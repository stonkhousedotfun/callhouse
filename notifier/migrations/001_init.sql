-- notifier schema, version 1.
--
-- Applied by src/db.ts migrate() at boot, inside one transaction that holds an advisory lock, and
-- recorded in notifier.migration so it runs once. Every statement is IF NOT EXISTS anyway: the
-- file is safe to run twice by hand.
--
-- Everything lives in schema "notifier" on the shared Railway Postgres; nothing here touches
-- another schema. Timestamps are timestamptz and are always written from the application clock
-- (never now()), so the tests can move time.

CREATE SCHEMA IF NOT EXISTS notifier;

-- A wallet's wish to hear about something on one channel.
--   target_enc   the channel target sealed with NOTIFIER_DATA_KEY (crypto.ts). NULL only for a
--                Telegram subscription whose chat has not been linked yet (/start completes it).
--   target_hash  HMAC of the canonical target: uniqueness and the bot's lookups by chat id,
--                without decrypting rows. NULL exactly when target_enc is.
--   verified_at  the target proved reachable by its owner: web push at creation (the browser
--                granted permission), Telegram at /start, email at the double opt-in click.
--                Only verified, enabled rows receive deliveries.
CREATE TABLE IF NOT EXISTS notifier.subscription (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  address         text        NOT NULL,
  channel         text        NOT NULL CHECK (channel IN ('telegram', 'webpush', 'email')),
  target_enc      text,
  target_hash     text,
  prefs           jsonb       NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  verified_at     timestamptz,
  verify_sent_at  timestamptz,
  disabled_at     timestamptz,
  disabled_reason text,
  CHECK ((target_enc IS NULL) = (target_hash IS NULL)),
  CHECK (target_enc IS NOT NULL OR channel = 'telegram')
);
-- One Telegram chat per wallet (re-linking moves it). Application quotas bound browser endpoints
-- and confirmation sends; these unique indexes identify individual browser and inbox rows.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_telegram_one_per_address
  ON notifier.subscription (address) WHERE channel = 'telegram';
CREATE UNIQUE INDEX IF NOT EXISTS subscription_target_unique
  ON notifier.subscription (address, channel, target_hash) WHERE channel <> 'telegram';
CREATE INDEX IF NOT EXISTS subscription_active_by_address
  ON notifier.subscription (address) WHERE verified_at IS NOT NULL AND disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS subscription_telegram_by_chat
  ON notifier.subscription (target_hash) WHERE channel = 'telegram';

-- Single-use challenge nonces (auth.ts). The message is stored verbatim so the signature is
-- checked against exactly the text that was handed out.
CREATE TABLE IF NOT EXISTS notifier.nonce (
  nonce       text        PRIMARY KEY,
  address     text        NOT NULL,
  message     text        NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS nonce_expires_at ON notifier.nonce (expires_at);

-- Pending Telegram deep links. Only the SHA-256 of the token is stored: a database read yields
-- no working link. Consumed (deleted) by the bot's /start.
CREATE TABLE IF NOT EXISTS notifier.telegram_link (
  token_hash  text        PRIMARY KEY,
  address     text        NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_link_expires_at ON notifier.telegram_link (expires_at);

-- One message to one subscription (delivery.ts). (subscription_id, dedupe_key) is unique, which is
-- what makes enqueue idempotent: the rules engine may re-evaluate the same event after a restart.
--   status          pending → sending → sent | failed | dropped   (sending → pending on a retry)
--   next_attempt_at when a pending row is due; for a sending row, when its lease runs out and
--                   another pass may take it again (at-least-once).
CREATE TABLE IF NOT EXISTS notifier.delivery (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid        NOT NULL REFERENCES notifier.subscription (id) ON DELETE CASCADE,
  kind            text        NOT NULL,
  dedupe_key      text        NOT NULL,
  payload         jsonb       NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dropped')),
  attempts        integer     NOT NULL DEFAULT 0,
  last_error_code text,
  created_at      timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  sent_at         timestamptz,
  UNIQUE (subscription_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS delivery_due
  ON notifier.delivery (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS delivery_sent_by_subscription
  ON notifier.delivery (subscription_id, sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS delivery_created_at ON notifier.delivery (created_at);
