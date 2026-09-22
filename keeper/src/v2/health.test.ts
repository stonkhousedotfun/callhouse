/**
 * The signing modes' health rules, HTTP surface and poll loop.
 *
 * WHY THIS FILE EXISTS: whatever reads /health restarts the process on a 503, so the code must mean
 * "the loop is wedged" and nothing else; v1 learned that a restart on low gas or a lagging RPC is a
 * crash loop that also kills in-flight transactions. The loop must never overlap two ticks, survive
 * a tick that throws, and let the in-flight tick finish on stop.
 *
 * GET /ready (T-423) is readiness, not liveness, and public-safe: five keys, a closed set of reasons, and
 * no path from "unknown" to ready. The pricer's own rule is pinned in pricer/pricer.test.ts.
 *
 * DELIBERATELY ABSENT: sockets. The app is driven with `app.request`; runtime.test.ts binds a port.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModeHealth, READY_REASONS, createModeHealthApp, evaluateHealth, readyBody, readyRoute, type HealthLimits, type Readiness, type ReadyReason } from './health.js';
import { startLoop } from './loop.js';
import { INTERFACE_VERSION } from './registry.js';
import { V2Store } from './store.js';

const LIMITS: HealthLimits = { pollIntervalMs: 60_000, txTimeoutMs: 180_000, rpcLagAlertMs: 300_000, minGasWei: 10n ** 16n };
const T0 = 1_790_000_000_000;
const GOOD_CHAIN = { headBlock: 65_000_000n, headTimestamp: T0 / 1000, rpcLagSeconds: 2, balanceWei: 10n ** 17n };

function healthAt(setup: (h: ModeHealth) => void): ModeHealth {
  const h = new ModeHealth(T0);
  setup(h);
  return h;
}

/*//////////////////////////////////////////////////////////////
                            THE RULES
//////////////////////////////////////////////////////////////*/

test('evaluateHealth: starting inside the grace window; wedged (503) only with no beat for 3 intervals and no tick in flight', () => {
  assert.deepEqual(evaluateHealth(healthAt(() => {}), LIMITS, T0 + 1_000), {
    status: 'starting',
    alive: true,
    checks: { heartbeat: true, rpcLag: false, gas: false, alerting: true },
  });
  // Never ticked, grace over: wedged.
  assert.equal(evaluateHealth(healthAt(() => {}), LIMITS, T0 + 180_000).alive, false);

  const beaten = healthAt((h) => {
    h.recordChain(GOOD_CHAIN);
    h.beat(T0);
  });
  assert.deepEqual(evaluateHealth(beaten, LIMITS, T0 + 179_999), { status: 'ok', alive: true, checks: { heartbeat: true, rpcLag: true, gas: true, alerting: true } });
  assert.deepEqual(evaluateHealth(beaten, LIMITS, T0 + 180_000), { status: 'degraded', alive: false, checks: { heartbeat: false, rpcLag: true, gas: true, alerting: true } });

  // A tick waiting on a receipt is alive for KEEPER_TX_TIMEOUT_MS plus a minute, however old the beat.
  beaten.tickStarted(T0 + 170_000);
  assert.equal(evaluateHealth(beaten, LIMITS, T0 + 170_000 + 239_999).alive, true);
  assert.equal(evaluateHealth(beaten, LIMITS, T0 + 170_000 + 240_000).alive, false);
});

test('evaluateHealth: low gas and a lagging RPC are degraded on a 200, never a 503', () => {
  const poor = healthAt((h) => {
    h.recordChain({ ...GOOD_CHAIN, balanceWei: 1n });
    h.beat(T0);
  });
  assert.deepEqual(evaluateHealth(poor, LIMITS, T0 + 1), { status: 'degraded', alive: true, checks: { heartbeat: true, rpcLag: true, gas: false, alerting: true } });
  const lagging = healthAt((h) => {
    h.recordChain({ ...GOOD_CHAIN, rpcLagSeconds: 301 });
    h.beat(T0);
  });
  assert.deepEqual(evaluateHealth(lagging, LIMITS, T0 + 1), { status: 'degraded', alive: true, checks: { heartbeat: true, rpcLag: false, gas: true, alerting: true } });
});

/*//////////////////////////////////////////////////////////////
                              HTTP
//////////////////////////////////////////////////////////////*/

test('the app: /health with bigints as strings and RPC origins only, /state 503 then the mode\'s view, / lists endpoints', async () => {
  let now = T0 + 1_000;
  let view: unknown = null;
  const health = new ModeHealth(T0);
  const store = new V2Store(':memory:');
  const app = createModeHealthApp({
    mode: 'cranker',
    health,
    limits: LIMITS,
    chainId: 4663,
    rpcUrls: ['https://rpc.example/v2/SECRET-KEY', 'https://backup.example/?apikey=SECRET'],
    signer: '0x000000000000000000000000000000000000bEEF',
    contracts: { clearinghouse: '0x00000000000000000000000000000000000000C1', makerVault: null },
    store,
    state: () => view,
    now: () => now,
  });

  const starting = await app.request('/health');
  assert.equal(starting.status, 200);
  const startingBody = (await starting.json()) as Record<string, unknown>;
  assert.equal(startingBody.status, 'starting');
  assert.equal(JSON.stringify(startingBody).includes('SECRET'), false);
  assert.deepEqual((startingBody.chain as { rpc: string[] }).rpc, ['https://rpc.example', 'https://backup.example']);

  health.tickStarted(now);
  health.recordChain(GOOD_CHAIN);
  health.beat(now);
  health.tickEnded();
  now += 5_000;
  const ok = await app.request('/health');
  const body = (await ok.json()) as Record<string, any>;
  assert.equal(ok.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.mode, 'cranker');
  assert.equal(body.ticks, 1);
  assert.equal(body.lastHeartbeatAgeSeconds, 5);
  assert.equal(body.chain.headBlock, '65000000');
  assert.equal(body.signer.balanceWei, '100000000000000000');
  assert.equal(body.signer.minBalanceWei, '10000000000000000');
  assert.deepEqual(body.db.rows, { v2_txs: 0, v2_alerts: 0, v2_meta: 0 });
  assert.equal(body.contracts.makerVault, null);

  now += 180_000;
  assert.equal((await app.request('/health')).status, 503, 'wedged');

  const noState = await app.request('/state');
  assert.equal(noState.status, 503);
  view = { steps: { settle: { sent: 2n } } };
  assert.deepEqual(await (await app.request('/state')).json(), { steps: { settle: { sent: '2' } } });
  assert.deepEqual(await (await app.request('/')).json(), { service: 'callhouse-cranker', mode: 'cranker', endpoints: ['/health', '/state'] });
  store.close();
});

/*//////////////////////////////////////////////////////////////
                              LOOP
//////////////////////////////////////////////////////////////*/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('startLoop: first tick at once, never two at a time, a throwing tick is handed to onError and the loop goes on', async () => {
  let running = 0;
  let maxRunning = 0;
  let ticks = 0;
  const errors: string[] = [];
  const loop = startLoop({
    intervalMs: 1,
    tick: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      ticks += 1;
      await sleep(5);
      running -= 1;
      if (ticks === 2) throw new Error('tick two failed');
    },
    onError: (error) => {
      errors.push((error as Error).message);
    },
  });
  assert.equal(ticks, 1, 'the first tick starts synchronously');
  while (ticks < 4) await sleep(2);
  await loop.stop();
  assert.equal(maxRunning, 1);
  assert.deepEqual(errors, ['tick two failed']);
});

test('startLoop: stop() waits for the in-flight tick and schedules nothing after; wake() runs the next tick now', async () => {
  let ticks = 0;
  let finished = false;
  const loop = startLoop({
    intervalMs: 60_000,
    tick: async () => {
      ticks += 1;
      if (ticks === 2) {
        await sleep(20);
        finished = true;
      }
    },
    onError: () => {},
  });
  await sleep(5);
  assert.equal(ticks, 1, 'the next tick waits for the interval');
  loop.wake();
  assert.equal(ticks, 2, 'woken at once');
  loop.wake(); // in flight: ignored
  await loop.stop();
  assert.equal(finished, true, 'stop resolved only after the in-flight tick finished');
  await sleep(10);
  assert.equal(ticks, 2);
});

test('startLoop: an onError that throws does not end the loop either', async () => {
  let ticks = 0;
  const loop = startLoop({
    intervalMs: 1,
    tick: async () => {
      ticks += 1;
      throw new Error('tick');
    },
    onError: () => {
      throw new Error('handler');
    },
  });
  while (ticks < 3) await sleep(2);
  await loop.stop();
});

test('evaluateHealth: a page the relay did not take is degraded (a 200) until a later delivery succeeds; no page yet is fine', () => {
  const h = healthAt((x) => {
    x.recordChain(GOOD_CHAIN);
    x.beat(T0);
  });
  assert.equal(evaluateHealth(h, LIMITS, T0 + 1).checks.alerting, true, 'nothing sent yet');
  h.recordAlertDelivery(T0, false, 'alert webhook rejected the POST (401)');
  assert.deepEqual(evaluateHealth(h, LIMITS, T0 + 1), { status: 'degraded', alive: true, checks: { heartbeat: true, rpcLag: true, gas: true, alerting: false } });
  h.recordAlertDelivery(T0 + 60_000, true, null);
  assert.equal(evaluateHealth(h, LIMITS, T0 + 60_001).status, 'ok');
});

test('evaluateHealth: a long tick that keeps making progress (a beat per send) stays alive; the receipt wait after its last send is granted from that send', () => {
  const h = healthAt((x) => {
    x.recordChain(GOOD_CHAIN);
    x.beat(T0);
  });
  h.tickStarted(T0);
  // Ten minutes into a settlement wave, the last send 170 s ago and its successor waiting on a receipt.
  h.beat(T0 + 430_000);
  assert.equal(evaluateHealth(h, LIMITS, T0 + 600_000).alive, true);
  assert.equal(evaluateHealth(h, LIMITS, T0 + 430_000 + 239_999).alive, true, 'KEEPER_TX_TIMEOUT_MS + 60 s from the last progress');
  assert.equal(evaluateHealth(h, LIMITS, T0 + 430_000 + 240_000).alive, false, 'no progress for that long: wedged');
});

/*//////////////////////////////////////////////////////////////
                          GET /ready
//////////////////////////////////////////////////////////////*/

const READY_KEYS = ['checkedAt', 'interfaceVersion', 'lastEvaluationAt', 'ready', 'reasons'];

test('readyBody: exactly five keys; ready only on an explicit true with no reason against it', () => {
  const at = T0 + 5_000;
  const ready = readyBody(() => ({ ready: true, reasons: [], lastEvaluationAt: T0 }), at);
  assert.deepEqual(ready, { ready: true, reasons: [], checkedAt: new Date(at).toISOString(), lastEvaluationAt: new Date(T0).toISOString(), interfaceVersion: INTERFACE_VERSION });
  assert.deepEqual(Object.keys(ready).sort(), READY_KEYS);

  // A rule that says ready but names a reason is not ready.
  assert.deepEqual(readyBody(() => ({ ready: true, reasons: ['fair-stale'], lastEvaluationAt: null }), at), {
    ready: false,
    reasons: ['fair-stale'],
    checkedAt: new Date(at).toISOString(),
    lastEvaluationAt: null,
    interfaceVersion: INTERFACE_VERSION,
  });
  // Repeated reasons are named once.
  assert.deepEqual(readyBody(() => ({ ready: false, reasons: ['role-unread', 'role-unread'], lastEvaluationAt: null }), at).reasons, ['role-unread']);
});

test('readyBody FAILS CLOSED: a throw, a non-boolean ready, a missing reasons list, an unknown code or a bare false are all state-unknown, never ready', () => {
  const at = T0 + 5_000;
  const unknown = { ready: false, reasons: ['state-unknown'], checkedAt: new Date(at).toISOString(), lastEvaluationAt: null, interfaceVersion: INTERFACE_VERSION };
  assert.deepEqual(
    readyBody(() => {
      throw new Error('the rule threw');
    }, at),
    unknown,
  );
  assert.deepEqual(readyBody(() => ({ ready: 'yes', reasons: [], lastEvaluationAt: null }) as unknown as Readiness, at), unknown, 'truthy is not true');
  assert.deepEqual(readyBody(() => ({ ready: true, lastEvaluationAt: null }) as unknown as Readiness, at), unknown, 'no reasons list is not "no reasons"');
  assert.deepEqual(readyBody(() => undefined as unknown as Readiness, at), unknown);
  assert.deepEqual(readyBody(() => ({ ready: false, reasons: [], lastEvaluationAt: null }), at), unknown, 'not ready never arrives without a reason');
  // An unknown code poisons a ready:true, and the known codes beside it survive.
  const mixed = readyBody(() => ({ ready: true, reasons: ['made-up' as ReadyReason], lastEvaluationAt: null }), at);
  assert.deepEqual([mixed.ready, mixed.reasons], [false, ['state-unknown']]);
  assert.deepEqual(readyBody(() => ({ ready: false, reasons: ['role-unread', 'made-up' as ReadyReason], lastEvaluationAt: null }), at).reasons, ['role-unread', 'state-unknown']);
  // A lastEvaluationAt that is not a finite number is null, not a thrown RangeError.
  assert.equal(readyBody(() => ({ ready: true, reasons: [], lastEvaluationAt: Number.NaN }), at).lastEvaluationAt, null);
  // The closed set is what the tests above assume.
  assert.deepEqual([...READY_REASONS].sort(), ['fair-stale', 'loop-wedged', 'no-completed-tick', 'role-delayed', 'role-refused', 'role-unread', 'state-unknown', 'tick-failed']);
});

test('GET /ready on the mode app: 200 ready / 503 not, no private field, /health and /state untouched, / lists it', async () => {
  const now = T0 + 1_000;
  let verdict: Readiness = { ready: false, reasons: ['no-completed-tick'], lastEvaluationAt: null };
  const options = {
    mode: 'pricer' as const,
    limits: LIMITS,
    chainId: 4663,
    rpcUrls: ['https://rpc.example/v2/SECRET-KEY'],
    signer: '0x000000000000000000000000000000000000bEEF' as const,
    contracts: { autoRoller: '0x00000000000000000000000000000000000000A1' as const, accessManager: '0x00000000000000000000000000000000000000A2' as const },
    now: () => now,
  };
  const store = new V2Store(':memory:');
  const withReady = createModeHealthApp({ ...options, health: new ModeHealth(T0), store, routes: readyRoute(() => verdict, () => now) });
  const without = createModeHealthApp({ ...options, health: new ModeHealth(T0), store });

  const notReady = await withReady.request('/ready');
  assert.equal(notReady.status, 503);
  const body = (await notReady.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), READY_KEYS);
  assert.deepEqual(body.reasons, ['no-completed-tick']);
  const raw = JSON.stringify(body).toLowerCase();
  for (const secret of ['secret', 'rpc.example', 'beef', '00a1', '00a2', 'memory']) assert.equal(raw.includes(secret), false, `/ready must not carry ${secret}`);

  verdict = { ready: true, reasons: [], lastEvaluationAt: T0 };
  const ok = await withReady.request('/ready');
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { ready: boolean }).ready, true);

  // Mounting /ready changes nothing about /health or /state: same status, same body, key for key.
  for (const path of ['/health', '/state']) {
    const [a, b] = [await withReady.request(path), await without.request(path)];
    assert.equal(a.status, b.status, path);
    assert.deepEqual(await a.json(), await b.json(), path);
  }
  assert.deepEqual(await (await withReady.request('/')).json(), { service: 'callhouse-pricer', mode: 'pricer', endpoints: ['/health', '/state', '/ready'] });
  store.close();
});
