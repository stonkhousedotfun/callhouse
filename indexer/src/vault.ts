import { ponder } from "ponder:registry";
import schema from "ponder:schema";
import type { Address } from "viem";

import { valoremClearAbi } from "../abis/valoremClear";
import { vaultAbi } from "../abis/vault";
import { checkWiring, constructorSettings, wiringError, type WiringReads } from "../lib/deployment";
import { ASSET, CLEARINGHOUSE, SEAPORT, USDG, VAULT, WAD } from "../lib/env";
import { addHarvest, splitHarvest } from "../lib/harvest";
import {
  PHASE,
  eventId,
  getCycle,
  getEpoch,
  getState,
  getUser,
  isAccountable,
  patchCycle,
  patchEpoch,
  patchState,
  patchStrand,
  safeDiv,
  snapshot,
  sub,
  ZERO_ADDRESS,
} from "../lib/indexing";
import {
  closeStatus,
  endedListingStatus,
  entryStrandShare,
  harvestCycleView,
  harvestOrigin,
  harvestTouchesCycle,
  optionIdAfterClose,
  recoveredStatus,
  settlementCycle,
  strandRecovery,
} from "../lib/lifecycle";
import { log } from "../lib/log";
import { roleName } from "../lib/roles";

/*//////////////////////////////////////////////////////////////
                       CONSTRUCTOR SETTINGS
//////////////////////////////////////////////////////////////*/

/** One of the vault's four immutable address views, or null when it did not answer. */
type ReadWiringView = (functionName: keyof WiringReads) => Promise<Address | null>;

/**
 * Compare the vault's four immutable contract addresses with the env and THROW on any
 * difference: a Ponder handler that throws stops the indexer, which is the point. A wrong source
 * address is a configuration error that would publish a wrong tape (every fill counted as 0
 * contracts), not something to warn about. Returns false when the views did not all answer, so
 * the caller knows the check is still owed. See lib/deployment.ts `checkWiring`.
 */
async function assertWiring(read: ReadWiringView, when: string): Promise<boolean> {
  const reads: WiringReads = { clear: await read("clear"), seaport: await read("seaport"), usdg: await read("usdg"), asset: await read("asset") };
  const { mismatches, unverified } = checkWiring(reads, { CLEARINGHOUSE, SEAPORT, USDG, ASSET });
  if (mismatches.length > 0) {
    log.warn({ vault: VAULT, when, mismatches }, "vault wiring does not match the indexer's env; refusing to index");
    throw wiringError(VAULT, mismatches);
  }
  if (unverified.length > 0) {
    log.warn({ vault: VAULT, when, unverified }, "vault wiring unreadable; checked again at the next RollOpen");
    return false;
  }
  return true;
}

/**
 * Seed the settings the constructor sets without an event: `policy().protocolFeeBps`,
 * `feeRecipient()` and `depositCap()`. Runs once, before any vault event, with the client pinned
 * to START_BLOCK. Governance events later in the log overwrite them as before. See lib/deployment.ts.
 *
 * First, refuse to index a vault built over different contracts than the env names: `clear()`,
 * `seaport()`, `usdg()` and `asset()` against CLEARINGHOUSE, SEAPORT, USDG and ASSET. If
 * START_BLOCK precedes the deployment the views do not answer here, and `Vault:RollOpen` makes the
 * same check before the first week can be misread.
 */
ponder.on("Vault:setup", async ({ context }) => {
  await assertWiring(async (functionName) => {
    try {
      return (await context.client.readContract({ abi: vaultAbi, address: VAULT, functionName })) as Address;
    } catch {
      return null;
    }
  }, "setup (START_BLOCK)");

  const read = async <T>(functionName: "policy" | "feeRecipient" | "depositCap"): Promise<T | null> => {
    try {
      return (await context.client.readContract({ abi: vaultAbi, address: VAULT, functionName })) as T;
    } catch {
      return null;
    }
  };
  const settings = constructorSettings({
    policy: await read("policy"),
    feeRecipient: await read("feeRecipient"),
    depositCap: await read("depositCap"),
  });
  if (Object.keys(settings).length === 0) {
    log.warn({ vault: VAULT }, "vault settings unreadable at START_BLOCK; fee bps, fee recipient and cap stay unset until a governance event");
    return;
  }
  await patchState(context.db, settings);
});

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
 *
 * Deposits are refused (`DepositsClosed`, `maxDeposit() == 0`) outside Idle and Listed, after
 * the exercise timestamp, with unclaimed assignment proceeds, while a claim is stranded, while
 * the reserve is unbacked, and below the share-price floor — none of which is an event; the API
 * reads `maxDeposit` live.
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

/** Instant redeem / withdraw. Only reachable while the vault is flat (Idle, nothing written); otherwise `UseQueue()`. */
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
 * An epoch settling while a claim is stranded takes its pro-rata WAD share of that claim.
 *
 * Fires inside `_settleQueue`, one log before `QueueSettled`, only when `claimKey != 0` at
 * settlement — i.e. on the `rollClose` that stranded the claim and on every flat `settleQueue()`
 * while it stays stranded. The share leaves the live shares' hands now (`strandedRemainingWad`)
 * and becomes assets and USDG for the epoch's owners only when `retryStrandedClaim` redeems it.
 */
ponder.on("Vault:EpochStrandShare", async ({ event, context }) => {
  const { epochId, gen, wad } = event.args;

  const state = await getState(context.db);
  await patchState(context.db, {
    strandedRemainingWad: sub(state.strandedRemainingWad, wad),
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await getEpoch(context.db, epochId, event);
  await patchEpoch(context.db, epochId, { strandGen: gen, strandWad: wad });

  const s = await context.db.find(schema.strand, { gen });
  if (s !== null) {
    await patchStrand(context.db, gen, { epochWad: s.epochWad + wad, epochCount: s.epochCount + 1 });
  }

  log.info({ epochId, gen, wad, txHash: event.transaction.hash }, "queue epoch took a share of the stranded claim");
});

/**
 * Settlement: escrowed shares are burnt and a slice of idle assets plus the USDG the escrow
 * itself accrued is set aside for the epoch. Both amounts leave NAV immediately, which is why
 * `reservedAssets` and `usdgReservedForQueue` go up here and come down as people claim.
 *
 * TWO ORIGINS. Inside `rollClose` (after `RollClose` and the terminal `Harvest`), and from the
 * permissionless `settleQueue()`, which anyone may call while the vault is Idle so a queue made
 * while flat never waits on a `rollOpen` that may not come — and which, while a claim is
 * stranded, IS the exit. The second runs in its own transaction, preceded by a checkpoint
 * `Harvest` when USDG had landed since the last close, and does not touch the phase. The state
 * arithmetic is identical; only the epoch's `cycleNumber` differs, and `settlementCycle` decides
 * it: the closing week for a `rollClose`, null for a flat settlement, which belongs to no week.
 */
ponder.on("Vault:QueueSettled", async ({ event, context }) => {
  const { epochId, shares, assets, usdgOut } = event.args;

  const state = await getState(context.db);
  const cycleNumber = settlementCycle(state, event.transaction.hash);
  await patchState(context.db, {
    queuedShares: sub(state.queuedShares, shares),
    reservedAssets: state.reservedAssets + assets,
    usdgReservedForQueue: state.usdgReservedForQueue + usdgOut,
    // `_settleQueue` takes the escrow's accrual through `Distributor._takeAccrued`, which adds it
    // to `totalUsdgClaimed` exactly as `_claimUsdg` does; `usdgOut` is that amount. Counting only
    // `ClaimUsdg` left the queue's USDG claimed nowhere, so `distributed − claimed` read the whole
    // escrow as still owed to holders (X-11: 1244.000475 published against 2061.250593 on chain).
    totalUsdgClaimed: state.totalUsdgClaimed + usdgOut,
    // The vault bumps its epoch counter immediately after emitting this.
    epochId: epochId + 1n,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await patchEpoch(context.db, epochId, {
    status: "settled",
    cycleNumber,
    sharesSettled: shares,
    assetsSettled: assets,
    usdgSettled: usdgOut,
    settledAt: event.block.timestamp,
    settledTx: event.transaction.hash,
  });

  // Open the next epoch so a queue joined before the next settlement has somewhere to land.
  await getEpoch(context.db, epochId + 1n, event);

  log.info(
    { epochId, shares, assets, usdgOut, cycleNumber, via: cycleNumber === null ? "settleQueue" : "rollClose" },
    "redeem queue settled",
  );

  await snapshot(context.db, event, cycleNumber === null ? "SettleQueue" : "QueueSettled");
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
 *
 * An epoch that settled while a claim was stranded also owns a WAD share of that claim, and
 * the entry takes its slice of it here (`Vault._settleEpochEntry`, no event of its own): pro
 * rata by shares, the last claimant taking the rest. It is staged against the owner as
 * `strandWad` and becomes assets and USDG only at `StrandShareSettled`.
 */
ponder.on("Vault:QueueEntrySettled", async ({ event, context }) => {
  const { owner, epochId, shares, assets, usdgOut } = event.args;

  const ep = await getEpoch(context.db, epochId, event);
  const strandShare = ep.strandGen === null ? 0n : entryStrandShare(ep, shares);

  // On chain the slot is zeroed, not decremented — the entry is gone. If the same transaction
  // re-queues, the `QueueRedeem` handler runs after this and starts the slot fresh.
  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({
    queuedShares: 0n,
    queuedEpoch: null,
    ...(strandShare === 0n
      ? {}
      : {
          // `_stageStrandShare` folds an older generation's share first (`StrandShareSettled`,
          // one log earlier in this same call), so by now the owner holds shares of one
          // generation at most and adding is exact.
          strandWad: u.strandWad + strandShare,
          strandGen: ep.strandGen,
        }),
  });

  await patchEpoch(context.db, epochId, {
    sharesClaimed: ep.sharesClaimed + shares,
    assetsClaimed: ep.assetsClaimed + assets,
    usdgClaimed: ep.usdgClaimed + usdgOut,
    claimCount: ep.claimCount + 1,
    strandWadClaimed: ep.strandWadClaimed + strandShare,
  });

  await snapshot(context.db, event, "QueueEntrySettled");
});

/**
 * An owner's staged share of a stranded claim became assets and USDG (AF-02).
 *
 * The strand analogue of `QueueEntrySettled`: books move, no token. Fires inside
 * `completeRedeem` (and inside `_stageStrandShare` when a newer share displaces an older,
 * resolved one) once `retryStrandedClaim` has redeemed the generation; the amounts go into the
 * owner's owed balances and are paid by the `CompleteRedeem` that follows, like any other owed
 * balance. The generation's `*Left` come down here; the reserves come down at the payout.
 */
ponder.on("Vault:StrandShareSettled", async ({ event, context }) => {
  const { owner, gen, wad, assets, usdgOut } = event.args;

  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({
    strandWad: sub(u.strandWad, wad),
    strandGen: sub(u.strandWad, wad) === 0n ? null : u.strandGen,
  });

  const s = await context.db.find(schema.strand, { gen });
  if (s !== null) {
    await patchStrand(context.db, gen, {
      wadLeft: sub(s.wadLeft, wad),
      assetsLeft: sub(s.assetsLeft, assets),
      usdgLeft: sub(s.usdgLeft, usdgOut),
      settledCount: s.settledCount + 1,
    });
  }

  log.info({ owner, gen, wad, assets, usdgOut, txHash: event.transaction.hash }, "stranded-claim share settled to its owner");
});

/**
 * The reserve was unbacked and a settled redeemer took the pro-rata haircut (AF-05).
 *
 * `reservedAssets` on chain is released by the BOOKED amount while only `paid` leaves the
 * vault, and `CompleteRedeem` (one log later) reports `paid`. The shortfall therefore comes off
 * the indexed reserve here so that the two handlers together release exactly `booked`. The
 * haircut is permanent: what the issuer's burn took from this claimant is never repaid.
 */
ponder.on("Vault:ReserveHaircut", async ({ event, context }) => {
  const { owner, booked, paid } = event.args;
  const shortfall = sub(booked, paid);

  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({ haircutAssets: u.haircutAssets + shortfall });

  const state = await getState(context.db);
  await patchState(context.db, {
    reservedAssets: sub(state.reservedAssets, shortfall),
    lifetimeHaircutAssets: state.lifetimeHaircutAssets + shortfall,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  // RESERVE_HAIRCUT: the Stock Token issuer burnt the vault below what settled redeemers are owed.
  log.warn({ owner, booked, paid, shortfall, txHash: event.transaction.hash }, "reserve haircut paid to a settled redeemer");
});

/**
 * The USDG leg of a payout could not move (AF-03): USDG paused, or the vault or the receiver
 * frozen on it. The Stock Token leg still went, `owedQueueUsdg` stays booked, and a later
 * `completeRedeem` — to the same or another receiver — collects it. Nothing here is lost; it is
 * surfaced so the UI can say "your USDG is still owed" instead of "paid".
 */
ponder.on("Vault:UsdgLegDeferred", async ({ event, context }) => {
  const { owner, receiver, usdgOwed } = event.args;

  // `getUser` stamps the owner's last activity; the row itself is patched with the figure the
  // contract still owes, which is the whole USDG leg (the leg moves entirely or not at all).
  await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({ deferredUsdg: usdgOwed });

  // USDG_LEG_DEFERRED: a stablecoin-side action is holding a redeemer's USDG.
  log.warn({ owner, receiver, usdgOwed, txHash: event.transaction.hash }, "usdg leg of a redemption deferred");
  await snapshot(context.db, event, "UsdgLegDeferred");
});

/**
 * Owed balances actually left the vault.
 *
 * The epoch drawdown is NOT here: it happened at `QueueEntrySettled`, which fires first in
 * the same transaction — or fired transactions earlier, when a later `queueRedeem`
 * auto-settled the slot. What remains is the payout itself: the lifetime redeemed totals, and
 * the reserves, which only ever come down here (and at `ReserveHaircut`, by the shortfall).
 *
 * `assets` is what was PAID. `usdgOut` is 0 when the USDG leg was deferred; a non-zero
 * `usdgOut` is the whole owed USDG, so it also clears any deferral on record.
 */
ponder.on("Vault:CompleteRedeem", async ({ event, context }) => {
  const { owner, assets, usdgOut } = event.args;

  const u = await getUser(context.db, owner, event);
  await context.db.update(schema.user, { address: owner }).set({
    redeemedAssets: u.redeemedAssets + assets,
    redeemedUsdg: u.redeemedUsdg + usdgOut,
    ...(usdgOut > 0n ? { deferredUsdg: 0n } : {}),
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
 * The keeper ARMED a cycle: a Valorem option type, validated by the vault from the clearinghouse
 * itself (asset/USDG, lot 1e18, exercise ≥ 1 h out, window ≥ 1 day, tenor ≤ 21 days, strike
 * inside the band). NOTHING IS WRITTEN HERE. `contractsCount` is always 0 under write on fill;
 * every write is reported by its own `CallsWritten` from inside the Seaport fill that sold it.
 *
 * The vault numbers its own cycles (no registry), so this is what creates the week's row. The
 * option's window is the tuple Valorem holds for the id — `clear.option(optionId)`, immutable
 * from `newOptionType` on, so the read is as deterministic as a log and reproducible on a
 * backfill. The vault's own `cycleExerciseTs` / `cycleExpiryTs` (its snapshot of that tuple, set
 * before the emit) are the fallback for a clearinghouse that does not answer at this block.
 */
ponder.on("Vault:RollOpen", async ({ event, context }) => {
  const { cycleNumber, optionId, contractsCount, strikeUsdg } = event.args;

  // The vault exists at this block by construction, so the wiring check `Vault:setup` could not
  // make (START_BLOCK before the deploy) is made here, before a single fill of the week is read.
  // The four views are immutable, so the reads are as reproducible as a log on a backfill.
  await assertWiring(async (functionName) => {
    try {
      return (await context.client.readContract({ abi: vaultAbi, address: VAULT, functionName })) as Address;
    } catch {
      return null;
    }
  }, `RollOpen ${cycleNumber}`);

  const state = await getState(context.db);

  const readTs = async (functionName: "cycleExerciseTs" | "cycleExpiryTs"): Promise<bigint> => {
    try {
      return BigInt(await context.client.readContract({ abi: vaultAbi, address: VAULT, functionName }));
    } catch {
      return 0n;
    }
  };
  let exerciseTimestamp = 0n;
  let expiryTimestamp = 0n;
  try {
    const option = await context.client.readContract({
      abi: valoremClearAbi,
      address: CLEARINGHOUSE,
      functionName: "option",
      args: [optionId],
    });
    exerciseTimestamp = BigInt(option.exerciseTimestamp);
    expiryTimestamp = BigInt(option.expiryTimestamp);
  } catch {
    log.warn({ cycleNumber, optionId, txHash: event.transaction.hash }, "clear.option() unreadable at RollOpen; falling back to the vault's snapshot of the window");
  }
  if (exerciseTimestamp === 0n) exerciseTimestamp = await readTs("cycleExerciseTs");
  if (expiryTimestamp === 0n) expiryTimestamp = await readTs("cycleExpiryTs");
  if (exerciseTimestamp === 0n || expiryTimestamp === 0n) {
    log.warn({ cycleNumber, optionId, txHash: event.transaction.hash }, "option window unreadable at RollOpen; timestamps stay 0 on the index");
  }
  if (contractsCount !== 0n) {
    // Not possible on the redesigned vault; if it ever is, the tape must not silently miss a write.
    log.warn({ cycleNumber, contractsCount, txHash: event.transaction.hash }, "RollOpen reported a non-zero write; the redesign writes on fill only");
  }

  await patchState(context.db, {
    phase: PHASE.Listed,
    cycleNumber,
    optionId,
    claimKey: null,
    strikeUsdg,
    exerciseTimestamp,
    expiryTimestamp,
    contractsWritten: 0n,
    lockedCollateral: 0n,
    listingHash: null,
    listingsThisCycle: 0,
    cyclesWritten: state.cyclesWritten + 1,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await patchCycle(context.db, cycleNumber, {
    status: "listed",
    optionId,
    strikeUsdg,
    exerciseTimestamp,
    expiryTimestamp,
    openedAt: event.block.timestamp,
    openedBlock: event.block.number,
    txOpen: event.transaction.hash,
  });

  log.info(
    { cycleNumber, optionId, strikeUsdg, exerciseTimestamp, expiryTimestamp, txHash: event.transaction.hash },
    "cycle armed: option type accepted, nothing written yet",
  );

  await snapshot(context.db, event, "RollOpen", {
    client: context.client,
    refreshMultiplier: true,
  });
});

/**
 * ONE FILL WROTE ITS CONTRACTS. Emitted from `_recordWrite` inside the Seaport zone hook
 * `authorizeOrder`, after `clear.write` and before Seaport moves the minted tokens to the
 * buyer, so it sits in the same transaction as the `OrderFulfilled` that bought them.
 *
 * `contractsCount` is THIS fill's size and `collateral` what THIS fill locked (`n × 1e18`; the
 * Valorem engine fee, if governance ever accepts it, is pulled on top and is not in it). Both
 * ACCUMULATE: the first fill of a cycle opens the claim and every later one tops the same claim
 * up (the library reverts if Valorem hands back any other id). Written == sold by construction,
 * so `vaultState.contractsWritten` is the week's size and `cycle.contractsSold` (from Seaport)
 * is its cross-check.
 */
ponder.on("Vault:CallsWritten", async ({ event, context }) => {
  const { optionId, claimKey, contractsCount, collateral } = event.args;
  const n = BigInt(contractsCount);

  const state = await getState(context.db);
  const contractsWritten = state.contractsWritten + n;
  const lockedCollateral = state.lockedCollateral + collateral;

  await patchState(context.db, {
    optionId,
    claimKey,
    contractsWritten,
    lockedCollateral,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  if (state.cycleNumber !== 0) {
    const c = await getCycle(context.db, state.cycleNumber);
    await patchCycle(context.db, state.cycleNumber, {
      claimKey,
      contractsWritten: c.contractsWritten + n,
      collateral: c.collateral + collateral,
      writeCount: c.writeCount + 1,
      firstWriteAt: c.firstWriteAt ?? event.block.timestamp,
      lastWriteAt: event.block.timestamp,
    });
  }

  log.info(
    { cycleNumber: state.cycleNumber, optionId, claimKey, contracts: n, collateral, contractsWritten, txHash: event.transaction.hash },
    "fill wrote its contracts",
  );

  // Collateral moved from idle into Valorem: the one moment `totalAssets` is unchanged while
  // `idleAssets` falls, and worth a row in the trail.
  await snapshot(context.db, event, "CallsWritten");
});

/**
 * The book closes at the option's exercise timestamp. Permissionless, so anyone may call it.
 * A listing still live is invalidated on the way (`ListingCancelled` + `AllListingsInvalidated`
 * one and two logs earlier), and this is where that listing's end reason learns it was the book
 * closing rather than the guardian.
 */
ponder.on("Vault:BookLocked", async ({ event, context }) => {
  const { cycleNumber } = event.args;

  const state = await getState(context.db);
  await refineEndReason(context.db, state, event.transaction.hash, "lockBook");

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
 * `rollClose` could not redeem the claim (AF-02): Valorem's `redeem` reverted — USDG paused,
 * the vault or Clear frozen on USDG, Clear's USDG burnt, or the vault blocklisted on the Stock
 * Token in an unassigned week. Emitted immediately BEFORE the `RollClose` of the same
 * transaction, which then reports zero legs.
 *
 * The vault still reaches Idle with the claim, `optionId` and `contractsWritten` all kept:
 * `lockedAssets()` stays honest, the instant path stays shut, deposits and `rollOpen` refuse,
 * and the queue keeps settling on the idle balance with each epoch taking its share of the
 * claim. `retryStrandedClaim()` is the way out, and anyone may call it.
 */
ponder.on("Vault:ClaimStranded", async ({ event, context }) => {
  const { cycleNumber, claimKey, gen } = event.args;

  const state = await getState(context.db);
  await patchState(context.db, {
    stranded: true,
    strandGen: gen,
    strandedRemainingWad: WAD,
    strandedCycleNumber: cycleNumber,
    cyclesStranded: state.cyclesStranded + 1,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await context.db
    .insert(schema.strand)
    .values({
      gen,
      cycleNumber,
      claimKey,
      strandedAt: event.block.timestamp,
      strandedBlock: event.block.number,
      strandedTx: event.transaction.hash,
    })
    .onConflictDoNothing();

  await patchCycle(context.db, cycleNumber, { stranded: true, strandGen: gen });

  // CLAIM_STRANDED: the week's strike proceeds and unassigned collateral are stuck in Valorem
  // until an issuer lifts whatever blocked the redeem. Deposits and instant redemption are shut.
  log.warn({ cycleNumber, claimKey, gen, txHash: event.transaction.hash }, "rollClose stranded the claim");
});

/**
 * The close: the claim was redeemed (or stranded, one log earlier) and the balance deltas are
 * known.
 *
 * `contractsAssignedCount` is read by the vault from `contractsAssigned()` — Valorem's
 * `claim().amountExercised`, divided back down by the 1e18 scalar — BEFORE the redeem is
 * attempted, so it is authoritative on a stranded close too. On a stranded close
 * `assetsReturned` and `usdgFromAssignment` are both 0; the real figures arrive with
 * `StrandedClaimRecovered` and the retry's `ClaimRedeemed`.
 *
 * This handler also stamps `rollCloseTx`, which is how the `Harvest` and `QueueSettled`
 * handlers tell the week's terminal events apart from a checkpoint or a flat `settleQueue`.
 */
ponder.on("Vault:RollClose", async ({ event, context }) => {
  const { cycleNumber, assetsReturned, usdgFromAssignment, contractsAssignedCount } =
    event.args;

  const state = await getState(context.db);
  const c = await getCycle(context.db, cycleNumber);
  await refineEndReason(context.db, state, event.transaction.hash, "rollClose");

  if (c.contractsSold !== c.contractsWritten) {
    // Written == sold is a property of the contracts, not of this index. If the two sums differ
    // the tape has missed a fill or a write, and that is worth knowing at once.
    log.warn(
      { cycleNumber, contractsSold: c.contractsSold, contractsWritten: c.contractsWritten, txHash: event.transaction.hash },
      "contracts sold (Seaport) and written (CallsWritten) disagree at the close",
    );
  }

  await patchCycle(context.db, cycleNumber, {
    assetsReturned,
    assignmentUsdg: usdgFromAssignment,
    contractsAssigned: contractsAssignedCount,
    closedAt: event.block.timestamp,
    closedBlock: event.block.number,
    txClose: event.transaction.hash,
  });

  await patchState(context.db, {
    phase: PHASE.Settling,
    // A stranded claim keeps its collateral locked; `Vault:ClaimRedeemed` clears it otherwise
    // (one log earlier) and clears it again when the retry lands.
    lockedCollateral: state.stranded ? state.lockedCollateral : 0n,
    // The armed type survives the close only while its claim is stranded: an unfilled week
    // forgets it on chain (`optionId = 0`, no claim to redeem) and a redeemed one already had
    // it cleared by `Vault:ClaimRedeemed`. Mirrored here so the vault row never names an
    // option the contract has let go of.
    optionId: optionIdAfterClose(state),
    lifetimeAssignmentUsdg: state.lifetimeAssignmentUsdg + usdgFromAssignment,
    // Read by the Harvest and QueueSettled handlers, a few logs later in this same transaction.
    rollCloseTx: event.transaction.hash,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  // The week's summary line — the same numbers the weekly publish is built from.
  log.info(
    {
      cycleNumber,
      written: c.contractsWritten,
      sold: c.contractsSold,
      assetsReturned,
      usdgFromAssignment,
      contractsAssigned: contractsAssignedCount,
      stranded: state.stranded,
      txHash: event.transaction.hash,
    },
    state.stranded ? "cycle closed: claim STRANDED" : "cycle closed: claim redeemed",
  );

  await snapshot(context.db, event, "RollClose", {
    client: context.client,
    refreshMultiplier: true,
  });
});

/**
 * The vault's own view of the Valorem redemption: the cycle's position is torn down. Fires
 * inside `rollClose` just before `RollClose` on an ordinary close, and inside
 * `retryStrandedClaim` just before `StrandedClaimRecovered` on a recovery. `Clear:ClaimRedeemed`
 * carries the same numbers from Valorem's side and is the cross-check.
 *
 * A stranded close does NOT emit this: the position is kept, and so are these columns.
 */
ponder.on("Vault:ClaimRedeemed", async ({ event, context }) => {
  const { claimKey, underlyingReturned, exerciseReceived } = event.args;

  const state = await getState(context.db);
  await patchState(context.db, {
    claimKey: null,
    optionId: null,
    contractsWritten: 0n,
    lockedCollateral: 0n,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  // The retry: the stranded week finally learns what its claim returned. The ordinary close
  // writes the same figures from `RollClose`, one log later.
  if (state.stranded && state.strandedCycleNumber !== null) {
    await patchCycle(context.db, state.strandedCycleNumber, {
      assetsReturned: underlyingReturned,
      assignmentUsdg: exerciseReceived,
    });
    log.info(
      { cycleNumber: state.strandedCycleNumber, claimKey, underlyingReturned, exerciseReceived, txHash: event.transaction.hash },
      "stranded claim redeemed",
    );
  }
});

/**
 * `retryStrandedClaim` got the claim through (AF-02). What the redeem returned is split by
 * `queueWad`: the settled epochs' part of both legs moves into the reserves and is drawn down
 * owner by owner (`StrandShareSettled`); the live shares' NVDA is simply in the balance again,
 * and their USDG goes through the retry's `Harvest` fee-free, one log later, under the stranded
 * cycle's number. The vault is no longer stranded, and the stranded week gets its verdict.
 */
ponder.on("Vault:StrandedClaimRecovered", async ({ event, context }) => {
  const { gen, assets, usdgOut, queueWad } = event.args;
  const split = strandRecovery(assets, usdgOut, queueWad);

  const state = await getState(context.db);
  await patchState(context.db, {
    stranded: false,
    lastResolvedGen: gen,
    strandedRemainingWad: 0n,
    strandedCycleNumber: null,
    reservedAssets: state.reservedAssets + split.queueAssets,
    usdgReservedForQueue: state.usdgReservedForQueue + split.queueUsdg,
    lifetimeAssignmentUsdg: state.lifetimeAssignmentUsdg + usdgOut,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await patchStrand(context.db, gen, {
    recovered: true,
    recoveredAt: event.block.timestamp,
    recoveredBlock: event.block.number,
    recoveredTx: event.transaction.hash,
    assetsIn: assets,
    usdgIn: usdgOut,
    queueWad,
    wadLeft: queueWad,
    assetsLeft: split.queueAssets,
    usdgLeft: split.queueUsdg,
  });

  const cycleNumber = state.strandedCycleNumber;
  if (cycleNumber !== null) {
    const c = await getCycle(context.db, cycleNumber);
    await patchCycle(context.db, cycleNumber, {
      status: recoveredStatus({ assigned: c.contractsAssigned }),
      recoveredAt: event.block.timestamp,
      recoveredTx: event.transaction.hash,
    });
  }

  log.warn(
    { gen, cycleNumber, assets, usdgOut, queueWad, ...split, txHash: event.transaction.hash },
    "stranded claim recovered",
  );

  await snapshot(context.db, event, "StrandedClaimRecovered", {
    client: context.client,
    refreshMultiplier: true,
  });
});

/*//////////////////////////////////////////////////////////////
                            LISTINGS
//////////////////////////////////////////////////////////////*/

/**
 * A listing the vault authorised on chain: a PARTIAL_RESTRICTED Seaport 1.6 order, offerer and
 * zone both the vault, one ERC-1155 offer item (this cycle's option type, at most the vault's
 * capacity), ONE ERC-20 consideration item (USDG to the vault), no signature (the vault
 * pre-validates on Seaport). The contract has proved `grossUsdg % amount == 0`, so the unit
 * price is exact and a partial fill pays exactly `unitPrice × k`.
 *
 * `seq` is `listingsThisCycle` after this approval: every `approveListing` spends one of the
 * cycle's three, cancelled or not, so it is a plain count, unique within the cycle. A relist is
 * a reprice (after a rally the fill gate refuses the old price), never a resize: Seaport tracks
 * the fraction filled and the vault sizes every fill itself.
 */
ponder.on("Vault:ListingApproved", async ({ event, context }) => {
  const { orderHash, optionId, amount, grossUsdg, seq } = event.args;

  const unitPrice = safeDiv(grossUsdg, amount);

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
      status: "approved",
      approvedAt: event.block.timestamp,
      approvedBlock: event.block.number,
      approvedTx: event.transaction.hash,
    })
    // Re-approving an identical hash is impossible on chain (the vault refuses a second live
    // listing, and Seaport refuses a validated hash twice), but a reorg replay must not
    // duplicate the row.
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

  log.info(
    { cycleNumber: state.cycleNumber, orderHash, seq, amount, grossUsdg, unitPrice, txHash: event.transaction.hash },
    "listing approved",
  );
});

/**
 * The live listing stopped being live. Emitted by an explicit `cancelListing` and by every
 * counter bump (`invalidateAllListings`, `lockBook`, `rollClose`); a counter bump follows up
 * with `AllListingsInvalidated`, and `lockBook` / `rollClose` with their own event, each of
 * which refines the end reason. A listing that already filled is left alone — a fill is the
 * better story.
 */
ponder.on("Vault:ListingCancelled", async ({ event, context }) => {
  const { orderHash } = event.args;

  const l = await context.db.find(schema.listing, { orderHash });
  if (l !== null && l.status !== "filled") {
    await context.db.update(schema.listing, { orderHash }).set({
      status: endedListingStatus(l.contractsFilled),
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
 * The Seaport counter was bumped, which kills every outstanding order from this offerer
 * without needing the order data: the keeper's or guardian's `invalidateAllListings`, and
 * `lockBook` and `rollClose` on their way through. The listing `ListingCancelled` just closed
 * (one log earlier, same tx) reads "counter" for now; `BookLocked` or `RollClose` in the same
 * transaction refines it to say which.
 */
ponder.on("Vault:AllListingsInvalidated", async ({ event, context }) => {
  const { newCounter } = event.args;

  const state = await getState(context.db);
  await refineEndReason(context.db, state, event.transaction.hash, "counter");

  await patchState(context.db, {
    listingHash: null,
    seaportCounter: newCounter,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/**
 * Upgrade the end reason of the listing `ListingCancelled` closed earlier in `txHash`, if any.
 * The three counter-bump paths emit identical `ListingCancelled` + `AllListingsInvalidated`
 * pairs; only the event that follows them in the same transaction says which path it was.
 */
async function refineEndReason(
  db: Parameters<typeof patchState>[0],
  state: Awaited<ReturnType<typeof getState>>,
  txHash: `0x${string}`,
  endReason: "counter" | "lockBook" | "rollClose",
) {
  if (state.lastCancelledHash === null || state.lastCancelledTx !== txHash) return;
  const l = await db.find(schema.listing, { orderHash: state.lastCancelledHash });
  if (l === null || l.status === "filled") return;
  await db.update(schema.listing, { orderHash: state.lastCancelledHash }).set({ endReason });
}

/*//////////////////////////////////////////////////////////////
                            HARVEST
//////////////////////////////////////////////////////////////*/

/**
 * The week's money, and — for the terminal one — the week's verdict.
 *
 * *** `Harvest` IS EMITTED FROM THREE PLACES AND THEY MEAN DIFFERENT THINGS. ***
 *
 *   `_harvest()` in `rollClose`   Always emits, even with a gross of zero, which is exactly how
 *                                 an unfilled week gets its honest row. This is the TERMINAL
 *                                 harvest: it closes the week and returns the vault to Idle.
 *   `_checkpointHarvest()`        Runs inside `deposit`, `mint` and `settleQueue`, and emits
 *                                 whenever premium has already landed (gross != 0). It exists so
 *                                 a depositor arriving on Thursday cannot mint into premium
 *                                 earned on Tuesday, and so a flat queue settlement pays the
 *                                 escrow its accrual. It carries the SAME cycle number — a
 *                                 settleQueue's checkpoint carries the number of the week that
 *                                 ALREADY closed — and is not a result.
 *   `_harvest()` in the retry     `retryStrandedClaim` indexes the live shares' part of the
 *                                 recovered claim's USDG fee-free, under the STRANDED cycle's
 *                                 number, and pushes any fee the stranded close could not.
 *
 * Nothing in the event itself separates them; `lib/lifecycle.ts harvestOrigin` does, from the
 * transaction. Treating a checkpoint as terminal would flip `phase` to Idle while the vault is
 * still Listed, publish a half-week as the week's result, and add a phantom week to every
 * lifetime tally on every deposit.
 *
 * All three move real money, so all three accumulate onto the cycle (a checkpoint only while
 * the week is still open) and all three get a row. Only the terminal one decides the status:
 *   stranded  the claim could not be redeemed; the verdict waits for the retry
 *   assigned  contracts were taken at the strike
 *   closed    filled, expired out of the money — premium and tokens both kept
 *   unfilled  nothing sold. THE MOST LIKELY OUTCOME, published as "unfilled, 0".
 *
 * The three amounts are taken from the event verbatim; nothing here recomputes the fee. That
 * matters on an assigned week: `grossUsdg` includes the strike proceeds, but the vault charges
 * `feeUsdg` on `grossUsdg − RollClose.usdgFromAssignment` only (Vault._accrueHarvest; a
 * checkpoint excludes 0; the retry excludes the live shares' part of the recovered USDG), so
 * `feeUsdg / grossUsdg` is NOT the policy rate there and must never be used as one.
 * `netUsdg == grossUsdg − feeUsdg` always.
 *
 * And for the same reason `netUsdg` is NOT premium on an assigned week (W-21): the strike
 * proceeds in it are returned principal. `lib/harvest.ts` splits every event into premium and
 * strike proceeds, and every "premium" column here is premium only. The whole credited figure
 * is kept under its own name (`creditedUsdg`, `usdgPerShare`) so nothing has to be inferred.
 */
ponder.on("Vault:Harvest", async ({ event, context }) => {
  const { cycleNumber, grossUsdg, feeUsdg, netUsdg } = event.args;

  const state = await getState(context.db);
  const lastStrand =
    state.lastResolvedGen === 0n ? null : await context.db.find(schema.strand, { gen: state.lastResolvedGen });
  const origin = harvestOrigin(state, lastStrand, event.transaction.hash);
  const terminal = origin === "rollClose";

  // Cycle 0 is the stretch between the deploy and the first `rollOpen`: a checkpoint there (a
  // donation or leftover USDG swept by the first deposit) is real money with no week attached.
  // Reading it through `getCycle` would insert a phantom "listed" row that nothing ever closes,
  // so no row is read and its cycle figures are zero (lib/lifecycle.ts `harvestCycleView`).
  const c = cycleNumber === 0 ? null : await getCycle(context.db, cycleNumber);
  const view = harvestCycleView(c);

  // The verdict comes from the vault's own write count (`CallsWritten`), not from Seaport's
  // offer items, which are only counted when their token equals the CLEARINGHOUSE env var.
  const filled = view.filled;
  const status = closeStatus({ stranded: state.stranded, written: view.contractsWritten, assigned: view.contractsAssigned });

  // Supply at harvest is the pre-burn, pre-mint supply. For the terminal harvest that is
  // deliberate — `_settleQueue` runs after `_harvest`, so shares still escrowed for the queue
  // earn the week they sat through. For a checkpoint harvest it is equally deliberate:
  // `_checkpointHarvest()` runs BEFORE `_mint`, which is the whole point of it existing.
  const supply = state.totalShares;

  // The fee-free part of this sweep, exactly as the vault passed it to `_accrueHarvest`: the
  // terminal harvest gets `RollClose.usdgFromAssignment` — which the RollClose handler wrote to
  // `c.assignmentUsdg` one log earlier in this same transaction — the retry gets the live
  // shares' part of the recovered USDG, and a checkpoint gets 0.
  const feeFree =
    origin === "rollClose"
      ? view.assignmentUsdg
      : origin === "retry" && lastStrand !== null
        ? strandRecovery(lastStrand.assetsIn, lastStrand.usdgIn, lastStrand.queueWad).liveUsdg
        : 0n;
  const h = { grossUsdg, feeUsdg, netUsdg, usdgFromAssignment: feeFree, supply };
  const split = splitHarvest(h);

  await context.db
    .insert(schema.harvest)
    .values({
      id: eventId(event),
      cycleNumber,
      terminal,
      origin,
      filled,
      grossUsdg,
      feeUsdg,
      netUsdg,
      premiumGrossUsdg: split.premiumGross,
      strikeProceedsUsdg: split.strikeProceeds,
      premiumNetUsdg: split.premiumNet,
      assignmentUsdg: view.assignmentUsdg,
      contractsSold: view.contractsSold,
      contractsAssigned: view.contractsAssigned,
      accUsdgPerShare: state.accUsdgPerShare,
      supply,
      premiumNetPerShare: split.premiumNetPerShare,
      usdgPerShare: split.creditedPerShare,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  // A checkpoint harvest that lands AFTER the week already closed (a deposit or a settleQueue
  // between `rollClose` and the next `rollOpen` still carries the closed cycle's number) must
  // not reopen or restate a published week. It keeps its row; the cycle is left alone. The
  // retry is the one post-close harvest that DOES belong to its week: it is the stranded
  // week's strike proceeds arriving late. Cycle 0 has no row to touch.
  if (c !== null && harvestTouchesCycle(c, origin)) {
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
          // still needs the closing cycle's number to stamp on its epoch. A stranded close
          // leaves `claimKey`, `optionId` and `contractsWritten` in place as well.
          phase: PHASE.Idle,
          cyclesFilled: state.cyclesFilled + (filled ? 1 : 0),
          cyclesUnfilled: state.cyclesUnfilled + (filled ? 0 : 1),
          cyclesAssigned: state.cyclesAssigned + (view.contractsAssigned > 0n ? 1 : 0),
        }
      : {}),
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  await snapshot(
    context.db,
    event,
    origin === "rollClose" ? "Harvest" : origin === "retry" ? "RetryHarvest" : "CheckpointHarvest",
  );
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

/**
 * A halt blocks `rollOpen`, `approveListing` and every fill (the zone hook refuses) and nothing
 * else: queueing, `settleQueue`, claiming, cancelling, closing and `retryStrandedClaim` stay open.
 */
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
 * How stale the spot price may be before `rollOpen` refuses to arm and a fill is refused.
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
 * Valorem's engine fee is 15 bps of NOTIONAL, charged on every fill, which on a weekly
 * out-of-the-money call is a large slice of the premium. The vault refuses to arm or fill while
 * it is on unless governance has explicitly accepted paying it (the fill floor is then raised by
 * the fee valued at spot), so this flag is worth surfacing.
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
