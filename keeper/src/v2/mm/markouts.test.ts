/**
 * mm/markouts.ts: markouts at +1/+5/+30 min against the later fair, on a synthetic
 * fill stream, and the rolling 30-minute alert.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MarkoutBook, markoutBps, type MarkoutFill } from './markouts.js';

const T0 = 1_800_000_000;
const USDG = (n: number) => BigInt(Math.round(n * 1e6));
let order = 0n;
const fill = (over: Partial<MarkoutFill> = {}): MarkoutFill => ({ at: T0, orderId: ++order, longId: 7n, side: 'sell', units: 10n, price: USDG(2), ...over });

test('sign: positive is good for the vault, on both sides', () => {
  assert.equal(markoutBps('sell', USDG(2), USDG(1.8)), 1_000, 'sold at 2.00, worth 1.80 later: +10 %');
  assert.equal(markoutBps('sell', USDG(2), USDG(2.2)), -1_000, 'sold at 2.00, worth 2.20 later: picked off');
  assert.equal(markoutBps('buy', USDG(2), USDG(2.2)), 1_000);
  assert.equal(markoutBps('buy', USDG(2), USDG(1.8)), -1_000);
  assert.equal(markoutBps('sell', USDG(3), USDG(2.99)), 33.33, 'to 0.01 bps');
  assert.equal(markoutBps('sell', 0n, USDG(1)), null, 'no price, no ratio');
});

test('checkpoints fall due at +1, +5 and +30 minutes and each is stored once', () => {
  const book = new MarkoutBook();
  const key = book.record(fill());
  assert.deepEqual(book.due(T0 + 59), [], 'nothing before a minute');
  assert.deepEqual(book.due(T0 + 60), [7n]);
  assert.equal(book.observe(T0 + 60, () => USDG(1.9)), 1);
  assert.deepEqual(book.due(T0 + 61), [], 'the 1-minute mark is stored; the next is not due');
  assert.equal(book.observe(T0 + 300, () => USDG(2.1)), 1);
  assert.equal(book.observe(T0 + 1_800, () => USDG(2)), 1);
  assert.deepEqual(book.due(T0 + 99_999), [], 'all three stored');
  const [row] = book.snapshot();
  assert.equal(row!.key, key);
  assert.deepEqual(row!.marks, {
    '60s': { bps: 500, fair: USDG(1.9).toString(), lateS: 0 },
    '300s': { bps: -500, fair: USDG(2.1).toString(), lateS: 0 },
    '1800s': { bps: 0, fair: USDG(2).toString(), lateS: 0 },
  });
});

test('a tick that arrives late stores the mark with its real lateness, never as exact', () => {
  const book = new MarkoutBook();
  book.record(fill());
  book.observe(T0 + 75, () => USDG(1.9));
  const marks = book.snapshot()[0]!.marks as Record<string, unknown>;
  assert.deepEqual(marks['60s'], { bps: 500, fair: USDG(1.9).toString(), lateS: 15 });
  assert.equal(marks['300s'], 'pending');
});

test('no fair: the checkpoint waits, then is given up as missing and never counts', () => {
  const book = new MarkoutBook({ giveUpS: 600, keep: 100 });
  book.record(fill());
  assert.equal(book.observe(T0 + 1_800, () => null), 2, '1- and 5-minute checkpoints are past horizon + giveUp and are given up');
  assert.equal((book.snapshot()[0]!.marks as Record<string, unknown>)['1800s'], 'pending', 'the 30-minute one is still inside its grace');
  book.observe(T0 + 1_800 + 600, () => undefined);
  assert.equal((book.snapshot()[0]!.marks as Record<string, unknown>)['1800s'], 'missing');
  assert.equal(book.alert({ thresholdBps: 0, minFills: 1 }), null, 'a missing mark is not a bad mark');
});

test('the alert: the recent 30-minute markouts, notional-weighted, below the threshold', () => {
  const book = new MarkoutBook();
  // Three picked-off sells and one large well-marked sell.
  book.record(fill({ units: 1n }));
  book.record(fill({ units: 1n }));
  book.record(fill({ units: 1n }));
  book.observe(T0 + 1_800, () => USDG(2.2)); // -1000 bps each
  assert.deepEqual(book.alert({ thresholdBps: -200, minFills: 3 }), { fills: 3, meanBps: -1_000, thresholdBps: -200, worst: { key: book.snapshot()[2]!.key, bps: -1_000 } });
  assert.equal(book.alert({ thresholdBps: -200, minFills: 4 }), null, 'not enough fills yet');

  book.record(fill({ at: T0 + 60, units: 100n }));
  book.observe(T0 + 60 + 1_800, () => USDG(1.9)); // +500 bps, 100x the notional
  const a = book.alert({ thresholdBps: -200, minFills: 4 });
  assert.equal(a, null, 'the large good fill dominates the weighted mean: (3 x -1000 + 100 x 500) / 103 > -200');
});

test('bounded memory: only the last `keep` fills are held', () => {
  const book = new MarkoutBook({ giveUpS: 600, keep: 3 });
  for (let i = 0; i < 5; i += 1) book.record(fill({ at: T0 + i }));
  assert.equal(book.snapshot(99).length, 3);
});

test('buys and sells in one stream are each marked on their own side', () => {
  const book = new MarkoutBook();
  book.record(fill({ side: 'sell', longId: 7n }));
  book.record(fill({ side: 'buy', longId: 8n }));
  book.observe(T0 + 1_800, (id) => (id === 7n ? USDG(2.2) : USDG(2.2)));
  const rows = book.snapshot();
  const bps = (i: number) => ((rows[i]!.marks as Record<string, { bps: number }>)['1800s']!.bps);
  assert.equal(bps(0), 1_000, 'the buy at 2.00 is worth 2.20 later');
  assert.equal(bps(1), -1_000, 'the sell at 2.00 is worth 2.20 later');
});
