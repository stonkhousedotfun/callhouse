/**
 * Which series exist: Clearinghouse SeriesCreated logs into v2_mm_series, from the registry's deploy
 * block, LOG_CHUNK_BLOCKS at a time and at most LOG_CHUNKS_PER_TICK ranges per tick, each range and the
 * cursor in one SQLite transaction, restarting SERIES_REORG_OVERLAP blocks under the cursor (inserts are
 * idempotent). A range the node refuses is halved down to 100 blocks before the tick gives up. The log
 * client is pinned to RH_RPC (chain.ts: a fallback that refuses archive ranges would read as "no series"), and the scan
 * never goes past that client's own head (cranker/scanner.ts THE HEAD).
 */
import { getAbiItem, type AbiEvent, type Address, type PublicClient } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import type { SeriesInfo } from './engine.js';
import { LOG_CHUNK_BLOCKS, LOG_CHUNKS_PER_TICK, SERIES_REORG_OVERLAP } from './constants.js';
import type { MmStore } from './mm-store.js';

const SERIES_CREATED = getAbiItem({ abi: clearinghouseAbi, name: 'SeriesCreated' }) as AbiEvent;
const MIN_CHUNK = 100n;

export interface SeriesScan {
  fromBlock: bigint | null;
  toBlock: bigint | null;
  ranges: number;
  created: number;
  caughtUp: boolean;
}

export async function scanSeries(
  client: Pick<PublicClient, 'getLogs' | 'getBlockNumber'>,
  store: MmStore,
  options: { clearinghouse: Address; deployBlock: bigint; head: bigint; chunkBlocks?: number; maxChunks?: number },
): Promise<SeriesScan> {
  const cursor = store.scannedTo();
  let start = cursor === null ? options.deployBlock : cursor + 1n - SERIES_REORG_OVERLAP;
  if (start < options.deployBlock) start = options.deployBlock;
  let chunk = BigInt(options.chunkBlocks ?? LOG_CHUNK_BLOCKS);
  const maxChunks = options.maxChunks ?? LOG_CHUNKS_PER_TICK;
  const logHead = await client.getBlockNumber({ cacheTime: 0 });
  const head = logHead < options.head ? logHead : options.head;
  const result: SeriesScan = { fromBlock: null, toBlock: null, ranges: 0, created: 0, caughtUp: start > head };
  while (start <= head && result.ranges < maxChunks) {
    const to = start + chunk - 1n > head ? head : start + chunk - 1n;
    let logs: Array<{ args?: Record<string, unknown> }>;
    try {
      logs = (await client.getLogs({ address: options.clearinghouse, event: SERIES_CREATED, fromBlock: start, toBlock: to, strict: false } as never)) as unknown as Array<{ args?: Record<string, unknown> }>;
    } catch (error) {
      if (chunk > MIN_CHUNK) {
        chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
        continue;
      }
      throw error;
    }
    const series: SeriesInfo[] = [];
    for (const log of logs) {
      const a = log.args ?? {};
      if (typeof a.longId !== 'bigint' || typeof a.underlying !== 'string' || typeof a.strike !== 'bigint') continue;
      series.push({ longId: a.longId, underlying: a.underlying, isPut: a.isPut === true, strike: a.strike, expiry: Number(a.expiry) });
    }
    store.applySeriesRange(series, to);
    result.fromBlock ??= start;
    result.toBlock = to;
    result.ranges += 1;
    result.created += series.length;
    start = to + 1n;
  }
  result.caughtUp = start > head;
  return result;
}
