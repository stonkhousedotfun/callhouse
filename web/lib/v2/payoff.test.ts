import { describe, expect, it } from "vitest";

import vectors from "./payoff-vectors.json";
import {
  BPS,
  MAX_PAYOUT_SLIPPAGE_CEIL_BPS,
  MAX_ROUTE_FEE_BPS,
  UNIT,
  breakeven,
  breakevenUsdg,
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
  pnlAt,
  premium,
  sharesToUnits,
  shortOutcome,
  takerFee,
  usdgPayoutBand,
} from "./payoff";

describe("v2 payoff vectors", () => {
  for (const v of vectors.payout) {
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
      // BuyCost carries the site's pricing status; plain resale-style asks price fully.
      pricingStatus: "priced", unpriceableAsks: [],
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

/**
 * Every fee term of the explorer, pinned to the contract constant it mirrors, in
 * callhouse-contracts (v8), by name:
 *   - V2Constants.sol  MAX_PAYOUT_SLIPPAGE_CEIL_BPS = 300
 *   - V2Constants.sol  MAX_ROUTE_FEE_BPS = 100
 *   - V2Constants.sol  EXERCISE_FEE_MAX_PAYOUT_SHARE_BPS = 1000, EXERCISE_FEE_CEIL_BPS = 200
 *   - Clearinghouse.sol _conversionFloor: value * (BPS - min(maxPayoutSlippageBps + min(routeFee, 100), 300)) / BPS
 *   - OptionMath.sol grossPayoutPerUnit, the exercise fee, longPayoutPerUnit
 *   - OrderBook.sol _takerFee = min(flat, premium * capBps / BPS) - discount
 * The design example: 300 units, one ask at 4.1333 USDG/share,
 * strike 230 call, exercise fee 25 bps, settlement 240, taker fee min(0.10 USDG, 10 %).
 */

describe("conversion band, P&L and USDG break-even", () => {
  const call = { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
  const put = { isPut: true, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
  const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
  const quote = costToBuy([{ orderId: "1", price: 4_133_300n, units: 300n }], 300n, fees);

  it("pins the contract ceilings the app assumes when the wire carries no slippage", () => {
    expect(MAX_PAYOUT_SLIPPAGE_CEIL_BPS).toBe(300);
    expect(MAX_ROUTE_FEE_BPS).toBe(100);
  });

  it("prices the design example the way OrderBook.take does", () => {
    // OptionMath.premium: 4_133_300 * 300 / 100; one taker fee on the total premium (OrderBook `_fill` through `_takerFee`).
    expect(quote.premium).toBe(12_399_900n);
    expect(quote.fee).toBe(100_000n);
    expect(quote.cost).toBe(12_499_900n);
    expect(quote.averagePrice).toBe(4_133_300n);
  });

  it("mirrors Clearinghouse._conversionFloor, including both clamps, from the vectors", () => {
    for (const v of vectors.conversion) {
      const band = usdgPayoutBand(BigInt(v.value), v.slippageBps, v.routeFeeBps);
      expect(band, v.name).toEqual({ low: BigInt(v.low), high: BigInt(v.value), floorBps: v.floorBps });
      // Independent restatement of :1183-1189.
      const routeFee = Math.min(v.routeFeeBps, 100);
      const total = Math.min(v.slippageBps + routeFee, 300);
      expect(band.low, v.name).toBe((BigInt(v.value) * BigInt(10_000 - total)) / BPS);
    }
    expect(() => usdgPayoutBand(1n, 301, 0)).toThrow(RangeError);
    expect(() => usdgPayoutBand(1n, -1, 0)).toThrow(RangeError);
    expect(() => usdgPayoutBand(-1n, 0, 0)).toThrow(RangeError);
  });

  it("values the design example call at 240 and floors every step", () => {
    const price = 240_000_000n;
    // OptionMath.grossPayoutPerUnit UNIT * (P - K) / P, floored; feePerUnit min(UNIT * 25 / BPS, gross * 1000 / BPS); longPayoutPerUnit gross - fee.
    const gross = (UNIT * (price - call.strike)) / price;
    expect(gross).toBe(416_666_666_666_666n);
    const fee = exerciseFeePerUnit(gross, UNIT, 25);
    expect(fee).toBe(25_000_000_000_000n);
    expect(payoutAt(price, call)).toBe(((gross - fee) * price / 10n ** 18n) * 300n);
    expect(payoutAt(price, call)).toBe(28_199_700n);
    const band = usdgPayoutBand(payoutAt(price, call), MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS);
    expect(band).toEqual({ low: 27_353_709n, high: 28_199_700n, floorBps: 9_700 });
    const pnl = pnlAt(price, call, quote.cost);
    expect(pnl).toEqual({ pnl: 15_699_800n, pct: 125.59, multiple: 2.25 });
  });

  it("floors a loss away from zero and a gain toward zero", () => {
    expect(pnlAt(200_000_000n, call, quote.cost)).toEqual({ pnl: -12_499_900n, pct: -100, multiple: 0 });
    // 1 base unit short of covering: -0.000008 % floors to -0.01 %, never to 0.
    const almost = { isPut: true, strike: 200_000_000n, units: 1n, exerciseFeeBps: 0 };
    expect(pnlAt(190_000_000n, almost, 100_001n)).toEqual({ pnl: -1n, pct: -0.01, multiple: 0.99 });
    expect(pnlAt(190_000_000n, almost, 0n)).toEqual({ pnl: 100_000n, pct: null, multiple: null });
    expect(() => pnlAt(1n, almost, -1n)).toThrow(RangeError);
  });

  it("solves the call's two break-evens to the cent and the put's one", () => {
    const inKind = breakeven(call, quote.cost)!;
    const inUsdg = breakevenUsdg(call, quote.cost, MAX_PAYOUT_SLIPPAGE_CEIL_BPS)!;
    expect(inKind).toBe(234_629_667n);
    expect(inUsdg).toBe(234_772_778n);
    expect(inUsdg).toBeGreaterThan(inKind);
    expect(payoutAt(inKind, call)).toBeGreaterThanOrEqual(quote.cost);
    expect(payoutAt(inKind - 1n, call)).toBeLessThan(quote.cost);
    const floorAt = (p: bigint) => usdgPayoutBand(payoutAt(p, call), MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS).low;
    expect(floorAt(inUsdg)).toBeGreaterThanOrEqual(quote.cost);
    expect(floorAt(inUsdg - 1n)).toBeLessThan(quote.cost);
    // Less slippage moves the USDG break-even toward the in-kind one; zero slippage and zero route fee equal it.
    expect(breakevenUsdg(call, quote.cost, 100)).toBeLessThan(inUsdg);
    expect(breakevenUsdg(call, quote.cost, 0, 0)).toBe(inKind);
    // A put is paid in USDG: one break-even, the highest price that still covers the cost.
    const putBe = breakevenUsdg(put, quote.cost, MAX_PAYOUT_SLIPPAGE_CEIL_BPS)!;
    expect(putBe).toBe(breakeven(put, quote.cost));
    expect(putBe).toBe(225_370_400n);
    expect(payoutAt(putBe, put)).toBeGreaterThanOrEqual(quote.cost);
    expect(payoutAt(putBe + 1n, put)).toBeLessThan(quote.cost);
    expect(breakevenUsdg(put, 3_000_000_000n, 300)).toBeNull();
    expect(breakevenUsdg(call, 0n, 300)).toBe(call.strike);
    expect(() => breakevenUsdg(call, 1n, 301)).toThrow(RangeError);
  });
});

/*
 * The site fixes (callhouse-site lib/site.test.ts) ported into the app twin. The
 * vectors below are the site's own, verbatim; each app-only case pins that the port is ADDITIVE (absent inputs keep
 * the app's previous results exactly) so the existing app suite above is untouched.
 */
describe("the marketing site's payoff port, on its own vectors", () => {
  it("taker fee applies the per-take discount after the capped base (site vectors)", async () => {
    const { takerFee } = await import("./payoff");
    const params = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000, discountBps: 2_500 };
    expect(takerFee(2_000_000n, params)).toBe(75_000n);
    expect(takerFee(100_000n, params)).toBe(7_500n);
    expect(takerFee(2_000_000n, { ...params, discountBps: 0 })).toBe(100_000n);
    expect(() => takerFee(2_000_000n, { ...params, discountBps: 5_001 })).toThrow(/discountBps/);
    expect(() => takerFee(2_000_000n, { ...params, discountBps: -1 })).toThrow(/discountBps/);
    // App-only: no discount given is exactly the pre-port capped fee.
    const { discountBps: _d, ...noDiscount } = params;
    expect(takerFee(2_000_000n, noDiscount)).toBe(100_000n);
    expect(takerFee(100_000n, noDiscount)).toBe(10_000n);
  });

  it("missing write-ask inputs remain visible rather than becoming absent depth (site vectors + the maker reason)", async () => {
    const { costToBuy } = await import("./payoff");
    const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000, discountBps: 0 };
    const ask = { orderId: "1", kind: "AskWrite" as const, maker: "0x123", price: 1_000_000n, units: 1n, makerFreeCollateral: null };
    const unpriceable = costToBuy([ask], 1n, fees);
    const absent = costToBuy([], 1n, fees);
    expect(unpriceable.pricingStatus).toBe("unpriceable");
    expect(unpriceable.unpriceableAsks).toEqual([{ orderId: "1", reason: "rent" }]);
    expect(absent.pricingStatus).toBe("priced");
    expect(absent.unpriceableAsks).toEqual([]);
    const rent = { collateralPerUnit: 1n, mintFeePpm: 0, expiry: 1_800_604_800, snapshotTimestamp: 1_800_000_000 };
    expect(costToBuy([ask], 1n, fees, rent).unpriceableAsks[0]?.reason).toBe("collateral");
    const { maker: _m, ...noMaker } = ask;
    expect(costToBuy([noMaker], 1n, fees, rent).unpriceableAsks).toEqual([{ orderId: "1", reason: "maker" }]);
    // The skipped ask is still not filled: listing it changes the status, never the fills or the cost.
    expect(unpriceable.filledUnits).toBe(0n);
    expect(unpriceable.cost).toBe(absent.cost);
    // A resale ask needs none of those inputs and prices.
    expect(costToBuy([{ orderId: "2", kind: "AskResale", price: 1_000_000n, units: 1n }], 1n, fees).pricingStatus).toBe("priced");
  });

  it("call conversion floors the whole owed amount before break-even valuation (site vectors)", async () => {
    const { breakeven, payoutAt } = await import("./payoff");
    const position = { isPut: false, strike: 223_000_000n, units: 100n, exerciseFeeBps: 25, conversionFloorBps: 9_700 };
    expect(payoutAt(240_000_000n, position)).toBe(15_907_999n);
    expect(breakeven(position, 1_100_000n)).toBe(224_260_024n);
    expect(payoutAt(224_260_023n, position)).toBe(1_099_999n);
    expect(payoutAt(224_260_024n, position)).toBe(1_100_000n);
    expect(payoutAt(100_000_104n, { ...position, strike: 100_000_000n, exerciseFeeBps: 0 })).toBe(99n);
    expect(payoutAt(190_000_000n, { isPut: true, strike: 200_000_000n, units: 1n, exerciseFeeBps: 25 })).toBe(95_000n);
    expect(() => payoutAt(240_000_000n, { ...position, conversionFloorBps: 9_699 })).toThrow(/conversionFloorBps/);
    expect(() => payoutAt(240_000_000n, { ...position, conversionFloorBps: 10_001 })).toThrow(/conversionFloorBps/);
  });

  it("app-only: no floor keeps the in-kind per-contract value; the floor equals the band's low end; breakevenUsdg never floors twice", async () => {
    const { payoutAt, netPayoutUsdgPerUnit, usdgPayoutBand, breakevenUsdg, MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS } = await import("./payoff");
    const { conversionFloorBps } = await import("./fees");
    const inKind = { isPut: false, strike: 223_000_000n, units: 100n, exerciseFeeBps: 25 };
    const perUnit = netPayoutUsdgPerUnit(false, inKind.strike, 240_000_000n, 25);
    expect(payoutAt(240_000_000n, inKind)).toBe(perUnit * 100n);
    // One unit: the per-contract and total roundings coincide, so the floored payout IS the band's low end.
    const floor = conversionFloorBps(MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS);
    const one = { ...inKind, units: 1n };
    expect(payoutAt(240_000_000n, { ...one, conversionFloorBps: floor })).toBe(usdgPayoutBand(payoutAt(240_000_000n, one), MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS).low);
    expect(netPayoutUsdgPerUnit(false, one.strike, 240_000_000n, 25, floor)).toBe(usdgPayoutBand(perUnit, MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS).low);
    const cost = 1_100_000n;
    expect(breakevenUsdg({ ...inKind, conversionFloorBps: floor }, cost, MAX_PAYOUT_SLIPPAGE_CEIL_BPS)).toBe(breakevenUsdg(inKind, cost, MAX_PAYOUT_SLIPPAGE_CEIL_BPS));
  });
});
