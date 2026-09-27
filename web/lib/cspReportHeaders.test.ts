/**
 * The report-only CSP names a report endpoint that exists.
 *
 * Pins the three things that have to agree for a violation to arrive anywhere: the policy's
 * `report-uri` path, the policy's `report-to` group and the `Reporting-Endpoints` header that
 * defines that group, and the route file both of them point at. It also pins that the policy is
 * still REPORT-ONLY: enforcing it is an (next.config.mjs), not a side effect of
 * adding a reporter.
 */
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

type ResponseHeader = { key: string; value: string };
type HeaderRule = { source: string; headers: ResponseHeader[] };
type NextConfigUnderTest = { headers(): Promise<HeaderRule[]> };

const REPORT_PATH = "/api/csp-report";

async function globalHeaders(preview: boolean): Promise<Map<string, string>> {
  const configUrl = new URL("../next.config.mjs", import.meta.url).href;
  const loaded = await import(configUrl) as { default: NextConfigUnderTest };
  const previous = process.env.NEXT_PUBLIC_DEV_PREVIEW;
  if (preview) process.env.NEXT_PUBLIC_DEV_PREVIEW = "1";
  else delete process.env.NEXT_PUBLIC_DEV_PREVIEW;
  try {
    const rules = await loaded.default.headers();
    const global = rules.find((rule) => rule.source === "/:path*");
    return new Map(global?.headers.map(({ key, value }) => [key, value]) ?? []);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_DEV_PREVIEW;
    else process.env.NEXT_PUBLIC_DEV_PREVIEW = previous;
  }
}

const directives = (policy: string | undefined) => (policy ?? "").split(";").map((part) => part.trim()).filter(Boolean);

describe("CSP violation reporting", () => {
  for (const preview of [false, true]) {
    describe(preview ? "dev preview build" : "production build", () => {
      it("keeps the policy report-only", async () => {
        const headers = await globalHeaders(preview);
        expect(headers.has("Content-Security-Policy-Report-Only")).toBe(true);
        expect(headers.has("Content-Security-Policy"), "the policy must not be enforced").toBe(false);
      });

      it("reports to /api/csp-report through report-uri and through the report-to group", async () => {
        const headers = await globalHeaders(preview);
        const policy = directives(headers.get("Content-Security-Policy-Report-Only"));
        expect(policy.filter((d) => d.startsWith("report-uri "))).toEqual([`report-uri ${REPORT_PATH}`]);
        expect(policy.filter((d) => d.startsWith("report-to "))).toEqual(["report-to csp"]);
        expect(headers.get("Reporting-Endpoints")).toBe(`csp="${REPORT_PATH}"`);
      });
    });
  }

  it("names a report-to group that Reporting-Endpoints defines", async () => {
    const headers = await globalHeaders(false);
    const group = directives(headers.get("Content-Security-Policy-Report-Only"))
      .find((d) => d.startsWith("report-to "))?.slice("report-to ".length);
    const endpoints = new Map(
      (headers.get("Reporting-Endpoints") ?? "").split(",").map((entry) => {
        const [name, url] = entry.trim().split("=");
        return [name, url?.replace(/^"|"$/g, "")] as const;
      }),
    );
    expect(group).toBeDefined();
    expect(endpoints.get(group!)).toBe(REPORT_PATH);
  });

  it("points at a route that exists", () => {
    expect(existsSync(new URL(`../app${REPORT_PATH}/route.ts`, import.meta.url))).toBe(true);
  });
});
