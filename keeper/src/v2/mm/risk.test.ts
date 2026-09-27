/**
 * Quote sizes under the MakerVault's size guards and the bot's own caps.
 *
 * WHY THIS FILE EXISTS: a size the vault's post-condition refuses is a simulation revert (the series goes unquoted) and
 * a size the funds cannot back is depth that is not there (a write ask the ledger cannot mint is skipped by takers).
 * Pinned here: the vault's exposure formula restated exactly; the per-series cap as the smaller of the vault's and the
 * bot's; the total-notional cap spent in quoting priority, stored notional of other series included; one USDG budget
 * for every bid and one collateral budget per asset for every write ask; inventory offered before writing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collateralNeeded } from '../mintFee.js';
import { exposureUnits, gateGreeks, greekBreach, marketGreeksOf, notionalOf, planSizes, type MarketGreeks, type SizeLimits, type SizeSeries } from './risk.js';

const NVDA = '0x00000000000000000000000000000000000000aa';
const UNIT = 10n ** 16n;
const NOW = 1_790_000_000;

const s = (over: Partial<SizeSeries> = {}): SizeSeries => ({
  longId: 1n,
  strike: 200_000_000n,
  longs: 0n,
  resale: 0n,
  shorts: 0n,
  seriesNotional: 0n,
  collateralAsset: NVDA,
  collateralPerUnit: UNIT,
  mintFeePpm: 0,
  expiry: NOW + 7 * 86_400,
  bidPrice: 2_000_000n,
  askPrice: 2_200_000n,
  writeAllowed: true,
  ...over,
});

const limits = (over: Partial<SizeLimits> = {}): SizeLimits => ({
  now: NOW,
  vaultMaxSeriesUnits: 10_000n,
  botMaxSeriesUnits: 0n,
  vaultMaxTotalNotional: 250_000_000_000n,
  botMaxTotalNotional: 0n,
  totalNotional: 0n,
  usdgBudget: 100_000_000_000n,
  outflowBudget: 100_000_000_000n,
  freeCollateral: new Map([[NVDA, 100n * 10n ** 18n]]),
  bidUnits: 100n,
  askUnits: 100n,
  ...over,
});

test('exposureUnits restates MakerVault._units: up counts longs, escrow and bids; down counts shorts and writes against wallet longs', () => {
  assert.equal(exposureUnits({ longs: 0n, resale: 0n, shorts: 100n, bid: 50n, write: 100n, resaleOrder: 0n }), 200n);
  assert.equal(exposureUnits({ longs: 30n, resale: 20n, shorts: 0n, bid: 10n, write: 0n, resaleOrder: 20n }), 60n);
  // 50 longs all offered for resale leave the wallet: down = shorts + writes - 0.
  assert.equal(exposureUnits({ longs: 50n, resale: 0n, shorts: 40n, bid: 0n, write: 30n, resaleOrder: 50n }), 70n);
  assert.equal(exposureUnits({ longs: 100n, resale: 0n, shorts: 100n, bid: 0n, write: 0n, resaleOrder: 0n }), 0n, 'a closeable pair is flat');
  assert.equal(notionalOf(100n, 200_000_000n), 200_000_000n);
});

test('planSizes: the configured sizes when nothing binds', () => {
  const [out] = planSizes([s()], limits());
  assert.deepEqual(out, { longId: 1n, bid: 100n, write: 100n, resale: 0n, exposure: 100n, notional: 200_000_000n, capped: [] });
});

test('planSizes: the per-series cap is the smaller of the vault\'s and the bot\'s', () => {
  const [bot] = planSizes([s()], limits({ botMaxSeriesUnits: 60n }));
  assert.equal(bot!.bid, 60n);
  assert.equal(bot!.write, 60n);
  assert.deepEqual(bot!.capped, ['series-units']);
  const [vault] = planSizes([s()], limits({ vaultMaxSeriesUnits: 40n, botMaxSeriesUnits: 60n }));
  assert.equal(vault!.bid, 40n);
  // Existing shorts: up = bid - shorts has room for more bids, down = shorts + write has less room for writes.
  const [short] = planSizes([s({ shorts: 100n })], limits({ vaultMaxSeriesUnits: 150n }));
  assert.equal(short!.bid, 100n);
  assert.equal(short!.write, 50n);
  assert.equal(short!.exposure, 150n);
});

test('planSizes: total notional is spent in priority order, counting what other series already store', () => {
  const out = planSizes([s({ longId: 1n }), s({ longId: 2n })], limits({ botMaxTotalNotional: 300_000_000n }));
  assert.deepEqual(out.map((x) => [x.bid, x.write, x.capped]), [
    [100n, 100n, []],
    [50n, 50n, ['total-notional']],
  ]);
  assert.equal(out[0]!.notional + out[1]!.notional, 300_000_000n);

  const [stored] = planSizes([s()], limits({ vaultMaxTotalNotional: 300_000_000n, totalNotional: 250_000_000n }));
  assert.equal(stored!.bid, 25n, 'another series stores 250 USDG: 50 USDG of room at a 200 strike');
  const [own] = planSizes([s({ seriesNotional: 200_000_000n })], limits({ vaultMaxTotalNotional: 300_000_000n, totalNotional: 250_000_000n }));
  assert.equal(own!.bid, 100n, 'the series\' own stored notional is replaced, not added');
});

test('planSizes: one USDG budget for every bid, one collateral budget per asset for every write ask', () => {
  const usdg = planSizes([s({ longId: 1n }), s({ longId: 2n })], limits({ usdgBudget: 3_000_000n }));
  assert.deepEqual(usdg.map((x) => [x.bid, x.capped]), [
    [100n, []],
    [50n, ['usdg']],
  ]);
  const collateral = planSizes([s({ longId: 1n }), s({ longId: 2n }), s({ longId: 3n, collateralAsset: '0x00000000000000000000000000000000000000cc' })], limits({ freeCollateral: new Map([[NVDA, 150n * UNIT]]) }));
  assert.deepEqual(collateral.map((x) => [x.write, x.capped]), [
    [100n, []],
    [50n, ['collateral']],
    [0n, ['collateral']],
  ]);
  const [unknown] = planSizes([s({ collateralPerUnit: 0n })], limits());
  assert.equal(unknown!.write, 0n);
});

test('planSizes: a write ask reserves collateral PLUS the rent, exactly as OrderBook._reserveCollateral does', () => {
  const rem = 7 * 86_400;
  const expiry = NOW + rem;
  // Exactly 100 units of collateral free at NVDA's launch rate: the rent costs the ask its last unit, so an order
  // sized at free / collateralPerUnit would be skipped by the book rather than filled.
  const one = planSizes([s({ mintFeePpm: 80, expiry })], limits({ freeCollateral: new Map([[NVDA, 100n * UNIT]]) }));
  assert.equal(one[0]!.write, 99n);
  assert.deepEqual(one[0]!.capped, ['collateral']);
  assert.equal(collateralNeeded(one[0]!.write, UNIT, 80, rem) <= 100n * UNIT, true, 'the advertised size fits');
  assert.equal(collateralNeeded(one[0]!.write + 1n, UNIT, 80, rem) > 100n * UNIT, true, 'and one more unit would not');

  // 0 ppm is the v6 answer, so the rent is the only thing that moved.
  assert.equal(planSizes([s({ mintFeePpm: 0, expiry })], limits({ freeCollateral: new Map([[NVDA, 100n * UNIT]]) }))[0]!.write, 100n);
  // Expired (and so past the mint cutoff): no life left to rent.
  assert.equal(planSizes([s({ mintFeePpm: 80, expiry: NOW })], limits({ freeCollateral: new Map([[NVDA, 100n * UNIT]]) }))[0]!.write, 100n);

  // Two asks on one asset: the second starts from what the first truly leaves, rent included, so the pair still fits.
  const free = 150n * UNIT;
  const pair = planSizes([s({ longId: 1n, mintFeePpm: 1_500, expiry }), s({ longId: 2n, mintFeePpm: 1_500, expiry })], limits({ freeCollateral: new Map([[NVDA, free]]) }));
  const total = collateralNeeded(pair[0]!.write, UNIT, 1_500, rem) + collateralNeeded(pair[1]!.write, UNIT, 1_500, rem);
  assert.ok(total <= free, `${total} > ${free}: the second ask reused the first ask's rent`);
  assert.equal(pair[0]!.write, 100n);
  assert.ok(pair[1]!.write >= 49n && pair[1]!.write <= 50n, `${pair[1]!.write}`);
});

test('planSizes: bids stay inside the vault\'s daily outflow budget, and say so', () => {
  // Room for one 2 USDG share of escrow and no more: the second series is trimmed, the third gets nothing.
  const out = planSizes([s({ longId: 1n }), s({ longId: 2n }), s({ longId: 3n })], limits({ outflowBudget: 3_000_000n }));
  assert.deepEqual(out.map((x) => [x.bid, x.capped]), [
    [100n, []],
    [50n, ['outflow']],
    [0n, ['outflow']],
  ]);
  // Escrow is price × units / 100, and the whole plan fits in the budget.
  assert.equal(out.reduce((sum, x, i) => sum + (2_000_000n * x.bid) / 100n, 0n), 3_000_000n);
  assert.equal(planSizes([s()], limits({ outflowBudget: 0n }))[0]!.bid, 0n, 'a full bucket quotes no bid at all');
  assert.deepEqual(planSizes([s()], limits({ outflowBudget: 0n }))[0]!.capped, ['outflow']);
  // The ask side is not booked by the cap: a frozen bucket still writes.
  assert.equal(planSizes([s()], limits({ outflowBudget: 0n }))[0]!.write, 100n);
  // The tighter of the two USDG limits binds, and both are named when they bind together.
  const both = planSizes([s()], limits({ usdgBudget: 1_000_000n, outflowBudget: 1_000_000n }));
  assert.equal(both[0]!.bid, 50n);
  assert.deepEqual(both[0]!.capped, ['usdg']);
});

test('planSizes: inventory is offered for resale before writing; a mint-paused market offers inventory only', () => {
  const [inv] = planSizes([s({ longs: 70n })], limits());
  assert.equal(inv!.resale, 70n);
  assert.equal(inv!.write, 30n);
  const [lots] = planSizes([s({ longs: 500n })], limits());
  assert.equal(lots!.resale, 100n);
  assert.equal(lots!.write, 0n);
  const [paused] = planSizes([s({ longs: 40n, writeAllowed: false })], limits());
  assert.equal(paused!.resale, 40n);
  assert.equal(paused!.write, 0n);
  const [noAsk] = planSizes([s({ askPrice: null, bidPrice: null })], limits());
  assert.deepEqual([noAsk!.bid, noAsk!.write, noAsk!.resale], [0n, 0n, 0n]);
});

/*//////////////////////////////////////////////////////////////
   ONE OVERSUBSCRIBED WRITE POOL (MM_WRITE_OVERSUBSCRIBE_BPS)
//////////////////////////////////////////////////////////////*/

// BREAK CHECK: size every ask against `collateralLeft` alone (drop the `single` bound) and the
// "each ask <= maxWriteUnits(free)" assertion below goes red at 20_000 bps with free = 150 units: the first ask
// would advertise 100 and the second 100 too, the second above what one fill of it can be covered by after the
// first fills. Drop the oversubscription factor instead and the "sum advertised == free x bps / 1e4" line goes red.
test('planSizes: the write pool is free x bps / 1e4 for SIZING, while every single ask still fits maxWriteUnits(free)', () => {
  const free = 150n * UNIT;
  const four = [s({ longId: 1n }), s({ longId: 2n }), s({ longId: 3n }), s({ longId: 4n })];

  // 10_000 bps: today's exact budget, unchanged -- the advertised sum never exceeds free.
  const exact = planSizes(four, limits({ freeCollateral: new Map([[NVDA, free]]), writeOversubscribeBps: 10_000 }));
  assert.deepEqual(exact.map((x) => x.write), [100n, 50n, 0n, 0n]);
  assert.deepEqual(planSizes(four, limits({ freeCollateral: new Map([[NVDA, free]]) })).map((x) => x.write), [100n, 50n, 0n, 0n], 'absent = 10_000');

  // 20_000 bps: the pool is 300 units for sizing; 100 + 100 + 100 = 300 advertised, each ask alone coverable by 150.
  const twice = planSizes(four, limits({ freeCollateral: new Map([[NVDA, free]]), writeOversubscribeBps: 20_000 }));
  assert.deepEqual(twice.map((x) => x.write), [100n, 100n, 100n, 0n]);
  const advertised = twice.reduce((sum, x) => sum + x.write, 0n);
  assert.equal(advertised * UNIT, (free * 20_000n) / 10_000n, 'sum advertised == free x bps / 1e4 (rent 0 here)');
  for (const x of twice) assert.ok(x.write * UNIT <= free, `ask ${x.longId} advertises ${x.write} units, above what one fill of it can be covered by`);

  // 50_000 bps (the runbook suggestion): five asks of the per-series size from the same 150 units.
  const five = planSizes([...four, s({ longId: 5n }), s({ longId: 6n })], limits({ freeCollateral: new Map([[NVDA, free]]), writeOversubscribeBps: 50_000 }));
  assert.deepEqual(five.map((x) => x.write), [100n, 100n, 100n, 100n, 100n, 100n]);

  // A single ask can never exceed what the chain covers, whatever the factor: free of 60 units caps EVERY ask at 60.
  const small = planSizes(four, limits({ freeCollateral: new Map([[NVDA, 60n * UNIT]]), writeOversubscribeBps: 50_000 }));
  assert.deepEqual(small.map((x) => [x.write, x.capped.includes('collateral')]), [[60n, true], [60n, true], [60n, true], [60n, true]]);
  assert.deepEqual(small.map((x) => x.write), [60n, 60n, 60n, 60n], 'sizing pool 300, but each ask <= maxWriteUnits(60)');
});

test('planSizes: oversubscription touches asks only; bids escrow real USDG and keep their exact budget', () => {
  const bids = planSizes([s({ longId: 1n }), s({ longId: 2n })], limits({ usdgBudget: 3_000_000n, writeOversubscribeBps: 50_000 }));
  assert.deepEqual(bids.map((x) => [x.bid, x.capped.includes('usdg')]), [[100n, false], [50n, true]]);
});

/*//////////////////////////////////////////////////////////////
       P13 (PER-EXPIRY NOTIONAL) AND P14 (GREEK GATE)
//////////////////////////////////////////////////////////////*/

test('P13: one expiry\'s notional is capped in quoting priority, stored notional of unquoted series included; other expiries are untouched; 0n is off', () => {
  const E1 = NOW + 86_400;
  const E2 = NOW + 2 * 86_400;
  // 300 USDG per expiry. Each series at strike 200 wants 100 units a side = 1 share = 200 USDG of notional.
  const cap = 300_000_000n;
  const sizes = planSizes([s({ longId: 1n, expiry: E1 }), s({ longId: 2n, expiry: E1 }), s({ longId: 3n, expiry: E2 })], limits({ maxExpiryNotional: cap, expiryNotional: new Map() }));
  assert.deepEqual(sizes.map((x) => [x.longId, x.bid, x.write]), [[1n, 100n, 100n], [2n, 50n, 50n], [3n, 100n, 100n]]);
  assert.deepEqual(sizes[1]!.capped, ['expiry-notional']);
  assert.ok(sizes[1]!.notional + sizes[0]!.notional <= cap);
  assert.deepEqual(sizes[2]!.capped, [], 'a different expiry has its own room');

  // An UNQUOTED series of E1 already stores 250 USDG: 50 USDG = 25 units are left for the quoted one.
  const stored = planSizes([s({ longId: 1n, expiry: E1 })], limits({ maxExpiryNotional: cap, expiryNotional: new Map([[E1, 250_000_000n]]) }));
  assert.deepEqual([stored[0]!.bid, stored[0]!.write, stored[0]!.capped], [25n, 25n, ['expiry-notional']]);

  // Its OWN stored notional is not counted twice (it is replaced by the planned state, as the total cap does).
  const own = planSizes([s({ longId: 1n, expiry: E1, seriesNotional: 200_000_000n })], limits({ maxExpiryNotional: cap, expiryNotional: new Map([[E1, 200_000_000n]]) }));
  assert.deepEqual([own[0]!.bid, own[0]!.write], [100n, 100n]);

  const off = planSizes([s({ longId: 1n, expiry: E1 }), s({ longId: 2n, expiry: E1 })], limits({ maxExpiryNotional: 0n, expiryNotional: new Map([[E1, 10n ** 15n]]) }));
  assert.deepEqual(off.map((x) => x.bid), [100n, 100n], '0n: no per-expiry cap');
});

const flatMarket = (): MarketGreeks => ({ delta: { lo: 0, hi: 0 }, gamma: { lo: 0, hi: 0 } });
const LIM = { maxDeltaShares: 10, maxGamma: 2 };

test('P14 greekBreach: a move past the limit AND away from zero; a move towards zero never breaches, however large the net', () => {
  assert.equal(greekBreach({ lo: -9, hi: -9 }, -2, 10), true, '-9 -> -11');
  assert.equal(greekBreach({ lo: -9, hi: -9 }, 2, 10), false, '-9 -> -7: towards zero');
  assert.equal(greekBreach({ lo: -50, hi: -50 }, 5, 10), false, 'far past the limit, but reducing');
  assert.equal(greekBreach({ lo: 5, hi: 5 }, -30, 10), true, '5 -> -25 crosses zero and ends past the limit');
  assert.equal(greekBreach({ lo: 5, hi: 5 }, -12, 10), false, '5 -> -7: inside');
  assert.equal(greekBreach({ lo: -9, hi: -9 }, -2, 0), false, 'limit 0 is off');
});

test('P14 gateGreeks: only the side that increases |net delta| is stopped -- a short-delta market loses its call ASK, keeps the BID; a long one the reverse', () => {
  // 0.4-delta call, 1 share a side. Market already 9.8 shares short delta.
  const short = { delta: { lo: -9.8, hi: -9.8 }, gamma: { lo: 0, hi: 0 } };
  const g1 = gateGreeks({ market: short, delta: 0.4, gamma: 0.01, bidUnits: 100n, askUnits: 100n, limits: LIM });
  assert.deepEqual([g1.bid, g1.ask], [true, false]);
  assert.match(g1.reasons.join(), /ask: net delta -9\.80 -> -10\.20 shares past 10/);
  const long = { delta: { lo: 9.8, hi: 9.8 }, gamma: { lo: 0, hi: 0 } };
  const g2 = gateGreeks({ market: long, delta: 0.4, gamma: 0.01, bidUnits: 100n, askUnits: 100n, limits: LIM });
  assert.deepEqual([g2.bid, g2.ask], [false, true]);
  // A put: selling it ADDS delta (put delta is negative), so a long-delta market stops the put ask.
  const g3 = gateGreeks({ market: { delta: { lo: 9.8, hi: 9.8 }, gamma: { lo: 0, hi: 0 } }, delta: -0.4, gamma: 0.01, bidUnits: 100n, askUnits: 100n, limits: LIM });
  assert.deepEqual([g3.bid, g3.ask], [true, false]);
});

test('P14 gateGreeks: gamma -- selling options is short gamma and is stopped past MM_MAX_GAMMA; buying back is not', () => {
  const m: MarketGreeks = { delta: { lo: 0, hi: 0 }, gamma: { lo: -1.9, hi: -1.9 } };
  const g = gateGreeks({ market: m, delta: 0, gamma: 0.2, bidUnits: 100n, askUnits: 100n, limits: LIM });
  assert.deepEqual([g.bid, g.ask], [true, false]);
  assert.match(g.reasons.join(), /ask: net gamma/);
});

test('P14 gateGreeks: the range accumulates across series of one market (two asks cannot share the same room), and an unknown greek fails closed', () => {
  const m = flatMarket();
  const a = gateGreeks({ market: m, delta: 0.3, gamma: 0, bidUnits: 0n, askUnits: 2_000n, limits: LIM });
  assert.equal(a.ask, true, '20 shares x 0.3 = -6');
  const b = gateGreeks({ market: m, delta: 0.3, gamma: 0, bidUnits: 0n, askUnits: 2_000n, limits: LIM });
  assert.equal(b.ask, false, 'a second -6 would reach -12');
  assert.deepEqual(m.delta, { lo: -6, hi: 0 });
  const unknown = gateGreeks({ market: flatMarket(), delta: 0.3, gamma: null, bidUnits: 100n, askUnits: 100n, limits: LIM });
  assert.deepEqual([unknown.bid, unknown.ask], [false, false]);
  const off = gateGreeks({ market: flatMarket(), delta: null, gamma: null, bidUnits: 100n, askUnits: 100n, limits: { maxDeltaShares: 0, maxGamma: 0 } });
  assert.deepEqual([off.bid, off.ask], [true, true], 'both limits off: nothing to gate on');
});

test('marketGreeksOf: inventory delta and gamma per market, in shares; an unknown greek counts 0', () => {
  const m = marketGreeksOf([
    { underlying: NVDA, units: -300n, delta: 0.4, gamma: 0.05 },
    { underlying: NVDA.toUpperCase().replace('0X', '0x'), units: 100n, delta: 0.2, gamma: null },
    { underlying: NVDA, units: 0n, delta: 1, gamma: 1 },
  ]).get(NVDA)!;
  assert.ok(Math.abs(m.delta.lo - -1.0) < 1e-12 && m.delta.lo === m.delta.hi);
  assert.ok(Math.abs(m.gamma.lo - -0.15) < 1e-12);
});

/*//////////////////////////////////////////////////////////////
   A FAILED READ NEVER LOOSENS A CAP OR A GATE
//////////////////////////////////////////////////////////////*/

test('P13: an expiry whose stored notional is unread has no room -- nothing grows in it; another expiry is untouched; with the cap off it does not matter', () => {
  const E1 = NOW + 86_400;
  const E2 = NOW + 2 * 86_400;
  const cap = 10n ** 12n; // far above what either series wants: only the unread flag can bind
  const unread = planSizes([s({ longId: 1n, expiry: E1 }), s({ longId: 2n, expiry: E2 })], limits({ maxExpiryNotional: cap, expiryNotional: new Map([[E1, 0n]]), expiryNotionalUnread: new Set([E1]) }));
  assert.deepEqual([unread[0]!.bid, unread[0]!.write, unread[0]!.capped], [0n, 0n, ['expiry-notional']], 'E1 is sized as if at its cap');
  assert.deepEqual([unread[1]!.bid, unread[1]!.write, unread[1]!.capped], [100n, 100n, []], 'E2 keeps its room');
  // Control: the same sizes with the sum read (0) are not capped.
  const read = planSizes([s({ longId: 1n, expiry: E1 })], limits({ maxExpiryNotional: cap, expiryNotional: new Map([[E1, 0n]]) }));
  assert.deepEqual([read[0]!.bid, read[0]!.write, read[0]!.capped], [100n, 100n, []]);
  const off = planSizes([s({ longId: 1n, expiry: E1 })], limits({ maxExpiryNotional: 0n, expiryNotional: new Map(), expiryNotionalUnread: new Set([E1]) }));
  assert.deepEqual([off[0]!.bid, off[0]!.write], [100n, 100n], '0n: no per-expiry cap, so an unknown sum changes nothing');
});

test('P14: a held position whose greek is unknown makes the market\'s net unknown -- gateGreeks opens no side there while the limit is on', () => {
  const m = marketGreeksOf([
    { underlying: NVDA, units: 100n, delta: 0.2, gamma: 0.01 },
    { underlying: NVDA, units: -300n, delta: null, gamma: null },
  ]).get(NVDA)!;
  assert.equal(m.deltaUnknown, true);
  assert.equal(m.gammaUnknown, true);
  const g = gateGreeks({ market: m, delta: 0.3, gamma: 0.01, bidUnits: 100n, askUnits: 100n, limits: LIM });
  assert.deepEqual([g.bid, g.ask], [false, false]);
  assert.match(g.reasons.join(), /market net delta unknown/);
  // Delta limit off: the gamma half still refuses on its own unknown.
  const gammaOnly = gateGreeks({ market: m, delta: 0.3, gamma: 0.01, bidUnits: 100n, askUnits: 100n, limits: { maxDeltaShares: 0, maxGamma: 2 } });
  assert.deepEqual([gammaOnly.bid, gammaOnly.ask], [false, false]);
  assert.match(gammaOnly.reasons.join(), /market net gamma unknown/);
  // Control: the same position priced, and both limits off, open both sides.
  const priced = marketGreeksOf([{ underlying: NVDA, units: 100n, delta: 0.2, gamma: 0.01 }, { underlying: NVDA, units: -300n, delta: 0.1, gamma: 0.01 }]).get(NVDA)!;
  assert.equal(priced.deltaUnknown, undefined);
  const ok = gateGreeks({ market: priced, delta: 0.3, gamma: 0.01, bidUnits: 100n, askUnits: 100n, limits: LIM });
  assert.deepEqual([ok.bid, ok.ask], [true, true]);
  const off = gateGreeks({ market: m, delta: 0.3, gamma: 0.01, bidUnits: 100n, askUnits: 100n, limits: { maxDeltaShares: 0, maxGamma: 0 } });
  assert.deepEqual([off.bid, off.ask], [true, true], 'both limits off: nothing to gate on');
  // A position with no units is not held: its unknown greek does not mark the market.
  assert.equal(marketGreeksOf([{ underlying: NVDA, units: 0n, delta: null, gamma: null }]).get(NVDA), undefined);
});
