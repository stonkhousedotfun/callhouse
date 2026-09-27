import { beforeAll, describe, expect, it, vi } from "vitest";

// The calendar's fail-closed switch is re-derived from its construction events, through
// the handlers Ponder actually registers (adminConfig.ts AuthorityUpdated, periphery.ts HolidaySet).
type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
});

vi.mock("../../lib/registry", () => ({
  v2CalendarPonder: registry,
  v2ChainlinkSourcePonder: registry,
  v2DataStreamsSourcePonder: registry,
  v2EarnVaultPonder: registry,
  v2FeeSplitterPonder: registry,
  v2HouseVaultEventsPonder: registry,
  v2HouseVaultKindedFactoryPonder: registry,
  v2HouseVaultPonder: registry,
  v2MakerVaultPonder: registry,
  v2PayoutRouterPonder: registry,
  v2Ponder: registry,
  v2RewardsDistributorPonder: registry,
  v2RewardsPonder: registry,
  v2UniV3SourcePonder: registry,
}));
vi.mock("ponder:schema", () => ({ default: new Proxy({}, { get: (_target, name) => name }) }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const keyOf = (row: any) => String(row.id ?? row.dayIndex);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    insert: (name: string) => ({ values: (row: any) => ({
      onConflictDoUpdate: async (values: any) => {
        const id = keyOf(row);
        table(name).set(id, { ...(table(name).get(id) ?? row), ...values });
      },
      onConflictDoNothing: async () => {
        if (!table(name).has(keyOf(row))) table(name).set(keyOf(row), row);
      },
    }) }),
    update: (name: string, key: any) => ({ set: async (values: any) => {
      table(name).set(keyOf(key), { ...table(name).get(keyOf(key)), ...values });
    } }),
  };
}

const CALENDAR = "0x00000000000000000000000000000000000000ca";
const MANAGER = "0x00000000000000000000000000000000000000a0";
const CREATE_TX = `0x${"c".repeat(64)}`;
const LATER_TX = `0x${"d".repeat(64)}`;
let logIndex = 0;
const event = (args: object, tx: string) => ({
  args,
  block: { timestamp: 1_000n, number: 10n },
  transaction: { hash: tx },
  log: { logIndex: logIndex++, address: CALENDAR },
});

async function fire(db: ReturnType<typeof memoryDb>, name: string, args: object, tx: string) {
  const handler = handlers.get(`ExpiryCalendar:${name}`);
  if (handler === undefined) throw new Error(`no ExpiryCalendar:${name} handler`);
  await handler({ event: event(args, tx), context: { db } });
}

const mode = (db: ReturnType<typeof memoryDb>) => db.rows.get("v2CalendarMode")?.get("expirycalendar");

beforeAll(async () => {
  await import("./adminConfig");
  await import("./periphery");
});

describe("ExpiryCalendar fail-closed switch from events", () => {
  it("is on when the constructor set closures in the creation transaction", async () => {
    const db = memoryDb();
    await fire(db, "AuthorityUpdated", { authority: MANAGER }, CREATE_TX);
    await fire(db, "HolidaySet", { dayIndex: 20_454, isHoliday: true }, CREATE_TX);
    await fire(db, "HolidaySet", { dayIndex: 20_502, isHoliday: true }, CREATE_TX);
    expect(mode(db)).toMatchObject({ contract: CALENDAR, constructionTx: CREATE_TX, unseededYearsClosed: true });
    // The switch is immutable on chain: clearing every closure later does not turn it off.
    await fire(db, "HolidaySet", { dayIndex: 20_454, isHoliday: false }, LATER_TX);
    await fire(db, "HolidaySet", { dayIndex: 20_502, isHoliday: false }, LATER_TX);
    expect(mode(db)?.unseededYearsClosed).toBe(true);
  });

  it("stays off for a constructor given no closures, whatever setHolidays does later", async () => {
    const db = memoryDb();
    await fire(db, "AuthorityUpdated", { authority: MANAGER }, CREATE_TX);
    expect(mode(db)).toMatchObject({ constructionTx: CREATE_TX, unseededYearsClosed: false });
    await fire(db, "HolidaySet", { dayIndex: 20_454, isHoliday: true }, LATER_TX);
    expect(mode(db)?.unseededYearsClosed).toBe(false);
  });

  it("is not turned on by a later re-point batched with setHolidays in one transaction", async () => {
    const db = memoryDb();
    await fire(db, "AuthorityUpdated", { authority: MANAGER }, CREATE_TX);
    await fire(db, "AuthorityUpdated", { authority: CALENDAR }, LATER_TX);
    await fire(db, "HolidaySet", { dayIndex: 20_454, isHoliday: true }, LATER_TX);
    expect(mode(db)).toMatchObject({ constructionTx: CREATE_TX, unseededYearsClosed: false });
    // The authority row itself does follow the re-point; only the mode row is first-seen.
    expect(db.rows.get("v2ContractAuthority")?.get("expirycalendar")?.updatedTx).toBe(LATER_TX);
  });
});
