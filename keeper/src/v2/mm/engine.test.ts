/**
 * The MM quote engine, pure: what a quote is, when there is none, and when a live one is left alone.
 *
 * WHY THIS FILE EXISTS: every price the vault shows comes out of these functions, and each rule here is money: a skew
 * with the wrong sign buys more of what the vault is already long; a rounding the wrong way crosses the book or trips
 * the vault's BadPrice guard; a missed halt quotes on a stale fair value or into the last minutes before the cutoff;
 * a requote threshold that fires on noise spends gas every tick.
 *
 * DELIBERATELY ABSENT: the chain and the pricing service (quoter.ts and devnet-mm.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HALTS,
  haltBeforeFair,
  fairAtSpot,
  fairCheckOf,
  intrinsicOf,
  quotedFairOf,
  haltOf,
  halfSpreadUsdg6,
  isKillTarget,
  isReclaimable,
  judgeReplace,
  moveBps,
  netDeltaByUnderlying,
  orderActions,
  planSeriesActions,
  pullAtOf,
  quotePrices,
  type QuoteFees,
  quoteValidUntil,
  roundDownToTick,
  roundUpToTick,
  selectSeries,
  skewUsdg6,
  widenBps,
  type HaltInput,
  type LiveOrder,
  type MmAction,
  type QuoteParams,
  type SeriesInfo,
} from './engine.js';

const NVDA = '0x00000000000000000000000000000000000000aa';
const TSLA = '0x00000000000000000000000000000000000000bb';
const EXPIRY = 1_790_000_000;
const NOW = EXPIRY - 86_400;

const PARAMS: QuoteParams = {
  halfSpreadBps: 500,
  minHalfSpreadUsdg6: 20_000n,
  expiryWidenS: 14_400,
  expiryWidenBps: 20_000,
  pullMinutes: 15,
  quoteOffHours: false,
  fairMaxAgeS: 1_800,
  fairMaxAgeOffHoursS: 345_600,
  skewBpsPerDeltaShare: 10,
  maxSkewBps: 1_000,
  requoteBps: 300,
  resizeBps: 5_000,
};

const series = (over: Partial<SeriesInfo> = {}): SeriesInfo => ({ longId: 1n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: EXPIRY, ...over });

/** The v8 launch fee set: 5 % on a first sale, 0 % on a resale (03-INTERFACES §4 registry table). */
const LAUNCH_FEES: QuoteFees = { current: { premiumFeeBps: 500, resaleFeeBps: 0 }, pending: null };
/** No fee at all: the pre-v8 arithmetic, so the existing price tests keep asserting what they were written for. */
const NO_FEES: QuoteFees = { current: { premiumFeeBps: 0, resaleFeeBps: 0 }, pending: null };

const price = (over: Partial<Parameters<typeof quotePrices>[0]> = {}) =>
  quotePrices({ now: NOW, series: series(), fair: 2_000_000n, delta: 0.4, spot: 210_000_000n, netDeltaShares: 0, askFloor: 0n, bidCap: 21_000_000n, fees: NO_FEES, params: PARAMS, ...over });

/*//////////////////////////////////////////////////////////////
                    THE SELLER FEE IN THE ASK
//////////////////////////////////////////////////////////////*/

test('the write ask is grossed up so the seller fee still leaves the target, at the v8 launch parameters', () => {
  // AC-2. The book credits a selling maker `premium - sellerFee + rebate`, so the ask must be the GROSS
  // whose fee still leaves fair + halfSpread. Without this, at MM_HALF_SPREAD_BPS 500 and premiumFeeBps
  // 500, the vault nets fair x 1.05 x 0.95 = 0.9975 x fair - a loss on every option it writes.
  const fair = 2_000_000n;
  const halfSpread = (fair * 500n) / 10_000n; // 100_000, above MM_MIN_HALF_SPREAD_USDG6
  const q = price({ fair, delta: 0, netDeltaShares: 0, fees: LAUNCH_FEES });

  const netToVault = (q.ask * (10_000n - 500n)) / 10_000n;
  assert.ok(netToVault >= fair + halfSpread, `net ${netToVault} must cover the target ${fair + halfSpread}`);
  // And it is a GROSS-UP, not a markup: a markup would be target * 1.05 = 2_205_000, which nets only
  // 2_094_750 and is short of the target for ever.
  assert.ok(q.ask > ((fair + halfSpread) * 10_500n) / 10_000n, 'a gross-up is strictly above the markup it is mistaken for');
});

test('resaleFeeBps 0: the resale ask is NOT grossed and stays one tick under the ungrossed write ask', () => {
  // AC-2, second half, and the trap the whole per-slot design exists for. If the resale ask were derived
  // from the GROSSED write ask it would carry the 5 % primary fee while owing 0, sit ~5 % too high, never
  // fill, and the bot would write new options instead of unwinding inventory.
  const fair = 2_000_000n;
  const halfSpread = (fair * 500n) / 10_000n;
  const ungrossedWriteAsk = fair + halfSpread; // already tick-aligned at these numbers
  const q = price({ fair, delta: 0, netDeltaShares: 0, fees: LAUNCH_FEES });

  assert.equal(q.resale, ungrossedWriteAsk - 100n, 'one tick under the UNGROSSED write ask');
  assert.ok(q.ask > q.resale + 100n, 'the two asks may sit more than one tick apart on chain, and here they do');
});

test('resaleFeeBps 300: the two asks are grossed by their own different rates', () => {
  const fair = 2_000_000n;
  const halfSpread = (fair * 500n) / 10_000n;
  const target = fair + halfSpread;
  const q = price({ fair, delta: 0, netDeltaShares: 0, fees: { current: { premiumFeeBps: 500, resaleFeeBps: 300 }, pending: null } });

  assert.ok((q.ask * 9_500n) / 10_000n >= target, 'the write ask nets the target after 5 %');
  assert.ok((q.resale * 9_700n) / 10_000n >= target - 100n, 'the resale ask nets one tick under the target after 3 %');
  assert.ok(q.resale < q.ask, 'inventory is still offered below new supply');
});

test('a scheduled fee rise is quoted against, because a resting order can fill after it bites', () => {
  // The horizon rule: `maxOrderLifetime` is 0 on the launch vault and 0 means NO LIMIT, so a rule that
  // ignored a change beyond that horizon would ignore EVERY change. This takes the max whenever anything
  // is scheduled.
  const fair = 2_000_000n;
  const pendingHigher = price({ fair, delta: 0, netDeltaShares: 0, fees: { current: { premiumFeeBps: 100, resaleFeeBps: 0 }, pending: { params: { premiumFeeBps: 900, resaleFeeBps: 0 }, effectiveAt: NOW + 172_800 } } });
  const currentOnly = price({ fair, delta: 0, netDeltaShares: 0, fees: { current: { premiumFeeBps: 100, resaleFeeBps: 0 }, pending: null } });
  assert.ok(pendingHigher.ask > currentOnly.ask, 'the higher scheduled rate is what the ask is grossed by');

  // effectiveAt 0 is the chain saying nothing is scheduled (OrderBook.pendingFeeParams returns the zero
  // value), NOT a change at the epoch.
  const none = price({ fair, delta: 0, netDeltaShares: 0, fees: { current: { premiumFeeBps: 100, resaleFeeBps: 0 }, pending: { params: { premiumFeeBps: 900, resaleFeeBps: 0 }, effectiveAt: 0 } } });
  assert.equal(none.ask, currentOnly.ask, 'effectiveAt 0 means nothing pending');
});

test('a fee at or above 100 % cannot gross up: the ask stays ungrossed and says so rather than resting garbage', () => {
  const q = price({ fair: 2_000_000n, delta: 0, netDeltaShares: 0, fees: { current: { premiumFeeBps: 10_000, resaleFeeBps: 0 }, pending: null } });
  assert.ok(q.clampedBy.includes('fee-out-of-range'), 'the caller is told the ask is too cheap');
  assert.equal(q.ask, 2_100_000n, 'the ungrossed price, not a division by zero');
});

/*//////////////////////////////////////////////////////////////
                          PRICES AND TICKS
//////////////////////////////////////////////////////////////*/

test('rounding: bids round down and asks round up to the 100 base-unit tick; nothing negative', () => {
  assert.equal(roundDownToTick(123_456n), 123_400n);
  assert.equal(roundUpToTick(123_456n), 123_500n);
  assert.equal(roundUpToTick(123_400n), 123_400n);
  assert.equal(roundDownToTick(-5n), 0n);
  assert.equal(roundUpToTick(0n), 0n);

  // fair 1.234567, half spread 5 % = 0.061728: bid 1.172839 → 1.1728, ask 1.296295 → 1.2963
  const q = price({ fair: 1_234_567n });
  assert.equal(q.halfSpread, 61_728n);
  assert.equal(q.bid, 1_172_800n);
  assert.equal(q.ask, 1_296_300n);
  assert.equal(q.bid! % 100n, 0n);
  assert.equal(q.ask % 100n, 0n);
  assert.deepEqual(q.clampedBy, []);
});

test('spread: a fraction of fair with a floor in USDG', () => {
  assert.equal(halfSpreadUsdg6(2_000_000n, 10_000n, PARAMS), 100_000n);
  assert.equal(halfSpreadUsdg6(100_000n, 10_000n, PARAMS), 20_000n, 'the minimum wins on a cheap option');
  const q = price({ fair: 100_000n });
  assert.equal(q.bid, 80_000n);
  assert.equal(q.ask, 120_000n);
});

test('inventory skew: long delta lowers call quotes and raises put quotes, short delta the reverse; linear, capped', () => {
  const flat = price();
  const long = price({ netDeltaShares: 1 });
  const short = price({ netDeltaShares: -1 });
  // skew = delta 0.4 × spot 210 USDG × 10 bps per delta-share × 1 share = 0.084 USDG
  assert.equal(long.skew, 84_000n);
  assert.equal(short.skew, -84_000n);
  assert.ok(long.bid! < flat.bid! && long.ask < flat.ask, 'a vault long delta sells calls cheaper and bids less');
  assert.ok(short.bid! > flat.bid! && short.ask > flat.ask, 'a vault short delta pays more for calls and asks more');
  assert.equal(flat.ask - long.ask, 84_000n);

  const put = price({ series: series({ isPut: true }), delta: -0.6, netDeltaShares: 1 });
  const putFlat = price({ series: series({ isPut: true }), delta: -0.6 });
  assert.ok(put.bid! > putFlat.bid! && put.ask > putFlat.ask, 'long delta buys puts (negative delta) more eagerly');

  assert.equal(skewUsdg6({ fair: 2_000_000n, delta: 0.4, spot: 210_000_000n, netDeltaShares: 2, params: PARAMS }), 168_000n, 'twice the inventory, twice the skew');
  assert.equal(skewUsdg6({ fair: 2_000_000n, delta: 0.4, spot: 210_000_000n, netDeltaShares: 1_000, params: PARAMS }), 200_000n, 'capped at MM_MAX_SKEW_BPS of fair');
  assert.equal(skewUsdg6({ fair: 2_000_000n, delta: 0.4, spot: 210_000_000n, netDeltaShares: -1_000, params: PARAMS }), -200_000n);
  assert.equal(skewUsdg6({ fair: 2_000_000n, delta: Number.NaN, spot: 210_000_000n, netDeltaShares: 5, params: PARAMS }), 0n);
  assert.equal(skewUsdg6({ fair: 2_000_000n, delta: 0.4, spot: 210_000_000n, netDeltaShares: 5, params: { ...PARAMS, skewBpsPerDeltaShare: 0 } }), 0n);
});

test('expiry widening: flat until MM_EXPIRY_WIDEN_S before expiry, then linear to the maximum at the pull time', () => {
  const start = EXPIRY - PARAMS.expiryWidenS;
  const end = pullAtOf(EXPIRY, PARAMS.pullMinutes);
  assert.equal(end, EXPIRY - 1_800 - 900);
  assert.equal(widenBps(start - 1, EXPIRY, PARAMS), 10_000n);
  assert.equal(widenBps(start, EXPIRY, PARAMS), 10_000n);
  assert.equal(widenBps(Math.floor((start + end) / 2), EXPIRY, PARAMS), 20_000n);
  assert.equal(widenBps(end, EXPIRY, PARAMS), 30_000n);
  assert.equal(widenBps(end, EXPIRY, { ...PARAMS, expiryWidenBps: 0 }), 10_000n);

  const far = price({ now: start - 60 });
  const near = price({ now: end - 1 });
  assert.equal(far.halfSpread, 100_000n);
  assert.ok(near.halfSpread > 290_000n && near.halfSpread <= 300_000n, `about 3x at the pull time (${near.halfSpread})`);
  assert.ok(near.bid! < far.bid! && near.ask > far.ask);
});

test('guards: a bid above the vault bid cap is capped, an ask below the ask floor is raised, a crossed quote keeps one tick', () => {
  const capped = price({ bidCap: 1_500_050n });
  assert.equal(capped.bid, 1_500_000n);
  assert.deepEqual(capped.clampedBy, ['bid-cap']);

  const floored = price({ askFloor: 2_500_001n });
  assert.equal(floored.ask, 2_500_100n);
  assert.ok(floored.clampedBy.includes('ask-floor'));

  const deepItm = price({ fair: 30_000_000n, askFloor: 40_000_000n, bidCap: 45_000_000n });
  assert.equal(deepItm.ask, 40_000_000n, 'an ITM ask below intrinsic less the tolerance would revert BadPrice');
  assert.equal(deepItm.bid, 28_500_000n);

  const crossed = price({ fair: 5_000n, params: { ...PARAMS, halfSpreadBps: 1, minHalfSpreadUsdg6: 0n } });
  assert.equal(crossed.ask, 5_000n);
  assert.equal(crossed.bid, 4_900n, 'a zero spread on a tick keeps the bid one tick under the ask');
  assert.ok(crossed.clampedBy.includes('crossed'));

  const worthless = price({ fair: 100n, params: { ...PARAMS, minHalfSpreadUsdg6: 100n } });
  assert.equal(worthless.bid, null, 'no bid under one tick');
  assert.equal(worthless.ask, 200n);
});

test('resale asks sit one tick under the write ask when that stays above the bid and the floor', () => {
  const q = price();
  assert.equal(q.resale, q.ask - 100n);
  const tight = price({ fair: 100n, params: { ...PARAMS, minHalfSpreadUsdg6: 100n } });
  assert.equal(tight.resale, tight.ask - 100n);
  const floor = price({ askFloor: 2_100_000n, fair: 2_000_000n, params: { ...PARAMS, halfSpreadBps: 1, minHalfSpreadUsdg6: 0n } });
  assert.equal(floor.ask, 2_100_000n);
  assert.equal(floor.resale, floor.ask, 'never under the floor');
});

/*//////////////////////////////////////////////////////////////
                              HALTS
//////////////////////////////////////////////////////////////*/

const haltInput = (over: Partial<HaltInput> = {}): HaltInput => ({
  now: NOW,
  series: series(),
  params: PARAMS,
  killed: false,
  lossStopped: false,
  isQuoter: true,
  tradingPaused: false,
  sessionOpen: true,
  marketEnabled: true,
  spotFresh: true,
  selected: true,
  fair: { ok: true, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf: NOW - 60, source: 'cboe' },
  guardsOk: true,
  ...over,
});

test('halts: each condition, in order, and none on a healthy series', () => {
  assert.equal(haltOf(haltInput()), null);
  const cases: Array<[Partial<HaltInput>, string]> = [
    [{ killed: true }, 'killed'],
    [{ lossStopped: true }, 'loss-stop'],
    [{ isQuoter: false }, 'not-quoter'],
    [{ tradingPaused: true }, 'trading-paused'],
    [{ now: EXPIRY }, 'expired'],
    [{ now: pullAtOf(EXPIRY, 15) }, 'pull-window'],
    [{ sessionOpen: false }, 'market-closed'],
    [{ marketEnabled: false }, 'market-disabled'],
    [{ spotFresh: false }, 'spot-stale'],
    [{ selected: false }, 'not-selected'],
    [{ fair: { ok: false, reason: 'chain-stale' } }, 'fair-unavailable'],
    [{ fair: undefined }, 'fair-unavailable'],
    [{ fair: { ok: true, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf: NOW - 1_801, source: 'cboe' } }, 'fair-stale'],
    [{ fair: { ok: true, fair: 0n, delta: 0.4, iv: 0.5, asOf: NOW, source: 'model' } }, 'fair-unavailable'],
    [{ guardsOk: false }, 'guards-unreadable'],
  ];
  for (const [over, expected] of cases) assert.equal(haltOf(haltInput(over))?.halt, expected, JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  // The first condition wins.
  assert.equal(haltOf(haltInput({ killed: true, lossStopped: true, sessionOpen: false }))?.halt, 'killed');
  assert.equal(haltOf(haltInput({ lossStopped: true, fair: { ok: false, reason: 'no-quotes' } }))?.halt, 'loss-stop');
});

test('halts: the pull window opens MM_PULL_MINUTES before the mint cutoff; off-hours quoting and its own staleness limit', () => {
  const pullAt = EXPIRY - 1_800 - 15 * 60;
  const fresh = (t: number) => ({ ok: true as const, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf: t - 60, source: 'cboe' });
  assert.equal(haltOf(haltInput({ now: pullAt - 1, fair: fresh(pullAt) })), null);
  assert.equal(haltOf(haltInput({ now: pullAt, fair: fresh(pullAt) }))?.halt, 'pull-window');
  assert.equal(haltOf(haltInput({ now: pullAt, fair: fresh(pullAt), params: { ...PARAMS, pullMinutes: 0 } })), null, 'MM_PULL_MINUTES=0 quotes up to the cutoff');

  const offHours = { ...PARAMS, quoteOffHours: true };
  assert.equal(haltOf(haltInput({ sessionOpen: false, params: offHours, fair: { ok: true, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf: NOW - 86_400, source: 'cboe' } })), null, 'a Friday close priced over the weekend');
  assert.equal(
    haltOf(haltInput({ sessionOpen: false, params: offHours, fair: { ok: true, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf: NOW - 345_601, source: 'cboe' } }))?.halt,
    'fair-stale',
  );
  assert.equal(haltBeforeFair(haltInput({ sessionOpen: false }))?.halt, 'market-closed');
  assert.equal(haltBeforeFair(haltInput({ fair: { ok: false, reason: 'x' } })), null, 'fair is judged after the request');
});

/*//////////////////////////////////////////////////////////////
                         REPLACE DISCIPLINE
//////////////////////////////////////////////////////////////*/

const order = (over: Partial<LiveOrder> = {}): LiveOrder => ({ id: 10n, kind: 'Bid', price: 1_900_000n, units: 100n, filled: 0n, validUntil: EXPIRY, cancelled: false, ...over });

test('requote threshold: a quote moves only when its target moves more than MM_REQUOTE_BPS or its size is off', () => {
  assert.equal(moveBps(1_000_000n, 1_030_000n), 300);
  assert.equal(moveBps(0n, 1n), Number.POSITIVE_INFINITY);
  const judge = (o: LiveOrder, target: { price: bigint; units: bigint }, slot: 'bid' | 'write' | 'resale' = 'bid') =>
    judgeReplace({ order: o, target, slot, askFloor: 0n, bidCap: 10_000_000n, params: PARAMS });

  assert.equal(judge(order(), { price: 1_957_000n, units: 100n }).replace, false, '300 bps is not more than 300');
  assert.equal(judge(order(), { price: 1_957_200n, units: 100n }).replace, true, '301 bps');
  assert.equal(judge(order(), { price: 1_843_000n, units: 100n }).replace, false);
  assert.equal(judge(order(), { price: 1_842_800n, units: 100n }).replace, true);
  assert.equal(judge(order({ filled: 40n }), { price: 1_900_000n, units: 100n }).replace, false, '60 left of 100 is inside MM_RESIZE_BPS');
  assert.equal(judge(order({ filled: 60n }), { price: 1_900_000n, units: 100n }).replace, true, '40 left is under half the target');
  assert.equal(judge(order({ units: 500n }), { price: 1_900_000n, units: 100n }).replace, true, 'more than the target is always resized');
  assert.match(judgeReplace({ order: order(), target: { price: 1_900_000n, units: 100n }, slot: 'bid', askFloor: 0n, bidCap: 1_800_000n, params: PARAMS }).reason, /above the bid cap/);
  assert.match(judgeReplace({ order: order({ kind: 'AskWrite' }), target: { price: 1_900_000n, units: 100n }, slot: 'write', askFloor: 2_000_000n, bidCap: 0n, params: PARAMS }).reason, /below the ask floor/);
});

const targets = (over: Partial<Record<'bid' | 'write' | 'resale', { price: bigint; units: bigint } | null>> = {}) => ({
  bid: { price: 1_900_000n, units: 100n },
  write: { price: 2_100_000n, units: 100n },
  resale: null,
  ...over,
});
const validUntil = { bid: EXPIRY - 3_600, write: EXPIRY - 3_600, resale: EXPIRY - 3_600 };
const plan = (orders: LiveOrder[], t: ReturnType<typeof targets> | null, over: Partial<Parameters<typeof planSeriesActions>[0]> = {}) =>
  planSeriesActions({ longId: 1n, now: NOW, orders, targets: t, validUntil, askFloor: 0n, bidCap: 10_000_000n, refreshS: 600, params: PARAMS, ...over });

test('planSeriesActions: place what is missing, leave what is close, replace what moved, cancel extras and halted series', () => {
  const placed = plan([], targets());
  assert.deepEqual(
    placed.map((a) => [a.type, a.type === 'place' ? a.slot : null, a.type === 'place' ? a.kind : null]),
    [
      ['place', 'bid', 0],
      ['place', 'write', 2],
    ],
  );

  const live = [order({ id: 1n }), order({ id: 2n, kind: 'AskWrite', price: 2_100_000n })];
  assert.deepEqual(plan(live, targets()), [], 'on target: nothing to send');
  assert.deepEqual(plan(live, targets({ bid: { price: 1_950_000n, units: 100n } })), [], 'a 263 bps move is noise');

  const moved = plan(live, targets({ bid: { price: 2_000_000n, units: 100n } }));
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.type, 'replace');
  assert.equal((moved[0] as Extract<MmAction, { type: 'replace' }>).orderId, 1n);

  const extras = plan([...live, order({ id: 3n })], targets());
  assert.deepEqual(extras, [{ type: 'cancel', longId: 1n, orderIds: [1n], reason: 'extra bid 1' }], 'the newest order of a kind is kept');

  const halted = plan(live, null, { haltReason: 'fair-stale' });
  assert.deepEqual(halted, [{ type: 'cancel', longId: 1n, orderIds: [1n, 2n], reason: 'fair-stale' }]);
  assert.deepEqual(plan([order({ cancelled: true }), order({ id: 5n, filled: 100n })], null), [], 'dead orders need nothing');

  const noWrite = plan(live, targets({ write: null }));
  assert.deepEqual(noWrite, [{ type: 'cancel', longId: 1n, orderIds: [2n], reason: 'no write target' }]);
});

test('planSeriesActions: expired escrowed orders are reclaimed; a quote about to expire is re-placed (replace keeps validUntil)', () => {
  const expiredBid = order({ id: 7n, validUntil: NOW - 1 });
  const expiredWrite = order({ id: 8n, kind: 'AskWrite', validUntil: NOW - 1 });
  assert.equal(isReclaimable(expiredBid, NOW), true);
  assert.equal(isReclaimable(expiredWrite, NOW), false, 'an AskWrite escrows nothing');
  // The kill switch: live orders and escrowed expired ones; never an expired AskWrite, a cancelled or a filled order.
  const expiredResale = order({ id: 9n, kind: 'AskResale', validUntil: NOW - 1 });
  assert.deepEqual(
    [order({ id: 1n }), expiredBid, expiredResale, expiredWrite, order({ id: 2n, cancelled: true, validUntil: NOW - 1 }), order({ id: 3n, filled: 100n })].filter((o) => isKillTarget(o, NOW)).map((o) => o.id),
    [1n, 7n, 9n],
  );
  const halted = plan([expiredBid, expiredWrite], null, { haltReason: 'market-closed' });
  assert.deepEqual(halted, [{ type: 'cancel', longId: 1n, orderIds: [7n], reason: 'reclaim expired Bid 7' }]);
  const quoting = plan([expiredBid], targets({ write: null }));
  assert.equal(quoting[0]!.type, 'cancel');
  assert.equal(quoting[1]!.type, 'place');

  const expiring = plan([order({ id: 1n, validUntil: NOW + 300 })], targets({ write: null }));
  assert.deepEqual(expiring.map((a) => a.type), ['cancel', 'place']);
  assert.deepEqual(plan([order({ id: 1n, validUntil: NOW + 300 })], targets({ write: null }), { validUntil: { ...validUntil, bid: NOW + 300 } }), [], 'no later validUntil allowed: keep it');
});

test('orderActions: cancels, then shrinking replaces, then growing ones, then places', () => {
  const r = (orderId: bigint, units: bigint, fromUnits: bigint): MmAction => ({ type: 'replace', longId: 1n, slot: 'bid', orderId, price: 1n, units, fromPrice: 1n, fromUnits, reason: '' });
  const p: MmAction = { type: 'place', longId: 2n, slot: 'bid', kind: 0, price: 1n, units: 1n, validUntil: 1, reason: '' };
  const c: MmAction = { type: 'cancel', longId: 3n, orderIds: [9n], reason: '' };
  const out = orderActions([[r(1n, 200n, 100n), p], [c, r(2n, 50n, 100n)]]);
  assert.deepEqual(out.map((a) => (a.type === 'replace' ? `r${a.orderId}` : a.type)), ['cancel', 'r2', 'r1', 'place']);
});

/*//////////////////////////////////////////////////////////////
                    SELECTION, VALIDITY, DELTA
//////////////////////////////////////////////////////////////*/

test('selectSeries: nearest the money, then nearest expiry, capped per market and in all, nothing in its pull window', () => {
  const s = (longId: bigint, underlying: string, strike: bigint, expiry: number) => ({ longId, underlying, isPut: false, strike, expiry });
  const candidates = [
    s(1n, NVDA, 230_000_000n, EXPIRY),
    s(2n, NVDA, 212_500_000n, EXPIRY + 86_400),
    s(3n, NVDA, 212_500_000n, EXPIRY),
    s(4n, TSLA, 400_000_000n, EXPIRY),
    s(5n, NVDA, 210_000_000n, NOW + 1_000),
    s(6n, TSLA, 390_000_000n, EXPIRY),
  ];
  const spots = new Map([
    [NVDA, 210_000_000n],
    [TSLA, 395_000_000n],
  ]);
  const picked = selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: 4, maxSeriesPerMarket: 2 });
  assert.deepEqual(
    picked.map((x) => x.longId),
    [3n, 2n, 4n, 6n],
    'NVDA 212.5 is 119 bps from spot (the nearer expiry first), TSLA 400 and 390 are 126; 5 is in its pull window; 1 is past the per-market cap',
  );
  assert.equal(selectSeries({ now: NOW, candidates: [s(9n, '0x1', 1n, EXPIRY)], spots, pullMinutes: 15, maxSeries: 5, maxSeriesPerMarket: 5 }).length, 1, 'no spot: ranked last, still eligible');
  const epoch = { epochEnd: EXPIRY, index: 1, rollDue: false };
  const withEpoch = selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: 10, maxSeriesPerMarket: 5, epoch });
  assert.equal(withEpoch.some((x) => x.expiry > epoch.epochEnd), false);
  assert.deepEqual(
    selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: 4, maxSeriesPerMarket: 2, epoch: null }).map((x) => x.longId),
    picked.map((x) => x.longId),
    'epoch null does not change selection',
  );
});

test('HALTS appends epoch-outside, epoch-winddown, protocol-cross, other-asker and keeps the original sixteen names', () => {
  assert.deepEqual(HALTS.slice(0, 16), [
    'killed',
    'loss-stop',
    'not-quoter',
    'trading-paused',
    'expired',
    'pull-window',
    'market-closed',
    'market-not-quoted',
    'market-disabled',
    'spot-stale',
    'not-selected',
    'fair-unavailable',
    'fair-stale',
    'fair-spot-mismatch',
    'fair-out-of-bounds',
    'guards-unreadable',
  ]);
  // T-OP-133 appended `other-asker` (MM_ASK_FALLBACK_ONLY): an ask-side-only halt, like protocol-cross.
  assert.deepEqual(HALTS.slice(16), ['epoch-outside', 'epoch-winddown', 'protocol-cross', 'other-asker']);
});

test('haltBeforeFair: epoch-outside costs no /fair; epoch-winddown is a pre-fair halt; epoch null is silent', () => {
  const epoch = { epochEnd: EXPIRY, index: 1, rollDue: false };
  const wind = 14_400; // longer than the pull window so this halt is the one that fires
  assert.equal(haltBeforeFair(haltInput({ epoch: null, epochWindDownS: wind })), null);
  assert.equal(haltBeforeFair(haltInput({ series: series({ expiry: EXPIRY + 1 }), epoch, epochWindDownS: wind }))?.halt, 'epoch-outside');
  assert.equal(haltBeforeFair(haltInput({ now: EXPIRY - wind, epoch, epochWindDownS: wind }))?.halt, 'epoch-winddown');
  assert.equal(haltBeforeFair(haltInput({ now: EXPIRY - wind - 1, epoch, epochWindDownS: wind })), null);
});

test('quoteValidUntil: the tightest of the series limit, the pull time, the session close and the vault lifetime', () => {
  const pull = pullAtOf(EXPIRY, 15);
  assert.equal(quoteValidUntil({ now: NOW, expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: null, maxOrderLifetime: 0 }), pull);
  assert.equal(quoteValidUntil({ now: NOW, expiry: EXPIRY, slot: 'write', pullMinutes: 0, sessionClose: null, maxOrderLifetime: 0 }), EXPIRY - 1_800, 'AskWrite stops at the mint cutoff');
  assert.equal(quoteValidUntil({ now: NOW, expiry: EXPIRY, slot: 'bid', pullMinutes: 0, sessionClose: null, maxOrderLifetime: 0 }), EXPIRY - 1_800, 'every quote is pulled by the mint cutoff');
  assert.equal(quoteValidUntil({ now: NOW, expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: NOW + 3_600, maxOrderLifetime: 0 }), NOW + 3_600);
  assert.equal(quoteValidUntil({ now: NOW, expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: null, maxOrderLifetime: 600 }), NOW + 600);
  assert.equal(quoteValidUntil({ now: pull, expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: null, maxOrderLifetime: 0 }), null);
});

test('netDeltaByUnderlying: units / 100 × delta, per underlying, positions without a delta counted apart', () => {
  const out = netDeltaByUnderlying([
    { underlying: NVDA, units: -300n, delta: 0.4 },
    { underlying: NVDA.toUpperCase().replace('0X', '0x'), units: 100n, delta: 0.25 },
    { underlying: NVDA, units: 50n, delta: null },
    { underlying: TSLA, units: 200n, delta: -0.5 },
    { underlying: TSLA, units: 0n, delta: 0.9 },
  ]);
  assert.ok(Math.abs(out.get(NVDA)!.deltaShares - -0.95) < 1e-9);
  assert.equal(out.get(NVDA)!.unknown, 1);
  assert.equal(out.get(NVDA)!.positions, 3);
  assert.equal(out.get(TSLA)!.deltaShares, -1);
  assert.equal(out.get(TSLA)!.positions, 1);
});

test('halts: a fair value the no-arbitrage bounds refuse (a call at or above spot, a put at or above strike), and one priced at a spot far from the oracle\'s', () => {
  const spot = 210_000_000n;
  const ok = (fair: bigint, fairSpot?: bigint) => ({ ok: true as const, fair, delta: 0.4, iv: 0.5, asOf: NOW - 60, source: 'model', ...(fairSpot === undefined ? {} : { spot: fairSpot }) });
  const params = { ...PARAMS, fairSpotToleranceBps: 300 };
  assert.equal(haltOf(haltInput({ params, spot, fair: ok(spot) }))?.halt, 'fair-out-of-bounds', 'a call is never worth the share');
  const put = { ...series(), isPut: true };
  assert.equal(haltOf(haltInput({ params, spot, series: put, fair: ok(put.strike) }))?.halt, 'fair-out-of-bounds', 'a put is never worth its strike');
  assert.equal(haltOf(haltInput({ params, spot, fair: ok(2_000_000n, (spot * 10_400n) / 10_000n) }))?.halt, 'fair-spot-mismatch', '400 bps apart');
  assert.equal(haltOf(haltInput({ params, spot, fair: ok(2_000_000n, (spot * 10_100n) / 10_000n) })), null, '100 bps apart: quoted, at the oracle spot');
});

test('fairAtSpot: a fair value priced at a slightly different spot is carried to the oracle\'s spot along its delta', () => {
  // delta 0.4, the pricing spot 2 USDG under the oracle's: +0.8 USDG.
  assert.equal(fairAtSpot({ fair: 2_000_000n, delta: 0.4, fairSpot: 208_000_000n, spot: 210_000_000n }), 2_800_000n);
  assert.equal(fairAtSpot({ fair: 500_000n, delta: 0.4, fairSpot: 212_000_000n, spot: 210_000_000n }), 0n, 'never negative');
  assert.equal(fairAtSpot({ fair: 2_000_000n, delta: 0.4, fairSpot: undefined, spot: 210_000_000n }), 2_000_000n, 'no spot in the answer: as it is');
});

test('halts: T-474, the QUOTED fair is judged, so a positive fair that carries to zero at the oracle\'s spot is fair-unavailable', () => {
  const spot = 210_000_000n;
  const params = { ...PARAMS, fairSpotToleranceBps: 300 };
  // 0.5 USDG at delta 0.4, priced 2 USDG above the oracle's spot: 95 bps apart, inside the tolerance. Raw > 0, quoted 0.
  const fair = { ok: true as const, fair: 500_000n, delta: 0.4, iv: 0.5, asOf: NOW - 60, source: 'model', spot: 212_000_000n };
  assert.equal(fairAtSpot({ fair: fair.fair, delta: fair.delta, fairSpot: fair.spot, spot }), 0n, 'the input: quoted at zero');
  const halt = haltOf(haltInput({ params, spot, fair }));
  assert.equal(halt?.halt, 'fair-unavailable', 'a zero QUOTED fair halts, whatever the raw fair was');
  assert.match(halt?.detail ?? '', /is 0 at the oracle's spot/);
  // Control: the same answer with a raw fair that stays positive after the carry is quoted.
  assert.equal(haltOf(haltInput({ params, spot, fair: { ...fair, fair: 2_000_000n } })), null, '2 USDG carries to 1.2 USDG: quoted');
  assert.deepEqual(quotedFairOf({ ...fair, fair: 2_000_000n }, spot), { quoted: 1_200_000n, halt: null });
});

test('halts: T-484, a QUOTED fair below its intrinsic value at the oracle\'s spot is fair-out-of-bounds, for a call and a put', () => {
  const ok = (fair: bigint, fairSpot?: bigint, delta = 0.9) => ({ ok: true as const, fair, delta, iv: 0.5, asOf: NOW - 60, source: 'model', ...(fairSpot === undefined ? {} : { spot: fairSpot }) });
  const params = { ...PARAMS, fairSpotToleranceBps: 300 };

  // CALL, strike 220, oracle spot 230: intrinsic 10 USDG. Exact: 10 USDG passes, one base unit under it halts.
  const call = series({ strike: 220_000_000n });
  const callSpot = 230_000_000n;
  assert.equal(intrinsicOf(call, callSpot), 10_000_000n);
  const low = haltOf(haltInput({ params, series: call, spot: callSpot, fair: ok(9_999_999n) }));
  assert.equal(low?.halt, 'fair-out-of-bounds', 'a call quoted under spot - strike');
  assert.match(low?.detail ?? '', /below the intrinsic 10000000/);
  assert.equal(haltOf(haltInput({ params, series: call, spot: callSpot, fair: ok(10_000_000n) })), null, 'exactly intrinsic is allowed');
  assert.equal(haltOf(haltInput({ params, series: call, spot: callSpot, fair: ok(10_500_000n) })), null, 'intrinsic plus time value');

  // PUT, strike 220, oracle spot 210: intrinsic 10 USDG.
  const put = series({ isPut: true, strike: 220_000_000n });
  const putSpot = 210_000_000n;
  assert.equal(intrinsicOf(put, putSpot), 10_000_000n);
  assert.equal(haltOf(haltInput({ params, series: put, spot: putSpot, fair: ok(9_999_999n, undefined, -0.9) }))?.halt, 'fair-out-of-bounds', 'a put quoted under strike - spot');
  assert.equal(haltOf(haltInput({ params, series: put, spot: putSpot, fair: ok(10_000_000n, undefined, -0.9) })), null, 'exactly intrinsic is allowed');

  // The bound is on the QUOTED fair: a raw 10.3 USDG (above intrinsic) priced 1 USDG ABOVE the oracle's spot at
  // delta 0.5 is quoted at 9.8 USDG, under the intrinsic 10 USDG at the oracle's spot (43 bps apart: inside tolerance).
  const carried = ok(10_300_000n, 231_000_000n, 0.5);
  assert.equal(fairAtSpot({ fair: carried.fair, delta: carried.delta, fairSpot: carried.spot, spot: callSpot }), 9_800_000n, 'the input: quoted at 9.8');
  assert.equal(haltOf(haltInput({ params, series: call, spot: callSpot, fair: carried }))?.halt, 'fair-out-of-bounds', 'judged on the quoted fair, not the raw one');
});

test('halts: T-484, out of the money the intrinsic bound is 0 and a small positive fair is still quoted', () => {
  const ok = (fair: bigint, delta: number) => ({ ok: true as const, fair, delta, iv: 0.5, asOf: NOW - 60, source: 'model' });
  const spot = 210_000_000n;
  const otmCall = series({ strike: 220_000_000n });
  const otmPut = series({ isPut: true, strike: 200_000_000n });
  assert.equal(intrinsicOf(otmCall, spot), 0n);
  assert.equal(intrinsicOf(otmPut, spot), 0n);
  assert.equal(haltOf(haltInput({ series: otmCall, spot, fair: ok(100n, 0.01) })), null, 'OTM call: one tick of fair is quoted');
  assert.equal(haltOf(haltInput({ series: otmPut, spot, fair: ok(100n, -0.01) })), null, 'OTM put: one tick of fair is quoted');
  // At the money the bound is also 0.
  assert.equal(intrinsicOf(series({ strike: spot }), spot), 0n);
});

test('fairCheckOf: T-484, the ONE fair check haltOf runs, and the quoted fair it hands the planner', () => {
  const spot = 210_000_000n;
  const params = { ...PARAMS, fairSpotToleranceBps: 300 };
  const base = { now: NOW, series: series(), params, sessionOpen: true, spot };
  const fair = { ok: true as const, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf: NOW - 60, source: 'model', spot: 208_000_000n };
  assert.deepEqual(fairCheckOf({ ...base, fair }), { halt: null, quoted: 2_800_000n }, 'passes, quoted at the oracle spot');
  // Every fair halt haltOf reports comes from here, with the same name.
  const cases: Array<[Parameters<typeof fairCheckOf>[0]['fair'], string]> = [
    [undefined, 'fair-unavailable'],
    [{ ok: false, reason: 'no-quotes' }, 'fair-unavailable'],
    [{ ...fair, asOf: NOW - 1_801 }, 'fair-stale'],
    [{ ...fair, fair: 0n }, 'fair-unavailable'],
    [{ ...fair, spot: (spot * 10_400n) / 10_000n }, 'fair-spot-mismatch'],
    [{ ...fair, fair: 500_000n, spot: 212_000_000n }, 'fair-unavailable'],
    [{ ...fair, fair: spot }, 'fair-out-of-bounds'],
  ];
  for (const [f, expected] of cases) {
    const checked = fairCheckOf({ ...base, fair: f });
    assert.equal(checked.halt?.halt, expected);
    assert.equal(checked.quoted, null, 'a halted fair hands the planner nothing to quote');
    assert.deepEqual(haltOf(haltInput({ params, spot, fair: f })), checked.halt, 'haltOf reports exactly what fairCheckOf said');
  }
  // No positive oracle spot: nothing to quote at, and no halt of its own (haltOf's rule before T-484).
  assert.deepEqual(fairCheckOf({ ...base, spot: null, fair }), { halt: null, quoted: null });
});
