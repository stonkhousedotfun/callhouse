import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { ContractFunctionRevertedError, encodeErrorResult, getAddress } from "viem";
import { type MockInstance, afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../ponder.schema";
import { earnVaultAbi } from "../../../abis/v2/earnVault";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { MAKER_BENCHMARK_POLICY } from "../../../lib/v2/makerScoring";
import { CALENDAR_MODE_ID } from "../../../lib/v2/calendar";
import { LIVE_RESPONSE_FIXTURES } from "./live-response.fixture";
import { ROUTES, configResponseSchema, earnResponseSchema, houseMarketResponseSchema } from "./schema";
import { teardown } from "./teardown";

const state = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.USDG ??= "0x0000000000000000000000000000000000000001";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_ACCESS_MANAGER ??= "0x0000000000000000000000000000000000006016";
  process.env.V2_FEE_SPLITTER ??= "0x0000000000000000000000000000000000007001";
  process.env.V2_BUYBACK_EXECUTOR ??= "0x0000000000000000000000000000000000007002";
  process.env.V2_FLYWHEEL_TOKEN_ADDRESS ??= "0x0000000000000000000000000000000000007003";
  process.env.V2_REWARDS_DISTRIBUTORS ??= JSON.stringify([
    { program: "maker", address: "0x0000000000000000000000000000000000005015" },
  ]);
  process.env.V2_MAKER_VAULT ??= "0x0000000000000000000000000000000000005016";
  process.env.V2_EARN_VAULT ??= "0x000000000000000000000000000000000000e011";
  process.env.V2_EARN_START_BLOCK ??= "50";
  process.env.V2_FLYWHEEL_START_BLOCK ??= "50";
  process.env.V2_START_BLOCK ??= "100";
  process.env.PRICING_URL ??= "http://127.0.0.1:8790";
  return { db: null as unknown, now: 1_800_000_000, failedSpot: null as string | null,
    fairResult: { quote: null, reasonCode: null, provenance: null } as any,
    spot: 200_000_000n, fairRequests: 0, fairInFlight: 0, maxFairInFlight: 0,
    yieldFair: false, hangFair: false, spotReads: 0,
    rewardBalances: new Map<string, { balance: bigint; decimals: number }>([
      ["0x0000000000000000000000000000000000005015", { balance: 75_000_000n, decimals: 6 }],
    ]),
    makerVault: {
      assets: [
        { asset: "0x0000000000000000000000000000000000000001", wallet: 12_000_000n, ledger: 3_000_000n },
        { asset: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", wallet: 2n * 10n ** 18n, ledger: 10n ** 18n },
      ],
      limits: { maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n,
        askToleranceBps: 100, maxBidBpsOfSpot: 1_000, maxOrderLifetime: 3_600,
        maxDailyOutflow: 2_500_000_000n },
      outflowUsed: 500_000_000n, liveOrderCount: 3, trackedSeries: [2n, 4n],
    } as any,
    fair: null as null | { fair: bigint; spot: bigint; iv: number; delta: number; asOf: number; source: "cboe" | "model" },
    // The /earn route's live mark reads through `publicClients[CHAIN_NAME].multicall`. Empty by
    // default (no client -> every live field null); a test installs a fake client to drive the other states.
    publicClients: {} as Record<string, { multicall: (args: { contracts: unknown[] }) => Promise<unknown> }> };
});

vi.mock("ponder:api", () => ({ get db() { return state.db; }, get publicClients() { return state.publicClients; } }));
vi.mock("ponder:schema", () => ({ ...schema, default: schema }));
vi.mock("../../../lib/v2/pricing", () => ({
  // Some tests drive this through state.fairResult, others through state.fair and the
  // in-flight counters. Both are kept: the counters always run, and state.fair wins when a
  // test has set it, otherwise the result's quote is returned.
  fetchFairQuote: async () => {
    state.fairRequests += 1;
    state.fairInFlight += 1;
    state.maxFairInFlight = Math.max(state.maxFairInFlight, state.fairInFlight);
    try {
      if (state.hangFair) await new Promise<never>(() => undefined);
      if (state.yieldFair) await Promise.resolve();
      return state.fair ?? state.fairResult.quote;
    } finally {
      state.fairInFlight -= 1;
    }
  },
  fetchFairResult: async () => state.fairResult,
  fetchPricingSpot: async () => 200_000_000n,
}));
vi.mock("./chain", () => ({
  readSpots: async (assets: string[]) => {
    state.spotReads += 1;
    return new Map(assets.filter((asset) => asset.toLowerCase() !== state.failedSpot).map((asset) => [asset.toLowerCase(),
      { price: state.spot, updatedAt: state.now }]));
  },
  readFree: async () => new Map(),
  readRewardBalances: async (distributors: string[]) => new Map(distributors.flatMap((distributor) => {
    const balance = state.rewardBalances.get(distributor.toLowerCase());
    return balance === undefined ? [] : [[distributor.toLowerCase(), balance] as const];
  })),
  readMakerVaultState: async () => state.makerVault,
}));

const MARKET = "0x0000000000000000000000000000000000000011" as const;
const BUYER = "0x0000000000000000000000000000000000000022" as const;
const WRITER = "0x0000000000000000000000000000000000000033" as const;
const RECIPIENT = "0x0000000000000000000000000000000000000044" as const;
const USDG = "0x0000000000000000000000000000000000000001" as const;
/** The Clearinghouse the Earn route reads `free(vault, asset)` from, lowercased as the multicall fakes key it. */
const CLEARINGHOUSE_LEDGER = (process.env.V2_CLEARINGHOUSE as string).toLowerCase();
const ACCESS_MANAGER = "0x0000000000000000000000000000000000006016" as const;
const FEE_SPLITTER = "0x0000000000000000000000000000000000007001" as const;
const FLYWHEEL_TOKEN = "0x0000000000000000000000000000000000007003" as const;
const REWARD_DISTRIBUTOR = "0x0000000000000000000000000000000000005015" as const;
const MAKER_VAULT = "0x0000000000000000000000000000000000005016" as const;
const NVDA_STOCK = V2_REGISTRY.markets.find((market) => market.ticker === "NVDA")!.underlying;
const TX = `0x${"1".repeat(64)}` as `0x${string}`;
const TX2 = `0x${"2".repeat(64)}` as `0x${string}`;
const TX3 = `0x${"3".repeat(64)}` as `0x${string}`;
const WIN_ID = `2-${BUYER}`;
const epoch = BigInt(Math.floor(state.now / 604_800) * 604_800);
const pricingProvenance = {
  contract: "O3-307/1" as const,
  provider: "listed-live",
  providerProduct: "quotes",
  method: "listed" as const,
  methodDetail: "listed-contract",
  contributingExpiries: [state.now + 86_400],
  identity: {
    market: "TEST",
    issuer: null,
    token: { chainId: 4663, address: MARKET, uiMultiplier: null },
    option: { side: "call" as const, strike: { raw: "210000000", decimals: 6, formatted: "210" },
      expiry: state.now + 86_400, timeZone: "America/New_York" as const, exercise: "european" as const,
      payoff: "cash-value" as const, settlement: "oracle-twap" as const },
    listed: [{ providerInstrumentId: "TEST-LISTED", root: "TEST", side: "call" as const, strike: "210",
      expiry: state.now + 86_400, multiplier: 100, exercise: "american", settlement: "physical" }],
  },
  observations: { listedQuotes: [{ providerInstrumentId: "TEST-LISTED", bid: "0.05", ask: "0.1",
    bidSize: "1", askSize: "1", currency: "USD", observedAt: state.now - 10 }], vendorTheoretical: [] },
  clocks: { quoteObservedAt: state.now - 10, tradeObservedAt: null, underlyingObservedAt: state.now - 20,
    volatilityObservedAt: null, publishedAt: state.now - 5, receivedAt: state.now - 2, computedAt: state.now },
  ages: { quoteS: 10, tradeS: null, underlyingS: 20, volatilityS: null },
  entitlement: { class: "real-time" as const, declaredDelayS: 0, rightsRef: "test" },
  expiryClock: { expiry: state.now + 86_400, timeZone: "America/New_York" as const,
    basis: "trading-time" as const, yearsToExpiry: 0.01 },
  quality: { readiness: "ready" as const, reasons: [] as string[], uncertainty: null,
    disagreement: null, fallback: null },
  pricedSpot: { raw: "200000000", decimals: 6, formatted: "200" },
};
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
    lastRolledAt: BigInt(state.now - 120), repriceCount: 0, updatedAt: BigInt(state.now - 120) });
  // The write-on-fill gates a live deployment has. The writer made the book its Clearinghouse operator
  // (OrderBook.sol:1101) and the book is on the minter allow-list (:1091); without them every AskWrite is skipped.
  await database.insert(schema.v2Account).values({ account: WRITER,
    delegates: JSON.stringify({ [process.env.V2_AUTO_ROLLER!.toLowerCase()]: true }),
    operators: JSON.stringify({ [process.env.V2_ORDER_BOOK!.toLowerCase()]: true }),
    firstSeen: BigInt(state.now - 120), lastSeen: BigInt(state.now - 120) });
  await database.insert(schema.v2Minter).values({ minter: process.env.V2_ORDER_BOOK!.toLowerCase() as `0x${string}`,
    allowed: true, changedAt: BigInt(state.now - 120), changedBlock: 100n, changedTx: TX });
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
    epoch, tierBps: 50, benchmarkPolicy: MAKER_BENCHMARK_POLICY,
    // samples is absent + valid; missingReference sits outside it.
    samples: 10, absentSamples: 4, validSamples: 6, missingReferenceSamples: 2,
    twoSidedSamples: 5, uptimePpm: 500_000n,
    // The band figure is the wider one: the 1000 bps band contains the 100 bps one.
    avgSpreadBps: 100n, depthWithin100bps: 100n, depthInBand: 180n, fills: 1, volumeUsdg: 3_000_000n,
    rebatesUsdg: 50_000n, scorePpm: 750_000n });
  await database.insert(schema.v2SelfTradeMaker).values({ maker: WRITER, units: 7n,
    updatedAt: BigInt(state.now - 30), updatedBlock: 103n });
  await database.insert(schema.v2CashFlow).values({ id: "cash-1", kind: "deposit", account: BUYER,
    actor: WRITER, asset: USDG, amount: 10_000_000n, ts: BigInt(state.now - 100), block: 99n, logIndex: 1, tx: TX });
});

afterAll(async () => { vi.useRealTimers(); await pg?.close(); });

describe("v2 API with seeded PGlite", () => {
  const list = async (response: Response) => await response.json() as {
    items: Array<Record<string, any>>; nextCursor: string | null;
  };

  const accessOperation = ({ operationId, nonce, status, block, readyAt = state.now + 3_600 }: {
    operationId: `0x${string}`;
    nonce: number;
    status: "pending" | "executed" | "canceled";
    block: number;
    readyAt?: number;
  }) => ({
    id: `${operationId}:${nonce}`,
    opId: operationId,
    nonce: BigInt(nonce),
    status,
    caller: BUYER,
    target: ACCESS_MANAGER,
    data: "0x12345678" as const,
    selector: "0x12345678" as const,
    targetName: "AccessManager",
    functionSignature: "setTargetClosed(address,bool)",
    label: "AccessManager.setTargetClosed(address,bool)",
    expectedRoleId: 3n,
    roleId: 3n,
    roleName: "CONFIG_ADMIN",
    scheduledAt: BigInt(state.now - 60),
    readyAt: BigInt(readyAt),
    expiresAt: BigInt(state.now + 86_400),
    scheduledBlock: BigInt(block),
    scheduledLogIndex: nonce,
    scheduledTx: TX,
  });

  it("builds config access, pending operations, and protocol fees from indexed chain state", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const sooner = accessOperation({ operationId: TX2, nonce: 29, status: "pending", block: 229,
      readyAt: state.now + 1_800 });
    const later = accessOperation({ operationId: TX3, nonce: 30, status: "pending", block: 230,
      readyAt: state.now + 3_600 });
    try {
      await database.insert(schema.v2ProtocolState).values({
        id: "protocol", createPaused: false, defaultExerciseFeeBps: 37, defaultMintFeePpm: 91,
        // (G7): PayoutAdapterSet's maxSlippageBps reaches the wire as fees.maxPayoutSlippageBps.
        maxSlippageBps: 250,
        updatedAt: BigInt(state.now),
      });
      await database.insert(schema.v2AccessRole).values({
        roleId: 3n, name: "CONFIG_ADMIN", expectedExecutionDelayS: 99_999n,
        grantDelayS: 123n, updatedAt: BigInt(state.now - 100), updatedBlock: 220n,
        updatedLogIndex: 1, updatedTx: TX,
      });
      await database.insert(schema.v2AccessRoleMember).values({
        id: `3-${BUYER}`, roleId: 3n, roleName: "CONFIG_ADMIN", account: BUYER,
        granted: true, memberSince: BigInt(state.now - 100), executionDelayS: 456n,
      });
      await database.insert(schema.v2AccessOperation).values([later, sooner]);

      clearCache();
      const response = await app.request("http://localhost/v2/config?case=indexed-v8-state");
      expect(response.status).toBe(200);
      expect(ROUTES.find((route) => route.route === "/v2/config")!.schema).toBe(configResponseSchema);
      const config = configResponseSchema.parse(await response.json());
      expect(config).toMatchObject({
        contracts: { accessManager: ACCESS_MANAGER },
        access: { manager: ACCESS_MANAGER },
        fees: { exerciseFeeBps: 37, mintFeePpm: 91, maxPayoutSlippageBps: 250 },
        constants: { feeChangeDelay: 172_800 },
        pendingOperations: [
          { id: TX2, role: "CONFIG_ADMIN", readyAt: state.now + 1_800 },
          { id: TX3, role: "CONFIG_ADMIN", readyAt: state.now + 3_600 },
        ],
      });
      const role = config.access?.roles.find((item) => item.name === "CONFIG_ADMIN");
      expect(role).toEqual({ id: 3, name: "CONFIG_ADMIN", delayS: 123,
        holders: [{ address: BUYER, delayS: 456 }] });
      expect(config.access?.roles).toHaveLength(1);
      expect(role?.delayS).not.toBe(99_999);
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_access_operation WHERE id IN ($1, $2)", [sooner.id, later.id], 2],
        ["DELETE FROM v2_access_role_member WHERE id = $1", [`3-${BUYER}`]],
        ["DELETE FROM v2_access_role WHERE role_id = 3"],
        ["DELETE FROM v2_protocol_state WHERE id = 'protocol'"],
      ]);
      clearCache();
    }
  });

  it("filters and cursor-pages manager operations by status", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const older = accessOperation({ operationId: TX, nonce: 40, status: "pending", block: 240 });
    const newer = accessOperation({ operationId: TX2, nonce: 41, status: "pending", block: 241 });
    const executed = accessOperation({ operationId: TX3, nonce: 42, status: "executed", block: 242 });
    try {
      await database.insert(schema.v2AccessOperation).values([older, newer, executed]);
      clearCache();

      const first = await list(await app.request("http://localhost/v2/admin/operations?status=pending&limit=1"));
      expect(first.items).toEqual([expect.objectContaining({ id: TX2, status: "pending" })]);
      expect(first.nextCursor).not.toBeNull();
      const second = await list(await app.request(
        `http://localhost/v2/admin/operations?status=pending&limit=1&cursor=${first.nextCursor}`,
      ));
      expect(second).toEqual({ items: [expect.objectContaining({ id: TX, status: "pending" })], nextCursor: null });

      const finished = await list(await app.request("http://localhost/v2/admin/operations?status=executed"));
      expect(finished.items).toEqual([expect.objectContaining({ id: TX3, status: "executed" })]);
      expect((await app.request("http://localhost/v2/admin/operations?status=unknown")).status).toBe(400);
    } finally {
      await teardown(pg, [["DELETE FROM v2_access_operation WHERE id IN ($1, $2, $3)", [older.id, newer.id, executed.id], 3]]);
      clearCache();
    }
  });

  // `id` is AccessManager's operation id and it REPEATS across a reschedule; the ingest row
  // is keyed `operationId:nonce` (accessManager.ts:135-137). Before `key` was published there was
  // nothing on the wire that separated these two rows, so any consumer keying on `id` lost one --
  // and the one it lost is a pending governance operation.
  it("serves both rows when one operation id is scheduled twice, with distinct keys", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const first = accessOperation({ operationId: TX2, nonce: 50, status: "pending", block: 250 });
    const rescheduled = accessOperation({ operationId: TX2, nonce: 51, status: "pending", block: 251 });
    try {
      await database.insert(schema.v2AccessOperation).values([first, rescheduled]);
      clearCache();

      const page = await list(await app.request("http://localhost/v2/admin/operations?status=pending"));
      const mine = page.items.filter((item) => item.id === TX2);
      expect(mine).toHaveLength(2);
      // Same id on both, which is the premise, not an accident.
      expect(new Set(mine.map((item) => item.id))).toEqual(new Set([TX2]));
      // Different key on each, which is the fix.
      expect(new Set(mine.map((item) => item.key))).toEqual(new Set([`${TX2}:50`, `${TX2}:51`]));
    } finally {
      await teardown(pg, [["DELETE FROM v2_access_operation WHERE id IN ($1, $2)", [first.id, rescheduled.id], 2]]);
      clearCache();
    }
  });

  it("keeps a scheduled selector-less operation visible in both public views", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    // OperationScheduled stores null for calldata shorter than a selector. Do not hand-seed a
    // four-byte selector here: that was the route-only shape that hid this production row.
    const operation = { ...accessOperation({ operationId: TX3, nonce: 43, status: "pending", block: 243 }),
      data: "0x1234" as const, selector: null, targetName: null, functionSignature: null,
      expectedRoleId: null, roleId: 0n, roleName: "ADMIN",
      label: `unknown-target ${ACCESS_MANAGER.toLowerCase()} no-selector` };
    try {
      await database.insert(schema.v2AccessOperation).values(operation);
      clearCache();

      const adminResponse = await app.request("http://localhost/v2/admin/operations?status=pending");
      expect(adminResponse.status).toBe(200);
      const admin = ROUTES.find((route) => route.route === "/v2/admin/operations")!
        .schema.parse(await adminResponse.json());
      expect(admin.items).toEqual([expect.objectContaining({
        id: TX3, selector: null, label: expect.stringContaining("no-selector"),
      })]);

      const configResponse = await app.request("http://localhost/v2/config?case=selector-less-operation");
      expect(configResponse.status).toBe(200);
      const config = ROUTES.find((route) => route.route === "/v2/config")!
        .schema.parse(await configResponse.json());
      expect(config.pendingOperations).toEqual([expect.objectContaining({
        id: TX3, selector: null, label: expect.stringContaining("no-selector"),
      })]);
    } finally {
      await teardown(pg, [["DELETE FROM v2_access_operation WHERE id = $1", [operation.id]]]);
      clearCache();
    }
  });

  it("reports native flywheel revenue and counts only canonical splitter burns", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    try {
      await database.insert(schema.v2FeeSweep).values([
        { id: "sweep-stock", asset: NVDA_STOCK, recipient: FEE_SPLITTER, amount: 100n,
          ts: BigInt(state.now - 300), block: 300n, logIndex: 1, tx: TX },
        { id: "sweep-usdg", asset: USDG, recipient: FEE_SPLITTER, amount: 200n,
          ts: BigInt(state.now - 290), block: 301n, logIndex: 1, tx: TX2 },
      ]);
      await database.insert(schema.v2FlywheelDistribution).values([
        { id: "distribution-usdg", asset: USDG, assetIn: 50n, usdgIn: 50n,
          treasuryOut: 25n, buybackAdded: 25n, ts: BigInt(state.now - 200),
          block: 302n, logIndex: 1, tx: TX2 },
        { id: "distribution-stock", asset: NVDA_STOCK, assetIn: 40n, usdgIn: 80n,
          treasuryOut: 40n, buybackAdded: 40n, ts: BigInt(state.now - 100),
          block: 303n, logIndex: 1, tx: TX3 },
      ]);
      await database.insert(schema.v2FlywheelBurn).values({ id: "burn-canonical", token: FLYWHEEL_TOKEN,
        amount: 25n, totalSupplyAtBlock: 1_000n, ts: BigInt(state.now - 50),
        block: 304n, logIndex: 1, tx: TX3 });
      await database.insert(schema.v2FlywheelExecutorBurn).values({ id: "burn-audit-duplicate", amount: 999n,
        ts: BigInt(state.now - 50), block: 304n, logIndex: 2, tx: TX3 });

      clearCache();
      const response = await app.request("http://localhost/v2/flywheel?case=native-revenue");
      expect(response.status).toBe(200);
      const flywheel = ROUTES.find((route) => route.route === "/v2/flywheel")!.schema.parse(await response.json());
      expect(flywheel).toMatchObject({
        configured: true,
        splitter: FEE_SPLITTER,
        tokenAddress: FLYWHEEL_TOKEN,
        burnedTotal: "25",
        burned7d: "25",
        held: [{ asset: NVDA_STOCK, symbol: "NVDA", decimals: 18, amountRaw: "60" }],
        lastDistribution: { id: "distribution-stock", asset: NVDA_STOCK, assetInRaw: "40" },
      });
      expect(flywheel.revenue7d).toEqual([
        { asset: USDG, symbol: "USDG", decimals: 6, amountRaw: "50" },
        { asset: NVDA_STOCK, symbol: "NVDA", decimals: 18, amountRaw: "40" },
      ]);
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_flywheel_executor_burn WHERE id = 'burn-audit-duplicate'"],
        ["DELETE FROM v2_flywheel_burn WHERE id = 'burn-canonical'"],
        ["DELETE FROM v2_flywheel_distribution WHERE id IN ('distribution-usdg', 'distribution-stock')", [], 2],
        ["DELETE FROM v2_fee_sweep WHERE id IN ('sweep-stock', 'sweep-usdg')", [], 2],
      ]);
      clearCache();
    }
  });

  it("projects a recovered, partially served Earn withdrawal without hiding the request", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const recoveredQueueId = `${vault.toLowerCase()}-7`;
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, fundingEnabled: true,
        sharesSupply: 100n, updatedAt: BigInt(state.now - 50), updatedBlock: 400n,
        updatedLogIndex: 1, updatedTx: TX,
      });
      await database.insert(schema.v2EarnVaultDeposit).values({
        id: "earn-deposit-1", vault, account: BUYER, receiver: BUYER, asset: USDG,
        assets: 1_000n, shares: 100n, queueId: null,
        ts: BigInt(state.now - 40), block: 401n, logIndex: 1, tx: TX2,
      });
      await database.insert(schema.v2EarnVaultWithdrawalQueue).values({
        id: recoveredQueueId, vault, account: BUYER, asset: USDG, status: "queued",
        sharesQueued: 100n, assetsRequested: null, requestedAt: BigInt(state.now - 30),
        requestedBlock: 402n, requestedLogIndex: 1, requestedTx: TX3,
        fulfilledAssets: 60n, fulfilledAt: BigInt(state.now - 20), fulfilledBlock: 403n,
        fulfilledLogIndex: 1, fulfilledTx: TX3,
      });
      await database.insert(schema.v2EarnVaultAdapterMove).values({
        id: "earn-move-1", vault, adapter: null, asset: USDG, direction: "pull",
        requested: 50n, delivered: null, succeeded: false,
        ts: BigInt(state.now - 20), block: 403n, logIndex: 1, tx: TX3,
      });
      clearCache();
      const response = await app.request(`http://localhost/v2/earn?address=${BUYER}`);
      expect(response.status).toBe(200);
      const body = ROUTES.find((route) => route.route === "/v2/earn")!.schema.parse(await response.json());
      expect(body.configured).toBe(true);
      expect(body.vaults).toEqual([expect.objectContaining({
        vault,
        asset: USDG,
        deposited: "1000",
        skimmed: null,
        sharesSupply: "100",
        // No public client here, so the live fundingEnabled() read is null and the indexed flag is served.
        fundingEnabled: true,
        queue: { depth: 1, oldestRequestedAt: state.now - 30 },
        lastAdapterMove: expect.objectContaining({ delivered: null, requested: "50", direction: "pull" }),
        // No public client in this scenario -> the live mark is "not read", null on all three.
        indicativeAssetsPerShare: null,
        indicativeTotalAssets: null,
        hasOpenPosition: null,
      })]);
      expect(body.account).toEqual(expect.objectContaining({
        address: getAddress(BUYER),
        shares: null,
        queued: [expect.objectContaining({
          id: recoveredQueueId,
          status: "queued",
          sharesQueued: "100",
          assetsRequested: null,
          fulfilledAssets: "60",
        })],
      }));

    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_earn_vault_adapter_move WHERE id = 'earn-move-1'"],
        ["DELETE FROM v2_earn_vault_withdrawal_queue WHERE id = $1", [recoveredQueueId]],
        ["DELETE FROM v2_earn_vault_deposit WHERE id = 'earn-deposit-1'"],
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  it("/v2/earn sends each vault's venue write-offs from the event, newest first and bounded, and [] when there is none", async () => {
    const { clearCache } = await import("../cache");
    const { EARN_WRITE_OFFS_SENT } = await import("./earn");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const key = vault.toLowerCase() as `0x${string}`;
    const OLD = "0x00000000000000000000000000000000000ad0a1";
    const OLDER = "0x00000000000000000000000000000000000ad0a2";
    const OTHER_VAULT = "0x00000000000000000000000000000000000000c3";
    // The route's own schema, typed: the ROUTES entry is a union of every route's.
    expect(ROUTES.find((item) => item.route === "/v2/earn")!.schema).toBe(earnResponseSchema);
    const route = { schema: earnResponseSchema };
    const writeOff = (id: string, onVault: string, adapter: string, lastKnown: bigint, block: bigint, logIndex: number, tx: `0x${string}`) => ({
      id, vault: onVault as `0x${string}`, adapter: adapter as `0x${string}`, asset: USDG, lastKnown,
      ts: BigInt(state.now) - (1_000n - block), block, logIndex, tx,
    });
    const filler = Array.from({ length: EARN_WRITE_OFFS_SENT }, (_, i) =>
      writeOff(`writeoff-old-${i}`, key, OLDER, 1n, 300n + BigInt(i), 0, TX));
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, fundingEnabled: true,
        sharesSupply: 100n, updatedAt: BigInt(state.now - 50), updatedBlock: 400n,
        updatedLogIndex: 1, updatedTx: TX,
      });
      clearCache();
      const none = route.schema.parse(await (await app.request("http://localhost/v2/earn")).json());
      expect(none.vaults?.map((v) => v.venueWriteOffs)).toEqual([[]]);

      await database.insert(schema.v2EarnVaultVenueWriteOff).values([
        // Same block, two logs: the later log first. A zero write-off is a row like any other.
        writeOff("writeoff-a", key, OLDER, 0n, 410n, 2, TX2),
        writeOff("writeoff-b", key, OLD, 12_345_678n, 420n, 0, TX3),
        writeOff("writeoff-c", key, OLD, 7n, 420n, 1, TX3),
        // Another vault's write-off is not this vault's, even when it is the newest row in the table.
        writeOff("writeoff-other", OTHER_VAULT, OLD, 5n, 430n, 0, TX),
      ]);
      clearCache();
      const body = route.schema.parse(await (await app.request("http://localhost/v2/earn")).json());
      expect(body.vaults?.[0]?.venueWriteOffs).toEqual([
        { adapter: getAddress(OLD), amount: "7", ts: state.now - 580, tx: TX3 },
        { adapter: getAddress(OLD), amount: "12345678", ts: state.now - 580, tx: TX3 },
        { adapter: getAddress(OLDER), amount: "0", ts: state.now - 590, tx: TX2 },
      ]);

      // Bounded: the newest EARN_WRITE_OFFS_SENT of 3 + EARN_WRITE_OFFS_SENT rows, so the three oldest fillers (blocks
      // 300-302) are left out and the last one sent is block 303.
      await database.insert(schema.v2EarnVaultVenueWriteOff).values(filler);
      clearCache();
      const many = route.schema.parse(await (await app.request("http://localhost/v2/earn")).json());
      const sent = many.vaults?.[0]?.venueWriteOffs ?? [];
      expect(sent).toHaveLength(EARN_WRITE_OFFS_SENT);
      expect(sent.slice(0, 3).map((w) => w.amount)).toEqual(["7", "12345678", "0"]);
      expect(sent.at(-1)).toEqual({ adapter: getAddress(OLDER), amount: "1", ts: state.now - 1_000 + 303, tx: TX });
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_earn_vault_venue_write_off WHERE id LIKE 'writeoff-%'", [], 4 + EARN_WRITE_OFFS_SENT],
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  it("lists the caller's queued deposits and withdrawals with queue id, escrow left and FIFO place", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const key = vault.toLowerCase();
    const other = "0x00000000000000000000000000000000000000b2";
    const otherVault = "0x00000000000000000000000000000000000000c3";
    const withdrawal = (id: string, account: string, status: string, block: bigint, logIndex: number, onVault = key) => ({
      id, vault: onVault as `0x${string}`, account: account as `0x${string}`, asset: USDG, status,
      sharesQueued: 100n, assetsRequested: null, requestedAt: BigInt(state.now - 30), requestedBlock: block,
      requestedLogIndex: logIndex, requestedTx: TX3, fulfilledAssets: null, fulfilledAt: null, fulfilledBlock: null,
      fulfilledLogIndex: null, fulfilledTx: null,
    });
    const deposit = (id: string, account: string, block: bigint, logIndex: number) => ({
      id, vault: key as `0x${string}`, account: account as `0x${string}`, receiver: account as `0x${string}`,
      asset: USDG, status: "queued", assetsQueued: 250n, requestedAt: BigInt(state.now - 20), requestedBlock: block,
      requestedLogIndex: logIndex, requestedTx: TX3, mintedShares: null, fulfilledAt: null, fulfilledBlock: null,
      fulfilledLogIndex: null, fulfilledTx: null,
    });
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, fundingEnabled: true,
        sharesSupply: 1_000n, updatedAt: BigInt(state.now - 50), updatedBlock: 499n,
        updatedLogIndex: 1, updatedTx: TX,
      });
      await database.insert(schema.v2EarnVaultWithdrawalQueue).values([
        // Cancelled before everything: waits for nothing, so it is never counted ahead.
        withdrawal(`${key}-1`, other, "cancelled", 499n, 1),
        // Open and earlier: ahead of both of BUYER's requests.
        withdrawal(`${key}-2`, other, "queued", 500n, 1),
        // BUYER's partially served redemption at (502, 2).
        withdrawal(`${key}-5`, BUYER, "queued", 502n, 2),
        // Another vault's queue is a different FIFO and is never counted, however early.
        withdrawal(`${otherVault}-1`, other, "queued", 400n, 1, otherVault),
      ]);
      await database.insert(schema.v2EarnVaultDepositQueue).values([
        // A queued DEPOSIT is in the same FIFO as the redemptions around it.
        deposit(`${key}-3`, other, 501n, 1),
        // Same block as BUYER's redemption, earlier log: ahead of it. The tie-break is the log index.
        deposit(`${key}-4`, other, 502n, 1),
        deposit(`${key}-6`, BUYER, 503n, 1),
      ]);
      // A partial service of #5 burned 40 of its 100 shares.
      await database.insert(schema.v2EarnVaultWithdrawal).values({
        id: "t-op-239-served", vault: key as `0x${string}`, account: BUYER, asset: USDG, assets: 400n, shares: 40n,
        queueId: `${key}-5`, ts: BigInt(state.now - 10), block: 504n, logIndex: 1, tx: TX3,
      });
      clearCache();
      const response = await app.request(`http://localhost/v2/earn?address=${BUYER}`);
      expect(response.status).toBe(200);
      const body = ROUTES.find((route) => route.route === "/v2/earn")!.schema.parse(await response.json());
      // Depth is every OPEN entry of this vault in either direction (#2, #3, #4, #5, #6); cancelled #1 and the other
      // vault's entry are not in it. Earlier it counted withdrawals only and said 2.
      expect(body.vaults?.[0]?.queue).toEqual({ depth: 5, oldestRequestedAt: state.now - 30 });
      expect(body.account?.queued).toEqual([
        {
          id: `${key}-5`, status: "queued", sharesQueued: "100", assetsRequested: null, fulfilledAssets: null,
          requestedAt: state.now - 30, vault, queueId: "5", kind: "withdrawal", assetsQueued: null,
          sharesEscrowed: "60", position: 4,
        },
        {
          id: `${key}-6`, status: "queued", sharesQueued: "0", assetsRequested: null, fulfilledAssets: null,
          requestedAt: state.now - 20, vault, queueId: "6", kind: "deposit", assetsQueued: "250",
          sharesEscrowed: "0", position: 5,
        },
      ]);
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_earn_vault_withdrawal WHERE id = 't-op-239-served'"],
        ["DELETE FROM v2_earn_vault_deposit_queue WHERE id IN ($1, $2, $3)", [`${key}-3`, `${key}-4`, `${key}-6`], 3],
        ["DELETE FROM v2_earn_vault_withdrawal_queue WHERE id IN ($1, $2, $3, $4)",
          [`${key}-1`, `${key}-2`, `${key}-5`, `${otherVault}-1`], 4],
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  it("serves the caller's held payments (owner or receiver) and the live fundingEnabled flag, never a pause", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const key = vault.toLowerCase();
    const other = "0x00000000000000000000000000000000000000b2";
    const held = (requestId: bigint, owner: string, receiver: string, assets: bigint) => ({
      id: `${key}-${requestId}`, vault: key as `0x${string}`, requestId, owner: owner.toLowerCase() as `0x${string}`,
      receiver: receiver.toLowerCase() as `0x${string}`, asset: USDG, assets, heldTotal: assets === 0n ? 90n : assets,
      claimedTotal: assets === 0n ? 90n : 0n, updatedAt: BigInt(state.now - Number(requestId)), updatedBlock: 600n + requestId,
      updatedLogIndex: 1, updatedTx: TX3,
    });
    try {
      // Nothing indexed about the flag: the deploy never emits FundingEnabledSet.
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, fundingEnabled: null,
        sharesSupply: 1_000n, updatedAt: BigInt(state.now - 50), updatedBlock: 499n, updatedLogIndex: 1, updatedTx: TX,
      });
      await database.insert(schema.v2EarnVaultHeldPayment).values([
        held(31n, BUYER, other, 300n), // BUYER owns it
        held(32n, other, BUYER, 70n), // BUYER is the receiver: claimDeferred lets the receiver pull too
        held(33n, BUYER, BUYER, 0n), // already pulled: nothing held, not listed
        held(34n, other, other, 500n), // someone else's
      ]);
      clearCache();
      state.publicClients = { robinhood: { multicall: async ({ contracts }: { contracts: unknown[] }) =>
        (contracts as Array<{ address: string; functionName: string }>).map(({ address: at, functionName }) =>
          at.toLowerCase() === key && functionName === "fundingEnabled"
            ? { status: "success", result: false }
            : { status: "failure", error: new Error("execution reverted") }) } };
      const route = ROUTES.find((item) => item.route === "/v2/earn")!;
      const response = await app.request(`http://localhost/v2/earn?address=${BUYER}`);
      expect(response.status).toBe(200);
      const body = route.schema.parse(await response.json());
      // The contract says false; an indexed-only answer would have been null.
      expect(body.vaults?.[0]?.fundingEnabled).toBe(false);
      expect(body.vaults?.[0]).not.toHaveProperty("paused");
      expect(body.account?.held).toEqual([
        { vault, queueId: "31", owner: getAddress(BUYER), receiver: getAddress(other), asset: getAddress(USDG), assets: "300", updatedAt: state.now - 31 },
        { vault, queueId: "32", owner: getAddress(other), receiver: getAddress(BUYER), asset: getAddress(USDG), assets: "70", updatedAt: state.now - 32 },
      ]);

      // The read fails: the last indexed FundingEnabledSet is served; with none, null (never a guessed false).
      state.publicClients = {};
      clearCache();
      const unread = route.schema.parse(await (await app.request(`http://localhost/v2/earn?address=${other}`)).json());
      expect(unread.vaults?.[0]?.fundingEnabled).toBeNull();
      expect(unread.account?.held?.map((item: { queueId: string }) => item.queueId)).toEqual(["31", "32", "34"]);
      await pg.query("UPDATE v2_earn_vault_state SET funding_enabled = true WHERE lower(vault) = lower($1)", [vault]);
      clearCache();
      const indexed = route.schema.parse(await (await app.request("http://localhost/v2/earn")).json());
      expect(indexed.vaults?.[0]?.fundingEnabled).toBe(true);
      expect(indexed.account ?? null).toBeNull();
    } finally {
      state.publicClients = {};
      await teardown(pg, [
        ["DELETE FROM v2_earn_vault_held_payment WHERE id IN ($1, $2, $3, $4)", [`${key}-31`, `${key}-32`, `${key}-33`, `${key}-34`], 4],
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  it("maps production Earn adapter directions instead of dropping them", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, fundingEnabled: true,
        sharesSupply: 100n, updatedAt: BigInt(state.now - 30), updatedBlock: 404n,
        updatedLogIndex: 1, updatedTx: TX,
      });
      // PulledFromVenue and SweptToVenue store "in" and "out" respectively.
      await database.insert(schema.v2EarnVaultAdapterMove).values({
        id: "earn-move-production", vault, adapter: null, asset: USDG, direction: "in",
        requested: 50n, delivered: 40n, succeeded: true,
        ts: BigInt(state.now - 20), block: 405n, logIndex: 1, tx: TX3,
      });
      clearCache();

      const route = ROUTES.find((item) => item.route === "/v2/earn")!;
      const inResponse = await app.request("http://localhost/v2/earn?case=production-in");
      expect(inResponse.status).toBe(200);
      const inBody = route.schema.parse(await inResponse.json());
      expect(inBody.vaults[0]?.lastAdapterMove).toEqual(expect.objectContaining({
        direction: "pull", requested: "50", delivered: "40",
      }));

      await pg.query("UPDATE v2_earn_vault_adapter_move SET direction = 'out' WHERE id = 'earn-move-production'", []);
      clearCache();
      const outResponse = await app.request("http://localhost/v2/earn?case=production-out");
      expect(outResponse.status).toBe(200);
      const outBody = route.schema.parse(await outResponse.json());
      expect(outBody.vaults[0]?.lastAdapterMove).toEqual(expect.objectContaining({
        direction: "push", requested: "50", delivered: "40",
      }));
      // Both production sites carry the live fields, null without a client.
      expect(inBody.vaults[0]).toEqual(expect.objectContaining({
        indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null,
      }));
      expect(outBody.vaults[0]).toEqual(expect.objectContaining({
        indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null,
      }));
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_earn_vault_adapter_move WHERE id = 'earn-move-production'"],
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  /**
   * The public Earn figures end to end through the route: realised APY from seeded hourly samples (flat
   * ones only, after the skim), the venue's APY over samples of the SAME venue, venue liquidity that uses the
   * POSITION on an advisory (Morpho Vault V2-shaped) venue and maxWithdraw on a standard one, and one
   * earliestWithdrawal per branch of EarnVault.redeem. The fake client answers by address and function, so the
   * vault's totalAssets() and the adapter's totalAssets() cannot be confused.
   */
  it("serves Earn APY, venue liquidity and earliestWithdrawal from samples and live reads", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const key = vault.toLowerCase() as `0x${string}`;
    const ADAPTER = "0x000000000000000000000000000000000000Ad01" as const;
    const VENUE = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd" as const;
    const OLD_VENUE = "0x000000000000000000000000000000000000Be01" as const;
    const route = ROUTES.find((item) => item.route === "/v2/earn")!;
    const DAY = 86_400;
    const E18 = 10n ** 18n;
    // The net-of-mark price sits a fixed 0.01 below the gross one, so a realised APY taken
    // from netPricePerShare gives a different ratio from every expectation below, which are on the gross price.
    const sample = (id: string, ts: number, positionOpen: boolean | null, price: bigint,
      venue: string | null, probe: bigint | null, venueName: string | null = null) => ({
      id: `${key}-${id}`, vault: key, ts: BigInt(ts), block: BigInt(ts), totalAssets: 1n, totalSupply: 1n,
      highWaterMark: 0n, skimBps: 0, pricePerShare: price, netPricePerShare: price - E18 / 100n, positionOpen,
      adapter: ADAPTER.toLowerCase() as `0x${string}`, venue: venue?.toLowerCase() as `0x${string}` | undefined ?? null,
      venueName, venueProbeAssets: probe,
    });
    const now = state.now;
    const endTs = now - 3_600;
    const rows = [
      sample("s30", now - 31 * DAY - 100, false, E18, OLD_VENUE, 500_000_000_000_000n),
      sample("s7", now - 8 * DAY, false, 1_004n * E18 / 1_000n, VENUE, 999_000_000_000_000n),
      sample("sv1", endTs - DAY - 60, false, 10_048n * E18 / 10_000n, VENUE, 1_000_000_000_000_000n),
      // A different venue, NEWER than sv1 inside the 24h start range: chosen only if the same-venue filter is gone.
      sample("sold", endTs - DAY - 10, false, 10_049n * E18 / 10_000n, OLD_VENUE, 100_000_000_000_000n),
      sample("send", endTs, false, 1_005n * E18 / 1_000n, VENUE, 1_000_500_000_000_000n, "Steakhouse USDG"),
      // Newer than send but NOT flat: unread flag, then an open position with the understated floor price.
      sample("snull", now - 120, null, 2n * E18, null, null),
      sample("sopen", now - 60, true, E18 / 2n, null, null),
    ];
    const base: Record<string, unknown> = {
      [`${key}:indicativeAssetsPerShare`]: 1_005_000n,
      [`${key}:indicativeTotalAssets`]: 7_000_000n,
      [`${key}:hasOpenPosition`]: false,
      [`${key}:queue`]: [5n, 4n],
      [`${key}:escrowedAssets`]: 250_000n,
      [`${key}:deferredAssets`]: 0n,
      [`${key}:totalAssets`]: 7_000_000n,
      // The venue probe answers, so the vault prices (its venue can be read).
      [`${key}:convertToAssets`]: 1n,
      [`${USDG}:balanceOf`]: 1_250_000n,
      // The vault's free Clearinghouse ledger, which `_raise` pulls before the venue. Zero in every case below
      // that does not name it, so those cases keep describing a vault with nothing parked on the ledger.
      [`${CLEARINGHOUSE_LEDGER}:free`]: 0n,
      [`${ADAPTER.toLowerCase()}:withdrawable`]: 0n,
      [`${ADAPTER.toLowerCase()}:totalAssets`]: 5_000_000n,
      [`${ADAPTER.toLowerCase()}:maxIsAdvisory`]: true,
      [`${ADAPTER.toLowerCase()}:venue`]: VENUE,
    };
    const answer = (over: Record<string, unknown> = {}) => ({ robinhood: { multicall: async ({ contracts }: { contracts: unknown[] }) =>
      (contracts as Array<{ address: string; functionName: string }>).map(({ address, functionName }) => {
        const leg = `${address.toLowerCase()}:${functionName}`;
        const value = leg in over ? over[leg] : base[leg];
        if (value instanceof Error) return { status: "failure", error: value };
        return value === undefined ? { status: "failure", error: new Error("execution reverted") }
          : { status: "success", result: value };
      }) } });
    const get = async (tag: string) => route.schema.parse(await (await app.request(`http://localhost/v2/earn?case=${tag}`)).json())
      .vaults![0]!;
    const compounded = (ratio: number, span: number) => Math.round((Math.pow(ratio, (365 * DAY) / span) - 1) * 10_000);
    // Counted, so a failure before case (4) reports ITS assertion rather than a teardown shortfall.
    let seededBalance = 0;
    let seededResale = 0;
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: ADAPTER, skimBps: 1_000, fundingEnabled: true,
        sharesSupply: 100n, updatedAt: BigInt(now - 30), updatedBlock: 404n, updatedLogIndex: 1, updatedTx: TX,
      });
      await database.insert(schema.v2EarnVaultSample).values(rows);

      // (1) Advisory venue, flat, no queue: liquid now, capped by wallet (1.25M - 0.25M escrow) + the POSITION.
      state.publicClients = answer();
      clearCache();
      let body = await get("t234-liquid");
      expect(body.earliestWithdrawal).toEqual({ kind: "now", at: now, reason: "liquid", liquidityCap: "6000000" });
      expect(body.totalAssets).toBe("7000000");
      expect(body.venue).toEqual({
        address: VENUE,
        name: "Steakhouse USDG",
        withdrawable: "5000000",
        withdrawableSource: "position",
        position: "5000000",
        apy24h: { bps: compounded(1.0005, DAY + 60), reason: null, from: endTs - DAY - 60, to: endTs },
        apy7d: { bps: compounded(1_000_500 / 999_000, endTs - (now - 8 * DAY)), reason: null,
          from: now - 8 * DAY, to: endTs },
      });
      // Realised: flat samples only, so `send` is the end and the unread/open rows after it are ignored.
      expect(body.apy7d).toEqual({ bps: compounded(1.005 / 1.004, endTs - (now - 8 * DAY)), reason: null,
        from: now - 8 * DAY, to: endTs });
      expect(body.apy30d).toEqual({ bps: compounded(1.005, endTs - (now - 31 * DAY - 100)), reason: null,
        from: now - 31 * DAY - 100, to: endTs });
      expect(body.apy7d!.bps).toBeGreaterThan(0);

      // (2) The same adapter numbers on a STANDARD venue: maxWithdraw (0) is the bound, so with an empty wallet
      // the redemption queues for venue liquidity. Identical reads, opposite answer: the advisory flag decides.
      state.publicClients = answer({ [`${ADAPTER.toLowerCase()}:maxIsAdvisory`]: false, [`${USDG}:balanceOf`]: 250_000n });
      clearCache();
      body = await get("t234-standard");
      expect(body.venue).toEqual(expect.objectContaining({ withdrawable: "0", withdrawableSource: "maxWithdraw" }));
      expect(body.earliestWithdrawal).toEqual({ kind: "queued", at: null, reason: "venue-liquidity", liquidityCap: "0" });

      // (2a). Payments held for claimDeferred are reserved like escrow (`_deliverable`): the wallet term is
      // 1.25M - 0.25M escrow - 0.4M deferred, so the advisory-venue cap drops from 6.0M to 5.6M.
      state.publicClients = answer({ [`${key}:deferredAssets`]: 400_000n });
      clearCache();
      body = await get("t467-deferred");
      expect(body.earliestWithdrawal).toEqual({ kind: "now", at: now, reason: "liquid", liquidityCap: "5600000" });

      // (2b). On a standard venue with nothing to withdraw, the 1.25M wallet minus 0.25M escrow would read
      // "liquid, 1.0M". With 1.0M held for claimDeferred the contract has nothing to pay from, and redeem queues.
      state.publicClients = answer({ [`${ADAPTER.toLowerCase()}:maxIsAdvisory`]: false, [`${key}:deferredAssets`]: 1_000_000n });
      clearCache();
      body = await get("t467-deferred-all");
      expect(body.earliestWithdrawal).toEqual({ kind: "queued", at: null, reason: "venue-liquidity", liquidityCap: "0" });

      // (2c). deferredAssets() unread: not-read, never a cap that treats the held payments as 0.
      state.publicClients = answer({ [`${key}:deferredAssets`]: undefined });
      clearCache();
      body = await get("t467-deferred-unread");
      expect(body.earliestWithdrawal).toEqual({ kind: "unknown", at: null, reason: "not-read", liquidityCap: null });

      // (2d). The standard-venue case of (2) with 0.3M USDG free on the vault's Clearinghouse ledger: `_raise`
      // pulls it before the venue (EarnVault), so `redeem` pays now up to 0.3M instead of queueing.
      state.publicClients = answer({ [`${ADAPTER.toLowerCase()}:maxIsAdvisory`]: false, [`${USDG}:balanceOf`]: 250_000n,
        [`${CLEARINGHOUSE_LEDGER}:free`]: 300_000n });
      clearCache();
      body = await get("t797-ledger");
      expect(body.earliestWithdrawal).toEqual({ kind: "now", at: now, reason: "liquid", liquidityCap: "300000" });

      // (2e). The ledger read fails: not-read, never a cap that treats the ledger as 0.
      state.publicClients = answer({ [`${CLEARINGHOUSE_LEDGER}:free`]: undefined });
      clearCache();
      body = await get("t797-ledger-unread");
      expect(body.earliestWithdrawal).toEqual({ kind: "unknown", at: null, reason: "not-read", liquidityCap: null });

      // (2f). The vault's convertToAssets reverts VenueUnreadable: nothing is priced and redeem
      // queues even though the wallet and venue could pay (without the probe this is "liquid, 6000000").
      const venueUnreadable = new ContractFunctionRevertedError({ abi: earnVaultAbi,
        data: encodeErrorResult({ abi: earnVaultAbi, errorName: "VenueUnreadable" }), functionName: "convertToAssets" });
      state.publicClients = answer({ [`${key}:convertToAssets`]: venueUnreadable });
      clearCache();
      body = await get("t839-venue-unreadable");
      expect(body.earliestWithdrawal).toEqual({ kind: "queued", at: null, reason: "venue-unreadable", liquidityCap: null });

      // (2g). A probe that fails for any other reason is not-read, never "liquid".
      state.publicClients = answer({ [`${key}:convertToAssets`]: undefined });
      clearCache();
      body = await get("t839-probe-unread");
      expect(body.earliestWithdrawal).toEqual({ kind: "unknown", at: null, reason: "not-read", liquidityCap: null });

      // (3) A queue is open (head <= tail): the redemption joins its back.
      state.publicClients = answer({ [`${key}:queue`]: [4n, 4n] });
      clearCache();
      body = await get("t234-queue");
      expect(body.earliestWithdrawal).toEqual({ kind: "queued", at: null, reason: "queue-ahead", liquidityCap: null });

      // (4) A position is open: queued until the latest expiry the vault still holds (series 4, now + 1 day).
      await database.insert(schema.v2Balance).values({
        id: `t234-4-${key}`, tokenId: 4n, holder: key, longId: 4n, side: "short", units: 10n,
      });
      seededBalance = 1;
      state.publicClients = answer({ [`${key}:hasOpenPosition`]: true });
      clearCache();
      body = await get("t234-open");
      expect(body.earliestWithdrawal).toEqual({ kind: "queued", at: now + 86_400, reason: "open-position", liquidityCap: null });

      // (4b). An AskResale the V2Clock marked `expired` but nobody pruned still escrows the vault's longs
      // (EarnVault `_resaleEscrowOpen`: "live or expired and unpruned"), so its series' later expiry is the earliest.
      await database.insert(schema.v2Series).values({ longId: 10_797n, underlying: MARKET, ticker: "TEST", isPut: false,
        strike: 230_000_000n, expiry: BigInt(now + 2 * 86_400), tenor: "daily", mintCutoff: BigInt(now + 2 * 86_400 - 1_800),
        oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "open",
        openInterestUnits: 0n, volumeUnits: 0n, volumeUsdg: 0n,
        createdAt: BigInt(now - 200_000), createdBlock: 80n, createdTx: TX });
      await database.insert(schema.v2Order).values({ orderId: 797_001n, maker: key, longId: 10_797n,
        kind: "AskResale", price: 3_000_000n, units: 10n, filled: 0n,
        validUntil: BigInt(now - 10), status: "expired", placedAt: BigInt(now - 120),
        placedBlock: 100n, placedTx: TX, updatedAt: BigInt(now - 120) });
      seededResale = 1;
      clearCache();
      body = await get("t797-expired-resale");
      expect(body.earliestWithdrawal).toEqual({ kind: "queued", at: now + 2 * 86_400, reason: "open-position",
        liquidityCap: null });

      // (5) The adapter now points at a venue with no samples yet (a swap): the address is the live one, and the
      // sampled name and APY -- which describe the OTHER venue -- are withheld rather than shown under it.
      state.publicClients = answer({ [`${ADAPTER.toLowerCase()}:venue`]: getAddress(OLD_VENUE) });
      clearCache();
      body = await get("t234-swapped");
      expect(body.venue).toEqual(expect.objectContaining({
        address: getAddress(OLD_VENUE), name: null,
        apy24h: { bps: null, reason: "no-samples", from: null, to: null },
        apy7d: { bps: null, reason: "no-samples", from: null, to: null },
      }));

      // (6) Nothing readable: not-read, never a guessed "now".
      state.publicClients = {};
      clearCache();
      body = await get("t234-unread");
      expect(body.earliestWithdrawal).toEqual({ kind: "unknown", at: null, reason: "not-read", liquidityCap: null });
      expect(body.venue).toEqual(expect.objectContaining({ address: VENUE, name: "Steakhouse USDG", withdrawable: null,
        withdrawableSource: null, position: null }));
    } finally {
      state.publicClients = {};
      await teardown(pg, [
        ["DELETE FROM v2_balance WHERE id = $1", [`t234-4-${key}`], seededBalance],
        ["DELETE FROM v2_order WHERE order_id = $1", [797_001n], seededResale],
        ["DELETE FROM v2_series WHERE long_id = $1", [10_797n], seededResale],
        ["DELETE FROM v2_earn_vault_sample WHERE vault = $1", [key], rows.length],
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  /**
   * The live mark: read from the vault's own `indicativeAssetsPerShare()` /
   * `indicativeTotalAssets()` / `hasOpenPosition()` in ONE multicall with allowFailure, forwarded as strings and
   * a boolean; a reverting or absent view (an older deployment) yields null for that field and only that field;
   * a client that throws yields null for all three -- never a 500, never a fabricated "0". Nothing here reads
   * `convertToShares` / `convertToAssets`: the fake client asserts the function names it was asked for.
   * A change added a SECOND multicall (liquidity for earliestWithdrawal); the mark's own call is still exactly the
   * three views above, which is what `calls[0]` pins, and no call of either reads convertTo* from the vault.
   */
  it("reads the indicative mark live with allowFailure and says null, not zero, for what it could not read", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const route = ROUTES.find((item) => item.route === "/v2/earn")!;
    const calls: Array<Array<{ functionName: string; address: string }>> = [];
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, fundingEnabled: true,
        sharesSupply: 100n, updatedAt: BigInt(state.now - 30), updatedBlock: 404n,
        updatedLogIndex: 1, updatedTx: TX,
      });

      // (1) Every view answers: the figures arrive as decimal strings and the flag as a boolean. The mark's
      // multicall is recognised by its first leg; the liquidity multicall is answered as unread.
      const markCall = (answers: Array<{ status: string; result?: unknown; error?: Error }>) =>
        async ({ contracts }: { contracts: unknown[] }) => {
          const list = contracts as Array<{ functionName: string; address: string }>;
          calls.push(list.map(({ functionName, address }) => ({ functionName, address })));
          return list[0]?.functionName === "indicativeAssetsPerShare"
            ? answers
            : list.map(() => ({ status: "failure", error: new Error("execution reverted") }));
        };
      state.publicClients = { robinhood: { multicall: markCall([
        { status: "success", result: 1_004_000n },
        { status: "success", result: 10_040_000_000n },
        { status: "success", result: true },
      ]) } };
      clearCache();
      let body = route.schema.parse(await (await app.request("http://localhost/v2/earn?case=live-ok")).json());
      expect(body.vaults[0]).toEqual(expect.objectContaining({
        indicativeAssetsPerShare: "1004000", indicativeTotalAssets: "10040000000", hasOpenPosition: true,
      }));
      expect(calls).toHaveLength(2);
      expect(calls[0]!.map((call) => call.functionName))
        // fundingEnabled() rides the same multicall (a fourth leg), so it describes the same block.
        .toEqual(["indicativeAssetsPerShare", "indicativeTotalAssets", "hasOpenPosition", "fundingEnabled"]);
      for (const call of calls[0]!) expect(call.address.toLowerCase()).toBe(vault.toLowerCase());
      const vaultReads = calls.flat().filter((call) => call.address.toLowerCase() === vault.toLowerCase())
        .map((call) => call.functionName);
      expect(vaultReads).not.toContain("convertToShares");
      // A change narrowed this from "never reads convertToAssets": it is now read exactly ONCE, in the
      // liquidity multicall, only for WHY it fails (VenueUnreadable: nothing is priced). Never in the mark call, and
      // never as a price: the figures above come from the indicative views alone.
      expect(calls[0]!.map((call) => call.functionName)).not.toContain("convertToAssets");
      expect(vaultReads.filter((name) => name === "convertToAssets")).toHaveLength(1);

      // (2) One view reverts (an older deployment): that field is null, the others survive.
      state.publicClients = { robinhood: { multicall: markCall([
        { status: "failure", error: new Error("execution reverted") },
        { status: "success", result: 10_000_000_000n },
        { status: "success", result: false },
      ]) } };
      clearCache();
      body = route.schema.parse(await (await app.request("http://localhost/v2/earn?case=live-partial")).json());
      expect(body.vaults[0]).toEqual(expect.objectContaining({
        indicativeAssetsPerShare: null, indicativeTotalAssets: "10000000000", hasOpenPosition: false,
      }));

      // (3) The RPC throws: all three null, the route still answers 200 with the indexed figures.
      state.publicClients = { robinhood: { multicall: async () => { throw new Error("rpc down"); } } };
      clearCache();
      const response = await app.request("http://localhost/v2/earn?case=live-throws");
      expect(response.status).toBe(200);
      body = route.schema.parse(await response.json());
      expect(body.vaults[0]).toEqual(expect.objectContaining({
        sharesSupply: "100", indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null,
      }));
    } finally {
      state.publicClients = {};
      await teardown(pg, [
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  /**
   * These replace a test that asserted the old stub's literal `{ items: [], nextCursor: null }`.
   * That assertion passed whether or not the House tables existed or held anything, so it could
   * not distinguish "ingest landed and the vault is empty" from "the API never looks". Each test
   * below seeds a row and asserts a value derived from it: delete the seed and it fails.
   */
  it("projects House vault rows and keeps unobserved distinct from zero", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const market = V2_REGISTRY.markets[0]!;
    const vault = getAddress(`0x${"a1".repeat(20)}`);
    const underlying = market.underlying.toLowerCase() as `0x${string}`;
    try {
      await database.insert(schema.v2HouseVault).values({
        vault, underlying, sharesToken: vault, factory: USDG, kind: "daily",
        name: `House ${market.ticker}`, symbol: `h${market.ticker}`,
        createdAt: BigInt(state.now - 900), createdBlock: 500n, createdLogIndex: 1, createdTx: TX,
        sharesSupply: 1_000n, quotingPaused: false, performanceFeeBps: 0,
        currentEpochId: 7n, currentEpochEnd: BigInt(state.now + 600),
      });
      await database.insert(schema.v2HouseEpoch).values({
        id: `${vault}-7`, vault, epochId: 7n,
        start: BigInt(state.now - 600), end: BigInt(state.now + 600), status: "running",
        rolledAt: null, rolledBlock: null, rolledLogIndex: null, rolledTx: null, resultUsdg: null,
      });
      await database.insert(schema.v2HouseEpoch).values({
        id: `${vault}-6`, vault, epochId: 6n,
        start: BigInt(state.now - 1_200), end: BigInt(state.now - 600), status: "rolled",
        rolledAt: BigInt(state.now - 600), rolledBlock: 501n, rolledLogIndex: 1, rolledTx: TX2,
        resultUsdg: -25n,
      });
      // EpochRolled names neither leg, so usdg and stockUnits are null on a real row too.
      await database.insert(schema.v2HouseNav).values({
        id: `${vault}-6`, vault, epochId: 6n, at: BigInt(state.now - 600),
        usdg: null, stockUnits: null, settlementPrice: 235_000_000n, navUsdg: 9_000n,
        sourceEvent: "EpochRolled", supply: 1_000n, sharesMinted: 0n, sharesBurned: 0n,
        performanceFee: 0n, ts: BigInt(state.now - 600), block: 501n, logIndex: 1, tx: TX2,
      });
      await database.insert(schema.v2HouseShareBalance).values({
        id: `${vault}-${BUYER}`, vault, account: BUYER, shares: 250n,
        updatedAt: BigInt(state.now - 300), updatedBlock: 502n, updatedLogIndex: 1, updatedTx: TX3,
      });
      await database.insert(schema.v2HouseDepositQueue).values({
        id: `${vault.toLowerCase()}-${BUYER.toLowerCase()}`, vault, account: BUYER, epochId: 7n,
        usdgAmount: 500n, stockAmount: 0n, status: "queued",
        requestedAt: BigInt(state.now - 200), requestedBlock: 503n, requestedLogIndex: 1, requestedTx: TX3,
        closedAt: null, closedBlock: null, closedLogIndex: null, closedTx: null,
      });
      // Ingest coalesces each vault/account pair, so a simultaneous stock-only request belongs
      // to a different account rather than a second row for BUYER.
      await database.insert(schema.v2HouseDepositQueue).values({
        id: `${vault.toLowerCase()}-${WRITER.toLowerCase()}`, vault, account: WRITER, epochId: 7n,
        usdgAmount: 0n, stockAmount: 2n * 10n ** 18n, status: "queued",
        requestedAt: BigInt(state.now - 190), requestedBlock: 504n, requestedLogIndex: 1, requestedTx: TX3,
        closedAt: null, closedBlock: null, closedLogIndex: null, closedTx: null,
      });
      // Closed requests are history, not queue entries: this one must NOT appear.
      await database.insert(schema.v2HouseWithdrawQueue).values({
        id: `${vault}-${BUYER}-w`, vault, account: BUYER, epochId: 6n,
        shares: 10n, status: "claimed",
        requestedAt: BigInt(state.now - 800), requestedBlock: 499n, requestedLogIndex: 1, requestedTx: TX2,
        closedAt: BigInt(state.now - 600), closedBlock: 501n, closedLogIndex: 2, closedTx: TX2,
      });
      clearCache();

      const list = await app.request("http://localhost/v2/house");
      expect(list.status).toBe(200);
      const listBody = ROUTES.find((route) => route.route === "/v2/house")!.schema.parse(await list.json());
      expect(listBody.items).toEqual([expect.objectContaining({
        market: market.ticker,
        vault,
        kind: "daily", // The stored kind reaches the list
        sharesSupply: "1000",
        currentEpoch: expect.objectContaining({ id: "7", start: state.now - 600, end: state.now + 600, nav: null }),
      })]);

      const detail = await app.request(`http://localhost/v2/house/${market.ticker}?address=${BUYER}`);
      expect(detail.status).toBe(200);
      expect(ROUTES.find((route) => route.route === "/v2/house/:market")!.schema).toBe(houseMarketResponseSchema);
      const body = houseMarketResponseSchema.parse(await detail.json());
      expect(body.market).toBe(market.ticker);
      expect(body.vault).toBe(vault);
      expect(body.kind).toBe("daily"); // And the market detail
      expect(body.currentEpoch).toEqual(expect.objectContaining({ id: "7", resultUsdg: null, nav: null }));
      // Newest first, and the rolled epoch carries its signed result and its boundary NAV.
      expect(body.epochs.map((epoch) => epoch.id)).toEqual(["7", "6"]);
      expect(body.epochs[1]).toEqual(expect.objectContaining({
        id: "6",
        resultUsdg: expect.objectContaining({ raw: "-25" }),
        nav: expect.objectContaining({
          epoch: "6",
          usdg: null,
          stockUnits: null,
          settlementPrice: expect.objectContaining({ raw: "235000000" }),
          navUsdg: expect.objectContaining({ raw: "9000" }),
        }),
      }));
      expect(body.shares).toEqual(expect.objectContaining({ address: getAddress(BUYER), shares: "250" }));
      expect(body.queue).toEqual([
        expect.objectContaining({
          kind: "deposit", account: getAddress(BUYER), assets: "500", stockAmount: "0", shares: null,
          requestedAt: state.now - 200,
          // Queued in the vault's current epoch 7, so not priced yet; it matures at epoch 7's roll.
          epochId: "7", status: "pending", maturesAt: state.now + 600,
        }),
        expect.objectContaining({
          kind: "deposit", account: getAddress(WRITER), assets: "0", stockAmount: "2000000000000000000", shares: null,
          requestedAt: state.now - 190,
          epochId: "7", status: "pending", maturesAt: state.now + 600,
        }),
      ]);
      expect(body.shares?.queued).toEqual([body.queue![0]]);
      const stockDetail = await app.request(`http://localhost/v2/house/${market.ticker}?address=${WRITER}`);
      expect(stockDetail.status).toBe(200);
      const stockBody = ROUTES.find((route) => route.route === "/v2/house/:market")!
        .schema.parse(await stockDetail.json());
      expect(stockBody.shares?.queued).toEqual([body.queue![1]]);

      // A withdrawal queued in epoch 6, which has rolled (the vault is in 7): HouseVault.claim retires it
      // (`w.epochId < epochId`) and cancelWithdrawRequest would revert TooEarly. Still `queued` on the tape until Claimed.
      await database.insert(schema.v2HouseWithdrawQueue).values({
        id: `${vault.toLowerCase()}-${WRITER.toLowerCase()}`, vault, account: WRITER, epochId: 6n,
        shares: 40n, status: "queued",
        requestedAt: BigInt(state.now - 700), requestedBlock: 500n, requestedLogIndex: 2, requestedTx: TX2,
        closedAt: null, closedBlock: null, closedLogIndex: null, closedTx: null,
      });
      clearCache();
      const matured = houseMarketResponseSchema.parse(
        await (await app.request(`http://localhost/v2/house/${market.ticker}?address=${WRITER}`)).json());
      expect(matured.shares?.queued).toEqual([
        expect.objectContaining({ kind: "withdraw", shares: "40", epochId: "6", status: "claimable", maturesAt: state.now - 600 }),
        expect.objectContaining({ kind: "deposit", epochId: "7", status: "pending" }),
      ]);
    } finally {
      // lower() ON BOTH SIDES, and it is load-bearing. The row is stored with the address the ingest
      // wrote - lowercase - while these seeds hold the CHECKSUMMED form from getAddress(). A plain
      // `vault = $1` deleted 0 rows and reported nothing, so the seed survived its own test and every
      // later test that lists vaults saw it. That is what made three /v2/house cases red at tip.
      await teardown(pg, [
        // BUYER's claimed withdrawal and WRITER's matured one.
        ["DELETE FROM v2_house_withdraw_queue WHERE lower(vault) = lower($1)", [vault], 2],
        ["DELETE FROM v2_house_deposit_queue WHERE lower(vault) = lower($1)", [vault], 2],
        ["DELETE FROM v2_house_share_balance WHERE lower(vault) = lower($1)", [vault]],
        ["DELETE FROM v2_house_nav WHERE lower(vault) = lower($1)", [vault]],
        ["DELETE FROM v2_house_epoch WHERE lower(vault) = lower($1)", [vault], 2],
        ["DELETE FROM v2_house_vault WHERE lower(vault) = lower($1)", [vault]],
      ]);
      clearCache();
    }
  });

  /**
   * A vault with no epoch row must still be LISTED with a null epoch. Dropping it would be the
   * failure this test exists to catch: the consumer cannot distinguish "no such vault" from "a
   * vault whose epoch has not been observed".
   */
  it("a House request is claimable only once the vault rolled PAST its epoch, as HouseVault.claim decides", async () => {
    const { houseRequestStatus } = await import("./house");
    // claim: `r.epochId < epochId`; cancel: TooEarly when `r.epochId != epochId`.
    expect(houseRequestStatus(6n, 7n)).toBe("claimable");
    expect(houseRequestStatus(7n, 7n)).toBe("pending"); // same epoch: past epochEnd but not rolled is still pending
    expect(houseRequestStatus(0n, 1n)).toBe("claimable");
    expect(houseRequestStatus(7n, null)).toBe("unknown"); // the vault's epoch is not indexed: never guessed
  });

  it("lists a House vault whose epoch has not been observed, with a null epoch", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const market = V2_REGISTRY.markets[1]!;
    const vault = getAddress(`0x${"b2".repeat(20)}`);
    try {
      await database.insert(schema.v2HouseVault).values({
        vault, underlying: market.underlying.toLowerCase() as `0x${string}`, sharesToken: vault,
        factory: USDG, kind: "surprise", name: `House ${market.ticker}`, symbol: `h${market.ticker}`,
        createdAt: BigInt(state.now - 100), createdBlock: 600n, createdLogIndex: 1, createdTx: TX,
        sharesSupply: null, quotingPaused: null, performanceFeeBps: null,
        currentEpochId: null, currentEpochEnd: null,
      });
      clearCache();
      const list = await app.request("http://localhost/v2/house");
      const body = ROUTES.find((route) => route.route === "/v2/house")!.schema.parse(await list.json());
      expect(body.items).toEqual([expect.objectContaining({
        market: market.ticker, vault, currentEpoch: null, sharesSupply: null,
        kind: "unknown", // A stored value this build does not know is served unknown, never weekly
      })]);
    } finally {
      await teardown(pg, [["DELETE FROM v2_house_vault WHERE lower(vault) = lower($1)", [vault]]]);
      clearCache();
    }
  });

  it("404s a market that is not in the registry and one with no vault created", async () => {
    const { clearCache } = await import("../cache");
    clearCache();
    // Not a registry ticker at all.
    expect((await app.request("http://localhost/v2/house/NOTATICKER")).status).toBe(404);
    // A real registry ticker whose vault has never been created.
    const market = V2_REGISTRY.markets[0]!;
    expect((await app.request(`http://localhost/v2/house/${market.ticker}`)).status).toBe(404);
  });

  /**
   * A market holds two House vaults once the daily ones are live (one weekly, one daily per factory), and
   * GET /v2/house/:market used to serve `vaults[0]` - whichever row the database returned first - with no way to ask
   * for the other. `?vault=<address>` now opens one exact vault; with no `vault` a fixed rule picks (daily first).
   *
   * The seed is built so that every wrong fix goes red here:
   *   - the weekly vault is inserted FIRST and has the LOWER createdBlock, so `vaults[0]` would be the weekly one and
   *     the default-rule assertion can only pass if the rule is applied;
   *   - every field differs between the two vaults (kind, epochs, NAV, shares, queue, earliest withdrawal), so a
   *     response for the wrong vault cannot satisfy the other's assertions;
   *   - NO clearCache between the vault requests, so a cache key that drops `vault` serves the first vault's body to
   *     the second request;
   *   - both the CHECKSUMMED and the lowercase form of each address are requested: rows come back lowercase, every
   *     web link carries the checksummed form, so an exact-string pick 404s the checksummed request only.
   */
  it("?vault= serves that exact vault, defaults daily-first, and 404s a vault that is not this market's", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const market = V2_REGISTRY.markets[0]!;
    const other = V2_REGISTRY.markets[1]!;
    const weekly = getAddress(`0x${"c3".repeat(20)}`);
    const daily = getAddress(`0x${"d4".repeat(20)}`);
    const foreign = getAddress(`0x${"e5".repeat(20)}`);
    const nobody = getAddress(`0x${"f6".repeat(20)}`);
    // The checksummed forms must differ from the lowercase ones, or the case-insensitivity checks below prove nothing.
    for (const vault of [weekly, daily]) expect(vault).not.toBe(vault.toLowerCase());
    /** One letter's case flipped: still mixed case, so viem's strict check reads it as a (wrong) checksum. */
    const wrongChecksum = (() => {
      const at = [...daily].findIndex((ch, i) => i > 1 && /[a-f]/i.test(ch));
      const ch = daily[at]!;
      return daily.slice(0, at) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + daily.slice(at + 1);
    })();
    expect(wrongChecksum.toLowerCase()).toBe(daily.toLowerCase());
    expect(wrongChecksum).not.toBe(wrongChecksum.toLowerCase());
    const underlying = market.underlying.toLowerCase() as `0x${string}`;
    const vaultRow = (vault: `0x${string}`, kind: string, createdBlock: bigint, epochId: bigint, end: number,
      at: `0x${string}` = underlying) => ({
      vault, underlying: at, sharesToken: vault, factory: USDG, kind,
      name: `House ${kind}`, symbol: `h${kind}`,
      createdAt: BigInt(state.now - 5_000), createdBlock, createdLogIndex: 1, createdTx: TX,
      sharesSupply: createdBlock, quotingPaused: false, performanceFeeBps: 0,
      currentEpochId: epochId, currentEpochEnd: BigInt(end),
    });
    const running = (vault: `0x${string}`, epochId: bigint, end: number) => ({
      id: `${vault}-${epochId}`, vault, epochId, start: BigInt(state.now - 1_000), end: BigInt(end), status: "running",
      rolledAt: null, rolledBlock: null, rolledLogIndex: null, rolledTx: null, resultUsdg: null,
    });
    const deposit = (vault: `0x${string}`, account: `0x${string}`, epochId: bigint, usdgAmount: bigint, stockAmount: bigint,
      requestedAt: number) => ({
      id: `${vault.toLowerCase()}-${account.toLowerCase()}`, vault, account, epochId, usdgAmount, stockAmount,
      status: "queued", requestedAt: BigInt(requestedAt), requestedBlock: 900n, requestedLogIndex: 1, requestedTx: TX3,
      closedAt: null, closedBlock: null, closedLogIndex: null, closedTx: null,
    });
    const balance = (vault: `0x${string}`, account: `0x${string}`, shares: bigint) => ({
      id: `${vault}-${account}`, vault, account, shares,
      updatedAt: BigInt(state.now - 300), updatedBlock: 902n, updatedLogIndex: 1, updatedTx: TX3,
    });
    try {
      // Weekly FIRST, with the lower createdBlock: `vaults[0]` is the weekly vault.
      await database.insert(schema.v2HouseVault).values(vaultRow(weekly, "weekly", 700n, 3n, state.now + 3_000));
      await database.insert(schema.v2HouseVault).values(vaultRow(daily, "daily", 800n, 9n, state.now + 500));
      await database.insert(schema.v2HouseVault).values(
        vaultRow(foreign, "daily", 900n, 4n, state.now + 400, other.underlying.toLowerCase() as `0x${string}`));
      await database.insert(schema.v2HouseEpoch).values(running(weekly, 3n, state.now + 3_000));
      await database.insert(schema.v2HouseEpoch).values({
        id: `${weekly}-2`, vault: weekly, epochId: 2n,
        start: BigInt(state.now - 9_000), end: BigInt(state.now - 1_000), status: "rolled",
        rolledAt: BigInt(state.now - 1_000), rolledBlock: 750n, rolledLogIndex: 1, rolledTx: TX2, resultUsdg: 41n,
      });
      await database.insert(schema.v2HouseNav).values({
        id: `${weekly}-2`, vault: weekly, epochId: 2n, at: BigInt(state.now - 1_000),
        usdg: null, stockUnits: null, settlementPrice: 190_000_000n, navUsdg: 7_700n,
        sourceEvent: "EpochRolled", supply: 700n, sharesMinted: 0n, sharesBurned: 0n,
        performanceFee: 0n, ts: BigInt(state.now - 1_000), block: 750n, logIndex: 1, tx: TX2,
      });
      await database.insert(schema.v2HouseEpoch).values(running(daily, 9n, state.now + 500));
      await database.insert(schema.v2HouseShareBalance).values(balance(weekly, BUYER, 111n));
      await database.insert(schema.v2HouseShareBalance).values(balance(daily, BUYER, 222n));
      await database.insert(schema.v2HouseDepositQueue).values(deposit(weekly, BUYER, 3n, 700n, 0n, state.now - 250));
      await database.insert(schema.v2HouseDepositQueue).values(deposit(daily, BUYER, 9n, 900n, 0n, state.now - 240));
      await database.insert(schema.v2HouseDepositQueue).values(deposit(daily, WRITER, 9n, 0n, 3n * 10n ** 18n, state.now - 230));
      clearCache();

      expect(ROUTES.find((row) => row.route === "/v2/house/:market")!.schema).toBe(houseMarketResponseSchema);
      const detail = async (query: string) => {
        const response = await app.request(`http://localhost/v2/house/${market.ticker}${query}`);
        return { status: response.status, cache: response.headers.get("x-cache"), json: await response.json() as unknown };
      };

      // The lowercase form of each address (what the ingest stores) opens that vault. Asked FIRST, back to back with no
      // clearCache, so a cache key without `vault` serves the weekly body to the daily request here.
      for (const [vault, id] of [[weekly, "3"], [daily, "9"]] as const) {
        const res = await detail(`?vault=${vault.toLowerCase()}`);
        expect(res.status, `lowercase ${vault}`).toBe(200);
        const body = houseMarketResponseSchema.parse(res.json);
        expect(body.vault).toBe(vault);
        expect(body.currentEpoch?.id).toBe(id);
      }

      // The CHECKSUMMED form (what every web link carries), again back to back: each vault's own fields.
      const weeklyRes = await detail(`?vault=${weekly}&address=${BUYER}`);
      const dailyRes = await detail(`?vault=${daily}&address=${BUYER}`);
      expect(weeklyRes.status, `checksummed ${weekly}`).toBe(200);
      expect(dailyRes.status, `checksummed ${daily}`).toBe(200);
      expect(dailyRes.cache, "the second vault must not be served from the first vault's cache entry").toBe("MISS");
      const weeklyBody = houseMarketResponseSchema.parse(weeklyRes.json);
      const dailyBody = houseMarketResponseSchema.parse(dailyRes.json);
      expect(weeklyBody.vault).toBe(weekly);
      expect(weeklyBody.kind).toBe("weekly");
      expect(weeklyBody.currentEpoch).toEqual(expect.objectContaining({ id: "3", end: state.now + 3_000 }));
      expect(weeklyBody.epochs.map((row) => row.id)).toEqual(["3", "2"]);
      expect(weeklyBody.epochs[1]!.nav).toEqual(expect.objectContaining({ navUsdg: expect.objectContaining({ raw: "7700" }) }));
      expect(weeklyBody.shares).toEqual(expect.objectContaining({ shares: "111" }));
      expect(weeklyBody.queue).toEqual([expect.objectContaining({ account: getAddress(BUYER), assets: "700" })]);
      expect(weeklyBody.earliestWithdrawal).toEqual({ kind: "weekly", at: state.now + 3_000, reason: "epoch-boundary" });
      expect(dailyBody.vault).toBe(daily);
      expect(dailyBody.kind).toBe("daily");
      expect(dailyBody.currentEpoch).toEqual(expect.objectContaining({ id: "9", end: state.now + 500 }));
      expect(dailyBody.epochs.map((row) => row.id)).toEqual(["9"]);
      expect(dailyBody.shares).toEqual(expect.objectContaining({ shares: "222" }));
      expect(dailyBody.queue).toEqual([
        expect.objectContaining({ account: getAddress(BUYER), assets: "900" }),
        expect.objectContaining({ account: getAddress(WRITER), stockAmount: "3000000000000000000" }),
      ]);
      // 500s is inside the 1800s settlement window, so the request is already refused.
      expect(dailyBody.earliestWithdrawal).toEqual({ kind: "daily", at: null, reason: "queue-closed" });

      // No vault named: the daily vault, although vaults[0] is the weekly one.
      const fallback = houseMarketResponseSchema.parse((await detail("")).json);
      expect(fallback.vault, "the default is daily first, never database order").toBe(daily);
      expect(fallback.kind).toBe("daily");

      // `address` still filters inside the SELECTED vault: WRITER queued only in the daily vault.
      const writerWeekly = houseMarketResponseSchema.parse((await detail(`?vault=${weekly}&address=${WRITER}`)).json);
      expect(writerWeekly.vault).toBe(weekly);
      expect(writerWeekly.shares).toEqual({ address: getAddress(WRITER), shares: null, queued: [] });
      const writerDaily = houseMarketResponseSchema.parse((await detail(`?vault=${daily}&address=${WRITER}`)).json);
      expect(writerDaily.shares?.queued).toEqual([dailyBody.queue![1]]);

      // A vault that is not this market's is a 404, never the default; a malformed value is a 400.
      expect((await detail(`?vault=${foreign}`)).status, "another market's vault").toBe(404);
      expect((await detail(`?vault=${nobody}`)).status, "an address with no vault").toBe(404);
      expect((await detail("?vault=nope")).status).toBe(400);
      expect((await detail(`?vault=${wrongChecksum}`)).status, "mixed case with a wrong checksum").toBe(400);

      // The list: every vault, and inside one market daily before weekly.
      const list = await app.request("http://localhost/v2/house");
      const listBody = ROUTES.find((row) => row.route === "/v2/house")!.schema.parse(await list.json()) as {
        items: Array<{ market: string; vault: string | null; kind?: string }>;
      };
      expect(listBody.items.filter((item) => item.market === market.ticker).map((item) => [item.vault, item.kind]))
        .toEqual([[daily, "daily"], [weekly, "weekly"]]);
      expect(listBody.items.filter((item) => item.market === other.ticker).map((item) => item.vault)).toEqual([foreign]);
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_house_deposit_queue WHERE lower(vault) = lower($1)", [weekly]],
        ["DELETE FROM v2_house_deposit_queue WHERE lower(vault) = lower($1)", [daily], 2],
        ["DELETE FROM v2_house_share_balance WHERE lower(vault) = lower($1)", [weekly]],
        ["DELETE FROM v2_house_share_balance WHERE lower(vault) = lower($1)", [daily]],
        ["DELETE FROM v2_house_nav WHERE lower(vault) = lower($1)", [weekly]],
        ["DELETE FROM v2_house_epoch WHERE lower(vault) = lower($1)", [weekly], 2],
        ["DELETE FROM v2_house_epoch WHERE lower(vault) = lower($1)", [daily]],
        ["DELETE FROM v2_house_vault WHERE lower(vault) = lower($1)", [weekly]],
        ["DELETE FROM v2_house_vault WHERE lower(vault) = lower($1)", [daily]],
        ["DELETE FROM v2_house_vault WHERE lower(vault) = lower($1)", [foreign]],
      ]);
      clearCache();
    }
  });

  it("passes pricing provenance through fair, quotes and position mark sources", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const fairSchema = ROUTES.find((route) => route.route === "/v2/fair/:longId")!.schema;
    const seriesSchema = ROUTES.find((route) => route.route === "/v2/series/:longId")!.schema;
    const positionsSchema = ROUTES.find((route) => route.route === "/v2/accounts/:address/positions")!.schema;
    try {
      state.fairResult = { quote: { fair: 0n, spot: 200_000_000n, iv: 0.3, delta: 0,
        source: "model", asOf: state.now - 10 }, reasonCode: null, provenance: pricingProvenance };
      clearCache();
      const fair = fairSchema.parse(await (await app.request("http://localhost/v2/fair/2?case=zero")).json());
      expect(fair).toMatchObject({ fair: { raw: "0" }, spot: { raw: "200000000" }, provenance: pricingProvenance });
      const series = seriesSchema.parse(await (await app.request("http://localhost/v2/series/2?case=zero")).json());
      expect(series.quote).toMatchObject({ fair: { raw: "0" }, fairProvenance: pricingProvenance });
      const positions = positionsSchema.parse(await (await app.request(
        `http://localhost/v2/accounts/${BUYER}/positions?case=zero`)).json());
      expect(positions.longs.find((long: any) => long.series.longId === "2")).toMatchObject({
        mark: { raw: "0" }, markSource: "fair",
      });

      const unavailable = { ...pricingProvenance,
        entitlement: { class: "delayed" as const, declaredDelayS: 900, rightsRef: null },
        quality: { readiness: "unavailable" as const, reasons: ["fallback-provider", "chain-unavailable"],
          uncertainty: null, disagreement: null,
          fallback: { from: "primary-live", to: "backup-delayed", reason: "outage" } },
        pricedSpot: null };
      state.fairResult = { quote: null, reasonCode: "chain-unavailable", provenance: unavailable };
      await database.insert(schema.v2Order).values({ orderId: 900n, maker: WRITER, longId: 2n,
        kind: "Bid", price: 2_000_000n, units: 10n, filled: 0n,
        validUntil: BigInt(state.now + 3600), status: "open", placedAt: BigInt(state.now - 30),
        placedBlock: 104n, placedTx: TX, updatedAt: BigInt(state.now - 30) });
      clearCache();
      const failed = fairSchema.parse(await (await app.request("http://localhost/v2/fair/2?case=failed")).json());
      expect(failed).toMatchObject({ fair: null, reasonCode: "chain-unavailable", provenance: unavailable });
      const unavailableSeries = seriesSchema.parse(await (await app.request(
        "http://localhost/v2/series/2?case=failed")).json());
      expect(unavailableSeries.quote).toMatchObject({ fair: null, fairProvenance: unavailable });
      const bidMarked = positionsSchema.parse(await (await app.request(
        `http://localhost/v2/accounts/${BUYER}/positions?case=bid`)).json());
      expect(bidMarked.longs.find((long: any) => long.series.longId === "2")).toMatchObject({
        mark: { raw: "2000000" }, markSource: "best-bid",
      });

      // Past expiry, not `cutoff` -- a cutoff series still trades until expiry and keeps its mark.
      await pg.query("UPDATE v2_series SET status = 'expired' WHERE long_id = 2");
      clearCache();
      const unavailableMark = positionsSchema.parse(await (await app.request(
        `http://localhost/v2/accounts/${BUYER}/positions?case=null`)).json());
      expect(unavailableMark.longs.find((long: any) => long.series.longId === "2")).toMatchObject({
        mark: null, markSource: null,
      });
    } finally {
      await pg.query("UPDATE v2_series SET status = 'open' WHERE long_id = 2");
      await teardown(pg, [["DELETE FROM v2_order WHERE order_id = 900"]]);
      state.fairResult = { quote: null, reasonCode: null, provenance: null };
      clearCache();
    }
  });

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
      expect(config).toMatchObject({ interfaceVersion: 8, fees: { premiumFeeBps: 500, mintFeePpm: 0 },
        constants: { mintFeePeriod: 604800, mintFeeCeilPpm: 5000 } });
      // (G7): no PayoutAdapterSet indexed in this fixture, so the Clearinghouse slippage bound is null on
      // the wire (the app then prices a call's USDG band at the 300 bps ceiling), and the strict schema admits it.
      expect(config.fees.maxPayoutSlippageBps).toBeNull();
      expect(ROUTES.find((route) => route.route === "/v2/config")!.schema.safeParse(config).success).toBe(true);
    } finally {
      await pg.query("UPDATE v2_series SET mint_fee_ppm = 0, mint_fees_held = 0, mint_fees_accrued = 0 WHERE long_id = 2");
      await pg.query("UPDATE v2_market SET mint_fee_ppm = 0 WHERE underlying = $1", [MARKET]);
      clearCache();
    }
  });

  /*
   * Every series ref carries the exercise fee the series PINNED at SeriesCreated (v2_series), which is
   * what redeem charges, not the market's current default (v2_market, moved by MarketConfigSet). Two series of one
   * market pinned at different fees keep their own, on every route that ships a series ref.
   */
  it("series refs carry each series' pinned exercise fee, not the market default", async () => {
    const { clearCache } = await import("../cache");
    await pg.query("UPDATE v2_series SET exercise_fee_bps = 40 WHERE long_id = 4");
    await pg.query("UPDATE v2_market SET exercise_fee_bps = 60 WHERE underlying = $1", [MARKET]);
    try {
      clearCache();
      const two = await (await app.request("http://localhost/v2/series/2")).json() as any;
      expect(two.series.exerciseFeeBps).toBe(25);
      expect(two.exerciseFeeBps).toBe(25);
      const four = await (await app.request("http://localhost/v2/series/4")).json() as any;
      expect(four.series.exerciseFeeBps).toBe(40);
      const listed = await (await app.request("http://localhost/v2/markets/TEST/series")).json() as any;
      const refs = JSON.stringify(listed).match(/"exerciseFeeBps":\d+/g) ?? [];
      expect(refs.length).toBeGreaterThan(0);
      expect(refs).not.toContain('"exerciseFeeBps":60');
      const byId = new Map<string, number>();
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (value === null || typeof value !== "object") return;
        const row = value as Record<string, unknown>;
        if (typeof row.longId === "string" && typeof row.exerciseFeeBps === "number") byId.set(row.longId, row.exerciseFeeBps);
        Object.values(row).forEach(walk);
      };
      walk(listed);
      expect(byId.get("2")).toBe(25);
      expect(byId.get("4")).toBe(40);
      for (const route of ["/v2/series/:longId", "/v2/markets/:ticker/series"]) {
        const body = route === "/v2/series/:longId" ? four : listed;
        expect(ROUTES.find((entry) => entry.route === route)!.schema.safeParse(body).success, route).toBe(true);
      }
    } finally {
      await pg.query("UPDATE v2_series SET exercise_fee_bps = 25 WHERE long_id = 4");
      await pg.query("UPDATE v2_market SET exercise_fee_bps = 25 WHERE underlying = $1", [MARKET]);
      clearCache();
    }
  });

  /*
   * The API lists no write ask the take would skip (OrderBook.sol:1091 isMinter(book), :1101 isOperator(writer,
   * book), callhouse-contracts), read from the same indexed snapshot as the orders; the series quote
   * carries the units at the best price beside total depth.
   */
  it("withholds a write ask whose writer revoked the book or while the book is not a minter; quote carries best-level units", async () => {
    const { clearCache } = await import("../cache");
    const orderBook = process.env.V2_ORDER_BOOK!.toLowerCase();
    const bookAsks = async () => ((await (await app.request("http://localhost/v2/series/2/book")).json()) as any).asks
      .flatMap((level: any) => level.orders.map((order: any) => order.orderId));
    const cardIds = async () => ((await (await app.request("http://localhost/v2/cards")).json()) as any).items
      .map((card: any) => card.series.longId);
    try {
      // The control: both gates pass (the base seed), so the write ask is listed and priced.
      clearCache();
      expect(await bookAsks()).toEqual(["1"]);
      expect(await cardIds()).toContain("2");
      const series = (await (await app.request("http://localhost/v2/series/2")).json()) as any;
      expect(series.quote).toMatchObject({ bestAsk: { raw: "3000000" }, askUnits: "200", bestAskUnits: "200",
        bidUnits: "0", bestBidUnits: "0" });

      // The writer revoked the book as its Clearinghouse operator: the take skips the ask, so the API does too.
      await pg.query("UPDATE v2_account SET operators = $1 WHERE account = $2", [JSON.stringify({ [orderBook]: false }), WRITER]);
      clearCache();
      expect(await bookAsks()).toEqual([]);
      expect(await cardIds()).not.toContain("2");
      expect(((await (await app.request("http://localhost/v2/series/2")).json()) as any).quote)
        .toMatchObject({ bestAsk: null, askUnits: "0", bestAskUnits: "0" });

      // Operator restored, the book taken off the minter allow-list: no write ask either.
      await pg.query("UPDATE v2_account SET operators = $1 WHERE account = $2", [JSON.stringify({ [orderBook]: true }), WRITER]);
      await pg.query("UPDATE v2_minter SET allowed = false WHERE minter = $1", [orderBook]);
      clearCache();
      expect(await bookAsks()).toEqual([]);
      expect(await cardIds()).not.toContain("2");
    } finally {
      await pg.query("UPDATE v2_account SET operators = $1 WHERE account = $2", [JSON.stringify({ [orderBook]: true }), WRITER]);
      await pg.query("UPDATE v2_minter SET allowed = true WHERE minter = $1", [orderBook]);
      clearCache();
    }
  });

  it("retries a book read when indexing commits after its starting checkpoint", async () => {
    const { clearCache } = await import("../cache");
    const head = await import("./head");
    const originalHead = head.indexedHead;
    const oldCheckpoint = `${state.now.toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"105".padStart(16, "0")}`;
    const newCheckpoint = `${(state.now + 1).toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"106".padStart(16, "0")}`;
    const headRead = vi.spyOn(head, "indexedHead").mockImplementationOnce(async () => {
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

  it.each(["/series/2/book", "/cards", "/strategies?active=1"])(
    "refuses and does not cache %s while the full checkpoint keeps changing", async (route) => {
      const { clearCache } = await import("../cache");
      const headModule = await import("./head");
      const head = (await headModule.indexedHead())!;
      let revision = 0;
      // Same block and timestamp, different event positions: comparing only block/time is unsafe.
      const headRead = vi.spyOn(headModule, "indexedHead").mockImplementation(async () => ({
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

  it("identifies the payer on gifted mints and keeps fee assets distinct", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    const series = (await database.select().from(schema.v2Series)).find((s) => s.longId === 2n)!;
    await database.insert(schema.v2Series).values({ ...series, longId: 14n, isPut: true, mintFeePpm: 80 });
    for (const [longId, fee, feeRefund] of [[2n, 123456789n, 12345n], [14n, 321n, 123n]] as const) {
      await database.insert(schema.v2Mint).values({ id: `rent-mint-${longId}`, longId, writer: WRITER, longTo: BUYER,
        units: 1n, collateral: longId === 2n ? 10n ** 16n : 2_100_000n, fee,
        ts: BigInt(state.now - 60), block: 100n, logIndex: 5, tx: TX });
      await database.insert(schema.v2Close).values({ id: `rent-close-${longId}`, longId, account: WRITER,
        units: 1n, collateralFreed: longId === 2n ? 10n ** 16n : 2_100_000n, feeRefund, realisedDeltaUsdg: -500n,
        ts: BigInt(state.now - 30), block: 101n, logIndex: 5, tx: TX });
    }
    try {
      clearCache();
      const result = await list(await app.request(`http://localhost/v2/accounts/${WRITER}/history`));
      const recipient = await list(await app.request(`http://localhost/v2/accounts/${BUYER}/history`));
      for (const longId of [2n, 14n]) {
        const id = `rent-mint-${longId}`;
        expect(result.items.find((item) => item.id === id)?.data).toMatchObject({ payer: WRITER, longTo: BUYER });
        expect(recipient.items.find((item) => item.id === id)?.data).toMatchObject({ payer: WRITER, longTo: BUYER });
      }
      expect(result.items.find((item) => item.id === "rent-mint-2")?.data.fee).toMatchObject({ raw: "123456789", decimals: 18 });
      expect(result.items.find((item) => item.id === "rent-mint-14")?.data.fee).toMatchObject({ raw: "321", decimals: 6 });
      expect(result.items.find((item) => item.id === "rent-close-2")?.data).toMatchObject({
        feeRefund: { raw: "12345", decimals: 18 }, realisedPnl: { raw: "-500", decimals: 6 } });
      expect(result.items.find((item) => item.id === "rent-close-14")?.data.feeRefund).toMatchObject({ raw: "123", decimals: 6 });
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_mint WHERE id LIKE 'rent-mint-%'", [], 2],
        ["DELETE FROM v2_close WHERE id LIKE 'rent-close-%'", [], 2],
        ["DELETE FROM v2_series WHERE long_id = 14"],
      ]);
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
      await teardown(pg, [["DELETE FROM v2_stale_cancel WHERE id = 'stale-cancel-1'"]]);
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
      await teardown(pg, [["DELETE FROM v2_order WHERE order_id >= $1 AND order_id < $2", [10_000n, 21_000n], rows.length * 2]]);
      clearCache();
    }
  });

  it("rejects missing or unknown reward programmes and malformed claim addresses", async () => {
    for (const request of [
      "http://localhost/v2/rewards/epochs",
      "http://localhost/v2/rewards/epochs?program=unknown",
    ]) {
      const response = await app.request(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_program" } });
    }
    const malformed = await app.request("http://localhost/v2/rewards/not-an-address/claims");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "bad_address" } });
  });

  it("fails closed when a required MakerVault live read fails", async () => {
    const { clearCache } = await import("../cache");
    const previous = state.makerVault;
    try {
      state.makerVault = null;
      clearCache();
      const response = await app.request("http://localhost/v2/vault");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "vault_unavailable" } });
    } finally {
      state.makerVault = previous;
      clearCache();
    }
  });

  it("returns the protocol MakerVault balances, limits, outflow, orders, and tracked series", async () => {
    const { clearCache } = await import("../cache");
    clearCache();
    const response = await app.request("http://localhost/v2/vault");
    expect(response.status).toBe(200);
    // Raw JSON, not vaultResponseSchema.parse: the key-count check below must see keys the schema would strip.
    const body = await response.json() as { limits: Record<string, unknown> };
    expect(body).toMatchObject({
      vault: MAKER_VAULT,
      protocol: true,
      balances: {
        wallet: [
          { asset: NVDA_STOCK, symbol: "NVDA", free: { raw: "2000000000000000000", decimals: 18 } },
          { asset: USDG, symbol: "USDG", free: { raw: "12000000", decimals: 6 } },
        ],
        ledger: [
          { asset: NVDA_STOCK, symbol: "NVDA", free: { raw: "1000000000000000000", decimals: 18 } },
          { asset: USDG, symbol: "USDG", free: { raw: "3000000", decimals: 6 } },
        ],
      },
      limits: {
        maxSeriesUnits: "10000",
        maxTotalNotional: "250000000000",
        askToleranceBps: 100,
        maxBidBpsOfSpot: 1000,
        maxOrderLifetime: 3600,
        maxDailyOutflow: "2500000000",
      },
      outflow: { used: { raw: "500000000" }, cap: { raw: "2500000000" } },
      liveOrderCount: 3,
      trackedSeries: ["2", "4"],
    });
    expect(Object.keys(body.limits)).toHaveLength(6);
  });

  it("matches every live v2 response to the production-shaped fixture", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const market = V2_REGISTRY.markets[0]!;
    const vault = getAddress(`0x${"c3".repeat(20)}`);
    const underlying = market.underlying.toLowerCase() as `0x${string}`;
    const earnVault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const operation = {
      ...accessOperation({ operationId: TX3, nonce: 943, status: "pending", block: 743 }),
      data: "0x1234" as const, selector: null, targetName: null, functionSignature: null,
      expectedRoleId: null, roleId: 0n, roleName: "ADMIN",
      label: `unknown-target ${ACCESS_MANAGER.toLowerCase()} no-selector`,
    };
    try {
      await database.insert(schema.v2ProtocolState).values({
        id: "protocol", createPaused: false, defaultExerciseFeeBps: 37, defaultMintFeePpm: 91,
        updatedAt: BigInt(state.now),
      });
      await database.insert(schema.v2AccessRole).values({
        roleId: 3n, name: "CONFIG_ADMIN", expectedExecutionDelayS: 99_999n,
        grantDelayS: 123n, updatedAt: BigInt(state.now - 100), updatedBlock: 720n,
        updatedLogIndex: 1, updatedTx: TX,
      });
      await database.insert(schema.v2AccessRoleMember).values({
        id: `3-${BUYER}`, roleId: 3n, roleName: "CONFIG_ADMIN", account: BUYER,
        granted: true, memberSince: BigInt(state.now - 100), executionDelayS: 456n,
      });
      await database.insert(schema.v2AccessOperation).values(operation);
      await database.insert(schema.v2FeeSweep).values([
        { id: "fixture-sweep-stock", asset: NVDA_STOCK, recipient: FEE_SPLITTER, amount: 100n,
          ts: BigInt(state.now - 300), block: 730n, logIndex: 1, tx: TX },
        { id: "fixture-sweep-usdg", asset: USDG, recipient: FEE_SPLITTER, amount: 200n,
          ts: BigInt(state.now - 290), block: 731n, logIndex: 1, tx: TX2 },
      ]);
      await database.insert(schema.v2FlywheelDistribution).values([
        { id: "fixture-distribution-usdg", asset: USDG, assetIn: 50n, usdgIn: 50n,
          treasuryOut: 25n, buybackAdded: 25n, ts: BigInt(state.now - 200),
          block: 732n, logIndex: 1, tx: TX2 },
        { id: "fixture-distribution-stock", asset: NVDA_STOCK, assetIn: 40n, usdgIn: 80n,
          treasuryOut: 40n, buybackAdded: 40n, ts: BigInt(state.now - 100),
          block: 733n, logIndex: 1, tx: TX3 },
      ]);
      await database.insert(schema.v2FlywheelBurn).values({
        id: "fixture-burn", token: FLYWHEEL_TOKEN, amount: 25n, totalSupplyAtBlock: 1_000n,
        ts: BigInt(state.now - 50), block: 734n, logIndex: 1, tx: TX3,
      });
      await database.insert(schema.v2EarnVaultState).values({
        vault: earnVault, asset: USDG, adapter: null, skimBps: null, fundingEnabled: true,
        sharesSupply: 100n, updatedAt: BigInt(state.now - 50), updatedBlock: 740n,
        updatedLogIndex: 1, updatedTx: TX,
      });
      await database.insert(schema.v2EarnVaultDeposit).values({
        id: "fixture-earn-deposit", vault: earnVault, account: BUYER, receiver: BUYER,
        asset: USDG, assets: 1_000n, shares: 100n, queueId: null,
        ts: BigInt(state.now - 40), block: 741n,
        logIndex: 1, tx: TX2,
      });
      await database.insert(schema.v2EarnVaultWithdrawalQueue).values({
        id: `${earnVault.toLowerCase()}-fixture-7`, vault: earnVault, account: BUYER,
        asset: USDG, status: "queued", sharesQueued: 100n, assetsRequested: null,
        requestedAt: BigInt(state.now - 30), requestedBlock: 742n, requestedLogIndex: 1,
        requestedTx: TX3, fulfilledAssets: 60n, fulfilledAt: BigInt(state.now - 20),
        fulfilledBlock: 743n, fulfilledLogIndex: 1, fulfilledTx: TX3,
      });
      // PulledFromVenue stores "in". The public fixture must preserve that truth as "pull".
      await database.insert(schema.v2EarnVaultAdapterMove).values({
        id: "fixture-earn-move", vault: earnVault, adapter: null, asset: USDG,
        direction: "in", requested: 50n, delivered: 40n, succeeded: true,
        ts: BigInt(state.now - 20), block: 743n, logIndex: 2, tx: TX3,
      });
      await database.insert(schema.v2RewardsEpoch).values({
        id: `${REWARD_DISTRIBUTOR.toLowerCase()}-2958`, distributor: REWARD_DISTRIBUTOR.toLowerCase() as `0x${string}`,
        epoch: 2_958n, root: `0x${"a".repeat(64)}` as const, total: 25_000_000n,
        setAt: BigInt(state.now - 80), setBlock: 744n, setLogIndex: 1, setTx: TX,
      });
      await database.insert(schema.v2RewardsClaim).values({
        id: `${REWARD_DISTRIBUTOR.toLowerCase()}-2958-0`, distributor: REWARD_DISTRIBUTOR.toLowerCase() as `0x${string}`,
        epoch: 2_958n, leafIndex: 0n, account: BUYER, amount: 20_000_000n,
        ts: BigInt(state.now - 70), block: 745n, logIndex: 1, tx: TX,
      });
      await database.insert(schema.v2ContractFunding).values({
        id: "fixture-reward-funding", source: "RewardsDistributor", contract: REWARD_DISTRIBUTOR.toLowerCase() as `0x${string}`,
        from: BUYER, amount: 100_000_000n, ts: BigInt(state.now - 90),
        block: 743n, logIndex: 3, tx: TX,
      });
      await database.insert(schema.v2TreasuryExit).values({
        id: "fixture-reward-defunding", source: "rewardsDistributor",
        sourceAddress: REWARD_DISTRIBUTOR.toLowerCase() as `0x${string}`, eventKind: "defunded", assetKind: "erc20",
        asset: USDG, tokenId: null, recipient: WRITER, amount: 5_000_000n,
        ts: BigInt(state.now - 60), block: 746n, logIndex: 1, tx: TX2,
      });
      await database.insert(schema.v2HouseVault).values({
        vault, underlying, sharesToken: vault, factory: USDG, kind: "weekly",
        name: `House ${market.ticker}`, symbol: `h${market.ticker}`,
        createdAt: BigInt(state.now - 900), createdBlock: 700n, createdLogIndex: 1, createdTx: TX,
        sharesSupply: 1_000n, quotingPaused: false, performanceFeeBps: 0,
        currentEpochId: 7n, currentEpochEnd: BigInt(state.now + 600),
      });
      await database.insert(schema.v2HouseEpoch).values({
        id: `${vault}-7`, vault, epochId: 7n,
        start: BigInt(state.now - 600), end: BigInt(state.now + 600), status: "running",
        rolledAt: null, rolledBlock: null, rolledLogIndex: null, rolledTx: null, resultUsdg: null,
      });
      await database.insert(schema.v2HouseNav).values({
        id: `${vault}-7`, vault, epochId: 7n, at: BigInt(state.now - 10),
        usdg: 700n, stockUnits: 2n * 10n ** 18n, settlementPrice: 235_000_000n,
        navUsdg: 9_000n, sourceEvent: "EpochRolled", supply: 1_000n,
        sharesMinted: 0n, sharesBurned: 0n, performanceFee: 0n,
        ts: BigInt(state.now - 10), block: 701n, logIndex: 2, tx: TX2,
      });
      await database.insert(schema.v2HouseShareBalance).values({
        id: `${vault}-${BUYER}`, vault, account: BUYER, shares: 250n,
        updatedAt: BigInt(state.now - 300), updatedBlock: 701n, updatedLogIndex: 1, updatedTx: TX2,
      });
      await database.insert(schema.v2HouseDepositQueue).values([
        {
          id: `${vault.toLowerCase()}-${BUYER.toLowerCase()}`, vault, account: BUYER, epochId: 7n,
          usdgAmount: 500n, stockAmount: 0n, status: "queued",
          requestedAt: BigInt(state.now - 200), requestedBlock: 702n, requestedLogIndex: 1, requestedTx: TX3,
          closedAt: null, closedBlock: null, closedLogIndex: null, closedTx: null,
        },
        {
          id: `${vault.toLowerCase()}-${WRITER.toLowerCase()}`, vault, account: WRITER, epochId: 7n,
          usdgAmount: 0n, stockAmount: 2n * 10n ** 18n, status: "queued",
          requestedAt: BigInt(state.now - 190), requestedBlock: 703n, requestedLogIndex: 1, requestedTx: TX3,
          closedAt: null, closedBlock: null, closedLogIndex: null, closedTx: null,
        },
      ]);
      clearCache();

      expect(new Set(Object.keys(LIVE_RESPONSE_FIXTURES))).toEqual(new Set(ROUTES.map((route) => route.route)));
      for (const [route, fixture] of Object.entries(LIVE_RESPONSE_FIXTURES)) {
        const spec = ROUTES.find((entry) => entry.route === route);
        expect(spec, route).toBeDefined();
        const expected = spec!.schema.safeParse(fixture.response);
        expect(expected.success, expected.success ? "" : `${route} fixture: ${JSON.stringify(expected.error.flatten())}`)
          .toBe(true);

        const response = await app.request(`http://localhost${fixture.request}`);
        expect(response.status, `${fixture.request}: ${await response.clone().text()}`).toBe(200);
        const live: unknown = await response.json();
        const parsed = spec!.schema.safeParse(live);
        expect(parsed.success, parsed.success ? "" : `${route} live: ${JSON.stringify(parsed.error.flatten())}`)
          .toBe(true);
        expect(live, route).toEqual(fixture.response);
      }
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_treasury_exit WHERE id = 'fixture-reward-defunding'"],
        ["DELETE FROM v2_contract_funding WHERE id = 'fixture-reward-funding'"],
        ["DELETE FROM v2_rewards_claim WHERE id = $1", [`${REWARD_DISTRIBUTOR.toLowerCase()}-2958-0`]],
        ["DELETE FROM v2_rewards_epoch WHERE id = $1", [`${REWARD_DISTRIBUTOR.toLowerCase()}-2958`]],
        ["DELETE FROM v2_house_deposit_queue WHERE lower(vault) = lower($1)", [vault], 2],
        ["DELETE FROM v2_house_share_balance WHERE lower(vault) = lower($1)", [vault]],
        ["DELETE FROM v2_house_nav WHERE lower(vault) = lower($1)", [vault]],
        ["DELETE FROM v2_house_epoch WHERE lower(vault) = lower($1)", [vault]],
        ["DELETE FROM v2_house_vault WHERE lower(vault) = lower($1)", [vault]],
        ["DELETE FROM v2_earn_vault_adapter_move WHERE id = 'fixture-earn-move'"],
        ["DELETE FROM v2_earn_vault_withdrawal_queue WHERE id = $1", [`${earnVault.toLowerCase()}-fixture-7`]],
        ["DELETE FROM v2_earn_vault_deposit WHERE id = 'fixture-earn-deposit'"],
        ["DELETE FROM v2_earn_vault_state WHERE lower(vault) = lower($1)", [earnVault]],
        ["DELETE FROM v2_flywheel_burn WHERE id = 'fixture-burn'"],
        ["DELETE FROM v2_flywheel_distribution WHERE id LIKE 'fixture-distribution-%'", [], 2],
        ["DELETE FROM v2_fee_sweep WHERE id LIKE 'fixture-sweep-%'", [], 2],
        ["DELETE FROM v2_access_operation WHERE id = $1", [operation.id]],
        ["DELETE FROM v2_access_role_member WHERE id = $1", [`3-${BUYER}`]],
        ["DELETE FROM v2_access_role WHERE role_id = 3"],
        ["DELETE FROM v2_protocol_state WHERE id = 'protocol'"],
      ]);
      clearCache();
    }
  });

  it("flags launch-set membership from the registry: a registered market outside the launch set is served launch:false", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const nvda = V2_REGISTRY.markets.find((market) => market.ticker === "NVDA")!;
    // A market registered on chain that is NOT in the launch set (what --wave wave1 would have done). Cutting the
    // registry to the launch set left no registry row outside it, so a synthetic one is
    // registered here instead, with a digit-only underlying no registry names.
    expect(V2_REGISTRY.markets.every((market) => V2_REGISTRY.launchSet.markets.includes(market.ticker as never))).toBe(true);
    const offLaunch = { ticker: "OFFLAUNCH", underlying: "0x0000000000000000000000000000000000c0ffee" as const };
    expect(V2_REGISTRY.markets.some((market) => market.ticker === offLaunch.ticker)).toBe(false);
    const [marketSeed] = await database.select().from(schema.v2Market).limit(1);
    await database.insert(schema.v2Market).values({ ...marketSeed!, underlying: nvda.underlying, ticker: nvda.ticker, oracle: nvda.underlying });
    await database.insert(schema.v2Market).values({ ...marketSeed!, underlying: offLaunch.underlying, ticker: offLaunch.ticker, oracle: offLaunch.underlying });
    const { clearCache } = await import("../cache");
    clearCache();
    try {
      const response = await app.request("http://localhost/v2/markets");
      expect(response.status).toBe(200);
      const markets = await response.json() as { ticker: string; status: string; launch: boolean }[];
      const byTicker = new Map(markets.map((market) => [market.ticker, market]));
      expect(byTicker.get("NVDA")?.launch).toBe(true);
      // Registered and live on chain, yet not launch: the flag is the registry's word, not the chain's.
      expect(byTicker.get(offLaunch.ticker)?.launch).toBe(false);
      expect(byTicker.get(offLaunch.ticker)?.status).toBe(byTicker.get("NVDA")?.status);
      // The seeded TEST market is not a registry row at all: not launch either.
      expect(byTicker.get("TEST")?.launch).toBe(false);
      // The projection's launch set is the registry's: every named ticker is a market, none is invented here.
      for (const ticker of V2_REGISTRY.launchSet.markets) expect(V2_REGISTRY.markets.some((market) => market.ticker === ticker)).toBe(true);
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_market WHERE lower(underlying) = lower($1)", [nvda.underlying]],
        ["DELETE FROM v2_market WHERE lower(underlying) = lower($1)", [offLaunch.underlying]],
      ]);
      clearCache();
    }
  });

  it("counts open series by status, not by the market's created-minus-settled counter", async () => {
    // The seed market's `seriesOpen` column says 1 while two of its series are `open`; the counter only
    // moves at SeriesCreated and settlement, so a series past its mint cutoff, expired or held would still
    // be in it. The route reads status instead: the two seeded open series, and nothing added below.
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const seed = (await database.select().from(schema.v2Series)).find((row) => row.longId === 2n);
    await database.insert(schema.v2Series).values([
      { ...seed!, longId: 483_000n, status: "cutoff" },
      { ...seed!, longId: 483_002n, status: "expired" },
      { ...seed!, longId: 483_004n, status: "held" },
      { ...seed!, longId: 483_006n, status: "settling" },
    ]);
    const { clearCache } = await import("../cache");
    clearCache();
    try {
      const markets = await (await app.request("http://localhost/v2/markets")).json() as
        { ticker: string; stats: { seriesOpen: number } }[];
      const openSeeded = (await database.select().from(schema.v2Series)).filter((row) =>
        row.underlying.toLowerCase() === MARKET.toLowerCase() && row.status === "open").length;
      expect(openSeeded, "fixture: two open series, four past open").toBe(2);
      expect(markets.find((market) => market.ticker === "TEST")?.stats.seriesOpen).toBe(openSeeded);
    } finally {
      await teardown(pg, [["DELETE FROM v2_series WHERE long_id IN (483000, 483002, 483004, 483006)", [], 4]]);
      clearCache();
    }
  });

  it("serves the guardian's trading and mint brakes, and lists cutoff days apart from writable ones",
    async () => {
    // Before this the market wire carried neither brake, so a paused book or mint read as "Live".
    // A day past its mint cutoff still trades resale asks and bids, so it is listed, but never in
    // `expiries`, which a writer's expiry select reads.
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const bookId = process.env.V2_ORDER_BOOK as `0x${string}`;
    const seed = (await database.select().from(schema.v2Series)).find((row) => row.longId === 2n);
    const cutoffExpiry = BigInt(state.now + 3_600);
    type Wire = { ticker: string; tradingPaused: boolean; mintPaused: boolean; expiries: number[]; cutoffExpiries: number[] };
    const { clearCache } = await import("../cache");
    const read = async () => {
      clearCache();
      const markets = await (await app.request("http://localhost/v2/markets")).json() as Wire[];
      return markets.find((market) => market.ticker === "TEST")!;
    };
    const before = await read();
    expect(before.tradingPaused, "no TradingPausedSet row: not paused").toBe(false);
    expect(before.mintPaused).toBe(false);
    expect(before.cutoffExpiries).toEqual([]);
    try {
      await database.insert(schema.v2OrderBookState).values({ id: bookId, tradingPaused: true, updatedAt: BigInt(state.now) });
      await pg.query("UPDATE v2_market SET mint_paused = true WHERE lower(underlying) = lower($1)", [MARKET]);
      await database.insert(schema.v2Series).values([
        { ...seed!, longId: 483_100n, expiry: cutoffExpiry, mintCutoff: cutoffExpiry - 1_800n, status: "cutoff" },
        { ...seed!, longId: 483_102n, expiry: cutoffExpiry, mintCutoff: cutoffExpiry - 1_800n, status: "cutoff" },
      ]);
      const after = await read();
      expect(after.tradingPaused).toBe(true);
      expect(after.mintPaused).toBe(true);
      expect(after.cutoffExpiries, "the cutoff day, once").toEqual([Number(cutoffExpiry)]);
      expect(after.expiries, "writable days only").toEqual(before.expiries);
      expect(after.expiries).not.toContain(Number(cutoffExpiry));
    } finally {
      await pg.query("UPDATE v2_market SET mint_paused = false WHERE lower(underlying) = lower($1)", [MARKET]);
      await teardown(pg, [
        ["DELETE FROM v2_order_book_state WHERE lower(id) = lower($1)", [bookId]],
        ["DELETE FROM v2_series WHERE long_id IN (483100, 483102)", [], 2],
      ]);
      clearCache();
    }
  });

  it("projects payout-route metadata without exposing the settlement TWAP pool", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const registered = V2_REGISTRY.markets.find((market) => market.ticker === "NVDA")!;
    const [marketSeed] = await database.select().from(schema.v2Market).limit(1);
    await database.insert(schema.v2Market).values({
      ...marketSeed!,
      underlying: registered.underlying,
      ticker: registered.ticker,
      oracle: registered.underlying,
    });
    const { clearCache } = await import("../cache");
    clearCache();
    try {
      const response = await app.request("http://localhost/v2/markets");
      expect(response.status).toBe(200);
      const markets = await response.json() as { ticker: string; settlement?: {
        sourceCount: number; uncorroboratedDelayS: number; route: null |
          { venue: "v3"; fee: number } |
          { venue: "v4"; fee: number; tickSpacing: number; poolId: string };
      } }[];
      expect(markets.find((market) => market.ticker === "NVDA")?.settlement).toEqual(registered.settlement);
      expect(markets.find((market) => market.ticker === "NVDA")?.settlement?.route).toEqual(registered.payoutRoute);
      expect(markets.find((market) => market.ticker === "NVDA")?.settlement?.route)
        .not.toBe("0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3");
      expect(markets.find((market) => market.ticker === "TEST")).not.toHaveProperty("settlement");
    } finally {
      await teardown(pg, [["DELETE FROM v2_market WHERE lower(underlying) = lower($1)", [registered.underlying]]]);
      clearCache();
    }
  });

  it("serves the LIVE settlement settings (MarketConfigured, RouteSet) over the registry's", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const registered = V2_REGISTRY.markets.find((market) => market.ticker === "NVDA")!;
    const [marketSeed] = await database.select().from(schema.v2Market).limit(1);
    await database.insert(schema.v2Market).values({ ...marketSeed!, underlying: registered.underlying, ticker: registered.ticker,
      oracle: registered.underlying });
    // The admin called setMarket (one source, a 12 h wait) and setRouteV3 (fee 500): both differ from the registry.
    await database.insert(schema.v2OracleMarketConfig).values({ underlying: registered.underlying,
      sources: ["0x00000000000000000000000000000000000000c1"], maxDeviationBps: 150, uncorroboratedDelayS: 43_200n,
      spotMaxAgeS: 90_000n, updatedAt: BigInt(state.now), updatedBlock: 1n, updatedLogIndex: 0, updatedTx: TX });
    await database.insert(schema.v2PayoutRoute).values({ asset: registered.underlying.toLowerCase() as `0x${string}`, active: true,
      venue: 1, poolId: `0x${"0".repeat(64)}`, fee: 500, tickSpacing: 0, v3Pool: "0x00000000000000000000000000000000000000c2",
      feeBps: 5, changedAt: BigInt(state.now), changedBlock: 1n, changedTx: TX });
    const { clearCache } = await import("../cache");
    clearCache();
    try {
      expect(registered.settlement.sourceCount, "the registry differs, or this test proves nothing").not.toBe(1);
      const markets = await (await app.request("http://localhost/v2/markets")).json() as { ticker: string; settlement?: unknown }[];
      expect(markets.find((market) => market.ticker === "NVDA")?.settlement).toEqual({
        sourceCount: 1, uncorroboratedDelayS: 43_200, route: { venue: "v3", fee: 500 },
      });
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_oracle_market_config WHERE lower(underlying) = lower($1)", [registered.underlying]],
        ["DELETE FROM v2_payout_route WHERE lower(asset) = lower($1)", [registered.underlying]],
        ["DELETE FROM v2_market WHERE lower(underlying) = lower($1)", [registered.underlying]],
      ]);
      clearCache();
    }
  });

  it("aggregates market premiums in SQL by underlying and time window", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const alternate = "0x0000000000000000000000000000000000000055" as const;
    const [marketSeed] = await database.select().from(schema.v2Market).limit(1);
    // Ordered, so the seed is open series 2 whatever earlier tests' UPDATEs did to the heap order (an unordered
    // LIMIT 1 returned settled series 6 once another test updated series 4, and ALT then listed no expiry).
    const [seriesSeed] = await database.select().from(schema.v2Series).orderBy(schema.v2Series.longId).limit(1);
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
      await teardown(pg, [
        ["DELETE FROM v2_fill WHERE id IN ($1, $2, $3)", ["market-alt-recent", "market-alt-older", "market-test-stale"], 3],
        ["DELETE FROM v2_series WHERE long_id = $1", [10n]],
        ["DELETE FROM v2_market WHERE lower(underlying) = lower($1)", [alternate]],
      ]);
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
      await teardown(pg, [["DELETE FROM v2_market WHERE lower(underlying) = lower($1)", [alternate]]]);
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
    let movedFirstRow = false;
    try {
      const route = `http://localhost/v2/markets/TEST/series?expiry=${state.now + 86_400}&type=call&status=open&limit=1`;
      const first = await list(await app.request(route));
      expect(first.items.map((item) => item.series.longId)).toEqual(["2"]);
      expect(first.items[0]!.volume24h.raw).toBe("3600000");
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first.nextCursor).not.toBe("1");
      await pg.query('UPDATE "v2_series" SET "status" = $1 WHERE "long_id" = $2', ["cutoff", 2n]);
      movedFirstRow = true;
      const second = await list(await app.request(`${route}&cursor=${first.nextCursor}`));
      expect(second.items.map((item) => item.series.longId)).toEqual(["4"]);
      expect(second.items[0]!.volume24h.raw).toBe("0");
      expect(second.nextCursor).toBeNull();
      await pg.query('UPDATE "v2_series" SET "status" = $1 WHERE "long_id" = $2', ["open", 2n]);
      movedFirstRow = false;
      const settled = await list(await app.request("http://localhost/v2/markets/TEST/series?status=settled&limit=1"));
      expect(settled.items.map((item) => item.series.longId)).toEqual(["6"]);
      expect(settled.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
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
      expect(pages.every((statement) => !statement.includes("offset"))).toBe(true);
      const volumes = statements.filter((statement) => statement.includes('from "v2_fill"') && statement.includes("sum("));
      expect(volumes).toHaveLength(3);
      expect(volumes.every((statement) => statement.includes('"long_id"') && statement.includes('"ts"') &&
        statement.includes("where") && statement.includes("group by"))).toBe(true);
    } finally {
      if (movedFirstRow)
        await pg.query('UPDATE "v2_series" SET "status" = $1 WHERE "long_id" = $2', ["open", 2n]);
      queries.mockRestore();
      clearCache();
    }
  });

  it("uses a total order when offset-paging fills tied on timestamp and log index", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const series = (await database.select().from(schema.v2Series))
      .find((row) => row.longId === 2n)!;
    const fill = (await database.select().from(schema.v2Fill))
      .find((row) => row.id === "fill-1")!;
    const longId = 9_101n;
    const fillIds = ["trade-page-tie-a", "trade-page-tie-b"] as const;
    const tieTs = BigInt(state.now - 45);
    await database.insert(schema.v2Series).values({ ...series, longId });
    await database.insert(schema.v2Fill).values([
      { ...fill, id: fillIds[0], longId, ts: tieTs, block: 900n, logIndex: 0, tx: TX },
      { ...fill, id: fillIds[1], longId, ts: tieTs, block: 901n, logIndex: 0, tx: TX2 },
    ]);
    const { clearCache } = await import("../cache");
    clearCache();
    const querySpy = vi.spyOn(pg, "query");
    try {
      const url = `http://localhost/v2/series/${longId}/trades?limit=1`;
      const first = await list(await app.request(url));
      const second = await list(await app.request(`${url}&cursor=${first.nextCursor}`));
      const pagedIds = [...first.items, ...second.items].map((item) => item.id);

      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBe("1");
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set(pagedIds), "offset pages repeated or omitted a tied fill").toEqual(new Set(fillIds));

      const tradeQueries = querySpy.mock.calls
        .map(([statement]) => String(statement).toLowerCase().replace(/\s+/g, " "))
        .filter((statement) => statement.includes('from "v2_fill"') && statement.includes("order by"));
      expect(tradeQueries).toHaveLength(2);
      expect(tradeQueries.every((statement) =>
        /order by .*"ts" desc, .*"log_index" desc, .*"id" desc/.test(statement)),
      "without the id tiebreak, offset pages can repeat or omit a tied fill").toBe(true);
    } finally {
      querySpy.mockRestore();
      await teardown(pg, [
        ["DELETE FROM v2_fill WHERE id IN ($1, $2)", [fillIds[0], fillIds[1]], 2],
        ["DELETE FROM v2_series WHERE long_id = $1", [longId]],
      ]);
      clearCache();
    }
  });

  it("rejects malformed market-series keyset cursors", async () => {
    const encoded = (parts: unknown) => Buffer.from(JSON.stringify(parts)).toString("base64url");
    const cursors = ["", "not-base64", encoded(["1", "2"]), encoded(["-1", "2", "4"]),
      encoded(["1", "2", "x"]), encoded(["9".repeat(79), "2", "4"]), "a".repeat(513)];
    for (const cursor of cursors) {
      const response = await app.request(`http://localhost/v2/markets/TEST/series?cursor=${cursor}`);
      expect(response.status, cursor.slice(0, 32)).toBe(400);
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
      await teardown(pg, [["DELETE FROM v2_series WHERE long_id >= $1", [10_000n], unrelated.length]]);
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
      await teardown(pg, [["DELETE FROM v2_order WHERE order_id = $1", [10_000n]]]);
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
      await teardown(pg, [["DELETE FROM v2_series WHERE long_id >= $1", [10_000n], oldIds.length]]);
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

  // In the fail-closed mode (a calendar constructed with closures) a year with no closure
  // set has no session days, exactly as ExpiryCalendar._isSessionDay; a seeded year answers as before.
  // Every request below uses its own range: the route's 15 s cache is keyed by fromDay/toDay.
  it("closes an unseeded year's weekdays when the calendar fails closed", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const days = async (fromDay: number, toDay: number) => {
      const response = await app.request(`http://localhost/v2/calendar/holidays?fromDay=${fromDay}&toDay=${toDay}`);
      expect(response.status).toBe(200);
      return (await response.json() as { items: { dayIndex: number; isHoliday: boolean; isSessionDay: boolean }[] }).items;
    };
    const utcDay = (year: number, month: number, date: number) => Date.UTC(year, month - 1, date) / 86_400_000;
    const weekday = (dayIndex: number) => ![0, 6].includes(new Date(dayIndex * 86_400_000).getUTCDay());
    const today = Math.floor(state.now / 86_400); // 2027-01-15; the fixture's closure on today + 1 seeds 2027
    const jan2031 = utcDay(2031, 1, 1);
    const closure2031 = utcDay(2031, 7, 3); // outside every range requested below

    // No mode row (the switch was not seen): unchanged, 10 weekdays in two weeks.
    expect((await days(jan2031, jan2031 + 13)).filter((item) => item.isSessionDay)).toHaveLength(10);
    await database.insert(schema.v2CalendarMode).values({ id: CALENDAR_MODE_ID,
      contract: "0x00000000000000000000000000000000000000ca", constructionTx: TX, unseededYearsClosed: true });
    try {
      const seededYear = await days(today - 3, today + 3);
      expect(seededYear.filter((item) => item.isSessionDay)).toHaveLength(5);
      for (const item of seededYear) expect(item.isSessionDay).toBe(weekday(item.dayIndex) && !item.isHoliday);

      const unseeded = await days(jan2031, jan2031 + 12);
      expect(unseeded.filter((item) => weekday(item.dayIndex))).toHaveLength(9);
      expect(unseeded.filter((item) => item.isSessionDay)).toEqual([]);

      // One closure anywhere in 2031 seeds it: the route reads the whole year, not only the range.
      await database.insert(schema.v2CalendarHoliday).values({ dayIndex: closure2031, isHoliday: true,
        changedAt: BigInt(state.now), changedBlock: 200n, changedTx: TX });
      const seeded = await days(jan2031, jan2031 + 11);
      expect(seeded.map((item) => item.isSessionDay)).toEqual(seeded.map((item) => weekday(item.dayIndex)));

      // Across New Year: unseeded 2030 stays closed, seeded 2031 opens.
      for (const item of await days(utcDay(2030, 12, 26), utcDay(2031, 1, 3))) {
        expect(item.isSessionDay).toBe(item.dayIndex >= jan2031 && weekday(item.dayIndex));
      }

      // A cleared closure no longer counts, as `_closuresInYear` is decremented on chain.
      await database.update(schema.v2CalendarHoliday).set({ isHoliday: false })
        .where(eq(schema.v2CalendarHoliday.dayIndex, closure2031));
      expect((await days(jan2031, jan2031 + 10)).filter((item) => item.isSessionDay)).toEqual([]);
    } finally {
      await database.delete(schema.v2CalendarMode);
      await database.delete(schema.v2CalendarHoliday).where(eq(schema.v2CalendarHoliday.dayIndex, closure2031));
    }
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

  it("serves holders and a no-reprice strategy with null fair when pricing is unavailable", async () => {
    const holders = await list(await app.request("http://localhost/v2/series/2/holders?side=long"));
    expect(holders.items).toEqual([{ holder: BUYER, units: "100" }]);
    const strategies = await list(await app.request("http://localhost/v2/strategies?active=1"));
    expect(strategies.items).toHaveLength(1);
    expect(strategies.items[0]!.writer).toBe(WRITER);
    expect(strategies.items[0]!.currentLongId).toBe("2");
    expect(strategies.items[0]!.pricing).toEqual({
      currentAsk: { raw: "3000000", decimals: 6, formatted: "3" },
      band: {
        // The spot band's 2.00 is below the 3.00 ask's drop floor, 3.00 x 0.75 = 2.25 (AutoRoller.sol:504
        // RepriceDropExceeded, MAX_REPRICE_DROP_BPS 2_500); a reprice to 2.00 reverts, so the floor is the min.
        min: { raw: "2250000", decimals: 6, formatted: "2.25" },
        max: { raw: "10000000", decimals: 6, formatted: "10" },
      },
      lastRepricedAt: null,
      lastRepricedPrice: null,
      repriceCount: 0,
      fair: null,
    });
    const inactive = await list(await app.request("http://localhost/v2/strategies?active=0"));
    expect(inactive.items).toEqual([]);
  });

  it("retries the whole strategy snapshot across an atomic AutoRoller replacement", async () => {
    const { clearCache } = await import("../cache");
    const head = await import("./head");
    const oldCheckpoint = `${state.now.toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"105".padStart(16, "0")}`;
    const newCheckpoint = `${(state.now + 1).toString().padStart(10, "0")}${"4663".padStart(16, "0")}${"106".padStart(16, "0")}`;
    let markChildReadStarted!: () => void;
    let releaseChildRead!: () => void;
    const childReadStarted = new Promise<void>((resolve) => { markChildReadStarted = resolve; });
    const childReadWait = new Promise<void>((resolve) => { releaseChildRead = resolve; });
    const originalQuery = pg.query.bind(pg);
    let pausedOrderRead = false;
    const querySpy = vi.spyOn(pg, "query").mockImplementation(async (...args: Parameters<PGlite["query"]>) => {
      if (!pausedOrderRead && /\bfrom "v2_order"/i.test(args[0])) {
        pausedOrderRead = true;
        markChildReadStarted();
        await childReadWait;
      }
      return originalQuery(...args);
    });
    const headRead = vi.spyOn(head, "indexedHead");
    const spotReadsBefore = state.spotReads;
    const fairReadsBefore = state.fairRequests;
    try {
      clearCache();
      const pending = Promise.resolve(app.request("http://localhost/v2/strategies?active=1"));
      // The root strategy row is captured before its indexed order child starts. Publish an
      // atomic replacement while that child is paused; the full snapshot must retry, rather
      // than combining the old root with replacement children.
      await childReadStarted;
      expect(state.spotReads).toBe(spotReadsBefore);
      expect(state.fairRequests).toBe(fairReadsBefore);
      await pg.transaction(async (tx) => {
        await tx.query(`INSERT INTO v2_order
          (order_id, maker, long_id, kind, price, units, filled, valid_until, status,
           placed_at, placed_block, placed_tx, updated_at)
          VALUES (77, $1, 4, 'AskWrite', 4000000, 100, 0, $2, 'open', $3, 106, $4, $3)`,
        [WRITER, state.now + 3600, state.now, TX3]);
        await tx.query("UPDATE v2_order SET status = 'cancelled' WHERE order_id = 1");
        await tx.query("UPDATE v2_series SET strike = 190000000, expiry = $1 WHERE long_id = 4",
          [state.now + 172_800]);
        await tx.query("UPDATE v2_strategy SET current_long_id = 4, order_id = 77, expiry = $1 WHERE writer = $2",
          [state.now + 172_800, WRITER]);
        await tx.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [newCheckpoint]);
      });
      releaseChildRead();
      const response = await pending;
      expect(response.status).toBe(200);
      const strategies = await list(response);
      expect(strategies.items).toHaveLength(1);
      expect(strategies.items[0]).toMatchObject({ currentLongId: "4", orderId: "77",
        expiry: state.now + 172_800,
        pricing: { currentAsk: { raw: "4000000" }, band: null } });
      expect(pausedOrderRead).toBe(true);
      expect(headRead).toHaveBeenCalledTimes(4);
      expect(state.spotReads).toBe(spotReadsBefore + 1);
      expect(state.fairRequests).toBe(fairReadsBefore + 1);
    } finally {
      releaseChildRead();
      querySpy.mockRestore();
      headRead.mockRestore();
      await pg.transaction(async (tx) => {
        await tx.query("DELETE FROM v2_order WHERE order_id = 77");
        await tx.query("UPDATE v2_order SET status = 'open' WHERE order_id = 1");
        await tx.query("UPDATE v2_series SET strike = 220000000, expiry = $1 WHERE long_id = 4",
          [state.now + 86_400]);
        await tx.query("UPDATE v2_strategy SET current_long_id = 2, order_id = 1, expiry = $1 WHERE writer = $2",
          [state.now + 86_400, WRITER]);
        await tx.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [oldCheckpoint]);
      });
      clearCache();
    }
  });

  it("serves multiple Repriced events and current fair in USDG per whole share", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    await database.insert(schema.v2Order).values({ orderId: 9n, maker: WRITER, longId: 2n,
      kind: "AskWrite", price: 3_183_100n, units: 90n, filled: 0n,
      validUntil: BigInt(state.now + 3600), status: "open", placedAt: BigInt(state.now - 30),
      placedBlock: 104n, placedTx: TX3, updatedAt: BigInt(state.now - 30) });
    // Min 50 bps, AutoRoller.MIN_ASK_BPS. A 30 bps floor is one setStrategy refuses, and the
    // indexer's band replay now refuses it too.
    await pg.query(`UPDATE v2_strategy SET order_id = 9, min_ask_bps = 50, max_ask_bps = 150,
      ask_bps = 150, last_repriced_at = $1, last_repriced_price = 3183100, reprice_count = 2`, [state.now - 30]);
    state.fair = { fair: 2_345_600n, spot: 212_210_000n, iv: 0.3, delta: 0.2,
      asOf: state.now - 60, source: "cboe" };
    try {
      clearCache();
      const strategies = await list(await app.request("http://localhost/v2/strategies?active=1"));
      expect(strategies.items[0]!.pricing).toEqual({
        currentAsk: { raw: "3183100", decimals: 6, formatted: "3.1831" },
        band: {
          // The drop floor, 3.1831 x 0.75 = 2.387325 rounded up to the 0.0001 tick (AutoRoller.sol:504).
          min: { raw: "2387400", decimals: 6, formatted: "2.3874" },
          max: { raw: "3000000", decimals: 6, formatted: "3" },
        },
        lastRepricedAt: state.now - 30,
        lastRepricedPrice: { raw: "3183100", decimals: 6, formatted: "3.1831" },
        repriceCount: 2,
        fair: { raw: "2345600", decimals: 6, formatted: "2.3456" },
      });
    } finally {
      state.fair = null;
      await pg.query(`UPDATE v2_strategy SET order_id = 1, min_ask_bps = 100, max_ask_bps = 500,
        ask_bps = 300, last_repriced_at = NULL, last_repriced_price = NULL, reprice_count = 0`);
      await teardown(pg, [["DELETE FROM v2_order WHERE order_id = 9"]]);
      clearCache();
    }
  });

  it("returns a band only while the indexed AutoRoller position remains reprice-eligible", async () => {
    const { clearCache } = await import("../cache");
    const pricing = async () => {
      clearCache();
      const response = await list(await app.request("http://localhost/v2/strategies"));
      return response.items[0]!.pricing as { currentAsk: unknown; band: unknown };
    };
    try {
      await pg.query("UPDATE v2_strategy SET active = false");
      expect((await pricing()).band).toBeNull();

      await pg.query("UPDATE v2_strategy SET active = true, order_id = NULL");
      expect(await pricing()).toMatchObject({ currentAsk: null, band: null });

      await pg.query("UPDATE v2_strategy SET order_id = 1");
      await pg.query("UPDATE v2_order SET status = 'cancelled' WHERE order_id = 1");
      expect(await pricing()).toMatchObject({ currentAsk: null, band: null });

      await pg.query("UPDATE v2_order SET status = 'open', filled = units WHERE order_id = 1");
      expect(await pricing()).toMatchObject({ currentAsk: null, band: null });

      await pg.query("UPDATE v2_order SET filled = 0, valid_until = $1 WHERE order_id = 1", [state.now]);
      expect(await pricing()).toMatchObject({ currentAsk: null, band: null });

      await pg.query("UPDATE v2_order SET valid_until = $1 WHERE order_id = 1", [state.now + 3600]);
      state.spot = 210_000_000n;
      expect((await pricing()).band).toBeNull();

      state.spot = 200_000_000n;
      expect((await pricing()).band).toEqual({
        // The 3.00 ask's drop floor (2.25) binds above the spot band's 2.00 (AutoRoller.sol:504).
        min: { raw: "2250000", decimals: 6, formatted: "2.25" },
        max: { raw: "10000000", decimals: 6, formatted: "10" },
      });
    } finally {
      state.spot = 200_000_000n;
      await pg.query(`UPDATE v2_strategy SET active = true, order_id = 1`);
      await pg.query(`UPDATE v2_order SET status = 'open', filled = 0, valid_until = $1 WHERE order_id = 1`,
        [state.now + 3600]);
      clearCache();
    }
  });

  it("returns no eligible band while indexed OrderBook trading is paused", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const id = process.env.V2_ORDER_BOOK as `0x${string}`;
    try {
      await database.insert(schema.v2OrderBookState).values({ id, tradingPaused: true,
        updatedAt: BigInt(state.now) });
      clearCache();
      const strategies = await list(await app.request("http://localhost/v2/strategies?active=1"));
      expect(strategies.items[0]!.pricing).toMatchObject({
        currentAsk: { raw: "3000000" }, band: null,
      });
    } finally {
      await teardown(pg, [["DELETE FROM v2_order_book_state WHERE lower(id) = lower($1)", [id]]]);
      clearCache();
    }
  });

  it("returns no eligible band after the writer revokes the AutoRoller delegate", async () => {
    const { clearCache } = await import("../cache");
    try {
      await pg.query("UPDATE v2_account SET delegates = '{}' WHERE account = $1", [WRITER]);
      clearCache();
      const strategies = await list(await app.request("http://localhost/v2/strategies?active=1"));
      expect(strategies.items[0]!.pricing).toMatchObject({
        currentAsk: { raw: "3000000" }, band: null,
      });
    } finally {
      await pg.query("UPDATE v2_account SET delegates = $1 WHERE account = $2",
        [JSON.stringify({ [process.env.V2_AUTO_ROLLER!.toLowerCase()]: true }), WRITER]);
      clearCache();
    }
  });

  it("bounds fair-quote fan-out to eight across a maximum 200-strategy page", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    const extraSeries = Array.from({ length: 199 }, (_, index) => ({
      longId: 10_000n + BigInt(index) * 2n,
      underlying: MARKET,
      ticker: "TEST",
      isPut: false,
      strike: 220_000_000n + BigInt(index) * 1_000_000n,
      expiry: BigInt(state.now + 86_400),
      tenor: "daily",
      mintCutoff: BigInt(state.now + 80_000),
      oracle: MARKET,
      exerciseFeeBps: 25,
      mintFeePpm: 0,
      mintFeesHeld: 0n,
      mintFeesAccrued: 0n,
      status: "open" as const,
      openInterestUnits: 0n,
      volumeUnits: 0n,
      volumeUsdg: 0n,
      createdAt: BigInt(state.now - 1000),
      createdBlock: 90n,
      createdTx: TX,
    }));
    const extraStrategies = extraSeries.map((series, index) => {
      const writer = `0x${(0x1000 + index).toString(16).padStart(40, "0")}` as `0x${string}`;
      return { id: `${writer}-${MARKET}`, writer, underlying: MARKET, ticker: "TEST",
        active: true, weekly: true, smartPricing: true, otmBps: 200, askBps: 100,
        minAskBps: 50, maxAskBps: 200, maxUnits: 100n, currentLongId: series.longId,
        orderId: null, expiry: series.expiry, lastRolledAt: BigInt(state.now - 120),
        repriceCount: 0, updatedAt: BigInt(state.now - 120) };
    });
    await database.insert(schema.v2Series).values(extraSeries);
    await database.insert(schema.v2Strategy).values(extraStrategies);
    state.fairRequests = 0;
    state.fairInFlight = 0;
    state.maxFairInFlight = 0;
    state.yieldFair = true;
    try {
      clearCache();
      const response = await list(await app.request("http://localhost/v2/strategies?active=1&limit=200"));
      expect(response.items).toHaveLength(200);
      expect(state.fairRequests).toBe(200);
      expect(state.maxFairInFlight).toBe(8);
      expect(state.fairInFlight).toBe(0);

      state.fairRequests = 0;
      state.fairInFlight = 0;
      state.maxFairInFlight = 0;
      state.yieldFair = false;
      state.hangFair = true;
      clearCache();
      let settled = false;
      const startedAt = Date.now();
      const hangingRequest = Promise.resolve(
        app.request("http://localhost/v2/strategies?active=1&limit=200"),
      ).then((result) => { settled = true; return result; });
      for (let attempt = 0; attempt < 100 && state.fairRequests < 8; attempt += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(state.fairRequests).toBe(8);
      expect(state.maxFairInFlight).toBe(8);
      await vi.advanceTimersByTimeAsync(2_499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const hangingPage = await list(await hangingRequest);
      expect(settled).toBe(true);
      expect(Date.now() - startedAt).toBe(2_500);
      expect(hangingPage.items).toHaveLength(200);
      expect(hangingPage.items.every((item) =>
        (item.pricing as { fair: unknown }).fair === null)).toBe(true);
      expect(state.fairRequests).toBe(8);
      expect(state.maxFairInFlight).toBe(8);
    } finally {
      state.yieldFair = false;
      state.hangFair = false;
      state.fairRequests = 0;
      state.fairInFlight = 0;
      state.maxFairInFlight = 0;
      await teardown(pg, [
        ["DELETE FROM v2_strategy WHERE current_long_id >= 10000", [], extraStrategies.length],
        ["DELETE FROM v2_series WHERE long_id >= 10000", [], extraSeries.length],
      ]);
      clearCache();
    }
  });

  it("filters /v2/strategies by writer, so a writer past the first 200 rows is found", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    // 205 other writers that sort before the late writer, so one unfiltered 200-row page cannot reach it.
    const late = "0xffffffffffffffffffffffffffffffffffff0496" as `0x${string}`;
    const others = Array.from({ length: 205 }, (_, index) =>
      `0x${(0x1000 + index).toString(16).padStart(40, "0")}` as `0x${string}`);
    const strategyRow = (writer: `0x${string}`) => ({ id: `${writer}-${MARKET}`, writer, underlying: MARKET,
      ticker: "TEST", active: true, weekly: true, smartPricing: true, otmBps: 200, askBps: 100, minAskBps: 50,
      maxAskBps: 200, maxUnits: 100n, currentLongId: null, orderId: null, expiry: null, lastRolledAt: null,
      repriceCount: 0, updatedAt: BigInt(state.now - 120) });
    await database.insert(schema.v2Strategy).values([...others, late].map(strategyRow));
    try {
      clearCache();
      const unfiltered = await list(await app.request("http://localhost/v2/strategies?active=1&limit=200"));
      expect(unfiltered.items).toHaveLength(200);
      expect(unfiltered.items.some((item) => String(item.writer).toLowerCase() === late)).toBe(false);

      // Lowercase and EIP-55 forms both match the lowercase column.
      for (const form of [late, getAddress(late)]) {
        clearCache();
        const mine = await list(await app.request(`http://localhost/v2/strategies?active=1&limit=200&writer=${form}`));
        expect(mine.items.map((item) => item.writer), form).toEqual([getAddress(late)]);
        expect(mine.nextCursor).toBeNull();
      }
      clearCache();
      const seeded = await list(await app.request(`http://localhost/v2/strategies?writer=${WRITER}`));
      expect(seeded.items.map((item) => item.writer)).toEqual([getAddress(WRITER)]);
      clearCache();
      const inactive = await list(await app.request(`http://localhost/v2/strategies?active=0&writer=${late}`));
      expect(inactive.items).toEqual([]);

      const good = getAddress(late);
      const flip = good.search(/[a-fA-F]/);
      const badChecksum = good.slice(0, flip) + (good[flip] === good[flip]!.toUpperCase()
        ? good[flip]!.toLowerCase() : good[flip]!.toUpperCase()) + good.slice(flip + 1);
      expect(badChecksum).not.toBe(badChecksum.toLowerCase());
      for (const bad of ["0x1234", "nope", `${late.slice(0, -1)}g`, badChecksum, ""]) {
        const response = await app.request(`http://localhost/v2/strategies?writer=${bad}`);
        expect(response.status, bad).toBe(400);
        expect(await response.json(), bad).toMatchObject({ error: { code: "bad_writer" } });
      }
    } finally {
      await teardown(pg, [["DELETE FROM v2_strategy WHERE writer <> $1", [WRITER], others.length + 1]]);
      clearCache();
    }
  });

  it("caches /v2/strategies per writer, so one wallet is never served another's page", async () => {
    // No clearCache() anywhere in this test: the 15 s response cache must itself keep the pages apart.
    // The test cleared the cache before every request, which is how a writer-blind cache key shipped.
    // limit=7 keeps these cache keys distinct from every other test's /v2/strategies requests.
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const walletA = `0x${"502a".padStart(40, "0")}` as `0x${string}`;
    const walletB = `0x${"502b".padStart(40, "0")}` as `0x${string}`;
    const strategyRow = (writer: `0x${string}`) => ({ id: `${writer}-${MARKET}`, writer, underlying: MARKET,
      ticker: "TEST", active: true, weekly: true, smartPricing: true, otmBps: 200, askBps: 100, minAskBps: 50,
      maxAskBps: 200, maxUnits: 100n, currentLongId: null, orderId: null, expiry: null, lastRolledAt: null,
      repriceCount: 0, updatedAt: BigInt(state.now - 120) });
    await database.insert(schema.v2Strategy).values([walletA, walletB].map(strategyRow));
    const page = async (query: string) => {
      const response = await app.request(`http://localhost/v2/strategies?limit=7${query}`);
      expect(response.status, query).toBe(200);
      return (await list(response)).items.map((item) => String(item.writer).toLowerCase());
    };
    try {
      expect(await page(`&writer=${walletA}`)).toEqual([walletA]);
      // Within the same 15 s window, B must get B's page, not the cached copy of A's.
      expect(await page(`&writer=${walletB}`)).toEqual([walletB]);
      // Served from the cache this time: A still gets its own page.
      expect(await page(`&writer=${walletA}`)).toEqual([walletA]);
      // The unfiltered page is its own entry too, not either wallet's.
      const everyone = await page("");
      expect(everyone).toEqual(expect.arrayContaining([walletA, walletB]));
    } finally {
      await teardown(pg, [["DELETE FROM v2_strategy WHERE writer IN ($1, $2)", [walletA, walletB], 2]]);
    }
  });

  it("serves a closed AutoRoller position as closed, with what it closed, not as open", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    const tracked = `0x${"806a".padStart(40, "0")}` as `0x${string}`;
    const dropped = `0x${"806b".padStart(40, "0")}` as `0x${string}`;
    const torn = `0x${"806c".padStart(40, "0")}` as `0x${string}`;
    // What the PositionClosed reducer leaves (lib/v2/autoRoller.ts): no current position, order or expiry.
    const closedRow = (writer: `0x${string}`, close: { orderId: bigint | null; redeemed: boolean | null }) => ({
      id: `${writer}-${MARKET}`, writer, underlying: MARKET, ticker: "TEST", active: true, weekly: true,
      smartPricing: true, otmBps: 200, askBps: 300, minAskBps: 100, maxAskBps: 500, maxUnits: 100n,
      currentLongId: null, orderId: null, expiry: null, lastRolledAt: BigInt(state.now - 90_000), repriceCount: 0,
      lastClosedAt: BigInt(state.now - 60), lastClosedLongId: 2n, lastClosedOrderId: close.orderId,
      lastCloseRedeemed: close.redeemed, updatedAt: BigInt(state.now - 60) });
    await database.insert(schema.v2Strategy).values([
      closedRow(tracked, { orderId: 1n, redeemed: true }),
      closedRow(dropped, { orderId: null, redeemed: false }),
      // Not a state the reducer writes; the route must not invent `redeemed` for it.
      closedRow(torn, { orderId: 1n, redeemed: null }),
    ]);
    const one = async (writer: `0x${string}`) => {
      clearCache();
      const page = await list(await app.request(`http://localhost/v2/strategies?writer=${writer}`));
      expect(page.items, writer).toHaveLength(1);
      return page.items[0]!;
    };
    try {
      const closed = await one(tracked);
      expect(closed).toMatchObject({ currentLongId: null, orderId: null, expiry: null,
        lastClose: { at: state.now - 60, longId: "2", orderId: "1", redeemed: true } });
      // Order 1 is still the seeded open AskWrite on series 2: the closed position must not revive it as live.
      expect(closed.pricing).toMatchObject({ currentAsk: null, band: null });
      expect((await one(dropped)).lastClose).toEqual({ at: state.now - 60, longId: "2", orderId: null, redeemed: false });
      expect((await one(torn)).lastClose).toBeNull();
      // The seeded writer never closed: the field is present and null (the live fixture pins the whole item).
      expect((await one(WRITER)).lastClose).toBeNull();
    } finally {
      await teardown(pg, [["DELETE FROM v2_strategy WHERE writer IN ($1, $2, $3)", [tracked, dropped, torn], 3]]);
      clearCache();
    }
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

  it("fills a settled long's claimable whatever the payout preference: a put in USDG, a call in the underlying", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const holder = "0x0000000000000000000000000000000000d3fa01";
    const putId = 10_482n;
    await database.insert(schema.v2Series).values({ longId: putId, underlying: MARKET, ticker: "TEST", isPut: true,
      strike: 230_000_000n, expiry: BigInt(state.now - 86_400), tenor: "daily", mintCutoff: BigInt(state.now - 88_200),
      oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "settled",
      settlementPrice: 225_000_000n, longPayoutPerUnit: 49_875n, feePerUnit: 125n, shortPayoutPerUnit: 2_250_000n,
      settledAt: BigInt(state.now - 30), settledTx: TX, settledBlock: 101n, settledLogIndex: 4,
      openInterestUnits: 5n, volumeUnits: 0n, volumeUsdg: 0n,
      createdAt: BigInt(state.now - 200_000), createdBlock: 80n, createdTx: TX });
    await database.insert(schema.v2Balance).values([
      { id: `6-${holder}`, tokenId: 6n, holder, longId: 6n, side: "long", units: 10n },
      { id: `${putId}-${holder}`, tokenId: putId, holder, longId: putId, side: "long", units: 5n },
    ]);
    (await import("../cache")).clearCache();
    try {
      // No v2_account row: the holder is on the Clearinghouse defaults (USDG, to the wallet).
      const body = await (await app.request(`http://localhost/v2/accounts/${holder}/positions`)).json() as {
        prefs: { inKind: boolean }; longs: { series: { longId: string }; claimable: { raw: string; decimals: number } | null }[] };
      expect(body.prefs.inKind).toBe(false);
      // Clearinghouse._redeem: owed = units x longPayoutPerUnit in the collateral asset.
      expect(body.longs.find((long) => long.series.longId === putId.toString())?.claimable)
        .toMatchObject({ raw: (5n * 49_875n).toString(), decimals: 6 });
      expect(body.longs.find((long) => long.series.longId === "6")?.claimable)
        .toMatchObject({ raw: (10n * 1_596_000_000_000_000n).toString(), decimals: 18 });
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_balance WHERE holder = $1", [holder], 2],
        ["DELETE FROM v2_series WHERE long_id = $1", [putId], 1],
      ]);
      (await import("../cache")).clearCache();
    }
  });

  it("marks a long on a series past its mint cutoff, which still trades until expiry", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const holder = "0x0000000000000000000000000000000000d3fa97";
    const bidder = "0x0000000000000000000000000000000000d3fa98";
    const longId = 10_798n;
    // OrderBook._place: Bid and AskResale run to expiry; only AskWrite stops at the mint cutoff.
    await database.insert(schema.v2Series).values({ longId, underlying: MARKET, ticker: "TEST", isPut: false,
      strike: 230_000_000n, expiry: BigInt(state.now + 3_600), tenor: "daily", mintCutoff: BigInt(state.now - 60),
      oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "cutoff",
      openInterestUnits: 5n, volumeUnits: 0n, volumeUsdg: 0n,
      createdAt: BigInt(state.now - 200_000), createdBlock: 80n, createdTx: TX });
    await database.insert(schema.v2Balance).values({ id: `${longId}-${holder}`, tokenId: longId, holder, longId,
      side: "long", units: 5n });
    await database.insert(schema.v2Order).values({ orderId: 797_002n, maker: bidder, longId, kind: "Bid",
      price: 1_000_000n, units: 5n, filled: 0n, validUntil: BigInt(state.now + 1_800), status: "open",
      placedAt: BigInt(state.now - 120), placedBlock: 100n, placedTx: TX, updatedAt: BigInt(state.now - 120) });
    (await import("../cache")).clearCache();
    try {
      const body = await (await app.request(`http://localhost/v2/accounts/${holder}/positions`)).json() as {
        longs: { series: { longId: string }; mark: { raw: string } | null; markSource: string | null }[] };
      const long = body.longs.find((item) => item.series.longId === longId.toString());
      // No fair quote in this suite (state.fairResult.quote is null), so the mark is the live bid.
      expect(long).toMatchObject({ mark: { raw: "1000000" }, markSource: "best-bid" });
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_order WHERE order_id = $1", [797_002n], 1],
        ["DELETE FROM v2_balance WHERE holder = $1", [holder], 1],
        ["DELETE FROM v2_series WHERE long_id = $1", [longId], 1],
      ]);
      (await import("../cache")).clearCache();
    }
  });

  it("serves a settled short's claimable and its locked collateral as the Clearinghouse computes them", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const writer = "0x0000000000000000000000000000000000d3fa99";
    const longId = 10_800n;
    await database.insert(schema.v2Series).values({ longId, underlying: MARKET, ticker: "TEST", isPut: true,
      strike: 230_000_000n, expiry: BigInt(state.now - 86_400), tenor: "daily", mintCutoff: BigInt(state.now - 88_200),
      oracle: MARKET, exerciseFeeBps: 25, mintFeePpm: 0, mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "settled",
      settlementPrice: 225_000_000n, longPayoutPerUnit: 49_875n, feePerUnit: 125n, shortPayoutPerUnit: 2_250_000n,
      settledAt: BigInt(state.now - 30), settledTx: TX, settledBlock: 101n, settledLogIndex: 4,
      openInterestUnits: 4n, volumeUnits: 0n, volumeUsdg: 0n,
      createdAt: BigInt(state.now - 200_000), createdBlock: 80n, createdTx: TX });
    await database.insert(schema.v2Balance).values({ id: `${longId + 1n}-${writer}`, tokenId: longId + 1n, holder: writer,
      longId, side: "short", units: 4n });
    (await import("../cache")).clearCache();
    try {
      const body = await (await app.request(`http://localhost/v2/accounts/${writer}/positions`)).json() as {
        shorts: { series: { longId: string }; claimable: { raw: string; decimals: number } | null;
          collateralLocked: { raw: string; decimals: number } }[] };
      const short = body.shorts.find((item) => item.series.longId === longId.toString());
      // Clearinghouse._redeem: owed = amount x shortPayoutPerUnit; OptionMath.collateralPerUnit(put) = strike / 100.
      expect(short).toMatchObject({
        claimable: { raw: (4n * 2_250_000n).toString(), decimals: 6 },
        collateralLocked: { raw: (230_000_000n / 100n * 4n).toString(), decimals: 6 },
      });
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_balance WHERE holder = $1", [writer], 1],
        ["DELETE FROM v2_series WHERE long_id = $1", [longId], 1],
      ]);
      (await import("../cache")).clearCache();
    }
  });

  it("charges each fill's fees to the party that paid them: a bid maker pays none, a selling taker pays both", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const bidder = "0x0000000000000000000000000000000000d3fa02";
    const seller = "0x0000000000000000000000000000000000d3fa03";
    const bidTx = `0x${"8".repeat(64)}` as `0x${string}`;
    await database.insert(schema.v2Fill).values({ id: "bid-hit", orderId: 482n, longId: 2n, maker: bidder,
      taker: seller, recipient: seller, buyer: bidder, seller, units: 10n, price: 500_000n, premium: 50_000n,
      sellerFee: 2_500n, makerRebate: 500n, primary: true, takerIsBuyer: false,
      ts: BigInt(state.now - 45), block: 101n, logIndex: 9, tx: bidTx });
    await database.insert(schema.v2Take).values({ id: "bid-hit-take", taker: seller, longId: 2n, buying: false,
      units: 10n, premium: 50_000n, takerFee: 2_000n, ts: BigInt(state.now - 45), block: 101n, logIndex: 10, tx: bidTx });
    (await import("../cache")).clearCache();
    try {
      const makerRow = (await list(await app.request(`http://localhost/v2/accounts/${bidder}/history`)))
        .items.find((item) => item.id === "bid-hit")!;
      // OrderBook `_credit`: a bid maker is credited the rebate only; the seller fee is the taker's.
      expect(makerRow.data).toMatchObject({ side: "buy", role: "maker" });
      expect(makerRow.data.fee.raw).toBe("0");
      expect(makerRow.data.rebate.raw).toBe("500");
      const takerRow = (await list(await app.request(`http://localhost/v2/accounts/${seller}/history`)))
        .items.find((item) => item.id === "bid-hit")!;
      // OrderBook `take`: a selling taker is paid premium - sellerFees - takerFee.
      expect(takerRow.data).toMatchObject({ side: "sell", role: "taker" });
      expect(takerRow.data.fee.raw).toBe("4500");
      // An ask's maker is the seller and still carries its own seller fee.
      const askMaker = (await list(await app.request(`http://localhost/v2/accounts/${WRITER}/history`)))
        .items.find((item) => item.id === "fill-1")!;
      expect(askMaker.data.fee.raw).toBe("150000");
    } finally {
      await teardown(pg, [
        ["DELETE FROM v2_take WHERE id = $1", ["bid-hit-take"], 1],
        ["DELETE FROM v2_fill WHERE id = $1", ["bid-hit"], 1],
      ]);
      (await import("../cache")).clearCache();
    }
  });

  it("pages the maker snapshot by an explicit epoch id", async () => {
    const response = await app.request(`http://localhost/v2/makers?epoch=${epoch / 604_800n}&limit=1`);
    const body = await list(response);
    expect(response.status).toBe(200);
    expect(body.items[0]!.maker).toBe(WRITER);
    expect(body.items[0]!.selfTradeUnits).toBe("7");
  });

  it("scopes maker snapshots and histories in SQL while preserving epoch order and pages", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const later = epoch + 604_800n;
    const extra = [
      { id: `${BUYER}-${epoch}`, maker: BUYER, epoch, tierBps: 25, scorePpm: 900_000n },
      { id: `${RECIPIENT}-${epoch}`, maker: RECIPIENT, epoch, tierBps: 30, scorePpm: 900_000n },
      { id: `${WRITER}-${later}`, maker: WRITER, epoch: later, tierBps: 60, scorePpm: 100_000n },
    ].map((row) => ({ ...row, benchmarkPolicy: MAKER_BENCHMARK_POLICY,
      samples: 2, absentSamples: 1, validSamples: 1, missingReferenceSamples: 0,
      twoSidedSamples: 1, uptimePpm: 500_000n,
      avgSpreadBps: 20n, depthWithin100bps: 50n, depthInBand: 90n, fills: 2, volumeUsdg: 1_000_000n,
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
      await teardown(pg, [["DELETE FROM v2_maker_epoch WHERE id IN ($1, $2, $3)", extra.map((row) => row.id), extra.length]]);
      clearCache();
    }
  });

  it("absence and a measured zero are different in /v2/makers, and every item names its benchmark", async () => {
    // The defect this test exists to catch: a maker that never quoted and a maker that quoted and
    // scored zero collapse into the same score. They must never collapse into the same counts, and
    // a reader must be able to tell which benchmark produced either figure.
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const quiet = epoch + 2n * 604_800n;
    const base = { epoch: quiet, tierBps: 0, benchmarkPolicy: MAKER_BENCHMARK_POLICY, twoSidedSamples: 0,
      uptimePpm: 0n, avgSpreadBps: 0n, depthWithin100bps: 0n, depthInBand: 0n, fills: 0, volumeUsdg: 0n,
      rebatesUsdg: 0n, scorePpm: 0n };
    const rows = [
      // Never quoted: ten ticks of definite downtime, nothing measured.
      { ...base, id: `${BUYER}-${quiet}`, maker: BUYER, samples: 10, absentSamples: 10, validSamples: 0, missingReferenceSamples: 0 },
      // Quoted on every tick and measured every time; the measurement came back zero.
      { ...base, id: `${RECIPIENT}-${quiet}`, maker: RECIPIENT, samples: 10, absentSamples: 0, validSamples: 10, missingReferenceSamples: 3 },
    ];
    await database.insert(schema.v2MakerEpoch).values(rows);
    const { clearCache } = await import("../cache");
    clearCache();
    try {
      const response = await app.request(`http://localhost/v2/makers?epoch=${quiet / 604_800n}`);
      expect(response.status).toBe(200);
      const body = ROUTES.find((route) => route.route === "/v2/makers")!.schema.parse(await response.json());
      const items = body.items as Array<Record<string, any>>;
      const absent = items.find((item) => item.maker === BUYER)!;
      const measuredZero = items.find((item) => item.maker === RECIPIENT)!;

      // Same score. That is the whole point: the score cannot tell them apart.
      expect([absent.score, measuredZero.score]).toEqual([0, 0]);
      // The counts can, and do.
      expect(absent.samples).toEqual({ absent: 10, valid: 0, missingReference: 0 });
      expect(measuredZero.samples).toEqual({ absent: 0, valid: 10, missingReference: 3 });
      expect(absent.samples).not.toEqual(measuredZero.samples);
      // And every served item says which benchmark produced its figures.
      for (const item of items) expect(item.benchmarkPolicy).toBe(MAKER_BENCHMARK_POLICY);
    } finally {
      await teardown(pg, [["DELETE FROM v2_maker_epoch WHERE id IN ($1, $2)", rows.map((row) => row.id), rows.length]]);
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
      // The loop above seeds 256 fills and 256 takes, four batches of 64.
      await teardown(pg, [
        ["DELETE FROM v2_order WHERE order_id = $1", [900n]],
        ["DELETE FROM v2_fill WHERE id LIKE 'positions-irrelevant-%'", [], 256],
        ["DELETE FROM v2_take WHERE id LIKE 'positions-irrelevant-%'", [], 256],
      ]);
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
      await teardown(pg, [["DELETE FROM v2_position_pnl WHERE id = $1", [id]]]);
      await pg.query("UPDATE v2_series SET settlement_price = $1 WHERE long_id = $2", [250_000_000n, 2n]);
      clearCache();
    }
  });

  it("derives detected, blind, and clean self-trade coverage from indexed rows", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const { clearCache } = await import("../cache");
    const readStats = async () => {
      clearCache();
      const response = await app.request("http://localhost/v2/stats");
      expect(response.status).toBe(200);
      return await response.json() as {
        selfTradeUnits: string;
        selfTradeCoverage: {
          status: "detected" | "blind" | "clean";
          unseenUnits: string;
          reasons: { reason: string; units: string; fills: number }[];
        };
      };
    };
    const makerSeed = { maker: WRITER, units: 7n,
      updatedAt: BigInt(state.now - 30), updatedBlock: 103n };
    const unseenSeeds = [
      { reason: "price-above-counted-band", units: 3n, fills: 1,
        updatedAt: BigInt(state.now - 20), updatedBlock: 104n },
      { reason: "no-link-evidence", units: 5n, fills: 2,
        updatedAt: BigInt(state.now - 10), updatedBlock: 105n },
    ];
    try {
      await pg.query('DELETE FROM "v2_self_trade_unseen"');
      await pg.query('DELETE FROM "v2_self_trade_maker"');
      await database.insert(schema.v2SelfTradeMaker).values(makerSeed);
      await database.insert(schema.v2SelfTradeUnseen).values(unseenSeeds);

      const detected = await readStats();
      expect(detected.selfTradeUnits).toBe("7");
      expect(detected.selfTradeCoverage).toEqual({
        status: "detected",
        unseenUnits: "8",
        reasons: [
          { reason: "no-link-evidence", units: "5", fills: 2 },
          { reason: "price-above-counted-band", units: "3", fills: 1 },
        ],
      });

      await pg.query('DELETE FROM "v2_self_trade_maker"');
      const blind = await readStats();
      expect(blind.selfTradeUnits).toBe("0");
      expect(blind.selfTradeCoverage).toEqual({
        status: "blind",
        unseenUnits: "8",
        reasons: [
          { reason: "no-link-evidence", units: "5", fills: 2 },
          { reason: "price-above-counted-band", units: "3", fills: 1 },
        ],
      });

      await pg.query('DELETE FROM "v2_self_trade_unseen"');
      const clean = await readStats();
      expect(clean.selfTradeUnits).toBe("0");
      expect(clean.selfTradeCoverage).toEqual({ status: "clean", unseenUnits: "0", reasons: [] });
    } finally {
      await pg.query('DELETE FROM "v2_self_trade_unseen"');
      await pg.query('DELETE FROM "v2_self_trade_maker"');
      await database.insert(schema.v2SelfTradeMaker).values(makerSeed);
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
      const stats = await statsResponse.json() as { contractsFilled: string; holders: number; selfTradeUnits: string };
      expect(stats.contractsFilled).toBe("100");
      expect(stats.holders).toBe(3);
      expect(stats.selfTradeUnits).toBe("7");
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
      await teardown(pg, [
        ["DELETE FROM v2_leaderboard WHERE id = $1", [staleRankId]],
        ["DELETE FROM v2_position_pnl WHERE id = $1", [staleId]],
      ]);
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
      await teardown(pg, [["DELETE FROM v2_order_book_state WHERE lower(id) = lower($1)", [id]]]);
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
      await teardown(pg, [["DELETE FROM v2_order_book_state WHERE lower(id) = lower($1)", [id]]]);
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

/**
 * Windows anchored to the indexed head, and one
 * checkpoint per activity page.
 *
 * WHY EVERY TEST HERE MOVES THE HEAD FIRST. `createTables` writes the checkpoint at `state.now` and
 * `beforeAll` pins the fake clock to the same `state.now`, so in the default fixture the indexed head
 * and the host clock are the SAME INSTANT. A wall-clock window and a head-anchored window then return
 * identical numbers, and an assertion written against that fixture passes whichever one the route
 * uses - it cannot see its own subject. Each test below separates the two before it measures.
 *
 * NOT ASSERTED HERE: an `asOf` field on the response. The v2 bodies are validated against the frozen
 * schema in ./schema.ts, which is versioned apart
 * from these routes. So the anchoring is proven and the
 * wire field is not: a consumer still cannot distinguish a quiet day from indexer lag
 * until that field exists. That gap is deliberate and known.
 */
describe("indexed-head windows and snapshot reads", () => {
  const CHAIN = "4663".padStart(16, "0");
  const checkpointAt = (ts: bigint, block: bigint) =>
    `${ts.toString().padStart(10, "0")}${CHAIN}${block.toString().padStart(16, "0")}`;
  const setCheckpoint = async (ts: bigint, block: bigint) =>
    pg.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1", [checkpointAt(ts, block)]);
  const DEFAULT_BLOCK = 105n;
  const TX_MID = `0x${"4".repeat(64)}` as `0x${string}`;
  const LAG = 2n * 86_400n;

  it("measures the 24h and 7d windows from the indexed head, not the host clock, on /v2/stats and /v2/markets",
    async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const head = BigInt(state.now) - LAG;
    // Inside the HEAD's 24h window and two days outside the host clock's. This row is the whole
    // experiment: a wall-clock window can never see it, a head-anchored one always does.
    const inHead24h = head - 3_600n;
    // Inside the HEAD's 7d window and nine days outside the host clock's.
    const inHead7d = head - 7n * 86_400n + 3_600n;
    const sumVolume24h = (markets: { stats: { volume24h: { raw: string } } }[]) =>
      markets.reduce((total, row) => total + BigInt(row.stats.volume24h.raw), 0n);
    const sumPremium7d = (markets: { stats: { premium7d: { raw: string } } }[]) =>
      markets.reduce((total, row) => total + BigInt(row.stats.premium7d.raw), 0n);
    type Markets = { stats: { volume24h: { raw: string }; premium7d: { raw: string } } }[];
    const read = async () => {
      clearCache();
      const stats = await (await app.request("http://localhost/v2/stats")).json() as
        { volume24h: { raw: string } };
      clearCache();
      const markets = await (await app.request("http://localhost/v2/markets")).json() as Markets;
      return { stats: BigInt(stats.volume24h.raw), markets: sumVolume24h(markets),
        premium7d: sumPremium7d(markets) };
    };
    try {
      await database.insert(schema.v2Fill).values([
        { id: "fill-t188-24h", orderId: 1n, longId: 2n, maker: WRITER, taker: BUYER, recipient: BUYER,
          buyer: BUYER, seller: WRITER, units: 1n, price: 777_000n, premium: 777_000n,
          sellerFee: 0n, makerRebate: 0n, primary: true, takerIsBuyer: true,
          ts: inHead24h, block: 60n, logIndex: 1, tx: TX },
        { id: "fill-t188-7d", orderId: 1n, longId: 2n, maker: WRITER, taker: BUYER, recipient: BUYER,
          buyer: BUYER, seller: WRITER, units: 1n, price: 555_000n, premium: 555_000n,
          sellerFee: 0n, makerRebate: 0n, primary: true, takerIsBuyer: true,
          ts: inHead7d, block: 59n, logIndex: 1, tx: TX },
      ]);

      // Head == clock: neither planted fill is in a 24h window, and only the 7d one is far enough out
      // to matter later. This is the reading a wall-clock route gives in BOTH halves of the test.
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      const atHead = await read();

      // Head two days behind the clock. Nothing about the host clock changed.
      await setCheckpoint(head, DEFAULT_BLOCK);
      const lagging = await read();

      // The planted 24h fill enters the window ONLY because the window moved back with the head.
      // A wall-clock window leaves both deltas at 0, which is what makes this test able to fail.
      expect(lagging.stats - atHead.stats).toBe(777_000n);
      expect(lagging.markets - atHead.markets).toBe(777_000n);
      // /v2/stats and /v2/markets must report ONE 24h volume.
      expect(lagging.stats).toBe(lagging.markets);
      expect(atHead.stats).toBe(atHead.markets);
      // The 7d window moved back by the same two days and swept in the nine-day-old fill.
      expect(lagging.premium7d - atHead.premium7d).toBe(555_000n);
    } finally {
      await teardown(pg, [['DELETE FROM "v2_fill" WHERE "id" IN ($1, $2)', ["fill-t188-24h", "fill-t188-7d"], 2]]);
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      clearCache();
    }
  });

  it("measures no window at all when the checkpoint is missing, rather than inventing one from the clock",
    async () => {
    const { clearCache } = await import("../cache");
    try {
      await pg.query("DELETE FROM _ponder_checkpoint");
      clearCache();
      const stats = await (await app.request("http://localhost/v2/stats")).json() as
        { volume24h: { raw: string } };
      // With no head there is no measured window, so the windowed figure is zero rather than a
      // host-clock guess. The all-time figures are unaffected and stay non-zero.
      expect(stats.volume24h.raw).toBe("0");
      clearCache();
      const markets = await (await app.request("http://localhost/v2/markets")).json() as
        { stats: { volume24h: { raw: string }; premium7d: { raw: string } } }[];
      expect(markets.every((row) => row.stats.volume24h.raw === "0")).toBe(true);
      expect(markets.every((row) => row.stats.premium7d.raw === "0")).toBe(true);
    } finally {
      await pg.query("DELETE FROM _ponder_checkpoint");
      await pg.query("INSERT INTO _ponder_checkpoint VALUES ($1)",
        [checkpointAt(BigInt(state.now), DEFAULT_BLOCK)]);
      clearCache();
    }
  });

  it("keeps /v2/feed/wins and /v2/stats on the same day and week when the index lags", async () => {
    const { clearCache } = await import("../cache");
    const head = BigInt(state.now) - LAG;
    const read = async () => {
      clearCache();
      const day = await (await app.request("http://localhost/v2/feed/wins?window=day")).json() as
        { items: { id: string }[] };
      clearCache();
      const week = await (await app.request("http://localhost/v2/feed/wins?window=week")).json() as
        { items: { id: string }[] };
      clearCache();
      const stats = await (await app.request("http://localhost/v2/stats")).json() as
        { biggestWinDay: { id: string } | null; biggestWinWeek: { id: string } | null };
      return { day: day.items.map((item) => item.id), week: week.items.map((item) => item.id),
        statsDay: stats.biggestWinDay?.id ?? null, statsWeek: stats.biggestWinWeek?.id ?? null };
    };
    try {
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      const atHead = await read();
      // The fixture must actually have a win in the current day and week, or the lagged half below
      // would pass against an empty baseline and prove nothing.
      expect(atHead.day.length).toBeGreaterThan(0);
      expect(atHead.statsDay).not.toBeNull();
      expect(atHead.day).toContain(atHead.statsDay!);
      expect(atHead.week).toContain(atHead.statsWeek!);

      // Two days of lag. The indexed head's New York day holds no settlement, so BOTH routes must
      // report that same empty day. On the host clock /feed/wins keeps answering with today's wins
      // while /stats has already moved back to the head - two different "todays" on one page.
      await setCheckpoint(head, DEFAULT_BLOCK);
      const lagging = await read();
      expect(lagging.statsDay).toBeNull();
      expect(lagging.day).toEqual([]);
      // Two days back is still the same New York week, so the week is checked for AGREEMENT here and
      // for emptiness at the nine-day lag below. Asserting null here would only encode the fixture.
      if (lagging.statsWeek === null) expect(lagging.week).toEqual([]);
      else expect(lagging.week).toContain(lagging.statsWeek);

      // Nine days back leaves the head's week empty too.
      await setCheckpoint(BigInt(state.now) - 9n * 86_400n, DEFAULT_BLOCK);
      const weekBehind = await read();
      expect(weekBehind.statsWeek).toBeNull();
      expect(weekBehind.week).toEqual([]);
      // `all` is not a window and is unaffected by the head.
      clearCache();
      const all = await (await app.request("http://localhost/v2/feed/wins?window=all")).json() as
        { items: { id: string }[] };
      expect(all.items.length).toBeGreaterThan(0);
    } finally {
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      clearCache();
    }
  });

  it("builds a /v2/feed/activity page from one checkpoint when the index commits mid-route", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);
    const original = pg.query.bind(pg);
    let spy: MockInstance<typeof pg.query> | null = null;
    try {
      // Ponder commits the projection write and the checkpoint in ONE transaction. Reproduce that:
      // after the route's FIRST fill select returns, land a fill at a block the current safeBlock
      // already covers and move the checkpoint, exactly as an indexing commit would.
      // safeBlock is head.block - 3 = 102 here, and the checkpoint's BLOCK is left alone so
      // safeBlock does not move - the only thing that changes is the set of committed rows.
      let landed = false;
      spy = vi.spyOn(pg, "query").mockImplementation((async (query, params, options) => {
        const result = await original(query, params, options);
        if (!landed && query.toLowerCase().includes('from "v2_fill"')) {
          landed = true;   // set BEFORE the writes below so they cannot re-enter this branch
          // Its OWN tx with a matching Taken: matchTakeFees throws "OrderFilled without matching
          // Taken" for a fill whose transaction has no Taken covering its premium, so a fill bolted
          // onto an existing tx would fail the route for a fixture reason and prove nothing.
          await database.insert(schema.v2Fill).values({ id: "fill-t188-mid", orderId: 1n, longId: 2n,
            maker: WRITER, taker: BUYER, recipient: BUYER, buyer: BUYER, seller: WRITER, units: 1n,
            price: 111_000n, premium: 111_000n, sellerFee: 0n, makerRebate: 0n, primary: true,
            takerIsBuyer: true, ts: BigInt(state.now - 30), block: 102n, logIndex: 7, tx: TX_MID });
          await database.insert(schema.v2Take).values({ id: "take-t188-mid", taker: BUYER, longId: 2n,
            buying: true, units: 1n, premium: 111_000n, takerFee: 0n,
            ts: BigInt(state.now - 30), block: 102n, logIndex: 8, tx: TX_MID });
          await original("UPDATE _ponder_checkpoint SET latest_checkpoint = $1",
            [checkpointAt(BigInt(state.now) + 1n, DEFAULT_BLOCK)]);
        }
        return result;
      }) as typeof pg.query);
      clearCache();
      const duringResponse = await app.request("http://localhost/v2/feed/activity");
      const duringText = await duringResponse.text();
      // Surface the body: a bare .json() on a 500 reports a JSON parse error and hides the cause.
      expect(duringResponse.status, duringText).toBe(200);
      const during = JSON.parse(duringText) as { items: { id: string }[] };
      spy.mockRestore();
      spy = null;

      // The page the settled index gives, with nothing moving underneath it.
      clearCache();
      const after = await (await app.request("http://localhost/v2/feed/activity")).json() as
        { items: { id: string }[] };

      // Read at ONE checkpoint, the interfered page is the settled page. Read at two, the fill that
      // landed after the fills select is missing from the page while later selects already saw the
      // committed state - the page is a mix of two index states, and the item is skipped.
      expect(ids(during)).toEqual(ids(after));
      expect(ids(during)).toContain("fill-t188-mid");
      // ...and no item is served twice within one page.
      expect(new Set(ids(during)).size).toBe(ids(during).length);
    } finally {
      spy?.mockRestore();
      await pg.query('DELETE FROM "v2_fill" WHERE "id" = $1', ["fill-t188-mid"]);
      await pg.query('DELETE FROM "v2_take" WHERE "id" = $1', ["take-t188-mid"]);
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      clearCache();
    }
  });
});

/**
 * `asOf` in the JSON contract.
 *
 * A change anchored the trailing windows of /v2/markets and /v2/markets/:ticker/series to the indexed
 * head, but the head never reached the wire: the response cache replays body and status only, so the
 * header it first tried would have vanished on every cache HIT, and the frozen schema was owned by
 * another row at the time. Anchoring without publishing leaves a consumer unable to tell a genuine
 * quiet day from indexer lag -- the figures simply differ, with nothing on the response saying why.
 *
 * The same fixture rule as the block applies and matters more here: `createTables` writes the
 * checkpoint at `state.now` and the fake clock is pinned to the same `state.now`, so an `asOf` taken
 * from the host clock and one taken from the head are IDENTICAL in the stock fixture. A test that
 * does not move them apart first cannot fail, whichever source the route uses.
 */
describe("windowed figures carry asOf", () => {
  const CHAIN = "4663".padStart(16, "0");
  const DEFAULT_BLOCK = 105n;
  const setCheckpoint = async (ts: bigint, block: bigint) =>
    pg.query("UPDATE _ponder_checkpoint SET latest_checkpoint = $1",
      [`${ts.toString().padStart(10, "0")}${CHAIN}${block.toString().padStart(16, "0")}`]);

  it("publishes the indexed head, not the host clock, as asOf on /v2/markets and the series page", async () => {
    const { clearCache } = await import("../cache");
    const LAG = 2n * 86_400n;
    const head = BigInt(state.now) - LAG;
    type Markets = { stats: { asOf: number; volume24h: { raw: string } } }[];
    type Series = { asOf: number; items: unknown[] };
    const read = async () => {
      clearCache();
      const markets = await (await app.request("http://localhost/v2/markets")).json() as Markets;
      clearCache();
      const series = await (await app.request(
        `http://localhost/v2/markets/TEST/series?expiry=${state.now + 86_400}`)).json() as Series;
      return { markets, series };
    };
    try {
      // Head == clock. Both sources agree here, which is exactly why this half proves nothing on its
      // own and is only a baseline for the lagged half below.
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      const level = await read();
      expect(level.markets.length).toBeGreaterThan(0);
      expect(level.markets.every((m) => m.stats.asOf === state.now)).toBe(true);
      expect(level.series.asOf).toBe(state.now);

      // Two days of indexer lag; the host clock has not moved. asOf must follow the HEAD.
      await setCheckpoint(head, DEFAULT_BLOCK);
      const lagging = await read();
      expect(lagging.markets.every((m) => m.stats.asOf === Number(head))).toBe(true);
      expect(lagging.series.asOf).toBe(Number(head));
      // ...and it must not be the wall clock, which is what a Date.now() asOf would report.
      expect(lagging.markets.every((m) => m.stats.asOf !== state.now)).toBe(true);
      expect(lagging.series.asOf).not.toBe(state.now);
      // One head per response: every market on the page carries the same asOf, so two markets
      // cannot disagree about when the page was measured.
      expect(new Set(lagging.markets.map((m) => m.stats.asOf)).size).toBe(1);
      // DELIBERATELY NOT ASSERTED: that the figures changed when the head moved. They do not here,
      // and that is a property of this fixture rather than of the fix. The 24h window is
      // `ts >= asOf - 86400` with NO UPPER BOUND, so moving the head back only ever WIDENS it, and
      // every fill in the stock fixture is inside both the level and the lagged window.
      // `measures the 24h and 7d windows from the indexed head` plants a fill in the gap precisely
      // to create that delta and pins the arithmetic; this test pins the PUBLISHED anchor, which is
      // all changes. Asserting a difference here would encode a fixture accident as a rule.
    } finally {
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      clearCache();
    }
  });

  it("publishes the same indexed head on /v2/stats as on /v2/markets", async () => {
    const { clearCache } = await import("../cache");
    const LAG = 2n * 86_400n;
    const head = BigInt(state.now) - LAG;
    const read = async () => {
      clearCache();
      const stats = await (await app.request("http://localhost/v2/stats")).json() as { asOf: number };
      clearCache();
      const markets = await (await app.request("http://localhost/v2/markets")).json() as
        { stats: { asOf: number } }[];
      return { stats: stats.asOf, markets: markets.map((m) => m.stats.asOf) };
    };
    try {
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      const level = await read();
      expect(level.stats).toBe(state.now);

      // Two days of lag, host clock unmoved. /v2/stats must follow the HEAD, and must agree with
      // /v2/markets: the site renders both, and two different "as of" instants on one page is the
      // same defect as two different 24h volumes, which is exactly what this test forbids.
      await setCheckpoint(head, DEFAULT_BLOCK);
      const lagging = await read();
      expect(lagging.stats).toBe(Number(head));
      expect(lagging.stats).not.toBe(state.now);
      expect(lagging.markets.every((a) => a === lagging.stats)).toBe(true);
    } finally {
      await setCheckpoint(BigInt(state.now), DEFAULT_BLOCK);
      clearCache();
    }
  });

  it("serves asOf 0 on /v2/stats too when no checkpoint can be read", async () => {
    const { clearCache } = await import("../cache");
    try {
      await pg.query("DELETE FROM _ponder_checkpoint");
      clearCache();
      const stats = await (await app.request("http://localhost/v2/stats")).json() as
        { asOf: number; volume24h: { raw: string }; biggestWinDay: unknown; biggestWinWeek: unknown };
      // Same degraded answer as /v2/markets, and the frozen schema still requires the field.
      expect(stats.asOf).toBe(0);
      expect(stats.volume24h.raw).toBe("0");
      expect(stats.biggestWinDay).toBeNull();
      expect(stats.biggestWinWeek).toBeNull();
    } finally {
      await pg.query("DELETE FROM _ponder_checkpoint");
      await pg.query("INSERT INTO _ponder_checkpoint VALUES ($1)",
        [`${state.now.toString().padStart(10, "0")}${CHAIN}${DEFAULT_BLOCK.toString().padStart(16, "0")}`]);
      clearCache();
    }
  });

  it("serves asOf 0, not a host-clock guess, when no checkpoint can be read", async () => {
    const { clearCache } = await import("../cache");
    try {
      await pg.query("DELETE FROM _ponder_checkpoint");
      clearCache();
      const markets = await (await app.request("http://localhost/v2/markets")).json() as
        { stats: { asOf: number; volume24h: { raw: string }; premium7d: { raw: string } } }[];
      // asOf stays REQUIRED and is 0 -- a value no real head can take -- rather than absent or null,
      // so the twin guard keeps holding and a consumer reads "no window was measured" instead of
      // having to infer it from two zero figures.
      expect(markets.every((m) => m.stats.asOf === 0)).toBe(true);
      expect(markets.every((m) => m.stats.volume24h.raw === "0")).toBe(true);
      expect(markets.every((m) => m.stats.premium7d.raw === "0")).toBe(true);
    } finally {
      await pg.query("DELETE FROM _ponder_checkpoint");
      await pg.query("INSERT INTO _ponder_checkpoint VALUES ($1)",
        [`${state.now.toString().padStart(10, "0")}${CHAIN}${DEFAULT_BLOCK.toString().padStart(16, "0")}`]);
      clearCache();
    }
  });

  it("refuses with a 503, never a time-zero answer, when the checkpoint query itself FAILS", async () => {
    const { clearCache } = await import("../cache");
    // Every route below reads the indexed head. A MISSING checkpoint (the tests above) measures no
    // window by design; a query that FAILED must not be read as that. Only the checkpoint table is
    // hidden, so the head read is the one read that fails: every other select still has its table.
    const paths = ["/v2/stats", "/v2/markets", "/v2/markets/TEST/series", "/v2/config", "/v2/flywheel",
      "/v2/admin/operations", "/v2/feed/wins?window=day", "/v2/leaderboard?window=week"];
    for (const path of paths) {
      clearCache();
      expect((await app.request(`http://localhost${path}`)).status, `${path} control`).toBe(200);
    }
    try {
      await pg.query("ALTER TABLE _ponder_checkpoint RENAME TO _ponder_checkpoint_hidden");
      for (const path of paths) {
        clearCache();
        const response = await app.request(`http://localhost${path}`);
        expect(response.status, path).toBe(503);
        expect(response.headers.get("cache-control"), path).toBe("no-store");
        expect((await response.json() as { error: { code: string } }).error.code, path).toBe("head_unavailable");
      }
      clearCache();
      const health = await app.request("http://localhost/v2/health");
      expect(health.status).toBe(503);
      expect((await health.json() as { status: string }).status).toBe("degraded");
    } finally {
      await pg.query("ALTER TABLE IF EXISTS _ponder_checkpoint_hidden RENAME TO _ponder_checkpoint");
      clearCache();
    }
  });
});
