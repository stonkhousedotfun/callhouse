/**
 * The cranker's side-effect ports (effects.ts) and a tick with the chain gone (cranker.ts).
 *
 * WHY THIS FILE EXISTS: three properties the devnet cycle cannot show because its chain always
 * answers. The dry run must never sign: its sender only judges. An event alert (a missed snapshot,
 * a new disagreeing candidate) pages once ever, across restarts, while a condition alert (held,
 * stuck) goes to the alerter's cooldown every time. And each step is independent: with every RPC
 * failing, every step fails on its own, is recorded on /state and paged per step, the rolls step
 * without a roller still reports itself skipped, and the tick returns. The one exception comes
 * first: until the deployment anchor has been read once, no step runs on the store at all, and a
 * store left by another deployment at the same addresses is reset before the first step reads it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PublicClient } from 'viem';
import { Alerter } from '../alerts.js';
import { loadV2Config, type CrankerConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import { Cranker } from './cranker.js';
import { CrankAlerts, drySender, type RaisedAlert } from './effects.js';
import { CrankerIndex, SCAN_CURSOR_META_KEY } from './index-store.js';

const CALL = { address: '0x00000000000000000000000000000000000000c1', abi: [], functionName: 'settle', args: [1n], gas: 1_500_000n } as never;

test('drySender: advanced → skip; a reverting simulation → simulation-reverted; worthSending false → no-op; else would-send; never a send', async () => {
  const account = '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f' as const;
  const seen: { args: { account?: string; gas?: bigint } | null } = { args: null };
  const ok = drySender({ simulateContract: (async (args: { account?: string; gas?: bigint }) => ((seen.args = args), { result: true, request: {} })) as never }, account);
  assert.equal(ok.dryRun, true);
  assert.deepEqual(await ok.execute(CALL, { kind: 'settle', key: '1', isAdvanced: async () => true }), { status: 'already-advanced' });
  assert.equal(seen.args, null, 'an advanced state is not even simulated');
  assert.deepEqual(await ok.execute(CALL, { kind: 'settle', key: '1', worthSending: (r) => r === false }), { status: 'no-op', result: true });
  assert.deepEqual(await ok.execute(CALL, { kind: 'settle', key: '1' }), { status: 'would-send', result: true });
  // (read through a function: assert.equal(seen.args, null) above narrowed the property for the compiler)
  const last = (): { account?: string; gas?: bigint } | null => seen.args;
  assert.equal(last()?.account, account);
  assert.equal(last()?.gas, 1_500_000n, 'the fixed gas limit reaches the simulation');

  const reverting = drySender({ simulateContract: (async () => Promise.reject(new Error('execution reverted'))) as never }, account);
  const outcome = await reverting.execute(CALL, { kind: 'settle', key: '1' });
  assert.equal(outcome.status, 'simulation-reverted');
});

test('CrankAlerts: an event pages once ever (remembered in the store), a condition every time; the dry run pages nothing', async () => {
  const sent: Array<{ kind: string; force: boolean | undefined; dedupeKey: string | undefined }> = [];
  const alerter = {
    alert: async (kind: string, _m: string, _d: unknown, o: { force?: boolean; dedupeKey?: string } = {}) => (sent.push({ kind, force: o.force, dedupeKey: o.dedupeKey }), true),
    clear: () => {},
  };
  const store = new V2Store(':memory:');
  const missed: RaisedAlert = { kind: 'v2_snapshot_missed', dedupeKey: 'u:1', message: 'm', data: {}, once: true };
  const held: RaisedAlert = { kind: 'v2_settlement_held', dedupeKey: 'u:1', message: 'h', data: {}, once: false };

  const live = new CrankAlerts(alerter as never, store, false);
  await live.raise(missed);
  await live.raise(missed);
  await live.raise(held);
  await live.raise(held);
  assert.deepEqual(sent, [
    { kind: 'v2_snapshot_missed', force: true, dedupeKey: 'u:1' },
    { kind: 'v2_settlement_held', force: undefined, dedupeKey: 'u:1' },
    { kind: 'v2_settlement_held', force: undefined, dedupeKey: 'u:1' },
  ]);
  assert.deepEqual(live.drain().map((a) => a.kind), ['v2_snapshot_missed', 'v2_settlement_held', 'v2_settlement_held']);
  // A restart (a new CrankAlerts on the same database) does not page the event again.
  await new CrankAlerts(alerter as never, store, false).raise(missed);
  assert.equal(sent.length, 3);

  const dry = new CrankAlerts(alerter as never, new V2Store(':memory:'), true);
  await dry.raise(missed);
  await dry.raise(held);
  assert.equal(sent.length, 3);
  assert.deepEqual(dry.drain().map((a) => a.kind), ['v2_snapshot_missed', 'v2_settlement_held']);
});

test('CrankAlerts: an event whose delivery failed is not marked sent; the next raise delivers it, then it is remembered', async () => {
  const sent: string[] = [];
  let relayUp = false;
  const alerter = { alert: async (kind: string) => (sent.push(kind), relayUp), clear: () => {} };
  const store = new V2Store(':memory:');
  const disagree: RaisedAlert = { kind: 'v2_sources_disagree', dedupeKey: 'u:1:2', message: 'm', data: {}, once: true };
  let clock = 1_000_000;
  const alerts = new CrankAlerts(alerter as never, store, false, () => clock);

  await alerts.raise(disagree);
  assert.deepEqual(sent, ['v2_sources_disagree']);
  assert.equal(store.getMeta('cranker:alerted:v2_sources_disagree:u:1:2'), null, 'an undelivered page is not remembered as sent');
  clock += 60_000;
  await alerts.raise(disagree);
  assert.equal(sent.length, 1, 'a failed delivery is not retried on every tick');

  relayUp = true;
  clock += 5 * 60_000;
  await alerts.raise(disagree);
  assert.deepEqual(sent, ['v2_sources_disagree', 'v2_sources_disagree'], 'the next tick tries again');
  assert.notEqual(store.getMeta('cranker:alerted:v2_sources_disagree:u:1:2'), null);
  await alerts.raise(disagree);
  assert.equal(sent.length, 2, 'once delivered, never again');
});

test('Cranker.tick with every RPC failing: each step fails on its own, is paged per step and shown on /state; rolls reports skipped; the tick returns', async () => {
  const registry = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
  const config = loadV2Config({ V2_MODE: 'cranker', RH_RPC: 'http://127.0.0.1:9', CRANKER_PK: `0x${'3c'.repeat(32)}`, KEEPER_DB_PATH: ':memory:', V2_REGISTRY_PATH: registry }) as CrankerConfig;
  // Every read fails, except (once anchorReadable) the deploy block the anchor is read from.
  let anchorReadable = false;
  const down = new Proxy(
    {},
    {
      get: (_target, prop) => async (args?: { blockNumber?: bigint }) =>
        prop === 'getBlock' && anchorReadable && args?.blockNumber !== undefined ? { number: args.blockNumber, hash: `0x${'d1'.repeat(32)}` } : Promise.reject(new Error('rpc down')),
    },
  ) as unknown as PublicClient;
  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: config.contracts.clearinghouse, orderBook: config.contracts.orderBook, autoRoller: null });
  // What a previous devnet at the same addresses left: its own anchor, a scan cursor and a done-mark.
  assert.equal(index.bindAnchor(`65100000:0x${'d0'.repeat(32)}`), 'fresh');
  store.setMeta(SCAN_CURSOR_META_KEY, '999');
  store.setMeta('cranker:snapshot:stale', '1');
  const paged: string[] = [];
  const alerter = { alert: async (kind: string, _m: string, data: { step?: string }) => (paged.push(`${kind}:${data.step}`), true), clear: () => {} };
  const cranker = new Cranker(
    {
      config,
      log: silentLogger(),
      client: down,
      logClient: down,
      addresses: {
        clearinghouse: config.contracts.clearinghouse,
        orderBook: config.contracts.orderBook,
        settlementOracle: config.contracts.settlementOracle,
        expiryCalendar: config.contracts.expiryCalendar,
        autoRoller: null,
        feeSplitter: null,
        multicall3: config.multicall3,
      },
      store,
      index,
      sender: drySender(down, '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f'),
      alerts: new CrankAlerts(alerter as never, store, false),
      indexer: null,
    },
    { pollIntervalMs: 60_000, schedule: true },
  );
  await assert.rejects(cranker.tick(), /rpc down/, 'no step runs before the store is matched to the deployment');
  assert.deepEqual(paged, []);
  assert.equal(index.anchor(), `65100000:0x${'d0'.repeat(32)}`);
  assert.equal(index.scannedTo(), 999n, 'nothing is reset on an anchor nobody has read');

  anchorReadable = true;
  const report = await cranker.tick();
  assert.equal(index.anchor(), `65100000:0x${'d1'.repeat(32)}`);
  assert.equal(index.scannedTo(), null, 'the stale deployment\'s cursor went before the index step');
  assert.equal(store.getMeta('cranker:snapshot:stale'), null);
  const failed = [...new Set(report.errors.map((e) => e.step))];
  assert.deepEqual(failed, ['index', 'snapshot', 'finalize', 'settle', 'prune', 'redeem', 'ladders', 'housekeeping']);
  assert.ok(report.errors.every((e) => /rpc down/.test(e.message)));
  assert.equal(report.wake, null);
  const rolls = report.reports.find((r) => r.step === 'rolls');
  assert.match(String(rolls?.notes.skipped), /no autoRoller configured/);
  assert.deepEqual(paged, ['index', 'snapshot', 'finalize', 'settle', 'prune', 'redeem', 'ladders', 'housekeeping'].map((s) => `v2_error:${s}`));
  const state = cranker.state() as { steps: Record<string, { runs: number; errors: number; lastError: { message: string } | null }>; ticks: number };
  assert.equal(state.ticks, 1);
  assert.equal(state.steps.ladders!.errors, 1);
  assert.match(state.steps.ladders!.lastError!.message, /rpc down/);
  assert.deepEqual({ runs: state.steps.rolls!.runs, errors: state.steps.rolls!.errors }, { runs: 1, errors: 0 });
  store.close();
});

test('CrankAlerts with the real Alerter: a once-page the store redelivered is not paged a second time by the next raise', async () => {
  let clock = 1_790_000_000_000;
  let relayUp = false;
  const posts: string[] = [];
  const store = new V2Store(':memory:');
  const alerter = new Alerter({
    mode: 'cranker',
    chainId: 4663,
    webhook: 'http://relay.test/alert',
    token: null,
    cooldownMs: 3_600_000,
    log: silentLogger(),
    store,
    now: () => clock,
    fetch: (async (_u: string, init: RequestInit) => (posts.push(String((JSON.parse(String(init.body)) as { kind: string }).kind)), new Response('{}', { status: relayUp ? 200 : 502 }))) as typeof fetch,
  });
  const alerts = new CrankAlerts(alerter, store, false, () => clock);
  const missed: RaisedAlert = { kind: 'v2_snapshot_missed', dedupeKey: 'u:9', message: 'm', data: {}, once: true };
  await alerts.raise(missed);
  relayUp = true;
  clock += 5 * 60_000;
  assert.equal(await alerter.redeliver(), 1, 'the tick start redelivers it');
  await alerts.raise(missed);
  assert.deepEqual(posts, ['v2_snapshot_missed', 'v2_snapshot_missed'], 'one failed POST, one delivered, no duplicate');
  assert.notEqual(store.getMeta('cranker:alerted:v2_snapshot_missed:u:9'), null);
});
