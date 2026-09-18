/**
 * The rules: pure functions from (before, after) snapshots, and from activity items, to enqueue
 * requests with deterministic dedupe keys. No I/O, no clock: `after.at` is the time.
 *
 * | kind                     | trigger                                                          | to                      | dedupe bucket (key = kind:address:seriesId:bucket)   |
 * |--------------------------|------------------------------------------------------------------|-------------------------|------------------------------------------------------|
 * | fill_receipt             | a `fill` item                                                    | taker, maker, recipient | `<item id>-<role>`, role = taker, maker, recipient   |
 * | strike_cross             | spot crosses a held series' strike past a 0.25 % band            | long and short holders  | `<position>-<above|below>-<NY date>`                 |
 * | price_alert              | spot at or beyond a subscriber's above/below level               | that subscriber         | seriesId = ticker, `<direction>-<level>-<NY date>`   |
 * | expiry_24h, expiry_1h    | a held series enters (23 h, 24 h] / (45 min, 60 min] to expiry   | holders                 | `<position>`                                         |
 * | writer_itm_warning       | a short is in the money on its expiry date after 09:30 New York  | short holders           | `itm`                                                |
 * | settlement_receipt       | a `redemption` item; or a held long whose series settled at 0    | holders                 | `<side>-<item id>`; worthless long `long-worthless`  |
 * | payout_failed_to_ledger  | a `redemption` item with toLedger for a holder whose pref is off | holder                  | `<item id>`                                          |
 * | auto_roll                | a `roll` item; or an active strategy not rolled 24 h after due   | writer                  | `rolled-<item id>`; `skipped` (seriesId = old series) |
 *
 * STATE RULES FIRE ON A TRANSITION between `before` and `after` (a window entered, a side flipped,
 * a series newly settled), so a condition that simply persists is not re-enqueued every tick; the
 * dedupe key is the second line of defence (a crash between enqueue and persist re-runs a tick).
 * A wallet absent from `before` (new subscriber, first boot) counts as "not before".
 *
 * DECISIONS WHERE THE TABLE IS SILENT
 *   - Strike hysteresis: spot is `above` once it reaches strike × 1.0025 and `below` once it falls
 *     to strike × 0.9975; in between the previous side stands. A series seen for the first time
 *     sets its side without a message (no crossing was observed). "Once per direction per day" is
 *     the New York date in the dedupe bucket.
 *   - Price alerts are level-triggered with re-arm: an above alert fires when spot >= level and it
 *     did not hold at the previous tick (so an alert that is already true when first seen fires
 *     once), at most once per direction and level per New York day.
 *   - Expiry windows are narrow so the "24 hours" / "1 hour" in the message stays true: a
 *     position first seen with 10 h left gets no 24 h notice, only the 1 h one.
 *   - "Inside the last trading day" is from 09:30 New York on the expiry date until expiry, and
 *     in the money is strictly beyond the strike (call: spot > strike, put: spot < strike).
 *   - A long payload's `cost` is the indexer's FIFO average cost (fees included) × units, rounded
 *     up to the base unit. A redemption's receipt needs the cost of a long the redemption burned,
 *     so it reads the holder's last-known longs; with none (never seen holding it) no receipt. Its
 *     settlement price is the redemption's own `settlementPrice` (never null on a redemption).
 *   - Receipts leave maker rebates out: a maker's sale is premium − seller fee, a bid maker's buy
 *     costs the premium. Rebates are small and paid separately; counting them would make "after
 *     fees" not add up in the message, and a cost may be overstated but never understated.
 *   - The fill's `recipient` (interface v4 OrderFilled.recipient) is the wallet the take delivered
 *     to: the longs on an ask hit, the taker's USDG proceeds on a bid hit. When it is the taker
 *     there is nothing more to say. When it is not, the taker's receipt names it, and it gets a
 *     receipt of its own under bucket `recipient`: on an ask hit a buy costing the premium (the
 *     indexer charges the taker fee to the taker's cost only when the taker is the buyer), paid by
 *     the taker; on a bid hit the proceeds, premium − seller fee − taker fee, from the taker's
 *     sale. A recipient that is also the maker gets both its maker and its recipient receipt: they
 *     are two different movements.
 *   - auto_roll `skipped`: the AutoRoller rolls only in a regular session, so a roll is due at
 *     09:30 New York on the first session day after the current series' expiry date, from the
 *     ExpiryCalendar (Snapshot.sessionDays), and the warning fires when it has not happened 24 h
 *     after that (Friday expiry: due Monday 09:30, warned Tuesday 09:30; a Monday holiday moves
 *     both a day). Until the calendar has answered for every day up to that session day the rule
 *     waits: it never counts an unknown day as a session.
 *   - Event-derived receipts older than the storm guard (6 h) are the engine's to skip; here only
 *     the holdings-derived worthless receipt checks its settlement time, because it has no item.
 */
import type { z } from 'zod';
import { dedupeKey } from '../delivery.js';
import type { EventKind, payloadSchemas } from '../events.js';
import { dayIndexOf, nextSessionDay, nyDate, sessionOpenOf, sessionOpenOfDay, type SessionDays } from './calendar.js';
import type { ActivityItem, ApiSeries, FillItem, RedemptionItem, RollItem, StaleCancelItem } from './indexer.js';
import {
  alertKey,
  holdersOf,
  type Holdings,
  type PriceAlert,
  type SeriesInfo,
  type Side,
  type Snapshot,
} from './snapshot.js';

export type RulePayloads = { [K in EventKind]: z.input<(typeof payloadSchemas)[K]> };

export type EnqueueRequest = {
  [K in EventKind]: { kind: K; address: string; payload: RulePayloads[K]; dedupeKey: string };
}[EventKind];

export const RULE_TIMING = {
  /** Storm guard: nothing is sent about an event older than this. */
  maxAgeS: 6 * 3600,
  hysteresisBps: 25n,
  expiry24h: { leadS: 24 * 3600, windowS: 3600 },
  expiry1h: { leadS: 3600, windowS: 15 * 60 },
  rollOverdueS: 24 * 3600,
} as const;

/* ------------------------------------------------------------------ helpers */

const usdg = (raw: string | bigint) => ({ raw: String(raw), decimals: 6 });

function seriesPayload(s: SeriesInfo | ApiSeries) {
  return { longId: s.longId, ticker: s.ticker, isPut: s.isPut, strike: { raw: s.strike.raw, decimals: s.strike.decimals }, expiry: s.expiry };
}

/** Average cost per share × units / 100, rounded up. */
export function longCost(avgCostPerShare: string, units: string): bigint {
  return (BigInt(avgCostPerShare) * BigInt(units) + 99n) / 100n;
}

const isLive = (s: SeriesInfo, at: number): boolean => (s.status === 'open' || s.status === 'cutoff') && at < s.expiry;

const request = <K extends EventKind>(kind: K, address: string, payload: RulePayloads[K], seriesId: string, bucket: string) =>
  ({ kind, address, payload, dedupeKey: dedupeKey(kind, address, seriesId, bucket) }) as EnqueueRequest;

interface Position {
  address: string;
  side: 'long' | 'short';
  series: SeriesInfo;
  units: string;
  /** long only */
  avgCost?: string;
}

function positionsOf(snapshot: Snapshot): Position[] {
  const out: Position[] = [];
  for (const [address, h] of Object.entries(snapshot.holdings)) {
    for (const l of h.longs) out.push({ address, side: 'long', series: l.series, units: l.units, avgCost: l.avgCost });
    for (const s of h.shorts) out.push({ address, side: 'short', series: s.series, units: s.units });
  }
  return out;
}

function findPosition(snapshot: Snapshot, address: string, side: 'long' | 'short', longId: string): Position | undefined {
  const h = snapshot.holdings[address];
  if (h === undefined) return undefined;
  if (side === 'long') {
    const l = h.longs.find((x) => x.series.longId === longId);
    return l === undefined ? undefined : { address, side, series: l.series, units: l.units, avgCost: l.avgCost };
  }
  const s = h.shorts.find((x) => x.series.longId === longId);
  return s === undefined ? undefined : { address, side, series: s.series, units: s.units };
}

const costOf = (p: Position) => (p.side === 'long' ? { cost: usdg(longCost(p.avgCost ?? '0', p.units)) } : {});

/* ------------------------------------------------------------------ derived state */

/** Which side of `strike` spot is on, with the hysteresis band; `previous` stands inside the band. */
export function strikeSide(previous: Side | undefined, spot: bigint, strike: bigint, bps: bigint = RULE_TIMING.hysteresisBps): Side | undefined {
  if (spot * 10_000n >= strike * (10_000n + bps)) return 'above';
  if (spot * 10_000n <= strike * (10_000n - bps)) return 'below';
  return previous;
}

export function alertMet(alert: PriceAlert, spot: bigint): boolean {
  return alert.direction === 'above' ? spot >= BigInt(alert.threshold) : spot <= BigInt(alert.threshold);
}

/**
 * `after` with strikeSides and alertStates derived from `before`. Sides are kept for series the
 * watch set holds and that have not expired; alert states for alerts that still exist.
 */
export function deriveState(before: Snapshot, after: Omit<Snapshot, 'strikeSides' | 'alertStates'>): Snapshot {
  const strikeSides: Snapshot['strikeSides'] = {};
  const draft: Snapshot = { ...after, strikeSides, alertStates: {} };
  for (const p of positionsOf(draft)) {
    if (!isLive(p.series, after.at) || p.series.longId in strikeSides) continue;
    const previous = before.strikeSides[p.series.longId];
    const spot = after.spots[p.series.ticker];
    const side = spot === undefined ? previous : strikeSide(previous, BigInt(spot), BigInt(p.series.strike.raw));
    if (side !== undefined) strikeSides[p.series.longId] = side;
  }
  for (const [address, alerts] of Object.entries(after.alerts)) {
    for (const alert of alerts) {
      const key = alertKey(address, alert);
      const spot = after.spots[alert.ticker];
      const met = spot === undefined ? before.alertStates[key] : alertMet(alert, BigInt(spot));
      if (met !== undefined) draft.alertStates[key] = met;
    }
  }
  return draft;
}

/* ------------------------------------------------------------------ event rules */

export function fillReceipts(item: FillItem): EnqueueRequest[] {
  const d = item.data;
  const series = seriesPayload(item.series);
  if (BigInt(d.units) === 0n) return [];
  const premium = BigInt(d.premium.raw);
  const takerFee = BigInt(d.takerFee.raw);
  const sellerFee = BigInt(d.sellerFee.raw);
  // Interface v4: where the take delivered (longs on an ask hit, USDG on a bid hit). The taker's
  // own receipt covers it when it is the taker, so the taker is never sent a second one.
  const recipient = d.recipient === d.taker ? undefined : d.recipient;
  const common = { series, units: d.units, price: usdg(d.price.raw), primary: d.primary, tx: d.tx };
  const out: EnqueueRequest[] = [];
  const bucket = (role: string) => `${item.id}-${role}`;
  // What the taker's sale into a bid pays out, to the taker or to its recipient.
  const proceeds = { side: 'sell', total: usdg(premium - sellerFee - takerFee), fee: usdg(sellerFee + takerFee) } as const;

  // The taker: bought (paid premium + taker fee), or sold into a bid (premium − seller fee − taker fee).
  out.push(
    request(
      'fill_receipt',
      d.taker,
      {
        ...common,
        ...(d.takerIsBuyer ? { side: 'buy', total: usdg(premium + takerFee), fee: usdg(takerFee) } : proceeds),
        role: 'taker',
        ...(recipient === undefined ? {} : { recipient }),
      },
      item.longId,
      bucket('taker'),
    ),
  );
  // The maker, unless it filled its own order.
  if (d.maker !== d.taker) {
    out.push(
      request(
        'fill_receipt',
        d.maker,
        d.takerIsBuyer
          ? { ...common, side: 'sell', role: 'maker', total: usdg(premium - sellerFee), fee: usdg(sellerFee) }
          : { ...common, side: 'buy', role: 'maker', total: usdg(premium), fee: usdg(0n) },
        item.longId,
        bucket('maker'),
      ),
    );
  }
  // Interface v4: the wallet the longs were bought for (ask hit), or the proceeds were paid to (bid hit).
  if (recipient !== undefined) {
    out.push(
      request(
        'fill_receipt',
        recipient,
        d.takerIsBuyer
          ? { ...common, side: 'buy', role: 'recipient', total: usdg(premium), fee: usdg(0n), payer: d.taker }
          : { ...common, ...proceeds, role: 'recipient', seller: d.taker },
        item.longId,
        bucket('recipient'),
      ),
    );
  }
  return out;
}

export function redemptionReceipts(item: RedemptionItem, after: Snapshot): EnqueueRequest[] {
  const d = item.data;
  const holdings: Holdings | undefined = after.holdings[d.holder];
  if (BigInt(d.units) === 0n) return [];
  const series = seriesPayload(item.series);
  const amount = BigInt(d.amount.raw);
  const inKind = d.asset.toLowerCase() === item.series.underlying.toLowerCase();
  const price = d.settlementPrice.raw;
  const out: EnqueueRequest[] = [];

  const payout = amount === 0n ? null : { asset: inKind ? ('stock' as const) : ('usdg' as const), amount: { raw: d.amount.raw, decimals: d.amount.decimals } };
  const payoutValue = inKind && amount > 0n ? { payoutValue: usdg((amount * BigInt(price)) / 10n ** BigInt(d.amount.decimals)) } : {};
  const base = { series, units: d.units, settlementPrice: usdg(price), payout, ...payoutValue, toLedger: d.toLedger, tx: d.tx };

  if (d.side === 'long') {
    const known = holdings?.lastKnownLongs[item.longId];
    if (known !== undefined) {
      out.push(
        request(
          'settlement_receipt',
          d.holder,
          { ...base, position: 'long', cost: usdg(longCost(known.avgCost, d.units)) },
          item.longId,
          payout === null ? 'long-worthless' : `long-${item.id}`,
        ),
      );
    }
  } else {
    out.push(request('settlement_receipt', d.holder, { ...base, position: 'short' }, item.longId, `short-${item.id}`));
  }

  if (d.toLedger && holdings !== undefined && !holdings.prefs.toLedger && payout !== null) {
    out.push(
      request('payout_failed_to_ledger', d.holder, { series, asset: payout.asset, amount: payout.amount, tx: d.tx }, item.longId, item.id),
    );
  }
  return out;
}

export function rollReceipts(item: RollItem): EnqueueRequest[] {
  const d = item.data;
  if (BigInt(d.units) === 0n) return [];
  return [
    request(
      'auto_roll',
      d.writer,
      { ticker: item.series.ticker, status: 'rolled', series: seriesPayload(item.series), price: usdg(d.price.raw), units: d.units },
      item.longId,
      `rolled-${item.id}`,
    ),
  ];
}

/**
 * INTERFACE_VERSION 7 (c16): `cancelStale` withdrew the writer's live roll ask because the spot
 * reached its strike. The writer is told once, keyed on the item so a re-read of the feed cannot
 * repeat it. This is not a failed roll: `autoRollSkipped` stays the only overdue warning, and a
 * strategy whose `orderId` is now null is still active. Nothing is said to holders: no option
 * changed hands, the ask simply stopped resting.
 */
export function staleCancelReceipts(item: StaleCancelItem): EnqueueRequest[] {
  const d = item.data;
  return [
    request(
      'auto_roll',
      d.writer,
      {
        ticker: item.series.ticker,
        status: 'withdrawn',
        series: seriesPayload(item.series),
        spot: usdg(d.spot.raw),
        spotUpdatedAt: d.spotUpdatedAt,
        nextRollAfter: d.nextRollAfter,
      },
      item.longId,
      `withdrawn-${item.id}`,
    ),
  ];
}

/** An activity item's receipts. `before` is unused today; the signature matches the state rules. */
export function eventRules(item: ActivityItem, _before: Snapshot, after: Snapshot): EnqueueRequest[] {
  switch (item.kind) {
    case 'fill':
      return fillReceipts(item);
    case 'redemption':
      return redemptionReceipts(item, after);
    case 'roll':
      return rollReceipts(item);
    case 'stale_cancel':
      return staleCancelReceipts(item);
    case 'settlement':
      // Holders of a settled series hear about it from their redemption or, for a long that
      // expired worthless and is not redeemed, from settledWorthless below.
      return [];
  }
}

/* ------------------------------------------------------------------ state rules */

export function strikeCross(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  const out: EnqueueRequest[] = [];
  const day = nyDate(after.at);
  for (const [longId, side] of Object.entries(after.strikeSides)) {
    const previous = before.strikeSides[longId];
    if (previous === undefined || previous === side) continue;
    for (const { address, side: position } of holdersOf(after, longId)) {
      const p = findPosition(after, address, position, longId);
      const spot = p === undefined ? undefined : after.spots[p.series.ticker];
      if (p === undefined || spot === undefined || !isLive(p.series, after.at)) continue;
      out.push(
        request(
          'strike_cross',
          address,
          { series: seriesPayload(p.series), position, direction: side, spot: usdg(spot), units: p.units, ...costOf(p) },
          longId,
          `${position}-${side}-${day}`,
        ),
      );
    }
  }
  return out;
}

export function priceAlerts(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  const out: EnqueueRequest[] = [];
  const day = nyDate(after.at);
  for (const [address, alerts] of Object.entries(after.alerts)) {
    for (const alert of alerts) {
      const key = alertKey(address, alert);
      const spot = after.spots[alert.ticker];
      if (spot === undefined || after.alertStates[key] !== true || before.alertStates[key] === true) continue;
      out.push(
        request(
          'price_alert',
          address,
          { ticker: alert.ticker, direction: alert.direction, threshold: usdg(alert.threshold), spot: usdg(spot) },
          alert.ticker,
          `${alert.direction}-${alert.threshold}-${day}`,
        ),
      );
    }
  }
  return out;
}

function inExpiryWindow(at: number, series: SeriesInfo, window: { leadS: number; windowS: number }): boolean {
  const remaining = series.expiry - at;
  return isLive(series, at) && remaining <= window.leadS && remaining > window.leadS - window.windowS;
}

export function expiryCountdowns(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  const out: EnqueueRequest[] = [];
  const windows = [
    ['expiry_24h', RULE_TIMING.expiry24h],
    ['expiry_1h', RULE_TIMING.expiry1h],
  ] as const;
  for (const p of positionsOf(after)) {
    for (const [kind, window] of windows) {
      if (!inExpiryWindow(after.at, p.series, window)) continue;
      const was = findPosition(before, p.address, p.side, p.series.longId);
      if (was !== undefined && inExpiryWindow(before.at, was.series, window)) continue;
      const spot = after.spots[p.series.ticker];
      out.push(
        request(
          kind,
          p.address,
          { series: seriesPayload(p.series), position: p.side, units: p.units, ...(spot === undefined ? {} : { spot: usdg(spot) }), ...costOf(p) },
          p.series.longId,
          p.side,
        ),
      );
    }
  }
  return out;
}

function writerAtRisk(snapshot: Snapshot, p: Position): boolean {
  const spot = snapshot.spots[p.series.ticker];
  if (spot === undefined || !isLive(p.series, snapshot.at) || snapshot.at < sessionOpenOf(p.series.expiry)) return false;
  const s = BigInt(spot);
  const k = BigInt(p.series.strike.raw);
  return p.series.isPut ? s < k : s > k;
}

export function writerItmWarnings(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  const out: EnqueueRequest[] = [];
  for (const p of positionsOf(after)) {
    if (p.side !== 'short' || !writerAtRisk(after, p)) continue;
    const was = findPosition(before, p.address, 'short', p.series.longId);
    if (was !== undefined && writerAtRisk(before, was)) continue;
    const short = after.holdings[p.address]?.shorts.find((s) => s.series.longId === p.series.longId);
    if (short === undefined) continue;
    out.push(
      request(
        'writer_itm_warning',
        p.address,
        { series: seriesPayload(p.series), units: p.units, spot: usdg(after.spots[p.series.ticker] ?? '0'), collateralLocked: short.collateralLocked },
        p.series.longId,
        'itm',
      ),
    );
  }
  return out;
}

export function settledWorthless(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  const out: EnqueueRequest[] = [];
  for (const p of positionsOf(after)) {
    if (p.side !== 'long' || p.series.status !== 'settled') continue;
    const settlement = after.settlements[p.series.longId];
    if (settlement === undefined || BigInt(settlement.longPayoutPerUnit) !== 0n) continue;
    if (after.at - settlement.finalizedAt > RULE_TIMING.maxAgeS) continue;
    const was = findPosition(before, p.address, 'long', p.series.longId);
    if (was !== undefined && was.series.status === 'settled') continue;
    out.push(
      request(
        'settlement_receipt',
        p.address,
        {
          series: seriesPayload(p.series),
          position: 'long',
          units: p.units,
          settlementPrice: usdg(settlement.price),
          payout: null,
          cost: usdg(longCost(p.avgCost ?? '0', p.units)),
          toLedger: after.holdings[p.address]?.prefs.toLedger ?? false,
        },
        p.series.longId,
        'long-worthless',
      ),
    );
  }
  return out;
}

type Strategy = Holdings['strategies'][number];

/**
 * When a strategy's roll falls due: 09:30 New York on the first session day after its current
 * series' expiry date. null = not rolling, nothing to roll, or the calendar has not answered yet.
 */
export function rollDueAt(strategy: Strategy, sessionDays: SessionDays): number | null {
  if (!strategy.active || strategy.currentSeries === null) return null;
  const day = nextSessionDay(dayIndexOf(strategy.currentSeries.expiry), sessionDays);
  return day === null ? null : sessionOpenOfDay(day);
}

/** When a due roll that has not happened is warned about (due + 24 h). null as for rollDueAt. */
export function rollOverdueAt(strategy: Strategy, sessionDays: SessionDays): number | null {
  const due = rollDueAt(strategy, sessionDays);
  return due === null ? null : due + RULE_TIMING.rollOverdueS;
}

export function autoRollSkipped(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  const out: EnqueueRequest[] = [];
  for (const [address, h] of Object.entries(after.holdings)) {
    for (const strategy of h.strategies) {
      const dueAt = rollDueAt(strategy, after.sessionDays);
      if (dueAt === null || strategy.currentSeries === null || after.at <= dueAt + RULE_TIMING.rollOverdueS) continue;
      const was = before.holdings[address]?.strategies.find(
        (s) => s.ticker === strategy.ticker && s.currentSeries?.longId === strategy.currentSeries?.longId,
      );
      // Each snapshot by its own calendar: a tick that could not read the days did not know it was
      // overdue, so the warning comes on the first tick that does (late, never lost). A holiday
      // set between two ticks can at worst repeat a request, which the dedupe key absorbs.
      const wasOverdueAt = was === undefined ? null : rollOverdueAt(was, before.sessionDays);
      if (wasOverdueAt !== null && before.at > wasOverdueAt) continue;
      out.push(
        request(
          'auto_roll',
          address,
          {
            ticker: strategy.ticker,
            status: 'skipped',
            dueAt,
            ...(strategy.lastRolledAt !== null && strategy.lastRolledAt > 0 ? { lastRolledAt: strategy.lastRolledAt } : {}),
          },
          strategy.currentSeries.longId,
          'skipped',
        ),
      );
    }
  }
  return out;
}

export function stateRules(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  return [
    ...strikeCross(before, after),
    ...priceAlerts(before, after),
    ...expiryCountdowns(before, after),
    ...writerItmWarnings(before, after),
    ...settledWorthless(before, after),
    ...autoRollSkipped(before, after),
  ];
}
