import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../ponder.schema";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { MAKER_BENCHMARK_POLICY } from "../../../lib/v2/makerScoring";
import { LIVE_RESPONSE_FIXTURES } from "./live-response.fixture";
import { ROUTES } from "./schema";
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
    // T-OP-086: the /earn route's live mark reads through `publicClients[CHAIN_NAME].multicall`. Empty by
    // default (no client -> every live field null); a test installs a fake client to drive the other states.
    publicClients: {} as Record<string, { multicall: (args: { contracts: unknown[] }) => Promise<unknown> }> };
});

vi.mock("ponder:api", () => ({ get db() { return state.db; }, get publicClients() { return state.publicClients; } }));
vi.mock("ponder:schema", () => ({ ...schema, default: schema }));
vi.mock("../../../lib/v2/pricing", () => ({
  // X3-302 drives this through state.fairResult; X3-304 drives it through state.fair and the
  // in-flight counters. Both are kept: the counters always run, and state.fair wins when an
  // X3-304 test has set it, otherwise the X3-302 result's quote is returned.
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
  await database.insert(schema.v2Account).values({ account: WRITER,
    delegates: JSON.stringify({ [process.env.V2_AUTO_ROLLER!.toLowerCase()]: true }),
    firstSeen: BigInt(state.now - 120), lastSeen: BigInt(state.now - 120) });
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
    // samples is absent + valid; missingReference sits outside it (X8-312).
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
        // T-OP-120 (G7): PayoutAdapterSet's maxSlippageBps reaches the wire as fees.maxPayoutSlippageBps.
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
      const config = ROUTES.find((route) => route.route === "/v2/config")!.schema.parse(await response.json());
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

  // T-434. `id` is AccessManager's operation id and it REPEATS across a reschedule; the ingest row
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
      data: "0x1234", selector: null, targetName: null, functionSignature: null,
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
        vault, asset: USDG, adapter: null, skimBps: null, paused: false,
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
        paused: false,
        queue: { depth: 1, oldestRequestedAt: state.now - 30 },
        lastAdapterMove: expect.objectContaining({ delivered: null, requested: "50", direction: "pull" }),
        // T-OP-086: no public client in this scenario -> the live mark is "not read", null on all three.
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

  it("maps production Earn adapter directions instead of dropping them", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, paused: false,
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
      // T-OP-086: both production sites carry the live fields, null without a client.
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
   * T-OP-086 (SEC-19 / T-OP-065). The live mark: read from the vault's own `indicativeAssetsPerShare()` /
   * `indicativeTotalAssets()` / `hasOpenPosition()` in ONE multicall with allowFailure, forwarded as strings and
   * a boolean; a reverting or absent view (an older deployment) yields null for that field and only that field;
   * a client that throws yields null for all three -- never a 500, never a fabricated "0". Nothing here reads
   * `convertToShares` / `convertToAssets`: the fake client asserts the function names it was asked for.
   */
  it("reads the indicative mark live with allowFailure and says null, not zero, for what it could not read", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const vault = getAddress(process.env.V2_EARN_VAULT as `0x${string}`);
    const route = ROUTES.find((item) => item.route === "/v2/earn")!;
    const asked: string[] = [];
    try {
      await database.insert(schema.v2EarnVaultState).values({
        vault, asset: USDG, adapter: null, skimBps: null, paused: false,
        sharesSupply: 100n, updatedAt: BigInt(state.now - 30), updatedBlock: 404n,
        updatedLogIndex: 1, updatedTx: TX,
      });

      // (1) Every view answers: the figures arrive as decimal strings and the flag as a boolean.
      state.publicClients = { robinhood: { multicall: async ({ contracts }) => {
        for (const call of contracts as Array<{ functionName: string; address: string }>) {
          asked.push(call.functionName);
          expect(call.address.toLowerCase()).toBe(vault.toLowerCase());
        }
        return [
          { status: "success", result: 1_004_000n },
          { status: "success", result: 10_040_000_000n },
          { status: "success", result: true },
        ];
      } } };
      clearCache();
      let body = route.schema.parse(await (await app.request("http://localhost/v2/earn?case=live-ok")).json());
      expect(body.vaults[0]).toEqual(expect.objectContaining({
        indicativeAssetsPerShare: "1004000", indicativeTotalAssets: "10040000000", hasOpenPosition: true,
      }));
      expect(asked).toEqual(["indicativeAssetsPerShare", "indicativeTotalAssets", "hasOpenPosition"]);
      expect(asked).not.toContain("convertToShares");
      expect(asked).not.toContain("convertToAssets");

      // (2) One view reverts (a deployment older than T-OP-065): that field is null, the others survive.
      state.publicClients = { robinhood: { multicall: async () => [
        { status: "failure", error: new Error("execution reverted") },
        { status: "success", result: 10_000_000_000n },
        { status: "success", result: false },
      ] } };
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
        vault, underlying, sharesToken: vault, factory: USDG,
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
        sharesSupply: "1000",
        currentEpoch: expect.objectContaining({ id: "7", start: state.now - 600, end: state.now + 600, nav: null }),
      })]);

      const detail = await app.request(`http://localhost/v2/house/${market.ticker}?address=${BUYER}`);
      expect(detail.status).toBe(200);
      const body = ROUTES.find((route) => route.route === "/v2/house/:market")!.schema.parse(await detail.json());
      expect(body.market).toBe(market.ticker);
      expect(body.vault).toBe(vault);
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
        }),
        expect.objectContaining({
          kind: "deposit", account: getAddress(WRITER), assets: "0", stockAmount: "2000000000000000000", shares: null,
          requestedAt: state.now - 190,
        }),
      ]);
      expect(body.shares?.queued).toEqual([body.queue[0]]);
      const stockDetail = await app.request(`http://localhost/v2/house/${market.ticker}?address=${WRITER}`);
      expect(stockDetail.status).toBe(200);
      const stockBody = ROUTES.find((route) => route.route === "/v2/house/:market")!
        .schema.parse(await stockDetail.json());
      expect(stockBody.shares?.queued).toEqual([body.queue[1]]);
    } finally {
      // lower() ON BOTH SIDES, and it is load-bearing. The row is stored with the address the ingest
      // wrote - lowercase - while these seeds hold the CHECKSUMMED form from getAddress(). A plain
      // `vault = $1` deleted 0 rows and reported nothing, so the seed survived its own test and every
      // later test that lists vaults saw it. That is what made three /v2/house cases red at tip.
      await teardown(pg, [
        ["DELETE FROM v2_house_withdraw_queue WHERE lower(vault) = lower($1)", [vault]],
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
   * failure this row exists to kill: the consumer cannot distinguish "no such vault" from "a
   * vault whose epoch has not been observed".
   */
  it("lists a House vault whose epoch has not been observed, with a null epoch", async () => {
    const { clearCache } = await import("../cache");
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const market = V2_REGISTRY.markets[1]!;
    const vault = getAddress(`0x${"b2".repeat(20)}`);
    try {
      await database.insert(schema.v2HouseVault).values({
        vault, underlying: market.underlying.toLowerCase() as `0x${string}`, sharesToken: vault,
        factory: USDG, name: `House ${market.ticker}`, symbol: `h${market.ticker}`,
        createdAt: BigInt(state.now - 100), createdBlock: 600n, createdLogIndex: 1, createdTx: TX,
        sharesSupply: null, quotingPaused: null, performanceFeeBps: null,
        currentEpochId: null, currentEpochEnd: null,
      });
      clearCache();
      const list = await app.request("http://localhost/v2/house");
      const body = ROUTES.find((route) => route.route === "/v2/house")!.schema.parse(await list.json());
      expect(body.items).toEqual([expect.objectContaining({
        market: market.ticker, vault, currentEpoch: null, sharesSupply: null,
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

      await pg.query("UPDATE v2_series SET status = 'cutoff' WHERE long_id = 2");
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
      // T-OP-120 (G7): no PayoutAdapterSet indexed in this fixture, so the Clearinghouse slippage bound is null on
      // the wire (the app then prices a call's USDG band at the 300 bps ceiling), and the strict schema admits it.
      expect(config.fees.maxPayoutSlippageBps).toBeNull();
      expect(ROUTES.find((route) => route.route === "/v2/config")!.schema.safeParse(config).success).toBe(true);
    } finally {
      await pg.query("UPDATE v2_series SET mint_fee_ppm = 0, mint_fees_held = 0, mint_fees_accrued = 0 WHERE long_id = 2");
      await pg.query("UPDATE v2_market SET mint_fee_ppm = 0 WHERE underlying = $1", [MARKET]);
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
    const body = await response.json();
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
      data: "0x1234", selector: null, targetName: null, functionSignature: null,
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
        vault: earnVault, asset: USDG, adapter: null, skimBps: null, paused: false,
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
        id: `${REWARD_DISTRIBUTOR.toLowerCase()}-2958`, distributor: REWARD_DISTRIBUTOR.toLowerCase(),
        epoch: 2_958n, root: `0x${"a".repeat(64)}`, total: 25_000_000n,
        setAt: BigInt(state.now - 80), setBlock: 744n, setLogIndex: 1, setTx: TX,
      });
      await database.insert(schema.v2RewardsClaim).values({
        id: `${REWARD_DISTRIBUTOR.toLowerCase()}-2958-0`, distributor: REWARD_DISTRIBUTOR.toLowerCase(),
        epoch: 2_958n, leafIndex: 0n, account: BUYER, amount: 20_000_000n,
        ts: BigInt(state.now - 70), block: 745n, logIndex: 1, tx: TX,
      });
      await database.insert(schema.v2ContractFunding).values({
        id: "fixture-reward-funding", source: "RewardsDistributor", contract: REWARD_DISTRIBUTOR.toLowerCase(),
        from: BUYER, amount: 100_000_000n, ts: BigInt(state.now - 90),
        block: 743n, logIndex: 3, tx: TX,
      });
      await database.insert(schema.v2TreasuryExit).values({
        id: "fixture-reward-defunding", source: "rewardsDistributor",
        sourceAddress: REWARD_DISTRIBUTOR.toLowerCase(), eventKind: "defunded", assetKind: "erc20",
        asset: USDG, tokenId: null, recipient: WRITER, amount: 5_000_000n,
        ts: BigInt(state.now - 60), block: 746n, logIndex: 1, tx: TX2,
      });
      await database.insert(schema.v2HouseVault).values({
        vault, underlying, sharesToken: vault, factory: USDG,
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

  it("flags launch-set membership from the registry: a registered market outside the launch set is served launch:false (T-OP-099)", async () => {
    const database = state.db as ReturnType<typeof drizzle<typeof schema>>;
    const nvda = V2_REGISTRY.markets.find((market) => market.ticker === "NVDA")!;
    // A registry market that is NOT in the launch set, registered on chain anyway (what --wave wave1 would do).
    const offLaunch = V2_REGISTRY.markets.find((market) => !V2_REGISTRY.launchSet.markets.includes(market.ticker as never))!;
    expect(offLaunch).toBeDefined();
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
        min: { raw: "2000000", decimals: 6, formatted: "2" },
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
    await pg.query(`UPDATE v2_strategy SET order_id = 9, min_ask_bps = 30, max_ask_bps = 150,
      ask_bps = 150, last_repriced_at = $1, last_repriced_price = 3183100, reprice_count = 2`, [state.now - 30]);
    state.fair = { fair: 2_345_600n, spot: 212_210_000n, iv: 0.3, delta: 0.2,
      asOf: state.now - 60, source: "cboe" };
    try {
      clearCache();
      const strategies = await list(await app.request("http://localhost/v2/strategies?active=1"));
      expect(strategies.items[0]!.pricing).toEqual({
        currentAsk: { raw: "3183100", decimals: 6, formatted: "3.1831" },
        band: {
          min: { raw: "600000", decimals: 6, formatted: "0.6" },
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
        min: { raw: "2000000", decimals: 6, formatted: "2" },
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

  it("X8-312: absence and a measured zero are different in /v2/makers, and every item names its benchmark", async () => {
    // The defect this row exists to close: a maker that never quoted and a maker that quoted and
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
 * T-188. F-APP-INDEXER-05 (windows anchored to the indexed head) and F-APP-INDEXER-09 (one
 * checkpoint per activity page).
 *
 * WHY EVERY TEST HERE MOVES THE HEAD FIRST. `createTables` writes the checkpoint at `state.now` and
 * `beforeAll` pins the fake clock to the same `state.now`, so in the default fixture the indexed head
 * and the host clock are the SAME INSTANT. A wall-clock window and a head-anchored window then return
 * identical numbers, and an assertion written against that fixture passes whichever one the route
 * uses - it cannot see its own subject. Each test below separates the two before it measures.
 *
 * NOT ASSERTED HERE: an `asOf` field on the response. The v2 bodies are validated against the frozen
 * schema in ./schema.ts, which this task does not own (T-188 acceptance criterion 11) and which
 * T-425-X8-WINDOWED-FIGURES-CARRY-ASOF-IN-THE-JSON-CONTRACT owns. So the anchoring is proven and the
 * wire field is not: a consumer still cannot distinguish a quiet day from indexer lag until T-425
 * lands. That gap is deliberate and is recorded in DEFERRED-VERIFICATION.md.
 */
describe("T-188 indexed-head windows and snapshot reads", () => {
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
      // /v2/stats and /v2/markets must report ONE 24h volume (acceptance criterion 6a).
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
    let spy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      // Ponder commits the projection write and the checkpoint in ONE transaction. Reproduce that:
      // after the route's FIRST fill select returns, land a fill at a block the current safeBlock
      // already covers and move the checkpoint, exactly as an indexing commit would.
      // safeBlock is head.block - 3 = 102 here, and the checkpoint's BLOCK is left alone so
      // safeBlock does not move - the only thing that changes is the set of committed rows.
      let landed = false;
      spy = vi.spyOn(pg, "query").mockImplementation(async (...args: unknown[]) => {
        const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
        if (!landed && String(args[0]).toLowerCase().includes('from "v2_fill"')) {
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
      });
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
 * T-425. `asOf` in the JSON contract.
 *
 * T-188 anchored the trailing windows of /v2/markets and /v2/markets/:ticker/series to the indexed
 * head, but the head never reached the wire: the response cache replays body and status only, so the
 * header it first tried would have vanished on every cache HIT, and the frozen schema was owned by
 * another row at the time. Anchoring without publishing leaves a consumer unable to tell a genuine
 * quiet day from indexer lag -- the figures simply differ, with nothing on the response saying why.
 *
 * The same fixture rule as the T-188 block applies and matters more here: `createTables` writes the
 * checkpoint at `state.now` and the fake clock is pinned to the same `state.now`, so an `asOf` taken
 * from the host clock and one taken from the head are IDENTICAL in the stock fixture. A test that
 * does not move them apart first cannot fail, whichever source the route uses.
 */
describe("T-425 windowed figures carry asOf", () => {
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
      // every fill in the stock fixture is inside both the level and the lagged window. T-188's
      // `measures the 24h and 7d windows from the indexed head` plants a fill in the gap precisely
      // to create that delta and pins the arithmetic; this test pins the PUBLISHED anchor, which is
      // all T-425 changes. Asserting a difference here would encode a fixture accident as a rule.
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
      // same defect as two different 24h volumes, which is what T-188 criterion 6(a) forbids.
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
});
