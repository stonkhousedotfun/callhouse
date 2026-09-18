/**
 * Storage: migrations and the upsert rules, on PGlite always and, when NOTIFIER_TEST_DATABASE_URL
 * points at a real Postgres, on that too through the production `pg` adapter (createPgDb). The
 * second run is how the "same SQL, same values from both drivers" rule in db.ts gets checked; CI
 * has no Postgres, so it is opt-in:
 *
 *   NOTIFIER_TEST_DATABASE_URL=postgres://localhost:5432/notifier_test pnpm --filter @callhouse/notifier test
 *
 * The database it points at is written to (schema "notifier" is emptied): never a real one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTargetCipher } from './crypto.js';
import { createPgDb, migrate, type Db } from './db.js';
import { DeliveryService, dedupeKey } from './delivery.js';
import { DEFAULT_PREFS, prefsSchema } from './prefs.js';
import {
  consumeNonce,
  consumeTelegramLink,
  insertNonce,
  insertTelegramLink,
  linkTelegramChat,
  EmailSubscriptionLimitError,
  MAX_EMAIL_SUBSCRIPTIONS_PER_WALLET,
  upsertEmail,
  upsertEmailAndClaimConfirmation,
  upsertTelegramPrefs,
  upsertWebPush,
} from './store.js';
import { loadState, loadWatchSet, saveState } from './rules/store.js';
import { appLinks } from './templates.js';
import { captureLogger, createTestDb, SAMPLE_ADDRESS, SAMPLE_PAYLOADS, SERIES_221, TEST_DATA_KEY_HEX, T0 } from './testing.js';

const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
const now = new Date(T0);

const targets: { name: string; open: () => Promise<Db & { reset(): Promise<void> }> }[] = [
  { name: 'PGlite', open: createTestDb },
];
const pgUrl = process.env.NOTIFIER_TEST_DATABASE_URL;
if (pgUrl !== undefined && pgUrl !== '') {
  targets.push({
    name: 'Postgres (pg adapter)',
    open: async () => {
      const db = createPgDb(pgUrl, captureLogger().logger);
      await db.query('DROP SCHEMA IF EXISTS notifier CASCADE');
      await migrate(db);
      return Object.assign(db, {
        reset: async () => {
          await db.query(
            'TRUNCATE notifier.delivery, notifier.subscription, notifier.nonce, notifier.telegram_link, notifier.rules_state, notifier.rules_holdings, notifier.email_confirmation_budget, notifier.email_suppression',
          );
        },
      });
    },
  });
}

for (const target of targets) {
  describe(`storage on ${target.name}`, () => {
    let db: Db & { reset(): Promise<void> };
    before(async () => {
      db = await target.open();
    });
    after(async () => {
      await db.close();
    });

    test('migrations are recorded and a second run applies nothing', async () => {
      assert.deepEqual(await migrate(db), []);
      const { rows } = await db.query<{ name: string }>('SELECT name FROM notifier.migration ORDER BY name');
      assert.deepEqual(rows.map((r) => r.name), ['001_init.sql', '002_rules.sql', '003_abuse_bounds.sql', '004_telegram_link_address.sql', '005_email_suppression.sql']);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'notifier' ORDER BY table_name`,
      );
      assert.deepEqual(tables.rows.map((r) => r.table_name), ['delivery', 'email_confirmation_budget', 'email_suppression', 'migration', 'nonce', 'rules_holdings', 'rules_state', 'subscription', 'telegram_link']);
    });

    test('values come back with the same JS types', async () => {
      await db.reset();
      const row = await upsertWebPush(db, { address: SAMPLE_ADDRESS, targetEnc: 'v1.a.b.c', targetHash: 'h1', prefs: DEFAULT_PREFS, now });
      assert.equal(row.inserted, true);
      const { rows } = await db.query<{ prefs: unknown; created_at: unknown; n: unknown }>(
        'SELECT prefs, created_at, (SELECT count(*)::int FROM notifier.subscription) AS n FROM notifier.subscription',
      );
      assert.deepEqual(rows[0]?.prefs, DEFAULT_PREFS);
      assert.ok(rows[0]?.created_at instanceof Date);
      assert.equal((rows[0]?.created_at as Date).getTime(), T0);
      assert.equal(rows[0]?.n, 1);
    });

    test('constraints: a non-Telegram row needs a target; one Telegram row per address', async () => {
      await db.reset();
      await assert.rejects(
        db.query(
          `INSERT INTO notifier.subscription (address, channel, prefs, created_at, updated_at) VALUES ($1, 'webpush', '{}', $2::timestamptz, $2::timestamptz)`,
          [SAMPLE_ADDRESS, now],
        ),
      );
      const a = await upsertTelegramPrefs(db, { address: SAMPLE_ADDRESS, prefs: prefsSchema.parse({ fills: false }), now });
      const b = await linkTelegramChat(db, { address: SAMPLE_ADDRESS, targetEnc: 'v1.x.y.z', targetHash: 'chat', defaultPrefs: DEFAULT_PREFS, now });
      assert.deepEqual([a.inserted, b.inserted, b.id], [true, false, a.id]);
    });

    test('email upsert: a disabled row comes back unverified', async () => {
      await db.reset();
      const first = await upsertEmail(db, { address: SAMPLE_ADDRESS, targetEnc: 'v1.a.b.c', targetHash: 'e1', prefs: DEFAULT_PREFS, now });
      await db.query(`UPDATE notifier.subscription SET verified_at = $2::timestamptz, verify_sent_at = $2::timestamptz WHERE id = $1`, [first.id, now]);
      const kept = await upsertEmail(db, { address: SAMPLE_ADDRESS, targetEnc: 'v1.a.b.c', targetHash: 'e1', prefs: DEFAULT_PREFS, now });
      assert.ok(kept.verified_at instanceof Date);
      await db.query(`UPDATE notifier.subscription SET disabled_at = $2::timestamptz WHERE id = $1`, [first.id, now]);
      const reset = await upsertEmail(db, { address: SAMPLE_ADDRESS, targetEnc: 'v1.a.b.c', targetHash: 'e1', prefs: DEFAULT_PREFS, now });
      assert.deepEqual([reset.id, reset.inserted, reset.verified_at, reset.verify_sent_at], [first.id, false, null, null]);
    });

    test('email subscriptions are capped per wallet under the upsert transaction', async () => {
      await db.reset();
      const subscribe = (index: number, address = SAMPLE_ADDRESS, at = now) => upsertEmailAndClaimConfirmation(db, {
        address, targetEnc: `v1.email.${index}`, targetHash: `email-${index}`,
        inboxBudgetHash: `inbox-${index}`, walletBudgetHash: `wallet-${address}`, globalBudgetHash: 'global',
        prefs: prefsSchema.parse({ priceAlerts: [{ ticker: 'NVDA', above: String(1_000 + index) }] }), now: at,
      });
      const ids: string[] = [];
      for (let i = 0; i < MAX_EMAIL_SUBSCRIPTIONS_PER_WALLET; i += 1) {
        const row = await subscribe(i);
        ids.push(row.id);
        await db.query(`UPDATE notifier.subscription SET verified_at = $2::timestamptz WHERE id = $1`, [row.id, now]);
      }
      await assert.rejects(subscribe(100), EmailSubscriptionLimitError);
      assert.equal((await subscribe(0)).id, ids[0], 'updating an enabled row does not spend a slot');
      const other = await subscribe(100, '0xanotherwallet');
      assert.equal(other.inserted, true, 'the limit is wallet scoped');
      let counts = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifier.subscription WHERE address = $1 AND channel = 'email' AND disabled_at IS NULL`,
        [SAMPLE_ADDRESS],
      );
      assert.equal(counts.rows[0]?.n, MAX_EMAIL_SUBSCRIPTIONS_PER_WALLET,
        'a rejected upsert rolls back without adding a pending row');

      await db.query(`UPDATE notifier.subscription SET disabled_at = $2::timestamptz WHERE id = $1`, [ids[0], now]);
      const replacement = await subscribe(100, SAMPLE_ADDRESS, new Date(now.getTime() + 86_400_000));
      assert.equal(replacement.inserted, true, 'a disabled row releases its slot');
      await db.query(`UPDATE notifier.subscription SET verified_at = $2::timestamptz WHERE id = $1`, [replacement.id, now]);
      await assert.rejects(subscribe(0), EmailSubscriptionLimitError,
        're-enabling a disabled row must respect the cap');
      counts = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifier.subscription WHERE address = $1 AND channel = 'email' AND disabled_at IS NULL`,
        [SAMPLE_ADDRESS],
      );
      assert.equal(counts.rows[0]?.n, MAX_EMAIL_SUBSCRIPTIONS_PER_WALLET);
      const watch = await loadWatchSet(db);
      assert.equal(watch.alerts[SAMPLE_ADDRESS]?.length, MAX_EMAIL_SUBSCRIPTIONS_PER_WALLET);
    });

    test('the watch set unions repeated alerts while retaining input order', async () => {
      await db.reset();
      const prefs = prefsSchema.parse({ priceAlerts: [
        { ticker: 'NVDA', above: '1000', below: '900' },
        { ticker: 'NVDA', above: '1000' },
      ] });
      for (let i = 0; i < 3; i += 1) {
        const row = await upsertEmailAndClaimConfirmation(db, {
          address: SAMPLE_ADDRESS, targetEnc: `v1.email.${i}`, targetHash: `union-${i}`,
          inboxBudgetHash: `inbox-union-${i}`, walletBudgetHash: `wallet-${SAMPLE_ADDRESS}`, globalBudgetHash: 'global', prefs, now,
        });
        await db.query(`UPDATE notifier.subscription SET verified_at = $2::timestamptz WHERE id = $1`, [row.id, now]);
      }
      assert.deepEqual((await loadWatchSet(db)).alerts[SAMPLE_ADDRESS], [
        { ticker: 'NVDA', direction: 'above', threshold: '1000' },
        { ticker: 'NVDA', direction: 'below', threshold: '900' },
      ]);
    });

    test('nonces and links are single-use', async () => {
      await db.reset();
      await insertNonce(db, { nonce: 'a'.repeat(32), address: SAMPLE_ADDRESS, message: 'm', now, expiresAt: new Date(T0 + 1000) });
      assert.equal(await consumeNonce(db, 'a'.repeat(32), SAMPLE_ADDRESS, now), 'm');
      assert.equal(await consumeNonce(db, 'a'.repeat(32), SAMPLE_ADDRESS, now), null);
      await insertTelegramLink(db, { tokenHash: 't', address: SAMPLE_ADDRESS, now, expiresAt: new Date(T0 + 1000) });
      assert.equal(await consumeTelegramLink(db, 't', now), SAMPLE_ADDRESS);
      assert.equal(await consumeTelegramLink(db, 't', now), null);
    });

    test('the delivery claim query runs (UPDATE … FROM with FOR UPDATE SKIP LOCKED)', async () => {
      await db.reset();
      await linkTelegramChat(db, {
        address: SAMPLE_ADDRESS,
        targetEnc: cipher.encrypt('-1001', `telegram:${SAMPLE_ADDRESS}`),
        targetHash: cipher.hash('telegram:-1001'),
        defaultPrefs: DEFAULT_PREFS,
        now,
      });
      const sent: string[] = [];
      const delivery = new DeliveryService({
        db,
        cipher,
        links: appLinks('https://app.stonkhouse.test'),
        logger: captureLogger().logger,
        now: () => now,
        channels: { telegram: { name: 'telegram', send: async (to) => (sent.push(to), { ok: true }) } },
      });
      const key = dedupeKey('fill_receipt', SAMPLE_ADDRESS, SERIES_221.longId, 1);
      assert.equal((await delivery.enqueue('fill_receipt', SAMPLE_ADDRESS, SAMPLE_PAYLOADS.fill_receipt, key)).queued, 1);
      assert.equal(await delivery.runOnce(), 1);
      assert.deepEqual(sent, ['-1001']);
    });

    test('rules state round-trips: cursor and snapshot jsonb, holdings rows, the watch set and its price alerts', async () => {
      await db.reset();
      await upsertWebPush(db, {
        address: SAMPLE_ADDRESS,
        targetEnc: 'v1.a.b.c',
        targetHash: 'h1',
        prefs: prefsSchema.parse({ priceAlerts: [{ ticker: 'NVDA', above: '225000000', below: '210000000' }] }),
        now,
      });
      const logger = captureLogger().logger;
      const holdings = {
        fetchedAt: T0 / 1000,
        longs: [],
        shorts: [],
        strategies: [{ ticker: 'NVDA', active: true, currentSeries: null, lastRolledAt: T0 / 1000 - 3600 }],
        prefs: { inKind: false, toLedger: true },
        lastKnownLongs: { '123': { units: '40', avgCost: '1250000', seenAt: T0 / 1000 } },
      };
      const snapshot = { at: T0 / 1000, spots: { NVDA: '215500000' }, alerts: {}, strikeSides: { '123': 'above' as const }, alertStates: {}, settlements: {}, sessionDays: { '20717': false, '20718': true } };
      const cursor = { since: T0 / 1000, seen: { 'tx-1': T0 / 1000 }, resume: null };
      const watch = await loadWatchSet(db);
      assert.deepEqual([...watch.addresses], [SAMPLE_ADDRESS]);
      assert.deepEqual(watch.alerts[SAMPLE_ADDRESS], [
        { ticker: 'NVDA', direction: 'above', threshold: '225000000' },
        { ticker: 'NVDA', direction: 'below', threshold: '210000000' },
      ]);
      await saveState(db, { cursor, snapshot, changedHoldings: { [SAMPLE_ADDRESS]: holdings, '0xgone': holdings }, watched: watch.addresses, now });
      assert.deepEqual(await loadState(db, logger), { cursor, snapshot, holdings: { [SAMPLE_ADDRESS]: holdings } });
      await saveState(db, { cursor, snapshot, changedHoldings: {}, watched: new Set(), now });
      assert.deepEqual((await loadState(db, logger)).holdings, {});

      // Rows stored before N2-02b's fields: a snapshot without sessionDays and a strategy without
      // lastRolledAt still parse (as unknown days and no last roll), rather than starting afresh.
      const { sessionDays: _days, ...olderSnapshot } = snapshot;
      const olderHoldings = { ...holdings, strategies: [{ ticker: 'NVDA', active: true, currentSeries: null }] };
      await db.query(`UPDATE notifier.rules_state SET value = $1::jsonb WHERE name = 'snapshot'`, [JSON.stringify(olderSnapshot)]);
      await db.query(`INSERT INTO notifier.rules_holdings (address, holdings, fetched_at) VALUES ($1, $2::jsonb, $3::timestamptz)`, [SAMPLE_ADDRESS, JSON.stringify(olderHoldings), now]);
      const older = await loadState(db, logger);
      assert.deepEqual(older.snapshot, { ...olderSnapshot, sessionDays: {} });
      assert.equal(older.holdings[SAMPLE_ADDRESS]?.strategies[0]?.lastRolledAt, null);
    });
  });
}
