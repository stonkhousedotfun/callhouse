/**
 * The MM bot's SQLite state and its series log scan.
 *
 * WHY THIS FILE EXISTS: a fill counted twice trips the loss stop on a good day; a fill never counted hides a bad one;
 * a kill switch forgotten by a restart starts quoting again; rows of another deployment mix two vaults' books, and so do
 * the rows of a previous devnet, whose contracts had the same addresses. Pinned: one deployment per file, told apart by
 * addresses and by the deployment anchor (a file reopened under another anchor is reset, under the same one keeps its
 * state), adopted orders never counted as fills, fill and progress written together and idempotently, the killed state
 * and the sync time surviving a reopen, and the series scan's cursor, reorg overlap and range halving. Since T-OP-132
 * also: the pre-vault-column attribution is idempotent per ROW and probed at every bind - a legacy-shaped row that
 * appears after the `legacyVault` key is set (a rolled-back binary, a restored backup) is still the treasury's and is
 * attributed at the next boot, a row that carries a vault is never touched, and the key is only a fast path.
 *
 * ON THE VAULT-LESS FORM these tests use: `ingestOrders(rows, index, at)` with no vault writes `vault = ''` rows and the
 * un-suffixed meta keys - the pre-column shape - and every production call is vault-scoped (quoter.ts, fills.ts). So a
 * rebind attributes what the vault-less form wrote to the treasury, and state written that way is read back after a
 * rebind under the treasury's key, which is where the quoter reads it (`makerIndex(a.vault)`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { V2Store } from '../store.js';
import { MM_META, MmStore } from './mm-store.js';
import { replayLedger } from './pnl.js';
import { scanSeries } from './series-index.js';

const DEPLOYMENT = { chainId: 4663, clearinghouse: '0x00000000000000000000000000000000000000c1', orderBook: '0x00000000000000000000000000000000000000b0', vault: '0x00000000000000000000000000000000000000fa' };
const NVDA = '0x00000000000000000000000000000000000000AA';

const order = (orderId: bigint, kind: 'Bid' | 'AskWrite' | 'AskResale' = 'Bid', filledSeen = 0n) => ({ orderId, longId: 9n, kind, price: 2_000_000n, units: 100n, filledSeen });

test('bind: one deployment per file; another CORE wipes the rows but not the kill switch; adding a vault does not', () => {
  const mm = new MmStore(new V2Store(':memory:'));
  assert.equal(mm.bind(DEPLOYMENT), false, 'a fresh file');
  mm.applySeriesRange([{ longId: 9n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: 2_000 }], 100n);
  mm.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  mm.setKilled({ at: 5, reason: 'test' });
  mm.setLastSync(7);
  assert.equal(mm.bind(DEPLOYMENT), false, 'same deployment, case-insensitively: kept');
  assert.equal(mm.bind({ ...DEPLOYMENT, vault: DEPLOYMENT.vault.toUpperCase().replace('0X', '0x') }), false);
  assert.deepEqual(mm.counts(), { series: 1, orders: 1, openOrders: 1, ledger: 0 });

  const vaultB = '0x00000000000000000000000000000000000000fb';
  assert.equal(mm.bind({ ...DEPLOYMENT, vaults: [DEPLOYMENT.vault, vaultB] }), false, 'adding vault B does not wipe A');
  assert.deepEqual(mm.counts(), { series: 1, orders: 1, openOrders: 1, ledger: 0 });
  // The rebind attributed the vault-less writes to the treasury (T-OP-132): read back where the quoter reads them.
  assert.equal(mm.makerIndex(DEPLOYMENT.vault), 1n);
  assert.equal(mm.lastSync(DEPLOYMENT.vault), 7);
  assert.equal(mm.makerIndex(), null, 'the global key is moved, not copied');
  assert.deepEqual(mm.openOrders(DEPLOYMENT.vault).map((o) => o.orderId), [1n]);

  assert.equal(mm.bind({ ...DEPLOYMENT, orderBook: '0x00000000000000000000000000000000000000b1' }), true, 'another book is another core');
  assert.deepEqual(mm.counts(), { series: 0, orders: 0, openOrders: 0, ledger: 0 });
  assert.equal(mm.scannedTo(), null);
  assert.equal(mm.makerIndex(), null);
  assert.equal(mm.lastSync(), null);
  assert.deepEqual(mm.killed(), { at: 5, reason: 'test' }, 'a kill is never forgotten by a rebind');
});

test('bind: adding vault B leaves vault A\'s adopted orders, ledger and makerIndex intact', () => {
  const mm = new MmStore(new V2Store(':memory:'));
  const vaultA = DEPLOYMENT.vault;
  const vaultB = '0x00000000000000000000000000000000000000fb';
  mm.bind({ ...DEPLOYMENT, vault: vaultA });
  mm.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  const fill = { type: 'fill' as const, longId: '9', side: 'buy' as const, units: 30n, price: 2_000_000n, feeBps: 0, at: 100 };
  mm.recordOrderProgress(1n, 30n, false, fill);
  mm.setKilledFor(vaultA, { at: 9, reason: 'A only' });
  assert.equal(mm.bind({ ...DEPLOYMENT, vaults: [vaultA, vaultB] }), false);
  assert.equal(mm.makerIndex(vaultA), 1n, "A's index, under A's key after the rebind attributed it (T-OP-132)");
  assert.deepEqual(mm.openOrders(vaultA).map((o) => [o.orderId, o.filledSeen]), [[1n, 30n]]);
  assert.equal(mm.ledger(vaultA).length, 1);
  assert.equal(mm.makerIndex(vaultB), null, 'B inherits nothing');
  assert.deepEqual(mm.openOrders(vaultB), []);
  assert.deepEqual(mm.killedFor(vaultA), { at: 9, reason: 'A only' });
  assert.equal(mm.killedFor(vaultB), null);
  assert.equal(mm.killed(), null, 'process-wide kill is separate');
});

test("legacy rows are attributed to the treasury ONCE, and a second vault never inherits them", () => {
  const store = new V2Store(':memory:');
  const treasury = DEPLOYMENT.vault;
  const house = '0x00000000000000000000000000000000000000fb';

  // A file written before the vault column existed: rows land with vault ''.
  const before = new MmStore(store);
  before.bind({ ...DEPLOYMENT, vault: treasury });
  store.db.prepare("UPDATE v2_mm_orders SET vault = ''").run();
  before.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  before.recordOrderProgress(1n, 30n, false, { type: 'fill', longId: '9', side: 'buy', units: 30n, price: 2_000_000n, feeBps: 0, at: 100 });
  store.db.prepare("UPDATE v2_mm_orders SET vault = ''").run();
  store.db.prepare("UPDATE v2_mm_ledger SET vault = ''").run();
  store.deleteMeta(`${MM_META.makerIndex}:${treasury}`);
  store.setMeta(MM_META.makerIndex, '1');
  store.setMeta(MM_META.lastSync, '7');
  store.deleteMeta(MM_META.legacyVault);

  // The upgrade: the same file, now bound to the vault SET.
  const mm = new MmStore(store);
  mm.bind({ ...DEPLOYMENT, vaults: [treasury, house], treasury });

  assert.deepEqual(mm.openOrders(treasury).map((o) => o.orderId), [1n], "the live vault keeps its adopted orders");
  assert.equal(mm.ledger(treasury).length, 1);
  assert.equal(mm.makerIndex(treasury), 1n);
  assert.equal(mm.lastSync(treasury), 7);

  // THE POINT. A `vault = '' ` fallback in the reads, or a fall back to the un-suffixed meta key,
  // would hand every one of those to the House vault as well - and a makerIndex of 1 would make it
  // skip ingesting its own first order, silently and for ever.
  assert.deepEqual(mm.openOrders(house), [], "the House vault inherits no orders");
  assert.deepEqual(mm.ledger(house), [], "the House vault inherits no ledger");
  assert.equal(mm.makerIndex(house), null, "a vault that has never ingested reads null, not the treasury's index");
  assert.equal(mm.lastSync(house), null);
  assert.equal(store.getMeta(MM_META.makerIndex), null, "the global key is moved, not copied");

  // Idempotent PER ROW (T-OP-132): a later bind never touches a row that carries a vault - the House vault's order
  // stays the House vault's - and the treasury's rows are not attributed twice. This block used to force a House
  // row to `''` and pin that the flag alone stopped its re-attribution; under the row-shape rule a `''` row can only
  // have been written by the pre-column binary or the vault-less form, so it IS the treasury's and the next bind says
  // so (pinned below in "migrateLegacy is idempotent per row ...").
  mm.ingestOrders([{ order: order(2n), closed: false }], 1n, 0, house);
  mm.bind({ ...DEPLOYMENT, vaults: [treasury, house, '0x00000000000000000000000000000000000000fc'], treasury });
  assert.deepEqual(mm.openOrders(treasury).map((o) => o.orderId), [1n], 'the second bind attributes nothing to the treasury');
  assert.deepEqual(mm.openOrders(house).map((o) => o.orderId), [2n], "the House vault's row is untouched");
  assert.equal(mm.makerIndex(house), 1n);
});

/*//////////////////////////////////////////////////////////////
       migrateLegacy IS IDEMPOTENT PER ROW (T-OP-132, K8-05 suspicion 2)
//////////////////////////////////////////////////////////////*/

// The three cases the row names, at the shape a live treasury store can actually have. TODAY'S BEHAVIOUR before this
// change, measured at callhouse 0e7bdcca with a scratch script: (a) the meta key was the only guard and a bind to the
// same set returned before reaching the migration, so the rows a rolled-back binary left (`vault = ''`, `settle:<id>`,
// the un-suffixed makerIndex) stayed invisible to every strict read on both the same-set and the new-set rebind - order
// 2 and its fill were NEVER counted (`ledger(treasury)` 1, `openOrders(treasury)` [1n], `makerIndex(treasury)` 1n);
// (b) already held: the UPDATEs matched nothing and the key was set. Nothing was ever attributed TWICE: fills are keyed
// `fill:<orderId>:<filled>` and a vault carried by a row is never rewritten.
const THIRD = '0x00000000000000000000000000000000000000fb';
const SETTLE = { type: 'settle' as const, longId: '9', isPut: false, strike: 220_000_000n, settlementPrice: 230_000_000n, at: 200 };
const FILL = (at: number) => ({ type: 'fill' as const, longId: '9', side: 'buy' as const, units: 30n, price: 2_000_000n, feeBps: 0, at });
const shape = (store: V2Store) => ({
  orders: store.db.prepare('SELECT order_id, vault FROM v2_mm_orders ORDER BY order_id').all(),
  ledger: store.db.prepare('SELECT uniq, vault FROM v2_mm_ledger ORDER BY id').all(),
  meta: [MM_META.makerIndex, `${MM_META.makerIndex}:${DEPLOYMENT.vault}`, MM_META.lastSync, `${MM_META.lastSync}:${DEPLOYMENT.vault}`, MM_META.legacyVault].map((k) => [k, store.getMeta(k)]),
});

test('migrateLegacy (a): the key is set but a rolled-back binary left legacy-shaped rows - a bind to the SAME set attributes them, once, and never double-counts', () => {
  const store = new V2Store(':memory:');
  const treasury = DEPLOYMENT.vault;
  const mm = new MmStore(store);
  mm.bind({ ...DEPLOYMENT, vault: treasury });
  assert.equal(store.getMeta(MM_META.legacyVault), treasury, 'migrated (empty) at the first bind: the key is set');
  // The vault-scoped binary: order 1, its settlement in the treasury form, the scoped index.
  mm.ingestOrders([{ order: order(1n), closed: false }], 1n, 0, treasury);
  mm.recordSettlement(SETTLE, treasury);
  // The pre-column binary, rolled back over the same file (same bind id for a treasury-only set): order 2 and its
  // fill with `vault = ''`, the SAME settlement again under the legacy uniq, a global makerIndex ahead of the scoped
  // one, a global lastSync.
  mm.ingestOrders([{ order: order(2n), closed: false }], 2n, 0);
  mm.recordOrderProgress(2n, 30n, false, FILL(100));
  mm.recordSettlement(SETTLE);
  mm.setLastSync(7);
  assert.deepEqual(mm.openOrders(treasury).map((o) => o.orderId), [1n], 'before the bind, the strict read cannot see order 2');

  // The roll-forward: the same set, so bind takes its early return - which is where the probe now lives.
  assert.equal(mm.bind({ ...DEPLOYMENT, vault: treasury }), false);
  assert.deepEqual(mm.openOrders(treasury).map((o) => [o.orderId, o.filledSeen]), [[1n, 0n], [2n, 30n]], 'order 2 is the treasury\'s');
  assert.deepEqual(mm.ledger(treasury).map((e) => e.type), ['settle', 'fill'], 'ONE settlement, the fill counted once');
  assert.equal(mm.hasSettlement(9n, treasury), true);
  assert.equal(mm.hasSettlement(9n), false, 'no legacy-form settlement is left behind');
  assert.equal(mm.makerIndex(treasury), 1n, 'the scoped index stands; the global one is dropped (re-ingestion is INSERT OR IGNORE)');
  assert.equal(mm.makerIndex(), null);
  assert.equal(mm.lastSync(treasury), 7, 'a scoped key that was absent is filled from the global one');
  assert.equal(mm.lastSync(), null);
  assert.equal(mm.ledger(treasury).filter((e) => e.type === 'settle').length, 1, 'the older binary\'s duplicate settlement row is dropped, not kept beside its twin');

  // Idempotent: the same bind again, and a set change, change nothing (the probe finds no legacy shape; no writes).
  const after = shape(store);
  assert.equal(mm.bind({ ...DEPLOYMENT, vault: treasury }), false);
  assert.deepEqual(shape(store), after, 'a second same-set bind is a no-op');
  assert.equal(mm.bind({ ...DEPLOYMENT, vaults: [treasury, THIRD], treasury }), false);
  assert.deepEqual(shape(store), after, 'a set change on a migrated file is a no-op on the rows');
  assert.deepEqual(mm.openOrders(THIRD), [], 'and the new vault inherits nothing');
});

test('migrateLegacy (b): rows already rewritten but the key absent - a no-op on every migrated row, by shape not by key', () => {
  const store = new V2Store(':memory:');
  const treasury = DEPLOYMENT.vault;
  const mm = new MmStore(store);
  mm.bind({ ...DEPLOYMENT, vault: treasury });
  mm.ingestOrders([{ order: order(1n), closed: false }], 1n, 0, treasury);
  mm.recordOrderProgress(1n, 30n, false, FILL(100), treasury);
  mm.recordSettlement(SETTLE, treasury);
  mm.setLastSync(7, treasury);
  mm.ingestOrders([{ order: order(2n), closed: false }], 1n, 0, THIRD);
  store.deleteMeta(MM_META.legacyVault);
  const before = shape(store);

  assert.equal(mm.bind({ ...DEPLOYMENT, vaults: [treasury, THIRD], treasury }), false);
  assert.deepEqual(shape(store), { ...before, meta: before.meta.map(([k, v]) => (k === MM_META.legacyVault ? [k, treasury] : [k, v])) }, 'only the key changes');
  assert.deepEqual(mm.openOrders(THIRD).map((o) => o.orderId), [2n], "the other vault's row is never re-attributed");
  assert.deepEqual(mm.ledger(treasury).map((e) => e.type), ['fill', 'settle']);
  assert.equal(mm.hasSettlement(9n, treasury), true);
});

test('migrateLegacy (c): the normal path - a pre-column file bound once to the vault set - is unchanged', () => {
  const store = new V2Store(':memory:');
  const treasury = DEPLOYMENT.vault;
  const before = new MmStore(store);
  before.bind({ ...DEPLOYMENT, vault: treasury });
  before.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  before.recordOrderProgress(1n, 30n, false, FILL(100));
  before.recordSettlement(SETTLE);
  before.setLastSync(7);
  store.db.prepare("UPDATE v2_mm_orders SET vault = ''").run();
  store.db.prepare("UPDATE v2_mm_ledger SET vault = ''").run();
  store.deleteMeta(MM_META.legacyVault);

  const mm = new MmStore(store);
  assert.equal(mm.bind({ ...DEPLOYMENT, vaults: [treasury, THIRD], treasury }), false);
  assert.equal(store.getMeta(MM_META.legacyVault), treasury);
  assert.deepEqual(mm.openOrders(treasury).map((o) => [o.orderId, o.filledSeen]), [[1n, 30n]]);
  assert.deepEqual(mm.ledger(treasury).map((e) => e.type), ['fill', 'settle']);
  assert.equal(mm.hasSettlement(9n, treasury), true, 'the legacy settlement uniq is rewritten to the treasury form');
  assert.equal(mm.makerIndex(treasury), 1n);
  assert.equal(mm.lastSync(treasury), 7);
  assert.equal(store.getMeta(MM_META.makerIndex), null);
  assert.deepEqual(mm.openOrders(THIRD), []);
  assert.deepEqual(mm.ledger(THIRD), []);
});

test('TWO VAULTS SETTLE THE SAME SERIES and both are recorded (F-DAPP-01)', () => {
  const store = new V2Store(':memory:');
  const treasury = DEPLOYMENT.vault;
  const house = '0x00000000000000000000000000000000000000fb';
  const mm = new MmStore(store);
  mm.bind({ ...DEPLOYMENT, vaults: [treasury, house], treasury });

  const settle = (vault: string) => ({
    type: 'settle' as const,
    longId: '9',
    isPut: false,
    strike: 220_000_000n,
    settlementPrice: 250_000_000n,
    at: 1_000,
  });

  mm.recordSettlement(settle(treasury), treasury);
  mm.recordSettlement(settle(house), house);

  // THE BUG THIS REPLACES, and it is the worst one the multi-vault rewrite left behind. `uniq` is a globally
  // UNIQUE column. The key used to be `settle:<longId>` with the vault only alongside it as a column, so the
  // SECOND vault's INSERT OR IGNORE matched the FIRST vault's row and wrote nothing at all. Two vaults holding
  // one series is the normal steady state of this bot, so the second vault's settlement vanished: its expired
  // position was filtered out of `expired` for ever, never settled, and the realised loss never counted toward
  // ITS daily loss limit. No error, no alert, no retry - the loss stop kept answering healthy about a subject
  // it could not see.
  assert.equal(mm.hasSettlement(9n, treasury), true, 'the treasury recorded its settlement');
  assert.equal(mm.hasSettlement(9n, house), true, 'THE SECOND VAULT MUST RECORD ITS OWN, not be swallowed');
  assert.equal(mm.ledger(treasury).length, 1, "the treasury's ledger has exactly its own");
  assert.equal(mm.ledger(house).length, 1, "the House vault's ledger has exactly its own");

  // A vault that never settled it still answers false: the question is per vault in both directions.
  const third = '0x00000000000000000000000000000000000000fc';
  assert.equal(mm.hasSettlement(9n, third), false);
});

test('per-vault kill: one vault killed leaves the others quoting, and both marks survive a restart', () => {
  const store = new V2Store(':memory:');
  const treasury = DEPLOYMENT.vault;
  const house = '0x00000000000000000000000000000000000000fb';
  const mm = new MmStore(store);
  mm.bind({ ...DEPLOYMENT, vaults: [treasury, house], treasury });

  mm.setKilledFor(house, { at: 11, reason: 'house only' });
  assert.deepEqual(mm.killedFor(house), { at: 11, reason: 'house only' });
  assert.equal(mm.killedFor(treasury), null, 'the other vault still quotes');
  assert.equal(mm.killed(), null, 'no process-wide kill was asked for');

  const restarted = new MmStore(store);
  assert.deepEqual(restarted.killedFor(house), { at: 11, reason: 'house only' }, 'a kill is never forgotten');

  // POST /kill with no body: every vault, whatever its own mark says.
  restarted.setKilled({ at: 12, reason: 'all' });
  assert.deepEqual(restarted.killedFor(treasury), { at: 12, reason: 'all' });
  assert.deepEqual(restarted.killedFor(house), { at: 12, reason: 'all' }, 'the process-wide kill wins');
  restarted.setKilled(null);
  assert.equal(restarted.killedFor(treasury), null);
  assert.deepEqual(restarted.killedFor(house), { at: 11, reason: 'house only' }, 'resuming all does not resume one');
});

test('orders and fills: progress and its ledger row are one write; the same fill twice is one row; closed orders leave the open list', () => {
  const store = new V2Store(':memory:');
  const mm = new MmStore(store);
  mm.bind(DEPLOYMENT);
  mm.ingestOrders([{ order: order(1n), closed: false }, { order: order(2n, 'AskWrite', 40n), closed: false }], 2n, 0);
  mm.ingestOrders([{ order: order(1n), closed: false }], 2n, 0);
  assert.equal(mm.makerIndex(), 2n);
  assert.deepEqual(mm.openOrders().map((o) => [o.orderId, o.filledSeen]), [[1n, 0n], [2n, 40n]]);

  const fill = { type: 'fill' as const, longId: '9', side: 'buy' as const, units: 30n, price: 2_000_000n, feeBps: 0, at: 100 };
  mm.recordOrderProgress(1n, 30n, false, fill);
  mm.recordOrderProgress(1n, 30n, false, fill);
  assert.equal(mm.ledger().length, 1);
  assert.deepEqual(mm.ledger()[0], fill);
  assert.equal(mm.openOrders()[0]!.filledSeen, 30n);

  mm.recordOrderProgress(2n, 40n, true, null);
  assert.deepEqual(mm.openOrders().map((o) => o.orderId), [1n]);

  const settle = { type: 'settle' as const, longId: '9', isPut: false, strike: 220_000_000n, settlementPrice: 230_000_000n, at: 200 };
  assert.equal(mm.hasSettlement(9n), false);
  mm.recordSettlement(settle);
  mm.recordSettlement(settle);
  assert.equal(mm.hasSettlement(9n), true);
  assert.deepEqual(mm.ledger(), [fill, settle]);
});

test('bindAnchor: a file reopened under another deployment anchor is reset (kill switch kept, pending journal rows dropped); under the same anchor it keeps its state', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mm-anchor-')), 'mm.db');
  const A = '65100000:0x' + 'aa'.repeat(32);
  const B = '65100000:0x' + 'bb'.repeat(32);
  const fill = { type: 'fill' as const, longId: '9', side: 'buy' as const, units: 30n, price: 2_000_000n, feeBps: 0, at: 100 };
  const populate = (mm: MmStore) => {
    mm.applySeriesRange([{ longId: 9n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: 2_000 }], 100n);
    mm.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
    mm.recordOrderProgress(1n, 30n, false, fill);
    mm.setLastSync(7);
    mm.store.setMeta(`${MM_META.lossStopAlerted}20000`, '50');
  };

  // Deployment A: a fresh file records its anchor.
  const first = new V2Store(path);
  const a = new MmStore(first);
  assert.equal(a.bind(DEPLOYMENT), false);
  assert.equal(a.bindAnchor(A), 'fresh');
  populate(a);
  a.setKilled({ at: 5, reason: 'drill' });
  first.recordTxSubmitted({ hash: '0x01', kind: 'mm-place', key: '9:bid', nonce: 1, to: DEPLOYMENT.vault, functionName: 'place' });
  first.close();

  // A restart on the same deployment (production): everything kept, nothing dropped.
  const again = new V2Store(path);
  const same = new MmStore(again);
  assert.equal(same.bind(DEPLOYMENT), false);
  assert.equal(same.bindAnchor(A), 'same');
  assert.deepEqual(same.counts(), { series: 1, orders: 1, openOrders: 1, ledger: 1 });
  // The restart's bind attributed the vault-less writes to the treasury (T-OP-132): read under its key.
  assert.equal(same.makerIndex(DEPLOYMENT.vault), 1n);
  assert.equal(same.scannedTo(), 100n);
  assert.equal(same.lastSync(DEPLOYMENT.vault), 7);
  assert.equal(again.getTx('0x01')?.status, 'pending');
  again.close();

  // The same addresses on a fresh deployment (another devnet): reset, the kill switch kept, the journal released.
  const fresh = new V2Store(path);
  const b = new MmStore(fresh);
  assert.equal(b.bind(DEPLOYMENT), false, 'the addresses alone cannot tell');
  assert.equal(b.bindAnchor(B), 'changed');
  assert.deepEqual(b.counts(), { series: 0, orders: 0, openOrders: 0, ledger: 0 });
  assert.equal(b.makerIndex(), null);
  assert.equal(b.scannedTo(), null);
  assert.equal(b.lastSync(), null);
  assert.equal(fresh.getMeta(`${MM_META.lossStopAlerted}20000`), null);
  assert.equal(b.anchor(), B);
  assert.deepEqual(b.killed(), { at: 5, reason: 'drill' }, 'a kill is never forgotten');
  assert.equal(fresh.getTx('0x01')?.status, 'dropped');
  assert.equal(b.bindAnchor(B), 'same', 'and B is kept from then on');
  fresh.close();
});

test('bindAnchor: state without a recorded anchor is reset; no deploy block in the registry keeps the state and records nothing; an address rebind clears the anchor', () => {
  const A = '100:0x' + 'aa'.repeat(32);
  const legacy = new MmStore(new V2Store(':memory:'));
  legacy.bind(DEPLOYMENT);
  legacy.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  assert.equal(legacy.bindAnchor(A), 'unverified', 'a file from before anchors cannot be vouched for');
  assert.equal(legacy.makerIndex(), null);
  assert.equal(legacy.anchor(), A);

  const unanchored = new MmStore(new V2Store(':memory:'));
  unanchored.bind(DEPLOYMENT);
  unanchored.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  assert.equal(unanchored.bindAnchor(null), 'unanchored');
  assert.equal(unanchored.makerIndex(), 1n);
  assert.equal(unanchored.anchor(), null);

  const moved = new MmStore(new V2Store(':memory:'));
  moved.bind(DEPLOYMENT);
  moved.bindAnchor(A);
  moved.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  assert.equal(moved.bind({ ...DEPLOYMENT, orderBook: '0x00000000000000000000000000000000000000b1' }), true);
  assert.equal(moved.anchor(), null);
  assert.equal(moved.bindAnchor(A), 'fresh', 'the new addresses start empty, so their anchor is simply recorded');
});

test('switches survive a reopen of the file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mm-store-')), 'mm.db');
  const first = new V2Store(path);
  const a = new MmStore(first);
  a.bind(DEPLOYMENT);
  a.setKilled({ at: 11, reason: 'POST /kill' });
  a.setKilledFor(DEPLOYMENT.vault, { at: 12, reason: 'one vault' });
  a.setLastSync(1234);
  first.close();
  const second = new V2Store(path);
  const b = new MmStore(second);
  assert.equal(b.bind(DEPLOYMENT), false);
  assert.deepEqual(b.killed(), { at: 11, reason: 'POST /kill' });
  assert.deepEqual(b.killedFor(DEPLOYMENT.vault), { at: 11, reason: 'POST /kill' }, 'process-wide kill covers every vault');
  assert.equal(b.lastSync(DEPLOYMENT.vault), 1234, 'the reopen attributed the global key to the treasury (T-OP-132)');
  b.setKilled(null);
  assert.equal(b.killed(), null);
  assert.deepEqual(b.killedFor(DEPLOYMENT.vault), { at: 12, reason: 'one vault' }, 'per-vault kill survives clearing the process-wide mark');
  second.close();
});

test('series: live ones by expiry, lookups by id; the log scan pages from the deploy block, overlaps reorgs and halves refused ranges', async () => {
  const mm = new MmStore(new V2Store(':memory:'));
  mm.bind(DEPLOYMENT);
  const created = (longId: bigint, expiry: number, blockNumber: bigint) => ({ blockNumber, args: { longId, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry, oracle: NVDA, exerciseFeeBps: 25 } });
  const chain = [created(1n, 1_000, 105n), created(2n, 3_000, 150n), created(3n, 2_000, 260n)];
  const ranges: string[] = [];
  let refuse = true;
  const client = {
    getBlockNumber: async () => 10n ** 12n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (refuse && toBlock - fromBlock + 1n > 100n) {
        refuse = false;
        throw new Error('range too large');
      }
      ranges.push(`${fromBlock}-${toBlock}`);
      return chain.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const first = await scanSeries(client as never, mm, { clearinghouse: DEPLOYMENT.clearinghouse as `0x${string}`, deployBlock: 100n, head: 200n, chunkBlocks: 200 });
  assert.deepEqual(ranges, ['100-199', '200-200'], 'the refused 200-block range was halved to 100');
  assert.deepEqual([first.created, first.caughtUp, first.toBlock], [2, true, 200n]);
  assert.equal(mm.scannedTo(), 200n);

  ranges.length = 0;
  const second = await scanSeries(client as never, mm, { clearinghouse: DEPLOYMENT.clearinghouse as `0x${string}`, deployBlock: 100n, head: 300n, chunkBlocks: 1_000 });
  assert.deepEqual(ranges, ['101-300'], 'restarts REORG_OVERLAP blocks under the cursor (100, floored at the deploy block)');
  assert.equal(second.created, 3, 'the overlap re-reads the first two');
  assert.equal(mm.seriesCount(), 3, 'inserts are idempotent');

  assert.deepEqual(mm.liveSeries(1_500).map((s) => s.longId), [3n, 2n], 'expiring after now, nearest first');
  assert.equal(mm.liveSeries(1_500)[0]!.underlying, NVDA.toLowerCase());
  const byId = mm.seriesByIds([2n, 99n]);
  assert.deepEqual([...byId.keys()], ['2']);
  assert.equal(byId.get('2')!.expiry, 3_000);

  const capped = await scanSeries(client as never, mm, { clearinghouse: DEPLOYMENT.clearinghouse as `0x${string}`, deployBlock: 100n, head: 1_000n, chunkBlocks: 100, maxChunks: 2 });
  assert.equal(capped.ranges, 2);
  assert.equal(capped.caughtUp, false);
});

test('series scan: a head from a backup ahead of the primary never moves the cursor past the SeriesCreated logs the primary has', async () => {
  const mm = new MmStore(new V2Store(':memory:'));
  mm.bind(DEPLOYMENT);
  const primaryHead = { value: 1_400n };
  const client = {
    getBlockNumber: async () => primaryHead.value,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      fromBlock <= 1_420n && 1_420n <= toBlock && 1_420n <= primaryHead.value ? [{ blockNumber: 1_420n, args: { longId: 7n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: 9_000 } }] : [],
  };
  const clearinghouse = DEPLOYMENT.clearinghouse as `0x${string}`;
  await scanSeries(client as never, mm, { clearinghouse, deployBlock: 1_000n, head: 1_450n, chunkBlocks: 1_000 });
  assert.equal(mm.scannedTo(), 1_400n);
  primaryHead.value = 1_460n;
  await scanSeries(client as never, mm, { clearinghouse, deployBlock: 1_000n, head: 1_460n, chunkBlocks: 1_000 });
  assert.equal(mm.seriesCount(), 1);
});

test('a settlement row keeps its series\' exercise fee across a reopen (the loss stop books a long net of it)', () => {
  const mm = new MmStore(new V2Store(':memory:'));
  mm.bind(DEPLOYMENT);
  mm.recordSettlement({ type: 'settle', longId: '9', isPut: false, strike: 220_000_000n, settlementPrice: 222_000_000n, exerciseFeeBps: 25, at: 5 });
  const [row] = mm.ledger();
  assert.ok(row?.type === 'settle');
  assert.equal(row.exerciseFeeBps, 25);
});

/*
 * T-OP-092. The census said the F-DAPP-01 guard was KEYED but never EXECUTED end to end: the test above pins that two
 * settlements are both recorded, not that two LEDGERS both close. This one drives the shape `MmBot.ledgerStop`
 * (quoter.ts) runs per vault - open positions from the ledger, `expired` filtered with the PER-VAULT `hasSettlement`,
 * `recordSettlement` per vault, `replayLedger` again - over TWO vaults holding ONE expired series, without the chain
 * read in the middle (the settlement values are the ones `readSettlements` would have returned). Both positions must
 * end at zero units.
 *
 * PROVE-BY-BREAKING (authored; scratch only, mm-store.ts is outside this row's fence): make `settlementUniq` in
 * mm-store.ts drop the vault again (`settle:<longId>` for every caller) and this test goes red at the second vault -
 * its `INSERT OR IGNORE` matches the first vault's row, `hasSettlement(9n, house)` still answers true (the uniq
 * exists), so `expired` filters the series out, nothing is recorded for it, and its position stays at -100 units.
 */
test('TWO VAULTS holding ONE expired series: ledgerStop-shaped settlement closes BOTH ledgers, not just the first (F-DAPP-01 executed)', () => {
  const store = new V2Store(':memory:');
  const mm = new MmStore(store);
  const treasury = '0x00000000000000000000000000000000000000a1';
  const house = '0x00000000000000000000000000000000000000b2';
  const longId = 9n;
  const expiry = 1_790_000_000;
  const head = { timestamp: expiry + 60 };
  // Each vault wrote 100 units of the same call at 3 USDG (a Bid fill would be `buy`; a write is `sell`). Distinct
  // order ids: the fill uniq is `fill:<orderId>:<filled>` and is global.
  mm.recordOrderProgress(1n, 100n, true, { type: 'fill', longId: longId.toString(), side: 'sell', units: 100n, price: 3_000_000n, feeBps: 500, at: expiry - 3_600 }, treasury);
  mm.recordOrderProgress(2n, 100n, true, { type: 'fill', longId: longId.toString(), side: 'sell', units: 100n, price: 3_000_000n, feeBps: 500, at: expiry - 3_600 }, house);
  for (const vault of [treasury, house]) {
    assert.equal(replayLedger(mm.ledger(vault)).positions.get(longId.toString())?.units, -100n, `${vault} opened short 100 units`);
  }
  const chainSettlement = { isPut: false, strike: 200_000_000n, settlementPrice: 210_000_000n, exerciseFeeBps: 25 };

  // ledgerStop, per vault, as quoter.ts runs it (minus readSettlements).
  const settleFor = (vault: string): number => {
    const ledger = replayLedger(mm.ledger(vault));
    const open = [...ledger.positions].filter(([, p]) => p.units !== 0n).map(([id]) => BigInt(id));
    const expired = open.filter((id) => expiry <= head.timestamp && !mm.hasSettlement(id, vault));
    for (const id of expired) {
      mm.recordSettlement({ type: 'settle', longId: id.toString(), ...chainSettlement, at: head.timestamp }, vault);
    }
    return expired.length;
  };
  assert.equal(settleFor(treasury), 1, 'the treasury sees its expired series');
  assert.equal(settleFor(house), 1, 'the house vault sees ITS expired series too - the per-vault hasSettlement does not hide it behind the treasury\'s row');

  for (const vault of [treasury, house]) {
    const after = replayLedger(mm.ledger(vault));
    assert.equal(after.positions.get(longId.toString())?.units, 0n, `${vault}'s position closed at settlement`);
    assert.equal(mm.hasSettlement(longId, vault), true);
    assert.equal(mm.ledger(vault).filter((e) => e.type === 'settle').length, 1, `${vault} carries exactly one settlement row`);
  }
  // A third pass records nothing: both are settled, `expired` is empty for both.
  assert.equal(settleFor(treasury) + settleFor(house), 0);
});
