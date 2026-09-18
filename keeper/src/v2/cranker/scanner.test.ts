/**
 * The cranker's log index: scanner.ts over a fake eth_getLogs, into index-store.ts on an in-memory
 * SQLite.
 *
 * WHY THIS FILE EXISTS: the index is what the cranker falls back to when the indexer is down, so its
 * failure modes are silent ones: a range the node refuses read as "no logs", a cursor that moves
 * without its rows (a crash skips a range), a transfer from another contract counted as a holder, a
 * store reused for another deployment cranking the old series, or for a fresh devnet at the same
 * addresses taking the old run's snapshots as sent. Pinned: ranges from the deploy block, bounded per
 * call, halved on refusal, restarted a few blocks back; rows filtered by emitter; one deployment per
 * store, by addresses and by deployment anchor.
 *
 * DELIBERATELY ABSENT: a node. v2:devnet-cycle scans a real one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Address } from 'viem';
import { V2Store } from '../store.js';
import { ALERTED_META_PREFIX } from './effects.js';
import { ANCHOR_META_KEY, CrankerIndex, DEPLOYMENT_META_KEY } from './index-store.js';
import { expiryKeyString } from './planner.js';
import { REORG_OVERLAP, rowsFromLogs, scanLogs, type LogClient } from './scanner.js';
import { ladderAnchorMetaKey, settledSeenMetaKey, snapshotMetaKey, sweepMetaKey } from './steps.js';

const CH: Address = '0x2256c045245288A314048aD2d71006a564343C63';
const BOOK: Address = '0x7bA861bC1ffC9b078dC2b74D7E83ac1E1327C5b0';
const ROLLER: Address = '0x00000000000000000000000000000000000000A1';
const NVDA: Address = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const ORACLE: Address = '0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78';
const ADA: Address = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const DEE: Address = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const log = (address: Address, eventName: string, args: Record<string, unknown>, blockNumber = 100n) => ({ address, eventName, args, blockNumber }) as never;

function freshIndex(): CrankerIndex {
  const index = new CrankerIndex(new V2Store(':memory:'));
  index.bind({ chainId: 4663, clearinghouse: CH, orderBook: BOOK, autoRoller: ROLLER });
  return index;
}

test('rowsFromLogs: series, holders (never the zero address, every id of a batch), orders, strategies; only from the configured emitters', () => {
  const rows = rowsFromLogs(
    [
      log(CH, 'SeriesCreated', { longId: 10n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: 1_789_761_600, oracle: ORACLE }),
      log(CH, 'TransferSingle', { operator: BOOK, from: ZERO, to: DEE, id: 10n, value: 5n }),
      log(CH, 'TransferSingle', { operator: CH, from: DEE, to: ZERO, id: 10n, value: 5n }), // a burn
      log(CH, 'TransferBatch', { operator: ADA, from: ADA, to: DEE, ids: [12n, 13n], values: [1n, 1n] }),
      log(BOOK, 'TransferSingle', { operator: BOOK, from: ZERO, to: ADA, id: 99n, value: 1n }), // not the Clearinghouse
      log(BOOK, 'OrderPlaced', { orderId: 30n, maker: DEE, longId: 10n, kind: 1, price: 1_440_000n, units: 150n, validUntil: 1_789_761_600 }),
      log(CH, 'OrderPlaced', { orderId: 31n, maker: DEE, longId: 10n, kind: 1, price: 1n, units: 1n, validUntil: 1 }), // wrong emitter
      log(ROLLER, 'StrategySet', { writer: ADA, underlying: NVDA, strategy: {} }),
    ],
    { clearinghouse: CH, orderBook: BOOK, autoRoller: ROLLER },
  );
  assert.deepEqual(rows.series, [{ longId: 10n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: 1_789_761_600, oracle: ORACLE }]);
  assert.deepEqual(rows.holders, [
    { tokenId: 10n, holder: DEE },
    { tokenId: 12n, holder: DEE },
    { tokenId: 13n, holder: DEE },
  ]);
  assert.deepEqual(rows.orders, [{ orderId: 30n, longId: 10n, maker: DEE, kind: 1, validUntil: 1_789_761_600 }]);
  assert.deepEqual(rows.strategies, [{ writer: ADA, underlying: NVDA }]);
  assert.deepEqual(rowsFromLogs([log(ROLLER, 'StrategySet', { writer: ADA, underlying: NVDA })], { clearinghouse: CH, orderBook: BOOK, autoRoller: null }).strategies, [], 'no roller configured');
});

test('scanLogs: from the deploy block in bounded ranges, the cursor moving with its rows; the next call restarts a few blocks back', async () => {
  const index = freshIndex();
  const calls: Array<[bigint, bigint]> = [];
  const client: LogClient = {
    getBlockNumber: (async () => 10n ** 12n) as never,
    getLogs: (async (args: { fromBlock: bigint; toBlock: bigint; address: Address[]; events: unknown[] }) => {
      calls.push([args.fromBlock, args.toBlock]);
      assert.deepEqual(args.address, [CH, BOOK, ROLLER]);
      assert.equal(args.events.length, 5);
      return args.fromBlock === 1_000n ? [log(CH, 'SeriesCreated', { longId: 10n, underlying: NVDA, isPut: false, strike: 1n, expiry: 5, oracle: ORACLE })] : [];
    }) as never,
  };
  const targets = { clearinghouse: CH, orderBook: BOOK, autoRoller: ROLLER, fromBlock: 1_000n };
  const first = await scanLogs(client, index, targets, { head: 1_450n, chunkBlocks: 100, maxChunks: 3 });
  assert.deepEqual(calls, [[1_000n, 1_099n], [1_100n, 1_199n], [1_200n, 1_299n]]);
  assert.deepEqual({ ranges: first.ranges, caughtUp: first.caughtUp, logs: first.logs }, { ranges: 3, caughtUp: false, logs: 1 });
  assert.equal(index.scannedTo(), 1_299n);
  assert.equal(index.seriesOf(NVDA, 5).length, 1);

  calls.length = 0;
  const second = await scanLogs(client, index, targets, { head: 1_450n, chunkBlocks: 100, maxChunks: 10 });
  // REORG_OVERLAP (100) back from the cursor at 1_299: 1_200, in 100-block ranges to the head.
  assert.deepEqual(calls, [[1_200n, 1_299n], [1_300n, 1_399n], [1_400n, 1_450n]]);
  assert.equal(REORG_OVERLAP, 100n);
  assert.equal(second.caughtUp, true);
  calls.length = 0;
  const idle = await scanLogs(client, index, targets, { head: 1_450n, chunkBlocks: 100, maxChunks: 10 });
  assert.deepEqual(calls, [[1_451n - REORG_OVERLAP, 1_450n]]);
  assert.equal(idle.caughtUp, true);
});

test('scanLogs: a refused range is halved down to 100 blocks, then the scan fails for this tick with the cursor where it was', async () => {
  const index = freshIndex();
  const sizes: bigint[] = [];
  const picky: LogClient = {
    getBlockNumber: (async () => 10n ** 12n) as never,
    getLogs: (async (args: { fromBlock: bigint; toBlock: bigint }) => {
      const size = args.toBlock - args.fromBlock + 1n;
      sizes.push(size);
      if (size > 250n) throw new Error('query returned more than 10000 results');
      return [];
    }) as never,
  };
  const result = await scanLogs(picky, index, { clearinghouse: CH, orderBook: BOOK, autoRoller: null, fromBlock: 0n }, { head: 10_000n, chunkBlocks: 1_000, maxChunks: 2 });
  assert.deepEqual(sizes, [1_000n, 500n, 250n, 250n]);
  assert.equal(result.chunkBlocks, 250n);
  assert.equal(index.scannedTo(), 499n);

  const broken: LogClient = { getBlockNumber: (async () => 10n ** 12n) as never, getLogs: (async () => Promise.reject(new Error('node down'))) as never };
  await assert.rejects(scanLogs(broken, index, { clearinghouse: CH, orderBook: BOOK, autoRoller: null, fromBlock: 0n }, { head: 10_000n, chunkBlocks: 400, maxChunks: 2 }), /node down/);
  assert.equal(index.scannedTo(), 499n, 'nothing moved');
});

test('CrankerIndex: one deployment per store; a roller added later keeps the rows but rescans; bookkeeping reads', () => {
  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  assert.equal(index.bind({ chainId: 4663, clearinghouse: CH, orderBook: BOOK, autoRoller: null }), false);
  index.applyRange(
    {
      series: [{ longId: 10n, underlying: NVDA, isPut: false, strike: 220n, expiry: 1_000, oracle: ORACLE }],
      holders: [{ tokenId: 10n, holder: DEE }, { tokenId: 10n, holder: DEE.toLowerCase() }],
      orders: [
        { orderId: 30n, longId: 10n, maker: DEE, kind: 1, validUntil: 1_000 },
        { orderId: 29n, longId: 10n, maker: ADA, kind: 2, validUntil: 900 },
        { orderId: 31n, longId: 10n, maker: ADA, kind: 0, validUntil: 2_000 },
      ],
      strategies: [],
      block: 50n,
    },
    50n,
  );
  assert.deepEqual(index.holdersOf(10n), [DEE.toLowerCase()], 'addresses are stored once, lower-case');
  assert.deepEqual(index.expiredOpenOrders(1_000, 10).map((o) => o.orderId), [29n, 30n]);
  index.markOrdersDead([29n]);
  assert.deepEqual(index.expiredOpenOrders(1_000, 10).map((o) => o.orderId), [30n]);
  index.markExpiryDone(ORACLE, NVDA, 1_000, 1_100);
  assert.ok(index.doneExpiries().has(expiryKeyString({ oracle: ORACLE, underlying: NVDA, expiry: 1_000 })), 'the done key is the planner\'s key');
  assert.deepEqual(index.expiries(), [{ oracle: ORACLE.toLowerCase(), underlying: NVDA.toLowerCase(), expiry: 1_000 }]);

  // Same deployment plus a roller: rows kept, cursor reset so StrategySet history is read.
  assert.equal(index.bind({ chainId: 4663, clearinghouse: CH, orderBook: BOOK, autoRoller: ROLLER }), false);
  assert.equal(index.scannedTo(), null);
  assert.equal(index.counts().series, 1);

  // Another clearinghouse: everything goes.
  assert.equal(index.bind({ chainId: 4663, clearinghouse: '0x00000000000000000000000000000000000000C1', orderBook: BOOK, autoRoller: ROLLER }), true);
  assert.deepEqual(index.counts(), { series: 0, holders: 0, orders: 0, openOrders: 0, strategies: 0, doneExpiries: 0 });
  store.close();
});

test('CrankerIndex.bindAnchor: reopened under another anchor, rows and every cranker mark go (the deployment id stays); under the same anchor they stay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cranker-anchor-')), 'cranker.db');
  const A = `65100000:0x${'aa'.repeat(32)}`;
  const B = `65100000:0x${'bb'.repeat(32)}`;
  const DEPLOYMENT = { chainId: 4663, clearinghouse: CH, orderBook: BOOK, autoRoller: ROLLER };
  const key = { oracle: ORACLE, underlying: NVDA, expiry: 1_000 };
  const marks = [snapshotMetaKey(key), settledSeenMetaKey(10n), ladderAnchorMetaKey(NVDA, 1_000, false, 'weekly'), sweepMetaKey(NVDA), `${ALERTED_META_PREFIX}v2_snapshot_missed:x`];

  const first = new V2Store(path);
  const a = new CrankerIndex(first);
  a.bind(DEPLOYMENT);
  assert.equal(a.bindAnchor(A), 'fresh');
  a.applyRange({ series: [{ longId: 10n, underlying: NVDA, isPut: false, strike: 220n, expiry: 1_000, oracle: ORACLE }], holders: [{ tokenId: 10n, holder: DEE }], orders: [], strategies: [{ writer: ADA, underlying: NVDA }], block: 50n }, 50n);
  a.markExpiryDone(ORACLE, NVDA, 1_000, 1_100);
  for (const m of marks) first.setMeta(m, '1');
  first.setMeta('mm:killed', '{}');
  first.recordTxSubmitted({ hash: '0x01', kind: 'snapshot', key: expiryKeyString(key), nonce: 1, to: ORACLE, functionName: 'snapshot' });
  first.close();

  const second = new V2Store(path);
  const same = new CrankerIndex(second);
  assert.equal(same.bind(DEPLOYMENT), false);
  assert.equal(same.bindAnchor(A), 'same', 'a restart on the same deployment');
  assert.deepEqual(same.counts(), { series: 1, holders: 1, orders: 0, openOrders: 0, strategies: 1, doneExpiries: 1 });
  assert.equal(same.scannedTo(), 50n);
  assert.ok(marks.every((m) => second.getMeta(m) !== null));
  assert.equal(second.getTx('0x01')?.status, 'pending');
  second.close();

  const third = new V2Store(path);
  const b = new CrankerIndex(third);
  assert.equal(b.bind(DEPLOYMENT), false, 'the addresses alone cannot tell');
  assert.equal(b.bindAnchor(B), 'changed');
  assert.deepEqual(b.counts(), { series: 0, holders: 0, orders: 0, openOrders: 0, strategies: 0, doneExpiries: 0 });
  assert.equal(b.scannedTo(), null);
  assert.deepEqual(marks.filter((m) => third.getMeta(m) !== null), [], 'no snapshot, settlement, ladder, sweep or alert mark of the old deployment');
  assert.notEqual(third.getMeta(DEPLOYMENT_META_KEY), null);
  assert.equal(third.getMeta(ANCHOR_META_KEY), B);
  assert.equal(third.getMeta('mm:killed'), '{}', 'another mode\'s keys are not the cranker\'s to delete');
  assert.equal(third.getTx('0x01')?.status, 'dropped');
  third.close();
});

test('CrankerIndex.bindAnchor: marks without an anchor are unverified and reset; no deploy block keeps them; a roller added keeps the anchor, another clearinghouse clears it', () => {
  const A = `1:0x${'aa'.repeat(32)}`;
  const legacy = new V2Store(':memory:');
  const index = new CrankerIndex(legacy);
  index.bind({ chainId: 4663, clearinghouse: CH, orderBook: BOOK, autoRoller: null });
  legacy.setMeta(sweepMetaKey(NVDA), '123');
  assert.equal(new CrankerIndex(legacy).bindAnchor(null), 'unanchored');
  assert.equal(legacy.getMeta(sweepMetaKey(NVDA)), '123');
  assert.equal(index.bindAnchor(A), 'unverified', 'a mark alone is state');
  assert.equal(legacy.getMeta(sweepMetaKey(NVDA)), null);

  assert.equal(index.bind({ chainId: 4663, clearinghouse: CH, orderBook: BOOK, autoRoller: ROLLER }), false);
  assert.equal(index.anchor(), A, 'a roller added to the same deployment keeps its anchor');
  assert.equal(index.bind({ chainId: 4663, clearinghouse: '0x00000000000000000000000000000000000000C1', orderBook: BOOK, autoRoller: ROLLER }), true);
  assert.equal(index.anchor(), null);
  assert.equal(index.bindAnchor(A), 'fresh');
  legacy.close();
});

/**
 * A primary RPC as measured on 4663: eth_getLogs past its own head answers without an error, with only the logs it has.
 * The tick's head comes from the fallback client, which may be a few blocks ahead of it.
 */
function laggingPrimary(chain: Array<{ block: bigint; log: unknown }>, head: { value: bigint }): LogClient {
  return {
    getBlockNumber: (async () => head.value) as never,
    getLogs: (async (args: { fromBlock: bigint; toBlock: bigint }) => chain.filter((l) => l.block >= args.fromBlock && l.block <= args.toBlock && l.block <= head.value).map((l) => l.log)) as never,
  };
}

test('scanLogs: a head read from a backup ahead of the primary never moves the cursor past the logs the primary has', async () => {
  const index = freshIndex();
  const primaryHead = { value: 1_400n };
  const client = laggingPrimary([{ block: 1_420n, log: log(CH, 'SeriesCreated', { longId: 10n, underlying: NVDA, isPut: false, strike: 1n, expiry: 5, oracle: ORACLE }, 1_420n) }], primaryHead);
  const targets = { clearinghouse: CH, orderBook: BOOK, autoRoller: null, fromBlock: 1_000n };
  await scanLogs(client, index, targets, { head: 1_450n, chunkBlocks: 1_000, maxChunks: 10 });
  assert.equal(index.scannedTo(), 1_400n, 'the cursor stops at the primary\'s head');
  primaryHead.value = 1_460n;
  await scanLogs(client, index, targets, { head: 1_460n, chunkBlocks: 1_000, maxChunks: 10 });
  assert.equal(index.seriesOf(NVDA, 5).length, 1, 'the series created in the gap is indexed');
  assert.ok(REORG_OVERLAP >= 50n, 'the overlap covers seconds of skew at 0.1 s blocks');
});
