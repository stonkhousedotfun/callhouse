import { publicClients } from "ponder:api";
import type { Address } from "viem";

import { erc20Abi } from "../../../abis/erc20";
import { clearinghouseAbi } from "../../../abis/v2/clearinghouse";
import { makerVaultAbi } from "../../../abis/v2/makerVault";
import { orderBookAbi } from "../../../abis/v2/orderBook";
import { rewardsDistributorAbi } from "../../../abis/v2/rewardsDistributor";
import { settlementOracleAbi } from "../../../abis/v2/settlementOracle";
import { CHAIN_NAME, LIVE_READ_TIMEOUT_MS, USDG, V2_CLEARINGHOUSE, V2_SETTLEMENT_ORACLE } from "../../../lib/env";

async function bounded<T>(promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LIVE_READ_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function successfulResult<T>(row: { status: string } | undefined): T | null {
  if (row?.status !== "success" || !("result" in row)) return null;
  return row.result as T;
}

/** One batched live read; a stale/reverting oracle leaves that market without a spot. */
export async function readSpots(underlyings: Address[]): Promise<Map<string, { price: bigint; updatedAt: number }>> {
  const result = new Map<string, { price: bigint; updatedAt: number }>();
  if (underlyings.length === 0 || V2_SETTLEMENT_ORACLE === undefined) return result;
  const client = publicClients[CHAIN_NAME];
  const oracle = V2_SETTLEMENT_ORACLE;
  const rows = await bounded(client.multicall({ contracts: underlyings.map((underlying) => ({
    abi: settlementOracleAbi, address: oracle, functionName: "spot" as const,
    args: [underlying] as const,
  })), allowFailure: true }));
  if (rows === null) return result;
  rows.forEach((row, index) => {
    if (row.status !== "success") return;
    const [price, updatedAt] = row.result as readonly [bigint, bigint];
    if (price <= 0n || updatedAt <= 0n || updatedAt > BigInt(Number.MAX_SAFE_INTEGER)) return;
    result.set(underlyings[index]!.toLowerCase(), { price, updatedAt: Number(updatedAt) });
  });
  return result;
}

/** Refresh the event-derived ledger for the wallet view when the RPC responds. */
export async function readFree(account: Address, assets: Address[]): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  if (assets.length === 0 || V2_CLEARINGHOUSE === undefined) return result;
  const client = publicClients[CHAIN_NAME];
  const clearinghouse = V2_CLEARINGHOUSE;
  const rows = await bounded(client.multicall({ contracts: assets.map((asset) => ({
    abi: clearinghouseAbi, address: clearinghouse, functionName: "free" as const,
    args: [account, asset] as const,
  })), allowFailure: true }));
  if (rows === null) return result;
  rows.forEach((row, index) => {
    if (row.status === "success") result.set(assets[index]!.toLowerCase(), row.result as bigint);
  });
  return result;
}

const rewardTokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint8" }] },
] as const;

export type RewardBalance = { balance: bigint; decimals: number };

/** Read each distributor's payout token, live balance, and scale without assuming USDG. */
export async function readRewardBalances(distributors: Address[]): Promise<Map<string, RewardBalance>> {
  const result = new Map<string, RewardBalance>();
  if (distributors.length === 0) return result;
  const client = publicClients[CHAIN_NAME];
  if (client === undefined) return result;
  const tokenRows = await bounded(client.multicall({ contracts: distributors.map((distributor) => ({
    abi: rewardsDistributorAbi, address: distributor, functionName: "usdg" as const,
  })), allowFailure: true }));
  if (tokenRows === null) return result;
  const resolved = tokenRows.flatMap((row, index) => row.status === "success"
    ? [{ distributor: distributors[index]!, token: row.result as Address }] : []);
  const rows = await bounded(client.multicall({ contracts: resolved.flatMap(({ distributor, token }) => [
    { abi: rewardTokenAbi, address: token, functionName: "balanceOf" as const, args: [distributor] as const },
    { abi: rewardTokenAbi, address: token, functionName: "decimals" as const },
  ]), allowFailure: true }));
  if (rows === null) return result;
  resolved.forEach(({ distributor }, index) => {
    const balance = rows[index * 2];
    const decimals = rows[index * 2 + 1];
    if (balance?.status !== "success" || decimals?.status !== "success") return;
    const scale = Number(decimals.result);
    if (!Number.isInteger(scale) || scale < 0 || scale > 36) return;
    result.set(distributor.toLowerCase(), { balance: balance.result as bigint, decimals: scale });
  });
  return result;
}

export type MakerVaultLiveState = {
  assets: Array<{ asset: Address; wallet: bigint; ledger: bigint }>;
  limits: {
    maxSeriesUnits: bigint;
    maxTotalNotional: bigint;
    askToleranceBps: number;
    maxBidBpsOfSpot: number;
    maxOrderLifetime: number;
    maxDailyOutflow: bigint;
  };
  outflowUsed: bigint;
  liveOrderCount: number;
  trackedSeries: bigint[];
};

/**
 * Read the MakerVault snapshot at one block. Every field is required: a partial RPC response is an
 * outage, not permission to publish plausible zeros for money or risk limits.
 */
export async function readMakerVaultState(vault: Address): Promise<MakerVaultLiveState | null> {
  if (V2_CLEARINGHOUSE === undefined) return null;
  const client = publicClients[CHAIN_NAME];
  if (client === undefined) return null;
  const blockNumber = await bounded(client.getBlockNumber());
  if (blockNumber === null) return null;
  const block = await bounded(client.getBlock({ blockNumber }));
  if (block === null) return null;

  const core = await bounded(client.multicall({
    blockNumber,
    allowFailure: true,
    contracts: [
      { abi: makerVaultAbi, address: vault, functionName: "limits" as const },
      { abi: makerVaultAbi, address: vault, functionName: "outflow" as const },
      { abi: makerVaultAbi, address: vault, functionName: "trackedSeries" as const },
      { abi: makerVaultAbi, address: vault, functionName: "usdg" as const },
      { abi: makerVaultAbi, address: vault, functionName: "clearinghouse" as const },
      { abi: makerVaultAbi, address: vault, functionName: "orderBook" as const },
    ],
  }));
  if (core === null) return null;
  const liveLimits = successfulResult<MakerVaultLiveState["limits"]>(core[0]);
  const liveOutflow = successfulResult<readonly [bigint, bigint]>(core[1]);
  const liveTrackedSeries = successfulResult<readonly bigint[]>(core[2]);
  const liveUsdg = successfulResult<Address>(core[3]);
  const liveClearinghouse = successfulResult<Address>(core[4]);
  const liveOrderBook = successfulResult<Address>(core[5]);
  if (liveLimits === null || liveOutflow === null || liveTrackedSeries === null ||
      liveUsdg === null || liveClearinghouse === null || liveOrderBook === null) return null;
  if (liveUsdg.toLowerCase() !== USDG.toLowerCase() ||
      liveClearinghouse.toLowerCase() !== V2_CLEARINGHOUSE.toLowerCase()) return null;

  const trackedSeries = [...new Set(liveTrackedSeries)];
  const series = trackedSeries.length === 0 ? [] : await bounded(client.multicall({
    blockNumber,
    allowFailure: true,
    contracts: trackedSeries.map((longId) => ({
      abi: clearinghouseAbi, address: V2_CLEARINGHOUSE!, functionName: "series" as const,
      args: [longId] as const,
    })),
  }));
  if (series === null) return null;
  const liveSeries = series.map((row) => successfulResult<{ underlying: Address }>(row));
  if (liveSeries.some((row) => row === null)) return null;
  const assets = [...new Map([
    [USDG.toLowerCase(), USDG],
    ...liveSeries.map((row) => {
      const underlying = row!.underlying;
      return [underlying.toLowerCase(), underlying] as const;
    }),
  ]).values()];

  const walletCount = assets.length;
  const ledgerStart = walletCount;
  const ordersStart = ledgerStart + assets.length;
  const details = await bounded(client.multicall({
    blockNumber,
    allowFailure: true,
    contracts: [
      ...assets.map((asset) => ({
        abi: erc20Abi, address: asset, functionName: "balanceOf" as const, args: [vault] as const,
      })),
      ...assets.map((asset) => ({
        abi: clearinghouseAbi, address: V2_CLEARINGHOUSE!, functionName: "free" as const,
        args: [vault, asset] as const,
      })),
      ...trackedSeries.map((longId) => ({
        abi: makerVaultAbi, address: vault, functionName: "orderIdsOf" as const, args: [longId] as const,
      })),
    ],
  }));
  if (details === null) return null;
  const liveDetails = details.map((row) => successfulResult<unknown>(row));
  if (liveDetails.some((row) => row === null)) return null;
  const orderIds = [...new Set(liveDetails.slice(ordersStart)
    .flatMap((ids) => ids as readonly bigint[]))];
  const orderRows = orderIds.length === 0 ? [] : await bounded(client.multicall({
    blockNumber,
    allowFailure: true,
    contracts: [{
      abi: orderBookAbi, address: liveOrderBook, functionName: "getOrders" as const,
      args: [orderIds] as const,
    }],
  }));
  if (orderRows === null) return null;
  const orders = orderIds.length === 0 ? [] : successfulResult<ReadonlyArray<{
    maker: Address;
    units: bigint;
    filled: bigint;
    validUntil: number;
    cancelled: boolean;
  }>>(orderRows[0]);
  if (orders === null) return null;
  const liveOrderCount = orders.filter((order) =>
    order.maker.toLowerCase() === vault.toLowerCase() && !order.cancelled &&
    order.filled < order.units && block.timestamp < BigInt(order.validUntil)
  ).length;
  if (!Number.isSafeInteger(liveOrderCount)) return null;

  const askToleranceBps = Number(liveLimits.askToleranceBps);
  const maxBidBpsOfSpot = Number(liveLimits.maxBidBpsOfSpot);
  const maxOrderLifetime = Number(liveLimits.maxOrderLifetime);
  if (![askToleranceBps, maxBidBpsOfSpot, maxOrderLifetime].every(Number.isSafeInteger)) return null;
  const [outflowUsed] = liveOutflow;

  return {
    assets: assets.map((asset, index) => ({
      asset,
      wallet: liveDetails[index] as bigint,
      ledger: liveDetails[ledgerStart + index] as bigint,
    })),
    limits: {
      maxSeriesUnits: liveLimits.maxSeriesUnits,
      maxTotalNotional: liveLimits.maxTotalNotional,
      askToleranceBps,
      maxBidBpsOfSpot,
      maxOrderLifetime,
      maxDailyOutflow: liveLimits.maxDailyOutflow,
    },
    outflowUsed,
    liveOrderCount,
    trackedSeries,
  };
}
