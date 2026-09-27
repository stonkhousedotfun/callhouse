/**
 * /trust/burns. The route rendered nothing but TokenBurnsPanel, which returns null while loading, on an
 * error, when the splitter is not configured and before the first recorded burn, so the page was blank in every state
 * but one. The route now always has its heading; the empty states say one neutral thing and announce nothing.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FlywheelResponse } from "@/lib/v2/api-types";
import { useFlywheel } from "@/lib/v2/hooks";
import { TOKEN_BURNS_EMPTY } from "@/components/v2/TokenBurnsPanel";
import TokenBurnsPage from "./page";

// The route also reads /v2/config for the fee manager's delay; unread here, so the sentence carries no number.
vi.mock("@/lib/v2/hooks", () => ({ useFlywheel: vi.fn(), useConfig: vi.fn(() => ({ data: undefined })) }));

const firstBurn: FlywheelResponse = {
  configured: true,
  splitter: "0x0000000000000000000000000000000000000001",
  tokenAddress: "0x0000000000000000000000000000000000000002",
  tokenDecimals: 18,
  burnedTotal: "1250000000000000000000",
  burned7d: "250000000000000000000",
  revenue7d: [],
  held: [],
  lastDistribution: null,
  distributions: [],
};

const page = (query: { data?: FlywheelResponse; isError?: boolean }) => {
  vi.mocked(useFlywheel).mockReturnValue({ data: query.data, isError: query.isError ?? false } as ReturnType<typeof useFlywheel>);
  return renderToStaticMarkup(createElement(TokenBurnsPage));
};
const heading = (html: string) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]*>/g, "") ?? null;

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_V2", "1"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("/trust/burns always renders a heading", () => {
  const empty: [string, { data?: FlywheelResponse; isError?: boolean }, keyof typeof TOKEN_BURNS_EMPTY][] = [
    ["loading", {}, "loading"],
    ["error", { isError: true }, "error"],
    ["not configured", { data: { ...firstBurn, configured: false } }, "unconfigured"],
    ["no burn yet", { data: { ...firstBurn, burnedTotal: "0", burned7d: "0" } }, "no-burn"],
    ["no burn total read", { data: { ...firstBurn, burnedTotal: null, burned7d: null } }, "no-burn"],
  ];

  for (const [name, query, kind] of empty) {
    it(`${name}: the heading and one neutral line, with nothing announced`, () => {
      const html = page(query);
      expect(heading(html)).toBe("Token burns");
      expect(html).toContain(TOKEN_BURNS_EMPTY[kind]);
      // No burn figure, no split or fee route, no programme wording, no promise of a future burn. Checked on the
      // visible text: class names carry digits and words of their own.
      const text = html.replace(/<[^>]*>/g, " ");
      expect(text).toContain("Token burns");
      expect(text).not.toContain("Burned so far");
      expect(text).not.toContain("STONKHOUSE");
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/split|fee|treasury|buyback|programme|program|will|soon|upcoming|first burn/i);
    });
  }

  it("the empty lines are different for each state, so a reader can tell loading from an error from no burn", () => {
    expect(new Set(Object.values(TOKEN_BURNS_EMPTY)).size).toBe(Object.keys(TOKEN_BURNS_EMPTY).length);
  });

  it("after a recorded burn the panel renders as before", () => {
    const html = page({ data: firstBurn });
    expect(heading(html)).toBe("Token burns");
    expect(html).toContain("Burned so far");
    // quantities go through lib/numberFormat.ts displayQuantity, which groups thousands.
    expect(html).toContain("1,250");
    expect(html).toContain("Only STONKHOUSE is burned");
    // The control for the empty-state checks: the same text filters fire on the panel's figures and fee-route copy.
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).toMatch(/\d/);
    expect(text).toMatch(/split|fee/i);
    for (const line of Object.values(TOKEN_BURNS_EMPTY)) expect(html).not.toContain(line);
  });

  it("a failed refetch keeps a burn already read on screen", () => {
    expect(page({ data: firstBurn, isError: true })).toContain("Burned so far");
  });
});
