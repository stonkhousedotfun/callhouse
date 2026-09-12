# Callhouse — Tasks & Progress

Companion to `plan.md`. One checkbox per task. Tick when done, add date + note.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (say by what)

Milestones: M0 scaffold+recon → M1 contracts on mocks → M2 contracts on fork → M3 keeper dry-run → M4 indexer+API → M5 web → M6 ops+testnet weeks → M7 launch wk0–1 → M8 wk2–4

---

## Phase 0 — Scaffold + recon (M0)

### Docs
- [x] P0-01 Read `README.md` + `TECHSPEC.md`, write `plan.md` + `tasks.md` (2026-09-12)
- [ ] P0-02 Strip chat artifacts: README last line; TECHSPEC first + last line
- [ ] P0-03 Fix TECHSPEC §4.4 garbled policy list using plan §4.4 reconstruction
- [ ] P0-04 Fix TECHSPEC `minOtmBps` ceiling row → floor 100 bps

### Repo
- [x] P0-05 Toolchain verified: forge 1.3.5, anvil 1.6.0, node 26.5, pnpm 9.10, git 2.50 (2026-09-12)
- [ ] P0-06 `git init`, `.gitignore`, `pnpm-workspace.yaml`, root `package.json`
- [ ] P0-07 `contracts/` foundry init, `foundry.toml` (solc 0.8.28, fork profile, via_ir off unless needed)
- [ ] P0-08 `forge install` OpenZeppelin 5, forge-std
- [ ] P0-09 `keeper/`, `indexer/`, `web/` empty packages that build
- [ ] P0-10 `.env.example` with all keys from plan §8
- [ ] P0-11 CI: forge test (unit), forge test --fork (fork, secret RPC), pnpm lint/build, copy-lint

### Recon (each writes into `ops/recon.md` + `ops/addresses.json`)
- [ ] R1 OvercallRegistry NVDA address + ABI: `cycle()`, `collateralToken()`, `exerciseToken()`, optionIds, exercise/expiry timestamps
- [ ] R2 Overcall reference order from `OrderFulfilled`: zone, conduitKey, orderType, fee recipient, salt, partial fills
- [ ] R3 Overcall listings API: URL, payload, auth, unknown-maker policy. Test POST. **Launch blocker if rejected**
- [ ] R4 Valorem Clear ABI on 4663: `write/redeem/claim/option/feesEnabled` exact names, token-id encoding, claim close rules for unsold 1155
- [ ] R5 Spot source on 4663: Chainlink NVDA/USD feed address or token oracle; `oraclePaused()`; heartbeat
- [ ] R6 Stock Token `uiMultiplier()` semantics, freeze/pause surface, transfer restrictions
- [ ] R7 Testnet 46630: Overcall registry present? Valorem + Seaport present?
- [ ] R8 Blockscout 4663 base URL + verify API
- [ ] R9 Seaport conduit: zero conduit vs Overcall conduit; controller address
- [ ] R10 Confirm all §2 addresses on explorer (Clear, Seaport, USDG, NVDA, Multicall3, fee key)
- [ ] R11 Pull + commit ABIs into `ops/abis/`

---

## Phase 1 — Contracts (M1 mocks, M2 fork)

### Interfaces + mocks
- [ ] C-01 `IValoremClear.sol` (bound to R4)
- [ ] C-02 `ISeaport.sol` (getOrderHash, validate, cancel, information, fulfill*)
- [ ] C-03 `IOvercallRegistry.sol` (bound to R1)
- [ ] C-04 `IStockToken.sol` (ERC-20 + uiMultiplier + oraclePaused)
- [ ] C-05 `IChainlinkFeed.sol`
- [ ] C-06 Mocks: MockClear, MockSeaport, MockRegistry, MockStockToken (multiplier + freeze), MockFeed (stale toggle)

### Core
- [ ] C-07 `Policy.sol`: PolicyParams struct, hard caps, floor minOtm 100, validate() pure lib
- [ ] C-08 `Vault.sol` state + constructor + AccessControl roles
- [ ] C-09 ERC-4626 deposit/mint (Idle + Listed), deposit cap
- [ ] C-10 Instant withdraw/redeem gated to Idle && contractsWritten == 0; `UseQueue()` revert
- [ ] C-11 `queueRedeem`, `completeRedeem`, `usdgReservedForQueue`, preview fns return queue path
- [ ] C-12 `totalAssets()` = idle + locked (from claim), USDG excluded
- [ ] C-13 Phase machine + `rollOpen` with all §4.4 checks
- [ ] C-14 `lockBook` after exerciseTimestamp
- [ ] C-15 `rollClose`: redeem claim → harvest → settle queue → Idle; guardian path after expiry+1h; idempotent
- [ ] C-16 `AdapterValorem`: approve, write, redeem, claim read, unsold 1155 close, contractsWritten/Sold/Remaining
- [ ] C-17 `AdapterSeaport`: `approveOrder(OrderComponents)` shape checks, hash, store, validate(), cancel previous, listingsThisCycle ≤ 3
- [ ] C-18 EIP-1271 `isValidSignature` on digest of listingHash
- [ ] C-19 `cancelListing` keeper + guardian
- [ ] C-20 `Distributor`: harvest, fee, accUsdgPerShare, claimUsdg, debt update on transfer/mint/burn
- [ ] C-21 `haltWrites` / `unhalt`; blocks rollOpen only
- [ ] C-22 `acceptValoremFee` admin; `feesEnabled` gate
- [ ] C-23 Admin setters inside hard caps; `setDepositCap`, `setKeeper`, `setFeeRecipient`
- [ ] C-24 All events from plan §4.10
- [ ] C-25 NatSpec on every external fn

### Tests — unit (mocks)
- [ ] T-01 Deposit / mint / instant redeem
- [ ] T-02 Queue redeem lifecycle
- [ ] T-03 Policy bounds + hard caps (test 14)
- [ ] T-04 Phase transitions + wrong-phase reverts
- [ ] T-05 Distributor math incl. transfer-mid-accrual
- [ ] T-06 Halt semantics (test 8)
- [ ] T-07 Listing count cap (test 11)

### Tests — fork 4663
- [ ] F-01 Deposit, instant redeem in Idle
- [ ] F-02 rollOpen writes exact contracts, claim NFT in vault
- [ ] F-03 Seaport fill ⇒ USDG += 95%
- [ ] F-04 Expiry OTM ⇒ full NVDA back
- [ ] F-05 Expiry ITM + exercise ⇒ NVDA down, USDG += strike × assigned
- [ ] F-06 Partial fill + partial assignment
- [ ] F-07 Queue during Listed; completeRedeem reverts until Settling done
- [ ] F-08 Halt blocks write, not redeem / claim / rollClose
- [ ] F-09 feesEnabled == true reverts write unless accepted
- [ ] F-10 Wrong optionId reverts
- [ ] F-11 Relist cancels previous hash; 4th listing reverts
- [ ] F-12 uiMultiplier change mid-cycle keeps share math
- [ ] F-13 Guardian rollClose after expiry+1h, keeper dead
- [ ] F-14 Admin cannot set minOtm < 100 / maxOtm > 2500

### Tests — invariant
- [ ] I-01 Asset: idle + locked + assignedOut == deposits − redemptions at every close
- [ ] I-02 USDG: distributed + fees + reservedForQueue + claimable == totalUsdgReceived

### Deploy
- [ ] D-01 `Deploy.s.sol` from `ops/addresses.json`
- [ ] D-02 `Configure.s.sol`: roles → Safe/keeper/guardian, launch policy, cap, renounce deployer
- [ ] D-03 Blockscout verify step
- [ ] D-04 Deploy to 46630 (if R7 yes) else anvil fork

---

## Phase 2 — Keeper (M3)

- [ ] K-01 Package: TS, viem, better-sqlite3, pino, dotenv; `config.ts` env schema (zod)
- [ ] K-02 Two-RPC client with failover
- [ ] K-03 `state.ts` SQLite: cycles handled, listings signed, tx hashes
- [ ] K-04 `roll.ts` state machine bound to `registry.cycle()`; 60s poll
- [ ] K-05 `policy.ts` strike picker + premium + contracts
- [ ] K-06 `seaport.ts` order builder copying R2 shape exactly
- [ ] K-07 `overcallApi.ts` POST client per R3; retry; fallback flag
- [ ] K-08 rollOpen → approveOrder → POST → verify visible (Overcall UI + our API)
- [ ] K-09 Hourly fill poll; relist once on cancel/invalid; max 3
- [ ] K-10 lockBook after exerciseTimestamp; no lists after
- [ ] K-11 rollClose after expiryTimestamp; confirm harvest + queue settled
- [ ] K-12 `health.ts` HTTP `/health`
- [ ] K-13 `alerts.ts` webhook: revert, API reject, listing invisible 15m, oracle paused, fees flip, low ETH
- [ ] K-14 Dry-run script: anvil fork + mock registry + time warp through a full cycle
- [ ] K-15 Dockerfile + systemd unit + restart-safe check
- [ ] K-16 Runbook stub for "keeper dead mid-week" (guardian close)

---

## Phase 3 — Indexer + API (M4)

- [ ] X-01 Ponder init, `ponder.config.ts` chain 4663 + fork/testnet
- [ ] X-02 `ponder.schema.ts`: vault_snapshots, cycles, users, listings
- [ ] X-03 Handlers: Vault events (all)
- [ ] X-04 Handlers: Valorem write/exercise/redeem filtered by vault
- [ ] X-05 Handlers: Seaport OrderFulfilled for listingHash → contractsSold, fill price
- [ ] X-06 Handlers: Stock Token Transfer in/out; oracle pause event if exists
- [ ] X-07 Handlers: Registry cycle updates
- [ ] X-08 Unfilled weeks written as cycle rows with 0
- [ ] X-09 API `GET /v1/vault`, `/v1/cycles`, `/v1/account/:addr`, `/health`; 15s cache
- [ ] X-10 `POST /v1/overcall/list` keeper-only HMAC → forwards to Overcall
- [ ] X-11 Sync against fork; assert tables match on-chain state

---

## Phase 4 — Web (M5)

- [ ] W-01 Next.js App Router + wagmi v2 + viem + TanStack Query; `defineChain(4663)`; wallet connect
- [ ] W-02 `lib/`: contracts ABI + addresses, API client, display math (raw vs NVDA-eq, PPS)
- [ ] W-03 `/` vault card
- [ ] W-04 `/vault/nvda`: approve → deposit; queue withdraw; complete redeem; claim USDG
- [ ] W-05 `/vault/nvda/cycle`: 5-rung ladder, our pick, order hash, explorer links, raw Seaport payload fallback fill
- [ ] W-06 `/activity`: every harvest incl. "unfilled, 0"
- [ ] W-07 `/docs`: shortened spec + risks list from plan §12
- [ ] W-08 `/legal`: US persons, Stock Token legal form, assignment, empty-book, geo
- [ ] W-09 Components: PhaseBadge, CycleTape, PositionSplit, UsdgClaim, TxToast, DepositForm, RedeemQueue
- [ ] W-10 Required disclosures rendered on `/vault/nvda`
- [ ] W-11 Copy-lint script: forbidden + required strings; wired to CI
- [ ] W-12 Mobile pass; no charts
- [ ] W-13 Acceptance test on fork from fresh wallet (plan §0)

---

## Phase 5 — Ops (M6)

- [ ] O-01 `ops/addresses.json` explorer-confirmed flags
- [ ] O-02 `ops/abis/` committed (from R11)
- [ ] O-03 `ops/runbooks/open-week.md`
- [ ] O-04 `ops/runbooks/close-week.md`
- [ ] O-05 `ops/runbooks/incident.md` (wrong strike, bad fill, over-assigned, keeper dead, issuer freeze)
- [ ] O-06 `ops/safes.md`: signers, 2/3 threshold, guardian key location
- [ ] O-07 Alert routing doc
- [ ] O-08 Weekly publish template (Friday/Saturday result, incl. unfilled 0)

---

## Phase 6 — E2E, testnet, audit (M6)

- [ ] E-01 Full cycle on anvil fork: deposit → open → fill → expire OTM → close → claim → queue redeem
- [ ] E-02 Full cycle ITM variant with partial assignment
- [ ] E-03 Testnet 46630 week 1 (or fork + mock registry if R7 no)
- [ ] E-04 Testnet week 2
- [ ] E-05 Audit scope doc: Vault + adapters + Distributor; link Zellic Valorem reports, do not re-audit Valorem
- [ ] E-06 Audit engaged; findings triaged; fixes merged
- [ ] E-07 Bug bounty page drafted (opens mainnet week 2)

---

## Phase 7 — Launch (M7, M8)

### Week 0
- [ ] L-01 Fork tests + invariants green in CI
- [ ] L-02 Admin Safe 2/3 deployed on 4663
- [ ] L-03 Guardian key provisioned, different continent
- [ ] L-04 Overcall API handshake done (R3 closed)
- [ ] L-05 Docs + legal live
- [ ] L-06 Mainnet deploy + verify; roles configured; deployer renounced

### Week 1
- [ ] L-07 Vault live, cap 20 NVDA, keeper = us, fee → Safe
- [ ] L-08 First cycle run; result published (filled or "unfilled, 0")

### Weeks 2–4
- [ ] L-09 Publish week 2 result; open bug bounty
- [ ] L-10 Publish week 3 result
- [ ] L-11 Publish week 4 result; raise cap
- [ ] L-12 Decide PFE / SCHD second deploy (v1.1) — same bytecode

---

## Blockers

| ID | Blocked task(s) | Blocked by | Owner | Since |
|---|---|---|---|---|
| — | — | — | — | — |

---

## Progress log

| Date | Note |
|---|---|
| 2026-09-12 | Consumed README + TECHSPEC. Wrote plan.md + tasks.md. Toolchain verified. Repo not yet git-initialized. Next: P0-02..P0-11, then recon R1–R11. |
