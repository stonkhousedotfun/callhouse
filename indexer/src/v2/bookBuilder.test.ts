import { describe, expect, it } from "vitest";
import { aggregateBook, quoteFromBook, type BookOrder, type BookSeries } from "../../lib/v2/book";

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
    expect(quoteFromBook(book, 900_000n, null)).toEqual({ bestBid: 1_500_000n, bestAsk: 1_000_000n,
      bidUnits: 200n, askUnits: 260n, fair: null, iv: null, delta: null, last: 900_000n });
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

  it("preserves each writer's shared budget alongside individually fillable ask units", () => {
    const book = aggregateBook({ series, now: 100n, freeByMaker: new Map([[maker.toLowerCase(), 50n * 10n ** 16n]]),
      orders: [order(1n, "AskWrite", 500_000n, { units: 50n }),
        order(2n, "AskWrite", 600_000n, { units: 50n })] });
    expect(book.asks.map((level) => level.orders[0])).toMatchObject([
      { units: 50n, onChainRemainingUnits: 50n, makerFreeUnits: 50n },
      { units: 50n, onChainRemainingUnits: 50n, makerFreeUnits: 50n },
    ]);
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
