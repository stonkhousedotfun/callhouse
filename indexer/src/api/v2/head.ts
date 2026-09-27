import { HTTPException } from "hono/http-exception";
import { db } from "ponder:api";
import { sql } from "ponder";

/** Ponder's checkpoint is fixed width: timestamp 10, chain 16, block 16 decimal digits. */
export type IndexedHead = { block: bigint; ts: bigint; checkpoint: string };

/**
 * The indexed head, or null when the checkpoint table holds no readable checkpoint yet.
 *
 * A query that FAILED is not "no checkpoint". Null makes every caller measure at time zero:
 * windowed figures of "0", the last indexed fee served as current, all-time totals served as 7-day
 * ones. That is the designed answer for an index that has not started, and a made-up one for a
 * database that did not answer, so a failed read refuses the request with a 503 instead. /v2/health
 * catches it and reports "degraded", exactly as it does for a missing checkpoint.
 */
export async function indexedHead(): Promise<IndexedHead | null> {
  let result: unknown;
  try {
    result = await (db as unknown as { execute: (query: unknown) => Promise<unknown> })
      .execute(sql`select latest_checkpoint from _ponder_checkpoint`);
  } catch (cause) {
    throw new HTTPException(503, { cause, res: Response.json({ error: {
      code: "head_unavailable", message: "The indexer could not read its sync position. Please retry.",
    } }, { status: 503, headers: { "cache-control": "no-store" } }) });
  }
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  let best: IndexedHead | null = null;
  for (const row of rows) {
    const cp = (row as { latest_checkpoint?: unknown }).latest_checkpoint;
    if (typeof cp !== "string" || !/^\d{42}/.test(cp)) continue;
    const candidate = { ts: BigInt(cp.slice(0, 10)), block: BigInt(cp.slice(26, 42)), checkpoint: cp };
    if (best === null || candidate.block > best.block) best = candidate;
  }
  return best;
}

/**
 * The instant every trailing window on a route (24h volume, 7d premium, today's and
 * this week's biggest win) ends at: the INDEXED head's block time, never the host clock. The data only
 * reaches the Ponder checkpoint, so a host-clock window silently shrinks toward zero while the indexer
 * lags, and a quiet day cannot be told from a stalled index.
 *
 * Null when the checkpoint is missing: then no window is measured and the windowed figures are zero
 * rather than invented. /stats, /markets and the market-series page all anchor through this one helper
 * so they report one 24h volume.
 *
 * NOT YET ON THE WIRE. Puts it in the JSON contract; a header was rejected because the response
 * cache replays body and status only, so a header asOf would vanish on every cache HIT.
 */
export function windowAsOf(head: IndexedHead | null): bigint | null {
  return head?.ts ?? null;
}
