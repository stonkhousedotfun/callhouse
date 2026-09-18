/**
 * The relay end to end, over real sockets, against local fake Discord and Telegram servers.
 *
 * WHAT IS PINNED:
 *   - authentication (header and ?token=) runs before anything else, and a wrong token never
 *     reaches a target;
 *   - validation refuses what is not a keeper alert, with 400, and forwards nothing;
 *   - the status contract the keeper's retry logic depends on: 200 if ANY target accepted,
 *     502 if none did — refused, unreachable, or past the deadline;
 *   - what the fake targets actually receive (body shape, Telegram's bot path);
 *   - no log line ever contains the relay token, the Discord webhook path or the bot token.
 *
 * DELIBERATELY ABSENT: any real network. Every target is 127.0.0.1.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { parseConfig, type RelayConfig } from './config.js';
import { createLogger } from './log.js';
import { MAX_BODY_BYTES, createRelayServer, tokenMatches } from './server.js';

const RELAY_TOKEN = 'relay-token-SECRET-0123456789abcdef0123456789';
const DISCORD_PATH = '/api/webhooks/42/DISCORD-SECRET-PATH';
const BOT_TOKEN = '7777:TELEGRAM-SECRET-BOT';

const SAMPLE = {
  source: 'callhouse-keeper',
  kind: 'tx_revert',
  severity: 'error',
  message: 'rollOpen reverted on chain',
  vault: '0x1111111111111111111111111111111111111111',
  chainId: 4663,
  at: '2026-09-12T20:00:00.000Z',
  data: { kind: 'rollOpen', hash: '0xabc' },
};

/* ------------------------------------------------------------ fake target */

interface Received {
  path: string;
  body: unknown;
}

type Behaviour = 'ok' | 'fail' | 'hang';

class FakeTarget {
  server: Server;
  received: Received[] = [];
  behaviour: Behaviour = 'ok';

  constructor(private readonly okReply: { status: number; body: string }) {
    this.server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.received.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        if (this.behaviour === 'hang') return; // never answer: the relay's deadline must fire
        if (this.behaviour === 'fail') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"ok":false,"description":"boom"}');
          return;
        }
        res.writeHead(this.okReply.status, { 'content-type': 'application/json' });
        res.end(this.okReply.body);
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/* ------------------------------------------------------------ harness */

const discord = new FakeTarget({ status: 204, body: '' });
const telegram = new FakeTarget({ status: 200, body: '{"ok":true,"result":{"message_id":1}}' });
let discordBase = '';
let telegramBase = '';
const logLines: string[] = [];

async function startRelay(config: RelayConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createRelayServer(config, { logger: createLogger((line) => logLines.push(line)) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function configFor(overrides: Record<string, string | undefined> = {}): RelayConfig {
  return parseConfig({
    RELAY_TOKEN,
    DISCORD_WEBHOOK_URL: `${discordBase}${DISCORD_PATH}`,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: '-100555',
    TELEGRAM_API_BASE: telegramBase,
    RELAY_TIMEOUT_MS: '300',
    ...overrides,
  });
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const auth = { authorization: `Bearer ${RELAY_TOKEN}` };

before(async () => {
  discordBase = await discord.start();
  telegramBase = await telegram.start();
});

after(async () => {
  await discord.stop();
  await telegram.stop();
  const all = logLines.join('\n');
  // Guard against a vacuous pass: the suite exercised 401, 400, 413, 200 and 502 paths.
  assert.ok(logLines.length >= 10, `expected the suite to have logged, got ${logLines.length} lines`);
  assert.ok(all.includes('"status":401') && all.includes('"status":502'));
  // The whole suite's log output, including every failure path above, carries no secret.
  for (const secret of [RELAY_TOKEN, 'DISCORD-SECRET-PATH', 'TELEGRAM-SECRET-BOT']) {
    assert.ok(!all.includes(secret), `log output leaked ${secret}`);
  }
});

beforeEach(() => {
  discord.received = [];
  telegram.received = [];
  discord.behaviour = 'ok';
  telegram.behaviour = 'ok';
});

/* ------------------------------------------------------------ tests */

test('tokenMatches: exact match only, constant-time over digests, any length', () => {
  assert.equal(tokenMatches(RELAY_TOKEN, RELAY_TOKEN), true);
  assert.equal(tokenMatches(`${RELAY_TOKEN}x`, RELAY_TOKEN), false);
  assert.equal(tokenMatches('short', RELAY_TOKEN), false);
  assert.equal(tokenMatches('', RELAY_TOKEN), false);
  assert.equal(tokenMatches(null, RELAY_TOKEN), false);
});

describe('with both targets configured', () => {
  let relay: { url: string; close: () => Promise<void> };
  before(async () => {
    relay = await startRelay(configFor());
  });
  after(async () => {
    await relay.close();
  });

  test('GET /health: 200, no auth, names the targets and nothing else', async () => {
    const res = await fetch(`${relay.url}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { status: 'ok', service: 'callhouse-relay', targets: ['discord', 'telegram'] });
  });

  test('unknown route 404, wrong method 405', async () => {
    assert.equal((await fetch(`${relay.url}/nope`)).status, 404);
    assert.equal((await fetch(`${relay.url}/alert`)).status, 405);
    assert.equal((await post(`${relay.url}/health`, {})).status, 405);
  });

  describe('authentication', () => {
    test('no token → 401, nothing forwarded', async () => {
      const res = await post(`${relay.url}/alert`, SAMPLE);
      assert.equal(res.status, 401);
      assert.equal(discord.received.length + telegram.received.length, 0);
    });

    test('wrong bearer → 401', async () => {
      const res = await post(`${relay.url}/alert`, SAMPLE, { authorization: 'Bearer nope' });
      assert.equal(res.status, 401);
      assert.equal(discord.received.length + telegram.received.length, 0);
    });

    test('wrong ?token= → 401', async () => {
      const res = await post(`${relay.url}/alert?token=${encodeURIComponent(`${RELAY_TOKEN}0`)}`, SAMPLE);
      assert.equal(res.status, 401);
    });

    test('a bad token is refused before the body is even validated', async () => {
      const res = await post(`${relay.url}/alert`, 'not json');
      assert.equal(res.status, 401);
    });

    test('correct legacy ?token= → 200', async () => {
      const res = await post(`${relay.url}/alert?token=${encodeURIComponent(RELAY_TOKEN)}`, SAMPLE);
      assert.equal(res.status, 200);
    });
  });

  describe('validation', () => {
    test('not JSON → 400, nothing forwarded', async () => {
      const res = await post(`${relay.url}/alert`, '{not json', auth);
      assert.equal(res.status, 400);
      assert.equal(discord.received.length + telegram.received.length, 0);
    });

    test('not a keeper alert → 400 with issues, nothing forwarded', async () => {
      const res = await post(`${relay.url}/alert`, { ...SAMPLE, severity: 'fatal' }, auth);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { issues: { path: string }[] };
      assert.ok(body.issues.some((i) => i.path === 'severity'));
      assert.equal(discord.received.length + telegram.received.length, 0);
    });

    test('body over the cap → 413', async () => {
      const huge = { ...SAMPLE, data: { blob: 'x'.repeat(MAX_BODY_BYTES) } };
      const res = await post(`${relay.url}/alert`, huge, auth);
      assert.equal(res.status, 413);
      assert.equal(discord.received.length + telegram.received.length, 0);
    });
  });

  describe('delivery', () => {
    test('both accept → 200, and each target got its own shape', async () => {
      const res = await post(`${relay.url}/alert`, SAMPLE, auth);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, delivered: ['discord', 'telegram'], failed: [] });

      assert.equal(discord.received.length, 1);
      assert.equal(discord.received[0]?.path, DISCORD_PATH);
      const d = discord.received[0]?.body as { content: string; allowed_mentions: unknown };
      assert.ok(d.content.startsWith('🔴 **ERROR** `tx_revert` rollOpen reverted on chain'));
      assert.deepEqual(d.allowed_mentions, { parse: [] });

      assert.equal(telegram.received.length, 1);
      assert.equal(telegram.received[0]?.path, `/bot${BOT_TOKEN}/sendMessage`);
      const t = telegram.received[0]?.body as { chat_id: string; text: string };
      assert.equal(t.chat_id, '-100555');
      assert.ok(t.text.startsWith('🔴 ERROR tx_revert\nrollOpen reverted on chain'));
    });

    test('one target fails, the other accepts → still 200 (a retry would duplicate the delivered one)', async () => {
      discord.behaviour = 'fail';
      const res = await post(`${relay.url}/alert`, SAMPLE, auth);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true,
        delivered: ['telegram'],
        failed: [{ target: 'discord', status: 500, error: 'http_500' }],
      });
    });

    test('every target refuses → 502, so the keeper retries', async () => {
      discord.behaviour = 'fail';
      telegram.behaviour = 'fail';
      const res = await post(`${relay.url}/alert`, SAMPLE, auth);
      assert.equal(res.status, 502);
      const body = (await res.json()) as { ok: boolean; delivered: string[] };
      assert.equal(body.ok, false);
      assert.deepEqual(body.delivered, []);
    });

    test('every target hangs past RELAY_TIMEOUT_MS → 502 with `timeout`, answered promptly', async () => {
      discord.behaviour = 'hang';
      telegram.behaviour = 'hang';
      const started = Date.now();
      const res = await post(`${relay.url}/alert`, SAMPLE, auth);
      const elapsed = Date.now() - started;
      assert.equal(res.status, 502);
      const body = (await res.json()) as { failed: { error: string }[] };
      assert.deepEqual(body.failed.map((f) => f.error), ['timeout', 'timeout']);
      assert.ok(elapsed < 3000, `took ${elapsed} ms; targets run in parallel under one deadline`);
    });

    test('Telegram 200 without {ok:true} is not a delivery', async () => {
      const liar = new FakeTarget({ status: 200, body: '{"ok":false,"description":"chat not found"}' });
      const base = await liar.start();
      const r = await startRelay(configFor({ DISCORD_WEBHOOK_URL: undefined, TELEGRAM_API_BASE: base }));
      try {
        const res = await post(`${r.url}/alert`, SAMPLE, auth);
        assert.equal(res.status, 502);
      } finally {
        await r.close();
        await liar.stop();
      }
    });
  });
});

test('Discord only, target unreachable → 502 with a code, not a message', async () => {
  // Bind and immediately release a port so nothing is listening on it.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const relay = await startRelay(
    parseConfig({ RELAY_TOKEN, DISCORD_WEBHOOK_URL: `http://127.0.0.1:${deadPort}${DISCORD_PATH}`, RELAY_TIMEOUT_MS: '1000' }),
  );
  try {
    const res = await post(`${relay.url}/alert`, SAMPLE, auth);
    assert.equal(res.status, 502);
    const body = (await res.json()) as { failed: { target: string; status: number | null; error: string }[] };
    assert.deepEqual(body.failed, [{ target: 'discord', status: null, error: 'ECONNREFUSED' }]);
    assert.ok(!JSON.stringify(body).includes('DISCORD-SECRET-PATH'));
  } finally {
    await relay.close();
  }
});
