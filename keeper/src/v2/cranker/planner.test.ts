/**
 * The cranker's pure decisions (planner.ts).
 *
 * WHY THIS FILE EXISTS: every rule here fails quietly on chain. A ladder that compounds its rounding
 * drifts a strike; a finalize sent before the snapshot turns a corroborated NVDA settlement into a
 * six-hour candidate; a redeem pushed before the resale asks are pruned skips the escrowed longs; a
 * batch sized by eth_estimateGas redeems nobody under a swallowed out-of-gas; a wake-up measured on
 * the wall clock misses a ten-minute snapshot window on a lagging RPC. Each is pinned below with the
 * numbers worked by hand in the comments.
 *
 * DELIBERATELY ABSENT: any chain. steps.ts gathers views; ops/devnet (v2:devnet-cycle) drives them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAS } from './constants.js';
import {
  ceilDiv,
  chunkByGas,
  chunkCreates,
  expiryKeyString,
  inStrikeBand,
  isDeadOrder,
  ladderSearchStart,
  ladderSlots,
  ladderStrikes,
  planExpiry,
  planLadder,
  planPinGroup,
  planRoll,
  planStale,
  overtaken,
  pinGasOf,
  pinGroupKey,
  prunableOrders,
  redeemGasOf,
  roundDownToTick,
  roundUpToTick,
  scheduleWake,
  selectExpiries,
  selectRedeemable,
  splitChunk,
  sweepDue,
  upcomingLadderExpiries,
  type ExpiryView,
  type OrderView,
  type SeriesView,
} from './planner.js';

const M = 1_000_000n; // 1 USDG
const WEEKLY = { rungs: 5, firstOtmBps: 200, stepBps: 200 };
const DAILY = { rungs: 5, firstOtmBps: 100, stepBps: 100 };
const T = { noSourceAlertS: 3_600, pendingStuckS: 1_800 };

/*//////////////////////////////////////////////////////////////
                              MATH
//////////////////////////////////////////////////////////////*/

test('ceilDiv and tick rounding; the createSeries band is inclusive and integer-divided like the contract', () => {
  assert.equal(ceilDiv(10n, 3n), 4n);
  assert.equal(ceilDiv(9n, 3n), 3n);
  assert.equal(ceilDiv(0n, 3n), 0n);
  assert.equal(roundUpToTick(102_000_001n, M), 103n * M);
  assert.equal(roundUpToTick(102n * M, M), 102n * M);
  assert.equal(roundDownToTick(97_999_999n, M), 97n * M);
  assert.equal(inStrikeBand(50n * M, 100n * M), true);
  assert.equal(inStrikeBand(200n * M, 100n * M), true);
  assert.equal(inStrikeBand(200n * M + 1n, 100n * M), false);
  assert.equal(inStrikeBand(0n, 100n * M), false);
  // spot / 2 floors: spot 101 base units → band starts at 50
  assert.equal(inStrikeBand(50n, 101n), true);
});

/*//////////////////////////////////////////////////////////////
                             LADDERS
//////////////////////////////////////////////////////////////*/

test('ladderStrikes calls: rung 0 = roundUp(spot × 1.02), then × 1.02 on the UNROUNDED value, each rounded up', () => {
  // spot 100: 102 → 104.04 → 106.1208 → 108.243216 → 110.40808032, rounded up to 1 USDG.
  // Additive steps would give 102, 104, 106, 108, 110; compounding on rounded rungs would give 102, 105, 108, 111, 114.
  assert.deepEqual(ladderStrikes(100n * M, WEEKLY, M, false), [102n * M, 105n * M, 107n * M, 109n * M, 111n * M]);
  // NVDA on the devnet: spot 216.466061, tick 2.50 → 220.795382… → 222.50, 225.211…→227.50, 229.715…→230, 234.309…→235, 238.996…→240
  assert.deepEqual(ladderStrikes(216_466_061n, WEEKLY, 2_500_000n, false), [222_500_000n, 227_500_000n, 230_000_000n, 235_000_000n, 240_000_000n]);
});

test('ladderStrikes puts: mirrored below spot, × 0.98 on the unrounded value, rounded down', () => {
  // 98 → 96.04 → 94.1192 → 92.236816 → 90.39207968
  assert.deepEqual(ladderStrikes(100n * M, WEEKLY, M, true), [98n * M, 96n * M, 94n * M, 92n * M, 90n * M]);
});

test('ladderStrikes: a coarse tick never maps two rungs onto one strike; the band and a zero spot end the ladder', () => {
  // daily 1 %: 101, 102.01, 103.03… all round up to 105 with a 5 USDG tick: each later rung moves a tick out.
  assert.deepEqual(ladderStrikes(100n * M, DAILY, 5n * M, false), [105n * M, 110n * M, 115n * M, 120n * M, 125n * M]);
  assert.deepEqual(ladderStrikes(100n * M, DAILY, 5n * M, true), [95n * M, 90n * M, 85n * M, 80n * M, 75n * M]);
  // 50 % steps: 150 is inside [50, 200], 225 is not; puts: 50 is the band's floor, 25 is below it.
  assert.deepEqual(ladderStrikes(100n * M, { rungs: 5, firstOtmBps: 5_000, stepBps: 5_000 }, M, false), [150n * M]);
  assert.deepEqual(ladderStrikes(100n * M, { rungs: 5, firstOtmBps: 5_000, stepBps: 5_000 }, M, true), [50n * M]);
  assert.deepEqual(ladderStrikes(0n, WEEKLY, M, false), []);
  assert.deepEqual(ladderStrikes(100n * M, { rungs: 0, firstOtmBps: 200, stepBps: 200 }, M, false), []);
});

test('planLadder: the first ladder at spot, minus what exists; anchored at spot', () => {
  const fresh = planLadder({ spot: 100n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: [], anchor: null });
  assert.deepEqual(fresh, { create: [102n * M, 105n * M, 107n * M, 109n * M, 111n * M], anchor: 100n * M, reason: 'initial', otm: 5 });

  // The seed (or anyone) already made two rungs and an unrelated strike: only the three missing ones.
  const partial = planLadder({ spot: 100n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: [105n * M, 111n * M, 150n * M], anchor: null });
  assert.deepEqual(partial.create, [102n * M, 107n * M, 109n * M]);
  assert.equal(partial.reason, 'initial');

  const nothing = planLadder({ spot: 100n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: [102n * M, 105n * M, 107n * M, 109n * M, 111n * M], anchor: null });
  assert.deepEqual(nothing.create, []);
  assert.equal(nothing.reason, 'ok');
});

test('planLadder: an anchored ladder a crash left half-made is completed at its ANCHOR, not re-centred on a small move', () => {
  const plan = planLadder({ spot: 101n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: [102n * M, 105n * M], anchor: 100n * M });
  assert.deepEqual(plan.create, [107n * M, 109n * M, 111n * M]);
  assert.equal(plan.reason, 'complete');
  assert.equal(plan.anchor, 100n * M);
});

test('planLadder: re-centre only when fewer than two rungs are OTM; add, never delete; a fall adds nothing', () => {
  const ladder100 = [102n * M, 105n * M, 107n * M, 109n * M, 111n * M];
  // spot 106: 107, 109, 111 are OTM (3 ≥ 2): nothing.
  const up = planLadder({ spot: 106n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: ladder100, anchor: 100n * M });
  assert.deepEqual({ create: up.create, reason: up.reason, anchor: up.anchor, otm: up.otm }, { create: [], reason: 'ok', anchor: 100n * M, otm: 3 });
  // spot 109.5: only 111 is OTM → a ladder at 109.5 (111.69→112, 113.9…→114, 116.2…→117, 118.5…→119, 120.9…→121) is added.
  const rally = planLadder({ spot: 109_500_000n, ladder: WEEKLY, strikeTick: M, isPut: false, existing: ladder100, anchor: 100n * M });
  assert.equal(rally.reason, 'recentre');
  assert.equal(rally.anchor, 109_500_000n);
  assert.deepEqual(rally.create, [112n * M, 114n * M, 117n * M, 119n * M, 121n * M]);
  // exactly at a rung is not OTM: spot 109 leaves only 111 → recentre (the rung at 111 exists and is not re-created)
  const atRung = planLadder({ spot: 109n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: ladder100, anchor: 100n * M });
  assert.equal(atRung.reason, 'recentre');
  assert.ok(!atRung.create.includes(111n * M));
  // a fall makes every rung more OTM: nothing, and no rung is ever proposed for deletion
  const fall = planLadder({ spot: 90n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: ladder100, anchor: 100n * M });
  assert.deepEqual(fall.create, []);
});

test('planLadder puts: OTM is below spot; a fall towards the rungs re-centres downwards', () => {
  const puts100 = [98n * M, 96n * M, 94n * M, 92n * M, 90n * M];
  assert.equal(planLadder({ spot: 93n * M, ladder: WEEKLY, strikeTick: M, isPut: true, existing: puts100, anchor: 100n * M }).reason, 'ok'); // 92, 90
  const fall = planLadder({ spot: 91n * M, ladder: WEEKLY, strikeTick: M, isPut: true, existing: puts100, anchor: 100n * M });
  assert.equal(fall.reason, 'recentre');
  // 91 × 0.98 = 89.18 → 89; × 0.98 = 87.3964 → 87; 85.648… → 85; 83.935… → 83; 82.256… → 82
  assert.deepEqual(fall.create, [82n * M, 83n * M, 85n * M, 87n * M, 89n * M]);
});

test('planLadder: an anchored rung outside today\'s createSeries band is never proposed, and does not count as a rung', () => {
  // Anchored at 400 (rungs 408…442), spot collapsed to 150: the band is [75, 300], so none of them can exist; the
  // ladder re-centres at 150: 153, 156.06→157, 159.18…→160, 162.36…→163, 165.61…→166.
  const plan = planLadder({ spot: 150n * M, ladder: WEEKLY, strikeTick: M, isPut: false, existing: [], anchor: 400n * M });
  assert.equal(plan.reason, 'recentre');
  assert.deepEqual(plan.create, [153n * M, 157n * M, 160n * M, 163n * M, 166n * M]);
});

test('ladderSearchStart: MIN_SERIES_LEAD plus a margin, so a create is not refused BadExpiry when mined', () => {
  assert.equal(ladderSearchStart(1_000), 1_000 + 3_600 + 300);
});

test('upcomingLadderExpiries: nextExpiry from ladderSearchStart, each after the previous; a rejected read ends the list there', async () => {
  const asked: Array<[number, boolean]> = [];
  const next = async (after: number, weekly: boolean) => {
    asked.push([after, weekly]);
    if (after >= 20_000) throw new Error('NoExpiry');
    return after + 10_000;
  };
  assert.deepEqual(await upcomingLadderExpiries(1_000, false, 3, next), [14_900, 24_900]);
  assert.deepEqual(asked, [[4_900, false], [14_900, false], [24_900, false]], 'from now + 3_600 + 300, then after each answer; the rejection stops it');
  asked.length = 0;
  assert.deepEqual(await upcomingLadderExpiries(1_000, true, 1, next), [14_900], 'count reached: no further read');
  assert.deepEqual(asked, [[4_900, true]]);
  assert.deepEqual(await upcomingLadderExpiries(1_000, true, 0, next), [], 'count 0 reads nothing');
});

test('ladderSlots: the first expiriesAhead expiries of each tenor, weekly then daily; puts only for a market with puts; 0 switches a tenor off', () => {
  const expiries = { weekly: [700, 1_400, 2_100], daily: [100, 200, 300, 400] };
  const slots = (weekly: number, daily: number, puts: boolean) =>
    ladderSlots({ expiriesAhead: { weekly, daily } }, puts, expiries).map((s) => `${s.tenor}:${s.expiry}:${s.isPut ? 'P' : 'C'}`);
  assert.deepEqual(slots(2, 3, false), ['weekly:700:C', 'weekly:1400:C', 'daily:100:C', 'daily:200:C', 'daily:300:C']);
  assert.deepEqual(slots(1, 1, true), ['weekly:700:C', 'weekly:700:P', 'daily:100:C', 'daily:100:P']);
  assert.deepEqual(slots(2, 0, false), ['weekly:700:C', 'weekly:1400:C'], 'no dailies when the registry turns them off');
  assert.deepEqual(slots(5, 9, false).length, 7, 'never more than the calendar gave');
});

/*//////////////////////////////////////////////////////////////
                       SERIES CREATION (PINS)
//////////////////////////////////////////////////////////////*/

// INTERFACE_VERSION 6: the first series of an expiry pins the oracle's copy and each source. callhouse-contracts
// docs/V2-GAS.md (mock fixture): 343,875 on two sources, 162,168 for the next series. The devnet (v2:devnet-cycle,
// eth_estimateGas on the real feed and pool): NVDA (two sources) 352,638 and 170,919; TSLA (one source) 269,965.
const FIRST_SERIES_TWO_SOURCES = 352_638n;
const FIRST_SERIES_ONE_SOURCE = 269_965n;
const LATER_SERIES = 170_919n;

test('pinGasOf: a lone first series of an expiry is budgeted above its measured cost with margin; the old 250k + 60k was not', () => {
  // Before v6 a batch of one first series had 60k + 250k = 310k: under 343,875, so the pin ran out of gas and the
  // create reverted (pinning fails closed).
  assert.ok(GAS.createSeriesBase + GAS.createSeriesEach < FIRST_SERIES_TWO_SOURCES, 'the pre-v6 budget starves a lone first series');
  const lone = GAS.createSeriesBase + GAS.createSeriesEach + pinGasOf(2);
  assert.ok(lone * 100n >= FIRST_SERIES_TWO_SOURCES * 140n, `two sources: ${lone} leaves at least 40 % over ${FIRST_SERIES_TWO_SOURCES}`);
  assert.ok((GAS.createSeriesEach + pinGasOf(1)) * 100n >= FIRST_SERIES_ONE_SOURCE * 140n, 'one source: at least 40 % over');
  // Per source the pool (the dearer source) measured +82,661 on the devnet: the per-source budget covers it.
  assert.ok(GAS.createSeriesPinPerSource >= FIRST_SERIES_TWO_SOURCES - FIRST_SERIES_ONE_SOURCE);
  assert.ok(GAS.createSeriesEach * 100n >= LATER_SERIES * 140n, 'a later series of a pinned expiry keeps 40 % headroom');
  // Each source adds its own pin; an unreadable count budgets the oracle's maximum.
  assert.equal(pinGasOf(3) - pinGasOf(2), GAS.createSeriesPinPerSource);
  assert.equal(pinGasOf(null), pinGasOf(8));
  assert.equal(pinGasOf(0), pinGasOf(1), 'an empty list reverts NoSource early; still budgeted as one');
});

test('planPinGroup: pinned by this Clearinghouse → create free; otherwise probe with the pin budgeted; a refusal skips until the recheck, then probes again', () => {
  const now = 1_790_000_000;
  const o = { now, recheckS: 900 };
  assert.deepEqual(planPinGroup({ key: 'g', pinnedByUs: true, sources: 2, refusedAt: null }, o), { action: 'create', pinGas: 0n });
  assert.deepEqual(planPinGroup({ key: 'g', pinnedByUs: false, sources: 2, refusedAt: null }, o), { action: 'probe', pinGas: pinGasOf(2) });
  assert.deepEqual(planPinGroup({ key: 'g', pinnedByUs: null, sources: null, refusedAt: null }, o), { action: 'probe', pinGas: pinGasOf(null) }, 'unreadable: probe, maximum budget');
  assert.deepEqual(planPinGroup({ key: 'g', pinnedByUs: false, sources: 1, refusedAt: now - 899 }, o), { action: 'skip', recheckAt: now + 1 });
  assert.deepEqual(planPinGroup({ key: 'g', pinnedByUs: false, sources: 1, refusedAt: now - 900 }, o), { action: 'probe', pinGas: pinGasOf(1) }, 'due exactly at the recheck');
  // A pinned expiry whose batch was refused (the oracle's clearinghouse pointer moved): probed, no pin gas.
  assert.deepEqual(planPinGroup({ key: 'g', pinnedByUs: true, sources: 2, refusedAt: now - 1_000 }, o), { action: 'probe', pinGas: 0n });
});

test('chunkCreates: a group\'s items stay together; its first item in each chunk carries the pin; caps as chunkByGas', () => {
  const item = (group: string, n: number) => ({ group, n });
  const pin: Record<string, bigint> = { a: 1_000n, b: 0n, c: 500n };
  // Interleaved input (a weekly and a daily ladder share an expiry): grouped in first-appearance order, stable inside.
  const items = [item('a', 1), item('b', 1), item('a', 2), item('c', 1), item('b', 2)];
  const one = chunkCreates(items, { pinGasOf: (g) => pin[g]!, eachGas: 100n, baseGas: 10n, capGas: 100_000n, maxItems: 40 });
  assert.deepEqual(one.map((c) => c.items.map((x) => `${x.group}${x.n}`)), [['a1', 'a2', 'b1', 'b2', 'c1']]);
  assert.equal(one[0]!.gas, 10n + 5n * 100n + 1_000n + 0n + 500n, 'each group\'s pin once');

  // A group split by the cap budgets its pin again in the next chunk: the second batch must not starve if the first was not mined.
  const split = chunkCreates([item('a', 1), item('a', 2), item('a', 3)], { pinGasOf: () => 1_000n, eachGas: 100n, baseGas: 10n, capGas: 1_250n, maxItems: 40 });
  assert.deepEqual(split.map((c) => [c.items.length, c.gas]), [[2, 1_210n], [1, 1_110n]]);
  assert.deepEqual(chunkCreates([item('a', 1), item('a', 2), item('a', 3)], { pinGasOf: () => 0n, eachGas: 1n, baseGas: 0n, capGas: 100n, maxItems: 2 }).map((c) => c.items.length), [2, 1]);
  // An item whose own budget exceeds the cap gets a chunk at the cap.
  assert.deepEqual(chunkCreates([item('a', 1)], { pinGasOf: () => 10_000n, eachGas: 100n, baseGas: 10n, capGas: 5_000n, maxItems: 40 }).map((c) => c.gas), [5_000n]);
  assert.deepEqual(chunkCreates([], { pinGasOf: () => 0n, eachGas: 1n, baseGas: 0n, capGas: 10n, maxItems: 1 }), []);
  assert.equal(pinGroupKey('0xAB', '0xCD', 5), '0xab:0xcd:5');
});

test('chunkCreates with the real budgets: a lone first series of a two-source expiry is sent above its measured cost', () => {
  const [chunk] = chunkCreates([{ group: 'nvda:e' }], { pinGasOf: () => pinGasOf(2), eachGas: GAS.createSeriesEach, baseGas: GAS.createSeriesBase, capGas: 8_000_000n, maxItems: 40 });
  assert.ok(chunk!.gas > FIRST_SERIES_TWO_SOURCES);
  // A ladder of 10 rungs on each of 35 markets for one new expiry: every group's first rung carries its pin.
  const ladder = Array.from({ length: 350 }, (_, i) => ({ group: `m${Math.floor(i / 10)}` }));
  const chunks = chunkCreates(ladder, { pinGasOf: () => pinGasOf(2), eachGas: GAS.createSeriesEach, baseGas: GAS.createSeriesBase, capGas: 8_000_000n, maxItems: 40 });
  for (const c of chunks) {
    const groups = new Set(c.items.map((x) => x.group)).size;
    assert.equal(c.gas, GAS.createSeriesBase + GAS.createSeriesEach * BigInt(c.items.length) + pinGasOf(2) * BigInt(groups));
    assert.ok(c.gas <= 8_000_000n);
    // The measured worst case of the chunk fits its limit.
    assert.ok(FIRST_SERIES_TWO_SOURCES * BigInt(groups) + LATER_SERIES * BigInt(c.items.length - groups) < c.gas);
  }
  assert.equal(chunks.reduce((n, c) => n + c.items.length, 0), 350);
});

/*//////////////////////////////////////////////////////////////
                            EXPIRIES
//////////////////////////////////////////////////////////////*/

const E = 1_789_761_600; // Fri 18 Sep 2026 16:00 New York
const SERIES: SeriesView = { longId: 10n, settled: false, longSupply: 350n, shortSupply: 350n, prunableOrders: 0 };

function view(overrides: Partial<ExpiryView>): ExpiryView {
  return {
    underlying: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
    expiry: E,
    now: E,
    openInterest: 350n,
    status: 'None',
    captured: false,
    candidate: null,
    sourcesKnown: true,
    sources: [
      { address: '0xchainlink', windowOk: true, recordedOk: null },
      { address: '0xpool', windowOk: false, recordedOk: null },
    ],
    pinned: true,
    series: [SERIES],
    snapshotDone: false,
    ...overrides,
  };
}

test('planExpiry before expiry: a wake-up AT expiry when there is open interest (or orders to prune), nothing else', () => {
  const before = planExpiry(view({ now: E - 30 }), T);
  assert.deepEqual({ phase: before.phase, wakeAt: before.wakeAt, snapshot: before.snapshot, finalize: before.finalize, prune: before.prune }, { phase: 'open', wakeAt: E, snapshot: false, finalize: false, prune: [] });
  assert.equal(planExpiry(view({ now: E - 30, openInterest: 0n, series: [{ ...SERIES, longSupply: 0n, shortSupply: 0n }] }), T).wakeAt, null);
});

test('planExpiry in [expiry, expiry + 120): snapshot now, wake for the first finalize; never finalize first', () => {
  const p = planExpiry(view({ now: E + 1 }), T);
  assert.equal(p.snapshot, true);
  assert.equal(p.finalize, false);
  assert.equal(p.phase, 'snapshot-window');
  assert.equal(p.wakeAt, E + 120);
});

test('planExpiry at expiry + 120 without the snapshot: the snapshot first, finalize waits (C2-04 order)', () => {
  const p = planExpiry(view({ now: E + 125 }), T);
  assert.equal(p.snapshot, true);
  assert.equal(p.finalize, false);
  assert.equal(p.phase, 'awaiting-snapshot');
});

test('planExpiry None: finalize when a source prices the window; otherwise no-source, and v2_settle_stuck after an hour', () => {
  const ok = planExpiry(view({ now: E + 130, snapshotDone: true }), T);
  assert.deepEqual({ finalize: ok.finalize, phase: ok.phase, alerts: ok.alerts }, { finalize: true, phase: 'finalizing', alerts: [] });

  const dark = view({ now: E + 130, snapshotDone: true, sources: [{ address: '0xchainlink', windowOk: false, recordedOk: null }] });
  const early = planExpiry(dark, T);
  assert.deepEqual({ finalize: early.finalize, phase: early.phase, alerts: early.alerts }, { finalize: false, phase: 'no-source', alerts: [] });
  const late = planExpiry({ ...dark, now: E + 120 + 3_600 }, T);
  assert.equal(late.alerts.length, 1);
  assert.equal(late.alerts[0]!.kind, 'v2_settle_stuck');
  assert.equal(late.alerts[0]!.once, false);
  // an oracle that does not expose its sources is finalized blind (it returns (false, 0) harmlessly)
  assert.equal(planExpiry({ ...dark, sourcesKnown: false, sources: [] }, T).finalize, true);
});

test('planExpiry after the window: a snapshot that never happened while a source still needs it is v2_snapshot_missed (once); finalize proceeds', () => {
  const p = planExpiry(view({ now: E + 601 }), T);
  assert.equal(p.snapshot, false);
  assert.equal(p.finalize, true);
  assert.deepEqual(p.alerts.map((a) => [a.kind, a.once]), [['v2_snapshot_missed', true]]);
  // every source prices the window (someone else snapshotted): nothing was missed
  const covered = planExpiry(view({ now: E + 601, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: null }, { address: '0xpool', windowOk: true, recordedOk: null }] }), T);
  assert.deepEqual(covered.alerts, []);
  // our own attempt inside the window counts, whether or not it recorded
  assert.deepEqual(planExpiry(view({ now: E + 601, snapshotDone: true }), T).alerts, []);
});

test('planExpiry Pending: wait for finalizableAt (the wake-up), finalize at it, early on a corroborating upgrade; disagreement pages once per candidate', () => {
  const candidate = { price: 216_470_000n, sourceIndex: 0, disagreed: false, finalizableAt: E + 125 + 21_600 };
  const waiting = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Pending', captured: true, candidate, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }] }), T);
  assert.deepEqual({ finalize: waiting.finalize, phase: waiting.phase, wakeAt: waiting.wakeAt, alerts: waiting.alerts }, { finalize: false, phase: 'pending', wakeAt: candidate.finalizableAt, alerts: [] });

  const due = planExpiry(view({ now: candidate.finalizableAt, snapshotDone: true, status: 'Pending', captured: true, candidate, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }] }), T);
  assert.equal(due.finalize, true);

  const upgrade = planExpiry(view({ now: E + 300, snapshotDone: true, status: 'Pending', captured: true, candidate, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }, { address: '0xpool', windowOk: true, recordedOk: false }] }), T);
  assert.equal(upgrade.finalize, true, 'a source recorded not-ok that now answers can corroborate before the delay');

  const disagreed = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Pending', captured: true, candidate: { ...candidate, disagreed: true }, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }, { address: '0xpool', windowOk: true, recordedOk: true }] }), T);
  assert.deepEqual(disagreed.alerts.map((a) => [a.kind, a.once, a.dedupeKey.endsWith(String(candidate.finalizableAt))]), [['v2_sources_disagree', true, true]]);
  assert.equal(disagreed.finalize, false);

  const stuck = planExpiry(view({ now: candidate.finalizableAt + 1_800, snapshotDone: true, status: 'Pending', captured: true, candidate, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }] }), T);
  assert.deepEqual(stuck.alerts.map((a) => a.kind), ['v2_settle_stuck']);
  assert.equal(stuck.finalize, true);
});

test('planExpiry Held: v2_settlement_held every cooldown; no finalize unless an upgrade could corroborate', () => {
  const held = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Held', captured: true, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }] }), T);
  assert.deepEqual({ phase: held.phase, finalize: held.finalize, alerts: held.alerts.map((a) => [a.kind, a.once]) }, { phase: 'held', finalize: false, alerts: [['v2_settlement_held', false]] });
  const heldUpgrade = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Held', captured: true, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }, { address: '0xpool', windowOk: true, recordedOk: false }] }), T);
  assert.equal(heldUpgrade.finalize, true);
});

test('planExpiry Pending without a candidate (unveto of a pre-emptive veto): finalize only when it can capture or advance; otherwise no-source and v2_settle_stuck', () => {
  const dark = [{ address: '0xchainlink', windowOk: false, recordedOk: null }];
  const nothing = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Pending', captured: false, candidate: null, sources: dark }), T);
  assert.deepEqual({ finalize: nothing.finalize, phase: nothing.phase, alerts: nothing.alerts }, { finalize: false, phase: 'no-source', alerts: [] }, 'finalize would return (false, 0) and change nothing');
  const late = planExpiry(view({ now: E + 120 + 3_600, snapshotDone: true, status: 'Pending', captured: false, candidate: null, sources: dark }), T);
  assert.deepEqual(late.alerts.map((a) => [a.kind, a.dedupeKey.endsWith(':no-source')]), [['v2_settle_stuck', true]]);
  assert.equal(late.finalize, false);

  const priced = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Pending', captured: false, candidate: null }), T);
  assert.equal(priced.finalize, true, 'a source prices the window: finalize captures it');
  const captured = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Pending', captured: true, candidate: null, sources: [{ address: '0xchainlink', windowOk: false, recordedOk: true }] }), T);
  assert.equal(captured.finalize, true, 'captured while held: finalize announces the candidate from the recorded prices');
  assert.equal(planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Pending', candidate: null, sourcesKnown: false, sources: [] }), T).finalize, true, 'sources unknown: blind');
});

test('planExpiry Held before any capture (a pre-emptive veto): finalize captures the window prices while a source prices it; nothing to send once captured', () => {
  // SettlementOracle.finalize runs _refresh whatever the status and _advance finalizes a corroborated price even while
  // Held: a veto blocks only the uncorroborated path. A Chainlink-only market held past its 96-round replay has
  // nothing captured and nothing ok at unveto, leaving adminResolve unbounded from E + 48 h.
  const sources = [
    { address: '0xchainlink', windowOk: true, recordedOk: null },
    { address: '0xpool', windowOk: true, recordedOk: null },
  ];
  const uncaptured = planExpiry(view({ now: E + 130, snapshotDone: true, status: 'Held', captured: false, sources }), T);
  assert.deepEqual({ phase: uncaptured.phase, finalize: uncaptured.finalize, alerts: uncaptured.alerts.map((a) => a.kind) }, { phase: 'held', finalize: true, alerts: ['v2_settlement_held'] });
  const dark = planExpiry(view({ now: E + 130, snapshotDone: true, status: 'Held', captured: false, sources: sources.map((s) => ({ ...s, windowOk: false })) }), T);
  assert.equal(dark.finalize, false, 'nothing to capture yet');
  const captured = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Held', captured: true, sources: [{ address: '0xchainlink', windowOk: true, recordedOk: true }, { address: '0xpool', windowOk: false, recordedOk: false }] }), T);
  assert.equal(captured.finalize, false, 'captured and no upgrade: finalize would change nothing');
});

test('planExpiry Finalized: settle series with long supply, prune series with open orders, redeem settled series with supply; done when none', () => {
  const s = (longId: bigint, o: Partial<SeriesView>): SeriesView => ({ ...SERIES, longId, ...o });
  const p = planExpiry(
    view({
      now: E + 400,
      status: 'Finalized',
      snapshotDone: true,
      series: [
        s(1n, {}), // unsettled with supply → settle
        s(2n, { longSupply: 0n, shortSupply: 0n }), // nothing locked → not settled, nothing to do
        s(3n, { settled: true, longSupply: 0n, shortSupply: 5n }), // shorts left → redeem
        s(4n, { settled: true, longSupply: 0n, shortSupply: 0n, prunableOrders: 2 }), // orders → prune
      ],
    }),
    T,
  );
  assert.deepEqual({ settle: p.settle, redeem: p.redeem, prune: p.prune, snapshot: p.snapshot, finalize: p.finalize, done: p.done }, { settle: [1n], redeem: [3n], prune: [4n], snapshot: false, finalize: false, done: false });
  const done = planExpiry(view({ now: E + 400, status: 'Finalized', series: [s(3n, { settled: true, longSupply: 0n, shortSupply: 0n })] }), T);
  assert.deepEqual({ phase: done.phase, done: done.done }, { phase: 'done', done: true });
});

test('planExpiry: open orders of an expired series are pruned whatever the settlement status; an empty expiry needs no oracle work', () => {
  const pending = planExpiry(view({ now: E + 200, snapshotDone: true, status: 'Pending', captured: true, candidate: { price: 1n, sourceIndex: 0, disagreed: false, finalizableAt: E + 9_999 }, series: [{ ...SERIES, prunableOrders: 3 }] }), T);
  assert.deepEqual(pending.prune, [SERIES.longId]);
  const empty = planExpiry(view({ now: E + 10, openInterest: 0n, series: [{ ...SERIES, longSupply: 0n, shortSupply: 0n, prunableOrders: 1 }] }), T);
  assert.deepEqual({ phase: empty.phase, snapshot: empty.snapshot, finalize: empty.finalize, prune: empty.prune, done: empty.done }, { phase: 'empty', snapshot: false, finalize: false, prune: [SERIES.longId], done: false });
  const emptyDone = planExpiry(view({ now: E + 10, openInterest: 0n, series: [{ ...SERIES, longSupply: 0n, shortSupply: 0n }] }), T);
  assert.equal(emptyDone.done, true);
});

/*//////////////////////////////////////////////////////////////
                           REDEMPTION
//////////////////////////////////////////////////////////////*/

test('selectRedeemable: balance, third-party permission, a payout unless burning is cheap; deduplicated, ordered by address', () => {
  const holders = [
    { holder: '0xCC00000000000000000000000000000000000003', balance: 5n, thirdPartyAllowed: true, inKind: false },
    { holder: '0xAA00000000000000000000000000000000000001', balance: 7n, thirdPartyAllowed: true, inKind: false },
    { holder: '0xaa00000000000000000000000000000000000001', balance: 7n, thirdPartyAllowed: true, inKind: false }, // same holder, other casing
    { holder: '0xBB00000000000000000000000000000000000002', balance: 0n, thirdPartyAllowed: true, inKind: false },
    { holder: '0x7bA861bC1ffC9b078dC2b74D7E83ac1E1327C5b0', balance: 150n, thirdPartyAllowed: false, inKind: false }, // the book's escrow
  ];
  const paid = selectRedeemable(holders, { perUnitPayout: 1n, burnZero: false });
  assert.deepEqual(paid.redeem.map((h) => h.holder.slice(0, 4)), ['0xAA', '0xCC']);
  assert.deepEqual({ empty: paid.empty, optedOut: paid.optedOut, zeroPayout: paid.zeroPayout }, { empty: 1, optedOut: 1, zeroPayout: 0 });
  const zero = selectRedeemable(holders, { perUnitPayout: 0n, burnZero: false });
  assert.deepEqual({ redeem: zero.redeem.length, zeroPayout: zero.zeroPayout }, { redeem: 0, zeroPayout: 2 });
  assert.equal(selectRedeemable(holders, { perUnitPayout: 0n, burnZero: true }).redeem.length, 2);
});

test('redeemGasOf: only an ITM call long converted through a set adapter budgets the swap', () => {
  const token = { isLong: true, isPut: false, perUnitPayout: 5n, adapterSet: true };
  assert.equal(redeemGasOf({ inKind: false }, token), GAS.redeemConvertEach);
  assert.equal(redeemGasOf({ inKind: true }, token), GAS.redeemInKindEach, 'opted in kind');
  assert.equal(redeemGasOf({ inKind: false }, { ...token, adapterSet: false }), GAS.redeemInKindEach);
  assert.equal(redeemGasOf({ inKind: false }, { ...token, isLong: false }), GAS.redeemInKindEach, 'shorts are paid in kind');
  assert.equal(redeemGasOf({ inKind: false }, { ...token, isPut: true }), GAS.redeemInKindEach, 'puts pay USDG natively');
  assert.equal(redeemGasOf({ inKind: false }, { ...token, perUnitPayout: 0n }), GAS.redeemInKindEach);
});

test('chunkByGas: packs in order under the cap and the item limit; an item over the cap goes alone, at the cap', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const chunks = chunkByGas(items, { gasOf: () => 100n, baseGas: 50n, capGas: 360n });
  // 50 + 3×100 = 350 ≤ 360; a fourth would be 450
  assert.deepEqual(chunks.map((c) => [c.items, c.gas]), [[[1, 2, 3], 350n], [[4, 5, 6], 350n], [[7], 150n]]);
  assert.deepEqual(chunkByGas(items, { gasOf: () => 1n, baseGas: 0n, capGas: 1_000n, maxItems: 4 }).map((c) => c.items.length), [4, 3]);
  const big = chunkByGas(['s', 'BIG', 't'], { gasOf: (x) => (x === 'BIG' ? 1_000n : 10n), baseGas: 5n, capGas: 100n });
  assert.deepEqual(big.map((c) => [c.items, c.gas]), [[['s'], 15n], [['BIG'], 100n], [['t'], 15n]]);
  assert.deepEqual(chunkByGas([], { gasOf: () => 1n, baseGas: 0n, capGas: 10n }), []);
  // the real budgets: 8M cap, in-kind 180k + 60k base → 44 holders per batch
  assert.equal(chunkByGas(Array.from({ length: 100 }, (_, i) => i), { gasOf: () => GAS.redeemInKindEach, baseGas: GAS.redeemBase, capGas: 8_000_000n })[0]!.items.length, 44);
});

test('splitChunk: halves that each keep the whole parent limit (per-item budget doubles); one item gets the cap', () => {
  assert.deepEqual(splitChunk({ items: [1, 2, 3], gas: 600n }, 8_000n), [
    { items: [1, 2], gas: 600n },
    { items: [3], gas: 600n },
  ]);
  assert.deepEqual(splitChunk({ items: [9], gas: 600n }, 8_000n), [{ items: [9], gas: 8_000n }]);
  assert.deepEqual(splitChunk({ items: [], gas: 600n }, 8_000n), []);
  assert.deepEqual(splitChunk({ items: [1, 2], gas: 9_000n }, 8_000n).map((c) => c.gas), [8_000n, 8_000n]);
});

/*//////////////////////////////////////////////////////////////
                             ORDERS
//////////////////////////////////////////////////////////////*/

const order = (id: bigint, o: Partial<OrderView>): OrderView => ({ id, maker: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', kind: 'AskWrite', units: 100n, filled: 0n, validUntil: E - 1_800, cancelled: false, ...o });

test('prunableOrders: OrderBook.prune\'s own rule, resale asks first, then bids, then write-on-fill asks', () => {
  const orders = [
    order(5n, {}),
    order(3n, { kind: 'Bid' }),
    order(30n, { kind: 'AskResale', validUntil: E }),
    order(7n, { kind: 'AskResale', validUntil: E }),
    order(8n, { cancelled: true }),
    order(9n, { filled: 100n }),
    order(10n, { maker: '0x0000000000000000000000000000000000000000' }),
    order(11n, { validUntil: E + 1 }), // still live at E
  ];
  assert.deepEqual(prunableOrders(orders, E).map((o) => o.id), [7n, 30n, 3n, 5n]);
  assert.deepEqual(prunableOrders(orders, E - 1_801).map((o) => o.id), [], 'nothing before validUntil');
  assert.equal(isDeadOrder(order(1n, { filled: 60n })), false, 'partly filled is alive');
  assert.equal(isDeadOrder(order(1n, { filled: 100n })), true);
});

/*//////////////////////////////////////////////////////////////
                         ROLLS, HOUSEKEEPING
//////////////////////////////////////////////////////////////*/

test('planRoll: one position per period; an expired one is closed out any time; a new one needs an active strategy, the session and a fresh spot', () => {
  const base = { active: true, positionLongId: 0n, positionExpiry: 0, now: E - 7_200, sessionOpen: true, spotFresh: true, sessionOpenAtGrace: true, spotUpdatedAt: E - 7_260, sessionAtSpotObservation: true };
  assert.deepEqual(planRoll(base), { roll: true, reason: 'roll' });
  assert.deepEqual(planRoll({ ...base, positionLongId: 1n, positionExpiry: E }), { roll: false, reason: 'rolled-this-period' });
  assert.deepEqual(planRoll({ ...base, positionLongId: 1n, positionExpiry: E, now: E, sessionOpen: false, spotFresh: false, active: false }), { roll: true, reason: 'close-out' });
  assert.deepEqual(planRoll({ ...base, active: false }), { roll: false, reason: 'inactive' });
  assert.deepEqual(planRoll({ ...base, sessionOpen: false }), { roll: false, reason: 'session-closed' });
  assert.deepEqual(planRoll({ ...base, spotFresh: false }), { roll: false, reason: 'spot-stale' });
});

test('planRoll: the open grace of INTERFACE_VERSION 7 — inside the first 30 min of a session, a spot observed before the open waits', () => {
  // 09:35 New York on the session day: the session is open, but it was not open a ROLL_OPEN_GRACE ago.
  const open = E - 6 * 3_600 - 25 * 60;
  const base = { active: true, positionLongId: 0n, positionExpiry: 0, now: open, sessionOpen: true, spotFresh: true, sessionOpenAtGrace: false };
  // Yesterday's close: the reading is still "fresh" under a 25 h spotMaxAge, and the open has gapped away from it.
  assert.deepEqual(planRoll({ ...base, spotUpdatedAt: open - 18 * 3_600, sessionAtSpotObservation: true }), { roll: false, reason: 'spot-before-open' });
  // A reading taken in session today: the grace is satisfied and the roll goes ahead.
  assert.deepEqual(planRoll({ ...base, spotUpdatedAt: open - 120, sessionAtSpotObservation: true }), { roll: true, reason: 'roll' });
  // Same UTC date, but the print was made before the session opened (pre-market): still refused.
  assert.deepEqual(planRoll({ ...base, spotUpdatedAt: open - 3_600, sessionAtSpotObservation: false }), { roll: false, reason: 'spot-before-open' });
  // Past the grace, the reading's own age is the oracle's business again.
  assert.deepEqual(planRoll({ ...base, sessionOpenAtGrace: true, spotUpdatedAt: open - 18 * 3_600, sessionAtSpotObservation: true }), { roll: true, reason: 'roll' });
  // The grace never blocks a close-out: an expired position is closed whenever it can be.
  assert.deepEqual(planRoll({ ...base, positionLongId: 1n, positionExpiry: open - 1, spotUpdatedAt: 0, sessionAtSpotObservation: false }), { roll: true, reason: 'close-out' });
});

test('overtaken: a call at or above its strike, a put at or below it (AutoRoller._overtaken)', () => {
  assert.equal(overtaken(false, 220_000_000n, 219_999_999n), false);
  assert.equal(overtaken(false, 220_000_000n, 220_000_000n), true, 'exactly at the strike counts');
  assert.equal(overtaken(false, 220_000_000n, 260_000_000n), true);
  assert.equal(overtaken(true, 180_000_000n, 180_000_001n), false);
  assert.equal(overtaken(true, 180_000_000n, 180_000_000n), true);
  assert.equal(overtaken(true, 180_000_000n, 100_000_000n), true);
});

test('planStale: cancelStale\'s own conditions, in its order, so only a withdrawable ask costs a simulation', () => {
  const now = E - 3 * 86_400;
  const ask = { units: 500n, filled: 0n, validUntil: now + 3_600, cancelled: false };
  const base = {
    orderId: 31n,
    positionExpiry: E,
    now,
    order: ask,
    series: { isPut: false, strike: 220_000_000n },
    spot: 225_000_000n,
    minRollUnits: 100n,
  };
  assert.deepEqual(planStale(base), { cancel: true, remaining: 500n, earnsBounty: true });
  // The bounty gate is the same as the ROLL bounty's: dust withdrawals are not worth a keeper's gas first.
  assert.deepEqual(planStale({ ...base, order: { ...ask, filled: 450n } }), { cancel: true, remaining: 50n, earnsBounty: false });

  assert.deepEqual(planStale({ ...base, orderId: 0n }), { cancel: false, reason: 'no-ask' });
  assert.deepEqual(planStale({ ...base, now: E }), { cancel: false, reason: 'period-over' });
  assert.deepEqual(planStale({ ...base, order: null }), { cancel: false, reason: 'unread' });
  assert.deepEqual(planStale({ ...base, series: null }), { cancel: false, reason: 'unread' });
  assert.deepEqual(planStale({ ...base, order: { ...ask, cancelled: true } }), { cancel: false, reason: 'order-dead' });
  assert.deepEqual(planStale({ ...base, order: { ...ask, filled: 500n } }), { cancel: false, reason: 'order-dead' });
  assert.deepEqual(planStale({ ...base, order: { ...ask, validUntil: now } }), { cancel: false, reason: 'order-dead' });
  assert.deepEqual(planStale({ ...base, spot: null }), { cancel: false, reason: 'spot-stale' }, 'no fresh spot, no withdrawal: the price must be the oracle\'s');
  assert.deepEqual(planStale({ ...base, spot: 0n }), { cancel: false, reason: 'spot-stale' });
  assert.deepEqual(planStale({ ...base, spot: 219_999_999n }), { cancel: false, reason: 'not-overtaken' }, 'one base unit short of the strike is still a live quote');
  assert.deepEqual(planStale({ ...base, spot: 220_000_000n }), { cancel: true, remaining: 500n, earnsBounty: true });
  // A put is overtaken downwards.
  const put = { ...base, series: { isPut: true, strike: 180_000_000n } };
  assert.deepEqual(planStale({ ...put, spot: 180_000_001n }), { cancel: false, reason: 'not-overtaken' });
  assert.deepEqual(planStale({ ...put, spot: 179_000_000n }), { cancel: true, remaining: 500n, earnsBounty: true });
});

test('sweepDue: accrued fees, first time or once per interval', () => {
  assert.equal(sweepDue({ accrued: 0n, lastSweepAt: null, now: 10, intervalS: 604_800 }), false);
  assert.equal(sweepDue({ accrued: 1n, lastSweepAt: null, now: 10, intervalS: 604_800 }), true);
  assert.equal(sweepDue({ accrued: 1n, lastSweepAt: 10, now: 10 + 604_799, intervalS: 604_800 }), false);
  assert.equal(sweepDue({ accrued: 1n, lastSweepAt: 10, now: 10 + 604_800, intervalS: 604_800 }), true);
});

/*//////////////////////////////////////////////////////////////
                               TIME
//////////////////////////////////////////////////////////////*/

test('scheduleWake: the earliest FUTURE target on the head clock plus the margin; none past the next poll', () => {
  assert.deepEqual(scheduleWake({ now: E - 30, targets: [null, E + 120, E, E - 40], pollIntervalMs: 60_000 }), { at: E, delayMs: 31_500 });
  assert.equal(scheduleWake({ now: E - 90, targets: [E], pollIntervalMs: 60_000 }), null, 'the poll comes first');
  assert.equal(scheduleWake({ now: E, targets: [E, E - 1, null], pollIntervalMs: 60_000 }), null, 'nothing in the future');
  assert.deepEqual(scheduleWake({ now: E - 1, targets: [E], pollIntervalMs: 60_000, marginMs: 0, minDelayMs: 2_000 }), { at: E, delayMs: 2_000 });
});

test('scheduleWake: a target that passed while the tick ran (planned from before it) wakes at once instead of waiting for the poll', () => {
  // The tick read the head at E - 10 and ran 25 s (a cold ladder): the expiry it planned for is now behind.
  assert.deepEqual(scheduleWake({ now: E + 15, plannedAt: E - 10, targets: [E, E + 120], pollIntervalMs: 60_000 }), { at: E, delayMs: 500 });
  // A target already past when the tick planned was that tick's own work: not a reason to re-run.
  assert.deepEqual(scheduleWake({ now: E + 15, plannedAt: E + 5, targets: [E, E + 120], pollIntervalMs: 200_000 }), { at: E + 120, delayMs: 106_500 });
});

test('selectExpiries: expired and not done, or inside the horizon; oldest first, deduplicated, bounded', () => {
  const k = (expiry: number, underlying = '0xu1', oracle = '0xo') => ({ oracle, underlying, expiry });
  const all = [k(E + 86_400), k(E), k(E - 86_400), k(E - 86_400), k(E - 86_400, '0xu2'), k(E + 600)];
  const done = new Set([expiryKeyString(k(E - 86_400, '0xu2'))]);
  assert.deepEqual(selectExpiries(all, done, E - 100, 900, 10).map((x) => [x.underlying, x.expiry]), [['0xu1', E - 86_400], ['0xu1', E], ['0xu1', E + 600]]);
  assert.equal(selectExpiries(all, done, E - 100, 900, 2).length, 2);
  assert.equal(expiryKeyString({ oracle: '0xAB', underlying: '0xCD', expiry: 5 }), '0xab:0xcd:5');
});

test('selectExpiries: a backlog of old undone expiries never crowds out the recent ones; the backlog is surveyed in rotation', () => {
  const k = (expiry: number, underlying = '0xu1') => ({ oracle: '0xo', underlying, expiry });
  // 200 expiries from a month ago that never finish (an unprunable order each), then today's and the next one.
  const stuck = Array.from({ length: 200 }, (_, i) => k(E - 30 * 86_400 + i * 60, `0xs${i}`));
  const recent = [k(E - 3_600), k(E + 600)];
  const now = E;
  const picked = selectExpiries([...stuck, ...recent], new Set(), now, 900, 200, { recentS: 3 * 86_400 });
  assert.equal(picked.length, 200);
  assert.deepEqual(picked.slice(0, 2).map((x) => x.expiry), [E - 3_600, E + 600], 'the recent expiries first: their snapshot and finalize windows are minutes long');
  assert.deepEqual(picked.slice(2, 4).map((x) => x.underlying), ['0xs0', '0xs1']);
  const rotated = selectExpiries([...stuck, ...recent], new Set(), now, 900, 200, { recentS: 3 * 86_400, backlogOffset: 198 });
  assert.deepEqual(rotated.slice(2, 5).map((x) => x.underlying), ['0xs198', '0xs199', '0xs0'], 'the backlog rotates from the offset');
});

test('planLadder: strikes far beyond this ladder\'s span (two far-OTM createSeries anyone can make) do not count as its OTM rungs: a moved market still re-centres', () => {
  const ladder100 = ladderStrikes(100n * M, DAILY, M, false); // 101, 103, 104, 105, 106
  // Spot rallied to 110: every daily rung is ITM. Someone created 190 and 195 calls (inside createSeries' band).
  const griefed = planLadder({ spot: 110n * M, ladder: DAILY, strikeTick: M, isPut: false, existing: [...ladder100, 190n * M, 195n * M], anchor: 100n * M });
  assert.equal(griefed.reason, 'recentre');
  // 110 × 1.01 = 111.1 → 112; × 1.01 … → 113, 114, 115, 116
  assert.deepEqual(griefed.create, [112n * M, 113n * M, 114n * M, 115n * M, 116n * M]);
  // A strike inside the span still counts (another tenor's rungs on the same expiry): two OTM, nothing to add.
  const nearby = planLadder({ spot: 110n * M, ladder: DAILY, strikeTick: M, isPut: false, existing: [...ladder100, 112n * M, 114n * M], anchor: 100n * M });
  assert.equal(nearby.reason, 'ok');
  // Puts mirror it: far below the span does not count.
  const puts = planLadder({ spot: 90n * M, ladder: DAILY, strikeTick: M, isPut: true, existing: [...ladderStrikes(100n * M, DAILY, M, true), 46n * M, 50n * M], anchor: 100n * M });
  assert.equal(puts.reason, 'recentre');
});
