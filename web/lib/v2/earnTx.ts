import { type Abi, type Address, type Hex, type PublicClient } from "viem";

import { erc20Abi } from "../abi/erc20";
import { autoRollerAbi } from "../abi/v2/autoRoller";
import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { expiryCalendarAbi } from "../abi/v2/expiryCalendar";
import { orderBookAbi } from "../abi/v2/orderBook";
import { publicClient, robinhoodChain } from "../chain";
import { USDG } from "../contracts";
import { requireV2Address, V2_DEPLOYMENT } from "./config";
import { explainV2Error } from "./errors";
import { mintRent } from "./rent";
import { collateralPerUnit } from "./payoff";
import type { Strategy } from "./api-types";
import type { WriteContext } from "./tx";
import { V2ReceiptUnknownError, waitForV2Receipt } from "./txStatus";

export type WriterBalance = { wallet: bigint; free: bigint; orderBookOperator: boolean; rollerOperator: boolean };
export type RollState = { strategyActive: boolean; longId: bigint; orderId: bigint; expiry: number; delegate: boolean };

async function write(context: WriteContext, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const client = context.client ?? publicClient;
  if (await context.wallet.getChainId() !== robinhoodChain.id) throw new Error("Switch to Robinhood Chain to continue.");
  try {
    const { request } = await client.simulateContract({ account: context.account, address, abi, functionName, args });
    const hash = await context.wallet.writeContract({ ...request, account: context.account, chain: robinhoodChain });
    await waitForV2Receipt(client, hash, functionName);
    try { await context.onConfirmed?.(hash); } catch { /* A confirmed write remains final. */ }
    return hash;
  } catch (error) {
    if (error instanceof V2ReceiptUnknownError) throw error;
    throw new Error(explainV2Error(error), { cause: error });
  }
}

export function createSeries(context: WriteContext, underlying: Address, isPut: boolean, strike: bigint, expiry: number): Promise<Hex> {
  return write(context, requireV2Address("clearinghouse"), clearinghouseAbi, "createSeries", [underlying, isPut, strike, expiry]);
}

export function setDelegate(context: WriteContext, delegate: Address, approved: boolean): Promise<Hex> {
  return write(context, requireV2Address("orderBook"), orderBookAbi, "setDelegate", [delegate, approved]);
}

export function setStrategy(context: WriteContext, underlying: Address, strategy: Strategy): Promise<Hex> {
  return write(context, requireV2Address("autoRoller"), autoRollerAbi, "setStrategy", [underlying, {
    ...strategy, maxUnits: BigInt(strategy.maxUnits),
  }]);
}

export function stopStrategy(context: WriteContext, underlying: Address): Promise<Hex> {
  return write(context, requireV2Address("autoRoller"), autoRollerAbi, "stop", [underlying]);
}

export async function readWriterBalance(account: Address, asset: Address, client: PublicClient = publicClient): Promise<WriterBalance> {
  const clearinghouse = requireV2Address("clearinghouse");
  const orderBook = V2_DEPLOYMENT.contracts.orderBook;
  const roller = V2_DEPLOYMENT.contracts.autoRoller;
  const [wallet, free] = await client.multicall({ allowFailure: false, contracts: [
    { address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account] },
    { address: clearinghouse, abi: clearinghouseAbi, functionName: "free", args: [account, asset] },
  ] });
  const [orderBookOperator, rollerOperator] = await Promise.all([
    orderBook ? client.readContract({ address: clearinghouse, abi: clearinghouseAbi,
      functionName: "isOperator", args: [account, orderBook] }) : false,
    roller ? client.readContract({ address: clearinghouse, abi: clearinghouseAbi,
      functionName: "isOperator", args: [account, roller] }) : false,
  ]);
  return { wallet, free, orderBookOperator, rollerOperator };
}

export function readWriterFree(account: Address, asset: Address, client: PublicClient = publicClient): Promise<bigint> {
  return client.readContract({ address: requireV2Address("clearinghouse"), abi: clearinghouseAbi,
    functionName: "free", args: [account, asset] });
}

export async function readRollPosition(account: Address, underlying: Address, client: PublicClient = publicClient): Promise<Omit<RollState, "delegate">> {
  const roller = requireV2Address("autoRoller");
  const [strategy, position] = await client.multicall({ allowFailure: false, contracts: [
    { address: roller, abi: autoRollerAbi, functionName: "strategy", args: [account, underlying] },
    { address: roller, abi: autoRollerAbi, functionName: "position", args: [account, underlying] },
  ] });
  return { strategyActive: strategy.active, longId: position[0], orderId: position[1], expiry: Number(position[2]) };
}

export async function readRollState(account: Address, underlying: Address, client: PublicClient = publicClient): Promise<RollState> {
  const position = await readRollPosition(account, underlying, client);
  const roller = requireV2Address("autoRoller");
  const orderBook = V2_DEPLOYMENT.contracts.orderBook;
  const delegate = orderBook ? await client.readContract({ address: orderBook, abi: orderBookAbi,
    functionName: "isDelegate", args: [account, roller] }) : false;
  return { ...position, delegate };
}

export type AskPreflight = { longId: bigint; exists: boolean; operator: boolean; free: bigint; mintCutoff: number | null; rent: bigint; collateralRequired: bigint };

/** Re-read the chain immediately before an ask; API rows are for discovery, not authority. */
export async function preflightAsk(
  account: Address, underlying: Address, isPut: boolean, strike: bigint, expiry: number, units: bigint,
  expectedPremiumFeeBps: number, client: PublicClient = publicClient,
): Promise<AskPreflight> {
  if (units <= 0n || units > (1n << 64n) - 1n || strike <= 0n || expiry <= Math.floor(Date.now() / 1000))
    throw new Error("Choose a future expiry, positive strike, and positive size.");
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const clearinghouse = requireV2Address("clearinghouse");
  const orderBook = requireV2Address("orderBook");
  const calendar = requireV2Address("expiryCalendar");
  const collateralAsset = isPut ? USDG : underlying;
  const [market, validExpiry, operator, free, feeParams, longId] = await Promise.all([
    client.readContract({ blockNumber, address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [underlying] }),
    client.readContract({ blockNumber, address: calendar, abi: expiryCalendarAbi, functionName: "isValidExpiry", args: [expiry] }),
    client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "isOperator", blockNumber, args: [account, orderBook] }),
    client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "free", blockNumber, args: [account, collateralAsset] }),
    client.readContract({ blockNumber, address: orderBook, abi: orderBookAbi, functionName: "feeParams" }),
    client.readContract({ blockNumber, address: clearinghouse, abi: clearinghouseAbi, functionName: "longIdOf", args: [underlying, isPut, strike, expiry] }),
  ]);
  if (!market.enabled || market.mintPaused) throw new Error("Writing is paused for this market.");
  if (!validExpiry || strike % market.strikeTick !== 0n) throw new Error("Choose a calendar expiry and a strike on the market tick.");
  if (Number(feeParams.premiumFeeBps) !== expectedPremiumFeeBps) throw new Error("The on-chain fee changed. Refresh the market before listing.");
  const exists = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "seriesExists", args: [longId], blockNumber });
  const mintCutoff = exists ? Number(await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "mintCutoff", args: [longId], blockNumber })) : null;
  if (mintCutoff !== null && mintCutoff <= now + 60) throw new Error("This series is past its writing cutoff.");
  const rent = exists
    ? await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "mintFee", args: [longId, units], blockNumber })
    : mintRent(units, { collateralPerUnit: collateralPerUnit(isPut, strike), mintFeePpm: market.mintFeePpm, expiry, snapshotTimestamp: now });
  const collateralRequired = units * collateralPerUnit(isPut, strike) + rent;
  if (free < collateralRequired) throw new Error(`Deposit enough free ${isPut ? "USDG" : "Stock Tokens"} for this ask first.`);
  return { longId, exists, operator, free, mintCutoff, rent, collateralRequired };
}

export async function readMintCutoff(longId: bigint, client: PublicClient = publicClient): Promise<number> {
  return Number(await client.readContract({ address: requireV2Address("clearinghouse"), abi: clearinghouseAbi,
    functionName: "mintCutoff", args: [longId] }));
}

export function nextAskExpiry(now: number, cutoff: number): number {
  const validUntil = Math.min(cutoff - 1, now + 7 * 86_400);
  if (validUntil <= now + 60) throw new Error("This series is too close to cutoff for a new ask.");
  return validUntil;
}

/** Estimate at one block; an existing series retains its creation-time rent rate. */
export async function readWriterRent(underlying: Address, isPut: boolean, strike: bigint, expiry: number,
  units: bigint, account?: Address, client: PublicClient = publicClient) {
  const clearinghouse = requireV2Address("clearinghouse");
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const longId = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi,
    functionName: "longIdOf", args: [underlying, isPut, strike, expiry], blockNumber });
  const exists = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi,
    functionName: "seriesExists", args: [longId], blockNumber });
  const terms = exists
    ? await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "series", args: [longId], blockNumber })
    : await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [underlying], blockNumber });
  const rent = exists ? await client.readContract({ address: clearinghouse, abi: clearinghouseAbi,
    functionName: "mintFee", args: [longId, units], blockNumber }) : mintRent(units, {
    collateralPerUnit: collateralPerUnit(isPut, strike), mintFeePpm: terms.mintFeePpm,
    expiry, snapshotTimestamp: Number(block.timestamp),
  });
  const free = account ? await client.readContract({ address: clearinghouse, abi: clearinghouseAbi,
    functionName: "free", args: [account, isPut ? USDG : underlying], blockNumber }) : null;
  return { rent, free, mintFeePpm: terms.mintFeePpm, snapshotTimestamp: Number(block.timestamp) };
}
