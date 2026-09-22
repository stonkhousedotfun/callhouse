/**
 * K3-304 replay: committed neutral fixtures and (env-gated) private Cboe fixtures through the
 * real PricingService onto the cranker's ladder (replay.ts). No network, no credential, no
 * provider contact; nothing private is committed.
 *
 *   neutral   listed quotes, vendor theoretical estimates, stale, empty, crossed and zero-bid
 *             books and missing timestamps, asserting method and every source clock are preserved
 *             (null stays null; a zero is a price, never "unavailable").
 *   ladder    the rungs the cranker maintains (steps.ts): weekly/daily closes from the NYSE
 *             calendar x ladderStrikes at the registry's strikeTick.
 *   private   PRICING_PRIVATE_FIXTURES_DIR=<dir outside the repo> replays real Cboe downloads;
 *             the test SKIPS with an explicit reason when the variable is unset, and is never
 *             reported as passing then.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

import { syntheticNvdaChain } from '../../fixtures/synthetic-chains.js';
import { cboeToNormalized } from './cboe.js';
import { bookState, type ChainRow, type NormalizedChain } from './chain.js';
import { createFakeProvider, fakeListedChain, fakeTheoreticalChain, withTheoretical } from './fake-provider.js';
import { PricingService, type FairOutcome, type FairQuote, type FairRequest } from './fair.js';
import { loadPricingRegistry, type PricingMarket } from './markets.js';
import {
  chainSpotReader,
  crankerLadderRungs,
  loadCboeFixtureDir,
  replayLadder,
  sessionCloseUnix,
  upcomingDailyCloses,
  upcomingWeeklyCloses,
} from './replay.js';
import { loadV2Registry, v2Markets } from '../registry.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const KEEPER_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const TIER1 = join(KEEPER_DIR, '..', 'ops', 'markets', 'tier1.json');

/**
 * The statuses the registry rows below are read at. These tests want a market's registry parameters (its
 * ladder, its expiries ahead and its strike tick), not its deployment state, and INTERFACE_VERSION 8's
 * ops/markets/tier1.json carries all 35 markets at `v2.status: "planned"` until the v8 deploy writes the
 * addresses back, so `live` alone selects nothing. (The row's v1 `status` is still `live`; it is the `v2`
 * block that is planned.) Widening here keeps the ladder pinned to the real registry instead of a copy.
 */
const LADDER_STATUSES = ['live', 'planned'] as const;

const NVDA = cboeToNormalized(syntheticNvdaChain(), 0);
const AS_OF = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const NOW_S = Date.UTC(2026, 8, 15, 8, 30) / 1000;
const closeOf = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;

const NVDA_FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const NVDA_TOKEN = { chainId: 4663, address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address, uiMultiplier: '1000775159164630595' };
const MARKETS: ReadonlyMap<string, PricingMarket> = new Map([
  ['NVDA', { ticker: 'NVDA', feed: NVDA_FEED, cboe: { root: 'NVDA', url: 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json' }, token: NVDA_TOKEN }],
]);

function serviceWith(chain: NormalizedChain, nowS = NOW_S): PricingService {
  return new PricingService({
    markets: MARKETS,
    nowMs: () => nowS * 1000,
    spotReader: chainSpotReader(chain, AS_OF),
    chains: { provider: createFakeProvider(chain.provider, { NVDA: chain }) },
  });
}

const request = (strike: number, expiry: number, type: 'call' | 'put' = 'call'): FairRequest => ({ ticker: 'NVDA', strikeUsdg6: BigInt(Math.round(strike * 1e6)), expiry, type });

function priced(outcome: FairOutcome): FairQuote {
  assert.ok(outcome.ok, `expected a price, got ${outcome.ok ? '' : `${outcome.reason} ${JSON.stringify(outcome.detail)}`}`);
  return outcome;
}

function refused(outcome: FairOutcome, reason: string): void {
  assert.ok(!outcome.ok, `expected a refusal (${reason}), got a price`);
  assert.equal(outcome.reason, reason);
}

/*//////////////////////////////////////////////////////////////
                    THE CRANKER'S LADDER, OFFLINE
//////////////////////////////////////////////////////////////*/

test('ladder: weekly and daily closes follow the NYSE calendar (Fridays walked back over holidays, session days ahead only)', () => {
  // NOW_S is Tuesday 2026-09-15 04:30 ET; the week's Friday close is still ahead.
  assert.deepEqual(
    upcomingWeeklyCloses(NOW_S, 2).map((t) => new Date(t * 1000).toISOString().slice(0, 10)),
    ['2026-09-18', '2026-09-25'],
  );
  assert.deepEqual(
    upcomingDailyCloses(NOW_S, 3).map((t) => new Date(t * 1000).toISOString().slice(0, 10)),
    ['2026-09-15', '2026-09-16', '2026-09-17'],
  );
  // After Friday's close the same week is no longer ahead.
  assert.deepEqual(
    upcomingWeeklyCloses(closeOf(18) + 1, 1).map((t) => new Date(t * 1000).toISOString().slice(0, 10)),
    ['2026-09-25'],
  );
  // 2026-11-26 (Thanksgiving) is a full-day holiday in the table; the day after is an early close, still a session day.
  const thanksgiving = Date.UTC(2026, 10, 25, 12) / 1000;
  const daily = upcomingDailyCloses(thanksgiving, 3).map((t) => new Date(t * 1000).toISOString().slice(0, 10));
  assert.deepEqual(daily, ['2026-11-25', '2026-11-27', '2026-11-30'], `the holiday is skipped: ${daily}`);
  // Good Friday 2026-07-03 is in the table: that week's close walks back to Thursday 2026-07-02.
  const july = upcomingWeeklyCloses(Date.UTC(2026, 6, 1, 12) / 1000, 1).map((t) => new Date(t * 1000).toISOString().slice(0, 10));
  assert.deepEqual(july, ['2026-07-02'], `the holiday Friday walks back to Thursday: ${july}`);
  assert.equal(sessionCloseUnix('2026-09-18'), closeOf(18));
});

test('ladder: the registry NVDA ladder is the cranker\'s: tenor rungs at the strike tick, ahead expiries only', () => {
  const market = v2Markets(loadV2Registry(TIER1), LADDER_STATUSES).find((m) => m.ticker === 'NVDA');
  assert.ok(market !== undefined, 'NVDA carries a v2 block in the committed registry');
  const rungs = crankerLadderRungs(NVDA, {
    ladder: market.v2.params.ladder,
    expiriesAhead: market.v2.params.expiriesAhead,
    strikeTick: market.v2.strikeTick,
    fromUnix: NOW_S,
  });
  const weekly = rungs.filter((r) => r.tenor === 'weekly');
  const daily = rungs.filter((r) => r.tenor === 'daily');
  assert.equal(weekly.length, market.v2.params.ladder.weekly.rungs * market.v2.params.expiriesAhead.weekly);
  assert.equal(daily.length, market.v2.params.ladder.daily.rungs * market.v2.params.expiriesAhead.daily);
  for (const rung of rungs) {
    assert.equal(rung.strike % market.v2.strikeTick, 0n, `rung ${rung.strike} is on the ${market.v2.strikeTick} tick`);
    assert.ok(rung.expiry > NOW_S, 'only expiries ahead of now');
    assert.equal(rung.strike, rung.strike / 100n * 100n, 'a multiple of PRICE_TICK');
  }
  // Spot 212.35: the first weekly rung is roundUp(spot x 1.02, 2.5) = 217.5, a strike the chain lists on 09-18.
  assert.equal(weekly[0]!.strike, 217_500_000n);
  assert.equal(weekly[0]!.expiry, closeOf(18));
});

/*//////////////////////////////////////////////////////////////
                    NEUTRAL REPLAY: METHOD + CLOCKS
//////////////////////////////////////////////////////////////*/

test('replay: the real NVDA ladder prices through the seam; the listed rung is listed, source cboe', async () => {
  const market = v2Markets(loadV2Registry(TIER1), LADDER_STATUSES).find((m) => m.ticker === 'NVDA');
  assert.ok(market !== undefined, 'NVDA carries a v2 block in the committed registry');
  const rungs = crankerLadderRungs(NVDA, {
    ladder: market.v2.params.ladder,
    expiriesAhead: market.v2.params.expiriesAhead,
    strikeTick: market.v2.strikeTick,
    fromUnix: NOW_S,
  });
  const outcomes = await replayLadder(serviceWith(NVDA), 'NVDA', rungs);
  assert.equal(outcomes.length, rungs.length);
  for (const row of outcomes) {
    const what = row.result.ok ? `${row.result.method} ${String(row.result.fairUsdg6)}` : row.result.reason;
    assert.ok(!('reason' in row.result && row.result.reason.startsWith('threw:')), `rung ${row.tenor} ${row.expiry} ${String(row.strike)} never throws: ${what}`);
  }
  const listed = outcomes.filter((r) => r.result.ok && r.result.method === 'listed-contract');
  assert.ok(listed.length >= 1, 'at least one rung is the exact listed contract');
  for (const row of listed) {
    if (!row.result.ok) continue;
    assert.equal(row.result.source, 'cboe', 'a Cboe exact listed contract keeps source cboe');
  }
});

test('clocks: a stated quote time is kept and aged; Cboe\'s missing quote time stays null', async () => {
  // The Cboe file states no quote time: null in, null out, and the method is still listed.
  const cboe = priced(await serviceWith(NVDA).fair(request(220, closeOf(18))));
  assert.equal(cboe.provenance.method, 'listed');
  assert.equal(cboe.provenance.clocks.quoteObservedAt, null, 'Cboe gives no quote time: never guessed');
  assert.equal(cboe.provenance.ages.quoteS, null);
  assert.equal(cboe.provenance.clocks.underlyingObservedAt, NVDA.underlying.observedAt);

  // A listed provider that states one: kept verbatim, aged from it, ready when everything is fresh.
  const quoted = fakeListedChain(NVDA, { quoteObservedAt: AS_OF });
  const q = priced(await serviceWith(quoted).fair(request(220, closeOf(18))));
  assert.equal(q.provenance.method, 'listed');
  assert.equal(q.provenance.clocks.quoteObservedAt, AS_OF, 'the provider quote time is kept');
  assert.equal(q.provenance.clocks.underlyingObservedAt, NVDA.underlying.observedAt);
  assert.equal(q.provenance.ages.quoteS, Math.floor(NOW_S) - AS_OF);
  assert.deepEqual(q.provenance.quality.reasons, []);
  assert.equal(q.provenance.quality.readiness, 'ready');
});

test('theoretical: a vendor estimate never prices as listed; mixed chains keep both apart and keep the clocks', async () => {
  const theoOnly = fakeTheoreticalChain(NVDA, { observedAt: AS_OF });
  const theoOutcome = await serviceWith(theoOnly).fair(request(220, closeOf(18)));
  assert.ok(!theoOutcome.ok, 'a theoretical-only chain has no listed input to price from');
  // The vendor observation time is on the chain, never relabeled a quote time.
  assert.equal(theoOnly.clocks.volatilityObservedAt, AS_OF);
  assert.equal(theoOnly.clocks.quoteObservedAt, null);

  const reference = priced(await serviceWith(fakeListedChain(NVDA, { quoteObservedAt: AS_OF })).fair(request(220, closeOf(18))));
  const mixed = withTheoretical(fakeListedChain(NVDA, { quoteObservedAt: AS_OF }), 'vendor-fair', AS_OF, (row: ChainRow) => 9.99);
  const m = priced(await serviceWith(mixed).fair(request(220, closeOf(18))));
  assert.equal(m.provenance.method, 'listed', 'the listed quote prices, not the vendor value');
  assert.equal(m.fairUsdg6, reference.fairUsdg6, 'the vendor value moves no price');
  assert.ok(m.provenance.observations.vendorTheoretical.length > 0, 'the vendor value is reported as theoretical');
  assert.ok(m.provenance.observations.listedQuotes.length > 0, 'the listed quote is reported as a quote');
  assert.equal(m.provenance.observations.vendorTheoretical[0]!.observedAt, AS_OF);
});

/*//////////////////////////////////////////////////////////////
              NEUTRAL REPLAY: BAD BOOKS AND CLOCKS
//////////////////////////////////////////////////////////////*/

test('stale: an old chain refuses chain-stale, never prices', async () => {
  const staleNow = AS_OF + 345_600 + 3_600;
  const outcomes = await replayLadder(serviceWith(NVDA, staleNow), 'NVDA', [
    { tenor: 'weekly', expiry: closeOf(25), strike: 220_000_000n },
  ]);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0]!.result, { ok: false, reason: 'chain-stale' });
});

test('empty: a chain with no quotes refuses every rung, never throws, never prices a null as a number', async () => {
  const empty: NormalizedChain = { ...NVDA, rows: NVDA.rows.map((r) => ({ ...r, quote: null, analytics: null })) };
  const outcomes = await replayLadder(serviceWith(empty), 'NVDA', [
    { tenor: 'weekly', expiry: closeOf(18), strike: 220_000_000n },
    { tenor: 'weekly', expiry: closeOf(18), strike: 217_500_000n },
  ]);
  for (const row of outcomes) {
    if (row.result.ok) assert.fail(`no quote is a refusal (${String(row.result.fairUsdg6)})`);
    assert.equal(row.result.reason, 'no-quotes');
  }
});

test('crossed: a crossed book is classified, never used as a listed input', async () => {
  const crossedQuote = { bid: 11, ask: 10, bidSize: null, askSize: null, currency: 'USD' as const, observedAt: null };
  assert.equal(bookState(crossedQuote).reason, 'book-crossed');
  const crossed: NormalizedChain = { ...NVDA, rows: NVDA.rows.map((r) => (r.quote === null ? r : { ...r, quote: { ...r.quote, bid: r.quote.ask === null ? 1 : r.quote.ask + 1 } })) };
  const outcome = await serviceWith(crossed).fair(request(220, closeOf(18)));
  assert.ok(!outcome.ok, 'a fully crossed chain cannot price as listed');
});

test('zero-bid: a zero side is a book state, not a missing quote; a zero fair is a price, not unavailable', async () => {
  const oneSided = { bid: 0, ask: 1, bidSize: null, askSize: null, currency: 'USD' as const, observedAt: null };
  const book = bookState(oneSided);
  assert.equal(book.bid, 'zero');
  assert.equal(book.reason, 'book-one-sided');

  const zeroBid: NormalizedChain = { ...NVDA, rows: NVDA.rows.map((r) => (r.quote?.bid === null || r.quote === null ? r : { ...r, quote: { ...r.quote, bid: 0 } })) };
  const outcome = await serviceWith(zeroBid).fair(request(220, closeOf(18)));
  assert.ok(!outcome.ok, 'a zero bid is not a usable listed quote');

  // Deep out of the money: a price that rounds to 0 is answered as a price (raw "0"), never null.
  const zero = priced(await serviceWith(NVDA).fair(request(900, closeOf(18))));
  assert.equal(zero.fairUsdg6, 0n);
});

test('missing timestamps: unknown clocks stay null and the estimate is never ready', async () => {
  // No quote time and no underlying time at all: the chain cannot be priced.
  const timeless = fakeListedChain(NVDA, { quoteObservedAt: null, underlyingObservedAt: null, publishedAt: null });
  refused(await serviceWith(timeless).fair(request(220, closeOf(18))), 'chain-inconsistent');

  // An untimed quote next to a timed underlying: priced on the underlying, the quote clock stays
  // null and the estimate is degraded, never ready on an unknown input.
  const noQuoteTime = fakeListedChain(NVDA, { quoteObservedAt: null });
  const q = priced(await serviceWith(noQuoteTime).fair(request(220, closeOf(18))));
  assert.equal(q.provenance.clocks.quoteObservedAt, null);
  assert.equal(q.provenance.ages.quoteS, null);
  assert.ok(q.provenance.quality.reasons.includes('quote-age-unknown'));
  assert.notEqual(q.provenance.quality.readiness, 'ready');

  // An untimed underlying next to timed quotes: priced on the quote, the underlying clock stays
  // null and carries the K3-311 reason code.
  const noUnderlyingTime = fakeListedChain(NVDA, { quoteObservedAt: AS_OF, underlyingObservedAt: null });
  const u = priced(await serviceWith(noUnderlyingTime).fair(request(220, closeOf(18))));
  assert.equal(u.provenance.clocks.underlyingObservedAt, null);
  assert.equal(u.provenance.ages.underlyingS, null);
  assert.ok(u.provenance.quality.reasons.includes('underlying-age-unknown'));
  assert.notEqual(u.provenance.quality.readiness, 'ready');
});

/*//////////////////////////////////////////////////////////////
              PRIVATE CBOE FIXTURES (ENV-GATED)
//////////////////////////////////////////////////////////////*/

const PRIVATE_DIR = process.env.PRICING_PRIVATE_FIXTURES_DIR;

test(
  'private fixtures: real Cboe downloads replay through the seam onto the cranker ladder',
  { skip: PRIVATE_DIR === undefined ? 'PRICING_PRIVATE_FIXTURES_DIR is not set: private Cboe fixtures are not committed' : false },
  async () => {
    const fixtures = loadCboeFixtureDir(PRIVATE_DIR!);
    assert.ok(fixtures.size > 0, 'at least one private fixture');
    const pricingRegistry = loadPricingRegistry(TIER1);
    const v2 = v2Markets(loadV2Registry(TIER1), LADDER_STATUSES);
    let replayedMarkets = 0;
    for (const [root, cboeChain] of fixtures) {
      const market = [...pricingRegistry.markets.values()].find((m) => m.cboe?.root === root);
      const ladderMarket = v2.find((m) => m.ticker === market?.ticker);
      if (market === undefined || ladderMarket === undefined) continue;
      replayedMarkets += 1;
      const chain = cboeToNormalized(cboeChain, 0);
      const nowS = chain.clocks.publishedAt ?? chain.underlying.observedAt ?? Math.floor(Date.now() / 1000);
      const svc = new PricingService({
        markets: new Map([[market.ticker, market]]),
        nowMs: () => nowS * 1000,
        spotReader: chainSpotReader(chain, nowS),
        chains: { provider: createFakeProvider(chain.provider, { [root]: chain }) },
      });
      const rungs = crankerLadderRungs(chain, {
        ladder: ladderMarket.v2.params.ladder,
        expiriesAhead: ladderMarket.v2.params.expiriesAhead,
        strikeTick: ladderMarket.v2.strikeTick,
        fromUnix: nowS,
      });
      assert.ok(rungs.length > 0, `${root}: the chain prices a real ladder (${rungs.length} rungs)`);
      const outcomes = await replayLadder(svc, market.ticker, rungs);
      assert.equal(outcomes.length, rungs.length);
      for (const row of outcomes) {
        assert.ok(!('reason' in row.result && row.result.reason.startsWith('threw:')), `${root} rung ${String(row.strike)} never throws: ${row.result.ok ? row.result.method : row.result.reason}`);
        if (row.result.ok && row.result.method === 'listed-contract') {
          assert.equal(row.result.source, 'cboe', `${root}: an exact Cboe listed contract keeps source cboe`);
        }
      }
    }
    assert.ok(replayedMarkets > 0, 'at least one fixture names a registry market');
  },
);
