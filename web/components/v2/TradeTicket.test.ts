import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ConfigResponse } from "@/lib/v2/api-types";
import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, costToBuy } from "@/lib/v2/payoff";
import { scenarioFigures } from "@/lib/v2/payoffReceipt";

import { CEILING_TERMS } from "./PayoffSlider";
import { explorerTerms, initialLimitPrice, partialDepthNotice, pricingStatusCaption, scenarioImageHref, swapForUsdgHref, usdgShortfallLine } from "./TradeTicket";

/**
 * The ticket mounts the explorer: slider, receipt and explainers in BUY mode only,
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
    // setPayoutAdapter reverts CeilingExceeded above 300 (Clearinghouse.setPayoutAdapter), so 301 cannot be a chain value.
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

describe("share-card URL", () => {
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
  it("mounts slider, share link, receipt and explainers in the buy-only payoff section, after the quote, and never in bid mode", () => {
    const section = source.indexOf('{mode === "buy" && payoffQuote && spot !== null && fees ? <TicketSection slot="payoff-explorer"');
    const advanced = source.indexOf('{mode === "buy" ? <TicketSection slot="ticket-advanced"');
    expect(section).toBeGreaterThan(-1);
    expect(advanced).toBeGreaterThan(section);
    const slider = source.indexOf("<PayoffSlider", section);
    const share = source.indexOf("Share this scenario", slider);
    const receipt = source.indexOf("<PayoffReceipt", share);
    const explainers = source.indexOf("<PayoffExplainers", receipt);
    expect(slider).toBeGreaterThan(section);
    expect(share).toBeGreaterThan(slider);
    expect(receipt).toBeGreaterThan(share);
    expect(explainers).toBeGreaterThan(receipt);
    expect(explainers).toBeLessThan(advanced);
    // One mount each: nothing in the bid branch or outside the ticket's buy flow.
    expect(source.match(/<PayoffSlider/g)).toHaveLength(1);
    expect(source.match(/<PayoffReceipt/g)).toHaveLength(1);
    expect(source.match(/<PayoffExplainers/g)).toHaveLength(1);
    expect(source).toContain("terms={terms}");
    // The chart's implied vol is fitted to the live premium over the time to this series' expiry.
    expect(source).toContain("premium={payoffQuote.buy.premium} expiry={detail.series.expiry} now={now}");
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
    // The same condition, in one short line.
    expect(source).toContain('{terms.source === "ceiling" && !detail.series.isPut ? <p className="text-xs text-ink-3">USDG range assumes the worst-case conversion (3 % under).</p> : null}');
  });
});

describe("Neon ticket", () => {
  it("makes the max loss the largest figure, names the capped fee and shows break-even", () => {
    expect(source).toContain('<span data-slot="max-loss" className="num ml-auto text-[20px] font-semibold text-ink">{usd(estimated, 6, "up")}</span>');
    const sizes = [...source.matchAll(/text-\[(\d+)px\]/g)].map((match) => Number(match[1]));
    expect(Math.max(...sizes)).toBe(20);
    expect(source).not.toMatch(/text-(3xl|4xl|5xl)/);
    expect(source).toContain('<SummaryRow k="Fee" tipLabel="About the fee" tip={feeTip}');
    expect(source).toContain('<SummaryRow k="Breakeven"');
    expect(source).toContain('<SummaryRow k="Max loss"');
  });

  it("shows P&L at the market page's chart handle, after the series' exercise fee, and reports its quote by value", () => {
    expect(source).toContain('{atPrice !== null && atPnl !== null ? <SummaryRow slot="at-price"');
    expect(source).toContain("exerciseFeeBps: detail.exerciseFeeBps }) - quote.buy.cost : null;");
    expect(source).toContain("useEffect(() => { onQuote?.(quoted); }, [quotedKey, onQuote]);");
  });
});

/**
 * costToBuy reports write asks it could not price (payoff.ts `pricingStatus`); the ticket
 * used to drop that, so an unpriceable ask read as absent liquidity. The caption says the quote is a lower bound.
 */
describe("Buy ticket pricing status", () => {
  const FEES = { takerFeeFlat: 0n, takerFeeCapBps: 0 };
  const writeAsk = (orderId: string, extra: Record<string, unknown>) =>
    ({ orderId, price: 1_000_000n, units: 100n, kind: "AskWrite" as const, maker: "0x0000000000000000000000000000000000000011", ...extra });

  it("says nothing when every ask was priced", () => {
    const buy = costToBuy([{ orderId: "1", price: 1_000_000n, units: 100n, kind: "AskResale" }], 100n, FEES);
    expect(buy.pricingStatus).toBe("priced");
    expect(pricingStatusCaption(buy)).toBeNull();
  });

  it("captions a quote that skipped a write ask it could not price as a lower-bound estimate", () => {
    // Control: the real walk marks the ask unpriceable (no rent terms), so the caption is fed the value the ticket gets.
    const buy = costToBuy([writeAsk("7", { makerFreeCollateral: 10n ** 12n })], 100n, FEES);
    expect(buy.pricingStatus).toBe("unpriceable");
    expect(buy.filledUnits).toBe(0n);
    const caption = pricingStatusCaption(buy);
    // The same count and reasons in plain words.
    expect(caption).toMatch(/^Estimate: 1 ask could not be priced/);
    expect(caption).toContain("series terms not loaded");
    expect(caption).toContain("so more may be available than shown");
  });

  it("counts every unpriceable ask and names each reason once", () => {
    expect(pricingStatusCaption({ pricingStatus: "unpriceable", unpriceableAsks: [
      { orderId: "1", reason: "collateral" }, { orderId: "2", reason: "maker" }, { orderId: "3", reason: "collateral" },
    ] })).toBe("Estimate: 3 asks could not be priced (seller's collateral not reported; "
      + "seller unknown), so more may be available than shown.");
  });

  it("renders the caption in the buy branch, beside the depth notice, from the ticket's own quote", () => {
    const buyBranch = source.indexOf("{estimated !== null ? <SummaryBox>");
    const bidBranch = source.indexOf('</> : <div data-slot="order-review"', buyBranch);
    const depth = source.indexOf("{partialDepth ? <Notice", buyBranch);
    const caption = source.indexOf('data-slot="pricing-status"', buyBranch);
    expect(buyBranch).toBeGreaterThan(-1);
    expect(depth).toBeGreaterThan(buyBranch);
    expect(caption).toBeGreaterThan(depth);
    expect(bidBranch).toBeGreaterThan(caption);
    expect(source).toContain("const pricingCaption = quote ? pricingStatusCaption(quote.buy) : null;");
    expect(source.match(/data-slot="pricing-status"/g)).toHaveLength(1);
  });
});

/**
 * partialDepthMessage says when the shortfall is asks the walk could not price, but the
 * ticket still called it without the count, so users saw "Only N available" as if the book had run out.
 */
describe("Shares-mode shortfall notice counts unpriceable asks", () => {
  const FEES = { takerFeeFlat: 0n, takerFeeCapBps: 0 };
  // A priced resale ask for 40 units, and a write ask for 100 the walk cannot price (no rent terms loaded).
  const book = [
    { orderId: "1", price: 1_000_000n, units: 40n, kind: "AskResale" as const },
    { orderId: "2", price: 2_000_000n, units: 100n, kind: "AskWrite" as const, maker: "0x0000000000000000000000000000000000000011", makerFreeCollateral: 10n ** 12n },
  ];

  it("says the rest of the order has no price when the shortfall is asks the walk could not price", () => {
    const buy = costToBuy(book, 100n, FEES);
    // Control: the real walk fills the priced 40 and skips the write ask, so the notice gets the ticket's own value.
    expect(buy.filledUnits).toBe(40n);
    expect(buy.unpriceableAsks).toEqual([{ orderId: "2", reason: "rent" }]);
    const notice = partialDepthNotice("shares", { buy }, 100n);
    expect(notice).toMatch(/^Only .+ available at a price for your .+ order\. 1 more listed ask has no price right now\. Choose a smaller size or enable partial fill\.$/);
  });

  it("keeps the plain text when every ask was priced, and counts several unpriceable asks", () => {
    const priced = costToBuy([book[0]], 100n, FEES);
    expect(priced.unpriceableAsks).toEqual([]);
    expect(partialDepthNotice("shares", { buy: priced }, 100n)).toMatch(/^Only .+ available for your .+ order\. Choose a smaller size or enable partial fill\.$/);
    const two = costToBuy([...book, { ...book[1], orderId: "3" }], 100n, FEES);
    expect(partialDepthNotice("shares", { buy: two }, 100n)).toContain("2 more listed asks have no price right now.");
  });

  it("stays silent outside shares mode, without a quote or size, and when the order fills", () => {
    const buy = costToBuy(book, 100n, FEES);
    expect(partialDepthNotice("budget", { buy }, 100n)).toBeNull();
    expect(partialDepthNotice("shares", null, 100n)).toBeNull();
    expect(partialDepthNotice("shares", { buy }, null)).toBeNull();
    expect(partialDepthNotice("shares", { buy: costToBuy(book, 40n, FEES) }, 40n)).toBeNull();
  });

  it("is what the ticket renders: the component calls partialDepthMessage only through partialDepthNotice", () => {
    expect(source).toContain("const partialDepth = partialDepthNotice(sizeMode, quote, units);");
    expect(source).toContain("return partialDepthMessage(quote.buy.filledUnits, units, quote.buy.unpriceableAsks.length);");
    expect(source.match(/partialDepthMessage\(/g)).toHaveLength(1);
  });
});

/**
 * The resting bid left over after a crossing buy takes its validUntil from CHAIN time through
 * restingValidUntil (tx.ts; tested there against a browser clock skewed both ways). The ticket is a wallet-bound
 * client component, so what is checkable here is that the site calls that helper and the browser clock is not in
 * the path between the crossing fill and the place() call.
 */
describe("resting bid remainder validUntil", () => {
  it("comes from chain time via restingValidUntil, never Date.now", () => {
    const start = source.indexOf("completeBidAfterCrossing(order.units, filled");
    const end = source.indexOf("await place(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const site = source.slice(start, end);
    expect(site).toContain("await restingValidUntil(context.client ?? publicClient, detail.series.expiry)");
    expect(site).not.toContain("Date.now");
    expect(site).not.toContain("86_400");
  });
});

describe("order review", () => {
  it("Review order only opens the review; the one button that calls submit() keeps the same gates", () => {
    expect(source.match(/onClick=\{\(\) => void submit\(\)\}/g)).toHaveLength(1);
    // The signing button also needs a reviewed order that the live book still matches.
    // Both buttons are also shut while the wallet holds less USDG than the order needs (usdgShortfallLine).
    expect(source).toContain('{address ? <Button onClick={() => void submit()} disabled={!writeReady || !(canBuy || canBid) || !reviewed || drift !== null || shortfall !== null} className="w-full">');
    expect(source).toContain('disabled={!liveOrder || shortfall !== null}\n      onClick={() => { if (!liveOrder || shortfall !== null) return; setSuccess(null); setBidPrice(bidPrice); setReviewed(liveOrder); setStep("review"); }}>Review order</Button>');
    expect(source).toContain('const reviewing = step === "review" && success === null;');
    expect(source.indexOf("{reviewing ? <div className=\"grid gap-2\">")).toBeGreaterThan(source.indexOf("restingOrderTiming({ kind: \"bid\""));
  });

  it("buys now only when the limit fills the whole size at the asks, at the reader's limit; otherwise it places the bid", () => {
    expect(source).toContain('const mode: "buy" | "bid" = split && price !== null && split.crossing.buy.filledUnits > 0n && split.restingUnits === 0n ? "buy" : "bid";');
    expect(source).toContain("const quote = useMemo(() => mode === \"buy\" && split && price !== null ? { ...split.crossing, limitPrice: price } : null,");
    // submit() branches on the REVIEWED mode and sends the reviewed size and partial-fill choice.
    expect(source).toContain('if (order.mode === "buy") {');
    expect(source).toContain("const filled = await executeCrossing(quote, order.units, order.allowPartial, context);");
  });
});

describe("the limit price starts at the ask", () => {
  const ask = (raw: string) => ({ price: { raw } });
  it("uses the lowest ask, then the fair value rounded down onto the $0.0001 tick", () => {
    expect(initialLimitPrice("334512", [ask("400000"), ask("350000")])).toBe("0.35");
    expect(initialLimitPrice("334512", undefined)).toBe("0.3345");
    expect(initialLimitPrice("334512", [])).toBe("0.3345");
  });
  it("is empty with neither", () => {
    expect(initialLimitPrice(undefined, [])).toBe("");
    expect(initialLimitPrice("50", undefined)).toBe("");
  });
});

describe("usdgShortfallLine", () => {
  it("rounds what is needed up and what the wallet has down, so a short wallet never reads as enough", () => {
    expect(usdgShortfallLine("NVDA", false, 100_001n, 99_999n))
      .toBe("You need $0.11 of USDG and your wallet has $0.099. Calls are paid in USDG, not NVDA Stock Tokens.");
    expect(usdgShortfallLine("NVDA", true, 2_000_000n, 0n))
      .toBe("You need $2.00 of USDG and your wallet has $0.00. Puts are paid in USDG, not NVDA Stock Tokens.");
  });

  it("is null when the wallet covers the order exactly, or when either figure is unknown", () => {
    expect(usdgShortfallLine("NVDA", false, 100_000n, 100_000n)).toBeNull();
    expect(usdgShortfallLine("NVDA", false, null, 0n)).toBeNull();
    expect(usdgShortfallLine("NVDA", false, 100_000n, null)).toBeNull();
  });

  it("links to the sell page's swap tab for the market", () => {
    expect(swapForUsdgHref("NVDA")).toBe("/sell/nvda?tab=swap");
  });
});
