import { ponder } from "ponder:registry";
import schema from "ponder:schema";

import { BPS, OVERCALL_FEE_BPS } from "../lib/env";
import { addHarvest, splitHarvest } from "../lib/harvest";
import { log } from "../lib/log";
import { roleName } from "../lib/roles";
import {
  PHASE,
  assignedContracts,
  eventId,
  getCycle,
  getEpoch,
  getState,
  getUser,
  isAccountable,
  patchCycle,
  patchEpoch,
  patchState,
  safeDiv,
  snapshot,
  sub,
  ZERO_ADDRESS,
} from "../lib/indexing";

/*//////////////////////////////////////////////////////////////
                       SHARES (ERC-20)
//////////////////////////////////////////////////////////////*/

/**
 * Share movements.
 *
 * Three kinds of transfer matter and they are told apart by the counterparty:
 *   from == 0        mint on deposit           → supply up,  holder up
 *   to   == 0        burn on redeem or settle  → supply down, holder down
 *   to   == vault    escrow into the queue     → holder down, supply unchanged
 *
 * `user.shares` therefore mirrors `balanceOf` exactly: escrowed shares leave the holder's
 * balance and reappear as `user.queuedShares`, which mirrors `Vault.queuedSharesOf`.
 * The vault's own balance is never given a user row — it is escrow, not a position.
 */
ponder.on("Vault:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  if (value === 0n) return;

  const state = await getState(context.db);
  let totalShares = state.totalShares;

  if (from === ZERO_ADDRESS) totalShares += value;
  if (to === ZERO_ADDRESS) totalShares = sub(totalShares, value);
  if (totalShares !== state.totalShares) {
    await patchState(context.db, { totalShares });
  }

  if (isAccountable(from)) {
    const u = await getUser(context.db, from, event);
    await context.db
      .update(schema.user, { address: from })
      .set({ shares: sub(u.shares, value) });
  }

  if (isAccountable(to)) {
    const u = await getUser(context.db, to, event);
    await context.db
      .update(schema.user, { address: to })
      .set({ shares: u.shares + value });
  }
});

/*//////////////////////////////////////////////////////////////
                        DEPOSIT / WITHDRAW
//////////////////////////////////////////////////////////////*/

/**
 * `Deposit` fires after the asset transfer and after the mint, so by the time this runs the
 * asset balance and the share supply are already reduced onto `vaultState`. The handler only
 * has to attribute the flow to the receiver and stamp a snapshot.
 */
ponder.on("Vault:Deposit", async ({ event, context }) => {
  const { owner, assets } = event.args;

  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({
    depositedAssets: u.depositedAssets + assets,
    depositCount: u.depositCount + 1,
  });

  await snapshot(context.db, event, "Deposit");
});

/** Instant redeem / withdraw. Only reachable while the vault is flat; otherwise `UseQueue()`. */
ponder.on("Vault:Withdraw", async ({ event, context }) => {
  const { owner, assets } = event.args;

  const u = await getUser(context.db, owner, event);
  await context.db
    .update(schema.user, { address: owner })
    .set({ withdrawnAssets: u.withdrawnAssets + assets });

  await snapshot(context.db, event, "Withdraw");
});

/*//////////////////////////////////////////////////////////////
                          REDEEM QUEUE
//////////////////////////////////////////////////////////////*/

ponder.on("Vault:QueueRedeem", async ({ event, context }) => {
  const { owner, shares, epochId } = event.args;

  const state = await getState(context.db);
  await patchState(context.db, {
    queuedShares: state.queuedShares + shares,
    epochId,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  const ep = await getEpoch(context.db, epochId, event);
  await patchEpoch(context.db, epochId, {
    sharesQueued: ep.sharesQueued + shares,
    queueCount: ep.queueCount + 1,
    openedAt: ep.openedAt ?? event.block.timestamp,
  });

  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({
    queuedShares: u.queuedShares + shares,
    queuedEpoch: epochId,
  });

  await snapshot(context.db, event, "QueueRedeem");
});

/**
 * Settlement: escrowed shares are burnt and a slice of idle assets plus the USDG the escrow
 * itself accrued is set aside for the epoch. Both amounts leave NAV immediately, which is why
 * `reservedAssets` and `usdgReservedForQueue` go up here and come down as people claim.
 */
ponder.on("Vault:QueueSettled", async ({ event, context }) => {
  const { epochId, shares, assets, usdgOut } = event.args;

  const state = await getState(context.db);
  await patchState(context.db, {
    queuedShares: sub(state.queuedShares, shares),
    reservedAssets: state.reservedAssets + assets,
    usdgReservedForQueue: state.usdgReservedForQueue + usdgOut,
    // The vault bumps its epoch counter immediately after emitting this.
    epochId: epochId + 1n,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await patchEpoch(context.db, epochId, {
    status: "settled",
    cycleNumber: state.cycleNumber,
    sharesSettled: shares,
    assetsSettled: assets,
    usdgSettled: usdgOut,
    settledAt: event.block.timestamp,
    settledTx: event.transaction.hash,
  });

  // Open the next epoch so a queue joined before the next settlement has somewhere to land.
  await getEpoch(context.db, epochId + 1n, event);

  log.info({ epochId, shares, assets, usdgOut }, "redeem queue settled");

  await snapshot(context.db, event, "QueueSettled");
});

/**
 * A queue entry left its epoch and became an owed balance.
 *
 * This fires from BOTH of the contract's settle paths: inside `completeRedeem` immediately
 * before the payout, and inside `queueRedeem` when joining the queue auto-settles a stale
 * slot. The second path is the one that cannot be inferred any other way — it changes who the
 * epoch still owes with no `CompleteRedeem` in sight, and before this event existed the epoch
 * row could only drift towards a false "unclaimed" total.
 *
 * The epoch is drawn down HERE, not at payout: on chain `assetsRemaining` falls at settle, so
 * `*Claimed` converging on `*Settled` reads as "no longer the epoch's problem". The vault's
 * `reservedAssets` is NOT touched — the money leaves the reserves only when it actually leaves
 * the vault, at `CompleteRedeem`.
 */
ponder.on("Vault:QueueEntrySettled", async ({ event, context }) => {
  const { owner, epochId, shares, assets, usdgOut } = event.args;

  // On chain the slot is zeroed, not decremented — the entry is gone. If the same transaction
  // re-queues, the `QueueRedeem` handler runs after this and starts the slot fresh.
  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({
    queuedShares: 0n,
    queuedEpoch: null,
  });

  const ep = await getEpoch(context.db, epochId, event);
  await patchEpoch(context.db, epochId, {
    sharesClaimed: ep.sharesClaimed + shares,
    assetsClaimed: ep.assetsClaimed + assets,
    usdgClaimed: ep.usdgClaimed + usdgOut,
    claimCount: ep.claimCount + 1,
  });

  await snapshot(context.db, event, "QueueEntrySettled");
});

/**
 * Owed balances actually left the vault.
 *
 * The epoch drawdown is NOT here: it happened at `QueueEntrySettled`, which fires first in
 * the same transaction — or fired transactions earlier, when a later `queueRedeem`
 * auto-settled the slot. What remains is the payout itself: the lifetime redeemed totals, and
 * the reserves, which only ever come down here.
 */
ponder.on("Vault:CompleteRedeem", async ({ event, context }) => {
  const { owner, assets, usdgOut } = event.args;

  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({
    redeemedAssets: u.redeemedAssets + assets,
    redeemedUsdg: u.redeemedUsdg + usdgOut,
  });

  const state = await getState(context.db);
  await patchState(context.db, {
    reservedAssets: sub(state.reservedAssets, assets),
    usdgReservedForQueue: sub(state.usdgReservedForQueue, usdgOut),
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await snapshot(context.db, event, "CompleteRedeem");
});

/*//////////////////////////////////////////////////////////////
                         PHASE MACHINE
//////////////////////////////////////////////////////////////*/

/**
 * `CallsWritten` is emitted from inside `_writeCalls`, i.e. BEFORE `RollOpen`, at a point
 * where `vaultState.cycleNumber` still holds the previous cycle. So it must not write to a
 * cycle row — it only stamps the claim onto vault state, and `RollOpen` (which carries the
 * cycle number) copies it across a few logs later.
 */
ponder.on("Vault:CallsWritten", async ({ event, context }) => {
  const { optionId, claimKey, contractsCount, collateral } = event.args;

  await patchState(context.db, {
    optionId,
    claimKey,
    contractsWritten: contractsCount,
    contractsSold: 0n,
    lockedCollateral: collateral,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Vault:RollOpen", async ({ event, context }) => {
  const { cycleNumber, optionId, contractsCount, strikeUsdg } = event.args;

  const state = await getState(context.db);

  // The week's two deadlines come from the registry (CycleSet), never from the wall clock:
  // `exerciseTimestamp` IS `registry.writeDeadline()` (book close) and `expiryTimestamp` is
  // when the option dies. Copy them onto vault state at the roll so "this week closes at X"
  // is answerable from the index alone, with no RPC read.
  const c = await getCycle(context.db, cycleNumber);

  await patchState(context.db, {
    phase: PHASE.Listed,
    cycleNumber,
    optionId,
    strikeUsdg,
    exerciseTimestamp: c.exerciseTimestamp ?? 0n,
    expiryTimestamp: c.expiryTimestamp ?? 0n,
    contractsWritten: contractsCount,
    contractsSold: 0n,
    listingHash: null,
    listingsThisCycle: 0,
    cyclesWritten: state.cyclesWritten + 1,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await patchCycle(context.db, cycleNumber, {
    status: "listed",
    wrote: true,
    optionId,
    claimKey: state.claimKey,
    strikeUsdg,
    contractsWritten: contractsCount,
    // `CallsWritten` ran first in this same transaction, so the collateral is already known.
    collateral: state.lockedCollateral,
    openedAt: event.block.timestamp,
    openedBlock: event.block.number,
    txOpen: event.transaction.hash,
    // A cycle the registry never announced to us still needs a lot size for the assignment
    // maths at close; fall back to what the write implies.
    lotSize: c.lotSize ?? safeDiv(state.lockedCollateral, contractsCount),
  });

  log.info(
    { cycleNumber, optionId, contractsCount, strikeUsdg, txHash: event.transaction.hash },
    "cycle opened: calls written",
  );

  await snapshot(context.db, event, "RollOpen", {
    client: context.client,
    refreshMultiplier: true,
  });
});

/** The book closes at the registry's exercise timestamp. Permissionless, so anyone may call it. */
ponder.on("Vault:BookLocked", async ({ event, context }) => {
  const { cycleNumber } = event.args;

  await patchState(context.db, {
    phase: PHASE.Exercisable,
    listingHash: null,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await patchCycle(context.db, cycleNumber, { lockedAt: event.block.timestamp });

  await snapshot(context.db, event, "BookLocked");
});

/**
 * The claim has been redeemed and the balance deltas are known.
 *
 * `contractsAssignedCount` is read by the vault from `contractsAssigned()` — i.e. Valorem's
 * `claim().amountExercised`, divided back down by the 1e18 scalar — BEFORE `_redeemClaim`
 * zeroes the claim key, so it is the authoritative count and it is used. (An earlier build of
 * the vault emitted a hardcoded 0 here; the fallback below covers that, and it is also what
 * answers if the cycle's collateral is known but the event's count is not.)
 *
 * The fallback derives the same number from the collateral that did NOT come back:
 * (collateral − underlyingReturned) / lotSize. The two agree by construction.
 *
 * This handler also stamps `rollCloseTx`, which is how the `Harvest` handler tells the week's
 * terminal harvest apart from a mid-week `_checkpointHarvest()` fired by a deposit.
 */
ponder.on("Vault:RollClose", async ({ event, context }) => {
  const { cycleNumber, assetsReturned, usdgFromAssignment, contractsAssignedCount } =
    event.args;

  const state = await getState(context.db);
  const c = await getCycle(context.db, cycleNumber);

  const collateral = c.collateral !== 0n ? c.collateral : state.lockedCollateral;
  const derived = assignedContracts(collateral, assetsReturned, c.lotSize);
  const assigned = contractsAssignedCount > 0n ? contractsAssignedCount : derived;

  await patchCycle(context.db, cycleNumber, {
    assetsReturned,
    assignmentUsdg: usdgFromAssignment,
    contractsAssigned: assigned,
    closedAt: event.block.timestamp,
    closedBlock: event.block.number,
    txClose: event.transaction.hash,
  });

  await patchState(context.db, {
    phase: PHASE.Settling,
    lockedCollateral: 0n,
    lifetimeAssignmentUsdg: state.lifetimeAssignmentUsdg + usdgFromAssignment,
    // Read by the Harvest handler, one or two logs later in this same transaction.
    rollCloseTx: event.transaction.hash,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  // The week's summary line — the same numbers the weekly publish is built from.
  log.info(
    {
      cycleNumber,
      assetsReturned,
      usdgFromAssignment,
      contractsAssigned: assigned,
      txHash: event.transaction.hash,
    },
    "cycle closed: claim redeemed",
  );

  await snapshot(context.db, event, "RollClose", {
    client: context.client,
    refreshMultiplier: true,
  });
});

/**
 * The vault's own view of the Valorem redemption. Fires inside `rollClose`, just before
 * `RollClose`, and is where the cycle's position is torn down. `Clear:ClaimRedeemed` carries
 * the same numbers from Valorem's side and is used as the cross-check.
 */
ponder.on("Vault:ClaimRedeemed", async ({ event, context }) => {
  await patchState(context.db, {
    claimKey: null,
    optionId: null,
    contractsWritten: 0n,
    contractsSold: 0n,
    lockedCollateral: 0n,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/*//////////////////////////////////////////////////////////////
                            LISTINGS
//////////////////////////////////////////////////////////////*/

/**
 * A listing the vault authorised on chain.
 *
 * `grossUsdg` is the sum of both consideration items, and the contract has already proved it
 * divides evenly by `amount`, so the unit price is exact. The 95/5 split is recomputed here
 * the same way `Policy.splitPremium` does it — floor the fee PER CONTRACT, then multiply.
 * Rounding the fee on the total instead yields an order that signs and validates and is then
 * refused by Seaport on a partial fill (InexactFraction); since every Overcall order is
 * PARTIAL_OPEN, that quietly turns the listing into full-fill-only.
 */
ponder.on("Vault:ListingApproved", async ({ event, context }) => {
  const { orderHash, optionId, amount, grossUsdg, seq } = event.args;

  const unitPrice = safeDiv(grossUsdg, amount);
  const feePerContract = (unitPrice * OVERCALL_FEE_BPS) / BPS;
  const writerPerContract = unitPrice - feePerContract;

  const state = await getState(context.db);

  await context.db
    .insert(schema.listing)
    .values({
      orderHash,
      cycleNumber: state.cycleNumber,
      seq,
      optionId,
      amount,
      grossUsdg,
      unitPriceUsdg: unitPrice,
      writerUsdg: writerPerContract * amount,
      overcallFeeUsdg: feePerContract * amount,
      status: "approved",
      approvedAt: event.block.timestamp,
      approvedBlock: event.block.number,
      approvedTx: event.transaction.hash,
    })
    // Re-approving an identical hash is impossible on chain (the vault refuses a second live
    // listing), but a reorg replay must not duplicate the row.
    .onConflictDoNothing();

  await patchState(context.db, {
    listingHash: orderHash,
    listingsThisCycle: seq,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await patchCycle(context.db, state.cycleNumber, {
    listingCount: seq,
    orderHash,
    listedGrossUsdg: grossUsdg,
    listedUnitPriceUsdg: unitPrice,
    listedContracts: amount,
    listedAt: event.block.timestamp,
  });
});

/**
 * The live listing stopped being live. Emitted both by an explicit `cancelListing` and by
 * `invalidateAllListings`; the latter follows up with `AllListingsInvalidated`, which refines
 * the end reason. A listing that already filled is left alone — a fill is the better story.
 */
ponder.on("Vault:ListingCancelled", async ({ event, context }) => {
  const { orderHash } = event.args;

  const l = await context.db.find(schema.listing, { orderHash });
  if (l !== null && l.status !== "filled") {
    await context.db.update(schema.listing, { orderHash }).set({
      status: l.contractsFilled > 0n ? "partially_filled" : "cancelled",
      endedAt: event.block.timestamp,
      endedTx: event.transaction.hash,
      endReason: "cancelled",
    });
  }

  await patchState(context.db, {
    listingHash: null,
    lastCancelledHash: orderHash,
    lastCancelledTx: event.transaction.hash,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/**
 * The guardian's blunt instrument: bumping the Seaport counter kills every outstanding order
 * from this offerer without needing the order data. `lockBook` and `rollClose` also use it.
 */
ponder.on("Vault:AllListingsInvalidated", async ({ event, context }) => {
  const { newCounter } = event.args;

  const state = await getState(context.db);

  // `_invalidateAllListings` emitted ListingCancelled one log earlier in this same tx; that
  // handler recorded which hash it was, so the end reason can be upgraded without a scan.
  if (
    state.lastCancelledHash !== null &&
    state.lastCancelledTx === event.transaction.hash
  ) {
    const l = await context.db.find(schema.listing, {
      orderHash: state.lastCancelledHash,
    });
    if (l !== null && l.status !== "filled") {
      await context.db
        .update(schema.listing, { orderHash: state.lastCancelledHash })
        .set({ endReason: "invalidated" });
    }
  }

  await patchState(context.db, {
    listingHash: null,
    seaportCounter: newCounter,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/*//////////////////////////////////////////////////////////////
                            HARVEST
//////////////////////////////////////////////////////////////*/

/**
 * The week's money, and — for the terminal one — the week's verdict.
 *
 * *** `Harvest` IS EMITTED FROM TWO PLACES AND THEY MEAN DIFFERENT THINGS. ***
 *
 *   `_harvest()`            runs inside `rollClose`. Always emits, even with a gross of zero,
 *                           which is exactly how an unfilled week gets its honest row. This
 *                           is the TERMINAL harvest: it closes the week and returns the vault
 *                           to Idle.
 *   `_checkpointHarvest()`  runs inside `deposit` and `mint`, and emits whenever premium has
 *                           already landed (gross != 0). It exists so a depositor arriving on
 *                           Thursday cannot mint into premium earned on Tuesday. It fires
 *                           MID-CYCLE, carries the SAME cycle number, and is not a result.
 *
 * Nothing in the event itself separates them. What does: `rollClose` emits `RollClose`
 * immediately before `_harvest()`, so the terminal harvest is the one whose transaction hash
 * matches `vaultState.rollCloseTx`. Treating a checkpoint as terminal would flip `phase` to
 * Idle while the vault is still Listed, publish a half-week as the week's result, and add a
 * phantom week to every lifetime tally on every deposit.
 *
 * Both kinds move real money, so both accumulate onto the cycle and both get a row. Only the
 * terminal one decides the status:
 *   assigned  contracts were taken at the strike
 *   closed    filled, expired out of the money — premium and tokens both kept
 *   unfilled  nothing sold. THE MOST LIKELY OUTCOME, published as "unfilled, 0".
 *
 * The three amounts are taken from the event verbatim; nothing here recomputes the fee. That
 * matters on an assigned week: `grossUsdg` includes the strike proceeds, but the vault charges
 * `feeUsdg` on `grossUsdg − RollClose.usdgFromAssignment` only (Vault._accrueHarvest; a deposit
 * checkpoint excludes 0), so `feeUsdg / grossUsdg` is NOT the policy rate there and must never
 * be used as one. `netUsdg == grossUsdg − feeUsdg` always.
 *
 * And for the same reason `netUsdg` is NOT premium on an assigned week (W-21): the strike
 * proceeds in it are returned principal. `lib/harvest.ts` splits every event into premium and
 * strike proceeds, and every "premium" column here is premium only. The whole credited figure
 * is kept under its own name (`creditedUsdg`, `usdgPerShare`) so nothing has to be inferred.
 */
ponder.on("Vault:Harvest", async ({ event, context }) => {
  const { cycleNumber, grossUsdg, feeUsdg, netUsdg } = event.args;

  // Terminal iff `RollClose` was emitted earlier in THIS transaction and the phase it set is
  // still Settling. The phase conjunction makes a second Harvest in the same transaction —
  // a `rollClose` and a `deposit` batched through a multicall, say — fall through to the
  // checkpoint branch, because the first terminal harvest already returned the vault to Idle.
  const state = await getState(context.db);
  const terminal =
    state.rollCloseTx === event.transaction.hash && state.phase === PHASE.Settling;

  const c = await getCycle(context.db, cycleNumber);

  const filled = c.contractsSold > 0n;
  const status = c.contractsAssigned > 0n ? "assigned" : filled ? "closed" : "unfilled";

  // Supply at harvest is the pre-burn, pre-mint supply. For the terminal harvest that is
  // deliberate — `_settleQueue` runs after `_harvest`, so shares still escrowed for the queue
  // earn the week they sat through. For a checkpoint harvest it is equally deliberate:
  // `_checkpointHarvest()` runs BEFORE `_mint`, which is the whole point of it existing.
  const supply = state.totalShares;

  // The fee-free part of this sweep, exactly as the vault passed it to `_accrueHarvest`: the
  // terminal harvest gets `RollClose.usdgFromAssignment` — which the RollClose handler wrote to
  // `c.assignmentUsdg` one log earlier in this same transaction — and a checkpoint gets 0.
  const h = {
    grossUsdg,
    feeUsdg,
    netUsdg,
    usdgFromAssignment: terminal ? c.assignmentUsdg : 0n,
    supply,
  };
  const split = splitHarvest(h);

  await context.db
    .insert(schema.harvest)
    .values({
      id: eventId(event),
      cycleNumber,
      terminal,
      filled,
      grossUsdg,
      feeUsdg,
      netUsdg,
      premiumGrossUsdg: split.premiumGross,
      strikeProceedsUsdg: split.strikeProceeds,
      premiumNetUsdg: split.premiumNet,
      premiumToVault: c.premiumToVault,
      assignmentUsdg: c.assignmentUsdg,
      contractsSold: c.contractsSold,
      contractsAssigned: c.contractsAssigned,
      accUsdgPerShare: state.accUsdgPerShare,
      supply,
      premiumNetPerShare: split.premiumNetPerShare,
      usdgPerShare: split.creditedPerShare,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  // A checkpoint harvest that lands AFTER the week already closed (a deposit between
  // `rollClose` and the next `rollOpen` still carries the closed cycle's number) must not
  // reopen or restate a published week. It keeps its row; the cycle is left alone.
  const touchesCycle = cycleNumber !== 0 && (terminal || !c.harvested);

  if (touchesCycle) {
    await patchCycle(context.db, cycleNumber, {
      // Accumulated, not assigned: the week's take can be swept in more than one go, and the
      // published figure is the whole week. Per-share figures are summed the same way, and for
      // the same reason: each sweep is indexed against the supply at that moment. The
      // arithmetic, and the premium / strike-proceeds split, is lib/harvest.ts `addHarvest`.
      ...addHarvest(c, h),
      supplyAtHarvest: supply,
      ...(terminal
        ? { status, harvested: true, harvestedAt: event.block.timestamp }
        : {}),
    });
  }

  await patchState(context.db, {
    lifetimeProtocolFee: state.lifetimeProtocolFee + feeUsdg,
    // Premium only. The strike proceeds are tallied beside it, never inside it.
    lifetimePremiumNet: state.lifetimePremiumNet + split.premiumNet,
    lifetimeStrikeProceeds: state.lifetimeStrikeProceeds + split.strikeProceeds,
    lifetimeCreditedUsdg: state.lifetimeCreditedUsdg + netUsdg,
    ...(terminal
      ? {
          // `rollClose` returns the vault to Idle right after settling the queue; there is no
          // later event to hang that on, and nothing after this point changes the phase.
          //
          // The cycle fields are deliberately NOT cleared. The contract does not clear them
          // either — `cycleNumber`, `cycleStrikeUsdg` and the two timestamps survive until
          // the next `rollOpen` — and `_settleQueue` runs AFTER `_harvest`, so `QueueSettled`
          // still needs the closing cycle's number to stamp on its epoch.
          phase: PHASE.Idle,
          cyclesFilled: state.cyclesFilled + (filled ? 1 : 0),
          cyclesUnfilled: state.cyclesUnfilled + (filled ? 0 : 1),
          cyclesAssigned: state.cyclesAssigned + (c.contractsAssigned > 0n ? 1 : 0),
        }
      : {}),
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await snapshot(context.db, event, terminal ? "Harvest" : "CheckpointHarvest");
});

/** The Distributor index moved. Fires just before `Harvest`, and only when there is something to index. */
ponder.on("Vault:UsdgDistributed", async ({ event, context }) => {
  const { amount, accUsdgPerShare } = event.args;

  const state = await getState(context.db);
  await patchState(context.db, {
    accUsdgPerShare,
    totalUsdgDistributed: state.totalUsdgDistributed + amount,
    // Anything that was being carried has now been folded into the index.
    usdgUnallocated: 0n,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/** USDG that arrived with no shares to index it against, or too small to index. Carried, never dropped. */
ponder.on("Vault:UsdgUnallocated", async ({ event, context }) => {
  const { totalUnallocated } = event.args;
  await patchState(context.db, {
    usdgUnallocated: totalUnallocated,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Vault:ClaimUsdg", async ({ event, context }) => {
  const { account, amount } = event.args;

  const u = await getUser(context.db, account, event);
  await context.db
    .update(schema.user, { address: account })
    .set({ claimedUsdg: u.claimedUsdg + amount });

  const state = await getState(context.db);
  await patchState(context.db, {
    totalUsdgClaimed: state.totalUsdgClaimed + amount,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await snapshot(context.db, event, "ClaimUsdg");
});

/**
 * The accrued protocol fee actually left the vault for the fee recipient.
 *
 * The fee accrues at every harvest with premium in it (`Harvest.feeUsdg`, counted in
 * `lifetimeProtocolFee`), but the push inside `rollClose` is deliberately best-effort — a
 * blocklisted or reverting recipient must not be able to freeze the whole vault over a fee
 * that harms only us — so payment trails accrual by an arbitrary gap and completes via the
 * permissionless `sweepFee`. `lifetimeProtocolFee − totalFeeSwept` is the vault's live
 * `pendingFeeUsdg`.
 */
ponder.on("Vault:FeeSwept", async ({ event, context }) => {
  const { feeRecipient, amount } = event.args;

  const state = await getState(context.db);
  await patchState(context.db, {
    totalFeeSwept: state.totalFeeSwept + amount,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  log.info({ feeRecipient, amount }, "protocol fee swept");

  await snapshot(context.db, event, "FeeSwept");
});

/*//////////////////////////////////////////////////////////////
                          GOVERNANCE
//////////////////////////////////////////////////////////////*/

/** A halt blocks `rollOpen` and nothing else: queueing, claiming and closing stay open. */
ponder.on("Vault:WritesHalted", async ({ event, context }) => {
  await patchState(context.db, {
    writesHalted: event.args.halted,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  log.warn({ halted: event.args.halted, txHash: event.transaction.hash }, "writes halted flipped");
  await snapshot(context.db, event, "WritesHalted");
});

ponder.on("Vault:PolicyUpdated", async ({ event, context }) => {
  await patchState(context.db, {
    protocolFeeBps: event.args.params.protocolFeeBps,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Vault:FeeRecipientUpdated", async ({ event, context }) => {
  await patchState(context.db, {
    feeRecipient: event.args.feeRecipient,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Vault:DepositCapUpdated", async ({ event, context }) => {
  await patchState(context.db, {
    depositCap: event.args.cap,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/**
 * How stale the spot price may be before `rollOpen` refuses to write.
 *
 * It is measured in DAYS, not hours, and that is deliberate: the NVDA/USD feed on this chain
 * only updates while the US equity market is open, so a weekend gap of ~52 hours is normal
 * and a 24-hour rule would have blocked every Saturday roll. Worth surfacing because it is
 * the one policy number that looks wrong until you know why.
 */
ponder.on("Vault:MaxPriceAgeUpdated", async ({ event, context }) => {
  await patchState(context.db, {
    maxPriceAge: event.args.seconds_,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/**
 * Valorem's engine fee is 15 bps of NOTIONAL, which on a weekly out-of-the-money call is a
 * large slice of the premium. The vault refuses to write while it is on unless governance has
 * explicitly accepted paying it, so this flag is worth surfacing.
 */
ponder.on("Vault:ValoremFeeAccepted", async ({ event, context }) => {
  await patchState(context.db, {
    valoremFeeAccepted: event.args.accepted,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  // Governance accepting a 15 bps-of-notional engine fee is an economics decision worth a
  // record of: it is ~37% of the launch premium floor.
  log.warn({ accepted: event.args.accepted, txHash: event.transaction.hash }, "valorem fee acceptance flipped");
});

/*//////////////////////////////////////////////////////////////
                             ROLES
//////////////////////////////////////////////////////////////*/

/**
 * Role grants and revocations.
 *
 * "Who can touch this vault right now" is a published fact, not an implementation detail: the
 * keeper can only propose, the guardian can only stop things, and the admin Safe can only move
 * policy inside caps that are compiled into the bytecode. A grant to an address nobody
 * recognises is the first thing anyone watching would want to see.
 *
 * `RoleAdminChanged` is NOT handled, and that is not an omission: the vault never calls
 * `_setRoleAdmin`, so every role's admin is `DEFAULT_ADMIN_ROLE` for the life of the contract
 * and the event can never be emitted. `Approval` is likewise skipped — an ERC-20 allowance on
 * the shares carries no product meaning and would bury the trail in noise.
 */
ponder.on("Vault:RoleGranted", async ({ event, context }) => {
  const { role, account } = event.args;
  const id = `${role}-${account.toLowerCase()}`;

  await context.db
    .insert(schema.roleMember)
    .values({
      id,
      role,
      roleName: roleName(role),
      account,
      granted: true,
      grantedAt: event.block.timestamp,
      grantedTx: event.transaction.hash,
    })
    // A re-grant after a revocation reopens the same row rather than starting a new one.
    .onConflictDoUpdate({
      granted: true,
      grantedAt: event.block.timestamp,
      grantedTx: event.transaction.hash,
      revokedAt: null,
      revokedTx: null,
    });

  log.warn(
    { role: roleName(role), account, txHash: event.transaction.hash },
    "role granted",
  );
});

ponder.on("Vault:RoleRevoked", async ({ event, context }) => {
  const { role, account } = event.args;
  const id = `${role}-${account.toLowerCase()}`;

  await context.db
    .insert(schema.roleMember)
    .values({
      id,
      role,
      roleName: roleName(role),
      account,
      granted: false,
      revokedAt: event.block.timestamp,
      revokedTx: event.transaction.hash,
    })
    .onConflictDoUpdate({
      granted: false,
      revokedAt: event.block.timestamp,
      revokedTx: event.transaction.hash,
    });

  log.warn(
    { role: roleName(role), account, txHash: event.transaction.hash },
    "role revoked",
  );
});
