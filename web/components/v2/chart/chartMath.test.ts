/**
 * The ticker charts' arithmetic: axis levels, time ticks, downsampling, which point the crosshair lands on,
 * and the date + hour / price labels it prints.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DRAWN_POINTS, changeOf, downsample, formatChartPrice, formatHoverTime, formatTimeTick, nearestIndex, niceTicks,
  ticksShowHours, timeTicks, type ChartPoint,
} from "./chartMath";

describe("niceTicks", () => {
  it("covers the range with 4-6 round levels", () => {
    const t = niceTicks(228.4, 231.7);
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.length).toBeLessThanOrEqual(6);
    expect(t[0]).toBeLessThanOrEqual(228.4);
    expect(t.at(-1)).toBeGreaterThanOrEqual(231.7);
    // Evenly spaced on a 1/2/2.5/5 x 10^n step.
    const step = t[1] - t[0];
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeCloseTo(step, 9);
    expect([0.5, 1, 2, 2.5, 5].some((m) => Math.abs(step - m) < 1e-9)).toBe(true);
  });

  it("gives a flat price levels around it instead of none", () => {
    const t = niceTicks(229, 229);
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(t[0]).toBeLessThan(229);
    expect(t.at(-1)).toBeGreaterThan(229);
  });

  it("handles sub-dollar prices without float dust", () => {
    const t = niceTicks(0.0123, 0.0189);
    for (const v of t) expect(String(v).length).toBeLessThan(10);
  });

  it("returns nothing for a non-finite range", () => {
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });
});

describe("timeTicks", () => {
  const H = 3_600;
  it("puts hourly-ish ticks on round boundaries inside a day", () => {
    const t0 = 1_790_000_000;
    const ticks = timeTicks(t0, t0 + 24 * H);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
    for (const t of ticks) {
      expect(t % H).toBe(0);
      expect(t).toBeGreaterThanOrEqual(t0);
      expect(t).toBeLessThanOrEqual(t0 + 24 * H);
    }
  });

  it("uses day steps for a month and shows dates, not hours", () => {
    const t0 = 1_790_000_000;
    const ticks = timeTicks(t0, t0 + 30 * 86_400);
    for (const t of ticks) expect(t % 86_400).toBe(0);
    expect(ticksShowHours(t0, t0 + 30 * 86_400)).toBe(false);
    expect(ticksShowHours(t0, t0 + 86_400)).toBe(true);
  });

  it("is empty for an empty span", () => {
    expect(timeTicks(10, 10)).toEqual([]);
  });
});

describe("downsample", () => {
  const series = (n: number): ChartPoint[] => Array.from({ length: n }, (_, i) => ({ t: i * 60, v: 100 + Math.sin(i / 7) }));

  it("leaves a short series alone", () => {
    const s = series(50);
    expect(downsample(s)).toEqual(s);
  });

  it("cuts a long series to the cap, keeping both ends in time order", () => {
    const s = series(2_000);
    const d = downsample(s);
    expect(d.length).toBe(MAX_DRAWN_POINTS);
    expect(d[0]).toEqual(s[0]);
    expect(d.at(-1)).toEqual(s.at(-1));
    for (let i = 1; i < d.length; i++) expect(d[i].t).toBeGreaterThan(d[i - 1].t);
  });

  it("keeps a lone spike instead of averaging it away -- the control against a plain stride", () => {
    const s = series(2_000).map((p, i) => (i === 1_234 ? { ...p, v: 500 } : p));
    expect(downsample(s).some((p) => p.v === 500)).toBe(true);
  });
});

describe("nearestIndex", () => {
  const pts: ChartPoint[] = [{ t: 0, v: 1 }, { t: 10, v: 2 }, { t: 20, v: 3 }];
  it("finds the nearest time, ends included", () => {
    expect(nearestIndex(pts, -5)).toBe(0);
    expect(nearestIndex(pts, 4)).toBe(0);
    expect(nearestIndex(pts, 6)).toBe(1);
    expect(nearestIndex(pts, 16)).toBe(2);
    expect(nearestIndex(pts, 99)).toBe(2);
    expect(nearestIndex([], 1)).toBe(-1);
  });
});

describe("labels", () => {
  it("prints price with at most 2 decimals and no zero tails", () => {
    expect(formatChartPrice(229)).toBe("$229");
    expect(formatChartPrice(229.5)).toBe("$229.5");
    expect(formatChartPrice(229.456)).toBe("$229.46");
    expect(formatChartPrice(1_234.5)).toBe("$1,234.5");
    expect(formatChartPrice(0.01234)).toBe("$0.0123");
  });

  it("prints the crosshair's date + hour, zone named", () => {
    // 2026-09-24 14:00:00 UTC
    expect(formatHoverTime(1_790_258_400, "UTC")).toBe("Sep 24, 2:00 PM UTC");
    expect(formatHoverTime(1_790_258_400, "America/New_York")).toBe("Sep 24, 10:00 AM EDT");
    expect(formatHoverTime(1_790_258_400, "America/Los_Angeles")).toBe("Sep 24, 7:00 AM PDT");
    // No zone given (a server render): New York, never the process zone.
    expect(formatHoverTime(1_790_258_400)).toBe("Sep 24, 10:00 AM EDT");
  });

  it("prints axis ticks as clock times for short spans and dates otherwise", () => {
    expect(formatTimeTick(1_790_258_400, true, "UTC")).toBe("14:00");
    expect(formatTimeTick(1_790_258_400, false, "UTC")).toBe("Sep 24");
  });

  it("gives the change over the points, signed", () => {
    expect(changeOf([{ t: 0, v: 200 }, { t: 1, v: 204.6 }])?.label).toBe("+2.30%");
    expect(changeOf([{ t: 0, v: 200 }, { t: 1, v: 190 }])?.label).toBe("-5.00%");
    expect(changeOf([{ t: 0, v: 200 }])).toBeNull();
  });
});
