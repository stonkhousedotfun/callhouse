/**
 * A signing mode booted end to end on the scaffold: config from a fixture registry, the runtime,
 * the health server on a real socket, the loop, and shutdown.
 *
 * WHY THIS FILE EXISTS: K2-03/K2-04/K2-05 each hand a `tick` to runSigningMode and inherit
 * everything else. Pinned here, before any of them exists: the wiring check refuses to boot a mixed
 * deployment, the chain probe feeds /health and the gas and lag alerts, a failing tick is alerted
 * and the loop carries on, a tick can send through the runtime's TxSender, and close() waits for
 * the in-flight tick.
 *
 * DELIBERATELY ABSENT: any RPC. The probe, the wiring check and the TxChain are seams; the health
 * server binds port 0 on the default interface and is read over 127.0.0.1.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import type { Hash } from 'viem';
import { loadV2Config, type CrankerConfig } from './config.js';
import type { ChainProbe } from './health.js';
import { silentLogger } from './logger.js';
import { createModeRuntime, runSigningMode, type RuntimeSeams } from './runtime.js';
import type { TxChain } from './tx.js';

const REGISTRY = fileURLToPath(new URL('./fixtures/registry-v2.json', import.meta.url));

function crankerConfig(): CrankerConfig {
  return loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: 'http://127.0.0.1:9',
    CRANKER_PK: `0x${'3c'.repeat(32)}`,
    CRANKER_PORT: '0',
    KEEPER_DB_PATH: ':memory:',
    POLL_INTERVAL_MS: '1000',
    V2_REGISTRY_PATH: REGISTRY,
    // Boot failures below are asserted at once; the retry has its own test.
    KEEPER_BOOT_RETRY_MS: '0',
  }) as CrankerConfig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const probeOf = (overrides: Partial<ChainProbe> = {}) => async (): Promise<ChainProbe> => ({
  headBlock: 65_000_000n,
  headTimestamp: Math.floor(Date.now() / 1000),
  rpcLagSeconds: 1,
  balanceWei: 10n ** 18n,
  ...overrides,
});

const fakeTxChain = (account: `0x${string}`): TxChain => ({
  account,
  simulate: async () => ({ result: true, request: {} }),
  broadcast: async () => `0x${'aa'.repeat(32)}` as Hash,
  pendingNonce: async () => 0,
  minedNonce: async () => 0,
  waitForReceipt: async () => ({ status: 'success', blockNumber: 1n, gasUsed: 1n }),
  getReceipt: async () => null,
});

function seams(extra: Partial<RuntimeSeams> = {}): RuntimeSeams {
  return { log: silentLogger(), checkWiring: async () => [], probe: probeOf(), ...extra };
}

test('createModeRuntime: typed handles for the required contracts, a signer from the mode\'s key, nothing dialled', () => {
  const config = crankerConfig();
  const runtime = createModeRuntime(config, seams());
  assert.equal(runtime.contracts.clearinghouse.address, config.contracts.clearinghouse);
  assert.equal(runtime.contracts.expiryCalendar.address, config.contracts.expiryCalendar);
  assert.equal(runtime.contracts.makerRegistry?.address, config.contracts.makerRegistry);
  assert.equal(runtime.sender.account, runtime.signer.account.address);
  assert.equal(runtime.store.path, ':memory:');
  runtime.store.close();
});

test('runSigningMode: boot alert, ticks with a heartbeat, /health and /state on the port, a tick sends through the sender, close() waits', async () => {
  const config = crankerConfig();
  const runtime = createModeRuntime(config, seams({ txChain: fakeTxChain('0x000000000000000000000000000000000000bEEF') }));
  let ticks = 0;
  let inSecondTick = false;
  const bound: { loop: { wake(): void } | null } = { loop: null };
  const running = await runSigningMode(runtime, {
    tick: async () => {
      ticks += 1;
      if (ticks === 1) {
        const outcome = await runtime.sender.execute(
          { address: config.contracts.clearinghouse, abi: runtime.contracts.clearinghouse.abi, functionName: 'settle', args: [2n] },
          { kind: 'settle', key: '2' },
        );
        assert.equal(outcome.status, 'confirmed');
      }
      if (ticks === 2) {
        inSecondTick = true;
        await sleep(50);
        inSecondTick = false;
      }
    },
    state: () => (ticks === 0 ? null : { ticks }),
    onLoop: (loop) => {
      bound.loop = loop;
    },
  });
  assert.ok(bound.loop !== null && typeof running.wake === 'function', 'the mode got the loop (its precise wake-ups) and the running mode exposes wake');
  assert.equal(running.mode, 'cranker');
  assert.ok(running.port !== null && running.port > 0);

  await until(() => ticks >= 1 && runtime.health.ticks >= 1, 'the first tick');
  const health = await fetch(`http://127.0.0.1:${running.port}/health`);
  assert.equal(health.status, 200);
  const body = (await health.json()) as Record<string, any>;
  assert.equal(body.status, 'ok');
  assert.equal(body.mode, 'cranker');
  assert.equal(body.chain.headBlock, '65000000');
  assert.equal(body.contracts.clearinghouse, config.contracts.clearinghouse);
  assert.equal(body.db.rows.v2_txs, 1, 'the tick\'s transaction is in the journal');
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${running.port}/state`)).json(), { ticks: 1 });
  const alerts = runtime.store.db.prepare('SELECT kind FROM v2_alerts').all() as Array<{ kind: string }>;
  assert.deepEqual(alerts.map((a) => a.kind), ['v2_boot']);

  // The second tick starts POLL_INTERVAL_MS (1 s) after the first; close() mid-tick waits for it.
  await until(() => inSecondTick, 'the second tick', 3_000);
  await running.close();
  assert.equal(inSecondTick, false, 'close resolved after the in-flight tick finished');
  await assert.rejects(fetch(`http://127.0.0.1:${running.port}/health`), 'the server is closed');
});

test('runSigningMode: a failing probe or tick is alerted and recorded, the loop goes on; low gas alerts once', async () => {
  let probes = 0;
  const config = crankerConfig();
  const runtime = createModeRuntime(
    config,
    seams({
      probe: async () => {
        probes += 1;
        if (probes === 1) throw new Error('fetch failed');
        return probeOf({ balanceWei: 1n })();
      },
    }),
  );
  let ticks = 0;
  const running = await runSigningMode(runtime, {
    tick: async () => {
      ticks += 1;
      throw new Error('settle step exploded');
    },
  });
  // The first tick fails at the probe (no mode tick), the second at the mode's tick.
  await until(() => ticks >= 1 && runtime.health.lastTickError?.message === 'settle step exploded', 'the mode tick after a failed probe', 4_000);
  const kinds = (runtime.store.db.prepare('SELECT kind FROM v2_alerts ORDER BY id').all() as Array<{ kind: string }>).map((a) => a.kind);
  // The second v2_error is inside the first one's cooldown: one page per hour for a recurring failure.
  assert.deepEqual(kinds, ['v2_boot', 'v2_rpc_lag', 'v2_error', 'v2_low_gas']);
  assert.equal(runtime.health.lastChain?.balanceWei, 1n);
  await running.close();
});

test('runSigningMode: wiring that does not belong together refuses to boot: no tick, the store closed', async () => {
  const config = crankerConfig();
  const runtime = createModeRuntime(config, seams({ checkWiring: async () => ['orderBook 0x… belongs to clearinghouse 0xdead, not the configured 0x…'] }));
  let ticked = false;
  await assert.rejects(
    runSigningMode(runtime, {
      tick: async () => {
        ticked = true;
      },
    }),
    /the configured v2 contracts do not belong together:\n {2}orderBook 0x… belongs to clearinghouse 0xdead/,
  );
  assert.equal(ticked, false);
  assert.equal(runtime.store.db.open, false, 'the store was closed');
});

test('runSigningMode: an unreachable RPC at boot fails as itself, not as a wiring mismatch', async () => {
  const runtime = createModeRuntime(crankerConfig(), { log: silentLogger(), probe: probeOf() });
  await assert.rejects(runSigningMode(runtime, { tick: async () => {} }), (error: unknown) => {
    assert.doesNotMatch(String(error), /do not belong together/);
    assert.match(String(error), /HTTP request failed/);
    return true;
  });
  assert.equal(runtime.store.db.open, false);
});

test('runSigningMode: a page the relay refused (the boot page) is redelivered from the store by a later tick', async () => {
  const base = loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: 'http://127.0.0.1:9',
    CRANKER_PK: `0x${'3c'.repeat(32)}`,
    CRANKER_PORT: '0',
    KEEPER_DB_PATH: ':memory:',
    POLL_INTERVAL_MS: '1000',
    V2_REGISTRY_PATH: REGISTRY,
    ALERT_WEBHOOK: 'http://relay.test/alert',
    ALERT_WEBHOOK_TOKEN: 't'.repeat(40),
  }) as CrankerConfig;
  let clock = Date.now();
  let relayUp = false;
  const posts: string[] = [];
  const runtime = createModeRuntime(
    base,
    seams({
      now: () => clock,
      fetch: (async (_url: string, init: RequestInit) => {
        posts.push(String((JSON.parse(String(init.body)) as { kind: string }).kind));
        return new Response('{}', { status: relayUp ? 200 : 502 });
      }) as typeof fetch,
    }),
  );
  let ticks = 0;
  const running = await runSigningMode(runtime, {
    tick: async () => {
      ticks += 1;
    },
  });
  try {
    await until(() => ticks >= 1, 'the first tick');
    assert.deepEqual(posts, ['v2_boot']);
    relayUp = true;
    clock += 6 * 60_000;
    await until(() => posts.length >= 2, 'the redelivery', 4_000);
    assert.deepEqual(posts, ['v2_boot', 'v2_boot']);
    const row = runtime.store.db.prepare("SELECT delivered FROM v2_alerts WHERE kind = 'v2_boot'").get() as { delivered: number };
    assert.equal(row.delivered, 1);
  } finally {
    await running.close();
  }
});

test('runSigningMode: the chain unreachable at boot is retried with the health server (and a mode\'s kill route) up, not a crash loop; a definitive mismatch still refuses at once', async () => {
  const lines: string[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  const config = { ...crankerConfig(), bootRetryMs: 60_000 };
  let checks = 0;
  const runtime = createModeRuntime(config, {
    log,
    probe: probeOf(),
    bootRetryDelayMs: 20,
    checkWiring: async () => {
      checks += 1;
      if (checks <= 2) throw new Error('HTTP request failed.');
      return [];
    },
  });
  let ticked = false;
  const booting = runSigningMode(runtime, {
    tick: async () => {
      ticked = true;
    },
    routes: { mount: (app) => app.post('/kill', (c) => c.json({ killed: true })), endpoints: ['POST /kill'] },
  });
  await until(() => lines.some((l) => /health server listening/.test(l)), 'the health server before the wiring check');
  const port = (JSON.parse(lines.find((l) => /health server listening/.test(l))!) as { port: number }).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/kill`, { method: 'POST' })).status, 200, 'the kill route answers while boot retries');
  const running = await booting;
  try {
    assert.equal(checks, 3);
    assert.ok(lines.some((l) => /chain not reachable at boot; retrying/.test(l)));
    await until(() => ticked, 'the first tick');
  } finally {
    await running.close();
  }

  const mismatch = createModeRuntime({ ...crankerConfig(), bootRetryMs: 60_000 }, seams({ checkWiring: async () => ['orderBook 0x… belongs to clearinghouse 0xdead, not the configured 0x…'] }));
  await assert.rejects(runSigningMode(mismatch, { tick: async () => {} }), /do not belong together/);
});
