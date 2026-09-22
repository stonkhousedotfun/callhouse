/**
 * The MM bot's fill tracking (quoter.ts step 4): every open vault order re-read at the head block, a grown `filled` a
 * fill written to the realised-PnL ledger in the same SQLite transaction as the new `filled`, and each sale booked at
 * the seller fee the book really took.
 *
 * WHY THE FEE IS NOT THE ONE READ NOW. Since INTERFACE_VERSION 6 OrderBook.setFeeParams schedules a change 24 h ahead
 * and every take from `effectiveAt` on pays it, resting orders included. A fill made at the old fees and seen after
 * `effectiveAt` (a poll that straddles it, a bot restarted after it) would be booked at the new ones: a fee cut would
 * overstate the proceeds, understate the day's loss and weaken the daily loss stop. So a sale is booked from its
 * OrderFilled logs (premium and sellerFee exactly, pnl.matchFillLogs over the range since the previous look), and one
 * the logs cannot account for (a refused log read, a range that ran out) at the highest seller fee any regime in the
 * interval can have charged (pnl.conservativeSellerFeeBps), with a warning. Bids pay no seller fee (the taker sells).
 *
 * THE CHECKPOINT (mm-store.ts). After every complete look the head block, its time and the fees in effect then are
 * stored: the next look reads logs from that block (less REORG_OVERLAP) and bounds the interval's fee regimes with
 * them. Without one (a store from before checkpoints) the logs are read FILL_LOG_MAX_CHUNKS ranges back and a fill
 * they do not cover is booked at the compiled ceiling.
 */
import { zeroAddress, type Address, type PublicClient } from 'viem';
import type { Head } from '../chain.js';
import type { Logger } from '../logger.js';
import { describeError } from '../tx.js';
import { FEE_CHANGE_DELAY_S, FILL_LOG_MAX_CHUNKS, LOG_CHUNK_BLOCKS, PREMIUM_FEE_CEIL_BPS, REORG_OVERLAP } from './constants.js';
import type { MmStore } from './mm-store.js';
import { conservativeSellerFeeBps, fillOf, matchFillLogs, sellerFeeBpsOf, type FeeRegime, type FillLog, type LedgerEvent } from './pnl.js';
import { readOrderFillLogs, readOrders, type ChainOrder } from './reads.js';

export interface FillRecord {
  at: number;
  orderId: bigint;
  longId: bigint;
  kind: string;
  side: 'buy' | 'sell';
  units: bigint;
  price: bigint;
  /** A sale's seller fee: `exact` from its OrderFilled logs (with `sellerFee`), else `conservative` at `feeBps`. */
  fee?: { basis: 'exact' | 'conservative'; feeBps: number; sellerFee?: bigint };
}

export interface TrackDeps {
  client: Pick<PublicClient, 'readContract'>;
  logClient: Pick<PublicClient, 'getLogs'>;
  mm: MmStore;
  log: Logger;
  orderBook: Address;
  vault: Address;
  /** The registry's v2.deployBlock (0 when unknown): no log range starts below it. */
  deployBlock: bigint;
}

export interface TrackResult {
  /** The chain state of the open orders read. */
  chain: ChainOrder[];
  fills: FillRecord[];
  /** How the tick's sales were booked, and why the logs could not be used when they were not. */
  sales: { exact: number; conservative: number; logError: string | null };
}

/** The first block the OrderFilled read of a look at `head` must reach: the previous look's block, less a reorg overlap. */
export function fillLogStart(checkpointBlock: bigint | null, head: bigint, deployBlock: bigint): bigint {
  const start = checkpointBlock === null ? head - BigInt(LOG_CHUNK_BLOCKS * FILL_LOG_MAX_CHUNKS) + 1n : checkpointBlock + 1n - REORG_OVERLAP;
  return start < deployBlock ? deployBlock : start < 0n ? 0n : start;
}

/** Re-read every open vault order at `head`; record fills (each sale at its real seller fee) and closes; checkpoint. */
export async function trackVaultOrders(deps: TrackDeps, fees: FeeRegime, head: Head): Promise<TrackResult> {
  const result: TrackResult = { chain: [], fills: [], sales: { exact: 0, conservative: 0, logError: null } };
  // Per vault (F-DAPP-02): a shared checkpoint made every vault after the first resume from another
  // vault's block and book its sales against whatever fee regime that window happened to carry.
  const checkpoint = deps.mm.fillCheckpoint(deps.vault);
  const open = deps.mm.openOrders(deps.vault);
  if (open.length > 0) {
    result.chain = await readOrders(deps.client, deps.orderBook, open.map((o) => o.orderId), head.blockNumber);
    const byId = new Map(result.chain.map((o) => [o.id.toString(), o]));
    const progress = open.flatMap((t) => {
      const c = byId.get(t.orderId.toString());
      if (c === undefined || c.maker === zeroAddress) return [];
      const f = fillOf(t, { filled: c.filled, cancelled: c.cancelled, units: c.units, validUntil: c.validUntil }, head.timestamp);
      return f.units === 0n && !f.closed && c.filled === t.filledSeen ? [] : [{ t, c, f }];
    });

    const sales = progress.filter((p) => p.f.units > 0n && p.f.side === 'sell');
    let logs: FillLog[] | null = null;
    if (sales.length > 0) {
      try {
        const read = await readOrderFillLogs(deps.logClient, {
          orderBook: deps.orderBook,
          orderIds: sales.map((s) => s.t.orderId),
          fromBlock: fillLogStart(checkpoint?.block ?? null, head.blockNumber, deps.deployBlock),
          toBlock: head.blockNumber,
          chunkBlocks: LOG_CHUNK_BLOCKS,
          maxChunks: FILL_LOG_MAX_CHUNKS,
        });
        logs = read.logs;
      } catch (error) {
        result.sales.logError = describeError(error);
        deps.log.warn({ err: result.sales.logError, orders: sales.map((s) => s.t.orderId) }, 'OrderFilled logs unreadable: this tick\'s sales are booked at the highest seller fee the interval allows');
      }
    }
    const vault = deps.vault.toLowerCase();

    for (const { t, c, f } of progress) {
      let event: LedgerEvent | null = null;
      let fee: FillRecord['fee'];
      if (f.units > 0n) {
        let feeBps = sellerFeeBpsOf(t.kind, fees);
        let exact: { premium: bigint; sellerFee: bigint } | null = null;
        if (f.side === 'sell') {
          const match = logs === null ? null : matchFillLogs(f.units, logs.filter((l) => l.orderId === t.orderId && l.maker.toLowerCase() === vault));
          if (match !== null) {
            exact = { premium: match.premium, sellerFee: match.sellerFee };
            feeBps = match.premium === 0n ? 0 : Number((match.sellerFee * 10_000n + match.premium - 1n) / match.premium);
            fee = { basis: 'exact', feeBps, sellerFee: match.sellerFee };
            result.sales.exact += 1;
          } else {
            feeBps = conservativeSellerFeeBps(t.kind, { current: fees, previous: checkpoint === null ? null : { regime: checkpoint, at: checkpoint.at }, now: head.timestamp, delayS: FEE_CHANGE_DELAY_S, ceilingBps: PREMIUM_FEE_CEIL_BPS });
            fee = { basis: 'conservative', feeBps };
            result.sales.conservative += 1;
            deps.log.warn({ orderId: t.orderId, units: f.units, feeBps, since: checkpoint?.at ?? null, logError: result.sales.logError }, 'a vault sale its OrderFilled logs do not account for: booked at the highest seller fee the interval allows');
          }
        }
        event = { type: 'fill', longId: t.longId.toString(), side: f.side, units: f.units, price: t.price, feeBps, ...(exact ?? {}), at: head.timestamp };
      }
      deps.mm.recordOrderProgress(t.orderId, c.filled, f.closed, event, deps.vault);
      if (event !== null) {
        const record: FillRecord = { at: head.timestamp, orderId: t.orderId, longId: t.longId, kind: t.kind, side: f.side, units: f.units, price: t.price, ...(fee === undefined ? {} : { fee }) };
        result.fills.push(record);
        deps.log.info({ orderId: t.orderId, longId: t.longId, kind: t.kind, side: f.side, units: f.units, price: t.price, fee }, 'vault order filled');
      }
    }
  }
  deps.mm.setFillCheckpoint({ block: head.blockNumber, at: head.timestamp, premiumFeeBps: fees.premiumFeeBps, resaleFeeBps: fees.resaleFeeBps }, deps.vault);
  return result;
}
