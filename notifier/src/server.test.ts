/**
 * The HTTP API end to end: the whole service built by startNotifier (listen: false) on PGlite,
 * driven with `app.request`, real EOA signatures, a mocked ERC-1271 client and a fake Bot API.
 *
 * WHAT IS PINNED:
 *   - challenge → sign → subscribe / list / delete, each spending a fresh nonce;
 *   - replayed nonces and wrong signers are 401; a malformed request is 400 and spends nothing;
 *   - per-channel `target` rules, the Telegram link endpoint, the VAPID key;
 *   - a wallet can neither list nor delete another wallet's subscriptions;
 *   - CORS admits APP_URL only; bodies are capped; errors are `{ error: { code, message } }`;
 *   - no log line carries an address, a signature, a nonce, a session token or a target;
 *   - v5 sessions: POST /v1/session spends a nonce and returns a 30-minute bearer that works on the
 *     four authenticated routes exactly as web/lib/v2/notifier.ts sends it, is bound to its
 *     address (403), refused when expired, tampered or foreign (401), beats signature/nonce in the
 *     same request without spending the nonce, and passes CORS preflight.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { startNotifier, type RunningNotifier } from './app.js';
import { CHALLENGE_WINDOW_MS, createSignatureVerifier, MAX_CHALLENGES_GLOBAL, MAX_CHALLENGES_PER_ADDRESS } from './auth.js';
import type { TelegramApi } from './channels/telegram.js';
import { createTargetCipher } from './crypto.js';
import { MAX_BODY_BYTES } from './server.js';
import { MAX_WEBPUSH_SUBSCRIPTIONS_PER_WALLET } from './store.js';
import { sessionTokens } from './session.js';
import { browserSubscription, captureLogger, createTestDb, TEST_VAPID, testConfig, TestClock, type TestDb } from './testing.js';

const APP_URL = 'https://app.stonkhouse.test';
const alice = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const bob = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SAFE = getAddress('0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe');
const SAFE_SIGNATURE: Hex = `0x${'12'.repeat(200)}`;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT-123';

let db: TestDb;
let notifier: RunningNotifier;
const clock = new TestClock();
let log = captureLogger();
const allLogs: string[] = [];
/** Every session token and signature the suite produced: none may reach a log line. */
const issuedSecrets: string[] = [];
let getMeWorks = true;

const fakeTelegram: TelegramApi = {
  async call<T>(method: string) {
    if (method === 'getMe' && getMeWorks) return { ok: true as const, result: { username: 'stonkhouse_test_bot' } as T };
    if (method === 'getMe') return { ok: false as const, status: 502, code: 'http_502', description: null };
    return { ok: true as const, result: [] as T };
  },
};

before(async () => {
  db = await createTestDb();
  notifier = await startNotifier(testConfig({ APP_URL }), {
    db,
    now: clock.now,
    logger: {
      info: (f, m) => log.logger.info(f, m),
      warn: (f, m) => log.logger.warn(f, m),
      error: (f, m) => log.logger.error(f, m),
    },
    verify: createSignatureVerifier({
      async verifyMessage({ address, signature }) {
        return address === SAFE && signature === SAFE_SIGNATURE;
      },
    }),
    telegramApi: fakeTelegram,
    listen: false,
  });
});
after(async () => {
  await notifier.close();
  allLogs.push(...log.lines);
  const text = allLogs.join('\n');
  assert.ok(allLogs.length >= 5, 'the suite should have logged');
  for (const secret of [alice.address, alice.address.toLowerCase(), bob.address, 'SECRET-ENDPOINT', '"nonce"', 'signature":', 'Bearer', 'authorization']) {
    assert.ok(!text.includes(secret), `log output leaked ${secret}`);
  }
  assert.ok(issuedSecrets.length >= 10, 'the session tests should have issued tokens');
  for (const secret of issuedSecrets) assert.ok(!text.includes(secret), 'log output leaked a session token or signature');
});
beforeEach(async () => {
  await db.reset();
  // The app's in-memory client gate persists across tests, just as it does across real requests.
  clock.ms = Math.max(clock.ms, Date.parse('2026-09-16T21:00:00Z')) + CHALLENGE_WINDOW_MS;
  getMeWorks = true;
  allLogs.push(...log.lines);
  log = captureLogger();
});

/* ------------------------------------------------------------------ helpers */

function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return notifier.app.request(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...init.headers },
    ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
}

async function credentials(account: PrivateKeyAccount | { address: `0x${string}`; sign: (m: string) => Promise<Hex> }) {
  const res = await request('/v1/challenge', { method: 'POST', body: { address: account.address } });
  assert.equal(res.status, 200);
  const { message, nonce } = (await res.json()) as { message: string; nonce: string };
  const signature = 'signMessage' in account ? await account.signMessage({ message }) : await account.sign(message);
  issuedSecrets.push(signature);
  return { address: account.address, signature, nonce };
}

const query = (c: { address: string; signature: string; nonce: string }) => new URLSearchParams(c).toString();

async function subscribeWebPush(account: PrivateKeyAccount = alice, endpoint = ENDPOINT, prefs: unknown = { fills: false }) {
  const res = await request('/v1/subscriptions', {
    method: 'POST',
    body: { ...(await credentials(account)), channel: 'webpush', target: browserSubscription(endpoint), prefs },
  });
  return { res, body: (await res.json()) as { id?: string; error?: { code: string } } };
}

/* ------------------------------------------------------------------ tests */

test('GET /health: database and channel state', async () => {
  const res = await request('/health', { headers: { origin: APP_URL } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), APP_URL);
  assert.deepEqual(await res.json(), {
    status: 'ok',
    service: 'callhouse-notifier',
    database: 'ok',
    channels: { telegram: 'closed', webpush: 'closed', email: 'off' },
    telegramBot: 'unknown',
    delivery: { lastHour: { sent: 0, failed: 0, dropped: 0, rateLimited: 0 } },
    rules: { status: 'starting', lastSuccessAt: null, consecutiveFailures: 0, watchSet: 0, oldestRefreshAgeS: null },
  });
});

test('GET /health: the last hour’s delivery outcomes, the watch set and the oldest holdings refresh', async () => {
  const mine = await subscribeWebPush(alice);
  const subscription = mine.body.id;
  assert.ok(subscription !== undefined);
  await subscribeWebPush(bob, 'https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT-bob');

  const row = (key: string, kind: string, status: string, code: string | null, minutesAgo: number) =>
    db.query(
      `INSERT INTO notifier.delivery (subscription_id, kind, dedupe_key, payload, status, created_at, next_attempt_at, sent_at, last_error_code)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5::timestamptz, $5::timestamptz, $6::timestamptz, $7)`,
      [subscription, kind, key, status, new Date(clock.ms - minutesAgo * 60_000), status === 'sent' ? new Date(clock.ms) : null, code],
    );
  await row('k1', 'fill_receipt', 'sent', null, 10);
  await row('k2', 'expiry_1h', 'failed', 'http_400', 20);
  await row('k3', 'expiry_1h', 'dropped', 'rate_limited:alerts', 30);
  await row('k4', 'strike_cross', 'dropped', 'pref_off', 40);
  await row('k5', 'fill_receipt', 'sent', null, 120); // older than the window
  await row('k6', 'fill_receipt', 'pending', null, 5); // no outcome yet

  // The engine read one wallet's positions 15 minutes ago and the other's 5 minutes ago.
  for (const [address, secondsAgo] of [[alice.address, 900], [bob.address, 300]] as const) {
    await db.query(`INSERT INTO notifier.rules_holdings (address, holdings, fetched_at) VALUES ($1, '{}'::jsonb, $2::timestamptz)`, [
      address,
      new Date(clock.ms - secondsAgo * 1000),
    ]);
  }

  const health = (await (await request('/health')).json()) as {
    delivery: { lastHour: { sent: number; failed: number; dropped: number; rateLimited: number } };
    rules: { watchSet: number; oldestRefreshAgeS: number | null };
  };
  assert.deepEqual(health.delivery.lastHour, { sent: 1, failed: 1, dropped: 2, rateLimited: 1 }, 'the hour before now, by outcome');
  assert.equal(health.rules.watchSet, 2, 'both verified, enabled wallets');
  assert.equal(health.rules.oldestRefreshAgeS, 900, 'the wallet furthest behind, in seconds');

  // A wallet that leaves the watch set leaves both numbers.
  await db.query('UPDATE notifier.subscription SET disabled_at = now() WHERE address = $1', [alice.address]);
  await db.query('DELETE FROM notifier.rules_holdings WHERE address = $1', [alice.address]);
  const after = (await (await request('/health')).json()) as { rules: { watchSet: number; oldestRefreshAgeS: number | null } };
  assert.deepEqual([after.rules.watchSet, after.rules.oldestRefreshAgeS], [1, 300]);
});

test('a price alert on a ticker the notifier has no market for is refused with the prefs 400 shape', async () => {
  notifier.markets.set(['NVDA', 'TSLA']);
  try {
    const bad = await subscribeWebPush(alice, ENDPOINT, { priceAlerts: [{ ticker: 'AAPL', above: '221000000' }] });
    assert.equal(bad.res.status, 400);
    assert.deepEqual(bad.body, {
      error: { code: 'bad-request', message: 'prefs: priceAlerts.0.ticker: AAPL is not a market on this notifier' },
    });
    assert.equal((await db.query('SELECT 1 FROM notifier.subscription')).rows.length, 0, 'nothing was saved');

    // A ticker that is a market is saved as before.
    const good = await subscribeWebPush(alice, ENDPOINT, { priceAlerts: [{ ticker: 'TSLA', below: '400000000' }] });
    assert.equal(good.res.status, 201);
  } finally {
    notifier.markets.set([]);
  }
});

test('with no market list cached the check fails open: an indexer outage cannot refuse every alert', async () => {
  assert.deepEqual(notifier.markets.tickers(), [], 'nothing has filled the cache in this suite');
  const res = await subscribeWebPush(alice, ENDPOINT, { priceAlerts: [{ ticker: 'AAPL', above: '221000000' }] });
  assert.equal(res.res.status, 201, 'an empty cache means “unknown”, never “no markets”');
  const { rows } = await db.query<{ prefs: { priceAlerts: { ticker: string }[] } }>('SELECT prefs FROM notifier.subscription');
  assert.deepEqual(rows[0]?.prefs.priceAlerts.map((a) => a.ticker), ['AAPL']);
});

test('POST /v1/challenge validates the address', async () => {
  assert.equal((await request('/v1/challenge', { method: 'POST', body: '{nope' })).status, 400);
  const bad = await request('/v1/challenge', { method: 'POST', body: { address: '0x123' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: { code: 'bad-request', message: 'address: a 20-byte hex address' } });
  const ok = await request('/v1/challenge', { method: 'POST', body: { address: alice.address.toLowerCase() } });
  const body = (await ok.json()) as { message: string; nonce: string; expiresAt: number };
  assert.ok(body.message.includes(alice.address));
  assert.equal(body.expiresAt, Math.floor(clock.ms / 1000) + 600);
});

test('public challenges are bounded per address and per client without locking out another client', async () => {
  const challenge = (address: string, ip = '203.0.113.66') => request('/v1/challenge', {
    method: 'POST', body: { address }, headers: { 'x-forwarded-for': ip },
  });
  for (let i = 0; i < MAX_CHALLENGES_PER_ADDRESS; i += 1) assert.equal((await challenge(alice.address)).status, 200);
  const limited = await challenge(alice.address);
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: { code: string } }).error.code, 'challenge-rate-limited');
  assert.equal((await challenge(bob.address)).status, 200, 'one wallet cannot consume another wallet’s quota');
  for (let i = 1; i < MAX_CHALLENGES_GLOBAL - MAX_CHALLENGES_PER_ADDRESS; i += 1) {
    const address = getAddress(`0x${i.toString(16).padStart(40, '0')}`);
    assert.equal((await challenge(address)).status, 200);
  }
  assert.equal((await challenge(getAddress(`0x${'ff'.repeat(20)}`))).status, 429, 'the client quota bounds rotating addresses');
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifier.nonce');
  assert.equal(rows[0]?.n, MAX_CHALLENGES_GLOBAL);
  assert.equal((await challenge(getAddress(`0x${'ee'.repeat(20)}`), '198.51.100.7')).status, 200);
  clock.advance(CHALLENGE_WINDOW_MS);
  assert.equal((await challenge(alice.address)).status, 200);
});

test('web push: subscribe (201), subscribe again (200, same id), list, delete', async () => {
  const first = await subscribeWebPush();
  assert.equal(first.res.status, 201);
  assert.match(first.body.id ?? '', /^[0-9a-f-]{36}$/);

  const again = await subscribeWebPush(alice, ENDPOINT, { fills: true, priceAlerts: [{ ticker: 'NVDA', above: '230000000' }] });
  assert.equal(again.res.status, 200);
  assert.equal(again.body.id, first.body.id);

  const list = await request(`/v1/subscriptions?${query(await credentials(alice))}`);
  assert.equal(list.status, 200);
  const { items } = (await list.json()) as { items: Record<string, unknown>[] };
  assert.deepEqual(items, [
    {
      id: first.body.id,
      channel: 'webpush',
      status: 'active',
      target: 'fcm.googleapis.com',
      prefs: {
        strikeCross: true,
        expiry24h: true,
        expiry1h: true,
        settlement: true,
        fills: true,
        writerItmWarning: true,
        autoRoll: true,
        priceAlerts: [{ ticker: 'NVDA', above: '230000000' }],
      },
      createdAt: Math.floor(clock.ms / 1000),
      verifiedAt: Math.floor(clock.ms / 1000),
      disabledAt: null,
      disabledReason: null,
    },
  ]);
  // The endpoint is stored sealed.
  const { rows } = await db.query<{ target_enc: string }>('SELECT target_enc FROM notifier.subscription');
  assert.ok(!rows[0]?.target_enc.includes('SECRET-ENDPOINT'));

  const del = await request(`/v1/subscriptions/${first.body.id}?${query(await credentials(alice))}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  const after = (await (await request(`/v1/subscriptions?${query(await credentials(alice))}`)).json()) as { items: unknown[] };
  assert.deepEqual(after.items, []);
});

test('a wallet cannot multiply web push fanout beyond the endpoint cap', async () => {
  const endpoint = (i: number) => `https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT-${i}`;
  let firstId: string | undefined;
  for (let i = 0; i < MAX_WEBPUSH_SUBSCRIPTIONS_PER_WALLET; i += 1) {
    const result = await subscribeWebPush(alice, endpoint(i));
    assert.equal(result.res.status, 201);
    if (i === 0) firstId = result.body.id;
  }
  const full = await subscribeWebPush(alice, endpoint(MAX_WEBPUSH_SUBSCRIPTIONS_PER_WALLET));
  assert.equal(full.res.status, 429);
  assert.equal(full.body.error?.code, 'subscription-limit');
  assert.equal((await subscribeWebPush(alice, endpoint(0))).res.status, 200, 'refreshing an existing endpoint still works');
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifier.subscription WHERE address = $1 AND channel = 'webpush'`,
    [alice.address],
  );
  assert.equal(rows[0]?.n, MAX_WEBPUSH_SUBSCRIPTIONS_PER_WALLET);

  // A gone browser must not permanently occupy an active slot; the same endpoint can rejoin.
  await db.query(`UPDATE notifier.subscription SET disabled_at = $2::timestamptz WHERE id = $1`, [firstId, clock.now()]);
  assert.equal((await subscribeWebPush(alice, endpoint(0))).res.status, 200);

  // If all ten browsers are gone, a fresh device can join and dead rows are cleared.
  await db.query(`UPDATE notifier.subscription SET disabled_at = $2::timestamptz WHERE address = $1 AND channel = 'webpush'`, [alice.address, clock.now()]);
  assert.equal((await subscribeWebPush(alice, endpoint(MAX_WEBPUSH_SUBSCRIPTIONS_PER_WALLET))).res.status, 201);
  const { rows: remaining } = await db.query<{ active: number; total: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE disabled_at IS NULL AND verified_at IS NOT NULL)::int AS active
       FROM notifier.subscription WHERE address = $1 AND channel = 'webpush'`,
    [alice.address],
  );
  assert.deepEqual(remaining[0], { total: 1, active: 1 });
});

test('reads and deletes need a fresh signature: a replayed nonce is 401', async () => {
  const creds = await credentials(alice);
  assert.equal((await request(`/v1/subscriptions?${query(creds)}`)).status, 200);
  const replay = await request(`/v1/subscriptions?${query(creds)}`);
  assert.equal(replay.status, 401);
  assert.equal(((await replay.json()) as { error: { code: string } }).error.code, 'nonce-invalid');
  assert.equal((await request('/v1/subscriptions')).status, 400);
});

test('a wrong signer is 401; a malformed request is 400 and does not spend the nonce', async () => {
  const creds = await credentials(alice);
  const forged = await request(`/v1/subscriptions?${query({ ...creds, signature: await bob.signMessage({ message: 'x' }) })}`);
  assert.equal(((await forged.json()) as { error: { code: string } }).error.code, 'signature-invalid');

  const good = await credentials(alice);
  const target = browserSubscription(ENDPOINT);
  const cases: [unknown, string][] = [
    [{ ...good, channel: 'webpush', target, prefs: { fillz: true } }, 'bad-request'],
    [{ ...good, channel: 'webpush', target, prefs: { priceAlerts: [{ ticker: 'NVDA', above: '221.5' }] } }, 'bad-request'],
    [{ ...good, channel: 'sms', target }, 'bad-request'],
    [{ ...good, channel: 'webpush', target: { ...target, endpoint: 'https://10.0.0.1/x' } }, 'target-invalid'],
    [{ ...good, channel: 'telegram', target: '12345' }, 'target-invalid'],
    [{ ...good, channel: 'email', target: 'a@b.co' }, 'channel-unavailable'],
    [{ ...good, channel: 'webpush', target, extra: 1 }, 'bad-request'],
  ];
  for (const [body, code] of cases) {
    const res = await request('/v1/subscriptions', { method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, code);
  }
  const res = await request('/v1/subscriptions', { method: 'POST', body: { ...good, channel: 'webpush', target } });
  assert.equal(res.status, 201, 'the nonce survived every refused request');
});

test('a wallet cannot list or delete another wallet’s subscriptions', async () => {
  const { body } = await subscribeWebPush(alice);
  const bobs = (await (await request(`/v1/subscriptions?${query(await credentials(bob))}`)).json()) as { items: unknown[] };
  assert.deepEqual(bobs.items, []);
  const del = await request(`/v1/subscriptions/${body.id}?${query(await credentials(bob))}`, { method: 'DELETE' });
  assert.equal(del.status, 404);
  const unknown = await request(`/v1/subscriptions/not-a-uuid?${query(await credentials(alice))}`, { method: 'DELETE' });
  assert.equal(unknown.status, 404);
  // Credentials in a JSON body work for DELETE too.
  const viaBody = await request(`/v1/subscriptions/${body.id}`, { method: 'DELETE', body: await credentials(alice) });
  assert.equal(viaBody.status, 200);
});

test('telegram: prefs without a target make a pending subscription; the link endpoint issues a deep link', async () => {
  const res = await request('/v1/subscriptions', {
    method: 'POST',
    body: { ...(await credentials(alice)), channel: 'telegram', prefs: { autoRoll: false } },
  });
  assert.equal(res.status, 201);
  const { items } = (await (await request(`/v1/subscriptions?${query(await credentials(alice))}`)).json()) as {
    items: { channel: string; status: string; target: string | null; verifiedAt: number | null }[];
  };
  assert.deepEqual(items.map((i) => [i.channel, i.status, i.target, i.verifiedAt]), [['telegram', 'pending', null, null]]);

  const link = await request(`/v1/telegram/link?${query(await credentials(alice))}`);
  assert.equal(link.status, 200);
  const body = (await link.json()) as { deepLink: string; expiresAt: number };
  assert.match(body.deepLink, /^https:\/\/t\.me\/stonkhouse_test_bot\?start=[A-Za-z0-9_-]{32}$/);
  assert.equal(body.expiresAt, Math.floor(clock.ms / 1000) + 900);

  getMeWorks = false;
  const fresh = await startNotifier(testConfig({ APP_URL }), { db, now: clock.now, logger: log.logger, telegramApi: fakeTelegram, verify: async () => true, listen: false });
  const down = await fresh.app.request(`/v1/telegram/link?${query(await credentials(alice))}`);
  assert.equal(down.status, 503);
  assert.equal(((await down.json()) as { error: { code: string } }).error.code, 'channel-unavailable');
});

test('ERC-1271 contract wallets subscribe through the chain verifier', async () => {
  const safe = { address: SAFE, sign: async () => SAFE_SIGNATURE };
  const res = await request('/v1/subscriptions', {
    method: 'POST',
    body: { ...(await credentials(safe)), channel: 'webpush', target: browserSubscription(ENDPOINT) },
  });
  assert.equal(res.status, 201);
});

test('GET /v1/webpush/key', async () => {
  const res = await request('/v1/webpush/key');
  assert.deepEqual(await res.json(), { publicKey: TEST_VAPID.publicKey });
});

test('CORS admits APP_URL only', async () => {
  const preflight = (origin: string) =>
    notifier.app.request('/v1/subscriptions', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
  const ok = await preflight(APP_URL);
  assert.equal(ok.headers.get('access-control-allow-origin'), APP_URL);
  assert.match(ok.headers.get('access-control-allow-methods') ?? '', /DELETE/);
  const evil = await preflight('https://evil.test');
  assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.test');
});

test('bodies are capped, unknown routes are 404, errors have one shape', async () => {
  const big = await request('/v1/challenge', { method: 'POST', body: { address: 'x'.repeat(MAX_BODY_BYTES + 10) } });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { error: { code: string } }).error.code, 'payload-too-large');
  const missing = await request('/v2/nothing');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: 'not-found', message: 'no such route' } });
});

/* ------------------------------------------------------------------ v5 sessions */

type SessionBody = { token: string; address: string; expiresAt: number };

async function openSession(account: Parameters<typeof credentials>[0] = alice): Promise<SessionBody> {
  const res = await request('/v1/session', { method: 'POST', body: await credentials(account) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as SessionBody;
  issuedSecrets.push(body.token);
  return body;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const spentNonces = async () =>
  Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifier.nonce WHERE used_at IS NOT NULL')).rows[0]?.n);

/** The four authenticated routes, sent the way web/lib/v2/notifier.ts sends them with a session. */
const dappCalls = (s: { token: string; address: string }, subscriptionId = '00000000-0000-4000-8000-000000000000') => ({
  list: () => notifier.app.request(`/v1/subscriptions?${new URLSearchParams({ address: s.address })}`, { headers: bearer(s.token) }),
  save: (channel: string, prefs: unknown, target?: unknown) =>
    notifier.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { ...bearer(s.token), 'content-type': 'application/json' },
      body: JSON.stringify({ address: s.address, channel, ...(target === undefined ? {} : { target }), prefs }),
    }),
  remove: (id = subscriptionId) =>
    notifier.app.request(`/v1/subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...bearer(s.token), 'content-type': 'application/json' },
      body: JSON.stringify({ address: s.address }),
    }),
  telegramLink: () => notifier.app.request(`/v1/telegram/link?${new URLSearchParams({ address: s.address })}`, { headers: bearer(s.token) }),
});

test('POST /v1/session: a signed challenge opens a 30-minute session, for an EOA and an ERC-1271 wallet', async () => {
  const creds = await credentials(alice);
  const res = await request('/v1/session', { method: 'POST', body: { ...creds, address: alice.address.toLowerCase() } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as SessionBody;
  issuedSecrets.push(body.token);
  assert.deepEqual(Object.keys(body).sort(), ['address', 'expiresAt', 'token']);
  assert.equal(body.address, alice.address, 'checksummed');
  assert.equal(body.expiresAt, Math.floor(clock.ms / 1000) + 30 * 60);
  assert.match(body.token, /^v1\.0x[0-9a-fA-F]{40}\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await dappCalls(body).list()).status, 200);

  const safe = { address: SAFE, sign: async () => SAFE_SIGNATURE };
  const safeSession = await openSession(safe);
  assert.equal(safeSession.address, SAFE);
  const listed = await dappCalls(safeSession).list();
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { items: [] });

  // Same failures as every signed route; a bearer never stands in for the signature here (no refresh).
  const forged = await request('/v1/session', { method: 'POST', body: { ...(await credentials(alice)), signature: await bob.signMessage({ message: 'x' }) } });
  assert.deepEqual([forged.status, await codeOf(forged)], [401, 'signature-invalid']);
  const refresh = await request('/v1/session', { method: 'POST', headers: bearer(body.token), body: { address: alice.address } });
  assert.deepEqual([refresh.status, await codeOf(refresh)], [400, 'bad-request']);
  assert.equal((await request('/v1/session', { method: 'POST', body: '{nope' })).status, 400);
});

test('POST /v1/session spends its nonce: one signature opens one session and nothing else', async () => {
  const creds = await credentials(alice);
  assert.equal((await request('/v1/session', { method: 'POST', body: creds })).status, 200);
  const again = await request('/v1/session', { method: 'POST', body: creds });
  assert.deepEqual([again.status, await codeOf(again)], [401, 'nonce-invalid']);
  const reuse = await request(`/v1/subscriptions?${query(creds)}`);
  assert.deepEqual([reuse.status, await codeOf(reuse)], [401, 'nonce-invalid']);

  // A nonce spent on a route cannot open a session afterwards.
  const used = await credentials(alice);
  assert.equal((await request(`/v1/subscriptions?${query(used)}`)).status, 200);
  const late = await request('/v1/session', { method: 'POST', body: used });
  assert.deepEqual([late.status, await codeOf(late)], [401, 'nonce-invalid']);

  // A malformed session request spends nothing.
  const fresh = await credentials(alice);
  const extra = await request('/v1/session', { method: 'POST', body: { ...fresh, channel: 'webpush' } });
  assert.deepEqual([extra.status, await codeOf(extra)], [400, 'bad-request']);
  const ok = await request('/v1/session', { method: 'POST', body: fresh });
  assert.equal(ok.status, 200);
  issuedSecrets.push(((await ok.json()) as SessionBody).token);
});

test('a session bearer is accepted on all four routes, exactly as the dapp sends them, and spends no nonce', async () => {
  const session = await openSession(alice);
  const spent = await spentNonces();
  const dapp = dappCalls(session);

  const push = await dapp.save('webpush', { fills: false }, browserSubscription(ENDPOINT));
  assert.equal(push.status, 201);
  const pushId = ((await push.json()) as { id: string }).id;
  const telegram = await dapp.save('telegram', { autoRoll: false });
  assert.equal(telegram.status, 201);
  const telegramId = ((await telegram.json()) as { id: string }).id;

  const list = await dapp.list();
  assert.equal(list.status, 200);
  const { items } = (await list.json()) as { items: { id: string; channel: string }[] };
  assert.deepEqual(items.map((i) => i.channel).sort(), ['telegram', 'webpush']);

  const link = await dapp.telegramLink();
  assert.equal(link.status, 200);
  assert.match(((await link.json()) as { deepLink: string }).deepLink, /^https:\/\/t\.me\/stonkhouse_test_bot\?start=/);

  const removed = await dapp.remove(pushId);
  assert.deepEqual([removed.status, await removed.json()], [200, { ok: true }]);

  // `address` is optional with a bearer, and matches case-insensitively when sent.
  const noAddress = await notifier.app.request('/v1/subscriptions', { headers: bearer(session.token) });
  assert.equal(noAddress.status, 200);
  const lower = await notifier.app.request(`/v1/subscriptions?address=${alice.address.toLowerCase()}`, { headers: bearer(session.token) });
  assert.equal(lower.status, 200);
  const saveNoAddress = await notifier.app.request('/v1/subscriptions', {
    method: 'POST',
    headers: { ...bearer(session.token), 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'telegram', prefs: { fills: false } }),
  });
  assert.equal(saveNoAddress.status, 200, 'the same Telegram row, updated');
  assert.equal((await notifier.app.request('/v1/telegram/link', { headers: bearer(session.token) })).status, 200);
  // DELETE needs only the bearer: no query, no body, no content-type.
  const bare = await notifier.app.request(`/v1/subscriptions/${telegramId}`, { method: 'DELETE', headers: bearer(session.token) });
  assert.deepEqual([bare.status, await bare.json()], [200, { ok: true }]);

  assert.deepEqual(((await (await dapp.list()).json()) as { items: unknown[] }).items, []);
  assert.equal(await spentNonces(), spent, 'no nonce was spent after the session opened');
});

test('a session is bound to its address: another address in the query or body is 403 forbidden', async () => {
  const { body: bobs } = await subscribeWebPush(bob, 'https://fcm.googleapis.com/fcm/send/other-wallet-endpoint');
  const session = await openSession(alice);
  const asBob = dappCalls({ token: session.token, address: bob.address });

  for (const res of [
    await asBob.list(),
    await asBob.save('telegram', {}),
    await asBob.remove(bobs.id),
    await asBob.telegramLink(),
    await notifier.app.request('/v1/subscriptions?address=0x123', { headers: bearer(session.token) }),
    await notifier.app.request('/v1/subscriptions?address=', { headers: bearer(session.token) }),
  ]) {
    assert.deepEqual([res.status, await codeOf(res)], [403, 'forbidden']);
  }
  // Without an address the bearer's own wallet is used: bob's row is not alice's to delete.
  const bare = await notifier.app.request(`/v1/subscriptions/${bobs.id}`, { method: 'DELETE', headers: bearer(session.token) });
  assert.equal(bare.status, 404);
  const bobsList = (await (await request(`/v1/subscriptions?${query(await credentials(bob))}`)).json()) as { items: unknown[] };
  assert.equal(bobsList.items.length, 1);
});

test('an expired session is 401 session-invalid on every route (injected clock)', async () => {
  const session = await openSession(alice);
  const dapp = dappCalls(session);
  clock.advance(30 * 60_000 - 1_000);
  assert.equal((await dapp.list()).status, 200, 'one second before expiresAt');
  clock.advance(1_000);
  assert.equal(Math.floor(clock.ms / 1000), session.expiresAt);
  for (const res of [await dapp.list(), await dapp.save('telegram', {}), await dapp.remove(), await dapp.telegramLink()]) {
    assert.deepEqual([res.status, await codeOf(res)], [401, 'session-invalid']);
  }
});

test('a tampered, malformed or foreign token is 401 session-invalid', async () => {
  const session = await openSession(alice);
  const [version, address, expires, mac = ''] = session.token.split('.');
  const flipped = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  const foreign = sessionTokens(createTargetCipher(Buffer.from('b2'.repeat(32), 'hex'))).issue(alice.address, clock.now());
  issuedSecrets.push(foreign.token);

  const headers = [
    `Bearer ${version}.${address}.${expires}.${flipped}`,
    `Bearer ${version}.${address}.${Number(expires) + 86_400}.${mac}`,
    `Bearer ${version}.${bob.address}.${expires}.${mac}`,
    `Bearer ${version}.${alice.address.toLowerCase()}.${expires}.${mac}`,
    `Bearer ${session.token.slice(0, -1)}`,
    `Bearer ${foreign.token}`,
    'Bearer not-a-session',
    'Bearer',
    `Basic ${session.token}`,
    session.token,
  ];
  for (const authorization of headers) {
    const res = await notifier.app.request(`/v1/subscriptions?address=${alice.address}`, { headers: { authorization } });
    assert.deepEqual([res.status, await codeOf(res)], [401, 'session-invalid'], authorization.slice(0, 20));
  }
  assert.equal((await dappCalls(session).list()).status, 200, 'the untouched token still works');
});

test('a bearer beats signature/nonce sent in the same request, and that nonce is not spent', async () => {
  const session = await openSession(alice);
  const creds = await credentials(alice);
  const spent = await spentNonces();

  assert.equal((await notifier.app.request(`/v1/subscriptions?${query(creds)}`, { headers: bearer(session.token) })).status, 200);
  const saved = await notifier.app.request('/v1/subscriptions', {
    method: 'POST',
    headers: { ...bearer(session.token), 'content-type': 'application/json' },
    body: JSON.stringify({ ...creds, channel: 'telegram', prefs: {} }),
  });
  assert.equal(saved.status, 201);
  const savedId = ((await saved.json()) as { id: string }).id;
  assert.equal((await notifier.app.request(`/v1/telegram/link?${query(creds)}`, { headers: bearer(session.token) })).status, 200);
  const del = await notifier.app.request(`/v1/subscriptions/${savedId}`, {
    method: 'DELETE',
    headers: { ...bearer(session.token), 'content-type': 'application/json' },
    body: JSON.stringify(creds),
  });
  assert.equal(del.status, 200);
  // A garbage signature is not even looked at under a bearer.
  const garbage = new URLSearchParams({ address: alice.address, signature: 'nope', nonce: 'short' });
  assert.equal((await notifier.app.request(`/v1/subscriptions?${garbage}`, { headers: bearer(session.token) })).status, 200);
  // A bad bearer still wins over a good signature: 401, and the nonce survives that too.
  const bad = await notifier.app.request(`/v1/subscriptions?${query(creds)}`, { headers: bearer('v1.bad') });
  assert.deepEqual([bad.status, await codeOf(bad)], [401, 'session-invalid']);

  assert.equal(await spentNonces(), spent);
  assert.equal((await request(`/v1/subscriptions?${query(creds)}`)).status, 200, 'the nonce is still live without the bearer');
  assert.equal((await request(`/v1/subscriptions?${query(creds)}`)).status, 401, 'and single-use');
});

test('CORS preflight admits the Authorization header from APP_URL', async () => {
  for (const [path, method] of [
    ['/v1/subscriptions', 'GET'],
    ['/v1/subscriptions', 'POST'],
    ['/v1/subscriptions/00000000-0000-4000-8000-000000000000', 'DELETE'],
    ['/v1/telegram/link', 'GET'],
    ['/v1/session', 'POST'],
  ] as const) {
    const res = await notifier.app.request(path, {
      method: 'OPTIONS',
      headers: { origin: APP_URL, 'access-control-request-method': method, 'access-control-request-headers': 'authorization, content-type' },
    });
    assert.equal(res.status, 204, `${method} ${path}`);
    assert.equal(res.headers.get('access-control-allow-origin'), APP_URL);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase());
    assert.ok(allowed.includes('authorization') && allowed.includes('content-type'), allowed.join(','));
    assert.match(res.headers.get('access-control-allow-methods') ?? '', new RegExp(method));
  }
  const session = await openSession(alice);
  const actual = await notifier.app.request('/v1/subscriptions', { headers: { ...bearer(session.token), origin: APP_URL } });
  assert.equal(actual.status, 200);
  assert.equal(actual.headers.get('access-control-allow-origin'), APP_URL);
});

test('logs never carry a session token, a signature or the Authorization header', async () => {
  const creds = await credentials(alice);
  const res = await request('/v1/session', { method: 'POST', body: creds });
  const session = (await res.json()) as SessionBody;
  issuedSecrets.push(session.token);
  const dapp = dappCalls(session);
  const saved = await dapp.save('webpush', {}, browserSubscription(ENDPOINT));
  await dapp.list();
  await dapp.telegramLink();
  await dapp.remove(((await saved.json()) as { id: string }).id);
  await dappCalls({ token: session.token, address: bob.address }).list();
  await notifier.app.request('/v1/subscriptions', { headers: bearer(`${session.token}x`) });

  const text = log.lines.join('\n');
  assert.ok(text.includes('session issued') && text.includes('subscription saved') && text.includes('subscription deleted'));
  const mac = session.token.split('.')[3] ?? '';
  for (const secret of [session.token, mac, creds.signature, creds.signature.slice(2, 42), 'Bearer', 'v1.0x']) {
    assert.ok(!text.includes(secret), `log output leaked ${secret.slice(0, 12)}`);
  }
});
