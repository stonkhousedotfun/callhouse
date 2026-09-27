/**
 * devnet-reprice-check.ts: how the --pricing-url (REAL) devnet run judges one pricer tick, offline.
 *
 * WHAT THIS CATCHES: the harness judging a send against the fair-value target alone, or not knowing
 * 'drop-floor-above-band'. Either fails a devnet run whose pricer did exactly the right thing. The plans come from the
 * pricer's own planReprice on the devnet seed's band (30-150 bps) and the keeper's default tuning (edge 500 bps,
 * threshold 1_000 bps); the prices are literals, planner.test.ts's cases at its spot, so a planner change
 * that moves them shows up here as well.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REAL_TICK_OUTCOMES, judgeDropFloorAboveBand, judgeRepriced, unexpectedAlerts } from './devnet-reprice-check.js';
import { planReprice } from './planner.js';

const SPOT = 212_210_000n;
/** Band 3.183100 at the top (150 bps of SPOT); fair 1.500000 + 5 % = a 1.575000 target. */
const plan = (livePrice: bigint, fair = 1_500_000n) =>
  planReprice({ spot: SPOT, strategy: { minAskBps: 30, maxAskBps: 150 }, edgeBps: 500, thresholdBps: 1_000, fair, livePrice });

test('REAL outcomes: drop-floor-above-band is known; a band-ceiling step is reported as repriced, not as an outcome', () => {
  assert.ok(REAL_TICK_OUTCOMES.includes('drop-floor-above-band'));
  assert.ok(REAL_TICK_OUTCOMES.includes('repriced'));
  assert.ok(!REAL_TICK_OUTCOMES.includes('band-ceiling-step'));
});

test('judgeRepriced: a target within one step of the live ask is sent as it is, with no step floor in /state', () => {
  const p = plan(2_500_000n, 2_000_000n);
  const at = judgeRepriced(p, 2_100_000n, { target: '2100000' });
  assert.ok(at.ok, at.what);
  assert.match(at.what, /repriced to the target/);
  assert.ok(!judgeRepriced(p, 2_000_000n, { target: '2100000' }).ok, 'another price fails');
  assert.ok(!judgeRepriced(p, 2_100_000n, { target: '2100000', stepFloor: '2025000' }).ok, 'a step floor in /state for a plain send fails');
});

test('judgeRepriced: a target more than one step below the live ask passes at the step floor, not at the target', () => {
  const p = plan(3_183_100n);
  const state = { target: '2578400', stepFloor: '2578400' };
  const at = judgeRepriced(p, 2_578_400n, state);
  assert.ok(at.ok, at.what);
  assert.match(at.what, /repriced to the step floor/);
  // The target is a 50.5 % drop: reprice refuses it (RepriceDropExceeded), and the pricer no longer sends it.
  assert.ok(!judgeRepriced(p, 1_575_000n, state).ok, 'the target fails');
  assert.ok(!judgeRepriced(p, 2_578_400n, { target: '2578400' }).ok, '/state without the step floor fails');
});

test('judgeRepriced: a step floor above the band passes at the band ceiling', () => {
  const p = plan(4_000_000n);
  const state = { target: '3183100', stepFloor: '3240000', ceilingStepDropBps: '2042' };
  const at = judgeRepriced(p, 3_183_100n, state);
  assert.ok(at.ok, at.what);
  assert.match(at.what, /repriced to the band's ceiling \(a 2042 bps band-ceiling step/);
  assert.ok(!judgeRepriced(p, 1_575_000n, state).ok, 'the target fails');
  assert.ok(!judgeRepriced(p, 3_240_000n, state).ok, 'the step floor, above the band (BadPrice), fails');
  assert.ok(!judgeRepriced(p, 3_183_100n, { target: '3183100', stepFloor: '3240000' }).ok, '/state without the step\'s drop fails');
});

test('judgeRepriced: a Repriced where planReprice sends nothing fails', () => {
  assert.ok(!judgeRepriced(plan(5_000_000n), 3_183_100n, { target: '3183100' }).ok, 'drop-floor-above-band');
  assert.ok(!judgeRepriced(plan(1_600_000n), 1_575_000n, { target: '1575000' }).ok, 'within-threshold');
});

test('judgeDropFloorAboveBand: nothing sent, and /state carries the step floor and the contract floor', () => {
  const p = plan(5_000_000n);
  const state = { stepFloor: '4050000', contractFloor: '3750000' };
  const at = judgeDropFloorAboveBand(p, 0, state);
  assert.ok(at.ok, at.what);
  assert.ok(!judgeDropFloorAboveBand(p, 1, state).ok, 'a Repriced fails');
  assert.ok(!judgeDropFloorAboveBand(p, 0, { stepFloor: '4050000' }).ok, '/state without the contract floor fails');
  assert.ok(!judgeDropFloorAboveBand(plan(4_000_000n), 0, state).ok, 'a ceiling the contract accepts must go out: sending nothing fails');
});

test('unexpectedAlerts: only drop-floor-above-band\'s own v2_pricer_reprice_failed at warn is allowed', () => {
  const failedWarn = { kind: 'v2_pricer_reprice_failed', severity: 'warn' };
  const failedError = { kind: 'v2_pricer_reprice_failed', severity: 'error' };
  const others = [
    { kind: 'v2_error', severity: 'error' },
    { kind: 'v2_pricer_clamped', severity: 'warn' },
  ];
  assert.deepEqual(unexpectedAlerts('drop-floor-above-band', [failedWarn]), []);
  assert.deepEqual(unexpectedAlerts('repriced', [failedWarn]), [failedWarn]);
  assert.deepEqual(unexpectedAlerts('drop-floor-above-band', [failedError, ...others]), [failedError, ...others]);
  assert.deepEqual(unexpectedAlerts('repriced', [{ kind: 'v2_boot', severity: 'info' }]), []);
});
