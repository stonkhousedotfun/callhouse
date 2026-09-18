/**
 * The vol surface on two synthetic chains: parity forwards, OTM-side points, and reading it at strikes
 * and expiries nobody lists.
 *
 * WHY THIS FILE EXISTS: the surface is where a daily that Cboe does not list gets its vol, and where
 * a wrong spot would silently tilt every call against every put. Put-call parity is the sanity
 * check that the synthetic paired quotes agree with themselves: the invented forward sits about
 * 40 bps under the invented chain spot, and the call and put at a strike solve to the same vol.
 *
 * Fixtures as in cboe.test.ts. DELIBERATELY ABSENT: the token and the network (fair.test.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CboeChain, type CboeOption } from '../../vol.js';
import { syntheticNvdaChain, syntheticTslaChain } from '../../fixtures/synthetic-chains.js';
import { SESSION_SECONDS, TRADING_YEAR_SECONDS, bsPrice, impliedVol, tradingYears } from './bs.js';
import { filterQuotes, mid } from './cboe.js';
import {
  IV_CEILING,
  IV_FLOOR,
  MAX_FORWARD_DIVERGENCE_BPS,
  buildSurface,
  parityForward,
  surfacePoints,
  volAt,
  volAtStrike,
  type Surface,
} from './surface.js';

const NVDA = syntheticNvdaChain();
const TSLA = syntheticTslaChain();
/** The chains' last trades: 15:59:59 New York on 14 and 16 Sep. */
const NVDA_AS_OF = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const TSLA_AS_OF = Date.UTC(2026, 8, 16, 19, 59, 59) / 1000;
/** 16:00 New York (EDT) on a September day. */
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;

const NVDA_SURFACE = buildSurface(NVDA, NVDA_AS_OF);
const TSLA_SURFACE = buildSurface(TSLA, TSLA_AS_OF);

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected} (±${tolerance})`);

function entry(surface: Surface, day: string) {
  const e = surface.expiries.find((x) => x.day === day);
  assert.ok(e, `${surface.root} keeps ${day}`);
  return e;
}

/*//////////////////////////////////////////////////////////////
                              BUILD
//////////////////////////////////////////////////////////////*/

test('buildSurface: the expiries kept, their trading-clock T, and the same-day expiry a closing file still lists dropped', () => {
  assert.deepEqual(NVDA_SURFACE.expiries.map((e) => e.day), ['2026-09-18', '2026-09-25']);
  // 16 Sep is listed in the TSLA file one second before its close: no market left in it.
  assert.ok(TSLA.options.some((o) => o.expiry === '2026-09-16'));
  assert.deepEqual(TSLA_SURFACE.expiries.map((e) => e.day), ['2026-09-18', '2026-09-21', '2026-09-23', '2026-09-25']);
  const sessions = (s: Surface) => s.expiries.map((e) => Math.round(e.t * TRADING_YEAR_SECONDS));
  assert.deepEqual(sessions(NVDA_SURFACE), [4 * SESSION_SECONDS + 1, 9 * SESSION_SECONDS + 1]);
  assert.deepEqual(sessions(TSLA_SURFACE), [2, 3, 5, 7].map((d) => d * SESSION_SECONDS + 1));
  assert.deepEqual(TSLA_SURFACE.expiries.map((e) => e.expiry), [closeOf(18), closeOf(21), closeOf(23), closeOf(25)]);
  for (const e of [...NVDA_SURFACE.expiries, ...TSLA_SURFACE.expiries]) {
    assert.equal(e.failure, null, e.day);
    assert.equal(e.forwardSource, 'parity');
  }
  assert.equal(entry(NVDA_SURFACE, '2026-09-18').points.length, 27);
  assert.equal(entry(TSLA_SURFACE, '2026-09-21').points.length, 37);
  // A horizon shorter than the second expiry keeps only the first.
  assert.deepEqual(buildSurface(NVDA, NVDA_AS_OF, { horizonDays: 5 }).expiries.map((e) => e.day), ['2026-09-18']);
});

test('put-call parity sanity: one forward per expiry, C - P = F - K near the money, call and put vols agree', () => {
  close(entry(NVDA_SURFACE, '2026-09-18').forward!, 211.4, 0.02, 'synthetic NVDA 18 Sep forward');
  close(entry(NVDA_SURFACE, '2026-09-25').forward!, 211.4, 0.02, 'synthetic NVDA 25 Sep forward');
  close(entry(TSLA_SURFACE, '2026-09-18').forward!, 358.9, 0.02, 'synthetic TSLA 18 Sep forward');
  for (const [surface, chain] of [[NVDA_SURFACE, NVDA], [TSLA_SURFACE, TSLA]] as const) {
    let pairs = 0;
    for (const e of surface.expiries) {
      const F = e.forward!;
      const bps = (F / chain.shareSpot - 1) * 10_000;
      assert.ok(bps < -35 && bps > -55, `${chain.root} ${e.day}: the forward is ${bps.toFixed(1)} bps under current_price (after hours)`);
      assert.ok(Math.abs(bps) < MAX_FORWARD_DIVERGENCE_BPS);
      const puts = new Map(e.puts.map((p) => [p.strike, p]));
      for (const c of e.calls) {
        const p = puts.get(c.strike);
        if (p === undefined || Math.abs(c.strike / F - 1) > 0.03) continue;
        pairs += 1;
        const halfSpreads = 0.5 * (c.ask - c.bid + (p.ask - p.bid));
        const residual = mid(c) - mid(p) - (F - c.strike);
        assert.ok(Math.abs(residual) <= halfSpreads + 1e-9, `${chain.root} ${e.day} ${c.strike}: parity residual ${residual.toFixed(3)} vs half-spreads ${halfSpreads.toFixed(3)}`);
        const callIv = impliedVol(mid(c), { type: 'call', spot: F, strike: c.strike, t: e.t })!;
        const putIv = impliedVol(mid(p), { type: 'put', spot: F, strike: c.strike, t: e.t })!;
        assert.ok(Math.abs(callIv - putIv) < 0.02, `${chain.root} ${e.day} ${c.strike}: call vol ${callIv.toFixed(4)} vs put vol ${putIv.toFixed(4)}`);
      }
    }
    assert.ok(pairs >= 10, `${chain.root}: ${pairs} near-the-money pairs checked`);
  }
  // Against chain spot instead, the same-strike put reads richer than its call.
  const e = entry(NVDA_SURFACE, '2026-09-18');
  const c210 = e.calls.find((c) => c.strike === 210)!;
  const p210 = e.puts.find((p) => p.strike === 210)!;
  const skew = impliedVol(mid(p210), { type: 'put', spot: NVDA.shareSpot, strike: 210, t: e.t })! - impliedVol(mid(c210), { type: 'call', spot: NVDA.shareSpot, strike: 210, t: e.t })!;
  assert.ok(skew > 0.05, `put vol over call vol at the wrong spot: ${skew.toFixed(4)}`);
});

test('parityForward: disagreeing pairs, a forward far from the spot, or no pairs', () => {
  const e = entry(NVDA_SURFACE, '2026-09-18');
  const shiftPuts = (by: Record<number, number>) => e.puts.map((p) => (by[p.strike] === undefined ? p : { ...p, bid: p.bid + by[p.strike]!, ask: p.ask + by[p.strike]! }));
  // The four nearest strikes to the invented spot are 212.5, 210, 215 and 207.5. One bad pair is outvoted.
  const outvoted = parityForward(e.calls, shiftPuts({ 212.5: 3 }), NVDA.shareSpot);
  assert.ok(outvoted.ok);
  close(outvoted.forward, 211.4, 0.02, 'the median of the three good estimates and the bad one');
  // Pairs that scatter: no estimate agrees with the median within its half-spreads.
  const bad = parityForward(e.calls, shiftPuts({ 210: 1.5, 212.5: -1.5, 215: 3 }), NVDA.shareSpot);
  assert.equal(!bad.ok && bad.reason, 'chain-inconsistent');
  assert.match(!bad.ok ? bad.detail.why ?? '' : '', /parity does not hold/);
  // Options from another day: the file's spot 8% away from what its quotes imply.
  const far = parityForward(e.calls, e.puts, NVDA.shareSpot * 1.08);
  assert.equal(!far.ok && far.reason, 'chain-inconsistent');
  assert.match(!far.ok ? far.detail.why ?? '' : '', /far from the chain spot/);
  // No strike quoted on both sides: the spot, flagged.
  const alone = parityForward(e.calls, [], NVDA.shareSpot);
  assert.deepEqual(alone, { ok: true, forward: NVDA.shareSpot, source: 'spot', estimates: [] });
});

test('surfacePoints: the OTM side where it quotes, the other side where it does not, vols floored and capped', () => {
  const e = entry(NVDA_SURFACE, '2026-09-18');
  const F = e.forward!;
  for (const p of e.points) {
    const otm = p.strike >= F ? 'C' : 'P';
    const otmQuoted = (otm === 'C' ? e.calls : e.puts).some((q) => q.strike === p.strike);
    if (otmQuoted) assert.equal(p.side, otm, `${p.strike}: OTM side`);
    assert.ok(p.iv >= IV_FLOOR && p.iv <= IV_CEILING);
    assert.ok(p.delta > 0 && p.delta < 1);
  }
  // The vols are the mids' own: each point reprices its quote at the forward.
  const p220 = e.points.find((p) => p.strike === 220)!;
  assert.equal(p220.side, 'C');
  close(bsPrice({ type: 'call', spot: F, strike: 220, vol: p220.iv, t: e.t }), p220.callMid!, 1e-9, 'the point reprices its synthetic mid');
  assert.ok(p220.callMid! > 0 && p220.putMid! > p220.callMid!);
  const p205 = e.points.find((p) => p.strike === 205)!;
  assert.equal(p205.side, 'P');
  close(bsPrice({ type: 'put', spot: F, strike: 205, vol: p205.iv, t: e.t }), p205.putMid!, 1e-9, 'synthetic put mid');

  // With the OTM put removed, 205 falls back to the ITM call's vol.
  const noPut = surfacePoints(e.calls, e.puts.filter((q) => q.strike !== 205), F, e.t).find((p) => p.strike === 205)!;
  assert.equal(noPut.side, 'C');
  assert.equal(noPut.putMid, null);

  // Floor and ceiling: a 10% OTM call an hour from expiry at 4.20 solves to ~800%; a 0.0001 mid
  // half a percent out with 30 sessions to go solves to 0.5%.
  const hour = 3_600 / TRADING_YEAR_SECONDS;
  const q = (strike: number, type: 'C' | 'P', bid: number, ask: number): CboeOption => ({ symbol: 'X', expiry: '2026-09-18', type, strike, bid, ask, iv: 1, delta: type === 'C' ? 0.5 : -0.5 });
  const wild = surfacePoints([q(110, 'C', 4.1, 4.3)], [], 100, hour);
  assert.equal(wild[0]!.iv, IV_CEILING);
  const locked = surfacePoints([q(100.5, 'C', 0.0001, 0.0001)], [], 100, 30 / 252);
  assert.equal(locked[0]!.iv, IV_FLOOR);
});

/*//////////////////////////////////////////////////////////////
                              READ
//////////////////////////////////////////////////////////////*/

test('volAtStrike: listed, interpolated between listed points, flat on both wings; gaps and broken windows refused', () => {
  const e = entry(NVDA_SURFACE, '2026-09-18');
  const at = (k: number) => {
    const v = volAtStrike(e, k);
    assert.ok(v.ok, `${k}: ${v.ok ? '' : JSON.stringify(v.detail)}`);
    return v;
  };
  const p = (k: number) => e.points.find((x) => x.strike === k)!.iv;
  assert.equal(at(220).iv, p(220));
  assert.equal(at(220).method, 'listed');
  const v221 = at(221);
  assert.equal(v221.method, 'interpolated');
  assert.deepEqual(v221.bracket, [220, 222.5]);
  close(v221.iv, p(220) + 0.4 * (p(222.5) - p(220)), 1e-12, 'linear in strike');
  const first = e.points[0]!;
  const last = e.points[e.points.length - 1]!;
  assert.deepEqual(at(first.strike - 20), { ok: true, iv: first.iv, method: 'wing', bracket: [first.strike, first.strike] });
  assert.equal(at(last.strike + 50).iv, last.iv);

  // A hole of three listings (217.5-225 gone) is 10 wide at 215: more than max(2.5, 5.375).
  const holed = buildSurface({ ...NVDA, options: NVDA.options.filter((o) => o.expiry !== '2026-09-18' || o.strike < 216 || o.strike > 226) }, NVDA_AS_OF);
  const gap = volAtStrike(entry(holed, '2026-09-18'), 221);
  assert.equal(!gap.ok && gap.reason, 'quotes-inconsistent');
  assert.match(!gap.ok ? gap.detail.why ?? '' : '', /too far apart/);
  // A corrupt call delta next to 222.5 breaks the window of the point the read leans on.
  const corrupt: CboeChain = { ...NVDA, options: NVDA.options.map((o) => (o.symbol === 'NVDA260918C00225000' ? { ...o, delta: 0.2 } : o)) };
  const bad = volAtStrike(entry(buildSurface(corrupt, NVDA_AS_OF), '2026-09-18'), 221);
  assert.equal(!bad.ok && bad.reason, 'quotes-inconsistent');
  assert.match(!bad.ok ? bad.detail.why ?? '' : '', /delta rises/);
  assert.equal(volAtStrike(entry(buildSurface(corrupt, NVDA_AS_OF), '2026-09-18'), 205).ok, true, 'far from the corruption it is not this read’s business');
});

test('volAt: a listed expiry, total variance between two, flat before the first and after the last, the horizon', () => {
  const s = NVDA_SURFACE;
  const e18 = entry(s, '2026-09-18');
  const e25 = entry(s, '2026-09-25');
  const listed = volAt(s, 231, closeOf(18));
  assert.ok(listed.ok);
  assert.equal(listed.method, 'listed-expiry');

  // 02-interfaces §5's example: NVDA 231 call, Monday 21 Sep, between the 18th and the 25th.
  const monday = volAt(s, 231, closeOf(21));
  assert.ok(monday.ok);
  assert.equal(monday.method, 'total-variance');
  assert.deepEqual(monday.days, ['2026-09-18', '2026-09-25']);
  const v18 = volAtStrike(e18, 231);
  const v25 = volAtStrike(e25, 231);
  assert.ok(v18.ok && v25.ok);
  const t = tradingYears(NVDA_AS_OF, closeOf(21));
  const w = v18.iv ** 2 * e18.t + ((t - e18.t) / (e25.t - e18.t)) * (v25.iv ** 2 * e25.t - v18.iv ** 2 * e18.t);
  close(monday.iv, Math.sqrt(w / t), 1e-12, 'σ²T linear in T');
  assert.ok(monday.iv > Math.min(v18.iv, v25.iv) - 1e-12 && monday.iv < Math.max(v18.iv, v25.iv) + 1e-12);
  // Linear in total variance at the listed ends is the listed vol itself.
  const almost18 = volAt({ ...s, expiries: [e18, e25] }, 231, closeOf(18) + 1);
  assert.ok(almost18.ok);
  close(almost18.iv, v18.iv, 1e-3, 'a second after the 18th close is the 18th');

  // Tuesday 15 Sep (a daily Cboe's NVDA file does not carry): the first expiry's vol, flat.
  const tuesday = volAt(s, 215, closeOf(15));
  assert.ok(tuesday.ok);
  assert.equal(tuesday.method, 'flat-before-first');
  assert.equal(tuesday.iv, (volAtStrike(e18, 215) as { iv: number }).iv);
  // Friday 2 Oct: the last one's, flat.
  const october = volAt(s, 215, Date.UTC(2026, 9, 2, 20) / 1000);
  assert.ok(october.ok);
  assert.equal(october.method, 'flat-after-last');
  assert.equal(october.iv, (volAtStrike(e25, 215) as { iv: number }).iv);
  // Past the horizon: no market to read.
  const far = volAt(s, 215, NVDA_AS_OF + 91 * 86_400);
  assert.equal(!far.ok && far.reason, 'no-quotes');
});

test('volAt: an expiry the read needs that failed fails the read; nothing listed is no-quotes', () => {
  const e25 = entry(NVDA_SURFACE, '2026-09-25');
  const failed25 = { ...e25, points: [], forward: null, forwardSource: null, failure: { ok: false as const, reason: 'chain-inconsistent' as const, detail: { why: 'put-call parity does not hold near the money' } } };
  const s = { ...NVDA_SURFACE, expiries: [entry(NVDA_SURFACE, '2026-09-18'), failed25] };
  const between = volAt(s, 231, closeOf(21));
  assert.equal(!between.ok && between.reason, 'chain-inconsistent', 'never quietly the 18th alone');
  assert.equal(volAt(s, 231, closeOf(17)).ok, true, 'a read that does not need the 25th is unaffected');
  const empty = volAt({ ...NVDA_SURFACE, expiries: [] }, 231, closeOf(18));
  assert.equal(!empty.ok && empty.reason, 'no-quotes');
  const junk = buildSurface({ ...NVDA, options: NVDA.options.map((o) => ({ ...o, bid: 0 })) }, NVDA_AS_OF);
  assert.deepEqual(junk.expiries.map((x) => x.failure?.reason), ['no-quotes', 'no-quotes']);
  const read = volAt(junk, 220, closeOf(18));
  assert.equal(!read.ok && read.reason, 'no-quotes');
  // filterQuotes is the gate in front of every point: an unusable quote never becomes one.
  assert.equal(filterQuotes(junk.expiries[0]!.calls, 'C').length, 0);
});
