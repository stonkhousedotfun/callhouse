/**
 * Massive's option chain snapshot (Massive is the rebranded Polygon.io) as a provider: the
 * paid feed chain.ts was written to take. PRICING_CHAIN_PROVIDER=massive is main.ts's default and the only
 * provider production accepts.
 *
 * THE ENDPOINT. GET {base}/v3/snapshot/options/{root}?limit=250, then `next_url` until there is none.
 * One row per listed contract: `details` (contract_type, expiration_date, strike_price,
 * shares_per_contract, exercise_style, the OCC ticker `O:NVDA260925C00230000`), `last_quote` (bid, ask,
 * sizes, `last_updated` in nanoseconds, `timeframe`), `greeks` and `implied_volatility` (omitted for
 * contracts Massive cannot solve, deep in the money or without a two-sided book), and `underlying_asset`
 * (price, `last_updated`, `timeframe`). A full NVDA chain is ~3,800 rows, 16 pages and ~3.6 MB; the
 * request is cut at the surface horizon (`expiration_date.lte`), which halves it.
 *
 * WHAT THE FEED STATES, KEPT. Unlike Cboe's file, every quote carries its own time, its sizes, the
 * contract multiplier and the exercise style, so those fill chain.ts's fields instead of staying null.
 * Quote age is then real: provenance ages the quotes a price used, not the underlying's clock.
 *
 * TWO TIMEFRAMES. Each quote and the underlying say `REAL-TIME` or `DELAYED` (15 minutes). The chain's
 * entitlement is read from the quotes, per download, not assumed from the plan: real-time only when
 * every quote says so. An options-only plan is not entitled to stock quotes, so on such a key the
 * underlying stays DELAYED while the quotes are real time: measured on the production key 2026-09-24,
 * `underlying_asset.timeframe` DELAYED and exactly 900 s old on NVDA and SPCX, every `last_quote` REAL-TIME. The
 * underlying price only anchors the parity forward and the token-vs-chain spot check.
 *
 * THE PRICING CLOCK. This feed stamps no file-wide time, so `clocks.quoteObservedAt` is the NEWEST
 * quote's `last_updated` in the download: the moment the snapshot is current to. chain.ts pricingClock then prices
 * on it (basis `quote`) and /fair's asOf is it. Earlier the clock was the underlying's, which on this key is
 * always 15 minutes old, so a real-time bound (mm-bot MM_FAIR_MAX_AGE_S 60) would have halted every market. A
 * download with no quote time at all keeps the underlying's clock, as before. Each price's own inputs are still
 * aged one by one (provenance.ts: the OLDEST quote a price used).
 *
 * THE KEY. Sent only as `Authorization: Bearer`, never in a URL, so no request URL (or `next_url`) that
 * reaches an error, a log or /health carries it; an `apiKey` query parameter Massive might echo into
 * `next_url` is removed, and every error text is scrubbed of the key before it leaves this file.
 *
 * FAILURES. One deadline (`timeoutMs`) and one byte budget (`maxBytes`) cover every page together, like
 * vol.ts's one-download rule. 401 / 403 / 429 each get their own code, so /health says "the key was
 * refused", "the plan is not entitled" or "rate limited" rather than "HTTP 4xx". A failed page fails the
 * download: a half chain is never served (ChainCache keeps the last good one). Nothing retries here;
 * the cache's failure backoff does.
 *
 * Pure except fetchMassiveSnapshot, which takes `fetchImpl` as its seam.
 */
import { z } from 'zod';
import { MAX_OPTION_ROWS } from '../../vol.js';
import { CHAIN_CONTRACT, type ChainRow, type ChainSource, type EntitlementClass, type NormalizedChain, type OptionChainProvider, type ProviderDescriptor, type ProviderFetchOptions } from './chain.js';

/*//////////////////////////////////////////////////////////////
                             CONSTANTS
//////////////////////////////////////////////////////////////*/

export const MASSIVE_API_BASE = 'https://api.massive.com';

/** The endpoint's maximum page size. */
export const MASSIVE_PAGE_LIMIT = 250;

/** Pages one download may follow: 60 × 250 = 15,000 rows, above the registry's largest chains cut at the horizon. */
export const MASSIVE_MAX_PAGES = 60;

/** Massive's DELAYED timeframe is 15 minutes. */
export const MASSIVE_DELAYED_S = 900;

/** The least time between two downloads of one ticker's chain on this feed. A real-time feed is only
 *  worth paying for if it is read inside a minute; cboe.ts PRICING_MIN_REFETCH_MS is Cboe's. */
export const MASSIVE_MIN_REFETCH_MS = 15_000;

/** Deadline for one whole paginated download (every page). */
export const MASSIVE_CHAIN_TIMEOUT_MS = 20_000;

/** Static descriptor. Each downloaded chain carries its own, with the entitlement its quotes state. */
export const MASSIVE_PROVIDER: ProviderDescriptor = {
  id: 'massive-options',
  product: 'v3/snapshot/options',
  entitlement: { class: 'unknown', declaredDelayS: null, rightsRef: null },
};

export class MassiveFetchError extends Error {
  constructor(
    readonly code: 'bad-url' | 'auth' | 'not-entitled' | 'rate-limited' | 'http-status' | 'redirect' | 'timeout' | 'network' | 'oversize' | 'bad-json' | 'bad-shape' | 'too-many-pages',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'MassiveFetchError';
  }
}

/*//////////////////////////////////////////////////////////////
                         PARSING (UNTRUSTED)
//////////////////////////////////////////////////////////////*/

const finite = z.number().finite();

/** One page. Rows are parsed one by one below, so one malformed row is skipped, not the page. */
const pageSchema = z.object({
  status: z.string().max(64).optional(),
  results: z.array(z.unknown()).max(MAX_OPTION_ROWS).optional(),
  next_url: z.string().max(2_048).optional(),
});

/** Only the fields this module reads. Everything else in the row is ignored, never trusted. */
const rowSchema = z.object({
  details: z.object({
    contract_type: z.enum(['call', 'put']),
    expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    strike_price: finite.positive(),
    ticker: z.string().min(1).max(64),
    shares_per_contract: finite.positive().optional(),
    exercise_style: z.string().max(32).optional(),
  }),
  last_quote: z
    .object({
      bid: finite.optional(),
      ask: finite.optional(),
      bid_size: finite.optional(),
      ask_size: finite.optional(),
      last_updated: finite.optional(),
      timeframe: z.string().max(32).optional(),
    })
    .optional(),
  greeks: z.object({ delta: finite.optional() }).optional(),
  implied_volatility: finite.optional(),
  underlying_asset: z
    .object({
      ticker: z.string().max(32).optional(),
      price: finite.optional(),
      /** Index underlyings (I:SPX) state `value`, not `price`. */
      value: finite.optional(),
      last_updated: finite.optional(),
      timeframe: z.string().max(32).optional(),
    })
    .optional(),
});

type MassiveRow = z.infer<typeof rowSchema>;

/** `O:NVDA260925C00230000` -> `NVDA`. An adjusted contract keeps its own root (`NVDA1`), which
 *  chain.ts listedOptionOf then refuses as `identity-mismatch`. */
const OCC_TICKER = /^O:([A-Z][A-Z0-9]{0,5})(\d{6})([CP])(\d{8})$/;

function occRoot(ticker: string): string | null {
  return OCC_TICKER.exec(ticker)?.[1] ?? null;
}

/** Massive's nanosecond timestamps (beyond 2^53, so already rounded by JSON.parse) to unix seconds. */
function nsToSeconds(ns: number | undefined): number | null {
  if (ns === undefined || !(ns > 0)) return null;
  return Math.floor(ns / 1e9);
}

/** The chain's entitlement as its quotes (and the pages' `status`) state it, never as the plan claims. */
export function massiveEntitlement(timeframes: readonly (string | undefined)[], pageStatuses: readonly (string | undefined)[]): ProviderDescriptor['entitlement'] {
  let cls: EntitlementClass;
  if (pageStatuses.includes('DELAYED') || timeframes.includes('DELAYED')) cls = 'delayed';
  else if (timeframes.length > 0 && timeframes.every((t) => t === 'REAL-TIME')) cls = 'real-time';
  else cls = 'unknown';
  return { class: cls, declaredDelayS: cls === 'delayed' ? MASSIVE_DELAYED_S : cls === 'real-time' ? 0 : null, rightsRef: null };
}

/**
 * Every row of one download as a NormalizedChain for `root`. What Massive states is kept; what it omits
 * stays null: a missing quote side is null (a stated 0 stays 0), missing greeks or iv leave
 * `analytics` fields null (chain.ts then keeps the row out of the surface as `analytics-missing`), and
 * a row with no `last_quote` has no quote at all. The underlying is read from the rows whose
 * `underlying_asset.ticker` is `root`: the newest observation wins.
 */
export function massiveToNormalized(root: string, rawRows: readonly unknown[], receivedAt: number, pageStatuses: readonly (string | undefined)[] = []): NormalizedChain {
  const rows: ChainRow[] = [];
  const timeframes: (string | undefined)[] = [];
  let skippedRows = 0;
  let firstSkip: string | null = null;
  let underlying: { price: number; observedAt: number | null; timeframe: string | undefined } | null = null;
  for (const raw of rawRows) {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) {
      skippedRows += 1;
      if (firstSkip === null) firstSkip = parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      continue;
    }
    const r: MassiveRow = parsed.data;
    const u = r.underlying_asset;
    const uPrice = u?.price ?? u?.value;
    if (u !== undefined && u.ticker === root && uPrice !== undefined && uPrice > 0) {
      const at = nsToSeconds(u.last_updated);
      if (underlying === null || (at !== null && (underlying.observedAt === null || at > underlying.observedAt))) {
        underlying = { price: uPrice, observedAt: at, timeframe: u.timeframe };
      }
    }
    const q = r.last_quote;
    if (q !== undefined) timeframes.push(q.timeframe);
    const iv = r.implied_volatility ?? null;
    const delta = r.greeks?.delta ?? null;
    rows.push({
      instrument: {
        providerInstrumentId: r.details.ticker,
        root: occRoot(r.details.ticker),
        side: r.details.contract_type === 'call' ? 'C' : 'P',
        strike: r.details.strike_price,
        expiryDay: r.details.expiration_date,
        expiry: null,
        multiplier: r.details.shares_per_contract ?? null,
        exercise: r.details.exercise_style ?? null,
        settlement: null,
      },
      quote:
        q === undefined
          ? null
          : { bid: q.bid ?? null, ask: q.ask ?? null, bidSize: q.bid_size ?? null, askSize: q.ask_size ?? null, currency: 'USD', observedAt: nsToSeconds(q.last_updated) },
      analytics: iv === null && delta === null ? null : { iv, delta, observedAt: null },
      theoretical: null,
    });
  }
  // THE PRICING CLOCK above: the newest quote time in this download, or null (the underlying's clock) when none.
  let newestQuoteAt: number | null = null;
  for (const row of rows) {
    const at = row.quote?.observedAt ?? null;
    if (at !== null && (newestQuoteAt === null || at > newestQuoteAt)) newestQuoteAt = at;
  }
  return {
    contract: CHAIN_CONTRACT,
    provider: { ...MASSIVE_PROVIDER, entitlement: massiveEntitlement(timeframes, pageStatuses) },
    underlying: {
      providerSymbol: root,
      issuer: null,
      price: underlying?.price ?? null,
      observedAt: underlying?.observedAt ?? null,
      observedAtText: underlying === null || underlying.observedAt === null ? null : `${new Date(underlying.observedAt * 1000).toISOString()} ${underlying.timeframe ?? ''}`.trim(),
    },
    clocks: { quoteObservedAt: newestQuoteAt, tradeObservedAt: null, volatilityObservedAt: null, publishedAt: null, publishedAtText: null, receivedAt },
    rows,
    skippedRows,
    firstSkip,
  };
}

/*//////////////////////////////////////////////////////////////
                              FETCH
//////////////////////////////////////////////////////////////*/

export interface MassiveFetchOptions {
  apiKey: string;
  /** Default MASSIVE_API_BASE. https only. */
  baseUrl?: string;
  timeoutMs: number;
  maxBytes: number;
  /** Last listed expiry day asked for (YYYY-MM-DD, New York), or null for the whole chain. */
  expiryLte?: string | null;
  maxPages?: number;
  /** SEAM for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface MassiveSnapshot {
  rows: unknown[];
  pageStatuses: (string | undefined)[];
  pages: number;
  bytes: number;
}

/** `text` without the key, cut to one short line. */
function scrub(text: string, apiKey: string): string {
  const clean = apiKey === '' ? text : text.split(apiKey).join('[redacted]');
  return clean.replace(/\s+/g, ' ').slice(0, 200);
}

/** The first page's URL. */
export function massiveSnapshotUrl(baseUrl: string, root: string, expiryLte: string | null = null): URL {
  const url = new URL(`/v3/snapshot/options/${encodeURIComponent(root)}`, baseUrl);
  url.searchParams.set('limit', String(MASSIVE_PAGE_LIMIT));
  if (expiryLte !== null) url.searchParams.set('expiration_date.lte', expiryLte);
  return url;
}

/**
 * Every page of `root`'s snapshot under one deadline and one byte budget. `next_url` is followed only on
 * the base URL's own https origin, with any `apiKey` parameter removed (the key rides the header).
 * Throws MassiveFetchError; the cache turns that into an entry error.
 */
export async function fetchMassiveSnapshot(root: string, options: MassiveFetchOptions): Promise<MassiveSnapshot> {
  const { apiKey } = options;
  let base: URL;
  try {
    base = new URL(options.baseUrl ?? MASSIVE_API_BASE);
  } catch {
    throw new MassiveFetchError('bad-url', 'the Massive API URL does not parse');
  }
  if (base.protocol !== 'https:') throw new MassiveFetchError('bad-url', `refusing ${base.protocol} (https only)`);
  const doFetch = options.fetchImpl ?? fetch;
  const maxPages = options.maxPages ?? MASSIVE_MAX_PAGES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const out: MassiveSnapshot = { rows: [], pageStatuses: [], pages: 0, bytes: 0 };
  let next: URL | null = massiveSnapshotUrl(base.toString(), root, options.expiryLte ?? null);
  try {
    while (next !== null) {
      if (out.pages >= maxPages) throw new MassiveFetchError('too-many-pages', `more than ${maxPages} pages for ${root}`);
      const response = await abortable(
        doFetch(next.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'user-agent': 'callhouse-pricing' },
        }),
        controller.signal,
      );
      const declared = response.headers.get('content-length');
      if (declared !== null && out.bytes + Number(declared) > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new MassiveFetchError('oversize', `page ${out.pages + 1} would pass ${options.maxBytes} bytes`);
      }
      const text = await abortable(response.text(), controller.signal);
      out.bytes += Buffer.byteLength(text);
      out.pages += 1;
      if (response.status >= 300 && response.status < 400) throw new MassiveFetchError('redirect', `HTTP ${response.status}: refusing to follow a redirect`);
      if (!response.ok) {
        let said = '';
        try {
          const body = JSON.parse(text) as { status?: unknown; message?: unknown; error?: unknown };
          said = [body.status, body.message ?? body.error].filter((s) => typeof s === 'string').join(': ');
        } catch {
          // not JSON: the status alone says enough
        }
        const tail = said === '' ? '' : ` (${scrub(said, apiKey)})`;
        if (response.status === 401) throw new MassiveFetchError('auth', `HTTP 401: Massive refused the API key (MASSIVE_API_KEY)${tail}`);
        if (response.status === 403) throw new MassiveFetchError('not-entitled', `HTTP 403: the Massive plan is not entitled to ${root} option snapshots${tail}`);
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          throw new MassiveFetchError('rate-limited', `HTTP 429: Massive rate limit${retry === null ? '' : `, retry after ${scrub(retry, apiKey)} s`}${tail}`);
        }
        throw new MassiveFetchError('http-status', `HTTP ${response.status}${tail}`);
      }
      if (out.bytes > options.maxBytes) throw new MassiveFetchError('oversize', `the chain passed ${options.maxBytes} bytes over ${out.pages} pages`);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new MassiveFetchError('bad-json', `page ${out.pages} is not JSON (${text.length} characters)`);
      }
      const page = pageSchema.safeParse(json);
      if (!page.success) throw new MassiveFetchError('bad-shape', `page ${out.pages}: ${page.error.issues[0]?.path.join('.') ?? ''} ${page.error.issues[0]?.message ?? ''}`.trim());
      out.pageStatuses.push(page.data.status);
      for (const row of page.data.results ?? []) out.rows.push(row);
      if (out.rows.length > MAX_OPTION_ROWS) throw new MassiveFetchError('oversize', `more than ${MAX_OPTION_ROWS} rows`);
      next = page.data.next_url === undefined || page.data.next_url === '' ? null : followable(page.data.next_url, base);
    }
    return out;
  } catch (error) {
    if (timedOut) throw new MassiveFetchError('timeout', `no complete chain for ${root} within ${options.timeoutMs} ms (${out.pages} pages read)`);
    if (error instanceof MassiveFetchError) throw error;
    throw new MassiveFetchError('network', scrub(error instanceof Error ? error.message : String(error), apiKey));
  } finally {
    clearTimeout(timer);
  }
}

/** vol.ts's rule: a body stream is not necessarily tied to the fetch's signal (an injected fetch, a
 *  proxy), so every await on the network is raced against the deadline explicitly. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** `next_url`, only on the base's origin, without an `apiKey` parameter. */
function followable(raw: string, base: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new MassiveFetchError('bad-shape', 'next_url does not parse');
  }
  if (url.protocol !== 'https:' || url.host !== base.host) throw new MassiveFetchError('bad-shape', `refusing a next_url off ${base.host} (to ${url.protocol}//${url.host})`);
  url.searchParams.delete('apiKey');
  return url;
}

/*//////////////////////////////////////////////////////////////
                           THE PROVIDER
//////////////////////////////////////////////////////////////*/

/** The New York calendar day `days` after `nowMs`. */
export function newYorkDayAfter(nowMs: number, days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs + days * 86_400_000));
}

export interface MassiveProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Ask only for expiries within this many days (plus one of slack); null for the whole chain. */
  horizonDays?: number | null;
  maxPages?: number;
  /** SEAM for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The Massive provider. `source.root` (the registry's `cboe.root`, the listed option root) names the
 * underlying; `source.url` is Cboe's locator and is not read.
 */
export function createMassiveProvider(options: MassiveProviderOptions): OptionChainProvider {
  if (options.apiKey.trim() === '') throw new Error('the Massive provider needs an API key (MASSIVE_API_KEY)');
  const horizonDays = options.horizonDays === undefined ? null : options.horizonDays;
  return {
    descriptor: MASSIVE_PROVIDER,
    async fetch(source: ChainSource, fetchOptions: ProviderFetchOptions) {
      const snapshot = await fetchMassiveSnapshot(source.root, {
        apiKey: options.apiKey,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        timeoutMs: fetchOptions.timeoutMs,
        maxBytes: fetchOptions.maxBytes,
        expiryLte: horizonDays === null ? null : newYorkDayAfter(fetchOptions.nowMs(), horizonDays + 1),
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      return massiveToNormalized(source.root, snapshot.rows, Math.floor(fetchOptions.nowMs() / 1000), snapshot.pageStatuses);
    },
  };
}
