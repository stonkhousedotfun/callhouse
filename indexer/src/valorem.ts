import { ponder } from "ponder:registry";

import {
  assignedContracts,
  getCycle,
  getState,
  patchCycle,
  patchState,
} from "../lib/indexing";

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
 * They are therefore indexed unfiltered and narrowed here against the option and claim the
 * vault actually wrote. Valorem's entire log history on chain 4663 is a few dozen entries, so
 * the unfiltered read costs nothing.
 *
 * THE 1e18 SCALAR. `Claim.amountWritten` and `Claim.amountExercised` are 1e18-scaled
 * scalars, not contract counts; `write(optionId, amount)` and the `OptionsWritten` /
 * `OptionsExercised` / `BucketAssignedExercise` event arguments are raw uint112 counts.
 * Mixing the two is an 18-order-of-magnitude error, so anything sourced from `claim()` is
 * divided by VALOREM_SCALAR and anything sourced from an event is not.
 */

/** The write landed. Fires inside `clear.write`, before the vault's own `CallsWritten`. */
ponder.on("Clear:OptionsWritten", async ({ event, context }) => {
  const { optionId, claimId, amount } = event.args;

  await patchState(context.db, {
    optionId,
    claimKey: claimId,
    contractsWritten: amount,
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
 * not a number: the authoritative assignment is measured at redeem.
 */
ponder.on("Clear:BucketWrittenInto", async ({ event, context }) => {
  const { claimId, bucketIndex } = event.args;

  const state = await getState(context.db);
  if (state.claimKey === null || state.claimKey !== claimId) return;
  if (state.cycleNumber === 0) return;

  await patchCycle(context.db, state.cycleNumber, { bucketIndex });
});

/**
 * Somebody exercised this option type. MARKET-WIDE, not ours.
 *
 * A buyer exercising says the call is in the money; whether this vault is the writer who gets
 * assigned is a bucket lottery that resolves at redeem. Stored under a name that says so.
 */
ponder.on("Clear:OptionsExercised", async ({ event, context }) => {
  const { optionId, amount } = event.args;

  const state = await getState(context.db);
  if (state.optionId === null || state.optionId !== optionId) return;
  if (state.cycleNumber === 0) return;

  const c = await getCycle(context.db, state.cycleNumber);
  await patchCycle(context.db, state.cycleNumber, {
    marketExercised: c.marketExercised + amount,
  });
});

/** Exercise assigned to a specific bucket. Only interesting when it is the bucket we wrote into. */
ponder.on("Clear:BucketAssignedExercise", async ({ event, context }) => {
  const { optionId, bucketIndex, amountAssigned } = event.args;

  const state = await getState(context.db);
  if (state.optionId === null || state.optionId !== optionId) return;
  if (state.cycleNumber === 0) return;

  const c = await getCycle(context.db, state.cycleNumber);
  if (c.bucketIndex === null || c.bucketIndex !== bucketIndex) return;

  await patchCycle(context.db, state.cycleNumber, {
    bucketAssigned: c.bucketAssigned + amountAssigned,
  });
});

/**
 * Valorem's side of the redemption, filtered to the vault as redeemer.
 *
 * This is the authority on the claim: `underlyingAmountRedeemed` is exactly the collateral
 * that came back and `exerciseAmountRedeemed` is exactly the strike proceeds. The collateral
 * that did NOT come back is the assignment, and dividing it by the lot size gives the
 * contract count — which is why the vault's own `RollClose` argument
 * `contractsAssignedCount` (emitted as a literal 0) is never used.
 *
 * Fires before the vault's `ClaimRedeemed` and before `RollClose`, so the cycle number on
 * vault state is still this cycle's.
 */
ponder.on("Clear:ClaimRedeemed", async ({ event, context }) => {
  const { exerciseAmountRedeemed, underlyingAmountRedeemed } = event.args;

  const state = await getState(context.db);
  if (state.cycleNumber === 0) return;

  const c = await getCycle(context.db, state.cycleNumber);
  const collateral = c.collateral !== 0n ? c.collateral : state.lockedCollateral;

  await patchCycle(context.db, state.cycleNumber, {
    assetsReturned: underlyingAmountRedeemed,
    assignmentUsdg: exerciseAmountRedeemed,
    contractsAssigned: assignedContracts(
      collateral,
      underlyingAmountRedeemed,
      c.lotSize,
    ),
  });
});
