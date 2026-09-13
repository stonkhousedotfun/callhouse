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
 *
 * DELIBERATELY ABSENT: no chain, no HTTP. roll.ts is imported for its pure exports only; the
 * RPC in the environment is a discard port.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-roll-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { bookVerdict, isPostRetryable, seaportVerdict } = await import('./roll.js');
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
