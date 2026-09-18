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

vi.mock("../../lib/registry", () => ({
  v2Ponder: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
}));
vi.mock("ponder:schema", async () => {
  const actual = await vi.importActual<typeof schema>("../../ponder.schema");
  return { default: actual, ...actual };
});
vi.mock("../../lib/v2/pricing", () => ({ fetchFairQuote: async () => null }));

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
          rows(table).push({ ...value });
          return value;
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
      [schema.v2Series, [{ longId: 2n, ticker: "TEST", strike: 200_000_000n,
        expiry: 1_800_086_400n, isPut: false }]],
      [schema.v2Transfer, [transfer("transfer-a", buyerA, 1n, 1), transfer("transfer-b", buyerB, 2n, 4)]],
      [schema.v2Mint, [mint("mint-a", buyerA, 1n, 2), mint("mint-b", buyerB, 2n, 5)]],
      [schema.v2Fill, [fill("fill-a", buyerA, 1n, 100n, 5n, 3),
        fill("fill-b", buyerB, 2n, 200n, 10n, 6)]],
      [schema.v2Take, [{ id: "take", ...common, taker: writer, buying: false,
        units: 3n, premium: 300n, takerFee: 11n, logIndex: 7 }]],
    ]);
    const input = { event: { block: { number: 100n } }, context: { db: state.db } };
    await handler!(input);

    expect(state.rows(schema.v2WriterSeriesPremium)).toEqual([{
      id: `2-${writer}`, longId: 2n, writer, premiumUsdg: 274n,
    }]);
    expect(state.rows(schema.v2WriterStats).filter((row) => row.window === "all"))
      .toEqual([expect.objectContaining({ writer, premiumUsdg: 274n })]);
    await handler!(input);
    expect(state.rows(schema.v2WriterSeriesPremium)[0]?.premiumUsdg).toBe(274n);
  });
});
