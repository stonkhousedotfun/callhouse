/**
 * The chain as the v2 bots see it: clients, typed contract handles over the generated ABIs,
 * multicall helpers, and the head block's clock.
 *
 * CLIENTS, split as in v1's clients.ts and for the same reasons:
 *   publicClient  reads and simulations, `fallback` across RH_RPC and RH_RPC_2;
 *   logClient     eth_getLogs, pinned to RH_RPC (the public backup refuses archive log ranges and a
 *                 fallback would turn that into an empty result that reads as "nothing happened");
 *   walletClient  sends, pinned to RH_RPC: nonces across two mempool views are how transactions
 *                 get stuck. One key per process (tx.ts serialises every send through it).
 *
 * HANDLES are viem `getContract` objects over the public client only: `.read`, `.simulate`,
 * `.getEvents`, never `.write`. Every write goes through tx.ts, so nothing can skip the
 * simulate → send → record → wait discipline by calling `handle.write.settle()`. The ABIs are the
 * generated modules in ./abi (never hand-edited; `pnpm gen:abis`). RewardsDistributor has an address
 * (config.ts) but no handle: no bot calls it.
 *
 * TIME. Every protocol decision uses the head block's timestamp (`readHead`, `headTimestamp`), never
 * the wall clock: the contracts compare against `block.timestamp`, and a keeper that decides
 * "expiry has passed" from its own clock sends into a TooEarly revert whenever the RPC lags. The wall
 * clock is used for exactly one thing, measuring that lag (`rpcLagSeconds`).
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  getContract,
  http,
  type Abi,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type GetContractReturnType,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { autoRollerAbi } from './abi/autoRoller.js';
import { clearinghouseAbi } from './abi/clearinghouse.js';
import { expiryCalendarAbi } from './abi/expiryCalendar.js';
import { keeperRewardsAbi } from './abi/keeperRewards.js';
import { makerRegistryAbi } from './abi/makerRegistry.js';
import { makerVaultAbi } from './abi/makerVault.js';
import { orderBookAbi } from './abi/orderBook.js';
import { payoutAdapterAbi } from './abi/payoutAdapter.js';
import { settlementOracleAbi } from './abi/settlementOracle.js';
import type { V2ContractName } from './registry.js';

/*//////////////////////////////////////////////////////////////
                            CLIENTS
//////////////////////////////////////////////////////////////*/

export interface ChainOptions {
  chainId: number;
  /** Primary first. */
  rpcUrls: readonly [string, ...string[]];
  multicall3: Address;
  /** How often a receipt wait polls. Default 1 s: viem's 4 s default turns a 40-transaction redeem
   *  backlog on a sub-second chain into minutes of waiting. */
  pollingIntervalMs?: number;
}

export const DEFAULT_POLLING_INTERVAL_MS = 1_000;

export function defineV2Chain(options: ChainOptions): Chain {
  return defineChain({
    id: options.chainId,
    name: options.chainId === 4663 ? 'Robinhood Chain' : `Chain ${options.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [...options.rpcUrls] } },
    contracts: { multicall3: { address: options.multicall3 } },
  });
}

export interface V2Clients {
  chain: Chain;
  publicClient: PublicClient;
  logClient: PublicClient;
}

export interface V2Signer {
  account: PrivateKeyAccount;
  walletClient: WalletClient;
}

function primaryTransport(url: string) {
  return http(url, { timeout: 20_000, retryCount: 2, retryDelay: 250 });
}

/** Builds clients; dials nothing until the first request. */
export function createV2Clients(options: ChainOptions): V2Clients {
  const chain = defineV2Chain(options);
  const [primary, ...backups] = options.rpcUrls;
  const transports = [primaryTransport(primary), ...backups.map((url) => http(url, { timeout: 20_000, retryCount: 1, retryDelay: 250 }))];
  return {
    chain,
    publicClient: createPublicClient({
      chain,
      transport: transports.length > 1 ? fallback(transports, { rank: false, retryCount: 1 }) : transports[0]!,
      // Concurrent eth_calls in one tick are aggregated through Multicall3, as in v1.
      batch: { multicall: { wait: 8 } },
      pollingInterval: options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
    }),
    logClient: createPublicClient({ chain, transport: primaryTransport(primary) }),
  };
}

/** The mode's hot key and a wallet client pinned to the primary RPC. */
export function createV2Signer(clients: V2Clients, options: { privateKey: Hex; primaryRpc: string }): V2Signer {
  const account = privateKeyToAccount(options.privateKey);
  return { account, walletClient: createWalletClient({ account, chain: clients.chain, transport: primaryTransport(options.primaryRpc) }) };
}

/*//////////////////////////////////////////////////////////////
                         CONTRACT HANDLES
//////////////////////////////////////////////////////////////*/

/** The contracts with a generated ABI module, by registry name. */
export const V2_ABIS = {
  clearinghouse: clearinghouseAbi,
  orderBook: orderBookAbi,
  settlementOracle: settlementOracleAbi,
  expiryCalendar: expiryCalendarAbi,
  keeperRewards: keeperRewardsAbi,
  autoRoller: autoRollerAbi,
  payoutAdapter: payoutAdapterAbi,
  makerRegistry: makerRegistryAbi,
  makerVault: makerVaultAbi,
} as const satisfies Partial<Record<V2ContractName, Abi>>;

export type AbiContractName = keyof typeof V2_ABIS;

/** Keyed `{ public }` only: viem then builds no `.write` (a bare client would count as both). */
export type ContractHandle<K extends AbiContractName> = GetContractReturnType<(typeof V2_ABIS)[K], { public: PublicClient }>;

/** A handle for every contract with an ABI; non-null exactly where the address type is. */
export type ContractHandles<C extends Record<V2ContractName, Address | null>> = {
  [K in AbiContractName]: C[K] extends Address ? ContractHandle<K> : ContractHandle<K> | null;
};

export function contractHandles<C extends Record<V2ContractName, Address | null>>(client: PublicClient, contracts: C): ContractHandles<C> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(V2_ABIS) as AbiContractName[]) {
    const address = contracts[name];
    out[name] = address === null ? null : getContract({ address, abi: V2_ABIS[name], client: { public: client } });
  }
  return out as ContractHandles<C>;
}

/*//////////////////////////////////////////////////////////////
                            MULTICALL
//////////////////////////////////////////////////////////////*/

export type ReadMutability = 'view' | 'pure';
export type ReadFunctionName<TAbi extends Abi> = ContractFunctionName<TAbi, ReadMutability>;

/** One view call. Homogeneous batches (one function over many args) keep full result typing. */
export interface ReadCall<TAbi extends Abi, TName extends ReadFunctionName<TAbi>> {
  address: Address;
  abi: TAbi;
  functionName: TName;
  args?: ContractFunctionArgs<TAbi, ReadMutability, TName>;
}

export type ReadOutcome<T> = { ok: true; result: T } | { ok: false; error: Error };

export type MulticallClient = Pick<PublicClient, 'multicall' | 'getBlockNumber'>;

/** Multicall3 aggregates are one eth_call; past a few hundred calls a node's gas cap refuses it. */
export const DEFAULT_MULTICALL_CHUNK = 200;

/** `items` in consecutive slices of at most `size`. Pure. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Read many view calls through Multicall3 in chunks; one outcome per call, in order, failures
 * included (a reverted call is `ok: false`, not a thrown batch).
 *
 * Every chunk is pinned to ONE block: the caller's `blockNumber`, or the head read once up front
 * when there is more than one chunk. Unpinned, chunk 1 and chunk 2 can straddle a block, and a
 * holder list read that way can count a transfer twice or not at all.
 */
export async function multicallMany<const TAbi extends Abi, TName extends ReadFunctionName<TAbi>>(
  client: MulticallClient,
  calls: readonly ReadCall<TAbi, TName>[],
  options: { chunkSize?: number; blockNumber?: bigint } = {},
): Promise<ReadOutcome<ContractFunctionReturnType<TAbi, ReadMutability, TName>>[]> {
  if (calls.length === 0) return [];
  const slices = chunk(calls, options.chunkSize ?? DEFAULT_MULTICALL_CHUNK);
  const blockNumber = options.blockNumber ?? (slices.length > 1 ? await client.getBlockNumber() : undefined);
  const out: ReadOutcome<ContractFunctionReturnType<TAbi, ReadMutability, TName>>[] = [];
  for (const slice of slices) {
    const results = (await client.multicall({
      contracts: slice as never,
      allowFailure: true,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })) as Array<{ status: 'success'; result: unknown } | { status: 'failure'; error: Error }>;
    for (const r of results) {
      out.push(r.status === 'success' ? { ok: true, result: r.result as ContractFunctionReturnType<TAbi, ReadMutability, TName> } : { ok: false, error: r.error });
    }
  }
  return out;
}

export class MulticallError extends Error {
  constructor(
    message: string,
    readonly index: number,
    override readonly cause: Error,
  ) {
    super(message);
    this.name = 'MulticallError';
  }
}

/** multicallMany, but every call must succeed: throws naming the first failure. */
export async function multicallStrict<const TAbi extends Abi, TName extends ReadFunctionName<TAbi>>(
  client: MulticallClient,
  calls: readonly ReadCall<TAbi, TName>[],
  options: { chunkSize?: number; blockNumber?: bigint } = {},
): Promise<ContractFunctionReturnType<TAbi, ReadMutability, TName>[]> {
  const outcomes = await multicallMany(client, calls, options);
  return outcomes.map((o, i) => {
    if (!o.ok) {
      const call = calls[i]!;
      throw new MulticallError(`multicall ${i} ${call.functionName} on ${call.address} failed: ${o.error.message.split('\n')[0]}`, i, o.error);
    }
    return o.result;
  });
}

/*//////////////////////////////////////////////////////////////
                         THE HEAD BLOCK
//////////////////////////////////////////////////////////////*/

export interface Head {
  blockNumber: bigint;
  /** Unix seconds: `block.timestamp` of the head. */
  timestamp: number;
}

/** The latest block's number and timestamp: the clock every protocol decision uses. */
export async function readHead(client: Pick<PublicClient, 'getBlock'>): Promise<Head> {
  const block = await client.getBlock({ blockTag: 'latest' });
  return { blockNumber: block.number, timestamp: Number(block.timestamp) };
}

/** `block.timestamp` of the head. Use this, never `Date.now()`, for "has expiry passed". */
export async function headTimestamp(client: Pick<PublicClient, 'getBlock'>): Promise<number> {
  return (await readHead(client)).timestamp;
}

/** How far the head trails the wall clock, whole seconds, never negative. The one wall-clock use. */
export function rpcLagSeconds(head: Head, nowMs: number): number {
  return Math.max(0, Math.floor(nowMs / 1000) - head.timestamp);
}

/*//////////////////////////////////////////////////////////////
                             WIRING
//////////////////////////////////////////////////////////////*/

/** What the configured addresses must say about each other. */
export interface WiringExpectation {
  clearinghouse: Address;
  orderBook: Address | null;
  expiryCalendar: Address | null;
  /** The registry's `shared.usdg`. */
  usdg: Address | null;
}

/** What the chain says, null where the view was not read or reverted. */
export interface WiringObservation {
  orderBookClearinghouse: Address | null;
  clearinghouseCalendar: Address | null;
  clearinghouseUsdg: Address | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Mismatches between configured and on-chain wiring, as sentences. Pure. An env address set for a
 * rehearsal next to a registry address from production is exactly the mix this catches: a cranker
 * pruning orders on one deployment's book and settling on another's clearinghouse.
 */
export function wiringProblems(expected: WiringExpectation, observed: WiringObservation): string[] {
  const problems: string[] = [];
  if (expected.orderBook !== null) {
    if (observed.orderBookClearinghouse === null) problems.push(`orderBook ${expected.orderBook}: clearinghouse() could not be read`);
    else if (!same(observed.orderBookClearinghouse, expected.clearinghouse)) {
      problems.push(`orderBook ${expected.orderBook} belongs to clearinghouse ${observed.orderBookClearinghouse}, not the configured ${expected.clearinghouse}`);
    }
  }
  if (expected.expiryCalendar !== null) {
    if (observed.clearinghouseCalendar === null) problems.push(`clearinghouse ${expected.clearinghouse}: calendar() could not be read`);
    else if (!same(observed.clearinghouseCalendar, expected.expiryCalendar)) {
      // The calendar pointer is admin-settable for NEW series (ADR-07); after a switch the registry must follow.
      problems.push(`clearinghouse ${expected.clearinghouse} uses calendar ${observed.clearinghouseCalendar}, not the configured ${expected.expiryCalendar}`);
    }
  }
  if (expected.usdg !== null) {
    if (observed.clearinghouseUsdg === null) problems.push(`clearinghouse ${expected.clearinghouse}: usdg() could not be read`);
    else if (!same(observed.clearinghouseUsdg, expected.usdg)) {
      problems.push(`clearinghouse ${expected.clearinghouse} settles in ${observed.clearinghouseUsdg}, not the registry's USDG ${expected.usdg}`);
    }
  }
  return problems;
}

/** Read the views wiringProblems compares. The public client's batching folds them into one eth_call. */
export async function readWiring(client: Pick<PublicClient, 'readContract'>, expected: WiringExpectation): Promise<WiringObservation> {
  const [orderBookClearinghouse, clearinghouseCalendar, clearinghouseUsdg] = await Promise.all([
    expected.orderBook === null
      ? Promise.resolve(null)
      : client.readContract({ address: expected.orderBook, abi: orderBookAbi, functionName: 'clearinghouse' }).catch(() => null),
    client.readContract({ address: expected.clearinghouse, abi: clearinghouseAbi, functionName: 'calendar' }).catch(() => null),
    client.readContract({ address: expected.clearinghouse, abi: clearinghouseAbi, functionName: 'usdg' }).catch(() => null),
  ]);
  return { orderBookClearinghouse, clearinghouseCalendar, clearinghouseUsdg };
}
