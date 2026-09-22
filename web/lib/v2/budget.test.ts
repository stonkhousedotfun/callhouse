import { describe, expect, it } from "vitest";

import type { Level } from "./api-types";
import { buyQuoteForBudget, maxBuyQuote, parseUsdgBudget } from "./budget";

const maker = "0x0000000000000000000000000000000000000001";
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };

function level(orderId: string, price: bigint, units: bigint, makerAddress = maker): Level {
  return {
    price: { raw: price.toString(), decimals: 6, formatted: (Number(price) / 1_000_000).toString() },
    units: units.toString(),
    orders: [{ orderId, maker: makerAddress, kind: "AskResale", units: units.toString(),
      onChainRemainingUnits: units.toString(), makerFreeCollateral: null, makerFreeUnits: units.toString(),
      validUntil: 2_000_000_000 }],
  };
}

describe("USDG-first ticket sizing", () => {
  it("parses positive USDG exactly and rejects ambiguous or over-precise input", () => {
    expect(parseUsdgBudget("10")).toBe(10_000_000n);
    expect(parseUsdgBudget("0.000001")).toBe(1n);
    expect(parseUsdgBudget("1.25")).toBe(1_250_000n);
    expect(parseUsdgBudget("0")).toBeNull();
    expect(parseUsdgBudget("01")).toBeNull();
    expect(parseUsdgBudget("1.0000001")).toBeNull();
  });

  it("binary-searches the real ladder and includes the capped taker fee in the budget", () => {
    const quote = buyQuoteForBudget([level("1", 500_000n, 100n), level("2", 1_000_000n, 100n)],
      1_100_000n, fees, 200);
    expect(quote?.buy.filledUnits).toBe(150n);
    expect(quote?.buy.premium).toBe(1_000_000n);
    expect(quote?.buy.fee).toBe(100_000n);
    expect(quote?.buy.cost).toBe(1_100_000n);
  });

  it("returns no selection when one contract unit exceeds the budget", () => {
    expect(buyQuoteForBudget([level("1", 500_000n, 10n)], 5_499n, fees)).toBeNull();
    expect(buyQuoteForBudget([level("1", 500_000n, 10n)], 5_500n, fees)?.buy.filledUnits).toBe(1n);
  });

  it("selects Max from fully fillable depth and excludes the connected maker", () => {
    const other = "0x0000000000000000000000000000000000000002";
    const quote = maxBuyQuote([level("1", 500_000n, 100n), level("2", 1_000_000n, 40n, other)],
      fees, 200, maker.toUpperCase());
    expect(quote?.buy.filledUnits).toBe(40n);
    expect(quote?.buy.orderIds).toEqual(["2"]);
  });

  it("finds the smaller executable ticket when a larger AskWrite proposal is skipped whole", () => {
    const write: Level = {
      price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "100",
      orders: [{ orderId: "1", maker, kind: "AskWrite", units: "100", onChainRemainingUnits: "100",
        makerFreeCollateral: { raw: "500000000000000000", decimals: 18, formatted: "0.5" },
        makerFreeUnits: "50", validUntil: 2_000_000_000 }],
    };
    const rent = { collateralPerUnit: 10n ** 16n, mintFeePpm: 0, expiry: 2_000_000_000,
      mintCutoff: 1_999_999_900, snapshotTimestamp: 1_999_999_000 };
    const quote = buyQuoteForBudget([write], 10_000_000n, fees, 0, undefined, rent);
    expect(quote?.buy.filledUnits).toBe(50n);
    expect(quote?.buy.unfilledUnits).toBe(0n);
  });

  it("fails closed for a malformed ladder", () => {
    const duplicate = [level("1", 500_000n, 10n), level("1", 600_000n, 10n)];
    expect(buyQuoteForBudget(duplicate, 1_000_000n, fees)).toBeNull();
    expect(maxBuyQuote(duplicate, fees)).toBeNull();
  });
});
