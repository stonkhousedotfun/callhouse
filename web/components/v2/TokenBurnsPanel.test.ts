import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ConfigResponse, FlywheelResponse } from "@/lib/v2/api-types";
import { useConfig, useFlywheel } from "@/lib/v2/hooks";
import { TokenBurnsPanelView, TokenBurnsRoute, splitChangeSentence, tokenBurnsRouteState } from "./TokenBurnsPanel";

// The route reads /v2/config for the Admin Safe's FEE_MANAGER holder delay. Only the route test uses these.
vi.mock("@/lib/v2/hooks", () => ({ useConfig: vi.fn(), useFlywheel: vi.fn() }));

const firstBurn: FlywheelResponse = {
  configured: true,
  splitter: "0x0000000000000000000000000000000000000001",
  tokenAddress: "0x0000000000000000000000000000000000000002",
  tokenDecimals: 18,
  burnedTotal: "1250000000000000000000",
  burned7d: "250000000000000000000",
  revenue7d: [{
    asset: "0x0000000000000000000000000000000000000003",
    symbol: "NVDA",
    decimals: 18,
    amountRaw: "80000000000000000",
  }],
  held: [],
  lastDistribution: null,
  distributions: [],
};

describe("token burns panel", () => {
  it("stays hidden until the splitter is configured and a burn is recorded", () => {
    expect(renderToStaticMarkup(createElement(TokenBurnsPanelView, {
      data: { ...firstBurn, configured: false },
    }))).toBe("");
    expect(renderToStaticMarkup(createElement(TokenBurnsPanelView, {
      data: { ...firstBurn, burnedTotal: "0", burned7d: "0" },
    }))).toBe("");
  });

  it("shows the first recorded burn without inventing a fixed split", () => {
    const html = renderToStaticMarkup(createElement(TokenBurnsPanelView, { data: firstBurn }));
    expect(html).toContain("Token burns");
    expect(html).toContain("Only STONKHOUSE is burned");
    expect(html).toContain("Stock Token fees are sold for USDG first");
    // CHANGED ON PURPOSE: this line used to pin "change waits 48 hours". FeeSplitter.setBurnBps has no wait of
    // its own; the 48 h was the FEE_MANAGER lane delay, which the zero-delay launch sets to 0 until the admin's lock
    // transaction. Unread (no delay passed), the sentence now states no number at all; the delay cases are below.
    expect(html).toContain("The split is set on chain by the fee manager.");
    expect(html).not.toContain("48");
    // quantities go through lib/numberFormat.ts displayQuantity, which groups thousands.
    expect(html).toContain("1,250");
    expect(html).not.toMatch(/\b50\s*%|50\/50/i);
    expect(html).not.toMatch(/buyback/i);
  });
});

// Which state /trust/burns is in. The panel's own hiding rule above is unchanged.
describe("tokenBurnsRouteState", () => {
  it("maps the query to a state, and only a positive burned total is a recorded burn", () => {
    expect(tokenBurnsRouteState({ isError: false }).kind).toBe("loading");
    expect(tokenBurnsRouteState({ isError: true }).kind).toBe("error");
    expect(tokenBurnsRouteState({ data: { ...firstBurn, configured: false }, isError: false }).kind).toBe("unconfigured");
    expect(tokenBurnsRouteState({ data: { ...firstBurn, burnedTotal: "0" }, isError: false }).kind).toBe("no-burn");
    expect(tokenBurnsRouteState({ data: { ...firstBurn, burnedTotal: null }, isError: false }).kind).toBe("no-burn");
    expect(tokenBurnsRouteState({ data: firstBurn, isError: false })).toEqual({ kind: "burned", data: firstBurn });
  });
});

/**
 * The split-change sentence states the Admin Safe's FEE_MANAGER holder delay as the chain has it, never the
 * planned 48 h. 0 is "takes effect immediately"; a set delay is formatted; unread says no number.
 */
describe("token burns: the split-change delay", () => {
  const SAFE = "0x00000000000000000000000000000000000000aB";
  const panel = (feeManagerDelayS: number | null) =>
    renderToStaticMarkup(createElement(TokenBurnsPanelView, { data: firstBurn, feeManagerDelayS }));
  const config = (over: Partial<Pick<ConfigResponse, "access" | "safes">> = {}, delayS = 0): Pick<ConfigResponse, "access" | "safes"> => ({
    safes: { admin: SAFE, treasury: null },
    access: { manager: "0x0000000000000000000000000000000000000003", roles: [
      { id: 1, name: "FEE_MANAGER", delayS: 0, holders: [{ address: SAFE.toLowerCase(), delayS }] },
    ] },
    ...over,
  });

  it("at a delay of 0: takes effect immediately, and no 48", () => {
    const html = panel(0);
    expect(html).toContain("a change takes effect immediately.");
    expect(html).not.toContain("48");
  });

  it("at 172800: the formatted delay", () => {
    const html = panel(172_800);
    expect(html).toContain("a change waits 2 days.");
    expect(html).not.toContain("immediately");
  });

  it("unread, or the role or holder missing: the sentence carries no number", () => {
    expect(splitChangeSentence(null)).toBe("The split is set on chain by the fee manager.");
    expect(splitChangeSentence(null)).not.toMatch(/\d/);
  });

  it("the route reads the Safe's FEE_MANAGER holder delay from /v2/config and passes it down", () => {
    vi.mocked(useFlywheel).mockReturnValue({ data: firstBurn, isError: false } as unknown as ReturnType<typeof useFlywheel>);
    const route = (data: unknown) => {
      vi.mocked(useConfig).mockReturnValue({ data } as unknown as ReturnType<typeof useConfig>);
      return renderToStaticMarkup(createElement(TokenBurnsRoute));
    };
    // delay 0 on the chain: immediate. This is the case a planned-table (172800) source would get wrong.
    expect(route(config())).toContain("a change takes effect immediately.");
    expect(route(config({}, 172_800))).toContain("a change waits 2 days.");
    // unread access table, missing role, missing Safe, Safe not a holder: no number.
    for (const unread of [undefined, config({ access: undefined }), config({ access: { manager: "0x0000000000000000000000000000000000000003", roles: [] } }),
      config({ safes: undefined }), config({ safes: { admin: "0x00000000000000000000000000000000000000cd", treasury: null } })]) {
      const html = route(unread);
      expect(html).toContain("The split is set on chain by the fee manager.");
      expect(html).not.toMatch(/immediately|waits/);
    }
  });
});
