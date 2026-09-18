/**
 * notifier-18 (low): a failed positions read leaves Holdings.fetchedAt unchanged (rules/engine.ts
 * 281-284), and `due` is sorted by fetchedAt ascending and cut at maxRefreshPerTick = 50
 * (engine.ts:268-269). Fifty wallets whose reads keep failing (e.g. many longs and a slow pricing
 * service behind /positions) take every periodic slot on every tick, and every other watched
 * wallet stops getting its 5-minute refresh. Expected after the fix: failing wallets back off.
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { formatUnits, getAddress } from 'viem';
import { createTargetCipher } from '../crypto.js';
import { DEFAULT_PREFS } from '../prefs.js';
import { RulesEngine } from './engine.js';
import { createIndexerClient } from './indexer.js';
import { linkTelegramChat } from '../store.js';
import { captureLogger, createTestDb, json, startFakeServer, TEST_DATA_KEY_HEX, TestClock, type FakeServer, type TestDb } from '../testing.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const money = (raw: string) => ({ raw, decimals: 6, formatted: formatUnits(BigInt(raw), 6) });
const HEALTHY = getAddress('0xffffffffffffffffffffffffffffffffffffff01');
let db: TestDb;
let indexer: FakeServer;
let failing = new Set<string>();

before(async () => {
  db = await createTestDb();
  indexer = await startFakeServer((req, res: ServerResponse) => {
    const url = new URL(req.path, 'http://fake');
    if (url.pathname === '/v2/markets') return json(res, 200, [{ ticker: 'NVDA', name: 'NVIDIA', underlying: NVDA, status: 'live', spot: money('220000000'), spotUpdatedAt: 1, strikeTick: money('1000000'), puts: false, expiries: [], stats: {} }]);
    if (url.pathname === '/v2/feed/activity') return json(res, 200, { items: [], nextCursor: null });
    const m = /^\/v2\/accounts\/(0x[0-9a-fA-F]{40})\/positions$/.exec(url.pathname);
    if (m !== null) {
      if (failing.has(m[1] ?? '')) return json(res, 504, { error: { code: 'pricing_timeout', message: '' } });
      return json(res, 200, { longs: [], shorts: [], orders: [], ledger: [], strategies: [], prefs: { inKind: false, toLedger: false } });
    }
    return json(res, 404, { error: { code: 'not_found', message: '' } });
  });
});
after(async () => {
  await indexer.close();
  await db.close();
});

const link = async (address: string, n: number, now: Date) =>
  linkTelegramChat(db, { address, targetEnc: cipher.encrypt(`-${n}`, `telegram:${address}`), targetHash: cipher.hash(`telegram:-${n}`), defaultPrefs: DEFAULT_PREFS, now });

test('fifty persistently failing wallets do not starve another wallet\'s periodic refresh', async () => {
  const clock = new TestClock();
  const engine = new RulesEngine({ db, indexer: createIndexerClient({ baseUrl: indexer.url }), enqueue: async () => ({ queued: 0, duplicates: 0, filtered: 0 }), logger: captureLogger().logger, now: clock.now });
  const heavy = Array.from({ length: 50 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`));
  for (const [i, a] of heavy.entries()) await link(a, i + 1, clock.now());
  await engine.runOnce(); // first reads succeed
  clock.advance(60_000);
  await link(HEALTHY, 999, clock.now());
  await engine.runOnce(); // the healthy wallet's first read, one minute later
  failing = new Set(heavy); // those 50 now time out every time
  const healthyReads = () => indexer.requests.filter((r) => r.path === `/v2/accounts/${HEALTHY}/positions`).length;
  const start = healthyReads();
  for (let tick = 0; tick < 60; tick += 1) {
    clock.advance(30_000);
    await engine.runOnce();
  }
  console.log(`30 minutes of ticks (holdingsRefreshS 300): periodic refreshes of the healthy wallet = ${healthyReads() - start}; failed reads = ${indexer.requests.filter((r) => failing.has(/0x[0-9a-fA-F]{40}/.exec(r.path)?.[0] ?? '')).length - 100}`);
  assert.ok(healthyReads() - start >= 5, 'the healthy wallet was never refreshed in 30 minutes');
});
