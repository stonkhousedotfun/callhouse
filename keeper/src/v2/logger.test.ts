/**
 * No keeper log line carries an RPC key. The v2 modes' logger is exercised with the lines it really writes;
 * the v1 keeper's logger and the pricing service's own pino are checked for the same hook, since both build their
 * logger at import or boot from a full environment. FAKE keys only.
 *
 *   tsx --test src/v2/logger.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BaseError, HttpRequestError } from 'viem';
import { createV2Logger } from './logger.js';

const KEYED = 'https://robinhood-mainnet.g.alchemy.com/v2/FAKEKEY0123456789abcdef';
const HOST = 'https://robinhood-mainnet.g.alchemy.com/…';

function capture() {
  const lines: string[] = [];
  const log = createV2Logger({ level: 'info', mode: 'cranker', destination: { write: (s: string) => void lines.push(s) } });
  return { log, lines };
}

test('an error carrying a keyed RPC URL, logged whole, prints only the host', () => {
  const { log, lines } = capture();
  const err = new HttpRequestError({ url: KEYED, status: 429, body: { method: 'eth_getLogs' } });
  // The raw error really does carry the key in every field pino serializes: message, stack and url.
  assert.ok(err.message.includes('FAKEKEY') && (err.stack ?? '').includes('FAKEKEY') && err.url.includes('FAKEKEY'));
  log.error({ err }, 'rpc failed');
  log.warn({ cause: new BaseError('simulation failed', { cause: err }) }, `retrying ${KEYED}`);
  log.child({ mod: 'steps' }).info({ url: KEYED, rpcUrls: [KEYED, 'https://rpc.mainnet.chain.robinhood.com'] }, 'boot');

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(!line.includes('FAKEKEY'), `the key reached the log: ${line}`);
    assert.ok(line.includes(HOST), `the host is still named: ${line}`);
    JSON.parse(line); // every line is still one JSON object
  }
  const boot = JSON.parse(lines[2]!) as { rpcUrls: string[]; mod: string };
  assert.deepEqual(boot.rpcUrls, [HOST, 'https://rpc.mainnet.chain.robinhood.com'], 'a bare origin is left alone');
  assert.equal(boot.mod, 'steps', 'child loggers inherit the hook');
});

test('POSITIVE CONTROL: without the hook the same line leaks, so the assertion above can fail', async () => {
  const { pino } = await import('pino');
  const lines: string[] = [];
  const bare = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
  bare.error({ err: new HttpRequestError({ url: KEYED, status: 429 }) }, 'rpc failed');
  assert.ok(lines[0]!.includes('FAKEKEY'), 'pino alone prints the keyed URL');
});

test('the v1 keeper logger and the pricing service logger apply the same hook', () => {
  const v1 = readFileSync(new URL('../logger.ts', import.meta.url), 'utf8');
  assert.match(v1, /^import \{ redactUrls \} from '\.\/v2\/redact\.js';$/m);
  assert.match(v1, /^\s+streamWrite: redactUrls,$/m);
  const pricing = readFileSync(new URL('./pricing/main.ts', import.meta.url), 'utf8');
  const block = pricing.match(/const log = pino\(\{([\s\S]*?)\n {2}\}\);/)?.[1];
  assert.ok(block, 'the pricing service builds its pino where this test reads it');
  assert.match(block, /hooks: \{ streamWrite: redactUrls \}/);
});
