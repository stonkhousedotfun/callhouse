import { ponder } from "ponder:registry";

import { getCycle, getState, patchCycle, patchState } from "../lib/indexing";
import { log } from "../lib/log";

/*//////////////////////////////////////////////////////////////
                   VALOREM CLEARINGHOUSE
//////////////////////////////////////////////////////////////*/

/**
 * Valorem events, and how each one is narrowed to this vault.
 *
 * `OptionsWritten` and `ClaimRedeemed` carry the vault in an indexed position (`writer`,
 * `redeemer`), so ponder.config.ts filters them at the node and nothing unrelated arrives.
 *
 * `OptionsExercised`, `BucketWrittenInto` and `BucketAssignedExercise` carry no address for
 * us — only an option id or a claim id, neither of which is known when the config is built.
 * They are therefore indexed unfiltered and narrowed here against the option the vault armed
 * and the claim its fills wrote. Valorem's entire log history on chain 4663 is a few dozen
 * entries, so the unfiltered read costs nothing.
 *
 * UNDER WRITE ON FILL every one of these fires inside a Seaport fill transaction, after
 * `RollOpen` has already created the week: `clear.write` runs inside the vault's
 * `authorizeOrder` hook and emits `OptionsWritten` then `BucketWrittenInto`, and the vault's
 * own `CallsWritten` follows. So `vaultState.cycleNumber` already names the right week here,
 * and the bucket can be stamped straight onto the cycle row (the pre-redesign index had to
 * hold it on vault state because the write preceded `RollOpen`).
 *
 * THE 1e18 SCALAR. `Claim.amountWritten` and `Claim.amountExercised` are 1e18-scaled
 * scalars, not contract counts; `write(optionId, amount)` and the `OptionsWritten` /
 * `OptionsExercised` / `BucketAssignedExercise` event arguments are raw uint112 counts.
 * Mixing the two is an 18-order-of-magnitude error, so anything sourced from `claim()` is
 * divided by VALOREM_SCALAR and anything sourced from an event is not.
 */

/**
 * One fill's write landed in Valorem. Fires inside `clear.write`, before the vault's own
 * `CallsWritten` in the same transaction, which is where the running totals are kept (the
 * vault's figure is the one the tape publishes; this is Valorem agreeing). The claim key is
 * stamped here so `BucketWrittenInto`, one log later, can recognise our claim.
 */
ponder.on("Clear:OptionsWritten", async ({ event, context }) => {
  const { optionId, claimId } = event.args;

  await patchState(context.db, {
    optionId,
    claimKey: claimId,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/**
 * Which Valorem bucket our claim went into.
 *
 * Valorem assigns exercise per bucket rather than pro-rata across the whole market, so the
 * bucket a claim sits in is the only thing that decides whether it is assigned. Recording it
 * lets `BucketAssignedExercise` be read as an early warning during the week. It is a warning,
 * not a number: the authoritative assignment is measured at the close.
 *
 * Every fill of a cycle emits this again for the same claim. Upstream Clear (6436c823) opens a
 * new bucket for an option type only once its current bucket has been exercised, exercise
 * cannot happen before the exercise timestamp, and no fill can happen at or after it, so every
 * fill of a week lands in the bucket its first fill wrote into. The first bucket is kept; a
 * disagreement is logged rather than silently re-pointing the week.
 */
ponder.on("Clear:BucketWrittenInto", async ({ event, context }) => {
  const { claimId, bucketIndex } = event.args;

  const state = await getState(context.db);
  if (state.claimKey === null || state.claimKey !== claimId) return;
  if (state.cycleNumber === 0) return;

  const c = await getCycle(context.db, state.cycleNumber);
  if (c.bucketIndex === null) {
    await patchCycle(context.db, state.cycleNumber, { bucketIndex: BigInt(bucketIndex) });
  } else if (c.bucketIndex !== BigInt(bucketIndex)) {
    log.warn(
      { cycleNumber: state.cycleNumber, claimId, bucketIndex, cycleBucket: c.bucketIndex, txHash: event.transaction.hash },
      "fill written into a second Valorem bucket; bucketAssigned tracks the first only",
    );
  }
});

/**
 * Somebody exercised this option type. MARKET-WIDE, not ours.
 *
 * A buyer exercising says the call is in the money; whether this vault is the writer who gets
 * assigned is a bucket lottery that resolves at the close. Stored under a name that says so.
 */
ponder.on("Clear:OptionsExercised", async ({ event, context }) => {
  const { optionId, amount } = event.args;

  const state = await getState(context.db);
  if (state.optionId === null || state.optionId !== optionId) return;
  if (state.cycleNumber === 0) return;

  const c = await getCycle(context.db, state.cycleNumber);
  await patchCycle(context.db, state.cycleNumber, {
    marketExercised: c.marketExercised + BigInt(amount),
  });
});

/** Exercise assigned to a specific bucket. Only interesting when it is the bucket we wrote into. */
ponder.on("Clear:BucketAssignedExercise", async ({ event, context }) => {
  const { optionId, bucketIndex, amountAssigned } = event.args;

  const state = await getState(context.db);
  if (state.optionId === null || state.optionId !== optionId) return;
  if (state.cycleNumber === 0) return;

  const c = await getCycle(context.db, state.cycleNumber);
  if (c.bucketIndex === null || c.bucketIndex !== BigInt(bucketIndex)) return;

  await patchCycle(context.db, state.cycleNumber, {
    bucketAssigned: c.bucketAssigned + BigInt(amountAssigned),
  });
});

/**
 * Valorem's side of the redemption, filtered to the vault as redeemer.
 *
 * `underlyingAmountRedeemed` is exactly the collateral that came back and
 * `exerciseAmountRedeemed` is exactly the strike proceeds. It fires before the vault's own
 * `ClaimRedeemed` and before `RollClose` (or `StrandedClaimRecovered`), which then write the
 * same figures from the vault's balance deltas; this is the cross-check, stamped first so a
 * disagreement would show as the later handler overwriting it. The contract count is NOT
 * derived from it any more: `RollClose.contractsAssignedCount` is read from Valorem before the
 * redeem and is authoritative on every close, stranded or not.
 */
ponder.on("Clear:ClaimRedeemed", async ({ event, context }) => {
  const { exerciseAmountRedeemed, underlyingAmountRedeemed } = event.args;

  const state = await getState(context.db);
  const cycleNumber = state.stranded ? state.strandedCycleNumber : state.cycleNumber;
  if (cycleNumber === null || cycleNumber === 0) return;

  await patchCycle(context.db, cycleNumber, {
    assetsReturned: underlyingAmountRedeemed,
    assignmentUsdg: exerciseAmountRedeemed,
  });
});
