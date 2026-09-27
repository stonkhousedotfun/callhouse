import { afterEach, describe, expect, it, vi } from "vitest";

/** robots() reads NEXT_PUBLIC_V2 at call time and DEV_PREVIEW at module load, so each case re-imports. */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, undefined as unknown as string);
    else vi.stubEnv(k, v);
  }
  return (await import("./robots")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("robots", () => {
  it("disallows everything in a v1 build", async () => {
    const robots = await load({ NEXT_PUBLIC_V2: "", NEXT_PUBLIC_DEV_PREVIEW: "" });
    expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("disallows everything in a v2 dev preview, so the dev environment is never indexed", async () => {
    const robots = await load({ NEXT_PUBLIC_V2: "1", NEXT_PUBLIC_DEV_PREVIEW: "1" });
    const out = robots();
    expect(out.rules).toEqual([{ userAgent: "*", disallow: "/" }]);
    expect(out.sitemap).toBeUndefined();
  });

  it("allows public v2 pages and excludes private paths", async () => {
    const robots = await load({ NEXT_PUBLIC_V2: "1", NEXT_PUBLIC_DEV_PREVIEW: "", NEXT_PUBLIC_APP_URL: "https://example.test//" });
    const out = robots();
    const rule = (Array.isArray(out.rules) ? out.rules[0] : out.rules)!;
    expect(rule.allow).toBe("/");
    for (const path of ["/portfolio", "/sell", "/settings", "/legacy", "/account", "/book", "/activity", "/collect", "/vault"]) {
      expect(rule.disallow).toContain(path);
    }
    expect(rule.disallow).not.toContain("/earn");
    // Trailing slashes are stripped before the sitemap path is appended.
    expect(out.sitemap).toBe("https://example.test/sitemap.xml");
  });

  it("falls back to the production origin when NEXT_PUBLIC_APP_URL is unset", async () => {
    const robots = await load({ NEXT_PUBLIC_V2: "1", NEXT_PUBLIC_DEV_PREVIEW: "" });
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(robots().sitemap).toBe("https://app.stonkhouse.fun/sitemap.xml");
  });
});
