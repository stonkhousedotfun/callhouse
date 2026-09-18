import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../ponder.schema";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const handlers = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) process.env[name] ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_START_BLOCK ??= "1";
  return new Map<string, Handler>();
});
vi.mock("../../lib/registry", () => ({ v2Ponder: { on: (event: string, handler: Handler) => handlers.set(event, handler) } }));
vi.mock("ponder:schema", () => ({ ...schema, default: schema }));
const asset = "0x0000000000000000000000000000000000000011" as const;
const writer = "0x0000000000000000000000000000000000000022" as const;
const holder = "0x0000000000000000000000000000000000000033" as const;
const tx = `0x${"a".repeat(64)}` as const;
let pg: PGlite;
let sql: any;
let context: any;
let logIndex = 0;
let usdg: `0x${string}`;
const send = async (name: string, args: object, at = 100n) => handlers.get(name)!({ context,
  event: { args, block: { timestamp: at, number: 100n }, transaction: { hash: tx }, log: { logIndex: logIndex++ } } });
const where = (table: any, key: any) => and(...Object.entries(key).map(([k, v]) => eq(table[k], v)));

beforeAll(async () => {
  pg = new PGlite();
  for (const table of [schema.v2Market, schema.v2Series, schema.v2Account, schema.v2Ledger,
    schema.v2Mint, schema.v2Close, schema.v2MintFeeAccrual, schema.v2SpecialExpiry, schema.v2CashFlow,
    schema.v2Strategy, schema.v2Roll, schema.v2StaleCancel]) {
    const config = getTableConfig(table);
    const columns = config.columns.map((c) => {
      const value = typeof c.default === "string" ? "'" + c.default.replaceAll("'", "''") + "'" : String(c.default);
      return `"${c.name}" ${c.getSQLType().startsWith("v2_") ? "text" : c.getSQLType()}${c.primary ? " PRIMARY KEY" : c.notNull ? " NOT NULL" : ""}${c.default === undefined ? "" : " DEFAULT " + value}`;
    });
    await pg.exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
  }
  sql = drizzle({ client: pg, schema });
  usdg = (await import("../../lib/env")).USDG;
  context = {
    db: {
      find: async (table: any, key: any) => (await sql.select().from(table).where(where(table, key)))[0] ?? null,
      insert: (table: any) => ({ values: async (row: any) => (await sql.insert(table).values(row).returning())[0] }),
      update: (table: any, key: any) => ({ set: async (row: any) => (await sql.update(table).set(row).where(where(table, key)).returning())[0] }),
    },
    client: { readContract: async (input: any) => {
      if (input.functionName === "symbol") return "TEST";
      if (input.functionName === "calendar") return asset;
      if (input.functionName === "isWeekly") return true;
      if (input.functionName === "mintCutoff") return 603_100;
      if (input.functionName === "collateralAsset") return input.args[0] === 2n ? asset : usdg;
      throw new Error(`unexpected read ${input.functionName}`);
    } },
  };
  await import("./clearinghouse");
  await import("./autoRoller");
});
afterAll(async () => { await pg?.close(); });

describe("v7 native-rent event replay through real handlers and SQL schema", () => {
  it("pins each series rate while market changes only affect future series", async () => {
    const config = { enabled: true, mintPaused: false, strikeTick: 1_000_000n, exerciseFeeBps: 25, oracle: asset, mintFeePpm: 80 };
    await send("Clearinghouse:MarketRegistered", { underlying: asset, config });
    for (const [longId, isPut] of [[2n, false], [4n, true]] as const) await send("Clearinghouse:SeriesCreated", {
      longId, underlying: asset, isPut, strike: 200_000_000n, expiry: 604_900, oracle: asset,
      exerciseFeeBps: 25, mintFeePpm: 80,
    });
    await send("Clearinghouse:MarketConfigSet", { underlying: asset, config: { ...config, mintFeePpm: 300 } });
    expect((await sql.select().from(schema.v2Market))[0].mintFeePpm).toBe(300);
    expect((await sql.select().from(schema.v2Series)).map((s: any) => s.mintFeePpm)).toEqual([80, 80]);
  });

  it.each([{ longId: 2n, cpu: 10n ** 16n, fee: 1_600_000_000_000n, refund: 400_000_000_000n },
    { longId: 4n, cpu: 2_000_000n, fee: 320n, refund: 80n }])("conserves free + locked + held/accrued for series $longId", async ({ longId, cpu, fee, refund }) => {
    const collateralAsset = longId === 2n ? asset : usdg;
    await send("Clearinghouse:Deposited", { account: writer, asset: collateralAsset, amount: 10n * cpu, from: writer });
    await send("Clearinghouse:Minted", { longId, writer, longTo: holder, units: 2n, collateral: 2n * cpu, fee });
    const findSeries = () => context.db.find(schema.v2Series, { longId });
    const ledger = (account: string) => context.db.find(schema.v2Ledger, { id: `${account}-${collateralAsset.toLowerCase()}` });
    expect((await ledger(writer)).free).toBe(8n * cpu - fee);
    expect((await findSeries()).mintFeesHeld).toBe(fee);
    // Matching tokens can move to another closer; the refund belongs to whoever closes.
    await send("Clearinghouse:Closed", { longId, account: holder, units: 1n, collateralFreed: cpu, feeRefund: refund }, 302_500n);
    expect((await ledger(holder)).free).toBe(cpu + refund);
    expect((await findSeries()).mintFeesHeld).toBe(fee - refund);
    expect((await ledger(writer)).free + (await ledger(holder)).free + cpu + (await findSeries()).mintFeesHeld).toBe(10n * cpu);
    await send("Clearinghouse:SeriesSettled", { longId, settlementPrice: 200_000_000n,
      longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: cpu }, 604_900n);
    expect((await findSeries()).mintFeesHeld).toBe(fee - refund); // next emitted event accrues it
    await send("Clearinghouse:MintFeesAccrued", { longId, asset: collateralAsset, amount: fee - refund }, 604_900n);
    expect(await findSeries()).toMatchObject({ mintFeesHeld: 0n, mintFeesAccrued: fee - refund });
    const [accrual] = await sql.select().from(schema.v2MintFeeAccrual).where(eq(schema.v2MintFeeAccrual.longId, longId));
    expect(accrual).toMatchObject({ asset: collateralAsset.toLowerCase(), amount: fee - refund });
    const [mint] = await sql.select().from(schema.v2Mint).where(eq(schema.v2Mint.longId, longId));
    const [close] = await sql.select().from(schema.v2Close).where(eq(schema.v2Close.longId, longId));
    expect(mint.fee).toBe(fee);
    expect(close.feeRefund).toBe(refund);
    expect((await ledger(writer)).free + (await ledger(holder)).free + cpu + (await findSeries()).mintFeesAccrued).toBe(10n * cpu);
  });
});

it("records the permissionless stale withdrawal while retaining the current strategy position", async () => {
  await send("AutoRoller:StrategySet", { writer, underlying: asset, strategy: {
    active: true, weekly: true, smartPricing: true, otmBps: 200, askBps: 100,
    minAskBps: 50, maxAskBps: 200, maxUnits: 100n,
  } });
  await send("AutoRoller:Rolled", { writer, underlying: asset, longId: 2n, orderId: 7n,
    strike: 200_000_000n, expiry: 604_900, price: 1_000_000n, units: 100n });
  await send("AutoRoller:StaleAskCancelled", { writer, underlying: asset, longId: 2n, orderId: 7n,
    spot: 210_000_000n, updatedAt: 190n }, 200n);
  const [strategy] = await sql.select().from(schema.v2Strategy);
  expect(strategy).toMatchObject({ active: true, currentLongId: 2n, expiry: 604_900n, orderId: null,
    lastRolledAt: 100n, lastStaleCancelAt: 200n, staleSpot: 210_000_000n });
  const [record] = await sql.select().from(schema.v2StaleCancel);
  expect(record).toMatchObject({ writer, underlying: asset, longId: 2n, orderId: 7n,
    spot: 210_000_000n, spotUpdatedAt: 190n, ts: 200n });
});
