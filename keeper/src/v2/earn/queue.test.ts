/**
 * earn/queue.ts: queued EarnVault withdrawals are paid automatically once the vault's
 * series settle. A mocked vault: processQueue serves up to `cash` entries per call while no position is open.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { drainQueue, type QueueView } from './queue.js';

/** A vault with entries [head..tail], `payable` of them affordable in total, and a position flag. */
function vault(init: { head: bigint; tail: bigint; payable: number; position: boolean; confirm?: boolean; venueUnreadable?: boolean }) {
  const s = { ...init };
  const sent: Array<{ maxEntries: number; headBefore: bigint }> = [];
  return {
    sent,
    settle: () => {
      s.position = false;
    },
    venueReads: () => {
      s.venueUnreadable = false;
    },
    io: {
      read: async (): Promise<QueueView> => ({ head: s.head, tail: s.tail, hasOpenPosition: s.position, venueUnreadable: s.venueUnreadable ?? false }),
      processQueue: async (maxEntries: number, headBefore: bigint) => {
        sent.push({ maxEntries, headBefore });
        if (init.confirm === false) return false;
        if (s.position) return true; // the contract serves nothing while a series is written
        if (s.venueUnreadable) return true; // Nor while the venue cannot be read
        const open = s.tail - s.head + 1n;
        const n = BigInt(Math.min(maxEntries, s.payable, Number(open > 0n ? open : 0n)));
        s.head += n;
        s.payable -= Number(n);
        return true;
      },
    },
  };
}

test('after the position settles, the queue is paid with no user action, across several calls', async () => {
  const v = vault({ head: 1n, tail: 25n, payable: 100, position: true });
  const held = await drainQueue(v.io, 10, 5);
  assert.equal(held.stop, 'open-position', 'nothing is sent while a series is written');
  assert.equal(v.sent.length, 0);

  v.settle(); // the series the vault wrote settles and prunes to none
  const r = await drainQueue(v.io, 10, 5);
  assert.equal(r.stop, 'empty');
  assert.equal(r.served, 25n);
  assert.equal(r.calls, 3, '10 + 10 + 5 entries');
  assert.deepEqual(v.sent.map((c) => c.headBefore), [1n, 11n, 21n]);
});

test('an empty queue sends nothing', async () => {
  const v = vault({ head: 4n, tail: 3n, payable: 10, position: false });
  const r = await drainQueue(v.io, 10, 5);
  assert.equal(r.stop, 'empty');
  assert.equal(v.sent.length, 0);
});

test('short of cash: one call that serves nothing stops the loop, and says so', async () => {
  const v = vault({ head: 1n, tail: 9n, payable: 4, position: false });
  const r = await drainQueue(v.io, 10, 5);
  assert.equal(r.served, 4n);
  assert.equal(r.stop, 'no-progress');
  assert.equal(r.calls, 2, 'the second call served nothing and the loop did not spin');
});

test('bounded: at most maxCalls per tick', async () => {
  const v = vault({ head: 1n, tail: 1_000n, payable: 10_000, position: false });
  const r = await drainQueue(v.io, 10, 3);
  assert.equal(r.stop, 'max-calls');
  assert.equal(r.calls, 3);
  assert.equal(r.served, 30n);
});

test('a send that did not land stops the loop', async () => {
  const v = vault({ head: 1n, tail: 5n, payable: 10, position: false, confirm: false });
  const r = await drainQueue(v.io, 10, 5);
  assert.equal(r.stop, 'not-confirmed');
  assert.equal(r.calls, 1);
});

test('nothing is sent while the vault cannot read its venue; once it reads, the queue is paid', async () => {
  const v = vault({ head: 1n, tail: 5n, payable: 10, position: false, venueUnreadable: true });
  const held = await drainQueue(v.io, 10, 5);
  assert.equal(held.stop, 'venue-unreadable');
  assert.equal(v.sent.length, 0, 'processQueue would serve nothing and spend gas');
  v.venueReads();
  const r = await drainQueue(v.io, 10, 5);
  assert.equal(r.stop, 'empty');
  assert.equal(r.served, 5n);
});

test('an open position is still named first when both hold', async () => {
  const v = vault({ head: 1n, tail: 5n, payable: 10, position: true, venueUnreadable: true });
  assert.equal((await drainQueue(v.io, 10, 5)).stop, 'open-position');
});
