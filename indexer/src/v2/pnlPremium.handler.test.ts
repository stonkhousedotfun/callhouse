import { describe, expect, it, vi } from "vitest";

import * as schema from "../../ponder.schema";

type Handler = (input: { event: unknown; context: unknown }) => Promise<void>;
const handlers = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_START_BLOCK ??= "100";
  return new Map<string, Handler>();
});
const pricing = vi.hoisted(() => ({
  calls: 0,
  quote: null as null | { fair: bigint; asOf: number; spot: bigint },
}));

vi.mock("../../lib/registry", () => ({
  v2Ponder: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
}));
vi.mock("ponder:schema", async () => {
  const actual = await vi.importActual<typeof schema>("../../ponder.schema");
  return { default: actual, ...actual };
});
vi.mock("../../lib/v2/pricing", () => ({ fetchFairQuote: async () => {
  pricing.calls += 1;
  return pricing.quote;
} }));

type Row = Record<string, unknown>;

/** The PnL clock's Ponder methods backed by in-memory rows. Every SELECT sees the
 * whole single-block fixture; only the SQL predicates that matter to this test
 * (the clock block range) are satisfied by the fixture itself. */
function memoryDb(seed: [object, Row[]][]) {
  const tables = new Map<object, Row[]>(seed);
  const rows = (table: object) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const matches = (row: Row, key: Row) => Object.entries(key).every(([column, value]) => row[column] === value);
  const query = (table: object) => {
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      then: <T>(resolve: (value: Row[]) => T, reject?: (reason: unknown) => unknown) =>
        Promise.resolve([...rows(table)]).then(resolve, reject),
    };
    return chain;
  };
  return {
    rows,
    db: {
      sql: { select: () => ({ from: (table: object) => query(table) }) },
      find: async (table: object, key: Row) => rows(table).find((row) => matches(row, key)) ?? null,
      insert: (table: object) => ({ values: (value: Row) => {
        const write = (patch?: Row) => {
          const existing = rows(table).find((row) => row.id === value.id);
          if (existing) {
            if (!patch) throw new Error(`duplicate indexed row ${String(value.id)}`);
            Object.assign(existing, patch);
            return existing;
          }
          const inserted = { ...(table === schema.v2PositionPnl ? { spotAtEntry: null } : {}), ...value };
          rows(table).push(inserted);
          return inserted;
        };
        return {
          then: <T>(resolve: (value: Row) => T, reject?: (reason: unknown) => unknown) =>
            Promise.resolve().then(() => write()).then(resolve, reject),
          onConflictDoUpdate: (patch: Row) => Promise.resolve().then(() => write(patch)),
        };
      } }),
      update: (table: object, key: Row) => ({ set: async (patch: Row) => {
        const current = rows(table).find((row) => matches(row, key));
        if (!current) throw new Error("missing indexed row");
        Object.assign(current, patch);
        return current;
      } }),
    },
  };
}

describe("V2PnlClock primary writer premium projection", () => {
  it("accumulates two bid-write fills from one take and does not count the block twice", async () => {
    await import("./pnl");
    const handler = handlers.get("V2PnlClock:block");
    expect(handler).toBeDefined();

    const writer = "0x0000000000000000000000000000000000000033";
    const buyerA = "0x0000000000000000000000000000000000000044";
    const buyerB = "0x0000000000000000000000000000000000000055";
    const zero = "0x0000000000000000000000000000000000000000";
    const tx = `0x${"a".repeat(64)}`;
    const common = { longId: 2n, ts: 1_800_000_000n, block: 100n, tx };
    const fill = (id: string, maker: string, units: bigint, premium: bigint, sellerFee: bigint,
      logIndex: number) => ({ id, orderId: BigInt(logIndex), ...common, maker, taker: writer,
      recipient: writer, buyer: maker, seller: writer, units, price: 100n, premium,
      sellerFee, makerRebate: 0n, primary: true, takerIsBuyer: false,
      fairAtFill: null, realisedDeltaUsdg: null, logIndex });
    const transfer = (id: string, to: string, units: bigint, logIndex: number) => ({
      id, tokenId: 2n, ...common, from: zero, to, units, logIndex,
    });
    const mint = (id: string, longTo: string, units: bigint, logIndex: number) => ({
      id, ...common, writer, longTo, units, collateral: units * 10n ** 16n, logIndex,
    });
    const state = memoryDb([
      [schema.v2Series, [{ longId: 2n, ticker: "TEST",
        underlying: "0x0000000000000000000000000000000000000011",
        oracle: "0x0000000000000000000000000000000000000012",
        strike: 200_000_000n, expiry: 1_800_086_400n, isPut: false }]],
      [schema.v2Transfer, [transfer("transfer-a", buyerA, 1n, 1), transfer("transfer-b", buyerB, 2n, 4)]],
      [schema.v2Mint, [mint("mint-a", buyerA, 1n, 2), mint("mint-b", buyerB, 2n, 5)]],
      [schema.v2Fill, [fill("fill-a", buyerA, 1n, 100n, 5n, 3),
        fill("fill-b", buyerB, 2n, 200n, 10n, 6)]],
      [schema.v2Take, [{ id: "take", ...common, taker: writer, buying: false,
        units: 3n, premium: 300n, takerFee: 11n, logIndex: 7 }]],
    ]);
    const input = { event: { block: { number: 100n } }, context: { db: state.db,
      client: { readContract: async () => [true, 200_000_000n, 1_800_000_000n] } } };
    await handler!(input);

    expect(state.rows(schema.v2WriterSeriesPremium)).toEqual([{
      id: `2-${writer}`, longId: 2n, writer, premiumUsdg: 274n,
    }]);
    expect(state.rows(schema.v2WriterStats).filter((row) => row.window === "all"))
      .toEqual([expect.objectContaining({ writer, premiumUsdg: 274n })]);
    await handler!(input);
    expect(state.rows(schema.v2WriterSeriesPremium)[0]?.premiumUsdg).toBe(274n);
  });

  it("derives fill references only from replayable chain state", async () => {
    await import("./pnl");
    const handler = handlers.get("V2PnlClock:block");
    expect(handler).toBeDefined();

    const underlying = "0x0000000000000000000000000000000000000011";
    const oracle = "0x0000000000000000000000000000000000000012";
    const writerA = "0x0000000000000000000000000000000000000021";
    const writerB = "0x0000000000000000000000000000000000000022";
    const buyerA = "0x0000000000000000000000000000000000000031";
    const buyerB = "0x0000000000000000000000000000000000000032";
    const zero = "0x0000000000000000000000000000000000000000";
    const ts = 1_800_000_000n;
    const oracleSpot = 225_000_000n;

    const replay = async (quote: NonNullable<typeof pricing.quote>) => {
      pricing.quote = quote;
      const txA = `0x${"a".repeat(64)}`;
      const txB = `0x${"b".repeat(64)}`;
      const fill = (id: string, tx: string, writer: string, buyer: string, price: bigint,
        premium: bigint, logIndex: number) => ({ id, orderId: BigInt(logIndex), longId: 2n, ts,
        block: 100n, tx, maker: writer, taker: buyer, recipient: buyer, buyer, seller: writer,
        units: 100n, price, premium, sellerFee: 0n, makerRebate: 0n, primary: true,
        takerIsBuyer: true, fairAtFill: null, realisedDeltaUsdg: null, logIndex });
      const fills = [fill("fill-a", txA, writerA, buyerA, 1_000n, 1_000n, 3),
        fill("fill-b", txB, writerB, buyerB, 2_000n, 2_000n, 3)];
      const state = memoryDb([
        [schema.v2Series, [{ longId: 2n, ticker: "TEST", underlying, oracle,
          strike: 200_000_000n, expiry: ts + 86_400n, isPut: false }]],
        [schema.v2Transfer, [
          { id: "transfer-a", tokenId: 2n, longId: 2n, ts, block: 100n, tx: txA,
            from: zero, to: buyerA, units: 100n, logIndex: 1 },
          { id: "transfer-b", tokenId: 2n, longId: 2n, ts, block: 100n, tx: txB,
            from: zero, to: buyerB, units: 100n, logIndex: 1 },
        ]],
        [schema.v2Mint, [
          { id: "mint-a", longId: 2n, writer: writerA, longTo: buyerA, units: 100n,
            collateral: 10n ** 18n, ts, block: 100n, tx: txA, logIndex: 2 },
          { id: "mint-b", longId: 2n, writer: writerB, longTo: buyerB, units: 100n,
            collateral: 10n ** 18n, ts, block: 100n, tx: txB, logIndex: 2 },
        ]],
        [schema.v2Fill, fills],
        [schema.v2Take, [
          { id: "take-a", longId: 2n, taker: buyerA, buying: true, units: 100n,
            premium: 1_000n, takerFee: 0n, ts, block: 100n, tx: txA, logIndex: 4 },
          { id: "take-b", longId: 2n, taker: buyerB, buying: true, units: 100n,
            premium: 2_000n, takerFee: 0n, ts, block: 100n, tx: txB, logIndex: 4 },
        ]],
      ]);
      const readContract = vi.fn(async () => [true, oracleSpot, ts] as const);
      await handler!({ event: { block: { number: 100n } },
        context: { db: state.db, client: { readContract } } });
      return {
        output: {
          fills: state.rows(schema.v2Fill).map((row) => ({ id: row.id, fairAtFill: row.fairAtFill })),
          positions: state.rows(schema.v2PositionPnl).map((row) => ({
            id: row.id, offMarket: row.offMarket, spotAtEntry: row.spotAtEntry,
          })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        },
        readContract,
      };
    };

    pricing.calls = 0;
    const first = await replay({ fair: 9_000n, asOf: Number(ts), spot: 190_000_000n });
    const second = await replay({ fair: 30_000n, asOf: Number(ts), spot: 310_000_000n });

    expect(second.output).toEqual(first.output);
    expect(pricing.calls).toBe(0);
    expect(first.output.fills).toEqual([
      { id: "fill-a", fairAtFill: 2_000n },
      { id: "fill-b", fairAtFill: 1_000n },
    ]);
    expect(first.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: oracle, functionName: "trySpot", args: [underlying], blockNumber: 100n,
    }));
    expect(first.output.positions.map((row) => row.spotAtEntry)).toEqual([oracleSpot, oracleSpot]);
  });
});
