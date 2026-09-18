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
import {
  CUTOFF_MARGIN_S,
  askLive,
  differsEnough,
  evaluationDue,
  inBand,
  planCheck,
  planReprice,
  priceBand,
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
  // An exact multiple is inclusive at both ends (the C2-09 test: 1_100_000 and 11_000_000 at spot 220 with 50-500 bps).
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
    memory: null,
    ...overrides,
  };
}

test('planCheck: the contract\'s refusals first (strategy, position, tracked ask, live ask, cutoff), then the cadence, then spot', () => {
  const settings = { minIntervalS: 1_800 };
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
  const settings = { minIntervalS: 1_800 };
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
