/**
 * SWEEP relay-14. ops/alerts.md Routing: `error` = webhook, unmuted; `info` = webhook, log only,
 * who: Nobody. formatTelegram (format.ts:99-107) never sets `disable_notification`, so every info
 * alert (v2_boot x3 per deploy, v2_mon_resolved, v2_mon_safe_nonce_changed) rings phones exactly
 * like an error page.
 *
 * Pass condition: Telegram info alerts are sent silently; error alerts are not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTelegram } from './format.js';

test('Telegram: info is silent (disable_notification), error still notifies', () => {
  const info = formatTelegram({ kind: 'v2_boot', severity: 'info', message: 'cranker booted' }, '-100') as unknown as Record<string, unknown>;
  const error = formatTelegram({ kind: 'v2_settlement_held', severity: 'error', message: 'held' }, '-100') as unknown as Record<string, unknown>;
  assert.equal(info.disable_notification, true, `info body: ${JSON.stringify(info)}`);
  assert.notEqual(error.disable_notification, true);
});
