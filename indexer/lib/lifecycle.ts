import type { Hex } from "viem";

/**
 * The pure decisions the vault handlers make about WHERE an event came from and WHAT it means,
 * with no Ponder import so src/lifecycle.test.ts can pin them.
 *
 * WHY THIS EXISTS. Several vault events have more than one origin and none of them says which
 * entry point emitted it:
 *
 *   Harvest        `rollClose` (the week's verdict), `deposit`/`mint`/`settleQueue` (a checkpoint
 *                  of premium that already landed) or `retryStrandedClaim` (the live shares'
 *                  part of a recovered claim, under the STRANDED cycle's number).
 *   QueueSettled   `rollClose` (the week's settlement) or `settleQueue` (anyone, while Idle,
 *                  with no cycle attached).
 *   RollClose      a redeemed claim, or a STRANDED one reporting zero legs with `ClaimStranded`
 *                  one log earlier; the outcome is only known at recovery.
 *
 * The handlers import `ponder:registry` / `ponder:schema`, which only exist inside a Ponder
 * process, so they cannot be unit-tested. The choices themselves can: they live here.
 */

/** Vault.Phase, mirrored. There is no phase-change event, so it is derived from the rolls. */
export const PHASE = { Idle: 0, Listed: 1, Exercisable: 2, Settling: 3 } as const;

const WAD = 10n ** 18n;

const sameTx = (a: Hex | null | undefined, b: Hex): boolean =>
  a !== null && a !== undefined && a.toLowerCase() === b.toLowerCase();

/*//////////////////////////////////////////////////////////////
                              HARVEST
//////////////////////////////////////////////////////////////*/

export type HarvestOrigin = "rollClose" | "checkpoint" | "retry";

/**
 * Where a `Harvest` came from.
 *
 * `rollClose` emits `RollClose` BEFORE `_harvest()`, and the `RollClose` handler stamps
 * `rollCloseTx` and the phase Settling, so a `Harvest` in that transaction while the phase is
 * still Settling is the terminal one. The phase conjunction makes a second Harvest in the same
 * transaction — a `rollClose` and a `deposit` batched through a multicall, say — fall through to
 * the checkpoint branch, because the first terminal harvest already returned the vault to Idle.
 *
 * `retryStrandedClaim` emits `StrandedClaimRecovered` BEFORE its `_harvest()`, and that handler
 * stamps the strand row's `recoveredTx`, so a `Harvest` in that transaction is the retry's.
 * Everything else is a checkpoint: `_checkpointHarvest()` inside `deposit`, `mint` or
 * `settleQueue`, which emits only when premium has already landed.
 */
export function harvestOrigin(
  state: { rollCloseTx: Hex | null; phase: number },
  lastStrand: { recoveredTx: Hex | null } | null,
  txHash: Hex,
): HarvestOrigin {
  if (sameTx(state.rollCloseTx, txHash) && state.phase === PHASE.Settling) return "rollClose";
  if (lastStrand !== null && sameTx(lastStrand.recoveredTx, txHash)) return "retry";
  return "checkpoint";
}

export type CloseStatus = "stranded" | "assigned" | "closed" | "unfilled";

/**
 * The week's status at its terminal harvest.
 *
 * A stranded close is `stranded` whatever was sold or assigned: the claim's proceeds have not
 * arrived and the outcome is published when they do (`recoveredStatus`). Otherwise contracts
 * taken at the strike make the week `assigned`; a sale that expired out of the money `closed`;
 * and a week with no sale — the most likely one — `unfilled`, with every money column at zero.
 */
export function closeStatus(c: { stranded: boolean; sold: bigint; assigned: bigint }): CloseStatus {
  if (c.stranded) return "stranded";
  if (c.assigned > 0n) return "assigned";
  return c.sold > 0n ? "closed" : "unfilled";
}

/** The stranded week's status once `retryStrandedClaim` has redeemed the claim. A claim exists only if something sold. */
export function recoveredStatus(c: { assigned: bigint }): "assigned" | "closed" {
  return c.assigned > 0n ? "assigned" : "closed";
}

/*//////////////////////////////////////////////////////////////
                           QUEUE SETTLEMENT
//////////////////////////////////////////////////////////////*/

/**
 * The cycle a `QueueSettled` belongs to, or null when it settled outside a `rollClose`.
 *
 * `rollClose` emits `RollClose` before `_harvest()` and `_settleQueue()`, and the `RollClose`
 * handler stamps `rollCloseTx`, so a settlement in that same transaction is the closing week's.
 * `settleQueue()` runs while Idle with no week attached: the vault's `cycleNumber` there is
 * whatever week closed last, possibly months ago, and stamping it on the epoch would claim that
 * week settled a queue it never saw. Null is the schema's "not settled in a cycle".
 */
export function settlementCycle(
  state: { rollCloseTx: Hex | null; cycleNumber: number },
  txHash: Hex,
): number | null {
  if (!sameTx(state.rollCloseTx, txHash)) return null;
  return state.cycleNumber;
}

/*//////////////////////////////////////////////////////////////
                          STRANDED CLAIMS
//////////////////////////////////////////////////////////////*/

/**
 * The share of an epoch's stranded-claim WAD that one settling entry takes, exactly as
 * `Vault._settleEpochEntry` computes it: pro rata by shares against what the epoch still holds,
 * and the last claimant (`shares == sharesRemaining`) takes the rest so no WAD is left behind.
 * Both `sharesRemaining` and the epoch's WAD are the figures BEFORE this entry.
 */
export function entryStrandShare(
  epoch: { sharesSettled: bigint; sharesClaimed: bigint; strandWad: bigint; strandWadClaimed: bigint },
  shares: bigint,
): bigint {
  const w = epoch.strandWad > epoch.strandWadClaimed ? epoch.strandWad - epoch.strandWadClaimed : 0n;
  if (w === 0n) return 0n;
  const remaining = epoch.sharesSettled > epoch.sharesClaimed ? epoch.sharesSettled - epoch.sharesClaimed : 0n;
  if (remaining === 0n || shares >= remaining) return w;
  return (w * shares) / remaining;
}

export type StrandRecovery = {
  /** The queue's part of each leg, moved into the reserves at recovery. Floors, like `mulDiv`. */
  queueAssets: bigint;
  queueUsdg: bigint;
  /** The live shares' part: the NVDA is simply in the balance again, the USDG goes through the retry harvest fee-free. */
  liveAssets: bigint;
  liveUsdg: bigint;
};

/**
 * How `retryStrandedClaim` splits what the redeem returned between the settled epochs and the
 * live shares: `queueWad` (of 1e18) of each leg to the queue, the rest to live shares. The
 * retry's `Harvest` is then passed `usdgIn − queueUsdg` as its fee-free part, which is what
 * the handler needs to split that harvest into premium and strike proceeds.
 */
export function strandRecovery(assetsIn: bigint, usdgIn: bigint, queueWad: bigint): StrandRecovery {
  const queueAssets = (assetsIn * queueWad) / WAD;
  const queueUsdg = (usdgIn * queueWad) / WAD;
  return { queueAssets, queueUsdg, liveAssets: assetsIn - queueAssets, liveUsdg: usdgIn - queueUsdg };
}

/*//////////////////////////////////////////////////////////////
                              LISTINGS
//////////////////////////////////////////////////////////////*/

/**
 * The status a listing takes when it stops being live without having filled completely: a
 * partial fill is the better story than the cancellation that followed it.
 */
export function endedListingStatus(contractsFilled: bigint): "partially_filled" | "cancelled" {
  return contractsFilled > 0n ? "partially_filled" : "cancelled";
}

/*//////////////////////////////////////////////////////////////
                              CAPACITY
//////////////////////////////////////////////////////////////*/

/**
 * Contracts the vault could still write this cycle: `Policy.maxContracts(totalAssets) −
 * contractsWritten`, floored at zero. `maxContracts` is the smaller of the utilisation bound
 * (`totalAssets × maxUtilizationBps / 10_000` lots) and the compiled cap. There is no
 * `contractsRemaining` view under write on fill — inventory does not exist — so the API derives
 * this from `policy()`, `totalAssets()` and `contractsWritten()`.
 */
export function capacity(
  p: { maxUtilizationBps: number; maxContractsCap: bigint },
  totalAssets: bigint,
  contractsWritten: bigint,
  lot: bigint = WAD,
): bigint {
  const byUtilization = (totalAssets * BigInt(p.maxUtilizationBps)) / 10_000n / lot;
  const max = byUtilization < p.maxContractsCap ? byUtilization : p.maxContractsCap;
  return max > contractsWritten ? max - contractsWritten : 0n;
}
