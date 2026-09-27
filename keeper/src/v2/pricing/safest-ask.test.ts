/**
 * The safest-ask inputs: gamma and vega, askIv = max(iv, realized, floor)
 * marked up and never below iv, the pool's realized vol through the service, and the event calendar file,
 * its flag on /fair and its refusals. The service is the fair-spot.test.ts arrangement: the synthetic NVDA
 * chain from a fake real-time provider, an injected Chainlink round and an injected v3 pool. No network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Address } from 'viem';
import { syntheticNvdaChain } from '../../fixtures/synthetic-chains.js';
import { bsDelta, bsGamma, bsPrice, bsVega, type BsInput } from './bs.js';
import { cboeToNormalized } from './cboe.js';
import { FAKE_LISTED_PROVIDER, createFakeProvider, fakeListedChain } from './fake-provider.js';
import { DEFAULT_ASK_IV_SETTINGS, PricingService, askIvFor, type AskIvSettings, type FairOutcome, type FairQuote, type FairRequest, type PricingSettings } from './fair.js';
import { loadEventCalendarFile, parseEventCalendarFile } from './events.js';
import { loadPricingEnv } from './main.js';
import type { PricingMarket } from './markets.js';
import { quoteAtTick, type PoolObservation, type PoolReader } from './pool-spot.js';
import { createPricingApp, fairResponse } from './server.js';
import { eventCalendar, eventsInWindow, type EventCalendar } from './short-maturity.js';
import type { FeedRound } from './spot.js';
import { IV_CEILING } from './surface.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const NOW_MS = Date.UTC(2026, 8, 15, 8, 30);
const NOW = NOW_MS / 1000;
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;
const ASSET: Address = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const POOL: Address = '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ROUND: FeedRound = { roundId: 18_446_744_073_709_552_249n, answer: 21_221_000_000n, updatedAt: 1_789_416_000n, decimals: 8 };
const NVDA_CHAIN = cboeToNormalized(syntheticNvdaChain(), NOW_MS);
const listed = fakeListedChain(NVDA_CHAIN, { quoteObservedAt: NOW - 5 });
const REAL_TIME = { ...listed, rows: listed.rows.map((r) => ({ ...r, quote: r.quote === null ? null : { ...r.quote, observedAt: NOW - 5 } })) };
const MARKET: PricingMarket = {
  ticker: 'NVDA',
  feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15',
  cboe: { root: 'NVDA', url: 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json' },
  token: { chainId: 4663, address: ASSET, uiMultiplier: null },
  pool: { address: POOL, minLiquidity: 10n ** 18n, usdg: USDG },
};

/** A pool whose TWAP sits at Chainlink's 212.21 and whose observe(secondsAgos) series is `series(secondsAgos)`. */
function pool(series?: (secondsAgos: readonly number[]) => bigint[]): PoolReader & { seriesCalls: number[][] } {
  const tick = Math.round(Math.log(1e12 / 212.21) / Math.log(1.0001));
  const seriesCalls: number[][] = [];
  return {
    seriesCalls,
    meta: async () => ({ token0: USDG, token1: ASSET, assetDecimals: 18 }),
    observe: async (_p, windowS): Promise<PoolObservation> => ({ tickCumulatives: [0n, BigInt(tick) * BigInt(windowS)], secondsPerLiquidityCumulativeX128s: [0n, (BigInt(windowS) << 128n) / 10n ** 20n] }),
    ...(series === undefined
      ? {}
      : {
          observeSeries: async (_p: Address, secondsAgos: readonly number[]) => {
            seriesCalls.push([...secondsAgos]);
            return series(secondsAgos);
          },
        }),
  };
}

function service(options: { poolReader?: PoolReader; settings?: Partial<PricingSettings>; events?: EventCalendar; nowMs?: number } = {}): PricingService {
  return new PricingService({
    markets: new Map([['NVDA', MARKET]]),
    nowMs: () => options.nowMs ?? NOW_MS,
    spotReader: async () => ROUND,
    chains: { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: REAL_TIME }) },
    poolReader: options.poolReader ?? pool(),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.events === undefined ? {} : { events: options.events }),
  });
}

const request = (strike: number, type: 'call' | 'put', day = 18): FairRequest => ({ ticker: 'NVDA', strikeUsdg6: BigInt(strike) * 1_000_000n, expiry: closeOf(day), type });

function priced(outcome: FairOutcome): FairQuote {
  assert.ok(outcome.ok, outcome.ok ? '' : `${outcome.reason} ${JSON.stringify(outcome.detail)}`);
  return outcome;
}

/*//////////////////////////////////////////////////////////////
                          GAMMA AND VEGA
//////////////////////////////////////////////////////////////*/

test('bsGamma and bsVega match central differences of bsDelta and bsPrice, calls and puts alike; 0 at expiry', () => {
  for (const type of ['call', 'put'] as const) {
    for (const [spot, strike, vol, t] of [[212.21, 220, 0.43, 3 / 252], [212.21, 205, 0.6, 1 / 252], [100, 100, 0.2, 0.5], [50, 80, 1.2, 0.1]] as const) {
      const input: BsInput = { type, spot, strike, vol, t };
      const hS = spot * 1e-4;
      const gammaFd = (bsDelta({ ...input, spot: spot + hS }) - bsDelta({ ...input, spot: spot - hS })) / (2 * hS);
      const vegaFd = (bsPrice({ ...input, vol: vol + 1e-5 }) - bsPrice({ ...input, vol: vol - 1e-5 })) / 2e-5;
      const what = `${type} S=${spot} K=${strike} σ=${vol} t=${t}`;
      assert.ok(Math.abs(bsGamma(input) - gammaFd) <= 1e-6 * Math.max(1, gammaFd), `${what}: gamma ${bsGamma(input)} vs ${gammaFd}`);
      assert.ok(Math.abs(bsVega(input) - vegaFd) <= 1e-5 * Math.max(1, vegaFd), `${what}: vega ${bsVega(input)} vs ${vegaFd}`);
      assert.ok(bsGamma(input) > 0 && bsVega(input) > 0, what);
    }
    assert.equal(bsGamma({ type, spot: 212, strike: 220, vol: 0.4, t: 0 }), 0);
    assert.equal(bsVega({ type, spot: 212, strike: 220, vol: 0.4, t: 0 }), 0);
  }
});

/*//////////////////////////////////////////////////////////////
                               ASK IV
//////////////////////////////////////////////////////////////*/

test('askIvFor: max(iv, realized, floor) × (1 + markup); the per-ticker floor wins over the global one', () => {
  const s: AskIvSettings = { markupBps: 1_000, floor: 0.3, floors: { NVDA: 0.55 } };
  assert.ok(Math.abs(askIvFor({ iv: 0.43, realizedVol: null, ticker: 'TSLA', settings: s }) - 0.473) < 1e-12, 'iv wins');
  assert.ok(Math.abs(askIvFor({ iv: 0.43, realizedVol: 0.5, ticker: 'TSLA', settings: s }) - 0.55) < 1e-12, 'realized wins');
  assert.ok(Math.abs(askIvFor({ iv: 0.43, realizedVol: 0.5, ticker: 'NVDA', settings: s }) - 0.605) < 1e-12, 'the NVDA floor wins');
  assert.equal(askIvFor({ iv: 0.43, realizedVol: null, ticker: 'NVDA', settings: DEFAULT_ASK_IV_SETTINGS }), 0.43 * 1.1);
});

test('askIvFor: NEVER below the live iv, over a grid that includes a negative markup, NaN and Infinity inputs and a floor over the ceiling', () => {
  const ivs = [0.01, 0.2, 0.43, 1, 4.99, IV_CEILING];
  const realized = [null, 0, 0.1, 0.43, 2, 10, Number.NaN, Number.POSITIVE_INFINITY, -1];
  const floors = [0, 0.05, 0.5, 6, Number.NaN, -3];
  const markups = [-50_000, -1, 0, 1, 1_000, 10_000, Number.NaN];
  let checked = 0;
  for (const iv of ivs) {
    for (const realizedVol of realized) {
      for (const floor of floors) {
        for (const markupBps of markups) {
          const a = askIvFor({ iv, realizedVol, ticker: 'NVDA', settings: { markupBps, floor, floors: {} } });
          assert.ok(Number.isFinite(a), `finite: iv ${iv} rv ${realizedVol} floor ${floor} markup ${markupBps} -> ${a}`);
          assert.ok(a >= iv, `askIv ${a} below iv ${iv} (rv ${realizedVol}, floor ${floor}, markup ${markupBps})`);
          assert.ok(a <= Math.max(iv, IV_CEILING), `askIv ${a} above the ceiling`);
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, ivs.length * realized.length * floors.length * markups.length);
});

test('/fair through the service: askIv from the pool\'s realized vol, with gamma and vega at iv; the point price and iv are unchanged', async () => {
  // A pool series whose 300 s TWAP moves ±1 tick-step of 2% every window: a realized vol far above the chain's iv.
  const jumpy = (secondsAgos: readonly number[]) => {
    let c = 0n;
    const out: bigint[] = [];
    secondsAgos.forEach((_, i) => {
      out.push(c);
      c += BigInt((i % 2 === 0 ? 1 : -1) * 198 + 222_700) * 300n;
    });
    return out;
  };
  // 14:00 New York on a session day, so the lookback's returns are in session.
  const sessionNowMs = Date.UTC(2026, 8, 15, 18, 0);
  const withRealized = service({ poolReader: pool(jumpy), nowMs: sessionNowMs });
  const without = service({ poolReader: pool(), nowMs: sessionNowMs });
  const a = priced(await withRealized.fair(request(220, 'call')));
  const b = priced(await without.fair(request(220, 'call')));
  assert.deepEqual([a.fairUsdg6, a.iv, a.delta], [b.fairUsdg6, b.iv, b.delta], 'askIv never moves the point');
  assert.equal(b.realizedVol, null);
  assert.match(b.realizedWhy ?? '', /no pool series reader/);
  assert.ok(a.realizedVol !== null && a.realizedVol > a.iv, `realized ${a.realizedVol} vs iv ${a.iv}`);
  assert.ok(Math.abs(a.askIv - Math.min(a.realizedVol * 1.1, IV_CEILING)) < 1e-12, `askIv ${a.askIv}`);
  assert.ok(Math.abs(b.askIv - b.iv * 1.1) < 1e-12);
  assert.ok(a.gamma > 0 && a.vega > 0);
  const body = fairResponse(a).body;
  assert.equal(body.askIv, Math.round(a.askIv * 1e6) / 1e6);
  assert.equal(body.realizedVol, Math.round(a.realizedVol * 1e6) / 1e6);
  // One observe per ticker per ttl: a second request in the same instant reads no new series.
  const reader = pool(jumpy);
  const svc = service({ poolReader: reader, nowMs: sessionNowMs });
  await svc.fair(request(220, 'call'));
  await svc.fair(request(225, 'call'));
  assert.equal(reader.seriesCalls.length, 1);
  assert.equal(reader.seriesCalls[0]!.length, 79);
  const health = (await (await createPricingApp(svc).request('/health')).json()) as { realized: Record<string, { vol: number | null; returns: number }>; eventCalendar: string[] };
  assert.equal(health.realized.NVDA!.returns > 0, true);
  assert.deepEqual(health.eventCalendar, []);
});

test('/fair through the service: a failed series read is a reason, never a refusal of the price', async () => {
  const broken = pool(() => {
    throw new Error('execution reverted: OLD');
  });
  const q = priced(await service({ poolReader: broken }).fair(request(220, 'call')));
  assert.equal(q.realizedVol, null);
  assert.match(q.realizedWhy ?? '', /the pool series read failed: execution reverted: OLD/);
  assert.ok(Math.abs(q.askIv - q.iv * 1.1) < 1e-12);
});

/*//////////////////////////////////////////////////////////////
                          EVENT CALENDAR
//////////////////////////////////////////////////////////////*/

const KNOWN = new Set(['NVDA', 'SPCX']);

test('events file: rows load into the calendar; a ticker with no row and no through has NO input; through alone is supplied', () => {
  const cal = parseEventCalendarFile(
    {
      _readme: 'ignored',
      through: { SPCX: '2026-12-31' },
      events: [{ ticker: 'NVDA', date: '2026-09-17', kind: 'earnings', timing: 'amc', source: 'https://example.com/nvda-ir' }],
    },
    KNOWN,
  );
  assert.deepEqual(cal.get('NVDA'), { events: [{ date: '2026-09-17', kind: 'earnings', timing: 'amc' }], through: null });
  assert.deepEqual(cal.get('SPCX'), { events: [], through: '2026-12-31' });
  assert.equal(parseEventCalendarFile({ through: {}, events: [] }, KNOWN).size, 0, 'an empty file is no input, not "no events"');
});

test('events file: every malformed row is refused, all of them named, and nothing half-loads', () => {
  const bad = {
    through: { TSLA: '2026-12-31', NVDA: '2026-02-30' },
    events: [
      { ticker: 'TSLA', date: '2026-10-01', kind: 'earnings', source: 'https://x.test/a' },
      { ticker: 'NVDA', date: '2026-10-01', kind: 'earnings' },
      { ticker: 'NVDA', date: '2026-13-01', kind: 'earnings', source: 'https://x.test/b' },
      { ticker: 'NVDA', date: '2026-10-02', kind: 'Earnings Call', source: 'https://x.test/c' },
      { ticker: 'NVDA', date: '2026-10-03', kind: 'earnings', timing: 'noon', source: 'https://x.test/d' },
      { ticker: 'NVDA', date: '2026-10-04', kind: 'earnings', source: 'http://x.test/e' },
      { ticker: 'NVDA', date: '2026-10-05', kind: 'earnings', source: 'https://x.test/f', when: 'x' },
      'nope',
    ],
  };
  let message = '';
  try {
    parseEventCalendarFile(bad, KNOWN);
  } catch (error) {
    message = (error as Error).message;
  }
  for (const expected of [
    /events\[0\]: ticker TSLA is not a registry market/,
    /events\[1\]: source must be the https URL the date came from/,
    /date 2026-13-01 is not a YYYY-MM-DD day/,
    /kind Earnings Call is not a short lower-case label/,
    /timing noon is not bmo, amc or null/,
    /events\[5\]: source must be the https URL/,
    /events\[6\]: unknown key\(s\) when/,
    /events\[7\]: not an object/,
    /through\.TSLA: not a registry market/,
    /through is not a YYYY-MM-DD day: 2026-02-30/,
  ]) {
    assert.match(message, expected);
  }
  assert.throws(() => parseEventCalendarFile([], KNOWN), /not a JSON object/);
  assert.throws(() => parseEventCalendarFile({ events: {} }, KNOWN), /events: not a list/);
});

test('loadEventCalendarFile: an absent default is no calendar; an absent configured path refuses; a file that is not JSON refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  assert.deepEqual(loadEventCalendarFile(join(dir, 'none.json'), KNOWN, false), { calendar: new Map(), loaded: false });
  assert.throws(() => loadEventCalendarFile(join(dir, 'none.json'), KNOWN, true), /PRICING_EVENTS_PATH .*no such file/);
  writeFileSync(join(dir, 'bad.json'), '{ nope');
  assert.throws(() => loadEventCalendarFile(join(dir, 'bad.json'), KNOWN, false), /not JSON/);
});

test('the committed ops/markets/events.json parses against the registry and is empty on purpose (no date could be cited)', () => {
  const path = new URL('../../../../ops/markets/events.json', import.meta.url);
  const registry = JSON.parse(readFileSync(new URL('../../../../ops/markets/tier1.json', import.meta.url), 'utf8')) as { markets: Array<{ ticker: string }> };
  const { calendar, loaded } = loadEventCalendarFile(path.pathname, new Set(registry.markets.map((m) => m.ticker)), true);
  assert.equal(loaded, true);
  assert.equal(calendar.size, 0);
});

test('eventsInWindow: missing, short and supplied input; an event whose jump may land in (now, expiry] is in the window', () => {
  const expiry = closeOf(18);
  assert.deepEqual(eventsInWindow(null, NOW, expiry), { input: 'missing', inWindow: false, events: [] });
  const cal = eventCalendar({
    NVDA: { events: [{ date: '2026-09-16', kind: 'earnings', timing: 'amc' }, { date: '2026-09-21', kind: 'cpi', timing: 'bmo' }], through: '2026-09-30' },
    SPCX: { events: [{ date: '2026-09-18', kind: 'earnings', timing: 'amc' }], through: '2026-09-17' },
  });
  const nvda = eventsInWindow(cal.get('NVDA')!, NOW, expiry);
  assert.equal(nvda.input, 'supplied');
  assert.equal(nvda.inWindow, true);
  assert.deepEqual(nvda.events.map((e) => e.date), ['2026-09-16']);
  // SPCX: an amc event on the expiry day lands after the 16:00 expiry, and the list stops before the expiry day.
  const spcx = eventsInWindow(cal.get('SPCX')!, NOW, expiry);
  assert.deepEqual([spcx.input, spcx.inWindow], ['short', false]);
});

test('/fair: the event flag reaches the body top-level (never as provenance), with quality alongside', async () => {
  const events = eventCalendar({ NVDA: { events: [{ date: '2026-09-16', kind: 'earnings', timing: 'amc' }], through: '2026-12-31' } });
  const res = await createPricingApp(service({ events })).request(`/fair?ticker=NVDA&strike=220000000&expiry=${closeOf(18)}&type=call`);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(res.status, 200);
  assert.deepEqual(body.event, { input: 'supplied', inWindow: true });
  assert.equal(typeof body.quality.readiness, 'string');
  assert.ok(Array.isArray(body.quality.reasons));
  assert.equal('provenance' in body, false);
});

/*//////////////////////////////////////////////////////////////
                            ENVIRONMENT
//////////////////////////////////////////////////////////////*/

test('loadPricingEnv: the safest-ask knobs default, parse and refuse', () => {
  // Massive is the default provider and needs a key (a synthetic one here).
  const base = { RH_RPC: 'https://rpc.example.com', MASSIVE_API_KEY: 'SYNTHETIC0000000000000000000000000' };
  const d = loadPricingEnv(base);
  assert.deepEqual(d.ask, { markupBps: 1_000, floor: 0, floors: {}, realizedLookbackS: 23_400, realizedStepS: 300 });
  assert.equal(d.events.explicit, false);
  assert.match(d.events.path, /ops\/markets\/events\.json$/);
  const set = loadPricingEnv({ ...base, PRICING_ASK_IV_MARKUP_BPS: '1500', PRICING_ASK_IV_FLOOR: '0.25', PRICING_ASK_IV_FLOORS: '{"NVDA":0.4}', PRICING_EVENTS_PATH: '/tmp/e.json' });
  assert.deepEqual([set.ask.markupBps, set.ask.floor, set.ask.floors, set.events], [1_500, 0.25, { NVDA: 0.4 }, { path: '/tmp/e.json', explicit: true }]);
  assert.throws(() => loadPricingEnv({ ...base, PRICING_ASK_IV_MARKUP_BPS: '-1' }), /PRICING_ASK_IV_MARKUP_BPS/);
  assert.throws(() => loadPricingEnv({ ...base, PRICING_ASK_IV_FLOORS: '{"NVDA":-1}' }), /PRICING_ASK_IV_FLOORS: NVDA: a registry ticker mapped to a vol/);
  assert.throws(() => loadPricingEnv({ ...base, PRICING_ASK_IV_FLOORS: 'x' }), /PRICING_ASK_IV_FLOORS: not JSON/);
  assert.throws(() => loadPricingEnv({ ...base, PRICING_REALIZED_LOOKBACK_S: '600', PRICING_REALIZED_STEP_S: '600' }), /must cover at least two steps/);
});
