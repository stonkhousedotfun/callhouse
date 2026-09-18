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
  calendarHolidaysResponseSchema,
  bookOrderSchema,
  bookResponseSchema,
  cardSchema,
  cardsResponseSchema,
  configResponseSchema,
  errorSchema,
  fairResponseSchema,
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
  marketSchema,
  marketSeriesResponseSchema,
  marketsResponseSchema,
  moneySchema,
  orderKindSchema,
  pnlResponseSchema,
  positionsResponseSchema,
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

/** Money whose raw may carry a leading "-" (PnL only). */
export type SignedMoney = { raw: string; decimals: number; formatted: string };

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

// ---------------------------------------------------------------------------------------------
// /v2/health, /v2/config, /v2/markets
// ---------------------------------------------------------------------------------------------

export type HealthResponse = {
  status: "ok" | "lagging" | "degraded";
  block: string;
  lagSeconds: number;
  interfaceVersion: number;
};

export type LadderDefaults = { rungs: number; firstOtmBps: number; stepBps: number; cardTargetBps: number };

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
    sources: { chainlink: string | null; univ3: string | null; dataStreams: string | null };
  };
  fees: {
    premiumFeeBps: number;
    resaleFeeBps: number;
    takerFeeFlat: Money;
    takerFeeCapBps: number;
    makerRebateBps: number;
    exerciseFeeBps: number;
    mintFeePpm: number;
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
  };
  ladder: { weekly: LadderDefaults; daily: LadderDefaults };
};

export type Market = {
  ticker: string;
  name: string;
  underlying: string;
  status: "planned" | "live" | "paused";
  spot: Money | null;
  spotUpdatedAt: number | null;
  strikeTick: Money;
  puts: boolean;
  mintFeePpm: number;
  expiries: number[];
  stats: { volume24h: Money; premium7d: Money; openInterestUnits: string; seriesOpen: number };
};

export type MarketsResponse = Market[];

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

export type MarketSeriesResponse = {
  items: { series: SeriesRef; quote: Quote; openInterestUnits: string; volume24h: Money }[];
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
  | SeriesHistory<"mint", { units: string; collateral: Money; fee: Money; longTo: string; tx: string }>
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

export type StatsResponse = {
  volume24h: Money;
  volumeAll: Money;
  premiumAll: Money;
  feesAll: Money;
  contractsFilled: string;
  holders: number;
  biggestWinDay: Win | null;
  biggestWinWeek: Win | null;
};

// ---------------------------------------------------------------------------------------------
// Makers, fair value
// ---------------------------------------------------------------------------------------------

export type MakerEpoch = { id: number; start: number; end: number };

export type MakerStats = {
  uptimePct: number;
  avgSpreadBps: number | null;
  depthWithin100bps: string;
  fills: number;
  volume: Money;
  rebates: Money;
  score: number;
};

export type MakersResponse = {
  epoch: MakerEpoch;
  items: ({ maker: string; tierBps: number } & MakerStats)[];
  nextCursor: string | null;
};

export type MakerResponse = { maker: string; tierBps: number; epochs: ({ epoch: MakerEpoch } & MakerStats)[] };

export type FairResponse =
  | { fair: Money; iv: number; delta: number; source: "cboe" | "model"; asOf: number }
  | { fair: null; reason: string };

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
  Assert<Equals<SeriesStatus, Wire<typeof seriesStatusSchema>>>,
  Assert<Equals<SeriesRef, Wire<typeof seriesRefSchema>>>,
  Assert<Equals<Quote, Wire<typeof quoteSchema>>>,
  Assert<Equals<Card, Wire<typeof cardSchema>>>,
  Assert<Equals<OrderKind, Wire<typeof orderKindSchema>>>,
  Assert<Equals<BookOrder, Wire<typeof bookOrderSchema>>>,
  Assert<Equals<Level, Wire<typeof levelSchema>>>,
  Assert<Equals<Win, Wire<typeof winSchema>>>,
  Assert<Equals<ApiError, Wire<typeof errorSchema>>>,
  Assert<Equals<HealthResponse, Wire<typeof healthResponseSchema>>>,
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
  Assert<Equals<FairResponse, Wire<typeof fairResponseSchema>>>,
];
