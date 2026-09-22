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
import { exposureUnits, notionalOf, planSizes, type SizeLimits, type SizeSeries } from './risk.js';

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
   T-OP-133: ONE OVERSUBSCRIBED WRITE POOL (MM_WRITE_OVERSUBSCRIBE_BPS)
//////////////////////////////////////////////////////////////*/

// PROVE BY BREAKING (authored): size every ask against `collateralLeft` alone (drop the `single` bound) and the
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
