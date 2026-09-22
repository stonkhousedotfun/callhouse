#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# ops/v2/notifier-backup.sh — O3-409: a verified `pg_dump --schema=notifier`, and the drill that
# proves it can be restored (ops/runbooks/notifier-restore.md).
#
# The notifier schema is the only user data Stonkhouse keeps: who asked to be told what, and where.
# It is not reconstructible from the chain. The indexer can be rebuilt by replaying blocks; this
# cannot — a lost `notifier.subscription` is every wallet having to opt in again, and a lost
# `notifier.delivery` is every alert those wallets already received arriving a second time.
#
#   ops/v2/notifier-backup.sh --out ~/backups                 # DATABASE_URL from the environment
#   ops/v2/notifier-backup.sh --out ~/backups --url-file ~/.callhouse-keys/notifier-db.url
#   ops/v2/notifier-backup.sh --out ~/backups --url-stdin     # the URL on standard input
#   ops/v2/notifier-backup.sh --out ~/backups --dry-run       # print the plan, connect to nothing
#
# THE CONNECTION STRING IS NOT IN THIS FILE, never on a command line and never in the output. It
# comes from `NOTIFIER_DATABASE_URL`, from `DATABASE_URL`, from a mode-600 file (`--url-file`) or
# from standard input (`--url-stdin`), and it reaches pg_dump the only way libpq accepts without
# argv: host, port, database, user and sslmode become PG* environment variables and the password
# becomes a mode-600 `PGPASSFILE` in a private temp directory this script removes on exit.
# `--url <value>` is refused on purpose — every process on the machine can read another process's
# argv, and the shell keeps its history.
#
# WHAT IT WRITES, per run, into --out:
#   notifier-<UTC stamp>.dump           pg_dump --format=custom (compressed, selective restore)
#   notifier-<UTC stamp>.manifest.json  when, from where (host/port/database/user, never the
#                                       password), pg_dump and server versions, byte size, SHA-256,
#                                       the tables the dump carries and their row counts
#
# AND IT READS THE DUMP BACK BEFORE CALLING IT A BACKUP. `pg_dump` exits 0 on a schema that is
# empty, missing, or unreadable to this role, so the run lists the archive with `pg_restore --list`
# and refuses one that carries no table data. That is the failure normally discovered during a
# restore, at the worst possible moment. A rejected archive is renamed `*.REJECTED` so nobody can
# mistake it for a backup.
#
# WHAT A DUMP OF THIS SCHEMA CANNOT BRING BACK: every delivery target in it is encrypted with
# NOTIFIER_DATA_KEY (AES-256-GCM) and every lookup column is an HMAC under the same key
# (notifier/src/crypto.ts). Restored beside a different key, every row survives and not one target
# can be used — the schema is whole and the service is empty. Back the key up with the dump or the
# dump is decoration. The drill checks exactly that.
#
# Nothing here writes to the database, touches Railway or deploys anything: pg_dump takes an
# ordinary read transaction. Exit codes: 0 a verified dump · 1 pg_dump failed, or the dump was made
# and rejected · 2 bad usage or a missing tool. Bash 3.2 (macOS default).
# ---------------------------------------------------------------------------------------------
set -euo pipefail

SCHEMA=notifier
OUT_DIR=""
URL_FILE=""
URL_STDIN=0
DRY_RUN=0

die() { echo "notifier-backup: $*" >&2; exit 2; }
fail() { echo "notifier-backup: $*" >&2; exit 1; }
note() { echo "  $*"; }
usage() { sed -n '3,/^# ----/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT_DIR=$2; shift 2 ;;
    --out=*) OUT_DIR=${1#*=}; shift ;;
    --url-file) [ $# -ge 2 ] || die "--url-file needs a path"; URL_FILE=$2; shift 2 ;;
    --url-file=*) URL_FILE=${1#*=}; shift ;;
    --url-stdin) URL_STDIN=1; shift ;;
    --schema) [ $# -ge 2 ] || die "--schema needs a name"; SCHEMA=$2; shift 2 ;;
    --schema=*) SCHEMA=${1#*=}; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --url|--url=*)
      die "--url would put the connection string in this process's argv, where every process on the
  machine can read it, and in the shell's history.
  Use one of: NOTIFIER_DATABASE_URL=... (or DATABASE_URL), --url-file <path>, --url-stdin." ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

[ -n "$OUT_DIR" ] || die "--out <directory> is required: it is where the dump and its manifest are written"
case "$SCHEMA" in
  ''|*[!a-z0-9_]*) die "--schema takes a lower-case identifier, not '$SCHEMA'" ;;
esac

command -v node >/dev/null 2>&1 || die "node is not installed (it parses the connection string without putting it in argv)"
if [ "$DRY_RUN" != 1 ]; then
  for tool in pg_dump pg_restore; do
    command -v "$tool" >/dev/null 2>&1 \
      || die "$tool is not installed. macOS: brew install libpq && brew link --force libpq"
  done
fi

# ---------------------------------------------------------------------------------------------
# The connection string: environment, file or stdin. Never a flag, never echoed, never in argv.
# ---------------------------------------------------------------------------------------------
CONN=""
SOURCE=""
if [ "$URL_STDIN" = 1 ]; then
  [ -z "$URL_FILE" ] || die "--url-stdin and --url-file are two answers to the same question"
  IFS= read -r CONN || true
  SOURCE="standard input"
elif [ -n "$URL_FILE" ]; then
  [ -f "$URL_FILE" ] || die "--url-file $URL_FILE does not exist"
  perms=$(stat -f '%Lp' "$URL_FILE" 2>/dev/null || stat -c '%a' "$URL_FILE")
  case "$perms" in
    600|400) ;;
    *) die "$URL_FILE is mode $perms: a file holding a database password must be 600 (chmod 600 $URL_FILE)" ;;
  esac
  IFS= read -r CONN < "$URL_FILE" || true
  SOURCE="$URL_FILE"
elif [ -n "${NOTIFIER_DATABASE_URL:-}" ]; then
  CONN=$NOTIFIER_DATABASE_URL
  SOURCE='$NOTIFIER_DATABASE_URL'
elif [ -n "${DATABASE_URL:-}" ]; then
  CONN=$DATABASE_URL
  SOURCE='$DATABASE_URL'
fi
if [ -z "$CONN" ]; then
  die "no connection string. This script holds none. Give it one of:
    NOTIFIER_DATABASE_URL=postgres://...   (or DATABASE_URL)
    --url-file <a mode-600 file whose first line is the URL>
    --url-stdin
  On Railway it is the notifier service's DATABASE_URL. Read it in the dashboard or with
  \`railway variables --service notifier\`; do not paste it into a command line."
fi
case "$CONN" in
  postgres://*|postgresql://*) ;;
  *) die "the connection string is not a postgres:// or postgresql:// URL" ;;
esac

PGDIR=$(mktemp -d "${TMPDIR:-/tmp}/notifier-backup.XXXXXX")
chmod 700 "$PGDIR"
cleanup() { code=$?; rm -rf "$PGDIR"; exit "$code"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The URL reaches node through the environment, so it is in no argv. node writes the password into
# a mode-600 passfile and hands the shell only the parts that are not secret, as tab-separated
# lines (no quoting rules to get wrong).
cat > "$PGDIR/parse.mjs" <<'PARSE'
import { writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.NOTIFIER_BACKUP_DIR;
let url;
try {
  url = new URL(process.env.NOTIFIER_BACKUP_CONN);
} catch {
  process.stderr.write("the connection string is not a URL\n");
  process.exit(2);
}
const host = url.hostname;
const port = url.port === "" ? "5432" : url.port;
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const sslmode = url.searchParams.get("sslmode") ?? "";
if (host === "" || database === "" || user === "") {
  process.stderr.write("the connection string needs a host, a user and a database name\n");
  process.exit(2);
}
for (const [what, value] of [["host", host], ["port", port], ["database", database], ["user", user], ["sslmode", sslmode]]) {
  if (/[\t\n\r]/.test(value)) {
    process.stderr.write(`the ${what} in the connection string contains a tab or a newline\n`);
    process.exit(2);
  }
}
// libpq's password file: a backslash or a colon inside a field is escaped with a backslash.
const field = (s) => s.replace(/([\\:])/g, "\\$1");
writeFileSync(path.join(dir, "pgpass"), `${[host, port, database, user, password].map(field).join(":")}\n`, { mode: 0o600 });
const rows = [["PGHOST", host], ["PGPORT", port], ["PGDATABASE", database], ["PGUSER", user]];
if (sslmode !== "") rows.push(["PGSSLMODE", sslmode]);
writeFileSync(path.join(dir, "env.tsv"), `${rows.map(([k, v]) => `${k}\t${v}`).join("\n")}\n`, { mode: 0o600 });
PARSE

NOTIFIER_BACKUP_CONN="$CONN" NOTIFIER_BACKUP_DIR="$PGDIR" node "$PGDIR/parse.mjs" \
  || die "the connection string could not be parsed (see above)"
CONN=""

PGSSLMODE=""
while IFS=$'\t' read -r key value; do
  case "$key" in
    PGHOST) PGHOST=$value ;;
    PGPORT) PGPORT=$value ;;
    PGDATABASE) PGDATABASE=$value ;;
    PGUSER) PGUSER=$value ;;
    PGSSLMODE) PGSSLMODE=$value ;;
  esac
done < "$PGDIR/env.tsv"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSFILE="$PGDIR/pgpass"
if [ -n "$PGSSLMODE" ]; then export PGSSLMODE; fi
# Without this libpq waits on a tty for a password that will never be typed, inside cron or CI.
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="$OUT_DIR/notifier-$STAMP.dump"
MANIFEST="$OUT_DIR/notifier-$STAMP.manifest.json"

echo "notifier backup"
note "source      $SOURCE"
note "database    $PGUSER@$PGHOST:$PGPORT/$PGDATABASE${PGSSLMODE:+ (sslmode=$PGSSLMODE)}"
note "schema      $SCHEMA"
note "dump        $DUMP"

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "# DRY RUN: nothing connected, nothing written. The run would be:"
  echo "mkdir -p $OUT_DIR"
  echo "PGPASSFILE=<mode-600 temp file> PGHOST=$PGHOST PGPORT=$PGPORT PGDATABASE=$PGDATABASE PGUSER=$PGUSER \\"
  echo "  pg_dump --schema=$SCHEMA --format=custom --compress=9 --file $DUMP"
  echo "pg_restore --list $DUMP     # refused unless it carries TABLE DATA for schema $SCHEMA"
  echo "shasum -a 256 $DUMP         # recorded, with the row counts, in $MANIFEST"
  echo
  echo "Restore drill: ops/runbooks/notifier-restore.md"
  exit 0
fi

mkdir -p "$OUT_DIR" || die "cannot create $OUT_DIR"
[ -w "$OUT_DIR" ] || die "$OUT_DIR is not writable"

# --format=custom, not plain SQL: it compresses, it can be listed without being restored (which is
# how this run verifies it below), and pg_restore can take one table out of it. Ownership and ACLs
# stay in the archive because pg_dump ignores --no-owner / --no-privileges for an archive format;
# the drill drops them at restore time, where those flags do apply.
echo
echo "\$ pg_dump --schema=$SCHEMA --format=custom --compress=9 --file <dump>"
pg_dump --schema="$SCHEMA" --format=custom --compress=9 --file "$DUMP" \
  || fail "pg_dump failed; the message above is libpq's, and nothing usable was written.
  A version complaint here is usually a pg_dump older than the server: compare \`pg_dump --version\`
  with \`psql -At -c 'SHOW server_version'\` and install the newer client."

BYTES=$(wc -c < "$DUMP" | tr -d ' ')
SHA=""
if command -v shasum >/dev/null 2>&1; then
  SHA=$(shasum -a 256 "$DUMP" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  SHA=$(sha256sum "$DUMP" | awk '{print $1}')
fi

# ---- read the archive back: a dump nobody has opened is a guess ----
LISTING=$(pg_restore --list "$DUMP") || fail "pg_restore cannot read $DUMP: the archive is corrupt"
TABLES=$(printf '%s\n' "$LISTING" | awk -v s="$SCHEMA" '
  { head = "TABLE DATA " s " "; i = index($0, head)
    if (i > 0) { split(substr($0, i + length(head)), part, " "); if (part[1] != "") print part[1] } }' | sort -u)
COUNT=$(printf '%s\n' "$TABLES" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$COUNT" = 0 ]; then
  mv "$DUMP" "$DUMP.REJECTED"
  fail "the dump carries no table data for schema '$SCHEMA'.
  pg_dump exits 0 on a schema that is empty, does not exist, or that this role cannot read, so this
  is the usual shape of a backup found to be worthless during an incident.
  Check that the database is the notifier's (not the indexer's), that the schema name is right, and
  that $PGUSER has SELECT on it. The archive was kept as $DUMP.REJECTED so it cannot be mistaken
  for a backup."
fi
note "tables      $COUNT with data: $(printf '%s ' $TABLES)"
note "size        $BYTES bytes"
if [ -n "$SHA" ]; then note "sha256      $SHA"; fi

# ---- row counts and the server version, when psql is installed ----
ROWS="{}"
SERVER=""
if command -v psql >/dev/null 2>&1; then
  SERVER=$(psql -At -c 'SHOW server_version' 2>/dev/null || true)
  ROWS="{"
  SEP=""
  for t in $TABLES; do
    n=$(psql -At -c "SELECT count(*) FROM \"$SCHEMA\".\"$t\"" 2>/dev/null || echo "")
    case "$n" in ''|*[!0-9]*) n=null ;; esac
    ROWS="$ROWS$SEP\"$t\": $n"
    SEP=", "
  done
  ROWS="$ROWS}"
  note "rows        $ROWS"
else
  note "rows        not counted: psql is not installed (the manifest records rowCounts null)"
  ROWS="null"
fi

cat > "$PGDIR/manifest.mjs" <<'MANIFEST'
import { writeFileSync } from "node:fs";
import path from "node:path";

const e = process.env;
writeFileSync(
  process.argv[2],
  `${JSON.stringify(
    {
      dumpedAt: new Date().toISOString(),
      stamp: e.STAMP,
      connectionFrom: e.SOURCE,
      host: e.PGHOST,
      port: e.PGPORT,
      database: e.PGDATABASE,
      user: e.PGUSER,
      sslmode: e.PGSSLMODE === "" ? null : e.PGSSLMODE,
      schema: e.SCHEMA,
      file: path.basename(e.DUMP),
      bytes: Number(e.BYTES),
      sha256: e.SHA === "" ? null : e.SHA,
      pgDumpVersion: e.PGDUMP_VERSION,
      serverVersion: e.SERVER === "" ? null : e.SERVER,
      rowCounts: JSON.parse(e.ROWS),
      restoreNeeds:
        "the same NOTIFIER_DATA_KEY: every target in this dump is AES-256-GCM under it and every " +
        "lookup column is an HMAC under it (notifier/src/crypto.ts). Restored beside a different " +
        "key every row survives and not one of them can be used.",
      drill: "ops/runbooks/notifier-restore.md",
    },
    null,
    2,
  )}\n`,
);
MANIFEST

SCHEMA="$SCHEMA" DUMP="$DUMP" BYTES="$BYTES" SHA="$SHA" ROWS="$ROWS" SERVER="$SERVER" \
  PGDUMP_VERSION="$(pg_dump --version | head -1)" SOURCE="$SOURCE" STAMP="$STAMP" PGSSLMODE="$PGSSLMODE" \
  node "$PGDIR/manifest.mjs" "$MANIFEST"
note "manifest    $MANIFEST"

echo
echo "BACKUP OK: $COUNT tables, $BYTES bytes."
echo "It is not a backup until it has been restored: ops/runbooks/notifier-restore.md (quarterly, and"
echo "before every notifier database migration or move). Keep NOTIFIER_DATA_KEY with it, offline."
