# Handoff — 2026-09-14 (write-on-fill port, launch)

Callhouse is **not deployed**. Owner decision D14: no external audit; the gate is the test suite.
An internal review of `redesign/a2-own-strikes-2026-09-13` @ `79cee08` on 2026-09-14 found no
Critical/High/Medium; Low L-01 (in-fill deposit) is fixed at `bec4dbd`. Tip is `165b4ab` (script-only:
Clear `feeTo` must be the admin Safe). Report:
`~/Desktop/robinhood-dev/projects/callhouse/handoff-2026-09-13/AUDIT-FINDINGS-2026-09-14.md`.
Canary runbook: `ops/runbooks/canary-week.md`.

**Four private repositories (nothing of the redesign is on `main` / live yet):**

| Repo | Branch (local) | Pin / head | Live |
|---|---|---|---|
| `leekzor/callhouse` | `redesign/app-write-on-fill` | submodule `contracts/` = `165b4ab` | app.callhouse.finance still the old app; no vault |
| `leekzor/callhouse-contracts` | `redesign/a2-own-strikes-2026-09-13` | `165b4ab` | not deployed |
| `leekzor/callhouse-site` | `redesign/write-on-fill` | `a6eb0bf` | callhouse.finance still the old copy until this branch is merged |
| `leekzor/callhouse-docs` | `redesign/pass-2` | `4c16b58` | docs.callhouse.finance still the old copy (`main` unprotected — do not push this branch by accident) |

## State of the gates (measured 2026-09-14)

| Gate | State |
|---|---|
| Contracts (`165b4ab`) | L-01 in `bec4dbd` (Vault 25,775 B). Offline suite **405** passed / 24 suites; fork **20/20**. ABI byte-identical to `79cee08`. `foundry.toml` now `isolate = true` (transient `_fillArmed`). Script-only `165b4ab`: Verify requires `EXPECTED_CLEAR_FEE_TO` on our Clear |
| Keeper | typecheck clean; **96/96**. Both fork dry runs passed 2026-09-14 (`keeper/DRYRUN.md`). Review-fixes committed (`recoveryLegs`, adopt lost `rollOpen`, no listing while Valorem fee on and unaccepted) |
| Indexer | typecheck clean; **79** tests. **X-11 PASSED** 2026-09-14 (2010/2010 API assertions, 107 run.json/chain cross-checks; dry run 33.7s + sync 10.6s) |
| Web | lint, typecheck, copy-lint (59 files, 0), build, **185** tests. Fill-state/guards in `web/lib/vaultStatus.ts`. **W-13 PASSED** 2026-09-14 (write-on-fill: tamper rejected, page fill 2 + raw fill 3, queue, exercise 2, assigned close, activity agrees; 24s) |
| Relay | 38 tests; unchanged |
| Site | `redesign/write-on-fill`: lint, typecheck, copy-lint (45 files, 0), build |
| Docs | `redesign/pass-2` committed locally, including `product/buying-calls.md` |
| CI on GitHub | **proves nothing**: Actions `startup_failure` (billing) |

## Owner decisions (2026-09-14)

- Own Clear via `DeployClear.s.sol`. **`feeTo` = a 1-of-1 Safe owned by `0x7A3a8C3F6331f63107D5b3aEeA0515e799022C32`** (personal wallet, given 2026-09-14; EOA, 0.27 ETH on 4663, nonce 0). Vault admin stays hot-wallet account 0 until handover. `HandoverAdmin` does not move `feeTo`.
- `KEEPER_PREMIUM_MARGIN_BPS=50`. Guardian = mnemonic account 2 `0x29741A8d…6F39`. Cap 20 NVDA, raise weekly. No alerts for the canary.
- Merge+push both repos when gates and the fork rehearsal are green (authorised). Tag contracts `v1.0.0-rc1`.
- Funded on 4663: admin `0xEb82c3D0…19d9b` 0.05 ETH, keeper `0x06c131cf…FC1d2` 0.02 ETH, guardian 0.01 ETH.
- Canary token buy deferred a few hours; runbook is `ops/runbooks/canary-week.md`.

## Next, in order

1. **Canary week** per `ops/runbooks/canary-week.md`. Vault is live at `0x88a98931E3682137E7e4D3426f623247f4A4ecbb`. Keeper stays stopped until the 1.06 NVDA deposit lands. Site/docs branches stay unpublished until the owner says so.

Deploy rehearsal (2026-09-14, fork block 63400155): **REHEARSAL PASSED**. Path A on our Clear with `feeTo` = admin Safe 2/3; Verify's missing/wrong-holder checks have teeth; handover; path B on Overcall's Clear with Safe from block one.

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

**Dropped:** L-04 (a real Overcall listing) and L-1 (a real keeper signature). There is no Overcall
listing, no EIP-1271 and no signature: the vault pre-validates its restricted order and the fill
page is the venue (D2 = b). Legal residue (entity / governing law / GDPR controller) remains open
and is ignored for the canary.

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
