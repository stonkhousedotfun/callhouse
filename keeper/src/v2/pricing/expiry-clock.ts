/**
 * The expiry clock of one price (K3-312): which clocks feed its time to expiry, and the check that
 * refuses or flags an expiry the trading clock cannot price honestly.
 *
 * TWO CLOCKS, ONE BASIS. Both are trading time (bs.ts: regular-session seconds, 09:30-16:00 New York
 * on NYSE session days, over 252 × 6.5 h), with the same holiday table (PricingSettings.holidays):
 *   surface  each listed expiry's T, the T its mid was solved on, runs from the chain's pricing clock
 *            (chain.ts pricingClock): the provider's quote time when it states one, else the
 *            underlying's observation time (Cboe: `last_trade_time`). surface.ts buildSurface.
 *   pricing  the series' `yearsToExpiry`, the T the token option is priced at, runs from the
 *            service's own clock (PricingService `nowMs`: the wall clock in production) to the series
 *            expiry. fair.ts priceContract.
 * Neither ever reads a publication time or a download time (`publishedAt`, `receivedAt`). Vol crosses
 * from the surface clock to the pricing clock (fair.ts header).
 *
 * WHAT THE TRADING CLOCK DOES NOT SEE
 *   overnights, weekends, holidays  no session, so no time. The listed market prices that gap risk
 *            into its session vol on the same clock, so a listed or bracketed read stays consistent.
 *            A read before the first listed expiry is not identified there; this check counts the
 *            gaps and closed days in its window, and short-maturity.ts gives them an allowance.
 *   early closes  calendar.ts models none, and bs.ts counts 09:30-16:00 on those days too. With an
 *            injected early-close list (PricingSettings.earlyCloses: New York days closing at
 *            EARLY_CLOSE_HOUR_ET), this check counts the session the clock over-counts inside the
 *            window and flags it (`clock-early-close`); short-maturity.ts widens the bounds by it. The
 *            point estimate is unchanged.
 *
 * REFUSED, as `expired` with `detail.why`:
 *   - the expiry is not after the service clock;
 *   - the expiry is not after the surface clock (a chain clock ahead of the service clock);
 *   - no regular session remains before the expiry, counting early closes: a series on a closed day
 *     after its last session, or after an early close. Its trading time is zero, so the model would
 *     answer intrinsic value at a spot the settlement does not read.
 *
 * Pure.
 */
import { CLOSE_HOUR_ET, newYorkParts, newYorkTimeToUnix } from '../../calendar.js';
import { SESSION_OPEN_SECONDS_ET, TRADING_YEAR_SECONDS, sessionSecondsBetween } from './bs.js';
import { failure, type PricingFailure } from './cboe.js';

/** The NYSE's early close, New York local hour. */
export const EARLY_CLOSE_HOUR_ET = 13;

/** Reason code for an early close inside the window (an open code, 02-interfaces §5.1). */
export const CLOCK_EARLY_CLOSE = 'clock-early-close';

export interface ExpiryClockInput {
  /** The service clock, unix seconds. */
  nowSeconds: number;
  /** The surface's clock (surface.ts Surface.asOf) and where it came from. */
  surfaceAsOf: number;
  surfaceClockBasis: 'quote' | 'underlying';
  /** The series expiry, unix seconds. */
  expiry: number;
  holidays: readonly string[];
  /** YYYY-MM-DD New York days closing at EARLY_CLOSE_HOUR_ET. Default none. */
  earlyCloses?: readonly string[];
}

export interface ExpiryClock {
  ok: true;
  basis: 'trading-time';
  /** The pricing clock: the service's own. */
  pricingFrom: number;
  pricingFromSource: 'service-clock';
  /** The surface clock: the chain's quote time, else its underlying observation time. */
  surfaceFrom: number;
  surfaceFromSource: 'quote' | 'underlying';
  /** Regular-session seconds in (now, expiry] as bs.ts counts them: the price's T. */
  sessionSeconds: number;
  yearsToExpiry: number;
  /** Seconds of `sessionSeconds` that an injected early close removes, and those days. */
  earlyCloseLostSeconds: number;
  earlyCloseDays: string[];
  /** Session opens in (now, expiry]: one per close-to-open gap (overnight, weekend or holiday). */
  gaps: number;
  /** Whole New York days strictly between today and the expiry day with no session. */
  closedDays: number;
  /** `clock-early-close` when an early close lies inside the window. */
  reasons: string[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Every New York calendar day from `from`'s day to `to`'s day, inclusive. */
function* newYorkDays(fromUnix: number, toUnix: number): Generator<{ iso: string; year: number; month: number; day: number; weekday: number }> {
  const start = newYorkParts(fromUnix);
  const end = newYorkParts(toUnix);
  const endKey = end.year * 10_000 + end.month * 100 + end.day;
  for (let i = 0; i < 1_000; i += 1) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (year * 10_000 + month * 100 + day > endKey) return;
    yield { iso: `${year}-${pad2(month)}-${pad2(day)}`, year, month, day, weekday: d.getUTCDay() };
  }
}

/** See the header. Never throws on a finite input. */
export function checkExpiryClock(input: ExpiryClockInput): ExpiryClock | PricingFailure {
  const { nowSeconds, surfaceAsOf, expiry, holidays } = input;
  const detail = { expiry: String(expiry), nowSeconds: String(nowSeconds), surfaceAsOf: String(surfaceAsOf) };
  if (!(expiry > nowSeconds)) return failure('expired', { why: 'the expiry is not after the service clock', ...detail });
  if (!(expiry > surfaceAsOf)) return failure('expired', { why: 'the expiry is not after the surface clock', ...detail });

  const sessionSeconds = sessionSecondsBetween(nowSeconds, expiry, holidays);
  const closed = new Set(holidays);
  const early = new Set(input.earlyCloses ?? []);
  const today = newYorkParts(nowSeconds);
  const todayIso = `${today.year}-${pad2(today.month)}-${pad2(today.day)}`;
  const expiryParts = newYorkParts(expiry);
  const expiryIso = `${expiryParts.year}-${pad2(expiryParts.month)}-${pad2(expiryParts.day)}`;

  let gaps = 0;
  let closedDays = 0;
  let earlyCloseLostSeconds = 0;
  const earlyCloseDays: string[] = [];
  for (const d of newYorkDays(nowSeconds, expiry)) {
    const session = d.weekday !== 0 && d.weekday !== 6 && !closed.has(d.iso);
    if (!session) {
      if (d.iso > todayIso && d.iso < expiryIso) closedDays += 1;
      continue;
    }
    const open = newYorkTimeToUnix(d.year, d.month, d.day, 9) + (SESSION_OPEN_SECONDS_ET - 9 * 3_600);
    if (open > nowSeconds && open <= expiry) gaps += 1;
    if (early.has(d.iso)) {
      const earlyClose = newYorkTimeToUnix(d.year, d.month, d.day, EARLY_CLOSE_HOUR_ET);
      const close = newYorkTimeToUnix(d.year, d.month, d.day, CLOSE_HOUR_ET);
      const lost = Math.max(0, Math.min(close, expiry) - Math.max(earlyClose, nowSeconds));
      if (lost > 0) {
        earlyCloseLostSeconds += lost;
        earlyCloseDays.push(d.iso);
      }
    }
  }

  if (sessionSeconds - earlyCloseLostSeconds <= 0) {
    return failure('expired', {
      why: earlyCloseLostSeconds > 0 ? 'no regular session remains before the expiry after the early close' : 'no regular session remains before the expiry',
      sessionSeconds: String(sessionSeconds),
      earlyCloseLostSeconds: String(earlyCloseLostSeconds),
      ...detail,
    });
  }
  return {
    ok: true,
    basis: 'trading-time',
    pricingFrom: nowSeconds,
    pricingFromSource: 'service-clock',
    surfaceFrom: surfaceAsOf,
    surfaceFromSource: input.surfaceClockBasis,
    sessionSeconds,
    yearsToExpiry: sessionSeconds / TRADING_YEAR_SECONDS,
    earlyCloseLostSeconds,
    earlyCloseDays,
    gaps,
    closedDays,
    reasons: earlyCloseLostSeconds > 0 ? [CLOCK_EARLY_CLOSE] : [],
  };
}
