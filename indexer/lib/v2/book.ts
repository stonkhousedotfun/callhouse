import { collateralWithRent, rentCapacity } from "./rent";

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
 *
 * An ask the contract's take would skip must not be listed, or it sits at the top of the book, the ticket
 * plans against it, `quoteTake` skips it, and every buy fails the quote check. Contract lines are callhouse-contracts
 * OrderBook.sol; a skipped fill is `continue` in `_plan` (:966).
 *   AskWrite  `plan.mintOpen` (:1091-1092) needs the market enabled, the mint not paused, the book on the Clearinghouse
 *             minter allow-list (`bookIsMinter`) and the cutoff not reached. The writer's budget is `usable` only if
 *             the writer made the book its Clearinghouse operator (`operators`, :1101). An unusable budget consumes
 *             nothing (`_consume` :1139-1140), so the fill is skipped.
 *   AskResale NO seller gate. The longs are escrowed in the book when the ask is placed (`_place` :768-769,
 *             `_escrowLongs` :799-802), and a buy delivers them from the book (`_deliver` :1155-1158). `_plan` reserves
 *             nothing for the seller when buying (:963-966). `_reserveInventory` (:1125-1135) is the TAKER's inventory
 *             when selling into a bid. The seller's own `balanceOf` excludes the escrowed units, so gating on it would
 *             hide live asks.
 * `bookIsMinter` and `operators` are optional so pure callers keep their behaviour. Every caller that serves the book
 * (bookData.ts, makerScoring.ts) passes both.
 *
 * ONE BUDGET PER WRITER. `_reserveCollateral` keeps a single budget per writer for a whole take and consumes
 * collateral plus rent from it fill by fill, so a writer's free balance backs its asks ONCE, not once per ask. Each
 * AskWrite is therefore listed, in price-time order, with what is left of its writer's balance after the writer's
 * better asks: capped separately, N asks on one collateral showed N times the depth (level units, `askUnits`, maker
 * scoring depth). `makerFreeUnits` / `makerFreeCollateral` still describe the writer's whole balance, as documented.
 *
 * A DISABLED market hides only AskWrite, like a paused mint; bids and resale asks stay listed. Contract lines
 * are callhouse-contracts. `enabled` is read in two places only: Clearinghouse.createSeries (:521)
 * and Clearinghouse.mint (:663), and in the book only through `plan.mintOpen` (OrderBook.sol:1091), which gates the
 * AskWrite buy (:963-964) and the taker's writeToSell (:965-966). A resale buy reserves nothing (:962-964) and delivers
 * the escrowed longs by `safeTransferFrom` (:1156-1158); a taker selling into a bid from inventory is
 * `_reserveInventory` (:967) and `safeTransferFrom` (:1171). Clearinghouse's ERC-1155 transfers (:910-926) read no
 * market flag, and the bid's USDG and the resale ask's longs are escrowed at placement (:766-769). So both stay
 * executable on a disabled market, and an empty book would hide them.
 */
export function aggregateBook(input: {
  series: BookSeries;
  orders: readonly BookOrder[];
  freeByMaker: ReadonlyMap<string, bigint>;
  now: bigint;
  /** Balance checkpoint time; use this earlier time for rent even if display time advances. */
  snapshotTimestamp?: bigint;
  /** Clearinghouse `market(underlying).enabled`. `false` lists no AskWrite (mint reverts MarketDisabled, :663); bids and
   *  resale asks stay. */
  marketEnabled?: boolean;
  mintPaused?: boolean;
  tradingPaused?: boolean;
  /** `Clearinghouse.isMinter(book)` (OrderBook.sol:1091). `false` lists no AskWrite; undefined applies no gate. */
  bookIsMinter?: boolean;
  /** Lowercased writers with `isOperator(writer, book)` (OrderBook.sol:1101). Absent from the set: its AskWrite is skipped. */
  operators?: ReadonlySet<string>;
  depth?: number;
}): AggregatedBook {
  const { series, orders, freeByMaker, now } = input;
  const empty: AggregatedBook = { bids: [], asks: [], updatedBlock: 0n, snapshotTimestamp: input.snapshotTimestamp ?? now };
  const liveAt = now > empty.snapshotTimestamp ? now : empty.snapshotTimestamp;
  if ((series.status !== "open" && series.status !== "cutoff") || liveAt >= series.expiry
      || input.tradingPaused === true) return empty;
  const cpu = collateralPerUnit(series.isPut, series.strike);
  const bids: FillableOrder[] = [];
  const asks: FillableOrder[] = [];
  const writes: FillableOrder[] = [];
  let updatedBlock = 0n;

  for (const order of orders) {
    if (order.longId !== series.longId || order.status !== "open" || order.price <= 0n) continue;
    const seriesDeadline = order.kind === "AskWrite" ? series.mintCutoff : series.expiry;
    const validUntil = order.validUntil === 0n || order.validUntil > seriesDeadline
      ? seriesDeadline : order.validUntil;
    if (validUntil <= liveAt) continue;
    const units = order.units - order.filled;
    const onChainRemainingUnits = units;
    let makerFreeUnits: bigint | null = null;
    let makerFreeCollateral: bigint | null = null;
    if (units <= 0n) continue;
    if (order.kind === "AskWrite") {
      if (liveAt >= series.mintCutoff || input.marketEnabled === false || input.mintPaused === true
          || input.bookIsMinter === false) continue;
      if (input.operators !== undefined && !input.operators.has(makerKey(order.maker))) continue;
      const free = freeByMaker.get(makerKey(order.maker)) ?? 0n;
      makerFreeCollateral = free;
      makerFreeUnits = rentCapacity(free, cpu, series.mintFeePpm, series.expiry - empty.snapshotTimestamp);
      if (makerFreeUnits <= 0n) continue;
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
    if (order.kind === "AskWrite") {
      writes.push(fillable);
      continue;
    }
    (order.kind === "Bid" ? bids : asks).push(fillable);
    if (order.placedBlock > updatedBlock) updatedBlock = order.placedBlock;
  }
  // Each writer's budget, spent in the order a take walks the asks (best price, then oldest).
  const remaining = series.expiry - empty.snapshotTimestamp;
  const left = new Map<string, bigint>();
  for (const order of writes.sort((a, b) => compare(a, b, false))) {
    const key = makerKey(order.maker);
    const free = left.get(key) ?? freeByMaker.get(key) ?? 0n;
    const covered = rentCapacity(free, cpu, series.mintFeePpm, remaining);
    const units = order.units < covered ? order.units : covered;
    if (units <= 0n) continue;
    left.set(key, free - collateralWithRent(units, cpu, series.mintFeePpm, remaining));
    asks.push({ ...order, units });
    if (order.placedBlock > updatedBlock) updatedBlock = order.placedBlock;
  }
  const depth = input.depth === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(input.depth));
  return { bids: levels(bids, true).slice(0, depth), asks: levels(asks, false).slice(0, depth), updatedBlock, snapshotTimestamp: empty.snapshotTimestamp };
}

/**
 * `bookIsMinter` and `operators` for aggregateBook, from indexed rows: MinterSet (v2_minter) and OperatorSet
 * (v2_account.operators, keyed by lowercased operator as setAddressFlag writes it; a revoked operator reads false).
 * Rows are filtered here as well, so a caller may pass a superset. With no book address, no writer can be shown usable.
 */
export function writeGatesFromRows(
  orderBook: string | undefined,
  minterRows: ReadonlyArray<{ minter: string; allowed: boolean }>,
  accountRows: ReadonlyArray<{ account: string; operators: string }>,
): { bookIsMinter: boolean; operators: Set<string> } {
  const operators = new Set<string>();
  if (orderBook === undefined) return { bookIsMinter: false, operators };
  const book = orderBook.toLowerCase();
  for (const row of accountRows) {
    const flags = JSON.parse(row.operators) as Record<string, boolean>;
    if (flags[book] === true) operators.add(makerKey(row.account));
  }
  return { bookIsMinter: minterRows.some((row) => row.minter.toLowerCase() === book && row.allowed), operators };
}

export function totalUnits(levelsInput: readonly BookLevel[]): bigint {
  return levelsInput.reduce((sum, level) => sum + level.units, 0n);
}

export type BookQuote = {
  bestBid: bigint | null;
  bestAsk: bigint | null;
  /** Total depth on each side, every level. */
  bidUnits: bigint;
  askUnits: bigint;
  /** Units at the best price only: what one price per share can be quoted on. 0 with no level. */
  bestBidUnits: bigint;
  bestAskUnits: bigint;
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
    bestBidUnits: book.bids[0]?.units ?? 0n,
    bestAskUnits: book.asks[0]?.units ?? 0n,
    fair: fair?.fair ?? null,
    iv: fair?.iv ?? null,
    delta: fair?.delta ?? null,
    last,
  };
}
