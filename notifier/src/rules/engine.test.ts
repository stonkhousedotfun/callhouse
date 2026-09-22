/**
 * The rules engine on PGlite against a fake indexer on 127.0.0.1, with the real delivery queue.
 *
 * WHAT IS PINNED:
 *   - a tick reads /v2/markets, the activity feed and the positions of WATCHED wallets only (no
 *     holders or strategies scan), and enqueues receipts once;
 *   - the cursor and the snapshot survive a restart: the same items are not handled again, a
 *     strike side seen before the restart still makes a crossing after it;
 *   - the storm guard: after a long restart the feed is read from now − 6 h and nothing older than
 *     6 h is enqueued; first boot starts at now − 6 h;
 *   - market spot outages (5xx, bad JSON, a bad shape, a timeout) leave receipts flowing; feed
 *     outages fail the tick, and the loop logs a code, backs off and recovers;
 *   - paging resumes from the indexer's cursor when a tick's page budget runs out; the re-read
 *     window behind the cursor is 60 s;
 *   - a redemption receipt gets the cost of the long it burned and the redemption's own
 *     settlementPrice, with no /v2/series read; a settled long's settlement is read once, at its
 *     transition;
 *   - auto_roll skipped reads calendar days in 62-day blocks, caches them, waits past a holiday,
 *     and survives a calendar outage (the tick runs, the warning comes once the days are read);
 *   - the feed is asked for every activity kind the notifier can parse (a `stale_cancel` item
 *     produces the v7 auto_roll `withdrawn` message), and price-driven payloads carry the market's
 *     own `spotUpdatedAt`;
 *   - unreadable stored state starts afresh; wallets that leave the watch set lose their holdings;
 *   - the interface-version pin (K8-231): a /v2/config version this build does not implement fails
 *     the tick CLOSED - it throws before any other route is read, persists nothing and enqueues
 *     nothing - while an UNREADABLE config stays a warning and the tick continues on stored state;
 *   - migration 002 is idempotent; no log line carries a wallet address.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { formatUnits } from 'viem';
import type { Channel } from '../channels/types.js';
import { createTargetCipher } from '../crypto.js';
import { MIGRATIONS_DIR, migrate } from '../db.js';
import { DeliveryService } from '../delivery.js';
import { prefsSchema, type Prefs } from '../prefs.js';
import { linkTelegramChat } from '../store.js';
import { appLinks } from '../templates.js';
import { captureLogger, createTestDb, json, startFakeServer, TEST_DATA_KEY_HEX, TestClock, type FakeServer, type Recorded, type TestDb } from '../testing.js';
import { backoffMs, RulesEngine, type RulesOptions } from './engine.js';
import { ACTIVITY_KINDS, activityItemSchema, assertInterfaceVersion, createIndexerClient, IMPLEMENTED_INTERFACE_VERSION, IndexerError, InterfaceVersionError } from './indexer.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const links = appLinks('https://app.stonkhouse.test');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ALICE = '0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';
const BOB = '0x4088c59Eb3fB713B124f182E7083AEb3358A030B';
const CAROL = '0x300a7AB2f92B536e3f58422372c964B2Bb535ea2';
const HOUR = 3600;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const money = (raw: string | bigint, decimals = 6) => ({ raw: String(raw), decimals, formatted: formatUnits(BigInt(raw), decimals) });

const EXPIRY = 1790366400; // Fri 25 Sep 2026 16:00 New York
const series = (longId: string, o: Record<string, unknown> = {}) => ({
  longId,
  shortId: String(BigInt(longId) + 1n),
  ticker: 'NVDA',
  underlying: NVDA,
  isPut: false,
  strike: money('221000000'),
  expiry: EXPIRY,
  tenor: 'weekly',
  mintCutoff: EXPIRY - 1800,
  status: 'open',
  ...o,
});
const L221 = '1000';
const L216 = '2000';

/* ------------------------------------------------------------------ fake indexer */

type Item = { id: string; ts: number; [key: string]: unknown };

class FakeIndexer {
  server!: FakeServer;
  spot = '220000000';
  items: Item[] = [];
  positions: Record<string, unknown> = {};
  series: Record<string, unknown> = {};
  /**
   * Values from /v2/config. chainId and deployBlock stay arbitrary — those are runtime identity and
   * are never hardcoded in production. interfaceVersion is NOT arbitrary any more (K8-231): this
   * fake stands in for an indexer the build implements, so it serves the pinned version. It is a
   * literal, not `IMPLEMENTED_INTERFACE_VERSION`, on purpose — a fixture that reads the constant it
   * is meant to exercise agrees with any value the constant takes, and raising the pin should make
   * this suite go red until someone has looked at the payload shapes.
   */
  config: { chainId: number; interfaceVersion: number; deployBlock: string | null } = {
    chainId: 1, interfaceVersion: 8, deployBlock: '1',
  };
  operations: unknown[] = [];
  /** Day indices the ExpiryCalendar marks as holidays. */
  holidays = new Set<number>();
  honourSince = true;
  /** Answer a path instead of the fake's own logic (outage injection). Return false to fall through. */
  override: (path: string, res: ServerResponse) => boolean = () => false;

  async start(): Promise<string> {
    this.server = await startFakeServer((req, res) => this.handle(req, res));
    return this.server.url;
  }

  paths(): string[] {
    return this.server.requests.map((r) => r.path);
  }

  private handle(req: Recorded, res: ServerResponse): void {
    if (this.override(req.path, res)) return;
    const url = new URL(req.path, 'http://fake');
    const path = url.pathname;
    if (path === '/v2/config') {
      return json(res, 200, this.config);
    }
    if (path === '/v2/admin/operations') {
      return json(res, 200, { items: this.operations });
    }
    if (path === '/v2/markets') {
      return json(res, 200, [
        { ticker: 'NVDA', name: 'NVIDIA', underlying: NVDA, status: 'live', spot: money(this.spot), spotUpdatedAt: 1789589112, strikeTick: money('1000000'), puts: false, expiries: [], stats: {} },
      ]);
    }
    if (path === '/v2/feed/activity') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const start = Number(url.searchParams.get('cursor') ?? '0');
      const all = [...this.items].sort((a, b) => a.ts - b.ts).filter((i) => !this.honourSince || i.ts >= since);
      const items = all.slice(start, start + limit);
      return json(res, 200, { items, nextCursor: start + limit < all.length ? String(start + limit) : null });
    }
    const positions = /^\/v2\/accounts\/(0x[0-9a-fA-F]{40})\/positions$/.exec(path);
    if (positions !== null) {
      const body = this.positions[positions[1] ?? ''];
      return body === undefined ? json(res, 404, { error: { code: 'not_found', message: 'no fixture' } }) : json(res, 200, body);
    }
    if (path === '/v2/calendar/holidays') {
      const fromDay = Number(url.searchParams.get('fromDay'));
      const toDay = Number(url.searchParams.get('toDay'));
      if (!(toDay >= fromDay && toDay - fromDay < 62)) return json(res, 400, { error: { code: 'bad_calendar_range', message: 'no' } });
      const items = [];
      for (let dayIndex = fromDay; dayIndex <= toDay; dayIndex += 1) {
        const weekday = new Date(dayIndex * 86_400_000).getUTCDay();
        const isHoliday = this.holidays.has(dayIndex);
        items.push({ dayIndex, isHoliday, isSessionDay: weekday !== 0 && weekday !== 6 && !isHoliday });
      }
      return json(res, 200, { items });
    }
    const detail = /^\/v2\/series\/(\d+)$/.exec(path);
    if (detail !== null) {
      const body = this.series[detail[1] ?? ''];
      return body === undefined ? json(res, 404, { error: { code: 'series_not_found', message: 'no' } }) : json(res, 200, body);
    }
    return json(res, 404, { error: { code: 'not_found', message: 'no route' } });
  }
}

const STRATEGY = { active: true, weekly: true, smartPricing: false, otmBps: 450, askBps: 12, minAskBps: 5, maxAskBps: 50, maxUnits: '0' };

function positionsBody(
  o: {
    longs?: { longId: string; units: string; avgCost: string; status?: string }[];
    strategies?: { longId: string; expiry: number; lastRolledAt: number | null }[];
    toLedger?: boolean;
  } = {},
) {
  return {
    longs: (o.longs ?? []).map((l) => ({
      series: series(l.longId, l.status === undefined ? {} : { status: l.status }),
      units: l.units,
      avgCost: money(l.avgCost),
      mark: null,
      unrealised: null,
      claimable: null,
    })),
    shorts: [],
    orders: [],
    ledger: [],
    strategies: (o.strategies ?? []).map((st) => ({
      ticker: 'NVDA',
      strategy: STRATEGY,
      currentSeries: series(st.longId, { expiry: st.expiry, mintCutoff: st.expiry - 1800, status: 'settled' }),
      orderId: '1009',
      lastRolledAt: st.lastRolledAt,
    })),
    prefs: { inKind: false, toLedger: o.toLedger ?? false },
  };
}

function fillItem(n: number, ts: number, taker = ALICE, maker = BOB, recipient = taker): Item {
  return {
    id: `${tx(n)}-1`,
    kind: 'fill',
    ts,
    longId: L221,
    series: series(L221),
    accounts: [...new Set([taker, maker, recipient])],
    data: {
      orderId: String(n),
      taker,
      maker,
      recipient,
      units: '50',
      price: money('3600000'),
      premium: money('1800000'),
      takerFee: money('100000'),
      sellerFee: money('90000'),
      makerRebate: money('45000'),
      primary: true,
      takerIsBuyer: true,
      tx: tx(n),
    },
  };
}

/** INTERFACE_VERSION 7: AutoRoller.cancelStale withdrew a roll ask the spot had overtaken. */
function staleCancelItem(n: number, ts: number, o: { writer?: string; spotUpdatedAt?: number } = {}): Item {
  const writer = o.writer ?? ALICE;
  return {
    id: `${tx(n)}-5`,
    kind: 'stale_cancel',
    ts,
    longId: L221,
    series: series(L221),
    accounts: [writer],
    data: {
      writer,
      orderId: String(n),
      spot: money('223400000'),
      spotUpdatedAt: o.spotUpdatedAt ?? ts - 30,
      nextRollAfter: EXPIRY,
      tx: tx(n),
    },
  };
}

function redemptionItem(n: number, ts: number, o: { side?: 'long' | 'short'; amount?: string } = {}): Item {
  return {
    id: `${tx(n)}-4`,
    kind: 'redemption',
    ts,
    longId: L216,
    series: series(L216, { strike: money('216000000'), status: 'settled' }),
    accounts: [ALICE],
    data: {
      holder: ALICE,
      side: o.side ?? 'long',
      tokenId: o.side === 'short' ? String(BigInt(L216) + 1n) : L216,
      units: '40',
      asset: USDG,
      amount: money(o.amount ?? '1360000'),
      amountInKind: money('5578851412944360', 18),
      settlementPrice: money('219400000'),
      toLedger: false,
      tx: tx(n),
    },
  };
}

/* ------------------------------------------------------------------ harness */

let db: TestDb;
let fake: FakeIndexer;
let indexerUrl: string;
const clock = new TestClock();
let log = captureLogger();
const allLogs: string[] = [];
const sent: string[] = [];

const telegram: Channel = {
  name: 'telegram',
  async send(_target, message) {
    sent.push(message.title);
    return { ok: true };
  },
};

function delivery() {
  return new DeliveryService({ db, cipher, links, logger: log.logger, now: clock.now, channels: { telegram } });
}

function engine(options: Partial<RulesOptions> = {}, timeoutMs?: number) {
  const queue = delivery();
  return new RulesEngine({
    db,
    indexer: createIndexerClient({ baseUrl: indexerUrl, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    enqueue: (kind, address, payload, key) => queue.enqueue(kind, address, payload, key),
    logger: log.logger,
    now: clock.now,
    options,
  });
}

async function subscribe(address: string, prefs: Prefs = prefsSchema.parse({})) {
  const chat = `-100${address.slice(2, 8).replace(/\D/g, '1')}`;
  await linkTelegramChat(db, {
    address,
    targetEnc: cipher.encrypt(chat, `telegram:${address}`),
    targetHash: cipher.hash(`telegram:${chat}`),
    defaultPrefs: prefs,
    now: clock.now(),
  });
}

async function keys(): Promise<string[]> {
  const { rows } = await db.query<{ dedupe_key: string }>('SELECT dedupe_key FROM notifier.delivery ORDER BY created_at, dedupe_key');
  return rows.map((r) => r.dedupe_key);
}

const now = () => Math.floor(clock.ms / 1000);
const activityQueries = () =>
  fake.paths().filter((p) => p.startsWith('/v2/feed/activity')).map((p) => new URL(p, 'http://fake').searchParams);
const calendarQueries = () =>
  fake
    .paths()
    .filter((p) => p.startsWith('/v2/calendar/holidays'))
    .map((p) => new URL(p, 'http://fake').searchParams)
    .map((q) => [q.get('fromDay'), q.get('toDay')]);

before(async () => {
  db = await createTestDb();
  fake = new FakeIndexer();
  indexerUrl = await fake.start();
});
after(async () => {
  await fake.server.close();
  await db.close();
  allLogs.push(...log.lines);
  const text = allLogs.join('\n');
  assert.ok(allLogs.length > 5, 'the suite should have logged');
  for (const secret of [ALICE, BOB, ALICE.toLowerCase(), BOB.toLowerCase()]) {
    assert.ok(!text.includes(secret), `log output leaked ${secret}`);
  }
});
beforeEach(async () => {
  await db.reset();
  clock.ms = Date.parse('2026-09-16T21:00:00Z');
  Object.assign(fake, {
    spot: '220000000', items: [], positions: {}, series: {}, holidays: new Set<number>(),
    honourSince: true, override: () => false,
    config: { chainId: 1, interfaceVersion: 8, deployBlock: '1' },
    operations: [],
  });
  fake.server.requests.length = 0;
  sent.length = 0;
  allLogs.push(...log.lines);
  log = captureLogger();
});

/* ------------------------------------------------------------------ tests */

test('a tick reads spot, the feed and watched wallets only; receipts go out once; the cursor survives a restart', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.positions[BOB] = positionsBody();
  const f1 = fillItem(1, now() - 120);
  fake.items = [f1];

  const first = await engine().runOnce();
  assert.deepEqual([first.items, first.stale, first.refreshed, first.queued], [1, 0, 1, 1]);
  assert.deepEqual(await keys(), [`fill_receipt:${ALICE}:${L221}:${f1.id}-taker`], 'Bob is not subscribed');
  assert.equal(activityQueries()[0]?.get('since'), String(now() - 6 * HOUR - 60), 'first boot reads from now − 6 h (less the 60 s re-read)');
  assert.equal(
    log.lines.some((l) => l.includes('deployment anchor changed')),
    false,
    'first boot has no previous anchor: record it, do not reset',
  );
  const { rows: anchors } = await db.query<{ value: unknown }>(`SELECT value FROM notifier.rules_state WHERE name = 'anchor'`);
  assert.equal(anchors[0]?.value, '1:8:1');
  assert.equal(activityQueries()[0]?.get('kinds'), ACTIVITY_KINDS.join(','), 'the query asks for the list, not a frozen subset of it');
  assert.ok(fake.paths().includes(`/v2/accounts/${ALICE}/positions`));
  assert.ok(!fake.paths().some((p) => p.includes(BOB) || p.includes('/holders') || p.includes('/strategies')), fake.paths().join(' '));

  // A new process on the same database.
  clock.advance(30_000);
  fake.server.requests.length = 0;
  const again = await engine().runOnce();
  assert.deepEqual([again.items, again.queued, again.requests], [0, 0, 0]);
  assert.equal(activityQueries()[0]?.get('since'), String(f1.ts - 60), 'the persisted cursor minus the 60 s lookback');

  const f2 = fillItem(2, now() - 10, BOB, ALICE);
  fake.items.push(f2);
  const third = await engine().runOnce();
  assert.deepEqual([third.items, third.queued], [1, 1]);
  assert.deepEqual((await keys()).slice(1), [`fill_receipt:${ALICE}:${L221}:${f2.id}-maker`]);
});

test('the feed is asked for every kind the notifier can parse, inside the route’s 64-character bound', () => {
  // The schema union is the notifier's definition of "a kind I can handle"; the query is what it
  // actually receives. A kind in the first and not the second is a message that can never fire,
  // which is how the v7 withdrawal notice was lost for a release.
  const parsable = (activityItemSchema.options as unknown as { shape: { kind: { value: string } } }[]).map((option) => option.shape.kind.value);
  assert.deepEqual([...ACTIVITY_KINDS].sort(), [...parsable].sort(), 'every parsable activity kind must be requested');
  assert.ok(ACTIVITY_KINDS.includes('stale_cancel'), 'without stale_cancel the auto_roll withdrawn message never arrives');
  const parameter = ACTIVITY_KINDS.join(',');
  assert.ok(parameter.length <= 64, `kinds is ${parameter.length} characters; /v2/feed/activity bounds the parameter at 64`);
});

test('storm guard: after two days down, the feed is read from now − 6 h and nothing older is sent', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  await engine().runOnce();
  const bootedAt = now();

  clock.advance(2 * 24 * HOUR * 1000);
  const old = fillItem(1, bootedAt + HOUR);
  const stale = fillItem(2, now() - 6 * HOUR - 60);
  const fresh = fillItem(3, now() - 60);
  fake.items = [old, stale, fresh];
  fake.server.requests.length = 0;

  const result = await engine().runOnce();
  assert.equal(activityQueries()[0]?.get('since'), String(now() - 6 * HOUR - 60));
  assert.deepEqual([result.items, result.stale, result.queued], [2, 1, 1]);
  assert.deepEqual(await keys(), [`fill_receipt:${ALICE}:${L221}:${fresh.id}-taker`]);

  // A feed that ignored `since` would hand back the old item: it is not handled either.
  fake.honourSince = false;
  fake.items.push(fillItem(4, now() - 30));
  const next = await engine().runOnce();
  assert.deepEqual([next.items, next.queued], [1, 1]);
  assert.equal((await keys()).length, 2);
});

test('market spot failures leave receipts flowing; a feed failure still aborts before persistence', async () => {
  const failWith = async (answer: (res: ServerResponse) => void, code: string, timeoutMs?: number) => {
    await db.reset();
    await subscribe(ALICE);
    fake.positions[ALICE] = positionsBody();
    fake.items = [fillItem(1, now() - 60)];
    fake.override = (path, res) => {
      if (!path.startsWith('/v2/markets')) return false;
      answer(res);
      return true;
    };
    const result = await engine({}, timeoutMs).runOnce();
    assert.equal(result.queued, 1);
    assert.ok(log.lines.some((line) => line.includes(`"code":"${code}"`) && line.includes('market spots unavailable')));
    assert.equal((await keys()).length, 1);
  };
  await failWith((res) => json(res, 502, { error: { code: 'bad_gateway', message: '' } }), 'http_502');
  await failWith((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{nope');
  }, 'bad_json');
  await failWith((res) => json(res, 200, [{ ticker: 'NVDA', spot: 215 }]), 'bad_response');
  await failWith(() => undefined, 'timeout', 100);

  await db.reset();
  await subscribe(ALICE);
  fake.override = (path, res) => {
    if (!path.startsWith('/v2/feed/activity')) return false;
    json(res, 503, { error: { code: 'degraded', message: '' } });
    return true;
  };
  await assert.rejects(engine().runOnce(), (error: unknown) => error instanceof IndexerError && error.code === 'http_503' && error.route === 'activity');
  const { rows } = await db.query('SELECT name FROM notifier.rules_state');
  assert.equal(rows.length, 0, 'feed failure must not advance the cursor');
});

test('an unavailable spot in one market preserves receipt processing and healthy spot reads', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.items = [fillItem(1, now() - 60)];
  fake.override = (path, res) => {
    if (!path.startsWith('/v2/markets')) return false;
    json(res, 200, [
      { ticker: 'NVDA', underlying: NVDA, status: 'live', spot: money('220000000'), spotUpdatedAt: now() },
      { ticker: 'TSLA', underlying: NVDA, status: 'live', spot: null, spotUpdatedAt: null },
    ]);
    return true;
  };
  const result = await engine().runOnce();
  assert.equal(result.queued, 1);
  assert.ok(!log.lines.some((line) => line.includes('market spots unavailable')));
});

test('the loop survives an outage: logs a code, backs off, recovers', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.items = [fillItem(1, now() - 60)];
  let failures = 3;
  fake.override = (path, res) => {
    if (!path.startsWith('/v2/feed/activity') || failures === 0) return false;
    failures -= 1;
    json(res, 503, { error: { code: 'degraded', message: '' } });
    return true;
  };
  const rules = engine({ pollMs: 5, maxBackoffMs: 20 });
  assert.equal(rules.health().status, 'starting');
  rules.start();
  try {
    for (let i = 0; i < 600 && (await keys()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  } finally {
    await rules.stop();
  }
  assert.equal((await keys()).length, 1);
  assert.equal(rules.health().status, 'ok');
  const failed = log.lines.filter((l) => l.includes('"msg":"rules tick failed"'));
  assert.equal(failed.length, 3);
  assert.ok(failed.every((l) => l.includes('"errorCode":"http_503"') && l.includes('"route":"activity"')), failed.join('\n'));
  assert.deepEqual(failed.map((l) => (JSON.parse(l) as { retryInMs: number }).retryInMs), [5, 10, 20]);
  assert.equal(backoffMs(1, 30_000, 300_000), 30_000);
  assert.equal(backoffMs(3, 30_000, 300_000), 120_000);
  assert.equal(backoffMs(9, 30_000, 300_000), 300_000);
});

test('paging: when a tick runs out of pages it resumes from the indexer cursor', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.items = [fillItem(1, now() - 90), fillItem(2, now() - 60), fillItem(3, now() - 30)];
  const rules = engine({ pageLimit: 1, maxPages: 2 });

  assert.equal((await rules.runOnce()).queued, 2);
  assert.deepEqual(activityQueries().map((q) => q.get('cursor')), [null, '1']);
  fake.server.requests.length = 0;
  assert.equal((await rules.runOnce()).queued, 1);
  assert.deepEqual(activityQueries().map((q) => q.get('cursor')), ['2'], 'resumed where the budget ran out');
  fake.server.requests.length = 0;
  assert.equal((await rules.runOnce()).queued, 0);
  assert.equal(activityQueries()[0]?.get('cursor'), null);
  assert.equal((await keys()).length, 3);
});

test('a redemption receipt carries the cost of the long it burned and its own settlement price, with no series read; a failed positions read is not fatal', async () => {
  await subscribe(ALICE);
  await subscribe(BOB); // no positions fixture: every read 404s
  fake.positions[ALICE] = positionsBody({ longs: [{ longId: L216, units: '40', avgCost: '1250000', status: 'expired' }] });
  const seen = await engine().runOnce();
  assert.deepEqual([seen.refreshed, seen.refreshFailed], [1, 1]);
  assert.ok(log.lines.some((l) => l.includes('"refreshErrors":{"http_404":1}')));

  clock.advance(60_000);
  fake.positions[ALICE] = positionsBody();
  fake.items = [redemptionItem(7, now() - 20)];
  const redeemed = await engine().runOnce();
  assert.equal(redeemed.byKind.settlement_receipt, 1);
  const { rows } = await db.query<{ payload: { cost: { raw: string }; settlementPrice: { raw: string }; payout: { asset: string } } }>(
    `SELECT payload FROM notifier.delivery WHERE kind = 'settlement_receipt'`,
  );
  assert.deepEqual([rows[0]?.payload.cost.raw, rows[0]?.payload.settlementPrice.raw, rows[0]?.payload.payout.asset], ['500000', '219400000', 'usdg']);

  clock.advance(30_000);
  fake.items.push(redemptionItem(8, now() - 5, { side: 'short', amount: '4000000' }));
  const short = await engine().runOnce();
  assert.equal(short.byKind.settlement_receipt, 1);
  assert.deepEqual(fake.paths().filter((p) => p.startsWith('/v2/series/')), [], 'the redemption carries settlementPrice');
});

test('a settled long that is never redeemed: its settlement is read once, at the transition, however old, and it is not a worthless receipt when it paid', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody({ longs: [{ longId: L216, units: '100', avgCost: '275000', status: 'settled' }] });
  fake.series[L216] = {
    series: series(L216, { status: 'settled' }),
    settlement: { status: 'Finalized', price: money('219400000'), longPayoutPerUnit: money('57429352780310', 18), finalizedAt: now() - 30 * 24 * HOUR },
  };
  const rules = engine({ holdingsRefreshS: 0 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await rules.runOnce()).requests, 0);
    clock.advance(30_000);
  }
  assert.equal(fake.paths().filter((p) => p === `/v2/series/${L216}`).length, 1);
  assert.equal(fake.paths().filter((p) => p.endsWith('/positions')).length, 3, 'refreshed every tick at holdingsRefreshS 0');
});

test('a stale_cancel item tells the writer its auto-roll ask was withdrawn, once (INTERFACE_VERSION 7)', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  const at = now() - 45;
  const cancel = staleCancelItem(11, at);
  fake.items = [cancel];

  const result = await engine().runOnce();
  assert.deepEqual([result.items, result.stale, result.queued], [1, 0, 1]);
  assert.deepEqual(result.byKind, { auto_roll: 1 });
  assert.deepEqual(await keys(), [`auto_roll:${ALICE}:${L221}:withdrawn-${cancel.id}`], 'keyed on the item, to the writer only');

  const { rows } = await db.query<{ payload: unknown }>(`SELECT payload FROM notifier.delivery WHERE kind = 'auto_roll'`);
  assert.deepEqual(rows[0]?.payload, {
    ticker: 'NVDA',
    status: 'withdrawn',
    series: { longId: L221, ticker: 'NVDA', isPut: false, strike: { raw: '221000000', decimals: 6 }, expiry: EXPIRY },
    spot: { raw: '223400000', decimals: 6 },
    spotUpdatedAt: at - 30,
    nextRollAfter: EXPIRY,
  });

  // The lookback re-reads the same page next tick: the seen ids make that no second message.
  clock.advance(30_000);
  const again = await engine().runOnce();
  assert.deepEqual([again.items, again.queued], [0, 0]);
  assert.equal((await keys()).length, 1);
});

test('state survives a restart: a strike side and a price alert seen before it make their events after it', async () => {
  await subscribe(ALICE, prefsSchema.parse({ priceAlerts: [{ ticker: 'NVDA', above: '221500000' }] }));
  fake.positions[ALICE] = positionsBody({ longs: [{ longId: L221, units: '50', avgCost: '3800000' }] });
  fake.spot = '220000000';
  assert.equal((await engine().runOnce()).requests, 0, 'first sight: a side, not a crossing');

  clock.advance(30_000);
  fake.spot = '222000000';
  const crossed = await engine().runOnce();
  assert.deepEqual(crossed.byKind, { strike_cross: 1, price_alert: 1 });

  // Both price-driven payloads carry /v2/markets' own spotUpdatedAt, never the tick's clock.
  const priced = await db.query<{ kind: string; payload: { spotUpdatedAt?: number } }>(
    `SELECT kind, payload FROM notifier.delivery ORDER BY kind`,
  );
  assert.deepEqual(priced.rows.map((r) => [r.kind, r.payload.spotUpdatedAt]), [
    ['price_alert', 1789589112],
    ['strike_cross', 1789589112],
  ]);
  assert.notEqual(1789589112, now(), 'the observation time is the market’s, not the tick’s');

  clock.advance(30_000);
  assert.equal((await engine().runOnce()).requests, 0, 'nothing new while it stays there');
});

test('unreadable stored state starts afresh; a wallet that leaves the watch set loses its holdings row', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  await db.query(`INSERT INTO notifier.rules_state (name, value, updated_at) VALUES ('cursor', '{"since":"soon"}', now())`);
  await db.query(`INSERT INTO notifier.rules_holdings (address, holdings, fetched_at) VALUES ($1, '{"longs":1}', now())`, [CAROL]);
  const result = await engine().runOnce();
  assert.equal(result.refreshed, 1);
  assert.ok(log.lines.some((l) => l.includes('"msg":"rules state unreadable, starting it afresh"')));
  const { rows } = await db.query<{ address: string }>('SELECT address FROM notifier.rules_holdings');
  assert.deepEqual(rows.map((r) => r.address), [ALICE]);

  await db.query('UPDATE notifier.subscription SET disabled_at = now()');
  await engine().runOnce();
  assert.equal((await db.query('SELECT 1 FROM notifier.rules_holdings')).rows.length, 0);
});

test('migration 002 is idempotent', async () => {
  assert.deepEqual(await migrate(db), []);
  const sql = readFileSync(`${MIGRATIONS_DIR}002_rules.sql`, 'utf8');
  await db.transaction(async (tx) => {
    await tx.exec(sql);
    await tx.exec(sql);
  });
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM notifier.migration ORDER BY name`);
  assert.deepEqual(rows.map((r) => r.name), ['001_init.sql', '002_rules.sql', '003_abuse_bounds.sql', '004_telegram_link_address.sql', '005_email_suppression.sql']);
});

test('auto_roll skipped: calendar days read in 62-day blocks and cached; a Monday holiday moves the warning to Wednesday; once', async () => {
  await subscribe(ALICE);
  const friday = Date.parse('2026-09-18T20:00:00Z') / 1000;
  const lastRolledAt = Date.parse('2026-09-14T13:35:00Z') / 1000;
  fake.positions[ALICE] = positionsBody({ strategies: [{ longId: '3000', expiry: friday, lastRolledAt }] });
  fake.holidays = new Set([20717]); // Mon 21 Sep 2026
  clock.ms = Date.parse('2026-09-22T13:31:00Z'); // weekdays alone: a day overdue
  const rules = engine();

  const tuesday = await rules.runOnce();
  assert.deepEqual([tuesday.calendarRead, tuesday.calendarFailed, tuesday.requests], [1, 0, 0], 'due Tuesday 09:30, not overdue');
  assert.deepEqual(calendarQueries(), [['20708', '20769']], 'the 62-day block holding Sat 19 Sep');
  clock.advance(30_000);
  assert.equal((await rules.runOnce()).calendarRead, 0);
  assert.equal(calendarQueries().length, 1, 'cached');

  clock.ms = Date.parse('2026-09-23T13:31:00Z');
  const wednesday = await rules.runOnce();
  assert.deepEqual([wednesday.calendarRead, wednesday.byKind.auto_roll], [1, 1], 'read again after calendarRefreshS; warned');
  const { rows } = await db.query<{ dedupe_key: string; payload: unknown }>(`SELECT dedupe_key, payload FROM notifier.delivery WHERE kind = 'auto_roll'`);
  assert.deepEqual(rows, [
    { dedupe_key: `auto_roll:${ALICE}:3000:skipped`, payload: { ticker: 'NVDA', status: 'skipped', dueAt: Date.parse('2026-09-22T13:30:00Z') / 1000, lastRolledAt } },
  ]);
  clock.advance(30_000);
  assert.equal((await engine().runOnce()).requests, 0, 'once, also across a restart');
});

test('a calendar that cannot be read: the tick still delivers, the warning waits for the days, a stale block is used over none', async () => {
  await subscribe(ALICE);
  clock.ms = Date.parse('2026-09-23T13:31:00Z'); // no holiday: due Mon 21 Sep, overdue since Tue
  fake.positions[ALICE] = positionsBody({ strategies: [{ longId: '3000', expiry: Date.parse('2026-09-18T20:00:00Z') / 1000, lastRolledAt: null }] });
  fake.items = [fillItem(1, now() - 60)];
  let calendarDown = true;
  fake.override = (path, res) => {
    if (!path.startsWith('/v2/calendar/holidays') || !calendarDown) return false;
    json(res, 503, { error: { code: 'degraded', message: '' } });
    return true;
  };
  const rules = engine();
  const down = await rules.runOnce();
  assert.deepEqual([down.calendarFailed, down.byKind], [1, { fill_receipt: 1 }]);
  assert.ok(log.lines.some((l) => l.includes('"calendarErrors":{"http_503":1}')));

  calendarDown = false;
  clock.advance(30_000);
  const up = await rules.runOnce();
  assert.deepEqual([up.calendarRead, up.byKind], [1, { auto_roll: 1 }], 'late, not lost');

  calendarDown = true;
  clock.advance(2 * HOUR * 1000);
  const stale = await rules.runOnce();
  assert.deepEqual([stale.calendarFailed, stale.requests], [1, 0]);
  const { rows } = await db.query<{ value: { sessionDays: Record<string, boolean> } }>(`SELECT value FROM notifier.rules_state WHERE name = 'snapshot'`);
  assert.deepEqual(rows[0]?.value.sessionDays, { '20715': false, '20716': false, '20717': true }, 'the stale block still answered');
});

test('a changed /v2/config anchor drops the cursor back to the storm-guard floor', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.items = [fillItem(1, now() - 120)];
  await engine().runOnce();
  fake.config = { chainId: 1, interfaceVersion: 8, deployBlock: '99' };
  fake.server.requests.length = 0;
  fake.items = [fillItem(2, now() - 10)];
  await engine().runOnce();
  assert.equal(activityQueries().at(-1)?.get('since'), String(now() - 6 * HOUR - 60), 'cutover re-reads from now − 6 h');
  assert.ok(log.lines.some((l) => l.includes('deployment anchor changed') && l.includes('1:8:1') && l.includes('1:8:99')));
});

test('a failed /v2/config read leaves the cursor and stored anchor', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.items = [fillItem(1, now() - 120)];
  await engine().runOnce();
  fake.override = (path, res) => {
    if (path !== '/v2/config') return false;
    json(res, 503, { error: { code: 'degraded', message: '' } });
    return true;
  };
  fake.server.requests.length = 0;
  await engine().runOnce();
  assert.equal(activityQueries()[0]?.get('since'), String((now() - 120) - 60));
  const { rows } = await db.query<{ value: unknown }>(`SELECT value FROM notifier.rules_state WHERE name = 'anchor'`);
  assert.equal(rows[0]?.value, '1:8:1');
  assert.ok(log.lines.some((l) => l.includes('config unavailable')));
});

/* ------------------------------------------------------------------ K8-231 interface-version pin */

test('a /v2/config interface version this build does not implement fails the tick CLOSED', async () => {
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.items = [fillItem(1, now() - 120)];
  fake.config = { chainId: 1, interfaceVersion: IMPLEMENTED_INTERFACE_VERSION + 1, deployBlock: '1' };
  fake.server.requests.length = 0;

  await assert.rejects(
    engine().runOnce(),
    (error: unknown) =>
      error instanceof InterfaceVersionError
      && error instanceof IndexerError
      && error.route === '/v2/config'
      && error.code === 'interface-version-unsupported'
      && error.observed === IMPLEMENTED_INTERFACE_VERSION + 1
      && error.implemented === IMPLEMENTED_INTERFACE_VERSION,
    'the tick rejects with a routed, coded indexer error the run loop can log',
  );

  // CLOSED, not merely loud. Each of these would still hold if the check only logged, EXCEPT the
  // route list: that is the one that says the tick stopped rather than carried on degraded.
  assert.deepEqual(fake.paths(), ['/v2/config'], 'no route is read after the version check');
  assert.deepEqual(await keys(), [], 'nothing is enqueued from an interface this build cannot decode');
  assert.deepEqual(sent, [], 'and nothing is delivered');
  const { rows } = await db.query<{ name: string }>('SELECT name FROM notifier.rules_state ORDER BY name');
  assert.deepEqual(rows, [], 'nothing is persisted, so the next tick starts from the same place');
});

test('a v7 indexer under the SAME deployment anchor is refused: the anchor cannot see the version', async () => {
  // The gap this row closes. `deploymentAnchor` concatenates the version, so it changes only when
  // the DEPLOYMENT changes; a v7 indexer serving the chain and deploy block this build already
  // recorded produces a different anchor string but no refusal, and before the pin the tick simply
  // decoded v7 payloads with v8 expectations. Here the stored anchor is written by a good tick
  // first, so the refusal below is the version check firing and not a cutover reset.
  await subscribe(ALICE);
  fake.positions[ALICE] = positionsBody();
  fake.items = [fillItem(1, now() - 120)];
  await engine().runOnce();
  const beforeState = await db.query<{ name: string; value: unknown }>('SELECT name, value FROM notifier.rules_state ORDER BY name');

  fake.config = { chainId: 1, interfaceVersion: 7, deployBlock: '1' };
  fake.items = [fillItem(2, now() - 10)];
  fake.server.requests.length = 0;
  sent.length = 0;

  await assert.rejects(engine().runOnce(), (error: unknown) => error instanceof InterfaceVersionError && error.observed === 7);
  assert.deepEqual(fake.paths(), ['/v2/config']);
  const afterState = await db.query<{ name: string; value: unknown }>('SELECT name, value FROM notifier.rules_state ORDER BY name');
  assert.deepEqual(afterState.rows, beforeState.rows, 'the refused tick left every stored row exactly as the good tick wrote it');
});

test('assertInterfaceVersion accepts the pinned version and nothing else', () => {
  const config = (interfaceVersion: number) => ({ chainId: 1, interfaceVersion, deployBlock: '1', fees: undefined, pendingFees: undefined });
  assert.doesNotThrow(() => assertInterfaceVersion(config(IMPLEMENTED_INTERFACE_VERSION)));
  for (const version of [0, 1, 7, 9, 80]) {
    if (version === IMPLEMENTED_INTERFACE_VERSION) continue;
    assert.throws(() => assertInterfaceVersion(config(version)), InterfaceVersionError, `version ${version} must be refused`);
  }
});

/** One /v2/admin/operations row as the indexer serves it (target and caller from ops/fixtures/api/v2/admin/operations.json). */
const adminOperation = (id: string, nonce: number, selector: string | null, label: string) => ({
  key: `${id}:${nonce}`,
  id,
  role: 'CONFIG_ADMIN',
  target: '0x301b1e55217f139123D276B8298284EA2B704ca8',
  selector,
  label,
  caller: '0x31D35771AaE6676aE6DFb4EdF2399D6115b3Af14',
  scheduledAt: 1789588800,
  readyAt: 1789675200,
  status: 'pending',
});

test('T-435: a page holding one selector-less operation still delivers EVERY operation on it', async () => {
  // The wire declares `selector` nullable and the indexer serves a selector-less operation on
  // purpose. The notifier parses the page as one array, so a copy that required a string lost the
  // whole page: 'admin operations unavailable', the stored operations kept, nothing announced - the
  // ordinary operation beside it included. That second operation arriving is the assertion that
  // matters, because it is what shows the blast radius was the page and not the row.
  await subscribe(ALICE, prefsSchema.parse({ adminOperation: true }));
  fake.positions[ALICE] = positionsBody();
  await engine().runOnce(); // first boot records and announces nothing

  const ordinary = adminOperation(`0x${'11'.repeat(32)}`, 1, '0xc44014d2', 'Clearinghouse.setDefaultOracle(address)');
  const selectorLess = adminOperation(`0x${'22'.repeat(32)}`, 1, null, 'Clearinghouse.fallback()');
  fake.operations = [selectorLess, ordinary];
  clock.advance(30_000);
  await engine().runOnce();

  assert.deepEqual(
    (await keys()).filter((k) => k.startsWith('admin_operation:')).sort(),
    [`admin_operation:${ALICE}:${ordinary.key}:pending`, `admin_operation:${ALICE}:${selectorLess.key}:pending`].sort(),
    'both operations are announced, each under its own key',
  );
  assert.equal(log.lines.some((l) => l.includes('admin operations unavailable')), false, 'the page parsed');
});
