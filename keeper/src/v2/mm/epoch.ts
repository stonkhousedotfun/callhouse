/**
 * Pure epoch-window predicates for the MM quote plan (K8-05).
 *
 * `epochEnd` is a UNIX second READ FROM THE VAULT by the runtime (T-K8-05-VAULTS /
 * K8-05 vaults) and passed in on `EpochView`. This file never derives "next Friday",
 * never consults a local clock, a cron expression or `ExpiryCalendar`, and never
 * assumes a 7-day epoch length.
 *
 * `epoch === null` is a treasury MakerVault: unrestricted, i.e. today's behaviour
 * exactly.
 *
 * No viem, no address, no chain read.
 */

export interface EpochView {
  /** UNIX seconds; source is the vault, not this file. */
  epochEnd: number;
  index: number | bigint;
  rollDue: boolean;
}

export type EpochSelectable = 'ok' | 'epoch-outside' | 'epoch-winddown';

/**
 * Whether this series may open new risk in `epoch` at `now`.
 * `'epoch-outside'` when `series.expiry > epoch.epochEnd`.
 * `'epoch-winddown'` when `now >= epoch.epochEnd - windDownS` (no NEW risk).
 */
export function epochSelectable(
  series: { expiry: number },
  epoch: EpochView | null,
  now: number,
  windDownS: number,
): EpochSelectable {
  if (epoch === null) return 'ok';
  if (series.expiry > epoch.epochEnd) return 'epoch-outside';
  if (now >= epoch.epochEnd - windDownS) return 'epoch-winddown';
  return 'ok';
}

/** What wind-down does to each slot: opening risk stops; unwinding does not. */
export interface WindDownSlots {
  bid: boolean;
  write: boolean;
  resale: boolean;
  close: boolean;
  cancel: boolean;
}

export function windDownAction(view: { exposure: { longs: bigint } | null }): WindDownSlots {
  const longs = view.exposure === null ? 0n : view.exposure.longs;
  return {
    bid: false,
    write: false,
    resale: longs > 0n,
    close: true,
    cancel: true,
  };
}

/** True iff every series of the epoch has no longs, shorts or resale (planner `hasInventory` shape). */
export function flatForRoll(views: readonly { longs: bigint; shorts: bigint; resale: bigint }[]): boolean {
  return views.every((v) => v.longs === 0n && v.shorts === 0n && v.resale === 0n);
}
