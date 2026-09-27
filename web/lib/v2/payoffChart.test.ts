import { describe, expect, it } from "vitest";

import { breakeven, costToBuy, payoutAt, takerFee } from "./payoff";
import { SECONDS_PER_YEAR, bsPrice } from "./impliedVol";
import {
  ARROW_STEP, CHART_VIEW, CURVE_SAMPLES, PAGE_STEP, SITE_CHART_CAPTION, ariaValueText, buildPayoffChart, chartCaptions, chartDomain, costFromQuote,
  costLabel, defaultHandlePrice, earlyText, keyboardChartPrice, priceAtRatio, ratioOfPrice, tooltipFor, type ChartInput,
} from "./payoffChart";

/**
 * The payoff chart's model, pinned. A 5-share NVDA $236 call at a 1.00 ask with launch fees
 * (flat 0.10, cap 10 %), spot 229.03, one day left. Money is USDG-6.
 */
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const NOW = 1_790_000_000;
const DAY = 86_400;
const units = 500n;
const take = costToBuy([{ orderId: "1", price: 1_000_000n, units }], units, fees);
const call: ChartInput = {
  ticker: "NVDA", isPut: false, strike: 236_000_000n, units, spot: 229_030_000n,
  cost: take.cost, premium: take.premium, exerciseFeeBps: 25, expiry: NOW + DAY, now: NOW,
};
const put: ChartInput = { ...call, isPut: true, strike: 222_000_000n };

describe("cost and break-even", () => {
  it("caps the taker fee at 0.10 or 10 % of premium, whichever is smaller", () => {
    expect(takerFee(5_000_000n, fees)).toBe(100_000n); // 10 % of 5.00 is 0.50: the flat 0.10 wins
    expect(takerFee(400_000n, fees)).toBe(40_000n); // 10 % of 0.40 is 0.04: the cap wins
    expect(costFromQuote(5_000_000n, fees)).toBe(5_100_000n);
    expect(costFromQuote(400_000n, fees)).toBe(440_000n);
    // A 5-share take at 1.00 is one take: one 0.10 fee on 5.00 of premium.
    expect(take.premium).toBe(5_000_000n);
    expect(take.cost).toBe(5_100_000n);
  });

  it("puts a call's break-even at K + cost per share and a put's at K − cost per share, without the exercise fee", () => {
    const noFee = buildPayoffChart({ ...call, exerciseFeeBps: 0 });
    // cost per share = 5.10 / 5 = 1.02, so K + cost = 237.02. A call pays Stock Tokens, floored, then valued at the
    // settlement price, floored (payoff.ts netPayoutUsdgPerUnit), so the contract's break-even can sit up to a
    // few base units above the textbook one — never below it.
    expect(noFee.breakeven!).toBeGreaterThanOrEqual(237_020_000n);
    expect(noFee.breakeven! - 237_020_000n).toBeLessThanOrEqual(5n);
    const putNoFee = buildPayoffChart({ ...put, exerciseFeeBps: 0 });
    expect(putNoFee.breakeven).toBe(220_980_000n);
  });

  it("moves the break-even out when the exercise fee is included, and labels the chart when it is not", () => {
    const withFee = buildPayoffChart(call);
    expect(withFee.breakeven).toBe(breakeven({ isPut: false, strike: call.strike, units, exerciseFeeBps: 25 }, call.cost));
    expect(withFee.breakeven!).toBeGreaterThan(237_020_000n);
    expect(withFee.feeKnown).toBe(true);
    expect(chartCaptions(withFee)).toContain("Includes the exercise fee taken from the payout.");
    const unknown = buildPayoffChart({ ...call, exerciseFeeBps: null });
    expect(unknown.feeKnown).toBe(false);
    expect(chartCaptions(unknown)).toContain("Values are before exercise fee.");
    expect(tooltipFor(unknown, 245_000_000n).worth).toContain("before exercise fee");
    expect(ariaValueText(unknown, 245_000_000n)).toContain("before exercise fee");
  });

  it("captions the settlement average", () => {
    expect(chartCaptions(buildPayoffChart(call))[0]).toBe(
      "At-expiry values use the settlement price: the average of the last 30 minutes before the close, not a single trade.");
  });
});

describe("expiry value (the hinge at the strike)", () => {
  it("is exactly the contract payout: zero out of the money, net of the exercise fee in it", () => {
    const model = buildPayoffChart(call);
    expect(model.at(230_000_000n).expiryValue).toBe(0n);
    expect(model.at(236_000_000n).expiryValue).toBe(0n);
    const at241 = model.at(241_000_000n);
    expect(at241.expiryValue).toBe(payoutAt(241_000_000n, { isPut: false, strike: call.strike, units, exerciseFeeBps: 25 }));
    // Gross 5 × 5.00 = 25.00. The fee is 0.25 % of collateral (0.25 % of a share, about 0.60) capped at 10 % of the
    // payout (0.50 a share): the cap binds this close to the strike, so the holder gets 90 % of 25.00.
    expect(at241.expiryValue).toBeLessThanOrEqual(22_500_000n);
    expect(at241.expiryValue).toBeGreaterThan(22_499_900n);
    expect(at241.pnl).toBe(at241.expiryValue - call.cost);
  });

  it("pays a put below the strike and nothing above it", () => {
    const model = buildPayoffChart({ ...put, exerciseFeeBps: 0 });
    expect(model.at(223_000_000n).expiryValue).toBe(0n);
    expect(model.at(217_000_000n).expiryValue).toBe(25_000_000n); // 5 shares × 5.00
  });
});

describe("x domain", () => {
  it("starts a call at floor(K × 0.975) and ends at ceil(max(spot × 1.12, K × 1.08))", () => {
    // 236 × 0.975 = 230.1 → 230; max(229.03 × 1.12 = 256.5136, 254.88) → 257.
    expect(chartDomain(false, 236_000_000n, 229_030_000n)).toEqual({ min: 230_000_000n, max: 257_000_000n, reversed: false });
    // Spot far below: the strike term sets the top. 236 × 1.08 = 254.88 → 255.
    expect(chartDomain(false, 236_000_000n, 150_000_000n)).toEqual({ min: 230_000_000n, max: 255_000_000n, reversed: false });
    expect(chartDomain(false, 236_000_000n, null).max).toBe(255_000_000n);
  });

  it("mirrors a put: from ceil(K × 1.025) down to floor(min(spot × 0.88, K × 0.92)), drawn right to left", () => {
    // 222 × 1.025 = 227.55 → 228; min(229.03 × 0.88 = 201.5464, 204.24) → 201.
    expect(chartDomain(true, 222_000_000n, 229_030_000n)).toEqual({ min: 201_000_000n, max: 228_000_000n, reversed: true });
    const domain = chartDomain(true, 222_000_000n, 229_030_000n);
    expect(ratioOfPrice(domain.max, domain)).toBe(0); // the $0 point is on the left
    expect(ratioOfPrice(domain.min, domain)).toBe(1);
  });

  it("hides the Now label instead of stretching the axis when spot is outside", () => {
    // Spot 229.03 is below the call's $230 start.
    const model = buildPayoffChart(call);
    expect(model.domain.min).toBe(230_000_000n);
    expect(model.spotX).toBeNull();
    const inside = buildPayoffChart({ ...call, strike: 226_000_000n });
    expect(inside.spotX).not.toBeNull();
    expect(buildPayoffChart({ ...call, spot: null, premium: null }).spotX).toBeNull();
  });

  it("puts the default handle at spot + 5 % (a put: − 5 %), to the cent, clamped", () => {
    const domain = chartDomain(false, 236_000_000n, 229_030_000n);
    expect(defaultHandlePrice(call, domain)).toBe(240_480_000n); // 229.03 × 1.05 = 240.4815 → 240.48
    const putDomain = chartDomain(true, 222_000_000n, 229_030_000n);
    expect(defaultHandlePrice(put, putDomain)).toBe(217_580_000n); // 229.03 × 0.95 = 217.5785 → 217.58
    // A strike far above spot: spot + 5 % is left of the $0 point, so the handle clamps to the domain start.
    const far = chartDomain(false, 300_000_000n, 229_030_000n);
    expect(far.min).toBe(292_000_000n);
    expect(defaultHandlePrice({ ...call, strike: 300_000_000n }, far)).toBe(far.min);
  });
});

describe("value axis", () => {
  it("starts at 0, has no negative region, and fits the curve, the hinge and the cost line", () => {
    const model = buildPayoffChart(call);
    expect(model.yTicks[0]!.label).toBe("0");
    expect(model.yTicks[0]!.at).toBe(model.baseY);
    expect(model.yTicks.every((tick) => Number(tick.label) >= 0)).toBe(true);
    const top = Number(payoutAt(model.domain.max, { isPut: false, strike: call.strike, units, exerciseFeeBps: 25 })) / 1e6;
    expect(model.yMax).toBeGreaterThanOrEqual(top);
    expect(model.costY).toBeLessThan(model.baseY);
    expect(model.costY).toBeGreaterThan(CHART_VIEW.top);
    expect(costLabel(call.cost)).toBe("You paid 5.10 · above this line is profit");
  });

  it("samples the before-expiry curve at 72 points", () => {
    const model = buildPayoffChart(call);
    expect(model.curvePath.match(/[ML]/g)).toHaveLength(CURVE_SAMPLES);
    expect(model.areaPath.endsWith("Z")).toBe(true);
  });
});

describe("implied vol from the live ask", () => {
  // Strikes whose domain contains spot 229.03, so the curve can be read at spot: a $234 call (domain from $228)
  // and a $228 put (domain up to $234). Both out of the money, so a 1.00-a-share ask is above intrinsic.
  const nearCall: ChartInput = { ...call, strike: 234_000_000n };
  const nearPut: ChartInput = { ...call, isPut: true, strike: 228_000_000n };

  it("draws the curve through the quoted premium at spot, with and without the exercise fee, 1 to 6 days out", () => {
    for (const input of [nearCall, nearPut, { ...nearCall, exerciseFeeBps: 0 }, { ...nearPut, expiry: NOW + 6 * DAY },
      { ...nearCall, premium: 2_500_000n, cost: 2_600_000n, expiry: NOW + 3_600 },
      // In the money at spot with the exercise fee: the fit must add back the fee the curve deducts at spot.
      { ...call, strike: 226_000_000n, premium: 17_500_000n, cost: 17_600_000n }]) {
      const model = buildPayoffChart(input);
      expect(model.estimate.ok, `${input.isPut} ${input.strike}`).toBe(true);
      expect(model.spotX).not.toBeNull();
      const atSpot = model.at(input.spot!);
      expect(atSpot.price).toBe(input.spot);
      expect(atSpot.estimateValue!).toBeCloseTo(Number(input.premium) / 1e6, 6);
    }
  });

  it("never uses a fixed vol: two asks on one strike fit two vols", () => {
    const cheap = buildPayoffChart({ ...nearCall, premium: 5_000_000n, cost: 5_100_000n });
    const dear = buildPayoffChart({ ...nearCall, premium: 7_500_000n, cost: 7_600_000n });
    expect(cheap.estimate.ok && dear.estimate.ok).toBe(true);
    if (cheap.estimate.ok && dear.estimate.ok) expect(dear.estimate.vol).toBeGreaterThan(cheap.estimate.vol);
  });

  it("converges to the expiry hinge as time runs out", () => {
    // Hold the vol (60 %) and shrink the time: the ask is priced from it, so the fit recovers the same vol and the
    // curve's time value must vanish. An in-the-money $226 call keeps the ask above zero at every tenor.
    const strike = 226_000_000n;
    const gap = (seconds: number) => {
      const perShare = bsPrice({ isPut: false, spot: 229.03, strike: 226, years: seconds / SECONDS_PER_YEAR }, 0.6);
      const premium = BigInt(Math.round(perShare * 5 * 1e6));
      const model = buildPayoffChart({ ...call, strike, exerciseFeeBps: 0, expiry: NOW + seconds, premium, cost: costFromQuote(premium, fees) });
      if (!model.estimate.ok) return null;
      let worst = 0;
      for (const price of [strike - 3_000_000n, strike, strike + 4_000_000n, strike + 20_000_000n]) {
        const point = model.at(price);
        worst = Math.max(worst, Math.abs(point.estimateValue! - Number(point.expiryValue) / 1e6));
      }
      return worst;
    };
    const day = gap(DAY);
    const hour = gap(3_600);
    const minute = gap(60);
    expect([day, hour, minute].every((g) => typeof g === "number")).toBe(true);
    expect(hour!).toBeLessThan(day!);
    expect(minute!).toBeLessThan(hour!);
    expect(minute!).toBeLessThan(0.5);
  });

  it("falls back to the hinge alone, and says why, when no vol fits or no time is left", () => {
    // 5 shares of a call $10 in the money are worth ≥ 50; a 5.00 premium is below intrinsic.
    const below = buildPayoffChart({ ...call, strike: 219_000_000n });
    expect(below.estimate).toEqual({ ok: false, reason: "below-intrinsic" });
    expect(below.curvePath).toBe("");
    expect(below.areaPath).not.toBe("");
    expect(chartCaptions(below)[2]).toBe(
      "No before-expiry curve because the quote is below what the option is worth at expiry. The dashed line is the value at expiry.");
    expect(tooltipFor(below, 240_000_000n).estimate).toBe("No before-expiry estimate");
    const expired = buildPayoffChart({ ...call, expiry: NOW });
    expect(expired.estimate).toEqual({ ok: false, reason: "no-time" });
    expect(chartCaptions(expired)[2]).toContain("no time is left before expiry");
    const unquoted = buildPayoffChart({ ...call, premium: null });
    expect(unquoted.estimate).toEqual({ ok: false, reason: "no-quote" });
    expect(tooltipFor(unquoted, 240_000_000n).estimate).toBe("No live quote: at-expiry value only");
  });

  it("states the fitted vol in the caption", () => {
    const model = buildPayoffChart(call);
    expect(model.estimate.ok).toBe(true);
    if (model.estimate.ok) {
      expect(chartCaptions(model)[2]).toBe(`The curve estimates what the option could sell for before expiry: Black–Scholes at ${(model.estimate.vol * 100).toFixed(0)} % implied vol from the live ask. An estimate, not a bid.`);
    }
    expect(model.estimate.ok && model.estimate.years).toBeCloseTo(DAY / SECONDS_PER_YEAR, 12);
  });
});

describe("tooltip", () => {
  // A put pays USDG outright, so its figures are exact to the cent and can be written by hand.
  const handPut: ChartInput = { ...call, isPut: true, strike: 246_000_000n, exerciseFeeBps: 0 };

  it("headlines the exact expiry P&L above break-even, with the worth and the ≈ estimate under it", () => {
    const tip = tooltipFor(buildPayoffChart(handPut), 241_000_000n);
    expect(tip.title).toBe("NVDA at $241.00");
    // 5 × 5.00 − 5.10
    expect(tip.headline).toBe("+19.90 USDG");
    expect(tip.worth).toBe("at expiry · worth 25.00");
    expect(tip.gain).toBe(true);
    // 5 × 1.00 at spot is below the $246 put's intrinsic 16.97: no estimate, and the tooltip says so.
    expect(tip.estimate).toBe("No before-expiry estimate");
    const fitted = tooltipFor(buildPayoffChart({ ...call, strike: 234_000_000n }), 241_000_000n);
    expect(fitted.estimate).toMatch(/^≈ \+\d+\.\d\d if sold a day early$/);
  });

  it("shows a loss below break-even with a minus sign, never a bare number", () => {
    const tip = tooltipFor(buildPayoffChart(handPut), 245_500_000n);
    // 5 × 0.50 − 5.10
    expect(tip.headline).toBe("−2.60 USDG");
    expect(tip.worth).toBe("at expiry · worth 2.50");
    expect(tip.gain).toBe(false);
  });

  it("uses the contract's in-kind rounding for a call, never a rounder number", () => {
    const model = buildPayoffChart({ ...call, exerciseFeeBps: 0 });
    const value = payoutAt(241_000_000n, { isPut: false, strike: call.strike, units, exerciseFeeBps: 0 });
    // Stock Tokens floored per unit, then valued at the price, floored, times 500 units: 24.9995, not 25.00.
    expect(value).toBe(24_999_500n);
    expect(tooltipFor(model, 241_000_000n).headline).toBe("+19.89 USDG");
    expect(tooltipFor(model, 241_000_000n).worth).toBe("at expiry · worth 24.99");
  });

  it("describes the early sale by the time left", () => {
    expect(earlyText(DAY)).toBe("a day early");
    expect(earlyText(3 * DAY)).toBe("3 days early");
    expect(earlyText(5 * 3_600)).toBe("5 hours early");
    expect(earlyText(3_600)).toBe("an hour early");
    expect(earlyText(600)).toBe("10 minutes early");
  });

  it("reads the aria-valuetext as a sentence: the price, its worth at expiry, and the result after the cost", () => {
    // The spec's example is a call at 241 worth 5.00; a put pays USDG exactly, so its mirror carries the same words.
    const model = buildPayoffChart({ ...handPut, cost: 1_100_000n, premium: 1_000_000n, units: 100n });
    expect(ariaValueText(model, 241_000_000n)).toBe("NVDA 241.00, worth 5.00 at expiry, plus 3.90 after the 1.10 paid");
    expect(ariaValueText(model, 245_500_000n)).toBe("NVDA 245.50, worth 0.50 at expiry, minus 0.60 after the 1.10 paid");
    expect(ariaValueText(model, 244_900_000n)).toBe("NVDA 244.90, worth 1.10 at expiry, even after the 1.10 paid");
  });
});

describe("keyboard and pointer", () => {
  const domain = chartDomain(false, 236_000_000n, 229_030_000n);

  it("steps 0.50 on arrows, 5.00 on Page Up/Down, and jumps to the edges on Home/End", () => {
    expect(ARROW_STEP).toBe(500_000n);
    expect(PAGE_STEP).toBe(5_000_000n);
    const at = 240_000_000n;
    expect(keyboardChartPrice("ArrowRight", at, domain)).toBe(240_500_000n);
    expect(keyboardChartPrice("ArrowUp", at, domain)).toBe(240_500_000n);
    expect(keyboardChartPrice("ArrowLeft", at, domain)).toBe(239_500_000n);
    expect(keyboardChartPrice("ArrowDown", at, domain)).toBe(239_500_000n);
    expect(keyboardChartPrice("PageUp", at, domain)).toBe(245_000_000n);
    expect(keyboardChartPrice("PageDown", at, domain)).toBe(235_000_000n);
    expect(keyboardChartPrice("Home", at, domain)).toBe(domain.min);
    expect(keyboardChartPrice("End", at, domain)).toBe(domain.max);
    expect(keyboardChartPrice("Tab", at, domain)).toBeNull();
  });

  it("clamps steps at the domain edges", () => {
    expect(keyboardChartPrice("PageDown", domain.min + 1_000_000n, domain)).toBe(domain.min);
    expect(keyboardChartPrice("ArrowRight", domain.max, domain)).toBe(domain.max);
  });

  it("maps a pointer ratio to a cent-snapped price, mirrored on a put's axis", () => {
    expect(priceAtRatio(0, domain)).toBe(domain.min);
    expect(priceAtRatio(1, domain)).toBe(domain.max);
    expect(priceAtRatio(2, domain)).toBe(domain.max);
    expect(priceAtRatio(0.5, domain) % 10_000n).toBe(0n);
    const putDomain = chartDomain(true, 222_000_000n, 229_030_000n);
    expect(priceAtRatio(0, putDomain)).toBe(putDomain.max);
    expect(priceAtRatio(1, putDomain)).toBe(putDomain.min);
  });
});

describe("quote caption switch", () => {
  it("defaults to the live ask, and quote: \"live\" is the same chart", () => {
    const byDefault = buildPayoffChart(call);
    const live = buildPayoffChart({ ...call, quote: "live" });
    expect(chartCaptions(live)).toEqual(chartCaptions(byDefault));
    expect(chartCaptions(live)[2]).toContain("implied vol from the live ask. An estimate, not a bid.");
    expect(tooltipFor(live, 240_000_000n)).toEqual(tooltipFor(byDefault, 240_000_000n));
    const unquoted = buildPayoffChart({ ...call, premium: null, quote: "live" });
    expect(chartCaptions(unquoted)[2]).toBe("No live ask, so no before-expiry curve: the dashed line is the value at expiry.");
    expect(tooltipFor(unquoted, 240_000_000n).estimate).toBe("No live quote: at-expiry value only");
  });

  it("gives the site's example chart one plain settlement caption, and changes no number", () => {
    const live = buildPayoffChart(call);
    const example = buildPayoffChart({ ...call, quote: "example" });
    expect(example.estimate.ok).toBe(true);
    expect(chartCaptions(example)).toEqual([SITE_CHART_CAPTION]);
    expect(SITE_CHART_CAPTION).toBe("Settles on the average price over the last 30 minutes before the close.");
    // The live chart (the app's) keeps its three captions.
    expect(chartCaptions(live)).toHaveLength(3);
    expect(example.curvePath).toBe(live.curvePath);
    expect(example.expiryPath).toBe(live.expiryPath);
    expect(example.breakeven).toBe(live.breakeven);
    const tip = tooltipFor(example, 240_000_000n);
    const { estimate: _e, ...numbers } = tip;
    const { estimate: _l, ...liveNumbers } = tooltipFor(live, 240_000_000n);
    expect(numbers).toEqual(liveNumbers);
    const unquoted = buildPayoffChart({ ...call, premium: null, quote: "example" });
    expect(chartCaptions(unquoted)).toEqual([SITE_CHART_CAPTION]);
    expect(tooltipFor(unquoted, 240_000_000n).estimate).toBe("No example quote: at-expiry value only");
  });
});

describe("conversion floor", () => {
  // The contract's lowest conversion floor: 100 % less the 3 % slippage-plus-route-fee ceiling (payoff.ts).
  const floorBps = 9_700;
  const floored = { isPut: false, strike: call.strike, units, exerciseFeeBps: call.exerciseFeeBps!, conversionFloorBps: floorBps };
  const inKind = { isPut: false, strike: call.strike, units, exerciseFeeBps: call.exerciseFeeBps! };

  it("values a call's expiry, P&L and break-even through the floor", () => {
    const model = buildPayoffChart({ ...call, conversionFloorBps: floorBps });
    const plain = buildPayoffChart(call);
    const price = 250_000_000n;
    const point = model.at(price);
    expect(point.expiryValue).toBe(payoutAt(price, floored));
    expect(point.expiryValue).toBeLessThan(plain.at(price).expiryValue);
    expect(point.pnl).toBe(point.expiryValue - call.cost);
    expect(model.breakeven).toBe(breakeven(floored, call.cost));
    expect(model.breakeven!).toBeGreaterThan(plain.breakeven!);
    expect(plain.at(price).expiryValue).toBe(payoutAt(price, inKind));
  });

  it("leaves the before-expiry estimate unconverted: it is a book sale, not a settlement", () => {
    const model = buildPayoffChart({ ...call, conversionFloorBps: floorBps });
    const plain = buildPayoffChart(call);
    expect(model.estimate).toEqual(plain.estimate);
    for (const price of [230_000_000n, 240_000_000n, 250_000_000n]) {
      expect(model.at(price).estimateValue).toBe(plain.at(price).estimateValue);
    }
  });

  it("ignores the floor on a put, which pays USDG natively", () => {
    const model = buildPayoffChart({ ...put, conversionFloorBps: floorBps });
    const plain = buildPayoffChart(put);
    expect(model.at(215_000_000n)).toEqual({ ...plain.at(215_000_000n) });
    expect(model.breakeven).toBe(plain.breakeven);
    expect(model.expiryPath).toBe(plain.expiryPath);
  });
});
