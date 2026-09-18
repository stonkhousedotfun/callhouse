/**
 * What the rules see: a Snapshot of the world at one tick, built from the indexer and the
 * subscriptions table, and the derived per-series and per-alert state that carries from one tick
 * to the next. Rules (rules.ts) are pure functions over the previous snapshot (`before`) and the
 * current one (`after`); the engine (engine.ts) builds `after` and persists it (store.ts).
 *
 * Every shape here is also a jsonb column, so each has a zod schema and a stored value that no
 * longer parses is treated as absent (a fresh start for that part), never as a crash.
 */
import { getAddress } from 'viem';
import { z } from 'zod';
import type { ApiPositions, ApiSeries } from './indexer.js';

/* ------------------------------------------------------------------ holdings */

const uint = z.string().regex(/^(0|[1-9]\d*)$/);

export const seriesInfoSchema = z.object({
  longId: uint,
  ticker: z.string().min(1),
  underlying: z.string(),
  isPut: z.boolean(),
  strike: z.object({ raw: uint, decimals: z.number().int() }),
  expiry: z.number().int().nonnegative(),
  status: z.enum(['open', 'cutoff', 'expired', 'settling', 'held', 'settled']),
});
/** The part of a §4 SeriesRef the rules and the payloads need. */
export type SeriesInfo = z.infer<typeof seriesInfoSchema>;

export const holdingsSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  longs: z.array(z.object({ series: seriesInfoSchema, units: uint, avgCost: uint })),
  shorts: z.array(
    z.object({ series: seriesInfoSchema, units: uint, collateralLocked: z.object({ raw: uint, decimals: z.number().int() }) }),
  ),
  strategies: z.array(
    z.object({
      ticker: z.string().min(1),
      active: z.boolean(),
      currentSeries: seriesInfoSchema.nullable(),
      /** Unix seconds of the last Rolled. A row stored before the field existed reads as null. */
      lastRolledAt: z.number().int().nonnegative().nullable().default(null),
    }),
  ),
  prefs: z.object({ inKind: z.boolean(), toLedger: z.boolean() }),
  /**
   * Units and average cost (USDG per share, fees included) of every long this wallet was last
   * seen holding, kept LAST_KNOWN_TTL_S after the long disappears. A redemption burns the long, so
   * by the time its receipt is built the positions route no longer lists what it cost.
   */
  lastKnownLongs: z.record(z.object({ units: uint, avgCost: uint, seenAt: z.number().int().nonnegative() })),
});
/** One subscribed wallet's positions, trimmed to what the rules read. */
export type Holdings = z.infer<typeof holdingsSchema>;

export const LAST_KNOWN_TTL_S = 8 * 24 * 3600;

export function seriesInfo(series: ApiSeries): SeriesInfo {
  return {
    longId: series.longId,
    ticker: series.ticker,
    underlying: series.underlying,
    isPut: series.isPut,
    strike: { raw: series.strike.raw, decimals: series.strike.decimals },
    expiry: series.expiry,
    status: series.status,
  };
}

/** Positions → Holdings, carrying the previous holdings' last-known longs forward. Pure. */
export function holdingsFrom(positions: ApiPositions, previous: Holdings | undefined, now: number): Holdings {
  const lastKnownLongs: Holdings['lastKnownLongs'] = {};
  for (const [longId, known] of Object.entries(previous?.lastKnownLongs ?? {})) {
    if (now - known.seenAt <= LAST_KNOWN_TTL_S) lastKnownLongs[longId] = known;
  }
  const longs = positions.longs
    .filter((l) => BigInt(l.units) > 0n)
    .map((l) => ({ series: seriesInfo(l.series), units: l.units, avgCost: l.avgCost.raw }));
  for (const long of longs) {
    lastKnownLongs[long.series.longId] = { units: long.units, avgCost: long.avgCost, seenAt: now };
  }
  return {
    fetchedAt: now,
    longs,
    shorts: positions.shorts
      .filter((s) => BigInt(s.units) > 0n)
      .map((s) => ({
        series: seriesInfo(s.series),
        units: s.units,
        collateralLocked: { raw: s.collateralLocked.raw, decimals: s.collateralLocked.decimals },
      })),
    strategies: positions.strategies.map((s) => ({
      ticker: s.ticker,
      active: s.strategy.active,
      currentSeries: s.currentSeries === null ? null : seriesInfo(s.currentSeries),
      lastRolledAt: s.lastRolledAt,
    })),
    prefs: { inKind: positions.prefs.inKind, toLedger: positions.prefs.toLedger },
    lastKnownLongs,
  };
}

/* ------------------------------------------------------------------ settlements, alerts */

export const settlementInfoSchema = z.object({
  /** USDG per share. */
  price: uint,
  /** Collateral-asset base units per unit (18 dp for calls, 6 for puts); "0" = expired worthless. */
  longPayoutPerUnit: uint,
  /**
   * When the series settled, for the storm guard: the SeriesSettled time (the activity item's
   * `ts`), or the oracle's finalization time, which is at or before it, when the settlement came
   * from the /v2/series fallback. The key keeps its first name so stored snapshots still parse.
   */
  finalizedAt: z.number().int().nonnegative(),
});
export type SettlementInfo = z.infer<typeof settlementInfoSchema>;

export interface PriceAlert {
  ticker: string;
  direction: 'above' | 'below';
  /** USDG base units per share. */
  threshold: string;
}

export function alertKey(address: string, alert: PriceAlert): string {
  return `${address}|${alert.ticker}|${alert.direction}|${alert.threshold}`;
}

/* ------------------------------------------------------------------ snapshot */

export const sideSchema = z.enum(['above', 'below']);
export type Side = z.infer<typeof sideSchema>;

/** Everything of a snapshot except holdings, which are stored one row per wallet. */
export const snapshotStateSchema = z.object({
  /** Unix seconds of the tick. 0 = no tick yet. */
  at: z.number().int().nonnegative(),
  /** Ticker → spot, USDG base units per share. */
  spots: z.record(uint),
  /** Checksummed address → that wallet's price alerts (the union over its subscriptions). */
  alerts: z.record(z.array(z.object({ ticker: z.string(), direction: sideSchema, threshold: uint }))),
  /** longId → which side of the strike spot is on, after the 0.25 % hysteresis (derived). */
  strikeSides: z.record(sideSchema),
  /** alertKey → whether the alert's condition held at `at` (derived). */
  alertStates: z.record(z.boolean()),
  /**
   * longId → settlement of a series whose long the watch set holds, while it can still matter to
   * the worthless-long receipt (settled within the storm guard). Immutable once final.
   */
  settlements: z.record(settlementInfoSchema),
  /**
   * Day index → isSessionDay (GET /v2/calendar/holidays): the days the auto_roll rule read at `at`,
   * kept so the next tick judges "was it already overdue" by what this tick knew. A day missing
   * here was unknown then. Absent in snapshots stored before it existed.
   */
  sessionDays: z.record(z.boolean()).default({}),
});
export type SnapshotState = z.infer<typeof snapshotStateSchema>;

export interface Snapshot extends SnapshotState {
  /** Checksummed address → holdings. A watched wallet whose positions were never read is absent. */
  holdings: Record<string, Holdings>;
}

export function emptySnapshot(): Snapshot {
  return { at: 0, spots: {}, alerts: {}, strikeSides: {}, alertStates: {}, settlements: {}, holdings: {}, sessionDays: {} };
}

/** Every (holder, position) of a series in a snapshot. */
export function holdersOf(snapshot: Snapshot, longId: string): { address: string; side: 'long' | 'short' }[] {
  const out: { address: string; side: 'long' | 'short' }[] = [];
  for (const [address, h] of Object.entries(snapshot.holdings)) {
    if (h.longs.some((l) => l.series.longId === longId)) out.push({ address, side: 'long' });
    if (h.shorts.some((s) => s.series.longId === longId)) out.push({ address, side: 'short' });
  }
  return out;
}

export const checksum = (address: string): string => getAddress(address);
