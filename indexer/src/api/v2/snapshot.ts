import { HTTPException } from "hono/http-exception";
import { indexedHead, type IndexedHead } from "./machine";

/**
 * Ponder publishes normal projection writes and the full checkpoint in one transaction.
 * Read-only API queries are separate transactions: retry if indexing committed between
 * them. Compare the whole checkpoint, including its event position, not just block/time.
 * Keep network calls outside `read` so a slow oracle cannot exhaust these retries.
 *
 * This does not establish chain finality. Ponder 0.17's reorg rollback temporarily leaves
 * its checkpoint unchanged until replacement blocks are indexed; execution still needs
 * the contract preflight. Missing checkpoints retain the existing conservative time-zero
 * behavior and are reported unhealthy by /health.
 */
export async function readIndexedSnapshot<T>(read: (head: IndexedHead | null) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await indexedHead();
    const value = await read(before);
    const after = await indexedHead();
    if (before?.checkpoint === after?.checkpoint) return value;
  }
  throw new HTTPException(503, { res: Response.json({ error: {
    code: "snapshot_changing", message: "Indexer state changed during the quote. Please retry.",
  } }, { status: 503, headers: { "cache-control": "no-store" } }) });
}
