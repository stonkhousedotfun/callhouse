import { getAddress, type Address, type PublicClient } from "viem";

import { erc20Abi } from "../abi/erc20";
import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { orderBookAbi } from "../abi/v2/orderBook";
import { settlementOracleAbi } from "../abi/v2/settlementOracle";
import { publicClient } from "../chain";
import { v2Markets } from "../markets";
import { requireV2Address } from "./config";
import { shortIdOf } from "./seriesId";
import type { SeriesRef } from "./api-types";

/** Read the compiled market's oracle directly when the indexer cannot serve /markets. */
export async function readMarketSpotOnChain(ticker: string, client: PublicClient = publicClient): Promise<bigint> {
  const market = v2Markets().find((row) => row.ticker === ticker.toUpperCase());
  if (!market) throw new Error("Market is not in this app's registry");
  // SettlementOracle.spot itself enforces the configured feed age and source validity.
  const [price] = await client.readContract({ address: requireV2Address("settlementOracle"),
    abi: settlementOracleAbi, functionName: "spot", args: [market.asset] });
  if (price <= 0n) throw new Error("Oracle spot is unavailable");
  return price;
}

/** On-chain state is authoritative for transactions; API snapshots are display data. */
export async function readSeriesOnChain(longId: bigint, client: PublicClient = publicClient, pinnedBlock?: bigint) {
  const blockNumber = pinnedBlock ?? await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber });
  const address = requireV2Address("clearinghouse");
  const [exists, series, cutoff, collateral] = await client.multicall({
    allowFailure: false, blockNumber,
    contracts: [
      { address, abi: clearinghouseAbi, functionName: "seriesExists", args: [longId] },
      { address, abi: clearinghouseAbi, functionName: "series", args: [longId] },
      { address, abi: clearinghouseAbi, functionName: "mintCutoff", args: [longId] },
      { address, abi: clearinghouseAbi, functionName: "collateralPerUnit", args: [longId] },
    ],
  });
  return { exists, series, cutoff, collateral, blockNumber, snapshotTimestamp: Number(block.timestamp) };
}

/** API option terms are display data; compare them to the compiled market and on-chain series before a trade. */
export function assertSeriesTermsMatch(
  displayed: SeriesRef, onChain: Awaited<ReturnType<typeof readSeriesOnChain>>["series"],
  expectedTicker: string, displayedExerciseFeeBps?: number,
): void {
  const market = v2Markets().find((row) => row.ticker === expectedTicker.toUpperCase());
  if (!market || BigInt(displayed.shortId) !== shortIdOf(BigInt(displayed.longId)) ||
      displayed.ticker !== market.ticker ||
      getAddress(displayed.underlying) !== market.asset || getAddress(onChain.underlying) !== market.asset ||
      displayed.mintFeePpm !== onChain.mintFeePpm || displayed.isPut !== onChain.isPut || BigInt(displayed.strike.raw) !== onChain.strike ||
      BigInt(displayed.expiry) !== BigInt(onChain.expiry) ||
      (displayedExerciseFeeBps !== undefined && displayedExerciseFeeBps !== Number(onChain.exerciseFeeBps)))
    throw new Error("Option terms differ from the chain or this app's market registry. Refresh before trading.");
}

/** A position or order ID is not evidence that its API-displayed payoff is correct. */
export async function assertPortfolioSeries(displayed: SeriesRef, client: PublicClient = publicClient): Promise<void> {
  const onChain = await readSeriesOnChain(BigInt(displayed.longId), client);
  if (!onChain.exists) throw new Error("This option is no longer on chain. Refresh Portfolio.");
  assertSeriesTermsMatch(displayed, onChain.series, displayed.ticker);
}

export type PayoutPrefs = { inKind: boolean; toLedger: boolean };

/** Read the destination and asset choice that Clearinghouse will use at redemption. */
export async function readPayoutPrefs(account: Address, client: PublicClient = publicClient): Promise<PayoutPrefs> {
  const [inKind, toLedger] = await client.readContract({ address: requireV2Address("clearinghouse"),
    abi: clearinghouseAbi, functionName: "payoutPrefs", args: [account] });
  return { inKind, toLedger };
}

/** Stop a claim when another tab or transaction changed the preference after it was shown. */
export function assertPayoutPrefsMatch(shown: PayoutPrefs, current: PayoutPrefs): void {
  if (shown.inKind !== current.inKind || shown.toLedger !== current.toLedger)
    throw new Error("Your on-chain payout preference changed. Refresh Portfolio and review the payout before collecting.");
}

/** Reread exact selected orders just before a fill, including their makers' free stock collateral. */
export async function readOrderPreflight(orderIds: readonly bigint[], underlying: Address, client: PublicClient = publicClient, pinnedBlock?: bigint) {
  if (!orderIds.length) return [];
  // The calls cannot share a multicall: maker addresses come from getOrders. Pin both
  // reads to one block so an order and its collateral never describe different states.
  const blockNumber = pinnedBlock ?? await client.getBlockNumber();
  const orders = await client.readContract({
    address: requireV2Address("orderBook"), abi: orderBookAbi, functionName: "getOrders", args: [[...orderIds]], blockNumber,
  });
  const clearinghouse = requireV2Address("clearinghouse");
  const writers = orders.filter((order) => order.kind === 2);
  const free = writers.length ? await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: writers.map((order) => ({
      address: clearinghouse, abi: clearinghouseAbi, functionName: "free" as const,
      args: [order.maker, underlying] as const,
    })),
  }) : [];
  let writerIndex = 0;
  return orders.map((order, index) => ({
    orderId: orderIds[index]!, order,
    // Bid collateral is USDG escrow and resale asks hold ERC-1155s in the book;
    // free Stock Tokens only gate write-on-fill orders.
    freeCollateral: order.kind === 2 ? free[writerIndex++]! : null,
    blockNumber,
  }));
}

/** One block snapshot of balances, ledger, allowance and ERC-1155/operator approvals. */
export async function readAccountOnChain(
  account: Address,
  asset: Address,
  longId: bigint,
  spender: Address,
  client: PublicClient = publicClient,
) {
  const clearinghouse = requireV2Address("clearinghouse");
  const orderBook = requireV2Address("orderBook");
  const [longBalance, shortBalance, free, usdgBalance, allowance, approvedForAll, operator, thirdPartyRedeem] =
    await client.multicall({
      allowFailure: false,
      contracts: [
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "balanceOf", args: [account, longId] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "balanceOf", args: [account, longId | 1n] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "free", args: [account, asset] },
        { address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: asset, abi: erc20Abi, functionName: "allowance", args: [account, spender] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "isApprovedForAll", args: [account, orderBook] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "isOperator", args: [account, orderBook] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "thirdPartyRedeemAllowed", args: [account] },
      ],
    });
  return { longBalance, shortBalance, free, tokenBalance: usdgBalance, allowance, approvedForAll, operator, thirdPartyRedeem };
}

export async function readAllowances(
  account: Address, asset: Address, spenders: readonly Address[], client: PublicClient = publicClient,
) {
  return client.multicall({
    allowFailure: false,
    contracts: spenders.map((spender) => ({ address: asset, abi: erc20Abi, functionName: "allowance" as const, args: [account, spender] as const })),
  });
}
