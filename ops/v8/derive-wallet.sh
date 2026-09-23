#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v8/derive-wallet.sh — one labelled EOA from the ops mnemonic, at a fixed index.
#
#   ops/v8/derive-wallet.sh fee-recipient 73
#   ops/v8/derive-wallet.sh ops-wallet    74
#
# WHY THIS EXISTS. build-markets.mjs:1355-1367 requires every v2.protocolAddresses value to be
# pairwise DISTINCT -- the only pair allowed to name one address is feeRecipient = feeSplitter. The
# two Safes, the guardian hot key and the ops wallet are separate on purpose, so a launch needs a
# real address for each rather than one placeholder reused.
#
# INDEX ALLOCATION on this phrase, so nothing collides:
#   73+ these labelled wallets.
#
# Key handling mirrors ops/v2/derive-bot-keys.sh exactly: the phrase goes to a mode-600 tempfile
# removed on exit and is never an argv; the key is written to ~/.callhouse-keys/v8/<label>.env
# (mode 600) and is NEVER printed; re-running refuses to overwrite a file holding a different key.
# Only the address is echoed.
# -------------------------------------------------------------------------------------------------
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

LABEL="${1:-}"; INDEX="${2:-}"
[ -n "$LABEL" ] && [ -n "$INDEX" ] || { echo "usage: ops/v8/derive-wallet.sh <label> <index>" >&2; exit 2; }
case "$INDEX" in (*[!0-9]*|'') echo "index must be a number" >&2; exit 2 ;; esac
# NORMALISE BEFORE ANY COMPARISON. T-LP-08 P2: the allocated-index refusal below is a string `case`,
# so `060` did not match `60` and sailed past it -- the operator reproduced it and the run derived
# 0xc992...5d47, the CRANKER key, into a file under a different label. That breaks the one-key-per-
# process invariant this whole allocation exists to keep.
# `10#` is load-bearing: bare $((INDEX)) reads a leading zero as OCTAL, so 060 would become 48 and
# silently derive the wrong index instead of the right one. Wrong-but-plausible is worse than refused.
INDEX=$((10#$INDEX))

WALLET_FILE="${CALLHOUSE_WALLET_FILE:-$HOME/.callhouse-keys/callhouse-hot-wallet.txt}"
OUT_DIR="${CALLHOUSE_V2_KEYS_DIR:-$HOME/.callhouse-keys/v8}"
VAR="$(printf '%s' "$LABEL" | tr '[:lower:]-' '[:upper:]_')_PK"

die() { printf '\nDERIVE FAILED: %s\n' "$*" >&2; exit 1; }

[ -f "$WALLET_FILE" ] || die "no wallet file at $WALLET_FILE"
command -v cast >/dev/null || die "cast not found"

# Refuse an index this repo already spends elsewhere.
case "$INDEX" in
  0|1|2|50|51|52|60|61|62|63|70|71|72) die "index $INDEX is already allocated (see the header). Pick a free one." ;;
esac
if [ "$INDEX" -ge 10 ] && [ "$INDEX" -le 43 ]; then die "index $INDEX is a v1 market keeper (10-43)"; fi

MNEMONIC="$(awk 'found { print; exit } /^Phrase:?[[:space:]]*$/ { found = 1 }' "$WALLET_FILE")"
WORDS=$(printf '%s' "$MNEMONIC" | wc -w | tr -d ' ')
[ "$WORDS" = "24" ] || die "expected a 24-word phrase after the Phrase line, got $WORDS"
umask 077
MNEMONIC_FILE="$(mktemp)"
trap 'rm -f "$MNEMONIC_FILE"' EXIT
printf '%s\n' "$MNEMONIC" > "$MNEMONIC_FILE"
unset MNEMONIC

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
ADDRESS="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$INDEX")"
KEY_FILE="$OUT_DIR/$LABEL.env"
DERIVED="$(cast wallet private-key --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$INDEX")"
if [ -f "$KEY_FILE" ]; then
  grep -qx "$VAR=$DERIVED" "$KEY_FILE" \
    || die "$KEY_FILE exists and does NOT hold the key index $INDEX derives to. Refusing to overwrite."
fi
# T-LP-08 P3: the guard above keys on the LABEL, so it never noticed a SECOND label pointed at an
# index some other label already holds -- two files, two names, one key. Check the index too.
for other in "$OUT_DIR"/*.env; do
  [ -e "$other" ] || continue
  [ "$other" = "$KEY_FILE" ] && continue
  if grep -qx "[A-Z0-9_]*=$DERIVED" "$other" 2>/dev/null; then
    die "index $INDEX already lives in $other under another label. One key per process: a second name for the same key defeats the allocation."
  fi
done
if [ -f "$KEY_FILE" ]; then
  :
else
  printf '%s=%s\n' "$VAR" "$DERIVED" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi
unset DERIVED
printf '%s index %s  %s  -> %s\n' "$LABEL" "$INDEX" "$ADDRESS" "$KEY_FILE"
