/**
 * Web Push against a fake push service on 127.0.0.1.
 *
 * WHAT IS PINNED:
 *   - the request is a real RFC 8291/8292 push: POST, aes128gcm body that does not contain the
 *     message, TTL and Urgency headers, a VAPID Authorization with our public key and the endpoint
 *     origin as audience;
 *   - 404 and 410 from the push service disable the subscription (through the delivery worker);
 *     429 honours Retry-After; 5xx and network errors are transient; other 4xx are permanent;
 *   - the API only stores https endpoints on public names, and a PushSubscription in either form.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createTargetCipher } from '../crypto.js';
import { dedupeKey, DeliveryService } from '../delivery.js';
import { DEFAULT_PREFS } from '../prefs.js';
import { upsertWebPush } from '../store.js';
import { appLinks, type Rendered } from '../templates.js';
import {
  browserSubscription,
  captureLogger,
  createTestDb,
  SAMPLE_ADDRESS,
  SAMPLE_PAYLOADS,
  SERIES_221,
  startFakeServer,
  TEST_DATA_KEY_HEX,
  TEST_VAPID,
  TestClock,
  type FakeServer,
  type TestDb,
} from '../testing.js';
import { isAllowedPushEndpoint, parsePushTarget, PUSH_TTL_S, pushTtlSeconds, webPushChannel } from './webpush.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const links = appLinks('https://app.stonkhouse.test');
const settings = { ...TEST_VAPID, subject: 'https://app.stonkhouse.test' };
const MESSAGE: Rendered = { title: 'Bought NVDA 221.00 call', body: 'You bought 0.50 shares.', url: 'https://app.stonkhouse.test/NVDA/1' };

let push: FakeServer;
let reply: { status: number; headers?: Record<string, string> } = { status: 201 };
let db: TestDb;
const clock = new TestClock();

before(async () => {
  db = await createTestDb();
  push = await startFakeServer((_req, res) => {
    res.writeHead(reply.status, reply.headers ?? {});
    res.end();
  });
});
after(async () => {
  await push.close();
  await db.close();
});
beforeEach(async () => {
  await db.reset();
  push.requests.length = 0;
  reply = { status: 201 };
});

test('endpoint policy: https on public DNS names only', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://web.push.apple.com/QGx',
    'https://wns2-by3p.notify.windows.com/w/?token=x',
    'https://courier.push.apple.com/abc',
  ]) {
    assert.equal(isAllowedPushEndpoint(ok), true, ok);
  }
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://10.0.0.8/x',
    'https://localhost/x',
    'https://notifier.railway.internal/x',
    'https://printer.local/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://intranet/x',
    'https://127.0.0.1.nip.io/x',
    'https://10-0-0-5.sslip.io/x',
    'https://localtest.me/x',
    'https://fd12-3456-789a--1.sslip.io/x',
    'https://fcm.googleapis.com.attacker.test/x',
    'https://notify.windows.com.attacker.test/x',
    'not a url',
  ]) {
    assert.equal(isAllowedPushEndpoint(bad), false, bad);
  }
});

test('a PushSubscription is accepted as an object or its JSON string, and canonicalised', () => {
  const sub = browserSubscription('https://fcm.googleapis.com/fcm/send/abc');
  const expected = { endpoint: sub.endpoint, keys: sub.keys };
  assert.deepEqual(parsePushTarget(sub), expected);
  assert.deepEqual(parsePushTarget(JSON.stringify(sub)), expected);
  assert.equal(parsePushTarget({ ...sub, keys: { ...sub.keys, auth: 'AAAA' } }), null);
  assert.equal(parsePushTarget({ ...sub, keys: { p256dh: sub.keys.auth, auth: sub.keys.auth } }), null);
  assert.equal(parsePushTarget({ ...sub, endpoint: 'http://127.0.0.1/x' }), null);
  assert.equal(parsePushTarget('{nope'), null);
  assert.equal(parsePushTarget(undefined), null);
});

test('a push is encrypted, VAPID-signed, and carries TTL and Urgency', async () => {
  const sub = browserSubscription(`${push.url}/push/abc`);
  const outcome = await webPushChannel(settings).send(JSON.stringify(sub), MESSAGE, { subscriptionId: 's', kind: 'fill_receipt' });
  assert.deepEqual(outcome, { ok: true });

  const [request] = push.requests;
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/push/abc');
  assert.equal(request.headers['content-encoding'], 'aes128gcm');
  assert.equal(request.headers.ttl, String(PUSH_TTL_S));
  assert.equal(request.headers.urgency, 'normal');
  assert.ok(request.body.length > 0);
  assert.ok(!request.body.toString('latin1').includes('Bought'), 'the payload is encrypted');

  const auth = String(request.headers.authorization);
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(auth);
  assert.ok(match, auth);
  assert.equal(match[2], TEST_VAPID.publicKey);
  const claims = JSON.parse(Buffer.from(match[1]?.split('.')[1] ?? '', 'base64url').toString('utf8')) as { aud: string; sub: string };
  assert.equal(claims.aud, push.url);
  assert.equal(claims.sub, settings.subject);
});

test('push TTL respects delivery staleness and actual series expiry', async () => {
  const now = 1_700_000_000_000;
  assert.equal(pushTtlSeconds('fill_receipt', undefined, now), 6 * 3600);
  assert.equal(pushTtlSeconds('expiry_1h', undefined, now), 3600);
  assert.equal(pushTtlSeconds('expiry_24h', 1_700_000_600, now), 600);
  assert.equal(pushTtlSeconds('expiry_1h', 1_700_000_100, now), 100);
  assert.equal(pushTtlSeconds('expiry_1h', 1_699_999_999, now), 0);

  const target = JSON.stringify(browserSubscription(`${push.url}/push/expiry`));
  const expiresAt = Math.floor(Date.now() / 1000) + 90;
  assert.deepEqual(await webPushChannel(settings).send(target, MESSAGE, {
    subscriptionId: 's', kind: 'expiry_1h', expiresAt,
  }), { ok: true });
  assert.ok(Number(push.requests[0]?.headers.ttl) > 0);
  assert.ok(Number(push.requests[0]?.headers.ttl) <= 90);
  push.requests.length = 0;
  assert.deepEqual(await webPushChannel(settings).send(target, MESSAGE, {
    subscriptionId: 's', kind: 'expiry_1h', expiresAt: Math.floor(Date.now() / 1000) - 1,
  }), { ok: false, kind: 'permanent', code: 'expired_notification' });
  assert.equal(push.requests.length, 0);
});

test('a push response body is canceled without buffering untrusted bytes', async () => {
  const originalFetch = globalThis.fetch;
  let canceled = false;
  let pulled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull() { pulled = true; },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }), { status: 201 });
  try {
    const target = JSON.stringify(browserSubscription('https://fcm.googleapis.com/fcm/send/abc'));
    const outcome = await webPushChannel(settings).send(target, MESSAGE, { subscriptionId: 's', kind: 'fill_receipt' });
    assert.deepEqual(outcome, { ok: true });
    assert.equal(canceled, true);
    assert.equal(pulled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outcomes: 404/410 gone, 429 with Retry-After, 5xx transient, other 4xx permanent', async () => {
  const channel = webPushChannel(settings);
  const target = JSON.stringify(browserSubscription(`${push.url}/push/abc`));
  const send = () => channel.send(target, MESSAGE, { subscriptionId: 's', kind: 'fill_receipt' });
  const cases: [typeof reply, unknown][] = [
    [{ status: 410 }, { ok: false, kind: 'gone', code: 'http_410' }],
    [{ status: 404 }, { ok: false, kind: 'gone', code: 'http_404' }],
    [{ status: 429, headers: { 'retry-after': '120' } }, { ok: false, kind: 'transient', code: 'http_429', retryAfterMs: 120_000 }],
    [{ status: 503 }, { ok: false, kind: 'transient', code: 'http_503' }],
    [{ status: 413 }, { ok: false, kind: 'permanent', code: 'http_413' }],
    [{ status: 400 }, { ok: false, kind: 'permanent', code: 'http_400' }],
    [{ status: 202 }, { ok: true }],
  ];
  for (const [r, expected] of cases) {
    reply = r;
    assert.deepEqual(await send(), expected, String(r.status));
  }
  const down = await webPushChannel(settings).send(JSON.stringify(browserSubscription('http://127.0.0.1:1/x')), MESSAGE, { subscriptionId: 's', kind: 'k' });
  assert.equal(down.ok ? 'ok' : down.kind, 'transient');
  assert.deepEqual(await channel.send('{"endpoint":"x"}', MESSAGE, { subscriptionId: 's', kind: 'k' }), {
    ok: false,
    kind: 'permanent',
    code: 'bad_subscription',
  });
});

test('410 from the push service disables the subscription through the delivery worker', async () => {
  const { logger, lines } = captureLogger();
  const endpoint = `${push.url}/push/SECRET-ENDPOINT`;
  const sub = await upsertWebPush(db, {
    address: SAMPLE_ADDRESS,
    targetEnc: cipher.encrypt(JSON.stringify(browserSubscription(endpoint)), `webpush:${SAMPLE_ADDRESS}`),
    targetHash: cipher.hash(`webpush:${endpoint}`),
    prefs: DEFAULT_PREFS,
    now: clock.now(),
  });
  const delivery = new DeliveryService({ db, cipher, links, logger, now: clock.now, channels: { webpush: webPushChannel(settings) } });
  reply = { status: 410 };
  await delivery.enqueue('fill_receipt', SAMPLE_ADDRESS, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', SAMPLE_ADDRESS, SERIES_221.longId, 1));
  assert.equal(await delivery.runOnce(), 1);
  assert.equal(push.requests.length, 1);

  const { rows } = await db.query<{ disabled_at: Date | null; disabled_reason: string }>('SELECT disabled_at, disabled_reason FROM notifier.subscription WHERE id = $1', [sub.id]);
  assert.ok(rows[0]?.disabled_at instanceof Date);
  assert.equal(rows[0]?.disabled_reason, 'http_410');
  const { rows: del } = await db.query<{ status: string; last_error_code: string }>('SELECT status, last_error_code FROM notifier.delivery');
  assert.deepEqual(del, [{ status: 'failed', last_error_code: 'http_410' }]);

  // Nothing further is queued for a disabled subscription.
  assert.deepEqual(
    await delivery.enqueue('fill_receipt', SAMPLE_ADDRESS, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', SAMPLE_ADDRESS, SERIES_221.longId, 2)),
    { queued: 0, duplicates: 0, filtered: 0 },
  );
  // A browser that subscribes again with the same endpoint re-enables it.
  await upsertWebPush(db, {
    address: SAMPLE_ADDRESS,
    targetEnc: cipher.encrypt(JSON.stringify(browserSubscription(endpoint)), `webpush:${SAMPLE_ADDRESS}`),
    targetHash: cipher.hash(`webpush:${endpoint}`),
    prefs: DEFAULT_PREFS,
    now: clock.now(),
  });
  const { rows: again } = await db.query<{ id: string; disabled_at: Date | null }>('SELECT id, disabled_at FROM notifier.subscription');
  assert.deepEqual(again, [{ id: sub.id, disabled_at: null }]);

  const text = lines.join('\n');
  assert.ok(text.includes('"msg":"subscription disabled"'));
  assert.ok(!text.includes('SECRET-ENDPOINT') && !text.includes(SAMPLE_ADDRESS));
});
