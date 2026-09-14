/**
 * The weekly clock, pinned to real dates.
 *
 * WHY THIS FILE EXISTS: with no registry the keeper decides the tuple's timestamps itself, and
 * the tuple is immutable once created on Clear. A close computed at 20:00 UTC in November sells
 * a call that settles an hour after the market shut; one computed for Friday 25 December sells a
 * call against a closed exchange. Every case here is a date on the 2026–27 NYSE calendar, run
 * through the same Intl path production uses.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EXERCISE_WINDOW_SECONDS,
  NYSE_HOLIDAYS_2026_2027,
  describeInstant,
  newYorkParts,
  newYorkTimeToUnix,
  nextWeekWindow,
  parseHolidays,
} from './calendar.js';

const H = 3600;
const LEAD = 6 * H;

/** A UTC instant from a calendar line, for readable fixtures. */
const utc = (y: number, m: number, d: number, hh: number, mm = 0): number => Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000);

test('Overcall’s cycle-1 close reproduces: Fri 18 Sep 2026 16:00 ET is 20:00 UTC (EDT)', () => {
  assert.equal(newYorkTimeToUnix(2026, 9, 18, 16), 1789761600);
  const w = nextWeekWindow(utc(2026, 9, 14, 12), LEAD, []); // a Monday
  assert.equal(w.exerciseTs, 1789761600);
  assert.equal(w.expiryTs, 1789848000, 'expiry = exercise + 24 h, as on the real registry');
  assert.equal(w.friday, '2026-09-18');
  assert.equal(w.closeDay, '2026-09-18');
  assert.equal(w.skippedForLead, 0);
  assert.equal(EXERCISE_WINDOW_SECONDS, 86_400);
});

test('after the DST switch (1 Nov 2026) the same 16:00 ET close is 21:00 UTC, with no code change', () => {
  const w = nextWeekWindow(utc(2026, 11, 2, 12), LEAD, []);
  assert.equal(w.friday, '2026-11-06');
  assert.equal(w.exerciseTs, utc(2026, 11, 6, 21));
  assert.equal(newYorkParts(w.exerciseTs).offsetSeconds, -5 * H);
  // And the week before it was still 20:00 UTC.
  assert.equal(nextWeekWindow(utc(2026, 10, 26, 12), LEAD, []).exerciseTs, utc(2026, 10, 30, 20));
  // Spring forward 14 Mar 2027: back to 20:00 UTC.
  assert.equal(nextWeekWindow(utc(2027, 3, 15, 12), LEAD, []).exerciseTs, utc(2027, 3, 19, 20));
  assert.equal(nextWeekWindow(utc(2027, 3, 8, 12), LEAD, []).exerciseTs, utc(2027, 3, 12, 21));
});

test('a full-day Friday holiday rolls the close back to Thursday 16:00 ET', () => {
  // Christmas Day 2026 is a Friday: the week's close is Thursday 24 Dec 16:00 ET = 21:00 UTC.
  const xmas = nextWeekWindow(utc(2026, 12, 21, 12), LEAD, NYSE_HOLIDAYS_2026_2027);
  assert.equal(xmas.friday, '2026-12-25');
  assert.equal(xmas.closeDay, '2026-12-24');
  assert.equal(xmas.exerciseTs, utc(2026, 12, 24, 21));
  // Good Friday 3 Apr 2026: Thursday 2 Apr, 20:00 UTC (EDT by then).
  const goodFriday = nextWeekWindow(utc(2026, 3, 30, 12), LEAD, NYSE_HOLIDAYS_2026_2027);
  assert.equal(goodFriday.closeDay, '2026-04-02');
  assert.equal(goodFriday.exerciseTs, utc(2026, 4, 2, 20));
  // Independence Day observed Fri 3 Jul 2026: the feed's own 76 h gap that week began Thu 2 Jul.
  assert.equal(nextWeekWindow(utc(2026, 6, 29, 12), LEAD, NYSE_HOLIDAYS_2026_2027).closeDay, '2026-07-02');
  // New Year's Day 2027 is a Friday too.
  assert.equal(nextWeekWindow(utc(2026, 12, 28, 12), LEAD, NYSE_HOLIDAYS_2026_2027).closeDay, '2026-12-31');
  // Thanksgiving is a Thursday: the Friday close stands (an early close is not modelled).
  assert.equal(nextWeekWindow(utc(2026, 11, 23, 12), LEAD, NYSE_HOLIDAYS_2026_2027).closeDay, '2026-11-27');
  // Without the table, Christmas Day would be the close: the table is what moves it.
  assert.equal(nextWeekWindow(utc(2026, 12, 21, 12), LEAD, []).closeDay, '2026-12-25');
});

test('the lead rule: too close to this Friday’s close means next Friday', () => {
  const friday1500Et = utc(2026, 9, 18, 19); // 15:00 ET, one hour before the close
  const w = nextWeekWindow(friday1500Et, LEAD, []);
  assert.equal(w.friday, '2026-09-25');
  assert.equal(w.exerciseTs, utc(2026, 9, 25, 20));
  assert.equal(w.skippedForLead, 1);
  // Exactly the lead away is still this Friday; a second less is not.
  assert.equal(nextWeekWindow(1789761600 - LEAD, LEAD, []).friday, '2026-09-18');
  assert.equal(nextWeekWindow(1789761600 - LEAD + 1, LEAD, []).friday, '2026-09-25');
  // Saturday after the close: the next Friday is next week's, and nothing was skipped for the
  // lead (yesterday's Friday is not "on or after today").
  const sat = nextWeekWindow(utc(2026, 9, 19, 12), LEAD, []);
  assert.equal(sat.friday, '2026-09-25');
  assert.equal(sat.skippedForLead, 0);
  // A holiday week where Thursday’s close has passed on the Friday itself: next week.
  assert.equal(nextWeekWindow(utc(2026, 12, 25, 12), LEAD, NYSE_HOLIDAYS_2026_2027).friday, '2027-01-01');
  assert.equal(nextWeekWindow(utc(2026, 12, 25, 12), LEAD, NYSE_HOLIDAYS_2026_2027).closeDay, '2026-12-31');
});

test('the lead may not undercut the vault’s MIN_LEAD of an hour', () => {
  assert.throws(() => nextWeekWindow(utc(2026, 9, 14, 12), 3599, []), /MIN_LEAD/);
  assert.equal(nextWeekWindow(utc(2026, 9, 14, 12), 3600, []).friday, '2026-09-18');
});

test('newYorkParts reads the wall clock and weekday in New York', () => {
  const p = newYorkParts(1789761600);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 9, 18, 16, 0, 5]);
  // 03:00 UTC Saturday is still Friday evening in New York.
  const late = newYorkParts(utc(2026, 9, 19, 3));
  assert.deepEqual([late.day, late.hour, late.weekday], [18, 23, 5]);
});

test('parseHolidays: unset is the table, a list must be YYYY-MM-DD', () => {
  assert.deepEqual(parseHolidays(undefined), NYSE_HOLIDAYS_2026_2027);
  assert.deepEqual(parseHolidays('  '), NYSE_HOLIDAYS_2026_2027);
  assert.deepEqual(parseHolidays('2028-01-17,2028-02-21'), ['2028-01-17', '2028-02-21']);
  assert.throws(() => parseHolidays('2028-13-45'), /not a YYYY-MM-DD date/);
  assert.equal(NYSE_HOLIDAYS_2026_2027.length, 20, 'ten closures a year for two years');
});

test('describeInstant names both clocks', () => {
  assert.equal(describeInstant(1789761600), '2026-09-18T20:00:00Z (2026-09-18 16:00 ET, UTC-4)');
  assert.equal(describeInstant(utc(2026, 12, 24, 21)), '2026-12-24T21:00:00Z (2026-12-24 16:00 ET, UTC-5)');
});
