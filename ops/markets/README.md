# ops/markets — the market registry

`tier1.json` is the one list of markets Stonkhouse runs. Every market-specific value in the
system is derived from it; nothing else may hard-code a ticker, a token, a feed or a factory.

| File | What it is |
|---|---|
| [`tier1.json`](tier1.json) | The registry. GENERATED; a few fields, the `shared` block and the `v2` blocks are hand-maintained (below) |
| [`dev.json`](dev.json) | The LOCAL DEVNET registry (INTERFACE_VERSION 8). Not production, not a copy of it: every wallet is a public anvil dev account and `--check` refuses a production address in it |
| [`v7-legacy.json`](v7-legacy.json) | The FROZEN v7 production registry, kept readable for the run-off. `build-markets.mjs` refuses to touch it; `ops/v2-env.mjs --registry ops/markets/v7-legacy.json` still renders the v7 service env |
| [`v2-sources.json`](v2-sources.json) | The F2-02 recon (`ops/recon/r13-probe.mjs`, `ops/recon/R13-v2-sources.md`): Uniswap v3 pools, TWAP class, Data Streams ids, proposed strike ticks. The `v2` blocks were filled from it and `--check` cross-checks pools against it |
| [`build-markets.mjs`](build-markets.mjs) | Builds and verifies it. Node 22 + `cast`, no npm dependencies |
| [`derive-keeper-keys.sh`](derive-keeper-keys.sh) | One keeper hot key per market from the ops mnemonic; writes the keys under `~/.callhouse-keys/markets/` and the addresses into the registry |
| [`../v2/derive-bot-keys.sh`](../v2/derive-bot-keys.sh) | The three v2 bot keys (cranker 50, pricer 51, MM quoter 52) into `~/.callhouse-keys/v2/`; writes only their addresses into `v2.bots` |

Consumers, and what each reads:

| Consumer | Reads |
|---|---|
| `contracts/script/DeploySoloBatch.sh` | `asset`, `feed`, `depositCap`, `ticker`, `deployment.keeper`, `deployment.guardian`; writes `deployment.factory`, `implementation`, `deployBlock`, `deployTx` back |
| `ops/keeper-env.sh` | everything a keeper needs: `deployment.factory`, `asset`, `feed`, `mode`, `cboe.url`, `strikeOtmBps`, `minAskUsdg6`, `targetDelta`, `priceEdgeBps`, `premiumMarginBps`, `v1RunOff` → `ops/keeper/markets/<TICKER>.env` (live, planned and superseded-by-v2 rows) |
| `ops/v2-env.mjs` | top-level `v2.contracts`, `v2.deployBlock`, `v2.interfaceVersion` → `ops/v2/env/<service>.env` for production or `ops/v2/env-dev/<service>.env` for dev |
| `ops/go-live-v2.sh` | top-level `v2` (refuses null contracts, deploy block or bot addresses), `v2.bots` against the bot key files, markets with `v2.status == "live"` (`ops/deploy.md` §15) |
| `web/scripts/gen-markets.mjs` | `ticker`, `name`, `asset`, `feed`, `deployment.factory`, `deployment.deployBlock`, `status`, `mode`, `cboe.root`, `v1FrozenAt`, each market's `v2`, the top-level `v2` → `web/lib/markets.generated.ts` |
| `keeper/src/v2` | the pricing service reads `ticker`, `feed`, `cboe`, `defaults`; the v2 bots read the `v2` blocks |
| `callhouse-docs/product/markets.md` | rendered by `ops/markets/render-docs.mjs`: `ticker`, `asset`, `feed`, `feedDescription`, `status`, `v1RunOff`, `v1FrozenAt`, `deployment.factory`, `deployment.deployBlock`, each market's `v2` including `payoutRoute`, `v2.contracts.accessManager`, `v2.flywheel`, `shared.safes`, `shared.usdg`, the provenance fields, `observedBlock` / `checkedAt` of `v2-sources.json`, and the interface-7 set in `v7-legacy.json` |
| `ops/runbooks/*.md` | loop over `status == "live"` |

## What is in a market row

```
ticker            AAPL                                   from the feed name; equals the token's symbol()
name              Apple • Robinhood Token                issuer's token name (R6 list)
asset             0x6B22…                                the Stock Token (18 dp), EIP-55
assetDeployBlock  48276                                  from the R6 list
feed              0x…                                    Chainlink proxy (8 dp), the factory's priceFeed
feedSvr           0x…                                    the SVR (secondary) proxy, recorded, not used
feedAggregator    0x…                                    the aggregator behind the proxy at build time
cboe              { root, url, weekly, rows, currentPrice, spotDivergenceBps, underlyingMatches, checkedAt }
mode              vol | fixed                            how the keeper prices the week (below)
depositCapUsd     10000                                  per-ACCOUNT cap in USD notional; null = uncapped
depositCap        "45000000000000000000"                 the same in token base units at the verified spot
strikeOtmBps      500                                    fixed mode: strike = spot + 5%
minAskUsdg6       "100000"                               v1 factory keeper ask floor (0.10 USDG); v2 ignores it
targetDelta / priceEdgeBps / premiumMarginBps            vol-mode knobs, keeper defaults
wave              live | canary | wave1 | wave2          the v1 rollout order (record of the cancelled plan)
status            live | planned | paused | superseded-by-v2
                                                         the v1 FACTORY lifecycle; superseded-by-v2 = was planned,
                                                         never deployed, the rollout was cancelled for v2 (ADR-02)
v1RunOff          true | false | absent                  true once the owner froze this v1 factory (ADR-10); absent = false
v1FrozenAt        1790000000 | null | absent             unix seconds of that freeze, set with v1RunOff: true; absent = null
verification      { block, feedDecimals, feedAnswer, feedUpdatedAt, feedAgeS, spotUsd, feedDescription,
                    tokenDecimals, tokenSymbol, uiMultiplier, oraclePaused, ok, issues[] }
deployment        { factory, implementation, deployBlock, deployTx, keeper, keeperKeyIndex, guardian,
                    admin, feeRecipient, sourcify, configuredAt }     hand-maintained / written by scripts
v2                { status, wave, strikeTick, puts, mintFeePpm, univ3Pool, univ3MinLiquidity,
                    dataStreamsFeedId, payoutRoute, overrides, registeredAt, registerTx }
                                                                      the v2 market (below), hand-maintained
```

**Hand-maintained fields** (the builder preserves them; everything else is regenerated):
`deployment.*`, `wave`, `status`, `depositCapUsd`, `strikeOtmBps`, `minAskUsdg6`, `targetDelta`,
`priceEdgeBps`, `premiumMarginBps`, `modeOverride`, `v1RunOff`, `v1FrozenAt`, `notes`, each market's `v2`
and the top-level `v2`.

`minAskUsdg6` only feeds the v1 factory keeper through `ops/keeper-env.sh` as
`KEEPER_MIN_ASK_USDG6`. Changing it does not change v2 market-maker quotes. The v2 bot prices
asks from fair value and a half-spread (at least `MM_MIN_HALF_SPREAD_USDG6`, default 0.02 USDG
per share), then clamps them to `MakerVault.askFloor(longId)`; see `keeper/src/v2/mm/engine.ts`.

**`superseded-by-v2`.** On 2026-09-16 the per-market factory rollout (canary TSLA+AAPL, then
waves) was cancelled: v2 lists every market on one clearinghouse. The 34 rows that were `planned`
became `superseded-by-v2`; NVDA stays `live` on its v1 factory. A superseded row never has a
factory (`--check` refuses one: a deployed factory is run off, not superseded). Consumers: the
keeper env files stay byte-identical (`ops/keeper/markets/README.md`), the docs page lists every
market by its `v2` block and keeps only live or paused v1 factories in its legacy section (it
refuses a v1 `planned` row), and the web app's v1 "next" list leaves them out.
A market the builder sees for the first time enters as `superseded-by-v2` with a planned `v2` block.

**`v1RunOff`** is the v1 run-off switch for one market's factory keeper. Set it to `true` only after
that factory has been frozen (`writesHalted`, `depositCap` 0: the owner-run v1 freeze); then
`ops/keeper-env.sh` writes `SOLO_WIND_DOWN=1` into `ops/keeper/markets/<TICKER>.env`, and the keeper
stops calling `setWeek` and `listFor`, keeps settling expired accounts, and alerts `v1_drained` once
when no account is live or pending. `true` on a market with no `deployment.factory` is refused.
Absent and `false` render the same file. The v1 freeze runbook (O2-05) sets `v1RunOff: true`
together with **`v1FrozenAt`**, the unix seconds of the freeze (`FreezeV1`: `setWritesHalted` +
`setDepositCap(0)`); until then `v1FrozenAt` is absent or null. `--check` refuses a `v1FrozenAt` that is not a positive integer, or one on a market without
`deployment.factory` or without `v1RunOff: true`. The web app exports it per market
(`v1FrozenAt(ticker)` in `web/lib/markets.ts`) and the docs page prints the freeze date in the
legacy v1 table.

## The shared block (INTERFACE_VERSION 8)

```
shared.chainId        4663
shared.usdg           0x5fc5…                 fixed facts of chain 4663
shared.clearinghouse  0x53d7…                 the V1 Clearinghouse, still read by the v1 run-off
shared.seaport        0x0000…
shared.multicall3     0xcA11…
shared.admin          null | address          the ADMIN SAFE (2-of-3, V3-D1/D10). Same address as shared.safes.admin
shared.guardian       null | address          the GUARDIAN holder: owner hot-wallet index 2 (T-OP-160). Same address as v2.bots.guardian
shared.feeRecipient   null | address          the FeeSplitter. Same address as v2.flywheel.feeSplitter
shared.opsWallet      null | address          the hot ops wallet the Treasury Safe tops up for bot gas
shared.safes          { admin, treasury }     the two Safes; they may not be one Safe
shared.token          { address, symbol, decimals,
                        poolKey { currency0, currency1, fee, tickSpacing, hooks }, poolId }
                                              STONKHOUSE and the pinned Pons LAUNCH-HOOK v4 pool the buyback buys it on
```

**`shared` is hand-maintained from INTERFACE_VERSION 8.** Until v7 the builder rewrote it from a constant on
every run, which is why `dev.json` could not stop being a copy of production: a rebuild put production's
admin, guardian and fee wallets straight back into it. Only a registry with no `shared` block at all gets
the skeleton now. The key set is closed like every other block, and `poolKey` and `poolId` are filled in
together — `--check` recomputes `keccak256(abi.encode(PoolKey))` with `cast` and refuses an id that names a
different pool.

**`shared.token.poolKey.hooks` MUST name the Pons launch hook, and the pool is native-ETH-quoted.** (This
paragraph said "may only be the zero address" until T-OP-108; that rule was inverted by the owner ruling of
2026-09-21 / T-OP-012 and the validator has refused a hookless key since — `V4BuybackExecutor` requires the
key's hook to have code and to be the PoolManager's registered launch hook. The zero-hooks rule of V8-DESIGN
6A still governs `v2.payoutRoute` keys, whose ids are recomputed with `hooks: address(0)` hard-coded.) The
committed values are DERIVED FROM CHAIN 4663, not from a document (T-OP-108, block 69,289,315, endpoint
`https://rpc.mainnet.chain.robinhood.com`): `address` is what the hook's `launches(poolId)` names as the
memecoin, `symbol`/`decimals` are the token's own, the five `poolKey` fields are the PoolManager's `Initialize`
log for the id at block 64,068,924 (`currency0` = the zero address = native ETH, which `DeployV2Batch.sh`
requires; `fee` 0 because the launch pool's fee is the hook's; `tickSpacing` 200; `hooks` the launch hook),
and `poolId` is re-asserted as `keccak256(abi.encode(poolKey))`. `build-markets.test.mjs` pins all of that in
BOTH registries — `dev.json` must carry the same token because the dev deploy path reads it.

`v2.bots.{cranker,pricer,quoter}` are the owner's DERIVED keys (item 18 of `OWNER-QUESTIONS-2026-09-21`,
indexes 60-62 of `ops/v2/derive-bot-keys.sh`, written by T-OP-108 from the operator's read of the key-file
comment lines — the script itself reads the mnemonic and is owner-only). `shared.guardian` is NOT index 63
any more. OWNER RULING 2026-09-22 06:12Z (T-OP-160, Bridge M-0cebd9aff05944b4): the GUARDIAN holder is
**`0x29741A8d283a253E8Ce10aDfd04C6507438b6F39` = owner hot-wallet index 2**, the same EOA every v1 row
names as `deployment.guardian` (the v7 dev-launch guardian, `DECISIONS-2026-09-17`), because the owner wants
the GUARDIAN-gated calls (pause, veto, and once T-OP-159 lands `HouseVault.setLimits` at 0 s) under a wallet
they already hold. The owner's first choice, their index-0 wallet `0xEb82c3D0…9d9b`, was withdrawn on the
same day: that key is the v8 DEPLOYER (`DEPLOYER_PK`; the v7 admin every v1 row names as
`deployment.admin`), and `DeployV8._principals` refuses a guardian equal to the deployer. Measured at
block 69,439,947 on `rpc.mainnet.chain.robinhood.com`: `0x2974…6F39` has no code, nonce 0, 0.01 ETH
(≈2,000 pauses at the 0.055 gwei the coordinator measured 06:20Z); the retired `0x2875…A566` (index 63) has no code, nonce 0, 0 ETH. Index 63
is retired from the registry, not reassigned. `shared.guardian` IS `v2.bots.guardian`: the wrapper exports
it as `V2_GUARDIAN` (`DeployV2Batch.sh:667`) and `V2DeployBase.sol:234` grants that principal the GUARDIAN
role; the wrapper refuses a null `guardian` (`:314`). The contracts fixture
`script/v2/fixtures/registry-v8.json` does NOT mirror this value by coordinator decision (it keeps anvil #1,
a stand-in the unit tests sign with); `build-markets.mjs:118`'s "never the v7 one" comment predates the
ruling. `shared.admin`, `shared.opsWallet` and `shared.safes.*` are the owner's Safes and ops wallet
(T-OP-111, verified on chain); `feeRecipient` may be null (it IS the FeeSplitter the run creates). Do not
invent any of them. `dev.json` carries anvil keys in every one of these slots on purpose.

## v2 blocks

The v2 schema (plan `02-interfaces.md` §3, `v8-plan/03-INTERFACES.md` §4). Top level:

```
v2.interfaceVersion   8                       the frozen v2 interface version; build-markets.mjs INTERFACE_VERSION
v2.deployBlock        null | block             the v2 deploy block (written back by the deploy)
v2.contracts          clearinghouse, orderBook, settlementOracle, expiryCalendar, keeperRewards, autoRoller,
                      payoutAdapter, makerVault, makerRegistry, rewardsDistributor, accessManager,
                      sources { chainlink, univ3, dataStreams }          null until deployed; 14 addresses
                      + ACCEPTED WHEN PRESENT (T-OP-114): houseVault, houseVaultFactory, hedger,
                        rewardsDistributorLender, earnVault, stockVenueAdapter   the six the deploy wrapper's
                                                                        EXTERNAL_KEYS reads; written back by the
                                                                        externals step, never required, not counted
v2.externalDeployBlocks  houseVault, houseVaultFactory, hedger, rewardsDistributorLender, earnVault, stockVenueAdapter
                                                                        null | block per external (T-OP-114); refused
                                                                        null once its address is set; the indexer's
                                                                        V2_EARN/HOUSE_START_BLOCK source
v2.bots               cranker, pricer, quoter, guardian                 bot ADDRESSES (EIP-55) | null; ops/v2/derive-bot-keys.sh
v2.protocolAddresses  accessManager, makerVault, autoRoller, admin, guardian, feeRecipient, opsWallet,
                      cranker, pricer, quoter, feeSplitter, buybackExecutor, treasury,
                      distributors { maker, user, lender }              the protocol's own addresses (O3-204)
v2.flywheel           feeSplitter, buybackExecutor, deployBlock         the v8 flywheel (V8-DESIGN §6)
v2.uniswapV3          factory, swapRouter02, quoterV2                   4663 periphery (recon: code present)
v2.fees               premiumFeeBps 500, mintFeePpm 0, allowRent false, resaleFeeBps 0, takerFeeFlat "100000",
                      takerFeeCapBps 1000, makerRebateBps 5000, exerciseFeeBps 25
                                                                        launch values; the contracts hold the live ones
v2.vault              maxSeriesUnits "10000", maxTotalNotional "250000000000", askToleranceBps 100,
                      maxBidBpsOfSpot 1000, maxOrderLifetime 0, maxDailyOutflow "2500000000"
                                                                        the MakerVault Limits tuple, in setLimits order
v2.defaults           maxDeviationBps, uncorroboratedDelayS, spotMaxAgeS, ladder { weekly, daily }, expiriesAhead
```

**INTERFACE_VERSION 8: the fee rules are INVERTED, both of them.** v7 refused `premiumFeeBps > resaleFeeBps`
(a writer could mint outside the book and resell at the 0 % resale fee) and refused a rent of 0 (the rent
*was* the writer fee). v8 closed the minting hole — `mint` is callable only by an allowlisted minter, so
every long that exists was created inside a fill with a known premium — and the writer fee is the 5 %
premium fee again. So `--check` now refuses **`premiumFeeBps <= resaleFeeBps`**, and refuses **any non-zero
`mintFeePpm`**, shared or per market, unless the registry carries **`v2.fees.allowRent: true`**. The rent
code stays in the Clearinghouse as a dial at zero and can be switched on later under the 72 h
MARKET_FEE_MANAGER lane; the flag is how that decision is written down instead of arriving as a number in
a diff. Both directions of both inversions are asserted in `build-markets.test.mjs`, because a
half-inverted pair of checks accepts every registry or none.

**`v2.flywheel`** is its own block, never a `v2.contracts` key: that set is closed and counted, and a
flywheel address there would be copied into generated code `/v2/config` does not expose. It carries its own
`deployBlock` because the splitter is constructed **before** the core (it is the core's fee recipient), so
its first event can precede `v2.deployBlock`.

**The six external contracts (T-OP-114).** `houseVault`, `houseVaultFactory`, `hedger`, `rewardsDistributorLender`,
`earnVault` and `stockVenueAdapter` are the contracts DeployV8 does **not** create: callhouse-contracts
`script/v2/lib/registry-env.sh:413` names them `EXTERNAL_KEYS`, reads each from `v2.contracts.<key>` and hands it
to DeployV8 by environment (unset when absent or null, which DeployV8 reads as "not supplied"); T-OP-116's externals
step deploys them after the core and writes each back under the same path. The builder now **accepts** those six
keys under `v2.contracts` — present or absent, and when present null or an address — without adding them to
`V2_CONTRACT_NAMES`, so the 14-count every mirror closes over (`finish-dev-deploy.sh`, the keeper, `gen-markets.mjs`,
`render-docs.mjs`) is unchanged, and without requiring them once `v2.deployBlock` is set, because the externals
step runs after DeployV8 and the owner's item-19 decision may skip two of them. A seventh name is still refused.
**The committed registries and `V2_SKELETON` do not carry the keys yet**, on the coordinator's ruling
(M-ad3328c276524acb): `render-docs.mjs` and `web/scripts/gen-markets.mjs` still throw on them, so the consumers row
widens those two and adds the six to the skeleton and both registries in one commit; the first address reaches
`tier1.json` only by write-back after that. `v2.externalDeployBlocks` is the start-block slot T-302 asked for, one
per external, and unlike the six address keys it is an ordinary closed block — in the skeleton and in both
registries now, all null, exact-keyed — because a new top-level `v2` block breaks no consumer
(M-b3f5ca18efa5443f). The indexer refuses `V2_EARN_VAULT` / `V2_HOUSE_VAULT_FACTORY` without `V2_EARN_START_BLOCK` /
`V2_HOUSE_START_BLOCK` (`indexer/lib/env.ts:241-270`), and `ops/v2-env.mjs` is where a group's value is derived from
its members. The block is coupled to the address the way `v2.flywheel.deployBlock` is to `feeSplitter`: an external
written back under `v2.contracts.<key>` with `externalDeployBlocks.<key>` still null is refused by name, so the
externals step writes the two together.

**`v2.bots` is a new key set, and the keys themselves are new** (06-QUIRKS §G). `mmQuoter` became `quoter`
(the role is QUOTER on the manager, not a vault role), `guardian` joined it, and the cranker is no longer
roleless — it holds BUYBACK and cranks `FeeSplitter.buyback`. Indices 60–63 of the ops mnemonic; v7's
50–52 are **not** reused, because v7 runs off beside v8 and a shared key would make one incident two.

**`v2.protocolAddresses` (O3-204, plan §3.3).** The addresses that belong to the protocol rather than to a
user: what scoring flags `protocol` and what `maker-epoch.mjs` never allocates to a maker. It is not a
`v2.contracts` key — that block is closed and counted in three places — and it does not replace the blocks that
hold the contract slots: it mirrors them. `build-markets.mjs --check` refuses a malformed address, a missing key,
a key that has drifted from its twin (`null` included) and one address under two keys.

INTERFACE_VERSION 8 closes the gap O3-204 left. In v7 `feeSplitter`, `buybackExecutor` and `treasury` had no
twin and sat null "until their phase" — which is exactly the hole this block exists to prevent. Their blocks
exist now (`v2.flywheel`, `shared.safes`), so **every key but `distributors.user` and `distributors.lender`
mirrors something**;
`accessManager` and `opsWallet` joined for the same reason. Two further v8 changes:

- **Null is allowed before the deploy, and refused after it.** v7 refused a null `admin` / `guardian` /
  `feeRecipient` outright. In v8 all three are addresses the launch itself produces (the Admin Safe, a fresh
  guardian hot key, the FeeSplitter), so the rule moved to `v2.deployBlock`: once the registry says a
  deployment exists, the manager, both role wallets and the fee recipient may not be null.
- **Only one pair may name one address: `feeRecipient` is `feeSplitter`.** v7 let any two "wallet roles"
  overlap because the admin and the fee recipient were one hot EOA. In v8 the fee recipient is a contract,
  the two Safes are two Safes on purpose, the ops wallet is hot precisely so neither Safe has to be, and the
  guardian must not be able to sign as the Safe. A repeat there is what makes a delay or a 2-of-3 threshold
  decorative, so it is refused and the message names the pair.

`ops/devnet/devnet.mjs` rewrites the whole block in its (gitignored) registry copy, or the devnet's exclusion
list would name production wallets. `ops/markets/dev.json` is checked for the same thing by
`validateDevIsolation`, which refuses a `_dev` registry that names any production wallet, bot key, contract
or v1 factory. Chain addresses — USDG, Seaport, Multicall3, the Stock Tokens, the feeds, the Uniswap
deployment — are not the protocol's and are shared with production on purpose: a devnet is a fork of 4663.

**`v2.vault`** is the MakerVault `Limits` tuple the deploy sets: all six fields, in `setLimits` order, because a
call site that drops one does not encode. `maxDailyOutflow` is the leaky bucket on net USDG a quoter call may
pay out — at most the cap at once, at most twice the cap in 24 h — and must be > 0 (0 would deploy the vault
unable to bid, take or replace upwards; a spend freeze is a later `setLimits`).

### Three things are called a "wave", and they are not interchangeable (T-LP-06)

The registry used to state the v8 rollout twice, and the two disagreed — the top-level `waves` map
said `canary: [TSLA, AAPL]` while `markets[].v2.wave` said `canary: [NVDA]`. `DeployV2Batch.sh`
reads both, refuses a disagreement and dies, which is correct: a launch set cannot have two answers.
The duplicate v8 keys were removed from the top-level map. What each one is now:

| field | what it answers | who reads it |
|---|---|---|
| top-level `waves.live` | which markets are live on **v7 today** — the freeze input | `ops/v8/freeze-v7.mjs:135`, which refuses an empty list and cross-checks each ticker against `markets[]` |
| `markets[].wave` | the **v1** wave of that market | `ops/markets/build-markets.mjs:1105`, validated against `V1_WAVES` |
| `markets[].v2.wave` | the **v8** rollout wave — AUTHORITATIVE for v8 | `ops/v8/listing-calendar.mjs:209` (throws if absent), `keeper/src/v2/registry.ts:673`, `keeper/src/v2/pricing/coverage.ts:518`, `ops/v8/launch-packet.mjs:170`, `ops/markets/build-markets.mjs:1125` against `V2_WAVES` |

`waves.live` is NOT the v8 plan and must not be deleted: it is the only part of the top-level map
anything reads, and `[NVDA]` is correct there because NVDA is what is live on v7. The top-level map
carries no `canary` or `wave1` key any more — nothing ever read them, and they were the whole
disagreement. **Put a new v8 wave in `markets[].v2.wave` and nowhere else.**

Per market:

```
v2.status             planned | live | paused     live/paused need registeredAt + registerTx; live needs the contracts
v2.wave               canary | wave1 | wave2      canary NVDA; wave1 the 19 launch markets below; wave2 the 15 not launching
v2.strikeTick         "2500000"                   USDG base units per share, decimal string, a multiple of 100
v2.puts               false                       put ladders on (O2-07, after a clean week of calls)
v2.mintFeePpm         0                           the rent dial, 0 on every v8 market; a non-zero rate needs v2.fees.allowRent
v2.univ3Pool          0x… | null                  Uniswap v3 {asset, USDG} pool: the SETTLEMENT TWAP source only; fee tier ≤ 10000
                                                  (1 %, interface v6) and observation cardinality ≥ 2401 (interface v7, sign-off c10)
v2.univ3MinLiquidity  "1700000000000000000" | null harmonic-mean liquidity floor (raw pool liquidity), set with the pool
v2.dataStreamsFeedId  0x… (bytes32) | null        Chainlink Data Streams regular-hours id
v2.payoutRoute        null | { venue: "v3", fee } | { venue: "v4", fee, tickSpacing, poolId }
                                                  where a winning call's Stock Tokens (and the splitter's fee stock) are sold
                                                  for USDG. null = paid in kind. NOT univ3Pool: v4 has no observation array,
                                                  so a v4 route may never be a settlement source (interface v8)
                                                  O8-03 pinned 14 of the 20 launch markets from the 2026-09-17 recon
                                                  SNAPSHOT, offline, with no chain read; six are deliberately null. The rows
                                                  are PROVISIONAL and are re-measured immediately before OWN8-06 - the
                                                  snapshot does not satisfy OWN8-06's fresh v4 pool table. Per-ticker
                                                  reasons and the three snapshot caveats: ops/markets/PAYOUT-ROUTES-V8.md
v2.overrides          {}                          keys of v2.defaults this market replaces (e.g. expiriesAhead.daily 0)
                                                  uncorroboratedDelayS 3600 on the 18 Chainlink-only launch rows; a row that
                                                  still carries a v2.univ3Pool may NOT carry it (build-markets refuses the
                                                  pair): the shortened delay only ever applies on the day that pool is not
                                                  ok, which is the day the delay is doing its job
v2.registeredAt       null | unix seconds         written by the registration
v2.registerTx         null | tx hash
```

**How the 2026-09-16 values were chosen** (from `v2-sources.json`, probe block 65069842):

- `strikeTick` = the recon's `strikeTick` (the Cboe near-money listing increment, not the spot
  heuristic) in USDG base units: 0.5 → `"500000"`, 2.5 → `"2500000"`, 10 → `"10000000"`. O2-07
  re-checks the listed strikes before each wave.
- `univ3Pool` only where the recon class is `usable` (USDG balance ≥ 250,000, cardinality ≥ 300,
  30-minute observe works, TWAP within 100 bps of the feed) **and the observation ring is at least
  `MIN_POOL_OBSERVATION_CARDINALITY` (2401)**: **2 pools** — NVDA
  (`0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3`, fee 500, ring 6000) and SPCX (ring 3100). The recon's
  other 11 usable pools (AAPL, AMZN, CRCL, GME, GOOGL, MSFT, MU, QQQ, SGOV, TSLA, USO) have
  observation-ring **cardinality** of 1800–1860 **slots** — against the contract's
  `MIN_POOL_OBSERVATION_CARDINALITY = 2401` — and were dropped at INTERFACE_VERSION 7 (owner sign-off c10, `DECISIONS-2026-09-17` §7):
  a ring shorter than the settlement window plus the snapshot grace can be overwritten by one dust
  mint or burn per second before the snapshot is taken, so `UniV3TwapSource.setPool` refuses the pool
  and buying cardinality on mainnet was declined for launch. **33 markets are `null`**: the 11 shallow
  rings, 20 `thin` (a pool exists but fails the recon rule) and CRWV, ORCL with no pool. Those settle
  on Chainlink alone (uncorroborated delay) and pay out in kind. Revisit per market before expansion
  (O2-07).
- `univ3MinLiquidity` = the in-range liquidity at which the pool's USDG balance would sit exactly at
  the recon's 250,000-USDG usable threshold, scaled linearly from the pool's observed
  (`liquidity`, USDG balance) pair and rounded down to two significant figures:
  `floor(liquidity × 250,000 / usdgDepth)`. The floor enforces the same rule that made the pool
  usable, in the unit the contract checks. The scaling assumes the positions' shape does not change,
  so it is an estimate; pools near the threshold (AAPL 71 %, QQQ 78 %, MSFT 82 % of observed
  liquidity) can fall under it, and that market's Uniswap source then reports not-ok and settlement
  falls back to Chainlink with the uncorroborated delay, which is the intended failure. **Of the two
  markets that carry a floor today, SPCX has almost none of that margin**: its measured
  time-weighted harmonic minimum over the 11 closes of `univ3-liquidity-2026-09-17.json` is
  **106.4 % of its own floor**, against NVDA's 369.9 % (T-200; `ops/v8/liquidity-floors.mjs --report`
  recomputes both). Neither has failed a session, but SPCX is one change in the positions' shape away
  from the silent Chainlink-only fallback, and it is the market to re-probe first under O2-07. O2-07
  re-probes and re-derives before each wave. `--check` prints a note when current in-range
  liquidity is below the floor; it does not fail on it.
- `dataStreamsFeedId` = the recon's regular-hours id for every market. Only 14 appear in Chainlink's
  public discovery API; the rest are catalog candidates, and none may be enabled before the owner's
  Data Streams entitlement confirms it.
- `mintFeePpm` = **0** on every market from INTERFACE_VERSION 8 (V3-D18). v7's per-market rates — the
  `V7-DESIGN` §5.1 table, 5 (SGOV, SPY) to 1500 (NBIS) against a ceiling of 5000 — are preserved in
  `v7-legacy.json` and nowhere else; v8 charges the writer 5 % of the premium on first sale instead.
- `payoutRoute` = null everywhere until `O8-03` measures per-ticker v4 depth at a recorded block and
  pins one `PoolKey` per launch ticker. A market with no route pays a winning call in Stock Tokens,
  which is the designed fallback, not a failure: the Clearinghouse computes its own floor from the
  settlement price and pays in kind on any shortfall (V8-DESIGN §6A).

**`v2.defaults.spotMaxAgeS` = 90000 (25 h), no overrides (2026-09-17).** `SettlementOracle.spot()`
reverts once the Chainlink print is older than this, and the feeds print on a 0.5 % move or a 24 h
heartbeat (`feedThresholdPct`, `feedHeartbeatS`). Measured on all 35 feeds from 2026-08-03 to
2026-09-17 (33 regular sessions), the share of session time `spot()` would have reverted was:

| spotMaxAgeS | markets affected | worst |
|---|---|---|
| 3600 (the launch plan's value) | 35 | SGOV 100 %, SPY 88.6 %, NVDA 41.9 % |
| 43200 | 14 | SGOV 100 %, SPY 32.4 % |
| 86400 | 2 | SPY 0.011 % (heartbeat latency) |
| 90000 and above | 0 | none |

The oldest in-session print was 86,427 s old; no feed missed its heartbeat. The tradeoff: an accepted
spot can be up to 25 h old, which means a quiet feed's print (within 0.5 % of the price while the price
network runs), the previous session's print at the 09:30 open until the first deviation print, or a
stalled feed's print. The MakerVault's bid cap and ask floor and the AutoRoller's roll strike, roll ask and
reprice band all scale with that spot. Settlement does not read `spotMaxAge`: the window walk uses the
pinned `maxStale` (26 h). The bots quote only on a `/fair` answer, which is refused when the print is 300 bps
from Cboe. `ops/deploy.md` §15.13 has the contract lines, the keeper guards, their blind spot and the release
runbook; `ops/runbooks/incident-v2.md` §7 the broken-feed response. `build-markets.mjs --check` refuses an
effective `spotMaxAgeS` under a market's `feedHeartbeatS` + 1 h or over the oracle's 4-day ceiling.

**`uncorroboratedDelayS` (INTERFACE_VERSION 8).** The delay a market with one ok source waits before it
finalizes on an uncorroborated candidate. The default is 21,600 s (6 h); the owner's decision of 2026-09-19
drops it to 3,600 s on the Chainlink-only launch markets, and `O8-10` writes those rows. The mechanism is
here: an override is bounded to [900, 345600] — under one guardian veto window a single uncorroborated
source finalizes before anyone can veto it — and it is **refused on a market that still has a
`univ3Pool`**, because there the delay only ever applies on the day that source is not ok, which is exactly
when it is doing its job.

`build-markets.mjs --check` validates all of it (keys, enums, the tick, fee ceilings of
`V2Constants`, rent 0 unless `allowRent`, the vault limits, `premiumFeeBps > resaleFeeBps`, payout routes and
their recomputed v4 pool ids, overrides against `v2.defaults`, the spot age against the heartbeat, the
uncorroborated delay, pool with floor) and checks every pool twice:
offline, it must be a `usable` pool of that ticker in `v2-sources.json` with tokens {asset, USDG} and
an observation cardinality of at least 2401; on chain, `token0()`/`token1()` must be {asset, USDG} and
the factory's `getPool` must return it for its own `fee()`.

## The v8 launch set (O8-10)

Twenty markets go live on v8: **NVDA** as the `canary`, and these **19** in `wave1` —

| | | | |
|---|---|---|---|
| SPCX | SPY | MU | QQQ |
| SNDK | AAPL | MSFT | INTC |
| TSLA | META | AMD | GOOGL |
| AMZN | MSTR | PLTR | DELL |
| ORCL | TSM | CRWV | |

The other **15** rows stay `wave2` and are not part of the launch: **ASML BABA CLSK COIN CRCL EWY GME
IONQ NBIS RGTI RKLB SLV USAR USO** are deferred, and **SGOV is dropped**. SGOV is dropped because it
has no weekly expiries — its own row says so (`mode: "fixed"`, `modeReason: "no weekly expiries"`,
`cboe.weekly: false`), and a call ladder with only monthly expiries is not the product. The registry
has no `dropped` wave: `V2_WAVES` is `canary | wave1 | wave2`, so the drop lives in this paragraph
rather than in a value nothing else would understand.

**A row with a `v2.univ3Pool` may not carry `v2.overrides.uncorroboratedDelayS`.** `--check` refuses
the pair. The delay is what a market with one working source waits before finalizing on an
uncorroborated candidate, so on a market that still has a corroborating pool it only ever applies on
the day that pool is *not* ok — exactly when the delay is protecting settlement. Every launch market
but SPCX is Chainlink-only (their pools are under `V2Constants.MIN_POOL_OBSERVATION_CARDINALITY`) and
carries `uncorroboratedDelayS: 3600`; SPCX and the NVDA canary keep their pools and the 21600 default.
The 1800..86400 band is read from `src/v2/oracle/SettlementOracle.sol:202-203`, not reasoned.

Dailies were **verified on, not switched on**: `v2.defaults.expiriesAhead` is `{weekly: 2, daily: 3}`
and no launch row overrides it.

## vol or fixed

The keeper's vol mode prices the week from Cboe's delayed option chain for the ticker, and it
refuses to arm when the chain is not the same instrument as the feed (spot divergence over
`KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS`, 300) or has no expiry on the cycle's Friday. So `mode` is
decided by evidence, per build:

- `vol` when Cboe answers 200 for the root, lists both of the next two Fridays, and its
  `current_price` is within 300 bps of the feed's spot;
- `fixed` otherwise, with `modeReason` saying which test failed.

At the 2026-09-15 build every ticker but **SGOV** (monthly expiries only) is `vol`. The plan's
guess that SPCX, SLV, USO, SGOV and EWY lack a Cboe chain was wrong for four of the five: all four
have weekly chains on the same underlying (SPCX's Cboe root tracks the SpaceX token within 34 bps).
`modeOverride` forces a mode by hand; the builder keeps it and records the automatic verdict in
`modeReason`.

## Rebuilding

```bash
export PATH="$HOME/.foundry/bin:$PATH"
node ops/markets/build-markets.mjs            # fetch the feed directory, verify on chain, probe Cboe
node ops/markets/build-markets.mjs --check    # CI / pre-deploy: exit 1 on any drift or failing check
node ops/markets/build-markets.mjs --check --registry ops/markets/dev.json   # the DEV registry, same rules
```

**`dev.json`, the second registry.** From INTERFACE_VERSION 8 `ops/markets/dev.json` describes the **local
anvil devnet** (`ops/devnet/up.sh`), a fork of 4663 whose v2 set is deployed fresh on every run. Until v8 it
was a byte copy of this file with `v2.bots` filled in, and because the builder rewrote `shared` from a
constant, a rebuild put production's admin, guardian and fee wallets back into it: a dev stack pointed at it
ran against production's wallets and nothing said so. Now every wallet in it is a public anvil dev account
(admin #0, guardian #1, feeRecipient #2, cranker #8, pricer #9, quoter #10, treasury stand-in #11 — the
indices of `ops/devnet/lib.mjs` `ROLE_INDEX`), every v1 deployment field is null, and **`--check` refuses any
production wallet, bot key, contract or v1 factory in it** (`validateDevIsolation`). `shared.token` is the one
production address it MUST share: STONKHOUSE and its launch pool are a fact of chain 4663 like `shared.usdg`,
the devnet is a fork of 4663 and the dev deploy path reads them from here — so since T-OP-108 the rule no
longer claims `shared.token.address` as production's own. `v2.contracts`,
`v2.deployBlock` and `v2.flywheel` stay null here: the devnet writes its own copy with that run's addresses
(`ops/devnet/devnet.mjs registry` → `ops/devnet/tier1.devnet.json`, gitignored). Every other rule above
applies unchanged; `--registry <file>` is how each tool is pointed at it and nothing defaults to it. `_dev`
is the one top-level key the builder preserves the way it preserves the v2 blocks.

**`v7-legacy.json`, the frozen third.** `ops/markets/v7-legacy.json` is this file exactly as it stood at the
v8 registry commit: interface version 7, the v7 deploy block and addresses, NVDA live, rent 80 ppm. It exists
so the v7 monitor and cranker instances have something to read during the run-off and so an audit can still
resolve a v7 address, fee or market row — not so anything new is registered on v7. It carries `_legacy` and
`build-markets.mjs` **refuses to rebuild or validate it**: the v8 validator would report every v7 value as a
fault, and a "fix" that made the check pass would have edited the freeze. `ops/v2-env.mjs --registry
ops/markets/v7-legacy.json --out <dir>` still renders the v7 service env, value for value as it was, because
every v8 env line is rendered only for a registry that carries the v8 blocks.

The feed directory grows (35 equity feeds on 2026-09-12 and on 2026-09-15). A new feed with a
matching Stock Token appears as a new `superseded-by-v2` row with a planned `v2` block in `wave2`
whose `strikeTick` is null, which `--check` refuses until it is filled by hand. A feed that
disappears makes `--check` fail rather than silently dropping a live market.

Every address in the file was read on chain at `verifiedAtBlock`; `verification.issues` is empty
for every row or the builder exits 1. Never copy an address from anywhere else into this file.

## Schema compatibility and regeneration

The registry follows the O3-003 conventions (plan `02-interfaces.md` §3.1 registry, §4.1 API); every schema change
is logged in the plan's `status/INTERFACE-CHANGES.md`.

- **Closed-set blocks change with their skeleton.** `build-markets.mjs --check` accepts exactly the keys of
  `V2_SKELETON` under `v2`, of `v2.contracts`, `.sources`, `.bots`, `.protocolAddresses` (and its `distributors`),
  `.flywheel`, `.uniswapV3`, `.fees`, `.vault` and `v2.defaults`; of `SHARED_SKELETON` under `shared`, and of
  `shared.safes`, `shared.token` and `shared.token.poolKey`; and of `V2_MARKET_KEYS` in each market's `v2`, with
  `payoutRoute` closed per venue. `overrides` may omit keys but not add them. **An unknown key is refused, never
  ignored** — every consumer reads fixed names, so a misspelt key is not a wrong value but no value, and the
  reader silently takes its default (`buybackExecuter` disables the buyback; `allowRent` one level up turns the
  rent guard off). A new block or key lands in the same commit as its skeleton entry and validator, with its
  values in `tier1.json` and `dev.json`. A new per-market or override key also changes `web/scripts/gen-markets.mjs`
  and `render-docs.mjs` (and keeper `paramsPartial` for an override).
- **Periphery data gets its own block or route.** Never add a key to `v2.contracts`: `build-markets.mjs` and
  `render-docs.mjs` reject it, `ops/v2/finish-dev-deploy.sh` expects exactly 14 addresses, `ops/v2-env.mjs` exits
  unless it is null or an address, and the generators copy it into generated code that `/v2/config` does not expose.
  Flywheel addresses go in `v2.flywheel`, rewards in `v2.rewards`, the token in `shared.token`. The one exception is
  the six external contracts above (T-OP-114), whose path the contracts wrapper fixed before this file could: they
  are accepted, never required, and never counted. A new API field is
  consumer-first: optional in the web and indexer schema twins and fixtures, shipped, and only then produced.
- **Additive versus breaking.** An additive change keeps `v2.interfaceVersion` at 8 only when every strict or
  closed-set consumer accepts it; it is still logged. A removal, rename, type change or meaning change is breaking:
  one reviewed release set bumps every exact-version gate (this builder's and the keeper's `INTERFACE_VERSION`,
  `indexer/scripts/gen-v2-registry.mjs`, `render-docs.mjs`, the contracts' `DeployV2Batch.sh`,
  `ops/v2/dev_deploy.py`, the rehearsal and devnet checks) and regenerates every generated value and fixture that
  carries the version, `ops/fixtures/api/v2` included. Plan §3.1 rule 4 lists each `file:line`.
- **Regenerate every projection together.** A registry edit ships as one reviewed release set: this repository's
  commit carries `tier1.json`, `dev.json` and every affected projection below, and the docs and site projections land
  as paired commits in those repositories. Run every check against the set before release; only the projections the
  edit affects change bytes.

| Projection | Regenerate | Check (exit 0 = no drift) |
|---|---|---|
| `tier1.json` (validator) | `node ops/markets/build-markets.mjs` | `node ops/markets/build-markets.mjs --check` |
| `ops/markets/build-markets.test.mjs` (the schema's own assertions) | — | `node --test ops/markets/build-markets.test.mjs` |
| `dev.json` (validator) | `node ops/markets/build-markets.mjs --registry ops/markets/dev.json` | `node ops/markets/build-markets.mjs --check --registry ops/markets/dev.json` |
| `web/lib/markets.generated.ts` | `node web/scripts/gen-markets.mjs` | `node web/scripts/gen-markets.mjs --check` |
| `indexer/lib/v2/marketRegistry.generated.ts` | `node indexer/scripts/gen-v2-registry.mjs` | `node indexer/scripts/gen-v2-registry.mjs --check` |
| `indexer/lib/v2/cardRegistry.generated.json` | `node indexer/scripts/gen-card-registry.mjs` | `node indexer/scripts/gen-card-registry.mjs --check` |
| `ops/keeper/markets/*.env` | `node ops/keeper-env.sh` | `node ops/keeper-env.sh --check` |
| `ops/v2/env/*.env` | `node ops/v2-env.mjs` | `node ops/v2-env.mjs --check` |
| `ops/v2/env-dev/*.env` | `node ops/v2-env.mjs --registry ops/markets/dev.json --out ops/v2/env-dev` | `node ops/v2-env.mjs --registry ops/markets/dev.json --out ops/v2/env-dev --check` |
| callhouse-docs `product/markets.md`, `docs/product/markets.md` | `node ops/markets/render-docs.mjs --docs-dir <callhouse-docs checkout>` | `node ops/markets/render-docs.mjs --check --docs-dir <callhouse-docs checkout>` |
| callhouse-site `lib/markets.generated.ts` | the site's `scripts/market-projection.mjs` | in the site checkout: `CALLHOUSE_WEB_DIR=<this checkout>/web pnpm check-twins` |

**`ops/v2/wave.mjs`, the whole set in one command (O3-102).** `node ops/v2/wave.mjs --docs-dir
<callhouse-docs checkout>` validates `tier1.json`, checks `dev.json` against it, validates `dev.json`,
regenerates every projection above (the site's row runs in the site checkout, not here), verifies each
with its own `--check` afterwards, and prints the exact file commit set and the services to rebuild.
**It never writes a registry.** Both registries are inputs: `tier1.json` is rebuilt from the network by
`build-markets.mjs`, and `dev.json` is the devnet's own file — copying tier1's values into it would
import production wallets and null the anvil ones, which is exactly what `validateDevIsolation`
refuses. What wave does check is the one thing a second hand-maintained registry loses silently: its
market set and its `v2.interfaceVersion` must match `tier1.json`'s (per-market `status` deliberately
need not — NVDA is `live` here and `superseded-by-v2` in `dev.json`). A mismatch is reported as drift
naming the builder, `node ops/markets/build-markets.mjs --registry ops/markets/dev.json`, as the fix.

The commit set: a registry file that differs from HEAD joins it and rebuilds the five services built
from the image that bakes the registry (`keeper/Dockerfile` — `pricing`, `cranker`, `pricer`, `mm-bot`
and `monitor`, which reads the baked file); for `dev.json` those are marked ` (dev)` and the signing
bots are left out, because the `stonkhouse-dev` project refuses them (`ops/v2/go-live-gating.mjs`).
`v7-legacy.json` joins the commit set but rebuilds nothing by itself and has no step: the builder
refuses a frozen registry and only `ops/v2-env.mjs` still renders from it. The indexer's projections
map to `indexer-v2`, keeper-env's to `keeper-<lowercase ticker>` (Railway's own name), env files to
their stems (` (dev)` for env-dev), docs to `docs (publish)`.

`node ops/v2/wave.mjs --check` writes nothing and exits non-zero naming each stale projection, with
non-drift check failures (an RPC outage, a missing tool) reported apart from staleness. It needs
`--docs-dir`, or `--skip-docs` (check mode only) to explicitly report the docs projection as skipped.
Write mode aborts before projecting when a registry does not validate, and a docs checkout is required
in write mode. `MARKETS_REGISTRY` is stripped from generator child processes. CI's `ops` job
(`.github/workflows/ci.yml`) runs `build-markets.mjs --check`, `v2-env.mjs --check`, the monitor and
runbook suites and `node --test ops/v2/wave.test.mjs`, but not `wave --check` itself: that needs a
`callhouse-docs` checkout the runner does not have, so run it by hand for every registry change,
alongside the site's `check-twins`. Tests: `node --test ops/v2/wave.test.mjs`.

`render-docs --check` and the site's `check-twins` are not in CI, and `check-twins` skips when it finds no app
checkout unless `CALLHOUSE_WEB_DIR` is set, so run both by hand for every registry change.
