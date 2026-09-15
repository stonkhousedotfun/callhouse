/**
 * The pure verdicts of the roll state machine.
 *
 * WHY THIS FILE EXISTS: Seaport is the only authority on a listing's lifecycle now — there is no
 * book to disagree with it — and the close publishes numbers a depositor reads. Pinned here,
 * without a chain:
 *
 *   seaportVerdict   Seaport's own getOrderStatus: fills and cancels move a row, `cancelled` and
 *                    `expired` are latches (counters only move forward).
 *   resolveContractsAssigned
 *                    the assignment count a closed week publishes. The vault's RollClose is the
 *                    number; the keeper's pre-close Valorem read is the fallback for a receipt
 *                    without one and the cross-check for a receipt with one.
 *   decodeRollClose / decodeClaimStranded
 *                    the two events that decide whether a close redeemed or stranded the claim.
 *   rollCloseMessage / rollCloseAlertData
 *                    what the roll_close alert says. On an assigned week the gross includes the
 *                    strike proceeds, which are returned principal, so premium and strike
 *                    proceeds are named separately; a stranded close says so on the end.
 *
 * DELIBERATELY ABSENT: no chain, no HTTP. roll.ts is imported for its pure exports only; the
 * RPC in the environment is a discard port. (roll.close.test.ts drives both close paths through
 * tick() with the keeper's own client stubbed.)
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, type TransactionReceipt } from 'viem';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-roll-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { decodeClaimStranded, decodeRollClose, describeInterval, listingFilled, resolveContractsAssigned, rollCloseAlertData, rollCloseMessage, seaportVerdict } =
  await import('./roll.js');
type RollCloseSummary = import('./roll.js').RollCloseSummary;
const { vaultAbi } = await import('./abi.js');
type SeaportOrderStatus = import('./seaport.js').SeaportOrderStatus;

function seaport(overrides: Partial<SeaportOrderStatus> = {}): SeaportOrderStatus {
  return { isValidated: true, isCancelled: false, totalFilled: 0n, totalSize: 23n, isFullyFilled: false, ...overrides };
}

test('seaportVerdict: fills and cancels move a row', () => {
  assert.equal(seaportVerdict('approved', seaport({ isFullyFilled: true, totalFilled: 23n })), 'filled');
  assert.equal(seaportVerdict('partial', seaport({ isFullyFilled: true, totalFilled: 23n })), 'filled');
  assert.equal(seaportVerdict('approved', seaport({ isCancelled: true })), 'cancelled');
  assert.equal(seaportVerdict('partial', seaport({ isCancelled: true, totalFilled: 3n })), 'cancelled');
  assert.equal(seaportVerdict('approved', seaport({ totalFilled: 3n })), 'partial');
  assert.equal(seaportVerdict('approved', seaport({})), 'approved', 'untouched stays approved');
  assert.equal(seaportVerdict('partial', seaport({ totalFilled: 3n })), 'partial');
  // A row marked filled by a read the chain now says is only part-filled: the chain wins.
  assert.equal(seaportVerdict('filled', seaport({ totalFilled: 3n })), 'partial');
});

test('seaportVerdict: cancelled and expired are latches', () => {
  // A counter bump (invalidateAllListings, lockBook, rollClose) kills an order WITHOUT setting
  // isCancelled, so Seaport reads it as untouched and valid. The latch keeps it dead.
  assert.equal(seaportVerdict('cancelled', seaport({})), 'cancelled');
  assert.equal(seaportVerdict('expired', seaport({})), 'expired');
  assert.equal(seaportVerdict('expired', seaport({ isFullyFilled: true, totalFilled: 23n })), 'expired');
});

test('describeInterval: minutes at a minute or more, seconds below (the retry timer in the stranded page)', () => {
  assert.equal(describeInterval(3_600_000), '60 minutes');
  assert.equal(describeInterval(60_000), '1 minute');
  assert.equal(describeInterval(90_000), '2 minutes');
  assert.equal(describeInterval(1_000), '1 second', 'the fork rehearsal’s timer, not "0 minutes"');
  assert.equal(describeInterval(15_000), '15 seconds');
});

test('listingFilled: the row’s Seaport fraction applied to its size', () => {
  assert.equal(listingFilled({ contracts: '28', seaport_total_filled: '7', seaport_total_size: '28' }), 7n);
  assert.equal(listingFilled({ contracts: '28', seaport_total_filled: null, seaport_total_size: null }), 0n);
  assert.equal(listingFilled({ contracts: '28', seaport_total_filled: '1', seaport_total_size: '1' }), 28n);
});

/* ---- rollClose: which assignment count gets published ---- */

const VAULT = process.env.VAULT as `0x${string}`;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const LOT = 1_000_000_000_000_000_000n;

/** A `RollClose(cycleNumber, assetsReturned, usdgFromAssignment, contractsAssignedCount)` log as
 *  the vault emits it: the cycle number indexed, the three amounts in data. */
function rollCloseLog(count: bigint, address: `0x${string}` = VAULT, cycleNumber = 3): TransactionReceipt['logs'][number] {
  const topics = encodeEventTopics({ abi: vaultAbi, eventName: 'RollClose', args: { cycleNumber } });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [(23n - count) * LOT, count * 225_000_000n, count],
  );
  return {
    address,
    topics,
    data,
    blockNumber: 1n,
    blockHash: `0x${'ab'.repeat(32)}`,
    logIndex: 0,
    transactionHash: `0x${'cd'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as unknown as TransactionReceipt['logs'][number];
}

/** Something else the vault logged in the same receipt: a Harvest, which must not be mistaken. */
function harvestLog(): TransactionReceipt['logs'][number] {
  const topics = encodeEventTopics({ abi: vaultAbi, eventName: 'Harvest', args: { cycleNumber: 3 } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1_000_000n, 100_000n, 900_000n]);
  return { ...rollCloseLog(0n), topics, data, logIndex: 1 } as unknown as TransactionReceipt['logs'][number];
}

/** `ClaimStranded(cycleNumber, claimKey, gen)`: the close could not redeem the claim. */
function claimStrandedLog(gen: bigint, address: `0x${string}` = VAULT): TransactionReceipt['logs'][number] {
  const claimKey = (0xabcdefn << 96n) | 1n;
  const topics = encodeEventTopics({ abi: vaultAbi, eventName: 'ClaimStranded', args: { cycleNumber: 3, claimKey } });
  const data = encodeAbiParameters([{ type: 'uint256' }], [gen]);
  return { ...rollCloseLog(0n, address), topics, data, logIndex: 2 } as unknown as TransactionReceipt['logs'][number];
}

function receiptWith(...logs: Array<TransactionReceipt['logs'][number]>): TransactionReceipt {
  return { logs } as unknown as TransactionReceipt;
}

test("resolveContractsAssigned: the vault's RollClose is the number published; the pre-read is its cross-check", () => {
  const receipt = receiptWith(harvestLog(), rollCloseLog(9n));
  assert.deepEqual(resolveContractsAssigned(receipt, 9n), { assigned: 9, source: 'RollClose', fromEvent: 9n, fromClaim: 9n, mismatch: false });
  // The two are read from the same Valorem claim across a window with no possible exercise, so
  // a disagreement is a defect: the event is still what gets published, and the caller warns.
  assert.deepEqual(resolveContractsAssigned(receipt, 4n), { assigned: 9, source: 'RollClose', fromEvent: 9n, fromClaim: 4n, mismatch: true });
  // A failed pre-read (null, never a silent 0) is not a mismatch.
  assert.deepEqual(resolveContractsAssigned(receipt, null), { assigned: 9, source: 'RollClose', fromEvent: 9n, fromClaim: null, mismatch: false });
});

test('resolveContractsAssigned: a RollClose count of 0 is a result, not a reason to fall through', () => {
  const outOfTheMoney = resolveContractsAssigned(receiptWith(rollCloseLog(0n)), 0n);
  assert.deepEqual(outOfTheMoney, { assigned: 0, source: 'RollClose', fromEvent: 0n, fromClaim: 0n, mismatch: false });
  const disagreeing = resolveContractsAssigned(receiptWith(rollCloseLog(0n)), 9n);
  assert.equal(disagreeing.assigned, 0, 'the event, even at 0, outranks the pre-read');
  assert.equal(disagreeing.mismatch, true);
});

test('resolveContractsAssigned: without a RollClose from the vault, the pre-read stands in; without that, 0 and "unknown"', () => {
  // A RollClose from some other contract in the same receipt is not the vault's.
  assert.deepEqual(resolveContractsAssigned(receiptWith(harvestLog(), rollCloseLog(23n, OTHER)), 9n), {
    assigned: 9,
    source: 'claim-preread',
    fromEvent: null,
    fromClaim: 9n,
    mismatch: false,
  });
  // Case-insensitive on the address, the way receipts come back.
  assert.equal(resolveContractsAssigned(receiptWith(rollCloseLog(9n, VAULT.toUpperCase().replace('0X', '0x') as `0x${string}`)), null).source, 'RollClose');
  assert.deepEqual(resolveContractsAssigned(receiptWith(), 0n), { assigned: 0, source: 'claim-preread', fromEvent: null, fromClaim: 0n, mismatch: false });
  assert.deepEqual(resolveContractsAssigned(receiptWith(harvestLog()), null), { assigned: 0, source: 'unknown', fromEvent: null, fromClaim: null, mismatch: false });
});

test('decodeRollClose: all three amounts from the vault’s RollClose, null without one', () => {
  assert.deepEqual(decodeRollClose(receiptWith(harvestLog(), rollCloseLog(9n))), {
    assetsReturned: 14n * LOT,
    usdgFromAssignment: 2_025_000_000n,
    contractsAssignedCount: 9n,
  });
  assert.deepEqual(decodeRollClose(receiptWith(rollCloseLog(0n))), { assetsReturned: 23n * LOT, usdgFromAssignment: 0n, contractsAssignedCount: 0n });
  assert.equal(decodeRollClose(receiptWith(harvestLog(), rollCloseLog(9n, OTHER))), null, "another contract's RollClose is not the vault's");
  assert.equal(decodeRollClose(receiptWith(harvestLog())), null);
});

test('decodeClaimStranded: the vault’s ClaimStranded in a close receipt, null when the claim redeemed', () => {
  assert.deepEqual(decodeClaimStranded(receiptWith(rollCloseLog(1n), claimStrandedLog(1n))), {
    cycleNumber: 3,
    claimKey: (0xabcdefn << 96n) | 1n,
    gen: 1n,
  });
  assert.equal(decodeClaimStranded(receiptWith(rollCloseLog(9n), harvestLog())), null);
  assert.equal(decodeClaimStranded(receiptWith(claimStrandedLog(1n, OTHER))), null, "another contract's event is not the vault's");
});

/** Dry-run cycle 3 in USDG base units: 19.079259 premium, 5% fee on the premium only, 2025 strike
 *  proceeds from 9 contracts at 225, 14 NVDA returned. */
const ASSIGNED: RollCloseSummary = {
  cycleNumber: 3,
  gross: 2_044_079_259n,
  fee: 953_962n,
  net: 2_043_125_297n,
  usdgFromAssignment: 2_025_000_000n,
  assetsReturned: 14n * LOT,
  contractsAssigned: 9,
  witnessedLive: true,
};
const UNWITNESSED = ' The close ran without this keeper witnessing it; reconstructed from chain logs.';
const STRANDED = ' The claim could NOT be redeemed and is stranded: its legs are paid by retryStrandedClaim.';

test('rollCloseMessage: an assigned week names premium and strike proceeds separately', () => {
  assert.equal(ASSIGNED.fee, ((ASSIGNED.gross - (ASSIGNED.usdgFromAssignment ?? 0n)) * 500n) / 10_000n, 'fixture: fee on premium only');
  assert.equal(ASSIGNED.net, ASSIGNED.gross - ASSIGNED.fee, 'fixture: net = gross - fee');
  assert.equal(
    rollCloseMessage(ASSIGNED),
    'cycle 3 closed: premium 19.079259 USDG (fee 0.953962), strike proceeds 2025 USDG from 9 contracts assigned; 2043.125297 USDG to depositors.',
  );
  assert.doesNotMatch(rollCloseMessage(ASSIGNED), /harvested/, 'strike proceeds are not "harvested"');
  assert.equal(
    rollCloseMessage({ ...ASSIGNED, witnessedLive: false }),
    `cycle 3 closed: premium 19.079259 USDG (fee 0.953962), strike proceeds 2025 USDG from 9 contracts assigned; 2043.125297 USDG to depositors.${UNWITNESSED}`,
  );
  const one = { ...ASSIGNED, gross: 244_079_259n, usdgFromAssignment: 225_000_000n, net: 243_125_297n, contractsAssigned: 1 };
  assert.equal(
    rollCloseMessage(one),
    'cycle 3 closed: premium 19.079259 USDG (fee 0.953962), strike proceeds 225 USDG from 1 contract assigned; 243.125297 USDG to depositors.',
  );
});

test('rollCloseMessage: unassigned and unfilled wordings are unchanged, live and reconstructed', () => {
  const unassigned: RollCloseSummary = {
    ...ASSIGNED,
    cycleNumber: 1,
    gross: 19_079_259n,
    net: 18_125_297n,
    usdgFromAssignment: 0n,
    assetsReturned: 23n * LOT,
    contractsAssigned: 0,
  };
  assert.equal(rollCloseMessage(unassigned), 'cycle 1 closed: 19.079259 USDG harvested, 18.125297 to depositors.');
  assert.equal(rollCloseMessage({ ...unassigned, witnessedLive: false }), `cycle 1 closed: 19.079259 USDG harvested, 18.125297 to depositors.${UNWITNESSED}`);
  assert.equal(rollCloseMessage({ ...unassigned, usdgFromAssignment: null, assetsReturned: null }), 'cycle 1 closed: 19.079259 USDG harvested, 18.125297 to depositors.');

  const unfilled: RollCloseSummary = { ...unassigned, cycleNumber: 2, gross: 0n, fee: 0n, net: 0n };
  assert.equal(rollCloseMessage(unfilled), 'cycle 2 closed unfilled: 0 USDG harvested.');
  assert.equal(rollCloseMessage({ ...unfilled, witnessedLive: false }), `cycle 2 closed unfilled: 0 USDG harvested.${UNWITNESSED}`);
  assert.equal(rollCloseMessage({ ...unfilled, usdgFromAssignment: null }), 'cycle 2 closed unfilled: 0 USDG harvested.');
});

test('rollCloseMessage: a stranded close says so, after the numbers and before the unwitnessed note', () => {
  // A strand reports zero legs: the harvest is whatever premium sat idle, and the proceeds wait.
  const stranded: RollCloseSummary = { ...ASSIGNED, gross: 19_079_259n, net: 18_125_297n, usdgFromAssignment: 0n, assetsReturned: 0n, contractsAssigned: 1, stranded: true };
  assert.equal(rollCloseMessage(stranded), `cycle 3 closed: 19.079259 USDG harvested, 18.125297 to depositors.${STRANDED}`);
  assert.equal(rollCloseMessage({ ...stranded, witnessedLive: false }), `cycle 3 closed: 19.079259 USDG harvested, 18.125297 to depositors.${STRANDED}${UNWITNESSED}`);
  assert.equal(rollCloseAlertData(stranded).stranded, true);
  assert.equal(rollCloseAlertData(ASSIGNED).stranded, false);
});

test('rollCloseMessage: assigned with the proceeds unknown says so instead of calling the gross premium', () => {
  const unknown = { ...ASSIGNED, usdgFromAssignment: null, assetsReturned: null };
  assert.equal(
    rollCloseMessage(unknown),
    'cycle 3 closed: 2044.079259 USDG gross including strike proceeds from 9 contracts assigned (premium/proceeds split unknown), 2043.125297 to depositors.',
  );
  assert.doesNotMatch(rollCloseMessage(unknown), /premium \d/);
});

test('rollCloseAlertData: premiumUsdg and strikeProceedsUsdg beside the gross/fee/net, null when unknown', () => {
  assert.deepEqual(rollCloseAlertData(ASSIGNED), {
    cycleNumber: 3,
    grossUsdg: '2044.079259',
    feeUsdg: '0.953962',
    netUsdg: '2043.125297',
    premiumUsdg: '19.079259',
    strikeProceedsUsdg: '2025',
    assetsReturned: '14000000000000000000',
    contractsAssigned: 9,
    stranded: false,
  });
  const unassigned = rollCloseAlertData({ ...ASSIGNED, gross: 19_079_259n, net: 18_125_297n, usdgFromAssignment: 0n, contractsAssigned: 0 });
  assert.equal(unassigned.premiumUsdg, '19.079259', 'nothing assigned: the whole gross is premium');
  assert.equal(unassigned.strikeProceedsUsdg, '0');
  const unfilled = rollCloseAlertData({ ...ASSIGNED, gross: 0n, fee: 0n, net: 0n, usdgFromAssignment: 0n, contractsAssigned: 0 });
  assert.equal(unfilled.premiumUsdg, '0');
  assert.equal(unfilled.strikeProceedsUsdg, '0');
  const unknown = rollCloseAlertData({ ...ASSIGNED, usdgFromAssignment: null, assetsReturned: null });
  assert.equal(unknown.premiumUsdg, null);
  assert.equal(unknown.strikeProceedsUsdg, null);
  assert.equal(unknown.assetsReturned, null);
  assert.equal(unknown.grossUsdg, '2044.079259');
});
