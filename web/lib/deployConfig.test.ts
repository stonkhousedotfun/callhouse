import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type ResponseHeader = { key: string; value: string };
type HeaderRule = { source: string; headers: ResponseHeader[] };
type NextConfigUnderTest = {
  poweredByHeader?: boolean;
  headers(): Promise<HeaderRule[]>;
};

async function loadNextConfig(): Promise<NextConfigUnderTest> {
  const configUrl = new URL("../next.config.mjs", import.meta.url).href;
  const module = await import(configUrl) as { default: NextConfigUnderTest };
  return module.default;
}

const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

describe("v2 browser configuration reaches a Docker build", () => {
  it.each(["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_V1_API_URL", "NEXT_PUBLIC_V7_API_URL", "NEXT_PUBLIC_V2",
    "NEXT_PUBLIC_NOTIFIER_URL", "NEXT_PUBLIC_WC_PROJECT_ID"])("passes %s into next build", (key) => {
    expect(docker).toMatch(new RegExp(`^ARG ${key}=`, "m"));
    expect(docker).toMatch(new RegExp(`^ENV ${key}=\\$${key}$`, "m"));
    expect(env).toMatch(new RegExp(`^${key}=`, "m"));
  });
});

describe("maker epoch files reach the standalone image", () => {
  it("uses a stable ops source and keeps the empty epoch state buildable", () => {
    expect(docker).toMatch(/^COPY ops \.\/ops$/m);
    expect(docker).not.toMatch(/^COPY ops\/maker-epochs\/\*\.json/m);
    expect(docker).toContain("mkdir -p ./web/public/maker-epochs");
    expect(docker).toContain("if [ -d ./ops/maker-epochs ]; then");
    expect(docker).toContain("find ./ops/maker-epochs -maxdepth 1 -type f -name '*.json'");
  });

  it("copies the populated public tree into the standalone runner", () => {
    expect(docker).toContain(
      "COPY --from=builder --chown=nextjs:nodejs /app/web/public ./web/public",
    );
  });
});

describe("production response headers", () => {
  it("ships the wallet app baseline independently of the preview flag", async () => {
    const nextConfig = await loadNextConfig();
    const previous = process.env.NEXT_PUBLIC_DEV_PREVIEW;
    delete process.env.NEXT_PUBLIC_DEV_PREVIEW;
    try {
      const rules = await nextConfig.headers();
      const global = rules.find((rule) => rule.source === "/:path*");
      const headers = new Map(global?.headers.map(({ key, value }) => [key, value]) ?? []);

      expect(nextConfig.poweredByHeader).toBe(false);
      expect(headers.get("X-Content-Type-Options"), "missing X-Content-Type-Options").toBe("nosniff");
      expect(headers.get("Referrer-Policy"), "missing Referrer-Policy").toBe("strict-origin-when-cross-origin");
      expect(headers.get("X-Frame-Options"), "missing X-Frame-Options").toBe("DENY");
      expect(headers.get("Permissions-Policy"), "missing Permissions-Policy").toContain("camera=()");
      expect(headers.get("Strict-Transport-Security"), "missing Strict-Transport-Security")
        .toBe("max-age=31536000; includeSubDomains");
      expect(headers.get("Strict-Transport-Security")).not.toContain("preload");

      const csp = headers.get("Content-Security-Policy-Report-Only");
      expect(csp, "missing Content-Security-Policy-Report-Only").toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self' https: wss:");
      expect(headers.has("Server-Timing"), "control header should remain absent").toBe(false);
      expect(headers.has("X-Robots-Tag"), "production must not inherit preview noindex").toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_DEV_PREVIEW;
      else process.env.NEXT_PUBLIC_DEV_PREVIEW = previous;
    }
  });

  it("preserves the dev-preview noindex header", async () => {
    const nextConfig = await loadNextConfig();
    const previous = process.env.NEXT_PUBLIC_DEV_PREVIEW;
    process.env.NEXT_PUBLIC_DEV_PREVIEW = "1";
    try {
      const rules = await nextConfig.headers();
      const global = rules.find((rule) => rule.source === "/:path*");
      const headers = new Map(global?.headers.map(({ key, value }) => [key, value]) ?? []);
      expect(headers.get("X-Robots-Tag"), "missing preview X-Robots-Tag")
        .toBe("noindex, nofollow, noarchive");
      expect(headers.get("X-Content-Type-Options"), "preview must retain security headers")
        .toBe("nosniff");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_DEV_PREVIEW;
      else process.env.NEXT_PUBLIC_DEV_PREVIEW = previous;
    }
  });
});
