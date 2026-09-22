# Live-set fork (`ops/v2/rehearse.sh --fork-live`)

O3-005. A local anvil fork of Robinhood Chain **4663 at head**, against the **already deployed** 13
`v2.contracts` addresses in `ops/markets/tier1.json`. No fresh `DeployV2Batch`. No real keys.

The older O2-03 path (`ops/v2/rehearse.sh` with no `--fork-live`) still deploys a throwaway set on
the fork, detaches, and runs the story + drills. Use that when you need a clean deploy; use
`--fork-live` when later tasks (O3-105, O3-202, O3-305) need the live contract set.

## What it does

1. `anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --code-size-limit 98304`.
   The fork block is recorded. State is **not** dumped (disk).
2. Reads the 13 live addresses (`v2.contracts` + `v2.contracts.sources`).
3. `anvil_impersonateAccount` + `anvil_setBalance` for the registry admin and guardian, and for
   anvil writer/holder personas (public junk mnemonic indices 3 and 5). Nothing is sent to the
   public RPC except the fork's own reads.
4. `eth_call` of `Clearinghouse.market(NVDA)` on the fork and on the public RPC at that block;
   they must be byte-identical.
5. Boots `--services` (default `cranker,indexer`) against the fork RPC. The cranker signs with
   anvil account #8 (the public `test test … junk` key). `~/.callhouse-keys` is never read.
   Indexer `V2_START_BLOCK` is the **fork block**, not the original deploy block, so this does
   not backfill the whole chain.
6. Writes `FORK-LIVE-REPORT.json` (and a short markdown) under a temp dir, then stops every
   process and deletes that dir unless `--keep`.

## Commands

```bash
# parse + print the 13 addresses; no anvil
ops/v2/rehearse.sh --fork-live --check --services cranker,indexer

# acceptance boot (tears down and deletes the temp dir on exit)
ops/v2/rehearse.sh --fork-live --services cranker,indexer

# leave anvil + services up
ops/v2/rehearse.sh --fork-live --services cranker,indexer --keep
REHEARSE_OUT=<printed temp dir> node ops/v2/rehearse/stop.mjs
```

Optional: `REHEARSE_FORK_BLOCK=<n>` pins the fork (the public RPC must still serve that block).
`REHEARSE_ANVIL_PORT` if 8590 is busy.

## Keys and chain

- Fork-only. Anvil's public mnemonic and impersonation. Never `~/.callhouse-keys`, never
  `--private-key`, never `cast send` to a non-local RPC.
- The live cranker/pricer/mmQuoter **roles** stay on the live bot addresses. Anvil #8 can run
  the cranker process against the fork (most cranker steps are permissionless) but it is not
  the production key and must not be used on the real chain.
- If a service needs a keeper/indexer/web **code** change to run against this fork, stop and
  report; do not patch those trees in this task.

## OQ-01

Informational only: local fork of the shared live set for signing rehearsals, then keyless
dev services. This harness is that local fork. It does not authorize remote deploys, keys,
or funding.
