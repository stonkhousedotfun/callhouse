/**
 * The pricer's pure decisions (planner.ts).
 *
 * WHY THIS FILE EXISTS: every rule here is one AutoRoller.reprice would otherwise enforce by
 * reverting, or one the task sets for gas discipline. Pinned: the band is exactly the contract's
 * (inclusive, integer, on the PRICE_TICK grid, rounded inward); the target is clamp(fair × (1 + edge),
 * band) rounded up to the tick; "differs by > 10 %" is strict in both directions; a new position is
 * evaluated at once and an evaluated one not again inside 30 minutes; the skip reasons come in the
 * contract's order.
 *
 * DELIBERATELY ABSENT: chain, clock, pricing service (pricer.test.ts drives the tick on fakes, and
 * devnet-reprice.ts on a real chain).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_REPRICE_DROP_BPS, PRICER_MAX_STEP_DROP_BPS, REPRICE_PAGE_DROP_BPS } from '../cranker/constants.js';
import {
  CUTOFF_MARGIN_S,
  askLive,
  differsEnough,
  evaluationDue,
  inBand,
  planCheck,
  planReprice,
  priceBand,
  repriceFloor,
  stepFloor,
  targetPrice,
  type CheckView,
} from './planner.js';

/** NVDA at 212.21 USDG. */
const SPOT = 212_210_000n;

/*//////////////////////////////////////////////////////////////
                              BAND
//////////////////////////////////////////////////////////////*/

test('priceBand: the ends are rounded inward to the tick and both pass the contract\'s exact inclusive check', () => {
  // 30 bps of 212.21 = 0.636630 -> 0.636700; 150 bps = 3.183150 -> 3.183100.
  const band = priceBand(SPOT, 30, 150);
  assert.deepEqual(band, { min: 636_700n, max: 3_183_100n });
  assert.ok(inBand(band!.min, SPOT, 30, 150) && inBand(band!.max, SPOT, 30, 150));
  assert.ok(!inBand(band!.min - 100n, SPOT, 30, 150), 'one tick under the floor is BadPrice');
  assert.ok(!inBand(band!.max + 100n, SPOT, 30, 150), 'one tick over the ceiling is BadPrice');
  // An exact multiple is inclusive at both ends (the contract's test: 1_100_000 and 11_000_000 at spot 220 with 50-500 bps).
  assert.deepEqual(priceBand(220_000_000n, 50, 500), { min: 1_100_000n, max: 11_000_000n });
  assert.ok(inBand(1_100_000n, 220_000_000n, 50, 500) && inBand(11_000_000n, 220_000_000n, 50, 500));
  assert.ok(!inBand(1_099_900n, 220_000_000n, 50, 500) && !inBand(11_000_100n, 220_000_000n, 50, 500));
  assert.ok(!inBand(2_000_050n, 220_000_000n, 50, 500), 'off the tick grid is BadPrice');
});

test('priceBand: null when no positive tick fits, spot is not positive or the band is inverted; never a zero floor', () => {
  // 5-5 bps of 1.0001 USDG: 500.05 base units -> floor 600, ceiling 500: no tick.
  assert.equal(priceBand(1_000_100n, 5, 5), null);
  assert.deepEqual(priceBand(1_000_000n, 5, 5), { min: 500n, max: 500n }, 'a band exactly on a tick holds that tick');
  assert.equal(priceBand(0n, 30, 150), null);
  assert.equal(priceBand(SPOT, 150, 30), null);
  // 5-1000 bps of 0.01 USDG: floor would be 0 -> 100; ceiling 1000 -> 1000.
  assert.deepEqual(priceBand(10_000n, 5, 1_000), { min: 100n, max: 1_000n });
});

test('band property: for 2000 pseudo-random spots and strategy bands, every target lies on the grid inside the exact band', () => {
  let seed = 0x2b05;
  const rand = (n: number) => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % n;
  };
  let checked = 0;
  for (let i = 0; i < 2_000; i += 1) {
    const spot = BigInt(1 + rand(2_000_000_000));
    const min = 5 + rand(200);
    const max = min + rand(1_000 - min + 1);
    const fair = BigInt(rand(100_000_000));
    const edge = rand(15_000) - 5_000;
    const t = targetPrice({ fair, edgeBps: edge, spot, minAskBps: min, maxAskBps: max });
    if (!t.ok) {
      assert.equal(priceBand(spot, min, max), null);
      continue;
    }
    checked += 1;
    assert.ok(inBand(t.price, spot, min, max), `spot ${spot} band ${min}-${max} fair ${fair} edge ${edge}: ${t.price} not accepted`);
    assert.ok(t.price >= t.band.min && t.price <= t.band.max);
  }
  assert.ok(checked > 1_500, `most random bands admit a tick (${checked})`);
});

/*//////////////////////////////////////////////////////////////
                             TARGET
//////////////////////////////////////////////////////////////*/

test('targetPrice: fair × (1 + edge) rounded up to the tick inside the band; clamped to the floor or the ceiling outside it', () => {
  // fair 1.500000, +5 %: 1.575000 exactly on the grid.
  assert.deepEqual(targetPrice({ fair: 1_500_000n, edgeBps: 500, spot: SPOT, minAskBps: 30, maxAskBps: 150 }), {
    ok: true,
    price: 1_575_000n,
    raw: 1_575_000n,
    band: { min: 636_700n, max: 3_183_100n },
    clamped: null,
  });
  // fair 1.234567, +5 %: 1.29629535 -> ceil 1.296296 -> tick up 1.296300.
  const up = targetPrice({ fair: 1_234_567n, edgeBps: 500, spot: SPOT, minAskBps: 30, maxAskBps: 150 });
  assert.ok(up.ok && up.price === 1_296_300n && up.clamped === null);
  const low = targetPrice({ fair: 100_000n, edgeBps: 500, spot: SPOT, minAskBps: 30, maxAskBps: 150 });
  assert.ok(low.ok && low.price === 636_700n && low.raw === 105_000n && low.clamped === 'floor');
  const high = targetPrice({ fair: 9_000_000n, edgeBps: 500, spot: SPOT, minAskBps: 30, maxAskBps: 150 });
  assert.ok(high.ok && high.price === 3_183_100n && high.clamped === 'ceiling');
  // A negative edge prices under fair; zero fair sits on the floor.
  const under = targetPrice({ fair: 2_000_000n, edgeBps: -1_000, spot: SPOT, minAskBps: 30, maxAskBps: 150 });
  assert.ok(under.ok && under.price === 1_800_000n);
  const zero = targetPrice({ fair: 0n, edgeBps: 500, spot: SPOT, minAskBps: 30, maxAskBps: 150 });
  assert.ok(zero.ok && zero.price === 636_700n && zero.clamped === 'floor');
  assert.deepEqual(targetPrice({ fair: 1_000_000n, edgeBps: 0, spot: 1_000_100n, minAskBps: 5, maxAskBps: 5 }), { ok: false, reason: 'band-empty' });
});

/*//////////////////////////////////////////////////////////////
                            THRESHOLD
//////////////////////////////////////////////////////////////*/

test('differsEnough: strictly more than the threshold, up or down; exactly 10 % does not reprice', () => {
  assert.equal(differsEnough(1_100_000n, 1_000_000n, 1_000), false, 'exactly +10 %');
  assert.equal(differsEnough(1_100_100n, 1_000_000n, 1_000), true, '+10.01 %');
  assert.equal(differsEnough(900_000n, 1_000_000n, 1_000), false, 'exactly -10 %');
  assert.equal(differsEnough(899_900n, 1_000_000n, 1_000), true, '-10.01 %');
  assert.equal(differsEnough(1_000_000n, 1_000_000n, 1_000), false);
  assert.equal(differsEnough(1_050_000n, 1_000_000n, 1_000), false, '+5 %');
  assert.equal(differsEnough(1_050_000n, 1_000_000n, 400), true, 'a tighter threshold');
  assert.equal(differsEnough(100n, 0n, 1_000), true, 'a zero live price differs from any positive target');
});

/*//////////////////////////////////////////////////////////////
                             CADENCE
//////////////////////////////////////////////////////////////*/

test('evaluationDue: a position never evaluated (a new roll, or first sight after boot) is due at once; then every 30 minutes on the head clock', () => {
  const t0 = 1_790_000_000;
  assert.deepEqual(evaluationDue({ positionLongId: 7n, memory: null, now: t0, minIntervalS: 1_800 }), { due: true, why: 'new-position' });
  const memory = { longId: 7n, checkedAt: t0 };
  assert.deepEqual(evaluationDue({ positionLongId: 7n, memory, now: t0 + 600, minIntervalS: 1_800 }), { due: false, nextAt: t0 + 1_800 });
  assert.deepEqual(evaluationDue({ positionLongId: 7n, memory, now: t0 + 1_799, minIntervalS: 1_800 }), { due: false, nextAt: t0 + 1_800 });
  assert.deepEqual(evaluationDue({ positionLongId: 7n, memory, now: t0 + 1_800, minIntervalS: 1_800 }), { due: true, why: 'interval' });
  // The roll after that period: a new longId is due immediately, whatever the clock says.
  assert.deepEqual(evaluationDue({ positionLongId: 8n, memory, now: t0 + 60, minIntervalS: 1_800 }), { due: true, why: 'new-position' });
});

/*//////////////////////////////////////////////////////////////
                            DECISIONS
//////////////////////////////////////////////////////////////*/

const NOW = 1_790_000_000;

function view(overrides: Partial<CheckView> = {}): CheckView {
  return {
    strategy: { active: true, smartPricing: true, minAskBps: 30, maxAskBps: 150 },
    position: { longId: 11n, orderId: 31n, expiry: NOW + 3 * 86_400 },
    order: { price: 1_273_300n, units: 1_000n, filled: 0n, validUntil: NOW + 3 * 86_400 - 1_800, cancelled: false },
    spot: SPOT,
    series: { isPut: false, strike: SPOT * 2n },
    now: NOW,
    sessionOpen: true,
    memory: null,
    ...overrides,
  };
}

test('planCheck: the contract\'s refusals first (strategy, position, tracked ask, live ask, cutoff), then the cadence, then spot', () => {
  const settings = { minIntervalS: 1_800, repriceOffHours: false };
  const reason = (v: CheckView) => {
    const d = planCheck(v, settings);
    return d.check ? `check:${d.why}` : d.reason;
  };
  const order = view().order!;
  assert.equal(reason(view()), 'check:new-position');
  assert.equal(reason(view({ strategy: { active: false, smartPricing: true, minAskBps: 30, maxAskBps: 150 } })), 'inactive');
  assert.equal(reason(view({ strategy: { active: true, smartPricing: false, minAskBps: 0, maxAskBps: 0 } })), 'not-smart-pricing');
  assert.equal(reason(view({ position: { longId: 0n, orderId: 0n, expiry: 0 } })), 'no-position');
  assert.equal(reason(view({ position: { longId: 11n, orderId: 0n, expiry: NOW + 86_400 } })), 'no-tracked-ask');
  assert.equal(reason(view({ order: null })), 'order-not-live');
  assert.equal(reason(view({ order: { ...order, cancelled: true } })), 'order-not-live');
  assert.equal(reason(view({ order: { ...order, filled: 1_000n } })), 'order-not-live');
  assert.equal(reason(view({ order: { ...order, validUntil: NOW } })), 'order-not-live');
  assert.equal(reason(view({ order: { ...order, validUntil: NOW + CUTOFF_MARGIN_S } })), 'near-cutoff');
  assert.equal(reason(view({ order: { ...order, validUntil: NOW + CUTOFF_MARGIN_S + 1 } })), 'check:new-position');
  const recent = planCheck(view({ memory: { longId: 11n, checkedAt: NOW - 600 } }), settings);
  assert.deepEqual(recent, { check: false, reason: 'not-due', nextAt: NOW + 1_200 });
  assert.equal(reason(view({ memory: { longId: 11n, checkedAt: NOW - 1_800 } })), 'check:interval');
  assert.equal(reason(view({ spot: null })), 'spot-stale');
  assert.equal(reason(view({ spot: null, memory: { longId: 11n, checkedAt: NOW - 60 } })), 'not-due', 'a stale spot is not what a not-due pair reports');
  // A partly filled ask is still live.
  assert.ok(askLive({ ...order, filled: 999n }, NOW));
});

test('planCheck: an in-the-money ask is not repriced — reprice reverts InTheMoney and cancelStale withdraws it', () => {
  const settings = { minIntervalS: 1_800, repriceOffHours: false };
  const reason = (v: CheckView) => {
    const d = planCheck(v, settings);
    return d.check ? `check:${d.why}` : d.reason;
  };
  // A call written 5 % out of the money, then a rally past the strike.
  const strike = 220_000_000n;
  assert.equal(reason(view({ series: { isPut: false, strike }, spot: strike - 1n })), 'check:new-position');
  assert.equal(reason(view({ series: { isPut: false, strike }, spot: strike })), 'in-the-money', 'exactly at the strike is what the contract refuses');
  assert.equal(reason(view({ series: { isPut: false, strike }, spot: strike + 10_000_000n })), 'in-the-money');
  // A put is in the money below its strike.
  assert.equal(reason(view({ series: { isPut: true, strike }, spot: strike + 1n })), 'check:new-position');
  assert.equal(reason(view({ series: { isPut: true, strike }, spot: strike })), 'in-the-money');
  // The refusal sits AFTER the cheap checks, so a pair that is not due or has no live ask still reports that instead.
  assert.equal(reason(view({ series: { isPut: false, strike }, spot: strike, order: null })), 'order-not-live');
  assert.equal(reason(view({ series: { isPut: false, strike }, spot: strike, memory: { longId: 11n, checkedAt: NOW - 60 } })), 'not-due');
  assert.equal(reason(view({ series: { isPut: false, strike }, spot: null })), 'spot-stale', 'without a spot there is nothing to compare');
  // An unread series does not invent a refusal: the pricer falls through and reports the read failure itself.
  assert.equal(reason(view({ series: null, spot: strike })), 'check:new-position');
});

test('planCheck: session gate refuses overnight and unread calendars without moving evaluation memory', () => {
  const settings = { minIntervalS: 1_800, repriceOffHours: false };
  assert.deepEqual(planCheck(view({ sessionOpen: false }), settings), { check: false, reason: 'market-closed' });
  assert.deepEqual(planCheck(view({ sessionOpen: null }), settings), { check: false, reason: 'session-unavailable' });
  assert.deepEqual(planCheck(view({ sessionOpen: false }), { ...settings, repriceOffHours: true }), { check: true, why: 'new-position', spot: SPOT, order: view().order });
  assert.deepEqual(planCheck(view({ sessionOpen: true }), settings), { check: true, why: 'new-position', spot: SPOT, order: view().order });
});

test('planReprice: repriced to the clamped target only when it moves more than the threshold', () => {
  const strategy = { minAskBps: 30, maxAskBps: 150 };
  const base = { spot: SPOT, strategy, edgeBps: 500, thresholdBps: 1_000 };
  // Live 1.273300 (60 bps of spot rounded up). Fair 2.000000 +5 % = 2.100000: +65 %.
  const move = planReprice({ ...base, fair: 2_000_000n, livePrice: 1_273_300n });
  assert.ok(move.reprice && move.price === 2_100_000n);
  // Fair 1.250000 +5 % = 1.312500: +3.1 %.
  const small = planReprice({ ...base, fair: 1_250_000n, livePrice: 1_273_300n });
  assert.ok(!small.reprice && small.reason === 'within-threshold' && small.target.price === 1_312_500n);
  // A fair far above the ceiling reprices to the ceiling, which is still > 10 % away.
  const ceiling = planReprice({ ...base, fair: 50_000_000n, livePrice: 1_273_300n });
  assert.ok(ceiling.reprice && ceiling.price === 3_183_100n && ceiling.target.clamped === 'ceiling');
  // Already at the ceiling: the clamp keeps the target where the ask is.
  const pinned = planReprice({ ...base, fair: 50_000_000n, livePrice: 3_183_100n });
  assert.ok(!pinned.reprice && pinned.reason === 'within-threshold');
  assert.deepEqual(planReprice({ ...base, spot: 1_000_100n, strategy: { minAskBps: 5, maxAskBps: 5 }, fair: 1n, livePrice: 100n }), { reprice: false, reason: 'band-empty' });
});

/*//////////////////////////////////////////////////////////////
          THE PER-CALL DROP FLOOR
//////////////////////////////////////////////////////////////*/

/**
 * AutoRoller.reprice's drop rule, written from the contract (callhouse-contracts AutoRoller.sol reprice):
 * `if (newPrice * BPS < o.price * (BPS - MAX_REPRICE_DROP_BPS)) revert RepriceDropExceeded(...)`, MAX_REPRICE_DROP_BPS
 * 2_500 (AutoRoller.sol:162), and the book's tick (`price % 100 == 0`). A literal copy, deliberately not the planner's.
 */
const contractAcceptsDrop = (newPrice: bigint, live: bigint): boolean => newPrice % 100n === 0n && newPrice * 10_000n >= live * 7_500n;

test('repriceFloor: the lowest tick the contract accepts in one call, exactly; one tick less is refused', () => {
  for (const live of [100n, 1_273_300n, 1_000_000n, 3_183_100n, 7_777_700n, 123_456_700n, 999_999_900n]) {
    const floor = repriceFloor(live);
    assert.ok(contractAcceptsDrop(floor, live), `floor ${floor} of ${live} is accepted`);
    assert.ok(!contractAcceptsDrop(floor - 100n, live), `one tick under the floor of ${live} is refused`);
  }
  // The revert's own named floor: roundUpToTick(ceilDiv(1_273_300 x 7_500, 10_000), 100) = 955_000.
  assert.equal(repriceFloor(1_273_300n), 955_000n);
  assert.equal(repriceFloor(0n), 0n);
});

/**
 * ops/v2/monitor.mjs repriceFindings' own measure of a reprice's drop, bps of the ask it replaced (integer, floored):
 * at REPRICE_PAGE_DROP_BPS or more it pages v2_mon_reprice_floorward at ERROR, the leaked-key signature.
 */
const monitorDropBps = (before: bigint, price: bigint): bigint => ((before - price) * 10_000n) / before;

test('the pricer step sits strictly under the monitor page, which sits under the contract cap', () => {
  assert.ok(PRICER_MAX_STEP_DROP_BPS < REPRICE_PAGE_DROP_BPS, 'an honest step never pages as a leaked key');
  assert.ok(REPRICE_PAGE_DROP_BPS < MAX_REPRICE_DROP_BPS, 'the page fires before a key reaches the contract cap');
  for (const live of [100n, 1_273_300n, 1_000_000n, 3_183_100n, 7_777_700n, 123_456_700n, 999_999_900n]) {
    const floor = stepFloor(live);
    assert.ok(contractAcceptsDrop(floor, live), `the step from ${live} is one reprice accepts`);
    assert.ok(monitorDropBps(live, floor) < REPRICE_PAGE_DROP_BPS, `the step from ${live} (${monitorDropBps(live, floor)} bps) does not page`);
  }
});

test('planReprice: a fair 50 % below the ask steps down, each step accepted by reprice and under the monitor page, until within threshold', () => {
  const strategy = { minAskBps: 30, maxAskBps: 150 };
  // Live 3.183100 (the ceiling); fair 1.500000 +5 % = 1.575000, 50.5 % below the ask.
  let live = 3_183_100n;
  const steps: bigint[] = [];
  for (let i = 0; i < 10; i += 1) {
    const plan = planReprice({ spot: SPOT, strategy, edgeBps: 500, thresholdBps: 1_000, fair: 1_500_000n, livePrice: live });
    if (!plan.reprice) {
      assert.equal(plan.reason, 'within-threshold');
      break;
    }
    assert.ok(contractAcceptsDrop(plan.price, live), `step ${i + 1}: ${live} -> ${plan.price} is accepted by reprice`);
    assert.ok(monitorDropBps(live, plan.price) < REPRICE_PAGE_DROP_BPS, `step ${i + 1}: ${live} -> ${plan.price} does not page v2_mon_reprice_floorward`);
    assert.ok(inBand(plan.price, SPOT, strategy.minAskBps, strategy.maxAskBps), `step ${i + 1} is inside the band`);
    steps.push(plan.price);
    live = plan.price;
  }
  assert.deepEqual(steps, [2_578_400n, 2_088_600n, 1_691_800n], 'three 19 % steps; 1.691800 is then within 10 % of the target');
  // The first plan is a step: its price is the step floor, and the target is kept for the report.
  const first = planReprice({ spot: SPOT, strategy, edgeBps: 500, thresholdBps: 1_000, fair: 1_500_000n, livePrice: 3_183_100n });
  assert.ok(first.reprice && first.stepFloor === 2_578_400n && first.target.price === 1_575_000n);
  // A target inside one step is sent as it is.
  const near = planReprice({ spot: SPOT, strategy, edgeBps: 500, thresholdBps: 1_000, fair: 2_000_000n, livePrice: 2_500_000n });
  assert.ok(near.reprice && near.price === 2_100_000n && near.stepFloor === null);
});

test('planReprice: a step floor above the band\'s ceiling means no price is within one step, and nothing is sent', () => {
  // The ask sits at 5.000000 while the band tops out at 3.183100: every price one pricer step down (>= 4.050000) is
  // above the band, and every price inside the band is more than one step down.
  const strategy = { minAskBps: 30, maxAskBps: 150 };
  const plan = planReprice({ spot: SPOT, strategy, edgeBps: 500, thresholdBps: 1_000, fair: 1_500_000n, livePrice: 5_000_000n });
  assert.ok(!plan.reprice && plan.reason === 'drop-floor-above-band');
  assert.equal(plan.floor, 4_050_000n);
  assert.equal(plan.target.band.max, 3_183_100n);
});


/*//////////////////////////////////////////////////////////////
   THE STEP FLOOR ABOVE THE BAND'S CEILING
   (the ceiling wins)
//////////////////////////////////////////////////////////////*/

test('planReprice: the step floor above the band but the ceiling within the contract floor sends the ceiling', () => {
  // The numbers: live 1.000000, spot 53.666667, band 50-150 bps, fair 0.763810 (+5 % = 0.802100, a 19.79 %
  // drop). The band's ceiling is 150 bps x 53.666667 = 0.805000 on the tick; the pricer's 19 % step floor is 0.810000,
  // above it; the contract's 25 % floor is 0.750000, below it. The old planner returned drop-floor-above-band and sent nothing.
  const plan = planReprice({ spot: 53_666_667n, strategy: { minAskBps: 50, maxAskBps: 150 }, edgeBps: 500, thresholdBps: 1_000, fair: 763_810n, livePrice: 1_000_000n });
  assert.ok(plan.reprice, 'a reprice is planned');
  assert.equal(plan.target.price, 802_100n, 'the target the base sent');
  assert.equal(plan.target.band.max, 805_000n);
  assert.equal(plan.price, 805_000n, 'the band ceiling is sent');
  assert.equal(plan.stepFloor, null, 'the price is not the step floor');
  assert.deepEqual(plan.ceilingStep, { stepFloor: 810_000n, dropBps: 1_950n });
  assert.ok(contractAcceptsDrop(plan.price, 1_000_000n), 'reprice accepts it');
  assert.ok(monitorDropBps(1_000_000n, plan.price) < REPRICE_PAGE_DROP_BPS, 'a 19.5 % step: the monitor does not page it');
});

test('planReprice: a ceiling step of 20 % or more is still sent, and its drop is the monitor\'s page measure', () => {
  // Band ceiling 3.183100 at SPOT (150 bps). Live 4.000000: step floor 3.240000 is above it, contract floor 3.000000 is
  // below it, so the ceiling goes out, a 20.42 % drop that pages v2_mon_reprice_floorward.
  const strategy = { minAskBps: 30, maxAskBps: 150 };
  const plan = planReprice({ spot: SPOT, strategy, edgeBps: 500, thresholdBps: 1_000, fair: 1_500_000n, livePrice: 4_000_000n });
  assert.ok(plan.reprice && plan.ceilingStep !== undefined);
  assert.equal(plan.price, 3_183_100n);
  assert.equal(plan.ceilingStep.stepFloor, 3_240_000n);
  assert.equal(plan.ceilingStep.dropBps, 2_042n);
  assert.equal(plan.ceilingStep.dropBps, monitorDropBps(4_000_000n, plan.price), 'the same floored bps the monitor computes');
  assert.ok(plan.ceilingStep.dropBps >= REPRICE_PAGE_DROP_BPS, 'at or over the page line');
  assert.ok(contractAcceptsDrop(plan.price, 4_000_000n));
  assert.ok(inBand(plan.price, SPOT, strategy.minAskBps, strategy.maxAskBps));
});

test('planReprice: nothing is sent only when the band\'s ceiling is below the contract floor, to the tick', () => {
  const strategy = { minAskBps: 30, maxAskBps: 150 };
  const at = (livePrice: bigint) => planReprice({ spot: SPOT, strategy, edgeBps: 500, thresholdBps: 1_000, fair: 1_500_000n, livePrice });
  // Live 4.244100: the contract floor is ceil(3.183075) on the tick = 3.183100, exactly the ceiling: accepted, sent.
  const edge = at(4_244_100n);
  assert.ok(contractAcceptsDrop(3_183_100n, 4_244_100n), 'the literal contract rule accepts the ceiling at 4.244100');
  assert.ok(edge.reprice && edge.price === 3_183_100n && edge.ceilingStep?.dropBps === 2_499n);
  // One tick more on the ask: the contract floor is 3.183200, one tick over the ceiling: refused, nothing sent.
  const stuck = at(4_244_200n);
  assert.ok(!contractAcceptsDrop(3_183_100n, 4_244_200n), 'the literal contract rule refuses the ceiling at 4.244200');
  assert.ok(!stuck.reprice && stuck.reason === 'drop-floor-above-band');
  assert.equal(stuck.contractFloor, 3_183_200n);
  assert.equal(stuck.contractFloor, repriceFloor(4_244_200n));
  assert.equal(stuck.floor, stepFloor(4_244_200n), 'floor is still the pricer\'s step floor');
  // The earlier 5.000000 case is this one: contract floor 3.750000 over the 3.183100 ceiling.
  const far = at(5_000_000n);
  assert.ok(!far.reprice && far.reason === 'drop-floor-above-band' && far.contractFloor === 3_750_000n);
});
