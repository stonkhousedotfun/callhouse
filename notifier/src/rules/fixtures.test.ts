/**
 * End to end, standing in for the plan's devnet gate until F2-04 exists: the whole notifier
 * (startNotifier, listening, every loop running) polls ops/fixtures/serve-v2.mjs, the static
 * indexer API v2 fixture server, spawned on a free port, and delivers to a fake Telegram Bot API
 * (TELEGRAM_API_BASE override).
 *
 * The fixtures are one frozen scenario ("now" = Wed 16 Sep 2026 21:00Z). The clock is set to
 * Mon 14 Sep 13:40Z, five minutes after writer.roller's roll, so the storm guard lets through that
 * morning's short redemption and roll and the later fills. Three wallets are linked:
 *   writer.roller           a maker fill (fill_receipt), its short redemption (settlement_receipt,
 *                           priced by the redemption's settlementPrice), the roll
 *   buyer.sam               two taker buys (fill_receipt)
 *   writer.manual.treasury  the recipient of writer.manual's sale into a bid (interface v4
 *                           data.recipient): a proceeds receipt, though it is neither taker nor maker
 * and every message must arrive exactly once, while the server keeps answering the same feed.
 *
 * Then the clock moves past the roller's next roll: its series expired Fri 18 Sep, and the fixture
 * calendar (GET /v2/calendar/holidays) closes Mon 21 Sep, so the roll is due Tue 22 Sep 09:30 and
 * the skipped warning, with the strategy's lastRolledAt, comes Wednesday, not Tuesday.
 *
 * The notifier's zod mirrors (indexer.ts) also parse the fixture files directly, and refuse them
 * without the v4 fields.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { startNotifier, type RunningNotifier } from '../app.js';
import { createTargetCipher } from '../crypto.js';
import { prefsSchema } from '../prefs.js';
import { linkTelegramChat } from '../store.js';
import { captureLogger, createTestDb, json, startFakeServer, TEST_BOT_TOKEN, TEST_DATA_KEY_HEX, testConfig, TestClock, type FakeServer, type Recorded, type TestDb } from '../testing.js';
import { activityItemSchema, activityPageSchema, calendarSchema, marketsSchema, positionsSchema, seriesDetailSchema } from './indexer.js';

const ROLLER = '0xD6b49a27Ead99118b61F0827C7aB2782aea07bE6';
const SAM = '0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';
const TREASURY = '0xF9806B161b1d09106C63E25907F50B4a93EF8fda';
const ROLLER_CHAT = 5550001;
const SAM_CHAT = 5550002;
const TREASURY_CHAT = 5550003;
const SERVE = fileURLToPath(new URL('../../../ops/fixtures/serve-v2.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../ops/fixtures/api/v2/', import.meta.url));
/** A fixture file as JSON, loosely typed so a test can delete a field before parsing. */
const fixture = (path: string): any => JSON.parse(readFileSync(`${FIXTURES}${path}`, 'utf8'));

let fixtures: ChildProcess;
let fixturesUrl: string;
let telegram: FakeServer;
let db: TestDb;
let notifier: RunningNotifier | null = null;
const log = captureLogger();
const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));

function telegramHandler(req: Recorded, res: ServerResponse): void {
  const method = /^\/bot([^/]+)\/(\w+)$/.exec(req.path);
  if (method === null || method[1] !== TEST_BOT_TOKEN) return json(res, 404, { ok: false });
  if (method[2] === 'getMe') return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'stonkhouse_test_bot' } });
  // A short long-poll, so the bot's loop does not spin.
  if (method[2] === 'getUpdates') return void setTimeout(() => json(res, 200, { ok: true, result: [] }), 100);
  if (method[2] === 'sendMessage') return json(res, 200, { ok: true, result: { message_id: 1 } });
  return json(res, 404, { ok: false });
}

function messages(chat: number): string[] {
  return telegram.requests
    .filter((r) => r.path.endsWith('/sendMessage'))
    .map((r) => JSON.parse(r.body.toString('utf8')) as { chat_id: string; text: string })
    .filter((m) => m.chat_id === String(chat))
    .map((m) => m.text);
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

before(async () => {
  fixtures = spawn(process.execPath, [SERVE, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  fixturesUrl = await new Promise<string>((resolve, reject) => {
    let out = '';
    fixtures.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /http:\/\/localhost:(\d+)\/v2/.exec(out);
      if (match !== null) resolve(`http://127.0.0.1:${match[1]}`);
    });
    fixtures.once('exit', (code) => reject(new Error(`serve-v2.mjs exited with ${code}`)));
  });
  telegram = await startFakeServer(telegramHandler);
  db = await createTestDb();
});

after(async () => {
  await notifier?.close();
  await telegram.close();
  fixtures.kill('SIGTERM');
  const text = log.lines.join('\n');
  for (const secret of [ROLLER, SAM, TREASURY, ROLLER.toLowerCase(), SAM.toLowerCase(), TREASURY.toLowerCase(), TEST_BOT_TOKEN, String(ROLLER_CHAT)]) {
    assert.ok(!text.includes(secret), `log output leaked ${secret}`);
  }
});

test('the notifier’s API mirrors parse the committed fixtures and require the interface v4 fields', () => {
  const activity = activityPageSchema.parse(fixture('feed/activity.json'));
  const sale = activity.items.find((i) => i.kind === 'fill' && !i.data.takerIsBuyer && i.data.recipient !== i.data.taker);
  assert.ok(sale?.kind === 'fill' && sale.data.recipient === TREASURY && sale.accounts.includes(TREASURY), 'a sale into a bid paid to a third wallet');
  const redemptions = activity.items.filter((i) => i.kind === 'redemption');
  assert.ok(redemptions.length > 0 && redemptions.every((r) => r.kind === 'redemption' && r.data.settlementPrice.raw === '219400000'));
  assert.equal(positionsSchema.parse(fixture(`accounts/${ROLLER}/positions.json`)).strategies[0]?.lastRolledAt, Date.parse('2026-09-14T13:35:00Z') / 1000);
  positionsSchema.parse(fixture(`accounts/${SAM}/positions.json`));
  const markets = marketsSchema.parse(fixture('markets.json'));
  assert.equal(marketsSchema.safeParse([{ ...markets[0], spot: null, spotUpdatedAt: null }]).success, true,
    'one market can have an unavailable oracle spot');
  assert.equal(marketsSchema.safeParse([{ ...markets[0], spot: null }]).success, false,
    'spot and timestamp availability must match');
  for (const name of readdirSync(`${FIXTURES}series`).filter((n) => n.endsWith('.json'))) seriesDetailSchema.parse(fixture(`series/${name}`));
  const calendar = calendarSchema.parse(fixture('calendar/holidays.json'));
  assert.deepEqual(calendar.items.filter((d) => d.isHoliday), [{ dayIndex: 20717, isHoliday: true, isSessionDay: false }], 'Mon 21 Sep');

  const without = (path: string, pick: (body: any) => any, key: string) => {
    const body = fixture(path);
    delete pick(body)[key];
    return body;
  };
  const firstOf = (kind: string) => (body: { items: { kind: string; data: object }[] }) => body.items.find((i) => i.kind === kind)?.data;
  assert.equal(activityPageSchema.safeParse(without('feed/activity.json', firstOf('fill'), 'recipient')).success, false, 'recipient is required');
  assert.equal(activityPageSchema.safeParse(without('feed/activity.json', firstOf('redemption'), 'settlementPrice')).success, false, 'settlementPrice is required');
  assert.equal(positionsSchema.safeParse(without(`accounts/${ROLLER}/positions.json`, (b) => b.strategies[0], 'lastRolledAt')).success, false, 'lastRolledAt is required (nullable)');
  assert.equal(calendarSchema.safeParse(without('calendar/holidays.json', (b) => b.items[0], 'isSessionDay')).success, false);
  assert.equal(activityItemSchema.safeParse({ ...sale, data: { ...sale.data, recipient: TREASURY.toLowerCase() } }).success, false, 'checksummed');

  // INTERFACE_VERSION 7: the indexer's feed gained a `stale_cancel` item (indexer/src/api/v2/schema.ts
  // activityStaleCancelSchema). The item list is a discriminated union with no catch-all, so a kind the
  // mirror does not know fails the whole PAGE, not just that row, and every receipt in it stops. That is
  // the regression this pins: `stale_cancel` parses, an unknown kind still does not.
  const staleCancel = {
    id: `${'0x' + 'cd'.repeat(32)}-4`,
    ts: Date.parse('2026-09-14T13:40:00Z') / 1000,
    kind: 'stale_cancel',
    longId: activity.items[0]!.longId,
    series: activity.items[0]!.series,
    accounts: [ROLLER],
    data: {
      writer: ROLLER,
      orderId: '1009',
      spot: { raw: '223400000', decimals: 6, formatted: '223.4' },
      spotUpdatedAt: Date.parse('2026-09-14T13:40:00Z') / 1000,
      nextRollAfter: activity.items[0]!.series.expiry,
      tx: `0x${'cd'.repeat(32)}`,
    },
  };
  const parsed = activityItemSchema.parse(staleCancel);
  assert.equal(parsed.kind === 'stale_cancel' && parsed.data.writer, ROLLER);
  assert.equal(activityPageSchema.safeParse({ items: [...fixture('feed/activity.json').items, staleCancel], nextCursor: null }).success, true,
    'a page carrying a stale cancellation still parses');
  assert.equal(activityPageSchema.safeParse({ items: [{ ...staleCancel, kind: 'not_a_kind' }], nextCursor: null }).success, false,
    'an unknown item kind still fails the page: the mirror must track the indexer');
});

test('the notifier polls the v2 fixture server and delivers fill and settlement receipts to Telegram, once each; then a holiday-aware auto-roll warning', async () => {
  const clock = new TestClock(Date.parse('2026-09-14T13:40:00Z'));
  for (const [address, chat] of [
    [ROLLER, ROLLER_CHAT],
    [SAM, SAM_CHAT],
    [TREASURY, TREASURY_CHAT],
  ] as const) {
    await linkTelegramChat(db, {
      address,
      targetEnc: cipher.encrypt(String(chat), `telegram:${address}`),
      targetHash: cipher.hash(`telegram:${chat}`),
      defaultPrefs: prefsSchema.parse({}),
      now: clock.now(),
    });
  }

  notifier = await startNotifier(testConfig({ INDEXER_URL: fixturesUrl, TELEGRAM_API_BASE: telegram.url, PORT: '0' }), {
    db,
    now: clock.now,
    logger: log.logger,
    telegramPollTimeoutS: 0,
    rules: { pollMs: 50 },
    delivery: { pollMs: 50 },
  });
  assert.ok(notifier.rules !== null);

  const roller = () => messages(ROLLER_CHAT);
  await until(
    () => roller().some((m) => m.startsWith('Sold NVDA 227.00 call')) && roller().some((m) => m.startsWith('The NVDA 216.00 call you wrote settled')),
    'the roller’s fill and settlement receipts',
  );
  await until(() => messages(SAM_CHAT).length >= 2, 'sam’s fill receipts');
  await until(() => messages(TREASURY_CHAT).length >= 1, 'the treasury’s proceeds receipt');
  // Let several more ticks (50 ms apart) read the same feed: nothing is enqueued or delivered twice.
  await new Promise((r) => setTimeout(r, 500));

  const fill = roller().find((m) => m.startsWith('Sold NVDA 227.00 call'));
  assert.match(fill ?? '', /You wrote and sold 0\.60 shares of the NVDA 227\.00 call expiring Fri 18 Sep, 4:00pm EDT, at 0\.26 USDG per share\./);
  // INTERFACE_VERSION 7: premiumFeeBps is 0, so the maker keeps the whole premium (60 units at
  // 0.2601 = 0.15606 USDG) and the seller fee line reads 0.00 because there is no seller fee at all.
  assert.match(fill ?? '', /Received: 0\.15 USDG, after 0\.00 USDG in fees\./);

  const settlement = roller().find((m) => m.startsWith('The NVDA 216.00 call you wrote settled'));
  assert.match(settlement ?? '', /settled at 219\.40 USDG\./);
  assert.match(settlement ?? '', /Returned to you: 1\.9690 NVDA Stock Tokens of collateral, held in your Stonkhouse balance\./);

  assert.deepEqual(
    roller().map((m) => m.split('\n')[0]).sort(),
    ['Auto-roll listed your next NVDA call', 'Sold NVDA 227.00 call', 'The NVDA 216.00 call you wrote settled'],
  );
  assert.deepEqual(messages(SAM_CHAT).map((m) => m.split('\n')[0]).sort(), ['Bought NVDA 215.00 call', 'Bought NVDA 222.00 call']);
  assert.ok(messages(SAM_CHAT).every((m) => /Max loss: \d+\.\d\d USDG/.test(m)));
  assert.deepEqual(messages(TREASURY_CHAT).map((m) => m.split('\n').filter((line) => line !== '').slice(0, 3).join('\n')), [
    [
      'Received sale proceeds: NVDA 216.00 call',
      'Wallet 0x7055…3Ff9 sold 0.50 shares of the NVDA 216.00 call expiring Thu 17 Sep, 4:00pm EDT, at 1.60 USDG per share, and the proceeds were paid to your wallet.',
      // v7: premium 0.8006 less the 0.08006 taker fee only; the seller fee is 0.
      'Received: 0.72 USDG, after 0.08 USDG in fees.',
    ].join('\n'),
  ]);

  const kinds = async () =>
    (await db.query<{ kind: string; status: string }>('SELECT kind, status FROM notifier.delivery ORDER BY kind')).rows.map((r) => `${r.kind}:${r.status}`);
  assert.deepEqual(await kinds(), ['auto_roll:sent', 'fill_receipt:sent', 'fill_receipt:sent', 'fill_receipt:sent', 'fill_receipt:sent', 'settlement_receipt:sent']);
  assert.equal(notifier.rules.health().status, 'ok');

  // Tuesday 09:31 New York: a day after a weekdays-only due date, but Monday was a holiday.
  clock.ms = Date.parse('2026-09-22T13:31:00Z');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!roller().some((m) => m.startsWith('Auto-roll has not rolled')), 'not on Tuesday');
  // Wednesday 09:31: 24 h after Tuesday's open.
  clock.ms = Date.parse('2026-09-23T13:31:00Z');
  await until(() => roller().some((m) => m.startsWith('Auto-roll has not rolled')), 'the roller’s skipped warning');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(roller().filter((m) => m.startsWith('Auto-roll has not rolled')).map((m) => m.split('\n').filter((line) => line !== '').slice(0, 3).join('\n')), [
    [
      'Auto-roll has not rolled your NVDA position',
      'Auto-roll has not rolled your NVDA position. The roll was due when the session opened Tue 22 Sep, 9:30am EDT, more than 24 hours ago.',
      'Last roll: Mon 14 Sep, 9:35am EDT.',
    ].join('\n'),
  ]);
  assert.deepEqual(await kinds(), ['auto_roll:sent', 'auto_roll:sent', 'fill_receipt:sent', 'fill_receipt:sent', 'fill_receipt:sent', 'fill_receipt:sent', 'settlement_receipt:sent']);
  const health = (await (await notifier.app.request('/health')).json()) as { rules: { status: string } };
  assert.equal(health.rules.status, 'ok');
});
