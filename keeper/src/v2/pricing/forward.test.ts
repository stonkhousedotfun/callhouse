/**
 * forward.ts: the live underlying implied by put-call parity, on synthetic chains with a KNOWN forward.
 *
 * Every chain here is built so that at the true forward F = 211.40 each pair's call mid minus put mid
 * is exactly F - K. Then one pair at a time is spoiled (a wide book, a stale or missing quote clock, a
 * quote far off the others, a missing leg) and the forward must still be F, from the pairs left, with
 * the drop counted under its reason. Below `minPairs` there is no forward and the caller falls back.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAIN_CONTRACT, type ChainRow, type NormalizedChain, type OptionSide } from './chain.js';
import { DEFAULT_FORWARD_SETTINGS, afterNewYorkClose, impliedForward, newYorkDay } from './forward.js';

/** 2026-09-18 12:00 New York (EDT): a Friday with a listed expiry the same day. */
const NOW = Date.UTC(2026, 8, 18, 16) / 1000;
const TODAY = '2026-09-18';
const F = 211.4;
/** The provider's (delayed) underlying: 1% off the forward, as a 15-minute-old print can be. */
const DELAYED_UNDERLYING = 209.3;

interface Leg {
  bid: number;
  ask: number;
  observedAt: number | null;
}

function row(day: string, side: OptionSide, strike: number, leg: Leg | null): ChainRow {
  return {
    instrument: { providerInstrumentId: `O:NVDA${day}${side}${strike}`, root: 'NVDA', side, strike, expiryDay: day, expiry: null, multiplier: 100, exercise: 'american', settlement: 'physical' },
    quote: leg === null ? null : { bid: leg.bid, ask: leg.ask, bidSize: 10, askSize: 10, currency: 'USD', observedAt: leg.observedAt },
    analytics: null,
    theoretical: null,
  };
}

/** A call and a put at `strike` whose mids satisfy parity at `forward`, with `halfSpread` each side. */
function pair(day: string, strike: number, options: { forward?: number; halfSpread?: number; at?: number | null; callAt?: number | null } = {}): ChainRow[] {
  const forward = options.forward ?? F;
  const h = options.halfSpread ?? 0.02;
  const at = options.at === undefined ? NOW - 5 : options.at;
  const intrinsic = forward - strike;
  // Time value 1.00 on both sides keeps every mid positive; C - P = F - K.
  const callMid = Math.max(intrinsic, 0) + 1;
  const putMid = callMid - intrinsic;
  return [
    row(day, 'C', strike, { bid: callMid - h, ask: callMid + h, observedAt: options.callAt === undefined ? at : options.callAt }),
    row(day, 'P', strike, { bid: putMid - h, ask: putMid + h, observedAt: at }),
  ];
}

function chain(rows: ChainRow[], underlying: number | null = DELAYED_UNDERLYING): NormalizedChain {
  return {
    contract: CHAIN_CONTRACT,
    provider: { id: 'test', product: null, entitlement: { class: 'real-time', declaredDelayS: 0, rightsRef: null } },
    underlying: { providerSymbol: 'NVDA', issuer: null, price: underlying, observedAt: NOW - 900, observedAtText: null },
    clocks: { quoteObservedAt: null, tradeObservedAt: null, volatilityObservedAt: null, publishedAt: null, publishedAtText: null, receivedAt: NOW },
    rows,
    skippedRows: 0,
    firstSkip: null,
  };
}

const STRIKES = [205, 207.5, 210, 212.5, 215, 217.5];
const clean = (day = TODAY) => STRIKES.flatMap((k) => pair(day, k));

function forwardOf(result: ReturnType<typeof impliedForward>): number {
  assert.ok(result.ok, result.ok ? '' : result.why);
  return result.forward;
}

test('newYorkDay is the New York calendar day, not UTC\'s', () => {
  assert.equal(newYorkDay(NOW), TODAY);
  // 2026-09-19 02:00 UTC is still the 18th in New York.
  assert.equal(newYorkDay(Date.UTC(2026, 8, 19, 2) / 1000), '2026-09-18');
});

test('a clean chain gives the known forward from several strikes, not the delayed underlying', () => {
  const r = impliedForward(chain(clean()), DELAYED_UNDERLYING, NOW);
  assert.ok(Math.abs(forwardOf(r) - F) < 1e-9, `${forwardOf(r)}`);
  assert.ok(r.ok);
  assert.equal(r.expiryDay, TODAY);
  assert.equal(r.pairs.length, DEFAULT_FORWARD_SETTINGS.maxPairs);
  assert.equal(r.observedAt, NOW - 5);
});

test('after 16:00 New York today\'s listing has expired: the forward moves to the next expiry', () => {
  const close = Date.UTC(2026, 8, 18, 20) / 1000; // 16:00 EDT
  assert.equal(afterNewYorkClose(close - 1), false);
  assert.equal(afterNewYorkClose(close), true);
  // Both listings quoted fresh around the close: today's at 15:59, Monday's through the evening.
  const rows = [...STRIKES.flatMap((k) => pair(TODAY, k, { at: close - 61 })), ...STRIKES.flatMap((k) => pair('2026-09-21', k, { forward: 213, at: close + 60 }))];
  const before = impliedForward(chain(rows.filter((r) => r.instrument.expiryDay === TODAY)), DELAYED_UNDERLYING, close - 60);
  assert.ok(before.ok);
  assert.equal(before.expiryDay, TODAY);
  const after = impliedForward(chain(rows), DELAYED_UNDERLYING, close + 120);
  assert.ok(after.ok, after.ok ? '' : after.why);
  assert.equal(after.expiryDay, '2026-09-21');
  assert.ok(Math.abs(after.forward - 213) < 1e-9);
});

test('the nearest expiry on or after today: the 0DTE day, and never a past day', () => {
  const rows = [...STRIKES.flatMap((k) => pair('2026-09-17', k, { forward: 190 })), ...clean(), ...STRIKES.flatMap((k) => pair('2026-09-25', k, { forward: 213 }))];
  const r = impliedForward(chain(rows), DELAYED_UNDERLYING, NOW);
  assert.ok(r.ok);
  assert.equal(r.expiryDay, TODAY);
  assert.ok(Math.abs(r.forward - F) < 1e-9);
  const afterToday = impliedForward(chain(STRIKES.flatMap((k) => pair('2026-09-25', k, { forward: 213 }))), DELAYED_UNDERLYING, NOW);
  assert.ok(afterToday.ok);
  assert.equal(afterToday.expiryDay, '2026-09-25', 'with no 0DTE listing, the next one');
});

test('a wide pair is dropped by its combined spread, and the forward still comes from the rest', () => {
  // 210's pair is 1.80 wide each side: 3.60 total, 172 bps of 209.3, over the 100 bps limit, and quoted off parity by 2.
  const rows = [...STRIKES.filter((k) => k !== 210).flatMap((k) => pair(TODAY, k)), ...pair(TODAY, 210, { forward: F + 2, halfSpread: 0.9 })];
  const r = impliedForward(chain(rows), DELAYED_UNDERLYING, NOW);
  assert.ok(Math.abs(forwardOf(r) - F) < 1e-9);
  assert.ok(r.ok);
  assert.equal(r.dropped.wide, 1);
  assert.ok(!r.pairs.some((p) => p.strike === 210));
});

test('a stale pair is dropped by its OWN quote clock, and so is a leg with no clock at all', () => {
  const stale = NOW - DEFAULT_FORWARD_SETTINGS.maxQuoteAgeS - 1;
  const rows = [
    ...[205, 212.5, 215, 217.5].flatMap((k) => pair(TODAY, k)),
    ...pair(TODAY, 210, { forward: F - 3, at: stale }),
    ...pair(TODAY, 207.5, { forward: F + 3, callAt: null }),
  ];
  const r = impliedForward(chain(rows), DELAYED_UNDERLYING, NOW);
  assert.ok(Math.abs(forwardOf(r) - F) < 1e-9);
  assert.ok(r.ok);
  assert.equal(r.dropped.stale, 2);
  const atLimit = impliedForward(chain(pair(TODAY, 210, { at: NOW - DEFAULT_FORWARD_SETTINGS.maxQuoteAgeS }).concat(pair(TODAY, 212.5))), DELAYED_UNDERLYING, NOW);
  assert.ok(atLimit.ok, 'the age limit is inclusive');
});

test('an outlier pair inside its spread limits is dropped against the median', () => {
  const rows = [...STRIKES.filter((k) => k !== 212.5).flatMap((k) => pair(TODAY, k)), ...pair(TODAY, 212.5, { forward: F + 0.5 })];
  const r = impliedForward(chain(rows), DELAYED_UNDERLYING, NOW);
  assert.ok(Math.abs(forwardOf(r) - F) < 1e-9);
  assert.ok(r.ok);
  assert.equal(r.dropped.outlier, 1);
});

test('tighter pairs weigh more: 1 / width^2', () => {
  const rows = [...pair(TODAY, 210, { forward: 211.3, halfSpread: 0.01 }), ...pair(TODAY, 212.5, { forward: 211.5, halfSpread: 0.03 })];
  const r = impliedForward(chain(rows), DELAYED_UNDERLYING, NOW, { ...DEFAULT_FORWARD_SETTINGS, agreeSlackBps: 100 });
  // Widths 0.04 and 0.12: weights 625 and 69.4, so F = (211.3 * 625 + 211.5 * 69.44) / 694.44 = 211.32.
  assert.ok(Math.abs(forwardOf(r) - 211.32) < 1e-9, `${forwardOf(r)}`);
});

test('fallback: too few usable pairs, one-sided books, no listing, no reference; each says why', () => {
  const one = impliedForward(chain(pair(TODAY, 210)), DELAYED_UNDERLYING, NOW);
  assert.ok(!one.ok);
  assert.match(one.why, /fewer than 2/);
  const oneSided = impliedForward(chain([...pair(TODAY, 210), row(TODAY, 'C', 212.5, { bid: 1, ask: 1.1, observedAt: NOW }), row(TODAY, 'P', 212.5, null)]), DELAYED_UNDERLYING, NOW);
  assert.ok(!oneSided.ok);
  assert.equal(oneSided.dropped['one-sided'], 1);
  const allStale = impliedForward(chain(STRIKES.flatMap((k) => pair(TODAY, k, { at: NOW - 3_600 }))), DELAYED_UNDERLYING, NOW);
  assert.ok(!allStale.ok);
  assert.equal(allStale.dropped.stale, STRIKES.length);
  const past = impliedForward(chain(STRIKES.flatMap((k) => pair('2026-09-17', k))), DELAYED_UNDERLYING, NOW);
  assert.ok(!past.ok);
  assert.match(past.why, /no listed expiry/);
  assert.ok(!impliedForward(chain(clean()), Number.NaN, NOW).ok);
});

test('the reference only chooses the strikes: a reference 1% off still gives the true forward', () => {
  const wide = [195, 197.5, 200, 202.5, ...STRIKES, 220, 222.5, 225].flatMap((k) => pair(TODAY, k));
  const low = impliedForward(chain(wide), F * 0.99, NOW);
  const high = impliedForward(chain(wide), F * 1.01, NOW);
  assert.ok(Math.abs(forwardOf(low) - F) < 1e-9);
  assert.ok(Math.abs(forwardOf(high) - F) < 1e-9);
  assert.ok(low.ok && high.ok);
  assert.notDeepEqual(low.pairs.map((p) => p.strike), high.pairs.map((p) => p.strike), 'different strikes were near');
});
