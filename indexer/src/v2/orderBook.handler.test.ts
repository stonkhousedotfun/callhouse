/**
 * src/v2/orderBook.ts handlers beyond the placement/fill paths x8CoreHandlers and orderBookFees cover: the gap checks
 * that halt indexing (unknown series/order/market, an inconsistent fill), taker volume and fees, delegate approvals,
 * fee parameters and the trading pause, plus fill accounting into series and market totals.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry, recordHouseFills } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
    recordHouseFills: vi.fn(async () => undefined),
  };
});

vi.mock("../../lib/registry", () => ({ v2Ponder: registry }));
// House fill rows are lib/v2/houseVault.ts's subject; here only that every fill is offered to it.
vi.mock("./houseVault", () => ({ recordHouseFills }));
vi.mock("ponder:schema", () => ({ default: new Proxy({}, { get: (_target, name) => name }) }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const keyOf = (row: any) => String(row.id ?? row.orderId ?? row.longId ?? row.account ?? row.maker ?? row.underlying);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    insert: (name: string) => ({ values: (row: any) => {
      const id = keyOf(row);
      const previous = table(name).get(id);
      if (previous === undefined) table(name).set(id, row);
      return {
        then: (resolve: (value: unknown) => void) => resolve(row),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(id, previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
    update: (name: string, key: any) => ({ set: async (values: any) => {
      table(name).set(keyOf(key), { ...table(name).get(keyOf(key)), ...values });
    } }),
    sql: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) },
  };
}

const BOOK = "0x000000000000000000000000000000000000c012";
const MAKER = "0x00000000000000000000000000000000000000Aa";
const TAKER = "0x00000000000000000000000000000000000000Bb";
const UNDERLYING = "0x00000000000000000000000000000000000000cc";
const TX = `0x${"f".repeat(64)}`;
let logIndex = 0;
const event = (args: object, block = 300n) => ({
  args,
  block: { timestamp: 1_000n + block, number: block },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address: BOOK },
});
const fire = (db: ReturnType<typeof memoryDb>, name: string, args: object, block?: bigint) =>
  handlers.get(`OrderBook:${name}`)!({ event: event(args, block), context: { db } });

function seeded() {
  const db = memoryDb();
  db.rows.set("v2Series", new Map([["2", {
    longId: 2n, underlying: UNDERLYING, mintCutoff: 5_000n, expiry: 6_000n,
    volumeUnits: 0n, volumeUsdg: 0n, lastPrice: null,
  }]]));
  db.rows.set("v2Market", new Map([[UNDERLYING, {
    underlying: UNDERLYING, volumeUnits: 0n, volumeUsdg: 0n, premiumUsdg: 0n, feesUsdg: 0n, lastBlock: 0n, lastTimestamp: 0n,
  }]]));
  return db;
}
const place = (db: ReturnType<typeof memoryDb>, orderId: bigint, units = 10n, kind = 2) =>
  fire(db, "OrderPlaced", { orderId, maker: MAKER, longId: 2n, kind, price: 1_500_000n, units, validUntil: 0 });
const fill = (orderId: bigint, units: bigint, extra: object = {}) => ({
  orderId, longId: 2n, taker: TAKER, maker: MAKER, units, price: 1_500_000n, premium: units * 1_500_000n,
  sellerFee: 75_000n, makerRebate: 5_000n, primary: true, takerIsBuyer: true, recipient: TAKER, ...extra,
});

beforeAll(async () => {
  await import("./orderBook");
});
beforeEach(() => recordHouseFills.mockClear());

describe("OrderBook gap checks halt instead of indexing a partial history", () => {
  it("refuses an order for an unknown series, and delegate marks or cancels for an unknown order", async () => {
    const db = memoryDb();
    await expect(fire(db, "OrderPlaced", { orderId: 1n, maker: MAKER, longId: 9n, kind: 0, price: 1n, units: 1n, validUntil: 0 }))
      .rejects.toThrow("Order 1: unknown series 9");
    await expect(fire(db, "OrderPlacedBy", { orderId: 1n, placer: TAKER })).rejects.toThrow("OrderPlacedBy 1: unknown order");
    await expect(fire(db, "OrderCancelled", { orderId: 1n, unitsRemaining: 1n, pruned: false }))
      .rejects.toThrow("OrderCancelled 1: unknown order");
  });

  it("refuses a fill whose order is missing or disagrees on series or maker", async () => {
    const db = seeded();
    await expect(fire(db, "OrderFilled", fill(1n, 1n))).rejects.toThrow("OrderFilled 1: missing or inconsistent order");
    await place(db, 1n);
    await expect(fire(db, "OrderFilled", fill(1n, 1n, { longId: 4n }))).rejects.toThrow("inconsistent order");
    await expect(fire(db, "OrderFilled", fill(1n, 1n, { maker: TAKER }))).rejects.toThrow("inconsistent order");
    // A maker that differs only in case is the same maker.
    await fire(db, "OrderFilled", fill(1n, 1n, { maker: MAKER.toLowerCase() }));
    expect(db.rows.get("v2Order")!.get("1").filled).toBe(1n);
  });

  it("refuses a fill or take whose series or market is not indexed", async () => {
    const db = seeded();
    await place(db, 1n);
    db.rows.get("v2Market")!.clear();
    await expect(fire(db, "OrderFilled", fill(1n, 1n))).rejects.toThrow(`unknown market ${UNDERLYING}`);
    await expect(fire(db, "Taken", { taker: TAKER, longId: 2n, buying: true, units: 1n, premium: 1n, takerFee: 1n }))
      .rejects.toThrow(`Taken: unknown market ${UNDERLYING}`);
    db.rows.get("v2Series")!.clear();
    await expect(fire(db, "Taken", { taker: TAKER, longId: 2n, buying: true, units: 1n, premium: 1n, takerFee: 1n }))
      .rejects.toThrow("Taken: unknown series 2");
  });
});

describe("fills and takes", () => {
  it("places a writing ask valid to the mint cutoff, fills it in parts and rolls up series and market totals", async () => {
    const db = seeded();
    await place(db, 1n, 10n);
    expect(db.rows.get("v2Order")!.get("1")).toMatchObject({ kind: "AskWrite", validUntil: 5_000n, status: "open", placedBy: null });
    await fire(db, "OrderPlacedBy", { orderId: 1n, placer: TAKER }, 301n);
    expect(db.rows.get("v2Order")!.get("1")).toMatchObject({ placedBy: TAKER, updatedAt: 1_301n });

    await fire(db, "OrderFilled", fill(1n, 4n), 310n);
    await fire(db, "OrderFilled", fill(1n, 6n, { primary: false, takerIsBuyer: false }), 311n);
    expect(db.rows.get("v2Order")!.get("1")).toMatchObject({ filled: 10n, status: "filled" });
    const fills = [...db.rows.get("v2Fill")!.values()];
    expect(fills.map((f) => [f.buyer, f.seller])).toEqual([[TAKER, MAKER], [MAKER, TAKER]]);
    expect(db.rows.get("v2Series")!.get("2")).toMatchObject({ volumeUnits: 10n, volumeUsdg: 15_000_000n, lastPrice: 1_500_000n });
    expect(db.rows.get("v2Market")!.get(UNDERLYING)).toMatchObject({
      volumeUnits: 10n, volumeUsdg: 15_000_000n,
      premiumUsdg: 6_000_000n, // only the primary fill is premium
      feesUsdg: 2n * (75_000n - 5_000n), // seller fee net of maker rebate
      lastBlock: 311n, lastTimestamp: 1_311n,
    });
    expect(recordHouseFills).toHaveBeenCalledTimes(2);
    expect(db.rows.get("v2PnlInput")!.get("global")).toMatchObject({ block: 311n });
    await expect(fire(db, "OrderFilled", fill(1n, 1n))).rejects.toThrow("Cannot fill filled order");
  });

  it("records a take and adds its taker fee to the market's fees", async () => {
    const db = seeded();
    await fire(db, "Taken", { taker: TAKER, longId: 2n, buying: false, units: 3n, premium: 4_500_000n, takerFee: 100_000n }, 320n);
    expect([...db.rows.get("v2Take")!.values()]).toEqual([expect.objectContaining({
      taker: TAKER, longId: 2n, buying: false, units: 3n, premium: 4_500_000n, takerFee: 100_000n, block: 320n,
    })]);
    expect(db.rows.get("v2Market")!.get(UNDERLYING)).toMatchObject({ feesUsdg: 100_000n, volumeUsdg: 0n, lastBlock: 320n });
    expect(db.rows.get("v2PnlInput")!.get("global")).toMatchObject({ block: 320n });
  });

  it("cancels or prunes only with the right remaining units, recording cancel provenance", async () => {
    const db = seeded();
    await place(db, 1n, 5n, 0);
    await expect(fire(db, "OrderCancelled", { orderId: 1n, unitsRemaining: 4n, pruned: false })).rejects.toThrow("mismatch");
    await fire(db, "OrderCancelled", { orderId: 1n, unitsRemaining: 5n, pruned: true }, 330n);
    expect(db.rows.get("v2Order")!.get("1")).toMatchObject({ kind: "Bid", validUntil: 6_000n, status: "pruned", cancelledTx: TX });
  });
});

describe("book settings", () => {
  it("creates an account on the first delegate approval and keeps delegates sorted and lower-cased", async () => {
    const db = memoryDb();
    const d1 = "0x00000000000000000000000000000000000000D2";
    const d2 = "0x00000000000000000000000000000000000000D1";
    await fire(db, "DelegateSet", { maker: MAKER, delegate: d1, approved: true }, 340n);
    await fire(db, "DelegateSet", { maker: MAKER, delegate: d2, approved: true }, 341n);
    expect(db.rows.get("v2Account")!.get(MAKER)).toMatchObject({
      delegates: JSON.stringify({ [d2.toLowerCase()]: true, [d1.toLowerCase()]: true }),
      firstSeen: 1_340n, lastSeen: 1_341n,
    });
    await fire(db, "DelegateSet", { maker: MAKER, delegate: d1, approved: false }, 342n);
    expect(db.rows.get("v2Account")!.get(MAKER).delegates).toBe(JSON.stringify({ [d2.toLowerCase()]: true }));
  });

  it("stores fee parameters as numbers and bigint per book, and toggles the trading pause without losing them", async () => {
    const db = memoryDb();
    await fire(db, "FeeParamsSet", { params: {
      premiumFeeBps: 500n, resaleFeeBps: 25, takerFeeFlat: 100_000, takerFeeCapBps: 1_000n, makerRebateBps: 5_000,
    } }, 350n);
    await fire(db, "TradingPausedSet", { paused: true }, 351n);
    await fire(db, "DiscountModuleSet", { module: "0x0000000000000000000000000000000000000000" }, 352n);
    expect(db.rows.get("v2OrderBookState")!.get(BOOK)).toEqual({
      id: BOOK, premiumFeeBps: 500, resaleFeeBps: 25, takerFeeFlat: 100_000n, takerFeeCapBps: 1_000,
      makerRebateBps: 5_000, tradingPaused: true, discountModule: null, updatedAt: 1_352n,
    });
    await fire(db, "TradingPausedSet", { paused: false }, 353n);
    expect(db.rows.get("v2OrderBookState")!.get(BOOK)).toMatchObject({ tradingPaused: false, premiumFeeBps: 500 });
  });

  it("refuses FundingSet for a maker the index never saw allowed", async () => {
    const db = memoryDb();
    await expect(fire(db, "FundingSet", { maker: MAKER, on: true }, 360n))
      .rejects.toThrow(`FundingSet for disallowed maker ${MAKER.toLowerCase()} at block 360`);
    await fire(db, "FundingAllowedSet", { maker: MAKER, allowed: false });
    await expect(fire(db, "FundingSet", { maker: MAKER, on: true })).rejects.toThrow("disallowed maker");
  });
});
