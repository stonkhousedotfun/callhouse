# Callhouse keeper

The weekly roll, as a single Node 22 process. One vault per process.

It watches the vault's own phase and the clock of the head block, creates the week's option type
on the Valorem clearinghouse, ARMS it on the vault (`rollOpen` writes nothing), authorises one
Seaport 1.6 listing sized to the vault's capacity, serves that listing from its own `/orders` (the
self-hosted fill page is the venue), locks the book at the Friday close, and after Saturday
expiry redeems the claim so depositors get paid. Every fill of the listing is written by the
vault itself, inside Seaport's `authorizeOrder` hook: **written == sold**, and the vault never
holds an unsold option token. When the week does not fill — which is the most likely week — the
keeper records that honestly and moves on.

It never holds depositor funds. The hot key holds gas and `KEEPER_ROLE`, nothing else. The vault
is the Seaport offerer AND the zone, and it authorises orders by hash on chain. A compromised
keeper can propose a bad order and have it rejected; it cannot move a single share.

There is no registry and no Overcall API any more (redesign of 2026-09-13). The vault reads the
option tuple from the clearinghouse, numbers its own cycles, and sells through `/orders`.

---

## Run it

```bash
cd keeper
cp .env.example .env      # keeper/.env.example — this package's own file, with the chain defaults
                          # filled. The repo-root .env.example covers the other services and lacks
                          # most keeper keys. Then fill in VAULT, KEEPER_PK
                          # (config.ts reads ./.env, or KEEPER_ENV_FILE)
pnpm install              # from the repo root; the lockfile is workspace-wide
pnpm typecheck            # must be clean, dry runs included
pnpm test                 # unit tests, no network (see "Tests")
pnpm dev                  # tsx watch
# production
pnpm build && pnpm start
```

Health and state:

```bash
curl -s localhost:8787/health | jq
curl -s localhost:8787/state  | jq
curl -s localhost:8787/orders | jq    # the book: the vault's live listing, OrderParameters + "0x"
curl -s localhost:8787/cycles | jq    # the cycle tape
```

### Tests

```bash
pnpm test        # tsx --test 'src/**/*.test.ts'
```

The runner is `tsx --test`, not `node --test --experimental-strip-types`: strip-types cannot
compile `enum Phase` in roll.ts (or any `.js`-suffixed import of a `.ts` file), and a glob that
matches no files exits 0. The test files sit next to the modules they test and are typechecked by
`pnpm typecheck` with everything else. None of them dials a network: the RPC in the test
environment is a discard port, the tick tests replace the keeper's own viem client methods
with in-process stubs, and the Cboe chain comes from `src/fixtures/cboe-nvda-2026-09-14.json`
(the real NVDA chain after the close on 14 Sep 2026, trimmed to the 18 Sep and 25 Sep expiries)
through `fetchCboeChain`'s fetch seam and `roll.ts`'s `volSource`.

What is pinned, because each of these is a week of premium when it drifts:

| File | Pins |
|---|---|
| `policy.test.ts` | the OTM band, `maxContracts`, capacity (`Policy.maxContracts(totalAssets) − contractsWritten`), the fill floor with the engine fee valued at spot, `withPremiumMargin`, `planWeek` / `priceListing` / `fillVerdict`, all to Policy.sol's and ValoremLib.sol's integer maths on the real Chainlink print (fixed mode) |
| `vol.test.ts` | Cboe option symbols, the chain's two clocks (timestamp UTC, `last_trade_time` New York) and freshness, including the latest settled NYSE session (weekends, holidays, DST, early closes), the wrong-root and changed-format refusals, exact-expiry selection, the quote filter (spread, overflow), the quote-window consistency checks (gap, rising delta, vertical and butterfly arbitrage), the share-to-token spot ratio and its divergence limit, `strikeForDelta` (0.15 on 18 Sep lands at 220), its out-of-range flag and its single-crossing rule, `fairCallPrice` interpolation and round-up, and `fetchCboeChain` refusing non-https, off-host redirects, a timeout (headers or body), an oversize body, bad JSON and a wrong shape |
| `policy.vol.test.ts` | vol-mode `planWeek` on the fixture: every vault gate holds (band at the arm spot, `unit ≤ strike`, `unit ≥` floor with margin, `gross % N == 0`), the band clamp both ways with both buffers, every `vol-*` skip reason, broken chains refused (gapped grid, inverted or non-convex quote, corrupt delta, delta far from target, overflowing quote, a thrown getter), the 200 bps default buffer's rally room, fixed mode ignoring the chain, the raise-only override, and reprices with and without fresh data (never below the last market-based ask) |
| `roll.vol.test.ts` | vol mode through `tick()`: a failed or stale fetch is a remembered skip and an alert with nothing simulated, an empty vault fetches nothing, one fetch arms the delta strike and prices its listing, the pricing record reaches the rows, the alerts, `/orders` and `/state`, a reprice on a dark feed falls back to the previous fair value or, with none, leaves the live listing in place, a rally reprices a fillable listing UP (not without a spare slot, below the threshold, more than every 30 minutes, or for a non-vol listing), the first listing falls back to the arm's fair value, and `/state` serves no pricing while Idle |
| `calendar.test.ts` | the NYSE Friday 16:00 ET close through the DST switch, a Friday holiday rolling to Thursday, the arm lead and the vault's `MIN_LEAD` floor |
| `optionType.test.ts` | the option id derivation (`keccak` of the six-field tuple, upper 160 bits `<< 96`) against five real NVDA ids the real Clear emitted; the whole-USDG strike rounding |
| `seaport.test.ts` | the PARTIAL_RESTRICTED order shape (zone == vault, one USDG item, empty signature), and the local struct hash and EIP-712 digest **byte for byte** against two real orders on 4663; JSON round-trips of 256-bit fields |
| `state.test.ts` | the SQLite store on a real file: components JSON round-trip of a 77-digit option id, the column allowlists, `/orders` hiding rows past `endTime`, tx recovery by kind and cycle, reopening the file after close, the migration mechanism on a first-release schema, and `pricing_json` added to a first-release file idempotently |
| `abi.test.ts` | that `abi.ts` names **all 92** custom errors of Vault + SeaportOrderLib + ValoremLib + Policy (pinned, and re-derived from `contracts/out` when present; 36 of them are raised inside the linked libraries and are absent from `Vault.json`), that its functions and events match `Vault.json`, and that `describeError` / `revertName` report them by name |
| `roll.test.ts` | the pure verdicts: `seaportVerdict`, `resolveContractsAssigned`, `decodeRollClose` / `decodeClaimStranded`, the `roll_close` wording incl. the stranded suffix, `describeInterval` |
| `roll.close.test.ts` | `contractsAssignedAt` (the 1e18 divisor, the Clear read, null on a revert) and both close paths through `tick()`: the keeper's own `rollClose` and the reconstruction of a close it never witnessed, with `assets_returned` / `usdg_from_assignment` and `/cycles` |
| `roll.idle.test.ts` | the Idle tick: `settleQueue` then a fresh snapshot before the plan; `phase_stuck` on the head block's clock; a stranded claim (no arm attempted, `claim_stranded` once, `strand_retry_failed` on `StillStranded`, `strand_recovered` closing the row) |
| `roll.relist.test.ts` | a Listed tick with `listingHash == 0` retires every still-offered row of the cycle — Seaport-cancelled, counter-invalidated (never `isCancelled`), or filled before the cancel — and leaves `/orders` serving none of them |
| `alerts.test.ts` | the cooldown clock: a failed webhook delivery retries after five minutes, a successful one suppresses for the full `KEEPER_ALERT_COOLDOWN_MS` |
| `config.test.ts` | the schema's hard edges: bigint fields reject `-1` loudly, `KEEPER_PREMIUM_MARGIN_BPS` in 0..1000, the week's knobs, the vol pricing keys' defaults and bounds (`KEEPER_VOL_URL` https only), no registry or Overcall key |
| `health.test.ts` | the HTTP server answers on `127.0.0.1` and on `::1` (Railway's private network is IPv6) |

### Dry run against a fork

There is no usable testnet for the whole week (testnet 46630 has no Chainlink RHNVDA feed and no
usable Clear), so a **mainnet fork** is the only place to compress a week into seconds.
`src/dryrun.ts` drives the **production keeper** — `reconcile()` and `tick()` from roll.ts, with
state.ts, policy.ts, seaport.ts, optionType.ts, calendar.ts, alerts.ts and health.ts all running
unmodified — through three weeks and a fourth arm against a fork. `DRYRUN.md` is the recorded run.

```bash
# 1. build the artifacts the dry run deploys (Vault + both linked libraries + MockFeed).
#    contracts/ is the callhouse-contracts submodule: git submodule update --init --recursive
(cd contracts && forge build)     # `forge build --sizes` exits 1 on its EIP-170 line: noise on this chain

# 2. fork mainnet, keeping chain id 4663 AND the chain's real code limit (the vault is 25,765 B),
#    and RUN STEP 3 WITHIN A FEW MINUTES — see the traps below
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8560 --code-size-limit 98304

# 3. drive the weeks. No .env is needed or read; every keeper variable is set by the harness.
pnpm --filter @callhouse/keeper dryrun
# report: keeper/dryrun-out/<utc>/report.md, run.json, keeper.db   (DRYRUN_OUT overrides)
```

What it does, in order — every step is an assertion, and a failure exits 1 naming the step:

1. Checks the RPC is anvil on 4663 on a loopback address (it writes storage and warps time; it
   refuses a real chain and any other chain id).
2. Deploys `MockFeed` (seeded with the real Chainlink answer at the fork block), `SeaportOrderLib`,
   `ValoremLib` and the linked `Vault` from `contracts/out`, with the constructor `Config` tuple
   exactly as `script/Deploy.s.sol` builds it (no registry, no zone argument; `clear` = the real
   Clear `0x9a7b…C0C0`, whose `newOptionType` is permissionless and whose fee switch is off).
   Grants `KEEPER_ROLE` and `GUARDIAN_ROLE`.
3. Starts an alert capture, sets the keeper's environment, and only then imports the keeper.
4. **Week 1, unfilled.** A depositor puts 25 NVDA in. `tick()` → the keeper computes the next NYSE
   Friday 16:00 ET close, creates the option type on the real Clear (asserting the
   `NewOptionType` log names the id it derived and `clear.tokenType(id) == Option`), `rollOpen(id)`
   (`RollOpen.contractsCount == 0`, nothing written, no option tokens), and `approveListing` at
   capacity (23 = `floor(25 × 0.95)`): `seaport.getOrderStatus(hash).isValidated`,
   `vault.listingHash == hash`, and the `/orders` payload is `orderType 3`, `zone == vault`, one
   USDG consideration item, `signature "0x"`, `endTime == cycleExerciseTs`. Nobody fills. The
   depositor queues 5 shares while Listed; at the exercise timestamp deposits close on the clock
   (`DepositsClosed`); `tick()` → `lockBook` (counter bump, listing row `expired`, `/orders` empty);
   `tick()` → `rollClose` flat: `RollClose(1, 0, 0, 0)`, the honest `Harvest(1, 0, 0, 0)`, no
   `ClaimRedeemed`, the queue settled at `q × (idle + 1) / (supply + 1)`. Flat: `completeRedeem`,
   an instant `redeem`, a queue joined while Idle, and the next `tick()` settles it through the
   keeper's own `settleQueue()` **and re-reads the vault before planning week 2** (capacity 14,
   not the 17 a stale snapshot would have planned).
5. **Week 2, filled and exercised.** Buyer A fills 2 of 14 straight from `/orders` with
   `fulfillAdvancedOrder(2, 14, "0x")` (gas recorded; opens the claim), buyer B fills 3 more (the
   top-up): `CallsWritten` once per fill, `contractsWritten == 5`, the vault's ERC-1155 balance 0
   after each fill, the premium on the vault; `tick()` publishes each fill. A 5 NVDA deposit while
   Listed succeeds (D8) and checkpoints the premium early (`Harvest` inside the deposit; `sweepFee`
   then pays the 5% to the base unit); the depositor queues 4 while Listed. Spot moves above the
   strike, `lockBook`, buyer A exercises 2 on the real Clear, `rollClose`: `RollClose(2, 3e18,
   2 × strike, 2)`, both `ClaimRedeemed`s, a second `Harvest` carrying the strike proceeds fee-free,
   the keeper's row summing both Harvests, the assigned-week wording, the queue settled;
   `completeRedeem` and `claimUsdg` to the base unit.
6. **Week 3, stranded.** A fill, a queue while Listed, one exercise of two (both claim legs
   non-zero), then Paxos's `ASSET_PROTECTION` EOA (impersonated) **freezes the vault on the real
   USDG**. `tick()` → `rollClose` STRANDS: `ClaimStranded(3, claimKey, 1)`, `RollClose(3, 0, 0, 1)`,
   the premium harvested but the fee left pending (the frozen vault cannot pay it), Idle with the
   claim kept, `EpochStrandShare(4, 1, wad)`, `isStranded()`, deposits `DepositsClosed`,
   `retryStrandedClaim` and `rollOpen` both `StillStranded`; the keeper pages `claim_stranded`.
   The next tick attempts no arm, its retry timer fires, the retry reverts `StillStranded` →
   `strand_retry_failed`; a tick inside the timer does nothing. Unfreeze → the next retry lands:
   `StrandedClaimRecovered`, `Harvest` carrying cycle 3's number, the deferred fee swept,
   `strand_recovered`; the queuer's `completeRedeem` pays the idle slice, the escrow's USDG and
   the `StrandShareSettled` claim share; then the keeper arms **week 4** normally.
7. Closes the store, reopens the same file, and asserts every cycle and listing row and the
   exact alert and transaction sequences.

Options: `DRYRUN_DEPOSIT` (default 25e18, within [15e18, 45e18]; every figure is derived),
`DRYRUN_RPC` (default `http://127.0.0.1:8560`), `DRYRUN_OUT`, `DRYRUN_ARTIFACTS`,
`DRYRUN_HEALTH_PORT` (default 18790), `DRYRUN_KEEPER_PK`.

### Extended dry run

`src/dryrun-extended.ts` covers what the three-week run cannot, on one vault with a non-default
deposit (30e18), the same fork and the same exact-amount style (shared plumbing in
`src/dryrun-common.ts`):

```bash
(cd contracts && forge build)
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8560 --code-size-limit 98304
pnpm --filter @callhouse/keeper dryrun:extended
# report: keeper/dryrun-out/extended-<utc>/report.md, run.json, keeper.db, keeper-process.log
```

1. **`index.ts`, the real process.** Runs `tsc` (the `build` script) and spawns `node
   dist/index.js` — the Dockerfile's CMD — with `POLL_INTERVAL_MS=5000` against the fork. It must
   boot, send the `boot` alert, tick idle on its interval (every gap ≥ 5 s, `no-capacity`), then
   create the type and arm on the poll tick after a deposit lands. The harness holds that tick's
   `roll_open` alert delivery open, sends SIGTERM, and asserts the process is still alive two
   seconds later, logs `shutting down` → `waiting for the in-flight tick` → the `approveListing`
   confirmation → `stopped`, starts no new tick, exits 0, and leaves no `-wal`/`-shm`/`-journal`
   beside `keeper.db`; the file passes `PRAGMA integrity_check` and the in-process keeper carries
   the week on from it.
2. **Partial fills, a guardian cancel, a reprice, refused fills, the budget.** Buyer A fills 7/28;
   the guardian `cancelListing`s (a role-less cancel is refused) and the keeper relists the 21
   left; buyer B fills 6/21. The feed **rallies 1.5%**: an `eth_call` of a fill now reverts
   `PremiumBelowFloorAtFill(gross, floor)`, decoded by name through the 92-error ABI; the keeper
   cancels and re-approves at the new floor (its third and last authorisation) and a fill at the
   new price succeeds. The guardian `haltWrites`: the eth_call reverts `WritesAreHalted`; the admin
   unhalts. The guardian `invalidateAllListings`; the keeper retires the row, lists nothing, and a
   fourth `approveListing` reverts `TooManyListings(3, 3)`.
3. **Several exercisers across several transactions**: 3, 4 and 2 contracts in three `exercise`
   transactions by two buyers; one `RollClose(1, 5e18, 9 × strike, 9)` and the harvest exact.
4. **Anyone `rollClose`**: the keeper does not tick at expiry; a role-less address reverts
   `GuardianTooEarly(expiry + 3600)` just past expiry and at expiry + 3599, and closes at exactly
   expiry + 3600. The keeper's next tick reconstructs the week from logs with the split and the
   unwitnessed wording.
5. **Valorem's fee switch**: the Clear's `feeTo` is impersonated to `setFeesEnabled(true)`. The
   keeper reports the flip (`fee_switch`), refuses to arm (`valorem_fees_enabled`), and `rollOpen`
   reverts `ValoremFeeNotAccepted(15)`; after `acceptValoremFee(true)` it arms and prices the
   listing with the fee valued at spot; the fill pays 15 bps of collateral in NVDA, the exercise
   15 bps of the strike in USDG, and the claim redeems untouched.

Options: `DRYRUN_DEPOSIT` (default 30e18, within [23e18, 45e18]), `DRYRUN_HEALTH_PORT` (default
18790; the spawned keeper takes the next port), `DRYRUN_RPC`, `DRYRUN_OUT`, `DRYRUN_ARTIFACTS`,
`DRYRUN_KEEPER_PK`.

Traps, each of which has cost an afternoon:

- **The public RPC serves state for only the last few thousand blocks, and 429s under load.** An
  anvil fork asks the upstream for every account and slot it has not seen yet, at the fork block.
  Roughly 4,000–8,000 blocks after you start anvil the upstream starts answering `metadata is not
  found`, and a busy moment answers `429 Too Many Requests` at fork time (`failed to create
  genesis`). Start anvil immediately before the run, run at once (both harnesses take under a
  minute), and if either message appears, restart anvil at the head with a short backoff.
- **`--code-size-limit 98304` is required.** Chain 4663's real code limit is 98,304 B and the vault
  is 25,765 B; without the flag anvil refuses the deployment as an EIP-170 breach.
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
- **A second run on the same fork reuses option types.** The tuple (asset, lot, USDG, strike,
  exercise, expiry) is the id, so a rerun that lands on the same Friday and the same strike finds
  the type already created and the keeper reuses it (`optionTypeReused` in `run.json`, no
  `newOptionType` transaction). That is designed behaviour, not a miss; a clean record still
  wants a fresh fork.

### Docker

The image is built from the **repo root**, like the web image, because the lockfile is
workspace-wide. `keeper/Dockerfile` explains every layer; `ops/deploy.md` ("keeper") is the
Railway runbook, and `keeper/railway.json` is the config-as-code.

```bash
# from the repo root — the trailing dot is the build context
docker build -f keeper/Dockerfile -t callhouse-keeper .
docker run --rm callhouse-keeper                     # no env: prints the missing keys, exits 1
docker run --env-file keeper/.env --env KEEPER_DB_PATH=/data/keeper.db -v callhouse-keeper-db:/data -p 8787:8787 callhouse-keeper
```

The root `.dockerignore` must let `keeper/src` and `keeper/tsconfig.json` into the context; it is
shared with the web image, so the exceptions live there, not in a per-package file.
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
worse than one that will not start. `keeper/.env.example` lists every key with its default.

### Required

| Key | What it is |
|---|---|
| `RH_RPC` | Primary RPC. **Must be an archive node** — it is the only endpoint used for `eth_getLogs`. |
| `VAULT` | The Callhouse vault this process drives. |
| `KEEPER_PK` | The hot key. Needs gas and `KEEPER_ROLE`. Keep ~0.05 ETH on it. |

### Chain, with working defaults

| Key | Default | Notes |
|---|---|---|
| `RH_RPC_2` | — | Backup RPC for `eth_call` and sends. `robinhood-rpc.publicnode.com` **rejects archive `eth_getLogs`**, so the keeper keeps a separate log client pinned to the primary and never fails a log query over to the backup. |
| `CHAIN_ID` | `4663` | Robinhood Chain mainnet, an Arbitrum Orbit L2. |
| `CLEARINGHOUSE` | `0x9a7b…C0C0` | The Valorem clearinghouse the vault was constructed with (Overcall's unmodified instance by default; our own from `script/DeployClear.s.sol` if deployed that way). The keeper creates the week's option type on it. |
| `SEAPORT` | `0x0000…B395` | Seaport 1.6. |
| `USDG` | `0x5fc5…d168` | 6 decimals. |
| `ASSET` | `0xd060…9EEC` | NVDA Stock Token, 18 decimals. |
| `MULTICALL3` | `0xcA11…CA11` | Used to batch the per-tick snapshot into a couple of round trips. |
| `SEAPORT_CONDUIT_KEY` | zero | Zero means Seaport pulls the ERC-1155 itself, so the vault approves **Seaport**, not a conduit. The zone is the vault itself and is derived, not configured. |

All of these are cross-checked against the deployed vault at boot (`asset`, `usdg`, `clear`,
`seaport`, `conduitKey`, `seaportZone == VAULT`). A mismatch is fatal.

### The week

| Key | Default | Notes |
|---|---|---|
| `KEEPER_STRIKE_OTM_BPS` | `500` | **Fixed mode only.** The strike is `round(spot × (1 + bps/1e4))` to a whole USDG. It must sit inside the vault's policy band at the spot of the arm (launch 3%–12%); outside it the keeper declines the week before spending gas. |
| `KEEPER_ARM_LEAD_S` | `21600` (6 h) | The keeper's own minimum distance to the Friday close when it arms; at least the vault's `MIN_LEAD` (3600). Closer than this means the following Friday. |
| `KEEPER_NYSE_HOLIDAYS` | built-in 2026–2027 table | Full-day NYSE closures as `YYYY-MM-DD,…`. A Friday holiday rolls the close back to Thursday 16:00 ET. Set it once the table runs out. |

### Pricing

| Key | Default | Notes |
|---|---|---|
| `KEEPER_PRICING_MODE` | `vol` | `vol`: strike at `KEEPER_TARGET_DELTA` and ask at the market's fair value plus `KEEPER_PRICE_EDGE_BPS`, from Cboe's free delayed option quotes, never below the fill floor with the margin and never above the strike (see [Choosing the week](#choosing-the-week)). Missing, stale or inconsistent market data skips the week with a named `vol-*` reason; it never falls back to `fixed`. `fixed`: the launch rule, `KEEPER_STRIKE_OTM_BPS` and the fill floor with the margin. |
| `KEEPER_TARGET_DELTA` | `0.15` | Vol mode. The call delta the strike targets, `0.05`–`0.40`: linear interpolation between the two listed strikes of the cycle's expiry that bracket it, mapped to the token by moneyness, rounded to a whole USDG half up. A target the quoted deltas do not reach skips (`vol-delta-out-of-range`). |
| `KEEPER_PRICE_EDGE_BPS` | `1000` (10%) | Vol mode. `volAsk = ceil(fair × (10000 + edge) / 10000)`, where `fair` is the listed mid interpolated at the armed strike and mapped to the token. The ask is `max(fill floor with the margin, volAsk)`. `0`–`5000`. |
| `KEEPER_STRIKE_BAND_BUFFER_BPS` | `200` | Vol mode. The delta strike is clamped into `[ceil(spot × (1 + (minOtmBps + buffer)/1e4)), floor(spot × (1 + (maxOtmBps − 50)/1e4))]` in whole USDG, and the clamp is recorded. The buffer keeps the strike off the band floor, which the fill gate re-checks at every fill (`StrikeBelowBand` after a rally of more than the room left, and no reprice can move a strike). A delta-0.15 strike on a two- to four-day expiry lands close to the floor, so the default is the room the fixed rule has (a 5% strike over a 3% floor). The fixed 50 bps under the ceiling covers a spot drop between the plan and the two arm transactions. `0`–`1000`. |
| `KEEPER_VOL_REPRICE_UP_BPS` | `2500` | Vol mode. A live listing the fill gate still accepts is cancelled and relisted UP when fresh, fully checked market data puts the market-based ask more than this many bps above the live ask (a rally raises a 0.15-delta call's fair value far faster than the vault's floor, which is the only thing a floor reprice watches). Only for listings priced in vol mode, at most every 30 minutes per listing, and only while a listing slot would remain for a floor reprice; otherwise `fill_sim_revert` (`reprice-up-no-slot`). `0` turns it off. `0`–`50000`. |
| `KEEPER_VOL_URL` | Cboe's NVDA delayed chain | Vol mode. `https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json`. https only; redirects are followed only to the same https host. |
| `KEEPER_VOL_ROOT` | `NVDA` | Vol mode. The option root the chain must report in `data.symbol`; any other ticker's file is `vol-inconsistent`. |
| `KEEPER_VOL_MAX_AGE_S` | `345600` (4 days) | Vol mode. The oldest last trade (and file) the keeper prices on: the vault's own `maxPriceAge`, so a Saturday arm reads Friday's close and a long weekend still fits. `3600`–`1209600`. |
| `KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS` | `300` | Vol mode. `|tokenSpot / shareSpot − 1|` limit, where `tokenSpot` is `vault.spotUsdg()` and `shareSpot` the feed's `current_price`. The token multiplier is ~8 bps; beyond the limit one of the two spots is wrong or from another day (`vol-spot-divergence`). `1`–`2000`. |
| `KEEPER_VOL_TIMEOUT_MS` | `10000` | Vol mode. One deadline for the whole fetch: connect, headers and body. `1000`–`60000`. |
| `KEEPER_VOL_MAX_BYTES` | `8000000` | Vol mode. Body byte cap, enforced while streaming (the NVDA chain is ~1.9 MB). `100000`–`64000000`. |
| `KEEPER_PREMIUM_MARGIN_BPS` | `100` (1%) | Basis points added to the vault's **fill-time** premium floor when pricing a listing: `unit = ceil(floor × (10000 + margin) / 10000)`. The fill gate re-derives the floor from the spot of the FILL (`PremiumBelowFloorAtFill`), so a listing priced exactly at today's floor is refused by the first buyer after any uptick; a margin of `m` bps absorbs a rise of up to `m` bps before the keeper has to reprice, and each reprice spends one of the vault's three listings a week. Trade-off: higher margin, fewer reprices, slightly higher ask. `0`–`1000`. Not applied to `KEEPER_UNIT_PRICE_USDG6`. |
| `KEEPER_UNIT_PRICE_USDG6` | — | Manual per-contract ask override, USDG base units. For one unusual cycle. Still floored at the live fill floor and capped at the strike. In vol mode it can only **raise** the ask: the listing stays at or above `max(fill floor with the margin, fair value with the edge)`, and nothing is armed or listed without a market-based fair value. To sell below the market, switch to `KEEPER_PRICING_MODE=fixed`. Leave unset normally. |
| `KEEPER_FALLBACK_DIR` | — | Mirrors each authorised order payload to disk. The payload is always in SQLite and served from `/orders`; this is belt and braces. |

### Stranded claims

| Key | Default | Notes |
|---|---|---|
| `KEEPER_RETRY_STRANDED_MS` | `3600000` (1 h) | How often `retryStrandedClaim()` is attempted while the vault is stranded. Simulated first, so a freeze that still holds costs no gas. Floor 1000. |

### Keeper behaviour

| Key | Default | Notes |
|---|---|---|
| `POLL_INTERVAL_MS` | `60000` | Main loop. |
| `KEEPER_DB_PATH` | `./keeper.db` | SQLite. Back this up; it is the keeper's memory. |
| `KEEPER_PORT` | `8787` | Health server. |
| `KEEPER_LOG_LEVEL` | `info` | pino levels. |
| `KEEPER_MIN_GAS_WEI` | `1e16` (0.01 ETH) | Low-gas alert threshold. |
| `KEEPER_RPC_LAG_ALERT_MS` | `300000` | Head-block lag that trips an alert. |
| `KEEPER_ALERT_COOLDOWN_MS` | `3600000` | Repeat suppression per alert kind. State changes ignore it. |
| `KEEPER_TX_TIMEOUT_MS` | `180000` | Receipt wait before the tick gives up and alerts. |
| `ALERT_WEBHOOK` | — | Generic JSON `POST`. Unset means alerts are still logged and stored, just not delivered. In production this is the relay (`relay/`). |
| `ALERT_WEBHOOK_TOKEN` | — | ≥ 16 chars. Sent as `authorization: Bearer <token>` with every webhook POST; the relay requires it. |
| `KEEPER_ENV_FILE` | `.env` | Alternative dotenv path. |

---

## What the loop actually does

Decisions bind to the vault's `phase()` and the head block's timestamp. **Never the wall clock,
and never a third party.** A guardian can cancel a listing or halt the vault, anyone can lock the
book, close the week, settle the queue or retry a stranded claim while the keeper is asleep; all
of it has to come out right on the next tick.

| Vault phase | Condition | Action |
|---|---|---|
| `Idle` | `queuedShares > 0` | `settleQueue()` (permissionless), then re-read the vault before deciding anything else |
| `Idle` | `isStranded()` | no arm (`rollOpen` would revert `StillStranded`); `retryStrandedClaim()` on the `KEEPER_RETRY_STRANDED_MS` timer, simulated first; `claim_stranded` once, `strand_retry_failed` while it reverts, `strand_recovered` when it lands |
| `Idle` | flat, capacity > 0 | window = next NYSE Friday 16:00 ET (+24 h expiry); vol mode: fetch the Cboe chain once; strike = the target-delta call clamped into the buffered band (fixed mode: `round(spot × 1.05)`); option id = `keccak(tuple)`; `clear.tokenType(id)`: reuse if it exists, else `clear.newOptionType(asset, 1e18, usdg, strike, exercise, expiry)`; `rollOpen(id)` (arms only); then `approveListing` at capacity in the same tick |
| `Idle` | anything refuses the arm (halted, no role, fee on and not accepted, oracle paused or stale, strike outside the band, no capacity, market data missing / stale / inconsistent) | write nothing; remember the reason; `cycle_not_created` when the Friday goes by (and at once, per reason, for a stale oracle or a `vol-*` reason) |
| `Listed` | every tick | `contractsWritten` (== sold) and Seaport's fill fraction: publish each fill; mirror the fill gate at live spot (`fillVerdict`) and **reprice** (cancel + approve, within the vault's three) when the ask fell under the fill floor — in vol mode only after the replacement has been priced, on one fresh fetch or the previous listing's fair value; in vol mode also **reprice up** a still-fillable listing the market has left more than `KEEPER_VOL_REPRICE_UP_BPS` behind, keeping one slot in reserve; alert `fill_sim_revert` when it cannot (strike under the band floor, budget spent, stale feed, no price for the replacement, no spare slot to reprice up) |
| `Listed` | the listing sold out and deposits added capacity | cancel the filled order and list the remainder, within the three |
| `Listed` | `listingHash == 0` (a guardian `cancelListing` / `invalidateAllListings`) | retire every still-offered row of the cycle (`cancelled`, or `filled` if Seaport says so) so `/orders` stops serving it, then relist within the three |
| `Listed` | `now >= cycleExerciseTs` | `lockBook()` (permissionless) |
| `Listed` / `Exercisable` | `now >= cycleExpiryTs` | `rollClose()` — redeem, harvest, settle the queue; a `ClaimStranded` in the receipt is the stranded path |

Every transaction is **simulated first**, then sent, then waited on, then written to SQLite.
Nothing is fired and forgotten.

### Choosing the week

Read `vault.policy()` — nothing is hardcoded, so an admin policy change takes effect without a
keeper deploy. Then:

```
window     = next NYSE Friday 16:00 America/New_York (DST-correct; Thursday on a Friday holiday),
             at least KEEPER_ARM_LEAD_S away, else the Friday after; expiry = exercise + 24 h
band       = [spot * (1 + minOtmBps/1e4), spot * (1 + maxOtmBps/1e4)]   (floor division, as on chain)
strike     fixed: round(spot * (1 + KEEPER_STRIKE_OTM_BPS/1e4)) to a whole USDG, inside the band
           vol:   the KEEPER_TARGET_DELTA strike of the listed calls expiring on the close day
                  (linear between the bracketing strikes), * tokenSpot / shareSpot, whole USDG
                  half up, clamped into [ceil(spot * (1 + (minOtmBps + KEEPER_STRIKE_BAND_BUFFER_BPS)/1e4)),
                  floor(spot * (1 + (maxOtmBps - 50)/1e4))] and checked against the band again; an
                  unclamped strike whose Cboe delta is more than 0.05 from the target skips
optionId   = uint256(uint160(bytes20(keccak256(abi.encode(asset, 1e18, usdg, strike, exercise, expiry))))) << 96
capacity   = min(floor(totalAssets * maxUtilizationBps / 1e4 / 1e18), maxContractsCap) - contractsWritten
floorUnit  = ceil((spot * N * minPremiumBps / 1e4 + engineFee(N) * spot / 1e18) / N)
             (the engine fee term only while Valorem's fee switch is on)
marginUnit = ceil(floorUnit * (10000 + KEEPER_PREMIUM_MARGIN_BPS) / 10000)
unitPrice  fixed: marginUnit
           vol:   max(marginUnit, ceil(fair * (10000 + KEEPER_PRICE_EDGE_BPS) / 10000)), where fair is
                  the listed mid interpolated at strike * shareSpot / tokenSpot, * tokenSpot / shareSpot,
                  rounded UP to a base unit
           both:  never above the strike; KEEPER_UNIT_PRICE_USDG6 replaces it, lifted to floorUnit
                  (fixed), or raises it and never lowers it (vol)
gross      = unitPrice * N                            (so gross % N == 0, and a partial fill of k pays k * unitPrice)
```

The vault re-checks every one of these at the arm (`StrikeBelowBand` / `StrikeAboveBand`,
`ExerciseTooSoon`, `BadCycleWindow`, `UnexpectedLotSize`…), at the approval (`OfferExceedsCapacity`,
`PremiumNotDivisibleByOrderSize`, `UnitPriceExceedsStrike`, `ListingOutlivesExercise`,
`BadCounter`…) and at **every fill** (`PremiumBelowFloorAtFill`, `StrikeBelowBand`,
`WriteWindowClosed`, `ContractsAboveUtilization`…). `policy.ts` mirrors the maths integer for
integer so a refusal is a computed decision, not a revert on Friday.

If the strike would fall outside the band, or there is no capacity, the keeper writes nothing and
says so. That is a legitimate outcome and it stays one all week: the keeper keeps re-evaluating
until the Friday goes by.

#### Market data (vol mode)

`vol.ts` reads Cboe's free delayed chain, `GET https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json`,
once per decision (an arm and its first listing share one fetch; a reprice makes one), never
more often than every five minutes (`VOL_MIN_REFETCH_MS`: a keeper declining a week tick after tick
reuses the last answer or failure instead of pulling ~1.9 MB from Cboe every poll; freshness is
still judged on the chain's own clocks at each use), and treats it as untrusted: https only, one deadline, a streamed byte cap, same-host redirects only, strict
UTF-8 and a schema over only the fields it reads. Option symbols are `NVDA` + `YYMMDD` + `C|P` +
strike × 1000 in 8 digits; prices are per share.

The feed's two clocks are undocumented and were measured on 2026-09-15: the top-level
`timestamp` is **UTC**, the time Cboe generated the file (NVDA's read `2026-09-15 05:57:42` against
an HTTP `Last-Modified` of `05:57:45 GMT`; TSLA, AAPL and `_SPX` matched their own `Last-Modified`
within seconds too), and `data.last_trade_time` is the **New York** wall clock of the underlying's
last trade (`15:59:59` for stocks, `16:14:59` for `_SPX`). The chain is fresh when both are within
`KEEPER_VOL_MAX_AGE_S` of the head block, neither is in the future, the last trade is not newer
than the file (an hour of skew tolerated), and the last trade belongs to the latest NYSE session
that has closed: the latest weekday outside `KEEPER_NYSE_HOLIDAYS` whose 16:00 ET close is at
least 12 hours old, less 4 hours for early closes. Cboe regenerates each ticker's file on its own
schedule, so a stuck file is stale on a Saturday arm even when Wednesday's close is only 72 hours
old.

The chain must be for `KEEPER_VOL_ROOT`, and at most half its option rows may fail to parse (more
is a changed feed format: `vol-inconsistent` with the count and the first failing field, not
`vol-no-expiry`). Only the calls whose expiry is exactly the cycle's close day are used (a holiday
Thursday close needs a Thursday listing; there is no interpolation across expiries). A quote is
usable when `bid > 0`, `ask ≥ bid`, both under 1,000,000, `0 < delta < 1`, iv is finite, and the
spread is at most `max(0.05, 30% of mid)`. Where the keeper interpolates (the delta bracket, and
the price bracket at the armed strike) the chain must also be sane: the call deltas cross the
target once, downwards; the two bracketing strikes are at most `max(2.5, 2.5% of the lower
strike)` apart; and across those quotes and one neighbour each side the delta does not rise with
the strike, no higher strike is bid above a lower strike's ask, and no call is bid above the
strike-weighted asks of its neighbours (both would be free money in the quotes, which a real
market does not offer). Every refusal is a named skip, remembered and alerted:

| Reason | Meaning |
|---|---|
| `vol-unavailable` | the fetch failed (timeout, HTTP status, redirect, oversize, bad JSON or shape); the error is in the alert |
| `vol-stale` | the last trade or the file is older than `KEEPER_VOL_MAX_AGE_S`, or the last trade predates the latest settled NYSE session |
| `vol-inconsistent` | a clock does not parse, the file is dated in the future, the last trade is newer than the file, the chain is for another root, most rows do not parse, the strike grid is gapped or the quotes around the bracket are non-monotone or arbitrageable, the armed delta is far from the target, or the data could not be evaluated at all; `data.why` says which |
| `vol-no-expiry` | no listed call expires on the close day |
| `vol-no-quotes` | fewer than two usable quotes on that expiry |
| `vol-spot-divergence` | the vault's token spot and the feed's share spot differ by more than `KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS` |
| `vol-delta-out-of-range` | the target delta is outside the quoted deltas (never extrapolated) |
| `vol-strike-unquoted` | the armed strike maps outside the quoted strikes, so there is no fair value |

A reprice (the strike is fixed all week) prices at the armed strike on fresh data when it has it;
without it, at `max(marginUnit, ceil(previousFair × (1 + edge)))` using the fair value stored with
the cycle's previous listing (or, for the cycle's first listing, the arm's), so a reprice never
undercuts the last market-based ask. With neither, the live listing is left in place rather than
cancelled for a relist that cannot be priced.

A floor reprice only fires when the ask falls under the vault's floor, and after a rally the fair
value at the armed strike rises far faster than that floor. So in vol mode a listing that is still
fillable is also checked against fresh data at most every 30 minutes, and cancelled and relisted
at the market when the market-based ask is more than `KEEPER_VOL_REPRICE_UP_BPS` above it, as long
as a slot would still remain for a floor reprice. Stale or unusable data never moves an ask up.

Every listing stores its pricing record (`listings.pricing_json`; the arm's is on
`cycles.pricing_json`), and `/orders` (per order) and `/state` (the live cycle's latest listing;
`null` while the vault is Idle, so a closed or skipped week's figures never read as current) serve
it as `pricing`:

```json
{
  "mode": "vol", "source": "cboe-delayed", "priceSource": "vol-fair", "volPath": "fresh",
  "volUnavailableReason": null, "targetDelta": 0.15, "deltaAtStrike": 0.1464, "ivAtStrike": 0.3266,
  "strikeUsdg6": "225000000", "strikeOtmBps": 602, "deltaStrikeUsdg6": "225000000",
  "strikeClamped": null, "bandBufferBps": 200,
  "fairUnit6": "860864", "volUnit6": "946951", "floorUnit6": "848840", "marginUnit6": "857329",
  "unitPrice6": "946951", "edgeBps": 1000, "marginBps": 100,
  "shareSpot": 212.0404, "tokenSpot": 212.21, "spotUsdg6": "212210000",
  "expiry": "2026-09-25", "chainTimestamp": "2026-09-15 05:57:42", "lastTradeTime": "2026-09-14T15:59:59"
}
```

`priceSource` is `fill-floor` (the floor with the margin was binding), `vol-fair`,
`vol-previous-fair` or `manual-override`; `strikeClamped` is `null`, `band-floor` or
`band-ceiling`. The record is order figures only, nothing annualised and nothing framed as a
return. Rows written before the column existed serve `pricing: null`. The fork dry runs pin
`KEEPER_PRICING_MODE=fixed`: their clock is warped weeks ahead, where no live chain lists the
fork's expiries.

### The listing and `/orders`

The order is a Seaport 1.6 **`PARTIAL_RESTRICTED`** order (`orderType 3`) whose offerer AND zone
are the vault: Seaport calls the vault's `authorizeOrder` before any transfer of a restricted
order, and that hook writes exactly the filled contracts into Valorem, so the tokens Seaport then
moves to the buyer were minted in the same call. `zoneHash 0`, `conduitKey vault.conduitKey()`
(zero), `startTime 0`, `endTime == cycleExerciseTs`, a random 256-bit salt, the counter read live
from `seaport.getCounter(vault)` (a bump is quasi-random, never `+1`), ONE ERC-1155 offer item
(the Clear, the armed option id, N contracts) and ONE ERC-20 consideration item (USDG,
`unitPrice × N`, recipient the vault). **The signature is empty.** The vault has no signing key
and no EIP-1271 hook; `approveListing` calls `seaport.validate()` and Seaport skips signature
verification for a validated order on every later fill.

`GET /orders` serves every listing the vault currently authorises, one entry per order:

```json
{
  "orders": [
    {
      "orderHash": "0x…",
      "chainId": 4663,
      "seaport": "0x0000000000000068F116a894984e2DB1123eB395",
      "vault": "0x…",
      "optionId": "7303991185649978700925346618953552234032347613125769741146061281471184135782",
      "contracts": "23",
      "filledContracts": "2",
      "remainingContracts": "21",
      "unitPrice6": "856189",
      "grossUsdg6": "19692347",
      "endTime": 1789761600,
      "status": "partial",
      "parameters": {
        "offerer": "0x<vault>", "zone": "0x<vault>",
        "offer": [{ "itemType": 3, "token": "0x<clear>", "identifierOrCriteria": "<optionId>", "startAmount": "23", "endAmount": "23" }],
        "consideration": [{ "itemType": 1, "token": "0x<usdg>", "identifierOrCriteria": "0", "startAmount": "19692347", "endAmount": "19692347", "recipient": "0x<vault>" }],
        "orderType": 3, "startTime": "0", "endTime": "1789761600",
        "zoneHash": "0x00…00", "salt": "<256-bit decimal>", "conduitKey": "0x00…00",
        "totalOriginalConsiderationItems": "1"
      },
      "signature": "0x",
      "pricing": { "mode": "vol", "unitPrice6": "856189", "…": "see Market data (vol mode)" }
    }
  ]
}
```

`parameters` is Seaport's `OrderParameters` (the components with the counter dropped and
`totalOriginalConsiderationItems` appended): what a buyer passes to `fulfillAdvancedOrder(
{parameters, numerator: k, denominator: contracts, signature: "0x", extraData: "0x"}, [], 0x0,
recipient)` after approving `k × unitPrice6` USDG to Seaport. The web fill route re-reads the
counter from Seaport, rebuilds the hash, and serves the order only if it is the vault's
`listingHash`. `status` is `approved` (untouched) or `partial`; a row past its `endTime` or in a
terminal state is never served.

### Closing the week: what gets published

`rollClose()` is one transaction that redeems the claim, harvests, settles the queue and returns
the vault to `Idle`. Two numbers come out of it and both are easy to get wrong:

**Contracts assigned** is read **before** the transaction is sent. `rollClose` redeems the claim,
which zeroes `claimKey`, and Valorem's `claim()` then reverts `TokenNotFound` — so the same read
taken afterwards answers `0` and every assigned week would be published as unassigned. The vault
emits the number in `RollClose(cycleNumber, assetsReturned, usdgFromAssignment,
contractsAssignedCount)`; the keeper publishes the event (`resolveContractsAssigned`) and keeps its
own pre-close read as the fallback for a receipt with no `RollClose` and as a cross-check when
there is one. A pre-close read that fails is `null`, "unknown", never a silent 0.

**The harvest is summed over the whole cycle, not read off the `rollClose` receipt.** The vault
calls `_checkpointHarvest()` inside `deposit()` and `mint()`, and deposits are open during
`Listed`. So a buyer fills on Tuesday, somebody deposits on Wednesday, that deposit sweeps the
premium into the per-share index and emits `Harvest(cycle, gross, fee, net)` right then — and
Friday's `rollClose` receipt carries a `Harvest` with only the strike proceeds. Every `Harvest` is
tagged with the indexed cycle number (a stranded cycle's retry included), so the keeper sums the
cycle's logs from the `rollOpen` block to the close (over the primary archive RPC).

**On an assigned week the gross is not all premium.** The strike proceeds (`RollClose.
usdgFromAssignment`) are returned principal and fee-free: the vault's fee is `floor((gross −
usdgFromAssignment) × bps / 10000)`. Both close paths — the keeper's own `rollClose` and the boot
reconciliation of a close someone else ran — record `assets_returned` and `usdg_from_assignment`
on the cycle row; `GET /cycles` serves them plus `premium_gross_usdg6` and
`strike_proceeds_usdg6`. The `roll_close` alert names the two separately:

```
cycle 2 closed: premium 4.280945 USDG (fee 0.214047), strike proceeds 446 USDG from 2 contracts assigned; 450.066898 USDG to depositors.
```

Unfilled (`closed unfilled: 0 USDG harvested.`) and unassigned weeks keep their wording; a
stranded close appends `The claim could NOT be redeemed and is stranded: its legs are paid by
retryStrandedClaim.` and the row's status is `stranded` until the retry lands, when its
`retry_tx`, `assets_returned` and `usdg_from_assignment` are filled from `StrandedClaimRecovered`.

Both closing paths also retire every still-live listing row for the cycle. `rollClose` and
`lockBook` kill orders by bumping the Seaport counter, which does **not** set `isCancelled`, so
polling `getOrderStatus` would never retire them and `/orders` would go on offering a buyer an
order Seaport now rejects. `/orders` additionally refuses to serve anything past its `endTime`.

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
a 200, and they page through the alert webhook as `low_gas` and `rpc_lag`. A stranded claim is
neither: `/health` stays `ok` and `/state` says `stranded: true`.

`/health` and `/state` report the phase from the pre-tick snapshot, so a phase change lands up
to one poll interval late. RPC endpoints are reported origin-only: the port is unauthenticated
and production RPC URLs routinely embed keys.

## Logs

JSON lines from pino, one per event, with a `mod` field naming the subsystem: `roll` (the state
machine), `policy` (policy reads and the week's plan), `seaport` (order building and Seaport
chain reads — `debug` only, so silent at the default `info`), `state` (the SQLite store),
`alerts`, `health`, `boot`. bigints are stringified by the serialiser, so the lines are safe to
ship as JSON. `KEEPER_LOG_LEVEL=debug` turns on the per-tick chain-read lines; they are noisy on
purpose and should not run in production.

## Alerts

Delivered as a JSON `POST` to `ALERT_WEBHOOK`, logged at severity, and stored in SQLite either
way. Repeats of the same kind are suppressed for `KEEPER_ALERT_COOLDOWN_MS`; a condition clearing
resets the suppression so the next occurrence alerts immediately. `alerts.ts` (`AlertKind`) is the
source of truth for the names; `ops/alerts.md` is the runbook for them.

| Kind | Severity | What it means and what to do |
|---|---|---|
| `tx_revert` | error | A simulation or a receipt came back reverted. The message carries the decoded custom error and its arguments — `rollOpen would revert: … StrikeBelowBand(226000000, 231750000)` — for every error the vault and its two linked libraries can throw. Nothing was sent if it was a simulation. |
| `cycle_not_created` | warn | A Friday passed without the vault being armed; `data.reason` says why (`strike-outside-band`, `no-capacity`, `writes-halted`, `no-keeper-role`, `valorem-fees-enabled`, `oracle-paused`, `stale-oracle: …`, `option-type-failed`, `rollOpen-would-revert`, and in vol mode `vol-unavailable`, `vol-stale`, `vol-inconsistent`, `vol-no-expiry`, `vol-no-quotes`, `vol-spot-divergence`, `vol-delta-out-of-range`, `vol-strike-unquoted`). The `stale-oracle` and `vol-*` variants page while the week can still be saved (once per reason per week, then the cooldown). An honest skipped week: unfilled, 0. |
| `option_type_failed` | error | `clear.newOptionType` would revert, did not confirm, or its `NewOptionType` log did not name the id the keeper derived. The week cannot be armed. |
| `fill_sim_revert` | warn | The live listing would be refused at the fill gate and the keeper cannot or may not reprice: the strike is under the band floor after a rally (no price fixes it), the vault's three listings are spent, the feed is stale, or (vol mode) the replacement cannot be priced, in which case the live listing is left in place. Also raised when vol mode cannot price a listing at all (`vol-*` reason; retried each tick), and when a listing the market has left behind cannot be repriced up without spending the slot kept for a floor reprice (`reprice-up-no-slot`). Also: the vault authorises a hash this keeper has no row for (it invalidates it and relists), or has not approved Seaport to move its tokens. |
| `claim_stranded` | error, forced | `rollClose` could not redeem the Valorem claim (USDG paused/frozen, NVDA blocklist). The vault is Idle with the claim kept; deposits and instant redemption are shut; the keeper retries on `KEEPER_RETRY_STRANDED_MS`. `ops/runbooks/incident.md` §9. |
| `strand_retry_failed` | warn | `retryStrandedClaim` still reverts (`StillStranded`); the cause has not cleared. |
| `strand_recovered` | info, forced | The retry went through; both legs are home and the cycle row is closed. |
| `oracle_paused` | warn | The Stock Token halted its own oracle. The vault will refuse to arm and to fill. |
| `valorem_fees_enabled` | warn | Valorem's 15 bps **notional** engine fee is on and governance has not accepted it. The vault stops arming and filling until an admin calls `acceptValoremFee(true)`. |
| `fee_switch` | warn, forced | `FeeSwitchUpdated` on the Clear: the switch moved, in either direction. |
| `low_gas` | warn | Keeper ETH under `KEEPER_MIN_GAS_WEI`. Top it up. |
| `rpc_lag` | warn | Head block trails the wall clock by over `KEEPER_RPC_LAG_ALERT_MS`, or both RPCs are unreachable. |
| `phase_stuck` | error | The vault is still not `Idle` more than an hour after expiry, by the head block's clock. **Anyone can call `rollClose()` now.** |
| `keeper_error` | error | An unhandled error inside a tick. The loop keeps running; the next tick re-reads everything from chain. |
| `boot` / `roll_open` / `listing` / `fill` / `queue_settled` / `roll_close` | info, forced | State changes, always delivered, never suppressed. `boot` also has a **warn** variant — the keeper lacks `KEEPER_ROLE` and can close but not open. |

---

## Restart safety

The keeper may be killed at any instant, including between `approveListing()` landing on chain
and the row being written. On boot it does not trust its database:

1. Reads the vault's wiring (`asset`, `usdg`, `clear`, `seaport`, `conduitKey`, `seaportZone`)
   and **refuses to start** if any of it disagrees with the environment. Creating option types on
   the wrong clearinghouse arms nothing.
2. Checks that the vault has approved Seaport to move its option tokens, and that the keeper
   holds `KEEPER_ROLE`. Missing role is a warning, not a failure — `lockBook`, `settleQueue` and
   `retryStrandedClaim` are permissionless and `rollClose` opens to everyone an hour after expiry.
3. Resolves every transaction it had recorded as pending against its receipt.
4. Adopts an open cycle it has no row for — the "died right after `rollOpen`" case — and closes
   out, from the chain's own logs, a cycle whose `rollClose` (or `retryStrandedClaim`) it never
   witnessed.
5. Refreshes every non-terminal listing from `seaport.getOrderStatus`.

A cycle with a row in `cycles` is never rewritten. Listings are keyed by order hash. `docker
restart` mid-week is a non-event.

---

## When the keeper is dead

This is the case the design is built around, so nothing about it is dramatic.

**Options still expire on their own.** Valorem is not waiting for us. A call that is out of the
money at the Saturday expiry simply becomes worthless, and the collateral stays where it is —
inside the vault's claim.

**A live listing keeps filling on its own terms.** The vault's hook, not the keeper, writes and
prices every fill. With the keeper down the fill page has no payload to show; anyone who saved
the payload can still fill through Seaport directly.

**`lockBook()` is permissionless** once `cycleExerciseTs` has passed. It only moves `Listed →
Exercisable` and kills any listing still live.

**`rollClose()` opens to everyone an hour after expiry.** It redeems the claim, harvests the
premium, settles the redeem queue and returns the vault to `Idle`, all in one transaction, and a
redeem the token issuers refuse strands the claim instead of failing the close. **`settleQueue()`
and `retryStrandedClaim()` are permissionless too.** The guardian does not need the keeper's key,
its database, or its order components:

```bash
cast send $VAULT "rollClose()"             --rpc-url $RH_RPC --private-key <any funded key>   # from expiry + 1h
cast send $VAULT "settleQueue()"           --rpc-url $RH_RPC --private-key <any funded key>   # Idle, shares queued
cast send $VAULT "retryStrandedClaim()"    --rpc-url $RH_RPC --private-key <any funded key>   # while isStranded()
```

**The guardian can kill listings without any keeper state.** `invalidateAllListings()` bumps the
vault's Seaport counter, which invalidates every outstanding order at once and needs no order data:

```bash
cast send $VAULT "invalidateAllListings()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
cast send $VAULT "haltWrites()"            --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```

**Depositors are never trapped.** `queueRedeem`, `settleQueue`, `completeRedeem` and `claimUsdg`
are never blocked by a halt, by the phase, or by the keeper being down. The worst case of a dead
keeper is a week with no premium, published as **unfilled, 0**.

### Restarting after a death mid-week

Just start it. Reconciliation adopts whatever state the vault is in. If anyone already called
`rollClose`, the keeper sees `Idle` and closes the row from logs. If the vault is still `Listed`,
it picks the listing back up from `seaport.getOrderStatus` and carries on.

---

## Files

| File | What it holds |
|---|---|
| `config.ts` | zod-validated environment. Exits with the full problem list on anything malformed. |
| `abi.ts` | viem `as const` ABI fragments: Vault (write on fill: `rollOpen(optionId)`, the Seaport zone hooks, the stranded-claim views, every error of Vault + its linked libraries), Valorem Clear (incl. `newOptionType`), Seaport 1.6, ERC-20, Stock Token. Transcribed from `ops/abis` and `contracts/out`; cross-checked against the artefacts by `abi.test.ts`. |
| `clients.ts` | Three viem clients: reads (both RPCs, `fallback`), logs (primary only), writes (primary only). |
| `state.ts` | SQLite: cycles, listings, transactions, alerts, heartbeat. 256-bit values are stored as decimal TEXT — an optionId does not fit in a SQLite INTEGER. |
| `calendar.ts` | The weekly clock: the next NYSE Friday 16:00 ET, DST-correct, holidays, the arm lead. |
| `optionType.ts` | The week's Valorem tuple and its id before it exists; the whole-USDG strike. |
| `policy.ts` | The strike, the capacity, the fill floor (fee valued at spot), the margin and the fill-gate mirror, integer for integer with `Policy.sol` / `ValoremLib.sol`. |
| `seaport.ts` | Order construction in exactly the shape `SeaportOrderLib` authorises, local hash derivation, Seaport reads. |
| `roll.ts` | The state machine, the transaction plumbing, the stranded-claim handling, and the boot reconciliation. |
| `health.ts` | `/health`, `/state`, `/orders`, `/cycles`. |
| `vol.ts` | Cboe delayed option chain: the hardened fetch, parsing, freshness, expiry and quote selection, strike by delta, fair value by strike. |
| `alerts.ts` | Webhook alerting with per-kind cooldown. |
| `index.ts` | Wiring, the poll loop, graceful shutdown. |
| `dryrun.ts` | The production keeper driven through three weeks against an anvil fork (unfilled; filled + exercised; stranded by a USDG freeze and recovered) and a fourth arm, with assertions. `DRYRUN.md` is the recorded run. |
| `dryrun-extended.ts` | The scenarios the three-week run does not reach: the compiled `index.ts` process under SIGTERM mid-tick, partial fills / a guardian cancel / a reprice after a rally / refused fills / the listing budget, several exercisers, an anyone-`rollClose` reconciled from logs, and Valorem's fee switch on and accepted. |
| `dryrun-common.ts` | What both harnesses share: chain constants, derived actors, anvil RPC, storage-written balances, the linked deploy from `contracts/out`, the USDG freeze, a buyer's fill and exercise, the fill simulation, the alert capture, the report writer. |
| `*.test.ts` | Unit tests, next to the module each one pins. `pnpm test`. |
| `Dockerfile`, `railway.json` | The container, built from the repo root, and the Railway config-as-code. Runbook: `ops/deploy.md`. |
| `deploy/callhouse-keeper.service` | The systemd alternative. |
