#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v2/rehearse.sh — the O2-03 end-to-end rehearsal of Stonkhouse v2 on a fork of Robinhood Chain (4663).
#
#   ops/v2/rehearse.sh                     every step; stops every process it started on exit
#   ops/v2/rehearse.sh --keep              leave anvil and the services running (stop: node ops/v2/rehearse/stop.mjs)
#   ops/v2/rehearse.sh --skip-web          no Next build, no browser: the story's web actions are sent by script
#   ops/v2/rehearse.sh --only 3 --keep     one step against what an earlier --keep run left running
#   ops/v2/rehearse.sh --publish           also copy the report to ops/v2/REHEARSAL-<date>.md (tracked)
#   ops/v2/rehearse.sh --fork-live [--services cranker,indexer] [--registry <path>]
#                                         O3-005 live-set fork: no fresh deploy. Forks 4663 at head, impersonates
#                                         admin/writer/holder, boots the named services against the ALREADY-LIVE
#                                         addresses, writes a report under a temp dir, tears it down on exit.
#                                         THE LIVE SET IS v7, so this path reads ops/markets/v7-legacy.json, NOT
#                                         the tier1.json the numbered steps deploy from -- tier1.json is the v8
#                                         registry and every contract address in it is null until v8 deploys.
#                                         Handed a v8 registry it REFUSES by interfaceVersion and names the
#                                         numbered stack instead, rather than dying on a null address.
#                                         --registry overrides, for a soak against another committed registry.
#   ops/v2/rehearse.sh --fork-live --check
#                                         parse flags, print the live addresses and planned env; no anvil.
#
# Steps (one node module each under ops/v2/rehearse/, sharing lib.mjs):
#   1  1-fork.mjs      anvil fork (the fork block is recorded) -> callhouse-contracts script/v2/DeployV2Batch.sh
#                      --rehearse (DeployV2, RegisterMarkets NVDA + TSLA + META, VerifyV2) -> VerifyV2 alone ->
#                      Chainlink feeds etched -> owner funding -> warm-up -> detached node
#   2  2-services.mjs  Telegram stand-in, relay, Postgres, pricing stand-in, indexer-v2, cranker, mm-bot, pricer,
#                      notifier, web; each health-checked
#   3  3-story.mjs     the scripted story: writers, MM quotes, buyers, resale, bid hit by writing, expiry by warp,
#                      settlement, payouts, auto-roll, wins/leaderboard/PNL, notifications (browser screenshots)
#   4  4-drills.mjs    failure drills: indexer-down (forward, browser), feed-paused, sources-disagree, guardian-veto,
#                      cranker-killed, mint-paused, fee-change, pin-refused (each in an evm_snapshot sandbox with the live
#                      stack frozen and its own cranker), usdg-paused (forward), monitor (monitor.mjs --once in each)
#   5  5-report.mjs    out/REHEARSAL-<date>.md: steps, drills, tx hashes, gas per action, bounty spend per expiry,
#                      screenshots, deviations, what was not covered
#
# Output: ops/v2/rehearse/out/ (gitignored): state.json, ledger.json (every transaction with its gas), services.json,
# logs/, screenshots/, tier1.rehearsal.json (the registry copy the deploy wrote back), state/fork-state.json.
#
# Environment: CONTRACTS_DIR (a built callhouse-contracts checkout on v2; default ../callhouse-contracts),
# REHEARSE_FORK_BLOCK (pin anvil to a block the public RPC still serves; default: anvil pins the head),
# REHEARSE_HEADFUL=1 (a visible browser), REHEARSE_STRICT=1 (a drill that found a product issue fails step 4).
# Ports: anvil 8590 (drill MM bot 8591), services 42190-42199 (drill crankers 42199), web 3190.
#
# Keys: none. Anvil's public dev accounts and impersonation of the registry's admin and guardian on the fork only.
# Nothing is sent to a non-local RPC; the public RPC is read once, by the fork.
# -------------------------------------------------------------------------------------------------
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
R="$HERE/rehearse"
OUT="$R/out"
export PATH="$HOME/.foundry/bin:$PATH"
export CONTRACTS_DIR=${CONTRACTS_DIR:-$ROOT/../callhouse-contracts}

KEEP=0; SKIP_WEB=0; ONLY=""; PUBLISH=0; FORK_LIVE=0; CHECK=0; SERVICES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --skip-web) SKIP_WEB=1; shift ;;
    --publish) PUBLISH=1; shift ;;
    --fork-live) FORK_LIVE=1; shift ;;
    --registry) FL_REGISTRY=$2; shift 2 ;;
    --check) CHECK=1; shift ;;
    --services) [ $# -ge 2 ] || { echo "--services needs a comma list" >&2; exit 2; }; SERVICES=$2; shift 2 ;;
    --only) [ $# -ge 2 ] || { echo "--only needs a step (1-5)" >&2; exit 2; }; ONLY=$2; shift 2 ;;
    -h|--help) sed -n '3,/^# ----/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$ONLY" in ""|1|2|3|4|5) ;; *) echo "--only takes 1, 2, 3, 4 or 5" >&2; exit 2 ;; esac
if [ "$FORK_LIVE" = 1 ] && [ -n "$ONLY" ]; then
  echo "--fork-live cannot be combined with --only (the live-set path is not a numbered O2-03 step)" >&2
  exit 2
fi
if [ "$CHECK" = 1 ] && [ "$FORK_LIVE" != 1 ]; then
  echo "--check is only valid with --fork-live" >&2
  exit 2
fi

die() { echo "REHEARSAL FAILED: $*" >&2; exit 1; }

if [ "$FORK_LIVE" = 1 ]; then
  command -v node >/dev/null || die "node not on PATH"
  if [ "$CHECK" != 1 ]; then
    command -v anvil >/dev/null || die "anvil not on PATH"
    command -v jq >/dev/null || die "jq not on PATH"
    for pkg in keeper indexer relay; do
      [ -d "$ROOT/$pkg/node_modules" ] || die "$pkg/node_modules missing: run pnpm install --frozen-lockfile at $ROOT"
    done
  fi
  LIVE_OUT=$(mktemp -d "${TMPDIR:-/tmp}/rehearse-fork-live.XXXXXX")
  export REHEARSE_OUT="$LIVE_OUT"
  mkdir -p "$LIVE_OUT/logs"
  cleanup_live() {
    local code=$?
    if [ "$KEEP" = 1 ]; then
      echo "left running (--keep) under $LIVE_OUT: node $R/stop.mjs (REHEARSE_OUT=$LIVE_OUT) stops everything"
    else
      REHEARSE_OUT="$LIVE_OUT" node "$R/stop.mjs" || echo "stop.mjs failed under $LIVE_OUT" >&2
      rm -rf "$LIVE_OUT"
    fi
    exit "$code"
  }
  trap cleanup_live EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  FL_ARGS=(--services "${SERVICES:-cranker,indexer}")
  [ -n "${FL_REGISTRY:-}" ] && FL_ARGS+=(--registry "$FL_REGISTRY")
  echo "FORK-LIVE out=$LIVE_OUT services=${SERVICES:-cranker,indexer}"
  if [ "$CHECK" = 1 ]; then
    node "$R/fork-live-check.mjs" "${FL_ARGS[@]}"
  else
    node "$R/fork-live.mjs" "${FL_ARGS[@]}"
  fi
  if [ "$CHECK" = 1 ]; then
    # --check starts nothing; skip stop/rm of an empty tree by disabling KEEP cleanup's stop noise
    KEEP=1
    rm -rf "$LIVE_OUT"
  elif [ -f "$LIVE_OUT/FORK-LIVE-REPORT.json" ]; then
    echo "FORK-LIVE report: $LIVE_OUT/FORK-LIVE-REPORT.json"
    # Print a copy the caller can capture before the EXIT trap deletes the temp dir.
    jq -c '{mode,forkBlock,nvda:(.nvda|{identical,asset,enabled}),services,keys,seconds}' "$LIVE_OUT/FORK-LIVE-REPORT.json" || true
  fi
  exit 0
fi

for tool in anvil forge cast jq node pnpm initdb postgres pg_isready psql shasum; do
  command -v "$tool" >/dev/null || die "$tool not on PATH"
done
[ -f "$CONTRACTS_DIR/script/v2/DeployV2Batch.sh" ] || die "CONTRACTS_DIR=$CONTRACTS_DIR has no script/v2/DeployV2Batch.sh"
for pkg in keeper indexer relay notifier web; do
  [ -d "$ROOT/$pkg/node_modules" ] || die "$pkg/node_modules missing: run pnpm install --frozen-lockfile at $ROOT"
done
mkdir -p "$OUT/logs"

cleanup() {
  local code=$?
  if [ "$KEEP" = 1 ]; then
    echo "left running (--keep): node $R/stop.mjs stops everything"
  else
    node "$R/stop.mjs" || echo "stop.mjs failed: stop the processes in $OUT/services.json by hand" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "$ONLY" ] || [ "$ONLY" = 1 ]; then
  # A fresh rehearsal: nothing from an earlier run may be running or read back.
  if [ -f "$OUT/services.json" ] && [ "$(jq 'length' "$OUT/services.json")" != 0 ]; then
    node "$R/stop.mjs"
  fi
  rm -rf "$OUT/state.json" "$OUT/ledger.json" "$OUT/screenshots" "$OUT/db" "$OUT/pglite" "$OUT/pg" "$OUT/logs" "$OUT/monitor"
  mkdir -p "$OUT/logs" "$OUT/screenshots"
fi

WEB_FLAG=()
[ "$SKIP_WEB" = 0 ] || WEB_FLAG=(--skip-web)
T0=$(date +%s)
run_step() { # n module [args]
  local n=$1; shift
  if [ -n "$ONLY" ] && [ "$ONLY" != "$n" ]; then return 0; fi
  printf '\n######## step %s: %s  (+%ss)\n' "$n" "$1" "$(( $(date +%s) - T0 ))"
  node "$R/$1" "${@:2}" 2>&1 | tee "$OUT/logs/step-$n.log"
}
run_step 1 1-fork.mjs
run_step 2 2-services.mjs "${WEB_FLAG[@]+"${WEB_FLAG[@]}"}"
run_step 3 3-story.mjs "${WEB_FLAG[@]+"${WEB_FLAG[@]}"}"
run_step 4 4-drills.mjs "${WEB_FLAG[@]+"${WEB_FLAG[@]}"}"
REPORT_FLAG=()
[ "$PUBLISH" = 0 ] || REPORT_FLAG=(--publish)
run_step 5 5-report.mjs "${REPORT_FLAG[@]+"${REPORT_FLAG[@]}"}"

DRILLS=$(jq -r '.drills._summary // empty | "\(.passed) passed, \(.issue) passed with a product issue reported, \(.failed) failed, \(.skipped) skipped"' "$OUT/state.json" 2>/dev/null || true)
printf '\nREHEARSAL %s in %ss: %s\n' "$([ -z "$ONLY" ] && echo "steps 1-3 PASSED, step 4 drills: ${DRILLS:-not recorded}, step 5 report written" || echo "step $ONLY PASSED")" \
  "$(( $(date +%s) - T0 ))" "$OUT"
