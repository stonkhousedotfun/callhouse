# Handoff — 2026-09-13 (redesign)

Callhouse is **not deployed and not audited** (owner decision D14: no external audit; the gate is the
test suite). The contracts were redesigned on 2026-09-13 (branch
`redesign/a2-own-strikes-2026-09-13`, head `ca0e985`; report:
`~/Desktop/robinhood-dev/projects/callhouse/handoff-2026-09-13/REDESIGN-REPORT-2026-09-13.md`):
**write on fill**, **no Overcall registry or order book**, a **stranded-claim state machine**, split
payout legs, honest NAV, and chain 4663's real **98,304 B** code limit. The app is being ported to
it on branch `redesign/app-write-on-fill` (keeper, indexer, web, ops+docs lanes). The pre-redesign
integration WIP is preserved on `wip/pre-redesign-integration-2026-09-13`. The public site and the
GitBook docs are live but describe the pre-redesign product until pass 2 lands. The live launch
sequence is `docs/LAUNCH-PLAN.md`. The full tracker is `tasks.md`.

**Four private repositories:**

| Repo | Holds | Live at |
|---|---|---|
| `leekzor/callhouse` (this) | `web/`, `keeper/`, `indexer/`, `relay/`, `ops/`, `docs/`, trackers; `contracts/` is a git submodule pinned to `ca0e985` | app.callhouse.finance (Railway service `web`; no vault yet) |
| `leekzor/callhouse-contracts` | the Foundry project, deploy/verify/handover scripts, `docs/AUDIT-SCOPE.md`, `docs/ACCOUNTING.md`, `docs/DEPLOY.md`, `SECURITY.md` | not deployed |
| `leekzor/callhouse-site` | the landing, standalone | https://callhouse.finance (push-to-deploy) |
| `leekzor/callhouse-docs` | GitBook Git Sync source | https://docs.callhouse.finance (push-to-publish; `main` unprotected, so work on a branch) |

Clone with `git clone --recurse-submodules`.

## State of the gates

| Gate | State |
|---|---|
| Contracts (`ca0e985`) | `forge fmt --check` clean; **399 unit/regression/invariant tests, 23 suites** (13 invariants at 64 runs × depth 600); **20 fork tests** vs live 4663; Vault runtime **25,470 B** (chain limit 98,304 B; forge's EIP-170 line is noise), ValoremLib 5,993 B, SeaportOrderLib 5,170 B; deploy rehearsal with real Safes and our own Clear passes (`script/rehearse-deploy.sh`, Verify 63/69/72/71, fork block 62533535). A small follow-up commit (AF-05 share-price floor) may land on the branch; the ABI is unchanged by it, the size moves to ~25,765 B |
| ABIs | `ops/abis/{Vault,ValoremLib,SeaportOrderLib,Policy}.json` regenerated from `ca0e985`; indexer and web generators merge the 36 library-only errors (92 total); the keeper hand ABI carries all 92 |
| Keeper | being ported (keeper lane): `newOptionType` → `rollOpen(id)`, `PARTIAL_RESTRICTED` orders with the vault as zone, fill simulation + reprice, `isStranded` / `retryStrandedClaim`, no Overcall. `keeper/DRYRUN.md` records the **pre-redesign** run and must be re-run |
| Indexer | being ported (indexer lane): `CallsWritten` per fill summed per `claimKey`, the new events, no registry; X-11 fork sync to re-run |
| Web | being ported (web lane): fill page pre-flight for orderType 3 + empty signature, `DepositsClosed` / `maxDeposit == 0`, stranded banner + Retry, Settle queue; W-13 acceptance to re-run |
| Relay | 38 tests; unchanged (its `kind` is not an enum, so the new alert kinds arrive) |
| Ops + docs | this lane: runbooks, alerts, deploy, addresses, safes, publish template, go-live script, architecture, wiring, trackers rewritten for the redesign |
| CI on GitHub | **proves nothing**: every Actions run on the account dies `startup_failure` (billing). The local gates are the gates |

## Done on 2026-09-13

- **Contracts redesign** (owner decisions D1 = A(ii), D16, D17, D14): `rollOpen(optionId)` arms only;
  every Seaport fill writes exactly the filled contracts inside `authorizeOrder`; `validateOrder`
  reverts unless the vault's option balance is back at baseline (AF-01 closed by construction). No
  registry, no Overcall fee item, no `writeMore`, no `invalidateStaleListing`, no EIP-1271. AF-02
  stranded-claim state machine (`ClaimStranded`, `EpochStrandShare`, `retryStrandedClaim`,
  `StillStranded`, `RedeemOutOfGas`). AF-03 split payout legs. AF-04 utilization ceiling 9,985 and
  the engine fee valued at spot inside the fill floor. AF-05 honest NAV, one `DepositsClosed` gate,
  pro-rata `ReserveHaircut`. `DeployClear.s.sol` for our own clearinghouse. Sourcify for source
  verification.
- **App integration started** on `redesign/app-write-on-fill`: submodule pinned, ABIs regenerated
  with the library errors merged, old WIP preserved, per-package lanes running.
- **Ops + docs** (this handoff): `ops/deploy.md` (Railway config-as-code is dead → `RAILWAY_*`
  variables and UI settings; `PORT=3000` on web; CLI ≥ 5.47.2 before sealing; keeper volume
  `RAILWAY_RUN_UID=0` and draining seconds; Sourcify; §13 hand-off), `ops/addresses.json` (registry
  moved to history, `ours.clearinghouse` slot, corrected 46630 verdict), runbooks for the new
  keeper flow and the stranded claim, `ops/alerts.md` (14 kinds: `api_reject` / `listing_invisible`
  retired; `claim_stranded`, `strand_retry_failed`, `fill_sim_revert` added), `ops/safes.md` §4
  re-derived at `ca0e985`, `ops/go-live-app.sh` re-ported, `docs/ARCHITECTURE.md`, `docs/WIRING.md`,
  Eastern-Time cycle wording everywhere a UTC hour was hard-coded.

## Decisions only you can make

1. **`PREMIUM_MARGIN_BPS`**: defaults to 0 (list at the floor). Under write on fill the floor is
   re-priced at every fill, so 0 makes the listing unfillable on the first upward tick until the
   keeper reprices; 50 absorbs a normal tick.
2. **Which clearinghouse** the vault is constructed with: Overcall's unmodified instance (default;
   its `feeTo` key holds the 15 bps switch) or our own from `DeployClear.s.sol` (path A0).
3. **Legal residue**: operating entity, governing law, GDPR controller (`ops/launch-legal.md` §2).
4. **Keys**: Admin Safe 2/3 signers, fee Safe, guardian hardware (`ops/safes.md`). Until the
   handover one deployer key holds every admin power with no timelock (SECURITY §3 mitigations,
   timelock / higher compiled floors / listing start delay / vol-model pricing / no deposits
   before handover, are all open).
5. **GitBook pass 2** (D-02) content for the redesign; work on a branch.

## Next, in order

1. Finish the app port on `redesign/app-write-on-fill` (keeper, indexer, web lanes), each package's
   gate green, then re-run the keeper dry run, X-11 and W-13 against the redesigned vault on an
   anvil fork with `--code-size-limit 98304`.
2. Re-pin `contracts/` at the branch tip if the follow-up commit landed (ABI unchanged; sizes move),
   merge to `main`, push.
3. Keys (L-02, L-03). 4. Mainnet deploy + handover (`contracts/docs/DEPLOY.md` path A, Sourcify).
5. `ops/go-live-app.sh` (after upgrading the Railway CLI ≥ 5.47.2); seal the secrets; the web → keeper
   private-network check; the two external monitors and the P7-02 third-party-key alert set.
6. One real 1-contract fill through the fill page, then four published weeks.

**Dropped:** L-04 (a real Overcall listing) and L-1 (a real keeper signature). There is no Overcall
listing, no EIP-1271 and no signature: the vault pre-validates its restricted order and the fill
page is the venue (D2 = b).

## Traps

- The public RPC keeps only a few thousand trailing blocks of state. Start anvil and run the dry
  run within minutes, **with the code-size flag**:

  ```bash
  (cd contracts && forge build)
  anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545 --code-size-limit 98304
  pnpm --filter @callhouse/keeper dryrun
  ```

- A default anvil refuses the 25 KB vault. `forge build --sizes` exits 1 on its EIP-170 line; that
  is forge, not the chain. `forge script --broadcast` needs `--non-interactive` for the same reason.
- Pass `--no-storage-caching` to every forked `forge script`/`forge test` run near anvil: forge's
  RPC cache (`~/.foundry/cache/rpc/4663/`) can store anvil blocks and silently make later runs lie.
- `RollOpen.contractsCount` is always 0 now; sold is the sum of `CallsWritten` per `claimKey`.
- 36 of the vault's 92 custom errors live only in the library artefacts. A decoder built from
  `Vault.json` alone prints a bare selector for a mis-built order.
- `contracts/` is a submodule. An empty `contracts/` means `git submodule update --init --recursive`
  was never run. `git submodule update` resets the pin to what this repo records.
- A change that spans repos is paired commits. Land the contracts commit first, then bump the pin
  here in the same commit as the app-side changes that depend on it. Copy that changes in `web/`
  usually needs the same change in `callhouse-site` and `callhouse-docs`.
- Railway: config-as-code is deprecated (the `railway.json` files are reference only); healthchecks
  run at deploy time only; sealed variables are invisible to CLI 4.54.0; volumes mount root-owned.
  `ops/deploy.md` has each.
- Several Claude sessions work in these trees at once. Run `git status` before committing, stage
  only your own files, and push fast-forward only. `LAUNCH-CHECKLIST.md` and `docs/COPY.md` in the
  app tree are the owner's untracked files; leave them alone.
