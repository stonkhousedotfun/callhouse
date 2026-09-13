# Callhouse — End-to-End Build Plan

Source of truth: `README.md` + `TECHSPEC.md`. This plan turns those two docs into a buildable sequence. Progress lives in `tasks.md`.

Product in one line: pooled covered-call vault for Robinhood Chain Stock Tokens. Deposit NVDA, get `cNVDA`. Weekly keeper writes an Overcall call on Valorem, lists it on Seaport for USDG, harvests filled premium, pays depositors USDG. No protocol token. No APY on the site.

---

## 0. Scope, non-goals, acceptance

### In scope (v1)
- One vault, one asset: NVDA Stock Token ↔ USDG.
- ERC-4626-style shares with queued redeem while a call is open.
- Weekly phase machine `Idle → Listed → Exercisable → Settling → Idle`.
- Valorem Clear write / redeem adapter. Seaport 1.6 listing with vault as offerer (EIP-1271).
- 10% protocol fee on harvested USDG, filled weeks only. `accUsdgPerShare` distribution.
- Keeper (Node 22) that binds to `registry.cycle()`, picks strike, signs, POSTs to Overcall listings API, closes, harvests.
- Ponder indexer + small read API.
- Next.js frontend: deposit, queue withdraw, claim USDG, cycle tape, activity, docs, legal.
- Ops: runbooks, ABIs, Safe addresses, `.env.example`.

### Out of scope (v2, do not build)
- Auto-rebuy after assignment. Pare y-leg deposit asset. Protocol token / buyback. Multi-strike ladder. Cross-vault router. US persons / KYC wrapper. Options AMM or order book. Proxy / upgradeability.

### Acceptance test ("the entire app")
A stranger can:
1. Deposit 1 NVDA and receive `cNVDA`.
2. See this week's strike and Seaport listing hash.
3. After Saturday expiry, claim USDG, or see "unfilled, 0".
4. Queue a redeem and receive leftover NVDA (+ USDG if assigned).

Nothing else is required for v1.

---

## 1. Resolved discrepancies and spec repairs

Both docs were consumed. Where they differ or are broken, this is the decision:

| Topic | README | TECHSPEC | Decision |
|---|---|---|---|
| Share ticker | `cNVDA` | "$NVDAy vault" (working) | `cNVDA`. Vault name "Callhouse NVDA". |
| Seaport adapter job | EIP-1271 listings, cancel, order hash | "EIP-712 hash + conduit approvals" in layout; §4.7 says EIP-1271, vault is offerer | Vault is offerer. EIP-1271 `isValidSignature`. Keeper never holds the 1155. |
| Indexer | Ponder | "Ponder (or Envio)" | Ponder. |
| §4.4 policy check list | — | Markdown ate `<`/`>=` characters | Reconstructed in §4.4 below. |
| `minOtmBps` "contract ceiling 0" | — | Listed as 0, but §10 says "Admin sets minOtmBps = 0 and sells ATM — cap it" | Contract enforces a **floor** `MIN_OTM_FLOOR_BPS = 100`. Admin cannot go below. |
| Valorem redeem fn name | — | "redeem / reclaim — bind to ABI" | Bind to deployed ABI in Phase 0. Expected: `write(uint256,uint112) returns (uint256 claimId)`, `redeem(uint256 claimId)`, `option(uint256)`, `claim(uint256)`, `feesEnabled()`. |
| Trailing chat artifacts | Last line of README ("Save that as README.md…") | First + last line of TECHSPEC ("I'll pull the live…", "If you want this turned into…") | Strip in Phase 0. |

---

## 2. Architecture

```
User ──ERC-20 NVDA──► Vault (cNVDA shares)
                         │ approve + clear.write(optionId, n)
                         ▼
             ValoremOptionsClearinghouse  0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
                         │ n option ERC-1155 + 1 claim NFT → vault
                         ▼
             Seaport 1.6                  0x0000000000000068F116a894984e2DB1123eB395
                         │ vault = offerer, EIP-1271 sig, keeper POSTs JSON to Overcall API
                         ▼
             Buyer fills: USDG 95% → vault, 5% → Overcall fee recipient
                         │ Saturday 20:00 UTC expiry → clear.redeem(claimKey)
                         ▼
             idle NVDA + USDG ──► 90% accUsdgPerShare, 10% fee Safe
```

Invariants that never bend:
- Settlement never reads a price feed. Chainlink / token oracle is display + write-gate only.
- Short call is never marked to market. PPS moves only when USDG arrives or NVDA is assigned away.
- Internal math uses raw `balanceOf`. `uiMultiplier()` is display only. Never rebase.
- Lot size 1e18 per contract. USDG 6 decimals. Strike `S` ⇒ `exerciseAmount = S * 1e6`.
- Pause / halt blocks `rollOpen` only. Never blocks `queueRedeem`, `claimUsdg`, `rollClose`, idle withdrawals.
- No user approvals to the keeper. Only to Vault.

---

## 3. Monorepo layout

```
callhouse/
  package.json              pnpm workspaces: keeper, indexer, web
  pnpm-workspace.yaml
  .env.example
  contracts/                Foundry, Solidity 0.8.28, OZ 5
    foundry.toml
    src/
      Vault.sol
      Policy.sol
      AdapterValorem.sol
      AdapterSeaport.sol
      Distributor.sol
      interfaces/  IValoremClear.sol ISeaport.sol IOvercallRegistry.sol IStockToken.sol IChainlinkFeed.sol
      mocks/       MockClear.sol MockSeaport.sol MockRegistry.sol MockStockToken.sol MockFeed.sol
    test/          unit/  fork/  invariant/
    script/        Deploy.s.sol  Configure.s.sol
  keeper/                   Node 22 + TS + viem
    src/  index.ts roll.ts policy.ts seaport.ts overcallApi.ts health.ts state.ts alerts.ts config.ts
  indexer/                  Ponder
    ponder.config.ts ponder.schema.ts src/  api/
  web/                      Next.js App Router + wagmi/viem
    app/  components/  lib/
  ops/
    runbooks/  abis/  addresses.json  safes.md
```

---

## 4. Contracts (Phase 1)

### 4.1 Roles (OZ `AccessControl`)
| Role | Holder | Powers |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | 2/3 Safe | set keeper, fee recipient, policy inside hard caps, `acceptValoremFee`, unhalt |
| `KEEPER_ROLE` | hot wallet + backup | `rollOpen`, `approveOrder`, `cancelListing`, `lockBook`, `rollClose`, `harvest` |
| `GUARDIAN_ROLE` | 1/1 hardware key | `haltWrites`, `cancelListing`, `rollClose` after `expiry + 1h` |
| fee recipient | Safe | receives 10% USDG |

No proxy. Bug fix = Vault v2 + migrate.

### 4.2 Vault state
```solidity
IERC20 immutable asset; IERC20 immutable usdg;
IValoremClear immutable clear; ISeaport immutable seaport; IOvercallRegistry immutable registry;
enum Phase { Idle, Listed, Exercisable, Settling }
Phase phase; uint32 cycleNumber;
uint256 optionId; uint256 contractsWritten; uint256 contractsSold; uint256 claimKey;
bytes32 listingHash; uint8 listingsThisCycle;
uint256 queuedShares; uint256 queuedAssetsSnapshot;
uint256 accUsdgPerShare; mapping(address => uint256) usdgDebt;
uint256 usdgReservedForQueue;
bool halted; bool valoremFeeAccepted;
PolicyParams policy;   // minOtmBps, maxOtmBps, minPremiumBps, maxUtilizationBps, protocolFeeBps, maxContractsCap
```

`totalAssets()` = idle NVDA + locked NVDA (from `clear.claim(claimKey)` remaining) . USDG is tracked separately via `accUsdgPerShare`, not folded into share price. Unsold option inventory valued at 0.

### 4.3 ERC-4626 deviations
- `deposit` / `mint`: allowed in `Idle` and `Listed`. Goes to idle. Not added to this week's short.
- `withdraw` / `redeem`: instant only when `phase == Idle && contractsWritten == 0`. Otherwise revert with `UseQueue()`.
- `queueRedeem(shares)`: locks shares, adds to `queuedShares`. Any phase.
- `completeRedeem()`: after `rollClose` settles, pays pro-rata idle NVDA + USDG. Assigned weeks pay a mix. Never a 1:1 promise.
- `previewWithdraw` / `previewRedeem`: return 0 / revert outside the instant path. Never fake instant amounts.
- Deposit cap: `maxDeposit` enforces `depositCap` (20–50 NVDA at launch, admin-settable).

### 4.4 Policy checks (reconstructed from garbled §4.4)
`rollOpen(optionId, contracts)` reverts unless all hold:
```
phase == Idle && !halted
cycle = registry.cycle(); optionId ∈ cycle.optionIds
registry.collateralToken() == asset && registry.exerciseToken() == usdg
block.timestamp < cycle.exerciseTimestamp
!asset.oraclePaused()                                  // if the token exposes it
!clear.feesEnabled() || valoremFeeAccepted
strike = clear.option(optionId).exerciseAmount
spot   = feed.latestRoundData() (heartbeat fresh)      // gate only
strike >= spot * (10_000 + minOtmBps) / 10_000
strike <= spot * (10_000 + maxOtmBps) / 10_000
contracts * 1e18 <= idle * maxUtilizationBps / 10_000
contracts <= maxContractsCap && contracts > 0
```
`approveOrder(OrderComponents calldata o)` reverts unless:
```
phase == Listed && listingsThisCycle < 3
o.offerer == address(this)
o.offer.length == 1, itemType ERC1155, token == clear, identifier == optionId, amount <= contractsWritten - contractsSold
o.consideration[0]: USDG → vault, amount == 95% of gross
o.consideration[1]: USDG → OVERCALL_FEE_RECIPIENT, amount == 5% of gross
gross >= minPremiumBps * spot * o.offer[0].amount / 10_000   (USDG 6-dec scaled)
o.endTime <= cycle.exerciseTimestamp
o.zone / conduitKey == configured Overcall values
```
On pass: cancel previous `listingHash` via `seaport.cancel`, store new hash, `seaport.validate([order])`, `listingsThisCycle++`.

Hard caps in bytecode:
| Param | Launch | Hard cap |
|---|---|---|
| minOtmBps | 300 | floor 100 |
| maxOtmBps | 1200 | ceil 2500 |
| minPremiumBps | 40 | floor 10 |
| maxUtilizationBps | 9500 | ceil 10000 |
| protocolFeeBps | 1000 | ceil 2000 |
| maxContractsCap | 50 | per deploy |
| maxListingsPerCycle | 3 | const |

### 4.5 Phase machine
```
Idle        rollOpen()            → Listed      (write on Valorem)
Listed      approveOrder / cancelListing / (external fill)
            lockBook()  after exerciseTimestamp   → Exercisable
Exercisable rollClose() after expiryTimestamp    → Settling
Settling    clear.redeem(claimKey); harvest(); settleQueue(); → Idle
```
`rollOpen` / `rollClose` idempotent and permissioned. Guardian may `rollClose` after `expiryTimestamp + 1 hours`. Anyone-callable `rollClose` after `+24h` is a stretch option; decide at review.

### 4.6 AdapterValorem (internal library or abstract base)
- `asset.approve(clear, contracts * 1e18)`, `claimKey = clear.write(optionId, uint112(contracts))`.
- `clear.setApprovalForAll(seaportConduit, true)` once in constructor.
- After expiry: `clear.redeem(claimKey)`. Accept `0..contracts` assigned. Read `clear.claim(claimKey)` for `amountWritten / amountExercised`.
- Unsold 1155 still in vault: redeem/burn per Valorem rules so the claim closes. Bind to ABI.
- Track `contractsWritten`, `contractsSold` (1155 leaving vault via `OrderFulfilled`, or `balanceOf` delta at close), `contractsRemaining`.

### 4.7 AdapterSeaport
- `isValidSignature(bytes32 digest, bytes)`: return magic value iff `digest == approvedDigest` where `approvedDigest = keccak256("\x19\x01" ‖ seaport.domainSeparator ‖ listingHash)`. Empty signature bytes accepted.
- Also call `seaport.validate()` so fills with empty signature work regardless of the 1271 path.
- `cancelListing()`: `seaport.cancel([components])`. Never two live orders on the same 1155 amount.
- Store `OrderComponents` for the live listing so cancel can rebuild it.

### 4.8 Distributor
```
harvest():
  gross = usdg.balanceOf(this) - usdgReservedForQueue - alreadyDistributed
  fee   = gross * protocolFeeBps / 10_000      (0 if gross == 0)
  net   = gross - fee
  usdg.transfer(feeRecipient, fee)
  accUsdgPerShare += net * 1e18 / totalSupply
claimUsdg(): standard debt-per-share pattern. Update debt on every share transfer / mint / burn.
```
Emit `Harvest(cycle, gross, fee, net, fillPriceUsdg, contractsAssigned)`.

### 4.9 Halt
`haltWrites()` guardian/admin. Blocks `rollOpen` only. `unhalt()` admin only.

### 4.10 Events
`Deposit, Withdraw` (4626), `QueueRedeem(user, shares)`, `CompleteRedeem(user, nvda, usdg)`, `RollOpen(cycle, optionId, contracts, claimKey)`, `ListingApproved(cycle, orderHash, amount, grossUsdg)`, `ListingCancelled(orderHash)`, `LockBook(cycle)`, `RollClose(cycle, nvdaBack, usdgIn, assigned)`, `Harvest(...)`, `ClaimUsdg(user, amount)`, `Halt(bool)`, `PolicyUpdated(...)`, `ValoremFeeAccepted(bool)`.

### 4.11 Tests
Unit (mocks) + fork (4663, `--fork-url $RH_RPC`) + invariant.

Fork tests that must stay green (README + TECHSPEC union):
1. Deposit, instant redeem in Idle.
2. `rollOpen` writes exact contracts, claim NFT held by vault.
3. Simulated Seaport fill ⇒ vault USDG += 95% of gross.
4. Expiry OTM ⇒ full NVDA back.
5. Expiry ITM + exercise ⇒ NVDA down, USDG up by `strike * assigned`.
6. Partial fill + partial assignment.
7. Queue during Listed; `completeRedeem` reverts until Settling done.
8. Halt blocks write, not redeem / claim / rollClose.
9. `feesEnabled == true` reverts write unless accepted.
10. Wrong `optionId` reverts.
11. Relist cancels previous hash; 4th listing reverts.
12. `uiMultiplier` change mid-cycle does not break share math.
13. Guardian `rollClose` after `expiry + 1h`, keeper dead.
14. Admin cannot set `minOtmBps < 100` or `maxOtmBps > 2500`.

Invariant: `idle + locked + assignedOut == deposits − redemptions` for the asset at every close. USDG: `distributed + fees + reservedForQueue + claimable == totalUsdgReceived`.

### 4.12 Deploy
`Deploy.s.sol`: constructor args from `ops/addresses.json`. Verify on Blockscout 4663. `Configure.s.sol`: grant roles to Safe / keeper / guardian, set launch policy, set deposit cap, renounce deployer.

---

## 5. Keeper (Phase 2)

Single Node 22 + TypeScript + viem process. One vault per process. Persist state (last cycle handled, listings signed, tx hashes) in SQLite via `better-sqlite3`.

### 5.1 Loop
Poll every 60s. Decisions bind to `registry.cycle()`, never the wall clock.

| Trigger | Action |
|---|---|
| `cycle.status == Open` and vault `Idle` | pick strike → `rollOpen` → build order → `approveOrder` → POST Overcall API → verify visible |
| Hourly while `Listed` | poll `OrderFulfilled`; if filled stop; if cancelled/invalid relist once (max 3 total) |
| `now >= exerciseTimestamp` | no new lists; `lockBook` |
| `now >= expiryTimestamp` | `rollClose` (contains redeem + harvest + settle queue) |
| Sun–Thu 12:00 UTC | health ping only |
| Any | retry with backoff; alert on any revert |

### 5.2 Strike picker (`policy.ts`)
```
spot     = feed.latestRoundData()       // gate + display
rungs    = cycle.optionIds → clear.option(id).exerciseAmount
eligible = rungs where spot*(1+minOtm) <= strike <= spot*(1+maxOtm)
pick     = nearest OTM (eligible[0] ascending)
premium  = max(minPremiumBps * spot / 10_000, lastFill * 1.00)
contracts = floor(idle * utilization / 1e18), capped by maxContractsCap
if eligible empty → skip week, log "no rung", stay Idle
```

### 5.3 Seaport order builder (`seaport.ts`)
Copy Overcall's live order shape byte-for-byte: `zone`, `conduitKey`, `orderType`, `salt` style, consideration order, fee recipient. Captured in Phase 0 from a filled reference order. Never invent a second shape.

### 5.4 Overcall API client (`overcallApi.ts`)
Reverse `POST /api/orders` from Overcall web app (`web/src/app/api/orders`). Persist required fields: `chainId, order, signature, optionId, maker`. Signature for a 1271 offerer = any bytes the vault accepts (empty or keeper sig). If they reject unknown makers ⇒ **launch blocker**, needs handshake.

Fallback: publish Seaport payload on `/vault/nvda/cycle` so a buyer can fill from our UI.

### 5.5 Health + alerts
`GET /health` → last beat, RPC lag, phase, cycle. Alerts (Telegram/Discord webhook) on: revert, API reject, listing not visible after 15 min, oracle paused, `feesEnabled` flip, keeper ETH < 0.01.

### 5.6 Keys
Keeper hot key: gas + `KEEPER_ROLE` only, ~0.05 ETH. Safe 2/3 admin. Guardian 1/1 on a different continent. Two RPC providers.

---

## 6. Indexer + API (Phase 3)

Ponder, Postgres.

Listen: Vault (all events above), Valorem `write/exercise/redeem` filtered by vault, Seaport `OrderFulfilled` where `orderHash == listingHash`, Stock Token `Transfer` in/out of vault (+ oracle pause event if any), Registry cycle updates.

Tables:
```
vault_snapshots(ts, idle_nvda, locked_nvda, usdg, shares, phase, ui_multiplier)
cycles(cycle, option_id, strike, contracts, listed_at, order_hash, filled_at, premium_gross, premium_net, fee, assigned, tx_open, tx_close, status)
users(addr, shares, claimable_usdg, queued_shares)
listings(cycle, seq, order_hash, price, status, tx)
```

API (Ponder `api/` or thin Hono):
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/vault` | TVL, phase, this week |
| GET | `/v1/cycles` | history incl. unfilled 0 weeks |
| GET | `/v1/account/:addr` | shares, claimable, queue |
| POST | `/v1/overcall/list` | keeper-only HMAC, forwards to Overcall |
| GET | `/health` | keeper beat, RPC lag |

Public routes cached 15s.

---

## 7. Frontend (Phase 4)

Next.js App Router, wagmi v2 + viem, TanStack Query. Chain 4663 via `defineChain`. Wallet connect via RainbowKit (or ConnectKit; pick one, no debate).

Pages:
| Route | Content |
|---|---|
| `/` | one vault card: ticker, idle + locked, this week strike, listed / filled / unfilled / assigned, last week USDG/share |
| `/vault/nvda` | deposit, queue withdraw, complete redeem, claim USDG |
| `/vault/nvda/cycle` | 5-rung Overcall ladder, our pick, order hash, explorer links, raw Seaport payload fallback |
| `/activity` | every harvest incl. unfilled 0 |
| `/docs` | shortened spec + risks |
| `/legal` | not for US persons, Stock Token restrictions |

Components: `PhaseBadge`, `CycleTape` (countdown from registry timestamps), `PositionSplit` (idle / listed / assigned), `UsdgClaim`, `TxToast` (Blockscout links), `DepositForm`, `RedeemQueue`.

Deposit flow: Connect → switch to 4663 → approve NVDA → deposit. Show raw + `uiMultiplier`-adjusted "NVDA-eq".

Display math: `PPS = (idle + locked) / shares` raw. Headline this week: `net USDG / TVL USD at harvest`. Never annualize on page.

Copy rules enforced by a lint script over `web/`:
- Forbidden strings: `APY`, `10% weekly`, `projected`, `backed by Nvidia`, `dividend paid by Nvidia`.
- Required strings present on `/vault/nvda`: "Premium is paid only if a buyer fills", "Assignment can take your tokens at the strike", "Stock Tokens are debt securities", "Last week realized".

No token chart. No candlesticks.

---

## 8. Ops (Phase 5)

- `ops/addresses.json`: every address from §2 plus registry, conduit, zone, fee recipient, feed, Safe, guardian. Explorer-confirmed flag per entry.
- `ops/abis/`: Valorem Clear, Seaport 1.6, Registry, Stock Token, USDG, Vault.
- `ops/runbooks/open-week.md`, `close-week.md`, `incident.md` (from TECHSPEC §11).
- `ops/safes.md`: signers, thresholds, guardian location.
- `.env.example`: `RH_RPC, RH_RPC_2, KEEPER_PK, VAULT, REGISTRY, SEAPORT, CLEARINGHOUSE, OVERCALL_ORDERS_URL, SAFE_FEE, FEED, DATABASE_URL, ALERT_WEBHOOK`.

---

## 9. Phase 0 recon — unknowns that block later phases

Every item below is unknown from the docs and must be resolved before the dependent phase starts.

| # | Unknown | Blocks | How |
|---|---|---|---|
| R1 | OvercallRegistry (NVDA) address + ABI (`cycle()`, `collateralToken()`, `exerciseToken()`, `optionIds`, timestamps) | contracts, keeper | Overcall docs / explorer / their web app source |
| R2 | Overcall Seaport order shape: `zone`, `conduitKey`, `orderType`, fee recipient, salt style, partial fills allowed? | AdapterSeaport, keeper | pull a filled reference order from `OrderFulfilled` logs |
| R3 | Overcall listings API: URL, payload, auth, unknown-maker policy | keeper, launch | read `web/src/app/api/orders`; test POST from a throwaway maker |
| R4 | Valorem Clear ABI on 4663: exact `write / redeem / claim / option / feesEnabled` names + token-id encoding | AdapterValorem | explorer verified source; compare to Zellic-audited `OptionSettlementEngine` |
| R5 | Spot source: Chainlink NVDA/USD feed address on 4663, or Stock Token internal oracle; `oraclePaused()` existence + heartbeat | policy gate | Stock Token verified source, Chainlink 4663 feed list |
| R6 | Stock Token `uiMultiplier()` (ERC-8056) semantics + freeze/pause surface | Vault, UI | verified source |
| R7 | Testnet 46630: does Overcall registry exist there? | keeper dry-run | explorer |
| R8 | Blockscout 4663 URL + verify API | deploy, UI links | explorer |
| R9 | Seaport 1.6 conduit controller + whether Overcall uses the zero conduit | approvals | reference order |

Toolchain present locally: forge 1.3.5, anvil 1.6.0, node 26.5, pnpm 9.10, git 2.50.

---

## 10. Build sequence and milestones

Order is chosen so each phase has real inputs from the previous one. Contracts before keeper before UI, because the keeper needs the ABI and the UI needs both the ABI and the indexer.

| Milestone | Phase | Exit criteria |
|---|---|---|
| M0 Scaffold + recon | 0 | Monorepo compiles empty. R1–R9 answered in `ops/addresses.json` + `ops/recon.md`. Docs stripped of chat artifacts. `.env.example` exists. |
| M1 Contracts green on mocks | 1a | Vault, Policy, adapters, Distributor compile. Unit tests pass. |
| M2 Contracts green on fork | 1b | All 14 fork tests + invariants pass against 4663 fork with real Valorem + Seaport. Deploy script dry-runs. |
| M3 Keeper dry-run | 2 | Keeper runs a full `Idle → Listed → Exercisable → Settling → Idle` cycle on anvil fork with mock registry time-warp. Order POST accepted by Overcall (or fallback documented). |
| M4 Indexer + API | 3 | Ponder syncs fork events. `/v1/vault`, `/v1/cycles`, `/v1/account` return correct data. |
| M5 Web | 4 | Acceptance test passes end-to-end on fork from a fresh wallet. Copy lint passes. |
| M6 Ops + testnet weeks | 5–6 | Runbooks written. Two live weeks on 46630 (or fork + mock registry). Audit scope handed off. |
| M7 Launch week 0–1 | 7 | Safe deployed, docs live, Overcall handshake done, vault live with 20 NVDA cap, keeper = us. |
| M8 Weeks 2–4 | 7 | Four published Friday results incl. any "unfilled, 0". Raise cap. Bug bounty opens week 2. |

---

## 11. Key design decisions (locked)

1. Vault is the Seaport offerer. Keeper never custodies the 1155. EIP-1271 + `seaport.validate()` both.
2. `approveOrder` takes full `OrderComponents`, validates shape on-chain, computes hash via `seaport.getOrderHash`. Keeper cannot list at a price the policy rejects.
3. USDG is not folded into share price. Separate `accUsdgPerShare`. Share price = NVDA only.
4. Queued redeem snapshots shares, not assets. Payout computed at settle.
5. `minOtmBps` has an on-chain floor of 100 bps. Admin cannot sell ATM.
6. No proxy. No upgrade path but v2 + migrate.
7. Keeper state in SQLite, not memory. Restart-safe.
8. Every unfilled week is published as a row with 0. UI and indexer treat it as a first-class cycle.
9. Copy rules are enforced by CI lint, not by memory.
10. Two RPC providers in keeper and web.

---

## 12. Risks carried into build

| Risk | Mitigation in this plan |
|---|---|
| No buyer (economic) | Fallback fill page on `/vault/nvda/cycle`; publish 0 weeks honestly |
| Overcall API rejects unknown maker | R3 in Phase 0; launch blocker, not polish |
| Issuer freeze bricks write/settle | Disclosed on `/legal` + `/docs`; keeper alerts on transfer failure; cannot code around |
| Valorem fee switch | `feesEnabled` gate + explicit `acceptValoremFee` |
| Partial assignment lottery | Adapter accepts `0..n`; queue payout mixes NVDA + USDG |
| Fees stacked 5% + 10% | Shown in `/docs`; fee only on filled weeks |
| Admin misconfig | Hard caps in bytecode; test 14 |
| Keeper dies mid-week | Guardian `rollClose` after `expiry + 1h`; documented |
| Sequencer / API down Friday | Retry with backoff; do not write if cannot list; Overcall exercise window is 24h |
| Unaudited Vault | Do not mainnet without audit of this repo's code; bounty after week 2 |

---

## 13. Definition of done (v1)

- All 14 fork tests + 2 invariants green in CI on every push.
- Keeper completes one full cycle unattended on fork and one on testnet.
- Indexer + web pass the §0 acceptance test from a fresh wallet.
- Copy lint green. `/legal` and `/docs` risks published.
- `ops/` runbooks and addresses explorer-confirmed.
- Audit engaged with this repo's Vault + adapters as scope.
- Launch week 0 checklist complete.

---

## 14. Recon results and the spec repairs they forced (2026-09-12)

Phase 0 recon ran against live chain 4663. Nine unknowns, each investigated then adversarially
re-verified. Everything below is confirmed by an `eth_call` or an `eth_getCode` that was actually
executed, not inferred. Full evidence in `ops/recon/`.

### 14.1 What was found

| Unknown | Answer |
|---|---|
| R1 OvercallRegistry (NVDA) | **`0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`**, verified source, not a proxy |
| R2/R9 Seaport order shape | zone `0x0`, zoneHash `0x0`, conduitKey `0x0`, orderType `1` (PARTIAL_OPEN), startTime `0`, endTime = exerciseTimestamp, fee recipient `0xdAe7e82A…0782` |
| R3 Overcall listings API | `POST https://overcall.finance/api/orders?market=NVDA`. No auth, no allowlist, ERC-1271 offerers explicitly accepted. **Not a launch blocker.** |
| R4 Valorem Clear | Exact upstream `ValoremOptionsClearinghouse`, valorem-core @`6436c823`, solc 0.8.16. Bytecode-identical outside the metadata trailer. |
| R5 Spot feed | Chainlink `RHNVDA / USD` at `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`, 8 decimals |
| R6 Stock Token | 18 decimals, non-rebasing, live `uiMultiplier()` (observed 1.000775…), `oraclePaused()` present |
| R7 Testnet 46630 | **Usable after all.** The first pass found no Valorem/Overcall/NVDA and an older Stock build; the adversarial re-check refuted that — Valorem Clear is at `0x0059df7c…acbc` (byte-identical), ten Overcall registries exist (NVDA `0xdFA1cab9…4A56`, with `isWritingOpen`), mock NVDA implements `oraclePaused()`, and mock USDG self-mints. Cycles are hand-set by Overcall's operator and lapse between rehearsals. Full evidence in `ops/recon/R7-R8-testnet-explorer.md` (both passes) |
| R8 Explorer | Blockscout sits behind a Cloudflare challenge; its API is not reliably scriptable |
| R10 Address audit | All six README addresses confirmed. `0xdAe7e82A…0782` is an EOA and really is Valorem's `feeTo` |
| R12 Overcall surface | One contract type, `OvercallRegistry`, deployed once per market. 11 live markets. No zone, no conduit, no periphery, no proxy |

Live NVDA cycle at recon time: cycle 1, lot size 1e18, five rungs at 226 / 231 / 236 / 241 / 246
USDG, book close Fri 2026-09-18 20:00 UTC, expiry Sat 2026-09-19 20:00 UTC. `MAX_STRIKES` is 5 and
`MIN_EXERCISE_WINDOW` is 24h, so the observed 24h window is the registry's minimum.

### 14.2 Spec repairs

1. **The cycle has no status field.** TECHSPEC assumed `registry.cycle().status`. It does not exist.
   The real gates are `isWritingOpen()`, `isCycleLive()`, `writeDeadline()` (which IS
   `exerciseTimestamp`) and `canReplaceCycle()`. Every trigger binds to those.
2. **Overcall rounds its 5% fee PER CONTRACT, not on the total.** Rounding on the total yields an
   order that signs and validates and then cannot be partially filled (`InexactFraction`). Since
   every Overcall order is `PARTIAL_OPEN`, that silently makes a listing full-fill-only.
   `Policy.splitPremium` implements the per-contract rule and the vault enforces it on chain.
3. **The listings API body is `{chainId, components, signature}`**, not the
   `{chainId, order, signature, optionId, maker}` TECHSPEC guessed. The signature field must be
   64 or 65 bytes, which is why the keeper sends a well-formed placeholder and the vault answers
   by hash through EIP-1271.
4. **There is one registry per market, and the frontend's top-level `registry` key is JUGGERNAUT,
   not NVDA.** Wiring it would collateralise NVDA calls against the wrong token. The vault
   constructor now refuses any registry whose `collateralToken`/`exerciseToken`/`clearinghouse`
   do not match, and a fork test asserts the trap explicitly.
5. **Testnet 46630 was mis-scoped at first, then re-verified as usable.** The initial pass searched
   the testnet explorer by contract *name*, which misses unverified contracts, and reported no
   Valorem and no Overcall. The adversarial re-check found both: Valorem Clear at
   `0x0059df7c6229373a5afc0685b0ee8777f59bacbc` (byte-identical to mainnet), ten Overcall
   registries including NVDA `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56` (the new build, with
   `isWritingOpen()`), a mock NVDA that implements `oraclePaused()`, and mock USDG with a
   permissionless mint. M6 is therefore: two time-warped weeks on a mainnet fork with a mock
   registry (the only place to compress a week into minutes), **plus** a real testnet cycle on
   46630 once Overcall's operator sets a fresh one — or against our own mock registry deployed
   there, which needs no one's cooperation. The only leg testnet can never cover is Overcall's
   production listings API, which is mainnet-only.
6. **The price feed stops at the weekend.** It is a `us_equities_24/5` feed: observed gaps are 17h
   intra-week, ~52h over a weekend and ~78h over a holiday weekend, while Overcall's write window
   stays open throughout. A 24h staleness rule would have skipped almost every week. `maxPriceAge`
   is therefore a bounded governance parameter, `[1 hour, 7 days]`, launching at **4 days**. A
   stale weekend price is also the economically right one: the market is shut, so Friday's close
   is spot.
7. **Chain 4663 has no Chainlink sequencer uptime feed**, so the usual L2 sequencer guard cannot
   be implemented. A sequencer outage surfaces instead as a stale price, which the check catches.
8. **Seaport's `incrementCounter` does not add one.** It jumps by a quasi-random amount
   (observed 0 → 6.45e35), so anything building an order must re-read `getCounter` after a bump.
9. **`minOtmBps` is a floor, not a ceiling.** Confirmed as written in plan section 1; the contract
   enforces `MIN_OTM_FLOOR_BPS = 100` so an admin cannot sell at-the-money.

### 14.3 Implementation decisions forced by the build

- **`SeaportOrderLib` is a linked public library.** With the order-shape checks and Seaport's three
  nested-struct encoders inlined, `Vault` compiled to 31.6 KB, well past the EIP-170 24 KB limit.
  Moving them out brought it to ~23 KB. via-IR is on. The library must be deployed and linked
  before the vault.
- **Queued shares are governed by escrow alone.** An earlier draft both escrowed the shares and
  subtracted `queuedSharesOf` from the owner's balance in `_update`, double counting them: queueing
  a full position was impossible and a partial queue froze the remainder. The two designs are
  alternatives. Escrow won; the balance check went.
- **Redemption epochs draw down rather than divide.** Each epoch tracks remaining shares, assets
  and USDG; every claimant takes their proportion of what is left, so the final claimant absorbs
  the remainder and no dust is ever stranded.
