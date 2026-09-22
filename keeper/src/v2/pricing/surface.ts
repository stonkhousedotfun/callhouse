/**
 * The implied-vol surface of one chain: what vol the listed market is paying, per expiry and
 * strike, and how to read it at a strike or an expiry nobody lists.
 *
 * SPACE. Everything here is in the listed market's terms: share USD, the provider's listed strikes and
 * expiry days, and time on the trading clock measured from the chain's pricing clock (bs.ts; Cboe's
 * last trade, cboe.ts checkChain). The token only enters in fair.ts, which carries VOL, not price,
 * across (see its header).
 *
 * INPUT. A provider-neutral chain (chain.ts NormalizedChain). Only its listed quotes with the
 * provider's greeks feed the surface (chain.ts listedOptions); a provider theoretical value never
 * does, and a row stating a non-standard contract multiplier or another root is left out.
 *
 * PER EXPIRY
 *   forward   put-call parity at r = 0: F = K + C - P, from the (up to) PARITY_PAIRS strikes
 *             nearest the chain's spot where both sides quote, median. This is not a nicety.
 *             `current_price` is the underlying's LAST price, after-hours included, while the
 *             option quotes stop at the close: the real 2026-09-14 NVDA file says 212.04 against
 *             a parity forward of 211.06 on both expiries, and the 2026-09-16 TSLA file 359.94
 *             against 358.36. Solving vol against `current_price` would read every call as
 *             cheap and every put as rich by the after-hours move. The forward also absorbs the
 *             listed market's rate and dividends. Refused (`chain-inconsistent`) when fewer than
 *             half the pairs agree with the median within their half-spreads plus
 *             PARITY_TOLERANCE_BPS, or when the forward sits more than
 *             MAX_FORWARD_DIVERGENCE_BPS from the spot (a file whose options are from another
 *             day). No pair at all: the spot, flagged.
 *   points    one per listed strike: the vol solved from the mid of the OUT-of-the-money side
 *             (calls at or above the forward, puts below), whose time value is most of its price;
 *             the in-the-money side only when the OTM quote is unusable or does not solve. Kept
 *             inside [IV_FLOOR, IV_CEILING].
 *   excluded  expiries at or before the chain's last trade, with less than
 *             MIN_SURFACE_SESSION_S of session left at it (the same-day expiry a closing file
 *             still lists), or beyond SURFACE_HORIZON_DAYS.
 *
 * READING IT (volAt)
 *   strike    linear in vol between the two listed points around it, flat beyond the outermost
 *             point on either wing. The points used must pass the window checks on their own
 *             side's quotes (cboe.ts checkQuoteWindow), and two points more than maxBracketGap
 *             apart are not interpolated across.
 *   expiry    linear in total variance (σ²T) between the listed expiries either side, flat vol
 *             before the first and after the last. An expiry that is needed and failed (parity,
 *             no quotes) fails the read; a neighbour is never silently substituted for it.
 *
 * Pure.
 */
import { CLOSE_HOUR_ET, NYSE_HOLIDAYS_2026_2028, newYorkTimeToUnix } from '../../calendar.js';
import { maxBracketGap } from '../../vol.js';
import { bsDelta, impliedVol, sessionSecondsBetween, tradingYears } from './bs.js';
import { checkQuoteWindow, failure, filterQuotes, mid, type OptionSide, type PricingFailure } from './cboe.js';
import { listedOptions, type ListedOption, type NormalizedChain } from './chain.js';

/*//////////////////////////////////////////////////////////////
                            CONSTANTS
//////////////////////////////////////////////////////////////*/

/** No listed single name trades under 1% vol; a solved vol below it is a stale or locked quote. */
export const IV_FLOOR = 0.01;
/** 500%: dailies on the registry's most volatile names print in the low hundreds near the close. */
export const IV_CEILING = 5;

/** How far past the chain's last trade an expiry is kept, calendar days. MAX_TENOR is 45 days;
 *  the rest is room for the listed expiry on the far side of a 45-day target. */
export const SURFACE_HORIZON_DAYS = 90;

/** An expiry with less session than this left at the chain's last trade is over: a closing file
 *  still lists the day's expiry, one second from its close, with mids at intrinsic. */
export const MIN_SURFACE_SESSION_S = 900;

/** Strikes used for the parity forward, nearest the spot first, within PARITY_STRIKE_BAND of it. */
export const PARITY_PAIRS = 4;
export const PARITY_STRIKE_BAND = 0.1;
/** Slack on top of the two half-spreads when a pair's forward is compared with the median. */
export const PARITY_TOLERANCE_BPS = 10;
/** The forward may sit this far from the chain's spot; an earnings move after the close is ~10%
 *  on the wildest names, but those nights the closing vols are not today's market anyway. */
export const MAX_FORWARD_DIVERGENCE_BPS = 500;

const EPSILON = 1e-9;

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export interface SurfacePoint {
  /** Share USD, as listed. */
  strike: number;
  /** Solved from `side`'s mid, floored and capped. */
  iv: number;
  side: OptionSide;
  /** Mids of the usable quotes at this strike, share USD; null for a side with none. */
  callMid: number | null;
  putMid: number | null;
  /** Call delta at the forward, `iv` and the expiry's T. A put's is this minus one. */
  delta: number;
}

export interface SurfaceExpiry {
  /** YYYY-MM-DD, New York, as listed. */
  day: string;
  /** 16:00 New York that day, unix seconds: the on-chain expiry convention. */
  expiry: number;
  /** Trading years from the chain's last trade to `expiry`. */
  t: number;
  /** Usable quotes per side, sorted by strike. */
  calls: ListedOption[];
  puts: ListedOption[];
  forward: number | null;
  forwardSource: 'parity' | 'spot' | null;
  /** Sorted by strike. Empty when `failure` is set. */
  points: SurfacePoint[];
  failure: PricingFailure | null;
}

export interface Surface {
  root: string;
  /** The chain's provider id (chain.ts ProviderDescriptor.id). */
  provider: string;
  /** The chain's last trade, unix seconds: the clock every `t` is measured from. */
  asOf: number;
  shareSpot: number;
  /** Sorted by expiry. */
  expiries: SurfaceExpiry[];
  holidays: readonly string[];
  horizonDays: number;
}

export interface SurfaceSettings {
  holidays?: readonly string[];
  horizonDays?: number;
}

/*//////////////////////////////////////////////////////////////
                              BUILD
//////////////////////////////////////////////////////////////*/

function dayCloseUnix(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return newYorkTimeToUnix(y, m, d, CLOSE_HOUR_ET);
}

function clampIv(iv: number): number {
  return Math.min(IV_CEILING, Math.max(IV_FLOOR, iv));
}

export type ForwardEstimate = { ok: true; forward: number; source: 'parity' | 'spot'; estimates: number[] } | PricingFailure;

/** The put-call parity forward of one expiry. See the header. */
export function parityForward(calls: readonly ListedOption[], puts: readonly ListedOption[], spot: number): ForwardEstimate {
  const putByStrike = new Map(puts.map((p) => [p.strike, p]));
  const pairs = calls
    .filter((c) => putByStrike.has(c.strike) && Math.abs(c.strike / spot - 1) <= PARITY_STRIKE_BAND + EPSILON)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike)
    .slice(0, PARITY_PAIRS)
    .map((c) => {
      const p = putByStrike.get(c.strike)!;
      return {
        strike: c.strike,
        forward: c.strike + mid(c) - mid(p),
        tolerance: 0.5 * (c.ask - c.bid + (p.ask - p.bid)) + (PARITY_TOLERANCE_BPS / 10_000) * spot,
      };
    });
  if (pairs.length === 0) return { ok: true, forward: spot, source: 'spot', estimates: [] };
  const sorted = pairs.map((p) => p.forward).sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  const forward = sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
  const estimates = pairs.map((p) => p.forward);
  const detail = { spot: String(spot), forward: forward.toFixed(4), estimates: pairs.map((p) => `${p.strike}:${p.forward.toFixed(4)}`).join(',') };
  const agreeing = pairs.filter((p) => Math.abs(p.forward - forward) <= p.tolerance + EPSILON).length;
  if (agreeing * 2 < pairs.length) {
    return failure('chain-inconsistent', { why: 'put-call parity does not hold near the money', ...detail });
  }
  const divergenceBps = Math.abs(forward / spot - 1) * 10_000;
  if (!(forward > 0) || divergenceBps > MAX_FORWARD_DIVERGENCE_BPS + 1e-6) {
    return failure('chain-inconsistent', { why: 'the parity forward is far from the chain spot', divergenceBps: divergenceBps.toFixed(1), ...detail });
  }
  return { ok: true, forward, source: 'parity', estimates };
}

/** The listed strikes' vol points of one expiry, out-of-the-money side first. */
export function surfacePoints(calls: readonly ListedOption[], puts: readonly ListedOption[], forward: number, t: number): SurfacePoint[] {
  const callByStrike = new Map(calls.map((c) => [c.strike, c]));
  const putByStrike = new Map(puts.map((p) => [p.strike, p]));
  const strikes = [...new Set([...callByStrike.keys(), ...putByStrike.keys()])].sort((a, b) => a - b);
  const points: SurfacePoint[] = [];
  for (const strike of strikes) {
    const call = callByStrike.get(strike);
    const put = putByStrike.get(strike);
    const order: Array<[OptionSide, ListedOption | undefined]> = strike >= forward ? [['C', call], ['P', put]] : [['P', put], ['C', call]];
    for (const [side, quote] of order) {
      if (quote === undefined) continue;
      const iv = impliedVol(mid(quote), { type: side === 'C' ? 'call' : 'put', spot: forward, strike, t });
      if (iv === null) continue;
      const kept = clampIv(iv);
      points.push({
        strike,
        iv: kept,
        side,
        callMid: call === undefined ? null : mid(call),
        putMid: put === undefined ? null : mid(put),
        delta: bsDelta({ type: 'call', spot: forward, strike, vol: kept, t }),
      });
      break;
    }
  }
  return points;
}

/**
 * The surface of `chain` as of `asOf` (its pricing clock, unix seconds, from cboe.ts checkChain).
 * Expiries are grouped from every listed input; each keeps its own failure rather than failing the
 * whole chain, so one broken expiry does not take the others down with it.
 */
export function buildSurface(chain: NormalizedChain, asOf: number, settings: SurfaceSettings = {}): Surface {
  const holidays = settings.holidays ?? NYSE_HOLIDAYS_2026_2028;
  const horizonDays = settings.horizonDays ?? SURFACE_HORIZON_DAYS;
  const horizonS = horizonDays * 86_400;
  const root = chain.underlying.providerSymbol;
  const shareSpot = chain.underlying.price ?? Number.NaN;
  const byDay = new Map<string, ListedOption[]>();
  for (const o of listedOptions(chain, root)) {
    const rows = byDay.get(o.expiry);
    if (rows === undefined) byDay.set(o.expiry, [o]);
    else rows.push(o);
  }
  const expiries: SurfaceExpiry[] = [];
  for (const [day, rows] of byDay) {
    const expiry = dayCloseUnix(day);
    if (expiry <= asOf || expiry - asOf > horizonS) continue;
    const sessionLeft = sessionSecondsBetween(asOf, expiry, holidays);
    if (sessionLeft < MIN_SURFACE_SESSION_S) continue;
    const t = tradingYears(asOf, expiry, holidays);
    const calls = filterQuotes(rows, 'C');
    const puts = filterQuotes(rows, 'P');
    const base = { day, expiry, t, calls, puts };
    if (!(shareSpot > 0)) {
      expiries.push({ ...base, forward: null, forwardSource: null, points: [], failure: failure('chain-inconsistent', { why: 'the source gives no usable underlying price', day }) });
      continue;
    }
    if (calls.length + puts.length === 0) {
      expiries.push({ ...base, forward: null, forwardSource: null, points: [], failure: failure('no-quotes', { why: 'no usable quote at this expiry', day, listed: String(rows.length) }) });
      continue;
    }
    const fwd = parityForward(calls, puts, shareSpot);
    if (!fwd.ok) {
      expiries.push({ ...base, forward: null, forwardSource: null, points: [], failure: { ...fwd, detail: { day, ...fwd.detail } } });
      continue;
    }
    const points = surfacePoints(calls, puts, fwd.forward, t);
    expiries.push({
      ...base,
      forward: fwd.forward,
      forwardSource: fwd.source,
      points,
      failure: points.length === 0 ? failure('no-quotes', { why: 'no quote at this expiry implies a volatility', day }) : null,
    });
  }
  expiries.sort((a, b) => a.expiry - b.expiry);
  return { root, provider: chain.provider.id, asOf, shareSpot, expiries, holidays, horizonDays };
}

/*//////////////////////////////////////////////////////////////
                              READ
//////////////////////////////////////////////////////////////*/

export type StrikeVol = { ok: true; iv: number; method: 'listed' | 'interpolated' | 'wing'; bracket: [number, number] } | PricingFailure;

function pointWindow(entry: SurfaceExpiry, point: SurfacePoint): PricingFailure | null {
  const w = checkQuoteWindow(point.side === 'C' ? entry.calls : entry.puts, point.side, [point.strike, point.strike]);
  return w === null ? null : { ...w, detail: { day: entry.day, ...w.detail } };
}

/** One expiry's vol at a share strike. See READING IT in the header. */
export function volAtStrike(entry: SurfaceExpiry, strike: number): StrikeVol {
  if (entry.failure !== null) return entry.failure;
  const points = entry.points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const single = (point: SurfacePoint, method: 'listed' | 'wing'): StrikeVol => {
    const bad = pointWindow(entry, point);
    return bad ?? { ok: true, iv: point.iv, method, bracket: [point.strike, point.strike] };
  };
  if (strike < first.strike - EPSILON) return single(first, 'wing');
  if (strike > last.strike + EPSILON) return single(last, 'wing');
  for (let i = 0; i < points.length; i += 1) {
    const lo = points[i]!;
    if (Math.abs(lo.strike - strike) < EPSILON) return single(lo, 'listed');
    const hi = points[i + 1];
    if (hi === undefined || !(lo.strike < strike && strike < hi.strike)) continue;
    const gap = hi.strike - lo.strike;
    if (gap > maxBracketGap(lo.strike) + EPSILON) {
      return failure('quotes-inconsistent', { why: 'the bracketing listed strikes are too far apart', day: entry.day, bracket: `${lo.strike}-${hi.strike}`, gapUsd: String(gap), maxGapUsd: maxBracketGap(lo.strike).toFixed(4) });
    }
    const bad = pointWindow(entry, lo) ?? pointWindow(entry, hi);
    if (bad !== null) return bad;
    const w = (strike - lo.strike) / gap;
    return { ok: true, iv: lo.iv + w * (hi.iv - lo.iv), method: 'interpolated', bracket: [lo.strike, hi.strike] };
  }
  // Unreachable: a strike inside [first, last] is on a point or between two.
  return failure('no-quotes', { why: 'no bracket found', day: entry.day, strike: String(strike) });
}

/** One listed expiry's contribution to a read: the strikes its vol came from and how. */
export interface SurfaceInput {
  day: string;
  expiry: number;
  bracket: [number, number];
  strikeMethod: 'listed' | 'interpolated' | 'wing';
}

export type SurfaceVol =
  | { ok: true; iv: number; days: string[]; method: 'listed-expiry' | 'total-variance' | 'flat-before-first' | 'flat-after-last'; inputs: SurfaceInput[] }
  | PricingFailure;

const inputOf = (e: SurfaceExpiry, v: Extract<StrikeVol, { ok: true }>): SurfaceInput => ({ day: e.day, expiry: e.expiry, bracket: v.bracket, strikeMethod: v.method });

/** The vol at a share `strike` for an `expiry` (unix seconds), listed or not. See the header. */
export function volAt(surface: Surface, strike: number, expiry: number): SurfaceVol {
  if (expiry - surface.asOf > surface.horizonDays * 86_400) {
    return failure('no-quotes', { why: 'the expiry is beyond the surface horizon', expiry: String(expiry), horizonDays: String(surface.horizonDays) });
  }
  const expiries = surface.expiries;
  if (expiries.length === 0) return failure('no-quotes', { why: 'the chain lists no expiry the surface keeps' });
  const exact = expiries.find((e) => e.expiry === expiry);
  if (exact !== undefined) {
    const v = volAtStrike(exact, strike);
    return v.ok ? { ok: true, iv: clampIv(v.iv), days: [exact.day], method: 'listed-expiry', inputs: [inputOf(exact, v)] } : v;
  }
  const before = expiries.filter((e) => e.expiry < expiry).at(-1);
  const after = expiries.find((e) => e.expiry > expiry);
  if (before === undefined || after === undefined) {
    const only = (before ?? after)!;
    const v = volAtStrike(only, strike);
    return v.ok ? { ok: true, iv: clampIv(v.iv), days: [only.day], method: before === undefined ? 'flat-before-first' : 'flat-after-last', inputs: [inputOf(only, v)] } : v;
  }
  const v1 = volAtStrike(before, strike);
  if (!v1.ok) return v1;
  const v2 = volAtStrike(after, strike);
  if (!v2.ok) return v2;
  const target = tradingYears(surface.asOf, expiry, surface.holidays);
  // A target with no session between it and the earlier expiry (a special expiry on a closed
  // day) has that expiry's T: its vol is the earlier one's, not a division by a tiny number.
  if (!(target > before.t) || !(after.t > before.t)) {
    return { ok: true, iv: clampIv(v1.iv), days: [before.day, after.day], method: 'total-variance', inputs: [inputOf(before, v1), inputOf(after, v2)] };
  }
  const w1 = v1.iv * v1.iv * before.t;
  const w2 = v2.iv * v2.iv * after.t;
  const frac = Math.min(1, Math.max(0, (target - before.t) / (after.t - before.t)));
  const w = w1 + frac * (w2 - w1);
  return { ok: true, iv: clampIv(Math.sqrt(w / target)), days: [before.day, after.day], method: 'total-variance', inputs: [inputOf(before, v1), inputOf(after, v2)] };
}
