/**
 * The live underlying, implied from the option book: a put-call parity forward over near-the-money
 * pairs of the nearest listed expiry, each pair judged by its own quote clocks.
 *
 * WHY. Massive gives REAL-TIME option quotes but only a 15-minute DELAYED underlying on an options-only
 * key (massive.ts TWO TIMEFRAMES; its stock endpoints answer 403). fair.ts used that delayed price as the
 * equity spot the token spot is mapped against (vol.ts mapSpot) and gated by maxSpotDivergenceBps. For
 * a 0DTE series 15 minutes is a lot of the day. The option quotes themselves carry the live price:
 * at r = 0 a same-expiry, same-strike call and put satisfy C - P = F - K, so F = K + C_mid - P_mid.
 * When this forward is available it replaces `chain.underlying.price` in the mapping and in the gate.
 * When it is not, fair.ts falls back to the provider's underlying price, as before, and says so.
 *
 * THE RULE.
 *   expiry   the earliest listed expiry day on or after today in New York (the 0DTE day when one is
 *            listed), skipping today's once its 16:00 close has passed: an expired listing's last quotes
 *            say where the stock closed, not where it is. The forward of a later expiry carries a
 *            dividend and financing term the 0DTE one does not, and is not the spot.
 *   pairs    a strike with a usable call AND put quote: both sides present, bid >= 0, ask >= bid, ask > 0.
 *   stale    a pair is dropped when either leg's OWN quote time is unknown or older than `maxQuoteAgeS`
 *            at `nowSeconds`. Never the chain's download time, never the underlying's clock
 *            (chain.ts MISSING IS NOT ZERO).
 *   wide     a pair is dropped when the sum of its two spreads, the width of the interval F can sit in,
 *            is more than `maxPairSpreadBps` of the reference spot.
 *   near     of the pairs left, the `maxPairs` strikes nearest the reference spot, within `strikeBandBps`.
 *   agree    a pair whose forward is more than its own half-width plus `agreeSlackBps` from the median is
 *            dropped as an outlier (a stale leg the clock did not catch, a crossed book).
 *   weight   the remaining forwards are averaged with weight 1 / width^2, the inverse variance of a
 *            uniform error across the pair's interval: a tight ATM pair counts for more than a wide wing.
 *   enough   fewer than `minPairs` pairs left: no forward.
 * The reference spot only chooses which strikes are "near"; it never enters F.
 *
 * Pure.
 */
import type { ChainRow, NormalizedChain } from './chain.js';

export interface ForwardSettings {
  /** Oldest quote a pair may use, by the quote's own clock. */
  maxQuoteAgeS: number;
  /** Sum of both legs' spreads, as bps of the reference spot. */
  maxPairSpreadBps: number;
  /** Strikes considered, nearest the reference first. */
  maxPairs: number;
  /** Least pairs a forward rests on. */
  minPairs: number;
  /** Only strikes within this distance of the reference, bps. */
  strikeBandBps: number;
  /** Slack on top of a pair's half-width when it is compared with the median, bps of the reference. */
  agreeSlackBps: number;
}

export const DEFAULT_FORWARD_SETTINGS: ForwardSettings = {
  maxQuoteAgeS: 120,
  maxPairSpreadBps: 100,
  maxPairs: 6,
  minPairs: 2,
  strikeBandBps: 1_000,
  agreeSlackBps: 10,
};

export interface ForwardPair {
  strike: number;
  forward: number;
  /** Sum of the two spreads, USD per share. */
  width: number;
  weight: number;
  /** The older of the two quotes' own times. */
  observedAt: number;
}

export type ForwardDrop = 'stale' | 'wide' | 'far' | 'outlier' | 'one-sided';

export type ImpliedForward =
  | {
      ok: true;
      /** USD per share. */
      forward: number;
      expiryDay: string;
      pairs: ForwardPair[];
      /** The oldest quote the forward used. */
      observedAt: number;
      dropped: Record<ForwardDrop, number>;
    }
  | { ok: false; why: string; expiryDay: string | null; dropped: Record<ForwardDrop, number> };

/** YYYY-MM-DD in New York at `unixSeconds`. */
export function newYorkDay(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSeconds * 1000));
}

/** Whether `unixSeconds` is at or after 16:00 New York, the regular close, on its own New York day. */
export function afterNewYorkClose(unixSeconds: number): boolean {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(unixSeconds * 1000));
  return hm >= '16:00';
}

const mid = (bid: number, ask: number) => (bid + ask) / 2;

function usableLeg(row: ChainRow | undefined): { bid: number; ask: number; at: number | null } | null {
  const q = row?.quote;
  if (q === undefined || q === null || q.bid === null || q.ask === null) return null;
  if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid < 0 || q.ask <= 0 || q.ask < q.bid) return null;
  return { bid: q.bid, ask: q.ask, at: q.observedAt };
}

/** The parity forward of the nearest listed expiry. See the header. */
export function impliedForward(chain: NormalizedChain, reference: number, nowSeconds: number, settings: ForwardSettings = DEFAULT_FORWARD_SETTINGS): ImpliedForward {
  const dropped: Record<ForwardDrop, number> = { stale: 0, wide: 0, far: 0, outlier: 0, 'one-sided': 0 };
  if (!(Number.isFinite(reference) && reference > 0)) return { ok: false, why: 'no positive reference spot', expiryDay: null, dropped };
  const root = chain.underlying.providerSymbol;
  const today = newYorkDay(nowSeconds);
  const days = [...new Set(chain.rows.filter((r) => r.instrument.root === null || r.instrument.root === root).map((r) => r.instrument.expiryDay))]
    .filter((d) => d > today || (d === today && !afterNewYorkClose(nowSeconds)))
    .sort();
  const expiryDay = days[0] ?? null;
  if (expiryDay === null) return { ok: false, why: 'no listed expiry today or later', expiryDay, dropped };

  const byStrike = new Map<number, { C?: ChainRow; P?: ChainRow }>();
  for (const row of chain.rows) {
    const i = row.instrument;
    if (i.expiryDay !== expiryDay || (i.root !== null && i.root !== root)) continue;
    if (i.multiplier !== null && i.multiplier !== 100) continue;
    const key = Math.round(i.strike * 1_000);
    const slot = byStrike.get(key) ?? {};
    slot[i.side] = row;
    byStrike.set(key, slot);
  }

  const candidates: ForwardPair[] = [];
  for (const [key, slot] of byStrike) {
    const strike = key / 1_000;
    if ((Math.abs(strike / reference - 1) * 10_000) > settings.strikeBandBps + 1e-9) {
      dropped.far += 1;
      continue;
    }
    const c = usableLeg(slot.C);
    const p = usableLeg(slot.P);
    if (c === null || p === null) {
      dropped['one-sided'] += 1;
      continue;
    }
    if (c.at === null || p.at === null || nowSeconds - Math.min(c.at, p.at) > settings.maxQuoteAgeS) {
      dropped.stale += 1;
      continue;
    }
    const width = c.ask - c.bid + (p.ask - p.bid);
    if ((width / reference) * 10_000 > settings.maxPairSpreadBps + 1e-9) {
      dropped.wide += 1;
      continue;
    }
    // A zero-width pair would take all the weight: floor the width at a tenth of a cent.
    const w = Math.max(width, 0.001);
    candidates.push({ strike, forward: strike + mid(c.bid, c.ask) - mid(p.bid, p.ask), width, weight: 1 / (w * w), observedAt: Math.min(c.at, p.at) });
  }

  const near = candidates.sort((a, b) => Math.abs(a.strike - reference) - Math.abs(b.strike - reference) || a.strike - b.strike).slice(0, settings.maxPairs);
  dropped.far += candidates.length - near.length;
  if (near.length < settings.minPairs) return { ok: false, why: `${near.length} usable pair(s) at ${expiryDay}, fewer than ${settings.minPairs}`, expiryDay, dropped };

  const sorted = near.map((p) => p.forward).sort((a, b) => a - b);
  const h = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[h]! : (sorted[h - 1]! + sorted[h]!) / 2;
  const slack = (settings.agreeSlackBps / 10_000) * reference;
  const pairs = near.filter((p) => Math.abs(p.forward - median) <= p.width / 2 + slack + 1e-9);
  dropped.outlier += near.length - pairs.length;
  if (pairs.length < settings.minPairs) return { ok: false, why: `${pairs.length} agreeing pair(s) at ${expiryDay}, fewer than ${settings.minPairs}`, expiryDay, dropped };

  const total = pairs.reduce((s, p) => s + p.weight, 0);
  const forward = pairs.reduce((s, p) => s + p.forward * p.weight, 0) / total;
  if (!(Number.isFinite(forward) && forward > 0)) return { ok: false, why: 'the weighted forward is not positive', expiryDay, dropped };
  pairs.sort((a, b) => a.strike - b.strike);
  return { ok: true, forward, expiryDay, pairs, observedAt: Math.min(...pairs.map((p) => p.observedAt)), dropped };
}
