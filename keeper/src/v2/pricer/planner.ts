/**
 * The pricer's decisions, as pure functions of chain views and a fair value. Nothing here
 * reads a chain, a clock, the pricing service or a database: pricer.ts gathers the views, asks these,
 * and acts. planner.test.ts pins every rule.
 *
 *   priceBand     the PRICE_TICK multiples AutoRoller.reprice accepts for a strategy at a spot
 *   targetPrice   clamp(fair × (1 + edgeBps), minAskBps · spot, maxAskBps · spot), on the tick grid
 *   differsEnough the "> 10 %" rule against the live ask
 *   repriceFloor  the lowest price one reprice may set: MAX_REPRICE_DROP_BPS below the live ask, up to the tick
 *   stepFloor     the lowest price the pricer steps to: PRICER_MAX_STEP_DROP_BPS below the live ask, under the monitor's
 *                 page; when it is above the band's ceiling the ceiling is sent instead, if reprice accepts it
 *   evaluationDue right after each roll, then at most once per PRICER_MIN_INTERVAL_S
 *   planCheck     everything that must hold before a fair value is worth asking for, including the regular session and in-the-money
 *                 refusal of INTERFACE_VERSION 7 included
 *   planReprice   the decision once the fair value is known
 *
 * THE CONTRACT'S RULES, which the send would otherwise discover as a revert (AutoRoller.reprice,
 * OrderBook.replace): the manager admitting `reprice`; strategy active with smartPricing (NotAuthorized); a tracked ask
 * (OrderNotLive(0)); a fresh spot from the SERIES' pinned oracle (`Series.oracle`, not `market(u).oracle`:
 * `spot()` reverts when stale); the spot short of the strike (InTheMoney, INTERFACE_VERSION 7); the band
 * `minAskBps × spot ≤ price × 1e4 ≤ maxAskBps × spot`, inclusive and exact (BadPrice); price > 0 and
 * `price % 100 == 0` (BadPrice); at most MAX_REPRICE_DROP_BPS below the ask it replaces (RepriceDropExceeded);
 * the ask not cancelled, not filled and before its validUntil (OrderNotLive). The replacement keeps the
 * remaining units and the validUntil.
 *
 * ROUNDING. The band's ends are rounded INWARD to the tick (floor up, ceiling down), so every price
 * this returns passes the exact check at the same spot. The raw target fair × (1 + edge) is rounded
 * UP to the tick, as AutoRoller.roll rounds the price it starts from (never below the rate asked).
 *
 * UNITS: prices, fair values and spot are USDG base units (6 dp) per whole share; bps of
 * 10_000; times are unix seconds of the HEAD BLOCK.
 */
import { BPS, MAX_REPRICE_DROP_BPS, PRICER_MAX_STEP_DROP_BPS, PRICE_TICK } from '../cranker/constants.js';
import { ceilDiv, overtaken, roundDownToTick, roundUpToTick } from '../cranker/planner.js';

/** A reprice is not planned when the ask's validUntil is this close: the transaction would land past the cutoff. */
export const CUTOFF_MARGIN_S = 60;

/*//////////////////////////////////////////////////////////////
                              PRICES
//////////////////////////////////////////////////////////////*/

export interface Band {
  /** Smallest accepted price: the first tick at or above minAskBps × spot / 1e4. */
  min: bigint;
  /** Largest accepted price: the last tick at or below maxAskBps × spot / 1e4. */
  max: bigint;
}

/** The accepted prices of AutoRoller.reprice at `spot`, or null when no positive tick fits in the band. */
export function priceBand(spot: bigint, minAskBps: number, maxAskBps: number): Band | null {
  if (spot <= 0n || minAskBps > maxAskBps) return null;
  let min = roundUpToTick(ceilDiv(spot * BigInt(minAskBps), BPS), PRICE_TICK);
  if (min === 0n) min = PRICE_TICK; // the book refuses a zero price
  const max = roundDownToTick((spot * BigInt(maxAskBps)) / BPS, PRICE_TICK);
  return min > max ? null : { min, max };
}

/** Whether `price` passes reprice's own checks at `spot` (the band exactly as the contract computes it, and the tick). */
export function inBand(price: bigint, spot: bigint, minAskBps: number, maxAskBps: number): boolean {
  if (price <= 0n || price % PRICE_TICK !== 0n) return false;
  const scaled = price * BPS;
  return scaled >= spot * BigInt(minAskBps) && scaled <= spot * BigInt(maxAskBps);
}

export type TargetPrice =
  | {
      ok: true;
      /** The price to reprice to. */
      price: bigint;
      /** fair × (1 + edge), rounded up to the tick, before the clamp. */
      raw: bigint;
      band: Band;
      /** Which end of the band moved the raw target, if one did. */
      clamped: 'floor' | 'ceiling' | null;
    }
  | { ok: false; reason: 'band-empty' };

/** Price = clamp(fair × (1 + edgeBps), minAskBps · spot, maxAskBps · spot), on the tick grid. */
export function targetPrice(input: { fair: bigint; edgeBps: number; spot: bigint; minAskBps: number; maxAskBps: number }): TargetPrice {
  const band = priceBand(input.spot, input.minAskBps, input.maxAskBps);
  if (band === null) return { ok: false, reason: 'band-empty' };
  const factor = BPS + BigInt(input.edgeBps);
  const fair = input.fair < 0n ? 0n : input.fair;
  const raw = factor <= 0n ? 0n : roundUpToTick(ceilDiv(fair * factor, BPS), PRICE_TICK);
  if (raw < band.min) return { ok: true, price: band.min, raw, band, clamped: 'floor' };
  if (raw > band.max) return { ok: true, price: band.max, raw, band, clamped: 'ceiling' };
  return { ok: true, price: raw, raw, band, clamped: null };
}

/**
 * The lowest price AutoRoller.reprice accepts in one call against a live ask of `live`: it reverts
 * RepriceDropExceeded when `newPrice x BPS < live x (BPS - MAX_REPRICE_DROP_BPS)` (AutoRoller.sol reprice), so the
 * first price on the tick grid at or above `live x (BPS - MAX_REPRICE_DROP_BPS) / BPS`: exactly the `floor` the revert
 * itself names (roundUpToTick(ceilDiv(live x (BPS - MAX_REPRICE_DROP_BPS), BPS), PRICE_TICK)).
 */
export function repriceFloor(live: bigint): bigint {
  if (live <= 0n) return 0n;
  return roundUpToTick(ceilDiv(live * (BPS - MAX_REPRICE_DROP_BPS), BPS), PRICE_TICK);
}

/**
 * The lowest price the PRICER itself steps an ask down to in one call:
 * PRICER_MAX_STEP_DROP_BPS below the live ask, rounded UP to the tick (so the step is never larger), and never below
 * the contract's repriceFloor. The monitor pages v2_mon_reprice_floorward for a single drop of REPRICE_PAGE_DROP_BPS or
 * more (the leaked-key signature), so the pricer stays strictly under it; that makes it stricter than the contract on
 * purpose, and a large fall takes one or two more steps.
 */
export function stepFloor(live: bigint): bigint {
  if (live <= 0n) return 0n;
  const own = roundUpToTick(ceilDiv(live * (BPS - PRICER_MAX_STEP_DROP_BPS), BPS), PRICE_TICK);
  const contract = repriceFloor(live);
  return own > contract ? own : contract;
}

/** The gas discipline: |target − live| / live > thresholdBps / 1e4, strictly. */
export function differsEnough(target: bigint, live: bigint, thresholdBps: number): boolean {
  if (live <= 0n) return target !== live;
  const diff = target > live ? target - live : live - target;
  return diff * BPS > live * BigInt(thresholdBps);
}

/*//////////////////////////////////////////////////////////////
                             CADENCE
//////////////////////////////////////////////////////////////*/

/** What the pricer remembers of its last completed evaluation of one (writer, underlying). */
export interface EvaluationMemory {
  /** The position's longId evaluated: a different one means the strategy rolled since. */
  longId: bigint;
  /** Head timestamp of the evaluation. */
  checkedAt: number;
}

export type Due = { due: true; why: 'new-position' | 'interval' } | { due: false; nextAt: number };

/**
 * "After each roll and then at most every 30 min": a position the pricer has not evaluated yet (a new
 * roll, or the first sight of one after a boot) is due at once; an evaluated one again once
 * `minIntervalS` has passed on the head clock since that evaluation, whatever it decided.
 */
export function evaluationDue(input: { positionLongId: bigint; memory: EvaluationMemory | null; now: number; minIntervalS: number }): Due {
  const { memory } = input;
  if (memory === null || memory.longId !== input.positionLongId) return { due: true, why: 'new-position' };
  const nextAt = memory.checkedAt + input.minIntervalS;
  return input.now >= nextAt ? { due: true, why: 'interval' } : { due: false, nextAt };
}

/*//////////////////////////////////////////////////////////////
                            DECISIONS
//////////////////////////////////////////////////////////////*/

export interface StrategyView {
  active: boolean;
  smartPricing: boolean;
  minAskBps: number;
  maxAskBps: number;
}

export interface PositionView {
  longId: bigint;
  orderId: bigint;
  expiry: number;
}

export interface AskView {
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

export interface CheckView {
  strategy: StrategyView;
  position: PositionView;
  /** OrderBook.getOrders([position.orderId])[0]; null when not read. */
  order: AskView | null;
  /**
   * SettlementOracle.trySpot of the series' PINNED oracle (Clearinghouse.series(longId).oracle), the one reprice reads
   * and the series settles on: null when not ok, and null when the series was not read, since then the
   * oracle is unknown. Never market(u).oracle, which a setMarketOracle moves away from existing series.
   */
  spot: bigint | null;
  /** Clearinghouse.series(position.longId): the side and strike `reprice` compares the spot with. Null when unread. */
  series: { isPut: boolean; strike: bigint } | null;
  now: number;
  /** ExpiryCalendar.isRegularSession at the pinned head; null when the read failed. */
  sessionOpen: boolean | null;
  memory: EvaluationMemory | null;
}

export type SkipReason =
  | 'inactive'
  | 'not-smart-pricing'
  | 'no-position'
  | 'no-tracked-ask'
  | 'order-not-live'
  | 'near-cutoff'
  | 'not-due'
  | 'market-closed'
  | 'session-unavailable'
  | 'spot-stale'
  | 'in-the-money';

export type CheckDecision = { check: true; why: 'new-position' | 'interval'; spot: bigint; order: AskView } | { check: false; reason: SkipReason; nextAt?: number };

/** Remaining units of an ask; 0 once filled. */
export const remainingUnits = (o: AskView): bigint => (o.units > o.filled ? o.units - o.filled : 0n);

/** Whether the ask can still be replaced now (OrderBook.replace's OrderNotLive rule). */
export const askLive = (o: AskView, now: number): boolean => !o.cancelled && remainingUnits(o) > 0n && now < o.validUntil;

/**
 * Before the fair value: is there a live ask this pricer may move, and is it due? Checked in the
 * contract's order, then the cadence, then spot (the band needs it). Nothing here costs a request.
 *
 * IN THE MONEY (INTERFACE_VERSION 7). `reprice` reverts `InTheMoney` once the spot has
 * reached the strike, and it is right to: the band caps the ask at `maxAskBps` of spot, at most 10 %, so every price
 * it would allow there is below intrinsic value and a reprice would only make the writer's loss cheaper to take. The
 * ask is withdrawn instead, by the permissionless `AutoRoller.cancelStale` the cranker sends (`stepStale`). The
 * pricer therefore stops at this pair: no `/fair` request, no send, and the evaluation clock does not move, so it
 * looks again on the next tick — a spot that falls back below the strike resumes repricing by itself.
 */
export function planCheck(view: CheckView, settings: { minIntervalS: number; repriceOffHours: boolean }): CheckDecision {
  if (!view.strategy.active) return { check: false, reason: 'inactive' };
  if (!view.strategy.smartPricing) return { check: false, reason: 'not-smart-pricing' };
  if (view.position.longId === 0n) return { check: false, reason: 'no-position' };
  if (view.position.orderId === 0n) return { check: false, reason: 'no-tracked-ask' };
  const order = view.order;
  if (order === null || !askLive(order, view.now)) return { check: false, reason: 'order-not-live' };
  if (view.now + CUTOFF_MARGIN_S >= order.validUntil) return { check: false, reason: 'near-cutoff' };
  const due = evaluationDue({ positionLongId: view.position.longId, memory: view.memory, now: view.now, minIntervalS: settings.minIntervalS });
  if (!due.due) return { check: false, reason: 'not-due', nextAt: due.nextAt };
  if (!settings.repriceOffHours && view.sessionOpen === null) return { check: false, reason: 'session-unavailable' };
  if (!settings.repriceOffHours && !view.sessionOpen) return { check: false, reason: 'market-closed' };
  if (view.spot === null || view.spot <= 0n) return { check: false, reason: 'spot-stale' };
  if (view.series !== null && overtaken(view.series.isPut, view.series.strike, view.spot)) return { check: false, reason: 'in-the-money' };
  return { check: true, why: due.why, spot: view.spot, order };
}

export type RepriceDecision =
  | {
      reprice: true;
      price: bigint;
      target: Extract<TargetPrice, { ok: true }>;
      /** The step floor (stepFloor) when it lifted the price above the target (a step down), else null. */
      stepFloor: bigint | null;
      /**
       * Present when the step floor is above the band's ceiling but the contract
       * accepts the ceiling. The price is then `target.band.max`, a step LARGER than the pricer's own; `dropBps` is its
       * size as the monitor measures it (floored bps of the live ask), which pages v2_mon_reprice_floorward at
       * REPRICE_PAGE_DROP_BPS or more.
       */
      ceilingStep?: { stepFloor: bigint; dropBps: bigint };
    }
  | { reprice: false; reason: 'band-empty' }
  | { reprice: false; reason: 'within-threshold'; target: Extract<TargetPrice, { ok: true }> }
  /**
   * The band's ceiling is below the contract's per-call floor (repriceFloor): every price inside the band is a
   * drop reprice refuses (RepriceDropExceeded), so nothing can be sent until the spot recovers or the ask rolls.
   * `floor` is the pricer's step floor, `contractFloor` the contract's.
   */
  | { reprice: false; reason: 'drop-floor-above-band'; target: Extract<TargetPrice, { ok: true }>; floor: bigint; contractFloor: bigint };

/**
 * With the fair value: the target, and whether it is far enough from the live ask to send.
 *
 * STEP DOWN. A target more than MAX_REPRICE_DROP_BPS below the live ask is refused by reprice
 * (RepriceDropExceeded), so it used to be simulated, refused and dropped on every tick, and the ask never moved down.
 * The price sent is now max(target, stepFloor(live)): a step of at most PRICER_MAX_STEP_DROP_BPS (under the monitor's
 * leaked-key page, and inside the contract's cap), then another from the new ask on the next evaluation, until the
 * target is inside one step. "Differs enough" is still judged on the target, so a step is taken whenever the target
 * itself is worth a reprice.
 *
 * STEP FLOOR ABOVE THE BAND. When the spot fell so far that
 * the step floor is above the band's ceiling, no price is both within one pricer step and inside the band. If the
 * contract still accepts the ceiling (band.max >= repriceFloor(live)), the ceiling is sent: the ask must never sit
 * above the band when one reprice can bring it in. That step is larger than the pricer's own and pages the monitor's
 * v2_mon_reprice_floorward when it is REPRICE_PAGE_DROP_BPS or more (`ceilingStep.dropBps`). Only when the ceiling is
 * below the contract's floor is nothing sent ('drop-floor-above-band'); the pricer pages that itself.
 */
export function planReprice(input: {
  fair: bigint;
  spot: bigint;
  livePrice: bigint;
  strategy: Pick<StrategyView, 'minAskBps' | 'maxAskBps'>;
  edgeBps: number;
  thresholdBps: number;
}): RepriceDecision {
  const target = targetPrice({ fair: input.fair, edgeBps: input.edgeBps, spot: input.spot, minAskBps: input.strategy.minAskBps, maxAskBps: input.strategy.maxAskBps });
  if (!target.ok) return { reprice: false, reason: 'band-empty' };
  if (!differsEnough(target.price, input.livePrice, input.thresholdBps)) return { reprice: false, reason: 'within-threshold', target };
  const floor = stepFloor(input.livePrice);
  if (target.price >= floor) return { reprice: true, price: target.price, target, stepFloor: null };
  if (floor <= target.band.max) return { reprice: true, price: floor, target, stepFloor: floor };
  const contractFloor = repriceFloor(input.livePrice);
  if (target.band.max < contractFloor) return { reprice: false, reason: 'drop-floor-above-band', target, floor, contractFloor };
  const dropBps = ((input.livePrice - target.band.max) * BPS) / input.livePrice;
  return { reprice: true, price: target.band.max, target, stepFloor: null, ceilingStep: { stepFloor: floor, dropBps } };
}
