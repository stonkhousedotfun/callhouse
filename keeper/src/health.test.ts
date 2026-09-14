/**
 * The keeper's HTTP server listens on every interface, IPv6 included.
 *
 * WHY THIS FILE EXISTS: the web app's keeper fallback reads GET /orders over Railway's private
 * network, which is IPv6 (keeper.railway.internal). The server used to pin `hostname: '0.0.0.0'`,
 * IPv4 only, so on Railway the fallback would have answered "The keeper could not be reached." in
 * exactly the week it exists for, while every local run (all on 127.0.0.1) stayed green. This
 * starts the real startHealthServer() and asks it on both loopbacks.
 *
 * DELIBERATELY ABSENT: a chain. `/` answers from config alone; the RPC in the environment is a
 * discard port. On a host with no IPv6 loopback at all the ::1 half is skipped, and says so.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-health-'));
const port = await freePort();
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
process.env.KEEPER_PORT = String(port);
delete process.env.ALERT_WEBHOOK;

const { startHealthServer } = await import('./health.js');
const { store } = await import('./state.js');

test('startHealthServer answers on 127.0.0.1 and on ::1', async (t) => {
  const server = startHealthServer();
  try {
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));

    const v4 = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(v4.status, 200);
    assert.equal(((await v4.json()) as { service: string }).service, 'callhouse-keeper');

    if (!(await hasIpv6Loopback())) {
      t.skip('this host has no IPv6 loopback');
      return;
    }
    const v6 = await fetch(`http://[::1]:${port}/orders`);
    assert.equal(v6.status, 200, 'GET /orders over IPv6: what keeper.railway.internal needs');
    assert.deepEqual(await v6.json(), { orders: [] });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
