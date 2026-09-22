/**
 * K3-301 qualification of a /fair answer: source age, unknown times, optional provenance, spot gap.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress } from 'viem';
import type { FairAnswer } from './fair-client.js';
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
