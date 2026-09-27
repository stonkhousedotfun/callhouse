/**
 * EarnVault venue keeping, as a pure decision: given what the vault reports, what to send this tick.
 *
 * WHAT THE CONTRACT ALREADY GUARANTEES, and why this planner can stay small (EarnVault.sol at contracts v8):
 *   - `redeem` raises what it owes from the venue itself (`_raise` -> `_pull`) and QUEUES the remainder with an
 *     event instead of reverting. Nothing this keeper does or fails to do can make a redeem revert; leaving cash
 *     in the venue only means a larger redeem waits in the queue for `processQueue`.
 *   - `sweepToVenue` clamps to the UNESCROWED wallet and reverts `NoSource` with no adapter and `BadUnits` for
 *     zero. `pullFromVenue` is credited as the measured balance delta.
 *   - UNESCROWED is `_unescrowed()` = `_deliverable(wallet, 0)` = wallet - (escrowedAssets + deferredAssets),
 *     saturating at 0 (EarnVault.sol `_deliverable`). Queued deposits AND payments held for
 *     `claimDeferred` (a receiver the asset refused) sit in the wallet but are never the vault's to sweep.
 *     `totalAssets()` already nets both out, so the percentage buffer reads it as reported.
 *   - `processQueue` and `skim` are permissionless. `processQueue` serves nothing while a position is open;
 *     `skim` takes nothing while a queue is open and pays 0 while `skimBps` is 0.
 *     A zero return is not always "nothing owed": the cranker (steps.ts earnQueue) treats a zero fee
 *     whose mark did not move, while the share price is still above the mark, as a fee still owed.
 *   - The queue is empty when `head > tail` (`queue()` returns both; the constructor sets head = 1, tail = 0).
 *
 * THE RULES HERE:
 *   - No adapter: nothing at all. There is no venue to move to or from.
 *   - A queue is open: NEVER sweep. Pull what the venue can give (bounded) and serve the queue, unless a
 *     position is open, in which case `processQueue` would serve nothing, so do nothing.
 *   - No queue, a position open: never sweep (the vault is mid-cycle and its cash backs what it wrote).
 *   - The vault refuses to price because its venue cannot be read (earn/venue.ts): nothing,
 *     queue or not. `processQueue` serves nothing then, a sweep would put more cash into a venue nobody can value,
 *     and what a pull takes out of it is TREASURY_ADMIN's call (fix the venue, or write it off with `setAdapter`).
 *   - No queue, no position, and `deferredAssets()` could not be read: nothing. The sweepable amount is
 *     unknown, and reading it as 0 would sweep money owed to deferred receivers. The queue branch above needs no
 *     deferred figure (it pulls what the venue can give), so it still runs.
 *   - No queue, no position: keep `buffer` in the wallet. Sweep the unescrowed excess above it into the venue;
 *     pull back up to it when the wallet has fallen below. Buffer = max(bufferUsdg6, totalAssets * bufferBps).
 *     Both default to 0: everything idle is swept
 *     and redeems pull from the venue on demand.
 *   - Every move is capped at `maxMoveUsdg6` per tick, and a move under `dustUsdg6` is not worth a transaction.
 *   - `skim` once per `skimIntervalS`, and only when no queue is open (it would take nothing).
 */

export interface EarnState {
  /** `adapter()`; null for address(0). */
  adapter: string | null;
  /** `hasOpenPosition()`: a short written, a long bought, or longs escrowed in a resale. */
  hasOpenPosition: boolean;
  /** `convertToAssets` refuses VenueUnreadable: nothing is priced until the venue reads (earn/venue.ts). */
  venueUnreadable: boolean;
  /** `queue()`. */
  queueHead: bigint;
  queueTail: bigint;
  /** USDG `balanceOf(vault)`. */
  wallet: bigint;
  /** `escrowedAssets()`: queued deposits held in the wallet, never swept. */
  escrowed: bigint;
  /**
   * `deferredAssets()`: queue payments held in the wallet for `claimDeferred`, never swept. null when the
   * read failed (an older EarnVault build has no such function), which is a skip, never a 0.
   */
  deferred: bigint | null;
  /** `totalAssets()`, for the percentage buffer. */
  totalAssets: bigint;
  /** The adapter's `withdrawable()`: what the venue can return right now. */
  venueWithdrawable: bigint;
  /** Head timestamp. */
  now: number;
  /** When `skim` was last sent (head seconds), or null. */
  lastSkimAt: number | null;
}

export interface EarnKnobs {
  /** Fixed wallet buffer, USDG base units (6 dp). */
  bufferUsdg6: bigint;
  /** Wallet buffer as bps of totalAssets. The larger of the two buffers applies. */
  bufferBps: number;
  /** Most USDG moved by one sweep or pull, per tick. */
  maxMoveUsdg6: bigint;
  /** Smallest move worth a transaction. */
  dustUsdg6: bigint;
  /** Queue entries per processQueue call. */
  queueBatch: number;
  /** Seconds between skims. */
  skimIntervalS: number;
}

export type EarnAction =
  | { kind: 'sweep'; amount: bigint }
  | { kind: 'pull'; amount: bigint; reason: 'queue' | 'buffer' }
  | { kind: 'processQueue'; maxEntries: number }
  | { kind: 'skim' };

export type EarnSkip = 'no-adapter' | 'open-position' | 'venue-unreadable' | 'deferred-unreadable';

export interface EarnPlan {
  actions: EarnAction[];
  skipped: EarnSkip | null;
  queueOpen: boolean;
  /** Wallet minus escrow and deferred payments, saturating at 0 (the contract's `_unescrowed`); null when deferred is unknown. */
  unescrowed: bigint | null;
  buffer: bigint;
}

const BPS = 10_000n;

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

export function queueOpen(head: bigint, tail: bigint): boolean {
  return head <= tail;
}

export function walletBuffer(totalAssets: bigint, k: Pick<EarnKnobs, 'bufferUsdg6' | 'bufferBps'>): bigint {
  const pct = (totalAssets * BigInt(k.bufferBps)) / BPS;
  return pct > k.bufferUsdg6 ? pct : k.bufferUsdg6;
}

/** The contract's `_unescrowed()`: wallet - (escrowed + deferred), saturating at 0. null when deferred is unknown. */
export function unescrowedOf(s: Pick<EarnState, 'wallet' | 'escrowed' | 'deferred'>): bigint | null {
  if (s.deferred === null) return null;
  const reserved = s.escrowed + s.deferred;
  return s.wallet > reserved ? s.wallet - reserved : 0n;
}

export function planEarn(s: EarnState, k: EarnKnobs): EarnPlan {
  const open = queueOpen(s.queueHead, s.queueTail);
  const unescrowed = unescrowedOf(s);
  const buffer = walletBuffer(s.totalAssets, k);
  const plan: EarnPlan = { actions: [], skipped: null, queueOpen: open, unescrowed, buffer };

  if (s.adapter === null) {
    plan.skipped = 'no-adapter';
    return plan;
  }
  if (s.hasOpenPosition) {
    // Queue or not: a sweep would move cash that backs a written series, and processQueue serves nothing.
    plan.skipped = 'open-position';
    return plan;
  }
  if (s.venueUnreadable) {
    plan.skipped = 'venue-unreadable';
    return plan;
  }

  if (open) {
    const pull = min(s.venueWithdrawable, k.maxMoveUsdg6);
    if (pull >= k.dustUsdg6 && pull > 0n) plan.actions.push({ kind: 'pull', amount: pull, reason: 'queue' });
    plan.actions.push({ kind: 'processQueue', maxEntries: k.queueBatch });
    return plan; // never sweep, and skim would take nothing
  }

  if (unescrowed === null) {
    plan.skipped = 'deferred-unreadable';
    return plan;
  }
  if (unescrowed > buffer) {
    const sweep = min(unescrowed - buffer, k.maxMoveUsdg6);
    if (sweep >= k.dustUsdg6 && sweep > 0n) plan.actions.push({ kind: 'sweep', amount: sweep });
  } else if (unescrowed < buffer) {
    const pull = min(buffer - unescrowed, s.venueWithdrawable, k.maxMoveUsdg6);
    if (pull >= k.dustUsdg6 && pull > 0n) plan.actions.push({ kind: 'pull', amount: pull, reason: 'buffer' });
  }

  if (s.lastSkimAt === null || s.now - s.lastSkimAt >= k.skimIntervalS) plan.actions.push({ kind: 'skim' });
  return plan;
}
