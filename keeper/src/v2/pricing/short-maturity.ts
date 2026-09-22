/**
 * Event-aware short maturities (K3-312, F3 D7): how uncertain a price read off the surface is where
 * the listed market does not identify it, as explicit bounds and reason codes around the unchanged
 * point estimate.
 *
 * THE PROBLEM. surface.ts reads an expiry before the first listed one at the first listing's vol
 * (`flat-before-first`), which is linear total variance between (surface clock, 0) and the first
 * listing. One listed expiry cannot tell an earnings jump from ordinary variance: when an event lies
 * between now and the first listing, a daily that includes it is worth more than the flat read and a
 * daily that excludes it is worth less. Bracketed reads (`total-variance`) have the same blind spot
 * between their two listings. The point estimate is kept (it prices today's series exactly as before);
 * this module says how far off it can be and why, and never claims an observed daily vol.
 *
 * EVENT INPUT (injectable, EventCalendar): per registry ticker, a list of { date (New York),
 * kind, timing: 'bmo' | 'amc' | null } and optionally the last day the list is complete through.
 * Nothing here knows a real date. The service's default is NO_EVENT_INPUT (no input for any ticker), so
 * every short-maturity read is `event-uncertainty` under the proposal policy until one is injected. Every kind counts as a
 * possible jump. The jump of an event lands in:
 *   bmo   (00:00, 09:30] New York on its date (before the open)
 *   amc   (16:00, 24:00] New York on its date (after the close: excluded from that day's 16:00 expiry)
 *   null  (00:00, 24:00] New York on its date (unknown timing: either side of a same-day close)
 *
 * THE BOUNDS, in variance, around the point vol σ (all knobs in ShortMaturityPolicy; defaults are
 * PROPOSALS, not approved limits):
 *   segment   the stretch the read interpolates: (surface clock, first listing] for before-first,
 *             (earlier listing, later listing] for bracketed. W_a, W_b are its ends' total variance at
 *             the strike; f is where the target sits between them on the surface clock.
 *   event     an event whose jump may land inside the segment and after now carries at most
 *             ω = min(maxEventVariance, W_b − W_a). If it may land inside (now, expiry], the target's
 *             variance may be up to ω(1 − f) higher; if it may land after the expiry, up to ω·f lower.
 *             With no event input for a before-first read (or input that stops short of the first
 *             listing) and `requireEventInput`, one unknown event is assumed anywhere in the segment:
 *             both sides. Several events together never exceed the segment's own variance.
 *   realized  an event whose jump may have landed between the surface clock and now is inside every
 *             listed vol but no longer ahead: up to min(maxEventVariance, σ²T) lower, on any read.
 *   gaps      before-first only: ± gapVariance per close-to-open gap and ± closedDayVariance per whole
 *             closed day in (now, expiry] (expiry-clock.ts), the variance the trading clock gives none.
 *   early     an injected early close inside the window: the clock over-counts that session, so the
 *             variance may be σ² × lost / T lower (expiry-clock.ts).
 *   term      before-first only: ± termStructureMultiplier × |σ − the forward vol between the first
 *             two listings| at the strike, in vol; a second listing with less total variance than the
 *             first gives ± multiplier × σ.
 * ivLow = √(σ² − down) − term and ivHigh = √(σ² + up) + term, kept in [IV_FLOOR, IV_CEILING] and
 * around σ; fairLow and fairHigh are Black-Scholes at those vols with the price's own spot, strike
 * and T, so ivLow ≤ iv ≤ ivHigh and fairLow ≤ fair ≤ fairHigh always hold.
 *
 * REASONS (02-interfaces §5.1): `event-uncertainty` for any event or missing-input term above;
 * `clock-early-close` for an early close; `model-uncertainty` when (ivHigh − ivLow) / iv exceeds
 * maxRelativeIvWidth. `extrapolated` is provenance.ts's, from the method. Then the policy either keeps
 * the point with its bounds (`bound`) or refuses it (`refuse`: fair.ts answers `model-uncertainty`).
 * A read with any of these reasons is never `ready`. Exact listed and listed-expiry reads carry no
 * bounds unless an event was realized since the surface or an early close falls in the window;
 * after-last and strike-wing extrapolations are flagged `extrapolated` only (not modelled here).
 *
 * Pure.
 */
import { newYorkTimeToUnix } from '../../calendar.js';
import { TRADING_YEAR_SECONDS, bsPrice, tradingYears, type OptionKind } from './bs.js';
import type { ExpiryClock } from './expiry-clock.js';
import type { FairMethod } from './fair.js';
import type { FairUncertainty } from './provenance.js';
import { IV_CEILING, IV_FLOOR, volAtStrike, type Surface } from './surface.js';

/*//////////////////////////////////////////////////////////////
                           EVENT INPUT
//////////////////////////////////////////////////////////////*/

export type EventTiming = 'bmo' | 'amc' | null;

export interface MarketEvent {
  /** YYYY-MM-DD, New York. */
  date: string;
  /** Open label, e.g. `earnings`. Every kind counts as a possible jump. */
  kind: string;
  timing: EventTiming;
}

export interface TickerEventInput {
  events: readonly MarketEvent[];
  /** The last New York day the list is complete through; null when the input states no limit. */
  through: string | null;
}

/** Registry ticker → its event input. A ticker that is absent has NO input, which is not "no events". */
export type EventCalendar = ReadonlyMap<string, TickerEventInput>;

export const NO_EVENT_INPUT: EventCalendar = new Map();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * An EventCalendar from a plain object: `{ TICKER: MarketEvent[] }` or `{ TICKER: { events, through } }`.
 * Throws with every problem named: a date that is not a real YYYY-MM-DD day, a kind that is not a
 * short lower-case label, a timing other than bmo, amc or null. Copies; the input is not kept.
 */
export function eventCalendar(raw: unknown): EventCalendar {
  const problems: string[] = [];
  const out = new Map<string, TickerEventInput>();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('event calendar: not an object of tickers');
  for (const [ticker, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = Array.isArray(value) ? { events: value, through: null } : (value as { events?: unknown; through?: unknown } | null);
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.events)) {
      problems.push(`${ticker}: not a list of events or { events, through }`);
      continue;
    }
    const through = entry.through ?? null;
    if (through !== null && !isDay(through)) problems.push(`${ticker}: through is not a YYYY-MM-DD day: ${String(through)}`);
    const events: MarketEvent[] = [];
    (entry.events as unknown[]).forEach((e, i) => {
      const ev = e as { date?: unknown; kind?: unknown; timing?: unknown } | null;
      if (ev === null || typeof ev !== 'object') {
        problems.push(`${ticker}[${i}]: not an object`);
        return;
      }
      const timing = ev.timing === undefined ? null : ev.timing;
      const bad: string[] = [];
      if (!isDay(ev.date)) bad.push(`date ${String(ev.date)} is not a YYYY-MM-DD day`);
      if (typeof ev.kind !== 'string' || !KIND_RE.test(ev.kind)) bad.push(`kind ${String(ev.kind)} is not a short lower-case label`);
      if (timing !== null && timing !== 'bmo' && timing !== 'amc') bad.push(`timing ${String(timing)} is not bmo, amc or null`);
      if (bad.length > 0) problems.push(`${ticker}[${i}]: ${bad.join('; ')}`);
      else events.push({ date: ev.date as string, kind: ev.kind as string, timing: timing as EventTiming });
    });
    out.set(ticker, { events: events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), through: through as string | null });
  }
  if (problems.length > 0) throw new Error(`event calendar:\n  ${problems.join('\n  ')}`);
  return out;
}

/** The instants an event's jump may land in, (from, to], unix seconds. See the header. */
export function eventWindow(event: MarketEvent): { from: number; to: number } {
  const [y, m, d] = event.date.split('-').map(Number) as [number, number, number];
  const midnight = newYorkTimeToUnix(y, m, d, 0);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextMidnight = newYorkTimeToUnix(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0);
  if (event.timing === 'bmo') return { from: midnight, to: newYorkTimeToUnix(y, m, d, 9) + 1_800 };
  if (event.timing === 'amc') return { from: newYorkTimeToUnix(y, m, d, 16), to: nextMidnight };
  return { from: midnight, to: nextMidnight };
}

/*//////////////////////////////////////////////////////////////
                              POLICY
//////////////////////////////////////////////////////////////*/

export interface ShortMaturityPolicy {
  /** Most log-return variance one event may carry (0.12² = a 12% one-sigma jump); null: bounded only
   *  by the segment's own variance. */
  maxEventVariance: number | null;
  /** Variance allowance per close-to-open gap in a before-first window (0.01² = a 1% one-sigma gap). */
  gapVariance: number;
  /** Extra allowance per whole closed calendar day in that window (weekend day or holiday). */
  closedDayVariance: number;
  /** Multiplier on |front vol − next forward vol| for the before-first term-structure band. */
  termStructureMultiplier: number;
  /** A before-first read with no (or too short) event input for its ticker is event-uncertain and
   *  assumes one unknown event anywhere before the first listing. */
  requireEventInput: boolean;
  /** (ivHigh − ivLow) / iv above this is `model-uncertainty`. */
  maxRelativeIvWidth: number;
  /** A model-uncertain read keeps its point and bounds (`bound`) or is refused (`refuse`). */
  onModelUncertainty: 'bound' | 'refuse';
}

/**
 * PROPOSAL values (F3 OQ-15: event-uncertainty limits are an operating-policy decision, not approved
 * here). `bound` keeps every price this service gave before K3-312 and leaves quoting to the
 * consumer's readiness policy (K3-306); `refuse` is the stricter setting an approval may choose.
 */
export const DEFAULT_SHORT_MATURITY_POLICY: ShortMaturityPolicy = {
  maxEventVariance: 0.0144,
  gapVariance: 0.0001,
  closedDayVariance: 0.000025,
  termStructureMultiplier: 1,
  requireEventInput: true,
  maxRelativeIvWidth: 0.5,
  onModelUncertainty: 'bound',
};

/*//////////////////////////////////////////////////////////////
                            ASSESSMENT
//////////////////////////////////////////////////////////////*/

export const EVENT_UNCERTAINTY = 'event-uncertainty';
export const MODEL_UNCERTAINTY = 'model-uncertainty';

export type EventPlacement =
  | 'realized-since-surface' // may have landed between the surface clock and now
  | 'inside-window' // lands in (now, expiry] and inside the segment
  | 'after-window' // lands after the expiry, inside the segment
  | 'straddles-expiry' // may land either side of the expiry, inside the segment
  | 'outside-segment'; // identified by the listings (or irrelevant to this read)

export interface ShortMaturityDiagnostics {
  /** The stretch the read is not identified on, unix seconds; null for a listed or wing-only read. */
  segment: { kind: 'before-first' | 'bracketed'; from: number; to: number; fraction: number } | null;
  eventInput: 'supplied' | 'missing' | 'short';
  events: Array<MarketEvent & { placement: EventPlacement }>;
  /** Variance added to (up) and taken from (down) σ² per year of the read, by source; term in vol. */
  components: { eventUp: number; eventDown: number; realizedDown: number; gap: number; earlyCloseDown: number; termVol: number };
  termStructure: 'flat-front' | 'forward' | 'inverted' | 'unavailable' | null;
  relativeIvWidth: number | null;
  clock: ExpiryClock;
  policy: ShortMaturityPolicy;
}

export interface ShortMaturityAssessment {
  uncertainty: FairUncertainty | null;
  /** In order: event-uncertainty, clock-early-close, model-uncertainty. */
  reasons: string[];
  modelUncertain: boolean;
  diagnostics: ShortMaturityDiagnostics;
}

export interface ShortMaturityInput {
  surface: Surface;
  request: { strikeUsdg6: bigint; expiry: number; type: OptionKind };
  priced: { iv: number; method: FairMethod; days: readonly string[]; yearsToExpiry: number };
  /** The token spot the point was priced at, USD per token. */
  tokenSpot: number;
  clock: ExpiryClock;
  /** This ticker's event input, or null when there is none. */
  events: TickerEventInput | null;
  policy: ShortMaturityPolicy;
}

const EPSILON = 1e-12;

function price(type: OptionKind, spot: number, strike: number, vol: number, t: number): bigint {
  return BigInt(Math.round(bsPrice({ type, spot, strike, vol, t }) * 1e6));
}

/** Total variance at a share strike on one listed expiry of the surface, or null when it does not read. */
function totalVariance(surface: Surface, day: string, strike: number): { w: number; t: number; expiry: number } | null {
  const entry = surface.expiries.find((e) => e.day === day);
  if (entry === undefined) return null;
  const v = volAtStrike(entry, strike);
  return v.ok ? { w: v.iv * v.iv * entry.t, t: entry.t, expiry: entry.expiry } : null;
}

/** See the header. */
export function assessShortMaturity(input: ShortMaturityInput): ShortMaturityAssessment {
  const { surface, request, priced, clock, policy } = input;
  const strike = Number(request.strikeUsdg6) / 1e6;
  const sigma = priced.iv;
  const now = clock.pricingFrom;
  const tPricing = priced.yearsToExpiry;
  const tSurface = tradingYears(surface.asOf, request.expiry, surface.holidays);
  const beforeFirst = priced.method === 'flat-before-first';

  // The unidentified segment of this read, in surface time and total variance.
  let segment: ShortMaturityDiagnostics['segment'] = null;
  let wA = 0;
  let wB = 0;
  let firstT = 0;
  let second: string | null = null;
  if (beforeFirst) {
    // The flat read IS the first listing's vol: its total variance is σ² t1.
    const index = surface.expiries.findIndex((e) => e.day === priced.days[0]);
    const first = surface.expiries[index];
    firstT = first?.t ?? 0;
    wB = sigma * sigma * firstT;
    segment = { kind: 'before-first', from: surface.asOf, to: first?.expiry ?? request.expiry, fraction: firstT > 0 ? Math.min(1, Math.max(0, tSurface / firstT)) : 1 };
    second = surface.expiries[index + 1]?.day ?? null;
  } else if (priced.method === 'total-variance' && priced.days.length === 2) {
    const a = totalVariance(surface, priced.days[0]!, strike);
    const b = totalVariance(surface, priced.days[1]!, strike);
    if (a !== null && b !== null && b.t > a.t) {
      wA = a.w;
      wB = b.w;
      segment = { kind: 'bracketed', from: a.expiry, to: b.expiry, fraction: Math.min(1, Math.max(0, (tSurface - a.t) / (b.t - a.t))) };
    }
  }
  const f = segment?.fraction ?? 0;
  const segmentVariance = Math.max(0, wB - wA);
  const cap = policy.maxEventVariance === null ? segmentVariance : Math.min(policy.maxEventVariance, segmentVariance);

  // Event terms, in total variance on the surface clock.
  let upW = 0;
  let downW = 0;
  let realizedW = 0;
  let eventUncertain = false;
  const events: ShortMaturityDiagnostics['events'] = [];
  const pointW = sigma * sigma * tSurface;
  const realizedCap = policy.maxEventVariance === null ? pointW : Math.min(policy.maxEventVariance, pointW);
  for (const event of input.events?.events ?? []) {
    const w = eventWindow(event);
    let placement: EventPlacement = 'outside-segment';
    if (w.to > surface.asOf && w.from < now) {
      placement = 'realized-since-surface';
      realizedW = Math.min(pointW, realizedW + realizedCap);
      eventUncertain = true;
    }
    const future = w.to > now;
    if (segment !== null && future && w.to > segment.from && w.from < segment.to) {
      const mayBeInside = w.from < request.expiry;
      const mayBeAfter = w.to > request.expiry;
      if (mayBeInside) upW += cap * (1 - f);
      if (mayBeAfter) downW += cap * f;
      if (placement === 'outside-segment') placement = mayBeInside && mayBeAfter ? 'straddles-expiry' : mayBeInside ? 'inside-window' : 'after-window';
      eventUncertain = true;
    }
    events.push({ ...event, placement });
  }
  // Input "through" a day before the first listing's day cannot vouch for the whole segment.
  const through = input.events?.through ?? null;
  const eventInput: ShortMaturityDiagnostics['eventInput'] = input.events === null ? 'missing' : beforeFirst && through !== null && priced.days[0]! > through ? 'short' : 'supplied';
  if (beforeFirst && policy.requireEventInput && eventInput !== 'supplied') {
    upW += cap * (1 - f);
    downW += cap * f;
    eventUncertain = true;
  }
  upW = Math.min(upW, segmentVariance * (1 - f));
  downW = Math.min(downW, segmentVariance * f);

  // Everything as variance per year of the read (σ² units).
  const eventUp = tSurface > EPSILON ? upW / tSurface : 0;
  const eventDown = tSurface > EPSILON ? downW / tSurface : 0;
  const realizedDown = tSurface > EPSILON ? realizedW / tSurface : 0;
  const gap = beforeFirst && tPricing > EPSILON ? (policy.gapVariance * clock.gaps + policy.closedDayVariance * clock.closedDays) / tPricing : 0;
  const earlyCloseDown = tPricing > EPSILON ? (sigma * sigma * clock.earlyCloseLostSeconds) / TRADING_YEAR_SECONDS / tPricing : 0;

  let termVol = 0;
  let termStructure: ShortMaturityDiagnostics['termStructure'] = null;
  if (beforeFirst) {
    const next = second === null ? null : totalVariance(surface, second, strike);
    if (next === null || !(next.t > firstT)) termStructure = 'unavailable';
    else if (next.w > wB) {
      const forwardVol = Math.sqrt((next.w - wB) / (next.t - firstT));
      termVol = policy.termStructureMultiplier * Math.abs(sigma - forwardVol);
      termStructure = termVol > EPSILON ? 'forward' : 'flat-front';
    } else {
      termVol = policy.termStructureMultiplier * sigma;
      termStructure = 'inverted';
    }
  }

  const up = eventUp + gap;
  const down = eventDown + realizedDown + gap + earlyCloseDown;
  const reasons: string[] = [];
  if (eventUncertain) reasons.push(EVENT_UNCERTAINTY);
  for (const r of clock.reasons) reasons.push(r);

  const bounded = beforeFirst || up > EPSILON || down > EPSILON || termVol > EPSILON;
  let uncertainty: FairUncertainty | null = null;
  let relativeIvWidth: number | null = null;
  let modelUncertain = false;
  if (bounded) {
    const low = Math.sqrt(Math.max(0, sigma * sigma - down)) - termVol;
    const high = Math.sqrt(sigma * sigma + up) + termVol;
    const ivLow = Math.min(sigma, Math.max(IV_FLOOR, low));
    const ivHigh = Math.max(sigma, Math.min(IV_CEILING, high));
    uncertainty = {
      ivLow,
      ivHigh,
      fairLowUsdg6: price(request.type, input.tokenSpot, strike, ivLow, tPricing),
      fairHighUsdg6: price(request.type, input.tokenSpot, strike, ivHigh, tPricing),
    };
    relativeIvWidth = sigma > 0 ? (ivHigh - ivLow) / sigma : null;
    modelUncertain = relativeIvWidth === null || relativeIvWidth > policy.maxRelativeIvWidth;
    if (modelUncertain) reasons.push(MODEL_UNCERTAINTY);
  }

  return {
    uncertainty,
    reasons,
    modelUncertain,
    diagnostics: {
      segment,
      eventInput,
      events,
      components: { eventUp, eventDown, realizedDown, gap, earlyCloseDown, termVol },
      termStructure,
      relativeIvWidth,
      clock,
      policy,
    },
  };
}
