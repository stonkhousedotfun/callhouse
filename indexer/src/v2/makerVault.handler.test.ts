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
vi.mock("../../lib/env", () => ({
  USDG: "0x0000000000000000000000000000000000000001",
  V2_CLEARINGHOUSE: "0x000000000000000000000000000000000000c011",
}));
vi.mock("ponder:schema", () => ({ default: {
  v2Market: "v2Market",
  v2MakerVaultDeposit: "v2MakerVaultDeposit",
  v2MakerVaultExposure: "v2MakerVaultExposure",
  v2MakerVaultLimits: "v2MakerVaultLimits",
  v2TreasuryExit: "v2TreasuryExit",
} }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const rowKey = (row: any) => String(row.id ?? row.longId ?? row.vault ?? row.underlying);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(rowKey(key)) ?? null,
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
  };
}

const TX = `0x${"1".repeat(64)}`;
let logIndex = 0;
const event = (address: string, args: object) => ({
  args,
  block: { timestamp: 100n, number: 200n },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address },
});

beforeAll(async () => {
  await import("./stateFacts");
  await import("./treasury");
});

describe("MakerVault transparency reducers", () => {
  it("retains deposits, withdrawals, exposure, and all six live-limit fields", async () => {
    const vault = "0x0000000000000000000000000000000000005016";
    const asset = "0x00000000000000000000000000000000000000AA";
    const account = "0x0000000000000000000000000000000000000011";
    const db = memoryDb();
    const context = { db };
    // A deposit is stored only for USDG or a registered market's underlying, so the asset is a market here.
    db.rows.set("v2Market", new Map([[asset.toLowerCase(), { underlying: asset.toLowerCase(), ticker: "NVDA" }]]));

    await handlers.get("MakerVault:Deposited")!({
      event: event(vault, { asset, from: account, amount: 20n }), context,
    });
    await handlers.get("MakerVault:Withdrawn")!({
      event: event(vault, { asset, to: account, amount: 3n }), context,
    });
    await handlers.get("MakerVault:ExposureSet")!({
      event: event(vault, { longId: 7n, units: 8n, notional: 9n, totalNotional: 10n }), context,
    });
    await handlers.get("MakerVault:LimitsSet")!({
      event: event(vault, { limits: {
        maxSeriesUnits: 11n,
        maxTotalNotional: 12n,
        askToleranceBps: 13,
        maxBidBpsOfSpot: 14,
        maxOrderLifetime: 15,
        maxDailyOutflow: 16n,
      } }), context,
    });

    expect([...db.rows.get("v2MakerVaultDeposit")!.values()][0]).toMatchObject({
      asset, from: account, amount: 20n,
    });
    expect([...db.rows.get("v2TreasuryExit")!.values()][0]).toMatchObject({
      source: "makerVault", eventKind: "withdrawn", asset: asset.toLowerCase(), amount: 3n,
    });
    expect(db.rows.get("v2MakerVaultExposure")!.get("7")).toMatchObject({
      units: 8n, notional: 9n, totalNotional: 10n,
    });
    expect(db.rows.get("v2MakerVaultLimits")!.get(vault)).toMatchObject({
      maxSeriesUnits: 11n,
      maxTotalNotional: 12n,
      askToleranceBps: 13,
      maxBidBpsOfSpot: 14,
      maxOrderLifetime: 15n,
      maxDailyOutflow: 16n,
    });
  });
});

describe(": Deposited is stored only for USDG or a registered market underlying", () => {
  const vault = "0x0000000000000000000000000000000000005016";
  const from = "0x0000000000000000000000000000000000000011";
  const USDG = "0x0000000000000000000000000000000000000001"; // the lib/env mock's USDG
  // Mixed case, as a log carries it; v2Market is keyed by the lowercased underlying (src/v2/clearinghouse.ts).
  const NVDA = "0x00000000000000000000000000000000000000aB";
  const FORGED = "0x000000000000000000000000000000000000F00d";

  function withMarket() {
    const db = memoryDb();
    db.rows.set("v2Market", new Map([[NVDA.toLowerCase(), { underlying: NVDA.toLowerCase(), ticker: "NVDA" }]]));
    return db;
  }
  async function deposit(db: ReturnType<typeof memoryDb>, asset: string, amount: bigint) {
    await handlers.get("MakerVault:Deposited")!({ event: event(vault, { asset, from, amount }), context: { db } });
  }
  const deposits = (db: ReturnType<typeof memoryDb>) => [...(db.rows.get("v2MakerVaultDeposit")?.values() ?? [])];

  it("a forged-token deposit leaves no row and logs the refusal, naming the token", async () => {
    const db = withMarket();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await deposit(db, FORGED, 1_000_000n);
      expect(deposits(db)).toEqual([]);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`MAKER_VAULT_DEPOSIT_UNLISTED asset=${FORGED.toLowerCase()}`);
    } finally {
      warn.mockRestore();
    }
  });

  it("a USDG deposit leaves exactly one row", async () => {
    const db = withMarket();
    await deposit(db, USDG, 5n);
    expect(deposits(db)).toHaveLength(1);
    expect(deposits(db)[0]).toMatchObject({ asset: USDG, from, amount: 5n });
  });

  it("a registered market's Stock Token deposit leaves exactly one row, whatever the address case", async () => {
    const db = withMarket();
    await deposit(db, NVDA, 7n);
    expect(deposits(db)).toHaveLength(1);
    expect(deposits(db)[0]).toMatchObject({ asset: NVDA, amount: 7n });
  });

  it("the allow-set is the v2Market table: the same token is refused before its market is registered", async () => {
    const db = memoryDb(); // no v2Market row yet
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await deposit(db, NVDA, 7n);
      expect(deposits(db)).toEqual([]);
      db.rows.set("v2Market", new Map([[NVDA.toLowerCase(), { underlying: NVDA.toLowerCase(), ticker: "NVDA" }]]));
      await deposit(db, NVDA, 7n);
      expect(deposits(db)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
