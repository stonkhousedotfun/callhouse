/**
 * The SQLite store, on a real file.
 *
 * WHY THIS FILE EXISTS: the store is the keeper's memory of what it has already done. Two things
 * about it cost money if they are wrong. A 256-bit value that goes through a SQLite INTEGER is
 * silently truncated, and the option id, the salt and the counter are all 256-bit — so every one
 * must survive as decimal TEXT and come back as the same bigint, or `cancelListing(components)`
 * is sent with a different order than the vault authorised. And the file must still hold every
 * row after the process is killed and reopened, because that is the whole point of having it.
 *
 * DELIBERATELY ABSENT: no `:memory:` database. The constructor resolves the path and creates the
 * directory, and restart-safety is only a test if there is a file to reopen.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-state-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'default', 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { KeeperStore, bigintReplacer, store } = await import('./state.js');
const { PLACEHOLDER_SIGNATURE, buildOrderComponents, componentsFromJson, componentsToJson, localOrderHash } =
  await import('./seaport.js');
type ListingRow = import('./state.js').ListingRow;
type OrderComponentsJson = import('./seaport.js').OrderComponentsJson;

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const VAULT = '0x1111111111111111111111111111111111111111';
const OPTION_ID = 56885395977254369119998982131173877604217583767740146085872832926902011297792n;
/** Bigger than 2^64, so a SQLite INTEGER could not hold it either. */
const SALT = 95941992777576660739888578361827826050802484697670100586800480598437555708740n;
/** Seaport bumps counters by a quasi-random amount; this one was observed on the real chain. */
const COUNTER = 645105783290196256915466989660461880n;

const components = buildOrderComponents({
  offerer: VAULT,
  optionId: OPTION_ID,
  contracts: 23n,
  unitPrice6: 873_192n,
  endTime: 1789761600n,
  counter: COUNTER,
  salt: SALT,
});
const orderHash = localOrderHash(components);

function listingRow(overrides: Partial<ListingRow> = {}): Omit<ListingRow, 'created_at' | 'updated_at'> {
  return {
    order_hash: orderHash,
    cycle_number: 1,
    seq: 1,
    option_id: OPTION_ID.toString(),
    contracts: '23',
    unit_price6: '873192',
    gross_usdg6: (873_192n * 23n).toString(),
    to_vault6: (829_533n * 23n).toString(),
    to_overcall6: (43_659n * 23n).toString(),
    end_time: 1789761600,
    counter: COUNTER.toString(),
    salt: SALT.toString(),
    components_json: JSON.stringify(componentsToJson(components)),
    signature: PLACEHOLDER_SIGNATURE,
    approve_tx: `0x${'aa'.repeat(32)}`,
    cancel_tx: null,
    status: 'approved',
    api_status: null,
    api_error: null,
    posted_at: null,
    visible_at: null,
    filled_numerator: null,
    filled_denominator: null,
    seaport_total_filled: null,
    seaport_total_size: null,
    seaport_cancelled: null,
    ...overrides,
  };
}

/*//////////////////////////////////////////////////////////////
                               TESTS
//////////////////////////////////////////////////////////////*/

test('the process-wide store opened at KEEPER_DB_PATH and created the directory', () => {
  assert.equal(store.path, join(scratch, 'default', 'keeper.db'));
  assert.ok(existsSync(store.path));
  assert.deepEqual(store.counts(), { cycles: 0, listings: 0, txs: 0, alerts: 0, meta: 0 });
});

test('cycles: ensureCycle never clobbers, updateCycle touches only allowed columns', () => {
  const db = new KeeperStore(join(scratch, 'cycles.db'));
  try {
    assert.equal(db.isCycleHandled(7), false);
    const created = db.ensureCycle(7, 'open');
    assert.equal(created.status, 'open');
    assert.equal(created.relists_used, 0);
    assert.equal(db.isCycleHandled(7), true);

    db.updateCycle(7, {
      option_id: OPTION_ID.toString(),
      strike_usdg6: '226000000',
      contracts: 23,
      exercise_ts: 1789761600,
      expiry_ts: 1789848000,
      lot_size: '1000000000000000000',
      roll_open_tx: `0x${'01'.repeat(32)}`,
      // Not in CYCLE_COLUMNS: the primary key and the timestamps the store owns. Ignored.
      cycle_number: 99,
      created_at: 1,
    } as Partial<import('./state.js').CycleRow>);

    const row = db.getCycle(7);
    assert.ok(row);
    assert.equal(row.option_id, OPTION_ID.toString());
    assert.equal(row.contracts, 23);
    assert.equal(row.cycle_number, 7, 'the key cannot be rewritten through the patch');
    assert.notEqual(row.created_at, 1);
    assert.equal(db.getCycle(99), null);

    // A second ensureCycle with a different status returns the existing row untouched.
    const again = db.ensureCycle(7, 'skipped');
    assert.equal(again.status, 'open');

    db.ensureCycle(8, 'skipped');
    db.updateCycle(8, { skip_reason: 'no-rung-in-band' });
    assert.equal(db.latestCycle()?.cycle_number, 8);
    assert.deepEqual(db.recentCycles(5).map((c) => c.cycle_number), [8, 7]);
    assert.equal(db.getCycle(8)?.skip_reason, 'no-rung-in-band');

    // An empty patch is a no-op, not a SQL error.
    db.updateCycle(7, {});
  } finally {
    db.close();
  }
});

test('listings: the components JSON round-trips through SQLite exactly', () => {
  const db = new KeeperStore(join(scratch, 'listings.db'));
  try {
    db.ensureCycle(1, 'open');
    db.insertListing(listingRow());
    // Inserting the same hash again is a no-op (ON CONFLICT DO NOTHING), not a crash.
    db.insertListing(listingRow({ status: 'filled' }));

    const row = db.getListing(orderHash);
    assert.ok(row);
    assert.equal(row.status, 'approved', 'the second insert did not overwrite the first');
    assert.equal(row.option_id, OPTION_ID.toString(), '77 decimal digits, intact');
    assert.equal(row.salt, SALT.toString());
    assert.equal(row.counter, COUNTER.toString());

    const back = componentsFromJson(JSON.parse(row.components_json) as OrderComponentsJson);
    assert.deepEqual(back, components, 'bigint -> string -> bigint, field for field');
    assert.equal(back.offer[0]?.identifierOrCriteria, OPTION_ID);
    assert.equal(back.salt, SALT);
    assert.equal(back.counter, COUNTER);
    assert.equal(localOrderHash(back), orderHash, 'the rehydrated order hashes to the authorised hash');

    assert.deepEqual(db.listingsForCycle(1).map((l) => l.seq), [1]);
    assert.equal(db.latestListingForCycle(1)?.order_hash, orderHash);
    assert.equal(db.latestListingForCycle(2), null);
  } finally {
    db.close();
  }
});

test('listings: updateListing writes only allowlisted columns and normalises bigints/booleans', () => {
  const db = new KeeperStore(join(scratch, 'listings-update.db'));
  try {
    db.insertListing(listingRow());
    db.updateListing(orderHash, {
      status: 'partial',
      seaport_total_filled: 3n.toString(),
      seaport_total_size: '23',
      seaport_cancelled: 0,
      posted_at: 1_700_000_000_000,
      // Outside LISTING_COLUMNS: the economics and the key are immutable once authorised.
      unit_price6: '1',
      order_hash: `0x${'ff'.repeat(32)}`,
      contracts: '1',
    });
    const row = db.getListing(orderHash);
    assert.ok(row);
    assert.equal(row.status, 'partial');
    assert.equal(row.seaport_total_filled, '3');
    assert.equal(row.seaport_total_size, '23');
    assert.equal(row.seaport_cancelled, 0);
    assert.equal(row.posted_at, 1_700_000_000_000);
    assert.equal(row.unit_price6, '873192', 'economics cannot be patched');
    assert.equal(row.contracts, '23');
    assert.equal(db.getListing(`0x${'ff'.repeat(32)}`), null, 'the key cannot be patched');
  } finally {
    db.close();
  }
});

test('listings: openListings hides rows past their endTime; liveListingsForCycle hides terminal ones', () => {
  const db = new KeeperStore(join(scratch, 'listings-open.db'));
  try {
    const hashes = ['approved', 'posted', 'visible', 'post_failed', 'partial', 'filled', 'cancelled', 'expired', 'unfillable'].map(
      (status, i) => {
        const hash = `0x${i.toString(16).padStart(64, '0')}`;
        db.insertListing(listingRow({ order_hash: hash, seq: i + 1, status: status as ListingRow['status'] }));
        return [status, hash] as const;
      },
    );
    const before = 1789761600 - 1;
    const after = 1789761600;

    // Before endTime: the five states a buyer can still act on are offered from /orders.
    assert.deepEqual(
      db.openListings(before).map((l) => l.status).sort(),
      ['approved', 'partial', 'post_failed', 'posted', 'visible'],
    );
    // At or past endTime Seaport rejects the fill, so nothing is offered.
    assert.deepEqual(db.openListings(after), []);

    // Live-for-the-cycle is stricter still: a partial is not relisted, it is still selling.
    assert.deepEqual(
      db.liveListingsForCycle(1).map((l) => l.status),
      ['approved', 'posted', 'visible', 'post_failed'],
    );
    assert.equal(hashes.length, 9);
  } finally {
    db.close();
  }
});

test('txs: pending -> resolved, with bigint block and gas stored as TEXT', () => {
  const db = new KeeperStore(join(scratch, 'txs.db'));
  try {
    const hash = `0x${'bb'.repeat(32)}`;
    db.recordTxSubmitted(hash, 'rollOpen', 3);
    db.recordTxSubmitted(hash, 'rollClose', 4); // same hash again: ignored, not duplicated
    assert.deepEqual(db.pendingTxs().map((t) => [t.hash, t.kind, t.cycle_number, t.status]), [[hash, 'rollOpen', 3, 'pending']]);

    db.recordTxResult(hash, 'success', 61_566_832n, 214_000n, null);
    assert.deepEqual(db.pendingTxs(), []);
    const row = db.getTx(hash);
    assert.ok(row);
    assert.equal(row.status, 'success');
    assert.equal(row.block_number, '61566832');
    assert.equal(row.gas_used, '214000');
    assert.equal(row.error, null);

    const reverted = `0x${'cc'.repeat(32)}`;
    db.recordTxSubmitted(reverted, 'approveListing', 3);
    db.recordTxResult(reverted, 'reverted', 61_566_833n, 90_000n, 'receipt status: reverted');
    assert.equal(db.getTx(reverted)?.status, 'reverted');

    // latestTxForCycle: the newest submission of a kind for a cycle, whatever its status. This
    // is how a cycle row written without its rollOpen hash recovers it.
    assert.equal(db.latestTxForCycle('rollOpen', 3)?.hash, hash);
    assert.equal(db.latestTxForCycle('rollClose', 4), null, 'the duplicate insert was ignored');
    assert.equal(db.latestTxForCycle('approveListing', 3)?.hash, reverted);
    assert.equal(db.latestTxForCycle('approveListing', 99), null);
    // Both rows were created inside the same millisecond, so their relative order is not
    // something the store promises; the set is.
    assert.deepEqual(db.recentTxs(10).map((t) => t.hash).sort(), [hash, reverted].sort());
    assert.equal(db.recentTxs(1).length, 1);
    assert.equal(db.getTx(`0x${'dd'.repeat(32)}`), null);
  } finally {
    db.close();
  }
});

test('alerts and meta: bigints are serialised, the heartbeat is a number', () => {
  const db = new KeeperStore(join(scratch, 'alerts.db'));
  try {
    const id = db.recordAlert('roll_open', 'info', 'wrote 23', { contracts: 23n, optionId: OPTION_ID }, false);
    db.markAlertDelivered(id);
    const [row] = db.recentAlerts(1);
    assert.ok(row);
    assert.equal(row.kind, 'roll_open');
    assert.equal(row.delivered, 1);
    assert.deepEqual(JSON.parse(row.data_json ?? 'null'), { contracts: '23', optionId: OPTION_ID.toString() });
    assert.equal(JSON.stringify({ x: 1n }, bigintReplacer), '{"x":"1"}');

    assert.equal(db.lastHeartbeat(), null);
    db.beat(1_700_000_000_123);
    assert.equal(db.lastHeartbeat(), 1_700_000_000_123);
    db.setMeta('skip_reason:5', 'no-rung-in-band');
    assert.equal(db.getMeta('skip_reason:5'), 'no-rung-in-band');
    assert.equal(db.getMeta('missing'), null);
    assert.equal(db.getMetaNumber('skip_reason:5'), null, 'a non-number reads as null, not NaN');
    db.setMeta('skip_reason:5', 'writes-halted');
    assert.equal(db.getMeta('skip_reason:5'), 'writes-halted', 'upsert');
  } finally {
    db.close();
  }
});

test('restart safety: close the file, reopen it, every row is still there', () => {
  const path = join(scratch, 'restart', 'keeper.db');
  const first = new KeeperStore(path);
  first.ensureCycle(1, 'open');
  first.updateCycle(1, { option_id: OPTION_ID.toString(), roll_open_tx: `0x${'01'.repeat(32)}` });
  first.insertListing(listingRow({ status: 'posted', posted_at: 1 }));
  first.recordTxSubmitted(`0x${'01'.repeat(32)}`, 'rollOpen', 1);
  first.recordTxResult(`0x${'01'.repeat(32)}`, 'success', 1n, 1n, null);
  first.recordAlert('roll_open', 'info', 'x', {}, true);
  first.beat(42);
  const countsBefore = first.counts();
  first.close();

  const second = new KeeperStore(path);
  try {
    assert.deepEqual(second.counts(), countsBefore);
    assert.deepEqual(second.counts(), { cycles: 1, listings: 1, txs: 1, alerts: 1, meta: 1 });
    assert.equal(second.getCycle(1)?.roll_open_tx, `0x${'01'.repeat(32)}`);
    assert.equal(second.lastHeartbeat(), 42);
    const row = second.getListing(orderHash);
    assert.ok(row);
    assert.equal(row.status, 'posted');
    const back = componentsFromJson(JSON.parse(row.components_json) as OrderComponentsJson);
    assert.deepEqual(back, components);
    assert.equal(second.getTx(`0x${'01'.repeat(32)}`)?.status, 'success');
  } finally {
    second.close();
  }
});
