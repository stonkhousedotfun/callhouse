/**
 * The house vault write path. AUTHORED, NOT RUN as a shipping gate — owner directive 2026-09-19.
 *
 * Covers the two write-path cases the task contract names: "approval is exact" and "revert copy for
 * each new error". The fake client below is the minimum surface `approveExact` and `simulatedWrite`
 * touch (`tx.ts:30-71`) — multicall, simulateContract, writeContract, waitForTransactionReceipt — so
 * the test exercises the REAL helpers rather than a re-implementation of them.
 */
import { describe, expect, it } from "vitest";

import { USDG } from "../contracts";
import {
  HOUSE_OZ_ERROR_NAMES, cancelHouseDepositRequest, cancelHouseWithdrawRequest, claimHouseOwed,
  claimHouseWithdrawal, explainHouseOzError, houseVaultAddress, requestHouseDeposit,
  requestHouseWithdraw, requireHouseVaultAddress,
} from "./houseTx";

const VAULT = "0x00000000000000000000000000000000000000a1";
const ACCOUNT = "0x0000000000000000000000000000000000000044";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);

type Call = { address: string; functionName: string; args: readonly unknown[] };

/** `balance` and `allowance` are what the on-chain reads return; every write is recorded. */
function harness({ balance = 10_000_000n, allowance = 0n } = {}) {
  const calls: Call[] = [];
  const client = {
    multicall: async () => [balance, allowance],
    simulateContract: async (request: Call) => {
      calls.push({ address: request.address, functionName: request.functionName, args: request.args });
      return { request };
    },
    waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
  };
  const context = {
    account: ACCOUNT,
    client,
    wallet: {
      getChainId: async () => CHAIN_ID,
      writeContract: async () => "0xhash",
    },
  } as never;
  return { calls, context };
}

describe("house vault address", () => {
  it("is null when the market has no vault, and refuses every write with a reason", async () => {
    const { context } = harness();
    expect(houseVaultAddress(null)).toBeNull();
    expect(houseVaultAddress("not-an-address")).toBeNull();
    expect(() => requireHouseVaultAddress(null)).toThrow(/house vault is not deployed yet/);
    await expect(requestHouseDeposit(context, null, USDG, 1n)).rejects.toThrow(/not deployed yet/);
    await expect(requestHouseWithdraw(context, null, 1n)).rejects.toThrow(/not deployed yet/);
    await expect(cancelHouseDepositRequest(context, null)).rejects.toThrow(/not deployed yet/);
    await expect(cancelHouseWithdrawRequest(context, null)).rejects.toThrow(/not deployed yet/);
    await expect(claimHouseWithdrawal(context, null)).rejects.toThrow(/not deployed yet/);
    await expect(claimHouseOwed(context, null)).rejects.toThrow(/not deployed yet/);
  });

  it("refuses a non-positive deposit or withdrawal before touching the wallet", async () => {
    const { context, calls } = harness();
    await expect(requestHouseDeposit(context, VAULT, USDG, 0n)).rejects.toThrow(/positive deposit/);
    await expect(requestHouseWithdraw(context, VAULT, 0n)).rejects.toThrow(/positive share/);
    expect(calls).toHaveLength(0);
  });
});

describe("deposit approval is exact", () => {
  it("approves the exact deposit amount, never an unlimited allowance", async () => {
    const { context, calls } = harness({ allowance: 0n });
    await requestHouseDeposit(context, VAULT, USDG, 2_500_000n);
    const approve = calls.find((call) => call.functionName === "approve");
    expect(approve).toBeDefined();
    expect(approve!.args[0]).toBe(VAULT);
    expect(approve!.args[1]).toBe(2_500_000n);
    // The shape of the bug this guards: an unlimited allowance, or a padded one.
    expect(approve!.args[1]).not.toBe((1n << 256n) - 1n);
  });

  it("skips the approval entirely when the allowance already covers the deposit", async () => {
    const { context, calls } = harness({ allowance: 9_000_000n });
    await requestHouseDeposit(context, VAULT, USDG, 2_500_000n);
    expect(calls.some((call) => call.functionName === "approve")).toBe(false);
    expect(calls.map((call) => call.functionName)).toEqual(["requestDeposit"]);
  });

  it("sends requestDeposit to the vault with the asset and amount, after the approval", async () => {
    const { context, calls } = harness({ allowance: 0n });
    await requestHouseDeposit(context, VAULT, USDG, 1_000_000n);
    expect(calls.map((call) => call.functionName)).toEqual(["approve", "requestDeposit"]);
    const request = calls[1]!;
    expect(request.address).toBe(VAULT);
    expect(request.args).toEqual([USDG, 1_000_000n]);
  });

  it("stops before any write when the wallet cannot cover the deposit", async () => {
    const { context, calls } = harness({ balance: 1n });
    await expect(requestHouseDeposit(context, VAULT, USDG, 5_000_000n)).rejects.toThrow(/does not have enough/);
    expect(calls).toHaveLength(0);
  });
});

describe("revert copy", () => {
  it("pins the size of the list the loops below iterate", () => {
    // Both loops in this describe are `for (const name of HOUSE_OZ_ERROR_NAMES)`, and a for-of over an
    // empty array runs zero assertions and reports GREEN. That is the can't-see-its-subject shape: the
    // checks would stop checking silently if the list were ever emptied. Pinning the length means the
    // loops cannot pass by having nothing to iterate. Raised by the operator against T-136; fixed here
    // because T-113 is the next task in this file's scope.
    expect(HOUSE_OZ_ERROR_NAMES).toHaveLength(11);
  });

  it("names every OpenZeppelin error HouseVault can revert with that v2ErrorsAbi cannot decode", () => {
    expect(HOUSE_OZ_ERROR_NAMES.length).toBeGreaterThan(0);
    for (const name of HOUSE_OZ_ERROR_NAMES) {
      const copy = explainHouseOzError({ errorName: name });
      expect(copy, name).toBeTruthy();
      expect(copy, name).not.toMatch(/could not be completed/);
    }
  });

  it("covers the two a depositor actually hits", () => {
    expect(explainHouseOzError({ errorName: "ERC20InsufficientAllowance" })).toMatch(/approve/i);
    expect(explainHouseOzError({ errorName: "ERC20InsufficientBalance" })).toMatch(/not have enough/i);
  });

  it("reads an error nested in a viem cause chain, and one carried on `data`", () => {
    expect(explainHouseOzError({ cause: { cause: { errorName: "SafeERC20FailedOperation" } } })).toBeTruthy();
    expect(explainHouseOzError({ data: { errorName: "ReentrancyGuardReentrantCall" } })).toBeTruthy();
  });

  it("returns null for a shared v2 error so explainV2Error's own copy is used instead", () => {
    // TradingPaused, OutflowCapExceeded and NotAuthorized are in V2Errors.json and already have
    // copy in V2_ERROR_TEXT. Answering them here would shadow it.
    for (const name of ["TradingPaused", "OutflowCapExceeded", "NotAuthorized", "TooEarly"]) {
      expect(explainHouseOzError({ errorName: name }), name).toBeNull();
    }
    expect(explainHouseOzError(new Error("plain"))).toBeNull();
    expect(explainHouseOzError(null)).toBeNull();
  });

  it("does not claim any error name that is not in the generated HouseVault ABI", async () => {
    const { houseVaultAbi } = await import("../abi/v2/houseVault");
    const inAbi = new Set((houseVaultAbi as readonly { type: string; name?: string }[])
      .filter((entry) => entry.type === "error").map((entry) => entry.name));
    expect(HOUSE_OZ_ERROR_NAMES.length).toBeGreaterThan(0);
    for (const name of HOUSE_OZ_ERROR_NAMES) expect(inAbi.has(name), name).toBe(true);
  });
});
