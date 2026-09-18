/**
 * Black-Scholes for the pricing service: calls and puts, r = 0, time in TRADING years.
 *
 * WHY r = 0. A Stonkhouse series is written against Stock Tokens or USDG sitting idle in the
 * clearinghouse; nothing on chain pays interest on either, and every tenor is 45 days or less. The
 * listed equity options that feed the surface DO carry a rate (and dividends), but surface.ts
 * absorbs that into each expiry's put-call-parity forward before solving for vol, so vol is the
 * quantity carried from the listed market to the token, never a price.
 *
 * WHY TRADING TIME. Dailies are the point of v2, and a daily's clock is the session, not the
 * calendar: the premium of a Monday expiry does not decay over the weekend, and a Friday 10:00
 * quote with six hours of session left is not a quarter of a day's option. Time here is the
 * regular-session seconds (09:30-16:00 America/New_York, NYSE session days only) between two
 * instants, over 252 × 6.5 h. Weekends and the full-day holidays of calendar.ts contribute
 * nothing; early closes are not modelled, exactly as calendar.ts does not model them. Overnight
 * gap risk is therefore priced into the next session's vol, which is where the listed market puts
 * it too: the surface solves every listed mid on this same clock, so the two are consistent.
 *
 * NO BLOW-UPS. A daily an hour before its close has T ≈ 6e-4 years; one second before, T ≈ 1.7e-7.
 * Every formula here stays finite down to T = 0: below MIN_STDDEV of σ√T the option is its
 * intrinsic value and its delta is the step (0.5 exactly at the money), prices are clamped into
 * their no-arbitrage bounds, and the implied-vol solve is a bracketed bisection (Newton divides by
 * vega, which is what vanishes near expiry).
 *
 * Pure. Numbers are floats in share-space USD; fair.ts does the one rounding into base units.
 */
import { CLOSE_HOUR_ET, NYSE_HOLIDAYS_2026_2028, newYorkParts, newYorkTimeToUnix } from '../../calendar.js';

/*//////////////////////////////////////////////////////////////
                            CONSTANTS
//////////////////////////////////////////////////////////////*/

export type OptionKind = 'call' | 'put';

/** 09:30 New York, seconds after local midnight: IExpiryCalendar.isRegularSession's open. */
export const SESSION_OPEN_SECONDS_ET = 9 * 3_600 + 1_800;
/** 09:30-16:00: six and a half hours. */
export const SESSION_SECONDS = 23_400;
export const TRADING_DAYS_PER_YEAR = 252;
/** One trading year in session seconds. */
export const TRADING_YEAR_SECONDS = SESSION_SECONDS * TRADING_DAYS_PER_YEAR;

/** No expiry this service prices is more than a few months out (MAX_TENOR is 45 days). A span of
 *  more calendar days than this is a caller bug, not a long option. */
export const MAX_SPAN_DAYS = 1_000;

/** σ√T below this is an expired option: intrinsic value, step delta. Far below any real quote
 *  (a 1% vol one second before the close is 4e-6). */
export const MIN_STDDEV = 1e-12;

/** The implied-vol bracket. Both ends are far outside any usable quote; surface.ts floors and
 *  caps what it keeps much tighter (IV_FLOOR, IV_CEILING). */
export const IV_SOLVE_MIN = 1e-4;
export const IV_SOLVE_MAX = 20;
const IV_SOLVE_ITERATIONS = 100;
const IV_SOLVE_TOLERANCE = 1e-12;

/*//////////////////////////////////////////////////////////////
                          TRADING TIME
//////////////////////////////////////////////////////////////*/

const holidaySets = new WeakMap<readonly string[], ReadonlySet<string>>();

function holidaySet(holidays: readonly string[]): ReadonlySet<string> {
  let set = holidaySets.get(holidays);
  if (set === undefined) {
    set = new Set(holidays);
    holidaySets.set(holidays, set);
  }
  return set;
}

/** open/close unix per New York day. Intl is the slow part of newYorkTimeToUnix and a surface
 *  asks for the same few weeks over and over. Bounded: cleared when it grows past a few years. */
const sessionBoundsCache = new Map<number, readonly [number, number]>();

function sessionBounds(year: number, month: number, day: number): readonly [number, number] {
  const key = year * 10_000 + month * 100 + day;
  let bounds = sessionBoundsCache.get(key);
  if (bounds === undefined) {
    if (sessionBoundsCache.size > 4_000) sessionBoundsCache.clear();
    // DST switches at 02:00 on a Sunday, never between 09:00 and 09:30 on a session day.
    bounds = [newYorkTimeToUnix(year, month, day, 9) + (SESSION_OPEN_SECONDS_ET - 9 * 3_600), newYorkTimeToUnix(year, month, day, CLOSE_HOUR_ET)];
    sessionBoundsCache.set(key, bounds);
  }
  return bounds;
}

/**
 * Regular-session seconds in (fromUnix, toUnix]: for every New York calendar day the span
 * touches that is a weekday and not in `holidays`, the overlap with 09:30-16:00 that day. 0 when
 * `toUnix <= fromUnix`. DST needs nothing: each day's open and close come from calendar.ts.
 */
export function sessionSecondsBetween(fromUnix: number, toUnix: number, holidays: readonly string[] = NYSE_HOLIDAYS_2026_2028): number {
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix)) throw new RangeError(`not an instant: ${fromUnix} -> ${toUnix}`);
  if (toUnix <= fromUnix) return 0;
  const closed = holidaySet(holidays);
  const start = newYorkParts(fromUnix);
  const end = newYorkParts(toUnix);
  const endKey = end.year * 10_000 + end.month * 100 + end.day;
  let total = 0;
  for (let i = 0; ; i += 1) {
    if (i > MAX_SPAN_DAYS) throw new RangeError(`more than ${MAX_SPAN_DAYS} days between ${fromUnix} and ${toUnix}`);
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (year * 10_000 + month * 100 + day > endKey) break;
    const weekday = d.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (closed.has(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)) continue;
    const [open, close] = sessionBounds(year, month, day);
    total += Math.max(0, Math.min(close, toUnix) - Math.max(open, fromUnix));
  }
  return total;
}

/** sessionSecondsBetween in trading years: the T every formula below takes. */
export function tradingYears(fromUnix: number, toUnix: number, holidays: readonly string[] = NYSE_HOLIDAYS_2026_2028): number {
  return sessionSecondsBetween(fromUnix, toUnix, holidays) / TRADING_YEAR_SECONDS;
}

/*//////////////////////////////////////////////////////////////
                         NORMAL DISTRIBUTION
//////////////////////////////////////////////////////////////*/

/**
 * The standard normal CDF to double precision across the whole line: Hart's algorithm as given
 * by West, "Better approximations to cumulative normal functions" (2005), the version with the
 * continued-fraction tail. The tail matters: a far out-of-the-money daily is priced from the
 * difference of two tail values, and the 7-digit textbook approximation turns those into noise.
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const z = Math.abs(x);
  let tail: number;
  if (z > 37) {
    tail = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      tail = (e * n) / d;
    } else {
      let f = z + 0.65;
      f = z + 4 / f;
      f = z + 3 / f;
      f = z + 2 / f;
      f = z + 1 / f;
      tail = e / f / 2.506628274631;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

/*//////////////////////////////////////////////////////////////
                          BLACK-SCHOLES
//////////////////////////////////////////////////////////////*/

export interface BsInput {
  type: OptionKind;
  /** Underlying price (the forward, with r = 0). */
  spot: number;
  strike: number;
  /** Annualised, on the trading clock: 0.40 is 40%. */
  vol: number;
  /** Trading years to expiry (tradingYears). */
  t: number;
}

function assertInput({ spot, strike, vol, t }: Pick<BsInput, 'spot' | 'strike' | 'vol' | 't'>): void {
  if (!(Number.isFinite(spot) && spot > 0) || !(Number.isFinite(strike) && strike > 0) || !(Number.isFinite(vol) && vol >= 0) || !(Number.isFinite(t) && t >= 0)) {
    throw new RangeError(`not a Black-Scholes input: spot ${spot}, strike ${strike}, vol ${vol}, t ${t}`);
  }
}

export function intrinsicValue(type: OptionKind, spot: number, strike: number): number {
  return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

/** The price no European option can exceed: the underlying for a call, the strike for a put. */
function upperBound(type: OptionKind, spot: number, strike: number): number {
  return type === 'call' ? spot : strike;
}

/**
 * The European price at r = 0, clamped into [intrinsic, upper bound]: floats near expiry can land
 * a hair outside it, and a price under intrinsic is an arbitrage nobody should be quoted.
 */
export function bsPrice(input: BsInput): number {
  assertInput(input);
  const { type, spot, strike, vol, t } = input;
  const intrinsic = intrinsicValue(type, spot, strike);
  const sd = vol * Math.sqrt(t);
  if (sd < MIN_STDDEV) return intrinsic;
  const d1 = (Math.log(spot / strike) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  const raw = type === 'call' ? spot * normCdf(d1) - strike * normCdf(d2) : strike * normCdf(-d2) - spot * normCdf(-d1);
  return Math.min(upperBound(type, spot, strike), Math.max(intrinsic, raw));
}

/** dPrice/dSpot: N(d1) for a call, N(d1) - 1 for a put. At expiry the step, 0.5 at the money. */
export function bsDelta(input: BsInput): number {
  assertInput(input);
  const { type, spot, strike, vol, t } = input;
  const sd = vol * Math.sqrt(t);
  let callDelta: number;
  if (sd < MIN_STDDEV) {
    callDelta = spot > strike ? 1 : spot < strike ? 0 : 0.5;
  } else {
    callDelta = normCdf((Math.log(spot / strike) + 0.5 * sd * sd) / sd);
  }
  return type === 'call' ? callDelta : callDelta - 1;
}

/**
 * The vol at which bsPrice equals `price`, or null when no vol in [IV_SOLVE_MIN, IV_SOLVE_MAX]
 * does: a price at or under intrinsic (no time value to explain), at or over the upper bound, a
 * zero time to expiry, or a price that needs an absurd vol. Bisection: the price is monotone in
 * vol, so the bracket always converges, including where vega is ~0.
 */
export function impliedVol(price: number, input: Omit<BsInput, 'vol'>): number | null {
  const { type, spot, strike, t } = input;
  if (!Number.isFinite(price) || !(Number.isFinite(spot) && spot > 0) || !(Number.isFinite(strike) && strike > 0) || !(Number.isFinite(t) && t > 0)) return null;
  const intrinsic = intrinsicValue(type, spot, strike);
  if (!(price > intrinsic) || !(price < upperBound(type, spot, strike))) return null;
  let lo = IV_SOLVE_MIN;
  let hi = IV_SOLVE_MAX;
  if (bsPrice({ type, spot, strike, t, vol: lo }) > price) return null;
  if (bsPrice({ type, spot, strike, t, vol: hi }) < price) return null;
  for (let i = 0; i < IV_SOLVE_ITERATIONS && hi - lo > IV_SOLVE_TOLERANCE; i += 1) {
    const mid = (lo + hi) / 2;
    if (bsPrice({ type, spot, strike, t, vol: mid }) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
