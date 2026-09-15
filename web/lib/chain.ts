import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";

/**
 * Robinhood Chain mainnet, an Arbitrum Orbit L2. Chain id 4663 = 0x1237.
 *
 * Two RPCs, in this order, and the order matters:
 *   1. rpc.mainnet.chain.robinhood.com — archive reads work, full-range eth_getLogs works.
 *   2. robinhood-rpc.publicnode.com    — fine for eth_call, but it REJECTS eth_getLogs over
 *      old ranges with "Archive requests require a personal token".
 * So the fallback transport is safe for the contract reads that make up 99% of this app, and
 * the log scan on /activity deliberately uses `archiveClient` (primary only) instead.
 *
 * Testnet 46630 is intentionally not defined here. It has no NVDA Stock Token and no
 * clearinghouse this vault can use (ops/addresses.json records what is there and why not), so
 * there is nothing for this UI to render there.
 */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);

const PRIMARY_RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const BACKUP_RPC = process.env.NEXT_PUBLIC_RPC_URL_2 ?? "https://robinhood-rpc.publicnode.com";

/**
 * Blockscout is the canonical explorer. Its *API* sits behind a Cloudflare JS challenge, so
 * nothing in this app may fetch from it — links only, opened by a real browser with a real
 * challenge cookie. robinscan.io / hoodscan.co / stonkscan.io are the alternates.
 */
export const EXPLORER_URL = (
  process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://robinhoodchain.blockscout.com"
).replace(/\/+$/, "");

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [PRIMARY_RPC, BACKUP_RPC] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: EXPLORER_URL },
  },
  contracts: {
    // Multicall3 is deployed at the canonical address on 4663 (eth_getCode confirmed).
    // Without this every vault read would be its own round trip; with it, one call.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/** Read client used outside React (route handlers, one-off reads). Both RPCs, in order. */
export const publicClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: fallback([http(PRIMARY_RPC), http(BACKUP_RPC)], { rank: false }),
  batch: { multicall: true },
});

/**
 * Primary RPC ONLY. Use for eth_getLogs. The backup returns
 * "Archive requests require a personal token" for anything but a recent range, and a fallback
 * transport would happily hand you that error as if it were the answer.
 */
export const archiveClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(PRIMARY_RPC),
});

export function txUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function tokenUrl(address: string): string {
  return `${EXPLORER_URL}/token/${address}`;
}
