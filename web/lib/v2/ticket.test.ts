import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BookResponse, Card, ConfigResponse, Level } from "./api-types";
import { bidSplit as actualBidSplit, buyQuote as actualBuyQuote, completeBidAfterCrossing, crossingBidUnknownMessage, partialDepthMessage, safeBuyQuote, staleSelectedOrders, type ChainOrder } from "./ticket";

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
