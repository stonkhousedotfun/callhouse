/**
 * The event calendar file: ops/markets/events.json, next to the registry, read once
 * at boot into the EventCalendar short-maturity.ts and the /fair event flag use.
 *
 *   {
 *     "through": { "NVDA": "2026-12-31" },          optional: the last New York day each ticker's list is
 *                                                   complete through; a ticker absent here is complete only
 *                                                   through its latest row
 *     "events": [
 *       { "ticker": "NVDA", "date": "2026-11-18", "kind": "earnings", "timing": "amc",
 *         "source": "https://…" }                   every row names where its date came from
 *     ]
 *   }
 *
 * A ticker with no row and no `through` has NO input (the flag reads `missing`): an empty file is "we do not
 * know", never "no events". A ticker with rows and no `through` vouches only through its latest row
 * (short-maturity.ts eventsCompleteThrough): a later expiry reads `short`, so adding the next report's date
 * never clears the report after it. Every problem refuses the whole file, named: an unknown ticker (not in the
 * registry), a row without a `source` URL, and everything short-maturity.ts eventCalendar refuses (a date
 * that is not a real day, a kind that is not a short lower-case label, a timing other than bmo/amc/null).
 * A calendar that half-loads would silently drop exactly the rows that were typed wrong.
 *
 * RE-CHECK DATES. `"recheckBy": { "NVDA": "2026-10-15" }` is the New York day by which someone must
 * look for the ticker's next announced date. A `missing` event input does not halt the MM (by design), so an
 * empty list whose re-check day has passed would let short-dated asks quote through a real report with nothing
 * saying so. eventRecheckStatus marks such a ticker overdue; /health serves it and ops/v2/monitor.mjs pages on
 * it. A recheckBy entry is refused like a row: unknown ticker, or not a real day.
 */
import { existsSync, readFileSync } from 'node:fs';
import { newYorkParts } from '../../calendar.js';
import { eventCalendar, isDay, type EventCalendar } from './short-maturity.js';

const ROW_KEYS = new Set(['ticker', 'date', 'kind', 'timing', 'source', 'note']);

/** Registry ticker → the New York day (YYYY-MM-DD) by which its next event date must be looked for. */
export type EventRecheckSchedule = ReadonlyMap<string, string>;

/** Parse the file's JSON value against the registry's tickers. Throws with every problem listed. */
export function parseEventCalendarFile(raw: unknown, knownTickers: ReadonlySet<string>): EventCalendar {
  return parseEventsFile(raw, knownTickers).calendar;
}

/** The calendar and its re-check days, from one parse that refuses the whole file on any problem. */
function parseEventsFile(raw: unknown, knownTickers: ReadonlySet<string>): { calendar: EventCalendar; recheckBy: EventRecheckSchedule } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('events file: not a JSON object');
  const file = raw as { events?: unknown; through?: unknown; recheckBy?: unknown };
  const problems: string[] = [];
  const byTicker: Record<string, { events: unknown[]; through: unknown }> = {};
  const entry = (ticker: string) => (byTicker[ticker] ??= { events: [], through: null });

  if (!Array.isArray(file.events)) problems.push('events: not a list');
  else {
    file.events.forEach((row, i) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        problems.push(`events[${i}]: not an object`);
        return;
      }
      const r = row as Record<string, unknown>;
      const extra = Object.keys(r).filter((k) => !ROW_KEYS.has(k));
      if (extra.length > 0) problems.push(`events[${i}]: unknown key(s) ${extra.join(', ')}`);
      if (typeof r.ticker !== 'string' || !knownTickers.has(r.ticker)) {
        problems.push(`events[${i}]: ticker ${String(r.ticker)} is not a registry market`);
        return;
      }
      if (typeof r.source !== 'string' || !/^https:\/\/\S+$/.test(r.source)) problems.push(`events[${i}]: source must be the https URL the date came from`);
      entry(r.ticker).events.push({ date: r.date, kind: r.kind, timing: r.timing ?? null });
    });
  }

  if (file.through !== undefined) {
    if (typeof file.through !== 'object' || file.through === null || Array.isArray(file.through)) problems.push('through: not an object of ticker -> YYYY-MM-DD');
    else {
      for (const [ticker, day] of Object.entries(file.through as Record<string, unknown>)) {
        if (!knownTickers.has(ticker)) problems.push(`through.${ticker}: not a registry market`);
        else entry(ticker).through = day;
      }
    }
  }

  const recheckBy = new Map<string, string>();
  if (file.recheckBy !== undefined) {
    if (typeof file.recheckBy !== 'object' || file.recheckBy === null || Array.isArray(file.recheckBy)) problems.push('recheckBy: not an object of ticker -> YYYY-MM-DD');
    else {
      for (const [ticker, day] of Object.entries(file.recheckBy as Record<string, unknown>)) {
        if (!knownTickers.has(ticker)) problems.push(`recheckBy.${ticker}: not a registry market`);
        else if (!isDay(day)) problems.push(`recheckBy.${ticker}: not a YYYY-MM-DD day: ${String(day)}`);
        else recheckBy.set(ticker, day);
      }
    }
  }

  // Row-level checks (date, kind, timing, through) are short-maturity.ts's own; its message lists each.
  let calendar: EventCalendar | null = null;
  try {
    calendar = eventCalendar(byTicker);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0 || calendar === null) throw new Error(`events file:\n  ${problems.join('\n  ')}`);
  return { calendar, recheckBy };
}

/** One ticker's re-check state. `coveredBy` names what answers the question today, when something does. */
export interface EventRecheckState {
  recheckBy: string;
  /** Today in New York is after recheckBy and nothing covers today: someone must look for the next date. */
  overdue: boolean;
  /** `through`: the list is stated complete through today or later. `event`: a row is dated today or later. */
  coveredBy: 'through' | 'event' | null;
}

/**
 * Each scheduled ticker's re-check state at `nowSeconds`, compared in New York days. Covered means the list
 * already answers "is there an event from today on": its `through` reaches today, or a row is dated today or
 * later. A row that is already past does not cover: it says nothing about the next report, so once a
 * listed report has gone by, the ticker is overdue again until its next date or a new recheckBy is added.
 */
export function eventRecheckStatus(recheckBy: EventRecheckSchedule, calendar: EventCalendar, nowSeconds: number): Record<string, EventRecheckState> {
  const p = newYorkParts(nowSeconds);
  const today = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const out: Record<string, EventRecheckState> = {};
  for (const ticker of [...recheckBy.keys()].sort()) {
    const day = recheckBy.get(ticker)!;
    const input = calendar.get(ticker);
    const coveredBy =
      input !== undefined && input.through !== null && input.through >= today ? 'through' : input?.events.some((e) => e.date >= today) === true ? 'event' : null;
    out[ticker] = { recheckBy: day, overdue: today > day && coveredBy === null, coveredBy };
  }
  return out;
}

/**
 * Why the calendar refused boot. `missing`: PRICING_EVENTS_PATH names a file that does not exist.
 * `invalid`: the file exists and is not JSON, or parseEventCalendarFile refused it. The message names the
 * path, and names PRICING_EVENTS_PATH when the path came from it.
 */
export class EventCalendarFileError extends Error {
  constructor(
    readonly code: 'missing' | 'invalid',
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'EventCalendarFileError';
  }
}

/**
 * Load the calendar for the service. `explicit`: the path was configured (PRICING_EVENTS_PATH), so a missing
 * file refuses boot. Otherwise the default path may be absent (an image that does not bake it): that is no
 * calendar at all, reported as `loaded: false` so /health and the boot log can say so. A file that exists
 * and does not parse always refuses. Every refusal is an EventCalendarFileError.
 */
export function loadEventCalendarFile(
  path: string,
  knownTickers: ReadonlySet<string>,
  explicit: boolean,
): { calendar: EventCalendar; loaded: false } | { calendar: EventCalendar; recheckBy: EventRecheckSchedule; loaded: true } {
  const label = explicit ? `PRICING_EVENTS_PATH ${path}` : `events file ${path}`;
  if (!existsSync(path)) {
    if (explicit) throw new EventCalendarFileError('missing', path, `${label}: no such file`);
    // No file: no calendar and no re-check days, so /health says the days are not served rather than "none due".
    return { calendar: new Map(), loaded: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new EventCalendarFileError('invalid', path, `${label}: not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { ...parseEventsFile(raw, knownTickers), loaded: true as const };
  } catch (error) {
    throw new EventCalendarFileError('invalid', path, `${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
