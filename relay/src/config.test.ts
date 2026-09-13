/**
 * Boot configuration: what refuses to start, what the defaults are, and that no error message
 * ever repeats a secret it is complaining about.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseConfig } from './config.js';

const TOKEN = 'a'.repeat(64);

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error.issues;
  }
  assert.fail('expected parseConfig to throw');
}

test('discord only: defaults for port, timeout and Telegram base', () => {
  const config = parseConfig({ RELAY_TOKEN: TOKEN, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' });
  assert.equal(config.port, 8080);
  assert.equal(config.timeoutMs, 5000);
  assert.deepEqual(config.discord, { webhookUrl: 'https://discord.com/api/webhooks/1/x' });
  assert.equal(config.telegram, null);
});

test('telegram only, trailing slash on the API base is trimmed, PORT is read', () => {
  const config = parseConfig({
    RELAY_TOKEN: TOKEN,
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-1001234',
    TELEGRAM_API_BASE: 'http://127.0.0.1:9999/',
    PORT: '3001',
    RELAY_TIMEOUT_MS: '2500',
  });
  assert.equal(config.discord, null);
  assert.deepEqual(config.telegram, { botToken: '123:abc', chatId: '-1001234', apiBase: 'http://127.0.0.1:9999' });
  assert.equal(config.port, 3001);
  assert.equal(config.timeoutMs, 2500);
});

test('RELAY_TOKEN is required and must be long', () => {
  assert.ok(issuesOf({ DISCORD_WEBHOOK_URL: 'https://d/x' }).some((i) => i.startsWith('RELAY_TOKEN')));
  assert.ok(issuesOf({ RELAY_TOKEN: 'short', DISCORD_WEBHOOK_URL: 'https://d/x' }).some((i) => i.startsWith('RELAY_TOKEN')));
  // Railway keeps a cleared variable as "": that is unset, not a token.
  assert.ok(issuesOf({ RELAY_TOKEN: '   ', DISCORD_WEBHOOK_URL: 'https://d/x' }).some((i) => i.startsWith('RELAY_TOKEN')));
});

test('at least one target is required', () => {
  assert.ok(issuesOf({ RELAY_TOKEN: TOKEN }).some((i) => i.includes('no target configured')));
  assert.ok(issuesOf({ RELAY_TOKEN: TOKEN, DISCORD_WEBHOOK_URL: '' }).some((i) => i.includes('no target configured')));
});

test('Telegram token and chat id come as a pair', () => {
  assert.ok(issuesOf({ RELAY_TOKEN: TOKEN, TELEGRAM_BOT_TOKEN: '123:abc' }).some((i) => i.includes('set together')));
  assert.ok(issuesOf({ RELAY_TOKEN: TOKEN, DISCORD_WEBHOOK_URL: 'https://d/x', TELEGRAM_CHAT_ID: '1' }).some((i) => i.includes('set together')));
});

test('timeout is capped below the keeper’s own 10 s abort', () => {
  assert.ok(issuesOf({ RELAY_TOKEN: TOKEN, DISCORD_WEBHOOK_URL: 'https://d/x', RELAY_TIMEOUT_MS: '10000' }).some((i) => i.startsWith('RELAY_TIMEOUT_MS')));
});

test('no issue message echoes a secret value', () => {
  const secretUrl = 'ftp://discord.com/api/webhooks/999/SECRET-PATH';
  const issues = issuesOf({ RELAY_TOKEN: 'tooshort-SECRET', DISCORD_WEBHOOK_URL: secretUrl, TELEGRAM_BOT_TOKEN: '555:SECRET-BOT' });
  const text = issues.join('\n');
  assert.ok(issues.length >= 2);
  assert.ok(!text.includes('SECRET'), text);
});
