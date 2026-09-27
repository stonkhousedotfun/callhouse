import { formatUnits } from "viem";
import { writerCapacity, type RentTerms } from "./rent";
import type { Address, PublicClient } from "viem";

import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { orderBookAbi } from "../abi/v2/orderBook";
import { USDG } from "../contracts";
import { publicClient } from "../chain";
import type { BookResponse, Level } from "./api-types";
import { requireV2Address } from "./config";
import { formatUsdg } from "./payoffCard";

export type RawBookOrder = {
  orderId: bigint;
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
};

/**
 * The take-time conditions the contract applies that an order's own fields do not show. Read at the same
 * pinned block as the orders. Without them the fallback listed asks the book will not fill, so the page showed a best
 * ask that the on-chain quote then refused. Contract citations name the function in OrderBook.sol.
 */
export type ChainBookGates = {
  /** `OrderBook.tradingPaused()`: every take reverts `TradingPaused` (OrderBook.sol, via `_whenTrading`). */
  tradingPaused: boolean;
  /**
   * Write-on-fill asks can mint: the market is enabled, minting is not paused and the book is on the Clearinghouse
   * minter allow-list (OrderBook.sol `plan.mintOpen`). The mint cutoff is applied separately.
   */
  mintOpen: boolean;
  /** Lowercased writers that made the book their Clearinghouse operator (OrderBook.sol `isOperator`). */
  operators: ReadonlySet<string>;
  // NO resale-seller gate. A resale ask's longs are escrowed in
  // the book when it is placed (`_place` :768-769, `_escrowLongs` :799-802), and a buy delivers them from the book
  // (`_deliver` :1155-1158). `_reserveInventory` (:1125-1135) is the TAKER's inventory when selling into a bid, called
  // only at :970. This file caps each resale ask at the seller's `balanceOf`, which excludes the escrowed units, so the
  // fallback hid valid resale asks.
};

/** Keep the fallback's returned order count aligned with the indexer book endpoint. */
export const BOOK_ORDERS_PER_SIDE = 200;

/** A failed refetch may leave React Query's last API book in `data`; do not let it mask a fresh chain fallback. */
export function selectBookSnapshot(indexed: BookResponse | undefined, fallback: BookResponse | undefined,
  indexerFailed: boolean): { book: BookResponse | null; degraded: boolean } {
  if (indexerFailed) return { book: fallback ?? null, degraded: fallback !== undefined };
  return { book: indexed ?? fallback ?? null, degraded: indexed === undefined && fallback !== undefined };
}

/** Turn pinned chain reads into the same sorted levels as /v2/series/:id/book. */
export function levelsFromChainOrders(
  orders: readonly RawBookOrder[], freeByMaker: ReadonlyMap<string, bigint>, collateralPerUnit: bigint,
  longId: bigint, now: number, updatedBlock: bigint, mintCutoff = Number.POSITIVE_INFINITY, mintFeePpm = 0, expiry = mintCutoff, collateralDecimals = 18,
  gates?: ChainBookGates,
): BookResponse {
  if (collateralPerUnit <= 0n) throw new RangeError("Invalid series collateral");
  // Nothing on a paused book is executable, bids included (selling into a bid is a take too).
  if (gates?.tradingPaused) return { bids: [], asks: [], updatedBlock: updatedBlock.toString(), snapshotTimestamp: now };
  const rent: RentTerms = { collateralPerUnit, mintFeePpm, expiry: Number.isFinite(expiry) ? expiry : now + 604800, snapshotTimestamp: now, mintCutoff };
  const live = orders.filter((order) => !order.cancelled && order.longId === longId && order.validUntil > now &&
    (order.kind !== 2 || now < mintCutoff) &&
    (order.kind !== 2 || gates === undefined || (gates.mintOpen && gates.operators.has(order.maker.toLowerCase()))) &&
    order.units > order.filled && order.price > 0n && [0, 1, 2].includes(order.kind));
  const priority = (a: RawBookOrder, b: RawBookOrder, descending: boolean) =>
    a.price < b.price ? (descending ? 1 : -1) : a.price > b.price ? (descending ? -1 : 1)
      : a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
  const bids = live.filter((order) => order.kind === 0)
    .sort((a, b) => priority(a, b, true)).slice(0, BOOK_ORDERS_PER_SIDE);
  // Show each order's individually executable capacity, matching the API.
  // The ticket reserves shared writer collateral in actual planned fill order.
  const asks = live.filter((order) => order.kind !== 0)
    .sort((a, b) => priority(a, b, false)).slice(0, BOOK_ORDERS_PER_SIDE);
  const bid = new Map<string, Level>();
  const ask = new Map<string, Level>();
  for (const order of [...bids, ...asks]) {
    let units = order.units - order.filled;
    const onChainRemainingUnits = units;
    const makerFreeUnits = order.kind === 2
      ? writerCapacity(freeByMaker.get(order.maker.toLowerCase()) ?? 0n, rent) : null;
    if (order.kind === 2) {
      const key = order.maker.toLowerCase();
      const free = freeByMaker.get(key) ?? 0n;
      units = writerCapacity(free, rent, units);
    }
    if (units === 0n) continue;
    const side = order.kind === 0 ? bid : ask;
    const key = order.price.toString();
    let level = side.get(key);
    if (!level) {
      level = { price: { raw: key, decimals: 6, formatted: formatUsdg(order.price) }, units: "0", orders: [] };
      side.set(key, level);
    }
    level.units = (BigInt(level.units) + units).toString();
    level.orders.push({ orderId: order.orderId.toString(), maker: order.maker, units: units.toString(),
      onChainRemainingUnits: onChainRemainingUnits.toString(), makerFreeUnits: makerFreeUnits?.toString() ?? null,
      makerFreeCollateral: order.kind === 2 ? { raw: (freeByMaker.get(order.maker.toLowerCase()) ?? 0n).toString(),
        decimals: collateralDecimals, formatted: formatUnits(freeByMaker.get(order.maker.toLowerCase()) ?? 0n, collateralDecimals) } : null,
      kind: order.kind === 0 ? "Bid" : order.kind === 1 ? "AskResale" : "AskWrite", validUntil: order.validUntil });
  }
  return {
    bids: [...bid.values()].sort((a, b) => BigInt(a.price.raw) > BigInt(b.price.raw) ? -1 : 1),
    asks: [...ask.values()].sort((a, b) => BigInt(a.price.raw) < BigInt(b.price.raw) ? -1 : 1),
    updatedBlock: updatedBlock.toString(), snapshotTimestamp: now,
  };
}

export async function bookFromChain(longId: bigint, collateralAsset: Address, collateralPerUnit: bigint, mintCutoff: number,
  client: PublicClient = publicClient): Promise<BookResponse> {
  const orderBook = requireV2Address("orderBook");
  const clearinghouse = requireV2Address("clearinghouse");
  // cacheTime 0. viem caches the head for 4 s, so a book rebuilt right after a replace showed the old block.
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [block, series, pinnedCollateral, pinnedCutoff] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "series", args: [longId], blockNumber }),
    client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "collateralPerUnit", args: [longId], blockNumber }),
    client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "mintCutoff", args: [longId], blockNumber }),
  ]);
  if (collateralAsset.toLowerCase() !== (series.isPut ? USDG : series.underlying).toLowerCase()) throw new Error("Series collateral asset differs from the chain.");
  if (pinnedCollateral !== collateralPerUnit || Number(pinnedCutoff) !== mintCutoff) throw new Error("Series collateral terms changed. Refresh the series.");
  const ids: bigint[] = [];
  let cursor = 0n;
  for (let page = 0; page < 50; page++) {
    const [batch, nextCursor] = await client.readContract({ address: orderBook, abi: orderBookAbi,
      functionName: "ordersOfSeries", args: [longId, cursor, 200n], blockNumber });
    ids.push(...batch);
    if (batch.length === 0 || nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  const raw: RawBookOrder[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const orders = await client.readContract({ address: orderBook, abi: orderBookAbi,
      functionName: "getOrders", args: [ids.slice(i, i + 200)], blockNumber });
    orders.forEach((order, index) => raw.push({ orderId: ids[i + index]!, maker: order.maker,
      longId: order.longId, kind: order.kind, price: order.price, units: order.units, filled: order.filled,
      validUntil: order.validUntil, cancelled: order.cancelled }));
  }
  const makers = [...new Set(raw.filter((order) => order.kind === 2).map((order) => order.maker.toLowerCase()))] as Address[];
  const [free, operator, tradingPaused, market, bookIsMinter] = await Promise.all([
    makers.length ? client.multicall({ allowFailure: false, blockNumber,
      contracts: makers.map((maker) => ({ address: clearinghouse, abi: clearinghouseAbi,
        functionName: "free" as const, args: [maker, collateralAsset] as const })) }) : [],
    makers.length ? client.multicall({ allowFailure: false, blockNumber,
      contracts: makers.map((maker) => ({ address: clearinghouse, abi: clearinghouseAbi,
        functionName: "isOperator" as const, args: [maker, orderBook] as const })) }) : [],
    client.readContract({ address: orderBook, abi: orderBookAbi, functionName: "tradingPaused", blockNumber }),
    client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [series.underlying], blockNumber }),
    client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "isMinter", args: [orderBook], blockNumber }),
  ]);
  const freeByMaker = new Map(makers.map((maker, index) => [maker, free[index]!]));
  const gates: ChainBookGates = {
    tradingPaused,
    mintOpen: market.enabled && !market.mintPaused && bookIsMinter,
    operators: new Set(makers.filter((_, index) => operator[index] === true)),
  };
  return levelsFromChainOrders(raw, freeByMaker, collateralPerUnit, longId, Number(block.timestamp), blockNumber, mintCutoff,
    series.mintFeePpm, Number(series.expiry), series.isPut ? 6 : 18, gates);
}
