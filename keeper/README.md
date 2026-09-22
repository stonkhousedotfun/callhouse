# Stonkhouse keeper

The weekly roll, as a single Node 22 process. One market per process: the pooled vault (`VAULT`),
one isolated-account factory (`FACTORY`), or both for the transition. Every new market is a
factory-only process ("Factory-only mode" below); the pooled vault is closed.

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
| `health.solo.test.ts` | the surface of a process with NO `VAULT`: `/` and `/health` name the factory and the market with `vault: null`, `/orders` is an empty book with a note, `/state` is a 503 that names the market before the first tick |
| `feed.test.ts` | the Chainlink read pinned to `Policy.normalizeSpot` / `ValoremLib.spotUsdg`: 8 dp → 6 dp by integer division on the real NVDA and TSLA prints, 18 / 6 / 4 dp, zero and negative answers refused, round 0 refused, stale at `maxPriceAge` inclusive |
| `solo.winddown.test.ts` | v1 run-off through the real solo tick: no `setWeek`, no `listFor`, every expired account settled, `v1_drained` once per factory across restarts; the settle guard in both modes: its one multicall (`claimKey` plus USDG `paused`/`isFrozen`, the Stock Token's `paused` and its registry's `isBlocked`, for the account and the Clear), each shut gate holding every sold account it touches with `v1_settle_held` once per account, a failed read (a gate, the registry address, `claimKey`, the whole multicall) holding rather than passing, `claimKey == 0` settling regardless, the hold lifted and the account settled once the gate opens; and the registry `v1RunOff` flag through `ops/keeper-env.sh` into the config |
| `solo.test.ts` | the factory week (`planSoloWeek`): the fixed strike rounds DOWN and must sit in the factory's band (GME at 21.42 with 5% is skipped, 8% is not), the ask is the one-lot fill floor with the margin from the factory's `minPremiumBps`, `KEEPER_MIN_ASK_USDG6` lifts it (`min-ask`) and is capped at the strike, vol mode lands on the pooled figures for one lot (225 / 0.946951 on the fixture), every `vol-*` reason skips and never falls back to fixed, and solo.ts loads without a `VAULT` |

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
| `VAULT` **or** `FACTORY` | At least one. `VAULT` is the pooled vault (closed; its keeper runs `WIND_DOWN`). `FACTORY` is an isolated-account factory (`contracts/src/solo/AccountFactory.sol`): one process per market. With only `FACTORY` set, nothing in `roll.ts` runs ("Factory-only mode" below). Neither set is a boot failure that names both. |
| `KEEPER_PK` | The hot key. Needs gas and `KEEPER_ROLE` on the vault or the factory. Keep ~0.05 ETH on it. One key per market (`ops/markets/derive-keeper-keys.sh`). |

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
`seaport`, `conduitKey`, `seaportZone == VAULT`). A mismatch is fatal. A factory is cross-checked
the same way (`asset`, `priceFeed`, `usdg`, `clear`, `seaport`); see the next section.

### Factory-only mode

Every market but the closed pooled vault is a factory: one `AccountFactory`, its `WriterAccount`
clones, one keeper process, one hot key, one Railway service (`ops/keeper/markets/README.md`).
The environment for each is rendered from the registry by `ops/keeper-env.sh` into
`ops/keeper/markets/<TICKER>.env`; these are the keys that matter to it, on top of the shared ones
above and the pricing keys below, which the factory path reuses unchanged.

| Key | Default | Notes |
|---|---|---|
| `FACTORY` | — | The factory this process drives. Its `asset()`, `priceFeed()`, `usdg()`, `clear()` and `seaport()` are compared with `ASSET`, `PRICE_FEED`, `USDG`, `CLEARINGHOUSE`, `SEAPORT` at boot; a mismatch exits 1. A keeper without `KEEPER_ROLE` on it alerts `keeper_role` and keeps running: `settle()` is permissionless, `setWeek`/`listFor` are not. |
| `PRICE_FEED` | `0x379E…9F15` (NVDA) | The Chainlink proxy the factory prices against. The solo path reads `latestRoundData()` itself (there is no `vault.spotUsdg()` to ask), refuses a round older than `factory.maxPriceAge()` at the head block's clock, and normalises exactly like `Policy.normalizeSpot` (`feed.ts`). The default keeps the live NVDA keeper's env unchanged; every other market sets its own. |
| `KEEPER_MIN_ASK_USDG6` | `1000000` (1 USDG) | The week's ask is never below this, whatever the fill floor says. The default is the floor the first factory keeper hard-coded, kept so NVDA's behaviour does not change with the key's arrival; it is 4% a week on a $25 token, so the registry sets `100000` (0.10 USDG) per market and the env generator writes that. Capped at the strike (`setWeek` reverts `AskAboveStrike`). `0` switches it off. |
| `SOLO_WIND_DOWN` | unset (off) | v1 run-off (ADR-10), for a factory the owner has frozen (`writesHalted`, `depositCap` 0). `1`/`true`: the tick never calls `setWeek` or `listFor`, still settles every expired account and raises `low_gas` / `rpc_lag` / `oracle_paused`, and alerts `v1_drained` once when `liveCount() == 0 && pendingCount() == 0` (remembered in SQLite, so a restart does not repeat it). `/health` and `/state` show `windDown: true`; `/state` has `nextWeek: null` and `drainedAt`. As in every factory tick, a sold account's `settle()` is held while USDG or the Stock Token would refuse its redeem (the settle guard below, alert `v1_settle_held`). `0`/`false`/unset: off. Any other value is refused at boot. Rendered from the registry's `v1RunOff`. |
| `KEEPER_MARKET` | `NVDA` | A label: the registry ticker (`^[A-Z0-9.]{1,8}$`). On every log line, every alert payload (`market`, beside `factory` and `vault`), `/health` and `/state`, so 35 keepers behind one relay can be told apart. Read by no pricing decision. |

**How a factory week is priced** (`src/solo.ts` header has the long version). Once a week, when
the factory has no week or the current one's base expiry has passed, the keeper calls
`setWeek(strike, exerciseTs, baseExpiryTs, ask)` with the next NYSE Friday window
(`KEEPER_ARM_LEAD_S`, the same clock as the vault). Every account then lists every lot at that
one strike and that one ask all week; there is no per-account price and no reprice. The numbers
come from `factory.policy()` (band, premium floor; never hard-coded) and the feed:

- **fixed**: strike = spot + `KEEPER_STRIKE_OTM_BPS` rounded **down** to a whole USDG, refused
  (`strike-outside-band`) unless inside `[spot × (1 + minOtm), spot × (1 + maxOtm)]`. On a token
  under ~25 USDG a 5% strike rounded down lands under a 3% floor; tune the registry's
  `strikeOtmBps`, not the keeper.
- **vol**: the pooled machinery for ONE contract: the chain for the close day (throttled by
  `VOL_MIN_REFETCH_MS`), the `KEEPER_TARGET_DELTA` strike clamped into the buffered band, the fair
  value at that strike lifted by `KEEPER_PRICE_EDGE_BPS`. Any `vol-*` reason skips the week,
  alerts once per (week, reason) across restarts, retries next tick, never falls back to fixed.
- **ask**: `max(one-lot fill floor with KEEPER_PREMIUM_MARGIN_BPS, vol fair value with the edge)`,
  then lifted to `KEEPER_MIN_ASK_USDG6` (`min-ask`), then capped at the strike.

Every tick between weeks: `listFor(owner)` for each pending account (simulated first; a
reverting one is logged and skipped, not sent 25 times), nothing while `factory.writesHalted()`,
nothing inside the last hour before the close; `settle()` for each live account past its expiry.
The last pricing record and the last skip reason are in the meta table and served by `/state`
(`lastPricing`, `lastSkipReason`).

**The settle guard** (every factory tick, run-off or not). `settle()` redeems a sold account's
Valorem claim with a caught call; if the issuers refuse that redeem, `settle()` still completes,
zeroes `listedExpiryTs` and keeps the claim for good (a second `settle()` reverts `TooEarly`, and
the account has no other redeem). So before it simulates `settle()` for an expired account, the
keeper reads, in **one multicall**, `claimKey()` on the account and the six gates of `settle_safe`
(`ops/runbooks/v1-runoff.md` step 8): USDG `paused()`, USDG `isFrozen(account)`, USDG
`isFrozen(CLEARINGHOUSE)`, `ASSET.paused()`, and `isBlocked(account)` / `isBlocked(CLEARINGHOUSE)`
on the Stock Token's `ACCESS_CONTROLLED_REGISTRY()` (read once per tick). With `claimKey() != 0`
and any gate true, or any read failed (a failed read is never taken as open), nothing is sent for
that account: alert `v1_settle_held` once per account per reason, and `/state` lists it under
`settleHeld` (`account`, `claimKey`, `listedExpiryTs`, `reasons`, `since`). It settles on the first
tick every read is false again, and the alert state is cleared. An account with `claimKey() == 0`
sold nothing, has no redeem, and settles regardless. Holds are kept in memory: a restart re-reads
the gates and says each hold once more.

**The per-market dry run** (`solo:quote`) prints what the keeper would set right now, from the
real feed, the real factory policy (or the launch defaults with `--factory none`, for a market
whose factory is not deployed) and, in vol mode, the real Cboe chain. It sends nothing and needs
no role; with no `KEEPER_PK` in the environment it uses the dry-run harness's throwaway key.

```bash
KEEPER_ENV_FILE=../ops/keeper/markets/NVDA.env pnpm solo:quote                  # live: factory.policy()
KEEPER_ENV_FILE=../ops/keeper/markets/TSLA.env pnpm solo:quote --factory none   # planned: launch defaults
KEEPER_ENV_FILE=../ops/keeper/markets/SGOV.env pnpm solo:quote --factory none   # fixed mode: no Cboe
pnpm solo:quote --mode fixed --json                                             # override the mode, machine-readable
```

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
| `ALERT_WEBHOOK_TOKEN` | — | ≥ 16 chars (v1); ≥ 32 and required with `ALERT_WEBHOOK` in the v2 modes, the relay's `RELAY_TOKEN` minimum. Sent as `authorization: Bearer <token>` with every webhook POST; the relay requires it. |
| `KEEPER_ENV_FILE` | `.env` | Alternative dotenv path. `ops/keeper/markets/<TICKER>.env` is one. |

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
| `v1_drained` | info | Factory in v1 run-off (`SOLO_WIND_DOWN`): no account is live or pending, so nothing is left to settle. Once per factory, remembered across restarts; a failed delivery is retried on the five-minute clock. The run-off is over for that market. |
| `v1_settle_held` | warn | Factory, any mode: an expired account with `claimKey() != 0` was **not** settled this tick, because its Valorem redeem would be refused and `settle()` would keep the claim for good. `data.reason`: `usdg_paused`, `usdg_frozen` (the account), `clear_usdg_frozen`, `asset_paused`, `asset_blocked` (the account), `clear_asset_blocked`, or `read_failed` (`data.failedReads` names the reads that did not answer). Once per account per reason while it holds; retried every tick; settles on the first tick every gate reads open. Do not settle that account by hand while it holds. `ops/runbooks/v1-runoff.md` step 8. |
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
its database, or its order components. A key never goes on the command line (`--private-key` puts it in the
process list for the command's lifetime): import it once into Foundry's encrypted keystore and name the account.

```bash
cast wallet import ops-any --interactive                   # once: paste the key, set a password (never echoed)
cast send $VAULT "rollClose()"             --rpc-url $RH_RPC --account ops-any   # from expiry + 1h
cast send $VAULT "settleQueue()"           --rpc-url $RH_RPC --account ops-any   # Idle, shares queued
cast send $VAULT "retryStrandedClaim()"    --rpc-url $RH_RPC --account ops-any   # while isStranded()
```

**The guardian can kill listings without any keeper state.** `invalidateAllListings()` bumps the
vault's Seaport counter, which invalidates every outstanding order at once and needs no order data:

```bash
cast wallet import guardian --interactive                  # once, on the machine that holds the guardian key
cast send $VAULT "invalidateAllListings()" --rpc-url $RH_RPC --account guardian
cast send $VAULT "haltWrites()"            --rpc-url $RH_RPC --account guardian
```

**Depositors are never trapped.** `queueRedeem`, `settleQueue`, `completeRedeem` and `claimUsdg`
are never blocked by a halt, by the phase, or by the keeper being down. The worst case of a dead
keeper is a week with no premium, published as **unfilled, 0**.

### Restarting after a death mid-week

Just start it. Reconciliation adopts whatever state the vault is in. If anyone already called
`rollClose`, the keeper sees `Idle` and closes the row from logs. If the vault is still `Listed`,
it picks the listing back up from `seaport.getOrderStatus` and carries on.

---

## v2 modes

The same image runs the Stonkhouse v2 bots. `V2_MODE` picks one; unset (or blank), the process is
the v1 keeper above, unchanged (`src/v2/index.test.ts` runs both entries and compares their
output). Everything v2 lives under `src/v2/` and imports nothing from the v1 modules, whose config
exits without `VAULT`/`FACTORY` and `KEEPER_PK`.

| `V2_MODE` | What | Key | Port | Also required | Contracts it needs |
|---|---|---|---|---|---|
| `pricing` | fair value / IV service (`src/v2/pricing/`) | none | `PRICING_PORT` 8790 | `RH_RPC` | none |
| `cranker` | permissionless lifecycle loop (K2-03, "The cranker" below) | `CRANKER_PK` | `CRANKER_PORT` 8792 | `RH_RPC`; `INDEXER_URL` optional | clearinghouse, orderBook, settlementOracle, expiryCalendar; autoRoller optional (rolls skipped without it), feeSplitter optional (distribute and buyback skipped without it) |
| `mm` | MakerVault quoter (K2-04, "The MM bot" below) | `MM_QUOTER_PK` | `MM_PORT` 8793 | `RH_RPC`, `PRICING_URL`, `MM_KILL_TOKEN`; `INDEXER_URL` accepted, unused | clearinghouse, orderBook, makerVault, accessManager |
| `pricer` | AutoRoller repricer (K2-05, "The pricer" below) | `PRICER_PK` | `PRICER_PORT` 8794 | `RH_RPC`, `PRICING_URL`; `INDEXER_URL` optional | clearinghouse, orderBook, settlementOracle, autoRoller, accessManager |

INTERFACE_VERSION 8 adds one required address: the MM bot and the pricer need `accessManager`, because
under `Managed` a target has no `hasRole` of its own and each bot reads its own role from the manager
(K8-03). Without it the pricer would not fail — it would reprice nothing for ever while reporting
healthy — so a bot that cannot find out whether it may act refuses to start instead. The cranker does not
need it, and its `feeSplitter` is optional exactly like `autoRoller`: with `V2_FEE_SPLITTER` empty the
distribute and buyback steps skip and every other step keeps running, which is what the cranker does
before the flywheel is deployed (`ops/v2/env/cranker.env`).

Markets come from `V2_REGISTRY_PATH` (default `../ops/markets/tier1.json`, resolved against this
package). The image carries the registry at `/app/ops/markets/tier1.json` (`Dockerfile`: a registry change is
an image rebuild, ops/deploy.md §15.2), and a container sets `V2_REGISTRY_PATH=/app/ops/markets/tier1.json`
(ops/v2/env). Do not mount another copy: the monitor and an image rollback read the baked one. This
image implements INTERFACE_VERSION 8, and a registry declaring any other `v2.interfaceVersion` is
refused outright at boot — including `ops/markets/v7-legacy.json`, the frozen v7 registry the v7 run-off
image reads and this one must not, because one process never serves two interface versions.
Each contract address is read from its env var when set, else from the registry. `V2_CLEARINGHOUSE`,
`V2_ORDER_BOOK`, `V2_SETTLEMENT_ORACLE`, `V2_EXPIRY_CALENDAR`, `V2_KEEPER_REWARDS`, `V2_AUTO_ROLLER`,
`V2_PAYOUT_ROUTER`, `MAKER_VAULT`, `V2_MAKER_REGISTRY`, `V2_REWARDS_DISTRIBUTOR` and
`V2_ACCESS_MANAGER` come from `v2.contracts`; `V2_FEE_SPLITTER` and `V2_BUYBACK_EXECUTOR` come from
`v2.flywheel`, which INTERFACE_VERSION 8 gave its own block because the `v2.contracts` set is closed and
counted by the deploy tooling. The registry key behind `V2_PAYOUT_ROUTER` is still `payoutAdapter`, and
`V2_PAYOUT_ADAPTER` is the deprecated v7 spelling of the variable: still read when `V2_PAYOUT_ROUTER` is
unset (a rename of ours must not break a working deployment) and never preferred, but both set to
different addresses is a boot failure naming both. A missing one is a boot failure only for a mode that
needs it, and names both places. An env var that **disagrees** with the registry is a boot failure too:
the baked registry is the release, so a variable set at an earlier one would survive the rebuild that
replaced the contract and keep the bot pointed at it. `V2_CONTRACTS_FROM_ENV=1` takes the environment on
purpose (a devnet, or an override before the registry is rebuilt); `ops/v2/env` sets no contract
address on a bot for this reason, except the flywheel pair on the cranker, which it renders empty (an
empty variable reads as unset) until the flywheel is deployed. The v1 names keep their meaning and
defaults: `RH_RPC_2`, `CHAIN_ID` (must match the registry's `shared.chainId`), `MULTICALL3`,
`KEEPER_DB_PATH` (default `./keeper-v2.db`; tables are `v2_*`), `KEEPER_LOG_LEVEL`,
`KEEPER_MIN_GAS_WEI`, `KEEPER_RPC_LAG_ALERT_MS`,
`KEEPER_ALERT_COOLDOWN_MS`, `KEEPER_TX_TIMEOUT_MS`, `ALERT_WEBHOOK`, `ALERT_WEBHOOK_TOKEN`,
`POLL_INTERVAL_MS` (floor 1000 in v2). v2 only: `KEEPER_BOOT_RETRY_MS` (300000): how long a signing mode retries a chain
it cannot read at boot, with its health server and routes (the MM kill switch) already up, before it exits 1.

| File | What it holds |
|---|---|
| `v2/config.ts` | zod env per mode; every problem (env, registry, missing contracts) in one list. |
| `v2/registry.ts` | The registry's `v2` blocks typed (02-interfaces.md §3); absent blocks tolerated; ladder and oracle parameters resolved as §3 defaults ← `v2.defaults` ← the market's `overrides`. |
| `v2/chain.ts` | Clients (as `clients.ts`), read-only typed handles over the generated `v2/abi`, chunked multicalls pinned to one block, the head block's clock, the wiring check. |
| `v2/tx.ts` | In flight? → already advanced? → simulate → worth sending? → send (tracked nonce, one at a time) → journal → wait. |
| `v2/store.ts` | SQLite: `v2_txs`, `v2_alerts`, `v2_meta`. |
| `v2/anchor.ts` | The deployment anchor: registry `v2.deployBlock` and its block hash, read once per process by the cranker, the MM bot and the pricer before they read their store. A file written for another deployment at the same addresses (a fresh devnet: `up.sh` deploys from a pinned nonce), or holding state from before anchors, is reset with a warning (rows, cursors and marks; pending journal rows marked `dropped`; the MM kill switch kept). Same anchor: the state survives restarts. No deploy block in the registry: bound on addresses alone, with a warning. |
| `v2/runtime.ts` | What a signing mode runs on, and `runSigningMode(runtime, { tick, state })`: wiring check, health server, `v2_boot`, the loop with the chain probe, gas and lag alerts, shutdown. |
| `v2/health.ts`, `v2/loop.ts`, `v2/alerts.ts`, `v2/logger.ts` | `/health` `/state` `/` with v1's 503 rule; the non-overlapping poll loop; relay alerts (`v2_*` kinds, `source: callhouse-<mode>`); pino. |
| `v2/index.ts`, `v2/mode.ts`, `v2/{cranker,mm,pricer}/main.ts` | The mode switch, exit codes and signals; the per-mode entries. |
| `v2/pricer/*` | The pricer (K2-05): `planner.ts` (band, target, threshold, cadence), `fair-client.ts` (`/fair`), `strategies.ts` (StrategySet scan ∪ indexer), `pricer.ts` (the tick, `/state`), `devnet-reprice.ts`. |
| `v2/abi/*`, `v2/seriesId.ts` | GENERATED by `scripts/gen-abis.mjs` from `ops/abis/v2` and `ops/shared/v2`. Never edited by hand. |
| `v2/fixtures/registry-*.json` | Registries before O2-01, with §3's unset block, and deployed with overrides. |
| `v2/pricing/*` | The pricing service: `chain.ts` (the provider-neutral chain contract and its quality checks), `cboe.ts` (the Cboe adapter, quote gates, chain check and cache), `surface.ts`, `fair.ts`, `provenance.ts` (internal per-price provenance), `fake-provider.ts` (deterministic test providers), `server.ts`, `main.ts`, `coverage.ts` and `coverage-main.ts` (the `v2:pricing-coverage` report). |

### Pricing data providers (K3-311)

The pricing service reads option chains only through a provider-neutral contract
(`src/v2/pricing/chain.ts` `NormalizedChain`). A data provider is an `OptionChainProvider`. Cboe's
free delayed file is the default one (`cboe.ts` `createCboeProvider`), and a paid feed (K3-308) will
be another adapter. No code after the adapter reads a provider's payload type. The contract keeps
four things apart:

- **Identity.** Each instrument as the provider states it: its own id, root, side, strike, expiry day,
  and its multiplier, exercise and settlement convention. A value the provider does not give is
  `null`. The canonical market, Stock Token (`asset`, `shared.chainId`, `verification.uiMultiplier`)
  and issuer come from the registry, and the registry has no issuer.
- **Observation.** A raw listed quote (bid, ask, sizes and its own time), the provider's greeks on
  that quote, and any provider model value (`theoretical`) in a separate field. A theoretical value
  never becomes a listed input.
- **Method.** How `fair.ts` priced the series: exact listed contract, interpolation or extrapolation.
- **Quality.** Book state (empty, one-sided, crossed; a missing side is kept apart from a zero side),
  clock ages, source disagreement, and identity or multiplier mismatch, each with its own reason code.

A clock the provider does not give stays `null` through the cache and a failed refetch. Quote age
comes only from a quote time, never from the download, the file or the underlying's last trade. A
chain is priced on its quote time when the provider gives one, otherwise on the underlying's last
trade (Cboe, unchanged). A refetch advances only `receivedAt`. An underlying price with no stated
time is reported as `underlying-age-unknown`, so that estimate is never `ready`.

The `/fair` body is unchanged. Every priced answer carries an internal `provenance` (02-interfaces.md
§5.1 shape) that `server.ts` does not serialize. It names only the listed inputs the price actually
used (matched by instrument, not by expiry, side and strike alone). Producers emit it only in the consumer-first order
of §5.1. The legacy `source` is `"cboe"` only for Cboe's own exact listed contract; the same price
from any other provider is `"model"`.

`startPricingService({ provider })` replaces the provider. `fetchChain` still replaces only the Cboe
download. Tests use `fake-provider.ts`, which serves committed fixtures with no network, credentials
or provider contact:

- `chain.test.ts` covers the pure checks;
- `fake-provider.test.ts` covers listed parity with Cboe, theoretical-only and mixed chains, frozen
  underlying with fresh quotes, unknown clocks (including an untimed underlying), refetch clocks,
  identity and multiplier mismatch, same-key decoy rows kept out of provenance, and zero versus
  unavailable.

### Short maturities, events and the expiry clock (K3-312)

A daily before the first listed expiry is priced at that listing's vol (`flat-before-first`). One
listed expiry cannot separate an earnings jump from ordinary variance. `short-maturity.ts` keeps that
point price. It adds bounds (`ivLow`/`ivHigh`, `fairLow`/`fairHigh`) and reason codes to the
internal provenance (`quality.uncertainty`, `quality.reasons`) and working to `FairQuote.diagnostics`.
The `/fair` body is unchanged, and `fixtures/pricing-parity.ts` pins the base answers.

- **Event input** is injected (`PricingService({ events })`, built by `eventCalendar`): per ticker,
  `{ date, kind, timing: 'bmo' | 'amc' | null }`, optionally with a `through` day. None is wired in
  production, and no real dates are committed. A before-first read without input for its ticker is
  `event-uncertainty`. An event between now and the first listing widens the bound up when the
  expiry includes it and down when it excludes it. A bracketed read is flagged only for a known event
  between its listings. An event realized since the chain's clock bounds any read down.
- **Policy** (`PricingSettings.shortMaturity`). These defaults are proposals, not approved limits
  (OQ-15): `maxEventVariance` 0.0144, `gapVariance` 0.0001 per overnight/weekend/holiday gap,
  `closedDayVariance` 0.000025, `termStructureMultiplier` 1, `requireEventInput` true,
  `maxRelativeIvWidth` 0.5 (above it: `model-uncertainty`), `onModelUncertainty` `bound`. `refuse`
  answers `{ fair: null, reason: "model-uncertainty" }`. A read with any of these reasons is never
  `ready`.
- **Clocks** (`expiry-clock.ts`). `yearsToExpiry` is trading time from the service clock. Listed T and
  solved vols run from the chain's pricing clock: the quote time, else Cboe's last trade. Neither
  clock uses file or download times. A series whose expiry is not after both clocks, or that has no
  regular session left, is `expired`. Early closes (`PricingSettings.earlyCloses`, none by default)
  are flagged `clock-early-close` and widen the bound. They do not change the price.

### Replaying real and synthetic chains (K3-304)

`src/v2/pricing/replay.ts` replays chains through the same `PricingService` onto the cranker's
ladder — the weekly (Friday walked back over full-day holidays) and daily (every session day)
closes from the NYSE calendar, `expiriesAhead` of each tenor, crossed with `ladderStrikes` at the
market's `strikeTick`, exactly as `cranker/steps.ts` maintains them. A rung the chain does not list
prices interpolated or modeled or refuses, like the live service; the replay records every outcome
and never throws on bad data. No network, no credentials, no provider contact: chains come from
files, and the spot is a synthetic round over the chain's own underlying.

- **Committed neutral replay** (`replay.test.ts`): the committed synthetic chain and its fake-provider
  variants — listed quotes, vendor theoretical estimates, stale, empty, crossed and zero-bid books,
  and missing timestamps — asserting the method and every source clock are preserved (`null` stays
  `null`; a zero fair is a price, never "unavailable").
- **Private real-data replay**: point `PRICING_PRIVATE_FIXTURES_DIR` at a directory OUTSIDE the repo
  holding real Cboe downloads (`*.json`, one per root). The replay converts them through
  `cboeToNormalized` and prices the registry ladder of each live market they name. Private data is
  never committed; when the variable is unset the private test **skips with an explicit reason** and
  is never reported as passing.
- **Real `--pricing-url` devnet paths**: `v2:devnet-pricer` and `v2:devnet-mm` accept
  `--pricing-url <url>` (or `PRICING_URL`) to call a real running pricing service — for example one
  serving replayed chains — instead of their in-process stubs. Flag parsing and the default path are
  covered by `devnet-pricing-url.test.ts`.

### Pricing coverage (K3-303)

`v2:pricing-coverage` prices every rung the cranker would list and reports on each one. Its output is
derived only. It holds no key, sends nothing and never writes the registry.

```bash
RH_RPC=… pnpm --filter @callhouse/keeper v2:pricing-coverage                               # live markets, table
RH_RPC=… pnpm --filter @callhouse/keeper v2:pricing-coverage -- --status live,planned --suggest
RH_RPC=… pnpm --filter @callhouse/keeper v2:pricing-coverage -- --mode quote-readiness --tickers NVDA
RH_RPC=… pnpm --filter @callhouse/keeper v2:pricing-coverage -- --watch 300 --out coverage.jsonl
```

- **The ladder is the cranker's.** Expiries come from `upcomingLadderExpiries`, which walks
  `ExpiryCalendar.nextExpiry` from `ladderSearchStart`. By default it reads the on-chain calendar at the
  registry's address; `--calendar local` uses a mirror of its grid built from the NYSE holiday table. Slots
  come from `ladderSlots` (each tenor's `expiriesAhead`, plus puts where the market has them), and strikes
  from `planLadder`'s first ladder. All of these live in `cranker/planner.ts`, which the cranker also uses.
  The ladder is centred on the Stock Token feed's spot, where the cranker uses `SettlementOracle.trySpot`.
  It is today's ladder: a live ladder keeps its anchored strikes until it re-centres.
- **Each rung is priced in process** by `PricingService` through the provider seam (Cboe by default).
  A rung record (one JSON line) carries:
  - identity: ticker, expiry (unix and New York day), tenor, side, strike, and the canonical identity
    (token, chain id, uiMultiplier; issuer `null`);
  - source and method: provider, product, entitlement, method, method detail and contributing expiries;
  - clocks and ages: every clock with its age, `null` when the source does not give it;
  - verdict: readiness and reasons, fair (`null` when refused, with the refusal reason; `"0"` is a
    price), iv and delta;
  - listing: whether the exact contract is listed, and its bid, ask and sizes as supplied;
  - `belowFloor`, measured against the house floor.

  Some reasons are added only here. `early-close` marks an expiry on an NYSE early close
  (`calendar.ts NYSE_EARLY_CLOSES_2026_2028`), where the listed market stops at 13:00 and no clock models
  it. The `--events` calendar is also the pricing service's K3-312 event input (single source of truth):
  the service flags and bounds `event-uncertainty` (K3-312) and the rung reports its reasons verbatim,
  while the rung's `events` field only reports which of those events it spans (inside-series /
  inside-inputs), which the service does not say. Without `--events` the rung's events are `null`
  (unknown), and a before-first read still assumes one unknown event per the K3-312 policy.
- **The floor is a proposal.** The default of 0.05 USDG fair comes from F3 D9 and is not an approved
  value. `--floor` replaces it.
- **Summaries.** Each market and tenor gets its own line of ready, degraded, unavailable and below-floor
  counts, so a weekly pass never hides a daily failure. A market without a fresh feed spot has no ladder,
  and that blocks every enabled tenor; it never counts as an empty pass. The F1 registration inputs are
  printed separately from MM/pricer quote readiness. They cover identity, the strike tick against the
  listed strike spacing near the money, the ladder, each ladder expiry (whether it is listed, whether it
  is an early close) and per-tenor listing and floor counts.
- **Modes.** `--mode diagnostic` (the default) always exits 0 and always prints the F1 inputs.
  `--mode quote-readiness` exits 1 unless every enabled series of every selected market is `ready`, and
  lists the failing series. Cboe states no quote time, so every Cboe-priced rung is `degraded`
  (`quote-age-unknown`) and a Cboe-only run is never quote-ready. A usage or configuration error exits 2.
  pnpm reports any failing script as exit 1. To tell 1 from 2, run
  `npx tsx src/v2/pricing/coverage-main.ts …` from `keeper/`.
- **`--suggest`** prints a candidate `overrides.ladder` and a strike-tick flag per market (`match`,
  `coarser-than-listed`, `off-listed-grid` with the listed spacing, `no-listing`). If rungs k and beyond
  are below the floor at every priced expiry, it suggests `rungs: k` (k ≥ 1). If even rung 0 is below,
  it suggests the largest smaller `firstOtmBps` whose first rung reprices above the floor. It never
  suggests `expiriesAhead` or zero rungs, so it never turns a daily off (owner D6).
- **`--watch <s>`** writes one JSON line per market per refresh to `--out` (default stdout). Each line
  has the chain's quote, trade, underlying, volatility, published and received clocks, their ages
  (`null` kept), the refusal state and per-tenor readiness counts. `--iterations n` bounds the run.
  Chains are still refetched at most every five minutes, so only `receivedAt` moves on a refetch.
- Selection: `--tickers` (any v2 status) or `--status` (default `live`). Output: `--format table|jsonl`,
  and `--out` also appends the JSON lines. Environment: `V2_REGISTRY_PATH`, `RH_RPC` (feeds and calendar),
  `RH_RPC_2`, `PRICING_NYSE_HOLIDAYS`.

`coverage.test.ts` runs it on the synthetic NVDA and TSLA chains, through the Cboe adapter and the fake
providers, with injected feed rounds and no network.

### The cranker (`V2_MODE=cranker`)

One loop (`POLL_INTERVAL_MS`) plus a precise wake-up at each time-critical moment (an expiry with open
interest, `expiry + 120`, a candidate's `finalizableAt`), measured on the head block's clock. Each tick
runs its steps in this order, each isolated (a failing step is paged as `v2_error` and the next runs),
bounded (`CRANKER_MAX_TX_PER_STEP`) and idempotent:

| step | what |
|---|---|
| index | scan `SeriesCreated`, `TransferSingle`/`TransferBatch`, `OrderPlaced`, `StrategySet` into SQLite (`v2_cranker_*`) from the registry's deploy block: the holder, series, order and strategy lists the cranker uses alone while the indexer is down |
| snapshot | `SettlementOracle.snapshot` once inside `[expiry, expiry + 600]` for every expiry with open interest |
| finalize | from `expiry + 120`, after the snapshot attempt, only when a view says it advances (a source prices the window, an upgrade can corroborate, a candidate is past `finalizableAt`); the sources judged are the expiry's (recorded, else `settlementConfig(u, E)`: the configuration pinned at its first series), never the market's current list; alerts `v2_sources_disagree`, `v2_settlement_held`, `v2_snapshot_missed`, `v2_settle_stuck` |
| settle | `Clearinghouse.settle` every series of a final expiry with long supply |
| prune | every open order of an expired series, resale asks first (they hold longs about to be redeemed); a chunk that prunes nothing or runs out of gas is split down to one order, and one the book still skips alone (its maker rejects the refund) is marked and left out, so it cannot keep its expiry open |
| redeem | `redeemBatch` holders (indexer pages ∪ the log index, balances read from chain), longs then shorts; opted-out and zero-payout holders skipped (`CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI`); chunks sized by fixed per-holder gas budgets and split when a simulation under the limit redeems fewer or runs out of gas; `v2_redeem_backlog` once per expiry |
| ladders | the registry ladder (`v2.defaults.ladder` ← overrides) for the next `expiriesAhead` expiries of each live market and tenor, created in Multicall3 batches; completed if half-made, re-centred when fewer than two rungs are OTM, never deleted. Since INTERFACE_VERSION 6 the first series of an (underlying, expiry) pins its settlement configuration on the oracle and every source, and the pin fails closed: an expiry this Clearinghouse has not pinned is budgeted `GAS.createSeriesPinBase` + `createSeriesPinPerSource` per source on top of `createSeriesEach`, and first probed alone with ample gas. A refused pin (`PinMismatch`, `SourceNotPinned(source, reason)`, the oracle's `NotAuthorized` / `NoSource`: `cranker/pin.ts`) skips that expiry, pages `v2_pin_refused` once per oracle and cause, and is asked again after 15 min |
| rolls | `AutoRoller.roll` for due strategies (skipped without a roller; reverting writers skipped; a roll refused by its new series' pin pages `v2_pin_refused`); close-outs and rolls that earn the ROLL bounty (at least `minRollUnits`) first, at most 10 below it per tick, from a rotating start |
| housekeeping | prune orders past `validUntil`; `sweepFees` per asset weekly; **House vault epoch roll** (T-OP-117): for every vault of `CRANKER_HOUSE_FACTORY` / `MM_HOUSE_FACTORY`, `rollEpoch()` once the head is past `epochEnd` AND the vault's `oracle.settlementPrice(underlying, epochEnd)` is Finalized AND every tracked series is settled with no longs, shorts or live orders — the contract's own three preconditions, so a `NotSettled` revert is predicted rather than provoked. Fixed gas `HOUSE_ROLL_GAS` (2.5M), `kind: house-roll`, key `<vault>:<epochId>`, on the housekeeping budget. A boundary due for more than 7 h (the oracle's 6 h uncorroborated delay + 1 h) without rolling pages `v2_house_roll_overdue`; `rollEpoch` is permissionless, so a human can send it from any key (`ops/alerts.md`). Rides this step rather than its own `STEP_ORDER` entry because the dispatcher `case` lives in `cranker.ts`; the factory address is read from the environment because `CrankerTuning` has no field for it yet — both are named follow-ups. |

Every lifecycle call is sent with a FIXED gas limit (`cranker/constants.ts GAS`): `snapshot`, `finalize`,
`settle`, `redeemBatch` and `roll` swallow an inner out-of-gas, so `eth_estimateGas` finds a limit at which
they silently do nothing. `/state` carries per-step metrics (runs, errors, outcome counts, last actions and
what the step saw), the armed wake-up, the index counts and the latest journal rows. The pure decisions are
in `cranker/planner.ts` (unit tests in `planner.test.ts`).

```bash
KEEPER_ENV_FILE=../ops/devnet/env/cranker.env pnpm --filter @callhouse/keeper v2:dryrun   # what each step would do; sends nothing
DEVNET_PORT=8552 CONTRACTS_DIR=<callhouse-contracts on v2> pnpm --filter @callhouse/keeper v2:devnet-cycle
```

`v2:devnet-cycle` brings up `ops/devnet`, runs the cranker in process through two expiries (a single-source
candidate past its delay; a corroborated NVDA expiry snapshotted by the precise wake-up, with resale asks
pruned before an ITM long is redeemed) and asserts the on-chain end state, the journal and the alerts. It also
measures the pin: per market, the first series of an unpinned expiry against its budget, a later series of the
pinned expiry against `createSeriesEach`, and a lone first series batched at its limit (created) and at the
pre-v6 limit (refused); every createSeries batch and roll of the journal under 90 % of its limit.

### The MM bot (`V2_MODE=mm`)

Two-sided quotes through `MakerVault` around the pricing service's fair value. `MM_QUOTER_PK` holds
the AccessManager's `QUOTER` role on the vault and nothing else (INTERFACE_VERSION 8; the bot asks
`AccessManager.canCall(signer, vault, place-selector)` and never needs the role id): it places, replaces and
cancels the vault's orders and moves
vault funds between the vault's wallet and the vault's own Clearinghouse ledger, never out of the vault.
Every quoted price and size is checked by the vault on chain (ask floor, bid cap, per-series units, total
notional, 16 live orders per series); the bot sizes inside those guards so its calls do not revert.

Per series, each tick (`POLL_INTERVAL_MS`):

```
halfSpread = max(fair × MM_HALF_SPREAD_BPS, MM_MIN_HALF_SPREAD_USDG6) × widen   (widen: 1 → 1 + MM_EXPIRY_WIDEN_BPS
                                                                                  over the last MM_EXPIRY_WIDEN_S before the pull time)
skew       = seriesDelta × spot × MM_SKEW_BPS_PER_DELTA_SHARE × netDeltaShares(market), capped at MM_MAX_SKEW_BPS of fair
bid        = roundDown(fair − halfSpread − skew), at most MakerVault.bidCap
target     = fair + halfSpread − skew                                  (the NET the vault must keep)
writeAsk   = roundUp(target / (1 − premiumFeeBps/1e4)), at least MakerVault.askFloor
resaleAsk  = roundUp((target − PRICE_TICK) / (1 − resaleFeeBps/1e4))
```

The seller fee is taken from the MAKER, so it belongs in the ask: the book credits a selling maker
`premium − sellerFee + rebate`. It is a GROSS-UP (divide by one minus the rate), never a markup. Each ask is
grossed by ITS OWN rate — `premiumFeeBps` for the write ask, `resaleFeeBps` for the resale ask — because the
book picks the rate per order kind, and v8 launches at 500 / 0. So the "one tick under" relation holds on the
UNGROSSED prices and **the two asks may sit more than one tick apart on chain**. Bids carry no fee term: a
selling taker is paid `premium − sellerFees − takerFee` and the bid maker is credited only its rebate.

```
```

A vault that is long delta (bids filled) lowers every call quote on that market; short delta (asks lifted)
raises them. The ask side is `MM_ASK_UNITS` in total: inventory first (`AskResale`), `AskWrite` from the
vault's ledger collateral for the rest; bids are `MM_BID_UNITS`, escrowed from the vault's USDG. Series are
chosen nearest the money first (`MM_MAX_SERIES`, `MM_MAX_SERIES_PER_MARKET`). Unset, both caps are DERIVED
from the registry ladder of the quoted markets so that every listed series carries a quote (T-OP-123/T-OP-133,
owner: "each option should have a pre-filled ask"): per market the resolved ladder count -- rungs x expiries
ahead x sides per tenor, 5 x (2 weekly + 3 daily) x call/put = 50 at launch -- and in all their sum. A cap SET
below what a quoted market lists is refused at boot with the unquoted count, because a silently partial book
was the failure. `/state` reports `coverage` per market: listed, live, selected, and every trim by name.

**Fallback-only asks (`MM_ASK_FALLBACK_ONLY`, default 1 -- the owner's model).** The vault's ask on a series is the
FALLBACK: it rests only while no other maker's live ask (`AskWrite` or `AskResale`) rests on that series. Each tick
reads the tail of every managed series' order list (`OrderBook.ordersOfSeries` + `getOrders`, reads.ts
`readOtherAskers`); while another asker is found the series halts `other-asker` ON THE ASK SIDE ONLY -- no ask is
sized or placed, a resting vault ask is cancelled, the bid is untouched -- and the ask returns at the next tick once
the book clears. The vault's OWN resting ask is never "another asker" (the read drops it), so the ask does not flap.
**Protocol accounts count as another asker** (the HouseVault's covered-call ask, `protocolBook`): a listed option
already offered by the house is left to the house. That is a choice, not a mechanism -- to let the MM bot quote
alongside protocol asks, filter `protocolAccounts` out in `planner.ts` `otherAskOn` and say so here. `0` restores the
always-quote. `MM_QUOTE_OFF_HOURS` is unchanged by this flag (still 0; an open owner question).

**One oversubscribed write pool (`MM_WRITE_OVERSUBSCRIBE_BPS`, default 10000).** The per-asset write budget the asks
are SIZED against is `Clearinghouse.free(vault, asset) x bps / 10000`. At 10000 (the default) it is today's exact
budget: the advertised sum of every write ask on an asset never exceeds what the ledger holds. Above it the ledger is
ONE POOL shared by every ask on that asset -- the launch runbook suggests 50000 -- while EVERY SINGLE ask still fits
`maxWriteUnits(free)`, so any one fill is always covered; only several fills of different series inside one tick can
outrun the pool, and then the book SKIPS the uncoverable fill at plan time (`OrderBook._plan` budgets each write ask
against the maker's free collateral, "filled whole or skipped, never cut") and catches a mint that still fails at
delivery -- a taker never reverts on our shortfall. Bids are untouched: they escrow real USDG at placement. The
vault's on-chain `maxTotalNotional` counts ADVERTISED write units, so the notional the advertised sum reaches must
fit `V2_VAULT_MAX_TOTAL_NOTIONAL` (ops/runbooks/v2-canary.md states the number). `ops/go-live-v2.sh` prints, per
quoted market, the listed series and the pool each asset needs at the chosen bps next to what the vault holds
(wallet + ledger), and WARNS when short -- never refuses; funding is owner-gated.

A live quote is replaced only
when its target moved more than `MM_REQUOTE_BPS`, its size is off (`MM_RESIZE_BPS`), it broke a guard, or it
is about to expire (re-placed: `replace` keeps `validUntil`). Every new quote is valid until the pull time, the
session close (unless `MM_QUOTE_OFF_HOURS=1`), the vault's `maxOrderLifetime`, and at most `MM_MAX_QUOTE_LIFETIME_S`
(1800) from now: the book does not re-check the vault's guards at fill time and the launch vault has no lifetime, so
a bot that dies, or whose sends all fail, leaves no quote fillable for longer than that.

Nothing is quoted on a series (its orders are cancelled) when, in this order: the kill switch is engaged;
the day's realised loss reached `MM_DAILY_LOSS_LIMIT_USDG6`; the signer lost its role (then nothing is sent
at all); the book is paused; the series expired or is inside `MM_PULL_MINUTES` before its mint cutoff; the
regular session is closed and `MM_QUOTE_OFF_HOURS=0`; the market is outside the quoted set (`MM_MARKETS`, or
no longer live in the registry: its vault orders are still pulled and its inventory counted); the market is disabled; the series' oracle spot is
stale (vault calls would revert `StaleSpot`); the series is not selected; `/fair` is null, unreachable or
older than `MM_FAIR_MAX_AGE_S` (`MM_FAIR_MAX_AGE_OFF_HOURS_S` outside the session), priced at a spot more than
`MM_FAIR_SPOT_TOLERANCE_BPS` (300) from the series oracle's (inside it, the fair value is carried to the oracle's
spot along its delta), or outside the no-arbitrage bounds (a call at or above spot, a put at or above strike); the
guards are unreadable. Two halts are ONE-SIDED and leave the other side resting: `protocol-cross` (a quote that
would rest across a protocol account's order) and `other-asker` (`MM_ASK_FALLBACK_ONLY`, above: another maker's
live ask rests on the series, so only the vault's ask is held back). Housekeeping: expired bids and resale asks are cancelled to reclaim their escrow, long/short
pairs are closed, `owed` USDG is claimed, idle Stock Tokens in the vault wallet go into its ledger
(`MM_DEPOSIT_TOKENS`), and `MakerVault.sync` refreshes series whose stored notional is above the measured
one (fills and expiries leave it stale-high) at most every `MM_SYNC_INTERVAL_S`.

Realised PnL: a growing `filled` on a vault order (read every tick, fills written to SQLite in the same
transaction as the new `filled`, so a crash never counts one twice) at average cost per series, seller fees
included, rebates ignored; settlement closes a position at intrinsic value. Orders that existed when the
database was first bound are adopted at their current fills. A sale is booked at the seller fee the book took,
from its `OrderFilled` logs (`mm/fills.ts`), not at the fees in effect when the bot sees it: since
INTERFACE_VERSION 6 a fee change takes effect 24 h after it is scheduled, so a fill made before `effectiveAt` and
seen after it would be mispriced (a fee cut understates the loss and weakens the loss stop). When the logs cannot
account for a sale it is booked at the highest seller fee of the regimes in effect at the previous look and now
(the compiled ceiling, 10 %, across a gap of a day or more), with a warning; `/state` shows each fill's `fee`
basis and the tick's `lastSales`.

| endpoint | what |
|---|---|
| `GET /state` | process-wide kill plus a `vaults[]` row per quoted vault (killed, caps, inventory, epoch, current plan). Treasury fields at the top stay the first vault for existing readers |
| `POST /kill` | `Authorization: Bearer <MM_KILL_TOKEN>` (constant-time compare; anything else 401). No body still kills **every** vault. `{ "vault": "0x.." }` kills one. Stored first (a restart stays killed), `v2_mm_killed` pages, then every vault order that is live or still holds escrow (an expired Bid or AskResale; never an expired AskWrite) is cancelled, on every market, until a re-read finds none: 200 `{ cancelled, remaining: 0, done: true }`; 202 if still running after a minute, or if orders are left after every pass (`remaining`, `remainingOrderIds`, the failed cancels in `errors`; later ticks keep cancelling) |
| `POST /resume` | same header; optional `{ "vault": "0x.." }`. Quoting resumes at the next tick (`v2_mm_resumed`) |

Per-vault env (K8-05). `MM_MAX_TX_PER_TICK` is a **process** budget, treasury first then `MM_VAULTS` extras.

| key | default | meaning |
|---|---|---|
| `MM_EPOCH_WIND_DOWN_S` | `14400` | Seconds of lead before a House vault `epochEnd` during which the plan opens no new risk. `epochEnd` is read from the vault when a House ABI exists; treasury is `epoch: null`. |
| `MM_VAULTS` | empty | Extra vault addresses, comma-separated, quoted in this process with the treasury `MAKER_VAULT`. |
| `CRANKER_HOUSE_FACTORY` | empty (falls back to `MM_HOUSE_FACTORY`) | HouseVaultFactory address the **cranker** enumerates for the weekly `rollEpoch` (housekeeping step, T-OP-117). Set it on the cranker's env, or set `MM_HOUSE_FACTORY` there too; unset = the roll is a documented no-op. Must be a 20-byte hex address; anything else is treated as unset (fail closed), never a partial read. |
| `MM_HOUSE_FACTORY` | empty | HouseVaultFactory address. House vaults are **enumerated** from its `vaults()`. Blocked on **T-78**: `ops/abis/v2` publishes no `HouseVault`/`HouseVaultFactory` artifact, so `gen-abis` renders no module and there is nothing to call. Set it anyway and the bot pages `v2_mm_house_unavailable` every tick rather than quietly quoting no House vault. Do not hand-write those ABIs. |
| `MM_VAULT_CAPS` | empty | Per-vault overrides of `MM_MAX_SERIES_UNITS`, `MM_MAX_TOTAL_NOTIONAL_USDG6` and `MM_DAILY_LOSS_LIMIT_USDG6`, as JSON keyed by vault address: `{"0xVault":{"maxSeriesUnits":"25","dailyLossLimitUsdg6":"250000000"}}`. Fields are optional and decimal; an omitted one falls back to the process-wide value. It can only **tighten** — the result is still clamped to that vault's own on-chain limit, and an unknown field name is refused at boot rather than ignored. |

**A House vault whose epoch cannot be read is not quoted.** `epoch: null` means *treasury MakerVault,
no epoch discipline* to every consumer, so falling back to it would be permission to open risk past
`epochEnd` in the one kind of vault that has to be flat when `rollEpoch` is due. The bot skips the
vault and pages instead.

**The tx budget is shared, treasury first, with a reserve.** `MM_MAX_TX_PER_TICK` is spent by the
treasury first, because it is the live vault and carries the protocol's existing inventory, but each
vault still to come reserves an equal share so a saturating treasury cannot starve a House vault of
even its cancels — and a vault that cannot cancel cannot wind down for its roll. **Gas / key model:**
one `MM_QUOTER_PK` serves every vault in one process, deliberately: two processes on one key collide
on nonces (`NonceTracker` is per-process, `src/v2/tx.ts:158`) and cannot see each other's resting
quotes, which is what makes the protocol-cross guard possible at all. If one key cannot serve the
configured vaults inside that budget, that is the trigger for the parked shard mode `K3-205`, not a
reason to run a second process.

Private networking only: `mm-bot` never gets a public domain (`ops/deploy.md` §15). Alerts: `v2_mm_killed`,
`v2_mm_resumed`, `v2_mm_loss_stop`, `v2_mm_wrong_book` (a vault on another OrderBook: skipped, the rest still tick),
`v2_mm_epoch_unflat` (a House vault still holding risk at `epochEnd`), `v2_mm_protocol_cross` (a rest that would have
crossed another protocol-owned maker), `v2_mm_house_unavailable`,
`v2_mm_delta` (net delta above `MM_DELTA_ALERT_SHARES`), `v2_mm_not_quoter`,
`v2_mm_pricing` (no `/fair` answered), `v2_mm_tx_rejected` (a vault call's simulation reverted),
`v2_mm_funds` (quoted series left one-sided by USDG or collateral), plus the shared `v2_*`.

Vault calls use FIXED gas limits (`mm/constants.ts MM_GAS`; place and replace 1.2M, cancel 150k + 250k per id).
Measured on the devnet: place ≤ 436k, replace ≤ 348k, a 20-order cancel ≈ 1.06M.

```bash
DEVNET_PORT=8560 CONTRACTS_DIR=<callhouse-contracts on v2> pnpm --filter @callhouse/keeper v2:devnet-mm
```

`v2:devnet-mm` brings up `ops/devnet`, warps into a session, serves `/fair` from the pricing service's own
Black-Scholes at the devnet oracle's spot, runs the MM bot in process and asserts on chain: two-sided vault
quotes on at least 5 series inside the guards and around fair; a second tick sends nothing; a null `/fair`
pulls that market; a taker lifting a vault ask (deadline capped before any pending fee change) is booked at its
`OrderFilled` seller fee, turns the net delta negative and gets the quotes replaced higher; `/kill` refuses a wrong token, clears the vault's book and keeps it clear, `/resume` quotes again;
every journalled transaction confirmed under its gas limit. With `--pricing-url <url>` (or `PRICING_URL`)
it calls a real pricing service instead of the stand-in; the null-`/fair` step belongs to the stand-in and
is skipped with an explicit note.

### The pricer (`V2_MODE=pricer`)

Reprices the live AutoRoller ask of every strategy with `smartPricing` (roadmap 5.3). `PRICER_PK` holds
the AccessManager's `PRICER` role on the AutoRoller and nothing else (INTERFACE_VERSION 8; the bot asks
`AccessManager.canCall(signer, roller, reprice-selector)`): the role can only move a smart-pricing writer's ask
inside the writer's own `[minAskBps, maxAskBps]` band of spot, keeping its units and expiry (C2-09). It
cannot touch collateral, but a leaked key is not harmless: it can move every smart-pricing writer's ask to the
bottom of that writer's band, where a colluding taker lifts it (each writer sells at its band minimum instead of
fair plus edge; callhouse-contracts `SECURITY.md`). Revoke it at once — `PRICER`'s role admin is `OPS_ADMIN` at delay 0, so it is one Safe transaction with no
wait (`script/v2/roles.v8.json`).

Each tick (`POLL_INTERVAL_MS`): the strategy list (its own `StrategySet` scan ∪ the indexer's
`/v2/strategies?active=1`), one pinned multicall of `hasRole`, `strategy`, `position`, the market's
oracle `trySpot`, the tracked ask and its series, then per writer:

| rule | |
|---|---|
| eligible | strategy active with `smartPricing`; a tracked ask not cancelled, not filled, more than 60 s before its `validUntil`; a fresh spot |
| cadence | right after each roll (a position the pricer has not evaluated yet), then at most every `PRICER_MIN_INTERVAL_S` (1800) on the head block's clock; only an evaluation that reached a decision restarts it |
| /fair gates | `PRICER_FAIR_MAX_AGE_S` (1800): refuse unknown or stale source times. Legacy `asOf` is the Cboe underlying last-trade clock, not an option quote time. When additive `provenance` is present it is used and never required: quote age is only `quoteObservedAt`; a refetch does not refresh an old observation; unknown reason codes and non-ready quality refuse. `PRICER_FAIR_SPOT_TOLERANCE_BPS` (300): `/fair.spot` vs oracle `trySpot`, 300 bps accepted, 301 refused. Zero `fair` is a number, not unavailable. Each skip reason is on `/state` and feeds the fair-unavailable timer |
| target | `clamp(fair × (1 + PRICER_EDGE_BPS), minAskBps · spot, maxAskBps · spot)`: fair from `PRICING_URL` `/fair` for the series' strike and expiry; the raw target rounded UP to `PRICE_TICK` (100) and the band's ends rounded INWARD, so every price passes the contract's exact inclusive check |
| send | only when the target differs from the live ask by more than `PRICER_REPRICE_THRESHOLD_BPS` (1000 = 10 %): `AutoRoller.reprice` through `tx.ts` with a fixed gas limit (600k; 251k measured), keyed by the ask it replaces |

No fair value (the service down or `fair: null`), an unqualified /fair (stale/unknown source time, spot gap, provenance not ready), a stale spot, a refused simulation, a reverted or
unconfirmed transaction: nothing is remembered, and the next tick tries again. Alerts:
`v2_pricer_no_role` (error: the key lacks `PRICER_ROLE`, nothing is sent), `v2_pricer_fair_unavailable`
(warn: a due ask has had no usable fair value for `PRICER_FAIR_ALERT_S`, 7200), `v2_pricer_reprice_failed` (warn
for a refused simulation, error for an on-chain revert or a lost receipt). Tuning: `PRICER_EDGE_BPS` (500,
-5000..10000), `PRICER_REPRICE_THRESHOLD_BPS`, `PRICER_MIN_INTERVAL_S`, `PRICER_MAX_TX_PER_TICK` (50),
`PRICER_HTTP_TIMEOUT_MS` (5000), `PRICER_FAIR_ALERT_S`, `PRICER_FAIR_MAX_AGE_S` (1800), `PRICER_FAIR_SPOT_TOLERANCE_BPS` (300), `PRICER_LOG_CHUNK_BLOCKS` (50000),
`PRICER_LOG_CHUNKS_PER_TICK` (40). `/state` shows each writer's live price, spot, fair, target, band, the
decision and the next check. The pure rules are `pricer/planner.ts` (`planner.test.ts`) and `pricer/fair-gates.ts`; the tick on
fakes is `pricer.test.ts`.

```bash
DEVNET_PORT=8561 CONTRACTS_DIR=<callhouse-contracts on v2> pnpm --filter @callhouse/keeper v2:devnet-pricer
```

`v2:devnet-pricer` brings up `ops/devnet` and runs the pricer in process, with an injected fair value,
against the seeded writer's smart-pricing roll ask: repriced by account 9 right after the roll, not
again inside 30 minutes, left alone within 10 %, then clamped to the band's ceiling tick. It asserts the
`Repriced` events, the replacement asks, the journal and the alerts. With `--pricing-url <url>` (or
`PRICING_URL`) it boots on the real pricing client instead of the injected value, ticks once and checks
that what the pricer did matches what the service answers for the same series.

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
| `index.ts` | The image's entry: `V2_MODE` unset or blank imports `main-v1.ts`, set imports `v2/index.ts` (see "v2 modes"). |
| `main-v1.ts` | The v1 keeper: wiring, the poll loop, graceful shutdown. Moved out of `index.ts` unchanged so a v2 process never evaluates the v1 config. |
| `dryrun.ts` | The production keeper driven through three weeks against an anvil fork (unfilled; filled + exercised; stranded by a USDG freeze and recovered) and a fourth arm, with assertions. `DRYRUN.md` is the recorded run. |
| `dryrun-extended.ts` | The scenarios the three-week run does not reach: the compiled `index.ts` process under SIGTERM mid-tick, partial fills / a guardian cancel / a reprice after a rally / refused fills / the listing budget, several exercisers, an anyone-`rollClose` reconciled from logs, and Valorem's fee switch on and accepted. |
| `dryrun-common.ts` | What both harnesses share: chain constants, derived actors, anvil RPC, storage-written balances, the linked deploy from `contracts/out`, the USDG freeze, a buyer's fill and exercise, the fill simulation, the alert capture, the report writer. |
| `*.test.ts` | Unit tests, next to the module each one pins. `pnpm test`. |
| `Dockerfile`, `railway.json` | The container, built from the repo root, and the Railway config-as-code. Runbook: `ops/deploy.md`. |
| `deploy/callhouse-keeper.service` | The systemd alternative. |
