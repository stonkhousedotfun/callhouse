/**
 * The relay logger is the backstop the call sites are not. Every finished line goes through redactUrls
 * (./redact.ts) before the sink, so a Discord webhook URL (its path is the secret), a Telegram bot<TOKEN> URL and a
 * `?token=` URL print as scheme://host/… whether they arrive as a field value or inside an error's text. FAKE values
 * only.
 *
 *   tsx --test src/log.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from './log.js';

const CASES = [
  ['discord webhook', 'https://discord.com/api/webhooks/123456789012345678/FAKE-DISCORD-WEBHOOK-TOKEN', 'https://discord.com/…'],
  ['telegram bot', 'https://api.telegram.org/bot123456:FAKE-TELEGRAM-BOT-TOKEN/sendMessage', 'https://api.telegram.org/…'],
  ['token query', 'http://relay.railway.internal:8080/alert?token=FAKE-RELAY-TOKEN', 'http://relay.railway.internal:8080/…'],
] as const;

function capture() {
  const lines: string[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}

for (const [name, url, redacted] of CASES) {
  test(`${name}: as a field value it prints as scheme://host/…, and the line parses`, () => {
    const { lines, logger } = capture();
    logger.warn({ target: name, url }, 'delivery failed');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes('FAKE'), `a FAKE survived: ${lines[0]}`);
    const parsed = JSON.parse(lines[0]!) as { url: string; msg: string; level: string };
    assert.equal(parsed.url, redacted);
    assert.equal(parsed.msg, 'delivery failed');
    assert.equal(parsed.level, 'warn');
  });

  test(`${name}: inside an Error's text (message and String(err)) it prints as scheme://host/…`, () => {
    const { lines, logger } = capture();
    const error = new TypeError(`fetch failed for ${url} (ECONNRESET)`);
    logger.error({ error: error.message, detail: String(error) }, 'delivery threw');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes('FAKE'), `a FAKE survived: ${lines[0]}`);
    const parsed = JSON.parse(lines[0]!) as { error: string; detail: string };
    assert.equal(parsed.error, `fetch failed for ${redacted} (ECONNRESET)`);
    assert.equal(parsed.detail, `TypeError: fetch failed for ${redacted} (ECONNRESET)`);
  });
}

test('the default sink writes the same redacted line to stdout', () => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    createLogger().info({ url: CASES[0][1] }, 'probe');
  } finally {
    process.stdout.write = original;
  }
  assert.equal(written.length, 1);
  assert.ok(!written[0]!.includes('FAKE'));
  assert.ok(written[0]!.endsWith('\n'));
  assert.equal((JSON.parse(written[0]!) as { url: string }).url, CASES[0][2]);
});

test('a line with no URL is unchanged: the backstop does not rewrite ordinary fields', () => {
  const { lines, logger } = capture();
  logger.info({ target: 'discord', status: 502, code: 'upstream_5xx' }, 'delivery failed');
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual({ target: parsed.target, status: parsed.status, code: parsed.code }, { target: 'discord', status: 502, code: 'upstream_5xx' });
});
