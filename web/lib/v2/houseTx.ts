/**
 * House vault write path. Every write goes through `simulatedWrite`/`approveExact` in
 * `web/lib/v2/tx.ts:30-71` — this module adds no transport of its own. (`lendTx.ts:35-49`
 * re-implements that transport; that predates this task and is left alone rather than
 * refactored under a build-mode directive, but do not copy it here.)
 *
 * THE VAULT ADDRESS COMES FROM THE API, NOT THE REGISTRY. HouseVault is deployed per market by
 * HouseVaultFactory, so there is no single `houseVault` key in the generated contract registry the
 * way there is for the Clearinghouse. `/v2/house/{market}` carries it as `vault` (`HouseMarketResponse`,
 * `web/lib/v2/api-types.ts:380-387`) and it is `null` until that market's vault is deployed. A null
 * vault blocks every write here with a reason rather than falling back to an address from anywhere else.
 *
 * MIRROR, DO NOT RE-REASON: the ABI is `houseVaultAbi`, generated from `ops/abis/v2/HouseVault.json`
 * by `web/scripts/gen-abis.mjs` (the `houseVault` row at `:310`, already present at this base — it is
 * not added by this task). No signature in this file is transcribed from Solidity or from an interface.
 */
import { isAddress, type Address, type Hex } from "viem";

import { houseVaultAbi } from "../abi/v2/houseVault";
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
 * Walks the same cause chain `explainV2Error` walks and returns copy for an OZ error, or null.
 * Returning null — rather than a generic string — is what lets the caller fall through to
 * `V2WriteError`, whose message is already `explainV2Error`'s. A blanket string here would mask
 * every v2 error this vault shares with the rest of the protocol.
 */
export function explainHouseOzError(error: unknown): string | null {
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
      if (name && name in HOUSE_OZ_ERROR_TEXT) return HOUSE_OZ_ERROR_TEXT[name]!;
    }
    cause = value.cause;
  }
  return null;
}

/** Re-throws with OZ copy when the revert is one `explainV2Error` cannot name, otherwise untouched. */
async function withHouseErrorCopy<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const oz = explainHouseOzError(error);
    if (oz) throw new Error(oz, { cause: error });
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

/** Cancel this wallet's own queued deposit. The ABI takes the account explicitly. */
export async function cancelHouseDepositRequest(context: WriteContext, vault: string | null | undefined): Promise<Hex> {
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() =>
    simulatedWrite(context, address, houseVaultAbi, "cancelDepositRequest", [context.account]));
}

/** Queue a withdrawal of `shares` (18 dp). It is paid in kind at the boundary, not now. */
export async function requestHouseWithdraw(
  context: WriteContext, vault: string | null | undefined, shares: bigint,
): Promise<Hex> {
  if (shares <= 0n) throw new Error("Enter a positive share amount.");
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() =>
    simulatedWrite(context, address, houseVaultAbi, "requestWithdraw", [shares]));
}

export async function cancelHouseWithdrawRequest(context: WriteContext, vault: string | null | undefined): Promise<Hex> {
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() =>
    simulatedWrite(context, address, houseVaultAbi, "cancelWithdrawRequest", []));
}

/** Collect a settled withdrawal batch: the in-kind USDG and stock slice for this wallet. */
export async function claimHouseWithdrawal(context: WriteContext, vault: string | null | undefined): Promise<Hex> {
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() => simulatedWrite(context, address, houseVaultAbi, "claim", []));
}

/** Collect what the vault owes this wallet but could not pay at the boundary. */
export async function claimHouseOwed(context: WriteContext, vault: string | null | undefined): Promise<Hex> {
  const address = requireHouseVaultAddress(vault);
  return withHouseErrorCopy(() => simulatedWrite(context, address, houseVaultAbi, "claimOwed", []));
}

/*
 * T-133 NOTE, not a T-136 edit made quietly: the five functions above are `async` as of T-133.
 * They were plain functions, so their guards threw SYNCHRONOUSLY while `requestHouseDeposit` rejected
 * — a caller writing `claimHouseOwed(...).catch(...)` got an uncaught throw. The same shape recurred
 * in `lenderRewards.ts` and was caught there by its own test; both are fixed the same way.
 */
