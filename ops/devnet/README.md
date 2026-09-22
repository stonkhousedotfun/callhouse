# ops/devnet — a local Stonkhouse v2 chain

One command gives you an anvil fork of Robinhood Chain (4663) with the v2 core and periphery contracts
deployed against the **real** USDG, NVDA, TSLA, Chainlink feeds, USDG/NVDA Uniswap pool and SwapRouter02,
a seeded market (ladders, asks, bids, fills, a resale ask, one AutoRoller strategy with a live roll order,
two MakerVault quotes, one settled in-the-money series whose winners were paid in USDG through the
PayoutAdapter, and one pending TSLA settlement), and the env blocks for every v2 service.

```bash
ops/devnet/up.sh          # ~1 minute; ends with the summary and the env blocks
ops/devnet/down.sh        # stop it (--clean also deletes the generated files)
```

Prerequisites: foundry (`anvil`, `forge`, `cast`), node >= 22, `pnpm install` at the repo root (viem is
loaded from the keeper package), and a `callhouse-contracts` checkout on `v2` next to this repository
(or `CONTRACTS_DIR=/path/to/callhouse-contracts`). No keys: every transaction is sent from one of anvil's
unlocked dev accounts. Re-running `up.sh` stops the old devnet anvil first and starts from scratch.

**anvil outlives the shell that started it.** `up.sh` returns with anvil still running, and it keeps
running after that shell exits, including a one-shot exec session (`bash -c '... ops/devnet/up.sh'` from
an agent or CI step) that tears down its whole process group when it returns. anvil is started in its own
session and process group (node's detached spawn, i.e. `setsid`, under `nohup`), with stdin from
`/dev/null`, stdout and stderr in `state/anvil-fork.log` (the fork) or `state/anvil.log` (the detached
node), and `state/anvil.pid` holding `<pid> <port> <process start time>`. A custom `RH_RPC` may contain
credentials, so raw Anvil output is suppressed for that fork and the log records only why it was
suppressed. `down.sh` stops only the recorded process group after checking its PID, port, and start
time (TERM, KILL after 5 s). It refuses an unrecorded listener, including another Anvil, and exits 1
unless the port is free afterwards. A legacy two-field PID file requires manual shutdown. So
`up.sh`, the tool that uses the devnet and `down.sh` can each run in a separate shell. A failed or
interrupted `up.sh` (error, Ctrl-C, SIGTERM, SIGHUP) stops its anvil unless `DEVNET_KEEP_ON_FAIL=1`.

| env | default | |
|---|---|---|
| `DEVNET_PORT` | `8546` | RPC `http://127.0.0.1:$DEVNET_PORT`; one devnet per checkout (the generated files are shared) |
| `RH_RPC` | public RPC | fork source; anvil reads it through foundry.toml's `rh` alias, so a keyed URL never hits a command line |
| `CONTRACTS_DIR` | `../callhouse-contracts` | where `script/v2/DevDeploy.s.sol` lives |
| `DEVNET_DETACH` | `1` | see "Detached" below; `0` keeps the fork attached (use with an archive `RH_RPC`) |
| `DEVNET_KEEP_ON_FAIL` | `0` | `1` leaves a failed run's anvil up for inspection |
| `DEV_AUTO_ROLLER`, `DEV_PAYOUT_ADAPTER`, `DEV_MAKER_SUITE` | `auto` | `0` leaves that periphery contract out (null in `addresses.json`, skipped by the seed, its gates off); `1` makes DevDeploy refuse to run without it |

## INTERFACE_VERSION 8

The devnet is built from **`ops/markets/dev.json`**, never from the production registry. `dev.json` is
the decoupled dev registry: the same v8 fee block, a `_dev` marker, and an isolation check in
`build-markets.mjs` that refuses any production wallet in it. Every account here is a public anvil dev
account from the `test test … junk` mnemonic.

**Every admin action goes through the driver.** Nothing in `ops/devnet/**` sends a restricted call
from an admin key: see **[`ops/v2/ADMIN-DRIVER.md`](../v2/ADMIN-DRIVER.md)** and
`node ops/v2/devnet-admin.mjs <target> "<signature>" [args...]`. The driver reads every role id and
delay from `ops/abis/v2/roles.json` at run time, picks `execute` / `schedule-execute` /
`schedule-direct` from the manifest, and moves the **node** clock across a delay
(`evm_setNextBlockTimestamp` + `evm_mine`). A forge cheatcode cannot do that: `vm.warp` moves a
script's own EVM and leaves the chain where it was, so a scheduled operation replayed on the node
still meets an unexpired delay.

**The roles live on a test Safe, at their real delays.** `DevDeploy.s.sol` grants every privileged
role to the admin EOA at delay 0, which is the arrangement v8 exists to end, so `up.sh` runs
`devnet.mjs safe` straight after the deploy:

- it deploys a stand-in contract (runtime `60006000fd` — any call to it reverts) and records it as
  `accounts.adminSafe`, which is where `devnet-admin.mjs` resolves `--safe` from;
- it grants that contract **every** role in the manifest at the manifest's own `delaysS`
  (`ADMIN` 48 h, `FEE_MANAGER` 48 h, `MARKET_FEE_MANAGER` 72 h, `CONFIG_ADMIN` 24 h,
  `TREASURY_ADMIN` 24 h, `LISTING` 1 h, and the hot roles at 0), reading the grant back and refusing
  a delay it did not ask for;
- it revokes the admin EOA from every delayed role, `ADMIN` last, because that membership is what
  authorises the calls;
- it then proves the property rather than asserting it: no delayed role is held by any anvil EOA.

The stand-in is **not a Safe and does not pretend to be one**. It has no `execTransaction`; it is a
contract so that roles 0-6 are held by code rather than by a key, and it acts by impersonation. A
rehearsal that needs real Safe *behaviour* needs a real Safe.

**The 72 h lane is crossed on every run**, before the seed: `up.sh` sends
`setDefaultMarketFees` (MARKET_FEE_MANAGER, 259,200 s) through the driver with the registry's own
values, so the longest lane is exercised without changing a fee. It runs before the seed on purpose —
`seed.mjs` takes `now()` and asks `ExpiryCalendar.nextExpiry` for every ladder, so its expiries are
relative to the clock *after* the warp. Crossing the lane after the seed would push the chain past
expiries that had already been written and sold into.

**What this devnet cannot do.** `DevDeploy.s.sol` builds no `FeeSplitter` and no `V4BuybackExecutor` —
they are not in the script — and the Clearinghouse and OrderBook take an EOA as `feeRecipient`. So
there is no flywheel here: `v2.flywheel` stays null in the registry copy, the two flywheel gates in
`up.sh` print a named skip instead of a false pass, and nothing on this devnet exercises the
fee split, the buyback or the burn.

## What you get

- **Contracts** (`DevDeploy.s.sol`): ExpiryCalendar (NYSE holidays from `ops/markets/v2-sources.json`),
  ChainlinkFeedSource, UniV3TwapSource, SettlementOracle (NVDA: Chainlink then pool; TSLA: Chainlink
  only), Clearinghouse (base URI `https://app.stonkhouse.fun/api/token/`), OrderBook (fees from the
  registry's `v2.fees`), KeeperRewards (bounties 0.05 / 0.05 / 0.05 / 0.02 / 0.05 USDG, 100 USDG daily
  cap, funded with 1,000 USDG). The admin's nonce is pinned, so the addresses are the same on every run.
- **Periphery** (same script, after the core): AutoRoller (PRICER_ROLE to account 9, pays the ROLL bounty
  through KeeperRewards), UniV3PayoutAdapter over SwapRouter02 (NVDA routed through its 0.05 % pool,
  TSLA unrouted and paid in kind; Clearinghouse slippage bound 30 bps + the route pool's fee: NVDA
  0.05 % -> effective 35 bps), MakerRegistry (set on the book),
  MakerVault (QUOTER_ROLE to account 10; limits 10,000 units per series, 250,000 USDG notional, ask
  tolerance 100 bps, bids at most 10 % of spot, no lifetime cap) and RewardsDistributor.
- **Mock feeds** (`DEV_MOCK_FEED=1`): each market's ChainlinkFeedSource reads a `MockRoundFeed` seeded
  with the real feed's last 8 rounds plus a fresh one. A live feed cannot follow a warp; the mock can.
- **`addresses.json`**: chain, fork and start block (`V2_START_BLOCK`), accounts, `contracts` in the
  shape of the registry's `v2.contracts` (`null` = not on this devnet), markets (mock and real feed,
  pool, sources), config, and `seed` (series, orders, fills, the settlement, the summary).
- **`tier1.devnet.json`**: the registry with the devnet's contracts and deploy block, `v2.bots`, NVDA
  and TSLA `live`, TSLA's pool cleared (Chainlink-only on the devnet), and `feed` pointing at the mock.
  The bots and the web app read addresses from it. Never commit it or deploy from it.
- **`env/*.env`**: `indexer`, `cranker`, `pricing`, `mm-bot`, `pricer`, `notifier`, `web`, in the real
  variable names (plan 02-interfaces §7). The bot keys are anvil's public dev keys. The signing bots'
  `KEEPER_DB_PATH` is `state/<service>.db` (absolute), so the next `up.sh` deletes it with `state/`: every
  devnet has the same contract addresses, and a database kept from the last one would carry its cursors,
  adopted orders and done-marks. The bots also check the registry deploy block's hash against the one their
  database recorded and reset it on a mismatch (`keeper/src/v2/anchor.ts`), for a file kept anywhere else.

These three and `state/` (state dump, anvil and forge logs, the bots' databases) are generated per run and gitignored.

Accounts (anvil's default mnemonic, `--accounts 12`): 0 admin, 1 guardian, 2 fee recipient, 3 `ada` and
4 `ben` (writers; `ben` is also the AutoRoller writer), 5 `cy`, 6 `dee`, 7 `eve` (buyers), 8 cranker,
9 pricer (PRICER_ROLE), 10 MM quoter (QUOTER_ROLE), 11 unused.
On chain 4663 all twelve carry EIP-7702 delegation code (public keys get delegated by sweepers);
`up.sh` clears it on the devnet, or ERC-1155 mints to them would revert.

## Using it

```bash
set -a; . ops/devnet/env/pricing.env; set +a; pnpm --filter @callhouse/keeper exec tsx src/v2/pricing/main.ts
MARKETS_REGISTRY=$PWD/ops/devnet/tier1.devnet.json pnpm --filter @callhouse/indexer gen:v2-registry   # first; see below
set -a; . ops/devnet/env/indexer.env; set +a; pnpm --filter @callhouse/indexer dev
set -a; . ops/devnet/env/web.env;     set +a; MARKETS_REGISTRY=$PWD/ops/devnet/tier1.devnet.json pnpm --filter @callhouse/web gen:markets
```

The web step rewrites `web/lib/markets.generated.ts` as a rehearsal build: do not commit it.

**Indexer: generate the devnet registry before Ponder starts.** The indexer compiles the v2 market
registry into `indexer/lib/v2/marketRegistry.generated.ts` (from the production registry, which has no v2
contracts or deploy block yet). Point it at the devnet copy first, start Ponder (or
`pnpm --filter @callhouse/indexer v2:devnet-check`), then put the committed snapshot back:

```bash
MARKETS_REGISTRY=$PWD/ops/devnet/tier1.devnet.json pnpm --filter @callhouse/indexer gen:v2-registry
set -a; . ops/devnet/env/indexer.env; set +a; pnpm --filter @callhouse/indexer dev
# afterwards, before any commit:
/opt/homebrew/bin/git checkout -- indexer/lib/v2/marketRegistry.generated.ts
```

The generator prints a REHEARSAL warning and stamps the file "do not commit" while it holds devnet
addresses (`indexer/scripts/gen-v2-registry.mjs`, also `--registry <path>`).

**Warp time.** Blocks come every second; move the clock with

```bash
cast rpc evm_increaseTime 3600 --rpc-url http://127.0.0.1:8546 && cast rpc evm_mine --rpc-url http://127.0.0.1:8546
cast rpc evm_setNextBlockTimestamp 1790366405 --rpc-url http://127.0.0.1:8546 && cast rpc evm_mine --rpc-url http://127.0.0.1:8546
```

Spot goes stale after the oracle's `spotMaxAge` (the registry's `v2.defaults.spotMaxAgeS`, 25 h; `ops/deploy.md`
§15.13): after a warp across a weekend or past that age, push a round before anything reads spot (series creation
skips its strike band without it; the AutoRoller refuses). A warp of a few hours keeps the old round valid, as on
mainnet: push one anyway when a step needs a price that moved.

**Push a Chainlink round** (`set-feed.mjs`, answers at the feed's 8 decimals, never stamped in the future):

```bash
node ops/devnet/set-feed.mjs --show                    # latest round and spot per market
node ops/devnet/set-feed.mjs --all                     # re-print every latest answer, stamped now
node ops/devnet/set-feed.mjs NVDA --price 231.5        # new price now (one step moves at most 20 %)
node ops/devnet/set-feed.mjs NVDA --pool               # at the pool's 5-minute TWAP
node ops/devnet/set-feed.mjs NVDA --window 1790366400 --pool   # a whole settlement window, after expiry
```

**Settle another expiry by hand** (what the cranker, K2-03, automates): warp to `expiry + 5`,
`set-feed.mjs <T> --window <expiry> --pool` (NVDA: the pool must agree within 150 bps or the price waits
6 h as an uncorroborated candidate), `SettlementOracle.snapshot(underlying, expiry)` inside
`[expiry, expiry + 600]`, warp past `expiry + 120`, `finalize`, `Clearinghouse.settle(longId)` per
series, `OrderBook.prune(orderIds)`, then `redeemBatch` longs and shorts. `seed.mjs settle` is the
worked example. Send these with a fixed gas limit: `snapshot`, `finalize`, `settle` and `redeemBatch`
swallow an inner out-of-gas, so `eth_estimateGas` finds a limit at which the pool snapshot silently
records nothing.

## Detached

The public RPC keeps state only about 15 minutes behind its head, and a fork fetches every storage slot
it has not seen at the fork block. So after seeding, `up.sh` sends one warm-up transaction (tokens,
feeds, pools, and the views `ops/v2/monitor.mjs` reads: USDG `isFrozen` of every v2 contract, the Stock
Tokens' multiplier and access-registry views), dumps the node (`anvil_dumpState` ->
`state/devnet-state.json`) and restarts anvil from the dump with no fork: every block, log and touched slot is kept, any untouched slot reads as zero (right
for new accounts). The settlement half of the seed runs on the detached node. Restart the same devnet
later with `anvil --load-state ops/devnet/state/devnet-state.json --chain-id 4663 --code-size-limit
98304 --block-time 1 --port 8546 --accounts 12` (state as of the dump, before the settlement).

## Periphery (C2-09, C2-10, C2-11)

What the seed does with each (`seed.mjs`; the summary gates each one the devnet has):

- **AutoRoller.** In `trade`, `ben` runs the writer setup (NVDA approve, deposit 20 NVDA,
  `setPayoutToLedger(true)`, `setOperator(book)`, `setOperator(roller)`, `book.setDelegate(roller)`) and
  `setStrategy(NVDA, weekly, otm 500, ask 60, smart pricing 30-150, max 1,000 units)`. In `session`, the
  cranker calls `roll(ben, NVDA)`. Gate: one active strategy whose roll order is live.
- **UniV3PayoutAdapter.** In `trade`, the admin sells 0.5 NVDA through `adapter.swapToUsdg` and buys NVDA
  with 100 USDG through SwapRouter02 directly. That is not decoration: a detached node keeps only the
  storage a transaction touched, and these two swaps put the pool's swap path around the current tick,
  the router and the adapter's token slots into the dump. The settlement's `redeemBatch` then converts
  every ITM call long to USDG (`Redeemed.asset` = USDG, `amountInKind` = the NVDA owed). Gate: adapter set on
  the Clearinghouse, NVDA routed through its pool, at least one USDG conversion. A swap much larger than
  the warm-up (crossing initialized ticks nobody touched) can still read missing tick data on a detached
  node; use `DEVNET_DETACH=0` with an archive `RH_RPC` for that.
- **MakerVault.** In `trade`, the admin deposits 100,000 USDG and 100 NVDA into the vault and the quoter
  moves the NVDA into the vault's Clearinghouse ledger. In `session`, the quoter places an AskWrite (500
  units) and a Bid (300 units) on NVDA weekly1-r0 inside `askFloor` / `bidCap`. Gate: two live vault
  quotes and the book's maker registry is the devnet's. The MM bot (K2-04) adopts those two orders;
  `pnpm --filter @callhouse/keeper v2:devnet-mm` runs it against a fresh devnet (keeper/README.md, "The MM
  bot"). `env/mm-bot.env` carries a public devnet `MM_KILL_TOKEN`. No maker tier is set; RewardsDistributor has no
  root.

`session` runs right before the settlement: inside the current regular session, or at 10:00 New York of
the next one (a warp), after a fresh round on every mock feed. It always lands before the first daily
expiry's settlement window, so the settlement and the chain's final time are what they were without it.

The devnet reads the committed interface version 6 ABIs in `ops/abis/v2`. `lib.mjs` can fall back to
forge artifacts under `CONTRACTS_DIR` for a new contract that has not been exported yet. Run the pinned
contracts' `script/v2/export-abis.sh --callhouse <this checkout> --check` before treating a rehearsal as
release evidence.
