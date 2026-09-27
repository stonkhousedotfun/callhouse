/**
 * The mm bot's EarnVault venue step: read the vault, decide with earn/plan.ts, send the one QUOTER move the
 * plan asks for, and watch the withdrawal queue for standing still.
 *
 * WHY THE MM BOT. `sweepToVenue` and `pullFromVenue` are QUOTER on the EarnVault (roles.v8.json) and the mm bot's key
 * is its QUOTER. `processQueue` and `skim` are permissionless and already sent by the cranker's `house` step
 * (cranker/steps.ts, earn/queue.ts), so this step drops them from the plan rather than sending them twice.
 *
 * THE BUFFER COMES FROM CONFIG, never from a constant here: EARN_BUFFER_USDG6 / EARN_BUFFER_BPS, rendered by
 * ops/v2-env.mjs into the mm-bot env and parsed into MmTuning.earn (config.ts). Sweeping with no buffer at all is the
 * launch setting (both 0), not a default this file picks.
 *
 * STUCK. A queue whose head has not moved for `queueStuckS` while entries wait is paged as v2_earn_queue_stuck by the
 * caller. The clock is the head timestamp, and the watch is in memory: a restart starts the wait again.
 * Reads and sends are injected, so the mm bot and the tests share this code.
 */
import { planEarn, queueOpen, type EarnKnobs, type EarnPlan, type EarnState } from './plan.js';

/** The venue settings the mm bot reads from MmTuning.earn. */
export type EarnVenueKnobs = Pick<EarnKnobs, 'bufferUsdg6' | 'bufferBps' | 'maxMoveUsdg6' | 'dustUsdg6'>;

/** A QUOTER move: `sweepToVenue(amount)` or `pullFromVenue(amount)`. */
export type EarnMove = Extract<EarnPlan['actions'][number], { kind: 'sweep' | 'pull' }>;

/** Where the queue head was first seen standing (head seconds). null while the queue is empty. */
export interface QueueWatch {
  head: bigint;
  since: number;
}

export interface EarnKeepIo {
  read: () => Promise<EarnState>;
  /** Sends the move; true when it confirmed. */
  send: (move: EarnMove) => Promise<boolean>;
}

export interface EarnKeepResult {
  state: EarnState;
  plan: EarnPlan;
  /** The moves the plan asked for (at most one), and whether each confirmed. */
  sent: Array<{ move: EarnMove; confirmed: boolean }>;
  watch: QueueWatch | null;
  /** Seconds the open queue's head has stood still; 0 when the queue is empty or just moved. */
  stuckForS: number;
}

/** The QUOTER moves of a plan. processQueue and skim are the cranker's, so they are dropped here. */
export function venueMoves(plan: EarnPlan): EarnMove[] {
  return plan.actions.filter((a): a is EarnMove => a.kind === 'sweep' || a.kind === 'pull');
}

/** planEarn over the venue settings. queueBatch and skimIntervalS shape only the dropped cranker actions. */
export function planVenue(s: EarnState, k: EarnVenueKnobs): { plan: EarnPlan; moves: EarnMove[] } {
  const plan = planEarn(s, { ...k, queueBatch: 0, skimIntervalS: 0 });
  return { plan, moves: venueMoves(plan) };
}

/** The watch after a read: cleared when the queue is empty, restarted when its head moved, else unchanged. */
export function watchQueue(prev: QueueWatch | null, s: Pick<EarnState, 'queueHead' | 'queueTail' | 'now'>): QueueWatch | null {
  if (!queueOpen(s.queueHead, s.queueTail)) return null;
  if (prev !== null && prev.head === s.queueHead) return prev;
  return { head: s.queueHead, since: s.now };
}

/** Why an open queue is not being paid, in the words the page carries. */
export function stuckReason(s: EarnState, plan: EarnPlan): string {
  if (plan.skipped === 'no-adapter') return 'no venue adapter is set, so the vault can pay only from its wallet';
  if (plan.skipped === 'open-position') {
    return 'the vault holds a position: processQueue serves nothing until its series settle or the mm bot closes them';
  }
  if (plan.skipped === 'venue-unreadable') {
    return 'the venue adapter cannot be read, so the vault prices nothing: processQueue serves nothing until the venue '
      + 'reads again or TREASURY_ADMIN writes it off with setAdapter (VenueWrittenOff)';
  }
  if (s.venueWithdrawable === 0n) return 'the venue has nothing withdrawable and the wallet cannot cover the head entry';
  return 'the venue still has USDG to pull: check that the mm bot pulls and the cranker house step sends processQueue';
}

export async function keepEarn(io: EarnKeepIo, k: EarnVenueKnobs, prev: QueueWatch | null): Promise<EarnKeepResult> {
  const state = await io.read();
  const { plan, moves } = planVenue(state, k);
  const sent: EarnKeepResult['sent'] = [];
  for (const move of moves) sent.push({ move, confirmed: await io.send(move) });
  const watch = watchQueue(prev, state);
  return { state, plan, sent, watch, stuckForS: watch === null ? 0 : state.now - watch.since };
}
