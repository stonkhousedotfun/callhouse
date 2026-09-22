#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/v8/import-deployer.sh — put the deployer key (mnemonic index 0) into a cast keystore.
#
#   ops/v8/import-deployer.sh [account-name]      # default: ops
#
# WHY. `cast send --account <name>` prompts for a keystore password and never takes a private key on
# a command line, where it would be visible in `ps` and in shell history. That is the only send path
# ops/v8/safes-bootstrap.sh will use. This is the one-time step that creates that keystore.
#
# The phrase is read from the "Phrase" line of ~/.callhouse-keys/callhouse-hot-wallet.txt into a
# mode-600 tempfile removed on exit, exactly as ops/v2/derive-bot-keys.sh does, and is never an argv.
# cast prompts you for a NEW password to encrypt the keystore; that password is not stored anywhere
# and is not recoverable, so put it in your password manager before you continue.
#
# Index 0 is the deployer/admin of this phrase. It is not a Safe owner and holds no v8 role; it only
# pays gas to create the proxies. The Safe does not care which key created it.
# -------------------------------------------------------------------------------------------------
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

ACCOUNT="${1:-ops}"
WALLET_FILE="${CALLHOUSE_WALLET_FILE:-$HOME/.callhouse-keys/callhouse-hot-wallet.txt}"

die() { printf '\nIMPORT FAILED: %s\n' "$*" >&2; exit 1; }

[ -f "$WALLET_FILE" ] || die "no wallet file at $WALLET_FILE"
command -v cast >/dev/null || die "cast not found; install foundry"

if cast wallet list 2>/dev/null | grep -q "^$ACCOUNT"; then
  printf 'keystore "%s" already exists:\n' "$ACCOUNT"
  cast wallet list | grep "^$ACCOUNT"
  printf '\nNothing to do. If it holds the wrong key, remove it from ~/.foundry/keystores deliberately.\n'
  exit 0
fi

MNEMONIC="$(awk 'found { print; exit } /^Phrase:?[[:space:]]*$/ { found = 1 }' "$WALLET_FILE")"
WORDS=$(printf '%s' "$MNEMONIC" | wc -w | tr -d ' ')
[ "$WORDS" = "24" ] || die "expected a 24-word phrase after the Phrase line, got $WORDS"
umask 077
MNEMONIC_FILE="$(mktemp)"
trap 'rm -f "$MNEMONIC_FILE"' EXIT
printf '%s\n' "$MNEMONIC" > "$MNEMONIC_FILE"
unset MNEMONIC

EXPECT="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index 0)"
printf 'importing deployer %s as keystore "%s"\n' "$EXPECT" "$ACCOUNT"
printf 'cast will now ask you to set a NEW password for this keystore.\n\n'

cast wallet import "$ACCOUNT" \
  --mnemonic "$MNEMONIC_FILE" \
  --mnemonic-derivation-path "m/44'/60'/0'/0/0" \
  || die "cast wallet import failed"

GOT="$(cast wallet address --account "$ACCOUNT" 2>/dev/null || true)"
if [ -n "$GOT" ]; then
  [ "$(printf '%s' "$GOT" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$EXPECT" | tr 'A-Z' 'a-z')" ] \
    || die "keystore holds $GOT, expected $EXPECT"
  printf '\nOK. keystore "%s" = %s\n' "$ACCOUNT" "$GOT"
else
  printf '\nImported. Verify with: cast wallet address --account %s\n' "$ACCOUNT"
fi
