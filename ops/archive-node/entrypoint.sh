#!/bin/sh
# ops/archive-node/entrypoint.sh — start Nitro as a chain-4663 ARCHIVE node.
#
# Everything that is not a secret lives in nitro.json. The two L1 endpoints are secrets (keyed
# provider URLs) and arrive only as environment variables; they are passed as flags and never echoed.
#
# Required:  PARENT_CHAIN_RPC_URL        Ethereum mainnet execution RPC (the chain posts to L1)
#            PARENT_CHAIN_BEACON_URL     Ethereum mainnet beacon API (blob data; normally :3500 or a provider)
# First run: SNAPSHOT_URL                an Archive-path snapshot DIRECTORY with a trailing slash, e.g.
#                                        https://robinhood-snapshots.offchainlabs.com/robinhood%20chain/2026-09-06-a346dc6c/
#                                        Only read while /data holds no database. Unset = sync from genesis
#                                        (weeks) — refused unless ALLOW_GENESIS_SYNC=1.
# Optional:  EXTRA_NITRO_ARGS            appended verbatim (e.g. --execution.caching.trie-clean-cache=16384)
# Test seams (entrypoint.test.mjs; never set in production): ARCHIVE_ROOT, DATA_DIR, NITRO_BIN.
set -eu

ROOT="${ARCHIVE_ROOT:-/opt/archive-node}"
DATA="${DATA_DIR:-/data}"
NITRO="${NITRO_BIN:-/usr/local/bin/nitro}"

die() { echo "archive-node: $*" >&2; exit 2; }

[ -n "${PARENT_CHAIN_RPC_URL:-}" ] || die "PARENT_CHAIN_RPC_URL is required (Ethereum L1 execution RPC)"
[ -n "${PARENT_CHAIN_BEACON_URL:-}" ] || die "PARENT_CHAIN_BEACON_URL is required (Ethereum L1 beacon API, for blobs)"

# The chain files are baked into the image; refuse to start on a tampered or truncated copy.
( cd "$ROOT/chain" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) || die "chain config checksum mismatch"

[ -d "$DATA" ] && [ -w "$DATA" ] || die "$DATA is not a writable volume (mount the volume at /data; see RUNBOOK.md §1)"

set -- --conf.file="$ROOT/nitro.json" \
  --parent-chain.connection.url="$PARENT_CHAIN_RPC_URL" \
  --parent-chain.blob-client.beacon-url="$PARENT_CHAIN_BEACON_URL"

# Nitro keeps its database under <global-config>/<chain name>/nitro. Any l2chaindata there means an
# initialised node: never pass an init source again (Nitro would ignore it, but say so plainly).
if [ -z "$(find "$DATA" -maxdepth 3 -type d -name l2chaindata 2>/dev/null | head -n 1)" ]; then
  if [ -n "${SNAPSHOT_URL:-}" ]; then
    case "$SNAPSHOT_URL" in
      */) ;;
      *) die "SNAPSHOT_URL must end in / so Nitro reads the directory's .manifest.txt (multi-part snapshot)" ;;
    esac
    mkdir -p "$DATA/snapshot-download"
    echo "archive-node: empty database, initialising from snapshot $(echo "$SNAPSHOT_URL" | sed -E 's#^(https?://[^/]+).*#\1#')/..."
    set -- "$@" --init.url="$SNAPSHOT_URL"
  elif [ "${ALLOW_GENESIS_SYNC:-0}" = "1" ]; then
    echo "archive-node: empty database, ALLOW_GENESIS_SYNC=1: syncing from genesis"
  else
    die "empty database and no SNAPSHOT_URL; set one (RUNBOOK.md §2) or ALLOW_GENESIS_SYNC=1"
  fi
else
  echo "archive-node: existing database found, resuming"
fi

# shellcheck disable=SC2086 # EXTRA_NITRO_ARGS is deliberately word-split
exec "$NITRO" "$@" ${EXTRA_NITRO_ARGS:-}
