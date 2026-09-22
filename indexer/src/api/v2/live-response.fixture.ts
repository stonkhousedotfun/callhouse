/**
 * Hand-derived live-response fixture for the deterministic PGlite scenario in routes.test.ts.
 *
 * Keep this file independent of the route mappers. The seed, frozen clock, mocked chain reads,
 * and protocol arithmetic are its inputs; no value here is captured from an API response.
 */

const NOW = 1_800_000_000;
// T-425's `asOf` is the indexed head's block time (head.ts `windowAsOf`), never the host clock. routes.test.ts
// seeds `_ponder_checkpoint` with `state.now` as the checkpoint timestamp (createTables, routes.test.ts:137), and
// `state.now` is NOW.
const INDEXED_HEAD_TS = NOW;

const MARKET = "0x0000000000000000000000000000000000000011";
const BUYER = "0x0000000000000000000000000000000000000022";
const WRITER = "0x0000000000000000000000000000000000000033";
const RECIPIENT = "0x0000000000000000000000000000000000000044";
const USDG = "0x0000000000000000000000000000000000000001";
const ACCESS_MANAGER = "0x0000000000000000000000000000000000006016";
const FEE_SPLITTER = "0x0000000000000000000000000000000000007001";
const FLYWHEEL_TOKEN = "0x0000000000000000000000000000000000007003";
const EARN_VAULT = "0x000000000000000000000000000000000000e011";
const REWARD_DISTRIBUTOR = "0x0000000000000000000000000000000000005015";
const MAKER_VAULT = "0x0000000000000000000000000000000000005016";
const HOUSE_VAULT = "0xc3c3c3c3c3c3c3c3c3C3C3c3C3C3C3c3C3C3c3c3";
const NVDA_STOCK = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

const TX = `0x${"1".repeat(64)}`;
const TX2 = `0x${"2".repeat(64)}`;
const TX3 = `0x${"3".repeat(64)}`;
const WIN_ID = `2-${BUYER}`;

function money(raw: string, decimals: number, formatted: string) {
  return { raw, decimals, formatted } as const;
}

function series(
  longId: string,
  shortId: string,
  strikeRaw: string,
  strikeFormatted: string,
  expiry: number,
  mintCutoff: number,
  status: "open" | "settled",
) {
  return {
    longId,
    shortId,
    ticker: "TEST",
    underlying: MARKET,
    isPut: false,
    strike: money(strikeRaw, 6, strikeFormatted),
    expiry,
    tenor: "daily",
    mintFeePpm: 0,
    mintFeesHeld: money("0", 18, "0"),
    mintFeesAccrued: money("0", 18, "0"),
    mintCutoff,
    status,
  } as const;
}

const SERIES_2 = series("2", "3", "210000000", "210", NOW + 86_400, NOW + 80_000, "open");
const SERIES_4 = series("4", "5", "220000000", "220", NOW + 86_400, NOW + 80_000, "open");
const SERIES_6 = series("6", "7", "210000000", "210", NOW - 86_400, NOW - 88_200, "settled");
const SERIES_8 = series("8", "9", "220000000", "220", NOW - 86_400, NOW - 88_200, "settled");

const EMPTY_QUOTE = {
  bestBid: null,
  bestAsk: null,
  bidUnits: "0",
  askUnits: "0",
  fair: null,
  iv: null,
  delta: null,
  last: null,
  fairProvenance: null,
} as const;

const SERIES_2_QUOTE = {
  ...EMPTY_QUOTE,
  bestAsk: money("3000000", 6, "3"),
  askUnits: "200",
  last: money("3000000", 6, "3"),
} as const;

const CARD_2 = {
  series: SERIES_2,
  spot: money("200000000", 6, "200"),
  ask: money("3000000", 6, "3"),
  target: money("215000000", 6, "215"),
  perUnit: {
    cost: money("33000", 6, "0.033"),
    payoutAtTarget: money("44999", 6, "0.044999"),
    multiple: 1.36,
  },
  perShare: {
    cost: money("3100000", 6, "3.1"),
    payoutAtTarget: money("4499900", 6, "4.4999"),
    multiple: 1.45,
  },
  maxLoss: "cost",
  unitsAvailable: "200",
  orderIds: ["1"],
} as const;

const WIN = {
  id: WIN_ID,
  holder: BUYER,
  ticker: "TEST",
  series: SERIES_2,
  cost: money("3100000", 6, "3.1"),
  payout: money("6200000", 6, "6.2"),
  multiple: 2,
  settledAt: NOW - 30,
  tx: TX,
} as const;

// The seed schedules this operation with `nonce: 943` (routes.test.ts:1040); `accessOperation` builds its row id
// as `${operationId}:${nonce}` (routes.test.ts:295).
const ADMIN_OPERATION_NONCE = 943;

const ADMIN_OPERATION = {
  // `operationId:nonce`, the indexer's own row key. Unique where `id` is not.
  key: `${TX3}:${ADMIN_OPERATION_NONCE}`,
  id: TX3,
  role: "ADMIN",
  target: ACCESS_MANAGER,
  selector: null,
  label: `unknown-target ${ACCESS_MANAGER} no-selector`,
  caller: BUYER,
  scheduledAt: NOW - 60,
  readyAt: NOW + 3_600,
} as const;

const HOUSE_NAV = {
  epoch: "7",
  at: NOW - 10,
  usdg: money("700", 6, "0.0007"),
  stockUnits: "2000000000000000000",
  settlementPrice: money("235000000", 6, "235"),
  navUsdg: money("9000", 6, "0.009"),
} as const;

const HOUSE_EPOCH = {
  id: "7",
  start: NOW - 600,
  end: NOW + 600,
  nav: HOUSE_NAV,
  resultUsdg: null,
} as const;

const HOUSE_BUYER_DEPOSIT = {
  kind: "deposit",
  account: BUYER,
  assets: "500",
  stockAmount: "0",
  shares: null,
  requestedAt: NOW - 200,
} as const;

const HOUSE_WRITER_DEPOSIT = {
  kind: "deposit",
  account: WRITER,
  assets: "0",
  stockAmount: "2000000000000000000",
  shares: null,
  requestedAt: NOW - 190,
} as const;

const MAKER_EPOCH = {
  id: 2_976,
  start: 1_799_884_800,
  end: 1_800_230_400,
  /**
   * The scoring policy the epoch's figures were produced under (X3-201). LITERALS, not the imported
   * MAKER_SCORING_POLICY, for the same reason the benchmark policy below is a literal: changing the band
   * must turn this wire sample RED so a human looks at it, rather than have the sample quietly relabel
   * itself to agree with whatever the producer now does.
   */
  band: { bps: 1_000, minUsdg: money("20000", 6, "0.02") },
} as const;

const MAKER_STATS = {
  /**
   * X8-312. Both fields are REQUIRED on a maker item now, and this fixture is compared to the live
   * response by deep equality (routes.test.ts), so these must match the seeded v2MakerEpoch row
   * exactly: benchmarkPolicy MAKER_BENCHMARK_POLICY, samples absent 4 / valid 6 / missingReference 2.
   *
   * The 2 is a LITERAL, not the imported constant, on purpose: bumping MAKER_BENCHMARK_POLICY must
   * turn this red so the wire sample is looked at rather than silently relabelled. That is the same
   * defect this row exists to close, one layer out.
   *
   * uptimePct 50 is the two-sided share of absent + valid (5 of 10); missingReference sits outside
   * that denominator, which is why 2 more samples do not move it.
   */
  benchmarkPolicy: 2,
  samples: { absent: 4, valid: 6, missingReference: 2 },
  uptimePct: 50,
  avgSpreadBps: 100,
  depthWithin100bps: "100",
  /** The band statistic. Wider band, so never below the 100 bps figure beside it. */
  depthInBand: "180",
  fills: 1,
  volume: money("3000000", 6, "3"),
  rebates: money("50000", 6, "0.05"),
  score: 75,
  selfTradeUnits: "7",
  selfTradeCoverage: {
    status: "detected",
    unseenUnits: "0",
    reasons: [],
  },
} as const;

const FLYWHEEL_STOCK_DISTRIBUTION = {
  id: "fixture-distribution-stock",
  asset: NVDA_STOCK,
  symbol: "NVDA",
  decimals: 18,
  assetInRaw: "40",
  usdgInRaw: "80",
  treasuryOutRaw: "40",
  buybackAddedRaw: "40",
  ts: NOW - 100,
  tx: TX3,
} as const;

const FLYWHEEL_USDG_DISTRIBUTION = {
  id: "fixture-distribution-usdg",
  asset: USDG,
  symbol: "USDG",
  decimals: 6,
  assetInRaw: "50",
  usdgInRaw: "50",
  treasuryOutRaw: "25",
  buybackAddedRaw: "25",
  ts: NOW - 200,
  tx: TX2,
} as const;

function calendarDay(dayIndex: number, isHoliday: boolean, isSessionDay: boolean) {
  return { dayIndex, isHoliday, isSessionDay } as const;
}

export type LiveResponseFixtureEntry = {
  request: string;
  response: unknown;
};

/** One concrete request and complete expected response for every frozen v2 route template. */
export const LIVE_RESPONSE_FIXTURES = {
  "/v2/health": {
    request: "/v2/health",
    response: {
      status: "ok",
      block: "105",
      lagSeconds: 0,
      interfaceVersion: 8,
    },
  },

  "/v2/services": {
    request: "/v2/services",
    // The scenario never sets PRICER_READY_URL, so services.ts answers not_configured without a
    // fetch, and checkedAt is the frozen clock routes.test.ts pins with vi.setSystemTime.
    response: {
      pricer: {
        healthy: false,
        reason: "not_configured",
        reasons: [],
        checkedAt: NOW,
        lastEvaluationAt: null,
      },
    },
  },

  "/v2/config": {
    request: "/v2/config",
    response: {
      chainId: 4_663,
      interfaceVersion: 8,
      deployBlock: "100",
      usdg: { address: USDG, symbol: "USDG", decimals: 6 },
      contracts: {
        clearinghouse: "0x000000000000000000000000000000000000c011",
        orderBook: "0x000000000000000000000000000000000000c012",
        settlementOracle: "0x000000000000000000000000000000000000C013",
        expiryCalendar: null,
        keeperRewards: null,
        autoRoller: "0x000000000000000000000000000000000000c014",
        payoutAdapter: null,
        makerVault: null,
        makerRegistry: "0x000000000000000000000000000000000000c015",
        rewardsDistributor: null,
        accessManager: ACCESS_MANAGER,
        sources: { chainlink: null, univ3: null, dataStreams: null },
      },
      flywheel: {
        feeSplitter: FEE_SPLITTER,
        buybackExecutor: "0x0000000000000000000000000000000000007002",
      },
      safes: { admin: null, treasury: null },
      access: {
        manager: ACCESS_MANAGER,
        roles: [{
          id: 3,
          name: "CONFIG_ADMIN",
          delayS: 123,
          holders: [{ address: BUYER, delayS: 456 }],
        }],
      },
      pendingOperations: [ADMIN_OPERATION],
      fees: {
        premiumFeeBps: 500,
        resaleFeeBps: 0,
        takerFeeFlat: money("100000", 6, "0.1"),
        takerFeeCapBps: 1_000,
        makerRebateBps: 5_000,
        exerciseFeeBps: 37,
        mintFeePpm: 91,
        maxPayoutSlippageBps: null,
      },
      pendingFees: null,
      constants: {
        unit: "10000000000000000",
        unitsPerShare: 100,
        priceTick: 100,
        settlementWindow: 1_800,
        finalizeDelay: 120,
        snapshotGrace: 600,
        resolveDelay: 172_800,
        maxTenor: 3_888_000,
        minSeriesLead: 3_600,
        mintFeePeriod: 604_800,
        mintFeeCeilPpm: 5_000,
        feeChangeDelay: 172_800,
      },
      ladder: {
        weekly: { rungs: 5, firstOtmBps: 200, stepBps: 200, cardTargetBps: 400 },
        daily: { rungs: 5, firstOtmBps: 100, stepBps: 100, cardTargetBps: 200 },
      },
    },
  },

  "/v2/admin/operations": {
    request: "/v2/admin/operations",
    response: {
      items: [{ ...ADMIN_OPERATION, status: "pending" }],
      nextCursor: null,
    },
  },

  "/v2/flywheel": {
    request: "/v2/flywheel",
    response: {
      configured: true,
      splitter: FEE_SPLITTER,
      tokenAddress: FLYWHEEL_TOKEN,
      tokenDecimals: 18,
      burnedTotal: "25",
      burned7d: "25",
      revenue7d: [
        { asset: USDG, symbol: "USDG", decimals: 6, amountRaw: "50" },
        { asset: NVDA_STOCK, symbol: "NVDA", decimals: 18, amountRaw: "40" },
      ],
      held: [{ asset: NVDA_STOCK, symbol: "NVDA", decimals: 18, amountRaw: "60" }],
      lastDistribution: FLYWHEEL_STOCK_DISTRIBUTION,
      distributions: [FLYWHEEL_STOCK_DISTRIBUTION, FLYWHEEL_USDG_DISTRIBUTION],
    },
  },

  "/v2/earn": {
    request: `/v2/earn?address=${BUYER}`,
    response: {
      configured: true,
      vaults: [{
        vault: EARN_VAULT,
        asset: USDG,
        adapter: null,
        paused: false,
        sharesSupply: "100",
        deposited: "1000",
        skimmed: null,
        queue: { depth: 1, oldestRequestedAt: NOW - 30 },
        lastAdapterMove: {
          adapter: null,
          direction: "pull",
          requested: "50",
          delivered: "40",
          ts: NOW - 20,
          tx: TX3,
        },
        // T-OP-086: the scenario mocks `ponder:api` with no public client, so the live mark is NOT READ and
        // the route says so with null on all three (never "0", which would be an observed zero).
        indicativeAssetsPerShare: null,
        indicativeTotalAssets: null,
        hasOpenPosition: null,
      }],
      account: {
        address: BUYER,
        shares: null,
        queued: [{
          id: `${EARN_VAULT}-fixture-7`,
          status: "queued",
          sharesQueued: "100",
          assetsRequested: null,
          fulfilledAssets: "60",
          requestedAt: NOW - 30,
        }],
      },
    },
  },

  "/v2/markets": {
    request: "/v2/markets",
    response: [{
      ticker: "TEST",
      name: "TEST",
      underlying: MARKET,
      status: "live",
      // T-OP-099. TEST is not a registry ticker, so it is not in the launch set: the wire says so.
      launch: false,
      spot: money("200000000", 6, "200"),
      spotUpdatedAt: NOW,
      strikeTick: money("1000000", 6, "1"),
      mintFeePpm: 0,
      puts: false,
      expiries: [NOW + 86_400],
      stats: {
        volume24h: money("3600000", 6, "3.6"),
        premium7d: money("3600000", 6, "3.6"),
        asOf: INDEXED_HEAD_TS,
        openInterestUnits: "100",
        seriesOpen: 1,
      },
    }],
  },

  "/v2/calendar/holidays": {
    request: "/v2/calendar/holidays",
    response: {
      items: [
        calendarDay(20_833, false, true),
        calendarDay(20_834, true, false),
        calendarDay(20_835, false, false),
        calendarDay(20_836, false, true),
        calendarDay(20_837, false, true),
        calendarDay(20_838, false, true),
        calendarDay(20_839, false, true),
        calendarDay(20_840, false, true),
        calendarDay(20_841, false, false),
        calendarDay(20_842, false, false),
        calendarDay(20_843, false, true),
        calendarDay(20_844, false, true),
        calendarDay(20_845, false, true),
        calendarDay(20_846, false, true),
        calendarDay(20_847, false, true),
        calendarDay(20_848, false, false),
        calendarDay(20_849, false, false),
        calendarDay(20_850, false, true),
        calendarDay(20_851, false, true),
        calendarDay(20_852, false, true),
        calendarDay(20_853, false, true),
        calendarDay(20_854, false, true),
        calendarDay(20_855, false, false),
        calendarDay(20_856, false, false),
        calendarDay(20_857, false, true),
        calendarDay(20_858, false, true),
        calendarDay(20_859, false, true),
        calendarDay(20_860, false, true),
        calendarDay(20_861, false, true),
        calendarDay(20_862, false, false),
        calendarDay(20_863, false, false),
      ],
    },
  },

  "/v2/markets/:ticker/series": {
    request: "/v2/markets/TEST/series",
    response: {
      items: [
        { series: SERIES_6, quote: EMPTY_QUOTE, openInterestUnits: "100", volume24h: money("0", 6, "0") },
        { series: SERIES_8, quote: EMPTY_QUOTE, openInterestUnits: "100", volume24h: money("0", 6, "0") },
        { series: SERIES_2, quote: SERIES_2_QUOTE, openInterestUnits: "100", volume24h: money("3600000", 6, "3.6") },
        { series: SERIES_4, quote: EMPTY_QUOTE, openInterestUnits: "100", volume24h: money("0", 6, "0") },
      ],
      asOf: INDEXED_HEAD_TS,
      nextCursor: null,
    },
  },

  "/v2/series/:longId": {
    request: "/v2/series/2",
    response: {
      series: SERIES_2,
      quote: SERIES_2_QUOTE,
      openInterestUnits: "100",
      volume: money("3000000", 6, "3"),
      settlement: {
        status: "Finalized",
        price: money("250000000", 6, "250"),
        longPayoutPerUnit: money("1596000000000000", 18, "0.001596"),
        feePerUnit: money("4000000000000", 18, "0.000004"),
        shortPayoutPerUnit: money("8400000000000000", 18, "0.0084"),
        finalizedAt: NOW - 40,
        settledAt: null,
        sourceIndex: 0,
        corroborated: true,
        candidate: null,
      },
      exerciseFeeBps: 25,
    },
  },

  "/v2/series/:longId/book": {
    request: "/v2/series/2/book",
    response: {
      bids: [],
      asks: [{
        price: money("3000000", 6, "3"),
        units: "200",
        orders: [{
          orderId: "1",
          maker: WRITER,
          units: "200",
          onChainRemainingUnits: "200",
          makerFreeUnits: "200",
          makerFreeCollateral: money("2000000000000000000", 18, "2"),
          kind: "AskWrite",
          validUntil: NOW + 3_600,
        }],
      }],
      updatedBlock: "105",
      snapshotTimestamp: NOW,
    },
  },

  "/v2/series/:longId/holders": {
    request: "/v2/series/2/holders",
    response: {
      items: [{ holder: BUYER, units: "100" }],
      nextCursor: null,
    },
  },

  "/v2/series/:longId/trades": {
    request: "/v2/series/2/trades",
    response: {
      items: [
        {
          id: "fill-unsafe",
          ts: NOW - 10,
          price: money("3000000", 6, "3"),
          units: "10",
          premium: money("300000", 6, "0.3"),
          takerIsBuyer: true,
          primary: true,
          taker: BUYER,
          maker: WRITER,
          tx: TX3,
        },
        {
          id: "fill-2",
          ts: NOW - 50,
          price: money("3000000", 6, "3"),
          units: "10",
          premium: money("300000", 6, "0.3"),
          takerIsBuyer: true,
          primary: true,
          taker: BUYER,
          maker: WRITER,
          tx: TX2,
        },
        {
          id: "fill-1",
          ts: NOW - 60,
          price: money("3000000", 6, "3"),
          units: "100",
          premium: money("3000000", 6, "3"),
          takerIsBuyer: true,
          primary: true,
          taker: BUYER,
          maker: WRITER,
          tx: TX,
        },
      ],
      nextCursor: null,
    },
  },

  "/v2/cards": {
    request: "/v2/cards",
    response: {
      items: [CARD_2],
      nextCursor: null,
      generatedAt: NOW,
    },
  },

  "/v2/cards/hero": {
    request: "/v2/cards/hero",
    response: { card: CARD_2, maxMultiple: 1.36 },
  },

  "/v2/accounts/:address/positions": {
    request: `/v2/accounts/${BUYER}/positions`,
    response: {
      longs: [{
        series: SERIES_2,
        units: "110",
        avgCost: money("3100000", 6, "3.1"),
        mark: null,
        markSource: null,
        unrealised: null,
        claimable: null,
      }],
      shorts: [],
      orders: [{
        orderId: "2",
        series: SERIES_2,
        kind: "AskResale",
        price: money("3000000", 6, "3"),
        units: "10",
        filled: "0",
        validUntil: NOW - 10,
      }],
      ledger: [],
      strategies: [],
      prefs: { inKind: false, toLedger: false },
    },
  },

  "/v2/accounts/:address/history": {
    request: `/v2/accounts/${BUYER}/history`,
    response: {
      items: [
        {
          id: "fill-unsafe",
          kind: "fill",
          ts: NOW - 10,
          longId: "2",
          series: SERIES_2,
          data: {
            orderId: "1",
            side: "buy",
            role: "taker",
            counterparty: WRITER,
            units: "10",
            price: money("3000000", 6, "3"),
            premium: money("300000", 6, "0.3"),
            fee: money("10000", 6, "0.01"),
            rebate: money("0", 6, "0"),
            primary: true,
            realisedPnl: null,
            tx: TX3,
          },
        },
        {
          id: "redeem-1",
          kind: "redemption",
          ts: NOW - 10,
          longId: "6",
          series: SERIES_6,
          data: {
            side: "long",
            tokenId: "6",
            units: "10",
            asset: USDG,
            amount: money("1596000", 6, "1.596"),
            amountInKind: money("15960000000000000", 18, "0.01596"),
            toLedger: false,
            realisedPnl: money("900000", 6, "0.9"),
            tx: TX,
          },
        },
        {
          id: "fill-2",
          kind: "fill",
          ts: NOW - 50,
          longId: "2",
          series: SERIES_2,
          data: {
            orderId: "1",
            side: "buy",
            role: "taker",
            counterparty: WRITER,
            units: "10",
            price: money("3000000", 6, "3"),
            premium: money("300000", 6, "0.3"),
            fee: money("10000", 6, "0.01"),
            rebate: money("0", 6, "0"),
            primary: true,
            realisedPnl: null,
            tx: TX2,
          },
        },
        {
          id: "fill-1",
          kind: "fill",
          ts: NOW - 60,
          longId: "2",
          series: SERIES_2,
          data: {
            orderId: "1",
            side: "buy",
            role: "taker",
            counterparty: WRITER,
            units: "100",
            price: money("3000000", 6, "3"),
            premium: money("3000000", 6, "3"),
            fee: money("100000", 6, "0.1"),
            rebate: money("0", 6, "0"),
            primary: true,
            realisedPnl: null,
            tx: TX,
          },
        },
        {
          id: "cash-1",
          kind: "deposit",
          ts: NOW - 100,
          longId: null,
          series: null,
          data: {
            asset: USDG,
            symbol: "USDG",
            amount: money("10000000", 6, "10"),
            from: WRITER,
            tx: TX,
          },
        },
      ],
      nextCursor: null,
    },
  },

  "/v2/feed/wins": {
    request: "/v2/feed/wins",
    response: { items: [WIN], nextCursor: null },
  },

  "/v2/feed/activity": {
    request: "/v2/feed/activity?since=0",
    response: {
      items: [
        {
          id: "fill-1",
          kind: "fill",
          ts: NOW - 60,
          longId: "2",
          series: SERIES_2,
          accounts: [BUYER, WRITER],
          data: {
            orderId: "1",
            taker: BUYER,
            maker: WRITER,
            recipient: BUYER,
            units: "100",
            price: money("3000000", 6, "3"),
            premium: money("3000000", 6, "3"),
            takerFee: money("100000", 6, "0.1"),
            sellerFee: money("150000", 6, "0.15"),
            makerRebate: money("50000", 6, "0.05"),
            primary: true,
            takerIsBuyer: true,
            tx: TX,
          },
        },
        {
          id: "fill-2",
          kind: "fill",
          ts: NOW - 50,
          longId: "2",
          series: SERIES_2,
          accounts: [BUYER, WRITER, RECIPIENT],
          data: {
            orderId: "1",
            taker: BUYER,
            maker: WRITER,
            recipient: RECIPIENT,
            units: "10",
            price: money("3000000", 6, "3"),
            premium: money("300000", 6, "0.3"),
            takerFee: money("10000", 6, "0.01"),
            sellerFee: money("15000", 6, "0.015"),
            makerRebate: money("5000", 6, "0.005"),
            primary: true,
            takerIsBuyer: true,
            tx: TX2,
          },
        },
        {
          id: `${TX}-3-6`,
          kind: "settlement",
          ts: NOW - 30,
          longId: "6",
          series: SERIES_6,
          accounts: [],
          data: {
            price: money("250000000", 6, "250"),
            longPayoutPerUnit: money("1596000000000000", 18, "0.001596"),
            feePerUnit: money("4000000000000", 18, "0.000004"),
            shortPayoutPerUnit: money("8400000000000000", 18, "0.0084"),
            tx: TX,
          },
        },
        {
          id: `${TX}-2-8`,
          kind: "settlement",
          ts: NOW - 20,
          longId: "8",
          series: SERIES_8,
          accounts: [],
          data: {
            price: money("250000000", 6, "250"),
            longPayoutPerUnit: money("1197000000000000", 18, "0.001197"),
            feePerUnit: money("3000000000000", 18, "0.000003"),
            shortPayoutPerUnit: money("8800000000000000", 18, "0.0088"),
            tx: TX,
          },
        },
        {
          id: "redeem-1",
          kind: "redemption",
          ts: NOW - 10,
          longId: "6",
          series: SERIES_6,
          accounts: [BUYER],
          data: {
            holder: BUYER,
            side: "long",
            tokenId: "6",
            units: "10",
            asset: USDG,
            amount: money("1596000", 6, "1.596"),
            amountInKind: money("15960000000000000", 18, "0.01596"),
            settlementPrice: money("250000000", 6, "250"),
            toLedger: false,
            tx: TX,
          },
        },
      ],
      nextCursor: null,
    },
  },

  "/v2/strategies": {
    request: "/v2/strategies?active=1",
    response: {
      items: [{
        writer: WRITER,
        underlying: MARKET,
        ticker: "TEST",
        strategy: {
          active: true,
          weekly: true,
          smartPricing: true,
          otmBps: 200,
          askBps: 300,
          minAskBps: 100,
          maxAskBps: 500,
          maxUnits: "100",
        },
        currentLongId: "2",
        orderId: "1",
        expiry: NOW + 86_400,
        lastRolledAt: NOW - 120,
        lastStaleCancelAt: null,
        staleSpot: null,
        pricing: {
          currentAsk: money("3000000", 6, "3"),
          band: {
            min: money("2000000", 6, "2"),
            max: money("10000000", 6, "10"),
          },
          lastRepricedAt: null,
          lastRepricedPrice: null,
          repriceCount: 0,
          fair: null,
        },
      }],
      nextCursor: null,
    },
  },

  "/v2/leaderboard": {
    request: "/v2/leaderboard",
    response: {
      metric: "multiple",
      window: "week",
      items: [{ rank: 1, holder: BUYER, value: 2, wins: 1, losses: 0, best: WIN }],
      nextCursor: null,
    },
  },

  "/v2/pnl/:id": {
    request: `/v2/pnl/${WIN_ID}`,
    response: {
      ...WIN,
      units: "100",
      entryPrice: money("3000000", 6, "3"),
      settlementPrice: money("250000000", 6, "250"),
      spotAtEntry: money("200000000", 6, "200"),
    },
  },

  "/v2/stats": {
    request: "/v2/stats",
    response: {
      asOf: INDEXED_HEAD_TS,
      volume24h: money("3600000", 6, "3.6"),
      volumeAll: money("3000000", 6, "3"),
      premiumAll: money("3000000", 6, "3"),
      feesAll: money("100000", 6, "0.1"),
      contractsFilled: "100",
      holders: 1,
      selfTradeUnits: "7",
      selfTradeCoverage: { status: "detected", unseenUnits: "0", reasons: [] },
      biggestWinDay: WIN,
      biggestWinWeek: WIN,
    },
  },

  "/v2/makers": {
    request: "/v2/makers",
    response: {
      epoch: MAKER_EPOCH,
      items: [{ maker: WRITER, tierBps: 50, ...MAKER_STATS }],
      nextCursor: null,
    },
  },

  "/v2/makers/:address": {
    request: `/v2/makers/${WRITER}`,
    response: {
      maker: WRITER,
      tierBps: 50,
      epochs: [{ epoch: MAKER_EPOCH, ...MAKER_STATS }],
    },
  },

  "/v2/rewards/epochs": {
    request: "/v2/rewards/epochs?program=maker",
    response: {
      program: "maker",
      distributors: [{
        distributor: REWARD_DISTRIBUTOR,
        funded: money("100000000", 6, "100"),
        defunded: money("5000000", 6, "5"),
        balance: money("75000000", 6, "75"),
      }],
      items: [{
        distributor: REWARD_DISTRIBUTOR,
        epochId: 2958,
        root: `0x${"a".repeat(64)}`,
        total: money("25000000", 6, "25"),
        claimed: money("20000000", 6, "20"),
      }],
      nextCursor: null,
    },
  },

  "/v2/rewards/:address/claims": {
    request: `/v2/rewards/${BUYER}/claims`,
    response: {
      address: BUYER,
      items: [{
        program: "maker",
        distributor: REWARD_DISTRIBUTOR,
        epochId: 2958,
        index: 0,
        amount: money("20000000", 6, "20"),
        claimed: true,
        tx: TX,
      }],
      nextCursor: null,
    },
  },

  "/v2/vault": {
    request: "/v2/vault",
    response: {
      vault: MAKER_VAULT,
      protocol: true,
      balances: {
        wallet: [
          { asset: NVDA_STOCK, symbol: "NVDA", free: money("2000000000000000000", 18, "2") },
          { asset: USDG, symbol: "USDG", free: money("12000000", 6, "12") },
        ],
        ledger: [
          { asset: NVDA_STOCK, symbol: "NVDA", free: money("1000000000000000000", 18, "1") },
          { asset: USDG, symbol: "USDG", free: money("3000000", 6, "3") },
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
      outflow: {
        used: money("500000000", 6, "500"),
        cap: money("2500000000", 6, "2500"),
      },
      liveOrderCount: 3,
      trackedSeries: ["2", "4"],
    },
  },

  "/v2/fair/:longId": {
    request: "/v2/fair/2",
    response: { fair: null, reason: "Pricing service is unavailable." },
  },

  "/v2/house": {
    request: "/v2/house",
    response: {
      items: [{
        market: "AAPL",
        vault: HOUSE_VAULT,
        currentEpoch: HOUSE_EPOCH,
        sharesSupply: "1000",
      }],
      nextCursor: null,
    },
  },

  "/v2/house/:market": {
    request: `/v2/house/AAPL?address=${BUYER}`,
    response: {
      market: "AAPL",
      vault: HOUSE_VAULT,
      currentEpoch: HOUSE_EPOCH,
      epochs: [HOUSE_EPOCH],
      shares: {
        address: BUYER,
        shares: "250",
        queued: [HOUSE_BUYER_DEPOSIT],
      },
      queue: [HOUSE_BUYER_DEPOSIT, HOUSE_WRITER_DEPOSIT],
    },
  },
} as const satisfies Record<string, LiveResponseFixtureEntry>;
