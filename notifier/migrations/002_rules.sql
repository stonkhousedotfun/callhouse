-- notifier schema, version 2: rules engine state (N2-02, src/rules/).
--
-- Applied once by src/db.ts migrate(), like 001. Every statement is IF NOT EXISTS, so the file is
-- also safe to run twice by hand. Nothing here touches the tables of 001.

-- Named JSON documents, rewritten at the end of every successful tick (src/rules/store.ts):
--   cursor     { since, seen: { activityId: ts }, resume }   where the activity feed was read to
--   snapshot   { at, spots, alerts, strikeSides, alertStates, settlements }   the last tick's view
CREATE TABLE IF NOT EXISTS notifier.rules_state (
  name       text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL
);

-- The last /v2/accounts/:address/positions of each watched wallet, trimmed (src/rules/snapshot.ts
-- Holdings), plus the last-known cost of longs it no longer holds. Rows of wallets that left the
-- watch set are deleted by the next tick.
CREATE TABLE IF NOT EXISTS notifier.rules_holdings (
  address    text        PRIMARY KEY,
  holdings   jsonb       NOT NULL,
  fetched_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_holdings_fetched_at ON notifier.rules_holdings (fetched_at);
