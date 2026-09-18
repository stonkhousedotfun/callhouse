/**
 * The pricer's strategy list (strategies.ts): its StrategySet scan and the union with the indexer.
 *
 * WHY THIS FILE EXISTS: a writer missing from this list is never repriced, silently. Pinned: only
 * StrategySet logs of the configured roller count; the cursor and its rows move together and resume
 * with a reorg overlap; a range the node refuses is halved, not skipped; a restart reads the rows
 * back; the indexer's list adds to the log index and an indexer that is down, or a scan that fails,
 * leaves the other source in charge; a file reopened under another deployment anchor loses that
 * roller's rows and marks (only that roller's), under the same anchor it keeps them.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getAddress, type Address } from 'viem';
import { V2Store } from '../store.js';
import { evaluatedMetaKey, fairMissingMetaKey } from './pricer.js';
import { REORG_OVERLAP, StrategyIndex, anchorMetaKey, cursorMetaKey, listStrategies, pairsFromLogs, type LogClient } from './strategies.js';

const ROLLER = getAddress('0x00000000000000000000000000000000c0de0006');
const OTHER = getAddress('0x00000000000000000000000000000000c0de0099');
const BEN = getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65');
const ADA = getAddress('0x90f79bf6eb2c4f870365e785982e1f101e93b906');
const NVDA = getAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
const TSLA = getAddress('0x322F0929c4625eD5bAd873c95208D54E1c003b2d');

const log = (address: Address, writer: Address, underlying: Address, block: bigint, eventName = 'StrategySet') => ({ address, blockNumber: block, eventName, args: { writer, underlying } });

test('pairsFromLogs: StrategySet of the configured roller only, checksummed, with its block', () => {
  const rows = pairsFromLogs(
    [log(ROLLER, BEN, NVDA, 10n), log(OTHER, ADA, NVDA, 11n), log(ROLLER, ADA, TSLA, 12n, 'StrategyStopped'), { address: ROLLER.toLowerCase(), blockNumber: 13n, eventName: 'StrategySet', args: { writer: ADA.toLowerCase(), underlying: TSLA.toLowerCase() } }],
    ROLLER,
  );
  assert.deepEqual(rows, [
    { writer: BEN, underlying: NVDA, block: 10n },
    { writer: ADA, underlying: TSLA, block: 13n },
  ]);
});

test('scan: from the deploy block in chunks, resumes below the cursor, halves a refused range, and a restart keeps the rows', async () => {
  const store = new V2Store(':memory:');
  const index = new StrategyIndex(store, ROLLER);
  const ranges: Array<[bigint, bigint]> = [];
  let refuseWide = true;
  const client: LogClient = {
    getBlockNumber: (async () => 10n ** 12n) as never,
    getLogs: (async (args: { fromBlock: bigint; toBlock: bigint; address: Address }) => {
      assert.equal(args.address, ROLLER);
      if (refuseWide && args.toBlock - args.fromBlock + 1n > 500n) throw new Error('query exceeds max block range');
      ranges.push([args.fromBlock, args.toBlock]);
      const out = [];
      if (args.fromBlock <= 1_050n && 1_050n <= args.toBlock) out.push(log(ROLLER, BEN, NVDA, 1_050n));
      if (args.fromBlock <= 1_700n && 1_700n <= args.toBlock) out.push(log(ROLLER, BEN, NVDA, 1_700n), log(ROLLER, ADA, TSLA, 1_700n));
      return out;
    }) as never,
  };

  const first = await index.scan(client, { fromBlock: 1_000n, head: 1_999n, chunkBlocks: 1_000, maxChunks: 3 });
  // The node refuses 1000-block ranges: halved to 500, two ranges reach the head inside maxChunks.
  assert.deepEqual(ranges, [
    [1_000n, 1_499n],
    [1_500n, 1_999n],
  ]);
  assert.deepEqual(first, { fromBlock: 1_000n, toBlock: 1_999n, ranges: 2, logs: 3, caughtUp: true });
  assert.equal(index.scannedTo(), 1_999n);
  // Ordered by lower-case writer: 0x15d3… (ben) before 0x90f7… (ada); ben's second StrategySet is one row.
  assert.deepEqual(index.pairs(), [
    { writer: BEN, underlying: NVDA },
    { writer: ADA, underlying: TSLA },
  ]);

  refuseWide = false;
  ranges.length = 0;
  const second = await index.scan(client, { fromBlock: 1_000n, head: 2_010n, chunkBlocks: 1_000, maxChunks: 3 });
  assert.deepEqual(ranges, [[2_000n - REORG_OVERLAP, 2_010n]], 'the next scan re-reads the overlap below the cursor');
  assert.equal(second.caughtUp, true);

  // A new index over the same store (a restart) reads the rows back; another roller has none.
  assert.equal(new StrategyIndex(store, ROLLER).pairs().length, 2);
  assert.deepEqual(new StrategyIndex(store, OTHER).pairs(), []);
  assert.equal(new StrategyIndex(store, OTHER).scannedTo(), null);

  // maxChunks bounds a catching-up scan; a minimal range the node still refuses throws.
  const bounded = await new StrategyIndex(new V2Store(':memory:'), ROLLER).scan(client, { fromBlock: 0n, head: 10_000n, chunkBlocks: 1_000, maxChunks: 2 });
  assert.deepEqual([bounded.ranges, bounded.toBlock, bounded.caughtUp], [2, 1_999n, false]);
  const broken: LogClient = { getBlockNumber: (async () => 10n ** 12n) as never, getLogs: (async () => { throw new Error('rpc down'); }) as never };
  await assert.rejects(new StrategyIndex(new V2Store(':memory:'), ROLLER).scan(broken, { fromBlock: 0n, head: 10_000n, chunkBlocks: 400, maxChunks: 2 }), /rpc down/);
  store.close();
});

test('listStrategies: the log index ∪ the indexer\'s active strategies; the indexer down or the scan failing leaves the other source', async () => {
  const store = new V2Store(':memory:');
  const index = new StrategyIndex(store, ROLLER);
  index.applyRange([{ writer: BEN, underlying: NVDA, block: 5n }], 10n);
  const scanOk = async () => ({ fromBlock: 6n, toBlock: 10n, ranges: 1, logs: 0, caughtUp: true });

  const both = await listStrategies(index, { activeStrategies: async () => ({ ok: true, items: [{ writer: BEN, underlying: NVDA }, { writer: ADA, underlying: TSLA }] }) }, scanOk);
  assert.equal(both.indexer, 'ok');
  assert.equal(both.pairs.length, 2, 'deduplicated across sources');

  const down = await listStrategies(index, { activeStrategies: async () => ({ ok: false, reason: 'unreachable: fetch failed' }) }, scanOk);
  assert.equal(down.indexer, 'down (unreachable: fetch failed); log index only');
  assert.deepEqual(down.pairs, [{ writer: BEN, underlying: NVDA }]);

  const off = await listStrategies(index, null, async () => {
    throw new Error('HTTP request failed.\n\nURL: http://127.0.0.1:9');
  });
  assert.equal(off.indexer, 'off');
  assert.deepEqual(off.scan, { error: 'HTTP request failed.' });
  assert.deepEqual(off.pairs, [{ writer: BEN, underlying: NVDA }], 'rows of earlier scans still count');
  store.close();
});

test('bindAnchor: reopened under another anchor, the roller\'s rows, cursor and evaluation marks go (another roller\'s stay); under the same anchor they stay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pricer-anchor-')), 'pricer.db');
  const A = `65100000:0x${'aa'.repeat(32)}`;
  const B = `65100000:0x${'bb'.repeat(32)}`;
  const pair = { writer: BEN, underlying: NVDA };
  const marks = [cursorMetaKey(ROLLER), evaluatedMetaKey(ROLLER, pair), fairMissingMetaKey(ROLLER, pair)];

  const first = new V2Store(path);
  const index = new StrategyIndex(first, ROLLER);
  assert.equal(index.bindAnchor(A), 'fresh');
  index.applyRange([{ ...pair, block: 10n }], 20n);
  first.setMeta(evaluatedMetaKey(ROLLER, pair), JSON.stringify({ longId: '11', checkedAt: 5 }));
  first.setMeta(fairMissingMetaKey(ROLLER, pair), '5');
  const other = new StrategyIndex(first, OTHER);
  other.bindAnchor(A);
  other.applyRange([{ writer: ADA, underlying: TSLA, block: 10n }], 20n);
  first.setMeta(evaluatedMetaKey(OTHER, { writer: ADA, underlying: TSLA }), '{}');
  first.recordTxSubmitted({ hash: '0x01', kind: 'reprice', key: 'k', nonce: 1, to: ROLLER, functionName: 'reprice' });
  first.close();

  const second = new V2Store(path);
  const same = new StrategyIndex(second, ROLLER);
  assert.equal(same.bindAnchor(A), 'same');
  assert.deepEqual(same.pairs(), [pair]);
  assert.ok(marks.every((m) => second.getMeta(m) !== null));
  assert.equal(second.getTx('0x01')?.status, 'pending');
  second.close();

  const third = new V2Store(path);
  const fresh = new StrategyIndex(third, ROLLER);
  assert.equal(fresh.bindAnchor(B), 'changed');
  assert.deepEqual(fresh.pairs(), []);
  assert.equal(fresh.scannedTo(), null);
  assert.deepEqual(marks.filter((m) => third.getMeta(m) !== null), []);
  assert.equal(third.getMeta(anchorMetaKey(ROLLER)), B);
  assert.equal(third.getTx('0x01')?.status, 'dropped');
  const untouched = new StrategyIndex(third, OTHER);
  assert.deepEqual(untouched.pairs(), [{ writer: ADA, underlying: TSLA }], 'another roller is another namespace');
  assert.notEqual(third.getMeta(evaluatedMetaKey(OTHER, { writer: ADA, underlying: TSLA })), null);
  third.close();
});

test('bindAnchor: rows without an anchor are unverified and reset; no deploy block keeps them and records nothing', () => {
  const store = new V2Store(':memory:');
  const index = new StrategyIndex(store, ROLLER);
  index.applyRange([{ writer: BEN, underlying: NVDA, block: 10n }], 20n);
  assert.equal(index.bindAnchor(null), 'unanchored');
  assert.equal(index.pairs().length, 1);
  assert.equal(index.anchor(), null);
  assert.equal(index.bindAnchor(`1:0x${'aa'.repeat(32)}`), 'unverified');
  assert.deepEqual(index.pairs(), []);
  store.close();
});

test('scan: a head from a backup ahead of the primary never moves the cursor past the StrategySet logs the primary has', async () => {
  const index = new StrategyIndex(new V2Store(':memory:'), ROLLER);
  const primaryHead = { value: 1_400n };
  const client: LogClient = {
    getBlockNumber: (async () => primaryHead.value) as never,
    getLogs: (async (args: { fromBlock: bigint; toBlock: bigint }) => (args.fromBlock <= 1_420n && 1_420n <= args.toBlock && 1_420n <= primaryHead.value ? [log(ROLLER, BEN, NVDA, 1_420n)] : [])) as never,
  };
  await index.scan(client, { fromBlock: 1_000n, head: 1_450n, chunkBlocks: 1_000, maxChunks: 5 });
  assert.equal(index.scannedTo(), 1_400n);
  primaryHead.value = 1_460n;
  await index.scan(client, { fromBlock: 1_000n, head: 1_460n, chunkBlocks: 1_000, maxChunks: 5 });
  assert.deepEqual(index.pairs(), [{ writer: BEN, underlying: NVDA }]);
});
