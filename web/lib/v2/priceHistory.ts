/**
 * Price history for the market page's Price view ("we also want live charts of
 * NVDA/SPCX, it can be 15 min old, that's ok, just the chart").
 *
 * SOURCE. GeckoTerminal's public OHLCV API, which indexes the market's registry pool (`markets[].v2.univ3Pool`, the
 * deep {Stock Token, USDG} Uniswap v3 pool) on network id `robinhood`. No key. The pool is read from the registry
 * through `getV2Market`, never written here, so a registry change of pool reaches the chart by regenerating
 * `markets.generated.ts`. The price is asked for the STOCK TOKEN (`token=<asset>`) in USD, and the answer's
 * `meta.base.address` must be that token: a pool whose sides are read the other way round would otherwise chart
 * 1 / price without any error.
 *
 * SERVER ONLY, BY DESIGN. The browser calls this app's own route (app/api/v2/price-history/route.ts), never
 * GeckoTerminal: the CSP does not allow the third party, every visitor would spend the free API's rate limit, and a
 * cached answer here serves every open page. One request per (pool, range) per CACHE_OK_S, a failure is remembered
 * for CACHE_FAIL_S so an outage is not hammered, and concurrent requests for the same key share one upstream call.
 *
 * NEVER SILENTLY STALE. Every answer carries `lastAt` (the newest candle's open time) and `fetchedAt`; the chart
 * prints both. GeckoTerminal serves candles up to about fifteen minutes late, which is accepted.
 */
import { getV2Market } from "@/lib/markets";

export const PRICE_RANGES = ["1D", "1W", "1M", "1Y"] as const;
export type PriceRange = (typeof PRICE_RANGES)[number];

/** How a range is asked for: the API's timeframe and aggregate, the candle width, the window and the row limit. */
export type RangeSpec = {
  timeframe: "minute" | "hour" | "day";
  aggregate: number;
  /** Candle width, seconds. */
  resolutionSec: number;
  /** How far back the range reaches, seconds. */
  spanSec: number;
  /** Rows asked for: one per candle in the span, plus one for the candle the span starts inside. */
  limit: number;
};

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

function spec(timeframe: RangeSpec["timeframe"], aggregate: number, resolutionSec: number, spanSec: number): RangeSpec {
  return { timeframe, aggregate, resolutionSec, spanSec, limit: Math.ceil(spanSec / resolutionSec) + 1 };
}

/**
 * 1D in 15-minute candles, 1W hourly, 1M in 4-hour candles, 1Y daily. The API allows minute aggregates 1/5/15,
 * hour 1/4/12 and day 1, and at most 1000 rows; every limit here is well under it.
 */
export const RANGE_SPECS: Readonly<Record<PriceRange, RangeSpec>> = {
  "1D": spec("minute", 15, 15 * MINUTE, DAY),
  "1W": spec("hour", 1, HOUR, 7 * DAY),
  "1M": spec("hour", 4, 4 * HOUR, 30 * DAY),
  "1Y": spec("day", 1, DAY, 365 * DAY),
};

export function isPriceRange(value: unknown): value is PriceRange {
  return typeof value === "string" && (PRICE_RANGES as readonly string[]).includes(value);
}

export const GECKO_API = "https://api.geckoterminal.com/api/v2";
export const GECKO_NETWORK = "robinhood";

/** The OHLCV request for `pool`, priced in USD for `token`. */
export function geckoOhlcvUrl(pool: string, token: string, s: RangeSpec): string {
  const q = new URLSearchParams({ aggregate: String(s.aggregate), limit: String(s.limit), currency: "usd", token });
  return `${GECKO_API}/networks/${GECKO_NETWORK}/pools/${pool}/ohlcv/${s.timeframe}?${q}`;
}

/** The pool's public page, for the attribution link. */
export function geckoPoolPage(pool: string): string {
  return `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${pool}`;
}

/** One candle: open time (unix seconds) and USD prices. */
export type Candle = { t: number; o: number; h: number; l: number; c: number };

export class PriceHistoryError extends Error {
  /** `status` is the route's answer for this failure: 504 for a timeout, 502 for anything else the source did. */
  constructor(message: string, readonly retryable: boolean, readonly status = 502) {
    super(message);
    this.name = "PriceHistoryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The API's answer as candles, oldest first, inside the range's window. Refuses (PriceHistoryError) an answer that
 * is not the documented shape, prices another token, carries a non-finite or non-positive price, or has no candle
 * inside the window. Duplicate open times keep the last row the API sent.
 */
export function normaliseOhlcv(json: unknown, opts: { token: string; spanSec: number; now: number }): Candle[] {
  const list = isRecord(json) && isRecord(json.data) && isRecord(json.data.attributes)
    ? json.data.attributes.ohlcv_list : undefined;
  if (!Array.isArray(list)) throw new PriceHistoryError("The price source answered in an unexpected shape.", true);

  const base = isRecord(json) && isRecord(json.meta) && isRecord(json.meta.base) ? json.meta.base.address : undefined;
  if (typeof base !== "string" || base.toLowerCase() !== opts.token.toLowerCase()) {
    throw new PriceHistoryError("The price source priced a different token than this market's.", false);
  }

  const byTime = new Map<number, Candle>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) throw new PriceHistoryError("The price source sent a malformed candle.", true);
    const [t, o, h, l, c] = row.slice(0, 5).map(Number);
    if (!Number.isSafeInteger(t) || t <= 0 || ![o, h, l, c].every((p) => Number.isFinite(p) && p > 0)) {
      throw new PriceHistoryError("The price source sent a malformed candle.", true);
    }
    byTime.set(t, { t, o, h, l, c });
  }
  const from = opts.now - opts.spanSec;
  const candles = [...byTime.values()].filter((k) => k.t >= from && k.t <= opts.now).sort((a, b) => a.t - b.t);
  if (candles.length === 0) throw new PriceHistoryError("The price source has no candles for this range yet.", true);
  return candles;
}

export type PriceHistoryOk = {
  ok: true;
  ticker: string;
  range: PriceRange;
  resolutionSec: number;
  pool: string;
  candles: Candle[];
  /** Open time of the oldest and newest candle, unix seconds. */
  firstAt: number;
  lastAt: number;
  /** When this server read the source, unix seconds. */
  fetchedAt: number;
  source: "GeckoTerminal";
  sourceUrl: string;
};

export type PriceHistoryFail = { ok: false; ticker: string | null; range: string | null; error: string; retryable: boolean };

export type PriceHistoryBody = PriceHistoryOk | PriceHistoryFail;

export type PriceHistoryAnswer = { status: number; body: PriceHistoryBody };

/** A good answer is reused this long, seconds; a failure this long, so an outage is not hammered. */
export const CACHE_OK_S = 180;
export const CACHE_FAIL_S = 30;
/** The upstream deadline, milliseconds: well inside what a browser waits for the route. */
export const UPSTREAM_TIMEOUT_MS = 6_000;

type Entry = { answer: PriceHistoryAnswer; at: number };

/** Per-process answers keyed by pool and range, and the in-flight upstream call per key. */
export type PriceHistoryCache = { entries: Map<string, Entry>; inflight: Map<string, Promise<PriceHistoryAnswer>> };

export function createPriceHistoryCache(): PriceHistoryCache {
  return { entries: new Map(), inflight: new Map() };
}

export type PriceHistoryDeps = {
  fetch: typeof fetch;
  /** Unix seconds. */
  now: () => number;
  cache: PriceHistoryCache;
  timeoutMs?: number;
  /** Ticker to pool and token; the registry's by default. */
  market?: (ticker: string) => { ticker: string; pool: string | null; token: string } | undefined;
};

function registryMarket(ticker: string): { ticker: string; pool: string | null; token: string } | undefined {
  const m = getV2Market(ticker);
  return m ? { ticker: m.ticker, pool: m.v2.univ3Pool, token: m.asset } : undefined;
}

function fail(status: number, ticker: string | null, range: string | null, error: string, retryable: boolean): PriceHistoryAnswer {
  return { status, body: { ok: false, ticker, range, error, retryable } };
}

async function readUpstream(url: string, deps: PriceHistoryDeps): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, { signal: controller.signal, headers: { accept: "application/json" }, redirect: "error", cache: "no-store" });
    if (res.status === 429) throw new PriceHistoryError("The price source is rate limiting requests; try again shortly.", true);
    if (!res.ok) throw new PriceHistoryError(`The price source answered HTTP ${res.status}.`, true);
    return await res.json();
  } catch (error) {
    if (error instanceof PriceHistoryError) throw error;
    if (controller.signal.aborted) throw new PriceHistoryError("The price source did not answer in time.", true, 504);
    throw new PriceHistoryError("The price source could not be reached.", true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/v2/price-history?ticker=&range= as data: 400 for a missing or unknown range, 404 for a ticker outside the
 * app's markets or one with no pool, 200 with candles, 502/504 when the source fails (the chart then falls back to the
 * live spot). Nothing from the request reaches the upstream URL except through the registry lookup and RANGE_SPECS.
 */
export async function servePriceHistory(
  query: { ticker: string | null; range: string | null },
  deps: PriceHistoryDeps,
): Promise<PriceHistoryAnswer> {
  const { ticker, range } = query;
  if (!isPriceRange(range)) return fail(400, ticker, range, `Unknown range; use one of ${PRICE_RANGES.join(", ")}.`, false);
  const market = ticker ? (deps.market ?? registryMarket)(ticker) : undefined;
  if (!market) return fail(404, ticker, range, "Unknown market.", false);
  if (!market.pool) return fail(404, market.ticker, range, `${market.ticker} has no pool to chart.`, false);

  const key = `${market.pool.toLowerCase()}|${range}`;
  const now = deps.now();
  const hit = deps.cache.entries.get(key);
  if (hit && now - hit.at < (hit.answer.body.ok ? CACHE_OK_S : CACHE_FAIL_S)) return hit.answer;

  const running = deps.cache.inflight.get(key);
  if (running) return running;

  const s = RANGE_SPECS[range];
  const pool = market.pool;
  const call = (async (): Promise<PriceHistoryAnswer> => {
    try {
      const json = await readUpstream(geckoOhlcvUrl(pool, market.token, s), deps);
      const fetchedAt = deps.now();
      const candles = normaliseOhlcv(json, { token: market.token, spanSec: s.spanSec, now: fetchedAt });
      return {
        status: 200,
        body: {
          ok: true, ticker: market.ticker, range, resolutionSec: s.resolutionSec, pool, candles,
          firstAt: candles[0].t, lastAt: candles[candles.length - 1].t, fetchedAt,
          source: "GeckoTerminal", sourceUrl: geckoPoolPage(pool),
        },
      };
    } catch (error) {
      const e = error instanceof PriceHistoryError ? error : new PriceHistoryError("The price history could not be read.", true);
      return fail(e.status, market.ticker, range, e.message, e.retryable);
    }
  })();
  deps.cache.inflight.set(key, call);
  try {
    const answer = await call;
    deps.cache.entries.set(key, { answer, at: deps.now() });
    return answer;
  } finally {
    deps.cache.inflight.delete(key);
  }
}

/** The route's process-wide cache. */
export const PRICE_HISTORY_CACHE: PriceHistoryCache = createPriceHistoryCache();

/** A candle close as the USDG 6-decimal integer the rest of the page uses. */
export function toUsdg6(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}
