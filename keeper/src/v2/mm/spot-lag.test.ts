/**
 * The spot-lag floor and bid cap (spot-lag.ts), pure: where the band comes from, what the floor and the cap are, and that
 * merging them into a quote can only raise an ask and only lower a bid.
 *
 * WHY THIS FILE EXISTS: the floor is priced at a spot nobody observed, so nothing downstream can tell a wrong band from a
 * right one; a floor that quietly stops binding reads exactly like a quiet market. Each number here is pinned twice:
 * against the formula (bs.ts at the stressed spot) and against a value computed outside this codebase (Python, math.erf;
 * a short check script), within one base unit for the two normal-CDF implementations.
 *
 * DELIBERATELY ABSENT: the planner (planner.test.ts runs the floor inside a tick).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { newYorkTimeToUnix } from '../../calendar.js';
import { DEFAULT_REGISTRY_PATH, KEEPER_PACKAGE_DIR, loadV2Config, type MmConfig } from '../config.js';
import { bsPrice, tradingYears } from '../pricing/bs.js';
import { SPOT_CORROBORATION_AGE_S } from './constants.js';
import { quotePrices, roundDownToTick, roundUpToTick, type FairInput, type QuoteFees, type QuoteParams, type SeriesInfo } from './engine.js';
import { spotLagOf, spotLagOn, vaultAskBaseOf, withSpotLag, type SpotLagParams } from './spot-lag.js';

const NVDA = '0x00000000000000000000000000000000000000aa';
/** Tuesday 22 September 2026: noon, four session hours before a 16:00 expiry. */
const NOON = newYorkTimeToUnix(2026, 9, 22, 12);
const EXPIRY = newYorkTimeToUnix(2026, 9, 22, 16);
/** The worked example: NVDA 229.03, the 232.50 call, 45 % vol; its plain fair value is 0.763151. */
const SPOT = 229_030_000n;
const STRIKE = 232_500_000n;
const LAUNCH_FEES: QuoteFees = { current: { premiumFeeBps: 500, resaleFeeBps: 0 }, pending: null };
const P: SpotLagParams = { spotLagBps: 50, spotLagStaleBps: 150 };
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

const series = (over: Partial<SeriesInfo> = {}): SeriesInfo => ({ longId: 1n, underlying: NVDA, isPut: false, strike: STRIKE, expiry: EXPIRY, ...over });
const fairOk = (over: Partial<Extract<FairInput, { ok: true }>> = {}): Extract<FairInput, { ok: true }> => ({ ok: true, fair: 763_151n, delta: 0.253, iv: 0.45, asOf: NOON - 900, source: 'cboe', spot: SPOT, ...over });
const lagAt = (over: Partial<Parameters<typeof spotLagOf>[0]> = {}) =>
  spotLagOf({ now: NOON, series: series(), fair: fairOk(), spot: SPOT, spotUpdatedAt: NOON - 60, fees: LAUNCH_FEES, params: P, ...over });
/** engine.grossUpToTick at 5 %. */
const grossAt5 = (net: bigint) => roundUpToTick((net * 10_000n + 9_499n) / 9_500n);
const near = (actual: bigint, expected: bigint, what: string) => assert.ok(actual - expected <= 1n && expected - actual <= 1n, `${what}: ${actual} vs ${expected} (±1)`);

test('the worked example: the call priced at the spot 0.5 % up, at the live vol; its floor grossed per slot', () => {
  const q = lagAt()!;
  const t = tradingYears(NOON, EXPIRY);
  assert.equal(q.spotRef, SPOT);
  assert.equal(q.bandBps, 50, 'a print one minute old: the feed threshold');
  assert.equal(q.spotQ, 230_175_150n, 'S × 1.005, rounded up');
  assert.equal(q.lagFair, BigInt(Math.ceil(bsPrice({ type: 'call', spot: 230.17515, strike: 232.5, vol: 0.45, t }) * 1e6)));
  near(q.lagFair, 1_095_905n, 'independent Python value');
  assert.ok(q.lagFair > (763_151n * 14n) / 10n, 'the 0.5 % band is worth over 40 % of this call');
  assert.deepEqual(q.floor, { write: grossAt5(roundUpToTick(q.lagFair)), resale: roundUpToTick(q.lagFair), bid: roundDownToTick(q.bidLagFair) });
  near(q.floor.write, 1_153_700n, 'independent Python value, grossed at 5 %');
});

test('the band: the feed threshold for 30 minutes after a print, the pool band after that and when the time is unknown', () => {
  assert.equal(lagAt({ spotUpdatedAt: NOON - SPOT_CORROBORATION_AGE_S })!.bandBps, 50, 'exactly 30 minutes is still the oracle\'s own fresh window');
  const stale = lagAt({ spotUpdatedAt: NOON - SPOT_CORROBORATION_AGE_S - 1 })!;
  assert.equal(stale.bandBps, 150);
  assert.equal(stale.spotQ, 232_465_450n);
  near(stale.lagFair, 2_045_193n, 'independent Python value');
  assert.equal(lagAt({ spotUpdatedAt: null })!.bandBps, 150, 'an unknown print time is priced as the older regime, never the fresh one');
});

test('past 30 minutes the band is the wider of MM_SPOT_LAG_STALE_BPS and the oracle\'s live maxDeviationBps', () => {
  const OLD = NOON - SPOT_CORROBORATION_AGE_S - 1;
  const t = tradingYears(NOON, EXPIRY);
  const env = lagAt({ spotUpdatedAt: OLD })!;
  // The owner widened the market to 300 bps (SettlementOracle.setMarket): the oracle now accepts an old print its pool
  // agrees with within 3 %, so the floor must price that 3 %, not the env's 1.5 %.
  const wide = lagAt({ spotUpdatedAt: OLD, oracleBandBps: 300 })!;
  assert.equal(wide.bandBps, 300);
  assert.equal(wide.spotQ, 235_900_900n, 'S × 1.03, rounded up');
  assert.equal(wide.lagFair, BigInt(Math.ceil(bsPrice({ type: 'call', spot: 235.9009, strike: 232.5, vol: 0.45, t }) * 1e6)));
  assert.ok(wide.floor.write > env.floor.write, `a wider live band raises the write floor: ${wide.floor.write} vs ${env.floor.write}`);
  assert.ok(wide.floor.bid < env.floor.bid, `and lowers the bid cap: ${wide.floor.bid} vs ${env.floor.bid}`);
  const put = lagAt({ series: series({ isPut: true, strike: 225_000_000n }), fair: fairOk({ delta: -0.2 }), spotUpdatedAt: OLD, oracleBandBps: 300 })!;
  assert.equal(put.spotQ, (SPOT * 9_700n) / 10_000n, 'a put: S × 0.97, rounded down');
  assert.equal(lagAt({ spotUpdatedAt: null, oracleBandBps: 300 })!.bandBps, 300, 'an unknown print time takes the live band too');
  assert.equal(lagAt({ spotUpdatedAt: OLD, oracleBandBps: 100 })!.bandBps, 150, 'a narrower live band never lowers the env floor');
  assert.equal(lagAt({ spotUpdatedAt: OLD, oracleBandBps: null })!.bandBps, 150, 'unread: the env alone');
  assert.equal(lagAt({ spotUpdatedAt: OLD })!.bandBps, 150, 'absent: the env alone');
  assert.equal(lagAt({ spotUpdatedAt: OLD, oracleBandBps: Number.NaN })!.bandBps, 150, 'a band that is not an integer is not priced');
  assert.equal(lagAt({ spotUpdatedAt: NOON - 60, oracleBandBps: 300 })!.bandBps, 50, 'a fresh print keeps the feed threshold: the live band is the OLD print\'s band');
});

test('the spot: the worse of the oracle and /fair for the seller; a put is stressed down', () => {
  assert.equal(lagAt({ fair: fairOk({ spot: SPOT + 1_000_000n }) })!.spotRef, SPOT + 1_000_000n, 'a higher /fair spot raises a call\'s floor');
  assert.equal(lagAt({ fair: fairOk({ spot: SPOT - 1_000_000n }) })!.spotRef, SPOT, 'a lower one never lowers it');
  const { spot: _drop, ...noSpot } = fairOk();
  assert.equal(lagAt({ fair: noSpot })!.spotRef, SPOT, '/fair without a spot: the oracle alone');
  const put = lagAt({ series: series({ isPut: true, strike: 225_000_000n }), fair: fairOk({ spot: SPOT - 1_000_000n, delta: -0.2 }) })!;
  assert.equal(put.spotRef, SPOT - 1_000_000n);
  assert.equal(put.spotQ, 226_889_850n, '(S − 1) × 0.995, rounded down');
  near(put.lagFair, 1_199_632n, 'independent Python value');
});

test('no floor for an input Black-Scholes cannot take: the caller does not quote the series', () => {
  assert.equal(lagAt({ fair: fairOk({ iv: Number.NaN }) }), null);
  assert.equal(lagAt({ fair: fairOk({ iv: -0.1 }) }), null);
  assert.equal(lagAt({ spot: 0n }), null);
  assert.equal(lagAt({ params: { spotLagBps: 10_000, spotLagStaleBps: 10_000 } }), null, 'a band of the whole spot is not a price');
  assert.equal(spotLagOn({ spotLagBps: 0, spotLagStaleBps: 0 }), false);
  assert.equal(spotLagOn({ spotLagBps: 0, spotLagStaleBps: 150 }), true);
});

test('withSpotLag: each ask the highest of the fair\'s quote, the lag fair\'s and its floor; the bid the lower of the fair\'s and the cap', () => {
  const lag = lagAt()!;
  const args = { now: NOON, series: series(), delta: 0.253, spot: SPOT, netDeltaShares: 0, askFloors: { write: 0n, resale: 0n }, bidCap: 22_903_000n, fees: LAUNCH_FEES, params: PARAMS };
  const plain = quotePrices({ ...args, fair: 763_151n });
  const lagged = quotePrices({ ...args, fair: lag.lagFair });
  const { prices, lag: out } = withSpotLag(plain, lagged, lag);
  assert.equal(prices.ask, lagged.ask, 'the lag fair\'s ask is the higher one here');
  assert.ok(prices.ask > plain.ask && prices.ask >= lag.floor.write);
  assert.equal(prices.resale, lagged.resale > lag.floor.resale ? lagged.resale : lag.floor.resale);
  // The band is worth far more than the 5 % half spread here, so the cap binds: the bid is the cap, not the fair's.
  assert.ok(plain.bid !== null && plain.bid > lag.floor.bid, `the setup: the fair's bid ${plain.bid} is over the cap ${lag.floor.bid}`);
  assert.equal(prices.bid, lag.floor.bid);
  assert.equal(out.raised, true);
  assert.equal(out.bidCapped, true);
  // A floor under the fair's quote and a cap over it change nothing and say so.
  const low = { ...lag, lagFair: 1n, floor: { write: 100n, resale: 100n, bid: 100_000_000n }, bidCapAhead: 100_000_000n, askAhead: { write: 100n, resale: 100n } };
  const same = withSpotLag(plain, quotePrices({ ...args, fair: 1n }), low);
  assert.deepEqual([same.prices.ask, same.prices.resale, same.prices.bid, same.lag.raised, same.lag.bidCapped], [plain.ask, plain.resale, plain.bid, false, false]);
});

test('withSpotLag: an inventory skew may lean the lag quote down, never under the floor; a refused fee read is carried', () => {
  const lag = lagAt()!;
  // Long 100 shares of delta: the skew leans every ask down by up to 10 % of fair, under the 5 % half spread.
  const args = { now: NOON, series: series(), delta: 0.253, spot: SPOT, netDeltaShares: 100, askFloors: { write: 0n, resale: 0n }, bidCap: 22_903_000n, fees: LAUNCH_FEES, params: PARAMS };
  const lagged = quotePrices({ ...args, fair: lag.lagFair });
  assert.ok(lagged.ask < lag.floor.write, 'the setup: the leaned lag ask is under the floor');
  const { prices } = withSpotLag(quotePrices({ ...args, fair: 763_151n }), lagged, lag);
  assert.equal(prices.ask, lag.floor.write);
  assert.equal(prices.resale, lag.floor.resale);
  const refused = { ...lagged, clampedBy: ['fee-out-of-range' as const] };
  assert.ok(withSpotLag(quotePrices({ ...args, fair: 763_151n }), refused, lag).prices.clampedBy.includes('fee-out-of-range'), 'the quoter withholds an ask whose fee read was refused');
});

/*//////////////////////////////////////////////////////////////
        THE BID CAP
//////////////////////////////////////////////////////////////*/

const PUT_STRIKE = 225_000_000n;
/** The 225 put's plain fair value at SPOT, same clock and vol (Python, math.erf). */
const PUT_FAIR = 608_589n;
const putSeries = () => series({ isPut: true, strike: PUT_STRIKE });

test('the bid cap: the call priced at the spot 0.5 % DOWN, the put 0.5 % UP, each rounded down to the tick', () => {
  const t = tradingYears(NOON, EXPIRY);
  const call = lagAt()!;
  assert.equal(call.bidSpotRef, SPOT);
  assert.equal(call.bidSpotQ, 227_884_850n, 'S × 0.995, rounded down');
  assert.equal(call.bidLagFair, BigInt(Math.floor(bsPrice({ type: 'call', spot: 227.88485, strike: 232.5, vol: 0.45, t }) * 1e6)));
  near(call.bidLagFair, 512_526n, 'independent Python value');
  assert.equal(call.floor.bid, roundDownToTick(call.bidLagFair), 'no fee term: a bid is not grossed');
  near(call.floor.bid, 512_500n, 'independent Python value, to the tick');
  assert.ok(call.bidLagFair < (763_151n * 7n) / 10n, 'the 0.5 % band takes over 30 % off this call');
  const put = lagAt({ series: putSeries(), fair: fairOk({ delta: -0.2 }) })!;
  assert.equal(put.bidSpotRef, SPOT);
  assert.equal(put.bidSpotQ, 230_175_150n, 'S × 1.005, rounded up');
  assert.equal(put.bidLagFair, BigInt(Math.floor(bsPrice({ type: 'put', spot: 230.17515, strike: 225, vol: 0.45, t }) * 1e6)));
  near(put.bidLagFair, 403_775n, 'independent Python value');
  assert.equal(put.floor.bid, roundDownToTick(put.bidLagFair));
});

test('the bid cap: the same band as the floor, 150 bps past 30 minutes; the worse spot for a buyer', () => {
  const stale = lagAt({ spotUpdatedAt: NOON - SPOT_CORROBORATION_AGE_S - 1 })!;
  assert.equal(stale.bidSpotQ, 225_594_550n, 'S × 0.985');
  near(stale.bidLagFair, 205_649n, 'independent Python value');
  assert.equal(lagAt({ spotUpdatedAt: null })!.bidSpotQ, 225_594_550n, 'an unknown print time is the older regime for the bid too');
  // A call bid is stressed from the LOWER of the two spots, a put bid from the HIGHER: never the seller's reference.
  const lowFair = lagAt({ fair: fairOk({ spot: SPOT - 1_000_000n }) })!;
  assert.deepEqual([lowFair.spotRef, lowFair.bidSpotRef], [SPOT, SPOT - 1_000_000n]);
  near(lowFair.bidLagFair, 351_569n, 'independent Python value');
  assert.equal(lagAt({ fair: fairOk({ spot: SPOT + 1_000_000n }) })!.bidSpotRef, SPOT, 'a higher /fair spot never raises a call\'s cap');
  const highPut = lagAt({ series: putSeries(), fair: fairOk({ spot: SPOT + 1_000_000n, delta: -0.2 }) })!;
  assert.deepEqual([highPut.spotRef, highPut.bidSpotRef], [SPOT, SPOT + 1_000_000n]);
  near(highPut.bidLagFair, 273_880n, 'independent Python value');
  // Both off: no stress, the cap is the fair value at the worse spot.
  const off = lagAt({ params: { spotLagBps: 0, spotLagStaleBps: 0 } })!;
  assert.equal(off.bidSpotQ, SPOT);
});

/**
 * THE SPOT CUSHION. The QUOTED bid (bidCapAhead) is priced at B_q moved against the buyer by one more sigma of
 * spot over the bid horizon, ⌈iv × √(trading years to bidAt)⌉ bps: lower for a call, higher for a put. floor.bid, the cap
 * no resting bid may exceed, does not move: the cap is not loosened, the bid is lowered. So a /fair downtick of up to one
 * sigma inside the horizon leaves the bid under the cap and does not force a protective replace.
 */
test('the bid ahead is priced one sigma of spot past B_q; the cap now does not move', () => {
  const at = NOON + 150; // the rendered env's two routine sends ahead (config.bidCapAheadOf: 2 x (60 + 15))
  const plain = lagAt()!;
  const call = lagAt({ bidAt: at })!;
  const cushion = Math.ceil(0.45 * Math.sqrt(tradingYears(NOON, at)) * 10_000);
  assert.equal(call.bidCushionBps, cushion);
  assert.ok(cushion >= 20 && cushion <= 30, `one sigma of spot over 150 session seconds at 45 % vol is about 23 bps (${cushion})`);
  assert.deepEqual(call.floor, plain.floor, 'the cap now (floor.bid) and both ask floors are unchanged');
  const valueAt = (type: 'call' | 'put', spot: bigint, strike: number) =>
    roundDownToTick(BigInt(Math.floor(bsPrice({ type, spot: Number(spot) / 1e6, strike, vol: 0.45, t: tradingYears(at, EXPIRY) }) * 1e6)));
  assert.equal(call.bidCapAhead, valueAt('call', (call.bidSpotQ * BigInt(10_000 - cushion)) / 10_000n, 232.5), 'B_q x (1 - cushion), rounded down');
  const put = lagAt({ series: putSeries(), fair: fairOk({ delta: -0.2 }), bidAt: at })!;
  assert.equal(put.bidCushionBps, cushion);
  assert.equal(put.bidCapAhead, valueAt('put', (put.bidSpotQ * BigInt(10_000 + cushion) + 9_999n) / 10_000n, 225), 'B_q x (1 + cushion), rounded up');
  assert.deepEqual(put.floor, lagAt({ series: putSeries(), fair: fairOk({ delta: -0.2 }) })!.floor);
  // No horizon, no cushion: the quoted bid is the cap now.
  assert.equal(plain.bidCushionBps, 0);
  assert.equal(plain.bidCapAhead, plain.floor.bid);
  // What it buys: /fair's spot falls just under one sigma by `at`. The cap then is under where an uncushioned bid would
  // sit (that bid would be replaced), and the cushioned bid is still at or under it.
  const moved = lagAt({ now: at, fair: fairOk({ spot: (SPOT * BigInt(10_000 - (cushion - 1))) / 10_000n }) })!;
  assert.ok(valueAt('call', call.bidSpotQ, 232.5) > moved.floor.bid, 'the control: the move alone puts an uncushioned bid over the cap');
  assert.ok(call.bidCapAhead <= moved.floor.bid, `the cushioned bid ${call.bidCapAhead} stays at or under the cap ${moved.floor.bid}`);
});

/**
 * THE ASK CUSHION, the spot cushion's mirror. Each ask is also priced at both floors where one more sigma of
 * spot over the same horizon can put them: the spot-lag floor at S_q moved up (a put: down), and the vault's own floor
 * (MakerVault._askFloor) at the print moved to the worse of max(print, /fair) up and min(print, /fair) down. The floors
 * themselves do not move: the ask is raised. So a /fair uptick of up to one sigma inside the horizon, or the print it
 * brings, leaves the ask at or over both floors and does not force a protective replace.
 */
test('the ask ahead is priced one sigma of spot past S_q, at now; the floors do not move', () => {
  const at = NOON + 150; // the rendered env's two routine sends ahead (config.bidCapAheadOf: 2 x (60 + 15))
  const plain = lagAt()!;
  const call = lagAt({ bidAt: at })!;
  const cushion = Math.ceil(0.45 * Math.sqrt(tradingYears(NOON, at)) * 10_000);
  assert.equal(call.askCushionBps, cushion, 'the same sigma over the same horizon as the bid');
  assert.equal(call.bidCushionBps, cushion);
  assert.deepEqual(call.floor, plain.floor, 'both ask floors and the cap now are unchanged');
  // Priced at NOW, not at `at`: the value only falls with T, so a floor is highest at the start of the horizon.
  const valueNow = (type: 'call' | 'put', spot: bigint, strike: number) =>
    BigInt(Math.ceil(bsPrice({ type, spot: Number(spot) / 1e6, strike, vol: 0.45, t: tradingYears(NOON, EXPIRY) }) * 1e6));
  assert.equal(call.lagFairAhead, valueNow('call', (call.spotQ * BigInt(10_000 + cushion) + 9_999n) / 10_000n, 232.5), 'S_q x (1 + cushion), rounded up');
  assert.ok(call.lagFairAhead > call.lagFair);
  assert.equal(call.askAhead.write, grossAt5(roundUpToTick(call.lagFairAhead)), 'grossed for the write fee (5 %)');
  assert.equal(call.askAhead.resale, roundUpToTick(call.lagFairAhead), 'the resale fee is 0 at launch');
  const put = lagAt({ series: putSeries(), fair: fairOk({ delta: -0.2 }), bidAt: at })!;
  assert.equal(put.askCushionBps, cushion);
  assert.equal(put.lagFairAhead, valueNow('put', (put.spotQ * BigInt(10_000 - cushion)) / 10_000n, 225), 'S_q x (1 - cushion), rounded down');
  assert.ok(put.lagFairAhead > put.lagFair);
  // No horizon, no cushion and no vault floor: the ask ahead is the floor.
  assert.deepEqual([plain.askCushionBps, plain.lagFairAhead], [0, plain.lagFair]);
  assert.deepEqual(plain.askAhead, { write: plain.floor.write, resale: plain.floor.resale });
  // What it buys: /fair's spot rises just under one sigma by `at`. The floor then is over an ask at today's floor (that
  // ask would be replaced), and the cushioned ask is still at or over it.
  const moved = lagAt({ now: at, fair: fairOk({ spot: (SPOT * BigInt(10_000 + (cushion - 1))) / 10_000n }) })!;
  assert.ok(moved.floor.write > plain.floor.write, 'the control: the move alone puts an ask at today\'s floor under the floor');
  assert.ok(call.askAhead.write >= moved.floor.write, `the cushioned ask ${call.askAhead.write} stays at or over the floor ${moved.floor.write}`);
  assert.ok(call.askAhead.resale >= moved.floor.resale);
});

test('the vault floor ahead: MakerVault._askFloor\'s base, its rise over [lo, hi] added to the floor the vault answered', () => {
  // The mirror, by hand: max(0, intrinsic - spot x tol / BPS) + ceil(spot x 50 / BPS).
  assert.equal(vaultAskBaseOf({ isPut: false, strike: STRIKE }, SPOT, 0), 1_145_150n, 'out of the money: 0.5 % of 229.03');
  assert.equal(vaultAskBaseOf({ isPut: false, strike: 220_000_000n }, SPOT, 0), 9_030_000n + 1_145_150n);
  assert.equal(vaultAskBaseOf({ isPut: false, strike: 220_000_000n }, SPOT, 100), 9_030_000n - 2_290_300n + 1_145_150n, 'the tolerance comes off the intrinsic part only');
  assert.equal(vaultAskBaseOf({ isPut: true, strike: 240_000_000n }, SPOT, 0), 10_970_000n + 1_145_150n);
  assert.equal(vaultAskBaseOf({ isPut: true, strike: 200_000_000n }, 229_030_001n, 0), 1_145_151n, 'the time-value term rounds up');
  const at = NOON + 150;
  const cushion = BigInt(Math.ceil(0.45 * Math.sqrt(tradingYears(NOON, at)) * 10_000));
  const gross = (base: bigint, feeBps: bigint) => roundUpToTick((base * 10_000n + 10_000n - feeBps - 1n) / (10_000n - feeBps));
  const cases: Array<{ name: string; s: SeriesInfo; fairSpot: bigint; delta: number; tol: number }> = [
    { name: 'a far out-of-the-money call, /fair over the print', s: series({ strike: 260_000_000n }), fairSpot: SPOT + 500_000n, delta: 0.01, tol: 0 },
    { name: 'an in-the-money call', s: series({ strike: 200_000_000n }), fairSpot: SPOT, delta: 0.95, tol: 0 },
    { name: 'an in-the-money call, 100 bps tolerance', s: series({ strike: 200_000_000n }), fairSpot: SPOT, delta: 0.95, tol: 100 },
    { name: 'an in-the-money put, /fair under the print', s: series({ isPut: true, strike: 260_000_000n }), fairSpot: SPOT - 500_000n, delta: -0.95, tol: 0 },
    { name: 'a far out-of-the-money put (its floor rises with spot)', s: series({ isPut: true, strike: 200_000_000n }), fairSpot: SPOT, delta: -0.01, tol: 0 },
  ];
  for (const { name, s, fairSpot, delta, tol } of cases) {
    const read = { write: gross(vaultAskBaseOf(s, SPOT, tol), 500n), resale: gross(vaultAskBaseOf(s, SPOT, tol), 0n) };
    const q = lagAt({ series: s, fair: fairOk({ spot: fairSpot, delta }), bidAt: at, vaultFloor: { askFloors: read, askToleranceBps: tol } })!;
    const high = fairSpot > SPOT ? fairSpot : SPOT;
    const low = fairSpot < SPOT ? fairSpot : SPOT;
    const hi = (high * (10_000n + cushion) + 9_999n) / 10_000n;
    const lo = (low * (10_000n - cushion)) / 10_000n;
    // Every print the move can bring, on a grid over [lo, hi] and both ends: the vault's floor there is at or under the ask.
    let crossed = false;
    for (let i = 0n; i <= 40n; i += 1n) {
      const spot = lo + ((hi - lo) * i) / 40n;
      const write = gross(vaultAskBaseOf(s, spot, tol), 500n);
      const resale = gross(vaultAskBaseOf(s, spot, tol), 0n);
      assert.ok(q.askAhead.write >= write, `${name}: the write ask ahead ${q.askAhead.write} under the vault floor ${write} at spot ${spot}`);
      assert.ok(q.askAhead.resale >= resale, `${name}: the resale ask ahead ${q.askAhead.resale} under the vault floor ${resale} at spot ${spot}`);
      if (write > read.write) crossed = true;
    }
    assert.ok(crossed, `${name}: the control: some print in the range puts an ask at the floor it answered under the floor`);
    assert.deepEqual(q.floor, lagAt({ series: s, fair: fairOk({ spot: fairSpot, delta }), bidAt: at })!.floor, `${name}: the vault floor does not move the spot-lag floors`);
  }
  // Where the vault's floor is what binds (the far call), the ask ahead is that floor at the worst end and no more than
  // the two gross-up roundings over it.
  const far = series({ strike: 260_000_000n });
  const read = { write: gross(vaultAskBaseOf(far, SPOT, 0), 500n), resale: gross(vaultAskBaseOf(far, SPOT, 0), 0n) };
  const q = lagAt({ series: far, fair: fairOk({ spot: SPOT, delta: 0.01 }), bidAt: at, vaultFloor: { askFloors: read, askToleranceBps: 0 } })!;
  const top = gross(vaultAskBaseOf(far, (SPOT * (10_000n + cushion) + 9_999n) / 10_000n, 0), 500n);
  assert.ok(q.askAhead.write > q.floor.write, 'the setup: the vault floor, not the spot-lag floor, binds this far out');
  assert.ok(q.askAhead.write >= top && q.askAhead.write <= top + 200n, `the far call's ask ahead ${q.askAhead.write} vs the vault floor at hi ${top}`);
  // No vault floor given: the spot-lag floor ahead alone.
  const alone = lagAt({ series: far, fair: fairOk({ spot: SPOT, delta: 0.01 }), bidAt: at })!;
  assert.equal(alone.askAhead.write, grossAt5(roundUpToTick(alone.lagFairAhead)));
});

test('withSpotLag: each ask is at least its ask ahead; the bid is untouched by it', () => {
  const at = NOON + 150;
  const far = series({ strike: 260_000_000n });
  const gross = (base: bigint, feeBps: bigint) => roundUpToTick((base * 10_000n + 10_000n - feeBps - 1n) / (10_000n - feeBps));
  const read = { write: gross(vaultAskBaseOf(far, SPOT, 0), 500n), resale: gross(vaultAskBaseOf(far, SPOT, 0), 0n) };
  const lag = lagAt({ series: far, fair: fairOk({ fair: 20_000n, delta: 0.01 }), bidAt: at, vaultFloor: { askFloors: read, askToleranceBps: 0 } })!;
  const args = { now: NOON, series: far, delta: 0.01, spot: SPOT, netDeltaShares: 0, askFloors: read, bidCap: 22_903_000n, fees: LAUNCH_FEES, params: PARAMS };
  const plain = quotePrices({ ...args, fair: 20_000n });
  const lagged = quotePrices({ ...args, fair: lag.lagFair });
  assert.equal(plain.ask, read.write, 'the setup: the plain write ask sits at the vault floor it read');
  const { prices, lag: out } = withSpotLag(plain, lagged, lag);
  assert.ok(lag.askAhead.write > read.write && lag.askAhead.resale > read.resale, 'the setup: the ask ahead is over both floors read');
  assert.equal(prices.ask, lag.askAhead.write);
  // The resale here is quotePrices' fallback to the write ask (its own target cannot clear the floor); still at least its ask ahead.
  assert.equal(prices.resale, plain.resale > lag.askAhead.resale ? plain.resale : lag.askAhead.resale);
  assert.ok(prices.resale >= lag.askAhead.resale);
  assert.equal(out.raised, true);
  const without = withSpotLag(plain, lagged, { ...lag, askAhead: { write: 0n, resale: 0n } });
  assert.equal(prices.bid, without.prices.bid, 'the ask cushion moves only the asks');
});

test('withSpotLag: a lagging print caps a call bid and a put bid; the asks are untouched by the cap', () => {
  const quoteOf = (s: SeriesInfo, fair: bigint, delta: number) => {
    const args = { now: NOON, series: s, delta, spot: SPOT, netDeltaShares: 0, askFloors: { write: 0n, resale: 0n }, bidCap: 22_903_000n, fees: LAUNCH_FEES, params: PARAMS };
    return { plain: quotePrices({ ...args, fair }), at: (f: bigint) => quotePrices({ ...args, fair: f }) };
  };
  const call = lagAt()!;
  const c = quoteOf(series(), 763_151n, 0.253);
  const cOut = withSpotLag(c.plain, c.at(call.lagFair), call);
  assert.equal(c.plain.bid, 724_900n, 'the setup: fair − 5 % to the tick, the pre-move bid');
  assert.equal(cOut.prices.bid, call.floor.bid);
  near(cOut.prices.bid!, 512_500n, 'the call bid falls to the cap');
  const put = lagAt({ series: putSeries(), fair: fairOk({ delta: -0.2 }) })!;
  const p = quoteOf(putSeries(), PUT_FAIR, -0.2);
  const pOut = withSpotLag(p.plain, p.at(put.lagFair), put);
  assert.equal(p.plain.bid, 578_100n, 'the setup: the put\'s pre-move bid');
  assert.equal(pOut.prices.bid, put.floor.bid);
  assert.equal(pOut.lag.bidCapped, true);
  // The cap moves only the bid: the asks are what the floor alone makes them.
  const uncapped = withSpotLag(p.plain, p.at(put.lagFair), { ...put, floor: { ...put.floor, bid: 100_000_000n }, bidCapAhead: 100_000_000n });
  assert.deepEqual([pOut.prices.ask, pOut.prices.resale], [uncapped.prices.ask, uncapped.prices.resale]);
  assert.ok(pOut.prices.bid! < pOut.prices.resale && pOut.prices.bid! < pOut.prices.ask, 'a lowered bid cannot cross');
});

test('withSpotLag: a cap under one tick pulls the bid; a series with no bid stays without one', () => {
  const lag = lagAt()!;
  const args = { now: NOON, series: series(), delta: 0.253, spot: SPOT, netDeltaShares: 0, askFloors: { write: 0n, resale: 0n }, bidCap: 22_903_000n, fees: LAUNCH_FEES, params: PARAMS };
  const plain = quotePrices({ ...args, fair: 763_151n });
  const lagged = quotePrices({ ...args, fair: lag.lagFair });
  const pulled = withSpotLag(plain, lagged, { ...lag, floor: { ...lag.floor, bid: 0n } });
  assert.deepEqual([pulled.prices.bid, pulled.lag.bidCapped], [null, true]);
  const none = withSpotLag({ ...plain, bid: null }, lagged, lag);
  assert.deepEqual([none.prices.bid, none.lag.bidCapped], [null, false]);
});

/*//////////////////////////////////////////////////////////////
    TWO CLOCKS, ONE PIN
//////////////////////////////////////////////////////////////*/

/** The env the MM bot ships with, as ops/v2-env.mjs renders it. */
const SHIPPED_ENV = join(KEEPER_PACKAGE_DIR, '..', 'ops', 'v2', 'env', 'mm-bot.env');

/** The shipped env's assignments through loadV2Config, its secrets and an out-of-image registry path standing in. */
function shippedTuning(over: Record<string, string> = {}): MmConfig['tuning'] {
  const env: Record<string, string> = {};
  for (const line of readFileSync(SHIPPED_ENV, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  assert.equal(env.V2_MODE, 'mm', 'the setup: this is the MM bot\'s file');
  const secrets = { MM_QUOTER_PK: `0x${'2b'.repeat(32)}`, MM_KILL_TOKEN: 'f0'.repeat(32), ALERT_WEBHOOK_TOKEN: 'e1'.repeat(32) };
  const config = loadV2Config({ ...env, ...secrets, V2_REGISTRY_PATH: join(KEEPER_PACKAGE_DIR, DEFAULT_REGISTRY_PATH), ...over });
  return (config as MmConfig).tuning;
}

test('in the shipped env MM_SPOT_LAG_BPS is at least MM_FAIR_SPOT_TOLERANCE_BPS, so the band covers every pool gap P7 accepts', () => {
  // P7 (engine.marketSafetyHalt) ages the FRESHEST CORROBORATED observation: a print older than MM_MAX_SPOT_AGE_S still
  // quotes when a pool reading within MM_FAIR_SPOT_TOLERANCE_BPS refreshes it (reads.readSpotClocks). The floor and the
  // cap age the PRINT and use MM_SPOT_LAG_BPS for its first 30 minutes. See spot-lag.ts, TWO CLOCKS FOR ONE QUESTION.
  const t = shippedTuning();
  assert.ok(t.spotLagBps >= t.fairSpotToleranceBps, `MM_SPOT_LAG_BPS ${t.spotLagBps} < MM_FAIR_SPOT_TOLERANCE_BPS ${t.fairSpotToleranceBps}: P7 accepts a gap the band does not price`);
  assert.ok(t.spotLagStaleBps >= t.spotLagBps, 'the stale band is never the narrower one');
  // The control: one bps past the band. The keeper itself refuses to boot on it (config.ts), so the
  // shipped env with the tolerance one bps wider is no longer a configuration at all, rather than one this check fails.
  assert.throws(
    () => shippedTuning({ MM_FAIR_SPOT_TOLERANCE_BPS: String(t.spotLagBps + 1) }),
    new RegExp(`MM_SPOT_LAG_BPS: ${t.spotLagBps} is below MM_FAIR_SPOT_TOLERANCE_BPS ${t.spotLagBps + 1}`),
  );
});
