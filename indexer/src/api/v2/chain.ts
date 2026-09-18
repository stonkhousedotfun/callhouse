import { publicClients } from "ponder:api";
import type { Address } from "viem";

import { clearinghouseAbi } from "../../../abis/v2/clearinghouse";
import { settlementOracleAbi } from "../../../abis/v2/settlementOracle";
import { CHAIN_NAME, LIVE_READ_TIMEOUT_MS, V2_CLEARINGHOUSE, V2_SETTLEMENT_ORACLE } from "../../../lib/env";

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
