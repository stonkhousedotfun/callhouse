import { zeroAddress, type Address, type PublicClient } from "viem";
import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { payoutAdapterAbi } from "../abi/v2/payoutAdapter";
import { publicClient } from "../chain";
import { requireV2Address } from "./config";

export function conversionFloorBps(maxSlippageBps: number, routeFeeBps: number): number {
  if (![maxSlippageBps, routeFeeBps].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new RangeError("Invalid conversion bounds");
  return 10_000 - Math.min(300, maxSlippageBps + Math.min(100, routeFeeBps));
}

export type ConversionFloorState =
  | { kind: "routed"; floorBps: number }
  | { kind: "unrouted" }
  | { kind: "unset" };

export async function readConversionFloorState(asset: Address, client: PublicClient = publicClient): Promise<ConversionFloorState> {
  const blockNumber = await client.getBlockNumber();
  const clearinghouse = requireV2Address("clearinghouse");
  const [adapter, slippage] = await client.multicall({ allowFailure: false, blockNumber, contracts: [
    { address: clearinghouse, abi: clearinghouseAbi, functionName: "payoutAdapter" },
    { address: clearinghouse, abi: clearinghouseAbi, functionName: "maxPayoutSlippageBps" },
  ] });
  if (adapter === zeroAddress) return { kind: "unset" };
  const route = await client.readContract({ address: adapter, abi: payoutAdapterAbi,
    functionName: "routes", args: [asset], blockNumber });
  if (route.venue === 0) return { kind: "unrouted" };
  const routeFee = await client.readContract({ address: adapter, abi: payoutAdapterAbi,
    functionName: "routeFeeBps", args: [asset], blockNumber });
  return { kind: "routed", floorBps: conversionFloorBps(Number(slippage), Number(routeFee)) };
}

/** Numeric compatibility for callers that only need a usable floor. */
export async function readConversionFloor(asset: Address, client: PublicClient = publicClient): Promise<number | null> {
  const state = await readConversionFloorState(asset, client);
  return state.kind === "routed" ? state.floorBps : null;
}
