/**
 * Feeds index-store.ts from the v2 contracts' logs: SeriesCreated, TransferSingle, TransferBatch
 * (Clearinghouse), OrderPlaced (OrderBook), StrategySet (AutoRoller, when configured).
 *
 * One eth_getLogs per block range over all addresses and events, on the log client (pinned to
 * RH_RPC, chain.ts: a fallback RPC that refuses archive ranges would read as "nothing happened").
 * Ranges start at the registry's deploy block, move `chunkBlocks` at a time, and at most
 * `maxChunks` per call: a cranker catching up on a long history still finishes its tick. A range the
 * node refuses is halved (down to 100 blocks) before the scan gives up for this tick. The cursor and
 * the rows of a range are written in one SQLite transaction, so a crash never skips a range.
 *
 * THE HEAD. A scan never goes past the log client's OWN head, whatever head the tick read: the tick's head comes from
 * the fallback client and may be ahead of RH_RPC, which answers eth_getLogs past its head without an error, with only
 * the logs it has. A cursor moved to the tick's head would skip those blocks for good.
 *
 * REORGS. Each scan restarts REORG_OVERLAP blocks below the cursor; inserts are idempotent. Holder
 * rows are candidates only (balances are read from chain before any redeem), so a reorged-out
 * transfer costs one extra balanceOf, never a wrong redemption.
 */
import { getAbiItem, type AbiEvent, type Address, type Log, type PublicClient } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { orderBookAbi } from '../abi/orderBook.js';
import type { CrankerIndex, IndexedOrder, IndexedSeries } from './index-store.js';

/** 100 blocks: ~10 s at 4663's 0.1 s blocks, over the few blocks two nodes behind one RPC URL disagree by. */
export const REORG_OVERLAP = 100n;
const MIN_CHUNK = 100n;

const EVENTS = {
  seriesCreated: getAbiItem({ abi: clearinghouseAbi, name: 'SeriesCreated' }) as AbiEvent,
  transferSingle: getAbiItem({ abi: clearinghouseAbi, name: 'TransferSingle' }) as AbiEvent,
  transferBatch: getAbiItem({ abi: clearinghouseAbi, name: 'TransferBatch' }) as AbiEvent,
  orderPlaced: getAbiItem({ abi: orderBookAbi, name: 'OrderPlaced' }) as AbiEvent,
  strategySet: getAbiItem({ abi: autoRollerAbi, name: 'StrategySet' }) as AbiEvent,
};

export type LogClient = Pick<PublicClient, 'getLogs' | 'getBlockNumber'>;

export interface ScanTargets {
  clearinghouse: Address;
  orderBook: Address;
  autoRoller: Address | null;
  /** First block to scan when the index is empty (registry v2.deployBlock, else 0). */
  fromBlock: bigint;
}

export interface ScanResult {
  fromBlock: bigint | null;
  toBlock: bigint | null;
  ranges: number;
  logs: number;
  /** True when the index reached `head`. */
  caughtUp: boolean;
  /** The range size that worked last (after halving). */
  chunkBlocks: bigint;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type DecodedLog = Log<bigint, number, false> & { eventName?: string; args?: Record<string, unknown> };

/** The rows one batch of decoded logs contributes. Pure; exported for tests. */
export function rowsFromLogs(logs: readonly DecodedLog[], targets: Pick<ScanTargets, 'clearinghouse' | 'orderBook' | 'autoRoller'>) {
  const series: IndexedSeries[] = [];
  const holders: Array<{ tokenId: bigint; holder: string }> = [];
  const orders: IndexedOrder[] = [];
  const strategies: Array<{ writer: string; underlying: string }> = [];
  const zero = '0x0000000000000000000000000000000000000000';
  for (const log of logs) {
    const args = log.args ?? {};
    const from = log.address;
    switch (log.eventName) {
      case 'SeriesCreated':
        if (!same(from, targets.clearinghouse)) break;
        series.push({
          longId: args.longId as bigint,
          underlying: args.underlying as string,
          isPut: args.isPut as boolean,
          strike: args.strike as bigint,
          expiry: Number(args.expiry),
          oracle: args.oracle as string,
        });
        break;
      case 'TransferSingle':
        if (!same(from, targets.clearinghouse) || same(args.to as string, zero)) break;
        holders.push({ tokenId: args.id as bigint, holder: args.to as string });
        break;
      case 'TransferBatch':
        if (!same(from, targets.clearinghouse) || same(args.to as string, zero)) break;
        for (const id of args.ids as bigint[]) holders.push({ tokenId: id, holder: args.to as string });
        break;
      case 'OrderPlaced':
        if (!same(from, targets.orderBook)) break;
        orders.push({ orderId: args.orderId as bigint, longId: args.longId as bigint, maker: args.maker as string, kind: Number(args.kind), validUntil: Number(args.validUntil) });
        break;
      case 'StrategySet':
        if (targets.autoRoller === null || !same(from, targets.autoRoller)) break;
        strategies.push({ writer: args.writer as string, underlying: args.underlying as string });
        break;
      default:
        break;
    }
  }
  return { series, holders, orders, strategies };
}

/** Scan from the cursor towards `head`, at most `maxChunks` ranges. Throws only when even a minimal range fails. */
export async function scanLogs(
  client: LogClient,
  index: CrankerIndex,
  targets: ScanTargets,
  options: { head: bigint; chunkBlocks: number; maxChunks: number },
): Promise<ScanResult> {
  const cursor = index.scannedTo();
  let start = cursor === null ? targets.fromBlock : cursor + 1n - REORG_OVERLAP;
  if (start < targets.fromBlock) start = targets.fromBlock;
  let chunk = BigInt(options.chunkBlocks);
  const logHead = await client.getBlockNumber({ cacheTime: 0 });
  const head = logHead < options.head ? logHead : options.head;
  const result: ScanResult = { fromBlock: null, toBlock: null, ranges: 0, logs: 0, caughtUp: start > head, chunkBlocks: chunk };
  const address = [targets.clearinghouse, targets.orderBook, ...(targets.autoRoller === null ? [] : [targets.autoRoller])];
  const events = [EVENTS.seriesCreated, EVENTS.transferSingle, EVENTS.transferBatch, EVENTS.orderPlaced, ...(targets.autoRoller === null ? [] : [EVENTS.strategySet])];

  while (start <= head && result.ranges < options.maxChunks) {
    const to = start + chunk - 1n > head ? head : start + chunk - 1n;
    let logs: DecodedLog[];
    try {
      logs = (await client.getLogs({ address, events, fromBlock: start, toBlock: to, strict: false } as never)) as unknown as DecodedLog[];
    } catch (error) {
      if (chunk > MIN_CHUNK) {
        chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
        continue;
      }
      throw error;
    }
    const rows = rowsFromLogs(logs, targets);
    index.applyRange({ ...rows, block: to }, to);
    result.fromBlock ??= start;
    result.toBlock = to;
    result.ranges += 1;
    result.logs += logs.length;
    start = to + 1n;
  }
  result.caughtUp = start > head;
  result.chunkBlocks = chunk;
  return result;
}
