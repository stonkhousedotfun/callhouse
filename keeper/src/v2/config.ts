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
 *            autoRoller, expiryCalendar. PRICER_* tuning below (pricerSchema).
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
import {
  TENORS,
  V2_ADDRESS_NAMES,
  V2_ADDRESS_PATH,
  V2RegistryError,
  loadV2Registry,
  v2Address,
  v2Markets,
  type MarketParams,
  type V2AddressName,
  type V2Market,
  type V2Registry,
} from './registry.js';

export { V2_MODES, type SigningMode, type V2Mode } from './mode.js';

/** The keeper package directory: src/v2/ and dist/v2/ are both two levels in. */
export const KEEPER_PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_REGISTRY_PATH = '../ops/markets/tier1.json';

/**
 * Where each address's explicit value is read from. `MAKER_VAULT` is §7's spelling.
 *
 * MIRRORED, NOT CHOSEN. Every v8 name here is the name ops already renders, so a variable an operator sets
 * from the generated env file reaches the bot: `V2_ACCESS_MANAGER` (ops/v2-env.mjs:245),
 * `V2_FEE_SPLITTER` (:251) and `V2_BUYBACK_EXECUTOR` (:252) — the last two are the only contract addresses
 * ops sets on any keeper process at all (ops/v2/env/cranker.env:23,25).
 *
 * `payoutAdapter` is the one slot where the repo disagreed with itself: ops (`ops/v2-env.mjs`:308) and the
 * indexer (`indexer/lib/env.ts`:171) both say `V2_PAYOUT_ROUTER`, while the keeper said
 * `V2_PAYOUT_ADAPTER`. v8 puts the `PayoutRouter` in that slot, so the keeper takes the router spelling and
 * keeps the adapter spelling as a deprecated alias rather than ignoring a variable somebody already set —
 * see PAYOUT_ENV_ALIAS below. The REGISTRY key stays `payoutAdapter` in v8 and is not renamed here.
 */
export const CONTRACT_ENV: Record<V2AddressName, string> = {
  clearinghouse: 'V2_CLEARINGHOUSE',
  orderBook: 'V2_ORDER_BOOK',
  settlementOracle: 'V2_SETTLEMENT_ORACLE',
  expiryCalendar: 'V2_EXPIRY_CALENDAR',
  keeperRewards: 'V2_KEEPER_REWARDS',
  autoRoller: 'V2_AUTO_ROLLER',
  payoutAdapter: 'V2_PAYOUT_ROUTER',
  makerVault: 'MAKER_VAULT',
  makerRegistry: 'V2_MAKER_REGISTRY',
  rewardsDistributor: 'V2_REWARDS_DISTRIBUTOR',
  accessManager: 'V2_ACCESS_MANAGER',
  feeSplitter: 'V2_FEE_SPLITTER',
  buybackExecutor: 'V2_BUYBACK_EXECUTOR',
};

/**
 * The keeper's pre-v8 spelling of the payout slot, still read so that an environment written against
 * `keeper/README.md`'s v7 table keeps working. It is a fallback, never an override: if both are set and they
 * disagree the boot refuses and names both, because silently preferring one of two spellings of one contract
 * is how a bot ends up pointed at a replaced address with nothing failing.
 */
export const PAYOUT_ENV_ALIAS = { name: 'payoutAdapter', env: 'V2_PAYOUT_ADAPTER' } as const satisfies {
  name: V2AddressName;
  env: string;
};

/**
 * The contracts each signing mode cannot run without. A later task that needs one more adds it here.
 * The cranker's autoRoller is deliberately absent: rolls are one of six steps, and a deployment
 * without the roller must still snapshot, settle and redeem (the step reports itself skipped).
 *
 * INTERFACE_VERSION 8 adds `accessManager` to mm and pricer, and NOT to the cranker, for reasons that are
 * not symmetric:
 *
 *   - Under `Managed` a target has no `hasRole` of its own, so the mm bot and the pricer read their own role
 *     from the manager (K8-03). Without the manager address the pricer does not fail — it falls through to
 *     `role-unread` and reprices nothing, for ever, while reporting healthy. A bot that cannot find out
 *     whether it is allowed to act must refuse to start rather than run blind, so the manager is REQUIRED.
 *   - The cranker's `feeSplitter` is deliberately absent, exactly like `autoRoller`: distribute and buyback
 *     are steps, the other five must keep running before the flywheel exists, and ops says so in the
 *     generated file it hands the operator — "With V2_FEE_SPLITTER empty the cranker runs every other step
 *     and skips these, which is what it does before the flywheel is deployed" (ops/v2/env/cranker.env:26-27,
 *     rendered by ops/v2-env.mjs). K8-02 skips the step; it does not fail the boot.
 *   - `buybackExecutor` is nobody's required address: the keeper never calls it. Only the splitter may, and
 *     the splitter holds its own pointer. The keeper resolves it so the cranker can report and compare it.
 */
export const MODE_CONTRACTS = {
  cranker: ['clearinghouse', 'orderBook', 'settlementOracle', 'expiryCalendar'],
  mm: ['clearinghouse', 'orderBook', 'makerVault', 'accessManager'],
  pricer: ['clearinghouse', 'orderBook', 'settlementOracle', 'autoRoller', 'expiryCalendar', 'accessManager'],
} as const satisfies Record<SigningMode, readonly V2AddressName[]>;

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

/** A `0` / `1` switch. */
const flagField = z.enum(['0', '1']).transform((raw) => raw === '1');

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
  V2_PAYOUT_ROUTER: addressField.optional(),
  /** Deprecated spelling of V2_PAYOUT_ROUTER; read, never preferred (PAYOUT_ENV_ALIAS). */
  V2_PAYOUT_ADAPTER: addressField.optional(),
  MAKER_VAULT: addressField.optional(),
  V2_MAKER_REGISTRY: addressField.optional(),
  V2_REWARDS_DISTRIBUTOR: addressField.optional(),
  /* ---- INTERFACE_VERSION 8; the ops spellings (see CONTRACT_ENV) ---- */
  V2_ACCESS_MANAGER: addressField.optional(),
  V2_FEE_SPLITTER: addressField.optional(),
  V2_BUYBACK_EXECUTOR: addressField.optional(),
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
  /* ---- the v8 flywheel step (K8-02, cranker/flywheel.ts) ---- */
  /** Claim, distribute and buy back. Default OFF: the flywheel is not deployed, and it spends protocol USDG. */
  CRANKER_FLYWHEEL_ENABLED: flagField.default('0'),
  /**
   * One flywheel pass at most this often. The floor is the compiled BUYBACK_COOLDOWN
   * (V2Constants.sol:63, 5 minutes): a shorter interval cannot buy back more often, it can only produce
   * cooldown skips. Distribution has no cooldown, so the default is an hour rather than the floor.
   */
  CRANKER_FLYWHEEL_INTERVAL_S: intField(300, 30 * 86_400).default(3_600),
  /**
   * How far below the probe's quote the buyback's `minTokenOut` is set, in bps. It covers drift between the
   * probe and inclusion, and nothing else — the route's real protections are on chain (the executor's
   * raise-never-lower v3 TWAP floor and its fee caps). 50 bps at a 5-minute cooldown and a 50 USDG launch cap:
   * wide enough that an ordinary block or two of drift does not waste the call, tight enough that the fill is
   * still bounded. NEVER 0: `minTokenOut == burned` exactly, and the smallest drift reverts TooLittleTokens.
   */
  CRANKER_BUYBACK_TOLERANCE_BPS: intField(1, 5_000).default(50),
  /**
   * Probe the buyback and report it, but never send it, while every other step runs live. NOT the process-wide
   * dry run (`ctx.sender.dryRun`, cranker/effects.ts), which stops the whole cranker sending: this is the one
   * switch that lets an operator watch the route for a few days before it is allowed to spend.
   */
  CRANKER_BUYBACK_DRY_RUN: flagField.default('0'),
};

const crankerSchema = z.object({
  ...commonFields,
  CRANKER_PK: privateKeyField,
  CRANKER_PORT: intField(0, 65_535).default(DEFAULT_MODE_PORT.cranker),
  INDEXER_URL: httpUrlField.optional(),
  ...crankerTuningFields,
});

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
  /**
   * Most series quoted at once, and per market (nearest the money first, then nearest expiry). UNSET, both are
   * DERIVED from the registry ladder of the quoted markets so that every listed series carries our quote
   * (T-OP-123, owner: "each option should have a pre-filled ask ... which is our MM bot's quote"); SET below that
   * ladder count, boot refuses and names the unquoted series -- a silent partial book was the failure. The old
   * literal defaults (40 / 10) covered ten of the fifty series a launch market lists.
   */
  MM_MAX_SERIES: intField(1, 5_000).optional(),
  MM_MAX_SERIES_PER_MARKET: intField(1, 1_000).optional(),
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
  /**
   * T-OP-133, the owner's model and therefore the DEFAULT: the vault's ask on a series is the FALLBACK, resting only
   * while no other maker's live ask (AskWrite or AskResale, protocol accounts included) rests there. 1: a series with
   * another asker halts `other-asker` on the ask side (a resting vault ask is cancelled, the ask returns at the next
   * tick once the book clears); bids are untouched. 0: today's always-quote.
   */
  MM_ASK_FALLBACK_ONLY: flagField.default('1'),
  /**
   * T-OP-133. The per-asset write POOL the asks are sized against, as bps of Clearinghouse.free(vault, asset).
   * 10_000 = today's exact budget (the advertised sum never exceeds free). Above it, every single ask still fits
   * `maxWriteUnits(free)` so any ONE fill is covered; several fills of different series in one tick can outrun the
   * pool, and the book then skips the uncoverable fill (never a revert). The launch runbook value is the owner's.
   */
  MM_WRITE_OVERSUBSCRIBE_BPS: intField(10_000, 1_000_000).default(10_000),
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
  /**
   * Seconds of lead before a House vault's epochEnd during which the plan opens no new risk.
   * Fed to planTick as MmPlanParams.epochWindDownS. 0 = only at/after epochEnd.
   */
  MM_EPOCH_WIND_DOWN_S: intField(0, 7 * 86_400).default(14_400),
  /**
   * Extra MakerVault / House vault addresses to quote in this process, comma-separated.
   * The treasury vault is always included from MAKER_VAULT. Empty = treasury only.
   * House factory enumeration needs IHouseVaultFactory in ops/abis/v2 (T-78); until then this list is the discovery path.
   */
  MM_VAULTS: z.string().optional().default(''),
  /**
   * HouseVaultFactory address (src/v2/periphery/house/HouseVaultFactory.sol). When set, the House
   * vaults are ENUMERATED from it through `vaults()` (:90) rather than listed by hand.
   * BLOCKED ON T-78: ops/abis/v2 publishes no HouseVaultFactory artifact, so gen-abis renders no
   * module for it and the keeper has no ABI to call it with. Until then a set factory is a
   * configured expectation the bot cannot meet, and it says so every tick (v2_mm_house_unavailable)
   * instead of quietly quoting nothing. See mm/house.ts.
   */
  MM_HOUSE_FACTORY: z.string().optional().default(''),
  /**
   * Per-vault overrides of the three bot caps, JSON keyed by vault address:
   *   {"0xVault":{"maxSeriesUnits":"100","maxTotalNotionalUsdg6":"50000000000","dailyLossLimitUsdg6":"2000000000"}}
   * Every field is optional and decimal; an omitted one falls back to the process-wide MM_* value.
   * This can only ever TIGHTEN: the result is still clamped at tick time to the vault's own on-chain
   * limit (quoter.ts capAtMost), and 0 keeps today's "the vault's limit alone" meaning.
   */
  MM_VAULT_CAPS: z.string().optional().default(''),
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
  /** 0: do not reprice outside ExpiryCalendar's regular session. */
  PRICER_REPRICE_OFF_HOURS: flagField.default('0'),
  /** Most reprice transactions sent in one tick. */
  PRICER_MAX_TX_PER_TICK: intField(1, 1_000).default(50),
  /** Timeout of one pricing-service or indexer request. */
  PRICER_HTTP_TIMEOUT_MS: intField(500, 120_000).default(5_000),
  /** Alert v2_pricer_fair_unavailable when a live smart-pricing ask has had no fair value this long. */
  PRICER_FAIR_ALERT_S: intField(60, 7 * 86_400).default(7_200),
  /** Refuse a /fair whose source observation (legacy asOf, or provenance quoteObservedAt) is older than this. */
  PRICER_FAIR_MAX_AGE_S: intField(1, 7 * 86_400).default(1_800),
  /** Refuse when /fair.spot and the oracle trySpot differ by more than this many bps of the oracle spot. 300 accepted, 301 refused. */
  PRICER_FAIR_SPOT_TOLERANCE_BPS: intField(0, 10_000).default(300),
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
export type ContractsWith<R extends V2AddressName> = { [K in V2AddressName]: K extends R ? Address : Address | null };

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
  contractSources: Record<V2AddressName, 'env' | 'registry' | null>;
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
  flywheelEnabled: boolean;
  flywheelIntervalS: number;
  buybackToleranceBps: number;
  buybackDryRun: boolean;
}

export interface CrankerConfig extends SigningModeBase<'cranker'> {
  indexerUrl: string | null;
  tuning: CrankerTuning;
}

/** The MM_* keys, parsed (see mmTuningFields for each one's meaning). */
/** How the two series caps were settled at boot, per quoted market (T-OP-123): what the ladder lists vs the cap. */
export interface MmSeriesCoverage {
  /** true: MM_MAX_SERIES / MM_MAX_SERIES_PER_MARKET were unset and derived from the registry ladder. */
  derived: boolean;
  /** Listed series per quoted market, from its resolved ladder (rungs x expiries ahead x sides, per tenor). */
  listedByMarket: Readonly<Record<string, number>>;
}

export interface MmTuning {
  /** Upper-case tickers, or null for every live v2 market. */
  markets: readonly string[] | null;
  maxSeries: number;
  maxSeriesPerMarket: number;
  seriesCoverage: MmSeriesCoverage;
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
  /** MM_ASK_FALLBACK_ONLY (T-OP-133). */
  askFallbackOnly: boolean;
  /** MM_WRITE_OVERSUBSCRIBE_BPS (T-OP-133); 10_000 = the exact budget. */
  writeOversubscribeBps: number;
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
  epochWindDownS: number;
  /** Extra vaults besides MAKER_VAULT, lower-cased, unique, order preserved from env. */
  extraVaults: readonly Address[];
  /** HouseVaultFactory if set; null when unset or not a 0x address. */
  houseFactory: Address | null;
  /** Per-vault cap overrides, keyed lower-case. Absent vault, or absent field, = the process-wide value. */
  vaultCaps: ReadonlyMap<string, VaultCapOverride>;
}

/** A vault's overrides of the three bot caps. Every field is optional; all of them only tighten. */
export interface VaultCapOverride {
  maxSeriesUnits?: bigint;
  maxTotalNotionalUsdg6?: bigint;
  dailyLossLimitUsdg6?: bigint;
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
  repriceOffHours: boolean;
  maxTxPerTick: number;
  httpTimeoutMs: number;
  fairAlertS: number;
  fairMaxAgeS: number;
  fairSpotToleranceBps: number;
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
/**
 * How many series a market's resolved ladder lists: for each tenor, `rungs` strikes on each of the first
 * `expiriesAhead` expiries, calls always and puts only when the market lists puts. This is the count of the
 * slots `cranker/planner.ts` `ladderSlots` builds (K2-03 step 1) times that tenor's rungs; the RESOLUTION of the
 * ladder (SPEC_DEFAULTS <- registry v2.defaults <- market overrides) is `registry.ts` `applyOverrides`, read here
 * from `market.v2.params` exactly as the cranker reads it -- nothing is re-resolved. Pure.
 */
export function ladderSeriesCount(params: Pick<MarketParams, 'ladder' | 'expiriesAhead'>, puts: boolean): number {
  const sides = puts ? 2 : 1;
  let n = 0;
  for (const tenor of TENORS) n += params.ladder[tenor].rungs * params.expiriesAhead[tenor] * sides;
  return n;
}

/** The markets the bot quotes, as `mm/quoter.ts` `quotedMarkets` picks them: MM_MARKETS (any status), else every live v2 market. */
function quotedMarketsOf(registry: V2Registry, tickers: readonly string[] | null): V2Market[] {
  if (tickers === null) return v2Markets(registry, ['live']);
  return v2Markets(registry, ['live', 'paused', 'planned']).filter((m) => tickers.includes(m.ticker));
}

/**
 * The two series caps, settled (T-OP-123). Unset: derived so the whole ladder of every quoted market is selectable
 * -- per market the largest listed count among them, in all their sum. Set below the ladder: one problem line per
 * market naming how many of its listed series the cap leaves unquoted, in the shape the MM_MARKETS typo refusal
 * uses, because a cap that trims the book silently is the failure the owner named. A registry with no quoted
 * market (the bot boots and idles) keeps a cap of 1 so the schema's floor holds.
 */
export function settleSeriesCaps(input: {
  registry: V2Registry;
  markets: readonly string[] | null;
  maxSeries: number | undefined;
  maxSeriesPerMarket: number | undefined;
}): { maxSeries: number; maxSeriesPerMarket: number; coverage: MmSeriesCoverage; problems: string[] } {
  const quoted = quotedMarketsOf(input.registry, input.markets);
  const listedByMarket: Record<string, number> = {};
  for (const m of quoted) listedByMarket[m.ticker] = ladderSeriesCount(m.v2.params, m.v2.puts);
  const counts = Object.values(listedByMarket);
  const largest = counts.length === 0 ? 1 : Math.max(1, ...counts);
  const total = counts.length === 0 ? 1 : Math.max(1, counts.reduce((a, b) => a + b, 0));
  const problems: string[] = [];
  const perMarket = input.maxSeriesPerMarket ?? largest;
  const overall = input.maxSeries ?? total;
  if (input.maxSeriesPerMarket !== undefined) {
    for (const [ticker, listed] of Object.entries(listedByMarket)) {
      if (input.maxSeriesPerMarket < listed) {
        problems.push(`MM_MAX_SERIES_PER_MARKET=${input.maxSeriesPerMarket} leaves ${listed - input.maxSeriesPerMarket} of ${ticker}'s ${listed} listed series unquoted; unset it to derive ${largest} from the registry ladder, or set it to at least ${listed}`);
      }
    }
  }
  if (input.maxSeries !== undefined && input.maxSeries < total) {
    problems.push(`MM_MAX_SERIES=${input.maxSeries} leaves ${total - input.maxSeries} of the ${total} series listed across ${quoted.map((m) => m.ticker).join(', ') || 'the quoted markets'} unquoted; unset it to derive ${total} from the registry ladder, or set it to at least ${total}`);
  }
  return {
    maxSeries: overall,
    maxSeriesPerMarket: perMarket,
    coverage: { derived: input.maxSeries === undefined && input.maxSeriesPerMarket === undefined, listedByMarket },
    problems,
  };
}

export function parseTickerList(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim().toUpperCase()).filter((t) => t !== ''))];
}

/** Comma-separated 0x addresses, checksummed, unique, first-seen order. */
export function parseAddressList(raw: string): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t === '') continue;
    if (!isAddress(t, { strict: false })) throw new V2ConfigError(`not an address: ${t}`);
    const a = getAddress(t);
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}

const CAP_FIELDS = ['maxSeriesUnits', 'maxTotalNotionalUsdg6', 'dailyLossLimitUsdg6'] as const;

/**
 * MM_VAULT_CAPS. Refuses an unknown field rather than ignoring it: a typo in a cap key is a cap that
 * silently did not apply, which is the failure mode this whole task exists to remove.
 */
export function parseVaultCaps(raw: string): Map<string, VaultCapOverride> {
  const out = new Map<string, VaultCapOverride>();
  const trimmed = raw.trim();
  if (trimmed === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new V2ConfigError('MM_VAULT_CAPS is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new V2ConfigError('MM_VAULT_CAPS must be a JSON object keyed by vault address');
  }
  for (const [addr, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isAddress(addr, { strict: false })) throw new V2ConfigError(`MM_VAULT_CAPS: not an address: ${addr}`);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new V2ConfigError(`MM_VAULT_CAPS: ${addr} must map to an object`);
    }
    const row: VaultCapOverride = {};
    for (const [field, amount] of Object.entries(value as Record<string, unknown>)) {
      if (!(CAP_FIELDS as readonly string[]).includes(field)) {
        throw new V2ConfigError(`MM_VAULT_CAPS: ${addr}: unknown cap ${field} (expected ${CAP_FIELDS.join(', ')})`);
      }
      if (typeof amount !== 'string' && typeof amount !== 'number') {
        throw new V2ConfigError(`MM_VAULT_CAPS: ${addr}.${field} must be a decimal string or number`);
      }
      let v: bigint;
      try {
        v = BigInt(amount);
      } catch {
        throw new V2ConfigError(`MM_VAULT_CAPS: ${addr}.${field} is not an integer: ${String(amount)}`);
      }
      if (v < 0n) throw new V2ConfigError(`MM_VAULT_CAPS: ${addr}.${field} must not be negative`);
      row[field as (typeof CAP_FIELDS)[number]] = v;
    }
    out.set(addr.toLowerCase(), row);
  }
  return out;
}

export function parseOptionalAddress(raw: string): Address | null {
  const t = raw.trim();
  if (t === '') return null;
  if (!isAddress(t, { strict: false })) throw new V2ConfigError(`not an address: ${t}`);
  return getAddress(t);
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

  const parseAddress = (raw: string | undefined): Address | null =>
    raw !== undefined && isAddress(raw, { strict: false }) ? getAddress(raw) : null;
  // The deprecated payout spelling is a FALLBACK, never an override, and a disagreement is refused rather
  // than resolved: two spellings of one contract that quietly pick a winner is how a bot ends up pointed at
  // a replaced address with nothing failing.
  const payoutRouter = parseAddress(cleaned[CONTRACT_ENV[PAYOUT_ENV_ALIAS.name]]);
  const payoutAlias = parseAddress(cleaned[PAYOUT_ENV_ALIAS.env]);
  if (payoutRouter !== null && payoutAlias !== null && payoutRouter !== payoutAlias) {
    lines.push(
      `${PAYOUT_ENV_ALIAS.env}: ${payoutAlias} disagrees with ${CONTRACT_ENV[PAYOUT_ENV_ALIAS.name]} ${payoutRouter}; ` +
        `they are two spellings of the same contract (v2.contracts.${PAYOUT_ENV_ALIAS.name}). ` +
        `${CONTRACT_ENV[PAYOUT_ENV_ALIAS.name]} is the v8 name ops renders — unset ${PAYOUT_ENV_ALIAS.env}.`,
    );
  }
  // Deliberately NOT a problem when it is the only spelling present: `lines` is fatal here, and refusing a
  // boot over the NAME of an address that is otherwise correct would break a working deployment for a rename
  // that is ours, not the operator's. The deprecation is recorded in CONTRACT_ENV's comment and in
  // keeper/README.md instead; the disagreement above is the case that is genuinely a misconfiguration.
  const envAddress = (name: V2AddressName): Address | null => {
    const explicit = parseAddress(cleaned[CONTRACT_ENV[name]]);
    if (name === PAYOUT_ENV_ALIAS.name) return explicit ?? payoutAlias;
    return explicit;
  };
  /** True when SOMETHING named this address in the environment, however it was spelled. */
  const envNamed = (name: V2AddressName): boolean =>
    cleaned[CONTRACT_ENV[name]] !== undefined || (name === PAYOUT_ENV_ALIAS.name && cleaned[PAYOUT_ENV_ALIAS.env] !== undefined);
  const contracts = {} as Record<V2AddressName, Address | null>;
  const contractSources = {} as Record<V2AddressName, 'env' | 'registry' | null>;
  // An explicit address wins over the registry's, which is what a devnet and a registry with no v2
  // block need. But when BOTH name an address and they differ, the environment is almost always
  // stale: the image carries the release's registry (ops/deploy.md §15.2), so a redeployed contract
  // reaches the bot as a rebuild, while a Railway variable set at the last release survives it and
  // silently keeps the bot pointed at the replaced contract. That is refused; V2_CONTRACTS_FROM_ENV=1
  // takes the environment on purpose (an override before the registry is rebuilt).
  const envOverrideAllowed = cleaned.V2_CONTRACTS_FROM_ENV === '1';
  // Driven by V2_ADDRESS_NAMES, not by the keys of CONTRACT_ENV: the name list is the canonical set, and a
  // name that reached one and not the other would land here as `undefined` rather than `null` and read as
  // "present" to every `=== null` check downstream.
  for (const name of V2_ADDRESS_NAMES) {
    const fromEnv = envAddress(name);
    const fromRegistry = registry === null ? null : v2Address(registry, name);
    contracts[name] = fromEnv ?? fromRegistry;
    contractSources[name] = fromEnv !== null ? 'env' : fromRegistry !== null ? 'registry' : null;
    if (fromEnv !== null && fromRegistry !== null && fromEnv !== fromRegistry && !envOverrideAllowed) {
      lines.push(
        `${CONTRACT_ENV[name]}: ${fromEnv} disagrees with ${V2_ADDRESS_PATH[name]} ${fromRegistry} in ${registryPath}; ` +
          'the registry in the image is the release. Unset the variable, or set V2_CONTRACTS_FROM_ENV=1 to use the environment on purpose.',
      );
    }
  }
  if (registry !== null) {
    for (const name of MODE_CONTRACTS[mode]) {
      // An env var that failed to parse is already listed; do not also call it missing.
      if (contracts[name] === null && !envNamed(name)) {
        lines.push(
          `${CONTRACT_ENV[name]}: V2_MODE=${mode} needs the ${name} address; set ${CONTRACT_ENV[name]} or ${V2_ADDRESS_PATH[name]} in ${registryPath}` +
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
  // The series caps against the ladder (T-OP-123): a cap set below what a quoted market lists is refused here, by
  // count, for the same reason as the MM_MARKETS typo above -- a partial book with no error is the silent failure.
  // Read from the cleaned environment through the two cap fields alone, so the ladder check joins the one list
  // even when another key is malformed (a malformed cap is reported by the main parse, and skipped here).
  let seriesCaps: ReturnType<typeof settleSeriesCaps> | null = null;
  if (mode === 'mm' && registry !== null) {
    const caps = z.object({ MM_MAX_SERIES: mmTuningFields.MM_MAX_SERIES, MM_MAX_SERIES_PER_MARKET: mmTuningFields.MM_MAX_SERIES_PER_MARKET }).safeParse(cleaned);
    const known = cleaned.MM_MARKETS === undefined || parseTickerList(cleaned.MM_MARKETS).every((t) => registry!.markets.some((m) => m.ticker === t && m.v2 !== null));
    if (caps.success && known) {
      seriesCaps = settleSeriesCaps({
        registry,
        markets: cleaned.MM_MARKETS === undefined ? null : parseTickerList(cleaned.MM_MARKETS),
        maxSeries: caps.data.MM_MAX_SERIES,
        maxSeriesPerMarket: caps.data.MM_MAX_SERIES_PER_MARKET,
      });
      lines.push(...seriesCaps.problems);
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
        flywheelEnabled: c.CRANKER_FLYWHEEL_ENABLED,
        flywheelIntervalS: c.CRANKER_FLYWHEEL_INTERVAL_S,
        buybackToleranceBps: c.CRANKER_BUYBACK_TOLERANCE_BPS,
        buybackDryRun: c.CRANKER_BUYBACK_DRY_RUN,
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
        // settled above, against the registry ladder; seriesCaps is non-null on every path that reaches here
        maxSeries: seriesCaps!.maxSeries,
        maxSeriesPerMarket: seriesCaps!.maxSeriesPerMarket,
        seriesCoverage: seriesCaps!.coverage,
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
        askFallbackOnly: c.MM_ASK_FALLBACK_ONLY,
        writeOversubscribeBps: c.MM_WRITE_OVERSUBSCRIBE_BPS,
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
        epochWindDownS: c.MM_EPOCH_WIND_DOWN_S,
        extraVaults: parseAddressList(c.MM_VAULTS),
        houseFactory: parseOptionalAddress(c.MM_HOUSE_FACTORY),
        vaultCaps: parseVaultCaps(c.MM_VAULT_CAPS),
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
      repriceOffHours: c.PRICER_REPRICE_OFF_HOURS,
      maxTxPerTick: c.PRICER_MAX_TX_PER_TICK,
      httpTimeoutMs: c.PRICER_HTTP_TIMEOUT_MS,
      fairAlertS: c.PRICER_FAIR_ALERT_S,
      fairMaxAgeS: c.PRICER_FAIR_MAX_AGE_S,
      fairSpotToleranceBps: c.PRICER_FAIR_SPOT_TOLERANCE_BPS,
      logChunkBlocks: c.PRICER_LOG_CHUNK_BLOCKS,
      logChunksPerTick: c.PRICER_LOG_CHUNKS_PER_TICK,
    },
  };
}
