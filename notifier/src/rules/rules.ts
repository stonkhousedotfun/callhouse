/**
 * The rules: pure functions from (before, after) snapshots, and from activity items, to enqueue
 * requests with deterministic dedupe keys. No I/O, no clock: `after.at` is the time.
 *
 * | kind                     | trigger                                                          | to                      | dedupe bucket (key = kind:address:seriesId:bucket)   |
 * |--------------------------|------------------------------------------------------------------|-------------------------|------------------------------------------------------|
 * | fill_receipt             | a `fill` item                                                    | taker, maker, recipient | `<item id>-<role>`, role = taker, maker, recipient   |
 * | strike_cross             | spot crosses a held series' strike past a 0.25 % band            | long and short holders  | `<position>-<above|below>-<NY date>`                 |
 * | price_alert              | spot at or beyond a subscriber's above/below level               | that subscriber         | seriesId = ticker, `<direction>-<level>-<NY date>`   |
 * | expiry_24h, expiry_1h    | a held series enters (23 h, 24 h] / (45 min, 60 min] to expiry   | holders                 | `<position>`; digest `kind:address:<expiry>:digest-<batch>` when >3 enter the same expiry's window, `<batch>` naming which positions are in it |
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
 *   - Price-driven payloads (strike_cross, price_alert, writer_itm_warning) carry the snapshot's
 *     `spotTimes` entry for their ticker as `spotUpdatedAt`, so the message can state when the
 *     price was observed. A ticker with no time carries none: the spot the rules act on is the
 *     on-chain one, which stops updating from about 17:00 New York on Friday, and a substituted
 *     "now" would read as a fresh price that nobody observed.
 *   - Expiry windows are narrow so the "24 hours" / "1 hour" in the message stays true: a
 *     position first seen with 10 h left gets no 24 h notice, only the 1 h one. More than 3
 *     positions of one wallet entering the same `expiry_24h` or `expiry_1h` window for the same
 *     expiry in one tick collapse to one digest (F4 D7 / N3-404): kinds unchanged, bucket `digest`,
 *     seriesId the expiry unix seconds, list capped at 10. Exactly 3 stay per-position.
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
  /** N3-404: more than this many entering one (wallet, kind, expiry) window become one digest. */
  expiryDigestAfter: 3,
  /** Digest body lists at most this many; the rest is `more`. */
  expiryDigestList: 10,
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

/**
 * When the oracle last updated `ticker`'s spot, for the message's "as of" (F4 D8). A ticker whose
 * market gave no time (a snapshot from before the field existed, a spot read that failed) yields
 * NOTHING, never a substitute: the template then omits the phrase instead of stating a time the
 * notifier does not know.
 */
function spotSeenAt(snapshot: Snapshot, ticker: string): { spotUpdatedAt?: number } {
  const at = snapshot.spotTimes[ticker];
  return at === undefined || at <= 0 ? {} : { spotUpdatedAt: at };
}

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
          {
            series: seriesPayload(p.series),
            position,
            direction: side,
            spot: usdg(spot),
            ...spotSeenAt(after, p.series.ticker),
            units: p.units,
            ...costOf(p),
          },
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
          {
            ticker: alert.ticker,
            direction: alert.direction,
            threshold: usdg(alert.threshold),
            spot: usdg(spot),
            ...spotSeenAt(after, alert.ticker),
          },
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

function expiryLine(p: Position) {
  return { series: seriesPayload(p.series), position: p.side, units: p.units, ...costOf(p) };
}

function expirySingle(kind: 'expiry_24h' | 'expiry_1h', p: Position, after: Snapshot): EnqueueRequest {
  const spot = after.spots[p.series.ticker];
  return request(
    kind,
    p.address,
    { ...expiryLine(p), ...(spot === undefined ? {} : { spot: usdg(spot) }) },
    p.series.longId,
    p.side,
  );
}

/**
 * X8-181, F-APP-OPS-06. Names WHICH positions a digest is about, so two digests for one
 * (wallet, kind, expiry) are the same delivery only when they carry the same batch.
 *
 * The bucket used to be the constant `digest`, so the key was `kind:address:<expiry>:digest` for every
 * batch of that expiry. `expiryCountdowns` only groups NEWLY-entering positions, so a later purchase
 * into an expiry the wallet already holds more than three of forms a SECOND digest with an IDENTICAL
 * key - and `delivery.enqueue`'s `ON CONFLICT (subscription_id, dedupe_key) DO NOTHING` drops it,
 * counts it as a duplicate, and returns success. The wallet is never told about the later batch and
 * nothing reports that it was not told.
 *
 * Derived from the batch's CONTENT and not from a clock, deliberately: the fact to protect is "a later
 * batch is delivered once", not "the key differs". A timestamp in the bucket would make every
 * re-evaluation of the SAME batch a fresh key and re-send the same digest, which is a worse bug than
 * the one being fixed. With the content tag, re-evaluating an identical batch produces an identical key
 * and is correctly suppressed.
 *
 * FNV-1a, 64-bit, inline: this file is documented as pure functions with no I/O, and a hash is the only
 * thing needed here, so it does not earn an import.
 */
function batchTag(group: Position[]): string {
  const ids = group.map((p) => `${p.side}:${p.series.longId}`).sort().join(',');
  const mask = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < ids.length; i += 1) {
    h = (h ^ BigInt(ids.charCodeAt(i))) & mask;
    h = (h * 0x100000001b3n) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

function expiryDigest(kind: 'expiry_24h' | 'expiry_1h', address: string, group: Position[], after: Snapshot): EnqueueRequest {
  const listed = group.slice(0, RULE_TIMING.expiryDigestList);
  const first = listed[0]!;
  const spot = after.spots[first.series.ticker];
  const more = group.length - listed.length;
  return request(
    kind,
    address,
    {
      ...expiryLine(first),
      ...(spot === undefined ? {} : { spot: usdg(spot) }),
      positions: listed.map(expiryLine),
      ...(more > 0 ? { more } : {}),
    },
    String(first.series.expiry),
    `digest-${batchTag(group)}`,
  );
}

export function expiryCountdowns(before: Snapshot, after: Snapshot): EnqueueRequest[] {
  const windows = [
    ['expiry_24h', RULE_TIMING.expiry24h],
    ['expiry_1h', RULE_TIMING.expiry1h],
  ] as const;
  type Key = `${string}:${(typeof windows)[number][0]}:${number}`;
  const groups = new Map<Key, Position[]>();
  for (const p of positionsOf(after)) {
    for (const [kind, window] of windows) {
      if (!inExpiryWindow(after.at, p.series, window)) continue;
      const was = findPosition(before, p.address, p.side, p.series.longId);
      if (was !== undefined && inExpiryWindow(before.at, was.series, window)) continue;
      const key = `${p.address}:${kind}:${p.series.expiry}` as Key;
      const list = groups.get(key);
      if (list) list.push(p);
      else groups.set(key, [p]);
    }
  }
  const out: EnqueueRequest[] = [];
  for (const [key, group] of groups) {
    const kind = key.split(':')[1] as 'expiry_24h' | 'expiry_1h';
    if (group.length <= RULE_TIMING.expiryDigestAfter) {
      for (const p of group) out.push(expirySingle(kind, p, after));
    } else {
      out.push(expiryDigest(kind, group[0]!.address, group, after));
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
        {
          series: seriesPayload(p.series),
          units: p.units,
          spot: usdg(after.spots[p.series.ticker] ?? '0'),
          ...spotSeenAt(after, p.series.ticker),
          collateralLocked: short.collateralLocked,
        },
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

/**
 * Protocol-wide fee changes. Fan-out is one request per watched address because enqueue is
 * per-wallet. An absent previous snapshot (at === 0) is not a change.
 */
export function feeNotices(before: Snapshot, after: Snapshot, watched: Iterable<string>): EnqueueRequest[] {
  if (before.at === 0) return [];
  const out: EnqueueRequest[] = [];
  const addresses = [...watched];
  if (
    before.pendingFeesEffectiveAt === null &&
    after.pendingFeesEffectiveAt !== null
  ) {
    const effectiveAt = after.pendingFeesEffectiveAt;
    for (const address of addresses) {
      out.push(request('fee_notice', address, { phase: 'scheduled', effectiveAt }, 'protocol', `scheduled-${effectiveAt}`));
    }
  }
  if (
    before.liveFeesKey !== null &&
    after.liveFeesKey !== null &&
    before.liveFeesKey !== after.liveFeesKey
  ) {
    for (const address of addresses) {
      out.push(request('fee_notice', address, { phase: 'live' }, 'protocol', `live-${after.liveFeesKey}`));
    }
  }
  return out;
}

type AdminOperationState = Snapshot['adminOperations'][string];

const ownOperation = (map: Snapshot['adminOperations'], key: string): AdminOperationState | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/**
 * T-435. What a snapshot stored before T-435 remembered about the operation now seen as `current`.
 *
 * Those snapshots keyed an operation by its bare `id`, so the first tick after the upgrade finds every
 * live operation under a key the previous tick never had. Read as new, every pending operation would
 * be announced a second time to every subscriber, and one that went pending -> executed across the
 * upgrade would say nothing at all (a first sighting that is not pending is recorded silently). The
 * id-keyed entry IS that operation's previous state - but only while exactly one current key carries
 * its id. With two, the entry cannot say which of them it described, and a repeated notice is the
 * lesser failure: silencing the other one is the defect T-435 exists to close.
 */
function legacyPrevious(before: Snapshot, after: Snapshot, current: AdminOperationState): AdminOperationState | undefined {
  if (current.id === undefined) return undefined;
  const legacy = ownOperation(before.adminOperations, current.id);
  if (legacy === undefined || legacy.id !== undefined) return undefined;
  let sharing = 0;
  for (const op of Object.values(after.adminOperations)) if (op.id === current.id) sharing += 1;
  return sharing === 1 ? legacy : undefined;
}

/**
 * AccessManager operations. Fires only when a previously seen operation changes status, or a
 * previously seen snapshot (at > 0) observes a new pending one. First boot (at === 0) records without
 * messaging.
 *
 * T-435. AN OPERATION IS ITS `key`, NEVER ITS `id`. Rescheduling reuses the id, so two pending
 * operations can share it; keyed on id, the second one found the first one's `pending` already
 * remembered and was never announced, and both collapsed into one dedupe key so a later status of
 * either could be swallowed as a duplicate of the other. Both the state lookup and the dedupe key use
 * `key`; `id` rides along in the payload for readers that name the operation.
 */
export function adminOperationNotices(before: Snapshot, after: Snapshot, watched: Iterable<string>): EnqueueRequest[] {
  if (before.at === 0) return [];
  const out: EnqueueRequest[] = [];
  const addresses = [...watched];
  for (const [key, current] of Object.entries(after.adminOperations)) {
    const previous = ownOperation(before.adminOperations, key) ?? legacyPrevious(before, after, current);
    if (previous !== undefined && previous.status === current.status) continue;
    if (previous === undefined && current.status !== 'pending') continue;
    const id = current.id ?? key;
    for (const address of addresses) {
      out.push(request('admin_operation', address, { id, key, status: current.status, label: current.label }, key, current.status));
    }
  }
  return out;
}

/**
 * X8-181, F-APP-OPS-02 and NOTE-1. Fold a read of `/v2/admin/operations` into the operations the
 * previous tick remembered, keyed by `key` (T-435: never by `id`, which a reschedule reuses).
 *
 * WHY A MERGE AND NOT A REBUILD. This used to be `adminOperations = {}` followed by a loop, so an
 * operation that was not on the page just read was ABSENT from the next snapshot rather than CHANGED -
 * and `adminOperationNotices` only fires on a status that differs from a remembered one. Paired with a
 * client that asked for the pending page alone, every operation vanished from the notifier at exactly
 * the moment it became worth telling someone about: the subscriber heard "scheduled" and never heard
 * executed or canceled, which is the half that moves protocol state.
 *
 * NOTHING HERE INFERS A STATUS FROM AN ABSENCE, and that is the point rather than an omission. An
 * operation leaves the pending page three ways, not two: executed, canceled, or EXPIRED - the route
 * filters pending on `expiresAt > indexedAt` (indexer/src/api/v2/admin.ts) while the stored status
 * stays `pending`, so an expired operation is served on no page at all. It therefore keeps its
 * remembered `pending` here and fires no notice, which is correct: there is no expired notice to send,
 * and treating the disappearance as `executed` would report a governance action that never happened.
 *
 * An entry a pre-T-435 snapshot stored under the bare `id` is dropped once an operation carrying that
 * id is read under its `key`: from then on the key entry is the state, and keeping both would leave
 * one operation remembered twice. `adminOperationNotices` reads the old entry from the previous
 * snapshot on that one tick (see legacyPrevious), so nothing it knew is lost by the drop.
 *
 * The container is null-prototype because `op.key` is server-supplied: `map[key] = x` on a plain `{}`
 * runs the `__proto__` SETTER for a key of that name instead of storing it.
 */
export function mergeAdminOperations(
  remembered: Snapshot['adminOperations'],
  ops: readonly { key: string; id: string; status: 'pending' | 'executed' | 'canceled'; label: string }[],
): Snapshot['adminOperations'] {
  const merged = Object.create(null) as Snapshot['adminOperations'];
  for (const [key, op] of Object.entries(remembered)) merged[key] = op;
  for (const op of ops) {
    const legacy = ownOperation(merged, op.id);
    if (op.id !== op.key && legacy !== undefined && legacy.id === undefined) delete merged[op.id];
    merged[op.key] = { id: op.id, status: op.status, label: op.label };
  }
  return merged;
}

export function stateRules(before: Snapshot, after: Snapshot, watched: Iterable<string> = []): EnqueueRequest[] {
  return [
    ...strikeCross(before, after),
    ...priceAlerts(before, after),
    ...expiryCountdowns(before, after),
    ...writerItmWarnings(before, after),
    ...settledWorthless(before, after),
    ...autoRollSkipped(before, after),
    ...feeNotices(before, after, watched),
    ...adminOperationNotices(before, after, watched),
  ];
}
