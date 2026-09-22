/**
 * The provider-neutral contract's pure checks (chain.ts): what a book, a clock, two sources and an
 * identity are judged as, independent of any provider.
 *
 * WHY THIS FILE EXISTS: K3-311 must keep "no quote" apart from "a zero quote", "unknown time" apart
 * from "old time", a frozen underlying apart from stale option quotes, and a provider's model value
 * apart from a listed quote. Each is pinned here on hand-built rows; fake-provider.test.ts pins the
 * same through the service.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syntheticNvdaChain } from '../../fixtures/synthetic-chains.js';
import { cboeToNormalized } from './cboe.js';
import {
  STANDARD_LISTED_MULTIPLIER,
  bookState,
  checkIdentity,
  clockAges,
  listedOptionOf,
  listedOptions,
  pricingClock,
  sourceDisagreement,
  type CanonicalIdentity,
  type ChainRow,
  type ListedQuote,
} from './chain.js';
import { fakeListedChain, fakeTheoreticalChain, withTheoretical } from './fake-provider.js';

const NVDA_CBOE = syntheticNvdaChain();
const NVDA = cboeToNormalized(NVDA_CBOE, 1_789_460_000);
/** The synthetic file's last trade and publication: 15:59:59 New York 14 Sep, 05:45 UTC 15 Sep. */
const NVDA_LAST_TRADE = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const NVDA_FILE = Date.UTC(2026, 8, 15, 5, 45) / 1000;
const NVDA_NOW = Date.UTC(2026, 8, 15, 8, 30) / 1000;
const LIMITS = { maxQuoteAgeS: 3_600, maxUnderlyingAgeS: 345_600, maxVolatilityAgeS: 3_600 };

const quote = (bid: number | null, ask: number | null, observedAt: number | null = null): ListedQuote => ({ bid, ask, bidSize: null, askSize: null, currency: 'USD', observedAt });

const CANONICAL: CanonicalIdentity = {
  market: 'NVDA',
  root: 'NVDA',
  issuer: 'US67066G1040',
  token: { chainId: 4663, address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', uiMultiplier: '1000775159164630595' },
};

/*//////////////////////////////////////////////////////////////
                          THE CBOE ADAPTER
//////////////////////////////////////////////////////////////*/

test('cboeToNormalized: every row kept with what Cboe states; what it does not state is null, never guessed', () => {
  assert.equal(NVDA.provider.id, 'cboe-delayed');
  assert.deepEqual(NVDA.provider.entitlement, { class: 'delayed', declaredDelayS: null, rightsRef: null });
  assert.equal(NVDA.rows.length, NVDA_CBOE.options.length);
  assert.deepEqual(NVDA.underlying, { providerSymbol: 'NVDA', issuer: null, price: NVDA_CBOE.shareSpot, observedAt: NVDA_LAST_TRADE, observedAtText: NVDA_CBOE.lastTradeTime });
  assert.deepEqual(NVDA.clocks, { quoteObservedAt: null, tradeObservedAt: null, volatilityObservedAt: null, publishedAt: NVDA_FILE, publishedAtText: NVDA_CBOE.timestamp, receivedAt: 1_789_460_000 });
  const o = NVDA_CBOE.options[0]!;
  assert.deepEqual(NVDA.rows[0], {
    instrument: { providerInstrumentId: o.symbol, root: 'NVDA', side: o.type, strike: o.strike, expiryDay: o.expiry, expiry: null, multiplier: null, exercise: null, settlement: null },
    quote: { bid: o.bid, ask: o.ask, bidSize: null, askSize: null, currency: 'USD', observedAt: null },
    analytics: { iv: o.iv, delta: o.delta, observedAt: null },
    theoretical: null,
  });
  // The surface's view of a Cboe row is exactly the old CboeOption: same fields, same values.
  assert.deepEqual(listedOptions(NVDA, 'NVDA'), NVDA_CBOE.options);
  // An unparseable clock stays null beside its verbatim text, and is refused, not replaced.
  const garbage = cboeToNormalized({ ...NVDA_CBOE, lastTradeTime: 'garbage' }, 0);
  assert.equal(garbage.underlying.observedAt, null);
  assert.equal(garbage.underlying.observedAtText, 'garbage');
  const clock = pricingClock(garbage, NVDA_NOW, 345_600);
  assert.equal(!clock.ok && clock.detail.why, 'a clock does not parse');
});

/*//////////////////////////////////////////////////////////////
                               BOOKS
//////////////////////////////////////////////////////////////*/

test('bookState: absent, empty, one-sided, crossed and two-sided, with missing kept apart from zero', () => {
  assert.deepEqual(bookState(null), { state: 'absent', bid: 'missing', ask: 'missing', reason: 'no-quotes' });
  assert.deepEqual(bookState(quote(null, null)), { state: 'empty', bid: 'missing', ask: 'missing', reason: 'book-empty' });
  assert.deepEqual(bookState(quote(0, 0)), { state: 'empty', bid: 'zero', ask: 'zero', reason: 'book-empty' }, 'a zero book is empty, and says it was zero');
  assert.deepEqual(bookState(quote(null, 1.2)), { state: 'one-sided', bid: 'missing', ask: 'positive', reason: 'book-one-sided' });
  assert.deepEqual(bookState(quote(0, 1.2)), { state: 'one-sided', bid: 'zero', ask: 'positive', reason: 'book-one-sided' }, 'a zero bid is not a missing bid');
  assert.deepEqual(bookState(quote(1.1, null)), { state: 'one-sided', bid: 'positive', ask: 'missing', reason: 'book-one-sided' });
  assert.deepEqual(bookState(quote(1.3, 1.2)), { state: 'crossed', bid: 'positive', ask: 'positive', reason: 'book-crossed' });
  assert.deepEqual(bookState(quote(1.2, 1.2)), { state: 'two-sided', bid: 'positive', ask: 'positive', reason: null }, 'locked is not crossed');
  assert.deepEqual(bookState(quote(1.1, 1.2)), { state: 'two-sided', bid: 'positive', ask: 'positive', reason: null });
  assert.equal(bookState(quote(-1, 1.2)).bid, 'invalid');
  assert.equal(bookState(quote(Number.NaN, 1.2)).bid, 'invalid');
});

test('listedOptionOf: only a supplied two-field quote with the provider greeks is a listed input; a theoretical value never is', () => {
  const base = NVDA.rows[0]!;
  const why = (row: ChainRow) => {
    const o = listedOptionOf(row, 'NVDA');
    return typeof o === 'string' ? o : 'listed';
  };
  assert.equal(why(base), 'listed');
  assert.equal(why({ ...base, quote: null, theoretical: { product: 'fmv', value: 1.23, iv: 0.4, currency: 'USD', observedAt: NVDA_NOW } }), 'no-quotes');
  assert.equal(why({ ...base, quote: { ...base.quote!, bid: null } }), 'quote-side-missing', 'a missing bid is not read as zero');
  assert.equal(why({ ...base, quote: { ...base.quote!, bid: 0 } }), 'listed', 'a zero bid is a value; the quote gate (isUsableQuote) refuses it later');
  assert.equal(why({ ...base, analytics: null }), 'analytics-missing');
  assert.equal(why({ ...base, analytics: { ...base.analytics!, delta: null } }), 'analytics-missing');
  assert.equal(why({ ...base, instrument: { ...base.instrument, root: 'NVDA1' } }), 'identity-mismatch');
  assert.equal(why({ ...base, instrument: { ...base.instrument, multiplier: 150 } }), 'multiplier-mismatch');
  assert.equal(why({ ...base, instrument: { ...base.instrument, multiplier: STANDARD_LISTED_MULTIPLIER } }), 'listed');
  // A theoretical-only chain has no listed input at all; a mixed one keeps its quotes unchanged.
  assert.deepEqual(listedOptions(fakeTheoreticalChain(NVDA, { observedAt: NVDA_NOW }), 'NVDA'), []);
  const mixed = withTheoretical(NVDA, 'fmv', NVDA_NOW, () => 999);
  assert.deepEqual(listedOptions(mixed, 'NVDA'), listedOptions(NVDA, 'NVDA'), 'a theoretical 999 beside a quote changes no listed input');
});

/*//////////////////////////////////////////////////////////////
                              CLOCKS
//////////////////////////////////////////////////////////////*/

test('clockAges: quote age only from a quote clock; unknown is its own reason; a frozen underlying does not stale moving quotes', () => {
  // Cboe: no quote time anywhere. Not from receivedAt, not from the file time, not from the last trade.
  const cboe = clockAges(NVDA.clocks, NVDA.underlying, NVDA.rows[0]!.quote, NVDA_NOW, LIMITS);
  assert.equal(cboe.quoteS, null);
  assert.deepEqual(cboe.reasons, ['quote-age-unknown']);
  assert.equal(cboe.underlyingS, NVDA_NOW - NVDA_LAST_TRADE);

  // Quotes 30 s old, the underlying's last trade five days old: the quotes are fresh, the underlying stale.
  const frozen = clockAges({ ...NVDA.clocks, quoteObservedAt: NVDA_NOW - 30 }, { observedAt: NVDA_NOW - 5 * 86_400 }, null, NVDA_NOW, LIMITS);
  assert.equal(frozen.quoteS, 30);
  assert.deepEqual(frozen.reasons, ['underlying-stale']);

  // A quote's own time wins over the file's; an old one is stale.
  const own = clockAges({ ...NVDA.clocks, quoteObservedAt: NVDA_NOW - 30 }, NVDA.underlying, quote(1, 1.1, NVDA_NOW - 7_200), NVDA_NOW, LIMITS);
  assert.equal(own.quoteS, 7_200);
  assert.deepEqual(own.reasons, ['quote-stale']);

  // A volatility input past its limit is its own reason; unknown volatility time is not guessed stale.
  assert.deepEqual(clockAges({ ...NVDA.clocks, quoteObservedAt: NVDA_NOW, volatilityObservedAt: NVDA_NOW - 7_200 }, NVDA.underlying, null, NVDA_NOW, LIMITS).reasons, ['volatility-stale']);
  assert.equal(clockAges({ ...NVDA.clocks, quoteObservedAt: NVDA_NOW }, NVDA.underlying, null, NVDA_NOW, LIMITS).volatilityS, null);
});

test('pricingClock: Cboe is judged on its last trade exactly as before; a provider quote time takes over when given', () => {
  const cboe = pricingClock(NVDA, NVDA_NOW, 345_600);
  assert.deepEqual(cboe, { ok: true, clock: NVDA_LAST_TRADE, basis: 'underlying', ageSeconds: NVDA_NOW - NVDA_LAST_TRADE, publishedAt: NVDA_FILE });
  assert.equal(pricingClock(NVDA, NVDA_NOW + 5 * 86_400, 345_600).ok, false);

  // Quotes stamped a minute ago, underlying frozen five days: priced on the quotes, not stale.
  const frozen = fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW - 60, underlyingObservedAt: NVDA_NOW - 5 * 86_400 });
  const fresh = pricingClock(frozen, NVDA_NOW, 345_600);
  assert.equal(fresh.ok && fresh.basis, 'quote');
  assert.equal(fresh.ok && fresh.ageSeconds, 60);
  // The same file without a quote time falls back to the underlying clock and is stale.
  const noQuoteTime = fakeListedChain(NVDA, { quoteObservedAt: null, underlyingObservedAt: NVDA_NOW - 5 * 86_400, publishedAt: NVDA_NOW - 60 });
  const stale = pricingClock(noQuoteTime, NVDA_NOW, 345_600);
  assert.equal(!stale.ok && stale.reason, 'stale');

  // No clock at all: refused as inconsistent, never priced on the download time.
  const none = fakeListedChain(NVDA, { quoteObservedAt: null, underlyingObservedAt: null, publishedAt: null });
  const refused = pricingClock(none, NVDA_NOW, 345_600);
  assert.equal(!refused.ok && refused.reason, 'inconsistent');
  assert.equal(!refused.ok && refused.detail.why, 'the source gives no observation time');
  // A provider with a quote time and no file time is judged on the quote time alone.
  assert.equal(pricingClock(fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW - 60, publishedAt: null }), NVDA_NOW, 345_600).ok, true);
  const future = pricingClock(fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW + 7_200, publishedAt: null }), NVDA_NOW, 345_600);
  assert.equal(!future.ok && future.detail.why, 'the pricing clock is in the future');
});

/*//////////////////////////////////////////////////////////////
                        SOURCES AND IDENTITY
//////////////////////////////////////////////////////////////*/

test('sourceDisagreement: a measured gap above the limit disagrees; an unknown side is unknown, not agreement', () => {
  const near = sourceDisagreement(1.0, { provider: 'b', value: 1.02 }, 300);
  assert.equal(near.disagrees, false);
  assert.ok(Math.abs(near.fairBps! - (1 - 1 / 1.02) * 10_000) < 1e-9);
  const wide = sourceDisagreement(1.1, { provider: 'b', value: 1.0 }, 300);
  assert.ok(wide.disagrees);
  assert.ok(Math.abs(wide.fairBps! - 1_000) < 1e-6);
  assert.deepEqual(sourceDisagreement(null, { provider: 'b', value: 1 }, 300), { provider: 'b', fairBps: null, disagrees: false });
  assert.deepEqual(sourceDisagreement(1, { provider: 'b', value: null }, 300), { provider: 'b', fairBps: null, disagrees: false });
  assert.deepEqual(sourceDisagreement(0, { provider: 'b', value: 0 }, 300), { provider: 'b', fairBps: null, disagrees: false }, 'a zero reference has no ratio');
  assert.equal(sourceDisagreement(0, { provider: 'b', value: 1 }, 300).disagrees, true, 'a zero against a positive value is a measured disagreement');
});

test('checkIdentity: canonical token, issuer and multiplier mismatches each get their own reason; ticker alone is not an identity', () => {
  assert.deepEqual(checkIdentity(NVDA, CANONICAL), { ok: true, reasons: [], detail: {}, nonStandardRows: 0 }, 'Cboe states no issuer or multiplier: nothing to contradict');
  assert.deepEqual(checkIdentity(NVDA, { ...CANONICAL, token: { ...CANONICAL.token, address: null } }).reasons, ['identity-unmapped']);
  assert.deepEqual(checkIdentity(NVDA, { ...CANONICAL, root: null }).reasons, ['identity-unmapped'], 'a chain whose symbol equals the ticker is still unmapped without a registry root');
  const other = checkIdentity(fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW, providerSymbol: 'NVDX' }), CANONICAL);
  assert.deepEqual(other.reasons, ['identity-mismatch']);
  assert.equal(other.detail.symbol, 'NVDX');
  const issuer = checkIdentity(fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW, issuer: 'US0000000000' }), CANONICAL);
  assert.deepEqual(issuer.reasons, ['identity-mismatch']);
  assert.equal(issuer.detail.expectedIssuer, 'US67066G1040');
  assert.equal(checkIdentity(fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW, issuer: 'US67066G1040' }), CANONICAL).ok, true);
  const adjusted = checkIdentity(fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW, multiplier: 150 }), CANONICAL);
  assert.deepEqual(adjusted.reasons, ['multiplier-mismatch']);
  assert.equal(adjusted.nonStandardRows, NVDA.rows.length);
  assert.equal(checkIdentity(fakeListedChain(NVDA, { quoteObservedAt: NVDA_NOW, multiplier: 100 }), CANONICAL).ok, true);
  const ui = checkIdentity(NVDA, CANONICAL, '1000000000000000000');
  assert.deepEqual(ui.reasons, ['multiplier-mismatch']);
  assert.equal(ui.detail.expectedUiMultiplier, '1000775159164630595');
  assert.equal(checkIdentity(NVDA, CANONICAL, '1000775159164630595').ok, true);
});
