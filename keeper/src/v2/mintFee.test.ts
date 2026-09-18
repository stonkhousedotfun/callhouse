/**
 * The collateral rent of INTERFACE_VERSION 7 (c05), against the contracts' own arithmetic.
 *
 * WHY THIS FILE EXISTS: `OrderBook._reserveCollateral` budgets collateral PLUS
 * `ceil(collateral × mintFeePpm × (expiry − now) / (1e6 × 7 days))` and SKIPS a write-on-fill order the writer
 * cannot cover, without reverting. A bot that sizes at `free / collateralPerUnit` therefore advertises depth the
 * chain will not fill, silently. Pinned here: the ceiling and the flooring exactly as `OptionMath.mintFee` and
 * `mintFeeRefund` compute them, that the refund never exceeds the fee, and that {maxWriteUnits} is the exact
 * largest size one fill can take — its answer fits and one more unit does not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINT_FEE_PERIOD_S, PPM, UNIT } from './cranker/constants.js';
import { collateralNeeded, maxWriteUnits, mintFee, mintFeeRefund, remainingLife, rentPerUnit } from './mintFee.js';

const DENOM = PPM * BigInt(MINT_FEE_PERIOD_S);
/** The contract's formula, written out again here so a refactor of mintFee.ts cannot quietly redefine it. */
const ceilFee = (c: bigint, ppm: bigint, rem: bigint) => (c * ppm * rem === 0n ? 0n : (c * ppm * rem - 1n) / DENOM + 1n);

test('mintFee is OptionMath.mintFee: the product rounded UP, 0 when any input is 0', () => {
  // NVDA's launch rate on one whole share (100 units) locked for exactly one period.
  const collateral = 100n * UNIT;
  assert.equal(mintFee(collateral, 80, MINT_FEE_PERIOD_S), (collateral * 80n) / PPM);
  assert.equal(mintFee(collateral, 80, MINT_FEE_PERIOD_S), ceilFee(collateral, 80n, BigInt(MINT_FEE_PERIOD_S)));
  // A true value far below one base unit still costs one: the rounding is always the protocol's.
  assert.equal(mintFee(1n, 1, 1), 1n);
  assert.equal(mintFee(UNIT, 80, 1), ceilFee(UNIT, 80n, 1n));
  assert.equal(mintFee(UNIT, 0, MINT_FEE_PERIOD_S), 0n, 'a 0 ppm market charges nothing');
  assert.equal(mintFee(UNIT, 80, 0), 0n, 'at expiry there is no life left to rent');
  assert.equal(mintFee(0n, 80, MINT_FEE_PERIOD_S), 0n);
  // A put's USDG collateral (6 dp) rounds the same way.
  assert.equal(mintFee(250_000_000n, 1_500, 3 * 86_400), ceilFee(250_000_000n, 1_500n, BigInt(3 * 86_400)));
});

test('mintFeeRefund is the same product rounded DOWN, and never above the fee', () => {
  for (const rem of [1, 3_600, 86_400, MINT_FEE_PERIOD_S, 45 * 86_400]) {
    for (const ppm of [1, 5, 80, 1_500, 5_000]) {
      const c = 137n * UNIT;
      const fee = mintFee(c, ppm, rem);
      const refund = mintFeeRefund(c, ppm, rem);
      assert.equal(refund, (c * BigInt(ppm) * BigInt(rem)) / DENOM);
      assert.ok(refund <= fee, `refund ${refund} > fee ${fee} at ${ppm} ppm, ${rem} s`);
      assert.ok(fee - refund <= 1n, 'the two differ by at most the one rounding');
    }
  }
});

test('remainingLife floors at 0, and rentPerUnit is the per-unit figure AutoRoller._plan sizes with', () => {
  assert.equal(remainingLife(1_000, 400), 600);
  assert.equal(remainingLife(1_000, 1_000), 0);
  assert.equal(remainingLife(1_000, 4_000), 0);
  assert.equal(rentPerUnit(UNIT, 80, MINT_FEE_PERIOD_S), mintFee(UNIT, 80, MINT_FEE_PERIOD_S));
  // ceil(u × x) <= u × ceil(x): the roller's per-unit rate always covers a whole ask, and usually over-covers it.
  const units = 100n;
  assert.ok(collateralNeeded(units, UNIT, 80, MINT_FEE_PERIOD_S) <= units * (UNIT + rentPerUnit(UNIT, 80, MINT_FEE_PERIOD_S)));
});

test('collateralNeeded is what OrderBook._reserveCollateral consumes: one rounding for the whole fill', () => {
  const rem = 4 * 86_400;
  assert.equal(collateralNeeded(0n, UNIT, 80, rem), 0n);
  assert.equal(collateralNeeded(1n, UNIT, 80, rem), UNIT + mintFee(UNIT, 80, rem));
  // Two fills of 50 round twice, one fill of 100 rounds once: never more than one base unit apart.
  const whole = collateralNeeded(100n, UNIT, 80, rem);
  const halves = collateralNeeded(50n, UNIT, 80, rem) * 2n;
  assert.ok(halves >= whole && halves - whole <= 1n, `${halves} vs ${whole}`);
});

test('maxWriteUnits is exact: its answer fits in the free balance and one more unit does not', () => {
  const cases: Array<{ free: bigint; cpu: bigint; ppm: number; rem: number }> = [
    // Exactly 100 units of collateral and no headroom: the rent costs the ask its last unit.
    { free: 100n * UNIT, cpu: UNIT, ppm: 80, rem: MINT_FEE_PERIOD_S },
    { free: 100n * UNIT, cpu: UNIT, ppm: 1_500, rem: 45 * 86_400 },
    { free: 100n * UNIT, cpu: UNIT, ppm: 5_000, rem: 45 * 86_400 },
    { free: 1n * UNIT, cpu: UNIT, ppm: 80, rem: 60 },
    { free: 3n * UNIT + 7n, cpu: UNIT, ppm: 5, rem: 86_400 },
    // A put: USDG collateral at 6 dp, a 250 strike.
    { free: 1_000_000_000n, cpu: 2_500_000n, ppm: 700, rem: 7 * 86_400 },
  ];
  for (const { free, cpu, ppm, rem } of cases) {
    const n = maxWriteUnits(free, cpu, ppm, rem);
    assert.ok(collateralNeeded(n, cpu, ppm, rem) <= free, `${n} units do not fit in ${free}`);
    assert.ok(collateralNeeded(n + 1n, cpu, ppm, rem) > free, `${n + 1n} units would also fit in ${free}`);
  }
  // A whole share's collateral at the launch rate buys 99 units, not 100: the "N × 100 − 1" sizing of v7 §4.5.4.
  assert.equal(maxWriteUnits(100n * UNIT, UNIT, 80, MINT_FEE_PERIOD_S), 99n);
  assert.equal(maxWriteUnits(100n * UNIT, UNIT, 0, MINT_FEE_PERIOD_S), 100n, 'a 0 ppm market is the v6 answer');
  assert.equal(maxWriteUnits(100n * UNIT, UNIT, 80, 0), 100n, 'at expiry there is no rent to reserve');
  assert.equal(maxWriteUnits(0n, UNIT, 80, 60), 0n);
  assert.equal(maxWriteUnits(100n * UNIT, 0n, 80, 60), 0n, 'an unreadable collateralPerUnit writes nothing');
});
