/**
 * Every SQL statement that touches subscriptions, nonces and Telegram links, in one place. The
 * delivery queue's SQL lives with its worker in delivery.ts.
 *
 * Callers pass a Queryable, which is the pool or an open transaction (db.ts). Nothing here
 * encrypts or decrypts: targets arrive sealed and hashed (crypto.ts) and leave sealed.
 *
 * UPSERT RULES (the unique indexes are in migrations/001_init.sql):
 *   webpush   keyed by (address, endpoint hash). A repeat POST refreshes keys and prefs and
 *             re-enables a row a 404/410 disabled: the browser subscribed again.
 *   email     keyed by (address, email hash). A repeat POST updates prefs. If the row had been
 *             disabled by a bounce, it goes back to UNVERIFIED and needs a fresh double opt-in.
 *             An unsubscribe suppresses confirmation mail until the inbox owner opts back in:
 *             a wallet signature proves the wallet, not the inbox.
 *   telegram  one per address. A POST sets prefs only (creating an unlinked row if needed); it
 *             never re-enables a chat that sent /stop, because only the chat can undo that
 *             (/start with a new link). The bot's /start sets the chat and enables the row.
 */
import type { ChannelName } from './channels/types.js';
import type { Db, Queryable } from './db.js';
import type { Prefs } from './prefs.js';

export const MAX_WEBPUSH_SUBSCRIPTIONS_PER_WALLET = 10;
export const MAX_EMAIL_SUBSCRIPTIONS_PER_WALLET = 10;
export const MAX_EMAIL_CONFIRMATIONS_PER_DAY = 3;
export const MAX_EMAIL_CONFIRMATIONS_PER_WALLET_DAY = 10;
export const MAX_EMAIL_CONFIRMATIONS_GLOBAL_DAY = 1_000;
export const EMAIL_CONFIRM_RESEND_MS = 10 * 60_000;

export class SubscriptionLimitError extends Error {
  constructor() {
    super('web push subscription limit reached');
    this.name = 'SubscriptionLimitError';
  }
}

export class EmailRecipientLimitError extends Error {
  constructor() {
    super('email recipient confirmation limit reached');
    this.name = 'EmailRecipientLimitError';
  }
}

export class EmailSuppressedError extends EmailRecipientLimitError {
  constructor() {
    super();
    this.name = 'EmailSuppressedError';
  }
}

export class EmailConfirmationBudgetError extends EmailRecipientLimitError {
  constructor() {
    super();
    this.name = 'EmailConfirmationBudgetError';
  }
}

/** Extends the existing email 429 path until its HTTP copy can be updated alongside server auth. */
export class EmailSubscriptionLimitError extends EmailRecipientLimitError {
  constructor() {
    super();
    this.message = 'email subscription limit reached for this wallet';
    this.name = 'EmailSubscriptionLimitError';
  }
}

export interface SubscriptionRow {
  id: string;
  address: string;
  channel: ChannelName;
  target_enc: string | null;
  target_hash: string | null;
  prefs: unknown;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
  verify_sent_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

export interface UpsertResult {
  id: string;
  inserted: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function upsertWebPush(
  q: Db,
  a: { address: string; targetEnc: string; targetHash: string; prefs: Prefs; now: Date },
): Promise<UpsertResult> {
  return q.transaction(async (tx) => {
    // Serialize inserts for this wallet, including concurrent requests on separate replicas.
    await tx.query(`SELECT pg_advisory_xact_lock(731459, hashtext($1))`, [a.address]);
    const { rows: existing } = await tx.query<{ id: string; verified_at: Date | null; disabled_at: Date | null }>(
      `SELECT id, verified_at, disabled_at FROM notifier.subscription WHERE address = $1 AND channel = 'webpush' AND target_hash = $2`,
      [a.address, a.targetHash],
    );
    const alreadyActive = existing[0] !== undefined && existing[0].verified_at !== null && existing[0].disabled_at === null;
    if (!alreadyActive) {
      const { rows: counts } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifier.subscription
          WHERE address = $1 AND channel = 'webpush' AND verified_at IS NOT NULL AND disabled_at IS NULL`,
        [a.address],
      );
      if ((counts[0]?.n ?? 0) >= MAX_WEBPUSH_SUBSCRIPTIONS_PER_WALLET) throw new SubscriptionLimitError();
    }
    if (existing.length === 0) {
      // Dead endpoints need no pending deliveries. Clearing them when a new device arrives
      // prevents old 404/410 rows from accumulating without limiting active devices.
      await tx.query(
        `DELETE FROM notifier.subscription WHERE address = $1 AND channel = 'webpush' AND disabled_at IS NOT NULL`,
        [a.address],
      );
    }
    const { rows } = await tx.query<{ id: string; inserted: boolean }>(
      `INSERT INTO notifier.subscription AS s
         (address, channel, target_enc, target_hash, prefs, created_at, updated_at, verified_at)
       VALUES ($1, 'webpush', $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz, $5::timestamptz)
       ON CONFLICT (address, channel, target_hash) WHERE channel <> 'telegram'
       DO UPDATE SET target_enc = EXCLUDED.target_enc, prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at,
                     verified_at = COALESCE(s.verified_at, EXCLUDED.verified_at),
                     disabled_at = NULL, disabled_reason = NULL
       RETURNING id, (xmax = 0) AS inserted`,
      [a.address, a.targetEnc, a.targetHash, JSON.stringify(a.prefs), a.now],
    );
    return rows[0] as UpsertResult;
  });
}

export async function upsertEmail(
  q: Queryable,
  a: { address: string; targetEnc: string; targetHash: string; prefs: Prefs; now: Date },
): Promise<UpsertResult & { verified_at: Date | null; verify_sent_at: Date | null }> {
  const { rows } = await q.query<UpsertResult & { verified_at: Date | null; verify_sent_at: Date | null }>(
    `INSERT INTO notifier.subscription AS s
       (address, channel, target_enc, target_hash, prefs, created_at, updated_at)
     VALUES ($1, 'email', $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz)
     ON CONFLICT (address, channel, target_hash) WHERE channel <> 'telegram'
     DO UPDATE SET target_enc = EXCLUDED.target_enc, prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at,
                   verified_at    = CASE WHEN s.disabled_at IS NULL THEN s.verified_at ELSE NULL END,
                   verify_sent_at = CASE WHEN s.disabled_at IS NULL THEN s.verify_sent_at ELSE NULL END,
                   disabled_at = NULL, disabled_reason = NULL
     RETURNING id, (xmax = 0) AS inserted, verified_at, verify_sent_at`,
    [a.address, a.targetEnc, a.targetHash, JSON.stringify(a.prefs), a.now],
  );
  return rows[0] as UpsertResult & { verified_at: Date | null; verify_sent_at: Date | null };
}

export async function upsertTelegramPrefs(
  q: Queryable,
  a: { address: string; prefs: Prefs; now: Date },
): Promise<UpsertResult> {
  const { rows } = await q.query<{ id: string; inserted: boolean }>(
    `INSERT INTO notifier.subscription AS s (address, channel, prefs, created_at, updated_at)
     VALUES ($1, 'telegram', $2::jsonb, $3::timestamptz, $3::timestamptz)
     ON CONFLICT (address) WHERE channel = 'telegram'
     DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at
     RETURNING id, (xmax = 0) AS inserted`,
    [a.address, JSON.stringify(a.prefs), a.now],
  );
  return rows[0] as UpsertResult;
}

/** The bot's /start: bind the chat to the address's Telegram row (default prefs if none yet). */
export async function linkTelegramChat(
  q: Queryable,
  a: { address: string; targetEnc: string; targetHash: string; defaultPrefs: Prefs; now: Date },
): Promise<UpsertResult> {
  const { rows } = await q.query<{ id: string; inserted: boolean }>(
    `INSERT INTO notifier.subscription AS s
       (address, channel, target_enc, target_hash, prefs, created_at, updated_at, verified_at)
     VALUES ($1, 'telegram', $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz, $5::timestamptz)
     ON CONFLICT (address) WHERE channel = 'telegram'
     DO UPDATE SET target_enc = EXCLUDED.target_enc, target_hash = EXCLUDED.target_hash,
                   verified_at = EXCLUDED.verified_at, updated_at = EXCLUDED.updated_at,
                   disabled_at = NULL, disabled_reason = NULL
     RETURNING id, (xmax = 0) AS inserted`,
    [a.address, a.targetEnc, a.targetHash, JSON.stringify(a.defaultPrefs), a.now],
  );
  return rows[0] as UpsertResult;
}

export async function listByAddress(q: Queryable, address: string): Promise<SubscriptionRow[]> {
  const { rows } = await q.query<SubscriptionRow>(
    `SELECT * FROM notifier.subscription WHERE address = $1 ORDER BY created_at, id`,
    [address],
  );
  return rows;
}

export async function getById(q: Queryable, id: string): Promise<SubscriptionRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await q.query<SubscriptionRow>(
    `SELECT * FROM notifier.subscription WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Delete a subscription only if it belongs to `address`. Its deliveries go with it (cascade). */
export async function deleteOwned(q: Queryable, id: string, address: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await q.query(`DELETE FROM notifier.subscription WHERE id = $1 AND address = $2`, [id, address]);
  return rowCount > 0;
}

/** Subscriptions that may receive deliveries: verified and not disabled. */
export async function activeForAddress(q: Queryable, address: string): Promise<Pick<SubscriptionRow, 'id' | 'channel' | 'prefs'>[]> {
  const { rows } = await q.query<{ id: string; channel: ChannelName; prefs: unknown }>(
    `SELECT id, channel, prefs FROM notifier.subscription
      WHERE address = $1 AND verified_at IS NOT NULL AND disabled_at IS NULL
      ORDER BY created_at, id`,
    [address],
  );
  return rows;
}

export async function disableSubscription(q: Queryable, id: string, reason: string, now: Date): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE notifier.subscription SET disabled_at = $3::timestamptz, disabled_reason = $2, updated_at = $3::timestamptz
      WHERE id = $1 AND disabled_at IS NULL`,
    [id, reason, now],
  );
  return rowCount > 0;
}

export async function telegramByChat(q: Queryable, chatHash: string): Promise<SubscriptionRow[]> {
  const { rows } = await q.query<SubscriptionRow>(
    `SELECT * FROM notifier.subscription WHERE channel = 'telegram' AND target_hash = $1 ORDER BY created_at, id`,
    [chatHash],
  );
  return rows;
}

/** The bot's /stop. Returns the ids it disabled. */
export async function disableTelegramChat(q: Queryable, chatHash: string, now: Date): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `UPDATE notifier.subscription SET disabled_at = $2::timestamptz, disabled_reason = 'telegram_stop', updated_at = $2::timestamptz
      WHERE channel = 'telegram' AND target_hash = $1 AND disabled_at IS NULL
      RETURNING id`,
    [chatHash, now],
  );
  return rows.map((r) => r.id);
}

/** Reserve a confirmation send inside the same transaction as the email upsert. */
async function claimEmailConfirmation(
  q: Queryable,
  id: string,
  hashes: { inbox: string; wallet: string; global: string },
  now: Date,
): Promise<boolean> {
  const day = Math.floor(now.getTime() / 86_400_000);
  const { rows: claimed } = await q.query<{ id: string }>(
    `UPDATE notifier.subscription SET verify_sent_at = $2::timestamptz
      WHERE id = $1 AND channel = 'email' AND verified_at IS NULL AND disabled_at IS NULL
        AND (verify_sent_at IS NULL OR verify_sent_at <= $3::timestamptz)
      RETURNING id`,
    [id, now, new Date(now.getTime() - EMAIL_CONFIRM_RESEND_MS)],
  );
  if (claimed.length === 0) return false;
  const reserve = async (hash: string, limit: number): Promise<boolean> => {
    const { rows } = await q.query<{ attempts: number }>(
      `INSERT INTO notifier.email_confirmation_budget (target_hash, day_index, attempts)
        VALUES ($1, $2, 1)
        ON CONFLICT (target_hash, day_index) DO UPDATE
          SET attempts = notifier.email_confirmation_budget.attempts + 1
          WHERE notifier.email_confirmation_budget.attempts < $3
        RETURNING attempts`,
      [hash, day, limit],
    );
    return rows.length !== 0;
  };
  if (!(await reserve(hashes.inbox, MAX_EMAIL_CONFIRMATIONS_PER_DAY))) throw new EmailRecipientLimitError();
  if (!(await reserve(hashes.wallet, MAX_EMAIL_CONFIRMATIONS_PER_WALLET_DAY))) throw new EmailConfirmationBudgetError();
  if (!(await reserve(hashes.global, MAX_EMAIL_CONFIRMATIONS_GLOBAL_DAY))) throw new EmailConfirmationBudgetError();
  return true;
}

/** A rejected recipient budget must also roll back a newly inserted, unverified subscription. */
export async function upsertEmailAndClaimConfirmation(
  db: Db,
  a: { address: string; targetEnc: string; targetHash: string; inboxBudgetHash: string; walletBudgetHash: string; globalBudgetHash: string; prefs: Prefs; now: Date },
): Promise<UpsertResult & { due: boolean }> {
  return db.transaction(async (tx) => {
    // The same wallet may submit on several replicas at once. Count and upsert under one
    // transaction-wide lock, including pending rows so confirmation cannot bypass the cap.
    await tx.query(`SELECT pg_advisory_xact_lock(731460, hashtext($1))`, [a.address]);
    await tx.query(`SELECT pg_advisory_xact_lock(731461, hashtext($1))`, [a.inboxBudgetHash]);
    const { rows: suppressed } = await tx.query(
      'SELECT 1 FROM notifier.email_suppression WHERE budget_hash = $1',
      [a.inboxBudgetHash],
    );
    if (suppressed.length > 0) throw new EmailSuppressedError();
    const { rows: existing } = await tx.query<{ disabled_at: Date | null }>(
      `SELECT disabled_at FROM notifier.subscription
        WHERE address = $1 AND channel = 'email' AND target_hash = $2`,
      [a.address, a.targetHash],
    );
    if (existing[0] === undefined || existing[0].disabled_at !== null) {
      const { rows: counts } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifier.subscription
          WHERE address = $1 AND channel = 'email' AND disabled_at IS NULL`,
        [a.address],
      );
      if ((counts[0]?.n ?? 0) >= MAX_EMAIL_SUBSCRIPTIONS_PER_WALLET) throw new EmailSubscriptionLimitError();
    }
    const row = await upsertEmail(tx, a);
    const due = await claimEmailConfirmation(tx, row.id, {
      inbox: a.inboxBudgetHash,
      wallet: a.walletBudgetHash,
      global: a.globalBudgetHash,
    }, a.now);
    return { id: row.id, inserted: row.inserted, due };
  });
}

/** The inbox owner opted out. Serialize with confirmation claims for its normalized identity. */
export async function unsubscribeEmail(db: Db, id: string, inboxBudgetHash: string, now: Date): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(731461, hashtext($1))`, [inboxBudgetHash]);
    const { rowCount } = await tx.query(
      `UPDATE notifier.subscription SET disabled_at = $2::timestamptz, disabled_reason = 'email_unsubscribe', updated_at = $2::timestamptz
        WHERE id = $1 AND channel = 'email' AND disabled_at IS NULL`,
      [id, now],
    );
    await tx.query(
      `INSERT INTO notifier.email_suppression (budget_hash, created_at) VALUES ($1, $2::timestamptz)
        ON CONFLICT (budget_hash) DO NOTHING`,
      [inboxBudgetHash, now],
    );
    return rowCount > 0;
  });
}

/** Requires proof of inbox access: the caller must present an unsubscribe token from its mail. */
export async function allowEmailConfirmations(db: Db, inboxBudgetHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(731461, hashtext($1))`, [inboxBudgetHash]);
    await tx.query('DELETE FROM notifier.email_suppression WHERE budget_hash = $1', [inboxBudgetHash]);
  });
}

/** Double opt-in: verify an email row that is still pending. True when this call verified it. */
export async function confirmEmail(q: Queryable, id: string, now: Date): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await q.query(
    `UPDATE notifier.subscription SET verified_at = $2::timestamptz, updated_at = $2::timestamptz
      WHERE id = $1 AND channel = 'email' AND verified_at IS NULL AND disabled_at IS NULL`,
    [id, now],
  );
  return rowCount > 0;
}

/* ------------------------------------------------------------------ nonces */

export async function insertNonce(
  q: Queryable,
  a: { nonce: string; address: string; message: string; now: Date; expiresAt: Date },
): Promise<void> {
  await q.query(
    `INSERT INTO notifier.nonce (nonce, address, message, created_at, expires_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
    [a.nonce, a.address, a.message, a.now, a.expiresAt],
  );
}

/**
 * Burn a nonce and return the message it was issued with, or null when it is unknown, already
 * used, expired, or was issued for another address. One UPDATE, so two requests racing with the
 * same nonce cannot both win.
 */
export async function consumeNonce(q: Queryable, nonce: string, address: string, now: Date): Promise<string | null> {
  const { rows } = await q.query<{ message: string }>(
    `UPDATE notifier.nonce SET used_at = $3::timestamptz
      WHERE nonce = $1 AND address = $2 AND used_at IS NULL AND expires_at > $3::timestamptz
      RETURNING message`,
    [nonce, address, now],
  );
  return rows[0]?.message ?? null;
}

/* ------------------------------------------------------------------ telegram links */

export async function insertTelegramLink(
  q: Queryable,
  a: { tokenHash: string; address: string; now: Date; expiresAt: Date },
): Promise<void> {
  // A fresh link replaces earlier unused links for this wallet. The caller serialises this by
  // address, so repeated authenticated GETs consume one live row instead of unbounded storage.
  await q.query('DELETE FROM notifier.telegram_link WHERE address = $1', [a.address]);
  await q.query(
    `INSERT INTO notifier.telegram_link (token_hash, address, created_at, expires_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz)`,
    [a.tokenHash, a.address, a.now, a.expiresAt],
  );
}

/** Single use: the row is deleted whether or not it has expired. Returns the address if it was live. */
export async function consumeTelegramLink(q: Queryable, tokenHash: string, now: Date): Promise<string | null> {
  const { rows } = await q.query<{ address: string; live: boolean }>(
    `DELETE FROM notifier.telegram_link WHERE token_hash = $1
      RETURNING address, (expires_at > $2::timestamptz) AS live`,
    [tokenHash, now],
  );
  const row = rows[0];
  return row !== undefined && row.live ? row.address : null;
}

/* ------------------------------------------------------------------ housekeeping */

export const DELIVERY_RETENTION_MS = 30 * 24 * 3600_000;

/** Drop dead nonces and links, and finished deliveries past retention. */
export async function purge(q: Queryable, now: Date): Promise<{ nonces: number; links: number; deliveries: number }> {
  // An expired nonce is refused whether or not its row still exists, so it can go at once.
  const nonces = await q.query(`DELETE FROM notifier.nonce WHERE expires_at < $1::timestamptz`, [now]);
  const links = await q.query(`DELETE FROM notifier.telegram_link WHERE expires_at < $1::timestamptz`, [now]);
  const deliveries = await q.query(
    `DELETE FROM notifier.delivery WHERE status IN ('sent', 'failed', 'dropped') AND created_at < $1::timestamptz`,
    [new Date(now.getTime() - DELIVERY_RETENTION_MS)],
  );
  await q.query(`DELETE FROM notifier.email_confirmation_budget WHERE day_index < $1`, [Math.floor(now.getTime() / 86_400_000) - 1]);
  return { nonces: nonces.rowCount, links: links.rowCount, deliveries: deliveries.rowCount };
}
