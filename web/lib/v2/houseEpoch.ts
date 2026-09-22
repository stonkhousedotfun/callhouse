/**
 * House vault presentation maths. No API, chain, or React imports.
 *
 * Units, each read at the line cited and not retyped from plan prose:
 * - USDG 6 dp, Stock Tokens 18 dp — web/lib/v2/api-schema.ts:18-19
 * - timestamps unix seconds — web/lib/v2/api-schema.ts:25
 * - New York display — web/lib/v2/time.ts `stamp` (was duplicated inline in EarnMarket.tsx; UX item 8)
 * - shares 18 dp — callhouse-contracts src/v2/periphery/house/HouseVault.sol:36
 *   ("the Stock Token is 18 dp; rates are bps of BPS = 10_000. Shares are 18 dp."), read from a
 *   callhouse-contracts checkout on v8. The contracts submodule in this worktree is not populated,
 *   so this file does not claim to have read it from `contracts/`.
 *
 * Every HouseVault.sol line cited below was re-read at callhouse-contracts leekzor/v8
 * 0124b58e756568b239f7ad97acd1571add5b58a9 (T-546). The earlier citations (:440-445, :452-455,
 * :456-457, :388-389, :378) were struck against an older tree and had moved; the maths they
 * described has not, except where SEC-27 is named.
 *
 * NAV exists only at a boundary. This file exposes no function that builds a NAV, a share price or
 * any per-share value from a running-epoch input: both doors that could produce one — {navView} and
 * {inKindPreview} — take the same discriminated input and return {NAV_NOT_AVAILABLE} mid-epoch.
 */

import { stamp } from "./time";

export const USDG_DECIMALS = 6;
export const STOCK_DECIMALS = 18;
export const SHARE_DECIMALS = 18;
export { NEW_YORK_TIME_ZONE } from "./time";
export const NAV_NOT_AVAILABLE = "not available until the next boundary";

export type RunningEpochInput = { atBoundary: false };
export type BoundaryNavInput = { atBoundary: true; navUsdg: bigint };
export type NavInput = RunningEpochInput | BoundaryNavInput;

export type UnavailableNav = { available: false; message: typeof NAV_NOT_AVAILABLE };
export type BoundaryNav = { available: true; navUsdg: bigint };
export type NavView = UnavailableNav | BoundaryNav;

/** Mid-epoch callers get the message, never a number. */
export function navView(input: NavInput): NavView {
  if (!input.atBoundary) return { available: false, message: NAV_NOT_AVAILABLE };
  return { available: true, navUsdg: input.navUsdg };
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
  return `Your deposit joins at the next boundary (${formatNewYork(boundaryUnixSeconds)}).`;
}

/**
 * A boundary-time snapshot of everything {inKindPreview} needs.
 *
 * THE POOL FIGURES ARE NOT TOKEN BALANCES. HouseVault.rollEpoch:609-616 computes the pool it pays
 * withdrawals from as
 *     sat( usdg.balanceOf(vault) + clearinghouse.free(vault, usdg) + orderBook.owed(vault)
 *          − (pendingDepositUsdg + owedUsdg) )
 * where `sat(x − y)` is `x > y ? x − y : 0`, and the same shape for the Stock Token without the
 * book-owed term (:611-612, :614, :616), evaluated AFTER the performance fee is transferred to the
 * splitter (:574-591). The book-owed term is T-OP-073's and is in the pool for the same reason it
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
 *   stage 1, HouseVault.rollEpoch:617-618   wUsdg = mulDiv(poolUsdg, queueShares, supply)
 *   stage 2, HouseVault.claim:478-479       usdgOut = mulDiv(wUsdg, holderShares, queueShares)
 *
 * Composing two floors is not the same as flooring once: a single
 * `floor(poolUsdg * shares / totalShares)` is always greater than or equal to the composed value,
 * so a one-stage preview can promise more USDG than {claim} actually pays. Both stages are floored
 * here for the same reason the contract floors them — floor division can never overdraw the batch
 * (the comment at HouseVault.sol:467 says so in those terms for the deposit leg).
 *
 * THE RESIDUE DOES NOT STAY IN THE VAULT. Since SEC-27 (HouseVault.claim:482-503, landed by
 * T-SEC-P4-HOUSEVAULT 5c7ac72b) the batch is RUN DOWN IN STORAGE: each claim subtracts what it paid
 * from the batch's remaining USDG, stock and shares, so the LAST claimant of an epoch divides the
 * whole remainder by the whole remaining share count and receives the dust exactly. Two
 * consequences for this preview, both asserted in the test that walks both claim orders:
 *   1. stage 2 is EXACT for whoever claims first and a LOWER BOUND for everyone after — a later
 *      claimant can only receive more than previewed, never less, so the preview still never
 *      overstates;
 *   2. per-holder dust is still not returned, and is now not even a function of one holder's
 *      inputs: it depends on every other queued holder's share count AND on claim order.
 * `usdgLeftInVault` is unaffected: stage 1 (:617-618) still moves the whole `wUsdg` into the owed
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
