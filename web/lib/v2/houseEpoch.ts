/**
 * House vault presentation maths. No API, chain, or React imports.
 *
 * Units, each read at the line cited and not retyped from plan prose:
 * - USDG 6 dp, Stock Tokens 18 dp — web/lib/v2/api-schema.ts header, "USDG is 6 dp; Stock Tokens ... are 18 dp"
 * - timestamps unix seconds — web/lib/v2/api-schema.ts header, "Timestamps are unix SECONDS"
 * - New York display — web/lib/v2/time.ts `stamp` (was duplicated inline in EarnMarket.tsx; UX item 8)
 * - shares 18 dp — callhouse-contracts src/v2/periphery/house/HouseVault.sol, the contract NatSpec's UNITS
 *   paragraph ("the Stock Token is 18 dp; rates are bps of BPS = 10_000. Shares are 18 dp."), read from a
 *   callhouse-contracts source. The contracts submodule is not always checked out,
 *   so this file does not claim to have read it from `contracts/`.
 *
 * HouseVault.sol is cited below BY ANCHOR (function name plus the quoted expression), not by line
 * number: line citations were struck twice against older trees and had moved each time.
 * Every anchor was re-read against the contracts;
 * grep the quoted text to find it. The maths
 * has not moved, except where named below.
 *
 * NAV exists only at a boundary. This file exposes no function that builds a NAV, a share price or
 * any per-share value from a running-epoch input: both doors that could produce one — {navView} and
 * {inKindPreview} — take the same discriminated input and return {NAV_NOT_AVAILABLE} mid-epoch.
 */

import { stamp } from "./time";
import { houseIdle, type Cadence } from "./vaultCopy";

export const USDG_DECIMALS = 6;
export const STOCK_DECIMALS = 18;
export const SHARE_DECIMALS = 18;
export { NEW_YORK_TIME_ZONE } from "./time";
export const NAV_NOT_AVAILABLE = "shown after the next close";

export type RunningEpochInput = { atBoundary: false };
export type BoundaryNavInput = { atBoundary: true; navUsdg: bigint };
export type NavInput = RunningEpochInput | BoundaryNavInput;

export type UnavailableNav = { available: false; message: typeof NAV_NOT_AVAILABLE };
export type BoundaryNav = { available: true; navUsdg: bigint };
export type NavView = UnavailableNav | BoundaryNav;

/**
 * USDG base units per 1e18 shares from `HouseVault.nav()` and `totalSupply()`. `nav()` is the MARK at the
 * LAST BOUNDARY's settlement price (HouseVault.sol `_nav`), not a live price, so this is a boundary figure and every
 * caller must render it with `vaultMarkLabel`. Null when either input is missing or the supply is zero -- there is
 * no per-share figure of an empty vault, and a missing read is not 0.
 */
export function markPerShare(navUsdg: bigint | null, supply: bigint | null): bigint | null {
  if (navUsdg === null || supply === null || supply === 0n) return null;
  return (navUsdg * 10n ** BigInt(SHARE_DECIMALS)) / supply;
}

/** Mid-epoch callers get the message, never a number. */
export function navView(input: NavInput): NavView {
  if (!input.atBoundary) return { available: false, message: NAV_NOT_AVAILABLE };
  return { available: true, navUsdg: input.navUsdg };
}

/**
 * `previewBoundary` / `previewClaim` return `exact`. True only when the vault is flat
 * (no option, no live order, every tracked series settled): the preview is the roll. False means
 * open positions were valued as if they settled at the chosen price, so the number is an estimate.
 * A screen that shows those amounts uses this label. No screen calls the views yet.
 */
export function houseRollPreviewLabel(exact: boolean): string {
  return exact ? "what the next close pays" : "estimate; positions are still open";
}

export type EpochResult = {
  startNavUsdg: bigint;
  endNavUsdg: bigint;
  /** end − start, USDG base units. Negative is a losing epoch and is a first-class result. */
  resultUsdg: bigint;
};

/** Both NAVs are boundary figures supplied by the caller. */
export function epochResult(startNavUsdg: bigint, endNavUsdg: bigint): EpochResult {
  return { startNavUsdg, endNavUsdg, resultUsdg: endNavUsdg - startNavUsdg };
}

export function secondsUntilBoundary(nowUnixSeconds: number, boundaryUnixSeconds: number): number {
  if (!Number.isFinite(nowUnixSeconds) || !Number.isFinite(boundaryUnixSeconds)) {
    throw new Error("timestamps are unix seconds");
  }
  return Math.max(0, Math.trunc(boundaryUnixSeconds) - Math.trunc(nowUnixSeconds));
}

/**
 * Unix seconds in America/New_York.
 *
 * THE COMMENT THAT USED TO BE HERE WAS THE BUG REPORT: "Same formatter as EarnMarket.tsx:39".
 * It was right, and it stayed right through two moves of that line — the duplicate had drifted to
 * :43 by the time this was fixed. Both now call one implementation in `lib/v2/time.ts`. This stays
 * as a named re-export rather than being deleted so that every existing caller and its tests keep
 * working; the duplication is gone, the name is not.
 */
export const formatNewYork = stamp;

export function depositJoinsSentence(boundaryUnixSeconds: number): string {
  return `Your deposit joins at the next close (${formatNewYork(boundaryUnixSeconds)}).`;
}

/** "30 minutes": a window in words, whole minutes when exact (the House queue cutoff's copy). */
export function houseWindowWords(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * Queued deposits and withdrawal requests (and both cancels)
 * stop at `epochEnd - SETTLEMENT_WINDOW`: HouseVault.sol `_requireBeforeCutoff` reverts PastCutoff from there until
 * the roll. `settlementWindowS` is the chain's `SETTLEMENT_WINDOW()` read, never a literal here. Both are
 * priced at the same close. The weekday wording is a function of the vault's cadence, never a literal (vaultCopy.ts).
 */
export type CutoffSentences = { deposit: string; withdraw: string; idle: string };

export function cutoffSentences(cadence: Cadence, boundaryUnixSeconds: number, settlementWindowS: number): CutoffSentences {
  const at = formatNewYork(boundaryUnixSeconds);
  const cut = formatNewYork(boundaryUnixSeconds - settlementWindowS);
  return {
    deposit: cadence === "daily"
      ? `Deposit before ${cut} to be priced at today's close (${at}).`
      // The close time is the vault's own epochEnd, never "Fri 4:00 pm ET" (holiday weeks, early closes).
      : `Deposit before ${cut} to be priced at this week's close (${at}).`,
    withdraw: `Withdrawal requests are taken until ${cut}, ${houseWindowWords(settlementWindowS)} before the close, and are priced at that close.`,
    idle: houseIdle(cadence),
  };
}

/**
 * Mirrors keeper/src/v2/cranker/steps.ts `HOUSE_ROLL_OVERDUE_S` (7 h), the threshold the keeper pages
 * `v2_house_roll_overdue` at, so a user and an operator read the same fact. The web cannot import keeper code;
 * houseEpoch.test.ts reads the keeper file and fails if the two drift.
 */
export const HOUSE_ROLL_OVERDUE_S = 7 * 3_600;

export type BoundaryState = "open" | "waiting" | "held" | "overdue";

/**
 * HouseVault.UNPINNED_BOUNDARY_HOLD (private): how long past the close rollEpoch holds a boundary the vault
 * did not lock before money was exposed to it (`TooEarly(epochEnd + UNPINNED_BOUNDARY_HOLD)`). A declared mirror
 * (ops/v2/contract-mirrors.list.mjs), so a changed contract value turns the mirror guard red.
 */
export const UNPINNED_BOUNDARY_HOLD_S = 7 * 86_400;

/**
 * What the vault says about the running boundary's lock. `pinnedBoundary` is `pinnedBoundary()`; `exposed` is
 * shares or a queued deposit (totalSupply, pendingDepositUsdg, pendingDepositStock). Null = not read, never judged.
 */
export type BoundaryLock = { pinnedBoundary: number | null; exposed: boolean | null };

/** Whether money is exposed to the running boundary; null when any of the three reads failed. */
export function houseExposed(totalSupply: bigint | null | undefined, pendingDeposit: { usdg: bigint; stock: bigint } | null | undefined): boolean | null {
  if (totalSupply === null || totalSupply === undefined || pendingDeposit === null || pendingDeposit === undefined) return null;
  return totalSupply !== 0n || pendingDeposit.usdg !== 0n || pendingDeposit.stock !== 0n;
}

/** When a held boundary is processed: its close plus UNPINNED_BOUNDARY_HOLD_S. */
export const houseHeldUntil = (epochEndUnixSeconds: number): number => epochEndUnixSeconds + UNPINNED_BOUNDARY_HOLD_S;

/**
 * Before the close: open. From the close until 7 h past it: waiting for Finalized + the roll. After that: overdue.
 * A boundary money is exposed to that the vault did not lock (`pinnedBoundary != epochEnd`) is
 * `held` from the close until `houseHeldUntil`, because rollEpoch refuses until then; it is a known wait, not a late
 * close. Past the hold an unrolled boundary is overdue as before. Without a read `lock` nothing is held.
 */
export function boundaryState(nowUnixSeconds: number, epochEndUnixSeconds: number, lock?: BoundaryLock | null): BoundaryState {
  if (nowUnixSeconds < epochEndUnixSeconds) return "open";
  if (
    lock != null && lock.pinnedBoundary !== null && lock.exposed === true && lock.pinnedBoundary !== epochEndUnixSeconds
    && nowUnixSeconds < houseHeldUntil(epochEndUnixSeconds)
  ) return "held";
  return nowUnixSeconds > epochEndUnixSeconds + HOUSE_ROLL_OVERDUE_S ? "overdue" : "waiting";
}

/**
 * A boundary-time snapshot of everything {inKindPreview} needs.
 *
 * THE POOL FIGURES ARE NOT TOKEN BALANCES. HouseVault.rollEpoch (the `usdgPool` / `stockPool` block under
 * "WITHDRAWALS, in kind and pro rata") computes the pool it pays withdrawals from as
 *     sat( usdg.balanceOf(vault) + clearinghouse.free(vault, usdg) + orderBook.owed(vault)
 *          − (pendingDepositUsdg + owedUsdg) )
 * where `sat(x − y)` is `x > y ? x − y : 0`, and the same shape for the Stock Token without the
 * book-owed term (`stockPool = underlying.balanceOf(address(this)) + clearinghouse.free(...)`, then
 * `reservedStock = pendingDepositStock + owedStock`), evaluated AFTER the performance fee is transferred
 * to the splitter (the "PERFORMANCE FEE" block ending `usdg.safeTransfer(splitter, fee)`). The book-owed term is and is in the pool for the same reason it
 * is in `_nav`. Feeding this a bare `balanceOf` overstates the payout even at a boundary; leaving
 * the ledger or book-owed terms out understates it.
 * Mid-epoch it is worse than wrong: the vault also holds open ERC-1155 option positions, which no
 * pair of token balances describes — which is why there is no mid-epoch answer at all.
 */
export type BoundaryPoolInput = {
  atBoundary: true;
  /** The holder's own queued shares (HouseVault withdrawRequestOf[holder].shares). */
  shares: bigint;
  /** The whole withdraw queue at the boundary (HouseVault pendingWithdrawShares). */
  queueShares: bigint;
  /** Share supply the queue is floored against (HouseVault rollEpoch `supply`). */
  totalShares: bigint;
  /** Boundary-time, post-fee pool as defined above. */
  poolUsdg: bigint;
  poolStock: bigint;
};

export type InKindPreviewInput = RunningEpochInput | BoundaryPoolInput;

export type InKindUnavailable = { available: false; message: typeof NAV_NOT_AVAILABLE };

export type InKindAvailable = {
  available: true;
  /** What this holder receives, composed exactly as the contract composes it. */
  usdgOut: bigint;
  stockOut: bigint;
  /** Stage one: what the WHOLE queue's slice takes out of the pool. */
  queueUsdg: bigint;
  queueStock: bigint;
  /**
   * The pool minus the whole queue's slice — what the vault keeps for the shareholders who are NOT
   * withdrawing. This is deliberately not "the vault balance minus this one holder's slice", which
   * is what the previous field name `usdgRemaining` meant and which is wrong by orders of magnitude
   * for any holder who is not the entire queue.
   */
  usdgLeftInVault: bigint;
  stockLeftInVault: bigint;
};

export type InKindPreview = InKindUnavailable | InKindAvailable;

/**
 * In-kind withdrawal preview, floor-divided in bigint, mirroring the contract's TWO stages:
 *
 *   stage 1, HouseVault.rollEpoch   `wUsdg = Math.mulDiv(usdgPool, wShares, supply)`
 *   stage 2, HouseVault.claim       `payUsdg = Math.mulDiv(e.withdrawUsdg, w.shares, e.withdrawShares)`
 *
 * Composing two floors is not the same as flooring once: a single
 * `floor(poolUsdg * shares / totalShares)` is always greater than or equal to the composed value,
 * so a one-stage preview can promise more USDG than {claim} actually pays. Both stages are floored
 * here for the same reason the contract floors them — floor division can never overdraw the batch
 * (HouseVault.claim's deposit leg says so in those terms: "floor-divided against the batch, so rounding
 * dust stays with the pool and never overdraws it").
 *
 * THE RESIDUE DOES NOT STAY IN THE VAULT. Since a change to HouseVault.claim (the block headed "THE
 * BATCH IS RUN DOWN IN STORAGE"),
 * the batch is RUN DOWN IN STORAGE: each claim subtracts what it paid
 * from the batch's remaining USDG, stock and shares, so the LAST claimant of an epoch divides the
 * whole remainder by the whole remaining share count and receives the dust exactly. Two
 * consequences for this preview, both asserted in the test that walks both claim orders:
 *   1. stage 2 is EXACT for whoever claims first and a LOWER BOUND for everyone after — a later
 *      claimant can only receive more than previewed, never less, so the preview still never
 *      overstates;
 *   2. per-holder dust is still not returned, and is now not even a function of one holder's
 *      inputs: it depends on every other queued holder's share count AND on claim order.
 * `usdgLeftInVault` is unaffected: stage 1 (`owedUsdg += wUsdg` in rollEpoch) still moves the whole `wUsdg` into the owed
 * reserve, and what the vault keeps for the non-withdrawing shareholders is `poolUsdg − wUsdg`.
 */
export function inKindPreview(input: InKindPreviewInput): InKindPreview {
  if (!input.atBoundary) return { available: false, message: NAV_NOT_AVAILABLE };

  const { shares, queueShares, totalShares, poolUsdg, poolStock } = input;
  if (totalShares <= 0n) throw new Error("in-kind preview needs totalShares > 0");
  if (queueShares < 0n || queueShares > totalShares) {
    throw new Error("in-kind preview needs 0 ≤ queueShares ≤ totalShares");
  }
  if (shares < 0n || shares > queueShares) {
    throw new Error("in-kind preview needs 0 ≤ shares ≤ queueShares");
  }
  if (poolUsdg < 0n || poolStock < 0n) throw new Error("pool balances are non-negative");

  // rollEpoch pays nothing when the queue is empty (`if (wShares != 0 && supply != 0)`), and claim
  // pays nothing when the batch recorded no shares (`if (e.withdrawShares != 0)`).
  const queueUsdg = queueShares === 0n ? 0n : (poolUsdg * queueShares) / totalShares;
  const queueStock = queueShares === 0n ? 0n : (poolStock * queueShares) / totalShares;
  const usdgOut = queueShares === 0n ? 0n : (queueUsdg * shares) / queueShares;
  const stockOut = queueShares === 0n ? 0n : (queueStock * shares) / queueShares;

  return {
    available: true,
    usdgOut,
    stockOut,
    queueUsdg,
    queueStock,
    usdgLeftInVault: poolUsdg - queueUsdg,
    stockLeftInVault: poolStock - queueStock,
  };
}
