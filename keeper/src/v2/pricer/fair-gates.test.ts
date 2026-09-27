/**
 * Qualification of a /fair answer: source age, unknown times, optional provenance, spot gap.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress } from 'viem';
import { fairResponse } from '../pricing/server.js';
import { parseFairBody, type FairAnswer } from './fair-client.js';
import { qualifyFair, spotGapBps, type FairGateContext } from './fair-gates.js';

const NVDA = getAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
const NOW = 1_790_000_000;
const SPOT = 212_210_000n;

function ctx(over: Partial<FairGateContext> = {}): FairGateContext {
  return {
    now: NOW,
    maxAgeS: 1_800,
    spotToleranceBps: 300,
    oracleSpot: SPOT,
    ticker: 'NVDA',
    underlying: NVDA,
    strike: 222_500_000n,
    expiry: NOW + 3 * 86_400,
    type: 'call',
    uiMultiplier: null,
    ...over,
  };
}

function priced(over: Partial<Extract<FairAnswer, { ok: true }>> = {}): FairAnswer {
  return { ok: true, fair: 2_000_000n, source: 'cboe', asOf: NOW - 60, spot: SPOT, ...over };
}

test('spotGapBps: 300 bps of the oracle is 300, 301 is 301', () => {
  assert.equal(spotGapBps(SPOT + (SPOT * 300n) / 10_000n, SPOT), 300n);
  assert.equal(spotGapBps(SPOT + (SPOT * 301n) / 10_000n, SPOT), 301n);
});

test('legacy /fair: a fresh asOf and matching spot is usable; fair 0 is a price, not unavailable', () => {
  assert.deepEqual(qualifyFair(priced(), ctx()), { ok: true, fair: 2_000_000n, source: 'cboe' });
  assert.deepEqual(qualifyFair(priced({ fair: 0n }), ctx()), { ok: true, fair: 0n, source: 'cboe' });
});

test('legacy /fair: unknown and stale asOf refuse; a refetch of the same asOf stays stale', () => {
  assert.equal(qualifyFair(priced({ asOf: null }), ctx()).ok, false);
  assert.equal((qualifyFair(priced({ asOf: null }), ctx()) as { reason: string }).reason, 'asOf-unknown');
  const stale = qualifyFair(priced({ asOf: NOW - 1_801 }), ctx());
  assert.equal(stale.ok, false);
  assert.equal((stale as { reason: string }).reason, 'fair-stale');
  assert.equal((qualifyFair(priced({ asOf: NOW - 1_800 }), ctx()) as { ok: true }).ok, true, 'age == maxAgeS is accepted');
  const later = qualifyFair(priced({ asOf: NOW - 1_801 }), ctx({ now: NOW + 3_600 }));
  assert.equal((later as { reason: string }).reason, 'fair-stale', 'the same observation is still stale after a refetch clock');
});

test('legacy /fair: 300 bps spot gap is accepted, 301 is refused', () => {
  const at300 = SPOT + (SPOT * 300n) / 10_000n;
  const at301 = SPOT + (SPOT * 301n) / 10_000n;
  assert.equal(qualifyFair(priced({ spot: at300 }), ctx()).ok, true);
  const miss = qualifyFair(priced({ spot: at301 }), ctx());
  assert.equal(miss.ok, false);
  assert.equal((miss as { reason: string }).reason, 'fair-spot-mismatch');
});

test('HTTP/null fair stays fair-unavailable', () => {
  assert.deepEqual(qualifyFair({ ok: false, reason: 'chain-stale' }, ctx()), { ok: false, reason: 'fair-unavailable', detail: 'chain-stale' });
});

test('optional provenance: quote age from quoteObservedAt, not asOf; frozen underlying last-trade with a fresh quote is usable', () => {
  const frozenAsOf = NOW - 86_400;
  const answer = priced({
    asOf: frozenAsOf,
    provenance: {
      quality: { readiness: 'ready', reasons: [] },
      clocks: { quoteObservedAt: NOW - 30, underlyingObservedAt: frozenAsOf },
      identity: { market: 'NVDA', token: { address: NVDA }, option: { side: 'call', strike: 222_500_000n, expiry: NOW + 3 * 86_400 } },
    },
  });
  assert.equal(qualifyFair(answer, ctx()).ok, true);
});

test('optional provenance: unknown quote time, unknown reason codes, degraded readiness, identity mismatch refuse', () => {
  const noQuote = priced({
    provenance: { quality: { readiness: 'ready', reasons: [] }, clocks: { quoteObservedAt: null } },
  });
  assert.equal((qualifyFair(noQuote, ctx()) as { reason: string }).reason, 'quote-age-unknown');

  const unknown = priced({
    provenance: { quality: { readiness: 'ready', reasons: ['vendor-xyz'] }, clocks: { quoteObservedAt: NOW } },
  });
  assert.equal((qualifyFair(unknown, ctx()) as { reason: string }).reason, 'not-ready');

  const degraded = priced({
    provenance: { quality: { readiness: 'degraded', reasons: ['quote-age-unknown'] }, clocks: { quoteObservedAt: null } },
  });
  assert.equal((qualifyFair(degraded, ctx()) as { reason: string }).reason, 'quote-age-unknown');

  const identity = priced({
    provenance: {
      quality: { readiness: 'ready', reasons: [] },
      clocks: { quoteObservedAt: NOW },
      identity: { market: 'AAPL' },
    },
  });
  assert.equal((qualifyFair(identity, ctx()) as { reason: string }).reason, 'identity-mismatch');
});

test('provenance is not required: a body without it still qualifies on asOf and spot', () => {
  const { provenance: _drop, ...legacy } = priced() as Extract<FairAnswer, { ok: true }> & { provenance?: unknown };
  assert.equal(qualifyFair(legacy, ctx()).ok, true);
});

/* The market maker's event rule (mm/engine.ts eventUncertaintyOf), applied to the top-level quality block. */

test('each of the MM\'s halt reasons refuses the re-price as event-uncertainty, naming the flag', () => {
  // Named here, not read from EVENT_HALT_REASONS: dropping one from the shared list must turn this test red.
  for (const flag of ['event-uncertainty', 'model-uncertainty', 'model-uncertain']) {
    const gate = qualifyFair(priced({ quality: { reasons: [flag] } }), ctx());
    assert.equal(gate.ok, false, flag);
    assert.equal((gate as { reason: string }).reason, 'event-uncertainty', flag);
    assert.match((gate as { detail: string }).detail, new RegExp(`pricing flagged ${flag}\\b`), flag);
  }
  // Beside a reason that does not refuse on its own, the halt reason still refuses.
  const mixed = qualifyFair(priced({ quality: { reasons: ['book-one-sided', 'model-uncertainty'] } }), ctx());
  assert.equal((mixed as { reason: string }).reason, 'event-uncertainty');
});

test('an event inside the series window refuses, even with no quality reason', () => {
  const gate = qualifyFair(priced({ quality: { reasons: [], eventInWindow: true, eventInput: 'supplied' } }), ctx());
  assert.deepEqual(gate, { ok: false, reason: 'event-uncertainty', detail: 'pricing: an event sits inside the series window (event calendar: supplied)' });
});

test('extrapolated, one-sided, quote-age-unknown and a missing or short event calendar do NOT refuse on their own', () => {
  const pass: Array<Extract<FairAnswer, { ok: true }>['quality']> = [
    { reasons: ['extrapolated'] },
    { reasons: ['book-one-sided'] },
    { reasons: ['quote-age-unknown'] },
    { reasons: ['extrapolated', 'book-one-sided', 'quote-age-unknown', 'identity-unmapped'] },
    { reasons: [], eventInWindow: false, eventInput: 'missing' },
    { reasons: ['extrapolated'], eventInWindow: false, eventInput: 'short' },
    { reasons: [] },
  ];
  for (const quality of pass) {
    assert.deepEqual(qualifyFair(priced({ quality }), ctx()), { ok: true, fair: 2_000_000n, source: 'cboe' }, JSON.stringify(quality));
  }
});

test('with a quality block, the asOf freshness and spot-mismatch rules still apply; without one, nothing changes', () => {
  const clean = { reasons: ['extrapolated'], eventInWindow: false, eventInput: 'missing' as const };
  assert.equal((qualifyFair(priced({ quality: clean, asOf: NOW - 1_801 }), ctx()) as { reason: string }).reason, 'fair-stale');
  assert.equal((qualifyFair(priced({ quality: clean, asOf: null }), ctx()) as { reason: string }).reason, 'asOf-unknown');
  assert.equal((qualifyFair(priced({ quality: clean, spot: SPOT + (SPOT * 301n) / 10_000n }), ctx()) as { reason: string }).reason, 'fair-spot-mismatch');
  assert.deepEqual(qualifyFair(priced(), ctx()), { ok: true, fair: 2_000_000n, source: 'cboe' });
});

test('end to end, the pricing service\'s real body: a degraded-but-not-halting answer re-prices, an event-day one does not', () => {
  const body = (reasons: string[], inWindow: boolean) =>
    fairResponse({
      ok: true, fairUsdg6: 2_000_000n, iv: 0.31, delta: 0.18, source: 'model', method: 'listed-contract', days: ['2026-09-18'], spotUsdg6: SPOT, asOf: NOW - 60,
      provenance: { quality: { readiness: 'degraded', reasons, uncertainty: null, disagreement: null, fallback: null } },
      event: { input: 'supplied', inWindow, events: [] },
    }).body;
  assert.deepEqual(qualifyFair(parseFairBody(200, body(['extrapolated', 'book-one-sided'], false)), ctx()), { ok: true, fair: 2_000_000n, source: 'model' });
  assert.equal((qualifyFair(parseFairBody(200, body([], true)), ctx()) as { reason: string }).reason, 'event-uncertainty');
  assert.equal((qualifyFair(parseFairBody(200, body(['model-uncertainty'], false)), ctx()) as { reason: string }).reason, 'event-uncertainty');
});
