/**
 * The house vault write path.
 *
 * Covers the two write-path cases that matter: "approval is exact" and "revert copy for
 * each new error". The fake client below is the minimum surface `approveExact` and `simulatedWrite`
 * touch (`tx.ts:30-71`) — multicall, simulateContract, writeContract, waitForTransactionReceipt — so
 * the test exercises the REAL helpers rather than a re-implementation of them.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Log, type PublicClient } from "viem";

import { houseVaultAbi } from "../abi/v2/houseVault";
import { USDG } from "../contracts";
import {
  HOUSE_OZ_ERROR_NAMES, HOUSE_WITHDRAW_OVER_BALANCE, cancelHouseDepositRequest, cancelHouseWithdrawRequest,
  HOUSE_PAST_CUTOFF, claimHouseWithdrawal, claimedFrom, depositedNowSharesFrom, depositHouseNow, explainHouseOzError, houseVaultAddress, minSharesFor,
  parseHouseWithdrawShares, previewHouseDepositNow, requestHouseDeposit, requestHouseWithdraw, requireHouseVaultAddress,
} from "./houseTx";
import { SHARE_DECIMALS, USDG_DECIMALS } from "./houseEpoch";
import { V2_ERROR_TEXT, v2ErrorName } from "./errors";
import { HOUSE_CLAIM_NOTHING_READY } from "./houseClaim";

const VAULT = "0x00000000000000000000000000000000000000a1";
const ACCOUNT = "0x0000000000000000000000000000000000000044";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);

type Call = { address: string; functionName: string; args: readonly unknown[] };

/** `balance` and `allowance` are what the on-chain reads return; every write is recorded. */
function harness({ balance = 10_000_000n, allowance = 0n, logs = [] as Log[] } = {}) {
  const calls: Call[] = [];
  const client = {
    multicall: async () => [balance, allowance],
    simulateContract: async (request: Call) => {
      calls.push({ address: request.address, functionName: request.functionName, args: request.args });
      return { request };
    },
    waitForTransactionReceipt: async () => ({ status: "success", logs }),
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
    // loops cannot pass by having nothing to iterate. Raised by the operator against fixed here
    // because is the next task in this file's scope.
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

/*
 * A USDG deposit mints now only when the vault's own previewDepositNow says so.
 */
function depositedNowLog(vault: string, account: string, usdgAmount: bigint, shares: bigint): Log {
  return {
    address: vault,
    topics: encodeEventTopics({ abi: houseVaultAbi, eventName: "DepositedNow", args: { account: account as `0x${string}`, epochId: 7n } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [usdgAmount, shares]),
  } as unknown as Log;
}

describe("instant USDG deposit", () => {
  const reverting = (errorName: string) => Object.assign(new Error("execution reverted"), { errorName });

  it("asks the vault's previewDepositNow and takes its share count as the instant answer", async () => {
    const calls: unknown[] = [];
    const client = { readContract: async (request: unknown) => { calls.push(request); return 4_200n; } } as unknown as PublicClient;
    expect(await previewHouseDepositNow(VAULT, 1_000_000n, client)).toEqual({ instant: true, shares: 4_200n });
    expect(calls).toEqual([expect.objectContaining({ address: VAULT, functionName: "previewDepositNow", args: [1_000_000n] })]);
  });

  it("a v2 refusal from the preview means the deposit queues, and the refusal is named", async () => {
    for (const name of ["PastCutoff", "NotSettled", "NoSource", "StaleSpot", "InsufficientCollateral", "FeeAboveMax", "BadUnits"]) {
      const client = { readContract: async () => { throw reverting(name); } } as unknown as PublicClient;
      expect(await previewHouseDepositNow(VAULT, 1_000_000n, client), name).toEqual({ instant: false, refusal: name });
    }
  });

  it("the not-exact preview (NoSource or StaleSpot) queues by that name and carries no shares", async () => {
    for (const name of ["NoSource", "StaleSpot"] as const) {
      const client = { readContract: async () => { throw reverting(name); } } as unknown as PublicClient;
      const route = await previewHouseDepositNow(VAULT, 1_000_000n, client);
      expect(route, name).toEqual({ instant: false, refusal: name });
      expect(route).not.toHaveProperty("shares");
    }
  });

  it("a preview that fails for another reason throws: could not ask is not 'it queues'", async () => {
    const client = { readContract: async () => { throw new Error("fetch failed"); } } as unknown as PublicClient;
    await expect(previewHouseDepositNow(VAULT, 1_000_000n, client)).rejects.toThrow(/Could not ask the vault/);
    await expect(previewHouseDepositNow(VAULT, 0n, client)).rejects.toThrow(/positive deposit/);
    await expect(previewHouseDepositNow(null, 1n, client)).rejects.toThrow(/not deployed yet/);
  });

  it("depositNow approves the exact amount first, then mints with the minShares bound", async () => {
    const { context, calls } = harness({ allowance: 0n, logs: [depositedNowLog(VAULT, ACCOUNT, 2_500_000n, 2_499n)] });
    const out = await depositHouseNow(context, VAULT, USDG, 2_500_000n, 2_400n);
    expect(calls.map((call) => call.functionName)).toEqual(["approve", "depositNow"]);
    expect(calls[0]!.args).toEqual([VAULT, 2_500_000n]);
    expect(calls[1]!.address).toBe(VAULT);
    expect(calls[1]!.args).toEqual([2_500_000n, 2_400n]);
    expect(out).toEqual({ hash: "0xhash", shares: 2_499n });
  });

  it("reads the minted shares only from THIS vault's DepositedNow log for THIS account", () => {
    const other = "0x00000000000000000000000000000000000000b2";
    expect(depositedNowSharesFrom({ logs: [depositedNowLog(other, ACCOUNT, 1n, 9n)] }, VAULT, ACCOUNT)).toBeNull();
    expect(depositedNowSharesFrom({ logs: [depositedNowLog(VAULT, other, 1n, 9n)] }, VAULT, ACCOUNT)).toBeNull();
    expect(depositedNowSharesFrom({ logs: [] }, VAULT, ACCOUNT)).toBeNull();
    expect(depositedNowSharesFrom({ logs: [depositedNowLog(VAULT, ACCOUNT, 1n, 9n)] }, VAULT, ACCOUNT)).toBe(9n);
  });

  it("refuses a non-positive amount or a zero share bound before touching the wallet", async () => {
    const { context, calls } = harness();
    await expect(depositHouseNow(context, VAULT, USDG, 0n, 1n)).rejects.toThrow(/positive deposit/);
    await expect(depositHouseNow(context, VAULT, USDG, 1n, 0n)).rejects.toThrow(/mint no shares/);
    await expect(depositHouseNow(context, null, USDG, 1n, 1n)).rejects.toThrow(/not deployed yet/);
    expect(calls).toHaveLength(0);
  });

  it("minShares is one basis point under the preview, never above it", () => {
    expect(minSharesFor(10_000n)).toBe(9_999n);
    expect(minSharesFor(1n)).toBe(1n);
    expect(minSharesFor(10n ** 18n)).toBe(10n ** 18n - 10n ** 14n);
  });
});

/**
 * (measured on a v9 fork): HouseVault.claim() refuses `BadUnits` when no request has matured, and
 * the shared BadUnits copy ("Enter a positive quantity in 0.01 share steps.") told a depositor who clicked Claim before
 * the close something that had nothing to do with it. Only claim's BadUnits is re-worded; every other call keeps the
 * shared text, which is right for a real quantity error.
 */
describe("claim refusal copy", () => {
  /** A simulation that reverts `errorName` for `functionName`, carried as raw revert data the way viem nests it. */
  function reverting(functionName: string, errorName: "BadUnits" | "TooEarly" | "PastCutoff") {
    const data = errorName === "TooEarly"
      ? encodeErrorResult({ abi: houseVaultAbi, errorName, args: [1_760_604_800] })
      : encodeErrorResult({ abi: houseVaultAbi, errorName });
    const { context } = harness();
    const client = (context as unknown as { client: Record<string, unknown> }).client;
    client.simulateContract = async (request: Call) => {
      if (request.functionName === functionName)
        throw Object.assign(new Error("execution reverted"), { cause: { name: "RawContractError", data } });
      return { request };
    };
    return context;
  }

  it("a claim with nothing matured says nothing is ready yet, not the quantity text", async () => {
    const error: unknown = await claimHouseWithdrawal(reverting("claim", "BadUnits"), VAULT).then(() => null, (e: unknown) => e);
    if (!(error instanceof Error)) throw new Error("claim did not refuse");
    expect(error.message).toBe(HOUSE_CLAIM_NOTHING_READY);
    expect(error.message).not.toBe(V2_ERROR_TEXT.BadUnits);
    // The chain's own error is still in the cause chain for support.
    expect(v2ErrorName(error)).toBe("BadUnits");
  });

  it("BadUnits from any other call keeps the shared quantity text", async () => {
    await expect(requestHouseWithdraw(reverting("requestWithdraw", "BadUnits"), VAULT, 1n))
      .rejects.toThrow(V2_ERROR_TEXT.BadUnits);
    await expect(cancelHouseWithdrawRequest(reverting("cancelWithdrawRequest", "BadUnits"), VAULT))
      .rejects.toThrow(V2_ERROR_TEXT.BadUnits);
  });

  it("any other claim refusal keeps its own copy", async () => {
    await expect(claimHouseWithdrawal(reverting("claim", "TooEarly"), VAULT)).rejects.toThrow(V2_ERROR_TEXT.TooEarly);
  });

  it("PastCutoff from the four queue calls says the queue closed, not the series mint-cutoff text", async () => {
    const refusals = [
      requestHouseDeposit(reverting("requestDeposit", "PastCutoff"), VAULT, USDG, 1_000_000n),
      cancelHouseDepositRequest(reverting("cancelDepositRequest", "PastCutoff"), VAULT),
      requestHouseWithdraw(reverting("requestWithdraw", "PastCutoff"), VAULT, 1n),
      cancelHouseWithdrawRequest(reverting("cancelWithdrawRequest", "PastCutoff"), VAULT),
    ];
    for (const refusal of refusals) {
      const error: unknown = await refusal.then(() => null, (e: unknown) => e);
      if (!(error instanceof Error)) throw new Error("the call did not refuse");
      expect(error.message).toBe(HOUSE_PAST_CUTOFF);
      expect(error.message).not.toBe(V2_ERROR_TEXT.PastCutoff);
      expect(v2ErrorName(error)).toBe("PastCutoff"); // the chain's own error stays in the cause chain
    }
  });

  it("a claim that goes through is sent as claim() with no arguments", async () => {
    const { context, calls } = harness();
    // The hash now travels with what the claim paid; this fake chain answers neither, so both are null.
    await expect(claimHouseWithdrawal(context, VAULT)).resolves.toEqual({ hash: "0xhash", paid: null, quoted: null });
    expect(calls).toEqual([{ address: VAULT, functionName: "claim", args: [] }]);
  });
});

/**
 * The House vault's first mint pays 10 ** (18 - USDG decimals) shares per USDG base
 * unit, so a whole share starts at about one USDG: typing 50 in the withdraw box must ask for 50 whole shares, and
 * requestWithdraw's ERC20InsufficientBalance is about the wallet's SHARE balance (the vault `_transfer`s the shares in),
 * not a deposit token.
 */
describe("House withdraw amount and copy", () => {
  /** What first mint pays for `usdg` base units: 10 ** (SHARE_DECIMALS - USDG_DECIMALS) shares each. */
  const firstMint = (usdg: bigint) => usdg * 10n ** BigInt(SHARE_DECIMALS - USDG_DECIMALS);

  it("typing 50 builds requestWithdraw(50 x 10^18): the shares a 50 USDG first deposit minted", async () => {
    const amount = parseHouseWithdrawShares("50");
    expect(amount).toBe(50n * 10n ** 18n);
    expect(amount).toBe(firstMint(50n * 10n ** BigInt(USDG_DECIMALS)));
    const { context, calls } = harness();
    await expect(requestHouseWithdraw(context, VAULT, amount!)).resolves.toBe("0xhash");
    expect(calls).toEqual([{ address: VAULT, functionName: "requestWithdraw", args: [50_000_000_000_000_000_000n] }]);
  });

  it("parses fractions in whole shares and refuses anything that is not a positive amount", () => {
    expect(parseHouseWithdrawShares("0.5")).toBe(5n * 10n ** 17n);
    expect(parseHouseWithdrawShares("1.000000000000000001")).toBe(10n ** 18n + 1n);
    for (const raw of ["", "0", "0.0", "-1", "abc", "1e18"]) expect(parseHouseWithdrawShares(raw), raw).toBeNull();
  });

  /** A simulation that reverts ERC20InsufficientBalance for `functionName`, decoded the way viem nests it. */
  function overBalance(functionName: string) {
    const { context } = harness();
    const client = (context as unknown as { client: Record<string, unknown> }).client;
    client.simulateContract = async (request: Call) => {
      if (request.functionName === functionName) {
        throw Object.assign(new Error("execution reverted"), {
          cause: { name: "ContractFunctionRevertedError", data: { errorName: "ERC20InsufficientBalance", args: [ACCOUNT, 1n, 2n] } },
        });
      }
      return { request };
    };
    return context;
  }

  it("requestWithdraw over the share balance names the share balance, not a deposit", async () => {
    const error: unknown = await requestHouseWithdraw(overBalance("requestWithdraw"), VAULT, 10n ** 18n)
      .then(() => null, (e: unknown) => e);
    if (!(error instanceof Error)) throw new Error("requestWithdraw did not refuse");
    expect(error.message).toBe(HOUSE_WITHDRAW_OVER_BALANCE);
    expect(error.message).not.toMatch(/deposit/i);
  });

  it("a deposit's ERC20InsufficientBalance keeps the deposit copy", async () => {
    await expect(requestHouseDeposit(overBalance("requestDeposit"), VAULT, USDG, 1n))
      .rejects.toThrow(explainHouseOzError({ errorName: "ERC20InsufficientBalance" })!);
    expect(explainHouseOzError({ errorName: "ERC20InsufficientBalance" })).toMatch(/for that deposit/);
  });
});

/**
 * HouseVault.claim() RETURNS what it pays, `(shares, usdgAmount, stockAmount)`, and emits the
 * same three in `Claimed`. The write reads both: the simulation's decoded return (`quoted`) and the receipt's log
 * (`paid`). The fake client runs the REAL simulatedWrite; only the chain answers are stubbed.
 */
function claimedLog(vault: string, account: string, shares: bigint, usdgAmount: bigint, stockAmount: bigint): Log {
  return {
    address: vault,
    topics: encodeEventTopics({ abi: houseVaultAbi, eventName: "Claimed", args: { account: account as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [shares, usdgAmount, stockAmount]),
  } as unknown as Log;
}

function claimHarness(result: unknown, logs: Log[]) {
  const client = {
    simulateContract: async (request: Call) => ({ request, result }),
    waitForTransactionReceipt: async () => ({ status: "success", logs }),
  };
  return {
    account: ACCOUNT,
    client,
    wallet: { getChainId: async () => CHAIN_ID, writeContract: async () => "0xhash" },
  } as never;
}

describe("claim() returns what it pays", () => {
  it("the generated ABI's claim() returns (shares, usdgAmount, stockAmount), as the contract declares it", () => {
    const claim = houseVaultAbi.find((item) => item.type === "function" && item.name === "claim");
    expect(claim).toBeDefined();
    const outputs = (claim as { outputs: readonly { name: string; type: string }[] }).outputs;
    expect(outputs.map((o) => `${o.type} ${o.name}`)).toEqual(["uint256 shares", "uint256 usdgAmount", "uint256 stockAmount"]);
    const view = houseVaultAbi.find((item) => item.type === "function" && item.name === "claimable") as
      { stateMutability: string; inputs: readonly { type: string }[]; outputs: readonly { name: string }[] } | undefined;
    expect(view?.stateMutability).toBe("view");
    expect(view?.inputs.map((i) => i.type)).toEqual(["address"]);
    expect(view?.outputs.map((o) => o.name)).toEqual(["shares", "usdgAmount", "stockAmount"]);
  });

  it("reports the simulated return as quoted and the receipt's Claimed log as paid", async () => {
    const context = claimHarness([2n, 7_000_000n, 5n], [claimedLog(VAULT, ACCOUNT, 3n, 7_000_001n, 6n)]);
    expect(await claimHouseWithdrawal(context, VAULT)).toEqual({
      hash: "0xhash",
      quoted: { shares: 2n, usdg: 7_000_000n, stock: 5n },
      paid: { shares: 3n, usdg: 7_000_001n, stock: 6n },
    });
  });

  it("a zero payout is a real (0, 0, 0), and an undecodable return or missing log is null, never zero", async () => {
    expect(await claimHouseWithdrawal(claimHarness([0n, 0n, 0n], [claimedLog(VAULT, ACCOUNT, 0n, 0n, 0n)]), VAULT)).toEqual({
      hash: "0xhash", quoted: { shares: 0n, usdg: 0n, stock: 0n }, paid: { shares: 0n, usdg: 0n, stock: 0n },
    });
    // What the earlier claim() decoded to (no outputs), and a receipt without our log.
    expect(await claimHouseWithdrawal(claimHarness(undefined, []), VAULT)).toEqual({ hash: "0xhash", quoted: null, paid: null });
  });

  it("claimedFrom reads only this vault's log for this account", () => {
    const other = "0x00000000000000000000000000000000000000b2";
    expect(claimedFrom({ logs: [claimedLog(other, ACCOUNT, 1n, 1n, 1n)] }, VAULT, ACCOUNT)).toBeNull();
    expect(claimedFrom({ logs: [claimedLog(VAULT, other, 1n, 1n, 1n)] }, VAULT, ACCOUNT)).toBeNull();
    expect(claimedFrom({ logs: [claimedLog(VAULT, ACCOUNT, 1n, 2n, 3n)] }, VAULT, ACCOUNT)).toEqual({ shares: 1n, usdg: 2n, stock: 3n });
  });
});
