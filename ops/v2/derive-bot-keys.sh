#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v2/derive-bot-keys.sh — the three v2 bot hot keys, derived from the ops mnemonic.
#
# WHY THREE KEYS: one key per process. Two bots on one key race on the nonce (ops/deploy.md §10
# "exactly one instance" is per key), and each key carries a different power, so a leak of one is
# a different incident (ops/deploy.md §15.6):
#   cranker   index 50  CRANKER_PK    no role at all: every lifecycle call is permissionless. Holds gas,
#                                     earns capped KeeperRewards bounties.
#   pricer    index 51  PRICER_PK     PRICER_ROLE on AutoRoller (reprices smart-pricing asks).
#   mmQuoter  index 52  MM_QUOTER_PK  QUOTER_ROLE on MakerVault: quotes, cannot withdraw.
#
# DERIVATION: BIP-44 m/44'/60'/0'/0/<index> from the 24-word phrase in ~/.callhouse-keys/
# callhouse-hot-wallet.txt (the "Phrase" line), exactly as ops/markets/derive-keeper-keys.sh.
# Indices: 0 admin/deployer, 1 the NVDA keeper, 2 the guardian, 10–43 the v1 market keepers
# (tier1.json deployment.keeperKeyIndex), 50–52 these. The indices are fixed here, not allocated.
#
# OUTPUT: ~/.callhouse-keys/v2/<bot>.env (mode 600, directory 700) holding one line
# `<VAR>=0x…`, and the ADDRESS in ops/markets/tier1.json `v2.bots.<bot>` (EIP-55). Nothing secret
# is ever printed or passed as an argument; the script echoes addresses only.
#
# RE-RUN: idempotent. An existing key file must hold the key its index derives to, and a non-null
# registry address must be that key's address; either mismatch refuses, never overwrites (a
# re-pointed bot address would fund or grant a role to the wrong key).
#
#   ops/v2/derive-bot-keys.sh                    # all three
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
OUT_DIR="${CALLHOUSE_V2_KEYS_DIR:-$HOME/.callhouse-keys/v2}"

# bot  index  variable
BOTS="cranker 50 CRANKER_PK
pricer 51 PRICER_PK
mmQuoter 52 MM_QUOTER_PK"

die() { echo "REFUSED: $*" >&2; exit 1; }

WANT="$*"
for w in $WANT; do
  printf '%s\n' "$BOTS" | awk '{print $1}' | grep -qx "$w" || die "unknown bot '$w' (cranker, pricer, mmQuoter)"
done

command -v cast >/dev/null || die "cast not on PATH (export PATH=\"\$HOME/.foundry/bin:\$PATH\")"
command -v node >/dev/null || die "node not on PATH"
[ -f "$WALLET_FILE" ] || die "wallet file not found: $WALLET_FILE"
[ -f "$REGISTRY" ] || die "registry not found: $REGISTRY"

# json_get 'expr': one value out of the registry (r), via node. Registry path through the
# environment, never interpolated into the program.
json_get() { REG="$REGISTRY" node -e "const r=JSON.parse(require('fs').readFileSync(process.env.REG,'utf8'));const v=($1);process.stdout.write(v==null?'':String(v))"; }

[ -n "$(json_get 'r.v2 && typeof r.v2.bots === "object" && r.v2.bots !== null ? "yes" : ""')" ] \
  || die "$REGISTRY has no v2.bots block; add {\"cranker\": null, \"pricer\": null, \"mmQuoter\": null} to the top-level v2 block (ops/markets/README.md \"v2 blocks\")"

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

# Sanity: index 0 must be the admin/deployer the registry names, or this is the wrong phrase.
EXPECT_ADMIN="$(json_get 'r.shared.admin')"
GOT_ADMIN="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index 0)"
[ "$(printf '%s' "$GOT_ADMIN" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$EXPECT_ADMIN" | tr '[:upper:]' '[:lower:]')" ] \
  || die "index 0 of this phrase is $GOT_ADMIN, not the registry admin $EXPECT_ADMIN; wrong wallet file"

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
}
if (changed) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(r, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
}
console.log(changed ? `registry updated: v2.bots (${changed} address(es))` : "registry already has these addresses");
'
echo "Next: node ops/markets/build-markets.mjs --check; commit ops/markets/tier1.json; fund each address (ops/deploy.md §15.6)."
