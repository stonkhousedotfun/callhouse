/**
 * SWEEP relay-09. keeper/src/alerts.ts:146-159 sends `factory` and `market` ("what the relay shows
 * first once there are 35 keepers behind it"); relay/src/payload.ts:28-40 does not declare them, so
 * zod strips both and contextLine (format.ts:43-52) never prints them. A factory keeper
 * (`vault: null`) arrives with no market or factory at all.
 *
 * Pass condition: the market and the factory reach both renderings.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDiscord, formatTelegram } from './format.js';
import { parseKeeperAlert } from './payload.js';

const FACTORY = '0xFac7000000000000000000000000000000000001';

test('v1 keeper payload keeps `market` and `factory` through validation and formatting', () => {
  const parsed = parseKeeperAlert({
    source: 'callhouse-keeper',
    kind: 'low_gas',
    severity: 'warn',
    message: 'hot key balance below threshold',
    vault: null,
    factory: FACTORY,
    market: 'NVDA',
    chainId: 4663,
    at: '2026-09-17T10:00:00.000Z',
    data: {},
  });
  assert.ok(parsed.ok);
  const discord = formatDiscord(parsed.alert).content;
  const telegram = formatTelegram(parsed.alert, '-100').text;
  for (const [name, text] of [['discord', discord], ['telegram', telegram]] as const) {
    assert.ok(text.includes('NVDA'), `${name} rendering has no market:\n${text}`);
    assert.ok(text.includes(FACTORY), `${name} rendering has no factory:\n${text}`);
  }
});
