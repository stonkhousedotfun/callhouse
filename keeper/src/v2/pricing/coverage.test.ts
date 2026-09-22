/**
 * The pricing-coverage report (coverage.ts) and its command (coverage-main.ts), on committed synthetic chains
 * (fixtures/synthetic-chains.ts) through the Cboe adapter and the fake providers. No network, no credential, no
 * provider contact: the Cboe download, the feed reads and the calendar are all injected.
 *
 * What these pin (K3-303 acceptance):
 *   ladder        the rungs are the cranker's own: upcomingLadderExpiries → ladderSlots → planLadder;
 *   methods       exact listed, interpolated (between listed expiries and between listed strikes) and extrapolated;
 *   zero / null   a price of zero is fair "0" and below the floor; a refusal is fair null and floor-unknown;
 *   clocks        an unknown quote clock is degraded; a stale or timeless chain is unavailable; nulls stay null;
 *   tenors        a weekly pass never hides a daily failure, in the summary, the readiness verdict and the exit code;
 *   calendar      a holiday and an early close (Thanksgiving week 2026), a weekly moved to Thursday (4 July week);
 *   events        a (synthetic) earnings date flags `event-uncertainty` on the series and inputs that span it;
 *   suggestions   derived only: never expiriesAhead, never zero rungs, never a daily turned off;
 *   watch         one JSON line per market per refresh, clocks and ages with nulls kept, refusal state.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Address } from 'viem';
import { NYSE_EARLY_CLOSES_2026_2028, NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { syntheticNvdaChain, syntheticNvdaDailiesChain, syntheticNvdaThanksgivingChain, syntheticTslaChain } from '../../fixtures/synthetic-chains.js';
import type { CboeChain } from '../../vol.js';
import { ladderSlots, planLadder, upcomingLadderExpiries } from '../cranker/planner.js';
import { INTERFACE_VERSION, parseV2Registry } from '../registry.js';
import { cboeToNormalized, createCboeProvider } from './cboe.js';
import type { NormalizedChain, OptionChainProvider } from './chain.js';
import {
  PROPOSED_HOUSE_FLOOR_USDG6,
  localNextExpiry,
  parseEventCalendar,
  quoteReadiness,
  runCoverage,
  strikeTickFlag,
  suggestLadders,
  summarize,
  f1Inputs,
  toServiceEventCalendar,
  type CoverageReport,
  type EventCalendar,
  type RungRecord,
  type WatchLine,
} from './coverage.js';
import { runCoverageCli } from './coverage-main.js';
import { FAKE_LISTED_PROVIDER, createFakeProvider, fakeListedChain } from './fake-provider.js';
import { PricingService } from './fair.js';
import { parsePricingRegistry } from './markets.js';
import type { FeedRound, SpotReader } from './spot.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const TSLA_FEED: Address = '0x4A1166a659A55625345e9515b32adECea5547C38';
const NVDA_TOKEN = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const TSLA_TOKEN = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
const cboeUrl = (root: string) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${root}.json`;

const NVDA_AS_OF = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const NVDA_NOW_MS = Date.UTC(2026, 8, 15, 8, 30);
const TSLA_NOW_MS = Date.UTC(2026, 8, 17, 8, 30);
/** 16:00 New York on a September 2026 day (EDT). */
const sepClose = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;

const NVDA_CBOE = syntheticNvdaChain();
const TSLA_CBOE = syntheticTslaChain();
const NVDA = cboeToNormalized(NVDA_CBOE, 0);
const listedTwin = (base: NormalizedChain, asOf: number) => fakeListedChain(base, { quoteObservedAt: asOf, underlyingObservedAt: asOf, publishedAt: base.clocks.publishedAt });

type V2Patch = Record<string, unknown>;

/**
 * A two-market registry in the tier1.json shape; `patch` merges into a market's `v2` block.
 *
 * The version is the loader's own so this suite moves with it rather than pinning a number the keeper no
 * longer implements. There is deliberately no `v2.fees` block: the coverage report reads the ladder, the
 * strike tick and the ExpiryCalendar address, never a fee, and parseV2Registry's INTERFACE_VERSION 8 fee
 * rules (registry.ts :593-619) only fire on a registry that carries one.
 */
function registryJson(patch: { NVDA?: V2Patch; TSLA?: V2Patch } = {}): object {
  return {
    shared: { chainId: 4663 },
    defaults: { maxPriceAgeS: 345_600, maxSpotDivergenceBps: 300 },
    v2: { interfaceVersion: INTERFACE_VERSION, contracts: { expiryCalendar: '0x00000000000000000000000000000000c0de0004' } },
    markets: [
      {
        ticker: 'NVDA',
        asset: NVDA_TOKEN,
        feed: NVDA_FEED,
        cboe: { root: 'NVDA', url: cboeUrl('NVDA') },
        verification: { uiMultiplier: '1000775159164630595' },
        v2: { status: 'live', wave: 'canary', strikeTick: '2500000', puts: false, ...patch.NVDA },
      },
      {
        ticker: 'TSLA',
        asset: TSLA_TOKEN,
        feed: TSLA_FEED,
        cboe: { root: 'TSLA', url: cboeUrl('TSLA') },
        verification: { uiMultiplier: '1000000000000000000' },
        v2: { status: 'live', wave: 'wave1', strikeTick: '2500000', puts: true, ...patch.TSLA },
      },
    ],
  };
}

const round = (answer: bigint, updatedAt: number): FeedRound => ({ roundId: 18_446_744_073_709_552_249n, answer, updatedAt: BigInt(updatedAt), decimals: 8 });
const ROUNDS = { NVDA: round(21_221_000_000n, 1_789_416_000), TSLA: round(36_020_000_000n, 1_789_588_800) };

function spotReaderOf(rounds: Partial<Record<'NVDA' | 'TSLA', FeedRound>> = {}): SpotReader {
  const r = { ...ROUNDS, ...rounds };
  return async (feed) => {
    if (feed === NVDA_FEED) return r.NVDA;
    if (feed === TSLA_FEED) return r.TSLA;
    throw new Error('no such feed');
  };
}

/** The Cboe adapter over committed chains by root (an Error is a failed download). */
function cboeProvider(chains: Record<string, CboeChain | Error>): OptionChainProvider {
  return createCboeProvider(async (url) => {
    const root = /options\/([A-Z]+)\.json$/.exec(url)?.[1] ?? '';
    const chain = chains[root];
    if (chain === undefined) throw new Error(`no fixture for ${root}`);
    if (chain instanceof Error) throw chain;
    return chain;
  });
}

interface Scenario {
  nowMs: number;
  provider: OptionChainProvider;
  registry?: object;
  rounds?: Partial<Record<'NVDA' | 'TSLA', FeedRound>>;
  tickers?: string[];
  events?: EventCalendar | null;
  floorUsdg6?: bigint;
}

async function cover(s: Scenario): Promise<{ report: CoverageReport; service: PricingService }> {
  const json = s.registry ?? registryJson();
  const pricing = parsePricingRegistry(json);
  const spotReader = spotReaderOf(s.rounds);
  const service = new PricingService({
    markets: pricing.markets,
    spotReader,
    chains: { provider: s.provider },
    nowMs: () => s.nowMs,
    // The same calendar the rungs report on is the service's K3-312 event input (single source).
    ...(s.events == null ? {} : { events: toServiceEventCalendar(s.events) }),
  });
  const report = await runCoverage({
    registry: parseV2Registry(json),
    service,
    provider: s.provider.descriptor,
    spotReader,
    nextExpiry: localNextExpiry(NYSE_HOLIDAYS_2026_2028),
    expirySource: 'local-mirror',
    nowMs: () => s.nowMs,
    selection: { tickers: s.tickers ?? null, statuses: ['live'] },
    floorUsdg6: s.floorUsdg6 ?? PROPOSED_HOUSE_FLOOR_USDG6,
    events: s.events ?? null,
  });
  return { report, service };
}

const rungsOf = (report: CoverageReport, ticker: string) => report.markets.find((m) => m.ticker === ticker)!.rungs;
const at = (rungs: readonly RungRecord[], tenor: string, day: string) => rungs.filter((r) => r.tenor === tenor && r.expiryDay === day);

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  appended: Record<string, string>;
}

async function cli(argv: string[], s: { nowMs: number | (() => number); provider: OptionChainProvider; registry?: object; files?: Record<string, string>; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv; noSpotReader?: boolean }): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const appended: Record<string, string> = {};
  const code = await runCoverageCli(argv, {
    env: s.env ?? {},
    readFile: (path) => {
      if (path.endsWith('tier1.json')) return JSON.stringify(s.registry ?? registryJson());
      const file = s.files?.[path];
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      return file;
    },
    provider: s.provider,
    ...(s.noSpotReader === true ? {} : { spotReader: spotReaderOf() }),
    nowMs: typeof s.nowMs === 'function' ? s.nowMs : () => s.nowMs as number,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    appendFile: (path, t) => void (appended[path] = (appended[path] ?? '') + t),
    sleep: s.sleep ?? (async () => undefined),
  });
  return { code, stdout: out.join(''), stderr: err.join(''), appended };
}

const jsonl = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

/*//////////////////////////////////////////////////////////////
                              CALENDAR
//////////////////////////////////////////////////////////////*/

test('the local expiry grid mirrors ExpiryCalendar.nextExpiry: holidays skipped, a shut Friday moves the weekly to Thursday, DST closes, strictly after, a 14-day window', async () => {
  const next = localNextExpiry(NYSE_HOLIDAYS_2026_2028);
  const est = (m: number, d: number, y = 2026) => Date.UTC(y, m - 1, d, 21) / 1000;
  const edt = (m: number, d: number, y = 2026) => Date.UTC(y, m - 1, d, 20) / 1000;
  // Thanksgiving 2026: Thursday 26 Nov is shut, Friday 27 Nov (an early close) keeps its 16:00 grid close.
  assert.equal(await next(Date.UTC(2026, 10, 25, 12) / 1000, false), est(11, 25));
  assert.equal(await next(est(11, 25), false), est(11, 27), 'strictly after, and the holiday is skipped');
  assert.equal(await next(Date.UTC(2026, 10, 23, 12) / 1000, true), est(11, 27), 'the Friday early close is still the weekly');
  // Independence Day observed Friday 3 July 2026 and Good Friday 26 March 2027: the weekly is Thursday.
  assert.equal(await next(Date.UTC(2026, 5, 29, 12) / 1000, true), edt(7, 2));
  assert.equal(await next(Date.UTC(2027, 2, 22, 12) / 1000, true), edt(3, 25, 2027));
  // DST ends 1 November 2026: Friday 30 October closes 20:00 UTC, Monday 2 November 21:00 UTC.
  assert.equal(await next(edt(10, 29), false), edt(10, 30));
  assert.equal(await next(edt(10, 30), false), est(11, 2));
  // Nothing within 14 days (every weekday shut): rejects, as the contract reverts.
  const shut = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  await assert.rejects(localNextExpiry(shut)(Date.UTC(2026, 8, 1) / 1000, false), /no daily close within 14 days/);
});

test('the early-close table is the one ops/markets/v2-sources.json records', () => {
  const sources = JSON.parse(readFileSync(new URL('../../../../ops/markets/v2-sources.json', import.meta.url), 'utf8')) as { nyseHolidays: Record<string, { earlyCloses: Array<{ date: string }> }> };
  const recorded = Object.values(sources.nyseHolidays).flatMap((y) => y.earlyCloses.map((e) => e.date)).sort();
  assert.deepEqual([...NYSE_EARLY_CLOSES_2026_2028].sort(), recorded);
});

/*//////////////////////////////////////////////////////////////
                               LADDER
//////////////////////////////////////////////////////////////*/

test("the rungs are the cranker's own ladder: its expiry walk, its slots and planLadder's first ladder at the feed spot", async () => {
  const { report } = await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'] });
  const m = report.markets[0]!;
  const nowS = NVDA_NOW_MS / 1000;
  const calendar = localNextExpiry(NYSE_HOLIDAYS_2026_2028);
  const expiries = { weekly: await upcomingLadderExpiries(nowS, true, 2, calendar), daily: await upcomingLadderExpiries(nowS, false, 3, calendar) };
  assert.deepEqual(m.expiries, expiries);
  assert.deepEqual(expiries.daily, [sepClose(15), sepClose(16), sepClose(17)]);
  assert.deepEqual(expiries.weekly, [sepClose(18), sepClose(25)]);
  assert.equal(m.spot?.usdg6, 212_210_000n, 'the feed spot, as the pricing service reads it');
  const want = ladderSlots({ expiriesAhead: m.expiriesAhead }, false, expiries).flatMap((slot) =>
    planLadder({ spot: 212_210_000n, ladder: m.ladder[slot.tenor], strikeTick: 2_500_000n, isPut: slot.isPut, existing: [], anchor: null }).create.map((strike) => `${slot.tenor} ${slot.expiry} ${slot.isPut ? 'P' : 'C'} ${strike}`),
  );
  assert.deepEqual(m.rungs.map((r) => `${r.tenor} ${r.expiry} ${r.side === 'put' ? 'P' : 'C'} ${r.strike.raw}`), want);
  assert.equal(m.rungs.length, 25, '3 daily and 2 weekly expiries of 5 call rungs');
  assert.deepEqual(at(m.rungs, 'daily', '2026-09-15').map((r) => r.strike.formatted), ['215', '217.5', '220', '222.5', '225']);

  // Puts: rung 0 is the strike nearest the money, below it.
  const tsla = await cover({ nowMs: TSLA_NOW_MS, provider: cboeProvider({ TSLA: TSLA_CBOE }), tickers: ['TSLA'] });
  const puts = at(rungsOf(tsla.report, 'TSLA'), 'weekly', '2026-09-18').filter((r) => r.side === 'put');
  assert.deepEqual(puts.map((r) => [r.rung, r.strike.formatted]).sort((a, b) => Number(a[0]) - Number(b[0])), [[0, '352.5'], [1, '345'], [2, '337.5'], [3, '330'], [4, '325']]);
});

/*//////////////////////////////////////////////////////////////
                              METHODS
//////////////////////////////////////////////////////////////*/

test('methods: exact listed weeklies, dailies extrapolated before the first listing, interpolated between listed expiries and between listed strikes', async () => {
  const nvda = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'] })).report, 'NVDA');
  for (const r of nvda.filter((x) => x.tenor === 'daily')) {
    assert.deepEqual([r.method, r.methodDetail, r.listing.expiryListed, r.listing.exact], ['extrapolated', 'flat-before-first', false, false], `${r.expiryDay} ${r.strike.formatted}`);
    assert.deepEqual(r.contributingExpiries, [sepClose(18)]);
    assert.ok(r.reasons.includes('extrapolated'));
  }
  for (const r of nvda.filter((x) => x.tenor === 'weekly')) {
    assert.deepEqual([r.method, r.methodDetail, r.listing.exact, r.listing.usable], ['listed', 'listed-contract', true, true]);
    assert.deepEqual(r.contributingExpiries, [r.expiry]);
  }

  // A 1 USDG tick puts weekly rungs between the listed 2.5 strikes: interpolated inside the listed expiry.
  const fine = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], registry: registryJson({ NVDA: { strikeTick: '1000000' } }) })).report, 'NVDA');
  assert.deepEqual(
    at(fine, 'weekly', '2026-09-18').map((r) => [r.strike.formatted, r.method, r.listing.exact, r.listing.expiryListed]),
    [['217', 'interpolated', false, true], ['221', 'interpolated', false, true], ['226', 'interpolated', false, true], ['230', 'listed', true, true], ['235', 'listed', true, true]],
  );

  // TSLA with four dailies: Thursday before the first kept listing, Friday and Monday listed, Tuesday between listings.
  const tsla = rungsOf((await cover({ nowMs: TSLA_NOW_MS, provider: cboeProvider({ TSLA: TSLA_CBOE }), tickers: ['TSLA'], registry: registryJson({ TSLA: { overrides: { expiriesAhead: { daily: 4 } } } }) })).report, 'TSLA');
  const methodOf = (day: string) => [...new Set(at(tsla, 'daily', day).map((r) => r.method))];
  assert.deepEqual(methodOf('2026-09-17'), ['extrapolated']);
  assert.deepEqual(methodOf('2026-09-18'), ['listed']);
  assert.deepEqual(methodOf('2026-09-21'), ['listed']);
  assert.deepEqual(methodOf('2026-09-22'), ['interpolated']);
  for (const r of at(tsla, 'daily', '2026-09-22')) {
    assert.equal(r.methodDetail, 'total-variance');
    assert.deepEqual(r.contributingExpiries, [sepClose(21), sepClose(23)]);
    assert.deepEqual([r.listing.expiryListed, r.listing.exact], [false, false]);
  }
  assert.ok(tsla.some((r) => r.side === 'put'), 'TSLA lists puts');
});

test('listing: the exact listed quote rides as supplied (Cboe: no sizes, no quote time; a fake: its sizes and time); no chain is unknown, not absent', async () => {
  const cboe = at(rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'] })).report, 'NVDA'), 'weekly', '2026-09-18')[0]!;
  const row = NVDA_CBOE.options.find((o) => o.symbol === 'NVDA260918C00217500')!;
  assert.deepEqual(
    [cboe.listing.providerInstrumentId, cboe.listing.bid, cboe.listing.ask, cboe.listing.bidSize, cboe.listing.askSize, cboe.listing.quoteObservedAt, cboe.listing.book],
    ['NVDA260918C00217500', row.bid, row.ask, null, null, null, 'two-sided'],
  );
  const fake = at(rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listedTwin(NVDA, NVDA_AS_OF) }), tickers: ['NVDA'] })).report, 'NVDA'), 'weekly', '2026-09-18')[0]!;
  assert.deepEqual([fake.listing.bidSize, fake.listing.askSize, fake.listing.quoteObservedAt], [10, 10, NVDA_AS_OF]);
  assert.equal(fake.provider, 'fake-listed');
  assert.deepEqual(fake.entitlement, FAKE_LISTED_PROVIDER.entitlement);
  assert.deepEqual(fake.identity, { market: 'NVDA', root: 'NVDA', issuer: null, token: { chainId: 4663, address: NVDA_TOKEN, uiMultiplier: '1000775159164630595' } });

  const none = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: new Error('http-status: HTTP 503') }), tickers: ['NVDA'] })).report, 'NVDA');
  assert.ok(none.length > 0 && none.every((r) => r.listing.exact === null && r.listing.expiryListed === null), 'no chain to look in: unknown');
});

/*//////////////////////////////////////////////////////////////
                         ZERO IS NOT NULL
//////////////////////////////////////////////////////////////*/

test('zero is not null: a far OTM rung prices to fair "0" (below the floor, degraded); a refused rung is fair null with its reason and no floor verdict', async () => {
  const registry = registryJson({ NVDA: { overrides: { ladder: { daily: { firstOtmBps: 4000 } } } } });
  const { report } = await cover({
    nowMs: NVDA_NOW_MS,
    provider: cboeProvider({ NVDA: NVDA_CBOE, TSLA: new Error('http-status: HTTP 503') }),
    registry,
    rounds: { TSLA: round(36_020_000_000n, NVDA_NOW_MS / 1000 - 3_600) },
  });
  const zero = at(rungsOf(report, 'NVDA'), 'daily', '2026-09-15')[0]!;
  assert.deepEqual(zero.fair, { raw: '0', decimals: 6, formatted: '0' });
  assert.deepEqual([zero.belowFloor, zero.readiness, zero.refusal], [true, 'degraded', null]);
  assert.ok(zero.iv !== null && zero.iv > 0);

  const refused = rungsOf(report, 'TSLA');
  assert.ok(refused.length > 0);
  for (const r of refused) {
    assert.deepEqual([r.fair, r.iv, r.delta, r.belowFloor, r.readiness, r.method], [null, null, null, null, 'unavailable', null]);
    assert.equal(r.refusal?.reason, 'chain-unavailable');
    assert.deepEqual(r.reasons, ['chain-unavailable']);
  }
  const lines = [zero, refused[0]!].map((r) => JSON.parse(JSON.stringify(r)) as { fair: unknown; belowFloor: unknown });
  assert.deepEqual(lines.map((l) => [l.fair, l.belowFloor]), [[{ raw: '0', decimals: 6, formatted: '0' }, true], [null, null]], 'the JSON keeps the two apart');
  const s = summarize(report).find((x) => x.ticker === 'NVDA' && x.tenor === 'daily')!;
  assert.equal(s.belowFloor, 15);
  assert.equal(s.unavailable, 0);
});

/*//////////////////////////////////////////////////////////////
                              CLOCKS
//////////////////////////////////////////////////////////////*/

test('clocks: Cboe states no quote time (degraded, quote-age-unknown, quote age null); a stale chain and a timeless chain are unavailable with their clocks kept as given', async () => {
  const nowS = NVDA_NOW_MS / 1000;
  const cboe = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'] })).report, 'NVDA');
  for (const r of cboe) {
    assert.equal(r.readiness, 'degraded');
    assert.ok(r.reasons.includes('quote-age-unknown'));
    assert.deepEqual([r.clocks.quoteObservedAt, r.ages.quoteS, r.clocks.underlyingObservedAt, r.ages.underlyingS], [null, null, NVDA_AS_OF, nowS - NVDA_AS_OF]);
    assert.equal(r.ages.publishedS, nowS - r.clocks.publishedAt!);
  }

  const stale = fakeListedChain(NVDA, { quoteObservedAt: null, underlyingObservedAt: nowS - 5 * 86_400, publishedAt: nowS - 60 });
  const staleRun = (await cover({ nowMs: NVDA_NOW_MS, provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: stale }), tickers: ['NVDA'] })).report;
  assert.equal(staleRun.markets[0]!.chain.state, 'chain-stale');
  for (const r of rungsOf(staleRun, 'NVDA')) {
    assert.deepEqual([r.readiness, r.refusal?.reason, r.fair], ['unavailable', 'chain-stale', null]);
    assert.deepEqual(r.clocks, { quoteObservedAt: null, tradeObservedAt: null, underlyingObservedAt: nowS - 5 * 86_400, volatilityObservedAt: null, publishedAt: nowS - 60, receivedAt: nowS, computedAt: nowS });
    assert.deepEqual(r.ages, { quoteS: null, tradeS: null, underlyingS: 5 * 86_400, volatilityS: null, publishedS: 60, receivedS: 0 });
  }
  assert.ok(rungsOf(staleRun, 'NVDA').some((r) => r.listing.exact === true), 'a stale chain still says what it lists');

  const timeless = fakeListedChain(NVDA, { quoteObservedAt: null, underlyingObservedAt: null, publishedAt: null });
  const timelessRun = (await cover({ nowMs: NVDA_NOW_MS, provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: timeless }), tickers: ['NVDA'] })).report;
  for (const r of rungsOf(timelessRun, 'NVDA')) {
    assert.deepEqual([r.readiness, r.refusal?.reason], ['unavailable', 'chain-inconsistent']);
    assert.deepEqual([r.clocks.quoteObservedAt, r.clocks.underlyingObservedAt, r.clocks.publishedAt, r.ages.underlyingS, r.ages.publishedS], [null, null, null, null, null], 'never filled from the download time');
  }
});

/*//////////////////////////////////////////////////////////////
                  TENORS: DAILY FAILURES STAY VISIBLE
//////////////////////////////////////////////////////////////*/

test('a weekly pass never hides a daily failure: each tenor summarised and judged on its own', async () => {
  const { report } = await cover({ nowMs: NVDA_NOW_MS, provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listedTwin(NVDA, NVDA_AS_OF) }), tickers: ['NVDA'] });
  const [daily, weekly] = summarize(report);
  assert.deepEqual([daily!.tenor, daily!.rungs, daily!.ready, daily!.degraded, daily!.quoteReady], ['daily', 15, 0, 15, false]);
  assert.deepEqual([weekly!.tenor, weekly!.rungs, weekly!.ready, weekly!.quoteReady], ['weekly', 10, 10, true]);
  const verdict = quoteReadiness(report);
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.markets, [{ ticker: 'NVDA', daily: 'not-ready', weekly: 'ready' }]);
  assert.equal(verdict.failing.length, 15);
  assert.ok(verdict.failing.every((f) => f.tenor === 'daily' && f.reasons.includes('extrapolated')));

  // A market with no fresh spot has no ladder: that is a blocker on every enabled tenor, never an empty pass.
  const dark = await cover({ nowMs: NVDA_NOW_MS, provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listedTwin(NVDA, NVDA_AS_OF) }), tickers: ['NVDA'], rounds: { NVDA: round(21_221_000_000n, NVDA_NOW_MS / 1000 - 2 * 86_400) } });
  assert.equal(dark.report.markets[0]!.ladderError?.reason, 'spot-stale');
  const darkVerdict = quoteReadiness(dark.report);
  assert.equal(darkVerdict.ready, false);
  assert.deepEqual(darkVerdict.blockers.map((b) => `${b.tenor} ${b.blocker}`), ['daily no ladder: spot-stale', 'weekly no ladder: spot-stale']);
  assert.equal(f1Inputs(dark.report)[0]!.ladderError?.reason, 'spot-stale', 'the F1 inputs are still emitted');
});

test('the command: quote-readiness exits 1 and lists only the failing (daily) series; exits 0 when every enabled series is ready; diagnostic always exits 0 with the F1 inputs', async () => {
  const fake = () => createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listedTwin(NVDA, NVDA_AS_OF) });
  const failing = await cli(['--mode', 'quote-readiness', '--tickers', 'NVDA', '--calendar', 'local'], { nowMs: NVDA_NOW_MS, provider: fake() });
  assert.equal(failing.code, 1, failing.stderr);
  assert.match(failing.stdout, /MM\/pricer quote readiness: NOT READY/);
  assert.match(failing.stdout, /NVDA: daily not-ready · weekly ready/);
  assert.match(failing.stdout, /failing series \(15\):/);
  // K3-303 and K3-312 combined: a before-first daily is extrapolated, assumes an unknown event with
  // no event input (event-uncertainty), and is too wide on this flat fixture (model-uncertainty).
  assert.match(failing.stdout, /NVDA daily 2026-09-15 call 215: degraded \(extrapolated, event-uncertainty, model-uncertainty\)/);
  assert.doesNotMatch(failing.stdout, /NVDA weekly 2026-09-18 call [\d.]+: /);

  const diagnostic = await cli(['--tickers', 'NVDA', '--calendar', 'local'], { nowMs: NVDA_NOW_MS, provider: fake() });
  assert.equal(diagnostic.code, 0);
  assert.match(diagnostic.stdout, /F1 registration inputs/);
  assert.match(diagnostic.stdout, /strikeTick 2\.5 vs listed spacing near the money 2\.5 \(2026-09-18\): match/);
  const broken = await cli(['--calendar', 'local'], { nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: new Error('http-status: HTTP 503'), TSLA: new Error('http-status: HTTP 503') }) });
  assert.equal(broken.code, 0, 'diagnostic exits 0 whatever the market data says');
  assert.match(broken.stdout, /F1 registration inputs[\s\S]*NVDA: token[\s\S]*TSLA: token/);

  // Every session of the week listed with a stated quote time: every enabled series is ready.
  const allListed = listedTwin(cboeToNormalized(syntheticNvdaDailiesChain(), 0), NVDA_AS_OF);
  const ready = await cli(['--mode', 'quote-readiness', '--tickers', 'NVDA', '--calendar', 'local'], { nowMs: NVDA_NOW_MS, provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: allListed }) });
  assert.equal(ready.code, 0, ready.stdout);
  assert.match(ready.stdout, /MM\/pricer quote readiness: READY/);
  assert.match(ready.stdout, /NVDA: daily ready · weekly ready/);
});

/*//////////////////////////////////////////////////////////////
                    HOLIDAYS AND EARLY CLOSES
//////////////////////////////////////////////////////////////*/

test('Thanksgiving week: dailies skip the holiday; the Friday early close is flagged on exact listed rungs; Monday interpolates across the weekend', async () => {
  const chain = listedTwin(cboeToNormalized(syntheticNvdaThanksgivingChain(), 0), Date.UTC(2026, 10, 24, 20, 59, 59) / 1000);
  const nowMs = Date.UTC(2026, 10, 25, 12);
  const { report } = await cover({ nowMs, provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: chain }), tickers: ['NVDA'], rounds: { NVDA: round(20_040_000_000n, Date.UTC(2026, 10, 24, 21) / 1000) } });
  const m = report.markets[0]!;
  const close = (d: number) => Date.UTC(2026, 10, d, 21) / 1000;
  assert.deepEqual(m.expiries.daily, [close(25), close(27), close(30)], 'Thursday 26 November is not an expiry');
  assert.deepEqual(m.expiries.weekly, [close(27), Date.UTC(2026, 11, 4, 21) / 1000]);

  for (const r of [...at(m.rungs, 'daily', '2026-11-27'), ...at(m.rungs, 'weekly', '2026-11-27')]) {
    assert.deepEqual([r.method, r.listing.exact, r.session.earlyClose], ['listed', true, true]);
    assert.deepEqual(r.reasons, ['early-close']);
    assert.equal(r.readiness, 'degraded', 'an exact listed contract on an early close is still not ready');
  }
  assert.ok(at(m.rungs, 'daily', '2026-11-25').every((r) => r.method === 'extrapolated' && !r.session.earlyClose));
  for (const r of at(m.rungs, 'daily', '2026-11-30')) {
    assert.deepEqual([r.method, r.methodDetail], ['interpolated', 'total-variance']);
    assert.deepEqual(r.contributingExpiries, [close(27), Date.UTC(2026, 11, 4, 21) / 1000]);
  }
  assert.ok(at(m.rungs, 'weekly', '2026-12-04').every((r) => r.readiness === 'ready' && r.session.earlyClose === false));
  const f1 = f1Inputs(report)[0]!;
  assert.deepEqual(
    f1.ladderExpiries.daily.map((e) => [e.day, e.weekday, e.listed, e.earlyClose]),
    [['2026-11-25', 'Wed', false, false], ['2026-11-27', 'Fri', true, true], ['2026-11-30', 'Mon', false, false]],
  );

  // Independence Day week 2026: Friday 3 July is shut, so the weekly is Thursday 2 July and says so.
  const july = await cover({ nowMs: Date.UTC(2026, 5, 30, 12), provider: cboeProvider({ NVDA: new Error('no July chain in the fixtures') }), tickers: ['NVDA'], rounds: { NVDA: round(21_221_000_000n, Date.UTC(2026, 5, 29, 20) / 1000) } });
  const thursday = at(rungsOf(july.report, 'NVDA'), 'weekly', '2026-07-02');
  assert.ok(thursday.length > 0 && thursday.every((r) => r.expiryWeekday === 'Thu' && r.session.holidayShiftedWeekly && r.readiness === 'unavailable'));
});

/*//////////////////////////////////////////////////////////////
                              EVENTS
//////////////////////////////////////////////////////////////*/

// A SYNTHETIC test event, not a real earnings date.
const SYNTHETIC_EVENT = { NVDA: [{ kind: 'earnings', date: '2026-09-16', session: 'after-close', label: 'synthetic test event' }] };

test('events: a supplied (synthetic) earnings date flags event-uncertainty on every series that spans it and every one priced from a listing that does', async () => {
  const events = parseEventCalendar(SYNTHETIC_EVENT);
  const rungs = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], events })).report, 'NVDA');
  const relation = (tenor: string, day: string) => [...new Set(at(rungs, tenor, day).map((r) => r.events?.map((e) => e.relation).join(',')))];
  assert.deepEqual(relation('daily', '2026-09-15'), ['inside-inputs'], 'settles before the event, but its vol comes from the 18 Sep listing that spans it');
  assert.deepEqual(relation('daily', '2026-09-16'), ['inside-inputs'], 'an after-close event is outside that day\'s 16:00 series');
  assert.deepEqual(relation('daily', '2026-09-17'), ['inside-series']);
  assert.deepEqual(relation('weekly', '2026-09-18'), ['inside-series']);
  assert.ok(rungs.every((r) => r.reasons.includes('event-uncertainty') && r.events?.[0]?.label === 'synthetic test event'));

  // A ready weekly is no longer ready once an event sits inside it.
  const fake = createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listedTwin(NVDA, NVDA_AS_OF) });
  const flagged = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: fake, tickers: ['NVDA'], events })).report, 'NVDA');
  assert.ok(at(flagged, 'weekly', '2026-09-18').every((r) => r.readiness === 'degraded' && r.reasons.join() === 'event-uncertainty'));

  // An event after every input: nothing flagged, events []. No calendar at all: events null (unknown).
  const later = parseEventCalendar({ NVDA: [{ kind: 'earnings', date: '2026-10-15', session: 'before-open' }] });
  const clear = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], events: later })).report, 'NVDA');
  assert.ok(clear.every((r) => Array.isArray(r.events) && r.events.length === 0 && !r.reasons.includes('event-uncertainty')));
  const unknown = rungsOf((await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'] })).report, 'NVDA');
  assert.ok(unknown.every((r) => r.events === null));
});

test('the event calendar is strict: a date needs a session, one form only, an upper-case ticker; --events feeds it to the command', async () => {
  const cal = parseEventCalendar({ NVDA: [{ kind: 'earnings', date: '2026-09-16', session: 'before-open' }, { at: 1_790_000_000 }] });
  assert.deepEqual(cal.get('NVDA'), [
    { kind: 'earnings', at: Date.UTC(2026, 8, 16, 13) / 1000, label: null, date: '2026-09-16', timing: 'bmo' },
    { kind: 'earnings', at: 1_790_000_000, label: null, date: '2026-09-21', timing: null },
  ]);
  assert.throws(() => parseEventCalendar({ NVDA: [{ date: '2026-09-16' }] }), /either `at`/);
  assert.throws(() => parseEventCalendar({ NVDA: [{ at: 1, date: '2026-09-16', session: 'after-close' }] }), /either `at`/);
  assert.throws(() => parseEventCalendar({ nvda: [] }), /not usable/);
  const run = await cli(['--tickers', 'NVDA', '--calendar', 'local', '--events', '/tmp/events.json', '--format', 'jsonl'], { nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), files: { '/tmp/events.json': JSON.stringify(SYNTHETIC_EVENT) } });
  assert.equal(run.code, 0, run.stderr);
  const lines = jsonl(run.stdout);
  assert.equal(lines[0]!.eventCalendar, 'provided');
  assert.ok(lines.filter((l) => l.kind === 'rung').every((l) => (l.reasons as string[]).includes('event-uncertainty')));
  const bad = await cli(['--tickers', 'NVDA', '--calendar', 'local', '--events', '/tmp/bad.json'], { nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), files: { '/tmp/bad.json': '{"NVDA":[{"date":"2026-09-16"}]}' } });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--events \/tmp\/bad\.json/);
});

/*//////////////////////////////////////////////////////////////
                            SUGGESTIONS
//////////////////////////////////////////////////////////////*/

function assertNeverDisables(suggestions: unknown): void {
  const text = JSON.stringify(suggestions);
  assert.doesNotMatch(text, /expiriesAhead/, 'no suggestion touches expiriesAhead');
  for (const s of suggestions as Array<{ derived: boolean; writesRegistry: boolean; overrides: { ladder?: Record<string, { rungs?: number }> } }>) {
    assert.deepEqual([s.derived, s.writesRegistry], [true, false]);
    for (const tenor of Object.values(s.overrides.ladder ?? {})) if (tenor.rungs !== undefined) assert.ok(tenor.rungs >= 1, 'never zero rungs');
  }
}

test('--suggest: derived overrides.ladder that reprice above the floor, never an expiriesAhead change, never zero rungs, never a daily turned off', async () => {
  // Every daily rung prices to zero: the first rung moves toward the money, repriced to prove it clears the floor.
  const far = registryJson({ NVDA: { overrides: { ladder: { daily: { firstOtmBps: 4000 } } } } });
  const farRun = await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], registry: far });
  const [farSuggestion] = await suggestLadders(farRun.report, farRun.service);
  assertNeverDisables([farSuggestion]);
  const firstOtm = farSuggestion!.overrides.ladder?.daily?.firstOtmBps;
  assert.ok(firstOtm !== undefined && firstOtm < 4000, JSON.stringify(farSuggestion));
  assert.equal(farSuggestion!.overrides.ladder?.weekly, undefined, 'the weekly ladder clears the floor: untouched');
  assert.ok(farSuggestion!.notes.some((n) => n.includes('dailies stay on (owner D6)')));
  const applied = await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], registry: registryJson({ NVDA: { overrides: { ladder: { daily: { firstOtmBps: firstOtm } } } } }) });
  assert.ok(rungsOf(applied.report, 'NVDA').filter((r) => r.tenor === 'daily' && r.rung === 0).every((r) => r.belowFloor === false), 'the suggestion holds when applied');

  // Outer rungs below the floor at every expiry: fewer rungs, at least one.
  const wide = await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], registry: registryJson({ NVDA: { overrides: { ladder: { daily: { stepBps: 2000 } } } } }) });
  const [wideSuggestion] = await suggestLadders(wide.report, wide.service);
  assertNeverDisables([wideSuggestion]);
  assert.deepEqual(wideSuggestion!.overrides, { ladder: { daily: { rungs: 1 } } });

  // Nothing prices above an absurd floor, and nothing prices at all without a chain: notes only, dailies stay on.
  const absurd = await cover({ nowMs: TSLA_NOW_MS, provider: cboeProvider({ TSLA: TSLA_CBOE }), tickers: ['TSLA'], floorUsdg6: 50_000_000n });
  const dead = await cover({ nowMs: TSLA_NOW_MS, provider: cboeProvider({ TSLA: new Error('http-status: HTTP 503') }), tickers: ['TSLA'] });
  const offDaily = await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], registry: registryJson({ NVDA: { overrides: { expiriesAhead: { daily: 0 } } } }) });
  for (const run of [absurd, dead, offDaily]) {
    const suggestions = await suggestLadders(run.report, run.service);
    assertNeverDisables(suggestions);
    assert.deepEqual(suggestions[0]!.overrides, {});
  }
  assert.ok((await suggestLadders(absurd.report, absurd.service))[0]!.notes.some((n) => n.startsWith('daily: even an at-the-money first rung is below the floor') && n.endsWith('(owner D6)')));
  assert.ok((await suggestLadders(dead.report, dead.service))[0]!.notes.includes('daily: no priced rung, so no floor evidence; dailies stay on (owner D6)'));
  assert.ok((await suggestLadders(offDaily.report, offDaily.service))[0]!.notes.some((n) => n.startsWith('daily: off in the registry; no ladder suggestion')));

  // Through the command: printed, never written.
  const run = await cli(['--tickers', 'NVDA', '--calendar', 'local', '--suggest', '--format', 'jsonl'], { nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), registry: far });
  assert.equal(run.code, 0, run.stderr);
  const suggestion = jsonl(run.stdout).filter((l) => l.kind === 'suggestion');
  assert.equal(suggestion.length, 1);
  assertNeverDisables(suggestion);
  assert.deepEqual(run.appended, {}, 'nothing written anywhere without --out');
});

test('strike tick against the listed spacing near the money: match, coarser, off the listed grid (with the listed spacing suggested), no listing', async () => {
  assert.deepEqual(strikeTickFlag(2_500_000n, { spacingUsd: 2.5 }), { flag: 'match', listedSpacingUsdg6: 2_500_000n, suggestedUsdg6: null });
  assert.deepEqual(strikeTickFlag(5_000_000n, { spacingUsd: 2.5 }), { flag: 'coarser-than-listed', listedSpacingUsdg6: 2_500_000n, suggestedUsdg6: null });
  assert.deepEqual(strikeTickFlag(1_000_000n, { spacingUsd: 2.5 }), { flag: 'off-listed-grid', listedSpacingUsdg6: 2_500_000n, suggestedUsdg6: 2_500_000n });
  assert.deepEqual(strikeTickFlag(1_000_000n, null), { flag: 'no-listing', listedSpacingUsdg6: null, suggestedUsdg6: null });
  const run = await cover({ nowMs: NVDA_NOW_MS, provider: cboeProvider({ NVDA: NVDA_CBOE }), tickers: ['NVDA'], registry: registryJson({ NVDA: { strikeTick: '1000000' } }) });
  assert.deepEqual(run.report.markets[0]!.listedSpacing, { day: '2026-09-18', spacingUsd: 2.5 });
  const [s] = await suggestLadders(run.report, run.service);
  assert.deepEqual(s!.strikeTick, { current: '1000000', listedSpacing: '2500000', flag: 'off-listed-grid', suggested: '2500000' });
  assert.equal(f1Inputs(run.report)[0]!.strikeTickVsListing, 'off-listed-grid');
});

/*//////////////////////////////////////////////////////////////
                               WATCH
//////////////////////////////////////////////////////////////*/

const WATCH_KEYS = ['kind', 'contract', 'iteration', 'at', 'ticker', 'provider', 'providerProduct', 'entitlement', 'chain', 'clocks', 'ages', 'refusal', 'ladderError', 'tenors'];

test('--watch: one JSON line per market per refresh with the chain clocks and ages (null kept null) and refusal state; a refetch advances only receivedAt', async () => {
  let now = NVDA_NOW_MS;
  const sleep = async (ms: number) => void (now += ms);
  const run = await cli(['--watch', '30', '--iterations', '3', '--calendar', 'local', '--out', '/tmp/watch.jsonl'], { nowMs: () => now, provider: cboeProvider({ NVDA: NVDA_CBOE, TSLA: new Error('http-status: HTTP 503') }), sleep });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, '', 'with --out the lines go only to the file');
  const lines = jsonl(run.appended['/tmp/watch.jsonl']!) as unknown as WatchLine[];
  assert.equal(lines.length, 6, 'two live markets × three refreshes');
  for (const line of lines) assert.deepEqual(Object.keys(line), WATCH_KEYS);
  const nvda = lines.filter((l) => l.ticker === 'NVDA');
  assert.deepEqual(nvda.map((l) => [l.iteration, l.at]), [[1, NVDA_NOW_MS / 1000], [2, NVDA_NOW_MS / 1000 + 30], [3, NVDA_NOW_MS / 1000 + 60]]);
  for (const l of nvda) {
    assert.deepEqual(Object.keys(l.clocks), ['quoteObservedAt', 'tradeObservedAt', 'underlyingObservedAt', 'volatilityObservedAt', 'publishedAt', 'receivedAt']);
    assert.deepEqual(Object.keys(l.ages), ['quoteS', 'tradeS', 'underlyingS', 'volatilityS', 'publishedS', 'receivedS']);
    assert.deepEqual([l.clocks.quoteObservedAt, l.ages.quoteS, l.clocks.volatilityObservedAt, l.ages.volatilityS], [null, null, null, null], 'Cboe states no quote or vol time');
    assert.equal(l.clocks.receivedAt, NVDA_NOW_MS / 1000, 'inside the five-minute refetch floor: the same download');
    assert.equal(l.ages.underlyingS, l.at - NVDA_AS_OF);
    assert.deepEqual([l.chain.state, l.refusal, l.provider], ['ok', null, 'cboe-delayed']);
    assert.deepEqual(l.tenors.daily, { rungs: 15, ready: 0, degraded: 15, unavailable: 0 });
  }
  const tsla = lines.filter((l) => l.ticker === 'TSLA');
  for (const l of tsla) {
    assert.deepEqual([l.chain.present, l.chain.state, l.refusal?.reason, l.chain.fetchError], [false, 'chain-unavailable', 'chain-unavailable', 'http-status: HTTP 503']);
    assert.deepEqual(l.clocks, { quoteObservedAt: null, tradeObservedAt: null, underlyingObservedAt: null, volatilityObservedAt: null, publishedAt: null, receivedAt: null });
    assert.ok(Object.values(l.ages).every((a) => a === null));
  }

  // Refreshes past the refetch floor download again: receivedAt moves, the observed clocks do not.
  now = NVDA_NOW_MS;
  const slow = await cli(['--watch', '360', '--iterations', '2', '--calendar', 'local', '--tickers', 'NVDA'], { nowMs: () => now, provider: cboeProvider({ NVDA: NVDA_CBOE }), sleep });
  const [first, second] = jsonl(slow.stdout) as unknown as WatchLine[];
  assert.equal(second!.clocks.receivedAt! - first!.clocks.receivedAt!, 360);
  assert.deepEqual([second!.clocks.publishedAt, second!.clocks.underlyingObservedAt, second!.clocks.quoteObservedAt], [first!.clocks.publishedAt, first!.clocks.underlyingObservedAt, null]);
});

/*//////////////////////////////////////////////////////////////
                           THE COMMAND
//////////////////////////////////////////////////////////////*/

test('the command: usage and configuration errors exit 2 before any read; no RPC is needed when every read is injected; JSON lines on stdout and appended with --out', async () => {
  const provider = cboeProvider({ NVDA: NVDA_CBOE });
  for (const argv of [['--bogus'], ['--mode', 'fast'], ['--format', 'xml'], ['--floor', 'abc'], ['--iterations', '2'], ['--watch', '0'], ['--status', 'retired'], ['--watch', '5', '--mode', 'quote-readiness'], ['--tickers', 'AAPL', '--calendar', 'local']]) {
    const run = await cli(argv, { nowMs: NVDA_NOW_MS, provider });
    assert.equal(run.code, 2, `${argv.join(' ')}: ${run.stdout}`);
    assert.match(run.stderr, /Usage: pnpm --filter @callhouse\/keeper v2:pricing-coverage/);
  }
  // The registry names an on-chain calendar: reading it needs RH_RPC, and the command says so instead of guessing.
  const noRpc = await cli(['--tickers', 'NVDA'], { nowMs: NVDA_NOW_MS, provider });
  assert.equal(noRpc.code, 2);
  assert.match(noRpc.stderr, /RH_RPC is required to read the ExpiryCalendar/);
  const noFeed = await cli(['--tickers', 'NVDA', '--calendar', 'local'], { nowMs: NVDA_NOW_MS, provider, noSpotReader: true });
  assert.equal(noFeed.code, 2);
  assert.match(noFeed.stderr, /RH_RPC is required: the Stock Token feeds are read there/);
  const help = await cli(['--help'], { nowMs: NVDA_NOW_MS, provider });
  assert.deepEqual([help.code, help.stdout.startsWith('Usage:')], [0, true]);

  const run = await cli(['--tickers', 'NVDA', '--calendar', 'local', '--format', 'jsonl', '--out', '/tmp/coverage.jsonl'], { nowMs: NVDA_NOW_MS, provider });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.appended['/tmp/coverage.jsonl'], run.stdout, 'the same lines on stdout and in the file');
  const lines = jsonl(run.stdout);
  assert.deepEqual([...new Set(lines.map((l) => l.kind))], ['run', 'rung', 'tenor-summary', 'f1-inputs', 'quote-readiness']);
  assert.deepEqual(lines[0], {
    kind: 'run',
    contract: 'K3-303/1',
    mode: 'diagnostic',
    computedAt: NVDA_NOW_MS / 1000,
    provider: { id: 'cboe-delayed', product: 'delayed_quotes/options', entitlement: { class: 'delayed', declaredDelayS: null, rightsRef: null } },
    expirySource: 'local-mirror',
    expiryErrors: [],
    ladderSpot: 'feed',
    floor: { usdg: { raw: '50000', decimals: 6, formatted: '0.05' }, proposal: true, note: 'F3 D9 proposal, not an approved value' },
    eventCalendar: 'absent',
    markets: ['NVDA'],
    derivedOnly: true,
  });
  assert.equal(lines.filter((l) => l.kind === 'rung').length, 25);
  const floor = await cli(['--tickers', 'NVDA', '--calendar', 'local', '--floor', '0.25'], { nowMs: NVDA_NOW_MS, provider });
  assert.match(floor.stdout, /floor 0\.25 USDG \(operator-supplied\)/);

  // Default selection is the live markets; --status widens it.
  const planned = registryJson({ TSLA: { status: 'planned' } });
  const live = jsonl((await cli(['--calendar', 'local', '--format', 'jsonl'], { nowMs: NVDA_NOW_MS, provider, registry: planned })).stdout)[0]!;
  assert.deepEqual(live.markets, ['NVDA']);
  const both = jsonl((await cli(['--calendar', 'local', '--format', 'jsonl', '--status', 'live,planned'], { nowMs: NVDA_NOW_MS, provider, registry: planned })).stdout)[0]!;
  assert.deepEqual(both.markets, ['NVDA', 'TSLA']);
});
