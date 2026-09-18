#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# ops/go-live-v2.sh — create, configure and deploy the Stonkhouse v2 services on Railway, AFTER
# the v2 contracts are deployed and written back into the registry.
#
# Run by the owner (ops/deploy.md §15 is the reference; §15.8 has a recorded dry run):
#
#   ops/go-live-v2.sh                                    # DRY RUN (the default): preflight + every command
#   ops/go-live-v2.sh --apply --ref <reviewed-SHA>       # do it (asks for a typed "yes")
#   ops/go-live-v2.sh --apply --ref <reviewed-SHA> --services cranker  # one service
#   ops/go-live-v2.sh --apply --ref <reviewed-SHA> --services web      # flip app.stonkhouse.fun to v2
#
# Services, in this order (the order is fixed; --services selects from it):
#   relay       existing; requires RELAY_TOKEN and a Discord/Telegram target before alert producers deploy
#   indexer-v2  indexer/Dockerfile, shared Postgres, generated public domain, /ready
#   pricing     keeper/Dockerfile V2_MODE=pricing, private only
#   cranker     keeper/Dockerfile V2_MODE=cranker, /data volume, replicas 1, CRANKER_PK
#   pricer      keeper/Dockerfile V2_MODE=pricer, /data volume, replicas 1, PRICER_PK
#   mm-bot      keeper/Dockerfile V2_MODE=mm, /data volume, replicas 1, MM_QUOTER_PK + MM_KILL_TOKEN, NO public domain
#   notifier    notifier/Dockerfile, schema notifier on the shared Postgres, notify.stonkhouse.fun
#   web         only with --services …,web: NEXT_PUBLIC_V2=1 + the two API URLs, then a REBUILD
#
# PREFLIGHT (runs in the dry run too, and refuses in both):
#   - registry v2 is deployed: v2.deployBlock and every v2.contracts address set (sources.dataStreams
#     may stay null: DataStreamsSource ships disabled, C2-12), v2.bots set for each selected bot;
#   - ops/v2/env/*.env equal what ops/v2-env.mjs renders from the registry (--check), and every
#     assignment the selected services take is non-empty; the apply run also compares this render
#     with the reviewed clone and takes Railway public values from that clone;
#     build-markets.mjs --check is green;
#   - on chain (skip with --offline, dry run only): chain 4663, code at every contract, the deploy
#     block behind the head; bot gas and roles are reported (warnings: a role grant is the admin's);
#   - a bot key file ~/.callhouse-keys/v2/<bot>.env, when present, is mode 600 and derives to the
#     registry's v2.bots address.
#   Repository shape (keeper/Dockerfile ships the registry, notifier/Dockerfile exists, web/Dockerfile
#   declares the v2 build ARGs, web/lib/markets.generated.ts carries the deployed addresses) is
#   reported by the dry run as "WILL REFUSE at --apply" and enforced at --apply against the clone
#   that is actually built.
#
# SECRETS never appear on a command line or in a file this writes. Each is set only when the
# service does not already have it (sealed or not): bot keys from ~/.callhouse-keys/v2/<bot>.env
# (ops/v2/derive-bot-keys.sh) after checking the derived address, or pasted with `read -rs` and
# checked the same way; PONDER_RPC_URL_4663, MM_KILL_TOKEN, NOTIFIER_DATA_KEY, TELEGRAM_BOT_TOKEN and the VAPID
# pair pasted with `read -rs`; both go to Railway through `railway variables --set-from-stdin`.
# RELAY_TOKEN, the relay's targets and SMTP_URL are expected on Railway already. DATABASE_URL and
# ALERT_WEBHOOK_TOKEN are Railway reference variables (${{Postgres.DATABASE_URL}},
# ${{relay.RELAY_TOKEN}}), not values.
#
# IDEMPOTENT: re-running creates nothing twice (service, volume, domain are looked up first),
# re-sets the same public values, keeps every secret already set (--rotate-keys to replace the bot
# keys: grant the role to the new key FIRST) and redeploys the selected services. The signing bots
# are not redeployed between 15:40 and 16:20 New York time on a weekday (the daily expiry's
# snapshot window, ops/deploy.md §15.3) unless --ignore-expiry-window. A relay-only apply prepares
# alert references on existing services and reports an incomplete run if any live service needs a redeploy.
#
# Every deploy is built from a fresh clone at an explicit commit SHA in a temp dir, never from this working
# tree, and that clone's ops/markets/tier1.json must equal the registry planned against: the bots
# read the copy baked into their image. What the CLI cannot do (seal, healthcheck path, restart
# policy, DNS) is printed as a TODO. There are no GitHub watch paths on these reviewed CLI uploads;
# code or registry changes require a new reviewed --ref and manual redeploy. Nothing here sends a chain transaction.
# Bash 3.2 compatible (macOS default).
# ---------------------------------------------------------------------------------------------
set -euo pipefail

RW_PROJECT=9988a803-0b8f-4b0e-8ada-ba71e5a505ae     # Railway project "callhouse"
RW_ENV=319fcb44-0e25-4367-947c-09351a349d2e         # production
REPO=stonkhousedotfun/callhouse
CHAIN_ID=4663
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEFAULT_REGISTRY="$HERE/markets/tier1.json"
KEYS_DIR="${CALLHOUSE_V2_KEYS_DIR:-$HOME/.callhouse-keys/v2}"
RPC=${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}
export ETH_RPC_URL="$RPC"                                # cast reads this without putting a keyed URL in argv
APP_URL=${APP_URL:-https://app.stonkhouse.fun}
NOTIFIER_DOMAIN=notify.stonkhouse.fun
RELAY_PRIVATE_URL=http://relay.railway.internal:8080/alert
READY_WAIT_SECS=${READY_WAIT_SECS:-1200}
DEPLOY_WAIT_SECS=${DEPLOY_WAIT_SECS:-900}
MIN_RAILWAY_CLI="5.47.2"                             # first release that lists sealed variables (as null)
MIN_BOT_WEI=10000000000000000                        # 0.01 ETH, the bots' KEEPER_MIN_GAS_WEI default

ORDER="relay indexer-v2 pricing cranker pricer mm-bot notifier web"
# mm-bot is NOT here: every other service reads or cranks, while the MM bot puts the vault's
# inventory on the book, and with MM_MARKETS unset and the bot caps at 0 it quotes every live
# market up to the vault's own limits. What it should quote, and how much, is the canary runbook
# (O2-04 ops/runbooks/v2-canary.md). Name it explicitly once that has been read.
DEFAULT_SERVICES="relay indexer-v2 pricing cranker pricer notifier"

# service    dockerfile          port   health   timeout drain volume public     bot       keyvar
TABLE="
relay        relay/Dockerfile    8080   /health  60      12    -      none       -         -
indexer-v2   indexer/Dockerfile  42069  /ready   3600    30    -      generated  -         -
pricing      keeper/Dockerfile   8790   /health  120     30    -      none       -         -
cranker      keeper/Dockerfile   8792   /health  300     120   /data  none       cranker   CRANKER_PK
pricer       keeper/Dockerfile   8794   /health  300     120   /data  none       pricer    PRICER_PK
mm-bot       keeper/Dockerfile   8793   /health  300     120   /data  forbidden  mmQuoter  MM_QUOTER_PK
notifier     notifier/Dockerfile 8791   /health  60      30    -      custom     -         -
web          web/Dockerfile      3000   /        120     -     -      custom     -         -
"
DOCKERFILE=2; PORT_COL=3; HEALTH=4; TIMEOUT=5; DRAIN=6; VOLUME=7; PUBLIC=8; BOT=9; KEYVAR=10
col() { printf '%s\n' "$TABLE" | awk -v s="$1" -v c="$2" '$1 == s { print $c }'; }

REGISTRY="$DEFAULT_REGISTRY"; APPLY=0; OFFLINE=0; ASSUME_YES=0; ROTATE_KEYS=0; IGNORE_WINDOW=0; REF=main; SERVICES=""

usage() {
  sed -n '3,56p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF
Options:
  --apply                   create/update services, set variables and deploy (default: dry run)
  --services a,b            which services, from: $ORDER
                            (default: $DEFAULT_SERVICES; web and mm-bot must be named)
  --ref REF                 full reviewed commit SHA for --apply (dry run defaults to main)
  --registry FILE           plan against another registry (a rehearsal copy); dry run only
  --offline                 skip the chain reads and build-markets.mjs --check; dry run only
  --rotate-keys             set the bot keys even if the services already have them
  --ignore-expiry-window    redeploy the signing bots inside 15:40-16:20 New York time
  --yes                     skip the typed confirmation
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --services) SERVICES=${2:-}; shift 2 ;;
    --services=*) SERVICES=${1#*=}; shift ;;
    --ref) REF=${2:-}; shift 2 ;;
    --registry) REGISTRY=${2:-}; shift 2 ;;
    --registry=*) REGISTRY=${1#*=}; shift ;;
    --offline) OFFLINE=1; shift ;;
    --rotate-keys) ROTATE_KEYS=1; shift ;;
    --ignore-expiry-window) IGNORE_WINDOW=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die()  { echo "REFUSED: $*" >&2; exit 1; }
[ "$APPLY" != 1 ] || [[ "$REF" =~ ^[0-9a-f]{40}$ ]] \
  || die "--apply requires --ref with the full 40-character reviewed commit SHA (ops/deploy.md §15.7)"
step() { printf '\n== %s ==\n' "$*"; }
note() { printf '  %s\n' "$*"; }
lc()   { tr '[:upper:]' '[:lower:]'; }
# A command the plan would run, copyable: the first argument, then continuation fragments (joined
# with backslash-newlines), then any argument starting with "#" as a comment line under it.
show() {
  cmd=$1; shift; parts=""; comments=""
  for l in "$@"; do case "$l" in '#'*) comments="$comments$l
" ;; *) parts="$parts$l
" ;; esac; done
  if [ -z "$parts" ]; then printf '  $ %s\n' "$cmd"
  else
    printf '  $ %s \\\n' "$cmd"
    printf '%s' "$parts" | sed '$!s/$/ \\/' | sed 's/^/      /'
  fi
  [ -z "$comments" ] || printf '%s' "$comments" | sed 's/^/    /'
}

version_ge() {
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").slice(0,4).map(Number));while(a.length<4)a.push(0);while(b.length<4)b.push(0);for(let i=0;i<4;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}process.exit(0)' "$1" "$2"
}
# reg 'expr': one value out of the registry (r); the path goes through the environment.
reg() { REG="$REGISTRY" node -e "const r=JSON.parse(require('fs').readFileSync(process.env.REG,'utf8'));const v=($1);process.stdout.write(v==null?'':String(v))"; }
in_list() { printf '%s\n' $2 | grep -qx "$1"; }
selected() { in_list "$1" "$SERVICES"; }

# ---------------------------------------------------------------------------------------------
# 0. Preflight — runs in the dry run too.
# ---------------------------------------------------------------------------------------------
step "Preflight$( [ "$APPLY" = 1 ] && echo ' (--apply)' || echo ' (dry run: nothing is changed)')"
command -v node >/dev/null 2>&1 || die "node is not installed"

if [ -z "$SERVICES" ]; then SERVICES="$DEFAULT_SERVICES"; else SERVICES=$(printf '%s' "$SERVICES" | tr ',' ' '); fi
for s in $SERVICES; do in_list "$s" "$ORDER" || die "unknown service '$s' (one of: $ORDER)"; done
ordered=""; for s in $ORDER; do selected "$s" && ordered="$ordered $s"; done; SERVICES="${ordered# }"
note "services: $SERVICES"
selected web || note "web: not selected (add web to --services to flip $APP_URL to v2; §15.5)"
if selected mm-bot; then
  CANARY="$HERE/runbooks/v2-canary.md"
  if [ -f "$CANARY" ]; then note "mm-bot: selected; its MM_* caps come from ops/runbooks/v2-canary.md, read it before --apply"
  else note "WARNING: mm-bot is selected and ops/runbooks/v2-canary.md does not exist (O2-04). Unset MM_* means MM_MARKETS empty (every live market) and the bot caps at 0 (the vault limits alone). Set MM_MARKETS and the caps on Railway before this bot quotes"; fi
fi

[ -f "$REGISTRY" ] || die "registry not found: $REGISTRY"
REGISTRY="$(cd "$(dirname "$REGISTRY")" && pwd)/$(basename "$REGISTRY")"
REHEARSAL=0
if [ "$REGISTRY" != "$DEFAULT_REGISTRY" ]; then
  REHEARSAL=1
  [ "$APPLY" = 1 ] && die "--registry is for planning against a rehearsal copy; --apply deploys ops/markets/tier1.json only"
  note "REHEARSAL: planning against $REGISTRY, not ops/markets/tier1.json"
fi
[ "$OFFLINE" = 1 ] && [ "$APPLY" = 1 ] && die "--offline skips the chain checks; never with --apply"

needs=""
[ "$OFFLINE" = 1 ] || needs="cast"
[ "$APPLY" = 1 ] && needs="$needs railway git curl"
for t in $needs; do command -v "$t" >/dev/null 2>&1 || die "$t is not installed"; done
if command -v railway >/dev/null 2>&1; then
  rw_ver=$(railway --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+){1,3}' | head -1 || true)
  if [ -n "$rw_ver" ] && version_ge "$rw_ver" "$MIN_RAILWAY_CLI"; then
    note "railway CLI $rw_ver"
  elif [ "$APPLY" = 1 ]; then
    die "Railway CLI ${rw_ver:-unknown} is too old: sealed variables are invisible to it. Upgrade to >= $MIN_RAILWAY_CLI"
  else
    note "WARNING: railway CLI ${rw_ver:-unknown} is older than $MIN_RAILWAY_CLI; --apply will refuse it"
  fi
fi
if [ "$APPLY" = 1 ]; then
  railway whoami >/dev/null 2>&1 || die "railway CLI is not logged in (railway login)"
  note "railway: $(railway whoami 2>/dev/null | head -1)"
fi

# ---- the registry: is v2 deployed? ----
PROBLEMS=$(REG="$REGISTRY" SERVICES="$SERVICES" node -e '
const r = JSON.parse(require("fs").readFileSync(process.env.REG, "utf8"));
const sel = new Set(process.env.SERVICES.split(" "));
const out = [];
const v2 = r.v2;
if (!v2 || typeof v2 !== "object") { console.log("the registry has no top-level v2 block"); process.exit(0); }
if (v2.deployBlock === null || v2.deployBlock === undefined) out.push("v2.deployBlock is null");
const names = ["clearinghouse","orderBook","settlementOracle","expiryCalendar","keeperRewards","autoRoller","payoutAdapter","makerVault","makerRegistry","rewardsDistributor"];
for (const k of names) if (!v2.contracts || !v2.contracts[k]) out.push(`v2.contracts.${k} is null`);
for (const k of ["chainlink","univ3"]) if (!v2.contracts?.sources?.[k]) out.push(`v2.contracts.sources.${k} is null`);
const bots = { cranker: "cranker", pricer: "pricer", "mm-bot": "mmQuoter" };
for (const [svc, bot] of Object.entries(bots)) if (sel.has(svc) && !v2.bots?.[bot]) out.push(`v2.bots.${bot} is null (ops/v2/derive-bot-keys.sh)`);
console.log(out.join("\n"));
')
if [ -n "$PROBLEMS" ]; then
  echo "REFUSED: the registry's v2 deployment is not complete; run the v2 deploy write-back (contracts script/v2/DeployV2Batch.sh) first:" >&2
  printf '%s\n' "$PROBLEMS" | sed 's/^/  /' >&2
  exit 1
fi
DEPLOY_BLOCK=$(reg 'r.v2.deployBlock')
note "registry v2: interface version $(reg 'r.v2.interfaceVersion'), deploy block $DEPLOY_BLOCK, clearinghouse $(reg 'r.v2.contracts.clearinghouse')"
[ -n "$(reg 'r.v2.contracts.sources.dataStreams')" ] || note "v2.contracts.sources.dataStreams is null: fine, DataStreamsSource ships disabled (C2-12)"
LIVE=$(reg 'r.markets.filter(m=>m.v2&&m.v2.status==="live").map(m=>m.ticker).join(" ")')
if [ -n "$LIVE" ]; then note "v2 live markets: $LIVE"; else note "WARNING: no market has v2.status live; the bots will boot and idle (RegisterMarkets first, ops/runbooks/v2-canary.md)"; fi

# ---- the env files ----
ENV_OUT=$(mktemp -d "${TMPDIR:-/tmp}/callhouse-v2env.XXXXXX")
WORK=""
cleanup() { rm -rf "$ENV_OUT"; [ -z "$WORK" ] || rm -rf "$WORK"; }
trap cleanup EXIT
if [ "$REHEARSAL" = 0 ]; then
  node "$HERE/v2-env.mjs" --check >/dev/null || die "ops/v2/env is out of date with the registry: run node ops/v2-env.mjs and commit"
  note "ops/v2/env/*.env match the registry (v2-env.mjs --check)"
fi
node "$HERE/v2-env.mjs" --registry "$REGISTRY" --out "$ENV_OUT" >/dev/null
for s in $SERVICES; do
  [ -f "$ENV_OUT/$s.env" ] || continue
  empty=$(grep -E '^[A-Z0-9_]+=$' "$ENV_OUT/$s.env" | cut -d= -f1 | tr '\n' ' ' || true)
  [ -z "$empty" ] || die "$s.env renders empty values for: $empty"
done
note "env rendered for: $(cd "$ENV_OUT" && ls *.env | sed 's/\.env$//' | tr '\n' ' ' | sed 's/ $//')"

if [ "$OFFLINE" = 0 ] && [ "$REHEARSAL" = 0 ]; then
  node "$HERE/markets/build-markets.mjs" --check >/dev/null 2>&1 \
    || die "node ops/markets/build-markets.mjs --check is not green; run it and fix what it prints"
  note "build-markets.mjs --check green"
fi

# ---- the chain ----
if [ "$OFFLINE" = 1 ]; then
  note "--offline: chain checks skipped (code at each contract, deploy block, bot gas and roles)"
else
  chain=$(cast chain-id 2>/dev/null) || die "RPC endpoint did not answer eth_chainId"
  [ "$chain" = "$CHAIN_ID" ] || die "RPC endpoint is chain $chain, expected $CHAIN_ID"
  head=$(cast block-number 2>/dev/null) || die "could not read the chain head"
  [ "$DEPLOY_BLOCK" -le "$head" ] || die "v2.deployBlock $DEPLOY_BLOCK is above the head $head"
  for k in clearinghouse orderBook settlementOracle expiryCalendar keeperRewards autoRoller payoutAdapter makerVault makerRegistry rewardsDistributor sources.chainlink sources.univ3; do
    a=$(reg "r.v2.contracts.$k")
    code=$(cast code "$a" 2>/dev/null || true)
    { [ -n "$code" ] && [ "$code" != "0x" ]; } || die "v2.contracts.$k $a has NO CODE on chain $CHAIN_ID"
  done
  note "chain $chain head $head: code at all 12 contract addresses"
  for pair in "cranker:cranker:" "pricer:pricer:PRICER_ROLE:autoRoller" "mm-bot:mmQuoter:QUOTER_ROLE:makerVault"; do
    svc=${pair%%:*}; rest=${pair#*:}; bot=${rest%%:*}; rest=${rest#*:}; role=${rest%%:*}; on=${rest#*:}
    selected "$svc" || continue
    addr=$(reg "r.v2.bots.$bot")
    wei=$(cast balance "$addr" 2>/dev/null || echo 0)
    if [ "$(node -e 'process.stdout.write(BigInt(process.argv[1])>=BigInt(process.argv[2])?"1":"0")' "$wei" "$MIN_BOT_WEI")" = 1 ]; then
      note "$bot $addr holds $wei wei"
    else
      note "WARNING: $bot $addr holds $wei wei, under 0.01 ETH: fund it before the service is useful (§15.6)"
    fi
    if [ -n "$role" ]; then
      target=$(reg "r.v2.contracts.$on")
      has=$(cast call "$target" 'hasRole(bytes32,address)(bool)' "$(cast keccak "$role")" "$addr" 2>/dev/null || echo "unreadable")
      [ "$has" = "true" ] && note "$bot holds $role on $on" \
        || note "WARNING: $bot $addr $role on $on is '$has': the admin grants it (contracts script/v2), or $svc's transactions revert"
    fi
  done
fi

# ---- bot keys already on disk ----
key_file_address() {  # file var -> the address the key derives to ("" when unusable); the key goes through the environment only
  KPK="$(sed -n "s/^$2=//p" "$1" | head -1)" NODE_PATH="$ROOT/keeper/node_modules" \
    node -e "const {privateKeyToAccount}=require('viem/accounts');const k=process.env.KPK.trim();process.stdout.write(privateKeyToAccount(k.startsWith('0x')?k:'0x'+k).address)" 2>/dev/null || true
}
for svc in cranker pricer mm-bot; do
  selected "$svc" || continue
  bot=$(col "$svc" $BOT); var=$(col "$svc" $KEYVAR); file="$KEYS_DIR/$bot.env"
  want=$(reg "r.v2.bots.$bot")
  if [ -f "$file" ]; then
    perms=$(stat -f '%Lp' "$file" 2>/dev/null || stat -c '%a' "$file")
    [ "$perms" = "600" ] || die "$file is mode $perms, must be 600"
    [ "$(grep -c "^$var=" "$file" || true)" = "1" ] || die "$file must hold exactly one $var line"
    got=$(key_file_address "$file" "$var")
    [ -n "$got" ] || die "$file does not hold a usable key (or keeper/node_modules is missing: pnpm install)"
    [ "$(printf '%s' "$got" | lc)" = "$(printf '%s' "$want" | lc)" ] || die "$file derives to $got, but registry v2.bots.$bot is $want"
    note "$var: $file derives to v2.bots.$bot $want"
  else
    note "$var: no $file; --apply keeps the value already on $svc, or asks for it with read -rs and checks it derives to $want"
  fi
done

# ---- repository shape: what the images will be built from ----
repo_shape() {  # dir -> one line per problem
  d=$1
  if selected pricing || selected cranker || selected pricer || selected mm-bot; then
    grep -Eq '^COPY .*ops/markets/tier1\.json' "$d/keeper/Dockerfile" \
      || echo "keeper/Dockerfile does not COPY ops/markets/tier1.json into the runner: the bots boot without a registry (ops/deploy.md §15.2)"
    grep -Eq '^!ops/markets/tier1\.json' "$d/.dockerignore" \
      || echo ".dockerignore keeps ops/markets/tier1.json out of the build context (ops/deploy.md §15.2)"
  fi
  if selected notifier; then
    [ -f "$d/notifier/Dockerfile" ] || echo "notifier/Dockerfile does not exist (N2-01)"
  fi
  if selected web; then
    for a in NEXT_PUBLIC_V2 NEXT_PUBLIC_NOTIFIER_URL; do
      grep -Eq "^ARG $a" "$d/web/Dockerfile" || echo "web/Dockerfile declares no ARG $a: the build silently drops it (ops/deploy.md §3, §15.5)"
    done
    REG="$REGISTRY" GEN="$d/web/lib/markets.generated.ts" node -e '
      const fs = require("fs");
      const r = JSON.parse(fs.readFileSync(process.env.REG, "utf8"));
      const gen = fs.readFileSync(process.env.GEN, "utf8");
      const i = gen.indexOf("export const V2_CONTRACTS");
      const block = i < 0 ? "" : gen.slice(i, gen.indexOf("as const;", i));
      const c = r.v2.contracts;
      const want = [c.clearinghouse, c.orderBook, c.settlementOracle, c.makerVault, c.autoRoller].filter(Boolean);
      if (!want.every((a) => block.toLowerCase().includes(a.toLowerCase())))
        console.log("web/lib/markets.generated.ts does not carry the deployed v2 addresses: pnpm --filter @callhouse/web gen:markets, commit");
    '
  fi
}
if selected web && grep -q 'process.env.NEXT_PUBLIC_API_URL' "$ROOT/web/lib/api.ts" 2>/dev/null \
   && grep -q 'process.env.NEXT_PUBLIC_API_URL' "$ROOT/web/lib/v2/api.ts" 2>/dev/null; then
  note "WARNING: web/lib/api.ts (the v1 vault history under /legacy) and web/lib/v2/api.ts read the same NEXT_PUBLIC_API_URL;"
  note "  pointed at indexer-v2, the /legacy history panels answer 'unavailable' (indexer-v2 has no VAULT_ADDRESS). §15.5"
fi
SHAPE=$(repo_shape "$ROOT")
if [ -n "$SHAPE" ]; then
  if [ "$APPLY" = 1 ]; then
    note "this working tree: $(printf '%s\n' "$SHAPE" | wc -l | tr -d ' ') problem(s); the clone of $REF is checked again below"
  else
    printf '%s\n' "$SHAPE" | sed 's/^/  WILL REFUSE at --apply (checked on the clone of the ref): /'
  fi
fi

# ---------------------------------------------------------------------------------------------
# Railway state (--apply only). Names and settings, never values: `railway variables --json` is
# reduced to its keys before anything is printed, and a sealed variable counts as set.
# ---------------------------------------------------------------------------------------------
services_json() { railway service list --json 2>/dev/null; }
svc_query() {  # service 'expr over s (the service row, or undefined)'
  local data
  data=$(services_json) || return 1
  printf '%s' "$data" | SVC="$1" node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let rows;try{rows=JSON.parse(d)}catch{process.exit(1)}if(!Array.isArray(rows))process.exit(1);const s=rows.find(x=>x.name===process.env.SVC);const v=($2);process.stdout.write(v==null?'':String(v))})"
}
service_exists() {
  local id
  id=$(svc_query "$1" 's&&s.id') || die "could not read Railway service list"
  [ -n "$id" ]
}
var_names() {
  local data
  data=$(railway variables --service "$1" --json 2>/dev/null) || return 1
  printf '%s' "$data" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(1)}if(v===null||typeof v!=="object"||Array.isArray(v))process.exit(1);console.log(Object.keys(v).join("\n"))})'
}
has_var() {
  local names
  names=$(var_names "$1") || die "could not read Railway variable names for $1"
  printf '%s\n' "$names" | grep -qx "$2"
}
domains_of() {
  local data
  data=$(railway domain list --service "$1" --json 2>/dev/null) || return 1
  printf '%s' "$data" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(1)}if(v===null||typeof v!=="object"||!Array.isArray(v.domains))process.exit(1);for(const x of v.domains){if(typeof x?.type!=="string"||typeof x?.domain!=="string")process.exit(1);console.log(x.type+" "+x.domain)}})'
}
latest_status() { svc_query "$1" 's&&s.latestDeployment?s.latestDeployment.status:"NONE"'; }
latest_deployment_record() { # service -> id|status from Railway's newest deployment
  local data
  data=$(railway deployment list --service "$1" --json 2>/dev/null) || return 1
  printf '%s' "$data" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let rows;try{rows=JSON.parse(s)}catch{process.exit(1)}if(!Array.isArray(rows))process.exit(1);const x=rows[0];if(!x){console.log("NONE|NONE");return}if(typeof x.id!=="string"||!x.id||typeof x.status!=="string")process.exit(1);console.log(x.id+"|"+x.status)})'
}
wait_new_deploy() { # service previous_id timeout_secs; an old healthy deployment does not satisfy this gate
  local svc=$1 previous=$2 limit=$3 waited=0 record id st
  while :; do
    record=$(latest_deployment_record "$svc") || die "could not read Railway deployments for $svc"
    id=${record%%|*}; st=${record#*|}
    if [ "$id" != NONE ] && [ "$id" != "$previous" ]; then
      case "$st" in
        SUCCESS) note "$svc new deployment $id SUCCESS"; return 0 ;;
        FAILED|CRASHED|REMOVED|SKIPPED) echo "  $svc new deployment $id $st — railway logs --service $svc" >&2; return 1 ;;
      esac
    fi
    [ "$waited" -ge "$limit" ] && { echo "  $svc new deployment not successful after ${limit}s (latest $id $st)" >&2; return 1; }
    sleep 10; waited=$((waited + 10))
  done
}
in_expiry_window() {  # weekday 15:40-16:20 America/New_York
  dow=$(TZ=America/New_York date +%u); hm=$(TZ=America/New_York date +%H%M)
  [ "$dow" -le 5 ] && [ "$hm" -ge 1540 ] && [ "$hm" -le 1620 ]
}

# ---------------------------------------------------------------------------------------------
# One step each. Dry run: print the command. --apply: look, then act only on what is missing.
# ---------------------------------------------------------------------------------------------
ensure_service() {
  svc=$1
  if [ "$APPLY" != 1 ]; then
    if [ "$svc" = web ]; then note "web: existing service required; --apply refuses a connected repo or image source"
    else show "railway add --service $svc" "# only if the service does not exist; --apply refuses a connected repo or image source"; fi
    return
  fi
  if service_exists "$svc"; then note "service $svc exists"
  elif [ "$svc" = web ]; then die "web service does not exist in this Railway environment; configure its public domain before the v2 flip"
  else railway add --service "$svc" >/dev/null; note "service $svc created"; fi
  # CLI uploads use the reviewed --ref clone. A connected source could later auto-deploy
  # public main or an image and bypass that SHA, the registry comparison and the time guard.
  source_repo=$(svc_query "$svc" 's&&s.source&&s.source.repo') || die "could not read Railway source for $svc"
  source_image=$(svc_query "$svc" 's&&s.source&&s.source.image') || die "could not read Railway image source for $svc"
  [ -z "$source_repo" ] && [ -z "$source_image" ] \
    || die "$svc has a connected Railway repo or image source; disconnect it in the UI before a reviewed CLI upload, then re-run"
  if [ "$(col "$svc" $VOLUME)" != "-" ] || [ "$svc" = indexer-v2 ] || [ "$svc" = notifier ]; then
    n=$(svc_query "$svc" 's&&s.replicas?s.replicas.configured:1') || die "could not read Railway replica count for $svc"
    [ "${n:-1}" -le 1 ] || die "$svc has $n replicas configured; it must run exactly one (ops/deploy.md §15.1). Set 1 in the UI and re-run"
  fi
}

# Variables: Railway settings + the rendered env file + reference variables. Public values only.
set_variables() {
  svc=$1; relay_on=$2
  SETS=("RAILWAY_DOCKERFILE_PATH=$(col "$svc" $DOCKERFILE)" "RAILWAY_HEALTHCHECK_TIMEOUT_SEC=$(col "$svc" $TIMEOUT)")
  [ "$(col "$svc" $DRAIN)" = "-" ] || SETS+=("RAILWAY_DEPLOYMENT_DRAINING_SECONDS=$(col "$svc" $DRAIN)")
  [ "$(col "$svc" $VOLUME)" = "-" ] || SETS+=("RAILWAY_RUN_UID=0")
  case "$svc" in indexer-v2|notifier) SETS+=('DATABASE_URL=${{Postgres.DATABASE_URL}}') ;; esac
  if [ -f "$ENV_OUT/$svc.env" ]; then
    while IFS= read -r line; do
      case "$line" in
        ''|'#'*) continue ;;
        ALERT_WEBHOOK=*) [ "$relay_on" = 0 ] && continue; SETS+=("$line") ;;
        *=*) SETS+=("$line") ;;
      esac
    done < "$ENV_OUT/$svc.env"
    if grep -q '^ALERT_WEBHOOK=' "$ENV_OUT/$svc.env" && [ "$relay_on" != 0 ]; then SETS+=('ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}'); fi
  fi
  if [ "$APPLY" != 1 ]; then
    lines=()
    for kv in "${SETS[@]}"; do case "$kv" in *'$'*) lines+=("--set '$kv'") ;; *) lines+=("--set $kv") ;; esac; done
    c="# Railway settings"
    [ -f "$ENV_OUT/$svc.env" ] && c="$c + every assignment in ops/v2/env/$svc.env"
    { [ -f "$ENV_OUT/$svc.env" ] && grep -q '^ALERT_WEBHOOK=' "$ENV_OUT/$svc.env"; } && c="$c; ALERT_WEBHOOK and its token only when the relay is deployed"
    show "railway variables --service $svc --skip-deploys" "${lines[@]}" "$c"
    return 0
  fi
  ARGS=(); for kv in "${SETS[@]}"; do ARGS+=(--set "$kv"); done
  railway variables --service "$svc" --skip-deploys "${ARGS[@]}" >/dev/null
  note "${#SETS[@]} variables set on $svc"
}

# A secret pasted by the operator: hidden, format-checked, piped to Railway, forgotten.
prompted_secret() {  # svc VAR regex "where it comes from"
  svc=$1; var=$2; re=$3; how=$4
  if [ "$APPLY" != 1 ]; then
    show "railway variables --service $svc --set-from-stdin $var --skip-deploys" "# only if $var is unset on $svc; value pasted with read -rs: $how"
    return
  fi
  if has_var "$svc" "$var"; then note "$var already set on $svc (sealed or not); keeping it"; return; fi
  [ -t 0 ] || die "$var is not set on $svc and stdin is not a terminal to read it from"
  printf '  %s for %s (%s; input hidden): ' "$var" "$svc" "$how"
  IFS= read -rs SECRET; echo
  if ! printf '%s' "$SECRET" | grep -Eq "$re"; then SECRET=""; die "$var does not have the expected shape (value not shown)"; fi
  printf '%s' "$SECRET" | railway variables --service "$svc" --set-from-stdin "$var" --skip-deploys >/dev/null
  SECRET=""
  note "$var set on $svc. SEAL IT in the Railway UI now (ops/deploy.md §9.15)"
}

# A bot key: from ~/.callhouse-keys/v2/<bot>.env or read -rs, and only if it derives to v2.bots.<bot>.
bot_key() {
  svc=$1; bot=$(col "$svc" $BOT); var=$(col "$svc" $KEYVAR); file="$KEYS_DIR/$bot.env"; want=$(reg "r.v2.bots.$bot")
  if [ "$APPLY" != 1 ]; then
    show "railway variables --service $svc --set-from-stdin $var --skip-deploys" \
      "# only if $var is unset on $svc (or --rotate-keys); from $file, else read -rs; must derive to $want"
    return
  fi
  if has_var "$svc" "$var" && [ "$ROTATE_KEYS" != 1 ]; then note "$var already set on $svc (sealed or not); keeping it (--rotate-keys to replace)"; return; fi
  if [ -f "$file" ]; then
    sed -n "s/^$var=//p" "$file" | head -1 | tr -d '\n' | railway variables --service "$svc" --set-from-stdin "$var" --skip-deploys >/dev/null
    note "$var set on $svc from $file (derives to $want). SEAL IT in the Railway UI now"
    return
  fi
  [ -t 0 ] || die "$var is not set on $svc, $file does not exist, and stdin is not a terminal"
  printf '  %s for %s (0x + 64 hex, must derive to %s; input hidden): ' "$var" "$svc" "$want"
  IFS= read -rs KEY; echo
  printf '%s' "$KEY" | grep -Eq '^(0x)?[0-9a-fA-F]{64}$' || { KEY=""; die "$var is not 32 bytes of hex (value not shown)"; }
  got=$(KPK="$KEY" NODE_PATH="$ROOT/keeper/node_modules" node -e "const {privateKeyToAccount}=require('viem/accounts');const k=process.env.KPK;process.stdout.write(privateKeyToAccount(k.startsWith('0x')?k:'0x'+k).address)" 2>/dev/null || true)
  [ "$(printf '%s' "$got" | lc)" = "$(printf '%s' "$want" | lc)" ] || { KEY=""; die "that key derives to ${got:-nothing}, not v2.bots.$bot $want"; }
  printf '%s' "$KEY" | railway variables --service "$svc" --set-from-stdin "$var" --skip-deploys >/dev/null
  KEY=""
  note "$var set on $svc (derives to $want). SEAL IT in the Railway UI now"
}

ensure_volume() {
  svc=$1; mount=$(col "$svc" $VOLUME)
  [ "$mount" != "-" ] || return 0
  if [ "$APPLY" != 1 ]; then show "railway volume --service $svc add --mount-path $mount" "# only if $svc has no volume"; return; fi
  local volumes
  volumes=$(svc_query "$svc" 's&&s.volumes&&s.volumes.length?"y":""') || die "could not read Railway volumes for $svc"
  if [ -n "$volumes" ]; then note "volume present"; return; fi
  railway volume --service "$svc" add --mount-path "$mount" >/dev/null
  note "volume mounted at $mount"
}

INDEXER_HOST=""
ensure_domain() {
  local domains
  svc=$1; kind=$(col "$svc" $PUBLIC); port=$(col "$svc" $PORT_COL)
  case "$kind" in
    none)
      if [ "$APPLY" = 1 ]; then
        domains=$(domains_of "$svc") || die "could not read Railway domains for $svc"
        [ -z "$domains" ] || note "WARNING: $svc has a public domain it does not need; remove it in the UI (private networking only, §15.1)"
      fi
      return 0 ;;
    forbidden)
      if [ "$APPLY" != 1 ]; then note "# $svc: refuses to deploy while it has any public domain (the kill switch is on port $port)"; return; fi
      domains=$(domains_of "$svc") || die "could not read Railway domains for $svc"
      [ -z "$domains" ] || die "$svc has a public domain; delete it in the UI first: /kill must be reachable on the private network only (§15.1)"
      return 0 ;;
    generated)
      if [ "$APPLY" != 1 ]; then show "railway domain --service $svc --port $port" "# only if $svc has no domain; the https://<domain> becomes web's NEXT_PUBLIC_API_URL"; return; fi
      domains=$(domains_of "$svc") || die "could not read Railway domains for $svc"
      INDEXER_HOST=$(printf '%s\n' "$domains" | awk 'NF {print $2; exit}')
      if [ -z "$INDEXER_HOST" ]; then
        railway domain --service "$svc" --port "$port" >/dev/null
        domains=$(domains_of "$svc") || die "could not read Railway domains for $svc"
        INDEXER_HOST=$(printf '%s\n' "$domains" | awk 'NF {print $2; exit}')
      fi
      [ -n "$INDEXER_HOST" ] || die "could not create or read the $svc domain"
      note "$svc domain https://$INDEXER_HOST" ;;
    custom)
      [ "$svc" = notifier ] || return 0
      if [ "$APPLY" != 1 ]; then
        show "railway domain $NOTIFIER_DOMAIN --service $svc --port $port" "# only if missing; prints the CNAME and _railway-verify TXT the owner adds in Cloudflare (DNS only)"
        return
      fi
      domains=$(domains_of "$svc") || die "could not read Railway domains for $svc"
      if printf '%s\n' "$domains" | grep -q " $NOTIFIER_DOMAIN\$"; then note "$NOTIFIER_DOMAIN attached"; return; fi
      railway domain "$NOTIFIER_DOMAIN" --service "$svc" --port "$port"
      note "TODO (owner, DNS): add the records printed above in Cloudflare, DNS only (ops/deploy.md §4)" ;;
  esac
}

deploy() {
  svc=$1; detach=${2:-}
  if [ "$APPLY" != 1 ]; then
    if [ -n "$detach" ]; then show "railway up --detach --service $svc -m \"go-live-v2: $REF\"" "# $(col "$svc" $HEALTH) waits for the backfill"
    else show "railway up --ci --service $svc -m \"go-live-v2: $REF\"" "# then wait for the deployment's SUCCESS (up to ${DEPLOY_WAIT_SECS}s)"; fi
    return
  fi
  if [ -n "$detach" ]; then railway up --detach --service "$svc" -m "go-live-v2: $REF" >/dev/null; note "$svc deploy started"; return 0; fi
  # Prompts and secret setup can cross into the settlement window before upload starts.
  case "$svc" in
    cranker|pricer|mm-bot)
      if [ "$IGNORE_WINDOW" != 1 ] && in_expiry_window; then
        note "Deployment stopped before $svc upload. Seal any secrets set above and complete the Railway UI checks in ops/deploy.md §15.7 before re-running outside the expiry window."
        die "$svc is not redeployed between 15:40 and 16:20 New York time on a weekday (pass --ignore-expiry-window only for an owner-reviewed exception)"
      fi ;;
  esac
  local previous_record previous_id
  previous_record=$(latest_deployment_record "$svc") || die "could not read the prior $svc deployment"
  previous_id=${previous_record%%|*}
  railway up --ci --service "$svc" -m "go-live-v2: $REF" || return 1
  wait_new_deploy "$svc" "$previous_id" "$DEPLOY_WAIT_SECS"
}

FAIL=0
container_health() {  # svc -> "<code> status=<status>" from inside the container (no public domain needed)
  svc=$1; port=$(col "$svc" $PORT_COL); path=$(col "$svc" $HEALTH)
  if [ "$APPLY" != 1 ]; then
    show "railway ssh --service $svc -- node -e 'fetch(\"http://127.0.0.1:$port$path\").then(async r=>console.log(r.status, await r.text()))'" "# expect 200 and status ok (degraded or starting while it warms up)"
    return
  fi
  out=$(railway ssh --service "$svc" -- node -e "fetch('http://127.0.0.1:$port$path').then(async r=>{console.log(r.status, await r.text())}).catch(e=>{console.log('ERR', e.message)})" 2>/dev/null || true)
  st=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const raw=s.trim();const i=raw.indexOf(" ");try{const d=JSON.parse(raw.slice(i+1));console.log(raw.slice(0,i),"status="+d.status)}catch{console.log(raw.slice(0,80)||"no answer")}})')
  note "$svc $path: $st"
  case "$st" in 200*status=ok*|200*status=degraded*|200*status=starting*) ;; *) FAIL=1 ;; esac
}

todo() {  # svc: what the CLI cannot set
  svc=$1
  TODOS="$TODOS
  $svc: healthcheck path $(col "$svc" $HEALTH); restart On Failure, 10 retries; replicas 1; no GitHub/image source. Redeploy manually from a new reviewed --ref after a code or registry change"
}

# ---------------------------------------------------------------------------------------------
# The services.
# ---------------------------------------------------------------------------------------------
if [ "$APPLY" = 1 ]; then
  [ "$ASSUME_YES" = 1 ] || {
    printf '\nDeploy %s to Railway production from %s@%s? Type "yes": ' "$SERVICES" "$REPO" "$REF"
    read -r answer; [ "$answer" = "yes" ] || die "not confirmed"
  }
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/callhouse-golive-v2.XXXXXX")
  step "Clone $REPO@$REF"
  if command -v gh >/dev/null 2>&1; then gh repo clone "$REPO" "$WORK/callhouse" -- --quiet --no-recurse-submodules
  else git clone --quiet --no-recurse-submodules "https://github.com/$REPO.git" "$WORK/callhouse"; fi
  cd "$WORK/callhouse"
  git checkout --quiet "$REF"
  [ "$(git rev-parse HEAD)" = "$REF" ] || die "the clone did not resolve to the reviewed commit SHA $REF"
  note "HEAD $(git rev-parse --short HEAD) $(git log -1 --format=%s | cut -c1-70)"
  cmp -s ops/markets/tier1.json "$REGISTRY" \
    || die "$REF carries a different ops/markets/tier1.json than this checkout; the bots bake the clone's copy. Commit and push the registry, then re-run"
  node ops/v2-env.mjs --check >/dev/null || die "$REF's ops/v2/env is out of date with its registry"
  # Preflight may inspect a local renderer, but deployed variables must come from the reviewed SHA.
  # Refuse a local-only renderer/env change rather than silently deploying a different value.
  diff -qr "$ENV_OUT" ops/v2/env >/dev/null \
    || die "local rendered v2 env differs from $REF; review, commit and re-run from the same SHA"
  rm -rf "$ENV_OUT"
  ENV_OUT="$WORK/callhouse/ops/v2/env"
  note "Railway public variables come from reviewed $REF ops/v2/env"
  SHAPE=$(repo_shape "$WORK/callhouse")
  [ -z "$SHAPE" ] || { echo "REFUSED: $REF cannot build what was selected:" >&2; printf '%s\n' "$SHAPE" | sed 's/^/  /' >&2; exit 1; }
  railway link -p "$RW_PROJECT" -e "$RW_ENV" >/dev/null
else
  step "Plan (dry run: every railway command --apply runs, in order; nothing was changed)"
  show "git clone $REPO (temp dir); git checkout $REF; railway link -p $RW_PROJECT -e $RW_ENV" "# the clone's ops/markets/tier1.json must equal the registry planned against, and the shape checks run on it"
fi
TODOS=""

# ---- relay ----
RELAY_ON=1
if selected relay; then
  step "relay"
  ensure_service relay
  ensure_domain relay
  if [ "$APPLY" != 1 ]; then
    note "# deployed only if RELAY_TOKEN and DISCORD_WEBHOOK_URL (or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) are already set on relay (§12.2)"
    set_variables relay 1
    deploy relay
    todo relay
  elif has_var relay RELAY_TOKEN && { has_var relay DISCORD_WEBHOOK_URL || { has_var relay TELEGRAM_BOT_TOKEN && has_var relay TELEGRAM_CHAT_ID; }; }; then
    set_variables relay 1
    deploy relay || { FAIL=1; RELAY_ON=0; }
    todo relay
  else
    RELAY_ON=0
    FAIL=1
    note "relay has no RELAY_TOKEN or no target (§12.2): not deployed; set both before declaring go-live complete"
  fi
elif [ "$APPLY" = 1 ]; then
  relay_status=$(latest_status relay) || die "could not read Railway deployment status for relay"
  if [ "$relay_status" != SUCCESS ] || ! has_var relay RELAY_TOKEN \
    || { ! has_var relay DISCORD_WEBHOOK_URL && { ! has_var relay TELEGRAM_BOT_TOKEN || ! has_var relay TELEGRAM_CHAT_ID; }; }; then
    RELAY_ON=0
  fi
fi
if [ "$APPLY" = 1 ] && [ "$RELAY_ON" = 0 ]; then
  for alert_svc in indexer-v2 pricing cranker pricer mm-bot notifier; do
    selected "$alert_svc" || continue
    die "relay is not live with RELAY_TOKEN and a target; refusing to deploy $alert_svc without ALERT_WEBHOOK. Deploy relay, then re-run --services relay,$alert_svc"
  done
fi

# ---- indexer-v2 ----
if selected indexer-v2; then
  step "indexer-v2"
  ensure_service indexer-v2
  if [ "$APPLY" = 1 ]; then
    for v in DATABASE_SCHEMA VAULT_ADDRESS VAULT FACTORY_ADDRESS FACTORY START_BLOCK; do
      if has_var indexer-v2 "$v"; then die "indexer-v2 has $v set; it must be unset on the v2-only indexer (ops/deploy.md §11.3, §15.1). Delete it in the UI and re-run"; fi
    done
  fi
  set_variables indexer-v2 "$RELAY_ON"
  prompted_secret indexer-v2 PONDER_RPC_URL_4663 '^https://[^[:space:]]+$' "the keyed archive RPC URL, the v1 indexer's value (§11.2)"
  ensure_domain indexer-v2
  if [ "$APPLY" = 1 ]; then
    indexer_before=$(latest_deployment_record indexer-v2) || die "could not read the prior indexer-v2 deployment"
    indexer_before=${indexer_before%%|*}
  fi
  deploy indexer-v2 detach || die "indexer-v2 upload failed"
  if [ "$APPLY" = 1 ]; then
    wait_new_deploy indexer-v2 "$indexer_before" "$READY_WAIT_SECS" \
      || die "new indexer-v2 deployment did not succeed; the old deployment's /ready is not release evidence"
    waited=0; rcode=000
    while [ "$waited" -le "$READY_WAIT_SECS" ]; do
      rcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$INDEXER_HOST/ready" || echo 000)
      [ "$rcode" = 200 ] && break
      sleep 30; waited=$((waited + 30))
    done
    note "indexer-v2 /ready: $rcode"
    [ "$rcode" = 200 ] || FAIL=1
    cfg=$(curl -s --max-time 15 "https://$INDEXER_HOST/v2/config" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);console.log(String(d.contracts&&d.contracts.clearinghouse).toLowerCase())}catch{console.log("unreadable")}})')
    [ "$cfg" = "$(reg 'r.v2.contracts.clearinghouse' | lc)" ] && note "indexer-v2 /v2/config names the registry's clearinghouse" || { note "indexer-v2 /v2/config clearinghouse: $cfg"; FAIL=1; }
  else
    show "curl -s https://<indexer-v2 domain>/ready" "# polled up to ${READY_WAIT_SECS}s for 200; then /v2/config must name clearinghouse $(reg 'r.v2.contracts.clearinghouse')"
  fi
  todo indexer-v2
fi
if [ "$APPLY" = 1 ] && [ -z "$INDEXER_HOST" ] && selected web; then
  domains=$(domains_of indexer-v2) || die "could not read Railway domains for indexer-v2"
  INDEXER_HOST=$(printf '%s\n' "$domains" | awk 'NF {print $2; exit}')
  [ -n "$INDEXER_HOST" ] || die "web needs the indexer-v2 domain and indexer-v2 has none: deploy indexer-v2 first"
fi

# ---- the keeper-image services ----
for svc in pricing cranker pricer mm-bot; do
  selected "$svc" || continue
  step "$svc"
  if [ "$APPLY" = 1 ] && [ "$svc" != pricing ] && in_expiry_window && [ "$IGNORE_WINDOW" != 1 ]; then
    die "$svc is not redeployed between 15:40 and 16:20 New York time on a weekday (the expiry snapshot window); re-run later or pass --ignore-expiry-window"
  fi
  ensure_service "$svc"
  if [ "$APPLY" = 1 ]; then
    for v in KEEPER_PK VAULT FACTORY; do
      if has_var "$svc" "$v"; then die "$svc has the v1 variable $v set; a V2_MODE service never reads it and a stray key is a key in the wrong place. Delete it in the UI and re-run"; fi
    done
  fi
  set_variables "$svc" "$RELAY_ON"
  [ "$svc" = pricing ] || bot_key "$svc"
  # The MM bot refuses to boot without its kill-switch token (keeper/src/v2/config.ts MM_KILL_TOKEN).
  [ "$svc" = mm-bot ] && prompted_secret mm-bot MM_KILL_TOKEN '^[0-9a-fA-F]{64}$' "openssl rand -hex 32; POST /kill and /resume on the private network need it; keep a copy where the on-call can reach it"
  ensure_volume "$svc"
  ensure_domain "$svc"
  if deploy "$svc"; then container_health "$svc"; else FAIL=1; fi
  todo "$svc"
done

# ---- notifier ----
if selected notifier; then
  step "notifier"
  ensure_service notifier
  set_variables notifier "$RELAY_ON"
  prompted_secret notifier NOTIFIER_DATA_KEY '^[0-9a-fA-F]{64}$' "openssl rand -hex 32; keep an offline copy, losing it orphans every stored target"
  prompted_secret notifier TELEGRAM_BOT_TOKEN '^[0-9]+:[A-Za-z0-9_-]{30,}$' "@BotFather, a user-facing bot, never the relay's operator bot"
  prompted_secret notifier VAPID_PUBLIC_KEY '^[A-Za-z0-9_-]{80,100}$' "npx web-push generate-vapid-keys (public, but generated with the private key)"
  prompted_secret notifier VAPID_PRIVATE_KEY '^[A-Za-z0-9_-]{40,50}$' "the same generate-vapid-keys run"
  if [ "$APPLY" != 1 ]; then note "# SMTP_URL (+ EMAIL_FROM, NOTIFIER_PUBLIC_URL) is not touched: set it in the UI to turn email on"; fi
  ensure_domain notifier
  if deploy notifier; then container_health notifier; else FAIL=1; fi
  todo notifier
fi

# A relay-only run prepares alert references on existing producers. A running service must then
# be redeployed: --skip-deploys changes its next deployment, not the process already serving.
if [ "$APPLY" = 1 ] && selected relay && [ "$RELAY_ON" = 1 ]; then
  for alert_svc in indexer-v2 pricing cranker pricer mm-bot notifier; do
    selected "$alert_svc" && continue
    service_exists "$alert_svc" || continue
    [ -f "$ENV_OUT/$alert_svc.env" ] || continue
    alert_line=$(grep -m1 '^ALERT_WEBHOOK=' "$ENV_OUT/$alert_svc.env" || true)
    [ -n "$alert_line" ] || continue
    alert_status=$(latest_status "$alert_svc") || die "could not read Railway deployment status for $alert_svc"
    if ! has_var "$alert_svc" ALERT_WEBHOOK || ! has_var "$alert_svc" ALERT_WEBHOOK_TOKEN; then
      railway variables --service "$alert_svc" --skip-deploys --set "$alert_line" \
        --set 'ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}' >/dev/null
      note "$alert_svc: relay alert variables set for its next deployment"
      if [ "$alert_status" != NONE ]; then
        note "ACTION REQUIRED: $alert_svc is already deployed; re-run --services $alert_svc to activate the alert wiring"
        FAIL=1
      fi
    fi
  done
fi

# ---- web: the public flip, only when asked ----
if selected web; then
  if [ "$APPLY" = 1 ] && [ "$FAIL" != 0 ]; then
    die "earlier v2 service checks are incomplete; refusing the public web flip"
  fi
  step "web"
  ensure_service web
  api="https://${INDEXER_HOST:-<indexer-v2 domain>}"
  SETS=("NEXT_PUBLIC_V2=1" "NEXT_PUBLIC_API_URL=$api" "NEXT_PUBLIC_NOTIFIER_URL=https://$NOTIFIER_DOMAIN")
  if [ "$APPLY" != 1 ]; then
    show "railway variables --service web --skip-deploys" "--set ${SETS[0]}" "--set ${SETS[1]}" "--set ${SETS[2]}" "# build-time values: the deploy below is a REBUILD, never a restart (§6)"
  else
    ARGS=(); for kv in "${SETS[@]}"; do ARGS+=(--set "$kv"); done
    railway variables --service web --skip-deploys "${ARGS[@]}" >/dev/null
    note "web: NEXT_PUBLIC_V2=1, NEXT_PUBLIC_API_URL=$api, NEXT_PUBLIC_NOTIFIER_URL=https://$NOTIFIER_DOMAIN"
  fi
  if deploy web; then
    if [ "$APPLY" = 1 ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$APP_URL/settings/notifications" || echo 000)
      note "web /settings/notifications: $code (200 only in a NEXT_PUBLIC_V2=1 build)"
      [ "$code" = 200 ] || FAIL=1
    else
      show "curl -s -o /dev/null -w '%{http_code}' $APP_URL/settings/notifications" "# 200 only in a NEXT_PUBLIC_V2=1 build (404 otherwise)"
    fi
  else FAIL=1; fi
  todo web
fi

# ---------------------------------------------------------------------------------------------
step "What the CLI cannot do (Railway UI / owner)"
{ selected indexer-v2 || selected cranker || selected pricer || selected mm-bot || selected notifier; } \
  && note "seal every secret just set: CRANKER_PK, PRICER_PK, MM_QUOTER_PK, MM_KILL_TOKEN, PONDER_RPC_URL_4663, NOTIFIER_DATA_KEY, TELEGRAM_BOT_TOKEN, VAPID_PRIVATE_KEY (§9.15)"
printf '%s\n' "$TODOS" | sed '/^$/d'
selected notifier && note "DNS (owner): CNAME notify -> the Railway target, TXT _railway-verify.notify; Cloudflare DNS only (§4)"
note "then ops/deploy.md §15.7: private-network reachability from each caller, the relay wiring test, the external monitors"
echo
if [ "$APPLY" != 1 ]; then echo "DRY RUN COMPLETE: nothing was changed. Re-run with --apply to do it."; exit 0; fi
if [ "$FAIL" = 0 ]; then echo "V2 GO-LIVE OK: $SERVICES"; else echo "V2 GO-LIVE INCOMPLETE — see the lines above"; exit 1; fi
