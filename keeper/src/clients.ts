/**
 * viem clients.
 *
 * Three of them, and the split is deliberate:
 *
 *  - `publicClient`  reads and simulations. Uses a `fallback` transport across both RPCs so a
 *                    single provider outage does not stop the weekly roll.
 *  - `logClient`     eth_getLogs only, pinned to the PRIMARY RPC. The backup
 *                    (robinhood-rpc.publicnode.com) rejects archive log ranges with
 *                    "Archive requests require a personal token", and a fallback transport
 *                    would happily retry the query there and return a confusing error — or
 *                    worse, an empty result set that reads as "nothing happened".
 *  - `walletClient`  transaction submission from the keeper hot key. Also pinned to the
 *                    primary, because nonce management across two providers with different
 *                    mempool views is a source of stuck transactions; on a primary outage the
 *                    keeper alerts rather than quietly double-spending a nonce.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';

/** Robinhood Chain mainnet, an Arbitrum Orbit L2. Chain id 4663 == 0x1237. */
export const robinhoodChain: Chain = defineChain({
  id: config.CHAIN_ID,
  name: config.CHAIN_ID === 4663 ? 'Robinhood Chain' : `Chain ${config.CHAIN_ID}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: config.RH_RPC_2 ? [config.RH_RPC, config.RH_RPC_2] : [config.RH_RPC] },
  },
  contracts: {
    multicall3: { address: config.MULTICALL3 },
  },
});

const primaryTransport = http(config.RH_RPC, {
  timeout: 20_000,
  retryCount: 2,
  retryDelay: 250,
});

const backupTransport = config.RH_RPC_2
  ? http(config.RH_RPC_2, { timeout: 20_000, retryCount: 1, retryDelay: 250 })
  : undefined;

/** Reads and simulations, with automatic failover to the backup RPC. */
export const publicClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: backupTransport
    ? fallback([primaryTransport, backupTransport], { rank: false, retryCount: 1 })
    : primaryTransport,
  // Concurrent eth_calls in the same tick are aggregated through Multicall3. This is what
  // makes the per-tick snapshot a couple of round trips instead of thirty.
  batch: { multicall: { wait: 8 } },
});

/** eth_getLogs only. Primary RPC, no fallback: the backup refuses archive ranges. */
export const logClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: primaryTransport,
});

/** The keeper hot key. Holds gas and KEEPER_ROLE. It can never move depositor funds. */
export const account = privateKeyToAccount(config.KEEPER_PK);

export const walletClient: WalletClient = createWalletClient({
  account,
  chain: robinhoodChain,
  transport: primaryTransport,
});

/** Which RPC each client is pointed at, for /health. */
export const rpcEndpoints = {
  primary: config.RH_RPC,
  backup: config.RH_RPC_2 ?? null,
} as const;
