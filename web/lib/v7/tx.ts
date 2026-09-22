import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";

import { v7ClearinghouseAbi } from "@/lib/abi/v7/clearinghouse";
import { v7OrderBookAbi } from "@/lib/abi/v7/orderBook";
import { publicClient, robinhoodChain } from "@/lib/chain";
import { explainV2Error } from "@/lib/v2/errors";
import { V2ReceiptUnknownError, waitForV2Receipt } from "@/lib/v2/txStatus";

import { V7_DEPLOYMENT } from "./config";

export type V7WriteContext = {
  account: Address;
  wallet: WalletClient;
  client?: PublicClient;
  onConfirmed?: (hash: Hex) => void | Promise<void>;
};

export class V7WriteError extends Error {
  constructor(cause: unknown) {
    super(explainV2Error(cause), { cause });
    this.name = "V7WriteError";
  }
}

async function simulatedV7Write(
  context: V7WriteContext,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<Hex> {
  const client = context.client ?? publicClient;
  if (await context.wallet.getChainId() !== robinhoodChain.id) {
    throw new Error("Switch to Robinhood Chain to continue.");
  }
  try {
    const { request } = await client.simulateContract({
      account: context.account, address, abi, functionName, args,
    });
    const hash = await context.wallet.writeContract({ ...request, account: context.account, chain: robinhoodChain });
    await waitForV2Receipt(client, hash, `v7 ${functionName}`);
    try { await context.onConfirmed?.(hash); } catch { /* confirmed write remains final */ }
    return hash;
  } catch (error) {
    if (error instanceof V2ReceiptUnknownError) throw error;
    throw new V7WriteError(error);
  }
}

export function redeemV7(context: V7WriteContext, tokenId: bigint) {
  return simulatedV7Write(context, V7_DEPLOYMENT.contracts.clearinghouse, v7ClearinghouseAbi, "redeem", [tokenId, context.account]);
}

export function closeV7(context: V7WriteContext, longId: bigint, units: bigint) {
  if (units <= 0n) throw new RangeError("Close size must be positive.");
  return simulatedV7Write(context, V7_DEPLOYMENT.contracts.clearinghouse, v7ClearinghouseAbi, "close", [longId, units]);
}

export function withdrawV7(context: V7WriteContext, asset: Address, amount: bigint) {
  if (amount <= 0n) throw new RangeError("Withdrawal amount must be positive.");
  return simulatedV7Write(context, V7_DEPLOYMENT.contracts.clearinghouse, v7ClearinghouseAbi, "withdraw", [asset, amount, context.account]);
}

export function cancelV7(context: V7WriteContext, orderId: bigint) {
  return simulatedV7Write(context, V7_DEPLOYMENT.contracts.orderBook, v7OrderBookAbi, "cancel", [[orderId]]);
}

/** Claims v7 OrderBook USDG owed to this wallet; it cannot open or increase risk. */
export function claimOwedV7(context: V7WriteContext) {
  return simulatedV7Write(context, V7_DEPLOYMENT.contracts.orderBook, v7OrderBookAbi, "claimOwed", []);
}
