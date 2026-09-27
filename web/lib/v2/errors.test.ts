import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult, type Abi, type Hex } from "viem";

import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { earnVaultAbi } from "../abi/v2/earnVault";
import { orderBookAbi } from "../abi/v2/orderBook";
import { v2ErrorsAbi } from "../abi/v2/v2Errors";
import { readFileSync } from "node:fs";

import { EARN_REDEEM_ERROR_TEXT, explainEarnRedeemError, explainV2Error, isWalletRejection, TOKEN_ERROR_TEXT, userErrorText, V2_ERROR_TEXT, v2ErrorName,
  WALLET_REJECTED_TEXT } from "./errors";

describe("v2 revert copy", () => {
  it("covers every custom ABI error with actionable text", () => {
    expect(Object.keys(V2_ERROR_TEXT).sort()).toEqual(v2ErrorsAbi.map((error) => error.name).sort());
    for (const message of Object.values(V2_ERROR_TEXT)) expect(message.length).toBeGreaterThan(20);
  });

  it("decodes AlreadyListed (0x19cd4595) by name, never as the generic line", () => {
    const data = encodeErrorResult({ abi: v2ErrorsAbi, errorName: "AlreadyListed", args: ["0x00000000000000000000000000000000000000a1"] });
    expect(data.slice(0, 10)).toBe("0x19cd4595");
    expect(v2ErrorName({ data })).toBe("AlreadyListed");
    expect(explainV2Error({ cause: { data } })).toBe(V2_ERROR_TEXT.AlreadyListed);
  });

  it("decodes v7 stale ask and vault spending reverts", () => {
    expect(explainV2Error({ data: encodeErrorResult({ abi: v2ErrorsAbi, errorName: "InTheMoney" }) })).toMatch(/at or in the money/);
    expect(explainV2Error({ data: encodeErrorResult({ abi: v2ErrorsAbi, errorName: "OutflowCapExceeded", args: [10n, 11n] }) })).toMatch(/spending limit/);
    expect(explainV2Error({ data: encodeErrorResult({ abi: v2ErrorsAbi, errorName: "FeeAboveMax", args: [2n, 1n] }) }))
      .toMatch(/above the maximum you approved/);
  });

  it("decodes a nested on-chain revert and keeps unknown failures generic", () => {
    const data = encodeErrorResult({ abi: v2ErrorsAbi, errorName: "TradingPaused" });
    expect(explainV2Error({ cause: { data } })).toBe(V2_ERROR_TEXT.TradingPaused);
    expect(explainV2Error({ cause: { data: { errorName: "TradingPaused" } } })).toBe(V2_ERROR_TEXT.TradingPaused);
    expect(explainV2Error(new Error("secret RPC internals"))).not.toContain("secret");
  });

  it("names the v2 error at any level of the cause chain, and returns null when there is none", () => {
    const data = encodeErrorResult({ abi: v2ErrorsAbi, errorName: "BadPrice" });
    expect(v2ErrorName({ data })).toBe("BadPrice");
    expect(v2ErrorName({ cause: { cause: { data } } })).toBe("BadPrice");
    expect(v2ErrorName({ cause: { data: { errorName: "StaleSpot" } } })).toBe("StaleSpot");
    expect(v2ErrorName({ errorName: "NotAnError" })).toBeNull();
    expect(v2ErrorName(new Error("secret RPC internals"))).toBeNull();
    expect(explainV2Error({ data })).toBe(V2_ERROR_TEXT.BadPrice);
  });
});

/*
 * (trading audit B, write path). Two ways a trading write used to end in the generic "Refresh the quote and
 * try again": a revert that is not a V2Errors name (OpenZeppelin ERC-1155 / SafeERC20, reachable from close, a resale
 * ask's escrow, a sale or the USDG pull), and a wallet refusal, which is the user's own choice and not a stale quote.
 * The reverts are real viem errors, wrapped the way simulateContract and writeContract wrap them.
 */
const ADDR = "0x0000000000000000000000000000000000000044";
function reverted(abi: Abi, functionName: string, data: Hex) {
  return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, data, functionName }),
    { abi, functionName, args: [], contractAddress: ADDR, sender: ADDR });
}
const GENERIC = /Refresh the quote and try again/;

describe("token-level reverts and wallet refusals", () => {
  it("every TOKEN_ERROR_TEXT name is an error of the generated Clearinghouse ABI and none is a V2Errors name", () => {
    const chErrors = new Set<string>(clearinghouseAbi.filter((item) => item.type === "error").map((item) => item.name));
    for (const name of Object.keys(TOKEN_ERROR_TEXT)) {
      expect(chErrors.has(name), name).toBe(true);
      expect(name in V2_ERROR_TEXT, name).toBe(false);
    }
  });

  it("an ERC-1155 approval revert bubbled up through OrderBook.place, which the OrderBook ABI cannot name, gets its own copy", () => {
    const data = encodeErrorResult({ abi: clearinghouseAbi, errorName: "ERC1155MissingApprovalForAll", args: [ADDR, ADDR] });
    expect(explainV2Error(reverted(orderBookAbi, "place", data))).toBe(TOKEN_ERROR_TEXT.ERC1155MissingApprovalForAll);
  });

  it("an ERC-1155 balance revert from Clearinghouse.close, named by viem against the Clearinghouse ABI, gets its own copy", () => {
    const data = encodeErrorResult({ abi: clearinghouseAbi, errorName: "ERC1155InsufficientBalance", args: [ADDR, 1n, 2n, 7n] });
    expect(explainV2Error(reverted(clearinghouseAbi, "close", data))).toBe(TOKEN_ERROR_TEXT.ERC1155InsufficientBalance);
  });

  it("a SafeERC20 refusal from the order book's USDG pull gets its own copy", () => {
    const data = encodeErrorResult({ abi: orderBookAbi, errorName: "SafeERC20FailedOperation", args: [ADDR] });
    expect(explainV2Error(reverted(orderBookAbi, "take", data))).toBe(TOKEN_ERROR_TEXT.SafeERC20FailedOperation);
  });

  it("a wallet refusal says the user declined it, not that the quote is stale", () => {
    const refused = new ContractFunctionExecutionError(new UserRejectedRequestError(new Error("User denied transaction signature.")),
      { abi: orderBookAbi, functionName: "take", args: [], contractAddress: ADDR, sender: ADDR });
    expect(isWalletRejection(refused)).toBe(true);
    expect(explainV2Error(refused)).toBe(WALLET_REJECTED_TEXT);
    expect(explainV2Error({ cause: { code: 4001 } })).toBe(WALLET_REJECTED_TEXT);
    expect(WALLET_REJECTED_TEXT).not.toMatch(GENERIC);
  });

  it("anything else stays generic, and a v2 revert still wins over the token table", () => {
    expect(isWalletRejection(new Error("boom"))).toBe(false);
    expect(explainV2Error(new Error("boom"))).toMatch(GENERIC);
    expect(explainV2Error(reverted(orderBookAbi, "take", "0xdeadbeef"))).toMatch(GENERIC);
    const paused = encodeErrorResult({ abi: v2ErrorsAbi, errorName: "TradingPaused" });
    expect(explainV2Error(reverted(orderBookAbi, "take", paused))).toBe(V2_ERROR_TEXT.TradingPaused);
  });
});

/*
 * What the trading pages print for a failed step: a viem error is decoded, never shown raw; app copy passes
 * through; nothing else becomes the fallback.
 */
describe("userErrorText", () => {
  const revert = (errorName: "BelowMinUnits" | "TradingPaused") => new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: orderBookAbi,
      data: errorName === "BelowMinUnits"
        ? encodeErrorResult({ abi: orderBookAbi, errorName, args: [1n, 2n] })
        : encodeErrorResult({ abi: orderBookAbi, errorName }),
      functionName: "quoteTake",
    }),
    { abi: orderBookAbi as Abi, functionName: "quoteTake", args: [], contractAddress: "0x0000000000000000000000000000000000000003",
      sender: "0x0000000000000000000000000000000000000001" });

  it("decodes a viem revert to its V2 copy instead of viem's dump", () => {
    const error = revert("BelowMinUnits");
    expect(error.message.length, "fixture: viem's own message is the long dump").toBeGreaterThan(300);
    expect(userErrorText(error, "fallback")).toBe(V2_ERROR_TEXT.BelowMinUnits);
    expect(userErrorText(revert("TradingPaused"), "fallback")).toBe(V2_ERROR_TEXT.TradingPaused);
  });

  it("an unknown viem error is the generic line, not its raw text", () => {
    const unknown = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: orderBookAbi, data: "0xdeadbeef" as Hex, functionName: "quoteTake" }),
      { abi: orderBookAbi as Abi, functionName: "quoteTake", args: [], contractAddress: "0x0000000000000000000000000000000000000003",
        sender: "0x0000000000000000000000000000000000000001" });
    expect(userErrorText(unknown, "fallback")).toBe(explainV2Error(new Error("none")));
    expect(userErrorText(unknown, "fallback")).not.toContain("quoteTake");
  });

  it("app copy passes through unchanged; a non-error is the fallback", () => {
    expect(userErrorText(new Error("The on-chain quote changed. Refresh and review the trade before continuing."), "x"))
      .toBe("The on-chain quote changed. Refresh and review the trade before continuing.");
    expect(userErrorText("not an error", "The trade could not be completed.")).toBe("The trade could not be completed.");
    expect(userErrorText(new Error(""), "fallback")).toBe("fallback");
  });

  it("the ticket and Portfolio print failures through it, and log the full error", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const ticket = read("../../components/v2/TradeTicket.tsx");
    const portfolio = read("../../components/v2/Portfolio.tsx");
    for (const [name, source] of [["TradeTicket", ticket], ["Portfolio", portfolio]] as const) {
      expect(source, name).toContain("userErrorText(error");
      expect(source, name).not.toContain("error instanceof Error ? error.message");
      expect(source, name).toMatch(/console\.error\([^)]*stopped[^)]*, error\)/);
    }
  });
});

/**
 * A redeem for more shares than the wallet holds reverts with the share token's OpenZeppelin
 * ERC20InsufficientBalance; before this it read as the generic "Refresh the quote" line. Encoded from the GENERATED
 * EarnVault ABI and wrapped the way simulateContract wraps it.
 */
describe("Earn redeem copy", () => {
  it("every EARN_REDEEM_ERROR_TEXT name is an error of the generated EarnVault ABI", () => {
    const names = new Set<string>(earnVaultAbi.filter((item) => item.type === "error").map((item) => item.name));
    for (const name of Object.keys(EARN_REDEEM_ERROR_TEXT)) expect(names.has(name), name).toBe(true);
  });

  it("more shares than held, and a zero amount, get redeem copy; anything else gets the general line", () => {
    const short = encodeErrorResult({ abi: earnVaultAbi, errorName: "ERC20InsufficientBalance", args: [ADDR, 1n, 2n] });
    expect(explainEarnRedeemError(reverted(earnVaultAbi, "redeem", short))).toBe("You are redeeming more shares than you hold.");
    expect(explainEarnRedeemError({ cause: { data: short } })).toBe(EARN_REDEEM_ERROR_TEXT.ERC20InsufficientBalance);
    const zero = encodeErrorResult({ abi: earnVaultAbi, errorName: "BadUnits" });
    expect(explainEarnRedeemError(reverted(earnVaultAbi, "redeem", zero))).toBe(EARN_REDEEM_ERROR_TEXT.BadUnits);
    // Positive control: the general copy is what a redeem showed before, and still what any other revert shows.
    expect(explainV2Error(reverted(earnVaultAbi, "redeem", short))).toMatch(GENERIC);
    const paused = encodeErrorResult({ abi: v2ErrorsAbi, errorName: "TradingPaused" });
    expect(explainEarnRedeemError(reverted(earnVaultAbi, "redeem", paused))).toBe(V2_ERROR_TEXT.TradingPaused);
    expect(explainEarnRedeemError(new Error("Connect your wallet first."))).toBe("Connect your wallet first.");
  });
});
