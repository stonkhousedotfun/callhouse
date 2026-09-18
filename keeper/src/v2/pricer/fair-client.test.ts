/**
 * The pricing service's /fair as the pricer reads it (fair-client.ts), over a fake fetch.
 *
 * WHY THIS FILE EXISTS: the pricer moves a writer's ask to a number this client returns, and leaves
 * the ask alone whenever it returns nothing. So every way the service can fail to give a price must
 * come back as `{ ok: false }` and never as a throw (which would fail the tick for every writer) or as
 * a number read out of the wrong field. The body shapes are pricing/server.ts fairResponse's.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fairResponse, parseFairQuery } from '../pricing/server.js';
import { PricingClient, parseFairBody } from './fair-client.js';

const REQUEST = { ticker: 'NVDA', strike: 220_000_000n, expiry: 1_789_761_600, type: 'call' as const };

function fakeFetch(respond: (url: string) => Response | Error, seen: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const r = respond(url);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('a priced answer: the query carries ticker, strike, expiry and type; fair.raw is the price (the pricing service\'s own body)', async () => {
  const { status, body } = fairResponse({ ok: true, fairUsdg6: 816_164n, iv: 0.310557, delta: 0.183571, source: 'cboe', method: 'listed-contract', days: ['2026-09-18'], spotUsdg6: 212_210_000n, asOf: 1_789_415_999 });
  const seen: string[] = [];
  const client = new PricingClient({ baseUrl: 'http://pricing:8790', timeoutMs: 1_000, fetch: fakeFetch(() => json(body, status), seen) });
  assert.deepEqual(await client.fair(REQUEST), { ok: true, fair: 816_164n, source: 'cboe', asOf: 1_789_415_999 });
  assert.equal(seen[0], 'http://pricing:8790/fair?ticker=NVDA&strike=220000000&expiry=1789761600&type=call');
  // The service's own query parser reads back exactly the series asked about (strike in USDG base units, not dollars).
  assert.deepEqual(parseFairQuery(Object.fromEntries(new URL(seen[0]!).searchParams)), { ok: true, ticker: 'NVDA', strikeUsdg6: 220_000_000n, expiry: 1_789_761_600, type: 'call' });
});

test('no price: fair null with a reason (200), bad request (400), unknown ticker (404), a 500, an unreachable service, a non-JSON body', async () => {
  const cases: Array<[Response | Error, string]> = [
    [json(fairResponse({ ok: false, reason: 'chain-stale', detail: { lastTrade: '2 days ago' } }).body), 'chain-stale'],
    [json({ fair: null, reason: 'bad-request', detail: { strike: '…' } }, 400), 'HTTP 400: bad-request'],
    [json({ fair: null, reason: 'unknown-ticker' }, 404), 'HTTP 404: unknown-ticker'],
    [json({ fair: null, reason: 'internal-error' }, 500), 'HTTP 500: internal-error'],
    [new TypeError('fetch failed'), 'unreachable: fetch failed'],
    [new Response('<html>bad gateway</html>', { status: 502 }), 'HTTP 502: not JSON'],
  ];
  for (const [response, reason] of cases) {
    const client = new PricingClient({ baseUrl: 'http://pricing:8790', timeoutMs: 1_000, fetch: fakeFetch(() => response) });
    assert.deepEqual(await client.fair(REQUEST), { ok: false, reason });
  }
});

test('parseFairBody: a fair that is not a canonical integer string, or a 200 with no fair field, is refused rather than guessed', () => {
  assert.deepEqual(parseFairBody(200, { fair: { raw: '0.816164', decimals: 6 } }), { ok: false, reason: 'fair.raw is not a non-negative integer string' });
  assert.deepEqual(parseFairBody(200, { fair: { raw: '-5' } }), { ok: false, reason: 'fair.raw is not a non-negative integer string' });
  assert.deepEqual(parseFairBody(200, { fair: { raw: 816164 } }), { ok: false, reason: 'fair.raw is not a non-negative integer string' });
  assert.deepEqual(parseFairBody(200, { price: '1' }), { ok: false, reason: 'HTTP 200: unexpected body' });
  assert.deepEqual(parseFairBody(200, 'nope'), { ok: false, reason: 'HTTP 200: not a JSON object' });
  assert.deepEqual(parseFairBody(200, { fair: null }), { ok: false, reason: 'HTTP 200' });
  assert.deepEqual(parseFairBody(200, { fair: { raw: '0' }, source: 'model' }), { ok: true, fair: 0n, source: 'model', asOf: null });
});
