#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/devnet/up.sh — a local Stonkhouse v2 chain: an anvil fork of Robinhood Chain (4663) with the v2
# core contracts and the periphery (AutoRoller, UniV3PayoutAdapter, MakerVault + MakerRegistry +
# RewardsDistributor) deployed (callhouse-contracts script/v2/DevDeploy.s.sol) against the REAL USDG,
# NVDA, TSLA, feeds, USDG/NVDA pool and SwapRouter02, seeded with a market (ops/devnet/seed.mjs), and the
# env blocks for the indexer, the keeper modes, the notifier and the web app printed at the end.
#
#   ops/devnet/up.sh                       fresh devnet on 127.0.0.1:8546 (kills an old devnet anvil first)
#   DEVNET_PORT=8547 ops/devnet/up.sh      another port
#   ops/devnet/down.sh [--clean]           stop it
#
# Steps: stop the old anvil -> forge build -> anvil --fork-url (RH_RPC, default the public RPC)
# --code-size-limit 98304 --block-time 1 -> dev accounts cleared of EIP-7702 code, USDG to the admin ->
# DevDeploy (forge script --broadcast --unlocked from anvil account #0) -> addresses.json -> seed trade
# (+ periphery setup and route warm-up swaps) -> DETACH -> seed session (roll, vault quotes) and settle
# (+ gates) -> tier1.devnet.json -> env blocks.
#
# DETACH (DEVNET_DETACH=1, the default). The public RPC serves state only ~15 minutes behind its head,
# and a fork reads every storage slot it has not seen from the RPC AT THE FORK BLOCK: a quarter of an
# hour after start, any new read (a new wallet's balance, a view nobody called yet) fails with
# "historical state ... is not available". So once the market is seeded, up.sh sends one warm-up
# transaction (seed.mjs warm), dumps the node's state (anvil_dumpState), and restarts anvil from that
# dump with no fork. Everything the deploy, the seed and the warm-up touched is kept, including every
# block and log since the fork; a slot never touched reads as zero, which is what it would be for any
# new account. The settlement half of the seed runs on the detached node, so the gate proves it works.
# With an archive endpoint in RH_RPC, DEVNET_DETACH=0 keeps the fork attached instead.
#
# The anvil process outlives this script and the shell that ran it: a one-shot exec session (an agent's
# `bash -c`, a CI step) tears its process group down when it returns, and nohup alone does not leave
# that group. start_anvil below gives anvil its own session and process group (setsid, no controlling
# terminal), stdin from /dev/null, and records the pid, port and process start time in
# state/anvil.pid; down.sh checks all three before stopping it. A custom fork RPC suppresses
# Anvil's raw output because its connection errors can include the resolved keyed URL.
#
# Environment
#   DEVNET_PORT       8546
#   RH_RPC            fork source, default https://rpc.mainnet.chain.robinhood.com. anvil runs from the
#                     contracts checkout with `--fork-url rh` (foundry.toml [rpc_endpoints]), so a keyed URL
#                     never appears on a command line; it is never printed or recorded either.
#   CONTRACTS_DIR     callhouse-contracts checkout with script/v2/DevDeploy.s.sol, default ../callhouse-contracts
#   DEVNET_DETACH     1 (default) | 0, see above
#   DEVNET_KEEP_ON_FAIL  1 leaves a failed run's anvil running for inspection (default: stopped)
#   DevDeploy knobs (BOUNTY_*, KEEPER_DAILY_CAP, KEEPER_FUND, PAYOUT_SLIPPAGE_BPS, MM_*,
#   DEV_AUTO_ROLLER, DEV_PAYOUT_ADAPTER, DEV_MAKER_SUITE = auto (default: deployed) | 0 (off) | 1 (required))
#   pass through; market, fee and SwapRouter02 values always come from ops/markets/dev.json. A periphery
#   contract switched off is null in addresses.json, skipped by the seed, and its gates do not apply.
#   DEV_MOCK_FEED=0 is refused here: the seeded settlement is driven through the mock feeds. Run
#   DevDeploy by hand for a real-feed deploy (ops/devnet/README.md).
#
# Keys: none. Every transaction is sent from one of anvil's unlocked dev accounts; the env blocks print
# anvil's PUBLIC dev keys for the bot signers. `set -o pipefail` is on: no gate here hides behind a pipe.
# -------------------------------------------------------------------------------------------------
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
export PATH="$HOME/.foundry/bin:$PATH"

PORT=${DEVNET_PORT:-8546}
export DEVNET_PORT=$PORT
RPC="http://127.0.0.1:$PORT"
PUBLIC_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_RPC=${RH_RPC:-$PUBLIC_RPC}
FORK_KIND=public; [ "$RH_RPC" = "$PUBLIC_RPC" ] || FORK_KIND=custom
CONTRACTS_DIR=${CONTRACTS_DIR:-$ROOT/../callhouse-contracts}
DETACH=${DEVNET_DETACH:-1}
STATE_DIR="$HERE/state"
# F8-03 criterion 2: the devnet builds from the decoupled dev registry (O8-01), never from the
# production one. dev.json carries the same v8 fee block plus a _dev marker and an isolation check
# that refuses a production wallet; the generated copy below keeps its historical filename because
# the indexer, the monitor, the web acceptance suite and three READMEs all name it.
REGISTRY="$ROOT/ops/markets/dev.json"
SOURCES="$ROOT/ops/markets/v2-sources.json"
T0=$(date +%s)

die() { echo "DEVNET UP FAILED: $*" >&2; exit 1; }
step() { printf '\n== %s  (+%ss)\n' "$*" "$(( $(date +%s) - T0 ))"; }

case "$DETACH" in 0|1) ;; *) die "DEVNET_DETACH must be 0 or 1, got '$DETACH'" ;; esac
[ "${DEV_MOCK_FEED:-1}" = 1 ] || die "DEV_MOCK_FEED=${DEV_MOCK_FEED}: up.sh seeds a settlement through the mock feeds; run DevDeploy by hand for a real-feed deploy (README)"
for tool in anvil forge cast node lsof; do command -v "$tool" >/dev/null || die "$tool not on PATH"; done
for flag in DEV_AUTO_ROLLER DEV_PAYOUT_ADAPTER DEV_MAKER_SUITE; do
  case "${!flag:-auto}" in auto|0|1) ;; *) die "$flag must be auto, 0 or 1, got '${!flag}'" ;; esac
done
[ -f "$CONTRACTS_DIR/script/v2/DevDeploy.s.sol" ] || die "no script/v2/DevDeploy.s.sol under CONTRACTS_DIR=$CONTRACTS_DIR (set CONTRACTS_DIR to a callhouse-contracts checkout on v2)"
# seed.mjs reads the periphery ABIs from this checkout's forge artifacts until ops/abis/v2 carries them.
CONTRACTS_DIR=$(cd "$CONTRACTS_DIR" && pwd)
export CONTRACTS_DIR
[ -f "$REGISTRY" ] || die "registry not found: $REGISTRY"
node -e 'require("node:module").createRequire(process.argv[1] + "/keeper/package.json")("viem")' "$ROOT" 2>/dev/null \
  || die "viem is not installed in the workspace: run 'pnpm install --frozen-lockfile' at $ROOT"

# ---------------------------------------------------------------- the old devnet
# One devnet per checkout: addresses.json, the registry copy, env/ and state/ are shared by every port.
process_start() { ps -p "$1" -o lstart= 2>/dev/null | awk '{$1=$1; print}'; }
if [ -f "$STATE_DIR/anvil.pid" ]; then
  read -r other_pid other_port other_start < "$STATE_DIR/anvil.pid" || true
  if [ -n "${other_port:-}" ] && [ "$other_port" != "$PORT" ] && [ -n "${other_start:-}" ] \
    && [ "$(process_start "${other_pid:-0}")" = "$other_start" ] \
    && ps -p "$other_pid" -o comm= 2>/dev/null | grep -q anvil; then
    die "this checkout's devnet is running on port $other_port; stop it first (DEVNET_PORT=$other_port ops/devnet/down.sh)"
  fi
fi
step "stop this checkout's devnet anvil on port $PORT"
"$HERE/down.sh" --quiet || die "port $PORT is busy with an unowned process or could not be stopped"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then die "port $PORT is still in use"; fi
rm -rf "$STATE_DIR" "$HERE/addresses.json" "$HERE/tier1.devnet.json" "$HERE/env"

mkdir -p "$STATE_DIR"

ANVIL_PID=""
SUCCESS=0
cleanup() {
  if [ "$SUCCESS" != 1 ] && [ -n "$ANVIL_PID" ] && [ "${DEVNET_KEEP_ON_FAIL:-0}" != 1 ]; then
    # anvil is not in this script's process group any more, so nothing stops it but this.
    if "$HERE/down.sh" --quiet; then
      echo "(anvil pid $ANVIL_PID stopped after the failure; DEVNET_KEEP_ON_FAIL=1 keeps it)" >&2
    else
      echo "(could not stop anvil pid $ANVIL_PID after the failure: run DEVNET_PORT=$PORT $HERE/down.sh)" >&2
    fi
  fi
}
trap cleanup EXIT
# An interrupted or hung-up run is a failed run: exit through the EXIT trap, which stops the anvil.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# start_anvil <dir> <log> <anvil args...>: anvil in its own session and process group through node's
# detached spawn (setsid in the child, so pgid = pid and no controlling terminal), under nohup, stdin
# /dev/null, stdout and stderr to <log>, no other descriptor inherited. A custom fork RPC may
# carry a key, which Anvil includes in connection errors, so its raw output goes to /dev/null.
# nohup execs anvil, so the pid recorded in state/anvil.pid is anvil's. Sets ANVIL_PID.
start_anvil() {
  local dir=$1 log=$2 output_log=$2
  shift 2
  if [ "$FORK_KIND" = custom ] && [ "${1:-}" = --fork-url ]; then
    printf 'Anvil fork output suppressed because RH_RPC may contain credentials.\n' > "$log"
    output_log=/dev/null
  fi
  ANVIL_PID=$(node -e '
    const [dir, log, ...args] = process.argv.slice(1);
    const out = require("node:fs").openSync(log, "w");
    const child = require("node:child_process").spawn("nohup", ["anvil", ...args], { cwd: dir, detached: true, stdio: ["ignore", out, out] });
    child.on("error", (error) => { process.stderr.write(`spawn nohup anvil: ${error.message}\n`); process.exit(1); });
    child.on("spawn", () => { child.unref(); process.stdout.write(String(child.pid)); process.exit(0); });
  ' -- "$dir" "$output_log" "$@") || die "could not start anvil (log: $log)"
  case "$ANVIL_PID" in ""|*[!0-9]*) die "could not start anvil: no pid (got '$ANVIL_PID', log: $log)" ;; esac
  local started
  started=$(process_start "$ANVIL_PID") || die "could not read anvil process start time (pid $ANVIL_PID)"
  [ -n "$started" ] || die "could not read anvil process start time (pid $ANVIL_PID)"
  printf '%s %s %s\n' "$ANVIL_PID" "$PORT" "$started" > "$STATE_DIR/anvil.pid"
}

wait_rpc() { # log
  for _ in $(seq 1 240); do
    if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then return 0; fi
    kill -0 "$ANVIL_PID" 2>/dev/null || { tail -20 "$1" >&2; die "anvil exited (log: $1)"; }
    sleep 0.25
  done
  tail -20 "$1" >&2
  die "anvil did not answer on $RPC (log: $1)"
}

# ---------------------------------------------------------------- build before the fork clock starts
step "forge build ($CONTRACTS_DIR)"
(cd "$CONTRACTS_DIR" && forge build) > "$STATE_DIR/forge-build.log" 2>&1 \
  || { tail -30 "$STATE_DIR/forge-build.log" >&2; die "forge build failed (log: $STATE_DIR/forge-build.log)"; }

# ---------------------------------------------------------------- fork
step "anvil fork of chain 4663 on $RPC ($FORK_KIND RPC)"
# --fork-url rh: foundry.toml's [rpc_endpoints] rh = "${RH_RPC}", resolved by anvil from the environment.
start_anvil "$CONTRACTS_DIR" "$STATE_DIR/anvil-fork.log" --fork-url rh --chain-id 4663 --code-size-limit 98304 \
  --block-time 1 --port "$PORT" --accounts 12
wait_rpc "$STATE_DIR/anvil-fork.log"
[ "$(cast chain-id --rpc-url "$RPC")" = 4663 ] || die "the node is not chain 4663"
case "$(cast rpc web3_clientVersion --rpc-url "$RPC")" in '"anvil/'*) ;; *) die "the node on $RPC is not anvil" ;; esac
FORK_BLOCK=$(cast rpc anvil_nodeInfo --rpc-url "$RPC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(Number(j.forkConfig?.forkBlockNumber ?? j.currentBlockNumber)))})')
case "$FORK_BLOCK" in ""|*[!0-9]*) die "could not read the fork block from anvil_nodeInfo (got '$FORK_BLOCK')" ;; esac
# Chain 4663 allows 98,304 B of code: a 30,000 B runtime must deploy (script/DeploySoloBatch.sh's probe).
cast call --rpc-url "$RPC" --create 0x6175306000f3 >/dev/null 2>&1 || die "this anvil refuses a 30,000 B contract (--code-size-limit)"
echo "  fork block $FORK_BLOCK, anvil pid $ANVIL_PID, log $STATE_DIR/anvil-fork.log"

# ---------------------------------------------------------------- deploy
step "dev accounts as plain EOAs, USDG for the admin (KeeperRewards budget), deployer nonce pinned"
node "$HERE/devnet.mjs" prepare --usdg 20000
START_BLOCK=$(( $(cast block-number --rpc-url "$RPC") + 1 ))

step "DevDeploy (forge script --broadcast --unlocked from anvil account #0)"
reg() { node -e 'const r=require(process.argv[1]); const f=new Function("r","return ("+process.argv[2]+")"); const v=f(r); if(v===undefined||v===null) process.exit(3); console.log(String(v))' "$REGISTRY" "$1" \
  || die "registry value missing: $1"; }
ACCOUNTS=$(cast rpc eth_accounts --rpc-url "$RPC")
acct() { node -e 'console.log(JSON.parse(process.argv[1])[Number(process.argv[2])])' "$ACCOUNTS" "$1"; }
HOLIDAYS=$(node -e 'const s=require(process.argv[1]); console.log(Object.values(s.nyseHolidays).flatMap((y)=>y.fullDays.map((d)=>d.dayIndex)).join(","))' "$SOURCES")
DEVDEPLOY_OUT="broadcast/devnet/devdeploy.json"
(
  cd "$CONTRACTS_DIR"
  mkdir -p broadcast/devnet
  rm -f "$DEVDEPLOY_OUT"
  export ADMIN; ADMIN=$(acct 0)
  export GUARDIAN; GUARDIAN=$(acct 1)
  export FEE_RECIPIENT; FEE_RECIPIENT=$(acct 2)
  export DEV_PRICER; DEV_PRICER=$(acct 9)
  export DEV_MM_QUOTER; DEV_MM_QUOTER=$(acct 10)
  export USDG; USDG=$(reg 'r.shared.usdg')
  export NVDA_TOKEN; NVDA_TOKEN=$(reg 'r.markets.find((m)=>m.ticker==="NVDA").asset')
  export NVDA_FEED; NVDA_FEED=$(reg 'r.markets.find((m)=>m.ticker==="NVDA").feed')
  export NVDA_POOL; NVDA_POOL=$(reg 'r.markets.find((m)=>m.ticker==="NVDA").v2.univ3Pool')
  export NVDA_MIN_LIQUIDITY; NVDA_MIN_LIQUIDITY=$(reg 'r.markets.find((m)=>m.ticker==="NVDA").v2.univ3MinLiquidity')
  export NVDA_STRIKE_TICK; NVDA_STRIKE_TICK=$(reg 'r.markets.find((m)=>m.ticker==="NVDA").v2.strikeTick')
  export TSLA_TOKEN; TSLA_TOKEN=$(reg 'r.markets.find((m)=>m.ticker==="TSLA").asset')
  export TSLA_FEED; TSLA_FEED=$(reg 'r.markets.find((m)=>m.ticker==="TSLA").feed')
  export TSLA_STRIKE_TICK; TSLA_STRIKE_TICK=$(reg 'r.markets.find((m)=>m.ticker==="TSLA").v2.strikeTick')
  export PREMIUM_FEE_BPS; PREMIUM_FEE_BPS=$(reg 'r.v2.fees.premiumFeeBps')
  # INTERFACE_VERSION 7 (c05): the writer fee is collateral rent, and DevDeploy defaults MINT_FEE_PPM to 0. Without
  # this export every devnet market would register at 0 ppm and no devnet run would exercise a mint fee or a refund.
  # The vault's six Limits default in DevDeploy to exactly the registry's v2.vault, so they need no export here.
  export MINT_FEE_PPM; MINT_FEE_PPM=$(reg 'r.v2.fees.mintFeePpm')
  export RESALE_FEE_BPS; RESALE_FEE_BPS=$(reg 'r.v2.fees.resaleFeeBps')
  export TAKER_FEE_FLAT; TAKER_FEE_FLAT=$(reg 'r.v2.fees.takerFeeFlat')
  export TAKER_FEE_CAP_BPS; TAKER_FEE_CAP_BPS=$(reg 'r.v2.fees.takerFeeCapBps')
  export MAKER_REBATE_BPS; MAKER_REBATE_BPS=$(reg 'r.v2.fees.makerRebateBps')
  export EXERCISE_FEE_BPS; EXERCISE_FEE_BPS=$(reg 'r.v2.fees.exerciseFeeBps')
  export MAX_DEVIATION_BPS; MAX_DEVIATION_BPS=$(reg 'r.v2.defaults.maxDeviationBps')
  export UNCORROBORATED_DELAY_S; UNCORROBORATED_DELAY_S=$(reg 'r.v2.defaults.uncorroboratedDelayS')
  export SPOT_MAX_AGE_S; SPOT_MAX_AGE_S=$(reg 'r.v2.defaults.spotMaxAgeS')
  export SWAP_ROUTER_02; SWAP_ROUTER_02=$(reg 'r.v2.uniswapV3.swapRouter02')
  export DEV_HOLIDAYS="$HOLIDAYS" DEV_MOCK_FEED=1 DEVNET_OUT="$DEVDEPLOY_OUT"
  # Keep the devnet's forge records apart from anything a real deploy writes under broadcast/.
  export FOUNDRY_BROADCAST=broadcast/devnet/forge
  # --no-storage-caching: the fork mines at real chain-4663 heights; never let forge cache its state (docs/DEPLOY.md).
  forge script script/v2/DevDeploy.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$ADMIN" \
    --non-interactive --no-storage-caching
) > "$STATE_DIR/devdeploy.log" 2>&1 || { tail -40 "$STATE_DIR/devdeploy.log" >&2; die "DevDeploy failed (log: $STATE_DIR/devdeploy.log)"; }
[ -f "$CONTRACTS_DIR/$DEVDEPLOY_OUT" ] || die "DevDeploy wrote no $DEVDEPLOY_OUT"
cp "$CONTRACTS_DIR/$DEVDEPLOY_OUT" "$STATE_DIR/devdeploy.json"
grep -E "^\s+(ExpiryCalendar|ChainlinkFeedSource|UniV3TwapSource|SettlementOracle|Clearinghouse|OrderBook|KeeperRewards|AutoRoller|PayoutAdapter|MakerVault|MakerRegistry|RewardsDistributor|market) " "$STATE_DIR/devdeploy.log" | sed 's/^ */  /' || true
for c in clearinghouse orderBook settlementOracle expiryCalendar keeperRewards; do
  a=$(node -e 'console.log(require(process.argv[1]).contracts[process.argv[2]])' "$STATE_DIR/devdeploy.json" "$c")
  [ "$(cast codesize "$a" --rpc-url "$RPC")" -gt 0 ] || die "$c: no code at $a after the broadcast"
done
# Periphery: null only when its flag is 0 (or, for the PayoutAdapter under auto, no SwapRouter02 code).
for pair in autoRoller:DEV_AUTO_ROLLER payoutAdapter:DEV_PAYOUT_ADAPTER makerVault:DEV_MAKER_SUITE makerRegistry:DEV_MAKER_SUITE rewardsDistributor:DEV_MAKER_SUITE; do
  c=${pair%%:*}; flag=${pair#*:}
  a=$(node -e 'console.log(require(process.argv[1]).contracts[process.argv[2]] ?? "")' "$STATE_DIR/devdeploy.json" "$c")
  if [ -z "$a" ]; then
    [ "${!flag:-auto}" = 0 ] || die "$c was not deployed although $flag=${!flag:-auto} (log: $STATE_DIR/devdeploy.log)"
    echo "  $c: off ($flag=0)"
    continue
  fi
  [ "$(cast codesize "$a" --rpc-url "$RPC")" -gt 0 ] || die "$c: no code at $a after the broadcast"
done

node "$HERE/devnet.mjs" addresses --devdeploy "$STATE_DIR/devdeploy.json" --fork-block "$FORK_BLOCK" \
  --start-block "$START_BLOCK" --fork "$FORK_KIND" --detached 0

# ---------------------------------------------------------------- v8 contract gates
# DevDeploy's own gates above cover the v7 set. INTERFACE_VERSION 8 adds a manager that everything is
# Managed by, and a flywheel that DevDeploy does not build; gate what exists and SAY what does not,
# because a gate that silently passes over a missing contract is worse than no gate.
step "v8 contract gates"
MANAGER=$(node -e 'console.log(require(process.argv[1]).contracts.accessManager ?? "")' "$HERE/addresses.json")
[ -n "$MANAGER" ] || die "addresses.json has no contracts.accessManager"
[ "$(cast codesize "$MANAGER" --rpc-url "$RPC")" -gt 0 ] || die "accessManager: no code at $MANAGER"
echo "  accessManager $MANAGER"
for c in feeSplitter buybackExecutor; do
  a=$(node -e 'console.log(require(process.argv[1]).flywheel?.[process.argv[2]] ?? "")' "$HERE/addresses.json" "$c")
  if [ -z "$a" ]; then
    # Not a failure of this devnet: script/v2/DevDeploy.s.sol contains no FeeSplitter and no
    # V4BuybackExecutor at all, so there is nothing on chain to gate. T-119's ledger entry records it.
    echo "  $c: NOT DEPLOYED on this devnet (DevDeploy builds no flywheel) -- nothing to gate"
    continue
  fi
  [ "$(cast codesize "$a" --rpc-url "$RPC")" -gt 0 ] || die "$c: no code at $a"
  echo "  $c $a"
done

# ---------------------------------------------------------------- hand the roles to the test Safe
# DevDeploy grants every privileged role to the admin EOA at delay 0 (DevDeploy.s.sol:471-477), which
# is the arrangement v8 exists to end. Move them onto a contract, at the manifest's real delays.
step "role hand-over: the test Safe takes roles 0-6 at the delays ops/abis/v2/roles.json names"
node "$HERE/devnet.mjs" safe

# ---------------------------------------------------------------- the 72 h lane, crossed for real
# MARKET_FEE_MANAGER is the longest lane in the manifest (delaysS 259200 = 72 h). Crossing it here,
# BEFORE the seed, is what makes the rest of this script honest about time: the driver schedules the
# operation, moves the NODE clock past the delay (ops/devnet/lib.mjs warpTo -> evm_setNextBlockTimestamp
# + evm_mine, never a forge cheatcode, which would move only a script's own EVM) and then executes.
#
# THE ORDER IS THE POINT. seed.mjs takes t0 = now() and asks ExpiryCalendar.nextExpiry for every
# ladder (seed.mjs:173-174, 208-212), so every expiry it seeds is relative to whatever the clock says
# when it runs. Crossing the 72 h lane first therefore leaves the calendar coherent; doing it after
# the seed would push the chain past expiries that were already written and sold into.
#
# The values are the registry's own, so the operation changes nothing semantically -- it is the LANE
# that is being exercised, not a new fee.
step "the 72 h lane: setDefaultMarketFees through the admin driver, scheduled, warped and executed"
node "$ROOT/ops/v2/devnet-admin.mjs" Clearinghouse "setDefaultMarketFees(uint16,uint32)" \
  "$(reg 'r.v2.fees.exerciseFeeBps')" "$(reg 'r.v2.fees.mintFeePpm')" \
  || die "the 72 h MARKET_FEE_MANAGER lane did not complete (ops/v2/ADMIN-DRIVER.md)"
echo "  crossed MARKET_FEE_MANAGER ($(node -e 'console.log(require(process.argv[1]).delaysS.MARKET_FEE_MANAGER)' "$ROOT/ops/abis/v2/roles.json")s); the seed below reads the clock AFTER this warp"

# A WARP AGES THE FEEDS. The lane above moved the chain 72 h, and the mock rounds DevDeploy seeded
# are stamped from before it, so SettlementOracle.spot() reverts StaleSpot for every market -- the
# seed's first read dies and every later step with it. A live Chainlink feed cannot follow a warp and
# nobody can impersonate its transmitters, which is exactly why the devnet uses MockRoundFeeds: push
# a fresh round at the new clock. This is the other half of "seeded relative to the warped clock" --
# the expiries come from the calendar, the prices have to be re-stamped.
step "refresh the mock feeds after the warp (a 72 h jump makes every seeded round stale)"
node "$HERE/set-feed.mjs" --all

# ---------------------------------------------------------------- seed
step "seed: wallets, collateral, ladders, orders, fills, resale ask, periphery setup"
node "$HERE/seed.mjs" trade

if [ "$DETACH" = 1 ]; then
  step "detach: warm-up transaction, state dump, restart anvil from the dump without a fork"
  node "$HERE/seed.mjs" warm
  node "$HERE/devnet.mjs" dump --out "$STATE_DIR/devnet-state.json"
  "$HERE/down.sh" --quiet || die "could not stop the forked anvil (pid $ANVIL_PID) on port $PORT"
  start_anvil "$HERE" "$STATE_DIR/anvil.log" --load-state "$STATE_DIR/devnet-state.json" --chain-id 4663 \
    --code-size-limit 98304 --block-time 1 --port "$PORT" --accounts 12
  wait_rpc "$STATE_DIR/anvil.log"
  node "$HERE/devnet.mjs" time-floor --state "$STATE_DIR/devnet-state.json"
  node "$HERE/devnet.mjs" detached --state "$STATE_DIR/devnet-state.json"
  echo "  detached: anvil pid $ANVIL_PID serves $RPC from $STATE_DIR/devnet-state.json"
fi

step "seed: a regular session (roll, vault quotes), then warp past the first daily expiry, settle, prune, redeem; summary and gates"
node "$HERE/seed.mjs" settle

# ---------------------------------------------------------------- outputs
step "registry copy and env blocks"
node "$HERE/devnet.mjs" registry
node "$HERE/devnet.mjs" env

# ---------------------------------------------------------------- VerifyV8 against the live devnet
# The wrapper builds the whole V2_* environment from the registry copy and runs VerifyV8 read-only,
# so this is the same verifier a deploy runs, pointed at what up.sh just built -- not a second,
# weaker check written here. It is a GATE: a failure fails up.sh.
#
# THERE IS NO SKIP FLAG HERE ANY MORE. There was one, DEVNET_SKIP_VERIFY, and its stated reason was
# T-154's target drift: VerifyV8 and DeployV8 both reverted before reading anything because
# roles.v8.json named 19 targets their resolvers knew 15 of. T-154 has landed, so that reason is
# gone and the flag went with it rather than staying as a documented way to not run the gate.
#
# What running it actually showed is a DIFFERENT and narrower limit: the wrapper's --verify needs all
# sixteen CONTRACT_KEYS recorded, and a devnet has thirteen. The three it lacks are not a devnet
# defect -- DevDeploy builds no FeeSplitter and no V4BuybackExecutor at all (C8-10 / T-156), and it
# configures no Data Streams source. So the gate is REPORTED as not-runnable, naming exactly which
# keys are missing, instead of being skipped by a flag or faked as a pass. When the set is complete
# it runs, and a failure fails up.sh.
step "VerifyV8 against the live devnet"
VERIFY_SCRIPT="$CONTRACTS_DIR/script/v2/DeployV2Batch.sh"
CONTRACT_KEYS=$(sed -n 's/^CONTRACT_KEYS="\(.*\)"$/\1/p' "$VERIFY_SCRIPT" | head -1)
[ -n "$CONTRACT_KEYS" ] || die "could not read CONTRACT_KEYS from $VERIFY_SCRIPT"
# MIRROR THE WRAPPER'S OWN RESOLVER, do not re-invent it: DeployV2Batch.sh contract_of() reads
# flywheel.* from .v2.flywheel and EVERY other key -- including sources.* -- from .v2.contracts.
# Walking .v2 for all of them reported all sixteen keys missing on a devnet that has thirteen: a
# true verdict (not runnable) reached for a false reason, with a list that named contracts sitting
# right there in the file. A diagnostic that lies is worse than no diagnostic.
MISSING_KEYS=$(CONTRACT_KEYS="$CONTRACT_KEYS" node -e '
  const r = require(process.argv[1]);
  const at = (path, root) => path.split(".").reduce((o, k) => (o || {})[k], root);
  const resolve = (k) => (k.startsWith("flywheel.")
    ? at(k.slice("flywheel.".length), r.v2.flywheel)
    : at(k, r.v2.contracts));
  console.log(process.env.CONTRACT_KEYS.split(/\s+/).filter((k) => k && !resolve(k)).join(" "));
' "$HERE/tier1.devnet.json")
if [ -n "$MISSING_KEYS" ]; then
  echo "  NOT RUN: the wrapper's --verify needs all 16 v2 contract keys recorded and this devnet has fewer."
  echo "  missing: $MISSING_KEYS"
  echo "  DevDeploy builds no FeeSplitter and no V4BuybackExecutor (C8-10/T-156) and configures no Data Streams source."
  echo "  This gate runs, and fails up.sh, as soon as the deployed set is complete."
elif [ ! -x "$VERIFY_SCRIPT" ]; then
  die "no executable $VERIFY_SCRIPT: CONTRACTS_DIR must be a callhouse-contracts checkout on v8"
else
  "$VERIFY_SCRIPT" --verify --rpc "$RPC" --registry "$HERE/tier1.devnet.json" \
    --sources "$ROOT/ops/markets/v2-sources.json" --admin "$(node -e 'console.log(require(process.argv[1]).accounts.adminSafe)' "$HERE/addresses.json")" \
    > "$STATE_DIR/verify.log" 2>&1 \
    || { tail -40 "$STATE_DIR/verify.log" >&2; die "VerifyV8 failed against the devnet (log: $STATE_DIR/verify.log)"; }
  grep -E "VERIFY PASSED" "$STATE_DIR/verify.log" | sed 's/^/  /' \
    || die "VerifyV8 printed no VERIFY PASSED line (log: $STATE_DIR/verify.log)"
fi

SUCCESS=1
step "DEVNET UP"
cat <<EOF
  rpc          $RPC  (chain 4663, anvil pid $ANVIL_PID, $( [ "$DETACH" = 1 ] && echo "detached from the fork" || echo "fork attached" ))
  anvil        own session, outlives this shell; pid file $STATE_DIR/anvil.pid, log $( [ "$DETACH" = 1 ] && echo "$STATE_DIR/anvil.log" || echo "$STATE_DIR/anvil-fork.log" )
  addresses    $HERE/addresses.json   (V2_START_BLOCK $START_BLOCK)
  registry     $HERE/tier1.devnet.json
  env files    $HERE/env/{indexer,cranker,pricing,mm-bot,pricer,notifier,web}.env
  feeds        node ops/devnet/set-feed.mjs --show | NVDA --price 231.5 | --all
  warp         cast rpc evm_increaseTime 3600 --rpc-url $RPC && cast rpc evm_mine --rpc-url $RPC
  stop         DEVNET_PORT=$PORT ops/devnet/down.sh   (--clean removes the files above)
EOF
