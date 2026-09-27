import type { PublicClient } from "viem";
import { USDG } from "../contracts";
import { describe, expect, it, vi } from "vitest";

import { BOOK_ORDERS_PER_SIDE, bookFromChain, levelsFromChainOrders, selectBookSnapshot, type ChainBookGates, type RawBookOrder } from "./bookFromChain";
import { advancingHeadClient } from "./testing/advancingHead";

vi.mock("./config", () => ({ requireV2Address: () => "0x0000000000000000000000000000000000000009" }));

const maker = "0x0000000000000000000000000000000000000001";
const longId = 22n;
const now = 1_790_000_000;
const base: RawBookOrder = { orderId: 1n, maker, longId, kind: 2, price: 1_000_000n,
  units: 15n, filled: 0n, validUntil: now + 100, cancelled: false };

describe("chain order-book fallback", () => {
  it("pins chain series, rent clock, collateral and orders to one block", async () => {
    const cutoff = now + 604000;
    const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "series") return { isPut: true, underlying: maker, mintFeePpm: 1200, expiry: now + 604800 };
      if (functionName === "collateralPerUnit") return 2_000_000n;
      if (functionName === "mintCutoff") return cutoff;
      if (functionName === "ordersOfSeries") return args?.[1] === 0n ? [[1n], 1n] : [[], 1n];
      if (functionName === "getOrders") return [{ ...base, units: 100n, validUntil: cutoff }];
      if (functionName === "tradingPaused") return false;
      if (functionName === "market") return { enabled: true, mintPaused: false };
      if (functionName === "isMinter") return true;
      throw new Error(`Unexpected ${functionName}`);
    });
    const multicall = vi.fn(async ({ contracts }: { contracts: readonly { functionName: string }[] }) =>
      contracts.map(({ functionName }) => {
        if (functionName === "free") return 200_000_000n;
        if (functionName === "isOperator") return true;
        throw new Error(`Unexpected multicall ${functionName}`);
      }));
    const client = { getBlockNumber: vi.fn(async () => 123n), getBlock: vi.fn(async () => ({ timestamp: BigInt(now) })), readContract, multicall } as unknown as PublicClient;
    const book = await bookFromChain(longId, USDG, 2_000_000n, cutoff, client);
    expect(book.snapshotTimestamp).toBe(now);
    expect(book.asks[0].orders[0]).toMatchObject({ units: "99", makerFreeCollateral: { raw: "200000000", decimals: 6 } });
    for (const [request] of readContract.mock.calls) expect(request).toMatchObject({ blockNumber: 123n });
    expect(multicall).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    await expect(bookFromChain(longId, maker, 2_000_000n, cutoff, client)).rejects.toThrow(/collateral asset/);
  });

  it("rebuilds at the new head, not viem's 4-second cached block number", async () => {
    const cutoff = now + 604000;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "series") return { isPut: true, underlying: maker, mintFeePpm: 1200, expiry: now + 604800 };
      if (functionName === "collateralPerUnit") return 2_000_000n;
      if (functionName === "mintCutoff") return cutoff;
      if (functionName === "ordersOfSeries") return [[], 0n];
      if (functionName === "tradingPaused") return false;
      if (functionName === "market") return { enabled: true, mintPaused: false };
      if (functionName === "isMinter") return true;
      throw new Error(`Unexpected ${functionName}`);
    });
    const client = advancingHeadClient(123n, { getBlock: vi.fn(async () => ({ timestamp: BigInt(now) })), readContract });
    expect((await bookFromChain(longId, USDG, 2_000_000n, cutoff, client)).updatedBlock).toBe("123");
    readContract.mockClear();
    // Back to back, well inside viem's 4 s cache: an order replaced in block 124 must not read as live.
    expect((await bookFromChain(longId, USDG, 2_000_000n, cutoff, client)).updatedBlock).toBe("124");
    for (const [request] of readContract.mock.calls) expect(request).toMatchObject({ blockNumber: 124n });
  });

  it("uses the rebuilt chain book when an API refetch fails with cached data", () => {
    const stale = { bids: [], asks: [], snapshotTimestamp: now, updatedBlock: "100" };
    const fresh = { bids: [], asks: [], snapshotTimestamp: now, updatedBlock: "101" };
    expect(selectBookSnapshot(stale, fresh, true)).toEqual({ book: fresh, degraded: true });
    expect(selectBookSnapshot(stale, undefined, true)).toEqual({ book: null, degraded: false });
    expect(selectBookSnapshot(stale, fresh, false)).toEqual({ book: stale, degraded: false });
  });

  it("caps a crowded level deterministically and sums only returned orders", () => {
    const orders = Array.from({ length: BOOK_ORDERS_PER_SIDE + 1 }, (_, index) => index).reverse()
      .flatMap((index) => [
        { ...base, orderId: BigInt(10_000 + index), kind: 1, units: 1n },
        { ...base, orderId: BigInt(20_000 + index), kind: 0, units: 1n },
      ]);
    const book = levelsFromChainOrders(orders, new Map(), 1n, longId, now, 123n);
    for (const [levels, firstId] of [[book.asks, 10_000], [book.bids, 20_000]] as const) {
      expect(levels).toHaveLength(1);
      expect(levels[0]!.orders).toHaveLength(BOOK_ORDERS_PER_SIDE);
      expect(levels[0]!.orders.map((order) => order.orderId)).toEqual(
        Array.from({ length: BOOK_ORDERS_PER_SIDE }, (_, index) => String(firstId + index)));
      expect(levels[0]!.units).toBe(levels[0]!.orders.reduce(
        (sum, order) => sum + BigInt(order.units), 0n).toString());
    }
  });

  it("sorts levels and exposes per-order capacity for the ticket shared budget", () => {
    const orders: RawBookOrder[] = [
      { ...base, orderId: 2n, price: 1_200_000n },
      base,
      { ...base, orderId: 3n, kind: 1, price: 1_100_000n, units: 7n },
      { ...base, orderId: 4n, kind: 0, price: 800_000n, units: 9n },
      { ...base, orderId: 5n, kind: 0, price: 900_000n, units: 4n },
      { ...base, orderId: 6n, cancelled: true },
      { ...base, orderId: 7n, validUntil: now },
      { ...base, orderId: 8n, longId: 99n },
    ];
    const book = levelsFromChainOrders(orders, new Map([[maker, 20n]]), 1n, longId, now, 123n);
    expect(book.updatedBlock).toBe("123");
    expect(book.asks.map((level) => [level.price.raw, level.units])).toEqual([
      ["1000000", "15"], ["1100000", "7"], ["1200000", "15"],
    ]);
    expect(book.bids.map((level) => level.price.raw)).toEqual(["900000", "800000"]);
    expect(book.asks[2].orders[0].kind).toBe("AskWrite");
    expect(book.asks[2].orders[0]).toMatchObject({ units: "15", onChainRemainingUnits: "15", makerFreeUnits: "20" });
  });

  it("handles an empty book and refuses invalid collateral", () => {
    expect(levelsFromChainOrders([], new Map(), 1n, longId, now, 0n)).toEqual({ bids: [], asks: [], snapshotTimestamp: now, updatedBlock: "0" });
    expect(() => levelsFromChainOrders([base], new Map(), 0n, longId, now, 0n)).toThrow();
  });

  it("drops write-on-fill asks at mint cutoff but keeps resale asks and bids", () => {
    const orders = [base, { ...base, orderId: 2n, kind: 1 }, { ...base, orderId: 3n, kind: 0 }];
    const book = levelsFromChainOrders(orders, new Map([[maker, 20n]]), 1n, longId, now, 124n, now);
    expect(book.asks.flatMap((level) => level.orders.map((order) => order.kind))).toEqual(["AskResale"]);
    expect(book.bids[0].orders[0].kind).toBe("Bid");
  });

  describe("take-time gates the order fields do not show", () => {
    const writer2 = "0x0000000000000000000000000000000000000002";
    const seller = "0x0000000000000000000000000000000000000003";
    const open: ChainBookGates = { tradingPaused: false, mintOpen: true, operators: new Set([maker, writer2]) };
    const orders: RawBookOrder[] = [
      base,
      { ...base, orderId: 2n, maker: writer2, price: 1_100_000n },
      { ...base, orderId: 3n, maker: seller, kind: 1, price: 1_200_000n, units: 30n },
      { ...base, orderId: 4n, kind: 0, price: 900_000n, units: 9n },
    ];
    const free = new Map([[maker, 20n], [writer2, 20n]]);
    const kinds = (gates: ChainBookGates) => levelsFromChainOrders(orders, free, 1n, longId, now, 1n, Number.POSITIVE_INFINITY, 0,
      now + 604800, 18, gates);
    const askIds = (gates: ChainBookGates) => kinds(gates).asks.flatMap((level) => level.orders.map((order) => order.orderId));

    it("keeps every order when every gate is open", () => {
      expect(askIds(open)).toEqual(["1", "2", "3"]);
      expect(kinds(open).bids).toHaveLength(1);
    });

    it("shows nothing executable while trading is paused, bids included", () => {
      const book = kinds({ ...open, tradingPaused: true });
      expect(book.asks).toEqual([]);
      expect(book.bids).toEqual([]);
    });

    it("drops write-on-fill asks while minting is closed, keeping resale asks and bids", () => {
      const book = kinds({ ...open, mintOpen: false });
      expect(book.asks.flatMap((level) => level.orders.map((order) => order.kind))).toEqual(["AskResale"]);
      expect(book.bids).toHaveLength(1);
    });

    it("drops a writer's asks when the writer has not made the book its operator", () => {
      expect(askIds({ ...open, operators: new Set([writer2]) })).toEqual(["2", "3"]);
    });

    // This case used to cap a resale ask at the seller's balance and drop it
    // at zero. The longs are escrowed in the book (OrderBook _place :768-769, _escrowLongs :799-802), so the seller's
    // balance says nothing about the ask: it is listed at its full remaining units under every gate.
    it("lists an escrowed resale ask at its full remaining units whatever gate is closed but trading", () => {
      for (const gates of [open, { ...open, mintOpen: false }, { ...open, operators: new Set<string>() }]) {
        expect(kinds(gates).asks.find((level) => level.price.raw === "1200000")?.units).toBe("30");
      }
    });

    it("reads every gate at the pinned block and applies them", async () => {
      const cutoff = now + 604000;
      const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "series") return { isPut: true, underlying: maker, mintFeePpm: 0, expiry: now + 604800 };
        if (functionName === "collateralPerUnit") return 1n;
        if (functionName === "mintCutoff") return cutoff;
        if (functionName === "ordersOfSeries") return args?.[1] === 0n ? [[1n, 2n, 3n], 3n] : [[], 3n];
        if (functionName === "getOrders") return [
          { ...base, validUntil: cutoff },
          { ...base, maker: writer2, price: 1_100_000n, validUntil: cutoff },
          { ...base, maker: seller, kind: 1, price: 1_200_000n, units: 30n, validUntil: cutoff },
        ];
        if (functionName === "tradingPaused") return false;
        if (functionName === "market") return { enabled: true, mintPaused: false };
        if (functionName === "isMinter") return true;
        throw new Error(`Unexpected ${functionName}`);
      });
      const multicall = vi.fn(async ({ contracts }: { contracts: readonly { functionName: string; args: readonly unknown[] }[] }) =>
        contracts.map(({ functionName, args }) => {
          if (functionName === "free") return 20n;
          if (functionName === "isOperator") return String(args[0]).toLowerCase() === writer2;
          // The resale seller holds nothing and has not approved the book; its escrowed ask still fills.
          if (functionName === "isApprovedForAll") return false;
          if (functionName === "balanceOf") return 0n;
          throw new Error(`Unexpected multicall ${functionName}`);
        }));
      const client = { getBlockNumber: vi.fn(async () => 7n), getBlock: vi.fn(async () => ({ timestamp: BigInt(now) })), readContract, multicall } as unknown as PublicClient;
      const book = await bookFromChain(longId, USDG, 1n, cutoff, client);
      expect(book.asks.flatMap((level) => level.orders.map((order) => [order.orderId, order.units]))).toEqual([["2", "15"], ["3", "30"]]);
      const asked = multicall.mock.calls.flatMap(([request]) => request.contracts.map((call) => call.functionName));
      expect(asked).not.toContain("balanceOf");
      expect(asked).not.toContain("isApprovedForAll");
      for (const [request] of readContract.mock.calls) expect(request).toMatchObject({ blockNumber: 7n });
      for (const [request] of multicall.mock.calls) expect(request).toMatchObject({ blockNumber: 7n });
    });
  });
});
