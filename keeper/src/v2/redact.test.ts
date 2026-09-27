/**
 * The URL rule every logger applies to its finished lines (redact.ts), and that the indexer's and the
 * notifier's copies of it agree with this one. FAKE keys only: nothing here is, or is shaped from, a real key.
 *
 *   tsx --test src/v2/redact.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactUrls } from './redact.js';
import { redactUrls as fromTx } from './tx.js';

/** [input, expected]. Every FAKE must be gone from the output; nothing else about the text changes. */
const CORPUS: readonly (readonly [string, string])[] = [
  ['https://robinhood-mainnet.g.alchemy.com/v2/FAKEKEY0123456789', 'https://robinhood-mainnet.g.alchemy.com/…'],
  ['https://lb.drpc.live/ogrpc?network=robinhood&dkey=FAKEKEY0123', 'https://lb.drpc.live/…'],
  ['wss://rpc.example.com/ws/FAKEKEY', 'wss://rpc.example.com/…'],
  ['https://fakeuser:FAKEPASS@rpc.example.com/', 'https://rpc.example.com/…'],
  ['https://rpc.example.com:8545/FAKEKEY', 'https://rpc.example.com:8545/…'],
  ['https://rpc.example.com/#FAKEFRAGMENT', 'https://rpc.example.com/…'],
  ['HTTPS://RPC.EXAMPLE.COM/v2/FAKEKEY', 'https://rpc.example.com/…'],
  // A host no list could know: the rule is the shape, not the provider.
  ['https://rpc.never-heard-of.example/abc/FAKEKEY', 'https://rpc.never-heard-of.example/…'],
  // A harmless path is cut too. That is the price of a rule by shape, and it is paid on purpose.
  ['http://relay.railway.internal:8080/alert', 'http://relay.railway.internal:8080/…'],
  // Bare origins carry nothing and stay exactly as written.
  ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.mainnet.chain.robinhood.com'],
  ['https://rpc.mainnet.chain.robinhood.com/', 'https://rpc.mainnet.chain.robinhood.com/'],
  // viem's HttpRequestError message shape: the URL on its own line, followed by more text.
  [
    'HTTP request failed.\n\nURL: https://robinhood-mainnet.g.alchemy.com/v2/FAKEKEY0123456789\nRequest body: {"method":"eth_getLogs"}',
    'HTTP request failed.\n\nURL: https://robinhood-mainnet.g.alchemy.com/…\nRequest body: {"method":"eth_getLogs"}',
  ],
  // PONDER_RPC_URL_4663's comma-separated form: the second key must not survive inside the first URL's path.
  ['rpc https://a.example/v2/FAKEA,https://b.example/FAKEB failed', 'rpc https://a.example/… failed'],
];

test('every keyed URL shape prints as scheme://host/…, a bare origin is left alone', () => {
  for (const [input, expected] of CORPUS) {
    const out = redactUrls(input);
    assert.equal(out, expected, input);
    assert.ok(!out.includes('FAKE'), `a FAKE survived: ${out}`);
  }
});

test('tx.ts still exports the same function its call sites import', () => {
  assert.equal(fromTx, redactUrls);
});

test('a finished JSON line stays JSON: a match never takes the backslash of an escape', () => {
  for (const [input] of CORPUS) {
    const line = JSON.stringify({ msg: `failed at "${input}"`, err: { message: input, stack: `Error: ${input}\n    at x (y.ts:1:1)` } });
    const out = redactUrls(line);
    const parsed = JSON.parse(out) as { msg: string; err: { message: string; stack: string } };
    assert.ok(!out.includes('FAKE'), `a FAKE survived: ${out}`);
    assert.equal(parsed.err.message, redactUrls(input), 'the redacted field reads as the redacted text');
    assert.match(parsed.msg, /^failed at "/);
  }
});

test('the indexer, notifier, relay and indexer-wrapper copies redact exactly as this one does', async () => {
  // Computed specifiers: those files sit outside this package's rootDir, so tsc must not follow them.
  // A change added the relay's copy and the indexer image's PID 1 wrapper (plain ESM, run by node, not tsx).
  const copies = [
    '../../../indexer/lib/redact.ts',
    '../../../notifier/src/redact.ts',
    '../../../indexer/lib/stdio-redact.mjs',
    '../../../relay/src/redact.ts',
  ];
  for (const rel of copies) {
    const specifier = new URL(rel, import.meta.url).href;
    const copy = (await import(specifier)) as { redactUrls: (text: string) => string };
    for (const [input] of CORPUS) assert.equal(copy.redactUrls(input), redactUrls(input), `${rel}: ${input}`);
    const line = JSON.stringify({ err: CORPUS.map(([input]) => input).join(' ') });
    assert.equal(copy.redactUrls(line), redactUrls(line), `${rel}: a whole JSON line`);
  }
});
