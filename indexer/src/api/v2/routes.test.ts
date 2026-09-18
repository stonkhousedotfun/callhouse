import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../ponder.schema";
import { ROUTES } from "./schema";

const state = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_START_BLOCK ??= "100";
  return { db: null as unknown, now: 1_800_000_000, failedSpot: null as string | null };
});

vi.mock("ponder:api", () => ({ get db() { return state.db; }, publicClients: {} }));
vi.mock("ponder:schema", () => ({ ...schema, default: schema }));
vi.mock("../../../lib/v2/pricing", () => ({
  fetchFairQuote: async () => null,
  fetchPricingSpot: async () => 200_000_000n,
}));
vi.mock("./chain", () => ({
  readSpots: async (assets: string[]) => new Map(assets.filter((asset) => asset.toLowerCase() !== state.failedSpot).map((asset) => [asset.toLowerCase(),
    { price: 200_000_000n, updatedAt: state.now }])),
  readFree: async () => new Map(),
}));

const MARKET = "0x0000000000000000000000000000000000000011" as const;
const BUYER = "0x0000000000000000000000000000000000000022" as const;
const WRITER = "0x0000000000000000000000000000000000000033" as const;
const RECIPIENT = "0x0000000000000000000000000000000000000044" as const;
const USDG = "0x0000000000000000000000000000000000000001" as const;
const TX = `0x${"1".repeat(64)}` as `0x${string}`;
const TX2 = `0x${"2".repeat(64)}` as `0x${string}`;
const TX3 = `0x${"3".repeat(64)}` as `0x${string}`;
const WIN_ID = `2-${BUYER}`;
const epoch = BigInt(Math.floor(state.now / 604_800) * 604_800);
let pg: PGlite;
let app: Hono;

/** Ponder onchainTable objects are Drizzle tables; make their actual columns in an in-memory Postgres. */
async function createTables(client: PGlite) {
  for (const [name, table] of Object.entries(schema)) {
    if (!name.startsWith("v2") || typeof table !== "object" || table === null) continue;
    let config: ReturnType<typeof getTableConfig>;
    try { config = getTableConfig(table as Parameters<typeof getTableConfig>[0]); }
    catch { continue; }
    if (!config.columns?.length) continue;
    const columns = config.columns.map((column) => {
      const rawType = column.getSQLType();
      const sqlType = rawType.startsWith("v2_") ? "text" : rawType;
      return `"${column.name}" ${sqlType}${column.primary ? " PRIMARY KEY" : ""}`;
    });
    await client.exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
  }
  await client.exec("CREATE TABLE _ponder_checkpoint (latest_checkpoint text)");
  const checkpoint = `${state.now.toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"105".padStart(16, "0")}`;
  await client.query("INSERT INTO _ponder_checkpoint VALUES ($1)", [checkpoint]);
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(state.now * 1000));
  pg = new PGlite();
  await createTables(pg);
  state.db = drizzle({ client: pg, schema });
  app = new Hono().route("/v2", (await import("./index")).v2App);
  const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
  await database.insert(schema.v2Market).values({ underlying: MARKET, ticker: "TEST", enabled: true,
    mintPaused: false, strikeTick: 1_000_000n, exerciseFeeBps: 25, mintFeePpm: 0, oracle: MARKET,
    status: "live", registeredAt: 1n, registeredBlock: 1n, registeredTx: TX,
    seriesCreated: 1, seriesOpen: 1, openInterestUnits: 100n, volumeUnits: 100n,
    volumeUsdg: 3_000_000n, premiumUsdg: 3_000_000n, feesUsdg: 100_000n,
    lastBlock: 100n, lastTimestamp: BigInt(state.now) });
  await database.insert(schema.v2Series).values({ longId: 2n, underlying: MARKET, ticker: "TEST",
    isPut: false, strike: 210_000_000n, expiry: BigInt(state.now + 86_400), tenor: "daily",
    mintCutoff: BigInt(state.now + 80_000), oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "open",
    settlementPrice: 250_000_000n, longPayoutPerUnit: 1_596_000_000_000_000n,
    feePerUnit: 4_000_000_000_000n, shortPayoutPerUnit: 8_400_000_000_000_000n,
    openInterestUnits: 100n, volumeUnits: 100n, volumeUsdg: 3_000_000n, lastPrice: 3_000_000n,
    createdAt: BigInt(state.now - 1000), createdBlock: 90n, createdTx: TX });
  await database.insert(schema.v2Series).values({ longId: 4n, underlying: MARKET, ticker: "TEST",
    isPut: false, strike: 220_000_000n, expiry: BigInt(state.now + 86_400), tenor: "daily",
    mintCutoff: BigInt(state.now + 80_000), oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "open",
    settlementPrice: 250_000_000n, longPayoutPerUnit: 1_197_000_000_000_000n,
    feePerUnit: 3_000_000_000_000n, shortPayoutPerUnit: 8_800_000_000_000_000n,
    openInterestUnits: 100n, volumeUnits: 0n, volumeUsdg: 0n,
    createdAt: BigInt(state.now - 1000), createdBlock: 90n, createdTx: TX });
  await database.insert(schema.v2Series).values([
    { longId: 6n, underlying: MARKET, ticker: "TEST", isPut: false, strike: 210_000_000n,
      expiry: BigInt(state.now - 86_400), tenor: "daily", mintCutoff: BigInt(state.now - 88_200),
      oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "settled", settlementPrice: 250_000_000n,
      longPayoutPerUnit: 1_596_000_000_000_000n, feePerUnit: 4_000_000_000_000n,
      shortPayoutPerUnit: 8_400_000_000_000_000n, settledAt: BigInt(state.now - 30),
      settledTx: TX, settledBlock: 101n, settledLogIndex: 3,
      openInterestUnits: 100n, volumeUnits: 100n, volumeUsdg: 3_000_000n,
      createdAt: BigInt(state.now - 200_000), createdBlock: 80n, createdTx: TX },
    { longId: 8n, underlying: MARKET, ticker: "TEST", isPut: false, strike: 220_000_000n,
      expiry: BigInt(state.now - 86_400), tenor: "daily", mintCutoff: BigInt(state.now - 88_200),
      oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "settled", settlementPrice: 250_000_000n,
      longPayoutPerUnit: 1_197_000_000_000_000n, feePerUnit: 3_000_000_000_000n,
      shortPayoutPerUnit: 8_800_000_000_000_000n, settledAt: BigInt(state.now - 20),
      settledTx: TX, settledBlock: 102n, settledLogIndex: 2,
      openInterestUnits: 100n, volumeUnits: 100n, volumeUsdg: 3_000_000n,
      createdAt: BigInt(state.now - 200_000), createdBlock: 80n, createdTx: TX },
  ]);
  await database.insert(schema.v2Settlement).values({ id: `${MARKET}-${state.now + 86_400}`,
    underlying: MARKET, expiry: BigInt(state.now + 86_400), status: "Finalized",
    price: 250_000_000n, sourceIndex: 0, corroborated: true, recordedSources: "{}",
    finalizedAt: BigInt(state.now - 40), finalizedTx: TX, finalizedBlock: 101n,
    finalizedLogIndex: 2 });
  await database.insert(schema.v2Settlement).values({ id: `${MARKET}-${state.now - 86_400}`,
    underlying: MARKET, expiry: BigInt(state.now - 86_400), status: "Finalized",
    price: 250_000_000n, sourceIndex: 0, corroborated: true, recordedSources: "{}",
    finalizedAt: BigInt(state.now - 1000), finalizedTx: TX, finalizedBlock: 95n,
    finalizedLogIndex: 2 });
  await database.insert(schema.v2Balance).values({ id: `2-${BUYER}`, tokenId: 2n,
    holder: BUYER, longId: 2n, side: "long", units: 100n });
  await database.insert(schema.v2Lot).values({ id: `2-${BUYER}-1`, longId: 2n, holder: BUYER,
    seq: 1, units: 100n, unitsRemaining: 100n, costUsdg: 3_100_000n,
    costRemainingUsdg: 3_100_000n, acquiredAt: BigInt(state.now - 60), source: "fill", sourceId: "fill-1" });
  await database.insert(schema.v2Order).values({ orderId: 1n, maker: WRITER, longId: 2n,
    kind: "AskWrite", price: 3_000_000n, units: 200n, filled: 0n,
    validUntil: BigInt(state.now + 3600), status: "open", placedAt: BigInt(state.now - 120),
    placedBlock: 100n, placedTx: TX, updatedAt: BigInt(state.now - 120) });
  await database.insert(schema.v2Order).values({ orderId: 2n, maker: BUYER, longId: 2n,
    kind: "AskResale", price: 3_000_000n, units: 10n, filled: 0n,
    validUntil: BigInt(state.now - 10), status: "expired", placedAt: BigInt(state.now - 120),
    placedBlock: 100n, placedTx: TX, updatedAt: BigInt(state.now - 120) });
  await database.insert(schema.v2Ledger).values({ id: `${WRITER}-${MARKET}`, account: WRITER,
    asset: MARKET, free: 2n * 10n ** 18n });
  await database.insert(schema.v2Fill).values({ id: "fill-1", orderId: 1n, longId: 2n,
    maker: WRITER, taker: BUYER, recipient: BUYER, buyer: BUYER, seller: WRITER, units: 100n, price: 3_000_000n,
    premium: 3_000_000n, sellerFee: 150_000n, makerRebate: 50_000n, primary: true,
    takerIsBuyer: true, ts: BigInt(state.now - 60), block: 100n, logIndex: 2, tx: TX });
  await database.insert(schema.v2Fill).values([
    { id: "fill-2", orderId: 1n, longId: 2n, maker: WRITER, taker: BUYER, recipient: RECIPIENT,
      buyer: RECIPIENT, seller: WRITER, units: 10n, price: 3_000_000n, premium: 300_000n,
      sellerFee: 15_000n, makerRebate: 5_000n, primary: true, takerIsBuyer: true,
      ts: BigInt(state.now - 50), block: 101n, logIndex: 1, tx: TX2 },
    { id: "fill-unsafe", orderId: 1n, longId: 2n, maker: WRITER, taker: BUYER, recipient: BUYER,
      buyer: BUYER, seller: WRITER, units: 10n, price: 3_000_000n, premium: 300_000n,
      sellerFee: 15_000n, makerRebate: 5_000n, primary: true, takerIsBuyer: true,
      ts: BigInt(state.now - 10), block: 103n, logIndex: 1, tx: TX3 },
  ]);
  await database.insert(schema.v2Take).values([
    { id: "take-1", taker: BUYER, longId: 2n, buying: true, units: 100n,
      premium: 3_000_000n, takerFee: 100_000n,
      ts: BigInt(state.now - 60), block: 100n, logIndex: 3, tx: TX },
    { id: "take-2", taker: BUYER, longId: 2n, buying: true, units: 10n,
      premium: 300_000n, takerFee: 10_000n,
      ts: BigInt(state.now - 50), block: 101n, logIndex: 2, tx: TX2 },
    { id: "take-unsafe", taker: BUYER, longId: 2n, buying: true, units: 10n,
      premium: 300_000n, takerFee: 10_000n,
      ts: BigInt(state.now - 10), block: 103n, logIndex: 2, tx: TX3 },
  ]);
  await database.insert(schema.v2WriterSeriesPremium).values({ id: `2-${WRITER}`,
    longId: 2n, writer: WRITER, premiumUsdg: 3_480_000n });
  await database.insert(schema.v2Redemption).values({ id: "redeem-1", tokenId: 6n, longId: 6n,
    side: "long", holder: BUYER, to: BUYER, units: 10n, asset: USDG, amount: 1_596_000n,
    amountInKind: 15_960_000_000_000_000n, toLedger: false, realisedDeltaUsdg: 900_000n,
    ts: BigInt(state.now - 10),
    block: 102n, logIndex: 3, tx: TX });
  await database.insert(schema.v2CalendarHoliday).values({
    dayIndex: Math.floor(state.now / 86_400) + 1, isHoliday: true,
    changedAt: BigInt(state.now - 100), changedBlock: 100n, changedTx: TX,
  });
  await database.insert(schema.v2Strategy).values({ id: `${WRITER}-${MARKET}`, writer: WRITER,
    underlying: MARKET, ticker: "TEST", active: true, weekly: true, smartPricing: true,
    otmBps: 200, askBps: 300, minAskBps: 100, maxAskBps: 500,
    maxUnits: 100n, currentLongId: 2n, orderId: 1n, expiry: BigInt(state.now + 86_400),
    lastRolledAt: BigInt(state.now - 120), updatedAt: BigInt(state.now - 120) });
  await database.insert(schema.v2PositionPnl).values({ id: WIN_ID, longId: 2n, holder: BUYER,
    unitsBought: 100n, costUsdg: 3_100_000n, unitsSold: 0n, proceedsUsdg: 0n,
    unitsRedeemed: 100n, payoutUsdgValue: 6_200_000n, realisedUsdg: 3_100_000n,
    multiple: "2", multiplePpm: 2_000_000n, closedAt: BigInt(state.now - 30), closedTx: TX,
    selfFill: false, belowMinCost: false, offMarket: false, transferIn: false,
    transferredOut: false, unitsTransferredOut: 0n, spotAtEntry: 200_000_000n });
  const { windowStarts } = await import("../../../lib/v2/windows");
  await database.insert(schema.v2Leaderboard).values({ id: `week-${windowStarts(BigInt(state.now)).week}-${BUYER}`,
    window: "week", windowStart: windowStarts(BigInt(state.now)).week, holder: BUYER,
    bestMultiplePpm: 2_000_000n, absoluteRealisedUsdg: 3_100_000n, streak: 1,
    wins: 1, losses: 0, bestWinId: WIN_ID, updatedAt: BigInt(state.now) });
  await database.insert(schema.v2MakerEpoch).values({ id: `${WRITER}-${epoch}`, maker: WRITER,
    epoch, tierBps: 50, samples: 10, twoSidedSamples: 5, uptimePpm: 500_000n,
    avgSpreadBps: 100n, depthWithin100bps: 100n, fills: 1, volumeUsdg: 3_000_000n,
    rebatesUsdg: 50_000n, scorePpm: 750_000n });
  await database.insert(schema.v2CashFlow).values({ id: "cash-1", kind: "deposit", account: BUYER,
    actor: WRITER, asset: USDG, amount: 10_000_000n, ts: BigInt(state.now - 100), block: 99n, logIndex: 1, tx: TX });
});

afterAll(async () => { vi.useRealTimers(); await pg?.close(); });

const routes = [
  "/v2/health", "/v2/config", "/v2/markets", "/v2/calendar/holidays", "/v2/markets/TEST/series",
  "/v2/series/2", "/v2/series/2/book", "/v2/series/2/holders", "/v2/series/2/trades",
  "/v2/cards", "/v2/cards/hero", `/v2/accounts/${BUYER}/positions`,
  `/v2/accounts/${BUYER}/history`, "/v2/feed/wins", "/v2/feed/activity?since=0",
  "/v2/strategies?active=1", "/v2/leaderboard", `/v2/pnl/${WIN_ID}`,
  "/v2/stats", "/v2/makers", `/v2/makers/${WRITER}`, "/v2/fair/2",
];

describe("v2 API with seeded PGlite", () => {
  const list = async (response: Response) => await response.json() as {
    items: Array<Record<string, any>>; nextCursor: string | null;
  };
  it("exposes series-pinned native rent and uses the indexed checkpoint for writer capacity", async () => {
    const { clearCache } = await import("../cache");
    await pg.query("UPDATE v2_series SET mint_fee_ppm = 80, mint_fees_held = 123456789012345, mint_fees_accrued = 9876 WHERE long_id = 2");
    await pg.query("UPDATE v2_market SET mint_fee_ppm = 300 WHERE underlying = $1", [MARKET]);
    try {
      clearCache();
      const series = await (await app.request("http://localhost/v2/series/2")).json() as any;
      expect(series.series).toMatchObject({ mintFeePpm: 80,
        mintFeesHeld: { raw: "123456789012345", decimals: 18 }, mintFeesAccrued: { raw: "9876", decimals: 18 } });
      const markets = await (await app.request("http://localhost/v2/markets")).json() as any[];
      expect(markets[0].mintFeePpm).toBe(300);
      const book = await (await app.request("http://localhost/v2/series/2/book")).json() as any;
      expect(book).toMatchObject({ updatedBlock: "105", snapshotTimestamp: state.now });
      expect(book.asks[0].orders[0]).toMatchObject({ units: "199", onChainRemainingUnits: "200",
        makerFreeUnits: "199", makerFreeCollateral: { raw: "2000000000000000000", decimals: 18 } });
      const config = await (await app.request("http://localhost/v2/config")).json() as any;
      expect(config).toMatchObject({ interfaceVersion: 7, fees: { premiumFeeBps: 0, mintFeePpm: 80 },
        constants: { mintFeePeriod: 604800, mintFeeCeilPpm: 5000 } });
    } finally {
      await pg.query("UPDATE v2_series SET mint_fee_ppm = 0, mint_fees_held = 0, mint_fees_accrued = 0 WHERE long_id = 2");
      await pg.query("UPDATE v2_market SET mint_fee_ppm = 0 WHERE underlying = $1", [MARKET]);
      clearCache();
    }
  });

  it("retries a book read when indexing commits after its starting checkpoint", async () => {
    const { clearCache } = await import("../cache");
    const machine = await import("./machine");
    const originalHead = machine.indexedHead;
    const oldCheckpoint = `${state.now.toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"105".padStart(16, "0")}`;
    const newCheckpoint = `${(state.now + 1).toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"106".padStart(16, "0")}`;
    const headRead = vi.spyOn(machine, "indexedHead").mockImplementationOnce(async () => {
      const oldHead = await originalHead();
      // Mimic an atomic Ponder publication after the API captured its initial head.
      await pg.transaction(async (tx) => {
        await tx.query("UPDATE v2_ledger SET free = 10000000000000000 WHERE account = $1 AND asset = $2", [WRITER, MARKET]);
        await tx.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [newCheckpoint]);
      });
      return oldHead;
    });
    try {
      clearCache();
      const response = await app.request("http://localhost/v2/series/2/book");
      expect(response.status).toBe(200);
      const book = await response.json() as any;
      expect(book).toMatchObject({ updatedBlock: "106", snapshotTimestamp: state.now + 1 });
      expect(book.asks[0].orders[0]).toMatchObject({ units: "1",
        makerFreeCollateral: { raw: "10000000000000000", decimals: 18 } });
      expect(headRead).toHaveBeenCalledTimes(4);
    } finally {
      headRead.mockRestore();
      await pg.query("UPDATE v2_ledger SET free = 2000000000000000000 WHERE account = $1 AND asset = $2", [WRITER, MARKET]);
      await pg.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [oldCheckpoint]);
      clearCache();
    }
  });

  it.each(["/series/2/book", "/cards"])("refuses and does not cache %s while the full checkpoint keeps changing", async (route) => {
    const { clearCache } = await import("../cache");
    const machine = await import("./machine");
    const head = (await machine.indexedHead())!;
    let revision = 0;
    // Same block and timestamp, different event positions: comparing only block/time is unsafe.
    const headRead = vi.spyOn(machine, "indexedHead").mockImplementation(async () => ({
      ...head, checkpoint: `${head.checkpoint}${String(++revision).padStart(33, "0")}`,
    }));
    try {
      clearCache();
      const response = await app.request(`http://localhost/v2${route}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "snapshot_changing" } });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(headRead).toHaveBeenCalledTimes(6);
      headRead.mockRestore();
      const retry = await app.request(`http://localhost/v2${route}`);
      expect(retry.status).toBe(200);
      expect(retry.headers.get("x-cache")).toBe("MISS");
    } finally { headRead.mockRestore(); clearCache(); }
  });

  it("returns native mint fees/refunds separately from USDG realised PnL", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    const series = (await database.select().from(schema.v2Series)).find((s) => s.longId === 2n)!;
    await database.insert(schema.v2Series).values({ ...series, longId: 14n, isPut: true, mintFeePpm: 80 });
    for (const [longId, fee, feeRefund] of [[2n, 123456789n, 12345n], [14n, 321n, 123n]] as const) {
      await database.insert(schema.v2Mint).values({ id: `rent-mint-${longId}`, longId, writer: WRITER, longTo: WRITER,
        units: 1n, collateral: longId === 2n ? 10n ** 16n : 2_100_000n, fee,
        ts: BigInt(state.now - 60), block: 100n, logIndex: 5, tx: TX });
      await database.insert(schema.v2Close).values({ id: `rent-close-${longId}`, longId, account: WRITER,
        units: 1n, collateralFreed: longId === 2n ? 10n ** 16n : 2_100_000n, feeRefund, realisedDeltaUsdg: -500n,
        ts: BigInt(state.now - 30), block: 101n, logIndex: 5, tx: TX });
    }
    try {
      clearCache();
      const result = await list(await app.request(`http://localhost/v2/accounts/${WRITER}/history`));
      expect(result.items.find((item) => item.id === "rent-mint-2")?.data.fee).toMatchObject({ raw: "123456789", decimals: 18 });
      expect(result.items.find((item) => item.id === "rent-mint-14")?.data.fee).toMatchObject({ raw: "321", decimals: 6 });
      expect(result.items.find((item) => item.id === "rent-close-2")?.data).toMatchObject({
        feeRefund: { raw: "12345", decimals: 18 }, realisedPnl: { raw: "-500", decimals: 6 } });
      expect(result.items.find((item) => item.id === "rent-close-14")?.data.feeRefund).toMatchObject({ raw: "123", decimals: 6 });
    } finally {
      await pg.query("DELETE FROM v2_mint WHERE id LIKE 'rent-mint-%'");
      await pg.query("DELETE FROM v2_close WHERE id LIKE 'rent-close-%'");
      await pg.query("DELETE FROM v2_series WHERE long_id = 14");
      clearCache();
    }
  });

  it("feeds a stale ask withdrawal once and keeps the active strategy visible without an order", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    await database.insert(schema.v2StaleCancel).values({ id: "stale-cancel-1", writer: WRITER, underlying: MARKET,
      longId: 2n, orderId: 1n, spot: 215_000_000n, spotUpdatedAt: BigInt(state.now - 35),
      ts: BigInt(state.now - 30), block: 102n, logIndex: 5, tx: TX });
    await pg.query("UPDATE v2_strategy SET order_id = NULL, last_stale_cancel_at = $1, stale_spot = 215000000", [state.now - 30]);
    try {
      clearCache();
      const feed = await list(await app.request("http://localhost/v2/feed/activity?since=0&kinds=stale_cancel"));
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0]).toMatchObject({ id: "stale-cancel-1", kind: "stale_cancel", accounts: [WRITER],
        data: { orderId: "1", spot: { raw: "215000000", decimals: 6 },
          spotUpdatedAt: state.now - 35, nextRollAfter: state.now + 86_400 } });
      const strategy = await list(await app.request("http://localhost/v2/strategies?active=1"));
      expect(strategy.items[0]).toMatchObject({ strategy: { active: true }, currentLongId: "2", orderId: null,
        lastStaleCancelAt: state.now - 30, staleSpot: { raw: "215000000" }, expiry: state.now + 86_400 });
      const position = await (await app.request(`http://localhost/v2/accounts/${WRITER}/positions`)).json() as any;
      expect(position.strategies[0]).toMatchObject({ currentSeries: { longId: "2" }, orderId: null,
        lastStaleCancelAt: state.now - 30, staleSpot: { raw: "215000000" } });
    } finally {
      await pg.query("DELETE FROM v2_stale_cancel WHERE id = 'stale-cancel-1'");
      await pg.query("UPDATE v2_strategy SET order_id = 1, last_stale_cancel_at = NULL, stale_spot = NULL");
      clearCache();
    }
  });

  it("caps both sides even when hundreds of orders share one price level", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { BOOK_ORDERS_PER_SIDE } = await import("./bookData");
    const rows = Array.from({ length: BOOK_ORDERS_PER_SIDE + 1 }, (_, index) => index).reverse();
    await database.insert(schema.v2Order).values(rows.flatMap((index) => ([
      { orderId: BigInt(10_000 + index), maker: BUYER, longId: 4n,
        kind: "AskResale" as const, price: 3_000_000n, units: 1n, filled: 0n,
        validUntil: BigInt(state.now + 3600), status: "open" as const,
        placedAt: BigInt(state.now - 120), placedBlock: 100n, placedTx: TX,
        updatedAt: BigInt(state.now - 120) },
      { orderId: BigInt(20_000 + index), maker: BUYER, longId: 4n,
        kind: "Bid" as const, price: 2_000_000n, units: 1n, filled: 0n,
        validUntil: BigInt(state.now + 3600), status: "open" as const,
        placedAt: BigInt(state.now - 120), placedBlock: 100n, placedTx: TX,
        updatedAt: BigInt(state.now - 120) },
    ])));
    const { clearCache } = await import("../cache");
    clearCache();
    const queries = vi.spyOn(pg, "query");
    try {
      const response = await app.request("http://localhost/v2/series/4/book?depth=1");
      expect(response.status, await response.clone().text()).toBe(200);
      const book = await response.json() as { asks: { units: string; orders: { orderId: string; units: string }[] }[];
        bids: { units: string; orders: { orderId: string; units: string }[] }[] };
      for (const [levels, firstId] of [[book.asks, 10_000], [book.bids, 20_000]] as const) {
        expect(levels).toHaveLength(1);
        expect(levels[0]!.orders).toHaveLength(BOOK_ORDERS_PER_SIDE);
        expect(levels[0]!.orders.map((order) => order.orderId)).toEqual(
          Array.from({ length: BOOK_ORDERS_PER_SIDE }, (_, index) => String(firstId + index)));
        expect(levels[0]!.units).toBe(levels[0]!.orders.reduce(
          (sum, order) => sum + BigInt(order.units), 0n).toString());
      }
      const orderQueries = queries.mock.calls.map(([statement]) => String(statement).toLowerCase())
        .filter((statement) => statement.includes('from "v2_order"'));
      expect(orderQueries).toHaveLength(2);
      expect(orderQueries.every((statement) => statement.includes("limit") && statement.includes("order by"))).toBe(true);
    } finally {
      queries.mockRestore();
      await pg.query("DELETE FROM v2_order WHERE order_id >= $1 AND order_id < $2", [10_000n, 21_000n]);
      clearCache();
    }
  });

  it.each(routes)("serves %s in the frozen shape", async (path) => {
    const response = await app.request(`http://localhost${path}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const pathname = new URL(path, "http://localhost").pathname;
    const spec = ROUTES.find((entry) => new RegExp(`^${entry.route.replace(/:[^/]+/g, "[^/]+")}$`).test(pathname));
    expect(spec).toBeDefined();
    const parsed = spec!.schema.safeParse(await response.json());
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.flatten())).toBe(true);
  });

  it("aggregates market premiums in SQL by underlying and time window", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const alternate = "0x0000000000000000000000000000000000000055" as const;
    const [marketSeed] = await database.select().from(schema.v2Market).limit(1);
    const [seriesSeed] = await database.select().from(schema.v2Series).limit(1);
    const [fillSeed] = await database.select().from(schema.v2Fill).limit(1);
    await database.insert(schema.v2Market).values({ ...marketSeed!, underlying: alternate, ticker: "ALT", oracle: alternate });
    await database.insert(schema.v2Series).values({ ...seriesSeed!, longId: 10n, underlying: alternate,
      ticker: "ALT", oracle: alternate });
    await database.insert(schema.v2Fill).values([
      { ...fillSeed!, id: "market-alt-recent", longId: 10n, premium: 700_000n, ts: BigInt(state.now - 60) },
      { ...fillSeed!, id: "market-alt-older", longId: 10n, premium: 200_000n, ts: BigInt(state.now - 2 * 86_400) },
      { ...fillSeed!, id: "market-test-stale", longId: 2n, premium: 2_000_000n, ts: BigInt(state.now - 8 * 86_400) },
    ]);
    const { clearCache } = await import("../cache");
    clearCache();
    const queries = vi.spyOn(pg, "query");
    try {
      const response = await app.request("http://localhost/v2/markets");
      expect(response.status).toBe(200);
      const markets = await response.json() as { ticker: string; expiries: number[];
        stats: { volume24h: { raw: string }; premium7d: { raw: string } } }[];
      expect(markets.find((market) => market.ticker === "TEST")).toMatchObject({
        expiries: [state.now + 86_400],
        stats: { volume24h: { raw: "3600000" }, premium7d: { raw: "3600000" } },
      });
      expect(markets.find((market) => market.ticker === "ALT")).toMatchObject({
        expiries: [state.now + 86_400],
        stats: { volume24h: { raw: "700000" }, premium7d: { raw: "900000" } },
      });
      const statements = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      const expiries = statements.find((statement) => statement.includes('from "v2_series"') && statement.includes("distinct"));
      expect(expiries).toContain('"status"');
      expect(expiries).toContain("where");
      const premiums = statements.find((statement) => statement.includes('from "v2_fill"') && statement.includes("sum("));
      expect(premiums).toContain('join "v2_series"');
      expect(premiums).toContain('"ts"');
      expect(premiums).toContain("where");
      expect(premiums).toContain("group by");
    } finally {
      queries.mockRestore();
      await pg.query("DELETE FROM v2_fill WHERE id IN ($1, $2, $3)",
        ["market-alt-recent", "market-alt-older", "market-test-stale"]);
      await pg.query("DELETE FROM v2_series WHERE long_id = $1", [10n]);
      await pg.query("DELETE FROM v2_market WHERE underlying = $1", [alternate]);
      clearCache();
    }
  });

  it("keeps healthy markets available when one live oracle spot fails", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const alternate = "0x0000000000000000000000000000000000000055" as const;
    const [seed] = await database.select().from(schema.v2Market).limit(1);
    await database.insert(schema.v2Market).values({ ...seed!, underlying: alternate, ticker: "ALT", oracle: alternate });
    const { clearCache } = await import("../cache");
    try {
      state.failedSpot = alternate.toLowerCase();
      clearCache();
      const response = await app.request("http://localhost/v2/markets");
      expect(response.status).toBe(200);
      const markets = ROUTES.find((route) => route.route === "/v2/markets")!.schema.parse(await response.json()) as
        { ticker: string; spot: { raw: string } | null; spotUpdatedAt: number | null }[];
      expect(markets.find((market) => market.ticker === "TEST")).toMatchObject({ spot: { raw: "200000000" }, spotUpdatedAt: state.now });
      expect(markets.find((market) => market.ticker === "ALT")).toMatchObject({ spot: null, spotUpdatedAt: null });

      state.failedSpot = MARKET.toLowerCase();
      clearCache();
      const swapped = ROUTES.find((route) => route.route === "/v2/markets")!.schema.parse(
        await (await app.request("http://localhost/v2/markets")).json()) as typeof markets;
      expect(swapped.find((market) => market.ticker === "TEST")).toMatchObject({ spot: null, spotUpdatedAt: null });
      expect(swapped.find((market) => market.ticker === "ALT")).toMatchObject({ spot: { raw: "200000000" }, spotUpdatedAt: state.now });
    } finally {
      state.failedSpot = null;
      await pg.query("DELETE FROM v2_market WHERE underlying = $1", [alternate]);
      clearCache();
    }
  });

  it("keeps fillable cards when their oracle spot is temporarily unavailable", async () => {
    const { clearCache } = await import("../cache");
    clearCache();
    const live = ROUTES.find((route) => route.route === "/v2/cards")!.schema.parse(
      await (await app.request("http://localhost/v2/cards?ticker=TEST")).json()) as
      { items: { spot: { raw: string } | null }[] };
    expect(live.items.length).toBeGreaterThan(0);
    expect(live.items.every((card) => card.spot?.raw === "200000000")).toBe(true);
    try {
      state.failedSpot = MARKET.toLowerCase();
      clearCache();
      const unavailable = ROUTES.find((route) => route.route === "/v2/cards")!.schema.parse(
        await (await app.request("http://localhost/v2/cards?ticker=TEST")).json()) as typeof live;
      expect(unavailable.items).toHaveLength(live.items.length);
      expect(unavailable.items.every((card) => card.spot === null)).toBe(true);
      const hero = ROUTES.find((route) => route.route === "/v2/cards/hero")!.schema.parse(
        await (await app.request("http://localhost/v2/cards/hero")).json()) as { card: unknown };
      expect(hero.card).toBeNull();
    } finally {
      state.failedSpot = null;
      clearCache();
    }
  });

  it("filters and pages a market's series in SQL and aggregates only page volumes", async () => {
    const { clearCache } = await import("../cache");
    clearCache();
    const queries = vi.spyOn(pg, "query");
    try {
      const route = `http://localhost/v2/markets/TEST/series?expiry=${state.now + 86_400}&type=call&status=open&limit=1`;
      const first = await list(await app.request(route));
      expect(first.items.map((item) => item.series.longId)).toEqual(["2"]);
      expect(first.items[0]!.volume24h.raw).toBe("3600000");
      expect(first.nextCursor).toBe("1");
      const second = await list(await app.request(`${route}&cursor=${first.nextCursor}`));
      expect(second.items.map((item) => item.series.longId)).toEqual(["4"]);
      expect(second.items[0]!.volume24h.raw).toBe("0");
      expect(second.nextCursor).toBeNull();
      const settled = await list(await app.request("http://localhost/v2/markets/TEST/series?status=settled&limit=1"));
      expect(settled.items.map((item) => item.series.longId)).toEqual(["6"]);
      expect(settled.nextCursor).toBe("1");
      const statements = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      const pages = statements.filter((statement) => statement.includes('from "v2_series"') &&
        statement.includes("order by"));
      expect(pages).toHaveLength(3);
      for (const statement of pages) {
        expect(statement).toContain("where");
        expect(statement).toContain("limit");
        expect(statement).toContain('"expiry"');
        expect(statement).toContain('"strike"');
      }
      expect(pages.some((statement) => statement.includes("offset"))).toBe(true);
      const volumes = statements.filter((statement) => statement.includes('from "v2_fill"') && statement.includes("sum("));
      expect(volumes).toHaveLength(3);
      expect(volumes.every((statement) => statement.includes('"long_id"') && statement.includes('"ts"') &&
        statement.includes("where") && statement.includes("group by"))).toBe(true);
    } finally {
      queries.mockRestore();
      clearCache();
    }
  });

  it("filters cards from candidates with live asks", async () => {
    const { clearCache } = await import("../cache");
    clearCache();
    const queries = vi.spyOn(pg, "query");
    try {
      const response = await app.request("http://localhost/v2/cards?ticker=TEST&tenor=daily&type=call");
      expect(response.status).toBe(200);
      const cards = await list(response);
      expect(cards.items.length).toBeGreaterThan(0);
      expect(cards.items.every((item) => item.series.ticker === "TEST" && item.series.tenor === "daily" &&
        item.series.isPut === false)).toBe(true);
      const statements = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      const series = statements.find((statement) => statement.includes('from "v2_series"'));
      expect(series).toContain("where");
      for (const field of ['"status"', '"expiry"', "exists", '"kind"']) expect(series).toContain(field);
      const orders = statements.find((statement) => statement.includes('from "v2_order"') &&
        !statement.includes('from "v2_series"'));
      expect(orders).toContain("where");
      for (const field of ['"long_id"', '"status"', '"valid_until"', '"kind"']) expect(orders).toContain(field);
    } finally {
      queries.mockRestore();
      clearCache();
    }
  });

  it("shares one card computation across cache-busting URLs and hero", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const seed = (await database.select().from(schema.v2Series)).find((row) => row.longId === 2n);
    const unrelated = Array.from({ length: 100 }, (_, i) => 10_000n + BigInt(i * 2));
    await database.insert(schema.v2Series).values(unrelated.map((longId) => ({ ...seed!, longId })));
    const { clearCache } = await import("../cache");
    clearCache();
    const queries = vi.spyOn(pg, "query");
    try {
      const responses = await Promise.all([
        app.request("http://localhost/v2/cards?limit=1&nonce=a"),
        app.request("http://localhost/v2/cards?limit=1&nonce=b"),
        app.request("http://localhost/v2/cards?ticker=TEST&nonce=c"),
        app.request("http://localhost/v2/cards/hero?nonce=d"),
      ]);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      const first = await list(responses[0]!);
      const second = await list(responses[1]!);
      expect(first.items).toEqual(second.items);
      const statements = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      const seriesQueries = statements.flatMap((statement, i) => statement.includes('from "v2_series"') ? [i] : []);
      expect(seriesQueries).toHaveLength(1);
      const seriesResult = await queries.mock.results[seriesQueries[0]!]!.value as { rows: unknown[] };
      expect(seriesResult.rows).toHaveLength(1);
      expect(statements.filter((statement) => statement.includes('from "v2_order"') &&
        !statement.includes('from "v2_series"'))).toHaveLength(1);
      vi.advanceTimersByTime(14_000);
      const late = await app.request("http://localhost/v2/cards?nonce=late");
      expect(late.headers.get("cache-control")).toBe("public, max-age=1");
      expect((await late.json() as { generatedAt: number }).generatedAt).toBe(state.now);
      vi.advanceTimersByTime(1_001);
      const refreshed = await app.request("http://localhost/v2/cards?nonce=late");
      expect(refreshed.headers.get("x-cache")).toBe("MISS");
      expect((await refreshed.json() as { generatedAt: number }).generatedAt).toBe(state.now + 15);
      expect(queries.mock.calls.filter(([statement]) => String(statement).toLowerCase().includes('from "v2_series"')))
        .toHaveLength(2);
    } finally {
      queries.mockRestore();
      await pg.query("DELETE FROM v2_series WHERE long_id >= $1", [10_000n]);
      vi.setSystemTime(new Date(state.now * 1000));
      clearCache();
    }
  });

  it("keeps global hero eligibility when the highest-multiple card is outside its ladder", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const seed = (await database.select().from(schema.v2Order)).find((row) => row.orderId === 1n)!;
    await database.insert(schema.v2Order).values({ ...seed, orderId: 10_000n,
      longId: 4n, price: 1_000_000n });
    const { clearCache } = await import("../cache");
    try {
      clearCache();
      const cards = await list(await app.request("http://localhost/v2/cards?sort=multiple&limit=1"));
      expect(cards.items[0]?.series.longId).toBe("4");
      const hero = await (await app.request("http://localhost/v2/cards/hero")).json() as
        { card: { series: { longId: string } } | null };
      expect(hero.card?.series.longId).toBe("2");
    } finally {
      await pg.query("DELETE FROM v2_order WHERE order_id = $1", [10_000n]);
      clearCache();
    }
  });

  it("distinguishes oracle finalization from each series' actual settlement", async () => {
    const pendingSeries = await app.request("http://localhost/v2/series/2");
    expect(pendingSeries.status).toBe(200);
    const pending = await pendingSeries.json() as { settlement: { finalizedAt: number; settledAt: number | null } };
    expect(pending.settlement.finalizedAt).toBe(state.now - 40);
    expect(pending.settlement.settledAt).toBeNull();

    const settledSeries = await app.request("http://localhost/v2/series/6");
    expect(settledSeries.status).toBe(200);
    const settled = await settledSeries.json() as { settlement: { finalizedAt: number; settledAt: number | null } };
    expect(settled.settlement.finalizedAt).toBe(state.now - 1000);
    expect(settled.settlement.settledAt).toBe(state.now - 30);
  });

  it("keeps the notifier cursor stable across pages and excludes the three newest blocks", async () => {
    const first = await list(await app.request("http://localhost/v2/feed/activity?since=0&kinds=fill&limit=1"));
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.kind).toBe("fill");
    expect(first.items[0]!.id).toBe("fill-1");
    expect(first.items[0]!.data.takerFee.raw).toBe("100000");
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await list(await app.request(`http://localhost/v2/feed/activity?since=0&kinds=fill&limit=1&cursor=${first.nextCursor}`));
    expect(second.items.map((item) => item.id)).toEqual(["fill-2"]);
    expect(second.nextCursor).toBeNull();
    const latest = await list(await app.request("http://localhost/v2/feed/activity?kinds=fill&limit=10"));
    expect(latest.items.map((item) => item.id)).toEqual(["fill-2", "fill-1"]);
    expect(latest.items[0]!.accounts).toContain(RECIPIENT);
    expect(latest.items[0]!.data.recipient).toBe(RECIPIENT);
    const settlementPage = await list(await app.request("http://localhost/v2/feed/activity?since=0&kinds=settlement&limit=1"));
    expect(settlementPage.items[0]!.longId).toBe("6");
    const settlementNext = await list(await app.request(
      `http://localhost/v2/feed/activity?since=0&kinds=settlement&limit=1&cursor=${settlementPage.nextCursor}`));
    expect(settlementNext.items[0]!.longId).toBe("8");
    expect(settlementNext.nextCursor).toBeNull();
  });

  it("rejects out-of-range activity cursor fields", async () => {
    const cursors = [
      ["1", 1e100, "fill-1"],
      ["9223372036854775808", 1, "fill-1"],
    ];
    for (const parts of cursors) {
      const cursor = Buffer.from(JSON.stringify(parts)).toString("base64url");
      const response = await app.request(`http://localhost/v2/feed/activity?kinds=fill&cursor=${cursor}`);
      expect(response.status).toBe(400);
    }
    const oversized = "a".repeat(513);
    expect((await app.request(`http://localhost/v2/feed/activity?cursor=${oversized}`)).status).toBe(400);
    expect((await app.request(`http://localhost/v2/feed/activity?since=${"9".repeat(20)}`)).status).toBe(400);
    expect((await app.request("http://localhost/v2/feed/activity?since=9223372036854775808")).status).toBe(400);
    expect((await app.request(`http://localhost/v2/feed/activity?kinds=${"fill,".repeat(20)}`)).status).toBe(400);
  });

  it("bounds public list cursors and numeric IDs before querying", async () => {
    const huge = "9".repeat(79);
    for (const route of [
      `/v2/series/${huge}`, `/v2/series/${huge}/book`,
      `/v2/markets/TEST/series?expiry=${huge}`,
      "/v2/feed/wins?cursor=10001", "/v2/leaderboard?cursor=9999999999999999",
      "/v2/markets/TEST/series?cursor=10001", "/v2/series/2/trades?cursor=10001",
      "/v2/cards?cursor=10001", "/v2/makers?cursor=10001",
      `/v2/makers?epoch=${huge}`,
      `/v2/series/2/holders?cursor=${"x".repeat(1_000)}`,
      `/v2/strategies?cursor=${"x".repeat(1_000)}`,
    ]) {
      expect((await app.request(`http://localhost${route}`)).status, route).toBe(400);
    }
  });

  it("bounds activity series reads to the requested page even with old settled series", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const seed = (await database.select().from(schema.v2Series))
      .find((row) => row.longId === 6n)!;
    const oldIds = Array.from({ length: 100 }, (_, i) => 10_000n + BigInt(i * 2));
    await database.insert(schema.v2Series).values(oldIds.map((longId, i) => ({
      ...seed, longId, settledBlock: 80n, settledLogIndex: i + 1,
      settledAt: BigInt(state.now - 86_400),
    })));
    const { clearCache } = await import("../cache");
    try {
      clearCache();
      const queries = vi.spyOn(pg, "query");
      const fills = await list(await app.request("http://localhost/v2/feed/activity?kinds=fill&limit=1"));
      const fillStatements = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      expect(fills.items).toHaveLength(1);
      const fillSeriesIndex = fillStatements.findIndex((statement) => statement.includes('from "v2_series"'));
      const fillSeries = fillStatements[fillSeriesIndex];
      expect(fillSeries).toContain("where");
      expect(fillSeries).toContain(" in ");
      const fillSeriesResult = await queries.mock.results[fillSeriesIndex]!.value as { rows: unknown[] };
      expect(fillSeriesResult.rows).toHaveLength(1);
      queries.mockRestore();

      clearCache();
      const settlementQueries = vi.spyOn(pg, "query");
      const settlements = await list(await app.request("http://localhost/v2/feed/activity?kinds=settlement&limit=1"));
      const settlementStatements = settlementQueries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      expect(settlements.items.map((item) => item.longId)).toEqual(["8"]);
      const settlementSeriesIndex = settlementStatements.findIndex((statement) => statement.includes('from "v2_series"'));
      const settlementSeries = settlementStatements[settlementSeriesIndex];
      expect(settlementSeries).toContain("where");
      expect(settlementSeries).toContain("limit");
      const settlementSeriesResult = await settlementQueries.mock.results[settlementSeriesIndex]!.value as { rows: unknown[] };
      expect(settlementSeriesResult.rows).toHaveLength(2);
      settlementQueries.mockRestore();

      clearCache();
      const sinceQueries = vi.spyOn(pg, "query");
      const sinceSettlement = await list(await app.request(
        `http://localhost/v2/feed/activity?kinds=settlement&since=${state.now - 120}&limit=1`));
      expect(sinceSettlement.items.map((item) => item.longId)).toEqual(["6"]);
      const sinceSeries = sinceQueries.mock.calls.flatMap(([statement], i) =>
        String(statement).toLowerCase().includes('from "v2_series"') ? [i] : []);
      expect(sinceSeries).toHaveLength(2);
      const floorSql = String(sinceQueries.mock.calls[sinceSeries[0]!]![0]).toLowerCase();
      expect(floorSql).toContain('order by "v2_series"."settled_at" asc, "v2_series"."settled_block" asc');
      expect(floorSql).toContain("limit");
      const floorResult = await sinceQueries.mock.results[sinceSeries[0]!]!.value as { rows: unknown[] };
      expect(floorResult.rows).toHaveLength(1);
      const pageSql = String(sinceQueries.mock.calls[sinceSeries[1]!]![0]).toLowerCase();
      expect(pageSql).toContain('"v2_series"."settled_block" >=');
      const pageResult = await sinceQueries.mock.results[sinceSeries[1]!]!.value as { rows: unknown[] };
      expect(pageResult.rows).toHaveLength(2);
      sinceQueries.mockRestore();

      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        clearCache();
        const params = new URLSearchParams({ kinds: "fill,settlement,redemption",
          since: String(state.now - 120), limit: "1" });
        if (cursor !== null) params.set("cursor", cursor);
        const page = await list(await app.request(`http://localhost/v2/feed/activity?${params}`));
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null && ids.length < 10);
      expect(ids).toEqual(["fill-1", "fill-2", `${TX}-3-6`, `${TX}-2-8`, "redeem-1"]);
    } finally {
      await pg.query("DELETE FROM v2_series WHERE long_id >= $1", [10_000n]);
      clearCache();
    }
  });

  it("emits settlements after oracle finalization and prices redemptions", async () => {
    const settlements = await list(await app.request(
      `http://localhost/v2/feed/activity?since=${state.now - 35}&kinds=settlement`));
    expect(settlements.items.map((item) => [item.longId, item.ts])).toEqual([
      ["6", state.now - 30], ["8", state.now - 20],
    ]);
    expect(settlements.items[0]!.data.tx).toBe(TX);
    const redemption = await list(await app.request("http://localhost/v2/feed/activity?kinds=redemption"));
    expect(redemption.items[0]!.data.settlementPrice.raw).toBe("250000000");
  });

  it("returns session days and retains expired resale orders until cancellation", async () => {
    const day = Math.floor(state.now / 86_400);
    const calendarResponse = await app.request(
      `http://localhost/v2/calendar/holidays?fromDay=${day}&toDay=${day + 2}`);
    expect(calendarResponse.status).toBe(200);
    const calendar = await calendarResponse.json() as { items: { dayIndex: number; isHoliday: boolean; isSessionDay: boolean }[] };
    expect(calendar.items).toHaveLength(3);
    expect(calendar.items[1]).toMatchObject({ dayIndex: day + 1, isHoliday: true, isSessionDay: false });
    for (const item of calendar.items) {
      const weekday = new Date(item.dayIndex * 86_400_000).getUTCDay();
      expect(item.isSessionDay).toBe(weekday !== 0 && weekday !== 6 && !item.isHoliday);
    }
    expect((await app.request(`http://localhost/v2/calendar/holidays?fromDay=${day}&toDay=${day + 62}`)).status).toBe(400);
    expect((await app.request("http://localhost/v2/calendar/holidays?fromDay=1e3&toDay=1001")).status).toBe(400);
    const positions = await app.request(`http://localhost/v2/accounts/${BUYER}/positions`);
    expect(positions.status).toBe(200);
    const body = await positions.json() as { orders: { orderId: string; validUntil: number }[];
      longs: { series: { longId: string }; units: string }[] };
    expect(body.orders).toContainEqual(expect.objectContaining({ orderId: "2", validUntil: state.now - 10 }));
    expect(body.longs.find((long) => long.series.longId === "2")?.units).toBe("110");
    const writerPositions = await app.request(`http://localhost/v2/accounts/${WRITER}/positions`);
    const writer = await writerPositions.json() as { strategies: { lastRolledAt: number | null }[] };
    expect(writer.strategies[0]!.lastRolledAt).toBe(state.now - 120);
  });

  it("serves wallet holders and active strategies for the cranker", async () => {
    const holders = await list(await app.request("http://localhost/v2/series/2/holders?side=long"));
    expect(holders.items).toEqual([{ holder: BUYER, units: "100" }]);
    const strategies = await list(await app.request("http://localhost/v2/strategies?active=1"));
    expect(strategies.items).toHaveLength(1);
    expect(strategies.items[0]!.writer).toBe(WRITER);
    expect(strategies.items[0]!.currentLongId).toBe("2");
    const inactive = await list(await app.request("http://localhost/v2/strategies?active=0"));
    expect(inactive.items).toEqual([]);
  });

  it("shows a delegated take to the recipient and charges the fee to the taker", async () => {
    const recipientHistory = await list(await app.request(`http://localhost/v2/accounts/${RECIPIENT}/history`));
    expect(recipientHistory.items.map((item) => item.id)).toContain("fill-2");
    const fill = recipientHistory.items.find((item) => item.id === "fill-2")!;
    expect(fill.data.side).toBe("buy");
    expect(fill.data.fee.raw).toBe("0");
    const payerHistory = await list(await app.request(`http://localhost/v2/accounts/${BUYER}/history`));
    expect(payerHistory.items.find((item) => item.id === "fill-2")!.data.fee.raw).toBe("10000");
  });

  it("pages the maker snapshot by an explicit epoch id", async () => {
    const response = await app.request(`http://localhost/v2/makers?epoch=${epoch / 604_800n}&limit=1`);
    const body = await list(response);
    expect(response.status).toBe(200);
    expect(body.items[0]!.maker).toBe(WRITER);
  });

  it("scopes maker snapshots and histories in SQL while preserving epoch order and pages", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const later = epoch + 604_800n;
    const extra = [
      { id: `${BUYER}-${epoch}`, maker: BUYER, epoch, tierBps: 25, scorePpm: 900_000n },
      { id: `${RECIPIENT}-${epoch}`, maker: RECIPIENT, epoch, tierBps: 30, scorePpm: 900_000n },
      { id: `${WRITER}-${later}`, maker: WRITER, epoch: later, tierBps: 60, scorePpm: 100_000n },
    ].map((row) => ({ ...row, samples: 2, twoSidedSamples: 1, uptimePpm: 500_000n,
      avgSpreadBps: 20n, depthWithin100bps: 50n, fills: 2, volumeUsdg: 1_000_000n,
      rebatesUsdg: 10_000n }));
    await database.insert(schema.v2MakerEpoch).values(extra);
    const { clearCache } = await import("../cache");
    clearCache();
    const queries = vi.spyOn(pg, "query");
    try {
      const latest = await app.request("http://localhost/v2/makers?limit=1");
      const latestBody = await list(latest);
      expect(latest.status).toBe(200);
      expect(latestBody.items.map((row) => row.maker)).toEqual([WRITER]);
      expect(latestBody.items[0]).toMatchObject({ tierBps: 60, score: 10, fills: 2,
        volume: { raw: "1000000" } });
      expect(latestBody.nextCursor).toBeNull();

      const first = await list(await app.request(`http://localhost/v2/makers?epoch=${epoch / 604_800n}&limit=2`));
      expect(first.items.map((row) => row.maker)).toEqual([BUYER, RECIPIENT]);
      expect(first.items.map((row) => row.score)).toEqual([90, 90]);
      expect(first.nextCursor).toBe("2");
      const second = await list(await app.request(
        `http://localhost/v2/makers?epoch=${epoch / 604_800n}&limit=2&cursor=${first.nextCursor}`));
      expect(second.items.map((row) => row.maker)).toEqual([WRITER]);
      expect(second.items[0]).toMatchObject({ tierBps: 50, score: 75 });
      expect(second.nextCursor).toBeNull();

      const historyResponse = await app.request(`http://localhost/v2/makers/${WRITER.toUpperCase().replace("0X", "0x")}`);
      const history = await historyResponse.json() as { maker: string; tierBps: number;
        epochs: { epoch: { start: number }; score: number }[] };
      expect(historyResponse.status).toBe(200);
      expect(history.maker).toBe(WRITER);
      expect(history.tierBps).toBe(60);
      expect(history.epochs.map((item) => [item.epoch.start, item.score])).toEqual([
        [Number(later), 10], [Number(epoch), 75],
      ]);
      const missing = await app.request(`http://localhost/v2/makers/${MARKET}`);
      expect(missing.status).toBe(404);
      const outOfRange = await app.request("http://localhost/v2/makers?epoch=999999999999999999999999");
      expect(outOfRange.status).toBe(400);

      const makerQueries = queries.mock.calls.map(([statement]) => String(statement).toLowerCase())
        .filter((statement) => statement.includes('from "v2_maker_epoch"'));
      expect(makerQueries).toHaveLength(8);
      for (const statement of makerQueries.filter((query) => query.includes('select "id"'))) {
        expect(statement).toContain("where");
      }
      const pages = makerQueries.filter((statement) => statement.includes('"score_ppm" desc'));
      expect(pages).toHaveLength(3);
      for (const statement of pages) {
        expect(statement).toContain('where "v2_maker_epoch"."epoch"');
        expect(statement).toContain('"maker" asc');
        expect(statement).toContain("limit");
      }
      expect(pages.some((statement) => statement.includes("offset"))).toBe(true);
      const histories = makerQueries.filter((statement) => statement.includes('lower("v2_maker_epoch"."maker")'));
      expect(histories).toHaveLength(2);
      expect(histories.every((statement) => statement.includes('"epoch" desc'))).toBe(true);
      expect(makerQueries.filter((statement) => statement.includes('"epoch" desc') && statement.includes("limit"))).toHaveLength(3);
    } finally {
      queries.mockRestore();
      await pg.query("DELETE FROM v2_maker_epoch WHERE id IN ($1, $2, $3)", extra.map((row) => row.id));
      clearCache();
    }
  });

  it("attributes primary premiums to the writer for both asks and writes into bids", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const bidTx = `0x${"4".repeat(64)}` as `0x${string}`;
    await database.insert(schema.v2Balance).values([
      { id: `3-${WRITER}`, tokenId: 3n, holder: WRITER, longId: 2n, side: "short", units: 120n },
      { id: `3-${RECIPIENT}`, tokenId: 3n, holder: RECIPIENT, longId: 2n, side: "short", units: 20n },
    ]);
    await database.insert(schema.v2Fill).values({ id: "bid-write", orderId: 3n, longId: 2n,
      maker: WRITER, taker: RECIPIENT, recipient: RECIPIENT, buyer: WRITER, seller: RECIPIENT,
      units: 20n, price: 3_000_000n, premium: 600_000n, sellerFee: 30_000n, makerRebate: 10_000n,
      primary: true, takerIsBuyer: false, ts: BigInt(state.now - 5), block: 104n, logIndex: 2, tx: bidTx });
    await database.insert(schema.v2Take).values({ id: "bid-write-take", taker: RECIPIENT, longId: 2n,
      buying: false, units: 20n, premium: 600_000n, takerFee: 20_000n,
      ts: BigInt(state.now - 5), block: 104n, logIndex: 3, tx: bidTx });
    await database.insert(schema.v2WriterSeriesPremium).values({ id: `2-${RECIPIENT}`,
      longId: 2n, writer: RECIPIENT, premiumUsdg: 550_000n });
    (await import("../cache")).clearCache();

    const askWriter = await app.request(`http://localhost/v2/accounts/${WRITER}/positions`);
    const askBody = await askWriter.json() as { shorts: { premiumReceived: { raw: string } }[] };
    expect(askWriter.status).toBe(200);
    expect(askBody.shorts[0]?.premiumReceived.raw).toBe("3480000");

    const bidWriter = await app.request(`http://localhost/v2/accounts/${RECIPIENT}/positions`);
    const bidBody = await bidWriter.json() as { shorts: { premiumReceived: { raw: string } }[] };
    expect(bidWriter.status).toBe(200);
    expect(bidBody.shorts[0]?.premiumReceived.raw).toBe("550000");
  });

  it("scopes the positions snapshot to reclaimable orders and indexed premiums", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    await database.insert(schema.v2Order).values({ orderId: 900n, maker: WRITER, longId: 2n,
      kind: "AskWrite", price: 3_000_000n, units: 10n, filled: 0n,
      validUntil: BigInt(state.now - 100), status: "cancelled", placedAt: BigInt(state.now - 200),
      placedBlock: 99n, placedTx: TX, updatedAt: BigInt(state.now - 100) });
    const { clearCache } = await import("../cache");
    const queries = vi.spyOn(pg, "query");
    try {
      // These valid historical resale calls share the active short series, but none
      // contributes to the writer's primary premium. The route must not read them.
      for (let start = 0; start < 256; start += 64) {
        const rows = Array.from({ length: 64 }, (_, offset) => {
          const n = start + offset;
          const tx = `0x${(n + 1000).toString(16).padStart(64, "0")}` as `0x${string}`;
          return { id: `positions-irrelevant-${n}`, orderId: BigInt(1000 + n), longId: 2n,
            maker: WRITER, taker: BUYER, recipient: BUYER, buyer: BUYER, seller: WRITER,
            units: 1n, price: 1n, premium: 1n, sellerFee: 0n, makerRebate: 0n,
            primary: false, takerIsBuyer: true, ts: BigInt(state.now - 1000 - n),
            block: BigInt(200 + n), logIndex: 1, tx };
        });
        await database.insert(schema.v2Fill).values(rows);
        await database.insert(schema.v2Take).values(rows.map((row) => ({
          id: `positions-irrelevant-take-${row.orderId}`, taker: BUYER, longId: 2n,
          buying: true, units: 1n, premium: 1n, takerFee: 0n,
          ts: row.ts, block: row.block, logIndex: 2, tx: row.tx,
        })));
      }
      clearCache();
      queries.mockClear();
      const response = await app.request(`http://localhost/v2/accounts/${WRITER}/positions`);
      expect(response.status).toBe(200);
      const positions = await response.json() as { orders: { orderId: string }[];
        shorts: { premiumReceived: { raw: string } }[] };
      expect(positions.orders.map((order) => order.orderId)).toContain("1");
      expect(positions.orders.map((order) => order.orderId)).not.toContain("900");
      expect(positions.shorts[0]?.premiumReceived.raw).toBe("3480000");
      const sqlText = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      for (const table of ["v2_order", "v2_writer_series_premium", "v2_series"]) {
        const statement = sqlText.find((sql) => sql.includes(`from "${table}"`));
        expect(statement, table).toContain("where");
      }
      expect(sqlText.find((sql) => sql.includes('from "v2_order"'))).toContain('"status"');
      expect(sqlText.find((sql) => sql.includes('from "v2_writer_series_premium"'))).toContain('"long_id"');
      expect(sqlText.some((sql) => sql.includes('from "v2_fill"') || sql.includes('from "v2_take"'))).toBe(false);
    } finally {
      queries.mockRestore();
      await pg.query("DELETE FROM v2_order WHERE order_id = $1", [900n]);
      await pg.query("DELETE FROM v2_fill WHERE id LIKE 'positions-irrelevant-%'");
      await pg.query("DELETE FROM v2_take WHERE id LIKE 'positions-irrelevant-%'");
      clearCache();
    }
  });

  it("serves a profitable resale receipt before its series has settled", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const id = `2-${RECIPIENT}`;
    await pg.query("UPDATE v2_series SET settlement_price = NULL WHERE long_id = $1", [2n]);
    await database.insert(schema.v2PositionPnl).values({ id, longId: 2n, holder: RECIPIENT,
      unitsBought: 10n, costUsdg: 300_000n, unitsSold: 10n, proceedsUsdg: 600_000n,
      unitsRedeemed: 0n, payoutUsdgValue: 0n, realisedUsdg: 300_000n,
      multiple: "2", multiplePpm: 2_000_000n, closedAt: BigInt(state.now - 5), closedTx: TX3,
      selfFill: false, belowMinCost: false, offMarket: false, transferIn: false,
      transferredOut: false, unitsTransferredOut: 0n, spotAtEntry: 200_000_000n });
    const { clearCache } = await import("../cache");
    clearCache();
    try {
      const feed = await list(await app.request("http://localhost/v2/feed/wins?window=day"));
      expect(feed.items.map((item) => item.id)).toContain(id);
      const first = await list(await app.request("http://localhost/v2/feed/wins?window=day&limit=1"));
      expect(first.items[0]?.id).toBe(id);
      expect(first.nextCursor).toBe("1");
      const second = await list(await app.request(
        `http://localhost/v2/feed/wins?window=day&limit=1&cursor=${first.nextCursor}`));
      expect(second.items[0]?.id).toBe(WIN_ID);
      const response = await app.request(`http://localhost/v2/pnl/${id}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { settlementPrice: unknown; payout: { raw: string }; entryPrice: { raw: string } };
      expect(body.settlementPrice).toBeNull();
      expect(body.payout.raw).toBe("600000");
      expect(body.entryPrice.raw).toBe("3000000");
      expect(ROUTES.find((route) => route.route === "/v2/pnl/:id")?.schema.safeParse(body).success).toBe(true);
    } finally {
      await pg.query("DELETE FROM v2_position_pnl WHERE id = $1", [id]);
      await pg.query("UPDATE v2_series SET settlement_price = $1 WHERE long_id = $2", [250_000_000n, 2n]);
      clearCache();
    }
  });

  it("pages public wins and leaderboard rows in SQL and aggregates stats in SQL", async () => {
    const { clearCache } = await import("../cache");
    clearCache();
    const queries = vi.spyOn(pg, "query");
    try {
      expect((await app.request("http://localhost/v2/feed/wins?limit=1")).status).toBe(200);
      expect((await app.request("http://localhost/v2/leaderboard?limit=1")).status).toBe(200);
      const statsResponse = await app.request("http://localhost/v2/stats");
      expect(statsResponse.status).toBe(200);
      const stats = await statsResponse.json() as { contractsFilled: string; holders: number };
      expect(stats.contractsFilled).toBe("100");
      expect(stats.holders).toBe(3);
      const statements = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
      expect(statements.some((text) => text.includes('from "v2_position_pnl"') && text.includes("where") && text.includes("limit"))).toBe(true);
      expect(statements.some((text) => text.includes('from "v2_leaderboard"') && text.includes("where") && text.includes("limit"))).toBe(true);
      expect(statements.some((text) => text.includes('from "v2_fill"') && text.includes("sum("))).toBe(true);
    } finally {
      queries.mockRestore();
      clearCache();
    }
  });

  it("removes an invalidated best win before leaderboard pagination", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { windowStarts } = await import("../../../lib/v2/windows");
    const epoch = windowStarts(BigInt(state.now)).week;
    const staleId = `stale-${WRITER}`;
    const staleRankId = `week-${epoch}-${WRITER}`;
    await database.insert(schema.v2PositionPnl).values({ id: staleId, longId: 2n, holder: WRITER,
      unitsBought: 100n, costUsdg: 1_000_000n, unitsSold: 100n, proceedsUsdg: 4_000_000n,
      unitsRedeemed: 0n, payoutUsdgValue: 0n, realisedUsdg: 3_000_000n,
      multiple: "4", multiplePpm: 4_000_000n, closedAt: BigInt(state.now - 20), closedTx: TX,
      selfFill: false, belowMinCost: false, offMarket: false, transferIn: true,
      transferredOut: false, unitsTransferredOut: 0n });
    await database.insert(schema.v2Leaderboard).values({ id: staleRankId,
      window: "week", windowStart: epoch, holder: WRITER,
      bestMultiplePpm: 4_000_000n, absoluteRealisedUsdg: 3_000_000n, streak: 1,
      wins: 1, losses: 0, bestWinId: staleId, updatedAt: BigInt(state.now) });
    try {
      const { clearCache } = await import("../cache");
      clearCache();
      const result = await list(await app.request("http://localhost/v2/leaderboard?metric=multiple&limit=1"));
      expect(result.items).toEqual([expect.objectContaining({ rank: 1, holder: BUYER })]);
      expect(result.nextCursor).toBeNull();
    } finally {
      await pg.query("DELETE FROM v2_leaderboard WHERE id = $1", [staleRankId]);
      await pg.query("DELETE FROM v2_position_pnl WHERE id = $1", [staleId]);
      (await import("../cache")).clearCache();
    }
  });

  it("assigns each taker fee to its own call when one transaction takes twice", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const multiTx = `0x${"5".repeat(64)}` as `0x${string}`;
    await database.insert(schema.v2Fill).values([
      { id: "multi-a", orderId: 4n, longId: 2n, maker: WRITER, taker: BUYER, recipient: BUYER,
        buyer: BUYER, seller: WRITER, units: 10n, price: 1_000_000n, premium: 100_000n,
        sellerFee: 1_000n, makerRebate: 0n, primary: false, takerIsBuyer: true,
        realisedDeltaUsdg: 20_000n,
        ts: BigInt(state.now - 40), block: 101n, logIndex: 5, tx: multiTx },
      { id: "multi-b", orderId: 5n, longId: 2n, maker: WRITER, taker: BUYER, recipient: BUYER,
        buyer: BUYER, seller: WRITER, units: 10n, price: 1_000_000n, premium: 100_000n,
        sellerFee: 1_000n, makerRebate: 0n, primary: false, takerIsBuyer: true,
        realisedDeltaUsdg: 30_000n,
        ts: BigInt(state.now - 40), block: 101n, logIndex: 7, tx: multiTx },
    ]);
    await database.insert(schema.v2Take).values([
      { id: "multi-take-a", taker: BUYER, longId: 2n, buying: true, units: 10n,
        premium: 100_000n, takerFee: 3_000n, ts: BigInt(state.now - 40),
        block: 101n, logIndex: 6, tx: multiTx },
      { id: "multi-take-b", taker: BUYER, longId: 2n, buying: true, units: 10n,
        premium: 100_000n, takerFee: 5_000n, ts: BigInt(state.now - 40),
        block: 101n, logIndex: 8, tx: multiTx },
    ]);
    (await import("../cache")).clearCache();

    const activity = await list(await app.request("http://localhost/v2/feed/activity?since=0&kinds=fill&limit=200"));
    expect(activity.items.find((item) => item.id === "multi-a")?.data.takerFee.raw).toBe("3000");
    expect(activity.items.find((item) => item.id === "multi-b")?.data.takerFee.raw).toBe("5000");

    const history = await list(await app.request(`http://localhost/v2/accounts/${BUYER}/history`));
    expect(history.items.find((item) => item.id === "multi-a")?.data.fee.raw).toBe("3000");
    expect(history.items.find((item) => item.id === "multi-b")?.data.fee.raw).toBe("5000");
    expect(history.items.find((item) => item.id === "multi-a")?.data.realisedPnl).toBeNull();
    const sellerHistory = await list(await app.request(`http://localhost/v2/accounts/${WRITER}/history`));
    expect(sellerHistory.items.find((item) => item.id === "multi-a")?.data.realisedPnl.raw).toBe("20000");
    expect(sellerHistory.items.find((item) => item.id === "multi-b")?.data.realisedPnl.raw).toBe("30000");
    expect(history.items.find((item) => item.id === "redeem-1")?.data.realisedPnl.raw).toBe("900000");
  });

  it("filters history in SQL and keeps pages stable when a newer event arrives", async () => {
    const cache = await import("../cache");
    cache.clearCache();
    const queries = vi.spyOn(pg, "query");
    const first = await list(await app.request(`http://localhost/v2/accounts/${BUYER}/history?limit=1`));
    const statements = queries.mock.calls.map(([statement]) => String(statement).toLowerCase());
    queries.mockRestore();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    for (const table of ["v2_fill", "v2_mint", "v2_close", "v2_redemption", "v2_cash_flow"]) {
      const statement = statements.find((item) => item.includes(`from "${table}"`));
      expect(statement, table).toBeDefined();
      expect(statement, table).toContain("where");
      expect(statement, table).toContain("limit");
    }

    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    await database.insert(schema.v2CashFlow).values({ id: "newer-cashflow", kind: "deposit",
      account: BUYER, actor: BUYER, asset: USDG, amount: 1_000_000n,
      ts: BigInt(state.now), block: 104n, logIndex: 9,
      tx: `0x${"6".repeat(64)}` as `0x${string}` });
    cache.clearCache();
    const second = await list(await app.request(
      `http://localhost/v2/accounts/${BUYER}/history?limit=1&cursor=${first.nextCursor}`));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.items[0]!.id).not.toBe("newer-cashflow");
  });

  it("switches config and card fees at the indexed block time, even when the host clock has not advanced", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const id = process.env.V2_ORDER_BOOK as `0x${string}`;
    const pendingAt = BigInt(state.now + 100);
    const checkpoint = (ts: number, block: number) =>
      `${ts.toString().padStart(10, "0")}${"4663".padStart(16, "0")}${block.toString().padStart(16, "0")}`;
    try {
      await database.insert(schema.v2OrderBookState).values({
        id, tradingPaused: false, premiumFeeBps: 500, resaleFeeBps: 0,
        takerFeeFlat: 100_000n, takerFeeCapBps: 1_000, makerRebateBps: 100,
        pendingPremiumFeeBps: 300, pendingResaleFeeBps: 0,
        pendingTakerFeeFlat: 0n, pendingTakerFeeCapBps: 0, pendingMakerRebateBps: 0,
        pendingEffectiveAt: pendingAt, updatedAt: BigInt(state.now),
      });
      clearCache();
      const beforeResponse = await app.request("http://localhost/v2/config");
      expect(beforeResponse.headers.get("cache-control")).toBe("no-store");
      const beforeConfig = await beforeResponse.json() as any;
      const beforeCards = await (await app.request("http://localhost/v2/cards")).json() as any;
      expect(beforeConfig.fees.takerFeeFlat.raw).toBe("100000");
      expect(beforeConfig.pendingFees).toEqual({ premiumFeeBps: 300, resaleFeeBps: 0,
        takerFeeFlat: { raw: "0", decimals: 6, formatted: "0" }, takerFeeCapBps: 0,
        makerRebateBps: 0, effectiveAt: state.now + 100 });
      const beforeCost = BigInt(beforeCards.items[0].perUnit.cost.raw);

      await pg.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [checkpoint(state.now + 100, 106)]);
      const afterConfig = await (await app.request("http://localhost/v2/config")).json() as any;
      clearCache();
      const afterCards = await (await app.request("http://localhost/v2/cards")).json() as any;
      expect(afterConfig.fees.takerFeeFlat.raw).toBe("0");
      expect(afterConfig.pendingFees).toBeNull();
      expect(BigInt(afterCards.items[0].perUnit.cost.raw)).toBeLessThan(beforeCost);
      // A later schedule that retains the now-effective policy is a cancellation, not a warning.
      await pg.query(`UPDATE v2_order_book_state SET premium_fee_bps = 300,
        resale_fee_bps = 0, taker_fee_flat = 0, taker_fee_cap_bps = 0,
        maker_rebate_bps = 0, pending_premium_fee_bps = 300,
        pending_resale_fee_bps = 0, pending_taker_fee_flat = 0,
        pending_taker_fee_cap_bps = 0, pending_maker_rebate_bps = 0,
        pending_effective_at = $1 WHERE id = $2`, [BigInt(state.now + 200), id]);
      await pg.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [checkpoint(state.now + 100, 107)]);
      clearCache();
      const cancelled = await (await app.request("http://localhost/v2/config")).json() as any;
      expect(cancelled.pendingFees).toBeNull();
    } finally {
      await pg.query("DELETE FROM v2_order_book_state WHERE id = $1", [id]);
      await pg.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [checkpoint(state.now, 105)]);
      clearCache();
    }
  });

  it("keeps the stored active fee for config and cards when the indexed checkpoint is absent", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const id = process.env.V2_ORDER_BOOK as `0x${string}`;
    const checkpoint = `${state.now.toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"105".padStart(16, "0")}`;
    clearCache();
    const baselineCards = await (await app.request("http://localhost/v2/cards")).json() as any;
    try {
      await database.insert(schema.v2OrderBookState).values({
        id, tradingPaused: false, premiumFeeBps: 500, resaleFeeBps: 0,
        takerFeeFlat: 100_000n, takerFeeCapBps: 1_000, makerRebateBps: 100,
        pendingPremiumFeeBps: 300, pendingResaleFeeBps: 0,
        pendingTakerFeeFlat: 0n, pendingTakerFeeCapBps: 0, pendingMakerRebateBps: 0,
        pendingEffectiveAt: BigInt(state.now - 100), updatedAt: BigInt(state.now - 200),
      });
      await pg.query("DELETE FROM _ponder_checkpoint");
      clearCache();
      const config = await (await app.request("http://localhost/v2/config")).json() as any;
      const cards = await (await app.request("http://localhost/v2/cards")).json() as any;
      expect(config.fees.takerFeeFlat.raw).toBe("100000");
      expect(config.pendingFees).toBeNull();
      expect(cards.items[0].perUnit.cost.raw).toBe(baselineCards.items[0].perUnit.cost.raw);
    } finally {
      await pg.query("DELETE FROM v2_order_book_state WHERE id = $1", [id]);
      await pg.query("INSERT INTO _ponder_checkpoint VALUES ($1)", [checkpoint]);
      clearCache();
    }
  });
});

const fixtureRoot = join(import.meta.dirname, "..", "..", "..", "..", "ops", "fixtures", "api", "v2");
function fixtures(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? fixtures(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

describe("v2 fixture and schema drift", () => {
  it("keeps the API registry snapshot aligned with the source projection", () => {
    const script = join(import.meta.dirname, "..", "..", "..", "scripts", "gen-v2-registry.mjs");
    expect(() => execFileSync(process.execPath, [script, "--check"])).not.toThrow();
  });
  it("keeps the producer and consumer schemas byte identical", () => {
    const web = join(import.meta.dirname, "..", "..", "..", "..", "web", "lib", "v2", "api-schema.ts");
    expect(readFileSync(join(import.meta.dirname, "schema.ts"), "utf8")).toBe(readFileSync(web, "utf8"));
  });
  it("parses every committed fixture and covers every frozen route", () => {
    const covered = new Set<string>();
    for (const file of fixtures(fixtureRoot)) {
      const path = `/v2/${relative(fixtureRoot, file).replace(/\.json$/, "").replaceAll("\\", "/")}`;
      const spec = ROUTES.find((entry) => new RegExp(`^${entry.route.replace(/:[^/]+/g, "[^/]+")}$`).test(path));
      expect(spec, file).toBeDefined();
      covered.add(spec!.route);
      const parsed = spec!.schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      expect(parsed.success, file).toBe(true);
    }
    expect(covered).toEqual(new Set(ROUTES.map((route) => route.route)));
  });
});
