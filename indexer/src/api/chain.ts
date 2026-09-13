import { publicClients } from "ponder:api";
import type { Address } from "viem";

import { stockTokenAbi } from "../../abis/stockToken";
import { overcallRegistryAbi } from "../../abis/overcallRegistry";
import { vaultAbi } from "../../abis/vault";
import {
  ASSET,
  CHAIN_NAME,
  LIVE_READ_TIMEOUT_MS,
  MULTICALL3,
  REGISTRY,
  VAULT,
} from "../../lib/env";

/**
 * Live chain reads for the API.
 *
 * Almost everything this API serves comes out of the index, which is deterministic and free.
 * These reads exist for the handful of facts that logs genuinely cannot carry:
 *
 *   - `lockedAssets()` / `contractsAssigned()` read Valorem's live position, which falls as
 *     buyers are assigned MID-WEEK. The index only learns the final figure at redeem.
 *   - `claimableUsdg(addr)` depends on a per-account index snapshot inside the Distributor,
 *     not on any event.
 *   - `spotUsdg()` and `uiMultiplier()` are display values with no event at all.
 *   - the registry's live cycle and strike ladder, which is what the cycle page renders.
 *
 * Every call is wrapped: a reverting view (a stale oracle makes `spotUsdg()` revert by
 * design) must degrade one field to null, never fail the whole response. Callers surface
 * `live: false` when the chain could not be reached at all.
 */

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const client = () => publicClients[CHAIN_NAME];

/**
 * Never let a chain read decide how long a request takes.
 *
 * Two failure modes are folded into one answer of `null`: the call reverted (a stale oracle
 * makes `spotUsdg()` revert by design, and a view on an address with no code returns `0x`),
 * or the RPC is slow. Public endpoints on 4663 rate-limit, and viem's own retry ladder can
 * hold a request open for a long time, so the deadline is enforced here. The underlying
 * promise keeps running and its rejection is swallowed, so a late failure cannot surface as
 * an unhandled rejection after the response has already gone out.
 */
async function safe<T>(p: Promise<T>): Promise<T | null> {
  const settled = p.then<T | null>((v) => v).catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LIVE_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One entry in a batched read: which contract, which view, which arguments. */
type Call = {
  abi: readonly unknown[];
  address: Address;
  functionName: string;
  args?: readonly unknown[];
};

/**
 * Read many views in ONE `eth_call`, through Multicall3's `aggregate3`.
 *
 * WHY THIS EXISTS, and why it is not a `Promise.all` of `readContract`:
 * `GET /v1/vault` needs about thirty-five views. Ponder's API client funnels every request
 * through the same rate-limited RPC queue the indexer uses, so thirty-five of them serialise
 * behind each other and blow any deadline worth having — measured on
 * rpc.mainnet.chain.robinhood.com, where it emptied the entire live half of the payload to
 * nulls while the node itself was perfectly healthy.
 *
 * `allowFailure` is always on, so a view that reverts BY DESIGN — `spotUsdg()` refuses to
 * answer on a stale feed, and that refusal is itself a published signal — comes back as one
 * null instead of failing the batch. A batch that cannot run at all (Multicall3 absent on a
 * bare dry-run chain, or the RPC down) returns all nulls, and the caller reports `live: false`
 * and serves the indexed figures.
 *
 * The `as never` casts are load-bearing: `functionName` is a runtime string here, while
 * abitype wants a literal drawn from the ABI. Every name passed in is checked against the
 * generated ABI by the call sites below, all of which name real views.
 */
async function multiread(calls: readonly Call[]): Promise<(unknown | null)[]> {
  if (calls.length === 0) return [];
  const c = client();

  const results = await safe(
    c.multicall({
      contracts: calls.map((call) => ({
        abi: call.abi,
        address: call.address,
        functionName: call.functionName,
        args: call.args ?? [],
      })) as never,
      allowFailure: true,
      multicallAddress: MULTICALL3,
    }) as Promise<readonly { status: string; result?: unknown }[]>,
  );

  if (results === null) return calls.map(() => null);
  return calls.map((_, i) => {
    const r = results[i];
    if (r === undefined || r.status !== "success") return null;
    return r.result ?? null;
  });
}

export type LiveVault = {
  live: boolean;
  blockNumber: bigint | null;
  phase: number | null;
  totalAssets: bigint | null;
  idleAssets: bigint | null;
  /** Live Valorem position: falls as buyers are assigned during the week. */
  lockedAssets: bigint | null;
  /** Live from `clear.claim().amountExercised / 1e18`, so it moves intra-week. */
  contractsAssigned: bigint | null;
  contractsRemaining: bigint | null;
  contractsWritten: bigint | null;
  totalSupply: bigint | null;
  canRedeemInstantly: boolean | null;
  maxDeposit: bigint | null;
  depositCap: bigint | null;
  uiMultiplier: bigint | null;
  /** USDG base units for one lot. Reverts when the feed is stale, which is a real signal. */
  spotUsdg: bigint | null;
  writesHalted: boolean | null;
  valoremFeeAccepted: boolean | null;
  listingHash: `0x${string}` | null;
  listingAmount: bigint | null;
  listingGrossUsdg: bigint | null;
  listingsThisCycle: number | null;
  queuedShares: bigint | null;
  usdgReservedForQueue: bigint | null;
};

export async function readVaultLive(): Promise<LiveVault> {
  const c = client();

  // Order matters: the destructuring below reads positionally out of the batch.
  const names = [
    "phase",
    "totalAssets",
    "idleAssets",
    "lockedAssets",
    "contractsAssigned",
    "contractsRemaining",
    "contractsWritten",
    "totalSupply",
    "canRedeemInstantly",
    "maxDeposit",
    "depositCap",
    "uiMultiplier",
    "spotUsdg",
    "writesHalted",
    "valoremFeeAccepted",
    "listingHash",
    "listingAmount",
    "listingGrossUsdg",
    "listingsThisCycle",
    "queuedShares",
    "usdgReservedForQueue",
  ] as const;

  // `maxDeposit(address)` is the only one that takes an argument. The zero address is the
  // right probe: the vault's cap is global, not per-account.
  const [batch, blockNumber] = await Promise.all([
    multiread(
      names.map((functionName) => ({
        abi: vaultAbi,
        address: VAULT,
        functionName,
        args: functionName === "maxDeposit" ? [ZERO] : [],
      })),
    ),
    safe(c.getBlockNumber()),
  ]);

  const at = <T>(name: (typeof names)[number]): T | null =>
    (batch[names.indexOf(name)] ?? null) as T | null;

  const totalAssets = at<bigint>("totalAssets");

  return {
    // `totalAssets` is the cheapest proof the vault answered at all.
    live: totalAssets !== null,
    blockNumber,
    phase: at<number>("phase"),
    totalAssets,
    idleAssets: at<bigint>("idleAssets"),
    lockedAssets: at<bigint>("lockedAssets"),
    contractsAssigned: at<bigint>("contractsAssigned"),
    contractsRemaining: at<bigint>("contractsRemaining"),
    contractsWritten: at<bigint>("contractsWritten"),
    totalSupply: at<bigint>("totalSupply"),
    canRedeemInstantly: at<boolean>("canRedeemInstantly"),
    maxDeposit: at<bigint>("maxDeposit"),
    depositCap: at<bigint>("depositCap"),
    uiMultiplier: at<bigint>("uiMultiplier"),
    spotUsdg: at<bigint>("spotUsdg"),
    writesHalted: at<boolean>("writesHalted"),
    valoremFeeAccepted: at<boolean>("valoremFeeAccepted"),
    listingHash: at<`0x${string}`>("listingHash"),
    listingAmount: at<bigint>("listingAmount"),
    listingGrossUsdg: at<bigint>("listingGrossUsdg"),
    listingsThisCycle: at<number>("listingsThisCycle"),
    queuedShares: at<bigint>("queuedShares"),
    usdgReservedForQueue: at<bigint>("usdgReservedForQueue"),
  };
}

export type LiveAccount = {
  live: boolean;
  shares: bigint | null;
  sharesAsAssets: bigint | null;
  claimableUsdg: bigint | null;
  queuedShares: bigint | null;
  queuedEpoch: bigint | null;
  /** What a settled queue position pays right now. (0, 0) until its epoch settles. */
  previewAssets: bigint | null;
  previewUsdg: bigint | null;
};

export async function readAccountLive(address: Address): Promise<LiveAccount> {
  const call = (functionName: string, args: readonly unknown[]) => ({
    abi: vaultAbi,
    address: VAULT,
    functionName,
    args,
  });

  const [shares, claimableUsdg, queuedShares, queuedEpoch, preview] = await multiread([
    call("balanceOf", [address]),
    call("claimableUsdg", [address]),
    call("queuedSharesOf", [address]),
    call("queuedEpochOf", [address]),
    call("previewCompleteRedeem", [address]),
  ]);

  // A second batch, because its argument is the first batch's answer. Skipped entirely when
  // the balance did not come back, so a dead RPC costs one deadline, not two.
  const sharesAsAssets =
    shares === null
      ? null
      : ((await multiread([call("convertToAssets", [shares])]))[0] as bigint | null);

  const previewPair = preview as readonly [bigint, bigint] | null;

  return {
    live: shares !== null,
    shares: shares as bigint | null,
    sharesAsAssets,
    claimableUsdg: claimableUsdg as bigint | null,
    queuedShares: queuedShares as bigint | null,
    queuedEpoch: queuedEpoch as bigint | null,
    previewAssets: previewPair === null ? null : previewPair[0],
    previewUsdg: previewPair === null ? null : previewPair[1],
  };
}

export type LiveRung = {
  optionId: bigint;
  strikeUsdg: bigint | null;
  approved: boolean | null;
};

export type LiveCycle = {
  live: boolean;
  cycleNumber: number | null;
  exerciseTimestamp: bigint | null;
  expiryTimestamp: bigint | null;
  lotSize: bigint | null;
  /** The registry's own gate. The keeper binds to this, never to the wall clock. */
  isWritingOpen: boolean | null;
  isCycleLive: boolean | null;
  writeDeadline: bigint | null;
  rungs: LiveRung[];
};

/**
 * The live Overcall cycle: the five-rung ladder, the two timestamps, and the two gates.
 *
 * The cycle struct carries NO status field — `isWritingOpen()` (a cycle is set and
 * `now < writeDeadline()`, which equals `exerciseTimestamp`) and `isCycleLive()`
 * (`now < expiryTimestamp`) are the whole state machine.
 */
export async function readCycleLive(): Promise<LiveCycle> {
  const reg = (functionName: string, args: readonly unknown[] = []) => ({
    abi: overcallRegistryAbi,
    address: REGISTRY,
    functionName,
    args,
  });

  // One batch for the cycle and its gates, a second for the ladder (its size is only known
  // once the first has answered). Two round trips is the worst case for this whole function.
  const [cycleRaw, isWritingOpenRaw, isCycleLiveRaw, writeDeadlineRaw] = await multiread([
    reg("cycle"),
    reg("isWritingOpen"),
    reg("isCycleLive"),
    reg("writeDeadline"),
  ]);

  const isWritingOpen = isWritingOpenRaw as boolean | null;
  const isCycleLive = isCycleLiveRaw as boolean | null;
  const writeDeadline =
    writeDeadlineRaw === null ? null : BigInt(writeDeadlineRaw as bigint | number);

  const cycle = cycleRaw as {
    number: number;
    exerciseTimestamp: number | bigint;
    expiryTimestamp: number | bigint;
    lotSize: bigint;
    optionIds: readonly bigint[];
  } | null;

  if (cycle === null) {
    return {
      live: false,
      cycleNumber: null,
      exerciseTimestamp: null,
      expiryTimestamp: null,
      lotSize: null,
      isWritingOpen,
      isCycleLive,
      writeDeadline,
      rungs: [],
    };
  }

  // Two views per rung — the strike and whether the registry still approves it — batched into
  // a single call rather than 2N of them.
  const ids = cycle.optionIds;
  const ladder = await multiread(
    ids.flatMap((optionId) => [
      reg("strikePerContract", [optionId]),
      reg("isApproved", [optionId]),
    ]),
  );

  const rungs: LiveRung[] = ids.map((optionId, i) => {
    const strike = ladder[i * 2] ?? null;
    const approved = ladder[i * 2 + 1] ?? null;
    return {
      optionId,
      strikeUsdg: strike === null ? null : BigInt(strike as bigint | number),
      approved: approved as boolean | null,
    };
  });

  return {
    live: true,
    cycleNumber: cycle.number,
    exerciseTimestamp: BigInt(cycle.exerciseTimestamp),
    expiryTimestamp: BigInt(cycle.expiryTimestamp),
    lotSize: BigInt(cycle.lotSize),
    isWritingOpen,
    isCycleLive,
    writeDeadline,
    rungs,
  };
}

/** Whether the issuer has paused the Stock Token's oracle. A paused oracle blocks every write. */
export async function readOraclePaused(): Promise<boolean | null> {
  return await safe(
    client().readContract({
      abi: stockTokenAbi,
      address: ASSET,
      functionName: "oraclePaused",
    }),
  );
}

/** Current chain head, for the health route's lag calculation. */
export async function readChainHead(): Promise<bigint | null> {
  return await safe(client().getBlockNumber());
}
