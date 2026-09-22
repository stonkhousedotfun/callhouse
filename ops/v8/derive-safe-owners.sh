#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v8/derive-safe-owners.sh — the three Safe owner keys, derived from the ops mnemonic.
#
#   ops/v8/derive-safe-owners.sh            # derive/print the three owner addresses
#   ops/v8/derive-safe-owners.sh --csv      # print just A,B,C for --owners
#
# INDICES 70, 71, 72. Fixed here, not allocated. Everything already in use on this phrase:
#   0 admin/deployer, 1 v1 keeper, 2 v1 guardian, 10-43 v1 market keepers, 50-52 v7 bots,
#   60-63 v8 bots (ops/v2/derive-bot-keys.sh). 70-72 are free and stay free for this purpose.
#
# OWNER DECISION, 2026-09-21: all three Safe owners come from THIS ONE PHRASE, on this one machine.
# ops/runbooks/v8-safes.md asks for three keys on three separate devices, and this is not that: one
# seed reconstructs all three signatures, so the 2-of-3 is a shape rather than a control. Recorded
# here because a later reader will otherwise assume the runbook was followed. The Safe owner set can
# be changed later by the Safe itself (swapOwner, 2-of-3), so this is reversible without redeploying.
#
# Derivation, key handling and the refuse-rather-than-overwrite rule mirror
# ops/v2/derive-bot-keys.sh exactly: BIP-44 m/44'/60'/0'/0/<index>, the phrase read from the "Phrase"
# line of ~/.callhouse-keys/callhouse-hot-wallet.txt into a mode-600 tempfile removed on exit, never
# an argv (argv is visible in `ps`). Keys are written to ~/.callhouse-keys/v8/safe-owners/<n>.env
# (mode 600) and are NEVER printed. Only addresses are echoed.
#
# Overrides for a rehearsal with a throwaway phrase: CALLHOUSE_WALLET_FILE, CALLHOUSE_SAFE_KEYS_DIR.
# -------------------------------------------------------------------------------------------------
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

WALLET_FILE="${CALLHOUSE_WALLET_FILE:-$HOME/.callhouse-keys/callhouse-hot-wallet.txt}"
OUT_DIR="${CALLHOUSE_SAFE_KEYS_DIR:-$HOME/.callhouse-keys/v8/safe-owners}"
INDICES="70 71 72"
CSV_ONLY=0
[ "${1:-}" = "--csv" ] && CSV_ONLY=1

die() { printf '\nSAFE OWNERS FAILED: %s\n' "$*" >&2; exit 1; }

[ -f "$WALLET_FILE" ] || die "no wallet file at $WALLET_FILE"
command -v cast >/dev/null || die "cast not found; install foundry"

MNEMONIC="$(awk 'found { print; exit } /^Phrase:?[[:space:]]*$/ { found = 1 }' "$WALLET_FILE")"
WORDS=$(printf '%s' "$MNEMONIC" | wc -w | tr -d ' ')
[ "$WORDS" = "24" ] || die "expected a 24-word phrase after the Phrase line, got $WORDS"
umask 077
MNEMONIC_FILE="$(mktemp)"
trap 'rm -f "$MNEMONIC_FILE"' EXIT
printf '%s\n' "$MNEMONIC" > "$MNEMONIC_FILE"
unset MNEMONIC

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"

ADDRS=""
for i in $INDICES; do
  ADDRESS="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$i")"
  KEY_FILE="$OUT_DIR/owner-$i.env"
  # Held in a variable and compared or written, never printed.
  DERIVED="$(cast wallet private-key --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$i")"
  if [ -f "$KEY_FILE" ]; then
    grep -qx "SAFE_OWNER_${i}_PK=$DERIVED" "$KEY_FILE" \
      || die "$KEY_FILE exists and does NOT hold the key index $i derives to. Refusing to overwrite: a re-pointed owner would put a Safe in the wrong hands. Move the old file aside deliberately if this is intended."
  else
    printf 'SAFE_OWNER_%s_PK=%s\n' "$i" "$DERIVED" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
  fi
  unset DERIVED
  ADDRS="${ADDRS:+$ADDRS,}$ADDRESS"
  [ "$CSV_ONLY" = 1 ] || printf '  index %-3s %s   -> %s\n' "$i" "$ADDRESS" "$KEY_FILE"
done

if [ "$CSV_ONLY" = 1 ]; then
  printf '%s\n' "$ADDRS"
else
  printf '\nTHREE SAFE OWNERS (2-of-3 on both Safes):\n  %s\n' "$ADDRS"
  printf '\nNext:\n  ./ops/v8/safes-bootstrap.sh plan --owners %s\n' "$ADDRS"
fi
