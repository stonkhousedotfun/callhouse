/**
 * TypeScript types for every indexer API v2 response (indexer/src/api/v2/).
 *
 * Hand-written on purpose: a page should import `Card`, not `z.infer<typeof cardSchema>`, and a
 * reader should be able to read the contract here without knowing zod. The cost of writing the
 * shapes twice is paid back by the block at the bottom: every type is asserted EQUAL to the
 * `z.infer` of its schema in ./api-schema, in both directions, at compile time. A field added,
 * removed, renamed or made nullable on one side and not the other fails `pnpm typecheck`, so the
 * types a page compiles against are exactly what the strict schema accepts on the wire.
 *
 * Units, as everywhere in v2: Money.raw is a base-unit integer string (USDG 6 dp, Stock Tokens
 * 18 dp); every price is USDG per WHOLE share; every `units` is 0.01-share units; timestamps are
 * unix seconds; ids and block numbers are decimal strings; addresses are checksummed.
 * The per-field meaning lives on the schemas and in ops/fixtures/api/v2/README.md.
 */
import type { z } from "zod";

import type {
  activityItemSchema,
  activityResponseSchema,
  adminOperationSchema,
  adminOperationsResponseSchema,
  calendarHolidaysResponseSchema,
  bookOrderSchema,
  bookResponseSchema,
  cardSchema,
  cardsResponseSchema,
  configResponseSchema,
  errorSchema,
  fairResponseSchema,
  pricerServiceSchema,
  servicesResponseSchema,
  flywheelAssetSchema,
  flywheelDistributionSchema,
  flywheelResponseSchema,
  earnAccountSchema,
  earnAdapterMoveSchema,
  earnQueuedRequestSchema,
  earnQueueSchema,
  earnResponseSchema,
  earnVaultSchema,
  houseEpochSchema,
  houseListResponseSchema,
  houseMarketResponseSchema,
  houseNavSchema,
  houseQueueItemSchema,
  houseSharesSchema,
  houseVaultSchema,
  healthResponseSchema,
  heroCardResponseSchema,
  historyItemSchema,
  historyResponseSchema,
  holdersResponseSchema,
  leaderboardResponseSchema,
  levelSchema,
  makerEpochSchema,
  makerResponseSchema,
  makersResponseSchema,
  rewardClaimSchema,
  rewardClaimsResponseSchema,
  rewardEpochSchema,
  rewardEpochsResponseSchema,
  vaultResponseSchema,
  marketSchema,
  marketSeriesResponseSchema,
  marketsResponseSchema,
  moneySchema,
  orderKindSchema,
  pnlResponseSchema,
  positionsResponseSchema,
  pricingProvenanceSchema,
  quoteSchema,
  seriesDetailResponseSchema,
  seriesRefSchema,
  seriesStatusSchema,
  settlementCandidateSchema,
  settlementSchema,
  signedMoneySchema,
  statsResponseSchema,
  strategiesResponseSchema,
  strategySchema,
  tradeSchema,
  tradesResponseSchema,
  winSchema,
  winsResponseSchema,
} from "./api-schema";

// ---------------------------------------------------------------------------------------------
// Shared objects
// ---------------------------------------------------------------------------------------------

export type Money = { raw: string; decimals: number; formatted: string };

/** A USDG-denominated price: six base-unit decimals per whole share. */
export type UsdgPrice = { raw: string; decimals: 6; formatted: string };

/** Money whose raw may carry a leading "-" (PnL only). */
export type SignedMoney = { raw: string; decimals: number; formatted: string };

export type PricingProvenance = {
  contract: "O3-307/1";
  provider: string;
  providerProduct: string | null;
  method: "listed" | "interpolated" | "extrapolated" | "modeled" | "external-indicative";
  methodDetail: string | null;
  contributingExpiries: number[];
  identity: {
    market: string;
    issuer: string | null;
    token: { chainId: number; address: string; uiMultiplier: string | null };
    option: {
      side: "call" | "put";
      strike: Money;
      expiry: number;
      timeZone: "America/New_York";
      exercise: "european";
      payoff: "cash-value";
      settlement: "oracle-twap";
    };
    listed: {
      providerInstrumentId: string | null;
      root: string | null;
      side: "call" | "put";
      strike: string;
      expiry: number | null;
      multiplier: number | null;
      exercise: string | null;
      settlement: string | null;
    }[];
  };
  observations: {
    listedQuotes: {
      providerInstrumentId: string | null;
      bid: string | null;
      ask: string | null;
      bidSize: string | null;
      askSize: string | null;
      currency: string;
      observedAt: number | null;
    }[];
    vendorTheoretical: {
      product: string;
      value: string | null;
      iv: number | null;
      currency: string;
      observedAt: number | null;
    }[];
  };
  clocks: {
    quoteObservedAt: number | null;
    tradeObservedAt: number | null;
    underlyingObservedAt: number | null;
    volatilityObservedAt: number | null;
    publishedAt: number | null;
    receivedAt: number;
    computedAt: number;
  };
  ages: { quoteS: number | null; tradeS: number | null; underlyingS: number | null; volatilityS: number | null };
  entitlement: {
    class: "real-time" | "delayed" | "end-of-day" | "indicative" | "unknown";
    declaredDelayS: number | null;
    rightsRef: string | null;
  };
  expiryClock: {
    expiry: number;
    timeZone: "America/New_York";
    basis: "trading-time" | "calendar-time";
    yearsToExpiry: number | null;
  };
  quality: {
    readiness: "ready" | "degraded" | "unavailable";
    reasons: string[];
    uncertainty: { ivLow: number | null; ivHigh: number | null; fairLow: Money | null; fairHigh: Money | null } | null;
    disagreement: { provider: string; fairBps: number | null } | null;
    fallback: { from: string; to: string; reason: string } | null;
  };
  pricedSpot: Money | null;
};

export type SeriesStatus = "open" | "cutoff" | "expired" | "settling" | "held" | "settled";

export type SeriesRef = {
  longId: string;
  shortId: string;
  ticker: string;
  underlying: string;
  isPut: boolean;
  strike: Money;
  expiry: number;
  tenor: "daily" | "weekly" | "special";
  mintCutoff: number;
  mintFeePpm: number;
  mintFeesHeld: Money;
  mintFeesAccrued: Money;
  status: SeriesStatus;
};

export type Quote = {
  bestBid: Money | null;
  bestAsk: Money | null;
  bidUnits: string;
  askUnits: string;
  fair: Money | null;
  iv: number | null;
  delta: number | null;
  last: Money | null;
  fairProvenance?: PricingProvenance | null;
};

export type Card = {
  series: SeriesRef;
  spot: Money | null;
  ask: Money;
  target: Money;
  perUnit: { cost: Money; payoutAtTarget: Money; multiple: number };
  /** A 100-unit ticket across the ask side with one taker fee; null under 100 ask units. */
  perShare: { cost: Money; payoutAtTarget: Money; multiple: number } | null;
  maxLoss: "cost";
  unitsAvailable: string;
  orderIds: string[];
};

export type OrderKind = "Bid" | "AskResale" | "AskWrite";

export type BookOrder = { orderId: string; maker: string; units: string; onChainRemainingUnits: string;
  makerFreeUnits: string | null; makerFreeCollateral: Money | null; kind: OrderKind; validUntil: number };

export type Level = { price: Money; units: string; orders: BookOrder[] };

export type Win = {
  id: string;
  holder: string;
  ticker: string;
  series: SeriesRef;
  cost: Money;
  payout: Money;
  multiple: number;
  settledAt: number;
  tx: string;
};

export type ApiError = { error: { code: string; message: string } };

export type PendingAdminOperation = {
  /** `operationId:nonce`. Unique per row; `id` alone is not. See api-schema `adminOperationSchema`. */
  key: string;
  id: string;
  role: string;
  target: string;
  selector: string | null;
  label: string;
  caller: string;
  scheduledAt: number;
  readyAt: number;
};

export type AdminOperation = PendingAdminOperation & {
  status: "pending" | "executed" | "canceled";
};

export type AdminOperationsResponse = { items: AdminOperation[]; nextCursor: string | null };

export type FlywheelAsset = {
  asset: string;
  symbol: string | null;
  decimals: number | null;
  amountRaw: string;
};

export type FlywheelDistribution = {
  id: string;
  asset: string;
  symbol: string | null;
  decimals: number | null;
  assetInRaw: string;
  usdgInRaw: string;
  treasuryOutRaw: string;
  buybackAddedRaw: string;
  ts: number;
  tx: string;
};

export type FlywheelResponse = {
  configured: boolean;
  splitter: string | null;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  burnedTotal: string | null;
  burned7d: string | null;
  revenue7d: FlywheelAsset[];
  held: FlywheelAsset[];
  lastDistribution: FlywheelDistribution | null;
  distributions: FlywheelDistribution[];
};

export type EarnQueuedRequest = {
  id: string;
  status: "queued" | "fulfilled" | "cancelled";
  sharesQueued: string;
  assetsRequested: string | null;
  fulfilledAssets: string | null;
  requestedAt: number;
};

export type EarnAccount = {
  address: string;
  shares: string | null;
  queued?: EarnQueuedRequest[];
};

export type EarnAdapterMove = {
  adapter: string | null;
  direction: "pull" | "push" | null;
  requested: string;
  delivered: string | null;
  ts: number;
  tx: string;
};

export type EarnQueue = {
  depth: number;
  oldestRequestedAt: number | null;
};

export type EarnVault = {
  vault: string;
  asset: string | null;
  adapter: string | null;
  paused: boolean | null;
  sharesSupply: string | null;
  deposited: string | null;
  skimmed: string | null;
  queue?: EarnQueue;
  lastAdapterMove?: EarnAdapterMove | null;
  /** T-OP-086: display-only mark per 1e18 shares; null when not read. */
  indicativeAssetsPerShare?: string | null;
  indicativeTotalAssets?: string | null;
  hasOpenPosition?: boolean | null;
};

export type EarnResponse = {
  configured: boolean;
  vaults?: EarnVault[];
  account?: EarnAccount | null;
};

export type HouseNav = {
  epoch: string;
  at: number;
  /** Null: EpochRolled does not name the leg (`v2HouseNav.usdg`). Never 0. */
  usdg: Money | null;
  /** Null for the same reason (`v2HouseNav.stockUnits`). Never 0. */
  stockUnits: string | null;
  settlementPrice: Money;
  navUsdg: Money;
};

export type HouseEpoch = {
  id: string;
  /** Null until observed (`v2HouseEpoch.start` / `.end`). Never coerced to 0. */
  start: number | null;
  end: number | null;
  nav: HouseNav | null;
  resultUsdg: SignedMoney | null;
};

export type HouseQueueItem = {
  kind: "deposit" | "withdraw";
  account: string;
  assets: string | null;
  stockAmount?: string | null;
  shares: string | null;
  requestedAt: number;
};

export type HouseShares = {
  address: string;
  shares: string | null;
  queued?: HouseQueueItem[];
};

export type HouseVault = {
  market: string;
  vault: string | null;
  /** Null: no epoch row observed. The vault is still listed. */
  currentEpoch: HouseEpoch | null;
  sharesSupply: string | null;
};

export type HouseListResponse = {
  items: HouseVault[];
  nextCursor: string | null;
};

/** Alias the AC names `HouseResponse`; the wire schema is `houseListResponseSchema`. */
export type HouseResponse = HouseListResponse;

export type HouseMarketResponse = {
  market: string;
  vault: string | null;
  /** Null: no epoch row observed. */
  currentEpoch: HouseEpoch | null;
  epochs: HouseEpoch[];
  shares?: HouseShares | null;
  queue?: HouseQueueItem[];
};

// ---------------------------------------------------------------------------------------------
// /v2/health, /v2/config, /v2/markets
// ---------------------------------------------------------------------------------------------

/**
 * /v2/services — readiness of the services the indexer does not run (T-424).
 *
 * `healthy` is true only when `reason` is `"ready"`, so a consumer can branch on `healthy` alone
 * and still be fail-closed, and read `reason` only to say why. `reasons` is the pricer's own closed
 * set, passed through untouched. Times are unix seconds; the pricer emits ISO on its own endpoint
 * and the indexer converts at the boundary.
 */
export type PricerService = {
  healthy: boolean;
  reason: "ready" | "not_configured" | "timeout" | "http_error" | "malformed_body" | "not_ready" | "stale";
  reasons: ("loop-wedged" | "no-completed-tick" | "tick-failed" | "role-unread"
    | "role-refused" | "role-delayed" | "fair-stale" | "state-unknown")[];
  checkedAt: number;
  lastEvaluationAt: number | null;
};

export type ServicesResponse = { pricer: PricerService };

export type HealthResponse = {
  status: "ok" | "lagging" | "degraded";
  block: string;
  lagSeconds: number;
  interfaceVersion: number;
};

export type LadderDefaults = { rungs: number; firstOtmBps: number; stepBps: number; cardTargetBps: number };

export type PayoutRoute =
  | { venue: "v3"; fee: number }
  | { venue: "v4"; fee: number; tickSpacing: number; poolId: string };

export type ConfigResponse = {
  chainId: number;
  interfaceVersion: number;
  deployBlock: string | null;
  usdg: { address: string; symbol: string; decimals: number };
  contracts: {
    clearinghouse: string | null;
    orderBook: string | null;
    settlementOracle: string | null;
    expiryCalendar: string | null;
    keeperRewards: string | null;
    autoRoller: string | null;
    payoutAdapter: string | null;
    makerVault: string | null;
    makerRegistry: string | null;
    rewardsDistributor: string | null;
    accessManager?: string | null;
    stockZap?: string | null;
    sources: { chainlink: string | null; univ3: string | null; dataStreams: string | null };
  };
  flywheel?: { feeSplitter: string | null; buybackExecutor: string | null };
  safes?: { admin: string | null; treasury: string | null };
  access?: {
    manager: string;
    roles: {
      id: number;
      name: string;
      delayS: number;
      holders: { address: string; delayS: number }[];
    }[];
  };
  pendingOperations?: PendingAdminOperation[];
  fees: {
    premiumFeeBps: number;
    resaleFeeBps: number;
    takerFeeFlat: Money;
    takerFeeCapBps: number;
    makerRebateBps: number;
    exerciseFeeBps: number;
    mintFeePpm: number;
    /** T-OP-120 (G7): Clearinghouse `maxPayoutSlippageBps`, null until a payout adapter has been set. */
    maxPayoutSlippageBps: number | null;
  };
  pendingFees: {
    premiumFeeBps: number;
    resaleFeeBps: number;
    takerFeeFlat: Money;
    takerFeeCapBps: number;
    makerRebateBps: number;
    effectiveAt: number;
  } | null;
  constants: {
    unit: string;
    unitsPerShare: number;
    priceTick: number;
    settlementWindow: number;
    finalizeDelay: number;
    snapshotGrace: number;
    resolveDelay: number;
    maxTenor: number;
    minSeriesLead: number;
    mintFeePeriod: number;
    mintFeeCeilPpm: number;
    feeChangeDelay?: number;
  };
  ladder: { weekly: LadderDefaults; daily: LadderDefaults };
};

export type Market = {
  ticker: string;
  name: string;
  underlying: string;
  status: "planned" | "live" | "paused";
  /** T-OP-099. In the owner's launch set (registry `launchSet`); `status` is the chain's word, this is the registry's. */
  launch: boolean;
  spot: Money | null;
  spotUpdatedAt: number | null;
  strikeTick: Money;
  puts: boolean;
  mintFeePpm: number;
  settlement?: { sourceCount: number; uncorroboratedDelayS: number; route: PayoutRoute | null };
  expiries: number[];
  /** `asOf` is the indexed head both windows end at, 0 when no checkpoint was readable (T-425). */
  stats: { volume24h: Money; premium7d: Money; asOf: number; openInterestUnits: string; seriesOpen: number };
};

export type MarketsResponse = Market[];

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

export type MarketSeriesResponse = {
  items: { series: SeriesRef; quote: Quote; openInterestUnits: string; volume24h: Money }[];
  /** The indexed head each item's `volume24h` window ends at (T-425). */
  asOf: number;
  nextCursor: string | null;
};

export type SettlementCandidate = { price: Money; sourceIndex: number; disagreed: boolean; finalizableAt: number };

export type Settlement = {
  status: "None" | "Pending" | "Finalized" | "Held";
  price: Money | null;
  longPayoutPerUnit: Money | null;
  feePerUnit: Money | null;
  shortPayoutPerUnit: Money | null;
  finalizedAt: number | null;
  settledAt: number | null;
  sourceIndex: number | null;
  corroborated: boolean | null;
  candidate: SettlementCandidate | null;
};

export type SeriesDetailResponse = {
  series: SeriesRef;
  quote: Quote;
  openInterestUnits: string;
  volume: Money;
  settlement: Settlement | null;
  exerciseFeeBps: number;
};

export type BookResponse = { bids: Level[]; asks: Level[]; updatedBlock: string; snapshotTimestamp: number };

export type HoldersResponse = { items: { holder: string; units: string }[]; nextCursor: string | null };

export type Trade = {
  id: string;
  ts: number;
  price: Money;
  units: string;
  premium: Money;
  takerIsBuyer: boolean;
  primary: boolean;
  taker: string;
  maker: string;
  tx: string;
};

export type TradesResponse = { items: Trade[]; nextCursor: string | null };

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

export type CardsResponse = { items: Card[]; generatedAt: number; nextCursor: string | null };

export type HeroCardResponse = { card: Card | null; maxMultiple: number | null };

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export type Strategy = {
  active: boolean;
  weekly: boolean;
  smartPricing: boolean;
  otmBps: number;
  askBps: number;
  minAskBps: number;
  maxAskBps: number;
  maxUnits: string;
};

export type LongPosition = {
  series: SeriesRef;
  units: string;
  avgCost: Money;
  mark: Money | null;
  markSource?: "fair" | "best-bid" | null;
  unrealised: SignedMoney | null;
  claimable: Money | null;
};

export type ShortPosition = {
  series: SeriesRef;
  units: string;
  premiumReceived: Money;
  collateralLocked: Money;
  claimable: Money | null;
};

export type AccountOrder = {
  orderId: string;
  series: SeriesRef;
  kind: OrderKind;
  price: Money;
  units: string;
  filled: string;
  validUntil: number;
};

export type PositionsResponse = {
  longs: LongPosition[];
  shorts: ShortPosition[];
  orders: AccountOrder[];
  ledger: { asset: string; symbol: string; free: Money }[];
  strategies: { ticker: string; strategy: Strategy; currentSeries: SeriesRef | null; orderId: string | null; lastRolledAt: number | null; lastStaleCancelAt: number | null; staleSpot: Money | null }[];
  prefs: { inKind: boolean; toLedger: boolean };
};

type SeriesHistory<K extends string, D> = { id: string; kind: K; ts: number; longId: string; series: SeriesRef; data: D };
type LedgerHistory<K extends string, D> = { id: string; kind: K; ts: number; longId: null; series: null; data: D };

export type HistoryItem =
  | SeriesHistory<
      "fill",
      {
        orderId: string;
        side: "buy" | "sell";
        role: "taker" | "maker";
        counterparty: string;
        units: string;
        price: Money;
        premium: Money;
        fee: Money;
        rebate: Money;
        primary: boolean;
        realisedPnl: SignedMoney | null;
        tx: string;
      }
    >
  | SeriesHistory<"mint", { units: string; collateral: Money; fee: Money; payer?: string; longTo: string; tx: string }>
  | SeriesHistory<"close", { units: string; collateralFreed: Money; feeRefund: Money; realisedPnl: SignedMoney | null; tx: string }>
  | SeriesHistory<
      "redemption",
      {
        side: "long" | "short";
        tokenId: string;
        units: string;
        asset: string;
        amount: Money;
        amountInKind: Money;
        toLedger: boolean;
        realisedPnl: SignedMoney | null;
        tx: string;
      }
    >
  | LedgerHistory<"deposit", { asset: string; symbol: string; amount: Money; from: string; tx: string }>
  | LedgerHistory<"withdrawal", { asset: string; symbol: string; amount: Money; to: string; tx: string }>;

export type HistoryResponse = { items: HistoryItem[]; nextCursor: string | null };

// ---------------------------------------------------------------------------------------------
// Feeds, strategies, leaderboard, pnl, stats
// ---------------------------------------------------------------------------------------------

export type WinsResponse = { items: Win[]; nextCursor: string | null };

type Activity<K extends string, D> = {
  id: string;
  ts: number;
  longId: string;
  series: SeriesRef;
  accounts: string[];
  kind: K;
  data: D;
};

export type ActivityItem =
  | Activity<
      "fill",
      {
        orderId: string;
        taker: string;
        maker: string;
        recipient: string;
        units: string;
        price: Money;
        premium: Money;
        takerFee: Money;
        sellerFee: Money;
        makerRebate: Money;
        primary: boolean;
        takerIsBuyer: boolean;
        tx: string;
      }
    >
  | Activity<
      "settlement",
      { price: Money; longPayoutPerUnit: Money; feePerUnit: Money; shortPayoutPerUnit: Money; tx: string }
    >
  | Activity<
      "redemption",
      {
        holder: string;
        side: "long" | "short";
        tokenId: string;
        units: string;
        asset: string;
        amount: Money;
        amountInKind: Money;
        settlementPrice: Money;
        toLedger: boolean;
        tx: string;
      }
    >
  | Activity<"roll", { writer: string; orderId: string; price: Money; units: string; tx: string }>
  | Activity<"stale_cancel", { writer: string; orderId: string; spot: Money; spotUpdatedAt: number; nextRollAfter: number; tx: string }>;

export type ActivityResponse = { items: ActivityItem[]; nextCursor: string | null };

export type CalendarHolidaysResponse = {
  items: { dayIndex: number; isHoliday: boolean; isSessionDay: boolean }[];
};

export type StrategyPricingState = {
  /** Current live AutoRoller ask, in USDG6 per whole share. */
  currentAsk: UsdgPrice | null;
  /** Exact tick-aligned interval for an active, live, out-of-the-money AutoRoller ask; otherwise null. */
  band: { min: UsdgPrice; max: UsdgPrice } | null;
  lastRepricedAt: number | null;
  lastRepricedPrice: UsdgPrice | null;
  /** Number of Repriced events since the current position was rolled. */
  repriceCount: number;
  /** Current pricing-service estimate, in USDG6 per whole share. */
  fair: UsdgPrice | null;
};

export type StrategiesResponse = {
  items: {
    writer: string;
    underlying: string;
    ticker: string;
    strategy: Strategy;
    currentLongId: string | null;
    orderId: string | null;
    expiry: number | null;
    lastRolledAt: number | null; lastStaleCancelAt: number | null; staleSpot: Money | null;
    pricing?: StrategyPricingState;
  }[];
  nextCursor: string | null;
};

export type LeaderboardWindow = "week" | "month" | "all";

export type LeaderRow<V> = { rank: number; holder: string; value: V; wins: number; losses: number; best: Win };

export type LeaderboardResponse =
  | { metric: "multiple"; window: LeaderboardWindow; items: LeaderRow<number>[]; nextCursor: string | null }
  | { metric: "absolute"; window: LeaderboardWindow; items: LeaderRow<SignedMoney>[]; nextCursor: string | null }
  | { metric: "streak"; window: LeaderboardWindow; items: LeaderRow<number>[]; nextCursor: string | null };

export type PnlResponse = Win & {
  units: string;
  entryPrice: Money;
  settlementPrice: Money | null;
  spotAtEntry: Money | null;
};

/**
 * Whether a `selfTradeUnits` of 0 means "nobody is self-trading" or "the detector could not see
 * it". Both cheap evasions - one extra price tick, or an off-chain-funded second wallet - drive
 * the counted total to exactly 0, so the bare number cannot answer it. `unseenUnits` is never
 * added to `selfTradeUnits`: a suspicion is not a measurement.
 */
export type SelfTradeCoverage = {
  status: "detected" | "clean" | "blind";
  unseenUnits: string;
  reasons: { reason: "price-above-counted-band" | "no-link-evidence"; units: string; fills: number }[];
};

export type StatsResponse = {
  /** The indexed head every windowed figure below ends at, 0 with no checkpoint (T-425). */
  asOf: number;
  volume24h: Money;
  volumeAll: Money;
  premiumAll: Money;
  feesAll: Money;
  contractsFilled: string;
  holders: number;
  selfTradeUnits?: string;
  selfTradeCoverage?: SelfTradeCoverage;
  biggestWinDay: Win | null;
  biggestWinWeek: Win | null;
};

// ---------------------------------------------------------------------------------------------
// Makers, fair value
// ---------------------------------------------------------------------------------------------

/**
 * The scoring policy the epoch's figures were produced under. Additive and optional: an absent `band`
 * means the producer does not publish its policy, and a consumer must not infer one. The values are
 * OQ-14 placeholders and are not approved for funded use.
 */
export type MakerBand = { bps: number; minUsdg: Money };

export type MakerEpoch = { id: number; start: number; end: number; band?: MakerBand };

export type MakerStats = {
  /** Comparable only within one policy; an item without it is policy 1 (see api-schema.ts). */
  benchmarkPolicy: number;
  samples: { absent: number; valid: number; missingReference: number };
  uptimePct: number;
  avgSpreadBps: number | null;
  /** Always the 100 bps band, whatever `epoch.band` says. Its name pins its meaning. */
  depthWithin100bps: string;
  /** The same statistic inside `epoch.band`. Optional and new; never an alias of the field above. */
  depthInBand?: string;
  fills: number;
  volume: Money;
  rebates: Money;
  score: number;
  selfTradeUnits?: string;
  selfTradeCoverage?: SelfTradeCoverage;
};

export type MakersResponse = {
  epoch: MakerEpoch;
  items: ({ maker: string; tierBps: number } & MakerStats)[];
  nextCursor: string | null;
};

export type MakerResponse = { maker: string; tierBps: number; epochs: ({ epoch: MakerEpoch } & MakerStats)[] };

export type RewardEpoch = {
  distributor: string;
  epochId: number;
  root: string;
  total: Money;
  claimed: Money;
};

export type RewardEpochsResponse = {
  program: string;
  distributors: { distributor: string; funded: Money; defunded: Money; balance: Money }[];
  items: RewardEpoch[];
  nextCursor: string | null;
};

export type RewardClaim = {
  program: string;
  distributor: string;
  epochId: number;
  index: number;
  amount: Money;
  claimed: boolean;
  tx: string | null;
};

export type RewardClaimsResponse = { address: string; items: RewardClaim[]; nextCursor: string | null };

export type VaultBalance = { asset: string; symbol: string; free: Money };

export type VaultResponse = {
  vault: string;
  protocol: true;
  balances: { wallet: VaultBalance[]; ledger: VaultBalance[] };
  limits: {
    maxSeriesUnits: string;
    maxTotalNotional: string;
    askToleranceBps: number;
    maxBidBpsOfSpot: number;
    maxOrderLifetime: number;
    maxDailyOutflow: string;
  };
  outflow: { used: Money; cap: Money };
  liveOrderCount: number;
  trackedSeries: string[];
};

export type FairResponse =
  | {
      fair: Money;
      iv: number;
      delta: number;
      source: "cboe" | "model";
      asOf: number;
      spot?: Money;
      provenance?: PricingProvenance;
    }
  | { fair: null; reason: string; reasonCode?: string; provenance?: PricingProvenance };

// ---------------------------------------------------------------------------------------------
// Compile-time equality with the schemas. Nothing below exists at runtime.
// ---------------------------------------------------------------------------------------------

/**
 * Flattens intersections and mapped types into one plain object type so that two structurally
 * identical shapes compare equal however they were spelled (`A & B` vs one literal, zod's
 * mapped output types). Recurses through arrays and unions; leaves primitives alone.
 */
type Normalize<T> = T extends readonly (infer E)[]
  ? Normalize<E>[]
  : T extends object
    ? { [K in keyof T]: Normalize<T[K]> }
    : T;

/** True only when X and Y are mutually identical after normalisation (the strict "tsd" equality). */
type Equals<X, Y> =
  (<T>() => T extends Normalize<X> ? 1 : 2) extends <T>() => T extends Normalize<Y> ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

type Wire<S extends z.ZodTypeAny> = z.infer<S>;

/** Exported only so the linter does not flag the checks as unused; never import it. */
export type ApiTypeAssertions = [
  Assert<Equals<Money, Wire<typeof moneySchema>>>,
  Assert<Equals<SignedMoney, Wire<typeof signedMoneySchema>>>,
  Assert<Equals<PricingProvenance, Wire<typeof pricingProvenanceSchema>>>,
  Assert<Equals<SeriesStatus, Wire<typeof seriesStatusSchema>>>,
  Assert<Equals<SeriesRef, Wire<typeof seriesRefSchema>>>,
  Assert<Equals<Quote, Wire<typeof quoteSchema>>>,
  Assert<Equals<Card, Wire<typeof cardSchema>>>,
  Assert<Equals<OrderKind, Wire<typeof orderKindSchema>>>,
  Assert<Equals<BookOrder, Wire<typeof bookOrderSchema>>>,
  Assert<Equals<Level, Wire<typeof levelSchema>>>,
  Assert<Equals<Win, Wire<typeof winSchema>>>,
  Assert<Equals<ApiError, Wire<typeof errorSchema>>>,
  Assert<Equals<AdminOperation, Wire<typeof adminOperationSchema>>>,
  Assert<Equals<AdminOperationsResponse, Wire<typeof adminOperationsResponseSchema>>>,
  Assert<Equals<FlywheelAsset, Wire<typeof flywheelAssetSchema>>>,
  Assert<Equals<FlywheelDistribution, Wire<typeof flywheelDistributionSchema>>>,
  Assert<Equals<FlywheelResponse, Wire<typeof flywheelResponseSchema>>>,
  Assert<Equals<EarnQueuedRequest, Wire<typeof earnQueuedRequestSchema>>>,
  Assert<Equals<EarnAccount, Wire<typeof earnAccountSchema>>>,
  Assert<Equals<EarnAdapterMove, Wire<typeof earnAdapterMoveSchema>>>,
  Assert<Equals<EarnQueue, Wire<typeof earnQueueSchema>>>,
  Assert<Equals<EarnVault, Wire<typeof earnVaultSchema>>>,
  Assert<Equals<EarnResponse, Wire<typeof earnResponseSchema>>>,
  Assert<Equals<HouseNav, Wire<typeof houseNavSchema>>>,
  Assert<Equals<HouseEpoch, Wire<typeof houseEpochSchema>>>,
  Assert<Equals<HouseQueueItem, Wire<typeof houseQueueItemSchema>>>,
  Assert<Equals<HouseShares, Wire<typeof houseSharesSchema>>>,
  Assert<Equals<HouseVault, Wire<typeof houseVaultSchema>>>,
  Assert<Equals<HouseListResponse, Wire<typeof houseListResponseSchema>>>,
  Assert<Equals<HouseResponse, Wire<typeof houseListResponseSchema>>>,
  Assert<Equals<HouseMarketResponse, Wire<typeof houseMarketResponseSchema>>>,
  Assert<Equals<HealthResponse, Wire<typeof healthResponseSchema>>>,
  Assert<Equals<PricerService, Wire<typeof pricerServiceSchema>>>,
  Assert<Equals<ServicesResponse, Wire<typeof servicesResponseSchema>>>,
  Assert<Equals<ConfigResponse, Wire<typeof configResponseSchema>>>,
  Assert<Equals<Market, Wire<typeof marketSchema>>>,
  Assert<Equals<MarketsResponse, Wire<typeof marketsResponseSchema>>>,
  Assert<Equals<MarketSeriesResponse, Wire<typeof marketSeriesResponseSchema>>>,
  Assert<Equals<SettlementCandidate, Wire<typeof settlementCandidateSchema>>>,
  Assert<Equals<Settlement, Wire<typeof settlementSchema>>>,
  Assert<Equals<SeriesDetailResponse, Wire<typeof seriesDetailResponseSchema>>>,
  Assert<Equals<BookResponse, Wire<typeof bookResponseSchema>>>,
  Assert<Equals<HoldersResponse, Wire<typeof holdersResponseSchema>>>,
  Assert<Equals<Trade, Wire<typeof tradeSchema>>>,
  Assert<Equals<TradesResponse, Wire<typeof tradesResponseSchema>>>,
  Assert<Equals<CardsResponse, Wire<typeof cardsResponseSchema>>>,
  Assert<Equals<HeroCardResponse, Wire<typeof heroCardResponseSchema>>>,
  Assert<Equals<Strategy, Wire<typeof strategySchema>>>,
  Assert<Equals<PositionsResponse, Wire<typeof positionsResponseSchema>>>,
  Assert<Equals<HistoryItem, Wire<typeof historyItemSchema>>>,
  Assert<Equals<HistoryResponse, Wire<typeof historyResponseSchema>>>,
  Assert<Equals<WinsResponse, Wire<typeof winsResponseSchema>>>,
  Assert<Equals<ActivityItem, Wire<typeof activityItemSchema>>>,
  Assert<Equals<ActivityResponse, Wire<typeof activityResponseSchema>>>,
  Assert<Equals<CalendarHolidaysResponse, Wire<typeof calendarHolidaysResponseSchema>>>,
  Assert<Equals<StrategiesResponse, Wire<typeof strategiesResponseSchema>>>,
  Assert<Equals<LeaderboardResponse, Wire<typeof leaderboardResponseSchema>>>,
  Assert<Equals<PnlResponse, Wire<typeof pnlResponseSchema>>>,
  Assert<Equals<StatsResponse, Wire<typeof statsResponseSchema>>>,
  Assert<Equals<MakerEpoch, Wire<typeof makerEpochSchema>>>,
  Assert<Equals<MakersResponse, Wire<typeof makersResponseSchema>>>,
  Assert<Equals<MakerResponse, Wire<typeof makerResponseSchema>>>,
  Assert<Equals<RewardEpoch, Wire<typeof rewardEpochSchema>>>,
  Assert<Equals<RewardEpochsResponse, Wire<typeof rewardEpochsResponseSchema>>>,
  Assert<Equals<RewardClaim, Wire<typeof rewardClaimSchema>>>,
  Assert<Equals<RewardClaimsResponse, Wire<typeof rewardClaimsResponseSchema>>>,
  Assert<Equals<VaultResponse, Wire<typeof vaultResponseSchema>>>,
  Assert<Equals<FairResponse, Wire<typeof fairResponseSchema>>>,
];
