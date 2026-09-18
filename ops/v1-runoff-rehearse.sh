#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# ops/v1-runoff-rehearse.sh — the v1 run-off (ops/runbooks/v1-runoff.md) end to end on an anvil
# fork of Robinhood Chain 4663. Nothing here touches mainnet state, Railway, the real registry or
# any key under ~/.callhouse-keys: every write goes to the local fork.
#
#   ops/v1-runoff-rehearse.sh                        # full rehearsal, log to ops/runbooks/rehearsals/
#   ops/v1-runoff-rehearse.sh --contracts ../callhouse-contracts --port 8547
#   ops/v1-runoff-rehearse.sh --no-listing --no-keeper --no-build-check   # freeze + reads only
#
# What it does, in the runbook's order:
#   1. anvil --fork-url <RH_RPC> --chain-id 4663 --code-size-limit 98304 on --port (default 8547).
#   2. The runbook's read-only state commands against the fork (factory, roles, accounts, tokens).
#   3. Unless --no-listing: one listed, unsold 1-lot account on the NVDA factory, made on the fork
#      only (a fresh writer address, NVDA from the Uniswap pool, setWeek + listFor from the
#      registry's keeper, all impersonated), so the run-off has something to run off. Skipped with a
#      note when the feed is older than the factory's maxPriceAge.
#   4. callhouse-contracts script/v2/freeze-v1.sh --rehearse (impersonates the registry's guardian and
#      admin on anvil), then --check (must exit 0 with the post-check passed).
#   5. The runbook's post-freeze reads: the freeze events, v1FrozenAt (unix seconds of the block of
#      the later freeze transaction), list and deposit refused, the run-off table, the settle
#      safety check (USDG pause/freeze, Stock Token pause/blocklist).
#   6. The registry step on a TEMP COPY: v1RunOff true + v1FrozenAt with the runbook's own edit;
#      ops/keeper-env.sh --registry <copy> --out <tmp> (must render SOLO_WIND_DOWN=1 and nothing else
#      new), render-docs and gen-markets on a copy, build-markets --check on the copy (network,
#      about a minute; --no-build-check skips it), keeper-env.sh --check on the real registry.
#   7. Unless --no-keeper: the keeper process from this checkout (tsx, no build) on the rendered
#      NVDA.env, pointed at the fork, with a throwaway key generated here (never printed, deleted on
#      exit) that is funded and granted KEEPER_ROLE on the fork. /health and /state must say
#      windDown; after anvil warps to the listed account's expiry the keeper must settle it, raise
#      v1_drained once and send nothing else; the writer then withdraws on the frozen market.
#   8. Kills the keeper and anvil. Exit 0 and "REHEARSAL PASSED" only when every check passed.
#
# The log (default ops/runbooks/rehearsals/v1-runoff-<utc date>.log) holds no secret: anvil's own
# output (its dev keys) goes to a temp file, the fork URL is logged as its origin only, and the
# throwaway key lives in a mode-600 temp file. Bash 3.2 compatible (macOS default).
# ---------------------------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
REGISTRY="$HERE/markets/tier1.json"
CONTRACTS="$APP/../callhouse-contracts"
FORK_URL="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
PORT=8547
KEEPER_PORT=8788
LOG="$HERE/runbooks/rehearsals/v1-runoff-$(date -u +%Y-%m-%d).log"
TICKER=NVDA
WITH_LISTING=1; WITH_KEEPER=1; WITH_BUILD_CHECK=1
export PATH="$HOME/.foundry/bin:$PATH"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf '\nREHEARSAL FAILED: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --contracts) CONTRACTS=${2:?--contracts needs a directory}; shift 2 ;;
    --port) PORT=${2:?--port needs a number}; shift 2 ;;
    --keeper-port) KEEPER_PORT=${2:?--keeper-port needs a number}; shift 2 ;;
    --fork-url) FORK_URL=${2:?--fork-url needs a url}; shift 2 ;;
    --log) LOG=${2:?--log needs a path}; shift 2 ;;
    --no-listing) WITH_LISTING=0; shift ;;
    --no-keeper) WITH_KEEPER=0; shift ;;
    --no-build-check) WITH_BUILD_CHECK=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------- preflight (not logged)
for t in anvil cast forge jq node curl; do command -v "$t" >/dev/null 2>&1 || die "$t is not on PATH"; done
CONTRACTS="$(cd "$CONTRACTS" 2>/dev/null && pwd)" || die "callhouse-contracts checkout not found (--contracts)"
FREEZE="$CONTRACTS/script/v2/freeze-v1.sh"
[ -x "$FREEZE" ] || die "$FREEZE is missing or not executable (callhouse-contracts v2, C2-14)"
[ -f "$REGISTRY" ] || die "registry not found: $REGISTRY"
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_busy "$PORT" && die "port $PORT is in use; pick another with --port"
if [ "$WITH_KEEPER" = 1 ]; then
  [ -f "$APP/keeper/node_modules/tsx/package.json" ] || die "keeper dependencies are not installed (pnpm install), or pass --no-keeper"
  port_busy "$KEEPER_PORT" && die "port $KEEPER_PORT is in use; pick another with --keeper-port"
fi
GIT=git; [ -x /opt/homebrew/bin/git ] && GIT=/opt/homebrew/bin/git

reg() { node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const m=r.markets.find(x=>x.ticker===process.argv[2]);const v=($1);process.stdout.write(v==null?'':String(v))" "$REGISTRY" "$TICKER"; }
F=$(reg 'm.deployment.factory'); GUARDIAN=$(reg 'm.deployment.guardian'); ADMIN=$(reg 'm.deployment.admin')
KEEPER=$(reg 'm.deployment.keeper'); DEPLOY_BLOCK=$(reg 'm.deployment.deployBlock'); NVDA=$(reg 'm.asset'); FEED=$(reg 'm.feed')
USDG=$(reg 'r.shared.usdg'); CLEAR=$(reg 'r.shared.clearinghouse'); POOL=$(reg 'm.v2 && m.v2.univ3Pool')
REG_RUNOFF=$(reg 'JSON.stringify(m.v1RunOff)'); REG_FROZEN=$(reg 'JSON.stringify(m.v1FrozenAt)')
[ -n "$F" ] || die "$TICKER has no deployment.factory in the registry"

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

TMPBASE=${TMPDIR:-/tmp}; TMP=$(mktemp -d "${TMPBASE%/}/v1-runoff-rehearse.XXXXXX")
ANVIL_PID=""; KEEPER_PID=""
cleanup() {
  local rc=$?
  if [ -n "$KEEPER_PID" ] && kill -0 "$KEEPER_PID" 2>/dev/null; then kill "$KEEPER_PID" 2>/dev/null || true; wait "$KEEPER_PID" 2>/dev/null || true; echo "keeper stopped"; fi
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; echo "anvil stopped (port $PORT)"; fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

RPC="http://127.0.0.1:$PORT"
PASSES=0
step() { printf '\n== %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; PASSES=$((PASSES + 1)); }
expect() { # what got want
  [ "$2" = "$3" ] || die "$1: got '$2', expected '$3'"
  pass "$1 = $3"
}
first() { awk 'NR==1 {print $1}'; }
# Temp paths in tool output become <tmp> (absolute or relative), indented as quoted output.
scrub() { sed -E -e "s#[^ =]*v1-runoff-rehearse\\.[A-Za-z0-9]+#<tmp>#g" -e 's/^/  | /'; }
# A read-only call against the fork, printed as the runbook writes it (with $RH_RPC for the node).
call() { # to sig [args...]  -> prints "cast call ..." and the answer, returns the answer's first word
  local out
  out=$(cast call "$@" --rpc-url "$RPC" 2>&1) || die "cast call $* failed: $out"
  printf '  $ cast call %s --rpc-url $RH_RPC\n      %s\n' "$*" "$(printf '%s' "$out" | sed 's/ \[[^]]*\]//g' | tr '\n' ' ')" >&2
  printf '%s' "$out" | first
}
quiet() { cast call "$@" --rpc-url "$RPC" | first; }
iso() { node -e 'console.log(new Date(Number(process.argv[1]) * 1000).toISOString())' "$1"; }
# One transaction on the fork from an impersonated address (anvil only).
as() { # from to sig [args...]
  local from=$1 status; shift
  cast rpc anvil_impersonateAccount "$from" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$from" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
  status=$(cast send "$@" --from "$from" --unlocked --rpc-url "$RPC" --json | jq -r .status)
  cast rpc anvil_stopImpersonatingAccount "$from" --rpc-url "$RPC" >/dev/null
  [ "$status" = 0x1 ] || die "fork tx $2 from $from: receipt status $status"
  note "fork tx from $from: $1 $2 ${*:3}  status 1"
}
# The revert selector of a call that must revert, or "none".
revert_selector() { # from to sig [args...]
  local from=$1 out; shift
  if out=$(cast call "$@" --from "$from" --rpc-url "$RPC" 2>&1); then echo none; return; fi
  printf '%s' "$out" | grep -oE 'data: "?0x[0-9a-fA-F]{8}' | grep -oE '0x[0-9a-fA-F]{8}' | head -1
}

origin=$(node -e 'try{console.log(new URL(process.argv[1]).origin)}catch{console.log("<unparseable>")}' "$FORK_URL")
echo "v1 run-off rehearsal, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  app        $APP @ $($GIT -C "$APP" rev-parse --short HEAD) ($($GIT -C "$APP" rev-parse --abbrev-ref HEAD))"
echo "  contracts  $CONTRACTS @ $($GIT -C "$CONTRACTS" rev-parse --short HEAD) ($($GIT -C "$CONTRACTS" rev-parse --abbrev-ref HEAD))"
echo "  registry   $REGISTRY: $TICKER factory $F, v1RunOff ${REG_RUNOFF:-absent}, v1FrozenAt ${REG_FROZEN:-absent} (the real file is never written)"
echo "  fork of    $origin on port $PORT; listing $WITH_LISTING, keeper $WITH_KEEPER (port $KEEPER_PORT), build-markets check $WITH_BUILD_CHECK"

# ---------------------------------------------------------------- 1. anvil
step "1. anvil fork of 4663"
note "\$ anvil --fork-url $origin --chain-id 4663 --port $PORT --code-size-limit 98304   (output to a temp file: it prints dev keys)"
anvil --fork-url "$FORK_URL" --chain-id 4663 --port "$PORT" --code-size-limit 98304 > "$TMP/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = 4663 ] && break
  kill -0 "$ANVIL_PID" 2>/dev/null || { tail -5 "$TMP/anvil.log" | sed 's/^/  anvil: /'; die "anvil exited"; }
  sleep 1
done
expect "chain id on the fork" "$(cast chain-id --rpc-url "$RPC")" 4663
case "$(cast rpc web3_clientVersion --rpc-url "$RPC")" in '"anvil/'*) pass "the node is anvil" ;; *) die "the node on $RPC is not anvil" ;; esac
# The first reads go through anvil to the upstream RPC; retry a transient upstream error a few times.
for _ in 1 2 3 4 5; do
  FORK_BLOCK=$(cast block-number --rpc-url "$RPC" 2>/dev/null || true)
  FORK_TS=$(cast block latest --field timestamp --rpc-url "$RPC" 2>/dev/null || true)
  [ -n "$FORK_BLOCK" ] && [ -n "$FORK_TS" ] && break
  sleep 3
done
[ -n "$FORK_BLOCK" ] && [ -n "$FORK_TS" ] || die "the fork cannot read the upstream RPC ($origin)"
note "fork block $FORK_BLOCK, timestamp $FORK_TS ($(iso "$FORK_TS"))"

# ---------------------------------------------------------------- 2. state before
step "2. state before the freeze (runbook step 3, read-only)"
GUARDIAN_ROLE=$(cast keccak GUARDIAN_ROLE); KEEPER_ROLE=$(cast keccak KEEPER_ROLE)
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
call "$F" "writesHalted()(bool)" >/dev/null
call "$F" "depositCap()(uint256)" >/dev/null
LIVE0=$(call "$F" "liveCount()(uint256)")
PENDING0=$(call "$F" "pendingCount()(uint256)")
call "$F" "accountCount()(uint256)" >/dev/null
call "$F" "week()(uint32,uint256,uint40,uint40,uint256)" >/dev/null
call "$F" "clear()(address)" >/dev/null
expect "registry guardian holds GUARDIAN_ROLE" "$(call "$F" "hasRole(bytes32,address)(bool)" "$GUARDIAN_ROLE" "$GUARDIAN")" true
expect "registry admin holds DEFAULT_ADMIN_ROLE" "$(call "$F" "hasRole(bytes32,address)(bool)" "$ZERO32" "$ADMIN")" true
expect "registry keeper holds KEEPER_ROLE" "$(call "$F" "hasRole(bytes32,address)(bool)" "$KEEPER_ROLE" "$KEEPER")" true
STOCK_REG=$(cast parse-bytes32-address "$(cast storage "$NVDA" 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50 --rpc-url "$RPC")")
note "Stock Token access registry (EIP-1967 beacon slot of $NVDA): $STOCK_REG"
expect "USDG paused()" "$(call "$USDG" "paused()(bool)")" false
expect "USDG isFrozen(Clear)" "$(call "$USDG" "isFrozen(address)(bool)" "$CLEAR")" false
expect "NVDA paused()" "$(call "$NVDA" "paused()(bool)")" false
expect "Stock Token registry isBlocked(Clear)" "$(call "$STOCK_REG" "isBlocked(address)(bool)" "$CLEAR")" false
note "\$ cast logs --from-block $DEPLOY_BLOCK --to-block latest --address $F 'AccountCreated(address,address,uint32)' --rpc-url \$RH_RPC --json | jq -r '.[].topics[2]'"
ACCOUNTS=$(cast logs --from-block "$DEPLOY_BLOCK" --to-block latest --address "$F" "AccountCreated(address,address,uint32)" --rpc-url "$RPC" --json \
  | jq -r '.[].topics[2]' | sed 's/^0x000000000000000000000000/0x/')
for a in $ACCOUNTS; do
  note "account $a: owner $(quiet "$a" "owner()(address)") index $(quiet "$a" "index()(uint32)") listedExpiryTs $(quiet "$a" "listedExpiryTs()(uint40)") claimKey $(quiet "$a" "claimKey()(uint256)") reserved $(quiet "$a" "reserved()(uint256)") idleAssets $(quiet "$a" "idleAssets()(uint256)") USDG $(quiet "$USDG" "balanceOf(address)(uint256)" "$a")"
done

# ---------------------------------------------------------------- 3. a listed account (fork only)
WRITER=""; ACCOUNT=""
if [ "$WITH_LISTING" = 1 ]; then
  step "3. fork only: one listed, unsold 1-lot account, so there is something to run off"
  read -r _ ANSWER _ UPDATED _ <<<"$(cast call "$FEED" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC" | awk '{print $1}' | tr '\n' ' ')"
  MAX_AGE=$(quiet "$F" "maxPriceAge()(uint32)")
  AGE=$((FORK_TS - UPDATED))
  if [ "$AGE" -gt "$MAX_AGE" ]; then
    note "SKIPPED: the feed is ${AGE}s old, over maxPriceAge ${MAX_AGE}s at the fork block (list() would revert StalePrice)"
    WITH_LISTING=0
  elif [ -z "$POOL" ]; then
    note "SKIPPED: the registry has no v2.univ3Pool for $TICKER to take NVDA from"
    WITH_LISTING=0
  else
    MIN_PREMIUM=$(cast call "$F" "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url "$RPC" | sed -n 3p | first)
    read -r STRIKE ASK <<<"$(node -e 'const s=BigInt(process.argv[1])/100n;const p=BigInt(process.argv[2]);console.log(String(s*10700n/10000n), String(2n*s*p/10000n+1000000n))' "$ANSWER" "$MIN_PREMIUM")"
    EXERCISE_TS=$((FORK_TS + 3 * 86400)); BASE_EXPIRY_TS=$((EXERCISE_TS + 86400))
    note "spot answer $ANSWER (8 dp), strike $STRIKE and ask $ASK USDG base units (7% OTM; ask 2x the premium floor + 1 USDG, as FreezeV1Fork.t.sol)"
    WRITER=$(cast to-check-sum-address "0x$(cast keccak "stonkhouse.v1-runoff-rehearsal.writer" | cut -c27-66)")
    as "$POOL" "$NVDA" "transfer(address,uint256)" "$WRITER" 2000000000000000000
    as "$WRITER" "$F" "createAccount()"
    ACCOUNT=$(quiet "$F" "accountOf(address)(address)" "$WRITER")
    as "$WRITER" "$NVDA" "approve(address,uint256)" "$ACCOUNT" 2000000000000000000
    as "$WRITER" "$ACCOUNT" "deposit(uint256)" 2000000000000000000
    as "$WRITER" "$ACCOUNT" "requestWrite(uint64)" 1
    as "$KEEPER" "$F" "setWeek(uint256,uint40,uint40,uint256)" "$STRIKE" "$EXERCISE_TS" "$BASE_EXPIRY_TS" "$ASK"
    as "$KEEPER" "$F" "listFor(address)" "$WRITER"
    expect "liveCount after the listing" "$(quiet "$F" "liveCount()(uint256)")" "$((LIVE0 + 1))"
    IDX=$(quiet "$ACCOUNT" "index()(uint32)")
    expect "account $ACCOUNT listedExpiryTs (baseExpiryTs + index $IDX)" "$(quiet "$ACCOUNT" "listedExpiryTs()(uint40)")" "$((BASE_EXPIRY_TS + IDX))"
    expect "reserved (one unsold lot)" "$(quiet "$ACCOUNT" "reserved()(uint256)")" 1000000000000000000
  fi
fi
[ "$WITH_LISTING" = 1 ] || step "3. no listing on the fork (liveCount stays $LIVE0)"
LIVE_AT_FREEZE=$(quiet "$F" "liveCount()(uint256)")
FREEZE_FROM=$(cast block-number --rpc-url "$RPC")
note "last block before the freeze: $FREEZE_FROM (the runbook records this as FREEZE_FROM)"

# ---------------------------------------------------------------- 4. freeze
step "4. freeze-v1.sh --rehearse (runbook step 2; the same two calls step 4 sends)"
note "\$ script/v2/freeze-v1.sh --rehearse --rpc $RPC --registry $REGISTRY"
set +e
"$FREEZE" --rehearse --rpc "$RPC" --registry "$REGISTRY" > "$TMP/rehearse.out" 2>&1
rc=$?
set -e
sed 's/^/  | /' "$TMP/rehearse.out"
expect "freeze-v1.sh --rehearse exit code" "$rc" 0
grep -q "REHEARSAL PASSED" "$TMP/rehearse.out" || die "no REHEARSAL PASSED line"
pass "REHEARSAL PASSED printed"

step "5. freeze-v1.sh --check (runbook step 5: the post-check against the node)"
note "\$ script/v2/freeze-v1.sh --check --rpc $RPC --registry $REGISTRY"
set +e
"$FREEZE" --check --rpc "$RPC" --registry "$REGISTRY" > "$TMP/check.out" 2>&1
rc=$?
set -e
sed 's/^/  | /' "$TMP/check.out"
expect "freeze-v1.sh --check exit code" "$rc" 0
grep -q "post-check PASSED: 3 checks on 1 factories" "$TMP/check.out" || die "no 'post-check PASSED: 3 checks on 1 factories' line"
pass "post-check PASSED: 3 checks on 1 factories"

# ---------------------------------------------------------------- 5. post-freeze reads
step "6. post-freeze reads and v1FrozenAt (runbook step 5)"
expect "writesHalted()" "$(call "$F" "writesHalted()(bool)")" true
expect "depositCap()" "$(call "$F" "depositCap()(uint256)")" 0
logs() { # event -> "block tx data" lines
  cast logs --from-block "$((FREEZE_FROM + 1))" --to-block latest --address "$F" "$1" --rpc-url "$RPC" --json \
    | jq -r '.[] | [.blockNumber, .transactionHash, .data] | @tsv'
}
note "\$ cast logs --from-block \$((FREEZE_FROM + 1)) --to-block latest --address $F 'WritesHalted(bool)' --rpc-url \$RH_RPC --json | jq -r '.[] | [.blockNumber, .transactionHash, .data] | @tsv'"
HALT_LOGS=$(logs "WritesHalted(bool)"); printf '%s\n' "$HALT_LOGS" | sed 's/^/      /'
note "\$ cast logs ... 'DepositCapSet(uint256)' (same flags)"
CAP_LOGS=$(logs "DepositCapSet(uint256)"); printf '%s\n' "$CAP_LOGS" | sed 's/^/      /'
expect "WritesHalted events since FREEZE_FROM" "$(printf '%s\n' "$HALT_LOGS" | grep -c . || true)" 1
expect "DepositCapSet events since FREEZE_FROM" "$(printf '%s\n' "$CAP_LOGS" | grep -c . || true)" 1
expect "WritesHalted data (true)" "$(cast to-dec "$(printf '%s' "$HALT_LOGS" | cut -f3)")" 1
expect "DepositCapSet data (0)" "$(cast to-dec "$(printf '%s' "$CAP_LOGS" | cut -f3)")" 0
HALT_BLOCK=$(cast to-dec "$(printf '%s' "$HALT_LOGS" | cut -f1)"); CAP_BLOCK=$(cast to-dec "$(printf '%s' "$CAP_LOGS" | cut -f1)")
FREEZE_BLOCK=$HALT_BLOCK; [ "$CAP_BLOCK" -gt "$FREEZE_BLOCK" ] && FREEZE_BLOCK=$CAP_BLOCK
V1_FROZEN_AT=$(cast block "$FREEZE_BLOCK" --field timestamp --rpc-url "$RPC")
note "\$ cast block $FREEZE_BLOCK --field timestamp --rpc-url \$RH_RPC      # the later of the halt block $HALT_BLOCK and the cap block $CAP_BLOCK"
note "v1FrozenAt = $V1_FROZEN_AT ($(iso "$V1_FROZEN_AT"))"
if [ -n "$WRITER" ]; then
  expect "listFor refused on the frozen factory (WritesAreHalted $(cast sig 'WritesAreHalted()'))" \
    "$(revert_selector "$KEEPER" "$F" "listFor(address)" "$WRITER")" "$(cast sig 'WritesAreHalted()')"
  expect "deposit(1) refused on the frozen factory (DepositCapExceeded $(cast sig 'DepositCapExceeded()'))" \
    "$(revert_selector "$WRITER" "$ACCOUNT" "deposit(uint256)" 1)" "$(cast sig 'DepositCapExceeded()')"
fi

step "7. the run-off table and the settle safety check (runbook step 8)"
LIVE=$(call "$F" "liveCount()(uint256)")
expect "liveCount unchanged by the freeze" "$LIVE" "$LIVE_AT_FREEZE"
LAST_EXPIRY=0; i=0
while [ "$i" -lt "$LIVE" ]; do
  a=$(quiet "$F" "liveAt(uint256)(address)" "$i")
  e=$(quiet "$a" "listedExpiryTs()(uint40)"); k=$(quiet "$a" "claimKey()(uint256)")
  note "live $i: $a  listedExpiryTs $e ($(iso "$e"))  claimKey $k  $([ "$k" = 0 ] && echo 'nothing sold: settle has no redeem' || echo 'sold: settle redeems')"
  note "  USDG paused $(quiet "$USDG" "paused()(bool)")  USDG isFrozen(account) $(quiet "$USDG" "isFrozen(address)(bool)" "$a")  USDG isFrozen(Clear) $(quiet "$USDG" "isFrozen(address)(bool)" "$CLEAR")  NVDA paused $(quiet "$NVDA" "paused()(bool)")  isBlocked(account) $(quiet "$STOCK_REG" "isBlocked(address)(bool)" "$a")  isBlocked(Clear) $(quiet "$STOCK_REG" "isBlocked(address)(bool)" "$CLEAR")"
  [ "$e" -gt "$LAST_EXPIRY" ] && LAST_EXPIRY=$e
  i=$((i + 1))
done
if [ "$LIVE" -gt 0 ]; then note "last listedExpiryTs $LAST_EXPIRY ($(iso "$LAST_EXPIRY")); the /legacy exercise UI stays until $((LAST_EXPIRY + 86400)) ($(iso $((LAST_EXPIRY + 86400))))"; else note "nothing live: no settle() left, the run-off is over at the freeze"; fi

# ---------------------------------------------------------------- 6. registry on a temp copy
step "8. registry step on a TEMP COPY (runbook step 6)"
C="$TMP/app"
mkdir -p "$C/ops/markets" "$C/ops/recon" "$C/web/scripts" "$C/web/lib"
cp "$REGISTRY" "$HERE/markets/v2-sources.json" "$HERE/markets/build-markets.mjs" "$HERE/markets/render-docs.mjs" "$C/ops/markets/"
cp "$HERE/recon/R6-stock-tokens-list.json" "$C/ops/recon/"
cp "$APP/web/scripts/gen-markets.mjs" "$C/web/scripts/"
TREG="$C/ops/markets/tier1.json"
# The runbook's edit, verbatim: v1RunOff and v1FrozenAt right after status, where build-markets.mjs puts them.
node -e '
const fs = require("fs"); const [file, t, ts] = process.argv.slice(1);
if (!/^[1-9][0-9]{9}$/.test(ts)) throw new Error("v1FrozenAt must be unix seconds, got " + ts);
const r = JSON.parse(fs.readFileSync(file, "utf8"));
const i = r.markets.findIndex((m) => m.ticker === t);
if (i < 0 || !r.markets[i].deployment?.factory) throw new Error(t + ": no such market with a factory");
const o = {};
for (const [k, v] of Object.entries(r.markets[i])) {
  if (k === "v1RunOff" || k === "v1FrozenAt") continue;
  o[k] = v;
  if (k === "status") { o.v1RunOff = true; o.v1FrozenAt = Number(ts); }
}
r.markets[i] = o;
fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
console.log(t + ": v1RunOff true, v1FrozenAt " + ts + " (" + new Date(ts * 1000).toISOString() + ")");
' "$TREG" "$TICKER" "$V1_FROZEN_AT" | sed 's/^/  /'
set +e; diff -u "$REGISTRY" "$TREG" > "$TMP/registry.diff"; set -e
scrub < "$TMP/registry.diff"
expect "lines added to the registry" "$(grep -c '^+ ' "$TMP/registry.diff" || true)" 2
expect "lines removed from the registry" "$(grep -c '^- ' "$TMP/registry.diff" || true)" 0

note "\$ node ops/keeper-env.sh --registry <copy> --out <tmp>/keeper-markets --tickers $TICKER"
node "$HERE/keeper-env.sh" --registry "$TREG" --out "$TMP/keeper-markets" --tickers "$TICKER" | scrub
ENVF="$TMP/keeper-markets/$TICKER.env"
set +e; diff "$HERE/keeper/markets/$TICKER.env" "$ENVF" > "$TMP/env.diff"; set -e
sed 's/^/  | /' "$TMP/env.diff"
expect "SOLO_WIND_DOWN in the rendered $TICKER.env" "$(sed -n 's/^SOLO_WIND_DOWN=//p' "$ENVF")" 1
expect "variables added besides SOLO_WIND_DOWN" "$(grep -E '^> [A-Z_]+=' "$TMP/env.diff" | grep -vc '^> SOLO_WIND_DOWN=' || true)" 0
expect "lines removed from $TICKER.env besides the render time" "$(grep -E '^< ' "$TMP/env.diff" | grep -vc '^< # rendered ' || true)" 0
note "\$ node ops/keeper-env.sh --check      # the REAL registry and committed files, untouched"
node "$HERE/keeper-env.sh" --check | sed 's/^/  | /'
pass "keeper-env.sh --check on the real registry"

note "\$ node ops/markets/render-docs.mjs --out <tmp>/markets.md      (on the copy)"
node "$C/ops/markets/render-docs.mjs" --out "$TMP/markets.md" | scrub
ROW=$(grep -F "| **$TICKER** | [\`$F\`]" "$TMP/markets.md" || true)
note "legacy row: $ROW"
DAY=$(iso "$V1_FROZEN_AT" | cut -c1-10)
case "$ROW" in *"Running off: frozen on $DAY"*) pass "docs legacy row says 'Running off: frozen on $DAY'" ;; *) die "docs legacy row does not say 'Running off: frozen on $DAY': $ROW" ;; esac

note "\$ node web/scripts/gen-markets.mjs      (on the copy)"
node "$C/web/scripts/gen-markets.mjs" 2>&1 | scrub
expect "non-null v1FrozenAt entries in markets.generated.ts" "$(grep -c "v1FrozenAt: [0-9]" "$C/web/lib/markets.generated.ts" || true)" 1
expect "v1FrozenAt in markets.generated.ts" "$(sed -n 's/.*v1FrozenAt: \([0-9][0-9]*\).*/\1/p' "$C/web/lib/markets.generated.ts")" "$V1_FROZEN_AT"

if [ "$WITH_BUILD_CHECK" = 1 ]; then
  note "\$ node ops/markets/build-markets.mjs --check      (on the copy; mainnet reads, about a minute)"
  set +e
  RH_RPC="$FORK_URL" node "$C/ops/markets/build-markets.mjs" --check > "$TMP/build.out" 2>&1
  rc=$?
  set -e
  tail -4 "$TMP/build.out" | sed 's/^/  | /'
  expect "build-markets.mjs --check exit code on the copy" "$rc" 0
else
  note "build-markets.mjs --check skipped (--no-build-check)"
fi
$GIT -C "$APP" diff --quiet -- ops/markets/tier1.json ops/keeper/markets web/lib/markets.generated.ts \
  || die "the real registry, keeper env files or markets.generated.ts changed"
pass "real registry, ops/keeper/markets and web/lib/markets.generated.ts unchanged"

# ---------------------------------------------------------------- 7. the keeper in run-off
if [ "$WITH_KEEPER" = 1 ]; then
  step "9. keeper with the rendered $TICKER.env on the fork (runbook steps 7, 8 and 10)"
  KENV="$TMP/keeper.env"
  (
    umask 077
    grep -E '^[A-Z_0-9]+=' "$ENVF" | grep -vE '^(RH_RPC|RH_RPC_2|ALERT_WEBHOOK|KEEPER_DB_PATH|KEEPER_PORT|PORT|POLL_INTERVAL_MS)='
    printf 'RH_RPC=%s\nKEEPER_DB_PATH=%s\nKEEPER_PORT=%s\nPORT=%s\nPOLL_INTERVAL_MS=5000\nKEEPER_LOG_LEVEL=info\n' "$RPC" "$TMP/keeper.db" "$KEEPER_PORT" "$KEEPER_PORT"
  ) > "$KENV"
  note "environment: the rendered file minus RH_RPC, RH_RPC_2, ALERT_WEBHOOK, KEEPER_DB_PATH, KEEPER_PORT, PORT, POLL_INTERVAL_MS; plus the fork RPC, a temp DB, port $KEEPER_PORT, a 5 s poll, and a throwaway KEEPER_PK (not shown)"
  scrub < "$KENV"
  ( umask 077; printf 'KEEPER_PK=0x%s\n' "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')" >> "$KENV" )
  KADDR=$(KENV="$KENV" NODE_PATH="$APP/keeper/node_modules" node -e '
    const pk = require("fs").readFileSync(process.env.KENV, "utf8").match(/^KEEPER_PK=(0x[0-9a-f]{64})$/m)[1];
    process.stdout.write(require("viem/accounts").privateKeyToAccount(pk).address)')
  note "throwaway keeper address $KADDR (fork only)"
  cast rpc anvil_setBalance "$KADDR" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
  as "$ADMIN" "$F" "grantRole(bytes32,address)" "$KEEPER_ROLE" "$KADDR"
  WEEK_BEFORE=$(quiet "$F" "week()(uint32,uint256,uint40,uint40,uint256)")
  (cd "$APP/keeper" && exec env -i PATH="$PATH" HOME="$HOME" KEEPER_ENV_FILE="$KENV" node --import tsx src/index.ts) > "$TMP/keeper.log" 2>&1 &
  KEEPER_PID=$!
  H="http://127.0.0.1:$KEEPER_PORT"
  health=""
  for _ in $(seq 1 90); do
    health=$(curl -sf "$H/health" 2>/dev/null || true)
    [ -n "$health" ] && [ "$(printf '%s' "$health" | jq -r '.factory.liveCount // "null"')" != null ] && break
    kill -0 "$KEEPER_PID" 2>/dev/null || { tail -20 "$TMP/keeper.log" | sed 's/^/  keeper: /'; die "the keeper exited"; }
    sleep 1
  done
  note "\$ curl -s $H/health | jq '{status, market, factory: (.factory | {address, windDown, writesHalted, liveCount, pendingCount, hasKeeperRole, weekId})}'"
  printf '%s' "$health" | jq '{status, market, factory: (.factory | {address, windDown, writesHalted, liveCount, pendingCount, hasKeeperRole, weekId})}' | sed 's/^/      /'
  expect "/health factory.windDown" "$(printf '%s' "$health" | jq -r .factory.windDown)" true
  expect "/health factory.writesHalted" "$(printf '%s' "$health" | jq -r .factory.writesHalted)" true
  expect "/health factory.hasKeeperRole" "$(printf '%s' "$health" | jq -r .factory.hasKeeperRole)" true
  state=$(curl -sf "$H/state")
  note "\$ curl -s $H/state | jq '{windDown, nextWeek, drainedAt, liveCount, pendingCount}'"
  printf '%s' "$state" | jq -c '{windDown, nextWeek, drainedAt, liveCount, pendingCount}' | sed 's/^/      /'
  expect "/state windDown" "$(printf '%s' "$state" | jq -r .windDown)" true
  expect "/state nextWeek" "$(printf '%s' "$state" | jq -r .nextWeek)" null

  SETTLES=0
  if [ "$LIVE" -gt 0 ]; then
    note "settle safety check before the expiry: USDG paused $(quiet "$USDG" "paused()(bool)"), NVDA paused $(quiet "$NVDA" "paused()(bool)") (per account above)"
    expect "keeper sent nothing before the expiry (nonce)" "$(cast nonce "$KADDR" --rpc-url "$RPC")" 0
    note "anvil warps to the last listedExpiryTs $LAST_EXPIRY and mines one block"
    cast rpc evm_setNextBlockTimestamp "$LAST_EXPIRY" --rpc-url "$RPC" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC" >/dev/null
    for _ in $(seq 1 90); do [ "$(quiet "$F" "liveCount()(uint256)")" = 0 ] && break; sleep 1; done
    expect "liveCount after the keeper's settle" "$(call "$F" "liveCount()(uint256)")" 0
    SETTLES=$LIVE
  fi
  for _ in $(seq 1 60); do
    [ "$(curl -sf "$H/state" | jq -r '.drainedAt // "null"')" != null ] && break
    sleep 1
  done
  state=$(curl -sf "$H/state")
  printf '%s' "$state" | jq -c '{windDown, nextWeek, drainedAt, liveCount, pendingCount}' | sed 's/^/      /'
  [ "$(printf '%s' "$state" | jq -r '.drainedAt // "null"')" != null ] || die "/state drainedAt stayed null: no v1_drained"
  pass "/state drainedAt set (v1_drained raised)"
  expect "transactions the keeper sent (settles only)" "$(cast nonce "$KADDR" --rpc-url "$RPC")" "$SETTLES"
  expect "week() unchanged: no setWeek in run-off" "$(quiet "$F" "week()(uint32,uint256,uint40,uint40,uint256)")" "$WEEK_BEFORE"
  note "keeper log (info and above; pino JSON reduced to level and message):"
  jq -Rr 'fromjson? | select(.msg != null) | "\(.level)\t\(.msg)\(if .kind then "  kind=" + .kind else "" end)\(if .tx then "  tx=" + .tx else "" end)"' "$TMP/keeper.log" \
    | grep -vE 'solo tick' | sed -E -e "s#[^ =]*v1-runoff-rehearse\\.[A-Za-z0-9]+#<tmp>#g" -e 's/^/      /'
  expect "v1_drained alerts in the keeper log" "$(grep -c '"kind":"v1_drained"' "$TMP/keeper.log" || true)" 1
  grep -q 'SOLO_WIND_DOWN: v1 run-off; settling only' "$TMP/keeper.log" || die "no SOLO_WIND_DOWN boot line"
  pass "SOLO_WIND_DOWN run-off line logged"
  kill "$KEEPER_PID" 2>/dev/null || true; wait "$KEEPER_PID" 2>/dev/null || true; KEEPER_PID=""
  note "keeper stopped"

  if [ -n "$ACCOUNT" ]; then
    step "10. the writer takes the collateral home on the frozen market (runbook step 11)"
    IDLE=$(call "$ACCOUNT" "idleAssets()(uint256)")
    expect "idleAssets after settle (the unsold lot released)" "$IDLE" 2000000000000000000
    as "$WRITER" "$ACCOUNT" "withdraw(uint256)" "$IDLE"
    expect "writer NVDA balance after withdraw" "$(quiet "$NVDA" "balanceOf(address)(uint256)" "$WRITER")" 2000000000000000000
  fi
fi

step "REHEARSAL PASSED: $PASSES checks. Fork block $FORK_BLOCK; freeze in block $FREEZE_BLOCK; v1FrozenAt $V1_FROZEN_AT on the fork (mainnet gets its own)."
