# Handoff — 2026-09-13

Callhouse is **not launchable yet**. The contracts and the keeper are proven on a mainnet fork.
Legal, CI, the external audit, deployment and hosting are not done. The full tracker is
`tasks.md`, and its "Session log" and "Next, in order" sections go deeper than this page.

**2026-09-13's work is committed locally as `8ff8bef`, with the DRYRUN.md proofread committed on
top — not pushed.** `main` on GitHub (`leekzor/callhouse`, private) is still `27d502a`.

## State of the gates

| Gate | State |
|---|---|
| Contracts | 307 unit+invariant pass, 21 fork tests pass against live chain 4663. Unaudited |
| Keeper | typecheck clean, 66/66 tests |
| Keeper dry run | **passed, three cycles**, fork block 61720714, 27.9 s. Re-run independently after the agents finished |
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

1. **Protocol fee on strike proceeds.** The vault takes 10% of strike proceeds on assigned weeks,
   not just of premium. In dry-run cycle 3 that was 202.5 of the 204.4 USDG fee. A test pins this
   behaviour, but `docs/ACCOUNTING.md` §6 says the opposite. Decide which is intended before the
   audit commit is pinned.
2. **GitHub billing.** Go to leekzor → Settings → Billing and raise the Actions spending limit. Then
   add the `RH_RPC` repo secret.
3. **Counsel and operating entity** for `site/app/terms` and `privacy`, plus a security.txt contact.

## Next, in order

1. ~~Commit this work, then proofread `keeper/DRYRUN.md` against the run report.~~ Done
   (2026-09-13): `8ff8bef` locally, proofread commit on top, one error fixed. Still to push.
2. Fix GitHub billing (L-01) and start legal (L-05). Legal is the longest pole.
3. Decide the fee question above.
4. Audit prep: work through the D-05 housekeeping list in `tasks.md`, pin a commit, send
   `docs/AUDIT-SCOPE.md`, and engage an auditor (E-06).
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

- Web-scraping agents have left files at the repo root before. Run `git status` before committing.
