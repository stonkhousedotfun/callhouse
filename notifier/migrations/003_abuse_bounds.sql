-- Bounded public challenges and recipient-wide email confirmation budgets.
CREATE INDEX IF NOT EXISTS nonce_created_at ON notifier.nonce (created_at);

CREATE TABLE IF NOT EXISTS notifier.email_confirmation_budget (
  target_hash text NOT NULL,
  day_index integer NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  PRIMARY KEY (target_hash, day_index)
);
