/**
 * The SettlementOracle handlers (src/v2/oracle.ts) through the real registered functions: the source tape, the
 * candidate, the finalized/resolved verdicts with their log position and the series' settlement price, the PnL dirty
 * mark, and MarketSourcesSet's market cursor. derivedStates.handler.test.ts covers veto/unveto timing.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { emptySettlement } from "../../lib/v2/oracle";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
});

vi.mock("../../lib/registry", () => ({ v2Ponder: registry }));

const table = (name: string, columns: string[]) =>
  Object.fromEntries([["__name", name], ...columns.map((column) => [column, `${name}.${column}`])]);
vi.mock("ponder:schema", () => ({ default: {
  v2Series: table("v2Series", ["longId", "underlying", "expiry", "status"]),
  v2Settlement: table("v2Settlement", ["id"]),
  v2Market: table("v2Market", ["underlying"]),
  v2PnlInput: table("v2PnlInput", ["id"]),
} }));
type Condition = { op: "and"; parts: Condition[] } | { op: "eq"; column: string; value: unknown };
vi.mock("ponder", () => ({
  and: (...parts: Condition[]) => ({ op: "and", parts }),
  eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
}));

const field = (column: string) => column.slice(column.indexOf(".") + 1);
const matches = (row: Record<string, unknown>, c: Condition): boolean =>
  c.op === "and" ? c.parts.every((part) => matches(row, part)) : row[field(c.column)] === c.value;

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const tableRows = (t: { __name: string }) => {
    let value = rows.get(t.__name);
    if (value === undefined) rows.set(t.__name, value = new Map());
    return value;
  };
  const keyOf = (row: any) => String(row.longId ?? row.id ?? row.underlying);
  return {
    rows,
    find: async (t: { __name: string }, key: any) => tableRows(t).get(keyOf(key)) ?? null,
    insert: (t: { __name: string }) => ({ values: (input: any) => {
      // Postgres fills the settlement row's column defaults (ponder.schema.ts), which are emptySettlement()'s.
      const row = t.__name === "v2Settlement" ? { ...emptySettlement(), ...input } : input;
      tableRows(t).set(keyOf(row), row);
      return { then: (resolve: (value: any) => void) => resolve(row) };
    } }),
    update: (t: { __name: string }, key: any) => ({ set: async (values: any) => {
      const id = keyOf(key);
      tableRows(t).set(id, { ...tableRows(t).get(id), ...values });
    } }),
    sql: { select: () => ({ from: (t: { __name: string }) => ({
      where: async (condition: Condition) => [...tableRows(t).values()].filter((row) => matches(row, condition)),
    }) }) },
  };
}

const UNDERLYING = "0x00000000000000000000000000000000000000Aa";
const KEY = UNDERLYING.toLowerCase();
const EXPIRY = 10_000n;
const TX = `0x${"7".repeat(64)}`;
const SETTLEMENT = `${KEY}-${EXPIRY}`;
let logIndex = 0;
const oracleEvent = (args: object, ts: bigint, block = ts) => ({
  // The event carries the checksummed underlying and a uint40 expiry as a number.
  args: { underlying: UNDERLYING, expiry: Number(EXPIRY), ...args },
  block: { timestamp: ts, number: block },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address: "0x000000000000000000000000000000000000c013" },
});
const on = (db: ReturnType<typeof memoryDb>, name: string, args: object, ts: bigint, block?: bigint) =>
  handlers.get(`SettlementOracle:${name}`)!({ event: oracleEvent(args, ts, block), context: { db } });

function seeded() {
  const db = memoryDb();
  db.rows.set("v2Series", new Map([
    ["2", { longId: 2n, underlying: KEY, expiry: EXPIRY, status: "expired" }],
    ["4", { longId: 4n, underlying: KEY, expiry: EXPIRY, status: "settled" }],
    // Another expiry of the same underlying: never touched by this settlement.
    ["6", { longId: 6n, underlying: KEY, expiry: EXPIRY + 86_400n, status: "open" }],
  ]));
  return db;
}
const settlement = (db: ReturnType<typeof memoryDb>) => db.rows.get("v2Settlement")!.get(SETTLEMENT);
const series = (db: ReturnType<typeof memoryDb>, id: string) => db.rows.get("v2Series")!.get(id);

beforeAll(async () => {
  await import("./oracle");
});

describe("SettlementOracle handlers", () => {
  it("registers every oracle event", () => {
    for (const name of [
      "SourceRecorded", "SettlementCandidate", "SettlementFinalized", "SettlementResolved",
      "SettlementVetoed", "SettlementUnvetoed", "MarketSourcesSet",
    ]) expect(handlers.has(`SettlementOracle:${name}`), name).toBe(true);
  });

  it("records sources on a lower-cased settlement row without touching series or the PnL mark", async () => {
    const db = seeded();
    await on(db, "SourceRecorded", { sourceIndex: 0, ok: true, price: 180_500_000n }, 10_010n);
    await on(db, "SourceRecorded", { sourceIndex: 1, ok: false, price: 0n }, 10_020n);
    expect(settlement(db)).toMatchObject({ id: SETTLEMENT, underlying: KEY, expiry: EXPIRY });
    expect(JSON.parse(settlement(db).recordedSources)).toEqual({
      0: { ok: true, price: "180500000", recordedAt: "10010" },
      1: { ok: false, price: "0", recordedAt: "10020" },
    });
    expect(settlement(db).finalizedBlock).toBeUndefined();
    expect(series(db, "2").status).toBe("expired");
    expect(db.rows.get("v2PnlInput")).toBeUndefined();
  });

  it("a candidate after expiry puts the expiry's open series into settling and marks PnL dirty", async () => {
    const db = seeded();
    await on(db, "SettlementCandidate", {
      price: 181_000_000n, sourceIndex: 1, disagreed: true, finalizableAt: 13_600,
    }, 10_050n, 777n);
    expect(settlement(db)).toMatchObject({
      status: "Pending", candidatePrice: 181_000_000n, candidateSourceIndex: 1, candidateDisagreed: true,
      finalizableAt: 13_600n, candidateAt: 10_050n,
    });
    expect(series(db, "2")).toMatchObject({ status: "settling" });
    expect(series(db, "2").settlementPrice).toBeUndefined();
    expect(series(db, "4").status).toBe("settled"); // a settled series never goes back
    expect(series(db, "6").status).toBe("open"); // another expiry
    expect(db.rows.get("v2PnlInput")!.get("global"))
      .toMatchObject({ block: 777n });
  });

  it("finalization stores price, provenance and log position, and prices the series", async () => {
    const db = seeded();
    await on(db, "SettlementCandidate", { price: 1n, sourceIndex: 0, disagreed: false, finalizableAt: 10_100 }, 10_050n);
    await on(db, "SettlementFinalized", { price: 182_000_000n, sourceIndex: 2, corroborated: true }, 10_200n, 900n);
    expect(settlement(db)).toMatchObject({
      status: "Finalized", price: 182_000_000n, sourceIndex: 2, corroborated: true,
      candidatePrice: null, finalizedAt: 10_200n, finalizedTx: TX, finalizedBlock: 900n,
    });
    expect(typeof settlement(db).finalizedLogIndex).toBe("number");
    expect(series(db, "2")).toMatchObject({ status: "settling", settlementPrice: 182_000_000n });
    expect(series(db, "4")).toMatchObject({ status: "settled", settlementPrice: 182_000_000n });
    expect(series(db, "6").settlementPrice).toBeUndefined();
    expect(db.rows.get("v2PnlInput")!.get("global")).toMatchObject({ block: 900n });
  });

  it("a governance resolution after a veto finalizes with no source or corroboration", async () => {
    const db = seeded();
    await on(db, "SettlementVetoed", {}, 10_100n);
    expect(series(db, "2").status).toBe("held");
    await on(db, "SettlementUnvetoed", { finalizableAt: 20_000 }, 10_150n);
    expect(settlement(db)).toMatchObject({ status: "Pending", finalizableAt: 20_000n, heldAt: null });
    expect(series(db, "2").status).toBe("settling");
    await on(db, "SettlementVetoed", {}, 10_160n);
    await on(db, "SettlementResolved", { price: 179_000_000n }, 10_300n, 950n);
    expect(settlement(db)).toMatchObject({
      status: "Finalized", price: 179_000_000n, sourceIndex: null, corroborated: null, heldAt: null,
      finalizedBlock: 950n,
    });
    expect(series(db, "2")).toMatchObject({ status: "settling", settlementPrice: 179_000_000n });
  });

  it("MarketSourcesSet advances a known market's cursor and ignores an unknown one", async () => {
    const db = seeded();
    db.rows.set("v2Market", new Map([[KEY, { underlying: KEY, lastBlock: 1n, lastTimestamp: 1n }]]));
    await on(db, "MarketSourcesSet", {}, 12_000n, 1_234n);
    expect(db.rows.get("v2Market")!.get(KEY)).toEqual({ underlying: KEY, lastBlock: 1_234n, lastTimestamp: 12_000n });

    const empty = memoryDb();
    await on(empty, "MarketSourcesSet", {}, 12_000n);
    expect(empty.rows.get("v2Market")?.size ?? 0).toBe(0);
    expect(empty.rows.get("v2Settlement")).toBeUndefined();
  });
});
