/**
 * The poll loop's wake-up (loop.ts).
 *
 * WHY THIS FILE EXISTS: the cranker's precise wake-up at an expiry calls wake(). When that lands
 * while a tick is still running (a tick that began a second before the expiry and is busy with a
 * ladder), dropping it would leave the snapshot to the next poll, a whole interval later, inside a
 * ten-minute window. Pinned: a wake during a tick runs the next tick right after it; a wake while
 * idle runs one at once; ticks never overlap; stop() ends it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLoop } from './loop.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('wake() during a tick runs the next tick right after it, not an interval later; never two at once', async () => {
  const starts: number[] = [];
  let running = 0;
  let maxRunning = 0;
  const t0 = Date.now();
  const loop = startLoop({
    intervalMs: 10_000,
    tick: async () => {
      starts.push(Date.now() - t0);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(60);
      running -= 1;
    },
    onError: () => {},
  });
  await sleep(20); // inside the first tick
  loop.wake();
  loop.wake(); // a second wake in the same tick is one pending wake
  await sleep(200);
  assert.equal(starts.length, 2, `ticks started at ${starts.join(', ')} ms`);
  assert.ok(starts[1]! < 150, `the woken tick followed the first at once (${starts[1]} ms), not after the 10 s interval`);
  assert.equal(maxRunning, 1);

  loop.wake(); // idle: at once
  await sleep(20);
  assert.equal(starts.length, 3);
  await loop.stop();
  loop.wake();
  await sleep(80);
  assert.equal(starts.length, 3, 'nothing after stop');
});

test('a tick that throws is handed to onError and the loop goes on', async () => {
  let ticks = 0;
  const errors: string[] = [];
  const loop = startLoop({
    intervalMs: 10,
    tick: async () => {
      ticks += 1;
      if (ticks === 1) throw new Error('boom');
    },
    onError: (e) => {
      errors.push((e as Error).message);
    },
  });
  await sleep(80);
  await loop.stop();
  assert.deepEqual(errors, ['boom']);
  assert.ok(ticks >= 2);
});
