/**
 * earn/plan.ts: the EarnVault venue keeper's decisions, against a vault described by its reads.
 * Every refusal the planner makes has its own case: adapter 0, an open position, an open queue.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planEarn, queueOpen, unescrowedOf, walletBuffer, type EarnKnobs, type EarnState } from './plan.js';

const USDG = (n: number) => BigInt(Math.round(n * 1e6));

const knobs = (over: Partial<EarnKnobs> = {}): EarnKnobs => ({
  bufferUsdg6: 0n,
  bufferBps: 0,
  maxMoveUsdg6: USDG(100_000),
  dustUsdg6: USDG(1),
  queueBatch: 10,
  skimIntervalS: 86_400,
  ...over,
});

// An idle vault with an adapter, no queue (head 1 > tail 0, the constructor's empty state) and no position.
const state = (over: Partial<EarnState> = {}): EarnState => ({
  adapter: '0x00000000000000000000000000000000000000ad',
  hasOpenPosition: false,
  venueUnreadable: false,
  queueHead: 1n,
  queueTail: 0n,
  wallet: USDG(5_000),
  escrowed: 0n,
  deferred: 0n,
  totalAssets: USDG(5_000),
  venueWithdrawable: 0n,
  now: 1_800_000_000,
  lastSkimAt: 1_800_000_000,
  ...over,
});

const kinds = (s: EarnState, k = knobs()) => planEarn(s, k).actions.map((a) => a.kind);

test('the queue rule is the contract one: empty when head > tail', () => {
  assert.equal(queueOpen(1n, 0n), false);
  assert.equal(queueOpen(3n, 3n), true);
  assert.equal(queueOpen(3n, 7n), true);
  assert.equal(queueOpen(8n, 7n), false);
});

test('adapter 0: nothing at all, and says why', () => {
  const p = planEarn(state({ adapter: null, wallet: USDG(1_000_000) }), knobs());
  assert.deepEqual(p.actions, []);
  assert.equal(p.skipped, 'no-adapter');
});

test('an open position: never sweep, never serve, with or without a queue', () => {
  for (const tail of [0n, 5n]) {
    const p = planEarn(state({ hasOpenPosition: true, queueTail: tail, wallet: USDG(50_000), venueWithdrawable: USDG(50_000) }), knobs());
    assert.deepEqual(p.actions, [], `tail ${tail}`);
    assert.equal(p.skipped, 'open-position');
  }
});

test('an open queue: NEVER sweep, even with idle cash far above the buffer; pull then processQueue', () => {
  const p = planEarn(state({ queueHead: 2n, queueTail: 4n, wallet: USDG(900_000), venueWithdrawable: USDG(30_000) }), knobs());
  assert.equal(p.queueOpen, true);
  assert.ok(!p.actions.some((a) => a.kind === 'sweep'), 'a sweep while a queue is open is forbidden');
  assert.deepEqual(p.actions, [
    { kind: 'pull', amount: USDG(30_000), reason: 'queue' },
    { kind: 'processQueue', maxEntries: 10 },
  ]);
});

test('an open queue with nothing in the venue still calls processQueue, and never skims', () => {
  const p = planEarn(state({ queueHead: 2n, queueTail: 2n, venueWithdrawable: 0n, lastSkimAt: null }), knobs());
  assert.deepEqual(kinds(state({ queueHead: 2n, queueTail: 2n, venueWithdrawable: 0n, lastSkimAt: null })), ['processQueue']);
  assert.equal(p.skipped, null);
});

test('the queue pull is bounded per tick', () => {
  const p = planEarn(state({ queueHead: 1n, queueTail: 1n, venueWithdrawable: USDG(10_000_000) }), knobs());
  assert.deepEqual(p.actions[0], { kind: 'pull', amount: USDG(100_000), reason: 'queue' });
});

test('default knobs (no buffer): every idle USDG is swept, up to the per-tick cap', () => {
  assert.deepEqual(planEarn(state({ wallet: USDG(5_000) }), knobs()).actions, [{ kind: 'sweep', amount: USDG(5_000) }]);
  assert.deepEqual(planEarn(state({ wallet: USDG(250_000) }), knobs()).actions, [{ kind: 'sweep', amount: USDG(100_000) }]);
});

test('escrowed deposits are never counted as sweepable', () => {
  const p = planEarn(state({ wallet: USDG(5_000), escrowed: USDG(4_000) }), knobs());
  assert.equal(p.unescrowed, USDG(1_000));
  assert.deepEqual(p.actions, [{ kind: 'sweep', amount: USDG(1_000) }]);
  assert.deepEqual(planEarn(state({ wallet: USDG(5_000), escrowed: USDG(6_000) }), knobs()).actions, [], 'a wallet below its escrow sweeps nothing');
});

// v9's EarnVault holds a queue payment the asset refused in its wallet for claimDeferred, and
// `_unescrowed()` = wallet - (escrowedAssets + deferredAssets). A sweep of the wallet minus escrow alone would plan to
// move money owed to those receivers, and `sweepToVenue` clamps it away or reverts BadUnits when it is all of the idle.
test('deferred payments are never counted as sweepable: they shrink the sweep', () => {
  const p = planEarn(state({ wallet: USDG(5_000), escrowed: USDG(1_000), deferred: USDG(1_500) }), knobs());
  assert.equal(p.unescrowed, USDG(2_500));
  assert.deepEqual(p.actions, [{ kind: 'sweep', amount: USDG(2_500) }]);
});

test('deferred payments that are all of the idle plan no sweep (the tick that reverted BadUnits every time)', () => {
  const exact = planEarn(state({ wallet: USDG(5_000), escrowed: USDG(1_000), deferred: USDG(4_000) }), knobs());
  assert.equal(exact.unescrowed, 0n);
  assert.deepEqual(exact.actions, []);
  assert.equal(exact.skipped, null);
  const over = planEarn(state({ wallet: USDG(5_000), deferred: USDG(9_000) }), knobs());
  assert.equal(over.unescrowed, 0n, 'saturating, as _deliverable is');
  assert.deepEqual(over.actions, []);
});

test('the buffer is the vault\'s own cash: deferred payments neither fill it nor count as excess', () => {
  const k = knobs({ bufferUsdg6: USDG(10_000) });
  // 30k wallet, 10k deferred: 20k of it is the vault's, 10k above the buffer.
  assert.deepEqual(planEarn(state({ wallet: USDG(30_000), deferred: USDG(10_000), totalAssets: USDG(1_000_000) }), k).actions, [
    { kind: 'sweep', amount: USDG(10_000) },
  ]);
  // 12k wallet, 5k deferred: 7k of it is the vault's, 3k under the buffer.
  const low = state({ wallet: USDG(12_000), deferred: USDG(5_000), totalAssets: USDG(1_000_000), venueWithdrawable: USDG(900_000) });
  assert.deepEqual(planEarn(low, k).actions, [{ kind: 'pull', amount: USDG(3_000), reason: 'buffer' }]);
  // The percentage buffer reads totalAssets() as reported: the contract already nets deferred out of it.
  const pct = knobs({ bufferBps: 100 });
  assert.equal(planEarn(state({ wallet: USDG(30_000), deferred: USDG(10_000), totalAssets: USDG(1_000_000) }), pct).buffer, USDG(10_000));
});

test('a failed deferredAssets() read skips and never sweeps or pulls for the buffer; it is never read as 0', () => {
  const p = planEarn(state({ wallet: USDG(900_000), deferred: null, lastSkimAt: null }), knobs());
  assert.deepEqual(p.actions, []);
  assert.equal(p.skipped, 'deferred-unreadable');
  assert.equal(p.unescrowed, null);
  const buffered = planEarn(state({ wallet: 0n, deferred: null, totalAssets: USDG(1_000_000), venueWithdrawable: USDG(900_000) }), knobs({ bufferUsdg6: USDG(10_000) }));
  assert.deepEqual(buffered.actions, [], 'no buffer pull from an unknown wallet either');
  assert.equal(unescrowedOf({ wallet: USDG(5), escrowed: 0n, deferred: null }), null);
});

test('with deferredAssets() unreadable, adapter 0 and an open position keep their own skip, and an open queue is still served', () => {
  assert.equal(planEarn(state({ adapter: null, deferred: null }), knobs()).skipped, 'no-adapter');
  assert.equal(planEarn(state({ hasOpenPosition: true, deferred: null }), knobs()).skipped, 'open-position');
  const q = planEarn(state({ queueHead: 2n, queueTail: 4n, deferred: null, venueWithdrawable: USDG(30_000) }), knobs());
  assert.equal(q.skipped, null);
  assert.deepEqual(q.actions, [
    { kind: 'pull', amount: USDG(30_000), reason: 'queue' },
    { kind: 'processQueue', maxEntries: 10 },
  ]);
});

test('the buffer is the larger of the fixed amount and the percentage of totalAssets', () => {
  assert.equal(walletBuffer(USDG(1_000_000), { bufferUsdg6: USDG(20_000), bufferBps: 100 }), USDG(20_000));
  assert.equal(walletBuffer(USDG(1_000_000), { bufferUsdg6: USDG(5_000), bufferBps: 100 }), USDG(10_000));
  assert.equal(walletBuffer(USDG(1_000_000), { bufferUsdg6: 0n, bufferBps: 0 }), 0n);
});

test('with a buffer: sweep only the excess above it', () => {
  const p = planEarn(state({ wallet: USDG(30_000), totalAssets: USDG(1_000_000) }), knobs({ bufferUsdg6: USDG(10_000) }));
  assert.deepEqual(p.actions, [{ kind: 'sweep', amount: USDG(20_000) }]);
});

test('with a buffer: pull back up to it when the wallet has fallen below, bounded by what the venue can give', () => {
  const k = knobs({ bufferBps: 200 }); // 2% of 1M = 20k
  const low = state({ wallet: USDG(5_000), totalAssets: USDG(1_000_000), venueWithdrawable: USDG(900_000) });
  assert.deepEqual(planEarn(low, k).actions, [{ kind: 'pull', amount: USDG(15_000), reason: 'buffer' }]);
  const frozen = state({ wallet: USDG(5_000), totalAssets: USDG(1_000_000), venueWithdrawable: USDG(3_000) });
  assert.deepEqual(planEarn(frozen, k).actions, [{ kind: 'pull', amount: USDG(3_000), reason: 'buffer' }]);
  const dead = state({ wallet: USDG(5_000), totalAssets: USDG(1_000_000), venueWithdrawable: 0n });
  assert.deepEqual(planEarn(dead, k).actions, []);
});

test('dust: a move under the threshold sends nothing', () => {
  assert.deepEqual(planEarn(state({ wallet: USDG(0.5) }), knobs()).actions, []);
  assert.deepEqual(planEarn(state({ wallet: USDG(10_000.5) }), knobs({ bufferUsdg6: USDG(10_000) })).actions, []);
});

test('skim runs once per interval, only with no queue open', () => {
  const now = 1_800_000_000;
  assert.ok(kinds(state({ wallet: 0n, lastSkimAt: null })).includes('skim'), 'never skimmed: skim now');
  assert.ok(!kinds(state({ wallet: 0n, lastSkimAt: now - 3_600 })).includes('skim'), 'an hour ago: not yet');
  assert.ok(kinds(state({ wallet: 0n, lastSkimAt: now - 86_400 })).includes('skim'), 'a day ago: due');
  assert.ok(!kinds(state({ wallet: 0n, queueTail: 1n, lastSkimAt: null })).includes('skim'), 'a queue is open: skim would take nothing');
});

test('sweep comes before skim in the same tick', () => {
  assert.deepEqual(kinds(state({ wallet: USDG(5_000), lastSkimAt: null })), ['sweep', 'skim']);
});

test('a venue the vault cannot read gets nothing, queue or not: no sweep into it, no pull, no processQueue, no skim', () => {
  const idle = planEarn(state({ venueUnreadable: true, wallet: USDG(1_000_000), lastSkimAt: null }), knobs());
  assert.deepEqual(idle.actions, [], 'without the rule this sweeps and skims');
  assert.equal(idle.skipped, 'venue-unreadable');
  const queued = planEarn(state({ venueUnreadable: true, queueHead: 3n, queueTail: 5n, venueWithdrawable: USDG(700) }), knobs());
  assert.deepEqual(queued.actions, [], 'without the rule this pulls and sends processQueue, which serves nothing');
  assert.equal(queued.skipped, 'venue-unreadable');
});

test('an open position is still the reason named when both hold', () => {
  assert.equal(planEarn(state({ venueUnreadable: true, hasOpenPosition: true }), knobs()).skipped, 'open-position');
});
