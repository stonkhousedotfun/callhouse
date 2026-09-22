import { decodeErrorResult, type Hex } from "viem";

import { v2ErrorsAbi } from "../abi/v2/v2Errors";

type V2ErrorName = (typeof v2ErrorsAbi)[number]["name"];

/** Every frozen v2 custom error has copy a buyer can act on. */
export const V2_ERROR_TEXT = {
  AlreadyFinal: "This settlement is already final.",
  AlreadySettled: "This series has already settled.",
  BadExpiry: "Choose a valid market expiry.",
  BadPrice: "Enter a price on the market's price tick.",
  BadStrike: "Choose a valid strike on the market's strike tick.",
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

/** viem wraps simulation errors in causes; look for an ABI error selector at every level. */
export function explainV2Error(error: unknown): string {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    if (typeof cause === "object") {
      const value = cause as { data?: unknown; raw?: unknown; cause?: unknown; errorName?: unknown };
      if (typeof value.errorName === "string" && value.errorName in V2_ERROR_TEXT) {
        return V2_ERROR_TEXT[value.errorName as V2ErrorName];
      }
      const decoded = value.data as { errorName?: unknown } | null;
      if (decoded && typeof decoded === "object" && typeof decoded.errorName === "string" && decoded.errorName in V2_ERROR_TEXT)
        return V2_ERROR_TEXT[decoded.errorName as V2ErrorName];
      const raw = typeof value.data === "string" ? value.data : value.raw;
      if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) {
        try {
          const result = decodeErrorResult({ abi: v2ErrorsAbi, data: raw as Hex });
          return V2_ERROR_TEXT[result.errorName as V2ErrorName];
        } catch { /* try the wrapped cause */ }
      }
      cause = value.cause;
    } else break;
  }
  return "The transaction could not be completed. Refresh the quote and try again.";
}
