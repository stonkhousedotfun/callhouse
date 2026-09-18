/**
 * Boot-time configuration of the v2 bots, one schema per `V2_MODE`.
 *
 * Strict for the same reason as the v1 config.ts: a bot that boots on a malformed address finds out
 * at the first expiry it was meant to settle. Every problem is listed at once (env, registry,
 * missing contracts), not one per restart, and a bad environment exits 1 before anything runs.
 *
 * WHY NOT THE v1 config.ts. Importing it validates the v1 environment at module load and exits
 * without VAULT/FACTORY and KEEPER_PK; so do clients.ts, state.ts, alerts.ts and logger.ts, which
 * import it. Nothing under src/v2 imports any of them. The key names that mean the same thing keep
 * their v1 spelling (RH_RPC, CHAIN_ID, KEEPER_DB_PATH, KEEPER_LOG_LEVEL, KEEPER_TX_TIMEOUT_MS,
 * ALERT_WEBHOOK, POLL_INTERVAL_MS, ...), so one image and one ops vocabulary serve both.
 *
 * MODES
 *   cranker  CRANKER_PK, CRANKER_PORT (8792), INDEXER_URL optional (K2-03 falls back to log scans).
 *            Contracts: clearinghouse, orderBook, settlementOracle, expiryCalendar. autoRoller is
 *            OPTIONAL: without it the rolls step is skipped (a deployment, or a devnet, whose
 *            periphery is not wired yet still settles). CRANKER_* tuning below (crankerSchema).
 *   mm       MM_QUOTER_PK, MM_PORT (8793), PRICING_URL, MM_KILL_TOKEN; INDEXER_URL accepted, unused.
 *            Contracts: clearinghouse, orderBook, makerVault (MAKER_VAULT). MM_* quoting and risk
 *            settings below (mmTuningFields).
 *   pricer   PRICER_PK, PRICER_PORT (8794), PRICING_URL, INDEXER_URL optional (K2-05 falls back to
 *            its own StrategySet scan). Contracts: clearinghouse, orderBook, settlementOracle,
 *            autoRoller. PRICER_* tuning below (pricerSchema).
 *   pricing  holds no key and sends nothing: pricing/main.ts's own loader (PRICING_PORT 8790,
 *            V2_REGISTRY_PATH, RH_RPC, RH_RPC_2, KEEPER_LOG_LEVEL) is the whole schema.
 * The ports are this file's choice (§7 names CRANKER_PORT only): 8787 is the v1 keeper, 8790 the
 * pricing service, 8791 the notifier.
 *
 * ADDRESSES. Markets always come from the registry (V2_REGISTRY_PATH, default
 * ../ops/markets/tier1.json against the keeper package, like the pricing service; the Docker image
 * bakes it at /app/ops/markets/tier1.json and a container sets that absolute path, ops/v2/env). Each contract address comes from its
 * env var when set (a fork rehearsal against the production registry), else from `v2.contracts`.
 * Only the contracts the mode needs must resolve; an absent one names both places to set it.
 *
 * DOTENV. src/index.ts loads KEEPER_ENV_FILE (or ./.env) before it reads V2_MODE, exactly as the v1
 * config does, so this module only reads the environment it is handed.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { loadPricingEnv, type PricingEnv } from './pricing/main.js';
import { V2_MODES, type SigningMode } from './mode.js';
import { V2RegistryError, loadV2Registry, type V2ContractName, type V2Registry } from './registry.js';

export { V2_MODES, type SigningMode, type V2Mode } from './mode.js';

/** The keeper package directory: src/v2/ and dist/v2/ are both two levels in. */
export const KEEPER_PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_REGISTRY_PATH = '../ops/markets/tier1.json';

/** Where each contract's explicit address is read from. `MAKER_VAULT` is §7's spelling. */
export const CONTRACT_ENV: Record<V2ContractName, string> = {
  clearinghouse: 'V2_CLEARINGHOUSE',
  orderBook: 'V2_ORDER_BOOK',
  settlementOracle: 'V2_SETTLEMENT_ORACLE',
  expiryCalendar: 'V2_EXPIRY_CALENDAR',
  keeperRewards: 'V2_KEEPER_REWARDS',
  autoRoller: 'V2_AUTO_ROLLER',
  payoutAdapter: 'V2_PAYOUT_ADAPTER',
  makerVault: 'MAKER_VAULT',
  makerRegistry: 'V2_MAKER_REGISTRY',
  rewardsDistributor: 'V2_REWARDS_DISTRIBUTOR',
};

/**
 * The contracts each signing mode cannot run without. A later task that needs one more adds it here.
 * The cranker's autoRoller is deliberately absent: rolls are one of six steps, and a deployment
 * without the roller must still snapshot, settle and redeem (the step reports itself skipped).
 */
export const MODE_CONTRACTS = {
  cranker: ['clearinghouse', 'orderBook', 'settlementOracle', 'expiryCalendar'],
  mm: ['clearinghouse', 'orderBook', 'makerVault'],
  pricer: ['clearinghouse', 'orderBook', 'settlementOracle', 'autoRoller'],
} as const satisfies Record<SigningMode, readonly V2ContractName[]>;

export const MODE_KEY_ENV = { cranker: 'CRANKER_PK', mm: 'MM_QUOTER_PK', pricer: 'PRICER_PK' } as const satisfies Record<SigningMode, string>;
export const MODE_PORT_ENV = { cranker: 'CRANKER_PORT', mm: 'MM_PORT', pricer: 'PRICER_PORT' } as const satisfies Record<SigningMode, string>;
export const DEFAULT_MODE_PORT = { cranker: 8792, mm: 8793, pricer: 8794 } as const satisfies Record<SigningMode, number>;

/*//////////////////////////////////////////////////////////////
                          FIELD TYPES
//////////////////////////////////////////////////////////////*/

const addressField = z.string().transform((raw, ctx): Address => {
  if (!isAddress(raw, { strict: false })) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a 20-byte hex address: ${raw}` });
    return z.NEVER;
  }
  return getAddress(raw);
});

const privateKeyField = z.string().transform((raw, ctx): Hex => {
  const withPrefix = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    // Deliberately does not echo the value.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a 32-byte hex private key' });
    return z.NEVER;
  }
  return withPrefix.toLowerCase() as Hex;
});

/** RPC and webhook URLs carry keys and tokens in practice: an error names the problem, never the value. */
const httpUrlField = z.string().transform((raw, ctx): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a URL (value not shown; ${raw.length} chars)` });
    return z.NEVER;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an http(s) URL (scheme ${parsed.protocol})` });
    return z.NEVER;
  }
  return parsed.toString().replace(/\/$/, '');
});

const intField = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const bigintField = z.string().transform((raw, ctx): bigint => {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an integer: ${raw}` });
    return z.NEVER;
  }
  // BigInt('-1') parses, and KEEPER_MIN_GAS_WEI=-1 would silently switch the low-gas check off.
  if (value < 0n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must not be negative: ${raw}` });
    return z.NEVER;
  }
  return value;
});

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type V2LogLevel = (typeof LOG_LEVELS)[number];

/*//////////////////////////////////////////////////////////////
                            SCHEMAS
//////////////////////////////////////////////////////////////*/

const commonFields = {
  /** Primary RPC: reads fall back to RH_RPC_2, eth_getLogs and every send stay here (clients.ts). */
  RH_RPC: httpUrlField,
  RH_RPC_2: httpUrlField.optional(),
  CHAIN_ID: intField(1, 2 ** 31).default(4663),
  MULTICALL3: addressField.default('0xcA11bde05977b3631167028862bE2a173976CA11'),
  V2_REGISTRY_PATH: z.string().min(1).default(DEFAULT_REGISTRY_PATH),
  /** The SQLite journal of sent transactions. The image sets /data/keeper.db (the mounted volume);
   *  v2 tables are prefixed `v2_`, so they never meet v1's even in one file. */
  KEEPER_DB_PATH: z.string().min(1).default('./keeper-v2.db'),
  KEEPER_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Alert and report `degraded` when the signer's gas balance drops below this. 0.01 ETH. */
  KEEPER_MIN_GAS_WEI: bigintField.default('10000000000000000'),
  /** Alert when the head block's timestamp trails the wall clock by more than this. */
  KEEPER_RPC_LAG_ALERT_MS: intField(10_000, 86_400_000).default(300_000),
  KEEPER_ALERT_COOLDOWN_MS: intField(0, 86_400_000).default(3_600_000),
  KEEPER_TX_TIMEOUT_MS: intField(10_000, 600_000).default(180_000),
  /** How long a boot retries a chain it cannot read (the wiring check) before it exits 1; 0: exit at once. The health
   *  server (and the MM bot's kill route) is up meanwhile, instead of a crash loop into the platform's restart cap. */
  KEEPER_BOOT_RETRY_MS: intField(0, 3_600_000).default(300_000),
  ALERT_WEBHOOK: httpUrlField.optional(),
  /** relay/src/config.ts refuses a RELAY_TOKEN under 32 characters and answers 401 without one: required with ALERT_WEBHOOK. */
  ALERT_WEBHOOK_TOKEN: z.string().min(32, 'must be at least 32 characters, the relay\'s RELAY_TOKEN minimum (value not shown)').optional(),
  /** 1 s floor (v1: 5 s): a devnet cycle drives the cranker fast, and the cranker schedules its
   *  own wake-up at expiry rather than relying on the poll. */
  POLL_INTERVAL_MS: intField(1_000, 3_600_000).default(60_000),
  /* ---- explicit addresses (CONTRACT_ENV); each wins over the registry's ---- */
  V2_CLEARINGHOUSE: addressField.optional(),
  V2_ORDER_BOOK: addressField.optional(),
  V2_SETTLEMENT_ORACLE: addressField.optional(),
  V2_EXPIRY_CALENDAR: addressField.optional(),
  V2_KEEPER_REWARDS: addressField.optional(),
  V2_AUTO_ROLLER: addressField.optional(),
  V2_PAYOUT_ADAPTER: addressField.optional(),
  MAKER_VAULT: addressField.optional(),
  V2_MAKER_REGISTRY: addressField.optional(),
  V2_REWARDS_DISTRIBUTOR: addressField.optional(),
};

/**
 * The cranker's tuning (K2-03). Every key has a default that is right for chain 4663; ops/v2-env.mjs
 * lists them as comments in the cranker's env file.
 */
const crankerTuningFields = {
  /** Most transactions one step sends in one tick ("bounded per tick"). The rest waits for the next. */
  CRANKER_MAX_TX_PER_STEP: intField(1, 1_000).default(50),
  /** Gas limit ceiling of one batched transaction (redeemBatch, prune, a createSeries batch). */
  CRANKER_TX_GAS_CAP: intField(1_000_000, 30_000_000).default(8_000_000),
  /** eth_getLogs range per request of the holder/series/order index; halved on a refused range. */
  CRANKER_LOG_CHUNK_BLOCKS: intField(100, 10_000_000).default(50_000),
  /** Most eth_getLogs ranges the index scans per tick while catching up. */
  CRANKER_LOG_CHUNKS_PER_TICK: intField(1, 10_000).default(40),
  /** Burn zero-payout balances only while the gas price is at most this (wei). 0: never. */
  CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI: bigintField.default('0'),
  /** Alert v2_redeem_backlog when a settled series still has redeemable holders this long after settlement. */
  CRANKER_REDEEM_BACKLOG_S: intField(60, 7 * 86_400).default(3_600),
  /** Alert v2_settle_stuck when no source prices an expiry this long after finalize opened. */
  CRANKER_NO_SOURCE_ALERT_S: intField(60, 7 * 86_400).default(3_600),
  /** Alert v2_settle_stuck when a Pending candidate is still not final this long after finalizableAt. */
  CRANKER_PENDING_STUCK_S: intField(60, 7 * 86_400).default(1_800),
  /** sweepFees per asset at most this often. */
  CRANKER_SWEEP_INTERVAL_S: intField(3_600, 90 * 86_400).default(7 * 86_400),
  /** Timeout of one indexer request (holders, strategies). */
  CRANKER_INDEXER_TIMEOUT_MS: intField(500, 120_000).default(5_000),
};

const crankerSchema = z.object({
  ...commonFields,
  CRANKER_PK: privateKeyField,
  CRANKER_PORT: intField(0, 65_535).default(DEFAULT_MODE_PORT.cranker),
  INDEXER_URL: httpUrlField.optional(),
  ...crankerTuningFields,
});

/** A `0` / `1` switch. */
const flagField = z.enum(['0', '1']).transform((raw) => raw === '1');

/**
 * The MM bot's quoting, risk and kill-switch settings (K2-04, mm/engine.ts and mm/risk.ts use them).
 * Prices are USDG base units (6 dp) PER WHOLE SHARE, sizes 0.01-share units, rates bps. Every key but
 * MM_KILL_TOKEN has a default; ops/v2-env.mjs lists them as comments in the mm-bot env file.
 */
const mmTuningFields = {
  /** Bearer token of POST /kill and POST /resume. A secret: never echoed, compared in constant time. */
  MM_KILL_TOKEN: z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32); the value is not shown'),
  /** Comma-separated tickers to quote; unset = every live v2 market in the registry. */
  MM_MARKETS: z.string().optional(),
  /** Most series quoted at once, and per market (nearest the money first, then nearest expiry). */
  MM_MAX_SERIES: intField(1, 1_000).default(40),
  MM_MAX_SERIES_PER_MARKET: intField(1, 500).default(10),
  /** bid = fair − halfSpread − skew, ask = fair + halfSpread − skew; halfSpread = max(fair × bps, the minimum). */
  MM_HALF_SPREAD_BPS: intField(1, 5_000).default(500),
  MM_MIN_HALF_SPREAD_USDG6: bigintField.default('20000'),
  /** Near expiry the half spread grows linearly from `expiry − MM_EXPIRY_WIDEN_S` to +MM_EXPIRY_WIDEN_BPS at the pull time. */
  MM_EXPIRY_WIDEN_S: intField(0, 45 * 86_400).default(14_400),
  MM_EXPIRY_WIDEN_BPS: intField(0, 1_000_000).default(20_000),
  /** Every quote of a series is pulled this many minutes before its mint cutoff (expiry − 30 min). */
  MM_PULL_MINUTES: intField(0, 1_440).default(15),
  /** 0: no quote outside the regular session (orders placed in a session expire at its close). */
  MM_QUOTE_OFF_HOURS: flagField.default('0'),
  /** Oldest pricing `asOf` (the Cboe chain's last trade) quoted on, against the head block's time. */
  MM_FAIR_MAX_AGE_S: intField(1, 45 * 86_400).default(1_800),
  MM_FAIR_MAX_AGE_OFF_HOURS_S: intField(1, 45 * 86_400).default(345_600),
  /** Size of the bid, and of the ask side (resale of inventory first, AskWrite for the rest). 0 turns a side off. */
  MM_BID_UNITS: intField(0, 100_000_000).default(100),
  MM_ASK_UNITS: intField(0, 100_000_000).default(100),
  /** skew = seriesDelta × spot × (MM_SKEW_BPS_PER_DELTA_SHARE / 1e4) × the market's net inventory delta in shares,
   *  capped at MM_MAX_SKEW_BPS of fair. */
  MM_SKEW_BPS_PER_DELTA_SHARE: intField(0, 100_000).default(10),
  MM_MAX_SKEW_BPS: intField(0, 10_000).default(1_000),
  /** Replace a live quote only when its target price moved more than this, or its size is off by more than MM_RESIZE_BPS. */
  MM_REQUOTE_BPS: intField(1, 10_000).default(300),
  MM_RESIZE_BPS: intField(0, 10_000).default(5_000),
  /** Bot-side caps, each at most the vault's own (0 = the vault's limit alone). */
  MM_MAX_SERIES_UNITS: bigintField.default('0'),
  MM_MAX_TOTAL_NOTIONAL_USDG6: bigintField.default('0'),
  /** Realised loss of one UTC day (head block time) that stops quoting until the next day. */
  MM_DAILY_LOSS_LIMIT_USDG6: bigintField.refine((v) => v > 0n, 'must be positive').default('1000000000'),
  /** Alert v2_mm_delta when a market's net inventory delta exceeds this many shares (hedging is manual). 0: never. */
  MM_DELTA_ALERT_SHARES: intField(0, 100_000_000).default(50),
  MM_MAX_TX_PER_TICK: intField(1, 1_000).default(60),
  /** MakerVault.sync(trackedSeries()) at most this often: fills and expiries leave stored notional stale-high. */
  MM_SYNC_INTERVAL_S: intField(60, 7 * 86_400).default(900),
  MM_PRICING_TIMEOUT_MS: intField(500, 120_000).default(5_000),
  /** 1: move Stock Tokens in the vault's wallet (settlement returns, admin top-ups) into its Clearinghouse ledger, where
   *  AskWrite fills mint from. USDG is never moved: bids escrow it from the wallet. */
  MM_DEPOSIT_TOKENS: flagField.default('1'),
  /**
   * The longest validUntil a new quote gets (0 = only the pull time, the session close and the vault's maxOrderLifetime).
   * A dead bot, or one whose sends all fail, leaves nothing fillable longer than this. Each quote is re-placed shortly
   * before it expires (two transactions per slot per lifetime), so lower costs gas.
   */
  MM_MAX_QUOTE_LIFETIME_S: intField(0, 7 * 86_400).default(1_800),
  /**
   * The pricing service's spot (in /fair) may differ from the series oracle's by at most this, bps; beyond it the series
   * halts fair-spot-mismatch, inside it the fair value is carried to the oracle's spot along its delta. Both read the same
   * Chainlink feed, so a gap is a lagging read. 0: unchecked.
   */
  MM_FAIR_SPOT_TOLERANCE_BPS: intField(0, 10_000).default(300),
};

const mmSchema = z.object({
  ...commonFields,
  MM_QUOTER_PK: privateKeyField,
  MM_PORT: intField(0, 65_535).default(DEFAULT_MODE_PORT.mm),
  PRICING_URL: httpUrlField,
  /** Accepted and unused: the MM bot reads series, orders and fills from chain (its own log scan). */
  INDEXER_URL: httpUrlField.optional(),
  ...mmTuningFields,
});

/**
 * The pricer's tuning (K2-05). Defaults are the task's numbers (a 10 % move, 30 minutes); ops/v2-env.mjs
 * lists them as comments in the pricer's env file.
 */
const pricerTuningFields = {
  /** target = fair × (1 + edge): the premium over fair value the writer's ask carries. May be negative. */
  PRICER_EDGE_BPS: intField(-5_000, 10_000).default(500),
  /** Reprice only when the target differs from the live ask by MORE than this (1000 = 10 %). */
  PRICER_REPRICE_THRESHOLD_BPS: intField(1, 10_000).default(1_000),
  /** A position is evaluated right after its roll, then at most once per this many seconds (head clock). */
  PRICER_MIN_INTERVAL_S: intField(60, 7 * 86_400).default(1_800),
  /** Most reprice transactions sent in one tick. */
  PRICER_MAX_TX_PER_TICK: intField(1, 1_000).default(50),
  /** Timeout of one pricing-service or indexer request. */
  PRICER_HTTP_TIMEOUT_MS: intField(500, 120_000).default(5_000),
  /** Alert v2_pricer_fair_unavailable when a live smart-pricing ask has had no fair value this long. */
  PRICER_FAIR_ALERT_S: intField(60, 7 * 86_400).default(7_200),
  /** eth_getLogs range of the StrategySet scan; halved on a refused range. */
  PRICER_LOG_CHUNK_BLOCKS: intField(100, 10_000_000).default(50_000),
  /** Most eth_getLogs ranges scanned per tick while catching up. */
  PRICER_LOG_CHUNKS_PER_TICK: intField(1, 10_000).default(40),
};

const pricerSchema = z.object({
  ...commonFields,
  PRICER_PK: privateKeyField,
  PRICER_PORT: intField(0, 65_535).default(DEFAULT_MODE_PORT.pricer),
  PRICING_URL: httpUrlField,
  /** Optional, as for the cranker: the strategy list also comes from the pricer's own StrategySet scan. */
  INDEXER_URL: httpUrlField.optional(),
  ...pricerTuningFields,
});

/*//////////////////////////////////////////////////////////////
                             TYPES
//////////////////////////////////////////////////////////////*/

/** Every contract address, with the mode's required ones known to be present. */
export type ContractsWith<R extends V2ContractName> = { [K in V2ContractName]: K extends R ? Address : Address | null };

export interface SigningModeBase<M extends SigningMode> {
  mode: M;
  rpcUrls: readonly [string, ...string[]];
  chainId: number;
  multicall3: Address;
  /** Absolute. */
  registryPath: string;
  registry: V2Registry;
  contracts: ContractsWith<(typeof MODE_CONTRACTS)[M][number]>;
  /** Where each address came from, for the boot line: an env var, the registry, or nowhere. */
  contractSources: Record<V2ContractName, 'env' | 'registry' | null>;
  /** The signer key, behind a function: a `log.info({ config })` serialises no function, so a
   *  config object dumped whole can never print the key. */
  privateKey: () => Hex;
  /** The env var the key came from (CRANKER_PK, MM_QUOTER_PK, PRICER_PK), for messages. */
  keyEnv: (typeof MODE_KEY_ENV)[M];
  /** Health server port (0 = any free port). */
  port: number;
  dbPath: string;
  logLevel: V2LogLevel;
  minGasWei: bigint;
  rpcLagAlertMs: number;
  alertCooldownMs: number;
  txTimeoutMs: number;
  /** KEEPER_BOOT_RETRY_MS. */
  bootRetryMs: number;
  alertWebhook: string | null;
  alertWebhookToken: string | null;
  pollIntervalMs: number;
}

/** The CRANKER_* keys, parsed (see crankerTuningFields for each one's meaning). */
export interface CrankerTuning {
  maxTxPerStep: number;
  txGasCap: bigint;
  logChunkBlocks: number;
  logChunksPerTick: number;
  zeroPayoutMaxGasPriceWei: bigint;
  redeemBacklogS: number;
  noSourceAlertS: number;
  pendingStuckS: number;
  sweepIntervalS: number;
  indexerTimeoutMs: number;
}

export interface CrankerConfig extends SigningModeBase<'cranker'> {
  indexerUrl: string | null;
  tuning: CrankerTuning;
}

/** The MM_* keys, parsed (see mmTuningFields for each one's meaning). */
export interface MmTuning {
  /** Upper-case tickers, or null for every live v2 market. */
  markets: readonly string[] | null;
  maxSeries: number;
  maxSeriesPerMarket: number;
  halfSpreadBps: number;
  minHalfSpreadUsdg6: bigint;
  expiryWidenS: number;
  expiryWidenBps: number;
  pullMinutes: number;
  quoteOffHours: boolean;
  fairMaxAgeS: number;
  fairMaxAgeOffHoursS: number;
  bidUnits: bigint;
  askUnits: bigint;
  skewBpsPerDeltaShare: number;
  maxSkewBps: number;
  requoteBps: number;
  resizeBps: number;
  /** 0n = the vault's limit alone. */
  maxSeriesUnits: bigint;
  /** 0n = the vault's limit alone. */
  maxTotalNotionalUsdg6: bigint;
  dailyLossLimitUsdg6: bigint;
  deltaAlertShares: number;
  maxTxPerTick: number;
  syncIntervalS: number;
  pricingTimeoutMs: number;
  depositTokens: boolean;
  maxQuoteLifetimeS: number;
  fairSpotToleranceBps: number;
}

export interface MmConfig extends SigningModeBase<'mm'> {
  pricingUrl: string;
  /** Unused by the MM bot (accepted so one env shape serves every bot). */
  indexerUrl: string | null;
  /** MM_KILL_TOKEN behind a function, like the key: a dumped config never prints it. */
  killToken: () => string;
  tuning: MmTuning;
}

/** The PRICER_* keys, parsed (see pricerTuningFields for each one's meaning). */
export interface PricerTuning {
  edgeBps: number;
  repriceThresholdBps: number;
  minIntervalS: number;
  maxTxPerTick: number;
  httpTimeoutMs: number;
  fairAlertS: number;
  logChunkBlocks: number;
  logChunksPerTick: number;
}

export interface PricerConfig extends SigningModeBase<'pricer'> {
  pricingUrl: string;
  indexerUrl: string | null;
  tuning: PricerTuning;
}

export interface PricingModeConfig {
  mode: 'pricing';
  /** Validated by pricing/main.ts's own loader; startPricingService reads the same environment. */
  pricing: PricingEnv;
}

export type SigningModeConfig = CrankerConfig | MmConfig | PricerConfig;
export type V2Config = SigningModeConfig | PricingModeConfig;

/*//////////////////////////////////////////////////////////////
                            LOADING
//////////////////////////////////////////////////////////////*/

export class V2ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V2ConfigError';
  }
}

/** `NVDA, tsla,,AAPL` → ['NVDA', 'TSLA', 'AAPL'] (trimmed, upper-cased, blanks and repeats dropped). */
export function parseTickerList(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim().toUpperCase()).filter((t) => t !== ''))];
}

/** Blank values are unset, as in v1's config.ts: `.env` files ship with `KEY=` lines. */
export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value.trim();
  }
  return cleaned;
}

function fail(lines: readonly string[]): never {
  throw new V2ConfigError(
    `v2 configuration is not usable. Fix these and restart:\n${lines.map((l) => `  ${l}`).join('\n')}\n\n` +
      'The v2 keys are documented in keeper/src/v2/config.ts and keeper/README.md ("v2 modes").',
  );
}

/**
 * Parse the environment for the mode it names. Throws V2ConfigError listing every problem.
 * Reads the registry file (every mode but pricing), and nothing else: no RPC.
 */
export function loadV2Config(env: NodeJS.ProcessEnv = process.env): V2Config {
  const cleaned = cleanEnv(env);
  const mode = cleaned.V2_MODE;
  if (mode === undefined || !(V2_MODES as readonly string[]).includes(mode)) {
    fail([`V2_MODE: must be one of ${V2_MODES.join(' | ')}${mode === undefined ? ' (unset)' : ` (got ${JSON.stringify(mode)})`}`]);
  }
  if (mode === 'pricing') {
    try {
      return { mode, pricing: loadPricingEnv(cleaned) };
    } catch (error) {
      throw new V2ConfigError(error instanceof Error ? error.message : String(error));
    }
  }
  return loadSigningModeConfig(mode as SigningMode, cleaned);
}

function loadSigningModeConfig(mode: SigningMode, cleaned: Record<string, string>): SigningModeConfig {
  const schema = mode === 'cranker' ? crankerSchema : mode === 'mm' ? mmSchema : pricerSchema;
  const parsed = schema.safeParse(cleaned);
  const lines = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

  // The registry is read even when the environment has problems: its path has a default, and its
  // problems belong in the same list.
  const registryPath = resolve(KEEPER_PACKAGE_DIR, cleaned.V2_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH);
  let registry: V2Registry | null = null;
  try {
    registry = loadV2Registry(registryPath);
  } catch (error) {
    const problems = error instanceof V2RegistryError ? error.problems : [error instanceof Error ? error.message : String(error)];
    lines.push(...problems.map((p) => `V2_REGISTRY_PATH (${registryPath}): ${p}`));
  }

  const envAddress = (name: V2ContractName): Address | null => {
    const raw = cleaned[CONTRACT_ENV[name]];
    return raw !== undefined && isAddress(raw, { strict: false }) ? getAddress(raw) : null;
  };
  const contracts = {} as Record<V2ContractName, Address | null>;
  const contractSources = {} as Record<V2ContractName, 'env' | 'registry' | null>;
  // An explicit address wins over the registry's, which is what a devnet and a registry with no v2
  // block need. But when BOTH name an address and they differ, the environment is almost always
  // stale: the image carries the release's registry (ops/deploy.md §15.2), so a redeployed contract
  // reaches the bot as a rebuild, while a Railway variable set at the last release survives it and
  // silently keeps the bot pointed at the replaced contract. That is refused; V2_CONTRACTS_FROM_ENV=1
  // takes the environment on purpose (an override before the registry is rebuilt).
  const envOverrideAllowed = cleaned.V2_CONTRACTS_FROM_ENV === '1';
  for (const name of Object.keys(CONTRACT_ENV) as V2ContractName[]) {
    const fromEnv = envAddress(name);
    const fromRegistry = registry?.contracts[name] ?? null;
    contracts[name] = fromEnv ?? fromRegistry;
    contractSources[name] = fromEnv !== null ? 'env' : fromRegistry !== null ? 'registry' : null;
    if (fromEnv !== null && fromRegistry !== null && fromEnv !== fromRegistry && !envOverrideAllowed) {
      lines.push(
        `${CONTRACT_ENV[name]}: ${fromEnv} disagrees with v2.contracts.${name} ${fromRegistry} in ${registryPath}; ` +
          'the registry in the image is the release. Unset the variable, or set V2_CONTRACTS_FROM_ENV=1 to use the environment on purpose.',
      );
    }
  }
  if (registry !== null) {
    for (const name of MODE_CONTRACTS[mode]) {
      // An env var that failed to parse is already listed; do not also call it missing.
      if (contracts[name] === null && cleaned[CONTRACT_ENV[name]] === undefined) {
        lines.push(
          `${CONTRACT_ENV[name]}: V2_MODE=${mode} needs the ${name} address; set ${CONTRACT_ENV[name]} or v2.contracts.${name} in ${registryPath}` +
            (registry.hasV2Block ? '' : ' (the registry has no v2 block yet)'),
        );
      }
    }
  }

  // A webhook without a token is refused by the relay (401) on every page, logged and never seen.
  if (cleaned.ALERT_WEBHOOK !== undefined && cleaned.ALERT_WEBHOOK_TOKEN === undefined) {
    lines.push('ALERT_WEBHOOK_TOKEN: required with ALERT_WEBHOOK (the relay answers 401 without it); set it to the relay\'s RELAY_TOKEN');
  }

  // MM_MARKETS names markets the registry must know as v2 markets (a typo would quote nothing, silently).
  if (mode === 'mm' && registry !== null && cleaned.MM_MARKETS !== undefined) {
    for (const ticker of parseTickerList(cleaned.MM_MARKETS)) {
      const row = registry.markets.find((m) => m.ticker === ticker);
      if (row === undefined || row.v2 === null) lines.push(`MM_MARKETS: ${ticker} is not a v2 market in ${registryPath}`);
    }
  }

  // Compared even when other keys failed, but not for a CHAIN_ID that is itself malformed (already listed).
  const chainId = parsed.success ? parsed.data.CHAIN_ID : Number(cleaned.CHAIN_ID ?? 4663);
  if (registry?.chainId != null && Number.isInteger(chainId) && registry.chainId !== chainId) {
    lines.push(`CHAIN_ID: ${chainId}, but the registry at ${registryPath} describes chain ${registry.chainId}; point V2_REGISTRY_PATH at that chain's registry`);
  }

  if (!parsed.success || registry === null || lines.length > 0) fail(lines);
  const e = parsed.data;

  const base = {
    rpcUrls: (e.RH_RPC_2 === undefined ? [e.RH_RPC] : [e.RH_RPC, e.RH_RPC_2]) as [string, ...string[]],
    chainId: e.CHAIN_ID,
    multicall3: e.MULTICALL3,
    registryPath,
    registry,
    contractSources,
    dbPath: e.KEEPER_DB_PATH,
    logLevel: e.KEEPER_LOG_LEVEL,
    minGasWei: e.KEEPER_MIN_GAS_WEI,
    rpcLagAlertMs: e.KEEPER_RPC_LAG_ALERT_MS,
    alertCooldownMs: e.KEEPER_ALERT_COOLDOWN_MS,
    txTimeoutMs: e.KEEPER_TX_TIMEOUT_MS,
    bootRetryMs: e.KEEPER_BOOT_RETRY_MS,
    alertWebhook: e.ALERT_WEBHOOK ?? null,
    alertWebhookToken: e.ALERT_WEBHOOK_TOKEN ?? null,
    pollIntervalMs: e.POLL_INTERVAL_MS,
  };

  // The required contracts were checked above; the casts narrow what that loop established.
  if (mode === 'cranker') {
    const c = e as z.infer<typeof crankerSchema>;
    const key = c.CRANKER_PK;
    return {
      ...base,
      mode,
      contracts: contracts as ContractsWith<(typeof MODE_CONTRACTS)['cranker'][number]>,
      privateKey: () => key,
      keyEnv: MODE_KEY_ENV.cranker,
      port: c.CRANKER_PORT,
      indexerUrl: c.INDEXER_URL ?? null,
      tuning: {
        maxTxPerStep: c.CRANKER_MAX_TX_PER_STEP,
        txGasCap: BigInt(c.CRANKER_TX_GAS_CAP),
        logChunkBlocks: c.CRANKER_LOG_CHUNK_BLOCKS,
        logChunksPerTick: c.CRANKER_LOG_CHUNKS_PER_TICK,
        zeroPayoutMaxGasPriceWei: c.CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI,
        redeemBacklogS: c.CRANKER_REDEEM_BACKLOG_S,
        noSourceAlertS: c.CRANKER_NO_SOURCE_ALERT_S,
        pendingStuckS: c.CRANKER_PENDING_STUCK_S,
        sweepIntervalS: c.CRANKER_SWEEP_INTERVAL_S,
        indexerTimeoutMs: c.CRANKER_INDEXER_TIMEOUT_MS,
      },
    };
  }
  if (mode === 'mm') {
    const c = e as z.infer<typeof mmSchema>;
    const key = c.MM_QUOTER_PK;
    const killToken = c.MM_KILL_TOKEN;
    const markets = c.MM_MARKETS === undefined ? [] : parseTickerList(c.MM_MARKETS);
    return {
      ...base,
      mode,
      contracts: contracts as ContractsWith<(typeof MODE_CONTRACTS)['mm'][number]>,
      privateKey: () => key,
      keyEnv: MODE_KEY_ENV.mm,
      port: c.MM_PORT,
      pricingUrl: c.PRICING_URL,
      indexerUrl: c.INDEXER_URL ?? null,
      killToken: () => killToken,
      tuning: {
        markets: markets.length === 0 ? null : markets,
        maxSeries: c.MM_MAX_SERIES,
        maxSeriesPerMarket: c.MM_MAX_SERIES_PER_MARKET,
        halfSpreadBps: c.MM_HALF_SPREAD_BPS,
        minHalfSpreadUsdg6: c.MM_MIN_HALF_SPREAD_USDG6,
        expiryWidenS: c.MM_EXPIRY_WIDEN_S,
        expiryWidenBps: c.MM_EXPIRY_WIDEN_BPS,
        pullMinutes: c.MM_PULL_MINUTES,
        quoteOffHours: c.MM_QUOTE_OFF_HOURS,
        fairMaxAgeS: c.MM_FAIR_MAX_AGE_S,
        fairMaxAgeOffHoursS: c.MM_FAIR_MAX_AGE_OFF_HOURS_S,
        bidUnits: BigInt(c.MM_BID_UNITS),
        askUnits: BigInt(c.MM_ASK_UNITS),
        skewBpsPerDeltaShare: c.MM_SKEW_BPS_PER_DELTA_SHARE,
        maxSkewBps: c.MM_MAX_SKEW_BPS,
        requoteBps: c.MM_REQUOTE_BPS,
        resizeBps: c.MM_RESIZE_BPS,
        maxSeriesUnits: c.MM_MAX_SERIES_UNITS,
        maxTotalNotionalUsdg6: c.MM_MAX_TOTAL_NOTIONAL_USDG6,
        dailyLossLimitUsdg6: c.MM_DAILY_LOSS_LIMIT_USDG6,
        deltaAlertShares: c.MM_DELTA_ALERT_SHARES,
        maxTxPerTick: c.MM_MAX_TX_PER_TICK,
        syncIntervalS: c.MM_SYNC_INTERVAL_S,
        pricingTimeoutMs: c.MM_PRICING_TIMEOUT_MS,
        depositTokens: c.MM_DEPOSIT_TOKENS,
        maxQuoteLifetimeS: c.MM_MAX_QUOTE_LIFETIME_S,
        fairSpotToleranceBps: c.MM_FAIR_SPOT_TOLERANCE_BPS,
      },
    };
  }
  const c = e as z.infer<typeof pricerSchema>;
  const key = c.PRICER_PK;
  return {
    ...base,
    mode,
    contracts: contracts as ContractsWith<(typeof MODE_CONTRACTS)['pricer'][number]>,
    privateKey: () => key,
    keyEnv: MODE_KEY_ENV.pricer,
    port: c.PRICER_PORT,
    pricingUrl: c.PRICING_URL,
    indexerUrl: c.INDEXER_URL ?? null,
    tuning: {
      edgeBps: c.PRICER_EDGE_BPS,
      repriceThresholdBps: c.PRICER_REPRICE_THRESHOLD_BPS,
      minIntervalS: c.PRICER_MIN_INTERVAL_S,
      maxTxPerTick: c.PRICER_MAX_TX_PER_TICK,
      httpTimeoutMs: c.PRICER_HTTP_TIMEOUT_MS,
      fairAlertS: c.PRICER_FAIR_ALERT_S,
      logChunkBlocks: c.PRICER_LOG_CHUNK_BLOCKS,
      logChunksPerTick: c.PRICER_LOG_CHUNKS_PER_TICK,
    },
  };
}
