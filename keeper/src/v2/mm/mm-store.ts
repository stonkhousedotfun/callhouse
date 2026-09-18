/**
 * The MM bot's durable state, in the mode's SQLite file (store.ts's database, tables `v2_mm_*`):
 *
 *   v2_mm_series   every series of the deployment (SeriesCreated, scanned by series-index.ts): which
 *                  series exist has no on-chain enumeration.
 *   v2_mm_orders   every vault order (OrderBook.ordersOfMaker(vault), an append-only list paged from the
 *                  index already ingested), with the `filled` the bot last saw: a growing `filled` is a
 *                  fill (pnl.ts fillOf). The orders that exist when the store is first bound are adopted at
 *                  their current `filled` (their past is not the bot's); every later one counts from 0,
 *                  whoever placed it through the vault.
 *   v2_mm_ledger   fills and settlements, in the order seen: pnl.ts replays it for the loss stop.
 * And in v2_meta: the scan cursor, the deployment the rows describe and its anchor, how many of the
 * vault's orders are ingested, the fill checkpoint (the head block, time and seller fees of the last
 * complete look at the open orders: where the next look's OrderFilled logs start, and the fee regime a
 * fill its logs cannot account for is bounded by), the kill switch, the last sync, the loss-stop
 * alerts sent.
 *
 * ONE DEPLOYMENT PER FILE, as the cranker's index: rows of another (chain, clearinghouse, book, vault)
 * are deleted when the store is bound to a new one (bind), and so are the rows of another deployment at
 * the same addresses, told apart by the deployment anchor (bindAnchor, ../anchor.ts: registry
 * v2.deployBlock and its block hash). The kill switch survives both: a kill is never forgotten. All
 * 256-bit values are decimal TEXT.
 */
import { anchorResets, compareAnchor, type AnchorCheck } from '../anchor.js';
import type { V2Store } from '../store.js';
import type { FeeRegime, LedgerEvent, TrackedOrder } from './pnl.js';
import type { SeriesInfo } from './engine.js';
import type { Projection } from './outflow.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS v2_mm_series (
  long_id    TEXT PRIMARY KEY,
  underlying TEXT NOT NULL,
  is_put     INTEGER NOT NULL,
  strike     TEXT NOT NULL,
  expiry     INTEGER NOT NULL,
  block      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_mm_series_by_expiry ON v2_mm_series (expiry);

CREATE TABLE IF NOT EXISTS v2_mm_orders (
  order_id    TEXT PRIMARY KEY,
  long_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  price       TEXT NOT NULL,
  units       TEXT NOT NULL,
  filled_seen TEXT NOT NULL,
  closed      INTEGER NOT NULL DEFAULT 0,
  seen_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_mm_orders_open ON v2_mm_orders (closed);

CREATE TABLE IF NOT EXISTS v2_mm_ledger (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type      TEXT NOT NULL,
  long_id   TEXT NOT NULL,
  data_json TEXT NOT NULL,
  at        INTEGER NOT NULL,
  -- one settlement per series; fills are keyed by order and cumulative filled
  uniq      TEXT NOT NULL UNIQUE
);
`;

const TABLES = ['v2_mm_series', 'v2_mm_orders', 'v2_mm_ledger'] as const;

export const MM_META = {
  deployment: 'mm:deployment',
  anchor: 'mm:anchor',
  scannedTo: 'mm:series:scannedTo',
  makerIndex: 'mm:makerIndex',
  killed: 'mm:killed',
  lastSync: 'mm:lastSync',
  fillCheckpoint: 'mm:fills:checkpoint',
  /** The bot's own projection of the vault's outflow bucket after its last tick (outflow.ts, INTERFACE_VERSION 7). */
  outflow: 'mm:outflow',
  /** Prefix of the per-day "loss stop paged" marks (quoter.ts). */
  lossStopAlerted: 'mm:lossStopAlerted:',
} as const;

/** The last complete look at the vault's open orders (fills.ts). */
export interface FillCheckpoint extends FeeRegime {
  block: bigint;
  at: number;
}

export interface KilledState {
  at: number;
  reason: string;
}

const lc = (a: string) => a.toLowerCase();

export class MmStore {
  constructor(readonly store: V2Store) {
    store.db.exec(SCHEMA);
  }

  /** Bind to a deployment; returns true when rows of another one were deleted. */
  bind(deployment: { chainId: number; clearinghouse: string; orderBook: string; vault: string }): boolean {
    const id = `${deployment.chainId}:${lc(deployment.clearinghouse)}:${lc(deployment.orderBook)}:${lc(deployment.vault)}`;
    const current = this.store.getMeta(MM_META.deployment);
    if (current === id) return false;
    const wiped = current !== null;
    this.store.db.transaction(() => {
      this.reset();
      // bindAnchor records the new deployment's anchor on an empty store.
      this.store.deleteMeta(MM_META.anchor);
      this.store.setMeta(MM_META.deployment, id);
    })();
    return wiped;
  }

  /**
   * Check the deployment anchor (../anchor.ts) of the chain the bot reads against the one recorded. Another deployment
   * at the same addresses, or state recorded before anchors, resets the store as bind does for other addresses, and
   * marks the journal's pending transactions dropped (that chain never mined them). Call before reading the store.
   */
  bindAnchor(anchor: string | null): AnchorCheck {
    const recorded = this.store.getMeta(MM_META.anchor);
    const hasState = this.scannedTo() !== null || this.makerIndex() !== null || this.lastSync() !== null || Object.values(this.counts()).some((n) => n > 0);
    const check = compareAnchor(recorded, anchor, hasState);
    this.store.db.transaction(() => {
      if (anchorResets(check)) {
        this.reset();
        this.store.dropPendingTxs(`the MM store was reset for another deployment (anchor ${anchor})`);
      }
      if (anchor !== null && check !== 'same') this.store.setMeta(MM_META.anchor, anchor);
    })();
    return check;
  }

  /** The anchor the rows describe, or null before one was recorded. */
  anchor(): string | null {
    return this.store.getMeta(MM_META.anchor);
  }

  /** Delete everything that describes a deployment; the kill switch stays. */
  private reset(): void {
    for (const table of TABLES) this.store.db.exec(`DELETE FROM ${table}`);
    for (const key of [MM_META.scannedTo, MM_META.makerIndex, MM_META.lastSync, MM_META.fillCheckpoint, MM_META.outflow]) this.store.deleteMeta(key);
    this.store.deleteMetaWithPrefix(MM_META.lossStopAlerted);
  }

  /*------------------------------ series ------------------------------*/

  scannedTo(): bigint | null {
    const raw = this.store.getMeta(MM_META.scannedTo);
    return raw === null ? null : BigInt(raw);
  }

  applySeriesRange(series: readonly SeriesInfo[], toBlock: bigint): void {
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO v2_mm_series (long_id, underlying, is_put, strike, expiry, block) VALUES (?, ?, ?, ?, ?, ?)');
    this.store.db.transaction(() => {
      for (const s of series) insert.run(s.longId.toString(), lc(s.underlying), s.isPut ? 1 : 0, s.strike.toString(), s.expiry, toBlock.toString());
      this.store.setMeta(MM_META.scannedTo, toBlock.toString());
    })();
  }

  /** Series expiring after `now`. */
  liveSeries(now: number): SeriesInfo[] {
    const rows = this.store.db.prepare('SELECT * FROM v2_mm_series WHERE expiry > ? ORDER BY expiry, long_id').all(now) as Array<{ long_id: string; underlying: string; is_put: number; strike: string; expiry: number }>;
    return rows.map((r) => ({ longId: BigInt(r.long_id), underlying: r.underlying, isPut: r.is_put === 1, strike: BigInt(r.strike), expiry: r.expiry }));
  }

  /** The stored series of these ids (absent ones are skipped: the scan has not reached them). */
  seriesByIds(longIds: readonly bigint[]): Map<string, SeriesInfo> {
    const out = new Map<string, SeriesInfo>();
    const get = this.store.db.prepare('SELECT * FROM v2_mm_series WHERE long_id = ?');
    for (const id of longIds) {
      const r = get.get(id.toString()) as { long_id: string; underlying: string; is_put: number; strike: string; expiry: number } | undefined;
      if (r !== undefined) out.set(r.long_id, { longId: BigInt(r.long_id), underlying: r.underlying, isPut: r.is_put === 1, strike: BigInt(r.strike), expiry: r.expiry });
    }
    return out;
  }

  seriesCount(): number {
    return (this.store.db.prepare('SELECT COUNT(*) AS n FROM v2_mm_series').get() as { n: number }).n;
  }

  /*------------------------------ orders ------------------------------*/

  /** How many entries of ordersOfMaker(vault) are ingested; null before the first ingestion. */
  makerIndex(): bigint | null {
    const raw = this.store.getMeta(MM_META.makerIndex);
    return raw === null ? null : BigInt(raw);
  }

  /** New vault orders and the index after them, atomically. */
  ingestOrders(rows: ReadonlyArray<{ order: TrackedOrder; closed: boolean }>, index: bigint, at: number): void {
    this.store.db.transaction(() => {
      for (const r of rows) this.trackOrder(r.order, r.closed, at);
      this.store.setMeta(MM_META.makerIndex, index.toString());
    })();
  }

  openOrders(): TrackedOrder[] {
    const rows = this.store.db.prepare('SELECT * FROM v2_mm_orders WHERE closed = 0 ORDER BY CAST(order_id AS INTEGER)').all() as Array<{ order_id: string; long_id: string; kind: string; price: string; units: string; filled_seen: string }>;
    return rows.map((r) => ({ orderId: BigInt(r.order_id), longId: BigInt(r.long_id), kind: r.kind as TrackedOrder['kind'], price: BigInt(r.price), units: BigInt(r.units), filledSeen: BigInt(r.filled_seen) }));
  }

  trackOrder(order: TrackedOrder, closed: boolean, at: number): void {
    this.store.db
      .prepare('INSERT OR IGNORE INTO v2_mm_orders (order_id, long_id, kind, price, units, filled_seen, closed, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(order.orderId.toString(), order.longId.toString(), order.kind, order.price.toString(), order.units.toString(), order.filledSeen.toString(), closed ? 1 : 0, at);
  }

  /** A fill (when `event` is given) and the order's new `filled`, atomically: a crash never counts a fill twice. */
  recordOrderProgress(orderId: bigint, filled: bigint, closed: boolean, event: LedgerEvent | null): void {
    this.store.db.transaction(() => {
      if (event !== null) this.insertLedger(event, `fill:${orderId}:${filled}`);
      this.store.db.prepare('UPDATE v2_mm_orders SET filled_seen = ?, closed = ? WHERE order_id = ?').run(filled.toString(), closed ? 1 : 0, orderId.toString());
    })();
  }

  /*------------------------------ ledger ------------------------------*/

  private insertLedger(event: LedgerEvent, uniq: string): void {
    const data = event.type === 'fill'
      ? {
          side: event.side,
          units: event.units.toString(),
          price: event.price.toString(),
          feeBps: event.feeBps,
          ...(event.premium !== undefined && event.sellerFee !== undefined ? { premium: event.premium.toString(), sellerFee: event.sellerFee.toString() } : {}),
        }
      : { isPut: event.isPut, strike: event.strike.toString(), settlementPrice: event.settlementPrice.toString(), ...(event.exerciseFeeBps === undefined ? {} : { exerciseFeeBps: event.exerciseFeeBps }) };
    this.store.db.prepare('INSERT OR IGNORE INTO v2_mm_ledger (type, long_id, data_json, at, uniq) VALUES (?, ?, ?, ?, ?)').run(event.type, event.longId, JSON.stringify(data), event.at, uniq);
  }

  recordSettlement(event: Extract<LedgerEvent, { type: 'settle' }>): void {
    this.insertLedger(event, `settle:${event.longId}`);
  }

  hasSettlement(longId: bigint): boolean {
    return this.store.db.prepare('SELECT 1 FROM v2_mm_ledger WHERE uniq = ?').get(`settle:${longId}`) !== undefined;
  }

  ledger(): LedgerEvent[] {
    const rows = this.store.db.prepare('SELECT * FROM v2_mm_ledger ORDER BY id').all() as Array<{ type: string; long_id: string; data_json: string; at: number }>;
    return rows.map((r): LedgerEvent => {
      const d = JSON.parse(r.data_json) as Record<string, unknown>;
      if (r.type === 'settle') {
        return { type: 'settle', longId: r.long_id, isPut: d.isPut === true, strike: BigInt(d.strike as string), settlementPrice: BigInt(d.settlementPrice as string), ...(typeof d.exerciseFeeBps === 'number' ? { exerciseFeeBps: d.exerciseFeeBps } : {}), at: r.at };
      }
      const exact = typeof d.premium === 'string' && typeof d.sellerFee === 'string' ? { premium: BigInt(d.premium), sellerFee: BigInt(d.sellerFee) } : {};
      return { type: 'fill', longId: r.long_id, side: d.side as 'buy' | 'sell', units: BigInt(d.units as string), price: BigInt(d.price as string), feeBps: Number(d.feeBps), ...exact, at: r.at };
    });
  }

  /** The last complete look at the open orders, or null before one (or on a store written before checkpoints). */
  fillCheckpoint(): FillCheckpoint | null {
    const raw = this.store.getMeta(MM_META.fillCheckpoint);
    if (raw === null) return null;
    try {
      const c = JSON.parse(raw) as { block: string; at: number; premiumFeeBps: number; resaleFeeBps: number };
      return typeof c.at === 'number' && typeof c.block === 'string' ? { block: BigInt(c.block), at: c.at, premiumFeeBps: Number(c.premiumFeeBps), resaleFeeBps: Number(c.resaleFeeBps) } : null;
    } catch {
      return null;
    }
  }

  setFillCheckpoint(checkpoint: FillCheckpoint): void {
    this.store.setMeta(MM_META.fillCheckpoint, JSON.stringify({ block: checkpoint.block.toString(), at: checkpoint.at, premiumFeeBps: checkpoint.premiumFeeBps, resaleFeeBps: checkpoint.resaleFeeBps }));
  }

  /*------------------------------ switches ----------------------------*/

  killed(): KilledState | null {
    const raw = this.store.getMeta(MM_META.killed);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as KilledState | null;
      return parsed && typeof parsed.at === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  setKilled(state: KilledState | null): void {
    this.store.setMeta(MM_META.killed, JSON.stringify(state));
  }

  lastSync(): number | null {
    const raw = this.store.getMeta(MM_META.lastSync);
    return raw === null ? null : Number(raw);
  }

  setLastSync(at: number): void {
    this.store.setMeta(MM_META.lastSync, String(at));
  }

  /**
   * Where the bot last projected `MakerVault.outflow().used` to be, and the cap it used. The next tick compares the
   * chain's reading with it and pages `v2_mm_outflow_foreign` when someone else spent the vault's USDG. Null before
   * the first tick, and after a deployment reset (the bucket belongs to that vault, not this one).
   */
  outflowProjection(): Projection | null {
    const raw = this.store.getMeta(MM_META.outflow);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { used: string; at: number; cap: string };
      return typeof parsed?.at === 'number' ? { used: BigInt(parsed.used), at: parsed.at, cap: BigInt(parsed.cap) } : null;
    } catch {
      return null;
    }
  }

  setOutflowProjection(p: Projection): void {
    this.store.setMeta(MM_META.outflow, JSON.stringify({ used: p.used.toString(), at: p.at, cap: p.cap.toString() }));
  }

  counts(): Record<string, number> {
    const n = (sql: string) => (this.store.db.prepare(sql).get() as { n: number }).n;
    return {
      series: n('SELECT COUNT(*) AS n FROM v2_mm_series'),
      orders: n('SELECT COUNT(*) AS n FROM v2_mm_orders'),
      openOrders: n('SELECT COUNT(*) AS n FROM v2_mm_orders WHERE closed = 0'),
      ledger: n('SELECT COUNT(*) AS n FROM v2_mm_ledger'),
    };
  }
}
