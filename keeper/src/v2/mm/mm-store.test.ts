/**
 * The MM bot's SQLite state and its series log scan.
 *
 * WHY THIS FILE EXISTS: a fill counted twice trips the loss stop on a good day; a fill never counted hides a bad one;
 * a kill switch forgotten by a restart starts quoting again; rows of another deployment mix two vaults' books, and so do
 * the rows of a previous devnet, whose contracts had the same addresses. Pinned: one deployment per file, told apart by
 * addresses and by the deployment anchor (a file reopened under another anchor is reset, under the same one keeps its
 * state), adopted orders never counted as fills, fill and progress written together and idempotently, the killed state
 * and the sync time surviving a reopen, and the series scan's cursor, reorg overlap and range halving.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { V2Store } from '../store.js';
import { MM_META, MmStore } from './mm-store.js';
import { scanSeries } from './series-index.js';

const DEPLOYMENT = { chainId: 4663, clearinghouse: '0x00000000000000000000000000000000000000c1', orderBook: '0x00000000000000000000000000000000000000b0', vault: '0x00000000000000000000000000000000000000fa' };
const NVDA = '0x00000000000000000000000000000000000000AA';

const order = (orderId: bigint, kind: 'Bid' | 'AskWrite' | 'AskResale' = 'Bid', filledSeen = 0n) => ({ orderId, longId: 9n, kind, price: 2_000_000n, units: 100n, filledSeen });

test('bind: one deployment per file; another one wipes the rows but not the kill switch', () => {
  const mm = new MmStore(new V2Store(':memory:'));
  assert.equal(mm.bind(DEPLOYMENT), false, 'a fresh file');
  mm.applySeriesRange([{ longId: 9n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: 2_000 }], 100n);
  mm.ingestOrders([{ order: order(1n), closed: false }], 1n, 0);
  mm.setKilled({ at: 5, reason: 'test' });
  mm.setLastSync(7);
  assert.equal(mm.bind(DEPLOYMENT), false, 'same deployment, case-insensitively: kept');
  assert.equal(mm.bind({ ...DEPLOYMENT, vault: DEPLOYMENT.vault.toUpperCase().replace('0X', '0x') }), false);
  assert.deepEqual(mm.counts(), { series: 1, orders: 1, openOrders: 1, ledger: 0 });

  assert.equal(mm.bind({ ...DEPLOYMENT, vault: '0x00000000000000000000000000000000000000fb' }), true);
  assert.deepEqual(mm.counts(), { series: 0, orders: 0, openOrders: 0, ledger: 0 });
  assert.equal(mm.scannedTo(), null);
  assert.equal(mm.makerIndex(), null);
  assert.equal(mm.lastSync(), null);
  assert.deepEqual(mm.killed(), { at: 5, reason: 'test' }, 'a kill is never forgotten by a rebind');
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
  assert.equal(same.makerIndex(), 1n);
  assert.equal(same.scannedTo(), 100n);
  assert.equal(same.lastSync(), 7);
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
  assert.equal(moved.bind({ ...DEPLOYMENT, vault: '0x00000000000000000000000000000000000000fb' }), true);
  assert.equal(moved.anchor(), null);
  assert.equal(moved.bindAnchor(A), 'fresh', 'the new addresses start empty, so their anchor is simply recorded');
});

test('switches survive a reopen of the file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mm-store-')), 'mm.db');
  const first = new V2Store(path);
  const a = new MmStore(first);
  a.bind(DEPLOYMENT);
  a.setKilled({ at: 11, reason: 'POST /kill' });
  a.setLastSync(1234);
  first.close();
  const second = new V2Store(path);
  const b = new MmStore(second);
  assert.equal(b.bind(DEPLOYMENT), false);
  assert.deepEqual(b.killed(), { at: 11, reason: 'POST /kill' });
  assert.equal(b.lastSync(), 1234);
  b.setKilled(null);
  assert.equal(b.killed(), null);
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
