import { BaseError, decodeErrorResult, type Abi, type Hex } from "viem";

import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { earnVaultAbi } from "../abi/v2/earnVault";
import { v2ErrorsAbi } from "../abi/v2/v2Errors";

export type V2ErrorName = (typeof v2ErrorsAbi)[number]["name"];

/** Every frozen v2 custom error has copy a buyer can act on. */
export const V2_ERROR_TEXT = {
  AlreadyFinal: "This settlement is already final.",
  // Only the Admin Safe's first-listing calls raise it; no buyer write reaches one.
  AlreadyListed: "This market is already set up. A change to it goes through its delayed setting, not a new listing.",
  AlreadySettled: "This series has already settled.",
  BadExpiry: "Choose a valid market expiry.",
  BadPrice: "Enter a price on the market's price tick.",
  BadStrike: "Choose a strike on the market's strike tick, between half and double the current price.",
  BadUnits: "Enter a positive quantity in 0.01 share steps.",
  BelowMinUnits: "The available order size is below your minimum fill. Refresh the book and try again.",
  CapExceeded: "This action exceeds the current protocol cap. Reduce the amount and try again.",
  CeilingExceeded: "This market has reached its position limit.",
  CooldownActive: "This action is still cooling down. Wait until it becomes available and try again.",
  CreatePaused: "New series creation is paused.",
  DeadlinePassed: "This quote expired. Refresh it and try again.",
  FeeAboveMax: "Fees moved above the maximum you approved. Refresh and review the updated fees before trying again.",
  InTheMoney: "This ask is at or in the money. Withdraw it and wait for the next expiry before rolling.",
  OutflowCapExceeded: "The vault has reached its spending limit. Wait for capacity to refill or reduce the trade size.",
  InsufficientCollateral: "There is not enough free collateral for this order.",
  MarketDisabled: "This market is currently unavailable.",
  MintPaused: "New positions are paused for this market.",
  NoSource: "A settlement price source is unavailable. Try again later.",
  NotAuthorized: "This wallet is not authorized for that action.",
  NotExpired: "This series has not expired yet.",
  NotMinter: "This contract is not allowed to create new positions. Try again after the market operator updates it.",
  NotSettled: "Settlement has not finished yet.",
  OrderNotLive: "An order has changed or expired. Refresh the book before trading.",
  OutsideRegularSession: "This action is only available during the regular market session.",
  PastCutoff: "The mint cutoff has passed for this series.",
  PinMismatch: "The settlement price source has changed. Wait for the market operator to restore it.",
  ResolveOutOfBand: "The proposed settlement price is outside the permitted range.",
  RouteRejected: "The payout conversion route was rejected. Choose in-kind payout or try again after the route is fixed.",
  SeriesIdCollision: "This series conflicts with an existing series. Contact support.",
  SourceNotPinned: "A settlement price source is unavailable for this expiry. New series cannot be created until the market operator fixes it.",
  StaleSpot: "The underlying price is stale. Wait for a fresh quote.",
  ThirdPartyRedeemDisabled: "The holder has disabled third-party redemption.",
  TooEarly: "This action is not available yet.",
  TradingPaused: "Trading is temporarily paused.",
  UnknownSeries: "This series is not registered yet.",
  UnsupportedAsset: "This asset is not supported by this market.",
} as const satisfies Record<V2ErrorName, string>;

/**
 * OpenZeppelin errors a trading write can revert with that V2Errors does not carry. They come from the
 * Clearinghouse's ERC-1155 (a close, or a resale ask's escrow, moving more option units than the wallet holds or has
 * approved the order book for) and from SafeERC20 (a token transfer that returned false). Without copy they read as
 * the generic line below. The fragments are taken from the GENERATED Clearinghouse ABI, not retyped, so every selector
 * is the deployed contract's own; a USDG-level ERC-20 revert is the token's own error and is not decoded here.
 */
export const TOKEN_ERROR_TEXT = {
  ERC1155InsufficientBalance: "Your wallet holds fewer option units than this needs. Refresh Portfolio and choose a smaller size.",
  ERC1155MissingApprovalForAll: "The order book is not approved to move your option units. Approve it and try again.",
  SafeERC20FailedOperation: "A token transfer was refused. Check your balance and approval, then try again.",
} as const;

export type TokenErrorName = keyof typeof TOKEN_ERROR_TEXT;

const tokenErrorsAbi = clearinghouseAbi.filter((item) => item.type === "error" && item.name in TOKEN_ERROR_TEXT);

/** What the wallet said when the user declined: not a stale quote, so it must not say "refresh the quote". */
export const WALLET_REJECTED_TEXT = "You rejected this transaction in your wallet.";

const GENERIC_TEXT = "The transaction could not be completed. Refresh the quote and try again.";

/** A request the user declined in the wallet: viem's UserRejectedRequestError, or EIP-1193 code 4001, at any level. */
export function isWalletRejection(error: unknown): boolean {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    const value = cause as { name?: unknown; code?: unknown; cause?: unknown };
    if (value.name === "UserRejectedRequestError" || value.code === 4001) return true;
    cause = value.cause;
  }
  return false;
}

/**
 * viem wraps simulation errors in causes; look for a known error at every level: by the name viem decoded against the
 * called contract's ABI, or by decoding the raw revert data against `abi` (an error bubbled up from another contract,
 * which the called ABI does not list). Returns the first name found in `text`, or null.
 */
function errorNameIn<Name extends string>(error: unknown, text: Readonly<Record<Name, string>>, abi: Abi): Name | null {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    if (typeof cause === "object") {
      const value = cause as { data?: unknown; raw?: unknown; cause?: unknown; errorName?: unknown };
      if (typeof value.errorName === "string" && value.errorName in text) {
        return value.errorName as Name;
      }
      const decoded = value.data as { errorName?: unknown } | null;
      if (decoded && typeof decoded === "object" && typeof decoded.errorName === "string" && decoded.errorName in text)
        return decoded.errorName as Name;
      const raw = typeof value.data === "string" ? value.data : value.raw;
      if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) {
        try {
          const result = decodeErrorResult({ abi, data: raw as Hex });
          if (result.errorName in text) return result.errorName as Name;
        } catch { /* try the wrapped cause */ }
      }
      cause = value.cause;
    } else break;
  }
  return null;
}

/**
 * The v2 error name anywhere in viem's cause chain, or null when no level carries one. Callers whose contract gives a
 * shared error a different meaning (StockZap's `BadPrice` is a slippage miss, not an order-ticket tick error) read
 * the name here and pick their own copy.
 */
export function v2ErrorName(error: unknown): V2ErrorName | null {
  return errorNameIn(error, V2_ERROR_TEXT, v2ErrorsAbi);
}

/**
 * Buyer copy for a failed write: the v2 revert, else a token-level revert (TOKEN_ERROR_TEXT), else a wallet refusal,
 * else a generic line that leaks nothing.
 */
export function explainV2Error(error: unknown): string {
  const name = v2ErrorName(error);
  if (name) return V2_ERROR_TEXT[name];
  const token = errorNameIn(error, TOKEN_ERROR_TEXT, tokenErrorsAbi);
  if (token) return TOKEN_ERROR_TEXT[token];
  if (isWalletRejection(error)) return WALLET_REJECTED_TEXT;
  return GENERIC_TEXT;
}

/**
 * Copy for a failed Earn `redeem`, checked BEFORE the general copy because two reverts mean something
 * specific here. `ERC20InsufficientBalance` is the share token's own OpenZeppelin error: `redeem` escrows or burns the
 * shares, so asking for more than the wallet holds reverts with it. `BadUnits` is a zero share amount, which the
 * general copy words as an order-ticket step. The fragments come from the GENERATED EarnVault ABI, not retyped.
 * Used only by the redeem action: on a deposit the same OpenZeppelin error would be about USDG, not shares.
 */
export const EARN_REDEEM_ERROR_TEXT = {
  ERC20InsufficientBalance: "You are redeeming more shares than you hold.",
  BadUnits: "Enter a positive share amount.",
} as const;

const earnRedeemErrorsAbi = earnVaultAbi.filter((item) => item.type === "error" && item.name in EARN_REDEEM_ERROR_TEXT);

/** Buyer copy for a failed Earn redeem: the redeem-specific line, else {userErrorText}'s. */
export function explainEarnRedeemError(error: unknown): string {
  const name = errorNameIn(error, EARN_REDEEM_ERROR_TEXT, earnRedeemErrorsAbi);
  if (name) return EARN_REDEEM_ERROR_TEXT[name];
  return userErrorText(error, "Try again after refreshing.");
}

/**
 * The one line a trading page shows for a failed step. A viem error (a revert, an RPC failure) is decoded
 * through {explainV2Error}: its own `message` is viem's multi-paragraph dump (about 936 characters for a reverting
 * quoteTake: request, args, contract, docs link, version), which is not something a buyer can act on. Everything else is
 * already app copy (V2WriteError, the "quote changed" refusals, V2ConfirmedStepError) and passes through unchanged.
 * Nothing is discarded: the caller still holds the error, with viem's detail in its `cause` chain.
 */
export function userErrorText(error: unknown, fallback: string): string {
  if (error instanceof BaseError) return explainV2Error(error);
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
