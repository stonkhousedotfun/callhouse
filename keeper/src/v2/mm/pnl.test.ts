/**
 * The MM bot's realised profit and loss and its daily loss stop.
 *
 * WHY THIS FILE EXISTS: the loss stop is the bot's only bound on a quoter that trades the vault badly inside the
 * vault's price guards (MakerVault NatSpec). Pinned: average-cost realisation of closing fills either way, flips,
 * seller fees on sales, settlement at intrinsic value (a short call in the money loses exactly that), the UTC day a
 * result belongs to, the stop tripping at the limit and releasing the next day, and which order changes are fills.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFill, applySettlement, dayOf, fillOf, intrinsicAt, lossStop, netSalePrice, replayLedger, type Position, type TrackedOrder } from './pnl.js';

const DAY = 20_700; // a UTC day index
const T = DAY * 86_400 + 50_000;

test('applyFill: a sale closes a long at average cost, a purchase closes a short, the rest opens the other way', () => {
  const p: Position = { units: 0n, basis: 0n };
  assert.equal(applyFill(p, 'buy', 100n, 2_000_000n), 0n);
  assert.equal(applyFill(p, 'buy', 100n, 4_000_000n), 0n);
  assert.deepEqual(p, { units: 200n, basis: 600_000_000n }, 'average 3 USDG');
  assert.equal(applyFill(p, 'sell', 100n, 3_500_000n), 500_000n, 'one share sold 0.50 above the average');
  assert.deepEqual(p, { units: 100n, basis: 300_000_000n });

  assert.equal(applyFill(p, 'sell', 150n, 2_000_000n), -1_000_000n, 'the 100 long close 1 USDG under average; 50 open short');
  assert.deepEqual(p, { units: -50n, basis: 100_000_000n });
  assert.equal(applyFill(p, 'buy', 50n, 5_000_000n), -1_500_000n, 'the short bought back 3 above its sale price, half a share');
  assert.deepEqual(p, { units: 0n, basis: 0n });
  assert.equal(applyFill(p, 'buy', 0n, 1n), 0n);
});

test('seller fee and settlement: net sale price after the fee; intrinsic value at settlement closes the position', () => {
  assert.equal(netSalePrice(3_000_000n, 500), 2_850_000n);
  assert.equal(intrinsicAt(false, 220_000_000n, 225_000_000n), 5_000_000n);
  assert.equal(intrinsicAt(false, 220_000_000n, 215_000_000n), 0n);
  assert.equal(intrinsicAt(true, 220_000_000n, 215_000_000n), 5_000_000n);

  const shortCall: Position = { units: -100n, basis: 200_000_000n };
  assert.equal(applySettlement(shortCall, 5_000_000n), -3_000_000n, 'sold one share at 2, owes 5 at settlement');
  const longCall: Position = { units: 100n, basis: 150_000_000n };
  assert.equal(applySettlement(longCall, 0n), -1_500_000n, 'the premium paid, lost');
  assert.deepEqual(longCall, { units: 0n, basis: 0n });
  assert.equal(applySettlement({ units: 0n, basis: 0n }, 9n), 0n);
});

test('replayLedger and lossStop: realised by UTC day; the stop trips at the limit and releases on the next day', () => {
  const id = '42';
  const ledger = replayLedger([
    { type: 'fill', longId: id, side: 'sell', units: 100n, price: 2_000_000n, feeBps: 500, at: T },
    { type: 'fill', longId: '43', side: 'buy', units: 100n, price: 1_000_000n, feeBps: 0, at: T },
    { type: 'fill', longId: '43', side: 'sell', units: 100n, price: 1_500_000n, feeBps: 0, at: T + 10 },
    { type: 'settle', longId: id, isPut: false, strike: 220_000_000n, settlementPrice: 222_000_000n, at: T + 86_400 },
  ]);
  assert.equal(dayOf(T), DAY);
  assert.equal(ledger.realisedByDay.get(DAY), 500_000n, 'day one: +0.50 on the round trip; the open short is unrealised');
  assert.equal(ledger.realisedByDay.get(DAY + 1), -100_000n, 'day two: sold at 1.90 net of the 5 % fee, settled 2.00 in the money');
  assert.equal(ledger.positions.get(id)!.units, 0n);

  assert.deepEqual(lossStop(ledger, T + 86_400, 100_000n), { day: DAY + 1, realised: -100_000n, limit: 100_000n, tripped: true });
  assert.equal(lossStop(ledger, T + 86_400, 100_001n).tripped, false);
  assert.equal(lossStop(ledger, T, 1n).tripped, false, 'a profitable day');
  assert.equal(lossStop(ledger, T + 2 * 86_400, 1n).tripped, false, 'a new day starts at zero');
});

test('fillOf: a grown `filled` is a fill; escrowed orders past validUntil stay open until cancelled or pruned', () => {
  const tracked = (kind: TrackedOrder['kind'], filledSeen = 10n): TrackedOrder => ({ orderId: 7n, longId: 1n, kind, price: 2_000_000n, units: 100n, filledSeen });
  const bid = fillOf(tracked('Bid'), { filled: 30n, cancelled: false, units: 100n, validUntil: T + 60 }, T);
  assert.deepEqual([bid.units, bid.side, bid.closed, bid.filled], [20n, 'buy', false, 30n]);
  assert.equal(fillOf(tracked('AskWrite'), { filled: 10n, cancelled: false, units: 100n, validUntil: T + 60 }, T).units, 0n);
  assert.equal(fillOf(tracked('AskResale'), { filled: 40n, cancelled: false, units: 100n, validUntil: T + 60 }, T).side, 'sell');

  assert.equal(fillOf(tracked('Bid'), { filled: 10n, cancelled: false, units: 100n, validUntil: T }, T).closed, false, 'still escrows USDG');
  assert.equal(fillOf(tracked('AskResale'), { filled: 10n, cancelled: false, units: 100n, validUntil: T }, T).closed, false, 'still escrows longs');
  assert.equal(fillOf(tracked('AskWrite'), { filled: 10n, cancelled: false, units: 100n, validUntil: T }, T).closed, true);
  assert.equal(fillOf(tracked('Bid'), { filled: 10n, cancelled: true, units: 100n, validUntil: T + 60 }, T).closed, true);
  assert.equal(fillOf(tracked('Bid'), { filled: 100n, cancelled: false, units: 100n, validUntil: T + 60 }, T).closed, true);
});

test('settlement of a LONG position is booked net of the series\' exercise fee (the payout the long receives); a short loses the whole intrinsic', () => {
  const id = '42';
  const T = 1_790_000_000;
  const events = [
    { type: 'fill' as const, longId: id, side: 'buy' as const, units: 100n, price: 1_000_000n, feeBps: 0, at: T },
    { type: 'settle' as const, longId: id, isPut: false, strike: 220_000_000n, settlementPrice: 222_000_000n, exerciseFeeBps: 25, at: T + 86_400 },
  ];
  // Intrinsic 2.00, the long redeems 2.00 × (1 − 0.25 %) = 1.995 for a share bought at 1.00.
  assert.equal(replayLedger(events).realisedByDay.get(dayOf(T + 86_400)), 995_000n);
  const short = [
    { type: 'fill' as const, longId: id, side: 'sell' as const, units: 100n, price: 1_000_000n, feeBps: 0, at: T },
    { ...events[1]! },
  ];
  assert.equal(replayLedger(short).realisedByDay.get(dayOf(T + 86_400)), -1_000_000n, 'sold at 1.00, owes the full 2.00');
});
