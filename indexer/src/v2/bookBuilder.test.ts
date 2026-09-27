import { describe, expect, it } from "vitest";
import { aggregateBook, quoteFromBook, writeGatesFromRows, type BookOrder, type BookSeries } from "../../lib/v2/book";

const maker = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222" as const;
const series: BookSeries = { longId: 8n, isPut: false, strike: 200_000_000n, mintCutoff: 900n, mintFeePpm: 0, expiry: 1000n, status: "open" };

function order(id: bigint, kind: BookOrder["kind"], price: bigint, overrides: Partial<BookOrder> = {}): BookOrder {
  return { orderId: id, maker, longId: 8n, kind, price, units: 100n, filled: 0n, validUntil: 0n,
    status: "open", placedAt: id, placedBlock: id, ...overrides };
}

describe("v2 book aggregation", () => {
  it("sorts prices and time, groups levels, and uses remaining rather than original units", () => {
    const book = aggregateBook({ series, now: 100n, freeByMaker: new Map(), orders: [
      order(5n, "Bid", 1_000_000n), order(2n, "AskResale", 2_000_000n, { filled: 40n }),
      order(1n, "AskResale", 1_000_000n), order(3n, "AskResale", 1_000_000n),
      order(4n, "Bid", 1_500_000n),
    ] });
    expect(book.asks.map((level) => [level.price, level.units])).toEqual([[1_000_000n, 200n], [2_000_000n, 60n]]);
    expect(book.asks[0]?.orders.map((item) => item.orderId)).toEqual([1n, 3n]);
    expect(book.bids.map((level) => level.price)).toEqual([1_500_000n, 1_000_000n]);
    expect(book.updatedBlock).toBe(5n);
    // bid/askUnits are total depth; bestBid/bestAskUnits are the units at the best price only.
    expect(quoteFromBook(book, 900_000n, null)).toEqual({ bestBid: 1_500_000n, bestAsk: 1_000_000n,
      bidUnits: 200n, askUnits: 260n, bestBidUnits: 100n, bestAskUnits: 200n, fair: null, iv: null, delta: null, last: 900_000n });
  });

  it("excludes cancelled, filled, expired, other-series and unfunded AskWrite orders", () => {
    const book = aggregateBook({ series, now: 800n, freeByMaker: new Map([[maker.toLowerCase(), 10n ** 16n], [other.toLowerCase(), 9n * 10n ** 15n]]), orders: [
      order(1n, "AskWrite", 100n, { units: 5n }),
      order(2n, "AskWrite", 100n, { maker: other }),
      order(3n, "AskResale", 100n, { status: "cancelled" }),
      order(4n, "Bid", 100n, { status: "filled" }),
      order(5n, "Bid", 100n, { validUntil: 799n }),
      order(6n, "AskResale", 100n, { longId: 10n }),
    ] });
    expect(book.asks[0]?.orders.map((item) => [item.orderId, item.units, item.validUntil])).toEqual([[1n, 1n, 900n]]);
    expect(book.asks[0]?.orders[0]).toMatchObject({ onChainRemainingUnits: 5n, makerFreeUnits: 1n });
    expect(book.bids).toEqual([]);
    expect(aggregateBook({ series, now: 900n, freeByMaker: new Map([[maker.toLowerCase(), 10n ** 16n]]),
      orders: [order(1n, "AskWrite", 100n), order(2n, "AskResale", 100n)] }).asks[0]?.orders.map((item) => item.orderId)).toEqual([2n]);
  });

  // This case pinned each ask capped separately, 50 + 50 units on one 50-unit
  // balance. OrderBook._reserveCollateral keeps ONE budget per writer per take, so the balance backs the best ask and
  // nothing is left for the next; makerFreeUnits still reports the writer's whole balance.
  it("spends each writer's shared budget once across its asks, best price first", () => {
    const book = aggregateBook({ series, now: 100n, freeByMaker: new Map([[maker.toLowerCase(), 50n * 10n ** 16n]]),
      orders: [order(2n, "AskWrite", 600_000n, { units: 50n }),
        order(1n, "AskWrite", 500_000n, { units: 50n })] });
    expect(book.asks.map((level) => level.orders[0])).toMatchObject([
      { orderId: 1n, units: 50n, onChainRemainingUnits: 50n, makerFreeUnits: 50n },
    ]);
    const split = aggregateBook({ series, now: 100n, freeByMaker: new Map([[maker.toLowerCase(), 80n * 10n ** 16n]]),
      orders: [order(1n, "AskWrite", 500_000n, { units: 50n }), order(2n, "AskWrite", 600_000n, { units: 50n })] });
    expect(split.asks.map((level) => [level.orders[0]!.orderId, level.units])).toEqual([[1n, 50n], [2n, 30n]]);
    // The quote /series/:id and /book serve counts the balance once as well (askUnits was 100 here).
    expect(quoteFromBook(split, null)).toMatchObject({ askUnits: 80n, bestAskUnits: 50n });
  });

  // The shared budget is spent on collateral PLUS rent, like
  // OrderBook._reserveCollateral (callhouse-contracts OrderBook.sol:1132-1134: collateral +
  // OptionMath.mintFee(collateral, mintFeePpm, expiry - now), rounded up). 5000 ppm over four weeks is 2%: the best ask
  // takes 50 units for 51 units' worth of balance, which leaves 49, and 49 covers 48 units with rent (48.96), not 49
  // (49.98). Spending the collateral alone would leave 50 and list 49.
  it("spends collateral plus rent from each writer's shared budget", () => {
    const rented = { ...series, mintFeePpm: 5_000, expiry: 100n + 4n * 604_800n, mintCutoff: 4n * 604_800n };
    const book = aggregateBook({ series: rented, now: 100n, freeByMaker: new Map([[maker.toLowerCase(), 100n * 10n ** 16n]]),
      orders: [order(1n, "AskWrite", 500_000n, { units: 50n }), order(2n, "AskWrite", 600_000n, { units: 50n })] });
    expect(book.asks.map((level) => [level.orders[0]!.orderId, level.units, level.orders[0]!.makerFreeUnits]))
      .toEqual([[1n, 50n, 98n], [2n, 48n, 98n]]);
    expect(quoteFromBook(book, null)).toMatchObject({ askUnits: 98n, bestAskUnits: 50n });
  });

  it("uses USDG collateral for puts and obeys market and book pauses", () => {
    const put = { ...series, isPut: true, strike: 200_000_000n };
    const asks = [order(1n, "AskWrite", 100n, { units: 100n })];
    const free = new Map([[maker.toLowerCase(), 3_900_000n]]); // $3.90 / $2 per put unit = 1 unit
    expect(aggregateBook({ series: put, orders: asks, freeByMaker: free, now: 100n }).asks[0]?.units).toBe(1n);
    expect(aggregateBook({ series: put, orders: asks, freeByMaker: free, now: 100n, mintPaused: true }).asks).toEqual([]);
    expect(aggregateBook({ series: put, orders: asks, freeByMaker: free, now: 100n, tradingPaused: true }).asks).toEqual([]);
    expect(aggregateBook({ series: put, orders: asks, freeByMaker: free, now: 100n, marketEnabled: false }).asks).toEqual([]);
  });

  it("keeps resale trading during the mint cutoff while removing new writer asks", () => {
    const cutoff = { ...series, status: "cutoff" as const };
    const book = aggregateBook({ series: cutoff, orders: [order(1n, "AskWrite", 100n), order(2n, "AskResale", 200n), order(3n, "Bid", 100n)],
      freeByMaker: new Map([[maker.toLowerCase(), 10n ** 16n]]), now: 900n });
    expect(book.asks.flatMap((level) => level.orders.map((item) => item.orderId))).toEqual([2n]);
    expect(book.bids[0]?.orders[0]?.orderId).toBe(3n);
  });
});

/*
 * The asks the contract's take skips are not listed (callhouse-contracts, OrderBook.sol):
 * a write ask needs the book on the minter allow-list (:1091) and the writer's `isOperator(writer, book)` (:1101). A
 * resale ask has NO seller gate: its longs are escrowed in the book at placement (:768-769, :799-802).
 */
describe("write-on-fill gates and best-level depth", () => {
  const funded = new Map([[maker.toLowerCase(), 10n ** 18n], [other.toLowerCase(), 10n ** 18n]]);
  const orders = [
    order(1n, "AskWrite", 100n, { units: 10n }),
    order(2n, "AskWrite", 150n, { units: 10n, maker: other }),
    order(3n, "AskResale", 200n, { units: 10n, maker: other }),
  ];
  const ids = (book: ReturnType<typeof aggregateBook>) => book.asks.flatMap((level) => level.orders.map((item) => item.orderId));

  it("drops a writer that has not made the book its operator, and keeps the one that has", () => {
    const book = aggregateBook({ series, now: 100n, freeByMaker: funded, orders, bookIsMinter: true,
      operators: new Set([maker.toLowerCase()]) });
    expect(ids(book)).toEqual([1n, 3n]);
  });

  it("lists no write ask while the book is off the minter allow-list; resale asks stay", () => {
    const book = aggregateBook({ series, now: 100n, freeByMaker: funded, orders, bookIsMinter: false,
      operators: new Set([maker.toLowerCase(), other.toLowerCase()]) });
    expect(ids(book)).toEqual([3n]);
  });

  it("never gates a resale ask on its seller: the escrowed longs sit in the book", () => {
    // `other` is in no operator set and the book is not a minter: its AskResale is still executable.
    const book = aggregateBook({ series, now: 100n, freeByMaker: new Map(), orders: [orders[2]!], bookIsMinter: false,
      operators: new Set() });
    expect(ids(book)).toEqual([3n]);
  });

  it("a stale write ask no longer tops the book: the next fillable ask is the best", () => {
    // Order 1 is the cheapest ask, but its writer revoked the book as operator; the take would skip it.
    const book = aggregateBook({ series, now: 100n, freeByMaker: funded, orders, bookIsMinter: true,
      operators: new Set([other.toLowerCase()]) });
    expect(book.asks[0]?.orders.map((item) => item.orderId)).toEqual([2n]);
    expect(quoteFromBook(book, null, null).bestAsk).toBe(150n);
  });

  it("best-level units: 40 at 0.50 over 100 at 0.80 is 40 at the best price and 140 in total", () => {
    const book = aggregateBook({ series, now: 100n, freeByMaker: new Map(), orders: [
      order(1n, "AskResale", 500_000n, { units: 40n }), order(2n, "AskResale", 800_000n, { units: 100n }),
    ] });
    expect(quoteFromBook(book, null, null)).toMatchObject({ bestAsk: 500_000n, bestAskUnits: 40n, askUnits: 140n,
      bestBid: null, bestBidUnits: 0n, bidUnits: 0n });
  });

  /*
   * A disabled market gates only what mints: Clearinghouse.mint
   * reverts MarketDisabled (:663), which the book reads as `plan.mintOpen` (OrderBook.sol:1091) for the AskWrite buy and
   * the taker's writeToSell. A resale ask delivers its escrowed longs and a bid takes the seller's inventory, both by an
   * ERC-1155 transfer that reads no market flag (OrderBook.sol:1156-1158, :1171; Clearinghouse.sol:910-926).
   */
  it("a disabled market lists no write ask, and keeps its bids and resale asks", () => {
    const withBid = [...orders, order(4n, "Bid", 90n, { units: 10n, maker: other })];
    const gates = { bookIsMinter: true, operators: new Set([maker.toLowerCase(), other.toLowerCase()]) };
    const off = aggregateBook({ series, now: 100n, freeByMaker: funded, orders: withBid, ...gates, marketEnabled: false });
    expect(ids(off)).toEqual([3n]);
    expect(off.bids.flatMap((level) => level.orders.map((item) => item.orderId))).toEqual([4n]);
    expect(quoteFromBook(off, null, null)).toMatchObject({ bestBid: 90n, bestAsk: 200n, bestBidUnits: 10n, bestAskUnits: 10n });
    // Control: the same book with the market enabled lists both write asks as well.
    const on = aggregateBook({ series, now: 100n, freeByMaker: funded, orders: withBid, ...gates, marketEnabled: true });
    expect(ids(on)).toEqual([1n, 2n, 3n]);
    expect(on.bids.flatMap((level) => level.orders.map((item) => item.orderId))).toEqual([4n]);
  });

  it("derives the gates from indexed rows: the book's own flag, case-insensitive, a revoked operator is out", () => {
    const book = "0x000000000000000000000000000000000000C012";
    const gates = writeGatesFromRows(book, [
      { minter: "0x0000000000000000000000000000000000000bad", allowed: true },
      { minter: book.toLowerCase(), allowed: true },
    ], [
      { account: maker, operators: JSON.stringify({ [book.toLowerCase()]: true }) },
      { account: other, operators: JSON.stringify({ [book.toLowerCase()]: false }) },
      { account: "0x3333333333333333333333333333333333333333", operators: JSON.stringify({ "0x0000000000000000000000000000000000000bad": true }) },
    ]);
    expect(gates.bookIsMinter).toBe(true);
    expect([...gates.operators]).toEqual([maker.toLowerCase()]);
    expect(writeGatesFromRows(book, [{ minter: book.toLowerCase(), allowed: false }], []).bookIsMinter).toBe(false);
    expect(writeGatesFromRows(book, [], []).bookIsMinter).toBe(false);
    // No book address: nothing can be shown usable.
    expect(writeGatesFromRows(undefined, [{ minter: book, allowed: true }],
      [{ account: maker, operators: JSON.stringify({ [book.toLowerCase()]: true }) }])).toEqual({ bookIsMinter: false, operators: new Set() });
  });
});
