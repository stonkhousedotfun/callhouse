import schema from "ponder:schema";

import type { DB } from "../../lib/indexing";

/**
 * THE PNL CLOCK SKIPS A TICK ONLY WHEN IT WOULD HAVE CHANGED NOTHING.
 *
 * `V2PnlClock:block` (src/v2/pnl.ts) runs every 30 blocks. Each tick used to issue thirteen `db.sql` selects even
 * on a chain with no trading, and each `db.sql` select flushes Ponder's cache and runs its own transaction.
 * measured it at 96 % of a redeploy's replay time, which is what makes a
 * redeploy outgrow Railway's health check after a day or two of chain.
 *
 * A tick reads: the six range tables (v2Transfer, v2Fill, v2Take, v2Mint, v2Close, v2Redemption), v2CashFlow in
 * range, every v2Account's operators/approvals/delegates, and every v2Series' expiry. It changes stored state only
 * when (a) one of those was written since its last full tick, or (b) an open self-trade lot's series expired
 * (`reduceSelfTrade` ends with `expire(throughTimestamp)`). So every write to one of those tables outside the clock
 * calls `markPnlInput` beside it (pnlInput.test.ts fails a write without one), and the clock records the earliest
 * open-lot expiry after each full tick. A tick whose cursor is past the last mark and whose timestamp is before that
 * expiry is exactly the tick that would have read empty ranges and written nothing: it advances the cursor only.
 *
 * The mark is a row, not a module variable, so a reorg rewinds it together with the rows it describes and a crash
 * recovery reads it back from the database.
 */
export const PNL_INPUT_ID = "global";

/** Record that a table the PnL clock reads was written at `block`. Blocks are indexed in order. find, then insert or
 * update: the plainest store calls, all served from Ponder's cache, and a repeat mark in one block writes nothing. */
export async function markPnlInput(db: DB, block: bigint): Promise<void> {
  const current = await db.find(schema.v2PnlInput, { id: PNL_INPUT_ID });
  if (current === null) await db.insert(schema.v2PnlInput).values({ id: PNL_INPUT_ID, block });
  else if (current.block !== block) await db.update(schema.v2PnlInput, { id: PNL_INPUT_ID }).set({ block });
}

/** The clock's own record after a full tick. `block` -1 on first insert: nothing has been marked yet. */
export async function recordNextLotExpiry(db: DB, nextLotExpiry: bigint | null): Promise<void> {
  await db.insert(schema.v2PnlInput).values({ id: PNL_INPUT_ID, block: -1n, nextLotExpiry })
    .onConflictDoUpdate({ nextLotExpiry });
}

/**
 * True when the tick over (from, through] would read empty ranges and write nothing but the cursor.
 *
 * `markedBlock < from`, strictly: a write at block `from` itself may have come after the tick at `from` (another
 * block source at the same block, such as V2Clock), so it forces one more full tick. `timestamp < nextLotExpiry`
 * mirrors `expire`'s `at >= expiry` in lib/v2/selfTrade.ts. No input row, or no cursor yet, is never a skip.
 */
export function pnlTickIsNoop(input: { block: bigint; nextLotExpiry: bigint | null } | null,
  cursor: bigint | null, from: bigint, timestamp: bigint): boolean {
  if (input === null || cursor === null) return false;
  if (input.block >= from) return false;
  return input.nextLotExpiry === null || timestamp < input.nextLotExpiry;
}

/** The earliest expiry among lots still open, or null when none is open or none has a known series. */
export function nextOpenLotExpiry(lots: readonly { longId: bigint; remaining: bigint }[],
  expiries: readonly { longId: bigint; expiry: bigint }[]): bigint | null {
  const byLong = new Map(expiries.map((row) => [row.longId, row.expiry]));
  let next: bigint | null = null;
  for (const lot of lots) {
    if (lot.remaining === 0n) continue;
    const expiry = byLong.get(lot.longId);
    if (expiry !== undefined && (next === null || expiry < next)) next = expiry;
  }
  return next;
}
