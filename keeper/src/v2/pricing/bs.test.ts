/**
 * Black-Scholes at r = 0 on the trading clock: the maths every fair value in v2 rests on.
 *
 * WHY THIS FILE EXISTS: a fair value is only as good as its normal CDF, its clock and its
 * behaviour an hour (or a second) before a daily's close. The price table was checked when it was
 * written against direct numerical integration of each payoff under the lognormal (agreement to
 * ~5e-9, the integration's own error) and every delta against a finite difference; here it is
 * pinned, together with the identities that hold for any input (put-call parity, homogeneity,
 * bounds), so a later "optimisation" cannot quietly move a price.
 *
 * DELIBERATELY ABSENT: market data. surface.test.ts and fair.test.ts use the real chains.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { newYorkTimeToUnix } from '../../calendar.js';
import { DEFAULT_PRICING_SETTINGS } from './fair.js';
import {
  IV_SOLVE_MAX,
  SESSION_SECONDS,
  TRADING_YEAR_SECONDS,
  bsDelta,
  bsPrice,
  impliedVol,
  intrinsicValue,
  normCdf,
  sessionSecondsBetween,
  tradingYears,
  type OptionKind,
} from './bs.js';

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected} (±${tolerance})`);

/** Unix seconds of a UTC wall-clock time. */
const utc = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

/*//////////////////////////////////////////////////////////////
                           NORMAL CDF
//////////////////////////////////////////////////////////////*/

test('normCdf: double precision in the body, relative precision in the far tails', () => {
  const body: Array<[number, number]> = [
    [0, 0.5],
    [0.1, 0.539827837277029],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145705],
    [1.96, 0.9750021048517795],
    [-1.96, 0.024997895148220435],
    [-3, 0.0013498980316300946],
    [3, 0.9986501019683699],
  ];
  for (const [x, p] of body) close(normCdf(x), p, 1e-14, `N(${x})`);
  const tails: Array<[number, number]> = [
    [-5, 2.866515718791939e-7],
    [-6, 9.865876450376946e-10],
    [-8, 6.22096057427178e-16],
  ];
  for (const [x, p] of tails) close(normCdf(x) / p, 1, 1e-7, `N(${x}) relative`);
  assert.equal(normCdf(-40), 0);
  assert.equal(normCdf(40), 1);
  assert.ok(Number.isNaN(normCdf(Number.NaN)));
  // Symmetric and monotone across the switch to the continued fraction at 7.07.
  for (const x of [0.3, 2.5, 7.07, 7.08, 12]) close(normCdf(x) + normCdf(-x), 1, 1e-15, `N(${x}) + N(-${x})`);
  assert.ok(normCdf(7.0710678) <= normCdf(7.0710679));
});

/*//////////////////////////////////////////////////////////////
                         PRICES AND DELTAS
//////////////////////////////////////////////////////////////*/

test('bsPrice and bsDelta: the table, calls and puts at r = 0', () => {
  // [type, spot, strike, vol, t, price, delta]. The ATM row is exact: S × (2N(σ√T/2) - 1).
  const rows: Array<[OptionKind, number, number, number, number, number, number]> = [
    ['call', 100, 100, 0.2, 1, 7.965567455405804, 0.539827837277029],
    ['put', 100, 100, 0.2, 1, 7.965567455405804, -0.460172162722971],
    ['call', 212.21, 220, 0.31, 4 / 252, 0.812212221656786, 0.183122793973858],
    ['put', 212.21, 205, 0.335, 4 / 252, 1.023097094729735, -0.20042776923977135],
    ['call', 360, 380, 0.45, 1 / 252, 0.11370919420668457, 0.029169718740566154],
    ['put', 360, 340, 0.45, 1 / 252, 0.08058011682282018, -0.021151196213129997],
    ['call', 50, 55, 0.8, 30 / 252, 3.6006259719840408, 0.4178952765535481],
    ['put', 50, 45, 0.8, 30 / 252, 3.086561235205494, -0.30163012418335045],
    ['call', 100, 90, 0.3, 0.25, 12.021727425647768, 0.7815396075567388],
    ['put', 100, 110, 0.3, 0.25, 12.500244806693075, -0.712397092903396],
  ];
  for (const [type, spot, strike, vol, t, price, delta] of rows) {
    const input = { type, spot, strike, vol, t };
    close(bsPrice(input), price, 1e-11, `${type} ${spot}/${strike} price`);
    close(bsDelta(input), delta, 1e-12, `${type} ${spot}/${strike} delta`);
    // Delta is the derivative of the price in spot.
    const h = 1e-4;
    const fd = (bsPrice({ ...input, spot: spot + h }) - bsPrice({ ...input, spot: spot - h })) / (2 * h);
    close(bsDelta(input), fd, 1e-6, `${type} ${spot}/${strike} delta vs finite difference`);
  }
});

test('the identities: put-call parity, put delta = call delta - 1, homogeneity, bounds, monotone in vol and time', () => {
  for (const [spot, strike, vol, t] of [
    [212.21, 220, 0.31, 4 / 252],
    [360, 300, 1.2, 0.5],
    [15, 17.5, 2.4, 1 / 252 / 6.5],
  ] as const) {
    const call = { type: 'call' as const, spot, strike, vol, t };
    const put = { ...call, type: 'put' as const };
    close(bsPrice(call) - bsPrice(put), spot - strike, 1e-9 * spot, 'C - P = S - K');
    close(bsDelta(call) - 1, bsDelta(put), 1e-15, 'put delta');
    // BS at r = 0 is homogeneous of degree one: what carries a share option to a token.
    close(bsPrice({ ...call, spot: spot * 1.0008, strike: strike * 1.0008 }), 1.0008 * bsPrice(call), 1e-9 * spot, 'homogeneity');
    for (const input of [call, put]) {
      const p = bsPrice(input);
      assert.ok(p >= intrinsicValue(input.type, spot, strike) && p <= (input.type === 'call' ? spot : strike), 'inside the no-arbitrage bounds');
      assert.ok(bsPrice({ ...input, vol: vol * 1.1 }) > p, 'more vol, more price');
      assert.ok(bsPrice({ ...input, t: t * 1.1 }) > p, 'more time, more price');
    }
  }
  assert.throws(() => bsPrice({ type: 'call', spot: 0, strike: 100, vol: 0.2, t: 1 }), RangeError);
  assert.throws(() => bsPrice({ type: 'call', spot: 100, strike: 100, vol: -0.2, t: 1 }), RangeError);
  assert.throws(() => bsDelta({ type: 'put', spot: 100, strike: Number.NaN, vol: 0.2, t: 1 }), RangeError);
});

test('dailies: an hour, a minute, a second and zero before the close price without a blow-up', () => {
  const spot = 360;
  const vol = 0.45;
  for (const seconds of [0, 1, 60, 3_600, SESSION_SECONDS]) {
    const t = seconds / TRADING_YEAR_SECONDS;
    for (const strike of [340, 355, 359.99, 360, 360.01, 365, 380]) {
      for (const type of ['call', 'put'] as const) {
        const input = { type, spot, strike, vol, t };
        const p = bsPrice(input);
        const d = bsDelta(input);
        assert.ok(Number.isFinite(p) && Number.isFinite(d), `${type} ${strike} at ${seconds}s is finite`);
        assert.ok(p >= intrinsicValue(type, spot, strike) - 1e-12, `${type} ${strike} at ${seconds}s is not under intrinsic`);
        assert.ok(type === 'call' ? d >= 0 && d <= 1 : d >= -1 && d <= 0, `${type} ${strike} at ${seconds}s delta in range`);
      }
    }
  }
  // At zero time: intrinsic and the step, 0.5 exactly at the money.
  const expired = { spot, vol, t: 0 };
  assert.equal(bsPrice({ ...expired, type: 'call', strike: 355 }), 5);
  assert.equal(bsPrice({ ...expired, type: 'put', strike: 355 }), 0);
  assert.equal(bsDelta({ ...expired, type: 'call', strike: 355 }), 1);
  assert.equal(bsDelta({ ...expired, type: 'call', strike: 360 }), 0.5);
  assert.equal(bsDelta({ ...expired, type: 'put', strike: 360 }), -0.5);
  assert.equal(bsDelta({ ...expired, type: 'put', strike: 365 }), -1);
  // Near the money a daily's premium is ~0.4 × S × σ√T, and shrinks with the square root of time.
  const oneHour = bsPrice({ type: 'call', spot, strike: spot, vol, t: 3_600 / TRADING_YEAR_SECONDS });
  const oneMinute = bsPrice({ type: 'call', spot, strike: spot, vol, t: 60 / TRADING_YEAR_SECONDS });
  close(oneHour, 0.3989 * spot * vol * Math.sqrt(3_600 / TRADING_YEAR_SECONDS), 1e-3, 'ATM hour');
  close(oneHour / oneMinute, Math.sqrt(60), 1e-3, 'square-root decay');
});

test('impliedVol: round trips calls and puts to 1e-9, dailies included; refuses what has no vol', () => {
  for (const [type, spot, strike, vol, t] of [
    ['call', 211.06, 220, 0.31, 4 / 252],
    ['put', 211.06, 200, 0.36, 4 / 252],
    ['call', 358.36, 400, 0.6, 7 / 252],
    ['put', 360, 359, 0.6, 60 / TRADING_YEAR_SECONDS],
    ['call', 12.55, 14, 1.8, 3_600 / TRADING_YEAR_SECONDS],
    ['put', 100, 100, 0.02, 1 / 252],
  ] as const) {
    const price = bsPrice({ type, spot, strike, vol, t });
    const iv = impliedVol(price, { type, spot, strike, t });
    assert.ok(iv !== null, `${type} ${strike} solves`);
    close(iv, vol, 1e-9, `${type} ${strike} vol`);
  }
  const base = { type: 'call' as const, spot: 100, strike: 90, t: 0.1 };
  assert.equal(impliedVol(10, base), null, 'at intrinsic: no time value to explain');
  assert.equal(impliedVol(9.5, base), null, 'under intrinsic');
  assert.equal(impliedVol(100, base), null, 'at the upper bound');
  assert.equal(impliedVol(1, { ...base, t: 0 }), null, 'no time');
  assert.equal(impliedVol(Number.NaN, base), null);
  assert.equal(impliedVol(1, { ...base, spot: -1 }), null);
  const absurd = bsPrice({ ...base, vol: IV_SOLVE_MAX * 1.5 });
  assert.equal(impliedVol(Math.min(absurd, 99.999), base), null, 'a price that needs more than IV_SOLVE_MAX');
  assert.equal(impliedVol(5, { type: 'put', spot: 100, strike: 105, t: 0.1 }), null, 'a put at intrinsic');
});

/*//////////////////////////////////////////////////////////////
                           TRADING CLOCK
//////////////////////////////////////////////////////////////*/

test('sessionSecondsBetween: 09:30-16:00 New York on session days only, DST and holidays from calendar.ts', () => {
  const days = (from: number, to: number, holidays?: readonly string[]) => sessionSecondsBetween(from, to, holidays) / SESSION_SECONDS;
  // The NVDA fixture's clock: Monday 15:59:59 EDT to Friday 16:00 EDT is four sessions and a second.
  assert.equal(sessionSecondsBetween(utc(2026, 9, 14, 19, 59, 59), utc(2026, 9, 18, 20)), 4 * SESSION_SECONDS + 1);
  // Overnight, a weekend, a whole Saturday: nothing.
  assert.equal(sessionSecondsBetween(utc(2026, 9, 14, 20), utc(2026, 9, 15, 13, 30)), 0, 'Mon close to Tue open');
  assert.equal(sessionSecondsBetween(utc(2026, 9, 18, 20), utc(2026, 9, 21, 13, 30)), 0, 'Fri close to Mon open');
  assert.equal(days(utc(2026, 9, 18, 20), utc(2026, 9, 21, 20)), 1, 'Fri close to Mon close');
  // Inside a session: Friday 10:00 to 16:00 EDT is six hours.
  assert.equal(sessionSecondsBetween(utc(2026, 9, 18, 14), utc(2026, 9, 18, 20)), 6 * 3_600);
  assert.equal(sessionSecondsBetween(utc(2026, 9, 18, 19, 59), utc(2026, 9, 18, 20)), 60, 'a minute before the close');
  // Pre-market counts from the open.
  assert.equal(sessionSecondsBetween(utc(2026, 9, 15, 8, 30), utc(2026, 9, 15, 20)), SESSION_SECONDS);
  // Thanksgiving (Thu 26 Nov 2026, EST): Wed 15:00 to Fri 16:00 is one hour plus one session.
  assert.equal(sessionSecondsBetween(utc(2026, 11, 25, 20), utc(2026, 11, 27, 21)), 3_600 + SESSION_SECONDS);
  // Across the DST switch (Sun 1 Nov 2026): Fri 16:00 EDT to Mon 16:00 EST is one session.
  assert.equal(days(utc(2026, 10, 30, 20), utc(2026, 11, 2, 21)), 1);
  // A custom holiday table replaces the built-in one; reversed or equal spans are zero.
  assert.equal(days(utc(2026, 9, 14, 20), utc(2026, 9, 16, 20), ['2026-09-15']), 1);
  assert.equal(sessionSecondsBetween(utc(2026, 9, 18, 20), utc(2026, 9, 14, 20)), 0);
  assert.throws(() => sessionSecondsBetween(0, Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => sessionSecondsBetween(utc(2026, 1, 1, 0), utc(2030, 1, 1, 0)), RangeError, 'a span no series has');
});

test('tradingYears: sessions over 252 × 6.5 h', () => {
  assert.equal(TRADING_YEAR_SECONDS, 252 * 23_400);
  assert.equal(tradingYears(utc(2026, 9, 18, 20), utc(2026, 9, 25, 20)), 5 / 252);
  assert.equal(tradingYears(utc(2026, 9, 18, 19), utc(2026, 9, 18, 20)), 3_600 / TRADING_YEAR_SECONDS);
});

test('the pricing clock knows the 2028 NYSE closures the on-chain ExpiryCalendar was seeded with (ops/markets/v2-sources.json)', () => {
  // Friday 14 Jan 2028 16:00 to Tuesday 18 Jan 2028 16:00 New York: Monday is MLK Day, so one session, not two.
  const fri = newYorkTimeToUnix(2028, 1, 14, 16);
  const tue = newYorkTimeToUnix(2028, 1, 18, 16);
  assert.equal(sessionSecondsBetween(fri, tue), 6.5 * 3_600);
  const sources = JSON.parse(readFileSync(new URL('../../../../ops/markets/v2-sources.json', import.meta.url), 'utf8')) as { nyseHolidays: Record<string, { fullDays: Array<{ date: string }> }> };
  for (const [year, { fullDays }] of Object.entries(sources.nyseHolidays)) {
    for (const { date } of fullDays) assert.ok(DEFAULT_PRICING_SETTINGS.holidays.includes(date), `${year}: ${date} is a closure the pricing service must know`);
  }
});
