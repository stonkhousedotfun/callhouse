/**
 * The price a page SHOWS for a market, always a number when anything can price it ("it
 * should always be available"). Mirrors callhouse-site (lib/spotFallback.ts, lib/chainPrice.ts):
 *   1. the API's spot (/v2/markets), when present;
 *   2. the market's Chainlink feed (`latestRoundData`);
 *   3. the market's Uniswap v3 pool (`slot0`);
 *   4. the last good price this server saw, with the time it was true.
 *
 * DISPLAY ONLY. Nothing here may reach a quote, an order, a slippage bound or a trade enable/disable decision: those
 * keep the strict live spot (`selectTradeSpot` in ./marketSpot, the oracle read in ./chainReads). A Chainlink stock feed
 * stops printing outside US market hours and the oracle refuses an old print, so the strict spot is null every night
 * and weekend; this module fills the DISPLAY gap and says how old the number is, and never feeds it anywhere else.
 *
 * Chain reads run on the server only (app/api/v2/spot), over the chain's public RPC or a server-only `CHAIN_RPC_URL`,
 * never a NEXT_PUBLIC keyed URL, and are reused for MEMO_S seconds.
 */
import { useQuery } from "@tanstack/react-query";

import { USDG } from "../contracts";
import { v2Markets } from "../markets";
import { localClock, localStamp } from "./time";

export type DisplaySource = "api" | "chainlink" | "pool" | "cached";
/** A price in USDG base units (6 dp) per whole share, when it was true (unix seconds), and where it came from. */
export type DisplaySpot = { raw: bigint; updatedAt: number; source: DisplaySource };

/** Seconds a chain read is reused before the RPC is asked again. */
export const MEMO_S = 45;
/**
 * A Chainlink answer older than this is not SHOWN; the pool is asked instead. DISPLAY-ONLY cutoff, not the oracle's
 * rule: 26 h is ChainlinkFeedSource's `DEFAULT_MAX_STALE` (and the registry's `v2.defaults.chainlinkMaxStaleS`), but
 * the oracle's bound is each feed's `maxStale`, which the config admin can set per feed (`setFeed`, 1 h to 7 d). This
 * module does not read that live, so a market whose feed is set differently can be shown a price the oracle would
 * refuse, or skip one it would accept. Nothing here decides a trade (see the header), so that is a display nuance only.
 */
export const MAX_FEED_AGE_S = 26 * 60 * 60;
/** A price older than this reads "last close price" rather than just "updated". */
export const LAST_CLOSE_AFTER_S = 60 * 60;
/** Chain 4663's public RPC. Server-only use. */
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

/** Where a market's price can be read on chain. Built from the app's compiled registry, never typed in. */
export type ChainSource = { feed: string; pool: string | null; stockIsToken0: boolean };

/** `eth_call` returning the hex result, or null on any failure. Injectable so tests never touch the network. */
export type Rpc = (to: string, data: string) => Promise<string | null>;

/** The chain readers, injectable so tests never touch the network. */
export type Readers = {
  chainlink: (source: ChainSource, now: number) => Promise<{ raw: bigint; updatedAt: number } | null>;
  pool: (source: ChainSource, now: number) => Promise<{ raw: bigint; updatedAt: number } | null>;
  now: () => number;
};

const SELECTOR = { decimals: "0x313ce567", latestRoundData: "0xfeaf968c", slot0: "0x3850c7bd" } as const;
const Q192 = 1n << 192n;
const SHARE = 10n ** 18n; // Stock Tokens have 18 decimals
const MAX_PRICE = (1n << 128n) - 1n;

/** Plain `eth_call` over fetch on the server's RPC. Server-only: `CHAIN_RPC_URL` is never a NEXT_PUBLIC variable. */
export const serverRpc: Rpc = async (to, data) => {
  const url = process.env.CHAIN_RPC_URL?.trim() || PUBLIC_RPC_URL;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { result?: unknown };
    return typeof body.result === "string" && /^0x([0-9a-fA-F]{64})+$/.test(body.result) ? body.result : null;
  } catch {
    return null;
  }
};

function word(hex: string, index: number): bigint | null {
  const start = 2 + index * 64;
  if (hex.length < start + 64) return null;
  return BigInt(`0x${hex.slice(start, start + 64)}`);
}

function signed(value: bigint): bigint {
  return value >= 1n << 255n ? value - (1n << 256n) : value;
}

/** A feed answer with `decimals` decimals as USDG base units (6 dp), floored. Null for a non-positive answer. */
export function toUsdg6(answer: bigint, decimals: number): bigint | null {
  if (answer <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
  const price = decimals >= 6 ? answer / 10n ** BigInt(decimals - 6) : answer * 10n ** BigInt(6 - decimals);
  return price > 0n && price <= MAX_PRICE ? price : null;
}

/**
 * A v3 pool's `slot0.sqrtPriceX96` as USDG base units per whole share. Raw price = sqrtPriceX96^2 / 2^192 = token1
 * base units per token0 base unit; the Stock Token has 18 decimals and USDG 6.
 */
export function poolPriceUsdg6(sqrtPriceX96: bigint, stockIsToken0: boolean): bigint | null {
  if (sqrtPriceX96 <= 0n) return null;
  const squared = sqrtPriceX96 * sqrtPriceX96;
  const price = stockIsToken0 ? (squared * SHARE) / Q192 : (Q192 * SHARE) / squared;
  return price > 0n && price <= MAX_PRICE ? price : null;
}

/** The feed's latest answer, or null when unreadable, not positive, or older than MAX_FEED_AGE_S. */
export async function chainlinkPrice(feed: string, now: number, rpc: Rpc = serverRpc) {
  const [dec, round] = await Promise.all([rpc(feed, SELECTOR.decimals), rpc(feed, SELECTOR.latestRoundData)]);
  if (!dec || !round) return null;
  const decimals = word(dec, 0);
  const answer = word(round, 1);
  const updatedAt = word(round, 3);
  if (decimals === null || answer === null || updatedAt === null || decimals > 77n) return null;
  const at = Number(updatedAt);
  if (!Number.isSafeInteger(at) || at <= 0 || at > now + 60 || now - at > MAX_FEED_AGE_S) return null;
  const raw = toUsdg6(signed(answer), Number(decimals));
  return raw === null ? null : { raw, updatedAt: at };
}

/** The pool's price now (`slot0`), or null when there is no pool or it cannot be read. */
export async function poolPrice(source: ChainSource, now: number, rpc: Rpc = serverRpc) {
  if (!source.pool) return null;
  const slot0 = await rpc(source.pool, SELECTOR.slot0);
  const sqrt = slot0 ? word(slot0, 0) : null;
  if (sqrt === null) return null;
  const raw = poolPriceUsdg6(sqrt & ((1n << 160n) - 1n), source.stockIsToken0);
  return raw === null ? null : { raw, updatedAt: now };
}

/**
 * Each registry market's feed and pool, from the compiled registry (lib/markets). A v3 pool sorts its tokens by
 * address, so the Stock Token is token0 exactly when its address is below USDG's.
 */
export function chainSources(usdg: string = USDG): Record<string, ChainSource> {
  const out: Record<string, ChainSource> = {};
  for (const market of v2Markets()) {
    out[market.ticker] = {
      feed: market.feed,
      pool: market.v2.univ3Pool,
      stockIsToken0: BigInt(market.asset) < BigInt(usdg),
    };
  }
  return out;
}

export const chainReaders: Readers = {
  chainlink: (source, now) => chainlinkPrice(source.feed, now),
  pool: (source, now) => poolPrice(source, now),
  now: () => Math.floor(Date.now() / 1000),
};

const lastGood = new Map<string, DisplaySpot>();
const memo = new Map<string, { at: number; value: DisplaySpot | null }>();

/** Forget every cached and reused price (tests). */
export function resetDisplayCache(): void {
  lastGood.clear();
  memo.clear();
}

async function chainSpot(ticker: string, source: ChainSource | undefined, readers: Readers, now: number) {
  if (!source) return null;
  const hit = memo.get(ticker);
  if (hit && now - hit.at < MEMO_S) return hit.value;
  let value: DisplaySpot | null = null;
  const feed = await readers.chainlink(source, now).catch(() => null);
  if (feed) value = { raw: feed.raw, updatedAt: feed.updatedAt, source: "chainlink" };
  else {
    const pool = await readers.pool(source, now).catch(() => null);
    if (pool) value = { raw: pool.raw, updatedAt: pool.updatedAt, source: "pool" };
  }
  memo.set(ticker, { at: now, value });
  return value;
}

/**
 * The price to SHOW for `ticker`: the API's spot when present, else Chainlink, else the pool, else the last good price
 * this server saw (source "cached"). Null only when nothing has ever priced this market here.
 */
export async function resolveDisplaySpot(
  ticker: string,
  api: { raw: bigint; updatedAt: number } | null,
  readers: Readers = chainReaders,
  sources: Record<string, ChainSource> = chainSources(),
): Promise<DisplaySpot | null> {
  const now = readers.now();
  const value: DisplaySpot | null = api !== null && api.raw > 0n
    ? { raw: api.raw, updatedAt: api.updatedAt, source: "api" }
    : await chainSpot(ticker, sources[ticker], readers, now);
  if (value) {
    lastGood.set(ticker, value);
    return value;
  }
  const cached = lastGood.get(ticker);
  return cached ? { ...cached, source: "cached" } : null;
}

/*//////////////////////////////////////////////////////////////
                          THE CLIENT SIDE
//////////////////////////////////////////////////////////////*/

/** One row of GET /api/v2/spot. */
export type DisplaySpotRow = { ticker: string; raw: string; updatedAt: number; source: DisplaySource };

const SOURCES: ReadonlySet<string> = new Set(["api", "chainlink", "pool", "cached"]);

/** The route's rows by ticker; malformed rows are dropped, never shown. */
export function parseDisplaySpots(body: unknown): Map<string, DisplaySpot> {
  const out = new Map<string, DisplaySpot>();
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const row = item as Partial<DisplaySpotRow> | null;
    if (!row || typeof row.ticker !== "string" || typeof row.raw !== "string" || !/^\d+$/.test(row.raw) ||
        typeof row.updatedAt !== "number" || !Number.isSafeInteger(row.updatedAt) || row.updatedAt <= 0 ||
        typeof row.source !== "string" || !SOURCES.has(row.source) || BigInt(row.raw) === 0n) continue;
    out.set(row.ticker, { raw: BigInt(row.raw), updatedAt: row.updatedAt, source: row.source as DisplaySource });
  }
  return out;
}

/** The display prices for every registry market, from the server route, refreshed every 30 s. */
export function useDisplaySpots() {
  return useQuery({
    queryKey: ["v2", "display-spot"],
    queryFn: async () => {
      const response = await fetch("/api/v2/spot", { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`display spot route answered HTTP ${response.status}`);
      return parseDisplaySpots(await response.json());
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 1,
  });
}

/**
 * What a card or the hero shows: the page's own API spot when it has one (unchanged from before), else the server's
 * fallback row. DISPLAY ONLY: the result is never a trade or quote input.
 */
export function pickDisplaySpot(
  apiRaw: string | null | undefined,
  apiUpdatedAt: number | null | undefined,
  fallback: DisplaySpot | undefined,
): DisplaySpot | null {
  if (apiRaw && /^\d+$/.test(apiRaw) && BigInt(apiRaw) > 0n && typeof apiUpdatedAt === "number") {
    return { raw: BigInt(apiRaw), updatedAt: apiUpdatedAt, source: "api" };
  }
  return fallback ?? null;
}

/**
 * The plain freshness line under a displayed price, in the app's copy style: short, no jargon. Times are in
 * `timeZone`, zone named.
 * Callers pass the reader's zone from `useViewerTimeZone()`, and New York while it is not known yet (server render
 * and hydration, components/ui/Time.tsx). Examples in New York:
 *   api / fresh Chainlink  "updated 12:04 AM EDT"
 *   old Chainlink          "last close price, updated Sep 23, 1:59 PM EDT"
 *   pool                   "pool price, updated 12:04 AM EDT"
 *   cached                 "last known price, updated Sep 23, 1:59 PM EDT"
 * `now` <= 0 is a clock not read yet (useNow() is 0 until mount, so the server render and the first client
 * render). The age is unknown then, so an api or Chainlink line carries its date ("updated Sep 23, 1:59 PM EDT") rather
 * than the bare time that reads as current, and does not call it the last close either.
 */
export function displaySourceLine(spot: DisplaySpot, now: number, timeZone: string): string {
  const known = now > 0;
  const old = known && now - spot.updatedAt > LAST_CLOSE_AFTER_S;
  const clock = localClock(spot.updatedAt, timeZone);
  const moment = localStamp(spot.updatedAt, timeZone);
  switch (spot.source) {
    case "pool":
      return `pool price, updated ${clock}`;
    case "cached":
      return `last known price, updated ${moment}`;
    case "chainlink":
      return old ? `last close price, updated ${moment}` : known ? `updated ${clock}` : `updated ${moment}`;
    default:
      return old || !known ? `updated ${moment}` : `updated ${clock}`;
  }
}

/** USDG base units as dollars and cents, floored: 225_549_701n -> "225.54". */
export function usdgDollars(raw: bigint): string {
  const cents = raw / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
