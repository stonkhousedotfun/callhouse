# Handoff — 2026-09-13 (late)

Callhouse is **not deployed and not audited**. The contracts, keeper, indexer and web app are
proven on a mainnet fork. The public site and the docs are live. What remains needs the owner:
the external audit, keys and Safes, the mainnet deploy, and the admin handover. The live launch
sequence is `docs/LAUNCH-PLAN.md`. The full tracker is `tasks.md`.

**Four private repositories:**

| Repo | Holds | Live at |
|---|---|---|
| `leekzor/callhouse` (this) | `web/`, `keeper/`, `indexer/`, `relay/`, `ops/`, `docs/`, trackers; `contracts/` is a git submodule pinned to 634bf55 | app.callhouse.finance (Railway service `web`; no vault yet) |
| `leekzor/callhouse-contracts` | the Foundry project, deploy/verify/handover scripts, `docs/AUDIT-SCOPE.md`, `docs/DEPLOY.md`, `SECURITY.md` | not deployed |
| `leekzor/callhouse-site` | the landing, standalone | https://callhouse.finance (push-to-deploy) |
| `leekzor/callhouse-docs` | GitBook Git Sync source | https://docs.callhouse.finance (push-to-publish) |

Clone with `git clone --recurse-submodules`.

## State of the gates

| Gate | State |
|---|---|
| Contracts | 319 unit+invariant (14 suites), 21 fork tests vs live 4663. Vault 23,618 B (margin 958). Deploy rehearsal with real Safes passes (`script/rehearse-deploy.sh`) |
| Keeper | 89/89 tests; `dryrun` and `dryrun:extended` pass on merged `main` (`keeper/DRYRUN.md`) |
| Indexer | typecheck, fixtures, X-11 fork sync (1452 assertions) |
| Web | lint, typecheck, build, 54 tests, copy-lint; W-13 fork acceptance |
| Relay | 38 tests |
| CI on GitHub | green in app, contracts and site. `RH_RPC` repo secret not set |

## Done on 2026-09-13

- **Two contract defects fixed**: registry lot size must be exactly 1e18; the redeem queue pays each
  entry what its own shares earned.
- **Protocol fee** 5% of premium only (user decision); strike proceeds fee-free.
- **Deploy path**: the deployer key is the bootstrap admin (user decision), then `HandoverAdmin.s.sol`
  grant → Safe smoke batch → renounce. `Verify.s.sol` checks bytecode, immutables, policy, roles and
  the Safe.
- **App launch code**: W-21 (premium vs strike proceeds), K-21, `PREMIUM_MARGIN_BPS`, indexer
  Dockerfile, X-11, alert relay, K-22, W-13; three indexer defects and two keeper defects found by
  the fork runs and fixed.
- **Site** live with corrected copy; **docs** live on GitBook, audited claim by claim against the code.

## Decisions only you can make

1. **External audit**: which firm, and when to tag the commit (`LAUNCH-PLAN.md` §5).
2. **Legal residue**: operating entity, governing law, GDPR controller (`ops/launch-legal.md` §2).
3. **Keys**: Admin Safe 2/3 signers, fee Safe, guardian hardware (`ops/safes.md`).
4. **`PREMIUM_MARGIN_BPS`**: defaults to 0 (list at the floor); 50 absorbs a normal oracle tick.

## Next, in order

1. Audit (E-06). 2. Keys (L-02, L-03). 3. Mainnet deploy + handover (`LAUNCH-PLAN.md` §6–7).
4. Point `web`, `indexer`, `keeper`, `relay` on Railway at the vault; uptime monitors (L-08, L-09).
5. One real Overcall listing (L-04), then four published weeks.

Before L-04: the keeper must post a real ECDSA signature, not the placeholder (L-1 in
`~/Desktop/robinhood-dev/projects/callhouse/HANDOFF-BUGS-2026-09-13.md`, with the other open
rehearsal defects). Owner decision W-1 (deposits into an open week) is in `docs/LAUNCH-PLAN.md`.
Smaller: rename the GitBook site title from "callhouse Docs" (GitBook UI); `RH_RPC` secret.

## Traps

- The public RPC keeps only a few thousand trailing blocks of state. Start anvil and run the dry
  run within minutes:

  ```bash
  (cd contracts && forge build)
  anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545
  pnpm --filter @callhouse/keeper dryrun
  ```

- Pass `--no-storage-caching` to every forked `forge script`/`forge test` run near anvil: forge's
  RPC cache (`~/.foundry/cache/rpc/4663/`) can store anvil blocks and silently make later runs lie.
- `contracts/` is a submodule. An empty `contracts/` means `git submodule update --init --recursive`
  was never run. `git submodule update` resets the pin to what this repo records.
- A change that spans repos is paired commits. Land the contracts commit first, then bump the pin
  here in the same commit as the app-side changes that depend on it. Copy that changes in `web/`
  usually needs the same change in `callhouse-site` and `callhouse-docs`.
- Several Claude sessions work in these trees at once. Run `git status` before committing, stage
  only your own files, and push fast-forward only.
