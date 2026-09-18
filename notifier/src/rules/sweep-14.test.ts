/**
 * notifier-14 (low): watched wallets with no stored holdings are refreshed outside the
 * maxRefreshPerTick budget (rules/engine.ts:265). K fresh wallets (one signature and one webpush
 * POST each, no gas) make the next tick issue K positions reads against indexer-v2, which also
 * serves the dapp, and every subscriber's rules wait for all K; while those reads keep failing the
 * wallets stay never-read and the full fan-out repeats every tick. Expected after the fix:
 * first reads share a per-tick budget and failed reads back off.
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { formatUnits, getAddress } from 'viem';
import { createTargetCipher } from '../crypto.js';
import { DEFAULT_PREFS } from '../prefs.js';
import { DEFAULT_RULES_OPTIONS, RulesEngine } from './engine.js';
import { createIndexerClient } from './indexer.js';
import { linkTelegramChat } from '../store.js';
import { captureLogger, createTestDb, json, startFakeServer, TEST_DATA_KEY_HEX, TestClock, type FakeServer, type TestDb } from '../testing.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const money = (raw: string) => ({ raw, decimals: 6, formatted: formatUnits(BigInt(raw), 6) });
let db: TestDb;
let indexer: FakeServer;
let positionsFail = true;

before(async () => {
  db = await createTestDb();
  indexer = await startFakeServer((req, res: ServerResponse) => {
    const url = new URL(req.path, 'http://fake');
    if (url.pathname === '/v2/markets') return json(res, 200, [{ ticker: 'NVDA', name: 'NVIDIA', underlying: NVDA, status: 'live', spot: money('220000000'), spotUpdatedAt: 1, strikeTick: money('1000000'), puts: false, expiries: [], stats: {} }]);
    if (url.pathname === '/v2/feed/activity') return json(res, 200, { items: [], nextCursor: null });
    if (url.pathname.endsWith('/positions')) {
      if (positionsFail) return json(res, 503, { error: { code: 'overloaded', message: '' } });
      return json(res, 200, { longs: [], shorts: [], orders: [], ledger: [], strategies: [], prefs: { inKind: false, toLedger: false } });
    }
    return json(res, 404, { error: { code: 'not_found', message: '' } });
  });
});
after(async () => {
  await indexer.close();
  await db.close();
});

test('never-read wallets share the per-tick positions budget', async () => {
  const clock = new TestClock();
  const K = 200;
  for (let i = 1; i <= K; i += 1) {
    const address = getAddress(`0x${i.toString(16).padStart(40, '0')}`);
    await linkTelegramChat(db, { address, targetEnc: cipher.encrypt(`-${i}`, `telegram:${address}`), targetHash: cipher.hash(`telegram:-${i}`), defaultPrefs: DEFAULT_PREFS, now: clock.now() });
  }
  const engine = new RulesEngine({ db, indexer: createIndexerClient({ baseUrl: indexer.url }), enqueue: async () => ({ queued: 0, duplicates: 0, filtered: 0 }), logger: captureLogger().logger, now: clock.now });
  const perTick: number[] = [];
  for (let tick = 0; tick < 3; tick += 1) {
    const before = indexer.requests.filter((r) => r.path.endsWith('/positions')).length;
    const r = await engine.runOnce();
    perTick.push(indexer.requests.filter((x) => x.path.endsWith('/positions')).length - before);
    assert.equal(r.refreshFailed, perTick.at(-1));
    clock.advance(30_000);
  }
  console.log(`positions reads per tick with ${K} never-read wallets and a failing indexer: ${JSON.stringify(perTick)} (maxRefreshPerTick ${DEFAULT_RULES_OPTIONS.maxRefreshPerTick})`);
  assert.ok(Math.max(...perTick) <= DEFAULT_RULES_OPTIONS.maxRefreshPerTick, 'first reads bypass the per-tick cap and repeat every tick while they fail');
});
