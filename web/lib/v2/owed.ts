/**
 * USDG the OrderBook OWES an account because a payment to it could not be transferred.
 *
 * `OrderBook` pays makers, takers and resale sellers best effort: a USDG transfer that reverts or returns false (USDG
 * paused, the recipient frozen) is credited to `owed(account)` instead, and emits NO log of its own
 * (callhouse-contracts src/v2/OrderBook.sol, "PAYMENTS NEVER BLOCK"). So the indexer cannot see the credit, and this
 * reads it straight from the chain. `claimOwed()` sends the whole balance to the caller, is caller-only, and is never
 * pausable. It is not the MakerVault or HouseVault `claimOwed`, which are keeper-restricted.
 */
import type { Address, Hex, PublicClient } from "viem";

import { orderBookAbi } from "../abi/v2/orderBook";
import { publicClient } from "../chain";
import { fmtUsdg } from "../format";
import { requireV2Address } from "./config";
import { simulatedWrite, type WriteContext } from "./tx";

export async function readOrderBookOwed(account: Address, client: PublicClient = publicClient): Promise<bigint> {
  return client.readContract({ address: requireV2Address("orderBook"), abi: orderBookAbi, functionName: "owed", args: [account] });
}

export function claimOrderBookOwed(context: WriteContext): Promise<Hex> {
  return simulatedWrite(context, requireV2Address("orderBook"), orderBookAbi, "claimOwed", []);
}

export type OwedBannerModel = { amount: string; raw: bigint };

/**
 * The banner shows only for an observed, positive balance. Not read (null) is NOT zero, but it is also not money
 * anyone can claim, so it shows nothing rather than a banner with no amount.
 */
export function owedBanner(owed: bigint | null | undefined): OwedBannerModel | null {
  if (owed === null || owed === undefined || owed <= 0n) return null;
  return { amount: `${fmtUsdg(owed, 2)} USDG`, raw: owed };
}
