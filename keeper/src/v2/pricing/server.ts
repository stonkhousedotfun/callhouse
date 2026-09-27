/**
 * The pricing service's HTTP surface. Hono, built around a PricingService so
 * a test drives it with `app.request` and an injected spot, no socket and no network.
 *
 *   GET /fair?ticker=NVDA&strike=231000000&expiry=1790020800&type=call
 *       200 { fair: Money, iv, delta, source: "cboe"|"model", spot: Money, asOf }
 *       200 { fair: null, reason, detail }   the market data does not support a price (cboe.ts
 *                                            PricingReason). Never an error status: "no price
 *                                            right now" is an answer, and the MM bot and the
 *                                            indexer treat it as one.
 *       400 { fair: null, reason: "bad-request", detail }      malformed parameters
 *       404 { fair: null, reason: "unknown-ticker", detail }   not in the registry
 *     `strike` is USDG base units per whole token, `expiry` unix seconds, `type` call|put. `spot` is
 *     the token spot the price is for; `asOf` the chain's pricing clock (Cboe: its last trade, unix
 *     seconds). The service's internal provenance (fair.ts FairQuote.provenance) is NOT in the body. `iv` is
 *     on the trading clock (bs.ts), so it reads below Cboe's calendar-day iv over spans without a
 *     weekend; `iv` and `delta` are rounded to 6 dp.
 *     ADDED, never renamed (every field above is unchanged):
 *       gamma, vega      at `iv`; vega per 1.00 of vol (6 dp)
 *       askIv            max(iv, realizedVol, floor) marked up, >= iv (fair.ts askIvFor; 6 dp)
 *       realizedVol      the pool's in-session realized vol (realized.ts), or null
 *       quality          { readiness, reasons, uncertainty: { ivLow, ivHigh, fairLow, fairHigh } | null }: the internal
 *                        provenance's quality, the one slice of it a quoting bot needs
 *       event            { input: supplied|missing|short, inWindow }. `input: missing` means no calendar for the
 *                        ticker, which is unknown, not clear.
 *     NEVER A `provenance` KEY. The indexer (indexer/lib/v2/pricing.ts fairResult) reads an own `provenance`
 *     key as the full O3-307/1 provenance and DISCARDS THE WHOLE QUOTE when it does not parse, so a partial
 *     one here would blank every quote the indexer proxies. quality and event are top-level for that reason.
 *
 *   GET /surface/:ticker
 *       200 { ticker, root, asOf, chainTimestamp, spot: Money, expiries: [{ expiry, day, forward:
 *             Money|null, status, strikes: [{ strike, iv, callMid, putMid, delta }] }] }
 *       200 { expiries: null, reason, detail }  (404 for an unknown ticker)
 *     IN THE LISTED MARKET'S TERMS: strikes and mids are USDG per SHARE as Cboe lists them, `spot` is
 *     Cboe's equity price, `delta` the call delta at the expiry's forward. A token strike is a share
 *     strike times tokenSpot/spot; the vols carry over unchanged. `status` is "ok" or the reason the
 *     expiry is unusable (its strikes are then empty).
 *
 *   GET /health   200 always while the process serves: liveness. `status: "degraded"` when the
 *                 latest download of any chain failed, or a chain no longer passes its own clocks
 *                 (`usable`: chain-stale, chain-inconsistent), which refuses every /fair of it;
 *                 per-ticker detail under `chains`, with the provider serving them (`chainProvider`) and
 *                 each chain's stated entitlement (`real-time`, `delayed`, `unknown`). `spots` has each
 *                 ticker's latest spot inputs: the Chainlink spot, the equity reference and
 *                 whether it was the parity forward, the pool spot and its divergence from Chainlink,
 *                 and which spot priced; `settings` the pool and forward limits. `eventRecheck`:
 *                 per ticker with a re-check day in the event calendar, { recheckBy, overdue, coveredBy }
 *                 (events.ts eventRecheckStatus, New York days); null when the app was built without the
 *                 calendar's re-check days. An overdue ticker does not degrade `status`: its /fair still
 *                 answers, with the event input `missing`, and ops/v2/monitor.mjs pages on it instead.
 *
 * Every Money is { raw, decimals: 6, formatted }, formatted with viem's formatUnits like the
 * indexer. Unexpected exceptions become 500 { fair: null, reason: "internal-error" } and are
 * logged; market data never gets that far.
 */
import { Hono } from 'hono';
import { formatUnits } from 'viem';
import type { PricingReason } from './cboe.js';
import { eventRecheckStatus, type EventRecheckSchedule } from './events.js';
import type { FairQuote, PricingLog, PricingService } from './fair.js';
import type { PricingFailure } from './cboe.js';
import type { EventCalendar } from './short-maturity.js';

export type Money = { raw: string; decimals: number; formatted: string };

export function money(raw: bigint): Money {
  return { raw: raw.toString(), decimals: 6, formatted: formatUnits(raw, 6) };
}

/** Share-space dollars (a Cboe strike or mid) as Money, to the nearest base unit. */
function usdMoney(usd: number): Money {
  return money(BigInt(Math.round(usd * 1e6)));
}

function round6(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

const TICKER_RE = /^[A-Z0-9.]{1,8}$/;
/** A positive integer of at most 18 digits: strikes up to a trillion USDG, well inside 2^53 once / 1e6. */
const STRIKE_RE = /^[1-9]\d{0,17}$/;
const EXPIRY_RE = /^[1-9]\d{0,10}$/;
/** 10^15 base units = one billion USDG per token: no Stock Token is priced there. */
const MAX_STRIKE_USDG6 = 10n ** 15n;

type Query = { ticker?: string; strike?: string; expiry?: string; type?: string };

export type ParsedFairQuery =
  | { ok: true; ticker: string; strikeUsdg6: bigint; expiry: number; type: 'call' | 'put' }
  | { ok: false; detail: Record<string, string> };

export function parseFairQuery(query: Query): ParsedFairQuery {
  const detail: Record<string, string> = {};
  const ticker = (query.ticker ?? '').trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) detail.ticker = 'an upper-case registry ticker, e.g. NVDA';
  const strikeRaw = (query.strike ?? '').trim();
  let strikeUsdg6 = 0n;
  if (!STRIKE_RE.test(strikeRaw)) detail.strike = 'a positive integer: USDG base units per whole token (231 USDG = 231000000)';
  else {
    strikeUsdg6 = BigInt(strikeRaw);
    if (strikeUsdg6 > MAX_STRIKE_USDG6) detail.strike = `at most ${MAX_STRIKE_USDG6} base units`;
  }
  const expiryRaw = (query.expiry ?? '').trim();
  if (!EXPIRY_RE.test(expiryRaw)) detail.expiry = 'unix seconds';
  const type = (query.type ?? '').trim().toLowerCase();
  if (type !== 'call' && type !== 'put') detail.type = 'call or put';
  if (Object.keys(detail).length > 0) return { ok: false, detail };
  return { ok: true, ticker, strikeUsdg6, expiry: Number(expiryRaw), type: type as 'call' | 'put' };
}

/** What the /fair body reads from an outcome: the legacy fields, plus the added fields when the outcome has
 *  them (a caller holding only the legacy shape still gets the legacy body). Never the rest of the provenance. */
export type FairBodyInput =
  | PricingFailure
  | (Pick<FairQuote, 'ok' | 'fairUsdg6' | 'iv' | 'delta' | 'source' | 'method' | 'days' | 'spotUsdg6' | 'asOf'> &
      Partial<Pick<FairQuote, 'gamma' | 'vega' | 'askIv' | 'realizedVol' | 'event'>> & { provenance?: Pick<FairQuote['provenance'], 'quality'> });

function round6OrNull(x: number | null | undefined): number | null {
  return x === null || x === undefined || !Number.isFinite(x) ? null : round6(x);
}

/** The /fair body for an outcome, and its status. */
export function fairResponse(outcome: FairBodyInput): { status: 200 | 404; body: Record<string, unknown> } {
  if (!outcome.ok) {
    return { status: outcome.reason === 'unknown-ticker' ? 404 : 200, body: { fair: null, reason: outcome.reason, detail: outcome.detail } };
  }
  return {
    status: 200,
    body: {
      fair: money(outcome.fairUsdg6),
      iv: round6(outcome.iv),
      delta: round6(outcome.delta),
      source: outcome.source,
      spot: money(outcome.spotUsdg6),
      asOf: outcome.asOf,
      ...(outcome.gamma === undefined ? {} : { gamma: round6(outcome.gamma) }),
      ...(outcome.vega === undefined ? {} : { vega: round6(outcome.vega) }),
      ...(outcome.askIv === undefined ? {} : { askIv: round6(outcome.askIv) }),
      ...(outcome.realizedVol === undefined ? {} : { realizedVol: round6OrNull(outcome.realizedVol) }),
      ...(outcome.provenance === undefined
        ? {}
        : {
            quality: {
              readiness: outcome.provenance.quality.readiness,
              reasons: [...outcome.provenance.quality.reasons],
              uncertainty:
                outcome.provenance.quality.uncertainty === null
                  ? null
                  : {
                      ivLow: round6OrNull(outcome.provenance.quality.uncertainty.ivLow),
                      ivHigh: round6OrNull(outcome.provenance.quality.uncertainty.ivHigh),
                      fairLow: outcome.provenance.quality.uncertainty.fairLowUsdg6 === null ? null : money(outcome.provenance.quality.uncertainty.fairLowUsdg6),
                      fairHigh: outcome.provenance.quality.uncertainty.fairHighUsdg6 === null ? null : money(outcome.provenance.quality.uncertainty.fairHighUsdg6),
                    },
            },
          }),
      ...(outcome.event === undefined ? {} : { event: { input: outcome.event.input, inWindow: outcome.event.inWindow } }),
    },
  };
}

export interface PricingAppOptions {
  /** The event calendar's re-check days and the calendar that covers them (events.ts), for /health. */
  eventRecheck?: { recheckBy: EventRecheckSchedule; calendar: EventCalendar };
  /** SEAM: wall clock, ms, for the re-check days. */
  nowMs?: () => number;
}

export function createPricingApp(service: PricingService, log?: PricingLog, options: PricingAppOptions = {}): Hono {
  const app = new Hono();
  const nowMs = options.nowMs ?? Date.now;

  app.onError((error, c) => {
    log?.warn({ err: error instanceof Error ? error.message : String(error), path: c.req.path }, 'pricing request failed');
    return c.json({ fair: null, reason: 'internal-error' }, 500);
  });

  app.get('/fair', async (c) => {
    const parsed = parseFairQuery(c.req.query());
    if (!parsed.ok) return c.json({ fair: null, reason: 'bad-request', detail: parsed.detail }, 400);
    const { ok: _ok, ...request } = parsed;
    const { status, body } = fairResponse(await service.fair(request));
    return c.json(body, status);
  });

  app.get('/surface/:ticker', async (c) => {
    const ticker = c.req.param('ticker').trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) return c.json({ expiries: null, reason: 'bad-request', detail: { ticker: 'an upper-case registry ticker, e.g. NVDA' } }, 400);
    const outcome = await service.surface(ticker);
    if (!outcome.ok) {
      const reason: PricingReason = outcome.reason;
      return c.json({ expiries: null, reason, detail: outcome.detail }, reason === 'unknown-ticker' ? 404 : 200);
    }
    const { surface, chain } = outcome;
    return c.json({
      ticker,
      root: surface.root,
      asOf: surface.asOf,
      chainTimestamp: chain.clocks.publishedAtText,
      spot: usdMoney(surface.shareSpot),
      expiries: surface.expiries.map((e) => ({
        expiry: e.expiry,
        day: e.day,
        forward: e.forward === null ? null : usdMoney(e.forward),
        status: e.failure === null ? 'ok' : e.failure.reason,
        strikes: e.points.map((p) => ({
          strike: usdMoney(p.strike),
          iv: round6(p.iv),
          callMid: p.callMid === null ? null : usdMoney(p.callMid),
          putMid: p.putMid === null ? null : usdMoney(p.putMid),
          delta: round6(p.delta),
        })),
      })),
    });
  });

  app.get('/health', (c) => {
    const chains: Record<string, unknown> = {};
    let failing = 0;
    let unusable = 0;
    for (const [ticker, entry] of service.chainAttempts()) {
      if (entry.error !== null) failing += 1;
      const usable = service.chainUsable(ticker);
      if (usable !== 'ok') unusable += 1;
      chains[ticker] = {
        // The latest download; a failed one still serves the last good chain (its times below).
        ok: entry.error === null,
        usable,
        fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
        error: entry.error,
        chainTimestamp: entry.chain?.clocks.publishedAtText ?? null,
        lastTradeTime: entry.chain?.underlying.observedAtText ?? null,
        options: entry.chain?.rows.length ?? null,
        // What the chain's own quotes state (massive.ts massiveEntitlement), not what the plan claims.
        entitlement: entry.chain?.provider.entitlement.class ?? null,
      };
    }
    return c.json({
      status: failing > 0 || unusable > 0 ? 'degraded' : 'ok',
      service: 'callhouse-pricing',
      uptimeSeconds: service.uptimeSeconds(),
      markets: service.markets.size,
      marketsWithChain: [...service.markets.values()].filter((m) => m.cboe !== null).length,
      chainProvider: service.chainProvider.id,
      settings: {
        maxChainAgeS: service.settings.maxChainAgeS,
        maxSpotAgeS: service.settings.maxSpotAgeS,
        maxSpotDivergenceBps: service.settings.maxSpotDivergenceBps,
        horizonDays: service.settings.horizonDays,
        poolTwapS: service.settings.poolTwapS,
        maxPoolChainlinkDivergenceBps: service.settings.maxPoolChainlinkDivergenceBps,
        poolRequired: service.settings.poolRequired,
        forwardMaxQuoteAgeS: service.settings.forward.maxQuoteAgeS,
        forwardMaxPairSpreadBps: service.settings.forward.maxPairSpreadBps,
      },
      chains,
      // The tickers the event calendar covers ([] = none supplied: every event flag reads 'missing'),
      // and each ticker's latest realized-vol read.
      eventCalendar: service.eventCalendarTickers(),
      // A ticker whose re-check day has passed with nothing covering today reads `overdue`.
      eventRecheck:
        options.eventRecheck === undefined
          ? null
          : eventRecheckStatus(options.eventRecheck.recheckBy, options.eventRecheck.calendar, Math.floor(nowMs() / 1000)),
      realized: Object.fromEntries(
        [...service.realizedReadsSnapshot()].map(([ticker, r]) => [
          ticker,
          { at: new Date(r.atMs).toISOString(), vol: r.ok ? round6(r.vol) : null, why: r.ok ? null : r.why, returns: r.returns, skipped: r.skipped },
        ]),
      ),
      spots: Object.fromEntries(
        [...service.spotInputs()].map(([ticker, s]) => [
          ticker,
          {
            at: new Date(s.atMs).toISOString(),
            chainlink: money(s.chainlinkUsdg6),
            chainlinkUpdatedAt: s.chainlinkUpdatedAt,
            forwardSource: s.equity.source,
            equity: s.equity.price === null ? null : usdMoney(s.equity.price),
            equityObservedAt: s.equity.observedAt,
            forwardExpiryDay: s.equity.expiryDay,
            forwardPairs: s.equity.pairs,
            forwardFallbackWhy: s.equity.fallbackWhy,
            equityDivergenceBps: Math.round(s.equityDivergenceBps * 10) / 10,
            pool:
              s.pool === null
                ? null
                : {
                    address: s.pool.address,
                    spot: s.pool.spotUsdg6 === null ? null : money(s.pool.spotUsdg6),
                    windowS: s.pool.windowS,
                    harmonicLiquidity: s.pool.harmonicLiquidity?.toString() ?? null,
                    minLiquidity: s.pool.minLiquidity.toString(),
                    divergenceBps: s.pool.divergenceBps === null ? null : Math.round(s.pool.divergenceBps * 10) / 10,
                    unusable: s.pool.unusable,
                  },
            pricedWith: s.pricedWith,
          },
        ]),
      ),
    });
  });

  app.get('/', (c) =>
    c.json({ service: 'callhouse-pricing', markets: [...service.markets.keys()], endpoints: ['/fair?ticker&strike&expiry&type', '/surface/:ticker', '/health'] }),
  );

  return app;
}
