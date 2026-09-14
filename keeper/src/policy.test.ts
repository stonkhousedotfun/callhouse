/**
 * The strike, the size and the price, pinned integer for integer against contracts/src/Policy.sol
 * and the fill gate in contracts/src/lib/ValoremLib.sol.
 *
 * WHY THIS FILE EXISTS: every number policy.ts produces is re-derived on chain by the vault — at
 * the arm, at the approval and at EVERY FILL — and the vault's answer wins. A price one base unit
 * under the fill floor is a `PremiumBelowFloorAtFill` for the first buyer, and a strike a dollar
 * outside the band is a `StrikeBelowBand` at the arm. These tests pin the maths to the values
 * the contracts compute, on the real Chainlink print from 2026-09-12.
 *
 * DELIBERATELY ABSENT: no RPC. The seams on PlanInput stand in for the environment, and the RPC
 * in the environment is a discard port.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-policy-'));
process.env.KEEPER_ENV_FILE = '/dev/null'; // never read a developer's .env into a test
process.env.RH_RPC = 'http://127.0.0.1:9'; // the discard port; nothing here dials it
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
delete process.env.KEEPER_UNIT_PRICE_USDG6;
delete process.env.KEEPER_PREMIUM_MARGIN_BPS; // the default (100) unless a test passes the seam
delete process.env.KEEPER_STRIKE_OTM_BPS;
delete process.env.RH_RPC_2;

const { BPS } = await import('./config.js');
const {
  MAX_LISTINGS_PER_CYCLE,
  capacity,
  ceilDiv,
  engineFeeAsset,
  fillFloorUnit6,
  fillFloorUsdg6,
  fillVerdict,
  maxContracts,
  minUnitPrice6,
  planWeek,
  priceListing,
  strikeBand,
  withPremiumMargin,
} = await import('./policy.js');
type PolicyParams = import('./policy.js').PolicyParams;

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

/** Policy.launchDefaults(), and README "Policy (launch)". */
const LAUNCH: PolicyParams = {
  minOtmBps: 300n,
  maxOtmBps: 1200n,
  minPremiumBps: 40n,
  maxUtilizationBps: 9500n,
  protocolFeeBps: 500n,
  maxContractsCap: 50n,
};

/** Chainlink RHNVDA/USD, 8 dp, read 2026-09-12: 21829793457 -> 218.297934 USDG per lot. */
const SPOT = 218_297_934n;
const LOT = 1_000_000_000_000_000_000n;
const TWENTY_FIVE = 25n * LOT;

function plan(overrides: Partial<Parameters<typeof planWeek>[0]> = {}) {
  return planWeek({
    policy: LAUNCH,
    spotUsdg6: SPOT,
    totalAssets: TWENTY_FIVE,
    contractsWritten: 0n,
    feesEnabled: false,
    feeBps: 15,
    strikeOtmBps: 500,
    premiumMarginBps: 0,
    unitPriceOverride6: null,
    ...overrides,
  });
}

/*//////////////////////////////////////////////////////////////
                              THE BAND
//////////////////////////////////////////////////////////////*/

test('strikeBand floors both ends exactly as Policy.strikeBand does', () => {
  // 218297934 * 10300 / 10000 = 224846872.02 -> 224846872; * 11200 / 10000 = 244493686.08.
  assert.deepEqual(strikeBand(SPOT, LAUNCH), { lo: 224_846_872n, hi: 244_493_686n });
});

test('planWeek picks spot + 5% rounded to a whole USDG, inside the band at both ends', () => {
  const p = plan();
  assert.ok(p.ok);
  assert.equal(p.strikeUsdg6, 229_000_000n, '218.297934 x 1.05 = 229.2128 -> 229');
  assert.equal(p.bandLowUsdg6, 224_846_872n);
  assert.equal(p.bandHighUsdg6, 244_493_686n);
  // The target is a knob; the band is the vault's. 3% rounds to 225 and is (just) inside; 12%
  // rounds to 244, inside; 13% is 247, outside.
  assert.equal((plan({ strikeOtmBps: 300 }) as { strikeUsdg6: bigint }).strikeUsdg6, 225_000_000n);
  assert.equal((plan({ strikeOtmBps: 1200 }) as { strikeUsdg6: bigint }).strikeUsdg6, 244_000_000n);
  const out = plan({ strikeOtmBps: 1300 });
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.reason, 'strike-outside-band');
  assert.equal(!out.ok && out.detail.strikeUsdg6, '247000000');
  // A rounding that lands below the floor is refused too: spot 24.99, +3% = 25.74 -> 26 is
  // inside, but at 20.00 the 3% target 20.60 rounds to 21 = 5% and the 2% target rounds to 20,
  // which is at the money and below the 3% floor.
  const atm = plan({ spotUsdg6: 20_000_000n, strikeOtmBps: 200 });
  assert.equal(!atm.ok && atm.reason, 'strike-outside-band');
});

test('planWeek refuses a zero spot and an empty vault, with the reason', () => {
  assert.equal((plan({ spotUsdg6: 0n }) as { reason: string }).reason, 'spot-zero');
  const empty = plan({ totalAssets: 0n });
  assert.equal(!empty.ok && empty.reason, 'no-capacity');
  // Less than a lot at 95% is no lot at all.
  assert.equal((plan({ totalAssets: LOT }) as { reason: string }).reason, 'no-capacity');
});

/*//////////////////////////////////////////////////////////////
                             THE SIZE
//////////////////////////////////////////////////////////////*/

test('maxContracts is floor(assets * 95% / lot), capped at maxContractsCap', () => {
  assert.equal(maxContracts(TWENTY_FIVE, LAUNCH), 23n, '25 x 0.95 = 23.75 -> 23');
  assert.equal(maxContracts(LOT, LAUNCH), 0n);
  assert.equal(maxContracts(LOT + LOT / 19n + 1n, LAUNCH), 1n, 'just over 1/0.95 lots');
  assert.equal(maxContracts(100n * LOT, LAUNCH), 50n, 'the cap binds');
  assert.equal(maxContracts(TWENTY_FIVE, { ...LAUNCH, maxUtilizationBps: 9985n }), 24n, 'the 99.85% ceiling');
});

test('capacity is maxContracts(totalAssets) less what is written, floored at zero', () => {
  assert.equal(capacity(TWENTY_FIVE, 0n, LAUNCH), 23n);
  assert.equal(capacity(TWENTY_FIVE, 7n, LAUNCH), 16n);
  assert.equal(capacity(TWENTY_FIVE, 23n, LAUNCH), 0n);
  // NAV fell below the sold size (an issuer burn): zero, never negative.
  assert.equal(capacity(10n * LOT, 23n, LAUNCH), 0n);
  // NAV grew mid-week (a deposit): the difference is listable.
  assert.equal(capacity(30n * LOT, 23n, LAUNCH), 5n);
  const p = plan();
  assert.ok(p.ok);
  assert.equal(p.contracts, 23n, 'the plan offers the whole capacity');
  assert.equal((plan({ contractsWritten: 7n }) as { contracts: bigint }).contracts, 16n);
});

/*//////////////////////////////////////////////////////////////
                             THE PRICE
//////////////////////////////////////////////////////////////*/

test('minUnitPrice6 is the ceiling of the per-contract premium floor', () => {
  // 218297934 * 40 / 10000 = 873191.736 -> 873192.
  assert.equal(minUnitPrice6(SPOT, LAUNCH), 873_192n);
  assert.equal(ceilDiv(10n, 3n), 4n);
  assert.equal(ceilDiv(9n, 3n), 3n);
  assert.throws(() => ceilDiv(1n, 0n));
});

test('the ceiling clears Policy.minPremium for every size; one unit below misses at n = 2', () => {
  const unit = minUnitPrice6(SPOT, LAUNCH);
  for (const n of [1n, 2n, 3n, 23n, 50n]) {
    const floor = (SPOT * n * LAUNCH.minPremiumBps) / BPS;
    assert.ok(unit * n >= floor, `n=${n}`);
  }
  assert.ok((unit - 1n) * 2n < (SPOT * 2n * LAUNCH.minPremiumBps) / BPS);
});

test('fillFloor mirrors ValoremLib.writeOnFill: minPremium(spot, n) plus the engine fee valued at spot', () => {
  // Fee off: the floor is the premium floor alone, for the size as a whole.
  assert.equal(fillFloorUsdg6(SPOT, 23n, LAUNCH, false, 15), (SPOT * 23n * 40n) / BPS);
  assert.equal(fillFloorUnit6(SPOT, 23n, LAUNCH, false, 15), 873_192n, 'per contract: ceil(20083409.9/23)');
  assert.equal(engineFeeAsset(23n, false, 15), 0n);
  // Fee on: 15 bps of notional in the ASSET, floored at one base unit, valued at spot per LOT.
  assert.equal(engineFeeAsset(23n, true, 15), (23n * LOT * 15n) / BPS);
  assert.equal(engineFeeAsset(1n, true, 0), 1n, 'the one-base-unit floor');
  const feeValued = ((23n * LOT * 15n) / BPS) * SPOT / LOT; // 0.0345 lots x spot = 7.531278 USDG
  assert.equal(feeValued, 7_531_278n);
  assert.equal(fillFloorUsdg6(SPOT, 23n, LAUNCH, true, 15), (SPOT * 23n * 40n) / BPS + feeValued);
  // Per contract with the fee: 873192 + ceil(7531278/23) = 873192 + 327447 (rounded up together).
  assert.equal(fillFloorUnit6(SPOT, 23n, LAUNCH, true, 15), ceilDiv((SPOT * 23n * 40n) / BPS + feeValued, 23n));
  assert.equal(fillFloorUnit6(SPOT, 23n, LAUNCH, true, 15), 1_200_639n);
});

test('withPremiumMargin: margin 0 is the identity, the margin rounds UP, a negative is refused', () => {
  assert.equal(withPremiumMargin(873_192n, 0), 873_192n);
  assert.equal(withPremiumMargin(873_192n, 100), 881_924n, '873192 x 1.01 = 881923.92 -> 881924');
  assert.equal(withPremiumMargin(873_192n, 50), 877_558n, '877557.96 -> 877558');
  assert.equal(withPremiumMargin(1n, 1), 2n, 'always up');
  assert.throws(() => withPremiumMargin(1n, -1));
});

test('planWeek prices at the fill floor plus the margin, never above the strike; the override is bounded', () => {
  const floor = plan();
  assert.ok(floor.ok);
  assert.equal(floor.unitPrice6, 873_192n, 'margin 0: the floor itself');
  assert.equal(floor.floorUnit6, 873_192n);
  assert.equal(floor.gross6, 873_192n * 23n);
  assert.equal(floor.priceSource, 'fill-floor');

  const margined = plan({ premiumMarginBps: 100 });
  assert.ok(margined.ok);
  assert.equal(margined.unitPrice6, 881_924n);
  // A 1% spot rise moves the floor to ceil(220480913.34 x 40 / 10000) = 881924: still clears.
  const higherSpot = (SPOT * 10_100n) / BPS;
  assert.ok(margined.unitPrice6 * 23n >= fillFloorUsdg6(higherSpot, 23n, LAUNCH, false, 15), 'survives a +1% tick');
  assert.ok(floor.unitPrice6 * 23n < fillFloorUsdg6(higherSpot, 23n, LAUNCH, false, 15), 'the unmargined floor does not');

  const override = plan({ unitPriceOverride6: 2_000_000n });
  assert.ok(override.ok);
  assert.equal(override.unitPrice6, 2_000_000n);
  assert.equal(override.priceSource, 'manual-override');
  const lowOverride = plan({ unitPriceOverride6: 20n });
  assert.ok(lowOverride.ok);
  assert.equal(lowOverride.unitPrice6, 873_192n, 'an override under the fill floor is lifted to it: a dead listing helps nobody');
  const above = plan({ unitPriceOverride6: 229_000_001n });
  assert.equal(!above.ok && above.reason, 'premium-above-strike');
});

test('priceListing is the same rule a reprice uses, on the armed strike', () => {
  const p = priceListing({ policy: LAUNCH, spotUsdg6: SPOT, strikeUsdg6: 229_000_000n, contracts: 16n, feesEnabled: false, feeBps: 15, premiumMarginBps: 100, unitPriceOverride6: null });
  assert.ok(p.ok);
  assert.equal(p.floorUnit6, 873_192n, 'per contract the floor does not depend on the size when the fee is off');
  assert.equal(p.unitPrice6, 881_924n);
  assert.equal((priceListing({ policy: LAUNCH, spotUsdg6: SPOT, strikeUsdg6: 229_000_000n, contracts: 0n, feesEnabled: false, feeBps: 15, unitPriceOverride6: null }) as { reason: string }).reason, 'no-capacity');
});

/*//////////////////////////////////////////////////////////////
                        THE FILL GATE, MIRRORED
//////////////////////////////////////////////////////////////*/

test('fillVerdict: the live listing against a moved spot, exactly the two checks the hook makes', () => {
  const listing = { grossUsdg6: 873_192n * 23n, amount: 23n, strikeUsdg6: 229_000_000n };
  // At the spot it was priced on: fillable.
  const same = fillVerdict(SPOT, listing, LAUNCH, false, 15);
  assert.equal(same.fillable, true);
  // A +1% tick: the ask is now under the fill floor; a reprice fixes it.
  const up1 = fillVerdict((SPOT * 10_100n) / BPS, listing, LAUNCH, false, 15);
  assert.equal(up1.fillable, false);
  assert.equal(!up1.fillable && up1.reason, 'premium-below-floor');
  assert.equal(!up1.fillable && up1.detail.unitPrice6, '873192');
  // A rally past the strike / 1.03: the strike is inside the band floor; no price fixes it.
  // 229 / 1.03 = 222.33: at spot 223 the floor is 229.69 > 229.
  const rally = fillVerdict(223_000_000n, listing, LAUNCH, false, 15);
  assert.equal(!rally.fillable && rally.reason, 'strike-below-band');
  assert.equal(!rally.fillable && rally.detail.bandLowUsdg6, '229690000');
  // A sell-off makes the call safer: still fillable (the hook checks the floor only).
  assert.equal(fillVerdict(200_000_000n, listing, LAUNCH, false, 15).fillable, true);
  // The fee switching on mid-week lifts the floor by the fee valued at spot: an unmargined
  // listing is refused; one priced with the fee in is not.
  assert.equal(!fillVerdict(SPOT, listing, LAUNCH, true, 15).fillable, true);
  const withFee = { ...listing, grossUsdg6: 1_200_639n * 23n };
  assert.equal(fillVerdict(SPOT, withFee, LAUNCH, true, 15).fillable, true);
});

test('the vault caps listings at three a cycle, mirrored', () => {
  assert.equal(MAX_LISTINGS_PER_CYCLE, 3);
});
