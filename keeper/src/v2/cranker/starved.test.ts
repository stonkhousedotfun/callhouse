/**
 * Mirrors the contracts' StarvedCall.sol. The keeper's fixed limits against the ceilings
 * put on its gas-capped calls: below starvedCeiling(CAP) a guarded call that fails having used most of its gas RE-THROWS
 * and reverts the transaction, where it used to read as "not ok" / SKIP_BELOW_FLOOR / paid in kind.
 *
 * Each headroom test below fails at the value it replaced: GAS.distribute 900k, no GAS.redeemConvertReserve, and a
 * snapshot/finalize resend that adds nothing (oracleStarvedGas returning the fixed limit).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONVERSION_GAS,
  DISTRIBUTE_AFTER_SWAP_GAS,
  DISTRIBUTE_BEFORE_SWAP_GAS,
  GAS,
  MAX_ORACLE_SOURCES,
  REDEEM_BEFORE_CONVERSION_GAS,
  SNAPSHOT_GRACE,
  SOURCE_GAS,
  STARVED_CALL_SLACK,
  SWAP_GAS,
  starvedCeiling,
} from './constants.js';
import { MM_GAS, MM_REDEEM_BEFORE_CALL_GAS } from '../mm/constants.js';
import { redeemBaseGas, redeemGasOf } from './planner.js';
import { CHAIN_MAX_TX_GAS, oracleSourceCalls, oracleStarvedGas } from './steps.js';

/** EIP-150: a callee is handed at most 63/64 of what its caller holds at the CALL. */
const forwarded = (held: bigint): bigint => (held * 63n) / 64n;

test('the mirrored gas caps and StarvedCall.belowCeiling, as StarvedCall.sol, SettlementOracle.sol, FeeSplitter.sol and Clearinghouse.sol define them', () => {
  // StarvedCall.sol:70 CALL_SLACK; SettlementOracle.sol:292; FeeSplitter.sol:69; Clearinghouse.sol:113.
  assert.equal(STARVED_CALL_SLACK, 10_000n);
  assert.equal(SOURCE_GAS, 2_000_000n);
  assert.equal(SWAP_GAS, 1_500_000n);
  assert.equal(CONVERSION_GAS, 1_500_000n);
  // StarvedCall.sol:77: `gasBefore < ceiling + ceiling / 63 + CALL_SLACK` (integer division).
  assert.equal(starvedCeiling(SOURCE_GAS), 2_041_746n);
  assert.equal(starvedCeiling(SWAP_GAS), 1_533_809n);
  assert.equal(starvedCeiling(CONVERSION_GAS), 1_533_809n);
});

test('a distribute holds the swap\'s whole SWAP_GAS ceiling at the swap, so a floor miss is SKIP_BELOW_FLOOR, never a re-throw (fails at the old 900k)', () => {
  const atSwap = GAS.distribute - DISTRIBUTE_BEFORE_SWAP_GAS;
  assert.ok(atSwap >= starvedCeiling(SWAP_GAS), `GAS.distribute ${GAS.distribute} leaves ${atSwap} at the swap, under its ceiling ${starvedCeiling(SWAP_GAS)}`);
  // A route that burns every unit of SWAP_GAS still leaves the catch its approval reset and DistributionSkipped.
  assert.ok(atSwap - SWAP_GAS >= DISTRIBUTE_AFTER_SWAP_GAS, `after a swap that burned SWAP_GAS only ${atSwap - SWAP_GAS} is left`);
  assert.ok(GAS.distribute <= CHAIN_MAX_TX_GAS);
});

test('a converting holder of a redeemBatch reaches its conversion above CONVERSION_GAS\'s ceiling on its own budget plus one reserve (fails with no reserve)', () => {
  // The batch's LAST converting holder, every holder before it having used exactly its own budget: what is left is its
  // own GAS.redeemConvertEach plus the reserve; batchRedeemOne is a CALL (63/64), and the holder's own work before the
  // conversion comes off that.
  const atConversion = forwarded(GAS.redeemConvertEach + GAS.redeemConvertReserve) - REDEEM_BEFORE_CONVERSION_GAS;
  assert.ok(atConversion >= starvedCeiling(CONVERSION_GAS), `${atConversion} at the conversion is under its ceiling ${starvedCeiling(CONVERSION_GAS)}`);
  // A route that burns all of CONVERSION_GAS still leaves the in-kind payout, the Redeemed log and the bounty.
  assert.ok(atConversion - CONVERSION_GAS >= GAS.redeemInKindEach, `after a conversion that burned CONVERSION_GAS only ${atConversion - CONVERSION_GAS} is left`);
});

test('the MM bot\'s MakerVault.redeem reaches its conversion above CONVERSION_GAS\'s ceiling (fails at the old 1.2M)', () => {
  // MakerVault.redeem -> Clearinghouse.redeem is one CALL with no try/catch (MakerVault.sol:470): a re-thrown conversion
  // reverts the whole redeem.
  const atConversion = forwarded(MM_GAS.redeem - MM_REDEEM_BEFORE_CALL_GAS) - REDEEM_BEFORE_CONVERSION_GAS;
  assert.ok(atConversion >= starvedCeiling(CONVERSION_GAS), `MM_GAS.redeem ${MM_GAS.redeem} leaves ${atConversion} at the conversion, under ${starvedCeiling(CONVERSION_GAS)}`);
  assert.ok(atConversion - CONVERSION_GAS >= GAS.redeemInKindEach, 'a conversion that burned CONVERSION_GAS still leaves the in-kind payout');
});

test('redeemBaseGas adds the conversion reserve once, only when some holder of the batch converts', () => {
  const call = { isLong: true, isPut: false, perUnitPayout: 1n, adapterSet: true };
  const converting = { inKind: false };
  const inKind = { inKind: true };
  assert.equal(redeemGasOf(converting, call), GAS.redeemConvertEach);
  assert.equal(redeemBaseGas([inKind, converting, converting], call), GAS.redeemBase + GAS.redeemConvertReserve, 'one reserve for the batch, not one per holder');
  // Controls: nothing converts, so nothing is reserved.
  assert.equal(redeemBaseGas([inKind, inKind], call), GAS.redeemBase, 'every holder takes its payout in kind');
  assert.equal(redeemBaseGas([converting], { ...call, adapterSet: false }), GAS.redeemBase, 'no payout adapter');
  assert.equal(redeemBaseGas([converting], { ...call, isPut: true }), GAS.redeemBase, 'a put pays USDG without a swap');
  assert.equal(redeemBaseGas([converting], { ...call, isLong: false }), GAS.redeemBase, 'a short is paid its collateral');
  assert.equal(redeemBaseGas([converting], { ...call, perUnitPayout: 0n }), GAS.redeemBase, 'an OTM long is paid nothing');
  assert.equal(redeemBaseGas([], call), GAS.redeemBase);
});

test('a snapshot/finalize resend holds every source call\'s SOURCE_GAS ceiling on top of the fixed limit, capped 2M under the chain cap (fails if the resend adds nothing)', () => {
  const ceiling = starvedCeiling(SOURCE_GAS);
  for (const [base, calls] of [[GAS.snapshot, 1], [GAS.snapshot, 2], [GAS.finalize, 2], [GAS.finalize, 4]] as const) {
    const gas = oracleStarvedGas(base, calls);
    assert.equal(gas, base + BigInt(calls) * ceiling, `${calls} source call(s) on ${base}`);
    // However much the calls before the last one burned (each at most SOURCE_GAS), the last still starts above its ceiling.
    assert.ok(gas - base - BigInt(calls - 1) * SOURCE_GAS >= ceiling);
  }
  // The launch pair: two sources, finalize inside the grace records and then reads each: four calls.
  assert.equal(oracleStarvedGas(GAS.finalize, 4), 9_666_984n);
  // An unreadable source list asks for 8 (16 inside the grace) and is clamped, never above the chain's cap.
  assert.equal(oracleStarvedGas(GAS.finalize, 2 * MAX_ORACLE_SOURCES), CHAIN_MAX_TX_GAS - 2_000_000n);
});

test('how many source calls a snapshot or finalize makes (SettlementOracle snapshot/_record, finalize/_record+_refresh)', () => {
  const two = { sourcesKnown: true, sources: [1, 2] };
  const E = 1_789_934_400;
  assert.equal(oracleSourceCalls(two, 'snapshot', E + 10, E), 2);
  assert.equal(oracleSourceCalls(two, 'finalize', E + SNAPSHOT_GRACE, E), 4, 'inside the grace finalize records each source, then reads each');
  assert.equal(oracleSourceCalls(two, 'finalize', E + SNAPSHOT_GRACE + 1, E), 2, 'after the grace it only reads');
  assert.equal(oracleSourceCalls({ sourcesKnown: false, sources: [] }, 'finalize', E + SNAPSHOT_GRACE + 1, E), MAX_ORACLE_SOURCES);
});
