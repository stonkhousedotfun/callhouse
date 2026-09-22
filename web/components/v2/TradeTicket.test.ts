import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ConfigResponse } from "@/lib/v2/api-types";
import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS } from "@/lib/v2/payoff";
import { scenarioFigures } from "@/lib/v2/payoffReceipt";

import { CEILING_TERMS } from "./PayoffSlider";
import { explorerTerms, scenarioImageHref } from "./TradeTicket";

/**
 * T-OP-120. The ticket mounts the explorer (design §0, §3 row 7): slider, receipt and explainers in BUY mode only,
 * once a quote exists; bid mode, Earn, House and the Marketplace grid are untouched. The ticket is a wallet-bound
 * client component, so what is unit-testable here is its two pure exports (the G7 conversion terms and the share
 * URL) and the mount structure, read from source the way SeriesPage.test.ts reads its hierarchy.
 */
const source = readFileSync(resolve(import.meta.dirname, "TradeTicket.tsx"), "utf8");
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../ops/fixtures/api/v2/config.json"), "utf8")) as ConfigResponse;

describe("explorer conversion terms (G7)", () => {
  it("uses the wire's Clearinghouse bound when /v2/config carries one, with the route fee at its ceiling", () => {
    const wired: ConfigResponse = { ...fixture, fees: { ...fixture.fees, maxPayoutSlippageBps: 150 } };
    expect(explorerTerms(wired)).toEqual({ slippageBps: 150, routeFeeBps: MAX_ROUTE_FEE_BPS, source: "wire" });
    expect(explorerTerms({ ...fixture, fees: { ...fixture.fees, maxPayoutSlippageBps: 0 } })).toEqual({ slippageBps: 0, routeFeeBps: 100, source: "wire" });
    expect(explorerTerms({ ...fixture, fees: { ...fixture.fees, maxPayoutSlippageBps: 300 } })).toEqual({ slippageBps: 300, routeFeeBps: 100, source: "wire" });
  });

  it("falls back to the contract ceiling when the wire is absent, null, or impossible", () => {
    // The committed fixture: no PayoutAdapterSet indexed, so null on the wire.
    expect(fixture.fees.maxPayoutSlippageBps).toBeNull();
    expect(explorerTerms(fixture)).toEqual({ ...CEILING_TERMS, source: "ceiling" });
    expect(explorerTerms(undefined)).toEqual({ slippageBps: MAX_PAYOUT_SLIPPAGE_CEIL_BPS, routeFeeBps: MAX_ROUTE_FEE_BPS, source: "ceiling" });
    // setPayoutAdapter reverts CeilingExceeded above 300 (Clearinghouse.sol:446 at ee14bfbc), so 301 cannot be a chain value.
    for (const impossible of [301, -1, 1.5, Number.NaN]) {
      expect(explorerTerms({ ...fixture, fees: { ...fixture.fees, maxPayoutSlippageBps: impossible } }), String(impossible))
        .toEqual({ ...CEILING_TERMS, source: "ceiling" });
    }
    // The ceiling is the widest band: a wire value can only narrow it.
    const call = { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
    const wide = scenarioFigures(call, 12_499_900n, 240_000_000n, explorerTerms(fixture));
    const narrow = scenarioFigures(call, 12_499_900n, 240_000_000n, explorerTerms({ ...fixture, fees: { ...fixture.fees, maxPayoutSlippageBps: 50 } }));
    expect(narrow.band!.low).toBeGreaterThan(wide.band!.low);
    expect(narrow.band!.high).toBe(wide.band!.high);
  });
});

describe("share-card URL (§2.8)", () => {
  it("carries every input the image route re-validates and nothing pre-rendered", () => {
    const position = { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
    const scenario = { price: 240_000_000n, figures: scenarioFigures(position, 12_499_900n, 240_000_000n, CEILING_TERMS), moved: true };
    const href = scenarioImageHref("NVDA", position, 12_499_900n, 1_790_200_800, scenario, { slippageBps: 150, routeFeeBps: 100 });
    const url = new URL(href, "https://app.stonkhouse.fun");
    expect(url.pathname).toBe("/api/pnl/scenario/image");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ticker: "NVDA", side: "call", strike: "230000000", units: "300", fee: "25", cost: "12499900", price: "240000000",
      expiry: "1790200800", slippage: "150", routeFee: "100", format: "square",
    });
    expect(href).not.toMatch(/pnl=|multiple=|payout=/);
    const put = scenarioImageHref("NVDA", { ...position, isPut: true }, 1n, 1, scenario, CEILING_TERMS, "wide");
    expect(new URL(put, "https://x").searchParams.get("side")).toBe("put");
    expect(new URL(put, "https://x").searchParams.get("format")).toBe("wide");
  });
});

describe("ticket mount structure", () => {
  it("mounts slider, share link, receipt and explainers inside the buy branch, after the quote, and never in bid mode", () => {
    const buyBranch = source.indexOf('{mode === "buy" ? <>');
    const advanced = source.indexOf("<summary className=\"cursor-pointer text-sm font-semibold text-ink\">Advanced</summary>");
    expect(buyBranch).toBeGreaterThan(-1);
    expect(advanced).toBeGreaterThan(buyBranch);
    const slider = source.indexOf("<PayoffSlider", buyBranch);
    const share = source.indexOf("Share this scenario", slider);
    const receipt = source.indexOf("<PayoffReceipt", share);
    const explainers = source.indexOf("<PayoffExplainers", receipt);
    expect(slider).toBeGreaterThan(buyBranch);
    expect(share).toBeGreaterThan(slider);
    expect(receipt).toBeGreaterThan(share);
    expect(explainers).toBeGreaterThan(receipt);
    expect(explainers).toBeLessThan(advanced);
    // One mount each: nothing in the bid branch or outside the ticket's buy flow.
    expect(source.match(/<PayoffSlider/g)).toHaveLength(1);
    expect(source.match(/<PayoffReceipt/g)).toHaveLength(1);
    expect(source.match(/<PayoffExplainers/g)).toHaveLength(1);
    // Gated on a quote, a spot and the fee params, as before, and fed the G7 terms and the wallet gas estimate.
    expect(source).toContain("{payoffQuote && spot !== null && fees ? <><PayoffSlider");
    expect(source).toContain("terms={terms}");
    expect(source).toContain("gas: gasEstimate.data ?? null");
    expect(source).toContain("const terms = useMemo(() => explorerTerms(config.data), [config.data]);");
  });

  it("estimates gas from the chain for this quote and never from a constant", () => {
    const estimator = source.slice(source.indexOf("async function estimateBuyGas"), source.indexOf("function tradePrice"));
    expect(estimator).toContain('functionName: "allowance"');
    expect(estimator).toContain('functionName: "take"');
    expect(estimator).toContain("publicClient.getGasPrice()");
    expect(estimator).toContain("estimateContractGas");
    // A short allowance means the take cannot be simulated yet: two transactions, no figure.
    expect(estimator).toContain("if (allowance < required) return { transactions: 2, wei: null, symbol };");
    expect(estimator).not.toMatch(/wei: \d/);
    expect(source).not.toMatch(/GAS_(ESTIMATE|COST|UNITS)\s*=\s*\d/);
  });

  it("tells a call buyer when the band is the worst case rather than the live bound", () => {
    expect(source).toContain('{terms.source === "ceiling" && !detail.series.isPut ? <p className="mt-2 text-xs text-ink-3">USDG band uses the contract’s worst-case conversion bound (3 %); the live bound was not available.</p> : null}');
  });
});
