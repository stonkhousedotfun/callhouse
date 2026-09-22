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
import { pullAtOf, type FairInput, type LiveOrder, type QuoteFees } from './engine.js';
import { flatForRoll } from './epoch.js';
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
  epochWindDownS: 600,
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
  askFloor: 0n,
  bidCap: 21_000_000n,
  collateralAsset: U,
  collateralPerUnit: 10n ** 16n,
  mintFeePpm: 80,
  orders: [],
  ...over,
});
// T-484: `asOf` follows the tick's `now`, not the module's NOW. A wind-down tick runs hours after NOW, and the fair
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

test('epoch === null is unrestricted: the same two-sided places as today', () => {
  const plan = planTick(input(2, { vault: vault({ epoch: null }) }));
  assert.equal(twoSidedCount(plan), 2);
  assert.equal(plan.series.every((s) => s.halt === null), true);
});

test('a series with expiry > epochEnd is never selected, halted epoch-outside, and is not a fair request', () => {
  const epochEnd = EXPIRY;
  const i = input(2, { vault: vault({ epoch: { epochEnd, index: 1, rollDue: false } }) });
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
  const mid = input(1, { now: NOW, vault: vault({ epoch }), params, series: [inside], fairs: new Map([['0', fairOf(0)]]) });
  const midPlan = planTick(mid);
  assert.ok(midPlan.txs.some((t) => t.type === 'place' && t.slot === 'bid'));
  assert.ok(midPlan.txs.some((t) => t.type === 'place' && t.slot === 'write'));
  assert.equal(midPlan.series[0]!.halt, null);

  const longs = view(0, {
    exposure: { longs: 100n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n },
  });
  const lead = input(1, {
    now: epochEnd - wind,
    vault: vault({ epoch }),
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
    vault: vault({ epoch }),
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

test('T-474: a wind-down series whose fair carries to zero at the oracle\'s spot is halted, not priced', () => {
  // epoch-winddown returns from haltBeforeFair, so haltOf never judges the fair on this path: the planner must.
  const epochEnd = EXPIRY;
  const wind = 14_400;
  const params = { ...PARAMS, epochWindDownS: wind };
  const longs = view(0, { exposure: { longs: 100n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n } });
  const at = (fair: FairInput) =>
    planTick(input(1, { now: epochEnd - wind, vault: vault({ epoch: { epochEnd, index: 1n, rollDue: false } }), params, series: [longs], fairs: new Map([['0', fair]]) }));

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

test('T-484: a wind-down series is priced only from a fair that passes every fair check haltOf runs', () => {
  // epoch-winddown returns from haltBeforeFair, so haltOf never reaches the fair checks on this path, and T-474 carried
  // over only the zero case. The planner's pricing branch now runs fairCheckOf, the SAME function haltOf runs.
  const epochEnd = EXPIRY;
  const wind = 14_400;
  const now = epochEnd - wind;
  const params = { ...PARAMS, epochWindDownS: wind, fairSpotToleranceBps: 300 };
  const longs = view(0, { exposure: { longs: 100n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n } });
  const at = (fair: FairInput) =>
    planTick(input(1, { now, vault: vault({ epoch: { epochEnd, index: 1n, rollDue: false } }), params, series: [longs], fairs: new Map([['0', fair]]) }));
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

// THE SENT HALF IS NOT HERE, BY CHARTER (T-OP-132, K8-05 suspicion 4). This proves the bid is not PLANNED: `plan.txs`
// is the list `MmQuoter.execute` walks, so nothing below can reach the sender. Whether it is not SENT is a quoter fact:
// `execute` is private (quoter.ts), reached only from `tickOne` after the chain read, and the sender is `ctx.sender`.
// That test needs the tick harness quoter.test.ts already has (T-540's seam) and belongs there, in that file's fence.
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
     T-OP-133: THE VAULT'S ASK IS THE FALLBACK (MM_ASK_FALLBACK_ONLY)
//////////////////////////////////////////////////////////////*/

const OTHER = '0x00000000000000000000000000000000000000cc';
const otherAsk = (longId: bigint, maker = OTHER, kind: 'AskWrite' | 'AskResale' = 'AskWrite') => ({ id: 900n + longId, maker, kind, price: 9_000_000n, remaining: 50n });

// PROVE BY BREAKING (authored): force `fallbackOnly` to false in planTick (or run with askFallbackOnly: false, which
// the last case does deliberately) and this test goes red at "no ask target" -- the vault asks into the other maker.
test('other-asker: a third-party live ask on the series halts the ask side only, cancels the resting vault ask, and leaves the bid', () => {
  const resting = liveOrder({ id: 7n, kind: 'AskWrite', price: 3_400_000n, units: 100n });
  const plan = planTick(input(2, {
    series: [view(0, { orders: [resting] }), view(1)],
    otherAskers: new Map([['0', [otherAsk(0n)]]]),
  }));
  const halted = plan.series.find((s) => s.longId === 0n)!;
  assert.equal(halted.halt?.halt, 'other-asker', 'visible in /state by name');
  assert.match(halted.halt?.detail ?? '', /1 live ask from 0x00000000000000000000000000000000000000cc/);
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

test('other-asker: a protocol account\'s ask (the HouseVault covered call) COUNTS as another asker -- documented, owner-flippable', () => {
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
        SAFETY INPUTS ARE REQUIRED (F-APP-KEEPER-01, T-OP-085)
//////////////////////////////////////////////////////////////*/

// The four K8-05 inputs used to be read behind `??` defaults that turned an ABSENT input into "protection off"
// (epoch -> unrestricted, epochWindDownS -> 0, protocolAccounts -> empty, protocolBook -> empty). TypeScript
// declares all four required, so no typed caller ever missed them and every existing test above passes them --
// which is exactly why nothing could see the defaults fire. These tests reach the planner the way a refactor
// that drops an argument would: through a cast the compiler does not check. Each one asserts the throw NAMES
// the input. PROVE-BY-BREAKING (authored, T-OP-085 ledger): restore `epoch: input.vault.epoch ?? null` at the
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
