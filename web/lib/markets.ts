import { getAddress, type Address, type Hex } from "viem";

import { ASSET, FACTORY } from "./contracts";
import { GENERATED_MARKETS, GENERATED_REGISTRY } from "./markets.generated";

/**
 * The markets, as the app sees them.
 *
 * ONE SOURCE. ops/markets/tier1.json is the registry; scripts/gen-markets.mjs compiles it into
 * lib/markets.generated.ts (committed, because the Docker build never sees ops/), and this module
 * is the typed view of that file every page reads. No page, component or lib may name a ticker, a
 * token or a factory of its own: it takes a `Market` from here, or the default one.
 *
 * LIVE IS THE ONLY THING A PAGE CAN OPEN. `MARKETS` is the live rows only, and `getMarket` /
 * `parseTickerParam` answer only for those, so a planned market's URL is a 404 rather than an
 * account page over a factory that does not exist yet. `ALL_MARKETS` exists for the landing and
 * the docs, which list what is coming, grouped by wave. A row turns live by editing `status` in
 * the registry once its factory is configured, re-running gen:markets and rebuilding: nothing in
 * the app changes.
 *
 * THE DEFAULT MARKET is NVDA, the first one, and it carries the app's pre-registry behaviour: the
 * bare /account and /book routes redirect to it, the nav points at it when no market is in the
 * URL, and the NEXT_PUBLIC_FACTORY / NEXT_PUBLIC_ASSET build-time overrides (lib/contracts.ts,
 * for a fork or a rehearsal deploy) apply to IT ALONE. Every other market is exactly what the
 * registry says; a rehearsal of a second market edits a copy of the registry instead
 * (scripts/gen-markets.mjs --registry). `DEFAULT_TICKER` is the one ticker this directory is
 * allowed to spell, and only here: it names which registry row the overrides land on. What the
 * pages treat as "the default" is `DEFAULT_MARKET`, which is that row while it is live and the
 * first live row otherwise (see `resolveDefaultMarket`), so pausing NVDA in the registry is a
 * registry edit and a rebuild, not a code change.
 *
 * `deployBlock` is a number, not a bigint: the generated file is `as const` JSON and a block
 * number is far inside 2^53. Convert at the call site that needs a bigint for eth_getLogs.
 *
 * TWO LIFECYCLES PER ROW. `status` is the v1 factory's: live, planned, paused, or
 * `superseded-by-v2`, which the 34 rows planned for their own factory became when that rollout was
 * cancelled (ADR-02) — never deployed, never a page, and not "coming next" on the v1 home either
 * (`plannedByWave` leaves them out). `v2` is the v2 market's (planned | live | paused, and a
 * rollout wave of its own), read through `v2Markets()` / `isV2Live()`. The v2 contract addresses,
 * fees and defaults are `V2_CONTRACTS`, `V2_FEES` and `V2_DEFAULTS` in the generated file.
 */
export type MarketStatus = "live" | "planned" | "paused" | "superseded-by-v2";
export type MarketWave = "live" | "canary" | "wave1" | "wave2";
export type MarketMode = "vol" | "fixed";

export type Market = {
  /** The Stock Token's symbol, the URL segment (lowercased) and every unit label. */
  ticker: string;
  /** The issuer's token name, e.g. "NVIDIA • Robinhood Token". */
  name: string;
  /** The Stock Token, 18 decimals, EIP-55. */
  asset: Address;
  /** The Chainlink proxy the factory prices against. Shown, never read by the browser. */
  feed: Address;
  /** The AccountFactory, or null until the market is configured. */
  factory: Address | null;
  /** The factory's deploy block, or null with the factory. */
  deployBlock: number | null;
  status: MarketStatus;
  wave: MarketWave;
  mode: MarketMode;
  /** Cboe's option root for the keeper's vol mode; usually the ticker. */
  cboeRoot: string;
  /** Per-account deposit cap in USD notional; null is uncapped. */
  depositCapUsd: number | null;
  /**
   * When the owner froze this market's v1 factory (writes halted, deposit cap 0), in unix seconds,
   * from the registry's hand-maintained `v1FrozenAt`; null until then, and always null for a market
   * with no v1 factory. Read it through `v1FrozenAt(ticker)`.
   */
  v1FrozenAt: number | null;
};

/** A market a page can open: live, with a factory. */
export type LiveMarket = Market & { status: "live"; factory: Address; deployBlock: number };

/** The two per-market sections a URL can name. */
export const MARKET_SECTIONS = ["account", "book"] as const;
export type MarketSection = (typeof MARKET_SECTIONS)[number];

export const DEFAULT_TICKER = "NVDA";

/** The registry build the markets came from (block every address was verified at). */
export const REGISTRY = GENERATED_REGISTRY;

/**
 * The generated file is `as const`, so every row is a literal type and TypeScript can prove things
 * about TODAY's registry (that only NVDA has a factory, say) and reject code for a registry it has
 * not seen. This module must work for any registry the generator accepts, so the rows are widened
 * to their shape here, once; the assignment itself is the check that the generated file still has
 * that shape.
 */
type GeneratedRow = {
  ticker: string;
  name: string;
  asset: string;
  feed: string;
  factory: string | null;
  deployBlock: number | null;
  status: MarketStatus;
  wave: MarketWave;
  mode: MarketMode;
  cboeRoot: string;
  depositCapUsd: number | null;
  v1FrozenAt: number | null;
  v2: {
    status: V2MarketStatus;
    wave: V2Wave;
    strikeTick: string;
    puts: boolean;
    mintFeePpm: number;
    univ3Pool: string | null;
    univ3MinLiquidity: string | null;
    dataStreamsFeedId: string | null;
    overrides: Readonly<Record<string, unknown>>;
    registeredAt: number | null;
    registerTx: string | null;
  };
};
const ROWS: readonly GeneratedRow[] = GENERATED_MARKETS;

/**
 * Every market in the registry, in registry order, with the default market's compiled-in
 * overrides applied. The address strings are re-checksummed through viem so a comparison against
 * a chain read (`getAddress` on both sides) can never fail on case.
 */
export const ALL_MARKETS: readonly Market[] = ROWS.map((m) => {
  const isDefault = m.ticker === DEFAULT_TICKER;
  return {
    ticker: m.ticker,
    name: m.name,
    asset: isDefault ? ASSET : getAddress(m.asset),
    feed: getAddress(m.feed),
    // The override is applied to the default market only, and only when that market has a
    // factory in the registry at all: an override cannot make a planned market live.
    factory: m.factory === null ? null : isDefault ? FACTORY : getAddress(m.factory),
    deployBlock: m.deployBlock,
    status: m.status,
    wave: m.wave,
    mode: m.mode,
    cboeRoot: m.cboeRoot,
    depositCapUsd: m.depositCapUsd,
    v1FrozenAt: m.v1FrozenAt,
  };
});

function isLive(m: Market): m is LiveMarket {
  return m.status === "live" && m.factory !== null && m.deployBlock !== null;
}

/** The live markets: the ones with a route. Registry order. */
export const MARKETS: readonly LiveMarket[] = ALL_MARKETS.filter(isLive);

/** The markets that are not live yet, in wave order, for the landing's "next" card. */
export const WAVE_ORDER: readonly MarketWave[] = ["live", "canary", "wave1", "wave2"];

/**
 * The v1 markets still to open (planned) or stopped (paused), grouped by v1 wave. A
 * `superseded-by-v2` row is not here: its factory will never be built, so listing it as "next"
 * would promise a v1 market that does not exist. The registry has no planned v1 row today, so this
 * returns only paused markets, usually none.
 */
export function plannedByWave(): ReadonlyArray<{ wave: MarketWave; markets: readonly Market[] }> {
  return WAVE_ORDER.map((wave) => ({
    wave,
    markets: ALL_MARKETS.filter((m) => m.wave === wave && m.status !== "superseded-by-v2" && !isLive(m)),
  })).filter((group) => group.markets.length > 0);
}

/* ---------------------------------------------------------------------------------------------- */
/*  v2                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

export type V2MarketStatus = "planned" | "live" | "paused";
export type V2Wave = "canary" | "wave1" | "wave2";
export const V2_WAVE_ORDER: readonly V2Wave[] = ["canary", "wave1", "wave2"];

/** A market's `v2` block from the registry, typed. Big integers are bigint (USDG base units, ADR-04). */
export type V2MarketConfig = {
  status: V2MarketStatus;
  /** Rollout wave: canary, then wave1, then wave2. Order, not dates. */
  wave: V2Wave;
  /** Every strike is a multiple of this, in USDG base units per share; itself a multiple of 100. */
  strikeTick: bigint;
  /** Put series are listed for this market. */
  puts: boolean;
  /** Collateral rent per seven days remaining, in parts per million; series pin it at creation. */
  mintFeePpm: number;
  /** The Uniswap v3 {Stock Token, USDG} pool used as a settlement source and for USDG payout, or null. */
  univ3Pool: Address | null;
  /** The pool's harmonic-mean liquidity floor (raw pool liquidity units), null with the pool. */
  univ3MinLiquidity: bigint | null;
  /** Chainlink Data Streams feed id, lowercase hex, or null. */
  dataStreamsFeedId: Hex | null;
  /** Keys of V2_DEFAULTS this market replaces. */
  overrides: Readonly<Record<string, unknown>>;
  /** Unix seconds of the market's registration, null while planned. */
  registeredAt: number | null;
  registerTx: Hex | null;
};

/**
 * A market as v2 sees it. The addresses are the registry's, checksummed; the v1 build-time
 * NEXT_PUBLIC_ASSET / NEXT_PUBLIC_FACTORY overrides of the default market do not apply here.
 */
export type V2Market = {
  ticker: string;
  name: string;
  asset: Address;
  feed: Address;
  v2: V2MarketConfig;
};

const V2_MARKETS: readonly V2Market[] = ROWS.map((m) => ({
  ticker: m.ticker,
  name: m.name,
  asset: getAddress(m.asset),
  feed: getAddress(m.feed),
  v2: {
    status: m.v2.status,
    wave: m.v2.wave,
    strikeTick: BigInt(m.v2.strikeTick),
    puts: m.v2.puts,
    mintFeePpm: m.v2.mintFeePpm,
    univ3Pool: m.v2.univ3Pool === null ? null : getAddress(m.v2.univ3Pool),
    univ3MinLiquidity: m.v2.univ3MinLiquidity === null ? null : BigInt(m.v2.univ3MinLiquidity),
    dataStreamsFeedId: m.v2.dataStreamsFeedId === null ? null : (m.v2.dataStreamsFeedId.toLowerCase() as Hex),
    overrides: m.v2.overrides,
    registeredAt: m.v2.registeredAt,
    registerTx: m.v2.registerTx === null ? null : (m.v2.registerTx.toLowerCase() as Hex),
  },
}));

/** Every registry market with its v2 block, whatever its v2 status, in registry order. */
export function v2Markets(): readonly V2Market[] {
  return V2_MARKETS;
}

/** Whether the ticker (any case) is a v2 market with status live. False for an unknown ticker. */
export function isV2Live(ticker: string | undefined | null): boolean {
  if (!ticker) return false;
  const key = ticker.trim().toUpperCase();
  return V2_MARKETS.some((m) => m.ticker === key && m.v2.status === "live");
}

/**
 * When the ticker's (any case) v1 factory was frozen, in unix seconds, or null: not frozen yet, no v1
 * factory, or an unknown ticker. The registry writes the date together with `v1RunOff: true` when the
 * owner runs the v1 freeze, so null means "no date to show", never "not frozen" on its own: a banner
 * that reads the factory's own `writesHalted` should keep doing so and add the date when there is one.
 * Looks at every registry row, not only live ones.
 */
export function v1FrozenAt(ticker: string): number | null {
  const key = ticker.trim().toUpperCase();
  return ALL_MARKETS.find((m) => m.ticker === key)?.v1FrozenAt ?? null;
}

/** The live market for a ticker in any case, or undefined (unknown, or not live). */
export function getMarket(ticker: string | undefined | null): LiveMarket | undefined {
  if (!ticker) return undefined;
  const key = ticker.trim().toUpperCase();
  return MARKETS.find((m) => m.ticker === key);
}

/**
 * Which live market the app treats as the default: `preferred` (DEFAULT_TICKER) when it is live,
 * otherwise the first live market in registry order. The fallback exists for one registry state,
 * the default market marked "paused" (the registry's only pause state): without it every page's
 * build would fail on a status flip that the runbook is allowed to make, and the pause could not
 * ship without editing this file. With it the bare /account and /book redirects, the nav, the 404
 * page and the footer follow the fallback, and the paused market's own pages are 404s like any
 * other non-live row. The NEXT_PUBLIC_FACTORY / NEXT_PUBLIC_ASSET overrides do NOT follow: they
 * stay keyed to DEFAULT_TICKER's row (lib/contracts.ts reads that row by name), because an
 * override that silently moved to another market's factory would be worse than one that does
 * nothing.
 *
 * A registry with no live market at all is the one state this refuses: `MARKETS` is a filtered
 * view of a committed file, so that is a build-time fact, every market page would be a 404, and
 * failing loudly at import beats shipping an app with nothing to open. Exported for the test,
 * which cannot build a paused registry into the committed file.
 */
export function resolveDefaultMarket(live: readonly LiveMarket[], preferred: string): LiveMarket {
  const m = live.find((x) => x.ticker === preferred) ?? live[0];
  if (m === undefined) {
    throw new Error(
      `[markets] no market is live in lib/markets.generated.ts: the default ${preferred} is not live and there is nothing to fall back to`,
    );
  }
  return m;
}

/** The default market: DEFAULT_TICKER while it is live, else the first live market (see above). */
export const DEFAULT_MARKET: LiveMarket = resolveDefaultMarket(MARKETS, DEFAULT_TICKER);

/** "/tsla/account". The ticker is lowercased: URLs are lowercase, tickers are not. */
export function marketHref(ticker: string, section: MarketSection): string {
  return `/${ticker.toLowerCase()}/${section}`;
}

/**
 * The live market a route's `[ticker]` segment names, or undefined for anything else (a planned
 * market, an unknown word, a missing param), which the page turns into notFound(). The segment is
 * URL-decoded first because Next hands it over encoded, and matched case-insensitively. Note that
 * the case-insensitivity is for the client (marketFromPathname, which sees whatever is in the
 * address bar) and for robustness, not a promise about URLs: the [ticker] routes prerender the
 * lowercase spelling only and refuse every other segment before rendering (`dynamicParams =
 * false`, app/[ticker]/*), so /NVDA/account is a 404 while /nvda/account is the page. Every link
 * the app emits is lowercase (marketHref).
 */
export function parseTickerParam(param: string | string[] | undefined): LiveMarket | undefined {
  if (typeof param !== "string") return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(param);
  } catch {
    return undefined;
  }
  if (!/^[A-Za-z0-9.]{1,10}$/.test(decoded)) return undefined;
  return getMarket(decoded);
}

/**
 * Which market and section a pathname is on, for the nav and the footer (client side, from
 * usePathname). Undefined on a page that belongs to no market (/, /docs, /legal, /vault/nvda…).
 */
export function marketFromPathname(pathname: string | null | undefined): { market: LiveMarket; section: MarketSection | undefined } | undefined {
  if (!pathname) return undefined;
  const [first, second] = pathname.split("/").filter((s) => s.length > 0);
  const market = parseTickerParam(first);
  if (market === undefined) return undefined;
  const section = (MARKET_SECTIONS as readonly string[]).includes(second ?? "") ? (second as MarketSection) : undefined;
  return { market, section };
}
