"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Abi, Address, Hex } from "viem";
import { useReadContracts } from "wagmi";

import {
  ASSET,
  CLEARINGHOUSE,
  LOT_SIZE,
  REGISTRY,
  SEAPORT,
  USDG,
  VAULT,
  overcallRegistryAbi,
  seaportAbi,
  stockTokenAbi,
  valoremClearAbi,
  vaultAbi,
} from "./contracts";

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

/**
 * What the week is actually doing, in the product's own words. This is the state the site
 * promises to publish honestly — "unfilled" included, because it is the most likely one.
 */
export type FillState =
  | "unknown" // nothing read yet, or no vault configured
  | "flat" // no call written; the vault is holding spot
  | "listed" // written and listed, no buyer yet
  | "partial" // some contracts sold
  | "filled" // every written contract sold
  | "locked" // past book close, no more listing
  | "settling" // past expiry, reclaiming
  | "assigned" // past book close, and part of the claim has been assigned
  | "unfilled"; // past book close with nothing sold: no premium (it can still be assigned)

export const FILL_STATE_COPY: Record<FillState, string> = {
  unknown: "State unavailable",
  flat: "Flat — no call written",
  listed: "Listed — waiting for a buyer",
  partial: "Partially filled",
  filled: "Filled",
  locked: "Book closed",
  settling: "Settling",
  assigned: "Assigned",
  unfilled: "Book closed, unsold",
};

function deriveFillState(v: {
  phase?: number;
  contractsWritten?: bigint;
  contractsSold?: bigint;
  contractsAssigned?: bigint;
}): FillState {
  // No phase means no answer yet (or no vault configured). Saying "flat" would be asserting
  // something about a vault we have not read.
  if (v.phase === undefined) return "unknown";
  const written = v.contractsWritten ?? 0n;
  const sold = v.contractsSold ?? 0n;
  const assigned = v.contractsAssigned ?? 0n;
  switch (v.phase) {
    case 1:
      if (sold === 0n) return "listed";
      return sold >= written && written > 0n ? "filled" : "partial";
    case 2:
      // Exercisable: the claim is still open, so assignment is readable here and only here.
      // rollClose zeroes contractsWritten and the claim key, which makes every Idle read "flat";
      // the closed week's result comes from history (the "Result" row), never from this badge.
      if (assigned > 0n) return "assigned";
      return sold === 0n ? "unfilled" : "locked";
    case 3:
      return "settling";
    case 0:
    default:
      return "flat";
  }
}

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
  fillState: FillState;
  cycleNumber?: number;
  cycleExerciseTs?: number;
  cycleExpiryTs?: number;
  cycleStrikeUsdg?: bigint;
  optionId?: bigint;
  claimKey?: bigint;
  contractsWritten?: bigint;
  contractsSold?: bigint;
  contractsRemaining?: bigint;
  contractsAssigned?: bigint;
  listingHash?: Hex;
  listingGrossUsdg?: bigint;
  listingAmount?: bigint;
  listingsThisCycle?: number;
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
  uiMultiplier?: bigint;
  /** USDG base units per lot. undefined when the feed is stale — the call reverts, by design. */
  spotUsdg?: bigint;
  spotStale: boolean;
  feeRecipient?: Address;
  policy?: {
    minOtmBps: number;
    maxOtmBps: number;
    minPremiumBps: number;
    maxUtilizationBps: number;
    protocolFeeBps: number;
    maxContractsCap: bigint;
  };
  /** Registry, the single source of truth for every deadline on this site. */
  registryCycleNumber?: number;
  registryExerciseTs?: number;
  registryExpiryTs?: number;
  registryLotSize?: bigint;
  registryOptionIds?: readonly bigint[];
  isWritingOpen?: boolean;
  isCycleLive?: boolean;
  writeDeadline?: number;
  /** Stock Token kill switch. True means the vault cannot write this week at all. */
  oraclePaused?: boolean;
};

const REFRESH_MS = 15_000;

export function useVaultSnapshot() {
  const { contracts, index } = useMemo(() => {
    const vault = (functionName: string, args?: readonly unknown[]): Call | null =>
      VAULT ? { address: VAULT, abi: vaultAbi as unknown as Abi, functionName, args } : null;
    const registry = (functionName: string): Call => ({
      address: REGISTRY,
      abi: overcallRegistryAbi as unknown as Abi,
      functionName,
    });

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
      ["contractsSold", vault("contractsSold")],
      ["contractsRemaining", vault("contractsRemaining")],
      ["contractsAssigned", vault("contractsAssigned")],
      ["listingHash", vault("listingHash")],
      ["listingGrossUsdg", vault("listingGrossUsdg")],
      ["listingAmount", vault("listingAmount")],
      ["listingsThisCycle", vault("listingsThisCycle")],
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
      ["uiMultiplier", vault("uiMultiplier")],
      // spotUsdg() REVERTS when the feed is older than maxPriceAge. That is not a bug to hide:
      // a stale feed is exactly the condition under which the vault refuses to write.
      ["spotUsdg", vault("spotUsdg")],
      ["feeRecipient", vault("feeRecipient")],
      ["policy", vault("policy")],
      [
        "assetHeld",
        VAULT ? { address: ASSET, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [VAULT] } : null,
      ],
      [
        "usdgHeld",
        VAULT ? { address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [VAULT] } : null,
      ],
      ["oraclePaused", { address: ASSET, abi: stockTokenAbi as unknown as Abi, functionName: "oraclePaused" }],
      ["registryCycle", registry("cycle")],
      ["isWritingOpen", registry("isWritingOpen")],
      ["isCycleLive", registry("isCycleLive")],
      ["writeDeadline", registry("writeDeadline")],
      ["registryLotSize", registry("lotSize")],
      ["registryCycleNumber", registry("cycleNumber")],
    ]);
  }, []);

  const query = useReadContracts({
    contracts,
    allowFailure: true,
    query: { refetchInterval: REFRESH_MS, staleTime: 5_000 },
  });

  const data = useMemo<VaultSnapshot>(() => {
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);

    /**
     * registry.cycle() has ONE output that is a struct with named components, so viem decodes it
     * as a named object — not as a positional tuple. (A function with several separate outputs,
     * like policy() below, does decode to an array.) Indexing this by position silently yields
     * undefined, which turns every countdown into NaN and empties the ladder.
     */
    const cycleStruct = r.raw("registryCycle") as
      | {
          number: number;
          exerciseTimestamp: number;
          expiryTimestamp: number;
          lotSize: bigint;
          optionIds: readonly bigint[];
        }
      | undefined;

    const policyTuple = r.raw("policy") as
      | readonly [number, number, number, number, number, bigint]
      | undefined;

    const base = {
      phase: num(r.raw("phase")),
      contractsWritten: big(r.raw("contractsWritten")),
      contractsSold: big(r.raw("contractsSold")),
      contractsAssigned: big(r.raw("contractsAssigned")),
    };

    return {
      ready: query.data !== undefined,
      symbol: str(r.raw("symbol")),
      name: str(r.raw("name")),
      totalSupply: big(r.raw("totalSupply")),
      totalAssets: big(r.raw("totalAssets")),
      idleAssets: big(r.raw("idleAssets")),
      lockedAssets: big(r.raw("lockedAssets")),
      reservedAssets: big(r.raw("reservedAssets")),
      assetHeld: big(r.raw("assetHeld")),
      usdgHeld: big(r.raw("usdgHeld")),
      ...base,
      fillState: deriveFillState(base),
      cycleNumber: num(r.raw("cycleNumber")),
      cycleExerciseTs: num(r.raw("cycleExerciseTs")),
      cycleExpiryTs: num(r.raw("cycleExpiryTs")),
      cycleStrikeUsdg: big(r.raw("cycleStrikeUsdg")),
      optionId: big(r.raw("optionId")),
      claimKey: big(r.raw("claimKey")),
      contractsRemaining: big(r.raw("contractsRemaining")),
      listingHash: hex(r.raw("listingHash")),
      listingGrossUsdg: big(r.raw("listingGrossUsdg")),
      listingAmount: big(r.raw("listingAmount")),
      listingsThisCycle: num(r.raw("listingsThisCycle")),
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
      uiMultiplier: big(r.raw("uiMultiplier")),
      spotUsdg: big(r.raw("spotUsdg")),
      spotStale: r.reverted("spotUsdg"),
      feeRecipient: hex(r.raw("feeRecipient")) as Address | undefined,
      policy: policyTuple
        ? {
            minOtmBps: Number(policyTuple[0]),
            maxOtmBps: Number(policyTuple[1]),
            minPremiumBps: Number(policyTuple[2]),
            maxUtilizationBps: Number(policyTuple[3]),
            protocolFeeBps: Number(policyTuple[4]),
            maxContractsCap: policyTuple[5],
          }
        : undefined,
      registryCycleNumber: num(r.raw("registryCycleNumber")) ?? num(cycleStruct?.number),
      registryExerciseTs: num(cycleStruct?.exerciseTimestamp),
      registryExpiryTs: num(cycleStruct?.expiryTimestamp),
      registryLotSize: big(r.raw("registryLotSize")) ?? big(cycleStruct?.lotSize),
      registryOptionIds: cycleStruct?.optionIds,
      isWritingOpen: bool(r.raw("isWritingOpen")),
      isCycleLive: bool(r.raw("isCycleLive")),
      writeDeadline: num(r.raw("writeDeadline")),
      // A token that does not expose oraclePaused() makes the call revert; that is "not paused",
      // not "paused". Same posture the vault itself takes with its staticcall probe.
      oraclePaused: r.reverted("oraclePaused") ? false : bool(r.raw("oraclePaused")),
    };
  }, [index, query.data]);

  return { data, isLoading: query.isLoading, isError: query.isError, error: query.error, refetch: query.refetch };
}

/* -------------------------------------------------------------------------- the 5 rungs --- */

export type Rung = {
  optionId: bigint;
  /** Strike per contract, USDG base units (6 dec). */
  strikeUsdg?: bigint;
  underlyingAmount?: bigint;
  exerciseTs?: number;
  expiryTs?: number;
  approved?: boolean;
  /** True when this is the rung the vault wrote this week. */
  picked: boolean;
  /** Distance above spot, in basis points. undefined when spot is unavailable. */
  otmBps?: number;
  /** Inside the policy band, i.e. a rung the vault is allowed to write. */
  inBand?: boolean;
};

/**
 * The Overcall ladder for the live cycle: one row per approved rung, ascending by strike.
 *
 * Strikes come from registry.strikePerContract(), cross-checked against
 * ValoremClear.option().exerciseAmount. They agree — the registry is derived from the option
 * series — but reading both means a mismatch shows up on screen instead of in a failed write.
 */
export function useLadder(snapshot: VaultSnapshot) {
  const optionIds = snapshot.registryOptionIds;

  const { contracts, index } = useMemo(() => {
    const entries: Array<readonly [string, Call | null]> = [];
    for (const id of optionIds ?? []) {
      const key = id.toString();
      entries.push([
        `strike:${key}`,
        { address: REGISTRY, abi: overcallRegistryAbi as unknown as Abi, functionName: "strikePerContract", args: [id] },
      ]);
      entries.push([
        `approved:${key}`,
        { address: REGISTRY, abi: overcallRegistryAbi as unknown as Abi, functionName: "isApproved", args: [id] },
      ]);
      entries.push([
        `option:${key}`,
        { address: CLEARINGHOUSE, abi: valoremClearAbi as unknown as Abi, functionName: "option", args: [id] },
      ]);
    }
    return buildBatch(entries);
  }, [optionIds]);

  const query = useReadContracts({
    contracts,
    allowFailure: true,
    query: { enabled: contracts.length > 0, refetchInterval: 60_000, staleTime: 30_000 },
  });

  const rungs = useMemo<Rung[]>(() => {
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);
    const spot = snapshot.spotUsdg;
    const policy = snapshot.policy;

    const rows: Rung[] = (optionIds ?? []).map((id) => {
      const key = id.toString();
      const option = r.raw(`option:${key}`) as
        | {
            underlyingAsset: Address;
            underlyingAmount: bigint;
            exerciseAsset: Address;
            exerciseAmount: bigint;
            exerciseTimestamp: number;
            expiryTimestamp: number;
          }
        | undefined;

      const strikeUsdg = big(r.raw(`strike:${key}`)) ?? option?.exerciseAmount;
      const otmBps =
        strikeUsdg !== undefined && spot !== undefined && spot > 0n
          ? Number(((strikeUsdg - spot) * 10_000n) / spot)
          : undefined;

      return {
        optionId: id,
        strikeUsdg,
        underlyingAmount: option?.underlyingAmount,
        exerciseTs: option ? Number(option.exerciseTimestamp) : undefined,
        expiryTs: option ? Number(option.expiryTimestamp) : undefined,
        approved: bool(r.raw(`approved:${key}`)),
        picked: snapshot.optionId !== undefined && snapshot.optionId !== 0n && snapshot.optionId === id,
        otmBps,
        inBand:
          otmBps === undefined || !policy
            ? undefined
            : otmBps >= policy.minOtmBps && otmBps <= policy.maxOtmBps,
      };
    });

    rows.sort((a, b) => {
      const x = a.strikeUsdg ?? 0n;
      const y = b.strikeUsdg ?? 0n;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return rows;
  }, [index, query.data, optionIds, snapshot.spotUsdg, snapshot.policy, snapshot.optionId]);

  return { rungs, isLoading: query.isLoading };
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
  /** Non-zero only once the queued epoch has settled. */
  pendingAssets?: bigint;
  pendingUsdg?: bigint;
  assetBalance?: bigint;
  assetAllowance?: bigint;
  usdgBalance?: bigint;
  maxDeposit?: bigint;
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

  const balance = useMemo(() => {
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);
    return big(r.raw("balance"));
  }, [index, query.data]);

  // convertToAssets needs the balance, so it is a second, dependent read rather than a guess.
  const convert = useReadContracts({
    contracts:
      VAULT && balance !== undefined
        ? [{ address: VAULT, abi: vaultAbi as unknown as Abi, functionName: "convertToAssets", args: [balance] }]
        : [],
    allowFailure: true,
    query: { enabled: VAULT !== undefined && balance !== undefined, staleTime: 5_000 },
  });

  const data = useMemo<AccountPosition>(() => {
    const r = readerFor(index, query.data as readonly CallResult[] | undefined);
    const pending = r.raw("pending") as readonly [bigint, bigint] | undefined;
    const queued = big(r.raw("queuedShares")) ?? 0n;
    const total = big(r.raw("balance"));
    const convertResult = (convert.data as readonly CallResult[] | undefined)?.[0];
    return {
      ready: query.data !== undefined,
      // The vault escrows queued shares by transferring them to itself, so balanceOf already
      // excludes them. Reported as-is: this is the number the user can still act on.
      shares: total,
      queuedShares: queued,
      queuedEpoch: big(r.raw("queuedEpoch")),
      sharesValueAssets:
        convertResult && convertResult.status === "success" ? big(convertResult.result) : undefined,
      claimableUsdg: big(r.raw("claimable")),
      pendingAssets: pending?.[0],
      pendingUsdg: pending?.[1],
      assetBalance: big(r.raw("assetBalance")),
      assetAllowance: big(r.raw("assetAllowance")),
      usdgBalance: big(r.raw("usdgBalance")),
      maxDeposit: big(r.raw("maxDeposit")),
    };
  }, [index, query.data, convert.data]);

  return {
    data,
    isLoading: query.isLoading,
    refetch: async () => {
      await query.refetch();
      await convert.refetch();
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
 * The per-contract collateral is NOT a constant. `rollOpen` locks `n * cycle.lotSize` and the
 * lot size is a registry field the owner can change between cycles (`LotSizeSet`), so
 * multiplying a contract count by a hardcoded 1e18 would misreport the split the moment
 * Overcall moves it. Derive it from what the vault actually locked — lockedAssets /
 * contractsWritten — and fall back to the registry's live lotSize, then to the launch lot size,
 * only when there is nothing written to derive from.
 */
export function collateralSplit(v: VaultSnapshot): {
  idle?: bigint;
  listed: bigint;
  sold: bigint;
  assigned: bigint;
} {
  const written = v.contractsWritten ?? 0n;
  const locked = v.lockedAssets ?? 0n;
  const registryLot = v.registryLotSize !== undefined && v.registryLotSize > 0n ? v.registryLotSize : LOT_SIZE;
  // lockedAssets already excludes assigned lots, so divide by the contracts still behind the
  // claim. Dividing by `written` after an exercise under-reports every lot (11e18 / 14, not 1e18).
  const assignedCount = v.contractsAssigned ?? 0n;
  const unassigned = written > assignedCount ? written - assignedCount : 0n;
  const perContract = unassigned > 0n && locked > 0n ? locked / unassigned : registryLot;

  const soldRaw = (v.contractsSold ?? 0n) * perContract;
  // Clamp: contractsSold is derived from the ERC-1155 balance and locked collateral is the
  // authority, so a rounding edge must never paint more "sold" than the vault has locked.
  const sold = soldRaw > locked ? locked : soldRaw;
  return {
    idle: v.idleAssets,
    listed: locked > sold ? locked - sold : 0n,
    sold,
    assigned: (v.contractsAssigned ?? 0n) * perContract,
  };
}

/** Contracts the vault could still write, from idle assets and the utilization cap. */
export function writableContracts(snapshot: VaultSnapshot): bigint | undefined {
  if (snapshot.idleAssets === undefined || !snapshot.policy) return undefined;
  const byUtilization =
    (snapshot.idleAssets * BigInt(snapshot.policy.maxUtilizationBps)) / 10_000n / LOT_SIZE;
  const cap = snapshot.policy.maxContractsCap;
  return byUtilization < cap ? byUtilization : cap;
}
