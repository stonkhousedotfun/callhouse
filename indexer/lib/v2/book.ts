import { rentCapacity } from "./rent";

/** Deterministic, event-backed view of the v2 on-chain order book. */

export type BookOrder = {
  orderId: bigint;
  maker: `0x${string}`;
  longId: bigint;
  kind: "Bid" | "AskResale" | "AskWrite";
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: bigint;
  status: "open" | "filled" | "cancelled" | "pruned" | "expired";
  placedAt: bigint;
  placedBlock: bigint;
};

export type BookSeries = {
  longId: bigint;
  isPut: boolean;
  strike: bigint;
  mintCutoff: bigint;
  mintFeePpm: number;
  expiry: bigint;
  status: "open" | "cutoff" | "expired" | "settling" | "held" | "settled";
};

export type FillableOrder = {
  orderId: bigint;
  maker: `0x${string}`;
  kind: BookOrder["kind"];
  price: bigint;
  units: bigint;
  /** Remaining units in the stored order before its individual collateral cap. */
  onChainRemainingUnits?: bigint;
  /** Max units funded including rent for one fill, before this ticket reserves anything. */
  makerFreeUnits?: bigint | null;
  makerFreeCollateral?: bigint | null;
  collateralDecimals?: number;
  validUntil: bigint;
  placedAt: bigint;
  placedBlock: bigint;
};

export type BookLevel = { price: bigint; units: bigint; orders: FillableOrder[] };
export type AggregatedBook = { bids: BookLevel[]; asks: BookLevel[]; updatedBlock: bigint; snapshotTimestamp: bigint };

const UNIT = 10n ** 16n;
const UNITS_PER_SHARE = 100n;

export function collateralPerUnit(isPut: boolean, strike: bigint): bigint {
  if (strike <= 0n) throw new RangeError("strike must be positive");
  return isPut ? strike / UNITS_PER_SHARE : UNIT;
}

export function makerKey(maker: string): string {
  return maker.toLowerCase();
}

function compare(a: FillableOrder, b: FillableOrder, descending: boolean): number {
  if (a.price !== b.price) return a.price < b.price ? (descending ? 1 : -1) : (descending ? -1 : 1);
  if (a.placedBlock !== b.placedBlock) return a.placedBlock < b.placedBlock ? -1 : 1;
  if (a.placedAt !== b.placedAt) return a.placedAt < b.placedAt ? -1 : 1;
  return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
}

function levels(orders: FillableOrder[], descending: boolean): BookLevel[] {
  const sorted = orders.sort((a, b) => compare(a, b, descending));
  const out: BookLevel[] = [];
  for (const order of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.price === order.price) {
      last.orders.push(order);
      last.units += order.units;
    } else {
      out.push({ price: order.price, units: order.units, orders: [order] });
    }
  }
  return out;
}

/**
 * `freeByMaker` contains the maker's free balance of this series' collateral asset.
 * An AskWrite has no escrow; each order can only promise what is free *now*. A multi-order
 * ticket must reserve that collateral as it walks the returned asks (see `walkAsks`).
 */
export function aggregateBook(input: {
  series: BookSeries;
  orders: readonly BookOrder[];
  freeByMaker: ReadonlyMap<string, bigint>;
  now: bigint;
  /** Balance checkpoint time; use this earlier time for rent even if display time advances. */
  snapshotTimestamp?: bigint;
  marketEnabled?: boolean;
  mintPaused?: boolean;
  tradingPaused?: boolean;
  depth?: number;
}): AggregatedBook {
  const { series, orders, freeByMaker, now } = input;
  const empty: AggregatedBook = { bids: [], asks: [], updatedBlock: 0n, snapshotTimestamp: input.snapshotTimestamp ?? now };
  const liveAt = now > empty.snapshotTimestamp ? now : empty.snapshotTimestamp;
  if ((series.status !== "open" && series.status !== "cutoff") || liveAt >= series.expiry
      || input.marketEnabled === false || input.tradingPaused === true) return empty;
  const cpu = collateralPerUnit(series.isPut, series.strike);
  const bids: FillableOrder[] = [];
  const asks: FillableOrder[] = [];
  let updatedBlock = 0n;

  for (const order of orders) {
    if (order.longId !== series.longId || order.status !== "open" || order.price <= 0n) continue;
    const seriesDeadline = order.kind === "AskWrite" ? series.mintCutoff : series.expiry;
    const validUntil = order.validUntil === 0n || order.validUntil > seriesDeadline
      ? seriesDeadline : order.validUntil;
    if (validUntil <= liveAt) continue;
    let units = order.units - order.filled;
    const onChainRemainingUnits = units;
    let makerFreeUnits: bigint | null = null;
    let makerFreeCollateral: bigint | null = null;
    if (units <= 0n) continue;
    if (order.kind === "AskWrite") {
      if (liveAt >= series.mintCutoff || input.mintPaused === true) continue;
      const free = freeByMaker.get(makerKey(order.maker)) ?? 0n;
      const covered = rentCapacity(free, cpu, series.mintFeePpm, series.expiry - empty.snapshotTimestamp);
      makerFreeCollateral = free;
      makerFreeUnits = covered;
      if (covered < units) units = covered;
      if (units <= 0n) continue;
    }
    const fillable: FillableOrder = {
      orderId: order.orderId,
      maker: order.maker,
      kind: order.kind,
      price: order.price,
      units,
      onChainRemainingUnits,
      makerFreeUnits,
      makerFreeCollateral,
      collateralDecimals: series.isPut ? 6 : 18,
      validUntil,
      placedAt: order.placedAt,
      placedBlock: order.placedBlock,
    };
    (order.kind === "Bid" ? bids : asks).push(fillable);
    if (order.placedBlock > updatedBlock) updatedBlock = order.placedBlock;
  }
  const depth = input.depth === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(input.depth));
  return { bids: levels(bids, true).slice(0, depth), asks: levels(asks, false).slice(0, depth), updatedBlock, snapshotTimestamp: empty.snapshotTimestamp };
}

export function totalUnits(levelsInput: readonly BookLevel[]): bigint {
  return levelsInput.reduce((sum, level) => sum + level.units, 0n);
}

export type BookQuote = {
  bestBid: bigint | null;
  bestAsk: bigint | null;
  bidUnits: bigint;
  askUnits: bigint;
  fair: bigint | null;
  iv: number | null;
  delta: number | null;
  last: bigint | null;
};

export function quoteFromBook(book: AggregatedBook, last: bigint | null, fair?: { fair: bigint; iv: number; delta: number } | null): BookQuote {
  return {
    bestBid: book.bids[0]?.price ?? null,
    bestAsk: book.asks[0]?.price ?? null,
    bidUnits: totalUnits(book.bids),
    askUnits: totalUnits(book.asks),
    fair: fair?.fair ?? null,
    iv: fair?.iv ?? null,
    delta: fair?.delta ?? null,
    last,
  };
}
