import { type Abi, type Address, type Hex } from "viem";

import { earnVaultAbi } from "../abi/v2/earnVault";
import { publicClient, robinhoodChain } from "../chain";
import { resolveV2Address, requireV2Address } from "./config";
import { explainV2Error } from "./errors";
import type { WriteContext } from "./tx";
import { V2ReceiptUnknownError, waitForV2Receipt } from "./txStatus";

/**
 * THE VAULT ADDRESS IS RESOLVED, NOT HARDCODED. It used to `return null` unconditionally, with a
 * comment saying the vault must be "never an env var, never an API-only address". The owner
 * reversed the env-var half on 2026-09-20 (the lending vault deploys soon and `/lend` must be able
 * to see it); the API half stands and is unchanged — an address still never comes from `/v2/config`
 * or from an epoch file, only from the generated registry or a validated build-time override.
 *
 * Under design B there is no `earnVault` key in the registry at all, so today this resolves from
 * `NEXT_PUBLIC_V2_EARN_VAULT` or it resolves to nothing. `resolveV2Address` validates the value
 * through the same `getAddress` path as every registry address, so a malformed variable becomes
 * `null` here rather than an unchecked cast reaching `simulateContract`.
 */
export function earnVaultAddress(): Address | null {
  return resolveV2Address("earnVault").address;
}

export function requireEarnVaultAddress(): Address {
  return requireV2Address("earnVault");
}

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

export async function depositToVault(context: WriteContext, assets: bigint): Promise<Hex> {
  if (assets <= 0n) throw new Error("Enter a positive deposit.");
  const vault = requireEarnVaultAddress();
  return write(context, vault, earnVaultAbi, "deposit", [assets, context.account]);
}

export async function redeemFromVault(context: WriteContext, shares: bigint): Promise<Hex> {
  if (shares <= 0n) throw new Error("Enter a positive share amount.");
  const vault = requireEarnVaultAddress();
  return write(context, vault, earnVaultAbi, "redeem", [shares, context.account]);
}

export async function processVaultQueue(context: WriteContext, maxEntries: bigint): Promise<Hex> {
  const vault = requireEarnVaultAddress();
  return write(context, vault, earnVaultAbi, "processQueue", [maxEntries]);
}
