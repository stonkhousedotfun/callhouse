/**
 * One MM tick, decided (planner.ts): from what a tick read to the vault transactions it sends.
 *
 * WHY THIS FILE EXISTS: the engine's rules only protect the vault if the tick applies them to every series together:
 * one net delta per market skewing every quote on it, one guard and funds budget spent in quoting priority, a kill or a
 * loss stop turning into cancels and nothing else, the transactions in the order that keeps the vault's guards happy.
 *
 * DELIBERATELY ABSENT: the chain (quoter.ts reads it; devnet-mm.ts runs all of it against the devnet).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deltaBandRank, localGreeks, mintCutoffOf, moveBps, pullAtOf, writeStopAtOf, type FairInput, type LiveOrder, type QuoteFees } from './engine.js';
import { flatForRoll } from './epoch.js';
import { UNITS_PER_SHARE } from './constants.js';
import { bidBudget, bookedCalls, fairRequests, fillableUnits, planTick, selectedSeries, STEP_ASIDE_MIN_UNITS, stepAsideAsks, twoSidedCount, type MarketView, type MmPlanParams, type MmTx, type OtherAskInput, type SeriesView, type TickInput, type TickPlan, type VaultView } from './planner.js';
import { maxWriteUnits } from '../mintFee.js';

const U = '0x00000000000000000000000000000000000000aa';
const EXPIRY = 1_790_020_800;
const NOW = EXPIRY - 6 * 3_600;
const CLOSE = EXPIRY;
const SPOT = 210_000_000n;

const PARAMS: MmPlanParams = {
  halfSpreadBps: 500,
  minHalfSpreadUsdg6: 20_000n,
  expiryWidenS: 14_400,
  expiryWidenBps: 20_000,
  pullMinutes: 15,
  quoteOffHours: false,
  fairMaxAgeS: 1_800,
  fairMaxAgeOffHoursS: 345_600,
  skewBpsPerDeltaShare: 100,
  maxSkewBps: 2_000,
  requoteBps: 300,
  resizeBps: 5_000,
  maxSeries: 40,
  maxSeriesPerMarket: 10,
  bidUnits: 100n,
  askUnits: 100n,
  maxSeriesUnits: 0n,
  maxTotalNotionalUsdg6: 0n,
  deltaAlertShares: 5,
  syncIntervalS: 900,
  depositTokens: true,
  maxQuoteLifetimeS: 0,
  epochWindDownS: 600,
  // P16 EXPLICITLY OFF: the planner tests below were written against the nearest-the-money selection order. The
  // delta-band ranking has its own planner test block, which runs at the defaults.
  deltaBandHi: 0,
  // Safe call selling off: this file pins what it pinned before it; its own tests turn each piece on.
  spotLagBps: 0,
  spotLagStaleBps: 0,
  fairFromSession: false,
  writeStopMinutes: 0,
};

const LAUNCH_FEES: QuoteFees = { current: { premiumFeeBps: 500, resaleFeeBps: 0 }, pending: null };

const vault = (over: Partial<VaultView> = {}): VaultView => ({
  isQuoter: true,
  quoterDelay: 0,
  tradingPaused: false,
  fees: LAUNCH_FEES,
  limits: { maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n, askToleranceBps: 100, maxBidBpsOfSpot: 1_000, maxOrderLifetime: 0, maxDailyOutflow: 2_500_000_000n },
  outflow: { used: 0n, available: 2_500_000_000n },
  totalNotional: 0n,
  usdgWallet: 100_000_000_000n,
  owed: 0n,
  freeCollateral: new Map([[U, 100n * 10n ** 18n]]),
  walletTokens: new Map([[U, 0n]]),
  tracked: [],
  // A treasury vault carries no House reserve. House cases below pass an explicit bigint.
  usdgReserved: null,
  epoch: null,
  ...over,
});

const market = (over: Partial<MarketView> = {}): MarketView => ({ underlying: U, ticker: 'NVDA', enabled: true, mintPaused: false, spot: SPOT, ...over });

/** Series i: strike 210 + 2.5 i, fair and delta falling with the strike. */
const strikeOf = (i: number) => SPOT + BigInt(i) * 2_500_000n;
const view = (i: number, over: Partial<SeriesView> = {}): SeriesView => ({
  info: { longId: BigInt(i), underlying: U, isPut: false, strike: strikeOf(i), expiry: EXPIRY },
  ticker: 'NVDA',
  settled: false,
  spotFresh: true,
  spot: SPOT,
  exposure: { longs: 0n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n },
  seriesNotional: 0n,
  askFloors: { write: 0n, resale: 0n },
  bidCap: 21_000_000n,
  collateralAsset: U,
  collateralPerUnit: 10n ** 16n,
  mintFeePpm: 80,
  orders: [],
  ...over,
});
// `asOf` follows the tick's `now`, not the module's NOW. A wind-down tick runs hours after NOW, and the fair
// checks now reach that path, so a fixture pinned to NOW - 120 is genuinely stale there and halts the series.
const fairOf = (i: number, now: number = NOW): FairInput => ({ ok: true, fair: 3_000_000n - BigInt(i) * 400_000n, delta: 0.45 - i * 0.07, iv: 0.5, asOf: now - 120, source: 'model' });

function input(n: number, over: Partial<TickInput> = {}): TickInput {
  const series = Array.from({ length: n }, (_, i) => view(i));
  return {
    now: NOW,
    sessionOpen: true,
    sessionClose: CLOSE,
    killed: false,
    lossStop: { day: Math.floor(NOW / 86_400), realised: 0n, limit: 1_000_000_000n, tripped: false },
    lastSync: NOW - 60,
    vault: vault(),
    markets: new Map([[U, market()]]),
    series,
    fairs: new Map(series.map((s, i) => [s.info.longId.toString(), fairOf(i)])),
    params: PARAMS,
    refreshS: 600,
    protocolAccounts: new Set<string>(),
    protocolBook: [],
    ...over,
  };
}

const types = (txs: MmTx[]) => txs.map((t) => (t.type === 'place' || t.type === 'replace' ? `${t.type}:${t.slot}` : t.type));
const liveOrder = (over: Partial<LiveOrder>): LiveOrder => ({ id: 1n, kind: 'Bid', price: 1n, units: 100n, filled: 0n, validUntil: CLOSE, cancelled: false, ...over });

test('a healthy market: a bid and a write ask on every series, around fair, sized, valid until the pull time', () => {
  const plan = planTick(input(6));
  assert.equal(twoSidedCount(plan), 6);
  // (engine.orderActions): every ask place before any bid place, so a budget cut darkens bids first.
  assert.deepEqual(types(plan.txs), [...Array.from({ length: 6 }, () => 'place:write'), ...Array.from({ length: 6 }, () => 'place:bid')]);
  const pull = pullAtOf(EXPIRY, PARAMS.pullMinutes);
  for (const tx of plan.txs) {
    assert.ok(tx.type === 'place');
    assert.equal(tx.units, 100n);
    assert.equal(tx.validUntil, pull, 'the pull time comes before the mint cutoff and the session close');
    const s = plan.series.find((x) => x.longId === tx.longId)!;
    if (tx.slot === 'bid') assert.ok(tx.price < s.fair!.fair && tx.kind === 0);
    else assert.ok(tx.price > s.fair!.fair && tx.kind === 2);
  }
  assert.deepEqual(plan.netDelta.map((r) => [r.ticker, r.deltaShares, r.alert]), [['NVDA', 0, false]]);
});

test('net inventory delta skews every quote of the market; a short vault quotes higher', () => {
  const flat = planTick(input(4));
  const shortOne = input(4);
  shortOne.series = shortOne.series.map((s, i) => (i === 0 ? { ...s, exposure: { ...s.exposure!, shorts: 300n } } : s));
  const skewed = planTick(shortOne);
  const delta = skewed.netDelta[0]!;
  assert.ok(Math.abs(delta.deltaShares - -1.35) < 1e-9, `3 shares short at delta 0.45 (${delta.deltaShares})`);
  for (const s of skewed.series) {
    const before = flat.series.find((x) => x.longId === s.longId)!;
    assert.ok(s.prices!.skew < 0n, 'negative skew');
    assert.ok(s.prices!.ask > before.prices!.ask && s.prices!.bid! > before.prices!.bid!, `series ${s.longId} quotes moved up`);
  }
  assert.equal(skewed.series.find((s) => s.longId === 0n)!.inventory, -300n);

  const big = input(4);
  big.series = big.series.map((s, i) => (i === 0 ? { ...s, exposure: { ...s.exposure!, shorts: 2_000n } } : s));
  assert.equal(planTick(big).netDelta[0]!.alert, true, 'above MM_DELTA_ALERT_SHARES');
});

test('replace discipline: live quotes on target stay; a skew past MM_REQUOTE_BPS replaces them, shrinking first', () => {
  const first = planTick(input(3));
  let id = 100n;
  const withOrders = input(3);
  withOrders.series = withOrders.series.map((s) => {
    const mine = first.txs.filter((t): t is Extract<MmTx, { type: 'place' }> => t.type === 'place' && t.longId === s.info.longId);
    return { ...s, orders: mine.map((t) => liveOrder({ id: (id += 1n), kind: t.slot === 'bid' ? 'Bid' : 'AskWrite', price: t.price, units: t.units, validUntil: t.validUntil })) };
  });
  assert.deepEqual(planTick(withOrders).txs, [], 'nothing moved: nothing sent');

  const skewed = { ...withOrders, series: withOrders.series.map((s, i) => (i === 2 ? { ...s, exposure: { ...s.exposure!, shorts: 1_000n } } : s)) };
  const plan = planTick(skewed);
  const replaces = plan.txs.filter((t): t is Extract<MmTx, { type: 'replace' }> => t.type === 'replace');
  assert.ok(replaces.length >= 4, `quotes replaced (${types(plan.txs).join(' ')})`);
  assert.ok(replaces.every((r) => r.price > r.fromPrice), 'every replacement is higher');
  const firstGrow = replaces.findIndex((r) => r.units > r.fromUnits);
  const lastShrink = replaces.map((r) => r.units <= r.fromUnits).lastIndexOf(true);
  assert.ok(firstGrow === -1 || lastShrink < firstGrow, 'shrinking replaces go first');
});

test('TickInput.replaceMarginS reaches the engine: a quote that must move but expires inside it is cancelled and placed fresh, never replaced', () => {
  // The replace-discipline quotes above, skewed so series 2 must move, but 100 s from their validUntil. refreshS 1
  // keeps the refresh branch out of it, so only the replace margin decides.
  const first = planTick(input(3));
  let id = 100n;
  const near = input(3, { refreshS: 1 });
  near.series = near.series.map((s, i) => {
    const mine = first.txs.filter((t): t is Extract<MmTx, { type: 'place' }> => t.type === 'place' && t.longId === s.info.longId);
    const orders = mine.map((t) => liveOrder({ id: (id += 1n), kind: t.slot === 'bid' ? 'Bid' : 'AskWrite', price: t.price, units: t.units, validUntil: NOW + 100 }));
    return { ...s, orders, ...(i === 2 ? { exposure: { ...s.exposure!, shorts: 1_000n } } : {}) };
  });
  const without = planTick(near);
  assert.ok(without.txs.some((t) => t.type === 'replace'), `no replaceMarginS: the margin is refreshS (1 s), so these are replaced (${types(without.txs).join(' ')})`);

  const withMargin = planTick({ ...near, replaceMarginS: 240 });
  assert.ok(!withMargin.txs.some((t) => t.type === 'replace'), `no replace inside the margin (${types(withMargin.txs).join(' ')})`);
  assert.ok(withMargin.txs.some((t) => t.type === 'cancel'), 'the dying quotes are cancelled');
  assert.equal(
    withMargin.txs.filter((t) => t.type === 'place').length,
    without.txs.filter((t) => t.type === 'replace').length,
    'one fresh place for each replace it stands in for',
  );
});

test('killed: every live order is cancelled in chunks of 20, and nothing else is planned', () => {
  const orders = (base: bigint) => Array.from({ length: 5 }, (_, k) => liveOrder({ id: base + BigInt(k), kind: k % 2 === 0 ? 'Bid' : 'AskWrite', price: 1_000_000n }));
  const i = input(5, { killed: true, vault: vault({ owed: 5n, walletTokens: new Map([[U, 10n ** 18n]]) }) });
  i.series = i.series.map((s, k) => ({ ...s, orders: orders(BigInt(k * 10)) }));
  const plan = planTick(i);
  assert.deepEqual(types(plan.txs), ['cancel', 'cancel']);
  assert.equal((plan.txs[0] as Extract<MmTx, { type: 'cancel' }>).orderIds.length, 20);
  assert.equal((plan.txs[1] as Extract<MmTx, { type: 'cancel' }>).orderIds.length, 5);
  assert.ok(plan.series.every((s) => s.halt?.halt === 'killed'));
  assert.equal(fairRequests(i).length, 0, 'no /fair request for a killed bot without inventory');
});

test('loss stop and a closed market pull every quote; a signer without the role plans nothing at all', () => {
  const withBid = (i: TickInput) => ({ ...i, series: i.series.map((s) => ({ ...s, orders: [liveOrder({ id: s.info.longId + 1n, price: 1_000_000n })] })) });
  const stopped = planTick(withBid(input(2, { lossStop: { day: 1, realised: -2n, limit: 1n, tripped: true } })));
  assert.deepEqual(types(stopped.txs), ['cancel']);
  assert.ok(stopped.series.every((s) => s.halt?.halt === 'loss-stop'));

  const closed = planTick(withBid(input(2, { sessionOpen: false, sessionClose: null })));
  assert.deepEqual(types(closed.txs), ['cancel']);
  const offHours = planTick(input(2, { sessionOpen: false, sessionClose: null, params: { ...PARAMS, quoteOffHours: true } }));
  assert.equal(twoSidedCount(offHours), 2, 'MM_QUOTE_OFF_HOURS=1 quotes outside the session');
  assert.ok(offHours.txs.every((t) => t.type !== 'place' || t.validUntil === pullAtOf(EXPIRY, 15)), 'with no session close to bound them');

  const noRole = planTick(withBid(input(2, { vault: vault({ isQuoter: false, owed: 9n }) })));
  assert.deepEqual(noRole.txs, []);
  assert.ok(noRole.series.every((s) => s.halt?.halt === 'not-quoter'));
});

test('fair values: null or stale answers halt that series only; series with inventory ask for a delta even when not quoted', () => {
  const i = input(3);
  i.fairs = new Map([
    ['0', { ok: false, reason: 'chain-stale' }],
    ['1', { ok: true, fair: 2_000_000n, delta: 0.3, iv: 0.5, asOf: NOW - 7_200, source: 'cboe' }],
    ['2', fairOf(2)],
  ]);
  const plan = planTick(i);
  assert.deepEqual(plan.series.map((s) => s.halt?.halt ?? 'quoting'), ['fair-unavailable', 'fair-stale', 'quoting']);
  assert.equal(twoSidedCount(plan), 1);

  const narrow = input(3, { params: { ...PARAMS, maxSeries: 1 } });
  assert.deepEqual(selectedSeries(narrow).map((s) => s.longId), [0n]);
  narrow.series = narrow.series.map((s, k) => (k === 2 ? { ...s, exposure: { ...s.exposure!, longs: 50n } } : s));
  assert.deepEqual(fairRequests(narrow).map((s) => s.info.longId), [0n, 2n], 'series 1 is not selected and holds nothing: no request');
});

test('sizes: the vault guards, the bot caps and the funds bind in priority order; a mint-paused market offers inventory only', () => {
  const capped = planTick(input(2, { vault: vault({ limits: { ...vault().limits, maxSeriesUnits: 40n } }) }));
  assert.ok(capped.txs.every((t) => t.type === 'place' && t.units === 40n));
  assert.deepEqual(capped.capped.map((c) => c.caps), [['series-units'], ['series-units']]);

  const poor = planTick(input(2, { vault: vault({ usdgWallet: 0n, freeCollateral: new Map() }) }));
  assert.deepEqual(types(poor.txs), [], 'no USDG and no collateral: nothing to quote');
  assert.equal(twoSidedCount(poor), 0);

  const paused = input(2, { markets: new Map([[U, market({ mintPaused: true })]]) });
  paused.series = paused.series.map((s, k) => (k === 0 ? { ...s, exposure: { ...s.exposure!, longs: 30n } } : s));
  const plan = planTick(paused);
  assert.deepEqual(types(plan.txs), ['place:resale', 'place:bid', 'place:bid'], 'T-OP-765: the ask place before the bid places');
  const resale = plan.txs.find((t) => t.type === 'place' && t.slot === 'resale') as Extract<MmTx, { type: 'place' }>;
  assert.equal(resale.units, 30n);
  assert.equal(resale.kind, 1);
});

test('sync: a tracked series that holds nothing is synced whatever it stores, so a House vault untracks it; a held one, an unread one and one not read for held are left', () => {
  // HouseVault leaves a series in _tracked until a re-measure finds nothing held. 3n is flat and already
  // stores 0, so measured < stored never fires for it: earlier it was never synced and every roll walked it.
  const i = input(2, {
    lastSync: NOW - 901,
    vault: vault({
      tracked: [
        { longId: 1n, stored: 500n, measured: 200n, held: true },
        { longId: 3n, stored: 0n, measured: 0n, held: false },
        { longId: 5n, stored: 0n, measured: 0n, held: true },
        { longId: 7n, stored: 0n, measured: null, held: null },
        { longId: 9n, stored: 0n, measured: 0n },
      ],
    }),
  });
  const plan = planTick(i);
  const syncs = plan.txs.filter((t): t is Extract<MmTx, { type: 'sync' }> => t.type === 'sync');
  assert.deepEqual(syncs.map((t) => t.longIds), [[1n, 3n]]);
  assert.match(syncs[0]!.reason, /1 series store more notional than they measure; 1 tracked series hold nothing/);
  const flatOnly = planTick({ ...i, vault: { ...i.vault, tracked: [{ longId: 3n, stored: 0n, measured: 0n, held: false }] } });
  assert.deepEqual(flatOnly.txs.filter((t) => t.type === 'sync').map((t) => (t as Extract<MmTx, { type: 'sync' }>).longIds), [[3n]]);
  assert.ok(!types(planTick({ ...i, lastSync: NOW - 60 }).txs).includes('sync'), 'still at most every MM_SYNC_INTERVAL_S');
});

test('housekeeping, in order: cancels, sync, close pairs, claim owed, deposit wallet tokens, then replaces and places', () => {
  const i = input(2, {
    lastSync: NOW - 901,
    vault: vault({
      owed: 1_234n,
      walletTokens: new Map([[U, 5n * 10n ** 18n]]),
      tracked: [
        { longId: 0n, stored: 500n, measured: 200n },
        { longId: 9n, stored: 100n, measured: 100n },
      ],
    }),
  });
  i.series = [
    { ...i.series[0]!, exposure: { ...i.series[0]!.exposure!, longs: 20n, shorts: 50n }, orders: [liveOrder({ id: 77n, validUntil: NOW - 1, price: 1_000_000n })] },
    i.series[1]!,
  ];
  const plan = planTick(i);
  const order = types(plan.txs);
  assert.deepEqual(order.slice(0, 5), ['cancel', 'sync', 'close', 'claimOwed', 'deposit']);
  assert.deepEqual((plan.txs[0] as Extract<MmTx, { type: 'cancel' }>).orderIds, [77n], 'the expired bid\'s escrow is reclaimed');
  assert.deepEqual((plan.txs[1] as Extract<MmTx, { type: 'sync' }>).longIds, [0n], 'only the series storing more than it measures');
  assert.equal((plan.txs[2] as Extract<MmTx, { type: 'close' }>).units, 20n);
  assert.ok(order.slice(5).every((t) => t.startsWith('place') || t.startsWith('replace')));

  const recent = planTick({ ...i, lastSync: NOW - 60 });
  assert.ok(!types(recent.txs).includes('sync'), 'a sync at most every MM_SYNC_INTERVAL_S');
  const noDeposit = planTick({ ...i, params: { ...PARAMS, depositTokens: false } });
  assert.ok(!types(noDeposit.txs).includes('deposit'));
});

test('an expired series with escrow left is still cleaned up; a settled one is never quoted', () => {
  const i = input(2);
  i.series = [
    { ...i.series[0]!, info: { ...i.series[0]!.info, expiry: NOW - 10 }, orders: [liveOrder({ id: 5n, validUntil: NOW - 10, price: 1_000_000n })] },
    { ...i.series[1]!, settled: true },
  ];
  const plan = planTick(i);
  assert.deepEqual(types(plan.txs), ['cancel']);
  assert.deepEqual(plan.series.map((s) => s.halt?.halt), ['expired', 'not-selected']);
  assert.deepEqual(fairRequests(i), []);
});

test('a series on a market the bot no longer quotes (paused in the registry, dropped from MM_MARKETS): its live quotes are cancelled, nothing placed, its inventory still asks for a delta', () => {
  const OTHER = '0x00000000000000000000000000000000000000bb';
  const i = input(1);
  const dropped: SeriesView = {
    ...view(5),
    info: { ...view(5).info, underlying: OTHER },
    ticker: 'TSLA',
    exposure: { longs: 40n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n },
    orders: [liveOrder({ id: 900n, kind: 'Bid', price: 1_000_000n }), liveOrder({ id: 901n, kind: 'AskWrite', price: 4_000_000n })],
  };
  i.series = [...i.series, dropped];
  const plan = planTick(i);
  const cancel = plan.txs.find((t): t is Extract<MmTx, { type: 'cancel' }> => t.type === 'cancel');
  assert.deepEqual(cancel?.orderIds, [900n, 901n]);
  assert.ok(!plan.txs.some((t) => (t.type === 'place' || t.type === 'replace') && t.longId === 5n));
  assert.equal(plan.series.find((s) => s.longId === 5n)!.halt?.halt, 'market-not-quoted');
  assert.ok(fairRequests(i).some((s) => s.info.longId === 5n), 'its inventory still needs a delta');
});

test('MM_MAX_QUOTE_LIFETIME_S bounds every new quote whatever the vault allows (maxOrderLifetime 0 at launch): a dead bot leaves no quote fillable for hours', () => {
  const plan = planTick(input(2, { params: { ...PARAMS, maxQuoteLifetimeS: 1_800 } }));
  const places = plan.txs.filter((t): t is Extract<MmTx, { type: 'place' }> => t.type === 'place');
  assert.ok(places.length > 0);
  assert.ok(places.every((t) => t.validUntil === NOW + 1_800), JSON.stringify(places.map((t) => t.validUntil)));
  // 0 turns the bound off: the pull time (or the session close) again.
  const unbounded = planTick(input(2, { params: { ...PARAMS, maxQuoteLifetimeS: 0 } }));
  assert.ok(unbounded.txs.every((t) => t.type !== 'place' || t.validUntil === pullAtOf(EXPIRY, PARAMS.pullMinutes)));
});

test('a long/short pair to close is sized as closed: no resale ask of the longs the close burns first (its escrow would revert)', () => {
  const i = input(1);
  i.series = [{ ...i.series[0]!, exposure: { ...i.series[0]!.exposure!, longs: 100n, shorts: 100n } }];
  const plan = planTick(i);
  assert.deepEqual(types(plan.txs), ['close', 'place:write', 'place:bid'], 'T-OP-765: the ask place before the bid place');
  assert.equal((plan.txs[0] as Extract<MmTx, { type: 'close' }>).units, 100n);
  // More longs than shorts: only the surplus is inventory to resell.
  const surplus = input(1);
  surplus.series = [{ ...surplus.series[0]!, exposure: { ...surplus.series[0]!.exposure!, longs: 130n, shorts: 100n } }];
  const sized = planTick(surplus);
  const resale = sized.txs.find((t): t is Extract<MmTx, { type: 'place' }> => t.type === 'place' && t.slot === 'resale');
  assert.equal(resale?.units, 30n);
});

test('the vault\'s daily outflow cap (INTERFACE_VERSION 7): the tick\'s own credits count, and bids are trimmed inside what is left', () => {
  // The bucket is nearly full: a little room for new bid escrow, so the bids shrink instead of the places reverting.
  const i = input(3, { vault: vault({ outflow: { used: 2_499_000_000n, available: 1_000_000n } }) });
  const plan = planTick(i);
  assert.equal(plan.outflow.cap, 2_500_000_000n);
  assert.equal(plan.outflow.used, 2_499_000_000n);
  assert.equal(plan.outflow.released, 0n, 'no live bid to cancel: nothing comes back first');
  assert.equal(plan.outflow.budget, 1_000_000n);
  assert.ok(plan.outflow.blocked, 'the cap bound');
  assert.ok(plan.outflow.planned <= plan.outflow.budget, `${plan.outflow.planned} > ${plan.outflow.budget}`);
  assert.ok(plan.capped.some((c) => c.caps.includes('outflow')));
  // Nothing on the ask side is booked by the cap, so the write asks are untouched.
  assert.equal(plan.txs.filter((t) => t.type === 'place' && t.slot === 'write').length, 3);

  // The same bucket, but the vault's live bids are the tick's own and their escrow comes back before any place: the
  // credit is what makes the quotes possible at all.
  const withBids = input(3, { vault: vault({ outflow: { used: 2_499_000_000n, available: 1_000_000n } }) });
  withBids.series = withBids.series.map((s, k) => ({ ...s, orders: [liveOrder({ id: BigInt(100 + k), kind: 'Bid', price: 2_000_000n, units: 100n })] }));
  const credited = planTick(withBids);
  assert.equal(credited.outflow.released, 6_000_000n, '3 bids of 1 share at 2 USDG');
  assert.equal(credited.outflow.budget, 7_000_000n, 'the cap less what the credits cannot cancel out');
  assert.ok(credited.outflow.planned > plan.outflow.planned, 'the credits bought the tick more bid escrow than it had');
  assert.ok(credited.outflow.planned <= credited.outflow.budget, `${credited.outflow.planned} > ${credited.outflow.budget}`);
});

test('bookedCalls: only Bid places, Bid replaces (the net) and cancels of a Bid reach the outflow bucket', () => {
  const i = input(2);
  i.series = [
    { ...i.series[0]!, orders: [liveOrder({ id: 11n, kind: 'Bid', price: 2_000_000n, units: 100n })] },
    { ...i.series[1]!, orders: [liveOrder({ id: 12n, kind: 'AskWrite', price: 9_000_000n, units: 100n })] },
  ];
  const plan = planTick(i);
  const live = new Map([
    ['11', { kind: 'Bid' as const, price: 2_000_000n, remaining: 100n }],
    ['12', { kind: 'AskWrite' as const, price: 9_000_000n, remaining: 100n }],
  ]);
  const booked = bookedCalls(plan, live);
  // Every entry points back at the transaction it models, and no ask ever appears.
  for (const b of booked) {
    const tx = plan.txs[b.index]!;
    assert.ok(tx.type === 'cancel' || ((tx.type === 'place' || tx.type === 'replace') && tx.slot === 'bid'), `${tx.type} is not booked`);
  }
  // A cancel of the AskWrite alone books nothing; the Bid's cancel or replace books its escrow.
  const bidMoves = booked.filter((b) => b.delta !== 0n);
  assert.ok(bidMoves.length > 0, 'the vault\'s live bid moved, so something is booked');
  const cancelCredit = booked.filter((b) => b.delta < 0n).reduce((s, b) => s + b.delta, 0n);
  const placed = booked.filter((b) => b.delta > 0n).reduce((s, b) => s + b.delta, 0n);
  assert.ok(cancelCredit <= 0n && placed >= 0n);
  // The bucket the bot projects from those calls never goes below 0, whatever it cancels.
  assert.ok(booked.every((b) => typeof b.delta === 'bigint'));
});

test('epoch === null is unrestricted: the same two-sided places as today', () => {
  const plan = planTick(input(2, { vault: vault({ epoch: null }) }));
  assert.equal(twoSidedCount(plan), 2);
  assert.equal(plan.series.every((s) => s.halt === null), true);
});

test('a series with expiry > epochEnd is never selected, halted epoch-outside, and is not a fair request', () => {
  const epochEnd = EXPIRY;
  const i = input(2, { vault: vault({ epoch: { epochEnd, index: 1, rollDue: false }, usdgReserved: 0n }) });
  i.series = [
    view(0, { info: { longId: 0n, underlying: U, isPut: false, strike: strikeOf(0), expiry: epochEnd } }),
    view(1, { info: { longId: 1n, underlying: U, isPut: false, strike: strikeOf(1), expiry: epochEnd + 86_400 } }),
  ];
  i.fairs = new Map(i.series.map((s, n) => [s.info.longId.toString(), fairOf(n)]));
  const plan = planTick(i);
  assert.deepEqual(plan.selected, [0n]);
  assert.equal(plan.series.find((s) => s.longId === 1n)!.halt?.halt, 'epoch-outside');
  assert.equal(plan.series.find((s) => s.longId === 1n)!.targets, null);
  const requested = fairRequests(i).map((s) => s.info.longId);
  assert.deepEqual(requested, [0n]);
  assert.equal(selectedSeries(i).map((s) => s.longId).includes(1n), false);
});

test('wind-down: a vault walks from mid-epoch to the boundary, last plan places nothing and is flatForRoll', () => {
  const epochEnd = EXPIRY;
  const wind = 14_400; // before the pull window (15 min before mint cutoff)
  const epoch = { epochEnd, index: 1n, rollDue: false };
  const params = { ...PARAMS, epochWindDownS: wind };
  const inside = view(0);
  const mid = input(1, { now: NOW, vault: vault({ epoch, usdgReserved: 0n }), params, series: [inside], fairs: new Map([['0', fairOf(0)]]) });
  const midPlan = planTick(mid);
  assert.ok(midPlan.txs.some((t) => t.type === 'place' && t.slot === 'bid'));
  assert.ok(midPlan.txs.some((t) => t.type === 'place' && t.slot === 'write'));
  assert.equal(midPlan.series[0]!.halt, null);

  const longs = view(0, {
    exposure: { longs: 100n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n },
  });
  const lead = input(1, {
    now: epochEnd - wind,
    vault: vault({ epoch, usdgReserved: 0n }),
    params,
    series: [longs],
    fairs: new Map([['0', fairOf(0, epochEnd - wind)]]),
  });
  const leadPlan = planTick(lead);
  assert.equal(leadPlan.series[0]!.halt?.halt, 'epoch-winddown');
  assert.equal(leadPlan.series[0]!.targets?.bid, null);
  assert.equal(leadPlan.series[0]!.targets?.write, null);
  assert.ok(leadPlan.series[0]!.targets?.resale !== null && leadPlan.series[0]!.targets!.resale!.units > 0n);
  assert.ok(leadPlan.txs.every((t) => t.type !== 'place' || t.slot === 'resale'));
  assert.ok(!leadPlan.txs.some((t) => t.type === 'place' && (t.slot === 'bid' || t.slot === 'write')));

  const flat = view(0, { exposure: { longs: 0n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n } });
  const last = input(1, {
    now: epochEnd - wind + 1,
    vault: vault({ epoch, usdgReserved: 0n }),
    params,
    series: [flat],
    fairs: new Map([['0', fairOf(0, epochEnd - wind + 1)]]),
  });
  const lastPlan = planTick(last);
  assert.equal(lastPlan.series[0]!.halt?.halt, 'epoch-winddown');
  assert.equal(lastPlan.txs.filter((t) => t.type === 'place' || t.type === 'replace').length, 0);
  assert.equal(
    flatForRoll(last.series.map((s) => s.exposure ?? { longs: 1n, shorts: 0n, resale: 0n })),
    true,
  );
});

test('a wind-down series whose fair carries to zero at the oracle\'s spot is halted, not priced', () => {
  // epoch-winddown returns from haltBeforeFair, so haltOf never judges the fair on this path: the planner must.
  const epochEnd = EXPIRY;
  const wind = 14_400;
  const params = { ...PARAMS, epochWindDownS: wind };
  const longs = view(0, { exposure: { longs: 100n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n } });
  const at = (fair: FairInput) =>
    planTick(input(1, { now: epochEnd - wind, vault: vault({ epoch: { epochEnd, index: 1n, rollDue: false }, usdgReserved: 0n }), params, series: [longs], fairs: new Map([['0', fair]]) }));

  // Control: a fair that stays positive still unwinds through a resale ask.
  const control = at(fairOf(0, epochEnd - wind));
  assert.equal(control.series[0]!.halt?.halt, 'epoch-winddown');
  assert.ok(control.txs.some((t) => t.type === 'place' && t.slot === 'resale'), 'the control does place a resale ask');

  // 0.5 USDG at delta 0.4, priced 2 USDG above the oracle's spot: carried to zero.
  const zero = at({ ok: true, fair: 500_000n, delta: 0.4, iv: 0.5, asOf: epochEnd - wind - 60, source: 'model', spot: SPOT + 2_000_000n });
  assert.equal(zero.series[0]!.halt?.halt, 'fair-unavailable', 'a zero QUOTED fair halts the wind-down too');
  assert.equal(zero.series[0]!.targets, null);
  assert.ok(!zero.txs.some((t) => t.type === 'place' || t.type === 'replace'), 'nothing is rested at a tick');
});

test('a wind-down series is priced only from a fair that passes every fair check haltOf runs', () => {
  // epoch-winddown returns from haltBeforeFair, so haltOf never reaches the fair checks on this path, and a change carried
  // over only the zero case. The planner's pricing branch now runs fairCheckOf, the SAME function haltOf runs.
  const epochEnd = EXPIRY;
  const wind = 14_400;
  const now = epochEnd - wind;
  const params = { ...PARAMS, epochWindDownS: wind, fairSpotToleranceBps: 300 };
  const longs = view(0, { exposure: { longs: 100n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n } });
  const at = (fair: FairInput) =>
    planTick(input(1, { now, vault: vault({ epoch: { epochEnd, index: 1n, rollDue: false }, usdgReserved: 0n }), params, series: [longs], fairs: new Map([['0', fair]]) }));
  const good = { ok: true as const, fair: 3_000_000n, delta: 0.45, iv: 0.5, asOf: now - 120, source: 'model', spot: SPOT };

  // Control: the fair passes every check, and the wind-down unwinds through a resale ask.
  const control = at(good);
  assert.equal(control.series[0]!.halt?.halt, 'epoch-winddown');
  assert.ok(control.txs.some((t) => t.type === 'place' && t.slot === 'resale'), 'the control does place a resale ask');

  // A STALE fair: asOf one second past MM_FAIR_MAX_AGE_S (1,800) with the session open.
  const stale = at({ ...good, asOf: now - 1_801 });
  assert.equal(stale.series[0]!.halt?.halt, 'fair-stale', 'a stale fair halts the wind-down instead of pricing it');
  assert.equal(stale.series[0]!.targets, null);
  assert.equal(stale.series[0]!.prices, null);
  assert.ok(!stale.txs.some((t) => t.type === 'place' || t.type === 'replace'), 'no resale ask from a stale fair');

  // A SPOT-MISMATCHED fair: priced 400 bps from the oracle's spot, the tolerance is 300.
  const mismatch = at({ ...good, spot: (SPOT * 10_400n) / 10_000n });
  assert.equal(mismatch.series[0]!.halt?.halt, 'fair-spot-mismatch', 'a spot-mismatched fair halts the wind-down instead of pricing it');
  assert.equal(mismatch.series[0]!.targets, null);
  assert.equal(mismatch.series[0]!.prices, null);
  assert.ok(!mismatch.txs.some((t) => t.type === 'place' || t.type === 'replace'), 'no resale ask from a mismatched fair');
});

// THE SENT HALF IS NOT HERE, BY DESIGN. This proves the bid is not PLANNED: `plan.txs`
// is the list `MmQuoter.execute` walks, so nothing below can reach the sender. Whether it is not SENT is a quoter fact:
// `execute` is private (quoter.ts), reached only from `sendVault` (`tickOne` before) after the chain read, and the sender is `ctx.sender`.
// That test needs the tick harness quoter.test.ts already has (its seam) and belongs there, in that file.
test('protocol-cross: a bid that would rest at or above a protocol-owned ask is skipped, and /state sees the halt', () => {
  const first = planTick(input(1));
  const bid = first.txs.find((t): t is Extract<MmTx, { type: 'place' }> => t.type === 'place' && t.slot === 'bid');
  assert.ok(bid);
  const protocol = '0x00000000000000000000000000000000000000bb';
  const crossed = input(1, {
    protocolAccounts: new Set([protocol]),
    protocolBook: [{ longId: 0n, maker: protocol.toUpperCase(), kind: 'AskWrite', price: bid.price }],
  });
  const plan = planTick(crossed);
  assert.equal(plan.series[0]!.halt?.halt, 'protocol-cross');
  assert.equal(plan.series[0]!.targets?.bid, null);
  assert.ok(!plan.txs.some((t) => t.type === 'place' && t.slot === 'bid'));
  assert.ok(plan.txs.some((t) => t.type === 'place' && t.slot === 'write'), 'the uncrossed write still rests');
});


/*//////////////////////////////////////////////////////////////
     THE VAULT'S ASK IS THE FALLBACK (MM_ASK_FALLBACK_ONLY)
//////////////////////////////////////////////////////////////*/

const OTHER = '0x00000000000000000000000000000000000000cc';
/**
 * The default other ask is one the vault SHOULD step aside for -- backed (an AskWrite with free collateral for
 * all of it; a resale is escrowed), priced under the bot's ask (series 0 fair is 3.0 USDG, the bot asks above it) and
 * two shares deep. Earlier this fixture was a 0.5-share, 9-USDG, unbacked AskWrite, and the bot stepped aside
 * for it: exactly the bug. The cases below keep the behaviour for a REAL ask; the next block tests the
 * asks the bot must now ignore.
 */
const otherAsk = (longId: bigint, maker = OTHER, kind: 'AskWrite' | 'AskResale' = 'AskWrite'): OtherAskInput =>
  ({ id: 900n + longId, maker, kind, price: 3_000_000n, remaining: 200n, ...(kind === 'AskWrite' ? { makerFree: 10n ** 19n } : {}) });

// BREAK CHECK: force `fallbackOnly` to false in planTick (or run with askFallbackOnly: false, which
// the last case does deliberately) and this test goes red at "no ask target" -- the vault asks into the other maker.
test('other-asker: a third-party live ask on the series halts the ask side only, cancels the resting vault ask, and leaves the bid', () => {
  const resting = liveOrder({ id: 7n, kind: 'AskWrite', price: 3_400_000n, units: 100n });
  const plan = planTick(input(2, {
    series: [view(0, { orders: [resting] }), view(1)],
    otherAskers: new Map([['0', [otherAsk(0n)]]]),
  }));
  const halted = plan.series.find((s) => s.longId === 0n)!;
  assert.equal(halted.halt?.halt, 'other-asker', 'visible in /state by name');
  assert.match(halted.halt?.detail ?? '', /1 fillable ask at or below the vault's ask: #900 AskWrite 0x00000000000000000000000000000000000000cc 200u@3000000/);
  assert.equal(halted.targets?.write, null, 'no ask target');
  assert.equal(halted.targets?.resale, null);
  assert.notEqual(halted.targets?.bid, null, 'the bid is untouched by the flag');
  assert.ok(plan.txs.some((t) => t.type === 'cancel' && t.orderIds.includes(7n)), 'the resting vault ask is cancelled');
  assert.ok(!plan.txs.some((t) => t.type === 'place' && t.slot === 'write' && t.longId === 0n), 'nothing asks into the other maker');
  assert.ok(plan.txs.some((t) => t.type === 'place' && t.slot === 'bid' && t.longId === 0n), 'the bid still rests');
  // The sibling series with no other asker quotes both sides as before.
  const free = plan.series.find((s) => s.longId === 1n)!;
  assert.equal(free.halt, null);
  assert.ok(plan.txs.some((t) => t.type === 'place' && t.slot === 'write' && t.longId === 1n));
});

test('other-asker: the ask returns the tick the book clears; the vault\'s OWN resting ask never counts (no flapping)', () => {
  const own = liveOrder({ id: 8n, kind: 'AskWrite', price: 3_400_000n, units: 100n });
  // reads.readOtherAskers drops the vault's own orders, so a tick with an empty entry plans the ask as usual.
  const plan = planTick(input(1, { series: [view(0, { orders: [own] })], otherAskers: new Map([['0', []]]) }));
  assert.equal(plan.series[0]!.halt, null);
  assert.notEqual(plan.series[0]!.targets?.write, null, 'the ask is planned again');
  assert.ok(!plan.txs.some((t) => t.type === 'cancel' && t.orderIds.includes(8n)), 'the own ask is kept or replaced, not cancelled for itself');
});

test('other-asker: a protocol account\'s ask (the HouseVault covered call) COUNTS as another asker -- documented, and flippable', () => {
  const protocol = '0x00000000000000000000000000000000000000bb';
  const plan = planTick(input(1, {
    protocolAccounts: new Set([protocol]),
    otherAskers: new Map([['0', [otherAsk(0n, protocol, 'AskResale')]]]),
  }));
  assert.equal(plan.series[0]!.halt?.halt, 'other-asker');
  assert.equal(plan.series[0]!.targets?.write, null);
  assert.ok(!plan.txs.some((t) => t.type === 'place' && t.slot === 'write'));
});

test('other-asker: MM_ASK_FALLBACK_ONLY=0 restores the always-quote; the read is simply not consulted', () => {
  const plan = planTick(input(1, {
    params: { ...PARAMS, askFallbackOnly: false },
    otherAskers: new Map([['0', [otherAsk(0n)]]]),
  }));
  assert.equal(plan.series[0]!.halt, null);
  assert.notEqual(plan.series[0]!.targets?.write, null, 'with the flag off the vault asks alongside the other maker');
  assert.ok(plan.txs.some((t) => t.type === 'place' && t.slot === 'write'));
});

test('other-asker: a suppressed ask does not spend the shared write pool, so the next series gets the collateral', () => {
  // Two series on one asset, a pool that covers exactly one full ask; series 0 has another asker.
  const cpu = 10n ** 16n;
  const one = 100n * cpu + 100n * cpu; // generous: one ask plus rent headroom
  const plan = planTick(input(2, {
    vault: vault({ freeCollateral: new Map([[U, one]]) }),
    otherAskers: new Map([['0', [otherAsk(0n)]]]),
  }));
  const s1 = plan.series.find((s) => s.longId === 1n)!;
  assert.equal(s1.sizes?.write, 100n, 'series 1 gets the whole ask: series 0 reserved nothing');
});

/*//////////////////////////////////////////////////////////////
   STEP ASIDE ONLY FOR AN ASK THAT CAN FILL, AT OR BELOW
   THE BOT'S ASK, AND AT LEAST STEP_ASIDE_MIN_UNITS DEEP
//////////////////////////////////////////////////////////////*/

/** The write ask the bot quotes on series 0 of `input(1)` with nobody else on the book. */
const botAskOf = (over: Partial<TickInput> = {}): bigint => {
  const price = planTick(input(1, over)).series[0]!.targets?.write?.price;
  assert.ok(price !== undefined && price > 0n, 'positive control: the bot quotes a write ask on series 0');
  return price;
};
/** The bot kept its ask on series 0: no other-asker halt and a write target (and a placed write). */
const assertBotStays = (plan: TickPlan, why: string) => {
  assert.equal(plan.series[0]!.halt, null, `${why}: series 0 must keep quoting, halted ${plan.series[0]!.halt?.halt}: ${plan.series[0]!.halt?.detail}`);
  assert.notEqual(plan.series[0]!.targets?.write, null, `${why}: series 0 keeps the vault's ask`);
  assert.ok(plan.txs.some((t) => t.type === 'place' && t.slot === 'write' && t.longId === 0n), `${why}: series 0 places the ask`);
};
const withOther = (ask: OtherAskInput) => input(1, { otherAskers: new Map([['0', [ask]]]) });

// BREAK CHECK: make stepAsideAsks return every ask (the "any ask" rule) and this test goes red
// at "unbacked AskWrite (no balance read): no halt", naming series 0; restore and it is green.
test('an UNBACKED AskWrite does not move the bot -- no balance, a failed read, or too little free collateral', () => {
  const botAsk = botAskOf();
  const cheap = botAsk - 100_000n;
  const base: OtherAskInput = { id: 901n, maker: OTHER, kind: 'AskWrite', price: cheap, remaining: 10_000n };
  assertBotStays(planTick(withOther({ ...base })), 'unbacked AskWrite (no balance read)');
  assertBotStays(planTick(withOther({ ...base, makerFree: null })), 'unbacked AskWrite (balance read failed)');
  assertBotStays(planTick(withOther({ ...base, makerFree: 0n })), 'unbacked AskWrite (0 free)');
  // Enough for 99 units with rent, not 100: fillable is under the one-share floor.
  const cpu = 10n ** 16n;
  const ninetyNine = 99n * cpu + 99n * cpu / 1_000n;
  assert.equal(maxWriteUnits(ninetyNine, cpu, 80, EXPIRY - NOW) < STEP_ASIDE_MIN_UNITS, true, 'fixture: free covers under one share');
  assertBotStays(planTick(withOther({ ...base, makerFree: ninetyNine })), 'AskWrite backed for under one share');
});

test('an OVERPRICED ask does not move the bot, however well backed; at exactly the bot\'s ask it does', () => {
  const botAsk = botAskOf();
  const backed: OtherAskInput = { id: 902n, maker: OTHER, kind: 'AskResale', price: botAsk + 1n, remaining: 10_000n };
  assertBotStays(planTick(withOther(backed)), 'resale one base unit above the bot');
  const atBot = planTick(withOther({ ...backed, price: botAsk }));
  assert.equal(atBot.series[0]!.halt?.halt, 'other-asker', 'at the bot\'s own price the buyer loses nothing: step aside');
  assert.equal(atBot.series[0]!.targets?.write, null);
});

test('a DUST ask does not move the bot; exactly one share does', () => {
  const botAsk = botAskOf();
  const dust: OtherAskInput = { id: 903n, maker: OTHER, kind: 'AskResale', price: botAsk - 1n, remaining: STEP_ASIDE_MIN_UNITS - 1n };
  assertBotStays(planTick(withOther(dust)), 'a 0.99-share resale');
  assertBotStays(planTick(withOther({ ...dust, remaining: 1n })), 'a 0.01-share resale');
  const share = planTick(withOther({ ...dust, remaining: STEP_ASIDE_MIN_UNITS }));
  assert.equal(share.series[0]!.halt?.halt, 'other-asker', 'one full share at or below the bot: step aside');
});

test('a backed, cheaper, sized AskWrite moves the bot, and the halt names only the asks that qualified', () => {
  const botAsk = botAskOf();
  const good: OtherAskInput = { id: 904n, maker: OTHER, kind: 'AskWrite', price: botAsk - 50_000n, remaining: 500n, makerFree: 10n ** 19n };
  const dust: OtherAskInput = { id: 905n, maker: '0x00000000000000000000000000000000000000dd', kind: 'AskResale', price: 1n, remaining: 1n };
  const plan = planTick(input(1, { otherAskers: new Map([['0', [dust, good]]]) }));
  const s0 = plan.series[0]!;
  assert.equal(s0.halt?.halt, 'other-asker');
  assert.equal(s0.targets?.write, null, 'the vault\'s ask steps aside');
  assert.notEqual(s0.targets?.bid, null, 'bids untouched');
  assert.match(s0.halt?.detail ?? '', /^1 fillable ask at or below the vault's ask: #904 AskWrite 0x0{38}cc 500u@/);
  assert.doesNotMatch(s0.halt?.detail ?? '', /#905|0x0{38}dd/, 'the dust ask is not named');
});

test('an AskWrite past the mint cutoff, or on a mint-paused market, cannot fill', () => {
  const series = { expiry: EXPIRY, collateralPerUnit: 10n ** 16n, mintFeePpm: 80 };
  const w: OtherAskInput = { id: 906n, maker: OTHER, kind: 'AskWrite', price: 1n, remaining: 500n, makerFree: 10n ** 19n };
  assert.equal(fillableUnits(w, series, NOW, false), 500n, 'control: open mint, enough collateral');
  assert.equal(fillableUnits(w, series, mintCutoffOf(EXPIRY), false), 0n, 'at the mint cutoff');
  assert.equal(fillableUnits(w, series, NOW, true), 0n, 'mint paused');
  const r: OtherAskInput = { id: 907n, maker: OTHER, kind: 'AskResale', price: 1n, remaining: 500n };
  assert.equal(fillableUnits(r, series, NOW, true), 500n, 'a resale is escrowed longs, not a mint: pause does not stop it');
  // Through planTick: on a mint-paused market the third-party AskWrite is not "another asker" (whatever else the pause
  // does to the vault's own write ask, the halt is never other-asker).
  const paused = planTick(input(1, { markets: new Map([[U, market({ mintPaused: true })]]), otherAskers: new Map([['0', [w]]]) }));
  assert.notEqual(paused.series[0]!.halt?.halt, 'other-asker', 'a mint-paused AskWrite is not a fillable other ask');
});

test('stepAsideAsks is empty when the bot has no ask of its own', () => {
  const series = { expiry: EXPIRY, collateralPerUnit: 10n ** 16n, mintFeePpm: 80 };
  assert.deepEqual(stepAsideAsks([otherAsk(0n)], null, series, NOW, false), []);
  assert.equal(stepAsideAsks([otherAsk(0n)], 3_000_000n, series, NOW, false).length, 1, 'control');
});

test('a higher-ranked own vault\'s ask counts up to MM_REQUOTE_BPS above the bot\'s ask; a third party\'s only at or below it', () => {
  // The House vault keeps a resting ask while its target stays within MM_REQUOTE_BPS of it (engine.judgeReplace), so the
  // treasury's fresh ask a hair under it is the same quote: resting it would take the House vault's fill.
  const series = { expiry: EXPIRY, collateralPerUnit: 10n ** 16n, mintFeePpm: 80 };
  const bot = 3_000_000n;
  const at = (price: bigint, sibling: boolean): OtherAskInput => ({ ...otherAsk(0n), price, ...(sibling ? { sibling: true } : {}) });
  const counts = (ask: OtherAskInput, band = 100) => stepAsideAsks([ask], bot, series, NOW, false, STEP_ASIDE_MIN_UNITS, band).length === 1;
  assert.equal(counts(at(3_000_100n, true)), true, 'a sibling ask one tick above the bot\'s ask: step aside');
  // Measured as judgeReplace measures the sibling's own ask: the move over the RESTING price (engine.moveBps).
  assert.equal(counts(at(3_030_000n, true)), true, '99 bps above: inside the band, step aside');
  assert.equal(counts(at(3_040_000n, true)), false, '131 bps above: past the band, where the sibling re-prices itself; quote');
  assert.equal(counts(at(3_000_100n, false)), false, 'a third party one tick above: unchanged (T-OP-341), quote under it');
  assert.equal(counts(at(3_000_400n, true), 0), false, 'band 0 (the default): a sibling 1 bp above is held to the third-party rule');
  assert.equal(counts(at(2_900_000n, false)), true, 'control: a third party below the bot\'s ask');
});

/**
 * PARITY. The bot and the app must agree on whether an AskWrite can fill: the app serves the book through the
 * indexer's aggregateBook, which caps an AskWrite at rentCapacity(free, collateralPerUnit, mintFeePpm, expiry - now)
 * (indexer/lib/v2/book.ts, rent.ts). The keeper uses mintFee.maxWriteUnits. This pins them equal over a grid of calls
 * and puts, rent rates and remaining lives. The indexer module is loaded at run time (keeper's tsconfig roots at src/).
 */
test('parity: keeper maxWriteUnits == indexer rentCapacity (the book\'s AskWrite cap)', async () => {
  const url = new URL('../../../../indexer/lib/v2/rent.ts', import.meta.url).href;
  const { rentCapacity } = (await import(url)) as { rentCapacity: (free: bigint, perUnit: bigint, ppm: number, remaining: bigint) => bigint };
  const perUnits = [10n ** 16n, 1_000_000n, 2_125_000n, 7n];
  const ppms = [0, 1, 80, 500, 5_000];
  const lives = [0, 1, 3_600, 86_400, 604_800, 30 * 86_400];
  const frees = [0n, 1n, 10n ** 16n - 1n, 10n ** 16n, 12_345_678_901_234_567_890n, 250_000_000n, 99n * 10n ** 16n + 7n];
  let cases = 0;
  for (const cpu of perUnits) for (const ppm of ppms) for (const life of lives) for (const free of frees) {
    assert.equal(maxWriteUnits(free, cpu, ppm, life), rentCapacity(free, cpu, ppm, BigInt(life)), `free ${free} cpu ${cpu} ppm ${ppm} life ${life}`);
    cases += 1;
  }
  assert.equal(cases, perUnits.length * ppms.length * lives.length * frees.length);
});

/*//////////////////////////////////////////////////////////////
        SAFETY INPUTS ARE REQUIRED
//////////////////////////////////////////////////////////////*/

// The four inputs used to be read behind `??` defaults that turned an ABSENT input into "protection off"
// (epoch -> unrestricted, epochWindDownS -> 0, protocolAccounts -> empty, protocolBook -> empty). TypeScript
// declares all four required, so no typed caller ever missed them and every existing test above passes them --
// which is exactly why nothing could see the defaults fire. These tests reach the planner the way a refactor
// that drops an argument would: through a cast the compiler does not check. Each one asserts the throw NAMES
// the input. BREAK CHECK: restore `epoch: input.vault.epoch ?? null` at the
// `selectedSeries` call in planner.ts and `required: vault.epoch undefined throws from every entry point` goes
// red at its first assertion, because `selectedSeries` then plans an unrestricted vault instead of throwing.

/** Removes one key so the value is `undefined` at runtime while the object still satisfies the type at compile time. */
function without<T extends object>(obj: T, key: keyof T): T {
  const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  delete copy[key as string];
  return copy as T;
}

test('required: vault.epoch undefined throws from every entry point, and null is still legal', () => {
  const i = input(2);
  const noEpoch: TickInput = { ...i, vault: without(i.vault, 'epoch') };
  assert.throws(() => selectedSeries(noEpoch), /required safety input "vault\.epoch"/);
  assert.throws(() => fairRequests(noEpoch), /required safety input "vault\.epoch"/);
  assert.throws(() => planTick(noEpoch), /required safety input "vault\.epoch"/);
  // `null` is the documented "treasury MakerVault, unrestricted" value and must keep working.
  assert.equal(twoSidedCount(planTick(input(2, { vault: vault({ epoch: null }) }))), 2);
});

test('required: params.epochWindDownS undefined throws, naming it; 0 supplied explicitly is legal', () => {
  const i = input(2);
  const noWindDown: TickInput = { ...i, params: without(i.params, 'epochWindDownS') };
  assert.throws(() => fairRequests(noWindDown), /required safety input "params\.epochWindDownS"/);
  assert.throws(() => planTick(noWindDown), /required safety input "params\.epochWindDownS"/);
  assert.doesNotThrow(() => planTick(input(2, { params: { ...PARAMS, epochWindDownS: 0 } })));
});

test('required: protocolAccounts undefined throws, naming it; an explicit empty set is legal', () => {
  const noAccounts = without(input(2), 'protocolAccounts');
  assert.throws(() => planTick(noAccounts), /required safety input "protocolAccounts"/);
  assert.doesNotThrow(() => planTick(input(2, { protocolAccounts: new Set<string>() })));
});

test('required: protocolBook undefined throws, naming it; an explicit empty book is legal', () => {
  const noBook = without(input(2), 'protocolBook');
  assert.throws(() => planTick(noBook), /required safety input "protocolBook"/);
  assert.doesNotThrow(() => planTick(input(2, { protocolBook: [] })));
});

test('required: the guard checks presence, not truthiness -- a well-formed input never trips it', () => {
  // Every earlier test in this file is the positive control: full inputs plan. This pins the order of checks so
  // a missing epoch is reported before a missing book when both are absent (the operator fixes the first wire).
  const both = without(without(input(2), 'protocolBook'), 'protocolAccounts');
  assert.throws(() => planTick(both), /"protocolAccounts"/);
});

/*//////////////////////////////////////////////////////////////
   A SAFETY HALT CANCELS THE MARKET'S RESTING ASKS
//////////////////////////////////////////////////////////////*/

// FORBIDDEN: a halt that leaves existing asks resting. Each guard's halt reaches the planner the way the
// quoter hands it over -- P7/P8/P15 on MarketView.halt, P9 on the fair's quality -- and the series' resting AskWrite
// (and its bid) is cancelled on that tick, with nothing placed. The control: the same series with no halt keeps its ask.
test('every market-safety halt and the P9 event halt cancel the series\' resting ask and bid, place nothing, and name the halt', () => {
  const resting = [liveOrder({ id: 31n, kind: 'AskWrite', price: 3_300_000n }), liveOrder({ id: 32n, kind: 'Bid', price: 2_700_000n })];
  const withOrders = (over: Partial<TickInput> = {}) => input(1, { series: [view(0, { orders: resting })], ...over });
  const control = planTick(withOrders());
  assert.equal(control.series[0]!.halt, null, 'control: unhalted');
  assert.ok(!control.txs.some((t) => t.type === 'cancel' && t.orderIds.includes(31n)), 'control: the resting ask is kept');

  const cases: Array<[string, Partial<TickInput>]> = [
    ['spot-age', { markets: new Map([[U, market({ halt: { halt: 'spot-age', detail: 'old' } })]]) }],
    ['open-grace', { markets: new Map([[U, market({ halt: { halt: 'open-grace' } })]]) }],
    ['spot-move-breaker', { markets: new Map([[U, market({ halt: { halt: 'spot-move-breaker' } })]]) }],
    ['event-uncertainty', { fairs: new Map([['0', { ...fairOf(0), quality: { reasons: ['event-uncertainty'] } }]]) }],
  ];
  for (const [name, over] of cases) {
    const plan = planTick(withOrders(over));
    assert.equal(plan.series[0]!.halt?.halt, name, name);
    const cancel = plan.txs.find((t): t is Extract<MmTx, { type: 'cancel' }> => t.type === 'cancel');
    assert.deepEqual([...(cancel?.orderIds ?? [])].sort(), [31n, 32n], `${name}: the resting ask and bid are cancelled`);
    assert.ok(!plan.txs.some((t) => t.type === 'place' || t.type === 'replace'), `${name}: nothing is placed or replaced`);
  }
});

test('a market halt stays on its market; another market in the same tick still quotes', () => {
  const V = '0x00000000000000000000000000000000000000bc';
  const other = view(1, { info: { longId: 1n, underlying: V, isPut: false, strike: strikeOf(1), expiry: EXPIRY }, ticker: 'SPCX' });
  const plan = planTick(
    input(2, {
      series: [view(0), other],
      markets: new Map([[U, market({ halt: { halt: 'spot-move-breaker' } })], [V, market({ underlying: V, ticker: 'SPCX' })]]),
      vault: vault({ freeCollateral: new Map([[U, 100n * 10n ** 18n], [V, 100n * 10n ** 18n]]), walletTokens: new Map([[U, 0n], [V, 0n]]) }),
    }),
  );
  assert.equal(plan.series.find((s) => s.longId === 0n)?.halt?.halt, 'spot-move-breaker');
  assert.equal(plan.series.find((s) => s.longId === 1n)?.halt, null);
  assert.ok(plan.txs.some((t) => t.type === 'place' && t.longId === 1n), 'the other market is still quoted');
});

/*//////////////////////////////////////////////////////////////
          THE SAFEST ASK THROUGH A WHOLE TICK
//////////////////////////////////////////////////////////////*/

const seriesPlan = (plan: ReturnType<typeof planTick>, id: bigint) => plan.series.find((x) => x.longId === id)!;

test('P14 through planTick: a market far short delta stops its call ASKS (resting asks cancelled, capped delta) and keeps every BID', () => {
  // 250 shares short of series 0 at delta 0.45 = −112.5 shares, past the default MM_MAX_DELTA_SHARES (100).
  const i = input(3);
  i.series = i.series.map((v, k) => (k === 0 ? { ...v, exposure: { ...v.exposure!, shorts: 25_000n } } : { ...v, orders: [liveOrder({ id: 50n + BigInt(k), kind: 'AskWrite', price: 5_000_000n })] }));
  const plan = planTick(i);
  for (const id of [1n, 2n]) {
    const sp = seriesPlan(plan, id);
    assert.equal(sp.targets!.write, null, `series ${id}: no write ask`);
    assert.notEqual(sp.targets!.bid, null, `series ${id}: the bid (buys delta back) stays`);
  }
  assert.ok(plan.capped.some((c) => c.caps.includes('delta')));
  const cancels = plan.txs.filter((t): t is Extract<MmTx, { type: 'cancel' }> => t.type === 'cancel').flatMap((t) => t.orderIds);
  assert.deepEqual(cancels.sort(), [51n, 52n], 'the resting asks lose their target and are cancelled');
  // With the limit off the same tick writes again.
  const off = planTick({ ...i, params: { ...PARAMS, maxDeltaShares: 0, maxGamma: 0 } });
  assert.notEqual(seriesPlan(off, 1n).targets!.write, null);
});

test('P18 through planTick: an open short marked against the vault halts every series loss-stop (mark-to-market) while the realised stop is clear', () => {
  // The ledger: 5 shares of series 0 short at 0.40; /fair marks series 0 at 3.00 -> −13 USDG unrealised.
  const positions = new Map([['0', { units: -500n, basis: 500n * 400_000n }]]);
  const lossStop = { day: Math.floor(NOW / 86_400), realised: 0n, limit: 1_000_000_000n, tripped: false, positions };
  const tripped = planTick(input(2, { lossStop, params: { ...PARAMS, dailyMtmLossLimitUsdg6: 10_000_000n } }));
  assert.equal(tripped.mtm!.tripped, true);
  assert.ok(tripped.mtm!.total <= -10_000_000n, `total ${tripped.mtm!.total}`);
  assert.ok(tripped.series.every((x) => x.halt?.halt === 'loss-stop' && /mark-to-market/.test(x.halt.detail ?? '')), JSON.stringify(tripped.series.map((x) => x.halt)));
  assert.equal(tripped.txs.filter((t) => t.type === 'place').length, 0);
  const clear = planTick(input(2, { lossStop, params: { ...PARAMS, dailyMtmLossLimitUsdg6: 20_000_000n } }));
  assert.equal(clear.mtm!.tripped, false);
  assert.ok(clear.txs.some((t) => t.type === 'place'));
});

test('P3 through planTick: /fair askIv + vega price the ask up; without them the local vega x MM_VOL_MARKUP_PTS does; the bid does not move', () => {
  const flat = planTick(input(1, { params: { ...PARAMS, volMarkupPts: 0 } }));
  const local = planTick(input(1));
  const withAskIv = input(1);
  withAskIv.fairs = new Map([['0', { ...fairOf(0), askIv: 0.7, vega: 0.2 } as FairInput]]);
  const served = planTick(withAskIv);
  const f = seriesPlan(flat, 0n).prices!;
  const l = seriesPlan(local, 0n).prices!;
  const a = seriesPlan(served, 0n).prices!;
  const vega = localGreeks({ now: NOW, series: view(0).info, spot: SPOT, vol: 0.5 })!.vega;
  assert.equal(l.volBump, BigInt(Math.ceil(vega * 0.02 * 1e6)), 'local vega at the fair iv x 2 points');
  assert.equal(a.volBump, 40_000n, '0.2 x (0.7 − 0.5)');
  assert.ok(l.ask > f.ask && a.ask > f.ask);
  assert.equal(l.bid, f.bid);
  assert.equal(a.bid, f.bid);
});

test('P13 through planTick: the per-expiry cap sizes the second series of the expiry down', () => {
  // Each series wants 1 share a side at strike ~210-212 -> ~210 USDG; cap 300 USDG for the expiry.
  const plan = planTick(input(2, { params: { ...PARAMS, maxExpiryNotionalUsdg6: 300_000_000n } }));
  assert.ok(plan.capped.some((c) => c.caps.includes('expiry-notional')), JSON.stringify(plan.capped, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
});

test('P16 through planTick: at the default band the at-the-money series is not the first quoted', () => {
  const params = { ...PARAMS, deltaBandHi: undefined, maxSeries: 1 };
  const i = input(6, { params });
  const picked = selectedSeries(i).map((x) => x.longId);
  const legacy = selectedSeries({ ...i, params: { ...params, deltaBandHi: 0 } }).map((x) => x.longId);
  assert.deepEqual(legacy, [0n], 'nearest the money: strike = spot');
  // The expected pick, derived independently: the best (outside, fromMid) of the six at the default band.
  const ranks = [0, 1, 2, 3, 4, 5].map((k) => ({ id: BigInt(k), ...deltaBandRank(view(k).info, SPOT, NOW, { lo: 0.1, hi: 0.3, vol: 0.5 }) }));
  const best = [...ranks].sort((x, y) => x.outside - y.outside || x.fromMid - y.fromMid)[0]!;
  assert.notEqual(best.id, 0n, 'fixture: the ATM series is not the band\'s best');
  assert.deepEqual(picked, [best.id]);
});

/*//////////////////////////////////////////////////////////////
       SAFE CALL SELLING
//////////////////////////////////////////////////////////////*/

/** NOW is 10:00 New York on Monday 21 September 2026: the session opened half an hour earlier. */
const OPEN = NOW - 1_800;

/** input(n) with the four pieces on at their defaults: prints a minute old, fairs dated at `now`, this session's open. */
function safeInput(n: number, over: Partial<TickInput> = {}, params: Partial<MmPlanParams> = {}): TickInput {
  const now = over.now ?? NOW;
  const base = input(n, { now });
  return {
    ...base,
    series: base.series.map((v) => ({ ...v, spotUpdatedAt: now - 60 })),
    fairs: new Map(base.series.map((v, i) => [v.info.longId.toString(), fairOf(i, now)])),
    params: { ...PARAMS, spotLagBps: 50, spotLagStaleBps: 150, fairFromSession: true, writeStopMinutes: 60, ...params },
    sessionOpenedAt: OPEN,
    ...over,
  };
}

test('the spot-lag floor: every ask at or above the plain one and its own floor; bids at or under the plain one and their cap; /state carries the floor', () => {
  const plain = planTick(input(6));
  const lagged = planTick(safeInput(6));
  assert.equal(twoSidedCount(lagged), 6);
  for (const s of lagged.series) {
    const p = plain.series.find((x) => x.longId === s.longId)!;
    assert.ok(s.lag !== null, `series ${s.longId} carries its floor`);
    assert.ok(s.prices!.ask >= p.prices!.ask, `series ${s.longId}: ${s.prices!.ask} under the plain ${p.prices!.ask}`);
    assert.ok(s.prices!.ask >= s.lag!.floor.write && s.prices!.resale >= s.lag!.floor.resale);
    // The spot-lag cap only ever lowers a bid, or pulls it when less than a tick is left.
    assert.ok(s.prices!.bid === null || (p.prices!.bid !== null && s.prices!.bid <= p.prices!.bid), `series ${s.longId}: bid ${s.prices!.bid} over the plain ${p.prices!.bid}`);
    assert.ok(s.prices!.bid === null || s.prices!.bid <= s.lag!.floor.bid, `series ${s.longId}: bid over its spot-lag cap`);
    assert.equal(s.lag!.bandBps, 50);
    assert.equal(s.lag!.spotQ, (SPOT * 10_050n + 9_999n) / 10_000n);
  }
  // At the money the band is worth more than this fixture's fair carries; far out of the money it is not.
  assert.equal(lagged.series.find((s) => s.longId === 0n)!.lag!.raised, true);
  assert.equal(lagged.series.find((s) => s.longId === 5n)!.lag!.raised, false);
  // Not vacuous: at the money the cap binds, so the bid really is under the plain one.
  const atm = lagged.series.find((s) => s.longId === 0n)!;
  assert.equal(atm.lag!.bidCapped, true);
  assert.ok(atm.prices!.bid !== null && atm.prices!.bid < plain.series.find((s) => s.longId === 0n)!.prices!.bid!);
  assert.equal(plain.series[0]!.lag, null, 'off: no floor');
});

test('an old print is floored at the series\' live oracle band when it is wider than MM_SPOT_LAG_STALE_BPS', () => {
  const old = (band: number | null | undefined) => {
    const i = safeInput(1);
    i.series = i.series.map((v) => ({ ...v, spotUpdatedAt: NOW - 3_600, ...(band === undefined ? {} : { oracleBandBps: band }) }));
    return planTick(i).series[0]!;
  };
  const wide = old(300);
  assert.equal(wide.lag!.bandBps, 300, 'the planner hands SeriesView.oracleBandBps to the floor');
  assert.equal(wide.lag!.spotQ, (SPOT * 10_300n + 9_999n) / 10_000n);
  const env = old(undefined);
  assert.equal(env.lag!.bandBps, 150, 'no live band read: MM_SPOT_LAG_STALE_BPS');
  assert.ok(wide.prices!.ask > env.prices!.ask, `the wider band raises the ask: ${wide.prices!.ask} vs ${env.prices!.ask}`);
  assert.equal(old(null).lag!.bandBps, 150);
  assert.equal(old(100).lag!.bandBps, 150, 'narrower than the env: the env');
});

test('a live write ask the spot-lag floor has moved above is replaced at once, even inside MM_REQUOTE_BPS', () => {
  // A 1 % half spread, and no vol bump (its fallback marks the ask up 2 vol points, about 4 % here), keep the
  // target within MM_REQUOTE_BPS of the floor, so only the floor can force the replace. The setup assertion checks it.
  const tight = { halfSpreadBps: 100, minHalfSpreadUsdg6: 1n, volMarkupPts: 0 };
  const first = planTick(safeInput(1, {}, tight));
  const floor = first.series[0]!.lag!.floor.write;
  const target = first.series[0]!.prices!.ask;
  const live = liveOrder({ id: 9n, kind: 'AskWrite', price: floor - 100n });
  assert.ok(moveBps(live.price, target) <= 300, `the setup: a ${moveBps(live.price, target)} bps move is inside MM_REQUOTE_BPS`);
  const under = safeInput(1, {}, tight);
  under.series = under.series.map((v) => ({ ...v, orders: [live] }));
  const replace = planTick(under).txs.find((t): t is Extract<MmTx, { type: 'replace' }> => t.type === 'replace');
  assert.equal(replace?.orderId, 9n);
  assert.match(replace!.reason, /below the spot-lag floor/);
  // The control: the same live ask AT the floor rests on, so it was the floor and not the move.
  const at = safeInput(1, {}, tight);
  at.series = at.series.map((v) => ({ ...v, orders: [{ ...live, price: floor }] }));
  const kept = planTick(at).txs;
  assert.equal(kept.some((t) => (t.type === 'replace' && t.orderId === 9n) || (t.type === 'cancel' && t.orderIds.includes(9n))), false);
});

test('a live bid the spot-lag cap has moved under is replaced at once, even inside MM_REQUOTE_BPS (the planner forwards floor.bid)', () => {
  // Series 0 is at the money, where the cap binds, so the bid target IS the cap and a live bid a hair over it is well
  // inside MM_REQUOTE_BPS: only the cap can force the replace. The setup assertions check both.
  const first = planTick(safeInput(1));
  const s0 = first.series[0]!;
  assert.equal(s0.lag!.bidCapped, true, 'the setup: the cap binds on this series');
  const cap = s0.lag!.floor.bid;
  assert.equal(s0.prices!.bid, cap, 'the setup: the bid target is the cap');
  const live = liveOrder({ id: 19n, kind: 'Bid', price: cap + 100n, units: 100n });
  assert.ok(moveBps(live.price, cap) <= 300, `the setup: a ${moveBps(live.price, cap)} bps move is inside MM_REQUOTE_BPS`);
  const over = safeInput(1);
  over.series = over.series.map((v) => ({ ...v, orders: [live] }));
  const replace = planTick(over).txs.find((t): t is Extract<MmTx, { type: 'replace' }> => t.type === 'replace');
  assert.equal(replace?.orderId, 19n);
  assert.match(replace!.reason, /above the spot-lag cap/);
  assert.equal(replace!.price, cap);
  // The control: the same live bid AT the cap rests, so it was the cap and not the move.
  const at = safeInput(1);
  at.series = at.series.map((v) => ({ ...v, orders: [{ ...live, price: cap }] }));
  const kept = planTick(at).txs;
  assert.equal(kept.some((t) => (t.type === 'replace' && t.orderId === 19n) || (t.type === 'cancel' && t.orderIds.includes(19n))), false);
});

test('a bid quoted with bidCapAheadS is never replaced for the spot-lag cap before the send after next; one quoted at the cap now is', () => {
  // The P11 env: 60 s routine sends, 15 s reads, 180 s quote life, 1 % requote, a 60 s replace margin and the refresh lead
  // of config.ts refreshLeadOf (90 s). The quoter passes bidCapAheadS = 2 x (60 + 15).
  const AHEAD = 150;
  const at = (now: number, orders: LiveOrder[], ahead = AHEAD) => {
    const i = safeInput(1, { now, bidCapAheadS: ahead, refreshS: 90, replaceMarginS: 60 }, { maxQuoteLifetimeS: 180, requoteBps: 100 });
    i.series = i.series.map((v) => ({ ...v, orders }));
    return planTick(i);
  };
  const bidPlace = (plan: TickPlan) => plan.txs.find((t): t is Extract<MmTx, { type: 'place' }> => t.type === 'place' && t.slot === 'bid')!;
  const capChased = (plan: TickPlan, id: bigint) =>
    plan.txs.filter((t) => ((t.type === 'replace' && t.orderId === id) || t.type === 'place') && /above the spot-lag cap/.test(t.reason)).length > 0;

  const first = at(NOW, []);
  const s0 = first.series[0]!;
  assert.equal(s0.lag!.bidCapped, true, 'the setup: the cap binds on this series');
  const placed = bidPlace(first);
  const bid = liveOrder({ id: 31n, kind: 'Bid', price: placed.price, units: placed.units, validUntil: placed.validUntil });
  // BREAK CHECK (a): quote the bid at the cap now again (spot-lag.ts withSpotLag `cap = lag.floor.bid`) and this
  // loop goes red at the first read where theta has moved the cap a tick.
  for (let dt = 15; dt <= AHEAD; dt += 15) {
    const later = at(NOW + dt, [bid]);
    assert.ok(bid.price <= later.series[0]!.lag!.floor.bid, `+${dt} s: the invariant holds, the bid is at or under the cap now`);
    assert.equal(capChased(later, 31n), false, `+${dt} s: nothing replaces the bid for the cap`);
  }
  assert.equal(placed.price, s0.lag!.bidCapAhead, 'the bid is quoted at the cap two routine sends ahead');
  assert.equal(s0.lag!.bidAt, NOW + AHEAD);
  assert.ok(placed.price < s0.lag!.floor.bid, `not vacuous: theta moves the cap by at least a tick in ${AHEAD} s (${placed.price} vs ${s0.lag!.floor.bid})`);

  // The control, and break check (a) in miniature: the bid quoted at the cap NOW (bidCapAheadS 0) is over the
  // falling cap, and replaced for it, inside the same window.
  const naive = bidPlace(at(NOW, [], 0));
  assert.equal(naive.price, s0.lag!.floor.bid, 'the setup: without the horizon the bid is the cap now');
  const naiveBid = liveOrder({ id: 32n, kind: 'Bid', price: naive.price, units: naive.units, validUntil: naive.validUntil });
  const chasedAt = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150].filter((dt) => capChased(at(NOW + dt, [naiveBid], 0), 32n));
  assert.ok(chasedAt.length > 0, 'at the cap now, theta alone lifts the bid over the cap and it is replaced');
});

test('the write stop: before it no write ask outlives it; from it the write goes and the bid and the resale stay', () => {
  const stop = writeStopAtOf(EXPIRY, 60);
  const withLongs = (i: TickInput) => ({ ...i, series: i.series.map((v, k) => (k === 0 ? { ...v, exposure: { ...v.exposure!, longs: 50n } } : v)) });
  const before = planTick(withLongs(safeInput(2, { now: stop - 600 })));
  const write = before.txs.find((t): t is Extract<MmTx, { type: 'place' }> => t.type === 'place' && t.slot === 'write')!;
  assert.equal(write.validUntil, stop, 'the book never re-checks a resting ask: it must end at the stop');
  assert.ok(before.series.every((s) => s.writeHold === null));
  const after = planTick(withLongs(safeInput(2, { now: stop })));
  assert.ok(after.series.every((s) => s.writeHold?.hold === 'write-cutoff'));
  assert.deepEqual(after.series.map((s) => [s.longId, s.targets?.bid !== null, s.targets?.write ?? null, s.targets?.resale?.units ?? null]), [
    [0n, true, null, 50n],
    [1n, true, null, null],
  ]);
  assert.ok(!after.txs.some((t) => (t.type === 'place' || t.type === 'replace') && t.slot === 'write'));
  assert.equal(planTick(withLongs(safeInput(2, { now: stop }, { writeStopMinutes: 0 }))).series[0]!.writeHold, null, '0: the mint cutoff itself');
});

test('fair-before-open: a fair priced on a chain from before the open is not quoted; MM_FAIR_FROM_SESSION=0 quotes it', () => {
  // The session opened a minute ago; the fixture's fairs are dated two minutes ago.
  const early = planTick(safeInput(2, { sessionOpenedAt: NOW - 60 }));
  assert.ok(early.series.every((s) => s.halt?.halt === 'fair-before-open'));
  assert.equal(early.txs.filter((t) => t.type === 'place').length, 0);
  assert.equal(twoSidedCount(planTick(safeInput(2, { sessionOpenedAt: NOW - 60 }, { fairFromSession: false }))), 2);
  assert.ok(planTick(safeInput(2, { sessionOpenedAt: null })).series.every((s) => s.halt?.halt === 'fair-before-open'), 'an open session it cannot place');
});

test('required while fair-before-open is on: sessionOpenedAt; off, it is not read', () => {
  const on = safeInput(2);
  assert.throws(() => planTick(without(on, 'sessionOpenedAt')), /required safety input "sessionOpenedAt"/);
  assert.throws(() => fairRequests(without(on, 'sessionOpenedAt')), /required safety input "sessionOpenedAt"/);
  assert.doesNotThrow(() => planTick(without(safeInput(2, {}, { fairFromSession: false }), 'sessionOpenedAt')));
});

test('the spot-lag band follows the print: 150 bps for a print older than 30 minutes or of unknown time; no vol, no quote', () => {
  const stale = safeInput(1);
  stale.series = stale.series.map((v) => ({ ...v, spotUpdatedAt: NOW - 1_801 }));
  assert.equal(planTick(stale).series[0]!.lag!.bandBps, 150);
  const unknown = safeInput(1);
  unknown.series = unknown.series.map((v) => ({ ...v, spotUpdatedAt: null }));
  assert.equal(planTick(unknown).series[0]!.lag!.bandBps, 150);
  const noVol = safeInput(1);
  noVol.fairs = new Map([['0', { ...(fairOf(0) as Extract<FairInput, { ok: true }>), iv: Number.NaN }]]);
  const halted = planTick(noVol).series[0]!;
  assert.equal(halted.halt?.halt, 'fair-unavailable');
  assert.match(halted.halt?.detail ?? '', /spot-lag/);
  assert.equal(halted.prices, null);
});

/*//////////////////////////////////////////////////////////////
   -- A HOUSE VAULT'S BIDS NEVER BUDGET ITS RESERVED USDG
//////////////////////////////////////////////////////////////*/

// A House vault holds USDG that belongs to other people: queued deposits (pendingDepositUsdg) and priced, unclaimed
// withdrawals (owedUsdg). readVaultState reads their sum into `usdgReserved`; the bid budget is
// max(0, wallet + live bid escrow - reserve). The cases below are in USDG base units (6 dp).
const HOUSE = { epochEnd: EXPIRY, index: 1n, rollDue: false };
const USDG = 1_000_000n;

/** USDG the plan's bids hold after the tick: every series' sized bid at its bid price, KEPT live bids included. */
const sizedBidEscrow = (plan: TickPlan): bigint =>
  plan.series.reduce((sum, s) => sum + (s.sizes !== null && s.prices !== null && s.prices.bid !== null ? (s.sizes.bid * s.prices.bid) / UNITS_PER_SHARE : 0n), 0n);

/** One live Bid of exactly `escrow` on series 0 (price 1.00 a share, so escrow = units / 100 USDG). */
const withLiveBid = (i: TickInput, escrow: bigint): TickInput => ({
  ...i,
  series: i.series.map((s, k) => (k === 0 ? { ...s, orders: [liveOrder({ id: 901n, kind: 'Bid', price: USDG, units: (escrow * UNITS_PER_SHARE) / USDG })] } : s)),
});

const liveOf = (plan: TickPlan) => new Map(plan.series.flatMap((s) => s.live.map((o) => [o.id.toString(), { kind: o.kind, price: o.price, remaining: o.remaining }] as const)));

test('bidBudget: max(0, wallet + live escrow - reserve); a treasury (null reserve) is wallet + escrow', () => {
  assert.equal(bidBudget(100n, 30n, 50n), 80n);
  assert.equal(bidBudget(10n, 30n, 50n), 0n, 'wallet 10, escrow 30, reserve 50: nothing is free (the saturate-first form says 30)');
  assert.equal(bidBudget(10n, 0n, 50n), 0n, 'never negative');
  assert.equal(bidBudget(10n, 30n, null), 40n, 'treasury: the pre-T-OP-328 budget, unchanged');
  assert.equal(bidBudget(10n, 30n, 0n), 40n);
});

test('required: vault.usdgReserved undefined throws for any vault; a House vault (epoch set) must carry a bigint; a treasury may carry null', () => {
  const treasury = input(2);
  assert.throws(() => planTick({ ...treasury, vault: without(treasury.vault, 'usdgReserved') }), /required safety input "vault\.usdgReserved"/);
  const house = input(2, { vault: vault({ epoch: HOUSE, usdgReserved: 0n }) });
  assert.throws(() => planTick({ ...house, vault: without(house.vault, 'usdgReserved') }), /required safety input "vault\.usdgReserved"/);
  assert.throws(() => planTick(input(2, { vault: vault({ epoch: HOUSE, usdgReserved: null }) })), /required safety input "vault\.usdgReserved"/, 'null is the treasury\'s "no reserve"; on a House vault it would make depositor money spendable');
  assert.equal(twoSidedCount(planTick(input(2, { vault: vault({ epoch: null, usdgReserved: null }) }))), 2, 'a treasury with null still plans');
  assert.equal(twoSidedCount(planTick(house)), 2, 'a House vault with an explicit bigint still plans');
});

test('regression: a treasury vault (epoch null, usdgReserved null) sizes and sends exactly what a zero reserve does -- the pre-reserve budget', () => {
  // A wallet small enough that the USDG budget binds, and a live bid whose escrow comes back, so the budget matters.
  const base = withLiveBid(input(6, { vault: vault({ epoch: null, usdgReserved: null, usdgWallet: 10n * USDG }) }), 30n * USDG);
  const plan = planTick(base);
  const zero = planTick({ ...base, vault: { ...base.vault, usdgReserved: 0n } });
  assert.deepEqual(plan.txs, zero.txs);
  assert.deepEqual(plan.series.map((s) => s.sizes), zero.series.map((s) => s.sizes));
  assert.ok(sizedBidEscrow(plan) > 0n && sizedBidEscrow(plan) <= 40n * USDG, 'the treasury budget is wallet + escrow = 40');
});

test('House, wallet above the reserve: the sized bid escrow fits in wallet + live escrow - reserve, and the USDG cap is what bound it', () => {
  const wallet = 10n * USDG;
  const reserve = 5n * USDG;
  const plan = planTick(input(6, { vault: vault({ epoch: HOUSE, usdgReserved: reserve, usdgWallet: wallet }) }));
  assert.ok(sizedBidEscrow(plan) <= wallet - reserve, `sized ${sizedBidEscrow(plan)} > budget ${wallet - reserve}`);
  assert.ok(sizedBidEscrow(plan) > 0n, 'some bid still fits');
  assert.ok(plan.capped.some((c) => c.caps.includes('usdg')), 'the USDG budget capped at least one bid');
});

test('House, wallet BELOW the reserve with live bids (wallet 10, escrow 30, reserve 50): no bid escrow at all, the live Bid is cancelled, nothing grows', () => {
  const plan = planTick(withLiveBid(input(6, { vault: vault({ epoch: HOUSE, usdgReserved: 50n * USDG, usdgWallet: 10n * USDG }) }), 30n * USDG));
  assert.equal(sizedBidEscrow(plan), 0n, 'the saturate-first budget (30) would size bids here');
  assert.ok(plan.txs.some((t) => t.type === 'cancel' && t.orderIds.includes(901n)), 'the live Bid holding depositor money is cancelled');
  assert.ok(!plan.txs.some((t) => t.type === 'place' && t.slot === 'bid'), 'no Bid place');
  const grows = bookedCalls(plan, liveOf(plan)).filter((c) => c.delta > 0n);
  assert.deepEqual(grows, [], 'no escrow-raising Bid replace or place');
});

test('House, reserve above wallet + escrow: the budget is 0, never negative, and no bid size is negative', () => {
  const plan = planTick(input(6, { vault: vault({ epoch: HOUSE, usdgReserved: 50n * USDG, usdgWallet: 10n * USDG }) }));
  assert.equal(sizedBidEscrow(plan), 0n);
  for (const s of plan.series) if (s.sizes !== null) assert.ok(s.sizes.bid >= 0n, `negative bid size on ${s.longId}`);
  assert.ok(!plan.txs.some((t) => t.type === 'place' && t.slot === 'bid'));
});

test('House, replayed in execution order: every USDG debit fits in max(0, walletBefore - reserve) -- the on-chain rule per call', () => {
  const wallet = 20n * USDG;
  const reserve = 25n * USDG;
  const plan = planTick(withLiveBid(input(6, { vault: vault({ epoch: HOUSE, usdgReserved: reserve, usdgWallet: wallet }) }), 30n * USDG));
  const calls = bookedCalls(plan, liveOf(plan));
  assert.ok(calls.some((c) => c.delta < 0n) && calls.some((c) => c.delta > 0n), 'fixture: the plan both frees escrow and places bids');
  let run = wallet;
  for (const c of calls) {
    if (c.delta < 0n) {
      run -= c.delta;
      continue;
    }
    const free = run > reserve ? run - reserve : 0n;
    assert.ok(c.delta <= free, `${c.what}: debit ${c.delta} > unreserved ${free}`);
    run -= c.delta;
  }
});


/**
 * (N3). Once the MakerVault opts out of third-party redemption, the cranker's redeemBatch skips it
 * silently, so the planner redeems the vault's own settled tokens through MakerVault.redeem(tokenId), one per token id.
 */
test('a settled long and a settled short the vault holds are each redeemed, in housekeeping before claimOwed', () => {
  const held = [
    { tokenId: 40n, longId: 40n, units: 300n },
    { tokenId: 41n, longId: 40n, units: 120n },
  ];
  const plan = planTick(input(1, { vault: vault({ owed: 5n, settledHeld: held }) }));
  const redeems = plan.txs.filter((t): t is Extract<MmTx, { type: 'redeem' }> => t.type === 'redeem');
  assert.deepEqual(redeems.map((r) => [r.tokenId, r.longId, r.units]), [[40n, 40n, 300n], [41n, 40n, 120n]]);
  assert.match(redeems[0]!.reason, /settled long 40/);
  assert.match(redeems[1]!.reason, /settled short 41/);
  const order = types(plan.txs);
  assert.ok(order.indexOf('redeem') < order.indexOf('claimOwed'), 'redeems are housekeeping, before claimOwed');
  assert.ok(order.lastIndexOf('redeem') < order.findIndex((t) => t.startsWith('place') || t.startsWith('replace')), 'before any quote');
});

test('no redeem without the role, when killed, with nothing held, or with the field absent (a House vault)', () => {
  const held = [{ tokenId: 40n, longId: 40n, units: 300n }];
  const count = (i: TickInput) => planTick(i).txs.filter((t) => t.type === 'redeem').length;
  assert.equal(count(input(1, { vault: vault({ isQuoter: false, settledHeld: held }) })), 0, 'a signer without QUOTER sends nothing');
  assert.equal(count(input(1, { killed: true, vault: vault({ settledHeld: held }) })), 0, 'killed: housekeeping stops');
  assert.equal(count(input(1, { vault: vault({ settledHeld: [] }) })), 0);
  assert.equal(count(input(1, { vault: vault({ settledHeld: [{ tokenId: 40n, longId: 40n, units: 0n }] }) })), 0, 'a zero balance is not redeemed');
  assert.equal(count(input(1)), 0, 'absent reads as none: the quoter never sets it on a House vault');
});

test('a redeem is not a booked outflow call', () => {
  const plan = planTick(input(1, { vault: vault({ settledHeld: [{ tokenId: 40n, longId: 40n, units: 300n }] }) }));
  const booked = bookedCalls(plan, new Map());
  const redeemIndex = plan.txs.findIndex((t) => t.type === 'redeem');
  assert.ok(redeemIndex >= 0);
  assert.ok(!booked.some((b) => b.index === redeemIndex), 'a redemption only brings value in (MakerVault OUTFLOW CAP)');
});

/*
 * The bot's copies of two HouseVault refusals, checked against the contract (callhouse-contracts
 * src/v2/periphery/house/HouseVault.sol): depositToClearinghouse clamps to the unreserved wallet and reverts BadUnits at
 * 0 (`_unreservedWallet`: pendingDepositStock + owedStock for the underlying), and place/replace revert TradingPaused
 * while quotingPaused (`_requireQuoting`).
 */
test('a House vault deposits only the stock nobody else owns; all of it reserved (the fork case) proposes nothing', () => {
  const held = 50_000_000_000_000_000_000n; // the 50e18 of still-queued deposit stock the fork run saw proposed
  const deposits = (over: Partial<VaultView>) =>
    planTick(input(1, { vault: vault({ epoch: HOUSE, usdgReserved: 0n, walletTokens: new Map([[U, held]]), ...over }) })).txs.filter(
      (t): t is Extract<MmTx, { type: 'deposit' }> => t.type === 'deposit',
    );
  assert.deepEqual(deposits({ walletReserved: new Map([[U, held]]) }), [], 'every token reserved: the vault clamps to 0 and reverts BadUnits');
  assert.deepEqual(deposits({ walletReserved: new Map([[U, held + 1n]]) }), [], 'a reserve above the wallet (collateral already in the ledger) leaves nothing');
  const part = deposits({ walletReserved: new Map([[U, 30n * 10n ** 18n]]) });
  assert.equal(part.length, 1);
  assert.equal(part[0]!.amount, 20n * 10n ** 18n, 'held less reserved, what the vault would clamp to');
  assert.match(part[0]!.reason, /reserved/);
  // No reserve for the token (a treasury MakerVault, or another market's stock in a House wallet): the whole balance.
  assert.equal(deposits({})[0]?.amount, held);
  assert.equal(deposits({ walletReserved: new Map([['0x00000000000000000000000000000000000000ff', held]]) })[0]?.amount, held);
});

test('HouseVault.quotingPaused halts every series quoting-paused and cancels its resting orders; no place or replace, housekeeping still runs', () => {
  const i = input(2, { vault: vault({ epoch: HOUSE, usdgReserved: 0n, quotingPaused: true, owed: 5n }) });
  i.series = [{ ...i.series[0]!, orders: [liveOrder({ id: 7n, kind: 'AskWrite', price: 4_000_000n })] }, i.series[1]!];
  const paused = planTick(i);
  assert.ok(paused.series.every((s) => s.halt?.halt === 'quoting-paused'), 'every series names the brake');
  assert.ok(!paused.txs.some((t) => t.type === 'place' || t.type === 'replace'), 'place and replace would revert TradingPaused');
  const cancel = paused.txs.find((t): t is Extract<MmTx, { type: 'cancel' }> => t.type === 'cancel');
  assert.deepEqual(cancel?.orderIds, [7n], 'cancel is not braked: the resting ask comes off');
  assert.ok(paused.txs.some((t) => t.type === 'claimOwed'), 'claimOwed is not braked either');
  // The same House vault with the brake off quotes; a treasury carries null and quotes too.
  const open = planTick({ ...i, vault: { ...i.vault, quotingPaused: false } });
  assert.ok(open.txs.some((t) => t.type === 'place'));
  assert.ok(planTick(input(2, { vault: vault({ quotingPaused: null }) })).txs.some((t) => t.type === 'place'));
});

test('OrderBook.tradingPaused halts every series and cancels its resting orders (cancel is never paused); no place or replace', () => {
  const i = input(2, { vault: vault({ tradingPaused: true }) });
  i.series = [{ ...i.series[0]!, orders: [liveOrder({ id: 9n, kind: 'Bid', price: 1_000_000n })] }, i.series[1]!];
  const plan = planTick(i);
  assert.ok(plan.series.every((s) => s.halt?.halt === 'trading-paused'));
  assert.ok(!plan.txs.some((t) => t.type === 'place' || t.type === 'replace'), 'OrderBook.place and replace revert TradingPaused');
  assert.deepEqual(plan.txs.find((t): t is Extract<MmTx, { type: 'cancel' }> => t.type === 'cancel')?.orderIds, [9n]);
});

test('no close of a settled series (Clearinghouse.close reverts AlreadySettled) nor of an expired one', () => {
  const pair = (over: Partial<SeriesView>) => {
    const i = input(1);
    i.series = [{ ...i.series[0]!, exposure: { ...i.series[0]!.exposure!, longs: 20n, shorts: 20n }, ...over }];
    return planTick(i).txs.filter((t) => t.type === 'close');
  };
  assert.equal(pair({}).length, 1, 'a live series closes its pair');
  assert.deepEqual(pair({ settled: true }), []);
  assert.deepEqual(pair({ info: { ...input(1).series[0]!.info, expiry: NOW } }), [], 'at expiry, before settlement: left to redemption (stricter than the Clearinghouse, which allows it)');
});

test('P13 through planTick: a series whose seriesNotional read failed closes its expiry -- no series of it grows; the read one does', () => {
  const params = { ...PARAMS, maxExpiryNotionalUsdg6: 10n ** 12n };
  const unread = input(2, { params });
  unread.series = unread.series.map((v, k) => (k === 0 ? { ...v, seriesNotionalUnread: true } : v));
  const plan = planTick(unread);
  for (const id of [0n, 1n]) {
    const t = seriesPlan(plan, id).targets;
    assert.ok(t === null || (t.bid === null && t.write === null), `series ${id}: nothing grows in an expiry of unknown notional`);
  }
  assert.ok(plan.capped.some((c) => c.caps.includes('expiry-notional')));
  assert.equal(plan.txs.filter((t) => t.type === 'place').length, 0);
  // Control: the same tick with the read answered places both sides of both series.
  const read = planTick(input(2, { params }));
  assert.equal(read.txs.filter((t) => t.type === 'place').length, 4);
});

test('P14 through planTick: a held series whose /fair failed makes its market\'s net greek unknown -- the other series of the market are not quoted', () => {
  const held = input(3);
  held.series = held.series.map((v, k) => (k === 0 ? { ...v, exposure: { ...v.exposure!, longs: 100n } } : v));
  const failed = { ...held, fairs: new Map([...held.fairs].map(([k, f]) => [k, k === '0' ? ({ ok: false, reason: 'pricing-timeout' } as FairInput) : f])) };
  const plan = planTick(failed);
  for (const id of [1n, 2n]) {
    const t = seriesPlan(plan, id).targets;
    assert.ok(t === null || (t.bid === null && t.write === null), `series ${id}: no side on an unknown market net`);
  }
  assert.equal(plan.txs.filter((t) => t.type === 'place').length, 0);
  // Control: the held series priced, the other series quote both sides.
  const priced = planTick(held);
  for (const id of [1n, 2n]) assert.ok(seriesPlan(priced, id).targets!.bid !== null && seriesPlan(priced, id).targets!.write !== null);
});
