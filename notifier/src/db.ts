/**
 * The database seam: a two-method interface over `pg` in production and PGlite in the tests, and
 * the migration runner.
 *
 * WHY AN INTERFACE AND NOT pg.Pool EVERYWHERE: the storage tests run on PGlite (real Postgres
 * compiled to WASM, in-process), which has its own client API. Both speak the same SQL, so every
 * query in this package is plain parameterised Postgres, written once, and the two adapters only
 * translate calls. Rules the SQL follows so both drivers return the same JS values:
 *   - counts are cast `::int` (pg returns int8 as a string, PGlite as a number);
 *   - jsonb parameters are passed as JSON text with `$n::jsonb` (pg turns a JS array into a
 *     Postgres array literal, not JSON);
 *   - timestamps are timestamptz, written from the application clock as a Date with
 *     `$n::timestamptz`, and read back as Date by both drivers.
 *
 * DEADLINES. The pool gives up connecting after 5 s and the server cancels any statement after
 * 10 s, so a hung database stalls a request or a delivery pass, never the process.
 *
 * MIGRATIONS are plain SQL files in ../migrations, applied in name order at boot, each once,
 * recorded in notifier.migration. The whole run is one transaction holding an advisory lock, so
 * two booting replicas cannot interleave and a failed file leaves nothing half-applied.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Logger } from './log.js';
import { errorCode } from './log.js';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<R = Row>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

export interface TxHandle extends Queryable {
  /** Run a multi-statement SQL script (no parameters). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** src/ and dist/ are both one level below the package root, so this resolves from either. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function createPgDb(connectionString: string, logger: Logger): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
  // An idle client losing its connection emits here; unhandled, it would crash the process.
  pool.on('error', (error) => logger.warn({ errorCode: errorCode(error) }, 'postgres idle client error'));

  const wrap = (client: { query: pg.Pool['query'] }): Queryable => ({
    async query<R>(text: string, params: unknown[] = []) {
      const result = await client.query(text, params);
      return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
    },
  });

  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const handle: TxHandle = {
          ...wrap(client as unknown as { query: pg.Pool['query'] }),
          async exec(sql) {
            // No parameters: pg uses the simple protocol, which accepts several statements.
            await client.query(sql);
          },
        };
        const out = await fn(handle);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Apply every not-yet-applied migration in `dir`. Returns the names applied this run. */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return db.transaction(async (tx) => {
    // hashtext is stable across Postgres versions; any constant works as long as it is shared.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('callhouse-notifier/migrate'))`);
    await tx.exec(`
      CREATE SCHEMA IF NOT EXISTS notifier;
      CREATE TABLE IF NOT EXISTS notifier.migration (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const done = new Set(
      (await tx.query<{ name: string }>('SELECT name FROM notifier.migration')).rows.map((r) => r.name),
    );
    const applied: string[] = [];
    for (const name of files) {
      if (done.has(name)) continue;
      await tx.exec(readFileSync(`${dir}${dir.endsWith('/') ? '' : '/'}${name}`, 'utf8'));
      await tx.query('INSERT INTO notifier.migration (name) VALUES ($1)', [name]);
      applied.push(name);
    }
    return applied;
  });
}
