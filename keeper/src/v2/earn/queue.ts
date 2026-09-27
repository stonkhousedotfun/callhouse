/**
 * Pay queued EarnVault withdrawals as soon as the vault can (the Earn
 * withdrawal experience: queued withdrawals are paid with no user action).
 *
 * `processQueue(maxEntries)` is permissionless and serves nothing while the vault holds a position
 * (EarnVault.sol processQueue: prune first, then return while a series is written). So the moment a series the
 * vault wrote or held settles and prunes to none, the next call pays the queue. This loop makes that call and
 * repeats it while it makes progress:
 *   - stops when the queue is empty (head > tail);
 *   - stops when a call served nothing (the head did not move): the vault is short of cash. `redeem` already
 *     pulled what the venue could give when it queued, and pulling more needs the QUOTER key (earn/plan.ts);
 *   - stops at `maxCalls`, or when the send was not confirmed (a revert, a lost receipt, a dry run);
 *   -: sends nothing while the vault refuses to price because its venue cannot be read.
 *     processQueue returns having served nothing then, so a send would only spend gas; it waits until the venue
 *     reads again or TREASURY_ADMIN writes it off (earn/venue.ts).
 * Reads and sends are injected, so the cranker step and the tests share this code.
 */

export interface QueueView {
  head: bigint;
  tail: bigint;
  hasOpenPosition: boolean;
  /** The vault refuses to price because its venue cannot be read (earn/venue.ts readVenueUnpriced). */
  venueUnreadable: boolean;
}

export type DrainStop = 'empty' | 'open-position' | 'venue-unreadable' | 'no-progress' | 'max-calls' | 'not-confirmed';

export interface DrainResult {
  calls: number;
  /** Queue entries the head moved past. */
  served: bigint;
  stop: DrainStop;
  /** The last view read. */
  last: QueueView;
}

export interface DrainIo {
  read: () => Promise<QueueView>;
  /** Sends processQueue(maxEntries). true when it landed (confirmed or already advanced). */
  processQueue: (maxEntries: number, headBefore: bigint) => Promise<boolean>;
}

export const queueIsOpen = (q: Pick<QueueView, 'head' | 'tail'>) => q.head <= q.tail;

export async function drainQueue(io: DrainIo, maxEntries: number, maxCalls: number): Promise<DrainResult> {
  let view = await io.read();
  const start = view.head;
  let calls = 0;
  const done = (stop: DrainStop): DrainResult => ({ calls, served: view.head - start, stop, last: view });
  for (;;) {
    if (!queueIsOpen(view)) return done('empty');
    if (view.hasOpenPosition) return done('open-position');
    if (view.venueUnreadable) return done('venue-unreadable');
    if (calls >= maxCalls) return done('max-calls');
    const before = view.head;
    calls += 1;
    if (!(await io.processQueue(maxEntries, before))) return done('not-confirmed');
    view = await io.read();
    if (view.head === before) return done('no-progress');
  }
}
