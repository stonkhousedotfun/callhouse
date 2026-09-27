/**
 * lib/hooks.ts (the closed v1 vault's wagmi readers). Node only: each hook runs inside a one-off server render, with
 * wagmi's `useReadContracts` / `useBlock` stubbed so every batch is answered by name. What is checked is the decoding:
 * that each named call's answer lands in the right field (an index slip would swap two numbers silently), the units,
 * and the enabled gates. Effects (useNow's ticking clock) never run in a server render and are not covered here.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VAULT = "0x00000000000000000000000000000000000000Aa";
const CLEAR = "0x00000000000000000000000000000000000000Cc";
const ACCOUNT = "0x00000000000000000000000000000000000000Ee";

vi.mock("./contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contracts")>()),
  VAULT: "0x00000000000000000000000000000000000000Aa",
}));

type Call = { address: string; functionName: string; args?: readonly unknown[] };
type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };
type Args = { contracts: Call[]; query?: { enabled?: boolean; refetchInterval?: number } };

const state = vi.hoisted(() => ({
  answer: (_call: { functionName: string; args?: readonly unknown[] }): unknown => undefined,
  calls: [] as Array<{ contracts: Array<{ address: string; functionName: string; args?: readonly unknown[] }>; query?: { enabled?: boolean } }>,
  loaded: true,
  block: undefined as undefined | { timestamp: bigint; number: bigint },
}));

vi.mock("wagmi", () => ({
  useReadContracts: (args: Args) => {
    state.calls.push(args);
    const data = state.loaded && args.contracts.length > 0
      ? args.contracts.map((call): Result => {
        const value = state.answer(call);
        return value instanceof Error ? { status: "failure", error: value } : value === undefined
          ? { status: "failure", error: new Error("no answer") } : { status: "success", result: value };
      })
      : undefined;
    return { data, isLoading: !state.loaded, isError: false, error: null, refetch: vi.fn(async () => undefined) };
  },
  useBlock: () => ({ data: state.block, refetch: vi.fn() }),
}));

import { LOT_SIZE, SEAPORT, USDG } from "./contracts";
import {
  phaseLabel, useAccountPosition, useChainTime, useCycleOption, useExercisePosition, useMounted, useNow, useOrderStatus,
  useVaultSnapshot, type VaultSnapshot,
} from "./hooks";

/** Run a hook once inside a server render and return what it returned. */
function run<T>(hook: () => T): T {
  let out: T | undefined;
  function Probe() {
    out = hook();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return out as T;
}

beforeEach(() => {
  state.calls = [];
  state.loaded = true;
  state.answer = () => undefined;
  state.block = undefined;
});

const E18 = 10n ** 18n;
const POLICY = [500, 2_000, 100, 8_000, 1_000, 50n] as const;

describe("phaseLabel", () => {
  it("names the four phases, a dash for unknown and a number for anything new", () => {
    expect([0, 1, 2, 3].map(phaseLabel)).toEqual(["Idle", "Listed", "Exercisable", "Settling"]);
    expect(phaseLabel(undefined)).toBe("—");
    expect(phaseLabel(7)).toBe("Phase 7");
  });
});

describe("useVaultSnapshot", () => {
  const VALUES: Record<string, unknown> = {
    symbol: "cNVDA", name: "Covered NVDA", totalSupply: 90n * E18, totalAssets: 100n * E18, idleAssets: 60n * E18,
    lockedAssets: 40n * E18, reservedAssets: 1n, phase: 1, cycleNumber: 7n, cycleExerciseTs: 1_790_000_000n,
    cycleExpiryTs: 1_790_086_400, cycleStrikeUsdg: 250_000_000n, optionId: 99n, claimKey: 5n, contractsWritten: 10n,
    contractsAssigned: 2n, listingHash: `0x${"ab".repeat(32)}`, listingGrossUsdg: 1_000_000n, listingAmount: 3n,
    listingsThisCycle: 1, conduitKey: `0x${"00".repeat(32)}`, clear: CLEAR, accUsdgPerShare: 11n, totalUsdgDistributed: 12n,
    usdgReservedForQueue: 13n, usdgUnallocated: 14n, queuedShares: 15n, epochId: 16n, writesHalted: false,
    valoremFeeAccepted: true, depositCap: 1_000n * E18, canRedeemInstantly: true, maxDeposit: 5n, uiMultiplier: E18,
    spotUsdg: 200_000_000n, feeRecipient: "0x00000000000000000000000000000000000000Fe", policy: POLICY, isStranded: false,
    strandGen: 0n, lastResolvedGen: 0n, strandedRemainingWad: 0n, oraclePaused: false, feesEnabled: true, feeBps: 15n,
  };

  it("maps every named read to its own field, with units intact", () => {
    state.answer = (call) => {
      if (call.functionName === "balanceOf") return call.args?.[0] === VAULT ? (call as Call).address === USDG ? 7_000_000n : 60n * E18 : undefined;
      return VALUES[call.functionName];
    };
    const { data } = run(() => useVaultSnapshot());
    expect(data).toMatchObject({
      ready: true, symbol: "cNVDA", name: "Covered NVDA", totalSupply: 90n * E18, totalAssets: 100n * E18, idleAssets: 60n * E18,
      lockedAssets: 40n * E18, assetHeld: 60n * E18, usdgHeld: 7_000_000n, phase: 1, cycleNumber: 7, cycleExerciseTs: 1_790_000_000,
      cycleExpiryTs: 1_790_086_400, cycleStrikeUsdg: 250_000_000n, optionId: 99n, contractsWritten: 10n, contractsAssigned: 2n,
      listingHash: `0x${"ab".repeat(32)}`, listingsThisCycle: 1, clear: CLEAR, clearFeesEnabled: true, clearFeeBps: 15,
      writesHalted: false, depositsOpen: true, spotUsdg: 200_000_000n, spotStale: false, oraclePaused: false,
      policy: { minOtmBps: 500, maxOtmBps: 2_000, minPremiumBps: 100, maxUtilizationBps: 8_000, protocolFeeBps: 1_000, maxContractsCap: 50n },
    });
    // 100 shares of NAV at 80% utilisation = 80 lots, capped at 50, minus 10 written.
    expect(data.capacity).toBe(40n);
    // Band: spot +5% .. +20%.
    expect(data.band).toEqual({ min: 210_000_000n, max: 240_000_000n });
  });

  it("asks the fee switch of the Clear the vault names, not the compiled constant", () => {
    state.answer = (call) => VALUES[call.functionName];
    run(() => useVaultSnapshot());
    const feeCall = state.calls.find((c) => c.contracts.some((x) => x.functionName === "feesEnabled"))!;
    expect(feeCall.contracts.every((x) => x.address === CLEAR)).toBe(true);
    expect(feeCall.query?.enabled).toBe(true);
  });

  it("marks a reverted spot as stale and a reverted oraclePaused as not paused", () => {
    state.answer = (call) => call.functionName === "spotUsdg" || call.functionName === "oraclePaused" ? new Error("revert") : VALUES[call.functionName];
    const { data } = run(() => useVaultSnapshot());
    expect(data.spotStale).toBe(true);
    expect(data.spotUsdg).toBeUndefined();
    expect(data.band).toBeUndefined();
    expect(data.oraclePaused).toBe(false);
  });

  it("reads closed deposits from maxDeposit(0) = 0, and ignores wrong-typed answers", () => {
    state.answer = (call) => ({ ...VALUES, maxDeposit: 0n, symbol: 5, writesHalted: "no", listingHash: "abc", phase: "1" })[call.functionName];
    const { data } = run(() => useVaultSnapshot());
    expect(data.depositsOpen).toBe(false);
    expect(data.symbol).toBeUndefined();
    expect(data.writesHalted).toBeUndefined();
    expect(data.listingHash).toBeUndefined();
    expect(data.phase).toBeUndefined();
  });

  it("is not ready, and has no fee read, before the batch answers", () => {
    state.loaded = false;
    const out = run(() => useVaultSnapshot());
    expect(out.isLoading).toBe(true);
    expect(out.data.ready).toBe(false);
    expect(out.data.depositsOpen).toBeUndefined();
    expect(out.data.policy).toBeUndefined();
    expect(state.calls[1]!.query?.enabled).toBe(false);
  });
});

describe("useCycleOption", () => {
  const OPTION = { underlyingAsset: "0x1", underlyingAmount: E18, exerciseAsset: USDG, exerciseAmount: 220_000_000n,
    exerciseTimestamp: 1_790_000_000, expiryTimestamp: 1_790_086_400 };
  const snap = (over: Partial<VaultSnapshot> = {}) => ({ ready: true, spotStale: false, optionId: 9n, clear: CLEAR as `0x${string}`,
    spotUsdg: 200_000_000n, cycleStrikeUsdg: 220_000_000n, cycleExerciseTs: 1_790_000_000, cycleExpiryTs: 1_790_086_400, ...over }) as VaultSnapshot;

  it("reads the option from the vault's Clear and computes distance above spot in bps", () => {
    state.answer = () => OPTION;
    const { data } = run(() => useCycleOption(snap()));
    expect(state.calls[0]!.contracts[0]).toMatchObject({ address: CLEAR, functionName: "option", args: [9n] });
    expect(data).toMatchObject({ strikeUsdg: 220_000_000n, exerciseTs: 1_790_000_000, expiryTs: 1_790_086_400, otmBps: 1_000, agreesWithVault: true });
  });

  it("flags a disagreement with the vault's own snapshot, and leaves it unknown when the snapshot is partial", () => {
    state.answer = () => OPTION;
    expect(run(() => useCycleOption(snap({ cycleStrikeUsdg: 221_000_000n }))).data?.agreesWithVault).toBe(false);
    expect(run(() => useCycleOption(snap({ cycleExpiryTs: undefined }))).data?.agreesWithVault).toBeUndefined();
    expect(run(() => useCycleOption(snap({ spotUsdg: 0n }))).data?.otmBps).toBeUndefined();
  });

  it("does not read without an armed option id", () => {
    expect(run(() => useCycleOption(snap({ optionId: 0n }))).data).toBeUndefined();
    expect(state.calls.at(-1)!.contracts).toEqual([]);
    expect(state.calls.at(-1)!.query?.enabled).toBe(false);
  });
});

describe("useAccountPosition", () => {
  it("decodes the account batch and the dependent epoch reads", () => {
    state.answer = (call) => ({
      balanceOf: call.args?.[0] === ACCOUNT ? 4n * E18 : undefined, queuedSharesOf: 2n * E18, queuedEpochOf: 3n,
      claimableUsdg: 1_500_000n, previewCompleteRedeem: [5n, 6n], maxDeposit: 100n, owedStrandWad: 7n, owedStrandGen: 1n,
      allowance: 8n, convertToAssets: 4_400_000_000_000_000_000n, epochStrandWad: 9n, epochStrandGen: 2n, epochs: [11n, 12n, 13n],
    } as Record<string, unknown>)[call.functionName];
    const { data } = run(() => useAccountPosition(ACCOUNT));
    expect(data).toMatchObject({ ready: true, shares: 4n * E18, queuedShares: 2n * E18, queuedEpoch: 3n, sharesValueAssets: 4_400_000_000_000_000_000n,
      claimableUsdg: 1_500_000n, pendingAssets: 5n, pendingUsdg: 6n, maxDeposit: 100n, owedStrandWad: 7n, owedStrandGen: 1n,
      assetAllowance: 8n, epochStrandWad: 9n, epochStrandGen: 2n, epochSharesRemaining: 11n });
    const dependent = state.calls.at(-1)!.contracts;
    expect(dependent.map((c) => c.functionName)).toEqual(["convertToAssets", "epochStrandWad", "epochStrandGen", "epochs"]);
    expect(dependent[0]!.args).toEqual([4n * E18]);
    const allowance = state.calls[0]!.contracts.find((c) => c.functionName === "allowance")!;
    expect(allowance.args).toEqual([ACCOUNT, VAULT]);
  });

  it("skips the epoch reads when nothing is queued", () => {
    state.answer = (call) => ({ balanceOf: E18, queuedSharesOf: 0n, queuedEpochOf: 0n, convertToAssets: E18 } as Record<string, unknown>)[call.functionName];
    const { data } = run(() => useAccountPosition(ACCOUNT));
    expect(state.calls.at(-1)!.contracts.map((c) => c.functionName)).toEqual(["convertToAssets"]);
    expect(data.epochSharesRemaining).toBeUndefined();
  });

  it("reads nothing without a wallet", () => {
    const { data } = run(() => useAccountPosition(undefined));
    expect(state.calls[0]!.contracts).toEqual([]);
    expect(state.calls[0]!.query?.enabled).toBe(false);
    expect(data.ready).toBe(false);
    expect(data.queuedShares).toBe(0n);
  });

  it("refetch refreshes both batches", async () => {
    state.answer = () => 1n;
    const out = run(() => useAccountPosition(ACCOUNT));
    await expect(out.refetch()).resolves.toBeUndefined();
  });
});

describe("useOrderStatus", () => {
  it("asks Seaport for a real hash and names the tuple", () => {
    state.answer = () => [true, false, 1n, 3n];
    const hash = `0x${"12".repeat(32)}` as const;
    const { data } = run(() => useOrderStatus(hash));
    expect(state.calls[0]!.contracts[0]).toMatchObject({ address: SEAPORT, functionName: "getOrderStatus", args: [hash] });
    expect(data).toEqual({ isValidated: true, isCancelled: false, totalFilled: 1n, totalSize: 3n });
  });

  it.each([undefined, "0x", `0x${"0".repeat(64)}`] as const)("does not ask for %s", (hash) => {
    expect(run(() => useOrderStatus(hash as `0x${string}` | undefined)).data).toBeUndefined();
    expect(state.calls[0]!.contracts).toEqual([]);
  });

  it("is undefined when the read fails", () => {
    state.answer = () => new Error("revert");
    expect(run(() => useOrderStatus(`0x${"12".repeat(32)}`)).data).toBeUndefined();
  });
});

describe("useExercisePosition", () => {
  const snap = { ready: true, spotStale: false, clear: CLEAR, optionId: 9n } as unknown as VaultSnapshot;

  it("reads everything from the vault's Clear, the allowance being to that Clear", () => {
    state.answer = (call) => ({
      option: { underlyingAsset: "0x1", underlyingAmount: E18, exerciseAsset: USDG, exerciseAmount: 220_000_000n, exerciseTimestamp: 10n, expiryTimestamp: 20 },
      balanceOf: call.args?.length === 2 ? 2n : 5_000_000n, feesEnabled: false, feeBps: 15, allowance: 1n,
    } as Record<string, unknown>)[call.functionName];
    const { data } = run(() => useExercisePosition(snap, ACCOUNT));
    expect(data).toEqual({ clear: CLEAR, optionId: 9n, underlyingAsset: "0x1", underlyingAmount: E18, exerciseAsset: USDG, strikeUsdg: 220_000_000n,
      exerciseTs: 10, expiryTs: 20, optionBalance: 2n, usdgBalance: 5_000_000n, usdgAllowance: 1n, feesEnabled: false, feeBps: 15 });
    const allowance = state.calls[0]!.contracts.find((c) => c.functionName === "allowance")!;
    expect(allowance).toMatchObject({ address: USDG, args: [ACCOUNT, CLEAR] });
    expect(state.calls[0]!.contracts.filter((c) => c.address === CLEAR).length).toBe(4);
  });

  it("leaves the option fields undefined when the option read fails", () => {
    state.answer = (call) => call.functionName === "option" ? new Error("revert") : 1n;
    const { data } = run(() => useExercisePosition(snap, ACCOUNT));
    expect(data.strikeUsdg).toBeUndefined();
    expect(data.exerciseTs).toBeUndefined();
    expect(data.optionBalance).toBe(1n);
  });

  it.each([
    ["no wallet", snap, undefined],
    ["no Clear", { ...snap, clear: undefined }, ACCOUNT],
    ["option id 0", { ...snap, optionId: 0n }, ACCOUNT],
  ] as const)("is empty with %s", (_label, s, account) => {
    expect(run(() => useExercisePosition(s as VaultSnapshot, account))).toMatchObject({ data: {} });
    expect(state.calls[0]!.contracts).toEqual([]);
  });
});

describe("clock and mount hooks", () => {
  it("useChainTime reads the latest block's timestamp as a number", () => {
    expect(run(() => useChainTime()).timestamp).toBeUndefined();
    state.block = { timestamp: 1_790_000_123n, number: 55n };
    expect(run(() => useChainTime())).toMatchObject({ timestamp: 1_790_000_123, blockNumber: 55n });
  });

  it("useNow is 0 and useMounted is false on the server, so the first client render matches", () => {
    expect(run(() => useNow())).toBe(0);
    expect(run(() => useMounted())).toBe(false);
  });
});

it("LOT_SIZE is one whole Stock Token", () => {
  expect(LOT_SIZE).toBe(E18);
});
