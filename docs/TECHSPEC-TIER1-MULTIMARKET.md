# Tier 1: many markets — technical specification (draft)

**Status: draft, 2026-09-15.** Written alongside the lanes that implement it; a later pass
reconciles this document with the real diffs (contracts scripts, keeper, indexer, web). Where a
name below differs from what landed, the code wins and this file is corrected. Design decisions
are settled and are not re-litigated here.

Companion documents: [ARCHITECTURE.md](./ARCHITECTURE.md) §9 (the one-paragraph version),
[WIRING.md](./WIRING.md) §10 (registry → consumers), [LAUNCH-PLAN.md](./LAUNCH-PLAN.md) §8 (the
waves), `ops/deploy.md` §14 (the Railway layout and the gates), `ops/markets/README.md` (the
registry's contract), and the runbooks under `ops/runbooks/` (each opens with a "Factory markets"
preamble).

---

## 1. Goal

Thirty-four new **isolated-account markets** in addition to NVDA, one for every Stock Token on
Robinhood Chain (4663) that has a live Chainlink `us_equities_24/5` feed, each behaving exactly as
the live NVDA market does: one `AccountFactory` per Stock Token, isolated `WriterAccount` clones,
write on fill, one FULL 1-lot Seaport order per lot, each account on its own Valorem option type
(`expiry = baseExpiry + index`), the 5% fee taken inside the fill, `settle` permissionless after
the account's expiry.

The plan, verbatim: *factory-only, one canonical registry, scale-out (one process per market) for
keeper and indexer, one multi-market web build with `[ticker]` routes, phased rollout canary
(TSLA, AAPL) → wave1 (MSFT, META, GOOGL, AMZN, AMD, ORCL, PLTR, COIN, MSTR, TSM, QQQ, SPY) → wave2
(the rest), each wave gated on one full weekly cycle with zero keeper failures, no stale-price
skips outside weekend windows, indexer backfill complete, docs updated.*

The NVDA market keeps working exactly as today (same env, same behaviour) unless this document
says otherwise.

## 2. The market list

The source is **`ops/markets/tier1.json`**, built and verified by `ops/markets/build-markets.mjs`
(README: `ops/markets/README.md`). At the 2026-09-15 build (`verifiedAtBlock` 64,151,977): 35
markets, all `verification.ok`, NVDA `live`, 34 `planned`, every planned row with a keeper
address already assigned (`deployment.keeper`, `keeperKeyIndex` 10–43).

| Wave | Tickers |
|---|---|
| `live` | NVDA (factory `0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb`, deploy block 64,038,234, keeper `0x06c1…C1d2`, key index 1) |
| `canary` | TSLA, AAPL |
| `wave1` | MSFT, META, GOOGL, AMZN, AMD, ORCL, PLTR, COIN, MSTR, TSM, QQQ, SPY |
| `wave2` | ASML, BABA, CLSK, CRCL, CRWV, DELL, EWY, GME, INTC, IONQ, MU, NBIS, RGTI, RKLB, SGOV, SLV, SNDK, SPCX, USAR, USO |

The list is not typed anywhere else. A lane that needs it reads the registry (contracts: the
batch script; keeper: `ops/keeper-env.sh`; web: `pnpm gen:markets`; docs: `render-docs.mjs`;
runbooks: a `node -e` loop over `status == "live"`).

## 3. Design decisions (settled)

1. **Factory-only.** Every new market is an `AccountFactory` + `WriterAccount` clone pair from
   `src/solo/` in the contracts repository, deployed from the same source and the same script as
   NVDA's. The pooled `Vault` product is closed and is neither redeployed nor changed. No
   contract source changes for Tier 1; only scripts.
2. **One canonical registry.** `ops/markets/tier1.json`, generated, with a small set of
   hand-maintained fields (`deployment.*`, `wave`, `status`, the per-market keeper knobs). Every
   address in it was read on chain at `verifiedAtBlock`; `--check` fails on drift or on a feed
   that disappears. Nothing else may hard-code a ticker, a token, a feed or a factory.
3. **Scale-out, one process per market**, for both the keeper and the indexer: `keeper-<ticker>`
   and `indexer-<ticker>` Railway services, the same images as today, env-only differences. No
   multi-market keeper process, no multi-vault Ponder schema. The reasons: the keeper's
   "exactly one instance per key" rule becomes "one key per market" and stays enforceable by a
   volume; a bug or a wedge on one market cannot stall another; each service's blast radius is
   one factory; and the existing code paths, tests and runbooks carry over with a variable
   change instead of a refactor.
4. **One multi-market web build.** `web/lib/markets.generated.ts` rendered from the registry at
   build time (`pnpm gen:markets`), dynamic `/<ticker>/account` and `/<ticker>/book` routes
   (lowercase), `/account` and `/book` redirecting to `/nvda/*`, a market switcher in the nav,
   `/vault/nvda/*` untouched. One image, one deploy, no per-market frontend.
5. **Phased rollout with hard gates.** canary → wave1 → wave2, each gated on one full weekly
   cycle: zero keeper failures, no stale-price skips outside weekend windows, indexer backfill
   complete, docs updated. A failed gate is another cycle on the same wave.

## 4. The registry schema

Top level: `_readme`, `generatedAt`, `verifiedAtBlock`, `rpc`, `feedsSource`, `tokensSource`,
`shared` (`chainId`, `usdg`, `clearinghouse` = our Clear `0x53d7…C6`, `seaport`, `multicall3`,
`admin`, `guardian`, `feeRecipient` = admin), `defaults`, `waves`, `skipped`, `summary`, `markets[]`.

Per market (from `ops/markets/README.md`, the authority):

```
ticker            AAPL                                   from the feed name; equals the token's symbol()
name              Apple • Robinhood Token                issuer's token name (R6 list)
asset             0x6B22…                                the Stock Token (18 dp), EIP-55
assetDeployBlock  48276                                  from the R6 list
feed              0x…                                    Chainlink proxy (8 dp), the factory's priceFeed
feedSvr           0x…                                    the SVR (secondary) proxy, recorded, not used
feedAggregator    0x…                                    the aggregator behind the proxy at build time
cboe              { root, url, weekly, rows, currentPrice, spotDivergenceBps, underlyingMatches, checkedAt }
mode              vol | fixed                            how the keeper prices the week (§5.2)
depositCapUsd     10000                                  per-ACCOUNT cap in USD notional; null = uncapped
depositCap        "45000000000000000000"                 the same in token base units at the verified spot
strikeOtmBps      500                                    fixed mode: strike = spot + 5%
minAskUsdg6       "100000"                               the ask is never below 0.10 USDG
targetDelta / priceEdgeBps / premiumMarginBps            vol-mode knobs, keeper defaults
wave              live | canary | wave1 | wave2          rollout order
status            live | planned | paused                planned until the factory is configured
verification      { block, feedDecimals, feedAnswer, feedUpdatedAt, feedAgeS, spotUsd, feedDescription,
                    tokenDecimals, tokenSymbol, uiMultiplier, oraclePaused, ok, issues[] }
deployment        { factory, implementation, deployBlock, deployTx, keeper, keeperKeyIndex, guardian,
                    admin, feeRecipient, sourcify, configuredAt }     hand-maintained / written by scripts
```

Hand-maintained (the builder preserves them): `deployment.*`, `wave`, `status`, `depositCapUsd`,
`strikeOtmBps`, `minAskUsdg6`, `targetDelta`, `priceEdgeBps`, `premiumMarginBps`, `modeOverride`,
`notes`. Everything else is regenerated on every build.

Who reads what:

| Consumer | Reads | Writes |
|---|---|---|
| `contracts/script/DeploySoloBatch.sh` | `asset`, `feed`, `depositCap`, `ticker`, `deployment.keeper`, `deployment.guardian`, `shared.*` | `deployment.factory`, `implementation`, `deployBlock`, `deployTx` |
| `ops/keeper-env.sh` | `deployment.factory`, `asset`, `feed`, `mode`, `cboe.url`, `cboe.root`, `strikeOtmBps`, `minAskUsdg6`, `targetDelta`, `priceEdgeBps`, `premiumMarginBps`, `shared.*` | `ops/keeper/markets/<TICKER>.env` |
| `ops/markets/derive-keeper-keys.sh` | `deployment.keeperKeyIndex`, `shared.admin` (sanity) | `deployment.keeper`, `deployment.keeperKeyIndex`; the key files under `~/.callhouse-keys/markets/` |
| `web/scripts/gen-markets.mjs` | `ticker`, `name`, `asset`, `feed`, `deployment.factory`, `deployment.deployBlock`, `status`, `mode`, `cboe.root` | `web/lib/markets.generated.ts` |
| `ops/markets/render-docs.mjs` | everything above plus `verifiedAtBlock`, `generatedAt`, `waves`, `defaults` | `callhouse-docs/product/markets.md` (+ `docs/` mirror) |
| `ops/runbooks/*.md` | `status == "live"` rows: `deployment.factory`, `asset`, `feed`, `deployment.keeper`, `mode` | — |

## 5. Per-lane design

### 5.1 Contracts (scripts only)

- `script/DeploySolo.s.sol`: one factory + implementation per run. Env: `DEPLOYER_PK`, `ADMIN`
  (or `SAFE_ADMIN`), `SAFE_FEE`, `ASSET`, `USDG`, `CLEARINGHOUSE`, `SEAPORT`, `PRICE_FEED`,
  `DEPOSIT_CAP`. **Extended preflight** for Tier 1: `EXPECTED_TICKER` must equal the token's
  `symbol()` (a mis-set `ASSET` deploys a factory for the wrong stock otherwise); the feed's
  `description()` must name the ticker, `decimals()` must be 8, `latestRoundData()` must be
  fresh within `maxPriceAge`; the token's `uiMultiplier()` and `oraclePaused()` are probed and
  printed (an issuer-paused oracle is a stop). The code size limit is 98,304 B on chain 4663;
  anvil rehearsals need `--code-size-limit 98304`.
- `script/ConfigureSolo.s.sol`: `FACTORY`, `KEEPER` (that market's key address), `GUARDIAN`
  (shared), `ADMIN_PK`, `DEPOSIT_CAP` (per account). Grants the two roles and sets the cap;
  `configuredAt` is written by the batch after Verify passes, not by this script.
- `script/VerifySolo.s.sol`: reads every immutable and role back and PASSes or FAILs per
  factory, the way `Verify.s.sol` does for the vault.
- `script/DeploySoloBatch.sh --registry <tier1.json> --tickers A,B | --wave <wave>
  --rehearse | --dry-run | --broadcast`: loops the three scripts over the selected rows, in
  registry order, and **writes `deployment.factory` / `implementation` / `deployBlock` /
  `deployTx` back into the registry immediately after each deploy, then `sourcify` /
  `configuredAt` after Configure + Verify** (the batch is the only writer of those six fields;
  a row left with `configuredAt` empty is finished with `--resume`). Broadcasts
  are run by the owner; nothing in the app repository sends one. `ops/addresses.json` →
  `chains.4663.ours.factories` records only the first factory (NVDA) with its evidence; per-market
  addresses live in the registry.

### 5.2 Keeper: a factory-only process, one per market

Env (in addition to today's): `FACTORY` (required in the factory-only process), `PRICE_FEED`
(cross-checked against `factory.priceFeed()` at boot), `KEEPER_MARKET` (the ticker, in logs,
alerts and `/health`), `KEEPER_MIN_ASK_USDG6` (the per-market minimum ask), `KEEPER_PRICING_MODE`
(`vol` | `fixed`, per market), and **`VAULT` optional**: a per-market keeper has no vault. NVDA's
`keeper` service becomes the closed pooled vault's wind-down process (`VAULT` set, `WIND_DOWN=1`,
`FACTORY` removed); the NVDA factory's keeper is a separate service, `keeper-nvda`, rendered from
`ops/keeper/markets/NVDA.env` by the same flow as every other market (`ops/deploy.md` §10.0, §14).
One process per market; one hot
key per market (`~/.callhouse-keys/markets/<TICKER>.env`, from `ops/markets/derive-keeper-keys.sh`,
mnemonic indices 10–43, mode 600, never printed). `ops/keeper-env.sh` renders the env file per
market; `ops/keeper-railway.sh` creates `keeper-<ticker>` services (dry-run by default). `pnpm
--filter @callhouse/keeper solo:quote` is the per-market dry run: it prints the week the keeper
would set and sends nothing.

**The week.** The keeper reads `factory.week()`; if `id == 0` or `baseExpiryTs` is past, it sets
the next one at least `KEEPER_ARM_LEAD_S` (6 h) before the next NYSE Friday 16:00 ET (Thursday on
a Friday holiday), base expiry 24 h later, through `setWeek(strike, exerciseTs, baseExpiryTs, ask)`.
Then, every tick, it `listFor`s each `pendingAt(i)`'s owner (capped per tick), and `settle`s each
`liveAt(i)` whose `listedExpiryTs` has passed.

**Pricing.** Spot is the feed's answer scaled to USDG base units (`spot6`), and the policy is read
from the factory (`minOtmBps`, `maxOtmBps`, `minPremiumBps`, …), never hard-coded:

```
floor6      = ceil(spot6 × minPremiumBps / 10000)                     the factory's premium floor per lot
margin6     = ceil(floor6 × (10000 + KEEPER_PREMIUM_MARGIN_BPS) / 10000)   the fill gate re-prices the floor at live spot
fixed:  strike6 = floor(spot6 × (10000 + KEEPER_STRIKE_OTM_BPS) / 10000 / 1e6) × 1e6      whole USDG, inside the band
        ask6    = max(margin6, KEEPER_MIN_ASK_USDG6)
vol:    strike6 = the KEEPER_TARGET_DELTA (0.15) call of the cycle's Friday from Cboe's chain for cboe.root,
                  mapped to the token by spot6 / shareSpot, whole USDG half up, clamped into
                  [ceil(spot6 × (1 + (minOtmBps + KEEPER_STRIKE_BAND_BUFFER_BPS)/1e4)), floor(spot6 × (1 + (maxOtmBps − 50)/1e4))]
        fair6   = Cboe's listed mid interpolated at strike6, mapped to the token, rounded up
        ask6    = max(margin6, ceil(fair6 × (10000 + KEEPER_PRICE_EDGE_BPS) / 10000), KEEPER_MIN_ASK_USDG6)
both:   ask6 ≤ strike6 (the factory reverts AskAboveStrike otherwise); a strike outside the band, or unusable
        vol data (stale, wrong root, spot divergence > KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS, no expiry on the
        Friday) means NO setWeek this tick, with a named reason; it never falls back to fixed.
```

The minimum ask replaces the NVDA-only keeper's hard `max(minPrem, 1 USDG)` (`keeper/src/solo.ts`
today): 1 USDG is a large slice of a weekly premium on a 25 USD token. `minAskUsdg6` is per
market, `100000` (0.10 USDG) by default. **Mode is selected by evidence** at each registry build:
`vol` when Cboe answers 200 for the root, lists both of the next two Fridays, and its
`current_price` is within 300 bps of the feed's spot; `fixed` otherwise, with `modeReason`;
`modeOverride` forces one by hand.

**Alerts and health.** Every alert carries `KEEPER_MARKET`; `/health` reports the market, the
factory, `hasKeeperRole` and the last `setWeek`. The relay is shared.

### 5.3 Indexer: one deployment per market

Env: `FACTORY_ADDRESS` (required), `MARKET` (the ticker, required), `START_BLOCK` (the market's
factory deploy block, required), **`VAULT_ADDRESS` optional** (unset on a per-market indexer; set
only on NVDA's). One Railway service `indexer-<ticker>` per market, the same image, one shared
Postgres with a schema per deployment (`RAILWAY_DEPLOYMENT_ID`, exactly today's mechanism), so 34
services on one database never collide. New tables for the factory product (accounts, weeks,
lots / fills, settlements) and new routes: `GET /v1/market` (ticker, factory, implementation,
feed, asset, the current `week()`, halted, cap), `GET /v1/market/weeks` (every week, including
weeks with no fills), `GET /v1/market/fills` (one row per `LotFilled`, with the Seaport order
hash and the premium split), `GET /v1/market/accounts/:address` (held, idle, requested, listed,
written, claim, USDG balance, settlement history). `/ready` stays the healthcheck; `/v1/health`
the uptime probe. The NVDA `indexer` keeps its vault routes.

### 5.4 Web: one build, dynamic routes

`web/lib/markets.generated.ts` from `pnpm gen:markets` (reads the registry; committed); `web/lib/
markets.ts` the typed accessor (`marketByTicker`, the live list, the default market). Routes:
`app/[ticker]/account` and `app/[ticker]/book` (lowercase ticker; an unknown or non-live ticker is
a 404), `/account` → `/nvda/account`, `/book` → `/nvda/book` (redirects, so every existing link and
the docs keep working), a market switcher in the nav listing live markets, `/vault/nvda/*`
untouched. `NEXT_PUBLIC_FACTORY` / `NEXT_PUBLIC_ASSET` move only the default market (forks). The
copy linter runs unchanged. Pages read the factory and its accounts over RPC (wagmi); the
per-market `indexer-<ticker>` deployments are operator-facing (backfill, dashboards), not read by
the web build (`ops/deploy.md` §14.3–14.4).

### 5.5 Docs: rendered from the registry

`ops/markets/render-docs.mjs` renders `callhouse-docs/product/markets.md` (and the GitBook mirror
under `callhouse-docs/docs/`): what a market is, the live table (ticker, token, feed, factory,
mode, per-account cap in tokens and USD, since block), the planned tables by wave with the
sentence that a planned market is not deployed and cannot take deposits, the `vol` / `fixed`
explanation, and the provenance line (`verifiedAtBlock`, `generatedAt`). `--check` exits 1 on
drift and is a deploy gate. `README.md`, `product/policy.md`, `product/risks.md` and
`protocol/addresses.md` were updated by hand once (the per-market URL scheme, the shared policy
table, the three new risks, the "only addresses on that page or in the registry are real" rule)
and are not regenerated. A push to callhouse-docs publishes.

### 5.6 Ops

`ops/deploy.md` §14 (service layout, variables per service, rollout order, wave gates, what to
check), `ops/README.md` (index rows, the 2026-09-15 "What changed"), `ops/addresses.json` →
`ours.factories` (NVDA only), and a "Factory markets" preamble in `open-week.md`, `close-week.md`,
`canary-week.md` and `incident.md` giving the per-market loop and the factory equivalent of every
vault step (`week()` / `setWeek`, `pendingCount` / `pendingAt` + `listFor`, `liveCount` / `liveAt`,
account `settle()`, `writesHalted` / `setWritesHalted`, `keeper-<ticker>` `/health`).

## 6. Rollout: waves and gates

Order: canary (TSLA, AAPL) → wave1 (12) → wave2 (20). Per wave, in order (the full list with
flags is `ops/deploy.md` §14.5): registry `--check` → keys derived and funded →
`script/DeploySoloBatch.sh --wave <wave> --rehearse --rpc http://127.0.0.1:8546` on an anvil fork,
then `--broadcast --rpc $RH_RPC` (owner; the registry defaults to `../callhouse/ops/markets/
tier1.json` from the contracts root, and ConfigureSolo / VerifySolo run inside the batch) → rows
to `live` →
`keeper-env.sh` + `solo:quote` + `keeper-railway.sh` → `indexer-<ticker>` → `gen:markets` + web
rebuild → `render-docs.mjs` + docs push → one full weekly cycle with the owner's own account at
1 lot per market.

The gate to the next wave, every market of the wave, over that cycle:

| Gate | Evidence |
|---|---|
| zero keeper failures | no `tx_revert`, `keeper_error` or `cycle_not_created` from any `keeper-<ticker>` (`phase_stuck` belongs to the vault wind-down process; a factory keeper's "week not set" alert is `cycle_not_created`); `/health` `ok` throughout |
| no stale-price skips outside weekend windows | a `stale-oracle` / `StalePrice` skip only between the Friday close and the Monday feed restart; any other is a stop |
| indexer backfill complete | every `indexer-<ticker>` `/ready` 200; `/v1/market` equals `week()` on chain |
| docs updated | page regenerated and pushed; `render-docs.mjs --check` and `build-markets.mjs --check` green |

## 7. Validation checklist

- [ ] `node ops/markets/build-markets.mjs --check` green (35 verified, none failing, no drift)
- [ ] `node ops/markets/render-docs.mjs && node ops/markets/render-docs.mjs --check` green; the
      page listed in `SUMMARY.md` under Product; every relative link resolves
- [ ] contracts: `forge fmt --check`, the unit / invariant / fork suites, `DeploySoloBatch.sh
      --rehearse --wave canary` PASSED on an anvil fork with `--code-size-limit 98304`;
      `VerifySolo` PASS per factory
- [ ] keeper: `pnpm --filter @callhouse/keeper test` green with `VAULT` unset and `FACTORY` set;
      `solo:quote` prints a week for every `vol` market and SGOV in `fixed`; the boot cross-check
      refuses a `PRICE_FEED` that is not `factory.priceFeed()`
- [ ] indexer: `pnpm --filter @callhouse/indexer test` green; a fork sync of one factory answers
      `/v1/market`, `/v1/market/weeks`, `/v1/market/fills`, `/v1/market/accounts/:address`
- [ ] web: `pnpm --filter @callhouse/web gen:markets`, `typecheck`, `test` green (copy-lint removed 2026-09-21);
      `/nvda/account`, `/nvda/book`, `/account` → `/nvda/account`, `/book` → `/nvda/book`; an
      unknown ticker is a 404; `/vault/nvda/collect` unchanged
- [ ] ops: `node -e 'JSON.parse(...)'` on `addresses.json`; `ops/keeper-env.sh` produces one file
      per market and none contains a key; `ops/keeper-railway.sh` dry-run prints 2 services for the
      canary wave
- [ ] the NVDA services are untouched: same variables, same image, `/health` `ok`

## 8. Out of scope

- The ~170 Stock Tokens **without** a Chainlink feed (the registry's token list has 204; 35 have
  an equity feed). No feed, no factory: the factory reads `priceFeed()` at every list and fill.
- A multi-market keeper process. One process per market, by decision 3.
- A multi-vault Ponder schema. One deployment per market, by decision 3.
- Reviving, redeploying or changing the pooled `Vault`. It is closed.
- Changing `src/solo/*.sol`. Tier 1 is scripts, env and rendering; a contract change would be a
  new implementation and a new factory per market.
- A Safe handover, a timelock, or an audit. Unchanged, unaudited, disclosed.

## 9. Deviations from the plan

Recorded as they were found; each one changes what the plan said, not why.

1. **The plan said SPCX, SLV, USO, SGOV and EWY have no Cboe chain.** The registry build probed
   Cboe for every root: all five answer 200, and four of the five (SPCX, SLV, USO, EWY) list
   weekly expiries on the same underlying as the feed; SPCX's Cboe root tracks the SpaceX token
   within 34 bps of the feed's spot. Only **SGOV** has monthly expiries only. So only SGOV is
   `fixed`; the other four are `vol` like everything else. `modeOverride` exists if the operator
   disagrees with the evidence for a market.
2. **The plan's 4-day staleness bound is the factory's `maxPriceAge`**, not a separate keeper
   rule. `AccountFactory.maxPriceAge` is 345,600 s (4 days) on NVDA and the batch deploys the
   same; the keeper's `KEEPER_VOL_MAX_AGE_S` mirrors it for the Cboe chain. "No stale-price
   skips outside weekend windows" in the wave gate is therefore judged against that 4-day bound:
   a feed that stops Friday and restarts Monday (00:00:54 UTC) never trips it; a holiday weekend
   longer than 4 days does, on every market at once, and that is the feed family, not a market.
3. **`depositCap` is per ACCOUNT in the factory**, not a market total: `WriterAccount.deposit`
   checks `_heldAssets() + assets` against `factory.depositCap()`. So the registry's
   `depositCapUsd` (10,000 USD default, converted to whole tokens at the verified spot into
   `depositCap`) is a **per-account notional**, and the docs page says so. NVDA's cap is
   `type(uint256).max` on chain and the registry records `null` / the max for it.

Open (for the reconciliation pass): the exact `/health` fields a per-market keeper exposes; how
the web maps a ticker to its `indexer-<ticker>` domain; whether `web` reads a per-market keeper's
`/orders` or only the accounts' `lotOrder` views; the VerifySolo check count.
