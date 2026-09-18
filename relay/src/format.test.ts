/**
 * Payload validation and the two renderings, as pure functions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DISCORD_CONTENT_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  formatDiscord,
  formatTelegram,
  truncate,
} from './format.js';
import { parseKeeperAlert, type KeeperAlert } from './payload.js';

/** Exactly what keeper/src/alerts.ts sends (ops/alerts.md, "The contract"). */
export const SAMPLE = {
  source: 'callhouse-keeper',
  kind: 'tx_revert',
  severity: 'error',
  message: 'rollOpen reverted on chain',
  vault: '0x1111111111111111111111111111111111111111',
  chainId: 4663,
  at: '2026-09-12T20:00:00.000Z',
  data: { kind: 'rollOpen', hash: '0xabc', gasUsed: '21000' },
} as const;

function alertOf(overrides: Record<string, unknown> = {}): KeeperAlert {
  const parsed = parseKeeperAlert({ ...SAMPLE, ...overrides });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.alert;
}

/* ---------------------------------------------------------------- validation */

test('the keeper’s own payload validates', () => {
  const parsed = parseKeeperAlert(SAMPLE);
  assert.ok(parsed.ok);
  assert.equal(parsed.alert.kind, 'tx_revert');
  assert.equal(parsed.alert.severity, 'error');
});

test('a kind the relay has never heard of is accepted (keeper and relay deploy separately)', () => {
  assert.ok(parseKeeperAlert({ ...SAMPLE, kind: 'some_future_kind' }).ok);
});

test('minimal payload: kind, severity, message', () => {
  assert.ok(parseKeeperAlert({ kind: 'boot', severity: 'info', message: 'online' }).ok);
});

test('invalid payloads are refused with the offending path', () => {
  const cases: [unknown, string][] = [
    [{ ...SAMPLE, severity: 'fatal' }, 'severity'],
    [{ ...SAMPLE, severity: undefined }, 'severity'],
    [{ ...SAMPLE, kind: 'TX REVERT' }, 'kind'],
    [{ ...SAMPLE, message: '' }, 'message'],
    [{ ...SAMPLE, message: 42 }, 'message'],
    [{ ...SAMPLE, chainId: '4663' }, 'chainId'],
    [{ ...SAMPLE, data: 'not an object' }, 'data'],
    [['not', 'an', 'object'], '(root)'],
    [null, '(root)'],
  ];
  for (const [body, path] of cases) {
    const parsed = parseKeeperAlert(body);
    assert.equal(parsed.ok, false, `expected refusal for ${JSON.stringify(body)}`);
    if (!parsed.ok) assert.ok(parsed.issues.some((i) => i.path === path), `${path} in ${JSON.stringify(parsed.issues)}`);
  }
});

test('a very long message is not refused — it is truncated at format time', () => {
  assert.ok(parseKeeperAlert({ ...SAMPLE, message: 'x'.repeat(50_000) }).ok);
});

/* ---------------------------------------------------------------- truncate */

test('truncate keeps short strings, cuts long ones to the limit, never splits a surrogate pair', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abcdefghij', 5).length, 5);
  const emoji = `ab${'🔴'.repeat(5)}`; // each 🔴 is two UTF-16 units
  for (let max = 2; max <= emoji.length; max += 1) {
    const out = truncate(emoji, max);
    assert.ok(out.length <= max);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), `lone high surrogate at max=${max}`);
  }
});

/* ---------------------------------------------------------------- Discord */

test('Discord: severity prefix, kind, message, context, data block, no mentions', () => {
  const body = formatDiscord(alertOf());
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  const lines = body.content.split('\n');
  assert.equal(lines[0], '🔴 **ERROR** `tx_revert` rollOpen reverted on chain');
  assert.equal(lines[1], 'vault 0x1111111111111111111111111111111111111111 · chain 4663 · 2026-09-12T20:00:00.000Z · callhouse-keeper');
  assert.equal(lines[2], '```json');
  assert.ok(body.content.includes('"hash": "0xabc"'));
  assert.ok(body.content.endsWith('\n```'));
});

test('Discord: warn and info prefixes', () => {
  assert.ok(formatDiscord(alertOf({ severity: 'warn', kind: 'low_gas' })).content.startsWith('🟠 **WARN** `low_gas`'));
  assert.ok(formatDiscord(alertOf({ severity: 'info', kind: 'boot' })).content.startsWith('🔵 **INFO** `boot`'));
});

test('Discord: empty data renders no code block', () => {
  const body = formatDiscord(alertOf({ data: {} }));
  assert.ok(!body.content.includes('```'));
});

test('Discord: oversized data is truncated to ≤ 2000 with the header intact and the fence closed', () => {
  const reason = 'The contract function "rollOpen" reverted. '.repeat(400); // ~17k chars
  const body = formatDiscord(alertOf({ data: { reason } }));
  assert.ok(body.content.length <= DISCORD_CONTENT_LIMIT, `length ${body.content.length}`);
  assert.ok(body.content.startsWith('🔴 **ERROR** `tx_revert` rollOpen reverted on chain\n'));
  assert.ok(body.content.includes('… (truncated)'));
  assert.ok(body.content.endsWith('\n```'));
  assert.equal(body.content.split('```').length - 1, 2, 'exactly one opening and one closing fence');
});

test('Discord: an oversized message alone is cut to ≤ 2000 and data is dropped with a note', () => {
  const body = formatDiscord(alertOf({ message: 'm'.repeat(5000) }));
  assert.ok(body.content.length <= DISCORD_CONTENT_LIMIT);
  assert.ok(body.content.startsWith('🔴 **ERROR** `tx_revert` mmm'));
  assert.ok(!body.content.includes('```json'));
});

test('Discord: a triple backtick inside data cannot close the code block early', () => {
  const body = formatDiscord(alertOf({ data: { reason: 'evil ``` @everyone' } }));
  assert.equal(body.content.split('```').length - 1, 2);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

/* ---------------------------------------------------------------- Telegram */

test('Telegram: plain text, chat id, severity first, data after', () => {
  const body = formatTelegram(alertOf(), '-1001234');
  assert.equal(body.chat_id, '-1001234');
  assert.equal(body.disable_web_page_preview, true);
  assert.ok(!('parse_mode' in body), 'plain text: nothing to escape, nothing to inject');
  const lines = body.text.split('\n');
  assert.equal(lines[0], '🔴 ERROR tx_revert');
  assert.equal(lines[1], 'rollOpen reverted on chain');
  assert.ok(lines[2]?.startsWith('vault 0x1111'));
  assert.ok(body.text.includes('\n\ndata:\n{'));
});

test('Telegram: oversized data is truncated to ≤ 4096', () => {
  const body = formatTelegram(alertOf({ data: { reason: 'r'.repeat(20_000) } }), '1');
  assert.ok(body.text.length <= TELEGRAM_TEXT_LIMIT, `length ${body.text.length}`);
  assert.ok(body.text.startsWith('🔴 ERROR tx_revert\nrollOpen reverted on chain'));
  assert.ok(body.text.endsWith('… (truncated)'));
});

test('a factory-only keeper alert with vault: null parses and prints no vault', () => {
  const parsed = parseKeeperAlert({ kind: 'low_gas', severity: 'warn', message: 'gas low', vault: null, chainId: 4663 });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const text = formatDiscord(parsed.alert);
  assert.ok(!JSON.stringify(text).includes('vault '));
});
