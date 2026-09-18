/**
 * Durable state of a v2 mode, in SQLite: the journal of sent transactions, alerts, and a meta
 * table for what a later task must remember across restarts ("already alerted", cursors).
 *
 * The discipline is v1's (state.ts, solo.ts:809-837): a transaction is written here the moment it
 * has a hash, BEFORE the receipt wait, so a kill or a lost receipt leaves a `pending` row that the
 * next attempt at the same step finds (tx.ts: in-flight check) instead of sending a duplicate.
 *
 * WHY NOT state.ts. Its module creates the v1 store from the v1 config at import, which exits
 * without a vault or factory key. The tables here are prefixed `v2_`, so a v2 file and a v1 file
 * never share a table even if pointed at the same path.
 *
 * `:memory:` opens an in-memory database (tests). All 256-bit values are decimal TEXT.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

/** `dropped`: no receipt long after submission; the node forgot it or a later nonce replaced it. */
export type V2TxStatus = 'pending' | 'success' | 'reverted' | 'dropped';

export interface V2TxRow {
  hash: string;
  /** The step, e.g. `settle`, `redeemBatch`, `createSeries`. */
  kind: string;
  /** The state transition's identity within the kind, e.g. the longId. The in-flight check keys on (kind, key). */
  tx_key: string;
  nonce: number | null;
  to_address: string;
  function_name: string;
  status: V2TxStatus;
  block_number: string | null;
  gas_used: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS v2_txs (
  hash          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  tx_key        TEXT NOT NULL,
  nonce         INTEGER,
  to_address    TEXT NOT NULL,
  function_name TEXT NOT NULL,
  status        TEXT NOT NULL,
  block_number  TEXT,
  gas_used      TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_txs_by_key ON v2_txs (kind, tx_key, created_at);

CREATE TABLE IF NOT EXISTS v2_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  message    TEXT NOT NULL,
  data_json  TEXT,
  delivered  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Resolved journal rows and stored alerts older than this are pruned (pruneHistory): the file must not grow forever. */
export const HISTORY_RETENTION_MS = 30 * 86_400_000;

export class V2Store {
  readonly db: Database.Database;
  readonly path: string;

  constructor(dbPath: string) {
    if (dbPath === ':memory:') {
      this.path = dbPath;
    } else {
      this.path = resolve(dbPath);
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new Database(this.path);
    // WAL keeps the health endpoint's reads from blocking the loop's writes.
    if (this.path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after a file may already exist: added in place, never a table rebuild. */
  private migrate(): void {
    const alertColumns = new Set((this.db.prepare('PRAGMA table_info(v2_alerts)').all() as Array<{ name: string }>).map((c) => c.name));
    // dedupe_key: which later delivery supersedes a failed one. failed_at: the last failed delivery, wall clock ms.
    if (!alertColumns.has('dedupe_key')) this.db.exec('ALTER TABLE v2_alerts ADD COLUMN dedupe_key TEXT');
    if (!alertColumns.has('failed_at')) this.db.exec('ALTER TABLE v2_alerts ADD COLUMN failed_at INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS v2_alerts_undelivered ON v2_alerts (delivered, failed_at)');
    // recentTxs (every /state) reads the newest rows through this instead of sorting the whole journal.
    this.db.exec('CREATE INDEX IF NOT EXISTS v2_txs_by_created ON v2_txs (created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS v2_alerts_by_created ON v2_alerts (created_at)');
  }

  close(): void {
    this.db.close();
  }

  /*------------------------------- txs --------------------------------*/

  recordTxSubmitted(tx: { hash: string; kind: string; key: string; nonce: number | null; to: string; functionName: string }, at = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO v2_txs (hash, kind, tx_key, nonce, to_address, function_name, status, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING',
      )
      .run(tx.hash, tx.kind, tx.key, tx.nonce, tx.to, tx.functionName, 'pending' satisfies V2TxStatus, at, at);
  }

  recordTxResult(hash: string, status: V2TxStatus, blockNumber: bigint | null, gasUsed: bigint | null, error: string | null, at = Date.now()): void {
    this.db
      .prepare('UPDATE v2_txs SET status = ?, block_number = ?, gas_used = ?, error = ?, updated_at = ? WHERE hash = ?')
      .run(status, blockNumber === null ? null : blockNumber.toString(), gasUsed === null ? null : gasUsed.toString(), error, at, hash);
  }

  getTx(hash: string): V2TxRow | null {
    return (this.db.prepare('SELECT * FROM v2_txs WHERE hash = ?').get(hash) as V2TxRow | undefined) ?? null;
  }

  /** The newest submission for (kind, key), resolved or not. */
  latestTx(kind: string, key: string): V2TxRow | null {
    return (
      (this.db.prepare('SELECT * FROM v2_txs WHERE kind = ? AND tx_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(kind, key) as V2TxRow | undefined) ??
      null
    );
  }

  pendingTxs(): V2TxRow[] {
    return this.db.prepare("SELECT * FROM v2_txs WHERE status = 'pending' ORDER BY created_at ASC").all() as V2TxRow[];
  }

  recentTxs(limit = 20): V2TxRow[] {
    return this.db.prepare('SELECT * FROM v2_txs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as V2TxRow[];
  }

  /*------------------------------ alerts ------------------------------*/

  recordAlert(kind: string, severity: string, message: string, data: unknown, delivered: boolean, dedupeKey: string | null = null, at = Date.now()): number {
    const info = this.db
      .prepare('INSERT INTO v2_alerts (kind, severity, message, data_json, delivered, created_at, dedupe_key) VALUES (?,?,?,?,?,?,?)')
      .run(kind, severity, message, data === undefined ? null : JSON.stringify(data, bigintReplacer), delivered ? 1 : 0, at, dedupeKey);
    return Number(info.lastInsertRowid);
  }

  markAlertDelivered(id: number): void {
    this.db.prepare('UPDATE v2_alerts SET delivered = 1 WHERE id = ?').run(id);
  }

  /** Alert `id` was delivered: it, and every earlier undelivered row of its (kind, dedupe key), need no redelivery. */
  markAlertsDeliveredUpTo(id: number, kind: string, dedupeKey: string | null): void {
    this.db.prepare('UPDATE v2_alerts SET delivered = 1 WHERE id <= ? AND delivered = 0 AND kind = ? AND dedupe_key IS ?').run(id, kind, dedupeKey);
  }

  /** Whether a row of (kind, dedupe key) created at or after `since` has been delivered (directly, redelivered, or superseded). */
  alertDeliveredSince(kind: string, dedupeKey: string | null, since: number): boolean {
    return this.db.prepare('SELECT 1 FROM v2_alerts WHERE kind = ? AND dedupe_key IS ? AND created_at >= ? AND delivered = 1 LIMIT 1').get(kind, dedupeKey, since) !== undefined;
  }

  markAlertFailed(id: number, at: number): void {
    this.db.prepare('UPDATE v2_alerts SET failed_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * Rows whose delivery failed and nothing delivered since, newest of each (kind, dedupe key), created at or after
   * `since` and last tried at or before `triedBefore`: what Alerter.redeliver sends again. Oldest first, at most `limit`.
   */
  undeliveredAlerts(options: { since: number; triedBefore: number; limit: number }): Array<{ id: number; kind: string; severity: string; message: string; data_json: string | null; dedupe_key: string | null; created_at: number }> {
    const rows = this.db
      .prepare('SELECT id, kind, severity, message, data_json, dedupe_key, created_at, failed_at FROM v2_alerts WHERE delivered = 0 AND failed_at IS NOT NULL AND created_at >= ? ORDER BY id DESC LIMIT 1000')
      .all(options.since) as Array<{ id: number; kind: string; severity: string; message: string; data_json: string | null; dedupe_key: string | null; created_at: number; failed_at: number }>;
    const seen = new Set<string>();
    const newest = rows.filter((r) => {
      const k = `${r.kind}\u0000${r.dedupe_key ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return newest.filter((r) => r.failed_at <= options.triedBefore).reverse().slice(0, options.limit);
  }

  /*------------------------------- meta -------------------------------*/

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM v2_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO v2_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, Date.now());
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM v2_meta WHERE key = ?').run(key);
  }

  /** Delete every meta key starting with `prefix` (compared literally, not as a LIKE pattern), except `keep`. */
  deleteMetaWithPrefix(prefix: string, keep: readonly string[] = []): number {
    const rows = this.db.prepare('SELECT key FROM v2_meta WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as Array<{ key: string }>;
    const del = this.db.prepare('DELETE FROM v2_meta WHERE key = ?');
    let n = 0;
    for (const { key } of rows) {
      if (keep.includes(key)) continue;
      del.run(key);
      n += 1;
    }
    return n;
  }

  /**
   * Mark every `pending` submission `dropped`: for a store reset to another deployment (anchor.ts), whose chain
   * never mined them. Left pending, each would block its (kind, key) for the in-flight TTL.
   */
  dropPendingTxs(reason: string, at = Date.now()): number {
    return this.db.prepare("UPDATE v2_txs SET status = 'dropped', error = ?, updated_at = ? WHERE status = 'pending'").run(reason, at).changes;
  }

  /**
   * Delete journal rows that are resolved (not `pending`: a pending row guards its (kind, key) against a duplicate) and
   * alerts that need no redelivery, both created before `now − HISTORY_RETENTION_MS`. Returns what went.
   */
  pruneHistory(now = Date.now()): { txs: number; alerts: number } {
    const before = now - HISTORY_RETENTION_MS;
    return this.db.transaction(() => ({
      txs: this.db.prepare("DELETE FROM v2_txs WHERE status != 'pending' AND created_at < ?").run(before).changes,
      alerts: this.db.prepare('DELETE FROM v2_alerts WHERE created_at < ?').run(before).changes,
    }))();
  }

  /*------------------------------ counts ------------------------------*/

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const table of ['v2_txs', 'v2_alerts', 'v2_meta'] as const) {
      out[table] = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return out;
  }
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
