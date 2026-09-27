import { createPublicClient, custom, toHex, type PublicClient } from "viem";
import { robinhoodChain } from "../../chain";

/**
 * Test double: a REAL viem client whose chain head moves one block on every
 * eth_blockNumber. It keeps viem's default block-number cache for this chain (4 s, the same as
 * the app's clients), so a caller that reads the head without `cacheTime: 0` gets the first head
 * back on its second read, and a test that reads twice sees the stale pin. Only `getBlockNumber`
 * is real; the reads it pins (readContract, multicall, getBlock) come from `stubs`.
 */
export function advancingHeadClient(first: bigint, stubs: Record<string, unknown>): PublicClient {
  let head = first;
  const client = createPublicClient({ chain: robinhoodChain, transport: custom({
    async request({ method }: { method: string }) {
      if (method === "eth_blockNumber") return toHex(head++);
      throw new Error(`Unexpected RPC ${method}`);
    },
  }) });
  return Object.assign(client, stubs) as unknown as PublicClient;
}
