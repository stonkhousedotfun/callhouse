/**
 * The cranker's decisions, as pure functions of chain views. Nothing here reads a chain, a clock or
 * a database: steps.ts gathers the views (one pinned multicall per question), asks these, and acts.
 * Every rule a keeper can get quietly wrong lives here, where planner.test.ts pins it.
 *
 *   ladders     ladderStrikes, planLadder (the registry ladder, completed, re-centred, never deleted),
 *               upcomingLadderExpiries, ladderSlots (which expiries and sides carry one)
 *   creation    pinGasOf, planPinGroup, chunkCreates (the first series of an expiry pays the settlement pin)
 *   expiries    planExpiry: snapshot → finalize → settle, prune before redeem, the alerts, the wake-up
 *   redemption  selectRedeemable, redeemGasOf, chunkByGas, splitChunk
 *   orders      prunableOrders, isDeadOrder
 *   rolls       planRoll (the open grace of INTERFACE_VERSION 7 included)
 *   stale asks  overtaken, planStale (AutoRoller.cancelStale's own conditions, c16)
 *   housekeeping sweepDue
 *   time        scheduleWake, selectExpiries
 *
 * UNITS (ADR-04): prices and strikes are USDG base units (6 dp) per whole share, bps of 10_000,
 * balances and supplies in 0.01-share units, times in unix seconds of the HEAD BLOCK (never the
 * wall clock), gas in gas units.
 */
import { TENORS, type LadderParams, type MarketParams, type Tenor } from '../registry.js';
import {
  BPS,
  FINALIZE_DELAY,
  GAS,
  MAX_ORACLE_SOURCES,
  MIN_SERIES_LEAD,
  LADDER_LEAD_MARGIN_S,
  MIN_WAKE_DELAY_MS,
  SNAPSHOT_GRACE,
  WAKE_MARGIN_MS,
  type OrderKindName,
  type SettlementStatusName,
} from './constants.js';

/*//////////////////////////////////////////////////////////////
                              MATH
//////////////////////////////////////////////////////////////*/

/** ⌈a / b⌉ for a ≥ 0, b > 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function roundUpToTick(value: bigint, tick: bigint): bigint {
  return ceilDiv(value, tick) * tick;
}

export function roundDownToTick(value: bigint, tick: bigint): bigint {
  return (value / tick) * tick;
}

/** Clearinghouse.createSeries' fat-finger band when spot is known: spot / 2 ≤ strike ≤ spot × 2 (integer division, as on chain). */
export function inStrikeBand(strike: bigint, spot: bigint): boolean {
  return strike > 0n && strike >= spot / 2n && strike <= spot * 2n;
}

export function isOtm(strike: bigint, spot: bigint, isPut: boolean): boolean {
  return isPut ? strike < spot : strike > spot;
}

/*//////////////////////////////////////////////////////////////
                             LADDERS
//////////////////////////////////////////////////////////////*/

/**
 * The registry ladder around `spot` (K2-03 step 1, registry.ts LadderParams):
 *   calls  rung 0 = roundUp(spot × (1 + firstOtmBps), strikeTick), each further rung × (1 + stepBps), rounded up;
 *   puts   mirrored below spot: rung 0 = roundDown(spot × (1 − firstOtmBps), strikeTick), × (1 − stepBps), rounded down.
 * The multiplication runs on the exact (unrounded) value, so rounding never compounds. When a coarse
 * tick maps two rungs onto one strike, the later rung moves one tick further out: a ladder always
 * has `rungs` distinct strikes. A rung outside createSeries' band [spot / 2, spot × 2], or a put at or
 * below zero, ends the ladder (it would revert BadStrike).
 */
export function ladderStrikes(spot: bigint, ladder: Pick<LadderParams, 'rungs' | 'firstOtmBps' | 'stepBps'>, strikeTick: bigint, isPut: boolean): bigint[] {
  if (spot <= 0n || strikeTick <= 0n) return [];
  const strikes: bigint[] = [];
  const first = BigInt(ladder.firstOtmBps);
  const step = BigInt(ladder.stepBps);
  let raw = isPut ? (spot * (BPS - first)) / BPS : ceilDiv(spot * (BPS + first), BPS);
  for (let i = 0; i < ladder.rungs; i += 1) {
    if (i > 0) raw = isPut ? (raw * (BPS - step)) / BPS : ceilDiv(raw * (BPS + step), BPS);
    let strike = isPut ? roundDownToTick(raw, strikeTick) : roundUpToTick(raw, strikeTick);
    const previous = strikes.at(-1);
    if (previous !== undefined) {
      if (!isPut && strike <= previous) strike = previous + strikeTick;
      if (isPut && strike >= previous) strike = previous - strikeTick;
    }
    if (!inStrikeBand(strike, spot)) break;
    strikes.push(strike);
  }
  return strikes;
}

export interface LadderInput {
  spot: bigint;
  ladder: Pick<LadderParams, 'rungs' | 'firstOtmBps' | 'stepBps'>;
  strikeTick: bigint;
  isPut: boolean;
  /** Strikes of every existing series of this (underlying, expiry, type), whoever created them. */
  existing: readonly bigint[];
  /** The spot this ladder was last centred on (the cranker's memory), or null the first time. */
  anchor: bigint | null;
}

export interface LadderPlan {
  /** Strikes to create, ascending. */
  create: bigint[];
  /** The spot to remember for this ladder. */
  anchor: bigint;
  /** initial: first ladder; complete: finishing the anchored ladder; recentre: fewer than two rungs
   *  were OTM, a ladder at today's spot is added; ok: nothing to do. */
  reason: 'initial' | 'complete' | 'recentre' | 'ok';
  /** OTM rungs at `spot` among the existing and anchored strikes. */
  otm: number;
}

/**
 * K2-03 step 1 for one (underlying, expiry, type, tenor). "Ensure the registry ladder exists" and
 * "re-centre when spot has moved so that fewer than two rungs are OTM; add rungs, never delete":
 *   - no anchor: create the ladder at spot (what exists already is not re-created);
 *   - an anchor: the ladder at the anchor is completed (a crash between two creates leaves it
 *     half-made), unless fewer than two of its strikes (existing or planned) are OTM at spot: then
 *     the ladder at today's spot is added and becomes the anchor.
 * Strikes outside createSeries' band at today's spot are never proposed.
 */
export function planLadder(input: LadderInput): LadderPlan {
  const { spot, ladder, strikeTick, isPut, anchor } = input;
  const have = new Set(input.existing.map((s) => s.toString()));
  const missing = (strikes: readonly bigint[]) =>
    [...new Set(strikes.filter((s) => !have.has(s.toString()) && inStrikeBand(s, spot)).map((s) => s.toString()))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const countOtm = (strikes: Iterable<bigint>) => [...strikes].filter((s) => isOtm(s, spot, isPut)).length;

  if (anchor === null) {
    const create = missing(ladderStrikes(spot, ladder, strikeTick, isPut));
    return { create, anchor: spot, reason: create.length > 0 ? 'initial' : 'ok', otm: countOtm(new Set([...input.existing, ...create])) };
  }
  // Anchored rungs today's band refuses can never be created: they do not count as rungs.
  const anchored = ladderStrikes(anchor, ladder, strikeTick, isPut).filter((s) => inStrikeBand(s, spot));
  // Other existing strikes count only inside this ladder's span at today's spot (up to its farthest rung): two far-OTM
  // series anyone can create (createSeries is permissionless inside [spot / 2, spot × 2]) must not stand in for rungs.
  const farthest = ladderStrikes(spot, ladder, strikeTick, isPut).at(-1);
  const inSpan = (s: bigint) => farthest === undefined || (isPut ? s >= farthest : s <= farthest);
  const union = new Map<string, bigint>();
  for (const s of [...input.existing.filter(inSpan), ...anchored]) union.set(s.toString(), s);
  const otm = countOtm(union.values());
  if (otm < 2) {
    const create = missing(ladderStrikes(spot, ladder, strikeTick, isPut));
    return { create, anchor: spot, reason: create.length > 0 ? 'recentre' : 'ok', otm };
  }
  const create = missing(anchored);
  return { create, anchor, reason: create.length > 0 ? 'complete' : 'ok', otm };
}

/** The earliest expiry a ladder may target now: createSeries needs expiry ≥ now + MIN_SERIES_LEAD when it is MINED. */
export function ladderSearchStart(now: number): number {
  return now + MIN_SERIES_LEAD + LADDER_LEAD_MARGIN_S;
}

/** ExpiryCalendar.nextExpiry(afterTs, weekly): the first close strictly after `afterTs`; rejects when none is in its window. */
export type NextExpiryRead = (afterTs: number, weekly: boolean) => Promise<number>;

/**
 * The next `count` expiries of one tenor a ladder targets at `now`: nextExpiry from ladderSearchStart(now), each after
 * the previous one. A rejected read (nothing inside the calendar's search window) ends the list there. The cranker
 * reads the on-chain ExpiryCalendar; the pricing-coverage report (pricing/coverage.ts) the same read or a local mirror.
 */
export async function upcomingLadderExpiries(now: number, weekly: boolean, count: number, nextExpiry: NextExpiryRead): Promise<number[]> {
  const out: number[] = [];
  let after = ladderSearchStart(now);
  while (out.length < count) {
    let next: number;
    try {
      next = await nextExpiry(after, weekly);
    } catch {
      break; // nothing within the calendar's search window
    }
    out.push(next);
    after = next;
  }
  return out;
}

/** One (tenor, expiry, side) a market carries a ladder on. */
export interface LadderSlot {
  tenor: Tenor;
  expiry: number;
  isPut: boolean;
}

/**
 * Which ladders a market carries (K2-03 step 1): for each tenor, the first `expiriesAhead[tenor]` of that tenor's
 * upcoming expiries (0 switches the tenor off), calls always and puts only when the market lists puts. In
 * TENORS order, then expiry order, calls before puts. `expiries[tenor]` is the shared upcoming list
 * (upcomingLadderExpiries at the largest `expiriesAhead` of any market).
 */
export function ladderSlots(params: Pick<MarketParams, 'expiriesAhead'>, puts: boolean, expiries: Readonly<Record<Tenor, readonly number[]>>): LadderSlot[] {
  const slots: LadderSlot[] = [];
  for (const tenor of TENORS) {
    for (const expiry of expiries[tenor].slice(0, params.expiriesAhead[tenor])) {
      for (const isPut of puts ? [false, true] : [false]) slots.push({ tenor, expiry, isPut });
    }
  }
  return slots;
}

/*//////////////////////////////////////////////////////////////
                       SERIES CREATION (PINS)
//////////////////////////////////////////////////////////////*/

/** The key of one (oracle, underlying, expiry): what SettlementOracle.pin pins, lower-case. */
export const pinGroupKey = (oracle: string, underlying: string, expiry: number): string => `${oracle.toLowerCase()}:${underlying.toLowerCase()}:${expiry}`;

/**
 * The gas a createSeries pays on top of GAS.createSeriesEach when it is the first of its (underlying, expiry) and the
 * expiry is not pinned by this Clearinghouse: the oracle's copy plus each source's pin. An unreadable source count
 * budgets the oracle's maximum.
 */
export function pinGasOf(sources: number | null): bigint {
  const n = sources === null ? MAX_ORACLE_SOURCES : Math.max(1, sources);
  return GAS.createSeriesPinBase + GAS.createSeriesPinPerSource * BigInt(n);
}

export interface PinGroupView {
  key: string;
  /** SettlementOracle.pinnedBy(u, E) is this Clearinghouse: `pin` returns at once. null: unreadable. */
  pinnedByUs: boolean | null;
  /** settlementConfig(u, E).sources.length (the pinned list, else the market's); null: unreadable. */
  sources: number | null;
  /** The head timestamp of the last refused pin of this group (cranker/pin.ts), or null. */
  refusedAt: number | null;
}

export type PinGroupAction =
  /** Create in the batch; `pinGas` on the group's first item of each chunk. */
  | { action: 'create'; pinGas: bigint }
  /** Simulate one createSeries with ample gas first: a refused pin skips the group and pages. */
  | { action: 'probe'; pinGas: bigint }
  /** Refused less than PIN_REFUSED_RECHECK_S ago: nothing is simulated or sent. */
  | { action: 'skip'; recheckAt: number };

/**
 * What the ladder step does with the missing series of one (oracle, underlying, expiry). An expiry this Clearinghouse
 * pinned costs nothing more and needs no probe. Any other one (not pinned yet, pinned elsewhere, unreadable) budgets
 * the pin and is probed first, so a refusal is named with ample gas and never spoils a batch. A refused group is
 * skipped until the recheck, then probed again: an admin fix resumes the ladder without anyone touching the cranker.
 */
export function planPinGroup(group: PinGroupView, options: { now: number; recheckS: number }): PinGroupAction {
  if (group.refusedAt !== null && options.now - group.refusedAt < options.recheckS) return { action: 'skip', recheckAt: group.refusedAt + options.recheckS };
  if (group.pinnedByUs === true && group.refusedAt === null) return { action: 'create', pinGas: 0n };
  return { action: 'probe', pinGas: group.pinnedByUs === true ? 0n : pinGasOf(group.sources) };
}

/**
 * createSeries items packed into Multicall3 batches: items of one group kept together (first-appearance order), each
 * item GAS.createSeriesEach, the first item of a group IN EACH CHUNK also its group's `pinGasOf` (a group split over
 * two chunks budgets its pin twice, which costs nothing: unused gas is not charged, and the second chunk still fits
 * when the first was not mined). Chunk gas starts at `baseGas`, stays within `capGas` and `maxItems`; an item that
 * alone exceeds the cap gets a chunk at the cap. Pure.
 */
export function chunkCreates<T extends { group: string }>(items: readonly T[], options: { pinGasOf: (group: string) => bigint; eachGas: bigint; baseGas: bigint; capGas: bigint; maxItems: number }): GasChunk<T>[] {
  const order = new Map<string, number>();
  for (const item of items) if (!order.has(item.group)) order.set(item.group, order.size);
  const sorted = items.map((item, i) => ({ item, i })).sort((a, b) => order.get(a.item.group)! - order.get(b.item.group)! || a.i - b.i).map((x) => x.item);
  const chunks: GasChunk<T>[] = [];
  let current: GasChunk<T> = { items: [], gas: options.baseGas };
  let groups = new Set<string>();
  const cost = (item: T) => options.eachGas + (groups.has(item.group) ? 0n : options.pinGasOf(item.group));
  for (const item of sorted) {
    if (current.items.length > 0 && (current.gas + cost(item) > options.capGas || current.items.length >= options.maxItems)) {
      chunks.push(current);
      current = { items: [], gas: options.baseGas };
      groups = new Set();
    }
    current.gas += cost(item);
    current.items.push(item);
    groups.add(item.group);
  }
  if (current.items.length > 0) chunks.push(current);
  return chunks.map((c) => ({ items: c.items, gas: c.gas > options.capGas ? options.capGas : c.gas }));
}

/*//////////////////////////////////////////////////////////////
                            EXPIRIES
//////////////////////////////////////////////////////////////*/

export interface SourceView {
  address: string;
  /** windowPrice(underlying, expiry − 1800, expiry) answers ok with a price in (0, 2^128]. */
  windowOk: boolean;
  /** Once captured: whether the oracle recorded this source ok. null before capture. */
  recordedOk: boolean | null;
}

export interface SeriesView {
  longId: bigint;
  settled: boolean;
  longSupply: bigint;
  shortSupply: bigint;
  /** Orders of the series that prune would cancel now. */
  prunableOrders: number;
}

export interface ExpiryView {
  underlying: string;
  expiry: number;
  /** Head block timestamp. */
  now: number;
  openInterest: bigint;
  status: SettlementStatusName;
  captured: boolean;
  candidate: { price: bigint; sourceIndex: number; disagreed: boolean; finalizableAt: number } | null;
  /** false when the oracle does not expose its sources (not the concrete SettlementOracle): finalize is then sent blind. */
  sourcesKnown: boolean;
  /**
   * The sources the oracle settles this expiry on, in priority order: once captured the recorded ones, before that
   * settlementConfig(u, E)'s (the configuration pinned at the first series, INTERFACE_VERSION 6), never the market's
   * current list, which the admin may have changed since the pin.
   */
  sources: readonly SourceView[];
  /** settlementConfig(u, E).pinned; null when the oracle does not answer it (then, uncaptured, the sources are unknown). */
  pinned: boolean | null;
  series: readonly SeriesView[];
  /** The cranker called snapshot inside the window (it recorded, or there was nothing to record). */
  snapshotDone: boolean;
}

export type CrankerAlertKind = 'v2_sources_disagree' | 'v2_settlement_held' | 'v2_snapshot_missed' | 'v2_settle_stuck' | 'v2_redeem_backlog';

export interface PlannedAlert {
  kind: CrankerAlertKind;
  dedupeKey: string;
  message: string;
  data: Record<string, unknown>;
  /** Page once per dedupeKey ever (an event), not once per cooldown (a condition). */
  once: boolean;
}

export type ExpiryPhase =
  | 'open' // before expiry
  | 'snapshot-window' // expired, finalize not open yet
  | 'awaiting-snapshot' // finalize open, the snapshot comes first
  | 'no-source' // no source prices the window yet
  | 'pending' // an uncorroborated candidate waits out its delay
  | 'held' // vetoed
  | 'finalizing'
  | 'settling'
  | 'redeeming'
  | 'empty' // expired without open interest: only orders to prune
  | 'done';

export interface ExpiryPlan {
  phase: ExpiryPhase;
  snapshot: boolean;
  finalize: boolean;
  /** Long ids to settle: unsettled with long supply. */
  settle: bigint[];
  /** Long ids whose orders to prune (before any redeem of that series). */
  prune: bigint[];
  /** Long ids settled with supply left. */
  redeem: bigint[];
  alerts: PlannedAlert[];
  /** A head timestamp at which this expiry has time-critical work; null when polling suffices. */
  wakeAt: number | null;
  /** Nothing left for the cranker (settlement-wise; the redeem step decides whether holders remain). */
  done: boolean;
}

export interface ExpiryThresholds {
  /** Seconds after finalize opens with no source ok before v2_settle_stuck. */
  noSourceAlertS: number;
  /** Seconds after finalizableAt a Pending candidate may stay unfinalized before v2_settle_stuck. */
  pendingStuckS: number;
}

/**
 * K2-03 steps 2-4 for one (underlying, expiry) of one oracle.
 *
 * ORDER (C2-04): snapshot inside [expiry, expiry + SNAPSHOT_GRACE] BEFORE the first finalize, which
 * opens at expiry + FINALIZE_DELAY: the first finalize captures every source, and a pool snapshot
 * taken after it only upgrades the capture (a spurious uncorroborated candidate in between). So
 * finalize waits for the snapshot attempt, or for the window to close.
 * FINALIZE is sent only when it would change something, judged from views: nothing captured and some
 * source prices the window; a captured source that was not ok now is (an upgrade can corroborate);
 * or a Pending candidate at/after finalizableAt. `finalize` returns (false, 0) for "not yet", so its
 * return value cannot say whether a call advanced the state.
 * SETTLE every series with long supply once Finalized. PRUNE every open order of an expired series,
 * whatever the settlement status: resale asks hand their escrowed longs back, and must before those
 * longs can be redeemed (architecture §3.6). REDEEM settled series with supply left.
 */
export function planExpiry(view: ExpiryView, thresholds: ExpiryThresholds): ExpiryPlan {
  const { underlying, expiry, now, openInterest, status } = view;
  const key = `${underlying}:${expiry}`;
  const plan: ExpiryPlan = { phase: 'open', snapshot: false, finalize: false, settle: [], prune: [], redeem: [], alerts: [], wakeAt: null, done: false };

  if (now < expiry) {
    plan.wakeAt = openInterest > 0n || view.series.some((s) => s.prunableOrders > 0) ? expiry : null;
    return plan;
  }

  plan.prune = view.series.filter((s) => s.prunableOrders > 0).map((s) => s.longId);

  if (status === 'Finalized') {
    plan.settle = view.series.filter((s) => !s.settled && s.longSupply > 0n).map((s) => s.longId);
    plan.redeem = view.series.filter((s) => s.settled && (s.longSupply > 0n || s.shortSupply > 0n)).map((s) => s.longId);
    plan.phase = plan.settle.length > 0 ? 'settling' : plan.redeem.length > 0 ? 'redeeming' : plan.prune.length > 0 ? 'redeeming' : 'done';
    plan.done = plan.settle.length === 0 && plan.redeem.length === 0 && plan.prune.length === 0;
    return plan;
  }

  const hasSupply = openInterest > 0n || view.series.some((s) => s.longSupply > 0n || s.shortSupply > 0n);
  if (!hasSupply) {
    plan.phase = plan.prune.length > 0 ? 'empty' : 'done';
    plan.done = plan.prune.length === 0;
    return plan;
  }

  const windowEnd = expiry + SNAPSHOT_GRACE;
  const finalizeOpensAt = expiry + FINALIZE_DELAY;
  const inWindow = now <= windowEnd;
  plan.snapshot = inWindow && !view.snapshotDone;
  if (!inWindow && !view.snapshotDone && view.sources.some((s) => !s.windowOk)) {
    plan.alerts.push({
      kind: 'v2_snapshot_missed',
      dedupeKey: key,
      once: true,
      message: `no snapshot of ${underlying} expiry ${expiry} inside [expiry, expiry + ${SNAPSHOT_GRACE}]: a source that needed it cannot vote`,
      data: { underlying, expiry, windowEnd, sources: view.sources.filter((s) => !s.windowOk).map((s) => s.address) },
    });
  }

  if (now < finalizeOpensAt) {
    plan.phase = 'snapshot-window';
    plan.wakeAt = finalizeOpensAt;
    return plan;
  }
  if (plan.snapshot) {
    // The snapshot is sent this tick; finalize is judged again right after it.
    plan.phase = 'awaiting-snapshot';
    return plan;
  }

  const upgrade = view.captured && view.sources.some((s) => s.recordedOk === false && s.windowOk);
  // finalize can capture (or, captured, announce a candidate from the recorded prices): anything else returns (false, 0).
  const canCapture = view.captured || !view.sourcesKnown || view.sources.some((s) => s.windowOk);
  const noSource = () => {
    plan.phase = 'no-source';
    if (now - finalizeOpensAt >= thresholds.noSourceAlertS) {
      plan.alerts.push({
        kind: 'v2_settle_stuck',
        dedupeKey: `${key}:no-source`,
        once: false,
        message: `no price source is ok for ${underlying} expiry ${expiry}, ${now - expiry} s after expiry`,
        data: { underlying, expiry, sources: view.sources.map((s) => s.address) },
      });
    }
  };
  switch (status) {
    case 'None': {
      if (canCapture) {
        plan.finalize = true;
        plan.phase = 'finalizing';
      } else {
        noSource();
      }
      return plan;
    }
    case 'Pending': {
      const c = view.candidate;
      // No candidate while Pending: the unveto of a veto made before anything was captured.
      if (c === null && !canCapture) {
        noSource();
        return plan;
      }
      if (c?.disagreed) {
        plan.alerts.push({
          kind: 'v2_sources_disagree',
          dedupeKey: `${key}:${c.finalizableAt}`,
          once: true,
          message: `sources disagree on ${underlying} expiry ${expiry}: candidate ${c.price} from source ${c.sourceIndex} finalizes at ${c.finalizableAt} unless vetoed`,
          data: { underlying, expiry, price: c.price, sourceIndex: c.sourceIndex, finalizableAt: c.finalizableAt },
        });
      }
      if (upgrade || c === null || now >= c.finalizableAt) {
        plan.finalize = true;
        plan.phase = 'finalizing';
        if (c !== null && now - c.finalizableAt >= thresholds.pendingStuckS) {
          plan.alerts.push({
            kind: 'v2_settle_stuck',
            dedupeKey: `${key}:pending`,
            once: false,
            message: `${underlying} expiry ${expiry}: the candidate was finalizable at ${c.finalizableAt} and is still Pending`,
            data: { underlying, expiry, finalizableAt: c.finalizableAt },
          });
        }
      } else {
        plan.phase = 'pending';
        plan.wakeAt = c.finalizableAt;
      }
      return plan;
    }
    case 'Held': {
      plan.phase = 'held';
      // A veto blocks only the uncorroborated path: an upgrade that corroborates still finalizes, and a first
      // capture (a veto before expiry + 120) records the window prices, which finalizes a corroborated price and
      // bounds adminResolve even if a source cannot replay its window by the time of the unveto.
      plan.finalize = upgrade || (!view.captured && view.sources.some((s) => s.windowOk));
      plan.alerts.push({
        kind: 'v2_settlement_held',
        dedupeKey: key,
        once: false,
        message: `${underlying} expiry ${expiry} is held (vetoed): nothing settles until unveto or adminResolve`,
        data: { underlying, expiry, candidate: view.candidate },
      });
      return plan;
    }
  }
  return plan;
}

/*//////////////////////////////////////////////////////////////
                           REDEMPTION
//////////////////////////////////////////////////////////////*/

export interface HolderView {
  holder: string;
  /** 0.01-share units of this token id. */
  balance: bigint;
  thirdPartyAllowed: boolean;
  /** payoutPrefs.inKind: an ITM call long that skips the USDG conversion. */
  inKind: boolean;
}

export interface RedeemSelection {
  redeem: HolderView[];
  empty: number;
  optedOut: number;
  zeroPayout: number;
}

/**
 * Which holders of one token id a keeper may and should redeem (K2-03 step 4): a balance, third-party
 * redemption allowed (redeemBatch would skip them anyway), and a payout above zero unless burning is
 * cheap. Ordered by address so chunks are stable across ticks.
 */
export function selectRedeemable(holders: readonly HolderView[], options: { perUnitPayout: bigint; burnZero: boolean }): RedeemSelection {
  const out: RedeemSelection = { redeem: [], empty: 0, optedOut: 0, zeroPayout: 0 };
  const seen = new Set<string>();
  for (const h of holders) {
    const k = h.holder.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (h.balance === 0n) out.empty += 1;
    else if (!h.thirdPartyAllowed) out.optedOut += 1;
    else if (options.perUnitPayout === 0n && !options.burnZero) out.zeroPayout += 1;
    else out.redeem.push(h);
  }
  out.redeem.sort((a, b) => (a.holder.toLowerCase() < b.holder.toLowerCase() ? -1 : 1));
  return out;
}

/** The gas one holder's redemption may take inside redeemBatch: a converted ITM call long budgets a swap. */
export function redeemGasOf(holder: Pick<HolderView, 'inKind'>, token: { isLong: boolean; isPut: boolean; perUnitPayout: bigint; adapterSet: boolean }): bigint {
  const converts = token.isLong && !token.isPut && token.perUnitPayout > 0n && token.adapterSet && !holder.inKind;
  return converts ? GAS.redeemConvertEach : GAS.redeemInKindEach;
}

export interface GasChunk<T> {
  items: T[];
  /** The fixed gas limit to send the chunk with. */
  gas: bigint;
}

/**
 * Items in order, packed into chunks whose summed budget (base + Σ gasOf) fits `capGas` and whose
 * size is at most `maxItems`. An item whose own budget exceeds the cap gets a chunk of its own at the
 * cap. Pure.
 */
export function chunkByGas<T>(items: readonly T[], options: { gasOf: (item: T) => bigint; baseGas: bigint; capGas: bigint; maxItems?: number }): GasChunk<T>[] {
  const { gasOf, baseGas, capGas } = options;
  const maxItems = options.maxItems ?? Number.MAX_SAFE_INTEGER;
  const chunks: GasChunk<T>[] = [];
  let current: GasChunk<T> = { items: [], gas: baseGas };
  for (const item of items) {
    const g = gasOf(item);
    if (current.items.length > 0 && (current.gas + g > capGas || current.items.length >= maxItems)) {
      chunks.push(current);
      current = { items: [], gas: baseGas };
    }
    current.items.push(item);
    current.gas += g;
  }
  if (current.items.length > 0) chunks.push(current);
  return chunks.map((c) => ({ items: c.items, gas: c.gas > capGas ? capGas : c.gas }));
}

/**
 * A chunk whose simulation under its fixed limit did less than all of it (an inner out-of-gas that
 * try/catch swallowed): two halves, each with the WHOLE parent's gas (so every item's budget
 * doubles), capped. A single item gets the cap. Returns [] for an empty chunk.
 */
export function splitChunk<T>(chunk: GasChunk<T>, capGas: bigint): GasChunk<T>[] {
  const n = chunk.items.length;
  if (n === 0) return [];
  if (n === 1) return [{ items: chunk.items, gas: capGas }];
  const gas = chunk.gas > capGas ? capGas : chunk.gas;
  const mid = Math.ceil(n / 2);
  return [
    { items: chunk.items.slice(0, mid), gas },
    { items: chunk.items.slice(mid), gas },
  ];
}

/*//////////////////////////////////////////////////////////////
                             ORDERS
//////////////////////////////////////////////////////////////*/

export interface OrderView {
  id: bigint;
  maker: string;
  kind: OrderKindName;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Nothing prune or anyone can ever do with it again: unknown id, cancelled, or fully filled. */
export function isDeadOrder(order: OrderView): boolean {
  return order.maker.toLowerCase() === ZERO_ADDRESS || order.cancelled || order.filled >= order.units;
}

const PRUNE_PRIORITY: Record<OrderKindName, number> = { AskResale: 0, Bid: 1, AskWrite: 2 };

/**
 * OrderBook.prune's own rule (not cancelled, units left, now ≥ validUntil), resale asks first (they
 * hold longs that are waiting to be redeemed), then bids (escrowed USDG), then write-on-fill asks;
 * by id within a kind.
 */
export function prunableOrders(orders: readonly OrderView[], now: number): OrderView[] {
  return orders
    .filter((o) => !isDeadOrder(o) && now >= o.validUntil)
    .sort((a, b) => PRUNE_PRIORITY[a.kind] - PRUNE_PRIORITY[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/*//////////////////////////////////////////////////////////////
                              ROLLS
//////////////////////////////////////////////////////////////*/

export interface RollView {
  active: boolean;
  /** AutoRoller.position(writer, underlying): 0 when there is none. */
  positionLongId: bigint;
  positionExpiry: number;
  now: number;
  /** ExpiryCalendar.isRegularSession(now). */
  sessionOpen: boolean;
  /** SettlementOracle.trySpot(underlying) ok. */
  spotFresh: boolean;
  /** ExpiryCalendar.isRegularSession(now − ROLL_OPEN_GRACE_S) (INTERFACE_VERSION 7). */
  sessionOpenAtGrace: boolean;
  /** The ok spot's `updatedAt`; 0 when there is no fresh spot. */
  spotUpdatedAt: number;
  /** ExpiryCalendar.isRegularSession(spotUpdatedAt): was the reading itself taken in a regular session? */
  sessionAtSpotObservation: boolean;
}

export type RollDecision =
  | { roll: true; reason: 'close-out' | 'roll' }
  | { roll: false; reason: 'rolled-this-period' | 'inactive' | 'session-closed' | 'spot-stale' | 'spot-before-open' };

/** The UTC date of a unix second. Inside a regular session the New York date equals it, which is what the roller uses. */
const utcDay = (t: number): number => Math.floor(t / 86_400);

/**
 * K2-03 step 5 (AutoRoller.roll, C2-09): a position of this period blocks until its expiry; an
 * expired position is closed out whenever it can be (roll returns false until the series settles,
 * which the simulation reports); a new position needs an active strategy, the regular session and a
 * fresh spot. The simulation decides the rest (no free collateral, calendar edge) and a reverting
 * writer (a revoked approval) is skipped by the step.
 *
 * OPEN GRACE (INTERFACE_VERSION 7, v7 design §4.5.3), mirrored from `AutoRoller._plan` so the cranker does not pay
 * gas for a roll that returns false: inside the first `ROLL_OPEN_GRACE` of a session the roll waits unless the ok
 * reading it holds was itself observed in a regular session on the same date. A feed that has not printed since
 * yesterday's close is still "fresh" under a spotMaxAge of a day, and would otherwise write a strike and an ask
 * around a price the open has already gapped away from.
 */
export function planRoll(view: RollView): RollDecision {
  if (view.positionLongId !== 0n) {
    if (view.now < view.positionExpiry) return { roll: false, reason: 'rolled-this-period' };
    return { roll: true, reason: 'close-out' };
  }
  if (!view.active) return { roll: false, reason: 'inactive' };
  if (!view.sessionOpen) return { roll: false, reason: 'session-closed' };
  if (!view.spotFresh) return { roll: false, reason: 'spot-stale' };
  if (!view.sessionOpenAtGrace && !(utcDay(view.spotUpdatedAt) === utcDay(view.now) && view.sessionAtSpotObservation)) {
    return { roll: false, reason: 'spot-before-open' };
  }
  return { roll: true, reason: 'roll' };
}

/*//////////////////////////////////////////////////////////////
                           STALE ASKS
//////////////////////////////////////////////////////////////*/

/**
 * `AutoRoller._overtaken`: the spot has reached the strike, so every price the writer's band allows is below
 * intrinsic value. A call is overtaken at or above its strike, a put at or below it.
 */
export const overtaken = (isPut: boolean, strike: bigint, spot: bigint): boolean => (isPut ? spot <= strike : spot >= strike);

export interface StaleView {
  /** AutoRoller.position(writer, underlying).orderId: 0 when no ask is tracked. */
  orderId: bigint;
  /** The period's expiry (position.expiry). */
  positionExpiry: number;
  now: number;
  /** The tracked ask from OrderBook.getOrders; null when it could not be read. */
  order: { units: bigint; filled: bigint; validUntil: number; cancelled: boolean } | null;
  /** Clearinghouse.series(position.longId): the side and strike the spot is compared with. Null when unread. */
  series: { isPut: boolean; strike: bigint } | null;
  /** SettlementOracle.trySpot(underlying) of the MARKET's oracle: the price when ok and non-zero, else null. */
  spot: bigint | null;
  /** AutoRoller.minRollUnits: a cancel of less than this pays no CANCEL_STALE bounty. */
  minRollUnits: bigint;
}

export type StaleDecision =
  | { cancel: true; remaining: bigint; earnsBounty: boolean }
  | { cancel: false; reason: 'no-ask' | 'period-over' | 'order-dead' | 'unread' | 'spot-stale' | 'not-overtaken' };

/**
 * `AutoRoller.cancelStale`'s own conditions, in its order, so a tick only simulates the writers it could withdraw
 * (INTERFACE_VERSION 7, c16). The contract returns **false** rather than reverting for every "nothing to do", so
 * without this mirror every writer would cost a simulation and a `no-op` per tick.
 *
 * FRESHNESS IS `trySpot` OK AND NOTHING MORE, deliberately (v7 design §4.5.1): source 0's `updatedAt` never goes
 * backwards, so any reading that triggers was observed after the roll, and a session-only bound would refuse to
 * withdraw overnight while the book still trades.
 */
export function planStale(view: StaleView): StaleDecision {
  if (view.orderId === 0n) return { cancel: false, reason: 'no-ask' };
  if (view.now >= view.positionExpiry) return { cancel: false, reason: 'period-over' };
  if (view.order === null || view.series === null) return { cancel: false, reason: 'unread' };
  const remaining = view.order.units > view.order.filled ? view.order.units - view.order.filled : 0n;
  if (view.order.cancelled || remaining === 0n || view.now >= view.order.validUntil) return { cancel: false, reason: 'order-dead' };
  if (view.spot === null || view.spot <= 0n) return { cancel: false, reason: 'spot-stale' };
  if (!overtaken(view.series.isPut, view.series.strike, view.spot)) return { cancel: false, reason: 'not-overtaken' };
  return { cancel: true, remaining, earnsBounty: remaining >= view.minRollUnits };
}

/*//////////////////////////////////////////////////////////////
                          HOUSEKEEPING
//////////////////////////////////////////////////////////////*/

/** K2-03 step 6: sweep an asset's accrued exercise fees at most once per interval. */
export function sweepDue(input: { accrued: bigint; lastSweepAt: number | null; now: number; intervalS: number }): boolean {
  if (input.accrued === 0n) return false;
  return input.lastSweepAt === null || input.now - input.lastSweepAt >= input.intervalS;
}

/*//////////////////////////////////////////////////////////////
                               TIME
//////////////////////////////////////////////////////////////*/

export interface WakeSchedule {
  /** Head timestamp the wake-up targets. */
  at: number;
  /** Wall-clock delay from now. */
  delayMs: number;
}

/**
 * The precise wake-up (K2-03 step 2: the snapshot window is ten minutes, a poll interval must not
 * decide whether it is hit). The earliest future target, as a delay measured on the head block's
 * clock plus a margin so the head has reached it; null when there is none or the next poll comes
 * first anyway.
 */
export function scheduleWake(input: {
  now: number;
  targets: readonly (number | null)[];
  pollIntervalMs: number;
  marginMs?: number;
  minDelayMs?: number;
  /** The head timestamp the tick planned from. A target that passed while the tick ran (after this,
   *  at or before `now`) was planned as future work nobody did: wake at once. */
  plannedAt?: number;
}): WakeSchedule | null {
  const minDelayMs = input.minDelayMs ?? MIN_WAKE_DELAY_MS;
  if (input.plannedAt !== undefined) {
    const missed = input.targets.filter((t): t is number => t !== null && t > input.plannedAt! && t <= input.now);
    if (missed.length > 0) return { at: Math.min(...missed), delayMs: minDelayMs };
  }
  const future = input.targets.filter((t): t is number => t !== null && t > input.now);
  if (future.length === 0) return null;
  const at = Math.min(...future);
  const delayMs = Math.max(minDelayMs, (at - input.now) * 1000 + (input.marginMs ?? WAKE_MARGIN_MS));
  if (delayMs >= input.pollIntervalMs) return null;
  return { at, delayMs };
}

/**
 * The wall-clock moment (ms) the head reaches the earliest target after `headTimestamp` among a tick's targets, measured
 * from when that head was read; null when there is none. Past it, the tick's slow steps stop sending (steps.ts Budget)
 * so the precise wake-up runs the time-critical work (a snapshot has 600 s) instead of waiting for the tick to end.
 */
export function yieldDeadlineMs(input: { targets: readonly (number | null)[]; headTimestamp: number; headReadAtMs: number }): number | null {
  const future = input.targets.filter((t): t is number => t !== null && t > input.headTimestamp);
  if (future.length === 0) return null;
  return input.headReadAtMs + (Math.min(...future) - input.headTimestamp) * 1000;
}

export interface ExpiryKey {
  oracle: string;
  underlying: string;
  expiry: number;
}

export const expiryKeyString = (k: ExpiryKey): string => `${k.oracle.toLowerCase()}:${k.underlying.toLowerCase()}:${k.expiry}`;

/**
 * The expiries a tick surveys: every expired one not marked done, and the upcoming ones within
 * `horizonS` (their open interest decides a wake-up). `limit` bounds the tick.
 *
 * RECENT FIRST. With `recentS`, the expiries at or after `now − recentS` (the upcoming ones, and those whose
 * snapshot, finalize, veto window and adminResolve are still ahead) come first, oldest first; the older backlog
 * fills what is left, in rotation from `backlogOffset`. Without it, a backlog of expiries that never finish (an
 * order the book will not prune, a holder nobody can redeem) would fill the limit oldest first and no newer expiry
 * would ever be surveyed: no snapshot, finalize, settle or redeem.
 */
export function selectExpiries(
  all: readonly ExpiryKey[],
  done: ReadonlySet<string>,
  now: number,
  horizonS: number,
  limit: number,
  options: { recentS?: number; backlogOffset?: number } = {},
): ExpiryKey[] {
  const seen = new Set<string>();
  const eligible: ExpiryKey[] = [];
  for (const k of [...all].sort((a, b) => a.expiry - b.expiry)) {
    const id = expiryKeyString(k);
    if (seen.has(id) || done.has(id) || k.expiry > now + horizonS) continue;
    seen.add(id);
    eligible.push(k);
  }
  if (options.recentS === undefined) return eligible.slice(0, limit);
  const cutoff = now - options.recentS;
  const recent = eligible.filter((k) => k.expiry >= cutoff);
  const backlog = eligible.filter((k) => k.expiry < cutoff);
  const out = recent.slice(0, limit);
  const room = Math.min(limit - out.length, backlog.length);
  const start = backlog.length === 0 ? 0 : (((options.backlogOffset ?? 0) % backlog.length) + backlog.length) % backlog.length;
  for (let i = 0; i < room; i += 1) out.push(backlog[(start + i) % backlog.length]!);
  return out;
}
