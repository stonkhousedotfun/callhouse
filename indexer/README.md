# @callhouse/indexer

Ponder indexer and read API for the Stonkhouse covered-call vault on **Robinhood Chain mainnet
(chain id 4663)**.

It watches one vault, the Valorem clearinghouse it writes into, the Seaport 1.6 order book it
lists on, and the two tokens that move in and out of it. It turns that into a small Postgres
schema and a JSON API that the web app and the keeper read.

The vault it indexes is the **write-on-fill** redesign (contracts branch
`redesign/a2-own-strikes-2026-09-13`): the keeper creates a weekly Valorem option type and
`rollOpen(optionId)` ARMS it, writing nothing; every Seaport fill of the vault's own
`PARTIAL_RESTRICTED` listing writes exactly the contracts it buys, inside the vault's zone hook;
a `rollClose` whose Valorem redeem reverts strands the claim instead of freezing the vault. There
is no Overcall registry, no Overcall API and no Overcall fee: the vault numbers its own cycles,
reads the option tuple from the clearinghouse, and its own listing is the only venue. Where this
README says "registry" or "Overcall" it is describing history.

The product rule this package exists to keep: **a week with no buyer is a row of zeros, not a
missing row.** Every route below is built so an unfilled week is a first-class, publishable
outcome — and so is a week whose claim is stranded.

---

## Quick start

```bash
cp .env.example .env.local          # fill in VAULT_ADDRESS and START_BLOCK
pnpm --filter @callhouse/indexer dev
```

`ponder dev` hot-reloads on every file in the package and serves the API on `:42069`.
`ponder start` is the production command; it exits non-zero on a build error instead of
retrying.

The gate (what CI runs, and what must be green before a commit touching this package):

```bash
pnpm --filter @callhouse/indexer typecheck   # tsc --noEmit, zero errors
pnpm --filter @callhouse/indexer test        # vitest, every file under src/ and scripts/
pnpm --filter @callhouse/indexer codegen     # ponder codegen: the config and schema build
```

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `PONDER_RPC_URL_4663` | yes | Archive-capable RPC. Use `https://rpc.mainnet.chain.robinhood.com`. |
| `VAULT_ADDRESS` (alias `VAULT`) | yes | The deployed Stonkhouse vault. |
| `START_BLOCK` | yes | Block the vault was deployed in. |
| `DATABASE_URL` | no | Postgres. Omit for a local PGlite DB under `.ponder/pglite`. |
| `DATABASE_PRIVATE_URL` | no | Railway-style private URL; Ponder prefers it over `DATABASE_URL`. Set one, not both. |
| `DATABASE_SCHEMA` | yes | Ponder refuses to start without a schema; `--schema <name>` also works. Leave unset on Railway (see "Deploy"). |
| `END_BLOCK` | no | Stop indexing here. Leave unset in production. Used to bound a replay. |
| `PGLITE_DIRECTORY` | no | Force PGlite at this path, even with `DATABASE_URL` set. For the fork sync's throwaway database; leave unset otherwise. |
| `LIVE_READ_TIMEOUT_MS` | no | Deadline on one batched live read. Default 8000. |
| `CLEARINGHOUSE` | no | The Valorem Clear the vault was constructed with (`Vault.clear()`). Default: the upstream build at `0x9a7b…C0C0`. A vault deployed on our own `DeployClear.s.sol` instance sets it. |
| `SEAPORT` / `USDG` / `ASSET` / `MULTICALL3` | no | Override the built-in mainnet addresses for a fork. |
| `PORT` | no | The HTTP port. Ponder reads it before `--port`. |

`VAULT_ADDRESS` and `START_BLOCK` have no defaults on purpose. Chain 4663 is past block
61,000,000; a scan from genesis is hours of `eth_getLogs` over a period when the vault did not
exist. The config throws with an explanatory message rather than quietly indexing nothing.

Gone with the redesign, and refused if you look for them in `lib/env.ts`: `REGISTRY`,
`REGISTRY_START_BLOCK`, `OVERCALL_ORDERS_URL`, `OVERCALL_MARKET`, `OVERCALL_FEE_RECIPIENT`,
`KEEPER_HMAC_SECRET`. There is no registry source, no `POST /v1/overcall/list` route and no
HMAC; delete the variables from any service that still carries them.

### `DATABASE_URL`

Ponder uses Postgres when `DATABASE_URL` (or `DATABASE_PRIVATE_URL`) is set, and PGlite —
an embedded Postgres under `.ponder/pglite` — when it is not. PGlite is fine for local work and
for the fork sync; production should be Postgres so `ponder serve` can run the API on separate
instances from the indexer.

Ponder also requires a **database schema** (a Postgres namespace) so that two deployments can
share one database without colliding: `DATABASE_SCHEMA=callhouse` or `--schema callhouse`.
A fresh deploy to a new schema backfills from scratch (from Ponder's RPC cache when it is warm). Reusing a
schema only resumes when neither the code nor the config changed; otherwise Ponder refuses it. On Railway
leave `DATABASE_SCHEMA` unset so each deployment gets its own schema (see "Deploy (Railway)").

---

## Backfilling

```bash
# full backfill from the vault's deploy block, following the head afterwards
DATABASE_SCHEMA=callhouse pnpm --filter @callhouse/indexer start

# bounded replay, e.g. to reproduce one week
START_BLOCK=61153980 END_BLOCK=61160000 DATABASE_SCHEMA=replay \
  pnpm --filter @callhouse/indexer start
```

Progress shows as `Updated backfill indexing progress`. `GET /ready` returns 503 until the
historical sync finishes and 200 afterwards — that is the signal to cut traffic over.

**The public RPC rate-limits.** A backfill over a wide range will collect HTTP 429s; Ponder
retries with backoff and finishes anyway, but a dedicated endpoint is the difference between
minutes and hours. The `robinhood-rpc.publicnode.com` backup is *not* usable here: it answers
`Archive requests require a personal token` on historical `eth_getLogs`.

To start over, drop the schema (`DROP SCHEMA callhouse CASCADE`) or `rm -rf .ponder` for PGlite.

---

## Deploy (Railway)

`indexer/Dockerfile` + `indexer/railway.json`, repo root as the build context, one Railway
Postgres. Every setting and variable is in `ops/deploy.md` §11; the four facts that decide whether
a deploy works:

- **The schema changes on every deploy.** The image runs
  `ponder start --schema ${DATABASE_SCHEMA:-$RAILWAY_DEPLOYMENT_ID}`. Leave `DATABASE_SCHEMA`
  **unset** on Railway. A schema remembers the build that created it — reusing one with different
  code or config fails with `Schema "…" was previously used by a different Ponder app` — and it is
  locked by a heartbeat while the old deployment is still serving, which Railway keeps doing until
  the new one is healthy. The first was reproduced against a local Postgres; the second is
  Ponder 0.17's `tryAcquireLockAndMigrate` (`Failed to acquire lock on schema`).
- **A new schema is not a cold backfill.** RPC responses are cached in the shared `ponder_sync`
  schema; a redeploy re-runs the handlers over cached logs and only fetches blocks newer than the
  cache. Old deployment schemas stay in the database until `ponder db prune`.
- **The Railway healthcheck is `/ready`, not `/health` or `/v1/health`.** `/ready` is 503 until the
  backfill finishes, so Railway keeps traffic on the previous deployment until the new one has the
  whole history — no half-indexed tape is ever served. `/health` is 200 as soon as the HTTP server
  exists (before any block is indexed), and `/v1/health` is 503 until the first checkpoint and then
  200 while still `lagging`, and it also fails when the RPC blips. `/v1/health` is for the uptime
  monitor, after the deploy.
- **Pick `START_BLOCK` well behind the head.** The public RPC load-balances across nodes whose heads
  were measured up to ~4,000 blocks apart. A `START_BLOCK` newer than a lagging node's head makes
  Ponder's first `eth_getBlockByNumber` fail with `BlockNotFoundError` and the process exit (code
  75). The vault's deploy block is always far enough back; a smoke test should be too.

```bash
# from the repo root — the smoke test this section was written from
docker build -f indexer/Dockerfile -t callhouse-indexer .
docker run -d --name ch-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
docker run --rm -p 42069:42069 \
  -e DATABASE_URL=postgres://postgres:pw@host.docker.internal:55432/postgres \
  -e DATABASE_SCHEMA=smoke \
  -e PONDER_RPC_URL_4663=https://rpc.mainnet.chain.robinhood.com \
  -e VAULT_ADDRESS=<vault> -e START_BLOCK=<head - 2000> callhouse-indexer
curl -si localhost:42069/ready     # 503 "Historical indexing is not complete." → 200
curl -s  localhost:42069/v1/health # {"status":"ok", …, "lag":{"blocks":"123","seconds":"14"}}
```

---

## What is indexed, and why

| Source | Address | Filtered by | Why |
|---|---|---|---|
| `Vault` | `VAULT_ADDRESS` | — | Every vault event. The primary record, and the clock: `RollOpen` is what makes a week exist. |
| `Clear` | `CLEARINGHOUSE` | `writer` / `redeemer` = vault on two events | Writes and redemptions. Exercise and bucket events carry no address for us and are narrowed in the handler. |
| `Seaport` | `0x0000…B395` | `offerer` = vault | Fills of the vault's own listing: the contracts moved and the USDG paid, per fill. |
| `StockTokenIn` / `StockTokenOut` | NVDA token | `to` / `from` = vault | Exact asset balance without an RPC read. |
| `UsdgIn` / `UsdgOut` | USDG | `to` / `from` = vault | Exact USDG balance. |
| `StockToken` | NVDA token | — | The issuer's switches: oracle pause, transfer pause, ERC-8056 multiplier. |

Two sources per token because a log filter **ANDs** its topics: `from == vault` and
`to == vault` cannot be expressed as one filter. Ponder fetches only the events that have a
handler, so a `filter` entry narrows topics 1–3 for that event and the unfiltered Clear events
(`OptionsExercised`, `BucketWrittenInto`, `BucketAssignedExercise`) still arrive.

### Every event, accounted for

Every event the vault, its adapters (`AdapterSeaport`, `AdapterValorem`) and the `Distributor`
emit has a handler in `src/vault.ts`, with two deliberate exceptions: `RoleAdminChanged` can never
fire (the vault never calls `_setRoleAdmin`) and `Approval` is an ERC-20 allowance on the shares
with no product meaning. On the Clear, `NewOptionType`, the fee events and the ERC-1155 plumbing
are not indexed; `src/valorem.ts` says why, one line each.

### Facts baked into the handlers

- **The vault is the clock.** `RollOpen(cycleNumber, optionId, contractsCount, strikeUsdg)` creates
  the week's row; the vault numbers its own cycles. `contractsCount` is **always 0** under write on
  fill (the handler warns if it ever is not). The option's window comes from
  `clear.option(optionId)` at that block — immutable in Valorem, so as deterministic as a log —
  with the vault's own `cycleExerciseTs` / `cycleExpiryTs` as the fallback. Cycle times are
  Eastern: exercise at the NYSE Friday 16:00 America/New_York close, expiry 24 h later.
- **The fill is the write.** Every Seaport fill of the vault's listing calls the vault's
  `authorizeOrder`, which writes exactly the filled contracts into Valorem and emits
  `CallsWritten(optionId, claimKey, contractsCount, collateral)` **once per fill**. The handler
  SUMS `contractsCount` and `collateral` per cycle (one claim key per cycle; every fill tops the
  same claim up). Seaport's `OrderFulfilled` in the same transaction carries the contracts moved
  and the one USDG consideration item; `cycle.contractsSold` sums those, and written == sold by
  construction. A difference is a bug in the tape, logged at the close.
- **Listings are `PARTIAL_RESTRICTED`, sized to capacity, and a relist is a reprice.**
  `ListingApproved.seq` is `listingsThisCycle` after the approval: a plain count, unique within
  the cycle, at most 3. There is no price-cut slot and no stale-kill. A listing ends by a fill
  (`filled`), a `cancelListing` (`cancelled`), a counter bump (`counter`), `lockBook` or
  `rollClose` — the last three all emit the same `ListingCancelled` + `AllListingsInvalidated`
  pair, and the event that follows in the same transaction refines `endReason`.
- **Valorem's `Claim.amountWritten` / `amountExercised` are 1e18-scaled scalars, not contract
  counts.** Event arguments (`OptionsWritten.amount`, `OptionsExercised.amount`) are raw
  counts. Anything read from `claim()` is divided by 1e18; nothing from an event is.
- **`RollClose.contractsAssignedCount` is real and is used.** The vault reads it from
  `contractsAssigned()` *before* the redeem is attempted, so it is authoritative on a stranded
  close too.
- **A stranded close is `ClaimStranded` then a zero-leg `RollClose`.** `rollClose` could not
  redeem the claim (USDG paused, the vault or Clear frozen on USDG, Clear's USDG burnt, the vault
  blocklisted on NVDA in an unassigned week): the vault reaches Idle with `claimKey`, `optionId`
  and `contractsWritten` kept, `isStranded()` is true, deposits and instant redemption are shut,
  `rollOpen` refuses. The cycle's `assignmentUsdg` and `assetsReturned` stay 0 and its status is
  `stranded` until anyone's `retryStrandedClaim()` lands: `ClaimRedeemed` + `StrandedClaimRecovered`
  + a fee-free `Harvest` under the **stranded** cycle's number. Every epoch that settled while
  the claim was stranded took a WAD share of it (`EpochStrandShare`); at recovery that part of
  both legs goes to the reserves and is folded into owners as they collect (`StrandShareSettled`).
- **`Harvest` is emitted from THREE places and they mean different things.** `_harvest()` inside
  `rollClose` always emits, including the honest zero of an unfilled week — the week's verdict.
  `_checkpointHarvest()` inside `deposit` / `mint` / `settleQueue` emits whenever premium has
  already landed, so a late depositor cannot mint into premium earned before they arrived and a
  flat queue settlement pays the escrow its accrual. `_harvest()` inside `retryStrandedClaim`
  indexes the live shares' part of a recovered claim's USDG. Same event, same cycle number. They
  are told apart by the transaction (`lib/lifecycle.ts harvestOrigin`): `rollClose` emits
  `RollClose` immediately before its harvest, `retryStrandedClaim` emits `StrandedClaimRecovered`
  before its. Only the terminal one closes the week, returns the phase to Idle and moves the
  cycle tallies; all three move real money and accumulate onto the cycle (a checkpoint only while
  the week is still open). Rows carry `origin`, and `/v1/activity` shows terminal rows only
  unless asked for `include=all`.
- **On an assigned week `Harvest.feeUsdg / Harvest.grossUsdg` is not the fee rate.** `grossUsdg`
  on the close includes the strike proceeds, but the vault charges the fee on
  `grossUsdg − RollClose.usdgFromAssignment` only. The handler takes all three amounts from the
  event verbatim and never recomputes the fee. `netUsdg == grossUsdg − feeUsdg` always.
- **On an assigned week `Harvest.netUsdg` is not premium** (W-21). The strike proceeds in it are
  returned principal. `lib/harvest.ts` splits every `Harvest` into `strikeProceeds` (the terminal
  harvest's `RollClose.usdgFromAssignment`; the retry's live part of the recovered USDG; 0 for a
  checkpoint), `premiumGross = grossUsdg − strikeProceeds` and `premiumNet = premiumGross −
  feeUsdg`. Every column and API field named `premium*` is premium only; the whole credited
  amount is published beside it as `creditedUsdg` / `usdgPerShare`.
- **There is no venue cut.** One consideration item, USDG to the vault, so what a fill paid is
  what reached the vault: `cycle.premiumGross` (from Seaport) equals `cycle.harvestPremiumGross`
  (from the harvests) once every fill's USDG has been swept.
- **The protocol fee accrues and pays on different events.** It accrues at every `Harvest` with
  premium in it (`feeUsdg`, tallied in `lifetimeProtocolFee`), but the push inside `rollClose` is
  best-effort — a blocked recipient must not freeze the close — so payment happens whenever it
  can, through `FeeSwept` (tallied in `totalFeeSwept`). The vault's live `pendingFeeUsdg` is
  `lifetimeProtocolFee − totalFeeSwept`.
- **A queue entry settles and pays out on different events.** `QueueEntrySettled` moves an entry
  out of its epoch into the owner's owed balances — pure bookkeeping, no tokens — and fires both
  inside `completeRedeem` and inside `queueRedeem` when joining auto-settles a stale slot. The
  epoch's `*Claimed` columns are drawn down THERE. `CompleteRedeem` reports the payout, and it is
  the only place `reservedAssets` comes down — apart from `ReserveHaircut`, which takes the
  shortfall off it when an issuer burn left the reserve unbacked (AF-05). `UsdgLegDeferred` says
  a payout's USDG leg could not move (AF-03): still owed, recorded on the user until a later
  payout moves USDG.
- **`QueueSettled` has two origins.** Inside `rollClose` (the epoch's `cycleNumber` is that week)
  and from the permissionless `settleQueue()` while Idle (`cycleNumber` null — it belongs to no
  week, and while a claim is stranded it is the exit).
- **The single deposit gate is not an event.** `DepositsClosed` fires for five reasons (not Idle
  or Listed, Listed but past the exercise timestamp, an unclaimed assignment or a stranded claim,
  an unbacked reserve, the share-price floor) and `maxDeposit` also quotes 0 at the cap;
  `maxDeposit(addr) == 0` is the whole gate in one number, read live.
- **USDG is 6 decimals, the Stock Token and the shares are 18.** Every API amount carries its
  own `decimals` so nothing has to be assumed.
- **`uiMultiplier()` is display only.** The vault never rebases and all share maths use raw
  balances.

---

## Tables

All amounts are base units in a `numeric` column, surfaced by the API as decimal strings.

### `vault_state` — one row, the running reduction of every event

Phase, cycle, balances, lifetime totals, governance settings, the issuer's switches, and the
stranded-claim state machine (`stranded`, `strandGen`, `lastResolvedGen`, `strandedRemainingWad`,
`strandedCycleNumber`). This is what `GET /v1/vault` reads before layering the live reads on top.

Three column names are deliberate:

- `lockedCollateral` is the sum of every fill's `CallsWritten.collateral`, held until the claim is
  redeemed (kept while stranded). It is *not* `Vault.lockedAssets()`, which reads Valorem's live
  position and therefore falls as buyers are assigned mid-week. The API reports the live figure
  under `tvl.lockedAssets` and the indexed one as the fallback.
- `contractsWritten` is the sum of the cycle's `CallsWritten`, which under write on fill IS the
  number sold; the cycle row keeps Seaport's own count beside it as the cross-check.
- `lifetimeProtocolFee` and `totalFeeSwept` are accrual and payment of the protocol fee. They
  differ on purpose — the push is best-effort — and their difference is the vault's live
  `pendingFeeUsdg`.

`optionId` and `claimKey` are cleared when the claim is redeemed and at an unfilled close (the
contract forgets the type), and kept while a claim is stranded, exactly as the contract does.

### `cycle` — the public record, one row per cycle the vault armed

Keyed by the vault's own cycle number. A row appears at `RollOpen` and never before: nothing
announces weeks any more, so there is no "announced and sat out" row.

`status` is the whole story of the week:

| status | meaning |
|---|---|
| `listed` | The keeper armed an option type. Nothing is written yet. |
| `filled` | A buyer filled. Set on the first matching `OrderFulfilled`; the same transaction's `CallsWritten` is the write that fill caused. |
| `unfilled` | The week closed with zero contracts sold, so nothing was ever written and there was no claim. **The most likely outcome.** Every money column is 0. Terminal. |
| `closed` | Filled, expired out of the money. Premium kept, tokens kept. Terminal. |
| `assigned` | Contracts were taken at the strike: tokens out, USDG in. Terminal. |
| `stranded` | The close could not redeem the claim. `contractsAssigned` is known, the legs are 0, `settlement.strand` names the generation. Becomes `assigned` or `closed` when `retryStrandedClaim` lands; `stranded: true` stays as history. |

The money columns the site quotes:

| column | meaning |
|---|---|
| `premiumGross` | What buyers paid on the cycle's fills: the one USDG consideration item, summed. What reached the vault. |
| `harvestGross` | The vault's whole USDG take as the `Harvest` events measured it: premium **plus**, on an assigned week, the strike proceeds. Not a premium figure. |
| `harvestPremiumGross` | `harvestGross − strikeProceeds`. Premium only, as harvested. |
| `strikeProceeds` | The strike-proceeds part of the harvests: `RollClose.usdgFromAssignment` on the terminal harvest, the live shares' part of a recovered stranded claim on the retry's. Returned principal, never yield. 0 on every week not assigned. |
| `assignmentUsdg` | The whole strike USDG the claim returned. Differs from `strikeProceeds` only after a strand, by the part the queue took directly. |
| `fee` | The protocol fee: `protocolFeeBps` (launch 500, 5%) of the premium only, taken at harvest. Strike proceeds are never fee'd. |
| `premiumNet` | `harvestPremiumGross − fee`. **Premium only.** |
| `creditedUsdg` | `harvestGross − fee` = `premiumNet + strikeProceeds`: everything the Distributor credited to holders. Real money, not a return. |
| `premiumNetPerShare` | `premiumNet` per whole share, summed per sweep. The per-share premium figure. |
| `usdgPerShare` | `creditedUsdg` per whole share, summed per sweep. Includes strike proceeds. |

`marketExercised`, `bucketIndex` and `bucketAssigned` are intra-week *signals* about Valorem's
bucket lottery, not claims about our assignment — that is only known at redeem.

### `listing` — one row per Seaport order the vault authorised

Keyed by order hash. Carries the ask (`amount`, `grossUsdg`, `unitPriceUsdg` — exact, because the
contract proved `grossUsdg % amount == 0`), the realised fills (`contractsFilled`,
`proceedsUsdg`, `fillCount`), and how the order ended (`endReason`: `filled`, `cancelled`,
`counter`, `lockBook`, `rollClose`). `seq` is 1–3 and unique within the cycle. There is no fee
split on it: what a fill pays is what reached the vault.

### `user` — per-depositor position

`shares` mirrors `balanceOf` and therefore **excludes** anything escrowed in the redeem queue —
the vault holds those shares itself. `queuedShares` mirrors `Vault.queuedSharesOf`. `strandWad` /
`strandGen` are the owner's staged share of a stranded claim (`owedStrandWad` / `owedStrandGen`);
`deferredUsdg` a USDG leg a payout could not move; `haircutAssets` what an unbacked reserve took.

Claimable USDG is **not** in this table: it depends on a per-account snapshot inside the
Distributor that no event exposes. `GET /v1/account/:addr` reads `claimableUsdg(address)` live.

### `harvest` — one row per `Harvest` event, including the zero ones

The terminal harvest fires on every `rollClose` unconditionally, so an unfilled week always
produces a row with `terminal: true`, `filled: false` and `grossUsdg: 0`. Each row carries the
event's own `grossUsdg` / `feeUsdg` / `netUsdg`, its `origin` (`rollClose`, `checkpoint`,
`retry`) and that event's split: `strikeProceedsUsdg`, `premiumGrossUsdg`, `premiumNetUsdg`.
`supply` is the pre-burn, pre-mint share count: `_settleQueue` runs *after* `_harvest`, so shares
escrowed for the queue earn the week they sat through, and `_checkpointHarvest()` runs *before*
`_mint`, which is the whole point of it existing.

### `queue_epoch` — one row per redemption epoch

The vault opens at epoch 1 and increments on every settlement. Queuing escrows shares;
settlement burns them and sets aside pro-rata idle assets plus the USDG the escrow accrued.
Entries are then drawn down on `QueueEntrySettled` and the last one takes the remainder, so
`*Claimed` converges on `*Settled`. An epoch settled while a claim was stranded also owns
`strandWad` (of 1e18) of that claim's generation `strandGen`, drawn down as `strandWadClaimed` and
paid to its owners once the claim is recovered.

### `strand` — one row per stranded claim

Keyed by the vault's generation counter: when it stranded (`cycleNumber`, `claimKey`,
`strandedAt`), what the settled epochs took (`epochWad`, `epochCount`), whether and when it
recovered, what the redeem returned (`assetsIn`, `usdgIn`), the queue's part of it (`queueWad`)
and how much of that is still to be folded into owners (`wadLeft`, `assetsLeft`, `usdgLeft`,
`settledCount`).

### `role_member` — who can touch the vault

One row per (role, account). Rows are never deleted: a revoked grant keeps `granted: false`
with a `revokedAt`, so the history survives. `roleName` resolves the hash to
`DEFAULT_ADMIN_ROLE`, `KEEPER_ROLE` or `GUARDIAN_ROLE`.

### `vault_snapshot` — append-only state trail

One row per state-changing event, keyed `${blockNumber}-${logIndex}`, with a `reason` naming the
event. `idleAssets` = `assetBalance − reservedAssets` and matches `Vault.idleAssets()`.

---

## API

Public `GET` routes are cached 15 seconds, in-process and via `Cache-Control: public,
max-age=15`. Responses carry `x-cache: HIT|MISS`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/vault` | TVL, phase, the deposit gate, the stranded-claim state, this week's option / listing / fills / capacity, the last terminal harvest, lifetime totals, roles. |
| GET | `/v1/cycles` | Full history, newest first. `?status=`, `?limit=`, `?offset=`. Includes unfilled-0 weeks and stranded ones. |
| GET | `/v1/cycles/:cycle` | One week, with its listings, every harvest carrying its number, and its strands. |
| GET | `/v1/activity` | The weekly tape: terminal harvests, including the zero rows. `?include=all` adds checkpoint and retry harvests. |
| GET | `/v1/account/:addr` | Shares, claimable USDG, queued position, any pending share of a stranded claim. |
| GET | `/v1/listings` | Current and past listings. `?cycle=`, `?status=`. |
| GET | `/v1/listings/:hash` | One order by hash. |
| GET | `/v1/strands` | Every stranded claim, newest first. |
| GET | `/v1/snapshots` | The raw state trail. |
| GET | `/v1/health` | Indexer head vs chain head, lag in blocks and seconds, and whether a claim is stranded. |
| POST | `/graphql` | Auto-generated from `ponder.schema.ts`. The escape hatch. |

### The stranded fields

- `/v1/vault.phase.depositsOpen` is `maxDeposit(0) > 0`: the one gate, live. `phase.clearFeesEnabled`
  is Clear's own fee switch beside `phase.valoremFeeAccepted`; on and not accepted means no arm
  and no fill. `phase.canRedeemInstantly` is false while stranded.
- `/v1/vault.stranded` is the state machine: `stranded` (`isStranded()`), `gen`, `lastResolvedGen`,
  `remainingWad` (the part of the claim live shares still own, of `wad` = 1e18), `cycle`,
  `claimKey`, `since` and `lockedAssets` while stranded, null otherwise.
- `/v1/vault.queue.canSettle`: `settleQueue()` is callable — Idle with shares queued — which
  while stranded is the only exit.
- A cycle's `settlement.strand` is `{gen, recovered, recoveredAt, recoveredTx}` or null;
  `stranded: true` stays as history after recovery while `status` becomes the verdict.
- `/v1/account/:addr.strand` is the owner's pending share: `wad` staged against them
  (`owedStrandWad`), `epochWad` still inside the epoch they queued into, `recovered`, and the
  strand row. `queue.preview*` include a recovered share; an unrecovered one is quoted as nothing.
- `/v1/strands` lists every generation; `/v1/cycles/:n.strands` the ones of that week.

### X-1, X-2, X-3

`listing.hash` on `/v1/vault` and `liveHash` on `/v1/listings` are null when the vault's
`listingHash()` is `bytes32(0)`, never a zero hash (X-1). Every enum value in `ponder.schema.ts` is
produced by a handler and accepted by the matching `?status=` filter, pinned by
`src/api/index.test.ts` (X-2). `/v1/vault.lastHarvest` is the last **terminal** harvest, which is
not the last harvest when a retry or a checkpoint came after it; the last closed week whole is
`lastClosedCycle` (X-3).

### The cycle shape is a tested contract

What `/v1/cycles` emits for one week — `cycleJson` in `src/api/index.ts` — is pinned by the
four files under `../ops/fixtures/api/`: a filled, an unfilled, an assigned and a stranded week,
with real numbers (12 contracts at 4.000000: 48 USDG gross, all of it to the vault, 2.4 protocol
fee, 45.6 net premium over 100 shares; 5 × 190 of strike proceeds on the assigned one, fee-free
and published as `harvest.strikeProceedsUsdg` beside a premium-only `harvest.premiumNet`; the
stranded one with `contractsAssigned` 5 known, both legs 0 and `settlement.strand.gen` 1).
`src/api/index.test.ts` builds those rows as typed schema literals, runs `cycleJson`, and
deep-equals the result against the files; the dapp's `web/lib/api.test.ts` reads the same files
and asserts what it renders from them. Change the shape and the indexer test fails; regenerate
the fixtures (`CALLHOUSE_WRITE_FIXTURES=1 pnpm --filter @callhouse/indexer test`) and the web
test tells you whether the dapp can still read it. The test loads the Hono app under `vitest`,
which means the `ponder:*` virtual modules and the `graphql()` middleware are stubbed just enough
for the module to import — nothing that is stubbed is asserted on.

### Health

Ponder **reserves** `/health`, `/ready`, `/status`, `/metrics` and `/client` for its own server
and refuses to build if an app route shadows one. Its `/health` is a bare liveness probe (empty
200) and `/ready` returns 503 until the backfill finishes. The lag payload therefore lives at
`/v1/health`:

```json
{
  "status": "ok",                       // ok | lagging | degraded
  "indexer": { "head": "61154100", "headAt": "2026-09-12T13:49:22.000Z" },
  "rpc":     { "head": "61154107", "reachable": true },
  "lag":     { "blocks": "7", "seconds": "14" },
  "vault":   { "phase": 1, "phaseName": "Listed", "cycle": 1, "writesHalted": false, "stranded": false }
}
```

`status` is `ok` under 120 seconds of lag, `lagging` beyond it, `degraded` if the index head or
the RPC cannot be read at all (503). Point uptime checks at `/health`, point the dashboard and
the keeper's alerting at `/v1/health`; `vault.stranded` is the STRANDED_CLAIM signal.

### Live reads and graceful degradation

Almost everything is served from the index. A handful of facts cannot be: Valorem's mid-week
position (`lockedAssets`, `contractsAssigned`), the deposit gate (`maxDeposit`), capacity
(`policy()` + `totalAssets()` − `contractsWritten()`), `claimableUsdg` / `owedStrandWad` /
`previewCompleteRedeem` per account, `spotUsdg()`, `uiMultiplier()` and Clear's `feesEnabled()`.

Those are read through **Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`,
`eth_getCode`-confirmed on 4663, `MULTICALL3` to override on a fork), with
`allowFailure: true`. This is not an optimisation detail — `GET /v1/vault` needs about thirty
views, and Ponder's API client funnels every request through the same rate-limited RPC queue the
indexer uses, so fired one at a time they serialise behind each other and blow any deadline worth
having. Measured on `rpc.mainnet.chain.robinhood.com`, that emptied the entire live half of the
payload to nulls while the node itself was healthy. Batched, `/v1/vault` answers in under a second.

Each batch carries a deadline (`LIVE_READ_TIMEOUT_MS`, default 8s). A view that reverts, a
batch that times out, or a chain with no Multicall3 all degrade to `null`, and the response
still goes out with `live: false` and the indexed figures in place — `spotUsdg` reverting is
itself a signal, because the vault refuses to arm or fill on a stale price.

---

## Fork sync (X-11)

```bash
(cd contracts && forge build)                 # the dry run deploys contracts/out
pnpm --filter @callhouse/indexer fork:sync
```

`scripts/fork-sync.ts` starts anvil (fork of 4663, port 8547, `--code-size-limit 98304` — the
chain's real limit; a default anvil refuses the ~25.8 KB Vault), runs the keeper dry run on it
(three cycles: one unfilled; one bought in several fills with contracts assigned, a deposit while
Listed and a queued redeem; one stranded by a USDG freeze at its close and recovered by
`retryStrandedClaim`), then `ponder start` on the same node: the dry run's vault, `START_BLOCK`
= its deploy block, `END_BLOCK` = the last dry-run block, a throwaway PGlite database under
`.ponder/fork-sync/<utc>/`. When `/v1/health` reports the head at `END_BLOCK` it queries
`/v1/vault`, `/v1/cycles`, `/v1/cycles/:n` for every cycle, `/v1/account/<depositor>`,
`/v1/listings`, `/v1/activity` (terminal and all), `/v1/strands`, `/v1/health` and `/graphql`,
and compares every leaf exactly with values derived from the fork's own logs and views
(`fork-sync/chain.ts`) and the dry run's `run.json` (`fork-sync/expected.ts`), never from the
indexer: per cycle the status, contracts written / sold / assigned, strike, listings and fills,
every harvest's origin and split, `assetsReturned`, the strand and its recovery, timestamps and
hashes; the queue epochs and their strand shares; lifetime sums; Distributor totals; the
depositor's position. `run.json` and the chain are cross-checked first. Exit 0 with a summary or
1 with a per-field diff; every process it started is stopped. `FORK_SYNC_*` knobs are listed at
the top of the script. It refuses any RPC that is not loopback: it warps time and writes storage.

`run.json` must carry, and `expected.ts` names as `RunJson` / `RunCycle`: `addresses.Vault`,
`actors.{admin,keeper,depositor}`, `blocks.{vaultDeployBlock,lastBlock}`, and one `cycles[]`
entry per cycle with `cycleNumber`, `optionId`, `strikeUsdg6`, `exerciseTimestamp`,
`expiryTimestamp`, `rollOpenTx`, `lockTx`, `rollCloseTx`, `fills[]{txHash,contracts,grossUsdg6}`,
`contractsAssigned`, `harvest{gross,fee,net}`, `stranded`, `retryTx`, `assetsReturned`,
`usdgFromAssignment`. A missing field fails by path before anything is compared. Everything
else the API publishes is derived from the chain, so the keeper's record is a cross-check, not
the source. `fork-sync/expected.test.ts` runs the builder over a hand-written three-week fixture
of exactly that shape and pins the derived figures.

Ponder needs no change to run against anvil: it backfills to head − 30 (its finality depth for
an unknown chain), answers `/ready`, then indexes the rest through realtime sync — which is why
the script waits on `/v1/health`, not `/ready`. `lag.seconds` is negative on the fork because the
dry run warps the clock ahead. The only config addition is `PGLITE_DIRECTORY`, so each run gets a
clean database (every fork deploys the vault at the same address).

**Status.** The redesign fork sync has not been run yet; it is the X-11 stage of the app port and
runs once the keeper's rewritten dry run produces a `run.json` of the shape above. The last
passing run (2026-09-13, fork block 62263964) was against the pre-redesign vault and its
MockRegistry, 1452 of 1452 assertions; three indexer defects it found are fixed and still hold:

- **Constructor settings were never indexed.** `Vault`'s constructor sets `policy`,
  `feeRecipient` and `depositCap` with no event, so `/v1/vault` published `protocolFeeBps: 0` and
  `feeRecipient: null` for a vault charging 500 bps. A `Vault:setup` handler seeds them from views
  at `START_BLOCK` (`lib/deployment.ts`, unit tested); governance events still overwrite them.
- **`usdg.claimed` left out the redeem queue.** `Distributor.totalUsdgClaimed` also counts the
  escrow's accrual taken at `_settleQueue` (`QueueSettled.usdgOut`); the index counted `ClaimUsdg`
  only. `QueueSettled` adds it.
- **The Valorem bucket landed on the previous week.** Under the pre-redesign write-at-open flow
  `BucketWrittenInto` fired before `RollOpen`. Under write on fill every write happens inside a
  fill, after `RollOpen`, so the bucket is stamped straight onto the cycle row.

---

## ABIs

`abis/*.ts` are **generated** from `ops/abis/*.json` by `pnpm gen:abis`. They are `as const`
TypeScript rather than JSON imports because abitype infers every handler's `event.args` from an
ABI literal, and a JSON import widens `type` to `string` and collapses all of it to `any`. The
generator also strips the `_comment` / `_selector` / `_verified` annotations that
`ops/abis/StockToken.json` carries for human readers.

The vault target merges the error fragments of `ValoremLib.json`, `SeaportOrderLib.json` and
`Policy.json` into `abis/vault.ts` (errors only): 36 of the vault's 92 error signatures are raised
inside a DELEGATECALLed library and are absent from `Vault.json`, and a decoder built from it
alone prints them as bare selectors.

`abis/seaport.ts` is hand-written: `ops/abis/` has no Seaport artefact and only three events
and two views are ever used. Every signature in it was confirmed against the deployed bytecode
(`OrderFulfilled` topic0 `0x9d9af8e3…6f31`; see `ops/recon/R2-R9-seaport-order-shape.md`).

Re-run `pnpm gen:abis` after any change under `ops/abis/`, then `pnpm typecheck`.

---

## Layout

```
ponder.config.ts      chain 4663, the eight sources and their topic filters
ponder.schema.ts      nine tables and four enums
ponder-env.d.ts       generated by `ponder codegen`; commit it
abis/                 generated (+ hand-written seaport.ts)
lib/env.ts            every address and knob, resolved once
lib/indexing.ts       shared reducers: state, snapshots, users, cycles, epochs, strands
lib/lifecycle.ts      the pure decisions: harvest origin, close status, strand maths, capacity
lib/harvest.ts        one Harvest split into premium and strike proceeds (W-21)
lib/roles.ts          the three AccessControl role hashes and what each one can do
lib/deployment.ts     constructor-set vault settings, seeded by Vault:setup
src/vault.ts          every vault, adapter and Distributor event
src/valorem.ts        Valorem, narrowed to our writer / claim / option
src/seaport.ts        OrderFulfilled → contractsSold and the realised price, per fill
src/token.ts          balances in and out, plus the issuer's switches
src/api/index.ts      the Hono app
src/api/chain.ts      live reads, each with a deadline
src/api/cache.ts      the 15s cache
src/api/serialize.ts  bigint → decimal string, and `{raw, decimals, formatted}` amounts
scripts/gen-abis.mjs  ops/abis/*.json → abis/*.ts
scripts/fork-sync.ts  X-11: dry run on a fork, sync, assert the API (fork-sync/: chain reads, expectations, diff)
```

Files under `src/` other than `src/api/**` are indexing functions and are executed by Ponder at
build time. Shared code that both the handlers and the API need lives in `lib/`. The handlers
import `ponder:registry`, which exists only inside a Ponder process, so they are not unit-tested;
the decisions they delegate to `lib/` are (`vitest.config.ts` says why).
