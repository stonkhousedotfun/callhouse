/**
 * notifier-06 / notifier-11 (medium): one circuit breaker per CHANNEL (delivery.ts:133-137), and
 * every transient outcome counts (delivery.ts:296-299). Web Push endpoints are user input on any
 * public-looking name, so a free wallet with 5 endpoints that answer 500 (or do not resolve) opens
 * the webpush breaker, and every other user's Web Push is postponed, then dropped as stale after
 * 6 h. The 10-endpoint cap on codex/v2-integration (b0acd9a) does not help: wallets are free.
 * Expected after the fix: an attacker's endpoints cannot delay another user's push.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { getAddress } from 'viem';
import { webPushChannel } from './channels/webpush.js';
import { createTargetCipher } from './crypto.js';
import { dedupeKey, DeliveryService } from './delivery.js';
import { prefsSchema } from './prefs.js';
import { upsertWebPush } from './store.js';
import { appLinks } from './templates.js';
import { browserSubscription, captureLogger, createTestDb, SAMPLE_PAYLOADS, SERIES_221, TEST_DATA_KEY_HEX, TEST_VAPID, TestClock, type TestDb } from './testing.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const links = appLinks('https://app.stonkhouse.test');
const ATTACKER = getAddress('0xa77ac4e5a77ac4e5a77ac4e5a77ac4e5a77ac4e5');
const USER = '0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';
let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
});

async function addPush(address: string, endpoint: string, prefs: unknown, now: Date) {
  const target = JSON.stringify(browserSubscription(endpoint));
  return upsertWebPush(db, { address, targetEnc: cipher.encrypt(target, `webpush:${address}`), targetHash: cipher.hash(`webpush:${endpoint}`), prefs: prefsSchema.parse(prefs), now });
}

test('five failing attacker push endpoints do not postpone another wallet\'s Web Push', async () => {
  const clock = new TestClock();
  const hits: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).host;
    hits.push(host);
    if (host.endsWith('.attacker.example')) return new Response('nope', { status: 500 });
    return new Response(null, { status: 201 });
  };
  try {
    // Free trigger: a price alert that is already true fires on the next rules tick.
    const alertPrefs = { priceAlerts: [{ ticker: 'NVDA', above: '1' }] };
    for (let i = 0; i < 5; i += 1) await addPush(ATTACKER, `https://p${i}.attacker.example/x`, alertPrefs, clock.now());
    await addPush(USER, 'https://fcm.googleapis.com/fcm/send/legit', {}, clock.now());
    const delivery = new DeliveryService({ db, cipher, links, logger: captureLogger().logger, now: clock.now, channels: { webpush: webPushChannel({ ...TEST_VAPID, subject: 'https://app.stonkhouse.test' }) } });
    const priceAlert = { ticker: 'NVDA', direction: 'above', threshold: { raw: '1', decimals: 6, formatted: '0.000001' }, spot: SAMPLE_PAYLOADS.price_alert.spot };
    const attackerQueued = await delivery.enqueue('price_alert', ATTACKER, priceAlert, dedupeKey('price_alert', ATTACKER, 'NVDA', 'above-1-2026-09-16'));
    clock.advance(1_000);
    await delivery.enqueue('fill_receipt', USER, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', USER, SERIES_221.longId, 'fill-1'));
    await delivery.runOnce();
    const { rows } = await db.query<{ status: string; attempts: number; next_attempt_at: Date }>(
      `SELECT d.status, d.attempts, d.next_attempt_at FROM notifier.delivery d JOIN notifier.subscription s ON s.id = d.subscription_id WHERE s.address = $1`,
      [USER],
    );
    console.log(`attacker rows queued: ${attackerQueued.queued}; push hosts contacted: ${JSON.stringify(hits)}`);
    console.log(`webpush breaker: ${delivery.breakerStates().webpush}; other wallet's delivery: ${JSON.stringify(rows[0])}`);
    assert.ok(hits.includes('fcm.googleapis.com'), 'the other wallet\'s push was never attempted');
    assert.equal(rows[0]?.status, 'sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one failed push host cannot block another host, even after its breaker opens', async () => {
  const clock = new TestClock();
  const hits: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).host;
    hits.push(host);
    return new Response(null, { status: host === 'bad.attacker.example' ? 500 : 201 });
  };
  try {
    const alertPrefs = { priceAlerts: [{ ticker: 'NVDA', above: '1' }] };
    for (let i = 0; i < 5; i += 1) await addPush(ATTACKER, `https://bad.attacker.example/x/${i}`, alertPrefs, clock.now());
    await addPush(USER, 'https://fcm.googleapis.com/fcm/send/legit', {}, clock.now());
    const delivery = new DeliveryService({ db, cipher, links, logger: captureLogger().logger, now: clock.now, channels: { webpush: webPushChannel({ ...TEST_VAPID, subject: 'https://app.stonkhouse.test' }) } });
    const priceAlert = { ticker: 'NVDA', direction: 'above', threshold: { raw: '1', decimals: 6, formatted: '0.000001' }, spot: SAMPLE_PAYLOADS.price_alert.spot };
    await delivery.enqueue('price_alert', ATTACKER, priceAlert, dedupeKey('price_alert', ATTACKER, 'NVDA', 'above-1-2026-09-16'));
    clock.advance(1_000);
    await delivery.enqueue('fill_receipt', USER, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', USER, SERIES_221.longId, 'fill-1'));
    await delivery.runOnce();
    assert.equal(delivery.breakerStates().webpush, 'open', 'the failing host has opened its breaker');
    assert.ok(hits.includes('fcm.googleapis.com'), 'a healthy push host still received its request');
    const { rows } = await db.query<{ status: string }>(
      `SELECT d.status FROM notifier.delivery d JOIN notifier.subscription s ON s.id = d.subscription_id WHERE s.address = $1`, [USER],
    );
    assert.equal(rows[0]?.status, 'sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one subscription getting 429 does not open a shared push-service breaker', async () => {
  const clock = new TestClock();
  const hits: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    hits.push(path);
    return new Response(null, { status: path.includes('/noisy/') ? 429 : 201 });
  };
  try {
    const alertPrefs = { priceAlerts: [{ ticker: 'NVDA', above: '1' }] };
    for (let i = 0; i < 5; i += 1) await addPush(ATTACKER, `https://fcm.googleapis.com/noisy/${i}`, alertPrefs, clock.now());
    await addPush(USER, 'https://fcm.googleapis.com/fcm/send/legit', {}, clock.now());
    const delivery = new DeliveryService({ db, cipher, links, logger: captureLogger().logger, now: clock.now, channels: { webpush: webPushChannel({ ...TEST_VAPID, subject: 'https://app.stonkhouse.test' }) } });
    const priceAlert = { ticker: 'NVDA', direction: 'above', threshold: { raw: '1', decimals: 6, formatted: '0.000001' }, spot: SAMPLE_PAYLOADS.price_alert.spot };
    await delivery.enqueue('price_alert', ATTACKER, priceAlert, dedupeKey('price_alert', ATTACKER, 'NVDA', 'above-1-2026-09-16'));
    clock.advance(1_000);
    await delivery.enqueue('fill_receipt', USER, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', USER, SERIES_221.longId, 'fill-1'));
    await delivery.runOnce();
    assert.equal(delivery.breakerStates().webpush, 'closed');
    assert.ok(hits.includes('/fcm/send/legit'));
    const { rows } = await db.query<{ status: string }>(
      `SELECT d.status FROM notifier.delivery d JOIN notifier.subscription s ON s.id = d.subscription_id WHERE s.address = $1`, [USER],
    );
    assert.equal(rows[0]?.status, 'sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
