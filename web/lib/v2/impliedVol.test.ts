import { describe, expect, it } from "vitest";

import { SECONDS_PER_YEAR, VOL_MAX, VOL_MIN, bsPrice, impliedVol, intrinsic, normCdf } from "./impliedVol";

/**
 * Chart criterion 3. The before-expiry curve backs its vol out of the live ask, so the curve at spot IS the
 * quote. Reference values are textbook Black–Scholes (r = 0), computed independently of this file (Python math.erf).
 */
const oneDay = 86_400 / SECONDS_PER_YEAR;

describe("normal CDF", () => {
  it("matches math.erf to 1e-12", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
    expect(normCdf(1)).toBeCloseTo(0.8413447460685429, 12);
    expect(normCdf(-1.96)).toBeCloseTo(0.024997895148220428, 12);
    expect(normCdf(3)).toBeCloseTo(0.9986501019683699, 12);
  });
});

describe("Black–Scholes, r = 0", () => {
  it("prices an at-the-money call and put the same (put–call parity at the money)", () => {
    // ATM, r = 0: C = P = S (2N(σ√T/2) − 1). σ = 0.2, T = 1: 100 × (2N(0.1) − 1) = 7.9655674554.
    const call = bsPrice({ isPut: false, spot: 100, strike: 100, years: 1 }, 0.2);
    const put = bsPrice({ isPut: true, spot: 100, strike: 100, years: 1 }, 0.2);
    expect(call).toBeCloseTo(7.965567455405798, 9);
    expect(put).toBeCloseTo(call, 9);
  });

  it("satisfies parity C − P = S − K off the money", () => {
    const input = { spot: 229.03, strike: 236, years: 3 * oneDay };
    const call = bsPrice({ ...input, isPut: false }, 0.6);
    const put = bsPrice({ ...input, isPut: true }, 0.6);
    expect(call - put).toBeCloseTo(229.03 - 236, 9);
  });

  it("collapses to intrinsic at zero time or zero vol", () => {
    expect(bsPrice({ isPut: false, spot: 250, strike: 236, years: 0 }, 0.5)).toBe(14);
    expect(bsPrice({ isPut: true, spot: 230, strike: 236, years: 1 }, 0)).toBe(6);
    expect(bsPrice({ isPut: false, spot: 230, strike: 236, years: 0 }, 0.5)).toBe(0);
  });

  it("rises with vol", () => {
    const input = { isPut: false, spot: 229.03, strike: 245, years: oneDay };
    expect(bsPrice(input, 0.8)).toBeGreaterThan(bsPrice(input, 0.4));
  });
});

describe("implied vol from the ask", () => {
  it("round-trips: the vol it returns reprices the ask", () => {
    for (const [isPut, strike, vol, days] of [
      [false, 236, 0.45, 1], [false, 245, 0.9, 1], [true, 220, 0.6, 3], [false, 229, 0.3, 6], [true, 240, 1.5, 0.25],
    ] as const) {
      const input = { isPut, spot: 229.03, strike, years: days * oneDay };
      const ask = bsPrice(input, vol);
      const solved = impliedVol(input, ask);
      expect(solved.ok, `${isPut ? "put" : "call"} ${strike}`).toBe(true);
      if (!solved.ok) continue;
      expect(solved.vol).toBeCloseTo(vol, 6);
      expect(bsPrice(input, solved.vol)).toBeCloseTo(ask, 9);
    }
  });

  it("fits a 0.47 quote on a $245 call exactly, where a fixed 50 % vol would not", () => {
    const input = { isPut: false, spot: 229.03, strike: 245, years: oneDay };
    expect(Math.abs(bsPrice(input, 0.5) - 0.47)).toBeGreaterThan(0.01);
    const solved = impliedVol(input, 0.47);
    expect(solved.ok).toBe(true);
    if (solved.ok) expect(bsPrice(input, solved.vol)).toBeCloseTo(0.47, 9);
  });

  it("refuses an ask below intrinsic, at zero time, above the model ceiling, and bad input", () => {
    const itm = { isPut: false, spot: 250, strike: 236, years: oneDay };
    expect(intrinsic(itm)).toBe(14);
    expect(impliedVol(itm, 13)).toEqual({ ok: false, reason: "below-intrinsic" });
    expect(impliedVol({ ...itm, years: 0 }, 15)).toEqual({ ok: false, reason: "no-time" });
    expect(impliedVol({ ...itm, years: -1 }, 15)).toEqual({ ok: false, reason: "no-time" });
    // A call can never be worth the stock itself.
    expect(impliedVol(itm, 250)).toEqual({ ok: false, reason: "above-max" });
    // Worth more than the vol ceiling allows, but less than the stock.
    const otm = { isPut: false, spot: 100, strike: 150, years: oneDay };
    expect(bsPrice(otm, VOL_MAX)).toBeLessThan(99);
    expect(impliedVol(otm, 99)).toEqual({ ok: false, reason: "above-max" });
    expect(impliedVol(itm, 0)).toEqual({ ok: false, reason: "invalid" });
    expect(impliedVol(itm, Number.NaN)).toEqual({ ok: false, reason: "invalid" });
    expect(impliedVol({ ...itm, spot: 0 }, 1)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a price above intrinsic that even the minimum vol overprices", () => {
    // At the money over a year, even VOL_MIN is worth 100 × (2N(0.0005) − 1) ≈ 0.0399 against intrinsic 0.
    const input = { isPut: false, spot: 100, strike: 100, years: 1 };
    expect(bsPrice(input, VOL_MIN)).toBeCloseTo(0.0399, 4);
    expect(impliedVol(input, 0.02)).toEqual({ ok: false, reason: "below-min-vol" });
  });
});
