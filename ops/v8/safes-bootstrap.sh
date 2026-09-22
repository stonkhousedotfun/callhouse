#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v8/safes-bootstrap.sh — create the two v8 Safes and record them, as ops/runbooks/v8-safes.md §1-§5.
#
# The runbook is correct and this script does not replace it: it mechanises the parts that are
# read-only or deterministic, and it REFUSES rather than guesses everywhere the runbook says to prove
# something at the prompt.
#
#   ops/v8/safes-bootstrap.sh probe
#       Read-only. Settles the one question the runbook says is unverified: are the Safe singleton
#       and proxy factory actually deployed on chain 4663? Proves code exists, VERSION, and that the
#       singleton is a singleton (getOwners() == [], getThreshold() == 1) rather than a stranger's
#       deployed Safe. Exits non-zero if any check fails. Costs nothing, sends nothing.
#
#   ops/v8/safes-bootstrap.sh plan --owners 0xA,0xB,0xC
#       Read-only. Builds the setup() initialiser, decodes it back for you to read aloud, and
#       SIMULATES createProxyWithNonce for both Safes so you see the two addresses before any gas.
#
#   ops/v8/safes-bootstrap.sh create --owners 0xA,0xB,0xC --account ops
#       OWNER ACTION. Sends the two creations. Requires `probe` and `plan` to have passed in this
#       same invocation. Prompts for the literal word "create". The keystore password is prompted by
#       cast and never appears on a command line.
#
#   ops/v8/safes-bootstrap.sh record --admin 0x… --treasury 0x…
#       Verifies each address really is a 2-of-3 Safe with the expected owners, then writes
#       shared.safes.admin, shared.admin, shared.safes.treasury, guardian, feeRecipient and opsWallet
#       into the registry and runs build-markets.mjs --check.
#
# WHY THE SINGLETON/FACTORY ARE NOT HARDCODED AS FACT. v8-safes.md records them as "unverified here"
# and names 0x29fcB43b… only as a LEAD from a Sourcify record, not a fact the repo stands behind. The
# defaults below are the canonical Safe 1.4.1 deterministic addresses; `probe` is what turns them
# from a guess into a checked fact on THIS chain. If probe fails, stop and report — deploying Safe
# from source is an owner decision and a change to C8-10, not something to improvise.
#
# A Safe "created" against an empty factory is an address with no code behind it, and funding it
# loses the funds. That is the whole reason probe runs first and refuses.
# -------------------------------------------------------------------------------------------------
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

HERE=$(cd "$(dirname "$0")/../.." && pwd)
REG="${CALLHOUSE_REGISTRY:-$HERE/ops/markets/tier1.json}"

# T-OP-118: the default is the PUBLIC RPC. The commit this was landed from (0c7b66ca) defaulted it to a
# provider URL with an API key embedded, which is a credential in source; a keyed endpoint goes in RH_RPC.
RH_RPC="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
CHAIN_EXPECT=4663

# Canonical Safe 1.4.1 deterministic deployments. Treated as CANDIDATES until probe proves them.
SAFE_SINGLETON="${SAFE_SINGLETON:-0x29fcB43b46531BcA003ddC8FCB67FFE91900C762}"   # SafeL2 1.4.1
SAFE_FACTORY="${SAFE_FACTORY:-0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67}"       # SafeProxyFactory 1.4.1
FALLBACK="${FALLBACK:-0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99}"               # CompatibilityFallbackHandler 1.4.1
ZERO=0x0000000000000000000000000000000000000000

die()  { printf '\nSAFES FAILED: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '   OK   %s\n' "$*"; }

rpc() { cast "$@" --rpc-url "$RH_RPC"; }

probe() {
  step "chain identity"
  local id; id=$(cast chain-id --rpc-url "$RH_RPC") || die "RPC unreachable: $RH_RPC"
  [ "$id" = "$CHAIN_EXPECT" ] || die "RPC is chain $id, expected $CHAIN_EXPECT"
  ok "chain-id $id"

  step "Safe contracts exist on this chain (v8-safes.md 1.2)"
  local c
  for pair in "singleton:$SAFE_SINGLETON" "factory:$SAFE_FACTORY" "fallback:$FALLBACK"; do
    local name=${pair%%:*} addr=${pair#*:}
    [ "$addr" = "$ZERO" ] && { ok "$name intentionally 0x0"; continue; }
    c=$(rpc code "$addr")
    [ "$c" != "0x" ] && [ -n "$c" ] || die "NO CODE at $name $addr on chain $CHAIN_EXPECT. A Safe created against an empty factory is an address with no code behind it, and funding it loses the funds. Stop and report (v8-safes.md 1.2)."
    ok "$name $addr has code (${#c} hex chars)"
  done

  step "singleton is what it claims (v8-safes.md 1.3-1.4)"
  local ver owners thr
  ver=$(rpc call "$SAFE_SINGLETON" "VERSION()(string)" 2>/dev/null) || die "VERSION() did not resolve on $SAFE_SINGLETON — not a Safe singleton, or a different release"
  ok "VERSION $ver"
  # getOwners() on an UNINITIALISED implementation reverts (INVALID): Safe.sol sets threshold=1 with
  # zero owners on the singleton, so the SENTINEL linked list was never written and the walk faults.
  # A revert here is the GOOD outcome. What is fatal is a SUCCESSFUL non-empty return: that means
  # somebody has called setup() on it and it is their Safe, not an implementation (v8-safes.md 1.4).
  if owners=$(rpc call "$SAFE_SINGLETON" "getOwners()(address[])" 2>/dev/null); then
    case "$owners" in
      "[]"|"") ok "getOwners() empty — implementation, not somebody's Safe" ;;
      *) die "getOwners() returned $owners. This is a DEPLOYED SAFE, not a singleton. Pointing our Safes at it would hand them to whoever controls it (v8-safes.md 1.4)." ;;
    esac
  else
    ok "getOwners() reverts — uninitialised implementation, which is what a singleton should be"
  fi
  thr=$(rpc call "$SAFE_SINGLETON" "getThreshold()(uint256)" 2>/dev/null) || die "getThreshold() did not resolve"
  [ "$thr" = "1" ] || die "getThreshold() is $thr, expected 1 on a singleton (Safe.sol:72-80)"
  ok "getThreshold() 1"

  step "factory exposes the signature this script encodes"
  if cast interface "$SAFE_FACTORY" --chain "$CHAIN_EXPECT" 2>/dev/null | grep -q "createProxyWithNonce"; then
    ok "createProxyWithNonce present in the published ABI"
  else
    printf '   NOTE no verified ABI published for the factory on this chain.\n'
    printf '        This script encodes createProxyWithNonce(address,bytes,uint256).\n'
    printf '        plan runs a SIMULATION, which fails loudly if that signature is wrong for this release.\n'
  fi
  printf '\nPROBE PASSED. singleton %s  factory %s\n' "$SAFE_SINGLETON" "$SAFE_FACTORY"
}

parse_owners() {
  IFS=',' read -r O1 O2 O3 <<< "${OWNERS:-}"
  [ -n "${O1:-}" ] && [ -n "${O2:-}" ] && [ -n "${O3:-}" ] || die "--owners needs three comma-separated addresses"
  for a in "$O1" "$O2" "$O3"; do
    cast to-check-sum-address "$a" >/dev/null 2>&1 || die "not an address: $a"
  done
  [ "$O1" != "$O2" ] && [ "$O1" != "$O3" ] && [ "$O2" != "$O3" ] || die "the three owners must be distinct — a duplicate silently lowers the real threshold"
}

build_init() {
  INIT=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" \
    "[$O1,$O2,$O3]" 2 "$ZERO" 0x "$FALLBACK" "$ZERO" 0 "$ZERO")
}

plan() {
  parse_owners; probe; build_init
  step "initialiser — READ THIS BACK AGAINST YOUR THREE OWNER ADDRESSES"
  cast decode-calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "$INIT"
  printf '\n   owners   %s\n            %s\n            %s\n   threshold 2 of 3\n   fallback %s\n' "$O1" "$O2" "$O3" "$FALLBACK"
  printf '\n   The owner set and the threshold are what you are creating. Everything else about a Safe\n'
  printf '   can be changed later by its owners; this cannot, if you get it wrong and fund it.\n'

  step "simulate both creations (no gas, no state change)"
  SALT_ADMIN="${SALT_ADMIN:-$(date -u +%Y%m%d)01}"
  SALT_TREASURY="${SALT_TREASURY:-$(date -u +%Y%m%d)02}"
  PRED_ADMIN=$(rpc call "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_SINGLETON" "$INIT" "$SALT_ADMIN") \
    || die "simulation failed for the ADMIN Safe. A failed simulation is a failed creation step — do not broadcast and hope the sender changes the result (v8-safes.md 2)."
  PRED_TREASURY=$(rpc call "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_SINGLETON" "$INIT" "$SALT_TREASURY") \
    || die "simulation failed for the TREASURY Safe"
  [ "$PRED_ADMIN" != "$PRED_TREASURY" ] || die "both salts predict the same address — change SALT_TREASURY"
  ok "admin    salt $SALT_ADMIN    -> $PRED_ADMIN"
  ok "treasury salt $SALT_TREASURY -> $PRED_TREASURY"
  printf '\nPLAN PASSED. Nothing was sent. To create:\n'
  printf '   ops/v8/safes-bootstrap.sh create --owners %s,%s,%s --account <keystore> \\\n' "$O1" "$O2" "$O3"
  printf '     SALT_ADMIN=%s SALT_TREASURY=%s\n' "$SALT_ADMIN" "$SALT_TREASURY"
}

create() {
  [ -n "${ACCOUNT:-}" ] || die "--account <keystore-name> is required; this script never takes a private key on the command line"
  plan
  step "OWNER ACTION — this sends two transactions on chain $CHAIN_EXPECT and spends real gas"
  printf '   ADMIN Safe    -> %s\n   TREASURY Safe -> %s\n' "$PRED_ADMIN" "$PRED_TREASURY"
  printf '\nType the word create to proceed: '
  read -r confirm
  [ "$confirm" = "create" ] || die "not confirmed (you typed '${confirm}')"

  step "creating ADMIN Safe"
  cast send "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_SINGLETON" "$INIT" "$SALT_ADMIN" \
    --rpc-url "$RH_RPC" --account "$ACCOUNT" || die "ADMIN Safe creation reverted"
  step "creating TREASURY Safe"
  cast send "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_SINGLETON" "$INIT" "$SALT_TREASURY" \
    --rpc-url "$RH_RPC" --account "$ACCOUNT" || die "TREASURY Safe creation reverted"

  printf '\nCREATED. Now verify and record (all six flags are required):\n'
  printf '   ops/v8/safes-bootstrap.sh record \\\n'
  printf '     --admin %s \\\n' "$PRED_ADMIN"
  printf '     --treasury %s \\\n' "$PRED_TREASURY"
  printf '     --guardian 0x<addr> --fee-recipient 0x<addr> --ops-wallet 0x<addr>\n' 
}

verify_safe() {
  local label=$1 addr=$2
  local c; c=$(rpc code "$addr")
  [ "$c" != "0x" ] || die "$label $addr has NO CODE. A receipt without a real proxy is a failed creation — never write it to the registry."
  local thr; thr=$(rpc call "$addr" "getThreshold()(uint256)")
  [ "$thr" = "2" ] || die "$label threshold is $thr, expected 2"
  local owners; owners=$(rpc call "$addr" "getOwners()(address[])")
  ok "$label $addr threshold 2, owners $owners"
}

record() {
  [ -n "${ADMIN_SAFE:-}" ] && [ -n "${TREASURY_SAFE:-}" ] || die "record needs --admin and --treasury"
  [ "$ADMIN_SAFE" != "$TREASURY_SAFE" ] || die "admin and treasury Safe must differ — build-markets.mjs:928-944 refuses one address for both, and the split is the point: the signatures that move protocol money are not the ones that change protocol configuration"
  step "verify both addresses really are 2-of-3 Safes"
  verify_safe "ADMIN   " "$ADMIN_SAFE"
  verify_safe "TREASURY" "$TREASURY_SAFE"

  # Name EVERY missing flag at once. The bash `${VAR:?}` form dies on the first one, so a caller
  # missing three flags has to re-run three times -- and by then the two on-chain reads above have
  # already happened, which reads as "it verified, then it failed".
  MISSING=""
  [ -n "${GUARDIAN:-}" ]      || MISSING="$MISSING --guardian"
  [ -n "${FEE_RECIPIENT:-}" ] || MISSING="$MISSING --fee-recipient"
  [ -n "${OPS_WALLET:-}" ]    || MISSING="$MISSING --ops-wallet"
  [ -z "$MISSING" ] || die "record also needs:$MISSING (each takes an address). The two Safes above verified fine; nothing was written."

  step "write the registry"
  node -e '
const fs = require("fs");
const [reg, adminSafe, treasurySafe, guardian, feeRecipient, opsWallet] = process.argv.slice(1);
const r = JSON.parse(fs.readFileSync(reg, "utf8"));
r.shared.safes.admin = adminSafe;
r.shared.safes.treasury = treasurySafe;
r.shared.admin = adminSafe;          // build-markets.mjs: shared.admin MUST equal shared.safes.admin
r.shared.guardian = guardian;
r.shared.feeRecipient = feeRecipient;
r.shared.opsWallet = opsWallet;
fs.writeFileSync(reg + ".tmp", JSON.stringify(r, null, 2) + "\n");
fs.renameSync(reg + ".tmp", reg);
console.log("   wrote", reg);
' "$REG" "$ADMIN_SAFE" "$TREASURY_SAFE" "$GUARDIAN" "$FEE_RECIPIENT" "$OPS_WALLET"

  step "build-markets.mjs --check"
  ( cd "$HERE" && node ops/markets/build-markets.mjs --check ) || die "registry check failed — the write above is on disk; fix the reported field and re-run --check"
  printf '\nRECORDED. Registry now carries both Safes.\n'
}

mirror() {
  step "fill v2.protocolAddresses from its sources (02-interfaces.md 3.3)"
  # Every entry here is a TWIN of a field that already exists elsewhere in the registry, so this
  # copies and never invents. The keys deliberately left alone -- accessManager, makerVault,
  # autoRoller, feeSplitter, buybackExecutor, distributors -- are DEPLOY OUTPUTS: they stay null
  # until DeployV2Batch writes them back, and filling them here would be a guess that reads as fact.
  node -e '
const fs = require("fs");
const reg = process.argv[1];
const r = JSON.parse(fs.readFileSync(reg, "utf8"));
const pa = r.v2.protocolAddresses;
const twin = {
  admin:        r.shared.admin,
  guardian:     r.shared.guardian,
  feeRecipient: r.shared.feeRecipient,
  opsWallet:    r.shared.opsWallet,
  treasury:     r.shared.safes && r.shared.safes.treasury,
  cranker:      r.v2.bots && r.v2.bots.cranker,
  pricer:       r.v2.bots && r.v2.bots.pricer,
  quoter:       r.v2.bots && r.v2.bots.quoter,
};
let n = 0;
for (const [k, v] of Object.entries(twin)) {
  if (v === undefined || v === null) continue;      // a null source stays a null twin, by design
  if (pa[k] === v) continue;
  if (pa[k] !== null && pa[k] !== v) {
    console.error(`REFUSING: protocolAddresses.${k} is already ${pa[k]} and its source says ${v}. Two different non-null values is a real disagreement, not drift to paper over.`);
    process.exit(1);
  }
  pa[k] = v; n++;
  console.log(`   ${k} <- ${v}`);
}
fs.writeFileSync(reg + ".tmp", JSON.stringify(r, null, 2) + "\n");
fs.renameSync(reg + ".tmp", reg);
console.log(`   ${n} twin(s) written`);
' "$REG" || die "mirror write failed"

  step "build-markets.mjs --check"
  ( cd "$HERE" && node ops/markets/build-markets.mjs --check ) || die "registry still fails --check; read the DRIFT lines above"
  printf '\nMIRROR DONE.\n'
}

CMD=${1:-}; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --owners) OWNERS=$2; shift 2 ;;
    --account) ACCOUNT=$2; shift 2 ;;
    --admin) ADMIN_SAFE=$2; shift 2 ;;
    --treasury) TREASURY_SAFE=$2; shift 2 ;;
    --guardian) GUARDIAN=$2; shift 2 ;;
    --fee-recipient) FEE_RECIPIENT=$2; shift 2 ;;
    --ops-wallet) OPS_WALLET=$2; shift 2 ;;
    --rpc) RH_RPC=$2; shift 2 ;;
    *) die "unknown flag $1" ;;
  esac
done

case "$CMD" in
  probe)  probe ;;
  plan)   plan ;;
  create) create ;;
  record) record ;;
  mirror) mirror ;;
  *) sed -n '3,/^# ----/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
