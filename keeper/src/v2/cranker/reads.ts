/**
 * The views the cranker plans from, read in pinned multicalls (chain.ts multicallMany: one block per
 * question, a reverted view is a failed outcome, not a thrown batch). Everything here reads; nothing
 * decides (planner.ts) or sends (steps.ts).
 */
import type { Abi, Address } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { priceSourceAbi } from '../abi/priceSource.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { multicallMany, type MulticallClient, type ReadOutcome } from '../chain.js';
import { shortIdOf } from '../seriesId.js';
import { ORDER_KIND, SETTLEMENT_STATUS, SETTLEMENT_WINDOW } from './constants.js';
import type { IndexedSeries } from './index-store.js';
import type { ExpiryKey, ExpiryView, HolderView, OrderView, SeriesView, SourceView } from './planner.js';

/** Any view call; heterogeneous batches give up result typing (each reader narrows its own). */
export interface AnyRead {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Heterogeneous calls through multicallMany, pinned to `blockNumber`. */
export async function readMany(client: MulticallClient, calls: readonly AnyRead[], blockNumber: bigint): Promise<ReadOutcome<unknown>[]> {
  return multicallMany(client, calls as never, { blockNumber }) as Promise<ReadOutcome<unknown>[]>;
}

const okOr = <T>(o: ReadOutcome<unknown> | undefined, fallback: T): T => (o !== undefined && o.ok ? (o.result as T) : fallback);

/** The result of a successful read, else undefined. */
export function okResult<T>(o: ReadOutcome<unknown> | undefined): T | undefined {
  return o !== undefined && o.ok ? (o.result as T) : undefined;
}

function must<T>(o: ReadOutcome<unknown> | undefined, what: string): T {
  if (o === undefined) throw new Error(`${what}: no result`);
  if (!o.ok) throw new Error(`${what}: ${o.error.message.split('\n')[0]}`);
  return o.result as T;
}

/*//////////////////////////////////////////////////////////////
                             SERIES
//////////////////////////////////////////////////////////////*/

export interface SeriesChain {
  longId: bigint;
  underlying: Address;
  isPut: boolean;
  strike: bigint;
  expiry: number;
  oracle: Address;
  settled: boolean;
  settlementPrice: bigint;
  longPayoutPerUnit: bigint;
  shortPayoutPerUnit: bigint;
  longSupply: bigint;
  shortSupply: bigint;
}

interface SeriesStruct {
  underlying: Address;
  isPut: boolean;
  expiry: number;
  strike: bigint;
  oracle: Address;
  settled: boolean;
  settlementPrice: bigint;
  longPayoutPerUnit: bigint;
  shortPayoutPerUnit: bigint;
}

export async function readSeries(client: MulticallClient, clearinghouse: Address, longIds: readonly bigint[], blockNumber: bigint): Promise<Map<string, SeriesChain>> {
  const calls: AnyRead[] = [];
  for (const id of longIds) {
    calls.push({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] });
    calls.push({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'totalSupply', args: [id] });
    calls.push({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'totalSupply', args: [shortIdOf(id)] });
  }
  const out = await readMany(client, calls, blockNumber);
  const map = new Map<string, SeriesChain>();
  longIds.forEach((id, i) => {
    const s = must<SeriesStruct>(out[i * 3], `series(${id})`);
    map.set(id.toString(), {
      longId: id,
      underlying: s.underlying,
      isPut: s.isPut,
      strike: s.strike,
      expiry: Number(s.expiry),
      oracle: s.oracle,
      settled: s.settled,
      settlementPrice: s.settlementPrice,
      longPayoutPerUnit: s.longPayoutPerUnit,
      shortPayoutPerUnit: s.shortPayoutPerUnit,
      longSupply: must<bigint>(out[i * 3 + 1], `totalSupply(${id})`),
      shortSupply: must<bigint>(out[i * 3 + 2], `totalSupply(short ${id})`),
    });
  });
  return map;
}

/*//////////////////////////////////////////////////////////////
                             ORDERS
//////////////////////////////////////////////////////////////*/

interface OrderStruct {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

const toOrderView = (id: bigint, o: OrderStruct): OrderView => ({
  id,
  maker: o.maker,
  kind: ORDER_KIND[o.kind] ?? 'AskWrite',
  units: BigInt(o.units),
  filled: BigInt(o.filled),
  validUntil: Number(o.validUntil),
  cancelled: o.cancelled,
});

/** Orders by id (getOrders in slices of 200 ids). */
export async function readOrders(client: MulticallClient, orderBook: Address, ids: readonly bigint[], blockNumber: bigint): Promise<OrderView[]> {
  const slices: bigint[][] = [];
  for (let i = 0; i < ids.length; i += 200) slices.push(ids.slice(i, i + 200));
  const out = await readMany(client, slices.map((slice) => ({ address: orderBook, abi: orderBookAbi, functionName: 'getOrders', args: [slice] })), blockNumber);
  const views: OrderView[] = [];
  slices.forEach((slice, i) => {
    const orders = must<OrderStruct[]>(out[i], 'getOrders');
    slice.forEach((id, j) => views.push(toOrderView(id, orders[j]!)));
  });
  return views;
}

/** Most order ids read per series per survey: 100 pages of 200. */
export const MAX_SERIES_ORDER_IDS = 20_000;

/**
 * The orders placed on each series (ordersOfSeries pages), then their state. A series with more than
 * MAX_SERIES_ORDER_IDS orders ever placed (heavy requoting, or spam) is read from its NEWEST MAX_SERIES_ORDER_IDS, where
 * the live escrow is, and listed in `truncated`: its orders are not all known, so its expiry must not be marked done.
 */
export async function readSeriesOrders(client: MulticallClient, orderBook: Address, longIds: readonly bigint[], blockNumber: bigint): Promise<{ orders: Map<string, OrderView[]>; truncated: Set<string> }> {
  const idsBySeries = new Map<string, bigint[]>(longIds.map((id) => [id.toString(), []]));
  const counts = await readMany(client, longIds.map((id) => ({ address: orderBook, abi: orderBookAbi, functionName: 'seriesOrderCount', args: [id] })), blockNumber);
  const truncated = new Set<string>();
  let pending = longIds.map((id, i) => {
    const count = must<bigint>(counts[i], `seriesOrderCount(${id})`);
    const max = BigInt(MAX_SERIES_ORDER_IDS);
    if (count > max) truncated.add(id.toString());
    return { id, cursor: count > max ? count - max : 0n };
  });
  for (let round = 0; pending.length > 0 && round < Math.ceil(MAX_SERIES_ORDER_IDS / 200); round += 1) {
    const out = await readMany(
      client,
      pending.map((p) => ({ address: orderBook, abi: orderBookAbi, functionName: 'ordersOfSeries', args: [p.id, p.cursor, 200n] })),
      blockNumber,
    );
    const next: typeof pending = [];
    pending.forEach((p, i) => {
      const [ids, nextCursor] = must<[readonly bigint[], bigint]>(out[i], `ordersOfSeries(${p.id})`);
      idsBySeries.get(p.id.toString())!.push(...ids);
      if (nextCursor !== 0n) next.push({ id: p.id, cursor: nextCursor });
    });
    pending = next;
  }
  const all = [...idsBySeries.values()].flat();
  const orders = all.length === 0 ? [] : await readOrders(client, orderBook, all, blockNumber);
  const byId = new Map(orders.map((o) => [o.id.toString(), o]));
  const result = new Map<string, OrderView[]>();
  for (const [longId, ids] of idsBySeries) result.set(longId, ids.map((id) => byId.get(id.toString())!).filter(Boolean));
  for (const p of pending) truncated.add(p.id.toString());
  return { orders: result, truncated };
}

/*//////////////////////////////////////////////////////////////
                             EXPIRIES
//////////////////////////////////////////////////////////////*/

export interface ExpirySurvey {
  key: ExpiryKey;
  view: ExpiryView;
  series: Map<string, SeriesChain>;
  /** Only read when asked (after expiry). */
  orders: Map<string, OrderView[]>;
}

/**
 * One view per (oracle, underlying, expiry): open interest, the oracle's settlement state, the
 * sources and whether each prices the window (after expiry), and every indexed series of it with
 * its supplies and (after expiry, when `withOrders`) its orders.
 *
 * WHICH SOURCES (INTERFACE_VERSION 6). The oracle settles an expiry on the configuration pinned when
 * its first series was created (SettlementOracle.settlementConfig(u, E)), and once captured on the
 * recorded list; SettlementOracle.setMarket reaches only unpinned expiries. So the source list the
 * finalize and snapshot-missed decisions read is the recorded one, else settlementConfig's. It is
 * never marketConfig(u): for a pinned expiry that list may be one the expiry will never settle on,
 * so an oracle that does not answer settlementConfig is cranked blind (sourcesKnown false) instead.
 * The sources' own windowPrice already reads their pinned feed or pool for the expiry.
 */
export async function surveyExpiries(
  client: MulticallClient,
  input: {
    clearinghouse: Address;
    orderBook: Address;
    keys: readonly ExpiryKey[];
    seriesOf: (key: ExpiryKey) => IndexedSeries[];
    snapshotDone: (key: ExpiryKey) => boolean;
    now: number;
    blockNumber: bigint;
    withOrders: boolean;
    prunable: (orders: readonly OrderView[], now: number) => OrderView[];
  },
): Promise<ExpirySurvey[]> {
  const { keys, blockNumber, now } = input;
  if (keys.length === 0) return [];

  const calls: AnyRead[] = [];
  for (const k of keys) {
    const oracle = k.oracle as Address;
    const u = k.underlying as Address;
    calls.push({ address: input.clearinghouse, abi: clearinghouseAbi, functionName: 'openInterest', args: [u, k.expiry] });
    // ISettlementOracle: settlementPrice and candidate. The concrete SettlementOracle's settlementInfo,
    // recordedSources and settlementConfig are read when present; an oracle without them is cranked blind.
    calls.push({ address: oracle, abi: settlementOracleAbi, functionName: 'settlementPrice', args: [u, k.expiry] });
    calls.push({ address: oracle, abi: settlementOracleAbi, functionName: 'candidate', args: [u, k.expiry] });
    calls.push({ address: oracle, abi: settlementOracleAbi, functionName: 'settlementInfo', args: [u, k.expiry] });
    calls.push({ address: oracle, abi: settlementOracleAbi, functionName: 'recordedSources', args: [u, k.expiry] });
    calls.push({ address: oracle, abi: settlementOracleAbi, functionName: 'settlementConfig', args: [u, k.expiry] });
  }
  const base = await readMany(client, calls, blockNumber);

  const perKey = keys.map((k, i) => {
    const o = i * 6;
    const price = must<readonly [number, bigint]>(base[o + 1], `settlementPrice(${k.underlying}, ${k.expiry})`);
    const cand = okOr<readonly [bigint, number, boolean, number]>(base[o + 2], [0n, 0, false, 0]);
    const info = okResult<readonly [number, bigint, number, boolean, boolean, boolean]>(base[o + 3]);
    const recorded = okResult<readonly [readonly Address[], readonly boolean[], readonly bigint[], number]>(base[o + 4]);
    const settlementConfig = okResult<readonly [boolean, readonly Address[], number, number, number]>(base[o + 5]);
    const status = SETTLEMENT_STATUS[Number(price[0])] ?? 'None';
    const captured = info !== undefined ? info[5] : status !== 'None' || Number(cand[3]) !== 0;
    const sources = captured ? recorded?.[0] : settlementConfig?.[1];
    return {
      key: k,
      openInterest: must<bigint>(base[o], `openInterest(${k.underlying}, ${k.expiry})`),
      status,
      captured,
      candidate: Number(cand[3]) === 0 ? null : { price: cand[0], sourceIndex: Number(cand[1]), disagreed: cand[2], finalizableAt: Number(cand[3]) },
      sourcesKnown: sources !== undefined,
      sourceAddresses: [...(sources ?? [])],
      recordedOk: captured && recorded !== undefined ? [...recorded[1]] : null,
      pinned: settlementConfig === undefined ? null : settlementConfig[0],
    };
  });

  // Window prices, only once the window has closed (before expiry nothing can be ok).
  const windowCalls: AnyRead[] = [];
  const windowIndex: Array<{ key: number; source: number }> = [];
  perKey.forEach((p, i) => {
    if (now < p.key.expiry || p.key.expiry < SETTLEMENT_WINDOW) return;
    p.sourceAddresses.forEach((source, j) => {
      windowCalls.push({ address: source, abi: priceSourceAbi, functionName: 'windowPrice', args: [p.key.underlying, p.key.expiry - SETTLEMENT_WINDOW, p.key.expiry] });
      windowIndex.push({ key: i, source: j });
    });
  });
  const windows = windowCalls.length === 0 ? [] : await readMany(client, windowCalls, blockNumber);
  const windowOk = new Map<string, boolean>();
  windowIndex.forEach((w, n) => {
    const r = windows[n];
    const ok = r !== undefined && r.ok && (() => {
      const [answered, price] = r.result as readonly [boolean, bigint];
      return answered && price > 0n && price <= (1n << 128n) - 1n;
    })();
    windowOk.set(`${w.key}:${w.source}`, ok);
  });

  // Series and orders.
  const seriesByKey = keys.map((k) => input.seriesOf(k));
  const allIds = seriesByKey.flat().map((s) => s.longId);
  const seriesChain = allIds.length === 0 ? new Map<string, SeriesChain>() : await readSeries(client, input.clearinghouse, allIds, blockNumber);
  const expiredIds = seriesByKey.flatMap((list, i) => (input.withOrders && now >= keys[i]!.expiry ? list.map((s) => s.longId) : []));
  const read = expiredIds.length === 0 ? { orders: new Map<string, OrderView[]>(), truncated: new Set<string>() } : await readSeriesOrders(client, input.orderBook, expiredIds, blockNumber);
  const orders = read.orders;

  return perKey.map((p, i) => {
    const sources: SourceView[] = p.sourceAddresses.map((address, j) => ({
      address,
      windowOk: windowOk.get(`${i}:${j}`) ?? false,
      recordedOk: p.recordedOk === null ? null : (p.recordedOk[j] ?? false),
    }));
    const series = new Map<string, SeriesChain>();
    const seriesViews: SeriesView[] = seriesByKey[i]!.map((s) => {
      const chain = seriesChain.get(s.longId.toString())!;
      series.set(s.longId.toString(), chain);
      const list = orders.get(s.longId.toString()) ?? [];
      // A partial order read counts one more prunable order: the expiry stays open rather than done on what was not read.
      const unread = read.truncated.has(s.longId.toString()) ? 1 : 0;
      return { longId: s.longId, settled: chain.settled, longSupply: chain.longSupply, shortSupply: chain.shortSupply, prunableOrders: input.prunable(list, now).length + unread };
    });
    const seriesOrders = new Map<string, OrderView[]>();
    for (const s of seriesByKey[i]!) seriesOrders.set(s.longId.toString(), orders.get(s.longId.toString()) ?? []);
    const view: ExpiryView = {
      underlying: p.key.underlying,
      expiry: p.key.expiry,
      now,
      openInterest: p.openInterest,
      status: p.status,
      captured: p.captured,
      candidate: p.candidate,
      sourcesKnown: p.sourcesKnown,
      sources,
      pinned: p.pinned,
      series: seriesViews,
      snapshotDone: input.snapshotDone(p.key),
    };
    return { key: p.key, view, series, orders: seriesOrders };
  });
}

/*//////////////////////////////////////////////////////////////
                             HOLDERS
//////////////////////////////////////////////////////////////*/

/** Balance, third-party permission and in-kind preference of each candidate for `tokenId`. */
export async function readHolders(client: MulticallClient, clearinghouse: Address, tokenId: bigint, holders: readonly Address[], blockNumber: bigint): Promise<HolderView[]> {
  const calls: AnyRead[] = [];
  for (const h of holders) {
    calls.push({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'balanceOf', args: [h, tokenId] });
    calls.push({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'thirdPartyRedeemAllowed', args: [h] });
    calls.push({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'payoutPrefs', args: [h] });
  }
  const out = await readMany(client, calls, blockNumber);
  return holders.map((holder, i) => ({
    holder,
    balance: must<bigint>(out[i * 3], `balanceOf(${holder}, ${tokenId})`),
    thirdPartyAllowed: must<boolean>(out[i * 3 + 1], `thirdPartyRedeemAllowed(${holder})`),
    inKind: must<readonly [boolean, boolean]>(out[i * 3 + 2], `payoutPrefs(${holder})`)[0],
  }));
}
