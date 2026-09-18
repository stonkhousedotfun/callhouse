-- Replacing old deep links by wallet needs an index for bounded lookup cost.
CREATE INDEX IF NOT EXISTS telegram_link_address ON notifier.telegram_link (address);
