/**
 * notifier-19 (low): the /v2/series fallback read (rules/engine.ts:311-318) is sequential and any
 * non-404 error rethrows, aborting the tick before saveState. Holdings refreshed in that tick are
 * discarded, every positions read is redone next tick, and fills and redemptions wait behind it.
 * Expected after the fix: a failed fallback read skips that long for this tick and the tick persists.
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { formatUnits } from 'viem';
import { createTargetCipher } from '../crypto.js';
import { DEFAULT_PREFS } from '../prefs.js';
import { RulesEngine } from './engine.js';
import { createIndexerClient } from './indexer.js';
import { linkTelegramChat } from '../store.js';
import { captureLogger, createTestDb, json, startFakeServer, TEST_DATA_KEY_HEX, TestClock, type FakeServer, type TestDb } from '../testing.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const ALICE = '0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';
const money = (raw: string) => ({ raw, decimals: 6, formatted: formatUnits(BigInt(raw), 6) });
const EXPIRY = 1789156800;
let db: TestDb;
let indexer: FakeServer;
let seriesMode: 'error' | 'pending' | 'final' = 'error';

before(async () => {
  db = await createTestDb();
  indexer = await startFakeServer((req, res: ServerResponse) => {
    const url = new URL(req.path, 'http://fake');
    if (url.pathname === '/v2/markets') return json(res, 200, [{ ticker: 'NVDA', name: 'NVIDIA', underlying: NVDA, status: 'live', spot: money('220000000'), spotUpdatedAt: 1, strikeTick: money('1000000'), puts: false, expiries: [], stats: {} }]);
    if (url.pathname === '/v2/feed/activity') return json(res, 200, { items: [], nextCursor: null });
    if (url.pathname.endsWith('/positions')) {
      return json(res, 200, {
        longs: [{
          series: { longId: '2000', shortId: '2001', ticker: 'NVDA', underlying: NVDA, isPut: false, strike: money('230000000'), expiry: EXPIRY, tenor: 'weekly', mintCutoff: EXPIRY - 1800, status: 'settled' },
          units: '40', avgCost: money('500000'), mark: null, unrealised: null, claimable: null,
        }],
        shorts: [], orders: [], ledger: [], strategies: [], prefs: { inKind: false, toLedger: false },
      });
    }
    if (url.pathname.startsWith('/v2/series/')) {
      if (seriesMode === 'error') return json(res, 502, { error: { code: 'pricing_unavailable', message: '' } });
      return json(res, 200, {
        series: { longId: '2000', shortId: '2001', ticker: 'NVDA', underlying: NVDA, isPut: false, strike: money('230000000'), expiry: EXPIRY, tenor: 'weekly', mintCutoff: EXPIRY - 1800, status: 'settled' },
        settlement: seriesMode === 'pending'
          ? { status: 'Pending', price: null, longPayoutPerUnit: null, finalizedAt: null }
          : { status: 'Finalized', price: money('220000000'), longPayoutPerUnit: money('0'), finalizedAt: Math.floor(Date.parse('2026-09-16T20:59:00Z') / 1000) },
      });
    }
    return json(res, 404, { error: { code: 'not_found', message: '' } });
  });
});
after(async () => {
  await indexer.close();
  await db.close();
});

test('one failing /v2/series fallback read does not discard the tick\'s refreshed holdings', async () => {
  const clock = new TestClock();
  const enqueued: string[] = [];
  await linkTelegramChat(db, { address: ALICE, targetEnc: cipher.encrypt('-1', `telegram:${ALICE}`), targetHash: cipher.hash('telegram:-1'), defaultPrefs: DEFAULT_PREFS, now: clock.now() });
  const engine = new RulesEngine({ db, indexer: createIndexerClient({ baseUrl: indexer.url }), enqueue: async (kind) => { enqueued.push(kind); return { queued: 1, duplicates: 0, filtered: 0 }; }, logger: captureLogger().logger, now: clock.now });
  let outcome = 'ok';
  try {
    await engine.runOnce();
  } catch (error) {
    outcome = `threw ${(error as { code?: string }).code}`;
  }
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifier.rules_holdings');
  const state = await db.query<{ name: string }>('SELECT name FROM notifier.rules_state');
  console.log(`tick with a 502 on /v2/series/2000: ${outcome}; rules_holdings rows persisted: ${rows[0]?.n}; cursor/snapshot rows: ${state.rows.length}`);
  assert.equal(outcome, 'ok', 'the whole tick aborted: nothing persisted, every positions read repeats next tick');
  const stored = await db.query<{ holdings: { longs: { series: { status: string } }[] } }>('SELECT holdings FROM notifier.rules_holdings');
  assert.equal(stored.rows[0]?.holdings.longs[0]?.series.status, 'held', 'failed settlement transition must remain retryable after restart');
  seriesMode = 'pending';
  clock.advance(5 * 60_000);
  const resumed = new RulesEngine({ db, indexer: createIndexerClient({ baseUrl: indexer.url }), enqueue: async (kind) => { enqueued.push(kind); return { queued: 1, duplicates: 0, filtered: 0 }; }, logger: captureLogger().logger, now: clock.now });
  await resumed.runOnce();
  assert.deepEqual(enqueued, [], 'a pending fallback must not issue a premature receipt');
  seriesMode = 'final';
  clock.advance(5 * 60_000);
  await resumed.runOnce();
  assert.deepEqual(enqueued, ['settlement_receipt'], 'recovered fallback must deliver the worthless-long receipt');
});
