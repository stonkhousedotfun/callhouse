/**
 * fair(): the exact listed contract, the model, and a null with a reason for everything else.
 *
 * WHY THIS FILE EXISTS: this is the number the MM bot quotes around and the pricer reprices to. The
 * tests pin, on deterministic synthetic NVDA- and TSLA-shaped chains with an injected feed:
 *   - an exact listed contract prices from its own mid (source "cboe"), and at the forward on the
 *     chain's own clock that price IS the mid, to the base unit, for calls and for puts;
 *   - a strike or an expiry Cboe does not list prices from the surface (source "model"), including
 *     02-interfaces §5's own example and a daily expiring hours after the fixture;
 *   - a daily decays with the session clock and lands on intrinsic at the close without a blow-up;
 *   - every degraded input is a null with its reason, and a dead chain costs no RPC call;
 *   - the feed read and the chain download are each cached.
 *
 * Token spots are invented test rounds: NVDA 212.21, TSLA 360.20. No network or HTTP layer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { VolFetchError, type CboeChain } from '../../vol.js';
import { syntheticNvdaChain, syntheticTslaChain } from '../../fixtures/synthetic-chains.js';
import type { PricingReason } from './cboe.js';
import { PricingService, priceContract, type FairOutcome, type FairRequest } from './fair.js';
import type { PricingMarket } from './markets.js';
import { tokenSpotFromRound, type FeedRound } from './spot.js';
import { buildSurface } from './surface.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const NVDA = syntheticNvdaChain();
const TSLA = syntheticTslaChain();
const NVDA_AS_OF = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const TSLA_AS_OF = Date.UTC(2026, 8, 16, 19, 59, 59) / 1000;
/** The mornings after, 04:30 New York. */
const NVDA_NOW_MS = Date.UTC(2026, 8, 15, 8, 30);
const TSLA_NOW_MS = Date.UTC(2026, 8, 17, 8, 30);
/** 16:00 New York (EDT) on a September 2026 day. */
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;

const cboeUrl = (root: string) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${root}.json`;
const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const TSLA_FEED: Address = '0x4A1166a659A55625345e9515b32adECea5547C38';
const SGOV_FEED: Address = '0xa0DF4ee0fFf975306345875E3548Fcc519577A11';

const MARKETS: ReadonlyMap<string, PricingMarket> = new Map([
  ['NVDA', { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: cboeUrl('NVDA') } }],
  ['TSLA', { ticker: 'TSLA', feed: TSLA_FEED, cboe: { root: 'TSLA', url: cboeUrl('TSLA') } }],
  ['SGOV', { ticker: 'SGOV', feed: SGOV_FEED, cboe: null }],
]);

/** Feed rounds as the RPC would return them: 8 dp, updated at each session's close. */
const NVDA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_249n, answer: 21_221_000_000n, updatedAt: 1_789_416_000n, decimals: 8 };
const TSLA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_900n, answer: 36_020_000_000n, updatedAt: 1_789_588_800n, decimals: 8 };

interface Harness {
  service: PricingService;
  spotReads: Address[];
  downloads: string[];
  setNow(ms: number): void;
}

function harness(options: {
  nowMs: number;
  chains?: Partial<Record<string, CboeChain | Error>>;
  rounds?: Partial<Record<Address, FeedRound | Error>>;
}): Harness {
  let now = options.nowMs;
  const spotReads: Address[] = [];
  const downloads: string[] = [];
  const chains: Record<string, CboeChain | Error> = { [cboeUrl('NVDA')]: NVDA, [cboeUrl('TSLA')]: TSLA, ...options.chains } as Record<string, CboeChain | Error>;
  const rounds: Record<string, FeedRound | Error> = { [NVDA_FEED]: NVDA_ROUND, [TSLA_FEED]: TSLA_ROUND, ...options.rounds } as Record<string, FeedRound | Error>;
  const service = new PricingService({
    markets: MARKETS,
    nowMs: () => now,
    spotReader: async (feed) => {
      spotReads.push(feed);
      const r = rounds[feed];
      if (r === undefined || r instanceof Error) throw r ?? new Error('no such feed');
      return r;
    },
    chains: {
      fetchChain: async (url) => {
        downloads.push(url);
        const c = chains[url];
        if (c === undefined || c instanceof Error) throw c ?? new VolFetchError('http-status', 'HTTP 404');
        return c;
      },
    },
  });
  return { service, spotReads, downloads, setNow: (ms) => (now = ms) };
}

const request = (ticker: string, strike: number, expiry: number, type: 'call' | 'put'): FairRequest => ({
  ticker,
  strikeUsdg6: BigInt(Math.round(strike * 1e6)),
  expiry,
  type,
});

function priced(outcome: FairOutcome) {
  assert.ok(outcome.ok, `expected a price, got ${outcome.ok ? '' : `${outcome.reason} ${JSON.stringify(outcome.detail)}`}`);
  return outcome;
}

function refused(outcome: FairOutcome, reason: PricingReason) {
  assert.equal(outcome.ok, false, `expected ${reason}, got a price`);
  assert.equal(!outcome.ok && outcome.reason, reason, !outcome.ok ? JSON.stringify(outcome.detail) : '');
  return outcome as Extract<FairOutcome, { ok: false }>;
}

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected} (±${tolerance})`);

/*//////////////////////////////////////////////////////////////
                            SOURCE: CBOE
//////////////////////////////////////////////////////////////*/

test('cboe: the exact listed NVDA contract prices from its own mid at the token spot, calls and puts', async () => {
  const { service } = harness({ nowMs: NVDA_NOW_MS });
  const call = priced(await service.fair(request('NVDA', 220, closeOf(18), 'call')));
  assert.equal(call.source, 'cboe');
  assert.equal(call.method, 'listed-contract');
  assert.deepEqual(call.days, ['2026-09-18']);
  assert.ok(call.fairUsdg6 > 0n);
  assert.ok(call.iv > 0 && Number.isFinite(call.iv));
  assert.ok(call.delta > 0 && call.delta < 1);
  assert.equal(call.spotUsdg6, 212_210_000n);
  assert.equal(call.asOf, NVDA_AS_OF);

  const put = priced(await service.fair(request('NVDA', 205, closeOf(18), 'put')));
  assert.equal(put.source, 'cboe');
  assert.ok(put.fairUsdg6 > 0n && put.delta < 0 && put.delta > -1);
  // The token sits above the synthetic quote forward: call rises, put falls versus its own mid.
  const quoteMid = (chain: CboeChain, symbol: string) => {
    const q = chain.options.find((o) => o.symbol === symbol)!;
    return BigInt(Math.round(((q.bid + q.ask) / 2) * 1_000_000));
  };
  assert.ok(call.fairUsdg6 > quoteMid(NVDA, 'NVDA260918C00220000'));
  assert.ok(put.fairUsdg6 < quoteMid(NVDA, 'NVDA260918P00205000'));

  // TSLA: a Monday daily call and a Wednesday daily put, both listed.
  const t = harness({ nowMs: TSLA_NOW_MS }).service;
  const daily = priced(await t.fair(request('TSLA', 360, closeOf(21), 'call')));
  assert.equal(daily.source, 'cboe');
  assert.ok(daily.fairUsdg6 > 0n);
  const wed = priced(await t.fair(request('TSLA', 350, closeOf(23), 'put')));
  assert.equal(wed.source, 'cboe');
  assert.ok(wed.fairUsdg6 > 0n);
  assert.ok(wed.delta < 0 && wed.delta > -1);
});

test('cboe: at the expiry forward on the chain clock the price IS the mid, to the base unit; a bare mid × ratio is not the answer', () => {
  const nvda = buildSurface(NVDA, NVDA_AS_OF);
  const tsla = buildSurface(TSLA, TSLA_AS_OF);
  const at = (surface: typeof nvda, strike: number, day: number, type: 'call' | 'put') => {
    const e = surface.expiries.find((x) => x.expiry === closeOf(day))!;
    const p = priceContract({ surface, request: request('X', strike, closeOf(day), type), tokenSpot: e.forward!, nowSeconds: surface.asOf });
    assert.ok(p.ok);
    assert.equal(p.source, 'cboe');
    return p.fairUsdg6;
  };
  for (const [chain, surface, root, strike, day, type] of [
    [NVDA, nvda, 'NVDA', 220, 18, 'call'], [NVDA, nvda, 'NVDA', 205, 18, 'put'],
    [NVDA, nvda, 'NVDA', 225, 25, 'call'], [TSLA, tsla, 'TSLA', 360, 21, 'call'],
    [TSLA, tsla, 'TSLA', 340, 23, 'put'],
  ] as const) {
    const symbol = `${root}2609${day}${type === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`;
    const quote = chain.options.find((o) => o.symbol === symbol)!;
    assert.equal(at(surface, strike, day, type), BigInt(Math.round(((quote.bid + quote.ask) / 2) * 1e6)), symbol);
  }

  // Homogeneity: the token at m × the forward prices at m × the share option AT K/m.
  const e = nvda.expiries[0]!;
  const m = 212.21 / e.forward!;
  const onToken = priceContract({ surface: nvda, request: request('NVDA', 220, closeOf(18), 'call'), tokenSpot: 212.21, nowSeconds: nvda.asOf });
  assert.ok(onToken.ok);
  const quoted = e.calls.find((q) => q.strike === 220)!;
  const bare = ((quoted.bid + quoted.ask) / 2) * m;
  assert.ok(Number(onToken.fairUsdg6) / 1e6 > bare + 0.05, `${onToken.fairUsdg6} is not ${bare.toFixed(6)}`);
});

/*//////////////////////////////////////////////////////////////
                            SOURCE: MODEL
//////////////////////////////////////////////////////////////*/

test('model: an unlisted strike, an unlisted expiry (the §5 example), a put, and a daily Cboe never listed', async () => {
  const { service } = harness({ nowMs: NVDA_NOW_MS });
  const strike = priced(await service.fair(request('NVDA', 221, closeOf(18), 'call')));
  assert.equal(strike.source, 'model');
  assert.equal(strike.method, 'listed-expiry');
  assert.ok(strike.fairUsdg6 > 0n);
  const monday = priced(await service.fair({ ticker: 'NVDA', strikeUsdg6: 231_000_000n, expiry: 1_790_020_800, type: 'call' }));
  assert.equal(monday.source, 'model');
  assert.equal(monday.method, 'total-variance');
  assert.deepEqual(monday.days, ['2026-09-18', '2026-09-25']);
  assert.ok(monday.fairUsdg6 > 0n && monday.iv > 0);
  const put = priced(await service.fair(request('NVDA', 200, closeOf(21), 'put')));
  assert.equal(put.source, 'model');
  assert.ok(put.fairUsdg6 > 0n);
  // Between the listed strikes the model sits between the listed contracts.
  const c220 = priced(await service.fair(request('NVDA', 220, closeOf(18), 'call'))).fairUsdg6;
  const c222 = priced(await service.fair(request('NVDA', 222.5, closeOf(18), 'call'))).fairUsdg6;
  assert.ok(strike.fairUsdg6 < c220 && strike.fairUsdg6 > c222);
  // A strike with more decimals than any listing is never "exact".
  assert.equal(priced(await service.fair({ ...request('NVDA', 220, closeOf(18), 'call'), strikeUsdg6: 220_000_100n })).source, 'model');

  // TSLA Tuesday 22 Sep: no listing, between the Monday and Wednesday dailies.
  const tuesday = priced(await harness({ nowMs: TSLA_NOW_MS }).service.fair(request('TSLA', 361, closeOf(22), 'call')));
  assert.equal(tuesday.method, 'total-variance');
  assert.deepEqual(tuesday.days, ['2026-09-21', '2026-09-23']);
  assert.ok(tuesday.fairUsdg6 > 0n);
});

test('an exact contract whose own quotes fail a gate falls back to the model; the model refuses where its own read fails', async () => {
  // A corrupt put delta next to the ITM 215 put: its window fails, but the surface reads 215 from
  // the OTM call, which is clean.
  const putBroken: CboeChain = { ...NVDA, options: NVDA.options.map((o) => (o.symbol === 'NVDA260918P00217500' ? { ...o, delta: -0.5 } : o)) };
  const a = harness({ nowMs: NVDA_NOW_MS, chains: { [cboeUrl('NVDA')]: putBroken } }).service;
  const fallback = priced(await a.fair(request('NVDA', 215, closeOf(18), 'put')));
  assert.equal(fallback.source, 'model');
  assert.equal(fallback.method, 'listed-expiry');
  // A corrupt call delta next to the 220 call: the exact contract and the surface both lean on it.
  const callBroken: CboeChain = { ...NVDA, options: NVDA.options.map((o) => (o.symbol === 'NVDA260918C00222500' ? { ...o, delta: 0.3 } : o)) };
  const b = harness({ nowMs: NVDA_NOW_MS, chains: { [cboeUrl('NVDA')]: callBroken } }).service;
  const r = refused(await b.fair(request('NVDA', 220, closeOf(18), 'call')), 'quotes-inconsistent');
  assert.match(r.detail.why ?? '', /delta rises/);
  assert.equal(r.detail.day, '2026-09-18');
});

/*//////////////////////////////////////////////////////////////
                              DAILIES
//////////////////////////////////////////////////////////////*/

test('dailies: hours, a minute and a second before the close; the premium decays with the session clock', async () => {
  // The TSLA quotes, re-dated to Thursday's close so Friday's session reads them as fresh.
  const thursday: CboeChain = { ...TSLA, lastTradeTime: '2026-09-17T15:59:59', timestamp: '2026-09-17 20:05:00' };
  const at = async (utcHour: number, minute: number, second: number, strike: number) => {
    const { service } = harness({ nowMs: Date.UTC(2026, 8, 18, utcHour, minute, second), chains: { [cboeUrl('TSLA')]: thursday } });
    return priced(await service.fair(request('TSLA', strike, closeOf(18), 'call')));
  };
  // Friday 10:00, 15:30, 15:59 and 15:59:59 New York.
  const atm = [await at(14, 0, 0, 360), await at(19, 30, 0, 360), await at(19, 59, 0, 360), await at(19, 59, 59, 360)];
  assert.ok(atm.every((p, i) => i === 0 || p.fairUsdg6 < atm[i - 1]!.fairUsdg6), 'time decay to intrinsic');
  assert.ok(atm.every((p) => p.source === 'cboe' && p.iv === atm[0]!.iv), 'one vol, only the clock moves');
  // A second before the close the 360 call on a 360.20 token is its 0.20 of intrinsic, plus dust.
  assert.ok(atm[3]!.fairUsdg6 >= 200_000n && atm[3]!.fairUsdg6 < 202_000n);
  assert.ok(atm[3]!.delta > 0.95, 'deep in the money with a second left');
  const otm = [await at(14, 0, 0, 365), await at(19, 30, 0, 365), await at(19, 59, 0, 365), await at(19, 59, 59, 365)];
  assert.ok(otm.every((p, i) => i === 0 || p.fairUsdg6 <= otm[i - 1]!.fairUsdg6));
  assert.equal(otm[3]!.fairUsdg6, 0n);
  assert.ok(otm.every((p) => Number.isFinite(p.delta) && p.delta >= 0 && p.delta < 0.4));

  // NVDA's own chain: a 16:00 daily on Tuesday 15 Sep, priced at 15:00 with an hour to go.
  const hour = priced(await harness({ nowMs: Date.UTC(2026, 8, 15, 19, 0) }).service.fair(request('NVDA', 215, closeOf(15), 'call')));
  assert.equal(hour.method, 'flat-before-first');
  assert.ok(hour.fairUsdg6 > 0n);
  // At the close it is expired, not a division by zero.
  refused(await harness({ nowMs: closeOf(15) * 1000 }).service.fair(request('NVDA', 215, closeOf(15), 'call')), 'expired');
});

/*//////////////////////////////////////////////////////////////
                          DEGRADED INPUTS
//////////////////////////////////////////////////////////////*/

test('degraded chains: null with a reason, and no RPC read for a chain that already failed', async () => {
  const req = request('NVDA', 220, closeOf(18), 'call');

  const unknown = harness({ nowMs: NVDA_NOW_MS });
  refused(await unknown.service.fair({ ...req, ticker: 'AAPL' }), 'unknown-ticker');
  refused(await unknown.service.fair({ ...req, expiry: Math.floor(NVDA_NOW_MS / 1000) }), 'expired');
  refused(await unknown.service.fair({ ...req, expiry: 1 }), 'expired');
  assert.equal(unknown.downloads.length + unknown.spotReads.length, 0, 'refused before any I/O');

  const down = harness({ nowMs: NVDA_NOW_MS, chains: { [cboeUrl('NVDA')]: new VolFetchError('http-status', 'HTTP 503') } });
  const r = refused(await down.service.fair(req), 'chain-unavailable');
  assert.equal(r.detail.error, 'http-status: HTTP 503');
  assert.equal(down.spotReads.length, 0);

  const noChain = harness({ nowMs: NVDA_NOW_MS });
  refused(await noChain.service.fair({ ...req, ticker: 'SGOV' }), 'chain-unavailable');
  assert.equal(noChain.downloads.length, 0);

  // Saturday 19 Sep: Monday's file is four sessions behind.
  const stale = harness({ nowMs: Date.UTC(2026, 8, 19, 16) });
  refused(await stale.service.fair({ ...req, expiry: closeOf(25) }), 'chain-stale');
  assert.equal(stale.spotReads.length, 0);

  const wrongRoot = harness({ nowMs: NVDA_NOW_MS, chains: { [cboeUrl('TSLA')]: NVDA } });
  refused(await wrongRoot.service.fair({ ...req, ticker: 'TSLA' }), 'chain-inconsistent');

  const noBids = harness({ nowMs: NVDA_NOW_MS, chains: { [cboeUrl('NVDA')]: { ...NVDA, options: NVDA.options.map((o) => ({ ...o, bid: 0 })) } } });
  refused(await noBids.service.fair(req), 'no-quotes');

  const holed: CboeChain = { ...NVDA, options: NVDA.options.filter((o) => o.expiry !== '2026-09-18' || o.strike < 216 || o.strike > 226) };
  refused(await harness({ nowMs: NVDA_NOW_MS, chains: { [cboeUrl('NVDA')]: holed } }).service.fair(request('NVDA', 221, closeOf(18), 'call')), 'quotes-inconsistent');

  // Parity broken on the 18th: every read that needs the 18th says so, the 25th still prices.
  const scattered: CboeChain = {
    ...NVDA,
    options: NVDA.options.map((o) => {
      const by: Record<string, number> = { NVDA260918P00210000: 1.5, NVDA260918P00212500: -1.5, NVDA260918P00215000: 3 };
      return by[o.symbol] === undefined ? o : { ...o, bid: o.bid + by[o.symbol]!, ask: o.ask + by[o.symbol]! };
    }),
  };
  const parity = harness({ nowMs: NVDA_NOW_MS, chains: { [cboeUrl('NVDA')]: scattered } }).service;
  refused(await parity.fair(request('NVDA', 231, closeOf(21), 'call')), 'chain-inconsistent');
  assert.equal(priced(await parity.fair(request('NVDA', 225, closeOf(25), 'call'))).source, 'cboe');

  // Beyond the surface's 90-day horizon.
  refused(await harness({ nowMs: NVDA_NOW_MS }).service.fair({ ...req, expiry: NVDA_AS_OF + 100 * 86_400 }), 'no-quotes');
});

test('degraded spots: an RPC failure, a dead or nonsensical feed, and a token that disagrees with Cboe', async () => {
  const req = request('NVDA', 220, closeOf(18), 'call');
  const rpc = refused(await harness({ nowMs: NVDA_NOW_MS, rounds: { [NVDA_FEED]: new Error('HTTP request failed.\n\nURL: https://rpc…') } }).service.fair(req), 'spot-unavailable');
  assert.equal(rpc.detail.error, 'HTTP request failed.', 'first line only: RPC URLs carry keys');
  refused(await harness({ nowMs: NVDA_NOW_MS, rounds: { [NVDA_FEED]: { ...NVDA_ROUND, answer: 0n } } }).service.fair(req), 'spot-unavailable');
  refused(await harness({ nowMs: NVDA_NOW_MS, rounds: { [NVDA_FEED]: { ...NVDA_ROUND, roundId: 0n } } }).service.fair(req), 'spot-unavailable');
  const stale = refused(await harness({ nowMs: NVDA_NOW_MS, rounds: { [NVDA_FEED]: { ...NVDA_ROUND, updatedAt: 1_789_000_000n } } }).service.fair(req), 'spot-stale');
  assert.equal(stale.detail.feed, NVDA_FEED);
  const far = refused(await harness({ nowMs: NVDA_NOW_MS, rounds: { [NVDA_FEED]: { ...NVDA_ROUND, answer: 23_000_000_000n } } }).service.fair(req), 'spot-divergence');
  assert.equal(far.detail.maxDivergenceBps, '300');
  // 3% is the edge, inclusive (vol.ts mapSpot).
  priced(await harness({ nowMs: NVDA_NOW_MS, rounds: { [NVDA_FEED]: { ...NVDA_ROUND, answer: 21_840_161_200n } } }).service.fair(req));
});

test('tokenSpotFromRound: Policy.normalizeSpot integers, and the refusals', () => {
  const now = 1_789_450_000;
  const spot = tokenSpotFromRound(NVDA_ROUND, 345_600, now);
  assert.ok(!('ok' in spot));
  assert.equal(spot.spotUsdg6, 212_210_000n);
  assert.equal(spot.ageSeconds, now - 1_789_416_000);
  // Truncating, like the contracts: 8 dp 212.21999999 is 212.219999 USDG.
  assert.equal((tokenSpotFromRound({ ...NVDA_ROUND, answer: 21_221_999_999n }, 345_600, now) as { spotUsdg6: bigint }).spotUsdg6, 212_219_999n);
  assert.equal((tokenSpotFromRound({ ...NVDA_ROUND, answer: 212_210_000_000_000_000_000n, decimals: 18 }, 345_600, now) as { spotUsdg6: bigint }).spotUsdg6, 212_210_000n);
  assert.equal((tokenSpotFromRound({ ...NVDA_ROUND, answer: 2_122_100n, decimals: 4 }, 345_600, now) as { spotUsdg6: bigint }).spotUsdg6, 212_210_000n);
  assert.equal((tokenSpotFromRound({ ...NVDA_ROUND, updatedAt: BigInt(now + 60) }, 345_600, now) as { ageSeconds: number }).ageSeconds, 0, 'a feed a minute ahead of the clock');
  const reason = (r: ReturnType<typeof tokenSpotFromRound>) => ('ok' in r ? r.reason : 'ok');
  assert.equal(reason(tokenSpotFromRound({ ...NVDA_ROUND, answer: -1n }, 345_600, now)), 'spot-unavailable');
  assert.equal(reason(tokenSpotFromRound({ ...NVDA_ROUND, answer: 99n, decimals: 12 }, 345_600, now)), 'spot-unavailable', 'under a base unit');
  assert.equal(reason(tokenSpotFromRound({ ...NVDA_ROUND, decimals: 78 }, 345_600, now)), 'spot-unavailable');
  assert.equal(reason(tokenSpotFromRound(NVDA_ROUND, 345_600, 1_789_416_000 + 345_600)), 'ok', 'the limit is inclusive');
  assert.equal(reason(tokenSpotFromRound(NVDA_ROUND, 345_600, 1_789_416_000 + 345_601)), 'spot-stale');
});

/*//////////////////////////////////////////////////////////////
                              CACHING
//////////////////////////////////////////////////////////////*/

test('caching: one feed read per ticker per 10 s and one chain download per five minutes, shared by concurrent callers', async () => {
  const h = harness({ nowMs: NVDA_NOW_MS });
  const reqs = [220, 221, 222.5, 225].map((k) => request('NVDA', k, closeOf(18), 'call'));
  const outcomes = await Promise.all(reqs.map((r) => h.service.fair(r)));
  assert.ok(outcomes.every((o) => o.ok));
  assert.equal(h.downloads.length, 1);
  assert.equal(h.spotReads.length, 1);
  h.setNow(NVDA_NOW_MS + 9_999);
  await h.service.fair(reqs[0]!);
  assert.equal(h.spotReads.length, 1);
  h.setNow(NVDA_NOW_MS + 10_000);
  await h.service.fair(reqs[0]!);
  assert.equal(h.spotReads.length, 2, 'the feed is read again after the TTL');
  assert.equal(h.downloads.length, 1, 'the chain is not');
  h.setNow(NVDA_NOW_MS + 300_000);
  await h.service.fair(reqs[0]!);
  assert.equal(h.downloads.length, 2);
  // A failed feed read is reused inside the TTL too: a dead RPC is not hammered per request.
  const dead = harness({ nowMs: NVDA_NOW_MS, rounds: { [NVDA_FEED]: new Error('down') } });
  await dead.service.fair(reqs[0]!);
  await dead.service.fair(reqs[1]!);
  assert.equal(dead.spotReads.length, 1);
});
