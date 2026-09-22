import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const handlers = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) {
    process.env[name] ??= "0x000000000000000000000000000000000000c012";
  }
  process.env.V2_START_BLOCK ??= "1";
  return new Map<string, Handler>();
});

vi.mock("../../lib/registry", () => ({
  v2Ponder: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
}));

vi.mock("ponder:schema", () => ({
  default: {
    v2ProtocolState: "v2ProtocolState", v2Minter: "v2Minter", v2OrderBookState: "v2OrderBookState",
    v2FundingSource: "v2FundingSource", v2FundingAttempt: "v2FundingAttempt",
  },
}));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const rowKey = (row: any) => String(row.id ?? row.minter ?? row.maker ?? row.underlying);
  const lookupKey = (key: any) => String(key.id ?? key.minter ?? key.maker ?? key.underlying);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(lookupKey(key)) ?? null,
    insert: (name: string) => ({ values: (row: any) => {
      const key = rowKey(row);
      const previous = table(name).get(key);
      if (previous === undefined) table(name).set(key, row);
      return {
        then: (resolve: (value: any) => void) => resolve(row),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(key, previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
    update: (name: string, key: any) => ({ set: async (values: any) => {
      const id = lookupKey(key);
      const next = { ...table(name).get(id), ...values };
      table(name).set(id, next);
      return next;
    } }),
  };
}

const tx = `0x${"a".repeat(64)}`;
let logIndex = 0;
const event = (args: object, address = "0x000000000000000000000000000000000000c012") => ({
  args,
  block: { timestamp: 100n + BigInt(logIndex), number: 200n },
  transaction: { hash: tx },
  log: { logIndex: logIndex++, address },
});

beforeAll(async () => {
  await import("./clearinghouse");
  await import("./orderBook");
});

describe("v8 Clearinghouse and OrderBook event reducers", () => {
  it("keeps the unchanged full market handlers and registers every new event", () => {
    for (const name of [
      "Clearinghouse:MarketRegistered", "Clearinghouse:MarketConfigSet",
      "Clearinghouse:DefaultMarketFeesSet", "Clearinghouse:DefaultOracleSet", "Clearinghouse:MinterSet",
      "OrderBook:DiscountModuleSet", "OrderBook:FundingAllowedSet", "OrderBook:FundingSet",
      "OrderBook:Funded", "OrderBook:FundingFailed",
    ]) expect(handlers.has(name), name).toBe(true);
  });

  it("stores default fees, default oracle, and minter state without a chain read", async () => {
    const db = memoryDb();
    const context = { db };
    const oracle = "0x00000000000000000000000000000000000000A1";
    const minter = "0x00000000000000000000000000000000000000B2";
    await handlers.get("Clearinghouse:DefaultMarketFeesSet")!({
      event: event({ exerciseFeeBps: 31, mintFeePpm: 0 }), context,
    });
    await handlers.get("Clearinghouse:DefaultOracleSet")!({ event: event({ oracle }), context });
    await handlers.get("Clearinghouse:MinterSet")!({ event: event({ minter, allowed: true }), context });
    await handlers.get("Clearinghouse:MinterSet")!({ event: event({ minter, allowed: false }), context });
    expect(db.rows.get("v2ProtocolState")?.get("global")).toMatchObject({
      defaultExerciseFeeBps: 31, defaultMintFeePpm: 0, defaultOracle: oracle.toLowerCase(),
    });
    expect(db.rows.get("v2Minter")?.get(minter.toLowerCase())).toMatchObject({ allowed: false });
  });

  it("preserves order-book state and records successful zero delivery separately from failure", async () => {
    const db = memoryDb();
    const context = { db };
    const book = "0x000000000000000000000000000000000000c012";
    const maker = "0x00000000000000000000000000000000000000C3";
    const asset = "0x00000000000000000000000000000000000000D4";
    const module = "0x00000000000000000000000000000000000000E5";
    db.rows.set("v2OrderBookState", new Map([[book, { id: book, tradingPaused: true, premiumFeeBps: 500 }]]));

    await handlers.get("OrderBook:DiscountModuleSet")!({ event: event({ module }, book), context });
    await handlers.get("OrderBook:FundingAllowedSet")!({ event: event({ maker, allowed: true }, book), context });
    await handlers.get("OrderBook:FundingSet")!({ event: event({ maker, on: true }, book), context });
    await handlers.get("OrderBook:Funded")!({
      event: event({ maker, asset, requested: 10n, delivered: 0n }, book), context,
    });
    await handlers.get("OrderBook:FundingFailed")!({
      event: event({ maker, asset, requested: 20n }, book), context,
    });
    await handlers.get("OrderBook:FundingAllowedSet")!({ event: event({ maker, allowed: false }, book), context });
    await handlers.get("OrderBook:FundingAllowedSet")!({ event: event({ maker, allowed: true }, book), context });

    expect(db.rows.get("v2OrderBookState")?.get(book)).toMatchObject({
      tradingPaused: true, premiumFeeBps: 500, discountModule: module.toLowerCase(),
    });
    expect(db.rows.get("v2FundingSource")?.get(maker.toLowerCase())).toMatchObject({
      allowed: true, fundingOn: false,
    });
    const attempts = [...(db.rows.get("v2FundingAttempt")?.values() ?? [])];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ succeeded: true, delivered: 0n });
    expect(attempts[1]).toMatchObject({ succeeded: false, delivered: null });
  });

  it("rejects FundingSet when no allow-list event established authority", async () => {
    const db = memoryDb();
    await expect(handlers.get("OrderBook:FundingSet")!({
      event: event({ maker: "0x00000000000000000000000000000000000000F6", on: true }),
      context: { db },
    })).rejects.toThrow("disallowed maker");
  });
});
