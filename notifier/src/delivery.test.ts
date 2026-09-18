/**
 * The delivery queue on PGlite with scripted channels and a hand-driven clock.
 *
 * WHAT IS PINNED:
 *   - enqueue validates (kind, address, payload, dedupe key) and writes one row per subscription
 *     that wants the kind; the same key twice is one message (dedupe), even after it was sent;
 *   - retries: 3, at 30 s / 2 min / 10 min (or a longer Retry-After), then `failed`;
 *   - permanent failures do not retry; `gone` also disables the subscription;
 *   - the per-subscription rate limit (20 per rolling hour) drops the excess;
 *   - the per-channel circuit breaker postpones without spending attempts, and other channels
 *     keep flowing;
 *   - at-least-once: a lease that ran out is taken again;
 *   - what changed since enqueue (deleted, disabled, prefs off, too old) drops the message;
 *   - logs carry ids and codes, never a target or an address.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { CircuitBreaker } from './breaker.js';
import type { Channel, ChannelName, SendContext, SendOutcome } from './channels/types.js';
import { createTargetCipher } from './crypto.js';
import { dedupeKey, DeliveryService, EnqueueError, type DeliveryOptions } from './delivery.js';
import type { EventKind } from './events.js';
import { DEFAULT_PREFS, prefsSchema, type Prefs } from './prefs.js';
import { disableSubscription, linkTelegramChat, purge, upsertWebPush } from './store.js';
import type { Rendered } from './templates.js';
import { appLinks } from './templates.js';
import {
  captureLogger,
  createTestDb,
  SAMPLE_ADDRESS,
  SAMPLE_PAYLOADS,
  SERIES_221,
  TEST_DATA_KEY_HEX,
  TestClock,
  type TestDb,
} from './testing.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const links = appLinks('https://app.stonkhouse.test');
const ADDRESS = SAMPLE_ADDRESS;
const OTHER = '0x4088c59Eb3fB713B124f182E7083AEb3358A030B';
const CHAT_ID = '-100987654321';
const ENDPOINT = 'https://push.example.test/send/SECRET-ENDPOINT-abc';

class ScriptedChannel implements Channel {
  sent: { target: string; message: Rendered; context: SendContext }[] = [];
  script: SendOutcome[] = [];
  constructor(readonly name: ChannelName) {}
  async send(target: string, message: Rendered, context: SendContext): Promise<SendOutcome> {
    this.sent.push({ target, message, context });
    return this.script.shift() ?? { ok: true };
  }
}

let db: TestDb;
const clock = new TestClock();
let telegram: ScriptedChannel;
let webpush: ScriptedChannel;
let log: ReturnType<typeof captureLogger>;
const allLogs: string[] = [];

function service(options: Partial<DeliveryOptions> = {}, breakers: Partial<Record<ChannelName, CircuitBreaker>> = {}) {
  return new DeliveryService({
    db,
    cipher,
    links,
    logger: log.logger,
    now: clock.now,
    channels: { telegram, webpush },
    options,
    breakers,
  });
}

async function telegramSub(address = ADDRESS, prefs: Prefs = DEFAULT_PREFS, chatId = CHAT_ID) {
  return linkTelegramChat(db, {
    address,
    targetEnc: cipher.encrypt(chatId, `telegram:${address}`),
    targetHash: cipher.hash(`telegram:${chatId}`),
    defaultPrefs: prefs,
    now: clock.now(),
  });
}

async function webpushSub(address = ADDRESS, prefs: Prefs = DEFAULT_PREFS, endpoint = ENDPOINT) {
  return upsertWebPush(db, {
    address,
    targetEnc: cipher.encrypt(endpoint, `webpush:${address}`),
    targetHash: cipher.hash(`webpush:${endpoint}`),
    prefs,
    now: clock.now(),
  });
}

async function deliveries() {
  const { rows } = await db.query<{ subscription_id: string; status: string; attempts: number; last_error_code: string | null; next_attempt_at: Date; dedupe_key: string }>(
    `SELECT subscription_id, status, attempts, last_error_code, next_attempt_at, dedupe_key FROM notifier.delivery ORDER BY created_at, dedupe_key`,
  );
  return rows;
}

const fill = (bucket: string | number, address = ADDRESS) =>
  ['fill_receipt', address, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', address, SERIES_221.longId, bucket)] as const;

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
  allLogs.push(...log.lines);
  const text = allLogs.join('\n');
  assert.ok(allLogs.length > 10, 'the suite should have logged');
  for (const secret of [CHAT_ID, 'SECRET-ENDPOINT', ADDRESS, ADDRESS.toLowerCase()]) {
    assert.ok(!text.includes(secret), `log output leaked ${secret}`);
  }
});
beforeEach(async () => {
  await db.reset();
  clock.ms = Date.parse('2026-09-16T21:00:00Z');
  telegram = new ScriptedChannel('telegram');
  webpush = new ScriptedChannel('webpush');
  if (log !== undefined) allLogs.push(...log.lines);
  log = captureLogger();
});

test('enqueue → send: the channel gets the decrypted target and the rendered message', async () => {
  const sub = await telegramSub();
  const delivery = service();
  assert.deepEqual(await delivery.enqueue(...fill('fill-1')), { queued: 1, duplicates: 0, filtered: 0 });
  assert.equal(await delivery.runOnce(), 1);

  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0]?.target, CHAT_ID);
  assert.equal(telegram.sent[0]?.message.title, 'Bought NVDA 221.00 call');
  assert.deepEqual(telegram.sent[0]?.context, { subscriptionId: sub.id, kind: 'fill_receipt' });
  const [row] = await deliveries();
  assert.equal(row?.status, 'sent');
  assert.equal(row?.attempts, 1);
  assert.equal(await delivery.runOnce(), 0);
});

test('dedupe: the same key is one message per subscription, before and after sending', async () => {
  await telegramSub();
  await webpushSub();
  const delivery = service();
  assert.deepEqual(await delivery.enqueue(...fill('fill-1')), { queued: 2, duplicates: 0, filtered: 0 });
  assert.deepEqual(await delivery.enqueue(...fill('fill-1')), { queued: 0, duplicates: 2, filtered: 0 });
  await delivery.runOnce();
  assert.deepEqual(await delivery.enqueue(...fill('fill-1')), { queued: 0, duplicates: 2, filtered: 0 });
  assert.equal(await delivery.runOnce(), 0);
  assert.equal(telegram.sent.length, 1);
  assert.equal(webpush.sent.length, 1);
  // A different bucket is a different event.
  assert.equal((await delivery.enqueue(...fill('fill-2'))).queued, 2);
});

test('enqueue refuses what is not a valid event, before writing anything', async () => {
  await telegramSub();
  const delivery = service();
  const refusals: [EventKind, string, unknown, string][] = [
    ['nope' as EventKind, ADDRESS, {}, `nope:${ADDRESS}:1:1`],
    ['fill_receipt', 'not-an-address', SAMPLE_PAYLOADS.fill_receipt, 'fill_receipt:x:1:1'],
    ['fill_receipt', ADDRESS, SAMPLE_PAYLOADS.fill_receipt, 'has a space'],
    // A key for another wallet or another kind: almost certainly a bug in the caller.
    ['fill_receipt', ADDRESS, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', OTHER, '1', 1)],
    ['fill_receipt', ADDRESS, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('strike_cross', ADDRESS, '1', 1)],
    ['fill_receipt', ADDRESS, { ...SAMPLE_PAYLOADS.fill_receipt, total: undefined }, dedupeKey('fill_receipt', ADDRESS, '1', 1)],
  ];
  for (const [kind, address, payload, key] of refusals) {
    await assert.rejects(delivery.enqueue(kind, address, payload, key), EnqueueError, key);
  }
  assert.equal((await deliveries()).length, 0);
  // Any case of the address is the same wallet.
  const key = dedupeKey('fill_receipt', ADDRESS, SERIES_221.longId, 7);
  assert.equal(key, `fill_receipt:${ADDRESS}:${SERIES_221.longId}:7`);
  assert.equal((await delivery.enqueue('fill_receipt', ADDRESS.toLowerCase(), SAMPLE_PAYLOADS.fill_receipt, key.toLowerCase())).queued, 1);
});

test('prefs, verification and channel availability filter at enqueue', async () => {
  await telegramSub(ADDRESS, prefsSchema.parse({ fills: false }));
  await webpushSub(ADDRESS, prefsSchema.parse({ priceAlerts: [{ ticker: 'NVDA', above: '221000000' }] }));
  const delivery = service();
  assert.deepEqual(await delivery.enqueue(...fill(1)), { queued: 1, duplicates: 0, filtered: 1 });

  // price_alert: only the subscription holding that exact alert.
  const alert = (threshold: string, direction: 'above' | 'below') =>
    delivery.enqueue(
      'price_alert',
      ADDRESS,
      { ...SAMPLE_PAYLOADS.price_alert, direction, threshold: { raw: threshold, decimals: 6 } },
      dedupeKey('price_alert', ADDRESS, 'NVDA', `${direction}-${threshold}`),
    );
  assert.deepEqual(await alert('221000000', 'above'), { queued: 1, duplicates: 0, filtered: 1 });
  assert.deepEqual(await alert('221000000', 'below'), { queued: 0, duplicates: 0, filtered: 2 });
  assert.deepEqual(await alert('225000000', 'above'), { queued: 0, duplicates: 0, filtered: 2 });

  // No subscription at all is not an error.
  assert.deepEqual(await delivery.enqueue(...fill(1, OTHER)), { queued: 0, duplicates: 0, filtered: 0 });

  // A channel that is off (email without SMTP) is filtered.
  const noWebPush = new DeliveryService({ db, cipher, links, logger: log.logger, now: clock.now, channels: { telegram } });
  assert.deepEqual(await noWebPush.enqueue(...fill(2)), { queued: 0, duplicates: 0, filtered: 2 });
});

test('retries: 3, after 30 s, 2 min and 10 min, then delivered', async () => {
  await telegramSub();
  const delivery = service();
  telegram.script = [
    { ok: false, kind: 'transient', code: 'timeout' },
    { ok: false, kind: 'transient', code: 'http_502' },
    { ok: false, kind: 'transient', code: 'ECONNRESET' },
  ];
  await delivery.enqueue(...fill(1));
  const start = clock.ms;
  for (const [waitMs, code] of [[30_000, 'timeout'], [120_000, 'http_502'], [600_000, 'ECONNRESET']] as const) {
    assert.equal(await delivery.runOnce(), 1);
    const [row] = await deliveries();
    assert.equal(row?.status, 'pending');
    assert.equal(row?.last_error_code, code);
    assert.equal(row?.next_attempt_at.getTime(), clock.ms + waitMs);
    clock.advance(waitMs - 1);
    assert.equal(await delivery.runOnce(), 0, 'not due a millisecond early');
    clock.advance(1);
  }
  assert.equal(await delivery.runOnce(), 1);
  const [row] = await deliveries();
  assert.deepEqual([row?.status, row?.attempts, row?.last_error_code], ['sent', 4, null]);
  assert.equal(telegram.sent.length, 4);
  assert.equal(clock.ms - start, 750_000);
});

test('retries exhausted: failed after the fourth attempt; Retry-After longer than the back-off wins', async () => {
  await telegramSub();
  const delivery = service();
  telegram.script = [
    { ok: false, kind: 'transient', code: 'http_429', retryAfterMs: 90_000 },
    { ok: false, kind: 'transient', code: 'http_500' },
    { ok: false, kind: 'transient', code: 'http_500' },
    { ok: false, kind: 'transient', code: 'http_500' },
  ];
  await delivery.enqueue(...fill(1));
  await delivery.runOnce();
  assert.equal((await deliveries())[0]?.next_attempt_at.getTime(), clock.ms + 90_000);
  for (const wait of [90_000, 120_000, 600_000]) {
    clock.advance(wait);
    assert.equal(await delivery.runOnce(), 1);
  }
  const [row] = await deliveries();
  assert.deepEqual([row?.status, row?.attempts, row?.last_error_code], ['failed', 4, 'http_500']);
  clock.advance(3600_000);
  assert.equal(await delivery.runOnce(), 0);
});

test('permanent: failed at once, no retry, subscription stays on', async () => {
  const sub = await telegramSub();
  const delivery = service();
  telegram.script = [{ ok: false, kind: 'permanent', code: 'http_400' }];
  await delivery.enqueue(...fill(1));
  await delivery.runOnce();
  assert.deepEqual((await deliveries()).map((r) => [r.status, r.attempts]), [['failed', 1]]);
  const { rows } = await db.query<{ disabled_at: Date | null }>('SELECT disabled_at FROM notifier.subscription WHERE id = $1', [sub.id]);
  assert.equal(rows[0]?.disabled_at, null);
  assert.equal((await delivery.enqueue(...fill(2))).queued, 1);
});

test('gone: failed, the subscription is disabled, and nothing more is queued for it', async () => {
  const sub = await webpushSub();
  await telegramSub();
  const delivery = service();
  webpush.script = [{ ok: false, kind: 'gone', code: 'http_410' }];
  await delivery.enqueue(...fill(1));
  await delivery.runOnce();
  const { rows } = await db.query<{ disabled_at: Date | null; disabled_reason: string | null }>(
    'SELECT disabled_at, disabled_reason FROM notifier.subscription WHERE id = $1',
    [sub.id],
  );
  assert.ok(rows[0]?.disabled_at instanceof Date);
  assert.equal(rows[0]?.disabled_reason, 'http_410');
  assert.deepEqual(await delivery.enqueue(...fill(2)), { queued: 1, duplicates: 0, filtered: 0 });
  assert.ok(log.lines.some((l) => l.includes('"msg":"subscription disabled"') && l.includes(sub.id)));
});

test('rate limit: 20 per subscription per rolling hour, the excess is dropped', async () => {
  await telegramSub();
  const delivery = service({ batchSize: 50 });
  for (let i = 0; i < 25; i += 1) {
    await delivery.enqueue(...fill(`f${i}`));
    clock.advance(60_000);
  }
  // 25 minutes of events, delivered in one pass.
  await delivery.runOnce();
  const rows = await deliveries();
  assert.equal(rows.filter((r) => r.status === 'sent').length, 20);
  assert.deepEqual([...new Set(rows.filter((r) => r.status !== 'sent').map((r) => `${r.status}:${r.last_error_code}`))], ['dropped:rate_limited']);
  assert.equal(telegram.sent.length, 20);

  // An hour after those sends the window has room again.
  clock.advance(3600_000);
  await delivery.enqueue(...fill('later'));
  await delivery.runOnce();
  assert.equal(telegram.sent.length, 21);
});

test('circuit breaker: opens on repeated transient failures, postpones without spending attempts, other channels flow', async () => {
  await telegramSub(ADDRESS);
  await telegramSub(OTHER, DEFAULT_PREFS, '-100111');
  await webpushSub(ADDRESS);
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000, maxCooldownMs: 600_000 });
  const delivery = service({}, { telegram: breaker });
  telegram.script = [
    { ok: false, kind: 'transient', code: 'timeout' },
    { ok: false, kind: 'transient', code: 'timeout' },
  ];
  await delivery.enqueue(...fill(1));
  await delivery.enqueue(...fill(1, OTHER));
  await delivery.runOnce();
  assert.equal(delivery.breakerStates().telegram, 'open');
  assert.equal(webpush.sent.length, 1, 'web push is not held back by Telegram');

  // A new Telegram message while open: postponed to the end of the cool-down, attempts untouched.
  await delivery.enqueue(...fill(2, OTHER));
  await delivery.runOnce();
  const postponed = (await deliveries()).find((r) => r.dedupe_key.endsWith(':2'));
  assert.deepEqual([postponed?.status, postponed?.attempts], ['pending', 0]);
  assert.equal(postponed?.next_attempt_at.getTime(), breaker.openUntil);
  assert.equal(telegram.sent.length, 2);

  // After the cool-down: one trial; it succeeds and closes the breaker, and the rest follow in the
  // same pass (the two failed messages were due again at +30 s, the postponed one at +60 s).
  clock.advance(60_000);
  assert.equal(delivery.breakerStates().telegram, 'half-open');
  await delivery.runOnce();
  assert.equal(delivery.breakerStates().telegram, 'closed');
  assert.ok(log.lines.some((l) => l.includes('"msg":"circuit breaker opened"')));
  const rows = await deliveries();
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'sent', 'sent', 'sent']);
  assert.equal(telegram.sent.length, 5);
  assert.equal(rows.find((r) => r.dedupe_key.endsWith(':2'))?.attempts, 1, 'the postponed message spent one attempt, not two');
});

test('a Telegram chat 429 retries that row without opening the bot-wide breaker', async () => {
  await telegramSub();
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, maxCooldownMs: 600_000 });
  const delivery = service({}, { telegram: breaker });
  telegram.script = [{ ok: false, kind: 'transient', code: 'http_429', retryAfterMs: 120_000 }];
  await delivery.enqueue(...fill('limited'));
  await delivery.runOnce();
  assert.equal(delivery.breakerStates().telegram, 'closed');
  const [pending] = await deliveries();
  assert.deepEqual([pending?.status, pending?.attempts], ['pending', 1]);
  assert.equal(pending?.next_attempt_at.getTime(), clock.ms + 120_000);
  clock.advance(120_000);
  await delivery.runOnce();
  assert.equal((await deliveries())[0]?.status, 'sent');
});

test('circuit breaker: a failed half-open trial re-opens with a longer cool-down', () => {
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1_000, maxCooldownMs: 3_000 });
  assert.equal(breaker.allow(0), true);
  breaker.failure(0);
  assert.equal(breaker.state(500), 'open');
  assert.equal(breaker.allow(500), false);
  assert.equal(breaker.allow(1_000), true, 'the trial');
  assert.equal(breaker.allow(1_000), false, 'only one trial');
  breaker.failure(1_000);
  assert.equal(breaker.openUntil, 3_000);
  assert.equal(breaker.allow(3_000), true);
  breaker.failure(3_000);
  assert.equal(breaker.openUntil, 6_000, 'capped at maxCooldownMs');
  assert.equal(breaker.allow(6_000), true);
  breaker.success();
  assert.equal(breaker.state(6_000), 'closed');
});

test('at-least-once: a lease that ran out is taken again; a live lease is not', async () => {
  await telegramSub();
  const delivery = service({ leaseMs: 300_000 });
  await delivery.enqueue(...fill(1));
  // Simulate a pass that leased the row and died before recording the outcome.
  await db.query(`UPDATE notifier.delivery SET status = 'sending', next_attempt_at = $1::timestamptz`, [new Date(clock.ms + 300_000)]);
  assert.equal(await delivery.runOnce(), 0);
  clock.advance(300_000);
  assert.equal(await delivery.runOnce(), 1);
  assert.equal((await deliveries())[0]?.status, 'sent');
});

test('what changed since enqueue drops the message: disabled, prefs off, deleted, stale', async () => {
  const tg = await telegramSub();
  const push = await webpushSub();
  const delivery = service();

  await delivery.enqueue(...fill(1));
  await disableSubscription(db, tg.id, 'telegram_stop', clock.now());
  await webpushSub(ADDRESS, prefsSchema.parse({ fills: false }));
  await delivery.runOnce();
  assert.deepEqual((await deliveries()).map((r) => `${r.status}:${r.last_error_code}`).sort(), ['dropped:pref_off', 'dropped:subscription_inactive']);

  await db.reset();
  await webpushSub();
  await delivery.enqueue(...fill(2));
  clock.advance(6 * 3600_000 + 1);
  await delivery.runOnce();
  assert.deepEqual((await deliveries()).map((r) => `${r.status}:${r.last_error_code}`), ['dropped:stale']);

  await db.query('DELETE FROM notifier.subscription');
  assert.equal((await deliveries()).length, 0, 'deliveries go with their subscription');
  assert.equal(webpush.sent.length + telegram.sent.length, 0);
  void push;
});

test('the worker loop: enqueue wakes it, stop ends it', async () => {
  await telegramSub();
  const delivery = service({ pollMs: 60_000 });
  delivery.start();
  try {
    // Enqueued while the loop's first pass is still reading an empty queue: it must not sleep 60 s.
    await delivery.enqueue(...fill(1));
    for (let i = 0; i < 400 && telegram.sent.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(telegram.sent.length, 1);
    // And once it is idle, a later enqueue wakes it too.
    await new Promise((r) => setTimeout(r, 50));
    await delivery.enqueue(...fill(2));
    for (let i = 0; i < 400 && telegram.sent.length === 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(telegram.sent.length, 2);
  } finally {
    await delivery.stop();
  }
});

test('purge: finished deliveries after 30 days, expired nonces and links', async () => {
  await telegramSub();
  const delivery = service();
  await delivery.enqueue(...fill(1));
  await delivery.runOnce();
  await db.query(
    `INSERT INTO notifier.nonce (nonce, address, message, created_at, expires_at) VALUES ('n1', $1, 'm', $2::timestamptz, $2::timestamptz)`,
    [ADDRESS, clock.now()],
  );
  clock.advance(31 * 24 * 3600_000);
  assert.deepEqual(await purge(db, clock.now()), { nonces: 1, links: 0, deliveries: 1 });
});
