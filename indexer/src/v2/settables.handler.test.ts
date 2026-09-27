import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The events the regenerated ABIs brought in (ops/abis/v2), each HANDLED:
 *   FeeSplitter:BuybackCapCeilingSet / BuybackCooldownSet and KeeperRewards:MaxBountySet (settables) and
 *   EarnVault:LimitsSet land in v2ContractSetting / v2ContractSettingChange (src/v2/adminConfig.ts);
 *   HouseVault:PerformanceFeeBpsApplied sets the rate IN FORCE on v2HouseVault, and PerformanceFeeBpsSet, which
 *   only stages a rate, is now a setting and leaves that column alone (the staged-fee-shown-as-charged finding).
 * The harness is priceSources.handler.test.ts's: a recorder for Ponder's `on` and an in-memory db.
 */
type Handler = (input: { event: any; context: any }) => Promise<void>;
const handlers = vi.hoisted(() => {
  // houseVault.ts reads the indexer env at import (lib/env, lib/v2/houseVaultSource), as in houseVault.handler.test.ts.
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) {
    process.env[name] ??= "0x000000000000000000000000000000000000c012";
  }
  process.env.V2_START_BLOCK ??= "1";
  process.env.V2_HOUSE_VAULT_FACTORY ??= "0x000000000000000000000000000000000000f001";
  process.env.V2_HOUSE_START_BLOCK ??= "100";
  return new Map<string, Handler>();
});

vi.mock("../../lib/registry", () => {
  const recorder = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
  return Object.fromEntries([
    "v2Ponder", "v2CalendarPonder", "v2EarnVaultPonder", "v2FeeSplitterPonder", "v2HouseVaultPonder",
    "v2HouseVaultEventsPonder", "v2HouseVaultKindedFactoryPonder",
    "v2MakerVaultPonder", "v2PayoutRouterPonder", "v2RewardsDistributorPonder", "v2RewardsPonder",
    "v2ChainlinkSourcePonder", "v2UniV3SourcePonder", "v2DataStreamsSourcePonder", "v2BuybackExecutorPonder",
  ].map((name) => [name, recorder]));
});

vi.mock("ponder:schema", () => ({
  default: {
    v2ContractSetting: "v2ContractSetting",
    v2ContractSettingChange: "v2ContractSettingChange",
    v2ContractAuthority: "v2ContractAuthority",
    v2HouseVault: "v2HouseVault", v2HouseEpoch: "v2HouseEpoch", v2HouseNav: "v2HouseNav",
    v2HouseQueueSettlement: "v2HouseQueueSettlement", v2HousePerformanceFee: "v2HousePerformanceFee",
  },
}));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  // `id` keys every table here except v2HouseVault, which is keyed by `vault`.
  const keyOf = (row: any) => String(row.id ?? row.vault);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    update: (name: string, key: any) => ({ set: async (values: any) => {
      const current = table(name).get(keyOf(key));
      if (current !== undefined) table(name).set(keyOf(key), { ...current, ...values });
    } }),
    insert: (name: string) => ({ values: (row: any) => {
      const existing = table(name).get(keyOf(row));
      if (existing === undefined) table(name).set(keyOf(row), row);
      return {
        then: (resolve: (value: any) => void, reject: (error: Error) => void) => existing === undefined
          ? resolve(row)
          : reject(new Error(`duplicate primary key ${name}:${row.id}`)),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(keyOf(row), existing === undefined ? row : { ...existing, ...values });
        },
      };
    } }),
  };
}

const source = "0x00000000000000000000000000000000000000f1";
const tx = `0x${"b".repeat(64)}`;
const event = (args: object, logIndex = 3) => ({
  args,
  block: { timestamp: 1_790_000_000n, number: 69_600_000n },
  transaction: { hash: tx },
  log: { logIndex, address: source },
});

async function run(name: string, args: object, db = memoryDb()) {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`no handler ${name}`);
  await handler({ event: event(args), context: { db } });
  return db;
}

const settingsOf = (db: ReturnType<typeof memoryDb>) => db.rows.get("v2ContractSetting") ?? new Map();
const changesOf = (db: ReturnType<typeof memoryDb>) => db.rows.get("v2ContractSettingChange") ?? new Map();

beforeAll(async () => {
  await import("./adminConfig");
  await import("./houseVault");
});

describe("the buyback, bounty and Earn limit settables are settings", () => {
  it("FeeSplitter:BuybackCapCeilingSet and BuybackCooldownSet write their current value and one change row each", async () => {
    // Two logs of one transaction, as the FeeSplitter constructor emits them: distinct log indexes, distinct change rows.
    const db = memoryDb();
    await handlers.get("FeeSplitter:BuybackCapCeilingSet")!({ event: event({ ceiling: 1_000_000_000n }, 3), context: { db } });
    await handlers.get("FeeSplitter:BuybackCooldownSet")!({ event: event({ cooldown: 300 }, 4), context: { db } });
    expect(settingsOf(db).get("FeeSplitter:buybackCapCeiling")).toMatchObject({
      source: "FeeSplitter", key: "buybackCapCeiling", valueKind: "uint", valueUint: 1_000_000_000n,
    });
    expect(settingsOf(db).get("FeeSplitter:buybackCooldown")).toMatchObject({ valueKind: "uint", valueUint: 300n });
    expect(changesOf(db).size).toBe(2);
  });

  it("KeeperRewards:MaxBountySet writes maxBounty", async () => {
    const db = await run("KeeperRewards:MaxBountySet", { amount: 1_000_000n });
    expect(settingsOf(db).get("KeeperRewards:maxBounty")).toMatchObject({ valueKind: "uint", valueUint: 1_000_000n });
  });

  it("EarnVault:LimitsSet writes each of the five caps as its own typed setting, with five distinct change rows", async () => {
    const db = await run("EarnVault:LimitsSet", { limits: {
      maxSeriesUnits: 1n, maxOrderNotional: 2n, maxWrittenUnitsPerSeries: 3n, maxWrittenNotional: 4n, maxDailyOutflow: 2_500_000_000n,
    } });
    const current = settingsOf(db);
    expect(current.get("EarnVault:limits.maxSeriesUnits")).toMatchObject({ valueUint: 1n });
    expect(current.get("EarnVault:limits.maxOrderNotional")).toMatchObject({ valueUint: 2n });
    expect(current.get("EarnVault:limits.maxWrittenUnitsPerSeries")).toMatchObject({ valueUint: 3n });
    expect(current.get("EarnVault:limits.maxWrittenNotional")).toMatchObject({ valueUint: 4n });
    expect(current.get("EarnVault:limits.maxDailyOutflow")).toMatchObject({ valueKind: "uint", valueUint: 2_500_000_000n });
    expect(changesOf(db).size).toBe(5);
  });
});

describe("the House performance fee in force follows PerformanceFeeBpsApplied, not the staging call", () => {
  const vaultRow = () => { const db = memoryDb(); db.rows.set("v2HouseVault", new Map([[source, { vault: source, performanceFeeBps: 100 }]])); return db; };

  it("PerformanceFeeBpsSet stages: a setting keyed by the vault, and the rate in force is untouched", async () => {
    const db = await run("HouseVault:PerformanceFeeBpsSet", { bps: 1_500 }, vaultRow());
    expect(settingsOf(db).get(`HouseVault:performanceFeeBps:${source}`)).toMatchObject({ valueKind: "uint", valueUint: 1_500n });
    expect(db.rows.get("v2HouseVault")?.get(source).performanceFeeBps).toBe(100);
  });

  it("PerformanceFeeBpsApplied puts the rate in force as the epoch opens", async () => {
    const db = await run("HouseVault:PerformanceFeeBpsApplied", { bps: 1_500, epochId: 7n }, vaultRow());
    expect(db.rows.get("v2HouseVault")?.get(source).performanceFeeBps).toBe(1_500);
  });

  it("an Applied for a vault the indexer has no row for writes nothing (the VaultCreated row comes first)", async () => {
    const db = await run("HouseVault:PerformanceFeeBpsApplied", { bps: 1_500, epochId: 7n });
    expect(db.rows.get("v2HouseVault")?.size ?? 0).toBe(0);
  });
});

describe("the oracle's House factory pointer and a failed boundary pin are settings", () => {
  it("SettlementOracle:HouseVaultFactorySet writes the oracle's houseVaultFactory pointer", async () => {
    const factory = "0x000000000000000000000000000000000000f00d";
    const db = await run("SettlementOracle:HouseVaultFactorySet", { houseVaultFactory: factory });
    expect(settingsOf(db).get("SettlementOracle:houseVaultFactory")).toMatchObject({
      source: "SettlementOracle", key: "houseVaultFactory", valueKind: "address", valueAddress: factory,
    });
    expect(changesOf(db).size).toBe(1);
  });

  it("HouseVault:BoundaryPinFailed records the boundary and the reason, keyed by the vault, with one change row each", async () => {
    const reason = "0x4ca88867";
    const db = await run("HouseVault:BoundaryPinFailed", { epochEnd: 1_790_020_800, reason });
    expect(settingsOf(db).get(`HouseVault:boundaryPinFailed:${source}`)).toMatchObject({ valueKind: "uint", valueUint: 1_790_020_800n });
    expect(settingsOf(db).get(`HouseVault:boundaryPinFailedReason:${source}`)).toMatchObject({ valueKind: "text", valueText: reason });
    expect([...changesOf(db).keys()].sort()).toEqual([`${tx}-3:boundaryPinFailed:${source}`, `${tx}-3:boundaryPinFailedReason:${source}`]);
  });
});
