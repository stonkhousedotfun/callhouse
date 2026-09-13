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

## Result

| | |
|---|---|
| Date | 2026-09-13T01:57:20Z |
| Outcome | **passed**, both cycles, every assertion |
| Wall clock | 20.2 s (harness start to report written) |
| Fork | anvil `v1.6.0`, `--fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663`, fork block **61583084**, head timestamp 1789264637 |
| Feed | `mock` — MockFeed seeded with the real Chainlink RHNVDA/USD answer at the fork block, `21829793457` (218.29793457 USD) |
| Keeper code | `roll.ts` (`reconcile`, `tick`), `state.ts`, `policy.ts`, `seaport.ts`, `overcallApi.ts`, `alerts.ts`, `health.ts`, `clients.ts`, `config.ts`, `abi.ts`, `logger.ts` — all imported unmodified after the harness set the environment |
| Not exercised | `index.ts` (the timer loop and SIGTERM handling; the harness calls `tick()` directly) |
| Commit | uncommitted tree of 2026-09-13; `contracts/out` rebuilt with `forge build` immediately before (see "Two failures first") |

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
| Vault "Callhouse NVDA (dry run)", cap 50 NVDA, launch policy | `0x07fF75F92DAC990C0Bf49690A50b9e129f4C14A6` | `contracts/out/Vault.sol/Vault.json`, linked by the harness |

Real contracts used at their live addresses: Valorem Clear `0x9a7b…C0C0`, Seaport 1.6
`0x0000…B395`, NVDA `0xd060…9EEC`, USDG `0x5fc5…d168`, Multicall3 `0xcA11…CA11`, the real NVDA
registry `0x8E97…f4EA` (read only, for the live series), the Overcall fee recipient
`0xdAe7…0782`.

## Cycle 1 — the live series, filled

The real registry's cycle 1 at the fork block, mirrored verbatim into MockRegistry:

| | |
|---|---|
| option ids | `1130256…413056`, `2965259…491776`, `1395615…458752`, `8012928…807488`, `5688539…297792` (the five real NVDA rungs) |
| strikes | 226 / 231 / 236 / 241 / 246 USDG |
| exerciseTimestamp / expiryTimestamp | 1789761600 (Fri 2026-09-18 20:00 UTC) / 1789848000 (Sat 2026-09-19 20:00 UTC) |
| spot (vault.spotUsdg) | 218.297934 USDG |
| band [3%, 12%] | [224.846872, 244.493686] → the keeper picked **226**, the nearest in-band rung |
| deposit | 25 NVDA → 25 cNVDA (1:1) |
| size | floor(25 × 95%) = **23 contracts** |
| ask | policy floor ceil(218.297934 × 0.40%) = **0.873192 USDG / contract**; the stub book had no fills |
| gross / to vault / to Overcall | 20.083416 / 19.079259 / 1.004157 USDG (fee floored per contract: 0.043659 × 23) |
| order hash (Seaport `getOrderHash` == keeper's local hash) | `0x80cab743c14911ff216e07bcd43016964b9c07e308a59d11f8af62712162c5ea` |

Sequence, with the keeper's transactions (from `state.db` → `txs`, all `success`):

| # | Who | What | Tx | Block | Gas |
|---|---|---|---|---|---|
| 1 | harness | NVDA.approve(vault) | `0x4f4c3ed0bc8ec13cf8c6958f1aae215300dced9a9207433ba5e08490513742df` | 61583092 | 63,637 |
| 2 | harness | vault.deposit(25e18) | `0xe0baa0813fa7370b508f32f808bad8dc63149a180e141f3fdf71a709463ec7e0` | 61583093 | 163,953 |
| 3 | **keeper, tick #1** | vault.rollOpen(226-rung, 23) → real Valorem wrote 23 calls | `0xd67548b908c770d0bfee1bce542b04650318f34052b8e3391f236c9c6ca64361` | 61583094 | 465,016 |
| 4 | **keeper, tick #1** | vault.approveListing(components) → real Seaport `validate()` | `0xda5e4383fa8445b7eaba9c3f9030387ba0670083d916a4183e47fdc11e78c31d` | 61583095 | 212,028 |
| — | **keeper, tick #1** | `POST /api/orders?market=NVDA` → 201; listing row `posted`; alert `roll_open` | | | |
| — | **keeper, tick #2** | Seaport says open; `GET /api/orders/0x80ca…` → open; listing row `visible` | | | |
| 5 | harness (buyer) | USDG.approve(seaport, 20.083416) | `0xa3c300f36bcbbc6e546437ffce1d8740ad5f435efd89d3de8c5fded35298406a` | 61583096 | 57,904 |
| 6 | harness (buyer) | seaport.fulfillOrder — parameters and signature taken from the keeper's own `GET /orders`; the 65-byte placeholder signature was accepted through the vault's EIP-1271 | `0x2cbc19027f92e131ce2b965f4bb44bd8c3c0311a4207f8b3b1b01b658d4df918` | 61583097 | 147,637 |
| — | assert | vault USDG +19.079259; fee recipient USDG +1.004157; buyer holds 23 option tokens | | | |
| — | **keeper, tick #3** | Seaport `getOrderStatus` → totalFilled 1 / totalSize 1; listing row `filled` | | | |
| — | harness | `evm_increaseTime` to 1789761660 (exercise + 60 s) | | | |
| 7 | **keeper, tick #4** | vault.lockBook | `0xa15b7b5e076389b3f7e399dc7514b7c4b3f092e1e0035355a4a4bb06b4982680` | 61583099 | 64,345 |
| — | harness | warp to 1789848060 (expiry + 60 s) | | | |
| 8 | **keeper, tick #5** | vault.rollClose → Valorem redeem, harvest, settle | `0x94cbcab4e91a521515dde733c229008c6ab93b9b1dd988f18172b35681163522` | 61583101 | 260,935 |
| — | **keeper, tick #5** | Harvest summed from `Harvest` logs (rollOpen block → rollClose block): gross **19.079259**, fee **1.907925**, net **17.171334**; contracts assigned 0; alert `roll_close` | | | |
| 9 | harness (depositor) | vault.claimUsdg → received exactly `claimableUsdg` = 17.171334 USDG | `0x4d9365d6362e97dac12e6fb2133452810c6b60ff09f9e1c11c2e23a690e0e7cd` | 61583102 | 124,998 |
| — | assert | phase Idle; idleAssets = 25 NVDA (all collateral back, the call expired out of the money) | | | |

## Cycle 2 — fresh series, rolled while the keeper was asleep, unfilled

| | |
|---|---|
| feed | `MockFeed.setAnswer(21829793457)` after the warp, so `updatedAt` is fresh (`0xbb168799…274a8c`) |
| new option types on the **real** Valorem Clear (`newOptionType`, NVDA 1e18 / USDG) | strikes 225 / 230 / 234 / 239 / 243 USDG; exercise 1789851661, expiry 1789938061; txs `0xf2033e03…`, `0x499c3edc…`, `0xc32cbd3b…`, `0xaa5536b0…`, `0x0dfd6188…` (blocks 61583104–61583108) |
| MockRegistry.setCycleWithStrikes(cycle 2) | `0x88b68ae8f93690516bf64c4da4a580a7bc710e6a5356ed03a0f6113fde804ea9` |
| plan (computed with the production picker, `pickWrite`) | 225-rung (3.07% OTM), 23 contracts |
| **vault.rollOpen sent by the harness with the keeper's key, no `state.db` row** — the "rolled while asleep" case | `0xa726560e5d4f9b6cfbde44d15366bffaef93ffcd2170d0e2865011ca4bb1ff36`, block 61583110 |
| **keeper `reconcile()`** | log `adopted an open cycle the database had no record of`; row 2 created `open` with option id, strike, contracts from chain and `roll_open_tx: null` |
| **keeper tick #6** | phase Listed, `listingHash` zero → `maybeRelist` → `repriceFromPolicy` (floor 0.873192; the book's only fill is on cycle 1's rung, ignored) → vault.approveListing `0xa2afde38429918b9a17d1dd94d9ff0eccd07ed06fbffd4e092baeb0e6119c1ce` (block 61583111, 212,220 gas) → `POST` → 201; `relists_used` stays 0 (a first listing is not a relist) |
| order hash | `0x798e7d3a093e242ccdc3469a2751897f943f9edb13086d89a1590319542f304d`, Seaport counter `301443738899834494477627151987492641784` (bumped by cycle 1's lockBook/rollClose invalidations; re-read live, as ForkLive.t.sol says it must be) |
| **keeper tick #7** | `GET /api/orders/0x798e…` → open; listing `visible`. Nobody fills. |
| warp to exercise + 60 s; **keeper tick #8** | vault.lockBook `0x08991fca8979283b25de6d2f4c432d5a5e8f08bc086fa28703d40be4bc4b6e95` (block 61583113); listing row → `expired`; `DELETE /api/orders/0x798e…` sent; `/orders` serves nothing |
| warp to expiry + 60 s; **keeper tick #9** | vault.rollClose `0x8419b0540b8e14fe9db45bf57e9c0c1efb021ad9b608b8c4f849600b5b372b52` (block 61583115, 143,069 gas); log `no rollOpen block on record; harvest read from the rollClose receipt alone` (correct for an adopted cycle); cycle 2 `closed`, gross **0**, fee 0, net 0; alert `roll_close: cycle 2 closed unfilled: 0 USDG harvested.`; idleAssets = 25 NVDA |

## state.db after the run (reopened from disk after `store.close()`)

`{"cycles":2,"listings":2,"txs":7,"alerts":3,"meta":3}` — identical before and after reopen.

**cycles**

| cycle | status | option_id | strike | contracts | roll_open_tx | lock_tx | roll_close_tx | gross / fee / net (USDG6) | assigned | relists |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | closed | `1130256…413056` | 226000000 | 23 | `0xd67548b9…` | `0xa15b7b5e…` | `0x94cbcab4…` | 19079259 / 1907925 / 17171334 | 0 | 0 |
| 2 | closed | `1088483…643392` | 225000000 | 23 | **null** (adopted) | `0x08991fca…` | `0x8419b054…` | 0 / 0 / 0 | 0 | 0 |

**listings**

| order_hash | cycle | contracts | unit_price6 | gross | to_vault | to_overcall | end_time | status | api_status | seaport filled/size |
|---|---|---|---|---|---|---|---|---|---|---|
| `0x80cab743…62c5ea` | 1 | 23 | 873192 | 20083416 | 19079259 | 1004157 | 1789761600 | filled | open | 1 / 1 |
| `0x798e7d3a…2f304d` | 2 | 23 | 873192 | 20083416 | 19079259 | 1004157 | 1789851661 | expired | open | 0 / 0 |

Both rows' `components_json` rehydrate to components whose local hash equals the authorised
hash (that is what `/orders` served and what the buyer filled with). `signature` is the 65-byte
placeholder on both.

**txs**: the seven keeper transactions in the tables above, every one `success` with block and
gas recorded. **meta**: `last_heartbeat_ms` and one `book_poll_ms:<hash>` per listing.

## Alerts captured at ALERT_WEBHOOK, in order — exactly these three, nothing else

1. `[info] roll_open` — cycle 1: wrote 23 contracts at strike 226 USDG
2. `[info] roll_close` — cycle 1 closed: 19.079259 USDG harvested, 17.171334 to depositors.
3. `[info] roll_close` — cycle 2 closed unfilled: 0 USDG harvested.

No `tx_revert`, `api_reject`, `listing_invisible`, `low_gas`, `rpc_lag`, `phase_stuck` or
`keeper_error` was raised. No `boot` alert, because `index.ts` (which emits it) is not part of
the harness. Cycle 2's `rollOpen` was the harness's, so there is correctly no second `roll_open`.

## Requests the Overcall stub received, in order

```
GET    /api/orders?status=filled&limit=50            tick #1: last fill on the chosen rung  -> none
GET    /api/orders?status=filled&limit=50            tick #1: last fill on any live rung    -> none
POST   /api/orders?market=NVDA                       tick #1: 201
GET    /api/orders/0x80cab743…                       tick #2: visible
GET    /api/orders?status=filled&limit=50            cycle 2, tick #6: reprice from the book -> only cycle 1's rung, ignored
POST   /api/orders?market=NVDA                       cycle 2, tick #6: 201
GET    /api/orders/0x798e7d3a…                       cycle 2, tick #7: visible
DELETE /api/orders/0x798e7d3a…                       cycle 2, tick #8: after lockBook
```

Every POST body was `{chainId: 4663, components, signature}` with `content-type:
application/json` and no authorization header, and the stub derived the same order hash from the
components that the vault had authorised.

## Health endpoints

- `GET /health` after `reconcile()` (no tick yet): `200 {"status":"ok"}` — the boot grace window;
  `keeper.hasKeeperRole: true`, `vault.registryCycleNumber: 1`.
- after cycle 1: `200 ok`, `checks: {heartbeat: true, rpcLag: true, gas: true}`,
  `lastHeartbeatAgeSeconds: 0`, `db.rows: {cycles:1, listings:1, txs:4, alerts:2, meta:2}`.
- final: `200 ok`, `db.rows: {cycles:2, listings:2, txs:7, alerts:3, meta:3}`.
- `GET /cycles` after cycle 1 listed the closed cycle with gross 19079259.
- `GET /orders` served the live listing with `parameters` (OrderParameters, counter dropped,
  `totalOriginalConsiderationItems: "2"`) and the placeholder `signature`; a real Seaport fill
  went through with that exact payload.
- Note, not a defect: `/health` and `/state` report the vault phase from the **last tick's**
  snapshot, which is taken before that tick acts. Immediately after the `rollClose` tick they
  still say `Exercisable`; the next tick says `Idle`.

## What was stubbed, skipped, or is not proven by this run

- **The Overcall registry is a mock.** The real one's cycle is set by Overcall's operator. Cycle 1
  used the real option ids, strikes and timestamps read from the real registry at the fork
  block, so the vault's `ValoremLib.writeCalls` window check ran against real Valorem option
  types. Cycle 2 used option types the harness created on the real Clear.
- **The price feed is a mock seeded with the real answer.** The vault's `StalePrice` gate with
  the real feed is covered by `contracts/test/fork/ForkLive.t.sol`, not here. `DRYRUN_FEED=real`
  runs cycle 1 against the real feed and stops (a one-week warp makes it stale, correctly).
- **Overcall's listings API is a stub.** It implements the recon-R3 shapes and status codes and
  the keeper's client ran unmodified against it, but the real validator's nine checks (and its
  500 on a hash mismatch) were not exercised. That needs a mainnet listing.
- **Token balances were written into storage** (NVDA at the ERC-7201 slot
  `0x52c63247…bace00`, USDG at base slot 1). Nobody here holds real Stock Tokens.
- **Assignment was not exercised.** Both cycles expired out of the money; `contracts_assigned`
  is 0 by fact, and the pre-`rollClose` claim read was taken but not tested against a non-zero
  value. `VaultAssignment.t.sol` covers the vault side; the keeper's `contractsAssignedAt` path
  with a real exercise is still untested.
- **`index.ts` was not exercised**: the poll timer, the tick-in-flight guard, and the SIGTERM
  path that finishes a tick before exiting. The container run in `ops/deploy.md` 10.6 covers
  boot-and-exit only.
- **Cooldown suppression was not observed**: no condition recurred inside the run.
- **Multi-listing and relist budgets were not exercised**: no cancel, no partial fill, no
  `invalidateAllListings` by a guardian, no third listing. `relists_used` stayed 0 in both cycles.

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
