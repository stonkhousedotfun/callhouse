/**
 * `pnpm --filter @callhouse/keeper v2:pricing-coverage -- [flags]`: the pricing-coverage report (coverage.ts) as a
 * command. It prices every rung of the cranker's ladder in process and prints the result; it holds no key, sends no
 * transaction and writes no registry. See USAGE for flags and exit codes.
 *
 * Environment (like pricing/main.ts; blank values are unset):
 *   V2_REGISTRY_PATH       default ../ops/markets/tier1.json, resolved against the keeper package directory
 *   RH_RPC, RH_RPC_2       the Stock Token feed reads (ladder centre and prices) and, with `--calendar chain`,
 *                          ExpiryCalendar.nextExpiry. Required unless every read is injected (tests)
 *   PRICING_NYSE_HOLIDAYS  optional YYYY-MM-DD full-day closures replacing calendar.ts NYSE_HOLIDAYS_2026_2028
 * The option chains come from Cboe's public delayed file, the pricing service's default provider, and are cached per
 * ticker for five minutes (cboe.ts PRICING_MIN_REFETCH_MS) whatever `--watch` interval is asked for.
 *
 * `runCoverageCli(argv, deps)` is the whole command with every seam injectable: tests pass a fake provider, fixed feed
 * rounds, a clock and output sinks, and touch no network.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, fallback, http, parseUnits, type Address } from 'viem';
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import type { NextExpiryRead } from '../cranker/planner.js';
import { V2_MARKET_STATUSES, parseV2Registry, type V2MarketStatus } from '../registry.js';
import { redactUrls } from '../tx.js';
import { createCboeProvider } from './cboe.js';
import type { OptionChainProvider } from './chain.js';
import {
  CoverageUsageError,
  PROPOSED_HOUSE_FLOOR_USDG6,
  f1Inputs,
  jsonLines,
  localNextExpiry,
  parseEventCalendar,
  quoteReadiness,
  renderTable,
  runCoverage,
  selectMarkets,
  suggestLadders,
  summarize,
  toJsonLine,
  toServiceEventCalendar,
  watchLines,
  type CoverageOptions,
  type EventCalendar,
  type RenderedReport,
} from './coverage.js';
import { PricingService } from './fair.js';
import { DEFAULT_REGISTRY_PATH, KEEPER_PACKAGE_DIR } from './main.js';
import { parsePricingRegistry } from './markets.js';
import { createFeedSpotReader, type SpotReader } from './spot.js';

export const USAGE = `Usage: pnpm --filter @callhouse/keeper v2:pricing-coverage -- [flags]

Prices every rung of the cranker's ladder (each daily and weekly expiry, each strike) in process through the
pricing service. Derived report only: it never writes the registry and sends nothing.

  --mode diagnostic|quote-readiness  diagnostic (default) always exits 0 and always prints the F1 registration
                                     inputs; quote-readiness exits 1 unless every enabled series is ready and
                                     lists the failing series
  --tickers NVDA,TSLA                these v2 markets, whatever their status
  --status live[,planned,paused]     otherwise every v2 market with one of these statuses (default: live)
  --floor 0.05                       house floor, USDG fair (default 0.05: the F3 D9 PROPOSAL, not approved)
  --calendar chain|local             expiries from the on-chain ExpiryCalendar (default when the registry has its
                                     address) or a local mirror of its grid on the NYSE holiday table
  --events <file.json>               event calendar, e.g. {"NVDA":[{"kind":"earnings","date":"YYYY-MM-DD",
                                     "session":"after-close"}]} or {"at":<unix s>}; flags event-uncertainty
  --suggest                          derived overrides.ladder and strike-tick flags (printed, never written;
                                     never an expiriesAhead change, so never a daily turned off)
  --format table|jsonl               stdout format (default table)
  --out <file>                       also append the JSON lines to <file>; with --watch the lines go only there
  --watch <seconds>                  refresh every <seconds>: one JSON line per market per refresh with the
                                     chain's clocks, ages and refusal state
  --iterations <n>                   with --watch: stop after n refreshes (default: run until interrupted)
  -h, --help

Environment: V2_REGISTRY_PATH (default ../ops/markets/tier1.json), RH_RPC (required), RH_RPC_2,
PRICING_NYSE_HOLIDAYS. Exit codes: 0 report produced, 1 not quote-ready (quote-readiness mode), 2 usage or
configuration error.`;

export interface CoverageArgs {
  mode: 'diagnostic' | 'quote-readiness';
  tickers: string[] | null;
  statuses: V2MarketStatus[];
  floorUsdg6: bigint;
  calendar: 'chain' | 'local' | null;
  eventsPath: string | null;
  suggest: boolean;
  format: 'table' | 'jsonl';
  out: string | null;
  watchS: number | null;
  iterations: number | null;
  help: boolean;
}

const positiveInt = (flag: string, raw: string): number => {
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new CoverageUsageError(`${flag}: a positive integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
};

/** Parse the flags. Throws CoverageUsageError naming the bad one. A bare `--` (pnpm's separator) is ignored. */
export function parseCoverageArgs(argv: readonly string[]): CoverageArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.filter((a) => a !== '--'),
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: 'string' },
        tickers: { type: 'string' },
        status: { type: 'string' },
        floor: { type: 'string' },
        calendar: { type: 'string' },
        events: { type: 'string' },
        suggest: { type: 'boolean' },
        format: { type: 'string' },
        out: { type: 'string' },
        watch: { type: 'string' },
        iterations: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new CoverageUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  const mode = values.mode ?? 'diagnostic';
  if (mode !== 'diagnostic' && mode !== 'quote-readiness') throw new CoverageUsageError(`--mode: diagnostic or quote-readiness, got ${JSON.stringify(mode)}`);
  const format = values.format ?? 'table';
  if (format !== 'table' && format !== 'jsonl') throw new CoverageUsageError(`--format: table or jsonl, got ${JSON.stringify(format)}`);
  const calendar = values.calendar ?? null;
  if (calendar !== null && calendar !== 'chain' && calendar !== 'local') throw new CoverageUsageError(`--calendar: chain or local, got ${JSON.stringify(calendar)}`);
  const list = (raw: string) => raw.split(',').map((t) => t.trim()).filter((t) => t !== '');
  const tickers = values.tickers === undefined ? null : list(values.tickers.toUpperCase());
  if (tickers !== null && tickers.length === 0) throw new CoverageUsageError('--tickers: at least one ticker');
  const statuses = values.status === undefined ? (['live'] as V2MarketStatus[]) : list(values.status);
  for (const s of statuses) if (!(V2_MARKET_STATUSES as readonly string[]).includes(s)) throw new CoverageUsageError(`--status: one of ${V2_MARKET_STATUSES.join(', ')}, got ${JSON.stringify(s)}`);
  if (statuses.length === 0) throw new CoverageUsageError('--status: at least one status');
  let floorUsdg6 = PROPOSED_HOUSE_FLOOR_USDG6;
  if (values.floor !== undefined) {
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(values.floor)) throw new CoverageUsageError(`--floor: a USDG amount with at most 6 decimals, got ${JSON.stringify(values.floor)}`);
    floorUsdg6 = parseUnits(values.floor, 6);
  }
  const watchS = values.watch === undefined ? null : positiveInt('--watch', values.watch);
  const iterations = values.iterations === undefined ? null : positiveInt('--iterations', values.iterations);
  if (iterations !== null && watchS === null) throw new CoverageUsageError('--iterations only applies with --watch');
  if (watchS !== null && mode === 'quote-readiness') throw new CoverageUsageError('--watch reports chain state per refresh; run --mode quote-readiness without it');
  if (watchS !== null && values.suggest === true) throw new CoverageUsageError('--suggest belongs to a single report, not --watch');
  return {
    mode,
    tickers,
    statuses: statuses as V2MarketStatus[],
    floorUsdg6,
    calendar,
    eventsPath: values.events ?? null,
    suggest: values.suggest === true,
    format,
    out: values.out ?? null,
    watchS,
    iterations,
    help: values.help === true,
  };
}

interface CoverageEnv {
  registryPath: string;
  rpcUrls: string[];
  holidays: readonly string[] | null;
}

function coverageEnv(env: NodeJS.ProcessEnv): CoverageEnv {
  const get = (key: string) => {
    const v = env[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const problems: string[] = [];
  const rpcUrls: string[] = [];
  for (const key of ['RH_RPC', 'RH_RPC_2']) {
    const raw = get(key);
    if (raw === undefined) continue;
    let ok = false;
    try {
      ok = ['http:', 'https:'].includes(new URL(raw).protocol);
    } catch {
      ok = false;
    }
    if (ok) rpcUrls.push(raw);
    else problems.push(`${key}: not an http(s) URL (value not shown)`);
  }
  let holidays: string[] | null = null;
  const rawHolidays = get('PRICING_NYSE_HOLIDAYS');
  if (rawHolidays !== undefined) {
    holidays = rawHolidays.split(',').map((d) => d.trim()).filter((d) => d !== '');
    for (const d of holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) problems.push(`PRICING_NYSE_HOLIDAYS: not a YYYY-MM-DD date: ${d}`);
    }
  }
  if (problems.length > 0) throw new CoverageUsageError(`the environment is not usable:\n  ${problems.join('\n  ')}`);
  return { registryPath: resolve(KEEPER_PACKAGE_DIR, get('V2_REGISTRY_PATH') ?? DEFAULT_REGISTRY_PATH), rpcUrls, holidays };
}

/** ExpiryCalendar.nextExpiry on chain, the read the cranker makes (cranker/steps.ts). Keyless. */
export function createChainNextExpiry(rpcUrls: readonly string[], address: Address, timeoutMs = 10_000): NextExpiryRead {
  const transports = rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount: 1 }));
  const client = createPublicClient({ transport: transports.length === 1 ? transports[0]! : fallback(transports) });
  return async (afterTs, weekly) => Number(await client.readContract({ address, abi: expiryCalendarAbi, functionName: 'nextExpiry', args: [afterTs, weekly] }));
}

export interface CoverageCliDeps {
  env?: NodeJS.ProcessEnv;
  /** SEAM: file reads (the registry, the event calendar). */
  readFile?: (path: string) => string;
  /** SEAM: the data provider (default: Cboe's delayed file). */
  provider?: OptionChainProvider;
  /** SEAM: the Stock Token feed read (default: RH_RPC). */
  spotReader?: SpotReader;
  /** SEAM: replaces both calendars. */
  nextExpiry?: NextExpiryRead;
  nowMs?: () => number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  appendFile?: (path: string, text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** The command. Resolves to the exit code; never throws. */
export async function runCoverageCli(argv: readonly string[], deps: CoverageCliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const appendFile = deps.appendFile ?? ((path: string, text: string) => appendFileSync(path, text));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const nowMs = deps.nowMs ?? Date.now;

  let args: CoverageArgs;
  let options: CoverageOptions;
  let service: PricingService;
  try {
    args = parseCoverageArgs(argv);
    if (args.help) {
      stdout(`${USAGE}\n`);
      return 0;
    }
    const env = coverageEnv(deps.env ?? process.env);
    let json: unknown;
    try {
      json = JSON.parse(readFile(env.registryPath));
    } catch (error) {
      throw new CoverageUsageError(`cannot read the market registry at ${env.registryPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const registry = parseV2Registry(json, env.registryPath);
    const pricing = parsePricingRegistry(json);
    // An unknown or non-v2 ticker is a usage error, found before anything is read.
    selectMarkets(registry, { tickers: args.tickers, statuses: args.statuses });
    const holidays = env.holidays ?? NYSE_HOLIDAYS_2026_2028;

    let nextExpiry: NextExpiryRead;
    let expirySource: string;
    const calendarAddress = registry.contracts.expiryCalendar;
    const calendar = args.calendar ?? (calendarAddress === null ? 'local' : 'chain');
    if (deps.nextExpiry !== undefined) {
      nextExpiry = deps.nextExpiry;
      expirySource = 'injected';
    } else if (calendar === 'chain') {
      if (calendarAddress === null) throw new CoverageUsageError('--calendar chain: the registry has no v2.contracts.expiryCalendar; use --calendar local');
      if (env.rpcUrls.length === 0) throw new CoverageUsageError('RH_RPC is required to read the ExpiryCalendar (or use --calendar local)');
      nextExpiry = createChainNextExpiry(env.rpcUrls, calendarAddress);
      expirySource = `chain:${calendarAddress}`;
    } else {
      nextExpiry = localNextExpiry(holidays);
      expirySource = 'local-mirror';
    }
    if (deps.spotReader === undefined && env.rpcUrls.length === 0) throw new CoverageUsageError('RH_RPC is required: the Stock Token feeds are read there');
    const spotReader = deps.spotReader ?? createFeedSpotReader(env.rpcUrls);
    const provider = deps.provider ?? createCboeProvider();
    let events: EventCalendar | null = null;
    if (args.eventsPath !== null) {
      try {
        events = parseEventCalendar(JSON.parse(readFile(args.eventsPath)));
      } catch (error) {
        throw new CoverageUsageError(`--events ${args.eventsPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    service = new PricingService({
      markets: pricing.markets,
      spotReader,
      chains: { provider },
      // The --events calendar is the single source of truth for event-uncertainty: the service
      // flags and bounds it (K3-312); the rungs report the service's reasons verbatim and only add
      // which events a rung spans and its early-close day, which the service does not say.
      ...(events === null ? {} : { events: toServiceEventCalendar(events) }),
      settings: {
        ...(pricing.maxPriceAgeS === null ? {} : { maxChainAgeS: pricing.maxPriceAgeS, maxSpotAgeS: pricing.maxPriceAgeS }),
        ...(pricing.maxSpotDivergenceBps === null ? {} : { maxSpotDivergenceBps: pricing.maxSpotDivergenceBps }),
        holidays,
      },
      nowMs,
    });
    options = {
      registry,
      service,
      provider: provider.descriptor,
      spotReader,
      nextExpiry,
      expirySource,
      nowMs,
      selection: { tickers: args.tickers, statuses: args.statuses },
      floorUsdg6: args.floorUsdg6,
      events,
    };
  } catch (error) {
    stderr(`${redactUrls(error instanceof Error ? error.message : String(error))}\n\n${USAGE}\n`);
    return 2;
  }

  try {
    if (args.watchS !== null) {
      const out = args.out;
      const write = out === null ? (line: string) => stdout(`${line}\n`) : (line: string) => appendFile(out, `${line}\n`);
      for (let i = 1; ; i += 1) {
        const report = await runCoverage(options);
        for (const line of watchLines(report, i)) write(toJsonLine(line));
        if (args.iterations !== null && i >= args.iterations) return 0;
        await sleep(args.watchS * 1000);
      }
    }
    const report = await runCoverage(options);
    const summaries = summarize(report);
    const rendered: RenderedReport = {
      report,
      summaries,
      f1: f1Inputs(report),
      readiness: quoteReadiness(report, summaries),
      suggestions: args.suggest ? await suggestLadders(report, service) : null,
    };
    const lines = jsonLines(rendered, args.mode);
    if (args.out !== null) appendFile(args.out, `${lines.join('\n')}\n`);
    stdout(`${args.format === 'jsonl' ? lines.join('\n') : renderTable(rendered, args.mode)}\n`);
    return args.mode === 'quote-readiness' && !rendered.readiness.ready ? 1 : 0;
  } catch (error) {
    // A selection problem found while running (an unknown ticker) is a usage error; anything else is a bug, reported.
    stderr(`${error instanceof CoverageUsageError ? '' : 'pricing coverage failed: '}${redactUrls(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}

/*//////////////////////////////////////////////////////////////
                               MAIN
//////////////////////////////////////////////////////////////*/

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runCoverageCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`\n${redactUrls(error instanceof Error ? error.message : String(error))}\n\n`);
      process.exit(2);
    },
  );
}
