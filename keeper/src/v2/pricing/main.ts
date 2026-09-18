/**
 * The pricing service as a process: `startPricingService()` plus a tiny main.
 *
 * `V2_MODE=pricing` (src/v2/index.ts, K2-01) calls startPricingService() and owns signals; run
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
 * The registry's `defaults.maxPriceAgeS` and `defaults.maxSpotDivergenceBps` set the chain and feed
 * age limits and the spot divergence limit; fair.ts DEFAULT_PRICING_SETTINGS otherwise.
 *
 * No host is passed to listen(), like health.ts: `::` where IPv6 exists (Railway's private network
 * is IPv6), `0.0.0.0` where it does not.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { pino } from 'pino';
import { z } from 'zod';
import type { FetchChain } from './cboe.js';
import { PricingService, type PricingSettings } from './fair.js';
import { loadPricingRegistry } from './markets.js';
import { createPricingApp } from './server.js';
import { createFeedSpotReader, type SpotReader } from './spot.js';
import { redactUrls } from '../tx.js';

/** The keeper package directory: src/v2/pricing/ and dist/v2/pricing/ are both three levels in. */
export const KEEPER_PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url));

export const DEFAULT_PRICING_PORT = 8790;
export const DEFAULT_REGISTRY_PATH = '../ops/markets/tier1.json';

const httpUrl = z.string().refine((raw) => {
  try {
    const p = new URL(raw).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}, 'not an http(s) URL (value not shown)');

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
});

export interface PricingEnv {
  port: number;
  /** Absolute. */
  registryPath: string;
  rpcUrls: string[];
  logLevel: z.infer<typeof envSchema>['KEEPER_LOG_LEVEL'];
  /** PRICING_NYSE_HOLIDAYS, or null for the built-in table. */
  holidays: readonly string[] | null;
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
  };
}

export interface StartPricingOptions {
  env?: NodeJS.ProcessEnv;
  /** SEAM: replaces the RH_RPC feed reader. */
  spotReader?: SpotReader;
  /** SEAM: replaces the Cboe download. */
  fetchChain?: FetchChain;
  settings?: Partial<PricingSettings>;
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
    ...(process.stdout.isTTY === true ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
  const service = new PricingService({
    markets: registry.markets,
    spotReader: options.spotReader ?? createFeedSpotReader(env.rpcUrls),
    chains: options.fetchChain === undefined ? {} : { fetchChain: options.fetchChain },
    settings: {
      ...(registry.maxPriceAgeS === null ? {} : { maxChainAgeS: registry.maxPriceAgeS, maxSpotAgeS: registry.maxPriceAgeS }),
      ...(registry.maxSpotDivergenceBps === null ? {} : { maxSpotDivergenceBps: registry.maxSpotDivergenceBps }),
      ...(env.holidays === null ? {} : { holidays: env.holidays }),
      ...options.settings,
    },
    log,
  });
  const app = createPricingApp(service, log);
  const server = await new Promise<ServerType>((resolveServer) => {
    const s = serve({ fetch: app.fetch, port: env.port }, () => resolveServer(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : env.port;
  log.info({ port, markets: registry.markets.size, registry: env.registryPath }, 'pricing service listening');
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
