/**
 * Whether a /fair answer is usable for a reprice (K3-301).
 *
 * TODAY the pricing service serializes only the legacy body (server.ts): fair, source, spot, asOf
 * where asOf is the Cboe underlying last-trade time, not an option quote time. Gate on that.
 * When an additive `provenance` object is present (02-interfaces.md §5.1, consumer-first), use it
 * and never require it: quote age comes only from quoteObservedAt; a refetch does not refresh an
 * old observation; unknown reason codes are not ready; zero fair is a number, not unavailable.
 *
 * Pure. The tick maps a refusal onto PairReport.outcome and the fair-unavailable timer.
 */
import { getAddress } from 'viem';
import { BPS } from '../cranker/constants.js';
import type { FairAnswer } from './fair-client.js';

/** §5.1 initial reason codes, plus the internal codes provenance.ts already emits. */
export const KNOWN_PROVENANCE_REASONS = new Set([
  'quote-stale',
  'quote-age-unknown',
  'underlying-stale',
  'underlying-age-unknown',
  'volatility-stale',
  'expired',
  'spot-unavailable',
  'spot-divergence',
  'identity-unmapped',
  'identity-mismatch',
  'multiplier-mismatch',
  'book-empty',
  'book-one-sided',
  'book-crossed',
  'no-quotes',
  'chain-unavailable',
  'chain-inconsistent',
  'source-disagreement',
  'extrapolated',
  'event-uncertainty',
  'model-uncertainty',
  'fallback-provider',
  'entitlement-insufficient',
  'external-indicative',
]);

export interface FairGateContext {
  now: number;
  maxAgeS: number;
  spotToleranceBps: number;
  oracleSpot: bigint | null;
  ticker: string;
  underlying: string;
  strike: bigint;
  expiry: number;
  type: 'call' | 'put';
  /** Registry 1e18-scaled uiMultiplier when the pricer has it; otherwise null. */
  uiMultiplier: string | null;
}

export type FairGate =
  | { ok: true; fair: bigint; source: string }
  | { ok: false; reason: string; detail: string };

function ageOf(now: number, observedAt: number): number {
  return Math.max(0, now - observedAt);
}

function addressesEqual(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** |fairSpot − oracleSpot| in bps of the oracle spot. Both sides are token USDG6. */
export function spotGapBps(fairSpot: bigint, oracleSpot: bigint): bigint {
  if (oracleSpot <= 0n) return 0n;
  const gap = fairSpot > oracleSpot ? fairSpot - oracleSpot : oracleSpot - fairSpot;
  return (gap * BPS) / oracleSpot;
}

function unknownReason(reasons: readonly string[]): string | null {
  for (const code of reasons) {
    if (!KNOWN_PROVENANCE_REASONS.has(code)) return code;
  }
  return null;
}

function qualifyProvenance(answer: Extract<FairAnswer, { ok: true }>, ctx: FairGateContext): FairGate | null {
  const p = answer.provenance;
  if (p === undefined) return null;

  const reasons = p.quality?.reasons ?? [];
  const unknown = unknownReason(reasons);
  if (unknown !== null) {
    return { ok: false, reason: 'not-ready', detail: `unknown provenance reason ${unknown}` };
  }
  const readiness = p.quality?.readiness;
  if (readiness === 'unavailable' || readiness === 'degraded' || reasons.length > 0) {
    const code = reasons[0] ?? 'not-ready';
    return { ok: false, reason: code, detail: `provenance readiness ${readiness ?? 'missing'}: ${reasons.join(',') || 'no reason'}` };
  }
  if (readiness !== undefined && readiness !== 'ready') {
    return { ok: false, reason: 'not-ready', detail: `provenance readiness ${readiness}` };
  }

  const id = p.identity;
  if (id !== undefined) {
    if (typeof id.market === 'string' && id.market !== ctx.ticker) {
      return { ok: false, reason: 'identity-mismatch', detail: `provenance market ${id.market} is not ${ctx.ticker}` };
    }
    const tokenAddr = id.token?.address;
    if (typeof tokenAddr === 'string' && tokenAddr.length > 0 && !addressesEqual(tokenAddr, ctx.underlying)) {
      return { ok: false, reason: 'identity-mismatch', detail: `provenance token ${tokenAddr} is not ${ctx.underlying}` };
    }
    const option = id.option;
    if (option !== undefined) {
      if (option.side !== undefined && option.side !== ctx.type) {
        return { ok: false, reason: 'identity-mismatch', detail: `provenance side ${option.side} is not ${ctx.type}` };
      }
      if (typeof option.expiry === 'number' && option.expiry !== ctx.expiry) {
        return { ok: false, reason: 'identity-mismatch', detail: `provenance expiry ${option.expiry} is not ${ctx.expiry}` };
      }
      if (option.strike !== undefined && option.strike !== ctx.strike) {
        return { ok: false, reason: 'identity-mismatch', detail: `provenance strike ${option.strike} is not ${ctx.strike}` };
      }
    }
    const tokenMult = id.token?.uiMultiplier ?? null;
    if (tokenMult !== null && ctx.uiMultiplier !== null && tokenMult !== ctx.uiMultiplier) {
      return { ok: false, reason: 'multiplier-mismatch', detail: `provenance uiMultiplier ${tokenMult} vs registry ${ctx.uiMultiplier}` };
    }
  }

  const quoteAt = p.clocks?.quoteObservedAt ?? null;
  if (quoteAt === null) {
    return { ok: false, reason: 'quote-age-unknown', detail: 'provenance.clocks.quoteObservedAt is null; quote age is not asOf or receivedAt' };
  }
  const quoteAge = ageOf(ctx.now, quoteAt);
  if (quoteAge > ctx.maxAgeS) {
    return { ok: false, reason: 'quote-stale', detail: `quoteObservedAt ${quoteAt} is ${quoteAge} s old (limit ${ctx.maxAgeS})` };
  }
  return { ok: true, fair: answer.fair, source: answer.source };
}

function qualifySpot(answer: Extract<FairAnswer, { ok: true }>, ctx: FairGateContext): FairGate | null {
  if (ctx.spotToleranceBps <= 0 || ctx.oracleSpot === null || ctx.oracleSpot <= 0n) return null;
  const fairSpot = answer.provenance?.pricedSpot ?? answer.spot;
  if (fairSpot === undefined) return null;
  const gap = spotGapBps(fairSpot, ctx.oracleSpot);
  if (gap > BigInt(ctx.spotToleranceBps)) {
    return {
      ok: false,
      reason: 'fair-spot-mismatch',
      detail: `priced at spot ${fairSpot}, the oracle reads ${ctx.oracleSpot} (${gap} bps, limit ${ctx.spotToleranceBps})`,
    };
  }
  return null;
}

/**
 * A priced /fair answer, or the skip reason to put on /state. `fair: 0` with ok:true is a price.
 */
export function qualifyFair(answer: FairAnswer, ctx: FairGateContext): FairGate {
  if (!answer.ok) return { ok: false, reason: 'fair-unavailable', detail: answer.reason };

  const fromProvenance = qualifyProvenance(answer, ctx);
  if (fromProvenance !== null && !fromProvenance.ok) return fromProvenance;

  if (fromProvenance === null) {
    if (answer.asOf === null) {
      return { ok: false, reason: 'asOf-unknown', detail: 'legacy asOf (underlying last trade) is missing; unknown times are not fresh' };
    }
    const age = ageOf(ctx.now, answer.asOf);
    if (age > ctx.maxAgeS) {
      return { ok: false, reason: 'fair-stale', detail: `asOf ${answer.asOf} is ${age} s old (limit ${ctx.maxAgeS})` };
    }
  }

  const spot = qualifySpot(answer, ctx);
  if (spot !== null) return spot;
  return { ok: true, fair: answer.fair, source: answer.source };
}
