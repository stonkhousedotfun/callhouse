/**
 * The market-data half of vol pricing: parsing Cboe's delayed chain, deciding whether it is fit to
 * price a week on, and the two interpolations (strike by delta, fair value by strike).
 *
 * WHY THIS FILE EXISTS: every number here ends up in an immutable option type or a Seaport order.
 * A symbol parsed as the wrong strike, a stale Friday read as this week, a spot from another day,
 * a float rounded down a base unit or a hostile response that hangs the tick would each arm or
 * price a week on nonsense. The fixture is a deterministic, synthetic NVDA-shaped chain with
 * invented Black–Scholes quotes for the 18 Sep and 25 Sep expiries.
 *
 * DELIBERATELY ABSENT: no network. fetchCboeChain is driven through its fetch seam.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syntheticNvdaChain, syntheticNvdaPayload } from './fixtures/synthetic-chains.js';
import {
  CLOCK_SKEW_TOLERANCE_S,
  MAX_SPREAD_FRACTION_OF_MID,
  MAX_SPREAD_USD,
  VolFetchError,
  chainAgeSeconds,
  chainFreshness,
  checkQuoteWindow,
  checkVolMarket,
  latestSettledSessionClose,
  closeDayOf,
  fairCallPrice,
  fetchCboeChain,
  filterQuotes,
  isUsableQuote,
  mapSpot,
  parseCboeChain,
  parseCboeTimestamp,
  parseNewYorkLocalTime,
  parseOptionSymbol,
  selectExpiry,
  strikeForDelta,
  usdToUsdg6Up,
  type CboeOption,
} from './vol.js';

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const RAW = JSON.stringify(syntheticNvdaPayload());
const CHAIN = syntheticNvdaChain();

/** 2026-09-14T15:59:59 New York (EDT, UTC-4) = 19:59:59 UTC. */
const LAST_TRADE_UNIX = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
/** Invented file-generation clock, read as UTC. */
const FILE_UNIX = Date.UTC(2026, 8, 15, 5, 45) / 1000;
/** Tuesday 2026-09-15 08:30 UTC: the synthetic observation clock. */
const NOW = Date.UTC(2026, 8, 15, 8, 30, 0) / 1000;

/** Invented token spot near the synthetic chain spot. */
const TOKEN_SPOT6 = 212_500_000n;

function quotesFor(day: string): CboeOption[] {
  const expiry = selectExpiry(CHAIN, day);
  assert.ok(expiry, `the fixture lists ${day}`);
  return filterQuotes(expiry.calls);
}

function ratio(): number {
  const m = mapSpot(CHAIN.shareSpot, TOKEN_SPOT6, 300);
  assert.ok(m.ok);
  return m.ratio;
}

function option(overrides: Partial<CboeOption>): CboeOption {
  return { symbol: 'NVDA260918C00220000', expiry: '2026-09-18', type: 'C', strike: 220, bid: 0.62, ask: 0.63, iv: 0.37, delta: 0.15, ...overrides };
}

/*//////////////////////////////////////////////////////////////
                              PARSING
//////////////////////////////////////////////////////////////*/

test('parseOptionSymbol: root + YYMMDD + C|P + strike x 1000, exactly', () => {
  assert.deepEqual(parseOptionSymbol('NVDA', 'NVDA260918C00222500'), { expiry: '2026-09-18', type: 'C', strike: 222.5 });
  assert.deepEqual(parseOptionSymbol('NVDA', 'NVDA260925P00050000'), { expiry: '2026-09-25', type: 'P', strike: 50 });
  assert.deepEqual(parseOptionSymbol('NVDA', 'NVDA270115C01234567'), { expiry: '2027-01-15', type: 'C', strike: 1234.567 });
  // Look-alike and adjusted roots never parse as NVDA.
  assert.equal(parseOptionSymbol('NVDA', 'NVDA1260918C00222500'), null);
  assert.equal(parseOptionSymbol('NVDA', 'NVDAX260918C00222500'), null);
  assert.equal(parseOptionSymbol('NVDA', 'AAPL260918C00222500'), null);
  // Malformed pieces.
  assert.equal(parseOptionSymbol('NVDA', 'NVDA260918X00222500'), null, 'type');
  assert.equal(parseOptionSymbol('NVDA', 'NVDA260918C0022250'), null, 'seven strike digits');
  assert.equal(parseOptionSymbol('NVDA', 'NVDA260918C002225000'), null, 'nine strike digits');
  assert.equal(parseOptionSymbol('NVDA', 'NVDA260230C00222500'), null, '30 February');
  assert.equal(parseOptionSymbol('NVDA', 'NVDA261318C00222500'), null, 'month 13');
  assert.equal(parseOptionSymbol('NVDA', 'NVDA260918C00000000'), null, 'zero strike');
  assert.equal(parseOptionSymbol('nvda', 'nvda260918C00222500'), null, 'the root is upper case');
});

test('parseCboeChain: the synthetic payload parses whole; malformed rows are counted, never priced; a bad envelope throws', () => {
  assert.equal(CHAIN.root, 'NVDA');
  assert.equal(CHAIN.shareSpot, 212.35);
  assert.equal(CHAIN.timestamp, '2026-09-15 05:45:00');
  assert.equal(CHAIN.lastTradeTime, '2026-09-14T15:59:59');
  assert.equal(CHAIN.options.length, 108, '27 strikes on both sides of two synthetic expiries');
  assert.equal(CHAIN.skippedRows, 0);
  const c220 = CHAIN.options.find((o) => o.symbol === 'NVDA260918C00220000');
  assert.deepEqual(c220, { symbol: 'NVDA260918C00220000', expiry: '2026-09-18', type: 'C', strike: 220, bid: 1.55, ask: 1.59, iv: 0.43, delta: 0.2392 });

  const doc = JSON.parse(RAW) as { data: { options: unknown[] } };
  doc.data.options = [
    ...doc.data.options.slice(0, 3),
    { option: 'NVDA260918C00220000', bid: null, ask: 0.63, iv: 0.37, delta: 0.15 },
    { option: 'NVDA260918C00220000', bid: '0.62', ask: 0.63, iv: 0.37, delta: 0.15 },
    { option: 'TSLA260918C00220000', bid: 0.62, ask: 0.63, iv: 0.37, delta: 0.15 },
    { bid: 0.62 },
    'not an object',
  ];
  const partial = parseCboeChain(doc);
  assert.equal(partial.options.length, 3);
  assert.equal(partial.skippedRows, 5);

  const expectShape = (json: unknown) =>
    assert.throws(() => parseCboeChain(json), (err: unknown) => err instanceof VolFetchError && err.code === 'bad-shape');
  expectShape(null);
  expectShape([]);
  expectShape({ timestamp: CHAIN.timestamp });
  expectShape({ ...JSON.parse(RAW), data: { ...JSON.parse(RAW).data, current_price: -1 } });
  expectShape({ ...JSON.parse(RAW), data: { ...JSON.parse(RAW).data, current_price: '212.04' } });
  expectShape({ ...JSON.parse(RAW), data: { ...JSON.parse(RAW).data, symbol: 'nvda; drop table' } });
  expectShape({ ...JSON.parse(RAW), data: { ...JSON.parse(RAW).data, options: 'many' } });
});

/*//////////////////////////////////////////////////////////////
                             FRESHNESS
//////////////////////////////////////////////////////////////*/

test('the two clocks: timestamp is UTC, last_trade_time is New York wall clock, DST included', () => {
  assert.equal(parseCboeTimestamp(CHAIN.timestamp), FILE_UNIX);
  assert.equal(parseNewYorkLocalTime('2026-09-14T15:59:59'), LAST_TRADE_UNIX, 'EDT: UTC-4');
  assert.equal(parseNewYorkLocalTime('2026-12-11T15:59:59'), Date.UTC(2026, 11, 11, 20, 59, 59) / 1000, 'EST: UTC-5');
  assert.equal(parseNewYorkLocalTime('2026-09-14T16:14:59.250'), Date.UTC(2026, 8, 14, 20, 14, 59) / 1000, 'fractional seconds are ignored');
  for (const bad of ['', 'yesterday', '2026-09-14', '2026-02-30T10:00:00', '2026-09-14T24:00:00', '2027-03-14T02:30:00']) {
    assert.equal(parseNewYorkLocalTime(bad), null, `refuses ${bad || '(empty)'}`);
  }
  assert.equal(parseCboeTimestamp('2026-09-15T05:45:00'), FILE_UNIX, 'a T separator is the same instant');
  assert.equal(parseCboeTimestamp('2026-13-15 05:57:42'), null);
  assert.equal(chainAgeSeconds(CHAIN, NOW), NOW - LAST_TRADE_UNIX);
  assert.equal(closeDayOf(Date.UTC(2026, 8, 18, 20, 0, 0) / 1000), '2026-09-18', 'the exercise ts of a Friday close is that Friday in New York');
});

test('chainFreshness: the age of the last trade and of the file, up to maxAge inclusive; the clocks must agree', () => {
  const maxAge = 345_600;
  const fresh = chainFreshness(CHAIN, NOW, maxAge);
  assert.ok(fresh.ok);
  assert.equal(fresh.ageSeconds, NOW - LAST_TRADE_UNIX);

  // Exactly four days after the last trade still prices; one second more does not.
  assert.equal(chainFreshness(CHAIN, LAST_TRADE_UNIX + maxAge, maxAge).ok, true);
  const stale = chainFreshness(CHAIN, LAST_TRADE_UNIX + maxAge + 1, maxAge);
  assert.equal(!stale.ok && stale.reason, 'vol-stale');
  assert.equal(!stale.ok && stale.detail.ageSeconds, String(maxAge + 1));

  // A file regenerated today about a trade from last week is still last week's market.
  const oldTrade = { ...CHAIN, lastTradeTime: '2026-09-04T15:59:59' };
  assert.equal((chainFreshness(oldTrade, NOW, maxAge) as { reason: string }).reason, 'vol-stale');

  // Inconsistent: unparseable, from the future, or a trade newer than the file reporting it.
  assert.equal((chainFreshness({ ...CHAIN, lastTradeTime: 'soon' }, NOW, maxAge) as { reason: string }).reason, 'vol-inconsistent');
  const future = chainFreshness({ ...CHAIN, timestamp: '2026-09-15 10:00:00' }, NOW, maxAge);
  assert.equal(!future.ok && future.reason, 'vol-inconsistent', 'dated 1.5 h after the block clock');
  assert.equal(chainFreshness({ ...CHAIN, timestamp: '2026-09-15 09:29:00' }, NOW, maxAge).ok, true, 'within the skew tolerance');
  const backwards = chainFreshness({ ...CHAIN, timestamp: '2026-09-14 18:00:00' }, NOW, maxAge);
  assert.equal(!backwards.ok && backwards.reason, 'vol-inconsistent', 'a file generated before the trade it reports');
  assert.equal(CLOCK_SKEW_TOLERANCE_S, 3_600);
});

/*//////////////////////////////////////////////////////////////
                         EXPIRY AND QUOTES
//////////////////////////////////////////////////////////////*/

test('selectExpiry: the calls of exactly the close day; no nearest expiry, no interpolation across days', () => {
  const sep18 = selectExpiry(CHAIN, '2026-09-18');
  assert.ok(sep18);
  assert.equal(sep18.calls.length, 27);
  assert.ok(sep18.calls.every((o) => o.type === 'C' && o.expiry === '2026-09-18'));
  assert.equal(selectExpiry(CHAIN, '2026-09-25')?.calls.length, 27);
  // A holiday Thursday close with no Thursday listing, a date in between, and a week not listed.
  assert.equal(selectExpiry(CHAIN, '2026-09-17'), null);
  assert.equal(selectExpiry(CHAIN, '2026-09-21'), null);
  assert.equal(selectExpiry(CHAIN, '2026-10-02'), null);
});

test('the quote filter: two-sided, ask >= bid, delta in (0,1), finite, spread <= max(0.05, 30% of mid)', () => {
  assert.equal(MAX_SPREAD_USD, 0.05);
  assert.equal(MAX_SPREAD_FRACTION_OF_MID, 0.3);
  assert.equal(isUsableQuote(option({})), true);
  assert.equal(isUsableQuote(option({ bid: 0 })), false, 'no bid');
  assert.equal(isUsableQuote(option({ bid: 0.7, ask: 0.6 })), false, 'crossed');
  assert.equal(isUsableQuote(option({ delta: 1 })), false, 'delta 1: no model');
  assert.equal(isUsableQuote(option({ delta: 0 })), false);
  assert.equal(isUsableQuote(option({ delta: Number.NaN })), false);
  assert.equal(isUsableQuote(option({ iv: Number.POSITIVE_INFINITY })), false);
  assert.equal(isUsableQuote(option({ iv: -0.1 })), false);
  // The absolute leg is for cheap wings only: 0.01/0.05 on a 0.03 mid is a normal tick, and
  // 0.02/0.07 is exactly 0.05 wide despite 0.07 - 0.02 = 0.05000000000000001 in floats. A 0.10
  // spread on a 0.18 mid (55%) or on a 0.06 mid (0.01/0.11, 167%) is not a price.
  assert.equal(isUsableQuote(option({ bid: 0.01, ask: 0.05 })), true);
  assert.equal(isUsableQuote(option({ bid: 0.02, ask: 0.07 })), true);
  assert.equal(isUsableQuote(option({ bid: 0.02, ask: 0.08 })), false);
  assert.equal(isUsableQuote(option({ bid: 0.13, ask: 0.23 })), false);
  assert.equal(isUsableQuote(option({ bid: 0.01, ask: 0.11 })), false);
  // A finite bid and ask whose sum overflows, or an absurd price, is not a quote.
  assert.equal(isUsableQuote(option({ bid: 1.7e308, ask: 1.7e308 })), false);
  assert.equal(isUsableQuote(option({ bid: 2e6, ask: 2e6 })), false);
  // The relative leg: on a 10.00 mid, 3.00 wide passes and 3.01 does not.
  assert.equal(isUsableQuote(option({ bid: 8.5, ask: 11.5 })), true);
  assert.equal(isUsableQuote(option({ bid: 8.495, ask: 11.505 })), false);

  const q = quotesFor('2026-09-18');
  assert.equal(q.length, 27, 'all synthetic calls have valid quotes');
  assert.ok(q.every((o, i) => i === 0 || o.strike > q[i - 1]!.strike), 'sorted by strike, one quote per strike');
  assert.ok(!q.some((o) => o.strike === 260), '260 is outside the synthetic grid');
  // A strike listed twice is dropped entirely.
  const dup = filterQuotes([option({ strike: 220 }), option({ strike: 220, bid: 0.5, ask: 0.55 }), option({ strike: 222.5, delta: 0.1 })]);
  assert.deepEqual(dup.map((o) => o.strike), [222.5]);
});

test('spot mapping: token / share within the divergence limit, else vol-spot-divergence', () => {
  const m = mapSpot(CHAIN.shareSpot, TOKEN_SPOT6, 300);
  assert.ok(m.ok);
  assert.ok(Math.abs(m.ratio - Number(TOKEN_SPOT6) / 1e6 / CHAIN.shareSpot) < 1e-9, 'the token multiplier');
  assert.ok(m.divergenceBps > 0 && m.divergenceBps < 10);
  // 3% apart is the edge; 3.01% is not.
  assert.equal(mapSpot(200, 206_000_000n, 300).ok, true);
  const far = mapSpot(200, 206_020_000n, 300);
  assert.equal(!far.ok && far.reason, 'vol-spot-divergence');
  assert.equal(!far.ok && far.detail.divergenceBps, '301.0');
  assert.equal((mapSpot(200, 194_000_000n, 300) as { ok: boolean }).ok, true, 'below as well as above');
  assert.equal((mapSpot(200, 193_000_000n, 300) as { reason: string }).reason, 'vol-spot-divergence');
  assert.equal((mapSpot(0, TOKEN_SPOT6, 300) as { reason: string }).reason, 'vol-inconsistent');
});

test('K3-305: spot mapping divides by uiMultiplier; a 2× token is not vol-spot-divergence against the share', () => {
  const unit = '1000000000000000000';
  const double = '2000000000000000000';
  assert.equal(mapSpot(200, 206_000_000n, 300, unit).ok, true, 'unit multiplier matches the 3-arg path');
  assert.equal(mapSpot(200, 206_020_000n, 300, unit).ok, false, 'unit: 3.01 % is still refused');
  // Token prints 400 USDG per token because each token is two shares; share spot is 200.
  const doubled = mapSpot(200, 400_000_000n, 300, double);
  assert.ok(doubled.ok, '2× token vs the share is in band after dividing by uiMultiplier');
  assert.ok(Math.abs(doubled.ratio - 1) < 1e-9);
  assert.equal(mapSpot(200, 400_000_000n, 300, unit).ok, false, 'the same print without the multiplier is 100 % off');
  assert.equal(mapSpot(200, 412_040_000n, 300, double).ok, false, '2× token still refuses a 3.01 % share gap');
});

/*//////////////////////////////////////////////////////////////
                         STRIKE AND PRICE
//////////////////////////////////////////////////////////////*/

test('strikeForDelta on the synthetic chain: targets interpolate monotonically between listings', () => {
  const q = quotesFor('2026-09-18');
  const r = ratio();
  const s15 = strikeForDelta(q, 0.15, r);
  assert.ok(s15.ok);
  assert.deepEqual(s15.bracket, [222.5, 225]);
  assert.ok(Math.abs(s15.shareStrike - 224.00614754098362) < 1e-9);
  assert.equal(s15.strikeUsdg6, 224_000_000n);
  assert.equal((strikeForDelta(q, 0.1, r) as { strikeUsdg6: bigint }).strikeUsdg6, 227_000_000n);
  assert.equal((strikeForDelta(q, 0.25, r) as { strikeUsdg6: bigint }).strikeUsdg6, 220_000_000n);
  // More trading time shifts the same delta to a higher strike.
  const s25 = strikeForDelta(quotesFor('2026-09-25'), 0.15, r);
  assert.ok(s25.ok);
  assert.equal(s25.strikeUsdg6, 231_000_000n);
  assert.deepEqual(s25.bracket, [230, 232.5]);
  // A delta exactly on a listing is that listing's strike.
  const exact = strikeForDelta([option({ strike: 217.5, delta: 0.2308 }), option({ strike: 220, delta: 0.15 }), option({ strike: 222.5, delta: 0.0978 })], 0.15, 1);
  assert.ok(exact.ok);
  assert.equal(exact.shareStrike, 220);
});

test('strikeForDelta: a target the quotes do not reach is flagged, never extrapolated', () => {
  const q = quotesFor('2026-09-18');
  const low = strikeForDelta(q, 0.0001, ratio());
  assert.equal(low.ok, false);
  assert.equal(!low.ok && low.reason, 'vol-delta-out-of-range');
  assert.equal(!low.ok && low.detail.quotedLow, q[q.length - 1]!.delta.toFixed(4));
  // Only the strikes from 210 up are considered: a 0.9 target is not reached.
  const high = strikeForDelta(q.filter((o) => o.strike >= 210), 0.9, ratio());
  assert.equal(!high.ok && high.reason, 'vol-delta-out-of-range');
  assert.equal(!high.ok && high.detail.quotedHigh, q.find((o) => o.strike === 210)!.delta.toFixed(4));
  assert.equal((strikeForDelta([], 0.15, 1) as { reason: string }).reason, 'vol-delta-out-of-range');
  assert.equal((strikeForDelta(q, 0.15, 0) as { reason: string }).reason, 'vol-delta-out-of-range', 'a broken ratio');
});

test('fairCallPrice: the mid interpolated in share-strike space, mapped to the token, rounded UP; outside the quotes, null', () => {
  const q = quotesFor('2026-09-18');
  const r = ratio();
  const f220 = fairCallPrice(q, 220_000_000n, r);
  assert.ok(f220);
  // Synthetic 220 token maps between the 217.5 and 220 share listings.
  assert.deepEqual(f220.bracket, [217.5, 220]);
  assert.ok(Math.abs(f220.shareMid - 1.6097552941176474) < 1e-9);
  assert.equal(f220.fairUnit6, 1_610_893n);
  assert.ok(Math.abs(f220.deltaAtStrike - 0.24354823529411768) < 1e-9, 'delta interpolated the same way');
  assert.equal(f220.ivAtStrike, 0.43);
  assert.equal(fairCallPrice(quotesFor('2026-09-25'), 225_000_000n, r)?.fairUnit6, 2_297_834n);

  // On a listing, with ratio 1: that listing's synthetic mid, exactly.
  assert.equal(fairCallPrice(q, 220_000_000n, 1)?.fairUnit6, 1_570_000n);
  assert.deepEqual(fairCallPrice(q, 220_000_000n, 1)?.bracket, [220, 220]);
  // Rounding UP at the base unit, and float noise is not a base unit.
  assert.equal(usdToUsdg6Up(0.63), 630_000n, '0.63 × 1e6 = 630000.0000000001 in floats');
  assert.equal(usdToUsdg6Up(0.6554141), 655_415n);
  assert.equal(usdToUsdg6Up(0.6554140000001), 655_414n);
  assert.equal(usdToUsdg6Up(0), 0n);
  assert.throws(() => usdToUsdg6Up(Number.NaN));
  assert.throws(() => usdToUsdg6Up(-1));

  // Outside the synthetic strike grid: null, never an extrapolation.
  assert.equal(q[0]?.strike, 185);
  assert.equal(q[q.length - 1]?.strike, 250);
  assert.equal(fairCallPrice(q, 251_000_000n, r), null);
  assert.ok(fairCallPrice(q, 250_000_000n, r));
  assert.equal(fairCallPrice(q, 184_000_000n, r), null);
  assert.equal(fairCallPrice([], 220_000_000n, r), null);
  assert.equal(fairCallPrice(q, 0n, r), null);
});

test('checkVolMarket: every strike-independent check in order, each with its own reason', () => {
  const settings = { maxAgeS: 345_600, maxDivergenceBps: 300 };
  const ctx = { chain: CHAIN, error: null, closeDay: '2026-09-18', nowSeconds: NOW };
  const ok = checkVolMarket(ctx, TOKEN_SPOT6, settings);
  assert.ok(ok.ok);
  assert.equal(ok.expiry, '2026-09-18');
  assert.equal(ok.quotes.length, 27);
  assert.equal(ok.chainTimestamp, CHAIN.timestamp);

  const reason = (r: ReturnType<typeof checkVolMarket>) => (r.ok ? 'ok' : r.reason);
  assert.equal(reason(checkVolMarket(undefined, TOKEN_SPOT6, settings)), 'vol-unavailable');
  const failed = checkVolMarket({ ...ctx, chain: null, error: 'timeout: no complete response within 10000 ms' }, TOKEN_SPOT6, settings);
  assert.equal(reason(failed), 'vol-unavailable');
  assert.equal(!failed.ok && failed.detail.error, 'timeout: no complete response within 10000 ms');
  assert.equal(reason(checkVolMarket({ ...ctx, nowSeconds: NOW + 5 * 86_400 }, TOKEN_SPOT6, settings)), 'vol-stale');
  assert.equal(reason(checkVolMarket({ ...ctx, chain: { ...CHAIN, lastTradeTime: 'garbage' } }, TOKEN_SPOT6, settings)), 'vol-inconsistent');
  assert.equal(reason(checkVolMarket({ ...ctx, closeDay: '2026-09-17' }, TOKEN_SPOT6, settings)), 'vol-no-expiry');
  const junk = { ...CHAIN, options: CHAIN.options.map((o) => ({ ...o, bid: 0 })) };
  assert.equal(reason(checkVolMarket({ ...ctx, chain: junk }, TOKEN_SPOT6, settings)), 'vol-no-quotes');
  assert.equal(reason(checkVolMarket(ctx, 230_000_000n, settings)), 'vol-spot-divergence');
});

/*//////////////////////////////////////////////////////////////
                               FETCH
//////////////////////////////////////////////////////////////*/

const URL_OK = 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json';
const OPTS = { timeoutMs: 200, maxBytes: 4_000_000 };

function expectCode(code: VolFetchError['code']) {
  return (err: unknown) => {
    assert.ok(err instanceof VolFetchError, `a VolFetchError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return true;
  };
}

/** A body that yields `chunks` then either ends or hangs forever; records whether it was cancelled. */
function streamBody(chunks: Uint8Array[], hang = false): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i += 1;
        return;
      }
      if (hang) return new Promise<void>(() => undefined);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

test('fetchCboeChain: https only, redirect manual, the chain parsed from the body', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const chain = await fetchCboeChain(URL_OK, {
    ...OPTS,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(RAW, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(chain.options.length, CHAIN.options.length);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.init?.redirect, 'manual', 'redirects are never followed blindly');
  assert.ok(seen[0]?.init?.signal instanceof AbortSignal, 'the deadline reaches the request');

  let called = false;
  const spy = async () => {
    called = true;
    return new Response(RAW);
  };
  await assert.rejects(fetchCboeChain('http://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json', { ...OPTS, fetchImpl: spy }), expectCode('non-https'));
  await assert.rejects(fetchCboeChain('file:///etc/passwd', { ...OPTS, fetchImpl: spy }), expectCode('non-https'));
  await assert.rejects(fetchCboeChain('not a url', { ...OPTS, fetchImpl: spy }), expectCode('bad-url'));
  assert.equal(called, false, 'nothing is requested for a refused URL');
});

test('fetchCboeChain: a same-host https redirect is followed; any other redirect is refused', async () => {
  const hops: string[] = [];
  const chain = await fetchCboeChain(URL_OK, {
    ...OPTS,
    fetchImpl: async (url) => {
      hops.push(String(url));
      if (hops.length === 1) return new Response(null, { status: 301, headers: { location: '/api/global/delayed_quotes/options/NVDA.json?v=2' } });
      return new Response(RAW);
    },
  });
  assert.equal(chain.root, 'NVDA');
  assert.deepEqual(hops, [URL_OK, `${URL_OK}?v=2`]);

  const redirectTo = (location: string) => async () => new Response(null, { status: 302, headers: { location } });
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: redirectTo('https://evil.example/NVDA.json') }), expectCode('redirect'));
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: redirectTo('http://cdn.cboe.com/NVDA.json') }), expectCode('redirect'));
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => new Response(null, { status: 301 }) }), expectCode('redirect'));
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: redirectTo(URL_OK) }), expectCode('redirect'), 'a loop ends');
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => new Response('nope', { status: 503 }) }), expectCode('http-status'));
});

test('fetchCboeChain: the deadline covers the request and the body', async () => {
  // Headers never arrive (and the fake ignores the signal, like a wedged proxy would).
  const started = Date.now();
  await assert.rejects(
    fetchCboeChain(URL_OK, { ...OPTS, timeoutMs: 50, fetchImpl: () => new Promise<Response>(() => undefined) }),
    expectCode('timeout'),
  );
  assert.ok(Date.now() - started < 2_000, 'returned promptly');

  // Headers arrive, then the body stalls after its first chunk.
  const body = streamBody([new TextEncoder().encode('{"timestamp": "2026-09-15 05:57:42", ')], true);
  await assert.rejects(
    fetchCboeChain(URL_OK, { ...OPTS, timeoutMs: 50, fetchImpl: async () => new Response(body.stream) }),
    expectCode('timeout'),
  );
  assert.equal(body.cancelled(), true, 'the stalled body is cancelled, not leaked');

  // A network error that is not the deadline is reported as such.
  await assert.rejects(
    fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    expectCode('network'),
  );
});

test('fetchCboeChain: the byte cap is enforced while streaming, and on a declared Content-Length', async () => {
  const chunk = new Uint8Array(1_000).fill(0x20);
  const body = streamBody(Array.from({ length: 20 }, () => chunk));
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, maxBytes: 5_000, fetchImpl: async () => new Response(body.stream) }), expectCode('oversize'));
  assert.equal(body.cancelled(), true, 'the download stops at the cap');

  const declared = streamBody([chunk]);
  await assert.rejects(
    fetchCboeChain(URL_OK, { ...OPTS, maxBytes: 5_000, fetchImpl: async () => new Response(declared.stream, { headers: { 'content-length': '9000000' } }) }),
    expectCode('oversize'),
  );
  // The synthetic chain fits under the default and fails a cap one byte below its length.
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, maxBytes: Buffer.byteLength(RAW) - 1, fetchImpl: async () => new Response(RAW) }), expectCode('oversize'));
});

test('fetchCboeChain: bad JSON, bad UTF-8 and a wrong shape are refused by name', async () => {
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => new Response('<html>Access denied</html>') }), expectCode('bad-json'));
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => new Response(RAW.slice(0, 5_000)) }), expectCode('bad-json'), 'truncated');
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])) }), expectCode('bad-json'));
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => new Response('{"data": {"options": []}}') }), expectCode('bad-shape'));
  await assert.rejects(fetchCboeChain(URL_OK, { ...OPTS, fetchImpl: async () => new Response('') }), expectCode('bad-json'));
});

/*//////////////////////////////////////////////////////////////
                     CONSISTENCY AND SESSIONS
//////////////////////////////////////////////////////////////*/

test('checkQuoteWindow: a gapped bracket, a rising delta, a vertical or butterfly arbitrage near it are inconsistent', () => {
  const q = quotesFor('2026-09-25');
  assert.equal(checkQuoteWindow(q, [222.5, 225]), null, 'the synthetic chain is clean');
  assert.equal(checkQuoteWindow(q, [225, 225]), null, 'an exact listing');
  const why = (r: ReturnType<typeof checkQuoteWindow>) => (r === null ? 'ok' : `${r.reason}: ${r.detail.why}`);
  // Gap: max(2.5, 2.5% of the lower strike). 215 -> 5.375: a 5 USD bracket passes, 7.5 does not.
  const without = (strikes: number[]) => q.filter((o) => !strikes.includes(o.strike));
  assert.equal(checkQuoteWindow(without([217.5]), [215, 220]), null);
  assert.match(why(checkQuoteWindow(without([217.5, 220]), [215, 222.5])), /vol-inconsistent: .*too far apart/);
  // A delta rising with the strike within one quote of the bracket.
  const bump = q.map((o) => (o.strike === 227.5 ? { ...o, delta: 0.5 } : o));
  assert.match(why(checkQuoteWindow(bump, [222.5, 225])), /delta rises/);
  assert.equal(checkQuoteWindow(bump, [212.5, 215]), null, 'far from the bracket it is not this decision’s business');
  // Vertical: 225 bid above 222.5's ask.
  const lowerAsk = q.find((o) => o.strike === 222.5)!.ask;
  const crossed = q.map((o) => (o.strike === 225 ? { ...o, bid: lowerAsk + 0.1, ask: lowerAsk + 0.14 } : o));
  assert.match(why(checkQuoteWindow(crossed, [222.5, 225])), /bid above a lower strike/);
  // Butterfly: 225 bid above the chord of 222.5 and 227.5 asks.
  const chord = (q.find((o) => o.strike === 222.5)!.ask + q.find((o) => o.strike === 227.5)!.ask) / 2;
  const bulge = q.map((o) => (o.strike === 225 ? { ...o, bid: chord + 0.1, ask: chord + 0.14 } : o));
  assert.match(why(checkQuoteWindow(bulge, [225, 227.5])), /convex/);
  assert.match(why(checkQuoteWindow(q, [222.5, 223])), /not in the usable quotes/);
});

test('strikeForDelta: a delta that climbs back over the target, or a gapped bracket, is inconsistent', () => {
  const q = quotesFor('2026-09-25');
  const r = ratio();
  const corrupt = q.map((o) => (o.strike === 232.5 ? { ...o, delta: 0.3 } : o));
  const c = strikeForDelta(corrupt, 0.15, r);
  assert.equal(!c.ok && c.reason, 'vol-inconsistent');
  assert.equal(!c.ok && c.detail.highStrike, '232.5');
  const holed = q.filter((o) => o.strike < 227.5 || o.strike > 235);
  const h = strikeForDelta(holed, 0.15, r);
  assert.equal(!h.ok && h.reason, 'vol-inconsistent');
  assert.match(!h.ok ? h.detail.why ?? '' : '', /too far apart/);
});

test('latestSettledSessionClose: weekends, holidays and the overnight grace', () => {
  const et = (y: number, mo: number, d: number, h: number, mi = 0) => {
    const unix = parseNewYorkLocalTime(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`);
    assert.ok(unix !== null);
    return unix;
  };
  const H = ['2026-11-26', '2027-03-26'];
  // Saturday 19 Sep 16:05 ET: Friday's close.
  assert.equal(latestSettledSessionClose(et(2026, 9, 19, 16, 5), H), et(2026, 9, 18, 16));
  // Monday 21 Sep 17:00 ET: Monday's close is not settled yet (grace), so Friday's.
  assert.equal(latestSettledSessionClose(et(2026, 9, 21, 17), H), et(2026, 9, 18, 16));
  // Tuesday 04:30 ET: Monday's (settled at 04:00).
  assert.equal(latestSettledSessionClose(et(2026, 9, 15, 4, 30), H), et(2026, 9, 14, 16));
  // Good Friday 2027: Saturday reads Thursday.
  assert.equal(latestSettledSessionClose(et(2027, 3, 27, 16, 5), H), et(2027, 3, 25, 16));
  // Across the DST change (Sun 1 Nov 2026): the EDT Friday close.
  assert.equal(latestSettledSessionClose(et(2026, 10, 31, 16, 5), H), Date.UTC(2026, 9, 30, 20, 0, 0) / 1000);
});

test('chainFreshness with the session calendar: a stuck file is stale on a Saturday arm, a normal weekend is not', () => {
  const holidays = ['2026-11-26', '2027-03-26'];
  const saturday = parseNewYorkLocalTime('2026-09-19T16:05:00')!;
  const chainAt = (lastTradeTime: string) => ({ lastTradeTime, timestamp: new Date((parseNewYorkLocalTime(lastTradeTime)! + 3_600) * 1000).toISOString().slice(0, 19).replace('T', ' ') });
  assert.equal(chainFreshness(chainAt('2026-09-18T15:59:59'), saturday, 345_600, holidays).ok, true, 'Friday close');
  for (const stuck of ['2026-09-17T15:59:59', '2026-09-16T15:59:59']) {
    const r = chainFreshness(chainAt(stuck), saturday, 345_600, holidays);
    assert.equal(!r.ok && r.reason, 'vol-stale', `${stuck} on a Saturday arm`);
    assert.equal(chainFreshness(chainAt(stuck), saturday, 345_600).ok, true, 'without the calendar, hours alone let it through');
  }
  // Tuesday 16:00 close on a Saturday 15:59 arm: exactly 96 h, inside maxAge, three sessions missed.
  const tue = chainFreshness(chainAt('2026-09-15T16:00:00'), parseNewYorkLocalTime('2026-09-19T15:59:00')!, 345_600, holidays);
  assert.equal(!tue.ok && tue.reason, 'vol-stale');
  // The day after Thanksgiving closes at 13:00: its last trade still counts for Saturday.
  assert.equal(chainFreshness(chainAt('2026-11-27T12:59:59'), parseNewYorkLocalTime('2026-11-28T16:05:00')!, 345_600, holidays).ok, true);
  // Good Friday: Thursday's close is the latest session.
  assert.equal(chainFreshness(chainAt('2027-03-25T15:59:59'), parseNewYorkLocalTime('2027-03-27T16:05:00')!, 345_600, holidays).ok, true);
  // DST weekend and an EST weekend.
  assert.equal(chainFreshness(chainAt('2026-10-30T15:59:59'), parseNewYorkLocalTime('2026-10-31T16:05:00')!, 345_600, holidays).ok, true);
  assert.equal(chainFreshness(chainAt('2026-11-06T15:59:59'), parseNewYorkLocalTime('2026-11-07T16:05:00')!, 345_600, holidays).ok, true);
});

test('checkVolMarket: a chain for another root, or one whose rows mostly do not parse, is inconsistent and says so', () => {
  const settings = { maxAgeS: 345_600, maxDivergenceBps: 300 };
  const ctx = { chain: CHAIN, error: null, closeDay: '2026-09-18', nowSeconds: NOW };
  const wrongRoot = checkVolMarket({ ...ctx, chain: { ...CHAIN, root: 'AAPL' } }, TOKEN_SPOT6, settings);
  assert.equal(!wrongRoot.ok && wrongRoot.reason, 'vol-inconsistent');
  assert.equal(!wrongRoot.ok && wrongRoot.detail.symbol, 'AAPL');
  assert.equal(checkVolMarket({ ...ctx, chain: { ...CHAIN, root: 'AAPL' } }, TOKEN_SPOT6, { ...settings, expectedRoot: 'AAPL' }).ok, true, 'the expected root is configurable');

  // `delta` renamed in every row: the old code called this 'vol-no-expiry'.
  const doc = JSON.parse(RAW) as { data: { symbol: string; options: Array<Record<string, unknown>> } };
  doc.data.options = doc.data.options.map(({ delta, ...rest }) => ({ ...rest, delta_v2: delta }));
  const drifted = parseCboeChain(doc);
  assert.equal(drifted.options.length, 0);
  assert.equal(drifted.firstSkip, 'delta: invalid_type');
  const r = checkVolMarket({ ...ctx, chain: drifted }, TOKEN_SPOT6, settings);
  assert.equal(!r.ok && r.reason, 'vol-inconsistent');
  assert.equal(!r.ok && r.detail.skippedRows, String(CHAIN.options.length));
  assert.equal(!r.ok && r.detail.firstSkip, 'delta: invalid_type');
  // A few bad rows are noise: the week still prices, and the count travels with a later skip.
  const few = { ...CHAIN, skippedRows: 3, firstSkip: 'symbol' };
  assert.equal(checkVolMarket({ ...ctx, chain: few }, TOKEN_SPOT6, settings).ok, true);
  const noExpiry = checkVolMarket({ ...ctx, chain: few, closeDay: '2026-10-02' }, TOKEN_SPOT6, settings);
  assert.equal(!noExpiry.ok && noExpiry.reason, 'vol-no-expiry');
  assert.equal(!noExpiry.ok && noExpiry.detail.skippedRows, '3');
});
