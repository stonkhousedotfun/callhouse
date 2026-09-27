import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BookResponse, Card, ConfigResponse, Level } from "./api-types";
import { bidSplit as actualBidSplit, buyQuote as actualBuyQuote, completeBidAfterCrossing, crossingBidUnknownMessage, formatMultipleTenths, partialDepthMessage, railPnlAt, railSummary, safeBuyQuote, scenarioLabel, staleSelectedOrders, stepShareInput, stepShares, strikeRow, type ChainOrder } from "./ticket";

const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const hero = read<{ card: Card }>("cards/hero.json").card;
const book = read<BookResponse>(`series/${hero.series.longId}/book.json`);
const config = read<ConfigResponse>("config.json");
const zeroRent = { collateralPerUnit: 10n ** 16n, mintFeePpm: 0, expiry: hero.series.expiry, snapshotTimestamp: hero.series.mintCutoff - 100 };
const buyQuote: typeof actualBuyQuote = (levels, units, fees, tolerance, taker, rent) => actualBuyQuote(levels, units, fees, tolerance, taker, rent ?? zeroRent);
const bidSplit: typeof actualBidSplit = (levels, units, price, fees, taker, rent) => actualBidSplit(levels, units, price, fees, taker, rent ?? zeroRent);
const fees = { takerFeeFlat: BigInt(config.fees.takerFeeFlat.raw), takerFeeCapBps: config.fees.takerFeeCapBps };

describe("buyer ticket quote", () => {
  it("disables an invalid book quote without crashing its shared UI boundary", () => {
    const order = { orderId: "1", maker: hero.series.underlying, kind: "AskResale" as const,
      units: "1", onChainRemainingUnits: "1", makerFreeCollateral: null, makerFreeUnits: null,
      validUntil: hero.series.expiry };
    const level: Level = { price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "2",
      orders: [order, { ...order }] };
    expect(safeBuyQuote([level], 2n, fees, 0, undefined, zeroRent)).toBeNull();
    expect(safeBuyQuote([{ ...level, units: "1", orders: [order] }], 1n, fees, 0, undefined, zeroRent)?.buy.filledUnits).toBe(1n);
  });

  it("walks fixture asks and rounds the 2% worst-price guard up to a tick", () => {
    const quote = buyQuote(book.asks, 100n, fees);
    expect(quote.buy.filledUnits).toBe(100n);
    expect(quote.buy.cost).toBe(BigInt(hero.perShare!.cost.raw));
    expect(quote.buy.orderIds).toEqual(hero.orderIds);
    expect(quote.limitPrice).toBe(406_900n);
  });

  it("shows partial depth and charges the capped fee only on filled units", () => {
    const quote = buyQuote(book.asks, 150n, fees);
    expect(quote.buy.filledUnits).toBe(120n);
    expect(quote.buy.unfilledUnits).toBe(30n);
    expect(quote.buy.fee).toBe((quote.buy.premium * 1_000n) / 10_000n);
    expect(() => buyQuote(book.asks, 1n, fees, 1_001)).toThrow();
  });

  it("suggests a smaller size only when some ask depth is fillable", () => {
    expect(partialDepthMessage(0n, 100n)).toBeNull();
    expect(partialDepthMessage(100n, 100n)).toBeNull();
    expect(partialDepthMessage(70n, 100n)).toBe("Only 0.7 shares available for your 1 share order. Choose a smaller size or enable partial fill.");
  });

  it("a shortfall with unpriceable asks states the priced size, then says the rest has no price", async () => {
    // The real walk: 0.7 shares of resale depth prices; a 0.3-share write ask with no rent terms is skipped as
    // unpriceable. The book did not run out, so the message must not read as though it had.
    const { costToBuy } = await import("./payoff");
    const walk = costToBuy([
      { orderId: "1", kind: "AskResale" as const, price: 1_000_000n, units: 70n },
      { orderId: "2", kind: "AskWrite" as const, maker: "0x123", price: 1_000_000n, units: 30n, makerFreeCollateral: null },
    ], 100n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000, discountBps: 0 });
    expect(walk.filledUnits).toBe(70n);
    expect(walk.unpriceableAsks).toEqual([{ orderId: "2", reason: "rent" }]);
    expect(partialDepthMessage(walk.filledUnits, 100n, walk.unpriceableAsks.length)).toBe(
      "Only 0.7 shares available at a price for your 1 share order. 1 more listed ask has no price right now. Choose a smaller size or enable partial fill.");
    expect(partialDepthMessage(70n, 100n, 2)).toBe(
      "Only 0.7 shares available at a price for your 1 share order. 2 more listed asks have no price right now. Choose a smaller size or enable partial fill.");
    // Unchanged when nothing is fillable or the order fills: no size advice either way.
    expect(partialDepthMessage(0n, 100n, 1)).toBeNull();
    expect(partialDepthMessage(100n, 100n, 1)).toBeNull();
  });

  it("reserves one writer's collateral across two asks before quoting a take", () => {
    const maker = hero.series.underlying;
    const levels: Level[] = [
      { price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "50", orders: [
        { orderId: "101", maker, kind: "AskWrite", units: "50", onChainRemainingUnits: "50",
          makerFreeCollateral: { raw: "500000000000000000", decimals: 18, formatted: "0.5" }, makerFreeUnits: "50", validUntil: hero.series.expiry },
      ] },
      { price: { raw: "600000", decimals: 6, formatted: "0.6" }, units: "50", orders: [
        { orderId: "102", maker, kind: "AskWrite", units: "50", onChainRemainingUnits: "50",
          makerFreeCollateral: { raw: "500000000000000000", decimals: 18, formatted: "0.5" }, makerFreeUnits: "50", validUntil: hero.series.expiry },
      ] },
    ];
    const quote = buyQuote(levels, 100n, fees);
    expect(quote.buy.filledUnits).toBe(50n);
    expect(quote.buy.unfilledUnits).toBe(50n);
    expect(quote.buy.orderIds).toEqual(["101"]);
    expect(bidSplit(levels, 100n, 600_000n, fees).restingUnits).toBe(50n);
  });

  it("skips an undercollateralized full order, but can fill it for a smaller request", () => {
    const levels: Level[] = [
      { price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "50", orders: [
        { orderId: "101", maker: hero.series.underlying, kind: "AskWrite", units: "50",
          onChainRemainingUnits: "100", makerFreeCollateral: { raw: "500000000000000000", decimals: 18, formatted: "0.5" }, makerFreeUnits: "50", validUntil: hero.series.expiry },
      ] },
      { price: { raw: "600000", decimals: 6, formatted: "0.6" }, units: "50", orders: [
        { orderId: "102", maker: config.usdg.address, kind: "AskWrite", units: "50",
          onChainRemainingUnits: "50", makerFreeCollateral: { raw: "500000000000000000", decimals: 18, formatted: "0.5" }, makerFreeUnits: "50", validUntil: hero.series.expiry },
      ] },
    ];
    expect(buyQuote(levels, 100n, fees).buy.orderIds).toEqual(["102"]);
    expect(buyQuote(levels, 50n, fees).buy.orderIds).toEqual(["101"]);
  });

  it("excludes a stale/cancelled order after on-chain reread", () => {
    const quote = buyQuote(book.asks, 10n, fees);
    const expected = quote.asks[0];
    const chain: ChainOrder = {
      orderId: BigInt(expected.orderId), maker: expected.maker, longId: BigInt(hero.series.longId),
      kind: 2, price: expected.price, units: 120n, filled: 0n, validUntil: hero.series.mintCutoff,
      cancelled: false, freeCollateral: 10n ** 18n,
    };
    expect(staleSelectedOrders(quote, [chain], chain.longId, 10n ** 16n, hero.series.mintCutoff - 1, zeroRent)).toEqual([]);
    expect(staleSelectedOrders(quote, [{ ...chain, cancelled: true }], chain.longId, 10n ** 16n, hero.series.mintCutoff - 1)).toEqual([expected.orderId]);
    expect(staleSelectedOrders(quote, [{ ...chain, units: 9n }], chain.longId, 10n ** 16n, hero.series.mintCutoff - 1)).toEqual([expected.orderId]);
    expect(staleSelectedOrders(quote, [chain], chain.longId, 10n ** 16n, hero.series.mintCutoff, zeroRent)).toEqual([expected.orderId]);
    // A write ask whose maker is not the book's operator is skipped by the take (OrderBook `_consume` refuses a budget that is not usable).
    expect(staleSelectedOrders(quote, [{ ...chain, writerIsOperator: false }], chain.longId, 10n ** 16n, hero.series.mintCutoff - 1, zeroRent))
      .toEqual([expected.orderId]);
    expect(staleSelectedOrders(quote, [{ ...chain, writerIsOperator: true }], chain.longId, 10n ** 16n, hero.series.mintCutoff - 1, zeroRent))
      .toEqual([]);
  });

  it("fills a crossing bid first and escrows only the remainder", () => {
    const levels: Level[] = [
      { price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "8",
        orders: [{ orderId: "1", maker: hero.series.underlying, units: "8", onChainRemainingUnits: "8", makerFreeCollateral: null, makerFreeUnits: null, kind: "AskResale", validUntil: hero.series.expiry }] },
      { price: { raw: "600000", decimals: 6, formatted: "0.6" }, units: "8",
        orders: [{ orderId: "2", maker: hero.series.underlying, units: "8", onChainRemainingUnits: "8", makerFreeCollateral: null, makerFreeUnits: null, kind: "AskResale", validUntil: hero.series.expiry }] },
    ];
    const split = bidSplit(levels, 20n, 600_000n, fees);
    expect(split.crossing.buy.filledUnits).toBe(16n);
    expect(split.crossing.buy.orderIds).toEqual(["1", "2"]);
    expect(split.restingUnits).toBe(4n);
    expect(split.escrow).toBe(24_000n);
    expect(split.crossing.limitPrice).toBe(600_000n);
  });

  it("excludes the connected maker's asks from buy and crossing-bid quotes", () => {
    const mine = hero.series.underlying;
    const other = config.usdg.address;
    const levels: Level[] = [
      { price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "8",
        orders: [{ orderId: "1", maker: mine, units: "8", onChainRemainingUnits: "8", makerFreeCollateral: null, makerFreeUnits: null,
          kind: "AskResale", validUntil: hero.series.expiry }] },
      { price: { raw: "600000", decimals: 6, formatted: "0.6" }, units: "8",
        orders: [{ orderId: "2", maker: other, units: "8", onChainRemainingUnits: "8", makerFreeCollateral: null, makerFreeUnits: null,
          kind: "AskResale", validUntil: hero.series.expiry }] },
    ];
    const buy = buyQuote(levels, 10n, fees, 0, mine.toUpperCase());
    expect(buy.buy.orderIds).toEqual(["2"]);
    expect(buy.buy.filledUnits).toBe(8n);
    expect(buy.buy.unfilledUnits).toBe(2n);
    expect(buy.limitPrice).toBe(600_000n);
    const bid = bidSplit(levels, 10n, 600_000n, fees, mine.toUpperCase());
    expect(bid.crossing.buy.orderIds).toEqual(["2"]);
    expect(bid.crossing.buy.filledUnits).toBe(8n);
    expect(bid.restingUnits).toBe(2n);
    expect(bid.escrow).toBe(12_000n);
  });
});

describe("crossing bid completion", () => {
  it("distinguishes an uncertain approval from an uncertain remaining bid", () => {
    const approval = crossingBidUnknownMessage(8n, "approve");
    expect(approval).toContain("Bought 0.08 shares now");
    expect(approval).toContain("approval for the remaining bid");
    expect(approval).toContain("The bid was not placed");
    const placement = crossingBidUnknownMessage(8n, "place");
    expect(placement).toContain("The bid may not have been placed");
    expect(placement).toContain("The remaining bid transaction");
    expect(placement).not.toContain("approval");
    const restingApproval = crossingBidUnknownMessage(0n, "approve");
    expect(restingApproval).toMatch(/^The USDG approval for the bid/);
    expect(restingApproval).toContain("The bid was not placed");
    expect(restingApproval).not.toMatch(/Bought 0/);
    const restingPlacement = crossingBidUnknownMessage(0n, "place");
    expect(restingPlacement).toMatch(/^The bid transaction/);
    expect(restingPlacement).toContain("The bid may not have been placed");
    expect(restingPlacement).not.toMatch(/Bought 0/);
    expect(crossingBidUnknownMessage(100n, "place")).toContain("Bought 1 share now");
  });

  it("preserves a confirmed crossing buy when the separate remainder bid fails", async () => {
    const error = new Error("Remainder bid rejected in wallet");
    let attempted = 0n;
    const result = await completeBidAfterCrossing(10n, 8n, async (remaining) => {
      attempted = remaining;
      throw error;
    });
    expect(attempted).toBe(2n);
    expect(result).toEqual({ kind: "partial", restingUnits: 2n, error });
  });

  it("propagates a failure when no crossing purchase was confirmed", async () => {
    const error = new Error("Bid rejected");
    await expect(completeBidAfterCrossing(10n, 0n, async () => { throw error; })).rejects.toBe(error);
  });

  it("does not place a remainder when the crossing purchase filled everything", async () => {
    const result = await completeBidAfterCrossing(10n, 10n, async () => { throw new Error("unexpected call"); });
    expect(result).toEqual({ kind: "complete", restingUnits: 0n });
  });
});

describe("market page rows and rail", () => {
  // Launch rates, stated rather than read from the fixture so the hand-checked numbers below stay true.
  const launch = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
  const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
  // The fourth argument is the units AT the best ask (bestAskUnits), which is what these cases always meant;
  // `askUnits` on the wire is total depth and defaults to the same figure (a one-level book).
  const item = (strike: string, isPut: boolean, ask: string | null, bestAskUnits = "500", askUnits = bestAskUnits) => ({
    series: { longId: "7", isPut, strike: { raw: String(usd(Number(strike))), formatted: strike }, expiry: 1_790_000_000 },
    quote: { bestAsk: ask === null ? null : { raw: String(usd(Number(ask))) }, askUnits, bestAskUnits },
  });

  it("prices one share at the best ask plus the capped fee: the spec's 1.00 ask costs 1.10", () => {
    const row = strikeRow(item("236", false, "1.00"), launch, usd(229.03));
    expect(row.label).toBe("$236 call");
    expect(row.costPerShare).toBe(usd(1.10));
    // payoutAt applies the contract's per-unit rounding, so the exact break-even sits a hair above 237.10: the
    // first price whose settled payout covers the cost. Within one micro-USDG of the hand figure, never below it.
    expect(row.breakEven! - usd(237.10)).toBeGreaterThanOrEqual(0n);
    expect(row.breakEven! - usd(237.10)).toBeLessThanOrEqual(1n);
  });

  it("the fee is capped at 10% of a small premium, not the flat 0.10", () => {
    // 0.40 ask: 10% is 0.04 < 0.10, so the cap binds.
    expect(strikeRow(item("240", false, "0.40"), launch, usd(229.03)).costPerShare).toBe(usd(0.44));
  });

  it("the scenario multiple is payout at spot x 1.10 over cost, floored to one decimal", () => {
    // spot 229.03 x 1.1 = 251.933; payout 15.933 on a 236 call; / 1.10 = 14.48 -> 14.4
    expect(strikeRow(item("236", false, "1.00"), launch, usd(229.03)).scenarioMultiple).toBe(14.4);
    expect(scenarioLabel(false)).toBe("If +10%");
  });

  it("a put's scenario is spot x 0.90", () => {
    // spot 229.03 x 0.9 = 206.127; payout on a 222 put 15.873; / 1.10 = 14.43 -> 14.4
    const row = strikeRow(item("222", true, "1.00"), launch, usd(229.03));
    expect(row.scenarioMultiple).toBe(14.4);
    expect(row.breakEven).toBe(usd(220.90));
    expect(scenarioLabel(true)).toBe("If −10%");
  });

  it("an out-of-reach scenario is a 0.0x multiple, not a missing one", () => {
    expect(strikeRow(item("300", false, "0.20"), launch, usd(229.03)).scenarioMultiple).toBe(0);
  });

  it("no ask, no fees, no spot, or less than a share at the best ask: no cost or multiple, never a zero", () => {
    expect(strikeRow(item("236", false, null), launch, usd(229.03)).costPerShare).toBeNull();
    expect(strikeRow(item("236", false, "1.00"), null, usd(229.03)).costPerShare).toBeNull();
    expect(strikeRow(item("236", false, "1.00"), launch, null).scenarioMultiple).toBeNull();
    expect(strikeRow(item("236", false, "1.00", "99"), launch, usd(229.03)).costPerShare).toBeNull();
    // The control: 100 units at the best ask is exactly one share and does price.
    expect(strikeRow(item("236", false, "1.00", "100"), launch, usd(229.03)).costPerShare).toBe(usd(1.10));
  });

  it("the rail sums premium and one capped fee for the size, and flags a size beyond the best ask", () => {
    const row = strikeRow(item("236", false, "1.00", "300"), launch, usd(229.03));
    const two = railSummary(row, 200n, launch)!;
    expect(two.premium).toBe(usd(2));
    expect(two.fee).toBe(usd(0.10)); // flat 0.10 < 10% of 2.00
    expect(two.cost).toBe(usd(2.10));
    expect(two.beyondBestAsk).toBe(false);
    expect(railSummary(row, 400n, launch)!.beyondBestAsk).toBe(true);
    expect(railSummary(strikeRow(item("236", false, null), launch, null), 100n, launch)).toBeNull();
  });

  it("a share is priced at the best ask only when a whole share rests there, not off total depth", () => {
    // 40 units at 0.50 over 100 at 0.80: total depth 140 >= one share, but only 40 sit at 0.50. Reading the total
    // priced a share at 0.55 (0.50 + 10% cap); the book fills 40 at 0.50 and 60 at 0.80 = 0.68, + 0.068 fee = 0.748.
    const row = strikeRow(item("236", false, "0.50", "40", "140"), launch, usd(229.03));
    expect(row.costPerShare).toBeNull();
    expect(row.askUnits).toBe(40n);
    expect(row.bestAskUnits).toBe(40n);
    expect(railSummary(row, 100n, launch)!.beyondBestAsk).toBe(true);
    // The control: 100 of the 140 at the best price does price at 0.55.
    expect(strikeRow(item("236", false, "0.50", "100", "140"), launch, usd(229.03)).costPerShare).toBe(usd(0.55));
  });

  it("an API that does not state bestAskUnits prices nothing per share and calls every size beyond the best ask", () => {
    const legacy = { ...item("236", false, "1.00"), quote: { bestAsk: { raw: String(usd(1)) }, askUnits: "500" } };
    const row = strikeRow(legacy, launch, usd(229.03));
    expect(row.bestAskUnits).toBeNull();
    expect(row.costPerShare).toBeNull();
    expect(row.askUnits).toBe(500n);
    expect(railSummary(row, 100n, launch)!.beyondBestAsk).toBe(true);
  });

  it("P&L at a price is the expiry payout minus the cost", () => {
    const row = strikeRow(item("236", false, "1.00"), launch, usd(229.03));
    const one = railSummary(row, 100n, launch)!;
    // The spec's tooltip says +3.90 at 241; the contract's per-unit rounding settles 4.9999 on 100 units, so the
    // exact figure is 0.0001 lower. The rail shows the exact one.
    expect(usd(3.90) - railPnlAt(row, one, usd(241))).toBeGreaterThanOrEqual(0n);
    expect(usd(3.90) - railPnlAt(row, one, usd(241))).toBeLessThanOrEqual(100n);
    expect(railPnlAt(row, one, usd(230))).toBe(-usd(1.10));
  });

  it("formats multiples and steps whole shares within bounds", () => {
    expect(formatMultipleTenths(14.4)).toBe("14.4×");
    expect(formatMultipleTenths(null)).toBe("—");
    expect(stepShares(1, -1)).toBe(1);
    expect(stepShares(3, 1)).toBe(4);
    expect(stepShares(1_000, 1)).toBe(1_000);
  });
});

describe("ticket share stepper", () => {
  it("steps whole shares from the typed size and never below one share", () => {
    expect(stepShareInput("1", 1)).toBe("2");
    expect(stepShareInput("3", -1)).toBe("2");
    expect(stepShareInput("1", -1)).toBe("1");
    // A fractional entry steps from its whole part, so + on 0.5 lands on a whole share rather than 1.5.
    expect(stepShareInput("0.5", 1)).toBe("1");
    expect(stepShareInput("2.75", 1)).toBe("3");
    expect(stepShareInput("2.75", -1)).toBe("1");
    // Unreadable or empty input starts from zero, then clamps to one share.
    expect(stepShareInput("", 1)).toBe("1");
    expect(stepShareInput("abc", -1)).toBe("1");
  });
});
