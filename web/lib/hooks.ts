"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Abi, Address, Hex } from "viem";
import { useBlock, useReadContracts } from "wagmi";

import { ASSET, CLEARINGHOUSE, LOT_SIZE, SEAPORT, USDG, VAULT, seaportAbi, stockTokenAbi, valoremClearAbi, vaultAbi } from "./contracts";
import { capacityContracts, strikeBand, type PolicyBps } from "./format";

/* ------------------------------------------------------------------ multicall plumbing --- */

type Call = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
};

type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/**
 * Keep the call list and the result list in lockstep by naming every call.
 *
 * Every read on this page goes out as one Multicall3 batch (the chain definition carries the
 * canonical 0xcA11… address), so an index slip would silently swap two numbers — TVL reading as
 * a timestamp, say — without anything failing. Naming the calls makes that impossible.
 */
function buildBatch(entries: Array<readonly [string, Call | null]>) {
  const names: string[] = [];
  const contracts: Call[] = [];
  for (const [name, call] of entries) {
    if (!call) continue;
    names.push(name);
    contracts.push(call);
  }
  const index = new Map(names.map((n, i) => [n, i] as const));
  return { contracts, index };
}

function readerFor(index: Map<string, number>, data: readonly CallResult[] | undefined) {
  return {
    raw(name: string): unknown {
      const i = index.get(name);
      if (i === undefined || !data) return undefined;
      const entry = data[i];
      if (!entry || entry.status !== "success") return undefined;
      return entry.result;
    },
    /** True when the call itself reverted — meaningful for spotUsdg() and oraclePaused(). */
    reverted(name: string): boolean {
      const i = index.get(name);
      if (i === undefined || !data) return false;
      const entry = data[i];
      return entry?.status === "failure";
    },
  };
}

function big(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hex(value: unknown): Hex | undefined {
  return typeof value === "string" && value.startsWith("0x") ? (value as Hex) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/* ------------------------------------------------------------------------------ phases --- */

export const PHASE_LABELS = ["Idle", "Listed", "Exercisable", "Settling"] as const;
export type Phase = 0 | 1 | 2 | 3;

export function phaseLabel(phase: number | undefined): string {
  if (phase === undefined) return "—";
  return PHASE_LABELS[phase] ?? `Phase ${phase}`;
}

// The fill-state badge and the guard chips are decided in lib/vaultStatus.ts, from this snapshot
// and the clock (a Listed vault past its exercise time is closed whatever its phase says), so the
// snapshot itself carries no clock-free "fill state" that could disagree with the badge.

/* ------------------------------------------------------------------------ vault snapshot --- */

export type VaultSnapshot = {
  /** Present only once the batch has answered. */
  ready: boolean;
  symbol?: string;
  name?: string;
  totalSupply?: bigint;
  totalAssets?: bigint;
  idleAssets?: bigint;
  lockedAssets?: bigint;
  reservedAssets?: bigint;
  assetHeld?: bigint;
  usdgHeld?: bigint;
  phase?: number;
  cycleNumber?: number;
  /** This cycle's clock, snapshotted from the option type at rollOpen. The only deadlines on this site. */
  cycleExerciseTs?: number;
  cycleExpiryTs?: number;
  cycleStrikeUsdg?: bigint;
  optionId?: bigint;
  claimKey?: bigint;
  /** Contracts written this cycle. Equals contracts SOLD: every write happens inside a fill. */
  contractsWritten?: bigint;
  contractsAssigned?: bigint;
  /** Contracts the vault can still write this cycle: maxContracts(totalAssets) − contractsWritten. */
  capacity?: bigint;
  listingHash?: Hex;
  listingGrossUsdg?: bigint;
  listingAmount?: bigint;
  listingsThisCycle?: number;
  /** The vault's Seaport conduit key (zero at deploy). A listing must carry exactly this. */
  conduitKey?: Hex;
  /**
   * `vault.clear()`: the clearinghouse the vault was constructed with, which is a deploy-time
   * choice (Overcall's instance, or one deployed by contracts/script/DeployClear.s.sol; that name
   * is history, the address is not). The offer item of every listing must be THIS contract's
   * ERC-1155 and the week's tuple is read from it, so the chain's answer, not
   * NEXT_PUBLIC_CLEARINGHOUSE, is what the checks and the tuple read use once it has been read;
   * the compiled constant is the fallback until then and a build whose constant disagrees is
   * reported on the cycle page.
   */
  clear?: Address;
  /**
   * `clear.feesEnabled()` on the vault's own clearinghouse. With `valoremFeeAccepted` false this
   * stops every arm and every fill (ValoremFeeNotAccepted); undefined until both reads land.
   */
  clearFeesEnabled?: boolean;
  /** `clear.feeBps()`, read beside it. */
  clearFeeBps?: number;
  accUsdgPerShare?: bigint;
  totalUsdgDistributed?: bigint;
  usdgReservedForQueue?: bigint;
  usdgUnallocated?: bigint;
  queuedShares?: bigint;
  epochId?: bigint;
  writesHalted?: boolean;
  valoremFeeAccepted?: boolean;
  depositCap?: bigint;
  canRedeemInstantly?: boolean;
  /** Anyone may deposit right now (maxDeposit for a zero address is non-zero). Mirrors DepositsClosed. */
  depositsOpen?: boolean;
  uiMultiplier?: bigint;
  /** USDG base units per lot. undefined when the feed is stale — the call reverts, by design. */
  spotUsdg?: bigint;
  spotStale: boolean;
  /** The [min, max] strike the vault would accept at today's spot; the floor is re-checked at every fill. */
  band?: { min: bigint; max: bigint };
  feeRecipient?: Address;
  policy?: PolicyBps;
  /** The stranded-claim state machine (Vault.sol "STRANDED CLAIM"). */
  isStranded?: boolean;
  strandGen?: bigint;
  lastResolvedGen?: bigint;
  /** WAD share of the stranded claim still owned by live shares. Meaningful only while stranded. */
  strandedRemainingWad?: bigint;
  /** Stock Token kill switch. True means the vault cannot write this week at all. */
  oraclePaused?: boolean;
};

const REFRESH_MS = 15_000;

export function useVaultSnapshot() {
  const { contracts, index } = useMemo(() => {
    const vault = (functionName: string, args?: readonly unknown[]): Call | null =>
      VAULT ? { address: VAULT, abi: vaultAbi as unknown as Abi, functionName, args } : null;

    return buildBatch([
      ["symbol", vault("symbol")],
      ["name", vault("name")],
      ["totalSupply", vault("totalSupply")],
      ["totalAssets", vault("totalAssets")],
      ["idleAssets", vault("idleAssets")],
      ["lockedAssets", vault("lockedAssets")],
      ["reservedAssets", vault("reservedAssets")],
      ["phase", vault("phase")],
      ["cycleNumber", vault("cycleNumber")],
      ["cycleExerciseTs", vault("cycleExerciseTs")],
      ["cycleExpiryTs", vault("cycleExpiryTs")],
      ["cycleStrikeUsdg", vault("cycleStrikeUsdg")],
      ["optionId", vault("optionId")],
      ["claimKey", vault("claimKey")],
      ["contractsWritten", vault("contractsWritten")],
      ["contractsAssigned", vault("contractsAssigned")],
      ["listingHash", vault("listingHash")],
      ["listingGrossUsdg", vault("listingGrossUsdg")],
      ["listingAmount", vault("listingAmount")],
      ["listingsThisCycle", vault("listingsThisCycle")],
      ["conduitKey", vault("conduitKey")],
      ["clear", vault("clear")],
      ["accUsdgPerShare", vault("accUsdgPerShare")],
      ["totalUsdgDistributed", vault("totalUsdgDistributed")],
      ["usdgReservedForQueue", vault("usdgReservedForQueue")],
      ["usdgUnallocated", vault("usdgUnallocated")],
      ["queuedShares", vault("queuedShares")],
      ["epochId", vault("epochId")],
      ["writesHalted", vault("writesHalted")],
      ["valoremFeeAccepted", vault("valoremFeeAccepted")],
      ["depositCap", vault("depositCap")],
      ["canRedeemInstantly", vault("canRedeemInstantly")],
      // maxDeposit ignores its argument and returns 0 whenever `deposit` would revert
      // DepositsClosed, so a zero address is enough to ask "are deposits open at all".
      ["maxDepositAny", vault("maxDeposit", ["0x0000000000000000000000000000000000000000"])],
      ["uiMultiplier", vault("uiMultiplier")],
      // spotUsdg() REVERTS when the feed is older than maxPriceAge. That is not a bug to hide:
      // a stale feed is exactly the condition under which the vault refuses to write or sell.
      ["spotUsdg", vault("spotUsdg")],
      ["feeRecipient", vault("feeRecipient")],
      ["policy", vault("policy")],
      ["isStranded", vault("isStranded")],
      ["strandGen", vault("strandGen")],
      ["lastResolvedGen", vault("lastResolvedGen")],
      ["strandedRemainingWad", vault("strandedRemainingWad")],
      [
        "assetHeld",
        VAULT ? { address: ASSET, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [VAULT] } : null,
      ],
      [
        "usdgHeld",
        VAULT ? { address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [VAULT] } : null,
      ],
      ["oraclePaused", { address: ASSET, abi: stockTokenAbi as unknown as Abi, functionName: "oraclePaused" }],
    ]);
  }, []);

  const query = useReadContracts({
    contracts,
    allowFailure: true,
    query: { refetchInterval: REFRESH_MS, staleTime: 5_000 },
  });

  // Clear's fee switch, on the clearinghouse the VAULT names: a dependent read, because the address
  // is only known once `vault.clear()` has answered, and the compiled constant is not asked in its
  // place (a build pointed at another Clear would report that Clear's switch).
  const clearAddress = useMemo(
    () => hex(readerFor(index, query.data as readonly CallResult[] | undefined).raw("clear")) as Address | undefined,
    [index, query.data],
  );
  const feeQuery = useReadContracts({
    contracts:
      clearAddress !== undefined
        ? [
            { address: clearAddress, abi: valoremClearAbi as unknown as Abi, functionName: "feesEnabled" },
            { address: clearAddress, abi: valoremClearAbi as unknown as Abi, functionName: "feeBps" },
          ]
        : [],
    allowFailure: true,
    query: { enabled: clearAddress !== undefined, refetchInterval: REFRESH_MS, staleTime: 5_000 },
  });

  const data = useMemo<VaultSnapshot>(() => {
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);

    // policy() has six separate outputs, so viem decodes it as a positional tuple. (A function
    // with ONE struct output would decode as a named object instead; indexing that by position
    // silently yields undefined.)
    const policyTuple = r.raw("policy") as
      | readonly [number, number, number, number, number, bigint]
      | undefined;
    const policy: PolicyBps | undefined = policyTuple
      ? {
          minOtmBps: Number(policyTuple[0]),
          maxOtmBps: Number(policyTuple[1]),
          minPremiumBps: Number(policyTuple[2]),
          maxUtilizationBps: Number(policyTuple[3]),
          protocolFeeBps: Number(policyTuple[4]),
          maxContractsCap: policyTuple[5],
        }
      : undefined;

    const totalAssets = big(r.raw("totalAssets"));
    const contractsWritten = big(r.raw("contractsWritten"));
    const capacity = capacityContracts(totalAssets, contractsWritten, policy);
    const spotUsdg = big(r.raw("spotUsdg"));
    const maxDepositAny = big(r.raw("maxDepositAny"));

    const fee = feeQuery.data as readonly CallResult[] | undefined;
    const feeRead = (i: number): unknown => (fee?.[i]?.status === "success" ? (fee[i] as { result: unknown }).result : undefined);

    return {
      ready: query.data !== undefined,
      symbol: str(r.raw("symbol")),
      name: str(r.raw("name")),
      totalSupply: big(r.raw("totalSupply")),
      totalAssets,
      idleAssets: big(r.raw("idleAssets")),
      lockedAssets: big(r.raw("lockedAssets")),
      reservedAssets: big(r.raw("reservedAssets")),
      assetHeld: big(r.raw("assetHeld")),
      usdgHeld: big(r.raw("usdgHeld")),
      phase: num(r.raw("phase")),
      claimKey: big(r.raw("claimKey")),
      contractsWritten,
      contractsAssigned: big(r.raw("contractsAssigned")),
      capacity,
      cycleNumber: num(r.raw("cycleNumber")),
      cycleExerciseTs: num(r.raw("cycleExerciseTs")),
      cycleExpiryTs: num(r.raw("cycleExpiryTs")),
      cycleStrikeUsdg: big(r.raw("cycleStrikeUsdg")),
      optionId: big(r.raw("optionId")),
      listingHash: hex(r.raw("listingHash")),
      listingGrossUsdg: big(r.raw("listingGrossUsdg")),
      listingAmount: big(r.raw("listingAmount")),
      listingsThisCycle: num(r.raw("listingsThisCycle")),
      conduitKey: hex(r.raw("conduitKey")),
      clear: hex(r.raw("clear")) as Address | undefined,
      clearFeesEnabled: bool(feeRead(0)),
      clearFeeBps: num(feeRead(1)),
      accUsdgPerShare: big(r.raw("accUsdgPerShare")),
      totalUsdgDistributed: big(r.raw("totalUsdgDistributed")),
      usdgReservedForQueue: big(r.raw("usdgReservedForQueue")),
      usdgUnallocated: big(r.raw("usdgUnallocated")),
      queuedShares: big(r.raw("queuedShares")),
      epochId: big(r.raw("epochId")),
      writesHalted: bool(r.raw("writesHalted")),
      valoremFeeAccepted: bool(r.raw("valoremFeeAccepted")),
      depositCap: big(r.raw("depositCap")),
      canRedeemInstantly: bool(r.raw("canRedeemInstantly")),
      depositsOpen: maxDepositAny === undefined ? undefined : maxDepositAny > 0n,
      uiMultiplier: big(r.raw("uiMultiplier")),
      spotUsdg,
      spotStale: r.reverted("spotUsdg"),
      band: strikeBand(spotUsdg, policy),
      feeRecipient: hex(r.raw("feeRecipient")) as Address | undefined,
      policy,
      isStranded: bool(r.raw("isStranded")),
      strandGen: big(r.raw("strandGen")),
      lastResolvedGen: big(r.raw("lastResolvedGen")),
      strandedRemainingWad: big(r.raw("strandedRemainingWad")),
      // A token that does not expose oraclePaused() makes the call revert; that is "not paused",
      // not "paused". Same posture the vault itself takes with its staticcall probe.
      oraclePaused: r.reverted("oraclePaused") ? false : bool(r.raw("oraclePaused")),
    };
  }, [index, query.data, feeQuery.data]);

  return { data, isLoading: query.isLoading, isError: query.isError, error: query.error, refetch: query.refetch };
}

/* ------------------------------------------------------------------- this week's option --- */

export type CycleOption = {
  /** Valorem's tuple for the armed option id, read from the clearinghouse. */
  underlyingAsset?: Address;
  underlyingAmount?: bigint;
  exerciseAsset?: Address;
  /** Strike per contract, USDG base units (6 dec). Valorem's `exerciseAmount`. */
  strikeUsdg?: bigint;
  exerciseTs?: number;
  expiryTs?: number;
  /** Distance above spot, in basis points. undefined when spot is unavailable. */
  otmBps?: number;
  /** The vault's own snapshot of the same tuple agrees with the clearinghouse's. */
  agreesWithVault?: boolean;
};

/**
 * The option type the vault armed this cycle, read back from the clearinghouse. There is no
 * registry and no ladder: the keeper creates one type a week (`clear.newOptionType`) and the
 * vault checks its tuple at rollOpen (asset, USDG, one-token lot, window, both band bounds) and
 * snapshots strike, exercise and expiry. Reading the tuple here too means a disagreement shows up
 * on screen instead of being trusted from one side. The clearinghouse asked is the one the vault
 * names (`snapshot.clear`), the compiled constant only until that read has landed.
 */
export function useCycleOption(snapshot: VaultSnapshot) {
  const optionId = snapshot.optionId;
  const clearinghouse = snapshot.clear ?? CLEARINGHOUSE;
  const enabled = optionId !== undefined && optionId !== 0n;

  const query = useReadContracts({
    contracts: enabled
      ? [{ address: clearinghouse, abi: valoremClearAbi as unknown as Abi, functionName: "option", args: [optionId] }]
      : [],
    allowFailure: true,
    query: { enabled, refetchInterval: 60_000, staleTime: 30_000 },
  });

  const data = useMemo<CycleOption | undefined>(() => {
    const entry = (query.data as readonly CallResult[] | undefined)?.[0];
    if (!entry || entry.status !== "success") return undefined;
    const option = entry.result as {
      underlyingAsset: Address;
      underlyingAmount: bigint;
      exerciseAsset: Address;
      exerciseAmount: bigint;
      exerciseTimestamp: number;
      expiryTimestamp: number;
    };
    const strikeUsdg = option.exerciseAmount;
    const spot = snapshot.spotUsdg;
    const exerciseTs = Number(option.exerciseTimestamp);
    const expiryTs = Number(option.expiryTimestamp);
    return {
      underlyingAsset: option.underlyingAsset,
      underlyingAmount: option.underlyingAmount,
      exerciseAsset: option.exerciseAsset,
      strikeUsdg,
      exerciseTs,
      expiryTs,
      otmBps: spot !== undefined && spot > 0n ? Number(((strikeUsdg - spot) * 10_000n) / spot) : undefined,
      agreesWithVault:
        snapshot.cycleStrikeUsdg === undefined || snapshot.cycleExerciseTs === undefined || snapshot.cycleExpiryTs === undefined
          ? undefined
          : snapshot.cycleStrikeUsdg === strikeUsdg && snapshot.cycleExerciseTs === exerciseTs && snapshot.cycleExpiryTs === expiryTs,
    };
  }, [query.data, snapshot.spotUsdg, snapshot.cycleStrikeUsdg, snapshot.cycleExerciseTs, snapshot.cycleExpiryTs]);

  return { data, isLoading: query.isLoading };
}

/* ------------------------------------------------------------------------ account state --- */

export type AccountPosition = {
  ready: boolean;
  /** Free shares — total balance minus whatever is escrowed in the redeem queue. */
  shares?: bigint;
  queuedShares?: bigint;
  queuedEpoch?: bigint;
  /** Assets those shares are worth right now at the raw share price. */
  sharesValueAssets?: bigint;
  claimableUsdg?: bigint;
  /** Non-zero only once the queued epoch has settled (and includes a resolved stranded share). */
  pendingAssets?: bigint;
  pendingUsdg?: bigint;
  assetBalance?: bigint;
  assetAllowance?: bigint;
  usdgBalance?: bigint;
  maxDeposit?: bigint;
  /** WAD share of a stranded claim staged against this account by a settled queue entry. */
  owedStrandWad?: bigint;
  owedStrandGen?: bigint;
  /** The queued epoch's own WAD share of a stranded claim (0 for an epoch that settled while flat). */
  epochStrandWad?: bigint;
  epochStrandGen?: bigint;
  /** Shares still in the queued epoch, the denominator of this account's slice of it. */
  epochSharesRemaining?: bigint;
};

export function useAccountPosition(address: Address | undefined) {
  const { contracts, index } = useMemo(() => {
    if (!VAULT || !address) return buildBatch([]);
    // Bind the narrowed value: `VAULT` is a module const of type `Address | undefined`, and the
    // narrowing above does not survive into the closures below.
    const vaultAddress = VAULT;
    const vault = (functionName: string, args?: readonly unknown[]): Call => ({
      address: vaultAddress,
      abi: vaultAbi as unknown as Abi,
      functionName,
      args,
    });
    return buildBatch([
      ["balance", vault("balanceOf", [address])],
      ["queuedShares", vault("queuedSharesOf", [address])],
      ["queuedEpoch", vault("queuedEpochOf", [address])],
      ["claimable", vault("claimableUsdg", [address])],
      ["pending", vault("previewCompleteRedeem", [address])],
      ["maxDeposit", vault("maxDeposit", [address])],
      ["owedStrandWad", vault("owedStrandWad", [address])],
      ["owedStrandGen", vault("owedStrandGen", [address])],
      [
        "assetBalance",
        { address: ASSET, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [address] },
      ],
      [
        "assetAllowance",
        {
          address: ASSET,
          abi: stockTokenAbi as unknown as Abi,
          functionName: "allowance",
          args: [address, vaultAddress],
        },
      ],
      [
        "usdgBalance",
        { address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [address] },
      ],
    ]);
  }, [address]);

  const query = useReadContracts({
    contracts,
    allowFailure: true,
    query: { enabled: contracts.length > 0, refetchInterval: REFRESH_MS, staleTime: 5_000 },
  });

  const { balance, queuedEpoch, queued } = useMemo(() => {
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);
    return { balance: big(r.raw("balance")), queuedEpoch: big(r.raw("queuedEpoch")), queued: big(r.raw("queuedShares")) ?? 0n };
  }, [index, query.data]);

  // convertToAssets needs the balance, and the queued epoch's strand share needs the epoch, so
  // these are a second, dependent read rather than a guess.
  const dependent = useReadContracts({
    contracts:
      VAULT && balance !== undefined
        ? [
            { address: VAULT, abi: vaultAbi as unknown as Abi, functionName: "convertToAssets", args: [balance] },
            ...(queued > 0n && queuedEpoch !== undefined
              ? [
                  { address: VAULT, abi: vaultAbi as unknown as Abi, functionName: "epochStrandWad", args: [queuedEpoch] },
                  { address: VAULT, abi: vaultAbi as unknown as Abi, functionName: "epochStrandGen", args: [queuedEpoch] },
                  { address: VAULT, abi: vaultAbi as unknown as Abi, functionName: "epochs", args: [queuedEpoch] },
                ]
              : []),
          ]
        : [],
    allowFailure: true,
    query: { enabled: VAULT !== undefined && balance !== undefined, staleTime: 5_000 },
  });

  const data = useMemo<AccountPosition>(() => {
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);
    const pending = r.raw("pending") as readonly [bigint, bigint] | undefined;
    const total = big(r.raw("balance"));
    const dep = dependent.data as readonly CallResult[] | undefined;
    const ok = (i: number): unknown => (dep?.[i]?.status === "success" ? dep[i]!.result : undefined);
    // epochs(id) has three named outputs and decodes positionally.
    const epoch = ok(3) as readonly [bigint, bigint, bigint] | undefined;
    return {
      ready: query.data !== undefined,
      // The vault escrows queued shares by transferring them to itself, so balanceOf already
      // excludes them. Reported as-is: this is the number the user can still act on.
      shares: total,
      queuedShares: queued,
      queuedEpoch,
      sharesValueAssets: big(ok(0)),
      claimableUsdg: big(r.raw("claimable")),
      pendingAssets: pending?.[0],
      pendingUsdg: pending?.[1],
      assetBalance: big(r.raw("assetBalance")),
      assetAllowance: big(r.raw("assetAllowance")),
      usdgBalance: big(r.raw("usdgBalance")),
      maxDeposit: big(r.raw("maxDeposit")),
      owedStrandWad: big(r.raw("owedStrandWad")),
      owedStrandGen: big(r.raw("owedStrandGen")),
      epochStrandWad: big(ok(1)),
      epochStrandGen: big(ok(2)),
      epochSharesRemaining: epoch?.[0],
    };
  }, [index, query.data, dependent.data, queued, queuedEpoch]);

  return {
    data,
    isLoading: query.isLoading,
    refetch: async () => {
      await query.refetch();
      await dependent.refetch();
    },
  };
}

/* ------------------------------------------------------------------ seaport order status --- */

export type OrderStatus = {
  isValidated?: boolean;
  isCancelled?: boolean;
  totalFilled?: bigint;
  totalSize?: bigint;
};

/** Seaport's own view of our listing. The one answer that cannot be spun. */
export function useOrderStatus(orderHash: Hex | undefined) {
  const enabled =
    orderHash !== undefined && orderHash !== "0x" && /^0x0*$/.test(orderHash) === false;

  const query = useReadContracts({
    contracts: enabled
      ? [{ address: SEAPORT, abi: seaportAbi as unknown as Abi, functionName: "getOrderStatus", args: [orderHash] }]
      : [],
    allowFailure: true,
    query: { enabled, refetchInterval: REFRESH_MS },
  });

  const data = useMemo<OrderStatus | undefined>(() => {
    const entry = (query.data as readonly CallResult[] | undefined)?.[0];
    if (!entry || entry.status !== "success") return undefined;
    const tuple = entry.result as readonly [boolean, boolean, bigint, bigint];
    return {
      isValidated: tuple[0],
      isCancelled: tuple[1],
      totalFilled: tuple[2],
      totalSize: tuple[3],
    };
  }, [query.data]);

  return { data, isLoading: query.isLoading };
}

/* ------------------------------------------------------------------------- exercising --- */

/**
 * The chain's clock: the latest block's timestamp, in whole seconds, polled every few seconds.
 * Undefined until the first block has been read.
 *
 * The exercise button is gated on THIS, not on useNow(): the clearinghouse compares its window
 * with `block.timestamp`, a device clock can run fast, and a fork can be warped days ahead of the
 * wall. A mined block's timestamp is never later than the block after it, so nothing gated on this
 * opens early; lib/exercise.ts explains the one-block lag at the closing edge.
 */
export function useChainTime() {
  const query = useBlock({ blockTag: "latest", query: { refetchInterval: 4_000, staleTime: 2_000 } });
  return {
    timestamp: query.data === undefined ? undefined : Number(query.data.timestamp),
    blockNumber: query.data?.number ?? undefined,
    refetch: query.refetch,
  };
}

export type ExercisePosition = {
  /** The clearinghouse the reads went to and an exercise goes to: the vault's own `clear()`. */
  clear?: Address;
  optionId?: bigint;
  /** Valorem's tuple for the option id, read from that clearinghouse, not from the keeper. */
  underlyingAsset?: Address;
  /** NVDA base units per contract. */
  underlyingAmount?: bigint;
  exerciseAsset?: Address;
  /** Strike per contract, USDG base units. */
  strikeUsdg?: bigint;
  exerciseTs?: number;
  expiryTs?: number;
  /** The account's balance of the option ERC-1155. */
  optionBalance?: bigint;
  usdgBalance?: bigint;
  /** The account's USDG allowance to the clearinghouse. */
  usdgAllowance?: bigint;
  feesEnabled?: boolean;
  feeBps?: number;
};

/**
 * What the Exercise card needs for one account, in one multicall against the clearinghouse the
 * VAULT names (`snapshot.clear`; never the compiled constant, because an exercise is sent there):
 * the option tuple, the account's option balance, its USDG balance and allowance to that
 * clearinghouse, and the clearinghouse's fee switch. Disabled until the vault, its option id and a
 * wallet are all known.
 */
export function useExercisePosition(snapshot: VaultSnapshot, account: Address | undefined) {
  const clear = snapshot.clear;
  const optionId = snapshot.optionId;
  const enabled = clear !== undefined && optionId !== undefined && optionId !== 0n && account !== undefined;

  const { contracts, index } = useMemo(() => {
    if (!enabled) return buildBatch([]);
    const onClear = (functionName: string, args?: readonly unknown[]): Call => ({
      address: clear,
      abi: valoremClearAbi as unknown as Abi,
      functionName,
      args,
    });
    return buildBatch([
      ["option", onClear("option", [optionId])],
      ["optionBalance", onClear("balanceOf", [account, optionId])],
      ["feesEnabled", onClear("feesEnabled")],
      ["feeBps", onClear("feeBps")],
      ["usdgBalance", { address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [account] }],
      ["usdgAllowance", { address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "allowance", args: [account, clear] }],
    ]);
  }, [enabled, clear, optionId, account]);

  const query = useReadContracts({
    contracts,
    allowFailure: true,
    query: { enabled: contracts.length > 0, refetchInterval: REFRESH_MS, staleTime: 5_000 },
  });

  const data = useMemo<ExercisePosition>(() => {
    if (!enabled) return {};
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);
    const option = r.raw("option") as
      | {
          underlyingAsset: Address;
          underlyingAmount: bigint;
          exerciseAsset: Address;
          exerciseAmount: bigint;
          exerciseTimestamp: number;
          expiryTimestamp: number;
        }
      | undefined;
    return {
      clear,
      optionId,
      underlyingAsset: option?.underlyingAsset,
      underlyingAmount: option === undefined ? undefined : big(option.underlyingAmount),
      exerciseAsset: option?.exerciseAsset,
      strikeUsdg: option === undefined ? undefined : big(option.exerciseAmount),
      exerciseTs: option === undefined ? undefined : num(option.exerciseTimestamp),
      expiryTs: option === undefined ? undefined : num(option.expiryTimestamp),
      optionBalance: big(r.raw("optionBalance")),
      usdgBalance: big(r.raw("usdgBalance")),
      usdgAllowance: big(r.raw("usdgAllowance")),
      feesEnabled: bool(r.raw("feesEnabled")),
      feeBps: num(r.raw("feeBps")),
    };
  }, [enabled, index, query.data, clear, optionId]);

  return { data, isLoading: query.isLoading, refetch: query.refetch };
}

/* ---------------------------------------------------------------------------------- misc --- */

/**
 * A ticking clock, in whole seconds, that only starts on the client.
 *
 * Returns 0 until mounted so that server-rendered markup and the first client render agree;
 * every countdown renders "—" for that one frame rather than hydration-mismatching.
 */
export function useNow(): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const NEVER_CHANGES = () => () => {};

/**
 * True once the component has mounted on the client. Guards wallet-dependent markup.
 *
 * useSyncExternalStore rather than a setState-in-an-effect: React calls the server snapshot
 * during hydration and the client snapshot afterwards, so this flips exactly once without a
 * cascading render.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false,
  );
}

/**
 * Where the vault's collateral sits right now, in RAW asset base units.
 *
 *   idle     — free collateral, the base every fill is sized against.
 *   sold     — locked behind calls a buyer owns. Under write on fill this is ALL the locked
 *              collateral: nothing is written until it is sold, so there is no "listed but
 *              unsold" slice, by construction.
 *   assigned — already taken at the strike.
 *
 * One contract is exactly one lot (Policy.LOT, compiled in and checked at rollOpen), so the
 * assigned figure is `contractsAssigned × 1e18`; the sold figure is what Valorem still holds for
 * the claim (`lockedAssets`), which already excludes assigned lots.
 */
export function collateralSplit(v: VaultSnapshot): {
  idle?: bigint;
  sold: bigint;
  assigned: bigint;
} {
  return {
    idle: v.idleAssets,
    sold: v.lockedAssets ?? 0n,
    assigned: (v.contractsAssigned ?? 0n) * LOT_SIZE,
  };
}
