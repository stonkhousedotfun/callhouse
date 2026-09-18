#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# ops/keeper-railway.sh — one Railway service per factory market: keeper-<ticker>.
#
# Creates or updates the service `keeper-<lowercase ticker>` in Railway project "callhouse"
# (environment production) for every ticker asked for, from the SAME image as the pooled keeper
# (repo root build context, keeper/Dockerfile, watch paths from keeper/railway.json), with a /data
# volume, one replica, root uid for the volume mount and a 120 s drain; sets every variable from
# ops/keeper/markets/<TICKER>.env plus KEEPER_PK from ~/.callhouse-keys/markets/<TICKER>.env; and
# deploys it with `railway up`. It is the multi-market successor of the keeper step in
# ops/go-live-app.sh, and every railway CLI call here is one that script already makes.
#
#   ops/keeper-railway.sh --tickers TSLA                         # DRY RUN (the default): preflight + plan
#   ops/keeper-railway.sh --tickers TSLA,AAPL --i-understand-this-deploys
#
# DEFAULT IS --dry-run. The script refuses to change anything without --i-understand-this-deploys,
# and then still asks for a typed "yes" unless --yes. Nothing here broadcasts a chain transaction:
# the KEEPER_ROLE grant and the factory deploy are contracts-side (ops/deploy.md §13).
#
# Preflight (runs in --dry-run too), per ticker:
#   - ops/keeper/markets/<TICKER>.env exists, matches the registry (ops/keeper-env.sh --check),
#     and has a non-blank FACTORY: a planned market is refused, its keeper would only exit 1.
#   - ~/.callhouse-keys/markets/<TICKER>.env exists with mode 600 and one KEEPER_PK line. The key
#     is never echoed, never on a command line, never in a temp file; it goes to Railway through
#     `railway variables --set-from-stdin KEEPER_PK`, exactly as go-live-app.sh does.
#   - The key's address equals the registry's deployment.keeper for that ticker (derived by viem
#     from an environment variable, so the key is not in `ps` either).
#   - Railway CLI >= 5.47.2 (older ones hide sealed variables and this script would re-set
#     KEEPER_PK every run), logged in, project reachable.
#
# What the CLI cannot do, and this script therefore prints as TODO after each deploy:
#   - SEAL KEEPER_PK. The CLI sets, the UI seals (ops/deploy.md §9.15). Until sealed the key is
#     readable in the Railway UI by anyone with project access.
#   - Replicas = 1, the healthcheck path/timeout and the watch paths are service settings: the
#     CLI has no flag for them. The repo's keeper/railway.json carries them; set "Config file
#     path" = keeper/railway.json on the service in the UI (once), or check them by hand.
#     RAILWAY_DOCKERFILE_PATH is a variable and IS set here. The volume, the uid and the drain
#     are set here too (a variable and `railway volume add`).
#
# Every deploy is built from a fresh clone of origin/<ref> in a temp dir, never from this working
# tree, so uncommitted local edits cannot ship. Bash 3.2 compatible (macOS default).
# ---------------------------------------------------------------------------------------------
set -euo pipefail

RW_PROJECT=9988a803-0b8f-4b0e-8ada-ba71e5a505ae     # Railway project "callhouse"
RW_ENV=319fcb44-0e25-4367-947c-09351a349d2e         # production
REPO=stonkhousedotfun/callhouse
MIN_RAILWAY_CLI="5.47.2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="$HERE/markets/tier1.json"
ENV_DIR="$HERE/keeper/markets"
KEYS_DIR="${CALLHOUSE_KEYS_DIR:-$HOME/.callhouse-keys/markets}"
RPC=${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}
DEPLOY_WAIT_SECS=${DEPLOY_WAIT_SECS:-600}

TICKERS=""; DRY_RUN=1; UNDERSTOOD=0; ASSUME_YES=0; REF=main; ROTATE_KEY=0

usage() {
  sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF
Options:
  --tickers TSLA,AAPL            which markets (required; upper-case registry tickers)
  --dry-run                      preflight and print the plan; change nothing (the default)
  --i-understand-this-deploys    actually create/update services, set variables and deploy
  --ref REF                      git ref to deploy (default main)
  --rotate-key                   set KEEPER_PK even if the service already has one
  --yes                          skip the typed confirmation
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tickers) TICKERS=${2:-}; shift 2 ;;
    --tickers=*) TICKERS=${1#*=}; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --i-understand-this-deploys) UNDERSTOOD=1; DRY_RUN=0; shift ;;
    --ref) REF=${2:-}; shift 2 ;;
    --rotate-key) ROTATE_KEY=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die()  { echo "REFUSED: $*" >&2; exit 1; }
step() { printf '\n== %s ==\n' "$*"; }
note() { printf '  %s\n' "$*"; }
lc()   { tr '[:upper:]' '[:lower:]'; }

# version_ge A B: true when dotted version A >= B (numeric, up to 4 components). node, not python3:
# /usr/bin/python3 is not guaranteed on a fresh macOS.
version_ge() {
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").slice(0,4).map(Number));while(a.length<4)a.push(0);while(b.length<4)b.push(0);for(let i=0;i<4;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}process.exit(0)' "$1" "$2"
}

# json_get FILE 'expr': one value out of the registry, via node.
json_get() { node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=($2);process.stdout.write(v==null?'':String(v))" "$1"; }

# ---------------------------------------------------------------------------------------------
# 0. Preflight — runs in --dry-run too.
# ---------------------------------------------------------------------------------------------
step "Preflight"
[ "$UNDERSTOOD" = 1 ] || [ "$DRY_RUN" = 1 ] || die "pass --i-understand-this-deploys to change anything; the default is --dry-run"
[ -n "$TICKERS" ] || { usage >&2; die "--tickers is required"; }
for t in node cast railway git; do command -v "$t" >/dev/null 2>&1 || die "$t is not installed"; done
command -v gh >/dev/null 2>&1 || note "gh not found; will clone with plain git over https"
[ -f "$REGISTRY" ] || die "registry not found: $REGISTRY"

rw_ver=$(railway --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+){1,3}' | head -1 || true)
[ -n "$rw_ver" ] || die "could not read the Railway CLI version (railway --version)"
version_ge "$rw_ver" "$MIN_RAILWAY_CLI" \
  || die "Railway CLI $rw_ver is too old: sealed variables are invisible to it. Upgrade to >= $MIN_RAILWAY_CLI"
note "railway CLI $rw_ver"
railway whoami >/dev/null 2>&1 || die "railway CLI is not logged in (railway login)"
note "railway: $(railway whoami 2>/dev/null | head -1)"

# The committed env files must be what the registry renders now, or the service would run on a
# stale factory / knob. --check exits 1 with the list.
node "$HERE/keeper-env.sh" --check || die "ops/keeper/markets is out of date: run ops/keeper-env.sh and commit"

chain=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "RPC $RPC did not answer eth_chainId"
[ "$chain" = "4663" ] || die "RPC $RPC is chain $chain, expected 4663"

LIST=$(printf '%s' "$TICKERS" | tr ',' ' ')
for T in $LIST; do
  T=$(printf '%s' "$T" | tr '[:lower:]' '[:upper:]')
  ENV_FILE="$ENV_DIR/$T.env"
  KEY_FILE="$KEYS_DIR/$T.env"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist (is $T a live/planned market? run ops/keeper-env.sh)"
  status=$(json_get "$REGISTRY" "r.markets.find(m=>m.ticker==='$T')?.status")
  factory=$(sed -n 's/^FACTORY=//p' "$ENV_FILE" | head -1)
  [ -n "$factory" ] || die "$T has no factory in $ENV_FILE (status ${status:-unknown}): deploy the factory first (contracts/script/DeploySoloBatch.sh), then re-run ops/keeper-env.sh"
  [ "$status" = "live" ] || die "$T is status '${status:-unknown}' in the registry, not live; flip it once the factory is configured"
  code=$(cast code --rpc-url "$RPC" "$factory" 2>/dev/null) || die "cast code failed for $T factory $factory"
  { [ -n "$code" ] && [ "$code" != "0x" ]; } || die "$T factory $factory has NO CODE on chain 4663"
  f_asset=$(cast call --rpc-url "$RPC" "$factory" 'asset()(address)' 2>/dev/null | lc || true)
  e_asset=$(sed -n 's/^ASSET=//p' "$ENV_FILE" | head -1 | lc)
  [ "$f_asset" = "$e_asset" ] || die "$T factory.asset() is '${f_asset:-no answer}', env says $e_asset"
  f_feed=$(cast call --rpc-url "$RPC" "$factory" 'priceFeed()(address)' 2>/dev/null | lc || true)
  e_feed=$(sed -n 's/^PRICE_FEED=//p' "$ENV_FILE" | head -1 | lc)
  [ "$f_feed" = "$e_feed" ] || die "$T factory.priceFeed() is '${f_feed:-no answer}', env says $e_feed"

  [ -f "$KEY_FILE" ] || die "$KEY_FILE does not exist (ops/markets/derive-keeper-keys.sh $T)"
  perms=$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || stat -c '%a' "$KEY_FILE")
  [ "$perms" = "600" ] || die "$KEY_FILE is mode $perms, must be 600"
  n=$(grep -c '^KEEPER_PK=' "$KEY_FILE" || true)
  [ "$n" = "1" ] || die "$KEY_FILE must hold exactly one KEEPER_PK line (has $n)"
  # The address the key derives to, compared with the registry. The key reaches node through an
  # environment variable, never argv (`cast wallet address --private-key` would put it in `ps`),
  # and node prints only the address. viem is resolved from the keeper's own node_modules.
  key_addr=$(KPK="$(sed -n 's/^KEEPER_PK=//p' "$KEY_FILE" | head -1)" NODE_PATH="$HERE/../keeper/node_modules" \
    node -e "const {privateKeyToAccount}=require('viem/accounts');const k=process.env.KPK.startsWith('0x')?process.env.KPK:'0x'+process.env.KPK;process.stdout.write(privateKeyToAccount(k).address)" 2>/dev/null | lc || true)
  reg_addr=$(json_get "$REGISTRY" "r.markets.find(m=>m.ticker==='$T')?.deployment?.keeper" | lc)
  [ -n "$key_addr" ] || die "$KEY_FILE does not hold a usable private key"
  [ "$key_addr" = "$reg_addr" ] || die "$T key file derives to $key_addr but the registry says deployment.keeper $reg_addr"
  role=$(cast call --rpc-url "$RPC" "$factory" 'hasRole(bytes32,address)(bool)' "$(cast keccak KEEPER_ROLE)" "$key_addr" 2>/dev/null || echo "?")
  note "$T: factory $factory, keeper $key_addr, KEEPER_ROLE=$role, env $ENV_FILE"
  [ "$role" = "true" ] || note "  WARNING: $key_addr does not hold KEEPER_ROLE on $factory; the keeper will alert keeper_role and not setWeek (grant it from the admin, ops/deploy.md §13)"
done

# ---------------------------------------------------------------------------------------------
# The plan.
# ---------------------------------------------------------------------------------------------
step "Plan$( [ "$DRY_RUN" = 1 ] && echo ' (dry run, nothing changed)')"
for T in $LIST; do
  T=$(printf '%s' "$T" | tr '[:lower:]' '[:upper:]')
  svc="keeper-$(printf '%s' "$T" | lc)"
  vars=$(grep -E '^[A-Z_]+=' "$ENV_DIR/$T.env" | cut -d= -f1 | tr '\n' ' ')
  cat <<EOF
  $svc:
    clone $REPO@$REF into a temp dir; railway link -p $RW_PROJECT -e $RW_ENV
    railway add --service $svc                      (only if it does not exist)
    railway variables --service $svc --skip-deploys --set RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile
        --set RAILWAY_RUN_UID=0 --set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120 --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300
        --set ALERT_WEBHOOK_TOKEN='\${{relay.RELAY_TOKEN}}'
        and from $ENV_DIR/$T.env: $vars
    railway variables --service $svc --set-from-stdin KEEPER_PK   (from $KEYS_DIR/$T.env, unless already set and not --rotate-key)
    railway volume --service $svc add --mount-path /data           (only if the service has no volume)
    railway up --ci --service $svc -m "keeper-$T: $REF"; wait for SUCCESS (up to ${DEPLOY_WAIT_SECS}s)
    check /health via railway ssh; then TODO in the UI: seal KEEPER_PK; config file path keeper/railway.json (replicas 1, /health, watch paths)
EOF
done
[ "$DRY_RUN" = 1 ] && exit 0

if [ "$ASSUME_YES" != 1 ]; then
  printf '\nDeploy the services above to Railway production? Type "yes": '
  read -r answer
  [ "$answer" = "yes" ] || die "not confirmed"
fi

# ---------------------------------------------------------------------------------------------
# Workspace: a fresh clone, linked to the Railway project. Removed on exit.
# ---------------------------------------------------------------------------------------------
WORK=$(mktemp -d "${TMPDIR:-/tmp}/callhouse-keepers.XXXXXX")
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
var_names() { railway variables --service "$1" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(Object.keys(JSON.parse(s)).join("\n"))}catch{}})'; }
has_var() { var_names "$1" | grep -qx "$2"; }
service_exists() { railway variables --service "$1" --json >/dev/null 2>&1; }
has_volume() {
  # `railway service list --json` carries each service's volumes; `railway volume list` takes no --service (CLI 5.57).
  railway service list --json 2>/dev/null | SVC="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let ok=false;try{const x=JSON.parse(s).find(v=>v.name===process.env.SVC);ok=!!(x&&x.volumes&&x.volumes.length)}catch{}process.exit(ok?0:1)})'
}
latest_status() {
  railway deployment list --service "$1" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);console.log(d[0]?d[0].status:"NONE")}catch{console.log("UNKNOWN")}})'
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

FAIL=0
for T in $LIST; do
  T=$(printf '%s' "$T" | tr '[:lower:]' '[:upper:]')
  svc="keeper-$(printf '%s' "$T" | lc)"
  ENV_FILE="$ENV_DIR/$T.env"
  KEY_FILE="$KEYS_DIR/$T.env"
  step "$svc"

  # 1. the service
  if service_exists "$svc"; then
    note "service $svc exists"
  else
    railway add --service "$svc" >/dev/null
    note "service $svc created"
  fi

  # 2. variables from the committed env file, plus the Railway-side settings the CLI can set.
  #    Refuse to deploy over a VAULT: a factory keeper must never enter the pooled roll.
  has_var "$svc" VAULT && die "$svc has VAULT set; a factory keeper never drives the pooled vault — delete it in Railway and re-run"
  set -- --set "RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile" \
         --set "RAILWAY_RUN_UID=0" \
         --set "RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120" \
         --set "RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300" \
         --set 'ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}'
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) set -- "$@" --set "$line" ;;
    esac
  done < "$ENV_FILE"
  railway variables --service "$svc" --skip-deploys "$@" >/dev/null
  note "$(( $# / 2 )) variables set from $ENV_FILE"

  # 3. the hot key: stdin only, never argv, never a file in the clone.
  if has_var "$svc" KEEPER_PK && [ "$ROTATE_KEY" != 1 ]; then
    note "KEEPER_PK already set on $svc (sealed or not); keeping it (--rotate-key to replace)"
  else
    sed -n 's/^KEEPER_PK=//p' "$KEY_FILE" | head -1 | tr -d '\n' \
      | railway variables --service "$svc" --set-from-stdin KEEPER_PK --skip-deploys >/dev/null
    note "KEEPER_PK set from $KEY_FILE. SEAL IT in the Railway UI now (ops/deploy.md §9.15); the CLI cannot seal"
  fi

  # 4. the volume: one per service, mounted at /data, where KEEPER_DB_PATH points.
  if has_volume "$svc"; then
    note "volume present"
  else
    railway volume --service "$svc" add --mount-path /data >/dev/null
    note "volume mounted at /data"
  fi

  # 5. deploy from the clean clone and wait.
  railway up --ci --service "$svc" -m "keeper-$T: $REF" || { FAIL=1; continue; }
  wait_deploy "$svc" "$DEPLOY_WAIT_SECS" || { FAIL=1; continue; }

  # 6. check: /health inside the container (no public domain), the factory block and the role.
  kh=$(railway ssh --service "$svc" -- node -e 'fetch("http://127.0.0.1:8787/health").then(async r=>{console.log(r.status, await r.text())}).catch(e=>{console.log("ERR", e.message)})' 2>/dev/null || true)
  kstatus=$(printf '%s' "$kh" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const raw=s.trim();const i=raw.indexOf(" ");const code=raw.slice(0,i);try{const d=JSON.parse(raw.slice(i+1));const f=d.factory||{};console.log(code,"status="+d.status,"market="+d.market,"factory="+f.address,"hasKeeperRole="+f.hasKeeperRole)}catch{console.log(raw.slice(0,120)||"no answer")}})')
  note "$svc /health: $kstatus"
  case "$kstatus" in 200*status=ok*|200*status=degraded*|200*status=starting*) ;; *) FAIL=1 ;; esac
  case "$kstatus" in *hasKeeperRole=false*) note "  $svc lacks KEEPER_ROLE on the factory: grant it from the admin (ops/deploy.md §13)"; FAIL=1 ;; esac
  note "TODO in the Railway UI for $svc: seal KEEPER_PK; set Config file path = keeper/railway.json (replicas 1, healthcheck /health, watch paths)"
done

echo
if [ "$FAIL" = 0 ]; then
  echo "KEEPERS DEPLOYED"
  echo "Next: seal every KEEPER_PK in the Railway UI; confirm the relay shows each keeper's boot alert with its market; stand up the /health monitors (ops/alerts.md §11)."
else
  echo "KEEPER DEPLOY INCOMPLETE — see the lines above"; exit 1
fi
