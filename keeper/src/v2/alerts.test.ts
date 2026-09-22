/**
 * v2 alerts as the relay receives them.
 *
 * WHY THIS FILE EXISTS: relay/src/payload.ts refuses a body whose kind is not snake_case, whose
 * severity is not info|warn|error, or whose `vault` is not a string, and a refused alert never
 * arrives. Pinned: the payload shape (no `vault`, `source` names the mode, Bearer token), the
 * cooldown and its force/clear escapes, the five-minute retry after a failed delivery, and that a
 * process with no webhook still logs and stores every alert. Every registered kind must satisfy
 * the relay's identifier and severity rules, including kinds added after the bot-specific tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALERT_SEVERITY, Alerter, FAILED_DELIVERY_RETRY_MS } from './alerts.js';
import { silentLogger } from './logger.js';
import { V2Store } from './store.js';

const HOUR = 3_600_000;

test('the cranker\'s alert kinds (K2-03) are registered with a severity and are relay identifiers', () => {
  const cranker = {
    v2_sources_disagree: 'warn',
    v2_settlement_held: 'error',
    v2_snapshot_missed: 'warn',
    v2_settle_stuck: 'error',
    v2_redeem_backlog: 'warn',
    v2_low_gas: 'warn',
    // INTERFACE_VERSION 6: a refused settlement pin blocks every series of the expiry until the admin acts.
    v2_pin_refused: 'error',
    // INTERFACE_VERSION 7 (c16): an overtaken AutoRoller ask the cranker cannot withdraw.
    v2_stale_cancel_failed: 'error',
  };
  for (const [kind, severity] of Object.entries(cranker)) {
    assert.equal(ALERT_SEVERITY[kind], severity, kind);
    assert.match(kind, /^[a-z][a-z0-9_]{0,63}$/);
  }
});

test('the MM bot\'s alert kinds (K2-04) are registered with a severity and are relay identifiers', () => {
  const mm = {
    v2_mm_killed: 'error',
    v2_mm_resumed: 'info',
    v2_mm_loss_stop: 'error',
    v2_mm_delta: 'warn',
    v2_mm_not_quoter: 'error',
    v2_mm_pricing: 'warn',
    v2_mm_tx_rejected: 'warn',
    v2_mm_funds: 'warn',
    // INTERFACE_VERSION 7 (c21): the vault's daily outflow cap binding, and USDG this bot did not spend.
    v2_mm_outflow: 'warn',
    v2_mm_outflow_foreign: 'error',
    v2_mm_wrong_book: 'error',
    v2_mm_epoch_unflat: 'warn',
    v2_mm_protocol_cross: 'warn',
    v2_mm_house_unavailable: 'error',
  };
  for (const [kind, severity] of Object.entries(mm)) {
    assert.equal(ALERT_SEVERITY[kind], severity, kind);
    assert.match(kind, /^[a-z][a-z0-9_]{0,63}$/);
  }
});

test('the pricer\'s alert kinds (K2-05) are registered with a severity and are relay identifiers', () => {
  const pricer = {
    v2_pricer_no_role: 'error',
    v2_pricer_fair_unavailable: 'warn',
    v2_pricer_reprice_failed: 'error',
    v2_pricer_clamped: 'warn',
  };
  for (const [kind, severity] of Object.entries(pricer)) {
    assert.equal(ALERT_SEVERITY[kind], severity, kind);
    assert.match(kind, /^[a-z][a-z0-9_]{0,63}$/);
  }
});

test('every registered v2 alert is accepted by the relay', () => {
  for (const [kind, severity] of Object.entries(ALERT_SEVERITY)) {
    assert.match(kind, /^[a-z][a-z0-9_]{0,63}$/, `${kind}: relay identifier`);
    assert.ok(['info', 'warn', 'error'].includes(severity), `${kind}: relay severity`);
  }
});

function setup(options: { webhook?: string | null; respond?: (n: number) => Response | Error } = {}) {
  let now = 1_790_000_000_000;
  const posts: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const store = new V2Store(':memory:');
  const alerter = new Alerter({
    mode: 'cranker',
    chainId: 4663,
    webhook: options.webhook === undefined ? 'http://relay.railway.internal:8080/alert' : options.webhook,
    token: 'relay-token-0123456789',
    cooldownMs: HOUR,
    log: silentLogger(),
    store,
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Record<string, unknown> });
      const r = options.respond?.(posts.length) ?? new Response('{}', { status: 200 });
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch,
  });
  return { alerter, posts, store, advance: (ms: number) => (now += ms) };
}

test('the payload is one the relay accepts: source names the mode, no vault, bigints as strings, Bearer token', async () => {
  const { alerter, posts, store } = setup();
  assert.equal(await alerter.alert('v2_low_gas', 'cranker signer is low on gas', { balanceWei: 5n }), true);
  assert.equal(posts.length, 1);
  const { url, headers, body } = posts[0]!;
  assert.equal(url, 'http://relay.railway.internal:8080/alert');
  assert.equal(headers.authorization, 'Bearer relay-token-0123456789');
  assert.deepEqual(body, {
    source: 'callhouse-cranker',
    kind: 'v2_low_gas',
    severity: 'warn',
    message: 'cranker signer is low on gas',
    chainId: 4663,
    at: '2026-09-21T14:13:20.000Z',
    data: { balanceWei: '5' },
  });
  // relay/src/payload.ts's rules (the workspace has no cross-package imports, so restated): a
  // snake_case kind, a known severity, a non-empty message, and no `vault` unless it is a string.
  assert.match(String(body.kind), /^[a-z][a-z0-9_]{0,63}$/);
  assert.ok(['info', 'warn', 'error'].includes(String(body.severity)));
  assert.equal('vault' in body, false);
  const row = store.db.prepare('SELECT kind, severity, delivered FROM v2_alerts').get();
  assert.deepEqual({ ...(row as object) }, { kind: 'v2_low_gas', severity: 'warn', delivered: 1 });
});

test('severity: the table for the scaffold\'s kinds, warn for a kind a mode has not registered, an explicit one wins', async () => {
  const { alerter, posts } = setup();
  await alerter.alert('v2_error', 'tick failed');
  await alerter.alert('v2_boot', 'online');
  await alerter.alert('v2_something_new', 'x');
  await alerter.alert('v2_settlement_held', 'held', {}, { severity: 'error' });
  assert.deepEqual(posts.map((p) => p.body.severity), ['error', 'info', 'warn', 'error']);
});

test('cooldown per (kind, dedupeKey); force ignores it; clear() lets the next occurrence through', async () => {
  const { alerter, posts, advance } = setup();
  await alerter.alert('v2_rpc_lag', 'lag');
  assert.equal(await alerter.alert('v2_rpc_lag', 'lag again'), false, 'suppressed');
  await alerter.alert('v2_tx_revert', 'settle 1', {}, { dedupeKey: '1' });
  await alerter.alert('v2_tx_revert', 'settle 2', {}, { dedupeKey: '2' });
  await alerter.alert('v2_rpc_lag', 'forced', {}, { force: true });
  alerter.clear('v2_rpc_lag');
  await alerter.alert('v2_rpc_lag', 'after clear');
  advance(HOUR);
  await alerter.alert('v2_tx_revert', 'settle 1 an hour later', {}, { dedupeKey: '1' });
  assert.deepEqual(posts.map((p) => p.body.message), ['lag', 'settle 1', 'settle 2', 'forced', 'after clear', 'settle 1 an hour later']);
});

test('a failed delivery (rejected or unreachable) is retried after five minutes, not every tick and not after an hour', async () => {
  const { alerter, posts, advance, store } = setup({ respond: (n) => (n === 1 ? new Response('no', { status: 500 }) : n === 2 ? new Error('ECONNREFUSED') : new Response('{}')) });
  assert.equal(await alerter.alert('v2_error', 'first'), false);
  assert.equal(await alerter.alert('v2_error', 'too soon'), false);
  advance(FAILED_DELIVERY_RETRY_MS);
  assert.equal(await alerter.alert('v2_error', 'retry, unreachable'), false);
  advance(FAILED_DELIVERY_RETRY_MS);
  assert.equal(await alerter.alert('v2_error', 'retry, delivered'), true);
  assert.deepEqual(posts.map((p) => p.body.message), ['first', 'retry, unreachable', 'retry, delivered']);
  const delivered = store.db.prepare('SELECT message, delivered FROM v2_alerts ORDER BY id').all() as Array<{ message: string; delivered: number }>;
  // The delivered retry supersedes the two failed rows of the same key: nothing is left for redeliver().
  assert.deepEqual(delivered.map((r) => [r.message, r.delivered]), [['first', 1], ['retry, unreachable', 1], ['retry, delivered', 1]]);
});

test('no webhook: logged and stored, reported as handled; a kind the relay would refuse is not sent at all', async () => {
  const { alerter, posts, store } = setup({ webhook: null });
  assert.equal(await alerter.alert('v2_boot', 'online'), true);
  assert.equal(posts.length, 0);
  assert.equal(store.counts().v2_alerts, 1);
  assert.equal(await alerter.alert('v2_Bad-Kind', 'x'), false);
  assert.equal(store.counts().v2_alerts, 1);
});

test('redeliver: a one-off page the relay did not take is sent again from the store after five minutes, once; a later delivery of the same key supersedes it', async () => {
  let relayUp = false;
  const { alerter, posts, advance, store } = setup({ respond: () => (relayUp ? new Response('{}') : new Response('bad gateway', { status: 502 })) });
  // An event nobody raises again: one transaction's revert.
  assert.equal(await alerter.alert('v2_tx_revert', 'redeemBatch reverted on chain', { hash: '0xab' }, { dedupeKey: 'redeemBatch:7', force: true }), false);
  assert.equal(posts.length, 1);

  assert.equal(await alerter.redeliver(), 0, 'not before the retry spacing');
  assert.equal(posts.length, 1);
  advance(FAILED_DELIVERY_RETRY_MS);
  assert.equal(await alerter.redeliver(), 0, 'the relay is still down: nothing delivered');
  assert.equal(posts.length, 2);
  relayUp = true;
  advance(FAILED_DELIVERY_RETRY_MS);
  assert.equal(await alerter.redeliver(), 1);
  assert.equal(posts.length, 3);
  assert.equal(posts[2]!.body.kind, 'v2_tx_revert');
  assert.equal(posts[2]!.body.message, 'redeemBatch reverted on chain');
  assert.deepEqual(posts[2]!.body.data, { hash: '0xab', redeliveredFrom: '2026-09-21T14:13:20.000Z' });
  advance(FAILED_DELIVERY_RETRY_MS);
  assert.equal(await alerter.redeliver(), 0, 'delivered once: not again');
  assert.equal(posts.length, 3);

  // A condition that fails, then is raised again and delivered: nothing is left to redeliver.
  relayUp = false;
  await alerter.alert('v2_low_gas', 'low', {}, { force: true });
  relayUp = true;
  advance(FAILED_DELIVERY_RETRY_MS);
  assert.equal(await alerter.alert('v2_low_gas', 'still low', {}, { force: true }), true);
  advance(FAILED_DELIVERY_RETRY_MS);
  assert.equal(await alerter.redeliver(), 0);
  assert.deepEqual(posts.slice(3).map((p) => p.body.message), ['low', 'still low']);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM v2_alerts WHERE delivered = 0').get() as { n: number }).n, 0);
});
