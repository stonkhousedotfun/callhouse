import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";

import { PGlite } from "@electric-sql/pglite";
import { and, eq, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, isPgEnum, PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../ponder.schema";
import cardRegistry from "../lib/v2/cardRegistry.generated.json";
import v2Sources from "../../ops/markets/v2-sources.json";
import baseline from "./v2-scale.baseline.json";
import {
  percentile95,
  roundedMs,
  SCALE_HEAD,
  SCALE_TICKERS,
  scalePlan,
  type ScaleSeries,
} from "./v2-scale";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const state = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_START_BLOCK ??= "100";
  // Match the deployed configuration so SeriesCreated exercises the holiday-table SQL branch.
  process.env.V2_EXPIRY_CALENDAR = "0x0000000000000000000000000000000000000ca1";
  return {
    db: null as unknown,
    now: 1_800_000_000,
    handlers: new Map<string, Handler>(),
    symbols: new Map<string, string>(),
    mintCutoffs: new Map<string, bigint>(),
    reads: { symbol: 0, calendar: 0, isWeekly: 0, mintCutoff: 0 },
  };
});

vi.mock("../lib/registry", () => ({
  v2Ponder: { on: (event: string, handler: Handler) => state.handlers.set(event, handler) },
}));
vi.mock("ponder:api", () => ({ get db() { return state.db; }, publicClients: {} }));
vi.mock("ponder:schema", () => ({ ...schema, default: schema }));
vi.mock("../lib/v2/pricing", () => ({
  fetchFairQuote: async () => null,
  fetchFairResult: async () => ({ quote: null, reasonCode: null, provenance: null }),
  fetchPricingSpot: async () => 200_000_000n,
}));
vi.mock("../src/api/v2/chain", () => ({
  readSpots: async (assets: string[]) => new Map(assets.map((asset) => [asset.toLowerCase(),
    { price: 200_000_000n, updatedAt: state.now }])),
  readFree: async () => new Map(),
}));

type HolidayRow = { date: string; dayIndex: number };
const HOLIDAY_ROWS = Object.values(v2Sources.nyseHolidays)
  .flatMap((year) => year.fullDays as HolidayRow[])
  .sort((a, b) => a.dayIndex - b.dayIndex);
const HOLIDAYS = new Map(HOLIDAY_ROWS.map((row) => [row.dayIndex, true]));
const selectedPlan = scalePlan(HOLIDAYS);
const shape = selectedPlan.shape;
const SAMPLE_COUNT = (() => {
  const raw = Number(process.env.V2_SCALE_SAMPLES ?? 20);
  if (!Number.isInteger(raw) || raw < 20 || raw > 100)
    throw new Error("V2_SCALE_SAMPLES must be an integer from 20 to 100 so p95 is meaningful and bounded");
  return raw;
})();
const TX = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const BUYER = address(0xb0);
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const;
const METRIC_KEYS = ["handlerReplay", "marketsP95", "cardsP95", "marketSeriesP95", "seriesDetailP95"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

type ScaleFixture = {
  series: readonly ScaleSeries[];
  firstByTicker: Map<string, bigint>;
  handlerReplayMs: number;
  /** The calibration measured immediately around the replay (mean of before and after). */
  handlerReplayCalibrationMs: number;
  eventCounts: { marketRegistered: number; seriesCreated: number };
};

/**
 * THE CEILINGS ARE RATIOS, NOT MILLISECONDS. A fixed ms budget cannot tell "the code got slower" from "the
 * machine is busy": at load average 75-100 (30 parallel compiles) the replay measured 8104 ms against a 6000 ms ceiling
 * with no code change, and passed on a rerun. So each metric is divided by a CALIBRATION measured in the same process,
 * on the same PGlite instance, immediately before and after it: a fixed workload of the same kind (single-row PGlite
 * writes and point reads plus one scan and a JSON round trip, the operations the handlers and the routes are made of).
 * A busy machine slows both, and the ratio holds; a code regression slows only the metric, and the ratio grows.
 * Each calibration is the median of CALIBRATION_REPEATS runs, so one scheduler stall does not set the scale.
 */
const CALIBRATION_ROWS = 200;
const CALIBRATION_REPEATS = 3;

async function calibrationOnce(client: PGlite): Promise<number> {
  await client.exec("CREATE TEMP TABLE IF NOT EXISTS _scale_calibration (id integer PRIMARY KEY, body text NOT NULL)");
  await client.exec("TRUNCATE _scale_calibration");
  const started = performance.now();
  for (let i = 0; i < CALIBRATION_ROWS; i++) {
    await client.query("INSERT INTO _scale_calibration VALUES ($1, $2)", [i, `calibration-row-${i}`]);
  }
  let found = 0;
  for (let i = 0; i < CALIBRATION_ROWS; i++) {
    found += (await client.query("SELECT body FROM _scale_calibration WHERE id = $1", [i])).rows.length;
  }
  const scanned = (await client.query("SELECT id, body FROM _scale_calibration ORDER BY id")).rows;
  const roundTrip = JSON.parse(JSON.stringify(scanned)) as unknown[];
  const elapsed = performance.now() - started;
  if (found !== CALIBRATION_ROWS || roundTrip.length !== CALIBRATION_ROWS) throw new Error("calibration workload did not run");
  return elapsed;
}

async function calibrationMs(client: PGlite): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < CALIBRATION_REPEATS; i++) runs.push(await calibrationOnce(client));
  return runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)]!;
}

/** A metric measured between two calibrations: its ms, the calibration mean, and the ratio the ceiling judges. */
type Normalized = { ms: number; calibrationMs: number; ratio: number };
const normalized = (ms: number, calibration: number): Normalized => ({ ms, calibrationMs: calibration, ratio: ms / calibration });

let pg: PGlite;
let app: Hono;
let fixture: ScaleFixture;
let restoreDateNow: (() => void) | undefined;

/**
 * EVERY table and enum `ponder.schema.ts` exports, read off the module the production indexer builds its
 * database from, never a hand list. The hand list this replaced lacked `v2_oracle_market_config` once a route began
 * reading it, so the route answered 500 (PGlite 42P01) and the harness failed on a missing table rather than on
 * anything it measures. `schemaDrift` below proves the database the harness built matches this list, table by table.
 */
const schemaExports: unknown[] = Object.values(schema);
const tables = schemaExports.filter((value): value is PgTable => is(value, PgTable));
const enums = schemaExports.filter(isPgEnum);
/** `export const x = onchainTable(` in the source: the count the module's tables must reach (a filter that matched
 *  nothing would otherwise build an empty database and fail somewhere unrelated). */
const SOURCE_TABLE_COUNT = readFileSync(new URL("../ponder.schema.ts", import.meta.url), "utf8")
  .match(/^export const \w+ = onchainTable\(/gm)?.length ?? 0;

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function defaultSql(value: unknown): string {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error(`Scale schema cannot reproduce non-literal default ${String(value)}`);
}

/** Reproduce every committed Ponder enum, column, default, constraint and index (all of them). */
async function createScaleSchema(client: PGlite) {
  for (const e of enums) {
    await client.exec(`CREATE TYPE ${quoted(e.enumName)} AS ENUM (${e.enumValues.map(defaultSql).join(", ")})`);
  }
  for (const table of tables) {
    const config = getTableConfig(table);
    if (config.primaryKeys.length !== 0) throw new Error(`Scale harness cannot reproduce the composite key of ${config.name}`);
    const columns = config.columns.map((column) => {
      const sqlType = column.getSQLType();
      const constraint = column.primary ? " PRIMARY KEY" : column.notNull ? " NOT NULL" : "";
      const fallback = column.default === undefined ? "" : ` DEFAULT ${defaultSql(column.default)}`;
      return `${quoted(column.name)} ${sqlType}${constraint}${fallback}`;
    });
    await client.exec(`CREATE TABLE ${quoted(config.name)} (${columns.join(", ")})`);
    for (const [position, entry] of config.indexes.entries()) {
      const names = entry.config.columns.map((column) => {
        if (!("name" in column) || typeof column.name !== "string")
          throw new Error(`Scale harness cannot reproduce an expression index on ${config.name}`);
        return column.name;
      });
      const name = `${config.name}_${names.join("_")}_${position}_scale_idx`;
      await client.exec(`CREATE INDEX ${quoted(name)} ON ${quoted(config.name)} (${names.map(quoted).join(", ")})`);
    }
  }
  await client.exec("CREATE TABLE _ponder_checkpoint (latest_checkpoint text)");
}

/**
 * Every schema table the built database lacks, or whose columns differ from `ponder.schema.ts`, by name.
 * Empty means the harness database is the production schema's table set.
 */
async function schemaDrift(client: PGlite): Promise<string[]> {
  const rows = (await client.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  )).rows;
  const built = new Map<string, Set<string>>();
  for (const row of rows) (built.get(row.table_name) ?? built.set(row.table_name, new Set()).get(row.table_name)!).add(row.column_name);
  const drift: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const have = built.get(config.name);
    if (have === undefined) {
      drift.push(`${config.name}: missing from the harness database`);
      continue;
    }
    const want = config.columns.map((column) => column.name);
    const missing = want.filter((name) => !have.has(name));
    const extra = [...have].filter((name) => !want.includes(name));
    if (missing.length !== 0 || extra.length !== 0) {
      drift.push(`${config.name}: columns missing [${missing.join(", ")}] extra [${extra.join(", ")}]`);
    }
  }
  return drift;
}

function where(table: any, key: Record<string, unknown>) {
  return and(...Object.entries(key).map(([name, value]) => eq(table[name], value)));
}

function handlerContext(database: ReturnType<typeof drizzle<typeof schema>>) {
  return {
    db: {
      find: async (table: any, key: Record<string, unknown>) => {
        const rows = await database.select().from(table).where(where(table, key)) as any[];
        return rows[0] ?? null;
      },
      insert: (table: any) => ({ values: async (row: any) => {
        const rows = await database.insert(table).values(row).returning() as any[];
        return rows[0];
      } }),
      update: (table: any, key: Record<string, unknown>) => ({ set: async (row: any) => {
        const rows = await database.update(table).set(row).where(where(table, key)).returning() as any[];
        return rows[0];
      } }),
      sql: database,
    },
    client: {
      readContract: async (input: { address?: string; functionName: string; args?: readonly unknown[] }) => {
        if (input.functionName === "symbol") {
          state.reads.symbol += 1;
          const symbol = state.symbols.get(input.address?.toLowerCase() ?? "");
          if (symbol === undefined) throw new Error(`unexpected symbol read for ${input.address}`);
          return symbol;
        }
        if (input.functionName === "calendar") {
          state.reads.calendar += 1;
          throw new Error("deployed scale replay must not use the fallback calendar RPC read");
        }
        if (input.functionName === "isWeekly") {
          state.reads.isWeekly += 1;
          throw new Error("deployed scale replay must not use the fallback isWeekly RPC read");
        }
        if (input.functionName === "mintCutoff") {
          state.reads.mintCutoff += 1;
          const cutoff = state.mintCutoffs.get(String(input.args?.[0]));
          if (cutoff === undefined) throw new Error(`unexpected mintCutoff read for ${String(input.args?.[0])}`);
          return cutoff;
        }
        throw new Error(`unexpected scale replay read ${input.functionName}`);
      },
    },
  };
}

async function replaySelectedLadder(database: ReturnType<typeof drizzle<typeof schema>>): Promise<ScaleFixture> {
  const series = selectedPlan.series;
  for (const market of shape.markets) state.symbols.set(market.underlying.toLowerCase(), market.ticker);
  for (const item of series) state.mintCutoffs.set(item.longId.toString(), item.expiry - 1_800n);
  const context = handlerContext(database);
  let ordinal = 0;
  const send = async (name: string, args: object) => {
    const handler = state.handlers.get(`Clearinghouse:${name}`);
    if (handler === undefined) throw new Error(`missing real Clearinghouse:${name} handler`);
    ordinal += 1;
    await handler({ context, event: {
      args,
      block: { number: 10_000n + BigInt(ordinal), timestamp: BigInt(state.now - 7_200 + ordinal) },
      transaction: { hash: TX(100_000 + ordinal) },
      log: { logIndex: ordinal % 100 },
    } });
  };

  const calibrationBefore = await calibrationMs(pg);
  const started = performance.now();
  for (const market of shape.markets) await send("MarketRegistered", {
    underlying: market.underlying,
    config: { enabled: true, mintPaused: false, strikeTick: market.strikeTick,
      exerciseFeeBps: 25, oracle: market.underlying, mintFeePpm: market.mintFeePpm },
  });
  for (const item of series) await send("SeriesCreated", {
    longId: item.longId,
    underlying: item.market.underlying,
    isPut: item.isPut,
    strike: item.strike,
    expiry: item.expiry,
    oracle: item.market.underlying,
    exerciseFeeBps: 25,
    mintFeePpm: item.market.mintFeePpm,
  });
  const handlerReplayMs = performance.now() - started;
  const handlerReplayCalibrationMs = (calibrationBefore + await calibrationMs(pg)) / 2;
  return {
    series,
    firstByTicker: new Map(shape.markets.map((market) => [market.ticker,
      series.find((item) => item.market.ticker === market.ticker)!.longId])),
    handlerReplayMs,
    handlerReplayCalibrationMs,
    eventCounts: { marketRegistered: shape.marketCount, seriesCreated: series.length },
  };
}

/** Orders, balances and fills are API load only. Their handlers are outside this measurement and untimed. */
async function seedApiActivity(database: ReturnType<typeof drizzle<typeof schema>>, series: readonly ScaleSeries[]) {
  const orders: (typeof schema.v2Order.$inferInsert)[] = [];
  const fills: (typeof schema.v2Fill.$inferInsert)[] = [];
  const ledgers = new Map<string, typeof schema.v2Ledger.$inferInsert>();
  for (const [index, item] of series.entries()) {
    const marketIndex = SCALE_TICKERS.indexOf(item.market.ticker);
    const maker = address(0x100 + marketIndex);
    const orderId = BigInt(index + 1);
    const price = 1_000_000n + BigInt((index % 5) * 10_000 + marketIndex * 100);
    const tx = TX(200_000 + index);
    const asset = item.isPut ? USDG : item.market.underlying.toLowerCase() as `0x${string}`;
    ledgers.set(`${maker}-${asset}`, { id: `${maker}-${asset}`, account: maker, asset,
      free: BigInt(item.market.series * 10) * (item.isPut ? 1_000_000n : 10n ** 18n) });
    orders.push({
      orderId, maker, longId: item.longId, kind: "AskWrite", price, units: 200n, filled: 100n,
      validUntil: item.expiry - 60n, status: "open", placedAt: BigInt(state.now - 1_800),
      placedBlock: 20_000n + orderId, placedTx: tx, updatedAt: BigInt(state.now - 1_800),
    });
    fills.push({
      id: `scale-${orderId}`, orderId, longId: item.longId, maker, taker: BUYER, recipient: BUYER,
      units: 100n, price, premium: price, sellerFee: 0n, makerRebate: 0n,
      primary: true, takerIsBuyer: true, buyer: BUYER, seller: maker,
      ts: BigInt(state.now - 900), block: 30_000n + orderId, logIndex: Number(orderId), tx,
    });
  }
  // As deployed, the book is on the Clearinghouse minter allow-list and every writer made it its operator;
  // without both the take skips every write ask, and so does the API.
  const orderBook = process.env.V2_ORDER_BOOK!.toLowerCase() as `0x${string}`;
  const writers = [...new Set(orders.map((order) => order.maker))];
  await database.transaction(async (tx) => {
    await tx.insert(schema.v2Minter).values({ minter: orderBook, allowed: true, changedAt: BigInt(state.now - 3_600),
      changedBlock: 1n, changedTx: TX(1) });
    await tx.insert(schema.v2Account).values(writers.map((account) => ({ account,
      operators: JSON.stringify({ [orderBook]: true }), firstSeen: BigInt(state.now - 3_600), lastSeen: BigInt(state.now - 3_600) })));
    await tx.insert(schema.v2Order).values(orders);
    await tx.insert(schema.v2Ledger).values([...ledgers.values()]);
    await tx.insert(schema.v2Fill).values(fills);
  });
}

type RouteSample = { p95: number; minimum: number; maximum: number; calibrationMs: number };

async function sampleRoute(path: string, validate: (body: unknown) => void): Promise<RouteSample> {
  const { clearCache } = await import("../src/api/cache");
  const elapsed: number[] = [];
  const calibrationBefore = await calibrationMs(pg);
  for (let attempt = 0; attempt < SAMPLE_COUNT + 2; attempt++) {
    clearCache();
    const started = performance.now();
    const response = await app.request(`http://localhost${path}`);
    const body: unknown = await response.json();
    const duration = performance.now() - started;
    expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
    validate(body);
    if (attempt >= 2) elapsed.push(duration);
  }
  return {
    p95: percentile95(elapsed),
    minimum: Math.min(...elapsed),
    maximum: Math.max(...elapsed),
    calibrationMs: (calibrationBefore + await calibrationMs(pg)) / 2,
  };
}

beforeAll(async () => {
  expect(state.now).toBe(SCALE_HEAD);
  const date = vi.spyOn(Date, "now").mockReturnValue(state.now * 1_000);
  restoreDateNow = () => date.mockRestore();
  pg = new PGlite();
  await createScaleSchema(pg);
  const database = drizzle({ client: pg, schema });
  state.db = database;
  await database.insert(schema.v2CalendarHoliday).values(HOLIDAY_ROWS.map((row, index) => ({
    dayIndex: row.dayIndex,
    isHoliday: true,
    changedAt: BigInt(state.now - 10_000),
    changedBlock: 9_000n + BigInt(index),
    changedTx: TX(50_000 + index),
  })));
  await import("../src/v2/clearinghouse");
  fixture = await replaySelectedLadder(database);
  const checkpoint = `${state.now.toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"40000".padStart(16, "0")}`;
  await pg.query("INSERT INTO _ponder_checkpoint VALUES ($1)", [checkpoint]);
  await seedApiActivity(database, fixture.series);
  app = new Hono().route("/v2", (await import("../src/api/v2/index")).v2App);
}, 120_000);

afterAll(async () => {
  restoreDateNow?.();
  await pg?.close();
});

describe("v2 selected-20 scale harness", () => {
  it("builds every table ponder.schema.ts exports, so a table a route starts reading cannot go missing", async () => {
    expect(tables.length, "tables read off ponder.schema").toBe(SOURCE_TABLE_COUNT);
    expect(SOURCE_TABLE_COUNT).toBeGreaterThan(100);
    expect(enums.length).toBeGreaterThan(0);
    expect(await schemaDrift(pg)).toEqual([]);
    expect(tables.map((table) => getTableConfig(table).name)).toContain("v2_oracle_market_config");
  });

  it("replays the approved generated ladder through real Clearinghouse handlers in event order", async () => {
    expect(shape).toMatchObject({
      marketCount: 20,
      additionCount: 19,
      requestedSeriesCount: 500,
      overlapDeduplicated: 50,
      seriesCount: 450,
      calls: 450,
      puts: 0,
      // The registry lists six dailies and no weekly; the harness measures its own weekly-on stress
      // shape (SCALE_EXPIRIES_AHEAD), so the committed ceilings keep covering that load.
      defaultExpiriesAhead: { daily: 6, weekly: 0 },
      stressExpiriesAhead: { daily: 3, weekly: 2 },
      expiries: {
        daily: [1_800_046_800, 1_800_392_400, 1_800_478_800],
        weekly: [1_800_046_800, 1_800_651_600],
      },
    });
    expect(new Set(SCALE_TICKERS).size).toBe(20);
    expect(SCALE_TICKERS).toContain("NVDA");
    expect((SCALE_TICKERS as readonly string[])).not.toContain("SGOV");
    expect(shape.markets.reduce((sum, market) => sum + market.dailySeries, 0)).toBe(200);
    expect(shape.markets.reduce((sum, market) => sum + market.weeklySeries, 0)).toBe(250);
    expect(shape.markets.reduce((sum, market) => sum + market.series, 0)).toBe(450);
    expect(fixture.eventCounts).toEqual({ marketRegistered: 20, seriesCreated: 450 });
    expect(state.reads).toEqual({ symbol: 20, calendar: 0, isWeekly: 0, mintCutoff: 450 });
    expect((await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM v2_market")).rows[0]?.count).toBe("20");
    expect((await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM v2_series")).rows[0]?.count).toBe("450");
    expect((await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM v2_order")).rows[0]?.count).toBe("450");
    expect((await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM v2_calendar_holiday")).rows[0]?.count)
      .toBe(String(HOLIDAY_ROWS.length));
    expect(fixture.handlerReplayMs / fixture.handlerReplayCalibrationMs, "handlerReplay per calibration")
      .toBeLessThan(baseline.ceilingsPerCalibration.handlerReplay);

    const { clearCache } = await import("../src/api/cache");
    clearCache();
    const ids: string[] = [];
    const pageSizes: number[] = [];
    const cursors: Array<string | null> = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await app.request(`http://localhost/v2/cards?${query}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: { series: { longId: string } }[]; nextCursor: string | null };
      ids.push(...body.items.map((card) => card.series.longId));
      pageSizes.push(body.items.length);
      cursor = body.nextCursor;
      cursors.push(cursor);
    } while (cursor !== null);
    expect(cursors).toEqual(["200", "400", null]);
    expect(pageSizes).toEqual([200, 200, 50]);
    expect(ids).toHaveLength(shape.seriesCount);
    expect(new Set(ids).size).toBe(shape.seriesCount);
  });

  it("pins measured provenance and keeps every ceiling below a ten-times regression", () => {
    expect(baseline.baseCommit).toBe("the pre-launch indexer tree measured on 2026-09-24");
    expect(baseline.registryProjectionSha256).toBe(cardRegistry.projectionSha256);
    expect(baseline.shape).toEqual({
      markets: 20,
      additions: 19,
      requestedSeries: 500,
      overlapDeduplicated: 50,
      series: 450,
      calls: 450,
      puts: 0,
    });
    // The ceilings are on metric / same-run calibration (see CALIBRATION_ROWS), with the same 4x-10x rule.
    expect(baseline.calibration).toMatchObject({ rows: CALIBRATION_ROWS, repeats: CALIBRATION_REPEATS });
    for (const key of METRIC_KEYS) {
      expect(baseline.ceilingsPerCalibration[key], `${key} ceiling must leave at least 4x baseline headroom`)
        .toBeGreaterThanOrEqual(baseline.metricsPerCalibration[key] * 4);
      expect(baseline.ceilingsPerCalibration[key], `${key} ceiling must fail a 10x baseline regression`)
        .toBeLessThan(baseline.metricsPerCalibration[key] * 10);
    }
  });

  it("measures uncached API p95 and enforces the committed regression ceilings", async () => {
    const detailId = fixture.series[Math.floor(fixture.series.length / 2)]!.longId;
    const nvdaId = fixture.firstByTicker.get("NVDA")!;
    const nvdaSeriesCount = fixture.series.filter((item) => item.market.ticker === "NVDA").length;
    const markets = await sampleRoute("/v2/markets", (body) => {
      expect(body).toBeInstanceOf(Array);
      expect(body as unknown[]).toHaveLength(shape.marketCount);
    });
    const cards = await sampleRoute("/v2/cards?limit=200", (body) => {
      expect(body).toMatchObject({ items: expect.any(Array), nextCursor: "200" });
      expect((body as { items: unknown[] }).items).toHaveLength(200);
    });
    const marketSeries = await sampleRoute("/v2/markets/NVDA/series?limit=50", (body) => {
      expect(body).toMatchObject({ items: expect.any(Array), nextCursor: null });
      expect((body as { items: unknown[] }).items).toHaveLength(nvdaSeriesCount);
    });
    const seriesDetail = await sampleRoute(`/v2/series/${detailId}`, (body) => {
      expect(body).toMatchObject({ series: { longId: detailId.toString() } });
    });
    expect((await (await app.request(`http://localhost/v2/series/${nvdaId}`)).json()))
      .toMatchObject({ series: { ticker: "NVDA" } });

    const measured: Record<MetricKey, Normalized> = {
      handlerReplay: normalized(fixture.handlerReplayMs, fixture.handlerReplayCalibrationMs),
      marketsP95: normalized(markets.p95, markets.calibrationMs),
      cardsP95: normalized(cards.p95, cards.calibrationMs),
      marketSeriesP95: normalized(marketSeries.p95, marketSeries.calibrationMs),
      seriesDetailP95: normalized(seriesDetail.p95, seriesDetail.calibrationMs),
    };
    const report = {
      provenance: baseline.provenance,
      machine: { node: process.version, platform: process.platform, arch: process.arch,
        cpu: cpus()[0]?.model ?? "unknown" },
      samples: SAMPLE_COUNT,
      shape: baseline.shape,
      handlerReplay: {
        ms: roundedMs(fixture.handlerReplayMs), events: fixture.eventCounts, reads: state.reads,
        includes: ["Clearinghouse:MarketRegistered", "Clearinghouse:SeriesCreated",
          "v2_calendar_holiday SQL classification"],
        excludes: ["orders", "fills", "RPC transport"],
      },
      uncachedP95Ms: {
        markets: roundedMs(markets.p95), cards: roundedMs(cards.p95),
        marketSeries: roundedMs(marketSeries.p95), seriesDetail: roundedMs(seriesDetail.p95),
      },
      rangesMs: {
        markets: [roundedMs(markets.minimum), roundedMs(markets.maximum)],
        cards: [roundedMs(cards.minimum), roundedMs(cards.maximum)],
        marketSeries: [roundedMs(marketSeries.minimum), roundedMs(marketSeries.maximum)],
        seriesDetail: [roundedMs(seriesDetail.minimum), roundedMs(seriesDetail.maximum)],
      },
      calibrationMs: Object.fromEntries(METRIC_KEYS.map((key) => [key, roundedMs(measured[key].calibrationMs)])),
      perCalibration: Object.fromEntries(METRIC_KEYS.map((key) => [key, Math.round(measured[key].ratio * 10_000) / 10_000])),
      baselinePerCalibration: baseline.metricsPerCalibration,
      ceilingsPerCalibration: baseline.ceilingsPerCalibration,
    };
    console.info(`[v2-scale] ${JSON.stringify(report)}`);
    for (const key of METRIC_KEYS) {
      expect(measured[key].ratio, `${key}: ${roundedMs(measured[key].ms)} ms / ${roundedMs(measured[key].calibrationMs)} ms calibration`)
        .toBeLessThan(baseline.ceilingsPerCalibration[key]);
    }
  }, 120_000);
});
