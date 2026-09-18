/**
 * The v2 journal's growth (store.ts).
 *
 * WHY THIS FILE EXISTS: an MM bot journals tens of thousands of transactions a session day and every alert is stored.
 * Unpruned, the file grows by gigabytes a year on a volume of fixed size (SQLITE_FULL after a broadcast is a sent
 * transaction nobody journalled), and /state's newest-rows query sorts the whole table on the event loop. Pinned: old
 * resolved rows and old alerts go, pending rows and recent history stay; the newest rows are read through an index.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HISTORY_RETENTION_MS, V2Store } from './store.js';

const DAY = 86_400_000;

test('pruneHistory: resolved transactions and alerts older than the retention go; pending rows and recent history stay', () => {
  const store = new V2Store(':memory:');
  const now = 2_000_000_000_000;
  const old = now - HISTORY_RETENTION_MS - DAY;
  store.recordTxSubmitted({ hash: '0x01', kind: 'settle', key: '1', nonce: 1, to: '0xc1', functionName: 'settle' }, old);
  store.recordTxResult('0x01', 'success', 1n, 1n, null, old);
  store.recordTxSubmitted({ hash: '0x02', kind: 'settle', key: '2', nonce: 2, to: '0xc1', functionName: 'settle' }, old);
  store.recordTxSubmitted({ hash: '0x03', kind: 'settle', key: '3', nonce: 3, to: '0xc1', functionName: 'settle' }, now - DAY);
  store.recordTxResult('0x03', 'success', 1n, 1n, null, now - DAY);
  const delivered = store.recordAlert('v2_boot', 'info', 'online', {}, true, null, old);
  store.recordAlert('v2_low_gas', 'warn', 'low', {}, false, null, now - DAY);
  assert.ok(delivered > 0);

  assert.deepEqual(store.pruneHistory(now), { txs: 1, alerts: 1 });
  assert.equal(store.getTx('0x01'), null);
  assert.equal(store.getTx('0x02')?.status, 'pending', 'a pending row still guards its (kind, key)');
  assert.equal(store.getTx('0x03')?.status, 'success');
  assert.equal(store.counts().v2_alerts, 1);
});

test('recentTxs reads the newest rows through an index, not a sort of the whole journal', () => {
  const store = new V2Store(':memory:');
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM v2_txs ORDER BY created_at DESC, rowid DESC LIMIT 20").all() as Array<{ detail: string }>;
  assert.ok(plan.every((row) => !/TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
});
