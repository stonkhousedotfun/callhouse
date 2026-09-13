# Callhouse — Tasks & Progress

Companion to `plan.md`. Progress as of **2026-09-12**.

Legend: `[x]` done · `[~]` in progress · `[ ]` todo · `[!]` blocked

Milestones: M0 scaffold+recon → **M1 contracts on mocks** → **M2 contracts on fork** → M3 keeper dry-run → M4 indexer+API → M5 web → M6 ops+audit → M7 launch wk0–1 → M8 wk2–4

---

## Status

| Gate | State |
|---|---|
| Unit + invariant tests | **307 passed, 0 failed, 0 skipped** across 12 suites |
| Fork tests vs live chain 4663 | **21 passed, 0 failed** (incl. `test_fork_writeAndListForReal`, 1.05M gas — a real write+list through live Valorem) |
| `Vault` runtime size | 23,142 B (EIP-170 limit 24,576, margin 1,434; two linked libraries) |
| keeper | typecheck clean; **59/59 tests** across 7 suites (the glob previously matched zero files) |
| indexer | typecheck clean; API shape pinned to `ops/fixtures/api/` |
| web | lint clean, build clean (7 routes), tests green |
| site | typecheck + lint clean, Docker build green |
| Docker | **all three images build** (`callhouse-web`, `callhouse-site`, `callhouse-keeper` — incl. the better-sqlite3 load assertion) |
| copy-lint (compliance) | 43 files in `web`, 20 in `site`, 0 violations; **7-case self-test runs on every invocation**; wrapped forbidden phrases caught by a full-buffer pass |
| Recon unknowns resolved | 9 of 9 |
| Real defects found and fixed | 13 in the first review + **18 in the second sweep** (keeper-focused, 2026-09-12; 38 raw findings, cross-confirmed, incl. the `.dockerignore` exclusion that kept the keeper image unbuildable) |
| Subagents run | 42 across the build workflows + 85 across the review + 4 in the second sweep |

M0, M1 and M2 are complete. M3–M5 are built and green in CI terms but have not yet been
exercised against a live cycle, which is what M6 is for. Two adversarial passes are done:
the internal review (see `SECURITY.md`) and a keeper-focused second sweep the same day —
three independent auditors, 38 raw findings, 18 real defects fixed and re-verified (the
state-reconciliation trio: unwitnessed `rollClose`, unservable authorised listing, missing
`roll_open_tx` backfill; the manipulable last-fill price signal; the book-status latch; the
`/health` RPC-URL leak; the `.dockerignore` exclusion that kept the keeper image
unbuildable). `ops/alerts.md` now documents the 13 kinds the keeper actually emits; the old
36-code vocabulary is retired and mapped. The external audit is still ahead.

---

## Phase 0 — Scaffold + recon (M0) ✅

- [x] P0-01 Read `README.md` + `TECHSPEC.md`, write `plan.md` + `tasks.md`
- [x] P0-02 Strip chat artifacts (README code-fence wrapper and trailing line; TECHSPEC leading and trailing lines)
- [x] P0-03 Reconstruct the garbled TECHSPEC §4.4 policy list (markdown had eaten the `<` and `>=`)
- [x] P0-04 `minOtmBps` corrected from "ceiling 0" to a **floor of 100 bps**, enforced in bytecode
- [x] P0-05 Toolchain verified: forge 1.3.5, anvil 1.6.0, node 26.5, pnpm 9.10
- [x] P0-06 `git init`, `.gitignore`, `pnpm-workspace.yaml`, root `package.json`
- [x] P0-07 `contracts/` Foundry, solc 0.8.28, cancun, **via-IR on** (needed for the order encoders)
- [x] P0-08 forge-std 1.16.2, OpenZeppelin 5.7.0
- [x] P0-09 keeper / indexer / web packages, real dependency versions pinned
- [x] P0-10 `.env.example` with every key, protocol addresses pre-filled
- [x] P0-11 CI: fmt, build, unit, invariant, fork, JS typecheck, web build, copy-lint

### Recon — all nine answered, each investigated then adversarially re-verified

- [x] R1 **OvercallRegistry (NVDA) = `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`**, verified source, not a proxy
- [x] R2 Overcall Seaport shape decoded from the one real fill on chain, cross-checked against their live API
- [x] R3 Listings API: `POST https://overcall.finance/api/orders?market=NVDA`, no auth, ERC-1271 offerers accepted — **not a launch blocker**
- [x] R4 Valorem Clear is bytecode-identical to upstream `ValoremOptionsClearinghouse` @`6436c823`
- [x] R5 Chainlink `RHNVDA / USD` at `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`, 8 decimals
- [x] R6 Stock Token: 18 decimals, non-rebasing, live `uiMultiplier()` (observed 1.000775…), `oraclePaused()` present
- [x] R7 Testnet 46630 **can host a dry-run** — first pass said unusable; the adversarial re-check refuted it: Valorem Clear `0x0059df7c…acbc`, ten Overcall registries (NVDA `0xdFA1cab9…4A56` with `isWritingOpen`), mock NVDA with `oraclePaused()`, self-minting mock USDG. Cycles are hand-set and lapse
- [x] R8 Explorers mapped; Blockscout sits behind a Cloudflare challenge and is not reliably scriptable
- [x] R9 Conduit key is zero — Seaport pulls the ERC-1155 directly
- [x] R10 All six README addresses independently confirmed
- [x] R11 ABIs committed to `ops/abis/`
- [x] R12 Overcall's whole on-chain surface mapped: one registry type, 11 live markets, no zone, no periphery, no proxy

Evidence lives in `ops/recon/`. Spec repairs are written up in `plan.md` section 14.

---

## Phase 1 — Contracts (M1 ✅, M2 ✅)

### Source — 18 files under `contracts/src/`

- [x] C-01..05 Interfaces: `IValoremClear`, `IOvercallRegistry`, `ISeaport`, `IStockToken`, `IChainlinkFeed`, `IERC1155Minimal`
- [x] C-06 Mocks: `MockClear`, `MockRegistry`, `MockSeaport`, `MockStockToken` (multiplier + issuer freeze), `MockERC20`, `MockFeed`
- [x] C-07 `Policy.sol` — bounds library, hard caps in bytecode, per-contract fee rounding
- [x] C-08..12 `Vault.sol` — state, roles, ERC-4626 deviations, `totalAssets`, previews that never quote an unavailable path
- [x] C-13..15 Phase machine, `rollOpen` gates, `lockBook`, `rollClose` with the guardian path
- [x] C-16 `AdapterValorem.sol` — write, redeem, claim accounting, partial assignment
- [x] C-17..19 `AdapterSeaport.sol` + `lib/SeaportOrderLib.sol` — on-chain order validation, EIP-1271, cancel, counter bump
- [x] C-20 `Distributor.sol` — `accUsdgPerShare`, settle-on-transfer, balance-checkpoint accounting
- [x] C-21..23 Halt, Valorem fee acceptance, admin setters inside hard caps
- [x] C-24..25 Events and NatSpec throughout

### Tests — 295 passing across 10 suites

- [x] `Policy.t.sol` (48) · `Smoke.t.sol` (4) · `SplitDiff.t.sol` (differential vs the keeper's TypeScript split) · `VaultDeposit` (43) · `VaultQueue` (33) · `VaultRoll` · `VaultListing` · `VaultDistributor` · `VaultAssignment` · `VaultAdmin` · `VaultInvariant` (stateful, 6 invariants)
- [x] All 14 fork tests from `plan.md` §4.11 covered, plus the live-chain integration test

### Fork — 21 tests green against chain 4663

- [x] Every address confirmed on chain; Seaport reports version `1.6`
- [x] Registry describes the NVDA pair; the JUGGERNAUT registry is asserted **not** to be ours
- [x] Live strike ladder read: 226 / 231 / 236 / 241 / 246 USDG, 5 rungs, ascending
- [x] Real NVDA deposit and instant redeem
- [x] **Real write and real listing**: 3 contracts written on the live 226 rung through Valorem, authorised on real Seaport, EIP-1271 answering for the real EIP-712 digest
- [x] Out-of-band rung correctly refused against the live ladder

### Deploy

- [x] D-01 `Deploy.s.sol` with recon-confirmed defaults and an on-chain preflight
- [x] D-02 `Configure.s.sol` — roles, optional policy override, renounce reminder
- [x] D-03 Blockscout verify flags documented
- [ ] D-04 Deploy to a fork rehearsal, then mainnet (M7)

---

## Phase 2 — Keeper (M3) — built, not yet run against a live cycle

- [x] K-01..03 zod-validated config, dual-RPC failover, restart-safe SQLite state
- [x] K-04..06 Roll state machine bound to `registry.isWritingOpen()`, strike picker, Seaport order builder
- [x] K-07..11 Overcall API client, listing verification, relist budget, `lockBook`, `rollClose`
- [x] K-12..13 `/health` and `/state`, webhook alerts
- [x] K-14 `dryrun.ts` — full cycle against an anvil fork with time warp, driving the production `reconcile()`/`tick()` (rewritten 2026-09-12; the previous version re-implemented the strike pick and ran no keeper code)
- [x] K-15..16 Dockerfile, systemd unit, keeper-dead runbook
- [x] K-17 Second-sweep hardening (2026-09-12): boot reconciliation now closes a cycle someone else closed (sums Harvest from logs, fires `roll_close`), recovers an authorised-but-unservable listing via `invalidateAllListings` + relist, backfills `roll_open_tx` from the tx table and the `RollOpen` log; relists price at `max(previous, live policy floor)`; the last-fill lift is clamped at 3× floor; book-reported `filled`/`unfillable` no longer latch against chain evidence; `/health` serves RPC origins only and stays 200 during a slow close; failed webhook deliveries retry in 5 min instead of burning the hour; `railway.json` `startCommand` deleted so SIGTERM reaches node
- [x] K-18 First real keeper tests: 59/59 across 7 suites (`alerts`, `config`, `overcallApi`, `policy`, `roll`, `seaport`, `state`) — the package previously had a test script whose glob matched zero files
- [ ] Run `dryrun.ts` end to end and record the output (anvil fork; the honest gate for M3, and a launch prerequisite — the keeper has never executed a live cycle)

---

## Phase 3 — Indexer + API (M4) — built, not yet backfilled

- [x] X-01..08 Ponder config, schema, handlers for vault / Valorem / Seaport / registry / token; unfilled weeks stored as first-class rows with zeros
- [x] X-09..10 `/v1/vault`, `/v1/cycles`, `/v1/account/:addr`, `/v1/listings`, `/health`, HMAC-gated `/v1/overcall/list`
- [ ] X-11 Sync against a fork and assert the tables match chain state

---

## Phase 4 — Web + site (M5) — built and building

- [x] W-01..02 Next 16 App Router, wagmi 3, viem, chain 4663, display math
- [x] W-03..08 `/`, `/vault/nvda`, `/vault/nvda/cycle`, `/activity`, `/docs`, `/legal`
- [x] W-09..10 All components; required disclosures rendered verbatim
- [x] W-11 copy-lint wired to CI — forbidden terms and required disclosures both enforced
- [x] W-12 Mobile pass, no charts
- [ ] W-13 Acceptance test from a fresh wallet against a fork, **including a fill served from the keeper's own `/orders` payload** — the self-hosted fallback on `/vault/nvda/cycle` is the answer if Overcall's book rejects us, and it has never filled anything end to end

### Frontend split — two domains, two services (code written, nothing deployed)

- [x] W-14 New `site/` package = `callhouse.xyz`, the marketing landing: `/`, `/how-it-works`, `/risks`, `/legal`. **No wallet code** — `wagmi`, `viem` and `@tanstack/react-query` are not dependencies and must not become dependencies. No chain read, no `fetch()`, no live figure: the vault is not deployed, so every live number would render zero, and a zero beside "realized" reads as a result rather than an absence. Every CTA is an absolute external link to `https://app.callhouse.xyz/...`
- [x] W-15 `web/` retargeted to `app.callhouse.xyz`, routes unchanged, and set `noindex` — the disclosures get one canonical address and it is the other domain (reasoning in `web/app/layout.tsx`, restated by `app/robots.ts`). `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_APP_URL` added to both packages via `lib/site.ts`, production values compiled in as defaults
- [x] W-16 Design tokens duplicated, not imported: the token block in `web/app/globals.css` is copied into `site/app/globals.css` so `site/` builds with no dependency on `web/`. **The two must be changed in the same commit** or the domains drift
- [x] W-17 copy-lint now walks both packages under one rule set, and a missing package is a hard failure rather than a silent pass. CI `js` job typechecks and builds `@callhouse/site` alongside `web`
- [x] W-18 `site/Dockerfile` + `site/railway.json`, `web/Dockerfile` + `web/railway.json`; `output: "standalone"`, repo root as build context (a `site/`-scoped context cannot install — the lockfile is workspace-wide), per-service `watchPatterns` so one push does not rebuild both. Runbook: `ops/deploy.md`
- [ ] W-19 Two Railway services created and deployed from `main`. Nothing is deployed yet; every `NEXT_PUBLIC_*` must be set as a build variable **before** the first build, because they are inlined by `next build` and not read at runtime
- [ ] W-20 DNS. `app.callhouse.xyz` is a plain `CNAME`. **`callhouse.xyz` is an apex**, and a `CNAME` at a zone apex is not valid DNS — it needs a provider offering `ALIAS`/`ANAME` or Cloudflare CNAME flattening. Prerequisite for W-19 being publicly reachable; attach the domains only after a deploy is healthy, so a DNS failure stays distinguishable from an application failure

---

## Phase 5 — Ops (M6) ✅

- [x] O-01 `ops/addresses.json` with evidence per entry and the JUGGERNAUT trap called out
- [x] O-02 `ops/abis/` committed
- [x] O-03..05 `runbooks/open-week.md`, `close-week.md`, `incident.md`
- [x] O-06 `ops/safes.md` — role topology and what each key can and cannot do
- [x] O-07 `ops/alerts.md` — reconciled 2026-09-12 to what the keeper actually emits (13 kinds, `info|warn|error`, payload shape, cooldown semantics). The previous 36 SCREAMING_CASE codes were never emitted; each is now mapped to its real kind or marked as an external monitor / weekly runbook step
- [x] O-08 `ops/publish-template.md`, including the honest "unfilled, 0"

---

## Phase 6 — E2E, testnet, audit (M6) — the next real work

- [x] E-00 Internal adversarial review (2026-09-12): 72 findings across 13 surfaces, 51 confirmed after refutation; 1 critical + 2 high + 2 medium fixed with regression tests, hardening (events, ABIs, decoder coverage) landed alongside. Write-up: `SECURITY.md`
- [x] E-00b Second sweep, keeper-focused (2026-09-12): three auditors (correctness / adversarial / operator), 38 raw findings, 18 real defects fixed and re-verified — see K-17 and the status table. Also: copy-lint gained its self-test and a full-buffer pass, and `ops/alerts.md` was rewritten to match the emitted kinds
- [ ] E-01 Full cycle on an anvil fork: deposit → open → fill → expire OTM → close → claim → queue redeem
- [ ] E-02 ITM variant with partial assignment
- [ ] E-03 Two rehearsal weeks on a **mainnet fork with a mock registry** (the only way to time-warp a week into minutes)
- [ ] E-04 One full cycle on **testnet 46630** — real Valorem + Seaport, Overcall's NVDA registry once their operator sets a fresh cycle (or our own MockRegistry deployed there), mock-NVDA collateral, self-filled listing. Needs: testnet deploy config, a stand-in price feed (no Chainlink RHNVDA on 46630), funded key from the faucet. Covers everything except Overcall's production listings API
- [ ] E-05 Audit scope doc: Vault, adapters, `SeaportOrderLib`, `ValoremLib`, Distributor. Link Zellic's Valorem reports; do not re-audit Valorem
- [ ] E-06 External audit engaged, findings triaged (E-00 was internal, not this)
- [ ] E-07 Bug bounty drafted, opens mainnet week 2

---

## Phase 7 — Launch (M7, M8)

- [x] L-00 Repo on GitHub: `leekzor/callhouse` (**private**), `main` pushed with the full tree, forge-std/OpenZeppelin as submodules (2026-09-12)
- [ ] L-01 CI green on every push. The workflow is committed and the full gate passes locally (forge unit+fork, keeper 59, indexer, web/site lint+build+tests, copy-lint self-test), but on GitHub every run dies as `startup_failure` before the first job — a one-step probe workflow fails identically, so the file is not the problem: it is account-level (Actions spending limit / private-repo minutes on the free `leekzor` plan; 2015 account, Actions enabled, token is leekzor's). Fix in the GitHub UI: Settings → Billing → spending limit. Until then the local gate is the gate. Also set the `RH_RPC` repo secret (archive RPC); the fork job falls back to the public endpoint without it
- [ ] L-02 Admin Safe 2/3 on 4663
- [ ] L-03 Guardian key provisioned on separate hardware
- [ ] L-04 One real 1-contract listing posted to Overcall to close out the EIP-1271 question (see Open questions)
- [ ] L-05 Legal, the real blocker: counsel reviews `site/app/terms` + `site/app/privacy`. Both render "Draft — pending review by counsel" and copy-lint fails CI until `LEGAL_DOCS_VERSION` drops the `draft-` prefix in the same commit as adoption — that is deliberate, do not bypass it. Set the operating-entity constants (the site renders "no operating entity designated" until then — also deliberate). Set a real `Contact:` for `.well-known/security.txt` (the route 404s without one; a security.txt with no contact is worse than none)
- [ ] L-06 Mainnet deploy, verify, configure roles, renounce deployer (D-04; runbook `ops/deploy.md`)
- [ ] L-07 Vault live, cap 20 NVDA
- [ ] L-08 Hosting beyond the two frontends (W-19): the keeper Railway service (keeper/Dockerfile, volume mounted at `/data`, `PORT=8787`, `KEEPER_PK` as a runtime service variable — never a build ARG) and the indexer service. Plus the two external uptime monitors: keeper `/health` and the indexer health endpoint (`ops/alerts.md` §11, §26 — currently "not yet stood up")
- [ ] L-09 Alerting delivery: `ALERT_WEBHOOK` pointed at a relay that wraps the JSON payload for Telegram/Discord — a raw Discord URL returns 400 forever (ops/alerts.md "Transport"). Webhook test is part of the Saturday `close-week.md` ritual
- [ ] L-10..13 Publish four weekly results, including any "unfilled, 0"; raise the cap
- [ ] L-14 Decide the PFE / SCHD second deploy

---

## Defects found and fixed during the build

Thirteen real defects, all found by adversarial passes and all fixed with a regression test left
behind. 1–9 were build-time; 10–13 came out of the 2026-09-12 review (full write-up, with the
attack mechanics, in `SECURITY.md` §4). The last five were the serious ones.

| # | Defect | Consequence | Fix |
|---|---|---|---|
| 1 | Queued shares were both escrowed and subtracted from the owner's balance | Queueing a full position reverted; a partial queue froze the remainder | Escrow alone governs a queued share |
| 2 | A deposit during `Listed` shared premium earned before it arrived | Anyone could deposit just before the close and dilute the holders whose collateral backed the call | Harvest is checkpointed into the index before minting |
| 3 | Deposit cap measured on the raw token balance | Writing collateral into Valorem re-opened the cap mid-cycle | Measured on `totalAssets()` |
| 4 | `maxDeposit` ignored the phase gate | Quoted room the caller could not use | Returns 0 outside the deposit phases; `maxMint` added |
| 5 | `RollClose` emitted a hardcoded `0` assigned count | Every assigned week looked unassigned in the public cycle tape | Read before `_redeemClaim` zeroes the claim key |
| 6 | `contractsSold` was never updated | `contractsRemaining()` lied after any fill | Both derived from the live ERC-1155 balance |
| 7 | The Valorem fee acceptance switch was decorative | The adapter reverted regardless, so governance could never accept the fee | The flag is passed into the write path |
| 8 | `queueRedeem`'s auto-complete moved tokens | Under an issuer freeze, a holder with an uncollected epoch could not queue at all | Settling parks into `owedAssets`; only collecting touches tokens |
| 9 | The accrual index could promise one base unit more USDG than the vault held | `usdgOwed()` underflowed and permanently bricked deposits and rolls; worse, a settled redeemer's entire principal was stranded behind a one-unit shortfall | Accounting anchored on a measured balance checkpoint; every payout clamped to what is actually backed |
| 10 | Deposits stayed open through the exercise window while assignment crashed NAV mid-transaction with no callback | Anyone could exercise, mint against the crashed NAV in the same block, and take a riskless pro-rata slice of the strike proceeds from the depositors actually assigned | Deposit window closes on `cycleExerciseTs` plus a clock-independent refusal whenever unclaimed assignment proceeds exist |
| 11 | The registry EOA could set an expiry years out, and the vault trusted the option's window to match the cycle's | Up to 95% of collateral locked in Valorem for the tenor; or the deposit gate's "no early assignment" premise silently broken | `MAX_CYCLE_TENOR = 21 days` compiled in; `OptionWindowMismatch` unless the option's window equals the cycle's |
| 12 | The protocol fee was pushed inside `rollClose` with a hard transfer | A blocklisted recipient, paused USDG or reverting receiver froze all collateral, the queue and every future cycle | Best-effort push that cannot revert the close; `pendingFeeUsdg` accrues; permissionless `sweepFee()` recovers |
| 13 | Accepting the Valorem engine fee still could not write — the 15 bps is charged **on top of** the collateral | With no upgradeability, Valorem flipping the fee switch would have ended the product's ability to write, permanently | The write approves collateral + fee and scrubs the allowance after |

Observability gaps closed in the same pass (not money defects): the queue auto-settle moved owed
balances with no event (`QueueEntrySettled` added, plus its indexer handler and one for
`FeeSwept`); the keeper was missing 32 custom-error fragments, so a simulation revert would have
printed a bare selector; the ops/indexer/web ABI copies predated the review fixes and were
regenerated (`web` now has a committed generator, `web/scripts/gen-abis.mjs`).

---

## Open questions to settle before launch

1. **EIP-1271 vs Overcall's validator.** The vault authorises listings by hash and ignores the
   signature bytes, which is strictly stronger than recovering a keeper signature. Overcall's
   documented validation calls `isValidSignature` on a contract offerer, so this should work —
   but it has never been exercised against their live server. Post one real 1-contract listing
   before launch. The self-hosted fill page on `/vault/nvda/cycle` is the fallback if it fails.
2. **Keeper premium floor.** The strike picker prices at exactly the policy floor, and the vault
   re-reads spot when authorising. A single upward oracle tick between the two reads reverts
   `PremiumBelowMinimum`. It self-heals on the next tick, but it will make Friday-night noise on
   the first live cycle. Decide whether to add a margin.
3. **Deposit-time harvest cost.** Checkpointing the harvest on every deposit is correct but adds
   gas to the deposit path. Measure it on the first live week.

---

## Build constraints worth knowing before you touch the contracts

- **`Vault` has ~1.4 KB of headroom** under the EIP-170 24,576-byte runtime limit (23,142 B used).
  via-IR is on and both `SeaportOrderLib` and `ValoremLib` are already factored out as linked
  public libraries — the second extraction paid for the 2026-09-12 review's deposit-gate and
  cycle-window checks. Anything more than a small addition will need a third extraction, not
  another optimiser setting: optimiser runs were measured from 1 to 200 and move the figure by
  under 200 bytes.
- **The test tree is near solc's tag-space limit.** Each unit suite deploys the whole fixture and
  compiles to roughly 100–122 KB of deployed bytecode, and with via-IR on, adding another
  fixture-heavy suite can produce
  `Internal compiler error (CompilerStack.cpp:1417): Assembly exception for bytecode: Tag too
  large for reserved space`. If it appears, factor shared sequences into helpers on `BaseTest`
  rather than repeating them per test.
- **`forge fmt --check` is a CI gate** and `--no-match-path 'test/fork/*'` is how the unit run
  excludes the fork suite; fork tests run under `FOUNDRY_PROFILE=fork`.
- **Clear `cache/invariant` after changing contract behaviour.** Foundry replays persisted
  counterexamples, and a stale one reports as a mystery failure in an unrelated test.
- **ABIs flow one way: `contracts/out` → `ops/abis/Vault.json` → generated copies.** After any
  contract change, refresh `ops/abis/Vault.json` from the compiled artefact, then run
  `pnpm gen:abis` in `indexer/` and in `web/` (committed scripts; the web one additionally filters
  to the read + user-write surface while keeping every event and error). The keeper's
  `keeper/src/abi.ts` is hand-transcribed by design — check it still names every custom error the
  keeper can hit, or a simulation revert prints a bare selector.
