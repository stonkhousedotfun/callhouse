/**
 * K3-312: event-aware short maturities, the expiry clock through the service, and parity.
 *
 * WHY THIS FILE EXISTS: a daily before the first listed expiry is priced at the first listing's vol,
 * which cannot tell an earnings jump from ordinary variance. The tests pin, on the committed synthetic
 * NVDA/TSLA chains through the real PricingService:
 *   - PARITY: with no event input every fair, iv, delta, source, method and asOf equals the base
 *     service's (fixtures/pricing-parity.ts, captured before K3-312), and event input never changes
 *     them either: it changes only bounds, reasons and readiness. The legacy /fair body is identical;
 *   - an event included in the window widens the bound up, an excluded one down, an unknown timing both;
 *   - the first listed expiry identifies what lies before it; missing or short event input is
 *     `event-uncertainty`; a model-uncertain read is bounded or refused by policy;
 *   - overnight, weekend, holiday and (synthetic) early-close windows, a moved listing calendar, and
 *     the clock refusals;
 *   - bounds always contain the point, nest as the policy loosens, and a bounded read is never ready.
 *
 * EVENT DATES ARE SYNTHETIC test inputs chosen around the fixtures' September 2026 dates; they are not
 * real earnings dates. The early-close day is synthetic too. No network, no credentials.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { PRICING_PARITY_CASES, type ParityScenario } from '../../fixtures/pricing-parity.js';
import { syntheticNvdaChain, syntheticTslaChain } from '../../fixtures/synthetic-chains.js';
import type { CboeChain } from '../../vol.js';
import { cboeToNormalized } from './cboe.js';
import type { NormalizedChain } from './chain.js';
import { FAKE_LISTED_PROVIDER, createFakeProvider, fakeListedChain } from './fake-provider.js';
import { PricingService, type FairOutcome, type FairQuote, type FairRequest, type PricingSettings } from './fair.js';
import type { PricingMarket } from './markets.js';
import { chainSpotReader } from './replay.js';
import { createPricingApp, fairResponse, money } from './server.js';
import { DEFAULT_SHORT_MATURITY_POLICY, eventCalendar, eventWindow, type EventCalendar, type ShortMaturityPolicy } from './short-maturity.js';
import type { FeedRound } from './spot.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const NVDA = syntheticNvdaChain();
const TSLA = syntheticTslaChain();
/** TSLA re-dated to Thursday 17 Sep's close (fair.test.ts's dailies). */
const TSLA_THURSDAY: CboeChain = { ...TSLA, lastTradeTime: '2026-09-17T15:59:59', timestamp: '2026-09-17 20:05:00' };
/** NVDA re-dated to Friday 4 Sep's close, the session before Labor Day. */
const NVDA_LABOR_DAY: CboeChain = { ...NVDA, lastTradeTime: '2026-09-04T15:59:59', timestamp: '2026-09-04 20:05:00' };

/** 16:00 New York (EDT) on a September 2026 day, and any New York wall time. */
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;
const nyMs = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour + 4, minute);
const NVDA_AM = nyMs(15, 4, 30);
const TSLA_AM = nyMs(17, 4, 30);

const cboeUrl = (root: string) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${root}.json`;
const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const TSLA_FEED: Address = '0x4A1166a659A55625345e9515b32adECea5547C38';
const NVDA_TOKEN = { chainId: 4663, address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address, uiMultiplier: '1000775159164630595' };
/** As the parity capture: no token, so provenance says `identity-unmapped`; prices do not read it. */
const MARKETS: ReadonlyMap<string, PricingMarket> = new Map([
  ['NVDA', { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: cboeUrl('NVDA') } }],
  ['TSLA', { ticker: 'TSLA', feed: TSLA_FEED, cboe: { root: 'TSLA', url: cboeUrl('TSLA') } }],
]);
const NVDA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_249n, answer: 21_221_000_000n, updatedAt: 1_789_416_000n, decimals: 8 };
const TSLA_ROUND: FeedRound = { roundId: 18_446_744_073_709_552_900n, answer: 36_020_000_000n, updatedAt: 1_789_588_800n, decimals: 8 };

interface ServiceOptions {
  nowMs: number;
  nvda?: CboeChain;
  tsla?: CboeChain;
  events?: EventCalendar;
  settings?: Partial<PricingSettings>;
  policy?: Partial<ShortMaturityPolicy>;
  rounds?: Partial<Record<Address, FeedRound>>;
}

function service(o: ServiceOptions): PricingService {
  const chains: Record<string, CboeChain> = { [cboeUrl('NVDA')]: o.nvda ?? NVDA, [cboeUrl('TSLA')]: o.tsla ?? TSLA };
  const rounds: Record<string, FeedRound> = { [NVDA_FEED]: NVDA_ROUND, [TSLA_FEED]: TSLA_ROUND, ...o.rounds } as Record<string, FeedRound>;
  return new PricingService({
    markets: MARKETS,
    nowMs: () => o.nowMs,
    spotReader: async (feed) => rounds[feed]!,
    chains: { fetchChain: async (url) => chains[url]! },
    ...(o.events === undefined ? {} : { events: o.events }),
    settings: { ...o.settings, ...(o.policy === undefined ? {} : { shortMaturity: { ...DEFAULT_SHORT_MATURITY_POLICY, ...o.policy } }) },
  });
}

const request = (ticker: string, strike: number, day: number, type: 'call' | 'put' = 'call'): FairRequest => ({
  ticker,
  strikeUsdg6: BigInt(Math.round(strike * 1e6)),
  expiry: closeOf(day),
  type,
});

function priced(outcome: FairOutcome): FairQuote {
  assert.ok(outcome.ok, `expected a price, got ${outcome.ok ? '' : `${outcome.reason} ${JSON.stringify(outcome.detail)}`}`);
  return outcome;
}

function bounds(q: FairQuote) {
  const u = q.provenance.quality.uncertainty;
  assert.ok(u !== null, `${q.method} ${q.days.join(',')}: expected bounds`);
  return { ivLow: u.ivLow!, ivHigh: u.ivHigh!, fairLow: u.fairLowUsdg6!, fairHigh: u.fairHighUsdg6! };
}

const reasons = (q: FairQuote) => q.provenance.quality.reasons;

/** Every invariant a priced answer must keep, whatever the input. */
function assertInvariants(q: FairQuote, what: string): void {
  const { readiness, reasons: rs, uncertainty: u } = q.provenance.quality;
  if (readiness === 'ready') assert.ok(rs.length === 0 && u === null, `${what}: ready with ${rs.join(',')} / ${JSON.stringify(u, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
  if (rs.length > 0 || u !== null) assert.notEqual(readiness, 'ready', `${what}: never ready with a reason or a bound`);
  if (u !== null) {
    assert.ok(rs.length > 0, `${what}: a bound always comes with a reason`);
    assert.ok(u.ivLow! <= q.iv && q.iv <= u.ivHigh!, `${what}: iv ${q.iv} outside [${u.ivLow}, ${u.ivHigh}]`);
    assert.ok(u.fairLowUsdg6! <= q.fairUsdg6 && q.fairUsdg6 <= u.fairHighUsdg6!, `${what}: fair ${q.fairUsdg6} outside [${u.fairLowUsdg6}, ${u.fairHighUsdg6}]`);
  }
  // A listed label only on the exact listed contract; an event realized since the surface leaves it listed (and degraded).
  if (q.provenance.method !== 'listed') assert.equal(q.source, 'model', `${what}: never a listed label on a read that is not the listed contract`);
}

/** Synthetic events around the fixtures (not real earnings dates). */
const PARITY_EVENTS = eventCalendar({
  NVDA: [
    { date: '2026-09-16', kind: 'earnings', timing: 'amc' },
    { date: '2026-09-22', kind: 'other', timing: null },
  ],
  TSLA: [{ date: '2026-09-17', kind: 'earnings', timing: 'amc' }],
});

/*//////////////////////////////////////////////////////////////
                               PARITY
//////////////////////////////////////////////////////////////*/

const SCENARIOS: Record<ParityScenario, { nowMs: number; tsla: CboeChain }> = {
  'nvda-am': { nowMs: NVDA_AM, tsla: TSLA },
  'nvda-pm': { nowMs: nyMs(15, 15), tsla: TSLA },
  'tsla-am': { nowMs: TSLA_AM, tsla: TSLA },
  'tsla-fri': { nowMs: nyMs(18, 10), tsla: TSLA_THURSDAY },
};

async function replayParity(events?: EventCalendar, policy?: Partial<ShortMaturityPolicy>): Promise<Array<[(typeof PRICING_PARITY_CASES)[number], FairOutcome]>> {
  const services = new Map<ParityScenario, PricingService>();
  const out: Array<[(typeof PRICING_PARITY_CASES)[number], FairOutcome]> = [];
  for (const c of PRICING_PARITY_CASES) {
    const [scenario, ticker, strike, day, type] = c;
    let svc = services.get(scenario);
    if (svc === undefined) {
      svc = service({ nowMs: SCENARIOS[scenario].nowMs, tsla: SCENARIOS[scenario].tsla, ...(events === undefined ? {} : { events }), ...(policy === undefined ? {} : { policy }) });
      services.set(scenario, svc);
    }
    out.push([c, await svc.fair(request(ticker, Number(strike), day, type))]);
  }
  return out;
}

const round6 = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

test('parity: with no event input every pinned base answer is reproduced exactly, and the legacy /fair body with it', async () => {
  assert.equal(PRICING_PARITY_CASES.length, 284);
  const methods = new Set(PRICING_PARITY_CASES.map((c) => c[9]));
  assert.deepEqual([...methods].sort(), ['flat-after-last', 'flat-before-first', 'listed-contract', 'listed-expiry', 'total-variance'], 'the grid covers every method');
  for (const [c, outcome] of await replayParity()) {
    const [scenario, ticker, strike, day, type, fair, iv, delta, source, method, asOf] = c;
    const what = `${scenario} ${ticker} ${strike} ${day} ${type}`;
    const q = priced(outcome);
    assert.equal(String(q.fairUsdg6), fair, `${what}: fair`);
    assert.ok(Object.is(q.iv, iv), `${what}: iv ${q.iv} vs ${iv}`);
    assert.ok(Object.is(q.delta, delta), `${what}: delta ${q.delta} vs ${delta}`);
    assert.deepEqual([q.source, q.method, q.asOf], [source, method, asOf], what);
    const spot = ticker === 'NVDA' ? 212_210_000n : 360_200_000n;
    const body = fairResponse(q).body;
    assert.deepEqual(Object.keys(body), ['fair', 'iv', 'delta', 'source', 'spot', 'asOf'], `${what}: legacy keys only`);
    assert.deepEqual(body, { fair: money(BigInt(fair)), iv: round6(iv), delta: round6(delta), source, spot: money(spot), asOf }, what);
    assertInvariants(q, what);
  }
});

test('parity: event input and a tighter policy change bounds, reasons and readiness only, never the point', async () => {
  const plain = await replayParity();
  for (const [events, policy] of [
    [PARITY_EVENTS, undefined],
    [eventCalendar({ NVDA: [], TSLA: [] }), { maxEventVariance: null, gapVariance: 0.001 }],
  ] as const) {
    const withEvents = await replayParity(events, policy);
    let changed = 0;
    withEvents.forEach(([c, outcome], i) => {
      const what = c.slice(0, 5).join(' ');
      const q = priced(outcome);
      const p = priced(plain[i]![1]);
      assert.deepEqual([q.fairUsdg6, q.iv, q.delta, q.source, q.method, q.asOf, q.spotUsdg6], [p.fairUsdg6, p.iv, p.delta, p.source, p.method, p.asOf, p.spotUsdg6], what);
      assert.deepEqual(fairResponse(q).body, fairResponse(p).body, `${what}: the /fair body is byte-for-byte the same`);
      if (JSON.stringify(reasons(q)) !== JSON.stringify(reasons(p))) changed += 1;
      assertInvariants(q, what);
    });
    assert.ok(changed > 0, 'the event input did reach the diagnostics');
  }
});

test('parity over HTTP: a before-first /fair body is the same text with or without event input; provenance is not serialized', async () => {
  const path = `/fair?ticker=NVDA&strike=215000000&expiry=${closeOf(16)}&type=call`;
  const a = await createPricingApp(service({ nowMs: NVDA_AM })).request(path);
  const b = await createPricingApp(service({ nowMs: NVDA_AM, events: PARITY_EVENTS })).request(path);
  const text = await a.text();
  assert.equal(a.status, 200);
  assert.equal(await b.text(), text);
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['fair', 'iv', 'delta', 'source', 'spot', 'asOf']);
  assert.ok(!/provenance|uncertainty|diagnostics|event/.test(text));
});

/*//////////////////////////////////////////////////////////////
                     EARNINGS: INCLUDED VS EXCLUDED
//////////////////////////////////////////////////////////////*/

test('earnings included vs excluded: the bound moves up for an included event, down for an excluded one, both for an unknown timing', async () => {
  // NVDA at 04:30 Tuesday 15 Sep; its first listing is Friday 18 Sep. Supplied input with no event
  // leaves only the gap and term-structure allowance.
  const none = service({ nowMs: NVDA_AM, events: eventCalendar({ NVDA: [] }) });
  const at = (timing: 'bmo' | 'amc' | null, date = '2026-09-16') => service({ nowMs: NVDA_AM, events: eventCalendar({ NVDA: [{ date, kind: 'earnings', timing }] }) });
  for (const type of ['call', 'put'] as const) {
    // After the close on the 16th: excluded from the 16th's expiry, included in the 17th's.
    const base16 = priced(await none.fair(request('NVDA', 215, 16, type)));
    const base17 = priced(await none.fair(request('NVDA', 215, 17, type)));
    assert.deepEqual(reasons(base16).filter((r) => r.endsWith('uncertainty')), []);
    const excluded = priced(await at('amc').fair(request('NVDA', 215, 16, type)));
    const included = priced(await at('amc').fair(request('NVDA', 215, 17, type)));
    for (const [q, base] of [[excluded, base16], [included, base17]] as const) {
      assert.deepEqual([q.fairUsdg6, q.iv, q.method], [base.fairUsdg6, base.iv, base.method], 'the point is the flat read');
      assert.ok(reasons(q).includes('extrapolated') && reasons(q).includes('event-uncertainty'));
    }
    assert.deepEqual(excluded.diagnostics.events.map((e) => e.placement), ['after-window']);
    assert.equal(bounds(excluded).ivHigh, bounds(base16).ivHigh, 'an excluded event adds no upside');
    assert.ok(bounds(excluded).ivLow < bounds(base16).ivLow && bounds(excluded).fairLow < bounds(base16).fairLow, 'an excluded event may have inflated the front vol');
    assert.deepEqual(included.diagnostics.events.map((e) => e.placement), ['inside-window']);
    assert.equal(bounds(included).ivLow, bounds(base17).ivLow, 'an included event takes nothing away');
    assert.ok(bounds(included).ivHigh > bounds(base17).ivHigh && bounds(included).fairHigh > bounds(base17).fairHigh, 'an included event may carry more than its share');

    // Before the open on the 16th: included in the 16th's own expiry.
    const bmo = priced(await at('bmo').fair(request('NVDA', 215, 16, type)));
    assert.deepEqual(bmo.diagnostics.events.map((e) => e.placement), ['inside-window']);
    assert.ok(bounds(bmo).ivHigh > bounds(base16).ivHigh);
    // Unknown timing on the expiry day: either side of the close.
    const unknown = priced(await at(null).fair(request('NVDA', 215, 16, type)));
    assert.deepEqual(unknown.diagnostics.events.map((e) => e.placement), ['straddles-expiry']);
    assert.ok(bounds(unknown).ivHigh > bounds(base16).ivHigh && bounds(unknown).ivLow < bounds(base16).ivLow);
    // After the first listing: identified by it, nothing to add to a read before it.
    const later = priced(await at('bmo', '2026-09-21').fair(request('NVDA', 215, 16, type)));
    assert.deepEqual(later.diagnostics.events.map((e) => e.placement), ['outside-segment']);
    assert.deepEqual(later.provenance.quality.uncertainty, base16.provenance.quality.uncertainty);
    assert.deepEqual(reasons(later), reasons(base16));
  }
});

test('eventWindow: bmo lands before the open, amc after the close, unknown timing anywhere that day (New York)', () => {
  const day = (hour: number, minute = 0) => nyMs(16, hour, minute) / 1000;
  assert.deepEqual(eventWindow({ date: '2026-09-16', kind: 'earnings', timing: 'bmo' }), { from: day(0), to: day(9, 30) });
  assert.deepEqual(eventWindow({ date: '2026-09-16', kind: 'earnings', timing: 'amc' }), { from: day(16), to: nyMs(17, 0) / 1000 });
  assert.deepEqual(eventWindow({ date: '2026-09-16', kind: 'earnings', timing: null }), { from: day(0), to: nyMs(17, 0) / 1000 });
  // Across the DST switch the New York midnights are still New York's.
  const nov = eventWindow({ date: '2026-11-01', kind: 'earnings', timing: null });
  assert.equal(nov.to - nov.from, 25 * 3_600, 'the fall-back day is 25 hours long');
});

test('an event realized since the surface (after its close, before now) bounds every read down, listed ones included', async () => {
  // Monday 14 Sep after the close: after the chain's last trade, before Tuesday 04:30.
  const events = eventCalendar({ NVDA: [{ date: '2026-09-14', kind: 'earnings', timing: 'amc' }] });
  const plain = service({ nowMs: NVDA_AM, events: eventCalendar({ NVDA: [] }) });
  const svc = service({ nowMs: NVDA_AM, events });
  for (const [strike, day, method] of [[220, 18, 'listed-contract'], [221, 18, 'listed-expiry'], [231, 21, 'total-variance']] as const) {
    const q = priced(await svc.fair(request('NVDA', strike, day)));
    const p = priced(await plain.fair(request('NVDA', strike, day)));
    assert.equal(q.method, method);
    assert.equal(q.fairUsdg6, p.fairUsdg6);
    assert.equal(p.provenance.quality.uncertainty, null, `${method}: no bound without the event`);
    assert.deepEqual(q.diagnostics.events.map((e) => e.placement), ['realized-since-surface']);
    assert.ok(reasons(q).includes('event-uncertainty'));
    const b = bounds(q);
    assert.equal(b.ivHigh, q.iv, 'down only: the jump is no longer ahead');
    assert.ok(b.ivLow < q.iv && b.fairLow < q.fairUsdg6);
    assertInvariants(q, method);
  }
});

/*//////////////////////////////////////////////////////////////
                    THE FIRST LISTED EXPIRY AND INPUT
//////////////////////////////////////////////////////////////*/

test('first listed expiry: it identifies the event before it; approaching it, the unknown-event upside shrinks to nothing', async () => {
  const events = eventCalendar({ NVDA: [{ date: '2026-09-17', kind: 'earnings', timing: 'bmo' }] });
  const svc = service({ nowMs: NVDA_AM, events });
  // On the first listing: the listed quotes carry the event.
  for (const strike of [215, 216]) {
    const q = priced(await svc.fair(request('NVDA', strike, 18)));
    assert.ok(q.method === 'listed-contract' || q.method === 'listed-expiry');
    assert.equal(q.provenance.quality.uncertainty, null);
    assert.ok(!reasons(q).includes('event-uncertainty'));
    assert.deepEqual(q.diagnostics.events.map((e) => e.placement), ['outside-segment']);
  }
  // Just before it: the event is after the 16th's expiry, inside the 17th's.
  const d16 = priced(await svc.fair(request('NVDA', 215, 16)));
  const d17 = priced(await svc.fair(request('NVDA', 215, 17)));
  assert.equal(d16.method, 'flat-before-first');
  assert.deepEqual([d16.diagnostics.events[0]!.placement, d17.diagnostics.events[0]!.placement], ['after-window', 'inside-window']);
  assert.equal(d16.diagnostics.segment?.to, closeOf(18));

  // No event input: the assumed event's upside is ω(1 − f), shrinking as the expiry nears the listing.
  const missing = service({ nowMs: NVDA_AM });
  const ups: number[] = [];
  const fractions: number[] = [];
  for (const day of [15, 16, 17]) {
    const q = priced(await missing.fair(request('NVDA', 215, day)));
    ups.push(q.diagnostics.components.eventUp * q.diagnostics.segment!.fraction);
    fractions.push(q.diagnostics.segment!.fraction);
    assertInvariants(q, `missing ${day}`);
  }
  assert.ok(fractions[0]! < fractions[1]! && fractions[1]! < fractions[2]! && fractions[2]! < 1);
  assert.ok(ups[0]! > ups[1]! && ups[1]! > ups[2]! && ups[2]! > 0, `upside ${ups.join(' > ')}`);
  assert.equal(priced(await missing.fair(request('NVDA', 215, 18))).provenance.quality.uncertainty, null);
});

test('missing event input: absent, for another ticker only, or stopping short of the first listing is event-uncertain; policy may waive it', async () => {
  const req = request('NVDA', 215, 16);
  const cases: Array<[string, EventCalendar | undefined, 'missing' | 'short' | 'supplied']> = [
    ['no calendar', undefined, 'missing'],
    ['TSLA only', eventCalendar({ TSLA: [] }), 'missing'],
    ['through the 16th', eventCalendar({ NVDA: { events: [], through: '2026-09-16' } }), 'short'],
    ['through the 18th', eventCalendar({ NVDA: { events: [], through: '2026-09-18' } }), 'supplied'],
    ['no stated limit', eventCalendar({ NVDA: [] }), 'supplied'],
  ];
  for (const [what, events, input] of cases) {
    const q = priced(await service({ nowMs: NVDA_AM, ...(events === undefined ? {} : { events }) }).fair(req));
    assert.equal(q.diagnostics.eventInput, input, what);
    assert.equal(reasons(q).includes('event-uncertainty'), input !== 'supplied', what);
    assertInvariants(q, what);
  }
  const missing = priced(await service({ nowMs: NVDA_AM }).fair(req));
  assert.deepEqual(reasons(missing).slice(-3), ['extrapolated', 'event-uncertainty', 'model-uncertainty']);
  const waived = priced(await service({ nowMs: NVDA_AM, policy: { requireEventInput: false } }).fair(req));
  assert.ok(!reasons(waived).includes('event-uncertainty'));
  assert.ok(reasons(waived).includes('extrapolated'), 'still an extrapolation');
  // Listed and bracketed reads never need the input.
  for (const [strike, day] of [[220, 18], [231, 21]] as const) {
    const q = priced(await service({ nowMs: NVDA_AM }).fair(request('NVDA', strike, day)));
    assert.equal(q.provenance.quality.uncertainty, null);
    assert.ok(!reasons(q).includes('event-uncertainty'));
  }
});

test('model uncertainty: bounded by default, refused by a refuse policy, with the reasons in the refusal', async () => {
  const req = request('NVDA', 215, 16);
  const bounded = priced(await service({ nowMs: NVDA_AM }).fair(req));
  assert.ok(bounded.diagnostics.relativeIvWidth! > DEFAULT_SHORT_MATURITY_POLICY.maxRelativeIvWidth);
  assert.ok(reasons(bounded).includes('model-uncertainty'));
  const strict = service({ nowMs: NVDA_AM, policy: { onModelUncertainty: 'refuse' } });
  const refusal = await strict.fair(req);
  assert.ok(!refusal.ok);
  assert.equal(refusal.reason, 'model-uncertainty');
  assert.equal(refusal.detail.reasons, 'event-uncertainty,model-uncertainty');
  assert.equal(refusal.detail.method, 'flat-before-first');
  assert.equal(refusal.detail.eventInput, 'missing');
  const http = await createPricingApp(strict).request(`/fair?ticker=NVDA&strike=215000000&expiry=${closeOf(16)}&type=call`);
  assert.equal(http.status, 200);
  const body = (await http.json()) as Record<string, unknown>;
  assert.deepEqual([body.fair, body.reason], [null, 'model-uncertainty']);
  // Narrow enough reads still price under the refuse policy: supplied input, and every listed read.
  const narrow = service({ nowMs: NVDA_AM, events: eventCalendar({ NVDA: [] }), policy: { onModelUncertainty: 'refuse' } });
  const q = priced(await narrow.fair(req));
  assert.ok(q.diagnostics.relativeIvWidth! <= DEFAULT_SHORT_MATURITY_POLICY.maxRelativeIvWidth);
  priced(await strict.fair(request('NVDA', 220, 18)));
  priced(await strict.fair(request('NVDA', 231, 21)));
});

/*//////////////////////////////////////////////////////////////
                    OVERNIGHT, WEEKEND, HOLIDAY, EARLY CLOSE
//////////////////////////////////////////////////////////////*/

const without = (chain: CboeChain, ...days: string[]): CboeChain => ({ ...chain, options: chain.options.filter((o) => !days.includes(o.expiry)) });

test('overnight and weekend: the gap allowance counts close-to-open gaps and closed days in the window', async () => {
  // Friday 18 Sep 10:00 with the Thursday TSLA file; the 18th and 21st delisted: the first listing is Wednesday 23.
  const svc = service({ nowMs: nyMs(18, 10), tsla: without(TSLA_THURSDAY, '2026-09-18', '2026-09-21'), events: eventCalendar({ TSLA: [] }) });
  const friday = priced(await svc.fair(request('TSLA', 361, 18)));
  const monday = priced(await svc.fair(request('TSLA', 361, 21)));
  const tuesday = priced(await svc.fair(request('TSLA', 361, 22)));
  for (const q of [friday, monday, tuesday]) assert.equal(q.method, 'flat-before-first');
  assert.deepEqual([friday.diagnostics.clock.gaps, friday.diagnostics.clock.closedDays], [0, 0], 'the rest of today: no gap');
  assert.deepEqual([monday.diagnostics.clock.gaps, monday.diagnostics.clock.closedDays], [1, 2], 'one weekend gap, two closed days');
  assert.deepEqual([tuesday.diagnostics.clock.gaps, tuesday.diagnostics.clock.closedDays], [2, 2]);
  assert.equal(friday.diagnostics.components.gap, 0);
  const p = DEFAULT_SHORT_MATURITY_POLICY;
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
  close(monday.diagnostics.components.gap, (p.gapVariance + 2 * p.closedDayVariance) / monday.yearsToExpiry);
  close(tuesday.diagnostics.components.gap, (2 * p.gapVariance + 2 * p.closedDayVariance) / tuesday.yearsToExpiry);
  assert.ok(bounds(monday).ivHigh - monday.iv > bounds(friday).ivHigh - friday.iv, 'a weekend widens more than the rest of a session');
  for (const q of [friday, monday, tuesday]) assertInvariants(q, q.days.join());
});

test('holiday: Labor Day is a closed day in the window, not a session; a series on it has no session left', async () => {
  // Saturday 5 Sep noon, the NVDA file re-dated to Friday 4 Sep's close; the first listing is the 18th.
  const round: FeedRound = { ...NVDA_ROUND, updatedAt: BigInt(Date.UTC(2026, 8, 4, 20) / 1000) };
  const nowMs = nyMs(5, 12);
  const events = eventCalendar({ NVDA: [] });
  const withHoliday = service({ nowMs, nvda: NVDA_LABOR_DAY, rounds: { [NVDA_FEED]: round }, events });
  const noHoliday = service({ nowMs, nvda: NVDA_LABOR_DAY, rounds: { [NVDA_FEED]: round }, events, settings: { holidays: NYSE_HOLIDAYS_2026_2028.filter((d) => d !== '2026-09-07') } });
  const tue = priced(await withHoliday.fair(request('NVDA', 215, 8)));
  const tueNoHoliday = priced(await noHoliday.fair(request('NVDA', 215, 8)));
  assert.equal(tue.method, 'flat-before-first');
  assert.deepEqual([tue.diagnostics.clock.gaps, tue.diagnostics.clock.closedDays, tue.diagnostics.clock.sessionSeconds], [1, 2, 23_400]);
  assert.deepEqual([tueNoHoliday.diagnostics.clock.gaps, tueNoHoliday.diagnostics.clock.closedDays, tueNoHoliday.diagnostics.clock.sessionSeconds], [2, 1, 2 * 23_400]);
  assert.ok(tue.fairUsdg6 < tueNoHoliday.fairUsdg6, 'one session of time value, not two');
  assertInvariants(tue, 'labor day');
  // A series expiring on the holiday itself.
  const onHoliday = await withHoliday.fair(request('NVDA', 215, 7));
  assert.ok(!onHoliday.ok && onHoliday.reason === 'expired');
  assert.match(onHoliday.ok ? '' : onHoliday.detail.why ?? '', /no regular session remains/);
  priced(await noHoliday.fair(request('NVDA', 215, 7)));
});

test('early close (synthetic day): flagged and bounded down on any read in the window; the point is unchanged; none left is expired', async () => {
  const early = service({ nowMs: NVDA_AM, events: eventCalendar({ NVDA: [] }), settings: { earlyCloses: ['2026-09-16'] } });
  const plain = service({ nowMs: NVDA_AM, events: eventCalendar({ NVDA: [] }) });
  for (const [strike, day] of [[215, 16], [215, 17], [220, 18], [231, 21]] as const) {
    const q = priced(await early.fair(request('NVDA', strike, day)));
    const p = priced(await plain.fair(request('NVDA', strike, day)));
    assert.deepEqual([q.fairUsdg6, q.iv, q.method], [p.fairUsdg6, p.iv, p.method]);
    assert.ok(reasons(q).includes('clock-early-close'), `${day}: flagged`);
    assert.equal(q.diagnostics.clock.earlyCloseLostSeconds, 3 * 3_600);
    assert.ok(q.diagnostics.components.earlyCloseDown > 0);
    assert.ok(bounds(q).ivLow < q.iv);
    assertInvariants(q, `early close ${day}`);
  }
  // Before the early-close day: nothing.
  const before = priced(await early.fair(request('NVDA', 215, 15)));
  assert.ok(!reasons(before).includes('clock-early-close'));
  // Thursday 17 Sep 14:00 with a (synthetic) 13:00 close that day: the 17th's expiry has no session left.
  const late = await service({ nowMs: nyMs(17, 14), settings: { earlyCloses: ['2026-09-17'] } }).fair(request('TSLA', 361, 17));
  assert.ok(!late.ok && late.reason === 'expired');
  assert.match(late.ok ? '' : late.detail.why ?? '', /after the early close/);
});

test('clock refusals through the service: after the close, a same-evening or Saturday expiry has no session left', async () => {
  // Tuesday 15 Sep 17:00: the Monday NVDA file is still the latest settled session's.
  const tuesdayEvening = service({ nowMs: nyMs(15, 17) });
  const evening = await tuesdayEvening.fair({ ...request('NVDA', 215, 15), expiry: nyMs(15, 18) / 1000 });
  assert.ok(!evening.ok && evening.reason === 'expired');
  // Friday 18 Sep 17:00 with the Thursday TSLA file: a Saturday 16:00 expiry.
  const saturday = await service({ nowMs: nyMs(18, 17), tsla: TSLA_THURSDAY }).fair(request('TSLA', 361, 19));
  assert.ok(!saturday.ok && saturday.reason === 'expired');
  assert.match(saturday.ok ? '' : saturday.detail.why ?? '', /no regular session remains before the expiry/);
  // The Monday expiry from the same evening still prices.
  priced(await service({ nowMs: nyMs(18, 17), tsla: TSLA_THURSDAY }).fair(request('TSLA', 361, 21)));
});

/*//////////////////////////////////////////////////////////////
                      A CHANGED LISTING CALENDAR
//////////////////////////////////////////////////////////////*/

test('changed listing calendar: when the first listing moves, the same series moves between bracketed and before-first', async () => {
  const events = eventCalendar({ NVDA: [{ date: '2026-09-22', kind: 'earnings', timing: 'amc' }] });
  const listed = service({ nowMs: NVDA_AM, events });
  const moved = service({ nowMs: NVDA_AM, nvda: without(NVDA, '2026-09-18'), events });
  const a = priced(await listed.fair(request('NVDA', 231, 21)));
  const b = priced(await moved.fair(request('NVDA', 231, 21)));
  assert.equal(a.method, 'total-variance');
  assert.equal(a.provenance.method, 'interpolated');
  assert.deepEqual(a.diagnostics.segment && [a.diagnostics.segment.kind, a.diagnostics.segment.from, a.diagnostics.segment.to], ['bracketed', closeOf(18), closeOf(25)]);
  assert.equal(b.method, 'flat-before-first');
  assert.equal(b.provenance.method, 'extrapolated');
  assert.deepEqual(b.provenance.contributingExpiries, [closeOf(25)]);
  assert.deepEqual(b.diagnostics.segment && [b.diagnostics.segment.kind, b.diagnostics.segment.to], ['before-first', closeOf(25)]);
  // The event after the 21st's close, before the 25th: after the window either way, bounded down.
  for (const q of [a, b]) {
    assert.deepEqual(q.diagnostics.events.map((e) => e.placement), ['after-window']);
    assert.ok(reasons(q).includes('event-uncertainty'));
    assert.ok(bounds(q).ivLow < q.iv);
    assertInvariants(q, q.method);
  }
  assert.equal(bounds(a).ivHigh, a.iv, 'a bracketed read with an excluded event gains no upside');
  // Without the event the bracketed read is identified; the moved one is still an extrapolation.
  const quiet = eventCalendar({ NVDA: [] });
  assert.equal(priced(await service({ nowMs: NVDA_AM, events: quiet }).fair(request('NVDA', 231, 21))).provenance.quality.uncertainty, null);
  assert.ok(reasons(priced(await service({ nowMs: NVDA_AM, nvda: without(NVDA, '2026-09-18'), events: quiet }).fair(request('NVDA', 231, 21)))).includes('extrapolated'));

  // TSLA: the 18th listed, then delisted; the 17th's segment ends at whichever listing is first.
  const t17 = priced(await service({ nowMs: TSLA_AM }).fair(request('TSLA', 361, 17)));
  const t17moved = priced(await service({ nowMs: TSLA_AM, tsla: without(TSLA, '2026-09-18') }).fair(request('TSLA', 361, 17)));
  assert.deepEqual([t17.diagnostics.segment?.to, t17moved.diagnostics.segment?.to], [closeOf(18), closeOf(21)]);
  assert.ok(t17moved.diagnostics.segment!.fraction < t17.diagnostics.segment!.fraction);
  const t18 = priced(await service({ nowMs: TSLA_AM, tsla: without(TSLA, '2026-09-18') }).fair(request('TSLA', 361, 18)));
  assert.equal(t18.method, 'flat-before-first');
  assert.ok(reasons(t18).includes('event-uncertainty'));
});

/*//////////////////////////////////////////////////////////////
                      BOUNDS: SHAPE AND MONOTONICITY
//////////////////////////////////////////////////////////////*/

test('bounds nest as the policy loosens, and contain the point everywhere', async () => {
  const req = request('NVDA', 215, 16, 'put');
  const loosening: Array<Partial<ShortMaturityPolicy>> = [
    { maxEventVariance: 0, gapVariance: 0, closedDayVariance: 0, termStructureMultiplier: 0 },
    { maxEventVariance: 0.0001 },
    { maxEventVariance: 0.001 },
    { maxEventVariance: 0.0144 },
    { maxEventVariance: null },
    { maxEventVariance: null, gapVariance: 0.001 },
    { maxEventVariance: null, gapVariance: 0.001, termStructureMultiplier: 5 },
  ];
  let previous: ReturnType<typeof bounds> | null = null;
  for (const policy of loosening) {
    const q = priced(await service({ nowMs: NVDA_AM, policy }).fair(req));
    const b = bounds(q);
    assertInvariants(q, JSON.stringify(policy));
    if (previous !== null) {
      assert.ok(b.ivLow <= previous.ivLow && b.ivHigh >= previous.ivHigh, `${JSON.stringify(policy)}: iv bounds nest`);
      assert.ok(b.fairLow <= previous.fairLow && b.fairHigh >= previous.fairHigh, `${JSON.stringify(policy)}: fair bounds nest`);
    }
    previous = b;
  }
  // With every allowance at zero and supplied input the bound collapses onto the point.
  const zero = priced(await service({ nowMs: NVDA_AM, events: eventCalendar({ NVDA: [] }), policy: loosening[0] }).fair(req));
  assert.deepEqual([bounds(zero).ivLow, bounds(zero).ivHigh], [zero.iv, zero.iv]);
  assert.deepEqual([bounds(zero).fairLow, bounds(zero).fairHigh], [zero.fairUsdg6, zero.fairUsdg6]);
  assert.deepEqual(reasons(zero).slice(-1), ['extrapolated'], 'still an extrapolation, so still not ready');

  // Every before-first read of the grid, with and without input: ordered bounds, in the vol band.
  for (const events of [undefined, PARITY_EVENTS]) {
    for (const [c, outcome] of await replayParity(events)) {
      const q = priced(outcome);
      assertInvariants(q, c.slice(0, 5).join(' '));
      if (q.method === 'flat-before-first') {
        const b = bounds(q);
        assert.ok(b.ivLow >= 0.01 && b.ivHigh <= 5);
      }
    }
  }
});

/*//////////////////////////////////////////////////////////////
                  READINESS WITH A FRESH LISTED PROVIDER
//////////////////////////////////////////////////////////////*/

test('readiness: with a fresh listed provider a listed read is ready, and any bound or uncertainty reason makes a read degraded', async () => {
  const asOf = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
  const base = cboeToNormalized(NVDA, 0);
  const listed: NormalizedChain = fakeListedChain(base, { quoteObservedAt: asOf, underlyingObservedAt: asOf, publishedAt: base.clocks.publishedAt });
  const markets: ReadonlyMap<string, PricingMarket> = new Map([['NVDA', { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: cboeUrl('NVDA') }, token: NVDA_TOKEN }]]);
  const svc = (events?: EventCalendar, earlyCloses: readonly string[] = []) =>
    new PricingService({
      markets,
      nowMs: () => NVDA_AM,
      spotReader: chainSpotReader(listed, asOf),
      chains: { provider: createFakeProvider(FAKE_LISTED_PROVIDER, { NVDA: listed }) },
      ...(events === undefined ? {} : { events }),
      settings: { earlyCloses },
    });
  const quiet = eventCalendar({ NVDA: [] });

  const ready = priced(await svc(quiet).fair(request('NVDA', 220, 18)));
  assert.deepEqual([ready.provenance.quality.readiness, reasons(ready), ready.provenance.quality.uncertainty], ['ready', [], null]);
  const bracketed = priced(await svc(quiet).fair(request('NVDA', 231, 21)));
  assert.deepEqual([bracketed.provenance.quality.readiness, reasons(bracketed)], ['ready', []]);

  const cases: Array<[string, FairOutcome, string[]]> = [
    ['before-first, input supplied', await svc(quiet).fair(request('NVDA', 215, 16)), ['extrapolated']],
    ['before-first, no input', await svc().fair(request('NVDA', 215, 16)), ['extrapolated', 'event-uncertainty', 'model-uncertainty']],
    ['bracketed, event inside', await svc(eventCalendar({ NVDA: [{ date: '2026-09-21', kind: 'earnings', timing: 'bmo' }] })).fair(request('NVDA', 231, 21)), ['event-uncertainty']],
    ['listed, early close', await svc(quiet, ['2026-09-16']).fair(request('NVDA', 220, 18)), ['clock-early-close']],
    ['listed, realized event', await svc(eventCalendar({ NVDA: [{ date: '2026-09-14', kind: 'earnings', timing: 'amc' }] })).fair(request('NVDA', 220, 18)), ['event-uncertainty']],
  ];
  for (const [what, outcome, expected] of cases) {
    const q = priced(outcome);
    for (const r of expected) assert.ok(reasons(q).includes(r), `${what}: ${reasons(q).join(',')} has ${r}`);
    assert.equal(q.provenance.quality.readiness, 'degraded', what);
    assert.notEqual(q.provenance.quality.uncertainty, null, what);
    assertInvariants(q, what);
  }

  // Never an observed daily vol: the before-first read names only the first listing's quotes.
  const daily = priced(cases[0]![1]);
  assert.deepEqual([daily.source, daily.provenance.method, daily.provenance.methodDetail], ['model', 'extrapolated', 'flat-before-first']);
  assert.deepEqual(daily.provenance.contributingExpiries, [closeOf(18)]);
  assert.ok(daily.provenance.identity.listed.length > 0 && daily.provenance.identity.listed.every((i) => i.expiryDay === '2026-09-18'));
  assert.equal(daily.provenance.expiryClock.basis, 'trading-time');
  assert.equal(daily.provenance.expiryClock.yearsToExpiry, daily.yearsToExpiry);
  assert.equal(daily.diagnostics.clock.surfaceFromSource, 'quote', 'the listed provider states a quote time: the surface runs from it');
});

/*//////////////////////////////////////////////////////////////
                           EVENT INPUT
//////////////////////////////////////////////////////////////*/

test('eventCalendar: validated, copied and sorted; every problem named', () => {
  const cal = eventCalendar({
    NVDA: [
      { date: '2026-09-22', kind: 'earnings', timing: 'amc' },
      { date: '2026-09-16', kind: 'other' },
    ],
    TSLA: { events: [], through: '2026-09-30' },
  });
  assert.deepEqual(cal.get('NVDA'), {
    events: [
      { date: '2026-09-16', kind: 'other', timing: null },
      { date: '2026-09-22', kind: 'earnings', timing: 'amc' },
    ],
    through: null,
  });
  assert.deepEqual(cal.get('TSLA'), { events: [], through: '2026-09-30' });
  assert.equal(cal.get('AAPL'), undefined, 'absent means no input');
  assert.throws(
    () =>
      eventCalendar({
        NVDA: [
          { date: '2026-02-30', kind: 'earnings', timing: 'bmo' },
          { date: '2026-09-16', kind: 'Earnings Call', timing: 'noon' },
        ],
        TSLA: { events: 'none' },
        AMD: { events: [], through: 'soon' },
      }),
    (e: Error) =>
      /NVDA\[0\]: date 2026-02-30/.test(e.message) &&
      /NVDA\[1\]: kind Earnings Call .*; timing noon/.test(e.message) &&
      /TSLA: not a list/.test(e.message) &&
      /AMD: through is not/.test(e.message),
  );
  assert.throws(() => eventCalendar([]), /not an object of tickers/);
});
