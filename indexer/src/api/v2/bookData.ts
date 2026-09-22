import { db } from "ponder:api";
import schema from "ponder:schema";
import { and, asc, desc, eq, exists, gt, inArray } from "ponder";
import { getAddress, type Address } from "viem";

import registry from "../../../lib/v2/cardRegistry.generated.json";
import { USDG } from "../../../lib/env";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { aggregateBook, makerKey, quoteFromBook, type AggregatedBook, type BookOrder, type BookSeries } from "../../../lib/v2/book";
import { buildCardMath, pickHero, type CardFees, type CardMath, type Ladder } from "../../../lib/v2/cards";
import { effectiveFees, feeStateFromRow, type OrderBookFees } from "../../../lib/v2/fees";
import { fetchFairResult } from "../../../lib/v2/pricing";
import { money, seriesWire } from "./shared";
import { usdg } from "../serialize";
import { compute15s } from "../cache";
import type { IndexedHead } from "./machine";
import { readIndexedSnapshot } from "./snapshot";
import { readSpots } from "./chain";

type SeriesRow = typeof schema.v2Series.$inferSelect;
type MarketRow = typeof schema.v2Market.$inferSelect;
type OrderRow = typeof schema.v2Order.$inferSelect;
type BookStateRow = typeof schema.v2OrderBookState.$inferSelect;

const defaults = registry.v2.defaults.ladder;
/** Bound both the database read and the public book payload, including a single crowded price level. */
export const BOOK_ORDERS_PER_SIDE = 200;
const fallbackFees: OrderBookFees = {
  premiumFeeBps: V2_REGISTRY.fees.premiumFeeBps,
  resaleFeeBps: V2_REGISTRY.fees.resaleFeeBps,
  takerFeeFlat: BigInt(V2_REGISTRY.fees.takerFeeFlat),
  takerFeeCapBps: V2_REGISTRY.fees.takerFeeCapBps,
  makerRebateBps: V2_REGISTRY.fees.makerRebateBps,
};

function seriesBook(series: SeriesRow): BookSeries {
  return {
    longId: series.longId,
    isPut: series.isPut,
    strike: series.strike,
    mintCutoff: series.mintCutoff,
    mintFeePpm: series.mintFeePpm,
    expiry: series.expiry,
    status: series.status,
  };
}

function orderBook(order: OrderRow): BookOrder {
  return {
    orderId: order.orderId,
    maker: order.maker,
    longId: order.longId,
    kind: order.kind,
    price: order.price,
    units: order.units,
    filled: order.filled,
    validUntil: order.validUntil,
    status: order.status,
    placedAt: order.placedAt,
    placedBlock: order.placedBlock,
  };
}

function collateralAsset(series: SeriesRow): Address {
  return (series.isPut ? USDG : series.underlying).toLowerCase() as Address;
}

function freeBalances(series: SeriesRow, rows: readonly (typeof schema.v2Ledger.$inferSelect)[]): Map<string, bigint> {
  const asset = collateralAsset(series);
  const out = new Map<string, bigint>();
  for (const row of rows) if (row.asset.toLowerCase() === asset) out.set(makerKey(row.account), row.free);
  return out;
}

function feesFrom(state: BookStateRow | null, series: SeriesRow, at: bigint): CardFees {
  const fees = effectiveFees(feeStateFromRow(state, fallbackFees), at);
  return {
    takerFeeFlat: fees.takerFeeFlat,
    takerFeeCapBps: fees.takerFeeCapBps,
    exerciseFeeBps: series.exerciseFeeBps,
  };
}

function ladderFor(ticker: string, tenor: string): Ladder {
  const market = registry.markets.find((item) => item.ticker === ticker);
  const overrides = market?.v2?.overrides as { ladder?: { weekly?: Partial<Ladder>; daily?: Partial<Ladder> } } | undefined;
  const kind = tenor === "daily" ? "daily" : "weekly";
  return { ...defaults[kind], ...overrides?.ladder?.[kind] };
}

export const seriesRef = seriesWire;

export function bookWire(book: AggregatedBook) {
  const levelWire = (level: AggregatedBook["asks"][number]) => ({
    price: usdg(level.price),
    units: level.units.toString(),
    orders: level.orders.map((order) => ({
      orderId: order.orderId.toString(),
      maker: getAddress(order.maker),
      units: order.units.toString(),
      onChainRemainingUnits: (order.onChainRemainingUnits ?? order.units).toString(),
      makerFreeUnits: order.makerFreeUnits?.toString() ?? null,
      makerFreeCollateral: order.makerFreeCollateral == null ? null : money(order.makerFreeCollateral, order.collateralDecimals ?? 18),
      kind: order.kind,
      validUntil: Number(order.validUntil),
    })),
  });
  return { bids: book.bids.map(levelWire), asks: book.asks.map(levelWire), updatedBlock: book.updatedBlock.toString(), snapshotTimestamp: Number(book.snapshotTimestamp) };
}

/** A route can use this one object for /series/:id/book, /series/:id and ticket preflight. */
export type LoadedBook = {
  series: SeriesRow;
  market: MarketRow;
  book: AggregatedBook;
  freeByMaker: Map<string, bigint>;
  fees: CardFees;
};

export async function loadBook(longId: bigint, now: bigint, depth?: number): Promise<LoadedBook | null> {
  return readIndexedSnapshot((head) => loadBookAt(longId, now, depth, head));
}

async function loadBookAt(longId: bigint, now: bigint, depth: number | undefined, head: IndexedHead | null): Promise<LoadedBook | null> {
  const [series] = await db.select().from(schema.v2Series).where(eq(schema.v2Series.longId, longId)).limit(1);
  if (series === undefined) return null;
  const [market] = await db.select().from(schema.v2Market).where(eq(schema.v2Market.underlying, series.underlying)).limit(1);
  if (market === undefined) return null;
  const orderScope = and(eq(schema.v2Order.longId, longId),
    eq(schema.v2Order.status, "open"), gt(schema.v2Order.validUntil, now));
  const [bids, asks, stateRows] = await Promise.all([
    db.select().from(schema.v2Order).where(and(orderScope, eq(schema.v2Order.kind, "Bid")))
      .orderBy(desc(schema.v2Order.price), asc(schema.v2Order.placedBlock),
        asc(schema.v2Order.placedAt), asc(schema.v2Order.orderId)).limit(BOOK_ORDERS_PER_SIDE),
    db.select().from(schema.v2Order).where(and(orderScope, inArray(schema.v2Order.kind, ["AskResale", "AskWrite"])))
      .orderBy(asc(schema.v2Order.price), asc(schema.v2Order.placedBlock),
        asc(schema.v2Order.placedAt), asc(schema.v2Order.orderId)).limit(BOOK_ORDERS_PER_SIDE),
    db.select().from(schema.v2OrderBookState).limit(1),
  ]);
  const orders = [...bids, ...asks];
  const makers = [...new Set(orders.filter((order) => order.kind === "AskWrite").map((order) => order.maker))];
  const ledgers = makers.length === 0 ? [] : await db.select().from(schema.v2Ledger)
    .where(and(inArray(schema.v2Ledger.account, makers), eq(schema.v2Ledger.asset, series.isPut ? USDG : series.underlying)));
  const state = stateRows[0] ?? null;
  const freeByMaker = freeBalances(series, ledgers);
  return {
    series,
    market,
    freeByMaker,
    fees: feesFrom(state, series, head?.ts ?? 0n),
    book: (() => {
      const book = aggregateBook({ series: seriesBook(series), orders: orders.map(orderBook), freeByMaker, now, snapshotTimestamp: head?.ts ?? 0n,
        marketEnabled: market.enabled, mintPaused: market.mintPaused, tradingPaused: state?.tradingPaused, depth });
      book.updatedBlock = head?.block ?? [book.updatedBlock, series.createdBlock, market.lastBlock].reduce((max, value) => value > max ? value : max);
      return book;
    })(),
  };
}

export async function loadQuote(loaded: LoadedBook) {
  const series = loaded.series;
  const fair = await fetchFairResult({ ticker: series.ticker, underlying: series.underlying,
    strike: series.strike, expiry: Number(series.expiry), isPut: series.isPut });
  const quote = quoteFromBook(loaded.book, series.lastPrice, fair.quote);
  return {
    bestBid: quote.bestBid === null ? null : usdg(quote.bestBid),
    bestAsk: quote.bestAsk === null ? null : usdg(quote.bestAsk),
    bidUnits: quote.bidUnits.toString(),
    askUnits: quote.askUnits.toString(),
    fair: quote.fair === null ? null : usdg(quote.fair),
    iv: quote.iv,
    delta: quote.delta,
    last: quote.last === null ? null : usdg(quote.last),
    fairProvenance: fair.provenance,
  };
}

export type CardWire = ReturnType<typeof cardWire>;

/** The public Card schema publishes both a one-unit and a full-share ticket. */
export function cardWire(series: SeriesRow, spot: bigint | null, math: CardMath) {
  return {
    series: seriesRef(series),
    spot: spot === null ? null : usdg(spot),
    ask: usdg(math.ask),
    target: usdg(math.target),
    perUnit: {
      cost: usdg(math.perUnit.cost),
      payoutAtTarget: usdg(math.perUnit.payoutAtTarget),
      multiple: math.perUnit.multiple,
    },
    perShare: math.perShare === null ? null : {
      cost: usdg(math.perShare.cost),
      payoutAtTarget: usdg(math.perShare.payoutAtTarget),
      multiple: math.perShare.multiple,
    },
    maxLoss: "cost" as const,
    unitsAvailable: math.unitsAvailable.toString(),
    orderIds: math.orderIds.map(String),
  };
}

export type BuiltCard = {
  card: CardWire;
  math: CardMath;
  expiry: bigint;
  strike: bigint;
  spot: bigint | null;
  isPut: boolean;
  tick: bigint;
  ladder: Ladder;
  volumeUnits: bigint;
};

/** One exact snapshot serves every card filter and the hero for 15 seconds per process. */
export async function loadCards(now: bigint, filters: { ticker?: string; tenor?: string; type?: "call" | "put" } = {}):
  Promise<{ cards: BuiltCard[]; generatedAt: number; expiresAt: number }> {
  const snapshot = await compute15s("v2.cards", async () => ({ cards: await loadAllCards(now), generatedAt: Number(now) }));
  return { cards: snapshot.value.cards.filter(({ card }) => (filters.ticker === undefined || card.series.ticker === filters.ticker)
    && (filters.tenor === undefined || card.series.tenor === filters.tenor)
    && (filters.type === undefined || card.series.isPut === (filters.type === "put"))),
    generatedAt: snapshot.value.generatedAt, expiresAt: snapshot.expiresAt };
}

/** Keep global ranking exact; prune only series that could never form a card. */
async function loadAllCards(now: bigint): Promise<BuiltCard[]> {
  const { seriesRows, stateRows, head, marketRows, orderRows, ledgerRows } = await readIndexedSnapshot(async (head) => {
    const [seriesRows, stateRows] = await Promise.all([
      db.select().from(schema.v2Series).where(and(
        inArray(schema.v2Series.status, ["open", "cutoff"]),
        gt(schema.v2Series.expiry, now),
        exists(db.select({ orderId: schema.v2Order.orderId }).from(schema.v2Order).where(and(
          eq(schema.v2Order.longId, schema.v2Series.longId),
          eq(schema.v2Order.status, "open"),
          inArray(schema.v2Order.kind, ["AskResale", "AskWrite"]),
          gt(schema.v2Order.validUntil, now),
          gt(schema.v2Order.price, 0n),
          gt(schema.v2Order.units, schema.v2Order.filled),
        ))),
      )),
      db.select().from(schema.v2OrderBookState).limit(1),
    ]);
    if (seriesRows.length === 0) return { seriesRows, stateRows, head, marketRows: [], orderRows: [], ledgerRows: [] };
    const longIds = seriesRows.map((series) => series.longId);
    // Open orders can remain stored after their deadline. The card builder ignores
    // them, so avoid loading them or orders for unrelated/historical series.
    const [marketRows, orderRows] = await Promise.all([
      db.select().from(schema.v2Market),
      db.select().from(schema.v2Order).where(and(inArray(schema.v2Order.longId, longIds),
        eq(schema.v2Order.status, "open"), inArray(schema.v2Order.kind, ["AskResale", "AskWrite"]),
        gt(schema.v2Order.validUntil, now), gt(schema.v2Order.price, 0n),
        gt(schema.v2Order.units, schema.v2Order.filled))),
    ]);
    const makers = [...new Set(orderRows.filter((order) => order.kind === "AskWrite").map((order) => order.maker))];
    const assets = [...new Set(seriesRows.map((series) => collateralAsset(series)))];
    const ledgerRows = makers.length === 0 ? [] : await db.select().from(schema.v2Ledger)
      .where(and(inArray(schema.v2Ledger.account, makers), inArray(schema.v2Ledger.asset, assets)));
    return { seriesRows, stateRows, head, marketRows, orderRows, ledgerRows };
  });
  if (seriesRows.length === 0) return [];
  const markets = new Map(marketRows.map((market) => [market.underlying.toLowerCase(), market]));
  const bySeries = new Map<bigint, BookOrder[]>();
  for (const row of orderRows) {
    const list = bySeries.get(row.longId) ?? [];
    list.push(orderBook(row));
    bySeries.set(row.longId, list);
  }
  // Card spot is the live settlement oracle price used by /markets, not the
  // pricing service's Cboe share spot. A failed display read must not erase
  // otherwise fillable asks from the catalogue.
  const spots = await readSpots([...new Set(seriesRows.map((series) => series.underlying))]);
  const state = stateRows[0] ?? null;
  const cards: BuiltCard[] = [];
  for (const series of seriesRows) {
    const market = markets.get(series.underlying.toLowerCase());
    if (market === undefined) continue;
    const spot = spots.get(series.underlying.toLowerCase())?.price ?? null;
    const freeByMaker = freeBalances(series, ledgerRows);
    const book = aggregateBook({ series: seriesBook(series), orders: bySeries.get(series.longId) ?? [], freeByMaker,
      now, snapshotTimestamp: head?.ts ?? 0n, marketEnabled: market.enabled, mintPaused: market.mintPaused, tradingPaused: state?.tradingPaused });
    const ladder = ladderFor(series.ticker, series.tenor);
    const math = buildCardMath({ book, series: seriesBook(series), freeByMaker, fees: feesFrom(state, series, head?.ts ?? 0n),
      targetBps: ladder.cardTargetBps, strikeTick: market.strikeTick });
    if (math === null) continue;
    cards.push({ card: cardWire(series, spot, math), math, expiry: series.expiry, strike: series.strike,
      spot, isPut: series.isPut, tick: market.strikeTick, ladder, volumeUnits: series.volumeUnits });
  }
  return cards;
}

export function heroFromCards(cards: readonly BuiltCard[], now: bigint): { card: CardWire | null; maxMultiple: number | null } {
  const hero = pickHero(cards.filter((card): card is BuiltCard & { spot: bigint } => card.spot !== null), now);
  return { card: hero?.card ?? null, maxMultiple: hero?.math.perUnit.multiple ?? null };
}
