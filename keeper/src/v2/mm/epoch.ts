/**
 * Pure epoch-window predicates for the MM quote plan.
 *
 * `epochEnd` is a UNIX second READ FROM THE VAULT by the runtime (House
 * vaults) and passed in on `EpochView`. This file never derives "next Friday",
 * never consults a local clock, a cron expression or `ExpiryCalendar`, and never
 * assumes a 7-day epoch length.
 *
 * `epoch === null` is a treasury MakerVault: unrestricted, i.e. today's behaviour
 * exactly.
 *
 * No viem, no address, no chain read.
 */

/** A House vault's epoch kind (`weekly()`; a legacy vault is weekly by construction). */
export type EpochKind = 'weekly' | 'daily';

export interface EpochView {
  /** UNIX seconds; source is the vault, not this file. */
  epochEnd: number;
  index: number | bigint;
  rollDue: boolean;
  /** The vault's epoch kind. Absent only on views built by older tests; the runtime always sets it. */
  kind?: EpochKind;
  /**
   * This vault's wind-down lead, seconds, chosen from `kind` by the quoter (MM_EPOCH_WIND_DOWN_S for weekly,
   * MM_EPOCH_WIND_DOWN_DAILY_S for daily). When set it wins over the process-wide value passed to
   * {@link epochSelectable}; absent means that value, which is exactly the earlier behaviour.
   */
  windDownS?: number;
  /**
   * The vault is being WOUND DOWN for good: its factory is the legacy weekly one and a daily factory is now
   * configured (mm/house.ts {@link legacyWeeklyWindingDown}). The whole epoch is then a wind-down window, not only
   * the last `windDownS` of it: no new risk at any time, closing trades only (windDownAction). Once the last epoch
   * has settled the vault holds nothing to close, so the bot places nothing on it. Absent = false.
   */
  windingDown?: boolean;
}

export type EpochSelectable = 'ok' | 'epoch-outside' | 'epoch-winddown';

/**
 * Whether this series may open new risk in `epoch` at `now`.
 * `'epoch-outside'` when `series.expiry > epoch.epochEnd`.
 * `'epoch-winddown'` when `now >= epoch.epochEnd - windDownS` (no NEW risk), where `windDownS` is the vault's own
 * `epoch.windDownS` when it carries one (a daily vault winds down in minutes, a weekly one in hours) and
 * the process-wide argument otherwise; and at ANY time when the vault is `windingDown`.
 */
export function epochSelectable(
  series: { expiry: number },
  epoch: EpochView | null,
  now: number,
  windDownS: number,
): EpochSelectable {
  if (epoch === null) return 'ok';
  if (series.expiry > epoch.epochEnd) return 'epoch-outside';
  if (epoch.windingDown === true) return 'epoch-winddown';
  if (now >= epoch.epochEnd - (epoch.windDownS ?? windDownS)) return 'epoch-winddown';
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
