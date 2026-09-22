/**
 * Real-data replay harness for the pricing service (K3-304). No network, no credential, no
 * provider contact: chains come from files, the spot from a synthetic round over the chain's own
 * underlying, and every answer comes from the real PricingService through the provider-neutral
 * seam (K3-311).
 *
 * Two data paths, kept strictly apart:
 *   private  loadCboeFixtureDir reads real Cboe downloads from a directory OUTSIDE the repo named
 *            by PRICING_PRIVATE_FIXTURES_DIR. Nothing private is ever committed; the tests that
 *            use it skip with an explicit reason when the variable is unset.
 *   neutral  committed fixtures (fixtures/synthetic-chains.ts) restated by the fake providers
 *            (fake-provider.ts): listed quotes, vendor theoretical values, stale, empty, crossed
 *            and zero-bid books, missing timestamps.
 *
 * THE LADDER. crankerLadderRungs mirrors what stepLadders maintains on chain (cranker/steps.ts):
 * the upcoming weekly (Friday, walked back over full-day holidays) and daily (every session day)
 * closes from the NYSE calendar the service already prices with, `expiriesAhead` of each tenor,
 * each expiry crossed with `ladderStrikes` (cranker/planner.ts) at the market's strikeTick. A rung
 * the chain does not list prices interpolated or modeled or refuses, exactly like the live
 * service; the replay records the outcome, never throws on bad data.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCboeChain, type CboeChain } from '../../vol.js';
import { CLOSE_HOUR_ET, NYSE_HOLIDAYS_2026_2028, newYorkParts, newYorkTimeToUnix } from '../../calendar.js';
import { ladderStrikes } from '../cranker/planner.js';
import { TENORS, type LadderParams, type Tenor } from '../registry.js';
import { CBOE_PROVIDER, cboeToNormalized } from './cboe.js';
import type { NormalizedChain, OptionChainProvider, ProviderDescriptor } from './chain.js';
import { createFakeProvider } from './fake-provider.js';
import type { FairOutcome, FairRequest, PricingService } from './fair.js';
import type { FeedRound, SpotReader } from './spot.js';

/*//////////////////////////////////////////////////////////////
                    THE CRANKER'S LADDER, OFFLINE
//////////////////////////////////////////////////////////////*/

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The listed day's 16:00 New York close as unix seconds (surface.ts dayCloseUnix). */
export function sessionCloseUnix(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return newYorkTimeToUnix(year, month, date, CLOSE_HOUR_ET);
}

function addDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

const isoOf = (parts: { year: number; month: number; day: number }) => `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;

/**
 * The next `count` session-day closes still ahead of `fromUnix`: every New York weekday that is
 * not a full-day holiday, the same rule the daily ladder's `nextExpiry(after, false)` follows.
 */
export function upcomingDailyCloses(fromUnix: number, count: number, holidays: readonly string[] = NYSE_HOLIDAYS_2026_2028): number[] {
  const closed = new Set(holidays);
  const out: number[] = [];
  const today = newYorkParts(fromUnix);
  let cursor = addDays({ year: today.year, month: today.month, day: today.day }, -1);
  for (let guard = 0; out.length < count && guard < 40 * count + 10; guard += 1) {
    cursor = addDays(cursor, 1);
    const iso = isoOf(cursor);
    if (closed.has(iso)) continue;
    const close = sessionCloseUnix(iso);
    const { weekday } = newYorkParts(close);
    if (weekday === 0 || weekday === 6 || close <= fromUnix) continue;
    out.push(close);
  }
  return out;
}

/**
 * The next `count` weekly closes still ahead of `fromUnix`: each Friday (this week's included
 * when its close is still ahead), walked back over full-day holidays to the last open weekday —
 * the weekly rule of calendar.ts nextWeekWindow and the ladder's `nextExpiry(after, true)`.
 */
export function upcomingWeeklyCloses(fromUnix: number, count: number, holidays: readonly string[] = NYSE_HOLIDAYS_2026_2028): number[] {
  const closed = new Set(holidays);
  const out: number[] = [];
  const today = newYorkParts(fromUnix);
  // This week's Friday (today itself when today is Friday), then every following Friday.
  for (let daysAhead = (5 - today.weekday + 7) % 7, guard = 0; out.length < count && guard < 60; daysAhead += 7, guard += 1) {
    let close = addDays(today, daysAhead);
    let iso = isoOf(close);
    for (let steps = 0; closed.has(iso) && steps < 4; steps += 1) {
      close = addDays(close, -1);
      iso = isoOf(close);
    }
    const closeUnix = sessionCloseUnix(iso);
    if (closeUnix > fromUnix) out.push(closeUnix);
  }
  return out;
}

export interface LadderRung {
  tenor: Tenor;
  /** The Stonkhouse series expiry (the listed day's 16:00 ET close), unix seconds. */
  expiry: number;
  /** USDG base units per whole share. */
  strike: bigint;
}

/**
 * The rungs the cranker maintains for one market (calls; puts mirror with isPut): each of the
 * first `expiriesAhead` closes of every tenor, crossed with `ladderStrikes` at `strikeTick`.
 * The spot is the chain's own underlying price (share terms); a chain without one has no ladder.
 */
export function crankerLadderRungs(
  chain: NormalizedChain,
  options: {
    ladder: Record<Tenor, LadderParams>;
    expiriesAhead: Record<Tenor, number>;
    strikeTick: bigint;
    /** The replay's "now": closes not after this are skipped (the surface's horizon rule). */
    fromUnix: number;
    holidays?: readonly string[];
  },
): LadderRung[] {
  const price = chain.underlying.price;
  if (price === null || !(price > 0)) return [];
  const spot = BigInt(Math.round(price * 1e6));
  const closes: Record<Tenor, number[]> = {
    weekly: upcomingWeeklyCloses(options.fromUnix, options.expiriesAhead.weekly, options.holidays),
    daily: upcomingDailyCloses(options.fromUnix, options.expiriesAhead.daily, options.holidays),
  };
  const rungs: LadderRung[] = [];
  for (const tenor of TENORS) {
    for (const expiry of closes[tenor]) {
      for (const strike of ladderStrikes(spot, options.ladder[tenor], options.strikeTick, false)) {
        rungs.push({ tenor, expiry, strike });
      }
    }
  }
  return rungs;
}

/*//////////////////////////////////////////////////////////////
                    PRIVATE CBOE FIXTURES (REAL DATA)
//////////////////////////////////////////////////////////////*/

/**
 * Every `*.json` file in `dir` parsed as a Cboe delayed chain (vol.ts parseCboeChain), keyed by
 * option root. Unreadable files and non-Cboe payloads throw with every offender named; duplicate
 * roots throw. The directory lives OUTSIDE the repo (PRICING_PRIVATE_FIXTURES_DIR): nothing here
 * is ever committed.
 */
export function loadCboeFixtureDir(dir: string): ReadonlyMap<string, CboeChain> {
  const out = new Map<string, CboeChain>();
  const problems: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const chain = parseCboeChain(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (out.has(chain.root)) throw new Error(`a second chain for root ${chain.root}`);
      out.set(chain.root, chain);
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) throw new Error(`unusable private Cboe fixtures in ${dir}:\n  ${problems.join('\n  ')}`);
  return out;
}

/**
 * The fixtures as an OptionChainProvider: each CboeChain converted through the seam's own
 * cboeToNormalized and served by root, `receivedAt` restamped from the service clock like a real
 * download (fake-provider.ts). The descriptor defaults to Cboe's own: real files are Cboe data.
 */
export function cboeFixtureProvider(fixtures: ReadonlyMap<string, CboeChain>, descriptor: ProviderDescriptor = CBOE_PROVIDER): OptionChainProvider {
  const normalized: Record<string, NormalizedChain> = {};
  for (const [root, chain] of fixtures) normalized[root] = cboeToNormalized(chain, 0);
  return createFakeProvider(descriptor, normalized);
}

/**
 * A SpotReader consistent with `chain`: one synthetic round answering the chain's own underlying
 * price in feed terms (8 decimals), stamped at the underlying's observation (or `fallbackAt` when
 * the chain states none), so the service's divergence check compares the chain with itself.
 */
export function chainSpotReader(chain: NormalizedChain, fallbackAt: number): SpotReader {
  const price = chain.underlying.price;
  if (price === null || !(price > 0)) throw new Error('the chain states no usable underlying price');
  const updatedAt = BigInt(chain.underlying.observedAt ?? fallbackAt);
  const round: FeedRound = { roundId: 1n, answer: BigInt(Math.round(price * 1e8)), updatedAt, decimals: 8 };
  return async () => round;
}

/*//////////////////////////////////////////////////////////////
                         LADDER REPLAY
//////////////////////////////////////////////////////////////*/

export interface RungOutcome {
  tenor: Tenor;
  expiry: number;
  strike: bigint;
  result:
    | { ok: true; fairUsdg6: bigint; source: string; method: string; readiness: string; reasons: string[] }
    | { ok: false; reason: string };
}

/**
 * Price every rung through the service. A refusal is an outcome, never a throw; anything else
 * that goes wrong one rung must not take the rest of the ladder with it.
 */
export async function replayLadder(svc: PricingService, ticker: string, rungs: readonly LadderRung[]): Promise<RungOutcome[]> {
  const out: RungOutcome[] = [];
  for (const rung of rungs) {
    const request: FairRequest = { ticker, strikeUsdg6: rung.strike, expiry: rung.expiry, type: 'call' };
    let outcome: FairOutcome;
    try {
      outcome = await svc.fair(request);
    } catch (error) {
      out.push({ ...rung, result: { ok: false, reason: `threw: ${error instanceof Error ? error.message : String(error)}` } });
      continue;
    }
    out.push({
      ...rung,
      result: outcome.ok
        ? {
            ok: true,
            fairUsdg6: outcome.fairUsdg6,
            source: outcome.source,
            method: outcome.method,
            readiness: outcome.provenance.quality.readiness,
            reasons: [...outcome.provenance.quality.reasons],
          }
        : { ok: false, reason: outcome.reason },
    });
  }
  return out;
}
