# @callhouse/indexer

Ponder indexer and read API for the Callhouse covered-call vault on **Robinhood Chain mainnet
(chain id 4663)**.

It watches one vault, the Overcall registry that sets its weekly cycle, the Valorem
clearinghouse it writes into, the Seaport order book it lists on, and the two tokens that move
in and out of it. It turns that into a small Postgres schema and a JSON API that the web app
and the keeper read.

The product rule this package exists to keep: **a week with no buyer is a row of zeros, not a
missing row.** Every route below is built so an unfilled week is a first-class, publishable
outcome.

---

## Quick start

```bash
cp .env.example .env.local          # fill in VAULT_ADDRESS and START_BLOCK
pnpm --filter @callhouse/indexer dev
```

`ponder dev` hot-reloads on every file in the package and serves the API on `:42069`.
`ponder start` is the production command; it exits non-zero on a build error instead of
retrying.

Typecheck (what CI runs):

```bash
pnpm --filter @callhouse/indexer typecheck
```

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `PONDER_RPC_URL_4663` | yes | Archive-capable RPC. Use `https://rpc.mainnet.chain.robinhood.com`. |
| `VAULT_ADDRESS` (alias `VAULT`) | yes | The deployed Callhouse vault. |
| `START_BLOCK` | yes | Block the vault was deployed in. |
| `DATABASE_URL` | no | Postgres. Omit for a local PGlite DB under `.ponder/pglite`. |
| `DATABASE_SCHEMA` | yes | Ponder refuses to start without a schema; `--schema <name>` also works. |
| `REGISTRY_START_BLOCK` | no | Scan the registry from earlier than the vault, to pick up pre-launch cycles. Defaults to `START_BLOCK`. |
| `END_BLOCK` | no | Stop indexing here. Leave unset in production. Used to bound a replay. |
| `KEEPER_HMAC_SECRET` | no | Shared secret for `POST /v1/overcall/list`. Unset ⇒ that route answers 503. |
| `OVERCALL_ORDERS_URL` | no | Defaults to `https://overcall.finance/api/orders`. |
| `OVERCALL_MARKET` | no | Defaults to `NVDA`. Sent as `?market=`. |
| `LIVE_READ_TIMEOUT_MS` | no | Deadline on one batched live read. Default 8000. |
| `REGISTRY` / `CLEARINGHOUSE` / `SEAPORT` / `USDG` / `ASSET` / `MULTICALL3` / `OVERCALL_FEE_RECIPIENT` | no | Override the built-in mainnet addresses for a fork. |

`VAULT_ADDRESS` and `START_BLOCK` have no defaults on purpose. Chain 4663 is past block
61,000,000; a scan from genesis is hours of `eth_getLogs` over a period when the vault did not
exist. The config throws with an explanatory message rather than quietly indexing nothing.

### `DATABASE_URL`

Ponder uses Postgres when `DATABASE_URL` (or `DATABASE_PRIVATE_URL`) is set, and PGlite —
an embedded Postgres under `.ponder/pglite` — when it is not. PGlite is fine for local work and
for the smoke test; production should be Postgres so `ponder serve` can run the API on separate
instances from the indexer.

Ponder also requires a **database schema** (a Postgres namespace) so that two deployments can
share one database without colliding: `DATABASE_SCHEMA=callhouse` or `--schema callhouse`.
A fresh deploy to a new schema backfills from scratch; redeploying to the same schema resumes.

---

## Backfilling

```bash
# full backfill from the vault's deploy block, following the head afterwards
DATABASE_SCHEMA=callhouse pnpm --filter @callhouse/indexer start

# pick up Overcall cycles that ran before we launched
REGISTRY_START_BLOCK=61000000 DATABASE_SCHEMA=callhouse pnpm --filter @callhouse/indexer start

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

## What is indexed, and why

| Source | Address | Filtered by | Why |
|---|---|---|---|
| `Vault` | `VAULT_ADDRESS` | — | Every vault event. The primary record. |
| `Registry` | `0x8E97…f4EA` | — | `CycleSet` is what makes a week exist, including weeks the vault sits out. |
| `Clear` | `0x9a7b…C0C0` | `writer` / `redeemer` = vault on two events | Writes and redemptions. Exercise and bucket events carry no address for us and are narrowed in the handler. |
| `Seaport` | `0x0000…B395` | `offerer` = vault | **The only source of truth for what we sold and what we got.** |
| `StockTokenIn` / `StockTokenOut` | NVDA token | `to` / `from` = vault | Exact asset balance without an RPC read. |
| `UsdgIn` / `UsdgOut` | USDG | `to` / `from` = vault | Exact USDG balance. |
| `StockToken` | NVDA token | — | The issuer's switches: oracle pause, transfer pause, ERC-8056 multiplier. |

Two sources per token because a log filter **ANDs** its topics: `from == vault` and
`to == vault` cannot be expressed as one filter.

### Facts baked into the handlers

- **The registry is the clock.** `cycle()` has **no status field**. The gates are
  `isWritingOpen()` (a cycle is set and `now < writeDeadline()`) and `isCycleLive()`
  (`now < expiryTimestamp`), and `writeDeadline() == exerciseTimestamp`. Nothing here keys off
  the wall clock.
- **Valorem's `Claim.amountWritten` / `amountExercised` are 1e18-scaled scalars, not contract
  counts.** Event arguments (`OptionsWritten.amount`, `OptionsExercised.amount`) are raw
  counts. Anything read from `claim()` is divided by 1e18; nothing from an event is.
- **`contractsSold` is never written on chain.** `AdapterValorem` declares it and only ever
  resets it; Seaport moves the ERC-1155 out of the vault with no callback. So both the
  contract count and the realised price come from `Seaport:OrderFulfilled`.
- **`RollClose.contractsAssignedCount` is real and is used.** The vault reads it from
  `contractsAssigned()` — Valorem's `claim().amountExercised`, divided back down by the 1e18
  scalar — *before* `_redeemClaim` zeroes the claim key. The handler keeps a derivation from
  the collateral that did *not* come back, `(collateral − underlyingReturned) / lotSize`, as
  the fallback: it agrees by construction, and it covers an earlier build of the vault that
  emitted a hardcoded `0` here.
- **`Harvest` is emitted from TWO places and they mean different things.** `_harvest()` runs
  inside `rollClose` and always emits, including the honest zero of an unfilled week — that is
  the week's verdict. `_checkpointHarvest()` runs inside `deposit` / `mint` and emits mid-week
  whenever premium has already landed, so a late depositor cannot mint into premium earned
  before they arrived. Same event, same cycle number. They are told apart by the transaction:
  `rollClose` emits `RollClose` immediately before `_harvest()`, so the terminal harvest is the
  one whose tx hash matches `vaultState.rollCloseTx` *and* whose phase is still `Settling`.
  Only the terminal one closes the week, returns the phase to Idle and moves the lifetime
  tallies; both accumulate onto the cycle's money columns, because both move real money. Rows
  carry `terminal`, and `/v1/activity` shows terminal rows only unless asked for `include=all`.
- **Fees stack, and they round per contract.** Overcall takes 5% of gross as
  `consideration[1]`; the protocol takes 5% (`protocolFeeBps` 500) of the premium that reached
  the vault, never of strike proceeds. The per-contract
  split is `feePerContract = floor(unitPrice × 500 / 10000)`, `writerPerContract = unitPrice −
  feePerContract`, then multiply by N. Rounding on the total produces an order that signs and
  validates and is then refused by Seaport on a partial fill (`InexactFraction`) — and every
  Overcall order is `PARTIAL_OPEN`, so that quietly turns the listing into full-fill-only.
- **On an assigned week `Harvest.feeUsdg / Harvest.grossUsdg` is not the fee rate.** `grossUsdg`
  on the close includes the strike proceeds, but the vault charges the fee on
  `grossUsdg − RollClose.usdgFromAssignment` only (a deposit checkpoint excludes nothing, because
  strike proceeds cannot be in the balance before `rollClose`). The handler takes all three
  amounts from the event verbatim and never recomputes the fee. `netUsdg == grossUsdg − feeUsdg`
  always.
- **The protocol fee accrues and pays on different events.** It accrues at every
  `Harvest` with premium in it (`feeUsdg`, tallied in `lifetimeProtocolFee`), but the push inside `rollClose` is
  best-effort — a blocked recipient must not freeze the close — so payment happens whenever it
  can, through `FeeSwept` (tallied in `totalFeeSwept`). The vault's live `pendingFeeUsdg` is
  `lifetimeProtocolFee − totalFeeSwept`.
- **A queue entry settles and pays out on different events.** `QueueEntrySettled` moves an
  entry out of its epoch into the owner's owed balances — pure bookkeeping, no tokens — and
  fires both inside `completeRedeem` and inside `queueRedeem` when joining auto-settles a stale
  slot. The epoch's `*Claimed` columns are drawn down THERE. `CompleteRedeem` only reports the
  payout, and it is the only place `reservedAssets` comes down. Reading payout events for epoch
  state (or vice versa) double-counts one and drifts the other.
- **USDG is 6 decimals, the Stock Token and the shares are 18.** Every API amount carries its
  own `decimals` so nothing has to be assumed.
- **`uiMultiplier()` is display only.** The vault never rebases and all share maths use raw
  balances.

---

## Tables

All amounts are base units in a `numeric` column, surfaced by the API as decimal strings.

### `vault_state` — one row, the running reduction of every event

Phase, cycle, balances, lifetime totals, governance settings, the issuer's switches. This is
what `GET /v1/vault` reads before layering the live reads on top.

Two column names are deliberate:

- `lockedCollateral` is what was written into Valorem, held until the claim is redeemed. It is
  *not* `Vault.lockedAssets()`, which reads Valorem's live position and therefore falls as
  buyers are assigned mid-week. The API reports the live figure under `tvl.lockedAssets` and
  the indexed one as the fallback.
- `contractsSold` comes from Seaport, not from the vault (see above).
- `lifetimeProtocolFee` and `totalFeeSwept` are accrual and payment of the protocol fee. They
  differ on purpose — the push is best-effort — and their difference is the vault's live
  `pendingFeeUsdg`.

### `cycle` — the public record, one row per registry cycle

Keyed by the registry's cycle number. A row appears as soon as `CycleSet` fires, whether or not
the vault ever writes into it.

`status` is the whole story of the week:

| status | meaning |
|---|---|
| `idle` | The registry opened the week; the vault never wrote. No rung inside the OTM band, writes halted, or nothing idle to write against. Terminal for a skipped week. |
| `listed` | The vault wrote calls; the inventory is or was on the book. |
| `filled` | A buyer filled. Set on the first matching `OrderFulfilled`. |
| `unfilled` | The week closed with zero contracts sold. **The most likely outcome.** Every money column is 0. Terminal. |
| `closed` | Filled, expired out of the money. Premium kept, tokens kept. Terminal. |
| `assigned` | Contracts were taken at the strike: tokens out, USDG in. Terminal. |

`idle` and `unfilled` are different facts and the distinction matters: *we did not write* versus
*we wrote and nobody bought*.

The three money columns the site quotes:

| column | meaning |
|---|---|
| `premiumGross` | What buyers paid for our calls, **including** Overcall's 5%. |
| `fee` | The protocol fee: `protocolFeeBps` (launch 500, 5%) of the premium only, taken at harvest, on filled weeks only. Strike proceeds are never fee'd. |
| `premiumNet` | What depositors actually received, after Overcall's 5% **and** the protocol fee: `harvestGross − fee`. On an assigned week it **includes** `assignmentUsdg`, not only premium. |

`premiumToVault`, `overcallFee`, `assignmentUsdg` and `harvestGross` sit alongside so nothing
about the two stacked fees has to be inferred. `marketExercised`, `bucketIndex` and
`bucketAssigned` are intra-week *signals* about Valorem's bucket lottery, not claims about our
assignment — that is only known at redeem.

### `listing` — one row per Seaport order the vault authorised

Keyed by order hash. Carries the ask (`grossUsdg`, `unitPriceUsdg`, and the recomputed
per-contract 95/5 split), the realised fills (`contractsFilled`, `proceedsUsdg`, `feePaidUsdg`),
and how the order ended (`endReason`: `filled`, `cancelled`, `invalidated`). The contract caps
a cycle at three listings, so `seq` is 1–3.

### `user` — per-depositor position

`shares` mirrors `balanceOf` and therefore **excludes** anything escrowed in the redeem queue —
the vault holds those shares itself. `queuedShares` mirrors `Vault.queuedSharesOf`.

Claimable USDG is **not** in this table: it depends on a per-account snapshot inside the
Distributor that no event exposes. `GET /v1/account/:addr` reads `claimableUsdg(address)` live.

### `harvest` — one row per `Harvest` event, including the zero ones

The terminal harvest fires on every `rollClose` unconditionally, so an unfilled week always
produces a row with `terminal: true`, `filled: false` and `grossUsdg: 0`. `usdgPerShare` is
`netUsdg × 1e18 / supply`, where `supply` is the pre-burn, pre-mint share count: `_settleQueue`
runs *after* `_harvest`, so shares escrowed for the queue earn the week they sat through, and
`_checkpointHarvest()` runs *before* `_mint`, which is the whole point of it existing.

Mid-week checkpoint harvests land here too, with `terminal: false`. They are real money —
premium swept into the USDG index ahead of a deposit — but they are not weekly results, so the
weekly tape at `/v1/activity` filters them out by default.

### `queue_epoch` — one row per redemption epoch

The vault opens at epoch 1 and increments on every settlement. Queuing escrows shares;
settlement burns them and sets aside pro-rata idle assets plus the USDG the escrow accrued.
Entries are then drawn down on `QueueEntrySettled` — which fires at collection AND when a
later `queueRedeem` auto-settles a stale slot — and the last one takes the remainder, so
`*Claimed` converges on `*Settled` rather than being recomputed per user. `CompleteRedeem`
moves the tokens later (or in the same transaction) and only touches the reserves.

### `role_member` — who can touch the vault

One row per (role, account). Rows are never deleted: a revoked grant keeps `granted: false`
with a `revokedAt`, so the history survives. `roleName` resolves the hash to
`DEFAULT_ADMIN_ROLE`, `KEEPER_ROLE` or `GUARDIAN_ROLE`.

Two vault events are **not** indexed, deliberately. `RoleAdminChanged` can never fire — the
vault never calls `_setRoleAdmin`, so every role's admin is `DEFAULT_ADMIN_ROLE` for the life
of the contract. `Approval` is an ERC-20 allowance on the shares; it carries no product meaning
and would bury the trail in noise.

### `vault_snapshot` — append-only state trail

One row per state-changing event, keyed `${blockNumber}-${logIndex}`, with a `reason` naming the
event. `idleAssets` = `assetBalance − reservedAssets` and matches `Vault.idleAssets()`.

---

## API

Public `GET` routes are cached 15 seconds, in-process and via `Cache-Control: public,
max-age=15`. Responses carry `x-cache: HIT|MISS`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/vault` | TVL, phase, this week's strike / listing / fill, the live rung ladder, lifetime totals. |
| GET | `/v1/cycles` | Full history, newest first. `?status=`, `?limit=`, `?offset=`. Includes unfilled-0 weeks. |
| GET | `/v1/cycles/:cycle` | One week, with its listings and harvests. |
| GET | `/v1/activity` | The weekly tape: terminal harvests, including the zero rows. `?include=all` adds mid-week checkpoint harvests. |
| GET | `/v1/account/:addr` | Shares, claimable USDG, queued position. |
| GET | `/v1/listings` | Current and past listings. `?cycle=`, `?status=`. |
| GET | `/v1/listings/:hash` | One order by hash. |
| GET | `/v1/snapshots` | The raw state trail. |
| GET | `/v1/health` | Indexer head vs chain head, lag in blocks and seconds. |
| POST | `/v1/overcall/list` | Keeper-only, HMAC. Forwards to Overcall's API. |
| POST | `/graphql` | Auto-generated from `ponder.schema.ts`. The escape hatch. |

### The cycle shape is a tested contract

What `/v1/cycles` emits for one week — `cycleJson` in `src/api/index.ts` — is pinned by the
four files under `../ops/fixtures/api/`: a filled, an unfilled, an assigned and a skipped week,
with real numbers (48 USDG gross, 5% per contract to Overcall, 5% of the 45.6 premium to the
protocol, 5 × 190 of strike proceeds on the assigned one, fee-free; the skipped one is what
`Registry:CycleSet` leaves when no `Vault:RollOpen` follows — `idle`, `wrote: false`, and no
`closedAt` ever). `src/api/index.test.ts` builds those rows as typed
schema literals, runs `cycleJson`, and deep-equals the result against the files; the dapp's
`web/lib/api.test.ts` reads the same files and asserts what it renders from them. Change the
shape and the indexer test fails; regenerate the fixtures
(`CALLHOUSE_WRITE_FIXTURES=1 pnpm --filter @callhouse/indexer test`) and the web test tells
you whether the dapp can still read it. The test loads the Hono app under `vitest`, which
means the `ponder:*` virtual modules and the `graphql()` middleware are stubbed just enough for
the module to import — nothing that is stubbed is asserted on, and `cycleJson` itself touches
neither the database nor the chain.

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
  "vault":   { "phase": 1, "phaseName": "Listed", "cycle": 1, "writesHalted": false }
}
```

`status` is `ok` under 120 seconds of lag, `lagging` beyond it, `degraded` if the index head or
the RPC cannot be read at all (503). Point uptime checks at `/health`, point the dashboard and
the keeper's alerting at `/v1/health`.

### Live reads and graceful degradation

Almost everything is served from the index. A handful of facts cannot be: Valorem's mid-week
position, `claimableUsdg`, `spotUsdg()`, `uiMultiplier()`, and the registry's live ladder.

Those are read through **Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`,
`eth_getCode`-confirmed on 4663, `MULTICALL3` to override on a fork), with
`allowFailure: true`. This is not an optimisation detail — `GET /v1/vault` needs about
thirty-five views, and Ponder's API client funnels every request through the same rate-limited
RPC queue the indexer uses, so fired one at a time they serialise behind each other and blow
any deadline worth having. Measured on `rpc.mainnet.chain.robinhood.com`, that emptied the
entire live half of the payload to nulls while the node itself was healthy. Batched, `/v1/vault`
answers in under a second.

Each batch carries a deadline (`LIVE_READ_TIMEOUT_MS`, default 8s). A view that reverts, a
batch that times out, or a chain with no Multicall3 all degrade to `null`, and the response
still goes out with `live: false` and the indexed figures in place — `spotUsdg` reverting is
itself a signal, because the vault refuses to write on a stale price.

### `POST /v1/overcall/list`

The keeper's relay into Overcall's order book. Overcall has no auth and no maker allowlist, so
the restriction here is ours: the body must offer from **our** vault. This is not an open proxy.

Authentication is HMAC-SHA256 over `${timestamp}.${rawBody}`, compared in constant time:

```
x-callhouse-timestamp: <unix seconds>
x-callhouse-signature: hex( HMAC-SHA256(KEEPER_HMAC_SECRET, `${timestamp}.${rawBody}`) )
```

The timestamp is inside the MAC, not merely beside it, so a captured request cannot be replayed
with a fresh clock. Requests more than 300 seconds out are rejected. `signKeeperRequest()` in
`src/api/hmac.ts` produces both headers.

The body is forwarded verbatim to `${OVERCALL_ORDERS_URL}?market=${OVERCALL_MARKET}` with
`content-type: application/json` as the **only** header, which is exactly what Overcall's own
client sends. The shape is `{chainId, components, signature}` — there is no `order`, no
`optionId` and no `maker` field; Overcall derives those server-side. `signature` must be 64 or
65 bytes: the vault answers EIP-1271 for the authorised hash and ignores the bytes, but
Overcall's schema rejects any other length, so the keeper sends a well-formed 65-byte
placeholder.

Responses:

| status | meaning |
|---|---|
| 200 | Forwarded. `upstreamStatus` is Overcall's own (201 on insert, 200 on an idempotent repeat of the same order hash). `listing.orderHash` is the handle. |
| 400 | Malformed body, wrong offerer, or a signature that is not 64/65 bytes. |
| 401 / 403 | Bad or missing MAC / timestamp outside the window. |
| 502 | Overcall rejected it. `error` carries their message verbatim — their 409 and 422 text is what tells the keeper whether to re-read the counter, retry, or give up. |
| 503 | `KEEPER_HMAC_SECRET` is not configured; the relay is disabled. |
| 504 | Overcall unreachable within 15s. |

---

## ABIs

`abis/*.ts` are **generated** from `ops/abis/*.json` by `pnpm gen:abis`. They are `as const`
TypeScript rather than JSON imports because abitype infers every handler's `event.args` from an
ABI literal, and a JSON import widens `type` to `string` and collapses all of it to `any`. The
generator also strips the `_comment` / `_selector` / `_verified` annotations that
`ops/abis/StockToken.json` carries for human readers.

`abis/seaport.ts` is hand-written: `ops/abis/` has no Seaport artefact and only three events
and two views are ever used. Every signature in it was confirmed against the deployed bytecode
(`OrderFulfilled` topic0 `0x9d9af8e3…6f31`; see `ops/recon/R2-R9-seaport-order-shape.md`).

Re-run `pnpm gen:abis` after any change under `ops/abis/`, then `pnpm typecheck`.

---

## Layout

```
ponder.config.ts      chain 4663, the eight sources and their topic filters
ponder.schema.ts      eight tables and three enums
ponder-env.d.ts       generated by `ponder codegen`; commit it
abis/                 generated (+ hand-written seaport.ts)
lib/env.ts            every address and knob, resolved once
lib/indexing.ts       shared reducers: state, snapshots, users, cycles, epochs
lib/roles.ts          the three AccessControl role hashes and what each one can do
src/vault.ts          every vault event
src/valorem.ts        Valorem, narrowed to our writer / claim / option
src/seaport.ts        OrderFulfilled → contractsSold and the real fill price
src/registry.ts       CycleSet → the week exists
src/token.ts          balances in and out, plus the issuer's switches
src/api/index.ts      the Hono app
src/api/chain.ts      live reads, each with a deadline
src/api/hmac.ts       constant-time keeper auth
src/api/overcall.ts   the relay
src/api/cache.ts      the 15s cache
src/api/serialize.ts  bigint → decimal string, and `{raw, decimals, formatted}` amounts
scripts/gen-abis.mjs  ops/abis/*.json → abis/*.ts
```

Files under `src/` other than `src/api/**` are indexing functions and are executed by Ponder at
build time. Shared code that both the handlers and the API need lives in `lib/`.
