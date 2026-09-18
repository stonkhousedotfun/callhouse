/**
 * The MakerVault's daily outflow cap (INTERFACE_VERSION 7, c21), as the bot models it. Pure: no chain, no clock.
 *
 * WHAT THE VAULT DOES. `_bookOutflow` measures CASH = `usdg.balanceOf(vault) + orderBook.owed(vault)` immediately
 * before and after every booked call and charges (or credits) the difference to a leaky bucket that refills linearly
 * at `limits.maxDailyOutflow` per `OUTFLOW_WINDOW`. Placing or replacing a **Bid**, and `take`, are booked AND
 * enforced (`OutflowCapExceeded(available, outflow)`); a `cancel` naming a Bid is booked as a credit and never
 * enforced, so unwinding can never be blocked; the ask side, `close`, `depositToClearinghouse`,
 * `withdrawFromClearinghouse`, `claimOwed`, `sync` and `refreshApprovals` are not booked at all. Nothing that happens
 * BETWEEN vault calls is booked: fills of resting orders, keeper prunes, redemptions, plain transfers in.
 * `outflow()` reports `used` (rounded up) and `available = cap − used`.
 *
 * WHY THE BOT MODELS IT.
 *   1. SIZING. A tick cancels and replaces its live bids before it places new ones, and every cancel credits its
 *      escrow back, so the room for new bids is `cap − max(0, used − released)`, not `available` ({budgetFor}).
 *      Quoting inside that budget turns the cap into smaller quotes instead of a reverted `place` (risk.planSizes,
 *      cap `'outflow'`).
 *   2. FOREIGN SPEND. The bucket is shared by every quoter and by the admin. The bot knows the exact escrow of every
 *      booked call it makes, so it can project the level forward ({project}, {decay}) and compare with what the next
 *      tick reads. A `used` above that projection is USDG this bot did not move — a second key on QUOTER_ROLE, or an
 *      admin (exempt from enforcement, still booked). That pages `v2_mm_outflow_foreign` (error, force).
 *
 * ROUNDING. The vault keeps the level multiplied by OUTFLOW_WINDOW and reports `used` rounded UP, so a model kept in
 * plain USDG base units is within one base unit per booked call. {foreignSpend} therefore takes a tolerance, and the
 * decay uses the SMALLER of the two caps observed, since a cap lowered in between refilled less than the new one
 * suggests.
 *
 * UNITS: USDG base units (6 dp); seconds.
 */
import { OUTFLOW_WINDOW_S, UNITS_PER_SHARE } from './constants.js';

/** Rounding slack for {foreignSpend}: one base unit per booked call of a full tick, and then some. 0.001 USDG. */
export const FOREIGN_SPEND_TOLERANCE = 1_000n;

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** USDG a Bid of `units` at `price` escrows: `OptionMath.premium`, the cash the vault pays out at placement. */
export const bidEscrowOf = (price: bigint, units: bigint): bigint => (price * units) / UNITS_PER_SHARE;

/**
 * What a tick may still escrow in NEW bids: the cap less the level its own credits cannot cancel out.
 * `released` is the escrow this tick's cancels and replaces hand back before its places run — the same live-bid
 * escrow `planTick` already adds to the USDG budget, because every live bid is either kept (its escrow counts on
 * both sides and nets out), replaced (the net is booked) or cancelled (a pure credit).
 */
export function budgetFor(input: { cap: bigint; used: bigint; released: bigint }): bigint {
  const level = max(input.used - max(input.released, 0n), 0n);
  return max(input.cap - level, 0n);
}

/** One booked vault call, as the bot planned it: positive = USDG out (charged), negative = escrow back (credited). */
export interface BookedCall {
  what: string;
  delta: bigint;
}

/**
 * The level after `calls` are booked in order, starting from `used`. A credit clamps at 0 exactly as the vault's
 * bucket does, so a tick that cancels far more than it places cannot bank the difference.
 */
export function project(used: bigint, calls: readonly BookedCall[]): bigint {
  let level = max(used, 0n);
  for (const c of calls) level = c.delta >= 0n ? level + c.delta : max(level - -c.delta, 0n);
  return level;
}

/** The level `elapsed` seconds later, refilling at `cap` per window: the vault's `_refilled`, floored at 0. */
export function decay(level: bigint, cap: bigint, elapsedS: number): bigint {
  if (elapsedS <= 0 || cap <= 0n) return max(level, 0n);
  return max(max(level, 0n) - (cap * BigInt(elapsedS)) / BigInt(OUTFLOW_WINDOW_S), 0n);
}

export interface Projection {
  /** The projected level at `at`. */
  used: bigint;
  /**
   * The head timestamp the level is dated from. It must be at or AFTER the last booked call of the tick that made
   * it, never the timestamp the tick read `outflow()` at: the vault refills from `_outflowAt`, the moment of its
   * last booked call, so dating the projection earlier assumes a refill the chain has not made and reads an honest
   * level as a foreign spend. The caller passes the head AFTER its sends, which is at or past every one of them.
   */
  at: number;
  /** `limits.maxDailyOutflow` then: the decay uses the smaller of this and the cap now. */
  cap: bigint;
}

/**
 * USDG spent through the vault that this bot did not spend, or null when the reading is within the projection.
 * `null` for a first look (no projection) and for a reading taken before the projection.
 */
export function foreignSpend(input: {
  observedUsed: bigint;
  now: number;
  cap: bigint;
  previous: Projection | null;
  tolerance?: bigint;
}): bigint | null {
  const { previous } = input;
  if (previous === null || input.now < previous.at) return null;
  const expected = decay(previous.used, min(previous.cap, input.cap), input.now - previous.at);
  const over = input.observedUsed - expected;
  return over > (input.tolerance ?? FOREIGN_SPEND_TOLERANCE) ? over : null;
}
