/**
 * The rules as pure functions over before/after snapshots and activity items.
 *
 * WHAT IS PINNED:
 *   - fill_receipt for taker and maker, and for the v4 `data.recipient` when it is not the taker:
 *     the longs of an ask hit, the USDG proceeds of a bid hit, never a second receipt to a taker
 *     that is its own recipient; self-fills; totals and fees as the messages state them;
 *   - strike_cross hysteresis (0.25 % both ways), long and short holders, once per direction per
 *     New York day (the dedupe bucket);
 *   - price_alert level-triggered with re-arm, once per direction and level per day;
 *   - expiry_24h / expiry_1h windows fire once, on entry;
 *   - writer_itm_warning only for shorts, only in the money, only inside the last trading day;
 *   - settlement_receipt from a redemption (USDG, in kind, worthless, short) priced by the
 *     redemption's own settlementPrice, and for a long that settled worthless without one, with the
 *     same key so the two paths never double up; the worthless wording; the storm guard on
 *     settlement time;
 *   - payout_failed_to_ledger with and without the ledger pref;
 *   - auto_roll rolled, and skipped only after a roll has been due for more than 24 h, due at the
 *     first ExpiryCalendar session day after expiry (a Friday holiday, Thanksgiving week, a Monday
 *     holiday), never before the calendar has answered; the lastRolledAt and due wording;
 *   - every request validates against events.ts, renders, and carries a key enqueue accepts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUnits } from 'viem';
import { dedupeKey } from '../delivery.js';
import { parsePayload } from '../events.js';
import { appLinks, render } from '../templates.js';
import { dayIndexOf, nextSessionDay, nyDate, nyWallTime, SESSION_SCAN_DAYS, sessionOpenOf, sessionOpenOfDay, type SessionDays } from './calendar.js';
import type { ApiSeries, FillItem, RedemptionItem, RollItem, StaleCancelItem } from './indexer.js';
import {
  alertMet,
  autoRollSkipped,
  deriveState,
  eventRules,
  expiryCountdowns,
  fillReceipts,
  longCost,
  priceAlerts,
  redemptionReceipts,
  rollDueAt,
  rollReceipts,
  settledWorthless,
  staleCancelReceipts,
  stateRules,
  strikeCross,
  strikeSide,
  writerItmWarnings,
  type EnqueueRequest,
} from './rules.js';
import { emptySnapshot, holdingsFrom, seriesInfo, type Holdings, type PriceAlert, type SettlementInfo, type Snapshot } from './snapshot.js';

const links = appLinks('https://app.stonkhouse.test');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ALICE = '0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';
const BOB = '0x4088c59Eb3fB713B124f182E7083AEb3358A030B';
const CAROL = '0x300a7AB2f92B536e3f58422372c964B2Bb535ea2';
const TX = `0x${'ab'.repeat(32)}`;

const money = (raw: string | bigint, decimals = 6) => ({ raw: String(raw), decimals, formatted: formatUnits(BigInt(raw), decimals) });

/** Fri 25 Sep 2026 16:00 New York. */
const EXPIRY = 1790366400;
const HOUR = 3600;

function apiSeries(o: Partial<ApiSeries> = {}): ApiSeries {
  return {
    longId: '29578741721805883636096061263188069692265858688783836537835344212255512771642',
    shortId: '29578741721805883636096061263188069692265858688783836537835344212255512771643',
    ticker: 'NVDA',
    underlying: NVDA,
    isPut: false,
    strike: money('221000000'),
    expiry: EXPIRY,
    tenor: 'weekly',
    mintCutoff: EXPIRY - 1800,
    status: 'open',
    ...o,
  };
}

const S221 = apiSeries();
const S216 = apiSeries({
  longId: '97249294176823841346447828561188452006185490110924851379129375223985952864952',
  shortId: '97249294176823841346447828561188452006185490110924851379129375223985952864953',
  strike: money('216000000'),
  expiry: 1789156800,
  mintCutoff: 1789155000,
  status: 'settled',
});

function holdings(o: {
  longs?: { series: ApiSeries; units: string; avgCost: string }[];
  shorts?: { series: ApiSeries; units: string; collateral?: string }[];
  strategies?: { ticker: string; active: boolean; currentSeries: ApiSeries | null; lastRolledAt?: number | null }[];
  toLedger?: boolean;
  at?: number;
  previous?: Holdings;
}): Holdings {
  return holdingsFrom(
    {
      longs: (o.longs ?? []).map((l) => ({ series: l.series, units: l.units, avgCost: money(l.avgCost) })),
      shorts: (o.shorts ?? []).map((s) => ({ series: s.series, units: s.units, collateralLocked: money(s.collateral ?? '500000000000000000', 18) })),
      strategies: (o.strategies ?? []).map((s) => ({ ticker: s.ticker, strategy: { active: s.active }, currentSeries: s.currentSeries, lastRolledAt: s.lastRolledAt ?? null })),
      prefs: { inKind: false, toLedger: o.toLedger ?? false },
    },
    o.previous,
    o.at ?? 0,
  );
}

function tick(
  before: Snapshot,
  a: {
    at: number;
    spots?: Record<string, string>;
    holdings?: Record<string, Holdings>;
    alerts?: Record<string, PriceAlert[]>;
    settlements?: Record<string, SettlementInfo>;
    sessionDays?: SessionDays;
  },
): Snapshot {
  return deriveState(before, {
    at: a.at,
    spots: a.spots ?? {},
    alerts: a.alerts ?? {},
    settlements: a.settlements ?? {},
    holdings: a.holdings ?? {},
    sessionDays: a.sessionDays ?? {},
  });
}

const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** What GET /v2/calendar/holidays answers for [from, to]: weekdays that are not `holidays`. */
function calendarDays(from: string, to: string, holidays: string[] = []): SessionDays {
  const out: Record<string, boolean> = {};
  const off = new Set(holidays.map(dayOf));
  for (let day = dayOf(from); day <= dayOf(to); day += 1) {
    const weekday = new Date(day * 86_400_000).getUTCDay();
    out[String(day)] = weekday !== 0 && weekday !== 6 && !off.has(day);
  }
  return out;
}

/** Every request must be something enqueue accepts and a template renders. */
function check(requests: EnqueueRequest[]): EnqueueRequest[] {
  for (const r of requests) {
    const parsed = parsePayload(r.kind, r.payload);
    assert.ok(parsed.ok, `${r.kind}: ${parsed.ok ? '' : parsed.issues.join('; ')}`);
    assert.match(r.dedupeKey, /^[\x21-\x7e]{1,256}$/);
    assert.ok(r.dedupeKey.startsWith(`${r.kind}:${r.address}:`), r.dedupeKey);
    const message = render(parsed.event, links);
    assert.ok(message.title.length > 0 && message.body.length > 0);
  }
  return requests;
}

function rendered(r: EnqueueRequest) {
  const parsed = parsePayload(r.kind, r.payload);
  assert.ok(parsed.ok);
  return render(parsed.event, links);
}

/* ------------------------------------------------------------------ fills */

function fill(o: Partial<FillItem['data']> & { accounts?: string[]; id?: string } = {}): FillItem {
  const { accounts, id, ...data } = o;
  const d: FillItem['data'] = {
    orderId: '1007',
    taker: BOB,
    maker: CAROL,
    recipient: data.taker ?? BOB,
    units: '50',
    price: money('3600000'),
    premium: money('1800000'),
    takerFee: money('100000'),
    sellerFee: money('90000'),
    makerRebate: money('50000'),
    primary: true,
    takerIsBuyer: true,
    tx: TX,
    ...data,
  };
  return {
    id: id ?? `${TX}-3`,
    kind: 'fill',
    ts: EXPIRY - 5 * 24 * HOUR,
    longId: S221.longId,
    series: S221,
    accounts: accounts ?? [...new Set([d.taker, d.maker, d.recipient])],
    data: d,
  };
}

const payloadOf = (r: EnqueueRequest | undefined) => r?.payload as Record<string, unknown> & { side: string; role: string; total: { raw: string }; fee: { raw: string } };

test('fill_receipt: the taker bought (premium + taker fee), the maker sold (premium − seller fee)', () => {
  const [taker, maker, ...rest] = check(fillReceipts(fill()));
  assert.equal(rest.length, 0);
  assert.deepEqual(
    [taker?.address, taker?.dedupeKey, maker?.address, maker?.dedupeKey],
    [BOB, `fill_receipt:${BOB}:${S221.longId}:${TX}-3-taker`, CAROL, `fill_receipt:${CAROL}:${S221.longId}:${TX}-3-maker`],
  );
  assert.equal(rendered(taker!).body.split('\n')[1], 'Cost: 1.90 USDG, including 0.10 USDG in fees. Max loss: 1.90 USDG.');
  assert.equal(rendered(maker!).title, 'Sold NVDA 221.00 call');
  assert.equal(rendered(maker!).body.split('\n')[1], 'Received: 1.71 USDG, after 0.09 USDG in fees.');
  assert.match(rendered(maker!).body, /^You wrote and sold 0\.50 shares/);
});

test('fill_receipt: an ask hit’s recipient that is not the taker gets its own receipt, and the taker’s names it (interface v4)', () => {
  const requests = check(fillReceipts(fill({ recipient: ALICE })));
  assert.deepEqual(requests.map((r) => [r.address, r.dedupeKey.split(':').at(-1)]), [
    [BOB, `${TX}-3-taker`],
    [CAROL, `${TX}-3-maker`],
    [ALICE, `${TX}-3-recipient`],
  ]);
  const [taker, , recipient] = requests;
  assert.deepEqual((recipient?.payload as { role: string; payer: string; total: { raw: string }; fee: { raw: string } }), {
    ...(recipient?.payload as object),
    role: 'recipient',
    payer: BOB,
    total: { raw: '1800000', decimals: 6 },
    fee: { raw: '0', decimals: 6 },
  });
  const toAlice = rendered(recipient!);
  assert.equal(toAlice.title, 'Received NVDA 221.00 call');
  assert.equal(
    toAlice.body,
    [
      'Wallet 0x4088…030B bought 0.50 shares of the NVDA 221.00 call expiring Fri 25 Sep, 4:00pm EDT for your wallet, at 3.60 USDG per share.',
      'Cost: 1.80 USDG, paid by 0x4088…030B. Max loss: 1.80 USDG.',
      'It pays out only if NVDA settles above 221.00 USDG at expiry.',
    ].join('\n'),
  );
  const fromBob = rendered(taker!);
  assert.equal(fromBob.title, 'Bought NVDA 221.00 call for 0xE378…8De3');
  assert.match(fromBob.body, /for wallet 0xE378…8De3, at 3\.60 USDG per share\.\nCost: 1\.90 USDG, including 0\.10 USDG in fees\. Max loss: 1\.90 USDG\./);
  assert.match(fromBob.body, /any payout goes to that wallet/);
});

test('fill_receipt: a bid hit the taker is paid for itself (taker sells, maker buys); a self-fill; accounts are not read for a recipient', () => {
  // The taker is its own recipient: two receipts, never a second one to the taker, even with a
  // third wallet in accounts (only data.recipient names a recipient since interface v4).
  const bid = check(fillReceipts(fill({ takerIsBuyer: false, accounts: [BOB, CAROL, ALICE] })));
  assert.deepEqual(
    bid.map((r) => [r.address, payloadOf(r).role, payloadOf(r).side, payloadOf(r).total.raw, payloadOf(r).fee.raw, payloadOf(r).recipient]),
    [
      [BOB, 'taker', 'sell', String(1_800_000 - 90_000 - 100_000), String(90_000 + 100_000), undefined],
      [CAROL, 'maker', 'buy', '1800000', '0', undefined],
    ],
  );
  assert.equal(rendered(bid[0]!).title, 'Sold NVDA 221.00 call');
  assert.equal(rendered(bid[0]!).body.split('\n')[1], 'Received: 1.61 USDG, after 0.19 USDG in fees.');
  const self = check(fillReceipts(fill({ maker: BOB })));
  assert.deepEqual(self.map((r) => r.address), [BOB]);
  assert.deepEqual(check(fillReceipts(fill({ units: '0' }))), []);
});

test('fill_receipt: a sale into a bid paid to another wallet: the recipient gets the proceeds receipt, the taker’s names it (interface v4)', () => {
  const item = fill({ takerIsBuyer: false, recipient: ALICE });
  assert.deepEqual(item.accounts, [BOB, CAROL, ALICE]);
  const requests = check(fillReceipts(item));
  assert.deepEqual(
    requests.map((r) => [r.address, r.dedupeKey.split(':').at(-1), payloadOf(r).role, payloadOf(r).side, payloadOf(r).total.raw, payloadOf(r).fee.raw]),
    [
      [BOB, `${TX}-3-taker`, 'taker', 'sell', '1610000', '190000'],
      [CAROL, `${TX}-3-maker`, 'maker', 'buy', '1800000', '0'],
      [ALICE, `${TX}-3-recipient`, 'recipient', 'sell', '1610000', '190000'],
    ],
  );
  const [taker, , recipient] = requests;
  assert.equal(payloadOf(taker).recipient, ALICE);
  assert.equal(payloadOf(recipient).seller, BOB);
  assert.equal(payloadOf(recipient).payer, undefined);

  const toAlice = rendered(recipient!);
  assert.equal(toAlice.title, 'Received sale proceeds: NVDA 221.00 call');
  assert.equal(
    toAlice.body,
    [
      'Wallet 0x4088…030B sold 0.50 shares of the NVDA 221.00 call expiring Fri 25 Sep, 4:00pm EDT, at 3.60 USDG per share, and the proceeds were paid to your wallet.',
      'Received: 1.61 USDG, after 0.19 USDG in fees.',
    ].join('\n'),
  );
  assert.doesNotMatch(toAlice.body, /Max loss|collateral/, 'the recipient holds no position');

  const fromBob = rendered(taker!);
  assert.equal(fromBob.title, 'Sold NVDA 221.00 call, proceeds to 0xE378…8De3');
  assert.equal(
    fromBob.body,
    [
      'You wrote and sold 0.50 shares of the NVDA 221.00 call expiring Fri 25 Sep, 4:00pm EDT, at 3.60 USDG per share.',
      'Proceeds: 1.61 USDG, after 0.19 USDG in fees, paid to wallet 0xE378…8De3.',
      'Your collateral backs these options until they settle. If NVDA settles above 221.00 USDG, holders are paid from it.',
    ].join('\n'),
  );

  // Deterministic: the same item gives the same keys; a resale into a bid reads without collateral.
  assert.deepEqual(fillReceipts(item).map((r) => r.dedupeKey), requests.map((r) => r.dedupeKey));
  const resale = check(fillReceipts(fill({ takerIsBuyer: false, recipient: ALICE, primary: false, sellerFee: money('0') })));
  assert.equal(rendered(resale[0]!).body.split('\n').length, 2);
  // A recipient that is the maker: its maker receipt (it bought) and its proceeds receipt, two keys.
  const toMaker = check(fillReceipts(fill({ takerIsBuyer: false, recipient: CAROL })));
  assert.deepEqual(toMaker.map((r) => [r.address, payloadOf(r).role]), [[BOB, 'taker'], [CAROL, 'maker'], [CAROL, 'recipient']]);
  // A self-fill paid to another wallet: the taker and the recipient, no maker receipt.
  assert.deepEqual(check(fillReceipts(fill({ takerIsBuyer: false, maker: BOB, recipient: ALICE }))).map((r) => [r.address, payloadOf(r).role]), [[BOB, 'taker'], [ALICE, 'recipient']]);
});

/* ------------------------------------------------------------------ strike cross */

test('strike_cross: 0.25 % hysteresis both ways, long and short holders, once per direction per New York day', () => {
  const day1 = Date.parse('2026-09-22T14:00:00Z') / 1000; // Tue 10:00 EDT
  const held = {
    [ALICE]: holdings({ longs: [{ series: S221, units: '50', avgCost: '3800000' }] }),
    [BOB]: holdings({ shorts: [{ series: S221, units: '50' }] }),
  };
  const at = (spot: string, t: number, before: Snapshot) => tick(before, { at: t, spots: { NVDA: spot }, holdings: held });

  const s0 = at('220000000', day1, emptySnapshot());
  assert.equal(s0.strikeSides[S221.longId], 'below');
  assert.deepEqual(strikeCross(emptySnapshot(), s0), [], 'a first observation is not a crossing');

  const s1 = at('221400000', day1 + 30, s0); // +0.18 %: inside the band
  assert.equal(s1.strikeSides[S221.longId], 'below');
  assert.deepEqual(strikeCross(s0, s1), []);

  const s2 = at('221552500', day1 + 60, s1); // exactly strike × 1.0025
  const up = check(strikeCross(s1, s2));
  assert.deepEqual(up.map((r) => [r.address, (r.payload as { position: string }).position, (r.payload as { direction: string }).direction]), [
    [ALICE, 'long', 'above'],
    [BOB, 'short', 'above'],
  ]);
  assert.equal(up[0]?.dedupeKey, `strike_cross:${ALICE}:${S221.longId}:long-above-2026-09-22`);
  assert.deepEqual((up[0]?.payload as { cost: unknown }).cost, { raw: '1900000', decimals: 6 });
  assert.match(rendered(up[0]!).body, /Cost: 1\.90 USDG\. Max loss: 1\.90 USDG\./);

  const s3 = at('220600000', day1 + 90, s2); // −0.18 %: still above
  assert.deepEqual(strikeCross(s2, s3), []);
  assert.equal(s3.strikeSides[S221.longId], 'above');

  const s4 = at('220447500', day1 + 120, s3); // exactly strike × 0.9975
  const down = check(strikeCross(s3, s4));
  assert.deepEqual(down.map((r) => (r.payload as { direction: string }).direction), ['below', 'below']);
  assert.equal(down[1]?.dedupeKey, `strike_cross:${BOB}:${S221.longId}:short-below-2026-09-22`);

  // Above again the same New York day: the same key, so delivery sends it once.
  const s5 = at('222000000', day1 + 3 * HOUR, s4);
  assert.deepEqual(check(strikeCross(s4, s5)).map((r) => r.dedupeKey), up.map((r) => r.dedupeKey));
  // The next day it is a new event.
  const s6 = at('220000000', day1 + 20 * HOUR, s5);
  const s7 = at('222000000', day1 + 21 * HOUR, s6);
  assert.equal(check(strikeCross(s6, s7))[0]?.dedupeKey, `strike_cross:${ALICE}:${S221.longId}:long-above-2026-09-23`);

  // Nothing after expiry, and nothing without a spot.
  assert.deepEqual(strikeCross(s4, at('230000000', EXPIRY + 60, s4)), []);
  assert.deepEqual(strikeCross(s4, tick(s4, { at: day1 + 150, spots: {}, holdings: held })), []);
  assert.equal(strikeSide(undefined, 221_000_000n, 221_000_000n), undefined);
});

/* ------------------------------------------------------------------ price alerts */

test('price_alert: fires when the level is reached, re-arms when it is lost, once per direction and level per day', () => {
  const t = Date.parse('2026-09-22T15:00:00Z') / 1000;
  const alerts = { [ALICE]: [{ ticker: 'NVDA', direction: 'above', threshold: '225000000' }, { ticker: 'NVDA', direction: 'below', threshold: '210000000' }] as PriceAlert[] };
  const at = (spot: string, dt: number, before: Snapshot) => tick(before, { at: t + dt, spots: { NVDA: spot }, alerts });

  const s0 = at('224000000', 0, emptySnapshot());
  assert.deepEqual(priceAlerts(emptySnapshot(), s0), []);
  const s1 = at('225000000', 30, s0);
  const fired = check(priceAlerts(s0, s1));
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.dedupeKey, `price_alert:${ALICE}:NVDA:above-225000000-2026-09-22`);
  assert.equal(rendered(fired[0]!).body, 'NVDA is at 225.00 USDG, above your alert at 225.00 USDG.');
  assert.deepEqual(priceAlerts(s1, at('226000000', 60, s1)), [], 'still above: no repeat');
  const s3 = at('224000000', 90, at('226000000', 60, s1));
  const again = check(priceAlerts(s3, at('225500000', 120, s3)));
  assert.equal(again[0]?.dedupeKey, fired[0]?.dedupeKey, 'the same day: deduped by delivery');

  const low = check(priceAlerts(s3, at('209000000', 150, s3)));
  assert.deepEqual(low.map((r) => (r.payload as { direction: string }).direction), ['below']);
  // An alert that already holds when first seen fires once.
  assert.equal(check(priceAlerts(emptySnapshot(), at('230000000', 0, emptySnapshot()))).length, 1);
  assert.equal(alertMet({ ticker: 'NVDA', direction: 'below', threshold: '210000000' }, 210_000_000n), true);
});

/* ------------------------------------------------------------------ expiry countdowns */

test('expiry_24h and expiry_1h: fire once when a held series enters its window, long with cost, short without', () => {
  const held = {
    [ALICE]: holdings({ longs: [{ series: S221, units: '50', avgCost: '3800000' }] }),
    [BOB]: holdings({ shorts: [{ series: S221, units: '100' }] }),
  };
  const at = (t: number, before: Snapshot) => tick(before, { at: t, spots: { NVDA: '219100000' }, holdings: held });

  const s0 = at(EXPIRY - 24 * HOUR - 60, emptySnapshot());
  assert.deepEqual(expiryCountdowns(emptySnapshot(), s0), [], '24 h and a minute out: not yet');
  const s1 = at(EXPIRY - 24 * HOUR + 30, s0);
  const day = check(expiryCountdowns(s0, s1));
  assert.deepEqual(day.map((r) => [r.kind, r.address, r.dedupeKey.split(':').at(-1)]), [
    ['expiry_24h', ALICE, 'long'],
    ['expiry_24h', BOB, 'short'],
  ]);
  assert.equal(rendered(day[0]!).title, 'Your NVDA 221.00 call expires in 24 hours');
  assert.match(rendered(day[0]!).body, /Max loss: 1\.90 USDG/);
  assert.deepEqual(expiryCountdowns(s1, at(EXPIRY - 23.5 * HOUR, s1)), [], 'already inside the window');

  // A position first seen inside the window still gets it; one first seen 10 h out does not.
  assert.equal(check(expiryCountdowns(emptySnapshot(), at(EXPIRY - 23.2 * HOUR, emptySnapshot()))).length, 2);
  assert.deepEqual(expiryCountdowns(emptySnapshot(), at(EXPIRY - 10 * HOUR, emptySnapshot())), []);

  const h0 = at(EXPIRY - 61 * 60, s1);
  const h1 = at(EXPIRY - 59 * 60, h0);
  assert.deepEqual(check(expiryCountdowns(h0, h1)).map((r) => r.kind), ['expiry_1h', 'expiry_1h']);
  assert.deepEqual(expiryCountdowns(emptySnapshot(), at(EXPIRY - 30 * 60, emptySnapshot())), [], 'a 1 h notice with 30 min left would be false');
  assert.deepEqual(expiryCountdowns(emptySnapshot(), at(EXPIRY + 60, emptySnapshot())), []);
});

/* ------------------------------------------------------------------ writer ITM */

test('writer_itm_warning: a short in the money after 09:30 New York on its expiry date, once', () => {
  const put = apiSeries({ longId: '12', shortId: '13', isPut: true });
  const held = {
    [BOB]: holdings({ shorts: [{ series: S221, units: '50' }, { series: put, units: '20', collateral: '4420000000' }] }),
    [ALICE]: holdings({ longs: [{ series: S221, units: '50', avgCost: '3800000' }] }),
  };
  const open = sessionOpenOf(EXPIRY);
  assert.equal(open, Date.parse('2026-09-25T13:30:00Z') / 1000);
  const at = (t: number, spot: string, before: Snapshot) => tick(before, { at: t, spots: { NVDA: spot }, holdings: held });

  assert.deepEqual(writerItmWarnings(emptySnapshot(), at(open - 60, '230000000', emptySnapshot())), [], 'before the session opens');
  assert.deepEqual(writerItmWarnings(emptySnapshot(), at(EXPIRY - 30 * HOUR, '230000000', emptySnapshot())), [], 'the day before');

  const s0 = at(open + 15 * 60, '221000000', emptySnapshot());
  assert.deepEqual(writerItmWarnings(emptySnapshot(), s0), [], 'at the strike is not in the money');
  const s1 = at(open + 30 * 60, '222100000', s0);
  const call = check(writerItmWarnings(s0, s1));
  assert.deepEqual(call.map((r) => [r.address, (r.payload as { series: { isPut: boolean } }).series.isPut, r.dedupeKey.split(':').at(-1)]), [[BOB, false, 'itm']]);
  assert.match(rendered(call[0]!).body, /holders are paid from your 0\.5000 NVDA Stock Tokens of collateral/);
  assert.deepEqual(writerItmWarnings(s1, at(open + 45 * 60, '223000000', s1)), [], 'still in the money: no repeat');

  const putItm = check(writerItmWarnings(s1, at(open + 60 * 60, '220000000', s1)));
  assert.deepEqual(putItm.map((r) => [(r.payload as { series: { isPut: boolean } }).series.isPut, (r.payload as { collateralLocked: { raw: string } }).collateralLocked.raw]), [[true, '4420000000']]);
});

/* ------------------------------------------------------------------ settlement */

const SETTLED_216: SettlementInfo = { price: '219400000', longPayoutPerUnit: '139471285323609', finalizedAt: 1789156925 };
const WORTHLESS_227: SettlementInfo = { price: '219400000', longPayoutPerUnit: '0', finalizedAt: 1789156925 };

function redemption(o: Partial<RedemptionItem['data']> & { series?: ApiSeries; id?: string } = {}): RedemptionItem {
  const { series = S216, id = `${TX}-9`, ...data } = o;
  return {
    id,
    kind: 'redemption',
    ts: 1789157000,
    longId: series.longId,
    series,
    accounts: [data.holder ?? ALICE],
    data: {
      holder: ALICE,
      side: 'long',
      tokenId: series.longId,
      units: '40',
      asset: USDG,
      amount: money('1360000'),
      amountInKind: money('5578851412944360', 18),
      settlementPrice: money('219400000'),
      toLedger: false,
      tx: TX,
      ...data,
    },
  };
}

/** A redemption needs no settlement in the snapshot (it carries settlementPrice): none is given unless asked. */
function afterRedemption(o: { toLedger?: boolean; known?: boolean; settlement?: SettlementInfo; series?: ApiSeries } = {}): Snapshot {
  const series = o.series ?? S216;
  // Seen holding 40 units at 1.25 USDG per share, then redeemed (the long is gone).
  const seen = holdings({ longs: [{ series: { ...series, status: 'expired' }, units: '40', avgCost: '1250000' }], at: 1789150000 });
  const now = holdings({ toLedger: o.toLedger ?? false, at: 1789157100, previous: o.known === false ? undefined : seen });
  return tick(emptySnapshot(), { at: 1789157100, holdings: { [ALICE]: now }, settlements: o.settlement === undefined ? {} : { [series.longId]: o.settlement } });
}

test('settlement_receipt from a redemption: amount, asset and multiple for the holder, cost from the last-known long, price from the redemption', () => {
  const after = afterRedemption();
  assert.deepEqual(after.settlements, {}, 'no settlement item and no /v2/series read behind this receipt');
  const [receipt, ...rest] = check(redemptionReceipts(redemption(), after));
  assert.equal(rest.length, 0);
  assert.equal(receipt?.dedupeKey, `settlement_receipt:${ALICE}:${S216.longId}:long-${TX}-9`);
  assert.deepEqual((receipt?.payload as { settlementPrice: unknown }).settlementPrice, { raw: '219400000', decimals: 6 });
  const message = rendered(receipt!);
  assert.equal(message.title, 'Your NVDA 216.00 call settled: paid 1.36 USDG');
  assert.match(message.body, /settled at 219\.40 USDG\./);
  assert.match(message.body, /Paid: 1\.36 USDG, sent to your wallet\./);
  assert.match(message.body, /Cost: 0\.50 USDG\. Max loss: 0\.50 USDG\. The payout is 2\.72 times the cost\./);

  const inKind = check(redemptionReceipts(redemption({ asset: NVDA, amount: money('6198723792160437', 18) }), after));
  assert.deepEqual((inKind[0]?.payload as { payoutValue: unknown }).payoutValue, { raw: String((6198723792160437n * 219400000n) / 10n ** 18n), decimals: 6 });
  assert.match(rendered(inKind[0]!).body, /Paid: 0\.0061 NVDA Stock Tokens \(1\.35 USDG at the settlement price\)/);

  // The redemption's price wins over anything the snapshot holds for the series.
  const repriced = check(redemptionReceipts(redemption({ asset: NVDA, amount: money('6198723792160437', 18), settlementPrice: money('230000000') }), afterRedemption({ settlement: SETTLED_216 })));
  assert.deepEqual((repriced[0]?.payload as { payoutValue: unknown }).payoutValue, { raw: String((6198723792160437n * 230000000n) / 10n ** 18n), decimals: 6 });
  assert.match(rendered(repriced[0]!).body, /settled at 230\.00 USDG\.\nPaid: 0\.0061 NVDA Stock Tokens \(1\.42 USDG at the settlement price\)/);

  // Never seen holding it: no cost, so no receipt (a long message must state its cost).
  assert.deepEqual(redemptionReceipts(redemption(), afterRedemption({ known: false })), []);
  // A short: what came back.
  const short = check(redemptionReceipts(redemption({ side: 'short', tokenId: S216.shortId, asset: NVDA, amount: money('1969006381039198000', 18), toLedger: true }), afterRedemption({ toLedger: true })));
  assert.equal(short[0]?.dedupeKey, `settlement_receipt:${ALICE}:${S216.longId}:short-${TX}-9`);
  assert.match(rendered(short[0]!).body, /Returned to you: 1\.9690 NVDA Stock Tokens of collateral, held in your Stonkhouse balance\./);
});

test('settlement_receipt: a long that expired worthless says what was lost and that it was the most it could lose, by either path, once', () => {
  const S227 = apiSeries({ longId: '555', shortId: '556', strike: money('227000000'), expiry: S216.expiry, status: 'settled' });
  const viaRedemption = check(redemptionReceipts(redemption({ series: S227, amount: money('0', 18), asset: NVDA }), afterRedemption({ series: S227 })));
  assert.equal(viaRedemption.length, 1);
  assert.equal(viaRedemption[0]?.dedupeKey, `settlement_receipt:${ALICE}:555:long-worthless`);
  const message = rendered(viaRedemption[0]!);
  assert.equal(message.title, 'Your NVDA 227.00 call expired worthless');
  assert.equal(
    message.body,
    [
      'Your NVDA 227.00 call (0.40 shares) expired worthless: NVDA settled at 219.40 USDG, below the 227.00 USDG strike.',
      'You lost the cost, 0.50 USDG. Max loss: 0.50 USDG, the most this position could lose.',
    ].join('\n'),
  );

  // Not redeemed (third-party redemption off): the holdings show the series settled at zero.
  const t = WORTHLESS_227.finalizedAt + 600;
  const was = tick(emptySnapshot(), { at: t - 30, holdings: { [ALICE]: holdings({ longs: [{ series: { ...S227, status: 'expired' }, units: '40', avgCost: '1250000' }] }) } });
  const now = tick(was, { at: t, holdings: { [ALICE]: holdings({ longs: [{ series: S227, units: '40', avgCost: '1250000' }] }) }, settlements: { '555': WORTHLESS_227 } });
  const viaHoldings = check(settledWorthless(was, now));
  assert.deepEqual(viaHoldings.map((r) => r.dedupeKey), [`settlement_receipt:${ALICE}:555:long-worthless`], 'the same key as the redemption path');
  assert.equal(rendered(viaHoldings[0]!).body, message.body);

  assert.deepEqual(settledWorthless(now, tick(now, { at: t + 30, holdings: now.holdings, settlements: now.settlements })), [], 'already settled before');
  const late = tick(was, { at: WORTHLESS_227.finalizedAt + 6 * HOUR + 1, holdings: now.holdings, settlements: now.settlements });
  assert.deepEqual(settledWorthless(was, late), [], 'storm guard: settled more than 6 h ago');
  const itm = tick(was, { at: t, holdings: now.holdings, settlements: { '555': SETTLED_216 } });
  assert.deepEqual(settledWorthless(was, itm), [], 'in the money is not worthless');
});

test('payout_failed_to_ledger: toLedger without the ledger pref, not with it, not for nothing', () => {
  const failed = check(redemptionReceipts(redemption({ toLedger: true }), afterRedemption({ toLedger: false })));
  assert.deepEqual(failed.map((r) => r.kind), ['settlement_receipt', 'payout_failed_to_ledger']);
  assert.equal(failed[1]?.dedupeKey, `payout_failed_to_ledger:${ALICE}:${S216.longId}:${TX}-9`);
  assert.match(rendered(failed[1]!).body, /A payout of 1\.36 USDG from your NVDA 216\.00 call could not be sent to your wallet/);

  assert.deepEqual(check(redemptionReceipts(redemption({ toLedger: true }), afterRedemption({ toLedger: true }))).map((r) => r.kind), ['settlement_receipt']);
  const nothing = redemptionReceipts(redemption({ toLedger: true, amount: money('0') }), afterRedemption({ settlement: WORTHLESS_227 }));
  assert.deepEqual(nothing.map((r) => r.kind), ['settlement_receipt']);
});

/* ------------------------------------------------------------------ auto roll */

test('auto_roll: a Rolled event, and a roll still not done 24 h after it was due', () => {
  const roll: RollItem = {
    id: `${TX}-12`,
    kind: 'roll',
    ts: 1789392900,
    longId: S221.longId,
    series: S221,
    accounts: [CAROL],
    data: { writer: CAROL, orderId: '1009', price: money('260100'), units: '296', tx: TX },
  };
  const rolled = check(rollReceipts(roll));
  assert.equal(rolled[0]?.dedupeKey, `auto_roll:${CAROL}:${S221.longId}:rolled-${TX}-12`);
  assert.equal(rendered(rolled[0]!).title, 'Auto-roll listed your next NVDA call');
  assert.deepEqual(rollReceipts({ ...roll, data: { ...roll.data, units: '0' } }), []);

  // Current series expired Fri 18 Sep 16:00 New York: the roll is due Mon 21 Sep 09:30, overdue after Tue 09:30.
  const LAST_ROLL = Date.parse('2026-09-14T13:35:00Z') / 1000;
  const friday = apiSeries({ longId: '777', shortId: '778', expiry: Date.parse('2026-09-18T20:00:00Z') / 1000, status: 'settled' });
  const strategy = (active = true, current: ApiSeries | null = friday, lastRolledAt: number | null = LAST_ROLL) => ({
    [CAROL]: holdings({ strategies: [{ ticker: 'NVDA', active, currentSeries: current, lastRolledAt }] }),
  });
  const september = calendarDays('2026-09-14', '2026-10-02');
  const at = (iso: string, before: Snapshot, h = strategy(), sessionDays: SessionDays = september) => tick(before, { at: Date.parse(iso) / 1000, holdings: h, sessionDays });

  const saturday = at('2026-09-19T15:00:00Z', emptySnapshot());
  assert.deepEqual(autoRollSkipped(emptySnapshot(), saturday), [], 'a weekend is not a skipped roll');
  const tuesdayEarly = at('2026-09-22T13:29:00Z', saturday);
  assert.deepEqual(autoRollSkipped(saturday, tuesdayEarly), []);
  const tuesday = at('2026-09-22T13:31:00Z', tuesdayEarly);
  const skipped = check(autoRollSkipped(tuesdayEarly, tuesday));
  assert.deepEqual(skipped.map((r) => r.dedupeKey), [`auto_roll:${CAROL}:777:skipped`]);
  assert.deepEqual(skipped[0]?.payload, { ticker: 'NVDA', status: 'skipped', dueAt: Date.parse('2026-09-21T13:30:00Z') / 1000, lastRolledAt: LAST_ROLL });
  const message = rendered(skipped[0]!);
  assert.equal(message.title, 'Auto-roll has not rolled your NVDA position');
  assert.equal(
    message.body,
    [
      'Auto-roll has not rolled your NVDA position. The roll was due when the session opened Mon 21 Sep, 9:30am EDT, more than 24 hours ago.',
      'Last roll: Mon 14 Sep, 9:35am EDT.',
      'Nothing new is listed for sale until it rolls. Check the strategy on Earn.',
    ].join('\n'),
  );
  assert.deepEqual(autoRollSkipped(tuesday, at('2026-09-22T14:00:00Z', tuesday)), [], 'once');
  assert.deepEqual(autoRollSkipped(emptySnapshot(), at('2026-09-22T14:00:00Z', emptySnapshot(), strategy(false))), [], 'a stopped strategy');
  assert.deepEqual(autoRollSkipped(emptySnapshot(), at('2026-09-22T14:00:00Z', emptySnapshot(), strategy(true, S221))), [], 'rolled into a live series');

  // No last roll on record: the due time alone.
  const never = check(autoRollSkipped(emptySnapshot(), at('2026-09-22T14:00:00Z', emptySnapshot(), strategy(true, friday, null))));
  assert.equal((never[0]?.payload as { lastRolledAt?: number }).lastRolledAt, undefined);
  assert.doesNotMatch(rendered(never[0]!).body, /Last roll/);

  // The calendar has not answered (or answered only part of the way): the rule waits, however late.
  assert.deepEqual(autoRollSkipped(emptySnapshot(), at('2026-09-30T14:00:00Z', emptySnapshot(), strategy(), {})), [], 'no calendar');
  const partial = calendarDays('2026-09-19', '2026-09-20');
  assert.deepEqual(autoRollSkipped(emptySnapshot(), at('2026-09-30T14:00:00Z', emptySnapshot(), strategy(), partial)), [], 'the weekend only');
  // And once it answers, the warning comes then, a transition from "unknown".
  const late = at('2026-09-30T14:00:00Z', at('2026-09-30T13:59:30Z', emptySnapshot(), strategy(), {}));
  assert.equal(check(autoRollSkipped(at('2026-09-30T13:59:30Z', emptySnapshot(), strategy(), {}), late)).length, 1);

  // A Monday holiday (the fixture calendar's hypothetical 21 Sep closure) moves due and warning a day.
  const mondayOff = calendarDays('2026-09-14', '2026-10-02', ['2026-09-21']);
  const tuesdayWithHoliday = at('2026-09-22T13:31:00Z', tuesdayEarly, strategy(), mondayOff);
  assert.deepEqual(autoRollSkipped(at('2026-09-22T13:29:00Z', saturday, strategy(), mondayOff), tuesdayWithHoliday), [], 'due Tuesday now');
  const wednesday = check(autoRollSkipped(tuesdayWithHoliday, at('2026-09-23T13:31:00Z', tuesdayWithHoliday, strategy(), mondayOff)));
  assert.equal((wednesday[0]?.payload as { dueAt: number }).dueAt, Date.parse('2026-09-22T13:30:00Z') / 1000);
});

test('auto_roll withdrawn: cancelStale withdrew the ask the spot overtook (INTERFACE_VERSION 7)', () => {
  const item: StaleCancelItem = {
    id: `${TX}-4`,
    kind: 'stale_cancel',
    ts: 1789392900,
    longId: S221.longId,
    series: S221,
    accounts: [CAROL],
    data: {
      writer: CAROL,
      orderId: '1009',
      spot: money('223400000'),
      spotUpdatedAt: Date.parse('2026-09-14T13:40:00Z') / 1000,
      nextRollAfter: EXPIRY,
      tx: TX,
    },
  };

  const withdrawn = check(staleCancelReceipts(item));
  // Only the writer hears: no option changed hands, so no holder has anything to be told.
  assert.deepEqual(withdrawn.map((r) => r.address), [CAROL]);
  // Keyed on the item, so re-reading the same feed page cannot repeat it.
  assert.deepEqual(withdrawn.map((r) => r.dedupeKey), [`auto_roll:${CAROL}:${S221.longId}:withdrawn-${TX}-4`]);
  assert.deepEqual(withdrawn[0]?.payload, {
    ticker: 'NVDA',
    status: 'withdrawn',
    series: { longId: S221.longId, ticker: 'NVDA', isPut: false, strike: { raw: '221000000', decimals: 6 }, expiry: EXPIRY },
    spot: { raw: '223400000', decimals: 6 },
    spotUpdatedAt: Date.parse('2026-09-14T13:40:00Z') / 1000,
    nextRollAfter: EXPIRY,
  });

  const message = rendered(withdrawn[0]!);
  assert.equal(message.title, 'Auto-roll withdrew your NVDA ask');
  assert.equal(
    message.body,
    [
      'NVDA reached the 221.00 USDG strike (spot 223.40 USDG at Mon 14 Sep, 9:40am EDT), so auto-roll withdrew the unsold part of your NVDA 221.00 call ask.',
      'That stops it selling for less than the option is now worth. Options already sold are unchanged, and your collateral still backs them.',
      'Auto-roll lists again after the Fri 25 Sep, 4:00pm EDT expiry.',
    ].join('\n'),
  );

  // A withdrawn ask is not an overdue roll: the two rules have different keys and different copy.
  assert.notEqual(withdrawn[0]?.dedupeKey, `auto_roll:${CAROL}:${S221.longId}:skipped`);
  assert.doesNotMatch(message.body, /has not rolled|Nothing new is listed/);

  // And it reaches eventRules by kind, so the feed loop delivers it like every other item.
  assert.deepEqual(eventRules(item, emptySnapshot(), emptySnapshot()).map((r) => r.kind), ['auto_roll']);
});

test('auto_roll skipped: roll due on the first ExpiryCalendar session day, across a Friday holiday and Thanksgiving week', () => {
  const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());
  const rolling = (expiryIso: string, longId = '901') => ({
    ticker: 'NVDA',
    active: true,
    currentSeries: seriesInfo(apiSeries({ longId, shortId: String(BigInt(longId) + 1n), expiry: Date.parse(expiryIso) / 1000, status: 'settled' })),
    lastRolledAt: Date.parse('2026-11-16T14:35:00Z') / 1000,
  });
  const winter = calendarDays('2026-11-16', '2027-01-08', ['2026-11-26', '2026-12-25', '2027-01-01']);
  const weekdays = calendarDays('2026-11-16', '2027-01-08');

  // Christmas 2026 is a Friday: that week's weekly expires Thu 24 Dec 16:00 EST (21:00Z). Weekdays
  // alone would make the roll due Fri 25 Dec and warn Sat 26 Dec; the holiday makes it Mon 28 Dec.
  const christmasWeek = rolling('2026-12-24T21:00:00Z');
  assert.equal(iso(rollDueAt(christmasWeek, weekdays)), '2026-12-25T14:30:00.000Z', 'weekdays only: the holiday itself');
  assert.equal(iso(rollDueAt(christmasWeek, winter)), '2026-12-28T14:30:00.000Z');
  // Thanksgiving (Thu 26 Nov): a daily expiring Wed 25 Nov is due Fri 27 Nov, the weekly expiring
  // Fri 27 Nov is due Mon 30 Nov (standard time: 09:30 is 14:30Z).
  assert.equal(iso(rollDueAt(rolling('2026-11-25T21:00:00Z'), weekdays)), '2026-11-26T14:30:00.000Z', 'weekdays only: Thanksgiving itself');
  assert.equal(iso(rollDueAt(rolling('2026-11-25T21:00:00Z'), winter)), '2026-11-27T14:30:00.000Z');
  assert.equal(iso(rollDueAt(rolling('2026-11-27T21:00:00Z'), winter)), '2026-11-30T14:30:00.000Z');
  // New Year's Day 2027 is a Friday too: Thu 31 Dec → Mon 4 Jan.
  assert.equal(iso(rollDueAt(rolling('2026-12-31T21:00:00Z'), winter)), '2027-01-04T14:30:00.000Z');
  assert.equal(rollDueAt({ ...christmasWeek, active: false }, winter), null);

  // Through the rule: the Christmas-week roll is not warned about Saturday (as weekdays alone
  // would), nor Monday, and is on Tuesday 29 Dec after 09:30 EST.
  const writer = (s: typeof christmasWeek) => ({ [CAROL]: { ...holdings({}), strategies: [s] } });
  const at = (isoTime: string, before: Snapshot, s = christmasWeek, days = winter) => tick(before, { at: Date.parse(isoTime) / 1000, holdings: writer(s), sessionDays: days });
  const friday = at('2026-12-25T15:00:00Z', emptySnapshot());
  assert.equal(check(autoRollSkipped(friday, at('2026-12-26T14:31:00Z', friday, christmasWeek, weekdays))).length, 1, 'weekdays alone warn on Saturday');
  const saturday = at('2026-12-26T14:31:00Z', friday);
  assert.deepEqual(autoRollSkipped(friday, saturday), [], 'not on Saturday');
  const monday = at('2026-12-28T15:00:00Z', saturday);
  assert.deepEqual(autoRollSkipped(saturday, monday), [], 'not on the due day');
  const tuesday = at('2026-12-29T14:31:00Z', monday);
  const warned = check(autoRollSkipped(monday, tuesday));
  assert.deepEqual(warned.map((r) => r.dedupeKey), [`auto_roll:${CAROL}:901:skipped`]);
  assert.match(rendered(warned[0]!).body, /^Auto-roll has not rolled your NVDA position\. The roll was due when the session opened Mon 28 Dec, 9:30am EST, more than 24 hours ago\.\nLast roll: Mon 16 Nov, 9:35am EST\./);

  // Thanksgiving week through the rule: the Wednesday daily is warned Saturday 28 Nov, not Friday.
  const daily = rolling('2026-11-25T21:00:00Z', '903');
  const thursday = at('2026-11-26T15:00:00Z', emptySnapshot(), daily);
  const fridayAfter = at('2026-11-27T14:31:00Z', thursday, daily);
  assert.deepEqual(autoRollSkipped(thursday, fridayAfter), [], 'Friday is the due day, not a day overdue');
  assert.equal(check(autoRollSkipped(fridayAfter, at('2026-11-28T14:31:00Z', fridayAfter, daily))).length, 1);
});

/* ------------------------------------------------------------------ composition, calendar */

test('eventRules and stateRules compose the kinds; settlement items produce nothing by themselves', () => {
  const after = afterRedemption();
  assert.deepEqual(eventRules(fill(), emptySnapshot(), after).map((r) => r.kind), ['fill_receipt', 'fill_receipt']);
  assert.deepEqual(eventRules(redemption(), emptySnapshot(), after).map((r) => r.kind), ['settlement_receipt']);
  const settlement = {
    id: `${TX}-1-${S216.longId}`,
    kind: 'settlement' as const,
    ts: 1789156925,
    longId: S216.longId,
    series: S216,
    accounts: [],
    data: { price: money('219400000'), longPayoutPerUnit: money('1', 18), feePerUnit: money('1', 18), shortPayoutPerUnit: money('1', 18), tx: TX },
  };
  assert.deepEqual(eventRules(settlement, emptySnapshot(), after), []);
  const s = tick(emptySnapshot(), { at: EXPIRY - 59 * 60, spots: { NVDA: '222000000' }, holdings: { [BOB]: holdings({ shorts: [{ series: S221, units: '5' }] }) } });
  assert.deepEqual(check(stateRules(emptySnapshot(), s)).map((r) => r.kind).sort(), ['expiry_1h', 'writer_itm_warning']);
  assert.equal(longCost('1250000', '40'), 500_000n);
  assert.equal(longCost('1', '1'), 1n, 'rounded up');
  assert.equal(dedupeKey('fill_receipt', ALICE.toLowerCase(), '1', 'x'), `fill_receipt:${ALICE}:1:x`);
  assert.equal(seriesInfo(S221).strike.raw, '221000000');
});

test('New York calendar: dates, API day indices, session days and opens across the weekend and the DST change', () => {
  assert.equal(nyDate(Date.parse('2026-09-23T03:59:00Z') / 1000), '2026-09-22');
  assert.equal(nyDate(Date.parse('2026-09-23T04:00:00Z') / 1000), '2026-09-23');
  assert.equal(nyWallTime(2026, 12, 4, 16, 0), Date.parse('2026-12-04T21:00:00Z') / 1000);
  const iso = (t: number) => new Date(t * 1000).toISOString();

  // The API's day index is floor(close / 86400): the UTC day number of the New York date, in EDT and EST.
  const friday = Date.parse('2026-09-18T20:00:00Z') / 1000;
  assert.equal(dayIndexOf(friday), Math.floor(friday / 86_400));
  assert.equal(dayIndexOf(friday), 20714);
  assert.equal(dayIndexOf(Date.parse('2026-12-04T21:00:00Z') / 1000), Math.floor(Date.parse('2026-12-04T21:00:00Z') / 86_400_000));
  assert.equal(dayIndexOf(Date.parse('2026-09-19T03:59:00Z') / 1000), 20714, 'late evening New York is still that date');
  assert.equal(iso(sessionOpenOfDay(20717)), '2026-09-21T13:30:00.000Z');
  assert.equal(iso(sessionOpenOfDay(dayOf('2026-11-02'))), '2026-11-02T14:30:00.000Z', 'standard time');

  const days = calendarDays('2026-09-14', '2026-11-06');
  assert.equal(nextSessionDay(dayIndexOf(friday), days), 20717, 'Friday → Monday');
  assert.equal(nextSessionDay(dayIndexOf(Date.parse('2026-09-17T20:00:00Z') / 1000), days), 20714, 'Thursday → Friday');
  assert.equal(iso(sessionOpenOfDay(nextSessionDay(dayOf('2026-10-30'), days) ?? 0)), '2026-11-02T14:30:00.000Z', 'into standard time');
  assert.equal(nextSessionDay(dayIndexOf(friday), calendarDays('2026-09-14', '2026-09-20')), null, 'Monday unknown: no answer');
  assert.equal(nextSessionDay(dayIndexOf(friday), {}), null);
  const closed = calendarDays('2026-09-19', '2026-10-10', ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']);
  assert.equal(nextSessionDay(dayIndexOf(friday), closed), null, `nothing within ${SESSION_SCAN_DAYS} days`);
});
