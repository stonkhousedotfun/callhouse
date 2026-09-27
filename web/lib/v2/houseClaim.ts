/**
 * Whether this wallet has anything HouseVault.claim() would pay, and what the page says when it has not.
 *
 * MIRROR, DO NOT RE-REASON. `claim()` (callhouse-contracts src/v2/periphery/house/HouseVault.sol, the `retired` test at
 * its end) succeeds only when it retires a MATURED request: a queued deposit (`usdg != 0 || stock != 0`) or a queued
 * withdrawal (`shares != 0`) whose `epochId` is BEFORE the vault's current `epochId`. Anything else reverts `BadUnits`,
 * which the shared error copy reads as "Enter a positive quantity in 0.01 share steps." (errors.ts). A fork run measured
 * exactly that on a v9 fork: a withdrawal requested in the current epoch, claimed before its close, got that sentence;
 * after the close the same click paid.
 *
 * So "has a pending request" is NOT "claimable": a request queued in the current epoch is pending and not claimable,
 * which is the case that failed. Both legs count, because `claim()` retires either one; a matured deposit is collected
 * by the same call.
 *
 * FAIL CLOSED. The three reads come from the page's vault multicall (chainReads.readHouseVault). Unread (the query in
 * flight) and unreadable (a failed call) both keep the button disabled and say so; neither is taken to mean ready.
 */
import { fmtAsset, fmtShares, fmtUsdg } from "../format";
import type { HouseVaultReads } from "./chainReads";
import { formatNewYork } from "./houseEpoch";

export type HouseClaimState =
  /** The reads have not answered yet (or there is no wallet). */
  | { kind: "unread" }
  /** A read failed: the page cannot tell. */
  | { kind: "unknown" }
  /** No queued deposit or withdrawal at all. */
  | { kind: "none" }
  /** Something is queued in the current epoch; it matures at that epoch's close. */
  | { kind: "pending" }
  /** A matured request exists: `claim()` retires it. */
  | { kind: "ready" };

type ClaimReads = Pick<HouseVaultReads, "epochId" | "withdrawRequest" | "depositRequest">;

/** `claim()`'s own test, on the chain's answers. Pure. */
export function houseClaimState(reads: ClaimReads | null | undefined): HouseClaimState {
  if (!reads) return { kind: "unread" };
  const { epochId, withdrawRequest, depositRequest } = reads;
  if (epochId === undefined || withdrawRequest === undefined || depositRequest === undefined) return { kind: "unread" };
  if (epochId === null || withdrawRequest === null || depositRequest === null) return { kind: "unknown" };
  const withdrawQueued = withdrawRequest.shares !== 0n;
  const depositQueued = depositRequest.usdg !== 0n || depositRequest.stock !== 0n;
  if ((withdrawQueued && withdrawRequest.epochId < epochId) || (depositQueued && depositRequest.epochId < epochId))
    return { kind: "ready" };
  return withdrawQueued || depositQueued ? { kind: "pending" } : { kind: "none" };
}

/** The claim revert's own words, for `BadUnits` from `claim()` only (houseTx.claimHouseWithdrawal). */
export const HOUSE_CLAIM_NOTHING_READY = "Nothing is ready to claim yet; it pays after the next close.";

/**
 * The line under a DISABLED claim button: why it is disabled and when that changes. Null when the button is enabled.
 * `epochEnd` is the current epoch's end from /v2/house (the close a pending request matures at); `now` is the page's
 * clock, used only to tell a close that is still ahead from one that is due.
 */
export function houseClaimLine(state: HouseClaimState, epochEnd: number | null, now: number): string | null {
  switch (state.kind) {
    case "ready":
      return null;
    case "unread":
      return "Checking whether anything is ready to claim.";
    case "unknown":
      return "Could not read your queued requests from the vault. Refresh to check again.";
    case "none":
      return "Nothing to claim. A withdrawal you request is claimable after the close that follows it.";
    case "pending":
      if (epochEnd === null) return "Claimable after this epoch closes.";
      if (now < epochEnd) return `Claimable after this epoch closes at ${formatNewYork(epochEnd)}.`;
      return "This epoch's close is due. Claimable as soon as the vault records it.";
  }
}

/*//////////////////////////////////////////////////////////////
          WHAT claim() PAYS, FROM THE VAULT'S OWN QUOTE
//////////////////////////////////////////////////////////////*/

/**
 * What `claim()` pays one account, in base units: shares (18 dp), USDG (6 dp), Stock Tokens (18 dp). Named like the
 * vault's `Claimed` event and `claim()`'s return (`shares`, `usdgAmount`, `stockAmount`).
 *
 * MIRROR, DO NOT RE-REASON. HouseVault.sol has `_claimQuote`, ONE private
 * computation that decides what a claim pays, exposed three ways: the view `claimable(account)`, the return value of
 * `claim()`, and the `Claimed` event. The page reads those, never a figure assembled from events or epoch rates: the
 * rates are run down by every claim and the last claimant of a batch takes its remainder, so no
 * client-side division reproduces the quote.
 */
export type HouseClaimAmounts = { shares: bigint; usdg: bigint; stock: bigint };

/** A `(shares, usdgAmount, stockAmount)` triple as viem decodes it (claimable's result, claim()'s return), or null. */
export function houseClaimAmounts(result: unknown): HouseClaimAmounts | null {
  if (!Array.isArray(result) || result.length !== 3) return null;
  const [shares, usdg, stock] = result as unknown[];
  if (typeof shares !== "bigint" || typeof usdg !== "bigint" || typeof stock !== "bigint") return null;
  return { shares, usdg, stock };
}

/** "1.5 shares, 12.34 USDG and 0.25 Stock Tokens": the non-zero legs only. Null when every leg is zero. */
export function houseClaimAmountsText(amounts: HouseClaimAmounts): string | null {
  const legs: string[] = [];
  if (amounts.shares !== 0n) legs.push(`${fmtShares(amounts.shares)} shares`);
  if (amounts.usdg !== 0n) legs.push(`${fmtUsdg(amounts.usdg)} USDG`);
  if (amounts.stock !== 0n) legs.push(`${fmtAsset(amounts.stock)} Stock Tokens`);
  if (legs.length === 0) return null;
  return legs.length === 1 ? legs[0]! : `${legs.slice(0, -1).join(", ")} and ${legs[legs.length - 1]}`;
}

/** The sentence for a matured request the vault quotes at zero: claim() still has to be sent (see the line below). */
export const HOUSE_CLAIM_PAYS_NOTHING =
  "Your request priced to zero at the close, so the claim pays nothing. Claim it anyway: that clears the request so you can queue again.";

/**
 * The sentence before the amount when the close REFUSED the matured deposit (HouseVault `epochRates`
 * `depositRefused`). `claim()` then returns the deposit as it was queued, so the USDG or Stock Tokens it pays
 * are that deposit coming back, not a withdrawal and not a loss of the shares the deposit would have bought.
 */
export const HOUSE_CLAIM_DEPOSIT_REFUSED =
  "The close refused your deposit, so the claim returns it as you queued it instead of minting shares.";

/**
 * The line NEXT TO an enabled claim button: what `claim()` would pay now, from `claimable(account)`.
 *
 * IT NEVER GATES THE BUTTON. A matured request can price to zero --
 * `claimable` answers (0, 0, 0) -- and `claim()` must still be sent, because HouseVault `requestDeposit` and
 * `requestWithdraw` refuse `TooEarly` until it retires that request. The button follows {houseClaimState}; this only
 * says what the click pays.
 *
 * Null when the button is not ready, or the view was not read: without an account, on a failed call, and on a vault
 * that predates (no `claimable`, so the call fails). Nothing is shown then, never a guessed amount.
 *
 * `depositRefused` is chainReads' `depositRefused`: only an explicit true adds
 * {HOUSE_CLAIM_DEPOSIT_REFUSED}; null (unread, or no matured deposit) says nothing about a refusal.
 */
export function houseClaimAmountLine(
  state: HouseClaimState, amounts: HouseClaimAmounts | null | undefined, depositRefused?: boolean | null,
): string | null {
  if (state.kind !== "ready" || !amounts) return null;
  const text = houseClaimAmountsText(amounts);
  if (text === null) return HOUSE_CLAIM_PAYS_NOTHING;
  return depositRefused === true ? `${HOUSE_CLAIM_DEPOSIT_REFUSED} Claim pays ${text}.` : `Claim pays ${text}.`;
}

/**
 * The notice after a confirmed claim. `paid` is the receipt's `Claimed` log (what the chain paid); `quoted` is
 * `claim()`'s return from the pre-send simulation, used when the receipt could not be read. Either way the claim
 * happened, so a missing figure never turns this into an error.
 */
export function houseClaimDoneLine(result: { paid: HouseClaimAmounts | null; quoted: HouseClaimAmounts | null }): string {
  const amounts = result.paid ?? result.quoted;
  if (amounts === null) return "Claim confirmed.";
  const text = houseClaimAmountsText(amounts);
  if (text === null) return "Claim confirmed. It paid nothing and cleared your matured request.";
  return result.paid !== null ? `Claim confirmed. It paid ${text}.` : `Claim confirmed. The vault quoted ${text} when you sent it.`;
}
