/**
 * src/v2/stateFacts.ts handlers not driven by x8CoreHandlers/rewards/makerVault handler tests: keeper budget funding
 * and callers, owed credit/claim rows, the oracle's market config and the per-expiry pinned config with its later
 * pin confirmation, and the MakerVault deposit/exposure/limits rows.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
});

vi.mock("../../lib/registry", () => ({
  v2Ponder: registry,
  v2RewardsPonder: registry,
  v2MakerVaultPonder: registry,
  v2RewardsDistributorPonder: registry,
}));
vi.mock("../../lib/env", () => ({ USDG: "0x0000000000000000000000000000000000000001" }));
vi.mock("ponder:schema", () => ({ default: new Proxy({}, { get: (_target, name) => name }) }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const keyOf = (row: any) => String(row.id ?? row.caller ?? row.longId ?? row.vault ?? row.underlying);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    insert: (name: string) => ({ values: (row: any) => {
      const id = keyOf(row);
      const previous = table(name).get(id);
      if (previous !== undefined) {
        // A plain insert of an existing key is a primary-key conflict in Postgres.
        return {
          then: (_resolve: unknown, reject: (e: unknown) => void) => reject(new Error(`duplicate key ${name} ${id}`)),
          onConflictDoUpdate: async (values: any) => { table(name).set(id, { ...previous, ...values }); },
        };
      }
      table(name).set(id, row);
      return {
        then: (resolve: (value: unknown) => void) => resolve(row),
        onConflictDoUpdate: async () => undefined,
      };
    } }),
    update: (name: string, key: any) => ({ set: async (values: any) => {
      table(name).set(keyOf(key), { ...table(name).get(keyOf(key)), ...values });
    } }),
  };
}

const TX = `0x${"e".repeat(64)}`;
const SOURCE = "0x000000000000000000000000000000000000Fe11";
let logIndex = 0;
const event = (args: object, block = 500n, address = SOURCE) => ({
  args,
  block: { timestamp: 10_000n + block, number: block },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address },
});
const fire = (db: ReturnType<typeof memoryDb>, name: string, args: object, block?: bigint, address?: string) =>
  handlers.get(name)!({ event: event(args, block, address), context: { db } });
const values = (db: ReturnType<typeof memoryDb>, name: string) => [...(db.rows.get(name)?.values() ?? [])];

beforeAll(async () => {
  await import("./stateFacts");
});

describe("keeper budget facts", () => {
  it("records KeeperRewards funding as an append-only row stamped with its log", async () => {
    const db = memoryDb();
    const from = "0x00000000000000000000000000000000000000F0";
    await fire(db, "KeeperRewards:Funded", { from, amount: 5_000_000n }, 501n);
    await fire(db, "KeeperRewards:Funded", { from, amount: 1n }, 502n);
    const rows = values(db, "v2ContractFunding");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "KeeperRewards", contract: SOURCE, from, amount: 5_000_000n,
      ts: 10_501n, block: 501n, tx: TX,
    });
    expect(rows[0].id).toBe(`${TX}-${rows[0].logIndex}`);
  });

  it("keeps one row per caller and lets a later CallerSet revoke it", async () => {
    const db = memoryDb();
    const caller = "0x00000000000000000000000000000000000000C1";
    await fire(db, "KeeperRewards:CallerSet", { caller, registered: true }, 510n);
    await fire(db, "KeeperRewards:CallerSet", { caller, registered: false }, 520n);
    expect(values(db, "v2KeeperCaller")).toEqual([expect.objectContaining({
      caller, registered: false, changedAt: 10_520n, changedBlock: 520n, changedTx: TX,
    })]);
  });
});

describe("OrderBook owed balances", () => {
  it("records a credit and its later withdrawal as separate append-only rows", async () => {
    const db = memoryDb();
    const account = "0x00000000000000000000000000000000000000A5";
    await fire(db, "OrderBook:OwedCredited", { account, amount: 7_000_000n }, 600n);
    await fire(db, "OrderBook:OwedClaimed", { account, amount: 7_000_000n }, 601n);
    expect(values(db, "v2OwedCredit")).toEqual([expect.objectContaining({ account, amount: 7_000_000n, block: 600n })]);
    expect(values(db, "v2OwedClaim")).toEqual([expect.objectContaining({ account, amount: 7_000_000n, block: 601n })]);
  });
});

describe("SettlementOracle configuration facts", () => {
  const UNDERLYING = "0x00000000000000000000000000000000000000Ab";
  const S1 = "0x00000000000000000000000000000000000000Aa";
  const S2 = "0x00000000000000000000000000000000000000Bb";

  it("stores the market's sources lower-cased in emitted priority order, replacing on reconfiguration", async () => {
    const db = memoryDb();
    await fire(db, "SettlementOracle:MarketConfigured", {
      underlying: UNDERLYING, sources: [S2, S1], maxDeviationBps: 150, uncorroboratedDelay: 3_600, spotMaxAge: 120,
    }, 700n);
    await fire(db, "SettlementOracle:MarketConfigured", {
      underlying: UNDERLYING, sources: [S1], maxDeviationBps: 100, uncorroboratedDelay: 7_200, spotMaxAge: 60,
    }, 701n);
    expect(values(db, "v2OracleMarketConfig")).toEqual([expect.objectContaining({
      underlying: UNDERLYING, sources: [S1.toLowerCase()], maxDeviationBps: 100,
      uncorroboratedDelayS: 7_200n, spotMaxAgeS: 60n, updatedBlock: 701n,
    })]);
  });

  it("pins an expiry's config by lower-cased underlying and expiry, and a confirmation updates the pinner", async () => {
    const db = memoryDb();
    const expiry = 1_790_000_000;
    await fire(db, "SettlementOracle:SettlementConfigPinned", {
      underlying: UNDERLYING, expiry, sources: [S1, S2], maxDeviationBps: 150, uncorroboratedDelay: 3_600,
    }, 800n);
    const id = `${UNDERLYING.toLowerCase()}-${expiry}`;
    const pinned = db.rows.get("v2OracleExpiryConfig")!.get(id);
    expect(pinned).toMatchObject({
      id, underlying: UNDERLYING, expiry: BigInt(expiry), sources: [S1.toLowerCase(), S2.toLowerCase()],
      maxDeviationBps: 150, uncorroboratedDelayS: 3_600n, pinnedAt: 10_800n, pinnedBlock: 800n, pinnedTx: TX,
    });
    expect(pinned).not.toHaveProperty("spotMaxAgeS"); // the event has none, and none is invented

    const previousPinner = "0x00000000000000000000000000000000000000C0";
    const pinner = "0x00000000000000000000000000000000000000C9";
    await fire(db, "SettlementOracle:SettlementPinConfirmed", { underlying: UNDERLYING, expiry, previousPinner, pinner }, 801n);
    expect(db.rows.get("v2OracleExpiryConfig")!.get(id)).toMatchObject({
      pinner: pinner.toLowerCase(), previousPinner: previousPinner.toLowerCase(), pinnedBlock: 800n,
    });
    expect(values(db, "v2OraclePinConfirm")).toEqual([expect.objectContaining({
      underlying: UNDERLYING.toLowerCase(), expiry: BigInt(expiry), block: 801n,
    })]);
  });

  it("stores a pin confirmation even when the pin itself was never indexed", async () => {
    const db = memoryDb();
    await fire(db, "SettlementOracle:SettlementPinConfirmed", {
      underlying: UNDERLYING, expiry: 5, previousPinner: S1, pinner: S2,
    });
    expect(values(db, "v2OraclePinConfirm")).toHaveLength(1);
    expect(values(db, "v2OracleExpiryConfig")).toEqual([]);
  });
});

describe("MakerVault facts", () => {
  const VAULT = "0x0000000000000000000000000000000000005016";
  const STOCK = "0x00000000000000000000000000000000000000Ab";

  it("stores USDG and registered-underlying deposits and drops (with a warning) anything else", async () => {
    const db = memoryDb();
    db.rows.set("v2Market", new Map([[STOCK.toLowerCase(), { underlying: STOCK.toLowerCase() }]]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const from = "0x00000000000000000000000000000000000000F1";
      await fire(db, "MakerVault:Deposited", { asset: "0x0000000000000000000000000000000000000001", from, amount: 10n }, 900n, VAULT);
      await fire(db, "MakerVault:Deposited", { asset: STOCK, from, amount: 2n * 10n ** 18n }, 901n, VAULT);
      await fire(db, "MakerVault:Deposited", { asset: "0x00000000000000000000000000000000000000Ee", from, amount: 99n }, 902n, VAULT);
      expect(values(db, "v2MakerVaultDeposit").map((r) => [r.asset, r.amount])).toEqual([
        ["0x0000000000000000000000000000000000000001", 10n], [STOCK, 2n * 10n ** 18n],
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("MAKER_VAULT_DEPOSIT_UNLISTED asset=0x00000000000000000000000000000000000000ee");
    } finally {
      warn.mockRestore();
    }
  });

  it("upserts exposure per series and limits per vault, widening integer fields to bigint", async () => {
    const db = memoryDb();
    await fire(db, "MakerVault:ExposureSet", { longId: 2n, units: 5n, notional: 1_000n, totalNotional: 3_000n }, 910n, VAULT);
    await fire(db, "MakerVault:ExposureSet", { longId: 2n, units: 0n, notional: 0n, totalNotional: 2_000n }, 911n, VAULT);
    expect(values(db, "v2MakerVaultExposure")).toEqual([expect.objectContaining({
      longId: 2n, units: 0n, notional: 0n, totalNotional: 2_000n, updatedBlock: 911n,
    })]);

    await fire(db, "MakerVault:LimitsSet", { limits: {
      maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n, askToleranceBps: 100,
      maxBidBpsOfSpot: 1_000, maxOrderLifetime: 3_600, maxDailyOutflow: 2_500_000_000n,
    } }, 912n, VAULT);
    expect(values(db, "v2MakerVaultLimits")).toEqual([expect.objectContaining({
      vault: VAULT, maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n, askToleranceBps: 100,
      maxBidBpsOfSpot: 1_000, maxOrderLifetime: 3_600n, maxDailyOutflow: 2_500_000_000n, updatedBlock: 912n,
    })]);
  });
});
