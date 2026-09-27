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
 *   cranker  CRANKER_PK, CRANKER_PORT (8792), INDEXER_URL optional (falls back to log scans).
 *            Contracts: clearinghouse, orderBook, settlementOracle, expiryCalendar. autoRoller is
 *            OPTIONAL: without it the rolls step is skipped (a deployment, or a devnet, whose
 *            periphery is not wired yet still settles). CRANKER_* tuning below (crankerSchema).
 *   mm       MM_QUOTER_PK, MM_PORT (8793), PRICING_URL, MM_KILL_TOKEN; INDEXER_URL accepted, unused.
 *            Contracts: clearinghouse, orderBook, makerVault (MAKER_VAULT). MM_* quoting and risk
 *            settings below (mmTuningFields).
 *   pricer   PRICER_PK, PRICER_PORT (8794), PRICING_URL, INDEXER_URL optional (falls back to
 *            its own StrategySet scan). Contracts: clearinghouse, orderBook, settlementOracle,
 *            autoRoller, expiryCalendar. PRICER_* tuning below (pricerSchema).
 *   guardian GUARDIAN_PK, GUARDIAN_PORT (8795). Contracts: clearinghouse, settlementOracle, accessManager (the boot check
 *            refuses a key that is not an immediate GUARDIAN on the oracle). GUARDIAN_* below (guardianSchema).
 *            pages every uncorroborated settlement candidate, vetoes a scale fault.
 *   pricing  holds no key and sends nothing: pricing/main.ts's own loader (PRICING_PORT 8790,
 *            V2_REGISTRY_PATH, RH_RPC, RH_RPC_2, KEEPER_LOG_LEVEL) is the whole schema.
 * The ports are this file's choice (only CRANKER_PORT was specified): 8787 is the v1 keeper, 8790 the
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
  type V2House,
  type V2Market,
  type V2Registry,
} from './registry.js';

export { V2_MODES, type SigningMode, type V2Mode } from './mode.js';

/** The keeper package directory: src/v2/ and dist/v2/ are both two levels in. */
export const KEEPER_PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_REGISTRY_PATH = '../ops/markets/tier1.json';

/**
 * Where each address's explicit value is read from. `MAKER_VAULT` is the specified env name.
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
 * the v7 environment table keeps working. It is a fallback, never an override: if both are set and they
 * disagree the boot refuses and names both, because silently preferring one of two spellings of one contract
 * is how a bot ends up pointed at a replaced address with nothing failing.
 */
export const PAYOUT_ENV_ALIAS = { name: 'payoutAdapter', env: 'V2_PAYOUT_ADAPTER' } as const satisfies {
  name: V2AddressName;
  env: string;
};

/**
 * The contracts each signing mode cannot run without. A mode that later needs one more adds it here.
 * The cranker's autoRoller is deliberately absent: rolls are one of six steps, and a deployment
 * without the roller must still snapshot, settle and redeem (the step reports itself skipped).
 *
 * INTERFACE_VERSION 8 adds `accessManager` to mm and pricer, and NOT to the cranker, for reasons that are
 * not symmetric:
 *
 *   - Under `Managed` a target has no `hasRole` of its own, so the mm bot and the pricer read their own role
 *     from the manager. Without the manager address the pricer does not fail — it falls through to
 *     `role-unread` and reprices nothing, for ever, while reporting healthy. A bot that cannot find out
 *     whether it is allowed to act must refuse to start rather than run blind, so the manager is REQUIRED.
 *   - The cranker's `feeSplitter` is deliberately absent, exactly like `autoRoller`: distribute and buyback
 *     are steps, the other five must keep running before the flywheel exists, and ops says so in the
 *     generated file it hands the operator — "With V2_FEE_SPLITTER empty the cranker runs every other step
 *     and skips these, which is what it does before the flywheel is deployed" (ops/v2/env/cranker.env:26-27,
 *     rendered by ops/v2-env.mjs). The cranker skips the step; it does not fail the boot.
 *   - `buybackExecutor` is nobody's required address: the keeper never calls it. Only the splitter may, and
 *     the splitter holds its own pointer. The keeper resolves it so the cranker can report and compare it.
 */
export const MODE_CONTRACTS = {
  cranker: ['clearinghouse', 'orderBook', 'settlementOracle', 'expiryCalendar'],
  mm: ['clearinghouse', 'orderBook', 'makerVault', 'accessManager'],
  pricer: ['clearinghouse', 'orderBook', 'settlementOracle', 'autoRoller', 'expiryCalendar', 'accessManager'],
  // The manager is required for the same reason as mm and pricer: the boot check asks it whether this key
  // may veto, and a guardian that cannot find out must refuse to start rather than page with nothing behind it. The
  // clearinghouse is what runtime.ts's boot wiring check reads for every signing mode (calendar, usdg).
  guardian: ['clearinghouse', 'settlementOracle', 'accessManager'],
} as const satisfies Record<SigningMode, readonly V2AddressName[]>;

export const MODE_KEY_ENV = { cranker: 'CRANKER_PK', mm: 'MM_QUOTER_PK', pricer: 'PRICER_PK', guardian: 'GUARDIAN_PK' } as const satisfies Record<SigningMode, string>;
export const MODE_PORT_ENV = { cranker: 'CRANKER_PORT', mm: 'MM_PORT', pricer: 'PRICER_PORT', guardian: 'GUARDIAN_PORT' } as const satisfies Record<SigningMode, string>;
export const DEFAULT_MODE_PORT = { cranker: 8792, mm: 8793, pricer: 8794, guardian: 8795 } as const satisfies Record<SigningMode, number>;

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

/**
 * How the vaults of one House factory say which epoch kind they run (the daily
 * House vault design in callhouse-contracts).
 *
 *   legacy-weekly  a factory compiled BEFORE kinding (the launch factory that lists the live NVDA/SPCX vaults).
 *                  Its vaults have NO `weekly()` getter -- the call reverts with empty data, measured on chain 4663
 *                  against both live vaults -- and are weekly by construction. `weekly()` is never called on them.
 *   kinded         a kinded factory. Each vault's kind is read from its immutable `weekly()`.
 *   unknown        an entry written without a tag. The bot cannot know which rule applies, so its vaults are NOT
 *                  quoted and the gap is paged every tick (v2_mm_house_unavailable). This is deliberate: the one
 *                  wrong guess that fails OPEN is calling a legacy factory "kinded" or vice versa, and the cost of
 *                  asking the operator to write six characters is lower than either.
 */
export type HouseFactoryKind = 'legacy-weekly' | 'kinded' | 'unknown';
export interface HouseFactoryEntry {
  address: Address;
  kind: HouseFactoryKind;
}
const HOUSE_FACTORY_TAGS: readonly HouseFactoryKind[] = ['legacy-weekly', 'kinded'];

/**
 * `0xFactory:legacy-weekly,0xFactory:kinded` -> entries, checksummed, in env order. A bare address is `unknown`
 * (above). A malformed address, an unrecognised tag or a duplicate factory is refused: each would otherwise turn a
 * typo into a House vault that is silently not quoted, or quoted under the wrong rule.
 */
export function parseHouseFactories(raw: string): HouseFactoryEntry[] {
  const out: HouseFactoryEntry[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t === '') continue;
    const [addrRaw = '', tagRaw, ...extra] = t.split(':').map((x) => x.trim());
    if (!isAddress(addrRaw, { strict: false })) throw new V2ConfigError(`not a 20-byte hex address: ${addrRaw}`);
    if (extra.length > 0) throw new V2ConfigError(`"${t}" has more than one ":" tag`);
    let kind: HouseFactoryKind = 'unknown';
    if (tagRaw !== undefined) {
      if (!(HOUSE_FACTORY_TAGS as readonly string[]).includes(tagRaw)) {
        throw new V2ConfigError(`unknown House factory tag "${tagRaw}" on ${addrRaw}: use :legacy-weekly or :kinded`);
      }
      kind = tagRaw as HouseFactoryKind;
    }
    const address = getAddress(addrRaw);
    if (seen.has(address.toLowerCase())) throw new V2ConfigError(`House factory ${address} is listed twice`);
    seen.add(address.toLowerCase());
    out.push({ address, kind });
  }
  return out;
}

/**
 * The House factories the registry records, as the bots' tagged list, so rolling and quoting a House vault
 * needs no environment variable.
 *
 *   `v2.house.factories`   weekly -> legacy-weekly (the launch factory, compiled before kinding: its vaults
 *                                     have no `weekly()` getter), daily -> kinded (`weekly()` is read).
 *   list ABSENT                       `v2.contracts.houseVaultFactory`, tagged legacy-weekly: before the registry had the
 *                                     list, that key was the one place the launch factory was recorded.
 *   neither                           empty.
 *
 * The registry's word for a factory is its KIND, and the kind fixes the tag: this never tags a v8 (weekly) launch
 * factory `kinded`, which would call `weekly()` on vaults that revert on it. A v9 launch factory is recorded
 * as the `daily` entry (registry.ts launchFactoryKind), so it is tagged `kinded`, correctly: it is a kinded
 * factory and its vaults have `weekly()`. Pure; the order is the registry's.
 */
export function houseFactoriesFromRegistry(house: V2House): HouseFactoryEntry[] {
  if (house.factories !== null) {
    return house.factories.map((f) => ({ address: f.address, kind: f.kind === 'weekly' ? 'legacy-weekly' : 'kinded' }));
  }
  return house.launchFactory === null ? [] : [{ address: house.launchFactory, kind: 'legacy-weekly' }];
}

/**
 * A registry that names House vaults but yields no factory to find them through: the one configuration that
 * used to fail SILENTLY (the house step rolled nothing and the MM bot quoted no House vault). Now a boot problem,
 * listed under `envKey`, the variable that would also fix it. null when there is nothing to report.
 *
 * Checked first: a `v2.house.factories` list that is present but leaves out the launch factory
 * (`v2.contracts.houseVaultFactory`). houseFactoriesFromRegistry returns the list as written, so the launch factory
 * was dropped without a word, and with an empty list the message below called that factory "unset". Refused rather
 * than added, because the list entry is the only record of its kind: tagged legacy-weekly on v9 the MM reads every
 * daily vault as weekly (the fail-OPEN case HouseFactoryKind warns about), tagged kinded on v8 it calls a `weekly()`
 * that reverts. Refused whether or not a market names a House vault yet: the launch factory's vaults are rolled from
 * the factory, so a registry that has not recorded them still has them on chain.
 */
export function houseFactoryBootProblem(house: V2House, envKey: 'CRANKER_HOUSE_FACTORY' | 'MM_HOUSE_FACTORY', registryPath: string): string | null {
  const launch = house.launchFactory;
  if (house.factories !== null && launch !== null && !house.factories.some((f) => f.address.toLowerCase() === launch.toLowerCase())) {
    const listed = house.factories.length === 0 ? 'is empty' : `lists only ${house.factories.map((f) => `${f.kind} ${f.address}`).join(', ')}`;
    return (
      `${envKey}: house-launch-factory-unlisted: the registry at ${registryPath} records the launch House factory ` +
      `v2.contracts.houseVaultFactory ${launch}, but v2.house.factories ${listed}, so its kind (weekly on v8, daily on v9) ` +
      `is unknown and none of its House vaults would roll or be quoted. Record it in v2.house.factories ` +
      `(ops/markets/write-back-v8.mjs --house-deployment), or set ${envKey}`
    );
  }
  if (house.vaults.length === 0 || houseFactoriesFromRegistry(house).length > 0) return null;
  const vaults = house.vaults.map((v) => `${v.ticker} ${v.kind} ${v.address}`).join(', ');
  return (
    `${envKey}: house-factory-missing: the registry at ${registryPath} records House vaults (${vaults}) but no House factory ` +
    `(${house.factories === null ? 'no v2.house.factories list' : 'v2.house.factories is empty'} and v2.contracts.houseVaultFactory is unset), ` +
    `so no House vault would roll or be quoted. Record the factory in the registry, or set ${envKey}`
  );
}

const houseFactoriesField = z.string().transform((raw, ctx): HouseFactoryEntry[] => {
  try {
    return parseHouseFactories(raw);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    return z.NEVER;
  }
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
/** A finite decimal in [min, max] (the vol points, delta band, gamma limit). */
const numField = (min: number, max: number) => z.coerce.number().finite().min(min).max(max);

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
  /**
   * Every fixed gas limit this process sends with (the cranker's GAS table and computed
   * budgets, the MM bot's MM_GAS, the pricer's and the guardian's) is simulated and sent at this percent of itself,
   * rounded up and capped at 30,000,000 (tx.ts scaleGas, GAS_SCALE_CAP). 100 = the limits as written. A tool for the
   * owner when a contract has grown past a budget: raise it, restart the service, then fix the budget in code. Bounds
   * are tx.ts GAS_SCALE_PCT_MIN..MAX (config.test.ts pins them equal); a value outside is refused by name at boot.
   */
  CRANKER_GAS_SCALE_PCT: intField(100, 300).default(100),
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
 * The cranker's tuning. Every key has a default that is right for chain 4663; ops/v2-env.mjs
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
  /* ---- the firstmint step (cranker/firstmint.ts) ---- */
  /**
   * The operator's off switch for the firstmint step ONLY; every other step keeps running. Default ON.
   * Turn it off while a setMarket, setFeed or setPool repair is scheduled, and back on once it has executed: a first
   * mint pins the expiry to the configuration it finds, so one sent between the halves of a repair pins a half-applied
   * configuration.
   */
  CRANKER_FIRSTMINT_ENABLED: flagField.default('1'),
  /* ---- the v8 flywheel step (cranker/flywheel.ts) ---- */
  /**
   * Claim, distribute and buy back. Default OFF, because it spends protocol USDG: a service must be told.
   * ops/v2-env.mjs renders it ON (=1) in cranker.env whenever the registry records v2.flywheel.feeSplitter, and a
   * cranker that has V2_FEE_SPLITTER set with this off pages v2_cranker_flywheel_disabled every tick instead of
   * skipping silently (cranker/flywheel.ts).
   */
  CRANKER_FLYWHEEL_ENABLED: flagField.default('0'),
  /**
   * One flywheel pass at most this often. The floor is the launch buyback cooldown, 5 minutes
   * (V2Constants.BUYBACK_COOLDOWN, the initial FeeSplitter.buybackCooldown(); ADMIN-settable, and
   * the flywheel step reads it live): a shorter interval cannot buy back more often, it can only produce
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
   * switch that lets an operator watch the route for a few days before it is allowed to spend. While it is
   * on, every buyback it withholds pages v2_cranker_buyback_dry_run (warn), so a watch left running does not look
   * like a quiet reserve.
   */
  CRANKER_BUYBACK_DRY_RUN: flagField.default('0'),
  /* ---- the house step (cranker/steps.ts stepHouse) ---- */
  /**
   * HouseVaultFactories whose vaults the `house` step rolls (`HouseVault.rollEpoch`, permissionless), comma-separated
   * in the MM_HOUSE_FACTORY syntax (`0x..:legacy-weekly,0x..:kinded`). The roll is the same for both epoch kinds and
   * never reads `weekly()`, so every listed factory is rolled whatever its tag. An OVERRIDE: unset,
   * the list comes from MM_HOUSE_FACTORY, else from the registry (houseFactoriesFromRegistry), and a registry that
   * records House vaults but no factory refuses to boot. Wins over MM_HOUSE_FACTORY.
   */
  CRANKER_HOUSE_FACTORY: houseFactoriesField.optional(),
  /**
   * The MM bot's spelling of the same list, read here only as the fallback when CRANKER_HOUSE_FACTORY is unset,
   * so one value set on both services is enough. Validated like any address: a bad value refuses to start rather
   * than silently turning the step off.
   */
  MM_HOUSE_FACTORY: houseFactoriesField.optional(),
  /* ---- EarnVault queue (earn/queue.ts, run by the `house` step) ---- */
  /**
   * The EarnVault whose withdrawal queue the cranker pays: `processQueue` is permissionless, so once a series the
   * vault wrote or held settles, queued withdrawals are served with no user action. ops/v2-env.mjs renders it
   * from `v2.contracts.earnVault`. Unset: the cranker reads nothing about Earn and sends nothing.
   */
  V2_EARN_VAULT: addressField.optional(),
  /** Queue entries per processQueue call. */
  EARN_QUEUE_BATCH: intField(1, 200).default(20),
  /** processQueue calls per tick at most; the loop also stops when a call serves nothing (the vault is short). */
  EARN_QUEUE_CALLS_PER_TICK: intField(1, 50).default(5),
  /** `EarnVault.skim()` (permissionless) at most this often; it pays 0 while skimBps is 0 and takes nothing while a queue is open. */
  EARN_SKIM_INTERVAL_S: intField(3_600, 30 * 86_400).default(86_400),
};

const crankerSchema = z.object({
  ...commonFields,
  CRANKER_PK: privateKeyField,
  CRANKER_PORT: intField(0, 65_535).default(DEFAULT_MODE_PORT.cranker),
  INDEXER_URL: httpUrlField.optional(),
  ...crankerTuningFields,
});

/**
 * The MM bot's quoting, risk and kill-switch settings (mm/engine.ts and mm/risk.ts use them).
 * Prices are USDG base units (6 dp) PER WHOLE SHARE, sizes 0.01-share units, rates bps. Every key but
 * MM_KILL_TOKEN has a default; ops/v2-env.mjs lists them as comments in the mm-bot env file.
 */
/**
 * MM_OPEN_GRACE_S's default: the market maker does nothing for the first 30 minutes of a regular session (the default
 * was 900). The halt pulls every resting bid, ask and resale too (engine.haltBeforeFair).
 */
export const MM_OPEN_GRACE_DEFAULT_S = 1_800;

const mmTuningFields = {
  /** Bearer token of POST /kill and POST /resume. A secret: never echoed, compared in constant time. */
  MM_KILL_TOKEN: z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32); the value is not shown'),
  /** Comma-separated tickers to quote; unset = every live v2 market in the registry. */
  MM_MARKETS: z.string().optional(),
  /**
   * Most series quoted at once, and per market (nearest the money first, then nearest expiry). UNSET, both are
   * DERIVED from the registry ladder of the quoted markets so that every listed series carries our quote
   * SET below that
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
  /**
   * Every quote of a series is pulled this many minutes before its mint cutoff (expiry − 30 min). The shipped mm-bot env
   * sets 60: 14:30 New York for a 16:00 expiry, the same instant as the default write stop below.
   */
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
   * the intended model and therefore the DEFAULT: the vault's ask on a series is the FALLBACK, resting only
   * while no other maker's live ask (AskWrite or AskResale, protocol accounts included) rests there. 1: a series with
   * another asker halts `other-asker` on the ask side (a resting vault ask is cancelled, the ask returns at the next
   * tick once the book clears); bids are untouched. 0: today's always-quote.
   */
  MM_ASK_FALLBACK_ONLY: flagField.default('1'),
  /**
   * The per-asset write POOL the asks are sized against, as bps of Clearinghouse.free(vault, asset).
   * 10_000 = today's exact budget (the advertised sum never exceeds free). Above it, every single ask still fits
   * `maxWriteUnits(free)` so any ONE fill is covered; several fills of different series in one tick can outrun the
   * pool, and the book then skips the uncoverable fill (never a revert). The launch runbook sets the value.
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
   * A vault's ROUTINE sends
   * (places, price and size requotes, refreshes before validUntil, syncs, closes, redeems, claims, deposits) go out at
   * most once per this many seconds of head time. The bot still READS every POLL_INTERVAL_MS, and a PROTECTIVE action
   * goes out on the read that finds it, whatever this says: a halt's cancels (spot breaker, event and quality halts, the
   * kill, the pull, the open grace), a bid over its caps or an ask under its floors, and a quote above its size target
   * (mm/engine.ts planSeriesActions `protective`). 0 = every read may send (the earlier cadence).
   */
  MM_SEND_INTERVAL_S: intField(0, 3_600).default(0),
  /**
   * How long after the plan a replace can take to land: no `replace` is sent for a live quote with less life
   * left than this (OrderBook.replace reverts OrderNotLive past validUntil; the quote is cancelled and placed fresh
   * instead). A CONFIRM bound, deliberately not KEEPER_TX_TIMEOUT_MS: that is when a send is given up on, and
   * POLL_INTERVAL_MS + KEEPER_TX_TIMEOUT_MS (195 s at the P11 env) was above the 180 s quote life, so no replace was
   * ever sent. Refused at boot when at or above MM_MAX_QUOTE_LIFETIME_S (replaceMarginOf).
   */
  MM_REPLACE_CONFIRM_S: intField(1, 3_600).default(60),
  /**
   * The pricing service's spot (in /fair) may differ from the series oracle's by at most this, bps; beyond it the series
   * halts fair-spot-mismatch, inside it the fair value is carried to the oracle's spot along its delta. Both read the same
   * Chainlink feed, so a gap is a lagging read. 0: unchecked.
   *
   * It is ALSO P7's corroboration band (mm/reads.ts readSpotClocks): a pool reading within it refreshes an old print, so
   * it may not exceed MM_SPOT_LAG_BPS, the move the spot-lag floor prices (refused at boot when both are non-zero).
   * Default 50 = MM_SPOT_LAG_BPS's default and the shipped mm-bot.env; it was 300, which broke
   * that relation for a bot started without the rendered env.
   */
  MM_FAIR_SPOT_TOLERANCE_BPS: intField(0, 10_000).default(50),
  /*
   * the market-safety halts (mm/engine.ts marketSafetyHalt, SpotMoveBreaker). Every guard is ON by
   * default; 0 is the explicit, documented opt-out of that one guard, never a default. A halted market's resting orders,
   * asks included, are cancelled on the tick it halts.
   */
  /**
   * P7. In a regular session, refuse a market whose oracle print (trySpot updatedAt) is older than this, corroborated by
   * the pool or not. The print is the Chainlink push feed's (0.5 % deviation / 24 h heartbeat), so on a quiet session
   * this halts until the next print: that is the rule, not a tuning accident.
   */
  MM_MAX_SPOT_AGE_S: intField(0, 7 * 86_400).default(120),
  /**
   * P8. No quotes until BOTH an in-session oracle print today exists AND the session has been open this long ("whichever
   * is later"). The in-session-print test mirrors AutoRoller.sol ROLL_OPEN_GRACE. Default {MM_OPEN_GRACE_DEFAULT_S}:
   * no market-maker quotes in the first 30 minutes of the open.
   */
  MM_OPEN_GRACE_S: intField(0, 6 * 3_600).default(MM_OPEN_GRACE_DEFAULT_S),
  /** P15. A market whose spot moves more than MM_BREAKER_BPS inside MM_BREAKER_WINDOW_S halts for MM_BREAKER_HALT_S. */
  MM_BREAKER_BPS: intField(0, 10_000).default(150),
  MM_BREAKER_WINDOW_S: intField(1, 86_400).default(300),
  MM_BREAKER_HALT_S: intField(1, 86_400).default(900),
  /*
   * the safest-ask SHAPING and RISK knobs (mm/engine.ts SAFEST_ASK_DEFAULTS, whose values these
   * defaults equal -- config.test.ts pins it). Every rule only RAISES an ask or REFUSES a side; none can lower an ask.
   * Every guard is ON by default; 0 is the explicit opt-out where one is offered. The numbers are starting
   * points for 0DTE, not measured optima.
   */
  /** P3 fallback: vol points (1 = 0.01 of vol) the ask is marked up by, as vega × points / 100, when /fair has no askIv. */
  MM_VOL_MARKUP_PTS: numField(0, 100).default(2),
  /** P4: the ask target is at least intrinsic value at the oracle spot + this many bps of that spot. */
  MM_INTRINSIC_BUFFER_BPS: intField(0, 10_000).default(5),
  /** P5: the ask target is at least this, USDG base units per share, independent of the fair value. 0 = off. */
  MM_MIN_PREMIUM_USDG6: bigintField.default('20000'),
  /** P13: Σ notional of the series of ONE expiry, USDG base units (bot-side; the vault has no such limit). 0 = off. */
  MM_MAX_EXPIRY_NOTIONAL_USDG6: bigintField.default('100000000000'),
  /** P14: a side that would take a market's |net delta| past this many shares is not quoted. 0 = off. */
  MM_MAX_DELTA_SHARES: numField(0, 100_000_000).default(100),
  /** P14: likewise for |net gamma| (share-delta per USD of spot). 0 = off. */
  MM_MAX_GAMMA: numField(0, 100_000_000).default(20),
  /** P16: selection ranks series by estimated |delta| distance from [LO, HI] at MM_SELECT_VOL. HI 0 = nearest the money. */
  MM_DELTA_BAND_LO: numField(0, 1).default(0.1),
  MM_DELTA_BAND_HI: numField(0, 1).default(0.3),
  MM_SELECT_VOL: numField(0.01, 5).default(0.5),
  /** P18: today's realised result + the mark-to-market of open positions at or below −this stops quoting. 0 = off. */
  MM_DAILY_MTM_LOSS_LIMIT_USDG6: bigintField.default('1000000000'),
  /*
   * Safe call selling (mm/spot-lag.ts). Each only ever raises an ask, holds a side or halts.
   */
  /**
   * The spot-lag floor: every ask is at least the option's value at the oracle spot moved this many bps against the
   * vault while the print is at most 30 minutes old (the feed prints on a 0.5 % move, so 50 is the whole gap), and
   * past that the wider of MM_SPOT_LAG_STALE_BPS and the market's live oracle band (SettlementOracle marketConfig
   * maxDeviationBps, settable per market and read every tick): this default is only the floor under it and
   * the whole band when that read fails. Both 0 = off.
   */
  MM_SPOT_LAG_BPS: intField(0, 2_000).default(50),
  MM_SPOT_LAG_STALE_BPS: intField(0, 2_000).default(150),
  /** 1: in session, a fair priced on an option chain dated before this session's open halts `fair-before-open`. */
  MM_FAIR_FROM_SESSION: flagField.default('1'),
  /**
   * No AskWrite this many minutes before the mint cutoff (60 = 14:30 New York for a 16:00 expiry),
   * and no AskWrite placed earlier stays valid past it. 0 = the mint cutoff itself.
   * The stop and MM_PULL_MINUTES both count back from the mint cutoff, and the pull takes every quote off, so bids and
   * inventory resales carry on past the stop only while the pull is LATER (fewer minutes): to 15:15 at the keeper's
   * default pull of 15. The shipped mm-bot env pulls at 60, the same 14:30, so there the pull takes
   * everything off at the stop and the stop adds nothing. A stop later than the pull (both non-zero) could never act and
   * is refused at boot.
   */
  MM_WRITE_STOP_MINUTES: intField(0, 1_440).default(60),
  /**
   * Seconds of lead before a House vault's epochEnd during which the plan opens no new risk.
   * Fed to planTick as MmPlanParams.epochWindDownS. 0 = only at/after epochEnd.
   */
  MM_EPOCH_WIND_DOWN_S: intField(0, 7 * 86_400).default(14_400),
  /**
   * The same lead for a DAILY House vault (design). Default 1 800 s:
   * that is SETTLEMENT_WINDOW (V2Constants.sol), after which the book refuses write-on-fill anyway, so a daily vault
   * needs only cancel time. Bounded by one 6.5 h session (23 400 s); 4 h of a 6.5 h day would leave no product.
   * MM_EPOCH_WIND_DOWN_S keeps governing weekly vaults, legacy ones included.
   */
  MM_EPOCH_WIND_DOWN_DAILY_S: intField(0, 23_400).default(1_800),
  /**
   * Extra MakerVault / House vault addresses to quote in this process, comma-separated.
   * The treasury vault is always included from MAKER_VAULT. Empty = treasury only.
   * House factory enumeration needs IHouseVaultFactory in ops/abis/v2; until then this list is the discovery path.
   */
  MM_VAULTS: z.string().optional().default(''),
  /**
   * HouseVaultFactory addresses (src/v2/periphery/house/HouseVaultFactory.sol), comma-separated, each tagged with how
   * its vaults state their epoch kind: `0x..:legacy-weekly` (legacy; weekly, never asked) or `0x..:kinded`
   * (`weekly()` is read). See {@link HouseFactoryKind}. The House vaults are ENUMERATED from each through
   * `vaults()` rather than listed by hand. A bare address is accepted but its vaults are not quoted until it is
   * tagged, and that is paged every tick (v2_mm_house_unavailable). See mm/house.ts. An OVERRIDE:
   * unset, the list is the registry's House factories (houseFactoriesFromRegistry), each tagged by its recorded kind.
   */
  MM_HOUSE_FACTORY: houseFactoriesField.optional(),
  /**
   * Per-vault overrides of the three bot caps, JSON keyed by vault address:
   *   {"0xVault":{"maxSeriesUnits":"100","maxTotalNotionalUsdg6":"50000000000","dailyLossLimitUsdg6":"2000000000"}}
   * Every field is optional and decimal; an omitted one falls back to the process-wide MM_* value.
   * This can only ever TIGHTEN: the result is still clamped at tick time to the vault's own on-chain
   * limit (quoter.ts capAtMost), and 0 keeps today's "the vault's limit alone" meaning.
   */
  MM_VAULT_CAPS: z.string().optional().default(''),
  /* ---- post-trade markouts (mm/markouts.ts) ---- */
  /**
   * v2_mm_markout_low fires when the notional-weighted mean 30-minute markout of the last MM_MARKOUT_ALERT_FILLS
   * fills is below this, in bps of the fill price (positive = the vault did well). A starting point to tune,
   * not a derived number: -200 means the fills are on average 2 % on the wrong side of where the option went.
   */
  MM_MARKOUT_ALERT_BPS: intField(-10_000, 10_000).default(-200),
  /** Fills the rolling markout needs before it can alert. */
  MM_MARKOUT_ALERT_FILLS: intField(1, 500).default(20),
  /* ---- EarnVault venue keeping (earn/plan.ts via earn/keep.ts, run by this bot) ---- */
  /**
   * The EarnVault whose idle USDG this bot parks in its venue and pulls back. `sweepToVenue` and `pullFromVenue` are
   * QUOTER on the EarnVault (roles.v8.json), and this bot's key is its QUOTER. ops/v2-env.mjs renders it from
   * `v2.contracts.earnVault`. Unset: the bot reads nothing about Earn and moves nothing. `processQueue` and `skim`
   * stay the cranker's (permissionless; cranker/steps.ts, the same V2_EARN_VAULT in its own env file).
   */
  V2_EARN_VAULT: addressField.optional(),
  /**
   * The wallet buffer kept out of the venue, USDG base units (6 dp). The larger of this and EARN_BUFFER_BPS applies.
   * Both default to 0: everything idle is swept and a
   * redeem pulls from the venue on demand (EarnVault._raise).
   */
  EARN_BUFFER_USDG6: bigintField.default('0'),
  /** The wallet buffer as bps of `totalAssets()`. */
  EARN_BUFFER_BPS: intField(0, 10_000).default(0),
  /** Most USDG one sweep or pull moves in a tick, base units. A larger gap closes over several ticks. */
  EARN_MAX_MOVE_USDG6: bigintField.refine((v) => v > 0n, 'must be positive').default('1000000000000'),
  /** A sweep or pull under this is not worth a transaction, base units (default 1 USDG). */
  EARN_DUST_USDG6: bigintField.default('1000000'),
  /** v2_earn_queue_stuck fires when the queue has entries and its head has not moved for this long (head seconds). */
  EARN_QUEUE_STUCK_S: intField(300, 7 * 86_400).default(3_600),
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
 * The pricer's tuning. Defaults are the specified numbers (a 10 % move, 30 minutes); ops/v2-env.mjs
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

/**
 * The guardian watch's settings (guardian/planner.ts). The defaults: veto ON, for the scale
 * band only, at 10x.
 */
const guardianTuningFields = {
  /** 1: veto a scale-fault candidate. 0: page it and leave the veto to a person. */
  GUARDIAN_AUTO_VETO: flagField.default('1'),
  /** A candidate this many times away (either way) from every reference is a scale fault. 2 is the floor: under it, an
   *  ordinary market move could Hold an expiry. */
  GUARDIAN_SCALE_FACTOR: intField(2, 1_000_000_000).default(10),
  /** The Chainlink feeds' heartbeat (ChainlinkFeedSource.DEFAULT_MAX_STALE is this plus 2 h). A candidate whose round in
   *  force at the expiry is older than heartbeat + margin was priced through a feed outage. */
  GUARDIAN_FEED_HEARTBEAT_S: intField(60, 7 * 86_400).default(86_400),
  /** Slack over the heartbeat before a round counts as stale. Keep heartbeat + margin under the feed's maxStale (26 h),
   *  or the source refuses the round first and this rule never fires. */
  GUARDIAN_FEED_STALE_MARGIN_S: intField(0, 86_400).default(1_800),
  /** eth_getLogs range of the SettlementOracle scan; halved on a refused range. */
  GUARDIAN_LOG_CHUNK_BLOCKS: intField(100, 10_000_000).default(50_000),
  /** Most eth_getLogs ranges scanned per tick while catching up. */
  GUARDIAN_LOG_CHUNKS_PER_TICK: intField(1, 10_000).default(40),
};

const guardianSchema = z.object({
  ...commonFields,
  GUARDIAN_PK: privateKeyField,
  GUARDIAN_PORT: intField(0, 65_535).default(DEFAULT_MODE_PORT.guardian),
  ...guardianTuningFields,
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
  /** The env var the key came from (CRANKER_PK, MM_QUOTER_PK, PRICER_PK, GUARDIAN_PK), for messages. */
  keyEnv: (typeof MODE_KEY_ENV)[M];
  /** Health server port (0 = any free port). */
  port: number;
  dbPath: string;
  logLevel: V2LogLevel;
  minGasWei: bigint;
  rpcLagAlertMs: number;
  alertCooldownMs: number;
  txTimeoutMs: number;
  /** CRANKER_GAS_SCALE_PCT: percent every fixed gas limit is sent at (tx.ts scaleGas). */
  gasScalePct: number;
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
  firstMintEnabled: boolean;
  flywheelEnabled: boolean;
  flywheelIntervalS: number;
  buybackToleranceBps: number;
  buybackDryRun: boolean;
  /**
   * CRANKER_HOUSE_FACTORY, else MM_HOUSE_FACTORY, else the registry's House factories
   * (houseFactoriesFromRegistry). Empty only when the registry records no House vault either: the `house` step is then
   * a no-op, and there is nothing for it to roll.
   */
  houseFactories: readonly HouseFactoryEntry[];
  /** V2_EARN_VAULT and its queue knobs; null when unset (no Earn reads, no sends). */
  earn: { vault: Address; queueBatch: number; queueCallsPerTick: number; skimIntervalS: number } | null;
}

export interface CrankerConfig extends SigningModeBase<'cranker'> {
  indexerUrl: string | null;
  tuning: CrankerTuning;
}

/** The MM_* keys, parsed (see mmTuningFields for each one's meaning). */
/** How the two series caps were settled at boot, per quoted market: what the ladder lists vs the cap. */
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
  /** MM_ASK_FALLBACK_ONLY. */
  askFallbackOnly: boolean;
  /** MM_WRITE_OVERSUBSCRIBE_BPS; 10_000 = the exact budget. */
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
  /** MM_SEND_INTERVAL_S (0 = every read may send) and MM_REPLACE_CONFIRM_S (replaceMarginOf). */
  sendIntervalS: number;
  replaceConfirmS: number;
  fairSpotToleranceBps: number;
  epochWindDownS: number;
  /** P7: MM_MAX_SPOT_AGE_S (0 = off, explicitly). */
  maxSpotAgeS: number;
  /** P8: MM_OPEN_GRACE_S (0 = off, explicitly). */
  openGraceS: number;
  /** P15: MM_BREAKER_BPS (0 = off, explicitly), MM_BREAKER_WINDOW_S, MM_BREAKER_HALT_S. */
  breakerBps: number;
  breakerWindowS: number;
  breakerHaltS: number;
  /** Safe call selling: MM_SPOT_LAG_BPS, MM_SPOT_LAG_STALE_BPS (both 0 = off), MM_FAIR_FROM_SESSION, MM_WRITE_STOP_MINUTES. */
  spotLagBps: number;
  spotLagStaleBps: number;
  fairFromSession: boolean;
  writeStopMinutes: number;
  /** MM_EPOCH_WIND_DOWN_DAILY_S: the wind-down lead for a daily House vault. */
  epochWindDownDailyS: number;
  /** engine.SafestAsk: P3 MM_VOL_MARKUP_PTS, P4 MM_INTRINSIC_BUFFER_BPS, P5 MM_MIN_PREMIUM_USDG6. */
  volMarkupPts: number;
  intrinsicBufferBps: number;
  minPremiumUsdg6: bigint;
  /** P13 MM_MAX_EXPIRY_NOTIONAL_USDG6, P14 MM_MAX_DELTA_SHARES / MM_MAX_GAMMA (0 = off each). */
  maxExpiryNotionalUsdg6: bigint;
  maxDeltaShares: number;
  maxGamma: number;
  /** P16 MM_DELTA_BAND_LO / MM_DELTA_BAND_HI (HI 0 = off) / MM_SELECT_VOL. */
  deltaBandLo: number;
  deltaBandHi: number;
  selectVol: number;
  /** P18 MM_DAILY_MTM_LOSS_LIMIT_USDG6 (0 = off). */
  dailyMtmLossLimitUsdg6: bigint;
  /** Extra vaults besides MAKER_VAULT, lower-cased, unique, order preserved from env. */
  extraVaults: readonly Address[];
  /**
   * MM_HOUSE_FACTORY, parsed: every House factory and the rule its vaults' kind is read by. Unset: the registry's House
   * factories (houseFactoriesFromRegistry), tagged by their recorded kind.
   */
  houseFactories: readonly HouseFactoryEntry[];
  /** Per-vault cap overrides, keyed lower-case. Absent vault, or absent field, = the process-wide value. */
  vaultCaps: ReadonlyMap<string, VaultCapOverride>;
  /** MM_MARKOUT_ALERT_BPS / MM_MARKOUT_ALERT_FILLS: the rolling 30-minute markout alert (mm/markouts.ts). */
  markoutAlert: { thresholdBps: number; minFills: number };
  /** V2_EARN_VAULT and the EARN_* venue settings; null when V2_EARN_VAULT is unset (no Earn reads, no moves). */
  earn: MmEarnTuning | null;
}

/** The mm bot's EarnVault venue settings, USDG base units; see mmTuningFields for each one. */
export interface MmEarnTuning {
  vault: Address;
  bufferUsdg6: bigint;
  bufferBps: number;
  maxMoveUsdg6: bigint;
  dustUsdg6: bigint;
  queueStuckS: number;
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

/** The GUARDIAN_* keys, parsed (guardianTuningFields). */
export interface GuardianTuning {
  autoVeto: boolean;
  scaleFactor: number;
  feedHeartbeatS: number;
  feedStaleMarginS: number;
  logChunkBlocks: number;
  logChunksPerTick: number;
}

export interface GuardianConfig extends SigningModeBase<'guardian'> {
  tuning: GuardianTuning;
}

export interface PricingModeConfig {
  mode: 'pricing';
  /** Validated by pricing/main.ts's own loader; startPricingService reads the same environment. */
  pricing: PricingEnv;
}

export type SigningModeConfig = CrankerConfig | MmConfig | PricerConfig | GuardianConfig;
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
 * slots `cranker/planner.ts` `ladderSlots` builds (step 1) times that tenor's rungs; the RESOLUTION of the
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
 * The two series caps, settled. Unset: derived so the whole ladder of every quoted market is selectable
 * -- per market the largest listed count among them, in all their sum. Set below the ladder: one problem line per
 * market naming how many of its listed series the cap leaves unquoted, in the shape the MM_MARKETS typo refusal
 * uses, because a cap that trims the book silently is the failure this guards against. A registry with no quoted
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

/**
 * The replace margin, seconds: no `replace` is sent for a live quote with less life left than this (mm/engine.ts
 * planSeriesActions). It is MM_REPLACE_CONFIRM_S, the bound on how long after the plan a replace takes to land. The poll
 * interval and KEEPER_TX_TIMEOUT_MS are taken so the one caller that knows them all (the boot check) and the quoter read
 * the same function, and deliberately not used: the timeout is when a send is GIVEN UP on, not how long a confirm takes,
 * and `ceil((poll + timeout) / 1000)` was 195 s at the P11 env, above the 180 s quote life.
 */
export function replaceMarginOf(input: { pollIntervalMs: number; txTimeoutMs: number; replaceConfirmS: number }): number {
  return input.replaceConfirmS;
}

/**
 * The refresh lead, seconds: a live quote expiring within this is cancelled and placed fresh on this send
 * (mm/engine.ts planSeriesActions `refreshS`; replace keeps validUntil, so it cannot extend one). The next routine send
 * can be up to MM_SEND_INTERVAL_S plus one read away, and the quote must not lapse before it; two reads, as before the
 * send gate, and never under a minute.
 */
export function refreshLeadOf(input: { pollIntervalMs: number; sendIntervalS: number }): number {
  return Math.max(60, Math.ceil((input.sendIntervalS * 1000 + input.pollIntervalMs * 2) / 1000));
}

/**
 * How far ahead a quoted bid is capped (mm/spot-lag.ts bidCapAhead; planner TickInput.bidCapAheadS): two
 * routine sends, each at most MM_SEND_INTERVAL_S plus one read away, so theta alone cannot lift a resting bid over the
 * spot-lag cap before the send after next.
 */
export function bidCapAheadOf(input: { pollIntervalMs: number; sendIntervalS: number }): number {
  return 2 * (input.sendIntervalS + Math.ceil(input.pollIntervalMs / 1000));
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
  const schema = mode === 'cranker' ? crankerSchema : mode === 'mm' ? mmSchema : mode === 'guardian' ? guardianSchema : pricerSchema;
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
  // the docs instead; the disagreement above is the case that is genuinely a misconfiguration.
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
  // stale: the image carries the release's registry, so a redeployed contract
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
  // The series caps against the ladder: a cap set below what a quoted market lists is refused here, by
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

  // The write stop and the pull both count back from the mint cutoff, and the pull takes every quote off. A
  // stop LATER than the pull (fewer minutes, both non-zero) would therefore never act while its description says it
  // does. Equal is accepted: it is the shipped env (both 60, 14:30 New York), where the pull does the
  // stop's job. Read through the two fields alone, like the ladder check, so a malformed value is listed once by the
  // main parse and skipped here.
  if (mode === 'mm') {
    const stop = z.object({ MM_PULL_MINUTES: mmTuningFields.MM_PULL_MINUTES, MM_WRITE_STOP_MINUTES: mmTuningFields.MM_WRITE_STOP_MINUTES }).safeParse(cleaned);
    if (stop.success) {
      const { MM_PULL_MINUTES: pull, MM_WRITE_STOP_MINUTES: write } = stop.data;
      if (pull > 0 && write > 0 && write < pull) {
        lines.push(
          `MM_WRITE_STOP_MINUTES: ${write} falls after the pull (MM_PULL_MINUTES ${pull}); both count back from the mint cutoff ` +
            'and the pull has already taken every quote off, so the write stop would never act. Set it to at least MM_PULL_MINUTES, or 0.',
        );
      }
    }
  }

  // P7 lets a pool reading within MM_FAIR_SPOT_TOLERANCE_BPS of the oracle refresh an old
  // print, while the spot-lag floor prices only an MM_SPOT_LAG_BPS move for the print's first 30 minutes. A tolerance
  // WIDER than the band therefore quotes on a pool gap the floor does not price, so asks can go under-floored. Refused
  // when both are non-zero; 0 is each guard's documented opt-out. Read through the two fields alone, like the checks above.
  if (mode === 'mm') {
    const band = z.object({ MM_FAIR_SPOT_TOLERANCE_BPS: mmTuningFields.MM_FAIR_SPOT_TOLERANCE_BPS, MM_SPOT_LAG_BPS: mmTuningFields.MM_SPOT_LAG_BPS }).safeParse(cleaned);
    if (band.success) {
      const { MM_FAIR_SPOT_TOLERANCE_BPS: tolerance, MM_SPOT_LAG_BPS: lag } = band.data;
      if (tolerance > 0 && lag > 0 && lag < tolerance) {
        lines.push(
          `MM_SPOT_LAG_BPS: ${lag} is below MM_FAIR_SPOT_TOLERANCE_BPS ${tolerance}; P7 accepts a pool gap up to the tolerance that the ` +
            'spot-lag floor does not price. Set MM_SPOT_LAG_BPS to at least MM_FAIR_SPOT_TOLERANCE_BPS, or lower the tolerance.',
        );
      }
    }
  }

  // The replace margin against the quote life: at or above it, every live quote is inside the margin from the
  // moment it is placed, so no `replace` is ever sent and every requote costs a cancel and a place (measured
  // exactly that at the P11 env: 195 s against 180 s). The margin is the quoter's own (replaceMarginOf), so this check
  // and the bot cannot disagree. Read through the fields alone, like the checks above.
  if (mode === 'mm') {
    const life = z
      .object({
        MM_MAX_QUOTE_LIFETIME_S: mmTuningFields.MM_MAX_QUOTE_LIFETIME_S,
        MM_REPLACE_CONFIRM_S: mmTuningFields.MM_REPLACE_CONFIRM_S,
        POLL_INTERVAL_MS: commonFields.POLL_INTERVAL_MS,
        KEEPER_TX_TIMEOUT_MS: commonFields.KEEPER_TX_TIMEOUT_MS,
      })
      .safeParse(cleaned);
    if (life.success) {
      const lifetime = life.data.MM_MAX_QUOTE_LIFETIME_S;
      const margin = replaceMarginOf({ pollIntervalMs: life.data.POLL_INTERVAL_MS, txTimeoutMs: life.data.KEEPER_TX_TIMEOUT_MS, replaceConfirmS: life.data.MM_REPLACE_CONFIRM_S });
      if (lifetime > 0 && margin >= lifetime) {
        lines.push(
          `MM_REPLACE_CONFIRM_S: the replace margin ${margin} s is at or above MM_MAX_QUOTE_LIFETIME_S ${lifetime} s, so no live quote could ever be ` +
            'replaced (each requote would cost a cancel and a place). Set MM_REPLACE_CONFIRM_S below the quote lifetime.',
        );
      }
    }
  }

  // A registry that records House vaults must also say where to find them, unless the environment names the
  // factories itself. Checked on the raw env, like the ladder check above, so it joins the one list of problems.
  if (registry !== null && (mode === 'cranker' || mode === 'mm')) {
    const envKey = mode === 'cranker' ? 'CRANKER_HOUSE_FACTORY' : 'MM_HOUSE_FACTORY';
    const envSet = cleaned[envKey] !== undefined || (mode === 'cranker' && cleaned.MM_HOUSE_FACTORY !== undefined);
    const problem = envSet ? null : houseFactoryBootProblem(registry.house, envKey, registryPath);
    if (problem !== null) lines.push(problem);
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
    gasScalePct: e.CRANKER_GAS_SCALE_PCT,
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
        firstMintEnabled: c.CRANKER_FIRSTMINT_ENABLED,
        flywheelEnabled: c.CRANKER_FLYWHEEL_ENABLED,
        flywheelIntervalS: c.CRANKER_FLYWHEEL_INTERVAL_S,
        buybackToleranceBps: c.CRANKER_BUYBACK_TOLERANCE_BPS,
        buybackDryRun: c.CRANKER_BUYBACK_DRY_RUN,
        houseFactories: c.CRANKER_HOUSE_FACTORY ?? c.MM_HOUSE_FACTORY ?? houseFactoriesFromRegistry(registry.house),
        earn: c.V2_EARN_VAULT === undefined ? null : { vault: c.V2_EARN_VAULT, queueBatch: c.EARN_QUEUE_BATCH, queueCallsPerTick: c.EARN_QUEUE_CALLS_PER_TICK, skimIntervalS: c.EARN_SKIM_INTERVAL_S },
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
        sendIntervalS: c.MM_SEND_INTERVAL_S,
        replaceConfirmS: c.MM_REPLACE_CONFIRM_S,
        fairSpotToleranceBps: c.MM_FAIR_SPOT_TOLERANCE_BPS,
        epochWindDownS: c.MM_EPOCH_WIND_DOWN_S,
        maxSpotAgeS: c.MM_MAX_SPOT_AGE_S,
        openGraceS: c.MM_OPEN_GRACE_S,
        breakerBps: c.MM_BREAKER_BPS,
        breakerWindowS: c.MM_BREAKER_WINDOW_S,
        breakerHaltS: c.MM_BREAKER_HALT_S,
        spotLagBps: c.MM_SPOT_LAG_BPS,
        spotLagStaleBps: c.MM_SPOT_LAG_STALE_BPS,
        fairFromSession: c.MM_FAIR_FROM_SESSION,
        writeStopMinutes: c.MM_WRITE_STOP_MINUTES,
        epochWindDownDailyS: c.MM_EPOCH_WIND_DOWN_DAILY_S,
        volMarkupPts: c.MM_VOL_MARKUP_PTS,
        intrinsicBufferBps: c.MM_INTRINSIC_BUFFER_BPS,
        minPremiumUsdg6: c.MM_MIN_PREMIUM_USDG6,
        maxExpiryNotionalUsdg6: c.MM_MAX_EXPIRY_NOTIONAL_USDG6,
        maxDeltaShares: c.MM_MAX_DELTA_SHARES,
        maxGamma: c.MM_MAX_GAMMA,
        deltaBandLo: c.MM_DELTA_BAND_LO,
        deltaBandHi: c.MM_DELTA_BAND_HI,
        selectVol: c.MM_SELECT_VOL,
        dailyMtmLossLimitUsdg6: c.MM_DAILY_MTM_LOSS_LIMIT_USDG6,
        extraVaults: parseAddressList(c.MM_VAULTS),
        houseFactories: c.MM_HOUSE_FACTORY ?? houseFactoriesFromRegistry(registry.house),
        vaultCaps: parseVaultCaps(c.MM_VAULT_CAPS),
        markoutAlert: { thresholdBps: c.MM_MARKOUT_ALERT_BPS, minFills: c.MM_MARKOUT_ALERT_FILLS },
        earn:
          c.V2_EARN_VAULT === undefined
            ? null
            : {
                vault: c.V2_EARN_VAULT,
                bufferUsdg6: c.EARN_BUFFER_USDG6,
                bufferBps: c.EARN_BUFFER_BPS,
                maxMoveUsdg6: c.EARN_MAX_MOVE_USDG6,
                dustUsdg6: c.EARN_DUST_USDG6,
                queueStuckS: c.EARN_QUEUE_STUCK_S,
              },
      },
    };
  }
  if (mode === 'guardian') {
    const g = e as z.infer<typeof guardianSchema>;
    const key = g.GUARDIAN_PK;
    return {
      ...base,
      mode,
      contracts: contracts as ContractsWith<(typeof MODE_CONTRACTS)['guardian'][number]>,
      privateKey: () => key,
      keyEnv: MODE_KEY_ENV.guardian,
      port: g.GUARDIAN_PORT,
      tuning: {
        autoVeto: g.GUARDIAN_AUTO_VETO,
        scaleFactor: g.GUARDIAN_SCALE_FACTOR,
        feedHeartbeatS: g.GUARDIAN_FEED_HEARTBEAT_S,
        feedStaleMarginS: g.GUARDIAN_FEED_STALE_MARGIN_S,
        logChunkBlocks: g.GUARDIAN_LOG_CHUNK_BLOCKS,
        logChunksPerTick: g.GUARDIAN_LOG_CHUNKS_PER_TICK,
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
