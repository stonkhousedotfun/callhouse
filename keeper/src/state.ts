/**
 * Durable keeper state, in SQLite.
 *
 * The keeper is a single process that must survive being killed at any instant — including
 * between `vault.approveListing()` landing on chain and its receipt coming back. That is why a
 * listing row is written BEFORE the approval is sent (status `submitted`, with the components,
 * salt and counter): the order is on disk whatever happens to the receipt, so a lost receipt or
 * a kill mid-wait is adopted by hash on the next tick instead of being invalidated as foreign.
 * Everything else the keeper does is written here before and after the fact too, and `roll.ts`
 * reconciles this table against live vault state on every boot and every tick. Nothing is
 * inferred from "it is Friday, so I probably armed already".
 *
 * All 256-bit values are stored as decimal TEXT. SQLite integers are 64-bit and an optionId is
 * 256 bits; storing one as INTEGER silently truncates it.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { log } from './logger.js';

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

/**
 * Where a cycle got to. A row exists only for a cycle the vault ARMED (`rollOpen` landed), and
 * it is keyed by the vault's own `cycleNumber`. A week the keeper decided not to arm has no
 * row: it is remembered in `meta` (`skip_reason:<exerciseTs>`) and published as an alert.
 *   open      armed and Listed; `contracts` is what has sold so far (== contractsWritten).
 *   locked    lockBook ran; the exercise window is open.
 *   closed    rollClose ran and the claim (if any) was redeemed.
 *   stranded  rollClose ran but the claim could not be redeemed (AF-02); `strand_gen` is set and
 *             `retryStrandedClaim` closes it out later, recording `retry_tx`.
 */
export type CycleStatus = 'open' | 'locked' | 'closed' | 'stranded';

/**
 * Listing lifecycle, from Seaport's own `getOrderStatus` and the vault's `listingHash`.
 *   submitted  built and handed to vault.approveListing; not confirmed yet. Written BEFORE the
 *              send so the components survive a lost receipt or a kill. Never served.
 *   failed     the approval reverted, was never broadcast, or was dropped unmined. Never served.
 *              Adopted back to `approved` if the vault turns out to authorise its hash after all.
 *   approved   vault.approveListing landed; the order is validated on Seaport, nothing filled.
 *   partial    Seaport reports a fraction filled and the order is still live.
 *   filled     Seaport reports it fully filled.
 *   cancelled  cancelListing (Seaport isCancelled) or invalidateAllListings (counter bump; Seaport
 *              never sets isCancelled, the vault's listingHash going to zero is the signal).
 *   expired    killed by lockBook or rollClose (counter bump at the end of the week).
 * `approved` and `partial` are what /orders serves.
 */
export type ListingStatus = 'submitted' | 'failed' | 'approved' | 'partial' | 'filled' | 'cancelled' | 'expired';

export type TxKind =
  | 'newOptionType'
  | 'rollOpen'
  | 'approveListing'
  | 'cancelListing'
  | 'invalidateAllListings'
  | 'lockBook'
  | 'rollClose'
  | 'retryStrandedClaim'
  | 'settleQueue';

/** `dropped`: never mined and no longer pending in the keeper's mempool (the node forgot it, or a
 *  later nonce replaced it). Distinct from `reverted`, which was mined. */
export type TxStatus = 'pending' | 'success' | 'reverted' | 'dropped';

export interface CycleRow {
  cycle_number: number;
  option_id: string | null;
  strike_usdg6: string | null;
  /** Contracts SOLD so far (== `contractsWritten`, the sum of `CallsWritten` for the cycle):
   *  0 at the arm, updated on every fill the keeper observes, final at the close. */
  contracts: number | null;
  exercise_ts: number | null;
  expiry_ts: number | null;
  lot_size: string | null;
  status: CycleStatus;
  skip_reason: string | null;
  roll_open_tx: string | null;
  lock_tx: string | null;
  roll_close_tx: string | null;
  gross_usdg6: string | null;
  fee_usdg6: string | null;
  net_usdg6: string | null;
  contracts_assigned: number | null;
  /** `RollClose.assetsReturned`: underlying handed back by the redeemed claim, asset base units
   *  (wei). NULL on a close with no RollClose. A stranded close reports 0; the recovery then
   *  records the LIVE SHARES' part of `StrandedClaimRecovered.assets` (the queue epochs' share,
   *  `floor(assets × queueWad / 1e18)`, went to the reserve, not to the cycle). */
  assets_returned: string | null;
  /** `RollClose.usdgFromAssignment`: strike proceeds from assigned contracts, USDG base units.
   *  Already INSIDE `gross_usdg6` (the terminal Harvest includes it) and fee-free, so premium is
   *  `gross_usdg6 - usdg_from_assignment`. NULL means unknown, never 0. For a recovered stranded
   *  cycle it is `usdgOut - floor(usdgOut × queueWad / 1e18)`: exactly what the retry's Harvest
   *  carried, so the same subtraction still yields the close-time premium. */
  usdg_from_assignment: string | null;
  /** Reprices this cycle: approveListing calls after the first. The vault caps the total at 3. */
  relists_used: number;
  opened_at: number | null;
  locked_at: number | null;
  closed_at: number | null;
  /** `ClaimStranded.gen` when the close stranded the claim; NULL otherwise. */
  strand_gen: string | null;
  /** The `retryStrandedClaim` transaction that recovered it; NULL until it has. */
  retry_tx: string | null;
  /** The arm's PricingRecord (policy.ts) as JSON: how the strike was picked and the first ask
   *  priced. NULL for a cycle armed before the column existed or adopted from chain. Added by
   *  migration, so typed optional for rows built in code; a row read back always carries it. */
  pricing_json?: string | null;
  created_at: number;
  updated_at: number;
}

export interface ListingRow {
  order_hash: string;
  cycle_number: number;
  seq: number;
  option_id: string;
  /** The order's size (`vault.listingAmount`), not the unfilled remainder. */
  contracts: string;
  unit_price6: string;
  /** `unit_price6 × contracts`: the ONE consideration item, paid to the vault in full. There is
   *  no venue fee item and no second recipient. */
  gross_usdg6: string;
  end_time: number;
  counter: string;
  salt: string;
  components_json: string;
  /** Always '0x'. The vault pre-validates on Seaport; no signature exists. */
  signature: string;
  approve_tx: string | null;
  cancel_tx: string | null;
  status: ListingStatus;
  /** Seaport's own `getOrderStatus` fraction, as last read: the fill is `contracts × filled /
   *  size`. Both NULL until the first read. */
  seaport_total_filled: string | null;
  seaport_total_size: string | null;
  seaport_cancelled: number | null;
  /** This listing's PricingRecord (policy.ts) as JSON: strike, spot, floor, fair value, edge,
   *  delta, iv and where the ask came from. /orders and /state serve it parsed. NULL for a row
   *  written before the column existed. Added by migration; optional on insert. */
  pricing_json?: string | null;
  created_at: number;
  updated_at: number;
}

export interface TxRow {
  hash: string;
  kind: TxKind;
  cycle_number: number | null;
  status: TxStatus;
  block_number: string | null;
  gas_used: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AlertRow {
  id: number;
  kind: string;
  severity: string;
  message: string;
  data_json: string | null;
  delivered: number;
  created_at: number;
}

/*//////////////////////////////////////////////////////////////
                             SCHEMA
//////////////////////////////////////////////////////////////*/

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cycles (
  cycle_number       INTEGER PRIMARY KEY,
  option_id          TEXT,
  strike_usdg6       TEXT,
  contracts          INTEGER,
  exercise_ts        INTEGER,
  expiry_ts          INTEGER,
  lot_size           TEXT,
  status             TEXT NOT NULL,
  skip_reason        TEXT,
  roll_open_tx       TEXT,
  lock_tx            TEXT,
  roll_close_tx      TEXT,
  gross_usdg6        TEXT,
  fee_usdg6          TEXT,
  net_usdg6          TEXT,
  contracts_assigned INTEGER,
  assets_returned    TEXT,
  usdg_from_assignment TEXT,
  relists_used       INTEGER NOT NULL DEFAULT 0,
  opened_at          INTEGER,
  locked_at          INTEGER,
  closed_at          INTEGER,
  strand_gen         TEXT,
  retry_tx           TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  order_hash           TEXT PRIMARY KEY,
  cycle_number         INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  option_id            TEXT NOT NULL,
  contracts            TEXT NOT NULL,
  unit_price6          TEXT NOT NULL,
  gross_usdg6          TEXT NOT NULL,
  end_time             INTEGER NOT NULL,
  counter              TEXT NOT NULL,
  salt                 TEXT NOT NULL,
  components_json      TEXT NOT NULL,
  signature            TEXT NOT NULL,
  approve_tx           TEXT,
  cancel_tx            TEXT,
  status               TEXT NOT NULL,
  seaport_total_filled TEXT,
  seaport_total_size   TEXT,
  seaport_cancelled    INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_by_cycle ON listings (cycle_number, seq);

CREATE TABLE IF NOT EXISTS txs (
  hash         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  cycle_number INTEGER,
  status       TEXT NOT NULL,
  block_number TEXT,
  gas_used     TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS txs_by_cycle ON txs (cycle_number, created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  message    TEXT NOT NULL,
  data_json  TEXT,
  delivered  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_by_kind ON alerts (kind, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Columns added after the first release, as forward migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database created by an earlier keeper, so a column
 * added to SCHEMA alone never reaches the production file on the volume — and the first
 * `updateCycle` naming it would throw "no such column" inside rollClose. Each entry is applied
 * with `ALTER TABLE ... ADD COLUMN` only when `PRAGMA table_info` says it is missing, so the
 * migration is idempotent and a fresh database (which already has the column) skips it. Existing
 * rows read NULL: "not recorded", which is the truth for a week closed before the column existed.
 * Append only; never reorder or remove.
 *
 * The first release shipped this list EMPTY. The SCHEMA above is the write-on-fill schema of
 * 2026-09-14 and no keeper database predates it: the columns the pre-redesign keeper had grown by
 * migration (`assets_returned`, `usdg_from_assignment`, `strand_gen`, `retry_tx`) are in the
 * table from the start, and the Overcall-shaped listing columns it carried (`to_vault6`,
 * `to_overcall6`, `api_status`, `api_error`, `posted_at`, `visible_at`, `filled_numerator`,
 * `filled_denominator`) are gone rather than dragged along as always-NULL. SCHEMA stays frozen at
 * that release; every later column arrives here, so a fresh file and the production file on the
 * volume take the same path to the same table.
 */
const MIGRATIONS: ReadonlyArray<Migration> = [
  // 2026-09-15, volatility-aware pricing: every number behind a strike and an ask, per listing
  // (served by /orders and /state) and per cycle (the arm's decision).
  { table: 'listings', column: 'pricing_json', type: 'TEXT' },
  { table: 'cycles', column: 'pricing_json', type: 'TEXT' },
];

export interface Migration {
  table: string;
  column: string;
  type: string;
}

/** Apply the migrations `db` has not had yet, in one transaction; the columns actually added. */
export function applyMigrations(db: Database.Database, migrations: ReadonlyArray<Migration>): Migration[] {
  const added: Migration[] = [];
  const apply = db.transaction(() => {
    for (const migration of migrations) {
      const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{ name: string }>;
      if (columns.some((c) => c.name === migration.column)) continue;
      db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.type}`);
      added.push(migration);
    }
  });
  apply();
  return added;
}

/** Columns the generic updaters are allowed to touch. Keeps the dynamic SQL honest. */
const CYCLE_COLUMNS = new Set<keyof CycleRow>([
  'option_id',
  'strike_usdg6',
  'contracts',
  'exercise_ts',
  'expiry_ts',
  'lot_size',
  'status',
  'skip_reason',
  'roll_open_tx',
  'lock_tx',
  'roll_close_tx',
  'gross_usdg6',
  'fee_usdg6',
  'net_usdg6',
  'contracts_assigned',
  'assets_returned',
  'usdg_from_assignment',
  'relists_used',
  'opened_at',
  'locked_at',
  'closed_at',
  'strand_gen',
  'retry_tx',
  'pricing_json',
]);

const LISTING_COLUMNS = new Set<keyof ListingRow>([
  'approve_tx',
  'cancel_tx',
  'status',
  'seaport_total_filled',
  'seaport_total_size',
  'seaport_cancelled',
]);

type SqlValue = string | number | bigint | null;

/*//////////////////////////////////////////////////////////////
                             STORE
//////////////////////////////////////////////////////////////*/

export class KeeperStore {
  readonly db: Database.Database;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = resolve(dbPath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    // WAL keeps the health endpoint's reads from blocking the loop's writes.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL'); // durability beats throughput; we write a few rows a week
    this.db.exec(SCHEMA);
    this.migrate();
    log.state.info({ path: this.path }, 'state database opened');
  }

  close(): void {
    this.db.close();
  }

  /** Apply MIGRATIONS that this file has not had yet. Runs in one transaction. */
  private migrate(): void {
    for (const { table, column } of applyMigrations(this.db, MIGRATIONS)) {
      log.state.info({ table, column }, 'migrated: added column');
    }
  }

  /*------------------------------- meta -------------------------------*/

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, Date.now());
  }

  getMetaNumber(key: string): number | null {
    const raw = this.getMeta(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /** The loop's liveness marker. /health reports the age of this. */
  beat(at: number = Date.now()): void {
    this.setMeta('last_heartbeat_ms', String(at));
  }

  lastHeartbeat(): number | null {
    return this.getMetaNumber('last_heartbeat_ms');
  }

  /*------------------------------ cycles ------------------------------*/

  getCycle(cycleNumber: number): CycleRow | null {
    const row = this.db.prepare('SELECT * FROM cycles WHERE cycle_number = ?').get(cycleNumber) as
      | CycleRow
      | undefined;
    return row ?? null;
  }

  latestCycle(): CycleRow | null {
    const row = this.db.prepare('SELECT * FROM cycles ORDER BY cycle_number DESC LIMIT 1').get() as
      | CycleRow
      | undefined;
    return row ?? null;
  }

  /** Create the row if it is new; never clobbers an existing one. */
  ensureCycle(cycleNumber: number, status: CycleStatus): CycleRow {
    const existing = this.getCycle(cycleNumber);
    if (existing) return existing;
    const now = Date.now();
    this.db
      .prepare('INSERT INTO cycles (cycle_number, status, relists_used, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run(cycleNumber, status, now, now);
    const created = this.getCycle(cycleNumber);
    if (!created) throw new Error(`failed to create cycle row ${cycleNumber}`);
    return created;
  }

  updateCycle(cycleNumber: number, patch: Partial<CycleRow>): void {
    const entries = Object.entries(patch).filter(([k]) => CYCLE_COLUMNS.has(k as keyof CycleRow));
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => normalise(v));
    this.db
      .prepare(`UPDATE cycles SET ${sets}, updated_at = ? WHERE cycle_number = ?`)
      .run(...values, Date.now(), cycleNumber);
    if (patch.status !== undefined) {
      log.state.info({ cycleNumber, status: patch.status }, 'cycle status');
    }
  }

  /** True when this cycle has already been decided, either way. A row exists only because the
   *  keeper opened it or deliberately skipped it, and both are decisions we do not revisit. */
  isCycleHandled(cycleNumber: number): boolean {
    return this.getCycle(cycleNumber) !== null;
  }

  recentCycles(limit = 12): CycleRow[] {
    return this.db.prepare('SELECT * FROM cycles ORDER BY cycle_number DESC LIMIT ?').all(limit) as CycleRow[];
  }

  /*----------------------------- listings -----------------------------*/

  insertListing(row: Omit<ListingRow, 'created_at' | 'updated_at'>): void {
    // pricing_json is optional on the way in; the named binding is not.
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO listings (
           order_hash, cycle_number, seq, option_id, contracts, unit_price6, gross_usdg6,
           end_time, counter, salt, components_json, signature, approve_tx, cancel_tx, status,
           seaport_total_filled, seaport_total_size, seaport_cancelled, pricing_json, created_at, updated_at
         ) VALUES (
           @order_hash, @cycle_number, @seq, @option_id, @contracts, @unit_price6, @gross_usdg6,
           @end_time, @counter, @salt, @components_json, @signature, @approve_tx, @cancel_tx, @status,
           @seaport_total_filled, @seaport_total_size, @seaport_cancelled, @pricing_json, @created_at, @updated_at
         )
         ON CONFLICT(order_hash) DO NOTHING`,
      )
      .run({ ...row, pricing_json: row.pricing_json ?? null, created_at: now, updated_at: now });
  }

  getListing(orderHash: string): ListingRow | null {
    const row = this.db.prepare('SELECT * FROM listings WHERE order_hash = ?').get(orderHash) as
      | ListingRow
      | undefined;
    return row ?? null;
  }

  listingsForCycle(cycleNumber: number): ListingRow[] {
    return this.db
      .prepare('SELECT * FROM listings WHERE cycle_number = ? ORDER BY seq ASC')
      .all(cycleNumber) as ListingRow[];
  }

  latestListingForCycle(cycleNumber: number): ListingRow | null {
    const row = this.db
      .prepare('SELECT * FROM listings WHERE cycle_number = ? ORDER BY seq DESC LIMIT 1')
      .get(cycleNumber) as ListingRow | undefined;
    return row ?? null;
  }

  /**
   * Listings whose payload should still be offered to buyers from our own fill page.
   *
   * `end_time` is the order's Seaport endTime, i.e. the cycle's exerciseTimestamp. Past it
   * Seaport rejects the fill, so an expired row must never reach /orders: the fill page would
   * be showing a buyer an order that cannot be filled. It is also the only guard that holds
   * when the vault went straight from Listed to rollClose without a `lockBook` — `rollClose`
   * kills listings by bumping the Seaport counter, which does NOT set `isCancelled`, so polling
   * alone would never retire the row.
   */
  openListings(nowSeconds: number = Math.floor(Date.now() / 1000)): ListingRow[] {
    return this.db
      .prepare("SELECT * FROM listings WHERE status IN ('approved','partial') AND end_time > ? ORDER BY created_at DESC")
      .all(nowSeconds) as ListingRow[];
  }

  /** Rows written before their approveListing confirmed and not yet resolved either way. */
  unconfirmedListingsForCycle(cycleNumber: number): ListingRow[] {
    return this.db
      .prepare("SELECT * FROM listings WHERE cycle_number = ? AND status = 'submitted' ORDER BY seq ASC")
      .all(cycleNumber) as ListingRow[];
  }

  /** Every listing for a cycle that still offers an order: the same set /orders serves. */
  liveListingsForCycle(cycleNumber: number): ListingRow[] {
    return this.db
      .prepare("SELECT * FROM listings WHERE cycle_number = ? AND status IN ('approved','partial') ORDER BY seq ASC")
      .all(cycleNumber) as ListingRow[];
  }

  updateListing(orderHash: string, patch: Partial<ListingRow>): void {
    const entries = Object.entries(patch).filter(([k]) => LISTING_COLUMNS.has(k as keyof ListingRow));
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => normalise(v));
    this.db
      .prepare(`UPDATE listings SET ${sets}, updated_at = ? WHERE order_hash = ?`)
      .run(...values, Date.now(), orderHash);
    if (patch.status !== undefined) {
      log.state.debug({ orderHash, status: patch.status }, 'listing status');
    }
  }

  /*------------------------------- txs --------------------------------*/

  recordTxSubmitted(hash: string, kind: TxKind, cycleNumber: number | null): void {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO txs (hash, kind, cycle_number, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(hash) DO NOTHING',
      )
      .run(hash, kind, cycleNumber, 'pending' satisfies TxStatus, now, now);
  }

  recordTxResult(
    hash: string,
    status: TxStatus,
    blockNumber: bigint | null,
    gasUsed: bigint | null,
    error: string | null,
  ): void {
    this.db
      .prepare('UPDATE txs SET status = ?, block_number = ?, gas_used = ?, error = ?, updated_at = ? WHERE hash = ?')
      .run(
        status,
        blockNumber === null ? null : blockNumber.toString(),
        gasUsed === null ? null : gasUsed.toString(),
        error,
        Date.now(),
        hash,
      );
    if (status === 'reverted') {
      log.state.warn({ hash, error }, 'transaction reverted on chain');
    }
  }

  getTx(hash: string): TxRow | null {
    const row = this.db.prepare('SELECT * FROM txs WHERE hash = ?').get(hash) as TxRow | undefined;
    return row ?? null;
  }

  /** The newest transaction the keeper submitted of a kind for a cycle, resolved or not. This
   *  is how a cycle row written without its tx hash (an adopted cycle, a lost write) recovers
   *  it: every submission is recorded here BEFORE the receipt wait. */
  latestTxForCycle(kind: TxKind, cycleNumber: number): TxRow | null {
    const row = this.db
      .prepare('SELECT * FROM txs WHERE kind = ? AND cycle_number = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(kind, cycleNumber) as TxRow | undefined;
    return row ?? null;
  }

  /** The newest submissions of a kind recorded without a cycle number (rollOpen goes out before
   *  the vault has numbered the cycle), for adoption after a lost receipt. */
  unattachedTxs(kind: TxKind, limit: number): TxRow[] {
    return this.db
      .prepare('SELECT * FROM txs WHERE kind = ? AND cycle_number IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(kind, limit) as TxRow[];
  }

  attachTxToCycle(hash: string, cycleNumber: number): void {
    this.db.prepare('UPDATE txs SET cycle_number = ?, updated_at = ? WHERE hash = ?').run(cycleNumber, Date.now(), hash);
  }

  pendingTxs(): TxRow[] {
    return this.db.prepare("SELECT * FROM txs WHERE status = 'pending' ORDER BY created_at ASC").all() as TxRow[];
  }

  recentTxs(limit = 20): TxRow[] {
    return this.db.prepare('SELECT * FROM txs ORDER BY created_at DESC LIMIT ?').all(limit) as TxRow[];
  }

  /*------------------------------ alerts ------------------------------*/

  recordAlert(kind: string, severity: string, message: string, data: unknown, delivered: boolean): number {
    const info = this.db
      .prepare('INSERT INTO alerts (kind, severity, message, data_json, delivered, created_at) VALUES (?,?,?,?,?,?)')
      .run(kind, severity, message, data === undefined ? null : JSON.stringify(data, bigintReplacer), delivered ? 1 : 0, Date.now());
    return Number(info.lastInsertRowid);
  }

  markAlertDelivered(id: number): void {
    this.db.prepare('UPDATE alerts SET delivered = 1 WHERE id = ?').run(id);
  }

  recentAlerts(limit = 20): AlertRow[] {
    return this.db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit) as AlertRow[];
  }

  /*------------------------------ counts ------------------------------*/

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const table of ['cycles', 'listings', 'txs', 'alerts', 'meta'] as const) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      out[table] = row.n;
    }
    return out;
  }
}

/*//////////////////////////////////////////////////////////////
                            HELPERS
//////////////////////////////////////////////////////////////*/

/** A cycle row as `/cycles` serves it: the stored columns plus the harvest split. */
export type CycleTapeRow = CycleRow & {
  /** `gross_usdg6 - usdg_from_assignment`: the premium the week earned, before the fee. */
  premium_gross_usdg6: string | null;
  /** `usdg_from_assignment` under the name a reader looks for: returned principal, not yield. */
  strike_proceeds_usdg6: string | null;
};

/**
 * Split a cycle's gross harvest into premium and strike proceeds.
 *
 * On an assigned week the terminal `Harvest.grossUsdg` includes `RollClose.usdgFromAssignment`,
 * so the gross alone reads returned principal as yield. Both halves are null when the strike
 * proceeds are unknown (a row closed before the column existed, a receipt with no RollClose):
 * an unknown split is never published as "0 strike proceeds". Proceeds above the gross would be
 * a vault defect; the premium then reads 0, never a negative number.
 */
export function splitGross(
  gross: bigint,
  usdgFromAssignment: bigint | null,
): { premium: bigint | null; strikeProceeds: bigint | null } {
  if (usdgFromAssignment === null) return { premium: null, strikeProceeds: null };
  return { premium: gross > usdgFromAssignment ? gross - usdgFromAssignment : 0n, strikeProceeds: usdgFromAssignment };
}

/** `/cycles` row: every stored column plus the split. Null wherever the gross or the proceeds are. */
export function cycleTapeRow(row: CycleRow): CycleTapeRow {
  if (row.gross_usdg6 === null || row.usdg_from_assignment === null) {
    return { ...row, premium_gross_usdg6: null, strike_proceeds_usdg6: null };
  }
  const { premium, strikeProceeds } = splitGross(BigInt(row.gross_usdg6), BigInt(row.usdg_from_assignment));
  return {
    ...row,
    premium_gross_usdg6: premium === null ? null : premium.toString(),
    strike_proceeds_usdg6: strikeProceeds === null ? null : strikeProceeds.toString(),
  };
}

/** better-sqlite3 binds only string/number/bigint/Buffer/null. Booleans and bigints come
 *  through the patch objects, so normalise them here rather than at every call site. */
function normalise(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return JSON.stringify(value, bigintReplacer);
}

/** A stored pricing_json as an object, or null: NULL, unparseable or not an object. What /orders
 *  and /state serve, so a corrupt row degrades to "not recorded" rather than a 500. */
export function parsePricingJson(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** The process-wide store. */
export const store = new KeeperStore(config.KEEPER_DB_PATH);
