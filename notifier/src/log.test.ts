/**
 * The notifier's line writer puts every finished line through redactUrls (./redact.ts), so a keyed URL a
 * call site should not have logged still prints only its host. FAKE values only.
 *
 *   tsx --test src/log.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from './log.js';

const KEYED_RPC = 'https://robinhood-mainnet.g.alchemy.com/v2/FAKEKEY0123456789abcdef';
const BOT_API = 'https://api.telegram.org/botFAKE123:FAKETOKENabcdef/getUpdates';

test('an error carrying a keyed URL, logged by message or in a field, prints only the host', () => {
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line));
  const error = new Error(`HTTP request failed.\n\nURL: ${KEYED_RPC}\nRequest body: {"method":"eth_call"}`);
  log.error({ reason: String(error) }, 'signature verification failed');
  log.warn({ endpoint: BOT_API, nested: { urls: [KEYED_RPC] } }, `poll ${BOT_API} failed`);
  log.info({ indexer: 'http://indexer-v2.railway.internal:42069', app: 'https://app.stonkhouse.fun' }, 'boot');

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(!line.includes('FAKE'), `a key reached the log: ${line}`);
    JSON.parse(line);
  }
  assert.ok(lines[0]!.includes('https://robinhood-mainnet.g.alchemy.com/…'), 'the RPC host is still named');
  assert.ok(lines[1]!.includes('https://api.telegram.org/…'), 'the Bot API host is still named');
  const boot = JSON.parse(lines[2]!) as { indexer: string; app: string; service: string; msg: string };
  assert.deepEqual([boot.indexer, boot.app], ['http://indexer-v2.railway.internal:42069', 'https://app.stonkhouse.fun'], 'bare origins are left alone');
  assert.equal(boot.service, 'callhouse-notifier');
  assert.equal(boot.msg, 'boot');
});
