/**
 * The optional periphery handlers (src/v2/periphery.ts) through the registered functions: ExpiryCalendar holiday and
 * special-expiry upserts (each clears the weekly-expiry cache), KeeperRewards bounty upserts, and reward rows with
 * their per-keeper-per-action running totals.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry, clearCalendarCache } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
    clearCalendarCache: vi.fn(),
  };
});

vi.mock("../../lib/registry", () => ({ v2CalendarPonder: registry, v2RewardsPonder: registry }));
vi.mock("../../lib/v2/calendarCache", () => ({ clearCalendarCache }));
vi.mock("ponder:schema", () => ({ default: new Proxy({}, { get: (_target, name) => name }) }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const keyOf = (row: any) => String(row.id ?? row.dayIndex ?? row.ts ?? row.action);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    insert: (name: string) => ({ values: (row: any) => {
      const id = keyOf(row);
      const previous = table(name).get(id);
      const write = () => { if (previous === undefined) table(name).set(id, row); };
      return {
        then: (resolve: (value: any) => void) => { write(); resolve(row); },
        onConflictDoUpdate: async (values: any) => {
          table(name).set(id, previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
    update: (name: string, key: any) => ({ set: async (values: any) => {
      table(name).set(keyOf(key), { ...table(name).get(keyOf(key)), ...values });
    } }),
  };
}

let logIndex = 0;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const event = (args: object, block: bigint, hash = tx(block === 0n ? 1 : Number(block))) => ({
  args,
  block: { timestamp: 1_000n + block, number: block },
  transaction: { hash },
  log: { logIndex: logIndex++, address: "0x00000000000000000000000000000000000000ca" },
});
const fire = (db: ReturnType<typeof memoryDb>, name: string, args: object, block: bigint) =>
  handlers.get(name)!({ event: event(args, block), context: { db } });

beforeAll(async () => {
  await import("./periphery");
});

describe("ExpiryCalendar handlers", () => {
  it("upserts a holiday by day index with provenance, and clears the calendar cache each time", async () => {
    const db = memoryDb();
    clearCalendarCache.mockClear();
    await fire(db, "ExpiryCalendar:HolidaySet", { dayIndex: 20_500, isHoliday: true }, 10n);
    await fire(db, "ExpiryCalendar:HolidaySet", { dayIndex: 20_500, isHoliday: false }, 11n);
    expect(clearCalendarCache).toHaveBeenCalledTimes(2);
    expect(db.rows.get("v2CalendarHoliday")!.get("20500")).toEqual({
      dayIndex: 20_500, isHoliday: false, changedAt: 1_011n, changedBlock: 11n, changedTx: tx(11),
    });
    // No calendar-mode row exists, so the fail-closed switch is not touched.
    expect(db.rows.get("v2CalendarMode")?.size ?? 0).toBe(0);
  });

  it("a holiday seeded in the calendar's construction tx closes unseeded years; a later one does not", async () => {
    const db = memoryDb();
    db.rows.set("v2CalendarMode", new Map([["expirycalendar", {
      id: "expirycalendar", unseededYearsClosed: false, constructionTx: tx(50),
    }]]));
    await fire(db, "ExpiryCalendar:HolidaySet", { dayIndex: 1, isHoliday: true }, 51n);
    expect(db.rows.get("v2CalendarMode")!.get("expirycalendar").unseededYearsClosed).toBe(false);
    await fire(db, "ExpiryCalendar:HolidaySet", { dayIndex: 2, isHoliday: true }, 50n);
    expect(db.rows.get("v2CalendarMode")!.get("expirycalendar").unseededYearsClosed).toBe(true);
  });

  it("stores a special expiry under a bigint timestamp and lets a later denial replace it", async () => {
    const db = memoryDb();
    clearCalendarCache.mockClear();
    await fire(db, "ExpiryCalendar:SpecialExpirySet", { ts: 1_790_000_000, allowed: true }, 20n);
    await fire(db, "ExpiryCalendar:SpecialExpirySet", { ts: 1_790_000_000, allowed: false }, 21n);
    const row = db.rows.get("v2SpecialExpiry")!.get("1790000000");
    expect(row).toEqual({ ts: 1_790_000_000n, allowed: false, changedAt: 1_021n, changedBlock: 21n, changedTx: tx(21) });
    expect(typeof row.ts).toBe("bigint");
    expect(clearCalendarCache).toHaveBeenCalledTimes(2);
  });
});

describe("KeeperRewards handlers", () => {
  const KEEPER = "0x00000000000000000000000000000000000000Ee";
  const SETTLE = `0x${"5".repeat(64)}`;
  const ROLL = `0x${"6".repeat(64)}`;

  it("upserts a bounty per action and refuses a negative amount", async () => {
    const db = memoryDb();
    await fire(db, "KeeperRewards:BountySet", { action: SETTLE, amount: 250_000n }, 30n);
    await fire(db, "KeeperRewards:BountySet", { action: SETTLE, amount: 100_000n }, 31n);
    expect(db.rows.get("v2KeeperBounty")!.get(SETTLE)).toMatchObject({ action: SETTLE, amount: 100_000n, changedBlock: 31n });
    await expect(fire(db, "KeeperRewards:BountySet", { action: SETTLE, amount: -1n }, 32n)).rejects.toThrow("Negative");
  });

  it("writes one reward row per log and a running total per keeper and action", async () => {
    const db = memoryDb();
    await fire(db, "KeeperRewards:Rewarded", { keeper: KEEPER, action: SETTLE, amount: 250_000n }, 40n);
    await fire(db, "KeeperRewards:Rewarded", { keeper: KEEPER, action: SETTLE, amount: 100_000n }, 41n);
    await fire(db, "KeeperRewards:Rewarded", { keeper: KEEPER, action: ROLL, amount: 0n }, 42n);
    const rewards = [...db.rows.get("v2KeeperReward")!.values()];
    expect(rewards).toHaveLength(3);
    expect(rewards[0]).toMatchObject({ keeper: KEEPER, action: SETTLE, amount: 250_000n, block: 40n, tx: tx(40), ts: 1_040n });
    expect(rewards[0].id).toBe(`${tx(40)}-${rewards[0].logIndex}`);
    const totals = db.rows.get("v2KeeperRewardTotal")!;
    expect(totals.get(`${KEEPER.toLowerCase()}-${SETTLE}`)).toMatchObject({ count: 2, amount: 350_000n });
    expect(totals.get(`${KEEPER.toLowerCase()}-${ROLL}`)).toMatchObject({ count: 1, amount: 0n, keeper: KEEPER, action: ROLL });
  });
});
