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
  // Inert, as lib/registry.ts exports it when no HouseVaultFactory is configured: the house-vault
  // handlers these modules pull in are not this suite's subject.
  v2HouseVaultPonder: { on: () => undefined },
  // The vault-event and kinded-factory gates, inert here for the same reason.
  v2HouseVaultEventsPonder: { on: () => undefined },
  v2HouseVaultKindedFactoryPonder: { on: () => undefined },
  v2MakerVaultPonder: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
  v2RewardsDistributorPonder: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
  v2RewardsPonder: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
}));

vi.mock("ponder:schema", () => ({
  default: {
    v2ProtocolState: "v2ProtocolState", v2Minter: "v2Minter", v2OrderBookState: "v2OrderBookState",
    v2FundingSource: "v2FundingSource", v2FundingAttempt: "v2FundingAttempt",
    v2Order: "v2Order", v2Series: "v2Series", v2OwedCredit: "v2OwedCredit", v2OwedClaim: "v2OwedClaim",
    v2OracleExpiryConfig: "v2OracleExpiryConfig", v2OraclePinConfirm: "v2OraclePinConfirm",
    v2OracleMarketConfig: "v2OracleMarketConfig",
  },
}));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const rowKey = (row: any) => String(row.id ?? row.orderId ?? row.minter ?? row.maker ?? row.longId ?? row.underlying);
  const lookupKey = (key: any) => String(key.id ?? key.orderId ?? key.minter ?? key.maker ?? key.longId ?? key.underlying);
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
    // OrderPlaced's replace lookup. Every row of the table comes back, with the unset nullable columns null as
    // Postgres returns them (ponder.schema.ts v2Order); replacementPredecessor applies the same maker / series /
    // cancel-tx / log-order filters the SQL does, so the result is the same.
    sql: { select: () => ({ from: (name: string) => ({ where: () => ({ orderBy: () => ({
      limit: async () => [...table(name).values()].map((row) => ({
        cancelledTx: null, cancelledLogIndex: null, replacedBy: null, ...row,
      })),
    }) }) }) }) },
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
  await import("./stateFacts");
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

  /**
   * replace() (OrderBook.sol:364-407) emits OrderCancelled(old), OrderPlaced(new) and, for a
   * delegate-placed AskWrite, OrderPlacedBy(new, placer) in one transaction. The new order gets its placer from
   * that log, not by copying the predecessor's column.
   */
  it("OrderPlacedBy sets placedBy on that order id, including the order a replace creates", async () => {
    const db = memoryDb();
    const maker = "0x00000000000000000000000000000000000000aa";
    const placer = "0x00000000000000000000000000000000000000bb";
    const longId = 7n;
    db.rows.set("v2Series", new Map([[String(longId), {
      longId, mintCutoff: 2_000n, expiry: 3_000n,
    }]]));
    const place = (orderId: bigint) => handlers.get("OrderBook:OrderPlaced")!({
      event: event({ orderId, maker, longId, kind: 2, price: 10n, units: 1n, validUntil: 0n }),
      context: { db },
    });
    await place(1n);
    expect(db.rows.get("v2Order")?.get("1").placedBy).toBeNull();
    await handlers.get("OrderBook:OrderPlacedBy")!({
      event: event({ orderId: 1n, placer }), context: { db },
    });
    expect(db.rows.get("v2Order")?.get("1").placedBy).toBe(placer);

    await handlers.get("OrderBook:OrderCancelled")!({
      event: event({ orderId: 1n, unitsRemaining: 1n, pruned: false }), context: { db },
    });
    await place(2n);
    expect(db.rows.get("v2Order")?.get("1")).toMatchObject({ status: "cancelled", replacedBy: 2n });
    expect(db.rows.get("v2Order")?.get("2").placedBy).toBeNull();
    await handlers.get("OrderBook:OrderPlacedBy")!({
      event: event({ orderId: 2n, placer }), context: { db },
    });
    expect(db.rows.get("v2Order")?.get("2").placedBy).toBe(placer);
    expect(db.rows.get("v2Order")?.get("1").placedBy).toBe(placer);
  });

  /** OrderPlaced always comes first in the same transaction, so an unknown id is an ingest fault. */
  it("OrderPlacedBy for an order the indexer never saw placed throws instead of dropping the placer", async () => {
    const db = memoryDb();
    await expect(handlers.get("OrderBook:OrderPlacedBy")!({
      event: event({ orderId: 99n, placer: "0x00000000000000000000000000000000000000bb" }), context: { db },
    })).rejects.toThrow("OrderPlacedBy 99: unknown order");
    expect(db.rows.get("v2Order")?.get("99")).toBeUndefined();
  });

  it("OwedCredited writes a credit row, and SettlementPinConfirmed stores the new pinner", async () => {
    const db = memoryDb();
    const account = "0x00000000000000000000000000000000000000cc";
    await handlers.get("OrderBook:OwedCredited")!({
      event: event({ account, amount: 40n }), context: { db },
    });
    expect([...(db.rows.get("v2OwedCredit")?.values() ?? [])][0]).toMatchObject({ account, amount: 40n });
    const underlying = "0x00000000000000000000000000000000000000d1";
    const previousPinner = "0x00000000000000000000000000000000000000d2";
    const pinner = "0x00000000000000000000000000000000000000d3";
    const id = `${underlying}-100`;
    db.rows.set("v2OracleExpiryConfig", new Map([[id, { id, underlying, expiry: 100n }]]));
    await handlers.get("SettlementOracle:SettlementPinConfirmed")!({
      event: event({ underlying, expiry: 100, previousPinner, pinner }), context: { db },
    });
    expect(db.rows.get("v2OracleExpiryConfig")?.get(id)).toMatchObject({
      pinner, previousPinner,
    });
    expect([...(db.rows.get("v2OraclePinConfirm")?.values() ?? [])][0]).toMatchObject({
      underlying, expiry: 100n, pinner, previousPinner,
    });
  });

  /**
   * An indexer that started between the pin and its confirmation has no pin row. The confirm row is
   * still stored and no half-filled pin row is made up (a real Ponder update of a missing row throws; this memory
   * db would create one, which is what the last assertion catches).
   */
  it("SettlementPinConfirmed with no pin row stores the confirm row and creates no pin row", async () => {
    const db = memoryDb();
    const underlying = "0x00000000000000000000000000000000000000e1";
    const previousPinner = "0x00000000000000000000000000000000000000e2";
    const pinner = "0x00000000000000000000000000000000000000e3";
    await handlers.get("SettlementOracle:SettlementPinConfirmed")!({
      event: event({ underlying, expiry: 200, previousPinner, pinner }), context: { db },
    });
    expect([...(db.rows.get("v2OraclePinConfirm")?.values() ?? [])]).toEqual([
      expect.objectContaining({ underlying, expiry: 200n, pinner, previousPinner }),
    ]);
    expect(db.rows.get("v2OracleExpiryConfig")?.get(`${underlying}-200`)).toBeUndefined();
  });
});
