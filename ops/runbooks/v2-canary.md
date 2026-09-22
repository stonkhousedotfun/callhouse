# Runbook — the v2 mainnet canary (NVDA)

Taking Stonkhouse v2 live on Robinhood Chain (4663) with **one market, NVDA**, at the smallest size the
contracts allow, with the owner's own money. Everything below is the **owner's** to run: it broadcasts
transactions, touches Railway, reads keys and flips a public domain. An agent may rehearse it on a fork;
an agent never runs it here.

Read once, end to end, before the first command. It is ordered, and step 3 assumes step 2 happened.

| | |
|---|---|
| **What goes live** | the 13 v2 contracts, NVDA registered, the six v2 services, the external monitor, and (last, and only when §7.2 below says so) `app.stonkhouse.fun` on the v2 build |
| **What does not** | the other 34 markets (`v2.status` stays `planned`), puts, Data Streams, email in the notifier, the daily "biggest win" post |
| **What keeps running** | v1: the `keeper`, `keeper-nvda`, `indexer` and the NVDA account factory. v2 runs **beside** them (`deploy.md` §15); the v1 run-off is a separate runbook, `v1-runoff.md` |
| **Blast radius** | the owner's own funds: ~25 USDG of keeper bounties, ~150 USDG + 1 NVDA Stock Token in the MakerVault, gas on four keys. Nothing else of ours is at risk, and no user money exists until someone buys |
| **Reference** | contracts: `callhouse-contracts/docs/DEPLOY-V2.md`. Services: `../deploy.md` §15. Alerts: `../alerts.md` "v2". Incidents: [`incident-v2.md`](incident-v2.md). Fork evidence: [`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md) |

**Copy rules apply to anything published from this runbook.** They are Stock Tokens, never "stocks"; no
APY, APR, annualised or projected return, nothing "guaranteed"; every payoff is stated with the most the
buyer can lose; "Most options expire worthless." `scripts/copy-lint.mjs` enforces this on `web/`, not on a
post you write by hand.

---

## Shell setup

Everything below assumes this, from the app repo root, on the machine that holds the keys.

```bash
REG=ops/markets/tier1.json
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export ETH_RPC_URL="$RH_RPC"          # cast reads this, so no keyed URL lands in argv
T=NVDA
```

After the deploy write-back (step 2), the same `eval` block [`incident-v2.md`](incident-v2.md) "Shell
setup" uses exports `$USDG`, `$CH`, `$BOOK`, `$ORACLE`, `$VAULT`, `$REWARDS`, `$ROLLER`, `$ADAPTER`,
`$CL_SRC`, `$UNI_SRC`, `$ASSET`, `$FEED`, `$POOL`, `$CRANKER`, `$PRICER`, `$QUOTER` and the three role
hashes out of the registry. Use it; never type an address by hand. It also sets `E` by hand — the expiry
in unix seconds — and `$E` means that everywhere below.

Section references, which the triage tables in §5.6 and §6 below lean on:

| Written | Means |
|---|---|
| `§1.3`, `§5.6`, or a bare number with **"above" / "below"** (`§2 above`, `§6 below`) | **this runbook** |
| a bare whole number or letter suffix with no "above"/"below" — `§1`, `§2`, `§4c`, `§5a` — which is every reference in the triage tables' last column | [`incident-v2.md`](incident-v2.md) |
| `§V8`, `§V11b`, `§V34a` | `../alerts.md` |
| `§15.2`, `§15.13` | `../deploy.md` |
| anything else | named in full: `incident.md §7`, `deploy.md §12.2`, `DEPLOY-V2.md` → "Resume and recovery", `status/DECISIONS-2026-09-17.md §7` |

**Keys never reach a command line.** `cast`'s `--private-key` puts the key in argv, where `ps -axww`
shows it for the life of the send. Import each key once into the Foundry keystore and name it with
`--account` (`incident-v2.md` header):

```bash
cast wallet import admin    --interactive   # ops mnemonic index 0 — also the deployer and the fee recipient
cast wallet import guardian --interactive   # index 2
cast wallet import ops      --interactive   # any funded key holding no role, for permissionless calls
cast wallet list
```

The deploy scripts are the exception by design: they read `DEPLOYER_PK` / `ADMIN_PK` from the
**environment** only (`read -rs`), never a file and never an argument.

```bash
probe() { railway ssh --service "$1" -- node -e "fetch('$2').then(async r=>console.log(r.status,(await r.text()).slice(0,4000))).catch(e=>console.log('ERR',e.message))"; }
```

`*.railway.internal` resolves only inside Railway's private network, and no image carries `curl` or
`wget` (`deploy.md` §15.11 item 10). Every private read in this runbook goes through `probe`.

---

## 1. Preconditions

Nothing in §2 below starts until every box here is ticked. Each one is a command with an expected answer.

### 1.1 The commits

| Repository | Branch | What must be true |
|---|---|---|
| `callhouse-contracts` | `leekzor/v2` | INTERFACE_VERSION **7** (mint rent, `MakerVault.Limits.maxDailyOutflow`, `AutoRoller.cancelStale`). `forge build && forge test` green from a clean tree; `script/v2/batch-refusals.sh` green. Record the 40-character SHA — every later step names it |
| `callhouse` | `leekzor/v2` | the v7 ABIs exported and integrated (keeper, monitor, registry, indexer, web), `ops/markets/tier1.json` in the v7 shape (§1.3), `ops/v2/env` re-rendered and committed. Record the 40-character SHA: `go-live-v2.sh --apply --ref <SHA>` builds from it |
| `callhouse-site`, `callhouse-docs` | `leekzor/v2` | not on the critical path. Publishing them is a separate owner decision |

```bash
/opt/homebrew/bin/git -C <callhouse-contracts> rev-parse HEAD     # contracts SHA, write it down
/opt/homebrew/bin/git -C <callhouse>           rev-parse HEAD     # app SHA, write it down
/opt/homebrew/bin/git -C <callhouse>           status --porcelain # empty
```

The contracts SHA also has to be the **submodule pin** the app repo carries, or the ABIs the bots use are
not the ABIs on chain. `CLAUDE.md` in the app root names the pin; check it matches.

### 1.2 Gates that must be green

Run them yourself; do not take a report's word for it. `set -o pipefail` before any pipe, or a failing
suite hides behind `tee`.

| Gate | Where | Expected |
|---|---|---|
| `forge build --force && forge test` | contracts | all green; the v7 integration run was **1,601/1,601 in 97 suites** (an unfiltered run; 1,577 in 91 is the `--no-match-path 'test/v2/fork/*'` subset, not this gate) |
| fork suites | contracts | green (v6 baseline: 43/43; v7 adds the rent and outflow fork cases) |
| `script/v2/batch-refusals.sh --registry <copy>` | contracts | `REFUSALS PASSED, 48 cases` at v7 (39 at v6) |
| `script/v2/rehearse-v2.sh` | contracts | `BATCH PASSED (rehearse)` + `VERIFY PASSED 144 checks` and the four drills (v7 record: `DEPLOY-V2.md` → Rehearsal records, 2026-09-17) |
| `ops/v2/rehearse.sh --publish` | app | exit 0 from a clean checkout. The O2-03 run: 5 steps, 10 drills, 175 assertions, 276 fork tx hashes ([`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md)). **Re-run it on v7**: the published report is a v6 run |
| `pnpm --filter @callhouse/keeper test` and `typecheck` | app | green (v6 baseline 517/517) |
| `node --test ops/v2/monitor.test.mjs` | app | green (v6 baseline 90/90) |
| `node --test ops/runbooks.test.mjs ops/markets/render-docs.test.mjs` | app | green |
| `node ops/markets/build-markets.mjs --check` | app | green — it verifies every registry address against chain 4663 |
| `node ops/v2-env.mjs --check` | app | `6 file(s) match the registry` |
| `node ops/keeper-env.sh --check` | app | `35 file(s) match the registry` |
| `node scripts/copy-lint.mjs` | app | 0 violations |
| `bash -n ops/go-live-v2.sh` | app | clean |
| indexer / web / relay / notifier suites | app | green (codex's lanes; the v7 integration must have landed) |

**The fork rehearsal report is a precondition, not a formality.** Before broadcasting, read
[`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md) → "Deviations from the plan" and "Not
covered". Everything in "Not covered" is something this canary is the first test of.

### 1.3 Registry state

The canary's registry is `ops/markets/tier1.json`, committed and pushed on the app SHA from §1.1. It must
carry:

```bash
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const n=r.markets.find(m=>m.ticker==="NVDA");
console.log("interfaceVersion   ", r.v2.interfaceVersion, "            (must be 7)");
console.log("premiumFeeBps      ", r.v2.fees.premiumFeeBps, "            (must be 0 at v7; rent replaced it)");
console.log("fees.mintFeePpm    ", r.v2.fees.mintFeePpm, "           (shared fallback, 80; 0 is refused)");
console.log("defaults.spotMaxAgeS", r.v2.defaults.spotMaxAgeS, "        (must be 90000)");
console.log("NVDA v2.mintFeePpm ", n.v2.mintFeePpm, "           (must be 80, non-zero)");
console.log("NVDA v2.strikeTick ", n.v2.strikeTick);
console.log("NVDA v2.wave/status", n.v2.wave, n.v2.status);
console.log("NVDA univ3Pool     ", n.v2.univ3Pool, n.v2.univ3MinLiquidity);
console.log("NVDA overrides     ", JSON.stringify(n.v2.overrides));
console.log("bots               ", JSON.stringify(r.v2.bots));
console.log("contracts written  ", r.v2.deployBlock, Object.values(r.v2.contracts).filter((x)=>typeof x==="string").length, "of 10 + 3 sources");
' "$REG"
```

| Field | Value for the canary | Why it matters |
|---|---|---|
| `v2.interfaceVersion` | `7` | `DeployV2Batch.sh` refuses anything else: six event topics and three selectors moved at v7, and a v6 consumer mis-decodes silently |
| `v2.fees.premiumFeeBps` | `0` | the writer fee is collateral rent at mint from v7; `DeployV2`, `VerifyV2` and `build-markets --check` all refuse `premiumFeeBps > resaleFeeBps` |
| `markets[NVDA].v2.mintFeePpm` | `80` | millionths of locked collateral per 7 days of remaining life. **A missing or zero effective ppm must not deploy** (decision log §11): the batch, the RegisterMarkets preflight and VerifyV2 each refuse it for a live market. The whole launch table is in `DEPLOY-V2.md` → "What the registry must carry"; the derivation is `status/V7-DESIGN.md` §5.1 |
| `v2.defaults.spotMaxAgeS` | `90000` (25 h) | measured: 0 stale session seconds over 45 days on all 35 feeds. At the contract's 1 h default (`SettlementOracle.DEFAULT_SPOT_MAX_AGE`) `spot()` reverts for most of each session and quoting, rolls and reprices stop with it. `deploy.md` §15.13 has the data. **Set it before the first series and leave it alone** — see the note below on what "pinned" does and does not mean |
| NVDA `v2.univ3Pool` / `univ3MinLiquidity` | present | NVDA is one of only two markets whose pool ring is deep enough. Read it yourself before the deploy (§1.4) |
| the other 34 markets | `v2.status: "planned"`, and **no** `univ3Pool` on any of the 11 shallow-ring markets | owner sign-off c10 (`status/DECISIONS-2026-09-17.md` §7): AAPL, AMZN, CRCL, GME, GOOGL, MSFT, MU, QQQ, SGOV, TSLA and USO register Chainlink-only when their wave comes, and drop their payout route with the pool. Nothing but NVDA registers in this runbook, but a stray pool on a planned row is a trap for O2-07 |
| `v2.bots` | the three addresses, EIP-55, distinct | written by `ops/v2/derive-bot-keys.sh`, addresses only |
| `v2.contracts`, `v2.deployBlock` | `null` before §2, filled by the write-back | `go-live-v2.sh` refuses a registry with nulls, by design |

**What the pin actually pins.** The first series of an expiry copies the market's source list,
`maxDeviationBps`, `uncorroboratedDelay` and `spotMaxAge` into `SettlementOracle._pinned`, and that copy
is what **settlement** of the expiry uses (`_configOf`). Two consequences an operator has to hold apart:

- `spot()` and `trySpot()` are **not** pinned. They read `_markets[underlying].spotMaxAge` — the market's
  *current* value — so a `setMarket` that lowers the spot age takes effect immediately, on every expiry,
  open or not, and quoting and reprices stop with it.
- Changing any of the four while an expiry is already pinned makes the **next** series of that expiry
  revert `PinMismatch` (`_sameConfig` compares all four, spot age included), and the monitor pages
  `v2_mon_pin_mismatch`. The already-created series keep settling under the pinned copy.

So "do not change it while series are open" is right; the reason is a half-broken market — new rungs
refused on open expiries while live quoting follows the new value — not a protected settlement.

**Optional, and recommended for day one — a smaller ladder.** The shared default is 5 rungs on each of 2
weekly and 3 daily expiries: about 25 NVDA series to watch on the first afternoon. For the canary set an
override on the NVDA row, which is a registry change and therefore an **image rebuild** of the four
keeper-image services (`deploy.md` §15.2):

```json
"overrides": { "expiriesAhead": { "weekly": 1, "daily": 1 }, "ladder": { "weekly": { "rungs": 3 }, "daily": { "rungs": 3 } } }
```

Six series, one weekly and one daily expiry. `build-markets.mjs --check` validates that an override names
only keys of `v2.defaults`. Removing it later is another registry change and another rebuild.

### 1.4 Read the chain yourself

The reads that decide whether the deploy can work at all. The values below were read on 2026-09-17
between blocks 65,677,424 and 65,701,790 — repeat them, do not trust them. Every one of them moves,
and two of them (gas price, pool liquidity) move enough to change a decision.

```bash
cast chain-id                                        # 4663
cast block-number
cast base-fee; cast gas-price                        # WEI. 59_500_000-59_900_000 = 0.0595-0.0599 gwei
#   when this was written (block 65,700,447-65,701,790). Divide by 1e9, not 1e8: this chain's gas is
#   two orders of magnitude under an L1's, and reading it an order of magnitude high makes the deploy
#   look ten times more expensive than it is

# the NVDA pool: the 4th value of slot0 is observationCardinality and must be >= 2401
cast call 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)"
#   sqrtPriceX96 tick <observationIndex> 6000 6000 ... -> cardinality 6000, next 6000: deep enough
#   (the index walks with every write; only the two 6000s matter)
cast call 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 "fee()(uint24)"        # 500 (0.05 %), at or under the 10000 ceiling
cast call 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 "liquidity()(uint128)" # 1.77e19 when this was written,
#   against the registry's univ3MinLiquidity floor of 1.7e18: an order of magnitude of headroom

# the NVDA feed and token
cast call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 "latestRoundData()(uint80,int256,uint256,uint256,uint80)"
#   answer 21967214898 (8 dp = 219.67), updatedAt 1789654501
cast call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC "oraclePaused()(bool)"   # false
cast call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC "uiMultiplier()(uint256)" # 1000775159164630595
cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "paused()(bool)"          # USDG: false
```

**NVDA is the only launch market with two price sources.** Its ring holds 6,000 observations, so it
registers with the pool: Chainlink first, the pool second, and a USDG payout route through that pool. A
settlement where both agree inside 150 bps finalizes from `expiry + 120 s`; one where they disagree, or
where only one is ok, records a candidate and waits the 21,600 s (6 h) uncorroborated delay. Every other
market this quarter is Chainlink-only and always waits.

### 1.5 Balances

```bash
for a in <admin> <guardian> <cranker> <pricer> <mmQuoter>; do echo -n "$a "; cast balance "$a"; done
cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "balanceOf(address)(uint256)" <admin>   # USDG, 6 dp
cast call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC "balanceOf(address)(uint256)" <admin>   # NVDA, 18 dp
```

| Holder | Needs | Held on 2026-09-17, re-read at block 65,700,447 | For |
|---|---|---|---|
| admin / deployer, index 0 `0xEb82c3D0…19d9b` | ≥ 0.05 ETH | 0.11410 ETH | ~29.8 M gas: the 13 creates plus 21 admin wiring calls plus NVDA's 5 calls (§2.2). At the 0.0595–0.0599 gwei read above that is **0.0018 ETH**, which agrees with the 0.056 gwei of the decision log §8. At 0.8 gwei it would be 0.024 ETH. **Gas price decides this, so re-read it and multiply — and check the exponent** |
| admin | ≥ 200 USDG, ≥ 1.1 NVDA | 437.06 USDG, 2.0353 NVDA | 25 USDG of bounties, ~150 USDG + 1 NVDA into the MakerVault, and enough left to be the first buyer |
| guardian, index 2 `0x29741A8d…6F39` | ≥ 0.005 ETH | 0.01 ETH | four pause calls, ~32k gas each |
| cranker, index 50 `0xD03c35Ee…22b0` | ≥ 0.01 ETH | 0.005 ETH | **under the bots' own `KEEPER_MIN_GAS_WEI` floor: top it up.** It spends the most — snapshot, finalize, settle, redeem, ladders, rolls for every expiry, partly repaid in bounties |
| pricer, index 51 `0xe25A7C5c…e360` | ≥ 0.01 ETH | 0.005 ETH | top up. One reprice ≈ 251k gas |
| MM quoter, index 52 `0x02EbA2fC…0BfC` | ≥ 0.02 ETH | 0.005 ETH | top up. It is the busiest signer: 109 places in the fork story at ~370k gas each |

Gas numbers per action are measured in [`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md) →
"Gas per action": an MM place is 370,234 gas on average, a pricer reprice 251,414, a `createSeries`
2,504,710. At the 0.06 gwei read today 0.02 ETH buys 333 M gas — about 900 MM places, so a week of the
canary is not the binding constraint; at 0.8 gwei the same 0.02 ETH is 25 M gas and about 65 places.
Top the bots up to 0.02 ETH each, and re-check the burn rate on the morning after (§7.4 below) rather
than trusting either figure.

Each `v2_low_gas` alert fires under `KEEPER_MIN_GAS_WEI` (0.01 ETH). A bot below it keeps running and
keeps failing to send.

### 1.6 Keys, and who holds them

One BIP-44 mnemonic, `~/.callhouse-keys/callhouse-hot-wallet.txt`, **held by the owner and nobody else**.
Nothing in this runbook prints key material, and no script reads that file.

| Role | Index | Address | Powers | Where the key lives |
|---|---|---|---|---|
| admin + deployer + fee recipient | 0 | `0xEb82c3D0…19d9b` | `DEFAULT_ADMIN_ROLE` on every v2 contract (owner decision: one hot key, no timelock) | keystore `admin`, and pasted as `DEPLOYER_PK` for the broadcast |
| guardian | 2 | `0x29741A8d…6F39` | `veto`, `setMintPaused`, `setCreatePaused`, `setTradingPaused`. **No guardian function touches a balance** | keystore `guardian` |
| cranker | 50 | `0xD03c35Ee…22b0` | none — every call it makes is permissionless | `~/.callhouse-keys/v2/cranker.env`, mode 600 |
| pricer | 51 | `0xe25A7C5c…e360` | `PRICER_ROLE` on `AutoRoller` | `~/.callhouse-keys/v2/pricer.env` |
| MM quoter | 52 | `0x02EbA2fC…0BfC` | `QUOTER_ROLE` on `MakerVault`: quotes and trades the vault's inventory, **cannot move funds out of the vault** | `~/.callhouse-keys/v2/mmQuoter.env` |

```bash
ops/v2/derive-bot-keys.sh                  # once; prints addresses only, writes mode-600 files
node ops/markets/build-markets.mjs --check # v2.bots EIP-55, distinct from each other and every keeper key
jq '.v2.bots' ops/markets/tier1.json
```

**Carry these two facts into the decision to go live** (`status/HANDOFF-OWNER-2026-09-17.md` §5):

1. The same key set covers live v1, the mainnet **dev** deployment and this production v2. A leaked bot
   key affects both environments. The quoter is bounded by the vault guards and, from v7, by
   `maxDailyOutflow`.
2. The admin key is one hot key with no timelock. What it can and cannot do, and what to do if it leaks,
   is [`incident-v2.md`](incident-v2.md) §5. Read §5 "What it can do" before you decide the canary is
   acceptable, not after.

**Address screening.** The task card asks for a sanctions screen "as `ops/` already advises". `ops/`
advises no such thing: `launch-legal.md` item 7 records that the perimeter is **disclosure-only** — no IP
check, no wallet screening, no country gate — and that a technical control is a product change, not a
variable. So there is nothing to run here, and the honest statement is: the five addresses above are the
owner's own, derived from one phrase held by the owner, and no counterparty is screened by this system.
If that stance changes, it changes in `launch-legal.md` first.

### 1.7 Railway

Project `callhouse` `9988a803-0b8f-4b0e-8ada-ba71e5a505ae`, environment `production`
`319fcb44-0e25-4367-947c-09351a349d2e`. Railway CLI **≥ 5.47.2** (it is the first release that lists
sealed variables; the script refuses older).

```bash
railway --version; railway whoami
railway link -p 9988a803-0b8f-4b0e-8ada-ba71e5a505ae -e 319fcb44-0e25-4367-947c-09351a349d2e
railway service list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const x of JSON.parse(s))console.log(x.name, x.latestDeployment?x.latestDeployment.status:"NONE")})'
```

| Service | Before this runbook | Created by |
|---|---|---|
| `Postgres`, `web`, `indexer`, `keeper`, `keeper-nvda`, `site` | exist, v1, untouched | — |
| `relay` | **exists but has never deployed.** `RELAY_TOKEN` and a Discord webhook (or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) must be set on it before any alert producer deploys | owner, §4.1 |
| `indexer-v2`, `pricing`, `cranker`, `pricer`, `mm-bot`, `notifier` | do not exist | `go-live-v2.sh --apply` |
| `monitor` | does not exist | `go-live-v2.sh --apply` after the relay is live (`deploy.md` §15.12) |

`go-live-v2.sh --apply` refuses a service with a connected GitHub repo or image source, including the
existing `web`. Disconnect `web`'s source in the Railway UI before the flip in §7.2 below, or it refuses.

### 1.8 Say out loud what the canary is not

- The contracts are **unaudited**, by decision, and the docs say so.
- 11 of 13 registry pools are too shallow to corroborate. NVDA is not one of them; every later wave is.
- Nothing pages a price network that stalls while its last print stays within 3 % of the truth
  (`deploy.md` §15.13, the first open item). During the canary that is an on-call job, §5.7.
- Lockfile advisories: 11, 8 in the production graph, no reachable path found.

---

## 2. Deploy

Two commands that matter — a rehearsal, then a broadcast — and a verification. The contracts side is
`callhouse-contracts/docs/DEPLOY-V2.md`; this is the canary's selection and the order around it.

### 2.1 Rehearse (mandatory, and it expires)

An anvil fork of 4663, the **production** scripts, the **real** registry path (the write-back goes to a
copy). The broadcast will not run without a matching rehearsal record **at most 24 hours old** with the
same registry sha256, the same fingerprint, the same markets and the same phase.

```bash
cd <callhouse-contracts>
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8551 \
  --code-size-limit 98304 --retries 12 --fork-retry-backoff 1000 --timeout 60000 &

ANVIL=$!

script/v2/DeployV2Batch.sh --rehearse --rpc http://127.0.0.1:8551 \
  --registry ../callhouse/ops/markets/tier1.json --wave canary

kill "$ANVIL"     # always. A forgotten anvil on 8551 makes the next rehearsal fork a stale head
```

Expected tail: `BATCH PASSED (rehearse)`, `VERIFY PASSED <n> checks` with **no** `FAIL` line (the count
for a one-market canary is lower than the 144 the two-market v7 rehearsal measured — §2.4), and a path to
`rehearsal-passed.json` with its fingerprint. Then stop the anvil. The public RPC serves state about 15
minutes behind its head, so the whole run must fit in that window; it takes about a minute.

The plan it prints first is what you are approving. For the canary it is one market
(`--dry-run` output, this worktree, 2026-09-17):

```
== plan: rehearse, deploy phase 'fresh', 1 market(s) to register, rpc http://127.0.0.1:8551
  admin         0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b  (DEFAULT_ADMIN_ROLE on every contract; registry shared.admin …)
  guardian      0x29741A8d283a253E8Ce10aDfd04C6507438b6F39
  bots          cranker 0xD03c35Ee…22b0  pricer 0xe25A7C5c…e360  mmQuoter 0x02EbA2fC…0BfC
  fees          premium 0 bps, resale 0 bps, taker flat 100000, taker cap 1000 bps, maker rebate 5000 bps, exercise 25 bps
  writer rent   v2.fees.mintFeePpm 80 shared (millionths of locked collateral per 7 days of remaining life; …ceiling 5000)
  contracts     0 of 13 recorded, deployBlock null
  TICKER ASSET       FEED        POOL        FEE  TICK     DEV  DELAY  AGE    PPM  ACTION
  NVDA   0xd0601CE1… 0x379EC4f7… 0xd4EB2120… 500  2500000  150  21600  90000  80   register
```

Check, line by line: `1 market(s)`, `phase 'fresh'`, the five addresses, `premium 0 bps`, `PPM 80`,
`AGE 90000`, `DELAY 21600`, and that the pool column is not empty. Anything else and you stop.

For the drills as well — nothing to do on a re-run, a lost pointer recovered by `--resume`, a lost
write-back recovered from the log, a flipped bytecode byte caught — run `script/v2/rehearse-v2.sh`
instead; its v7 record is in `DEPLOY-V2.md` under "Rehearsal records".

If the registry is not ready the batch says so precisely and sends nothing. This is what a v6 registry
gets, produced against these scripts on 2026-09-17:

```
$ script/v2/DeployV2Batch.sh --rehearse … --registry <a v6 registry> --wave canary --dry-run
BATCH FAILED: registry v2.interfaceVersion is 6; these scripts are INTERFACE_VERSION 7
```

### 2.2 Broadcast (owner)

Same selection, same registry file, same commit, **within 24 hours of the rehearsal**.

```bash
cd <callhouse-contracts>
read -rs DEPLOYER_PK && export DEPLOYER_PK
# ADMIN_PK only if shared.admin is a different key; here it is the same, so it defaults to DEPLOYER_PK

script/v2/DeployV2Batch.sh --broadcast --rpc $RH_RPC \
  --registry ../callhouse/ops/markets/tier1.json --wave canary

unset DEPLOYER_PK
```

**What the operator types:** the plan and the matching rehearsal record print, then the prompt asks for
the literal word `deploy`. Nothing else continues. Type it only after re-reading the plan: this is the
last reversible moment.

**What the write-back changes,** in the real `ops/markets/tier1.json`, after each phase:

| Phase | Written |
|---|---|
| deploy mined | `v2.contracts` (10 named + 3 sources) and `v2.deployBlock` |
| NVDA's `registerMarket` mined | `markets[NVDA].v2.registeredAt` and `v2.registerTx` |

`v2.status` is **never** written by the batch. Setting NVDA to `live` is a hand edit, §2.5.

Expect roughly **29.8 M gas**. The v7 integration rehearsal measured **29,998,453 gas** for the deploy
plus NVDA plus TSLA; TSLA's three calls (`setFeed`, `setMarket`, `registerMarket` — Chainlink-only, so no
pool and no route) were **220,947**, which the canary does not spend. NVDA's five calls are **390,464**:
`setFeed` 53,205, `setPool` 88,483, `setMarket` 126,814, `setRoute` 54,555, `registerMarket` 67,407.
`setOracle` on each source is normally already in place from `DeployV2` and sends nothing.

### 2.3 Resume a partial deploy

The phase is decided from the file the write-back goes to, so a half-finished deploy is a state, not a
disaster.

| What is recorded | Phase | What happens next |
|---|---|---|
| nothing | `fresh` | 13 creates + wiring |
| all 13 and `deployBlock` | `check` | read-only wiring check; it refuses and names the pending calls unless you pass `--resume` |
| some | refuses | `--resume` creates only the missing contracts and sends only the missing wiring |

Rehearse the resume before you broadcast it, exactly as you rehearsed the deploy:

```bash
script/v2/DeployV2Batch.sh --rehearse  --rpc http://127.0.0.1:8551 --registry … --wave canary --resume
script/v2/DeployV2Batch.sh --broadcast --rpc $RH_RPC                --registry … --wave canary --resume
# --deploy-block <n> if no CREATE receipt survived
```

A `registerMarket` that mined while its write-back was lost needs no transaction: re-run the same
selection and the `MarketRegistered` log supplies `registeredAt` / `registerTx`. A Sourcify failure after
the deploy mined is also not a re-deploy — `--resume` finds nothing to send, and you verify by hand per
contract with the constructor arguments from the run's `deploy-run-latest.json`.

`DEPLOY-V2.md` → "Resume and recovery" is the full table. Read it before improvising.

### 2.4 Verify

The batch already ran VerifyV2. Run it again, read-only, and keep the output:

```bash
script/v2/DeployV2Batch.sh --verify --rpc $RH_RPC --registry ../callhouse/ops/markets/tier1.json --expect-fresh true
```

| Expect | |
|---|---|
| `VERIFY PASSED <n> checks` | **127** for the canary, if you want the arithmetic: the v7 rehearsal measured 144 for a fresh set with **two** markets, and TSLA — Chainlink-only, so no pool ring, no route — contributed 17 of them. NVDA keeps its pool-ring and route checks, so one market fewer is 17 fewer. The number is derived here, not measured; what the gate is, is `VERIFY PASSED` with **zero `FAIL` lines** |
| `--expect-fresh false` (the default) | fewer again: no fresh-state block, no per-market mint-paused check, and every admin-tuned parameter becomes an `info` line instead of a check. The rehearsal's `--resume` drill read 136 that way |
| `info` lines you should see | `makerVault holds 0 USDG …(funding is an owner step)`, `keeperRewards USDG balance 0 base units`, `V2_ADMIN is a plain key, not a Safe`, `makerVault outflow: used 0, available …`, `NVDA: oracle trySpot ok …` |
| any `FAIL` | stop. The script reverts on one; there is no partial pass |

If you set the canary's vault limits with the `V2_VAULT_*` overrides (§3.4), export the same values
whenever you re-run `--verify`, or VerifyV2 compares against the compiled launch defaults and prints the
difference — a `FAIL` with `--expect-fresh true`, an `info` line without it.

### 2.5 Commit the write-back

```bash
cd <callhouse>
node ops/markets/build-markets.mjs --check        # green
# set markets[NVDA].v2.status = "live" by hand (registeredAt + registerTx must both be set)
node ops/v2-env.mjs                                # re-render ops/v2/env from the registry
node ops/v2-env.mjs --check                        # 6 files match
pnpm --filter @callhouse/web gen:markets           # web/lib/markets.generated.ts gets the deployed addresses
/opt/homebrew/bin/git add ops/markets/tier1.json ops/v2/env web/lib/markets.generated.ts
/opt/homebrew/bin/git commit    # "Record the v2 canary deployment"
/opt/homebrew/bin/git push leekzor HEAD:v2
```

**Push before §4 below.** `go-live-v2.sh --apply --ref <SHA>` builds every image from a fresh clone of
that SHA and refuses when the clone's `ops/markets/tier1.json` differs from the registry it planned
against. The bots read the copy baked into their image, so an unpushed registry is an image without the
deployment.

Record the new app SHA. It is the `--ref` for every service in §4 below.

---

## 3. Wiring and parameters

The deploy left the contracts wired to each other and to the three bot addresses. What is left is money
and caps. Every command here is the admin key.

### 3.1 Roles: confirm, do not grant

`DeployV2` already granted them. Confirm, and confirm nobody else holds anything.

```bash
# the eval block from incident-v2.md "Shell setup" first, so $ROLLER/$VAULT/$CH/… are exported
cast call $ROLLER "hasRole(bytes32,address)(bool)" $PRICER_ROLE   $PRICER   # true
cast call $VAULT  "hasRole(bytes32,address)(bool)" $QUOTER_ROLE   $QUOTER   # true
cast call $CH     "hasRole(bytes32,address)(bool)" $GUARDIAN_ROLE <guardian>  # true
cast call $BOOK   "hasRole(bytes32,address)(bool)" $GUARDIAN_ROLE <guardian>  # true
cast call $ORACLE "hasRole(bytes32,address)(bool)" $GUARDIAN_ROLE <guardian>  # true
cast call $VAULT  "hasRole(bytes32,address)(bool)" $QUOTER_ROLE   $CRANKER  # false — the cranker holds no role
```

VerifyV2 checks all of this and more (no other known key, not the deployer, every role administered by
`DEFAULT_ADMIN_ROLE`). These reads are the ten seconds that let you believe it.

### 3.2 KeeperRewards: fund it small

```bash
cast send $USDG    "approve(address,uint256)" $REWARDS 25000000 --rpc-url $RH_RPC --account admin
cast send $REWARDS "fund(uint256)" 25000000               --rpc-url $RH_RPC --account admin
cast call $USDG    "balanceOf(address)(uint256)" $REWARDS --rpc-url $RH_RPC   # 25000000
cast call $REWARDS "dailyCap()(uint256)"                  --rpc-url $RH_RPC
```

| | Launch value | Canary value | Derivation |
|---|---|---|---|
| balance | 1,000 USDG | **25 USDG** (`25000000`) | the fork measured **0.19 USDG per (underlying, expiry)** across four settled pairs, 0.33 on the busiest; NVDA alone settles at most one expiry per session day plus rolls. 25 USDG is over a month of canary |
| `dailyCap` | 100 USDG (`100000000`) | **5 USDG** (`5000000`) | 5–25× the measured daily spend, and it bounds what a compromised cranker key can drain in a day. Set it with `V2_KEEPER_DAILY_CAP=5000000` exported for the rehearsal **and** the broadcast, or afterwards with `cast send $REWARDS "setDailyCap(uint256)" 5000000 … --account admin` |
| bounties | SNAPSHOT / FINALIZE / SETTLE 50,000, REDEEM 20,000, ROLL 50,000, CANCEL_STALE 20,000 | unchanged | `CANCEL_STALE` is new at v7: the bounty for the permissionless `AutoRoller.cancelStale`, at most one per ROLL |

Hitting the cap **does not stop settlement**. Every lifecycle call is permissionless and works whether or
not a bounty is paid; the cap only stops the payment. `v2_mon_rewards_cap` and
`v2_mon_rewards_budget_low` page for it (`../alerts.md` §V25).

### 3.3 The payout route

`RegisterMarkets` already set it: NVDA's 0.05 % pool, from the registry's `univ3Pool`. Confirm:

```bash
cast call $CH      "payoutAdapter()(address)"          --rpc-url $RH_RPC   # $ADAPTER
cast call $CH      "maxPayoutSlippageBps()(uint16)"    --rpc-url $RH_RPC   # 30
cast call $ADAPTER "routes(address)(address,uint24)" $ASSET --rpc-url $RH_RPC   # the pool, fee 500
```

The 30 bps bound is measured **above** the route's pool fee (decision log §1), so NVDA's effective floor
is 35 bps below value. A conversion that misses it pays the holder in Stock Tokens instead — nobody loses
value, and that fallback is the design, not a fault ([`incident-v2.md`](incident-v2.md) §3).

### 3.4 MakerVault: limits, then funds

**One vault, one deployment.** There is a single protocol MakerVault on 4663 (`v2.contracts.makerVault`, `$VAULT` after the shell-setup `eval`). stonkhouse-dev does not get a second vault: it shares these contracts. There is a single `mm-bot`, in Railway project `callhouse` production, signing as BIP-44 index **52** (`v2.bots.mmQuoter`, `$QUOTER`). `go-live-v2.sh` refuses `--services mm-bot` (and any other signing bot) when the stonkhouse-dev project is selected; do not create an `mm-bot` there.

**Limits first, funds second.** An unfunded vault with wide limits is harmless; a funded one is not.

The six-field `Limits` struct gained `maxDailyOutflow` at v7, so `setLimits` moved to selector
`0x6693cc27`:

```bash
cast call $VAULT "limits()((uint64,uint128,uint16,uint16,uint32,uint128))" --rpc-url $RH_RPC
cast call $VAULT "outflow()(uint256,uint256)"                              --rpc-url $RH_RPC  # used, available
```

| Field | Launch | **Canary** | Why |
|---|---|---|---|
| `maxSeriesUnits` | 10,000 (100 shares) | **100** (1 share) | worst-case net position per series |
| `maxTotalNotional` | 250,000e6 | **1000000000** (1,000 USDG) | Σ over series of `exposure × strike / 100`. Four quoted series at 1 share and a ~230 USDG strike is 920 |
| `askToleranceBps` | 100 | **100** | unchanged: the ask floor is `max(0, intrinsic − spot × 1 %)` |
| `maxBidBpsOfSpot` | 1,000 | **1000** | unchanged: no bid above 10 % of spot, ~22 USDG a share at 219.67 |
| `maxOrderLifetime` | 0 (series limit) | **1800** | what a dead bot leaves fillable, bounded **on chain** rather than only by the bot's `MM_MAX_QUOTE_LIFETIME_S`. Costs nothing: the bot already re-places inside 30 minutes |
| `maxDailyOutflow` | 2,500e6 | **250000000** (250 USDG) | net USDG the quoter may pay out at once, refilling linearly over 24 h, so ≤ 500 USDG in any 24 h. The canary's live bid escrow ceiling is 4 series × 0.25 share × 22 USDG ≈ **22 USDG**, so 250 never binds honest quoting; it does bind a hostile quoter to about 1.6 buy-and-rebuy loops at once. **0 is the incident spend freeze, never a deploy value** |

Two ways to set them, and the first is better:

```bash
# A. at deploy time — export these for BOTH the rehearsal and the broadcast; the batch prints each
#    override in its plan and the rehearsal fingerprint covers them, so the two runs must match.
export V2_VAULT_MAX_SERIES_UNITS=100
export V2_VAULT_MAX_TOTAL_NOTIONAL=1000000000
export V2_VAULT_ASK_TOLERANCE_BPS=100
export V2_VAULT_MAX_BID_BPS_OF_SPOT=1000
export V2_VAULT_MAX_ORDER_LIFETIME_S=1800
export V2_VAULT_MAX_DAILY_OUTFLOW=250000000
export V2_KEEPER_DAILY_CAP=5000000

# B. afterwards, from the admin (a re-run of --verify then shows info lines instead of the launch values)
cast send $VAULT "setLimits((uint64,uint128,uint16,uint16,uint32,uint128))" \
  "(100,1000000000,100,1000,1800,250000000)" --rpc-url $RH_RPC --account admin
cast call $VAULT "limits()((uint64,uint128,uint16,uint16,uint32,uint128))" --rpc-url $RH_RPC
```

Then fund it. The quoter moves the vault's money into the Clearinghouse ledger itself
(`depositToClearinghouse`); the owner only has to get it into the vault.

```bash
cast send $USDG  "approve(address,uint256)" $VAULT 150000000            --rpc-url $RH_RPC --account admin
cast send $VAULT "deposit(address,uint256)" $USDG 150000000            --rpc-url $RH_RPC --account admin
cast send $ASSET "approve(address,uint256)" $VAULT 1000000000000000000 --rpc-url $RH_RPC --account admin
cast send $VAULT "deposit(address,uint256)" $ASSET 1000000000000000000 --rpc-url $RH_RPC --account admin
cast call $USDG  "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC   # 150000000
cast call $ASSET "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC   # 1e18
```

**150 USDG and 1 NVDA.** The USDG escrows bids (≈22 USDG live) and buys back; the one Stock Token is the
collateral behind `AskWrite`, and one token backs one share of calls written, so with `MM_ASK_UNITS=25`
over four series the vault can write at most exactly one share before it runs out — which is the point.

**Quoter gas, index 52, top-up 0.05 ETH.** `$QUOTER` is BIP-44 index 52, keystore name is not used
for this send — the admin pays it. §1.5's 0.02 ETH is the `v2_low_gas` floor (`KEEPER_MIN_GAS_WEI`);
the operating float before first quotes is **0.05 ETH**.

At canary settings (4 series, `MM_MAX_QUOTE_LIFETIME_S=900`, 1 cancel + 2 places per series per
lifetime) a regular session is ~6.5 h ≈ 26 lifetimes → ~312 OrderBook txs. An MM `place` averaged
**370,234 gas** in [`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md) → "Gas per action".
At **0.066 gwei** that is `312 × 370234 × 0.066 / 1e9 ≈ 0.0076 ETH` per session if every tx were a
place; cancels are cheaper, so budget **0.007–0.01 ETH per session day**. 0.05 ETH is several session
days of headroom at that gas price. **Re-read the price and multiply — gas price decides this:**

```bash
cast gas-price --rpc-url $RH_RPC          # wei; divide by 1e9 for gwei
cast balance $QUOTER --rpc-url $RH_RPC    # wei
# shortfall = 0.05e18 − balance, if positive. Convert to ether for --value.
# Example at a 0.005 ETH balance: send 0.045 ether, not another 0.05.
cast send $QUOTER --value 0.045ether --rpc-url $RH_RPC --account admin
cast balance $QUOTER --rpc-url $RH_RPC    # ≥ 50000000000000000
```

At 0.8 gwei the same 312 places cost ~0.09 ETH and 0.05 ETH is then half a session — raise the
float before that week, do not wait for `v2_low_gas`. Who supplies tomorrow's gas price: the chain,
via `cast gas-price`, the owner, today.

### 3.5 The MM bot's canary caps

`ops/go-live-v2.sh` leaves `mm-bot` out of its default service set, because with the `MM_*` variables
unset the bot quotes **every live market** up to the vault limits alone. Name it and the preflight prints
`mm-bot: selected; its MM_* caps come from ops/runbooks/v2-canary.md, read it before --apply` — this
section (sweep finding ops-c12). Each of these is a restart, not a rebuild: `--skip-deploys` sets the
value without one, so a change after the bot is live needs a `railway redeploy --service mm-bot` to take.

**Set them before the bot's first deploy.** `go-live-v2.sh --apply --services mm-bot` creates the service
*and* deploys it in one run, so create the service first — an **Empty Service** named `mm-bot` in the
Railway UI, with no repo or image source (the script refuses a connected one) — then set the variables
below, then run the apply. If you do it the other way round, set them and redeploy immediately; in that
window the on-chain vault limits from §3.4 are the only bound, which is exactly why they are set first.

| Variable | Default | **Canary** | Why |
|---|---|---|---|
| `MM_MARKETS` | unset = every `live` market | `NVDA` | one market. It is also the only live one, but naming it makes a second market a deliberate act. **A named ticker is quoted at any registry status** (`quotedMarkets`: unset selects `live`, a list selects `live`, `paused` and `planned`), so setting `v2.status` to `paused` does **not** pull this bot's quotes while `MM_MARKETS=NVDA` — §6.4 step 2 does |
| `MM_MAX_SERIES` | unset = derived from the ladder (50 per launch market x quoted markets; T-OP-133) | `4` | series quoted at once, nearest the money first. **A set value below what the market lists is refused at boot** with the unquoted count: the canary quotes 4 of NVDA's 50 on purpose, so this refusal is expected until the caps are unset for the full book |
| `MM_MAX_SERIES_PER_MARKET` | unset = derived (50 at launch) | `4` | same number: one market. Unset both to let every listed option carry the fallback ask (the owner's model) |
| `MM_ASK_FALLBACK_ONLY` | `1` | `1` | **the owner's model, default on.** The vault's ask rests only while no other maker's live ask rests on the series; while one does the series halts `other-asker` on the ask side (visible in `/state`), the resting vault ask is cancelled, the bid stays, and the ask returns once the book clears. The HouseVault's covered-call ask (a protocol account) COUNTS as another asker (keeper/README.md, flip there). `0` = always quote |
| `MM_WRITE_OVERSUBSCRIBE_BPS` | `10000` (the exact budget) | `50000` (owner's call) | the ONE write pool per asset the asks are sized against, as bps of `Clearinghouse.free(vault, asset)`: at 50000 the advertised sum may reach 5x the ledger while every single ask still fits what one fill can draw; several fills in one tick beyond the pool are SKIPPED by the book, never reverted. **Collateral:** 50 series x 25 units / 100 = 12.5 NVDA advertised at 50000 bps needs 2.5 NVDA in the ledger (calls; puts would need sum(strike) x 25/100 / 5 USDG). The on-chain `maxTotalNotional` counts ADVERTISED write units: 50 x 0.25 share x ~230 USDG = ~2,875 USDG of notional, so `V2_VAULT_MAX_TOTAL_NOTIONAL` must be at least **3000000000** (3,000 USDG) for the full book -- the 1,000 canary limit (§3.4) caps the advertised sum at ~17 series of 0.25 share. `ops/go-live-v2.sh` prints the pool needed vs held per market and warns when short |
| `MM_BID_UNITS` | 100 (1 share) | `25` (0.25 share) | ≤ 5.5 USDG of escrow per series at the 10 %-of-spot bid cap |
| `MM_ASK_UNITS` | 100 | `25` | inventory first, then `AskWrite` from the vault's collateral: at most 1 NVDA across four series |
| `MM_MAX_SERIES_UNITS` | 0 (the vault limit alone) | `50` (0.5 share) | a bot cap **tighter** than the vault's 100, so a bot bug hits the soft limit first |
| `MM_MAX_TOTAL_NOTIONAL_USDG6` | 0 (the vault limit alone) | `500000000` (500 USDG) | half the vault's 1,000. Worst case 4 × 0.5 share × 230 USDG = 460 |
| `MM_DAILY_LOSS_LIMIT_USDG6` | 1000000000 (1,000 USDG) | `25000000` (25 USDG) | realised loss in a UTC day that pulls every quote until the next day. 25 USDG is meaningful against 150 USDG of vault cash and is a number you will actually investigate |
| `MM_MAX_QUOTE_LIFETIME_S` | 1800 | `900` | the longest `validUntil` a new quote gets: what a dead bot leaves fillable. Backed on chain by `maxOrderLifetime` 1800 |
| `MM_DELTA_ALERT_SHARES` | 50 | `1` | `v2_mm_delta` at one share of net inventory. There is no borrow market; hedging is by hand |
| `MM_QUOTE_OFF_HOURS` | 0 | `0` | **set it explicitly.** Overnight feed prints reverse (11 feeds jumped and reversed on 2026-09-11); `deploy.md` §15.13 step 4. Untouched by T-OP-133: still 0, an open owner question |
| `MM_MAX_TX_PER_TICK` | 60 | `20` | one bad tick spends a fifth as much gas |
| `MM_HALF_SPREAD_BPS`, `MM_MIN_HALF_SPREAD_USDG6`, `MM_PULL_MINUTES`, `MM_FAIR_MAX_AGE_S`, `MM_FAIR_SPOT_TOLERANCE_BPS`, `MM_REQUOTE_BPS`, `MM_SKEW_BPS_PER_DELTA_SHARE` | 500 / 20000 / 15 / 1800 / 300 / 300 / 10 | unchanged | the defaults were measured; changing pricing and the caps in the same week makes neither readable |

```bash
railway variables --service mm-bot --skip-deploys \
  --set MM_MARKETS=NVDA \
  --set MM_MAX_SERIES=4 \
  --set MM_MAX_SERIES_PER_MARKET=4 \
  --set MM_ASK_FALLBACK_ONLY=1 \
  --set MM_WRITE_OVERSUBSCRIBE_BPS=50000 \
  --set MM_BID_UNITS=25 \
  --set MM_ASK_UNITS=25 \
  --set MM_MAX_SERIES_UNITS=50 \
  --set MM_MAX_TOTAL_NOTIONAL_USDG6=500000000 \
  --set MM_DAILY_LOSS_LIMIT_USDG6=25000000 \
  --set MM_MAX_QUOTE_LIFETIME_S=900 \
  --set MM_DELTA_ALERT_SHARES=1 \
  --set MM_QUOTE_OFF_HOURS=0 \
  --set MM_MAX_TX_PER_TICK=20
```

**`MM_KILL_TOKEN`.** `openssl rand -hex 32`. The bot refuses to boot without one. `go-live-v2.sh` asks
for it with `read -rs` and pipes it to Railway; seal it in the UI straight after. **Put a copy in the
password manager before you run anything** — the kill switch is the fastest lever in §6 below and it is
useless if nobody can reach the token. The token is never typed at the shell again: the kill command
reads it out of the container's own environment (§6.2).

The vault guards are on chain and the bot sizes inside them, so these caps are the second line, not the
only one. Widening them is a Railway variable and a restart; widening the vault's is `setLimits`.

**First-week record template** (OWN3-203 / go-no-go). Copy this table into the day's notes; fill every
cell the same day. Exit gate (one clean week): two-sided on ≥ 3 of 4 series for ≥ 90 % of session
minutes, no unresolved P1, kill drill done. Any `v2_mm_loss_stop`, `v2_mm_outflow_foreign`, or a vault
order alive past its `validUntil` + one tick: `POST /kill` (§6.2), then `setLimits` with
`maxDailyOutflow` 0 if needed.

```
Week of: ________    SHA mm-bot: ________    SHA pricing: ________    gas-price at open (gwei): ________

| Day | Session minutes | Two-sided (of 4 series) | Minutes two-sided / session | Fills (bid/ask) | Kill drill (time, 0 live vault orders?) | Resume requoted? | Realised PnL USDG | outflow() used / cap | ETH spent (quoter) | Unresolved P1 (kind or none) |
|---|---|---|---|---|---|---|---|---|---|---|
| Mon |  |  |  |  |  |  |  |  |  |  |
| Tue |  |  |  |  |  |  |  |  |  |  |
| Wed |  |  |  |  |  |  |  |  |  |  |
| Thu |  |  |  |  |  |  |  |  |  |  |
| Fri |  |  |  |  |  |  |  |  |  |  |

Settlement (each expiry this week): E=________  snapshot in [E, E+600]? ____  finalize ____  settle ____
redeem leftover OI ____  recordedSources vs official close × uiMultiplier ____

Go / no-go for widening (tick after the Friday close):
- [ ] two-sided on ≥ 3/4 series for ≥ 90 % of session minutes, every session day
- [ ] kill drill done once: POST /kill left 0 live vault orders; /resume requoted
- [ ] no unresolved P1; no second v2_mm_loss_stop; outflow used stayed well under 250 USDG
- [ ] quoter still ≥ 0.02 ETH at each close; top-up back to 0.05 ETH is close-week, not an incident
- [ ] numbers in §5.8 written down
Decision: go / no-go / watch one more week.  Signed: ________  Date: ________
```

Where a cell is unknown (a fill you did not take, a series the bot did not quote), write `n/a` and
why — do not leave it blank. Session minutes are America/New_York regular hours that day
(09:30–16:00, or 09:30–13:00 on an NYSE early close in `ops/markets/v2-sources.json`).

### 3.6 The pricer

| Variable | Default | Canary |
|---|---|---|
| `PRICER_EDGE_BPS` | `500` | **500**, unless the owner decides otherwise |
| `PRICER_REPRICE_THRESHOLD_BPS` | 1000 | unchanged |
| `PRICER_MIN_INTERVAL_S` | 1800 | unchanged |

`PRICER_EDGE_BPS` is one of the two product settings still open on the owner's desk
(`status/HANDOFF-OWNER-2026-09-17.md` §2.5): the target is `fair × (1 + edge)`, clamped to each writer's
own `[minAskBps, maxAskBps]` band. v1 used 1000. Decide before the first writer sets a smart-pricing
strategy, or the first reprices happen at a number nobody chose. Changing it is a Railway variable and a
restart.

**Known gap for the canary:** the pricer has no session gate — `AutoRoller.reprice` has no session check
on chain and the pricer's planner checks only `trySpot` and a `/fair` answer, so it can reprice overnight
on the previous session's spot. It is bounded by each writer's own band. `deploy.md` §15.13, second open
item, ticket K2-05 follow-up. Do not reprice by hand out of hours.

### 3.7 The cranker

Defaults, with one change for the canary:

| Variable | Default | Canary |
|---|---|---|
| `CRANKER_MAX_TX_PER_STEP` | 50 | **20** — one market, six series; a step that wants more than 20 transactions is a bug worth seeing before it spends |
| `CRANKER_REDEEM_BACKLOG_S` | 3600 | unchanged: `v2_redeem_backlog` an hour after settlement |
| `CRANKER_NO_SOURCE_ALERT_S`, `CRANKER_PENDING_STUCK_S` | 3600 / 1800 | unchanged |
| `CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI` | 0 (never) | unchanged |

### 3.8 Relay and notifier secrets

| Secret | Service | From | Note |
|---|---|---|---|
| `RELAY_TOKEN` + `DISCORD_WEBHOOK_URL` (or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) | `relay` | set by hand, `deploy.md` §12.2 | **before any alert producer deploys.** An apply run refuses otherwise |
| `ALERT_WEBHOOK_TOKEN` | cranker, pricer, mm-bot, monitor | the reference `${{relay.RELAY_TOKEN}}` | a reference, never a value |
| `NOTIFIER_DATA_KEY` | `notifier` | `openssl rand -hex 32` | **keep an offline copy.** Losing it orphans every stored target and there is no rotation |
| `TELEGRAM_BOT_TOKEN` | `notifier` | @BotFather, a **new user-facing** bot | never the relay's operator bot, and never set a webhook on it |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | `notifier` | one `npx web-push generate-vapid-keys` run | a new pair invalidates every browser subscription |
| `PONDER_RPC_URL_4663` | `indexer-v2` | the keyed archive endpoint, the v1 indexer's value | pasted, not referenced: a reference breaks the day v1's `indexer` is deleted |
| `SMTP_URL` | `notifier` | leave **unset** for the canary | email is a separate decision with its own abuse bounds (`notifier/README.md`) |

Every one of these is set with `read -rs` piped to `railway variables --set-from-stdin`, and **sealed in
the Railway UI immediately after**. `go-live-v2.sh` prints the list to seal at the end of its run.

---

## 4. Services

Order is fixed and the script enforces it: relay first so boot alerts land, `indexer-v2` before its
callers, `pricing` before `pricer` and `mm-bot`, `mm-bot` last because it is the one that commits
capital. `web` is not here — it is §7.2's decision.

### 4.1 Relay first

```bash
railway variables --service relay --skip-deploys --set-from-stdin RELAY_TOKEN   # read -rs
# and the Discord webhook or the Telegram pair, the same way
cd <callhouse>
ops/go-live-v2.sh --apply --ref <app SHA> --services relay
```

### 4.2 Read the dry run, then apply

```bash
ops/go-live-v2.sh --ref <app SHA>                         # DRY RUN: preflight + every command, nothing changed
ops/go-live-v2.sh --apply --ref <app SHA>                 # relay, indexer-v2, pricing, cranker, pricer, notifier, monitor
ops/go-live-v2.sh --apply --ref <app SHA> --services mm-bot   # last, after §3.4 and §3.5
```

The dry run is not optional and it is not long. `deploy.md` §15.8 holds a fully recorded one; §8 below
records the canary-shaped run made while this runbook was written.

**What it refuses, and what each refusal means:**

| Refusal | What to fix |
|---|---|
| `the registry's v2 deployment is not complete` + the list of nulls | §2 above has not happened, or its write-back was not committed |
| `--apply requires --ref with the full 40-character reviewed commit SHA` | resolve the release to an immutable SHA and review that exact code and its submodule pin |
| `<REF> carries a different ops/markets/tier1.json than this checkout` | push the registry commit (§2.5) |
| `local rendered v2 env differs from <REF>` | an uncommitted `ops/v2-env.mjs` or `ops/v2/env` change. Commit it or revert it; Railway values come from the reviewed clone, never your working tree |
| `<svc> has a connected Railway repo or image source` | disconnect it in the UI. A connected source would later auto-deploy public `main` past the SHA pin, the registry comparison and the expiry-window guard |
| `mm-bot has a public domain` | delete it. `/kill` lives on the same port as `/health`; a domain puts the kill switch on the internet behind one token |
| `<svc> has the v1 variable KEEPER_PK / VAULT / FACTORY set` | delete it. A `V2_MODE` service never reads it, and a stray key is a key in the wrong place |
| `indexer-v2 has DATABASE_SCHEMA set` | delete it. Ponder indexes into a schema named after the deployment id; the stable name is `DATABASE_VIEWS_SCHEMA=callhouse_v2` |
| `<svc> is not redeployed between 15:40 and 16:20 New York time` | wait. The daily expiry is 16:00, the snapshot must land in `[E, E+600]`, and a volume allows one deployment at a time |
| `relay is not live with RELAY_TOKEN and a target` | §4.1 |
| `<file> derives to <addr>, but registry v2.bots.<bot> is <other>` | the key file and the registry disagree. Do not "fix" it by editing the registry; [`incident-v2.md`](incident-v2.md) §4d is the only order the tools accept |
| `<svc> has <n> replicas configured; it must run exactly one` | set replicas to 1 in the UI. Two crankers waste gas; two MM bots or two monitors double every order and every page |
| `Railway CLI <v> is too old: sealed variables are invisible to it` | upgrade to ≥ 5.47.2. An older CLI cannot tell a sealed secret from an unset one, so the script would re-prompt for secrets that are already there |
| `--offline skips the chain checks; never with --apply` / `--registry is for planning against a rehearsal copy; --apply deploys ops/markets/tier1.json only` | you are mixing a rehearsal's flags into the real run. Drop them |
| `<REF> cannot build what was selected:` + a list | the reviewed clone's shape is wrong — `keeper/Dockerfile` does not `COPY ops/markets/tier1.json`, `.dockerignore` excludes it, `web/Dockerfile` declares no `ARG NEXT_PUBLIC_V2`, or `web/lib/markets.generated.ts` lacks the deployed addresses (§2.5). The dry run prints the same list as `WILL REFUSE at --apply` |

After the run, in the Railway UI: **seal every secret it set**, and set each HTTP service's
healthcheck path, restart policy `On Failure` with 10 retries, and replicas **1**. For `monitor`,
verify **no healthcheck**, no public domain, the `/data` mount and one replica; the CLI sets its
start command and restart policy.

### 4.3 The monitor

The reviewed `go-live-v2.sh --apply --ref <app SHA>` run creates `monitor` after the notifier.
For a separate run after the relay is live, use `--services monitor`. It mounts `/data`, sets
`RAILWAY_RUN_UID=0`, the registry, state and seven health targets, the relay reference token,
the start command `node ops/v2/monitor.mjs --interval 60`, and restart on failure. It refuses
a public domain or more than one configured replica. Verify one replica and **no healthcheck**
in the Railway UI; the monitor serves no port. The script checks the deployed process command
and registry/state paths through `railway ssh` before reporting success.

The monitor watches what nothing else emits. Skipping it is choosing not to be told.

### 4.4 Health checks, per service

```bash
probe relay      http://relay.railway.internal:8080/health          # 200, targets listed
probe pricing    http://pricing.railway.internal:8790/health        # 200 status ok
probe cranker    http://cranker.railway.internal:8792/health        # 200 status ok (starting for ~3 intervals)
probe pricer     http://pricer.railway.internal:8794/health         # 200 status ok
probe mm-bot     http://mm-bot.railway.internal:8793/health         # 200 status ok
probe notifier   http://notifier.railway.internal:8791/health       # 200 status ok
probe indexer-v2 http://indexer-v2.railway.internal:42069/v2/health # 200 {"status":"ok",…,"interfaceVersion":7}

# each caller reaches what it calls
probe indexer-v2 http://pricing.railway.internal:8790/health
probe cranker    http://indexer-v2.railway.internal:42069/v2/health
probe mm-bot     http://pricing.railway.internal:8790/health
probe notifier   http://indexer-v2.railway.internal:42069/v2/health

railway domain list --service mm-bot --json                         # {"domains":[]}
curl -s https://notify.stonkhouse.fun/health                        # after the Cloudflare CNAME + TXT
```

A 503 on a bot means **the loop is wedged** — no completed tick in three poll intervals — and only that.
Low gas or a lagging RPC is `degraded` on a 200 and pages through the relay. `indexer-v2`'s `/ready` is
503 until the backfill from `V2_START_BLOCK` finishes; the deploy block is minutes old, so it is short.
An `ERR` while the target's own `/health` is green is the service name, the port, or two services in
different environments.

Read each bot's `/state` once, now, while nothing has happened. It is the baseline you will compare
against tomorrow:

```bash
probe cranker http://cranker.railway.internal:8792/state
probe mm-bot  http://mm-bot.railway.internal:8793/state
probe pricer  http://pricer.railway.internal:8794/state
```

### 4.5 Prove the alert path, once

Send a real alert through the relay from a bot's own container, with the token read from the environment
and never typed:

```bash
railway ssh --service cranker -- node -e 'fetch(process.env.ALERT_WEBHOOK,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.ALERT_WEBHOOK_TOKEN},body:JSON.stringify({source:"callhouse-cranker",kind:"boot",severity:"info",message:"v2 canary relay wiring test",data:{}})}).then(async r=>console.log(r.status,await r.text())).catch(e=>console.log("ERR",e.message))'
# 200 {"ok":true,"delivered":["discord"],"failed":[]}   AND the message visible in the channel
```

`502` with `failed[].error` `http_401` / `http_404` on Discord means the webhook URL is wrong or deleted;
`http_400` / `http_403` from Telegram usually means a wrong chat id or a bot that is not in the chat. The
relay logs `alert relayed` at warn when one target fails and another works, and `alert NOT delivered:
every target failed` at error for the 502.

Then prove the monitor's own delivery, from the monitor's shell, without touching its real state file:

```bash
railway ssh --service monitor -- node ops/v2/monitor.mjs --once \
  --state /tmp/probe.json --health probe=http://127.0.0.1:1/health
# pages v2_mon_service_down for "probe" through the relay
```

`--state /tmp/probe.json` is what keeps this off the real dedupe memory on `/data`; `--rpc` is not
passed because the service already has `RH_RPC`. The image is `keeper/Dockerfile`, so `/app` holds
`ops/v2/monitor.mjs` and `node_modules`, and the working directory is `/app`.

And one clean pass from a laptop with the same registry — reads only, nothing sent, no state written:

```bash
node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts; echo "exit $?"   # 0, every check [ok]
```

**Nobody can page you about the relay through the relay.** The out-of-band signal is the process dying:
an always-on monitor gives up after `MONITOR_MAX_FAILED_PASSES` consecutive passes that reached nobody
(default 3, about 3 minutes at `--interval 60`) and Railway's deploy notification email is the channel
that reaches you. Confirm that email address is one you read.

---

## 5. The first market day

Do this on a **regular session day**, starting in the morning, so the first daily expiry at 16:00 New
York is watched from the beginning. Not a Friday: a weekend feed gap is a bad first experience. Not a
half day.

### 5.1 The clock

| Moment | What happens | Who |
|---|---|---|
| any time | the cranker's `ladders` step creates the first series of each expiry — and the **first series of an expiry pins its settlement configuration** on the oracle and every source | cranker (permissionless) |
| `E − 45 min` | the MM bot pulls every quote on that expiry: `MM_PULL_MINUTES` (15) before the mint cutoff | mm-bot |
| `E − 1800 s` | the mint cutoff (`SETTLEMENT_WINDOW`): no more minting into that expiry, and the settlement TWAP window opens | contract |
| `E` = 16:00 NY | expiry | — |
| `[E, E + 600 s]` | `snapshot` (`SNAPSHOT_GRACE`): the pool records its window. Miss it and NVDA settles Chainlink-only after the 6 h delay | cranker |
| from `E + 120 s` | `finalize` (`FINALIZE_DELAY`). Two sources agreeing inside 150 bps finalize now; disagreeing or single-source records a candidate and waits the 21,600 s uncorroborated delay — read the exact moment from `candidate().finalizableAt` | cranker |
| after Finalized | `settle` each series, `prune` its open orders, then `redeem` holders — longs, then shorts | cranker |
| `E + 48 h` | the earliest `adminResolve` (`RESOLVE_DELAY`), and only inside the band | admin, incident only |

**Never redeploy a signing bot between 15:40 and 16:20 New York.** `go-live-v2.sh --apply` refuses it,
twice — once before it sets each bot up and once immediately before the upload, because key prompts can
cross into the window.

### 5.2 Watch the first series appear

```bash
probe cranker http://cranker.railway.internal:8792/state    # the ladders step: runs, outcomes, last actions

# SeriesCreated gained mintFeePpm at v7, so its topic0 moved; only longId and underlying are indexed
cast logs --address $CH \
  "SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)" \
  --from-block $(( $(cast block-number) - 5000 ))
#   mintFeePpm must read 80 on every one of them

cast call $ORACLE "settlementConfig(address,uint40)(bool,address[],uint16,uint32,uint32)" $ASSET $E
#   pinned, the source list, deviation, delay, spot age.
#   pinned MUST be true once a series exists, and the last value MUST be 90000
cast call $ORACLE "marketConfig(address)(address[],uint16,uint32,uint32)" $ASSET
#   what an expiry with no series yet would still pin: the same four values
```

`settlementConfig` returns the **pinned** copy once `pinned` is true, so this read is the check that the
expiry will settle on 90000 / 150 bps / 21600 s and the two sources. A change to any of them while the
expiry is open refuses the next series of it with `PinMismatch` and pages `v2_mon_pin_mismatch` — and the
spot age also changes `spot()` for everything immediately (§1.3, "What the pin actually pins").

If the cranker pages `v2_pin_refused`, a source the market lists is not configured or has not allow-listed
the oracle. It skips that expiry, retries in 15 minutes and creates nothing in the meantime — fail-closed,
by design. `../alerts.md` §V10a.

### 5.3 The MM bot's first quotes

```bash
probe mm-bot http://mm-bot.railway.internal:8793/state
```

Expect: `netDelta` zero, `lossStop` clear, four series with a `fair`, a `quote`, `sizes` inside the caps,
and live orders on both sides. A series with `halt` tells you why it is not quoted — `market-closed`
(outside the session), `spot-stale`, `fair-unavailable`, `spot-divergence`, `not-selected`.

```bash
ids() { cast call "$@" --rpc-url $RH_RPC --json | tr -d ' \n"' | sed 's/^\[//; s/^\[//; s/\].*$//' | tr ',' '\n' | grep -v '^$'; }
for s in $(ids $VAULT "trackedSeries()(uint256[])"); do echo "series $s:"; ids $VAULT "orderIdsOf(uint256)(uint256[])" "$s"; done
```

`--json` is not optional: `cast call` prints any uint256 from 10000 up as `10234 [1.023e4]`, and OrderBook
ids are a global counter, so a plain loop iterates the annotations too and every `cancel(uint256[])` fails
with a parser error.

### 5.4 Be the first buyer, and the first writer

Do both yourself, from your own wallet, at the smallest size, through the app. The buy is the whole point
of the product and the number you will quote everywhere:

- **Buy.** One rung, 0.01 share. Check the ticket: the price you pay, the taker fee (flat 0.10 USDG,
  capped at 10 % of premium), and that the page states the most you can lose is what you paid. That is
  the copy rule and the truth: **a buyer's maximum loss is the premium they paid, and most options expire
  worthless.**
- **Write.** Mint one contract. Check the **collateral rent** — new at v7, charged at mint out of the
  collateral, not out of the premium. Read it before you send, and again for the refund a close would
  pay:

  ```bash
  cast call $CH "mintFee(uint256,uint64)(uint256)"     <longId> <units> --rpc-url $RH_RPC
  cast call $CH "closeRefund(uint256,uint64)(uint256)" <longId> <units> --rpc-url $RH_RPC
  ```

  Each is equal, base unit for base unit, to what `mint` takes and what `close` credits in the same
  block. For scale: NVDA at 80 ppm on a Monday 09:45 weekly roll is about 107 USDG base units of rent on
  one unit against 3,949 of premium — 2.7 % — and `status/V7-DESIGN.md` §5.1 pins the exact arithmetic
  the contracts' own tests assert.
- **Resell** one of them, so a resale fill exists before the first expiry (resale fee 0 bps).

### 5.5 Watch the first expiry end to end

```bash
cast call $ORACLE "settlementInfo(address,uint40)(uint8,uint256,uint8,bool,bool,bool)" $ASSET $E
#   status: 0 None, 1 Pending, 2 Finalized, 3 Held
cast call $ORACLE "candidate(address,uint40)(uint256,uint8,bool,uint40)" $ASSET $E       # price, sourceIndex, disagreed, finalizableAt
cast call $ORACLE "recordedSources(address,uint40)(address[],bool[],uint256[],uint16)" $ASSET $E
cast call $UNI_SRC "snapshots(address,uint40)(uint128,int24,uint40)" $ASSET $E           # recordedAt 0 = no snapshot
cast call $CH "openInterest(address,uint40)(uint256)" $ASSET $E                          # 0 once every side is redeemed
```

**Check the price against an independent reference before you accept it.** A settlement price is per
Stock Token, so: the Nasdaq Official Closing Price for that session × `uiMultiplier() / 1e18`. Cboe's
delayed `current_price` includes after-hours trades and is **not** the close.

Then watch settle → prune → redeem in the cranker's `/state` and on chain. An ITM call long should be paid
in **USDG** through the payout adapter; `Redeemed(…, asset, amount, amountInKind, …)` with `asset ==
$ASSET` for a holder whose `payoutPrefs().inKind` is false means the conversion missed its 35 bps floor
and fell back to Stock Tokens. That is the fallback working, not a fault.

### 5.6 What each alert means on day one

Full text and the first three checks per kind are in `../alerts.md`; this is the triage order for the
canary.

| Alert | On day one it means | Go to |
|---|---|---|
| `v2_boot` | expected, once per bot per deploy. Names the mode, chain and signer | — |
| `v2_low_gas` | a bot is under 0.01 ETH. Top it up; it keeps trying and keeps failing | §1.5 |
| `v2_pin_refused` | a listed source cannot pin: no series for that expiry until it is fixed | `../alerts.md` §V10a |
| `v2_snapshot_missed` | the pool could not vote. NVDA settles Chainlink-only after 6 h — not lost, late | §V8 |
| `v2_sources_disagree` | Chainlink and the pool differ by more than 150 bps. The candidate carries `disagreed` and finalizes after the delay. **Price it yourself against the reference before the delay runs out** | [`incident-v2.md`](incident-v2.md) §1 |
| `v2_settlement_held` | the guardian vetoed. Nothing settles until `unveto` (delay restarts) or an `adminResolve`, earliest `E + 48 h` and only inside the band | §1 |
| `v2_settle_stuck`, `v2_mon_settlement_late`, `v2_mon_series_unsettled` | the expiry is not finishing. Every lifecycle call is permissionless — you can do the cranker's work by hand | §2, and its fixed gas limits |
| `v2_redeem_backlog`, `v2_mon_redeem_backlog` | holders are settled but unpaid an hour (6 h for the monitor) later | §2 |
| `v2_mm_killed` **that nobody sent** | `MM_KILL_TOKEN` is out. P1 | §4c, and rotate the token |
| `v2_mm_loss_stop` | 25 USDG realised loss today; every quote is pulled until 00:00 UTC | §V11b |
| `v2_mm_not_quoter`, `v2_pricer_no_role` | a role was revoked that nobody on the rota revoked → treat as admin key compromise | §5 |
| `v2_mm_delta` | one share of net inventory. Expected early; there is no borrow market, hedging is by hand | §V11c |
| `v2_mm_tx_rejected`, `v2_mm_funds`, `v2_mm_pricing` | the bot is being stopped by a guard, by money, or by no fair value. Usually informative, not urgent | §V11e–g |
| `v2_mon_config_changed` | an admin or role event on our contracts. **Every one of these should be something you just did.** One that is not is §5 | §V27 |
| `v2_mon_feed_*`, `v2_mon_safe_*` | someone changed the Chainlink proxy, its access controller, or its owner Safe | §V28 |
| `v2_mon_token_paused`, `v2_mon_usdg_paused`, `v2_mon_token_blocked` | the issuer paused or blocked something. Closes and redemptions keep working; minting may not | §6 |
| `v2_mon_pool_liquidity_low`, `v2_mon_pool_wiring` | the pool fell under its floor, or points somewhere the registry does not name | §V34, §V34a |
| `v2_mon_l2_lag` | the chain's head is behind. Above 15 minutes it is P1 | `incident.md` §7 |
| `v2_mon_state_unwritable` | the monitor cannot write its volume — it is re-paging everything every pass | §4.3 |

### 5.7 The on-call job the monitor cannot do

Once per session, by hand, until the O2-06 follow-up lands: **is the price network actually moving?**
Nothing pages a stalled feed whose last print is still within 3 % of the truth. Signs:

- `spot-divergence` refusals in `mm-bot` `/state`, or `v2_mm_pricing` / `v2_pricer_fair_unavailable`;
- a Chainlink print more than 150–300 bps from Cboe's `current_price × uiMultiplier`, or from the pool
  TWAP, for over five minutes:
  `cast call $UNI_SRC "latest(address)(bool,uint256,uint256)" $ASSET`;
- a feed that normally prints several times an hour going silent for an hour.

Any of them: [`incident-v2.md`](incident-v2.md) §7.

### 5.8 The numbers to record

Write them down the same day; they are the input to every "can we widen this?" conversation.

| Number | Where |
|---|---|
| gas per action (createSeries, snapshot, finalize, settle, prune, redeemBatch, roll, mm place/replace/cancel) | each bot's `/state` journal rows; compare with the fork's table in [`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md) → "Gas per action" |
| ETH spent per bot | `cast balance` at open and at close |
| bounty spend per expiry, by action | `Rewarded` logs on `$REWARDS`. Fork baseline: **0.19 USDG per (underlying, expiry)**, 0.33 on the busiest, rolls 0.10 |
| `KeeperRewards` balance and whether `dailyCap` was reached | `cast call $USDG "balanceOf(address)(uint256)" $REWARDS` |
| fees taken | seller fee 0 at v7 (rent replaced it), taker flat 0.10 USDG capped at 10 %, exercise 25 bps, resale 0 |
| **collateral rent** charged and refunded | `cast call $CH "mintFee(uint256,uint64)(uint256)" <longId> <units>` before the mint and `"closeRefund(uint256,uint64)(uint256)"` before a close — each is equal, base unit for base unit, to what the call takes or credits in the same block. `MintFeesAccrued(longId, asset, amount)` on `settle` is the rent the protocol kept. The first real-money check of the c05 design |
| MakerVault: USDG and NVDA in and out, realised PnL, net delta, `outflow()` used | `/state` and `cast call $VAULT "outflow()(uint256,uint256)"` |
| settlement: candidate price, both sources' prices, the deviation, your independent reference | `recordedSources`, and your own arithmetic |
| the wall-clock from expiry to the last holder paid | the logs |

### 5.9 Stop conditions

Stop and go to §6 below — do not "watch it a bit longer" — on any of these:

1. A settlement price you cannot reconcile with the official close × `uiMultiplier` to within the
   deviation you expect. **Veto before it finalizes**, then reconcile.
2. `v2_mon_config_changed` for a role or configuration change **nobody on the rota made**.
3. `v2_mm_killed` that nobody sent, or a quoter role revoked that nobody revoked.
4. A holder who cannot redeem a settled series, for any reason other than a token or USDG freeze.
5. Rent, fees or a payout that differ from what the contracts' own tests say they should be.
6. The MM bot's realised loss reaching the 25 USDG stop twice in a week, or `outflow()` used approaching
   the cap during honest quoting.
7. Any `FAIL` from a re-run of `--verify`.

---

## 6. Abort and rollback

**There is no contract rollback.** The contracts are immutable and nothing is upgradeable. What exists is
a fast way to stop new risk, a slower way to wind a market down cleanly, and — only if the set itself is
broken — a fresh deployment. Everything in this section is designed so that **holders can always get out**:
`close`, `withdraw`, `redeem`, ERC-1155 transfers, `cancel`, `prune` and `claimOwed` have **no pause at
all**, and settlement is never pausable.

### 6.1 Guardian pauses — minutes, reversible, no balance touched

The guardian delays; it never redirects. No guardian function touches a balance.

```bash
# stop new series (the AutoRoller cannot roll either)
cast send $CH   "setCreatePaused(bool)" true                --rpc-url $RH_RPC --account guardian
# stop minting new contracts on NVDA (closes and redemptions keep working)
cast send $CH   "setMintPaused(address,bool)" $ASSET true   --rpc-url $RH_RPC --account guardian
# stop trading on the book: place, placeFor, replace, take (cancel and prune are NEVER pausable)
cast send $BOOK "setTradingPaused(bool)" true               --rpc-url $RH_RPC --account guardian
# hold one expiry's candidate price
cast send $ORACLE "veto(address,uint40)" $ASSET $E          --rpc-url $RH_RPC --account guardian

# confirm, then the same calls with false to lift
cast call $CH   "createPaused()(bool)"  --rpc-url $RH_RPC
cast call $BOOK "tradingPaused()(bool)" --rpc-url $RH_RPC
# mintPaused is the second field of the market config, not a view of its own
cast call $CH   "market(address)((bool,bool,uint64,uint16,address,uint32))" $ASSET --rpc-url $RH_RPC
#   (enabled, mintPaused, strikeTick, exerciseFeeBps, oracle, mintFeePpm)
```

| Pause | Stops | Leaves working |
|---|---|---|
| `setCreatePaused(true)` | new series, and therefore rolls | everything on existing series |
| `setMintPaused(asset, true)` | minting new contracts on that market; `AutoRoller.roll` reverts `MintPaused` | buying, selling, closing, settlement, redemption |
| `setTradingPaused(true)` | `place`, `placeFor`, `replace` and `take` — the MM bot's whole tick | `cancel`, `prune`, closing, settlement, redemption |
| `veto(asset, expiry)` | that expiry finalizing — status `Held` | every other expiry |

A veto is a **delay, not a decision**, and it has its own way back:

```bash
# lift it: Held -> Pending, with the uncorroborated delay restarted from this call (guardian or admin)
cast send $ORACLE "unveto(address,uint40)" $ASSET $E --rpc-url $RH_RPC --account guardian
```

`unveto` is the normal exit once the price is reconciled. `adminResolve` is the other one, allowed only
from `E + RESOLVE_DELAY` (48 h) and only inside the band the oracle computes — read it first with
`cast call $ORACLE "resolveBand(address,uint40)(bool,uint256,uint256)" $ASSET $E`. A final price is final:
`veto` and `adminResolve` both revert `AlreadyFinal`.

### 6.2 The MM kill switch — seconds

The fastest lever. It stores the kill first (a restart stays killed), then cancels every vault order on
every market until a re-read finds none.

```bash
railway ssh --service mm-bot -- node -e 'fetch("http://127.0.0.1:8793/kill",{method:"POST",headers:{authorization:"Bearer "+process.env.MM_KILL_TOKEN,"content-type":"application/json"},body:JSON.stringify({reason:"canary abort"})}).then(async(r)=>console.log(r.status,await r.text()))'
# 200 { killed: true, at, reason, cancelled, remaining: 0, remainingOrderIds: [], done: true, errors: [] }
# 202 with done: false means the cancels are still running (remaining -1) or some order survived a pass
# 401 { error: "unauthorized" } is a wrong or missing token — the same body whatever was wrong
# to lift it: the same command with /resume instead of /kill -> 200 { killed: false, at }
```

`remaining` above 0, or `errors` in the body, means cancel by hand: [`incident-v2.md`](incident-v2.md) §4c
step 3, with the `ids` helper. A kill **nobody sent** means the token is out — P1, §4c, and rotate
`MM_KILL_TOKEN` with the key.

### 6.3 Revoking roles

```bash
cast send $VAULT  "revokeRole(bytes32,address)" $QUOTER_ROLE $QUOTER --rpc-url $RH_RPC --account admin
cast send $ROLLER "revokeRole(bytes32,address)" $PRICER_ROLE $PRICER --rpc-url $RH_RPC --account admin
cast call $VAULT  "hasRole(bytes32,address)(bool)" $QUOTER_ROLE $QUOTER --rpc-url $RH_RPC   # false
```

Kill switch **first**, revoke **second**: the kill cancels with the same key, so it does nothing once the
role is gone. Then stop the service so it does not spin on `NotAuthorized`. Each revoke is a
`v2_mon_config_changed` error — expected, acknowledge it.

Rotating a key afterwards is [`incident-v2.md`](incident-v2.md) §4d, and only that order: the tools
refuse a half-done rotation rather than point a bot at the wrong key.

### 6.4 Wind one market down cleanly

The graceful abort. It ends the market without stranding anyone.

1. **Stop new risk.** `setCreatePaused(true)` and `setMintPaused($ASSET, true)`. Leave trading open so
   holders can sell; leave `cancel` alone (it is never pausable).
2. **Kill the MM bot** (§6.2) and confirm the vault's book is empty.
3. **Let every open series reach its expiry and settle.** Do not stop the cranker: it is what pays people.
   If you must, every call it makes is permissionless and [`incident-v2.md`](incident-v2.md) §2 step 3 has
   the by-hand version with the fixed gas limits and the batch sizes — never an estimated limit, because
   `finalize`, `settle`, `prune` and `redeemBatch` swallow an inner out-of-gas and "succeed" having done
   nothing.
4. **Prune before you redeem.** Resale asks hold longs that are about to be redeemed, and the book opts
   out of third-party redemption, so an unpruned order leaves escrowed longs unpaid. 25 order ids per
   `prune` call.
5. **Redeem.** 40 holders per `redeemBatch` in kind, **15** when ITM call longs are being converted to
   USDG (450k gas each) — `redeemBatch` silently skips what does not fit. Check `balanceOf` after every
   batch, then `openInterest(asset, expiry)` until it is 0.
6. **Withdraw the vault.** Ledger → vault → treasury, then `claimOwed()`. Collateral locked in open shorts
   frees at settlement; withdraw it then. The commands are [`incident-v2.md`](incident-v2.md) §4c step 4.
7. **`defund` KeeperRewards** once nothing is left to crank.
8. **Set `markets[NVDA].v2.status` to `paused`** — not `planned`: `paused` keeps `registeredAt` and
   `registerTx`, so the market stays registered and the monitor keeps watching it (its default scope is
   `live` and `paused`), while the cranker's `ladders` step stops creating series for it (that step reads
   `live` only). It does **not** stop the MM bot while `MM_MARKETS` names NVDA — a named ticker is quoted
   at any status — so the kill in step 2 is what holds, and clearing `MM_MARKETS` is the durable form.
   Commit, push, rebuild the keeper-image services (`deploy.md` §15.2). Leave the contracts deployed and
   **leave redemption open forever**: there is no expiry on a settled holder's claim, and nothing about
   closing the market takes it away.
9. **Publish what happened**, in the language of the copy rules, before anyone has to ask.

### 6.5 If the contract set itself is broken

`DEPLOY-V2.md` → "Rollback": pause new risk, deploy a fixed set against a registry whose `v2.contracts`,
`v2.deployBlock` and every `registeredAt` / `registerTx` are null (git history keeps the old values; write
them into the incident record), rehearse, broadcast, verify — then point the registry at it and redeploy
the services. **Keep a cranker running against the OLD addresses until every old series is settled and
redeemed**, and withdraw the old MakerVault and `defund` the old KeeperRewards only after that.

### 6.6 Service rollback

`deploy.md` §15.10 is the table. The two that bite:

- **An image rollback is a registry rollback.** A keeper image from before the write-back refuses to boot;
  one from before a market went `live` ignores that market. If the registry moved, revert the code commit
  and rebuild from the current registry instead.
- **Kill the MM bot before rolling it back**, and never roll back a signing bot inside the expiry window.

`web` is the easiest: redeploy the last deployment whose `NEXT_PUBLIC_V2` was unset. Reverting the
variable alone does nothing until a rebuild.

### 6.7 What cannot be undone

- **A finalized settlement price.** `veto` and `adminResolve` revert `AlreadyFinal`. The only window is
  before finalize.
- **A pinned settlement configuration.** The first series of an expiry pins the source list, deviation,
  delay and spot age, and that expiry settles on the pinned copy whatever the market says later. Changing
  the market afterwards does not re-pin it — it refuses the next series of every already-pinned expiry
  (`PinMismatch`) until you change it back. The one that is not pinned is `spot()`, which always reads
  the market's current spot age (§1.3).
- **A deployed contract.** Immutable, not upgradeable.
- **A mined transaction**, including a wrong `setMarketConfig`, a wrong route, or funds sent to the wrong
  address.
- **`NOTIFIER_DATA_KEY`.** Lose it and every stored notification target is orphaned; there is no rotation.
- **A burned BIP-44 index.** Once a key file is archived and the registry entry re-pointed, that index
  stays burned.
- **A published number.** Check the arithmetic before the post, not after.

---

## 7. Sign-off

### 7.1 The checklist the owner ticks

Preconditions

- [ ] contracts SHA recorded, `forge test` and the fork suites green from a clean tree
- [ ] app SHA recorded, pushed, and its contracts submodule pin is that contracts SHA
- [ ] `ops/v2/rehearse.sh --publish` re-run on v7 and exits 0; its report read, including "Deviations" and "Not covered"
- [ ] `build-markets --check`, `v2-env --check`, `keeper-env --check`, `copy-lint`, `runbooks.test.mjs`, the keeper and monitor suites all green
- [ ] registry: `interfaceVersion` 7, `premiumFeeBps` 0, NVDA `mintFeePpm` 80, `spotMaxAgeS` 90000, NVDA pool present, the 11 shallow-ring markets carry no pool
- [ ] NVDA pool `observationCardinality` ≥ 2401 read on chain today
- [ ] gas price read today, and the deploy's ETH cost multiplied out from it
- [ ] admin ≥ 0.05 ETH; three bots ≥ 0.02 ETH each; guardian ≥ 0.005 ETH; admin holds ≥ 200 USDG and ≥ 1.1 NVDA
- [ ] the three keystore accounts imported; `MM_KILL_TOKEN` generated and in the password manager
- [ ] Railway CLI ≥ 5.47.2, logged in, project linked; `web`'s GitHub source disconnected
- [ ] `relay` has `RELAY_TOKEN` and a live target

Deploy

- [ ] rehearsal `BATCH PASSED` + `VERIFY PASSED`, less than 24 hours before the broadcast
- [ ] the plan read line by line: 1 market, phase `fresh`, `premium 0 bps`, `PPM 80`, `AGE 90000`, the pool column filled
- [ ] broadcast confirmed by typing `deploy`; the run ended `BATCH PASSED`
- [ ] `--verify --expect-fresh true`: `VERIFY PASSED`, zero `FAIL`
- [ ] write-back committed and pushed; `v2.status` set to `live`; `gen:markets` committed

Wiring

- [ ] `PRICER_ROLE`, `QUOTER_ROLE` and the three guardian roles confirmed on chain; the cranker holds none
- [ ] KeeperRewards funded 25 USDG, `dailyCap` 5 USDG
- [ ] payout route reads back as the NVDA pool, slippage 30 bps
- [ ] vault limits read back as `(100, 1000000000, 100, 1000, 1800, 250000000)`; `outflow()` used 0
- [ ] vault funded 150 USDG + 1 NVDA
- [ ] every `MM_*` canary variable set and read back on `mm-bot`; `MM_MARKETS=NVDA`
- [ ] `PRICER_EDGE_BPS` decided
- [ ] every secret sealed in the Railway UI

Services

- [ ] dry run read; `--apply` run per §4.2; every service `SUCCESS`
- [ ] every `/health` 200; `indexer-v2` `/v2/health` names `interfaceVersion 7`; `/v2/config` names the deployed clearinghouse
- [ ] every private-network probe answers; `mm-bot` has **no** domain
- [ ] healthcheck path, restart policy and replicas 1 set per service in the UI
- [ ] `monitor` service created by hand, volume mounted, one clean `--once` pass
- [ ] the relay wiring test landed in the channel; the monitor's own delivery proved
- [ ] Railway deploy-notification email goes somewhere you read

First day

- [ ] first series created; the pinned `settlementConfig` ends in `90000`
- [ ] MM quotes live on both sides, inside the caps
- [ ] one buy, one mint, one resale done by the owner; rent and fees match the contracts' arithmetic
- [ ] first expiry: snapshot inside `[E, E+600]`, finalize, settle, prune, redeem, `openInterest` 0
- [ ] the settlement price reconciled against the official close × `uiMultiplier`
- [ ] §5.8's numbers written down

Go / no-go for widening

- [ ] no held settlement; redeem backlog zero; bounty spend within budget; no unexplained alert
- [ ] the numbers are within a factor of two of the fork's
- [ ] one full weekly cycle clean before anything in O2-07 starts

### 7.2 The web flip

Only after the first expiry settled cleanly and §7.1's "First day" boxes are ticked. It is a decision, not
a step in the bring-up, which is why `go-live-v2.sh` will not do it unless you name it:

```bash
ops/go-live-v2.sh --apply --ref <app SHA> --services web
curl -s -o /dev/null -w '%{http_code}' https://app.stonkhouse.fun/settings/notifications   # 200 only in a NEXT_PUBLIC_V2=1 build
```

It refuses the flip while any earlier selected service is incomplete. It is a **rebuild**, not a restart —
`NEXT_PUBLIC_*` are build arguments. Note the accepted degradation: `NEXT_PUBLIC_API_URL` is read by both
the v2 app and the `/legacy` v1 pages, so pointing it at `indexer-v2` costs the legacy history panels.
Acceptable only because v1 is in run-off.

### 7.3 After success

- `ops/addresses.json`: add the v2 set. The registry's `v2.contracts` is the source of truth; what
  belongs in `addresses.json` is each address with the call that proved it and the evidence, the way every
  other row there is written.
- D2-05 (docs) and S2 (site, `lib/site.ts`) take the mainnet addresses — both are codex's lanes and both
  have been waiting on exactly this.
- `node ops/markets/render-docs.mjs` and commit the rendered Markets page in `callhouse-docs`. It is
  currently the v1 page and `--check` fails against it.
- O2-07 (`runbooks/v2-waves.md`) is the next wave, and its first gate is one clean weekly cycle here.

### 7.4 The next morning

Fifteen minutes, before anything else:

```bash
node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts; echo "exit $?"   # 0
for a in <cranker> <pricer> <mmQuoter>; do echo -n "$a "; cast balance "$a"; done
cast call $USDG "balanceOf(address)(uint256)" $REWARDS
cast call $VAULT "outflow()(uint256,uint256)"
probe cranker http://cranker.railway.internal:8792/state
probe mm-bot  http://mm-bot.railway.internal:8793/state
probe pricer  http://pricer.railway.internal:8794/state
cast call $CH "openInterest(address,uint40)(uint256)" $ASSET $E    # 0 for yesterday's expiry
```

1. **Read every alert from the night, in order.** An overnight `v2_mm_*` is almost always
   `MM_QUOTE_OFF_HOURS=0` doing its job; an overnight `v2_mon_config_changed` is not.
2. **Top up gas** on any bot under 0.02 ETH, and note the burn rate per bot per day.
3. **Check the bounty budget** against the previous day's spend and decide whether 25 USDG still covers a
   month.
4. **Check the vault**: realised PnL, net delta, `outflow()` used, whether anything was `capped` by a bot
   limit rather than a vault one. A bot cap biting is a sizing decision; a vault cap biting is a design
   one.
5. **Confirm yesterday's expiry is fully closed** — `openInterest` 0, no redeem backlog, every holder paid.
6. **Write the day up**: §5.8's numbers, anything that surprised you, anything you had to do by hand. That
   note is what O2-07's wave gate is judged against, and the second market is not a smaller decision than
   the first one.

---

## 8. Dry-run record

The gate for this runbook is that its commands were dry-run against the rehearsal fork or a read-only
mainnet endpoint before anyone was asked to type them. What was run, by whom, and what it printed — the
last column is the evidence, not a summary of it:

| Command | Where | Result |
|---|---|---|
| `DeployV2Batch.sh --rehearse … --wave canary --dry-run` against a v7-shaped registry copy | contracts `v2-v7` `c8a0ece`, 2026-09-17 | exit 0. Plan: `1 market(s) to register`, phase `fresh`, `premium 0 bps`, NVDA `PPM 80`, `AGE 90000`, pool `0xd4EB2120…` fee 500 — quoted in §2.1 |
| the same against the current v6 registry | as above | exit 1, `BATCH FAILED: registry v2.interfaceVersion is 6; these scripts are INTERFACE_VERSION 7` |
| `script/v2/rehearse-v2.sh` (full batch + VerifyV2 + four drills) | contracts `v2-v7`, run by the v7 integration lane on 2026-09-17; **cited here, not re-run for this runbook** | `VERIFY PASSED 144 checks`, 13 creates, 21 admin calls, 29,998,453 gas — the record is `DEPLOY-V2.md` → Rehearsal records |
| `ops/go-live-v2.sh --offline` against the shipped registry | app `v2-O2-04-canary`, 2026-09-17 | exit 1, the full null list — the precondition gate in §4.2 |
| `ops/go-live-v2.sh --offline --registry <rehearsal copy> --services relay,indexer-v2,pricing,cranker,pricer,mm-bot,notifier` | as above, re-run at review | exit 0, `DRY RUN COMPLETE`. Every `railway` command printed in order, and the preflight now prints `mm-bot: selected; its MM_* caps come from ops/runbooks/v2-canary.md, read it before --apply` where it used to warn that the file did not exist (§3.5) |
| `node --test ops/runbooks.test.mjs` | as above | exit 0, 13/13. Five of them are this runbook's: the private-network ports against `go-live-v2.sh`'s service table, the `go-live-v2.sh` and `monitor.mjs` flags against each parser, every `NAME=value` against the services' own source, every backticked `v2_*` kind against `keeper/src/v2/alerts.ts` and `ops/v2/monitor.mjs`. Each was mutation-checked on a throwaway copy — port 8799 for the MM bot, `--service` for `--services`, `--no-alert` for `--no-alerts`, a typo in `MM_MAX_TX_PER_TICK`, a typo in the `v2_mm_loss_stop` kind — and each failed as it should. (The typos are described, not written: the kind test would flag one written here, which is the test biting) |
| `node ops/v2-env.mjs --check`, `node ops/keeper-env.sh --check`, `node scripts/copy-lint.mjs`, `bash -n ops/go-live-v2.sh`, `pnpm --filter @callhouse/keeper typecheck && test` | as above | exit 0: 6 files, 35 files, 0 violations, clean, 517/517 |
| `node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts` | as above, against mainnet | exit 0, `0 finding(s)`, `usdg paused false`; the v2 checks `skipped … (pre-deploy)`, which is the pre-deploy shape |
| `cast chain-id / block-number / base-fee / gas-price / balance / call` | mainnet 4663, read-only, 2026-09-17, blocks 65,677,424 and 65,700,447–65,701,790 | every figure in §1.4 and §1.5. Gas: base fee 58,946,000–59,820,000 wei and gas price 58,982,000–59,830,000 wei over five samples, i.e. **0.059–0.060 gwei** — the same order as the decision log's 0.056, and the reason §1.4 says to divide by 1e9 |
| `ops/v2/rehearse.sh --publish` (the whole stack, 10 drills) | app, run by the O2-03 lane on 2026-09-17 at INTERFACE_VERSION 6; **cited here, not re-run for this runbook** | exit 0 — [`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md). **Re-run it on v7 before the broadcast** (§1.2) |

Not dry-run, and not runnable without doing the thing: `--broadcast`, `go-live-v2.sh --apply`, the funding
sends, `setLimits`, the guardian pauses, the kill switch. Each has a fork counterpart in the O2-03
rehearsal — the guardian veto, the mint pause, the USDG pause, the killed cranker and the disagreeing
sources are all drills in that report, with their transaction hashes.

---

## Related

- `../deploy.md` §15 — the v2 services: layout, variables, secrets, bot keys, first deploy, rollback, the
  monitor, the spot-age analysis
- [`incident-v2.md`](incident-v2.md) — oracle dispute, paused settlement, payout conversion failing, bot
  key compromise, admin key compromise, issuer freeze, stalled feed
- `../alerts.md` "v2" — every `v2_*` and `v2_mon_*` kind, its severity, its first three checks
- `callhouse-contracts/docs/DEPLOY-V2.md` — the registry contract at v7, the scripts, what is deployed,
  resume and recovery, the preflights, what VerifyV2 checks, the rehearsal records
- `callhouse-contracts/SECURITY.md` — what a compromise of each key buys, and the accepted risks
- [`../v2/REHEARSAL-2026-09-17.md`](../v2/REHEARSAL-2026-09-17.md) — the fork rehearsal: assertions, ten
  drills, gas per action, bounty spend per expiry, deviations
- [`v1-runoff.md`](v1-runoff.md) — switching v1 off, afterwards
- `../markets/README.md` — the registry's contract
