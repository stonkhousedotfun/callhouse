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
  EVENT_HALT_REASONS,
  EXTRAPOLATED_HALT_CAUSE,
  marketSafetyHalt,
  SpotMoveBreaker,
  type MarketSafetyInput,
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
  mintCutoffOf,
  moveBps,
  netDeltaByUnderlying,
  orderActions,
  planSeriesActions,
  pullAtOf,
  quotePrices,
  type QuoteFees,
  quoteLifeOf,
  quoteValidUntil,
  validUntilAt,
  roundDownToTick,
  roundUpToTick,
  selectSeries,
  skewUsdg6,
  widenBps,
  writeStopAtOf,
  type HaltInput,
  type LiveOrder,
  type MmAction,
  type QuoteParams,
  type SeriesInfo,
  askFloorNetUsdg6,
  deltaBandRank,
  localGreeks,
  SAFEST_ASK_DEFAULTS,
  safestAskOf,
  volBumpUsdg6,
} from './engine.js';
import { bsDelta, bsGamma, bsVega, tradingYears } from '../pricing/bs.js';
import { MM_OPEN_GRACE_DEFAULT_S } from '../config.js';

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
  // The safest-ask floors EXPLICITLY OFF here, so the price tests below keep asserting the base formula they
  // were written for. The shaping has its own tests (the SAFEST_ASK blocks), which start from the defaults.
  intrinsicBufferBps: 0,
  minPremiumUsdg6: 0n,
  volMarkupPts: 0,
};

const series = (over: Partial<SeriesInfo> = {}): SeriesInfo => ({ longId: 1n, underlying: NVDA, isPut: false, strike: 220_000_000n, expiry: EXPIRY, ...over });

/** The v8 launch fee set: 5 % on a first sale, 0 % on a resale (the registry's fee table). */
const LAUNCH_FEES: QuoteFees = { current: { premiumFeeBps: 500, resaleFeeBps: 0 }, pending: null };
/** No fee at all: the pre-v8 arithmetic, so the existing price tests keep asserting what they were written for. */
const NO_FEES: QuoteFees = { current: { premiumFeeBps: 0, resaleFeeBps: 0 }, pending: null };

const price = (over: Partial<Parameters<typeof quotePrices>[0]> = {}) =>
  quotePrices({ now: NOW, series: series(), fair: 2_000_000n, delta: 0.4, spot: 210_000_000n, netDeltaShares: 0, askFloors: { write: 0n, resale: 0n }, bidCap: 21_000_000n, fees: NO_FEES, params: PARAMS, ...over });

/*//////////////////////////////////////////////////////////////
                    THE SELLER FEE IN THE ASK
//////////////////////////////////////////////////////////////*/

test('the write ask is grossed up so the seller fee still leaves the target, at the v8 launch parameters', () => {
  // The book credits a selling maker `premium - sellerFee + rebate`, so the ask must be the GROSS
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
  // The second half, and the trap the whole per-slot design exists for. If the resale ask were derived
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

  // An OUT-of-the-money put (strike 200 < spot 210). At strike 220 the put is 10 USDG in the money while the
  // fixture's fair is 2 USDG -- a fair fairCheckOf halts before it ever prices -- and P4's intrinsic floor lifts both asks
  // to intrinsic, which hides the skew this line is about.
  const put = price({ series: series({ isPut: true, strike: 200_000_000n }), delta: -0.6, netDeltaShares: 1 });
  const putFlat = price({ series: series({ isPut: true, strike: 200_000_000n }), delta: -0.6 });
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

  const floored = price({ askFloors: { write: 2_500_001n, resale: 2_500_001n } });
  assert.equal(floored.ask, 2_500_100n);
  assert.ok(floored.clampedBy.includes('ask-floor'));

  const deepItm = price({ fair: 30_000_000n, askFloors: { write: 40_000_000n, resale: 40_000_000n }, bidCap: 45_000_000n });
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
  const floor = price({ askFloors: { write: 2_100_000n, resale: 2_100_000n }, fair: 2_000_000n, params: { ...PARAMS, halfSpreadBps: 1, minHalfSpreadUsdg6: 0n } });
  assert.equal(floor.ask, 2_100_000n);
  assert.equal(floor.resale, floor.ask, 'never under the floor');
});

test('each ask clears its OWN kind\'s floor (askFloorOf per kind), not one floor applied to both', () => {
  const tight = { ...PARAMS, halfSpreadBps: 1, minHalfSpreadUsdg6: 0n };
  // Resale floor under the write floor (the House fork: 775 328 write, 736 561 resale). The write ask is held at its
  // floor; the resale rests at its own target, above its own floor. One floor for both pushed the resale up to 2.5.
  const split = price({ fair: 2_300_000n, askFloors: { write: 2_500_000n, resale: 2_200_000n }, params: tight });
  assert.equal(split.ask, 2_500_000n, 'the write ask is held at the write floor');
  assert.equal(split.resale, 2_300_200n, 'the resale rests one tick under the target, over its own floor and under the write floor');
  // Resale floor above the write floor: the resale falls back to the write ask and is lifted to its own floor. Held to
  // the write floor alone it would rest at 2.0 and revert BadPrice.
  const high = price({ askFloors: { write: 0n, resale: 2_500_001n } });
  assert.equal(high.ask, 2_100_000n, 'the write ask is not touched by the resale floor');
  assert.equal(high.resale, 2_500_100n, 'lifted to the resale floor, rounded up to the tick');
  assert.ok(high.clampedBy.includes('ask-floor'));
  assert.ok(high.bid === null || high.bid < high.resale);
});

test('judgeReplace: an ask is judged against its own slot\'s floor', () => {
  const floors = { write: 2_500_000n, resale: 2_200_000n };
  const judge = (kind: 'AskWrite' | 'AskResale', slot: 'write' | 'resale', at: bigint) =>
    judgeReplace({ order: order({ kind, price: at }), target: { price: at, units: 100n }, slot, askFloors: floors, bidCap: 0n, params: PARAMS });
  assert.equal(judge('AskResale', 'resale', 2_300_000n).replace, false, 'a resale over its own floor rests, though it is under the write floor');
  assert.match(judge('AskResale', 'resale', 2_100_000n).reason, /below the resale ask floor 2200000/);
  assert.match(judge('AskWrite', 'write', 2_300_000n).reason, /below the write ask floor 2500000/);
});

test('planSeriesActions: targets without ask floors pull the series (a failed floor read is never a zero floor)', () => {
  const live = [order({ id: 21n, kind: 'Bid' }), order({ id: 22n, kind: 'AskWrite', price: 2_100_000n })];
  const actions = planSeriesActions({ longId: 1n, now: NOW, orders: live, targets: targets(), validUntil, askFloors: null, bidCap: 10_000_000n, refreshS: 600, params: PARAMS });
  assert.deepEqual(actions.map((a) => a.type), ['cancel']);
  assert.deepEqual((actions[0] as Extract<MmAction, { type: 'cancel' }>).orderIds, [21n, 22n]);
  assert.match((actions[0] as Extract<MmAction, { type: 'cancel' }>).reason, /ask floors unread/);
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
    // A House vault's own brake (HouseVault._requireQuoting reverts place/replace TradingPaused).
    [{ quotingPaused: true }, 'quoting-paused'],
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
  // The book-wide pause is named first; the vault's own brake is a pre-fair halt (no /fair is spent on it).
  assert.equal(haltOf(haltInput({ tradingPaused: true, quotingPaused: true }))?.halt, 'trading-paused');
  assert.equal(haltBeforeFair(haltInput({ quotingPaused: true }))?.halt, 'quoting-paused');
  assert.equal(haltBeforeFair(haltInput({ quotingPaused: false })), null);
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
    judgeReplace({ order: o, target, slot, askFloors: { write: 0n, resale: 0n }, bidCap: 10_000_000n, params: PARAMS });

  assert.equal(judge(order(), { price: 1_957_000n, units: 100n }).replace, false, '300 bps is not more than 300');
  assert.equal(judge(order(), { price: 1_957_200n, units: 100n }).replace, true, '301 bps');
  assert.equal(judge(order(), { price: 1_843_000n, units: 100n }).replace, false);
  assert.equal(judge(order(), { price: 1_842_800n, units: 100n }).replace, true);
  assert.equal(judge(order({ filled: 40n }), { price: 1_900_000n, units: 100n }).replace, false, '60 left of 100 is inside MM_RESIZE_BPS');
  assert.equal(judge(order({ filled: 60n }), { price: 1_900_000n, units: 100n }).replace, true, '40 left is under half the target');
  assert.equal(judge(order({ units: 500n }), { price: 1_900_000n, units: 100n }).replace, true, 'more than the target is always resized');
  assert.match(judgeReplace({ order: order(), target: { price: 1_900_000n, units: 100n }, slot: 'bid', askFloors: { write: 0n, resale: 0n }, bidCap: 1_800_000n, params: PARAMS }).reason, /above the bid cap/);
  assert.match(judgeReplace({ order: order({ kind: 'AskWrite' }), target: { price: 1_900_000n, units: 100n }, slot: 'write', askFloors: { write: 2_000_000n, resale: 0n }, bidCap: 0n, params: PARAMS }).reason, /below the write ask floor/);
});

const targets = (over: Partial<Record<'bid' | 'write' | 'resale', { price: bigint; units: bigint } | null>> = {}) => ({
  bid: { price: 1_900_000n, units: 100n },
  write: { price: 2_100_000n, units: 100n },
  resale: null,
  ...over,
});
const validUntil = { bid: EXPIRY - 3_600, write: EXPIRY - 3_600, resale: EXPIRY - 3_600 };
const plan = (orders: LiveOrder[], t: ReturnType<typeof targets> | null, over: Partial<Parameters<typeof planSeriesActions>[0]> = {}) =>
  planSeriesActions({ longId: 1n, now: NOW, orders, targets: t, validUntil, askFloors: { write: 0n, resale: 0n }, bidCap: 10_000_000n, refreshS: 600, params: PARAMS, ...over });

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
  // Taking an order off that the bot's rules no longer allow is protective (sent on the read that finds it).
  assert.deepEqual(extras, [{ type: 'cancel', longId: 1n, orderIds: [1n], reason: 'extra bid 1', protective: true }], 'the newest order of a kind is kept');

  const halted = plan(live, null, { haltReason: 'fair-stale' });
  assert.deepEqual(halted, [{ type: 'cancel', longId: 1n, orderIds: [1n, 2n], reason: 'fair-stale', protective: true }]);
  assert.deepEqual(plan([order({ cancelled: true }), order({ id: 5n, filled: 100n })], null), [], 'dead orders need nothing');

  const noWrite = plan(live, targets({ write: null }));
  assert.deepEqual(noWrite, [{ type: 'cancel', longId: 1n, orderIds: [2n], reason: 'no write target', protective: true }]);
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

test('planSeriesActions: no replace inside the replace margin; a quote that must move is placed fresh, one that need not lapses', () => {
  // The keeper defaults: POLL_INTERVAL_MS 60 s + KEEPER_TX_TIMEOUT_MS 180 s. OrderBook.replace reverts OrderNotLive
  // once the block reaches validUntil, and a replace sent now can land up to that long after.
  const MARGIN = 240;
  const moved = targets({ bid: { price: 2_000_000n, units: 100n }, write: null });
  // The v9 MakerVault's maxOrderLifetime 300 s caps the new validUntil, so the refresh branch (a later validUntil by
  // more than refreshS) never fires in these cases: only the replace margin decides.
  const over = { refreshS: 120, replaceMarginS: MARGIN, validUntil: { ...validUntil, bid: NOW + 300 } };
  const at = (left: number, t = moved) => plan([order({ id: 1n, validUntil: NOW + left })], t, over);

  assert.deepEqual(at(MARGIN).map((a) => a.type), ['replace'], 'exactly at the margin a replace still has time to land');
  const inside = at(MARGIN - 1);
  assert.deepEqual(inside.map((a) => a.type), ['cancel', 'place'], 'one second inside it: cancel and place fresh, never replace');
  assert.deepEqual((inside[0] as Extract<MmAction, { type: 'cancel' }>).orderIds, [1n]);
  const fresh = inside[1] as Extract<MmAction, { type: 'place' }>;
  assert.equal(fresh.validUntil, NOW + 300, 'the fresh order takes the validUntil allowed now, not the dying one');
  assert.equal(fresh.price, 2_000_000n);
  assert.match(fresh.reason, /placed fresh, not replaced/);
  assert.deepEqual(at(1).map((a) => a.type), ['cancel', 'place'], 'one second before validUntil');
  assert.deepEqual(at(MARGIN - 1, targets({ write: null })), [], 'inside the margin and on target: nothing is sent, the quote lapses');

  // Without replaceMarginS the margin is refreshS (never off). A later validUntil of only 200 s keeps the refresh branch out.
  const noMargin = (left: number) => plan([order({ id: 1n, validUntil: NOW + left })], moved, { refreshS: 120, validUntil: { ...validUntil, bid: NOW + 200 } });
  assert.deepEqual(noMargin(120).map((a) => a.type), ['replace']);
  assert.match((noMargin(119)[1] as Extract<MmAction, { type: 'place' }>).reason, /placed fresh, not replaced/);
});

test('orderActions: cancels, protective and unit-shrinking replaces, ask places, escrow-only bid replaces, bid places, the rest', () => {
  type R = Extract<MmAction, { type: 'replace' }>;
  const r = (orderId: bigint, over: Partial<R> = {}): MmAction => ({ type: 'replace', longId: 1n, slot: 'bid', orderId, price: 100n, units: 100n, fromPrice: 100n, fromUnits: 100n, reason: '', ...over });
  const p = (longId: bigint, slot: 'bid' | 'write' | 'resale'): MmAction => ({ type: 'place', longId, slot, kind: 0, price: 1n, units: 1n, validUntil: 1, reason: '' });
  const c: MmAction = { type: 'cancel', longId: 3n, orderIds: [9n], reason: '' };
  const out = orderActions([
    [r(1n, { units: 200n }), p(10n, 'bid')], // r1: routine, more units -> last group, growing
    [c, r(2n, { units: 50n })], // r2: fewer units -> early
    [r(3n, { price: 90n })], // r3: routine bid, same units, lower price -> escrow-only
    [r(4n, { slot: 'write', price: 120n, fromPrice: 100n })], // r4: routine ask price move, frees nothing -> last group, shrinking side
    [r(5n, { price: 80n, protective: true }), p(11n, 'write')], // r5: protective -> early
    [p(12n, 'resale'), r(6n, { price: 120n })], // r6: routine bid up -> last group
  ]);
  const name = (a: MmAction) => (a.type === 'replace' ? `r${a.orderId}` : a.type === 'place' ? `p${a.longId}` : a.type);
  assert.deepEqual(out.map(name), ['cancel', 'r2', 'r5', 'p11', 'p12', 'r3', 'p10', 'r4', 'r6', 'r1']);
});

/**
 * The order cannot over-commit. The send budget may cut the list at ANY point; for every prefix each resource the
 * vault checks is at most the larger of where the tick started and where the whole list ends: units (notional), write
 * units (collateral) and bid escrow (price x units). The scenarios are BALANCED, a place paid for by what a replace frees,
 * so the bound is tight: moving the place ahead of what pays for it breaks it (the control below).
 */
test('orderActions: every prefix holds each resource at or under max(start, end)', () => {
  type A = MmAction;
  const rep = (orderId: bigint, slot: 'bid' | 'write', fromPrice: bigint, price: bigint, fromUnits: bigint, units: bigint, protective = false): A =>
    ({ type: 'replace', longId: orderId, slot, orderId, price, units, fromPrice, fromUnits, reason: '', ...(protective ? { protective: true as const } : {}) });
  const place = (longId: bigint, slot: 'bid' | 'write' | 'resale', price: bigint, units: bigint): A => ({ type: 'place', longId, slot, kind: 0, price, units, validUntil: 1, reason: '' });
  const scenarios: A[][][] = [
    // a write shrinks 50 units, a write place of 40 and a bid place of 10 spend them; a bid lowered 1000 -> 800 pays the bid place's escrow
    [[place(10n, 'write', 1n, 40n)], [rep(1n, 'write', 5n, 5n, 100n, 50n)], [place(11n, 'bid', 900n, 10n)], [rep(2n, 'bid', 1_000n, 800n, 100n, 100n)]],
    // the same freed by a protective bid (over its cap) and a routine ask requote that frees nothing
    [[place(12n, 'bid', 900n, 20n)], [rep(3n, 'write', 5n, 6n, 100n, 100n)], [rep(4n, 'bid', 1_000n, 800n, 100n, 100n, true)]],
    // a routine bid raised and grown is paid by a bid cut in units
    [[rep(5n, 'bid', 800n, 1_000n, 100n, 120n)], [rep(6n, 'bid', 1_000n, 1_000n, 100n, 60n)], [place(13n, 'resale', 1n, 20n)]],
  ];
  const use = (a: A) =>
    a.type === 'replace'
      ? { units: a.units - a.fromUnits, write: a.slot === 'write' ? a.units - a.fromUnits : 0n, escrow: a.slot === 'bid' ? a.price * a.units - a.fromPrice * a.fromUnits : 0n }
      : a.type === 'place'
        ? { units: a.units, write: a.slot === 'write' ? a.units : 0n, escrow: a.slot === 'bid' ? a.price * a.units : 0n }
        : { units: 0n, write: 0n, escrow: 0n };
  const keys = ['units', 'write', 'escrow'] as const;
  for (const [n, perSeries] of scenarios.entries()) {
    // Every rotation of the series priority: the bound may not depend on which series the planner ranked first.
    for (let k = 0; k < perSeries.length; k++) {
      const out = orderActions([...perSeries.slice(k), ...perSeries.slice(0, k)]);
      const end = out.reduce((acc, a) => ({ units: acc.units + use(a).units, write: acc.write + use(a).write, escrow: acc.escrow + use(a).escrow }), { units: 0n, write: 0n, escrow: 0n });
      const at = { units: 0n, write: 0n, escrow: 0n };
      for (const [i, a] of out.entries()) {
        for (const key of keys) {
          at[key] += use(a)[key];
          const bound = end[key] > 0n ? end[key] : 0n;
          assert.ok(at[key] <= bound, `scenario ${n} rotation ${k}, prefix ${i + 1} (${a.type}): ${key} ${at[key]} over max(start 0, end ${end[key]})`);
        }
      }
    }
  }
});

/*//////////////////////////////////////////////////////////////
                    SELECTION, VALIDITY, DELTA
//////////////////////////////////////////////////////////////*/

test('selectSeries (deltaBand: null, the original ranking): nearest the money, then nearest expiry, capped per market and in all, nothing in its pull window', () => {
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
  const picked = selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: 4, maxSeriesPerMarket: 2, deltaBand: null });
  assert.deepEqual(
    picked.map((x) => x.longId),
    [3n, 2n, 4n, 6n],
    'NVDA 212.5 is 119 bps from spot (the nearer expiry first), TSLA 400 and 390 are 126; 5 is in its pull window; 1 is past the per-market cap',
  );
  assert.equal(selectSeries({ now: NOW, candidates: [s(9n, '0x1', 1n, EXPIRY)], spots, pullMinutes: 15, maxSeries: 5, maxSeriesPerMarket: 5, deltaBand: null }).length, 1, 'no spot: ranked last, still eligible');
  const epoch = { epochEnd: EXPIRY, index: 1, rollDue: false };
  const withEpoch = selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: 10, maxSeriesPerMarket: 5, epoch, deltaBand: null });
  assert.equal(withEpoch.some((x) => x.expiry > epoch.epochEnd), false);
  assert.deepEqual(
    selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: 4, maxSeriesPerMarket: 2, epoch: null, deltaBand: null }).map((x) => x.longId),
    picked.map((x) => x.longId),
    'epoch null does not change selection',
  );
});

test('HALTS appends epoch-outside, epoch-winddown, protocol-cross, other-asker, then the four market-safety halts, fair-before-open and quoting-paused, and keeps the original sixteen names', () => {
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
  // A change appended `other-asker` (MM_ASK_FALLBACK_ONLY): an ask-side-only halt, like protocol-cross.
  assert.deepEqual(HALTS.slice(16, 20), ['epoch-outside', 'epoch-winddown', 'protocol-cross', 'other-asker']);
  // A change appended the market-safety halts P7, P8, P15 and the fair halt P9.
  assert.deepEqual(HALTS.slice(20, 24), ['spot-age', 'open-grace', 'spot-move-breaker', 'event-uncertainty']);
  // Safe call selling appended the fair halt for a chain from before the open.
  assert.deepEqual(HALTS.slice(24, 25), ['fair-before-open']);
  // A change appended the House vault's own quoting brake (HouseVault.quotingPaused).
  assert.deepEqual(HALTS.slice(25), ['quoting-paused']);
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

test('halts: the QUOTED fair is judged, so a positive fair that carries to zero at the oracle\'s spot is fair-unavailable', () => {
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

test('halts: a QUOTED fair below its intrinsic value at the oracle\'s spot is fair-out-of-bounds, for a call and a put', () => {
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

test('halts: out of the money the intrinsic bound is 0 and a small positive fair is still quoted', () => {
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

test('fairCheckOf: the ONE fair check haltOf runs, and the quoted fair it hands the planner', () => {
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
  // No positive oracle spot: nothing to quote at, and no halt of its own (haltOf's earlier rule).
  assert.deepEqual(fairCheckOf({ ...base, spot: null, fair }), { halt: null, quoted: null });
});

/*//////////////////////////////////////////////////////////////
          MARKET-SAFETY HALTS AND P9
//////////////////////////////////////////////////////////////*/

// A session day: the open at 13:30 UTC (09:30 NY, EDT), `now` an hour later. Times are unix seconds.
const OPEN = 1_790_083_800;
const IN_SESSION = OPEN + 3_600;
const safety = (over: Partial<MarketSafetyInput> = {}): MarketSafetyInput => ({
  now: IN_SESSION,
  sessionOpen: true,
  sessionOpenAtGrace: true,
  spotObservedAt: IN_SESSION - 30,
  spotObservedInSession: true,
  breaker: null,
  params: { maxSpotAgeS: 120, openGraceS: 900 },
  ...over,
});

test('marketSafetyHalt P7 spot-age: the freshest corroborated observation older than MM_MAX_SPOT_AGE_S in session halts; at the limit it quotes; 0 opts out', () => {
  assert.equal(marketSafetyHalt(safety()), null, 'a 30 s old observation quotes');
  assert.equal(marketSafetyHalt(safety({ spotObservedAt: IN_SESSION - 120 })), null, 'exactly the limit quotes');
  assert.equal(marketSafetyHalt(safety({ spotObservedAt: IN_SESSION - 121 }))?.halt, 'spot-age');
  assert.match(String(marketSafetyHalt(safety({ spotObservedAt: IN_SESSION - 121 }))?.detail), /121 s old \(limit 120\)/);
  assert.equal(marketSafetyHalt(safety({ spotObservedAt: null, params: { maxSpotAgeS: 120, openGraceS: 0 } }))?.halt, 'spot-age', 'no observation at all is not fresh');
  assert.equal(marketSafetyHalt(safety({ spotObservedAt: IN_SESSION - 7_200, params: { maxSpotAgeS: 0, openGraceS: 900 } })), null, 'MM_MAX_SPOT_AGE_S=0 is the explicit opt-out');
});

test('marketSafetyHalt P8 open-grace: BOTH an in-session observation today AND the grace since the open ("whichever is later"); 0 opts out', () => {
  // Inside the grace, even with a fresh in-session print: the AutoRoller would roll here (it accepts either), the MM waits.
  assert.equal(marketSafetyHalt(safety({ now: OPEN + 300, spotObservedAt: OPEN + 290, sessionOpenAtGrace: false }))?.halt, 'open-grace');
  // Past the grace, but the last observation is yesterday's (a feed that has not printed since the close, no pool).
  const stale = marketSafetyHalt(safety({ spotObservedAt: OPEN - 86_400 + 3_600 }));
  assert.equal(stale?.halt, 'open-grace');
  assert.match(String(stale?.detail), /no in-session spot observation today/);
  // Past the grace, today's date, but observed OUTSIDE a session (a pre-market print): AutoRoller's test refuses it too.
  assert.equal(marketSafetyHalt(safety({ spotObservedAt: OPEN - 600, spotObservedInSession: false, params: { maxSpotAgeS: 0, openGraceS: 900 } }))?.halt, 'open-grace');
  assert.equal(marketSafetyHalt(safety({ spotObservedInSession: null }))?.halt, 'open-grace', 'an unread session fact fails closed');
  // Both halves hold: quotes.
  assert.equal(marketSafetyHalt(safety({ now: OPEN + 900, spotObservedAt: OPEN + 880 })), null);
  assert.equal(marketSafetyHalt(safety({ now: OPEN + 300, spotObservedAt: OPEN + 290, sessionOpenAtGrace: false, params: { maxSpotAgeS: 120, openGraceS: 0 } })), null, 'MM_OPEN_GRACE_S=0 is the explicit opt-out');
});

test('at the keeper default open grace nothing quotes at open + 29 min (bid, ask and resale alike, and what rests from before the open is cancelled); at open + 31 min quoting resumes', () => {
  // The grace is read from the
  // keeper's own default, so a default back at 900 s turns the 29-minute case red.
  const graceS = MM_OPEN_GRACE_DEFAULT_S;
  // quoter.ts sets sessionOpenAtGrace from calendar.isRegularSession(now - openGraceS) (reads.ts readSpotClocks): the
  // session was already open a grace ago. Here the session opened at OPEN, and the oracle printed ten seconds ago.
  const at = (minutes: number) => {
    const now = OPEN + minutes * 60;
    const marketHalt = marketSafetyHalt(safety({ now, spotObservedAt: now - 10, sessionOpenAtGrace: now - graceS >= OPEN, params: { maxSpotAgeS: 120, openGraceS: graceS } }));
    return { marketHalt, halt: haltBeforeFair(haltInput({ marketHalt })) };
  };

  const early = at(29);
  assert.equal(early.marketHalt?.halt, 'open-grace', 'open + 29 min is inside the grace');
  assert.equal(early.halt?.halt, 'open-grace', 'the series halts on it before any fair is asked (haltBeforeFair)');
  // A halted series has no targets (planner.ts prices only an unhalted series), and planSeriesActions pulls every live
  // order of it: one of each slot, resting from before the open.
  const resting = [order({ id: 1n }), order({ id: 2n, kind: 'AskWrite', price: 2_100_000n }), order({ id: 3n, kind: 'AskResale', price: 2_050_000n })];
  assert.deepEqual(plan(resting, null, { haltReason: early.halt!.halt }), [{ type: 'cancel', longId: 1n, orderIds: [1n, 2n, 3n], reason: 'open-grace', protective: true }], 'bid, ask and resale are all cancelled');
  assert.deepEqual(plan([], null, { haltReason: 'open-grace' }), [], 'and nothing is placed');

  const late = at(31);
  assert.equal(late.marketHalt, null, 'open + 31 min is past the grace');
  assert.equal(late.halt, null, 'nothing else halts the series');
  const resumed = plan([], targets({ resale: { price: 2_050_000n, units: 100n } }));
  assert.deepEqual(resumed.map((a) => (a.type === 'place' ? a.slot : a.type)), ['bid', 'write', 'resale'], 'every slot quotes again');
});

test('marketSafetyHalt: the breaker wins, then open-grace, then spot-age; outside a session nothing (market-closed is the planner\'s)', () => {
  const tripped = { halt: 'spot-move-breaker' as const, detail: 'x' };
  assert.equal(marketSafetyHalt(safety({ breaker: tripped, sessionOpenAtGrace: false, spotObservedAt: null }))?.halt, 'spot-move-breaker');
  assert.equal(marketSafetyHalt(safety({ sessionOpenAtGrace: false, spotObservedAt: IN_SESSION - 500 }))?.halt, 'open-grace', 'open-grace before spot-age');
  assert.equal(marketSafetyHalt(safety({ sessionOpen: false, breaker: tripped, spotObservedAt: null })), null);
});

test('SpotMoveBreaker P15: a move above MM_BREAKER_BPS inside the window halts MM_BREAKER_HALT_S; a slower or smaller move does not; 0 is off', () => {
  const b = new SpotMoveBreaker({ bps: 150, windowS: 300, haltS: 900 });
  const U = NVDA;
  assert.equal(b.observe(U, 1_000, 200_000_000n), null);
  assert.equal(b.observe(U, 1_100, 202_900_000n), null, '145 bps: under the limit');
  assert.equal(b.haltOf(U, 1_100), null);
  const moved = b.observe(U, 1_200, 203_100_000n); // 155 bps over the reading at t=1000, still inside 300 s
  assert.equal(moved, 155n);
  assert.equal(b.haltOf(U, 1_200)?.halt, 'spot-move-breaker');
  assert.match(String(b.haltOf(U, 1_200)?.detail), /200000000 -> 203100000 \(155 bps > 150 in 300 s\); halted until 2100/);
  assert.equal(b.haltOf(U, 2_099)?.halt, 'spot-move-breaker', 'held for MM_BREAKER_HALT_S');
  assert.equal(b.haltOf(U, 2_100), null, 'released after it');
  assert.equal(b.haltOf(TSLA, 1_200), null, 'per market');

  const slow = new SpotMoveBreaker({ bps: 150, windowS: 300, haltS: 900 });
  slow.observe(U, 1_000, 200_000_000n);
  assert.equal(slow.observe(U, 1_301, 210_000_000n), null, 'the same 500 bps outside the window: the old reading is dropped');

  const down = new SpotMoveBreaker({ bps: 150, windowS: 300, haltS: 900 });
  down.observe(U, 1_000, 200_000_000n);
  assert.equal(down.observe(U, 1_060, 196_000_000n), 200n, 'a fall trips it as a rise does');

  const off = new SpotMoveBreaker({ bps: 0, windowS: 300, haltS: 900 });
  off.observe(U, 1_000, 200_000_000n);
  assert.equal(off.observe(U, 1_001, 300_000_000n), null, 'MM_BREAKER_BPS=0 is the explicit opt-out');
  assert.equal(off.haltOf(U, 1_001), null);
});

test('haltBeforeFair: a market-safety halt is judged right after spot-stale and before epoch and selection, and costs no /fair', () => {
  const breaker = { halt: 'spot-move-breaker' as const, detail: 'moved' };
  assert.deepEqual(haltBeforeFair(haltInput({ marketHalt: breaker })), breaker);
  assert.equal(haltBeforeFair(haltInput({ marketHalt: breaker, spotFresh: false }))?.halt, 'spot-stale', 'spot-stale first');
  assert.equal(haltBeforeFair(haltInput({ marketHalt: breaker, selected: false }))?.halt, 'spot-move-breaker', 'before not-selected');
  assert.equal(haltBeforeFair(haltInput({ marketHalt: { halt: 'open-grace' }, epoch: { epochEnd: EXPIRY - 1, index: 1, rollDue: false } }))?.halt, 'open-grace', 'before epoch-outside');
  assert.equal(haltBeforeFair(haltInput({ marketHalt: null })), null, 'null is none');
  for (const name of ['spot-age', 'open-grace', 'spot-move-breaker'] as const) assert.equal(haltOf(haltInput({ marketHalt: { halt: name } }))?.halt, name);
});

test('P9 event-uncertainty: a priced fair flagged event- or model-uncertain, or with an event in its window, halts first among the fair checks; a clean or absent quality block does not', () => {
  const fair = { ok: true as const, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf: NOW - 60, source: 'cboe' };
  assert.deepEqual(EVENT_HALT_REASONS, ['event-uncertainty', 'model-uncertainty', 'model-uncertain']);
  for (const reason of ['event-uncertainty', 'model-uncertainty', 'model-uncertain']) {
    const h = haltOf(haltInput({ fair: { ...fair, quality: { reasons: ['extrapolated', reason] } } }));
    assert.equal(h?.halt, 'event-uncertainty', reason);
    assert.match(String(h?.detail), new RegExp(reason));
  }
  assert.equal(haltOf(haltInput({ fair: { ...fair, quality: { reasons: [], eventInWindow: true } } }))?.halt, 'event-uncertainty');
  // First among the fair checks: a stale AND event-flagged fair names the event.
  assert.equal(haltOf(haltInput({ fair: { ...fair, asOf: NOW - 99_999, quality: { reasons: ['event-uncertainty'] } } }))?.halt, 'event-uncertainty');
  assert.equal(haltOf(haltInput({ fair: { ...fair, quality: { reasons: ['extrapolated', 'clock-early-close'], eventInWindow: false } } })), null, 'other reasons do not halt');
  // An UNKNOWN calendar (event.input missing/short) does not halt on its own: an empty events.json would otherwise quote
  // nothing on every day. A known flag with an unknown calendar names both.
  assert.equal(haltOf(haltInput({ fair: { ...fair, quality: { reasons: [], eventInWindow: false, eventInput: 'missing' } } })), null);
  assert.match(String(haltOf(haltInput({ fair: { ...fair, quality: { reasons: ['model-uncertainty'], eventInput: 'short' } } }))?.detail), /model-uncertainty \(event calendar: short\)/);
  // An extrapolated read (a date with no listed option expiry near it, e.g. SPCX Monday to Thursday before its
  // first Friday listing) names the missing listing, not the calendar: what the service answers for it with no events.
  const extrapolated = String(haltOf(haltInput({ fair: { ...fair, quality: { reasons: ['extrapolated', 'event-uncertainty', 'model-uncertainty'], eventInWindow: false, eventInput: 'missing' } } }))?.detail);
  assert.equal(extrapolated, `${EXTRAPOLATED_HALT_CAUSE} (pricing flagged event-uncertainty, model-uncertainty)`);
  assert.doesNotMatch(extrapolated, /event calendar/, 'a missing calendar is not the cause of an extrapolated read');
  assert.match(String(haltOf(haltInput({ fair: { ...fair, quality: { reasons: ['extrapolated', 'event-uncertainty'], eventInWindow: true, eventInput: 'supplied' } } }))?.detail), /extrapolated \(pricing flagged event-uncertainty\) \(event calendar: supplied\)$/, 'a supplied calendar with a real event is still named');
  assert.equal(haltOf(haltInput({ fair })), null, 'no quality block: an older service, no halt');
  // The planner's pricing branch runs the same check (fairCheckOf).
  assert.equal(fairCheckOf({ now: NOW, series: series(), params: PARAMS, sessionOpen: true, fair: { ...fair, quality: { reasons: ['event-uncertainty'] } }, spot: 210_000_000n }).halt?.halt, 'event-uncertainty');
});

/*//////////////////////////////////////////////////////////////
          THE SAFEST ASK
//////////////////////////////////////////////////////////////*/

/** PARAMS with the knobs back at their DEFAULTS (PARAMS turns the floors off for the base-formula tests). */
const SAFEST: QuoteParams = { ...PARAMS, intrinsicBufferBps: undefined, minPremiumUsdg6: undefined, volMarkupPts: undefined };

test('defaults: an absent knob is the default, never off; safestAskOf reads each one', () => {
  assert.deepEqual(safestAskOf({}), { ...SAFEST_ASK_DEFAULTS });
  assert.equal(safestAskOf(SAFEST).minPremiumUsdg6, 20_000n);
  assert.equal(safestAskOf({ minPremiumUsdg6: 0n }).minPremiumUsdg6, 0n, 'an explicit 0 is the opt-out');
  assert.equal(safestAskOf({ volMarkupPts: 7 }).volMarkupPts, 7);
});

test('P3 vol bump: vega x (askIv - iv) when /fair sent askIv; vega x MM_VOL_MARKUP_PTS / 100 otherwise; never negative', () => {
  // vega 0.5 USD per 1.00 of vol, askIv 4 points above iv: 0.5 x 0.04 = 0.02 USDG.
  assert.deepEqual(volBumpUsdg6({ iv: 0.4, askIv: 0.44, vega: 0.5, volMarkupPts: 2 }), { bump: 20_000n, how: 'ask-iv' });
  // No askIv: 2 points -> 0.5 x 0.02 = 0.01 USDG.
  assert.deepEqual(volBumpUsdg6({ iv: 0.4, askIv: null, vega: 0.5, volMarkupPts: 2 }), { bump: 10_000n, how: 'vol-markup' });
  assert.deepEqual(volBumpUsdg6({ iv: 0.4, vega: 0.5, volMarkupPts: 2 }), { bump: 10_000n, how: 'vol-markup' });
  // An askIv BELOW iv is no markup, never a discount.
  assert.deepEqual(volBumpUsdg6({ iv: 0.4, askIv: 0.3, vega: 0.5, volMarkupPts: 2 }), { bump: 0n, how: 'none' });
  for (const vega of [null, 0, -1, Number.NaN]) assert.equal(volBumpUsdg6({ iv: 0.4, askIv: 0.5, vega, volMarkupPts: 2 }).bump, 0n, `vega ${vega}`);
  assert.equal(volBumpUsdg6({ iv: 0.4, vega: 0.5, volMarkupPts: 0 }).bump, 0n, 'MM_VOL_MARKUP_PTS 0 is off');
  // Rounded UP: 0.3 x 0.0001 = 0.00003 USDG = 30 base units exactly; 0.3333 x 0.0001 -> 33.33 -> 34.
  assert.equal(volBumpUsdg6({ iv: 0.4, askIv: 0.4001, vega: 0.3333, volMarkupPts: 0 }).bump, 34n);
});

test('P4 + P5 floor: intrinsic at the oracle spot + MM_INTRINSIC_BUFFER_BPS of spot, or MM_MIN_PREMIUM_USDG6, whichever is higher', () => {
  const spot = 210_000_000n;
  // OTM call: intrinsic 0, 5 bps of 210 = 0.105 USDG > 0.02 minimum.
  assert.deepEqual(askFloorNetUsdg6({ series: { isPut: false, strike: 220_000_000n }, spot, intrinsicBufferBps: 5, minPremiumUsdg6: 20_000n }), { floor: 105_000n, by: 'intrinsic-buffer' });
  // ITM call: 10 USDG intrinsic + 0.105.
  assert.deepEqual(askFloorNetUsdg6({ series: { isPut: false, strike: 200_000_000n }, spot, intrinsicBufferBps: 5, minPremiumUsdg6: 20_000n }), { floor: 10_105_000n, by: 'intrinsic-buffer' });
  // ITM put: strike 220 - spot 210.
  assert.equal(askFloorNetUsdg6({ series: { isPut: true, strike: 220_000_000n }, spot, intrinsicBufferBps: 0, minPremiumUsdg6: 0n }).floor, 10_000_000n);
  // OTM, buffer off: the minimum premium, independent of any fair.
  assert.deepEqual(askFloorNetUsdg6({ series: { isPut: false, strike: 250_000_000n }, spot, intrinsicBufferBps: 0, minPremiumUsdg6: 20_000n }), { floor: 20_000n, by: 'min-premium' });
  // Buffer rounds UP: 1 bp of 210.000001 USDG.
  assert.equal(askFloorNetUsdg6({ series: {}, spot: 210_000_001n, intrinsicBufferBps: 1, minPremiumUsdg6: 0n }).floor, 21_001n);
});

test('P3 in quotePrices: the vol bump lifts both asks and not the bid; tagged for /state', () => {
  const base = price({ params: SAFEST, fair: 2_000_000n, fees: LAUNCH_FEES });
  const bumped = price({ params: SAFEST, fair: 2_000_000n, fees: LAUNCH_FEES, iv: 0.4, askIv: 0.6, vega: 0.5 });
  // 0.5 x 0.2 = 0.10 USDG on the ungrossed target, grossed at 5 %.
  assert.equal(bumped.volBump, 100_000n);
  assert.ok(bumped.ask > base.ask && bumped.resale > base.resale, `ask ${base.ask} -> ${bumped.ask}, resale ${base.resale} -> ${bumped.resale}`);
  assert.equal(bumped.bid, base.bid, 'the bid never moves for an ask rule');
  assert.ok(bumped.clampedBy.includes('ask-iv'));
  const fallback = price({ params: SAFEST, fair: 2_000_000n, fees: LAUNCH_FEES, iv: 0.4, vega: 0.5 });
  assert.equal(fallback.volBump, 10_000n, 'no askIv: vega x 2 points');
  assert.ok(fallback.clampedBy.includes('vol-markup'));
});

test('P4 / P5 in quotePrices: a tiny fair is asked at the minimum premium; an ITM series at intrinsic + buffer, not below', () => {
  const tiny = price({ params: SAFEST, fair: 1_000n, delta: 0.01, series: series({ strike: 260_000_000n }) });
  // OTM: the buffer (5 bps of 210 = 0.105) beats the 0.02 minimum; fair + half-spread would have been 0.021.
  assert.equal(tiny.ask, 105_000n);
  assert.ok(tiny.clampedBy.includes('intrinsic-buffer'));
  const noBuffer = price({ params: { ...SAFEST, intrinsicBufferBps: 0 }, fair: 1_000n, delta: 0.01, series: series({ strike: 260_000_000n }) });
  assert.equal(noBuffer.ask, 21_000n, 'fair 0.001 + min half-spread 0.02 = 0.021, above the 0.02 minimum');
  const noBufferLow = price({ params: { ...SAFEST, intrinsicBufferBps: 0, minHalfSpreadUsdg6: 0n, halfSpreadBps: 1 }, fair: 1_000n, delta: 0.01, series: series({ strike: 260_000_000n }) });
  assert.equal(noBufferLow.ask, 20_000n, 'the minimum premium alone holds the ask');
  assert.ok(noBufferLow.clampedBy.includes('min-premium'));
  const itm = price({ params: SAFEST, fair: 9_000_000n, delta: 0.9, series: series({ strike: 200_000_000n }) });
  assert.ok(itm.ask >= 10_105_000n && itm.resale >= 10_105_000n, `ITM asks ${itm.ask} / ${itm.resale} at least intrinsic 10 + 0.105`);
});

test('PROPERTY: for the same inputs the shaped ask and resale are never below the unshaped ones, and the bid never above', () => {
  // A seeded LCG so a failure reproduces: 4000 random quotes across fair, delta, spot, strike, side, skew, floors, fees.
  let seed = 0x2200n;
  const rand = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    return Number(seed >> 11n) / 2 ** 53;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const OFF: QuoteParams = { ...PARAMS, intrinsicBufferBps: 0, minPremiumUsdg6: 0n, volMarkupPts: 0 };
  for (let i = 0; i < 4_000; i += 1) {
    const spot = BigInt(Math.floor(20_000_000 + rand() * 400_000_000));
    const strike = BigInt(Math.floor(Number(spot) * (0.7 + rand() * 0.6)));
    const fair = BigInt(Math.floor(rand() * 15_000_000));
    // A third of the floors sit within a few ticks of the fair, where the resale falls back to the write ask: the
    // corner the explicit max() on the resale exists for (a uniform draw alone never landed there).
    const floorKind = pick(['zero', 'uniform', 'near'] as const);
    const askFloor = floorKind === 'zero' ? 0n : floorKind === 'uniform' ? BigInt(Math.floor(rand() * 5_000_000)) : fair + BigInt(Math.floor(rand() * 400_000));
    // The resale floor is its own read (askFloorOf(id, false)); half the draws give it a value of its own.
    const resaleFloor = rand() < 0.5 ? askFloor : BigInt(Math.floor(rand() * Number(askFloor + 400_000n)));
    const input = {
      now: NOW - Math.floor(rand() * 20_000),
      series: series({ isPut: rand() < 0.5, strike }),
      fair,
      delta: rand() * 2 - 1,
      spot,
      netDeltaShares: rand() * 40 - 20,
      askFloors: { write: askFloor, resale: resaleFloor },
      bidCap: BigInt(Math.floor(rand() * 30_000_000)),
      fees: pick([NO_FEES, LAUNCH_FEES, { current: { premiumFeeBps: 900, resaleFeeBps: 300 }, pending: null }]),
      iv: rand(),
      askIv: pick([null, rand() * 2]),
      vega: pick([null, rand() * 3, 0]),
    };
    const shapedParams: QuoteParams = { ...PARAMS, intrinsicBufferBps: Math.floor(rand() * 200), minPremiumUsdg6: BigInt(Math.floor(rand() * 200_000)), volMarkupPts: rand() * 10 };
    const before = quotePrices({ ...input, params: OFF, vega: null, askIv: null });
    const after = quotePrices({ ...input, params: shapedParams });
    const ctx = () => JSON.stringify({ i, ...input, params: shapedParams, before, after }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    // The message is built only on a failure (a template literal would stringify 4000 contexts).
    if (!(after.ask >= before.ask)) assert.fail(`ask lowered ${before.ask} -> ${after.ask}: ${ctx()}`);
    if (!(after.resale >= before.resale)) assert.fail(`resale lowered ${before.resale} -> ${after.resale}: ${ctx()}`);
    if (!(after.bid === null || (before.bid !== null && after.bid <= before.bid))) assert.fail(`bid raised ${before.bid} -> ${after.bid}: ${ctx()}`);
    if (!(after.bid === null || after.bid < after.ask)) assert.fail(`crossed: ${ctx()}`);
    // Each ask clears its OWN kind's floor, or the vault reverts it BadPrice.
    for (const q of [before, after]) {
      if (!(q.ask >= askFloor)) assert.fail(`write ask ${q.ask} under its floor ${askFloor}: ${ctx()}`);
      if (!(q.resale >= resaleFloor)) assert.fail(`resale ${q.resale} under its floor ${resaleFloor}: ${ctx()}`);
    }
  }
});

test('localGreeks: pricing/bs.ts at the fair\'s iv on the trading clock, from the oracle spot; null for a non-input', () => {
  const s = series({ strike: 220_000_000n });
  const g = localGreeks({ now: NOW, series: s, spot: 210_000_000n, vol: 0.5 })!;
  const bs = { type: 'call' as const, spot: 210, strike: 220, vol: 0.5, t: tradingYears(NOW, EXPIRY) };
  assert.equal(g.delta, bsDelta(bs));
  assert.equal(g.gamma, bsGamma(bs));
  assert.equal(g.vega, bsVega(bs));
  assert.ok(g.vega > 0 && g.gamma > 0 && g.delta > 0 && g.delta < 0.5);
  assert.equal(localGreeks({ now: NOW, series: s, spot: 0n, vol: 0.5 }), null);
  assert.equal(localGreeks({ now: NOW, series: s, spot: 210_000_000n, vol: Number.NaN }), null);
});

test('P16 selectSeries: by default the 0.10-0.30 delta wings come before the at-the-money series; deltaBandHi 0 restores nearest the money', () => {
  const spot = 210_000_000n;
  const spots = new Map([[NVDA.toLowerCase(), spot]]);
  const mk = (longId: bigint, strike: bigint) => ({ longId, underlying: NVDA, isPut: false, strike, expiry: EXPIRY });
  // Strikes from ATM outwards; one day out at the 0.5 selection vol.
  const candidates = [mk(1n, 210_000_000n), mk(2n, 210_500_000n), mk(3n, 211_000_000n), mk(4n, 211_500_000n), mk(5n, 212_000_000n), mk(6n, 213_000_000n), mk(7n, 215_000_000n)];
  const deltaOf = (c: (typeof candidates)[number]) => Math.abs(localGreeks({ now: NOW, series: c, spot, vol: 0.5 })!.delta);
  const inBand = candidates.filter((c) => deltaOf(c) >= 0.1 && deltaOf(c) <= 0.3).map((c) => c.longId);
  assert.ok(inBand.length > 0 && !inBand.includes(1n), `fixture: some wing is in the band, ATM is not (${candidates.map((c) => deltaOf(c).toFixed(3)).join(' ')})`);
  const picked = selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: inBand.length, maxSeriesPerMarket: 10 }).map((x) => x.longId);
  assert.deepEqual([...picked].sort(), [...inBand].sort(), 'the band fills the caps first');
  const legacy = selectSeries({ now: NOW, candidates, spots, pullMinutes: 15, maxSeries: 1, maxSeriesPerMarket: 10, deltaBand: { lo: 0.1, hi: 0, vol: 0.5 } });
  assert.deepEqual(legacy.map((x) => x.longId), [1n], 'hi 0: nearest the money');
  assert.deepEqual(deltaBandRank(candidates[0]!, undefined, NOW, { lo: 0.1, hi: 0.3, vol: 0.5 }), { outside: Number.POSITIVE_INFINITY, fromMid: Number.POSITIVE_INFINITY }, 'no spot ranks last');
});

test('the never-lower max() on the RESALE: a raised target can let the resale clear the vault floor at its own (lower-fee) price, below the write ask the unshaped rule fell back to', () => {
  // Launch fees: 5 % on a write, 0 % on a resale. Unshaped: target 1.20, under 1.19 < floor 1.20 -> the resale falls back
  // to the grossed write ask, 1.2632. A 0.02 vol bump: target 1.22, under 1.21 >= 1.20 -> the resale could rest at 1.21.
  const q = (over: Partial<Parameters<typeof quotePrices>[0]>) =>
    quotePrices({ now: NOW, series: series({ strike: 260_000_000n }), fair: 1_100_000n, delta: 0.1, spot: 210_000_000n, netDeltaShares: 0, askFloors: { write: 1_200_000n, resale: 1_200_000n }, bidCap: 21_000_000n, fees: LAUNCH_FEES, params: { ...PARAMS, halfSpreadBps: 1, minHalfSpreadUsdg6: 100_000n, expiryWidenBps: 0 }, ...over });
  const unshaped = q({});
  assert.equal(unshaped.resale, unshaped.ask, 'fixture: the unshaped resale fell back to the write ask');
  const bumped = q({ iv: 0.4, askIv: 0.44, vega: 0.5 });
  assert.equal(bumped.volBump, 20_000n);
  assert.ok(bumped.resale >= unshaped.resale, `resale ${unshaped.resale} -> ${bumped.resale}: a vol MARKUP must not lower the resale`);
});

/*//////////////////////////////////////////////////////////////
       SAFE CALL SELLING
//////////////////////////////////////////////////////////////*/

test('fairCheckOf: in session, a fair priced on a chain dated before the open halts fair-before-open; off, or off hours, it does not', () => {
  // Ten minutes into the session: a chain dated a minute before the open is 601 s old, well inside MM_FAIR_MAX_AGE_S.
  const open = NOW - 600;
  const fair = (asOf: number) => ({ ok: true as const, fair: 2_000_000n, delta: 0.4, iv: 0.5, asOf, source: 'cboe' });
  const base = { now: NOW, series: series(), params: PARAMS, sessionOpen: true, spot: 210_000_000n };
  // Younger than MM_FAIR_MAX_AGE_S (1800) and still the previous close's chain: only this rule sees it.
  const before = fairCheckOf({ ...base, fair: fair(open - 1), sessionOpenedAt: open });
  assert.equal(before.halt?.halt, 'fair-before-open');
  assert.equal(before.quoted, null);
  assert.equal(fairCheckOf({ ...base, fair: fair(open), sessionOpenedAt: open }).halt, null, 'a chain as of the open itself is this session\'s');
  assert.equal(fairCheckOf({ ...base, fair: fair(open - 1) }).halt, null, 'undefined: MM_FAIR_FROM_SESSION=0');
  assert.equal(fairCheckOf({ ...base, fair: fair(open - 1), sessionOpenedAt: null }).halt?.halt, 'fair-before-open', 'an open session whose open cannot be placed halts rather than guesses');
  assert.equal(fairCheckOf({ ...base, sessionOpen: false, fair: fair(open - 1), sessionOpenedAt: null }).halt, null, 'off hours there is no open to be before');
  // haltOf reports exactly what fairCheckOf decided: one rule.
  assert.deepEqual(haltOf(haltInput({ fair: fair(open - 1), sessionOpenedAt: open, spot: 210_000_000n })), before.halt);
  // Order: fair-before-open is judged before fair-stale. A chain dated before the open that is ALSO past
  // MM_FAIR_MAX_AGE_S names the real cause; at the shipped defaults (open grace = fair age = 1800 s) every pre-open
  // chain seen after the grace is both, so judged the other way round fair-before-open could never fire in session.
  const graceOver = NOW;
  const openedAt = graceOver - 1_800;
  const preOpenAndStale = fairCheckOf({ ...base, fair: fair(openedAt - 1), sessionOpenedAt: openedAt });
  assert.equal(preOpenAndStale.halt?.halt, 'fair-before-open', 'pre-open and 1801 s old: the cause is the chain, not its age');
  // A fair from this session that has gone stale is still fair-stale, and so is any stale fair while the rule is off.
  assert.equal(fairCheckOf({ ...base, now: NOW + 3_600, fair: fair(NOW - 1), sessionOpenedAt: openedAt }).halt?.halt, 'fair-stale');
  assert.equal(fairCheckOf({ ...base, fair: fair(NOW - 1_801) }).halt?.halt, 'fair-stale', 'MM_FAIR_FROM_SESSION=0');
});

test('judgeReplace: an ask under its slot\'s spot-lag floor is replaced whatever the move; at the floor it is not', () => {
  const order: LiveOrder = { id: 1n, kind: 'AskWrite', price: 2_990_000n, units: 100n, filled: 0n, validUntil: NOW + 600, cancelled: false };
  const target = { price: 3_000_000n, units: 100n };
  const judge = (over: Partial<Parameters<typeof judgeReplace>[0]> = {}) => judgeReplace({ order, target, slot: 'write', askFloors: { write: 0n, resale: 0n }, bidCap: 0n, params: PARAMS, ...over });
  assert.equal(judge().replace, false, 'a 0.33 % move is inside MM_REQUOTE_BPS');
  const under = judge({ safeFloor: 2_995_000n });
  assert.equal(under.replace, true);
  assert.match(under.reason, /below the spot-lag floor 2995000/);
  assert.equal(judge({ safeFloor: 2_990_000n }).replace, false);
});

test('judgeReplace: a bid over the spot-lag cap is replaced whatever the move; at or under the cap it is not', () => {
  // The market fell, the print did not, and the bid still rests at the pre-fall fair.
  const order: LiveOrder = { id: 1n, kind: 'Bid', price: 2_000_000n, units: 100n, filled: 0n, validUntil: NOW + 600, cancelled: false };
  const target = { price: 1_990_000n, units: 100n };
  const judge = (over: Partial<Parameters<typeof judgeReplace>[0]> = {}) => judgeReplace({ order, target, slot: 'bid', askFloors: { write: 0n, resale: 0n }, bidCap: 10_000_000n, params: PARAMS, ...over });
  assert.equal(judge().replace, false, 'the setup: a 0.5 % move is inside MM_REQUOTE_BPS, under the vault bid cap');
  const over = judge({ safeFloor: 1_995_000n });
  assert.equal(over.replace, true);
  assert.match(over.reason, /bid 2000000 above the spot-lag cap 1995000/);
  assert.equal(judge({ safeFloor: 2_000_000n }).replace, false, 'at the cap it rests');
  assert.equal(judge({ safeFloor: 5_000_000n }).replace, false, 'under the cap it rests');
  assert.match(judge({ bidCap: 1_900_000n, safeFloor: 1_995_000n }).reason, /above the bid cap 1900000/, 'the vault\'s own cap is judged first');
  // An ask's floor is never read as a cap, nor the other way round.
  assert.equal(judgeReplace({ order: { ...order, kind: 'AskWrite', price: 3_000_000n }, target: { price: 3_000_000n, units: 100n }, slot: 'write', askFloors: { write: 0n, resale: 0n }, bidCap: 0n, safeFloor: 2_000_000n, params: PARAMS }).replace, false);
});

test('planSeriesActions: each slot is held to its own spot-lag bound, the asks to their floors and the bid to its cap', () => {
  const orders: LiveOrder[] = [
    { id: 10n, kind: 'Bid', price: 2_010_000n, units: 100n, filled: 0n, validUntil: NOW + 3_600, cancelled: false },
    { id: 11n, kind: 'AskWrite', price: 3_100_000n, units: 100n, filled: 0n, validUntil: NOW + 3_600, cancelled: false },
    { id: 12n, kind: 'AskResale', price: 3_050_000n, units: 100n, filled: 0n, validUntil: NOW + 3_600, cancelled: false },
  ];
  const input = {
    longId: 1n,
    now: NOW,
    orders,
    targets: { bid: { price: 2_000_000n, units: 100n }, write: { price: 3_150_000n, units: 100n }, resale: { price: 3_060_000n, units: 100n } },
    validUntil: { bid: NOW + 3_600, write: NOW + 3_600, resale: NOW + 3_600 },
    askFloors: { write: 0n, resale: 0n },
    bidCap: 10_000_000n,
    refreshS: 60,
    params: PARAMS,
    // The write floor (5 % grossed) is above the live write ask; the resale floor is under the live resale ask; the bid's
    // cap is under the live bid, which is within MM_REQUOTE_BPS of its target.
    safeFloor: { write: 3_150_000n, resale: 3_000_000n, bid: 2_000_000n },
  };
  const slots = (a: ReturnType<typeof planSeriesActions>) => a.map((x) => (x.type === 'replace' ? `${x.type}:${x.slot}:${x.orderId}` : x.type));
  const actions = planSeriesActions(input);
  assert.deepEqual(slots(actions), ['replace:bid:10', 'replace:write:11']);
  assert.match((actions[0] as Extract<MmAction, { type: 'replace' }>).reason, /above the spot-lag cap/);
  assert.deepEqual(slots(planSeriesActions({ ...input, safeFloor: { ...input.safeFloor, bid: 2_010_000n } })), ['replace:write:11'], 'a bid at its cap rests');
});

test('quoteLifeOf + validUntilAt: the same validUntil as quoteValidUntil at any send time, and a later send lives later', () => {
  const cases = [
    { expiry: EXPIRY, slot: 'bid' as const, pullMinutes: 15, sessionClose: null, maxOrderLifetime: 0 },
    { expiry: EXPIRY, slot: 'write' as const, pullMinutes: 0, sessionClose: null, maxOrderLifetime: 0, writeStopAt: EXPIRY - 7_200 },
    { expiry: EXPIRY, slot: 'bid' as const, pullMinutes: 15, sessionClose: NOW + 3_600, maxOrderLifetime: 0 },
    { expiry: EXPIRY, slot: 'bid' as const, pullMinutes: 15, sessionClose: null, maxOrderLifetime: 600 },
    { expiry: EXPIRY, slot: 'resale' as const, pullMinutes: 15, sessionClose: NOW + 3_600, maxOrderLifetime: 300, maxQuoteLifetime: 180 },
    { expiry: EXPIRY, slot: 'bid' as const, pullMinutes: 15, sessionClose: null, maxOrderLifetime: 300, maxQuoteLifetime: 1_800 },
  ];
  for (const [i, c] of cases.entries()) {
    for (const now of [NOW, NOW + 50, NOW + 3_599, NOW + 3_600, pullAtOf(EXPIRY, 15), EXPIRY]) {
      assert.equal(validUntilAt(quoteLifeOf(c), now), quoteValidUntil({ ...c, now }), `case ${i} at ${now}`);
    }
  }
  const life = quoteLifeOf({ expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: NOW + 3_600, maxOrderLifetime: 300, maxQuoteLifetime: 180 });
  assert.deepEqual(life, { cap: NOW + 3_600, lifetime: 180 });
  assert.equal(validUntilAt(life, NOW + 90), NOW + 270, 'sent 90 s late: still 180 s of life from the send');
  assert.equal(validUntilAt(life, NOW + 3_500), NOW + 3_600, 'the session close still caps it');
});

test('quoteLifeOf with the head time: the vault\'s maxOrderLifetime is anchored at the head block, so a late send never stamps past head + maxOrderLifetime', () => {
  // _boundLifetime reverts PastCutoff above block.timestamp + maxOrderLifetime; the block a place lands in, and the latest
  // block it is simulated at, are never before the head, while the send-time estimate (chainNow) can run ahead of both.
  const head = NOW;
  const vaultBound = quoteLifeOf({ expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: null, maxOrderLifetime: 300, maxQuoteLifetime: 1_800, now: head });
  assert.deepEqual(vaultBound, { cap: head + 300, lifetime: 1_800 });
  for (const late of [0, 1, 90, 299]) assert.ok(validUntilAt(vaultBound, head + late)! <= head + 300, `sent ${late} s after the head`);
  assert.equal(validUntilAt(vaultBound, head + 300), null, 'nothing left of the vault\'s window: not placed');
  // The bot's own shorter lifetime still rides on the send, until the vault's anchored bound is the lower one.
  const own = quoteLifeOf({ expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: null, maxOrderLifetime: 300, maxQuoteLifetime: 180, now: head });
  assert.deepEqual(own, { cap: head + 300, lifetime: 180 });
  assert.equal(validUntilAt(own, head + 90), head + 270);
  assert.equal(validUntilAt(own, head + 200), head + 300, 'sent 200 s late: the vault\'s bound, not send + 180');
  // maxOrderLifetime 0 (no vault bound): nothing to anchor.
  assert.deepEqual(quoteLifeOf({ expiry: EXPIRY, slot: 'bid', pullMinutes: 15, sessionClose: null, maxOrderLifetime: 0, maxQuoteLifetime: 180, now: head }), { cap: pullAtOf(EXPIRY, 15), lifetime: 180 });
});

test('quoteLifeOf: an AskWrite never rests past the mint cutoff, a bid or resale never past expiry (OrderBook._place PastCutoff above the series limit)', () => {
  // OrderBook._place: limit = mintCutoff for AskWrite, mintCutoff + SETTLEMENT_WINDOW (= expiry) otherwise; validUntil above
  // it reverts PastCutoff. With no pull, no write stop and no session close, the series limit is the only cap left.
  const open = { expiry: EXPIRY, pullMinutes: 0, sessionClose: null, maxOrderLifetime: 0 } as const;
  assert.equal(quoteLifeOf({ ...open, slot: 'write' }).cap, mintCutoffOf(EXPIRY));
  for (const slot of ['bid', 'resale'] as const) assert.ok(quoteLifeOf({ ...open, slot }).cap <= EXPIRY, slot);
  assert.equal(validUntilAt(quoteLifeOf({ ...open, slot: 'write' }), mintCutoffOf(EXPIRY)), null, 'at the cutoff: not placed (the book refuses block.timestamp >= limit)');
});

test('planSeriesActions: a place carries its slot\'s life, a replace its order\'s validUntil', () => {
  const life = { cap: EXPIRY - 3_600, lifetime: 180 };
  const placed = plan([], targets(), { life: { bid: life, write: life } });
  const places = placed.filter((a): a is Extract<MmAction, { type: 'place' }> => a.type === 'place');
  assert.ok(places.length === 2 && places.every((p) => p.life === life), 'both places carry the life they are restamped from');
  assert.ok(plan([], targets()).every((a) => a.type !== 'place' || a.life === undefined), 'no life given: none attached (sent as planned)');
  const moved = plan([order({ id: 1n, validUntil: NOW + 900 })], targets({ bid: { price: 2_000_000n, units: 100n }, write: null }), { refreshS: 120, replaceMarginS: 240 });
  const replace = moved.find((a): a is Extract<MmAction, { type: 'replace' }> => a.type === 'replace');
  assert.equal(replace?.orderValidUntil, NOW + 900, 'the replace carries the validUntil the quoter re-judges at send');
});

test('quoteValidUntil: the write stop ends an AskWrite, and only an AskWrite', () => {
  const stop = writeStopAtOf(EXPIRY, 60);
  assert.equal(stop, EXPIRY - 1_800 - 3_600, '14:30 New York for a 16:00 expiry');
  const base = { now: stop - 600, expiry: EXPIRY, pullMinutes: 15, sessionClose: null, maxOrderLifetime: 0, writeStopAt: stop };
  assert.equal(quoteValidUntil({ ...base, slot: 'write' }), stop);
  assert.equal(quoteValidUntil({ ...base, slot: 'resale' }), pullAtOf(EXPIRY, 15));
  assert.equal(quoteValidUntil({ ...base, slot: 'bid' }), pullAtOf(EXPIRY, 15));
  assert.equal(quoteValidUntil({ ...base, now: stop, slot: 'write' }), null, 'from the stop on no write can be placed');
  assert.equal(quoteValidUntil({ ...base, writeStopAt: null, slot: 'write' }), pullAtOf(EXPIRY, 15), 'no stop: the pull time, as before');
});
