#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# ops/go-live-app.sh — turn on the Callhouse app services on Railway AFTER the vault is deployed.
#
# Run by the owner, once the vault exists on chain 4663:
#
#   ops/go-live-app.sh --vault 0xVAULT --from-block 61234567 --dry-run   # preflight + plan, no changes
#   ops/go-live-app.sh --vault 0xVAULT --from-block 61234567             # do it
#
# What it does, in order (ops/deploy.md §2, §10, §11, §12, §13 are the reference):
#   0. Preflight: tools, Railway CLI >= 5.47.2 (older CLIs hide sealed variables and this script
#      would re-prompt for KEEPER_PK and skip the relay), Railway login, chain id 4663, the vault
#      address HAS CODE (cast code), its asset() is NVDA, its seaportZone() is itself (the
#      redesigned vault is the zone of its own listings) and its clear() answers, --from-block is a
#      number at or below the head. Refuses otherwise, in --dry-run too.
#   1. Prompts for KEEPER_PK with `read -s` (never echoed, never on a command line, never in a file)
#      and pipes it into `railway variables --set-from-stdin KEEPER_PK`. Skipped when KEEPER_PK is
#      already set on the keeper service (sealed or not), unless --rotate-key.
#   2. indexer: VAULT_ADDRESS + START_BLOCK (+ CLEARINGHOUSE when the vault's clear() is not the
#      default), a Railway domain on port 42069, deploy (detached: its /ready healthcheck waits for
#      the whole backfill).
#   3. web: NEXT_PUBLIC_VAULT + NEXT_PUBLIC_VAULT_FROM_BLOCK + NEXT_PUBLIC_API_URL (the indexer
#      domain) (+ NEXT_PUBLIC_CLEARINGHOUSE as above), PORT=3000, and a REBUILD — NEXT_PUBLIC_* are
#      build-time, a restart would not pick them up.
#   4. relay: deployed only if DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID is set on
#      it (it refuses to boot with no target). If so the keeper gets ALERT_WEBHOOK pointed at it.
#   5. keeper: VAULT (+ CLEARINGHOUSE as above, + KEEPER_PK from step 1), deploy, wait for the
#      healthcheck.
#   6. Checks: keeper /health (inside the container via `railway ssh`, it has no public domain),
#      indexer /ready (polled, 503 = still backfilling), the web page no longer shows
#      "No vault address configured".
#
# Every deploy is built from a fresh clone of origin/main in a temp dir, never from this working
# tree, so uncommitted local edits cannot ship. Pass --ref to deploy another branch/tag/commit.
#
# There is no Overcall anything to set: the redesigned vault sells through the self-hosted fill
# page only (ops/deploy.md §3). The keeper's strike-selection variables (KEEPER_STRIKE_OTM_BPS and
# friends, keeper/README.md → Environment) have defaults and are not touched here; set them on the
# keeper service by hand if the defaults are not wanted.
#
# No secret is stored in this file. RELAY_TOKEN and the keeper's ALERT_WEBHOOK_TOKEN
# (= ${{relay.RELAY_TOKEN}}) were provisioned already; DATABASE_URL is ${{Postgres.DATABASE_URL}}.
# Bash 3.2 compatible (macOS default).
# ---------------------------------------------------------------------------------------------
set -euo pipefail

RW_PROJECT=9988a803-0b8f-4b0e-8ada-ba71e5a505ae     # Railway project "callhouse"
RW_ENV=319fcb44-0e25-4367-947c-09351a349d2e         # production
REPO=leekzor/callhouse
CHAIN_ID=4663
RPC=${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}
APP_URL=${APP_URL:-https://app.callhouse.finance}
RELAY_PRIVATE_URL=http://relay.railway.internal:8080/alert
READY_WAIT_SECS=${READY_WAIT_SECS:-1200}
MIN_RAILWAY_CLI="5.47.2"                             # first release that lists sealed variables (as null)
DEFAULT_CLEAR=0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0   # Overcall's unmodified Clear; the packages' compiled-in default
NVDA=0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec

VAULT=""; FROM_BLOCK=""; DRY_RUN=0; ASSUME_YES=0; ROTATE_KEY=0; SKIP_KEEPER=0; REF=main

usage() {
  sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF
Options:
  --vault 0x...        deployed vault address (required)
  --from-block N       block the vault was deployed in (required; START_BLOCK / NEXT_PUBLIC_VAULT_FROM_BLOCK)
  --dry-run            preflight and print the plan; change nothing
  --ref REF            git ref to deploy (default main)
  --rotate-key         prompt for KEEPER_PK even if one is already set (grant KEEPER_ROLE to the new key FIRST, ops/deploy.md §10.5)
  --skip-keeper        do everything except the keeper
  --yes                do not ask for confirmation
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT=${2:-}; shift 2 ;;
    --vault=*) VAULT=${1#*=}; shift ;;
    --from-block) FROM_BLOCK=${2:-}; shift 2 ;;
    --from-block=*) FROM_BLOCK=${1#*=}; shift ;;
    --ref) REF=${2:-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rotate-key) ROTATE_KEY=1; shift ;;
    --skip-keeper) SKIP_KEEPER=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die()  { echo "REFUSED: $*" >&2; exit 1; }
step() { printf '\n== %s ==\n' "$*"; }
note() { printf '  %s\n' "$*"; }
lc()   { tr '[:upper:]' '[:lower:]'; }

# version_ge A B: true when dotted version A >= B (numeric, up to 4 components)
version_ge() {
  python3 -c 'import sys
a=[int(x) for x in sys.argv[1].split(".")[:4]]; b=[int(x) for x in sys.argv[2].split(".")[:4]]
a+= [0]*(4-len(a)); b+=[0]*(4-len(b)); sys.exit(0 if a>=b else 1)' "$1" "$2"
}

# ---------------------------------------------------------------------------------------------
# 0. Preflight — runs in --dry-run too.
# ---------------------------------------------------------------------------------------------
step "Preflight"
for t in cast railway curl git python3; do command -v "$t" >/dev/null 2>&1 || die "$t is not installed"; done
command -v gh >/dev/null 2>&1 || note "gh not found; will clone with plain git over https"

# Railway CLI 4.54.0 drops sealed variables from `railway variables --json` entirely, so `has_var`
# below would see no KEEPER_PK once it is sealed, re-prompt for the key, skip the relay deploy and
# abort the keeper step. From 5.47.2 sealed variables are listed with a null value (ops/deploy.md §9.15).
rw_ver=$(railway --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+){1,3}' | head -1 || true)
[ -n "$rw_ver" ] || die "could not read the Railway CLI version (railway --version)"
version_ge "$rw_ver" "$MIN_RAILWAY_CLI" \
  || die "Railway CLI $rw_ver is too old: sealed variables are invisible to it. Upgrade to >= $MIN_RAILWAY_CLI (npm i -g @railway/cli, or brew upgrade railway)"
note "railway CLI $rw_ver"

[ -n "$VAULT" ] || { usage >&2; die "--vault is required"; }
[ -n "$FROM_BLOCK" ] || { usage >&2; die "--from-block is required"; }
echo "$VAULT" | grep -Eq '^0x[0-9a-fA-F]{40}$' || die "--vault is not a 20-byte hex address"
echo "$FROM_BLOCK" | grep -Eq '^[0-9]+$' || die "--from-block must be a decimal block number"
[ "$FROM_BLOCK" -gt 0 ] || die "--from-block must be the vault's deploy block, not 0 (a genesis scan is not a backfill)"

chain=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "RPC $RPC did not answer eth_chainId"
[ "$chain" = "$CHAIN_ID" ] || die "RPC $RPC is chain $chain, expected $CHAIN_ID"
note "rpc $RPC -> chain $chain"

code=$(cast code --rpc-url "$RPC" "$VAULT" 2>/dev/null) || die "cast code failed for $VAULT"
if [ -z "$code" ] || [ "$code" = "0x" ]; then
  die "$VAULT has NO CODE on chain $CHAIN_ID. Deploy the vault first (or fix the address)."
fi
note "vault $VAULT has $(( (${#code} - 2) / 2 )) bytes of code"
VAULT=$(cast to-check-sum-address "$VAULT")
# Code alone is not enough: any contract has code. The Callhouse vault exposes asset(), clear() and
# seaportZone(); the asset must be NVDA and the zone must be the vault itself (the redesigned vault is
# the zone of its own PARTIAL_RESTRICTED listings), or this is not our vault.
v_asset=$(cast call --rpc-url "$RPC" "$VAULT" 'asset()(address)' 2>/dev/null | lc || true)
v_zone=$(cast call --rpc-url "$RPC" "$VAULT" 'seaportZone()(address)' 2>/dev/null | lc || true)
v_clear=$(cast call --rpc-url "$RPC" "$VAULT" 'clear()(address)' 2>/dev/null | lc || true)
[ "$v_asset" = "$NVDA" ] \
  || die "$VAULT asset() is '${v_asset:-no answer}', expected NVDA 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"
[ "$v_zone" = "$(echo "$VAULT" | lc)" ] \
  || die "$VAULT seaportZone() is '${v_zone:-no answer}', expected the vault itself — not a redesigned Callhouse vault"
echo "$v_clear" | grep -Eq '^0x[0-9a-f]{40}$' || die "$VAULT clear() gave '${v_clear:-no answer}'"
clear_code=$(cast code --rpc-url "$RPC" "$v_clear" 2>/dev/null) || die "cast code failed for clear() $v_clear"
[ -n "$clear_code" ] && [ "$clear_code" != "0x" ] || die "vault.clear() $v_clear has no code"
if [ "$v_clear" = "$DEFAULT_CLEAR" ]; then
  CLEAR_OVERRIDE=""
  note "vault asset() is NVDA, seaportZone() is the vault, clear() is Overcall's default Clear (no CLEARINGHOUSE override needed)"
else
  CLEAR_OVERRIDE=$(cast to-check-sum-address "$v_clear")
  note "vault asset() is NVDA, seaportZone() is the vault, clear() is OUR OWN Clear $CLEAR_OVERRIDE (CLEARINGHOUSE will be set on every service)"
fi

head=$(cast block-number --rpc-url "$RPC") || die "could not read the chain head"
[ "$FROM_BLOCK" -le "$head" ] || die "--from-block $FROM_BLOCK is above the head $head"
if [ $(( head - FROM_BLOCK )) -lt 2000 ]; then
  note "WARNING: --from-block is within 2000 blocks of the head; RPC nodes lag each other (ops/deploy.md §11.6.2)"
fi
note "head $head, from-block $FROM_BLOCK"

railway whoami >/dev/null 2>&1 || die "railway CLI is not logged in (railway login)"
note "railway: $(railway whoami 2>/dev/null | head -1)"

if [ "$DRY_RUN" = 1 ]; then
  step "Plan (dry run, nothing changed)"
  cat <<EOF
  clone $REPO@$REF into a temp dir; link Railway project $RW_PROJECT env $RW_ENV
  indexer: set VAULT_ADDRESS=$VAULT START_BLOCK=$FROM_BLOCK${CLEAR_OVERRIDE:+ CLEARINGHOUSE=$CLEAR_OVERRIDE}; railway domain --port 42069; railway up --detach
  web:     set NEXT_PUBLIC_VAULT=$VAULT NEXT_PUBLIC_VAULT_FROM_BLOCK=$FROM_BLOCK NEXT_PUBLIC_API_URL=https://<indexer domain> PORT=3000${CLEAR_OVERRIDE:+ NEXT_PUBLIC_CLEARINGHOUSE=$CLEAR_OVERRIDE}; railway up (rebuild)
  relay:   deploy only if a Discord/Telegram target is set on it; then keeper ALERT_WEBHOOK=$RELAY_PRIVATE_URL
  keeper:  $( [ "$SKIP_KEEPER" = 1 ] && echo "SKIPPED (--skip-keeper)" || echo "set VAULT=$VAULT${CLEAR_OVERRIDE:+ CLEARINGHOUSE=$CLEAR_OVERRIDE} (+ KEEPER_PK via read -s if unset); railway up; wait for /health" )
  checks:  keeper /health via railway ssh; indexer /ready (up to ${READY_WAIT_SECS}s); $APP_URL/vault/nvda
  after:   seal KEEPER_PK / RELAY_TOKEN / DISCORD_WEBHOOK_URL / TELEGRAM_BOT_TOKEN in the Railway UI (ops/deploy.md §9.15)
EOF
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  printf '\nGo live against vault %s (from block %s) on Railway production? Type "yes": ' "$VAULT" "$FROM_BLOCK"
  read -r answer
  [ "$answer" = "yes" ] || die "not confirmed"
fi

# ---------------------------------------------------------------------------------------------
# Workspace: a fresh clone, linked to the Railway project. Removed on exit.
# ---------------------------------------------------------------------------------------------
WORK=$(mktemp -d "${TMPDIR:-/tmp}/callhouse-golive.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
step "Clone $REPO@$REF"
if command -v gh >/dev/null 2>&1; then
  gh repo clone "$REPO" "$WORK/callhouse" -- --quiet --no-recurse-submodules
else
  git clone --quiet --no-recurse-submodules "https://github.com/$REPO.git" "$WORK/callhouse"
fi
cd "$WORK/callhouse"
git checkout --quiet "$REF"
note "HEAD $(git rev-parse --short HEAD) $(git log -1 --format=%s | cut -c1-70)"
railway link -p "$RW_PROJECT" -e "$RW_ENV" >/dev/null

# Names of the variables set on a service (values never printed). KEY PRESENCE, not value truthiness:
# a sealed variable is listed with a null value and must still count as set.
var_names() { railway variables --service "$1" --json 2>/dev/null | python3 -c 'import sys,json; print("\n".join(json.load(sys.stdin).keys()))'; }
has_var() { var_names "$1" | grep -qx "$2"; }

latest_status() {
  railway deployment list --service "$1" --json 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["status"] if d else "NONE")'
}
wait_deploy() {  # service timeout_secs
  svc=$1; limit=$2; waited=0
  while :; do
    st=$(latest_status "$svc" || echo UNKNOWN)
    case "$st" in
      SUCCESS) note "$svc deployment SUCCESS"; return 0 ;;
      FAILED|CRASHED|REMOVED|SKIPPED) echo "  $svc deployment $st — railway logs --service $svc" >&2; return 1 ;;
    esac
    [ "$waited" -ge "$limit" ] && { echo "  $svc still $st after ${limit}s" >&2; return 1; }
    sleep 10; waited=$((waited + 10))
  done
}
# Refuse to deploy over a stale Overcall-era variable: the redesigned packages do not read them,
# and a leftover REGISTRY on the keeper would make someone believe a registry is still involved.
refuse_stale() {  # service var...
  svc=$1; shift
  for v in "$@"; do
    has_var "$svc" "$v" && die "$svc still has $v set; the redesigned app does not read it — delete it in Railway and re-run (ops/deploy.md §10.2 / §11.2)"
  done
}

# ---------------------------------------------------------------------------------------------
# 1. The hot key, first, so nothing waits on the prompt later.
# ---------------------------------------------------------------------------------------------
if [ "$SKIP_KEEPER" != 1 ]; then
  step "keeper: KEEPER_PK"
  if has_var keeper KEEPER_PK && [ "$ROTATE_KEY" != 1 ]; then
    note "KEEPER_PK already set on keeper (sealed or not); keeping it (--rotate-key to replace)"
  else
    printf '  Paste KEEPER_PK (hot key, 0x + 64 hex; input hidden): '
    IFS= read -rs KPK; echo
    if ! printf '%s' "$KPK" | grep -Eq '^(0x)?[0-9a-fA-F]{64}$'; then
      KPK=""; unset KPK; die "KEEPER_PK is not 32 bytes of hex (value not shown)"
    fi
    printf '%s' "$KPK" | railway variables --service keeper --set-from-stdin KEEPER_PK --skip-deploys >/dev/null
    KPK=""; unset KPK
    note "KEEPER_PK set. SEAL IT in the Railway UI now (ops/deploy.md §10.2); the CLI cannot seal"
  fi
fi

# ---------------------------------------------------------------------------------------------
# 2. indexer
# ---------------------------------------------------------------------------------------------
step "indexer"
refuse_stale indexer REGISTRY REGISTRY_START_BLOCK OVERCALL_ORDERS_URL OVERCALL_MARKET OVERCALL_FEE_RECIPIENT KEEPER_HMAC_SECRET
if [ -n "$CLEAR_OVERRIDE" ]; then
  railway variables --service indexer --skip-deploys \
    --set "VAULT_ADDRESS=$VAULT" --set "START_BLOCK=$FROM_BLOCK" --set "CLEARINGHOUSE=$CLEAR_OVERRIDE" >/dev/null
else
  railway variables --service indexer --skip-deploys \
    --set "VAULT_ADDRESS=$VAULT" --set "START_BLOCK=$FROM_BLOCK" >/dev/null
fi
has_var indexer DATABASE_SCHEMA && die "DATABASE_SCHEMA is set on indexer; it must stay unset on Railway (ops/deploy.md §11.3)"
INDEXER_HOST=$(railway domain --service indexer --port 42069 --json \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); x=(d.get("domains") or [d.get("domain","")])[0]; print(x.replace("https://","").rstrip("/"))')
[ -n "$INDEXER_HOST" ] || die "could not create/read the indexer domain"
INDEXER_URL="https://$INDEXER_HOST"
note "indexer domain $INDEXER_URL"
railway up --detach --service indexer -m "go-live: vault $VAULT from $FROM_BLOCK" >/dev/null
note "indexer deploy started (healthcheck /ready waits for the backfill)"

# ---------------------------------------------------------------------------------------------
# 3. web — build-time variables, so a rebuild
# ---------------------------------------------------------------------------------------------
step "web"
refuse_stale web OVERCALL_API_BASE NEXT_PUBLIC_REGISTRY
if [ -n "$CLEAR_OVERRIDE" ]; then
  railway variables --service web --skip-deploys \
    --set "NEXT_PUBLIC_VAULT=$VAULT" \
    --set "NEXT_PUBLIC_VAULT_FROM_BLOCK=$FROM_BLOCK" \
    --set "NEXT_PUBLIC_API_URL=$INDEXER_URL" \
    --set "NEXT_PUBLIC_CLEARINGHOUSE=$CLEAR_OVERRIDE" \
    --set "PORT=3000" >/dev/null
else
  railway variables --service web --skip-deploys \
    --set "NEXT_PUBLIC_VAULT=$VAULT" \
    --set "NEXT_PUBLIC_VAULT_FROM_BLOCK=$FROM_BLOCK" \
    --set "NEXT_PUBLIC_API_URL=$INDEXER_URL" \
    --set "PORT=3000" >/dev/null
fi
has_var web KEEPER_ORDERS_URL || note "WARNING: KEEPER_ORDERS_URL is not set on web; the fill page will have no orders (ops/deploy.md §3)"
railway up --ci --service web -m "go-live: NEXT_PUBLIC_VAULT $VAULT"
wait_deploy web 900

# ---------------------------------------------------------------------------------------------
# 4. relay — only when it has somewhere to send
# ---------------------------------------------------------------------------------------------
step "relay"
RELAY_ON=0
if has_var relay DISCORD_WEBHOOK_URL || { has_var relay TELEGRAM_BOT_TOKEN && has_var relay TELEGRAM_CHAT_ID; }; then
  railway up --ci --service relay -m "go-live"
  if wait_deploy relay 300; then RELAY_ON=1; fi
else
  note "no target on relay (set DISCORD_WEBHOOK_URL, or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID); not deployed"
  note "keeper alerts will be logged and stored in SQLite only"
fi

# ---------------------------------------------------------------------------------------------
# 5. keeper
# ---------------------------------------------------------------------------------------------
if [ "$SKIP_KEEPER" != 1 ]; then
  step "keeper"
  refuse_stale keeper REGISTRY SEAPORT_ZONE OVERCALL_FEE_RECIPIENT OVERCALL_ORDERS_URL OVERCALL_MARKET OVERCALL_API_KEY OVERCALL_MAX_ATTEMPTS
  has_var keeper KEEPER_PK || die "KEEPER_PK is not set on keeper"
  set -- --set "VAULT=$VAULT"
  [ -n "$CLEAR_OVERRIDE" ] && set -- "$@" --set "CLEARINGHOUSE=$CLEAR_OVERRIDE"
  [ "$RELAY_ON" = 1 ] && set -- "$@" --set "ALERT_WEBHOOK=$RELAY_PRIVATE_URL"
  railway variables --service keeper --skip-deploys "$@" >/dev/null
  has_var keeper RAILWAY_RUN_UID || note "WARNING: RAILWAY_RUN_UID is not set on keeper; the /data volume mounts root-owned (ops/deploy.md §10.3)"
  has_var keeper RAILWAY_DEPLOYMENT_DRAINING_SECONDS || note "WARNING: RAILWAY_DEPLOYMENT_DRAINING_SECONDS is not set on keeper; SIGTERM is followed by an immediate SIGKILL (ops/deploy.md §9.10)"
  railway up --ci --service keeper -m "go-live: vault $VAULT"
  wait_deploy keeper 600
fi

# ---------------------------------------------------------------------------------------------
# 6. Checks
# ---------------------------------------------------------------------------------------------
step "Checks"
FAIL=0

if [ "$SKIP_KEEPER" != 1 ]; then
  kh=$(railway ssh --service keeper -- node -e 'fetch("http://127.0.0.1:8787/health").then(async r=>{console.log(r.status, await r.text())}).catch(e=>{console.log("ERR", e.message)})' 2>/dev/null || true)
  kstatus=$(printf '%s' "$kh" | python3 -c '
import sys,json
raw=sys.stdin.read().strip(); code,_,body=raw.partition(" ")
try:
    d=json.loads(body); k=d.get("keeper") or {}
    print(code, "status="+str(d.get("status")), "hasKeeperRole="+str(k.get("hasKeeperRole")))
except Exception:
    print(raw[:120] or "no answer")')
  note "keeper /health: $kstatus"
  case "$kstatus" in 200*status=ok*|200*status=degraded*) ;; *) FAIL=1 ;; esac
  case "$kstatus" in *hasKeeperRole=False*) note "  keeper lacks KEEPER_ROLE: run script/Configure.s.sol from the admin key or Safe (ops/deploy.md §10.4)"; FAIL=1 ;; esac
fi

waited=0; rcode=000
while [ "$waited" -le "$READY_WAIT_SECS" ]; do
  rcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$INDEXER_URL/ready" || echo 000)
  [ "$rcode" = 200 ] && break
  sleep 30; waited=$((waited + 30))
done
if [ "$rcode" = 200 ]; then
  note "indexer /ready: 200"
  vh=$(curl -s --max-time 15 "$INDEXER_URL/v1/health" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status"), (d.get("vault") or {}).get("address"))' 2>/dev/null || echo "unreadable")
  note "indexer /v1/health: $vh"
else
  note "indexer /ready: $rcode after ${READY_WAIT_SECS}s (503 = still backfilling; re-check: curl -si $INDEXER_URL/ready)"
  [ "$rcode" = 503 ] || FAIL=1
fi

page=$(curl -s --max-time 20 -w '\n%{http_code}' "$APP_URL/vault/nvda" || true)
pcode=$(printf '%s' "$page" | tail -n1)
if [ "$pcode" != 200 ]; then
  WEB_HOST=$(railway domain --service web --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("domains") or [d.get("domain","")])[0])')
  note "$APP_URL answered $pcode; trying $WEB_HOST"
  page=$(curl -s --max-time 20 -w '\n%{http_code}' "$WEB_HOST/vault/nvda" || true)
  pcode=$(printf '%s' "$page" | tail -n1)
fi
if [ "$pcode" = 200 ] && ! printf '%s' "$page" | grep -q "No vault address configured"; then
  note "web /vault/nvda: 200, vault configured"
else
  note "web /vault/nvda: $pcode$(printf '%s' "$page" | grep -q 'No vault address configured' && echo ', STILL shows "No vault address configured"')"
  FAIL=1
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "GO-LIVE OK"
  echo "Next: seal KEEPER_PK / RELAY_TOKEN / DISCORD_WEBHOOK_URL / TELEGRAM_BOT_TOKEN in the Railway UI; run ops/deploy.md §9 item 14 (web -> keeper) and §12.4 (keeper -> relay); stand up the two external monitors (ops/alerts.md §11, §25)."
else
  echo "GO-LIVE INCOMPLETE — see the lines above"; exit 1
fi
