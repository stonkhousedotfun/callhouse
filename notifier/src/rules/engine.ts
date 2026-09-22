/**
 * The rules engine: every 30 s, read the indexer, build a snapshot, run the rules (rules.ts),
 * enqueue what they produce, persist. One tick, in order:
 *
 *   1. load the previous snapshot, the cursor and the watch set (verified, enabled subscriptions);
 *      GET /v2/config and, when a stored deployment anchor differs from the one just read, drop
 *      the cursor and snapshot so the tick starts at the storm-guard floor (now − maxAgeS). A
 *      failed config read leaves cursor, snapshot and stored anchor untouched (like a failed
 *      markets read). An absent stored anchor is recorded, not treated as a change.
 *   2. GET /v2/markets for spot and its `spotUpdatedAt` (the "as of" of price-driven messages); an
 *      unavailable spot skips spot-driven rules, not receipts. A successful read also refreshes the
 *      ticker cache the API refuses unknown price alerts against (markets.ts);
 *   3. GET /v2/feed/activity?since=<cursor.since − lookback> and page it; keep the items not seen;
 *   4. refresh /v2/accounts/:address/positions for WATCHED wallets only: those an item touched
 *      (taker, maker and fill recipient are all in `accounts`), those never read, and the stalest
 *      of the rest (holdingsRefreshS, all reads capped per tick). No global scan: the notifier never pages
 *      holders or strategies of the whole market;
 *   5. settlements for the worthless-long receipt: a settlement item for a long a watched wallet
 *      holds is kept in the snapshot for the storm-guard window. A redemption needs none (it
 *      carries its own settlementPrice). GET /v2/series/:longId is only the fallback for a held
 *      long that turned settled with no settlement item seen for it (a wallet watched after the
 *      item passed, a positions read that lagged), fetched at that transition. A failed fallback
 *      read does not block other receipts, and the transition is retried on the next refresh;
 *   6. GET /v2/calendar/holidays for the days after the expiry of each watched active strategy's
 *      current series, until a session day (auto_roll `skipped`). Days are fetched in fixed
 *      62-day blocks (the route's cap), cached per block for calendarRefreshS; a failure is not
 *      fatal (the rule waits for the days, and a stale block is used over none);
 *   7. event rules per new item, state rules over (before, after), only for watched wallets;
 *   8. delivery.enqueue each request (idempotent by dedupe key);
 *   9. persist cursor, snapshot and changed holdings in one transaction.
 *
 * RESTART SAFETY. Persisting last means a crash anywhere re-runs the tick; enqueue's dedupe keys
 * turn the re-run into duplicates, not second messages. The cursor keeps the ids it processed in
 * the lookback window, so the overlap the lookback asks for is read again but not handled again.
 *
 * WHY THE LOOKBACK IS 60 s. The feed is ordered by (block, log index) and every item's `ts` is its
 * block's timestamp, settlements included (they are anchored to SeriesSettled, not to the oracle's
 * earlier finalization, since interface v4), and the indexer serves only blocks at least 3 behind
 * its head, so a later read can no longer list an item older than one it already returned. What
 * the query must still repeat is the newest second: Robinhood Chain makes several blocks a second
 * with the same timestamp, so an item can land in a later block at the `ts` the cursor holds;
 * `since` is inclusive and the seen ids absorb that with no lookback at all. The 60 s kept is a
 * margin for a reorg deeper than the indexer's 3-block lag, whose replacement logs get new ids and
 * timestamps back to the fork (at 4 blocks a second, 240 blocks). The old 10 minutes existed for
 * settlements listed under a finalization time earlier than when they appeared; that is gone.
 *
 * STORM GUARD. Nothing is sent about an item older than maxAgeS (6 h), and after a restart the
 * feed is read from no earlier than now − 6 h: a notifier that was down for two days does not
 * replay two days of receipts. On first boot (no cursor) it starts at now − 6 h. Holdings-derived
 * settlement receipts check their settlement time the same way (rules.ts); countdowns, strike and
 * price conditions describe the present and are bounded by their transitions and dedupe buckets.
 *
 * OUTAGES. Failure of the state/feed/enqueue/persist steps aborts the tick with nothing persisted;
 * the loop logs a code and backs off (pollMs doubling to maxBackoffMs), and never throws. A failed
 * market read skips spot rules; failed positions and series reads keep prior holdings/settlements.
 * Wallet failures back off per address so one broken wallet cannot monopolize refresh slots.
 */
import { EnqueueError, type EnqueueResult } from '../delivery.js';
import type { Db } from '../db.js';
import type { EventKind } from '../events.js';
import { errorCode, type Logger } from '../log.js';
import type { MarketsCache } from '../markets.js';
import { dayIndexOf, SESSION_SCAN_DAYS } from './calendar.js';
import { CALENDAR_MAX_DAYS, IndexerError, assertInterfaceVersion, deploymentAnchor, liveFeesKey, type ActivityItem, type ApiConfig, type IndexerClient } from './indexer.js';
import { deriveState, eventRules, mergeAdminOperations, RULE_TIMING, stateRules, type EnqueueRequest } from './rules.js';
import { emptySnapshot, holdingsFrom, type Holdings, type SettlementInfo, type Snapshot, type SnapshotState } from './snapshot.js';
import { loadState, loadWatchSet, saveState, type Cursor } from './store.js';

export interface RulesOptions {
  pollMs: number;
  maxBackoffMs: number;
  /** Storm guard. */
  maxAgeS: number;
  /** How far behind the cursor each poll re-reads (see WHY THE LOOKBACK IS 60 s). */
  lookbackS: number;
  pageLimit: number;
  /** Pages per tick; the rest is resumed next tick from the indexer's cursor. */
  maxPages: number;
  holdingsRefreshS: number;
  /** Maximum positions reads per tick, including first reads and wallets touched by activity. */
  maxRefreshPerTick: number;
  refreshConcurrency: number;
  /** How long a fetched block of calendar days is used before it is read again (a holiday can be set late). */
  calendarRefreshS: number;
}

export const DEFAULT_RULES_OPTIONS: RulesOptions = {
  pollMs: 30_000,
  maxBackoffMs: 5 * 60_000,
  maxAgeS: RULE_TIMING.maxAgeS,
  lookbackS: 60,
  pageLimit: 200,
  maxPages: 10,
  holdingsRefreshS: 5 * 60,
  maxRefreshPerTick: 50,
  refreshConcurrency: 4,
  calendarRefreshS: 3600,
};

export type Enqueue = (kind: EventKind, address: string, payload: unknown, dedupeKey: string) => Promise<EnqueueResult>;

export interface RulesDeps {
  db: Db;
  indexer: IndexerClient;
  enqueue: Enqueue;
  logger: Logger;
  now: () => Date;
  /** Filled with the tickers of every successful /v2/markets read; the API reads it (markets.ts). */
  markets?: MarketsCache;
  options?: Partial<RulesOptions>;
}

export interface TickResult {
  /** New activity items read. */
  items: number;
  /** New items skipped by the storm guard. */
  stale: number;
  refreshed: number;
  refreshFailed: number;
  /** Calendar blocks read this tick, and reads that failed. */
  calendarRead: number;
  calendarFailed: number;
  requests: number;
  queued: number;
  duplicates: number;
  filtered: number;
  /** Requests enqueue refused (a rules bug); logged and skipped. */
  invalid: number;
  byKind: Partial<Record<EventKind, number>>;
}

export interface RulesHealth {
  status: 'off' | 'starting' | 'ok' | 'failing';
  lastSuccessAt: number | null;
  consecutiveFailures: number;
}

export function backoffMs(failures: number, pollMs: number, maxMs: number): number {
  if (failures <= 0) return pollMs;
  return Math.min(maxMs, pollMs * 2 ** Math.min(failures - 1, 20));
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

const codeOf = (error: unknown): string => (error instanceof IndexerError ? error.code : errorCode(error));

/** The first day of the fixed CALENDAR_MAX_DAYS-day block holding `day`. */
export const calendarBlockOf = (day: number): number => Math.floor(day / CALENDAR_MAX_DAYS) * CALENDAR_MAX_DAYS;

interface CalendarBlock {
  fetchedAt: number;
  /** Day index → isSessionDay, for the days the response covered inside the block. */
  days: Map<number, boolean>;
}

export class RulesEngine {
  private readonly options: RulesOptions;
  /** Block start → its days. Per process: a restart reads again what it needs. */
  private readonly calendar = new Map<number, CalendarBlock>();
  /** Failure retry state is process-local; restart still obeys the per-tick read limit. */
  private readonly holdingsRetry = new Map<string, { attempts: number; lastAttemptAt: number; retryAt: number }>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private lastSuccessAt: number | null = null;
  private failures = 0;

  constructor(private readonly deps: RulesDeps) {
    this.options = { ...DEFAULT_RULES_OPTIONS, ...deps.options };
  }

  health(): RulesHealth {
    return {
      status: this.failures > 0 ? 'failing' : this.lastSuccessAt === null ? 'starting' : 'ok',
      lastSuccessAt: this.lastSuccessAt,
      consecutiveFailures: this.failures,
    };
  }

  /** One tick. Throws when the tick could not complete; nothing is persisted then. */
  async runOnce(): Promise<TickResult> {
    const { db, indexer, logger } = this.deps;
    const o = this.options;
    const nowDate = this.deps.now();
    const now = Math.floor(nowDate.getTime() / 1000);
    const floor = now - o.maxAgeS;

    // 1. previous state, watch set, deployment anchor
    const stored = await loadState(db, logger);
    let before: Snapshot = { ...(stored.snapshot ?? emptySnapshot()), holdings: stored.holdings };
    const watch = await loadWatchSet(db);
    let observedAnchor: string | null = null;
    let anchorReset = false;
    let pendingFeesEffectiveAt: number | null = before.pendingFeesEffectiveAt;
    let liveKey: string | null = before.liveFeesKey;
    let adminOperations = mergeAdminOperations(before.adminOperations, []);
    let cfg: ApiConfig | null = null;
    try {
      cfg = await indexer.config();
    } catch (error) {
      logger.warn({ code: codeOf(error) }, 'config unavailable; leaving cursor and stored anchor');
    }
    // K8-231. THE VERSION CHECK IS DELIBERATELY OUTSIDE THE CATCH ABOVE.
    //
    // An UNREADABLE config is a transient failure and the tick continues on stored state; an
    // interface this build does not implement is neither transient nor recoverable, and the two must
    // not share a handler. Put `assertInterfaceVersion` inside that `try` and the catch swallows it
    // into 'config unavailable', the tick runs on, and the pin silently becomes a log line - a check
    // that cannot fail, which is the defect this row exists to close, one layer down.
    //
    // It throws before the admin-operations read and before any rule runs, so a tick that saw a
    // foreign interface reads nothing further, persists nothing and enqueues nothing.
    if (cfg !== null) {
      assertInterfaceVersion(cfg);
      observedAnchor = deploymentAnchor(cfg);
      pendingFeesEffectiveAt = cfg.pendingFees === undefined || cfg.pendingFees === null ? null : cfg.pendingFees.effectiveAt;
      liveKey = cfg.fees === undefined ? null : liveFeesKey(cfg.fees);
    }
    try {
      const ops = await indexer.adminOperations();
      // X8-181, F-APP-OPS-02. MERGE BY KEY (T-435: `key`, not `id`, which a reschedule reuses); do
      // not rebuild. `adminOperations = {}` threw the previous
      // tick's map away, so an operation that had left the page it was last seen on was ABSENT rather
      // than CHANGED - and the rule below only fires on a status that differs from a remembered one
      // (rules.ts adminOperationNotices). With only the pending page fetched, every operation that
      // reached a terminal state vanished exactly as it became worth telling someone about.
      //
      // The client now returns all three statuses, so an executed or canceled operation arrives here
      // with its REAL final status and overwrites the remembered `pending`. Nothing infers a status
      // from a disappearance: an operation can also leave the pending page by EXPIRING
      // (indexer/src/api/v2/admin.ts filters pending on `expiresAt > indexedAt` while its stored
      // status stays `pending`), and an expired operation is on no page at all. Such an operation
      // keeps its remembered `pending` and no notice fires, which is correct - there is no
      // expired notice to send, and guessing `executed` would report a governance action that never
      // happened.
      adminOperations = mergeAdminOperations(adminOperations, ops);
    } catch (error) {
      logger.warn({ code: codeOf(error) }, 'admin operations unavailable; leaving stored operations');
    }
    if (observedAnchor !== null) {
      const previous = stored.anchor;
      // Previous-absent is not a change: first boot (or an unreadable row) records the anchor
      // and resets nothing. Delete this `previous !== null` guard and the first-boot test goes red.
      if (previous !== null && previous !== observedAnchor) {
        logger.info({ oldAnchor: previous, newAnchor: observedAnchor }, 'deployment anchor changed; resetting activity cursor');
        stored.cursor = null;
        stored.snapshot = null;
        stored.holdings = {};
        before = { ...emptySnapshot(), holdings: {} };
        anchorReset = true;
      }
    }

    // 2. spot
    const spots: Record<string, string> = {};
    const spotTimes: Record<string, number> = {};
    try {
      const markets = await indexer.markets();
      for (const market of markets) {
        if (market.spot === null || market.spot.decimals !== 6) continue;
        spots[market.ticker] = market.spot.raw;
        // Paired by the API schema: a market with a spot has a spotUpdatedAt. The guard keeps the
        // observation time out of the payload rather than inventing one if that ever stops holding.
        if (market.spotUpdatedAt !== null) spotTimes[market.ticker] = market.spotUpdatedAt;
      }
      // The API's ticker list, for the price-alert check (markets.ts). Only a successful read
      // replaces it, so an outage leaves the last list standing instead of emptying the cache.
      this.deps.markets?.set(markets.map((market) => market.ticker), now);
    } catch (error) {
      logger.warn({ code: codeOf(error) }, 'market spots unavailable; continuing receipt rules');
    }

    // 3. activity
    let cursor: Cursor = stored.cursor ?? { since: floor, seen: {}, resume: null };
    if (cursor.since < floor) {
      // Storm guard on restart: jump to now − maxAge; what lies before it would be skipped anyway.
      const resume = cursor.resume !== null && cursor.resume.since >= floor - o.lookbackS ? cursor.resume : null;
      cursor = { since: floor, seen: cursor.seen, resume };
    }
    const querySince = cursor.resume?.since ?? Math.max(0, cursor.since - o.lookbackS);
    let pageCursor: string | null = cursor.resume?.cursor ?? null;
    let resume: Cursor['resume'] = null;
    const fetched: ActivityItem[] = [];
    for (let page = 1; ; page += 1) {
      const result = await indexer.activity({ since: querySince, cursor: pageCursor, limit: o.pageLimit });
      fetched.push(...result.items);
      if (result.nextCursor === null) break;
      if (page >= o.maxPages) {
        resume = { since: querySince, cursor: result.nextCursor };
        break;
      }
      pageCursor = result.nextCursor;
    }

    const seen = { ...cursor.seen };
    let since = cursor.since;
    const fresh: ActivityItem[] = [];
    let items = 0;
    let stale = 0;
    const ordered = fetched
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.ts - b.item.ts || a.index - b.index)
      .map(({ item }) => item);
    for (const item of ordered) {
      // Before the window asked for: not something the feed should have returned.
      if (item.ts < querySince || item.id in seen) continue;
      seen[item.id] = item.ts;
      items += 1;
      since = Math.max(since, item.ts);
      if (item.ts < floor) {
        stale += 1;
        continue;
      }
      fresh.push(item);
    }
    for (const [id, ts] of Object.entries(seen)) {
      if (ts < since - o.lookbackS) delete seen[id];
    }

    // 4. holdings of the watch set
    const holdings: Record<string, Holdings> = {};
    for (const address of watch.addresses) {
      const h = before.holdings[address];
      if (h !== undefined) holdings[address] = h;
    }
    for (const address of this.holdingsRetry.keys()) if (!watch.addresses.has(address)) this.holdingsRetry.delete(address);
    const urgent = new Set<string>();
    for (const item of fresh) {
      if (item.kind === 'settlement') {
        for (const [address, h] of Object.entries(holdings)) {
          if (h.longs.some((l) => l.series.longId === item.longId) || h.shorts.some((s) => s.series.longId === item.longId)) {
            urgent.add(address);
          }
        }
      } else {
        for (const account of item.accounts) if (watch.addresses.has(account)) urgent.add(account);
      }
    }
    const due: string[] = [];
    for (const address of watch.addresses) {
      const h = holdings[address];
      if (!urgent.has(address) && (h === undefined || now - h.fetchedAt >= o.holdingsRefreshS)) due.push(address);
    }
    // The last attempt, rather than fetchedAt alone, orders failures behind wallets that have
    // waited longer. This also rotates first reads through a large newly watched set.
    const waitSince = (address: string): number => this.holdingsRetry.get(address)?.lastAttemptAt ?? holdings[address]?.fetchedAt ?? -1;
    const eligible = (address: string): boolean => (this.holdingsRetry.get(address)?.retryAt ?? 0) <= now;
    const byWait = (a: string, b: string): number => waitSince(a) - waitSince(b) || a.localeCompare(b);
    const refresh = [...urgent].filter(eligible).sort(byWait);
    refresh.push(...due.filter(eligible).sort(byWait));
    refresh.length = Math.min(refresh.length, Math.max(0, o.maxRefreshPerTick));

    const changed: Record<string, Holdings> = {};
    let refreshed = 0;
    const refreshFailures: Record<string, number> = {};
    await forEachLimit(refresh, o.refreshConcurrency, async (address) => {
      try {
        const positions = await indexer.positions(address);
        const next = holdingsFrom(positions, before.holdings[address], now);
        holdings[address] = next;
        changed[address] = next;
        this.holdingsRetry.delete(address);
        refreshed += 1;
      } catch (error) {
        const code = codeOf(error);
        refreshFailures[code] = (refreshFailures[code] ?? 0) + 1;
        const attempts = (this.holdingsRetry.get(address)?.attempts ?? 0) + 1;
        const baseS = Math.max(1, Math.ceil(o.pollMs / 1000), o.holdingsRefreshS);
        const capS = Math.max(baseS, Math.ceil(o.maxBackoffMs / 1000), o.holdingsRefreshS * 6);
        this.holdingsRetry.set(address, {
          attempts, lastAttemptAt: now,
          retryAt: now + Math.min(capS, baseS * 2 ** Math.min(attempts - 1, 20)),
        });
      }
    });
    const refreshFailed = Object.values(refreshFailures).reduce((a, b) => a + b, 0);

    // 5. settlements of longs the watch set holds, for the worthless-long receipt only
    const heldLongs = new Set<string>();
    for (const h of Object.values(holdings)) for (const l of h.longs) heldLongs.add(l.series.longId);
    const settlements: Record<string, SettlementInfo> = {};
    // Past the storm guard the receipt can no longer fire, so the settlement is dropped.
    for (const [longId, info] of Object.entries(before.settlements)) {
      if (heldLongs.has(longId) && now - info.finalizedAt <= o.maxAgeS) settlements[longId] = info;
    }
    for (const item of fresh) {
      if (item.kind === 'settlement' && heldLongs.has(item.longId)) {
        settlements[item.longId] = { price: item.data.price.raw, longPayoutPerUnit: item.data.longPayoutPerUnit.raw, finalizedAt: item.ts };
      }
    }
    // The fallback, where rules.ts settledWorthless can still fire: a long seen settled now and not
    // before, with no settlement item seen. Failed transitions remain retryable after restart.
    const needed = new Set<string>();
    for (const [address, h] of Object.entries(holdings)) {
      for (const l of h.longs) {
        if (l.series.status !== 'settled' || settlements[l.series.longId] !== undefined) continue;
        const was = before.holdings[address]?.longs.find((x) => x.series.longId === l.series.longId);
        if (was === undefined || was.series.status !== 'settled') needed.add(l.series.longId);
      }
    }
    const seriesErrors: Record<string, number> = {};
    const failedSeries = new Set<string>();
    await forEachLimit([...needed].sort(), o.refreshConcurrency, async (longId) => {
      try {
        const detail = await indexer.series(longId);
        const s = detail.settlement;
        if (s?.status === 'Finalized' && s.price !== null && s.longPayoutPerUnit !== null && s.finalizedAt !== null) {
          settlements[longId] = { price: s.price.raw, longPayoutPerUnit: s.longPayoutPerUnit.raw, finalizedAt: s.finalizedAt };
        } else {
          // The positions route can expose "settled" before its detail route has the final
          // payout. Preserve a retryable transition rather than losing a worthless receipt.
          failedSeries.add(longId);
        }
      } catch (error) {
        const code = codeOf(error);
        seriesErrors[code] = (seriesErrors[code] ?? 0) + 1;
        failedSeries.add(longId);
      }
    });
    if (Object.keys(seriesErrors).length > 0) logger.warn({ errors: seriesErrors }, 'series fallback unavailable');
    // Keep the latest positions for this tick, but persist failed long transitions as "held".
    // A later periodic positions refresh will see "settled" again and retry the fallback, even
    // if the notifier restarted between the two ticks.
    for (const [address, h] of Object.entries(changed)) {
      if (!h.longs.some((long) => failedSeries.has(long.series.longId))) continue;
      changed[address] = {
        ...h,
        longs: h.longs.map((long) => failedSeries.has(long.series.longId)
          ? { ...long, series: { ...long.series, status: 'held' as const } }
          : long),
      };
    }

    // 6. session days after the expiry of each watched active strategy's current series
    const afterDays = new Set<number>();
    for (const h of Object.values(holdings)) {
      for (const s of h.strategies) {
        if (s.active && s.currentSeries !== null && now >= s.currentSeries.expiry) afterDays.add(dayIndexOf(s.currentSeries.expiry));
      }
    }
    const calendar = await this.sessionDaysAfter([...afterDays], now);

    // 7. rules
    const after = deriveState(before, {
      at: now, spots, spotTimes, alerts: watch.alerts, settlements, holdings,
      sessionDays: calendar.sessionDays, pendingFeesEffectiveAt, liveFeesKey: liveKey, adminOperations,
    });
    const requests: EnqueueRequest[] = [];
    for (const item of fresh) requests.push(...eventRules(item, before, after));
    requests.push(...stateRules(before, after, watch.addresses));

    // 8. enqueue
    const result: TickResult = {
      items,
      stale,
      refreshed,
      refreshFailed,
      calendarRead: calendar.read,
      calendarFailed: calendar.failed,
      requests: 0,
      queued: 0,
      duplicates: 0,
      filtered: 0,
      invalid: 0,
      byKind: {},
    };
    for (const r of requests) {
      if (!watch.addresses.has(r.address)) continue;
      result.requests += 1;
      try {
        const outcome = await this.deps.enqueue(r.kind, r.address, r.payload, r.dedupeKey);
        result.queued += outcome.queued;
        result.duplicates += outcome.duplicates;
        result.filtered += outcome.filtered;
        if (outcome.queued > 0) result.byKind[r.kind] = (result.byKind[r.kind] ?? 0) + outcome.queued;
      } catch (error) {
        if (!(error instanceof EnqueueError)) throw error;
        result.invalid += 1;
        logger.error({ kind: r.kind, issues: error.issues.length }, 'rules produced a payload enqueue refused');
      }
    }

    // 9. persist
    const snapshot: SnapshotState = {
      at: after.at,
      spots: after.spots,
      spotTimes: after.spotTimes,
      alerts: after.alerts,
      strikeSides: after.strikeSides,
      alertStates: after.alertStates,
      settlements: after.settlements,
      sessionDays: after.sessionDays,
      // The fee and admin-operation fields are what the NEXT tick compares against: fee_notice fires
      // on a change of pendingFeesEffectiveAt/liveFeesKey and admin_operation on a change of status.
      // Omitting them here persisted the schema defaults instead, so every restart re-announced a
      // scheduled fee change and lost the pending operations it had already told the subscriber about.
      pendingFeesEffectiveAt: after.pendingFeesEffectiveAt,
      liveFeesKey: after.liveFeesKey,
      adminOperations: after.adminOperations,
    };
    await saveState(db, {
      cursor: { since, seen, resume },
      snapshot,
      changedHoldings: changed,
      watched: watch.addresses,
      now: nowDate,
      anchor: observedAnchor,
      clearHoldings: anchorReset,
    });

    if (items > 0 || result.requests > 0 || refreshFailed > 0 || calendar.failed > 0 || result.invalid > 0) {
      logger.info(
        {
          items,
          stale,
          watched: watch.addresses.size,
          refreshed,
          refreshFailed,
          ...(refreshFailed > 0 ? { refreshErrors: refreshFailures } : {}),
          ...(calendar.failed > 0 ? { calendarErrors: calendar.errors } : {}),
          requests: result.requests,
          queued: result.queued,
          duplicates: result.duplicates,
          filtered: result.filtered,
          invalid: result.invalid,
          byKind: result.byKind,
          resumed: resume !== null,
        },
        'rules tick',
      );
    }
    return result;
  }

  /**
   * isSessionDay for the days after each of `afterDays`, up to and including the first session
   * day (or the first day the calendar does not answer for), from blocks cached for
   * calendarRefreshS. A block that cannot be read is tried once per tick; its stale copy, if any,
   * is used meanwhile.
   */
  private async sessionDaysAfter(
    afterDays: number[],
    now: number,
  ): Promise<{ sessionDays: Record<string, boolean>; read: number; failed: number; errors: Record<string, number> }> {
    const sessionDays: Record<string, boolean> = {};
    const errors: Record<string, number> = {};
    const tried = new Set<number>();
    let read = 0;
    let failed = 0;
    const blockOf = async (start: number): Promise<CalendarBlock | undefined> => {
      const cached = this.calendar.get(start);
      if ((cached !== undefined && now - cached.fetchedAt < this.options.calendarRefreshS) || tried.has(start)) return cached;
      tried.add(start);
      const toDay = start + CALENDAR_MAX_DAYS - 1;
      try {
        const response = await this.deps.indexer.calendar(start, toDay);
        const days = new Map<number, boolean>();
        for (const item of response.items) if (item.dayIndex >= start && item.dayIndex <= toDay) days.set(item.dayIndex, item.isSessionDay);
        const block = { fetchedAt: now, days };
        this.calendar.set(start, block);
        read += 1;
        return block;
      } catch (error) {
        const code = codeOf(error);
        errors[code] = (errors[code] ?? 0) + 1;
        failed += 1;
        return cached;
      }
    };
    for (const afterDay of [...afterDays].sort((a, b) => a - b)) {
      for (let day = afterDay + 1; day <= afterDay + SESSION_SCAN_DAYS; day += 1) {
        const isSession = (await blockOf(calendarBlockOf(day)))?.days.get(day);
        if (isSession === undefined) break;
        sessionDays[String(day)] = isSession;
        if (isSession) break;
      }
    }
    return { sessionDays, read, failed, errors };
  }

  /** Start the polling loop. Returns at once; the first tick runs immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.options.pollMs;
      try {
        await this.runOnce();
        this.failures = 0;
        this.lastSuccessAt = Math.floor(this.deps.now().getTime() / 1000);
      } catch (error) {
        this.failures += 1;
        delay = backoffMs(this.failures, this.options.pollMs, this.options.maxBackoffMs);
        this.deps.logger.warn(
          {
            ...(error instanceof IndexerError ? { route: error.route } : {}),
            errorCode: codeOf(error),
            failures: this.failures,
            retryInMs: delay,
          },
          'rules tick failed',
        );
      }
      if (!this.running) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, delay);
        const self = this;
        function done() {
          clearTimeout(timer);
          if (self.wake === done) self.wake = null;
          resolve();
        }
        this.wake = done;
      });
    }
  }
}
