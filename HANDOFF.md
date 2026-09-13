# Handoff — 2026-09-13

Callhouse is **not launchable yet**. The contracts and the keeper are proven on a mainnet fork.
Legal, CI, the external audit, deployment and hosting are not done. The full tracker is
`tasks.md`, and its "Session log" and "Next, in order" sections go deeper than this page.

**Three private repositories since 2026-09-13** (user decision):

| Repo | Holds | Deploys |
|---|---|---|
| `leekzor/callhouse` (this) | `web/`, `keeper/`, `indexer/`, `ops/`, `docs/`, trackers; `contracts/` is a git submodule | app.callhouse.finance, keeper, indexer on Railway |
| `leekzor/callhouse-contracts` | the Foundry project, `docs/AUDIT-SCOPE.md`, `docs/ACCOUNTING.md`, `SECURITY.md` | the vault (not deployed) |
| `leekzor/callhouse-site` | the landing, standalone | callhouse.finance on Railway |

Clone with `git clone --recurse-submodules`. The 2026-09-13 protocol fee change (5% of premium
only) landed before the split, so all three start from the same tree.

## State of the gates

| Gate | State |
|---|---|
| Contracts | 310 unit+invariant pass, 21 fork tests pass against live chain 4663. Unaudited. Vault 23,426 B (margin 1,150) |
| Keeper | typecheck clean, 66/66 tests |
| Keeper dry run | **passed, three cycles**; re-run after the fee change at fork block 62142174, 20.9 s (cycle 3 fee 0.953962 USDG) |
| Indexer / web / site | green locally. Never run against a live cycle |
| CI on GitHub | dead. Every run ends in `startup_failure`, an account-level billing problem |

## Done on 2026-09-13

- **Keeper dry run extended to three cycles** (`keeper/src/dryrun.ts`, record in `keeper/DRYRUN.md`).
  Cycle 3 is the first real option exercise in this repo, on the real Valorem Clear. 9 of 23 were
  assigned and a queued redeem settled. Every amount is asserted exactly.
- **Keeper defect fixed** (`keeper/src/roll.ts`). A failed pre-close Valorem read used to publish
  as "0 assigned". It is now "unknown" with a warning. 7 new tests cover it.
- **Audit scope written** (`docs/AUDIT-SCOPE.md`). One accuracy and completeness round ran, and its
  fixes were spot-checked by hand. The second check round was lost to the usage limit.
- **`ops/safes.md` §4 corrected.** Its grep proof missed the fee transfer, which is a raw `.call`.
- `keeper/dryrun-out/` added to `.gitignore`.
- `keeper/DRYRUN.md` rewritten for the three-cycle run and **proofread against the run report**
  (`report.md`, `run.json`, `keeper.db` in `keeper/dryrun-out/2026-09-13T05-49-32-373Z/`). Every
  hash, block, gas figure, amount, address and alert matched; one error found and fixed (the
  Overcall validator's check count, now R3's 0–12 table), and the run's commit ref added.

Committed as `8ff8bef`:

```
.gitignore  HANDOFF.md  tasks.md  ops/safes.md  docs/AUDIT-SCOPE.md
keeper/DRYRUN.md  keeper/README.md  keeper/src/dryrun.ts
keeper/src/roll.ts  keeper/src/abi.ts  keeper/src/roll.test.ts  keeper/src/roll.close.test.ts
```

## Decisions only you can make

1. ~~**Protocol fee on strike proceeds.**~~ **Decided and implemented 2026-09-13:** 5% of premium
   only, strike proceeds fee-free. See the afternoon session log in `tasks.md`.
2. **GitHub billing.** Go to leekzor → Settings → Billing and raise the Actions spending limit. Then
   add the `RH_RPC` repo secret.
3. **Counsel and operating entity** for `app/terms` and `app/privacy` in `leekzor/callhouse-site`,
   plus a security.txt contact.

## Next, in order

1. ~~Commit this work, then proofread `keeper/DRYRUN.md` against the run report.~~ Done and
   pushed (2026-09-13), followed by the fee change and the repository split.
2. Fix GitHub billing (L-01) and start legal (L-05). Legal is the longest pole.
3. ~~Decide the fee question above.~~ Done. Fix W-21 (assigned-week yield labels) before launch.
4. Audit prep: work through the D-05 housekeeping list in `tasks.md`, tag a commit in
   `leekzor/callhouse-contracts`, point the `contracts/` submodule here at it, send
   `contracts/docs/AUDIT-SCOPE.md`, and engage an auditor (E-06).
5. Finish the fork rehearsal. The indexer still has to sync against a fork (X-11), and the web app
   needs an acceptance test from a fresh wallet (W-13).
6. Keeper follow-ups. K-21: the assigned-week alert calls strike proceeds "harvested". K-22 lists
   the paths the dry run still does not cover.
7. Keys and deploy: Admin Safe 2/3, guardian key, mainnet deploy per `ops/deploy.md`, cap 20 NVDA.
8. Hosting and alerting: Railway services, apex DNS, uptime monitors, the alert webhook relay.
9. Post one real 1-contract Overcall listing to settle EIP-1271 (L-04). Then publish four weeks.

## Traps

- The public RPC keeps only a few thousand trailing blocks of state. Start anvil and run the dry
  run within minutes:

  ```bash
  (cd contracts && forge build)
  anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545
  pnpm --filter @callhouse/keeper dryrun
  ```

- `contracts/` is a submodule. An empty `contracts/` means `git submodule update --init --recursive`
  was never run, and the dry run then fails at the artifact link check. The dry run builds whatever
  commit the submodule is pinned to, not the tip of `leekzor/callhouse-contracts`.
- A change that spans repos (a contract change that alters amounts, copy rules, design tokens) is
  paired commits. Land the contracts commit first, bump the pin here in the same commit as the
  app-side changes that depend on it.
- Web-scraping agents have left files at the repo root before. Run `git status` before committing.
