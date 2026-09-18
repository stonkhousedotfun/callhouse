/**
 * The MM bot's /fair client (pricing/server.ts serves it).
 *
 * WHY THIS FILE EXISTS: "never quote without a fair value" holds only if every way the pricing service can fail becomes a
 * `{ ok: false }` the engine halts on, never an exception that fails the tick (and the cancels in it) or a zero price.
 * Pinned: the request shape, a priced answer, a refusal with its reason code, non-200s, bodies of the wrong shape,
 * timeouts and refused connections, and answers kept in request order under concurrency.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRICING_CONCURRENCY } from './constants.js';
import { PricingClient, fairUrl, parseFairResponse } from './pricing-client.js';

const PRICED = { fair: { raw: '816164', decimals: 6, formatted: '0.816164' }, iv: 0.310557, delta: 0.183571, source: 'cboe', spot: { raw: '212210000', decimals: 6, formatted: '212.21' }, asOf: 1789415999 };

test('fairUrl: ticker, strike in base units, expiry, call or put', () => {
  assert.equal(fairUrl('http://pricing.railway.internal:8790/', { ticker: 'NVDA', strike: 220_000_000n, expiry: 1789761600, isPut: false }), 'http://pricing.railway.internal:8790/fair?ticker=NVDA&strike=220000000&expiry=1789761600&type=call');
  assert.match(fairUrl('http://p', { ticker: 'TSLA', strike: 1n, expiry: 2, isPut: true }), /type=put$/);
});

test('parseFairResponse: priced, refused with a reason, refused by status, and malformed bodies', () => {
  assert.deepEqual(parseFairResponse(200, PRICED), { ok: true, fair: 816_164n, delta: 0.183571, iv: 0.310557, asOf: 1789415999, source: 'cboe', spot: 212_210_000n });
  const { spot: _spot, ...withoutSpot } = PRICED;
  assert.equal('spot' in parseFairResponse(200, withoutSpot), false, 'an answer without a spot is not checked against the oracle');
  assert.deepEqual(parseFairResponse(200, { fair: null, reason: 'chain-stale', detail: 'x' }), { ok: false, reason: 'chain-stale' });
  assert.deepEqual(parseFairResponse(404, { error: { code: 'unknown-ticker' } }), { ok: false, reason: 'pricing-http-404' });
  assert.deepEqual(parseFairResponse(400, { fair: null, reason: 'bad-request' }), { ok: false, reason: 'pricing-http-400:bad-request' });
  for (const body of [null, {}, { ...PRICED, fair: { raw: '-1' } }, { ...PRICED, fair: { raw: '1.5' } }, { ...PRICED, delta: 'x' }, { ...PRICED, asOf: -1 }, { ...PRICED, iv: Number.NaN }]) {
    assert.deepEqual(parseFairResponse(200, body), { ok: false, reason: 'pricing-bad-body' }, JSON.stringify(body));
  }
});

test('PricingClient: network failures and timeouts are reasons, never throws', async () => {
  const unreachable = new PricingClient({ baseUrl: 'http://p', timeoutMs: 1_000, fetch: async () => Promise.reject(new TypeError('fetch failed')) });
  assert.deepEqual(await unreachable.fair({ ticker: 'NVDA', strike: 1n, expiry: 1, isPut: false }), { ok: false, reason: 'pricing-unreachable' });

  const slow = new PricingClient({
    baseUrl: 'http://p',
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout's timer does not keep the event loop alive (on Node 22 the test runner then cancels the
        // test with the promise pending, the image's and CI's runtime): a ref'd timer holds it until the abort.
        const hold = setTimeout(() => undefined, 10_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(hold);
          reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
        });
      }),
  });
  assert.deepEqual(await slow.fair({ ticker: 'NVDA', strike: 1n, expiry: 1, isPut: false }), { ok: false, reason: 'pricing-timeout' });

  const html = new PricingClient({ baseUrl: 'http://p', timeoutMs: 1_000, fetch: async () => new Response('<html>', { status: 502 }) });
  assert.deepEqual(await html.fair({ ticker: 'NVDA', strike: 1n, expiry: 1, isPut: false }), { ok: false, reason: 'pricing-http-502' });
});

test('fairMany: answers in request order, at most PRICING_CONCURRENCY in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];
  const client = new PricingClient({
    baseUrl: 'http://p',
    timeoutMs: 1_000,
    fetch: async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const strike = new URL(String(url)).searchParams.get('strike')!;
      seen.push(strike);
      await new Promise((r) => setTimeout(r, 5 + (Number(strike) % 3) * 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ ...PRICED, fair: { raw: strike, decimals: 6, formatted: '' } }), { status: 200 });
    },
  });
  const requests = Array.from({ length: 20 }, (_, i) => ({ ticker: 'NVDA', strike: BigInt(i + 1), expiry: 1, isPut: false }));
  const out = await client.fairMany(requests);
  assert.deepEqual(out.map((f) => (f.ok ? f.fair : null)), requests.map((r) => r.strike));
  assert.equal(peak, PRICING_CONCURRENCY);
  assert.equal(seen.length, 20);
  assert.deepEqual(await client.fairMany([]), []);
});
