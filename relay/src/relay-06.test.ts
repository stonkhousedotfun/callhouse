/**
 * SWEEP relay-06. targets.ts:53-80 postJson makes exactly one attempt; a 429 from Discord
 * (JSON `retry_after` seconds, `Retry-After` header) or Telegram (`parameters.retry_after`) is
 * reported as `http_429` with no wait-and-retry, even when the platform's requested wait fits well
 * inside RELAY_TIMEOUT_MS. With one target that is a 502 and a synchronised 5-minute retry wave
 * from every bot; with two targets it is a 200 and the rate-limited channel never gets the alert.
 *
 * Pass condition: a single 429 with a short retry_after, followed by acceptance, is a delivery.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { discordTarget, telegramTarget } from './targets.js';

const ALERT = { kind: 'v2_mm_tx_rejected', severity: 'warn' as const, message: 'vault place would revert (StaleSpot)', data: {} };

let hits = 0;
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      const first = hits % 2 === 1; // odd request: rate limited; even request: accepted
      if (req.url?.startsWith('/api/webhooks/')) {
        if (first) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.2' });
          res.end('{"message":"You are being rate limited.","retry_after":0.2,"global":false}');
        } else {
          res.writeHead(204);
          res.end();
        }
        return;
      }
      if (first) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 1","parameters":{"retry_after":1}}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"result":{"message_id":1}}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('Discord 429 with retry_after 0.2 s inside a 5 s budget is retried and delivered', async () => {
  hits = 0;
  const result = await discordTarget(`${base}/api/webhooks/1/secret`, 5000).deliver(ALERT);
  assert.deepEqual({ ok: result.ok, hits }, { ok: true, hits: 2 }, `got ${JSON.stringify(result)} after ${hits} request(s)`);
});

test('Telegram 429 with parameters.retry_after 1 s inside a 5 s budget is retried and delivered', async () => {
  hits = 0;
  const result = await telegramTarget({ botToken: '1:x', chatId: '-100', apiBase: base }, 5000).deliver(ALERT);
  assert.deepEqual({ ok: result.ok, hits }, { ok: true, hits: 2 }, `got ${JSON.stringify(result)} after ${hits} request(s)`);
});

test('429 wait longer than the deadline is reported without replaying the alert', async () => {
  hits = 0;
  const result = await discordTarget(`${base}/api/webhooks/1/secret`, 100).deliver(ALERT);
  assert.deepEqual({ result, hits }, {
    result: { target: 'discord', ok: false, status: 429, error: 'http_429' },
    hits: 1,
  });
});

test('a second 429 stops after one retry', async () => {
  let requests = 0;
  const repeated = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.01' });
      res.end('{"retry_after":0.01}');
    });
  });
  await new Promise<void>((resolve) => repeated.listen(0, '127.0.0.1', resolve));
  try {
    const port = (repeated.address() as AddressInfo).port;
    const result = await discordTarget(`http://127.0.0.1:${port}/api/webhooks/1/secret`, 1000).deliver(ALERT);
    assert.equal(result.error, 'http_429');
    assert.equal(requests, 2);
  } finally {
    repeated.closeAllConnections();
    await new Promise<void>((resolve) => repeated.close(() => resolve()));
  }
});
