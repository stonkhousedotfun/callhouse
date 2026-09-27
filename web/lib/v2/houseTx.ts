/**
 * House vault write path. Every write goes through `simulatedWrite`/`approveExact` in
 * `web/lib/v2/tx.ts` — this module adds no transport of its own. (`lendTx.ts`'s private `write`
 * re-implements that transport; that predates this task and is left alone rather than
 * refactored under a build-mode directive, but do not copy it here.) Cited by symbol, not line
 * the line numbers had moved.
 *
 * THE VAULT ADDRESS COMES FROM THE API, NOT THE REGISTRY. HouseVault is deployed per market by
 * HouseVaultFactory, so there is no single `houseVault` key in the generated contract registry the
 * way there is for the Clearinghouse. `/v2/house/{market}` carries it as `vault` (`HouseMarketResponse`
 * in `web/lib/v2/api-types.ts`) and it is `null` until that market's vault is deployed. A null
 * vault blocks every write here with a reason rather than falling back to an address from anywhere else.
 *
 * MIRROR, DO NOT RE-REASON: the ABI is `houseVaultAbi`, generated from `ops/abis/v2/HouseVault.json`
 * by `web/scripts/gen-abis.mjs` (its `name: "houseVault"` row, already present at this base — it is
 * not added by this task). No signature in this file is transcribed from Solidity or from an interface.
 */
import { isAddress, parseEventLogs, parseUnits, type Address, type Hex, type Log, type PublicClient } from "viem";

import { houseVaultAbi } from "../abi/v2/houseVault";
import { publicClient } from "../chain";
import { v2ErrorName, type V2ErrorName } from "./errors";
import { HOUSE_CLAIM_NOTHING_READY, houseClaimAmounts, type HouseClaimAmounts } from "./houseClaim";
import { SHARE_DECIMALS } from "./houseEpoch";
import { approveExact, simulatedWrite, type WriteContext } from "./tx";

/**
 * OpenZeppelin errors that HouseVault can revert with and that `explainV2Error` CANNOT decode.
 *
 * `V2ErrorName` is derived from the generated `v2ErrorsAbi`, which is generated from
 * `ops/abis/v2/V2Errors.json` — the SHARED v2 error set. Every HouseVault error that is in that set
 * (BadExpiry, BadPrice, BadUnits, CeilingExceeded, NoSource, NotAuthorized, NotSettled, OrderNotLive,
 * OutflowCapExceeded, PastCutoff, TooEarly, TradingPaused, UnknownSeries, UnsupportedAsset) already has
 * copy in `V2_ERROR_TEXT`, so this task adds nothing there. The eleven below are OZ's own, they are in
 * `HouseVault.json` but NOT in `V2Errors.json`, and widening `Record<V2ErrorName, string>` to reach them
 * is exactly what `errors.ts:44` forbids. They are mapped here instead, against the generated ABI.
 *
 * Only the first two are reachable by a depositor in normal use; the rest are here so that an operator
 * reading a support ticket gets the name rather than the generic fallback.
 */
const HOUSE_OZ_ERROR_TEXT: Record<string, string> = {
  ERC20InsufficientAllowance: "This vault is not approved to move that much. Approve the exact amount and try again.",
  ERC20InsufficientBalance: "Your wallet does not have enough of this token for that deposit.",
  ERC20InvalidApprover: "That approval came from an address the token rejects.",
  ERC20InvalidReceiver: "That recipient address is not one the token accepts.",
  ERC20InvalidSender: "That sender address is not one the token accepts.",
  ERC20InvalidSpender: "That spender address is not one the token accepts.",
  SafeERC20FailedOperation: "The token transfer failed. Check the token's balance and allowance and try again.",
  ReentrancyGuardReentrantCall: "This vault is already mid-transaction. Wait for it to finish and try again.",
  AccessManagedUnauthorized: "This wallet is not authorized for that vault action.",
  AccessManagedInvalidAuthority: "The vault's role authority is misconfigured. Wait for the market operator to fix it.",
  AccessManagedRequiredDelay: "That vault action is time-locked and is not executable yet.",
};

/** The ABI error names this module can name, exported so a test can assert the set has not drifted. */
export const HOUSE_OZ_ERROR_NAMES = Object.keys(HOUSE_OZ_ERROR_TEXT);

/**
 * `requestWithdraw` moves the caller's SHARES into the vault
 * (HouseVault.sol `_transfer(msg.sender, address(this), shares)`), so its `ERC20InsufficientBalance` means the wallet
 * holds fewer shares than it asked to withdraw, not that it lacks a deposit token. Only that call reads this; every
 * other call keeps {@link HOUSE_OZ_ERROR_TEXT}.
 */
export const HOUSE_WITHDRAW_OVER_BALANCE =
  "This wallet holds fewer shares of this vault than that. Enter at most your share balance.";
const HOUSE_WITHDRAW_OZ_ERROR_TEXT: Readonly<Record<string, string>> = {
  ERC20InsufficientBalance: HOUSE_WITHDRAW_OVER_BALANCE,
};

/**
 * Walks the same cause chain `explainV2Error` walks and returns copy for an OZ error, or null.
 * Returning null — rather than a generic string — is what lets the caller fall through to
 * `V2WriteError`, whose message is already `explainV2Error`'s. A blanket string here would mask
 * every v2 error this vault shares with the rest of the protocol.
 */
export function explainHouseOzError(error: unknown, overrides: Readonly<Record<string, string>> = {}): string | null {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    const value = cause as { data?: unknown; errorName?: unknown; cause?: unknown };
    const named = typeof value.errorName === "string" ? value.errorName : undefined;
    const decoded = value.data as { errorName?: unknown } | null;
    const fromData = decoded && typeof decoded === "object" && typeof decoded.errorName === "string"
      ? decoded.errorName : undefined;
    for (const name of [named, fromData]) {
      if (name && name in overrides) return overrides[name]!;
      if (name && name in HOUSE_OZ_ERROR_TEXT) return HOUSE_OZ_ERROR_TEXT[name]!;
    }
    cause = value.cause;
  }
  return null;
}

/**
 * The shared PastCutoff text is about a series' mint cutoff. From this vault it means the queue has closed for
 * this close (requests and cancels stop at `epochEnd - SETTLEMENT_WINDOW`; depositNow at `epochEnd`).
 */
export const HOUSE_PAST_CUTOFF = "The vault has stopped taking this for the current close. It reopens when the vault starts its next epoch.";

/**
 * Re-throws with OZ copy when the revert is one `explainV2Error` cannot name, House copy for PastCutoff, otherwise
 * untouched. `overrides` re-words an OZ error for one call whose meaning differs (requestWithdraw's share balance).
 */
async function withHouseErrorCopy<T>(
  run: () => Promise<T>, overrides: Readonly<Record<string, string>> = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const oz = explainHouseOzError(error, overrides);
    if (oz) throw new Error(oz, { cause: error });
    if (v2ErrorName(error) === "PastCutoff") throw new Error(HOUSE_PAST_CUTOFF, { cause: error });
    throw error;
  }
}

/**
 * The vault address for a market, taken from `/v2/house/{market}`.
 *
 * `null` in, `null` out, and a value that is not an address is `null` too rather than being cast:
 * a malformed address reaching `simulateContract` produces a viem error about the address, which
 * reads as a chain problem and is not one.
 */
export function houseVaultAddress(vault: string | null | undefined): Address | null {
  if (!vault || !isAddress(vault)) return null;
  return vault;
}

export function requireHouseVaultAddress(vault: string | null | undefined): Address {
  const address = houseVaultAddress(vault);
  if (!address) throw new Error("This market's house vault is not deployed yet.");
  return address;
}

/**
 * Queue a deposit, approving the EXACT shortfall first.
 *
 * `approveExact` (`tx.ts:59-71`) reads balance and allowance, throws when the balance is short, and
 * approves `required` only when the current allowance does not already cover it — never an unlimited
 * allowance, and never a top-up computed here. `requestDeposit` queues; it does not mint shares. The
 * deposit joins at the next boundary and is valued there.
 */
export async function requestHouseDeposit(
  context: WriteContext, vault: string | null | undefined, asset: Address, amount: bigint,
): Promise<Hex> {
  if (amount <= 0n) throw new Error("Enter a positive deposit.");
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(async () => {
    await approveExact(context, asset, address, amount);
    return simulatedWrite(context, address, houseVaultAbi, "requestDeposit", [asset, amount]);
  });
}

/*//////////////////////////////////////////////////////////////
        INSTANT USDG DEPOSITS (v9)
//////////////////////////////////////////////////////////////*/

/**
 * Whether a USDG deposit of `amount` mints shares NOW, answered by the vault itself.
 * `previewDepositNow(amount)` returns the shares `depositNow` would mint for that amount. That count is
 * exact, including settled positions the vault would redeem before pricing. A return is the instant path and carries
 * the share count.
 *
 * A v2 revert is the queue path, and the refusal's name rides along. The not-exact state is one of those
 * reverts, not a share count: an ITM call the Clearinghouse would convert has no price a view can know, so the vault
 * reverts `NoSource` (or `StaleSpot` from the spot read it makes first). `depositNow` may still mint on a fresh spot.
 * This function does not label that "now" and does not return shares. Nothing here guesses the path from other vault
 * fields. Named refusals include PastCutoff, NotSettled, NoSource, StaleSpot, InsufficientCollateral, FeeAboveMax
 * and BadUnits.
 *
 * A read that fails for any OTHER reason (RPC down, no decodable revert) THROWS: "could not ask" is not "it queues".
 */
export type HouseDepositRoute = { instant: true; shares: bigint } | { instant: false; refusal: V2ErrorName };

export async function previewHouseDepositNow(
  vault: string | null | undefined, amount: bigint, client: PublicClient = publicClient,
): Promise<HouseDepositRoute> {
  if (amount <= 0n) throw new Error("Enter a positive deposit.");
  const address = requireHouseVaultAddress(vault);
  try {
    const shares = await client.readContract({ address, abi: houseVaultAbi, functionName: "previewDepositNow", args: [amount] });
    return { instant: true, shares };
  } catch (error) {
    const refusal = v2ErrorName(error);
    if (refusal) return { instant: false, refusal };
    throw new Error("Could not ask the vault whether this deposit mints now. Try again.", { cause: error });
  }
}

/**
 * The fewest shares `depositNow` may mint for a preview of `previewShares`: one basis point below it. The contract prices
 * the mint at floor(received x supply / cashNav) at send time, and another instant deposit landing first can move that
 * floor by rounding; a worse price than this reverts `BadPrice` and nothing is taken.
 */
export function minSharesFor(previewShares: bigint): bigint {
  return previewShares - previewShares / 10_000n;
}

/** The shares minted to `account` by THIS vault's `DepositedNow` log in a receipt; null when there is no such log. */
export function depositedNowSharesFrom(receipt: { logs: Log[] }, vault: Address, account: Address): bigint | null {
  const events = parseEventLogs({ abi: houseVaultAbi, eventName: "DepositedNow", logs: receipt.logs, strict: false });
  const mine = events.find((e) => e.address.toLowerCase() === vault.toLowerCase()
    && typeof e.args?.account === "string" && e.args.account.toLowerCase() === account.toLowerCase());
  const shares = mine?.args && "shares" in mine.args ? mine.args.shares : undefined;
  return typeof shares === "bigint" ? shares : null;
}

/**
 * Deposit USDG and mint shares in this transaction (`depositNow`), approving the EXACT amount first. `minShares` comes
 * from {minSharesFor} over a fresh {previewHouseDepositNow}. Returns the hash and the shares the receipt's
 * `DepositedNow` log reports (null when the receipt could not be read: the deposit still happened).
 */
export async function depositHouseNow(
  context: WriteContext, vault: string | null | undefined, usdg: Address, amount: bigint, minShares: bigint,
): Promise<{ hash: Hex; shares: bigint | null }> {
  if (amount <= 0n) throw new Error("Enter a positive deposit.");
  if (minShares <= 0n) throw new Error("This deposit would mint no shares.");
  const address = requireHouseVaultAddress(vault);
  let shares: bigint | null = null;
  const hash = await withHouseErrorCopy(async () => {
    await approveExact(context, usdg, address, amount);
    return simulatedWrite(context, address, houseVaultAbi, "depositNow", [amount, minShares], (receipt) => {
      shares = depositedNowSharesFrom(receipt, address, context.account);
    });
  });
  return { hash, shares };
}

/** Cancel this wallet's own queued deposit. The ABI takes the account explicitly. */
export async function cancelHouseDepositRequest(context: WriteContext, vault: string | null | undefined): Promise<Hex> {
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() =>
    simulatedWrite(context, address, houseVaultAbi, "cancelDepositRequest", [context.account]));
}

/**
 * The withdraw box's amount: whole shares as typed, in {@link SHARE_DECIMALS} (18) base units; null unless it parses
 * and is positive. The House vault's first mint pays 10 ** (18 - USDG decimals) shares per USDG
 * base unit, so a whole share starts at about one USDG and "50" asks for 50e18 shares, about 50 USDG at par.
 */
export function parseHouseWithdrawShares(raw: string): bigint | null {
  try {
    const amount = parseUnits(raw, SHARE_DECIMALS);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

/** Queue a withdrawal of `shares` (18 dp). It is paid in kind at the boundary, not now. */
export async function requestHouseWithdraw(
  context: WriteContext, vault: string | null | undefined, shares: bigint,
): Promise<Hex> {
  if (shares <= 0n) throw new Error("Enter a positive share amount.");
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() =>
    simulatedWrite(context, address, houseVaultAbi, "requestWithdraw", [shares]), HOUSE_WITHDRAW_OZ_ERROR_TEXT);
}

export async function cancelHouseWithdrawRequest(context: WriteContext, vault: string | null | undefined): Promise<Hex> {
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() =>
    simulatedWrite(context, address, houseVaultAbi, "cancelWithdrawRequest", []));
}

/**
 * What the receipt's `Claimed` log says `claim()` paid `account` from `vault` (the vault emits the same three
 * values `claim()` returns). Null when there is no such log or it cannot be read.
 */
export function claimedFrom(receipt: { logs: Log[] }, vault: Address, account: Address): HouseClaimAmounts | null {
  const events = parseEventLogs({ abi: houseVaultAbi, eventName: "Claimed", logs: receipt.logs, strict: false });
  const mine = events.filter((e) => e.address.toLowerCase() === vault.toLowerCase()
    && typeof e.args?.account === "string" && e.args.account.toLowerCase() === account.toLowerCase());
  if (mine.length !== 1) return null;
  const args = mine[0]!.args as { shares?: unknown; usdgAmount?: unknown; stockAmount?: unknown };
  return houseClaimAmounts([args.shares, args.usdgAmount, args.stockAmount]);
}

export type HouseClaimResult = {
  hash: Hex;
  /** The receipt's `Claimed` log: what the chain paid. Null when the receipt could not be read (the claim still happened). */
  paid: HouseClaimAmounts | null;
  /** `claim()`'s own return from the simulation just before sending. Null when it did not decode. */
  quoted: HouseClaimAmounts | null;
};

/**
 * Collect whatever a past close decided for this wallet: shares from a priced deposit, a refused deposit back in kind,
 * and the in-kind USDG and stock slice of a settled withdrawal (HouseVault.claim).
 *
 * `claim()` refuses `BadUnits` when it has no MATURED request to retire (HouseVault.sol, the refusal at the
 * end of `claim`), which is "nothing is ready yet", not a quantity error. The shared text for BadUnits is about
 * quantities and is right for every other call, so only this call's BadUnits is re-worded (houseClaim.ts).
 *
 * `claim()` returns `(shares, usdgAmount, stockAmount)`; the simulation's decoded return is
 * `quoted`, and the receipt's `Claimed` log is `paid`.
 */
export async function claimHouseWithdrawal(context: WriteContext, vault: string | null | undefined): Promise<HouseClaimResult> {
  const address = requireHouseVaultAddress(vault);
  let paid: HouseClaimAmounts | null = null;
  let quoted: HouseClaimAmounts | null = null;
  try {
    const hash = await withHouseErrorCopy(() => simulatedWrite(context, address, houseVaultAbi, "claim", [],
      (receipt) => { paid = claimedFrom(receipt, address, context.account); },
      (result) => { quoted = houseClaimAmounts(result); }));
    return { hash, paid, quoted };
  } catch (error) {
    if (v2ErrorName(error) === "BadUnits") throw new Error(HOUSE_CLAIM_NOTHING_READY, { cause: error });
    throw error;
  }
}

/*
 * NO wrapper for HouseVault.claimOwed(), on purpose. It is `restricted` to QUOTER (callhouse-contracts
 * HouseVault.claimOwed; roles.v8.json HouseVault "claimOwed()": "QUOTER"), so from a depositor's wallet it can only
 * revert, and what it moves is the order book's debt to the VAULT, not anything owed to the caller. The old wrapper
 * here said "what the vault owes this wallet", which was wrong. rollEpoch pulls it permissionlessly
 * (its best-effort orderBook.claimOwed) and the keeper's QUOTER sends it (keeper/src/v2/mm/planner.ts:774, quoter.ts:1220).
 */

/*
 * NOTE, not a edit made quietly: the four functions above after requestHouseDeposit are `async` as of
 * (five until the claimOwed wrapper was removed).
 * They were plain functions, so their guards threw SYNCHRONOUSLY while `requestHouseDeposit` rejected
 * — a caller writing `claimHouseWithdrawal(...).catch(...)` got an uncaught throw. The same shape recurred
 * in `lenderRewards.ts` and was caught there by its own test; both are fixed the same way.
 */
