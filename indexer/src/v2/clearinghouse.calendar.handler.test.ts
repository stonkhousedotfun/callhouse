import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
});

vi.mock("../../lib/registry", () => ({ v2Ponder: registry }));
vi.mock("../../lib/env", () => ({
  USDG: "0x000000000000000000000000000000000000d001",
  V2_CLEARINGHOUSE: "0x000000000000000000000000000000000000c011",
  V2_ORDER_BOOK: "0x000000000000000000000000000000000000c012",
  V2_EXPIRY_CALENDAR: undefined,
}));
vi.mock("ponder:schema", () => ({ default: {
  v2Market: "v2Market",
  v2Series: "v2Series",
  v2SpecialExpiry: "v2SpecialExpiry",
  v2CalendarHoliday: "v2CalendarHoliday",
} }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const keyOf = (row: any) => String(row.longId ?? row.underlying ?? row.ts ?? row.id);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    insert: (name: string) => ({ values: async (row: any) => {
      table(name).set(keyOf(row), row);
      return row;
    } }),
    update: (name: string, key: any) => ({ set: async (values: any) => {
      const id = keyOf(key);
      const next = { ...table(name).get(id), ...values };
      table(name).set(id, next);
      return next;
    } }),
    sql: { select: () => { throw new Error("configured-calendar branch was not expected"); } },
  };
}

const CLEARINGHOUSE = "0x000000000000000000000000000000000000c011";
const UNDERLYING = "0x0000000000000000000000000000000000000011";
const ORACLE = "0x0000000000000000000000000000000000000022";
const CALENDAR_A = "0x00000000000000000000000000000000000000a1";
const CALENDAR_B = "0x00000000000000000000000000000000000000b2";
const tx = `0x${"d".repeat(64)}`;
let logIndex = 0;
const event = (args: object, block: bigint) => ({
  args,
  block: { timestamp: block * 10n, number: block },
  transaction: { hash: tx },
  log: { logIndex: logIndex++, address: CLEARINGHOUSE },
});

beforeAll(async () => { await import("./clearinghouse"); });

describe("Clearinghouse calendar fallback", () => {
  it("keeps an old series on its event-block calendar after the pointer moves", async () => {
    const db = memoryDb();
    const calendarReads: Array<bigint | undefined> = [];
    const context = { db, client: { readContract: async (input: any) => {
      if (input.functionName === "symbol") return "TEST";
      if (input.functionName === "calendar") {
        calendarReads.push(input.blockNumber);
        // Calendar A was live through block 199; B is the later/latest pointer.
        return input.blockNumber !== undefined && input.blockNumber < 200n ? CALENDAR_A : CALENDAR_B;
      }
      if (input.functionName === "isWeekly") return input.address === CALENDAR_A;
      if (input.functionName === "mintCutoff") return Number(input.args[0]) + 1_000;
      throw new Error(`unexpected read ${input.functionName}`);
    } } };
    const config = { enabled: true, mintPaused: false, strikeTick: 1n,
      exerciseFeeBps: 25, mintFeePpm: 80, oracle: ORACLE };
    await handlers.get("Clearinghouse:MarketRegistered")!({
      event: event({ underlying: UNDERLYING, config }, 90n), context,
    });
    for (const [longId, block] of [[2n, 100n], [4n, 201n]] as const) {
      await handlers.get("Clearinghouse:SeriesCreated")!({
        event: event({ longId, underlying: UNDERLYING, isPut: false, strike: 200n,
          expiry: 1_800_000, oracle: ORACLE, exerciseFeeBps: 25, mintFeePpm: 80 }, block),
        context,
      });
    }

    expect(db.rows.get("v2Series")?.get("2").tenor).toBe("weekly");
    expect(db.rows.get("v2Series")?.get("4").tenor).toBe("daily");
    expect(calendarReads).toEqual([100n, 201n]);
  });
});
