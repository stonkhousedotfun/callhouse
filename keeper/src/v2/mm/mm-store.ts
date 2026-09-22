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
 * ONE DEPLOYMENT PER FILE, as the cranker's index: rows of another (chain, clearinghouse, book) are
 * deleted when the store is bound to a new core. The vault SET is part of the bind id; adding or
 * removing a vault does NOT wipe the other vaults' orders, ledger or makerIndex. Another deployment
 * at the same addresses is told apart by the deployment anchor (bindAnchor, ../anchor.ts). The kill
 * switch survives both: a kill is never forgotten. All 256-bit values are decimal TEXT.
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
  seen_at     INTEGER NOT NULL,
  vault       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS v2_mm_orders_open ON v2_mm_orders (closed);

CREATE TABLE IF NOT EXISTS v2_mm_ledger (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type      TEXT NOT NULL,
  long_id   TEXT NOT NULL,
  data_json TEXT NOT NULL,
  at        INTEGER NOT NULL,
  -- one settlement per series; fills are keyed by order and cumulative filled
  uniq      TEXT NOT NULL UNIQUE,
  vault     TEXT NOT NULL DEFAULT ''
);
`;

const TABLES = ['v2_mm_series', 'v2_mm_orders', 'v2_mm_ledger'] as const;

export const MM_META = {
  deployment: 'mm:deployment',
  anchor: 'mm:anchor',
  scannedTo: 'mm:series:scannedTo',
  makerIndex: 'mm:makerIndex',
  killed: 'mm:killed',
  /** Prefix of per-vault kill marks (`mm:killedVault:<addr>`). POST /kill {vault} writes here. */
  killedVault: 'mm:killedVault:',
  /**
   * The vault the pre-vault-column rows were attributed to, written by `migrateLegacy` the first time it runs. Since
   * T-OP-132 it is a FAST PATH, not the guard: with it set, a migrated file does no attribution writes at bind, but a
   * legacy-shaped row that appears later is still attributed (see the comment on `migrateLegacy`).
   */
  legacyVault: 'mm:legacyVault',
  lastSync: 'mm:lastSync',
  fillCheckpoint: 'mm:fills:checkpoint',
  /** The bot's own projection of the vault's outflow bucket after its last tick (outflow.ts, INTERFACE_VERSION 7). */
  outflow: 'mm:outflow',
  /** Prefix of the per-day "loss stop paged" marks (quoter.ts). */
  lossStopAlerted: 'mm:lossStopAlerted:',
} as const;

export type MmBind = {
  chainId: number;
  clearinghouse: string;
  orderBook: string;
  /** Single-vault form (treasury-only, and every existing test). */
  vault?: string;
  /** N-vault form: the SET the bot quotes. Adding a vault must not wipe the others. */
  vaults?: readonly string[];
  /**
   * The vault the rows written BEFORE the vault column existed belong to: the treasury MakerVault.
   * Defaults to the first entry of `vaults` (quoter.ts puts the treasury first) or to `vault`.
   * Only `migrateLegacy` reads it; it is not part of the bind id.
   */
  treasury?: string;
};

const vaultList = (d: MmBind): string[] => {
  const raw = d.vaults !== undefined && d.vaults.length > 0 ? d.vaults : d.vault !== undefined ? [d.vault] : [];
  return [...new Set(raw.map(lc))].sort();
};

const coreKey = (d: MmBind): string => `${d.chainId}:${lc(d.clearinghouse)}:${lc(d.orderBook)}`;

const setKey = (d: MmBind): string => {
  const vs = vaultList(d);
  if (vs.length === 0) throw new Error('mm bind: vault or vaults required');
  return `${coreKey(d)}:${vs.join(',')}`;
};

const coreOf = (deploymentId: string): string => deploymentId.split(':').slice(0, 3).join(':');

/** The vault that owns the rows written before the vault column existed. */
const treasuryOf = (d: MmBind): string | null => {
  if (d.treasury !== undefined) return lc(d.treasury);
  if (d.vaults !== undefined && d.vaults.length > 0) return lc(d.vaults[0]!);
  if (d.vault !== undefined) return lc(d.vault);
  return null;
};

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

/** The global meta keys the pre-vault-column store wrote, which `migrateLegacy` moves under the treasury's suffix. */
const LEGACY_SCOPED_KEYS = [MM_META.makerIndex, MM_META.lastSync, MM_META.outflow, MM_META.fillCheckpoint] as const;

/**
 * A per-vault meta key. An absent vault keeps the un-suffixed key, which is the legacy single-vault store and
 * the treasury's rows after {migrateLegacy} has attributed them.
 */
const metaKeyFor = (base: string, vault?: string): string => (vault === undefined ? base : `${base}:${lc(vault)}`);

/**
 * The ledger's UNIQUE key for a settlement. The vault is part of the identity because `uniq` is globally unique
 * and two vaults legitimately settle the same series; see {MmStore.recordSettlement}.
 */
const settlementUniq = (longId: bigint | string, vault?: string): string =>
  vault === undefined ? `settle:${longId}` : `settle:${lc(vault)}:${longId}`;

export class MmStore {
  constructor(readonly store: V2Store) {
    store.db.exec(SCHEMA);
    this.ensureColumn('v2_mm_orders', 'vault');
    this.ensureColumn('v2_mm_ledger', 'vault');
  }

  private ensureColumn(table: string, column: string): void {
    const cols = this.store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }

  /** Bind to a deployment; returns true when rows of another CORE (chain/ch/book) were deleted. */
  bind(deployment: MmBind): boolean {
    const id = setKey(deployment);
    const current = this.store.getMeta(MM_META.deployment);
    if (current === id) {
      // The same set as last boot, which is every production restart. The probe inside does no writes on a migrated
      // file, and it is the only thing that sees the rows a rolled-back binary left (migrateLegacy, T-OP-132).
      this.migrateLegacy(treasuryOf(deployment));
      return false;
    }
    const sameCore = current !== null && coreOf(current) === coreKey(deployment);
    const wiped = current !== null && !sameCore;
    this.store.db.transaction(() => {
      if (wiped) {
        this.reset();
        // bindAnchor records the new deployment's anchor on an empty store.
        this.store.deleteMeta(MM_META.anchor);
      }
      this.store.setMeta(MM_META.deployment, id);
      // After the wipe decision: on a wipe there is nothing left to attribute, on a re-bind there may be.
      this.migrateLegacy(treasuryOf(deployment));
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

  /**
   * ATTRIBUTION OF THE PRE-VAULT-COLUMN ROWS to the treasury vault.
   *
   * WHY IT IS NOT A `vault = ''` FALLBACK IN THE READS. The obvious way to keep the live treasury
   * vault's rows visible after the column was added is to read `WHERE vault = ? OR vault = ''`, and
   * to fall back to the un-suffixed `mm:makerIndex` when the per-vault key is missing. Both are
   * wrong the moment there is a SECOND vault: every House vault would then see the treasury's
   * legacy orders and ledger as its own, and a brand-new vault would read the treasury's
   * `makerIndex` as its own high-water mark and SKIP INGESTING ITS OWN FIRST ORDERS ENTIRELY -
   * silently, because a skipped ingestion looks exactly like a vault that has never traded.
   *
   * So the legacy rows are attributed here, and every read afterwards is strict.
   *
   * IDEMPOTENT PER ROW, PROBED AT EVERY BIND (T-OP-132; K8-05 suspicion 2). This used to run once, gated on the
   * `legacyVault` meta key alone, and a bind to the same set returned before reaching it. That gate could not see the
   * store's shape, and there is one plain way legacy-shaped rows appear AFTER the key is set: the pre-vault-column
   * binary rolled back over a migrated file. Its bind id for a treasury-only set is the SAME string as today's
   * (`chain:ch:book:vault`), so it bound without a wipe and wrote `vault = ''` rows, `settle:<longId>` uniqs and the
   * un-suffixed meta keys again; the roll-forward then bound with the same id, returned early, and every strict read
   * missed those rows for ever - a fill on one of them was never counted, and a fill never counted hides a bad day. A
   * file restored from a backup that mixes the two generations has the same shape. So the rule is now the ROW'S SHAPE:
   * a `''` vault, a legacy settlement uniq or an un-suffixed scoped key can only have been written by the pre-column
   * binary or by the vault-less single-vault form, both of which mean the treasury, and each one is attributed whenever
   * it is seen. The key is a fast path: with it set, a cheap probe decides whether anything is left, and a migrated
   * file does no writes at boot. Nothing re-runs from scratch: a row that carries a vault is never touched, a rewritten
   * uniq is never rewritten again, a scoped key that exists is never overwritten.
   */
  private migrateLegacy(treasury: string | null): void {
    if (treasury === null) return;
    if (this.store.getMeta(MM_META.legacyVault) !== null && !this.legacyShapesRemain()) return;
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE v2_mm_orders SET vault = ? WHERE vault = ''").run(treasury);
      this.store.db.prepare("UPDATE v2_mm_ledger SET vault = ? WHERE vault = ''").run(treasury);
      // The settlement uniq gained the vault (F-DAPP-01), so the legacy `settle:<longId>` rows must be rewritten
      // to the treasury's form or {hasSettlement} would not find them and the live vault would settle twice. A legacy
      // row whose treasury-form twin already exists IS that settlement, recorded a second time by the older binary:
      // it is dropped, not kept beside its twin, or {ledger} would carry two settlements of one series (replay tolerates
      // that - pnl.ts applySettlement returns 0 on a flat position - but the counts and {hasSettlement} would not).
      this.store.db
        .prepare(
          "DELETE FROM v2_mm_ledger WHERE type = 'settle' AND uniq = 'settle:' || long_id AND EXISTS (SELECT 1 FROM v2_mm_ledger t WHERE t.uniq = 'settle:' || ? || ':' || v2_mm_ledger.long_id)",
        )
        .run(treasury);
      this.store.db.prepare("UPDATE v2_mm_ledger SET uniq = 'settle:' || ? || ':' || long_id WHERE type = 'settle' AND uniq = 'settle:' || long_id").run(treasury);
      for (const key of LEGACY_SCOPED_KEYS) {
        const raw = this.store.getMeta(key);
        if (raw === null) continue;
        const scoped = `${key}:${treasury}`;
        if (this.store.getMeta(scoped) === null) this.store.setMeta(scoped, raw);
        this.store.deleteMeta(key);
      }
      this.store.setMeta(MM_META.legacyVault, treasury);
    })();
  }

  /** Anything of the pre-vault-column shape still in the file: a `''` vault, a legacy settlement uniq, a global scoped key. */
  private legacyShapesRemain(): boolean {
    const any = (sql: string) => this.store.db.prepare(sql).get() !== undefined;
    return (
      any("SELECT 1 FROM v2_mm_orders WHERE vault = '' LIMIT 1") ||
      any("SELECT 1 FROM v2_mm_ledger WHERE vault = '' OR (type = 'settle' AND uniq = 'settle:' || long_id) LIMIT 1") ||
      LEGACY_SCOPED_KEYS.some((key) => this.store.getMeta(key) !== null)
    );
  }

  /** Delete everything that describes a deployment; the kill switch stays. */
  private reset(): void {
    for (const table of TABLES) this.store.db.exec(`DELETE FROM ${table}`);
    for (const key of [MM_META.scannedTo, MM_META.makerIndex, MM_META.lastSync, MM_META.fillCheckpoint, MM_META.outflow]) this.store.deleteMeta(key);
    this.store.deleteMetaWithPrefix(`${MM_META.makerIndex}:`);
    this.store.deleteMetaWithPrefix(`${MM_META.lastSync}:`);
    this.store.deleteMetaWithPrefix(`${MM_META.outflow}:`);
    this.store.deleteMetaWithPrefix(`${MM_META.fillCheckpoint}:`);
    this.store.deleteMetaWithPrefix(MM_META.lossStopAlerted);
    // A new deployment starts empty, so the next bind re-arms the attribution rather than skipping it.
    this.store.deleteMeta(MM_META.legacyVault);
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
  makerIndex(vault?: string): bigint | null {
    const raw = this.store.getMeta(vault !== undefined ? `${MM_META.makerIndex}:${lc(vault)}` : MM_META.makerIndex);
    return raw === null ? null : BigInt(raw);
  }

  /** New vault orders and the index after them, atomically. */
  ingestOrders(rows: ReadonlyArray<{ order: TrackedOrder; closed: boolean }>, index: bigint, at: number, vault?: string): void {
    this.store.db.transaction(() => {
      for (const r of rows) this.trackOrder(r.order, r.closed, at, vault);
      this.store.setMeta(vault !== undefined ? `${MM_META.makerIndex}:${lc(vault)}` : MM_META.makerIndex, index.toString());
    })();
  }

  openOrders(vault?: string): TrackedOrder[] {
    const rows = (
      vault === undefined
        ? this.store.db.prepare('SELECT * FROM v2_mm_orders WHERE closed = 0 ORDER BY CAST(order_id AS INTEGER)').all()
        : this.store.db.prepare('SELECT * FROM v2_mm_orders WHERE closed = 0 AND vault = ? ORDER BY CAST(order_id AS INTEGER)').all(lc(vault))
    ) as Array<{ order_id: string; long_id: string; kind: string; price: string; units: string; filled_seen: string }>;
    return rows.map((r) => ({ orderId: BigInt(r.order_id), longId: BigInt(r.long_id), kind: r.kind as TrackedOrder['kind'], price: BigInt(r.price), units: BigInt(r.units), filledSeen: BigInt(r.filled_seen) }));
  }

  trackOrder(order: TrackedOrder, closed: boolean, at: number, vault?: string): void {
    this.store.db
      .prepare('INSERT OR IGNORE INTO v2_mm_orders (order_id, long_id, kind, price, units, filled_seen, closed, seen_at, vault) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(order.orderId.toString(), order.longId.toString(), order.kind, order.price.toString(), order.units.toString(), order.filledSeen.toString(), closed ? 1 : 0, at, vault !== undefined ? lc(vault) : '');
  }

  /** A fill (when `event` is given) and the order's new `filled`, atomically: a crash never counts a fill twice. */
  recordOrderProgress(orderId: bigint, filled: bigint, closed: boolean, event: LedgerEvent | null, vault?: string): void {
    this.store.db.transaction(() => {
      if (event !== null) this.insertLedger(event, `fill:${orderId}:${filled}`, vault);
      this.store.db.prepare('UPDATE v2_mm_orders SET filled_seen = ?, closed = ? WHERE order_id = ?').run(filled.toString(), closed ? 1 : 0, orderId.toString());
    })();
  }

  /*------------------------------ ledger ------------------------------*/

  private insertLedger(event: LedgerEvent, uniq: string, vault?: string): void {
    const data = event.type === 'fill'
      ? {
          side: event.side,
          units: event.units.toString(),
          price: event.price.toString(),
          feeBps: event.feeBps,
          ...(event.premium !== undefined && event.sellerFee !== undefined ? { premium: event.premium.toString(), sellerFee: event.sellerFee.toString() } : {}),
        }
      : { isPut: event.isPut, strike: event.strike.toString(), settlementPrice: event.settlementPrice.toString(), ...(event.exerciseFeeBps === undefined ? {} : { exerciseFeeBps: event.exerciseFeeBps }) };
    this.store.db.prepare('INSERT OR IGNORE INTO v2_mm_ledger (type, long_id, data_json, at, uniq, vault) VALUES (?, ?, ?, ?, ?, ?)').run(event.type, event.longId, JSON.stringify(data), event.at, uniq, vault !== undefined ? lc(vault) : '');
  }

  /**
   * THE WORST BUG THE MULTI-VAULT REWRITE LEFT BEHIND (F-DAPP-01), and it is mine.
   *
   * `uniq` is a globally UNIQUE column and this key used to be `settle:<longId>` with no vault in it, while the
   * vault travelled alongside as an ordinary COLUMN. That is what made it look finished. Two vaults holding the
   * same series is the NORMAL steady state of this bot, so the second vault's `INSERT OR IGNORE` matched the
   * first vault's row and wrote NOTHING: its settlement never entered its ledger, its expired position was
   * filtered out of `expired` and never settled, and the realised loss never counted toward ITS daily loss
   * limit. No error, no alert, no retry - the per-vault loss stop kept returning a healthy verdict about a
   * subject it could not see. The vault belongs IN the key, not merely beside it.
   */
  recordSettlement(event: Extract<LedgerEvent, { type: 'settle' }>, vault?: string): void {
    this.insertLedger(event, settlementUniq(event.longId, vault), vault);
  }

  /** Per vault, for the same reason {recordSettlement} is. A vault-less call answers the legacy rows only. */
  hasSettlement(longId: bigint, vault?: string): boolean {
    return (
      this.store.db.prepare('SELECT 1 FROM v2_mm_ledger WHERE uniq = ?').get(settlementUniq(longId, vault)) !== undefined
    );
  }

  ledger(vault?: string): LedgerEvent[] {
    const rows = (
      vault === undefined
        ? this.store.db.prepare('SELECT * FROM v2_mm_ledger ORDER BY id').all()
        : this.store.db.prepare('SELECT * FROM v2_mm_ledger WHERE vault = ? ORDER BY id').all(lc(vault))
    ) as Array<{ type: string; long_id: string; data_json: string; at: number }>;
    return rows.map((r): LedgerEvent => {
      const d = JSON.parse(r.data_json) as Record<string, unknown>;
      if (r.type === 'settle') {
        return { type: 'settle', longId: r.long_id, isPut: d.isPut === true, strike: BigInt(d.strike as string), settlementPrice: BigInt(d.settlementPrice as string), ...(typeof d.exerciseFeeBps === 'number' ? { exerciseFeeBps: d.exerciseFeeBps } : {}), at: r.at };
      }
      const exact = typeof d.premium === 'string' && typeof d.sellerFee === 'string' ? { premium: BigInt(d.premium), sellerFee: BigInt(d.sellerFee) } : {};
      return { type: 'fill', longId: r.long_id, side: d.side as 'buy' | 'sell', units: BigInt(d.units as string), price: BigInt(d.price as string), feeBps: Number(d.feeBps), ...exact, at: r.at };
    });
  }

  /**
   * The last complete look at the open orders, or null before one (or on a store written before checkpoints).
   *
   * PER VAULT (F-DAPP-02). One global checkpoint meant every vault after the first resumed from a block another
   * vault had already advanced past, so it scanned a few blocks instead of its own range and booked its sales
   * against whatever fee regime that window carried - silently wrong across a scheduled fee change.
   */
  fillCheckpoint(vault?: string): FillCheckpoint | null {
    const raw = this.store.getMeta(metaKeyFor(MM_META.fillCheckpoint, vault));
    if (raw === null) return null;
    try {
      const c = JSON.parse(raw) as { block: string; at: number; premiumFeeBps: number; resaleFeeBps: number };
      return typeof c.at === 'number' && typeof c.block === 'string' ? { block: BigInt(c.block), at: c.at, premiumFeeBps: Number(c.premiumFeeBps), resaleFeeBps: Number(c.resaleFeeBps) } : null;
    } catch {
      return null;
    }
  }

  setFillCheckpoint(checkpoint: FillCheckpoint, vault?: string): void {
    this.store.setMeta(metaKeyFor(MM_META.fillCheckpoint, vault), JSON.stringify({ block: checkpoint.block.toString(), at: checkpoint.at, premiumFeeBps: checkpoint.premiumFeeBps, resaleFeeBps: checkpoint.resaleFeeBps }));
  }

  /*------------------------------ switches ----------------------------*/

  /** Process-wide kill (POST /kill with no vault). Null when not all-killed. */
  killed(): KilledState | null {
    return this.readKilled(MM_META.killed);
  }

  /** Per-vault kill, or the process-wide kill if that is set. */
  killedFor(vault: string): KilledState | null {
    return this.killed() ?? this.readKilled(`${MM_META.killedVault}${lc(vault)}`);
  }

  setKilled(state: KilledState | null): void {
    this.store.setMeta(MM_META.killed, JSON.stringify(state));
  }

  setKilledFor(vault: string, state: KilledState | null): void {
    this.store.setMeta(`${MM_META.killedVault}${lc(vault)}`, JSON.stringify(state));
  }

  private readKilled(key: string): KilledState | null {
    const raw = this.store.getMeta(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as KilledState | null;
      return parsed && typeof parsed.at === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  lastSync(vault?: string): number | null {
    const raw = this.store.getMeta(vault !== undefined ? `${MM_META.lastSync}:${lc(vault)}` : MM_META.lastSync);
    return raw === null ? null : Number(raw);
  }

  setLastSync(at: number, vault?: string): void {
    this.store.setMeta(vault !== undefined ? `${MM_META.lastSync}:${lc(vault)}` : MM_META.lastSync, String(at));
  }

  /**
   * Where the bot last projected `MakerVault.outflow().used` to be, and the cap it used. The next tick compares the
   * chain's reading with it and pages `v2_mm_outflow_foreign` when someone else spent the vault's USDG. Null before
   * the first tick, and after a deployment reset (the bucket belongs to that vault, not this one).
   */
  outflowProjection(vault?: string): Projection | null {
    const raw = this.store.getMeta(vault !== undefined ? `${MM_META.outflow}:${lc(vault)}` : MM_META.outflow);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { used: string; at: number; cap: string };
      return typeof parsed?.at === 'number' ? { used: BigInt(parsed.used), at: parsed.at, cap: BigInt(parsed.cap) } : null;
    } catch {
      return null;
    }
  }

  setOutflowProjection(p: Projection, vault?: string): void {
    this.store.setMeta(vault !== undefined ? `${MM_META.outflow}:${lc(vault)}` : MM_META.outflow, JSON.stringify({ used: p.used.toString(), at: p.at, cap: p.cap.toString() }));
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
