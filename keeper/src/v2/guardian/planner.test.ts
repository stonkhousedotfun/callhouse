/**
 * The guardian's decision (planner.ts). Pinned: which candidates page, which are a scale fault, which are
 * vetoed, and that an ordinary disagreement never is. Prices are USDG 6 dp per share; NVDA traded near 229 USDG
 * when this was written, so 229_000000 is a real-scale print and 229_000000 x 1e8 is the mis-scale of 2026-06-22.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { agree, planGuardian, scaleApart, type GuardianThresholds, type GuardianView } from './planner.js';

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address;
const REAL = 229_000_000n;
const MIS = REAL * 100_000_000n;
const E = 1_790_193_600;
// Heartbeat 24 h + margin 30 min: the config defaults.
const STALE_AFTER = 86_400 + 1_800;
const ON: GuardianThresholds = { scaleFactor: 10, autoVeto: true, staleRoundAfterS: STALE_AFTER };
const OFF: GuardianThresholds = { scaleFactor: 10, autoVeto: false, staleRoundAfterS: STALE_AFTER };

const view = (over: Partial<GuardianView> = {}): GuardianView => ({
  underlying: NVDA,
  expiry: E,
  status: 'Pending',
  candidate: { price: REAL, sourceIndex: 0, disagreed: false, finalizableAt: E + 120 + 21_600 },
  poolPrice: REAL,
  lastFinalizedPrice: 228_000_000n,
  // An hour-old round at the expiry: a live feed.
  roundAge: 3_600,
  maxDeviationBps: 150,
  now: E + 200,
  ...over,
});

test('scaleApart: exact at the factor, either direction, never for a non-positive side', () => {
  assert.equal(scaleApart(1_000n, 100n, 10), true);
  assert.equal(scaleApart(999n, 100n, 10), false);
  assert.equal(scaleApart(100n, 1_000n, 10), true);
  assert.equal(scaleApart(100n, 999n, 10), false);
  assert.equal(scaleApart(0n, 100n, 10), false);
  assert.equal(scaleApart(100n, 0n, 10), false);
});

test('an uncorroborated candidate inside the band pages and is not vetoed', () => {
  const plan = planGuardian(view({ candidate: { price: 240_000_000n, sourceIndex: 0, disagreed: true, finalizableAt: E + 21_720 } }), ON);
  assert.equal(plan.page, true);
  assert.equal(plan.scaleFault, false);
  assert.equal(plan.veto, false);
  assert.equal(plan.reason, 'in-band');
});

test('a 1e8x candidate is a scale fault against both references, and is vetoed with the flag on', () => {
  const plan = planGuardian(view({ candidate: { price: MIS, sourceIndex: 0, disagreed: true, finalizableAt: E + 21_720 } }), ON);
  assert.equal(plan.page, true);
  assert.equal(plan.scaleFault, true);
  assert.equal(plan.veto, true);
  assert.equal(plan.late, false);
  assert.equal(plan.reason, 'scale-fault');
  assert.equal(Math.round(plan.ratios.pool!), 100_000_000);
});

test('the flag off: a scale fault pages and is not vetoed', () => {
  const plan = planGuardian(view({ candidate: { price: MIS, sourceIndex: 0, disagreed: true, finalizableAt: E + 21_720 } }), OFF);
  assert.equal(plan.scaleFault, true);
  assert.equal(plan.veto, false);
});

test('BOTH references must be 10x away: a candidate near either one is in band', () => {
  const c = { price: MIS, sourceIndex: 0, disagreed: true, finalizableAt: E + 21_720 };
  // The pool agrees with the mis-scaled print (a pool quoting the same wrong scale): not vetoed on the last price alone.
  assert.equal(planGuardian(view({ candidate: c, poolPrice: MIS / 2n }), ON).veto, false);
  // The last finalized price is near it: not vetoed on the pool alone.
  assert.equal(planGuardian(view({ candidate: c, lastFinalizedPrice: MIS }), ON).veto, false);
});

test('one reference read: it decides (the first expiries have no finalized price); none read: page, never veto', () => {
  const c = { price: MIS, sourceIndex: 0, disagreed: false, finalizableAt: E + 21_720 };
  const poolOnly = planGuardian(view({ candidate: c, lastFinalizedPrice: null }), ON);
  assert.equal(poolOnly.scaleFault, true);
  assert.equal(poolOnly.veto, true);
  const lastOnly = planGuardian(view({ candidate: c, poolPrice: null }), ON);
  assert.equal(lastOnly.veto, true);
  const neither = planGuardian(view({ candidate: c, poolPrice: null, lastFinalizedPrice: null }), ON);
  assert.equal(neither.page, true);
  assert.equal(neither.scaleFault, false);
  assert.equal(neither.veto, false);
  assert.equal(neither.reason, 'no-reference');
});

test('a scale fault past finalizableAt still vetoes (finalize has to be sent), and says it is late', () => {
  const plan = planGuardian(view({ candidate: { price: MIS, sourceIndex: 0, disagreed: true, finalizableAt: E + 100 }, now: E + 200 }), ON);
  assert.equal(plan.veto, true);
  assert.equal(plan.late, true);
});

test('nothing to do: finalized (a corroborated price finalizes at once), held, none, or no candidate', () => {
  for (const status of ['Finalized', 'Held', 'None'] as const) {
    const plan = planGuardian(view({ status, candidate: { price: MIS, sourceIndex: 0, disagreed: true, finalizableAt: E + 21_720 } }), ON);
    assert.equal(plan.page, false, status);
    assert.equal(plan.veto, false, status);
    assert.equal(plan.reason, 'not-pending', status);
  }
  const plan = planGuardian(view({ candidate: null }), ON);
  assert.equal(plan.page, false);
  assert.equal(plan.reason, 'no-candidate');
});

test('a mis-scale DOWN (1e-8x) is a scale fault too', () => {
  const plan = planGuardian(view({ candidate: { price: 2n, sourceIndex: 0, disagreed: true, finalizableAt: E + 21_720 } }), ON);
  assert.equal(plan.scaleFault, true);
  assert.equal(plan.veto, true);
});

/*//////////////////////////////////////////////////////////////
          STALE ROUND
//////////////////////////////////////////////////////////////*/

test('agree mirrors SettlementOracle._agree: (hi - lo) * 10000 <= lo * bps, exact at the edge', () => {
  assert.equal(agree(10_000n, 10_150n, 150), true);
  assert.equal(agree(10_000n, 10_151n, 150), false);
  assert.equal(agree(10_150n, 10_000n, 150), true, 'symmetric');
});

test('a stale round the pool disagrees with beyond the band is vetoed with the flag on, paged only with it off', () => {
  // The feed was down: the round in force at the expiry was 25 h old. The pool says 2 % lower (band 1.5 %).
  const v = view({ roundAge: 90_000, poolPrice: (REAL * 98n) / 100n, candidate: { price: REAL, sourceIndex: 0, disagreed: true, finalizableAt: E + 21_720 } });
  const on = planGuardian(v, ON);
  assert.equal(on.staleRound, true);
  assert.equal(on.poolDisagrees, true);
  assert.equal(on.scaleFault, false);
  assert.equal(on.veto, true);
  assert.equal(on.reason, 'stale-round');
  const off = planGuardian(v, OFF);
  assert.equal(off.staleRound, true);
  assert.equal(off.veto, false);
});

test('a stale round the pool AGREES with pages and is not vetoed (a quiet market, not a fault)', () => {
  const plan = planGuardian(view({ roundAge: 90_000, poolPrice: (REAL * 1_001n) / 1_000n }), ON);
  assert.equal(plan.staleRound, true);
  assert.equal(plan.poolDisagrees, false);
  assert.equal(plan.veto, false);
  assert.equal(plan.page, true);
});

test('a stale round with no pool price pages and is not vetoed: there is nothing to disagree', () => {
  const plan = planGuardian(view({ roundAge: 90_000, poolPrice: null }), ON);
  assert.equal(plan.staleRound, true);
  assert.equal(plan.veto, false);
});

test('the staleness edge: exactly heartbeat + margin is live, one second more is stale; unread age is never stale', () => {
  const disagreeing = { poolPrice: (REAL * 98n) / 100n };
  assert.equal(planGuardian(view({ ...disagreeing, roundAge: STALE_AFTER }), ON).staleRound, false);
  assert.equal(planGuardian(view({ ...disagreeing, roundAge: STALE_AFTER }), ON).veto, false);
  assert.equal(planGuardian(view({ ...disagreeing, roundAge: STALE_AFTER + 1 }), ON).veto, true);
  assert.equal(planGuardian(view({ ...disagreeing, roundAge: null }), ON).staleRound, false);
});

test('a fresh round the pool disagrees with is an ordinary uncorroborated candidate: paged, never vetoed', () => {
  const plan = planGuardian(view({ roundAge: 600, poolPrice: (REAL * 90n) / 100n }), ON);
  assert.equal(plan.poolDisagrees, true);
  assert.equal(plan.staleRound, false);
  assert.equal(plan.veto, false);
  assert.equal(plan.reason, 'in-band');
});

test('an UNREAD round age is not in band: reason round-unread, still paged, never stale, never vetoed', () => {
  const disagreeing = { poolPrice: (REAL * 98n) / 100n };
  const plan = planGuardian(view({ ...disagreeing, roundAge: 'unread' }), ON);
  assert.equal(plan.reason, 'round-unread');
  assert.equal(plan.page, true);
  assert.equal(plan.staleRound, false);
  assert.equal(plan.veto, false);
  // Control: null (not a Chainlink source) is the ordinary in-band candidate.
  assert.equal(planGuardian(view({ ...disagreeing, roundAge: null }), ON).reason, 'in-band');
  // A scale fault still decides on its references, whatever the round.
  assert.equal(planGuardian(view({ roundAge: 'unread', poolPrice: REAL / 20n, lastFinalizedPrice: REAL / 20n }), ON).reason, 'scale-fault');
});
