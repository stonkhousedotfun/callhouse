import { publicClients } from "ponder:api";
import type { Address } from "viem";

import { stockTokenAbi } from "../../abis/stockToken";
import { valoremClearAbi } from "../../abis/valoremClear";
import { vaultAbi } from "../../abis/vault";
import { ASSET, CHAIN_NAME, CLEARINGHOUSE, LIVE_READ_TIMEOUT_MS, MULTICALL3, vaultAddress } from "../../lib/env";

/**
 * Live chain reads for the API.
 *
 * Almost everything this API serves comes out of the index, which is deterministic and free.
 * These reads exist for the handful of facts that logs genuinely cannot carry:
 *
 *   - `lockedAssets()` / `contractsAssigned()` read Valorem's live position, which falls as
 *     buyers are assigned after the exercise timestamp. The index only learns the final figure
 *     at the close.
 *   - `maxDeposit()` folds the whole deposit gate (phase, exercise window, unclaimed assignment,
 *     stranded claim, unbacked reserve, share-price floor) into one number; `DepositsClosed`
 *     is not an event.
 *   - `claimableUsdg(addr)`, `owedStrandWad(addr)` and `previewCompleteRedeem(addr)` depend on
 *     per-account state inside the Distributor and the queue, not on any event.
 *   - `spotUsdg()` and `uiMultiplier()` are display values with no event at all.
 *   - `policy()` feeds the capacity figure, `Policy.maxContracts(totalAssets) − contractsWritten`.
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
 * `GET /v1/vault` needs about thirty views. Ponder's API client funnels every request
 * through the same rate-limited RPC queue the indexer uses, so thirty of them serialise
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

/** `Vault.policy()` as viem decodes it. */
export type LivePolicy = {
  minOtmBps: number;
  maxOtmBps: number;
  minPremiumBps: number;
  maxUtilizationBps: number;
  protocolFeeBps: number;
  maxContractsCap: bigint;
};

export type LiveVault = {
  live: boolean;
  blockNumber: bigint | null;
  phase: number | null;
  cycleNumber: number | null;
  totalAssets: bigint | null;
  idleAssets: bigint | null;
  /** Live Valorem position: falls as buyers are assigned after the exercise timestamp. */
  lockedAssets: bigint | null;
  /** Live from `clear.claim().amountExercised / 1e18`, so it moves once exercise opens. */
  contractsAssigned: bigint | null;
  /** Sum of every fill's write this cycle; equals sold. */
  contractsWritten: bigint | null;
  totalSupply: bigint | null;
  canRedeemInstantly: boolean | null;
  /** 0 whenever `deposit` would revert `DepositsClosed`: the whole gate in one number. */
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
  /** The armed option this cycle, as the vault holds it. */
  optionId: bigint | null;
  claimKey: bigint | null;
  cycleStrikeUsdg: bigint | null;
  cycleExerciseTs: bigint | null;
  cycleExpiryTs: bigint | null;
  /** The stranded-claim state machine (AF-02). */
  isStranded: boolean | null;
  strandGen: bigint | null;
  lastResolvedGen: bigint | null;
  strandedRemainingWad: bigint | null;
  policy: LivePolicy | null;
  /**
   * Clear's own fee switch (`feesEnabled()`, 15 bps of notional on every fill). While it is on
   * and `valoremFeeAccepted` is false the vault refuses to arm and every fill reverts
   * (`ValoremFeesEnabled` in the arm and fill gates), so the two bits are published side by
   * side. Read live: the switch flips by Clear governance, not by anything this vault emits.
   */
  clearFeesEnabled: boolean | null;
};

export async function readVaultLive(): Promise<LiveVault> {
  const c = client();
  // Reached only from the `/v1/vault*` routes, which answer 404 before this on a factory-only deployment.
  const VAULT = vaultAddress();

  // Order matters: the destructuring below reads positionally out of the batch.
  const names = [
    "phase",
    "cycleNumber",
    "totalAssets",
    "idleAssets",
    "lockedAssets",
    "contractsAssigned",
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
    "optionId",
    "claimKey",
    "cycleStrikeUsdg",
    "cycleExerciseTs",
    "cycleExpiryTs",
    "isStranded",
    "strandGen",
    "lastResolvedGen",
    "strandedRemainingWad",
    "policy",
  ] as const;

  // `maxDeposit(address)` is the only one that takes an argument. The zero address is the
  // right probe: the vault's cap is global, not per-account. Clear's fee switch rides in the
  // same batch, after the vault's views, so it costs no extra round trip.
  const [batch, blockNumber] = await Promise.all([
    multiread([
      ...names.map((functionName) => ({
        abi: vaultAbi,
        address: VAULT,
        functionName,
        args: functionName === "maxDeposit" ? [ZERO] : [],
      })),
      { abi: valoremClearAbi, address: CLEARINGHOUSE, functionName: "feesEnabled" },
    ]),
    safe(c.getBlockNumber()),
  ]);

  const at = <T>(name: (typeof names)[number]): T | null =>
    (batch[names.indexOf(name)] ?? null) as T | null;
  const clearFeesEnabled = (batch[names.length] ?? null) as boolean | null;
  const big = (name: (typeof names)[number]): bigint | null => {
    const v = at<bigint | number>(name);
    return v === null ? null : BigInt(v);
  };

  const totalAssets = at<bigint>("totalAssets");
  const policyRaw = at<readonly [number, number, number, number, number, bigint]>("policy");

  return {
    // `totalAssets` is the cheapest proof the vault answered at all.
    live: totalAssets !== null,
    blockNumber,
    phase: at<number>("phase"),
    cycleNumber: at<number>("cycleNumber"),
    totalAssets,
    idleAssets: at<bigint>("idleAssets"),
    lockedAssets: at<bigint>("lockedAssets"),
    contractsAssigned: at<bigint>("contractsAssigned"),
    contractsWritten: big("contractsWritten"),
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
    optionId: at<bigint>("optionId"),
    claimKey: at<bigint>("claimKey"),
    cycleStrikeUsdg: at<bigint>("cycleStrikeUsdg"),
    cycleExerciseTs: big("cycleExerciseTs"),
    cycleExpiryTs: big("cycleExpiryTs"),
    isStranded: at<boolean>("isStranded"),
    strandGen: at<bigint>("strandGen"),
    lastResolvedGen: at<bigint>("lastResolvedGen"),
    strandedRemainingWad: at<bigint>("strandedRemainingWad"),
    policy:
      policyRaw === null
        ? null
        : {
            minOtmBps: Number(policyRaw[0]),
            maxOtmBps: Number(policyRaw[1]),
            minPremiumBps: Number(policyRaw[2]),
            maxUtilizationBps: Number(policyRaw[3]),
            protocolFeeBps: Number(policyRaw[4]),
            maxContractsCap: BigInt(policyRaw[5]),
          },
    clearFeesEnabled,
  };
}

export type LiveAccount = {
  live: boolean;
  shares: bigint | null;
  sharesAsAssets: bigint | null;
  claimableUsdg: bigint | null;
  queuedShares: bigint | null;
  queuedEpoch: bigint | null;
  /**
   * What a `completeRedeem` would pay right now: the settled entry, any recovered strand share,
   * the reserve haircut applied. (0, 0) until the epoch settles; a share of a claim still
   * stranded is quoted as nothing.
   */
  previewAssets: bigint | null;
  previewUsdg: bigint | null;
  /** The owner's staged share of a stranded claim (`owedStrandWad` / `owedStrandGen`), WAD of 1e18. */
  strandWad: bigint | null;
  strandGen: bigint | null;
};

export async function readAccountLive(address: Address): Promise<LiveAccount> {
  const VAULT = vaultAddress();
  const call = (functionName: string, args: readonly unknown[]) => ({
    abi: vaultAbi,
    address: VAULT,
    functionName,
    args,
  });

  const [shares, claimableUsdg, queuedShares, queuedEpoch, preview, strandWad, strandGen] = await multiread([
    call("balanceOf", [address]),
    call("claimableUsdg", [address]),
    call("queuedSharesOf", [address]),
    call("queuedEpochOf", [address]),
    call("previewCompleteRedeem", [address]),
    call("owedStrandWad", [address]),
    call("owedStrandGen", [address]),
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
    strandWad: strandWad as bigint | null,
    strandGen: strandGen as bigint | null,
  };
}

/** Whether the issuer has paused the Stock Token's oracle. A paused oracle blocks every arm and every fill. */
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
