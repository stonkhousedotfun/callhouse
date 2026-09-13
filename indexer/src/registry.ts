import { ponder } from "ponder:registry";
import schema from "ponder:schema";

import { getCycle, patchState } from "../lib/indexing";
import { log } from "../lib/log";

/**
 * Overcall's per-market registry — the clock this whole product runs on.
 *
 * `CycleSet` is what makes a week exist. It is deliberately the FIRST thing that writes a
 * cycle row, before the vault has decided anything, so the tape contains every week Overcall
 * opened — including the ones this vault sat out. A week the vault skipped stays at status
 * `idle` with zeros; a week the vault wrote and nobody bought ends at `unfilled` with zeros.
 * Neither is ever a missing row.
 *
 * The cycle struct has NO status field. The registry's gates are `isWritingOpen()` (cycle set
 * and `now < writeDeadline()`) and `isCycleLive()` (`now < expiryTimestamp`), and
 * `writeDeadline() == exerciseTimestamp`. Everything here is bound to those timestamps and to
 * the cycle number, never to the wall clock.
 */
ponder.on("Registry:CycleSet", async ({ event, context }) => {
  const { number, optionIds, exerciseAt, expireAt, lotSize } = event.args;

  const cycleNumber = number;
  const c = await getCycle(context.db, cycleNumber);

  await context.db.update(schema.cycle, { cycleNumber }).set({
    // uint256 option ids do not survive JSON as numbers, so they are stored as decimal
    // strings — the same representation Overcall's API uses on the wire.
    optionIds: optionIds.map((id) => id.toString()),
    strikeCount: optionIds.length,
    lotSize,
    exerciseTimestamp: BigInt(exerciseAt),
    expiryTimestamp: BigInt(expireAt),
    setAt: event.block.timestamp,
    setBlock: event.block.number,
    setTx: event.transaction.hash,
    // Re-announcing a cycle must not reset a week we already wrote into and closed.
    status: c.status,
  });

  await patchState(context.db, {
    registryLotSize: lotSize,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  // The starting gun for the week: the keeper writes into this cycle, or deliberately sits it
  // out. Either way the row now exists, and Friday's tape will say which.
  log.info(
    {
      cycleNumber,
      strikes: optionIds.length,
      exerciseAt,
      expireAt,
      txHash: event.transaction.hash,
    },
    "registry announced a cycle",
  );
});

/**
 * The registry's lot size changed. One lot is one whole Stock Token at launch (1e18), and the
 * vault refuses to write an option whose `underlyingAmount` differs from it, so a change here
 * is a governance event worth surfacing rather than a routine one.
 */
ponder.on("Registry:LotSizeSet", async ({ event, context }) => {
  await patchState(context.db, {
    registryLotSize: event.args.newLotSize,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  log.warn(
    { previous: event.args.previousLotSize, next: event.args.newLotSize, txHash: event.transaction.hash },
    "registry lot size changed",
  );
});
