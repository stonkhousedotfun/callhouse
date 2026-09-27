/**
 * The guardian watch's one decision, as a pure function of what the chain says.
 *
 * WHY THIS EXISTS. ChainlinkFeedSource's only magnitude checks are the adjacent-round jump rule and the (0, 2^128]
 * bound, so a scale fault that lasts two or more rounds passes: each mis-scaled round is compared with a mis-scaled
 * predecessor. When the pool leg disagrees, or is not ok, source 0 becomes the UNCORROBORATED candidate
 * and finalizes after the market's uncorroboratedDelay unless the GUARDIAN vetoes (SettlementOracle `_advance`). Until
 * the contract fix is deployed, that veto is the only barrier, and this is what sends it.
 *
 * THE RULE, per (underlying, expiry):
 *   - not Pending, or no candidate           nothing. Finalized is final. A corroborated price finalizes at once,
 *                                            so it never sits here. Held is already vetoed, and the cranker pages
 *                                            v2_settlement_held for it.
 *   - Pending with a candidate               page v2_guardian_candidate, once per (price, finalizableAt).
 *   - ... and a SCALE FAULT                  page v2_guardian_scale_fault, and VETO when GUARDIAN_AUTO_VETO is on.
 *   - ... and a STALE ROUND                  page v2_guardian_stale_round, and VETO when GUARDIAN_AUTO_VETO is on and
 *                                            the pool disagrees with the candidate beyond the market's band.
 *
 * A SCALE FAULT is a candidate at least `scaleFactor` times away (either direction) from EVERY reference the watch
 * could read: the pool's price and the market's last finalized price before this expiry. The candidate's own source
 * is never its own reference. With both references read, both must agree, which is the band this guard needs. With
 * only one read, that one decides. The first expiries of a market have no finalized price, and a watch that needs
 * two references would sit inert through exactly the launch window it exists for. With none, it pages and never
 * vetoes: there is nothing to measure the candidate against.
 *
 * A STALE ROUND: the candidate came from a Chainlink
 * feed whose round in force at the expiry had then been in force longer than the feed's heartbeat plus a margin,
 * i.e. the feed was down and the source priced the window from a pre-outage round, which it accepts for up to its
 * `maxStale` (26 h). That price is suspect. It is vetoed only when the pool also disagrees with it beyond the
 * market's own maxDeviationBps, which is the band SettlementOracle `_agree` corroborates with. A stale round the
 * pool agrees with is the quiet market it looks like, so it only pages.
 *
 * WHY ONLY THESE TWO VETO, and not every candidate. Vetoing every uncorroborated candidate turns every
 * pool hiccup into a Held expiry that needs a person and adminResolve. A 10x gap is not a market move. A veto is
 * recoverable (unveto, or adminResolve from expiry + 48 h). A finalized mis-scale is not.
 *
 * `now >= finalizableAt` does not stop the veto. `finalize` has to be SENT before the candidate is final, and
 * `veto` works on any Pending expiry. The plan reports it as `late` so the page says the race is on.
 */
import type { Address } from 'viem';
import type { SettlementStatusName } from '../cranker/constants.js';

export interface CandidateState {
  price: bigint;
  sourceIndex: number;
  disagreed: boolean;
  finalizableAt: number;
}

/** Everything the rule reads for one (underlying, expiry), from one block. Prices are USDG base units (6 dp) per share. */
export interface GuardianView {
  underlying: Address;
  expiry: number;
  status: SettlementStatusName;
  candidate: CandidateState | null;
  /** The pool's price for this expiry: its recorded window price, else its live TWAP. null: not readable. */
  poolPrice: bigint | null;
  /** The market's last finalized settlement price before this expiry. null: none yet, or not readable. */
  lastFinalizedPrice: bigint | null;
  /**
   * Seconds the candidate's Chainlink round in force at the expiry had been in force by then (expiry - updatedAt).
   * null: the candidate is not from a Chainlink feed source, or the round could not be found. `'unread'`:
   * the feed could not be read, so whether the round is stale is unknown; the plan says so (reason `round-unread`).
   */
  roundAge: number | null | 'unread';
  /** The expiry's pinned maxDeviationBps (the corroboration band). null: not readable. */
  maxDeviationBps: number | null;
  /** Unix seconds, from the block the view was read at. */
  now: number;
}

export interface GuardianThresholds {
  /** GUARDIAN_SCALE_FACTOR: how many times away from every reference a candidate must be to count as a scale fault. */
  scaleFactor: number;
  /** GUARDIAN_AUTO_VETO: veto a scale fault, and a stale round the pool disagrees with. Off: page only. */
  autoVeto: boolean;
  /** GUARDIAN_FEED_HEARTBEAT_S + GUARDIAN_FEED_STALE_MARGIN_S: a round in force longer than this is stale. */
  staleRoundAfterS: number;
}

export interface GuardianPlan {
  /** Page v2_guardian_candidate. */
  page: boolean;
  scaleFault: boolean;
  /** The candidate's round in force at the expiry was older than staleRoundAfterS. */
  staleRound: boolean;
  /** The pool's price and the candidate do not agree within the market's maxDeviationBps (false when either is unread). */
  poolDisagrees: boolean;
  /** Send veto(underlying, expiry). */
  veto: boolean;
  /** At or past finalizableAt: the candidate can be finalized by anyone now. */
  late: boolean;
  /** Candidate / reference, as a float for the page (1e8 for a 1e8x fault). null: that reference was not read. */
  ratios: { pool: number | null; lastFinalized: number | null };
  reason: 'not-pending' | 'no-candidate' | 'no-reference' | 'in-band' | 'scale-fault' | 'stale-round' | 'round-unread';
}

/** True when `a` and `b` are at least `factor` times apart, either way. Exact in bigints; both must be positive. */
export function scaleApart(a: bigint, b: bigint, factor: number): boolean {
  if (a <= 0n || b <= 0n) return false;
  const f = BigInt(factor);
  return a >= b * f || b >= a * f;
}

/** SettlementOracle `_agree`, mirrored: (hi - lo) * 10_000 <= lo * maxDeviationBps. */
export function agree(a: bigint, b: bigint, maxDeviationBps: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return (hi - lo) * 10_000n <= lo * BigInt(maxDeviationBps);
}

/** a / b as a float for display, or null. */
function ratio(a: bigint, b: bigint | null): number | null {
  if (b === null || b <= 0n) return null;
  return Number(a) / Number(b);
}

export function planGuardian(view: GuardianView, thresholds: GuardianThresholds): GuardianPlan {
  const none = { page: false, scaleFault: false, staleRound: false, poolDisagrees: false, veto: false, late: false, ratios: { pool: null, lastFinalized: null } };
  if (view.status !== 'Pending') return { ...none, reason: 'not-pending' };
  const c = view.candidate;
  if (c === null || c.price <= 0n) return { ...none, reason: 'no-candidate' };

  const late = view.now >= c.finalizableAt;
  const ratios = { pool: ratio(c.price, view.poolPrice), lastFinalized: ratio(c.price, view.lastFinalizedPrice) };
  const staleRound = typeof view.roundAge === 'number' && view.roundAge > thresholds.staleRoundAfterS;
  const poolDisagrees =
    view.poolPrice !== null && view.poolPrice > 0n && view.maxDeviationBps !== null && !agree(c.price, view.poolPrice, view.maxDeviationBps);
  const base = { page: true, staleRound, poolDisagrees, late, ratios };

  const refs = [view.poolPrice, view.lastFinalizedPrice].filter((r): r is bigint => r !== null && r > 0n);
  const scaleFault = refs.length > 0 && refs.every((r) => scaleApart(c.price, r, thresholds.scaleFactor));
  if (scaleFault) return { ...base, scaleFault: true, veto: thresholds.autoVeto, reason: 'scale-fault' };
  if (staleRound) return { ...base, scaleFault: false, veto: thresholds.autoVeto && poolDisagrees, reason: 'stale-round' };
  // A round nobody could read is not "in band": the stale-round half of the rule did not run.
  if (view.roundAge === 'unread') return { ...base, scaleFault: false, veto: false, reason: 'round-unread' };
  return { ...base, scaleFault: false, veto: false, reason: refs.length === 0 ? 'no-reference' : 'in-band' };
}
