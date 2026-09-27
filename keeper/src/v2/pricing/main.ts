/**
 * The pricing service as a process: `startPricingService()` plus a tiny main.
 *
 * `V2_MODE=pricing` (src/v2/index.ts) calls startPricingService() and owns signals; run
 * directly (`tsx src/v2/pricing/main.ts`, `node dist/v2/pricing/main.js`) the main at the bottom
 * does the same and closes the server on SIGTERM/SIGINT. Nothing here imports the v1 config, which
 * exits without a vault or factory key: this process holds no key and sends no transaction.
 *
 * Environment (validated once, every problem listed, exit 1 from the main):
 *   PRICING_PORT       default 8790
 *   V2_REGISTRY_PATH   default ../ops/markets/tier1.json. A relative path resolves against the
 *                      keeper package directory (not the working directory), so the default
 *                      finds the repo's registry from src/ and from dist/ alike. The Docker image
 *                      bakes it at /app/ops/markets/tier1.json; a container sets that absolute path.
 *   RH_RPC             required: the Stock Token feeds are read here
 *   RH_RPC_2           optional fallback transport
 *   KEEPER_LOG_LEVEL   default info
 *   PRICING_NYSE_HOLIDAYS  optional YYYY-MM-DD list of full-day NYSE closures, replacing calendar.ts
 *                      NYSE_HOLIDAYS_2026_2028 (the years the on-chain ExpiryCalendar was seeded for). The
 *                      boot warns when the table does not cover now + the surface horizon.
 *   PRICING_CHAIN_PROVIDER  `massive` (default: Massive's real-time option snapshot, massive.ts) or `cboe`
 *                      (Cboe's free file, 15 minutes behind, cboe.ts). Production uses
 *                      massive only: IN PRODUCTION `cboe` REFUSES BOOT. Production is NODE_ENV=production (the
 *                      keeper image sets it) or the production registry (V2_REGISTRY_PATH naming tier1.json, the
 *                      default). There is no fallback either way: a failed Massive download refuses /fair for that
 *                      market (fair.ts loadChain) instead of switching provider or serving the last chain.
 *   MASSIVE_API_KEY    secret; required when the provider is `massive` (so, in production, always), refused as
 *                      unused otherwise. A Railway variable, never a file. Sent only as a Bearer header; never
 *                      logged (RedactedSecret)
 *   MASSIVE_API_URL    default https://api.massive.com
 *   PRICING_CHAIN_REFETCH_MS  least time between two downloads of one ticker's chain. Default per
 *                      provider: Cboe 300000 (cboe.ts PRICING_MIN_REFETCH_MS: a free feed that blocks
 *                      IPs, and at least 60000 is enforced), Massive 15000 (massive.ts
 *                      MASSIVE_MIN_REFETCH_MS: a real-time feed read inside a minute)
 *   PRICING_CHAIN_TIMEOUT_MS  deadline for one download (every page of it). Default Cboe 10000, Massive 20000
 *   PRICING_CHAIN_WARM_UP  1: after listen, download every market's chain once, one after another (cboe.ts
 *                      warmChains), so the first /fair does not wait for a download. Default 0 (first use), so
 *                      an embedder that injects seams sees only the downloads it asks for; ops/v2/env/pricing.env
 *                      sets 1 for the deployed service
 *   PRICING_POOL_TWAP_S  the pool spot's TWAP length (pool-spot.ts), seconds, 30..3600. Default 90
 *   PRICING_POOL_MAX_END_AGE_S  how far the TWAP's end block (the head it is read at) may trail the wall clock,
 *                      seconds, 1..3600. Default 300 (pool-spot.ts DEFAULT_POOL_TWAP_MAX_END_AGE_S, the keeper's RPC
 *                      lag alert); older refuses the pool leg `pool-twap-stale`. Raise it only if chain 4663's
 *                      head goes that long without a block while the market is priced
 *   PRICING_MAX_POOL_CHAINLINK_DIVERGENCE_BPS  pool spot vs Chainlink spot above which /fair refuses
 *                      (source-disagreement). Default 150
 *   PRICING_POOL_REQUIRED  1 (default): a market whose registry names a v3 pool refuses when its pool spot is
 *                      unusable; 0: it prices on Chainlink alone then (fair.ts TWO SPOTS AND A LIVE FORWARD)
 *   PRICING_FORWARD_MAX_QUOTE_AGE_S  oldest option quote the parity forward uses, by its own clock. Default 120
 *   PRICING_FORWARD_MAX_PAIR_SPREAD_BPS  widest call+put spread a forward pair may have, bps of spot. Default 100
 *   PRICING_ASK_IV_MARKUP_BPS  askIv's vol markup over max(iv, realized, floor), bps, 0..10000. Default 1000
 *                      (×1.10). askIv is never below iv whatever this is (fair.ts askIvFor)
 *   PRICING_ASK_IV_FLOOR  a vol floor for every ticker (annualised, trading clock), 0..5. Default 0 (none)
 *   PRICING_ASK_IV_FLOORS  optional JSON { "NVDA": 0.35 }: per-ticker floors over PRICING_ASK_IV_FLOOR
 *   PRICING_REALIZED_LOOKBACK_S  how far back the pool's realized vol looks, seconds. Default 23400 (a session)
 *   PRICING_REALIZED_STEP_S  its TWAP window, seconds, 60..3600. Default 300
 *   PRICING_EVENTS_PATH  the event calendar (events.ts). Default ../ops/markets/events.json, resolved like
 *                      V2_REGISTRY_PATH; a default that is absent is no calendar (logged, /health
 *                      `eventCalendar: []`), a configured path that is absent refuses boot, and a file that
 *                      does not parse always refuses boot, both with events.ts EventCalendarFileError. In the
 *                      image the default resolves OUTSIDE /app (the package root is /app, so ../ops is /ops),
 *                      which is why ops/v2/env/pricing.env sets this to the copy keeper/Dockerfile bakes at
 *                      /app/ops/markets/events.json: a set path cannot silently read no calendar.
 * The pool is read over RH_RPC / RH_RPC_2, like the feeds.
 * The registry's `defaults.maxPriceAgeS` and `defaults.maxSpotDivergenceBps` set the chain and feed
 * age limits and the spot divergence limit; fair.ts DEFAULT_PRICING_SETTINGS otherwise.
 *
 * No host is passed to listen(), like health.ts: `::` where IPv6 exists (Railway's private network
 * is IPv6), `0.0.0.0` where it does not.
 */
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { pino } from 'pino';
import { z } from 'zod';
import { DEFAULT_CHAIN_TIMEOUT_MS, PRICING_MIN_REFETCH_MS, warmChains, type FetchChain } from './cboe.js';
import type { OptionChainProvider } from './chain.js';
import { DEFAULT_ASK_IV_SETTINGS, DEFAULT_PRICING_SETTINGS, PricingService, type PricingSettings } from './fair.js';
import { MASSIVE_API_BASE, MASSIVE_CHAIN_TIMEOUT_MS, MASSIVE_MIN_REFETCH_MS, createMassiveProvider } from './massive.js';
import { loadPricingRegistry } from './markets.js';
import { SURFACE_HORIZON_DAYS } from './surface.js';
import { createPricingApp } from './server.js';
import { createFeedSpotReader, type SpotReader } from './spot.js';
import { DEFAULT_FORWARD_SETTINGS } from './forward.js';
import { DEFAULT_POOL_TWAP_MAX_END_AGE_S, DEFAULT_POOL_TWAP_S, MAX_POOL_TWAP_S, MIN_POOL_TWAP_S, createPoolObserveReader, type PoolReader } from './pool-spot.js';
import { loadEventCalendarFile } from './events.js';
import { redactUrls } from '../tx.js';

/** The keeper package directory: src/v2/pricing/ and dist/v2/pricing/ are both three levels in. */
export const KEEPER_PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url));

export const DEFAULT_PRICING_PORT = 8790;
export const DEFAULT_REGISTRY_PATH = '../ops/markets/tier1.json';
/** The event calendar next to the registry (events.ts); relative to the keeper package directory like it. */
export const DEFAULT_EVENTS_PATH = '../ops/markets/events.json';

const httpUrl = z.string().refine((raw) => {
  try {
    const p = new URL(raw).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}, 'not an http(s) URL (value not shown)');

const httpsUrl = z.string().refine((raw) => {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}, 'not an https URL (value not shown)');

/** Cboe's floor: below a minute a free feed is being polled hard enough to get the IP blocked. */
export const CBOE_MIN_ALLOWED_REFETCH_MS = 60_000;

/** The production registry's file name (keeper/Dockerfile bakes /app/ops/markets/tier1.json; DEFAULT_REGISTRY_PATH). */
export const PRODUCTION_REGISTRY_FILE = 'tier1.json';

/**
 * Whether this boot is production, where only Massive may price. NODE_ENV=production (keeper/Dockerfile
 * sets it for every service built from the image) or a registry path naming the production registry file. The local
 * devnet registry (ops/markets/dev.json) and a fork's copy (tier1.devnet.json) are neither.
 */
export function isProductionPricing(env: { NODE_ENV?: string | undefined; V2_REGISTRY_PATH: string }): boolean {
  return env.NODE_ENV === 'production' || basename(env.V2_REGISTRY_PATH) === PRODUCTION_REGISTRY_FILE;
}

/** A secret that prints as `[redacted]` through String(), JSON.stringify and util.inspect (pino, console). */
export class RedactedSecret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

const envSchema = z.object({
  PRICING_PORT: z.coerce.number().int().min(0).max(65_535).default(DEFAULT_PRICING_PORT),
  V2_REGISTRY_PATH: z.string().min(1).default(DEFAULT_REGISTRY_PATH),
  RH_RPC: httpUrl,
  RH_RPC_2: httpUrl.optional(),
  PRICING_NYSE_HOLIDAYS: z
    .string()
    .transform((raw, ctx) => {
      const dates = raw.split(',').map((d) => d.trim()).filter((d) => d !== '');
      for (const d of dates) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a YYYY-MM-DD date: ${d}` });
          return z.NEVER;
        }
      }
      return dates;
    })
    .optional(),
  KEEPER_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  // Read only for the production rule below (isProductionPricing).
  NODE_ENV: z.string().optional(),
  PRICING_CHAIN_PROVIDER: z.enum(['cboe', 'massive']).default('massive'),
  // A custom message: zod's default for a regex never echoes the value, and this says so.
  MASSIVE_API_KEY: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/, 'not a Massive API key (value not shown)').optional(),
  MASSIVE_API_URL: httpsUrl.default(MASSIVE_API_BASE),
  PRICING_CHAIN_REFETCH_MS: z.coerce.number().int().min(1_000).max(3_600_000).optional(),
  PRICING_CHAIN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).optional(),
  PRICING_CHAIN_WARM_UP: z.enum(['0', '1']).default('0'),
  PRICING_POOL_TWAP_S: z.coerce.number().int().min(MIN_POOL_TWAP_S).max(MAX_POOL_TWAP_S).default(DEFAULT_POOL_TWAP_S),
  PRICING_POOL_MAX_END_AGE_S: z.coerce.number().int().min(1).max(3_600).default(DEFAULT_POOL_TWAP_MAX_END_AGE_S),
  PRICING_MAX_POOL_CHAINLINK_DIVERGENCE_BPS: z.coerce.number().int().min(1).max(10_000).default(150),
  PRICING_POOL_REQUIRED: z.enum(['0', '1']).default('1'),
  PRICING_FORWARD_MAX_QUOTE_AGE_S: z.coerce.number().int().min(1).max(3_600).default(DEFAULT_FORWARD_SETTINGS.maxQuoteAgeS),
  PRICING_FORWARD_MAX_PAIR_SPREAD_BPS: z.coerce.number().int().min(1).max(10_000).default(DEFAULT_FORWARD_SETTINGS.maxPairSpreadBps),
  PRICING_ASK_IV_MARKUP_BPS: z.coerce.number().int().min(0).max(10_000).default(DEFAULT_ASK_IV_SETTINGS.markupBps),
  PRICING_ASK_IV_FLOOR: z.coerce.number().min(0).max(5).default(DEFAULT_ASK_IV_SETTINGS.floor),
  PRICING_ASK_IV_FLOORS: z
    .string()
    .transform((raw, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not JSON: expected { "NVDA": 0.35 }' });
        return z.NEVER;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected an object of ticker -> vol, e.g. { "NVDA": 0.35 }' });
        return z.NEVER;
      }
      const out: Record<string, number> = {};
      for (const [ticker, vol] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^[A-Z0-9.]{1,8}$/.test(ticker) || typeof vol !== 'number' || !Number.isFinite(vol) || vol < 0 || vol > 5) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ticker}: a registry ticker mapped to a vol in [0, 5], got ${JSON.stringify(vol)}` });
          return z.NEVER;
        }
        out[ticker] = vol;
      }
      return out;
    })
    .optional(),
  PRICING_REALIZED_LOOKBACK_S: z.coerce.number().int().min(600).max(7 * 86_400).default(DEFAULT_PRICING_SETTINGS.realized.lookbackS),
  PRICING_REALIZED_STEP_S: z.coerce.number().int().min(60).max(3_600).default(DEFAULT_PRICING_SETTINGS.realized.stepS),
  PRICING_EVENTS_PATH: z.string().min(1).optional(),
}).superRefine((e, ctx) => {
  if (e.PRICING_CHAIN_PROVIDER === 'cboe' && isProductionPricing(e)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PRICING_CHAIN_PROVIDER'],
      message: `cboe is refused in production (NODE_ENV=production or the ${PRODUCTION_REGISTRY_FILE} registry): Cboe's file is 15 minutes behind. Set PRICING_CHAIN_PROVIDER=massive and MASSIVE_API_KEY (T-OP-706)`,
    });
  }
  if (e.PRICING_CHAIN_PROVIDER === 'massive' && e.MASSIVE_API_KEY === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MASSIVE_API_KEY'], message: 'required when PRICING_CHAIN_PROVIDER=massive (the default, and the only provider production accepts): set it as a Railway variable, never in a file' });
  }
  if (e.PRICING_CHAIN_PROVIDER === 'cboe' && e.MASSIVE_API_KEY !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MASSIVE_API_KEY'], message: 'set while PRICING_CHAIN_PROVIDER is cboe: set PRICING_CHAIN_PROVIDER=massive to use it, or remove it' });
  }
  if (e.PRICING_REALIZED_LOOKBACK_S < 2 * e.PRICING_REALIZED_STEP_S) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PRICING_REALIZED_LOOKBACK_S'], message: `must cover at least two steps of PRICING_REALIZED_STEP_S (${e.PRICING_REALIZED_STEP_S})` });
  }
  if (e.PRICING_CHAIN_PROVIDER === 'cboe' && e.PRICING_CHAIN_REFETCH_MS !== undefined && e.PRICING_CHAIN_REFETCH_MS < CBOE_MIN_ALLOWED_REFETCH_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PRICING_CHAIN_REFETCH_MS'], message: `at least ${CBOE_MIN_ALLOWED_REFETCH_MS} on Cboe's free delayed file` });
  }
});

export interface PricingEnv {
  port: number;
  /** Absolute. */
  registryPath: string;
  rpcUrls: string[];
  logLevel: z.infer<typeof envSchema>['KEEPER_LOG_LEVEL'];
  /** PRICING_NYSE_HOLIDAYS, or null for the built-in table. */
  holidays: readonly string[] | null;
  /** The option-chain provider and its cadence. */
  chain: {
    provider: 'cboe' | 'massive';
    /** MASSIVE_API_KEY; null for Cboe. */
    massiveApiKey: RedactedSecret | null;
    massiveApiUrl: string;
    refetchMs: number;
    timeoutMs: number;
  };
  /** PRICING_CHAIN_WARM_UP: download every market's chain once after listen. */
  chainWarmUp: boolean;
  /** The pool spot and the parity forward (fair.ts TWO SPOTS AND A LIVE FORWARD). */
  spot: {
    poolTwapS: number;
    maxPoolChainlinkDivergenceBps: number;
    poolRequired: boolean;
    forwardMaxQuoteAgeS: number;
    forwardMaxPairSpreadBps: number;
  };
  /**
   * How the RH_RPC v3 pool reader is built (pool-spot.ts createPoolObserveReader), apart from `spot`, which feeds the
   * service's settings. maxEndAgeS: PRICING_POOL_MAX_END_AGE_S, the bound on its TWAP end block's age.
   */
  poolReader: { maxEndAgeS: number };
  /** The safest-ask inputs (fair.ts askIvFor, realized.ts). */
  ask: { markupBps: number; floor: number; floors: Record<string, number>; realizedLookbackS: number; realizedStepS: number };
  /** The event calendar file, absolute, and whether PRICING_EVENTS_PATH named it (events.ts loadEventCalendarFile). */
  events: { path: string; explicit: boolean };
}

/** Parse the environment. Blank values are unset (config.ts does the same). Throws listing every problem. */
export function loadPricingEnv(env: NodeJS.ProcessEnv = process.env): PricingEnv {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value.trim();
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Pricing service configuration is not usable. Fix these and restart:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    port: e.PRICING_PORT,
    registryPath: resolve(KEEPER_PACKAGE_DIR, e.V2_REGISTRY_PATH),
    rpcUrls: e.RH_RPC_2 === undefined ? [e.RH_RPC] : [e.RH_RPC, e.RH_RPC_2],
    logLevel: e.KEEPER_LOG_LEVEL,
    holidays: e.PRICING_NYSE_HOLIDAYS ?? null,
    chain: {
      provider: e.PRICING_CHAIN_PROVIDER,
      massiveApiKey: e.MASSIVE_API_KEY === undefined ? null : new RedactedSecret(e.MASSIVE_API_KEY),
      massiveApiUrl: e.MASSIVE_API_URL,
      refetchMs: e.PRICING_CHAIN_REFETCH_MS ?? (e.PRICING_CHAIN_PROVIDER === 'massive' ? MASSIVE_MIN_REFETCH_MS : PRICING_MIN_REFETCH_MS),
      timeoutMs: e.PRICING_CHAIN_TIMEOUT_MS ?? (e.PRICING_CHAIN_PROVIDER === 'massive' ? MASSIVE_CHAIN_TIMEOUT_MS : DEFAULT_CHAIN_TIMEOUT_MS),
    },
    chainWarmUp: e.PRICING_CHAIN_WARM_UP === '1',
    spot: {
      poolTwapS: e.PRICING_POOL_TWAP_S,
      maxPoolChainlinkDivergenceBps: e.PRICING_MAX_POOL_CHAINLINK_DIVERGENCE_BPS,
      poolRequired: e.PRICING_POOL_REQUIRED === '1',
      forwardMaxQuoteAgeS: e.PRICING_FORWARD_MAX_QUOTE_AGE_S,
      forwardMaxPairSpreadBps: e.PRICING_FORWARD_MAX_PAIR_SPREAD_BPS,
    },
    poolReader: { maxEndAgeS: e.PRICING_POOL_MAX_END_AGE_S },
    ask: {
      markupBps: e.PRICING_ASK_IV_MARKUP_BPS,
      floor: e.PRICING_ASK_IV_FLOOR,
      floors: e.PRICING_ASK_IV_FLOORS ?? {},
      realizedLookbackS: e.PRICING_REALIZED_LOOKBACK_S,
      realizedStepS: e.PRICING_REALIZED_STEP_S,
    },
    events: { path: resolve(KEEPER_PACKAGE_DIR, e.PRICING_EVENTS_PATH ?? DEFAULT_EVENTS_PATH), explicit: e.PRICING_EVENTS_PATH !== undefined },
  };
}

/**
 * The configured provider: Massive, or undefined for an explicit non-production `cboe` (ChainCache builds the Cboe
 * provider over `fetchChain`). loadPricingEnv already refused `cboe` in production, so production always gets Massive.
 */
export function chainProviderFor(env: PricingEnv, horizonDays: number = SURFACE_HORIZON_DAYS): OptionChainProvider | undefined {
  if (env.chain.provider === 'cboe') return undefined;
  if (env.chain.massiveApiKey === null) throw new Error('MASSIVE_API_KEY: required when PRICING_CHAIN_PROVIDER=massive');
  return createMassiveProvider({ apiKey: env.chain.massiveApiKey.reveal(), baseUrl: env.chain.massiveApiUrl, horizonDays });
}

export interface StartPricingOptions {
  env?: NodeJS.ProcessEnv;
  /** SEAM: replaces the RH_RPC feed reader. */
  spotReader?: SpotReader;
  /** SEAM: replaces the RH_RPC v3 pool reader. */
  poolReader?: PoolReader;
  /**
   * SEAM: what builds that reader when `poolReader` is not given (default createPoolObserveReader). It is handed the
   * env's RPC URLs and `{ maxEndAgeS: PRICING_POOL_MAX_END_AGE_S }`, which is how a test sees the bound arrive.
   */
  createPoolReader?: (rpcUrls: readonly string[], timeoutMs: number | undefined, options: { maxEndAgeS: number }) => PoolReader;
  /** SEAM: replaces the Cboe download. */
  fetchChain?: FetchChain;
  /** SEAM: replaces the data provider (chain.ts); takes precedence over `fetchChain`. */
  provider?: OptionChainProvider;
  settings?: Partial<PricingSettings>;
  /**
   * SEAM: the one address to listen on. Unset in production: no host, `::` (see the header). A test that reads the
   * service over 127.0.0.1 passes '127.0.0.1': on macOS a no-host bind for PRICING_PORT 0 can be given a
   * port another process already holds on 127.0.0.1 (or ::1), and 127.0.0.1 then reaches that process, not this one.
   * A 127.0.0.1 bind is never given a held port.
   */
  hostname?: string;
}

export interface RunningPricingService {
  service: PricingService;
  server: ServerType;
  /** The bound port (PRICING_PORT, or the one the OS chose for 0). */
  port: number;
  close(): Promise<void>;
}

/** Load env and registry, build the service, listen. Throws on a bad env or registry. */
export async function startPricingService(options: StartPricingOptions = {}): Promise<RunningPricingService> {
  const env = loadPricingEnv(options.env);
  const registry = loadPricingRegistry(env.registryPath);
  const log = pino({
    level: env.logLevel,
    base: { service: 'callhouse-pricing' },
    formatters: { level: (label) => ({ level: label }) },
    // Every finished line through the shared URL rule (../redact.ts), as the signing modes' logger does.
    hooks: { streamWrite: redactUrls },
    ...(process.stdout.isTTY === true ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
  const provider = options.provider ?? chainProviderFor(env, options.settings?.horizonDays ?? SURFACE_HORIZON_DAYS);
  // Refuses boot (EventCalendarFileError) when PRICING_EVENTS_PATH is set and the file is missing, and whenever a
  // file that exists does not parse; an unset path whose default is absent is no calendar, logged below.
  const events = loadEventCalendarFile(env.events.path, new Set(registry.markets.keys()), env.events.explicit);
  const service = new PricingService({
    markets: registry.markets,
    spotReader: options.spotReader ?? createFeedSpotReader(env.rpcUrls),
    // The bound is the env's, not pool-spot.ts's fixed default.
    poolReader: options.poolReader ?? (options.createPoolReader ?? createPoolObserveReader)(env.rpcUrls, undefined, { maxEndAgeS: env.poolReader.maxEndAgeS }),
    chains: {
      ...(options.fetchChain === undefined ? {} : { fetchChain: options.fetchChain }),
      ...(provider === undefined ? {} : { provider }),
      minRefetchMs: env.chain.refetchMs,
      timeoutMs: env.chain.timeoutMs,
    },
    settings: {
      ...(registry.maxPriceAgeS === null ? {} : { maxChainAgeS: registry.maxPriceAgeS, maxSpotAgeS: registry.maxPriceAgeS }),
      ...(registry.maxSpotDivergenceBps === null ? {} : { maxSpotDivergenceBps: registry.maxSpotDivergenceBps }),
      ...(env.holidays === null ? {} : { holidays: env.holidays }),
      poolTwapS: env.spot.poolTwapS,
      maxPoolChainlinkDivergenceBps: env.spot.maxPoolChainlinkDivergenceBps,
      poolRequired: env.spot.poolRequired,
      forward: { ...DEFAULT_FORWARD_SETTINGS, maxQuoteAgeS: env.spot.forwardMaxQuoteAgeS, maxPairSpreadBps: env.spot.forwardMaxPairSpreadBps },
      askIv: { markupBps: env.ask.markupBps, floor: env.ask.floor, floors: env.ask.floors },
      realized: { ...DEFAULT_PRICING_SETTINGS.realized, lookbackS: env.ask.realizedLookbackS, stepS: env.ask.realizedStepS },
      ...options.settings,
    },
    events: events.calendar,
    log,
  });
  // /health reads each ticker's re-check day against the same calendar the service prices with. No file
  // loaded: no days, and /health serves eventRecheck null (not served) rather than an empty "nothing due".
  const app = createPricingApp(service, log, events.loaded ? { eventRecheck: { recheckBy: events.recheckBy, calendar: events.calendar } } : {});
  const server = await new Promise<ServerType>((resolveServer) => {
    const s = serve({ fetch: app.fetch, port: env.port, ...(options.hostname === undefined ? {} : { hostname: options.hostname }) }, () => resolveServer(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : env.port;
  if (!events.loaded) log.warn({ eventsPath: env.events.path }, 'no event calendar file: every /fair event flag reads input "missing" (unknown, not clear)');
  log.info({ port, eventsPath: env.events.path, eventCalendarTickers: [...events.calendar.keys()], askIvMarkupBps: env.ask.markupBps, askIvFloor: env.ask.floor, markets: registry.markets.size, registry: env.registryPath, chainProvider: service.chainProvider.id, chainRefetchMs: env.chain.refetchMs, chainTimeoutMs: env.chain.timeoutMs, poolTwapS: env.spot.poolTwapS, poolMaxEndAgeS: env.poolReader.maxEndAgeS, maxPoolChainlinkDivergenceBps: env.spot.maxPoolChainlinkDivergenceBps, poolRequired: env.spot.poolRequired, marketsWithPool: [...registry.markets.values()].filter((m) => m.pool !== undefined).map((m) => m.ticker) }, 'pricing service listening');
  if (env.chainWarmUp) {
    // Not awaited: /health answers meanwhile, and a /fair that arrives first shares the same download.
    void warmChains([...registry.markets.keys()], (ticker) => service.surface(ticker)).then((results) => {
      log.info({ warmed: results.filter((r) => r.ok).map((r) => r.ticker), failed: results.filter((r) => !r.ok) }, 'option chains warmed');
    });
  }
  // A holiday the table does not know is priced as a session and read as a completed one by the chain freshness rule.
  const lastCovered = [...service.settings.holidays].sort().at(-1) ?? '0000';
  const horizonEnd = new Date(Date.now() + service.settings.horizonDays * 86_400_000).toISOString().slice(0, 4);
  if (lastCovered.slice(0, 4) < horizonEnd) {
    log.warn({ lastCoveredHoliday: lastCovered, horizonEndYear: horizonEnd }, 'the NYSE holiday table does not cover the pricing horizon: set PRICING_NYSE_HOLIDAYS (or update calendar.ts) with next year\'s closures');
  }
  return {
    service,
    server,
    port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/*//////////////////////////////////////////////////////////////
                               MAIN
//////////////////////////////////////////////////////////////*/

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  startPricingService().then(
    (running) => {
      const stop = () => void running.close().then(() => process.exit(0));
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    },
    (error: unknown) => {
      process.stderr.write(`\n${redactUrls(error instanceof Error ? error.message : String(error))}\n\n`);
      process.exit(1);
    },
  );
}
