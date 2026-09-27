/**
 * When a SettlementOracle verdict changes a series' status, replayed through the real handlers
 * (src/v2/oracle.ts and the V2Clock sweep in src/v2/clock.ts).
 *
 * SettlementOracle.veto is "allowed at any time before finalization, including before expiry (a pre-emptive veto)",
 * and unveto has no time check. Nothing that mints or trades reads settlement status (OrderBook._place/_plan,
 * Clearinghouse.mint, SettlementOracle.pin), so the series keeps trading until its cutoff and expiry. The verdict
 * takes effect from expiry on: at once for a later oracle event, at the first clock tick past expiry for an earlier one.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
});

vi.mock("../../lib/registry", () => ({ v2Ponder: registry }));
vi.mock("../../lib/env", () => ({ V2_EARN_START_BLOCK: undefined, V2_EARN_VAULT: undefined }));
// Not this suite's subject: the clock tick's maker scoring and Earn sampling, and the PnL dirty mark.
vi.mock("./makerScoring", () => ({ scoreMakerBlock: async () => undefined }));
vi.mock("./earnSample", () => ({ sampleEarnVault: async () => undefined }));
vi.mock("./pnlInput", () => ({ markPnlInput: async () => undefined }));

/** A table is its name plus `name.column` strings, so a query condition names the column it filters on. */
const table = (name: string, columns: string[]) =>
  Object.fromEntries([["__name", name], ...columns.map((column) => [column, `${name}.${column}`])]);
vi.mock("ponder:schema", () => ({ default: {
  v2Series: table("v2Series", ["longId", "underlying", "expiry", "status", "mintCutoff"]),
  v2Order: table("v2Order", ["longId", "status"]),
  v2Settlement: table("v2Settlement", ["id", "underlying", "expiry", "status"]),
} }));
type Condition = { op: "and"; parts: Condition[] } | { op: "eq"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] };
vi.mock("ponder", () => ({
  and: (...parts: Condition[]) => ({ op: "and", parts }),
  eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
  inArray: (column: string, values: unknown[]) => ({ op: "in", column, values }),
}));

const field = (column: string) => column.slice(column.indexOf(".") + 1);
function matches(row: Record<string, unknown>, condition: Condition): boolean {
  if (condition.op === "and") return condition.parts.every((part) => matches(row, part));
  if (condition.op === "eq") return row[field(condition.column)] === condition.value;
  return condition.values.includes(row[field(condition.column)]);
}

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const tableRows = (t: { __name: string }) => {
    let value = rows.get(t.__name);
    if (value === undefined) rows.set(t.__name, value = new Map());
    return value;
  };
  const keyOf = (row: any) => String(row.longId ?? row.id);
  return {
    rows,
    find: async (t: { __name: string }, key: any) => tableRows(t).get(keyOf(key)) ?? null,
    insert: (t: { __name: string }) => ({ values: (row: any) => {
      tableRows(t).set(keyOf(row), row);
      return { then: (resolve: (value: any) => void) => resolve(row) };
    } }),
    update: (t: { __name: string }, key: any) => ({ set: async (values: any) => {
      const id = keyOf(key);
      tableRows(t).set(id, { ...tableRows(t).get(id), ...values });
    } }),
    sql: { select: () => ({ from: (t: { __name: string }) => ({
      where: async (condition: Condition) => [...tableRows(t).values()].filter((row) => matches(row, condition)),
      // The clock's open-order read. No order is seeded here, so it answers empty.
      leftJoin: () => ({ where: async () => [] }),
    }) }) },
  };
}

const UNDERLYING = "0x0000000000000000000000000000000000000011";
const EXPIRY = 10_000n;
const TX = `0x${"7".repeat(64)}`;
let logIndex = 0;
const oracleEvent = (args: object, ts: bigint) => ({
  args: { underlying: UNDERLYING, expiry: Number(EXPIRY), ...args },
  block: { timestamp: ts, number: ts },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address: "0x000000000000000000000000000000000000c013" },
});

function seeded() {
  const db = memoryDb();
  db.rows.set("v2Series", new Map([["2", {
    longId: 2n, underlying: UNDERLYING, expiry: EXPIRY, mintCutoff: EXPIRY - 1_800n, status: "open",
  }]]));
  return db;
}
const series = (db: ReturnType<typeof memoryDb>) => db.rows.get("v2Series")!.get("2");
const tick = (db: ReturnType<typeof memoryDb>, ts: bigint) =>
  handlers.get("V2Clock:block")!({ event: { block: { timestamp: ts, number: ts } }, context: { db } });
const on = (db: ReturnType<typeof memoryDb>, name: string, args: object, ts: bigint) =>
  handlers.get(`SettlementOracle:${name}`)!({ event: oracleEvent(args, ts), context: { db } });

beforeAll(async () => {
  await import("./oracle");
  await import("./clock");
});

describe("a settlement verdict takes effect from expiry, not before", () => {
  it("a pre-emptive veto leaves the series trading, and the first tick past expiry holds it", async () => {
    const db = seeded();
    await on(db, "SettlementVetoed", {}, 5_000n);
    expect(db.rows.get("v2Settlement")!.get(`${UNDERLYING}-${EXPIRY}`).status).toBe("Held");
    expect(series(db).status).toBe("open");
    await tick(db, EXPIRY - 1_000n);
    expect(series(db).status).toBe("cutoff");
    await tick(db, EXPIRY);
    expect(series(db).status).toBe("held");
  });

  it("a veto and unveto before expiry leave it trading, and expiry finds it settling", async () => {
    const db = seeded();
    await on(db, "SettlementVetoed", {}, 5_000n);
    await on(db, "SettlementUnvetoed", { finalizableAt: 7_000 }, 6_000n);
    expect(series(db).status).toBe("open");
    await tick(db, EXPIRY + 60n);
    expect(series(db).status).toBe("settling");
  });

  it("with no verdict, expiry is only expired", async () => {
    const db = seeded();
    await tick(db, EXPIRY);
    expect(series(db).status).toBe("expired");
  });

  it("a verdict at or after expiry applies at once, and finalization publishes the price", async () => {
    const db = seeded();
    await on(db, "SettlementVetoed", {}, EXPIRY);
    expect(series(db).status).toBe("held");
    await on(db, "SettlementResolved", { price: 215_000_000n }, EXPIRY + 700n);
    expect(series(db)).toMatchObject({ status: "settling", settlementPrice: 215_000_000n });
  });
});
