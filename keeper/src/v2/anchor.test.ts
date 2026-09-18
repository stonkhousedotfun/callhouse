/**
 * The deployment anchor (anchor.ts) and the store helpers a reset uses (store.ts).
 *
 * WHY THIS FILE EXISTS: the signing modes' stores are bound to a deployment by addresses, and a devnet redeployed from
 * a pinned nonce has the same addresses every run. The anchor is what tells the runs apart; read wrong (the head's
 * hash, a case-sensitive compare, an absent block taken as "no anchor") it resets a production store on every restart
 * or never resets a stale one. Pinned: the deploy block's own hash, lower-cased; no RPC call without a deploy block;
 * a block the chain lacks throws; the five outcomes of a comparison; meta prefixes deleted literally; pending journal
 * rows dropped and nothing else.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorResets, anchorWarning, compareAnchor, readDeploymentAnchor } from './anchor.js';
import { V2Store } from './store.js';

test('readDeploymentAnchor: the registry deploy block and its hash, lower-cased; null without a deploy block; a missing block throws', async () => {
  const asked: Array<Record<string, unknown>> = [];
  const client = {
    getBlock: async (args: { blockNumber?: bigint }) => {
      asked.push(args);
      if (args.blockNumber === 99n) throw new Error('Block at number "99" could not be found.');
      return { number: args.blockNumber, hash: `0x${'AB'.repeat(32)}` };
    },
  };
  assert.equal(await readDeploymentAnchor(client as never, 65_100_000n), `65100000:0x${'ab'.repeat(32)}`);
  assert.deepEqual(asked, [{ blockNumber: 65_100_000n }], 'the deploy block itself, never the head');
  assert.equal(await readDeploymentAnchor({ getBlock: async () => assert.fail('no RPC call without a deploy block') } as never, null), null);
  await assert.rejects(readDeploymentAnchor(client as never, 99n), /could not be found/);
  await assert.rejects(readDeploymentAnchor({ getBlock: async () => ({ number: 5n, hash: null }) } as never, 5n), /the chain has no block 5/);
});

test('compareAnchor: fresh, same, changed, unverified, unanchored; only changed and unverified reset', () => {
  const A = `1:0x${'aa'.repeat(32)}`;
  const B = `1:0x${'bb'.repeat(32)}`;
  assert.equal(compareAnchor(null, A, false), 'fresh');
  assert.equal(compareAnchor(A, A, true), 'same');
  assert.equal(compareAnchor(A, B, true), 'changed');
  assert.equal(compareAnchor(A, B, false), 'changed', 'a recorded anchor that differs resets even an empty store');
  assert.equal(compareAnchor(null, A, true), 'unverified');
  assert.equal(compareAnchor(A, null, true), 'unanchored');
  assert.deepEqual((['fresh', 'same', 'changed', 'unverified', 'unanchored'] as const).filter(anchorResets), ['changed', 'unverified']);
  assert.equal(anchorWarning('same', 'the store'), null);
  assert.equal(anchorWarning('fresh', 'the store'), null);
  assert.match(anchorWarning('changed', 'the store')!, /another deployment at the same addresses/);
  assert.match(anchorWarning('unanchored', 'the store')!, /v2\.deployBlock is unset/);
});

test('store reset helpers: meta prefixes are literal (no LIKE wildcards) and keep what is asked; only pending journal rows are dropped', () => {
  const store = new V2Store(':memory:');
  for (const key of ['cranker:snapshot:a', 'cranker:index:deployment', 'crankerXsnapshot', 'cranker_snapshot', 'mm:killed', 'pricer:evaluated:0xr:1']) store.setMeta(key, '1');
  assert.equal(store.deleteMetaWithPrefix('cranker:', ['cranker:index:deployment']), 1);
  assert.equal(store.deleteMetaWithPrefix('cranker_'), 1, '`_` is not a wildcard');
  assert.deepEqual(
    (store.db.prepare('SELECT key FROM v2_meta ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key),
    ['cranker:index:deployment', 'crankerXsnapshot', 'mm:killed', 'pricer:evaluated:0xr:1'],
  );
  store.deleteMeta('mm:killed');
  assert.equal(store.getMeta('mm:killed'), null);

  store.recordTxSubmitted({ hash: '0x01', kind: 'settle', key: '1', nonce: 1, to: '0xc', functionName: 'settle' }, 10);
  store.recordTxSubmitted({ hash: '0x02', kind: 'settle', key: '2', nonce: 2, to: '0xc', functionName: 'settle' }, 11);
  store.recordTxResult('0x02', 'success', 5n, 21_000n, null, 12);
  assert.equal(store.dropPendingTxs('reset', 20), 1);
  assert.deepEqual([store.getTx('0x01')?.status, store.getTx('0x01')?.error, store.getTx('0x02')?.status], ['dropped', 'reset', 'success']);
  assert.deepEqual(store.pendingTxs(), []);
  store.close();
});
