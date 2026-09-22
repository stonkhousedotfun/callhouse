# Notifier backup and restore drill (O3-409)

`ops/v2/notifier-backup.sh` makes the dump. This is the drill that turns it into a backup.

**A dump nobody has restored is a hope.** Run this drill the first time a dump is taken, then
quarterly, and always before a notifier database migration, a Postgres upgrade or a move between
Railway projects. It takes about fifteen minutes and it touches nothing in production: every step
happens on a scratch database.

## What is at stake

The `notifier` schema is the only user data this protocol holds. It is the eight tables of
`notifier/migrations/`:

| Table | What is lost with it |
|---|---|
| `notifier.subscription` | every opt-in: channel, encrypted target, preferences, price alerts |
| `notifier.delivery` | what has already been sent. Lose it and every wallet is told about the same fill, expiry and settlement a second time |
| `notifier.telegram_link` | the pending `/start` links that attach a chat to a wallet |
| `notifier.nonce` | in-flight sign-in challenges (a minute of user annoyance, no more) |
| `notifier.rules_state` | how far the rules engine has read. Lose it and it re-reads or skips |
| `notifier.rules_holdings` | who holds what, as the engine last saw it |
| `notifier.email_confirmation_budget` | the per-inbox, per-wallet and global confirmation-mail caps |
| `notifier.email_suppression` | bounces and complaints. Lose it and the suppressed addresses are mailed again |

None of it is on chain. None of it can be rebuilt by replaying blocks.

## The thing this drill exists to catch

Every delivery target in the dump is encrypted with `NOTIFIER_DATA_KEY` (AES-256-GCM) and every
lookup column is an HMAC under the same key (`notifier/src/crypto.ts`). The key is not in the
database, and `crypto.ts` does not support rotating it.

So a restore beside a different key gives you a schema that is complete, a service that starts, an
API that answers, and not one target that can be delivered to. The rows are there and they are
rubbish. **Back the key up with the dump, offline, and prove in §5 that they belong together.**

Everything else in this drill is ordinary Postgres. §5 is the part that is specific to this service
and the part that is skipped when people are in a hurry.

---

## 1. Take a dump

```bash
# The URL is the notifier service's DATABASE_URL. Never paste it on a command line.
railway variables --service notifier --kv | grep '^DATABASE_URL=' | cut -d= -f2- > ~/.callhouse-keys/notifier-db.url
chmod 600 ~/.callhouse-keys/notifier-db.url

ops/v2/notifier-backup.sh --out ~/backups/notifier --url-file ~/.callhouse-keys/notifier-db.url
```

It refuses a dump that carries no table data, so a run that prints `BACKUP OK` has already been read
back once. Note the stamp it prints; `<stamp>` below is that value.

```bash
cat ~/backups/notifier/notifier-<stamp>.manifest.json
```

Keep the manifest with the dump. The drill compares against it, and during an incident it is the
only record of what the database held at that moment.

## 2. A scratch database, on your own machine

```bash
# Anything local. This is a throwaway.
createdb notifier_drill
psql -d notifier_drill -c 'SELECT current_database(), version()'
```

The scratch server must be at least the major version in the manifest's `serverVersion`. A newer one
is fine; an older one will refuse the archive, which is itself worth knowing before an incident.

## 3. Restore into it

```bash
pg_restore --dbname notifier_drill --no-owner --no-privileges \
  --schema notifier ~/backups/notifier/notifier-<stamp>.dump
```

`--no-owner --no-privileges` because the production role does not exist here. (They are given to
`pg_restore`, not to `pg_dump`: for an archive format pg_dump ignores them, which is why the
archive still carries the ownership it was dumped with.)

Expect no errors. `pg_restore` reports missing roles or extensions loudly; read them rather than
scrolling past them, because each one is a step somebody will have to perform by hand at 3 a.m.

## 4. Does it hold what the manifest says?

```bash
for t in subscription delivery telegram_link nonce rules_state rules_holdings \
         email_confirmation_budget email_suppression; do
  printf '%-28s %s\n' "$t" "$(psql -At -d notifier_drill -c "SELECT count(*) FROM notifier.$t")"
done
```

Compare with `rowCounts` in the manifest. They should match exactly: the dump is one read
transaction, so it is a single consistent moment, not a rolling read.

Then check the shape, not just the counts:

```bash
psql -d notifier_drill -c '\d notifier.subscription'
psql -At -d notifier_drill -c \
  "SELECT channel, count(*), count(*) FILTER (WHERE verified_at IS NOT NULL) FROM notifier.subscription GROUP BY channel"
```

A restore where `subscription` has rows but no index or constraint came back is a restore that will
duplicate deliveries under load.

## 5. Does the key still open the data? (the step that matters)

Take `NOTIFIER_DATA_KEY` from the offline copy — not from Railway, because the point of the drill is
to prove that the copy you keep beside the dump is the right one.

```bash
cd <the callhouse checkout>
pnpm install --frozen-lockfile        # tsx and pg come from the notifier package

NOTIFIER_DATA_KEY=<the 64 hex characters from the offline copy> \
DRILL_URL=postgres://localhost/notifier_drill \
pnpm --filter @callhouse/notifier exec tsx -e '
import { Client } from "pg";
import { createTargetCipher } from "./src/crypto.js";

const cipher = createTargetCipher(Buffer.from(process.env.NOTIFIER_DATA_KEY, "hex"));
const db = new Client({ connectionString: process.env.DRILL_URL });
await db.connect();
const { rows } = await db.query(
  "SELECT channel, address, target_enc FROM notifier.subscription WHERE target_enc IS NOT NULL LIMIT 50",
);
let ok = 0;
for (const row of rows) {
  try {
    // Exactly what the API does to show a target hint (notifier/src/server.ts targetHint).
    cipher.decrypt(row.target_enc, `${row.channel}:${row.address}`);
    ok += 1;
  } catch {
    /* counted as a failure below; the value is never printed either way */
  }
}
console.log(`decrypted ${ok} of ${rows.length} targets`);
await db.end();
'
```

- `decrypted 50 of 50` — the dump and the key belong together. The drill has passed.
- `decrypted 0 of 50` — **the key is wrong.** The dump is not restorable. Find the right key before
  anything else: without it those subscriptions are gone whatever you do to the database.
- Anything in between — a partial mismatch means rows were written under two different keys, which
  `crypto.ts` does not support. Stop and escalate; do not restore over production.
- `decrypted 0 of 0` — the table holds no targets with a ciphertext. On a young deployment that can
  be true (Telegram rows store no target until a chat is attached). Confirm against the manifest's
  `rowCounts` rather than accepting it.

Nothing above prints a target. Keep it that way: a drill that pastes a subscriber's email address
into a terminal log has created a second incident.

## 6. Prove the service accepts the restore

```bash
# A notifier pointed at the scratch database. Use throwaway channel credentials, never production's.
DATABASE_URL=postgres://localhost/notifier_drill \
NOTIFIER_DATA_KEY=<the same key> \
APP_URL=http://127.0.0.1:3000 RULES_ENABLED=false PORT=8791 \
  pnpm --filter @callhouse/notifier start

# in another shell
node ops/v2/notifier-smoke.mjs --url http://127.0.0.1:8791 --app-url http://127.0.0.1:3000
```

`RULES_ENABLED=false` on purpose: a rules engine pointed at restored data with real channel
credentials would deliver the alerts the restored `delivery` table has not recorded yet, to real
people, from a drill. Leave it off.

The migrations run at boot (`notifier/migrations/`). A boot that fails here means the dump predates
a migration the current code requires: note which, because the real restore will need the same
ordering.

## 7. Clean up

```bash
dropdb notifier_drill
```

Then record the drill: the date, the dump's stamp and SHA-256, the row counts you compared, the
result of §5, and anything that needed a hand. A drill nobody wrote down is a drill that will be
argued about.

---

## If this is not a drill

The order that matters during a real restore:

1. **Stop the notifier** (Railway: scale the service to zero, or pause the deployment). A running
   notifier writing into a database you are restoring over produces a state nothing can reason
   about, and it will deliver from a `delivery` table that is being replaced under it.
2. Restore into a **new, empty** database, never over the live one. Keep the damaged database: it is
   the only evidence of what happened, and it may hold rows newer than the dump.
3. §4 and §5 against the restored copy, before anything points at it.
4. Repoint `DATABASE_URL`, start the notifier, watch `/health` until `database` is `ok` and the
   rules engine reaches `ok`.
5. Expect duplicate deliveries for everything that happened between the dump and the incident: that
   window is what `notifier.delivery` no longer knows about. Say so publicly before the alerts land,
   rather than after.
