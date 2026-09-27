/**
 * Every AuthorityUpdated and single-key *Set handler in src/v2/adminConfig.ts, table-driven through the registered
 * functions: each must land its value in the one typed column its ABI type names (valueKind says which), with the
 * other value columns null, and append exactly one change row with the log's provenance. The multi-key settings
 * (EarnVault limits, price-source feeds, pools, bands, pins) are settables/priceSources.handler.test.ts's subject.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry, recordCalendarConstruction } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
    recordCalendarConstruction: vi.fn(async () => undefined),
  };
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
vi.mock("./calendarMode", () => ({ recordCalendarConstruction }));
vi.mock("ponder:schema", () => ({ default: new Proxy({}, { get: (_target, name) => name }) }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  return {
    rows,
    insert: (name: string) => ({ values: (row: any) => {
      const previous = table(name).get(row.id);
      const conflict = () => new Error(`duplicate key ${name} ${row.id}`);
      if (previous === undefined) table(name).set(row.id, row);
      return {
        then: (resolve: (value: unknown) => void, reject: (e: unknown) => void) =>
          previous === undefined ? resolve(row) : reject(conflict()),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(row.id, previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
  };
}

const EMITTER = "0x000000000000000000000000000000000000Ab12";
const A = "0x00000000000000000000000000000000000000a1";
const TX = `0x${"4".repeat(64)}`;
let logIndex = 0;
const event = (args: object, block = 70n) => ({
  args,
  block: { timestamp: 7_000n + block, number: block },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address: EMITTER },
});

const AUTHORITY_SOURCES: Array<[event: string, source: string]> = [
  ["AutoRoller:AuthorityUpdated", "AutoRoller"],
  ["Clearinghouse:AuthorityUpdated", "Clearinghouse"],
  ["EarnVault:AuthorityUpdated", "EarnVault"],
  ["ExpiryCalendar:AuthorityUpdated", "ExpiryCalendar"],
  ["FeeSplitter:AuthorityUpdated", "FeeSplitter"],
  ["HouseVault:AuthorityUpdated", "HouseVault"],
  ["HouseVaultFactory:AuthorityUpdated", "HouseVaultFactory"],
  ["HouseVaultFactoryKinded:AuthorityUpdated", "HouseVaultFactoryKinded"],
  ["KeeperRewards:AuthorityUpdated", "KeeperRewards"],
  ["MakerRegistry:AuthorityUpdated", "MakerRegistry"],
  ["MakerVault:AuthorityUpdated", "MakerVault"],
  ["OrderBook:AuthorityUpdated", "OrderBook"],
  ["PayoutRouter:AuthorityUpdated", "PayoutRouter"],
  ["RewardsDistributor:AuthorityUpdated", "RewardsDistributor"],
  ["SettlementOracle:AuthorityUpdated", "SettlementOracle"],
  ["ChainlinkFeedSource:AuthorityUpdated", "ChainlinkFeedSource"],
  ["UniV3TwapSource:AuthorityUpdated", "UniV3TwapSource"],
  ["DataStreamsSource:AuthorityUpdated", "DataStreamsSource"],
];

type Kind = "address" | "uint" | "bool" | "text";
const SETTINGS: Array<[event: string, args: object, source: string, key: string, kind: Kind, value: unknown]> = [
  ["AutoRoller:KeeperRewardsSet", { keeperRewards: A }, "AutoRoller", "keeperRewards", "address", A],
  ["AutoRoller:MinRollUnitsSet", { units: 5 }, "AutoRoller", "minRollUnits", "uint", 5n],
  ["Clearinghouse:BaseUriSet", { baseUri: "https://meta.invalid/{id}" }, "Clearinghouse", "baseUri", "text", "https://meta.invalid/{id}"],
  ["Clearinghouse:CalendarSet", { calendar: A }, "Clearinghouse", "calendar", "address", A],
  ["Clearinghouse:KeeperRewardsSet", { keeperRewards: A }, "Clearinghouse", "keeperRewards", "address", A],
  ["Clearinghouse:MinRedeemPayoutSet", { amount: 1_000_000 }, "Clearinghouse", "minRedeemPayout", "uint", 1_000_000n],
  ["FeeSplitter:BurnBpsSet", { burnBps: 5_000 }, "FeeSplitter", "burnBps", "uint", 5_000n],
  ["FeeSplitter:BuybackCapSet", { perCallUsdg: 250_000_000n }, "FeeSplitter", "buybackCapUsdg", "uint", 250_000_000n],
  ["FeeSplitter:BuybackCapCeilingSet", { ceiling: 10n ** 12n }, "FeeSplitter", "buybackCapCeiling", "uint", 10n ** 12n],
  ["FeeSplitter:BuybackCooldownSet", { cooldown: 3_600 }, "FeeSplitter", "buybackCooldown", "uint", 3_600n],
  ["FeeSplitter:BuybackExecutorSet", { executor: A }, "FeeSplitter", "buybackExecutor", "address", A],
  ["FeeSplitter:ConversionSlippageBpsSet", { bps: 50 }, "FeeSplitter", "conversionSlippageBps", "uint", 50n],
  ["FeeSplitter:OrderBookSet", { orderBook: A }, "FeeSplitter", "orderBook", "address", A],
  ["FeeSplitter:PausedSet", { paused: true }, "FeeSplitter", "paused", "bool", true],
  ["FeeSplitter:RouterSet", { router: A }, "FeeSplitter", "router", "address", A],
  ["FeeSplitter:SettlementOracleSet", { oracle: A }, "FeeSplitter", "settlementOracle", "address", A],
  ["FeeSplitter:StonkhouseSet", { token: A }, "FeeSplitter", "stonkhouse", "address", A],
  ["FeeSplitter:TreasurySet", { treasury: A }, "FeeSplitter", "treasury", "address", A],
  ["KeeperRewards:DailyCapSet", { amount: 50_000_000n }, "KeeperRewards", "dailyCap", "uint", 50_000_000n],
  ["KeeperRewards:MaxBountySet", { amount: 2_000_000n }, "KeeperRewards", "maxBounty", "uint", 2_000_000n],
  ["KeeperRewards:TreasurySet", { treasury: A }, "KeeperRewards", "treasury", "address", A],
  ["MakerVault:TreasurySet", { treasury: A }, "MakerVault", "treasury", "address", A],
  ["OrderBook:FeeRecipientSet", { recipient: A }, "OrderBook", "feeRecipient", "address", A],
  ["OrderBook:MakerRegistrySet", { registry: A }, "OrderBook", "makerRegistry", "address", A],
  ["RewardsDistributor:TreasurySet", { treasury: A }, "RewardsDistributor", "treasury", "address", A],
  ["SettlementOracle:ClearinghouseSet", { clearinghouse: A }, "SettlementOracle", "clearinghouse", "address", A],
  ["SettlementOracle:KeeperRewardsSet", { keeperRewards: A }, "SettlementOracle", "keeperRewards", "address", A],
  ["SettlementOracle:HouseVaultFactorySet", { houseVaultFactory: A }, "SettlementOracle", "houseVaultFactory", "address", A],
  ["HouseVault:PerformanceFeeBpsSet", { bps: 1_000 }, "HouseVault", `performanceFeeBps:${EMITTER}`, "uint", 1_000n],
  ["HouseVault:OracleSet", { oracle: A }, "HouseVault", `oracle:${EMITTER}`, "address", A],
  ["ChainlinkFeedSource:OracleSet", { oracle: A, allowed: true }, "ChainlinkFeedSource", `oracle:${A}`, "bool", true],
  ["UniV3TwapSource:OracleSet", { oracle: A, allowed: false }, "UniV3TwapSource", `oracle:${A}`, "bool", false],
  ["DataStreamsSource:OracleSet", { oracle: A, allowed: true }, "DataStreamsSource", `oracle:${A}`, "bool", true],
  ["DataStreamsSource:FeedSet", { underlying: A, feedId: `0x${"ab".repeat(32)}` }, "DataStreamsSource", `feedId:${A}`, "text", `0x${"ab".repeat(32)}`],
];
const COLUMN: Record<Kind, string> = { address: "valueAddress", uint: "valueUint", bool: "valueBool", text: "valueText" };

beforeAll(async () => {
  await import("./adminConfig");
});

describe("AuthorityUpdated", () => {
  it.each(AUTHORITY_SOURCES)("%s is kept under the lower-cased source name, latest wins", async (name, source) => {
    const db = memoryDb();
    const first = "0x00000000000000000000000000000000000000f1";
    const second = "0x00000000000000000000000000000000000000f2";
    await handlers.get(name)!({ event: event({ authority: first }, 70n), context: { db } });
    await handlers.get(name)!({ event: event({ authority: second }, 71n), context: { db } });
    const rows = [...db.rows.get("v2ContractAuthority")!.values()];
    expect(rows).toEqual([expect.objectContaining({
      id: source.toLowerCase(), source, contract: EMITTER, authority: second,
      updatedAt: 7_071n, updatedBlock: 71n, updatedTx: TX,
    })]);
  });

  it("the calendar's AuthorityUpdated also feeds its construction-time fail-closed switch", async () => {
    recordCalendarConstruction.mockClear();
    const db = memoryDb();
    const input = { event: event({ authority: A }), context: { db } };
    await handlers.get("ExpiryCalendar:AuthorityUpdated")!(input);
    expect(recordCalendarConstruction).toHaveBeenCalledWith(input.context, input.event);
    await handlers.get("Clearinghouse:AuthorityUpdated")!({ event: event({ authority: A }), context: { db } });
    expect(recordCalendarConstruction).toHaveBeenCalledTimes(1);
  });
});

describe("single-key settings", () => {
  it.each(SETTINGS)("%s -> %s.%s as %s", async (name, args, source, key, kind, value) => {
    const db = memoryDb();
    await handlers.get(name)!({ event: event(args, 80n), context: { db } });
    const current = db.rows.get("v2ContractSetting")!.get(`${source}:${key}`);
    expect(current).toMatchObject({ source, key, valueKind: kind, updatedBlock: 80n, updatedAt: 7_080n, updatedTx: TX });
    for (const [k, column] of Object.entries(COLUMN)) {
      expect(current[column], column).toEqual(k === kind ? value : null);
    }
    const changes = [...db.rows.get("v2ContractSettingChange")!.values()];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ source, key, valueKind: kind, [COLUMN[kind]]: value, block: 80n, tx: TX });
    expect(changes[0].id).toBe(`${TX}-${changes[0].logIndex}`); // single-key ids carry no key suffix
  });

  it("a second change of the same key replaces the current value and appends a second change row", async () => {
    const db = memoryDb();
    await handlers.get("FeeSplitter:PausedSet")!({ event: event({ paused: true }, 90n), context: { db } });
    await handlers.get("FeeSplitter:PausedSet")!({ event: event({ paused: false }, 91n), context: { db } });
    expect(db.rows.get("v2ContractSetting")!.get("FeeSplitter:paused")).toMatchObject({ valueBool: false, updatedBlock: 91n });
    expect([...db.rows.get("v2ContractSettingChange")!.values()].map((c) => c.valueBool)).toEqual([true, false]);
  });

  it("covers every registered single-key setting and authority handler", () => {
    const covered = new Set([...AUTHORITY_SOURCES.map(([name]) => name), ...SETTINGS.map(([name]) => name)]);
    const multiKey = new Set([
      "EarnVault:LimitsSet", "HouseVault:BoundaryPinFailed", "ChainlinkFeedSource:FeedSet", "ChainlinkFeedSource:FeedPinned",
      "ChainlinkFeedSource:BandSet", "ChainlinkFeedSource:BandPinned", "UniV3TwapSource:PoolSet", "UniV3TwapSource:PoolPinned",
      "DataStreamsSource:FeedPinned", "DataStreamsSource:MultiplierRegimeChanged",
    ]);
    expect([...handlers.keys()].filter((name) => !covered.has(name) && !multiKey.has(name))).toEqual([]);
  });
});

describe("ChainlinkFeedSource:FeedPinned", () => {
  it("pins feed, staleness and round-jump bounds under underlying and expiry, one change row per key", async () => {
    const db = memoryDb();
    await handlers.get("ChainlinkFeedSource:FeedPinned")!({
      event: event({ underlying: A, expiry: 1_790_000_000, feed: EMITTER, maxStale: 3_600, maxRoundJumpBps: 500 }, 95n),
      context: { db },
    });
    const pin = `pin:${A}:1790000000`;
    const current = db.rows.get("v2ContractSetting")!;
    expect(current.get(`ChainlinkFeedSource:${pin}:feed`)).toMatchObject({ valueKind: "address", valueAddress: EMITTER });
    expect(current.get(`ChainlinkFeedSource:${pin}:maxStale`)).toMatchObject({ valueKind: "uint", valueUint: 3_600n });
    expect(current.get(`ChainlinkFeedSource:${pin}:maxRoundJumpBps`)).toMatchObject({ valueKind: "uint", valueUint: 500n });
    const ids = [...db.rows.get("v2ContractSettingChange")!.keys()];
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => id.startsWith(`${TX}-`) && id.includes(`:${pin}:`))).toBe(true);
  });
});
