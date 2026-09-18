/**
 * Telegram against a fake Bot API on 127.0.0.1 (TELEGRAM_API_BASE override, as relay's tests do).
 *
 * WHAT IS PINNED:
 *   - the link flow: a wallet's deep link → `/start <token>` read by long-polling getUpdates →
 *     a verified subscription whose sealed target is that chat; tokens are single-use, expire after
 *     15 minutes, and only their hash is stored;
 *   - /status and /stop, and /start again after /stop;
 *   - getUpdates offsets advance, so an update is handled once;
 *   - sendMessage outcomes map to delivered / transient / permanent / gone;
 *   - no log line carries the bot token, a chat id, a link token or a wallet address.
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { createTargetCipher, sha256Hex } from '../crypto.js';
import { upsertTelegramPrefs } from '../store.js';
import { prefsSchema } from '../prefs.js';
import { appLinks, type Rendered } from '../templates.js';
import {
  captureLogger,
  createTestDb,
  json,
  SAMPLE_ADDRESS,
  startFakeServer,
  TEST_BOT_TOKEN,
  TEST_DATA_KEY_HEX,
  TestClock,
  type FakeServer,
  type Recorded,
  type TestDb,
} from '../testing.js';
import { classifyTelegram, createTelegramApi, formatTelegram, LINK_TTL_MS, telegramChannel, TelegramBot } from './telegram.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const links = appLinks('https://app.stonkhouse.test');
const OTHER = '0x4088c59Eb3fB713B124f182E7083AEb3358A030B';
const CHAT = 424242;

/* ------------------------------------------------------------------ fake Bot API */

type Update = { update_id: number; message: { text: string; chat: { id: number; type: string } } };

class FakeBotApi {
  server!: FakeServer;
  updates: Update[] = [];
  nextId = 1;
  getUpdatesOffsets: number[] = [];
  sendReply: (body: { chat_id: string }) => [number, unknown] = () => [200, { ok: true, result: { message_id: 1 } }];
  getMeOk = true;

  async start(): Promise<string> {
    this.server = await startFakeServer((req, res) => this.handle(req, res));
    return this.server.url;
  }

  private handle(req: Recorded, res: ServerResponse): void {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.path);
    if (match === null || match[1] !== TEST_BOT_TOKEN) return json(res, 404, { ok: false, description: 'Not Found' });
    const body = req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf8')) as Record<string, unknown>);
    switch (match[2]) {
      case 'getMe':
        return this.getMeOk
          ? json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'stonkhouse_test_bot' } })
          : json(res, 500, { ok: false });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        this.getUpdatesOffsets.push(offset);
        return json(res, 200, { ok: true, result: this.updates.filter((u) => u.update_id >= offset) });
      }
      case 'sendMessage': {
        const [status, reply] = this.sendReply(body as { chat_id: string });
        return json(res, status, reply);
      }
      default:
        return json(res, 404, { ok: false });
    }
  }

  push(text: string, chat = CHAT, type = 'private'): void {
    this.updates.push({ update_id: this.nextId++, message: { text, chat: { id: chat, type } } });
  }

  /** Every text the bot sent to `chat`. */
  replies(chat = CHAT): string[] {
    return this.server.requests
      .filter((r) => r.path.endsWith('/sendMessage'))
      .map((r) => JSON.parse(r.body.toString('utf8')) as { chat_id: string; text: string })
      .filter((b) => String(b.chat_id) === String(chat))
      .map((b) => b.text);
  }
}

/* ------------------------------------------------------------------ harness */

let db: TestDb;
let fake: FakeBotApi;
let apiBase: string;
const clock = new TestClock();
let log = captureLogger();
const allLogs: string[] = [];

function makeBot(base = apiBase): TelegramBot {
  return new TelegramBot({
    api: createTelegramApi({ botToken: TEST_BOT_TOKEN, apiBase: base }),
    db,
    cipher,
    links,
    logger: log.logger,
    now: clock.now,
    pollTimeoutS: 0,
  });
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function telegramRows() {
  const { rows } = await db.query<{ id: string; address: string; target_enc: string | null; target_hash: string | null; prefs: { fills: boolean }; verified_at: Date | null; disabled_at: Date | null }>(
    `SELECT id, address, target_enc, target_hash, prefs, verified_at, disabled_at FROM notifier.subscription WHERE channel = 'telegram' ORDER BY created_at, address`,
  );
  return rows;
}

const tokenOf = (deepLink: string) => new URL(deepLink).searchParams.get('start') ?? '';

before(async () => {
  db = await createTestDb();
  fake = new FakeBotApi();
  apiBase = await fake.start();
});
after(async () => {
  await fake.server.close();
  await db.close();
  allLogs.push(...log.lines);
  const text = allLogs.join('\n');
  assert.ok(allLogs.length >= 5, 'the suite should have logged');
  for (const secret of [TEST_BOT_TOKEN, 'TEST-SECRET-BOT', String(CHAT), SAMPLE_ADDRESS, SAMPLE_ADDRESS.toLowerCase(), OTHER]) {
    assert.ok(!text.includes(secret), `log output leaked ${secret}`);
  }
});
beforeEach(async () => {
  await db.reset();
  clock.ms = Date.parse('2026-09-16T21:00:00Z');
  fake.updates = [];
  fake.nextId = 1;
  fake.getUpdatesOffsets = [];
  fake.server.requests.length = 0;
  fake.sendReply = () => [200, { ok: true, result: { message_id: 1 } }];
  fake.getMeOk = true;
  allLogs.push(...log.lines);
  log = captureLogger();
});

/* ------------------------------------------------------------------ link flow */

test('link flow: deep link → /start <token> over getUpdates → a verified subscription for that chat', async () => {
  const bot = makeBot();
  const link = await bot.createLink(SAMPLE_ADDRESS);
  assert.ok(link !== null);
  assert.match(link.deepLink, /^https:\/\/t\.me\/stonkhouse_test_bot\?start=[A-Za-z0-9_-]{32}$/);
  assert.equal(link.expiresAt, Math.floor((clock.ms + LINK_TTL_MS) / 1000));
  const token = tokenOf(link.deepLink);

  // Only the token's hash is stored.
  const { rows: stored } = await db.query<{ token_hash: string; address: string }>('SELECT token_hash, address FROM notifier.telegram_link');
  assert.deepEqual(stored, [{ token_hash: sha256Hex(token), address: SAMPLE_ADDRESS }]);

  fake.push(`/start ${token}`);
  bot.start();
  try {
    await until(() => fake.replies().length === 1, 'the link reply');
    await until(() => fake.getUpdatesOffsets.includes(2), 'the offset to advance past the update');
  } finally {
    await bot.stop();
  }

  assert.match(fake.replies()[0] ?? '', /^Linked to wallet 0xE378…8De3\. Its alerts will arrive in this chat\./);
  const [row] = await telegramRows();
  assert.ok(row !== undefined && row.target_enc !== null);
  assert.equal(row.address, SAMPLE_ADDRESS);
  assert.equal(cipher.decrypt(row.target_enc, `telegram:${SAMPLE_ADDRESS}`), String(CHAT));
  assert.equal(row.target_hash, cipher.hash(`telegram:${CHAT}`));
  assert.ok(row.verified_at instanceof Date);
  assert.equal(row.disabled_at, null);
  assert.equal((await db.query('SELECT 1 FROM notifier.telegram_link')).rows.length, 0, 'the token is consumed');
  // Handled once: later polls start past it, and there is still exactly one reply.
  assert.equal(fake.replies().length, 1);
});

test('new deep links replace earlier unused links for the same wallet', async () => {
  const bot = makeBot();
  const first = tokenOf((await bot.createLink(SAMPLE_ADDRESS))?.deepLink ?? '');
  const second = tokenOf((await bot.createLink(SAMPLE_ADDRESS))?.deepLink ?? '');
  const rows = (await db.query<{ token_hash: string }>('SELECT token_hash FROM notifier.telegram_link')).rows;
  assert.deepEqual(rows, [{ token_hash: sha256Hex(second) }]);
  await bot.handleUpdate({ update_id: 1, message: { text: `/start ${first}`, chat: { id: CHAT, type: 'private' } } });
  assert.match(fake.replies()[0] ?? '', /expired or was already used/);
  await bot.handleUpdate({ update_id: 2, message: { text: `/start ${second}`, chat: { id: CHAT, type: 'private' } } });
  assert.match(fake.replies()[1] ?? '', /^Linked to wallet/);
});

test('a failed update is retried before getUpdates confirms its offset', async () => {
  const retryFake = new FakeBotApi();
  const bot = makeBot(await retryFake.start());
  const token = tokenOf((await bot.createLink(SAMPLE_ADDRESS))?.deepLink ?? '');
  const original = db.transaction;
  let failOnce = true;
  db.transaction = async (fn) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('transient database failure');
    }
    return original(fn);
  };
  retryFake.push(`/start ${token}`);
  bot.start();
  try {
    await until(() => retryFake.getUpdatesOffsets.length >= 2, 'the failed update to be fetched again');
    assert.deepEqual(retryFake.getUpdatesOffsets.slice(0, 2), [0, 0]);
    await until(() => retryFake.replies().length === 1, 'the retried link to succeed');
    await until(() => Reflect.get(bot, 'offset') === 2, 'the successful update to advance the offset');
  } finally {
    db.transaction = original;
    await bot.stop();
    await retryFake.server.close();
  }
  assert.equal((await telegramRows()).length, 1);
});

test('a token is single-use and expires after 15 minutes', async () => {
  const bot = makeBot();
  const first = tokenOf((await bot.createLink(SAMPLE_ADDRESS))?.deepLink ?? '');
  await bot.handleUpdate({ update_id: 1, message: { text: `/start ${first}`, chat: { id: CHAT, type: 'private' } } });
  await bot.handleUpdate({ update_id: 2, message: { text: `/start ${first}`, chat: { id: 777, type: 'private' } } });
  assert.match(fake.replies(777)[0] ?? '', /expired or was already used/);
  assert.equal((await telegramRows()).length, 1);

  const late = tokenOf((await bot.createLink(OTHER))?.deepLink ?? '');
  clock.advance(LINK_TTL_MS);
  await bot.handleUpdate({ update_id: 3, message: { text: `/start ${late}`, chat: { id: 888, type: 'private' } } });
  assert.match(fake.replies(888)[0] ?? '', /expired or was already used/);
  assert.equal((await telegramRows()).length, 1);
});

test('prefs saved before the chat is linked are kept by /start', async () => {
  const bot = makeBot();
  await upsertTelegramPrefs(db, { address: SAMPLE_ADDRESS, prefs: prefsSchema.parse({ fills: false }), now: clock.now() });
  const [pending] = await telegramRows();
  assert.deepEqual([pending?.target_enc, pending?.verified_at], [null, null]);

  const token = tokenOf((await bot.createLink(SAMPLE_ADDRESS))?.deepLink ?? '');
  await bot.handleUpdate({ update_id: 1, message: { text: `/start ${token}`, chat: { id: CHAT, type: 'private' } } });
  const [linked] = await telegramRows();
  assert.equal(linked?.id, pending?.id);
  assert.equal(linked?.prefs.fills, false);
  assert.ok(linked?.verified_at instanceof Date);
});

test('/status lists the chat’s wallets, /stop turns them all off, /start re-enables', async () => {
  const bot = makeBot();
  const say = (text: string, id: number) => bot.handleUpdate({ update_id: id, message: { text, chat: { id: CHAT, type: 'private' } } });

  await say('/status', 1);
  assert.match(fake.replies().at(-1) ?? '', /^No wallets are linked to this chat/);

  for (const [i, address] of [SAMPLE_ADDRESS, OTHER].entries()) {
    const token = tokenOf((await bot.createLink(address))?.deepLink ?? '');
    await say(`/start ${token}`, 10 + i);
  }
  await say('/status', 2);
  const status = fake.replies().at(-1) ?? '';
  assert.match(status, /0xE378…8De3: on \(fills, settlements and payouts, strike crosses/);
  assert.match(status, /0x4088…030B: on/);

  await say('/stop', 3);
  assert.match(fake.replies().at(-1) ?? '', /^Alerts are off for this chat \(2 wallets\)/);
  assert.ok((await telegramRows()).every((r) => r.disabled_at instanceof Date));
  await say('/status', 4);
  assert.match(fake.replies().at(-1) ?? '', /^0xE378…8De3: off$/m);
  assert.match(fake.replies().at(-1) ?? '', /^0x4088…030B: off$/m);
  await say('/stop', 5);
  assert.equal(fake.replies().at(-1), 'No alerts were on for this chat.');

  const token = tokenOf((await bot.createLink(SAMPLE_ADDRESS))?.deepLink ?? '');
  await say(`/start ${token}`, 6);
  const enabled = new Map((await telegramRows()).map((r) => [r.address, r.disabled_at === null]));
  assert.equal(enabled.get(SAMPLE_ADDRESS), true, 'the wallet linked again is back on');
  assert.equal(enabled.get(OTHER), false, 'the other wallet stays off until it is linked again');
});

test('groups: /start@bot works; chatter is ignored in groups and answered with help in private', async () => {
  const bot = makeBot();
  const token = tokenOf((await bot.createLink(SAMPLE_ADDRESS))?.deepLink ?? '');
  await bot.handleUpdate({ update_id: 1, message: { text: `/start@stonkhouse_test_bot ${token}`, chat: { id: -100555, type: 'supergroup' } } });
  assert.match(fake.replies(-100555)[0] ?? '', /^Linked to wallet/);
  await bot.handleUpdate({ update_id: 2, message: { text: 'gm', chat: { id: -100555, type: 'supergroup' } } });
  assert.equal(fake.replies(-100555).length, 1);
  await bot.handleUpdate({ update_id: 5, message: { text: '/stop@another_bot', chat: { id: -100555, type: 'supergroup' } } });
  assert.equal(fake.replies(-100555).length, 1);
  assert.equal((await telegramRows())[0]?.disabled_at, null);
  await bot.handleUpdate({ update_id: 3, message: { text: 'hello', chat: { id: CHAT, type: 'private' } } });
  assert.match(fake.replies()[0] ?? '', /^This bot sends Stonkhouse alerts/);
  await bot.handleUpdate({ update_id: 4, message: { text: '/start', chat: { id: CHAT, type: 'private' } } });
  assert.equal(fake.replies().length, 2);
});

test('no deep link while the bot cannot learn its username', async () => {
  fake.getMeOk = false;
  const bot = makeBot();
  assert.equal(await bot.createLink(SAMPLE_ADDRESS), null);
  assert.equal(bot.username, null);
  fake.getMeOk = true;
  assert.ok((await bot.createLink(SAMPLE_ADDRESS)) !== null);
});

/* ------------------------------------------------------------------ channel */

const MESSAGE: Rendered = { title: 'Bought NVDA 221.00 call', body: 'Line one.\nLine two.', url: 'https://app.stonkhouse.test/NVDA/1' };

test('delivery: sendMessage carries the chat, the framed text and no link preview', async () => {
  const channel = telegramChannel(createTelegramApi({ botToken: TEST_BOT_TOKEN, apiBase }), links);
  assert.deepEqual(await channel.send(String(CHAT), MESSAGE, { subscriptionId: 's', kind: 'fill_receipt' }), { ok: true });
  const [request] = fake.server.requests;
  assert.equal(request?.path, `/bot${TEST_BOT_TOKEN}/sendMessage`);
  assert.deepEqual(JSON.parse(request?.body.toString('utf8') ?? '{}'), {
    chat_id: String(CHAT),
    text: formatTelegram(MESSAGE, links.settings()),
    link_preview_options: { is_disabled: true },
  });
  assert.equal(
    formatTelegram(MESSAGE, links.settings()),
    'Bought NVDA 221.00 call\n\nLine one.\nLine two.\n\nhttps://app.stonkhouse.test/NVDA/1\n\nAlert settings: https://app.stonkhouse.test/settings/notifications',
  );
  const long = formatTelegram({ ...MESSAGE, body: 'x'.repeat(10_000) }, links.settings());
  assert.equal(long.length, 4096);
  assert.ok(long.endsWith('Alert settings: https://app.stonkhouse.test/settings/notifications'));
});

test('delivery outcomes: blocked and chat-not-found are gone, 429 waits, 5xx and network are transient', async () => {
  const channel = telegramChannel(createTelegramApi({ botToken: TEST_BOT_TOKEN, apiBase }), links);
  const send = () => channel.send(String(CHAT), MESSAGE, { subscriptionId: 's', kind: 'fill_receipt' });
  const cases: [[number, unknown], unknown][] = [
    [[403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }], { ok: false, kind: 'gone', code: 'http_403' }],
    [[400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }], { ok: false, kind: 'gone', code: 'http_400' }],
    [[400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' }], { ok: false, kind: 'permanent', code: 'http_400' }],
    [[429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }], { ok: false, kind: 'transient', code: 'http_429', retryAfterMs: 7000 }],
    [[502, 'Bad Gateway'], { ok: false, kind: 'transient', code: 'http_502' }],
    [[401, { ok: false, description: 'Unauthorized' }], { ok: false, kind: 'transient', code: 'http_401' }],
  ];
  for (const [reply, expected] of cases) {
    fake.sendReply = () => reply;
    assert.deepEqual(await send(), expected, JSON.stringify(reply));
  }

  const unreachable = telegramChannel(createTelegramApi({ botToken: TEST_BOT_TOKEN, apiBase: 'http://127.0.0.1:1' }), links);
  const outcome = await unreachable.send(String(CHAT), MESSAGE, { subscriptionId: 's', kind: 'fill_receipt' });
  assert.equal(outcome.ok ? 'ok' : outcome.kind, 'transient');
  assert.equal(classifyTelegram({ ok: false, status: null, code: 'timeout', description: null }).ok, false);
});

test('the Bot API client has a deadline', async () => {
  const hang = await startFakeServer(() => undefined);
  try {
    const api = createTelegramApi({ botToken: TEST_BOT_TOKEN, apiBase: hang.url });
    const started = Date.now();
    const result = await api.call('getMe', {}, 150);
    assert.deepEqual(result, { ok: false, status: null, code: 'timeout', description: null });
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await hang.close();
  }
});
