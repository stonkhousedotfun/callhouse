/**
 * The HTTP surface of a factory-only process: no VAULT in the environment at all.
 *
 * WHY THIS FILE EXISTS: every new market's keeper runs without a vault, and health.ts used to
 * read config.VAULT in four places as if it were always there. This pins what such a process
 * answers before its first tick: `/` and `/health` name the factory and the market with
 * `vault: null`, `/orders` is an empty book with a note (the factory's book is on chain), and
 * `/state` is a 503 that still says which market it is. The vault-mode surface is pinned by
 * health.test.ts; both files run in separate processes because config.ts reads the environment
 * once at import.
 *
 * DELIBERATELY ABSENT: no chain and no listen(): the app is driven through Hono's `request`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-health-solo-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
delete process.env.VAULT;
process.env.FACTORY = '0x3333333333333333333333333333333333333333';
process.env.PRICE_FEED = '0x4A1166a659A55625345e9515b32adECea5547C38';
process.env.KEEPER_MARKET = 'TSLA';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
delete process.env.ALERT_WEBHOOK;

const { buildApp } = await import('./health.js');
const { store } = await import('./state.js');

const app = buildApp();

test.after(() => {
  store.close();
});

test('/ names the market and the factory, and vault is null', async () => {
  const res = await app.request('/');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.service, 'callhouse-keeper');
  assert.equal(body.market, 'TSLA');
  assert.equal(body.vault, null);
  assert.equal(body.factory, '0x3333333333333333333333333333333333333333');
  assert.deepEqual(body.endpoints, ['/health', '/state', '/orders', '/cycles']);
});

test('/health before the first tick: starting, vault null, a factory block with nulls, the market', async () => {
  const res = await app.request('/health');
  assert.equal(res.status, 200, 'the boot grace window is not a 503');
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.status, 'starting');
  assert.equal(body.market, 'TSLA');
  assert.equal(body.vault, null);
  assert.equal(body.factory.address, '0x3333333333333333333333333333333333333333');
  assert.equal(body.factory.market, 'TSLA');
  assert.equal(body.factory.priceFeed, '0x4A1166a659A55625345e9515b32adECea5547C38');
  assert.equal(body.factory.pricingMode, 'vol');
  assert.equal(body.factory.weekId, null);
  assert.equal(body.factory.pendingCount, null);
  assert.equal(body.factory.hasKeeperRole, null);
  assert.equal(body.keeper.hasKeeperRole, null);
  assert.equal(body.keeper.balanceWei, null);
  assert.equal(body.chain.headBlock, null);
  assert.deepEqual(Object.keys(body.checks).sort(), ['gas', 'heartbeat', 'rpcLag']);
  assert.equal(body.checks.heartbeat, true, 'a first boot is allowed the grace period');
});

test('/health reads tickSolo\'s heartbeat: a beat from the solo loop is the liveness signal', async () => {
  store.beat();
  const body = (await (await app.request('/health')).json()) as Record<string, any>;
  assert.equal(body.checks.heartbeat, true);
  assert.equal(typeof body.lastHeartbeat, 'string');
  assert.equal(body.lastHeartbeatAgeSeconds, 0);
});

test('/orders without a vault is an empty book with a note; nothing reads the listings table', async () => {
  const res = await app.request('/orders');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { orders: unknown[]; note: string };
  assert.deepEqual(body.orders, []);
  assert.match(body.note, /factory-only keeper \(TSLA\)/);
  assert.match(body.note, /0x3333333333333333333333333333333333333333/);
});

test('/state without a vault and without a snapshot is a 503 that names the market', async () => {
  const res = await app.request('/state');
  assert.equal(res.status, 503);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.market, 'TSLA');
  assert.equal(body.factory, '0x3333333333333333333333333333333333333333');
  assert.match(String(body.error), /no snapshot yet/);
});

test('/cycles still answers (empty) so a dashboard built for the vault keeper does not break', async () => {
  const res = await app.request('/cycles');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cycles: [] });
});
