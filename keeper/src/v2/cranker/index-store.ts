/**
 * The cranker's own index of the v2 deployment, in the mode's SQLite file (store.ts's database,
 * tables `v2_cranker_*`), fed by scanner.ts from the contracts' logs.
 *
 * WHY THE CRANKER KEEPS ONE. The indexer is optional for this mode (K2-03: "fall back to log scans
 * when the indexer is down"), and three questions have no on-chain enumeration:
 *   series      which series exist for an (underlying, expiry): SeriesCreated;
 *   holders     who may hold a token id: every TransferSingle / TransferBatch recipient (candidates
 *               only; balances are always read from chain before a redeem);
 *   orders      which orders may need pruning past their validUntil: OrderPlaced;
 *   strategies  which writers have an AutoRoller strategy: StrategySet.
 * Plus the cranker's bookkeeping: expiries it has finished (`done_at`).
 *
 * ONE DEPLOYMENT PER FILE. The rows describe the deployment named in `v2_meta`
 * `cranker:index:deployment` (chain, clearinghouse, order book, roller); a store opened for another
 * one is wiped first, so a registry switch never cranks the old deployment's series. Another
 * deployment at the SAME addresses (a fresh devnet: up.sh deploys from a pinned nonce) is told apart
 * by the deployment anchor in `cranker:index:anchor` (bindAnchor, ../anchor.ts); it resets the rows
 * and every `cranker:` mark in v2_meta (snapshots taken, settlements seen, ladder anchors, sweeps,
 * alerts sent), which describe that deployment too.
 *
 * All 256-bit values are decimal TEXT; addresses are lower-case TEXT.
 */
import { anchorResets, compareAnchor, type AnchorCheck } from '../anchor.js';
import type { V2Store } from '../store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS v2_cranker_series (
  long_id    TEXT PRIMARY KEY,
  underlying TEXT NOT NULL,
  is_put     INTEGER NOT NULL,
  strike     TEXT NOT NULL,
  expiry     INTEGER NOT NULL,
  oracle     TEXT NOT NULL,
  block      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_cranker_series_by_expiry ON v2_cranker_series (underlying, expiry);

CREATE TABLE IF NOT EXISTS v2_cranker_holders (
  token_id TEXT NOT NULL,
  holder   TEXT NOT NULL,
  PRIMARY KEY (token_id, holder)
);

CREATE TABLE IF NOT EXISTS v2_cranker_orders (
  order_id    TEXT PRIMARY KEY,
  long_id     TEXT NOT NULL,
  maker       TEXT NOT NULL,
  kind        INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  dead        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS v2_cranker_orders_open ON v2_cranker_orders (dead, valid_until);

CREATE TABLE IF NOT EXISTS v2_cranker_strategies (
  writer     TEXT NOT NULL,
  underlying TEXT NOT NULL,
  PRIMARY KEY (writer, underlying)
);

CREATE TABLE IF NOT EXISTS v2_cranker_expiries (
  oracle     TEXT NOT NULL,
  underlying TEXT NOT NULL,
  expiry     INTEGER NOT NULL,
  done_at    INTEGER NOT NULL,
  PRIMARY KEY (oracle, underlying, expiry)
);
`;

const TABLES = ['v2_cranker_series', 'v2_cranker_holders', 'v2_cranker_orders', 'v2_cranker_strategies', 'v2_cranker_expiries'] as const;

export const DEPLOYMENT_META_KEY = 'cranker:index:deployment';
export const SCAN_CURSOR_META_KEY = 'cranker:index:scannedTo';
export const ANCHOR_META_KEY = 'cranker:index:anchor';
/** Every cranker mark in v2_meta starts with this (steps.ts, effects.ts). */
export const CRANKER_META_PREFIX = 'cranker:';

export interface IndexedSeries {
  longId: bigint;
  underlying: string;
  isPut: boolean;
  strike: bigint;
  expiry: number;
  oracle: string;
}

export interface IndexedOrder {
  orderId: bigint;
  longId: bigint;
  maker: string;
  kind: number;
  validUntil: number;
}

export interface DeploymentId {
  chainId: number;
  clearinghouse: string;
  orderBook: string;
  autoRoller: string | null;
}

const lc = (a: string) => a.toLowerCase();

export class CrankerIndex {
  constructor(private readonly store: V2Store) {
    store.db.exec(SCHEMA);
  }

  /** Bind the index to a deployment; rows of any other deployment are deleted. Returns true when it wiped. */
  bind(deployment: DeploymentId): boolean {
    const id = `${deployment.chainId}:${lc(deployment.clearinghouse)}:${lc(deployment.orderBook)}:${deployment.autoRoller === null ? '-' : lc(deployment.autoRoller)}`;
    const current = this.store.getMeta(DEPLOYMENT_META_KEY);
    if (current === id) return false;
    const wipe = this.store.db.transaction(() => {
      for (const table of TABLES) this.store.db.exec(`DELETE FROM ${table}`);
      this.store.db.prepare('DELETE FROM v2_meta WHERE key = ?').run(SCAN_CURSOR_META_KEY);
    });
    // A roller added to a deployment the index already knows keeps the rows: only StrategySet is new,
    // and a rescan from the deploy block picks it up.
    const sameCore = current !== null && current.split(':').slice(0, 3).join(':') === id.split(':').slice(0, 3).join(':');
    if (current !== null && !sameCore) {
      wipe();
      // bindAnchor records the new deployment's anchor.
      this.store.deleteMeta(ANCHOR_META_KEY);
    } else if (current !== null) {
      this.store.deleteMeta(SCAN_CURSOR_META_KEY);
    }
    this.store.setMeta(DEPLOYMENT_META_KEY, id);
    return current !== null && !sameCore;
  }

  /**
   * Check the deployment anchor of the chain the cranker reads against the one recorded (../anchor.ts). Another
   * deployment at the same addresses, or state recorded before anchors, deletes every row and `cranker:` mark but the
   * deployment id, and marks the journal's pending transactions dropped. Call before the first step of a process.
   */
  bindAnchor(anchor: string | null): AnchorCheck {
    const recorded = this.store.getMeta(ANCHOR_META_KEY);
    const keep = [DEPLOYMENT_META_KEY, ANCHOR_META_KEY];
    const marks = (this.store.db.prepare('SELECT key FROM v2_meta WHERE substr(key, 1, ?) = ?').all(CRANKER_META_PREFIX.length, CRANKER_META_PREFIX) as Array<{ key: string }>).filter((r) => !keep.includes(r.key));
    const hasState = marks.length > 0 || Object.values(this.counts()).some((n) => n > 0);
    const check = compareAnchor(recorded, anchor, hasState);
    this.store.db.transaction(() => {
      if (anchorResets(check)) {
        for (const table of TABLES) this.store.db.exec(`DELETE FROM ${table}`);
        this.store.deleteMetaWithPrefix(CRANKER_META_PREFIX, keep);
        this.store.dropPendingTxs(`the cranker store was reset for another deployment (anchor ${anchor})`);
      }
      if (anchor !== null && check !== 'same') this.store.setMeta(ANCHOR_META_KEY, anchor);
    })();
    return check;
  }

  anchor(): string | null {
    return this.store.getMeta(ANCHOR_META_KEY);
  }

  /*------------------------------ cursor ------------------------------*/

  scannedTo(): bigint | null {
    const raw = this.store.getMeta(SCAN_CURSOR_META_KEY);
    return raw === null ? null : BigInt(raw);
  }

  /*------------------------------ writes ------------------------------*/

  /** One scanned range, atomically: its rows and the cursor move together. */
  applyRange(rows: { series: IndexedSeries[]; holders: Array<{ tokenId: bigint; holder: string }>; orders: IndexedOrder[]; strategies: Array<{ writer: string; underlying: string }>; block: bigint }, toBlock: bigint): void {
    const db = this.store.db;
    const insertSeries = db.prepare('INSERT OR IGNORE INTO v2_cranker_series (long_id, underlying, is_put, strike, expiry, oracle, block) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertHolder = db.prepare('INSERT OR IGNORE INTO v2_cranker_holders (token_id, holder) VALUES (?, ?)');
    const insertOrder = db.prepare('INSERT OR IGNORE INTO v2_cranker_orders (order_id, long_id, maker, kind, valid_until) VALUES (?, ?, ?, ?, ?)');
    const insertStrategy = db.prepare('INSERT OR IGNORE INTO v2_cranker_strategies (writer, underlying) VALUES (?, ?)');
    db.transaction(() => {
      for (const s of rows.series) insertSeries.run(s.longId.toString(), lc(s.underlying), s.isPut ? 1 : 0, s.strike.toString(), s.expiry, lc(s.oracle), rows.block.toString());
      for (const h of rows.holders) insertHolder.run(h.tokenId.toString(), lc(h.holder));
      for (const o of rows.orders) insertOrder.run(o.orderId.toString(), o.longId.toString(), lc(o.maker), o.kind, o.validUntil);
      for (const s of rows.strategies) insertStrategy.run(lc(s.writer), lc(s.underlying));
      this.store.setMeta(SCAN_CURSOR_META_KEY, toBlock.toString());
    })();
  }

  markOrdersDead(orderIds: readonly bigint[]): void {
    const stmt = this.store.db.prepare('UPDATE v2_cranker_orders SET dead = 1 WHERE order_id = ?');
    this.store.db.transaction(() => {
      for (const id of orderIds) stmt.run(id.toString());
    })();
  }

  markExpiryDone(oracle: string, underlying: string, expiry: number, at: number): void {
    this.store.db.prepare('INSERT OR REPLACE INTO v2_cranker_expiries (oracle, underlying, expiry, done_at) VALUES (?, ?, ?, ?)').run(lc(oracle), lc(underlying), expiry, at);
  }

  /*------------------------------ reads -------------------------------*/

  /** Distinct (oracle, underlying, expiry) of every indexed series. */
  expiries(): Array<{ oracle: string; underlying: string; expiry: number }> {
    return this.store.db.prepare('SELECT DISTINCT oracle, underlying, expiry FROM v2_cranker_series ORDER BY expiry ASC').all() as Array<{ oracle: string; underlying: string; expiry: number }>;
  }

  doneExpiries(): Set<string> {
    const rows = this.store.db.prepare('SELECT oracle, underlying, expiry FROM v2_cranker_expiries').all() as Array<{ oracle: string; underlying: string; expiry: number }>;
    return new Set(rows.map((r) => `${r.oracle}:${r.underlying}:${r.expiry}`));
  }

  seriesOf(underlying: string, expiry: number, oracle?: string): IndexedSeries[] {
    const rows = (
      oracle === undefined
        ? this.store.db.prepare('SELECT * FROM v2_cranker_series WHERE underlying = ? AND expiry = ? ORDER BY is_put, CAST(strike AS INTEGER), long_id').all(lc(underlying), expiry)
        : this.store.db.prepare('SELECT * FROM v2_cranker_series WHERE underlying = ? AND expiry = ? AND oracle = ? ORDER BY is_put, CAST(strike AS INTEGER), long_id').all(lc(underlying), expiry, lc(oracle))
    ) as Array<{ long_id: string; underlying: string; is_put: number; strike: string; expiry: number; oracle: string }>;
    return rows.map((r) => ({ longId: BigInt(r.long_id), underlying: r.underlying, isPut: r.is_put === 1, strike: BigInt(r.strike), expiry: r.expiry, oracle: r.oracle }));
  }

  holdersOf(tokenId: bigint): string[] {
    return (this.store.db.prepare('SELECT holder FROM v2_cranker_holders WHERE token_id = ? ORDER BY holder').all(tokenId.toString()) as Array<{ holder: string }>).map((r) => r.holder);
  }

  /** Orders not known dead whose validUntil has passed, oldest validUntil first. */
  expiredOpenOrders(now: number, limit: number): IndexedOrder[] {
    const rows = this.store.db
      .prepare('SELECT * FROM v2_cranker_orders WHERE dead = 0 AND valid_until <= ? ORDER BY valid_until ASC, CAST(order_id AS INTEGER) ASC LIMIT ?')
      .all(now, limit) as Array<{ order_id: string; long_id: string; maker: string; kind: number; valid_until: number }>;
    return rows.map((r) => ({ orderId: BigInt(r.order_id), longId: BigInt(r.long_id), maker: r.maker, kind: r.kind, validUntil: r.valid_until }));
  }

  strategies(): Array<{ writer: string; underlying: string }> {
    return this.store.db.prepare('SELECT writer, underlying FROM v2_cranker_strategies ORDER BY writer, underlying').all() as Array<{ writer: string; underlying: string }>;
  }

  counts(): { series: number; holders: number; orders: number; openOrders: number; strategies: number; doneExpiries: number } {
    const n = (sql: string) => (this.store.db.prepare(sql).get() as { n: number }).n;
    return {
      series: n('SELECT COUNT(*) AS n FROM v2_cranker_series'),
      holders: n('SELECT COUNT(*) AS n FROM v2_cranker_holders'),
      orders: n('SELECT COUNT(*) AS n FROM v2_cranker_orders'),
      openOrders: n('SELECT COUNT(*) AS n FROM v2_cranker_orders WHERE dead = 0'),
      strategies: n('SELECT COUNT(*) AS n FROM v2_cranker_strategies'),
      doneExpiries: n('SELECT COUNT(*) AS n FROM v2_cranker_expiries'),
    };
  }
}
