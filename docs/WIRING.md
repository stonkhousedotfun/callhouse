# Wiring

The runtime complement to [ARCHITECTURE.md](./ARCHITECTURE.md): which process talks to which,
over which env var, on which port, and what has actually been proven end to end. Where a
statement here disagrees with a package README, the README wins for that package and this file
should be fixed.

Three facts frame everything below:

- **The keeper and the indexer never talk to each other.** Both read the same chain
  independently. The web app reads the chain and the indexer, and its server reads the keeper's
  `/orders` for the fill page (§7). There is no message bus and no shared database.
- **The only hop that moves money is the user's own wallet**, signing against chain 4663
  (deposit, queue, claim, settle, retry, and the Seaport fill on the cycle page). Every other hop
  is read-only JSON or an operator transaction.
- **Nothing here talks to Overcall.** Since the 2026-09-13 redesign there is no registry read, no
  order-book POST, no status poll, no proxy route and no HMAC relay. The keeper's `/orders` served
  through the web app **is** the venue.

---

## 1. The processes

| Process | Package | Default port | Public name | What it is |
|---|---|---|---|---|
| `site` | `leekzor/callhouse-site` (separate repo) | 3001 | `callhouse.finance` | static marketing; **no fetches, no wallet, no chain reads, ever** |
| `web` | `web/` | 3000 | `app.callhouse.finance` | the dapp; Next.js SSR + browser wagmi; hosts the fill page |
| indexer | `indexer/` | 42069 | a Railway domain (W-19) | Ponder: event indexer + the `/v1/*` read API |
| keeper | `keeper/` | 8787 | none (operator-only) | the roll bot; serves `/health` `/state` `/cycles` `/orders` |
| relay | `relay/` | 8080 | none (private network) | keeper alert webhook → Discord / Telegram |
| — | `contracts/` (git submodule → `leekzor/callhouse-contracts`) | — | — | the Vault on chain 4663; not deployed yet |

`site` builds and deploys from its own repository; nothing in this one builds, imports or
deploys it.

## 2. Every hop

### web, browser side

| From → To | What crosses | Env var (build-time inlined) | Default |
|---|---|---|---|
| browser → chain RPC | all live vault/token/clearinghouse reads, one Multicall3 batch (`phase`, `isStranded`, `maxDeposit`, `contractsWritten`, `listingHash`, `spotUsdg`, `policy`, `totalAssets`, …); tx sends from the wallet | `NEXT_PUBLIC_RPC_URL`, fallback `NEXT_PUBLIC_RPC_URL_2` | `rpc.mainnet.chain.robinhood.com`, `robinhood-rpc.publicnode.com` |
| browser → chain RPC (archive) | `eth_getLogs` history fallback; **primary only**: the backup refuses archive ranges | `NEXT_PUBLIC_RPC_URL` | as above |
| browser → chain RPC | the fill pre-flight: one `eth_call` of `fulfillAdvancedOrder` with the served payload, ~500k gas, decoded through the merged vault ABI so `PremiumBelowFloorAtFill` / `StrikeBelowBand` / `OraclePaused` / `WritesAreHalted` render as reasons | `NEXT_PUBLIC_RPC_URL` | as above |
| browser → indexer | `GET /v1/cycles?limit=N` for `/`, `/vault/nvda`, `/activity` | `NEXT_PUBLIC_API_URL` | `http://localhost:42069` |
| browser → same-origin route | `GET /api/keeper/orders` (the fill page's order source) | — | — |

The indexer client (`web/lib/api.ts`) is deliberately fail-soft: any error returns `null` and
history pages fall back to `eth_getLogs` against the archive RPC. Wallet connection is
injected-provider only; there is no WalletConnect.

### web, server side

| From → To | What crosses | Env var (runtime, **not** `NEXT_PUBLIC_`) | Default |
|---|---|---|---|
| fill route → keeper | `GET /orders` at the one configured URL, 5 s timeout (body included), 64 KiB cap, at most 8 orders (more is a 502), redirects refused; every order rebuilt and checked against the chain before it reaches the browser (§7) | `KEEPER_ORDERS_URL` | **none**: unset ⇒ 503 `configured:false`, no fill button. Railway: `http://keeper.railway.internal:8787/orders` |
| fill route → chain RPC | two Multicall3 `eth_call`s per computation, 6 s deadline for both: first the vault's `phase`, `listingHash`, `listingAmount`, `listingGrossUsdg`, `optionId`, `clear` with `Seaport.getCounter` per offerer and `getOrderStatus` per order hash (one call, so one block), then `Seaport.getOrderHash` for each order that names the authorised hash (pure). Shared across requests while running and for 2 s after | `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_RPC_URL_2` (build-time, `lib/chain.ts`) | as above |

The route is GET-only and reads nothing from the request. The web app never writes to the keeper
and never POSTs anywhere.

### keeper, outbound

| From → To | What crosses | Env var | Default |
|---|---|---|---|
| keeper → chain RPC | every call and send; `eth_getLogs` (harvest sums, `CallsWritten` per fill, boot reconciliation); the per-tick fill simulation | `RH_RPC` (**must be archive**) | none — required |
| keeper → chain RPC (backup) | `eth_call` and sends only, **never logs** (it rejects archive reads) | `RH_RPC_2` | publicnode |
| keeper → clearinghouse | `newOptionType(asset, 1e18, usdg, strike, exerciseTs, expiryTs)` once a week (permissionless; `OptionsTypeExists(id)` is read back and the id reused) | `CLEARINGHOUSE` | Overcall's unmodified Clear; must equal `vault.clear()` |
| keeper → vault | `rollOpen(id)`, `approveListing`, `cancelListing` (reprice), `lockBook`, `rollClose`, `retryStrandedClaim`, `settleQueue` | `VAULT` | none — required |
| keeper → alert relay | JSON POST per alert (14 kinds, `info\|warn\|error`, cooldowns) | `ALERT_WEBHOOK` | unset: logged + stored only |

At boot the keeper reads the vault's own wiring (`asset`, `usdg`, `clear`, `seaport`,
`seaportZone` (== the vault), `conduitKey`) and **refuses to start if it disagrees with the
keeper's env**: a mispointed keeper exits noisily instead of driving the wrong contract.

### keeper, inbound (its HTTP server, `:KEEPER_PORT`, unauthenticated, read-only)

| Route | Serves | Consumed by |
|---|---|---|
| `/health` | loop-wedged 503; degraded-on-200 for gas/RPC lag/stranded retry | external uptime monitor (L-08; Railway itself does not watch it after deploy) |
| `/state` | last snapshot + raw SQLite rows (snake_case) | operator debugging |
| `/cycles` | last 26 cycle rows, snake_case, incl. `premium_gross_usdg6` / `strike_proceeds_usdg6` and the strand state | operator debugging |
| `/orders` | the live listing as a `{parameters, signature: "0x"}` fill payload (`PARTIAL_RESTRICTED`, zone = vault, one consideration item) | `web`'s `/api/keeper/orders`, server-side over private networking; see §7 |

### indexer, outbound and inbound

| From → To | What crosses | Env var | Default |
|---|---|---|---|
| indexer → chain RPC | backfill + live event sync; Multicall3 overlay on reads | `PONDER_RPC_URL_4663` (archive for backfill) | none — required |
| indexer → Postgres | all indexed state | `DATABASE_URL` (+ `DATABASE_SCHEMA` from `RAILWAY_DEPLOYMENT_ID` on Railway) | PGlite under `.ponder/pglite` when unset |
| anyone → `GET /v1/*` | the public read API (`/v1/vault`, `/v1/cycles`, `/v1/cycles/:n`, `/v1/account/:addr`, `/v1/listings`, `/v1/snapshots`, `/v1/activity`, `/v1/health`) | — | — |

The indexer has **no write route**. Ponder reserves `/health`, `/ready`, `/status`, `/metrics` for
itself; the indexer's own health payload is **`/v1/health`**, and that is what an uptime monitor
must hit.

## 3. Configuration that must agree

The protocol addresses are compiled in as defaults in three places (`keeper/src/config.ts`,
`indexer/lib/env.ts`, `web/lib/contracts.ts`) and the defaults are the same recon-verified mainnet
values in all three (`ops/addresses.json` is the human-readable evidence; **nothing imports it at
runtime**). Override env vars exist per package for forks, rehearsals and a vault built on our own
clearinghouse:

| Address | keeper | indexer | web (build-time) |
|---|---|---|---|
| Vault (ours) | `VAULT` — **required, no default** | `VAULT_ADDRESS` — **required, no default** | `NEXT_PUBLIC_VAULT` — **no default; pages say "not configured" without it** |
| Clearinghouse | `CLEARINGHOUSE` (default Overcall's `0x9a7b…C0C0`; must equal `vault.clear()`) | `CLEARINGHOUSE` | `NEXT_PUBLIC_CLEARINGHOUSE` |
| Seaport 1.6 | `SEAPORT` | `SEAPORT` | `NEXT_PUBLIC_SEAPORT` |
| USDG | `USDG` | `USDG` | `NEXT_PUBLIC_USDG` |
| NVDA Stock Token | `ASSET` | `ASSET` | `NEXT_PUBLIC_ASSET` |
| Multicall3 | `MULTICALL3` | `MULTICALL3` | compiled into `lib/chain.ts` |
| Seaport zone | derived: `vault.seaportZone() == vault`; not configurable | — | — |
| Conduit key | `SEAPORT_CONDUIT_KEY` (zero; the vault's `conduitKey()` wins) | — | — |

Gone: `REGISTRY` / `NEXT_PUBLIC_REGISTRY`, `SEAPORT_ZONE`, `OVERCALL_FEE_RECIPIENT`,
`OVERCALL_ORDERS_URL`, `OVERCALL_MARKET`, `OVERCALL_API_BASE`, `KEEPER_HMAC_SECRET`.

Every `NEXT_PUBLIC_*` is inlined by `next build`: changing one needs a rebuild, not a restart
(`ops/deploy.md` §3). Keeper and indexer read their env at boot and validate it (zod; the keeper
exits 1 listing every bad value).

## 4. The indexer ↔ web contract is tested at both ends

`GET /v1/cycles` rows are the one shape two codebases share. The fixtures under
`ops/fixtures/api/` (filled, unfilled, assigned, idle weeks, real numbers; a stranded week when the
indexer lane adds it) pin it:

- `indexer/src/api/index.test.ts` proves the indexer still emits exactly those bytes
  (`CALLHOUSE_WRITE_FIXTURES=1` regenerates after a deliberate change);
- `web/lib/api.test.ts` runs the web normaliser over the same files and asserts the exact
  base-unit integers and booleans the pages render.

Money travels as `{raw, decimals, formatted}`; consumers read `raw` only. If a sold week ever
shows as "unfilled, 0" against a live API, check first that the indexer sums `CallsWritten` per
`claimKey` rather than reading `RollOpen.contractsCount` (always 0 now), then run both tests.

## 5. ABIs flow one way

`forge build` in `leekzor/callhouse-contracts` → the `contracts/` submodule pin →
`ops/abis/*.json` → generated copies. After any contract change: `forge build` in the contracts
repo, bump the submodule pin here, refresh `ops/abis/` (`jq --indent 1 '.abi'` from
`contracts/out/Vault.sol/Vault.json`, `ValoremLib.sol/ValoremLib.json`,
`SeaportOrderLib.sol/SeaportOrderLib.json`, `Policy.sol/Policy.json`), then `pnpm gen:abis` in
`indexer/` and in `web/`.

**The I-1 gap.** solc lists an error in a contract's ABI only when that contract's own bytecode
can raise it. The vault `DELEGATECALL`s `SeaportOrderLib` and `ValoremLib`, so 36 of its 92 custom
errors (`BadZone`, `BadOrderType`, `OfferExceedsCapacity`, `StrikeAboveBand`, `RedeemOutOfGas`,
`WriteReturnedWrongClaim`, …) are absent from `Vault.json`. Both generators merge the **error**
fragments of the library artefacts into the vault ABI, deduplicated by signature; the keeper's
hand-written `keeper/src/abi.ts` carries all 92 with source-line provenance and a test cross-checks
it against `contracts/out` when the artefacts are present. **Errors only**: the library artefacts'
function entries use forge's internal type names (`IValoremClear`, `ItemType`) and are not a
parseable ABI. A decoder built from `Vault.json` alone prints a bare selector for a mis-built order
or a library-side revert.

## 6. Same week, two vocabularies, by design

Do not "fix" these; they are different models of the same week:

- Cycle status: indexer `idle | armed | sold | unfilled | assigned | stranded | closed` (public
  tape; the indexer lane owns the exact enum); keeper `skipped | open | locked | stranded | closed`
  (its own state machine).
- Listing status: indexer `approved | partially_filled | filled | cancelled | invalidated |
  expired` (end reasons: cancel, `AllListingsInvalidated`, `BookLocked`, `RollClose`; there is no
  stale-kill status); keeper `approved | partial | filled | cancelled | expired | repriced`.
- Premium vs strike proceeds (W-21): indexer `harvest`: `grossUsdg` is the vault's whole USDG take
  (premium plus strike proceeds); `premiumGross` is premium as harvested, before the protocol fee
  (`Harvest.grossUsdg − RollClose.usdgFromAssignment`); `premiumNet` = `premiumGross − fee`;
  `strikeProceedsUsdg` is the assigned collateral sold at the strike; `creditedUsdg` =
  `premiumNet + strikeProceedsUsdg` (what holders were credited); `premiumNetPerShare` is premium
  only, `usdgPerShare` is `creditedUsdg` per share and is NOT a return. There is no venue fee any
  more, so `fill.premiumGross` (what buyers paid) equals the premium the vault received. Keeper
  `/cycles`: `gross_usdg6` still includes strike proceeds (the Harvest event's own figure);
  `premium_gross_usdg6` and `strike_proceeds_usdg6` split it. Every figure named `premium*` in
  either service is premium only.
- JSON style: indexer camelCase, bigints as decimal strings, money as `{raw, decimals,
  formatted}`; keeper `/state` and `/cycles`: raw SQLite rows in snake_case.

## 7. The fill page: the one venue

1. **The web app reads the keeper's `/orders` for the cycle page.** The vault authorises one
   `PARTIAL_RESTRICTED` Seaport order by hash (`seaport.validate`), with itself as zone and an
   empty signature; nobody else lists it anywhere. The cycle page calls `GET /api/keeper/orders`
   on its own origin.

   ```
   browser ──GET /api/keeper/orders──▶ web server ──GET KEEPER_ORDERS_URL──▶ keeper :8787/orders
                                          │  (private network, 5 s, 64 KiB, no redirects)
                                          └──eth_call──▶ chain: Seaport getCounter / getOrderHash /
                                                         getOrderStatus, vault phase / listingHash /
                                                         listingAmount / listingGrossUsdg / optionId / clear
   browser ──eth_call fulfillAdvancedOrder (~500k gas)──▶ chain   pre-flight; decoded refusal shown
   browser ──wallet: fulfillAdvancedOrder──▶ Seaport ──authorizeOrder──▶ vault writes k ──▶ tokens to buyer
   ```

   The route does not trust the keeper. It keeps only each order's `parameters` and `signature`.
   An order that does not name the vault's `listingHash()` is an earlier or superseded listing
   and is reported under `closed` as `notCurrent`, never checked further and never an alarm. For
   the one that does, it **restores Seaport's counter** from `getCounter(offerer)` (`/orders`
   drops it, and the vault's `rollClose` bumps it, so it is not safely 0), **hashes the order
   locally and has Seaport hash it** (the two must agree), and serves it only if the keeper's
   claimed hash equals that hash, the offerer and the zone are the configured vault, the order
   type is 3, the offer is the armed id on `vault.clear()`, and the single consideration item is
   USDG to the vault at the gross the vault recorded (`checkListingIsOurs`). A failure there is an
   integrity failure: returned under `rejected` and logged on `web` as one line per computation
   (`"msg":"keeper orders rejected"`). An order that passes but is sold out, cancelled, past its
   end time, or whose vault is not in its Listed phase is `closed` with that state. An order the
   chain could not be read for is `unchecked`. None of those reach a fill button. The page then
   pre-flights the fill with an `eth_call`, so a refusal the vault would make after a rally
   (`PremiumBelowFloorAtFill`, `StrikeBelowBand`) or a halt is shown as a reason instead of a
   reverting wallet transaction. Code: `web/lib/keeperOrders.ts`, `web/lib/cycleNotices.ts`,
   `web/app/api/keeper/orders/route.ts`; operator notes: `web/README.md`, `ops/deploy.md` §3.

   `KEEPER_ORDERS_URL` is a runtime server variable on `web`. Unset, the route answers 503
   `configured:false` and the page has no fill button. The keeper needs no public domain. It
   listens without a pinned host (`::`, IPv4 with it), so Railway's private network reaches it
   (dual-stack in environments created after 2025-10-16, IPv6-only before);
   `keeper/src/health.test.ts` asserts it answers on `::1`. Reachability from the deployed `web`
   service is a post-deploy check (`ops/deploy.md` §9 item 14) and, since there is no other venue,
   a launch blocker until it passes.
2. **Any Seaport 1.6 fulfil function works too.** `fulfillOrder`, `fulfillAdvancedOrder`,
   `fulfillAvailableAdvancedOrders` (the same listing may appear twice; two occurrences that overfill
   the remainder revert the whole transaction), `matchAdvancedOrders`, `fulfillBasicOrder`: the hooks
   run on every path. A buyer who saved the payload can fill with the keeper down.

## 8. What is proven and what is not

The 2026-09-13 redesign reset this table: every fork-proven link below was proven against the
pre-redesign vault and must be re-run against write on fill.

| Link | Proven by | State |
|---|---|---|
| contracts: every real Seaport 1.6 fulfil path writes exactly the fill, `InventoryLeftBehind` on the rest; AF-01..05 regressions on the real Clear bytecode | contracts gate: 399 unit/regression/invariant tests, 20 fork tests (`ca0e985`) | **green** |
| contracts: deploy, Verify 63/69/72/71, Safe handover, our own Clear (A0) | `script/rehearse-deploy.sh` on an anvil fork with `--code-size-limit 98304` | **green** (fork block 62533535) |
| indexer serialisation ↔ web parsing | the fixture contract, both test suites | **green**, fixtures to be extended for `CallsWritten`-per-fill and stranded weeks |
| keeper → create type → arm → list → fill through the hook → close | keeper dry run (`keeper/DRYRUN.md`) | **not run** against write on fill; the recorded run drove the pre-redesign vault |
| keeper boot config cross-check vs the vault (`seaportZone == vault`, `clear`) | unit tests + dry run | **to re-run** |
| indexer syncing a real week of `CallsWritten`/`OrderFulfilled`/`ClaimStranded` | X-11 (fork sync) | **not run** on the redesigned vault |
| web: fill page pre-flight, `DepositsClosed` decode, stranded banner, Retry, Settle queue | `pnpm --filter @callhouse/web acceptance:fork` (W-13) | **not run** on the redesigned vault |
| web → keeper `/orders` (route, counter restore, chain check, tamper refused) | `web/lib/keeperOrders.test.ts`, `web/lib/cycleNotices.test.ts`, `keeper/src/health.test.ts` | unit-level green; Railway private-network reachability is a post-deploy check, not yet run |
| Sourcify source verification on 4663 | — | **never exercised** (fork only) |
| any production deployment | W-19, W-20, L-08 | **not deployed** |

## 9. Bring the whole thing up against a fork

```bash
(cd contracts && forge build)
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545 --code-size-limit 98304
pnpm --filter @callhouse/keeper dryrun        # deploys a vault on the fork, drives the weeks

# indexer — copy .env.example to .env.local, then:
PONDER_RPC_URL_4663=http://127.0.0.1:8545 VAULT_ADDRESS=<dry-run vault> START_BLOCK=<fork block> \
END_BLOCK=<head> pnpm --filter @callhouse/indexer dev          # http://localhost:42069

# web — .env.local:
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545 NEXT_PUBLIC_VAULT=<dry-run vault> \
NEXT_PUBLIC_API_URL=http://localhost:42069 KEEPER_ORDERS_URL=http://127.0.0.1:8787/orders \
pnpm --filter @callhouse/web dev                              # http://localhost:3000
```

`--code-size-limit 98304` is not optional: a default anvil refuses the 25 KB vault. Pass
`--no-storage-caching` to every forked `forge script`/`forge test` run near anvil. X-11 and W-13
turn this sketch into the scripted rehearsal; the package READMEs own the details.
