/**
 * expiry-clock.ts: the two clocks behind a price's time to expiry, what the trading clock does not see
 * (overnights, weekends, holidays, early closes), and the expiries it refuses.
 *
 * Early-close days here are SYNTHETIC test inputs (calendar.ts models none on this revision); no real
 * exchange schedule is asserted. Holidays are the committed NYSE table (Labor Day 2026-09-07).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { SESSION_SECONDS, TRADING_YEAR_SECONDS, sessionSecondsBetween } from './bs.js';
import { CLOCK_EARLY_CLOSE, checkExpiryClock, type ExpiryClock, type ExpiryClockInput } from './expiry-clock.js';

/** A September 2026 New York wall time (EDT, UTC-4). */
const ny = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour + 4, minute) / 1000;
const HOLIDAYS = NYSE_HOLIDAYS_2026_2028;
const WITHOUT_LABOR_DAY = HOLIDAYS.filter((d) => d !== '2026-09-07');

function clock(input: Partial<ExpiryClockInput> & Pick<ExpiryClockInput, 'nowSeconds' | 'expiry'>): ExpiryClock {
  const out = checkExpiryClock({ surfaceAsOf: input.nowSeconds - 3_600, surfaceClockBasis: 'underlying', holidays: HOLIDAYS, ...input });
  assert.ok(out.ok, `expected a clock, got ${out.ok ? '' : `${out.reason} ${JSON.stringify(out.detail)}`}`);
  return out;
}

function refusedWhy(input: ExpiryClockInput): string {
  const out = checkExpiryClock(input);
  assert.ok(!out.ok, 'expected a refusal');
  assert.equal(out.reason, 'expired');
  return out.detail.why ?? '';
}

test('clocks: pricing runs from the service clock, the surface from the chain clock; T is bs.ts session time', () => {
  const c = clock({ nowSeconds: ny(15, 4, 30), surfaceAsOf: ny(14, 15, 59) + 59, surfaceClockBasis: 'underlying', expiry: ny(18, 16) });
  assert.equal(c.basis, 'trading-time');
  assert.deepEqual([c.pricingFrom, c.pricingFromSource], [ny(15, 4, 30), 'service-clock']);
  assert.deepEqual([c.surfaceFrom, c.surfaceFromSource], [ny(14, 15, 59) + 59, 'underlying']);
  assert.equal(c.sessionSeconds, 4 * SESSION_SECONDS);
  assert.equal(c.sessionSeconds, sessionSecondsBetween(ny(15, 4, 30), ny(18, 16), HOLIDAYS));
  assert.equal(c.yearsToExpiry, c.sessionSeconds / TRADING_YEAR_SECONDS);
  assert.equal(clock({ nowSeconds: ny(15, 4, 30), surfaceClockBasis: 'quote', expiry: ny(18, 16) }).surfaceFromSource, 'quote');
  assert.deepEqual(c.reasons, []);
});

test('overnight, weekend and holiday: gaps and closed days the trading clock gives no time', () => {
  // Intraday, same session: no gap.
  const intraday = clock({ nowSeconds: ny(15, 10), expiry: ny(15, 16) });
  assert.deepEqual([intraday.gaps, intraday.closedDays, intraday.sessionSeconds], [0, 0, 6 * 3_600]);
  // Before the open: the rest of the overnight is one gap.
  const preOpen = clock({ nowSeconds: ny(15, 4, 30), expiry: ny(15, 16) });
  assert.deepEqual([preOpen.gaps, preOpen.closedDays, preOpen.sessionSeconds], [1, 0, SESSION_SECONDS]);
  // One overnight.
  const overnight = clock({ nowSeconds: ny(15, 10), expiry: ny(16, 16) });
  assert.deepEqual([overnight.gaps, overnight.closedDays], [1, 0]);
  // Friday 10:00 to Monday's close: one gap (the weekend) holding two closed days.
  const weekend = clock({ nowSeconds: ny(18, 10), expiry: ny(21, 16) });
  assert.deepEqual([weekend.gaps, weekend.closedDays, weekend.sessionSeconds], [1, 2, 6 * 3_600 + SESSION_SECONDS]);
  // Friday 4 Sep to Tuesday 8 Sep over Labor Day: still one gap, three closed days, one session less.
  const holiday = clock({ nowSeconds: ny(4, 10), expiry: ny(8, 16) });
  assert.deepEqual([holiday.gaps, holiday.closedDays, holiday.sessionSeconds], [1, 3, 6 * 3_600 + SESSION_SECONDS]);
  const noHoliday = clock({ nowSeconds: ny(4, 10), expiry: ny(8, 16), holidays: WITHOUT_LABOR_DAY });
  assert.deepEqual([noHoliday.gaps, noHoliday.closedDays, noHoliday.sessionSeconds], [2, 2, 6 * 3_600 + 2 * SESSION_SECONDS]);
  // Saturday noon: today is not counted as a whole closed day, Sunday and Labor Day are.
  const saturday = clock({ nowSeconds: ny(5, 12), expiry: ny(8, 16) });
  assert.deepEqual([saturday.gaps, saturday.closedDays], [1, 2]);
});

test('early close (synthetic day): the over-counted session is measured and flagged; the price clock is unchanged', () => {
  const plain = clock({ nowSeconds: ny(15, 4, 30), expiry: ny(18, 16) });
  const early = clock({ nowSeconds: ny(15, 4, 30), expiry: ny(18, 16), earlyCloses: ['2026-09-16'] });
  assert.equal(early.sessionSeconds, plain.sessionSeconds, 'the trading clock itself does not model early closes');
  assert.equal(early.earlyCloseLostSeconds, 3 * 3_600);
  assert.deepEqual(early.earlyCloseDays, ['2026-09-16']);
  assert.deepEqual(early.reasons, [CLOCK_EARLY_CLOSE]);
  // Outside the window, after the early close already passed, or on a holiday: nothing.
  assert.deepEqual(clock({ nowSeconds: ny(15, 4, 30), expiry: ny(15, 16), earlyCloses: ['2026-09-16'] }).reasons, []);
  assert.equal(clock({ nowSeconds: ny(16, 15), expiry: ny(18, 16), earlyCloses: ['2026-09-16'] }).earlyCloseLostSeconds, 3_600, 'only the part still ahead');
  assert.equal(clock({ nowSeconds: ny(4, 10), expiry: ny(8, 16), earlyCloses: ['2026-09-07'] }).earlyCloseLostSeconds, 0, 'a holiday has no session to lose');
});

test('refusals: an expiry not after either clock, or with no regular session left', () => {
  const base = { surfaceClockBasis: 'underlying' as const, holidays: HOLIDAYS };
  assert.match(refusedWhy({ ...base, nowSeconds: ny(15, 16), surfaceAsOf: ny(14, 16), expiry: ny(15, 16) }), /not after the service clock/);
  assert.match(refusedWhy({ ...base, nowSeconds: ny(15, 10), surfaceAsOf: ny(16, 16), expiry: ny(15, 16) }), /not after the surface clock/);
  // After Friday's close, a Saturday expiry: every second left is closed.
  assert.match(refusedWhy({ ...base, nowSeconds: ny(18, 17), surfaceAsOf: ny(17, 16), expiry: ny(19, 16) }), /no regular session remains before the expiry$/);
  // Labor Day itself, from the Friday evening before.
  assert.match(refusedWhy({ ...base, nowSeconds: ny(4, 17), surfaceAsOf: ny(4, 16), expiry: ny(7, 16) }), /no regular session remains/);
  // After a (synthetic) 13:00 early close, that day's 16:00 expiry has no session left.
  assert.match(refusedWhy({ ...base, nowSeconds: ny(17, 14), surfaceAsOf: ny(16, 16), expiry: ny(17, 16), earlyCloses: ['2026-09-17'] }), /after the early close/);
  // A second of session is still a price.
  assert.equal(checkExpiryClock({ ...base, nowSeconds: ny(18, 16) - 1, surfaceAsOf: ny(17, 16), expiry: ny(18, 16) }).ok, true);
});
