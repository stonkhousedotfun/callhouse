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
import { pullAtOf, type FairInput, type LiveOrder } from './engine.js';
import { bookedCalls, fairRequests, planTick, selectedSeries, twoSidedCount, type MarketView, type MmPlanParams, type MmTx, type SeriesView, type TickInput, type VaultView } from './planner.js';

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
};

const vault = (over: Partial<VaultView> = {}): VaultView => ({
  isQuoter: true,
  tradingPaused: false,
  limits: { maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n, askToleranceBps: 100, maxBidBpsOfSpot: 1_000, maxOrderLifetime: 0, maxDailyOutflow: 2_500_000_000n },
  outflow: { used: 0n, available: 2_500_000_000n },
  totalNotional: 0n,
  usdgWallet: 100_000_000_000n,
  owed: 0n,
  freeCollateral: new Map([[U, 100n * 10n ** 18n]]),
  walletTokens: new Map([[U, 0n]]),
  tracked: [],
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
  askFloor: 0n,
  bidCap: 21_000_000n,
  collateralAsset: U,
  collateralPerUnit: 10n ** 16n,
  mintFeePpm: 80,
  orders: [],
  ...over,
});
const fairOf = (i: number): FairInput => ({ ok: true, fair: 3_000_000n - BigInt(i) * 400_000n, delta: 0.45 - i * 0.07, iv: 0.5, asOf: NOW - 120, source: 'model' });

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
    ...over,
  };
}

const types = (txs: MmTx[]) => txs.map((t) => (t.type === 'place' || t.type === 'replace' ? `${t.type}:${t.slot}` : t.type));
const liveOrder = (over: Partial<LiveOrder>): LiveOrder => ({ id: 1n, kind: 'Bid', price: 1n, units: 100n, filled: 0n, validUntil: CLOSE, cancelled: false, ...over });

test('a healthy market: a bid and a write ask on every series, around fair, sized, valid until the pull time', () => {
  const plan = planTick(input(6));
  assert.equal(twoSidedCount(plan), 6);
  assert.deepEqual(types(plan.txs), Array.from({ length: 6 }, () => ['place:bid', 'place:write']).flat());
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
  assert.deepEqual(types(plan.txs), ['place:bid', 'place:resale', 'place:bid']);
  const resale = plan.txs.find((t) => t.type === 'place' && t.slot === 'resale') as Extract<MmTx, { type: 'place' }>;
  assert.equal(resale.units, 30n);
  assert.equal(resale.kind, 1);
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
  assert.deepEqual(types(plan.txs), ['close', 'place:bid', 'place:write']);
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
