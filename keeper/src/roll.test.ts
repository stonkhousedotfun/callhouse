/**
 * The pure verdicts of the roll state machine.
 *
 * WHY THIS FILE EXISTS: the chain must outrank Overcall's book. Before these rules, a wrong or
 * malicious API row could latch a listing `filled` and censor a still-fillable order from the
 * keeper's own /orders fallback — an unfilled week by censorship, with the order valid on chain
 * the whole time. Pinned here, without a chain:
 *
 *   seaportVerdict   Seaport's own getOrderStatus — the authority. It may DOWNGRADE what the
 *                    book claimed, but only on a chain-valid state: a counter bump kills an
 *                    order without setting isCancelled, and that must not resurrect it.
 *   bookVerdict      the API's opinion. `filled` is believed only when the row's own Seaport
 *                    fields agree; a chain-confirmed `filled` is never downgraded by the book.
 *   isPostRetryable  the idempotent-repost set: approved, post_failed, and a partial the book
 *                    never accepted (a direct fill through /orders must not stop the repost).
 *   resolveContractsAssigned
 *                    the assignment count a closed week publishes. The vault's RollClose is the
 *                    number; the keeper's pre-close Valorem read is the fallback for a receipt
 *                    without one and the cross-check for a receipt with one. Both branches are
 *                    unreachable through a tick with the deployed bytecode (the event is always
 *                    there), so they are pinned here on synthetic receipts and driven on a real
 *                    one by dryrun.ts cycle 3.
 *
 * DELIBERATELY ABSENT: no chain, no HTTP. roll.ts is imported for its pure exports only; the
 * RPC in the environment is a discard port. (roll.close.test.ts covers the one impure piece of
 * the close path, contractsAssignedAt, with the keeper's own client stubbed.)
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
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { bookVerdict, isPostRetryable, resolveContractsAssigned, seaportVerdict } = await import('./roll.js');
const { vaultAbi } = await import('./abi.js');
type SeaportOrderStatus = import('./seaport.js').SeaportOrderStatus;

function seaport(overrides: Partial<SeaportOrderStatus> = {}): SeaportOrderStatus {
  return { isValidated: true, isCancelled: false, totalFilled: 0n, totalSize: 23n, isFullyFilled: false, ...overrides };
}

test('seaportVerdict: fills and cancels upgrade any state', () => {
  assert.equal(seaportVerdict('visible', seaport({ isFullyFilled: true, totalFilled: 23n })), 'filled');
  assert.equal(seaportVerdict('unfillable', seaport({ isFullyFilled: true, totalFilled: 23n })), 'filled');
  assert.equal(seaportVerdict('visible', seaport({ isCancelled: true })), 'cancelled');
  assert.equal(seaportVerdict('filled', seaport({ isCancelled: true, totalFilled: 3n })), 'cancelled');
  assert.equal(seaportVerdict('visible', seaport({ totalFilled: 3n })), 'partial');
  assert.equal(seaportVerdict('filled', seaport({ totalFilled: 3n })), 'partial', 'a book-filled row the chain says is only part-filled downgrades');
});

test('seaportVerdict: a chain-VALID untouched order revives a buried row; an invalid one does not', () => {
  // The book-latched states recover on the chain's say-so...
  assert.equal(seaportVerdict('filled', seaport({})), 'visible');
  assert.equal(seaportVerdict('partial', seaport({})), 'visible');
  assert.equal(seaportVerdict('unfillable', seaport({})), 'visible');
  // ...but a counter bump (invalidateAllListings, lockBook, rollClose) kills an order WITHOUT
  // setting isCancelled, and that must never bring a dead order back to /orders.
  assert.equal(seaportVerdict('unfillable', seaport({ isValidated: false })), 'unfillable');
  assert.equal(seaportVerdict('filled', seaport({ isValidated: false })), 'filled');
  // Latches and steady states.
  assert.equal(seaportVerdict('cancelled', seaport({})), 'cancelled');
  assert.equal(seaportVerdict('expired', seaport({})), 'expired');
  assert.equal(seaportVerdict('approved', seaport({})), 'approved');
  assert.equal(seaportVerdict('post_failed', seaport({})), 'post_failed');
});

test('bookVerdict: `filled` is believed only when the row’s own Seaport fields agree', () => {
  assert.equal(bookVerdict('visible', 'filled', 23n, 23n), 'filled');
  assert.equal(bookVerdict('visible', 'filled', 0n, 0n), undefined, 'no chain fields stamped: untouched');
  assert.equal(bookVerdict('visible', 'filled', 3n, 23n), undefined, 'chain says part-filled: untouched');
  // A chain-confirmed filled row is never downgraded by the book's say-so.
  assert.equal(bookVerdict('filled', 'open', 23n, 23n), undefined);
  assert.equal(bookVerdict('filled', 'partial', 23n, 23n), undefined);
});

test('bookVerdict: an `open` (re-)report confirms posts and revives `unfillable`', () => {
  assert.equal(bookVerdict('visible', 'partial', 3n, 23n), 'partial');
  assert.equal(bookVerdict('visible', 'unfillable', 0n, 23n), 'unfillable');
  assert.equal(bookVerdict('posted', 'open', 0n, 0n), 'visible');
  assert.equal(bookVerdict('post_failed', 'open', 0n, 0n), 'visible');
  assert.equal(bookVerdict('unfillable', 'open', 0n, 0n), 'visible', 'unfillable is a warning, not a death certificate');
  assert.equal(bookVerdict('posted', null, 0n, 0n), 'visible', 'in the book at all is visible');
  assert.equal(bookVerdict('approved', 'open', 0n, 0n), undefined);
  assert.equal(bookVerdict('cancelled', 'open', 0n, 0n), undefined);
});

test('isPostRetryable: approved, post_failed, and a partial the book never accepted', () => {
  assert.equal(isPostRetryable({ status: 'approved', api_status: null }), true);
  assert.equal(isPostRetryable({ status: 'post_failed', api_status: null }), true);
  assert.equal(
    isPostRetryable({ status: 'partial', api_status: null }),
    true,
    'an API outage at listing time plus one direct fill via /orders must not stop the repost',
  );
  assert.equal(isPostRetryable({ status: 'partial', api_status: 'open' }), false, 'the book has it');
  assert.equal(isPostRetryable({ status: 'visible', api_status: 'open' }), false);
  assert.equal(isPostRetryable({ status: 'filled', api_status: null }), false);
});

/* ---- rollClose: which assignment count gets published ---- */

const VAULT = process.env.VAULT as `0x${string}`;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const LOT = 1_000_000_000_000_000_000n;

/** A `RollClose(cycleNumber, assetsReturned, usdgFromAssignment, contractsAssignedCount)` log as
 *  the vault emits it (Vault.sol:801): the cycle number indexed, the three amounts in data. */
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

function receiptWith(...logs: Array<TransactionReceipt['logs'][number]>): TransactionReceipt {
  return { logs } as unknown as TransactionReceipt;
}

test("resolveContractsAssigned: the vault's RollClose is the number published; the pre-read is its cross-check", () => {
  const receipt = receiptWith(harvestLog(), rollCloseLog(9n));
  assert.deepEqual(resolveContractsAssigned(receipt, 9n), {
    assigned: 9,
    source: 'RollClose',
    fromEvent: 9n,
    fromClaim: 9n,
    mismatch: false,
  });
  // The two are read from the same Valorem claim across a window with no possible exercise, so
  // a disagreement is a defect: the event is still what gets published, and the caller warns.
  assert.deepEqual(resolveContractsAssigned(receipt, 4n), {
    assigned: 9,
    source: 'RollClose',
    fromEvent: 9n,
    fromClaim: 4n,
    mismatch: true,
  });
  // A failed pre-read (null, never a silent 0) is not a mismatch.
  assert.deepEqual(resolveContractsAssigned(receipt, null), {
    assigned: 9,
    source: 'RollClose',
    fromEvent: 9n,
    fromClaim: null,
    mismatch: false,
  });
});

test('resolveContractsAssigned: a RollClose count of 0 is a result, not a reason to fall through', () => {
  // Cycles 1 and 2 of the dry run: out of the money and unfilled. `0n ?? x` must stay 0n.
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
  assert.deepEqual(resolveContractsAssigned(receiptWith(), 0n), {
    assigned: 0,
    source: 'claim-preread',
    fromEvent: null,
    fromClaim: 0n,
    mismatch: false,
  });
  assert.deepEqual(resolveContractsAssigned(receiptWith(harvestLog()), null), {
    assigned: 0,
    source: 'unknown',
    fromEvent: null,
    fromClaim: null,
    mismatch: false,
  });
});
