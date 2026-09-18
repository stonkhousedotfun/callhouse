/**
 * The views an MM tick plans from, read in multicalls pinned to the tick's head block (chain.ts multicallMany; a view
 * that reverts is a failed outcome, not a thrown batch). Nothing here decides (planner.ts) or sends (quoter.ts).
 */
import { getAbiItem, keccak256, parseAbi, toBytes, zeroHash, type AbiEvent, type Address } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import { makerVaultAbi } from '../abi/makerVault.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import type { MulticallClient } from '../chain.js';
import { okResult, readMany, type AnyRead } from '../cranker/reads.js';
import { ORDER_KIND } from './constants.js';
import type { LiveOrder, SeriesInfo } from './engine.js';
import type { FillLog } from './pnl.js';
import type { ExposureDetail, MarketView, SeriesView, VaultLimits } from './planner.js';

export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

export const QUOTER_ROLE = keccak256(toBytes('QUOTER_ROLE'));
export const DEFAULT_ADMIN_ROLE = zeroHash;

export interface MmAddresses {
  clearinghouse: Address;
  orderBook: Address;
  vault: Address;
  usdg: Address;
}

const lc = (a: string): string => a.toLowerCase();

function must<T>(outcome: { ok: true; result: unknown } | { ok: false; error: Error } | undefined, what: string): T {
  if (outcome === undefined) throw new Error(`${what}: no result`);
  if (!outcome.ok) throw new Error(`${what}: ${outcome.error.message.split('\n')[0]}`);
  return outcome.result as T;
}

/*//////////////////////////////////////////////////////////////
                              VAULT
//////////////////////////////////////////////////////////////*/

export interface VaultState {
  limits: VaultLimits;
  /** MakerVault.outflow(): net USDG the quoter has moved out of the vault, and what the cap still allows. */
  outflow: { used: bigint; available: bigint };
  totalNotional: bigint;
  tracked: bigint[];
  isQuoter: boolean;
  tradingPaused: boolean;
  owed: bigint;
  makerOrderCount: bigint;
  usdgWallet: bigint;
  fees: { premiumFeeBps: number; resaleFeeBps: number };
  sessionOpen: boolean;
  sessionClose: number | null;
}

export async function readVaultState(client: MulticallClient, a: MmAddresses, input: { signer: Address; calendar: Address; now: number; blockNumber: bigint }): Promise<VaultState> {
  const day = Math.floor(input.now / 86_400);
  const calls: AnyRead[] = [
    { address: a.vault, abi: makerVaultAbi, functionName: 'limits' },
    { address: a.vault, abi: makerVaultAbi, functionName: 'totalNotional' },
    { address: a.vault, abi: makerVaultAbi, functionName: 'trackedSeries' },
    { address: a.vault, abi: makerVaultAbi, functionName: 'hasRole', args: [QUOTER_ROLE, input.signer] },
    { address: a.vault, abi: makerVaultAbi, functionName: 'hasRole', args: [DEFAULT_ADMIN_ROLE, input.signer] },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'tradingPaused' },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'owed', args: [a.vault] },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'makerOrderCount', args: [a.vault] },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'feeParams' },
    { address: a.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [a.vault] },
    { address: input.calendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [input.now] },
    { address: input.calendar, abi: expiryCalendarAbi, functionName: 'closeOf', args: [day] },
    // INTERFACE_VERSION 7 (c21): the leaky bucket behind limits.maxDailyOutflow, in the same pinned multicall.
    { address: a.vault, abi: makerVaultAbi, functionName: 'outflow' },
  ];
  const r = await readMany(client, calls, input.blockNumber);
  // Six fields since INTERFACE_VERSION 7: a positional decode that drops maxDailyOutflow would not encode setLimits.
  const limits = must<{ maxSeriesUnits: bigint; maxTotalNotional: bigint; askToleranceBps: number; maxBidBpsOfSpot: number; maxOrderLifetime: number; maxDailyOutflow: bigint }>(r[0], 'vault.limits');
  const fees = must<{ premiumFeeBps: number; resaleFeeBps: number }>(r[8], 'orderBook.feeParams');
  const sessionOpen = must<boolean>(r[10], 'calendar.isRegularSession');
  const outflow = must<readonly [bigint, bigint]>(r[12], 'vault.outflow');
  return {
    limits: {
      maxSeriesUnits: BigInt(limits.maxSeriesUnits),
      maxTotalNotional: BigInt(limits.maxTotalNotional),
      askToleranceBps: Number(limits.askToleranceBps),
      maxBidBpsOfSpot: Number(limits.maxBidBpsOfSpot),
      maxOrderLifetime: Number(limits.maxOrderLifetime),
      maxDailyOutflow: BigInt(limits.maxDailyOutflow),
    },
    outflow: { used: outflow[0], available: outflow[1] },
    totalNotional: must<bigint>(r[1], 'vault.totalNotional'),
    tracked: [...must<readonly bigint[]>(r[2], 'vault.trackedSeries')],
    isQuoter: must<boolean>(r[3], 'vault.hasRole(QUOTER_ROLE)') || must<boolean>(r[4], 'vault.hasRole(DEFAULT_ADMIN_ROLE)'),
    tradingPaused: must<boolean>(r[5], 'orderBook.tradingPaused'),
    owed: must<bigint>(r[6], 'orderBook.owed'),
    makerOrderCount: must<bigint>(r[7], 'orderBook.makerOrderCount'),
    usdgWallet: must<bigint>(r[9], 'usdg.balanceOf(vault)'),
    fees: { premiumFeeBps: Number(fees.premiumFeeBps), resaleFeeBps: Number(fees.resaleFeeBps) },
    sessionOpen,
    sessionClose: sessionOpen ? Number(must<bigint>(r[11], 'calendar.closeOf')) : null,
  };
}

/*//////////////////////////////////////////////////////////////
                             MARKETS
//////////////////////////////////////////////////////////////*/

export interface MarketsRead {
  markets: Map<string, MarketView>;
  /** Clearinghouse.free(vault, asset), lower-case asset: USDG and every quoted Stock Token. */
  freeCollateral: Map<string, bigint>;
  /** The vault wallet's Stock Token balances. */
  walletTokens: Map<string, bigint>;
}

export async function readMarkets(client: MulticallClient, a: MmAddresses, markets: ReadonlyArray<{ ticker: string; underlying: Address }>, blockNumber: bigint): Promise<MarketsRead> {
  const first: AnyRead[] = [{ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'free', args: [a.vault, a.usdg] }];
  for (const m of markets) {
    first.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'market', args: [m.underlying] });
    first.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'free', args: [a.vault, m.underlying] });
    first.push({ address: m.underlying, abi: erc20Abi, functionName: 'balanceOf', args: [a.vault] });
  }
  const r1 = await readMany(client, first, blockNumber);
  const freeCollateral = new Map<string, bigint>([[lc(a.usdg), okResult<bigint>(r1[0]) ?? 0n]]);
  const walletTokens = new Map<string, bigint>();
  const configs: Array<{ enabled: boolean; mintPaused: boolean; oracle: Address } | undefined> = [];
  markets.forEach((m, i) => {
    configs.push(okResult<{ enabled: boolean; mintPaused: boolean; oracle: Address }>(r1[1 + i * 3]));
    freeCollateral.set(lc(m.underlying), okResult<bigint>(r1[2 + i * 3]) ?? 0n);
    walletTokens.set(lc(m.underlying), okResult<bigint>(r1[3 + i * 3]) ?? 0n);
  });
  const spotCalls: AnyRead[] = markets.map((m, i) => ({ address: configs[i]?.oracle ?? a.clearinghouse, abi: settlementOracleAbi, functionName: 'trySpot', args: [m.underlying] }));
  const r2 = await readMany(client, spotCalls, blockNumber);
  const out = new Map<string, MarketView>();
  markets.forEach((m, i) => {
    const config = configs[i];
    const spot = config === undefined ? undefined : okResult<readonly [boolean, bigint, bigint]>(r2[i]);
    out.set(lc(m.underlying), {
      underlying: lc(m.underlying),
      ticker: m.ticker,
      enabled: config?.enabled ?? false,
      mintPaused: config?.mintPaused ?? true,
      spot: spot !== undefined && spot[0] && spot[1] > 0n ? spot[1] : null,
    });
  });
  return { markets: out, freeCollateral, walletTokens };
}

/*//////////////////////////////////////////////////////////////
                              SERIES
//////////////////////////////////////////////////////////////*/

interface SeriesStruct {
  underlying: Address;
  oracle: Address;
  exerciseFeeBps?: number;
  settled: boolean;
  settlementPrice: bigint;
  isPut: boolean;
  strike: bigint;
  expiry: number;
  /** INTERFACE_VERSION 7 (c05): the rent rate pinned at creation; absent on a v6 series read. */
  mintFeePpm?: number;
}

/** Everything planner.SeriesView needs per series, plus the settlement for the ledger. */
export async function readSeriesViews(
  client: MulticallClient,
  a: MmAddresses,
  input: { series: ReadonlyArray<{ info: SeriesInfo; ticker: string; orders: readonly LiveOrder[] }>; blockNumber: bigint },
): Promise<SeriesView[]> {
  const PER = 7;
  const calls: AnyRead[] = [];
  for (const { info } of input.series) {
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [info.longId] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'exposure', args: [info.longId] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'askFloor', args: [info.longId] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'bidCap', args: [info.longId] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'seriesNotional', args: [info.longId] });
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'collateralAsset', args: [info.longId] });
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'collateralPerUnit', args: [info.longId] });
  }
  const r = await readMany(client, calls, input.blockNumber);
  const structs = input.series.map((_, i) => okResult<SeriesStruct>(r[i * PER]));

  // One trySpot per (oracle, underlying): a series quotes against the oracle it pinned at creation.
  const spotKeys = [...new Set(structs.filter((s): s is SeriesStruct => s !== undefined).map((s) => `${lc(s.oracle)}|${lc(s.underlying)}`))];
  const spotResults = await readMany(
    client,
    spotKeys.map((k) => {
      const [oracle, underlying] = k.split('|') as [Address, Address];
      return { address: oracle, abi: settlementOracleAbi, functionName: 'trySpot', args: [underlying] };
    }),
    input.blockNumber,
  );
  const spots = new Map(spotKeys.map((k, i) => [k, okResult<readonly [boolean, bigint, bigint]>(spotResults[i])]));

  return input.series.map(({ info, ticker, orders }, i) => {
    const s = structs[i];
    const exposure = okResult<readonly [bigint, bigint, ExposureDetail]>(r[i * PER + 1]);
    const spot = s === undefined ? undefined : spots.get(`${lc(s.oracle)}|${lc(s.underlying)}`);
    const fresh = spot !== undefined && spot[0] && spot[1] > 0n;
    return {
      info,
      ticker,
      settled: s?.settled ?? false,
      spotFresh: fresh,
      spot: fresh ? spot[1] : null,
      exposure:
        exposure === undefined
          ? null
          : { longs: exposure[2].longs, shorts: exposure[2].shorts, bids: exposure[2].bids, resale: exposure[2].resale, writes: exposure[2].writes, live: exposure[2].live },
      seriesNotional: okResult<bigint>(r[i * PER + 4]) ?? 0n,
      askFloor: okResult<bigint>(r[i * PER + 2]) ?? null,
      bidCap: okResult<bigint>(r[i * PER + 3]) ?? null,
      collateralAsset: lc(okResult<Address>(r[i * PER + 5]) ?? '0x0000000000000000000000000000000000000000'),
      collateralPerUnit: okResult<bigint>(r[i * PER + 6]) ?? 0n,
      // The series' own pinned rate, not the market's: anyone may have created the series at an earlier rate.
      mintFeePpm: Number(s?.mintFeePpm ?? 0),
      orders,
    };
  });
}

/** Clearinghouse.series settlement fields, by long id (a failed read is absent). */
export async function readSettlements(client: MulticallClient, clearinghouse: Address, longIds: readonly bigint[], blockNumber: bigint): Promise<Map<string, { settled: boolean; settlementPrice: bigint; isPut: boolean; strike: bigint; exerciseFeeBps: number }>> {
  const r = await readMany(client, longIds.map((id) => ({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] })), blockNumber);
  const out = new Map<string, { settled: boolean; settlementPrice: bigint; isPut: boolean; strike: bigint; exerciseFeeBps: number }>();
  longIds.forEach((id, i) => {
    const s = okResult<SeriesStruct>(r[i]);
    if (s !== undefined) out.set(id.toString(), { settled: s.settled, settlementPrice: s.settlementPrice, isPut: s.isPut, strike: s.strike, exerciseFeeBps: Number(s.exerciseFeeBps ?? 0) });
  });
  return out;
}

/** MakerVault.exposure notional of each tracked series (measured now), by long id; null when unreadable. */
export async function readMeasuredNotional(client: MulticallClient, vault: Address, longIds: readonly bigint[], blockNumber: bigint): Promise<Array<{ longId: bigint; stored: bigint; measured: bigint | null }>> {
  const calls: AnyRead[] = [];
  for (const id of longIds) {
    calls.push({ address: vault, abi: makerVaultAbi, functionName: 'seriesNotional', args: [id] });
    calls.push({ address: vault, abi: makerVaultAbi, functionName: 'exposure', args: [id] });
  }
  const r = await readMany(client, calls, blockNumber);
  return longIds.map((longId, i) => {
    const exposure = okResult<readonly [bigint, bigint, unknown]>(r[i * 2 + 1]);
    return { longId, stored: okResult<bigint>(r[i * 2]) ?? 0n, measured: exposure === undefined ? null : exposure[1] };
  });
}

/*//////////////////////////////////////////////////////////////
                              ORDERS
//////////////////////////////////////////////////////////////*/

export interface ChainOrder {
  id: bigint;
  maker: Address;
  longId: bigint;
  kind: (typeof ORDER_KIND)[number];
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

const PAGE = 200n;

/** Order ids of `maker` from index `from` to `to` (exclusive), paged. */
export async function readMakerOrderIds(client: Pick<import('viem').PublicClient, 'readContract'>, orderBook: Address, maker: Address, from: bigint, to: bigint, blockNumber: bigint): Promise<bigint[]> {
  const out: bigint[] = [];
  let cursor = from;
  while (cursor < to) {
    const limit = to - cursor < PAGE ? to - cursor : PAGE;
    const [ids] = (await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: 'ordersOfMaker', args: [maker, cursor, limit], blockNumber })) as readonly [readonly bigint[], bigint];
    if (ids.length === 0) break;
    out.push(...ids);
    cursor += BigInt(ids.length);
  }
  return out;
}

const ORDER_FILLED = getAbiItem({ abi: orderBookAbi, name: 'OrderFilled' }) as AbiEvent;
const MIN_LOG_CHUNK = 100n;

/**
 * OrderBook.OrderFilled logs of `orderIds` (the indexed orderId topic) in [fromBlock, toBlock], read BACKWARDS from
 * `toBlock` in ranges of `chunkBlocks` (halved on a refused range, down to 100 blocks), at most `maxChunks` ranges: the
 * newest fills first, which are the ones a tick has just seen. `coveredFrom` is the lowest block read; above
 * `fromBlock` when the ranges ran out. Throws when even a minimal range is refused. The log client is pinned to
 * RH_RPC (chain.ts): a fallback that refuses archive ranges would read as "no fills".
 */
export async function readOrderFillLogs(
  client: Pick<import('viem').PublicClient, 'getLogs'>,
  input: { orderBook: Address; orderIds: readonly bigint[]; fromBlock: bigint; toBlock: bigint; chunkBlocks: number; maxChunks: number },
): Promise<{ logs: FillLog[]; coveredFrom: bigint }> {
  const logs: FillLog[] = [];
  let to = input.toBlock;
  let chunk = BigInt(input.chunkBlocks);
  let ranges = 0;
  let coveredFrom = input.toBlock + 1n;
  while (to >= input.fromBlock && ranges < input.maxChunks && input.orderIds.length > 0) {
    const from = to - chunk + 1n < input.fromBlock ? input.fromBlock : to - chunk + 1n;
    let page: Array<{ args?: Record<string, unknown>; blockNumber: bigint | null; logIndex: number | null }>;
    try {
      page = (await client.getLogs({ address: input.orderBook, event: ORDER_FILLED, args: { orderId: [...input.orderIds] }, fromBlock: from, toBlock: to } as never)) as unknown as typeof page;
    } catch (error) {
      if (chunk > MIN_LOG_CHUNK) {
        chunk = chunk / 2n < MIN_LOG_CHUNK ? MIN_LOG_CHUNK : chunk / 2n;
        continue;
      }
      throw error;
    }
    for (const l of page) {
      const a = l.args ?? {};
      if (typeof a.orderId !== 'bigint' || typeof a.units !== 'bigint' || typeof a.premium !== 'bigint' || typeof a.sellerFee !== 'bigint' || typeof a.maker !== 'string' || l.blockNumber === null || l.logIndex === null) continue;
      logs.push({ orderId: a.orderId, maker: a.maker, units: a.units, premium: a.premium, sellerFee: a.sellerFee, blockNumber: l.blockNumber, logIndex: l.logIndex });
    }
    coveredFrom = from;
    ranges += 1;
    to = from - 1n;
  }
  return { logs, coveredFrom };
}

/** OrderBook.getOrders in pages, one outcome per id (an unknown id is maker zero). */
export async function readOrders(client: Pick<import('viem').PublicClient, 'readContract'>, orderBook: Address, ids: readonly bigint[], blockNumber: bigint): Promise<ChainOrder[]> {
  const out: ChainOrder[] = [];
  for (let i = 0; i < ids.length; i += Number(PAGE)) {
    const page = ids.slice(i, i + Number(PAGE));
    const orders = (await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: 'getOrders', args: [page], blockNumber })) as ReadonlyArray<{
      maker: Address;
      longId: bigint;
      kind: number;
      price: bigint;
      units: bigint;
      filled: bigint;
      validUntil: number;
      cancelled: boolean;
    }>;
    orders.forEach((o, j) => {
      out.push({ id: page[j]!, maker: o.maker, longId: o.longId, kind: ORDER_KIND[o.kind] ?? 'Bid', price: BigInt(o.price), units: BigInt(o.units), filled: BigInt(o.filled), validUntil: Number(o.validUntil), cancelled: o.cancelled });
    });
  }
  return out;
}
