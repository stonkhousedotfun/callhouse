# Callhouse — Tasks & Progress

Companion to `plan.md`. Progress as of **2026-09-13**.

Legend: `[x]` done · `[~]` in progress · `[ ]` todo · `[!]` blocked

Milestones: M0 scaffold+recon → **M1 contracts on mocks** → **M2 contracts on fork** → M3 keeper dry-run → M4 indexer+API → M5 web → M6 ops+audit → M7 launch wk0–1 → M8 wk2–4

---

## Status

| Gate | State |
|---|---|
| Unit + invariant tests | **310 passed, 0 failed, 0 skipped** across 12 suites (307 before the 2026-09-13 fee change; +2 fee guards in `VaultAssignment`, +1 invariant `invariant_feeNeverTouchesStrikeProceeds`) |
| Fork tests vs live chain 4663 | **21 passed, 0 failed** (re-run after the fee change) (incl. `test_fork_writeAndListForReal`, 1.05M gas — a real write+list through live Valorem) |
| `Vault` runtime size | 23,426 B (EIP-170 limit 24,576, margin 1,150; two linked libraries). 23,142 B before the fee change, measured at `cb82bf3` |
| keeper | typecheck clean; **66/66 tests** across 8 files (59 on 2026-09-12, +7 for the assignment-count resolver) |
| Keeper dry run (anvil fork of 4663) | **passed, three cycles**, re-run after the fee change (2026-09-13T17:42Z, fork block 62142174, 20.9 s; first run fork block 61720714, 27.9 s): filled OTM week, adopted unfilled week, and an ITM week with 9 of 23 exercised on the real Valorem Clear plus a queued redeem. Record: `keeper/DRYRUN.md` |
| indexer | typecheck clean; API shape pinned to `ops/fixtures/api/` |
| web | lint clean, build clean (7 routes), tests green |
| site | typecheck + lint clean, Docker build green |
| Docker | **all three images build** (`callhouse-web`, `callhouse-site`, `callhouse-keeper` — incl. the better-sqlite3 load assertion) |
| copy-lint (compliance) | 43 files in `web`, 20 in `site`, 0 violations; **7-case self-test runs on every invocation**; wrapped forbidden phrases caught by a full-buffer pass |
| Recon unknowns resolved | 9 of 9 |
| Real defects found and fixed | 13 in the first review + **18 in the second sweep** (keeper-focused, 2026-09-12; 38 raw findings, cross-confirmed, incl. the `.dockerignore` exclusion that kept the keeper image unbuildable) |
| Audit scope | `docs/AUDIT-SCOPE.md` drafted and fact-checked (E-05); needs a pinned commit and the Appendix B housekeeping |
| Subagents run | 42 across the build workflows + 85 across the review + 4 in the second sweep + 29 on 2026-09-13 (dry-run cycle 3, audit scope, recording) |

M0, M1 and M2 are complete. M3 is complete: the keeper's production modules have run three
whole cycles on a mainnet fork, including a real assignment and a queued redeem (2026-09-13).
M4–M5 are built and green locally but have not been exercised against a live cycle. Two adversarial passes are done:
the internal review (see `SECURITY.md`) and a keeper-focused second sweep the same day —
three independent auditors, 38 raw findings, 18 real defects fixed and re-verified (the
state-reconciliation trio: unwitnessed `rollClose`, unservable authorised listing, missing
`roll_open_tx` backfill; the manipulable last-fill price signal; the book-status latch; the
`/health` RPC-URL leak; the `.dockerignore` exclusion that kept the keeper image
unbuildable). `ops/alerts.md` now documents the 13 kinds the keeper actually emits; the old
36-code vocabulary is retired and mapped. The external audit is still ahead.

### Session log — 2026-09-13 (afternoon): protocol fee decided and implemented

- **Decision (user):** the protocol fee is **5% of premium only**. Strike proceeds from assignment
  are credited to holders fee-free. Closes open question 3. Before: 10% of every USDG inflow, which
  on dry-run cycle 3 took 202.5 USDG of returned principal against a 19.08 USDG premium.
- **Contract:** `Vault._accrueHarvest(uint256 feeFree)`; `rollClose` passes
  `usdgFromAssignment` (the measured claim redemption) to `_harvest`; deposit checkpoints pass 0.
  `Policy.launchDefaults().protocolFeeBps` 1000 → 500; `Configure.s.sol` default 500. Event ABI
  unchanged: on an assigned week `Harvest.grossUsdg` still includes strike proceeds and
  `feeUsdg = floor((gross − RollClose.usdgFromAssignment) × bps / 10000)`. +284 B runtime.
- **Tests:** every hardcoded 10% figure re-derived by hand (python integer arithmetic, never pasted
  from a failing assertion; the contract agreed with every derivation). Inputs changed only where
  a test's exactness or remainder property would otherwise have gone unexercised
  (`VaultAssignment` two-redeemer dust test, `VaultQueue` two-epoch test, `VaultDistributor`
  dust-carry test). New: `test_protocolFeeIsChargedOnPremiumOnlyNeverOnStrikeProceeds` (replaces
  the test that pinned the old behaviour), `test_maxFeeCeilingOnAnAssignedWeekTakesOnlyPremium`,
  `test_checkpointedPremiumThenAssignment_feeIsStillPremiumOnly`, and
  `invariant_feeNeverTouchesStrikeProceeds` (ghost premium measured at each fill; fees paid +
  pending ≤ premium × bps). With the old rule restored the invariant fails in 7 calls.
- **Dry run re-run and recorded** (`keeper/DRYRUN.md`, new top section): cycle 3 fee 0.953962
  (was 204.407925), net 2043.125297, queued redeem 817.250118 USDG, claim 1225.875178. The
  harness now reads the policy back from the vault and checks every `Harvest` fee against the rule.
- **Docs and copy** brought in line: `ACCOUNTING.md` §6 (+ reconciliation for assigned weeks),
  `AUDIT-SCOPE.md` (+ property P-26), `SECURITY.md`, `README.md`, `TECHSPEC.md`, `plan.md`,
  `ops/safes.md`, `ops/runbooks/close-week.md`, `ops/publish-template.md`, site and web copy,
  indexer fixtures. **Caught on the way:** `ops/runbooks/incident.md`'s `setPolicy` tuple carried
  `1000`, so running the incident runbook as written would have silently restored a 10% fee.
- **Found, not fixed (pre-existing, now more visible):** web "Gross premium" / "Net" on
  `/vault/nvda` and `/activity`, `fmtRealizedWeek` and `usdgPerShare`, and the indexer's
  `premiumNet` sum `Harvest` amounts, which on an assigned week include strike proceeds, so
  returned principal is shown as realized yield. See W-21. The keeper alert has the same gap (K-21).
- Gates: forge 310/310, fork 21/21, `forge fmt --check`, keeper 66/66 + typecheck, indexer 11/11 +
  typecheck, web 48/48 + lint + typecheck + build, site lint + typecheck, copy-lint 0 violations.

### Session log — 2026-09-13

Done, each verified by a run rather than by a report:

- **Keeper dry run executed, then extended to three cycles** (K-19). Re-run by the main session on a
  fresh fork after the build and review agents: `DRY RUN PASSED`, fork block 61720714, 27.9 s. Cycle 3
  is the first time anything in this repo exercised an option on the **real** Valorem Clear: 9 of 23
  assigned, a queued redeem settled through the same close, every amount asserted exactly against
  chain state, receipts, the keeper database, its HTTP output and the captured alerts.
- **One keeper defect fixed** (K-20): a failed pre-close Valorem read was silently published as
  "0 assigned". Now "unknown" with a warning, plus 7 unit tests (keeper 66/66).
- **Audit scope written** (E-05, `docs/AUDIT-SCOPE.md`): in scope, out of scope with verified
  third-party audit links, properties to break, ranked concerns, evidence and its limits, build
  steps, severity scale. One accuracy and completeness round; every blocking/major finding fixed,
  the fixes spot-checked against the repo and chain 4663 (the USDG timelock is 24 h, the admin
  hand-over 3 h).
- **`ops/safes.md` §4 corrected**: its grep proof that no role reaches a token missed the fee leg,
  which became a raw `.call` in defect 12. Pattern, count (12 hits) and every line number re-derived.
- **Found, not yet acted on**: the protocol fee is charged on strike proceeds (open question 3), the
  alert and cycle tape call strike proceeds "harvested" (K-21), and seven places where our own docs
  contradict the code (D-05).
- **`keeper/DRYRUN.md` proofread** against the run artefacts (`report.md`, `run.json`, `keeper.db`
  in `keeper/dryrun-out/2026-09-13T05-49-32-373Z/`): every transaction hash, block, gas figure,
  amount, timestamp, address, alert payload (`delivered`, `contractsAssignedSource`/`FromClaim`
  0/0, 0/0, 9/9), Seaport counter, policy parameter and stub request matched. One error found and
  fixed: "the real validator's nine checks" → R3's 0–12 validation table (the 500 on a hash
  mismatch is check 7). The run's commit ref was added.
- `keeper/dryrun-out/` added to `.gitignore`. **The session's work is committed locally as
  `8ff8bef` (proofread fixes on top); not pushed — GitHub `main` is still `27d502a`.**
- **Frontend/backend wiring audited and documented** (user request): the web↔indexer link is
  sound (fixture contract green at both ends), and the two paths that carry no traffic are now
  written down in the new `docs/WIRING.md` (runtime hop map, env-var tables, proof status):
  web never reads the keeper's `/orders` (the W-13 fallback), and the indexer's HMAC relay has
  no caller (the keeper POSTs to Overcall directly). Fixes landed: `fetchHealth` pointed at
  Ponder-reserved `/health` → `/v1/health` with nested parsing; root `.env.example` dropped the
  unread `NEXT_PUBLIC_WALLETCONNECT_ID` and gained `NEXT_PUBLIC_RPC_URL_2` + `OVERCALL_API_BASE`;
  keeper `.env.example` gained `KEEPER_ENV_FILE` + `DRYRUN_SKIP_CYCLE3`; indexer `.env.example`
  gained `DATABASE_PRIVATE_URL`; `web/lib/abi/clear.ts`/`registry.ts` headers no longer claim to
  be generated (no generator exists — hand-maintained derivatives, per `web/README.md`). Stale
  facts corrected: `contracts/README.md` 328→307 tests; halt wording now "blocks `rollOpen` and
  `approveListing` only" in `contracts/README.md` and `docs/ARCHITECTURE.md` (verified against
  `Vault.sol:677,732`); `ops/README.md` testnet paragraph brought in line with the R7-R8
  refutation; root `README.md` cap 20–50→20. Gates: web 48/48 tests, lint, copy-lint, build all
  green. The `Vault.sol` NatSpec (L115, L995) stays with the D-05 audit batch.

### Next, in order

1. **You, GitHub UI** (L-01): leekzor → Settings → Billing → Actions spending limit, then set the
   `RH_RPC` secret. Until then no gate runs anywhere but locally.
2. **Legal, start now** (L-05): counsel on `site/app/terms` + `privacy`, operating-entity constants,
   a security.txt contact. Longest pole.
3. ~~Decide the fee-on-strike-proceeds question~~ **Done 2026-09-13:** 5% of premium only,
   implemented, tested, dry-run re-run, docs and copy aligned. Fix W-21 (assigned-week labels)
   before launch.
4. **Audit prep** (D-05 → E-05 → E-06): do the housekeeping list, pin a commit, send
   `docs/AUDIT-SCOPE.md`, engage the auditor.
5. **Finish the fork rehearsal** (E-03): indexer sync against a fork (X-11; the indexer already takes
   address overrides, runs on PGlite without `DATABASE_URL`, and `END_BLOCK` bounds a replay), then
   the web acceptance test from a fresh wallet including a fill from the keeper's `/orders` (W-13).
6. **Keeper follow-ups** (K-21, K-22): persist `assetsReturned` / `usdgFromAssignment` and word the
   assigned-week alert; cover `index.ts`, multi-exerciser assignment and guardian `rollClose`.
7. **Keys, then deploy** (L-02, L-03, L-06, L-07): Admin Safe 2/3, guardian key on separate hardware,
   mainnet deploy per `ops/deploy.md`, cap 20 NVDA.
8. **Hosting and alerting** (W-19, W-20, L-08, L-09): four Railway services, apex DNS, two uptime
   monitors, the `ALERT_WEBHOOK` relay.
9. **L-04**: one real 1-contract Overcall listing to settle EIP-1271 against their validator, then
   four published weeks (L-10..13).

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
- [x] K-19 Dry run executed and recorded (2026-09-13, `keeper/DRYRUN.md`). Three cycles on an anvil fork: (1) live series, filled, expired OTM, harvest claimed; (2) rolled while the keeper was asleep, adopted, unfilled, published 0; (3) **the keeper wrote and listed itself, the listing filled, the depositor queued 10 of 25 shares, the buyer exercised 9 of 23 on the real Valorem Clear**, `rollClose` emitted `RollClose(3, 14e18, 2025 USDG, 9)`, harvest 2044.079259 gross / 204.407925 fee / 1839.671334 net, `completeRedeem` paid 6.4 NVDA + 735.868533 USDG exactly, `claimUsdg` paid 1103.8028. Built by one implementer, attacked by an honesty auditor, a math reviewer and an independent runner, then re-run independently by the main session on a fresh fork
- [x] K-20 Assignment-count hardening, found by that review: `contractsAssignedAt` swallowed a failed Valorem read into `0n`, indistinguishable from a real zero. It now returns null and warns; `resolveContractsAssigned` publishes the `RollClose` count, falls back to the pre-read only without the event, and flags a mismatch; the `roll_close` alert carries `contractsAssignedSource`. 7 new unit tests (`roll.test.ts`, new `roll.close.test.ts`). The published number is unchanged whenever the vault emits `RollClose`, which the deployed bytecode always does
- [ ] K-21 Observability gap, not a wrong number: on an assigned week the `roll_close` alert and the cycle row call strike proceeds "harvested" (cycle 3 published 2044 USDG with no assignment wording), and `RollClose.assetsReturned` / `usdgFromAssignment` are decoded but not persisted, so `/cycles` cannot separate premium from returned principal. Needs two columns, alert wording and the `/cycles` shape
- [ ] K-22 Dry-run gaps still open: `index.ts` (poll loop, SIGTERM), multiple exercisers or exercise across several txs, the Valorem exercise-fee branch (fees are off on the live chain), guardian `rollClose`, cancel / partial fill / relist budget, and a non-default `DRYRUN_DEPOSIT` (cycle 3's index and dust expectations assume no carried `usdgDust`)

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
- [ ] W-21 Assigned-week labels overstate yield: `web/app/vault/nvda/page.tsx` "Gross premium" / "Net", `/activity` Gross and Net/TVL, `fmtRealizedWeek(netUsdg, tvl)` and `usdgPerShare(netUsdg, …)` sum `Harvest` amounts, which include strike proceeds on an assigned week; the indexer's `premiumNet`/`usdgPerShare` (`indexer/src/api/index.ts` ~L199–251, L448) do the same. Needs `settlement.assignmentUsdg` read into `web/lib/api.ts` and subtracted for premium figures. Disclosure accuracy, fix before launch
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
- [x] E-01 Full cycle on an anvil fork: deposit → open → fill → expire OTM → close → claim → queue redeem. Covered by the keeper dry run (K-19), with a mock registry and a mock feed seeded from the real ones
- [x] E-02 ITM variant with partial assignment: dry-run cycle 3, 9 of 23 exercised on the real clearinghouse (single exerciser, one tx; see K-22 for what that does not cover)
- [~] E-03 Two rehearsal weeks on a **mainnet fork with a mock registry** (the only way to time-warp a week into minutes). The keeper side is done (three weeks in K-19). Still missing: the indexer syncing the same fork (X-11) and the web app reading it (W-13)
- [ ] E-04 One full cycle on **testnet 46630** — real Valorem + Seaport, Overcall's NVDA registry once their operator sets a fresh cycle (or our own MockRegistry deployed there), mock-NVDA collateral, self-filled listing. Needs: testnet deploy config, a stand-in price feed (no Chainlink RHNVDA on 46630), funded key from the faucet. Covers everything except Overcall's production listings API
- [~] E-05 Audit scope doc: **drafted 2026-09-13 as `docs/AUDIT-SCOPE.md`**. Seven in-scope files (1,190 nSLOC) plus the deploy scripts for configuration review; out-of-scope dependencies with verified links (Zellic's Valorem reports, Seaport audits); 25 falsifiable properties and 6 money invariants to break; ranked areas of concern; prior evidence and what it does not prove; build instructions; severity scale. Checked once for accuracy and completeness, with every blocking/major finding fixed; the second check round did not run (usage limit) and the main session spot-checked the fixes. To finish: pin the engagement commit, then do the Appendix B housekeeping (below, D-05)
- [~] D-05 Housekeeping before the audit tag, from `docs/AUDIT-SCOPE.md` Appendix A/B. **Done
  2026-09-13:** `contracts/README.md` L117 and `docs/ARCHITECTURE.md` L124 now say halt blocks
  `rollOpen` **and** `approveListing`; `contracts/README.md` 328 → 307 tests (now 310); root README cap
  "20–50" → 20; `ops/README.md` testnet paragraph aligned with the R7-R8 refutation. **Remaining:**
  correct the `writesHalted` NatSpec (`Vault.sol` L115, and the halt function's NatSpec, shifted by
  the fee change); rewrite the `IValoremClear.sol` header (it names vendored files that do not
  exist); ~~fix `ACCOUNTING.md` §6~~ (resolved 2026-09-13: the code now matches it, 5% of premium
  only); `ops/addresses.json` has no `valoremLib` slot; `ACCOUNTING.md` §7 six
  invariants vs seven functions; re-derive line numbers in the scope doc and `ops/safes.md` §4 at
  the tag
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
3. ~~**Protocol fee on strike proceeds.**~~ **Settled 2026-09-13:** 5% of premium only; strike
   proceeds are fee-free (`Vault._accrueHarvest(feeFree)`), pinned by three unit tests and
   `invariant_feeNeverTouchesStrikeProceeds`. The old rule took 202.5 of dry-run cycle 3's 204.4
   USDG fee from returned principal.
4. **Deposit-time harvest cost.** Checkpointing the harvest on every deposit is correct but adds
   gas to the deposit path. Measure it on the first live week.

---

## Build constraints worth knowing before you touch the contracts

- **`Vault` has ~1.15 KB of headroom** under the EIP-170 24,576-byte runtime limit (23,426 B used
  since the 2026-09-13 fee change, which cost 284 B).
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
