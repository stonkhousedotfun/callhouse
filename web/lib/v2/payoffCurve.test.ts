import { describe, expect, it } from "vitest";

import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, breakevenUsdg, payoutAt } from "./payoff";
import {
  CURVE_VIEW, buildPayoffCurve, clampPrice, keyboardPriceStep, payoffPriceRange, presetPrices, priceAtRatio,
} from "./payoffCurve";

const usd = (amount: number) => BigInt(Math.round(amount * 1_000_000));

describe("payoff slider price range and input", () => {
  it("uses 25% around a nearby strike and three strike distances around a far strike", () => {
    // T-OP-120 widened 15% to 25% so the ±20% presets (design §2.3) sit inside the view.
    expect(payoffPriceRange(usd(200), usd(210))).toEqual({ min: usd(150), max: usd(250) });
    expect(payoffPriceRange(usd(200), usd(250))).toEqual({ min: usd(50), max: usd(350) });
    expect(payoffPriceRange(usd(100), usd(200))).toEqual({ min: 0n, max: usd(400) });
  });

  it("keeps every preset and the strike inside the range", () => {
    for (const [spot, strike] of [[usd(200), usd(210)], [usd(200), usd(250)], [usd(100), usd(200)], [usd(33.33), usd(30)]] as const) {
      const range = payoffPriceRange(spot, strike);
      for (const preset of presetPrices(spot, strike, null)) {
        if (preset.price === null) continue;
        expect(preset.price, `${preset.key} at spot ${spot}`).toBeGreaterThanOrEqual(range.min);
        expect(preset.price, `${preset.key} at spot ${spot}`).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it("lists the presets in design order, as percentages of spot snapped to the cent", () => {
    const presets = presetPrices(usd(200), usd(230), usd(234.772778));
    expect(presets.map((p) => p.key)).toEqual(["-20", "-10", "-5", "spot", "+5", "+10", "+20", "strike", "breakeven"]);
    expect(presets.map((p) => p.price)).toEqual([usd(160), usd(180), usd(190), usd(200), usd(210), usd(220), usd(240), usd(230), usd(234.772778)]);
    expect(presets.map((p) => p.label)).toEqual(["−20 %", "−10 %", "−5 %", "Spot", "+5 %", "+10 %", "+20 %", "At strike", "Break-even"]);
    // 33.33 × 1.05 = 34.9965 snaps to 35.00; nothing below one cent.
    expect(presetPrices(usd(33.33), usd(30), null).find((p) => p.key === "+5")!.price).toBe(usd(35));
    expect(presetPrices(1n, 1n, null).find((p) => p.key === "-20")!.price).toBe(10_000n);
    expect(presetPrices(usd(200), usd(230), null).at(-1)).toEqual({ key: "breakeven", label: "Break-even", price: null });
    expect(() => presetPrices(0n, usd(1), null)).toThrow();
  });

  it("clamps drag and keyboard positions and snaps pointer prices to cents", () => {
    const range = { min: usd(170), max: usd(230) };
    expect(clampPrice(usd(100), range)).toBe(range.min);
    expect(clampPrice(usd(300), range)).toBe(range.max);
    expect(priceAtRatio(-1, range)).toBe(range.min);
    expect(priceAtRatio(0.5, range)).toBe(usd(200));
    expect(priceAtRatio(2, range)).toBe(range.max);
    expect(priceAtRatio(0.3333, range) % 10_000n).toBe(0n);
    expect(keyboardPriceStep(range)).toBe(usd(0.6));
    expect(() => priceAtRatio(NaN, range)).toThrow();
  });
});

describe("fee-net payoff geometry", () => {
  it("draws a call flat at the full cost below strike, then rises through exact break-even", () => {
    const position = { isPut: false, strike: usd(200), units: 10n, exerciseFeeBps: 25 };
    const cost = usd(0.8);
    const curve = buildPayoffCurve(usd(200), position, cost);
    expect(curve.pointAt(usd(170)).pnl).toBe(-cost);
    expect(curve.pointAt(usd(190)).pnl).toBe(-cost);
    expect(curve.pointAt(position.strike).pnl).toBe(-cost);
    expect(curve.pointAt(usd(220)).pnl).toBe(payoutAt(usd(220), position) - cost);
    expect(curve.pointAt(usd(220)).pnl).toBeGreaterThan(0n);
    expect(curve.breakevenPrice).not.toBeNull();
    expect(curve.breakevenX).not.toBeNull();
    expect(curve.pointAt(curve.breakevenPrice!).pnl).toBeGreaterThanOrEqual(0n);
    expect(curve.pointAt(curve.breakevenPrice! - 1n).pnl).toBeLessThan(0n);
    expect(curve.strikeX).toBeCloseTo(CURVE_VIEW.width / 2);
    expect(curve.spotX).toBeCloseTo(CURVE_VIEW.width / 2);
    expect(curve.path.startsWith("M")).toBe(true);
    expect(curve.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });

  it("mirrors a put and marks a break-even on the lower-price side", () => {
    const position = { isPut: true, strike: usd(200), units: 10n, exerciseFeeBps: 25 };
    const cost = usd(0.8);
    const curve = buildPayoffCurve(usd(200), position, cost);
    expect(curve.pointAt(usd(220)).pnl).toBe(-cost);
    expect(curve.pointAt(usd(200)).pnl).toBe(-cost);
    expect(curve.pointAt(usd(170)).pnl).toBeGreaterThan(0n);
    expect(curve.breakevenPrice).not.toBeNull();
    expect(curve.breakevenPrice!).toBeLessThan(position.strike);
    expect(curve.breakevenX!).toBeLessThan(curve.strikeX!);
    expect(curve.pointAt(curve.breakevenPrice!).pnl).toBeGreaterThanOrEqual(0n);
  });

  it("responds to ticket quantity and total cost", () => {
    const one = { isPut: false, strike: usd(200), units: 1n, exerciseFeeBps: 25 };
    const ten = { ...one, units: 10n };
    const oneCurve = buildPayoffCurve(usd(200), one, usd(0.1));
    const tenCurve = buildPayoffCurve(usd(200), ten, usd(1));
    expect(tenCurve.pointAt(usd(220)).pnl).toBe(oneCurve.pointAt(usd(220)).pnl * 10n);
    expect(tenCurve.pointAt(usd(180)).pnl).toBe(oneCurve.pointAt(usd(180)).pnl * 10n);
  });

  it("handles break-even outside the view or impossible put payout", () => {
    const put = { isPut: true, strike: usd(200), units: 1n, exerciseFeeBps: 25 };
    const curve = buildPayoffCurve(usd(200), put, usd(3));
    expect(curve.breakevenPrice).toBeNull();
    expect(curve.breakevenX).toBeNull();
    expect(curve.breakevenUsdgX).toBeNull();
    expect(curve.pointAt(usd(500)).price).toBe(curve.range.max);
  });

  it("fills the gain and the loss sides against the zero line and never across it", () => {
    const position = { isPut: false, strike: usd(200), units: 10n, exerciseFeeBps: 25 };
    const cost = usd(0.8);
    const beUsdg = breakevenUsdg(position, cost, MAX_PAYOUT_SLIPPAGE_CEIL_BPS);
    const curve = buildPayoffCurve(usd(200), position, cost, beUsdg);
    expect(curve.domain.low).toBe(-cost);
    expect(curve.domain.high).toBeGreaterThan(0n);
    expect(curve.breakevenUsdgPrice).toBe(beUsdg);
    expect(curve.breakevenUsdgX!).toBeGreaterThan(curve.breakevenX!);
    // Both fills are closed and start and end on the zero line.
    for (const path of [curve.gainPath, curve.lossPath]) {
      expect(path.startsWith(`M${CURVE_VIEW.left.toFixed(2)} ${curve.zeroY.toFixed(2)}`)).toBe(true);
      expect(path.endsWith(`${curve.zeroY.toFixed(2)} Z`)).toBe(true);
    }
    // The gain fill never dips below zero (SVG y grows downward) and the loss fill never rises above it. Path
    // coordinates are written to two decimals, hence the half-unit tolerance.
    const ys = (path: string) => [...path.matchAll(/L[\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys(curve.gainPath).every((y) => y <= curve.zeroY + 0.005)).toBe(true);
    expect(ys(curve.lossPath).every((y) => y >= curve.zeroY - 0.005)).toBe(true);
    // Left of break-even the gain fill is flat on the zero line; right of it, it lifts off.
    const left = curve.pointAt(usd(150));
    const right = curve.pointAt(usd(250));
    expect(curve.gainPath).toContain(`L${left.x.toFixed(2)} ${curve.zeroY.toFixed(2)}`);
    expect(curve.gainPath).toContain(`L${right.x.toFixed(2)} ${right.y.toFixed(2)}`);
    expect(curve.lossPath).toContain(`L${left.x.toFixed(2)} ${left.y.toFixed(2)}`);
    expect(curve.lossPath).toContain(`L${right.x.toFixed(2)} ${curve.zeroY.toFixed(2)}`);
    expect(() => buildPayoffCurve(usd(200), position, cost, -1n)).toThrow();
  });
});
