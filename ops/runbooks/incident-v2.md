# Runbook — v2 incidents

Nine failures of the v2 protocol worth having written down: an oracle dispute, a settlement that does
not finish, payout conversion failing, a bot key compromise, an admin key compromise, an issuer
freezing one of our contract addresses, a broken or stalled Chainlink feed, an AutoRoller ask the market
overtook, and writer rent set wrong. Each one: **detect** (which alert, which read), **do** (the
exact command and who can send it), **do not**.

The v1 runbook (`incident.md`) still covers the v1 factory markets in run-off and the chain-level
failures both versions share (§7 sequencer, §8 RPC). The alert kinds named here are in
`ops/alerts.md` "v2": `v2_*` come from the bots (`keeper/src/v2/`), `v2_mon_*` from the external
monitor (`ops/v2/monitor.mjs`).

Four facts to hold on to (callhouse-contracts `docs/V2-ARCHITECTURE.md` §2, §4, §5):

1. **Every lifecycle call is permissionless.** `snapshot`, `finalize`, `settle`, `redeem`,
   `redeemBatch`, `prune` and `roll` need no role. A dead cranker is an inconvenience: anyone with gas
   can do its work (§2 below has the commands).
2. **The guardian delays, it never redirects.** `veto`, `setMintPaused`, `setCreatePaused`,
   `setTradingPaused`. No guardian function touches a balance. `close`, `withdraw`, `redeem`,
   ERC-1155 transfers, `cancel`, `prune` and `claimOwed` have no pause at all.
3. **The admin configures the settlement of every expiry that has no series yet, and of no other.**
   The first series of an expiry pins the oracle's source list, deviation and delay and each source's
   feed, pool and floor for it (INTERFACE_VERSION 6: `SettlementConfigPinned`, `settlementConfig`), so
   `setMarket`, `setFeed` and `setPool` reach only expiries nobody created a series for. Capture at
   the first `finalize` (from `E + 120 s`) then records the pinned sources' prices. Nothing on chain
   delays an admin change except an OrderBook fee change, which takes effect 24 h after it is scheduled
   (no timelock otherwise; one hot key holds the role, an owner decision).
4. **A final price is final.** `veto` and `adminResolve` revert `AlreadyFinal`; nobody can re-open it.

**Keys never reach a command line.** `cast`'s `--private-key` takes the value as an argument, so the
shell expands the key into `cast send`'s argv and `ps -axww` shows it to every user on the machine for
as long as the send runs. Every command below names a Foundry keystore account instead (`--account`,
which prompts for the password and reads the key from the encrypted file). Import each key once, on the
machine that holds it:

```bash
cast wallet import admin    --interactive   # hot wallet account 0; paste the key, set a password (nothing echoes)
cast wallet import guardian --interactive   # hot wallet account 2
cast wallet import ops      --interactive   # any funded key that holds no role, for the permissionless calls
cast wallet list                            # the three names; `cast wallet address --account admin` checks one
```

They live in `~/.foundry/keystores`, encrypted with that password. `--account` is also
`ETH_KEYSTORE_ACCOUNT`, so `export ETH_KEYSTORE_ACCOUNT=admin` works for a run of admin commands.

---

## Shell setup

```bash
# from the app repo root
REG=ops/markets/tier1.json
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
eval "$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const c = r.v2.contracts;
const v = { USDG: r.shared.usdg, CH: c.clearinghouse, BOOK: c.orderBook, ORACLE: c.settlementOracle, CAL: c.expiryCalendar,
  REWARDS: c.keeperRewards, ROLLER: c.autoRoller, ADAPTER: c.payoutAdapter, VAULT: c.makerVault, DIST: c.rewardsDistributor,
  CL_SRC: c.sources.chainlink, UNI_SRC: c.sources.univ3, DS_SRC: c.sources.dataStreams,
  // INTERFACE_VERSION 8. The registry key is `quoter`, not `mmQuoter` (ops/markets/build-markets.mjs:243):
  // the old spelling exported an EMPTY QUOTER and every cast below ran against nothing.
  CRANKER: r.v2.bots.cranker, PRICER: r.v2.bots.pricer, QUOTER: r.v2.bots.quoter, GUARDIAN: r.v2.bots.guardian,
  // What a v8 role operation needs: the manager holds every role, the flywheel is where BUYBACK acts,
  // and the two Safes are who signs (ops/runbooks/v8-roles.md, ops/runbooks/v8-safes.md).
  MANAGER: c.accessManager, SPLITTER: r.v2.flywheel.feeSplitter, BUYBACK_EXEC: r.v2.flywheel.buybackExecutor,
  SAFE_ADMIN: r.shared.safes.admin, SAFE_TREASURY: r.shared.safes.treasury };
for (const [k, x] of Object.entries(v)) console.log(`export ${k}=${x ?? ""}`);' "$REG")"
T=NVDA   # the market in the alert (data.ticker)
eval "$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const m = r.markets.find((x) => x.ticker === process.argv[2]);
console.log(`export ASSET=${m.asset} FEED=${m.feed} POOL=${m.v2.univ3Pool ?? ""}`);' "$REG" "$T")"
# v7 run-off ONLY. These are AccessControl role hashes on the v7 contracts, which still hold roles
# while v7 runs off. No v8 target holds a role: on a v8 deployment every grant/revoke/hasRole is a
# uint64 role id on $MANAGER, read out of ops/abis/v2/roles.json — ops/runbooks/v8-roles.md §0.
export GUARDIAN_ROLE=0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041
export PRICER_ROLE=0xc6823861ee2bb2198ce6b1fd6faf4c8f44f745bc804aca4a762f67e0d507fd8a
export QUOTER_ROLE=0x9a04aea0a349253cc7277afafdf6ead6729a3972a47ffb40eaef2c93d4e1bfea
# v8: the same four readers ops/runbooks/v8-roles.md §0 defines, so a role id is never retyped.
ROLES=ops/abis/v2/roles.json
rj() { ROLES="$ROLES" node -e '
  const r = JSON.parse(require("fs").readFileSync(process.env.ROLES, "utf8"));
  const [what, name] = process.argv.slice(1);
  const table = { id: r.roles, delay: r.delaysS, admin: r.roleAdmin, guardian: r.roleGuardian }[what];
  if (!(name in r.roles)) throw new Error(`${name} is not a role in ${process.env.ROLES}`);
  if (!(name in table)) throw new Error(`${name} has no ${what} in ${process.env.ROLES}`);
  process.stdout.write(String(table[name]));' "$1" "$2"; }
rid() { rj id "$1"; }; rdelay() { rj delay "$1"; }; radmin() { rj admin "$1"; }; rguard() { rj guardian "$1"; }
E=<the expiry, unix seconds: data.expiry of the alert>

# reading a service's private endpoint: *.railway.internal resolves only inside the Railway private
# network, and no image installs curl or wget (keeper and indexer are bookworm-slim; relay, notifier
# and web are alpine, so busybox wget is theirs alone). node is in every image, so the request is made
# from inside a container. Same helper as ops/deploy.md §15.7 step 9; it prints "<status> <body>".
probe() { railway ssh --service "$1" -- node -e "fetch('$2').then(async r=>console.log(r.status,(await r.text()).slice(0,4000))).catch(e=>console.log('ERR',e.message))"; }

# the whole picture first: every monitor check, nothing sent, the state file untouched
node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts
```

`--no-alerts` keeps no cursor, so this run scans the whole chain from `v2.deployBlock` every time: minutes
once the deploy is months old, and the `scan` line says how many ranges it read. Cap it with
`--threshold maxRangesPerRun=200` if you only need the recent picture — the run then covers 2,000,000
blocks from the deploy block (about 56 h of this chain) and says so, and series created after that window
are invisible to it.

The settlement reads every section below uses (prices are USDG base units per whole share, 6 dp;
status `0` None, `1` Pending, `2` Finalized, `3` Held):

```bash
cast call $ORACLE "settlementInfo(address,uint40)(uint8,uint256,uint8,bool,bool,bool)" $ASSET $E --rpc-url $RH_RPC
#   status, price, sourceIndex, corroborated, resolved, captured
cast call $ORACLE "candidate(address,uint40)(uint256,uint8,bool,uint40)" $ASSET $E --rpc-url $RH_RPC
#   price, sourceIndex, disagreed, finalizableAt (all zero: no candidate)
cast call $ORACLE "recordedSources(address,uint40)(address[],bool[],uint256[],uint16)" $ASSET $E --rpc-url $RH_RPC
#   the captured sources, which were ok, their prices, the pinned deviation (bps)
cast call $ORACLE "marketConfig(address)(address[],uint16,uint32,uint32)" $ASSET --rpc-url $RH_RPC
#   sources today, maxDeviationBps, uncorroboratedDelay, spotMaxAge
cast call $CL_SRC "windowPrice(address,uint40,uint40)(bool,uint256)" $ASSET $((E-1800)) $E --rpc-url $RH_RPC
cast call $UNI_SRC "snapshots(address,uint40)(uint128,int24,uint40)" $ASSET $E --rpc-url $RH_RPC   # recordedAt 0: no snapshot
cast call $ORACLE "resolveBand(address,uint40)(bool,uint256,uint256)" $ASSET $E --rpc-url $RH_RPC  # adminResolve's band
cast call $CH "openInterest(address,uint40)(uint256)" $ASSET $E --rpc-url $RH_RPC
cast block latest -f timestamp --rpc-url $RH_RPC
```

**The independent price.** A settlement price is per Stock Token, and a Stock Token's price includes
its multiplier: reference = the primary exchange's official closing price for the session that ends
at `E` (NVDA: the Nasdaq Official Closing Price; an early-close day closes at 13:00 New York) ×
`uiMultiplier() / 1e18` (`cast call $ASSET "uiMultiplier()(uint256)" --rpc-url $RH_RPC`). Cboe's
delayed `current_price` includes after-hours trades and is not the close.

---

## 1. Oracle dispute

A candidate price you believe is wrong: the sources disagree, one source prints something the other
does not, or a single-source (Chainlink-only) market's only candidate is off.

### Detect
- `v2_mon_sources_disagree` / `v2_sources_disagree` (cranker): Pending, `disagreed = true`; it
  finalizes at `finalizableAt` (expiry + 120 s + the market's delay, 6 h by default) unless vetoed.
- `v2_mon_settlement_late` **warn** on a two-source market: not corroborated 2 h after expiry (the pool
  snapshot was missed, or the pool window was not ok), a single candidate is waiting its delay.
- On a **Chainlink-only market every expiry is a single-source candidate** and pages nothing by design:
  comparing it with the reference is the operational duty `V2-ARCHITECTURE.md` §6.4 names. Check each
  one before its `finalizableAt`.
- Context that makes a bad print likely: `v2_mon_feed_round_jump`, `v2_mon_multiplier_updated` /
  `v2_mon_multiplier_staged` (a feed can lag a multiplier step by its heartbeat), `v2_mon_oracle_paused`,
  `v2_mon_feed_aggregator_changed`.

### Do
1. Read the candidate, the recorded sources and the reference (shell setup). Note `finalizableAt`:
   everything below must happen before it.
2. **Candidate within the pinned deviation of the reference** (150 bps by default): do nothing. The
   cranker finalizes at `finalizableAt`; `v2_mon_settlement_late` turns error 15 min after that if it
   does not.
3. **Candidate wrong**, or you cannot establish the reference before `finalizableAt` and something is
   visibly broken (a jump, a multiplier step or a pause inside the window): the guardian vetoes.
   ```bash
   cast send $ORACLE "veto(address,uint40)" $ASSET $E --rpc-url $RH_RPC --account guardian
   cast call $ORACLE "settlementInfo(address,uint40)(uint8,uint256,uint8,bool,bool,bool)" $ASSET $E --rpc-url $RH_RPC   # status 3
   ```
   `v2_mon_settlement_held` (error) fires on the next monitor run: that is the confirmation, not a
   new incident.
4. Publish within the hour: which expiry, that its payouts wait, why.
5. While held, three ways out (V2-ARCHITECTURE §3.4):
   - **Corroboration still finalizes a held expiry.** If a late source upgrades and two ok sources
     agree, the next `finalize` settles it at the agreeing price. Nothing to do.
   - **The candidate was right after all:** unveto. The delay restarts from now.
     ```bash
     cast send $ORACLE "unveto(address,uint40)" $ASSET $E --rpc-url $RH_RPC --account guardian
     ```
   - **It stays wrong:** the admin resolves from `E + 48 h`, inside the band of the captured ok
     prices (any price when no source was ok). Read the band first; pick the reference if it is inside,
     else the band edge nearest it.
     ```bash
     cast call $ORACLE "resolveBand(address,uint40)(bool,uint256,uint256)" $ASSET $E --rpc-url $RH_RPC
     cast send $ORACLE "adminResolve(address,uint40,uint256)" $ASSET $E <price, 6 dp> --rpc-url $RH_RPC --account admin
     ```
6. Then settle and redeem (the cranker does it within a poll; §2 has the manual commands).

### Do NOT
- Do not veto a corroborated or correct candidate to "be safe": every holder of that expiry waits,
  and a veto buys nothing a later `unveto` does not undo with a fresh 6 h delay.
- Do not change `setMarket`, `setFeed` or `setPool` to fix a disputed expiry. An expiry with series
  settles on its pin whatever they say now; the change reaches only expiries without series, whose
  first series would then pin a configuration the registry does not publish (`v2_mon_pin_mismatch`,
  §5).
- Do not `adminResolve` at a price you cannot justify with the reference and the band read. The
  resolution is final.

---

## 2. Paused settlement

An expiry with open interest that is not settling: no candidate, held, a candidate nobody finalizes,
or finalized but series not settled or holders not paid.

### Detect
- `v2_mon_settlement_late` **error**: status None 2 h after expiry (no source prices the window), or
  Pending 15 min past `finalizableAt` (nobody calls `finalize`).
- `v2_mon_settlement_held`: vetoed (§1).
- `v2_mon_snapshot_missed`: the pool cannot vote for that expiry (Chainlink alone, after the delay).
- `v2_mon_series_unsettled` **error**: the oracle finalized the expiry an hour or more ago and some of
  its Clearinghouse series are still unsettled (`data.unsettled` holds the long ids). Redeem reverts
  `NotSettled` for those series, and `v2_mon_redeem_backlog` cannot see them: it follows `SeriesSettled`.
- `v2_mon_redeem_backlog`: settled 6 h ago and redeemable holders (or the book's escrow) are left.
- `v2_settle_stuck`, `v2_redeem_backlog`, `v2_error` from the cranker; `v2_mon_service_down` for
  `cranker` (its `/health`).
- Underneath: `v2_mon_oracle_paused` (the Chainlink source and spot fail closed), a stale feed
  (`v2_mon_feed_stale`, §7),
  `v2_mon_feed_access_controller`, `v2_mon_l2_lag` (a stalled sequencer: `incident.md` §7).

### Do
1. Read status, candidate and the window prices (shell setup). Then:

| status | window prices | cause | action |
|---|---|---|---|
| None | none ok | `oraclePaused` or a feed access controller at the time; or the round in force was stale (older than `maxStale`); or more than 96 rounds printed since the window; or the pool window was thin / not snapshotted | a transient cause (`oraclePaused`, a refused read): `finalize` again once it lifts, every not-ok source is asked again. A stale or out-of-reach window never becomes ok: the admin resolves from `E + 48 h` at the reference (any price is accepted when no source is ok: be exact) |
| None | some ok | nobody called `finalize` | call it (below) |
| Pending | — | before `finalizableAt`: the delay (§1); after it: nobody called `finalize` | before: §1 step 2; after: call it |
| Held | — | vetoed | §1 step 5 |
| Finalized | — | series not settled, or holders not redeemed | settle, prune, redeem (below) |

2. **The cranker is down or wedged:** `probe cranker http://cranker.railway.internal:8792/health` from inside the
   project (503 `wedged`, or no answer), its logs, `railway logs --service cranker`. Restarting it is safe at
   any point (it re-reads the chain and its log index). Its key holds no role (`ops/deploy.md` §15.4).
3. **Do its work by hand** from any funded key (the `ops` keystore account, which holds no role).
   Fixed gas limits, always: `finalize`, `settle`, `prune` and `redeemBatch` swallow an inner
   out-of-gas or a per-item revert, so an estimated limit can "succeed" having done nothing, and an
   over-long batch silently skips its tail inside a successful transaction. **Send at most the batch
   sizes below and check the result after every batch.**

   `cast call` prints any uint256 from 10000 up with a scientific-notation tail (`10234 [1.023e4]`),
   which neither a shell loop nor `cast`'s own array parser can read. `--json` prints the raw digits;
   this helper turns any `uint256[]` return — alone, or first in a tuple — into one id per line:

   ```bash
   ids() { cast call "$@" --rpc-url $RH_RPC --json | tr -d ' \n"' | sed 's/^\[//; s/^\[//; s/\].*$//' | tr ',' '\n' | grep -v '^$'; }
   ```

   ```bash
   cast send $ORACLE "snapshot(address,uint40)" $ASSET $E --gas-limit 800000 --rpc-url $RH_RPC --account ops     # only inside [E, E+600]
   cast send $ORACLE "finalize(address,uint40)" $ASSET $E --gas-limit 1500000 --rpc-url $RH_RPC --account ops
   # each series of the expiry (long ids from the indexer's /v2/markets/$T/series or the SeriesCreated logs):
   cast send $CH "settle(uint256)" <longId> --gas-limit 1500000 --rpc-url $RH_RPC --account ops
   cast call $CH "series(uint256)((address,bool,uint40,uint128,address,uint16,bool,uint128,uint128,uint128,uint128))" <longId> --rpc-url $RH_RPC   # field 7 settled = true

   # prune the series' open orders BEFORE redeeming (resale asks hand escrowed longs back; the book
   # cannot be redeemed). 25 ids per call: pruneBase 60k + 80k per order (cranker constants.ts).
   ids $BOOK "ordersOfSeries(uint256,uint256,uint256)(uint256[],uint256)" <longId> 0 200 | xargs -n 25 | tr ' ' ',' |
     while read -r chunk; do
       cast send $BOOK "prune(uint256[])" "[$chunk]" --gas-limit 2100000 --rpc-url $RH_RPC --account ops
     done
   ids $BOOK "ordersOfSeries(uint256,uint256,uint256)(uint256[],uint256)" <longId> 0 200   # empty when done; re-run the loop if not

   # holders from /v2/series/<longId>/holders; longs, then shorts (shortId = longId + 1).
   # 40 holders per call paid in kind (180k each), but only 15 when the longs are ITM calls converted
   # to USDG through the PayoutAdapter (450k each) — redeemBatch skips what does not fit, silently.
   cast send $CH "redeemBatch(uint256,address[])" <tokenId> "[<up to 40 holders>]" --gas-limit 8000000 --rpc-url $RH_RPC --account ops
   for h in <the holders of that batch>; do cast call $CH "balanceOf(address,uint256)(uint256)" $h <tokenId> --rpc-url $RH_RPC; done   # all 0
   cast call $CH "openInterest(address,uint40)(uint256)" $ASSET $E --rpc-url $RH_RPC   # 0 once every side is redeemed
   ```
   A balance that is still non-zero after its batch is either an opted-out holder (step 4) or an item
   the gas limit skipped: re-send that holder alone.

   Or first see exactly what the cranker would send, signing nothing (no key needed). Two values in
   the env file are written for the image and have to be overridden on a laptop: `V2_REGISTRY_PATH`
   points at `/app`, and `ALERT_WEBHOOK` points at Railway's private network, which makes the config
   demand `ALERT_WEBHOOK_TOKEN`. Run it from the repository root:
   ```bash
   ALERT_WEBHOOK= V2_REGISTRY_PATH=$PWD/ops/markets/tier1.json \
     KEEPER_ENV_FILE=<a copy of ops/v2/env/cranker.env with RH_RPC set> \
     pnpm --filter @callhouse/keeper v2:dryrun
   ```
4. **Holders who opted out of third-party redemption** are never pushed: they redeem themselves (or
   through an operator). They are not a backlog; the monitor does not count them (`data.optedOut`).
5. Publish if payouts are late by more than a few hours: what is paid, what waits, until when.

### Do NOT
- Do not send `snapshot`/`finalize`/`settle`/`redeemBatch` with an estimated gas limit.
- Do not redeem a series before its orders are pruned: the book's escrowed longs would stay unpaid
  (it opts out of third-party redemption) until someone prunes.
- Do not reach for `adminResolve` before the table says so: it is final, and on a None expiry with no
  ok source it accepts any price.

---

## 3. Payout conversion failing

In-the-money call longs are meant to be paid in USDG through the `UniV3PayoutAdapter` (unless the
holder chose in kind). A conversion that misses its floor, or cannot move the tokens, falls back to
paying the Stock Tokens in kind. Nobody loses value (the tokens are worth the payout at the settlement
price); holders get the asset they did not ask for, and pay gas-heavier redemptions for nothing.

### Detect
- Users report being paid Stock Tokens; the indexer's redemption rows show the underlying as the asset.
- On chain: `Redeemed(tokenId, holder, to, units, asset, amount, amountInKind, toLedger)` with
  `asset == $ASSET` for a call long whose holder's `payoutPrefs(holder).inKind` is `false`.
  ```bash
  cast logs --address $CH "Redeemed(uint256 indexed tokenId, address indexed holder, address to, uint64 units, address asset, uint256 amount, uint256 amountInKind, bool toLedger)" \
    --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 20000 )) --rpc-url $RH_RPC
  cast call $CH "payoutPrefs(address)(bool,bool)" <holder> --rpc-url $RH_RPC      # inKind, toLedger
  ```
- Causes the monitor names: `v2_mon_pool_liquidity_low` (thin pool: the swap misses `minOut`),
  `v2_mon_token_blocked` for `payoutAdapter` or `pool`, `v2_mon_token_paused`, `v2_mon_usdg_paused` /
  `v2_mon_usdg_frozen`.

### Do
1. Read the wiring:
   ```bash
   cast call $CH "payoutAdapter()(address)" --rpc-url $RH_RPC
   cast call $CH "maxPayoutSlippageBps()(uint16)" --rpc-url $RH_RPC
   cast call $ADAPTER "routes(address)(address,uint24)" $ASSET --rpc-url $RH_RPC       # pool 0x0: no route, always in kind
   cast call $POOL "liquidity()(uint128)" --rpc-url $RH_RPC
   cast call $POOL "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url $RH_RPC
   ```
2. **Pool moved or thin at the time of the redemption** (the common case): nothing to fix; the
   fallback did its job. If a deeper fee tier of the same pair exists, the admin can route there:
   `cast send $ADAPTER "setRoute(address,uint24)" $ASSET <fee> ...` (the factory must know the pool,
   and the tier must be at most 10000). The tier's fee is added to the conversion floor (30 bps + the
   route's fee: 35 bps on a 0.05 % pool, 60 on 0.30 %, 130 on 1 %). The monitor pages it as
   `v2_mon_route_changed` **error**, a pool the registry does not name: expected, acknowledge it, and
   remember that `RegisterMarkets` puts the registry's route back on its next run.
3. **Transfers blocked** (a token or USDG freeze or pause): §6. Conversions resume by themselves when
   the restriction lifts; there is no retry to run for payouts already made in kind.
4. **Conversions keep failing for a whole expiry and cost gas for nothing:** the admin may switch
   conversion off (every ITM call long is then paid in kind until it is switched back on):
   `cast send $CH "setPayoutAdapter(address,uint16)" 0x0000000000000000000000000000000000000000 0 ...`.
   Owner decision; publish it.

### Do NOT
- Do not raise `maxPayoutSlippageBps` to make conversions pass. The bound plus the route's fee (at
  most 100 bps counted) is capped at 300 bps, and whoever redeems can move the pool in the same
  transaction and take up to the bound of each converted payout (V2-ARCHITECTURE §6.8).
- Do not try to "re-convert" payouts already made in kind: the holder has the tokens.

---

## 4. Bot key compromise

Assume the key is in someone else's hands the moment it appears anywhere it should not (a log, a
paste, an image, a laptop you do not control). Rotation mechanics are in `ops/deploy.md` §15.4 and
§15.6; this section is what to do first.

**INTERFACE_VERSION 8: there are four bot keys, and every one of them holds a role.**
`ops/v2/derive-bot-keys.sh:55-58` fixes them as `cranker` 60, `pricer` 61, `quoter` 62, `guardian` 63,
and `ops/markets/build-markets.mjs:243-245` maps each to the manager role it holds at launch —
cranker → `BUYBACK`, pricer → `PRICER`, quoter → `QUOTER`, guardian → `GUARDIAN`. The role lives on
the `AccessManager`, not on the target, so **every revoke and grant below is a call on `$MANAGER`**
and the role is named, never a `bytes32`. The procedure, the reverts and the readers are
`ops/runbooks/v8-roles.md`; this section is which key, in what order, and what it can do meanwhile.

The four bot roles all have `OPS_ADMIN` as their role admin and `OPS_ADMIN` has no execution delay,
so a revoke and a re-grant are **one Admin Safe transaction with no waiting** (`v8-roles.md` §6).
Prove that before you rely on it:

```bash
for R in BUYBACK PRICER QUOTER GUARDIAN; do printf '%-9s admin %-10s delay %s\n' "$R" "$(radmin $R)" "$(rdelay $R)"; done
printf 'OPS_ADMIN delay %s\n' "$(rdelay OPS_ADMIN)"
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid OPS_ADMIN)" $SAFE_ADMIN --rpc-url $RH_RPC
```

**Detect.** Besides a key seen where it should not be: `v2_mm_not_quoter`, `v2_pricer_no_role` or
`v2_cranker_no_buyback_role` for a revoke nobody on the rota made (then the Safe did it: §5),
`v2_mon_manager_role` for a `RoleGranted` / `RoleRevoked` on the manager (`ops/alerts.md` §V53),
`v2_mm_killed` nobody sent, and `v2_tx_revert` / `v2_pricer_reprice_failed` / `v2_mm_tx_rejected`
with `NotAuthorized` (the role is gone). First checks for each: `ops/alerts.md` §V10c,
§V11a-§V11j, §V3.

### 4a. Cranker (`CRANKER_PK`, index 60): revoke `BUYBACK`
Under v8 the cranker is **no longer roleless**. Every lifecycle call it makes is still permissionless,
but it also holds `BUYBACK`, which is `FeeSplitter.buyback(uint256)` — the buy-and-burn leg. An
attacker with the key can spend its gas, collect bounties (capped per call at 1 USDG and by
`dailyCap`), and repeatedly fire the buyback at the worst moment inside whatever slippage and cap the
splitter enforces.

1. **Revoke first**, from the Admin Safe. Build the calldata, then sign it (`v8-safes.md` §4):
   ```bash
   cast calldata "revokeRole(uint64,address)" "$(rid BUYBACK)" $CRANKER     # to = $MANAGER
   cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid BUYBACK)" $CRANKER --rpc-url $RH_RPC   # false
   ```
   Nothing is lost while the role is gone: `claimOrderBookFees` and `distribute` are permissionless,
   so fees keep arriving and keep being split, and the splitter's buyback reserve simply grows
   (`ops/alerts.md` §V10c). The guardian's `FeeSplitter.setPaused` is the heavier alternative if the
   splitter itself is misbehaving.
2. Move the remaining gas out if you still can: `cast balance $CRANKER --rpc-url $RH_RPC`, then send it
   to the ops wallet from the compromised key (the only time that key is used again).
3. New key: §4d, with the `BUYBACK` re-grant of §4d step 6.
4. Watch `v2_mon_rewards_budget_low` and `KeeperRewards` `Rewarded` logs to the old address; if they
   drain the daily cap, lower `dailyCap` — that is `FEE_MANAGER` and it is **delayed**
   (`rdelay FEE_MANAGER`), so it is a schedule, not a send: `v8-roles.md` §4.

### 4b. Pricer (`PRICER_PK`, index 61): revoke the role
`PRICER` is `AutoRoller.reprice(address,address,uint128)` and nothing else. It can move every
smart-pricing writer's live ask anywhere inside that writer's own `[minAskBps, maxAskBps]` band,
repeatedly. It cannot touch funds or other writers.

1. **Revoke first**, from the Admin Safe (`v8-safes.md` §4 signs it; `to` = `$MANAGER`):
   ```bash
   cast calldata "revokeRole(uint64,address)" "$(rid PRICER)" $PRICER
   cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid PRICER)" $PRICER --rpc-url $RH_RPC   # false
   ```
2. Stop the `pricer` service (Railway) so it does not spin on `NotAuthorized` (`0xea8e4eb5`).
3. Look for damage: `Repriced(writer, underlying, oldOrderId, newOrderId, price)` logs on `$ROLLER` since
   the suspected time. Asks at a writer's band minimum are within that writer's consent; tell affected
   writers, who can `setStrategy` again or `stop`.
4. New key: §4d, with the `PRICER` re-grant of §4d step 6. Grant before the restart; the old key
   stays revoked.

### 4c. MM quoter (`MM_QUOTER_PK`, index 62): the Safe unwinds the vault
`QUOTER` covers the `MakerVault` quoter entry points — it quotes and trades the vault's inventory
inside on-chain guards (ask floor, bid cap, per-series and total caps, 16 live orders per series). It
**cannot move funds out of the protocol**: no quoter entry point names a recipient but the vault, and
the withdrawal entry points are `TREASURY_ADMIN`. The attacker can still trade the inventory badly,
repeatedly, until the role is gone. Per C2-11: revoke, cancel, withdraw.

**Two v8 facts change the order of this section.** Read them before you start:

```bash
ROLES="$ROLES" node -e '
const r = JSON.parse(require("fs").readFileSync(process.env.ROLES, "utf8"));
for (const [sig, role] of Object.entries(r.targets.MakerVault)) console.log(role.padEnd(15), sig);'
printf 'QUOTER delay %s   TREASURY_ADMIN delay %s\n' "$(rdelay QUOTER)" "$(rdelay TREASURY_ADMIN)"
```

1. The **Admin Safe is itself a `QUOTER` member** (`ops/abis/v2/roles.json` `holders.adminSafe`) at
   `QUOTER`'s delay, which is 0. That is what makes step 3 possible at all: the Safe can cancel the
   compromised key's orders the moment the key is revoked, with no scheduling.
2. `setLimits`, `withdraw` and `withdrawPosition` are **`TREASURY_ADMIN`, which is delayed**. The v7
   "spend freeze" was an instant admin call and it is not one any more (step 2b). Schedule the
   withdrawal the moment you know you need it; do not discover the delay at the end.

1. **Kill switch** if the mm-bot is still yours and answering: its authenticated `POST /kill` on private
   networking stores the kill (a restart stays killed) and cancels every vault order on every market
   (`v2_mm_killed`; the command is in `ops/alerts.md` §V11). It cancels with the same key, so it does
   nothing once the role is revoked: send it first, do not wait for its answer, go to 2. A kill switch
   you did not send means `MM_KILL_TOKEN` is out too: rotate it with the key (`ops/deploy.md` §15.4).
2. **Revoke the role.** One Admin Safe transaction, no delay, `to` = `$MANAGER` (`v8-safes.md` §4):
   ```bash
   cast calldata "revokeRole(uint64,address)" "$(rid QUOTER)" $QUOTER
   cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid QUOTER)" $QUOTER --rpc-url $RH_RPC   # false
   cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid QUOTER)" $SAFE_ADMIN --rpc-url $RH_RPC # true, 0
   ```
   The second read is the one that matters for the next steps: revoking the bot must not have touched
   the Safe's own membership, because the Safe is how the vault gets unwound.
2b. **The spend freeze is no longer an incident tool.** INTERFACE_VERSION 7 (c21) gave `Limits` a
   sixth field, `maxDailyOutflow` — the net USDG a quoter call may pay out per window — and setting
   it to 0 froze spending instantly from a hot admin key. Under v8 `setLimits` is `TREASURY_ADMIN`
   and carries that role's execution delay, so it **cannot stop anything today**; v8 also removed
   v7's admin exemption from the outflow cap, so the cap now applies to the Safe as well. Step 2 is
   the freeze now. Read the current state anyway — it tells you how much the attacker has already
   moved:
   ```bash
   cast call $VAULT "limits()((uint64,uint128,uint16,uint16,uint32,uint128))" --rpc-url $RH_RPC
   #   maxSeriesUnits, maxTotalNotional, askToleranceBps, maxBidBpsOfSpot, maxOrderLifetime, maxDailyOutflow
   cast call $VAULT "outflow()(uint256,uint256)" --rpc-url $RH_RPC        # used, available
   ```
   If a limits change really is the right answer, it is a scheduled `TREASURY_ADMIN` operation:
   `v8-roles.md` §4, and pass **all six** fields back with the first five unchanged — a five-field
   tuple does not encode at all (`cast` fails outright) and a wrong order silently sets the wrong
   limits. `LimitsSet` pages as `v2_mon_config_changed` (warn) and the outflow state as
   `v2_mon_vault_outflow` (warn, `ops/alerts.md` §V45).
3. **Cancel every live vault order**, from the Admin Safe as a `QUOTER` member (step 2's second read
   is why this works, and `cancel(uint256[])` is `QUOTER` in the manifest). `cast call` annotates any
   uint256 from 10000 up (`10234 [1.023e4]`), and OrderBook ids are a global counter, so the ids must
   come back as JSON or both loops break (the outer one iterates the annotations, and `cancel` fails
   with `parser error`). The `ids` helper is the one in §2 step 3:
   ```bash
   ids() { cast call "$@" --rpc-url $RH_RPC --json | tr -d ' \n"' | sed 's/^\[//; s/^\[//; s/\].*$//' | tr ',' '\n' | grep -v '^$'; }
   for s in $(ids $VAULT "trackedSeries()(uint256[])"); do
     oids=$(ids $VAULT "orderIdsOf(uint256)(uint256[])" "$s" | paste -sd, -)
     [ -z "$oids" ] || cast calldata "cancel(uint256[])" "[$oids]"      # one Safe transaction per series
   done
   for s in $(ids $VAULT "trackedSeries()(uint256[])"); do ids $VAULT "orderIdsOf(uint256)(uint256[])" "$s"; done   # empty when done
   ```
4. **Withdraw** what is free. Two different lanes, and the second one is not instant:
   - Clearinghouse ledger → vault is `withdrawFromClearinghouse`, which is **`QUOTER`**: the Safe
     sends it now, like step 3.
   - vault → treasury is `withdraw` / `withdrawPosition`, which is **`TREASURY_ADMIN`**: schedule it
     (`v8-roles.md` §4) and send it when the delay is up. Schedule it at the same time as step 3 so
     the clock is already running while you cancel.

   In v8 both withdrawal entry points lost their free `to` argument and pay the vault's pinned
   `treasury()` instead (`MakerVault.sol:312,332` at the contracts v8 tip). **`ops/abis/v2/MakerVault.json`
   still lists the v7 three-argument overloads beside the v8 ones**, so `cast` will happily encode
   `withdraw(address,uint256,address)` against a v8 vault and the send will revert. Use the
   two-argument forms, and confirm where the money goes first.
   ```bash
   cast call $VAULT "treasury()(address)" --rpc-url $RH_RPC          # must equal $SAFE_TREASURY
   cast call $CH "free(address,address)(uint256)" $VAULT $USDG --rpc-url $RH_RPC
   cast calldata "withdrawFromClearinghouse(address,uint256)" $USDG <amount>    # QUOTER: send now
   cast call $CH "free(address,address)(uint256)" $VAULT $ASSET --rpc-url $RH_RPC
   cast calldata "withdrawFromClearinghouse(address,uint256)" $ASSET <amount>   # QUOTER: send now
   cast calldata "claimOwed()"                                                  # QUOTER: USDG the book could not pay
   cast calldata "withdraw(address,uint256)" $USDG <amount>                     # TREASURY_ADMIN: schedule
   cast calldata "withdraw(address,uint256)" $ASSET <amount>                    # TREASURY_ADMIN: schedule
   ```
   Collateral locked in open short positions frees at settlement (redeemed by the cranker to the vault);
   withdraw it then.
5. Expect the pages and check them off as yours: `v2_mon_manager_role` for the revoke
   (`ops/alerts.md` §V53), `v2_mon_manager_operation` for the scheduled withdrawal (§V52), and
   `v2_mon_config_changed` for the vault's own `Withdrawn` (§V27).
6. New key: §4d, with the `QUOTER` re-grant of §4d step 6, and rotate `MM_KILL_TOKEN` with it
   (`ops/deploy.md` §15.4). Fund the vault again only after both — `MakerVault.deposit` is
   permissionless from INTERFACE_VERSION 8, so the Treasury Safe funds it with no role.

### 4d. Rotating a bot key: the order the tools accept

The four indices are fixed in `ops/v2/derive-bot-keys.sh:55-58` — **60 cranker, 61 pricer, 62 quoter,
63 guardian** — and the script rejects any other name outright
(`derive-bot-keys.sh:64`: `unknown bot '<x>' (cranker, pricer, quoter, guardian)`). Both tools refuse
a half-done rotation rather than re-point a bot at the wrong key. Do it in this order; any other
order stops at step 3 or step 7.

```bash
# 1. Burn the index: edit the bot's row in ops/v2/derive-bot-keys.sh to the next free one (64, 65, …).
#    Indices in use: 0 admin, 1 the NVDA keeper, 2 the v1 guardian, 10-43 the v1 market keepers,
#    50-52 the v7 bots (burned; v7 runs off beside v8 and its keys are never reused), 60-63 these.
# 2. Archive the old key file — the script never overwrites one (it would lose the only copy):
mv ~/.callhouse-keys/v2/<bot>.env ~/.callhouse-keys/v2/<bot>.env.burned-$(date -u +%FT%TZ)
# 3. Null the registry address by hand — the script refuses to re-point a non-null v2.bots entry:
node -e 'const f="ops/markets/tier1.json",fs=require("fs"),r=JSON.parse(fs.readFileSync(f,"utf8"));r.v2.bots["<bot>"]=null;fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n")'
#    For the guardian, null shared.guardian in the same edit: derive-bot-keys.sh:157 writes both and
#    build-markets.mjs --check refuses them different.
# 4. Derive. It writes the new key file (mode 600) and records only the address:
ops/v2/derive-bot-keys.sh <bot>
node ops/markets/build-markets.mjs --check
# 5. Commit and push the registry. go-live-v2.sh builds from a reviewed SHA and refuses when that
#    commit's tier1.json differs from the one it planned against, so the push comes before --apply.
# 6. On chain: fund the new address, then grant it its role on $MANAGER from the Admin Safe. The role
#    per bot is ops/markets/build-markets.mjs:243-245 — cranker BUYBACK, pricer PRICER, quoter QUOTER,
#    guardian GUARDIAN — and all four have OPS_ADMIN as role admin at no delay, so the revoke of
#    §4a/§4b/§4c and this grant are ONE Safe transaction (ops/runbooks/v8-roles.md §6):
R=<BUYBACK|PRICER|QUOTER|GUARDIAN>
REVOKE=$(cast calldata "revokeRole(uint64,address)"       "$(rid $R)" <old address>)
GRANT=$( cast calldata "grantRole(uint64,address,uint32)" "$(rid $R)" <new address> "$(rdelay $R)")
cast calldata "multicall(bytes[])" "[$REVOKE,$GRANT]"      # to = $MANAGER, signed per v8-safes.md §4
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid $R)" <new address> --rpc-url $RH_RPC
# 7. Set the key on Railway and redeploy from the same reviewed SHA:
ops/go-live-v2.sh --apply --ref <40-char SHA> --rotate-keys --services <cranker|pricer|mm-bot>
#    Seal the variable in the Railway UI when the run says so.
```

`--rotate-keys` alone replaces nothing: `go-live-v2.sh` reads the key file (or the pasted key) and
refuses it unless it derives to the address in `v2.bots.<bot>` **as pushed**, which is why steps 2-5
come first. `derive-bot-keys.sh` refuses at step 4 if either the old key file or the old registry
address is still there (`derive-bot-keys.sh:107-110` for the registry, `:114-124` for the key file).

`<bot>` is the registry name — `cranker`, `pricer`, `quoter`, `guardian` — and the old spelling
`mmQuoter` is gone from both the script and `ops/markets/tier1.json`. The Railway service name is
different again: `cranker`, `pricer`, `mm-bot`. **The guardian has no service.** It is a key a person
holds, not a process (`ops/go-live-v2.sh`'s service table has no row for it), so a guardian rotation
ends at step 6 and step 7 does not apply.

### 4e. Guardian (`GUARDIAN_PK`, index 63): it delays, it never redirects
The guardian hot key holds `GUARDIAN`, which is the pause-and-veto surface and nothing else. Read
what that is rather than remembering it:

```bash
ROLES="$ROLES" node -e '
const r = JSON.parse(require("fs").readFileSync(process.env.ROLES, "utf8"));
for (const [c, fns] of Object.entries(r.targets)) for (const [sig, role] of Object.entries(fns)) {
  if (role === "GUARDIAN") console.log(c + "." + sig);
}
console.log("cancels scheduled operations of:", Object.keys(r.roleGuardian).filter((k) => r.roleGuardian[k] === "GUARDIAN").join(" "));'
```

An attacker with this key can halt trading, minting and creation, veto settlements, clear a payout
route, pause the fee splitter, and **cancel any scheduled operation in the roles the manifest lists
above** — including the very operations you would schedule to respond. That last power is the reason
this is not a low-severity key: no guardian function touches a balance, but a hostile guardian can
keep cancelling a scheduled fix while pausing everything it can reach.

1. **Revoke first**, one Safe transaction, no delay (`v8-roles.md` §6). The Admin Safe is also a
   `GUARDIAN` member (`ops/abis/v2/roles.json` `holders.adminSafe`), so the pause and veto powers
   stay available to the rota throughout:
   ```bash
   cast calldata "revokeRole(uint64,address)" "$(rid GUARDIAN)" $GUARDIAN      # to = $MANAGER
   cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid GUARDIAN)" $GUARDIAN --rpc-url $RH_RPC   # false
   cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid GUARDIAN)" $SAFE_ADMIN --rpc-url $RH_RPC # true
   ```
2. Undo what it did: `unveto` any veto that was not the rota's, and unpause what it paused
   (`setMintPaused`, `setCreatePaused`, `setTradingPaused`, `FeeSplitter.setPaused`) — all `GUARDIAN`,
   so the Safe sends them now. A `PayoutRouter.clearRoute` is **not** undone this way: re-setting a
   route is `CONFIG_ADMIN` and delayed (`v8-roles.md` §4), and redeems fall back to in-kind meanwhile.
3. Re-schedule anything it cancelled. `cast logs --address $MANAGER "OperationCanceled(bytes32 indexed operationId, uint32 indexed nonce)"`
   since the suspected time, against your own change notes; a re-schedule takes the full delay again.
4. New key: §4d, with the `GUARDIAN` re-grant of §4d step 6. There is no service to redeploy.

### Do NOT
- Do not rotate the service's key before revoking the old one's role: the old key keeps its power
  until `revokeRole` lands.
- Do not publish the old key's address as "safe to reuse". A burned index stays burned.
- Do not send `grantRole(bytes32,address)` or `revokeRole(bytes32,address)` to a **target** contract.
  Under INTERFACE_VERSION 8 no target holds a role and every one of those calls reverts; the
  `$GUARDIAN_ROLE` / `$PRICER_ROLE` / `$QUOTER_ROLE` hashes in the shell block are v7 run-off only.
- Do not reuse a v7 bot index (50-52) for a v8 key. v7 runs off beside v8 and a shared key would make
  a v7 incident a v8 incident too.

---

## 5. Admin key compromise

One hot key holds `DEFAULT_ADMIN_ROLE` on every v2 contract (owner decision). Nothing on chain delays
it except an OrderBook fee change, which takes effect 24 h after it is scheduled. This is the worst case
in the system. What follows is what the key **can** and **cannot** do under INTERFACE_VERSION 6
(callhouse-contracts `docs/V2-ARCHITECTURE.md` §2.2, §6.6, §6.9, `SECURITY.md` "What a compromise of
each v2 key buys" and "Accepted risks"), what the monitor pages for each, then the response. §5a
(pre-pins and the pin wiring) and §5b (a scheduled fee change) are the two v6 cases in detail.

### What it can do
- **Choose the settlement configuration of every expiry that has no series yet.** Whatever
  `SettlementOracle.setMarket` (sources, deviation, delay), `ChainlinkFeedSource.setFeed` and
  `UniV3TwapSource.setPool` say when an expiry's first series is created is pinned for that expiry,
  and nothing changes it afterwards. That includes **a same-block sandwich around a first
  `createSeries`**: a hostile configuration set in the transaction before somebody's (the cranker's, an
  AutoRoller writer's) first series of an expiry and the honest one restored right after leaves the
  expiry pinned to the hostile one. It is public before anyone trades it (`SettlementConfigPinned`,
  `settlementConfig`), but it is final. Pages: `v2_mon_config_changed` **error** for each change
  (`MarketConfigured`, `FeedSet`, `PoolSet`), `v2_mon_pin_mismatch` for the pinned expiry.
- **List a source contract of its own** for expiries without series. The pin fixes a source's address,
  not its behaviour: its own contract can answer anything later. Pages: `v2_mon_config_changed`
  (`MarketConfigured`), then `v2_mon_pin_mismatch` (the sources differ) once a series pins it.
- **Block series creation**, a denial and never a price: the oracle's `clearinghouse` pointer zero or
  elsewhere (`NotAuthorized`), the oracle off a listed source's allow-list
  (`SourceNotPinned(source, NotAuthorized)`), a listed source unconfigured
  (`SourceNotPinned(source, NoSource)`), an empty list (`NoSource`), or a **pre-pin**: pinning an expiry
  before its first series through the pointer or a source's allow-list, which blocks that expiry while
  the pin differs from the configuration current at creation (`PinMismatch`,
  `SourceNotPinned(source, PinMismatch)`). Pages: `v2_mon_pin_blocked`, `v2_mon_oracle_clearinghouse`,
  `v2_mon_oracle_allowlist`, `v2_mon_pre_pin`, `v2_mon_pinned_by` (§5a).
- **Move `pinnedBy` of an expiry that has series without changing its price**: point the pointer at
  itself and pin through it (the confirmation records the new pinner). Its next series must confirm the
  pin again, which reverts while the configuration differs. Pages: `v2_mon_oracle_clearinghouse`,
  `v2_mon_pinned_by` (§5a).
- **Take the Data Streams source out of a pinned expiry** by changing its feed id (no market lists the
  source today): that expiry then settles on its other pinned sources alone. Pages:
  `v2_mon_data_streams_feed` (error while the source is listed anywhere).
- **Schedule fee changes with 24 h notice**, up to the ceilings (seller fee 10 % of premium, taker fee
  `min(1 USDG, 10 %)`), paid from `effectiveAt` by every take, fills of resting orders included.
  `TakeParams` has no fee limit, so a take mined from `effectiveAt` pays the new fees (the dapp caps
  deadlines at `effectiveAt - 1`). Pages: `v2_mon_fee_scheduled` (error when a fee rises),
  `v2_mon_fee_change_pending` (§5b).
- **Set the payout route and slippage within the ceilings**: `setRoute` to any factory pool of the pair
  at a tier up to 10000 (its fee, at most 100 bps counted, is added to the conversion floor), and
  `setPayoutAdapter` with a slippage bound up to 300 bps (bound + route fee at most 300 bps): each
  converted payout up to 3 % below its value at the settlement price, or paid in kind. Pages:
  `v2_mon_route_changed`, `v2_mon_config_changed` (`PayoutAdapterSet`).
- `adminResolve` a non-final expiry from `E + 48 h`, inside the band of its pinned sources' recorded ok
  prices (any price only when none of them ever answered); `unveto` a guardian veto. Pages:
  `v2_mon_config_changed` (`SettlementResolved` error, `SettlementUnvetoed` warn).
- Point **new** series at an oracle or calendar of its choosing (`setMarketConfig`, `setCalendar`):
  existing series keep theirs. Pages: `v2_mon_config_changed` error, `v2_mon_pin_mismatch`
  (`<asset>:market-oracle`). `spot` follows a configuration change at once (strike band, AutoRoller
  strikes, MakerVault guards).
- The treasury: `KeeperRewards.defund`, `MakerVault.withdraw` / `withdrawPosition`,
  `RewardsDistributor.defund` and a root that pays itself (`setRoot`, up to the balance).
- Every guardian power (it grants itself `GUARDIAN_ROLE`), and revoke ours.

### What it cannot do
- Move, freeze or seize a user's **free** collateral or tokens: no role can. `withdraw`, `close`,
  `redeem`, ERC-1155 transfers, `cancel`, `prune`, `claimOwed` have no pause.
- **Change the settlement configuration of an expiry that has series**: add, remove or reorder its
  sources, re-point, loosen or remove its Chainlink feed, re-point its pool or lower its floor, change
  its deviation or delay, or open `adminResolve` to any price by emptying the list. A pin it makes
  outside a series creation can only block that expiry, never be settled on.
- Change a **final** price, or a series' pinned oracle, exercise fee, strike or expiry.
- Bring a fee change in before 24 h, or bypass the compiled ceilings (fees, bounty 1 USDG, slippage
  bound + route fee 300 bps, route tier 10000, delays 30 min - 24 h, the 48 h resolve delay).

So the value at risk is the collateral of the series **created while the key is hostile** (their pinned
configuration is the attacker's choice), of held expiries it can resolve inside the band after 48 h,
up to 3 % of each converted payout, fees from 24 h after a schedule, and treasury balances. Series
pinned before the compromise settle on their honest pins. Users' free balances are not at risk.

### Detect
- `v2_mon_config_changed` **error** for any of: `MarketConfigured`, `FeedSet`, `PoolSet`,
  `MarketConfigSet`, `CalendarSet`, `PayoutAdapterSet`, `RoleGranted` / `RoleRevoked` /
  `RoleAdminChanged`, `CallerSet`, `FeeRecipientSet`, `Defunded`, `Withdrawn`, `PositionWithdrawn`,
  `SettlementResolved`; **warn** for limits, pauses, vetoes, bounties, roots. Every legitimate one is a
  planned owner action (a wave, a canary step, a rotation): if nobody owns it, this section applies.
- The v6 kinds, each with its own first checks (`ops/alerts.md` §V38-§V43): `v2_mon_pin_mismatch`
  (an expiry with series pinned to what the registry does not publish: the sandwich, or a hostile
  configuration at a first series), `v2_mon_pre_pin`, `v2_mon_pinned_by`, `v2_mon_pin_blocked`,
  `v2_mon_oracle_clearinghouse`, `v2_mon_oracle_allowlist`, `v2_mon_fee_scheduled` /
  `v2_mon_fee_change_pending`, `v2_mon_route_changed`, `v2_mon_data_streams_feed`.
- `v2_mon_feed_mismatch` (error): the oracle's Chainlink source reads a different feed than the
  registry names (it reaches the next first series).
- A `SettlementCandidate` or `SettlementFinalized` far from the reference (§1).

### Do (minutes matter: every first series created under a hostile configuration is pinned to it)
1. **Confirm** from the chain, not from the alert: `cast tx <hash> --rpc-url $RH_RPC` (`from` is the admin
   address?), then the current wiring:
   ```bash
   cast call $ORACLE "marketConfig(address)(address[],uint16,uint32,uint32)" $ASSET --rpc-url $RH_RPC
   cast call $CL_SRC "feeds(address)(address,uint32,uint16)" $ASSET --rpc-url $RH_RPC
   cast call $UNI_SRC "pools(address)(address,bool,uint8,uint32,uint128)" $ASSET --rpc-url $RH_RPC
   cast call $ORACLE "clearinghouse()(address)" --rpc-url $RH_RPC                     # must be $CH
   cast call $CL_SRC "isOracle(address)(bool)" $ORACLE --rpc-url $RH_RPC               # and $UNI_SRC, $DS_SRC
   cast call $BOOK "pendingFeeParams()((uint16,uint16,uint32,uint16,uint16),uint40)" --rpc-url $RH_RPC
   cast call $ADAPTER "routes(address)(address,uint24)" $ASSET --rpc-url $RH_RPC
   cast call $ORACLE "hasRole(bytes32,address)(bool)" $GUARDIAN_ROLE <our guardian> --rpc-url $RH_RPC
   ```
2. **Stop new pins and new risk with the guardian, now** (if the attacker has not revoked it yet).
   Creation first: no new series means no new expiry pinned to a hostile configuration (the cranker's
   and the AutoRoller's `createSeries` calls then revert `CreatePaused`, harmlessly).
   ```bash
   cast send $CH "setCreatePaused(bool)" true --rpc-url $RH_RPC --account guardian
   cast send $BOOK "setTradingPaused(bool)" true --rpc-url $RH_RPC --account guardian
   cast send $CH "setMintPaused(address,bool)" $ASSET true --rpc-url $RH_RPC --account guardian   # each market
   ```
3. **List the expiries pinned since the compromise.** Every expiry the attacker's configuration reached
   is a `v2_mon_pin_mismatch`, and every pin since the suspected block is a `SettlementConfigPinned` log:
   ```bash
   node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts --json | jq '.findings[] | select(.kind == "v2_mon_pin_mismatch" or .kind == "v2_mon_pinned_by" or .kind == "v2_mon_pin_blocked")'
   cast logs --address $ORACLE "SettlementConfigPinned(address indexed underlying, uint40 indexed expiry, address[] sources, uint16 maxDeviationBps, uint32 uncorroboratedDelay)" --from-block <suspected block> --rpc-url $RH_RPC
   cast call $ORACLE "settlementConfig(address,uint40)(bool,address[],uint16,uint32,uint32)" $ASSET $E --rpc-url $RH_RPC
   ```
   Those expiries settle on the attacker's pin and nobody can change it. Veto their uncorroborated
   candidates when they are wrong (§1 step 3); a corroborated path through two hostile sources cannot
   be vetoed. Expiries pinned before the compromise are safe: leave them alone, including finalizing
   them early (it changes nothing for a pinned expiry).
4. **Take the role back if you still can**, from a key the attacker does not have (there is none today:
   one hot key). If an uncompromised admin exists: `grantRole(DEFAULT_ADMIN_ROLE, <new>)` and
   `revokeRole(DEFAULT_ADMIN_ROLE, <compromised>)` on **every** contract (Clearinghouse, OrderBook,
   SettlementOracle, ExpiryCalendar, KeeperRewards, ChainlinkFeedSource, UniV3TwapSource,
   DataStreamsSource, AutoRoller, UniV3PayoutAdapter, MakerVault, MakerRegistry, RewardsDistributor).
5. **Restore the wiring** with that admin, then check it: the registry configuration through
   `RegisterMarkets` (sources, feeds, pools, routes), the oracle's pointer and the allow-lists (§5a step 3),
   a pending hostile fee change cancelled (§5b step 3). `node ops/v2/monitor.mjs --once --no-alerts`: the
   `pins` check clean except the expiries already pinned in step 3, which stay open for good.
6. **Move the treasury** out before the attacker does (admin powers, if the key is still ours too):
   `KeeperRewards.defund`, MakerVault (§4c steps 3-4), `RewardsDistributor.defund`.
7. **Tell users within the hour**: do not open positions; which expiries are pinned to a configuration
   that is not the published one (and settle on it); a pending fee change and its `effectiveAt`; that
   closing (`close` with both sides) and withdrawing free collateral work and cannot be paused; that
   final prices cannot be changed afterwards.
8. Afterwards: redeploy under a new admin (a Safe, not a hot key) and list what the plan should change
   (a delay on `setMarket` / `setFeed` / `setPool` so a sandwich cannot land inside one block).

### Do NOT
- Do not unpause anything, and least of all series creation, while the key is unaccounted for.
- Do not tell users funds are "safe": series pinned to the attacker's configuration are exposed.
- Do not try to out-race the attacker with `adminResolve`: it needs `E + 48 h` and the attacker holds
  the same role.
- Do not "fix" a pinned expiry by changing the market's configuration: a pin never changes, and the
  change only reaches the next expiries' first series.

### 5a. Pre-pins and the pin wiring

A series exists only with its expiry pinned, and pinning fails closed. So everything that breaks the
pin wiring stops series creation, and a pin made outside a series creation (a **pre-pin**) fixes a
configuration that the Clearinghouse's first series of that expiry must confirm: it reverts
`PinMismatch` / `SourceNotPinned(source, PinMismatch)` while the pin differs from the configuration
current at creation, and succeeds (taking the pin over) when they are equal. A pre-pin is never settled
on in secret, but it silently denies that expiry: the cranker's ladders and the AutoRoller's rolls to it
revert.

**Detect.**
- `v2_mon_pre_pin` (error, event): a `SettlementConfigPinned` without the Clearinghouse's
  `SeriesCreated` for the same expiry in its transaction (the pointer was moved), or a source's
  `FeedPinned` / `PoolPinned` without either (a source's allow-list).
- `v2_mon_oracle_clearinghouse` (error: the pointer is not the live Clearinghouse),
  `v2_mon_oracle_allowlist` (error: anything but the published oracle allowed, or the oracle removed).
- `v2_mon_pinned_by` (error): `pinnedBy(asset, E)` is neither 0 nor the Clearinghouse, for a creatable
  expiry or one with series.
- `v2_mon_pin_blocked` (error): the monitor's dry run of `SettlementOracle.pin(asset, E)` as the
  Clearinghouse reverts: `<asset>:unpinned` for every expiry nobody pinned (one dry run stands for them
  all), `<asset>:<E>` for an expiry pinned some other way. `data.revert` names the blocker.

**Do.**
1. Read the wiring and the expiry (`E` = `data.expiry`; `$DS_SRC` only if the market lists it):
   ```bash
   cast call $ORACLE "clearinghouse()(address)" --rpc-url $RH_RPC                       # must be $CH
   cast call $CL_SRC "isOracle(address)(bool)" $ORACLE --rpc-url $RH_RPC                 # true; also $UNI_SRC
   cast call $CL_SRC "isOracle(address)(bool)" <the account from the OracleSet log> --rpc-url $RH_RPC   # false
   cast call $ORACLE "pinnedBy(address,uint40)(address)" $ASSET $E --rpc-url $RH_RPC
   cast call $ORACLE "settlementConfig(address,uint40)(bool,address[],uint16,uint32,uint32)" $ASSET $E --rpc-url $RH_RPC
   cast call $CL_SRC "pinnedFeeds(address,uint40)(address,uint32,uint16,bool)" $ASSET $E --rpc-url $RH_RPC
   cast call $UNI_SRC "pinnedPools(address,uint40)(address,bool,uint8,uint32,bool,uint128)" $ASSET $E --rpc-url $RH_RPC
   cast call $ORACLE "pin(address,uint40)" $ASSET $E --from $CH --rpc-url $RH_RPC        # the dry run: a revert names the blocker
   # revert selectors: 0xea8e4eb5 NotAuthorized, 0x7d19c0ff NoSource, 0x52e8e6d6 PinMismatch, 0xf54720df SourceNotPinned:
   cast decode-error --sig "SourceNotPinned(address,bytes4)" <revert data>                 # the source, then its own reason selector
   ```
2. **Nobody on the rota moved the pointer or an allow-list**: §5 from step 1.
3. **Restore the wiring** (admin), the oracle back on every listed source's allow-list first:
   ```bash
   cast send $CL_SRC "setOracle(address,bool)" $ORACLE true --rpc-url $RH_RPC --account admin      # where it was removed
   cast send $CL_SRC "setOracle(address,bool)" <other account> false --rpc-url $RH_RPC --account admin
   cast send $ORACLE "setClearinghouse(address)" $CH --rpc-url $RH_RPC --account admin
   ```
   The monitor's next pass re-reads the pins (a wiring log invalidates its cache): the `unpinned` blocks
   resolve, and so does every pre-pin equal to the current configuration.
4. **An expiry stays blocked while its pin differs from the current configuration.** Leave it: the
   cranker's ladder creation on that expiry fails and the other expiries are unaffected, and an
   AutoRoller roll that targets it reverts until the roll moves past it; tell the writers concerned. Making the pinned configuration current to unblock it is an owner
   decision, and only for a pin identical to the registry's configuration (compare `settlementConfig` and
   the sources' pins with the registry row); never for any other.
5. `v2_mon_pinned_by` on an expiry **with series** whose configuration is unchanged clears when its next
   series is created (the Clearinghouse confirms the pin): nothing to fix.

**Do NOT.**
- Do not allow-list any account but the published SettlementOracle on a source, not even for a
  migration test: it can pre-pin every expiry of every market that lists the source.
- Do not unblock an expiry by making a pin current that you have not compared with the registry.

### 5b. A scheduled fee change

`OrderBook.setFeeParams` schedules; it never changes the fees at once. The change takes effect from the
first block with `block.timestamp >= effectiveAt` (the scheduling block + 24 h) for every take,
including fills of resting orders. A second schedule before `effectiveAt` replaces the first and
restarts the delay; scheduling the fees in effect is the only cancel. `TakeParams` has no maximum fee:
a take mined from `effectiveAt` pays the new fees, so the dapp caps every take's deadline at
`effectiveAt - 1` while a change is pending (`SECURITY.md` "Accepted risks").

**Detect.**
- `v2_mon_fee_scheduled` (event): **warn** when nothing rises, **error** when a fee rises or the maker
  rebate share falls (`data.rises`), or when the fees in effect before it could not be established.
- `v2_mon_fee_change_pending` (condition, warn / error on a rise): a pending change that no
  `v2_mon_fee_scheduled` announced (its log was adopted on the monitor's first run, or the state file
  was lost). It resolves when the change takes effect or is cancelled.

**Do.**
1. Read it: `cast call $BOOK "pendingFeeParams()((uint16,uint16,uint32,uint16,uint16),uint40)" --rpc-url $RH_RPC`
   (premium, resale, taker flat, taker cap, maker rebate; `effectiveAt`), `cast call $BOOK
   "feeParams()((uint16,uint16,uint32,uint16,uint16))" --rpc-url $RH_RPC`, and `cast tx <data.transactionHash>`.
2. **Planned** (an owner change): tell makers and AutoRoller writers now, with the new fees and
   `effectiveAt` (the notifier's channels, or a post); make sure the MM quoter requotes or cancels before
   `effectiveAt`, and that the dapp shows the pending schedule and caps take deadlines.
3. **Not planned**: §5. With an uncompromised admin, cancel it by scheduling the fees in effect (that
   is itself a 24 h schedule of unchanged fees and pages `v2_mon_fee_scheduled` warn, "cancels any pending
   change"):
   ```bash
   cast call $BOOK "feeParams()((uint16,uint16,uint32,uint16,uint16))" --rpc-url $RH_RPC   # the five values in effect
   cast send $BOOK "setFeeParams((uint16,uint16,uint32,uint16,uint16))" "(<premium>,<resale>,<taker flat>,<taker cap>,<rebate>)" --rpc-url $RH_RPC --account admin
   ```
   No admin to cancel with: before `effectiveAt`, the guardian pauses trading (`setTradingPaused(true)`),
   the MM bot is killed (`/kill`), makers are told to cancel (`cancel` never pauses), and `effectiveAt`
   and the new fees are published.

**Do NOT.**
- Do not send takes with a deadline at or after `effectiveAt` while a change is pending, from any
  integration: they pay whatever is in effect when they are mined.
- Do not reschedule a planned change "to correct it" without telling makers again: each schedule
  restarts the 24 h and pages again.

---

## 6. Issuer freeze of a contract address

The Stock Token issuer (pause, per-address blocklist on the token's `ACCESS_CONTROLLED_REGISTRY`,
`adminBurn`, `oraclePaused`) or the USDG issuer (pause, per-address freeze, wipe, burn) acts on one of
our contracts. There is no technical response: the contracts already degrade to "value waits", and
the job is to know exactly what still works and to say so.

### Detect
- `v2_mon_usdg_paused` (error), `v2_mon_usdg_frozen` (error for `clearinghouse` and `orderBook`, warn
  for `keeperRewards`, `autoRoller`, `payoutAdapter`, `makerVault`, `rewardsDistributor`).
- `v2_mon_token_paused` (error), `v2_mon_token_blocked` (error for `clearinghouse`, warn for
  `makerVault`, `payoutAdapter`, `pool`), `v2_mon_oracle_paused` (warn).
- Transactions reverting in the bots (`v2_tx_revert`), redemptions crediting ledgers instead of paying.
  ```bash
  cast call $USDG "paused()(bool)" --rpc-url $RH_RPC
  cast call $USDG "isFrozen(address)(bool)" $CH --rpc-url $RH_RPC      # and $BOOK $REWARDS $VAULT $ADAPTER $ROLLER $DIST
  cast call $ASSET "paused()(bool)" --rpc-url $RH_RPC
  REGY=$(cast call $ASSET "ACCESS_CONTROLLED_REGISTRY()(address)" --rpc-url $RH_RPC)
  cast call $REGY "isBlocked(address)(bool)" $CH --rpc-url $RH_RPC      # and $VAULT $ADAPTER $POOL
  cast call $USDG "balanceOf(address)(uint256)" $CH --rpc-url $RH_RPC    # a wipe or burn shows here (compare with the indexer's totals)
  cast call $ASSET "balanceOf(address)(uint256)" $CH --rpc-url $RH_RPC
  ```

### What still works, by case (V2-ARCHITECTURE §6.1, §6.2)

| Restriction | Stops | Keeps working |
|---|---|---|
| USDG paused | takes (premium moves in USDG), bid placement, USDG deposits/withdrawals, put and converted payouts, bounties | redemptions **credit the holder's ledger** (withdraw later), the book credits `owed`, `close`, `cancel`, `prune`, token transfers, in-kind Stock Token payouts, settlement itself |
| USDG freezes the Clearinghouse | the same for everything held there: put collateral, USDG ledgers, converted payouts | Stock Token collateral and in-kind payouts, settlement |
| USDG freezes the OrderBook | bid escrow, taker payments, `owed` claims | settlement, redemption, `close`, deposits/withdrawals of Stock Tokens |
| USDG freezes KeeperRewards / RewardsDistributor / MakerVault | bounties (pay 0, never block a call) / reward claims / vault USDG quoting | everything users do |
| Stock Token paused, or the Clearinghouse blocked on it | deposits/withdrawals of that token, in-kind payouts and conversions (both need the token to move) | redemptions **credit the ledger**, USDG legs, settlement |
| MakerVault / PayoutAdapter / pool blocked | vault quoting on that market / conversions (fall back in kind) | everything users do |
| `oraclePaused` | the Chainlink source and `spot`: rolls, vault quoting, strike-band checks | settlement on the pool alone (a delayed candidate), everything else |
| issuer wipe or burn of our balance | a shortfall: first come, first served until the balance runs out | nothing is haircut on chain; the last claimants' transfers fail and are credited to ledgers |

### Do
1. Confirm which address and which issuer (the reads above; the issuer's events: USDG `Freeze(account)`,
   Stock Token `Paused()` / `OraclePaused()`).
2. **Guardian: stop new risk on the affected market** so no new position is opened into a market that
   cannot pay: `setMintPaused(ASSET, true)` for a Stock Token restriction; `setTradingPaused(true)` for
   a USDG pause or a book freeze. Settlement, redemption, `close`, `cancel` and `prune` continue.
3. **Stop the bots from wasting gas**: the cranker keeps redeeming (credits to ledgers are correct and
   final for the holder); the mm-bot should be killed (`/kill`, `ops/alerts.md` §V11; it stops every
   market, not only the affected one); the pricer stops on its own when rolls fail.
4. **Publish within the hour**: what is restricted, what still works (the table), that ledger credits
   are withdrawable when the restriction lifts, that nothing is lost unless the issuer wipes.
5. Contact the issuer (Robinhood for Stock Tokens, Paxos for USDG) through the owner's channel; ask what
   triggered it (sanctions screening of a counterparty is the usual reason).
6. When it lifts: unpause (guardian), re-run `node ops/v2/monitor.mjs --once --no-alerts` (the
   conditions resolve), tell users to withdraw their ledger credits.

### Do NOT
- Do not redeploy or migrate collateral to "escape" a freeze: a freeze of the Clearinghouse freezes
  what is in it, and a new address can be frozen the same way.
- Do not settle v1 run-off accounts while USDG is paused or the v1 Clear is frozen or blocked (the v1
  keeper already holds them: `v1_settle_held`, `ops/runbooks/v1-runoff.md` step 8).
- Do not promise a date. The issuer decides.

---

## 7. Broken or stalled Chainlink feed

A market's Chainlink push feed stops printing. It may miss its 24 h heartbeat, miss the print at the 24/5
reopen, or stall while the price moves (the price network is down). The oracle keeps accepting the last
print for `spotMaxAgeS` (25 h, `ops/deploy.md` §15.13), so for up to a day nothing on chain notices: rolls
take their strike and ask from it, the MakerVault's bid cap and ask floor move with it, and a settlement
window prices on it while it is younger than `maxStale` (26 h) at the window's start. On 2026-09-11 at
00:00-00:01Z, 11 feeds printed jumps of up to 12 % that reversed at 01:49-01:52Z, and 25 of the 35 feeds
printed nothing in between.

### Detect
- `v2_mon_feed_stale` **error**: no round for the heartbeat + 1 h of open 24/5 market (a broken feed).
  **warn**: no print 15 min after the market reopened on Sunday or a holiday evening (`ops/alerts.md` §V44).
- `v2_mon_price_divergence` **warn**: configured per-market band breached by the Chainlink source and
  the pool's five-minute TWAP; **error**: breach on a second distinct monitor pass (`ops/alerts.md` §V48).
  This check requires a calibrated `MONITOR_DIVERGENCE_BANDS` value for that market. An unavailable
  pool gives no price comparison and does not by itself imply a faulty feed.
- Inside those bounds a stall shows only as a price that stops tracking the market. The pricing
  service refuses `spot-divergence` once the print is 300 bps from Cboe's (mm-bot `/state` halts
  `fair-unavailable: spot-divergence`, `v2_mm_pricing`, `v2_pricer_fair_unavailable`). A Chainlink print
  that disagrees with the pool, `v2_mon_sources_disagree` on an expiry that settled inside the stall, and
  many feeds silent at once (the monitor's `feeds` detail prints each feed's last round age) are other
  signs.
  ```bash
  cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC   # answer (8 dp), updatedAt
  cast block latest -f timestamp --rpc-url $RH_RPC
  cast call $ORACLE "trySpot(address)(bool,uint256,uint256)" $ASSET --rpc-url $RH_RPC            # ok, spot (6 dp), updatedAt
  cast call $UNI_SRC "latest(address)(bool,uint256,uint256)" $ASSET --rpc-url $RH_RPC            # the pool's 5-min TWAP, where there is one
  curl -s https://cdn.cboe.com/api/global/delayed_quotes/options/$T.json | node -e 'let b="";process.stdin.on("data",(c)=>b+=c).on("end",()=>{const d=JSON.parse(b).data;console.log(d.current_price,d.last_trade_time)})'
  node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts --all-markets --tickers $T               # the feeds line: last round age
  ```
  A Stock Token's price is the share price times `uiMultiplier() / 1e18` (shell setup): compare like with like.

### Do
1. **Confirm it is an incident.** A closed market (weekend, holiday) or a quiet feed inside its heartbeat
   is not one. Nor is a print within the feed's 0.5 % threshold of the price, however old.
2. **The print is wrong and the market is open: stop what trusts it on that market.**
   ```bash
   cast send $CH "setMintPaused(address,bool)" $ASSET true --rpc-url $RH_RPC --account guardian
   ```
   `AutoRoller.roll` then reverts `MintPaused`. `roll` is permissionless, so a stopped cranker would not
   stop it. No AskWrite fills either. Kill the mm-bot (`/kill`, `ops/alerts.md` §V11; it halts on its own
   only past 300 bps, and the kill stops every market). If the stall lasts, stop the `pricer` service:
   `reprice` moves a writer's ask inside the writer's band of the stale spot during regular hours;
   the pricer now skips outside `ExpiryCalendar.isRegularSession` by default.
   Bids, resale asks, `close`, `cancel`, `redeem` and withdrawals keep working on that market.
3. **A settlement window inside the stall.** The Chainlink window price is the print in force. Compare the
   candidate with the reference (§1 "The independent price"). A two-source market disagrees with the pool
   beyond 150 bps and waits; a single-source market waits its uncorroborated delay. Veto a wrong candidate
   (§1). If the round in force was older than 26 h at the window's start, the Chainlink source is not ok:
   §2's table.
4. **A missed reopen print (warn).** `spot()` is stale until the feed prints, so rolls, vault quotes and
   reprices on that market wait by themselves. Nothing needs pausing. Escalate if the feed is still
   silent at 09:00 New York.
5. **A missed heartbeat (error), or many feeds silent at once.** Report it to Chainlink and Robinhood
   through the owner's channel: the feed address, the last `roundId` and `updatedAt`, and which other
   feeds are silent.
6. **When the feed prints again** and its print matches Cboe and the pool: the monitor condition resolves
   on its next run. Then `setMintPaused(ASSET, false)` (guardian), `/resume` the mm-bot and start the
   pricer.

### Do NOT
- Do not change `spotMaxAgeS` during a stall. It prices no settlement, and `_sameConfig` compares it: an
  expiry already pinned would make a pin confirmation from another Clearinghouse revert `PinMismatch`.
- Do not `setFeed` the market to another feed under pressure. It reaches only expiries nobody pinned,
  and a Chainlink walk never crosses into a new feed's history.
- Do not reach for `adminResolve` before §2's table says so.

---

## 8. An AutoRoller ask the market overtook

INTERFACE_VERSION 7 (c16). An `AutoRoller` roll places one `AskWrite` at a price set from the spot at
roll time. If the market then rallies through the strike, that ask is still resting at its roll-time
price and anyone can take it **below intrinsic value**, at the writer's expense. v7 closed that with
`cancelStale(writer, underlying)`: **permissionless**, refuses to do anything unless a fresh `trySpot`
is at or past the strike, cancels the remainder, pays the `CANCEL_STALE` bounty (20,000, when the
remainder is at least `minRollUnits`), and leaves the position's `longId` and expiry in place so no
re-roll happens inside the period. The cranker runs it as its first step every tick.

`reprice` also refuses an in-the-money ask now (`InTheMoney`), so the pricer cannot walk one down, and
`roll` waits out a 30-minute open grace on a pre-open reading.

### Detect
`v2_mon_roller_ask_overtaken` (`ops/alerts.md` §V46): a tracked ask at or past its strike on an ok spot
for more than 60 s. **error** normally, **warn** when the writer revoked the roller's OrderBook delegate.

```bash
W=<data.writer>            # the alert carries writer, underlying, longId, orderId, strike, spot
cast call $ROLLER "position(address,address)(uint256,uint256,uint40)" $W $ASSET --rpc-url $RH_RPC
cast call $BOOK "getOrders(uint256[])((address,uint256,uint8,uint128,uint64,uint64,uint40,bool)[])" "[<orderId>]" --rpc-url $RH_RPC
#   maker, longId, kind, price, units, filled, validUntil, cancelled
cast call $ORACLE "trySpot(address)(bool,uint256,uint256)" $ASSET --rpc-url $RH_RPC      # ok, price, updatedAt
cast call $CH "series(uint256)((address,bool,uint40,uint128,address,uint16,bool,uint128,uint128,uint128,uint128,uint32,uint128))" <longId> --rpc-url $RH_RPC
cast call $BOOK "isDelegate(address,address)(bool)" $W $ROLLER --rpc-url $RH_RPC          # false: warn case
cast call $ROLLER "cancelStale(address,address)(bool)" $W $ASSET --rpc-url $RH_RPC        # a CALL: true = it would work
```

### Do
1. **Cancel it, from any funded key.** This is the whole fix, and it needs no role:
   ```bash
   cast send $ROLLER "cancelStale(address,address)" $W $ASSET --rpc-url $RH_RPC --account ops
   cast call $ROLLER "position(address,address)(uint256,uint256,uint40)" $W $ASSET --rpc-url $RH_RPC   # orderId 0
   ```
   Do it for every writer the monitor named; the call is idempotent and returns false when there is
   nothing to cancel.
2. **Then ask why the cranker did not.** One overtaken ask is a cranker problem, not a roller problem:
   check `v2_mon_service_down:cranker`, the cranker's `/health` and its own `v2_cranker_*` alerts, and
   whether its address still has gas. A cranker whose `stale` step reverts reports the writers it could
   not simulate.
3. **The warn case (delegate revoked)** is the writer's own position: `cancelStale` reverts
   `NotAuthorized` because the roller can no longer act on their orders. Nothing we run can cancel it.
   The ask expires with its `validUntil` or fills. Do not chase it; note it and let the condition resolve.
4. **If the ask filled before anyone cancelled it**, nothing is broken on chain: the writer sold a call
   at a bad price and keeps the premium. The position settles normally. Record it for the
   post-mortem — that is the loss c16 exists to prevent.

### Do NOT
- Do not pause trading or mint over this. The ask is one order; `cancelStale` is a single call and
  pauses do not stop it (it works under trading, mint and create pause, and on a disabled market).
- Do not `reprice` it down. `reprice` reverts `InTheMoney` for exactly this ask, on purpose.
- Do not take the ask yourself to "rescue" the writer. Buying it is the attack, whoever does it.
- Do not re-roll the writer inside the period. After a cancel the position keeps its `longId` and
  expiry: one roll and at most one ROLL bounty per period is the owner's default.

---

## 9. Writer rent (the v7 mint fee) wrong or missing

INTERFACE_VERSION 7 (c05). The writer fee is **rent on locked collateral**, not a cut of the premium:
`mint` charges `ceil(units × collateralPerUnit × mintFeePpm × (expiry − now) / (1e6 × 604800))` out of
free collateral, `close` refunds the same product **floored** to whoever closes, and `settle` moves
whatever is left to `accruedFees` (`MintFeesAccrued`). `premiumFeeBps` is **0** at launch, so rent is the
only fee a writer pays. Rates are per market, in `ops/markets/tier1.json` (V7-DESIGN §5.1), ceiling
`MINT_FEE_CEIL_PPM` 5,000.

**A market's rate is pinned into each series at creation and never changes after that.** `setMarketConfig`
reaches only series created **afterwards** — exactly like `oracle` and `exerciseFeeBps`. There is no way
to re-rate a live series, and no reason to want one: raising it later would re-price an option that is
already sold. The operational consequence, on the canary and at every market added after it: **register
a market at its rate before anything creates a series on it.** A market opened at 0 and corrected later
leaves behind series that are free for their whole life, and only `close` before expiry gets rent back.
On the canary itself the MakerVault writes almost every ask, so most of NVDA's rent is treasury paying
treasury and the revenue line is near zero by design (`ops/alerts.md` §V47); what the canary has to show
is the mechanics — a non-zero `Minted.fee`, a `Closed.feeRefund`, and `MintFeesAccrued` at the first
settlement.

### Detect
`v2_mon_mint_fee_zero` and `v2_mon_mint_rent` (`ops/alerts.md` §V47).

```bash
cast call $CH "market(address)((bool,bool,uint64,uint16,address,uint32))" $ASSET --rpc-url $RH_RPC
#   enabled, mintPaused, strikeTick, exerciseFeeBps, oracle, mintFeePpm   <- the sixth field is the rate
node -e 'const r=require("./ops/markets/tier1.json"),m=r.markets.find(x=>x.ticker===process.argv[1]);
  console.log(m.ticker, m.v2.mintFeePpm ?? r.v2.fees.mintFeePpm ?? "NONE", "ppm")' $T
cast call $CH "mintFee(uint256,uint64)(uint256)" <longId> 100 --rpc-url $RH_RPC      # what a 1-share mint costs now
cast call $CH "closeRefund(uint256,uint64)(uint256)" <longId> 100 --rpc-url $RH_RPC  # what closing it back pays
cast call $BOOK "feeParams()((uint16,uint16,uint32,uint16,uint16))" --rpc-url $RH_RPC # premiumFeeBps must be 0
```

### Do
1. **A live market at 0 ppm** (`<asset>:chain`). Writers are minting for free and every series created
   meanwhile is free for its whole life, so this is worth minutes, not hours. Set the registry's rate:
   ```bash
   cast call $CH "market(address)((bool,bool,uint64,uint16,address,uint32))" $ASSET --rpc-url $RH_RPC
   cast send $CH "setMarketConfig(address,(bool,bool,uint64,uint16,address,uint32))" $ASSET \
     "(true,false,<strikeTick>,<exerciseFeeBps>,$ORACLE,<ppm>)" --rpc-url $RH_RPC --account admin
   ```
   Pass all six fields, read back from the same call; the tuple grew in v7 and a five-field call does not
   encode. It pages as a `v2_mon_config_changed` (error) — expected. Series already created stay at 0;
   they expire at 0.
2. **Consider pausing mint on that market while it is wrong**, but only if the gap is large and the
   market is busy: `cast send $CH "setMintPaused(address,bool)" $ASSET true --rpc-url $RH_RPC --account guardian`.
   It stops new writing (`close`, `redeem`, cancels and settlement are never paused). Lift it in the same
   session as step 1.
3. **The registry has no rate** (`<asset>:registry`). Nothing is wrong on chain yet, but a deploy or a
   re-registration from that registry would charge nothing: fill in `markets[].v2.mintFeePpm` from the
   V7-DESIGN §5.1 table, run `node ops/markets/build-markets.mjs --check`, and push. This is the release
   blocker of `status/DECISIONS-2026-09-17.md` §11.
4. **A ledger that does not add up** (`v2_mon_mint_rent`, `accrual` or `free-mint`). First suspect the
   monitor, not the chain: the v6 `Minted` and `Closed` signatures carry no fee field at all, so a monitor
   left on them is the ordinary explanation (`ops/alerts.md` §V17). Confirm with
   `node --test ops/v2/monitor.test.mjs`, which compares the hand-written tuples with `ops/abis/v2`. If the
   monitor is on v7 and the sums still disagree, the accounting identity of `V2-ACCOUNTING` §3.3 is broken:
   stop creating series (`setCreatePaused`), keep the numbers, and raise it — nothing is being stolen
   (rent never leaves the Clearinghouse except through `sweepFees`), but the books are wrong.
5. **Rent the writers did not expect.** An `AskWrite` whose maker cannot cover collateral **plus** rent is
   skipped by the book, not reverted, so a writer who deposited exactly N shares writes `N × 100 − 1`
   units. That is the design, not an incident: the deposit needs rent headroom.

### Do NOT
- Do not try to re-rate a live series. The rate is pinned at creation; there is no function for it.
- Do not "fix" rent by raising `premiumFeeBps`. It is 0 on purpose (the premium fee was avoidable — that
  is what c05 replaced), it takes 24 h to take effect, and `premiumFeeBps > resaleFeeBps` is refused by
  every deploy gate.
- Do not sweep fees to make the numbers line up while a `v2_mon_mint_rent` alert is open. `sweepFees`
  moves `accruedFees` out; the evidence goes with it.

---

## 10. Pricing inputs: a series nothing can price, or a pricer that reprices nothing

F3 (O3-304). Three conditions that look alike on a dashboard and are not the same incident:

| It says | It means | It does NOT mean |
|---|---|---|
| `v2_mon_service_down` / `v2_mon_service_degraded` (`ops/alerts.md` §V36) | the **process** did not answer, or answered unhealthy | anything about whether a series can be priced |
| `v2_mon_quote_unready` / `v2_mon_pricing_reason_unknown` (§V49) | a **market or one of its tenors** has inputs nothing can quote from | the process is down; it is usually up |
| `v2_mon_pricer_idle` (§V51) | the pricer answers and has **done no work** for the window | the pricer is dead, or that anyone's ask changed |

Two of them can be open at once and neither stands in for the other. A healthy pricing process with an
unpriceable daily is the exact condition §V49 exists for (F3 D6: a healthy process alone does not make an
unpriceable daily series eligible).

### Detect

```bash
PRICING=http://pricing.railway.internal:8790; PRICER=http://pricer.railway.internal:8794
curl -s "$PRICING/health" | jq '{status, settings, chains: (.chains | map_values(.usable))}'
curl -s "$PRICING/surface/NVDA" | jq '[.expiries[] | {expiry, status}]'
curl -s "$PRICER/state" | jq '{ticks, lastTickAt, sessionOpen, hasRole, strategies, outcomes}'
# the same pass the monitor makes, printing everything and sending nothing:
node ops/v2/monitor.mjs --once --rpc $RH_RPC --pricing $PRICING --pricer $PRICER --no-alerts --json | jq '.checks.pricing, .notes'
```

### Do

1. **Read the tenor, not the market.** The alert key is `<TICKER>:daily` or `<TICKER>:weekly`. A daily
   failure is a daily failure however well the weeklies price, and it must never be closed because a
   market-level number looks fine. `data.failing` names every expiry and series, with its reason.
2. **`expiry-not-listed`.** A live series settles on an expiry the provider does not list at all. The
   series is real and will settle on the oracle as usual; what is missing is an input to quote it from.
   Stop automated quoting on that series (the MM cancels on a reasoned refusal already) and leave the
   ladder visible with an unavailable estimate. Do **not** disable the tenor in the registry to silence
   the alert: dailies are on for the selected markets by owner decision (F3 D10), and `expiriesAhead: 0`
   is a product change, not an incident action.
3. **A whole market refused** (`chain-stale`, `chain-inconsistent`, not carried). Every estimate of it is
   refused, so no series of it is quotable. This is a data-source incident: check the download
   (`chains.<T>.error`, `fetchedAt`) and §V50 for the observation clocks. The registry and the
   settlement path are untouched — settlement does not read the pricing service.
4. **`v2_mon_pricing_reason_unknown`.** The service stated a code this monitor does not know. It is
   treated as **not ready** (`02-interfaces.md` §5.1), which is the safe direction, and the code is in
   `data.codes` verbatim. Decide what it means with whoever shipped it, then add it to `PRICING_REASONS`
   in `ops/v2/monitor.mjs` in its own change — never suppress the alert by widening the set blindly.
5. **`v2_mon_source_switch`.** Find out whether a deploy caused it. A provider or method change that
   nobody deployed is an outage or a fallback, and the edge and half-spread were calibrated on the old
   input: widen or stop automated quoting on that market until the new input is qualified (F3 D2).
6. **`v2_mon_pricer_idle`.** Work backwards through `/state`: `sessionOpen: false` is correct behaviour;
   `hasRole: false` means `PRICER_ROLE` was revoked (§4b if that was not deliberate); every pair on one
   skip reason is a data problem that §V49 and §V50 already name; `strategies: 0` means nobody has opted
   in. Only after those is it the loop: `railway logs -s pricer | tail -50`.

### Do NOT

- **Do not treat a green `/health` as a priced market, or a red one as an unpriceable series.** They are
  different questions; that is why they are different alerts.
- **Do not read an unknown age as fresh.** An observation time the source does not state is `unknown`,
  never 0 (F3 D5). A refetch, a 304 or a HEAD advances ingestion time only and never makes an old
  observation new, so "we just refreshed it" is not evidence of freshness.
- **Do not close a daily failure because the weeklies pass**, and do not report a market as ready from a
  weekly-only check. No promotion merely because weekly coverage passed (F3 §5, stage 5).
- **Do not expect stopping the pricer to cancel or reset an ask.** It stops repricing; asks already placed
  keep their last price and can still fill. Cancelling is the writer's action (or `cancelStale` once the
  market has overtaken it, §8).
- **Do not set a source-age limit to make an alert stop.** `quoteAgeS` / `underlyingAgeS` /
  `volatilityAgeS` are operating policy derived from a measured session (F3 D5); 0 means the age is
  reported and nothing pages, which is the honest default until one is derived.
- **Do not point `--pricing` at a dev service while judging production, or the reverse.** Dev shares
  production contracts; the pricing service is read-only, but the readiness you record must name the
  deployment it came from.
