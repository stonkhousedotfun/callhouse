/**
 * notifier-17 (high): step 2 of the rules tick (`await indexer.markets()`, rules/engine.ts:193) is
 * outside any try. The indexer's /v2/markets answers 503 spot_unavailable when SettlementOracle
 * spot() reverts for ANY market (index../api/v2/markets.ts, unchanged on codex/v2-integration),
 * and spot() reverts StaleSpot whenever the Chainlink push feed is older than spotMaxAgeS. At the 3600
 * of the time that was quiet hours, every night and every weekend; the 90000 of ops/deploy.md §15.13 still
 * leaves every weekend and a broken feed. Every tick then throws with nothing enqueued, and once
 * the gap passes 6 h the storm guard (engine.ts:198-203, 234) drops the receipts for good.
 * Expected after the fix: a markets failure leaves spot-driven rules idle but event receipts flow.
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { formatUnits } from 'viem';
import type { Channel } from '../channels/types.js';
import { createTargetCipher } from '../crypto.js';
import { DeliveryService } from '../delivery.js';
import { DEFAULT_PREFS } from '../prefs.js';
import { RulesEngine } from './engine.js';
import { createIndexerClient } from './indexer.js';
import { linkTelegramChat } from '../store.js';
import { appLinks } from '../templates.js';
import { captureLogger, createTestDb, json, startFakeServer, TEST_DATA_KEY_HEX, TestClock, type FakeServer, type TestDb } from '../testing.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const ALICE = '0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';
const BOB = '0x4088c59Eb3fB713B124f182E7083AEb3358A030B';
const money = (raw: string, decimals = 6) => ({ raw, decimals, formatted: formatUnits(BigInt(raw), decimals) });
const EXPIRY = 1790366400;
const series = { longId: '1000', shortId: '1001', ticker: 'NVDA', underlying: NVDA, isPut: false, strike: money('221000000'), expiry: EXPIRY, tenor: 'weekly', mintCutoff: EXPIRY - 1800, status: 'open' };
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const fill = (n: number, ts: number) => ({
  id: `${tx(n)}-1`, kind: 'fill', ts, longId: '1000', series, accounts: [ALICE, BOB],
  data: { orderId: String(n), taker: ALICE, maker: BOB, recipient: ALICE, units: '50', price: money('3600000'), premium: money('1800000'), takerFee: money('100000'), sellerFee: money('90000'), makerRebate: money('45000'), primary: true, takerIsBuyer: true, tx: tx(n) },
});
const emptyPositions = { longs: [], shorts: [], orders: [], ledger: [], strategies: [], prefs: { inKind: false, toLedger: false } };

let db: TestDb;
let indexer: FakeServer;
let spotStale = true;
let items: ReturnType<typeof fill>[] = [];
const clock = new TestClock(Date.parse('2026-09-18T20:30:00Z')); // Friday 16:30 New York

before(async () => {
  db = await createTestDb();
  indexer = await startFakeServer((req, res: ServerResponse) => {
    const url = new URL(req.path, 'http://fake');
    if (url.pathname === '/v2/markets') {
      if (spotStale) return json(res, 503, { error: { code: 'spot_unavailable', message: 'Live spot is unavailable for one or more markets.' } });
      return json(res, 200, [{ ticker: 'NVDA', name: 'NVIDIA', underlying: NVDA, status: 'live', spot: money('220000000'), spotUpdatedAt: 1, strikeTick: money('1000000'), puts: false, expiries: [], stats: {} }]);
    }
    if (url.pathname === '/v2/feed/activity') {
      const since = Number(url.searchParams.get('since') ?? '0');
      return json(res, 200, { items: items.filter((i) => i.ts >= since), nextCursor: null });
    }
    if (url.pathname.endsWith('/positions')) return json(res, 200, emptyPositions);
    return json(res, 404, { error: { code: 'not_found', message: '' } });
  });
});
after(async () => {
  await indexer.close();
  await db.close();
});

test('a stale spot on /v2/markets does not stop fill receipts, and they are not lost after 6 h', async () => {
  const sent: string[] = [];
  const telegram: Channel = { name: 'telegram', async send(_t, m) { sent.push(m.title); return { ok: true }; } };
  const queue = new DeliveryService({ db, cipher, links: appLinks('https://app.stonkhouse.test'), logger: captureLogger().logger, now: clock.now, channels: { telegram } });
  const log = captureLogger();
  const engine = () => new RulesEngine({ db, indexer: createIndexerClient({ baseUrl: indexer.url }), enqueue: (k, a, p, d) => queue.enqueue(k, a, p, d), logger: log.logger, now: clock.now });
  await linkTelegramChat(db, { address: ALICE, targetEnc: cipher.encrypt('-1001', `telegram:${ALICE}`), targetHash: cipher.hash('telegram:-1001'), defaultPrefs: DEFAULT_PREFS, now: clock.now() });
  items = [fill(1, Math.floor(clock.ms / 1000) - 60)];

  const outcomes: string[] = [];
  for (let hour = 0; hour < 7; hour += 1) {
    try {
      const r = await engine().runOnce();
      outcomes.push(`+${hour}h ok queued=${r.queued}`);
    } catch (error) {
      outcomes.push(`+${hour}h threw ${(error as { code?: string }).code}`);
    }
    clock.advance(3600_000);
  }
  spotStale = false; // the feed prints again (Monday open, or a 0.5 % move)
  const recovered = await engine().runOnce();
  outcomes.push(`+7h spot back: items=${recovered.items} stale=${recovered.stale} queued=${recovered.queued}`);
  const { rows } = await db.query<{ dedupe_key: string }>('SELECT dedupe_key FROM notifier.delivery');
  console.log(outcomes.join('\n'));
  console.log(`fill receipts queued for the subscriber: ${rows.length}`);
  assert.equal(rows.length, 1, 'the fill receipt was never enqueued and is now past the storm guard');
});
