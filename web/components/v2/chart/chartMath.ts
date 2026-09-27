import { localStamp, NEW_YORK_TIME_ZONE } from "@/lib/v2/time";

/**
 * The arithmetic behind the ticker page's line charts ("when scrolling over the charts we
 * should be able to see the date + hour on the X axis and the price on the Y axis, these graphs need to be so much
 * better"). Pure functions only, so the node-only vitest run covers every number the chart draws: the axis ticks, the
 * downsampling, which point the crosshair lands on, and the labels it prints.
 */

/** One drawn point: unix seconds and a price in dollars. */
export type ChartPoint = { t: number; v: number };

/** At most this many points are drawn; more is invisible at chart widths and slows the pointer handler. */
export const MAX_DRAWN_POINTS = 300;

/**
 * 4-6 round price levels covering [lo, hi]: steps of 1, 2, 2.5 or 5 times a power of ten, the first tick at or below
 * `lo` and the last at or above `hi`. A flat range is widened around its value so the axis still has levels.
 */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.01;
    lo -= pad;
    hi += pad;
  }
  const rough = (hi - lo) / Math.max(1, target - 1);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const first = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) ticks.push(roundTo(v, step));
  if (ticks.at(-1)! < hi) ticks.push(roundTo(ticks.at(-1)! + step, step));
  return ticks;
}

function roundTo(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  return Number(v.toFixed(decimals));
}

const HOUR = 3_600;
const DAY = 86_400;
/** Candidate time-tick spacings, seconds: 15 min up to 30 days. */
const TIME_STEPS = [900, 1_800, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

/**
 * About `target` time ticks inside [t0, t1], on round boundaries of the chosen spacing (in UTC, so a tick at a
 * whole hour stays a whole hour for every viewer whose offset is a whole number of hours).
 */
export function timeTicks(t0: number, t1: number, target = 5): number[] {
  if (!(t1 > t0)) return [];
  const rough = (t1 - t0) / target;
  const step = TIME_STEPS.find((s) => s >= rough) ?? TIME_STEPS.at(-1)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  return ticks;
}

/** Whether a span is short enough that its ticks should read as clock times rather than dates. */
export function ticksShowHours(t0: number, t1: number): boolean {
  return t1 - t0 <= 2 * DAY;
}

/**
 * Largest-triangle-three-buckets downsampling to at most `max` points. It keeps the first and last points and, in
 * each bucket, the point that best preserves the line's shape, so peaks and troughs survive instead of being
 * averaged away. Input must be sorted by time; returned unchanged when it is already small enough.
 */
export function downsample(points: readonly ChartPoint[], max = MAX_DRAWN_POINTS): ChartPoint[] {
  if (max < 3 || points.length <= max) return [...points];
  const out: ChartPoint[] = [points[0]];
  const every = (points.length - 2) / (max - 2);
  let a = 0;
  for (let i = 0; i < max - 2; i++) {
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * every) + 1, points.length);
    let avgT = 0;
    let avgV = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      avgT += points[j].t;
      avgV += points[j].v;
    }
    const n = Math.max(1, nextEnd - nextStart);
    avgT /= n;
    avgV /= n;

    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    let best = start;
    let bestArea = -1;
    for (let j = start; j < end; j++) {
      const area = Math.abs(
        (points[a].t - avgT) * (points[j].v - points[a].v) - (points[a].t - points[j].t) * (avgV - points[a].v),
      );
      if (area > bestArea) {
        bestArea = area;
        best = j;
      }
    }
    out.push(points[best]);
    a = best;
  }
  out.push(points.at(-1)!);
  return out;
}

/** Index of the point whose time is nearest `t` (points sorted by time), or -1 for none. */
export function nearestIndex(points: readonly ChartPoint[], t: number): number {
  if (points.length === 0) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? lo : hi;
}

const PRICE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const SMALL_PRICE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

/** A price for an axis or the crosshair: at most 2 decimals (4 below $1), no zero tails, a leading "$". */
export function formatChartPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `$${(Math.abs(v) < 1 ? SMALL_PRICE : PRICE).format(v)}`;
}

/**
 * The crosshair's date and time in the given zone, zone named: "Sep 24, 1:00 PM PDT". Callers pass the
 * reader's zone once mounted (components/ui/Time.tsx `useViewerTimeZone`); without one it is New York, never the
 * process zone, because a server render on Railway would otherwise print UTC.
 */
export function formatHoverTime(t: number, timeZone?: string): string {
  return localStamp(t, timeZone ?? NEW_YORK_TIME_ZONE);
}

/** An X-axis tick: a clock time for short spans ("14:00"), a date otherwise ("Sep 24"). */
export function formatTimeTick(t: number, hours: boolean, timeZone: string = NEW_YORK_TIME_ZONE): string {
  // The reader's zone when the caller has it, else New York; never the process zone (UTC on a server).
  const d = new Date(t * 1000);
  return hours
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

/** Signed percent change from the first to the last point, e.g. "+2.3%", or null with fewer than two points. */
export function changeOf(points: readonly ChartPoint[]): { pct: number; label: string } | null {
  if (points.length < 2 || !(points[0].v > 0)) return null;
  const pct = ((points.at(-1)!.v - points[0].v) / points[0].v) * 100;
  const shown = Math.abs(pct) < 10 ? pct.toFixed(2) : pct.toFixed(1);
  return { pct, label: `${pct >= 0 ? "+" : ""}${shown}%` };
}
