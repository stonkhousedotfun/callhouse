# @callhouse/indexer

Ponder indexer and read API for Stonkhouse on **Robinhood Chain mainnet
(chain id 4663)**.

V2 watches all markets through one Clearinghouse (`V2_CLEARINGHOUSE`). The legacy sources watch
one product per process: the pooled vault (`VAULT_ADDRESS`), or a factory market
(`FACTORY_ADDRESS`: an `AccountFactory` and its `WriterAccount` clones, see "Factory markets"
below), or both. V2 and legacy sources may run together. For the vault that is the vault itself, the Valorem clearinghouse it writes into,
the Seaport 1.6 order book it lists on, and the two tokens that move in and out of it. It turns
that into a small Postgres schema and a JSON API that the web app and the keeper read.

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
cp .env.example .env.local          # fill in a legacy group, a v2 group, or both
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
| `PONDER_RPC_URL_4663` | yes | Archive RPC that serves historical `eth_call` and `eth_getLogs` for a VAULT deployment (the vault handlers `eth_call` past blocks during backfill; `rpc.mainnet.chain.robinhood.com` answers "historical state ... is not available"). Production uses `https://robinhood-mainnet.g.alchemy.com/v2/<key>`. A FACTORY market backfills logs on the public RPC and wants the archive only for the optional `Factory:setup` settings read (see "Factory markets"). |
| `VAULT_ADDRESS` (alias `VAULT`) | one of the three groups | The deployed pooled vault. The NVDA legacy deployment sets this and only this, as before. |
| `FACTORY_ADDRESS` (alias `FACTORY`) | one of the three groups | A factory market's `AccountFactory` (`ops/markets/tier1.json` → `deployment.factory`). See "Factory markets". |
| `V2_CLEARINGHOUSE` | one of the three groups | The v2 Clearinghouse shared by every v2 market. Distinct from the legacy Valorem `CLEARINGHOUSE`. |
| `V2_ORDER_BOOK` / `V2_SETTLEMENT_ORACLE` / `V2_AUTO_ROLLER` / `V2_MAKER_REGISTRY` | with `V2_CLEARINGHOUSE` | The four other v2 event sources; all five addresses must be set together. |
| `V2_EXPIRY_CALENDAR` / `V2_KEEPER_REWARDS` | no | Optional periphery event sources. When set, calendar policy changes and keeper bounties/rewards are indexed from `V2_START_BLOCK`. When the calendar is unset, a nonweekly series cannot be identified as a whitelisted special expiry from events and appears as daily. |
| `V2_REWARDS_DISTRIBUTORS` | no | JSON array of `{ "program": "<open string>", "address": "0x..." }`. Every listed instance is indexed from `V2_START_BLOCK`; keep replaced instances listed while they still carry claims. `V2_REWARDS_DISTRIBUTOR` remains the maker-only fallback and, when both are set, must match a `maker` row. |
| `V2_ACCESS_MANAGER` / `V2_PAYOUT_ROUTER` | no | Optional v8 authority and payout-route event sources, indexed from `V2_START_BLOCK`. They are refused without `V2_CLEARINGHOUSE`. |
| `V2_FEE_SPLITTER` / `V2_BUYBACK_EXECUTOR` | no | Optional v8 flywheel event sources. The executor is refused without the splitter. Both use the earlier `V2_FLYWHEEL_START_BLOCK`. |
| `V2_START_BLOCK` | with `V2_CLEARINGHOUSE` | First v2 deployment block; no genesis default. |
| `V2_FLYWHEEL_START_BLOCK` | with `V2_FEE_SPLITTER` | Splitter deployment block. The splitter is constructed before the core because it is the core fee recipient, so using `V2_START_BLOCK` would miss its earliest events. |
| `PRICING_URL` | no | Optional HTTP(S) pricing service for v2 quotes and cards. |
| `MARKET` | no | The ticker the factory market is published under. A label; default `NVDA`. |
| `START_BLOCK` | with a legacy address | Block the legacy product was deployed in (a factory market: its `deployment.deployBlock`). |
| `DATABASE_URL` | no | Postgres. Omit for a local PGlite DB under `.ponder/pglite`. |
| `DATABASE_PRIVATE_URL` | no | Railway-style private URL; Ponder prefers it over `DATABASE_URL`. Set one, not both. |
| `DATABASE_SCHEMA` | yes | Ponder refuses to start without a schema; `--schema <name>` also works. Leave unset on Railway (see "Deploy"). |
| `DATABASE_VIEWS_SCHEMA` | no | Stable Ponder view namespace. The v8 Railway service uses `callhouse_v2`; it must use a different Postgres database from a simultaneously running v7 service with the same view namespace. |
| `END_BLOCK` | no | Stop indexing here. Leave unset in production. Used to bound a replay. |
| `PGLITE_DIRECTORY` | no | Force PGlite at this path, even with `DATABASE_URL` set. For the fork sync's throwaway database; leave unset otherwise. |
| `LIVE_READ_TIMEOUT_MS` | no | Deadline on one batched live read. Default 8000. |
| `CLEARINGHOUSE` | no | The Valorem Clear the vault was constructed with (`Vault.clear()`). Default: the upstream build at `0x9a7b…C0C0`. A vault deployed on our own `DeployClear.s.sol` instance sets it. |
| `SEAPORT` / `USDG` / `ASSET` / `MULTICALL3` | no | Override the built-in mainnet addresses for a fork. |
| `PORT` | no | The HTTP port. Ponder reads it before `--port`. |

V2 cards read `lib/v2/cardRegistry.generated.json`, a small committed projection of
`ops/markets/tier1.json`. The indexer image excludes `ops/`, so regenerate it with
`pnpm --filter @callhouse/indexer gen:card-registry` whenever its card inputs change. The indexer
test gate runs `check:card-registry` and fails on drift; the Dockerfile asserts that the snapshot
is present in the production tree.

### V2 replay and read API map

`src/v2/` reduces contract logs into the `v2*` tables in `ponder.schema.ts`. The
`src/api/v2/` routes read that projection; `schema.ts` is the exact response contract
mirrored by `web/lib/v2/api-schema.ts`. Keep the schema, generated fixtures, and web
consumer in sync. The chain remains authoritative for writes and settlement: the web
checks deployment config and selected orders on chain, then simulates its transaction.

The OrderBook logs `FeeParamsScheduled` when its admin schedules a change. The indexer
stores the active and pending values in `v2OrderBookState`; activation emits no second
log. `/v2/config` evaluates the stored schedule at the **indexed checkpoint's block
timestamp**, so an API response never applies a future fee based on the host clock.
The web checks `pendingFeeParams` and `quoteTake` at the same chain block before a take,
and caps the take deadline before any pending activation. A client must refresh its
quote after approval and inspect the confirmed `Taken` event for the actual fill size.

`/v2/series/:id/book` exposes an AskWrite's individually fillable `units`, its
`onChainRemainingUnits` before collateral clipping, and `makerFreeUnits` shared by
that maker's writer asks. The web ticket walks orders in price order, reserves the
shared maker budget, and skips an order when the contract would lack collateral
for that call's planned units. `quoteTake` is still the final chain check because
operator approval, pauses and balances can change after indexing.

Account positions include open and expired orders that still custody escrow; the
clock's `expired` projection does not release assets. Only on-chain cancellation or
pruning does that. Short `premiumReceived` comes from `v2WriterSeriesPremium`, one
row per writer and series. The block-end PnL reducer updates that row only for
primary fills after `matchTakeFees` has allocated each whole-call taker fee across
all of its fills, including any resale fills in the same call. Do not reconstruct
it by summing `v2Take.takerFee` or filtering fills before fee matching: either
loses per-fill rounding or charges resale fees to a primary writer. A schema
change adding this projection needs a fresh Ponder replay before serving the new
API; an empty table would make historical premiums show as zero.

Public market, win and leaderboard routes scope filters, time windows and pagination
in SQL before loading related rows. `/v2/pnl/:id` can
describe a profitable resale before settlement; its `settlementPrice` is then `null`.
`/v2/markets/:ticker/series` uses an opaque ascending `(expiry, strike, longId)`
keyset so a series that changes status between pages cannot shift and hide the
next row. Offset-based v2 lists (series trades, cards, wins, leaderboard and
makers) accept starts through 10,000 and return HTTP 400 for a deeper cursor;
they stop issuing `nextCursor` beyond that ceiling. Legacy v1 list offsets clamp
at 10,000. For an unbounded event stream, use the keyset `/v2/feed/activity`
cursor. Public v2 response caching ignores query keys that
the route does not read, but retains its actual filters and cursors; update
`src/api/cache.ts` whenever a new query option is added. Concurrent callers
with the same normalized key share one successful response computation.
`/v2/feed/activity` is the notifier's keyset feed. Each event kind reads at most
`limit + 1` rows and loads only the series those rows reference. Settlement rows
are also filtered and paged in SQL, with a three-block safety lag. A timestamp
seek sets the settlement block floor for `since` requests. Preserve the
`(block, logIndex, id)` cursor order and bounded reads when adding event kinds.
Account history reads `realisedDeltaUsdg` from each indexed resale fill, close or long
redemption. That is the event's USDG value minus the FIFO basis consumed by that event;
the cumulative `v2PositionPnl.realisedUsdg` belongs to the position and must not be
copied to every fill in a multi-fill transaction. Short redemptions have no long
position PnL. A later token transfer can invalidate a previously ranked win, so the
PnL reducer refreshes rankings when it marks transfer-in on a closed position.
`/v2/markets` keeps indexed rows present if a live settlement-oracle spot reverts or
times out. `src/api/v2/chain.ts` drops only the failed underlying from the batched
result; `markets.ts` emits `{ spot: null, spotUpdatedAt: null }` for that ticker.
Consumers must treat the pair as unavailable, not as zero or a stale card price.
`/v2/cards` uses the same settlement-oracle spot. It keeps fillable asks in the
catalogue with `card.spot: null` if that live read fails; the hero is unavailable
until a spot returns. The pricing service's Cboe share spot is used for fair
pricing and never substitutes for the token oracle spot on a card.
The card catalogue and hero rank globally computed, executable asks. `loadCards`
prunes series with no live ask in SQL, then shares one in-flight result across all
card filters and the hero for 15 seconds per indexer process. Response cache expiry
is capped at the snapshot expiry. This controls public query amplification, but
each refresh can still read every live ask; a hard work cap would require a
materialized card candidate view or an explicit active-series policy.
The web disables new buys, bids and writing for the affected ticker while retaining
withdrawal, cancellation, close and claim paths. The route test exercises one
healthy and one failed oracle result, and both API schemas enforce the paired nulls.
For a source-level map, start with `src/api/v2/{markets,bookData,accounts,feed}.ts`,
`src/v2/{orderBook,pnl,clock}.ts` and `lib/v2/{fees,windows}.ts`.

#### Selected-20 scale regression

Run the deterministic scale gate without an RPC or external database:

```bash
pnpm --filter @callhouse/indexer scale:v2
# optional, still bounded: V2_SCALE_SAMPLES=50 pnpm --filter @callhouse/indexer scale:v2
```

`scripts/v2-scale.ts` pins the approved target set (NVDA plus the nineteen additions) rather
than taking every registry row. The generated indexer projection carries both default and
per-market `expiriesAhead` alongside the ladder overrides. The harness resolves those values and
calls the keeper's production `ladderStrikes` helper, including bps compounding, outward tick
rounding, coarse-tick deduplication and the contract strike band. It also mirrors the production
`ExpiryCalendar.nextExpiry` search over the committed holiday table, computes the production
`longIdOf`, and uses the same long-id-keyed deduplication as `stepLadders`. At the pinned Friday
head, the first daily and weekly close overlap: the generated target asks for 500 nominal ladder
slots, 50 identical tuples collapse, and 450 canonical call series remain. SGOV and the deferred
markets are deliberately absent; this is not the optional 34-market stress case and creates no
rollout commitment.

`scripts/v2-scale.test.ts` builds the relevant committed Ponder columns, defaults, constraints and
indexes in PGlite, captures the real Clearinghouse handlers, then replays 20 `MarketRegistered`
events followed by 450 `SeriesCreated` events in production planner order. Every event has
deterministic block, transaction and log metadata. Before timing, the fixture seeds the committed
holiday rows and configures the calendar address, so every series runs the deployed handler's
holiday-table SQL classification branch. Deterministic client stubs serve only the handlers' symbol
and mint-cutoff reads; the test asserts that the fallback calendar and `isWeekly` RPC reads remain
zero. The reported `handlerReplay.ms` times this ordered local handler/SQL replay. Only after that
timer stops does the fixture insert 450 live asks, collateral balances and recent fills for API
load. Those order/fill inserts are not called backfill and are not part of the replay metric.

The same run calls the real Hono routes with strict response-schema validation. It clears both
response and shared-computation caches before each timed request, discards two warm-ups, and reports
uncached p95 over 20 samples for `/v2/markets`, `/v2/cards`, `/v2/markets/NVDA/series` and one
`/v2/series/:longId` detail. The last two measurements cover the API's `/v2/series` family; there is
no bare `/v2/series` route. The card pagination check follows each returned cursor and requires the
current 200/200/50 pages to end with a null cursor.

`scripts/v2-scale.baseline.json` records the registry projection hash, base revision, fixture shape,
machine/Node provenance and the median of three measured local runs. The regression ceilings are
6,000 ms for handler replay and 32/650/550/35 ms for the four routes above. A test requires every
ceiling to provide at least 4x measured headroom while remaining below 10x the committed baseline,
so a ten-times regression cannot pass. These machine-sensitive CI guardrails are not production
SLOs and do not claim owner agreement. Handler replay still excludes RPC log fetch/decoding,
Ponder scheduling and checkpoint management, RPC transport, networked Postgres and Railway
contention. O3-105's pinned-fork soak owns that end-to-end evidence; do not use this local number to
size a release window. The harness reviewed as X3-102 candidate `a20e61d` does not measure the
cold-Ponder target below: it remains local handler/PGlite replay and API evidence. X3-102 ends at
that evidence plus the agreed target definition; O3-105 owns executing and reporting the target.

The O3-105 target starts from candidate `a20e61d` and a chain 4663 fork pinned at block `65785744`,
warped to unix time `1800000000`. Replay `V2_START_BLOCK=65780341` through the block containing the
final canonical `SeriesCreated`. The exact set is SPCX, SPY, NVDA, MU, QQQ, SNDK, AAPL, MSFT,
INTC, TSLA, META, AMD, GOOGL, AMZN, MSTR, PLTR, DELL, ORCL, TSM and CRWV; SGOV and every deferred
market are excluded. The bounded dataset contains 29 `HolidaySet`, 20 `MarketRegistered` and 450
unique `SeriesCreated` events from 500 nominal slots after 50 long-id collisions: 450 calls, zero
puts, 200 daily series and 250 weekly series.

Each of three runs starts with a fresh PostgreSQL database containing neither application state nor
`ponder_sync` state; fixture construction is untimed. Completion requires Ponder to finish
historical indexing, the first subsequent `/ready` response to return 200, the checkpoint to equal
the final event block, and exact table cardinalities of 29 holidays, 20 markets and 450 series. Use
a monotonic timer from `Started backfill indexing` to that first `/ready` 200, polled every 250 ms,
and report the median of three runs. The reference host is Apple M3 Max (16 cores, 48 GiB), Darwin
arm64, Node 24.20.0, Ponder 0.17.10, PostgreSQL 14.23 and Anvil 1.6.0 commit `f83bad9`, with one
indexer process and no other soak services. Pass at a median no greater than 60,000 ms; an
incomplete run or any cardinality mismatch fails. This is a local cold-Ponder regression target,
not a hosted or production SLO. Keep the existing 32/650/550/35 ms API p95 gates above, and do not
add the 60-second target to `scale:v2`, which cannot measure it.

The gate reproduces every index already declared on the touched tables. If a ceiling fails, first
capture the route and query plan on the target Postgres shape; add a schema index only with a
before/after measurement. A passing run is evidence that no extra index is justified at this
fixture size, not proof that larger history or production hardware will behave identically.

All source addresses and their start blocks have no defaults on purpose. Chain 4663
is past block 61,000,000; a scan from genesis is hours of `eth_getLogs` over a period when the
product did not exist. The config throws with an explanatory message rather than quietly indexing
nothing, and it throws when no source group is set. A route for a legacy product a deployment does not
index answers `404 {"configured": false}` (`/v1/vault*` on a factory-only deployment, `/v1/market*`
on a vault-only one) rather than an empty tape.

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

For v8, use **one new `indexer-v2` service for all markets**. Give it a separate Postgres
service/database from the v7 indexer that remains alive for the run-off: both use the fixed
`DATABASE_VIEWS_SCHEMA=callhouse_v2`, so sharing a database would collide even though their
internal deployment schemas differ. Do not migrate, copy or drop the v7 rows; v8 starts from a
fresh schema and replays from its own deployment blocks. Set
`V2_CLEARINGHOUSE`, `V2_ORDER_BOOK`, `V2_SETTLEMENT_ORACLE`, `V2_AUTO_ROLLER`,
`V2_MAKER_REGISTRY`, and `V2_START_BLOCK` from the deployed v2 registry; set
`V2_EXPIRY_CALENDAR`, `V2_KEEPER_REWARDS`, `V2_ACCESS_MANAGER`, and `V2_PAYOUT_ROUTER` when
deployed. Set `V2_FEE_SPLITTER`, `V2_BUYBACK_EXECUTOR`, and `V2_FLYWHEEL_START_BLOCK` from
`v2.flywheel`. Leave the legacy source groups
(`VAULT_ADDRESS`, `FACTORY_ADDRESS`, `START_BLOCK`) unset on this service. Leave
`DATABASE_SCHEMA` unset on Railway: `indexer/Dockerfile` uses the deployment id as the schema,
and `indexer/railway.json` holds traffic until `/ready` returns 200 after backfill. Use an archive
`PONDER_RPC_URL_4663` that serves historical logs and contract reads; the public RPC is suitable
for a short devnet fork, not a production backfill. Do not set `END_BLOCK` in production.

### V2 devnet sync gate

Start a **fresh** local devnet, then run the harness from the same callhouse checkout:

```bash
CONTRACTS_DIR=/path/to/callhouse-contracts-on-v2 ops/devnet/up.sh
MARKETS_REGISTRY=$PWD/ops/devnet/tier1.devnet.json pnpm --filter @callhouse/indexer gen:v2-registry
pnpm --filter @callhouse/indexer v2:devnet-check
git restore -- indexer/lib/v2/marketRegistry.generated.ts
ops/devnet/down.sh
```

`up.sh` leaves anvil running in its own session, so the harness may run from another shell. Generate
the indexer registry from the devnet registry before starting Ponder: the committed registry is for
production and has no local deployment addresses. Restore that tracked generated file after the
harness, including after a failed run, and do not commit the rehearsal snapshot. The harness reads
the generated `ops/devnet/addresses.json` and `ops/devnet/env/indexer.env`, refuses a non-loopback
or non-anvil RPC, starts its own bounded Ponder process on port 42170 with a new temporary PGlite
database, and stops that
process on exit. It waits for `/ready` and the v2 indexed block, then compares the API with viem
chain logs and views: all series terms, an active book and its totals, wallet balances, settlement
amounts, and redeemed winners. `V2_DEVNET_API_PORT` and `V2_DEVNET_SYNC_TIMEOUT_MS` override its
port and fifteen-minute timeout. The devnet's generated registry and env files are rehearsal inputs;
never commit or deploy them.

### Deployed-dev read-only manifest check

After the dev deployment and historical replay finish, use the exact saved registry from that
deployment and its explicit dev indexer URL. This command makes four HTTP GET requests and has
no RPC, signing, database, deploy, time-warp or service-control capability:

```bash
pnpm --filter @callhouse/indexer v2:dev-readonly-check \
  --base-url https://YOUR-DEV-INDEXER-HOST \
  --registry /absolute/path/to/pinned-dev-registry.json \
  --registry-sha256 SHA256_OF_THAT_REGISTRY \
  --interface-version 7 --chain-id 4663
```

`--base-url` and `--registry` are required; neither falls back to an environment variable or
production registry. `--registry-sha256` is an optional content pin; obtain it from the deployment
handoff and pass it to reject the wrong file before making requests. The JSON result always
records the registry content hash. Interface version defaults to 7 and chain ID to 4663, so a
registry and API that agree on an older version or another chain still fail.

The checker requires a positive deployment block, all 13 nonzero contract/source addresses
(including a deployed but unused DataStreamsSource), and at least one intended live market.
It checks `/ready`, health and indexed block/lag, config chain/version/block/USDG, every contract
address, all seven effective fee fields including writer rent, and the registry's live/paused market set,
underlyings, puts policy, strike ticks and effective per-market rent. Missing, zero or over-ceiling
rent on a live or paused market fails before any HTTP request. Planned registry markets need not have indexed rows;
an unexpected live market fails. An authorized fee change requires a corresponding registry pin.

Each request has a 10-second deadline including its body (`--timeout-ms`, maximum 30 seconds)
and a 1 MiB body limit. Healthy lag must be at most 120 seconds (`--max-lag-seconds`). The command
does not retry, follow redirects, print the endpoint URL or echo upstream error bodies. HTTPS is
required; local HTTP fixtures require `--allow-loopback`. URLs with credentials, query strings
or fragments are refused. This option permits fixture GETs only; it never enables chain writes.

Exit 0 and `manifest_passed` cover **only this manifest check**. The output explicitly leaves
writer-rent behavior and series/event/on-chain parity pending for the separate acceptance suite.
This does not replace X2-06/W2-14, the local Anvil harness,
full v7 functional tests or deploy authorization. Until dev addresses and the final registry are
handed off, validate this checker using its local HTTP fixture tests; do not substitute live
production inputs.

### Deployment schema and readiness

- **The schema changes on every deploy.** The image runs
  `ponder start --schema ${DATABASE_SCHEMA:-$RAILWAY_DEPLOYMENT_ID}`. Leave `DATABASE_SCHEMA`
  **unset** on Railway. A schema remembers the build that created it — reusing one with different
  code or config fails with `Schema "…" was previously used by a different Ponder app` — and it is
  locked by a heartbeat while the old deployment is still serving, which Railway keeps doing until
  the new one is healthy. The first was reproduced against a local Postgres; the second is
  Ponder 0.17's `tryAcquireLockAndMigrate` (`Failed to acquire lock on schema`).
- **The v8 deployment is not a v7 migration.** Keep the v7 run-off indexer and its database
  untouched. Start v8 against a separate Postgres database with a fresh deployment-id schema;
  this also isolates the fixed `DATABASE_VIEWS_SCHEMA=callhouse_v2` view namespace used by both.
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
| `Factory` | `FACTORY_ADDRESS` | — | Factory market only. Accounts created and rekeyed, the week (`WeekSet`), the halt, policy / fee recipient / cap, roles. |
| `WriterAccount` | `factory(AccountCreated.account)` | — | Factory market only. Every clone's events; Ponder resolves the address set from the factory's `AccountCreated`. |

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

### The factory market's tables

Populated only with `FACTORY_ADDRESS`; see "Factory markets" for the model. `market` (one row, the
factory: settings, the current week, totals), `writer_account` (one row per clone, keyed by its
address: owner, status, the pinned listing, lifetime totals), `market_week` (one row per `WeekSet`,
`${factory}-${weekId}`, with what the accounts did under it), `lot_fill` (one row per `LotFilled`,
`${tx}-${logIndex}`), `account_settlement` (one row per `Settled`, same key, with the outcome) and
`market_role` (the factory's AccessControl grants, never deleted). The vault tables above are not
touched by any of them.

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
| GET | `/v1/market` | Factory market: the market row, the current week with totals, accounts by status, pending lots, roles. Index only, no live read. |
| GET | `/v1/market/weeks` | Every week the keeper set, newest first, each with its listings, fills and settlements. `?limit=`, `?offset=`. |
| GET | `/v1/market/fills` | Every lot filled, newest first. `?account=` (the clone) or `?owner=`. |
| GET | `/v1/market/accounts/:address` | One account by clone address OR owner address, with its fills and settlements. |
| GET | `/v1/health` | Indexer head vs chain head, lag in blocks and seconds, the vault's phase / strand state and the factory's week / halt / counts. Each product's block is null when it is not configured. |
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
  "market":  "NVDA",
  "vault":   { "phase": 1, "phaseName": "Listed", "cycle": 1, "writesHalted": false, "stranded": false },
  "factory": null                        // or { "address", "ticker", "week", "writesHalted", "accounts", "pendingLots", "settingsVerified", … }
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

## Factory markets

**The audit finding this section answers (2026-09-15).** The indexer was pooled-vault-shaped —
"one vault" in every source, table and route — and had ZERO coverage of the factory product
(`contracts/src/solo/`: one `AccountFactory` per market, one `WriterAccount` clone per user), which
is the product every Tier 1 market runs on, NVDA included (factory `0xc4A5Cd0D…2BBb`, live since
block 64,038,234). The web app's `/account` and `/book` pages read the factory and every clone
over RPC in the browser (`accountCount`, `liveAt`, each clone's views), so a factory market had
**no public tape at all**: no history of weeks, fills or settlements, nothing a dashboard or an
alert could read without an archive node. The `FACTORY_ADDRESS` mode below is that tape.

### One deployment per market

The Tier 1 plan runs one keeper and one indexer process per market, env-driven, and this package
follows it: there is no multi-market indexer and no list of factories in the config. A market's
deployment is:

```
FACTORY_ADDRESS = ops/markets/tier1.json → markets[ticker].deployment.factory
MARKET          = the ticker (a label on the payloads; nothing is derived from it)
START_BLOCK     = markets[ticker].deployment.deployBlock
VAULT_ADDRESS   unset
```

and everything else is the same as the vault's: one Postgres, a schema per deployment
(`DATABASE_SCHEMA` unset on Railway, `RAILWAY_DEPLOYMENT_ID` otherwise, "Deploy (Railway)" above),
`/ready` as the healthcheck. Both addresses may be set on one deployment (the NVDA vault could
carry its factory's tape beside its own); the sources and the handlers are registered per product
(`ponder.config.ts`, `lib/registry.ts`), and the vault's are byte-for-byte what they were.

`ASSET` and `CLEARINGHOUSE` are vault-only and stay unset on a market deployment: the `addresses`
group every `/v1/market*` payload carries publishes the market's OWN asset and Clear, read from
the factory at `Factory:setup` — null until that read answers, never the NVDA token or the
vault's Clear, which the env defaults would otherwise advertise on every market. `/v1/market`'s
`market.contracts` is the same two values with a `verified` flag beside them.

Two older documents describe this service differently and are superseded on those points by this
section: `ops/deploy.md` §14.3 (the per-market indexer follows neither Seaport nor the Clear —
the clones' own events carry the fills and the verdicts — and needs no archive endpoint beyond
the optional setup read) and `docs/TECHSPEC-TIER1-MULTIMARKET.md` §5.3 (`/v1/market/fills` carries
the whole premium only, not the fee split, and no route carries per-account balances; balances
stay a live RPC read — "Log-only, and what that costs" below).

### Log-only, and what that costs

No factory handler makes an `eth_call`. The public RPC for chain 4663 has no historical state
(`eth_call` at a past block answers `historical state … is not available`), per-market archive
endpoints are not provisioned, and a backfill that reads the chain per event would stall on the
endpoint the market actually runs against. So a factory market backfills on the public RPC from
logs alone — 131k blocks of the NVDA factory's history in about a minute on 2026-09-15 — and the
schema is shaped by what logs can say:

- **The factory is the clock.** `WeekSet(id, strikeUsdg, exerciseTs, baseExpiryTs, askUsdg)`
  creates a `market_week` row; the factory numbers its own weeks. Accounts that `list` afterwards
  pin those terms (`LotsListed(weekId, optionId, lots, askUsdg)`); an account's expiry is
  `baseExpiryTs + index`, one second per account, so no two share a Valorem bucket.
- **`LotFilled` is the fill.** One order, one contract, `premiumUsdg` = the whole ask (Seaport pays
  the seller's part to the owner and the fee item to the fee recipient directly). Seaport is NOT a
  source for the clones: a `filter` needs fixed addresses and the set of clones is dynamic, and
  the event already carries the order hash for anyone who wants the consideration items.
- **`Settled(nvdaReturned, strikeUsdg)` is the verdict**, read against the listing's fills
  (`lib/factoryLifecycle.ts settlementOutcome`): `unfilled` (no fills, no claim — the most likely
  outcome, and a row), `assigned` (strike USDG in), `expired` (collateral back, no USDG), and
  `unredeemed` — fills and NOTHING back, which means `tryRedeemClaim` failed and the account keeps
  its claim (`list` reverts `StillOpen` until it is resolved). The last one is logged as a warning.
- **Account status** (`writer_account.status`): `idle` → `pending` (`WriteRequested(n)`) → `listed`
  (`LotsListed`) → `settled` (`Settled`); `WriteRequested(0)` is back to `idle`. `market.pendingLots`
  is the requests of the accounts currently pending — the keeper's queue.
- **Balances are not here.** A clone's token transfers cannot be filtered, so an account row has
  `depositedTotal` / `withdrawnTotal` (a lower bound on what it holds: assignment moves assets out
  without a `Withdrawn`) and the web keeps reading `idleAssets()` live for the real figure.

### The one optional read: `Factory:setup`

The constructor sets `policy`, `feeRecipient` and `depositCap` without an event, and `PolicySet`
carries no values, so those come from views or not at all. `Factory:setup` reads them ONCE, before
any event, pinned to `START_BLOCK` — which needs an archive RPC. On the public RPC the batch fails
(retried by Ponder for ~2 minutes, so the handler gives it a 30 s deadline and moves on), the
columns stay null, `market.settingsVerified` is false, and `/v1/market.settings` publishes null
with `verified: false` — never a zero. `FeeRecipientSet` / `DepositCapSet` still update their
columns as they arrive; a `PolicySet` stamps `policySetAt` so a reader knows the six policy fields
may be stale from then. The four immutables (`asset`, `priceFeed`, `clear`, `implementation`) are
read with Ponder's `cache: "immutable"` at the head instead, which is exact for an immutable and
works on the public RPC, so `/v1/market.contracts` is verified even where the settings are not.
**This read is the only reason a factory deployment would want an archive RPC.** A read that
times out is not retried within a deployment — `Factory:setup` runs once per schema — so the
settings of a deployment whose read timed out stay `verified: false` until a governance event or
a redeploy (a new Railway deployment is a new schema, and the read re-runs); the boot log's
"factory settings unreadable" warn says the same.

### What `/v1/market` answered on the live NVDA factory

Smoke on 2026-09-15 (`FACTORY_ADDRESS=0xc4A5…2BBb`, `START_BLOCK=64038234`, `END_BLOCK` =
head − 2,000 — see "Deploy (Railway)": a bound at the head can exit 75 on a lagging public-RPC
node, so `/v1/health` read `lagging` by construction — public RPC, PGlite, no `VAULT_ADDRESS`):
`/ready` 200 after the backfill, one account created, week 1 set at strike 223.000000 USDG /
ask 1.000000 USDG, matching the chain; the vault routes 404 `{"configured": false}`.
`addresses.asset` / `addresses.clearinghouse` on the market payloads were the factory's own
(`market.contracts`), not the vault's env defaults. The web's `/account` and `/book` still read
the factory over RPC; moving them onto
`/v1/market` is the web lane's call, and when it happens the `marketJson` shape gets a fixture
under `ops/fixtures/api/` the way `cycleJson` has (`src/api/index.test.ts` says so).

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

`abis/accountFactory.ts` and `abis/writerAccount.ts` are generated from `ops/abis/AccountFactory.json`
and `ops/abis/WriterAccount.json` (extracted from `callhouse-contracts/out` at main `5eb84d1`), no
library errors to merge: neither contract links a public library.

Re-run `pnpm gen:abis` after any change under `ops/abis/`, then `pnpm typecheck`.

---

## Layout

```
ponder.config.ts      chain 4663; the vault's eight sources and the factory market's two, each group registered only with its address
ponder.schema.ts      the vault's nine tables and four enums, the factory market's six tables and one enum
ponder-env.d.ts       generated by `ponder codegen`; commit it
abis/                 generated (+ hand-written seaport.ts)
lib/env.ts            every address and knob, resolved once
lib/indexing.ts       shared reducers: state, snapshots, users, cycles, epochs, strands
lib/lifecycle.ts      the pure decisions: harvest origin, close status, strand maths, capacity
lib/harvest.ts        one Harvest split into premium and strike proceeds (W-21)
lib/roles.ts          the three AccessControl role hashes and what each one can do
lib/deployment.ts     constructor-set vault settings, seeded by Vault:setup
lib/registry.ts       the registry per product: the real `ponder` when its address is set, a no-op otherwise
lib/factoryLifecycle.ts  the factory market's pure decisions: account status, pending lots, settlement outcome, week totals
lib/factoryIndexing.ts   shared reducers for the market, account and week rows
src/vault.ts          every vault, adapter and Distributor event
src/valorem.ts        Valorem, narrowed to our writer / claim / option
src/seaport.ts        OrderFulfilled → contractsSold and the realised price, per fill
src/token.ts          balances in and out, plus the issuer's switches
src/factory.ts        the AccountFactory: setup read, accounts, the week, switches, roles
src/writerAccount.ts  every clone's events: request, listing, fills, settlement, claims, ownership
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

## Interface version 7: rent, stale asks, and replay

The v7 consumers decode the complete six-field MarketConfig and thirteen-field Series tuple.
Regenerate ABIs from the verified canonical `ops/abis/v2` export and generate the API registry
from the matching version-7 deployment registry. The registry generator rejects older interfaces.
Use a **fresh Ponder database/schema replay from the deployment block**; the v6 event topics and
persisted rows cannot supply the new rent accounting. The replay also populates the per-writer
premium projection introduced before v7.

- Market `mintFeePpm` changes apply to future series. Each series exposes its pinned rate,
  `mintFeesHeld` and cumulative `mintFeesAccrued`. The two monetary fields are in **native collateral**:
  18-decimal Stock Tokens for calls, 6-decimal USDG for puts.
- `Minted.fee` debits free collateral along with principal. `Closed.feeRefund` credits the closer
  along with freed collateral. `MintFeesAccrued` follows `SeriesSettled`, clears held rent and records
  protocol revenue in `v2MintFeeAccrual` with the emitted asset. Held rent is not sweepable revenue.
- Account mint/close history carries `fee`/`feeRefund` in the same native units. The existing USDG
  premium, PnL, leaderboard and aggregate trading-fee amounts **exclude collateral rent/refunds**;
  no Stock Token rent is silently valued or subtracted from USDG. Do not label these figures net
  of writer rent. To value rent, a future consumer must explicitly supply price source and time.
- Book `updatedBlock` and `snapshotTimestamp` identify the indexed balance checkpoint. Each
  write ask includes native `makerFreeCollateral`, original `onChainRemainingUnits` and its
  individually fillable `units`/`makerFreeUnits`. Expired orders are removed using the later of
  display and checkpoint time, while rent uses checkpoint time. On-chain quote/simulation remains the transaction
  authority. Writers share their remaining collateral across one ticket; rent rounds up **once
  per fill**, and an unfunded proposed fill is skipped whole as in OrderBook._plan.
- Book and card reads compare the complete Ponder checkpoint before and after their database
  queries. Normal indexing commits cause a retry; three unstable attempts return uncached 503
  `snapshot_changing`. Ponder 0.17 publishes projections and checkpoints atomically for normal
  blocks, but its reorg rollback temporarily leaves the old checkpoint until replacement blocks
  are processed. These API snapshots therefore are not finality proofs; transaction preflight is
  still required during a reorg. Missing checkpoints report unhealthy and use conservative time zero.
- Card depth searches for the largest fully executable ticket rather than summing independent
  per-order budgets. One-share and one-unit prices mirror the whole-or-skip plan independently.
- `StaleAskCancelled` clears strategy `orderId`, preserves active/current series/expiry and records
  `lastStaleCancelAt` plus `staleSpot`. A new roll clears the stale marker. `/v2/feed/activity` supports
  `kinds=stale_cancel`, including writer, spot, oracle observation time and `nextRollAfter` expiry;
  its event ID is the deduplication key. A withdrawn ask is not a stopped strategy.
- `/v2/vault` exposes MakerVault transparency from bounded live reads at one block: wallet and
  Clearinghouse free balances, all six configured limits, daily outflow, active order count and
  decimal tracked-series IDs. The route fails with `503 vault_unavailable` when any required live
  read fails; an absent `V2_MAKER_VAULT` is an explicit `404 not_configured`, never a zero-filled
  success. Existing deposit, limit, treasury-exit and exposure projections remain the historical
  source for indexed activity; the route does not duplicate them.

Regression gates cover real handlers against an in-memory Postgres schema (call/put mint, close,
settlement/accrual and stale withdrawal), native-money API responses, pinned capacity snapshots,
per-fill rounding, shared budgets and selector/topic drift. X2-06 is extended for native rent
conservation and capacity against a fresh local replay; the current seed exercises call accrual.
W2-14 adds call/put mint and close ledger/history parity, stale cancellation and API-outage fallback.
Put settlement/accrual is covered by the real-handler Postgres test until the local seed adds it.
Harness implementation/typecheck is not evidence of a completed fork run. The deployed-dev checker
is separately read-only and validates the deployment manifest, not transaction behavior.

## Posting a maker reward epoch

`pnpm maker:epoch <epoch-id> <budget-usdg-base-units>` reads the completed epoch from `/v2/makers` and writes `ops/maker-epochs/<epoch-id>.json` with allocations, the OpenZeppelin Merkle root and each proof. The budget is an explicit treasury decision. The score snapshot must be final before generating the file.

`RH_RPC=<chain-4663 RPC> pnpm maker:post <epoch-file>` checks the file's complete allocation, root and proofs; confirms the epoch has ended, the chain and registry addresses match, no root has already been posted, and the RewardsDistributor holds at least the new epoch's total. It sends nothing by default. Existing unpaid epochs may need more funding than this one balance check proves.

After review and funding, import the admin key into Foundry's local keystore and run `RH_RPC=<chain-4663 RPC> INDEXER_URL=<final indexer API> pnpm maker:post <epoch-file> --apply --account admin`. Before sending, it recomputes the allocation from the completed indexer score snapshot and refuses a different root. The script passes no key or RPC URL in command arguments to `cast`, then reads the posted root back. A root is immutable for its epoch; inspect the file and budget before `--apply`.
