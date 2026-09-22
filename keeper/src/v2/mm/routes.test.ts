/**
 * The kill switch's HTTP edge: POST /kill and POST /resume on the MM bot's health port.
 *
 * WHY THIS FILE EXISTS: /kill is the one control an operator has over a quoting bot besides revoking its role. A route
 * that accepts a wrong or missing token lets anyone on the private network stop the market maker; one that refuses the
 * right token leaves a misbehaving bot quoting. Pinned: only `Bearer <MM_KILL_TOKEN>` passes, the same 401 body for
 * every refusal, the token never echoed, the reason read from an optional body, 200 when the cancels finished and 202
 * when they are still running, GET refused, and the routes listed on `/`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { createModeHealthApp, ModeHealth } from '../health.js';
import { bearerMatches, mountKillRoutes, type KillOutcome, type KillSwitch } from './routes.js';

const TOKEN = 'ab'.repeat(32);

function setup(outcome: Partial<KillOutcome> = {}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const target: KillSwitch = {
    async kill(reason) {
      calls.push(`kill:${reason}`);
      return { killed: true, at: 1, reason, cancelled: 3, remaining: 0, remainingOrderIds: [], done: true, errors: [], ...outcome };
    },
    resume() {
      calls.push('resume');
      return { killed: false, at: 2 };
    },
  };
  const app = new Hono();
  mountKillRoutes(app, { token: () => TOKEN, target, log: { warn: (_o, msg) => warnings.push(msg) } });
  return { app, calls, warnings };
}

test('bearerMatches: exactly Bearer <token>; anything else is refused', () => {
  assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false, 'a prefix');
  assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), false);
  assert.equal(bearerMatches(TOKEN, TOKEN), false);
  assert.equal(bearerMatches('Bearer ', TOKEN), false);
  assert.equal(bearerMatches(undefined, TOKEN), false);
  assert.equal(bearerMatches(null, TOKEN), false);
  assert.equal(bearerMatches('Bearer ', ''), false, 'an empty configured token never matches');
});

test('POST /kill: 401 without the token, with a wrong one, or with it outside the Authorization header; the target is untouched', async () => {
  const { app, calls, warnings } = setup();
  for (const headers of [{}, { authorization: `Bearer ${'cd'.repeat(32)}` }, { authorization: `Basic ${TOKEN}` }, { 'x-kill-token': TOKEN }] as Array<Record<string, string>>) {
    const res = await app.request('/kill', { method: 'POST', headers });
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.equal(text, JSON.stringify({ error: 'unauthorized' }));
    assert.doesNotMatch(text, new RegExp(TOKEN));
  }
  assert.equal((await app.request(`/kill?token=${TOKEN}`, { method: 'POST' })).status, 401);
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 5);
});

test('POST /kill: 200 with the outcome once the cancels are done, 202 while they run; the reason comes from the body', async () => {
  const { app, calls } = setup();
  const res = await app.request('/kill', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: '  vol spike  ' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { killed: true, at: 1, reason: 'vol spike', cancelled: 3, remaining: 0, remainingOrderIds: [], done: true, errors: [] });
  await app.request('/kill', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  await app.request('/kill', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: 'not json' });
  assert.deepEqual(calls, ['kill:vol spike', 'kill:POST /kill', 'kill:POST /kill']);

  const slow = setup({ done: false, remaining: -1 });
  assert.equal((await slow.app.request('/kill', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 202);
});

test('POST /kill {vault} still uses the same 401 body; a valid token forwards the vault', async () => {
  const calls: string[] = [];
  const target: KillSwitch = {
    async kill(reason, vault) {
      calls.push(`kill:${reason}:${vault ?? ''}`);
      return { killed: true, at: 1, reason, cancelled: 0, remaining: 0, remainingOrderIds: [], done: true, errors: [] };
    },
    resume(vault) {
      calls.push(`resume:${vault ?? ''}`);
      return { killed: false, at: 2 };
    },
  };
  const app = new Hono();
  mountKillRoutes(app, { token: () => TOKEN, target });
  const denied = await app.request('/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vault: '0xabc' }) });
  assert.equal(denied.status, 401);
  assert.equal(await denied.text(), JSON.stringify({ error: 'unauthorized' }));
  const vault = '0x00000000000000000000000000000000000000aa';
  const res = await app.request('/kill', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ vault, reason: 'one' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [`kill:one:${vault}`]);
});

test('POST /resume needs the token too; GET on either path is 405', async () => {
  const { app, calls } = setup();
  assert.equal((await app.request('/resume', { method: 'POST' })).status, 401);
  const res = await app.request('/resume', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { killed: false, at: 2 });
  assert.equal((await app.request('/kill')).status, 405);
  assert.equal((await app.request('/resume')).status, 405);
  assert.deepEqual(calls, ['resume']);
});

test('the mode health app mounts the routes and lists them on /', async () => {
  const target: KillSwitch = { kill: async (reason) => ({ killed: true, at: 0, reason, cancelled: 0, remaining: 0, remainingOrderIds: [], done: true, errors: [] }), resume: () => ({ killed: false, at: 0 }) };
  const app = createModeHealthApp({
    mode: 'mm',
    health: new ModeHealth(0),
    limits: { pollIntervalMs: 60_000, txTimeoutMs: 180_000, rpcLagAlertMs: 300_000, minGasWei: 0n },
    chainId: 4663,
    rpcUrls: ['http://127.0.0.1:9'],
    signer: '0x0000000000000000000000000000000000000001',
    contracts: {},
    store: null,
    routes: { mount: (a) => mountKillRoutes(a, { token: () => TOKEN, target }), endpoints: ['POST /kill', 'POST /resume'] },
    now: () => 0,
  });
  assert.deepEqual(((await (await app.request('/')).json()) as { endpoints: string[] }).endpoints, ['/health', '/state', 'POST /kill', 'POST /resume']);
  assert.equal((await app.request('/kill', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await app.request('/health')).status, 200);
});
