-- An unsubscribe suppresses further confirmation mail to the same normalized inbox until its
-- owner explicitly opts back in using a token from an email they received.
CREATE TABLE IF NOT EXISTS notifier.email_suppression (
  budget_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL
);
