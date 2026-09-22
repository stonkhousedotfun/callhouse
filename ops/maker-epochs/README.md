# Maker epoch files

Published Merkle claim files for the F2 maker RewardsDistributor (`v2.contracts.rewardsDistributor`).
The web image copies `ops/maker-epochs/*.json` into `web/public/maker-epochs/` (W3-202). The indexer
serves unclaimed rows from a file only when that file's `root` equals the on-chain `RootSet` root
(`02-interfaces.md` §1.9 / § `/v2/rewards/:address/claims`).

This directory is empty at launch. An empty directory is a valid state: there is no epoch file, so
nothing is offered for claim. Do not invent a placeholder JSON.

## Files

| Name | What it is |
|---|---|
| `<n>.json` | Published claim file for epoch `n`. **This is what `check.mjs` verifies.** |
| `<n>.scores.json` | Closed-epoch snapshot (X3-204). Ignored by `check.mjs` (not a claim file). |
| `README.md`, `check.mjs` | this document and the gate |

`<n>` is the maker-scoring epoch id: whole weeks since Monday 1970-01-05 00:00Z,
`floor((t − 345600) / 604800)`. 2026-09-14 → 2958.

## Claim-file shape

OpenZeppelin `StandardMerkleTree.of(values, ["uint256","uint256","address","uint256"])` with default
leaf sorting. Amounts are USDG base-unit decimal strings.

```json
{
  "epoch": 2958,
  "root": "0x…64 hex…",
  "total": "1750001",
  "posted": false,
  "entries": [
    { "index": 0, "account": "0x…", "amount": "700000", "proof": ["0x…", "0x…"] }
  ]
}
```

`posted` is required and is a distinct state, not a missing field:

| `posted` | Meaning | `check.mjs` |
|---|---|---|
| `false` | **Unposted.** The file is a draft, a fixture, or not yet `setRoot`. This is not a failure. | Local Merkle verify only. |
| `true` | Posted. `setRoot` has been mined for this epoch. | Local Merkle verify **and** `root(epoch)` on chain equals `file.root`. |
| absent | Invalid. Unposted must be explicit. | Fail. |

Optional keys the claim UI ignores today: `meta`, `carry` (F5). Extra keys such as `tampered` (the
C2-11 fixture's negative vector) are refused in this directory — keep that fixture under
`indexer/src/v2/fixtures/`.

## Gate

```bash
node ops/maker-epochs/check.mjs
# empty dir: "no epoch files; ok", exit 0
# every <n>.json verifies; unposted files do not need RPC

RH_RPC=https://rpc.mainnet.chain.robinhood.com node ops/maker-epochs/check.mjs
# posted:true files also compared to RewardsDistributor.root(epoch)
```

`--dir` points at another directory (tests). `--offline` refuses `posted:true` rather than hitting
RPC. Who supplies `RH_RPC` when a file is posted: the owner. The public endpoint is
`https://rpc.mainnet.chain.robinhood.com`; a keyed URL stays in the environment.

The C2-11 vector `indexer/src/v2/fixtures/maker-epoch-2958.oz.json` is not committed here. A check
against a copy of it must set `"posted": false` (it was never `setRoot` on 4663).

## Publication (later: O3-207)

Weekly: snapshot → `maker:epoch` → review → `fund` → `maker:post --apply` → commit `<n>.json` with
`posted: true` only after the `RootSet` log → data-only release PR. Wrong-root response is that
runbook, not this directory.
