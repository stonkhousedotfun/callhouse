#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v8/launch.sh — the v8 launch, without the operator handling a private key or a long path.
#
#   ops/v8/launch.sh rehearse     # anvil fork of 4663; mandatory before broadcast
#   ops/v8/launch.sh broadcast    # mainnet. Prompts for the literal word "deploy".
#   ops/v8/launch.sh verify       # read-only VerifyV8 against the recorded set
#   ops/v8/launch.sh anvil        # print the anvil command to run in another terminal
#
# WHAT IT DOES FOR YOU. DeployV2Batch.sh needs DEPLOYER_PK in the environment, the right --registry
# (its default resolves to a path that does not exist from a worktree) and the right --rpc. This
# supplies all three. The key is derived from mnemonic index 0 into a variable by command
# substitution -- never an argv, which `ps` would show, and never echoed.
#
# --tickers NVDA, NOT --wave canary. The registry carries TWO wave plans and they disagree: the
# v1-era top-level `.waves` says canary is [TSLA,AAPL] and puts NVDA under `live`, while the v8 plan
# in `markets[].v2.wave` says canary is [NVDA]. DeployV2Batch refuses a disagreement rather than
# pick, which is correct, so the ticker is named explicitly here. Change LAUNCH_TICKERS to widen.
# -------------------------------------------------------------------------------------------------
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

HERE=$(cd "$(dirname "$0")/../.." && pwd)                 # the app worktree (registry lives here)
CONTRACTS="${CALLHOUSE_CONTRACTS_DIR:-$(cd "$HERE/../LAUNCH-contracts" 2>/dev/null && pwd || true)}"
REG="${CALLHOUSE_REGISTRY:-$HERE/ops/markets/tier1.json}"
WALLET_FILE="${CALLHOUSE_WALLET_FILE:-$HOME/.callhouse-keys/callhouse-hot-wallet.txt}"
# T-OP-118: the default is the PUBLIC RPC. The commit this was landed from (0c7b66ca) defaulted it to a
# provider URL with an API key embedded, which is a credential in source; a keyed endpoint goes in RH_RPC.
RH_RPC="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
ANVIL_RPC="${ANVIL_RPC:-http://127.0.0.1:8545}"
TICKERS="${LAUNCH_TICKERS:-NVDA}"

die() { printf '\nLAUNCH FAILED: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

[ -n "$CONTRACTS" ] && [ -x "$CONTRACTS/script/v2/DeployV2Batch.sh" ] \
  || die "cannot find DeployV2Batch.sh; expected $HERE/../LAUNCH-contracts/script/v2/. Set CALLHOUSE_CONTRACTS_DIR."
[ -f "$REG" ] || die "no registry at $REG"

load_deployer_pk() {
  [ -f "$WALLET_FILE" ] || die "no wallet file at $WALLET_FILE"
  local phrase words tmp
  phrase="$(awk 'found { print; exit } /^Phrase:?[[:space:]]*$/ { found = 1 }' "$WALLET_FILE")"
  words=$(printf '%s' "$phrase" | wc -w | tr -d ' ')
  [ "$words" = "24" ] || die "expected a 24-word phrase after the Phrase line, got $words"
  umask 077
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  printf '%s\n' "$phrase" > "$tmp"
  unset phrase
  DEPLOYER_ADDR="$(cast wallet address --mnemonic-path "$tmp" --mnemonic-index 0)"
  # Command substitution: the key never appears in argv and is never printed.
  DEPLOYER_PK="$(cast wallet private-key --mnemonic-path "$tmp" --mnemonic-index 0)"
  export DEPLOYER_PK
  rm -f "$tmp"
}

anvil_up() { curl -s -m 5 -X POST "$ANVIL_RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"web3_clientVersion","params":[]}' 2>/dev/null | grep -q anvil; }

batch() { ( cd "$CONTRACTS" && script/v2/DeployV2Batch.sh "$@" --registry "$REG" ); }

case "${1:-}" in
  anvil)
    # --code-size-limit: the v8 set contains a contract over the 24,576 B EIP-170 limit, and chain
    # 4663 raises that limit while a default anvil does not. Without this the fork preflight refuses
    # with "this anvil refuses a 30,000 B contract" AFTER a full compile -- minutes in.
    printf 'Run this in another terminal and leave it running:\n\n  anvil --fork-url %s --port 8545 --code-size-limit 98304\n\n' "$RH_RPC"
    ;;

  rehearse)
    anvil_up || die "no anvil at $ANVIL_RPC. Run:  ops/v8/launch.sh anvil"
    # Check the code-size limit BEFORE the compile, not after it. DeployV2Batch discovers this at the
    # fork preflight, which is several minutes of solc later; there is no reason to pay that twice.
    if ! cast rpc anvil_getNodeInfo --rpc-url "$ANVIL_RPC" 2>/dev/null | grep -q '"codeSizeLimit"'; then
      : # older anvil without the field; let DeployV2Batch make the call
    else
      csl=$(cast rpc anvil_getNodeInfo --rpc-url "$ANVIL_RPC" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.environment&&j.environment.codeSizeLimit||0)}catch{console.log(0)}})')
      if [ "${csl:-0}" -lt 30000 ] 2>/dev/null; then
        die "this anvil has codeSizeLimit ${csl:-0}; the v8 set needs more. Restart it as:  anvil --fork-url <rpc> --port 8545 --code-size-limit 98304   (or: ops/v8/launch.sh anvil)"
      fi
    fi
    step "rehearsal on the anvil fork (writes a temp copy, never $REG)"
    batch --rehearse --tickers "$TICKERS" --rpc "$ANVIL_RPC"
    ;;

  broadcast)
    # The rehearsal fingerprint is what makes this safe; DeployV2Batch checks it itself and refuses
    # without a passing rehearsal of the SAME registry within 24 h. Do not try to satisfy that here.
    load_deployer_pk
    step "MAINNET broadcast, chain 4663"
    printf '   deployer   %s\n' "$DEPLOYER_ADDR"
    printf '   registry   %s\n' "$REG"
    printf '   tickers    %s\n' "$TICKERS"
    printf '   rpc        %s\n' "${RH_RPC%%/v2/*}/v2/<key>"
    printf '\n   DEPLOYER_PK is loaded into this process only. ADMIN_PK is NOT needed: at\n'
    printf '   INTERFACE_VERSION 8 the Admin Safe never signs a deploy tx (DeployV2Batch.sh:258),\n'
    printf '   and the script unsets ADMIN_PK itself. The script will ask you to type "deploy".\n'
    RH_RPC="$RH_RPC" batch --broadcast --tickers "$TICKERS" --rpc "$RH_RPC"
    ;;

  verify)
    step "read-only VerifyV8"
    batch --verify --rpc "$RH_RPC"
    ;;

  *)
    sed -n '3,/^# ----/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 2 ;;
esac
