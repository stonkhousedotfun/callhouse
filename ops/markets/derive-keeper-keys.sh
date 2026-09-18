#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# One keeper hot key per market, derived from the ops mnemonic.
#
# WHY ONE KEY PER MARKET: 34 keeper processes writing in the same Friday window from one key would
# race on the nonce (ops/deploy.md §10 "exactly one instance" is per key, not per market). Each key
# holds gas and KEEPER_ROLE on exactly one factory; it can never move depositor funds.
#
# DERIVATION: BIP-44 m/44'/60'/0'/0/<index> from the 24-word phrase in ~/.callhouse-keys/
# callhouse-hot-wallet.txt (the "Phrase" line). Indices 0–9 are reserved (0 admin/deployer,
# 1 the NVDA keeper, 2 the guardian); markets take the next free index from 10 in registry order,
# recorded in tier1.json `deployment.keeperKeyIndex` so a re-run never reassigns a key.
#
# OUTPUT: ~/.callhouse-keys/markets/<TICKER>.env (mode 600) containing KEEPER_PK=0x…, and the
# keeper ADDRESS written into ops/markets/tier1.json `deployment.keeper`. Nothing secret is ever
# printed; the script echoes addresses only.
#
#   ops/markets/derive-keeper-keys.sh            # every planned market without a keeper
#   ops/markets/derive-keeper-keys.sh TSLA AAPL  # only these
#
# Needs `cast` and `node`. Never commit anything under ~/.callhouse-keys. For a rehearsal with
# a throwaway phrase and registry, set CALLHOUSE_WALLET_FILE, CALLHOUSE_KEYS_DIR and
# CALLHOUSE_REGISTRY. No key is passed in argv or printed.
# -------------------------------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${CALLHOUSE_REGISTRY:-$HERE/tier1.json}"
WALLET_FILE="${CALLHOUSE_WALLET_FILE:-$HOME/.callhouse-keys/callhouse-hot-wallet.txt}"
OUT_DIR="${CALLHOUSE_KEYS_DIR:-$HOME/.callhouse-keys/markets}"
FIRST_INDEX=10

command -v cast >/dev/null || { echo "cast not on PATH (export PATH=\"\$HOME/.foundry/bin:\$PATH\")" >&2; exit 1; }
[ -f "$WALLET_FILE" ] || { echo "wallet file not found: $WALLET_FILE" >&2; exit 1; }
[ -f "$REGISTRY" ] || { echo "registry not found: $REGISTRY" >&2; exit 1; }

# The 24 words follow the "Phrase" line. Held in a variable, never echoed, never passed as an argv
# (argv is visible in `ps`); cast reads it from a temporary file with mode 600.
MNEMONIC="$(awk 'found { print; exit } /^Phrase:?[[:space:]]*$/ { found = 1 }' "$WALLET_FILE")"
WORDS=$(printf '%s' "$MNEMONIC" | wc -w | tr -d ' ')
[ "$WORDS" = "24" ] || { echo "expected a 24-word phrase after the Phrase line, got $WORDS words" >&2; exit 1; }
umask 077
MNEMONIC_FILE="$(mktemp)"
trap 'rm -f "$MNEMONIC_FILE"' EXIT
printf '%s\n' "$MNEMONIC" > "$MNEMONIC_FILE"
unset MNEMONIC

# Sanity: index 0 must be the admin/deployer the registry names.
EXPECT_ADMIN="$(REG="$REGISTRY" node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.REG,"utf8")).shared.admin)')"
GOT_ADMIN="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index 0)"
[ "$(echo "$GOT_ADMIN" | tr '[:upper:]' '[:lower:]')" = "$(echo "$EXPECT_ADMIN" | tr '[:upper:]' '[:lower:]')" ] \
  || { echo "index 0 of this phrase is $GOT_ADMIN, not the registry admin $EXPECT_ADMIN; wrong wallet file" >&2; exit 1; }

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

# Which markets, and the next free index.
WANT="${*:-}"
PLAN="$(REG="$REGISTRY" WANT="$WANT" FIRST_INDEX="$FIRST_INDEX" node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.env.REG, "utf8"));
const want = process.env.WANT.split(/\s+/).filter(Boolean);
const used = new Set(r.markets.map(m => m.deployment.keeperKeyIndex).filter(i => i !== null && i !== undefined));
let next = Number(process.env.FIRST_INDEX);
const rows = [];
for (const m of r.markets) {
  if (want.length && !want.includes(m.ticker)) continue;
  if (m.status === "live" && m.deployment.keeper) continue;
  if (!/^[A-Z0-9.]+$/.test(m.ticker)) throw new Error("invalid registry ticker");
  let idx = m.deployment.keeperKeyIndex;
  if (idx === null || idx === undefined) { while (used.has(next)) next++; idx = next; used.add(idx); }
  rows.push(m.ticker + " " + idx);
}
console.log(rows.join("\n"));
')"

[ -n "$PLAN" ] || { echo "nothing to derive (every selected market already has a keeper)"; exit 0; }

UPDATES=""
while read -r TICKER INDEX; do
  [ -n "$TICKER" ] || continue
  ENV_FILE="$OUT_DIR/$TICKER.env"
  ADDRESS="$(cast wallet address --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$INDEX")"
  DERIVED="$(cast wallet private-key --mnemonic-path "$MNEMONIC_FILE" --mnemonic-index "$INDEX")"
  if [ -f "$ENV_FILE" ]; then
    # Re-run: compare the key bytes in shell variables. Passing it to cast would expose it in ps.
    perms=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")
    [ "$perms" = 600 ] || { DERIVED=""; echo "$ENV_FILE is mode $perms, must be 600" >&2; exit 1; }
    n=$(grep -c '^KEEPER_PK=' "$ENV_FILE" || true)
    [ "$n" = 1 ] || { DERIVED=""; echo "$ENV_FILE must hold exactly one KEEPER_PK line" >&2; exit 1; }
    EXISTING="$(sed -n 's/^KEEPER_PK=//p' "$ENV_FILE" | head -1 | tr -d '[:space:]')"
    [ "$(printf '%s' "${EXISTING#0x}" | tr '[:upper:]' '[:lower:]')" = \
      "$(printf '%s' "${DERIVED#0x}" | tr '[:upper:]' '[:lower:]')" ] \
      || { EXISTING=""; DERIVED=""; echo "$ENV_FILE holds a key that is not index $INDEX of this phrase; refusing to overwrite" >&2; exit 1; }
    EXISTING=""
  else
    {
      echo "# Stonkhouse keeper hot key for $TICKER, BIP-44 index $INDEX of the ops mnemonic. Address $ADDRESS."
      echo "# Holds gas and KEEPER_ROLE on the $TICKER factory only. Never commit. Generated $(date -u +%FT%TZ)."
      printf 'KEEPER_PK=%s\n' "$DERIVED"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  DERIVED=""
  echo "$TICKER  index $INDEX  keeper $ADDRESS  -> $ENV_FILE"
  UPDATES="$UPDATES$TICKER $INDEX $ADDRESS
"
done <<< "$PLAN"

# Record the addresses (never the keys) in the registry. Treat paths and updates as data,
# never splice them into JavaScript source.
REG="$REGISTRY" UPDATES="$UPDATES" node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.env.REG, "utf8"));
for (const line of process.env.UPDATES.split("\n").filter(Boolean)) {
  const [ticker, idx, addr] = line.split(" ");
  const m = r.markets.find(x => x.ticker === ticker);
  m.deployment.keeper = addr;
  m.deployment.keeperKeyIndex = Number(idx);
}
fs.writeFileSync(process.env.REG, JSON.stringify(r, null, 2) + "\n");
console.log("registry updated: deployment.keeper / keeperKeyIndex");
'
