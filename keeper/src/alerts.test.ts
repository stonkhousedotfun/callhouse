/**
 * The alert cooldown clock, against an in-process webhook stub.
 *
 * WHY THIS FILE EXISTS: an alert whose one delivery attempt fails and is then suppressed for an
 * hour is an alert nobody reads when the webhook is flapping. The rule pinned here: a
 * SUCCESSFUL delivery (or no webhook at all) suppresses repeats for the full
 * KEEPER_ALERT_COOLDOWN_MS; a FAILED delivery leaves only FAILED_DELIVERY_RETRY_MS of it, so
 * the retry comes in five minutes — not every tick, not after an hour.
 *
 * The suite runs with KEEPER_ALERT_COOLDOWN_MS=1200 so the full-cooldown half is testable with
 * a real 1.3s wait; the failed-delivery half is pinned arithmetically through
 * failedDeliveryStamp, because its five minutes is deliberately cooldown-independent.
 *
 * DELIBERATELY ABSENT: no real webhook. ALERT_WEBHOOK points at the stub.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let posts = 0;
let lastAuthorization: string | undefined;
let handler: () => { status: number } = () => ({ status: 200 });

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  posts += 1;
  lastAuthorization = req.headers.authorization;
  const reply = handler();
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('stub did not bind a port');

/* ---- environment: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-alerts-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
process.env.KEEPER_ALERT_COOLDOWN_MS = '1200'; // short enough to wait out for real
process.env.ALERT_WEBHOOK = `http://127.0.0.1:${address.port}/hook`;
process.env.ALERT_WEBHOOK_TOKEN = 'relay-token-0123456789abcdef';

const { FAILED_DELIVERY_RETRY_MS, alert, failedDeliveryStamp } = await import('./alerts.js');
const { store } = await import('./state.js');

test.after(() => {
  server.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('a failed delivery returns false, is stored undelivered, and is NOT retried every tick', async () => {
  handler = () => ({ status: 500 });
  assert.equal(await alert('keeper_error', 'down once', {}, { dedupeKey: 'flap' }), false);
  assert.equal(posts, 1);
  assert.equal(store.recentAlerts(1)[0]?.delivered, 0);

  // Immediately again: suppressed. The failure leaves five minutes of suppression — neither
  // zero (a page per tick) nor the full cooldown (an hour of silence for one failed POST).
  assert.equal(await alert('keeper_error', 'down twice', {}, { dedupeKey: 'flap' }), false);
  assert.equal(posts, 1);
});

test('failedDeliveryStamp leaves exactly FAILED_DELIVERY_RETRY_MS of cooldown, whatever the cooldown is', async () => {
  assert.equal(FAILED_DELIVERY_RETRY_MS, 300_000);
  const now = Date.now();
  assert.equal(failedDeliveryStamp(now), now - 1_200 + 300_000, 'this suite runs with a 1.2s cooldown');
  // Suppression ends at stamp + cooldown == now + 300_000: five minutes, by construction
  // independent of KEEPER_ALERT_COOLDOWN_MS.
  assert.equal(failedDeliveryStamp(now) + 1_200, now + FAILED_DELIVERY_RETRY_MS);
});

test('a successful delivery returns true and consumes the FULL cooldown', async () => {
  handler = () => ({ status: 200 });
  assert.equal(await alert('rpc_lag', 'lagging', {}, { dedupeKey: 'ok' }), true);
  assert.equal(store.recentAlerts(1)[0]?.delivered, 1);

  assert.equal(await alert('rpc_lag', 'lagging again', {}, { dedupeKey: 'ok' }), false, 'suppressed inside the cooldown');
  const before = posts;
  await sleep(1_300); // the suite cooldown is 1.2s
  assert.equal(await alert('rpc_lag', 'still lagging', {}, { dedupeKey: 'ok' }), true, 'allowed once it elapses');
  assert.equal(posts, before + 1);
});

test('the webhook POST carries ALERT_WEBHOOK_TOKEN as a bearer header', async () => {
  handler = () => ({ status: 200 });
  assert.equal(await alert('keeper_error', 'token check', {}, { dedupeKey: 'token-header' }), true);
  assert.equal(lastAuthorization, 'Bearer relay-token-0123456789abcdef');
});
