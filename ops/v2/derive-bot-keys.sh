#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v2/derive-bot-keys.sh — the four v8 bot hot keys, derived from the ops mnemonic.
#
# WHY ONE KEY EACH: one key per process. Two bots on one key race on the nonce (ops/deploy.md §10
# "exactly one instance" is per key), and each key carries a different power, so a leak of one is
# a different incident (ops/deploy.md §15.6). Under v8 every power is a role on the AccessManager,
# and OPS_ADMIN (the Admin Safe) can revoke and re-grant any of them with no delay, so a leaked hot
# key is rotated in one 2-of-3 transaction (V8-DESIGN §2.2):
#   cranker   index 60  CRANKER_PK    BUYBACK on the FeeSplitter. Every lifecycle call it makes is
#                                     permissionless; it holds gas and earns capped bounties. In v7
#                                     this key held no role at all — buyback(minTokenOut) is new.
#   pricer    index 61  PRICER_PK     PRICER: AutoRoller.reprice.
#   quoter    index 62  MM_QUOTER_PK  QUOTER: the ten MakerVault quoter functions, cannot withdraw.
#                                     Called mmQuoter in v7; the role is on the manager now.
#   guardian  index 63  GUARDIAN_PK   GUARDIAN: pause, veto, clearRoute, and cancelling any scheduled
#                                     fee / config / treasury / listing operation. No delay, by design.
#
# V8 KEYS ARE NEW KEYS (06-QUIRKS §G). Indices 50-52 are v7's cranker, pricer and mmQuoter and are
# NOT reused: v7 runs off beside v8, both sets are live at once, and a shared key would mean a v7
# incident is also a v8 incident. A dev stack never uses these either — ops/markets/dev.json runs on
# anvil's public dev accounts.
#
# DERIVATION: BIP-44 m/44'/60'/0'/0/<index> from the 24-word phrase in ~/.callhouse-keys/
# callhouse-hot-wallet.txt (the "Phrase" line), exactly as ops/markets/derive-keeper-keys.sh.
# Indices: 0 admin/deployer, 1 the NVDA keeper, 2 the v1 guardian, 10–43 the v1 market keepers
# (tier1.json deployment.keeperKeyIndex), 50–52 the v7 bots, 60–63 these. Fixed here, not allocated.
# CHANGE THEM ONLY BEFORE THE FIRST DERIVATION: after that the addresses are in the registry, funded
# and role-granted, and this script refuses to re-point a derived bot.
#
# OUTPUT: ~/.callhouse-keys/v8/<bot>.env (mode 600, directory 700) holding one line
# `<VAR>=0x…`, and the ADDRESS in ops/markets/tier1.json `v2.bots.<bot>` (EIP-55). Nothing secret
# is ever printed or passed as an argument; the script echoes addresses only.
# v8, NOT ~/.callhouse-keys/v2/: v7 derived indices 50-52 into v2/cranker.env and v2/pricer.env, and
# this script refuses to overwrite a key file, so a v8 derivation into that directory dies on any
# machine that ran v7, and the file there still holds the v7 key. v7's files stay where they are.
#
# RE-RUN: idempotent. An existing key file must hold the key its index derives to, and a non-null
# registry address must be that key's address; either mismatch refuses, never overwrites (a
# re-pointed bot address would fund or grant a role to the wrong key).
#
#   ops/v2/derive-bot-keys.sh                    # all four
#   ops/v2/derive-bot-keys.sh cranker pricer     # only these
#
# Then: node ops/markets/build-markets.mjs --check, commit the registry, fund the addresses
# (ops/deploy.md §15.6). Needs `cast` and `node`. Never commit anything under ~/.callhouse-keys.
# Overrides (rehearsals with a throwaway phrase): CALLHOUSE_WALLET_FILE, CALLHOUSE_V2_KEYS_DIR,
# CALLHOUSE_REGISTRY. Bash 3.2 compatible (macOS default).
# -------------------------------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${CALLHOUSE_REGISTRY:-$HERE/../markets/tier1.json}"
WALLET_FILE="${CALLHOUSE_WALLET_FILE:-$HOME/.callhouse-keys/callhouse-hot-wallet.txt}"
OUT_DIR="${CALLHOUSE_V2_KEYS_DIR:-$HOME/.callhouse-keys/v8}"

# T-LP-08 CHECKED THIS FILE, 2026-09-21, and the sibling's index defect does NOT apply here.
# `ops/v8/derive-wallet.sh` takes an index as an ARGUMENT and gates it on a `case` list of string
# literals, so a leading zero walks past the guard: `060` is refused by nothing and derives the same
# key as `60` (P2 in that row; fix is `INDEX=$((10#$INDEX))`, and NOT bare `$((INDEX))`, which reads
# a leading zero as OCTAL and would turn `060` into index 48).
# None of that reaches this script: every index below is a LITERAL in the table, read by
# `while read -r BOT INDEX VAR`, never supplied by a caller. There is no refusal list to bypass
# because there is nothing to refuse. Keep it that way -- the moment this file takes an index from
# an argument or the environment, it inherits the sibling's problem and needs the same `10#`.
#
# Also checked and holding: the key file at the bottom is mode 600 because `umask 077` is set BEFORE
# the write, not because of the `chmod 600` that follows it. The chmod is belt to that umask's
# braces; move or drop the umask and there is a real window between create and chmod.
#
# bot  index  variable
BOTS="cranker 60 CRANKER_PK
pricer 61 PRICER_PK
quoter 62 MM_QUOTER_PK
guardian 63 GUARDIAN_PK"

die() { echo "REFUSED: $*" >&2; exit 1; }

WANT="$*"
for w in $WANT; do
  printf '%s\n' "$BOTS" | awk '{print $1}' | grep -qx "$w" || die "unknown bot '$w' (cranker, pricer, quoter, guardian)"
done

command -v cast >/dev/null || die "cast not on PATH (export PATH=\"\$HOME/.foundry/bin:\$PATH\")"
command -v node >/dev/null || die "node not on PATH"
[ -f "$WALLET_FILE" ] || die "wallet file not found: $WALLET_FILE"
[ -f "$REGISTRY" ] || die "registry not found: $REGISTRY"

# json_get 'expr': one value out of the registry (r), via node. Registry path through the
# environment, never interpolated into the program.
json_get() { REG="$REGISTRY" node -e "const r=JSON.parse(require('fs').readFileSync(process.env.REG,'utf8'));const v=($1);process.stdout.write(v==null?'':String(v))"; }

[ -n "$(json_get 'r.v2 && typeof r.v2.bots === "object" && r.v2.bots !== null ? "yes" : ""')" ] \
  || die "$REGISTRY has no v2.bots block; add {\"cranker\": null, \"pricer\": null, \"quoter\": null, \"guardian\": null} to the top-level v2 block (ops/markets/README.md \"v2 blocks\")"

# The 24 words follow the "Phrase" line. Held in a variable, never echoed, never an argv (argv is
# visible in `ps`); cast reads it from a temporary file with mode 600, removed on exit.
MNEMONIC="$(awk 'found { print; exit } /^Phrase:?[[:space:]]*$/ { found = 1 }' "$WALLET_FILE")"
WORDS=$(printf '%s' "$MNEMONIC" | wc -w | tr -d ' ')
[ "$WORDS" = "24" ] || die "expected a 24-word phrase after the Phrase line, got $WORDS words"
umask 077
MNEMONIC_FILE="$(mktemp)"
trap 'rm -f "$MNEMONIC_FILE"' EXIT
printf '%s\n' "$MNEMONIC" > "$MNEMONIC_FILE"
unset MNEMONIC

# Sanity: index 0 must be the deployer EOA, or this is the wrong phrase.
#
# WHY THIS IS NOT SIMPLY `shared.admin` ANY MORE. Under v7 `shared.admin` WAS the deployer EOA, so
# comparing it to index 0 was a real wrong-wallet-file check. INTERFACE_VERSION 8 makes `shared.admin`
# the ADMIN SAFE -- build-markets.mjs:998-999 REQUIRES `shared.safes.admin === shared.admin`, and its
# comment at :996-997 says "One Safe under two names is how admin stops meaning the Safe". A contract
# address can never equal index 0 of a mnemonic, so on a correctly configured v8 registry that check
# could NEVER pass and the four v8 bot keys could never be derived -- while blaming the operator's
# wallet file, which was perfectly correct. Nobody hit it because nobody had run the v8 launch path.
#
# THE ANCHOR. The registry names no deployer: `shared` carries chainId, usdg, clearinghouse, seaport,
# multicall3, admin, guardian, feeRecipient, opsWallet, safes{admin,treasury} and token{...}, and no
# owners list. Reading the Safe's owners on chain is not an option -- this script is deliberately
# OFFLINE (cast and node, no RPC), `shared.safes.admin` is null until the owner creates the Safe, and
# even the mnemonic-derived identities here (guardian is index 63) are null until this script has run
# once, so none of them can anchor their own first derivation. That leaves the deployer stated
# explicitly: CALLHOUSE_DEPLOYER.
#
# WHICH BRANCH APPLIES. `shared.admin` is the deployer EOA only when it is set AND differs from
# `shared.safes.admin`; that is the v7 shape and the old check still holds there. Otherwise -- the v8
# shape where the two are the same Safe, OR a registry whose addresses are still null (both are null
# in ops/markets/tier1.json today, and `json_get` renders null as an empty string) -- the registry
# offers no EOA to compare against and the deployer must be named.
EXPECT_ADMIN="$(json_get 'r.shared.admin')"
SAFE_ADMIN="$(json_get 'r.shared.safes && r.shared.safes.admin')"
GOT_ADMIN="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index 0)"
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

if [ -n "$EXPECT_ADMIN" ] && [ "$(lower "$EXPECT_ADMIN")" != "$(lower "$SAFE_ADMIN")" ]; then
  # v7 shape: shared.admin is the deployer EOA itself.
  [ "$(lower "$GOT_ADMIN")" = "$(lower "$EXPECT_ADMIN")" ] \
    || die "index 0 of this phrase is $GOT_ADMIN, not the registry admin $EXPECT_ADMIN; wrong wallet file"
else
  # v8 shape, or a registry not yet filled in. Note what is NOT said here: nothing blames the wallet
  # file, because on this branch the wallet file is very likely correct and the registry simply has no
  # EOA to check it against.
  if [ -n "$EXPECT_ADMIN" ]; then
    WHY="shared.admin $EXPECT_ADMIN is the Admin Safe under v8, not a wallet"
  else
    WHY="shared.admin is not set yet"
  fi
  [ -n "${CALLHOUSE_DEPLOYER:-}" ] \
    || die "this registry names no deployer EOA to check the phrase against ($WHY). Set CALLHOUSE_DEPLOYER=0x... to the address index 0 of your phrase should produce. Your wallet file is not in question."
  [ "$(lower "$GOT_ADMIN")" = "$(lower "$CALLHOUSE_DEPLOYER")" ] \
    || die "index 0 of this phrase is $GOT_ADMIN, but CALLHOUSE_DEPLOYER says $CALLHOUSE_DEPLOYER. One of the two is wrong -- check the variable before you doubt the wallet file"
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

UPDATES=""
while read -r BOT INDEX VAR; do
  [ -n "$BOT" ] || continue
  if [ -n "$WANT" ] && ! printf '%s\n' $WANT | grep -qx "$BOT"; then continue; fi
  KEY_FILE="$OUT_DIR/$BOT.env"
  ADDRESS="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$INDEX")"
  ADDRESS="$(cast to-check-sum-address "$ADDRESS")"

  REG_ADDR="$(json_get "r.v2.bots['$BOT']")"
  if [ -n "$REG_ADDR" ] && [ "$(printf '%s' "$REG_ADDR" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$ADDRESS" | tr '[:upper:]' '[:lower:]')" ]; then
    die "registry v2.bots.$BOT is $REG_ADDR but index $INDEX of this phrase is $ADDRESS; refusing to re-point it (fix the registry by hand if the index really changed)"
  fi

  # The key the index derives to, held in a variable and compared or written, never printed.
  DERIVED="$(cast wallet private-key --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$INDEX")"
  if [ -f "$KEY_FILE" ]; then
    perms=$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || stat -c '%a' "$KEY_FILE")
    [ "$perms" = "600" ] || { DERIVED=""; die "$KEY_FILE is mode $perms, must be 600"; }
    n=$(grep -c "^$VAR=" "$KEY_FILE" || true)
    [ "$n" = "1" ] || { DERIVED=""; die "$KEY_FILE must hold exactly one $VAR line (has $n)"; }
    EXISTING="$(sed -n "s/^$VAR=//p" "$KEY_FILE" | head -1 | tr -d '[:space:]')"
    case "$EXISTING" in 0x*|0X*) ;; *) EXISTING="0x$EXISTING" ;; esac
    if [ "$(printf '%s' "$EXISTING" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$DERIVED" | tr '[:upper:]' '[:lower:]')" ]; then
      EXISTING=""; DERIVED=""
      die "$KEY_FILE holds a key that is not index $INDEX of this phrase; refusing to overwrite"
    fi
    EXISTING=""
    state="kept"
  else
    {
      echo "# Stonkhouse v2 $BOT hot key, BIP-44 index $INDEX of the ops mnemonic. Address $ADDRESS."
      echo "# ops/deploy.md §15.6. Never commit, never paste into a file under the repository. Generated $(date -u +%FT%TZ)."
      printf '%s=%s\n' "$VAR" "$DERIVED"
    } > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    state="written"
  fi
  DERIVED=""
  echo "$BOT  index $INDEX  $VAR  address $ADDRESS  ($state $KEY_FILE)"
  UPDATES="$UPDATES$BOT $ADDRESS
"
done <<< "$BOTS"

[ -n "$UPDATES" ] || die "nothing selected"

# Record the addresses (never the keys) in the registry, atomically. Values arrive through the
# environment; the builder's formatting (2-space JSON, trailing newline) is kept.
REG="$REGISTRY" UPDATES="$UPDATES" node -e '
const fs = require("fs");
const file = process.env.REG;
const r = JSON.parse(fs.readFileSync(file, "utf8"));
let changed = 0;
for (const line of process.env.UPDATES.split("\n").filter(Boolean)) {
  const [bot, addr] = line.split(" ");
  if (r.v2.bots[bot] !== addr) { r.v2.bots[bot] = addr; changed += 1; }
  // INTERFACE_VERSION 8: the guardian is one hot key written in two places (v2.bots.guardian beside
  // the other signers, shared.guardian where every v7-era reader looks). build-markets.mjs --check
  // refuses them different, so they are written together rather than left for a hand edit.
  if (bot === "guardian" && r.shared.guardian !== addr) { r.shared.guardian = addr; changed += 1; }
}
if (changed) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(r, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
}
console.log(changed ? `registry updated: v2.bots / shared.guardian (${changed} value(s))` : "registry already has these addresses");
'
echo "Next: node ops/markets/build-markets.mjs --check; commit ops/markets/tier1.json; fund each address (ops/deploy.md §15.6)."
