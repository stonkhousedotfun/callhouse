/**
 * ops/markets/events.json and its loader (keeper/src/v2/pricing/events.ts). Two rows' tests, one file:
 *
 * How the event calendar file refuses. PRICING_EVENTS_PATH set: a missing file and a file that does not
 * parse both refuse with EventCalendarFileError, naming the variable. Unset: an absent default is no calendar (the
 * earlier behaviour), and a default that exists but does not parse still refuses.
 *
 * What the committed calendar may contain.
 *   1. SOURCE POLICY. A row's date must come from the company itself (its IR newsroom) or an SEC filing. An
 *      aggregator's or an exchange vendor's ESTIMATED date is not a source: on 2026-09-23 Nasdaq/Zacks estimated
 *      SPCX for 2026-11-03 and Investing.com said 2026-11-05, and SpaceX had announced neither. A wrong date is
 *      worse than none: the flag would read `supplied` and clear the real event day.
 *   2. NO SILENT GAP. Every launch-set ticker has either rows or a dated `_checked` note naming what was read, so
 *      "we looked and nothing was announced" is recorded, never implied by an empty list.
 *   3. THE HALT INPUT. Rows of the shape a real one takes parse against the registry and put the event inside the
 *      window of the expiries it can move: the P9 event flag that the MM halts on (engine.ts).
 *
 * The re-check day. `recheckBy` is per ticker and machine-readable; eventRecheckStatus marks a ticker
 * overdue once the New York day is past it and nothing covers today, which /health serves and the monitor pages on.
 *
 *   pnpm --filter @callhouse/keeper exec tsx --test src/v2/pricing/events.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newYorkTimeToUnix } from '../../calendar.js';
import { EventCalendarFileError, eventRecheckStatus, loadEventCalendarFile, parseEventCalendarFile } from './events.js';
import { eventsInWindow } from './short-maturity.js';

const KNOWN: ReadonlySet<string> = new Set(['NVDA', 'SPCX']);
const EVENTS_URL = new URL('../../../../ops/markets/events.json', import.meta.url);
const COMMITTED = EVENTS_URL.pathname;
const registry = JSON.parse(readFileSync(new URL('../../../../ops/markets/tier1.json', import.meta.url), 'utf8')) as {
  markets: Array<{ ticker: string }>;
  launchSet: { markets: string[] };
};
const TICKERS = new Set(registry.markets.map((m) => m.ticker));
const LAUNCH = registry.launchSet.markets;

/*//////////////////////////////////////////////////////////////
                  THE FILE'S REFUSALS
//////////////////////////////////////////////////////////////*/

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'events-259-'));
}

/** Asserts `fn` throws an EventCalendarFileError with this code and a message matching `message`. */
function assertRefusal(fn: () => unknown, code: EventCalendarFileError['code'], message: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof EventCalendarFileError, `an EventCalendarFileError, got ${String(error)}`);
    assert.equal(error.name, 'EventCalendarFileError');
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

test('PRICING_EVENTS_PATH set and the file missing: refuses, code missing, naming the variable and the path', () => {
  const path = join(scratch(), 'none.json');
  assertRefusal(() => loadEventCalendarFile(path, KNOWN, true), 'missing', new RegExp(`^PRICING_EVENTS_PATH ${path}: no such file$`));
});

test('PRICING_EVENTS_PATH set and the file not JSON: refuses, code invalid, naming the variable', () => {
  const path = join(scratch(), 'bad.json');
  writeFileSync(path, '{ not json');
  assertRefusal(() => loadEventCalendarFile(path, KNOWN, true), 'invalid', new RegExp(`^PRICING_EVENTS_PATH ${path}: not JSON`));
});

test('PRICING_EVENTS_PATH set and the rows refused: code invalid, the row problem kept in the message', () => {
  const path = join(scratch(), 'rows.json');
  writeFileSync(path, JSON.stringify({ events: [{ ticker: 'ZZZZ', date: '2026-11-18', kind: 'earnings', timing: 'amc', source: 'https://example.com/ir' }] }));
  assertRefusal(() => loadEventCalendarFile(path, KNOWN, true), 'invalid', /^PRICING_EVENTS_PATH .*: events file:\n {2}events\[0\]: ticker ZZZZ is not a registry market/);
});

test('unset: an absent default is no calendar, as before; a default that exists and does not parse still refuses', () => {
  const dir = scratch();
  assert.deepEqual(loadEventCalendarFile(join(dir, 'none.json'), KNOWN, false), { calendar: new Map(), loaded: false });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '[');
  assertRefusal(() => loadEventCalendarFile(bad, KNOWN, false), 'invalid', new RegExp(`^events file ${bad}: not JSON`));
});

test('the committed ops/markets/events.json loads when PRICING_EVENTS_PATH names it (the value pricing.env sets, relative to the image)', () => {
  const { loaded } = loadEventCalendarFile(COMMITTED, KNOWN, true);
  assert.equal(loaded, true);
});

/*//////////////////////////////////////////////////////////////
               WHAT THE CALENDAR MAY HOLD
//////////////////////////////////////////////////////////////*/

/**
 * Where a row's date may come from, per ticker: the company's own newsroom and IR site, and SEC EDGAR. A ticker
 * missing here cannot take a row until its primary hosts are added, with the reason, in this table.
 */
const PRIMARY_HOSTS: Readonly<Record<string, readonly string[]>> = {
  NVDA: ['nvidianews.nvidia.com', 'investor.nvidia.com', 'www.sec.gov'],
  SPCX: ['ir.spacex.com', 'www.sec.gov'],
};

type EventsFile = {
  events?: Array<{ ticker?: unknown; source?: unknown }>;
  _checked?: Array<{ ticker?: unknown; asOf?: unknown; sources?: unknown }>;
};

function sourceProblems(file: EventsFile): string[] {
  const problems: string[] = [];
  (file.events ?? []).forEach((row, i) => {
    const ticker = String(row.ticker);
    const allowed = PRIMARY_HOSTS[ticker];
    let host = '';
    try {
      host = new URL(String(row.source)).host;
    } catch {
      problems.push(`events[${i}] ${ticker}: source is not a URL`);
      return;
    }
    if (allowed === undefined) problems.push(`events[${i}] ${ticker}: no primary-source hosts are listed for this ticker`);
    else if (!allowed.includes(host)) problems.push(`events[${i}] ${ticker}: ${host} is not a primary source (${allowed.join(', ')})`);
  });
  return problems;
}

function coverageProblems(file: EventsFile, launch: readonly string[]): string[] {
  const problems: string[] = [];
  for (const ticker of launch) {
    if ((file.events ?? []).some((row) => row.ticker === ticker)) continue;
    const note = (file._checked ?? []).find((c) => c.ticker === ticker);
    if (note === undefined) {
      problems.push(`${ticker}: no rows and no _checked note`);
      continue;
    }
    if (typeof note.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(note.asOf)) problems.push(`${ticker}: _checked has no asOf day`);
    const sources = Array.isArray(note.sources) ? note.sources : [];
    if (sources.length === 0 || !sources.every((s) => typeof s === 'string' && /^https:\/\/\S+$/.test(s))) {
      problems.push(`${ticker}: _checked must name the https pages that were read`);
    }
  }
  return problems;
}

const committed = JSON.parse(readFileSync(EVENTS_URL, 'utf8')) as EventsFile;

test('the committed events.json loads against the registry, cites only primary sources, and records the launch tickers', () => {
  const { loaded } = loadEventCalendarFile(EVENTS_URL.pathname, TICKERS, true);
  assert.equal(loaded, true);
  assert.deepEqual(LAUNCH.slice().sort(), ['NVDA', 'SPCX'], 'mirrored from tier1.json launchSet (owner 2026-09-21)');
  assert.deepEqual(sourceProblems(committed), []);
  assert.deepEqual(coverageProblems(committed, LAUNCH), []);
});

test('source policy: an aggregator or a vendor estimate is refused; the company newsroom and EDGAR are accepted', () => {
  const row = (ticker: string, source: string) => ({ events: [{ ticker, source }] });
  assert.deepEqual(sourceProblems(row('NVDA', 'https://nvidianews.nvidia.com/news/some-release')), []);
  assert.deepEqual(sourceProblems(row('SPCX', 'https://ir.spacex.com/updates/releases-details/x')), []);
  assert.deepEqual(sourceProblems(row('SPCX', 'https://www.sec.gov/Archives/edgar/data/x')), []);
  assert.match(sourceProblems(row('SPCX', 'https://api.nasdaq.com/api/analyst/SPCX/earnings-date'))[0] ?? '', /api\.nasdaq\.com is not a primary source/);
  assert.match(sourceProblems(row('SPCX', 'https://www.investing.com/equities/spacex-earnings'))[0] ?? '', /www\.investing\.com is not a primary source/);
  assert.match(sourceProblems(row('NVDA', 'https://ir.spacex.com/x'))[0] ?? '', /not a primary source/, 'another company\'s host is not NVIDIA\'s');
  assert.match(sourceProblems(row('TSLA', 'https://ir.tesla.com/x'))[0] ?? '', /no primary-source hosts are listed/);
  assert.match(sourceProblems(row('NVDA', 'not a url'))[0] ?? '', /not a URL/);
});

test('no silent gap: a launch ticker with no rows needs a dated _checked note with https sources', () => {
  assert.deepEqual(coverageProblems({ events: [] }, ['NVDA', 'SPCX']), ['NVDA: no rows and no _checked note', 'SPCX: no rows and no _checked note']);
  assert.deepEqual(coverageProblems({ events: [{ ticker: 'NVDA' }], _checked: [] }, ['NVDA']), [], 'a row is coverage');
  assert.deepEqual(coverageProblems({ _checked: [{ ticker: 'SPCX', asOf: 'soon', sources: ['http://x.test'] }] }, ['SPCX']),
    ['SPCX: _checked has no asOf day', 'SPCX: _checked must name the https pages that were read']);
});

test('the halt input: real-shaped rows parse against the registry and put the event inside the expiries it can move', () => {
  // Fixture dates, not a claim about any company's calendar. Shape: what a cited row will look like.
  const calendar = parseEventCalendarFile({
    through: { NVDA: '2026-12-31' },
    events: [
      { ticker: 'NVDA', date: '2026-11-18', kind: 'earnings', timing: 'amc', source: 'https://nvidianews.nvidia.com/news/fixture' },
      { ticker: 'SPCX', date: '2026-11-03', kind: 'earnings', timing: 'bmo', source: 'https://ir.spacex.com/updates/fixture' },
    ],
  }, TICKERS);
  const close = (m: number, d: number) => newYorkTimeToUnix(2026, m, d, 16);
  const now = newYorkTimeToUnix(2026, 11, 16, 10);

  // After the close on the 18th: the 18th's own expiry has settled before the print; the 19th's has not.
  const sameDay = eventsInWindow(calendar.get('NVDA') ?? null, now, close(11, 18));
  assert.deepEqual([sameDay.input, sameDay.inWindow], ['supplied', false]);
  const nextDay = eventsInWindow(calendar.get('NVDA') ?? null, now, close(11, 19));
  assert.deepEqual([nextDay.input, nextDay.inWindow], ['supplied', true]);
  assert.deepEqual(nextDay.events.map((e) => `${e.date} ${e.kind} ${e.timing}`), ['2026-11-18 earnings amc']);

  // Before the open on the 3rd: that day's expiry already carries it. No `through` for SPCX: complete only through
  // its row, which is the expiry's own day.
  const spcx = eventsInWindow(calendar.get('SPCX') ?? null, newYorkTimeToUnix(2026, 11, 2, 10), close(11, 3));
  assert.deepEqual([spcx.input, spcx.inWindow], ['supplied', true]);

  // A list that stops short of the expiry is unknown past its end, and a ticker with no input is missing.
  const short = eventsInWindow(parseEventCalendarFile({ through: { NVDA: '2026-11-17' }, events: [] }, TICKERS).get('NVDA') ?? null, now, close(11, 18));
  assert.equal(short.input, 'short');
  assert.equal(eventsInWindow(calendar.get('AAPL') ?? null, now, close(11, 18)).input, 'missing');
});

test('the first cited row with no `through` covers only through its day; later expiries read short, never supplied', () => {
  // The file as it will look the day NVIDIA announces its next report and someone adds just that row.
  const file = (through?: Record<string, string>) => ({
    ...(through === undefined ? {} : { through }),
    events: [{ ticker: 'NVDA', date: '2026-11-18', kind: 'earnings', timing: 'amc', source: 'https://nvidianews.nvidia.com/news/fixture' }],
  });
  const close = (y: number, m: number, d: number) => newYorkTimeToUnix(y, m, d, 16);
  const now = newYorkTimeToUnix(2026, 11, 16, 10);
  const nvda = parseEventCalendarFile(file(), TICKERS).get('NVDA') ?? null;
  assert.equal(nvda?.through, null, 'the loader keeps what the file says; the limit is read by eventsInWindow');
  assert.equal(eventsInWindow(nvda, now, close(2026, 11, 18)).input, 'supplied', 'through its own day the row answers');
  const next = eventsInWindow(nvda, now, close(2026, 11, 19));
  assert.deepEqual([next.input, next.inWindow], ['short', true], 'the print is in the window and the list says nothing after it');
  // The next report after this one (late February) is not cleared by a calendar that names only this one.
  assert.equal(eventsInWindow(nvda, now, close(2027, 2, 26)).input, 'short');
  // Stating `through` is how the file says it covers more.
  assert.equal(eventsInWindow(parseEventCalendarFile(file({ NVDA: '2027-01-31' }), TICKERS).get('NVDA') ?? null, now, close(2026, 12, 18)).input, 'supplied');
});

/*//////////////////////////////////////////////////////////////
                 THE RE-CHECK DAY
//////////////////////////////////////////////////////////////*/

/** Noon in New York on a 2026 day, and one minute either side of a New York midnight. */
const nyNoon = (m: number, d: number) => newYorkTimeToUnix(2026, m, d, 12);
const nyMidnight = (m: number, d: number) => newYorkTimeToUnix(2026, m, d, 0);

function recheckFile(extra: Record<string, unknown> = {}): { calendar: ReturnType<typeof parseEventCalendarFile>; recheckBy: ReadonlyMap<string, string> } {
  const dir = scratch();
  const path = join(dir, 'events.json');
  writeFileSync(path, JSON.stringify({ recheckBy: { NVDA: '2026-10-15', SPCX: '2026-10-15' }, events: [], ...extra }));
  return loaded(loadEventCalendarFile(path, KNOWN, true));
}

/** The loaded branch of loadEventCalendarFile, which is the only one that carries re-check days. */
function loaded(r: ReturnType<typeof loadEventCalendarFile>): { calendar: ReturnType<typeof parseEventCalendarFile>; recheckBy: ReadonlyMap<string, string> } {
  assert.equal(r.loaded, true, 'the file loaded');
  if (!r.loaded) throw new Error('unreachable');
  return r;
}

test('recheckBy: the committed file gives every launch ticker without a dated row a machine-readable re-check day', () => {
  const { recheckBy, calendar } = loaded(loadEventCalendarFile(COMMITTED, TICKERS, true));
  for (const ticker of LAUNCH) {
    if ((calendar.get(ticker)?.events.length ?? 0) > 0) continue;
    assert.match(recheckBy.get(ticker) ?? '', /^\d{4}-\d{2}-\d{2}$/, `${ticker}: no rows, so it needs a recheckBy day`);
  }
  assert.deepEqual(Object.fromEntries(recheckBy), { NVDA: '2026-10-15', SPCX: '2026-10-15' }, 'the day T-MM2-02 recorded in _recheck');
});

test('recheckBy: an unknown ticker, a day that is not a real day, and a non-object each refuse the whole file', () => {
  assert.throws(() => parseEventCalendarFile({ recheckBy: { ZZZZ: '2026-10-15' }, events: [] }, KNOWN), /recheckBy\.ZZZZ: not a registry market/);
  assert.throws(() => parseEventCalendarFile({ recheckBy: { NVDA: '2026-02-30' }, events: [] }, KNOWN), /recheckBy\.NVDA: not a YYYY-MM-DD day: 2026-02-30/);
  assert.throws(() => parseEventCalendarFile({ recheckBy: { NVDA: 'from 2026-10-15' }, events: [] }, KNOWN), /recheckBy\.NVDA: not a YYYY-MM-DD day/);
  assert.throws(() => parseEventCalendarFile({ recheckBy: ['NVDA'], events: [] }, KNOWN), /recheckBy: not an object/);
  const path = join(scratch(), 'bad-recheck.json');
  writeFileSync(path, JSON.stringify({ recheckBy: { NVDA: 'soon' }, events: [] }));
  assertRefusal(() => loadEventCalendarFile(path, KNOWN, true), 'invalid', /recheckBy\.NVDA: not a YYYY-MM-DD day: soon/);
});

test('recheckOverdue: past the day with no rows and no through is overdue; the day itself is not', () => {
  const { calendar, recheckBy } = recheckFile();
  assert.deepEqual(eventRecheckStatus(recheckBy, calendar, nyNoon(10, 15)), {
    NVDA: { recheckBy: '2026-10-15', overdue: false, coveredBy: null },
    SPCX: { recheckBy: '2026-10-15', overdue: false, coveredBy: null },
  });
  assert.deepEqual(eventRecheckStatus(recheckBy, calendar, nyNoon(10, 16)), {
    NVDA: { recheckBy: '2026-10-15', overdue: true, coveredBy: null },
    SPCX: { recheckBy: '2026-10-15', overdue: true, coveredBy: null },
  });
  assert.deepEqual(eventRecheckStatus(new Map(), calendar, nyNoon(10, 16)), {}, 'a ticker with no recheckBy is not scheduled');
});

test('recheckOverdue is computed in New York days, not UTC', () => {
  const { calendar, recheckBy } = recheckFile();
  // 2026-10-16 00:30 UTC is 2026-10-15 20:30 in New York (EDT): still the re-check day.
  const utcNextDay = Date.UTC(2026, 9, 16, 0, 30) / 1000;
  assert.equal(eventRecheckStatus(recheckBy, calendar, utcNextDay).NVDA?.overdue, false);
  assert.equal(eventRecheckStatus(recheckBy, calendar, nyMidnight(10, 16) - 60).NVDA?.overdue, false, 'a minute before New York midnight');
  assert.equal(eventRecheckStatus(recheckBy, calendar, nyMidnight(10, 16) + 60).NVDA?.overdue, true, 'a minute after');
});

test('recheckOverdue: a through reaching today, or a row dated today or later, covers the ticker; a past row does not', () => {
  const src = (t: string) => (t === 'NVDA' ? 'https://nvidianews.nvidia.com/news/fixture' : 'https://ir.spacex.com/updates/fixture');
  const now = nyNoon(10, 20);

  const through = recheckFile({ through: { NVDA: '2026-10-20', SPCX: '2026-10-19' } });
  assert.deepEqual(eventRecheckStatus(through.recheckBy, through.calendar, now), {
    NVDA: { recheckBy: '2026-10-15', overdue: false, coveredBy: 'through' },
    SPCX: { recheckBy: '2026-10-15', overdue: true, coveredBy: null },
  }, 'SPCX\'s list stops the day before today');

  const rows = recheckFile({
    events: [
      { ticker: 'NVDA', date: '2026-11-18', kind: 'earnings', timing: 'amc', source: src('NVDA') },
      { ticker: 'SPCX', date: '2026-08-04', kind: 'earnings', timing: 'amc', source: src('SPCX') },
    ],
  });
  assert.deepEqual(eventRecheckStatus(rows.recheckBy, rows.calendar, now), {
    NVDA: { recheckBy: '2026-10-15', overdue: false, coveredBy: 'event' },
    SPCX: { recheckBy: '2026-10-15', overdue: true, coveredBy: null },
  }, 'SPCX\'s only row is its last report, which says nothing about the next one');

  // Once NVIDIA's listed report has gone by, the ticker is overdue again until a new row or recheckBy lands.
  assert.equal(eventRecheckStatus(rows.recheckBy, rows.calendar, nyNoon(11, 18)).NVDA?.overdue, false, 'the report day itself is covered');
  assert.equal(eventRecheckStatus(rows.recheckBy, rows.calendar, nyNoon(11, 19)).NVDA?.overdue, true);
});

test('the committed file: quiet today, overdue for both launch tickers the day after its re-check day if nothing is added', () => {
  const { calendar, recheckBy } = loaded(loadEventCalendarFile(COMMITTED, TICKERS, true));
  const overdue = (at: number) => Object.entries(eventRecheckStatus(recheckBy, calendar, at)).filter(([, s]) => s.overdue).map(([t]) => t);
  assert.deepEqual(overdue(nyNoon(9, 23)), []);
  assert.deepEqual(overdue(nyNoon(10, 16)), ['NVDA', 'SPCX']);
});
