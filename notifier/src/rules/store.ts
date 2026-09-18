/**
 * The rules engine's SQL (migrations/002_rules.sql): the activity cursor and the last snapshot in
 * notifier.rules_state, one row per watched wallet's holdings in notifier.rules_holdings, and the
 * watch set read from notifier.subscription.
 *
 * Stored JSON is parsed on the way back in. A row that no longer parses (a shape changed between
 * versions) is logged and treated as absent: the engine starts that part afresh, which the storm
 * guard and the dedupe keys make harmless, instead of refusing to run.
 */
import { z } from 'zod';
import type { Db, Queryable } from '../db.js';
import type { Logger } from '../log.js';
import { readPrefs } from '../prefs.js';
import { holdingsSchema, snapshotStateSchema, type Holdings, type PriceAlert, type SnapshotState } from './snapshot.js';

export const cursorSchema = z.object({
  /** Unix seconds: the newest activity `ts` processed. The next poll asks from since − lookback. */
  since: z.number().int().nonnegative(),
  /** Activity ids already processed in the lookback window → their ts. */
  seen: z.record(z.number().int().nonnegative()),
  /** A page budget ran out mid-feed: continue from the indexer's cursor for that `since`. */
  resume: z.object({ since: z.number().int().nonnegative(), cursor: z.string().min(1) }).nullable(),
});
export type Cursor = z.infer<typeof cursorSchema>;

export interface StoredState {
  cursor: Cursor | null;
  snapshot: SnapshotState | null;
  holdings: Record<string, Holdings>;
}

export async function loadState(db: Queryable, logger: Logger): Promise<StoredState> {
  const { rows } = await db.query<{ name: string; value: unknown }>(
    `SELECT name, value FROM notifier.rules_state WHERE name IN ('cursor', 'snapshot')`,
  );
  const byName = new Map(rows.map((r) => [r.name, r.value]));
  const parse = <S extends z.ZodTypeAny>(name: string, schema: S): z.infer<S> | null => {
    if (!byName.has(name)) return null;
    const parsed = schema.safeParse(byName.get(name));
    if (parsed.success) return parsed.data;
    logger.warn({ state: name }, 'rules state unreadable, starting it afresh');
    return null;
  };

  const holdings: Record<string, Holdings> = {};
  let unreadable = 0;
  const { rows: holdingRows } = await db.query<{ address: string; holdings: unknown }>(
    'SELECT address, holdings FROM notifier.rules_holdings',
  );
  for (const row of holdingRows) {
    const parsed = holdingsSchema.safeParse(row.holdings);
    if (parsed.success) holdings[row.address] = parsed.data;
    else unreadable += 1;
  }
  if (unreadable > 0) logger.warn({ unreadable }, 'rules holdings unreadable, refetching them');

  return { cursor: parse('cursor', cursorSchema), snapshot: parse('snapshot', snapshotStateSchema), holdings };
}

/**
 * Write the tick's outcome atomically: cursor, snapshot, the holdings that changed, and the removal
 * of wallets that left the watch set.
 */
export async function saveState(
  db: Db,
  a: { cursor: Cursor; snapshot: SnapshotState; changedHoldings: Record<string, Holdings>; watched: Set<string>; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [name, value] of [
      ['cursor', a.cursor],
      ['snapshot', a.snapshot],
    ] as const) {
      await tx.query(
        `INSERT INTO notifier.rules_state (name, value, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [name, JSON.stringify(value), a.now],
      );
    }
    for (const [address, holdings] of Object.entries(a.changedHoldings)) {
      await tx.query(
        `INSERT INTO notifier.rules_holdings (address, holdings, fetched_at) VALUES ($1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (address) DO UPDATE SET holdings = EXCLUDED.holdings, fetched_at = EXCLUDED.fetched_at`,
        [address, JSON.stringify(holdings), new Date(holdings.fetchedAt * 1000)],
      );
    }
    await tx.query(`DELETE FROM notifier.rules_holdings WHERE NOT (address = ANY($1::text[]))`, [[...a.watched]]);
  });
}

export interface WatchSet {
  /** Checksummed addresses with at least one verified, enabled subscription. */
  addresses: Set<string>;
  /** address → the union of its subscriptions' price alerts. */
  alerts: Record<string, PriceAlert[]>;
}

/** The watch set: every wallet that can receive something, with its price alerts. */
export async function loadWatchSet(db: Queryable): Promise<WatchSet> {
  const { rows } = await db.query<{ address: string; prefs: unknown }>(
    `SELECT address, prefs FROM notifier.subscription
      WHERE verified_at IS NOT NULL AND disabled_at IS NULL
      ORDER BY address, created_at, id`,
  );
  const addresses = new Set<string>();
  const alerts: Record<string, PriceAlert[]> = {};
  const alertKeys = new Map<string, Set<string>>();
  for (const row of rows) {
    addresses.add(row.address);
    const prefs = readPrefs(row.prefs);
    if (prefs === null) continue;
    const list = (alerts[row.address] ??= []);
    const keys = alertKeys.get(row.address) ?? new Set<string>();
    alertKeys.set(row.address, keys);
    for (const alert of prefs.priceAlerts) {
      for (const direction of ['above', 'below'] as const) {
        const threshold = alert[direction];
        if (threshold === undefined) continue;
        const key = `${alert.ticker}\0${direction}\0${threshold}`;
        if (keys.has(key)) continue;
        keys.add(key);
        list.push({ ticker: alert.ticker, direction, threshold });
      }
    }
    if (list.length === 0) delete alerts[row.address];
  }
  return { addresses, alerts };
}
