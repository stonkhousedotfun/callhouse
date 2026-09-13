# Keeper dry run — recorded

This file is the record of the first time the keeper's production code executed a whole roll.
It exists because a keeper that has never run is a keeper whose first run is Friday night with
depositors' collateral. `src/dryrun.ts` produced everything below; the raw `report.md`,
`run.json` and `keeper.db` for this run are in the operator's `dryrun-out/` directory, not in
the repository. Re-run it on every commit that touches `keeper/` or `contracts/` before a deploy,
and replace this file with the new record when the numbers change.

What is deliberately absent from this file: any claim about Overcall's real validator, any
claim about the real Chainlink feed after a time warp, and any number that was not asserted by
the harness. The "What was stubbed" section is the list of things this run does not prove.

---

## Re-run after the fee change — 2026-09-13T17:42:14Z (supersedes every fee figure below)

The protocol fee became **5% of premium only** (`Policy.launchDefaults().protocolFeeBps` 500;
`Vault._harvest(usdgFromAssignment)` credits strike proceeds fee-free). The harness was updated
to derive every fee from that rule and to read the launch policy back from the deployed vault,
then re-run on a fresh fork: **passed**, all three cycles, fork block **62142174**, 20.9 s, on the
uncommitted tree on top of `cb82bf3`. Raw artefacts: `dryrun-out/2026-09-13T17-42-14-160Z/`.

The rest of this file is the 05:49 run under the old rule (10% of every USDG inflow, launch policy
`protocolFeeBps 1000`). Its transaction hashes, blocks and gas figures belong to that run; its
non-USDG facts were compared against the new report and match: 23 contracts at strike 226 then
225, 9 assigned, queued-redeem payout 6.4 NVDA, state.db rows `{cycles 3, listings 3, txs 11,
alerts 5, meta 4}`, and the same five alerts in the same order (amounts aside). The USDG figures
that changed:

| | old run (10% of everything) | this run (5% of premium) |
|---|---|---|
| launch policy `protocolFeeBps` | 1000 | **500** |
| cycle 1 `Harvest` gross / fee / net | 19.079259 / 1.907925 / 17.171334 | 19.079259 / **0.953962** / **18.125297** |
| cycle 1 depositor `claimUsdg` | 17.171334 | **18.125297** |
| cycle 2 | 0 / 0 / 0 | 0 / 0 / 0 |
| cycle 3 `Harvest` gross / fee / net | 2044.079259 / 204.407925 / 1839.671334 | 2044.079259 / **0.953962** / **2043.125297** |
| cycle 3 fee basis | gross, strike proceeds included | premium 19.079259 only; `RollClose.usdgFromAssignment` 2025 fee-free |
| cycle 3 `QueueSettled` / `completeRedeem` USDG | 735.868533 | **817.250118** (floor(2/5 of net)) |
| cycle 3 `claimUsdg` (15e18 shares) | 1103.8028 | **1225.875178** |
| where cycle 3's gross went | 735868533 + 1103802800 + 204407925 + 0 + 1 | 817250118 + 1225875178 + 953962 + 0 + 1 = 2044079259 |
| `roll_close` alerts | "…17.171334 to depositors", "…1839.671334 to depositors" | "…18.125297 to depositors", "…2043.125297 to depositors" |
| rollClose txs (new run) | — | c1 `0xaecf51ed…` (62142191, 261,114 gas), c2 `0xf8177554…` (62142205, 143,095), c3 `0x2174b4ba…` (62142225, 359,410) |

New harness assertions in this run: the vault's stored policy equals `launchDefaults` field by
field; every `Harvest` log's fee equals floor((gross − feeFree) × bps / 10000) with feeFree =
`RollClose.usdgFromAssignment` in the close transaction and 0 elsewhere; cycle 3's fee equals the
fee on its premium leg alone. The keeper alert still says "2044.079259 USDG harvested" on the
assigned week (K-21), so fee/gross read from keeper output looks like 0.047%, not 5%.

## Result

| | |
|---|---|
| Date | 2026-09-13T05:49:32.391Z |
| Outcome | **passed**, all three cycles, every assertion. An independent re-run on a fresh fork after cycle 3 was added to the harness |
| Wall clock | 27.9 s (harness start to report written) |
| Fork | anvil `v1.6.0` on port 8545, `--fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663`, fork block **61720714**, head timestamp 1789278568 |
| Feed | `mock` — MockFeed seeded with the real Chainlink RHNVDA/USD answer at the fork block, `21829793457` (218.29793457 USD); moved to strike + 5 USD for cycle 3's exercise |
| Keeper code | `roll.ts` (`reconcile`, `tick`, `snapshot`, `contractsAssignedAt`, `resolveContractsAssigned`), `state.ts`, `policy.ts`, `seaport.ts`, `overcallApi.ts`, `alerts.ts`, `health.ts`, `clients.ts`, `config.ts`, `abi.ts`, `logger.ts` — all imported unmodified after the harness set the environment |
| Change under test | `roll.ts`: `contractsAssignedAt` returns `null` plus a warn log on a failed Valorem read instead of a silent 0; new pure, exported `resolveContractsAssigned(receipt, assignedBefore)` publishes the `RollClose` event count when present, falls back to the pre-close Valorem claim read otherwise, and flags a mismatch; `roll_close` alert data gains `contractsAssignedSource` and `contractsAssignedFromClaim`. `abi.ts`: `clearAbi` gains `error TokenNotFound(uint256)`. Keeper unit tests 66/66 on this tree (59 before, plus 3 `resolveContractsAssigned` tests in `roll.test.ts` and 4 `contractsAssignedAt` tests in the new `roll.close.test.ts`) |
| Not exercised | `index.ts` (the timer loop and SIGTERM handling; the harness calls `tick()` directly) |
| Commit | run on the uncommitted tree on top of 27d502a, 2026-09-13; committed as 8ff8bef; the `contracts/out` Vault artifact passed the harness's link check (link references exactly `SeaportOrderLib` and `ValoremLib`, linked at 2 and 3 sites) |

## Actors and deployments on the fork

All actors are derived keys (`keccak256("callhouse-dryrun:<role>")`), funded with 100 ETH via
`anvil_setBalance`, and scrubbed of any EIP-7702 delegation code before use.

| Role | Address |
|---|---|
| keeper (holds `KEEPER_ROLE`; the key the keeper modules run as) | `0x19F7E8d3677b1cf159050DFBCf1F3A2F9F9155f2` |
| admin (`DEFAULT_ADMIN_ROLE`; deployer) | `0x5aa6C2455D29086e6C04Fb2a16De7D07d2c41Da8` |
| fee Safe stand-in | `0x506B221371D254C6d7A523E74f61148c4844EE1e` |
| depositor | `0x52195AD1a9324a780173b5f3538e448eB4770115` |
| buyer | `0xB8c8a777Cc847Bd8874d7447D6b1360E29A124A8` |

| Contract | Address on the fork | Source |
|---|---|---|
| MockRegistry (NVDA, USDG, Clear) | `0x1CE47ae17A39b86B1aE5aD333D8F29ebAaf2bb9D` | `contracts/src/mocks/MockRegistry.sol` |
| MockFeed (8 dp, real answer) | `0x5CcEF942D6538ae2d2139D5bf28191Cef1011697` | `contracts/src/mocks/MockFeed.sol` |
| SeaportOrderLib | `0x108609Ab596d8cF59BF75dE748Ab3FDF31876fAc` | linked at 2 sites |
| ValoremLib | `0x0Bb345e8eFC1F61a1707Ff717E8D07efB6Fb7f50` | linked at 3 sites |
| Vault "Callhouse NVDA (dry run)", cap 50 NVDA, launch policy (minOtmBps 300, maxOtmBps 1200, minPremiumBps 40, maxUtilizationBps 9500, protocolFeeBps 1000, maxContractsCap 50) | `0x07fF75F92DAC990C0Bf49690A50b9e129f4C14A6` | `contracts/out/Vault.sol/Vault.json`, linked by the harness |

Real contracts used at their live addresses: Valorem Clear `0x9a7b…C0C0`, Seaport 1.6
`0x0000…B395`, NVDA `0xd060…9EEC`, USDG `0x5fc5…d168`, Multicall3 `0xcA11…CA11`, the real NVDA
registry `0x8E97…f4EA` (read only, for the live series), the Overcall fee recipient
`0xdAe7…0782`.

## Cycle 1 — the live series, filled

The real registry's cycle 1 at the fork block, mirrored verbatim into MockRegistry
(`setCycleWithStrikes` `0xdb3e01c3fd3f5d9aa7980e5e0cb9869b52082ce05cc4fd582d109b771096560e`, block 61720721):

| | |
|---|---|
| option ids | `1130256…413056`, `2965259…491776`, `1395615…458752`, `8012928…807488`, `5688539…297792` (the five real NVDA rungs) |
| strikes | 226 / 231 / 236 / 241 / 246 USDG |
| exerciseTimestamp / expiryTimestamp | 1789761600 (Fri 2026-09-18 20:00 UTC) / 1789848000 (Sat 2026-09-19 20:00 UTC) |
| spot (vault.spotUsdg) | 218.297934 USDG |
| band [3%, 12%] | [224.846872, 244.493686] → the keeper picked **226**, the nearest in-band rung |
| deposit | 25 NVDA → 25 cNVDA (1:1) |
| size | floor(25 × 95%) = **23 contracts** |
| ask | policy floor (minPremiumBps 40 on spot) = **0.873192 USDG / contract**, `priceSource: policy-floor`; the stub book had no fills |
| gross / to vault / to Overcall | 20.083416 / 19.079259 / 1.004157 USDG |
| order hash (Seaport `getOrderHash` == keeper's local hash, or the keeper refuses to publish) | `0xd15df30d305e929c9bc3b2dc6f63c6634627e748d9a16ddbbf3cc4d6ff57bb5c`, Seaport counter `0` |

Sequence, with the keeper's transactions (from `state.db` → `txs`, all `success`):

| # | Who | What | Tx | Block | Gas |
|---|---|---|---|---|---|
| 1 | harness | NVDA.approve(vault) | `0xb8c5d4d8274c855f9ded027c7c99f7299eaeb676e3e75826248fc8c5a780a29f` | 61720722 | 63,637 |
| 2 | harness | vault.deposit(25e18) | `0x07ef1d1a58a86c3ce52e44f88821b6f8fcb414ca5a9cbffd899ff499b9e71263` | 61720723 | 163,953 |
| 3 | **keeper, tick #1** | vault.rollOpen(226-rung, 23) → real Valorem wrote 23 calls | `0xe9c8f9cc49cb9f4eac86c4eeb17f3fa69f81e4fae6200cf0ebc91a6227a1179e` | 61720724 | 465,016 |
| 4 | **keeper, tick #1** | vault.approveListing(components) → real Seaport `validate()` | `0x956bf050720c283647349c9a9aa946d030778a0c7f1c3015f1bd5cb293f81e55` | 61720725 | 212,028 |
| — | **keeper, tick #1** | `POST /api/orders?market=NVDA` → 201; listing row `posted`; alert `roll_open` | | | |
| — | **keeper, tick #2** | Seaport says open; `GET /api/orders/0xd15d…` → open; listing row `visible` | | | |
| 5 | harness (buyer) | USDG.approve(seaport, 20.083416) | `0xa1388c0dcab237cb0a5819e1d4b0f9ee4bbfc0dbb5e56e678d08cfbfeb5dc95b` | 61720726 | 57,904 |
| 6 | harness (buyer) | seaport.fulfillOrder — parameters and signature taken from the keeper's own `GET /orders`; the 65-byte placeholder signature was accepted through the vault's EIP-1271 | `0x212d24a739e238a584964afd728b3b6f11edc7ad74db64c564c4e36222fde9d8` | 61720727 | 147,637 |
| — | assert | vault USDG +19.079259; fee recipient USDG +1.004157; buyer holds 23 option tokens | | | |
| — | **keeper, tick #3** | Seaport `getOrderStatus` → totalFilled 1 / totalSize 1; listing row `filled` | | | |
| — | harness | `evm_increaseTime` 1789278584 → 1789761660 (+483076 s, past exerciseTimestamp) | | | |
| 7 | **keeper, tick #4** | vault.lockBook | `0xf9789e6cb0a31e992cb1d311dd38a10b113e5ba7cf25c14dc7d5339a774e972f` | 61720729 | 64,345 |
| — | harness | warp 1789761660 → 1789848060 (+86400 s, past expiryTimestamp) | | | |
| 8 | **keeper, tick #5** | vault.rollClose → Valorem redeem, harvest, settle | `0x908ba6ab7d30e42fb2205ea601e8a06cc1c216154f1d274da91a6ca744981cda` | 61720731 | 260,935 |
| — | **keeper, tick #5** | Harvest summed from `Harvest` logs (rollOpen block → rollClose block): gross **19.079259**, fee **1.907925**, net **17.171334**; contracts assigned 0 (`contractsAssignedSource: RollClose`, `contractsAssignedFromClaim: 0`); alert `roll_close` | | | |
| 9 | harness (depositor) | vault.claimUsdg → received exactly `claimableUsdg` = 17.171334 USDG | `0x1b308bbd51eccb9879ec4f63f0d9731144174988f07fcb94d89aa0de1b44504a` | 61720732 | 124,998 |
| — | assert | phase Idle; idleAssets = 25 NVDA (all collateral back, the call expired out of the money) | | | |

## Cycle 2 — fresh series, rolled while the keeper was asleep, unfilled

| | |
|---|---|
| feed | `MockFeed.setAnswer(21829793457)` after the warp, so `updatedAt` is fresh (`0x51942d1b…c879c6`, block 61720733) |
| new option types on the **real** Valorem Clear (`newOptionType`, NVDA 1e18 / USDG) | strikes 225 / 230 / 234 / 239 / 243 USDG; exercise 1789851660, expiry 1789938060; txs `0x3faa282e…`, `0xe343c762…`, `0x98b6911c…`, `0x7eccef7b…`, `0x49a9a4d9…` (blocks 61720734–61720738) |
| MockRegistry.setCycleWithStrikes(cycle 2) | `0xc283701be4a7a94742823b809b73486020c56150adc52a752a23fb51e25bb1a2`, block 61720739 |
| plan (computed with the production picker, `pickWrite`) | 225-rung (band [224.846872, 244.493686] on spot 218.297934), 23 contracts |
| **vault.rollOpen sent by the harness with the keeper's key, no `state.db` row** — the "rolled while asleep" case | `0x6fb1e9f95fee2b5ceb196236b6640de578852f59c73ce755901461263486020b`, block 61720740, 430,816 gas |
| **keeper `reconcile()`** | log `adopted an open cycle the database had no record of`; row 2 created `open` with option id `4528183…431424`, strike, contracts from chain and `roll_open_tx: null` |
| **keeper tick #6** | phase Listed, `listingHash` zero → `maybeRelist` → `repriceFromPolicy` (floor 0.873192; the book's only fill is on cycle 1's rung, ignored) → vault.approveListing `0x493e3be6a236470b820719c45fb9aeeff5c806f58b68e5c2b7e88e51025b0604` (block 61720741, 212,220 gas) → `POST` → 201; `relists_used` stays 0 (a first listing is not a relist) |
| order hash | `0x2ec8d8f821a297cb6395968d7a506dbb04453f0945172f3052ba35ab183ca239`, Seaport counter `161853509532601670948104544459648713489` (cycle 1's listing was signed at counter 0; the vault's `_invalidateAllListings` bumps it, so it is re-read live, as ForkLive.t.sol says it must be) |
| **keeper tick #7** | `GET /api/orders/0x2ec8…` → open; listing `visible`. Nobody fills. |
| warp 1789848066 → 1789851720; **keeper tick #8** | vault.lockBook `0xc7a0e48876c70a54167908d2990f626a07a9ca05643003bcd3208502456f08f4` (block 61720743, 50,665 gas); listing row → `expired`; `DELETE /api/orders/0x2ec8…` sent; `/orders` serves nothing |
| warp 1789851720 → 1789938120; **keeper tick #9** | vault.rollClose `0x3866a4fe16ae8f4829a1ecf66f0454691a46e8f60e986ab5065dd9740986d243` (block 61720745, 143,069 gas); no `no rollOpen block on record` warning in the log; cycle 2 `closed`, gross **0**, fee 0, net 0, contracts assigned 0 (`RollClose`); alert `roll_close: cycle 2 closed unfilled: 0 USDG harvested.`; idleAssets = 25 NVDA |

## Cycle 3 — fresh series, filled, queued redeem, 9 of 23 assigned

The first week in the money. Everything the keeper does in it is its own: it writes and lists
from Idle, locks the book, and closes an assigned claim. The exercise is done by the buyer on the
real Valorem Clear.

| | |
|---|---|
| feed | `MockFeed.setAnswer(21829793457)` after cycle 2's warp (`0x4ff30fcc…84a1fc`, block 61720746) |
| new option types on the **real** Valorem Clear | strikes 225 / 230 / 234 / 239 / 243 USDG; exercise 1789941721, expiry 1790028121; txs `0xab0cc4be…`, `0x2ffcaca3…`, `0xc126a6d7…`, `0x11f40588…`, `0x589c32a4…` (blocks 61720747–61720751, 141,587 gas each) |
| MockRegistry.setCycleWithStrikes(cycle 3) | `0x83edcf1ee35ca416b1cea83fb4f8dc2d43efb34decbee066b4e191908a149f8c`, block 61720752; registry cycle 3, writing open |
| option ids | `8184129…058112`, `2085335…842560`, `2738610…519872`, `9308022…351936`, `1694672…282816` — new ids although the strikes repeat cycle 2's, because Valorem hashes the whole tuple including the timestamps |
| idle collateral entering the cycle | 25 NVDA (both earlier cycles expired out of the money) |
| spot (vault.spotUsdg) at the pick | 218.297934 USDG; band [224.846872, 244.493686] → the keeper picked **225** |
| size / ask | **23 contracts** (the whole idle balance at 95% utilisation); **0.873192 USDG / contract**, `priceSource: policy-floor` (the book has no fill on these fresh ids) |
| gross / to vault / to Overcall | 20.083416 / 19.079259 / 1.004157 USDG |
| order hash | `0xa43b5008ea38d14625674e88f6232744648dee902669c4469d209a3006971af2`, Seaport counter `308089086655446757152343253644422587516`, endTime 1789941721 |
| Valorem claim key held by the vault | `8184129…058113` |

Sequence (keeper transactions from `state.db` → `txs`, all `success`):

| # | Who | What | Tx | Block | Gas |
|---|---|---|---|---|---|
| 1 | **keeper, tick #10** | vault.rollOpen(225-rung, 23) → real Valorem wrote 23 calls to the vault. Cycle row 3 `open` with a **non-null** `roll_open_tx` (the keeper's own); vault `cycleNumber` 3, phase Listed | `0xe80072b0218ba8e0cf348e0126ec0ba6ca2b6ea1c75168115b78ec4d3f683957` | 61720753 | 428,016 |
| 2 | **keeper, tick #10** | vault.approveListing(components) → real Seaport `validate()`; vault `listingHash` == the stored hash | `0x75c64e0c20f4857856585300bc63cd9c1ba8fa5a709f3e954f4943c5e0af94ea` | 61720754 | 212,220 |
| — | **keeper, tick #10** | `POST /api/orders?market=NVDA` → 201 (the run's third POST); listing row `posted`; alert `roll_open` for cycle 3, a second `roll_open` force-sent past the one-hour alert cooldown | | | |
| — | **keeper, tick #11** | `GET /api/orders/0xa43b…` → open; listing row `visible`; no new alert | | | |
| 3 | harness (buyer) | USDG.approve(seaport, 20.083416) | `0x006d103ca07f829e93d5db85731da4d50475368fc7fed3500aa5b360cac3f0cf` | 61720755 | 57,904 |
| 4 | harness (buyer) | seaport.fulfillOrder — the keeper's own `GET /orders` payload and the 65-byte placeholder signature, through the vault's EIP-1271 | `0xa2575d01821eec028a4a12092ff1187c5d44217b3eb9e444ac3efcb222ac5582` | 61720756 | 147,637 |
| — | assert | vault USDG +19.079259; fee recipient USDG +1.004157; buyer holds 23 option tokens | | | |
| — | **keeper, tick #12** | Seaport `getOrderStatus` → totalFilled 1 / totalSize 1; listing row `filled`; log `listing fully filled; nothing more to sell this cycle` | | | |
| 5 | harness (depositor) | vault.queueRedeem(10e18) while the call is live (Listed, filled), epoch 1. `QueueRedeem(depositor, 10e18, 1)`; the depositor keeps 15e18 shares, the vault escrows 10e18 on itself, `totalSupply` stays 25e18, `queuedShares` 10e18, `canRedeemInstantly` false, `previewRedeem` 0; `completeRedeem` now reverts `EpochNotSettled(1, 1)` | `0x606fcfb17310d954078b219deb1d2e2290a5d0947a349b0cee30023b209d5449` | 61720757 | 153,512 |
| — | harness | warp 1789938126 → 1789941781 (+3655 s, past exerciseTimestamp 1789941721) | | | |
| 6 | harness (admin) | MockFeed.setAnswer(strike + 5 USD) → vault.spotUsdg **230000000** > strike 225000000 USDG6. With the vault still Listed, `maxDeposit` is 0 and `deposit` reverts `DepositsClosedForCycle(1789941721)` | `0xbf5e95255e621609249ccf4ec1c7e0216835b8e9923f3bfe500297039731d922` | 61720759 | 36,570 |
| 7 | **keeper, tick #13** | vault.lockBook → phase Exercisable; cycle row `locked`. The filled listing row stays `filled` (terminal), so no `DELETE` is sent; `/orders` serves nothing; no new alert | `0x91aa757e1ca741a259a876a75525df9fe495bf523d2f58486ff26cff68c5f674` | 61720760 | 50,665 |
| — | harness | Clear read live: `feesEnabled=false`, `feeBps=15` → exercising 9 pulls 2025000000 + fee 0 = **2025000000 USDG6**; exactly that dealt to the buyer, whose USDG was 0 after the fill. Before: vault USDG exactly 19.079259 (this cycle's premium leg), `totalAssets` 25 NVDA, `contractsAssigned()` 0 | | | |
| 8 | harness (buyer) | USDG.approve(clear, 2025000000) | `0x9cae84d08d55e891eead8f901fb8b1c87accde3ee1bc2d2f46987772a695b126` | 61720761 | 57,988 |
| 9 | harness (buyer) | clear.exercise(optionId, 9) on the **real** Clear → exactly one `OptionsExercised(optionId, buyer, 9)` | `0xc0159981bb433534569bc290d2c9ff88298cc53e11b068ea52e502afb0f07ce1` | 61720762 | 156,019 |
| — | assert | buyer USDG back to 0 (the debit was exactly 2025000000); buyer took delivery of 9 NVDA; Clear USDG +2025000000 and NVDA −9; buyer's option tokens 23 → 14; vault USDG unchanged (the proceeds wait inside the claim). Claim read before the close: `amountExercised` **9000000000000000000** (a 1e18-scaled scalar), `amountWritten` 23 lots; `position`: 14 lots still locked, `exerciseAmount` 2025000000. Vault views: `contractsAssigned()` **9** (the raw count, not 9e18), `lockedAssets` 14 lots, `claimedExerciseProceeds` 2025000000, `totalAssets` already down 9 lots, `contractsSold` 23, `contractsRemaining` 0, `maxDeposit` 0 | | | |
| — | harness | warp 1789941782 → 1790028181 (+86399 s, past expiryTimestamp 1790028121) | | | |
| 10 | harness (admin) | MockFeed.setAnswer (refresh `updatedAt`; still in the money) | `0xcc7265895dfb56c7625cd213305fc23081648a0f6ed20c3f299499bd87f9bc63` | 61720764 | 33,770 |
| — | **keeper's pre-read, called directly** | `roll.snapshot()` → phase Exercisable, claim key `8184129…058113`, block timestamp past expiry; `roll.contractsAssignedAt(snap)` → **9n**, through the keeper's own Multicall3-batched `publicClient` against the real Clear | | | |
| 11 | **keeper, tick #14** | vault.rollClose → redeem the assigned claim, harvest premium plus strike proceeds, sweep the fee, settle the queue; cycle row `closed`; alert `roll_close` | `0x3041d5eb2a465699a76170b52626b7a20e88a5c826c85810c305ae5e6ef9c952` | 61720765 | 359,231 |
| 12 | harness (depositor) | vault.completeRedeem | `0x5d6f14a0dbf6b28ba5a3bf593391ca14be752117a3c117aaf938f9aa869acc4c` | 61720766 | 166,471 |
| 13 | harness (depositor) | vault.claimUsdg | `0xe7f70f4b50c08a9386ac42be42b1f2fbc5c520518bf3f760b17b8577e7cc94de` | 61720767 | 83,352 |

The `rollClose` receipt (tick #14), and what the keeper made of it:

| | |
|---|---|
| `RollClose` (vault) | cycleNumber 3, assetsReturned **14000000000000000000** (14 NVDA), usdgFromAssignment **2025000000**, contractsAssignedCount **9** |
| `ClaimRedeemed` (Clear) and `ClaimRedeemed` (vault adapter) | claim `8184129…058113`, option `8184129…058112`, redeemer the vault; exercise amount 2025000000 and underlying 14000000000000000000 on both, the adapter's measured as balance deltas |
| `Harvest` (vault) | gross **2044.079259** USDG = premium 19.079259 + strike proceeds 2025; fee **204.407925** = floor(gross × protocolFeeBps / 10000), charged on the strike proceeds too; net **1839.671334**. Exactly one `Harvest` for cycle 3 between the keeper's rollOpen block 61720753 and the rollClose block 61720765, and the keeper's sum equals it |
| `FeeSwept` | 204.407925 USDG to the fee Safe stand-in, received in the same transaction; `pendingFeeUsdg` 0 |
| `UsdgDistributed` | `totalSupply` 25e18 (the escrowed 10e18 still counted); index delta **73586853360000000** = floor(net × 1e27 / totalSupply); `usdgDust` **0** |
| `QueueSettled` | epoch 1, shares 10e18, assets **6400000000000000000** (16e18 × 10e18 / 25e18 = 6.4 NVDA, not the 10 that were queued), usdgOut **735868533** (735.868533 USDG: the escrow's own accrual, floor(2/5 of net)) |
| keeper's resolver and pre-read | the tick published `contracts_assigned` **9** from the `RollClose` event: alert `data.contractsAssigned` 9, `contractsAssignedSource` `RollClose`, `contractsAssignedFromClaim` **9** — the value the keeper's own `contractsAssignedAt` returned inside the tick. Driven directly on the same real receipt: `resolveContractsAssigned(receipt, 9n)` → source `RollClose`, assigned 9, fromEvent 9n, fromClaim 9n, mismatch false; on a copy with its one `RollClose` log removed → source `claim-preread`, assigned 9, fromEvent null; removed and a null pre-read → source `unknown`, assigned 0 |
| keeper row | `gross_usdg6` 2044079259, `fee_usdg6` 204407925, `net_usdg6` 1839671334, `contracts_assigned` 9; `/health` 200 `ok`; `/cycles[0]` is cycle 3 with `contracts_assigned` 9 and the same gross |
| vault right after the close | phase Idle; `totalSupply` 15e18 (the escrow burned); `queuedShares` 0; epoch advanced; `epochs[1]` = 10e18 shares, 6400000000000000000 assets, 735868533 USDG; `reservedAssets` 6400000000000000000; `usdgReservedForQueue` 735868533; the vault holds the 2 NVDA never written plus the 14 returned, and `idleAssets` = `totalAssets` = **9600000000000000000**; `lockedAssets`, `claimKey`, `contractsWritten` and `contractsAssigned()` all 0; the claim NFT burned; vault USDG = premium + strike proceeds − fee; the buyer keeps 9 NVDA |
| the keeper's read after the close | `roll.contractsAssignedAt` on a fresh keeper snapshot (claim key 0) → **0n**, answered without a read. On the burned claim key the real Clear's `claim()` reverts `TokenNotFound(8184129…058113)`, decoded with the keeper's `clearAbi`, and `contractsAssignedAt` → **`null`**, with the warn log `could not read the Valorem claim before rollClose; contracts assigned is unknown`. That probe is the harness's, after the tick; it and cycle 2's adoption are the only two warn lines in the run |

The depositor, after the close:

| | |
|---|---|
| completeRedeem | `previewCompleteRedeem` = (6400000000000000000, 735868533) beforehand; `QueueEntrySettled` and `CompleteRedeem` carry epoch 1, 10e18 shares and the same two amounts; the depositor received 6400000000000000000 NVDA wei and 735.868533 USDG. `reservedAssets`, `usdgReservedForQueue`, `queuedSharesOf`, `queuedEpochOf`, `owedAssets`, `owedQueueUsdg` all 0; epoch 1 empty |
| claimUsdg | `claimableUsdg` for the 15e18 shares left = shares × index delta / 1e27; `ClaimUsdg` amount **1103.8028 USDG** (1103802800), exactly the claimable; `claimableUsdg` 0 afterwards |
| where the gross went | escrow 735868533 + claim 1103802800 + fee 204407925 + dust 0 + owed 1 = gross 2044079259 (asserted to the base unit) |
| the 1-unit remainder | the vault's USDG balance after both calls is **1** base unit = `usdgDust` 0 + `usdgOwed` 1: the MasterChef per-account floor loss (floor(2n/5) + floor(3n/5) = n − 1 when 5 does not divide n). It sits inside `usdgAccounted`, so it can never be re-harvested as new premium; `usdgUnallocated` 0 |
| final state | phase Idle; `totalSupply` 15000000000000000000, all the depositor's; vault NVDA = `idleAssets` = `totalAssets` = 9600000000000000000 (9.6 NVDA backing 15 shares); `reservedAssets` 0; depositor NVDA 6400000000000000000; `previewRedeem` of the 15e18 is non-zero, the instant path open again |

## state.db after the run (reopened from disk after `store.close()`)

`{"cycles":3,"listings":3,"txs":11,"alerts":5,"meta":4}` — identical before and after reopen, and
equal to the harness's expected counts for three cycles.

**cycles**

| cycle | status | option_id | strike | contracts | roll_open_tx | lock_tx | roll_close_tx | gross / fee / net (USDG6) | assigned | relists |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | closed | `1130256…413056` | 226000000 | 23 | `0xe9c8f9cc…` | `0xf9789e6c…` | `0x908ba6ab…` | 19079259 / 1907925 / 17171334 | 0 | 0 |
| 2 | closed | `4528183…431424` | 225000000 | 23 | **null** (adopted) | `0xc7a0e488…` | `0x3866a4fe…` | 0 / 0 / 0 | 0 | 0 |
| 3 | closed | `8184129…058112` | 225000000 | 23 | `0xe80072b0…` | `0x91aa757e…` | `0x3041d5eb…` | 2044079259 / 204407925 / 1839671334 | **9** | 0 |

**listings**

| order_hash | cycle | contracts | unit_price6 | gross | to_vault | to_overcall | end_time | status | api_status | seaport filled/size |
|---|---|---|---|---|---|---|---|---|---|---|
| `0xd15df30d…57bb5c` | 1 | 23 | 873192 | 20083416 | 19079259 | 1004157 | 1789761600 | filled | open | 1 / 1 |
| `0x2ec8d8f8…3ca239` | 2 | 23 | 873192 | 20083416 | 19079259 | 1004157 | 1789851660 | expired | open | 0 / 0 |
| `0xa43b5008…971af2` | 3 | 23 | 873192 | 20083416 | 19079259 | 1004157 | 1789941721 | filled | open | 1 / 1 |

`/orders` rebuilds each order from the row's `components_json`; for cycles 1 and 3 the real Seaport
filled exactly that payload. `signature` is the 65-byte placeholder on all three rows.

**txs**: the eleven keeper transactions in the tables above (four in cycle 1, three in cycle 2
whose `rollOpen` was the harness's, four in cycle 3), every one `success` with block and gas
recorded and no error. **meta**: `last_heartbeat_ms` and one `book_poll_ms:<hash>` per listing.

## Alerts captured at ALERT_WEBHOOK, in order — exactly these five, nothing else

1. `[info] roll_open` — cycle 1: wrote 23 contracts at strike 226 USDG
2. `[info] roll_close` — cycle 1 closed: 19.079259 USDG harvested, 17.171334 to depositors.
3. `[info] roll_close` — cycle 2 closed unfilled: 0 USDG harvested.
4. `[info] roll_open` — cycle 3: wrote 23 contracts at strike 225 USDG
5. `[info] roll_close` — cycle 3 closed: 2044.079259 USDG harvested, 1839.671334 to depositors.

All five rows are `delivered: 1`. The three `roll_close` rows carry `contractsAssignedSource:
RollClose`, with `contractsAssigned` / `contractsAssignedFromClaim` 0 / 0, 0 / 0 and 9 / 9.

No `tx_revert`, `api_reject`, `listing_invisible`, `low_gas`, `rpc_lag`, `phase_stuck` or
`keeper_error` was raised. No `boot` alert, because `index.ts` (which emits it) is not part of
the harness. Cycle 2's `rollOpen` was the harness's, so there is correctly no `roll_open` for it;
cycle 3's was the keeper's, so there is a second `roll_open`, force-sent past the cooldown.

## Requests the Overcall stub received, in order

```
GET    /api/orders?status=filled&limit=50            tick #1: last fill on the chosen rung  -> none
GET    /api/orders?status=filled&limit=50            tick #1: last fill on any live rung    -> none
POST   /api/orders?market=NVDA                       tick #1: 201
GET    /api/orders/0xd15df30d…                       tick #2: visible
GET    /api/orders?status=filled&limit=50            cycle 2, tick #6: reprice from the book -> only cycle 1's rung, ignored
POST   /api/orders?market=NVDA                       cycle 2, tick #6: 201
GET    /api/orders/0x2ec8d8f8…                       cycle 2, tick #7: visible
DELETE /api/orders/0x2ec8d8f8…                       cycle 2, tick #8: after lockBook
GET    /api/orders?status=filled&limit=50            cycle 3, tick #10: last fill on the chosen rung -> none on these ids
GET    /api/orders?status=filled&limit=50            cycle 3, tick #10: last fill on any live rung   -> none on these ids
POST   /api/orders?market=NVDA                       cycle 3, tick #10: 201
GET    /api/orders/0xa43b5008…                       cycle 3, tick #11: visible
```

No `DELETE` for cycle 3: its listing was filled, a terminal row, so `lockBook` neither retired it
nor told the book. Every POST passed the stub's checks (`market=NVDA`, `chainId` 4663, a 64- or
65-byte `signature`, `orderType` 1), and the stub derived the order hash from the posted
components with the keeper's own `localOrderHash`, which the keeper had already checked against
`seaport.getOrderHash` before approving the listing.

## Health endpoints

- `GET /health` after `reconcile()` (no tick yet): `200 {"status":"ok"}` — the boot grace window
  (`lastHeartbeat: null`, every check `true`); `keeper.hasKeeperRole: true`,
  `vault.registryCycleNumber: 1`, `rpcLagSeconds: 3`, all row counts 0.
- after cycle 1: `200 ok`, `checks: {heartbeat: true, rpcLag: true, gas: true}`,
  `lastHeartbeatAgeSeconds: 0`, `db.rows: {cycles:1, listings:1, txs:4, alerts:2, meta:2}`.
- after cycle 3: `200 ok`, same checks, `lastHeartbeatAgeSeconds: 0`, `headBlock` 61720765,
  vault phase `Idle`, `cycleNumber` 3, `registryCycleNumber` 3,
  `db.rows: {cycles:3, listings:3, txs:11, alerts:5, meta:4}`.
- final (before the store closed): identical rows.
- `GET /cycles` after cycle 1 listed the closed cycle with gross 19079259; after cycle 3 its first
  entry was cycle 3 with `contracts_assigned` 9 and gross 2044079259.
- `GET /state` at the end: phase `Idle`, vault `claimKey` 0, `optionId` 0, `idleAssets` =
  `totalAssets` = 9600000000000000000, `lockedAssets` 0, `listingsThisCycle` 1,
  `valoremFeesEnabled: false`, and `keeperView` = the cycle 3 row.
- `GET /orders` served the live listing with `parameters` and the placeholder `signature`; a real
  Seaport fill went through with that exact payload, in cycles 1 and 3.
- Note, not a defect: `/health` and `/state` report the vault phase from the **last snapshot**,
  which a tick takes before it acts. Immediately after cycle 1's `rollClose` tick they still said
  `Exercisable`. After cycle 3 they said `Idle` only because the harness had called
  `roll.snapshot()` itself after the close, and `snapshot()` updates the cached snapshot.

## What was stubbed, skipped, or is not proven by this run

- **The Overcall registry is a mock.** The real one's cycle is set by Overcall's operator. Cycle 1
  used the real option ids, strikes and timestamps read from the real registry at the fork
  block, so the vault's `ValoremLib.writeCalls` window check ran against real Valorem option
  types. Cycles 2 and 3 used option types the harness created on the real Clear.
- **The price feed is a mock seeded with the real answer.** The vault's `StalePrice` gate with
  the real feed is covered by `contracts/test/fork/ForkLive.t.sol`, not here. `DRYRUN_FEED=real`
  runs cycle 1 against the real feed and stops (a one-week warp makes it stale, correctly).
  Cycle 3's move to strike + 5 USD was made after the keeper had written and listed; nothing in
  `lockBook`, the exercise, `rollClose` or the queue reads spot, and Valorem settles physically
  with no oracle, so the move is the narrative of the week, not its mechanism.
- **Overcall's listings API is a stub.** It implements the recon-R3 shapes and status codes and
  the keeper's client ran unmodified against it, but the real validator's documented checks
  (R3's 0–12 validation table, including the 500 on a hash mismatch at check 7) were not
  exercised. That needs a mainnet listing.
- **Token balances were written into storage** (NVDA at the ERC-7201 slot
  `0x52c63247…bace00`, USDG at base slot 1), including the buyer's 2025000000 USDG6 for the
  exercise. Nobody here holds real Stock Tokens.
- **Assignment is proven once, on the simplest shape.** Cycle 3 proves, against the real Clear,
  that a partial exercise lands on the vault's claim; that `rollClose` redeems it and emits
  `RollClose` with the true count; that the keeper's own pre-close read agrees (9n called directly,
  and 9 inside the tick); that the keeper stores and alerts 9 from the event; that the protocol
  fee is taken on strike proceeds; that the queue settles pro rata on the post-assignment NAV;
  and that `contractsAssignedAt` answers `null`, not 0, on the real `TokenNotFound`. It does not
  prove:
  - more than one exerciser, or more than one `exercise` transaction. An exercise spread across
    several transactions is untested.
  - the Clear's fee branch. `feesEnabled` is false on the live chain (`feeBps` 15), so the debit
    was `9 × strike` with fee 0, and the fee path of that debit is untested.
  - Valorem's bucketed fair assignment. The vault is the only writer of its option type, so every
    exercised contract lands on its one claim; allocation across several writers' claims is not
    exercised.
  - a guardian `rollClose` (anyone, from an hour after expiry). The keeper sent it.
  - the resolver's fallback inside a tick. The `claim-preread` and `unknown` branches ran only on
    a copy of the receipt with `RollClose` removed, and the mismatch warning only in
    `roll.test.ts`; with the deployed bytecode every tick takes the event path.
- **Observability gap, noted and not fixed.** The `roll_close` alert for an assigned week has the
  same shape as an unassigned filled week — `cycle 3 closed: 2044.079259 USDG harvested,
  1839.671334 to depositors.` — with no assignment wording; the count travels only in
  `data.contractsAssigned`. The alert and the tape present the 2025 USDG of strike proceeds,
  which is returned principal paying for the 9 NVDA delivered, as "harvested", and `/cycles`
  serves `gross_usdg6` 2044079259 beside `contracts_assigned` 9 with no field that separates the
  19.079259 premium from it.
- **A non-default `DRYRUN_DEPOSIT` is not a proven configuration for cycle 3.** The closed-form
  checks (6.4 NVDA out, zero dust, floor(2/5) of net, `usdgOwed` 0 or 1 by divisibility) are
  asserted only at the default 25e18. The general checks that remain — index delta =
  floor(net × 1e27 / totalSupply), `usdgDust` = net − credited, and gross = escrow + claim + fee
  + dust + owed — assume no `usdgDust` carried in from an earlier cycle. The Distributor folds
  carried dust into the next pot; at 25e18 the index is exact and there is none to carry, but at
  another deposit cycle 1 can leave some, and those assertions can then fail on arithmetic rather
  than on a defect.
- **`index.ts` was not exercised**: the poll timer, the tick-in-flight guard, and the SIGTERM
  path that finishes a tick before exiting. The container run in `ops/deploy.md` 10.6 covers
  boot-and-exit only.
- **Cooldown suppression was not observed.** The only alert kinds that recurred were `roll_open`
  and `roll_close`, which `roll.ts` force-sends past the cooldown; the exact five-alert list
  proves the bypass, not the suppression.
- **Multi-listing and relist budgets were not exercised**: no cancel, no partial fill, no
  `invalidateAllListings` by a guardian, no second listing within a cycle. `relists_used` stayed 0
  in all three cycles.

## Two failures first, and what they taught

The passing run above was the third attempt on 2026-09-13. Both earlier attempts are worth
keeping, because each is a trap the next operator will otherwise rediscover.

1. **`anvil_setBalance failed: … metadata is not found, 61566835`** at the very first step, on a
   fork that had been running for about 35 minutes. The public RPC keeps historical state for
   only a trailing window of roughly 4,000–8,000 blocks (measured: `eth_getBalance` at head-4000
   answered, head-8000 did not); an anvil fork asks the upstream for every account and slot it has
   not seen yet, *at the fork block*, and those lookups fail once the block leaves the window.
   The backup RPC (publicnode) refuses archive reads outright. **Start anvil, run immediately.**
   The run takes ~20 s.
2. **`approveListing would revert: The contract function "approveListing" reverted.`** with no
   error data, after a successful `rollOpen`. `debug_traceCall` showed the vault DELEGATECALLing
   `0x1111111111111111111111111111111111111111`: the `Vault.json` in `contracts/out` had been
   compiled with `SeaportOrderLib` **pinned** to that placeholder (`metadata.settings.libraries`),
   so `linkReferences` named only `ValoremLib` and the harness linked only that. `forge build`
   against the committed `foundry.toml` produced a clean artifact (both libraries as link
   references, no pinned addresses) and the run passed. The harness now refuses any artifact with
   pinned libraries and says so. This is also the run that showed `tx_revert` alerts carried no
   error name at all — `describeError` now appends the decoded custom error and its arguments.
