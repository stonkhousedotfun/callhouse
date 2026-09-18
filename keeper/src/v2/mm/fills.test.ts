/**
 * The MM bot's sales booked at the seller fee the book really took (fills.ts), across a scheduled fee change.
 *
 * WHY THIS FILE EXISTS: since INTERFACE_VERSION 6 a fee change takes effect 24 h after it is scheduled, for every take
 * from then on. The bot sees a fill on its next poll, so a fill made at the old fees just before `effectiveAt` is seen at
 * the new ones. Booked at the fees read then, a resale fee cut from 10 % to 0 % adds 10 % of the premium to the booked
 * proceeds: the day's loss is understated and the daily loss stop does not trip when it must. Pinned: the sale is booked
 * from its OrderFilled logs (premium and seller fee exactly, whatever older fills of the order the range holds); when the
 * logs are unreadable or do not account for the fill, at the highest seller fee any regime in the interval can have
 * charged (the two ends' regimes, or the compiled ceiling across 24 h or without a previous look); bids read no logs; the
 * log read goes backwards from the head from the previous look's block, halving refused ranges; and the store keeps the
 * exact amounts and the checkpoint, and forgets the checkpoint with the deployment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';
import type { Address } from 'viem';
import { V2Store } from '../store.js';
import { KIND_INDEX, type OrderKindName } from './constants.js';
import { fillLogStart, trackVaultOrders } from './fills.js';
import { MM_META, MmStore } from './mm-store.js';
import { conservativeSellerFeeBps, exactNetSalePrice, lossStop, matchFillLogs, replayLedger, type FillLog } from './pnl.js';
import { readOrderFillLogs } from './reads.js';

const DEPLOYMENT = { chainId: 4663, clearinghouse: '0x00000000000000000000000000000000000000c1', orderBook: '0x00000000000000000000000000000000000000b0', vault: '0x00000000000000000000000000000000000000fa' };
const BOOK = DEPLOYMENT.orderBook as Address;
const VAULT = DEPLOYMENT.vault as Address;
const DAY = 86_400;
const T = 20_700 * DAY + 50_000;
const LONG = 9n;

/** The book's OrderFilled of one fill. premium = price × units / 100; sellerFee = premium × feeBps / 1e4, floored, as OrderBook computes them. */
function filled(orderId: bigint, units: bigint, price: bigint, feeBps: number, blockNumber: bigint, logIndex = 0, maker: string = VAULT): FillLog {
  const premium = (price * units) / 100n;
  return { orderId, maker, units, premium, sellerFee: (premium * BigInt(feeBps)) / 10_000n, blockNumber, logIndex };
}

interface ChainOrderRow {
  kind: OrderKindName;
  price: bigint;
  units: bigint;
  filled: bigint;
}

function harness() {
  const store = new V2Store(':memory:');
  const mm = new MmStore(store);
  mm.bind(DEPLOYMENT);
  const orders = new Map<bigint, ChainOrderRow>();
  const logs: FillLog[] = [];
  const logCalls: Array<{ fromBlock: bigint; toBlock: bigint; orderIds: bigint[] }> = [];
  let logsError: Error | null = null;
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      assert.equal(functionName, 'getOrders');
      return (args[0] as bigint[]).map((id) => {
        const o = orders.get(id)!;
        return { maker: VAULT, longId: LONG, kind: KIND_INDEX[o.kind], price: o.price, units: o.units, filled: o.filled, validUntil: T + 10 * DAY, cancelled: false };
      });
    },
  };
  const logClient = {
    getLogs: async ({ fromBlock, toBlock, args }: { fromBlock: bigint; toBlock: bigint; args: { orderId: bigint[] } }) => {
      logCalls.push({ fromBlock, toBlock, orderIds: args.orderId });
      if (logsError !== null) throw logsError;
      return logs
        .filter((l) => args.orderId.includes(l.orderId) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        .map((l) => ({ blockNumber: l.blockNumber, logIndex: l.logIndex, args: { orderId: l.orderId, longId: LONG, taker: '0x01', maker: l.maker, units: l.units, price: 0n, premium: l.premium, sellerFee: l.sellerFee, makerRebate: 0n, primary: false, takerIsBuyer: true, recipient: '0x01' } }));
    },
  };
  const warnings: string[] = [];
  const log = pino({ level: 'warn' }, { write: (line: string) => void warnings.push((JSON.parse(line) as { msg: string }).msg) });
  const deps = { client: client as never, logClient: logClient as never, mm, log, orderBook: BOOK, vault: VAULT, deployBlock: 0n };
  const place = (orderId: bigint, row: ChainOrderRow, filledSeen = 0n) => {
    orders.set(orderId, row);
    mm.ingestOrders([{ order: { orderId, longId: LONG, kind: row.kind, price: row.price, units: row.units, filledSeen }, closed: false }], orderId, 0);
  };
  return { mm, deps, orders, logs, logCalls, warnings, place, failLogs: (e: Error | null) => (logsError = e) };
}

const OLD = { premiumFeeBps: 500, resaleFeeBps: 1_000 };
const NEW = { premiumFeeBps: 500, resaleFeeBps: 0 };

/**
 * The vault bought 1 share of the series at 2.50 (a filled Bid) and lists it for resale at 2.00. Resale fee 10 %,
 * a cut to 0 % scheduled 24 h earlier takes effect at T + 30. A taker lifts the ask at T + 20 (block 105), paying the
 * old 10 %; the bot's next look is at T + 60 (block 110), after the cut.
 *   booked from the log:        proceeds 2.00 − 0.20 = 1.80 → realised (1.80 − 2.50) × 1 = −0.70
 *   booked at the fees read now: proceeds 2.00           → realised −0.50
 * With a 0.60 daily loss limit the stop must trip.
 */
async function boundary(h: ReturnType<typeof harness>) {
  h.place(1n, { kind: 'Bid', price: 2_500_000n, units: 100n, filled: 0n });
  h.place(2n, { kind: 'AskResale', price: 2_000_000n, units: 100n, filled: 0n });
  await trackVaultOrders(h.deps, OLD, { blockNumber: 90n, timestamp: T - 100 });
  // The bid fills at T - 50 (no seller fee for the vault), seen at T - 40 under the old fees.
  h.orders.get(1n)!.filled = 100n;
  await trackVaultOrders(h.deps, OLD, { blockNumber: 100n, timestamp: T - 40 });
  // The resale ask fills at T + 20, before effectiveAt = T + 30, at 10 %.
  h.orders.get(2n)!.filled = 100n;
  h.logs.push(filled(2n, 100n, 2_000_000n, 1_000, 105n));
}

test('across a fee activation: a resale fill made at 10 % and seen after the cut to 0 % is booked at 10 % from its log, and the loss stop trips', async () => {
  const h = harness();
  await boundary(h);
  const result = await trackVaultOrders(h.deps, NEW, { blockNumber: 110n, timestamp: T + 60 });

  assert.deepEqual(result.sales, { exact: 1, conservative: 0, logError: null });
  assert.deepEqual(h.logCalls.map((c) => [c.fromBlock, c.toBlock, c.orderIds]), [[96n, 110n, [2n]]], 'from the previous look\'s block less the reorg overlap, the sale\'s order only; the bid read no logs');
  const sale = h.mm.ledger().find((e) => e.type === 'fill' && e.side === 'sell');
  assert.deepEqual(sale, { type: 'fill', longId: '9', side: 'sell', units: 100n, price: 2_000_000n, feeBps: 1_000, premium: 2_000_000n, sellerFee: 200_000n, at: T + 60 });
  assert.deepEqual(result.fills.map((f) => [f.orderId, f.side, f.fee]), [[2n, 'sell', { basis: 'exact', feeBps: 1_000, sellerFee: 200_000n }]]);

  const ledger = replayLedger(h.mm.ledger());
  assert.equal(ledger.realisedByDay.get(Math.floor((T + 60) / DAY)), -700_000n);
  assert.equal(lossStop(ledger, T + 60, 600_000n).tripped, true, 'the stop trips on the real loss');
  // What the bot booked before: the fees in effect when the fill was seen.
  const naive = replayLedger(h.mm.ledger().map((e) => (e.type === 'fill' && e.side === 'sell' ? { type: 'fill', longId: e.longId, side: e.side, units: e.units, price: e.price, feeBps: NEW.resaleFeeBps, at: e.at } : e)));
  assert.equal(naive.realisedByDay.get(Math.floor((T + 60) / DAY)), -500_000n);
  assert.equal(lossStop(naive, T + 60, 600_000n).tripped, false, 'booked at the new fees the stop would not have tripped');
  assert.deepEqual(h.mm.fillCheckpoint(), { block: 110n, at: T + 60, ...NEW });
});

test('across a fee activation with the logs unreadable: booked at the higher of the two regimes (10 %), with a warning; the stop still trips', async () => {
  const h = harness();
  await boundary(h);
  h.failLogs(new Error('HTTP request failed: 503'));
  const result = await trackVaultOrders(h.deps, NEW, { blockNumber: 110n, timestamp: T + 60 });
  assert.equal(result.sales.exact, 0);
  assert.equal(result.sales.conservative, 1);
  assert.match(String(result.sales.logError), /503/);
  const sale = h.mm.ledger().find((e) => e.type === 'fill' && e.side === 'sell')!;
  assert.equal(sale.type === 'fill' && sale.feeBps, 1_000);
  assert.equal(sale.type === 'fill' && sale.sellerFee, undefined);
  assert.equal(lossStop(replayLedger(h.mm.ledger()), T + 60, 600_000n).tripped, true);
  assert.ok(h.warnings.some((w) => /OrderFilled logs unreadable/.test(w)));
  assert.ok(h.warnings.some((w) => /booked at the highest seller fee the interval allows/.test(w)));

  // The reverse change (0 % → 10 %) is booked at 10 % too: the higher end of the interval, whichever side it is on.
  const r = harness();
  r.place(2n, { kind: 'AskResale', price: 2_000_000n, units: 100n, filled: 0n });
  await trackVaultOrders(r.deps, NEW, { blockNumber: 100n, timestamp: T - 40 });
  r.orders.get(2n)!.filled = 100n;
  r.failLogs(new Error('refused'));
  await trackVaultOrders(r.deps, OLD, { blockNumber: 110n, timestamp: T + 60 });
  const raised = r.mm.ledger()[0]!;
  assert.equal(raised.type === 'fill' && raised.feeBps, 1_000);
});

test('logs that do not account for the fill, a gap of 24 h or more, or no previous look: the compiled ceiling (10 %)', async () => {
  // A 3 % → 0 % cut with the fill's log missing: inside 24 h the two ends bound it (3 %)...
  const within = harness();
  within.place(2n, { kind: 'AskResale', price: 2_000_000n, units: 100n, filled: 0n });
  await trackVaultOrders(within.deps, { premiumFeeBps: 500, resaleFeeBps: 300 }, { blockNumber: 100n, timestamp: T });
  within.orders.get(2n)!.filled = 100n;
  within.logs.push(filled(2n, 40n, 2_000_000n, 300, 105n)); // a log the node returned for only part of the fill
  await trackVaultOrders(within.deps, NEW, { blockNumber: 110n, timestamp: T + 600 });
  const a = within.mm.ledger()[0]!;
  assert.equal(a.type === 'fill' && a.feeBps, 300);
  assert.equal(a.type === 'fill' && a.sellerFee, undefined);

  // ...a day or more between looks can hide any number of changes...
  const gap = harness();
  gap.place(2n, { kind: 'AskResale', price: 2_000_000n, units: 100n, filled: 0n });
  await trackVaultOrders(gap.deps, { premiumFeeBps: 500, resaleFeeBps: 300 }, { blockNumber: 100n, timestamp: T });
  gap.orders.get(2n)!.filled = 100n;
  gap.failLogs(new Error('refused'));
  await trackVaultOrders(gap.deps, NEW, { blockNumber: 900_000n, timestamp: T + DAY });
  const b = gap.mm.ledger()[0]!;
  assert.equal(b.type === 'fill' && b.feeBps, 1_000);

  // ...and a store from before checkpoints has no previous look at all (its order was tracked by the old code).
  const legacy = harness();
  legacy.place(2n, { kind: 'AskWrite', price: 2_000_000n, units: 100n, filled: 50n });
  legacy.failLogs(new Error('refused'));
  const r = await trackVaultOrders(legacy.deps, NEW, { blockNumber: 500_000n, timestamp: T });
  const c = legacy.mm.ledger()[0]!;
  assert.deepEqual([c.type === 'fill' && c.units, c.type === 'fill' && c.feeBps, r.sales.conservative], [50n, 1_000, 1]);
});

test('exact from the logs whatever older fills of the order the range holds; another maker\'s log of the same id is ignored; bids read nothing', async () => {
  const h = harness();
  // 40 units filled earlier at 5 % (counted), then 60 more at 10 % since the previous look.
  h.place(2n, { kind: 'AskWrite', price: 2_000_000n, units: 100n, filled: 40n }, 40n);
  await trackVaultOrders(h.deps, { premiumFeeBps: 500, resaleFeeBps: 0 }, { blockNumber: 100n, timestamp: T });
  h.orders.get(2n)!.filled = 100n;
  h.logs.push(filled(2n, 40n, 2_000_000n, 500, 97n)); // older, inside the reorg overlap
  h.logs.push(filled(2n, 30n, 2_000_000n, 1_000, 104n, 3));
  h.logs.push(filled(2n, 30n, 2_000_000n, 1_000, 104n, 1));
  h.logs.push(filled(2n, 30n, 2_000_000n, 1_000, 104n, 3)); // a duplicate the node returned twice
  const result = await trackVaultOrders(h.deps, { premiumFeeBps: 0, resaleFeeBps: 0 }, { blockNumber: 110n, timestamp: T + 60 });
  assert.equal(result.sales.exact, 1);
  const sale = h.mm.ledger()[0]!;
  assert.deepEqual(sale.type === 'fill' && [sale.units, sale.premium, sale.sellerFee], [60n, 1_200_000n, 120_000n]);

  // A bid fill reads no logs and pays no seller fee.
  const b = harness();
  b.place(1n, { kind: 'Bid', price: 1_000_000n, units: 100n, filled: 0n });
  await trackVaultOrders(b.deps, OLD, { blockNumber: 100n, timestamp: T });
  b.orders.get(1n)!.filled = 25n;
  await trackVaultOrders(b.deps, NEW, { blockNumber: 110n, timestamp: T + 60 });
  assert.equal(b.logCalls.length, 0);
  const bid = b.mm.ledger()[0]!;
  assert.deepEqual(bid.type === 'fill' && [bid.side, bid.units, bid.feeBps, bid.sellerFee], ['buy', 25n, 0, undefined]);

  // A log of the same order id whose maker is not the vault is not the vault's fill.
  assert.equal(matchFillLogs(30n, [filled(2n, 30n, 1n, 0, 1n, 0, '0x00000000000000000000000000000000000000ee')].filter((l) => l.maker === VAULT)), null);
});

test('readOrderFillLogs: backwards from the head in ranges, halving a refused one, bounded; fillLogStart from the checkpoint', async () => {
  const ranges: string[] = [];
  const client = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 1_000n) throw new Error('range too large');
      ranges.push(`${fromBlock}-${toBlock}`);
      return toBlock >= 9_500n && fromBlock <= 9_500n ? [{ blockNumber: 9_500n, logIndex: 2, args: { orderId: 7n, maker: VAULT, units: 5n, premium: 10n, sellerFee: 1n } }] : [];
    },
  };
  const all = await readOrderFillLogs(client as never, { orderBook: BOOK, orderIds: [7n], fromBlock: 7_001n, toBlock: 10_000n, chunkBlocks: 2_000, maxChunks: 5 });
  assert.deepEqual(ranges, ['9001-10000', '8001-9000', '7001-8000']);
  assert.equal(all.coveredFrom, 7_001n);
  assert.deepEqual(all.logs, [{ orderId: 7n, maker: VAULT, units: 5n, premium: 10n, sellerFee: 1n, blockNumber: 9_500n, logIndex: 2 }]);

  ranges.length = 0;
  const bounded = await readOrderFillLogs(client as never, { orderBook: BOOK, orderIds: [7n], fromBlock: 0n, toBlock: 10_000n, chunkBlocks: 1_000, maxChunks: 2 });
  assert.deepEqual(ranges, ['9001-10000', '8001-9000']);
  assert.equal(bounded.coveredFrom, 8_001n);
  await assert.rejects(readOrderFillLogs({ getLogs: async () => Promise.reject(new Error('down')) } as never, { orderBook: BOOK, orderIds: [7n], fromBlock: 0n, toBlock: 10_000n, chunkBlocks: 400, maxChunks: 2 }), /down/);

  assert.equal(fillLogStart(100n, 110n, 0n), 96n);
  assert.equal(fillLogStart(null, 1_000_000n, 0n), 1_000_000n - 200_000n + 1n);
  assert.equal(fillLogStart(null, 1_000n, 0n), 0n);
  assert.equal(fillLogStart(2n, 1_000n, 50n), 50n, 'never below the deploy block');
});

test('pnl: the conservative rate, the log match, the exact net price', () => {
  const base = { current: NEW, now: T, delayS: DAY, ceilingBps: 1_000 };
  assert.equal(conservativeSellerFeeBps('AskResale', { ...base, previous: { regime: OLD, at: T - 60 } }), 1_000);
  assert.equal(conservativeSellerFeeBps('AskWrite', { ...base, previous: { regime: { premiumFeeBps: 200, resaleFeeBps: 0 }, at: T - 60 } }), 500, 'the current end is higher');
  assert.equal(conservativeSellerFeeBps('AskResale', { ...base, previous: { regime: { premiumFeeBps: 0, resaleFeeBps: 50 }, at: T - DAY } }), 1_000, 'a day apart: the ceiling');
  assert.equal(conservativeSellerFeeBps('AskResale', { ...base, previous: null }), 1_000);
  assert.equal(conservativeSellerFeeBps('Bid', { ...base, previous: null }), 0);

  assert.equal(matchFillLogs(50n, [filled(1n, 20n, 1_000_000n, 100, 5n), filled(1n, 30n, 1_000_000n, 100, 6n)])?.logs, 2);
  assert.equal(matchFillLogs(30n, [filled(1n, 20n, 1_000_000n, 100, 5n), filled(1n, 30n, 1_000_000n, 100, 6n)])?.sellerFee, 3_000n, 'the newest log only');
  assert.equal(matchFillLogs(25n, [filled(1n, 20n, 1_000_000n, 100, 5n), filled(1n, 30n, 1_000_000n, 100, 6n)]), null, 'no boundary at 25 units');
  assert.equal(matchFillLogs(60n, [filled(1n, 20n, 1_000_000n, 100, 5n), filled(1n, 30n, 1_000_000n, 100, 6n)]), null, 'the range does not reach far enough');
  assert.equal(matchFillLogs(0n, []), null);

  assert.equal(exactNetSalePrice(100n, 2_000_000n, 200_000n), 1_800_000n);
  assert.equal(exactNetSalePrice(3n, 10n, 1n), 300n, '(10 - 1) × 100 / 3, floored');
  assert.equal(exactNetSalePrice(100n, 5n, 5n), 0n);
});

test('the store keeps a sale\'s exact premium and fee and the checkpoint; a rebind to another deployment forgets the checkpoint', () => {
  const mm = new MmStore(new V2Store(':memory:'));
  mm.bind(DEPLOYMENT);
  mm.ingestOrders([{ order: { orderId: 1n, longId: LONG, kind: 'AskResale', price: 2_000_000n, units: 100n, filledSeen: 0n }, closed: false }], 1n, 0);
  const exact = { type: 'fill' as const, longId: '9', side: 'sell' as const, units: 100n, price: 2_000_000n, feeBps: 1_000, premium: 2_000_000n, sellerFee: 200_000n, at: T };
  mm.recordOrderProgress(1n, 100n, true, exact);
  assert.deepEqual(mm.ledger(), [exact]);
  assert.equal(mm.fillCheckpoint(), null);
  mm.setFillCheckpoint({ block: 110n, at: T, premiumFeeBps: 500, resaleFeeBps: 0 });
  assert.deepEqual(mm.fillCheckpoint(), { block: 110n, at: T, premiumFeeBps: 500, resaleFeeBps: 0 });
  mm.store.setMeta(MM_META.fillCheckpoint, 'not json');
  assert.equal(mm.fillCheckpoint(), null, 'an unreadable checkpoint is none: the next sale is booked conservatively');
  mm.setFillCheckpoint({ block: 110n, at: T, premiumFeeBps: 500, resaleFeeBps: 0 });
  assert.equal(mm.bind({ ...DEPLOYMENT, vault: '0x00000000000000000000000000000000000000fb' }), true);
  assert.equal(mm.fillCheckpoint(), null);
});
