import { describe, expect, it } from "vitest";
import { aggregateBook, type BookOrder, type BookSeries } from "../../lib/v2/book";
import { executableAskDepth, walkAsks } from "../../lib/v2/cards";
import { collateralWithRent, mintRent, rentCapacity } from "../../lib/v2/rent";

const maker = "0x1111111111111111111111111111111111111111" as const;
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000, exerciseFeeBps: 25 };
const series: BookSeries = { longId: 2n, isPut: true, strike: 100n, mintFeePpm: 80,
  expiry: 604_800n, mintCutoff: 603_000n, status: "open" };
const order = (id: bigint, units: bigint, overrides: Partial<BookOrder> = {}): BookOrder => ({
  orderId: id, maker, longId: 2n, kind: "AskWrite", price: 10_000n, units,
  filled: 0n, validUntil: 0n, status: "open", placedAt: id, placedBlock: id, ...overrides,
});

describe("v7 rent and fill budgeting", () => {
  it("rounds per fill once, with zero-rate and expiry boundaries", () => {
    expect(mintRent(10_000n, 80, 604_800n)).toBe(1n);
    expect(mintRent(10_001n, 80, 604_800n)).toBe(1n);
    expect(mintRent(12_501n, 80, 604_800n)).toBe(2n);
    expect(mintRent(100n, 0, 604_800n)).toBe(0n);
    expect(mintRent(100n, 80, 0n)).toBe(0n);
    expect(mintRent(100n, 80, -1n)).toBe(0n);
    expect(collateralWithRent(10_000n, 1n, 80, 604_800n)).toBe(10_001n);
  });

  it.each([1n, 2_000_000n, 10n ** 16n])("computes exact maximal fill capacity for collateralPerUnit=%s", (cpu) => {
    for (const ppm of [0, 1, 80, 300, 5_000]) for (const remaining of [1n, 604_800n, 3_888_000n]) {
      for (const free of [0n, cpu, 100n * cpu, 100n * cpu + 1n]) {
        const n = rentCapacity(free, cpu, ppm, remaining);
        expect(collateralWithRent(n, cpu, ppm, remaining)).toBeLessThanOrEqual(free);
        expect(collateralWithRent(n + 1n, cpu, ppm, remaining)).toBeGreaterThan(free);
      }
    }
    expect(rentCapacity(10_001n, 1n, 80, 604_800n)).toBe(10_000n);
  });

  it("reserves separate ceilings across fills and skips an unfunded whole proposal", () => {
    const free = new Map([[maker, 10_001n]]);
    const book = aggregateBook({ series, now: 0n, freeByMaker: free,
      orders: [order(1n, 5_000n), order(2n, 5_000n), order(3n, 10n, { kind: "AskResale" })] });
    expect(book.asks[0]!.orders.slice(0, 2).map((o) => o.makerFreeUnits)).toEqual([10_000n, 10_000n]);
    const ticket = walkAsks(book, 10_000n, series, free, fees);
    // First fill spends 5000+1, second asks for 5000+1 with only5000 left and is skipped.
    expect(ticket.fills.map((fill) => [fill.orderId, fill.units])).toEqual([[1n, 5_000n], [3n, 10n]]);
    // A smaller requested ticket can fill both writes because the second proposal is4999 units.
    expect(walkAsks(book, 9_999n, series, free, fees).filled).toBe(9_999n);
  });

  it("preserves stored remaining and raw collateral when individual capacity is smaller", () => {
    const free = new Map([[maker, 10_001n]]);
    const book = aggregateBook({ series, now: 0n, freeByMaker: free, orders: [order(1n, 10_001n)] });
    expect(book.asks[0]!.orders[0]).toMatchObject({ units: 10_000n, onChainRemainingUnits: 10_001n,
      makerFreeCollateral: 10_001n, makerFreeUnits: 10_000n, collateralDecimals: 6 });
    expect(walkAsks(book, 10_001n, series, free, fees).filled).toBe(0n);
    expect(walkAsks(book, 10_000n, series, free, fees).filled).toBe(10_000n);
  });

  it("uses the balance checkpoint timestamp while removing wall-clock cutoff writes", () => {
    const free = new Map([[maker, 12_502n]]);
    const orders = [order(1n, 12_501n), order(2n, 5n, { kind: "AskResale" })];
    const pinned = aggregateBook({ series, now: 302_400n, snapshotTimestamp: 0n, freeByMaker: free, orders });
    expect(pinned.asks[0]!.orders[0]!.units).toBe(12_500n); // fee2, not the later fee1
    const cutoff = aggregateBook({ series, now: series.mintCutoff, snapshotTimestamp: 0n, freeByMaker: free, orders });
    expect(cutoff.asks[0]!.orders.map((o) => o.kind)).toEqual(["AskResale"]);
    expect(aggregateBook({ series, now: series.expiry, freeByMaker: free, orders }).asks).toEqual([]);
  });

  it("never advertises liquidity past the chain checkpoint when the host clock is behind", () => {
    const free = new Map([[maker, 10_001n]]);
    const orders = [order(1n, 10n), order(2n, 10n, { kind: "AskResale" })];
    const cutoff = aggregateBook({ series, now: series.mintCutoff - 1n, snapshotTimestamp: series.mintCutoff, freeByMaker: free, orders });
    expect(cutoff.asks.flatMap((level) => level.orders.map((o) => o.orderId))).toEqual([2n]);
    const deadline = aggregateBook({ series, now: 99n, snapshotTimestamp: 100n, freeByMaker: free,
      orders: [order(1n, 10n, { validUntil: 100n }), order(2n, 10n, { kind: "AskResale", validUntil: 100n })] });
    expect(deadline.asks).toEqual([]);
    expect(aggregateBook({ series, now: series.expiry - 1n, snapshotTimestamp: series.expiry, freeByMaker: free, orders }).asks).toEqual([]);
  });

  it("finds fully executable shared depth even when requesting the sum skips every large ask", () => {
    const free = new Map([[maker, 10_001n]]);
    const book = aggregateBook({ series, now: 0n, freeByMaker: free,
      orders: [order(1n, 20_000n), order(2n, 20_000n)] });
    expect(walkAsks(book, 20_000n, series, free, fees).filled).toBe(0n);
    expect(executableAskDepth(book, series, free, fees).filled).toBe(10_000n);
  });

  it("matches exhaustive maximum fully executable requests across rounded shared budgets", () => {
    for (let budget = 1n; budget <= 16n; budget++) {
      for (let first = 1n; first <= 8n; first++) {
        const free = new Map([[maker, budget]]);
        const book = aggregateBook({ series, now: 0n, freeByMaker: free,
          orders: [order(1n, first), order(2n, 9n - first), order(3n, 3n, { kind: "AskResale" })] });
        let best = 0n;
        for (let request = 1n; request <= 12n; request++) if (walkAsks(book, request, series, free, fees).filled === request) best = request;
        expect(executableAskDepth(book, series, free, fees).filled).toBe(best);
      }
    }
  });

  it("uses underlying base units for a call and USDG base units for a put", () => {
    for (const isPut of [false, true]) {
      const cpu = isPut ? 2_000_000n : 10n ** 16n;
      const terms = { ...series, isPut, strike: 200_000_000n };
      const book = aggregateBook({ series: terms, now: 0n, freeByMaker: new Map([[maker, 100n * cpu]]), orders: [order(1n, 100n)] });
      expect(book.asks[0]!.units).toBe(99n);
      expect(book.asks[0]!.orders[0]!.collateralDecimals).toBe(isPut ? 6 : 18);
    }
  });
});
