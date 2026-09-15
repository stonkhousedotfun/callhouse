/**
 * The market's view of the week's call: Cboe's free delayed option quotes for NVDA, turned into a
 * strike (by delta) and a fair price (by interpolating listed mids).
 *
 * The vault does not care what the market thinks. Its gates are the OTM band, the premium floor
 * and `unit <= strike` (policy.ts mirrors them). This module exists so the keeper does not sell a
 * week of calls at the floor when the listed market pays more, and so the strike sits where a
 * buyer would expect one of a given delta rather than at a fixed percentage above spot. Nothing
 * here is trusted: the response comes from the internet and every number is checked before it
 * can move a strike or a price, and any doubt skips the week (policy.ts turns each failure into
 * a named reason) instead of arming on a guess.
 *
 * THE FEED, as observed on 2026-09-14/15 (keeper/src/fixtures/cboe-nvda-2026-09-14.json):
 *   GET https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json
 *   { timestamp: "2026-09-15 05:57:42",
 *     data: { symbol: "NVDA", current_price: 212.0404, last_trade_time: "2026-09-14T15:59:59",
 *             options: [ { option: "NVDA260918C00222500", bid, ask, iv, delta, ... }, ... ] } }
 *   option   root + YYMMDD + C|P + strike × 1000 as 8 digits. Weekly expiries every Friday.
 *   prices   per SHARE (one listed contract is 100 shares; the vault's contract is one token).
 *   iv       a fraction (0.3732), unlike the stock-level iv30, which is in percent.
 *
 * THE TWO CLOCKS. Neither is documented by Cboe, so both were measured:
 *   timestamp        UTC. It is when Cboe generated the file, not when anything traded: fetched
 *                    live at 08:16 UTC on 2026-09-15, NVDA's said "2026-09-15 05:57:42" with an
 *                    HTTP Last-Modified of "05:57:45 GMT", TSLA's "05:55:12" against "05:55:15",
 *                    AAPL's "03:43:56" against "03:44:08", and _SPX's "08:16:07" against
 *                    "08:16:10" with the response Date at 08:16:36. Always a few seconds before
 *                    Last-Modified; an Eastern reading would put every one four hours off.
 *   last_trade_time  America/New_York wall clock of the underlying's last trade: 15:59:59 for
 *                    the stocks (the 16:00 close) and 16:14:59 for _SPX (whose options trade to
 *                    16:15 ET), on a file generated hours after both closes.
 * Freshness is judged on BOTH (chainFreshness): the quotes are as old as the last trade, and a
 * file whose last trade is newer than the file itself is inconsistent. Hours alone are not enough:
 * Cboe regenerates each ticker's file on its own schedule, so a stuck file can be days old and
 * still inside the four-day limit. The last trade must also belong to the latest NYSE session
 * that has closed (latestSettledSessionClose), so a Saturday arm never prices on Wednesday.
 *
 * UNITS. Share-space numbers (strikes, mids) are JavaScript floats: they are interpolation inputs.
 * Everything that feeds the chain leaves this module as bigint USDG base units (6 dp) through
 * one explicit rounding each: the strike to a whole USDG half up, the fair price UP.
 *
 * SHARE TO TOKEN. The Stock Token is not exactly a share (uiMultiplier ~1.0008, already inside
 * the Chainlink spot the vault reads), and the two spots are also taken at different moments.
 * Strikes and prices are mapped by moneyness, `token = share × tokenSpot / shareSpot`, and the
 * ratio itself is bounded (KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS) so a stale or wrong feed on either
 * side is a skipped week, not a mispriced one.
 *
 * Pure except fetchCboeChain, which takes its fetch as a seam.
 */
import { z } from 'zod';
import { CLOSE_HOUR_ET, NYSE_HOLIDAYS_2026_2027, newYorkParts, newYorkTimeToUnix } from './calendar.js';

/*//////////////////////////////////////////////////////////////
                            CONSTANTS
//////////////////////////////////////////////////////////////*/

export const CBOE_NVDA_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json';

/** The option root the default feed must report (`data.symbol`). A file for any other ticker is
 *  inconsistent, whatever its spot happens to be. */
export const CBOE_ROOT = 'NVDA';

/** What `pricing.source` says wherever a number came from this feed. */
export const VOL_SOURCE = 'cboe-delayed' as const;

/** A quote whose bid/ask spread is wider than BOTH of these is not a price, it is a guess.
 *  Absolute allowance for cheap wings only (a 0.01/0.05 quote on a 0.03 mid is a normal tick, not
 *  noise). It binds only below a ~0.17 mid; at the 0.2..2.0 mids this keeper prices at, a flat
 *  0.10 would let a quote 50% wide or more set the fair value, so the relative leg decides there. */
export const MAX_SPREAD_USD = 0.05;
/** ... and the relative ceiling for everything else: 30% of the mid. */
export const MAX_SPREAD_FRACTION_OF_MID = 0.3;

/** No listed NVDA call is worth a million dollars a share. A bid or ask beyond it is a corrupt row,
 *  and two of them near Number.MAX_VALUE would sum to Infinity. */
export const MAX_QUOTE_USD = 1_000_000;

/** The widest gap between the two listed strikes an interpolation may span: max(2.5 USD, 2.5% of
 *  the lower strike). NVDA's weeklies list every 2.5 USD near the money, so one missing quote (a
 *  5 USD bracket) still prices; a hole of several strikes is a broken chain, not a market. */
export const MAX_BRACKET_GAP_USD = 2.5;
export const MAX_BRACKET_GAP_FRACTION = 0.025;

/** Cboe prints delta to 4 dp. A delta that RISES with the strike by more than this is corrupt. */
export const DELTA_MONOTONE_TOLERANCE = 0.005;

/** A session counts as over for the freshness check this long after its 16:00 ET close, so a file
 *  regenerated overnight has time to carry it. Before that, the previous session is required. */
export const SESSION_GRACE_S = 12 * 3_600;
/** How far before 16:00 ET the last trade of that session may be: early closes (13:00 ET the day
 *  after Thanksgiving, Christmas Eve) are not in the holiday table. */
export const EARLY_CLOSE_TOLERANCE_S = 4 * 3_600;

/** More than this share of option rows failing to parse is a changed feed format, not noise. */
export const MAX_SKIPPED_ROW_FRACTION = 0.5;

/** How far in the future either clock may read before the file is called inconsistent. The block
 *  clock, the wall clock and Cboe's generator disagree by seconds in practice; an hour is a
 *  timezone bug, not skew. */
export const CLOCK_SKEW_TOLERANCE_S = 3_600;

/** More option rows than any single-name chain carries (NVDA: 4190). Bounds the CPU a hostile or
 *  broken response can cost before the byte cap even matters. */
export const MAX_OPTION_ROWS = 50_000;

/** Same-host redirects followed before giving up. A redirect to any other host is refused. */
export const MAX_REDIRECTS = 3;

/** Float comparisons on prices in dollars: well under a base unit (1e-6). */
const EPSILON = 1e-9;

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export interface CboeOption {
  symbol: string;
  /** YYYY-MM-DD, the listed expiry date. */
  expiry: string;
  type: 'C' | 'P';
  /** Per share, USD. */
  strike: number;
  bid: number;
  ask: number;
  /** A fraction: 0.3732 is 37.32%. */
  iv: number;
  delta: number;
}

export interface CboeChain {
  root: string;
  /** Top-level `timestamp`, verbatim: file generation time, UTC. */
  timestamp: string;
  /** `data.last_trade_time`, verbatim: the underlying's last trade, New York wall clock. */
  lastTradeTime: string;
  /** `data.current_price`: one share, USD. */
  shareSpot: number;
  options: CboeOption[];
  /** Option rows dropped at parse time: malformed fields or a symbol that is not `root` + date +
   *  type + strike. Reported, never priced. */
  skippedRows: number;
  /** Why the first dropped row was dropped (a field path, or `symbol`), for the skip detail. */
  firstSkip?: string | null;
}

/** The chain as roll.ts hands it to policy.ts: fetched once per decision, or the reason it could
 *  not be. Pure data, so a test builds one from the fixture. */
export interface VolContext {
  chain: CboeChain | null;
  /** Why the fetch failed, when `chain` is null. */
  error: string | null;
  /** The expiry to price: the cycle's close day, YYYY-MM-DD New York (WeekWindow.closeDay). */
  closeDay: string;
  /** The head block's timestamp: freshness is a chain-clock fact like every other decision. */
  nowSeconds: number;
}

export type VolReason =
  | 'vol-unavailable'
  | 'vol-stale'
  | 'vol-inconsistent'
  | 'vol-no-expiry'
  | 'vol-no-quotes'
  | 'vol-spot-divergence'
  | 'vol-delta-out-of-range'
  | 'vol-strike-unquoted';

export interface VolFailure {
  ok: false;
  reason: VolReason;
  detail: Record<string, string>;
}

/*//////////////////////////////////////////////////////////////
                         PARSING (UNTRUSTED)
//////////////////////////////////////////////////////////////*/

export class VolFetchError extends Error {
  constructor(
    readonly code: 'bad-url' | 'non-https' | 'redirect' | 'http-status' | 'timeout' | 'network' | 'oversize' | 'bad-json' | 'bad-shape',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'VolFetchError';
  }
}

const finite = z.number().finite();

/** Only the fields this module reads. Everything else in the row is ignored, never trusted. */
const optionRowSchema = z.object({
  option: z.string().min(1).max(64),
  bid: finite,
  ask: finite,
  iv: finite,
  delta: finite,
});

const chainSchema = z.object({
  timestamp: z.string().min(1).max(64),
  data: z.object({
    symbol: z.string().regex(/^[A-Z]{1,6}$/),
    current_price: finite.positive(),
    last_trade_time: z.string().min(1).max(64),
    options: z.array(z.unknown()).max(MAX_OPTION_ROWS),
  }),
});

/**
 * `NVDA260918C00222500` -> { expiry: '2026-09-18', type: 'C', strike: 222.5 }, or null.
 *
 * The root must match exactly and be followed immediately by the date, so an adjusted or
 * look-alike root (`NVDA1…`, `NVDAX…`) never parses as NVDA. The date must be a real calendar day.
 */
export function parseOptionSymbol(root: string, symbol: string): { expiry: string; type: 'C' | 'P'; strike: number } | null {
  if (!/^[A-Z]{1,6}$/.test(root) || !symbol.startsWith(root)) return null;
  const m = /^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol.slice(root.length));
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const thousandths = Number(m[5]);
  if (thousandths <= 0) return null;
  return {
    expiry: `${year}-${m[2]}-${m[3]}`,
    type: m[4] as 'C' | 'P',
    strike: thousandths / 1000,
  };
}

/** Validate a decoded response and keep only well-formed rows for this root. Throws
 *  VolFetchError('bad-shape') when the envelope itself is wrong. */
export function parseCboeChain(json: unknown): CboeChain {
  const parsed = chainSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.join('.') || '(root)')
      .join(', ');
    throw new VolFetchError('bad-shape', `response does not match the Cboe chain shape at ${where}`);
  }
  const { timestamp, data } = parsed.data;
  const options: CboeOption[] = [];
  let skippedRows = 0;
  let firstSkip: string | null = null;
  for (const raw of data.options) {
    const row = optionRowSchema.safeParse(raw);
    const symbol = row.success ? parseOptionSymbol(data.symbol, row.data.option) : null;
    if (!row.success || symbol === null) {
      skippedRows += 1;
      if (firstSkip === null) {
        const issue = row.success ? null : row.error.issues[0];
        firstSkip = issue ? `${issue.path.join('.') || '(row)'}: ${issue.code}` : 'symbol';
      }
      continue;
    }
    options.push({ symbol: row.data.option, ...symbol, bid: row.data.bid, ask: row.data.ask, iv: row.data.iv, delta: row.data.delta });
  }
  return { root: data.symbol, timestamp, lastTradeTime: data.last_trade_time, shareSpot: data.current_price, options, skippedRows, firstSkip };
}

/*//////////////////////////////////////////////////////////////
                              FETCH
//////////////////////////////////////////////////////////////*/

export interface FetchChainOptions {
  timeoutMs: number;
  maxBytes: number;
  /** SEAM for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * GET the chain, treating the response as hostile: https only, one deadline for the whole
 * exchange (connect, headers, body), a byte cap enforced while streaming (a Content-Length is a
 * claim, not a limit), redirects only to the same https host, strict UTF-8, then the schema.
 * Throws VolFetchError; the caller turns that into a skipped decision, never a crash.
 */
export async function fetchCboeChain(url: string, options: FetchChainOptions): Promise<CboeChain> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new VolFetchError('bad-url', 'the vol URL does not parse');
  }
  if (current.protocol !== 'https:') throw new VolFetchError('non-https', `refusing ${current.protocol} (https only)`);
  const host = current.host;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    let response: Response | null = null;
    for (let hop = 0; response === null; hop += 1) {
      const candidate = await abortable(
        doFetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': 'callhouse-keeper' },
        }),
        controller.signal,
      );
      if (candidate.status >= 300 && candidate.status < 400) {
        await candidate.body?.cancel().catch(() => undefined);
        const location = candidate.headers.get('location');
        if (location === null) throw new VolFetchError('redirect', `HTTP ${candidate.status} without a Location`);
        if (hop >= MAX_REDIRECTS) throw new VolFetchError('redirect', `more than ${MAX_REDIRECTS} redirects`);
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new VolFetchError('redirect', 'unparseable Location');
        }
        if (next.protocol !== 'https:' || next.host !== host) {
          throw new VolFetchError('redirect', `refusing a redirect off ${host} (to ${next.protocol}//${next.host})`);
        }
        current = next;
        continue;
      }
      response = candidate;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new VolFetchError('http-status', `HTTP ${response.status}`);
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new VolFetchError('oversize', `Content-Length ${declared} exceeds ${options.maxBytes} bytes`);
    }

    const bytes = await readCapped(response, options.maxBytes, controller.signal);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new VolFetchError('bad-json', 'body is not valid UTF-8');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new VolFetchError('bad-json', `body is not JSON (${bytes.byteLength} bytes)`);
    }
    return parseCboeChain(json);
  } catch (error) {
    if (timedOut) throw new VolFetchError('timeout', `no complete response within ${options.timeoutMs} ms`);
    if (error instanceof VolFetchError) throw error;
    throw new VolFetchError('network', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Read the body chunk by chunk and stop the moment it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new VolFetchError('oversize', `body passed ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A body stream is not necessarily tied to the fetch's signal (an injected fetch, a proxy), so
 *  every await on the network is raced against the deadline explicitly. */
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

/*//////////////////////////////////////////////////////////////
                            FRESHNESS
//////////////////////////////////////////////////////////////*/

/** `YYYY-MM-DD HH:MM:SS` (optionally `T` and fractional seconds), read as UTC. See THE TWO CLOCKS. */
export function parseCboeTimestamp(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) {
    return null;
  }
  return Math.floor(ms / 1000);
}

/** `YYYY-MM-DDTHH:MM:SS` on the New York wall clock -> unix seconds, through calendar.ts so the
 *  DST offset is the zone's at that instant. A time that does not exist there (a spring-forward
 *  gap, 30 February) is null. */
export function parseNewYorkLocalTime(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const unix = newYorkTimeToUnix(y, mo, d, h) + mi * 60 + s;
  const back = newYorkParts(unix);
  if (back.year !== y || back.month !== mo || back.day !== d || back.hour !== h || back.minute !== mi) return null;
  return unix;
}

/** Seconds since the underlying's last trade, or null when the field does not parse. */
export function chainAgeSeconds(chain: Pick<CboeChain, 'lastTradeTime'>, nowSeconds: number): number | null {
  const lastTrade = parseNewYorkLocalTime(chain.lastTradeTime);
  return lastTrade === null ? null : nowSeconds - lastTrade;
}

export type Freshness =
  | { ok: true; ageSeconds: number; lastTradeUnix: number; timestampUnix: number }
  | VolFailure;

/**
 * The 16:00 ET close of the latest NYSE session that ended at least SESSION_GRACE_S before
 * `nowSeconds`: the session a chain read now must already carry. Weekends and the full-day
 * `holidays` are not sessions. Null only if none is found in three weeks (a broken table).
 */
export function latestSettledSessionClose(nowSeconds: number, holidays: readonly string[]): number | null {
  const closed = new Set(holidays);
  const today = newYorkParts(nowSeconds);
  for (let back = 0; back <= 21; back += 1) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day - back));
    const weekday = d.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (closed.has(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)) continue;
    const close = newYorkTimeToUnix(year, month, day, CLOSE_HOUR_ET);
    if (close + SESSION_GRACE_S <= nowSeconds) return close;
  }
  return null;
}

/**
 * Fresh enough to price a week on?
 *   stale         the last trade, or the file itself, is more than `maxAgeS` old. The default is
 *                 the vault's own maxPriceAge (4 days): a Saturday arm reads Friday's close, and a
 *                 long weekend still fits; anything older is not this week's market. With
 *                 `holidays` (checkVolMarket always passes them), the last trade must also be from
 *                 the latest settled NYSE session (latestSettledSessionClose, less
 *                 EARLY_CLOSE_TOLERANCE_S): a file stuck on Wednesday is stale on Saturday.
 *   inconsistent  a clock that does not parse, a file from the future, or a last trade newer than
 *                 the file that reports it (each beyond CLOCK_SKEW_TOLERANCE_S).
 */
export function chainFreshness(
  chain: Pick<CboeChain, 'lastTradeTime' | 'timestamp'>,
  nowSeconds: number,
  maxAgeS: number,
  holidays?: readonly string[],
): Freshness {
  const lastTradeUnix = parseNewYorkLocalTime(chain.lastTradeTime);
  const timestampUnix = parseCboeTimestamp(chain.timestamp);
  const detail = { lastTradeTime: chain.lastTradeTime, chainTimestamp: chain.timestamp, nowSeconds: String(nowSeconds) };
  if (lastTradeUnix === null || timestampUnix === null) {
    return { ok: false, reason: 'vol-inconsistent', detail: { ...detail, why: 'a clock does not parse' } };
  }
  if (timestampUnix > nowSeconds + CLOCK_SKEW_TOLERANCE_S) {
    return { ok: false, reason: 'vol-inconsistent', detail: { ...detail, why: 'the file is dated in the future' } };
  }
  if (lastTradeUnix > timestampUnix + CLOCK_SKEW_TOLERANCE_S) {
    return { ok: false, reason: 'vol-inconsistent', detail: { ...detail, why: 'the last trade is newer than the file' } };
  }
  const ageSeconds = nowSeconds - lastTradeUnix;
  if (ageSeconds > maxAgeS || nowSeconds - timestampUnix > maxAgeS) {
    return { ok: false, reason: 'vol-stale', detail: { ...detail, ageSeconds: String(ageSeconds), maxAgeS: String(maxAgeS) } };
  }
  if (holidays !== undefined) {
    const sessionClose = latestSettledSessionClose(nowSeconds, holidays);
    if (sessionClose !== null && lastTradeUnix < sessionClose - EARLY_CLOSE_TOLERANCE_S) {
      return {
        ok: false,
        reason: 'vol-stale',
        detail: { ...detail, ageSeconds: String(ageSeconds), sessionClose: String(sessionClose), why: 'the last trade predates the latest completed NYSE session' },
      };
    }
  }
  return { ok: true, ageSeconds, lastTradeUnix, timestampUnix };
}

/*//////////////////////////////////////////////////////////////
                         EXPIRY AND QUOTES
//////////////////////////////////////////////////////////////*/

/**
 * The calls that expire on the cycle's close day, or null. No nearest expiry, no interpolation
 * across expiries: a week whose Friday (or holiday Thursday) has no listed weekly is not priced.
 */
export function selectExpiry(chain: Pick<CboeChain, 'options'>, closeDay: string): { expiry: string; calls: CboeOption[] } | null {
  const calls = chain.options.filter((o) => o.type === 'C' && o.expiry === closeDay);
  return calls.length === 0 ? null : { expiry: closeDay, calls };
}

/** A two-sided, sane quote: bid > 0, ask >= bid, both under MAX_QUOTE_USD, a delta strictly inside
 *  (0, 1), a finite non-negative iv, and a spread no wider than max(MAX_SPREAD_USD,
 *  MAX_SPREAD_FRACTION_OF_MID × mid). */
export function isUsableQuote(o: Pick<CboeOption, 'bid' | 'ask' | 'delta' | 'iv' | 'strike'>): boolean {
  if (![o.bid, o.ask, o.delta, o.iv, o.strike].every(Number.isFinite)) return false;
  if (!(o.bid > 0) || !(o.ask >= o.bid) || !(o.delta > 0 && o.delta < 1) || o.iv < 0 || !(o.strike > 0)) return false;
  if (!(o.ask <= MAX_QUOTE_USD)) return false;
  const mid = (o.bid + o.ask) / 2;
  if (!Number.isFinite(mid)) return false;
  const spread = o.ask - o.bid;
  return spread <= Math.max(MAX_SPREAD_USD, MAX_SPREAD_FRACTION_OF_MID * mid) + EPSILON;
}

/** Usable quotes, sorted by strike. A strike listed twice is dropped entirely: which of the two
 *  is real is not a question this module answers. */
export function filterQuotes(calls: readonly CboeOption[]): CboeOption[] {
  const usable = calls.filter(isUsableQuote);
  const counts = new Map<number, number>();
  for (const q of usable) counts.set(q.strike, (counts.get(q.strike) ?? 0) + 1);
  return usable.filter((q) => counts.get(q.strike) === 1).sort((a, b) => a.strike - b.strike);
}

/*//////////////////////////////////////////////////////////////
                         SHARE TO TOKEN
//////////////////////////////////////////////////////////////*/

export type SpotMapping = { ok: true; ratio: number; tokenSpot: number; divergenceBps: number } | VolFailure;

/**
 * The moneyness ratio `tokenSpot / shareSpot`, refused when it is further than `maxDivergenceBps`
 * from 1: the token's multiplier is ~8 bps, so hundreds of bps mean one of the two spots is
 * wrong or from a different day.
 */
export function mapSpot(shareSpot: number, spotUsdg6: bigint, maxDivergenceBps: number): SpotMapping {
  const tokenSpot = Number(spotUsdg6) / 1e6;
  if (!(Number.isFinite(shareSpot) && shareSpot > 0) || !(tokenSpot > 0)) {
    return { ok: false, reason: 'vol-inconsistent', detail: { why: 'a spot is not positive', shareSpot: String(shareSpot), spotUsdg6: spotUsdg6.toString() } };
  }
  const ratio = tokenSpot / shareSpot;
  const divergenceBps = Math.abs(ratio - 1) * 10_000;
  // 206 / 200 is 300.0000000000002 bps in floats: the limit is inclusive, not a float artefact.
  if (divergenceBps > maxDivergenceBps + 1e-6) {
    return {
      ok: false,
      reason: 'vol-spot-divergence',
      detail: { shareSpot: String(shareSpot), tokenSpot: String(tokenSpot), divergenceBps: divergenceBps.toFixed(1), maxDivergenceBps: String(maxDivergenceBps) },
    };
  }
  return { ok: true, ratio, tokenSpot, divergenceBps };
}

/*//////////////////////////////////////////////////////////////
                         STRIKE AND PRICE
//////////////////////////////////////////////////////////////*/

export type DeltaStrike =
  | {
      ok: true;
      /** The token strike rounded to a whole USDG, half up. */
      strikeUsdg6: bigint;
      /** The interpolated share strike, before the moneyness map. */
      shareStrike: number;
      /** The bracketing listed strikes. */
      bracket: [number, number];
    }
  | { ok: false; reason: 'vol-delta-out-of-range' | 'vol-inconsistent'; detail: Record<string, string> };

/** The widest listed-strike bracket an interpolation may span at `lowStrike` (share USD). */
export function maxBracketGap(lowStrike: number): number {
  return Math.max(MAX_BRACKET_GAP_USD, MAX_BRACKET_GAP_FRACTION * lowStrike);
}

/**
 * Is the chain sane where it is about to be interpolated? `bracket` is the pair of listed strikes
 * a strike or a price comes from; the check covers those two quotes and one neighbour on each
 * side, which is where a corrupt row would move the answer, and leaves deep wings (where stale,
 * wide quotes are normal and irrelevant) alone. Refused, as `vol-inconsistent`:
 *   gap       the bracket spans more than maxBracketGap: missing quotes, not a market
 *   delta     a delta that rises with the strike (beyond DELTA_MONOTONE_TOLERANCE)
 *   vertical  a higher strike bid above a lower strike's ask: a call spread for a credit
 *   butterfly a middle strike bid above the strike-weighted asks of its neighbours: a call price
 *             that is not convex in strike
 * The last two are static arbitrages in the quotes themselves, which a real two-sided market does
 * not offer. The real 2026-09-14 NVDA chain has none, across every expiry.
 */
export function checkQuoteWindow(quotes: readonly CboeOption[], bracket: readonly [number, number]): VolFailure | null {
  const fail = (why: string, extra: Record<string, string> = {}): VolFailure => ({
    ok: false,
    reason: 'vol-inconsistent',
    detail: { why, bracket: `${bracket[0]}-${bracket[1]}`, ...extra },
  });
  const loIdx = quotes.findIndex((q) => q.strike === bracket[0]);
  const hiIdx = quotes.findIndex((q) => q.strike === bracket[1]);
  if (loIdx < 0 || hiIdx < loIdx) return fail('the bracket is not in the usable quotes');
  const gap = bracket[1] - bracket[0];
  if (gap > maxBracketGap(bracket[0]) + EPSILON) {
    return fail('the bracketing listed strikes are too far apart', { gapUsd: String(gap), maxGapUsd: maxBracketGap(bracket[0]).toFixed(4) });
  }
  const from = Math.max(0, loIdx - 1);
  const to = Math.min(quotes.length - 1, hiIdx + 1);
  for (let i = from; i < to; i += 1) {
    const lo = quotes[i]!;
    const hi = quotes[i + 1]!;
    if (hi.delta > lo.delta + DELTA_MONOTONE_TOLERANCE) {
      return fail('delta rises with the strike', { lowStrike: String(lo.strike), lowDelta: String(lo.delta), highStrike: String(hi.strike), highDelta: String(hi.delta) });
    }
    if (hi.bid > lo.ask + EPSILON) {
      return fail('a higher strike is bid above a lower strike’s ask', { lowStrike: String(lo.strike), lowAsk: String(lo.ask), highStrike: String(hi.strike), highBid: String(hi.bid) });
    }
  }
  for (let i = from + 1; i < to; i += 1) {
    const a = quotes[i - 1]!;
    const b = quotes[i]!;
    const c = quotes[i + 1]!;
    const lambda = (c.strike - b.strike) / (c.strike - a.strike);
    const bound = lambda * a.ask + (1 - lambda) * c.ask;
    if (b.bid > bound + EPSILON) {
      return fail('a call is bid above the convex bound of its neighbours', { strike: String(b.strike), bid: String(b.bid), bound: bound.toFixed(6) });
    }
  }
  return null;
}

/**
 * The strike whose delta is `targetDelta`, by linear interpolation between the two adjacent listed
 * strikes that bracket it (quotes sorted by strike, call delta decreasing), mapped to the token
 * and rounded to a whole USDG half up. A target the quoted deltas do not reach is flagged, never
 * extrapolated: past the last quote there is no market to interpolate.
 *
 * The chain must cross the target exactly once, downwards. A delta that climbs back above the
 * target at a higher strike (one corrupt in-the-money row reading 0.12) would otherwise hand the
 * first, wrong bracket to a strike that is fixed for the week: `vol-inconsistent`. The bracket
 * itself must then pass checkQuoteWindow.
 */
export function strikeForDelta(quotes: readonly CboeOption[], targetDelta: number, ratio: number): DeltaStrike {
  const deltas = quotes.map((q) => q.delta);
  const outOfRange = (): DeltaStrike => ({
    ok: false,
    reason: 'vol-delta-out-of-range',
    detail: {
      targetDelta: String(targetDelta),
      quotedHigh: deltas.length ? String(Math.max(...deltas)) : 'none',
      quotedLow: deltas.length ? String(Math.min(...deltas)) : 'none',
      quotes: String(quotes.length),
    },
  });
  if (!(targetDelta > 0 && targetDelta < 1) || !(ratio > 0)) return outOfRange();

  for (let i = 0; i + 1 < quotes.length; i += 1) {
    const lo = quotes[i]!;
    const hi = quotes[i + 1]!;
    if (!(lo.delta > targetDelta) && hi.delta > targetDelta) {
      return {
        ok: false,
        reason: 'vol-inconsistent',
        detail: {
          why: 'delta climbs back above the target at a higher strike',
          targetDelta: String(targetDelta),
          lowStrike: String(lo.strike),
          lowDelta: String(lo.delta),
          highStrike: String(hi.strike),
          highDelta: String(hi.delta),
        },
      };
    }
  }

  let shareStrike: number | null = null;
  let bracket: [number, number] | null = null;
  for (let i = 0; i < quotes.length && shareStrike === null; i += 1) {
    const lo = quotes[i]!;
    if (Math.abs(lo.delta - targetDelta) < EPSILON) {
      shareStrike = lo.strike;
      bracket = [lo.strike, lo.strike];
      break;
    }
    const hi = quotes[i + 1];
    if (hi === undefined) break;
    if (lo.delta > targetDelta && targetDelta > hi.delta) {
      const w = (lo.delta - targetDelta) / (lo.delta - hi.delta);
      shareStrike = lo.strike + w * (hi.strike - lo.strike);
      bracket = [lo.strike, hi.strike];
    }
  }
  if (shareStrike === null || bracket === null) return outOfRange();
  const window = checkQuoteWindow(quotes, bracket);
  if (window !== null) return { ok: false, reason: 'vol-inconsistent', detail: window.detail };

  const tokenStrike = shareStrike * ratio;
  if (!Number.isFinite(tokenStrike) || tokenStrike <= 0) return outOfRange();
  // Whole USDG, half up. Math.floor(x + 0.5) is half up for the positive x it is given here.
  const strikeUsdg6 = BigInt(Math.floor(tokenStrike + 0.5)) * 1_000_000n;
  return { ok: true, strikeUsdg6, shareStrike, bracket };
}

export interface FairPrice {
  /** The interpolated mid mapped to the token, USDG base units, rounded UP. */
  fairUnit6: bigint;
  /** The token strike mapped back to share space: the point interpolated at. */
  shareStrike: number;
  shareMid: number;
  /** Cboe's own iv and delta, interpolated at the same point. For display. */
  ivAtStrike: number;
  deltaAtStrike: number;
  bracket: [number, number];
}

/**
 * The market's fair price for ONE token call at `strikeUsdg6`: map the strike to share space,
 * interpolate the mid linearly between the bracketing listed strikes, map the mid back. Call
 * prices are convex in strike, so the chord sits on or above the curve: the interpolation errs
 * towards a higher price, the seller's side. Outside the quoted strikes: null.
 */
export function fairCallPrice(quotes: readonly CboeOption[], strikeUsdg6: bigint, ratio: number): FairPrice | null {
  if (quotes.length === 0 || !(ratio > 0) || strikeUsdg6 <= 0n) return null;
  const shareStrike = Number(strikeUsdg6) / 1e6 / ratio;
  const first = quotes[0]!;
  const last = quotes[quotes.length - 1]!;
  if (shareStrike < first.strike - EPSILON || shareStrike > last.strike + EPSILON) return null;

  const mid = (q: CboeOption) => (q.bid + q.ask) / 2;
  let lo = first;
  let hi = first;
  for (let i = 0; i < quotes.length; i += 1) {
    const q = quotes[i]!;
    if (Math.abs(q.strike - shareStrike) < EPSILON) {
      lo = q;
      hi = q;
      break;
    }
    const next = quotes[i + 1];
    if (next !== undefined && q.strike < shareStrike && shareStrike < next.strike) {
      lo = q;
      hi = next;
      break;
    }
  }
  const w = hi.strike === lo.strike ? 0 : (shareStrike - lo.strike) / (hi.strike - lo.strike);
  const lerp = (a: number, b: number) => a + w * (b - a);
  const shareMid = lerp(mid(lo), mid(hi));
  if (!(Number.isFinite(shareMid) && shareMid > 0)) return null;
  return {
    fairUnit6: usdToUsdg6Up(shareMid * ratio),
    shareStrike,
    shareMid,
    ivAtStrike: lerp(lo.iv, hi.iv),
    deltaAtStrike: lerp(lo.delta, hi.delta),
    bracket: [lo.strike, hi.strike],
  };
}

/**
 * Dollars (float) -> USDG base units, rounded UP, explicitly. A float that is a whole number of
 * base units up to representation noise (0.63 × 1e6 = 630000.0000000001) is that number, not one
 * more; anything genuinely between two base units goes to the higher.
 */
export function usdToUsdg6Up(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`not a price: ${usd}`);
  const micros = usd * 1e6;
  const nearest = Math.round(micros);
  if (Math.abs(micros - nearest) < 1e-6) return BigInt(nearest);
  return BigInt(Math.ceil(micros));
}

/*//////////////////////////////////////////////////////////////
                        THE MARKET, CHECKED
//////////////////////////////////////////////////////////////*/

export interface VolMarket {
  ok: true;
  expiry: string;
  /** Usable calls for the expiry, sorted by strike. At least two. */
  quotes: CboeOption[];
  ratio: number;
  shareSpot: number;
  tokenSpot: number;
  divergenceBps: number;
  ageSeconds: number;
  chainTimestamp: string;
  lastTradeTime: string;
}

export interface VolSettings {
  maxAgeS: number;
  maxDivergenceBps: number;
  /** The root the chain must be for. Default CBOE_ROOT. */
  expectedRoot?: string;
  /** Full-day NYSE closures for the session freshness check. Default the built-in table. */
  holidays?: readonly string[];
}

/**
 * Every check that does not depend on the strike, in the order a human would ask them: is there
 * a chain, is it for the right ticker, is it fresh and self-consistent, did its rows parse, does
 * it list this week's expiry, are there at least two usable quotes on it, and does its spot agree
 * with the vault's.
 */
export function checkVolMarket(ctx: VolContext | null | undefined, spotUsdg6: bigint, settings: VolSettings): VolMarket | VolFailure {
  if (!ctx || ctx.chain === null) {
    return { ok: false, reason: 'vol-unavailable', detail: { error: ctx?.error ?? 'no chain was fetched' } };
  }
  const { chain, closeDay, nowSeconds } = ctx;
  const expectedRoot = settings.expectedRoot ?? CBOE_ROOT;
  if (chain.root !== expectedRoot) {
    return { ok: false, reason: 'vol-inconsistent', detail: { why: 'the chain is for another symbol', symbol: chain.root, expectedRoot } };
  }
  const fresh = chainFreshness(chain, nowSeconds, settings.maxAgeS, settings.holidays ?? NYSE_HOLIDAYS_2026_2027);
  if (!fresh.ok) return fresh;
  const rows = String(chain.options.length + chain.skippedRows);
  const skipped = { skippedRows: String(chain.skippedRows), rows, firstSkip: chain.firstSkip ?? 'none' };
  if (chain.skippedRows > 0 && chain.skippedRows > MAX_SKIPPED_ROW_FRACTION * (chain.options.length + chain.skippedRows)) {
    return { ok: false, reason: 'vol-inconsistent', detail: { why: 'most option rows do not parse: the feed format changed', ...skipped } };
  }
  const expiry = selectExpiry(chain, closeDay);
  if (expiry === null) return { ok: false, reason: 'vol-no-expiry', detail: { closeDay, chainTimestamp: chain.timestamp, ...skipped } };
  const quotes = filterQuotes(expiry.calls);
  if (quotes.length < 2) {
    return { ok: false, reason: 'vol-no-quotes', detail: { closeDay, listedCalls: String(expiry.calls.length), usableQuotes: String(quotes.length), ...skipped } };
  }
  const spot = mapSpot(chain.shareSpot, spotUsdg6, settings.maxDivergenceBps);
  if (!spot.ok) return spot;
  return {
    ok: true,
    expiry: expiry.expiry,
    quotes,
    ratio: spot.ratio,
    shareSpot: chain.shareSpot,
    tokenSpot: spot.tokenSpot,
    divergenceBps: spot.divergenceBps,
    ageSeconds: fresh.ageSeconds,
    chainTimestamp: chain.timestamp,
    lastTradeTime: chain.lastTradeTime,
  };
}

/** The New York calendar day of an exercise timestamp: the listed expiry a live cycle prices
 *  against on a reprice (the vault's cycleExerciseTs is the close of that day). */
export function closeDayOf(exerciseTs: number | bigint): string {
  const p = newYorkParts(Number(exerciseTs));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
