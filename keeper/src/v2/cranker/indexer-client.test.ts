/**
 * The two indexer routes the cranker pages (indexer-client.ts), over a fake fetch.
 *
 * WHY THIS FILE EXISTS: the indexer is optional for the cranker, so every way it can be unusable
 * must come back as `{ ok: false }` (the cranker then uses its log index) and never as a throw that
 * fails the redeem step, or as a partial list that reads as complete.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexerClient, PAGE_LIMIT } from './indexer-client.js';

const A = '0x976ea74026e726554db657fa54763abd0c3a0aa9';
const B = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';

function fakeFetch(pages: Record<string, { status?: number; body: unknown } | Error>, seen: string[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const key = Object.keys(pages).find((k) => url.includes(k));
    const page = key === undefined ? new Error(`no fake for ${url}`) : pages[key]!;
    if (page instanceof Error) throw page;
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200 });
  }) as typeof fetch;
}

test('holders: pages until nextCursor is null, checksums, passes side, limit and cursor', async () => {
  const seen: string[] = [];
  const client = new IndexerClient({
    baseUrl: 'http://indexer:42069',
    timeoutMs: 1_000,
    fetch: fakeFetch(
      {
        'cursor=0x9': { body: { items: [{ holder: B, units: '5' }], nextCursor: null } },
        'side=short': { body: { items: [{ holder: A, units: '150' }], nextCursor: '0x9' } },
      },
      seen,
    ),
  });
  const result = await client.holders(123n, 'short');
  assert.deepEqual(result, { ok: true, items: ['0x976EA74026E726554dB657fA54763abd0C3a0aa9', B] });
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /^http:\/\/indexer:42069\/v2\/series\/123\/holders\?side=short&limit=200$/);
  assert.match(seen[1]!, /cursor=0x9/);
  assert.equal(PAGE_LIMIT, 200);
});

test('down, erroring or malformed: ok false with the reason, never a throw', async () => {
  const cases: Array<[Record<string, { status?: number; body: unknown } | Error>, RegExp]> = [
    [{ holders: new Error('connect ECONNREFUSED') }, /unreachable: connect ECONNREFUSED/],
    [{ holders: { status: 503, body: { error: { code: 'lagging' } } } }, /HTTP 503/],
    [{ holders: { body: { rows: [] } } }, /unexpected body/],
    [{ holders: { body: { items: [{ units: '1' }], nextCursor: null } } }, /without a holder address/],
  ];
  for (const [pages, reason] of cases) {
    const client = new IndexerClient({ baseUrl: 'http://indexer:42069', timeoutMs: 1_000, fetch: fakeFetch(pages, []) });
    const result = await client.holders(1n, 'long');
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, reason);
  }
});

test('activeStrategies: writer and underlying pairs from /v2/strategies?active=1', async () => {
  const seen: string[] = [];
  const client = new IndexerClient({
    baseUrl: 'http://indexer:42069',
    timeoutMs: 1_000,
    fetch: fakeFetch({ strategies: { body: { items: [{ writer: A, underlying: B, ticker: 'NVDA', strategy: {} }], nextCursor: null } } }, seen),
  });
  assert.deepEqual(await client.activeStrategies(), { ok: true, items: [{ writer: '0x976EA74026E726554dB657fA54763abd0C3a0aa9', underlying: B }] });
  assert.match(seen[0]!, /\/v2\/strategies\?active=1&limit=200$/);
  const bad = new IndexerClient({ baseUrl: 'http://i', timeoutMs: 1_000, fetch: fakeFetch({ strategies: { body: { items: [{ writer: 'nope' }], nextCursor: null } } }, []) });
  assert.equal((await bad.activeStrategies()).ok, false);
});
