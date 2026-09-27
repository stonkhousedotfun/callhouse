/**
 * realized.ts on a RECORDED series: fixtures/univ3-observe-series-2026-09-22.json is one
 * observe(secondsAgos) per launch-market pool at one pinned block of chain 4663, instants every 300 s over
 * the whole 2026-09-22 regular session. The expected vols below were computed outside this code (Python,
 * the same formula written from the realized.ts header), so a test pinned here is not pinned to itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SESSION_SECONDS, TRADING_YEAR_SECONDS } from './bs.js';
import { observeSchedule, realizedVolFromTwaps, twapSeries, type TwapPoint } from './realized.js';

interface Fixture {
  blockNumber: string;
  stepS: number;
  instants: number[];
  markets: Record<string, { token0: string; token1: string; tickCumulatives: string[] }>;
}

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/univ3-observe-series-2026-09-22.json', import.meta.url), 'utf8')) as Fixture;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

function series(ticker: string): TwapPoint[] {
  const m = FIXTURE.markets[ticker]!;
  return twapSeries(FIXTURE.instants, m.tickCumulatives.map(BigInt), m.token0.toLowerCase() === USDG);
}

test('the fixture is one full session: 79 instants 300 s apart, 09:30 to 16:00 New York on 2026-09-22', () => {
  assert.equal(FIXTURE.instants.length, 79);
  assert.equal(FIXTURE.instants[0], Date.UTC(2026, 8, 22, 13, 30) / 1000);
  assert.equal(FIXTURE.instants.at(-1), Date.UTC(2026, 8, 22, 20, 0) / 1000);
  assert.ok(FIXTURE.instants.every((t, i) => i === 0 || t - FIXTURE.instants[i - 1]! === FIXTURE.stepS));
});

test('twapSeries: the recorded window means price NVDA near 229 and SPCX near 155 USDG per token (the sign follows token order)', () => {
  const nvda = series('NVDA');
  const spcx = series('SPCX');
  assert.equal(nvda.length, 78);
  // meanLogPrice is ln(USDG base units per asset wei); ×1e12 is the 18- vs 6-decimal shift.
  const usd = (p: TwapPoint) => Math.exp(p.meanLogPrice) * 1e12;
  assert.ok(Math.abs(usd(nvda.at(-1)!) - 229.1169) < 1e-3, String(usd(nvda.at(-1)!)));
  assert.ok(Math.abs(usd(spcx.at(-1)!) - 154.5557) < 1e-3, String(usd(spcx.at(-1)!)));
  // Flipping the token order flips the sign of every mean, and so of every return: the vol is the same.
  const flipped = twapSeries(FIXTURE.instants, FIXTURE.markets.NVDA!.tickCumulatives.map(BigInt), false);
  assert.ok(Math.abs(flipped[3]!.meanLogPrice + nvda[3]!.meanLogPrice) < 1e-12);
  assert.throws(() => twapSeries([1, 1], [0n, 0n], true), /not strictly increasing/);
  assert.throws(() => twapSeries([1, 2, 3], [0n, 0n], true), /3 instants for 2 cumulatives/);
});

test('realizedVolFromTwaps: the recorded session gives NVDA 0.149830 and SPCX 0.331165 (trading-year vol), 77 returns each', () => {
  const nvda = realizedVolFromTwaps(series('NVDA'));
  const spcx = realizedVolFromTwaps(series('SPCX'));
  assert.ok(nvda.ok && spcx.ok);
  assert.ok(Math.abs(nvda.vol - 0.149829550053) < 1e-9, String(nvda.vol));
  assert.ok(Math.abs(spcx.vol - 0.331164892594) < 1e-9, String(spcx.vol));
  assert.deepEqual([nvda.returns, nvda.skipped, nvda.from, nvda.to], [77, 0, FIXTURE.instants[0], FIXTURE.instants.at(-1)]);
});

test('realizedVolFromTwaps: the 3/2 TWAP correction recovers a known vol from averaged windows (seeded Brownian path)', () => {
  // A log price with σ = 0.50 per trading year, stepped every second through ten weekday sessions (no
  // holiday among them), averaged in 300 s windows exactly as a pool TWAP averages it. Without the 3/2 the
  // estimate reads ~0.41 (√(2/3) × 0.50). The overnight pairs are skipped as closed time.
  // mulberry32: 32-bit integer arithmetic throughout (a float LCG loses bits past 2^53 and skews the draw).
  let seed = 12_345;
  const uniform = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4_294_967_296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const sigmaPerS = 0.5 / Math.sqrt(TRADING_YEAR_SECONDS);
  const days = [14, 15, 16, 17, 18, 21, 22, 23, 24, 25];
  const points: TwapPoint[] = [];
  let x = 0;
  for (const day of days) {
    const open = Date.UTC(2026, 8, day, 13, 30) / 1000;
    for (let w = 0; w < SESSION_SECONDS / 300; w += 1) {
      let sum = 0;
      for (let s = 0; s < 300; s += 1) {
        x += sigmaPerS * gauss();
        sum += x;
      }
      points.push({ from: open + w * 300, to: open + (w + 1) * 300, meanLogPrice: sum / 300 });
    }
  }
  const r = realizedVolFromTwaps(points);
  assert.ok(r.ok);
  assert.equal(r.returns, 10 * 77);
  assert.equal(r.skipped, 9, 'the nine overnight/weekend pairs');
  assert.ok(Math.abs(r.vol - 0.5) < 0.05, `recovered ${r.vol} for a true 0.50`);
  // The same windows without the correction would sit near √(2/3) × 0.50: the 3/2 is what closes the gap.
  assert.ok(Math.abs(r.vol * Math.sqrt(2 / 3) - 0.408) < 0.05);
});

test('realizedVolFromTwaps: closed time is never divided by session seconds; too little history is a refusal, not a zero', () => {
  const nvda = series('NVDA');
  // Move the second half to the same clock times the next day (a Wednesday session): the one pair that straddles
  // the overnight gap spans closed time and is skipped; every other pair is still in session.
  const gapped = [...nvda.slice(0, 39), ...nvda.slice(39).map((p) => ({ ...p, from: p.from + 86_400, to: p.to + 86_400 }))];
  const r = realizedVolFromTwaps(gapped);
  assert.ok(r.ok);
  assert.equal(r.skipped, 1);
  assert.equal(r.returns, 76);
  // The same session moved to a Saturday: every pair is out of session.
  const saturday = nvda.map((p) => ({ ...p, from: p.from + 4 * 86_400, to: p.to + 4 * 86_400 }));
  const closed = realizedVolFromTwaps(saturday);
  assert.equal(closed.ok, false);
  assert.match(!closed.ok ? closed.why : '', /0 in-session returns, fewer than 12/);
  const short = realizedVolFromTwaps(nvda.slice(0, 5));
  assert.equal(short.ok, false);
  assert.equal(!short.ok && short.returns, 4);
});

test('observeSchedule: aligned instants every step over the lookback, oldest first, with the secondsAgos that name them', () => {
  const now = Date.UTC(2026, 8, 22, 20, 2, 17) / 1000;
  const { instants, secondsAgos } = observeSchedule(now, 23_400, 300);
  assert.equal(instants.length, 79);
  assert.equal(instants.at(-1), Date.UTC(2026, 8, 22, 20, 0) / 1000);
  assert.equal(instants[0], Date.UTC(2026, 8, 22, 13, 30) / 1000);
  assert.deepEqual(secondsAgos.slice(-2), [437, 137]);
  assert.throws(() => observeSchedule(now, 300, 300), /at least two steps/);
});
