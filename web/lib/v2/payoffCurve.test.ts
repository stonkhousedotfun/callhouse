import { describe, expect, it } from "vitest";

import { payoutAt } from "./payoff";
import {
  CURVE_VIEW, buildPayoffCurve, clampPrice, keyboardPriceStep, payoffPriceRange, priceAtRatio,
} from "./payoffCurve";

const usd = (amount: number) => BigInt(Math.round(amount * 1_000_000));

describe("payoff slider price range and input", () => {
  it("uses 15% around a nearby strike and three strike distances around a far strike", () => {
    expect(payoffPriceRange(usd(200), usd(210))).toEqual({ min: usd(170), max: usd(230) });
    expect(payoffPriceRange(usd(200), usd(250))).toEqual({ min: usd(50), max: usd(350) });
    expect(payoffPriceRange(usd(100), usd(200))).toEqual({ min: 0n, max: usd(400) });
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
    expect(curve.pointAt(usd(500)).price).toBe(curve.range.max);
  });
});
