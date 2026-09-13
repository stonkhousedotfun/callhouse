# Callhouse keeper

The weekly roll, as a single Node 22 process. One vault per process.

It watches the Overcall registry and the vault's own phase, writes the week's calls into Valorem,
lists the option on Seaport for USDG, publishes that listing to Overcall's book, and after
Saturday expiry redeems the claim so depositors get paid. When the week does not fill — which is
the most likely week — it records that honestly and moves on.

It never holds depositor funds. The hot key holds gas and `KEEPER_ROLE`, nothing else. The option
tokens live in the vault, the vault is the Seaport offerer, and the vault authorises orders by
hash on chain. A compromised keeper can propose a bad order and have it rejected; it cannot move
a single share.

---

## Run it

```bash
cd keeper
cp .env.example .env      # keeper/.env.example — this package's own file, with the chain defaults
                          # filled. The repo-root .env.example covers the other services and lacks
                          # most keeper keys. Then fill in VAULT, KEEPER_PK
                          # (config.ts reads ./.env, or KEEPER_ENV_FILE)
pnpm install              # from the repo root; the lockfile is workspace-wide
pnpm typecheck            # must be clean
pnpm test                 # unit tests, no network (see "Tests")
pnpm dev                  # tsx watch
# production
pnpm build && pnpm start
```

Health and state:

```bash
curl -s localhost:8787/health | jq
curl -s localhost:8787/state  | jq
curl -s localhost:8787/orders | jq    # the fallback book (see "If Overcall rejects us")
```

### Tests

```bash
pnpm test        # tsx --test 'src/**/*.test.ts'
```

The runner is `tsx --test`, not `node --test --experimental-strip-types`: strip-types cannot
compile `enum Phase` in roll.ts (or any `.js`-suffixed import of a `.ts` file), and a glob that
matches no files exits 0, which is how this package shipped with 5,673 lines and zero executed
tests until 2026-09-13. The test files sit next to the modules they test and are typechecked by
`pnpm typecheck` with everything else. None of them dials a network: Overcall is an in-process
stub, the RPC in the test environment is a discard port, and the picker's "last fill" is injected
through a seam on `PickInput`.

What is pinned, because each of these is a week of premium when it drifts:

| File | Pins |
|---|---|
| `policy.test.ts` | the OTM band and premium floor to Policy.sol's integer maths on the real cycle-1 ladder and the real Chainlink print; nearest-in-band rung selection; `isApproved`/`cycleOf` filtering; the 95% sizer; the last-fill lift clamped at 3x the floor; the per-contract fee split on the SAME 40 LCG vectors as `contracts/test/unit/SplitDiff.t.sol` |
| `seaport.test.ts` | the order shape, and the local struct hash and EIP-712 digest **byte for byte** against two real orders on 4663 (`0xa11edb62…`, filled, and `0xeda0150a…`, a live 21-contract order); JSON round-trips of 256-bit fields |
| `state.test.ts` | the SQLite store on a real file: components JSON round-trip of a 77-digit option id, the column allowlists, `/orders` hiding rows past `endTime`, tx recovery by kind and cycle, and reopening the file after close |
| `overcallApi.test.ts` | the POST body and query, 200-as-idempotent, 4xx-not-retried, 429/Retry-After with the 60s cap, network errors, `lastFilledUnitPrice6` picking the newest fill by `createdAt`; and that `abi.ts` names **all 89** custom errors of Vault + SeaportOrderLib + ValoremLib (pinned, and re-derived from `contracts/out` when present) and that `describeError` reports them by name |
| `roll.test.ts` | the chain-outranks-the-book rules without a chain: `seaportVerdict` downgrades a book-latched `filled`/`partial`/`unfillable` only on a chain-valid state, `bookVerdict` believes `filled` only when the row's own Seaport fields agree, and `isPostRetryable` covers a `partial` row the book never accepted |
| `alerts.test.ts` | the cooldown clock: a failed webhook delivery retries after five minutes, a successful one suppresses for the full `KEEPER_ALERT_COOLDOWN_MS` |
| `config.test.ts` | the schema's hard edges: bigint fields reject `-1` loudly (it parses, and would silently switch the low-gas alert off) |

### Dry run against a fork

There is no usable testnet for the whole week. Testnet 46630 has no Chainlink RHNVDA feed and its
cycles are hand-set by Overcall's operator, so a **mainnet fork** is the only place to compress a
week into seconds. `src/dryrun.ts` drives the **production keeper** — `reconcile()` and `tick()`
from roll.ts, with state.ts, policy.ts, seaport.ts, overcallApi.ts, alerts.ts and health.ts all
running unmodified — through two cycles against a fork. `DRYRUN.md` is the recorded run.

```bash
# 1. build the artifacts the dry run deploys (Vault + both linked libraries + the two mocks)
(cd contracts && forge build)

# 2. fork mainnet, keeping chain id 4663, and RUN STEP 3 WITHIN A FEW MINUTES — see the trap below
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545

# 3. drive both cycles. No .env is needed or read; every keeper variable is set by the harness.
pnpm --filter @callhouse/keeper dryrun
# report: keeper/dryrun-out/<utc>/report.md, run.json, keeper.db   (DRYRUN_OUT overrides)
```

What it does, in order — every step is an assertion, and a failure exits 1 naming the step:

1. Checks the RPC is anvil on 4663 (it writes storage and warps time; it refuses a real chain).
2. Reads the **live** Overcall NVDA cycle from the real registry — ids, strikes, timestamps.
3. Deploys `MockRegistry`, `MockFeed` (seeded with the real Chainlink answer), `SeaportOrderLib`,
   `ValoremLib`, and the linked `Vault`, from `contracts/out`. Grants `KEEPER_ROLE`.
4. Mirrors the live series into the mock registry as cycle 1, verbatim.
5. Starts an in-process Overcall (`POST/GET/DELETE /api/orders`, recon-R3 shapes) and an alert
   capture, sets the keeper's environment, and only then imports the keeper.
6. `reconcile()`; a depositor puts 25 NVDA in; `tick()` → `rollOpen` on the real Valorem Clear,
   `approveListing` on the real Seaport, `POST` to the stub; `tick()` → visible in the book.
7. A buyer fills on the real Seaport using the payload from the keeper's own `GET /orders`, with
   the 65-byte placeholder signature — so the vault's EIP-1271 answer and the fallback book are
   both proven. `tick()` sees the fill.
8. Warp to `exerciseTimestamp`; `tick()` → `lockBook`. Warp to `expiryTimestamp`; `tick()` →
   `rollClose`. Asserts the harvest (95% leg, 10% fee, net), that the collateral came back, and
   that the depositor can claim exactly the net.
9. **Cycle 2:** five fresh option types are created on the real Clear, the mock registry moves
   to cycle 2, and the vault is `rollOpen`ed by the harness with the keeper's key and **no
   database row** — the "rolled while asleep" case. `reconcile()` must adopt it, `tick()` must
   list from the policy floor, nobody fills, `lockBook` must retire the listing row and tell the
   book, and `rollClose` must publish **unfilled, 0**.
10. Closes the store, reopens the same file, and checks every row is still there.

Options: `DRYRUN_FEED=real` keeps the real Chainlink feed (cycle 1 only — after a one-week warp
the real feed is stale, which is the vault's `StalePrice` gate working); `DRYRUN_SKIP_CYCLE2=1`;
`DRYRUN_DEPOSIT`, `DRYRUN_RPC`, `DRYRUN_OUT`, `DRYRUN_ARTIFACTS` (where the compiled contracts
come from; default `../contracts/out`), `DRYRUN_HEALTH_PORT`, `DRYRUN_KEEPER_PK`.

Three traps, each of which cost an afternoon:

- **The public RPC serves state for only the last few thousand blocks.** An anvil fork asks the
  upstream for every account and slot it has not seen yet, at the fork block. Roughly 4,000–8,000
  blocks after you start anvil (fifteen to thirty minutes on a 250 ms chain) the upstream starts
  answering `metadata is not found, <block>` and every fresh lookup fails. Start anvil, run the
  dry run immediately, and if you see that message, restart anvil. The whole run takes ~20 s.
- **anvil's default accounts are not empty on chain 4663.** Every one of them carries 23 bytes of
  code — an EIP-7702 delegation designator. A fork inherits it, so the EVM treats those addresses
  as contracts, Valorem's ERC-1155 calls `onERC1155Received` on them, the delegate reverts, and
  Seaport reports `TokenTransferGenericFailure`. The harness derives its own actors from
  `keccak256("callhouse-dryrun:<role>")` and scrubs any code it finds on them.
- **A stale `contracts/out`.** A size-measuring build can leave `Vault.json` compiled with
  `SeaportOrderLib` pinned to `0x1111…1111`; `linkReferences` then names only `ValoremLib`, the
  deployed vault DELEGATECALLs an empty address on its first `approveListing`, and the revert
  carries no data at all. The harness refuses such an artifact and says to `forge clean && forge
  build`.

### Docker

The image is built from the **repo root**, like the two frontends, because the lockfile is
workspace-wide. `keeper/Dockerfile` explains every layer; `ops/deploy.md` ("keeper") is the
Railway runbook, and `keeper/railway.json` is the config-as-code.

```bash
# from the repo root — the trailing dot is the build context
docker build -f keeper/Dockerfile -t callhouse-keeper .
docker run --rm callhouse-keeper                     # no env: prints the missing keys, exits 1
docker run --env-file keeper/.env --env KEEPER_DB_PATH=/data/keeper.db -v callhouse-keeper-db:/data -p 8787:8787 callhouse-keeper
```

The root `.dockerignore` must let `keeper/src` and `keeper/tsconfig.json` into the context; it is
shared with the web and site images, so the exceptions live there, not in a per-package file.
The runner is the stock `node` user, carries no pnpm and no compiler, and reads
`KEEPER_DB_PATH=/data/keeper.db` by default — mount a volume at `/data`. An env file that sets
`KEEPER_DB_PATH` (keeper/.env.example ships `./keeper.db`) OVERRIDES the image default, so the
explicit `--env` above is what keeps the database on the volume.

### systemd

`deploy/callhouse-keeper.service` is a systemd unit with `Restart=always`. Restarting is safe at
any moment — see "Restart safety" below.

---

## Environment

Every variable is validated at boot. A missing or malformed value prints the full list of
problems and exits 1. A keeper that starts with a bad address and discovers it on Friday night is
worse than one that will not start.

### Required

| Key | What it is |
|---|---|
| `RH_RPC` | Primary RPC. **Must be an archive node** — it is the only endpoint used for `eth_getLogs`. |
| `REGISTRY` | The per-market Overcall registry. NVDA is `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`. **Not** the top-level `registry` key in Overcall's frontend config (`0x65dD4079…`), which is the JUGGERNAUT market. There are eleven of these and picking the wrong one writes calls against the wrong book. |
| `VAULT` | The Callhouse vault this process drives. |
| `KEEPER_PK` | The hot key. Needs gas and `KEEPER_ROLE`. Keep ~0.05 ETH on it. |

### Chain, with working defaults

| Key | Default | Notes |
|---|---|---|
| `RH_RPC_2` | — | Backup RPC for `eth_call` and sends. `robinhood-rpc.publicnode.com` **rejects archive `eth_getLogs`**, so the keeper keeps a separate log client pinned to the primary and never fails a log query over to the backup. |
| `CHAIN_ID` | `4663` | Robinhood Chain mainnet, an Arbitrum Orbit L2. |
| `CLEARINGHOUSE` | `0x9a7b…C0C0` | ValoremOptionsClearinghouse. |
| `SEAPORT` | `0x0000…B395` | Seaport 1.6. |
| `USDG` | `0x5fc5…d168` | 6 decimals. |
| `ASSET` | `0xd060…9EEC` | NVDA Stock Token, 18 decimals. |
| `MULTICALL3` | `0xcA11…CA11` | Used to batch the per-tick snapshot into a couple of round trips. |
| `SEAPORT_ZONE` | zero address | Overcall's listings carry no zone. |
| `SEAPORT_CONDUIT_KEY` | zero | Zero means Seaport pulls the ERC-1155 itself, so the vault approves **Seaport**, not a conduit. |
| `OVERCALL_FEE_RECIPIENT` | `0xdAe7…0782` | Receives `consideration[1]`, the 5%. Also Valorem's `feeTo`. |

All of these are cross-checked against the deployed vault at boot. A mismatch is fatal.

### Overcall listings API

| Key | Default | Notes |
|---|---|---|
| `OVERCALL_ORDERS_URL` | `https://overcall.finance/api/orders` | |
| `OVERCALL_MARKET` | `NVDA` | Sent as `?market=`. |
| `OVERCALL_API_KEY` | — | **There is no auth on this API.** No key, no bearer, no cookie, no maker allowlist. This is plumbed through only so the day they add one is a config change. When set it is sent as `authorization: Bearer …`. |
| `OVERCALL_MAX_ATTEMPTS` | `5` | Retries, with exponential backoff. Only 429 and 5xx are retried; a 400/422 means our order is wrong and retrying it just burns their per-IP token bucket. |

### Keeper behaviour

| Key | Default | Notes |
|---|---|---|
| `POLL_INTERVAL_MS` | `60000` | Main loop. |
| `KEEPER_DB_PATH` | `./keeper.db` | SQLite. Back this up; it is the keeper's memory. |
| `KEEPER_PORT` | `8787` | Health server. |
| `KEEPER_LOG_LEVEL` | `info` | pino levels. |
| `KEEPER_MIN_GAS_WEI` | `1e16` (0.01 ETH) | Low-gas alert threshold. |
| `KEEPER_RPC_LAG_ALERT_MS` | `300000` | Head-block lag that trips an alert. |
| `KEEPER_LISTING_VISIBLE_MS` | `900000` | How long a published listing may stay invisible in the book before it is an alert. |
| `KEEPER_FILL_POLL_MS` | `3600000` | How often the HTTP book is polled. Seaport's own `getOrderStatus` is polled every tick, because it is one `eth_call` and it catches a fill within a minute. |
| `KEEPER_MAX_RELISTS` | `1` | Relists after a cancel or invalidation. The vault caps total listings per cycle at 3 regardless, and that cap is read from chain. |
| `KEEPER_ALERT_COOLDOWN_MS` | `3600000` | Repeat suppression per alert kind. State changes ignore it. |
| `KEEPER_TX_TIMEOUT_MS` | `180000` | Receipt wait before the tick gives up and alerts. |
| `KEEPER_UNIT_PRICE_USDG6` | — | Manual per-contract ask override, USDG base units. For one unusual cycle. Leave unset normally. |
| `KEEPER_FALLBACK_DIR` | — | Mirrors each signed order payload to disk. The payload is always in SQLite and served from `/orders`; this is belt and braces. |
| `ALERT_WEBHOOK` | — | Generic JSON `POST`. Unset means alerts are still logged and stored, just not delivered. |
| `KEEPER_ENV_FILE` | `.env` | Alternative dotenv path. |

---

## What the loop actually does

Decisions bind to `registry.isWritingOpen()` and the vault's `phase()`. **Never the wall clock.**
The registry can move a cycle and a guardian can roll the vault while the keeper is asleep; both
have to come out right on the next tick.

| Vault phase | Condition | Action |
|---|---|---|
| `Idle` | `isWritingOpen()` and this cycle is not yet handled | pick strike → `rollOpen` → build order → `approveListing` → `POST` → verify visible |
| `Idle` | writing window closed and we never wrote | record the week as **skipped**, with the reason. This is "unfilled, 0" and it gets published. |
| `Listed` | every tick | `seaport.getOrderStatus`. Fully filled → stop. Cancelled → clear the vault listing and relist once. |
| `Listed` | hourly | Overcall's book: status, fill fraction, visibility |
| `Listed`/`Exercisable` | `now >= cycleExerciseTs` | no new listings; `lockBook()` |
| `Listed`/`Exercisable` | `now >= cycleExpiryTs` | `rollClose()` — redeem, harvest, settle the queue |

Every transaction is **simulated first**, then sent, then waited on, then written to SQLite.
Nothing is fired and forgotten.

### Picking the strike

Read `vault.policy()` — nothing is hardcoded, so an admin policy change takes effect without a
keeper deploy. Then:

```
band      = [ spot * (1 + minOtmBps/1e4) , spot * (1 + maxOtmBps/1e4) ]     (floor division, as on chain)
eligible  = approved rungs in the live cycle whose strike is inside the band
pick      = the LOWEST eligible strike — nearest out of the money, where the premium is
contracts = floor(idleAssets * maxUtilizationBps / 1e4 / lotSize), capped by maxContractsCap
unitPrice = max(policy floor, last observed fill on that rung), the last-fill lift clamped at
            3x the floor (a self-filled print is a cheap fake signal), never below 20 base units,
            never above the strike
```

If no rung qualifies, the keeper writes nothing and says so. That is a legitimate outcome and it
stays a legitimate outcome all week: the keeper keeps re-evaluating until the write deadline, so
a rung that drifts into band on Thursday still gets written.

### Closing the week: what gets published

`rollClose()` is one transaction that redeems the claim, harvests, settles the queue and returns
the vault to `Idle`. Two numbers come out of it and both are easy to get wrong:

**Contracts assigned** is read **before** the transaction is sent. `rollClose` redeems the claim,
which zeroes `claimKey`, and Valorem's `claim()` then reverts `TokenNotFound` — so the same read
taken afterwards answers `0` and every assigned week would be published as unassigned. The vault
has the same comment at the same place for the same reason, and it also emits the number in
`RollClose(cycleNumber, assetsReturned, usdgFromAssignment, contractsAssignedCount)`; the keeper
prefers the event and falls back to its own pre-close read.

**The harvest is summed over the whole cycle, not read off the `rollClose` receipt.** The vault
calls `_checkpointHarvest()` inside `deposit()` and `mint()`, and deposits are open during
`Listed`. So a buyer fills on Tuesday, somebody deposits on Wednesday, that deposit sweeps the
premium into the per-share index and emits `Harvest(cycle, gross, fee, net)` right then — and
Friday's `rollClose` receipt carries `Harvest(cycle, 0, 0, 0)` because there is nothing left to
sweep. Reading only the receipt would record a **sold** week as "unfilled, 0", which is exactly
the number this product promises to publish honestly. Every `Harvest` is tagged with the indexed
cycle number, so the keeper sums the cycle's logs from the `rollOpen` block to the `rollClose`
block (over the primary archive RPC — the backup refuses archive ranges) and falls back to the
receipt only if that range cannot be resolved.

Both closing paths also retire every still-live listing row for the cycle. `rollClose` and
`lockBook` kill orders by bumping the Seaport counter, which does **not** set `isCancelled`, so
polling `getOrderStatus` would never retire them and `/orders` would go on offering a buyer an
order Seaport now rejects. `/orders` additionally refuses to serve anything past its `endTime`.

### The fee split — the one thing that silently breaks fills

```
feePerContract6    = floor(unitPrice6 * 500 / 10000)
writerPerContract6 = unitPrice6 - feePerContract6
consideration[1]   = feePerContract6    * N      -> Overcall's fee recipient
consideration[0]   = writerPerContract6 * N      -> the vault
```

Round **per contract, then multiply**. Rounding on the total produces an order that signs, passes
Overcall's schema, and passes `seaport.validate()` — and that Seaport then refuses to partially
fill with `InexactFraction`, because it scales every consideration item by the fill fraction and
each amount must divide evenly by the order size. Every Overcall listing is `PARTIAL_OPEN`, so a
total-rounded fee quietly turns a 20-contract listing into full-fill-only, which usually means
nobody fills it at all.

`contracts/src/Policy.sol::splitPremium()` implements exactly this and `SeaportOrderLib` re-derives
it on chain, so a mismatch reverts at `approveListing` rather than dying quietly on Friday.

Also: `unitPrice6` must be at least 20, or the 5% floors to zero and Overcall's schema rejects the
zero-amount consideration item.

### Why the signature is a placeholder

The vault is the Seaport offerer. `approveListing()` records the order hash on chain and calls
`seaport.validate()`, so the order fills with an **empty** signature, and the vault's
`isValidSignature` answers `0x1626ba7e` for that hash while ignoring the signature bytes entirely.
There is no key that signs for the vault — it is a contract.

Overcall's zod schema still requires a `signature` field of exactly 64 or 65 bytes before any
on-chain check runs, so the keeper sends a well-formed 65-byte placeholder. Their step-8 check
verifies "the signature verifies for offerer (EOA or ERC-1271)", which for us routes into
`isValidSignature` and passes on the authorised hash.

The keeper also derives the order hash locally and compares it against `seaport.getOrderHash`
before spending gas. Note that `getOrderHash` returns the EIP-712 **struct hash**, not the signing
digest — comparing against `hashTypedData` output looks plausible and is always false. Verified
against the one real filled order on chain:

```
struct hash  0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522
digest       0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150
```

### If Overcall rejects us

A 200 on a repost is success — the endpoint is idempotent on order hash, so retries are safe.

On a persistent rejection the listing is marked `post_failed`, an `api_reject` alert fires, and the
signed payload stays available from `GET /orders`. That is not a dead listing: a Seaport order
authorised on chain is fillable by anyone holding a copy of it. Our own `/vault/nvda/cycle` page
serves these so a buyer can fill directly. **An invisible listing is an unfilled week**, so this
path is a first-class feature, not a consolation prize.

---

## `/health` and what a 503 means

`GET /health` returns **503 only when the loop is wedged** — no completed tick in three poll
intervals, outside the boot grace window, and no tick currently in flight for less than
`KEEPER_TX_TIMEOUT_MS` + 60s. A slow transaction (a rollClose can legitimately wait out the
whole receipt timeout) is NOT a wedged loop. That is the signal Railway's healthcheck
(`keeper/railway.json`) and any k8s probe act on, and the action they take is *restart the
process* — a 503 mid-transaction would kill a healthy keeper.

An empty gas tank and a lagging RPC are real problems that a restart cannot fix, so they do not
produce a 503: restarting on them turns one page into a crash loop that also throws away every
in-flight tick. They show up as `status: "degraded"` with `checks.gas` / `checks.rpcLag` false on
a 200, and they page through the alert webhook as `low_gas` and `rpc_lag`. Alert on
`status != "ok"` if you want a dashboard signal; alert on the HTTP code if you want a restart.

`/health` and `/state` report the phase from the pre-tick snapshot, so a phase change lands up
to one poll interval late. RPC endpoints are reported origin-only: the port is unauthenticated
and production RPC URLs routinely embed keys.

## Logs

JSON lines from pino, one per event, with a `mod` field naming the subsystem: `roll` (the state
machine), `policy` (policy reads and the strike pick), `seaport` (order building and Seaport
chain reads — `debug` only, so silent at the default `info`), `state` (the SQLite store),
`api` (Overcall), `alerts`, `health`, `boot`. bigints are stringified by the serialiser, so the
lines are safe to ship as JSON. `KEEPER_LOG_LEVEL=debug` turns on the per-tick chain-read lines;
they are noisy on purpose and should not run in production.

## Alerts

Delivered as a JSON `POST` to `ALERT_WEBHOOK`, logged at severity, and stored in SQLite either
way. Repeats of the same kind are suppressed for `KEEPER_ALERT_COOLDOWN_MS`; a condition clearing
resets the suppression so the next occurrence alerts immediately.

| Kind | Severity | What it means and what to do |
|---|---|---|
| `tx_revert` | error | A simulation or a receipt came back reverted. The message carries the decoded custom error and its arguments — `rollOpen would revert: … StrikeBelowBand(226000000, 231750000)` — for every error the vault and its two linked libraries can throw (`overcallApi.test.ts` pins the list). Nothing was sent if it was a simulation. |
| `api_reject` | error | Overcall refused the listing, or marked it `unfillable`, or the vault's ERC-1155 approval is missing. The server's own error string is included verbatim. The order is still on chain and still served from `/orders`. |
| `listing_invisible` | error | Published but not in the book 15 minutes later. Check `/orders`, point buyers at our page, and chase it. |
| `oracle_paused` | warn | The Stock Token halted its own oracle. The vault will refuse to write. Nothing to do but wait; redemptions and `rollClose` are unaffected. |
| `valorem_fees_enabled` | warn | Valorem turned its 15 bps **notional** engine fee on. The vault stops writing until an admin calls `acceptValoremFee(true)`. That is a governance decision, deliberately not a keeper one: on a weekly OTM call, 15 bps of notional is a large slice of the premium. |
| `low_gas` | warn | Keeper ETH under `KEEPER_MIN_GAS_WEI`. Top it up. |
| `rpc_lag` | warn | Head block trails the wall clock by over `KEEPER_RPC_LAG_ALERT_MS`. Check both RPCs. |
| `phase_stuck` | error | The vault is still not `Idle` more than an hour after expiry. **Anyone can call `rollClose()` now** — see below. |
| `no_rung` | info | No strike inside the policy band, or the write window closed with no write. An honest skipped week: unfilled, 0. Also comes in a **warn** variant: `stale-oracle` — the feed is stale and the vault refuses every write while it lasts; that one pages per cycle so it is heard while the week can still be saved. |
| `keeper_error` | error | An unhandled error inside a tick. The loop keeps running; the next tick re-reads everything from chain. |
| `roll_open` / `roll_close` / `boot` | info | State changes, always delivered, never suppressed. `boot` also has a **warn** variant — the keeper lacks `KEEPER_ROLE` and can close but not open — so routing that mutes info entirely would hide it. |

---

## Restart safety

The keeper may be killed at any instant, including in the gap between `approveListing()` landing
on chain and the `POST` to Overcall. On boot it does not trust its database:

1. Reads the vault's wiring (`asset`, `usdg`, `clear`, `seaport`, `registry`, fee recipient,
   conduit key, zone) and **refuses to start** if any of it disagrees with the environment.
2. Checks that the vault has approved Seaport to move its option tokens, and that the keeper
   holds `KEEPER_ROLE`. Missing role is a warning, not a failure — `lockBook` is permissionless
   and `rollClose` opens to everyone an hour after expiry, so a role-less keeper still closes.
3. Resolves every transaction it had recorded as pending against its receipt.
4. Refreshes every non-terminal listing from `seaport.getOrderStatus`.
5. Adopts an open cycle it has no row for — which is exactly the "died right after `rollOpen`"
   case.

A cycle with a row in `cycles` is never rewritten. Listings are keyed by order hash, and reposting
one is idempotent. `docker restart` mid-week is a non-event.

---

## When the keeper is dead

This is the case the design is built around, so nothing about it is dramatic.

**Options still expire on their own.** Valorem is not waiting for us. A call that is out of the
money at Saturday 20:00 UTC simply becomes worthless, and the collateral stays where it is —
inside the vault's claim.

**`lockBook()` is permissionless** once `cycleExerciseTs` has passed. Anyone can call it. It only
moves `Listed → Exercisable` and kills any listing still live, so there is nothing to gain by
calling it and something to lose if nobody can.

**`rollClose()` opens to everyone an hour after expiry.** From `cycleExpiryTs` the keeper can call
it; from `cycleExpiryTs + 1 hour` so can any address on earth. It redeems the claim, harvests the
premium, settles the redeem queue and returns the vault to `Idle`, all in one transaction. The
guardian does not need the keeper's key, its database, or its order components:

```bash
cast send $VAULT "rollClose()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```

**The guardian can kill listings without any keeper state.** `invalidateAllListings()` bumps the
vault's Seaport counter, which invalidates every outstanding order at once and needs no order data
to do it. That is the path that works when the keeper is gone and nobody can reconstruct the
components:

```bash
cast send $VAULT "invalidateAllListings()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
cast send $VAULT "haltWrites()"            --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```

**Depositors are never trapped.** `queueRedeem`, `completeRedeem` and `claimUsdg` are never
blocked by a halt, by the phase, or by the keeper being down. Once `rollClose` has run — by
anyone — the queue settles and everyone can withdraw. The worst case of a dead keeper is a week
with no premium written, published as **unfilled, 0**.

### Restarting after a death mid-week

Just start it. Reconciliation adopts whatever state the vault is in. If a guardian already called
`rollClose`, the keeper sees `Idle` and waits for the next cycle. If the vault is still `Listed`,
it picks the listing back up from `seaport.getOrderStatus` and carries on.

---

## Files

| File | What it holds |
|---|---|
| `config.ts` | zod-validated environment. Exits with the full problem list on anything malformed. |
| `abi.ts` | viem `as const` ABI fragments: Vault, OvercallRegistry, Valorem Clear, Seaport 1.6, ERC-20, Stock Token. Transcribed from `ops/abis`, verified against live chain reads. |
| `clients.ts` | Three viem clients: reads (both RPCs, `fallback`), logs (primary only), writes (primary only). |
| `state.ts` | SQLite: cycles, listings, transactions, alerts, heartbeat. 256-bit values are stored as decimal TEXT — an optionId does not fit in a SQLite INTEGER. |
| `policy.ts` | The strike picker and sizer, mirroring `Policy.sol` integer for integer. |
| `seaport.ts` | Order construction in exactly Overcall's shape, the per-contract fee split, local hash derivation. |
| `overcallApi.ts` | `POST`/`GET`/`DELETE` against their listings API, with backoff. |
| `roll.ts` | The state machine, the transaction plumbing, and the boot reconciliation. |
| `health.ts` | `/health`, `/state`, `/orders`, `/cycles`. |
| `alerts.ts` | Webhook alerting with per-kind cooldown. |
| `index.ts` | Wiring, the poll loop, graceful shutdown. |
| `dryrun.ts` | The production keeper driven through two cycles against an anvil fork, with assertions. `DRYRUN.md` is the recorded run. |
| `*.test.ts` | Unit tests, next to the module each one pins. `pnpm test`. |
| `Dockerfile`, `railway.json` | The container, built from the repo root, and the Railway config-as-code. Runbook: `ops/deploy.md`. |
| `deploy/callhouse-keeper.service` | The systemd alternative. |
