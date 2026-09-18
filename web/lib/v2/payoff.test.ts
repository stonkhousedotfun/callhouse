import { describe, expect, it } from "vitest";

import vectors from "./payoff-vectors.json";
import {
  UNIT,
  breakeven,
  cardSentence,
  cardTarget,
  collateralPerUnit,
  costToBuy,
  exerciseFeePerUnit,
  grossPayoutPerUnit,
  maxLoss,
  multipleAt,
  netPayoutUsdgPerUnit,
  payoutAt,
  premium,
  sharesToUnits,
  shortOutcome,
  takerFee,
} from "./payoff";

describe("v2 payoff vectors", () => {
  for (const v of vectors) {
    it(v.name, () => {
      const strike = BigInt(v.strike);
      const price = BigInt(v.price);
      const gross = grossPayoutPerUnit(v.isPut, strike, price);
      const collateral = collateralPerUnit(v.isPut, strike);
      const fee = exerciseFeePerUnit(gross, collateral, v.exerciseFeeBps);
      expect(gross).toBe(BigInt(v.grossPerUnit));
      expect(fee).toBe(BigInt(v.feePerUnit));
      expect(gross - fee).toBe(BigInt(v.longPerUnit));
      expect(collateral - gross).toBe(BigInt(v.shortPerUnit));
      expect(netPayoutUsdgPerUnit(v.isPut, strike, price, v.exerciseFeeBps)).toBe(BigInt(v.usdPerUnit));
    });
  }

  it("preserves collateral across a grid of calls, puts and fee rates", () => {
    for (const isPut of [false, true]) {
      for (const strike of [25_000_000n, 100_000_000n, 231_000_000n]) {
        for (const price of [0n, 1n, 24_999_999n, 25_000_000n, 101_000_000n, 240_000_000n, 500_000_000n]) {
          for (const bps of [0, 25, 200]) {
            const gross = grossPayoutPerUnit(isPut, strike, price);
            const collateral = collateralPerUnit(isPut, strike);
            const fee = exerciseFeePerUnit(gross, collateral, bps);
            expect(gross - fee + fee + (collateral - gross)).toBe(collateral);
            expect(fee).toBeLessThanOrEqual(gross / 10n);
          }
        }
      }
    }
  });
});

describe("buy cost and sizing", () => {
  it("uses cheapest asks, charges one capped taker fee and rounds average price upward", () => {
    const quote = costToBuy([
      { orderId: "2", price: 1_200_000n, units: 8n },
      { orderId: "1", price: 1_000_000n, units: 5n },
    ], 10n, { takerFeeFlat: 20_000n, takerFeeCapBps: 1_000 });
    expect(quote).toEqual({
      filledUnits: 10n, unfilledUnits: 0n, premium: 110_000n, fee: 11_000n, cost: 121_000n,
      averagePrice: 1_100_000n, orderIds: ["1", "2"],
      fills: [
        { orderId: "1", price: 1_000_000n, units: 5n, premium: 50_000n },
        { orderId: "2", price: 1_200_000n, units: 5n, premium: 60_000n },
      ],
    });
    expect(maxLoss(quote.cost)).toBe(121_000n);
    expect(premium(1_000_000n, 1n)).toBe(10_000n);
    expect(takerFee(10_000n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 })).toBe(1_000n);
  });

  it("reports partial depth without charging fee on unfilled units", () => {
    const quote = costToBuy([{ orderId: "7", price: 1_000_000n, units: 3n }], 5n,
      { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 });
    expect(quote).toMatchObject({ filledUnits: 3n, unfilledUnits: 2n, premium: 30_000n, fee: 3_000n, cost: 33_000n });
    expect(costToBuy([], 1n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 }).averagePrice).toBeNull();
  });

  it("parses only positive hundredth-share increments", () => {
    expect(sharesToUnits("0.01")).toBe(1n);
    expect(sharesToUnits("0.13")).toBe(13n);
    expect(sharesToUnits("1")).toBe(100n);
    for (const invalid of ["0", "0.00", "0.001", "-0.1", "1e3", "01", "", "1."]) {
      expect(() => sharesToUnits(invalid)).toThrow();
    }
  });
});

describe("scenarios and display", () => {
  it("rounds card target up to the market strike tick", () => {
    expect(cardTarget(231_000_000n, 400, 1_000_000n)).toBe(241_000_000n);
    expect(cardTarget(200_000_000n, 0, 500_000n)).toBe(200_000_000n);
  });

  it("rounds put targets down and applies the put collateral fee from interface v3", () => {
    expect(cardTarget(215_000_000n, 400, 1_000_000n, true)).toBe(206_000_000n);
    expect(netPayoutUsdgPerUnit(true, 215_000_000n, 206_000_000n, 25)).toBe(84_625n);
    expect(cardTarget(355_000_000n, 200, 5_000_000n, true)).toBe(345_000_000n);
    expect(netPayoutUsdgPerUnit(true, 355_000_000n, 345_000_000n, 25)).toBe(91_125n);
    expect(cardTarget(5_000_000n, 400, 5_000_000n, true)).toBe(5_000_000n);
    const sentence = cardSentence({
      series: { ticker: "NVDA", expiry: Date.UTC(2026, 8, 18, 20) / 1000, isPut: true },
      target: { raw: "206000000", decimals: 6 },
      perUnit: { cost: { raw: "10000", decimals: 6 }, payoutAtTarget: { raw: "84625", decimals: 6 } },
    }, 1n, { cost: 10_000n, payout: 84_625n });
    expect(sentence).toContain("falls to $206.00");
    expect(sentence).toContain("receive 0.084625 USDG");
  });

  it("finds the threshold where a holder breaks even", () => {
    const call = { isPut: false, strike: 231_000_000n, units: 1n, exerciseFeeBps: 25 };
    const put = { isPut: true, strike: 200_000_000n, units: 1n, exerciseFeeBps: 25 };
    const callPrice = breakeven(call, 11_000n);
    const putPrice = breakeven(put, 11_000n);
    expect(callPrice).not.toBeNull();
    expect(putPrice).not.toBeNull();
    expect(payoutAt(callPrice!, call)).toBeGreaterThanOrEqual(11_000n);
    expect(payoutAt(callPrice! - 1n, call)).toBeLessThan(11_000n);
    expect(payoutAt(putPrice!, put)).toBeGreaterThanOrEqual(11_000n);
    expect(payoutAt(putPrice! + 1n, put)).toBeLessThan(11_000n);
    expect(breakeven(put, 3_000_000n)).toBeNull();
    expect(multipleAt(240_000_000n, call, 10_000n)).toBe(8.4);
    expect(multipleAt(240_000_000n, call, 0n)).toBeNull();
  });

  it("values the writer's remaining collateral and premium", () => {
    const call = shortOutcome(240_000_000n,
      { isPut: false, strike: 231_000_000n, units: 2n, exerciseFeeBps: 25 }, 200_000n);
    expect(call.collateralReturned).toBe(2n * UNIT - 2n * 375_000_000_000_000n);
    expect(call.collateralAsset).toBe("Stock Token");
    expect(call.profitVsHoldUsdg).toBe(20_000n);
  });

  it("rounds displayed costs up and call settlement value down without promising a USDG transfer", () => {
    const card = {
      series: { ticker: "NVDA", expiry: Date.UTC(2026, 8, 18, 20) / 1000 },
      target: { raw: "240000000", decimals: 6 },
      perUnit: { cost: { raw: "10001", decimals: 6 }, payoutAtTarget: { raw: "172009", decimals: 6 } },
    };
    expect(cardSentence(card, 100n)).toBe(
      "Pay 1.01 USDG → estimated settlement value 17.20 USDG if NVDA reaches $240.00 by Friday. Max loss: 1.01 USDG.",
    );
  });
});
