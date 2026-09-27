/**
 * Realized vol of a token over its recent on-chain price history, on the
 * same trading clock every vol in this service uses (bs.ts: σ per trading year of session seconds).
 *
 * THE SERIES. One `observe(secondsAgos)` call on the market's registry v3 pool returns tick cumulatives at
 * evenly spaced instants t_0 < t_1 < … < t_n. Each adjacent pair gives the pool's geometric TWAP over
 * (t_{i-1}, t_i]: mean tick = Δcumulative / Δt, i.e. the time-average of the log price. That is a recorded,
 * manipulation-resistant series one RPC call can fetch; the Chainlink feed is not used, because it prints
 * on a 0.5% deviation (ChainlinkFeedSource.sol:17) and a deviation-triggered sample is not a time series.
 *
 * THE ESTIMATE. r_i = A_{i+1} − A_i, the difference of two ADJACENT window means of the log price. For a
 * log price with variance σ² per second, Var(r_i) = (2/3)·σ²·Δ, not σ²·Δ: averaging smooths each window, so
 * a sum of squared TWAP differences under-reads the variance by a third. The estimate undoes that:
 *   σ²/s = (3/2) · Σ r_i² / (n · Δ),     σ (trading-year) = √(σ²/s × TRADING_YEAR_SECONDS).
 * Only returns whose two windows lie wholly inside a regular NYSE session count (sessionSecondsBetween over
 * the pair's span equals the span): the trading clock gives closed time no variance, and an overnight or
 * weekend gap in the pool would otherwise be divided by session seconds it does not have. The mean return
 * is not removed (a short-horizon estimate; drift is noise at 5-minute steps).
 *
 * WHAT IT CANNOT SEE. A pool that trades rarely moves in steps when it is arbitraged, which reads LOW;
 * that is why the ask uses max(live IV, realized, floor) and realized can only ever raise it (fair.ts
 * askIvFor). Fewer than `minReturns` in-session returns is "not enough history", never a zero vol.
 *
 * Pure.
 */
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { TRADING_YEAR_SECONDS, sessionSecondsBetween } from './bs.js';

const LN_TICK = Math.log(1.0001);

/** One window's time-average of the log price (USDG per token), and the window it averages. */
export interface TwapPoint {
  /** Unix seconds: the window is (from, to]. */
  from: number;
  to: number;
  /** Mean of ln(USDG per whole token) over the window, up to a constant (decimals cancel in returns). */
  meanLogPrice: number;
}

/**
 * The window means from one `observe(secondsAgos)` reply. `instants[i]` is the unix time of
 * `tickCumulatives[i]`, strictly increasing. USDG per token rises with the tick when the asset is token0
 * and falls with it when USDG is token0 (pool-spot.ts quoteAtTick), so the sign follows the pool's order.
 */
export function twapSeries(instants: readonly number[], tickCumulatives: readonly bigint[], usdgIsToken0: boolean): TwapPoint[] {
  if (instants.length !== tickCumulatives.length) throw new Error(`twapSeries: ${instants.length} instants for ${tickCumulatives.length} cumulatives`);
  const sign = usdgIsToken0 ? -1 : 1;
  const out: TwapPoint[] = [];
  for (let i = 1; i < instants.length; i += 1) {
    const from = instants[i - 1]!;
    const to = instants[i]!;
    if (!(to > from)) throw new Error(`twapSeries: instants are not strictly increasing at ${i}: ${from} then ${to}`);
    const meanTick = Number(tickCumulatives[i]! - tickCumulatives[i - 1]!) / (to - from);
    out.push({ from, to, meanLogPrice: sign * meanTick * LN_TICK });
  }
  return out;
}

export interface RealizedSettings {
  /** Fewest in-session returns an estimate is made from. */
  minReturns: number;
  holidays: readonly string[];
}

export const DEFAULT_REALIZED_SETTINGS: RealizedSettings = { minReturns: 12, holidays: NYSE_HOLIDAYS_2026_2028 };

export type RealizedVol =
  | { ok: true; vol: number; returns: number; skipped: number; from: number; to: number }
  | { ok: false; why: string; returns: number; skipped: number };

/**
 * Annualised realized vol on the trading clock from equal-length adjacent TWAP windows. See THE ESTIMATE.
 * A pair of windows of unequal length, or not adjacent, or not wholly in session, is skipped (`skipped`).
 */
export function realizedVolFromTwaps(points: readonly TwapPoint[], settings: Partial<RealizedSettings> = {}): RealizedVol {
  const { minReturns, holidays } = { ...DEFAULT_REALIZED_SETTINGS, ...settings };
  let sumSq = 0;
  let sumDt = 0;
  let returns = 0;
  let skipped = 0;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dt = a.to - a.from;
    const adjacent = a.to === b.from && b.to - b.from === dt;
    const inSession = adjacent && sessionSecondsBetween(a.from, b.to, holidays) === b.to - a.from;
    if (!inSession || !Number.isFinite(a.meanLogPrice) || !Number.isFinite(b.meanLogPrice)) {
      skipped += 1;
      continue;
    }
    const r = b.meanLogPrice - a.meanLogPrice;
    sumSq += r * r;
    sumDt += dt;
    returns += 1;
    from = Math.min(from, a.from);
    to = Math.max(to, b.to);
  }
  if (returns < minReturns) return { ok: false, why: `${returns} in-session returns, fewer than ${minReturns}`, returns, skipped };
  const varPerSecond = (1.5 * sumSq) / sumDt;
  return { ok: true, vol: Math.sqrt(varPerSecond * TRADING_YEAR_SECONDS), returns, skipped, from, to };
}

/**
 * The `secondsAgos` for one `observe` call: instants every `stepS` seconds, aligned down to a multiple of
 * `stepS`, covering `lookbackS` back from `nowSeconds`, oldest first. Returned with the instants they name.
 */
export function observeSchedule(nowSeconds: number, lookbackS: number, stepS: number): { instants: number[]; secondsAgos: number[] } {
  if (!(stepS > 0) || !(lookbackS >= 2 * stepS)) throw new Error(`observeSchedule: lookback ${lookbackS} s must cover at least two steps of ${stepS} s`);
  const end = Math.floor(nowSeconds / stepS) * stepS;
  const instants: number[] = [];
  for (let t = end - Math.floor(lookbackS / stepS) * stepS; t <= end; t += stepS) instants.push(t);
  return { instants, secondsAgos: instants.map((t) => nowSeconds - t) };
}
