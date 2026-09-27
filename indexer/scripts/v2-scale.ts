import { ladderSearchStart, ladderStrikes } from "../../keeper/src/v2/cranker/planner";
import { longIdOf } from "../../keeper/src/v2/seriesId";
import { nextExpiry, isWeeklyExpiry } from "../lib/v2/calendar";
import { V2_REGISTRY } from "../lib/v2/marketRegistry.generated";

/**
 * The approved launch set: the existing NVDA canary plus nineteen additions.
 * Keep this explicit. Registry order and wave labels also contain deferred markets, and must
 * never turn the optional 34-market stress case into a rollout commitment.
 */
export const SCALE_TICKERS = [
  "SPCX", "SPY", "NVDA", "MU", "QQQ", "SNDK", "AAPL", "MSFT", "INTC", "TSLA",
  "META", "AMD", "GOOGL", "AMZN", "MSTR", "PLTR", "DELL", "ORCL", "TSM", "CRWV",
] as const;

/** Friday 2027-01-15 03:00 America/New_York; the first daily and weekly close overlap. */
export const SCALE_HEAD = 1_800_000_000;
export const SCALE_SPOT = 200_000_000n;
/** Same order as keeper/src/v2/registry.ts TENORS and stepLadders. */
export const SCALE_TENORS = ["weekly", "daily"] as const;
/**
 * The load this harness measures: two weekly and three daily expiries per market, the registry's earlier shape.
 * The launch registry lists the next daily close only since 2026-09-23, but the
 * committed ceilings must keep covering the load a later decision to turn weeklies back on would bring, so the
 * harness states its own expiry counts instead of reading `defaults.expiriesAhead`. Ladders and strike ticks are still
 * the generated registry's.
 */
export const SCALE_EXPIRIES_AHEAD = { weekly: 2, daily: 3 } as const satisfies Record<"weekly" | "daily", number>;

/**
 * The launch set is NVDA and SPCX: the
 * generated registry carries the launch set only, so eighteen of the twenty targets are no longer registry rows. The
 * harness measures LOAD (twenty markets, 450 series), not those markets, so a target the registry does not carry is
 * a SYNTHETIC scale market: the registry's default ladder and 0 mint fee, calls only, a deterministic synthetic
 * underlying, and the strike tick that ticker had in indexer/lib/v2/marketRegistry.generated.ts when the baseline
 * was captured (copied from that file, not re-chosen), so the measured shape is the one
 * the committed baseline was captured on. A target the registry does carry (NVDA, SPCX) is read from it as before.
 */
export const SCALE_SYNTHETIC_TICKS: Readonly<Record<string, string>> = {
  SPY: "1000000", MU: "5000000", QQQ: "1000000", SNDK: "10000000", AAPL: "2500000", MSFT: "2500000",
  INTC: "500000", TSLA: "2500000", META: "2500000", AMD: "2500000", GOOGL: "2500000", AMZN: "2500000",
  MSTR: "1000000", PLTR: "2500000", DELL: "2500000", ORCL: "1000000", TSM: "2500000", CRWV: "1000000",
};

/** `0x5ca1e…<index>`: a deterministic address no registry names, one per synthetic target. */
function syntheticUnderlying(index: number): `0x${string}` {
  return `0x5ca1e${String(index).padStart(35, "0")}`;
}

export type ScaleTicker = (typeof SCALE_TICKERS)[number];
export type ScaleTenor = (typeof SCALE_TENORS)[number];
export type ScaleLadder = {
  rungs: number;
  firstOtmBps: number;
  stepBps: number;
  cardTargetBps: number;
};

type MarketOverrides = {
  ladder?: Partial<Record<ScaleTenor, Partial<ScaleLadder>>>;
  expiriesAhead?: Partial<Record<ScaleTenor, number>>;
};

export type ScaleMarket = {
  ticker: ScaleTicker;
  name: string;
  underlying: `0x${string}`;
  strikeTick: bigint;
  mintFeePpm: number;
  puts: boolean;
  ladder: Record<ScaleTenor, ScaleLadder>;
  expiriesAhead: Record<ScaleTenor, number>;
  strikes: Record<ScaleTenor, { calls: readonly bigint[]; puts: readonly bigint[] }>;
  dailySeries: number;
  weeklySeries: number;
  series: number;
};

export type ScaleSeries = {
  longId: bigint;
  market: ScaleMarket;
  tenor: ScaleTenor;
  isPut: boolean;
  strike: bigint;
  expiry: bigint;
};

export type ScaleShape = {
  markets: readonly ScaleMarket[];
  marketCount: number;
  additionCount: number;
  requestedSeriesCount: number;
  overlapDeduplicated: number;
  seriesCount: number;
  calls: number;
  puts: number;
  defaultExpiriesAhead: Readonly<Record<ScaleTenor, number>>;
  stressExpiriesAhead: Readonly<Record<ScaleTenor, number>>;
  expiries: Readonly<Record<ScaleTenor, readonly number[]>>;
};

export type ScalePlan = { shape: ScaleShape; series: readonly ScaleSeries[] };

function integer(value: number, label: string, allowZero: boolean): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1))
    throw new Error(`${label} must be ${allowZero ? "a nonnegative" : "a positive"} integer`);
  return value;
}

function upcomingExpiries(now: number, weekly: boolean, count: number,
  holidays: ReadonlyMap<number, boolean>): number[] {
  const out: number[] = [];
  let after = ladderSearchStart(now);
  while (out.length < count) {
    const expiry = nextExpiry(after, weekly, holidays);
    out.push(expiry);
    after = expiry;
  }
  return out;
}

/**
 * Resolve the generated target through the same expiry search, ladder maths, long-id formula and
 * keyed create-map deduplication used by stepLadders at the pinned head.
 */
export function scalePlan(holidays: ReadonlyMap<number, boolean>, now = SCALE_HEAD): ScalePlan {
  // Keyed by string: the generated ticker type is the launch set only, and most scale targets are not in it.
  const generated = new Map<string, (typeof V2_REGISTRY.markets)[number]>(V2_REGISTRY.markets.map((market) => [market.ticker, market]));
  const defaults = V2_REGISTRY.defaults;
  const markets = SCALE_TICKERS.map((ticker, index): ScaleMarket => {
    const registered = generated.get(ticker);
    const tick = SCALE_SYNTHETIC_TICKS[ticker];
    if (!registered && tick === undefined) throw new Error(`Scale target ${ticker} is neither in the generated indexer registry nor a synthetic scale market`);
    const market = registered ?? {
      name: `${ticker} (synthetic scale market)`,
      underlying: syntheticUnderlying(index),
      strikeTick: tick!,
      mintFeePpm: 0,
      puts: false,
      overrides: {},
    };
    const overrides = market.overrides as MarketOverrides;
    const strikeTick = BigInt(market.strikeTick);
    const ladder = Object.fromEntries(SCALE_TENORS.map((tenor) => {
      const resolved = { ...defaults.ladder[tenor], ...overrides.ladder?.[tenor] };
      integer(resolved.rungs, `${ticker}.${tenor}.rungs`, false);
      integer(resolved.firstOtmBps, `${ticker}.${tenor}.firstOtmBps`, true);
      integer(resolved.stepBps, `${ticker}.${tenor}.stepBps`, false);
      integer(resolved.cardTargetBps, `${ticker}.${tenor}.cardTargetBps`, false);
      return [tenor, resolved];
    })) as Record<ScaleTenor, ScaleLadder>;
    const expiriesAhead = Object.fromEntries(SCALE_TENORS.map((tenor) => [
      tenor,
      integer(SCALE_EXPIRIES_AHEAD[tenor], `${ticker}.${tenor}.expiriesAhead`, true),
    ])) as Record<ScaleTenor, number>;
    const strikes = Object.fromEntries(SCALE_TENORS.map((tenor) => [tenor, {
      calls: ladderStrikes(SCALE_SPOT, ladder[tenor], strikeTick, false),
      puts: market.puts ? ladderStrikes(SCALE_SPOT, ladder[tenor], strikeTick, true) : [],
    }])) as unknown as Record<ScaleTenor, { calls: readonly bigint[]; puts: readonly bigint[] }>;
    return {
      ticker,
      name: market.name,
      underlying: market.underlying,
      strikeTick,
      mintFeePpm: market.mintFeePpm,
      puts: market.puts,
      ladder,
      expiriesAhead,
      strikes,
      dailySeries: 0,
      weeklySeries: 0,
      series: 0,
    };
  });

  const maxAhead = Object.fromEntries(SCALE_TENORS.map((tenor) => [tenor,
    Math.max(...markets.map((market) => market.expiriesAhead[tenor]))])) as Record<ScaleTenor, number>;
  const expiries = {
    weekly: upcomingExpiries(now, true, maxAhead.weekly, holidays),
    daily: upcomingExpiries(now, false, maxAhead.daily, holidays),
  } satisfies Record<ScaleTenor, number[]>;
  const creates = new Map<string, Omit<ScaleSeries, "tenor">>();
  let requestedSeriesCount = 0;
  for (const market of markets) {
    for (const tenor of SCALE_TENORS) {
      for (const expiry of expiries[tenor].slice(0, market.expiriesAhead[tenor])) {
        for (const [isPut, strikes] of [[false, market.strikes[tenor].calls],
          [true, market.strikes[tenor].puts]] as const) {
          for (const strike of strikes) {
            requestedSeriesCount += 1;
            const longId = longIdOf(market.underlying, isPut, strike, expiry);
            // stepLadders uses this exact long-id key, so an overlapping daily/weekly tuple is one create.
            creates.set(longId.toString(), { longId, market, isPut, strike, expiry: BigInt(expiry) });
          }
        }
      }
    }
  }
  const series = [...creates.values()].map((item): ScaleSeries => ({
    ...item,
    tenor: isWeeklyExpiry(item.expiry, holidays) ? "weekly" : "daily",
  }));
  for (const market of markets) {
    const rows = series.filter((item) => item.market === market);
    market.dailySeries = rows.filter((item) => item.tenor === "daily").length;
    market.weeklySeries = rows.filter((item) => item.tenor === "weekly").length;
    market.series = rows.length;
  }
  const calls = series.filter((item) => !item.isPut).length;
  const puts = series.length - calls;
  return {
    shape: {
      markets,
      marketCount: markets.length,
      additionCount: markets.length - 1,
      requestedSeriesCount,
      overlapDeduplicated: requestedSeriesCount - series.length,
      seriesCount: series.length,
      calls,
      puts,
      defaultExpiriesAhead: defaults.expiriesAhead,
      stressExpiriesAhead: SCALE_EXPIRIES_AHEAD,
      expiries,
    },
    series,
  };
}

export function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("Cannot calculate p95 without samples");
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

export function roundedMs(value: number): number {
  return Math.round(value * 100) / 100;
}
