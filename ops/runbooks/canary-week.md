# Canary week

Written 2026-09-14 for the redesigned vault (write on fill, our own Valorem clearinghouse). Supersedes
`projects/callhouse/handoff-2026-09-13/CANARY-RUNBOOK.md`, which describes the pre-redesign Overcall
flow and must not be followed.

The canary is one real week on Robinhood Chain (4663) with the owner's own money, at the smallest size the
contracts allow: one call contract, one fill through the app's own fill page, optionally one exercise.
Everything except about 2 USDG of premium and fees comes back to the owner's wallets.

## Factory markets (read this first)

**Steps A–J below are the pooled vault's canary** (2026-09-14/15, `cNVDA`), kept as the record
of what was run. That vault is closed. **The live product is the per-market account factory**
(`src/solo/`: one `AccountFactory` per Stock Token, isolated `WriterAccount` clones, write on
fill, one FULL 1-lot Seaport order per lot). NVDA's factory has been live since block 64,038,234;
Tier 1 adds 34 markets in waves, and the **canary wave is TSLA and AAPL** (`ops/markets/tier1.json`
→ `waves.canary`). Each later wave runs this same page against its own tickers.

**The market loop.** As in `open-week.md`: read the live rows from `ops/markets/tier1.json`,
never type an address by hand. For the wave being canaried, the rows are `planned` until step 4
below flips them.

```bash
REG=ops/markets/tier1.json
WAVE=canary                                   # then wave1, then wave2
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
TICKERS=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.markets.filter(m=>m.wave===process.argv[2]).map(m=>m.ticker).join(" "))' "$REG" "$WAVE")
for T in $TICKERS; do
  eval "$(node -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const m=r.markets.find(x=>x.ticker===process.argv[2]);
    console.log(`FACTORY=${m.deployment.factory} ASSET=${m.asset} FEED=${m.feed} KEEPER=${m.deployment.keeper} MODE=${m.mode} STATUS=${m.status}`);
  ' "$REG" "$T")"
  echo "== $T status=$STATUS factory=$FACTORY asset=$ASSET feed=$FEED keeper=$KEEPER mode=$MODE"
  [ "$STATUS" = live ] || continue
  cast call $FACTORY "week()(uint32,uint256,uint40,uint40,uint256)" --rpc-url $RH_RPC
  cast call $FACTORY "writesHalted()(bool)"    --rpc-url $RH_RPC
  cast call $FACTORY "pendingCount()(uint256)" --rpc-url $RH_RPC
  cast call $FACTORY "liveCount()(uint256)"    --rpc-url $RH_RPC
done
```

**The factory canary, per wave** (the ordered version with every flag is `ops/deploy.md` §14.5):

1. `node ops/markets/build-markets.mjs --check` green. Keys derived and funded (~0.05 ETH each;
   `deployment.keeper` in the registry, keys under `~/.callhouse-keys/markets/`, never printed).
2. Contracts: `script/DeploySoloBatch.sh --wave $WAVE --rehearse --rpc http://127.0.0.1:8546`
   on an anvil fork started with `--code-size-limit 98304` (the registry defaults to
   `../callhouse/ops/markets/tier1.json` from the contracts root; pass `--registry` only as an
   absolute path); read the preflight (`EXPECTED_TICKER`, feed
   description / decimals / freshness, `uiMultiplier` / `oraclePaused`). Then `--broadcast --rpc $RH_RPC`,
   **by the owner**. `ConfigureSolo.s.sol` (`FACTORY`, `KEEPER` = the market's key, `GUARDIAN`,
   `ADMIN_PK`, `DEPOSIT_CAP`), `VerifySolo.s.sol` PASS per factory.
3. The batch wrote `deployment.factory` / `implementation` / `deployBlock` / `deployTx` (right
   after each deploy) and `sourcify` / `configuredAt` (after Configure + Verify) into the
   registry; set `status: "live"` on the wave's rows; commit.
4. Keepers: `ops/keeper-env.sh` → `ops/keeper/markets/<TICKER>.env`; `ops/keeper-railway.sh`
   (dry-run first); seal `KEEPER_PK` on each `keeper-<ticker>`; boot alert seen for each market.
5. Indexers: `indexer-<ticker>` with `FACTORY_ADDRESS`, `MARKET`, `START_BLOCK` = deploy block;
   `/ready` 200; `/v1/market` names the factory and ticker.
6. Web: `pnpm gen:markets`, commit, rebuild; `/<ticker>/account` and `/<ticker>/book` render; the
   switcher lists the wave. Docs: `node ops/markets/render-docs.mjs`, commit in callhouse-docs.
7. The week itself, on each market, with the owner's own wallets at the smallest size: an
   account, a deposit of 1 token, `requestWrite(1)`, the keeper's `setWeek` and `listFor`, one
   fill from a second wallet on `/<ticker>/book`, optionally one exercise, `settle()` after the
   account's expiry, `withdraw` and `claimUsdg`. The publish, including `unfilled, 0`.

**Wave gate.** The next wave's step 2 does not start until every box is ticked for every market
of this wave over one full weekly cycle:

- [ ] **zero keeper failures**: no `tx_revert`, `keeper_error` or `cycle_not_created` alert from any
      `keeper-<ticker>` for the cycle (`phase_stuck` is the vault process's alert; a factory
      keeper's "week not set" is `cycle_not_created`, and one whose reason is `stale-oracle` or
      `vol-stale` inside the Friday-close-to-Monday window is the one allowed exception);
      `/health` `ok` on each, `keeper.hasKeeperRole: true`
- [ ] **no stale-price skips outside the weekend windows**: a `stale-oracle` / `StalePrice` /
      `vol-stale` skip is
      acceptable only between the Friday close and the Monday feed restart (`ops/README.md`
      "Six things", item 5); a skip at any other time is a stop (a feed, not a market, is broken)
- [ ] **indexer complete and correct**: every `indexer-<ticker>` `/ready` 200, `/v1/market`
      returns this factory, ticker, week id and strike equal to `week()` on chain, and
      `/v1/market/fills` shows the canary fill
- [ ] **docs page regenerated**: `node ops/markets/render-docs.mjs --check` green after the wave
      went live and the page pushed; `build-markets.mjs --check` and `ops/keeper-env.sh --check`
      green
- [ ] the publish done per market; the owner has decided the next wave

A failed gate means another full cycle on the same wave after the fix, then the gate again.

---

## Why a canary when the fork runs pass

A fork of 4663 runs the real Seaport, the real Clear bytecode and the real tokens, but it cannot prove:

| Not provable on a fork | Why |
|---|---|
| The live Chainlink RHNVDA/USD feed during a real week | forks warp the clock, so every run swaps in a mock feed seeded with the live answer |
| A real assignment on chain 4663 | Valorem's exercise/assignment path has never run on this chain (integrations/valorem.md) |
| The Railway services, sealed variables, the keeper's volume and restarts | forks run the processes locally |
| The production keys, gas on a busy sequencer, L1 data cost | anvil keys and anvil gas |
| Sourcify verification and Blockscout display of our contracts | not reachable from a fork |
| The public RPC's limits under the keeper's real polling | anvil serves every request |

## Who does what

| Step | Who | When |
|---|---|---|
| A. Buy tokens, fund personal wallets | owner | any time before step D |
| B. Deploy contracts, verify, configure | Claude, with the owner's go-ahead | Mon–Thu, before Fri 10:00 ET |
| C. Railway go-live (web, indexer, keeper stopped) | Claude | right after B |
| D. Deposit 1.06 NVDA from the depositor wallet | owner, in the app | after C, before starting the keeper |
| E. Start the keeper; it creates the week's option type, arms and lists 1 contract | Claude | right after D, during US market hours |
| F. Fill 1 contract from the buyer wallet through the fill page | owner, in the app | after E, before Fri 16:00 ET |
| G. Optional: exercise 1 contract | owner | Fri 16:00 ET to Sat 16:00 ET |
| H. The week closes: lockBook, rollClose | keeper (anyone can) | Fri 16:00 ET, then Sat 16:00 ET |
| I. Redeem and claim USDG | owner, in the app | after H |
| J. Record the week, raise the cap if clean | Claude records; owner decides the cap | after I |

For this week the exercise window is **Fri 2026-09-18 16:00 ET to Sat 2026-09-19 16:00 ET**. If step E
cannot happen by Fri 10:00 ET the keeper picks the following Friday (2026-09-25) automatically: it
arms only when the exercise time is at least `KEEPER_ARM_LEAD_S` (6 h) away.

## A. Buy tokens (owner)

Two personal wallets on Robinhood Chain. They can be the same wallet; two makes the fill look like a
real buyer's. Never use the hot-wallet accounts 0–2 for this.

| Wallet | Needs | Approx. cost at spot 212.73 | Comes back |
|---|---|---|---|
| Depositor | **1.06 NVDA** + ~0.001 ETH gas | ~$226 | yes, redeemed after the week |
| Buyer | **2 USDG** + ~0.001 ETH gas | ~$2 | the premium credits back to the depositor, less the 5% fee |
| Buyer, only to exercise | **+ the week's strike in USDG** (about 223 at today's spot) | ~$223 | yes: the vault pays it back to the depositor as strike proceeds |

Why 1.06: the policy sizes contracts at 95% utilisation and one contract is one whole NVDA, so
`floor(deposit × 0.95)` must be at least 1. The smallest deposit that writes one contract is 1.0527 NVDA.

Where: on chain, no allowlist. The deepest pool is Uniswap NVDA/USDG
(`0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3`, about $7 M liquidity on 2026-09-14). Route: bridge a
little ETH to 4663, swap ETH to USDG, then USDG to NVDA. Distribution of Stock Tokens is restricted for
US persons under the issuer's prospectus; that is the owner's call.

| Token | Address on 4663 | Decimals |
|---|---|---|
| NVDA Stock Token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 |

Wallet network, if the wallet does not know the chain: chain id `4663`, RPC
`https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`, currency ETH.

## B–C. Deploy and go live (Claude)

Hot wallet, funded 2026-09-14 and re-checked before broadcasting:

| Role | Address | Funded |
|---|---|---|
| Admin, deployer, fee recipient (account 0) | `0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b` | 0.05 ETH |
| Keeper (account 1) | `0x06c131cfEd73A56893f5eB52D17252856FAFC1d2` | 0.02 ETH |
| Guardian (account 2) | `0x29741A8d283a253E8Ce10aDfd04C6507438b6F39` | 0.01 ETH |

Sequence, from `contracts/docs/DEPLOY.md` path A with our own clearinghouse. **Owner decision 2026-09-14: Clear's `feeTo` is a 1-of-1 Safe owned by the owner's personal wallet, not account 0.** `HandoverAdmin` never moves `feeTo`.

1. The contracts branch is merged, tagged `v1.0.0-rc1` and pushed; the app is merged and pushed.
2. Create the 1-of-1 admin Safe on 4663 from account 0, owner = `0x7A3a8C3F6331f63107D5b3aEeA0515e799022C32` (owner's personal wallet, given 2026-09-14; EOA, 0.27 ETH on 4663, nonce 0). Record the Safe address.
3. `DeployClear.s.sol` with `CLEAR_FEE_TO` = that Safe. Confirm `feeTo() == Safe` before Deploy. Record the Clear address.
4. `Deploy.s.sol` with `CLEARINGHOUSE` = that address, `ADMIN` = account 0, deposit cap 20 NVDA.
5. `Verify.s.sol` with `EXPECTED_CLEAR_FEE_TO` = the Safe (bootstrap), `Configure.s.sol` (keeper = account 1, guardian = account 2), `Verify.s.sol` again.
6. Sourcify verification for the Clear, both libraries and the vault; import on Blockscout.
7. `ops/addresses.json` filled in; Railway variables set per `ops/deploy.md`, including
   `KEEPER_PREMIUM_MARGIN_BPS=50`, `CLEARINGHOUSE` = our Clear on every service, no `ALERT_WEBHOOK`
   for the canary. Pricing is `KEEPER_PRICING_MODE=vol` by default (strike at delta 0.15 from Cboe's
   delayed quotes, ask at the market's fair value plus 10%, never under the floor with the margin);
   `KEEPER_PRICING_MODE=fixed` with `KEEPER_STRIKE_OTM_BPS=500` is the fallback if the feed is
   unusable (see `keeper/README.md` → Choosing the week). Web and indexer deployed; the keeper
   service created but **not started** until step D is done.

Record here after deploy:

| Contract | Address | Block |
|---|---|---|
| Admin Safe (1-of-1, holds Clear `feeTo`) | `0xff1454009F024507f3E455eb2027E98fAF4ccF61` | Safe create tx `0x69fbef45…` |
| Clear (ours) | `0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6` | DeployClear 2026-09-15 |
| SeaportOrderLib | `0x6B617a0B578Ef6EDCD07774468f08b3778272D8A` | 63467831 |
| ValoremLib | `0xd3CB94893EAb55e425cCd77Db98458b38D75Fa3d` | 63467856 |
| Vault | `0x88a98931E3682137E7e4D3426f623247f4A4ecbb` | **63467882** |

## D. Deposit (owner)

1. Open `https://app.stonkhouse.fun/vault/nvda`, connect the depositor wallet.
2. Deposit **1.06 NVDA**: approve, then deposit. The form must show the deposit as open.
3. Tell Claude the transaction hash.

Deposit first so the keeper's first listing already has capacity for one contract.

## E. Keeper arms and lists (Claude)

Start the keeper service during US market hours (Mon–Fri 09:30–16:00 ET) so the feed is fresh. Within
one poll (60 s) it should:

1. compute the Friday close; in vol mode fetch Cboe's delayed NVDA chain and take the listed call
   for that close at delta 0.15, clamped to at least 5% above spot (the 3% band floor plus the 200 bps
   buffer) and at most 11.5%, rounded to a whole USDG (fixed mode: about 5% above spot);
2. call `newOptionType` on our Clear;
3. call `rollOpen(optionId)` (arms only, writes nothing);
4. call `approveListing` for **1 contract** at max(the floor plus 0.5%, the market's fair value plus
   10%) (fixed mode: the floor plus 0.5%).

If the keeper logs `not arming this tick` with a `vol-*` reason (a `cycle_not_created` alert in
SQLite), the market data is missing, stale or inconsistent and the week is not armed on a guess.
Read `data.why` / `data.error`; if Cboe stays unusable, set `KEEPER_PRICING_MODE=fixed` and restart.

Check with `GET /health` and `GET /orders` on the keeper, the cycle page, and on chain:
`phase() == 1` (Listed), `listingHash() != 0`, `contractsWritten() == 0`.

## F. Fill one contract (owner)

1. Open `https://app.stonkhouse.fun/vault/nvda/cycle` with the **buyer** wallet.
2. The page shows the listing, capacity 1, the unit price (about 0.86 USDG at the floor at today's
   spot; higher in vol mode when the market pays more), and the
   pre-flight result. If it says the fill would be refused after a price move, wait one or two minutes
   for the keeper to reprice and reload.
3. Approve USDG to Seaport, then fill 1. Expect about 460,000 gas for this first fill.
4. Tell Claude the transaction hash.

Claude then checks on chain: one `CallsWritten(…, 1, …)` in the fill transaction,
`contractsWritten() == 1`, the vault's option-token balance is 0, the premium arrived at the vault, and the
buyer holds 1 option token.

## G. Optional exercise (owner)

Only inside the window (Fri 16:00 ET to Sat 16:00 ET). Once the `accuracy/exercise-and-docs` branch is merged
and the web service has rebuilt, the cycle page shows the buyer wallet an **Exercise** card: enter 1, and it
approves exactly the strike in USDG to the Clear (only if the allowance is short), simulates, then calls
`exercise(optionId, 1)`. Until then, or if the card misbehaves, exercise directly on the clearinghouse:

1. From the buyer wallet, approve the Clear to spend the strike in USDG (`approve(clear, strike)` on USDG).
2. Call `exercise(uint256 optionId, uint112 amount)` on our Clear with `amount = 1`. Blockscout's
   "Write contract" tab works once the Clear is verified; Claude can also prepare the calldata for the
   wallet to sign.

Exercising below the strike loses money for the buyer and gains it for the depositor; with both wallets
owned by the owner it nets to zero apart from gas. It proves the first real assignment on this chain. It also
takes the vault's NAV to 0.06 NVDA, below the ~1.0527 NVDA the keeper needs to arm one contract, so cycle 2
will not arm until more is deposited.

## H. Close (keeper)

- At Fri 16:00 ET the keeper calls `lockBook()`; deposits and fills close.
- After Sat 16:00 ET the keeper calls `rollClose()`: the claim is redeemed, the premium is harvested with
  the 5% protocol fee on the premium only, and the vault returns to Idle. If the keeper is down, anyone
  can call `lockBook()` from Fri 16:00 ET and `rollClose()` from one hour after expiry (Sat 17:00 ET).
- If the close strands (a USDG pause or freeze), follow `ops/runbooks/incident.md`; `retryStrandedClaim()`
  recovers it and anyone can call it.

## I. Redeem and claim (owner)

1. On `/vault/nvda`, with the vault Idle, redeem all shares instantly. Unassigned, 1.06 NVDA comes back;
   assigned, 0.06 NVDA plus the strike in USDG.
2. Claim USDG: the premium less the fee, plus strike proceeds when assigned.

## J. Done when

- [ ] Deploy verified (Verify.s.sol counts recorded) and sources verified on Blockscout.
- [ ] The keeper created the type, armed and listed without manual help.
- [ ] One fill through the page wrote exactly 1 contract; the vault held 0 option tokens after it.
- [ ] Exercise (if done) assigned exactly 1; `rollClose` settled it.
- [ ] `lockBook` and `rollClose` ran on time from the keeper.
- [ ] Redeem and claim returned the expected amounts to the base unit; Claude reconciles them against the
      indexer API and the chain.
- [ ] No keeper `tx_revert`, `keeper_error` or `claim_stranded` alert.

Then the owner decides the next cap (`setDepositCap`, admin key). The launch plan keeps 20 NVDA until a
second clean week.

## Abort

| Situation | Action | Who |
|---|---|---|
| Anything unexpected before a fill | `haltWrites()` from the guardian (account 2) or the admin; `cancelListing` | Claude |
| A fill refused repeatedly | check `fill_sim_revert` in the keeper log; the keeper reprices up to 3 listings a week | Claude |
| Wrong amount after the close | stop; nothing is redeemed until reconciled | both |
| Keeper down at close | anyone calls `lockBook()` after the exercise time and `rollClose()` from one hour after expiry | anyone |
