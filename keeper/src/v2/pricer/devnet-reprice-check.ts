/**
 * The pure part of devnet-reprice.ts's --pricing-url (REAL) run: which outcomes one pricer tick may report
 * for the seeded pair, what a 'repriced' or 'drop-floor-above-band' tick must have left on chain and in /state, and
 * which alerts the run may raise. devnet-reprice.ts brings a devnet up at module load, so a test cannot import it;
 * this file it can (devnet-reprice-check.test.ts).
 *
 * WHY. A change changed what the pricer sends when the target is more than one step below the live ask: planReprice
 * sends max(target, stepFloor(live)); the band's ceiling when the step floor is above it (the band-ceiling step, logged
 * 'pricer band-ceiling-step'); and nothing when the ceiling is below AutoRoller.reprice's own per-call floor (outcome
 * 'drop-floor-above-band', paged as v2_pricer_reprice_failed at warn). The harness compared the Repriced price with
 * the fair-value target only and did not know 'drop-floor-above-band', so a correct step down failed the run.
 */
import type { RepriceDecision } from './planner.js';

/**
 * Every outcome one REAL tick may report for the pair; anything else fails the run. 'repriced' covers the step floor
 * and the band-ceiling step too: pricer.ts reports all three sends as 'repriced' and tells them apart by the pair's
 * stepFloor and ceilingStepDropBps. A change added 'drop-floor-above-band'.
 */
export const REAL_TICK_OUTCOMES: readonly string[] = [
  'repriced',
  'not-due',
  'within-threshold',
  'in-the-money',
  'fair-unavailable',
  'fair-stale',
  'fair-spot-mismatch',
  'asOf-unknown',
  'drop-floor-above-band',
];

/** The /state pair fields read here (pricer.ts PairReport). /state writes bigints as decimal strings (health.ts). */
export interface PairState {
  target?: string;
  stepFloor?: string;
  contractFloor?: string;
  ceilingStepDropBps?: string;
}

export interface Verdict {
  ok: boolean;
  what: string;
}

/** A /state field against the value it must carry; null or undefined means the field must be absent. */
const reports = (field: string | undefined, want: bigint | null | undefined): boolean => (want === null || want === undefined ? field === undefined : field === String(want));

/**
 * A 'repriced' tick. `plan` is planReprice on the fair value the service answered, the spot, the strategy and the ask
 * the tick replaced; `sent` is the price of the Repriced event the tick emitted. It must be plan.price: the target when
 * it is within one pricer step of the live ask, else the step floor, else the band's ceiling. /state must
 * name the same send: `target` is the price sent, `stepFloor` is set for a step or a band-ceiling step, and
 * `ceilingStepDropBps` for a band-ceiling step only.
 */
export function judgeRepriced(plan: RepriceDecision, sent: bigint | undefined, pair: PairState): Verdict {
  if (!plan.reprice) return { ok: false, what: `a Repriced at ${sent} went out, but planReprice sends nothing for this fair value (${plan.reason})` };
  const kind =
    plan.ceilingStep !== undefined
      ? `the band's ceiling (a ${plan.ceilingStep.dropBps} bps band-ceiling step: the step floor ${plan.ceilingStep.stepFloor} is above the band)`
      : plan.stepFloor !== null
        ? `the step floor (the target ${plan.target.price} is more than one pricer step below the live ask)`
        : 'the target';
  const ok =
    sent === plan.price &&
    reports(pair.target, plan.price) &&
    reports(pair.stepFloor, plan.ceilingStep?.stepFloor ?? plan.stepFloor) &&
    reports(pair.ceilingStepDropBps, plan.ceilingStep?.dropBps);
  return { ok, what: `repriced to ${kind}: Repriced ${sent} == ${plan.price}; /state target ${pair.target}, stepFloor ${pair.stepFloor ?? '-'}, ceilingStepDropBps ${pair.ceilingStepDropBps ?? '-'}` };
}

/**
 * A 'drop-floor-above-band' tick: the band's ceiling is below AutoRoller.reprice's per-call floor, so every
 * price in the band is refused and nothing is sent. planReprice must agree, no Repriced may exist, and /state must
 * carry the pricer's step floor and the contract's floor.
 */
export function judgeDropFloorAboveBand(plan: RepriceDecision, repriced: number, pair: PairState): Verdict {
  if (plan.reprice || plan.reason !== 'drop-floor-above-band') {
    return { ok: false, what: `the pricer reported drop-floor-above-band, but planReprice ${plan.reprice ? `sends ${plan.price}` : `says ${plan.reason}`} for this fair value` };
  }
  const ok = repriced === 0 && reports(pair.stepFloor, plan.floor) && reports(pair.contractFloor, plan.contractFloor);
  return { ok, what: `drop-floor-above-band: the band's ceiling ${plan.target.band.max} is below the contract floor ${plan.contractFloor}; ${repriced} Repriced; /state stepFloor ${pair.stepFloor ?? '-'}, contractFloor ${pair.contractFloor ?? '-'}` };
}

/**
 * The alerts that fail a REAL run: every v2_error and v2_pricer_*, except the v2_pricer_reprice_failed at warn that
 * pricer.ts raises for a 'drop-floor-above-band' tick by design.
 */
export function unexpectedAlerts<A extends { kind: string; severity: string }>(outcome: string | undefined, alerts: readonly A[]): A[] {
  return alerts.filter(
    (a) => (a.kind === 'v2_error' || a.kind.startsWith('v2_pricer_')) && !(outcome === 'drop-floor-above-band' && a.kind === 'v2_pricer_reprice_failed' && a.severity === 'warn'),
  );
}
