# Alerts

How a keeper problem reaches a human, and what to do first.

**The contract, honestly stated.** The keeper emits webhook alerts from `keeper/src/alerts.ts`.
Each payload is one JSON POST:

```json
{
  "source": "callhouse-keeper",
  "kind": "tx_revert",
  "severity": "error",
  "message": "rollOpen reverted on chain",
  "vault": "0x…",
  "chainId": 4663,
  "at": "2026-09-12T20:00:00.000Z",
  "data": { "kind": "rollOpen", "hash": "0x…" }
}
```

The index below lists the kinds the pooled vault's keeper emitted when this file was written; the
complete v1 vocabulary (all 24 kinds, which process emits each, and which still fire in the v1 run-off)
is §V16 in the "v2" part at the end of this file, together with every v2 kind. That is what a relay or
a human must key on. `keeper/src/alerts.ts` (`AlertKind`) is the source of truth for the
names; this file is the runbook for them. The payload `severity` is `info | warn | error`; the
P-level mapping is per kind in the index. Delivery dedupes per `kind:dedupeKey` for one hour
(`KEEPER_ALERT_COOLDOWN_MS`); a **failed** delivery is retried in five minutes, not held for the
hour. State changes (`boot`, `roll_open`, `roll_close`, `claim_stranded`, an on-chain revert) fire
with `force` and are never suppressed.

**Retired on 2026-09-13 with the redesign:** `api_reject` and `listing_invisible`. There is no
Overcall order book, no POST, no book status and no venue to be invisible on; the self-hosted fill
page is the venue and its health is the keeper's own `/orders`. Added: `claim_stranded`,
`strand_retry_failed`, `fill_sim_revert`.

**Transport:** `ALERT_WEBHOOK` is a generic JSON POST. Telegram and Discord do not accept this
shape directly; a raw Discord URL returns 400 forever and you will see nothing. `ALERT_WEBHOOK`
therefore points at **`relay/`**, the Railway service `relay` (`relay/README.md`,
`ops/deploy.md` §12), which checks a shared token, validates the payload, and posts it to Discord
(`content`, ≤ 2000 chars, mentions disabled) and/or Telegram (`sendMessage`, plain text, ≤ 4096),
prefixed 🔴 ERROR / 🟠 WARN / 🔵 INFO. With `ALERT_WEBHOOK` unset, alerts are logged at their own
severity and stored in SQLite (`alerts` table), nowhere else.

- **The token.** The relay requires `RELAY_TOKEN`, as `Authorization: Bearer <token>` or as
  `?token=<token>`. The keeper sends the header when `ALERT_WEBHOOK_TOKEN` is set (≥ 16 chars), so
  wire it as `ALERT_WEBHOOK=http://relay.railway.internal:8080/alert` plus
  `ALERT_WEBHOOK_TOKEN=<RELAY_TOKEN>` (private network, same Railway project). The `?token=` form
  still works but can land in proxy logs; do not use it. The keeper's config errors never echo a URL
  value, so a malformed `ALERT_WEBHOOK` does not print a token at boot.
- **What the keeper hears.** 200 when at least one configured target accepted (a partial failure
  is logged by the relay, not retried; a retry would duplicate the message where it landed); 502
  when every target refused, timed out (`RELAY_TIMEOUT_MS`, default 5 s, under the keeper's 10 s
  abort) or was unreachable, so the keeper's five-minute retry applies; 401 wrong/missing token;
  400 not a keeper alert. `kind` is **not an enum on the relay side** (any lowercase snake_case
  identifier passes), so a new or renamed kind still arrives; only this index goes stale.
- **Silence is the failure mode.** A relay with a wrong token, a deleted Discord webhook, or a bot
  removed from its chat looks exactly like a quiet week. The weekly webhook test below is the
  control; `ops/deploy.md` §12.4 is the one-line test.

**Health endpoint:** `GET /health` on `KEEPER_PORT` (default 8787). 200 `ok`/`degraded` while the
keeper ticks (degraded covers low gas, RPC lag, a slow in-flight transaction, a stranded claim
being retried); 503 `wedged` only when no tick has started or completed in three poll intervals
*and* no tick is currently running younger than the tx timeout. Unauthenticated; RPC URLs are served
redacted to their origin. **Railway probes it only at deploy time** and its `On Failure` restart
policy fires only on a crash, so a 503 wedge is neither restarted nor alerted by Railway: the
external monitor in §11 is not optional.

## Severity

| Payload | P-level | Meaning | Response |
|---|---|---|---|
| `error` | **P1/P2** | A transaction reverted, a claim is stranded, the cycle is stuck | Per kind, below |
| `warn` | **P2/P3** | The vault is behaving correctly but something around it is not | Within the hour |
| `info` | **INFO** | Expected behaviour worth recording | None. Several feed the weekly publish |

**An unfilled week is INFO, not an alert.** It is the most likely outcome, the product promises to
publish it honestly, and paging somebody about it trains everyone to ignore the channel.

## Shell prelude for every "first three checks" block

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_RPC_2=https://robinhood-rpc.publicnode.com
export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
export FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
export VAULT=<from ops/addresses.json>
export CLEAR=$(cast call $VAULT "clear()(address)" --rpc-url $RH_RPC)
```

### §0 Every `cast logs` in this file carries `--from-block`. Here is what the two RPCs actually serve.

Measured 2026-09-21 at head 69,203,074 against USDG `Transfer` logs, twenty-block windows, both RPCs from
the prelude. Two rows (T-CV-FLYWHEEL, T-CV-OTHER-CONTRACTS) had already paid to learn the state half;
this is the log half, and it is NOT the same window.

**`$RH_RPC` (rpc.mainnet.chain.robinhood.com)**

- **State is pruned. Logs are not.** `cast call ... --block <head-512>` answers; `--block <head-9428>` returns
  `error code -32000: historical state ...`. The state boundary sits somewhere between 512 and 9,428 blocks
  back and has not been bisected. `eth_getLogs`, by contrast, returned rows at head-512, head-9,428,
  head-50,000, head-1,000,000, head-3,000,000 and head-10,000,000. On this node a deploy-block lower bound
  on a `cast logs` query is INSIDE retention, so an empty answer to a bounded query means the query is
  wrong, not that the range is gone. Do not carry the state window over to logs; they are different stores.
- **An unbounded `cast logs` (no `--from-block`) does not return rows on this node, ever.** It fails loud:
  `error code -32602: expected fromBlock to be a hex string starting with 0x`. A control written without
  the bound therefore never produced a green here; it produced an error the reader had to interpret.
- **A raw `eth_getLogs` with neither bound** (a script that omits both fields) is answered for the head
  block only: `0` rows, no error. That is the fail-open shape — "no rows" reads as "nothing happened" when
  it means "you asked about one block".
- **Wide queries are capped**: `--from-block 1` on a busy event returns
  `error code -32000: logs matched by query exceeds limit of 10000`. Deploy-block bounds are fine for
  admin events (a handful of rows); for `Transfer`-class events use a recent window.

**`$RH_RPC_2` (robinhood-rpc.publicnode.com) — do not run a log control against it.**

- Any `--block` state read returns HTTP 403 `Archive requests require a personal token`.
- `cast logs` for a window older than roughly 64 blocks, and ANY `cast logs` while the endpoint is
  throttling, **exits 0 with empty output and no error**. Measured: a head-30 window returned 88 rows,
  then 0 rows on the identical query seconds later; head-64 through head-10,000,000 all returned 0 rows
  with exit 0. An empty answer from this endpoint is not evidence of anything. Use it for head-block
  cross-checks (§12) and nothing else.

**The rule, and how to read an empty result:**

1. Every `cast logs` carries `--from-block`: the contract's deploy block for genesis/admin events (one row
   per change, cheap), or `$(( $(cast block-number --rpc-url $RH_RPC) - N ))` for operational events.
2. Run it against `$RH_RPC`.
3. An empty result on `$RH_RPC` with a deploy-block bound means **the query is broken** — wrong `--address`,
   a `--from-block` later than the event, a signature that does not match the ABI, or an RPC answering for
   another chain. Prove the shape before you act on it: re-run the same command for an event you KNOW
   fired recently with `--from-block $(( $(cast block-number --rpc-url $RH_RPC) - 500 ))`. Rows there and
   none for your event means the event did not fire in the range you asked; none there either means the
   query shape is wrong. Until you have run the control, "no rows" means neither.

---

## Index — what the keeper emits

| kind | Payload sev | P | Fires when | Runbook |
|---|---|---|---|---|
| `tx_revert` | error | P2 | A keeper tx would revert / failed submission / reverted on chain (`force`). `data.kind` names the tx: `newOptionType`, `rollOpen`, `approveListing`, `cancelListing`, `invalidateAllListings`, `lockBook`, `rollClose`, `retryStrandedClaim`, `settleQueue` | §1 |
| `claim_stranded` | error, `force` | **P1** | `rollClose` (the keeper's or anyone's) emitted `ClaimStranded`: the Valorem redeem reverted and the vault is Idle with the claim kept; deposits, instant redemption and the next `rollOpen` are shut | §2 |
| `fill_sim_revert` | warn | P2 | The keeper's own fill simulation against the live listing started reverting (`data.reason`: `PremiumBelowFloorAtFill`, `StrikeBelowBand`, `OraclePaused`, `StalePrice`, `ValoremFeeNotAccepted`, `WritesAreHalted`, ...). Fires once per reason per listing; a reprice clears it | §3 |
| `phase_stuck` | error | P1 | Past expiry + 1h and the vault is still not `Idle` | §4 |
| `keeper_error` | error | P2 | A tick threw, or an unhandled rejection | §5 |
| `oracle_paused` | warn | P2 | Issuer flipped `oraclePaused()`; arms and fills both refuse | §6 |
| `valorem_fees_enabled` | warn | P2 | Valorem's 15 bps notional fee turned on; the vault has already stopped arming and filling | §7 |
| `low_gas` | warn | P2 | Keeper ETH below `KEEPER_MIN_GAS_WEI` (default 0.01) | §8 |
| `rpc_lag` | warn | P2 | Head block trails the wall clock, or both RPC endpoints are unreachable | §9 |
| `no_rung` | info (**warn** for `stale-oracle`) | INFO/P2 | The week is being skipped; `data.reason` says why: `no-strike-in-band`, `premium-above-strike`, `stale-oracle: …`, `writes-halted`, `no-keeper-role`, `valorem-fees-enabled`, `oracle-paused`, `no-capacity`, `stranded`, and in vol pricing mode `vol-*` (warn; emitted by the keeper as `cycle_not_created`) | §10 |
| `strand_retry_failed` | warn | P2 | `retryStrandedClaim()` still reverts `StillStranded` on the keeper's timer; `data.cause` carries the USDG/NVDA reads it took | §2 |
| `boot` | info (**warn** if no KEEPER_ROLE) | INFO | Process online and reconciled. Warn variant: the key can close but not arm | — |
| `roll_open` | info, `force` | INFO | Cycle armed: strike, window, capacity, price, option id, tx hash in `data`. Nothing written yet | — |
| `v1_drained` | info | INFO | A factory keeper in v1 run-off (`SOLO_WIND_DOWN=1`, registry `v1RunOff`) sees `liveCount() == 0 && pendingCount() == 0`: no account in that market holds a listed week or waits to list, so nothing is left for the keeper to settle. Once per factory (remembered in the keeper's SQLite, so a restart does not repeat it). `data`: `factory`, `liveCount`, `pendingCount`, `weekId`, `block`. The v1 run-off runbook decides when the service is switched off | — |
| `v1_settle_held` | warn | P2 | A factory keeper (run-off or not) did **not** send `settle()` for an expired account with `claimKey() != 0`, because the Valorem redeem inside it would be refused and `settle()` would keep the claim for good (no retry). `data.reason`: `usdg_paused` (USDG `paused()`), `usdg_frozen` / `clear_usdg_frozen` (USDG `isFrozen` of the account / the Clear), `asset_paused` (Stock Token `paused()`), `asset_blocked` / `clear_asset_blocked` (`isBlocked` of the account / the Clear on the token's `ACCESS_CONTROLLED_REGISTRY()`), or `read_failed` (a read did not answer; `data.failedReads` names it: a failed read is never taken as open). Once per account per reason while it holds; the keeper retries every tick and settles on the first tick every gate reads open. `data`: `account`, `reason`, `claimKey`, `listedExpiryTs`, `gates`, `failedReads`, `usdg`, `asset`, `clear`. Do not settle that account by hand while it holds | `ops/runbooks/v1-runoff.md` step 8; `incident.md` §5 |
| `roll_close` | info, `force` | INFO | Week closed: summed gross/fee/net plus `premiumUsdg` / `strikeProceedsUsdg` in `data`; an assigned week's message names premium and strike proceeds separately; a stranded close says so and defers the numbers. Emitted by the keeper's own close AND by the boot reconciliation when someone else closed the week | [payload](#roll_close--info-payload-and-message) |

## Index — conditions this file covers that the keeper does NOT emit

These need an external watcher, a weekly runbook step, or surface inside another kind.

| Condition | How it actually reaches you | Runbook |
|---|---|---|
| Keeper down / heartbeat missed | External uptime monitor on `/health` (503) — **not yet stood up**; Railway does not restart or alert on a 503 | §11 |
| One RPC endpoint down (the other works) | Silent by design (fallback). Both down → `rpc_lag` | §9 |
| Two RPCs disagree | Not monitored; no comparison logic exists | §12 |
| A fill | No alert. `CallsWritten` per fill; `/cycles`, the indexer, and the `roll_close` sums carry it | §13 |
| Feed stale while market is closed | Expected; no alert. A `stale-oracle` warn during the regular session is the broken-feed case | §14 |
| Seaport counter moved under a live listing | Keeper re-reads the counter and relists inside its budget; a deliberate invalidation surfaces as `tx_revert` (`BadCounter`) on the relist | §15 |
| Assignment detected | No alert. Weekly check in `close-week.md` | §16 |
| Book not locked at exercise | No alert. `rollClose` accepts `Listed` and invalidates the listing itself; the hook refuses fills after `cycleExerciseTs` regardless | §17 |
| Redeem reconciliation | No alert. Manual check, `close-week.md` §4; do not publish a number until it balances | §18 |
| Harvest zero / split across events | No separate kind: `roll_close` carries the cycle-summed gross/fee/net | §19 |
| Stock Token transfer fails (issuer freeze) | The failing tx reverts → `tx_revert`; a close that hits it → `claim_stranded`; a factory `settle()` it would strand is held → `v1_settle_held`; deposits fail in the dapp | §20 |
| Writes halted by guardian | Warn log per tick; `no_rung` at window close with `reason: writes-halted`; treat as key compromise until owned | §21 |
| Role or policy changed | No alert. Every legitimate change is a planned Safe transaction; review the Safe queue | §22 |
| Deposits closed (`maxDeposit == 0`) | No alert. One gate, five reasons, `incident.md` §11 | §23 |
| Settled epoch unclaimed 30 days | No alert. Periodic `epochs()` review | §24 |
| Indexer behind head | No alert; the indexer has no webhook. External monitor on its `/v1/health` — **not yet stood up** | §25 |
| Third-party keys: USDG `Pause`/`FreezeAddress`/`SupplyDecreased(vault)`, NVDA `UIMultiplierUpdated` (new < old), `OraclePaused`, Clear `FeeSwitchUpdated`/`FeeToUpdated` and storage slot 3, Chainlink `aggregator()` change | Not emitted by the keeper. The P7-02 external alert set (`projects/callhouse/integrations/INDEX.md` §3) — **not yet stood up**. Filter pause alerts by address or they fire on unrelated 4663 contracts | §26 |
| Keeper gas truly empty (cannot pay for `rollClose`) | No separate kind. `low_gas` at 0.01 is the only gas alert; past expiry + 1h anyone can close | §8 |

---

## Emitted kinds — first three checks

### §1 `tx_revert` — P2 (error)
A keeper transaction would revert, failed submission, or reverted on chain. `data.kind` names the
transaction; the revert reason is in `data.reason` or decodable from `data.hash`. Decode it rather
than guessing (the keeper's hand ABI carries all 92 custom errors, library ones included):

| Error | Meaning |
|---|---|
| `WrongPhase(0, n)` | Last week is not closed |
| `StillStranded()` | A claim is stranded; `rollOpen`, deposits and instant redemption are shut until `retryStrandedClaim` succeeds — §2 |
| `WritesAreHalted()` | Guardian or admin halted — §21 |
| `NotAnOptionType(id)` / `OptionAssetMismatch` / `OptionExerciseAssetMismatch` / `UnexpectedLotSize` | The id the keeper armed is not a `(NVDA, 1e18, USDG, …)` option type on this clearinghouse |
| `ExerciseTooSoon(exerciseTs, earliest)` / `BadCycleWindow(exerciseTs, expiryTs)` | The window: exercise < now + 1 h, window < 1 day, or tenor > 21 days |
| `OptionsTypeExists(id)` (from the Clear) | `newOptionType` for a tuple that already exists; read the id out of the revert and arm it, the type is the same |
| `ValoremFeeNotAccepted(15)` | See §7 |
| `OraclePaused()` / `StalePrice(...)` | See §6 / §14 |
| `StrikeBelowBand` / `StrikeAboveBand` | The chosen strike left the band between read and send |
| `ContractsAboveUtilization` / `ContractsAboveCap` / `ContractsZero` / `OfferExceedsCapacity` | Sizing: the offer exceeds `Policy.maxContracts(totalAssets()) − contractsWritten()` |
| `BadOrderType` / `BadZone` / `BadZoneHash` / `BadConduitKey` / `BadConsiderationLength` / `BadVaultRecipient` / `PremiumNotDivisibleByOrderSize` / `UnitPriceExceedsStrike` / `BadCounter` / `ListingOutlivesExercise` / `ListingStartsInFuture` / `PremiumBelowMinimum` / `PreviousListingLive` / `TooManyListings` | `approveListing`: the order builder or a live predecessor. The order must be `PARTIAL_RESTRICTED` (3), zone == vault, ONE USDG consideration item to the vault |
| `NotYetExpired` / `GuardianTooEarly` | `rollClose` too early; expected |
| `NotStranded()` | `retryStrandedClaim` with nothing stranded; somebody else already cleared it |
| `RedeemOutOfGas()` | A `rollClose`/retry sent with too little gas to tell a real redeem failure from starvation; resend with more gas |

1. `cast run <txhash> --rpc-url $RH_RPC` to decode
2. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC`, `"isStranded()(bool)"` and `"writesHalted()(bool)"`
3. `cast call $CLEAR "tokenType(uint256)(uint8)" <optionId> --rpc-url $RH_RPC` (1 = Option) and `"option(uint256)(...)"`

→ Most of these are the gate working. Fix the input and retry; the listing window is days long. An
order-shape revert means the **builder** is wrong: fix the builder, do not tune the number until it
passes. `open-week.md` §7.

### §2 `claim_stranded` — P1 (error) and `strand_retry_failed` — P2 (warn)
`rollClose` could not redeem the claim (USDG paused; the vault or the Clear frozen on USDG; the
Clear's USDG burnt; the vault blocklisted on NVDA) and the vault is Idle with the claim kept.
Depositors' money is behind an unredeemed claim, deposits and instant redemption are shut, and the
next week cannot be armed.

1. `cast call $VAULT "isStranded()(bool)" --rpc-url $RH_RPC` and `"strandedRemainingWad()(uint256)"`
2. `cast call $USDG "paused()(bool)" --rpc-url $RH_RPC`; `"isFrozen(address)(bool)" $VAULT`; `"isFrozen(address)(bool)" $CLEAR`; `"balanceOf(address)(uint256)" $CLEAR`
3. `cast call $NVDA "transfer(address,uint256)(bool)" $VAULT 1 --from $CLEAR --rpc-url $RH_RPC` (the NVDA-side blocklist)

→ **Anyone can `retryStrandedClaim()`**; the keeper does it on a timer and fires
`strand_retry_failed` while it keeps reverting `StillStranded`. Queuers get their idle slice now
through `settleQueue()` and their claim share at the retry. Publish within the hour (Template E).
`ops/runbooks/incident.md` §9. Nothing else in the system needs to change; the vault has already
refused everything a halt would.

### §3 `fill_sim_revert` — P2 (warn)
The keeper simulates a one-contract fill of the live listing every tick (the same `eth_call` the
cycle page runs before it enables the button) and it started reverting. `data.reason` is the decoded
error, `data.spot` / `data.floor` the numbers.

1. `cast call $VAULT "spotUsdg()(uint256)" --rpc-url $RH_RPC` vs the strike and `listingGrossUsdg()`
2. `cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC` — still validated, not cancelled?
3. `cast call $NVDA "oraclePaused()(bool)" --rpc-url $RH_RPC` and `cast call $CLEAR "feesEnabled()(bool)" --rpc-url $RH_RPC`

→ `PremiumBelowFloorAtFill` is a rally: the keeper reprices inside its relist budget
(`KEEPER_MAX_RELISTS`, under the vault's 3 per cycle). `StrikeBelowBand` cannot be repriced away;
the week is unfillable until spot returns. `OraclePaused` / `ValoremFeeNotAccepted` /
`WritesAreHalted` are §6 / §7 / §21. `ops/runbooks/incident.md` §10.

### §4 `phase_stuck` — P1 (error)
Past `expiry + 1 hour` and the vault is still not `Idle`. Depositors' money is sitting behind an
unredeemed claim (or, on an unsold week, behind an armed cycle nobody closed).

1. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC`
2. `cast call $VAULT "cycleExpiryTs()(uint40)" --rpc-url $RH_RPC` vs `cast block latest -f timestamp`
3. `cast call $NVDA "paused()(bool)" --rpc-url $RH_RPC` — is settlement blocked by the issuer?

→ **Anyone can call `rollClose()` now.** Do it. If the redeem cannot go through, the close still
lands and strands the claim (§2) rather than reverting. The keeper reconciles a close it did not
witness at boot (sums the harvest from logs, fires `roll_close`), so the record self-heals once the
process is back.

### §5 `keeper_error` — P2 (error)
A tick threw, or an unhandled rejection. `data.reason` carries the message. The process is alive
(the alert itself proves it), so:

1. Read the keeper logs around the timestamp; the same line is logged at error level
2. `curl -sS http://<keeper host>:8787/health` — heartbeat, gas, RPC lag, phase
3. If it repeats every minute: the tick body is failing deterministically; the hourly dedupe means
   the webhook shows it once; the logs have every instance

→ The weekly cadence is protected by the permissionless paths (`lockBook`, `rollClose` at
expiry + 1h, `settleQueue`, `retryStrandedClaim`) even if the keeper never recovers. A reboot is
safe at any point: boot reconciles from chain, including closing out a cycle someone else closed.

### §6 `oracle_paused` — P2 (warn)
`NVDA.oraclePaused()` returned true. `rollOpen` and every fill revert `OraclePaused()`.

1. `cast call $NVDA "oraclePaused()(bool)" --rpc-url $RH_RPC`
2. `cast call $NVDA "paused()(bool)" --rpc-url $RH_RPC` — is this the milder flag or a full freeze?
3. `cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC` — is Chainlink still publishing?

→ An issuer broadcast flag; Chainlink keeps publishing regardless. The vault holds spot and sells
nothing. Skipped week, not a freeze. If `paused()` is also true, escalate to
`ops/runbooks/incident.md` §5.

### §7 `valorem_fees_enabled` — P2 (warn)
`clear.feesEnabled()` flipped to true. 15 bps of **notional**, no timelock, and `setFeeTo` emits no
event (watch storage slot 3 of the Clear).

1. `cast call $CLEAR "feesEnabled()(bool)" --rpc-url $RH_RPC`
2. `cast call $CLEAR "feeBps()(uint8)" --rpc-url $RH_RPC` and `"feeTo()(address)"`
3. `cast call $VAULT "valoremFeeAccepted()(bool)" --rpc-url $RH_RPC`

→ The vault has already stopped arming and filling (`ValoremFeeNotAccepted`); that is why this is a
warn, not a page: nothing is at risk, the week is simply skipped until governance acts. Resuming
needs an explicit Admin Safe decision, and the arithmetic first: at a 0.40% premium floor, a 0.15%
notional fee is ~37% of the floor, and the hook adds the fee (valued at spot) to the fill floor.
`ops/runbooks/incident.md` §6.

### §8 `low_gas` — P2 (warn)
Keeper balance below `KEEPER_MIN_GAS_WEI` (default 0.01 ETH; the message reads ETH, `data` carries
raw wei). There is no separate "gas empty" alert; this one is the whole ladder.

1. `cast balance <keeper> --rpc-url $RH_RPC`
2. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC`
3. `cast call $VAULT "cycleExpiryTs()(uint40)" --rpc-url $RH_RPC` — how long until settlement is due?

→ Top up to ~0.05 ETH. Refilling is a step in `close-week.md`; if this alert fires, that step was
skipped. If the balance ever reaches zero mid-cycle, §4's permissionless close still applies.

### §9 `rpc_lag` — P2 (warn)
Two variants: the head block trails the wall clock by more than `KEEPER_RPC_LAG_ALERT_MS`
(default 5 min), or **both** RPC endpoints are unreachable (the tick cannot even snapshot).

1. `cast block-number --rpc-url $RH_RPC`
2. `cast block-number --rpc-url $RH_RPC_2`
3. `curl -sS -H 'Referer: https://robinhoodchain.blockscout.com/' https://robinhoodchain.blockscout.com/api/v2/stats`

→ One endpoint down alone is silent by design; reads and sends fail over. Both down: the keeper
cannot transact; `/health` shows `degraded` while ticks still attempt, then `wedged` if they stop
completing. **The indexer cannot use the backup** (it rejects `eth_getLogs` over old ranges), so
history goes stale and the site should say so. `ops/runbooks/incident.md` §8.

### §10 `no_rung` — INFO, or P2 (warn) for `stale-oracle`
The week is being skipped; `data.reason` says why:

- `no-strike-in-band` / `premium-above-strike` — routine. No whole-dollar strike sits inside
  `[spot × 1.03, spot × 1.12]`, or the floor premium would exceed the strike. Publish `no eligible
  strike, unfilled, 0`.
- `stale-oracle: …` — **warn, while the window is still open.** If the US market is shut this is
  expected (the `us_equities_24/5` feed stops; measured gaps: 21 h intra-week, 52 h weekend, 78 h
  three-day; `maxPriceAge` is days for this reason). If the market is open, the feed is genuinely
  broken, or the chain is stalled: chain 4663 has no Chainlink sequencer-uptime feed, so a
  sequencer stall surfaces here, late. `ops/runbooks/incident.md` §7.
- `writes-halted` — see §21. `no-keeper-role` — the boot warn told you already. `no-capacity` —
  `Policy.maxContracts(totalAssets())` is 0 (everything queued, or the vault is empty). `stranded` —
  §2; the keeper will not arm over a stranded claim.
- `vol-unavailable`, `vol-stale`, `vol-inconsistent`, `vol-no-expiry`, `vol-no-quotes`,
  `vol-spot-divergence`, `vol-delta-out-of-range`, `vol-strike-unquoted` — **warn** (the keeper
  emits these as `cycle_not_created`, once per reason per week). `KEEPER_PRICING_MODE=vol` (the
  default) could not price the week from Cboe's delayed chain and will not arm on a guess.
  `data.error` / `data.why` say what failed (`keeper/README.md` → Market data). A dark or stuck
  feed on a weekend is usually temporary: the keeper retries on its own, at most one download every
  five minutes. If it persists into the week, or `vol-inconsistent` names a changed feed format,
  set `KEEPER_PRICING_MODE=fixed` (strike `spot + KEEPER_STRIKE_OTM_BPS`, ask floor plus margin)
  and restart.
- At window close unarmed, a forced `no_rung` records the skipped week whatever the reason.

### `roll_close` — INFO: payload and message
No action; it feeds the weekly publish. On an assigned week the vault's `Harvest.grossUsdg`
includes the strike proceeds (`RollClose.usdgFromAssignment`), which are returned principal and
carry no fee. Publishing the gross as "harvested" would show principal as yield, so the keeper
splits it: premium = gross − strike proceeds. There is no venue fee any more: premium is what the
buyers paid.

Message, by outcome (`<n>` the cycle, amounts in USDG to at most 6 decimals, trailing zeros dropped):

| Outcome | Message |
|---|---|
| Unsold (`claimKey == 0`, nothing redeemed) | `cycle <n> closed unfilled: 0 USDG harvested.` |
| Sold, nothing assigned | `cycle <n> closed: <gross> USDG harvested, <net> to depositors.` |
| Sold, assigned | `cycle <n> closed: premium <premium> USDG (fee <fee>), strike proceeds <proceeds> USDG from <k> contracts assigned; <net> USDG to depositors.` |
| Stranded | `cycle <n> closed with the claim STRANDED (gen <g>): redeem deferred, deposits and instant redemption shut, anyone can retryStrandedClaim().` followed by a `claim_stranded` alert |
| Assigned, proceeds unknown (no `RollClose` in the receipt; unreachable with the deployed vault) | `cycle <n> closed: <gross> USDG gross including strike proceeds from <k> contracts assigned (premium/proceeds split unknown), <net> to depositors.` |

A close reconstructed at boot (someone else closed the week) appends ` The close ran without this
keeper witnessing it; reconstructed from chain logs.` to any of the five.

`data`:

| Field | Meaning |
|---|---|
| `cycleNumber` | The vault cycle |
| `grossUsdg` / `feeUsdg` / `netUsdg` | Every `Harvest` for the cycle, summed (§19). Gross includes strike proceeds. After a strand, the retry's `Harvest` carries this cycle's number and is folded in when it lands |
| `premiumUsdg` | `grossUsdg − strikeProceedsUsdg`. `null` when the proceeds are unknown |
| `strikeProceedsUsdg` | `RollClose.usdgFromAssignment`; `"0"` when nothing was assigned, `null` when unknown or stranded |
| `assetsReturned` | `RollClose.assetsReturned`, underlying base units (wei) as a string; `null` when unknown or stranded |
| `contractsWritten` | `== sold`; the sum of the cycle's `CallsWritten.contractsCount` |
| `contractsAssigned` | `RollClose.contractsAssignedCount` |
| `contractsAssignedSource` / `contractsAssignedFromClaim` | Keeper's own close only: where the count came from (`RollClose` \| `claim-preread` \| `unknown`) and its pre-close Valorem read |
| `stranded` / `strandGen` | `true` and the generation when the close stranded |
| `tx` | The `rollClose` transaction |
| `witnessedLive` | Boot reconciliation only: `false` |

The same split is on the keeper's `GET /cycles`: `assets_returned`, `usdg_from_assignment`,
`premium_gross_usdg6`, `strike_proceeds_usdg6` (the derived pair is `null` for a week closed
before the keeper recorded them). Check before publishing: `fee == floor(premium × protocolFeeBps / 10000)`
for a single-`Harvest` week; when a deposit checkpoint split the harvest, the fee is a sum of
per-event floors and may sit a few base units under that.

---

## Not emitted by the keeper — checks and external monitors

### §11 Keeper down / heartbeat missed — external monitor (not yet stood up)
No `/health` beat and no tick in progress for three poll intervals (default 3 minutes) → 503
`wedged`. The process is down, wedged, or the host is gone. **Railway will not notice**: its
healthcheck runs at deploy start only and `On Failure` restarts only a crashed process. Stand up an
in-project checker (a small cron service or the relay itself GETting
`http://keeper.railway.internal:8787/health` and posting to the relay on non-200) or an external
checker on a restricted public route before the first live week.

1. `curl -sS http://<keeper host>:8787/health`
2. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC` — is there a live position to babysit?
3. `cast call $VAULT "isStranded()(bool)" --rpc-url $RH_RPC` — is a retry timer being missed?

→ `ops/runbooks/incident.md` §4. Nothing is at risk: fills price themselves, `lockBook` is
permissionless, `rollClose` opens to anyone at expiry + 1h, `retryStrandedClaim` and `settleQueue`
to anyone at any time. Restarting a keeper mid-transaction is safe (boot reconciles, and a tx that
landed unwatched has its bookkeeping replayed from logs), but check `/health` first: a slow close
holds a tick open and is **not** wedged.

### §12 RPC disagreement — not monitored
The two RPCs returning different state at the same block. Recon confirmed they agree byte-for-byte
on feed round data, so a disagreement is real, but no comparison logic exists in the keeper; this
is a manual check when something smells wrong.

1. Re-run the differing call against both with an explicit `--block <n>`
2. `cast block-number` on both — is one simply behind?
3. Third opinion: `https://stonkscan.io/address/<addr>` or Blockscout through `ops/bsproxy.js`

→ Do not send a transaction until they agree. Halt writes if an arm is pending.

### §13 Fills — no alert by design
1. `cast call $VAULT "contractsWritten()(uint112)" --rpc-url $RH_RPC` (== sold)
2. `cast logs --address $VAULT $(cast keccak "CallsWritten(uint256,uint256,uint112,uint256)") --from-block <rollOpen block> --rpc-url $RH_RPC` — one per fill; sum `contractsCount`
3. `cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC` — the fill fraction

→ Record for the publish. A partial fill leaves the remainder live at the same unit price. Do not
relist cheaper to clear it. (A relist is a reprice to the live floor, never below it.)

### §14 Stale feed, market closed vs market open — see §10
The `stale-oracle` warn fires regardless of market hours; interpreting it needs the clock.
`RHNVDA / USD` is a `us_equities_24/5` feed: it stops when the market closes and restarts at
00:00:54 UTC Monday. It is also why the keeper should arm during the regular session (09:30–16:00
ET, Mon–Thu): a passing gate is not the same as a useful price. `open-week.md` §2b.

### §15 Seaport counter moved — self-healing, surfaces only if deliberate
`seaport.getCounter(vault)` changed while a listing was live. Everything from this offerer is
dead; the keeper re-reads the counter live and rebuilds within the relist budget.

1. `cast call $SEAPORT "getCounter(address)(uint256)" $VAULT --rpc-url $RH_RPC`
2. `cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC`
3. `cast logs --address $VAULT $(cast keccak "AllListingsInvalidated(uint256)") --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC` — who bumped it?

→ If it was `lockBook` or `rollClose`, this is expected. If nobody bumped it deliberately,
escalate. Seaport 1.2+ bumps by a quasi-random amount, so the keeper always re-reads.

### §16 Assignment — weekly check
An `OptionsExercised` on our option type touched our claim.

1. `cast call $VAULT "contractsAssigned()(uint256)" --rpc-url $RH_RPC` — **before** `rollClose`; it returns 0 after
2. `cast call $CLEAR "claim(uint256)((uint256,uint256,uint256))" $(cast call $VAULT "claimKey()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1) --rpc-url $RH_RPC`
3. `cast call $VAULT "contractsWritten()(uint112)" --rpc-url $RH_RPC`

→ Normal. Valorem assigns pro rata across every writer of the id (all pre-exercise writes share
bucket 0), bounded to what the vault sold, so `0..N` of our contracts can be taken.
`amountWritten`/`amountExercised` are **1e18-scaled scalars**; divide before believing them.
Escalate only if `assigned > written`, which write on fill makes impossible. `ops/runbooks/incident.md` §3.

### §17 Book not locked — untidy, not dangerous
Past `cycleExerciseTs` and `phase()` is still `1`. `lockBook()` is permissionless; anyone can call
it. `rollClose` accepts `Listed` too and invalidates any surviving listing itself, and the hook
refuses any fill after the exercise timestamp (`WriteWindowClosed`) regardless.

### §18 Redeem reconciliation — manual, before publishing
`underlyingReturned + assigned × strike` does not match what was written.

1. The vault's `ClaimRedeemed(claimKey, underlyingReturned, exerciseReceived)` from the close tx
2. The pre-close snapshot from `close-week.md` §1
3. `cast call $CLEAR "position(uint256)((address,int256,address,int256))" <claimKey> --rpc-url $RH_RPC`

→ **Do not publish a number.** Partial assignment is normal; an unreconcilable redeem is not.
Escalate to engineering. `RollClose.contractsAssignedCount` is a real number (the vault reads
`contractsAssigned()` before the redeem zeroes `claimKey`) and is usable as evidence, but it is the
*same* read as the pre-close snapshot, so it agreeing with the snapshot proves nothing. The
independent number is `contractsWritten - underlyingReturned / 1e18` off the vault's
`ClaimRedeemed`; that is the one that has to agree. `close-week.md` §4.

### §19 Harvest accounting — why every number is a sum
`deposit`/`mint` run `_checkpointHarvest()`, so a fill followed by a deposit puts the premium on
an earlier `Harvest` and leaves the close's own event at `(0, 0, 0)`. Reading only the close's
event reports a filled week as unfilled. The keeper sums every `Harvest` carrying the cycle number
from the rollOpen block (recovered from the tx row or the `RollOpen` log) through the close block,
and, after a strand, through the retry; the indexer folds the same way; the web history reads the
indexer's sum. The fee still leaves the vault exactly once, from `rollClose` (or `sweepFee` if the
push was deferred). On an assigned week the close's gross also carries the strike proceeds
(`RollClose.usdgFromAssignment`, fee-free): premium is gross minus that, and the keeper records both
(`roll_close` payload above, `GET /cycles`). `close-week.md` §5.

1. `cast logs --address $VAULT $(cast keccak "Harvest(uint32,uint256,uint256,uint256)") $(cast to-uint256 <cycle>) --from-block <rollOpen block> --rpc-url $RH_RPC`
2. `cast call $VAULT "pendingFeeUsdg()(uint256)" --rpc-url $RH_RPC` — 0 after close unless the push was deferred (then `sweepFee()`)
3. `cast logs --address $VAULT $(cast keccak "UsdgDistributed(uint256,uint256,uint256)") --from-block <rollOpen block> --rpc-url $RH_RPC`

### §20 Stock Token transfer fails — issuer freeze, surfaces as `tx_revert` or `claim_stranded`
1. `cast call $NVDA "paused()(bool)" --rpc-url $RH_RPC`
2. `cast call $NVDA "transfer(address,uint256)(bool)" <any address> 1 --from $VAULT --rpc-url $RH_RPC`
3. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC` and `"isStranded()(bool)"` — is a claim outstanding or already stranded?

→ Issuer freeze. Halt writes, publish within the hour, state precisely what still works (USDG
claims, queueing, `settleQueue`) and what does not (anything moving NVDA). A close that hits it
strands the claim rather than reverting (§2). There is no technical response.
`ops/runbooks/incident.md` §5.

### §21 Writes halted — treat as key compromise until owned
The `WritesHalted(bool)` event fired. The keeper logs a warn per tick and, at window close, fires
`no_rung` with `reason: writes-halted`, days after the fact. The runbook check is the early
warning. A halt also refuses every fill (`fill_sim_revert` with `WritesAreHalted` while a listing
is live).

1. `cast call $VAULT "writesHalted()(bool)" --rpc-url $RH_RPC`
2. `cast logs --address $VAULT $(cast keccak "WritesHalted(bool)") --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC` — who, and when?
3. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC`

→ If a human did it deliberately, acknowledge and move on. If nobody owns it, treat as a key
compromise until proven otherwise. Only the Admin Safe can unhalt.

### §22 Role or policy changed — Safe review is the control
No keeper alert exists for `RoleGranted`/`RoleRevoked`/`PolicyUpdated`/`MaxPriceAgeUpdated`/
`FeeRecipientUpdated`/`DepositCapUpdated`/`ValoremFeeAccepted`. Every legitimate change is a
planned Safe transaction (or, before the handover, a deployer-key transaction); review the Safe
queue and transaction history. An unplanned `RoleGranted` is the most serious event in this file.

1. `cast logs --address $VAULT $(cast keccak "RoleGranted(bytes32,address,address)") --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC`
2. `cast call $VAULT "hasRole(bytes32,address)(bool)" 0x0000000000000000000000000000000000000000000000000000000000000000 <each admin> --rpc-url $RH_RPC`
3. `cast call $VAULT "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url $RH_RPC`

→ Confirm it was intended and that the keeper picked up the new bounds on its next poll.

### §23 Deposits closed — one gate, five reasons
`maxDeposit(address)` returned 0 and `deposit` reverts `DepositsClosed()`. Halted, stranded, Listed
past `cycleExerciseTs`, at the cap (launch: 20 NVDA), or the reserve is unbacked after an issuer
burn. `ops/runbooks/incident.md` §11 reads them in order. Only the last two are news.

### §24 Settled epoch unclaimed — periodic review
A settled epoch still holds balances a month later.

1. `cast call $VAULT "epochs(uint256)(uint256,uint256,uint256)" <epochId> --rpc-url $RH_RPC`
2. `cast call $VAULT "reservedAssets()(uint256)" --rpc-url $RH_RPC` and `"usdgReservedForQueue()(uint256)"`
3. Identify the holders from the `QueueRedeem` logs for that epoch

→ Nothing is stuck: `completeRedeem` works forever and the reserves are excluded from NAV so
nobody else's share price is inflated. Reach out to the depositor.

### §25 Indexer lag — external monitor (not yet stood up)
Ponder is behind head. The indexer has no webhook; point an uptime check at `/v1/health`, which
reports `lag.blocks` / `lag.seconds` and turns `degraded` when behind. Railway's own healthcheck
uses `/ready` (ready only after historical sync), which is right for deploys and wrong for lag
monitoring.

1. `cast block-number --rpc-url $RH_RPC` vs the indexer's last processed block
2. Is the indexer pointed at the primary RPC? The publicnode backup rejects historical `eth_getLogs`
3. Indexer process logs

→ Chain state is unaffected. The web app's history is stale and should say so rather than serve
stale numbers as current.

### §26 Third-party keys — external alert set (not yet stood up)
None of these reach the keeper. Each is a one-line log filter against the primary RPC, filtered by
**address** (a bare `Paused` topic fires on unrelated 4663 contracts):

| Watch | Why |
|---|---|
| USDG `Pause()`, `FreezeAddress(vault \| clear \| seaport)`, `FrozenAddressWiped`, `SupplyDecreased(vault)`, `FacetUpdate` | any of the first three strands the next close (§2); a wipe or burn changes NAV |
| NVDA `UIMultiplierUpdated` with `new < old`, `OraclePaused`, `Paused`, `Blocked(vault)`, proxy `Upgraded` | multiplier can decrease and apply immediately; a blocklist strands an unassigned week's close |
| Clear `FeeSwitchUpdated`, `FeeToUpdated`, `TokenURIGeneratorUpdated`, and Clear **storage slot 3** (eventless `feeTo` nomination); ETH/nonce activity at Overcall's `feeTo` `0xdAe7…0782` when the vault targets Overcall's Clear | §7 before it fires |
| Chainlink proxy `aggregator()` / `accessController()` change; the feed's Safe nonce | the vault is bound to the proxy, not the aggregator |
| L2 head liveness (block timestamp vs wall clock) | no sequencer-uptime feed on 4663 (§9) |

---

## Routing

| Payload severity | Channel | Who |
|---|---|---|
| `error` | webhook, unmuted | Whoever is on the weekly rota; guardian if §2, §4 or §20 |
| `warn` | webhook | Whoever is on the weekly rota, within the hour |
| `info` | webhook, log only | Nobody. Several feed the weekly publish |

Test the webhook every week as part of `close-week.md`: with the relay, a failed delivery is
retried after five minutes and then suppressed for the hour; a silently broken relay looks
exactly like a quiet week. An alert channel nobody has seen fire is not an alert channel.

---

# v2

Everything above is v1: the closed pooled vault and the v1 factory keeper, which stays up in run-off
(`SOLO_WIND_DOWN=1`, `ops/runbooks/v1-runoff.md`) until its last account settles. Everything below is
v2: the bots in `keeper/src/v2/` (`V2_MODE=cranker|mm|pricer|pricing`), the services that send no
alert at all (pricing, notifier, indexer-v2, relay), and the external monitor `ops/v2/monitor.mjs`
that watches what none of them emits. Response runbooks: `ops/runbooks/incident-v2.md` (§1 oracle
dispute, §2 paused settlement, §3 payout conversion failing, §4 bot key compromise, §5 admin key
compromise with §5a pre-pins and the pin wiring and §5b a scheduled fee change, §6 issuer freeze of a
contract address).

## §V0 Where v2 alerts come from

| `source` | Process | Kinds | Code |
|---|---|---|---|
| `callhouse-cranker` | `cranker` (`V2_MODE=cranker`) | `v2_*`: the five common kinds + the six cranker kinds | `keeper/src/v2/alerts.ts` `ALERT_SEVERITY`, `keeper/src/v2/runtime.ts`, `keeper/src/v2/cranker/planner.ts`, `steps.ts` |
| `callhouse-mm` | `mm-bot` (`V2_MODE=mm`) | `v2_*`: the five common kinds + the ten `v2_mm_*` kinds | `keeper/src/v2/alerts.ts` `ALERT_SEVERITY`, `keeper/src/v2/runtime.ts`, `keeper/src/v2/mm/quoter.ts` |
| `callhouse-pricer` | `pricer` (`V2_MODE=pricer`) | `v2_*`: the five common kinds + the three `v2_pricer_*` kinds | `keeper/src/v2/alerts.ts` `ALERT_SEVERITY`, `keeper/src/v2/runtime.ts`, `keeper/src/v2/pricer/pricer.ts` |
| `callhouse-monitor` | the monitor (a cron job or an always-on service, §V17) | `v2_mon_*` | `ops/v2/monitor.mjs` `KINDS` |
| `callhouse-keeper` | the v1 factory keeper in run-off | v1 kinds (§V16) | `keeper/src/alerts.ts` |

The payload is the v1 shape without `vault` (the relay accepts it absent or null):

```json
{
  "source": "callhouse-monitor",
  "kind": "v2_mon_settlement_late",
  "severity": "error",
  "message": "NVDA expiry 2026-09-18T20:00:00Z is not finalized 2.0 h after expiry and has no candidate: …",
  "chainId": 4663,
  "at": "2026-09-18T22:01:02.000Z",
  "data": { "key": "0xd060…9eec:1789761600", "reason": "new", "runbook": "ops/alerts.md §V20; ops/runbooks/incident-v2.md §2", "ticker": "NVDA", "expiry": 1789761600, "status": "None", … }
}
```

**Delivery and dedupe.**
- **Bots** (`keeper/src/v2/alerts.ts`): one delivery per `kind:dedupeKey` per
  `KEEPER_ALERT_COOLDOWN_MS` (1 h); a failed POST is retried after 5 min; `force` for state changes
  (`v2_boot`, `v2_mm_killed`, `v2_mm_resumed`, `v2_mm_loss_stop`, `v2_mm_outflow_foreign`). The cranker's event kinds
  (`v2_sources_disagree`, `v2_snapshot_missed`) and the MM bot's loss stop (once per UTC day) page
  **once ever** per key, remembered in the bot's SQLite `v2_meta`, so a restart does not page again. A
  condition kind that clears (`v2_mm_not_quoter`, `v2_mm_delta`, `v2_mm_pricing`, `v2_pricer_no_role`,
  `v2_pricer_fair_unavailable`, `v2_pricer_reprice_failed`, `v2_stale_cancel_failed`) resets its cooldown, so it pages again at
  once if it comes back.
- **Monitor** (state file, §V17): a condition pages once when it opens, again when its severity rises
  (`data.reason: "escalated"`, message prefixed `escalated:`) and every 6 h while it stays open
  (`reminder`, `still open:`), and once more as `v2_mon_resolved` (info) when the check that found it
  completes without finding it. A check that failed never resolves anything. An event (a round jump, an
  admin action, a missed snapshot, an aggregator switch) pages once and is remembered for 30 days. An
  undelivered alert is retried on the next run.
- The relay forwards every kind (it validates the shape, not the vocabulary). Severity routing is the
  v1 table ("Routing" above): `error` unmuted, `warn` within the hour, `info` log only.

**The overlap is deliberate.** The cranker and the monitor both watch settlement (held, disagreeing,
snapshot missed, backlog) with different kinds (`v2_settlement_held` / `v2_mon_settlement_held`). The
cranker sees it first and in detail; the monitor sees it when the cranker is dead, wedged or wrong. Two
alerts for one held expiry is the system working.

## §V18 Shell prelude

`ops/runbooks/incident-v2.md` "Shell setup" exports `RH_RPC`, `USDG`, `CH`, `BOOK`, `ORACLE`, `CAL`,
`REWARDS`, `ROLLER`, `ADAPTER`, `VAULT`, `DIST`, `CL_SRC`, `UNI_SRC`, the bot addresses, `ASSET`,
`FEED`, `POOL` for a ticker `T`, the role hashes, the settlement reads, and `probe`. Every "first three
checks" below assumes it. Before anything else, the whole picture in one command (reads only, sends
nothing, leaves the state file alone):

```bash
node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts
```

**`probe` is how a `*.railway.internal` endpoint is read.** Those names resolve only inside the Railway
private network, so nothing on your laptop reaches them, and no image installs `curl` or `wget`: `keeper`
and `indexer` are `bookworm-slim` (neither), `relay`, `notifier` and `web` are alpine (busybox `wget`
only). `node` is in every image, so the request is made from inside a container and printed as
`<status> <body>` (`ops/deploy.md` §15.7 step 9, §15.11 item 10):

```bash
probe() { railway ssh --service "$1" -- node -e "fetch('$2').then(async r=>console.log(r.status,(await r.text()).slice(0,4000))).catch(e=>console.log('ERR',e.message))"; }
probe cranker http://cranker.railway.internal:8792/health | head -c 400
```

The first argument is the service to run it in — usually the one being read, but any running service in
the same environment reaches the same private network. `ERR` with the target's own `/health` green means
the service name, the port, or two services in different environments.

`--no-alerts` writes no cursor, so this run scans from `v2.deployBlock` to the head every time (minutes
once the deploy is old) rather than the per-run window a stateful run uses. `--threshold
maxRangesPerRun=200` caps it, at the price of seeing nothing created past block `deployBlock + 2,000,000`.

## Index — v2 bot kinds

| kind | source | severity | P | Fires when | § | Runbook |
|---|---|---|---|---|---|---|
| `v2_boot` | any bot | info, `force` | INFO | the mode passed its wiring checks and started (`data.signer`, `chainId`) | §V1 | — |
| `v2_error` | any bot | error | P2 | a tick threw, or a cranker step failed (`data.step`: snapshot, finalize, settle, prune, redeem, ladders, rolls, housekeeping, scan) | §V2 | §2 |
| `v2_tx_revert` | any bot | error | P2 | a sent transaction reverted on chain, was not confirmed in time, or could not be broadcast (`data.kind`, `key`, `status`, `hash` when sent) | §V3 | §4 |
| `v2_low_gas` | any bot | warn | P2 | the signer holds less than `KEEPER_MIN_GAS_WEI` (0.01 ETH) | §V4 | §2 |
| `v2_rpc_lag` | any bot | warn | P2 | the head trails the wall clock by more than `KEEPER_RPC_LAG_ALERT_MS` (5 min), or no RPC answered the tick's probe (`data.reason`) | §V5 | `incident.md` §7 |
| `v2_sources_disagree` | cranker | warn, once per candidate | P2 | a Pending candidate has `disagreed = true`; it finalizes at `finalizableAt` unless vetoed | §V6 | §1 |
| `v2_settlement_held` | cranker | error | **P1** | an expiry with supply is Held (vetoed) | §V7 | §1 |
| `v2_snapshot_missed` | cranker | warn, once per expiry | P2 | an expiry with open interest passed `[E, E + 600]` without the cranker's snapshot while a source still needed it | §V8 | §1 |
| `v2_settle_stuck` | cranker | error | **P1** | no source ok for `CRANKER_NO_SOURCE_ALERT_S` (1 h) after finalize opens; a candidate `CRANKER_PENDING_STUCK_S` (30 min) past `finalizableAt` still Pending; or `settle` does not advance / reverts on a final expiry | §V9 | §2 |
| `v2_redeem_backlog` | cranker | warn | P2 | redeemable holders (or holders nobody indexed) of a settled token remain `CRANKER_REDEEM_BACKLOG_S` (1 h) after the cranker saw it settled | §V10 | — |
| `v2_pin_refused` | cranker | error, per oracle and cause (a roll: per underlying and cause) | P2 (**P1** when it blocks the next expiry of a live market) | `createSeries` (a ladder rung or an `AutoRoller.roll`) is refused by the settlement pin: `PinMismatch`, `SourceNotPinned(source, reason)`, or the oracle's `NotAuthorized` / `NoSource` (`data.error`, `source`, `reasonName`, `expiries`). The expiry is skipped and asked again every 15 min | §V10a | — |
| `v2_mm_killed` | mm | error, `force` | P2 (**P1** if nobody on the rota sent it) | `POST /kill` with the right token: the stored kill switch is on, every vault order is being cancelled, nothing quotes until `POST /resume` (`data.reason`) | §V11a | §4c |
| `v2_mm_resumed` | mm | info, `force` | INFO | `POST /resume`: quoting resumes at the next tick | §V11a | — |
| `v2_mm_loss_stop` | mm | error, `force`, once per UTC day | **P1** | the day's realised loss reached `MM_DAILY_LOSS_LIMIT_USDG6` (`data.realised`, `limit`, `day`): every quote pulled until the next UTC day | §V11b | §4c |
| `v2_mm_delta` | mm | warn, per ticker | P2 | a market's net inventory delta is above `MM_DELTA_ALERT_SHARES` (50) shares (`data.ticker`, `deltaShares`): hedge by hand | §V11c | — |
| `v2_mm_not_quoter` | mm | error | **P1** | the MM signer holds neither `QUOTER_ROLE` nor admin on `MakerVault`: nothing is quoted or cancelled (`data.signer`) | §V11d | §4c, §5 |
| `v2_mm_pricing` | mm | warn | P2 | every selected series is halted for its fair value (`data.halts`: `fair-unavailable` from an unreachable service or a refusal, `fair-stale`), or no `/fair` request was answered (`data.reasons`): nothing is quoted | §V11e | — |
| `v2_mm_tx_rejected` | mm | warn, per call | P2 | a vault call's simulation reverted (`data.revert`: a guard, `StaleSpot`, a paused book): not sent | §V11f | — |
| `v2_mm_funds` | mm | warn, per ticker | P2 | quoted series left one-sided: no USDG for bids or no ledger collateral for write asks (`data.ticker`, `series`, `usdgWallet`) | §V11g | — |
| `v2_mm_outflow` | mm | warn, once per UTC day | P2 | the `MakerVault`'s daily outflow cap is binding (INTERFACE_VERSION 7): the bot trimmed its bids inside the remaining allowance, or a call was refused `OutflowCapExceeded` and no further bid grows this tick (`data.cap`, `used`, `budget`, `seriesTrimmed`, `refused`) | §V11k | §4c |
| `v2_mm_outflow_foreign` | mm | error, `force` | **P1** | the vault's outflow bucket is above what this bot's own booked calls account for: USDG left through a quoter or admin call this bot did not send (`data.over`, `used`, `cap`, `vault`) | §V11l | §4c, §5 |
| `v2_house_roll_overdue` | cranker | error, per vault | P2 (**P1** on a launch-set vault past a second boundary) | a House vault's `epochEnd` passed more than 7 h ago (`HOUSE_ROLL_OVERDUE_S`: the oracle's 6 h uncorroborated delay + 1 h) and `rollEpoch` has not run: `data.decision` says why the cranker did not send it — `not-finalized` (the boundary oracle price is not Finalized) or `not-flat` (`data.detail` names the unsettled/held series). Deposits and withdrawals queued for that boundary are unpriced until it rolls. Cleared when the vault is no longer due. | §V19 | below |
| `v2_stale_cancel_failed` | cranker | error, per writer and market (**warn** when the writer revoked the roller) | P2 | an `AutoRoller` ask the spot has overtaken cannot be withdrawn: `cancelStale`'s simulation is refused (`data.revert`, `spot`, `strike`, `orderId`), so the ask rests below intrinsic value until it fills or expires | §V10b | — |
| `v2_cranker_no_buyback_role` | cranker | error | P2 (**P1** if nobody revoked it on purpose) | the cranker's key does not hold `BUYBACK` on the `FeeSplitter`: fees are still claimed and distributed, but no buyback is sent and the reserve grows (`data.signer`, `splitter`) | §V10c | §4b, §5 |
| `v2_pricer_no_role` | pricer | error | P2 (**P1** if nobody revoked it on purpose) | the pricer's key does not hold `PRICER_ROLE` on the `AutoRoller`: no smart-pricing ask is repriced (`data.signer`, `autoRoller`) | §V11h | §4b, §5 |
| `v2_pricer_fair_unavailable` | pricer | warn, per writer and market | P2 | a live, due smart-pricing ask has had no fair value for `PRICER_FAIR_ALERT_S` (2 h): the pricing service is down or answers `fair: null` (`data.reason`, `since`) | §V11i | — |
| `v2_pricer_reprice_failed` | pricer | error (reverted on chain or not confirmed) / warn (simulation refused, send failed), per writer and market | P2 | a due `AutoRoller.reprice` did not go through (`data.status`, `orderId`, `price`, `hash`); `NotAuthorized` is a lost role | §V11j | §4b |

## Index — v2 services that send no alert

| Service | What fails silently | How it reaches you | § |
|---|---|---|---|
| `pricing` | a ticker's Cboe chain unavailable or stale; `/fair` answering `null` | monitor `--health pricing=…/health` → `v2_mon_service_degraded` (`status: degraded`) or `v2_mon_service_down` | §V12 |
| `notifier` | database down, a delivery channel's breaker open, the rules engine failing | monitor `--health notifier=…/health` → `v2_mon_service_degraded` / `down` | §V13 |
| `relay` | a wrong token, a deleted Discord webhook, a removed Telegram bot: **every** alert | monitor `--health relay=…/health` (down only), the monitor's exit 4 on a refused POST, the weekly test | §V14 |
| `indexer-v2` | Ponder behind head, or no indexed head | monitor `--health indexer-v2=…/v2/health` → `lagging` / 503 | §V15 |
| any bot | the process down or wedged (503) | monitor `--health cranker=…/health` etc. → `v2_mon_service_down` | §V2, §V36 |

## Index — the external monitor (`v2_mon_*`)

| kind | severity | event? | Fires when | § | Runbook |
|---|---|---|---|---|---|
| `v2_mon_settlement_late` | error / warn | | open interest, not finalized 2 h after expiry: **error** with no candidate or 15 min past `finalizableAt`; **warn** on a two-source market waiting an uncorroborated delay. A single-source market inside its delay does not page | §V20 | incident-v2 §2, §1 |
| `v2_mon_sources_disagree` | warn | | Pending with `disagreed = true` | §V21 | §1 |
| `v2_mon_settlement_held` | error | | Held | §V22 | §1, §2 |
| `v2_mon_series_unsettled` | error | | the oracle finalized the expiry, open interest is left and some of its Clearinghouse series are still unsettled 1 h later | §V20a | §2 |
| `v2_mon_snapshot_missed` | warn | yes | the pool is a source of the expiry, the grace passed, `snapshots(underlying, E).recordedAt == 0` | §V23 | §2 |
| `v2_mon_redeem_backlog` | warn | | 6 h after settlement: redeemable holders left, or the book still escrows longs | §V24 | §2 |
| `v2_mon_rewards_budget_low` | warn | | KeeperRewards' USDG covers fewer than 20 expiries of bounties | §V25 | — |
| `v2_mon_rewards_cap` | warn | | `dailyCap()` is 0 with bounties set, or `spentToday() >= dailyCap()` | §V25 | — |
| `v2_mon_vault_limit` | warn | | MakerVault at 90 % of `maxTotalNotional`, of `maxSeriesUnits` on a series, or 15 of 16 live orders on a series | §V26 | §4c |
| `v2_mon_vault_inventory_low` | warn | | MakerVault USDG (wallet + free ledger) under 100, or under 1 share of a Stock Token it quotes | §V26 | — |
| `v2_mon_config_changed` | error / warn | yes | an admin or guardian action on any v2 contract (the event table in §V27; the INTERFACE_VERSION 6 wiring events have the kinds of §V38-§V42); history before the first run is adopted | §V27 | §5 |
| `v2_mon_feed_mismatch` | error | | the Chainlink source reads a different feed than the registry names | §V28 | §5 |
| `v2_mon_feed_aggregator_changed` | warn | yes | the proxy's `aggregator()` differs from the last run (first run: from the registry's `feedAggregator`) | §V28 | §1 |
| `v2_mon_feed_access_controller` | error | | the proxy's `accessController()` is not zero | §V28 | §2 |
| `v2_mon_feed_owner_changed` | warn | yes | the proxy's `owner()` changed | §V28 | — |
| `v2_mon_safe_nonce_changed` | info | yes | the feed owner Safe executed a transaction | §V28 | — |
| `v2_mon_safe_config_changed` | warn | yes | the feed owner Safe's threshold or owners changed | §V28 | — |
| `v2_mon_feed_round_jump` | warn | yes | a round moved more than 5 % from the round before it | §V29 | §1 |
| `v2_mon_feed_stale` | error / warn | | **error**: no round for the feed's heartbeat (24 h) + 1 h of open 24/5 market; **warn**: no print since the 24/5 market reopened (Sunday or a holiday's 20:00 New York), 15 min after it | §V44 | §7 |
| `v2_mon_price_divergence` | warn / error | | Chainlink source price differs from pool 5-minute TWAP beyond a calibrated per-market band below 300 bps; error on a second distinct pass | §V48 | §7 |
| `v2_mon_token_paused` | error | | a Stock Token's `paused()` | §V30 | §6 |
| `v2_mon_oracle_paused` | warn | | a Stock Token's `oraclePaused()` | §V30 | §2 |
| `v2_mon_multiplier_updated` | warn / error (decrease) | yes | `UIMultiplierUpdated` logged | §V31 | §1 |
| `v2_mon_multiplier_staged` | warn | | `newUIMultiplier() != uiMultiplier()` | §V31 | §1 |
| `v2_mon_token_blocked` | error (Clearinghouse) / warn | | `isBlocked` on the token's `ACCESS_CONTROLLED_REGISTRY()` for the Clearinghouse, MakerVault, PayoutAdapter or the market's pool | §V32 | §6 |
| `v2_mon_usdg_paused` | error | | USDG `paused()` | §V33 | §6 |
| `v2_mon_usdg_frozen` | error (Clearinghouse, OrderBook) / warn | | USDG `isFrozen` of a v2 contract | §V33 | §6 |
| `v2_mon_pool_liquidity_low` | warn | | the market pool's `liquidity()` below the registry's `univ3MinLiquidity` | §V34 | §3 |
| `v2_mon_pool_wiring` | error | | UniV3TwapSource names another pool than the registry, or a minimum liquidity below it | §V34a | §3, §5 |
| `v2_mon_l2_lag` | warn / error (> 15 min) | | the head block's timestamp is more than 60 s behind the wall clock | §V35 | `incident.md` §7 |
| `v2_mon_service_down` | error | | a `--health` target does not answer, or answers non-2xx (503 `wedged`) | §V36 | — |
| `v2_mon_service_degraded` | warn | | it answers 2xx with `status` not ok/starting, `database` not ok, a breaker `open`, or `rules.status: failing` | §V36 | — |
| `v2_mon_check_failed` | warn (error for `head`) | | a check could not complete (RPC down, a read reverted, a log range refused) | §V37 | — |
| `v2_mon_state_unwritable` | error | | the monitor cannot write its state file: without it every run starts blind | §V37a | — |
| `v2_mon_resolved` | info | | an open warn/error condition cleared | §V37 | — |
| `v2_mon_fee_scheduled` | warn / error (a fee rises, the maker rebate falls, or the fees before are unknown) | yes | `OrderBook.FeeParamsScheduled`: a fee change in effect 24 h later, resting orders included | §V38 | §5b |
| `v2_mon_fee_change_pending` | warn / error (a rise) | | `pendingFeeParams()` shows a change no `v2_mon_fee_scheduled` announced (an adopted log, a lost state file) | §V38 | §5b |
| `v2_mon_route_changed` | warn / error (tier above 10000, a pool or venue the registry does not name, an asset without a registry route) | yes | `UniV3PayoutAdapter.RouteSet`, and from INTERFACE_VERSION 8 the `PayoutRouter`'s own five-field `RouteSet` and its `RouteCleared` | §V39 | §3, §5 |
| `v2_mon_oracle_allowlist` | error / warn | yes | a source's `OracleSet`: **error** for any account but the published SettlementOracle allowed, or that oracle removed | §V40 | §5a |
| `v2_mon_oracle_clearinghouse` | error / warn | yes | `SettlementOracle.ClearinghouseSet`: **error** unless it is the live Clearinghouse | §V40 | §5a |
| `v2_mon_pre_pin` | error | yes | a `SettlementConfigPinned` without the Clearinghouse's `SeriesCreated` of that expiry in its transaction, or a source's `FeedPinned` / `PoolPinned` without either | §V41 | §5a |
| `v2_mon_data_streams_feed` | error (the source listed anywhere) / warn | yes | `DataStreamsSource.FeedSet` | §V42 | §5 |
| `v2_mon_pin_blocked` | error | | the dry run `SettlementOracle.pin(asset, E)` as the Clearinghouse reverts, for the expiries nobody pinned (`<asset>:unpinned`) or one pinned some other way (`<asset>:<E>`) | §V43 | §5a |
| `v2_mon_pinned_by` | error | | `pinnedBy(asset, E)` is neither 0 nor the Clearinghouse, for a creatable expiry or one with series | §V43 | §5a |
| `v2_mon_pin_mismatch` | error | | an expiry with series is pinned to a configuration the registry does not publish (sources, deviation, delay, spot age, the feed and its bounds, the pool and its floor), or a market row points new series at another oracle | §V43 | §5, §5a |
| `v2_mon_quote_unready` | warn | | with `--pricing`: a market's chain is refused (`chain-stale`, `chain-inconsistent`, not carried), or a tenor of it has an expiry or a probed live series that cannot be priced. Per tenor, never aggregated: a daily failure pages under `<TICKER>:daily` however well the weeklies price, and an expiry a live series settles on that the provider does not list is that tenor's failure. Priceability only — the process is §V36 | §V49 | §10 |
| `v2_mon_pricing_reason_unknown` | warn | | the pricing service stated a refusal or quality code this build does not know; `02-interfaces.md` §5.1 has automation treat an unknown code as **not ready**, so the series carrying it is counted unready too | §V49 | §10 |
| `v2_mon_source_age` | warn | | a source observation clock (quote / underlying / volatility) is past an operator limit, or is **unknown** while a limit is set — an unknown age is not fresh and is never 0. Inactive until `--threshold quoteAgeS=…` / `underlyingAgeS=…` / `volatilityAgeS=…` is set | §V50 | §10 |
| `v2_mon_source_switch` | warn / info (a label appears or disappears) | yes | the data provider, the pricing method or the legacy `source` label of a market changed between two polls | §V50 | §10 |
| `v2_mon_pricer_idle` | warn | | with `--pricer`: its `/state` shows no tick and no pair evaluation for `pricerIdleS` (900 s) while the session is open. A pricer that does not answer at all is §V36 instead, never this | §V51 | §10 |
| `v2_mon_manager_operation` | error / warn (a cancel) | yes | INTERFACE_VERSION 8: any `AccessManager.OperationScheduled` / `OperationExecuted` / `OperationCanceled`. Every delayed admin action passes through here, so every one is paged | §V52 | §5 |
| `v2_mon_manager_role` | error / warn (`RoleLabel`) | yes | INTERFACE_VERSION 8: any manager role or target change — `RoleGranted(uint64,…)`, `RoleRevoked`, `RoleAdminChanged`, `RoleGuardianChanged`, `RoleGrantDelayChanged`, `TargetFunctionRoleUpdated`, `TargetAdminDelayUpdated`, `TargetClosed`. **Not** AccessControl's `RoleGranted(bytes32,…)`, which is §V27 | §V53 | §5 |
| `v2_mon_manager_wiring` | error | | the manager's state disagrees with `ops/abis/v2/roles.json`: a role's admin or guardian, a published holder that does not hold its role or holds one it should not, or a member whose execution delay is not the manifest's | §V54 | §5 |
| `v2_mon_safe_threshold` | error | | a protocol Safe needs fewer than 2 signatures, or more than it has owners. Judged with **no history**, so it fires on the first run against a Safe that is already 1-of-3 | §V55 | §5 |
| `v2_mon_protocol_safe_nonce_changed` | info | yes | INTERFACE_VERSION 8: **our own** Admin or Treasury Safe executed a transaction. Distinct from `v2_mon_safe_nonce_changed`, which is the third-party feed owner Safe | §V55 | §5 |
| `v2_mon_protocol_safe_config_changed` | error | yes | INTERFACE_VERSION 8: **our own** Admin or Treasury Safe changed its threshold or its owners — who signs for this protocol, or how many of them are needed | §V55 | §5 |
| `v2_mon_splitter_idle` | warn | | fees have been waiting at the FeeSplitter for `splitterIdleS` (24 h) with no `Distributed`. `distribute()` is permissionless | §V56 | §3 |
| `v2_mon_splitter_floor_miss` | error | | `splitterFloorMisses` (3) consecutive `DistributionSkipped` with the same reason for one asset (`BELOW_FLOOR`, `NO_ROUTE`, `NO_SPOT`, `DUST`) | §V56 | §3 |
| `v2_mon_buyback_stuck` | warn | | the buyback balance is non-zero, the 5-minute cooldown is long over, nothing has bought back for `buybackStuckS` (6 h), and the contract has emitted **no** recent `BuybackSkipped` — so nothing is calling `buyback()` | §V57 | — |
| `v2_mon_buyback_skipped` | error | | the balance is idle **and** `FeeSplitter` emitted `BuybackSkipped` inside the window: the cranker IS calling and the contract is refusing. `EMPTY` with a non-zero balance means `buybackCap` is 0; `NO_EXECUTOR` means `executor` or `stonkhouse` is unset | §V57 | — |
| `v2_mon_buyback_unburned` | error | | a `BoughtBack` with no `Burned` in the same transaction. Nothing may report a burn that has not happened | §V57 | — |
| `v2_mon_route_wiring` | error / warn (a cached route fee above 100 bps) | | INTERFACE_VERSION 8: a market's on-chain `PayoutRouter.routes()` disagrees with the registry's `payoutRoute` — venue, fee tier, v4 tick spacing, or a pinned v4 pool id that is not what its own key hashes to | §V58 | §3, §5 |
| `v2_mon_route_decode` | error | | `v2.contracts.payoutAdapter` is not the shape the registry's `interfaceVersion` says it is. `routes(address)` is one selector with two return tuples, so the wrong one decodes **without reverting**; route checks stop rather than guess | §V58 | §3 |
| `v2_mon_mint_fee_charged` | error / warn (a market not enabled yet) | | INTERFACE_VERSION 8: writer rent is charged where v8 charges none — a market row, the registry, or a series pinned at a non-zero rate. **This is §V47 inverted**: under v7 the alert was rent MISSING | §V59 | §9 |
| `v2_mon_token_pool_fee` | error | | the published STONKHOUSE pool is hooked, charges more than `MAX_HOOK_FEE_BPS` (300 bps), or its id is not what its own `PoolKey` hashes to | §V60 | — |
| `v2_mon_token_pool_depth` | warn | | the STONKHOUSE pool's depth is below `tokenPoolMinDepth`, or is **unknown** while that threshold is set. Inactive until an operator sets it | §V60 | — |
| `v2_mon_tvl_audit_trigger` | warn / error (at or past the trigger) | | USDG locked in the v8 contracts reaches half of, then all of, `auditTriggerUsdg`. Inactive until an operator sets it | §V61 | — |
| `v2_mon_reprice_floorward` | error | event | an `AutoRoller.Repriced` lowered a writer's ask by at least `repricePageDropFraction` of the per-call cap (`MAX_REPRICE_DROP_BPS`, 25 %): the step a key walking the ask to the floor sends | §V62 | §5 |
| `v2_mon_reprice_foreign_sender` | error | event | an `AutoRoller.Repriced` whose transaction sender is not the registry's `v2.bots.pricer` | §V62 | §5 |
| `v2_mon_repriced` | warn | event | every other `AutoRoller.Repriced`, individually up to `repriceWarnCap` per run, then one summary | §V62 | — |

## Index — every v1 keeper kind (`keeper/src/alerts.ts`)

§V16 has the table: all 24 kinds, which process emits each, and which ones the factory keeper still
sends in run-off.

---

## v2 bots — first three checks

### §V1 `v2_boot` — INFO
The mode checked its wiring on chain (the book's clearinghouse, the clearinghouse's calendar and
USDG match the env) and started. A deploy or restart sends one; several an hour is a crash loop.

1. `railway logs --service <cranker|mm-bot|pricer>` around the boot lines: the exit before each boot
2. `probe <service> http://<service>.railway.internal:<8792|8793|8794>/health` (private network): `status`, `lastTickError`
3. `cast balance $CRANKER --rpc-url $RH_RPC` (or `$PRICER` / `$QUOTER`): a key without gas fails every send

→ A boot that refuses (wrong addresses, `CHAIN_ID` mismatch, a missing key) exits 1 before this alert
and never sends it: Railway shows the crash, the monitor's `--health` shows `v2_mon_service_down`.

### §V2 `v2_error` — P2 (error)
A tick threw (`data.reason`), or one cranker step failed (`data.step`, deduped per step for an hour;
the other steps of the tick still ran).

1. `railway logs --service cranker` at the timestamp: the same line at error level, with the stack
2. `probe cranker http://cranker.railway.internal:8792/state`: per-step metrics, the last tick's report
3. `node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts`: is anything on chain actually late?

→ A step failing every tick is deterministic (a read that reverts, an indexer answering garbage): the
cranker falls back to its own log index when the indexer fails; everything it does is permissionless,
so `incident-v2.md` §2 step 3 covers a cranker that cannot recover. Restarting is safe at any point.

### §V3 `v2_tx_revert` — P2 (error)
A transaction the bot sent reverted on chain, was not confirmed within `KEEPER_TX_TIMEOUT_MS`, or could not be
broadcast at all (`data.status: send-failed`, no hash: the signing wallet is pinned to `RH_RPC`, so a primary that
still answers reads but refuses `eth_sendRawTransaction` shows only here). Bots simulate first, so an on-chain revert
means state changed between simulation and inclusion.

1. `cast run <data.hash> --rpc-url $RH_RPC` to decode (the ABIs merge `V2Errors`: `NotExpired`, `TooEarly`, `AlreadyFinal`, `ThirdPartyRedeemDisabled`, `CeilingExceeded`, `NotAuthorized`, …)
2. `cast receipt <data.hash> --rpc-url $RH_RPC` (`gasUsed` at the limit: an out-of-gas; the cranker's limits are fixed, `cranker/constants.ts`)
3. The step's state now, e.g. `settlementInfo` / `series(longId)` (shell prelude): did someone else do it first?

→ Mostly a race with another keeper or a user (idempotent calls: nothing lost). `NotAuthorized` from
the pricer or the MM bot means its role is gone (`incident-v2.md` §4). A "not confirmed" usually
follows `v2_rpc_lag`. Repeated `send-failed` pages from one bot: check `RH_RPC` itself (`cast chain-id --rpc-url $RH_RPC`,
a test `cast publish` from an ops key); reads keep working through `RH_RPC_2`, sends do not.

### §V4 `v2_low_gas` — P2 (warn)
The signer holds less than `KEEPER_MIN_GAS_WEI` (0.01 ETH). `data.balanceWei`, `data.minBalanceWei`.

1. `cast balance <signer> --rpc-url $RH_RPC`
2. `probe cranker http://cranker.railway.internal:8792/state`: how many sends per tick (a redemption wave spends more)
3. The next expiries with open interest: the gas they need soon (`ops/devnet` measures: finalize up to 1.5 M, redeemBatch 8 M per chunk)

→ Top up to ~0.05 ETH. The cranker's gas is refunded in bounties only roughly; the MM bot and pricer
earn none. Without gas the cranker stops; `incident-v2.md` §2 step 3 still works from any key.

### §V5 `v2_rpc_lag` — P2 (warn)
The head block trails the wall clock by more than `KEEPER_RPC_LAG_ALERT_MS` (5 min), or no RPC
answered the tick's probe (then the tick fails too, and `/health` goes 503 after three intervals).

1. `cast block latest -f number,timestamp --rpc-url $RH_RPC` and `date +%s`
2. `cast block-number --rpc-url $RH_RPC_2` (the backup): one endpoint, or the chain?
3. `v2_mon_l2_lag` from the monitor (its own RPC): if it fires too, the sequencer is stalled

→ One RPC down: fix the variable. The chain stalled: `incident.md` §7; the snapshot grace (600 s) is
the part of settlement a long stall can cost (`incident-v2.md` §2).

## Cranker — first three checks

### §V6 `v2_sources_disagree` — P2 (warn)
The expiry's ok sources disagree beyond the pinned deviation; the highest-priority ok source is the
candidate and **finalizes at `data.finalizableAt` unless the guardian vetoes**. Once per candidate.

1. `cast call $ORACLE "candidate(address,uint40)(uint256,uint8,bool,uint40)" $ASSET $E --rpc-url $RH_RPC`
2. `cast call $ORACLE "recordedSources(address,uint40)(address[],bool[],uint256[],uint16)" $ASSET $E --rpc-url $RH_RPC`
3. The reference: official close × `uiMultiplier()` / 1e18 (`incident-v2.md` "The independent price")

→ `incident-v2.md` §1. Decide before `finalizableAt`.

### §V7 `v2_settlement_held` — P1 (error)
Vetoed: nothing settles until two sources corroborate, `unveto`, or `adminResolve` from `E + 48 h`.

1. `cast call $ORACLE "settlementInfo(address,uint40)(uint8,uint256,uint8,bool,bool,bool)" $ASSET $E --rpc-url $RH_RPC` (status 3)
2. `cast logs --address $ORACLE "SettlementVetoed(address indexed underlying, uint40 indexed expiry)" --from-block <E's block - 5000> --rpc-url $RH_RPC`: who and when (a veto nobody owns: `incident-v2.md` §5)
3. `cast call $ORACLE "resolveBand(address,uint40)(bool,uint256,uint256)" $ASSET $E --rpc-url $RH_RPC`

→ `incident-v2.md` §1 step 5.

### §V8 `v2_snapshot_missed` — P2 (warn)
The pool's window for this expiry could only be recorded inside `[E, E + 600]` and was not: the pool
cannot vote, so the expiry settles on Chainlink alone after the delay. Once per expiry.

1. `cast call $UNI_SRC "snapshots(address,uint40)(uint128,int24,uint40)" $ASSET $E --rpc-url $RH_RPC` (recordedAt 0)
2. The cranker's logs at `E`: was the wake-up late (`v2_rpc_lag`, a restart, an out-of-gas)?
3. `cast call $ORACLE "candidate(address,uint40)(uint256,uint8,bool,uint40)" $ASSET $E --rpc-url $RH_RPC`: the single-source candidate and its `finalizableAt`

→ Compare the candidate with the reference before `finalizableAt` (`incident-v2.md` §1). The window
cannot be recorded later.

### §V9 `v2_settle_stuck` — P1 (error)
Three variants (`data`): no source prices the window an hour after finalize opens; a candidate half an
hour past `finalizableAt` still Pending; or the expiry is final and `settle(longId)` does not advance
or reverts: one page per expiry, `data.series` of them, the first 20 in `data.longIds`, `data.reverts`.

1. `settlementInfo`, `candidate`, `recordedSources` (shell prelude), and `cast call $CL_SRC "windowPrice(address,uint40,uint40)(bool,uint256)" $ASSET $((E-1800)) $E --rpc-url $RH_RPC`
2. `cast call $ASSET "oraclePaused()(bool)" --rpc-url $RH_RPC` and `cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC`
3. For the settle variant: `cast call $CH "series(uint256)((address,bool,uint40,uint128,address,uint16,bool,uint128,uint128,uint128,uint128,uint32,uint128))" <longId> --rpc-url $RH_RPC` and a `cast call $CH "settle(uint256)(bool)" <longId> --from <any> --rpc-url $RH_RPC` simulation

→ `incident-v2.md` §2.

### §V10 `v2_redeem_backlog` — P2 (warn)
Holders the cranker can redeem (non-zero balance, third-party redemption allowed, a payout above
zero or zero-payout burning enabled), or units held by holders nobody indexed, remain an hour after
settlement. One page per expiry: `data.holders`, `data.unaccounted`, and per token (the first 20) `data.tokens[]`
with `tokenId`, `remaining`, `skipped` (a chunk that would not fit), `unaccounted`.

1. `probe cranker http://cranker.railway.internal:8792/state`: the redeem step's summary (candidates, redeemed, skipped)
2. `curl -s "$INDEXER_URL/v2/series/<longId>/holders"` against `cast call $CH "totalSupply(uint256)(uint256)" <tokenId> --rpc-url $RH_RPC`
3. `cast call $CH "balanceOf(address,uint256)(uint256)" $BOOK <longId> --rpc-url $RH_RPC`: escrow not pruned?

→ Usually gas (§V4) or the budget per tick (`CRANKER_MAX_TX_PER_STEP`); it catches up. Holders who
opted out are not a backlog. The monitor's `v2_mon_redeem_backlog` (6 h) is the escalation.

### §V10a `v2_pin_refused` — P2 (error)
Every series creation pins its expiry's settlement configuration on the oracle and on each source, and
the pin fails closed: no series of the expiry can be created (no ladder rung, no AutoRoller roll into it)
until the refusal is fixed. The cranker skips the expiry and simulates one creation again every 15 min;
nothing is sent while it is refused. `data.error`:

| error | means | fix (admin) |
|---|---|---|
| `NotAuthorized` | the oracle's `clearinghouse` pointer is not this Clearinghouse | `SettlementOracle.setClearinghouse` |
| `NoSource` | the market has no source on the oracle | `SettlementOracle.setMarket` |
| `PinMismatch` | the expiry was pinned through another Clearinghouse (or by the admin outside a creation) with a configuration that differs from the market's now | restore the pinned configuration, or leave the expiry unused |
| `SourceNotPinned` | source `data.source` refused its pin; `data.reasonName`: `NotAuthorized` (its oracle allow-list lacks this oracle: `setOracle`), `NoSource` (no feed or pool for the underlying), `PinMismatch` (its earlier pin of the expiry differs from its configuration now), `none` (no code or a bad answer) | as the reason says |

1. `cast call $ORACLE "settlementConfig(address,uint40)(bool,address[],uint16,uint32,uint32)" $ASSET $E --rpc-url $RH_RPC` and `cast call $ORACLE "pinnedBy(address,uint40)(address)" $ASSET $E --rpc-url $RH_RPC` against `cast call $ORACLE "clearinghouse()(address)" --rpc-url $RH_RPC`
2. For `SourceNotPinned`: `cast call $SRC "isOracle(address)(bool)" $ORACLE --rpc-url $RH_RPC`, and its `pinnedFeeds` / `pinnedPools(address,uint40)` for the expiry against its current `feeds` / `pools(address)`
3. `probe cranker http://cranker.railway.internal:8792/state`: the ladders step's `pins` (action, probe) and `failures`

→ A pin nobody expected (`SettlementConfigPinned` with no `SeriesCreated`, a source allow-list or pointer
change) is `incident-v2.md` §5 until its owner is found.

### §V10b `v2_stale_cancel_failed` — P2 (error; **warn** for a revoked delegate)
INTERFACE_VERSION 7 (c16). An `AutoRoller` ask is at or past its strike (`data.spot`, `data.strike`), where
every price the writer's band allows is below intrinsic value, and the cranker's permissionless
`AutoRoller.cancelStale` is refused by its simulation (`data.revert`). The ask keeps resting until a taker
lifts it or it expires; `reprice` will not touch it either (it reverts `InTheMoney`). The cranker's `stale`
step mirrors every condition the contract answers `false` for, so a refusal here is a state only the writer
or the admin can change.

1. `cast call $ROLLER "position(address,address)(uint256,uint64,uint40)" $WRITER $ASSET --rpc-url $RH_RPC` and `cast call $BOOK "getOrders(uint256[])((address,uint256,uint8,uint128,uint64,uint64,uint40,bool)[])" "[$ORDER_ID]" --rpc-url $RH_RPC`: is the ask still live?
2. `data.revert`: `NotAuthorized` = the writer revoked the roller as its Clearinghouse operator (warn: only the writer can restore it, and the position closes out at expiry either way); `TradingPaused` = the guardian paused the book, so no cancel goes through; anything else is unexpected
3. `cast call $ORACLE "trySpot(address)(bool,uint256,uint256)" $ASSET --rpc-url $RH_RPC` against `data.strike`, and `probe cranker http://cranker.railway.internal:8792/state`: the `stale` step's `reasons` and `refused`

→ `NotAuthorized`: nothing to do; the writer's ask is the writer's to withdraw (`AutoRoller.stop`), and the
notifier tells them. Anything else on every tick: `incident-v2.md` §5.

### §V10c `v2_cranker_no_buyback_role` — P2 (error)
INTERFACE_VERSION 8. The cranker's key does not hold `BUYBACK` (role id 10) on the `FeeSplitter`
(`data.signer`, `data.splitter`), so `FeeSplitter.buyback` is refused by its own simulation and nothing is
sent. The rest of the flywheel is unaffected: `claimOrderBookFees` and `distribute` are permissionless, so
fees keep arriving and keep being split — what stops is the buy-and-burn leg, and the splitter's buyback
reserve grows until the role is restored. Nothing is lost; it accumulates.

This is raised only from the **buyback** probe, and that is deliberate: `Managed` answers an unauthorised
call with `V2Errors.NotAuthorized`, which is byte-identical to what `distribute` raises when the treasury is
unset, so the same revert from a distribute would not mean a missing role.

1. `cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" 10 $CRANKER --rpc-url $RH_RPC`: member, and an execution delay of **0** — a non-zero delay means the call must be scheduled, which the cranker will not do
2. `cast logs --address $MANAGER "RoleRevoked(uint64 indexed roleId, address indexed account)" --from-block <recent> --rpc-url $RH_RPC`: who revoked it, and when. Note this topic is NOT `AccessControl.RoleRevoked` (§V57)
3. `probe cranker http://cranker.railway.internal:8792/state`: the `flywheel` step's notes — `buybackBalance` is what has accumulated, and `buyback` says `refused: no BUYBACK role`

→ Revoked by the rota (an `incident-v2.md` §4b response): expected; the reserve is safe and grows. Never
granted after a deploy or a key rotation: `OPS_ADMIN` grants it at delay 0 (`script/v2/roles.v8.json`), one
Safe transaction. Nobody owns the revoke: **P1**, `incident-v2.md` §5. Do not confuse this with
`v2_mon_buyback_stuck` (§V57), which the monitor raises from chain state and which fires whether or not the
cranker is even running.

### §V19 `v2_house_roll_overdue` — P2 (error; P1 on a launch-set vault past a second boundary)
A House vault's weekly boundary is due and has not rolled for more than 7 h. The cranker sends `rollEpoch()`
itself (housekeeping step, T-OP-117) only when the contract's three preconditions hold: head past `epochEnd`,
`oracle.settlementPrice(underlying, epochEnd)` Finalized, every tracked series settled with nothing held and no
live order. `data.decision` is the one that failed. Until the roll, every `requestDeposit` / `requestWithdraw`
queued for the boundary sits unpriced (`HouseVault.sol` "NAV, AND THE MISTAKE IT IS BUILT TO AVOID").

1. `cast call $HOUSE "epochEnd()(uint40)" --rpc-url $RH_RPC` and `cast call $HOUSE "epochId()(uint64)"`: is it still the same epoch the page names?
2. `not-finalized`: `cast call $ORACLE "settlementInfo(address,uint40)(uint8,uint256,uint8,bool,bool,bool)" $ASSET $E --rpc-url $RH_RPC` — status 1 Pending past `finalizableAt` is `v2_settle_stuck`'s ground (§V9), status 3 Held is `v2_settlement_held`'s (§V7); `$ORACLE` and `$ASSET` are the VAULT's own `oracle()` / `underlying()`, which can differ from the market's oracle after a `setMarketOracle` migration (HouseVault.sol F6).
   `not-flat`: `cast call $HOUSE "trackedSeries()(uint256[])"` then, per id in `data.detail`, `cast call $CH "series(uint256)" <longId>` (settled?) and `cast call $HOUSE "exposure(uint256)(uint256,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))" <longId>` (longs, shorts, live must all be 0): an unsettled series is the cranker's settle step's job; a held long or short after settlement is redeemed by anyone with `cast send $CH "redeem(uint256,address)" <id> $HOUSE`; a live order is the MM bot's to cancel (`POST /kill` for that vault if it will not).
3. When the preconditions hold and the cranker still did not send (budget, dry run, a revert in the journal), the call is PERMISSIONLESS: `cast send $HOUSE "rollEpoch()" --gas-limit 2500000 --rpc-url $RH_RPC --private-key <any funded key>` — the recipient of the performance fee is the immutable splitter and the batch rates are decided on chain, so no key can misdirect it.

→ The page clears on the next tick that finds the vault not due (rolled by the bot or by hand).

## MM bot and pricer — first three checks

### §V11 What they share, and what the monitor adds
`mm` and `pricer` run on the cranker's runtime: the five common kinds (§V1-§V5) under `callhouse-mm` /
`callhouse-pricer`, plus their own below (`keeper/src/v2/alerts.ts` `ALERT_SEVERITY`). Both answer
`GET /state` on the private network (`mm-bot` :8793, `pricer` :8794; neither ever gets a public domain,
`ops/deploy.md` §15). The monitor adds `v2_mon_vault_limit`, `v2_mon_vault_inventory_low`,
`v2_mon_service_down` (`--health mm-bot=…:8793/health`, `pricer=…:8794/health`) and
`v2_mon_config_changed` for `RoleGranted`, `RoleRevoked`, `LimitsSet`, `Withdrawn`. A key or role problem is
`ops/runbooks/incident-v2.md` §4 (§4b the pricer, §4c the MM quoter); a role nobody on the rota revoked
is §5.

**The kill switch**, from inside the project (the token is read in the container, never typed):

```bash
railway ssh --service mm-bot -- node -e 'fetch("http://127.0.0.1:8793/kill",{method:"POST",headers:{authorization:"Bearer "+process.env.MM_KILL_TOKEN,"content-type":"application/json"},body:JSON.stringify({reason:"on-call"})}).then(async(r)=>console.log(r.status,await r.text()))'
```

200 `{ killed: true, cancelled, remaining: 0, remainingOrderIds: [], done: true }` once no vault order is
live or still holds escrow (an expired Bid or AskResale), 202 `done: false` when the cancels run past a minute
(they carry on; `remaining: -1`) or when orders are left after every cancel pass (`remaining`,
`remainingOrderIds`, and the failed cancels in `errors`; every later tick keeps cancelling them), 401 on a
wrong token. `/resume` takes the same header and no body.

### §V11a `v2_mm_killed` — P2 (error) and `v2_mm_resumed` — INFO
`POST /kill` with the token (`data.reason`, default `POST /kill`). The kill is stored before anything
else (a restart stays killed), then every vault order with units left is cancelled, on every market,
until a re-read finds none; ticks send nothing but cancels until `POST /resume` (`v2_mm_resumed`).

1. `probe mm-bot http://mm-bot.railway.internal:8793/state`: `killed`, `lastKill` (`done`, `remaining`, `remainingOrderIds`, `errors`)
2. What the vault still holds on the book. `--json` is not optional: `cast call` prints any uint256 from 10000 up as `10234 [1.023e4]`, and a plain loop then iterates the annotations too.
   ```bash
   ids() { cast call "$@" --rpc-url $RH_RPC --json | tr -d ' \n"' | sed 's/^\[//; s/^\[//; s/\].*$//' | tr ',' '\n' | grep -v '^$'; }
   for s in $(ids $VAULT "trackedSeries()(uint256[])"); do echo "series $s:"; ids $VAULT "orderIdsOf(uint256)(uint256[])" "$s"; done
   ```
3. `railway logs --service mm-bot` around `kill switch engaged`: the reason and any failed cancel

→ A kill nobody on the rota sent means the token is out: **P1**, `incident-v2.md` §4c, and rotate
`MM_KILL_TOKEN` (`ops/deploy.md` §15.4). `remaining` above 0 or `errors`: cancel by hand
(`incident-v2.md` §4c step 3). Resume only once the cause is known.

### §V11b `v2_mm_loss_stop` — P1 (error)
The day's realised loss (fills at average cost per series, seller fees included; a settlement closes at
intrinsic value) reached `MM_DAILY_LOSS_LIMIT_USDG6` (1,000 USDG by default). Every quote is pulled until
the next UTC day; cancels and housekeeping continue. Once per UTC day (`data.day`, `realised`, `limit`).

1. `probe mm-bot http://mm-bot.railway.internal:8793/state`: `lossStop`, `recentFills` (series, side, units, price), `netDelta`
2. For the largest fills, the fair value then and now: `probe pricing "http://pricing.railway.internal:8790/fair?ticker=$T&strike=<6dp>&expiry=<unix>&type=call"` against the fill price
3. `cast call $ASSET "oraclePaused()(bool)" --rpc-url $RH_RPC` and the feed's `latestRoundData` (§V9 check 2): did spot jump or go stale?

→ A stale or wrong fair value: fix pricing (§V12) before 00:00 UTC, or kill (§V11) so the reset does
not quote into it again. A loss nobody can explain: `incident-v2.md` §4c (a hostile quoter trades the
inventory badly). The limit is a Railway variable and a restart.

### §V11c `v2_mm_delta` — P2 (warn)
A market's net inventory delta is above `MM_DELTA_ALERT_SHARES` (50) shares (`data.ticker`,
`deltaShares`). The quotes already skew against it; there is no borrow market, so hedging is by hand.

1. `probe mm-bot http://mm-bot.railway.internal:8793/state`: `netDelta` for the ticker (`deltaShares`, `deltaUsdg`, `positions`, `positionsWithoutDelta`)
2. The same `/state` `series` of that ticker: `quote.skew` and `clampedBy` (is the skew at `MM_MAX_SKEW_BPS`?)
3. `cast call $VAULT "exposure(uint256)(uint256,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))" <longId> --rpc-url $RH_RPC` for the largest series (units, notional; longs, shorts, bids, resale, writes, live)

→ Hedge in the Stock Token outside the protocol, or shrink the side that fills (`MM_BID_UNITS` /
`MM_ASK_UNITS`, a restart). `positionsWithoutDelta` above 0: those positions had no `/fair`, so the
figure is a lower bound.

### §V11d `v2_mm_not_quoter` — P1 (error)
The MM signer holds neither `QUOTER_ROLE` nor admin on `MakerVault` (`data.signer`): it can neither
quote **nor cancel**, so the vault's live orders stay on the book at their last prices.

1. `cast call $VAULT "hasRole(bytes32,address)(bool)" $QUOTER_ROLE $QUOTER --rpc-url $RH_RPC`, and `data.signer` against `$QUOTER` (the wrong key on Railway?)
2. `cast logs --address $VAULT "RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)" --from-block <recent> --rpc-url $RH_RPC`: who revoked it, and when
3. The vault's live orders (§V11a check 2): still near fair?

→ Revoked by the rota (an `incident-v2.md` §4c response): expected; stop the service. Nobody owns the
revoke: `incident-v2.md` §5 (admin key). The wrong key in `MM_QUOTER_PK`: set the right one
(`ops/deploy.md` §15.4). Stale live orders: the admin cancels them (`incident-v2.md` §4c step 3).

### §V11e `v2_mm_pricing` — P2 (warn)
Every series the bot selected is halted for want of a fair value (`data.halts`: `fair-unavailable` when the service
is unreachable or refuses with a reason such as `chain-stale`, `spot-unavailable`, `chain-inconsistent`;
`fair-stale` when `asOf` is older than `MM_FAIR_MAX_AGE_S`), or no `/fair` request was answered (`data.reasons`,
`pricingUrl`). Nothing is quoted, and quotes without a fresh fair value are cancelled.

1. `probe pricing http://pricing.railway.internal:8790/health` (`chains.<ticker>.ok`: the latest download; `usable`: whether it still prices)
2. `data.reasons` (timeouts, errors or the service's refusal codes) and the `PRICING_URL` set on `mm-bot`
3. The monitor's `v2_mon_service_down` / `v2_mon_service_degraded` for `pricing`

→ §V12. Quotes come back on the first tick with fair values; nothing to undo.

### §V11f `v2_mm_tx_rejected` — P2 (warn)
A vault call failed its simulation and was not sent (`data.kind`: `mm-place`, `mm-replace`,
`mm-cancel`, `mm-sync`, `mm-close`, `mm-claimOwed`, `mm-deposit`; `data.revert`). The bot sizes
inside the vault's guards, so a repeat means its reads and the chain disagree.

1. `data.revert`: `StaleSpot` (§V9 check 2), `TradingPaused` (the guardian paused the book), `PastCutoff`, `CeilingExceeded` / `BadPrice` (a vault guard)
2. `cast call $VAULT "limits()((uint64,uint128,uint16,uint16,uint32,uint128))" --rpc-url $RH_RPC`, and `askFloor(uint256)` / `bidCap(uint256)` of the series in `data.key`
3. `probe mm-bot http://mm-bot.railway.internal:8793/state`: `vaultState.tradingPaused`, `series[].halt`

→ Once: a race, ignore. Every tick on the same key: a `LimitsSet` (`v2_mon_config_changed`) the bot's
caps no longer fit, or a pause; fix the limits or `MM_MAX_SERIES_UNITS` / `MM_MAX_TOTAL_NOTIONAL_USDG6`.

### §V11g `v2_mm_funds` — P2 (warn)
On `data.series` series of `data.ticker` one side is sized to zero by funds: no USDG to escrow bids, or no
free ledger collateral for write asks.

1. `cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC` and `cast call $CH "free(address,address)(uint256)" $VAULT $USDG --rpc-url $RH_RPC`
2. `cast call $CH "free(address,address)(uint256)" $VAULT $ASSET --rpc-url $RH_RPC` and `cast call $ASSET "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC` (idle tokens move into the ledger while `MM_DEPOSIT_TOKENS=1`)
3. `probe mm-bot http://mm-bot.railway.internal:8793/state`: `vaultState` (`usdgWallet`, `owed`, `freeCollateral`, `walletTokens`)

→ Fund the vault (owner-gated: treasury to `MakerVault.deposit`), or accept one-sided quotes.
`v2_mon_vault_inventory_low` is the monitor's view of the same.

### §V11k `v2_mm_outflow` — P2 (warn)
INTERFACE_VERSION 7 (c21). The vault charges the net USDG a quoter call moves out of
`usdg.balanceOf(vault) + orderBook.owed(vault)` against a leaky bucket that refills at
`limits.maxDailyOutflow` per 24 h, and refuses a Bid `place`, a Bid `replace` or a `take` above it. The bot
sizes its bids inside what is left (`data.budget`, `seriesTrimmed`), so this normally means **smaller bids**,
not lost quotes; `data.refused` names any call the chain refused anyway (a race, or a spend between ticks).
Asks, cancels, closes and ledger moves are never blocked by the cap.

1. `cast call $VAULT "outflow()(uint256,uint256)" --rpc-url $RH_RPC` and `cast call $VAULT "limits()((uint64,uint128,uint16,uint16,uint32,uint128))" --rpc-url $RH_RPC` (the sixth field is the cap)
2. `probe mm-bot http://mm-bot.railway.internal:8793/state`: `vaultState.outflow` (`usedUsdg6`, `budgetThisTickUsdg6`, `plannedThisTickUsdg6`, `blocked`) and `quoting.capped` for the `outflow` entries
3. `data.used` against the bot's own trading: `recentFills` and `lastTxs` in `/state`. A level the bot's own bids do not explain is `v2_mm_outflow_foreign` (§V11l), not this

→ Expected while the bot quotes near the cap: nothing to do, the bucket refills. Persistently binding with
small quotes: the cap is set too low for the book the bot is asked to make — the admin raises
`maxDailyOutflow` (`setLimits`, all six fields) or `MM_BID_UNITS` comes down. Never raise the cap to clear a
`v2_mm_outflow_foreign`.

### §V11l `v2_mm_outflow_foreign` — P1 (error)
The vault's outflow bucket is `data.over` USDG base units above everything this bot's own booked calls
account for. Only `QUOTER_ROLE` and the admin can move it, so **USDG left the vault through a call this bot
did not send**: a second key on `QUOTER_ROLE`, an admin action, or a compromised quoter key. Treat as a key
compromise until owned (`incident-v2.md` §4c, §5).

1. `cast logs --address $BOOK "OrderPlaced(uint256 indexed orderId, address indexed maker, uint256 indexed longId, uint8 kind, uint128 price, uint64 units, uint40 validUntil)" --from-block <recent> --rpc-url $RH_RPC`, filtered to the vault: are there bids the bot's `/state` does not list?
2. `cast call $VAULT "getRoleMemberCount(bytes32)(uint256)" $QUOTER_ROLE --rpc-url $RH_RPC` and the `RoleGranted` logs (`v2_mon_config_changed`): who else holds it?
3. `probe mm-bot http://mm-bot.railway.internal:8793/state`: `vaultState.outflow.projection` (what the bot expected) against `usedUsdg6` (what the chain says)

→ Kill the bot (§V11, it cancels everything and only credits), then `revokeRole(QUOTER_ROLE)` on the foreign
key, then `setLimits(..., maxDailyOutflow 0)` as an on-chain spend freeze that still allows unwinding. An
admin action the rota took on purpose: expected, note it and move on.

### §V11h `v2_pricer_no_role` — P2 (error)
The pricer's key does not hold `PRICER_ROLE` on the `AutoRoller` (`data.signer`, `autoRoller`): nothing
is sent, and every smart-pricing ask keeps its last price (inside its writer's band).

1. `cast call $ROLLER "hasRole(bytes32,address)(bool)" $PRICER_ROLE $PRICER --rpc-url $RH_RPC`, and `data.signer` against `$PRICER`
2. `cast logs --address $ROLLER "RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)" --from-block <recent> --rpc-url $RH_RPC`: who revoked it, and when
3. `v2_mon_config_changed` on the `AutoRoller` in the channel

→ Revoked by the rota (an `incident-v2.md` §4b response): expected; stop the service. Never granted
after a deploy or rotation: the admin grants it (`incident-v2.md` §4b step 4). Nobody owns the revoke:
**P1**, `incident-v2.md` §5.

### §V11i `v2_pricer_fair_unavailable` — P2 (warn)
A live, due smart-pricing ask (`data.ticker`, `writer`) has had no fair value for
`PRICER_FAIR_ALERT_S` (2 h; `data.since`): the pricing service is down or answers `fair: null`
(`data.reason`). The ask keeps its last price.

1. `probe pricing http://pricing.railway.internal:8790/health`
2. `probe pricer http://pricer.railway.internal:8794/state`: `pairs[]` for the writer (`outcome`, `detail`, the series)
3. `probe pricing "http://pricing.railway.internal:8790/fair?ticker=$T&strike=<6dp>&expiry=<unix>&type=call"` for that series: the `reason`

→ §V12. Cboe dark outside the session is expected and ends at the open; nothing to undo.

### §V11j `v2_pricer_reprice_failed` — P2 (error / warn)
A due `AutoRoller.reprice` of ask `data.orderId` to `data.price` did not go through (`data.status`:
`reverted` or `unconfirmed` go out as error, `simulation-reverted` or `send-failed` as warn). The ask
keeps its old price and the next tick tries again.

1. `cast run <data.hash> --rpc-url $RH_RPC` (on chain), or `probe pricer http://pricer.railway.internal:8794/state` `pairs[].tx` (`revert`, `error`)
2. `cast call $ROLLER "position(address,address)(uint256,uint256,uint40)" <data.writer> <data.underlying> --rpc-url $RH_RPC`: is `data.orderId` still the live ask (a roll or a fill in between)?
3. `cast call $ROLLER "strategy(address,address)((bool,bool,bool,uint16,uint16,uint16,uint16,uint64))" <data.writer> <data.underlying> --rpc-url $RH_RPC`: `active`, `smartPricing`, `minAskBps` / `maxAskBps`

→ A race with a roll or a fill clears on the next tick. `NotAuthorized`: §V11h. `StaleSpot`: §V9 check
2. `gasUsed` at the fixed 600k limit (`pricer/pricer.ts` `GAS_REPRICE`; 251k measured): an out-of-gas.
`RepriceDropExceeded(current, proposed, floor)`: the proposed ask is more than a quarter below the live
one — SEC-13's per-call cap (below). The pricer's own engine never proposes that, so it means the ask
moved between the pricer's read and its send (a roll, a partial fill, another reprice): the next tick
re-reads and tries again. `BadPrice` with a price under 0.5 % of spot: the compiled floor `MIN_ASK_BPS`
(below) — the writer's `minAskBps` cannot go under it.

**SEC-13, owner ruling 2026-09-22 (T-OP-063, callhouse-contracts `src/v2/AutoRoller.sol`).** `reprice`
is bounded twice, both compiled: every ask sits on `MIN_ASK_BPS = 50` (0.5 % of spot; it was 5, a
twentieth of a percent) as the floor of every writer's `[minAskBps, maxAskBps]` band, and one call may
LOWER an ask by at most `MAX_REPRICE_DROP_BPS = 2_500` of the price it replaces, reverting
`RepriceDropExceeded(current, proposed, floor)` past it; raising is not bounded. What a leaked
`PRICER` key can and cannot do now: it cannot put an ask under 0.5 % of spot, and it cannot get from
the default 150 bps ask to the 50 bps floor in one call — the cap is relative to the ask as it is NOW,
so that takes `ceil(log(50/150) / log(0.75))` = four calls, each an on-chain `Repriced` event, each a
tick apart if the key waits for nothing. Premium is what is at stake; principal is not (the ask is
still an ask). **What pages: nothing, on the reprices themselves.** `v2_pricer_reprice_failed` is the
pricer reporting its OWN sends; a stranger's key sends from elsewhere and the monitor does not scan
`AutoRoller.Repriced` (T-OP-082 measured: no `Repriced` in `ops/v2/monitor.mjs`). The first sign is a
writer's ask visibly stepping down on the book, or `v2_mon_config_changed` if the key holder also
touches strategy. **Operator action:** revoke `PRICER` from the key through `OPS_ADMIN` (delay 0,
Admin Safe): `incident-v2.md` §4b (the pricer's own section; §4a is the cranker's `BUYBACK` revoke,
the same shape), then rotate the key (`incident-v2.md` §4d, `ops/v2/derive-bot-keys.sh`) and re-grant. Four calls is the budget the cap buys you; the revoke
is what spends it well.

## Services that send nothing — first three checks

### §V12 `pricing` (no alerts)
`GET /health` on `PRICING_PORT` (8790): `status: ok`, or `degraded` when any ticker's Cboe chain did
not load (`chains.<T>.error`). `/fair` answers `{ fair: null, reason }` on bad market data (reasons in
`status/INTERFACE-CHANGES.md` "Pricing service"). Nothing on chain depends on it: the MM bot and the
pricer stop quoting and repricing on `null`.

1. `probe pricing http://pricing.railway.internal:8790/health`
2. `probe pricing "http://pricing.railway.internal:8790/fair?ticker=NVDA&strike=<6dp>&expiry=<unix>&type=call"`: the `reason`
3. `curl -s -o /dev/null -w '%{http_code}' https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json`

→ Cboe dark on a weekend or holiday is expected; `spot-stale` outside the session too.

### §V13 `notifier` (no alerts)
`GET /health` on 8791 always answers 200 while the process serves: `status` (`degraded` when the
database does not answer in 2 s), `channels.{telegram,webpush,email}` (`closed`, `open` = the breaker
tripped after 5 failures, `half-open`, `off`), `telegramBot`, `rules.{status,lastSuccessAt,
consecutiveFailures}` (`failing` when the indexer poll keeps failing). User notifications only:
nothing operator-facing goes through it.

1. `probe notifier http://notifier.railway.internal:8791/health`
2. `railway logs --service notifier`: `circuit breaker opened` (with the channel's error code), `rules poll failed`
3. For rules: `probe indexer-v2 http://indexer-v2.railway.internal:42069/v2/health` (the notifier reads the indexer)

→ One replica only (Telegram long-poll). A breaker reopens on its own; a permanently open email
channel is usually the SMTP credential.

### §V14 `relay` (no alerts about itself)
The relay is the transport: when it is broken, **every** alert is silent. `GET /health` answers
`{"status":"ok","targets":[…]}` whether or not Discord or Telegram accept anything. A POST answers 200
if at least one target accepted, 502 when all refused, 401 on the token, 400 on the shape.

1. `probe relay http://relay.railway.internal:8080/health` (targets listed?)
2. `railway logs --service relay`: the relay logs one line per POST, not per target. `alert relayed`
   at **warn** level carries `failed:[{target,status,error}]` beside `delivered:[…]` — that is one
   channel down while another still works. `alert NOT delivered: every target failed` at **error**
   level is the 502. Search for `alert NOT delivered` first, then `"failed":[{` (there is no
   `target refused` line; the relay has never logged one)
3. The weekly test (`ops/deploy.md` §12.4): one info alert, seen in the channel

→ The monitor exits **4** when the relay refuses or cannot be reached (a failed cron run in Railway's
UI) and retries the alert on its next run; the bots retry every 5 min. Neither can page you about the
relay through the relay, so the out-of-band signal is the process dying: an always-on monitor gives up
with exit 4 after `--max-failed-passes` consecutive passes that reached nobody (default 3, so about
3 min at `--interval 60`), and a cron monitor shows failed runs. Either way Railway's deploy
notifications (email) are the channel that reaches you.

### §V15 `indexer-v2` (no alerts)
Ponder reserves `/health` and `/ready` (ready only after the historical sync: right for deploys, wrong
for lag). `GET /v2/health`: `status: ok` (lag ≤ 120 s), `lagging`, or 503 `degraded` (no indexed
head), `block`, `lagSeconds`. Chain state is unaffected; the web app's history and the cranker's holder
lists go stale (the cranker falls back to its own log index).

1. `probe indexer-v2 http://indexer-v2.railway.internal:42069/v2/health`
2. `cast block-number --rpc-url $RH_RPC` against `block`
3. Is `PONDER_RPC_URL_4663` an archive endpoint (`ops/deploy.md` §15.4)? The public RPC refuses historical calls

## §V16 Every v1 keeper kind (`keeper/src/alerts.ts`)

The v1 factory keeper (`keeper/src/solo.ts`) keeps running in run-off until its last account settles
(`ops/runbooks/v1-runoff.md`). The pooled-vault kinds come from `keeper/src/roll.ts`, which serves the
closed pooled vault only. In run-off (`SOLO_WIND_DOWN=1`) the factory never calls `setWeek` or `listFor`.

| kind | severity | Emitted by | In run-off | Runbook |
|---|---|---|---|---|
| `tx_revert` | error | factory, pooled vault | yes (`settle`) | §1 |
| `keeper_error` | error | both (`main-v1.ts`) | yes | §5 |
| `low_gas` | warn | both | yes | §8 |
| `rpc_lag` | warn | both | yes | §9 |
| `oracle_paused` | warn | both | yes | §6 |
| `boot` | info (warn without `KEEPER_ROLE`) | both | yes | — |
| `keeper_role` | warn | factory | yes: settling needs no role, so a missing role in run-off is harmless | §22 |
| `v1_settle_held` | warn | factory | yes: `settle()` withheld while USDG / Stock Token gates are shut | table above; `v1-runoff.md` step 8; `incident.md` §5 |
| `v1_drained` | info | factory | yes: once per factory when nothing is live or pending | `v1-runoff.md` |
| `week_set` | info | factory | no (no `setWeek`) | — |
| `cycle_not_created` | warn | factory, pooled vault | no | §10 (`no_rung`) |
| `fill_sim_revert` | warn | pooled vault | no (closed) | §3 |
| `claim_stranded` | error | pooled vault | no (closed) | §2 |
| `strand_retry_failed` | warn | pooled vault | no (closed) | §2 |
| `strand_recovered` | info | pooled vault | no (closed) | §2 |
| `phase_stuck` | error | pooled vault | no (closed) | §4 |
| `option_type_failed` | error | pooled vault | no (closed) | §1 |
| `fee_switch` | warn | pooled vault | no (closed) | §7 |
| `valorem_fees_enabled` | warn | pooled vault | no (closed) | §7 |
| `roll_open` | info | pooled vault | no (closed) | — |
| `listing` | info | pooled vault | no (closed) | — |
| `fill` | info | pooled vault | no (closed) | §13 |
| `queue_settled` | info | pooled vault | no (closed) | — |
| `roll_close` | info | pooled vault | no (closed) | payload section |

## §V17 Running the monitor

`ops/v2/monitor.mjs` needs node 22+ and viem from the workspace (`pnpm install` at the root, or the
keeper image). It reads the registry's `v2` blocks: contract addresses, the deploy block, and for the
feed / token / pool checks the markets whose `v2.status` is `live` or `paused`, **plus any other registry
market the Clearinghouse has registered** (`Clearinghouse.market(asset).strikeTick != 0`): a market open to
users while the baked registry still calls it `planned` is watched anyway, and a note says the registry is
behind. `--all-markets` adds every `planned` market, `--tickers` picks and turns the chain check off; for
the `pins` check every registry market registered on the Clearinghouse
(`--tickers` narrows it) and the registry's `v2.defaults` / `v2.overrides`. Before the v2 deploy
(`v2.contracts` null) it runs the third-party checks only. It never signs anything: the pin dry run is an
`eth_call` from the Clearinghouse's address, so the RPC must accept a call whose `from` is a contract
(geth and Nitro do), and `shared.multicall3` must have code for the bulk reads (without it they fall back
to plain calls, eight at a time).

```bash
# one pass, the way a cron job runs it. On the monitor service both variables are already set; by hand,
# read the token in rather than typing it on the line (it would land in the shell history and in `ps`):
read -rs ALERT_WEBHOOK_TOKEN && export ALERT_WEBHOOK_TOKEN
ALERT_WEBHOOK=http://relay.railway.internal:8080/alert \
MONITOR_STATE_PATH=/data/monitor-v2.json \
MONITOR_HEALTH=cranker=http://cranker.railway.internal:8792/health,mm-bot=http://mm-bot.railway.internal:8793/health,pricer=http://pricer.railway.internal:8794/health,pricing=http://pricing.railway.internal:8790/health,notifier=http://notifier.railway.internal:8791/health,indexer-v2=http://indexer-v2.railway.internal:42069/v2/health,relay=http://relay.railway.internal:8080/health \
node ops/v2/monitor.mjs --once --rpc $RH_RPC; echo "exit $?"

# always on, every 60 s (a plain service). After --max-failed-passes consecutive passes that reached
# nobody (default 3, about 3 min here) it exits, so the platform restarts it and notifies; 0 loops for ever.
node ops/v2/monitor.mjs --rpc $RH_RPC --interval 60

# a devnet (the gate: ops/v2/monitor-devnet.mjs brings one up, provokes findings, checks dedupe)
node ops/v2/monitor.mjs --once --rpc http://127.0.0.1:8546 --registry ops/devnet/tier1.devnet.json

# with the pricing checks (§V49-§V51). BASE urls, not /health: the monitor appends /health,
# /surface/:ticker, /fair and /state itself, and every one of them is a read-only GET.
MONITOR_PRICING_URL=http://pricing.railway.internal:8790 \
MONITOR_PRICER_URL=http://pricer.railway.internal:8794 \
node ops/v2/monitor.mjs --once --rpc $RH_RPC
node ops/v2/monitor.mjs --once --rpc $RH_RPC --pricing http://127.0.0.1:8790 --pricer http://127.0.0.1:8794 --no-alerts --json
```

| Exit (`--once`) | Meaning |
|---|---|
| 0 | every check ran, nothing warn/error open |
| 1 | at least one warn/error finding open (new, or already paged) |
| 2 | bad usage, an unreadable registry, or an RPC serving another chain id |
| 3 | a check could not complete (RPC down, a read failed, the first log scan still catching up) |
| 4 | an alert could not be delivered (retried next run) |

In `--interval` mode those codes are per pass and the loop carries on, with one exception: after
`--max-failed-passes` (`MONITOR_MAX_FAILED_PASSES`, default 3) consecutive passes that **reached
nobody** — a delivery the relay refused, or a pass that threw before it could send anything — the
process exits with that pass's code so the platform restarts it and notifies. A pass that exits 3 and
delivered its `v2_mon_check_failed` does not count, so the catch-up runs after a deploy never trip it.

**State.** The dedupe memory, the log-scan cursor, the series and holder index, the feed / Safe
baselines and the adopted admin history live in one JSON file (default
`ops/v2/state/monitor-<chain>-<clearinghouse>.json`, gitignored). **Lose it and the monitor re-pages
every open condition once and re-scans from the deploy block**; admin events before the new first run
are adopted silently. On Railway the file must be on a volume. The file resets itself when the chain,
the Clearinghouse or the deploy block changes, or the block it anchored to last run is gone (a reorg or
a restarted devnet).

**Thresholds** (`--threshold name=value`, `MONITOR_THRESHOLDS`, defaults in `DEFAULTS`): `lateS` 7200,
`overdueGraceS` 900, `backlogS` 21600, `rewardsMinExpiries` 20, `vaultLimitPct` 90, `vaultOutflowWarnPct`
50, `vaultOutflowErrorPct` 90 (§V45), `vaultMinUsdg`
100, `vaultMinShares` 1, `rollerStaleS` 60 (§V46), `roundJumpBps` 500, `feedStaleMarginS` 3600,
`feedReopenGraceS` 900 (0: no reopen
warning), `lagWarnS` 60, `lagErrorS` 900, `repeatS` 21600 (also
`--repeat-hours`), `logChunkBlocks` 10000, `maxRangesPerRun` 200, `tokenLookbackBlocks` 100000, `pinCheckS`
900 (how long the `pins` check serves its last reads, §V43), `pricingTimeoutMs` 8000, `pricingProbes` 24
(`/fair` probes per pass, 0 = none), `pricingConcurrency` 4, `pricerIdleS` 900 (§V51, 0 = never), and the
source-age limits `quoteAgeS` / `underlyingAgeS` / `volatilityAgeS`, all 0 — **the age is reported, nothing
pages** until an operator sets one from a measured session (§V50).

**The hand-written ABIs, and why they are checked.** The monitor decodes `series()`, `market()`,
`limits()` and (INTERFACE_VERSION 8) `routes()` from positional tuples written out in
`ops/v2/monitor.mjs`, not from `ops/abis/v2`. v7 **appended** a field to each of the first three
(`Series.mintFeePpm` / `mintFeesHeld`, `MarketConfig.mintFeePpm`, `Limits.maxDailyOutflow`) and changed
six event topic0s, so a monitor left on the v6 strings does not fail against a v7 deployment — **it stops
seeing those events and reads the new returns wrong, and its alerts go quiet**.

INTERFACE_VERSION 8 adds the sharpest case of this the codebase has. `IPayoutRouter.routes(address)` and
`UniV3PayoutAdapter.routes(address)` are the **same selector `0xd7409659`** and return **different
tuples** — `(uint8 venue, uint24 fee, int24 tickSpacing, address v3Pool, uint16 feeBps)` against
`(address pool, uint24 fee)` — and `v2.contracts.payoutAdapter` names the router from interface 8 and the
adapter before it. Decoding the router's answer with the adapter's list **succeeds**: it reads the venue
enum as a pool address and reverts nothing. So the monitor identifies the contract before it decodes
(only the adapter answers `factory()`) and stops the route checks on a disagreement (§V58), and the
parity suite pins both halves: the selectors must be equal and the return tuples must not be.

`node --test ops/v2/monitor.test.mjs` compares every hand-written tuple with the exported ABI, every
scanned event signature with the contract that emits it, and the v7 and v8 event topics with the
signatures in the file. It also fails when a view list is added to `ABI_TEXT` and named in neither the
"ours" nor the "third-party" list, because a parity suite that silently checks nothing is worse than no
parity suite. **It runs in CI** (`.github/workflows/ci.yml`, the `ops` job) alongside
`node --test ops/runbooks.test.mjs`, `build-markets.mjs --check` and `v2-env.mjs --check`, so the next
drift fails on the pull request rather than in production.

**Railway** (owner-gated; `ops/deploy.md` §15.12): the keeper image carries the script and viem.

## Monitor kinds — first three checks

### §V20 `v2_mon_settlement_late` — P1 (error) / P2 (warn)
An expiry with open interest is not finalized 2 h after expiry. **error**: no candidate at all, or a
candidate 15 min past `finalizableAt` still Pending (nobody calls `finalize`). **warn**: a market with
two or more sources is waiting an uncorroborated candidate's delay. The same key escalates warn →
error when the delay passes unfinalized.

1. `settlementInfo`, `candidate`, `recordedSources` (prelude): which row of `incident-v2.md` §2's table
2. `cast call $UNI_SRC "snapshots(address,uint40)(uint128,int24,uint40)" $ASSET $E --rpc-url $RH_RPC` and the Chainlink `windowPrice`
3. `--health cranker` / `probe cranker http://cranker.railway.internal:8792/health`: is the cranker alive?

→ `incident-v2.md` §2 (error), §1 (warn: check the candidate against the reference).

### §V20a `v2_mon_series_unsettled` — P1 (error)
The oracle finalized the expiry, so settlement is not late, but the Clearinghouse has not settled all of
its series an hour later (`data.unsettled` lists the long ids, `data.seriesCount` how many the expiry
has). Every `redeem` of those series reverts `NotSettled`: the price is fixed and the holders are stuck.
The usual cause is the cranker dying between `finalize` and `settle`; `v2_mon_redeem_backlog` never
fires for these series, because it only counts series that emitted `SeriesSettled`.

1. `cast call $CH "series(uint256)((address,bool,uint40,uint128,address,uint16,bool,uint128,uint128,uint128,uint128,uint32,uint128))" <data.unsettled[0]> --rpc-url $RH_RPC`: field 7 `settled`
2. `probe cranker http://cranker.railway.internal:8792/health` and `railway logs --service cranker` around the finalize
3. `cast call $ORACLE "settlementInfo(address,uint40)(uint8,uint256,uint8,bool,bool,bool)" $ASSET <data.expiry> --rpc-url $RH_RPC`: status 2 (Finalized) with a price

→ `incident-v2.md` §2 step 3: `settle(longId)` per id with the fixed gas limit, then prune and
`redeemBatch`. The alert resolves on the next pass once every series is settled.

### §V21 `v2_mon_sources_disagree` — P2 (warn)
The monitor's copy of §V6, keyed by `finalizableAt` (a new candidate pages again).

1. `candidate` and `recordedSources` (prelude)
2. The reference price (`incident-v2.md` "The independent price")
3. `data.candidate.finalizableAt` against `cast block latest -f timestamp --rpc-url $RH_RPC`: the time left

→ `incident-v2.md` §1.

### §V22 `v2_mon_settlement_held` — P1 (error)
The monitor's copy of §V7, for as long as it holds. A veto you just sent pages here: that is the
confirmation.

1. `settlementInfo` (status 3)
2. The `SettlementVetoed` log: who vetoed (a veto nobody owns is `incident-v2.md` §5)
3. `data.resolvableAt` (`E + 48 h`) and `resolveBand`

→ `incident-v2.md` §1 step 5.

### §V23 `v2_mon_snapshot_missed` — P2 (warn, event)
The pool is one of the expiry's sources, `E + 600` has passed and `snapshots(underlying, E)` recorded
nothing. Paged once; the window cannot be recorded afterwards.

1. `cast call $UNI_SRC "snapshots(address,uint40)(uint128,int24,uint40)" $ASSET $E --rpc-url $RH_RPC`
2. `v2_snapshot_missed` / `v2_rpc_lag` / `v2_error` from the cranker around `E`; `v2_mon_l2_lag` (a stalled chain)
3. `candidate`: the Chainlink-only candidate and its `finalizableAt`

→ Check that candidate against the reference before it finalizes (`incident-v2.md` §1).

### §V24 `v2_mon_redeem_backlog` — P2 (warn)
Six hours after `SeriesSettled`, the monitor still counts holders it indexed from the Clearinghouse's
transfer logs with a non-zero balance, third-party redemption allowed and a non-zero payout on that side
(`data.long` / `data.short`: holders, units), or the OrderBook still escrows longs (`data.bookUnits`).
Opted-out holders are counted in `data.optedOut` and are not a backlog.

1. `cast call $CH "series(uint256)((address,bool,uint40,uint128,address,uint16,bool,uint128,uint128,uint128,uint128,uint32,uint128))" <data.longId> --rpc-url $RH_RPC`
2. `probe cranker http://cranker.railway.internal:8792/state` (the redeem step) and `v2_redeem_backlog` from it
3. Book escrow: `cast call $CH "balanceOf(address,uint256)(uint256)" $BOOK <longId> --rpc-url $RH_RPC`

→ `incident-v2.md` §2 step 3 (prune, then `redeemBatch`).

### §V25 `v2_mon_rewards_budget_low`, `v2_mon_rewards_cap` — P2 (warn)
Budget: KeeperRewards' USDG balance ÷ bounty spend per expiry < 20. Spend per expiry is observed
(`Rewarded` amounts over the last 20 finalized expiries, once 3 are known) or modelled from the bounty
table (1 SNAPSHOT + 2 FINALIZE + 10 SETTLE + 20 REDEEM). `data.basis` says which. Across all markets:
with 35 markets on dailies, 20 expiries is about half a day. Cap: `dailyCap()` is 0 (the deploy
default; nothing is paid) or the rolling 24 h spend reached it.

1. `cast call $USDG "balanceOf(address)(uint256)" $REWARDS --rpc-url $RH_RPC`
2. `cast call $REWARDS "dailyCap()(uint256)" --rpc-url $RH_RPC` and `"spentToday()(uint256)"`
3. `cast call $REWARDS "bounty(bytes32)(uint256)" $(cast keccak SETTLE) --rpc-url $RH_RPC` (and SNAPSHOT, FINALIZE, REDEEM, ROLL)

→ Fund it (`approve` then `fund(uint256)`, anyone may). Lifecycle calls never fail for lack of budget;
keepers just stop being paid. A cap hit every day means the cap is below a normal day.

### §V26 `v2_mon_vault_limit`, `v2_mon_vault_inventory_low` — P2 (warn)
Limits: `totalNotional()` at 90 % of `maxTotalNotional`, a tracked series' `exposure().units` at 90 %
of `maxSeriesUnits`, or 15 live orders on a series (the contract allows 16). Quotes that grow exposure
then revert `CeilingExceeded`. Inventory: USDG in the vault's wallet plus its free Clearinghouse
ledger under 100, or under 1 share of a Stock Token it quotes.

1. `cast call $VAULT "limits()((uint64,uint128,uint16,uint16,uint32,uint128))" --rpc-url $RH_RPC` and `"totalNotional()(uint256)"`
2. `cast call $VAULT "exposure(uint256)(uint256,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))" <longId> --rpc-url $RH_RPC`
3. `cast call $CH "free(address,address)(uint256)" $VAULT $USDG --rpc-url $RH_RPC` and `cast call $USDG "balanceOf(address)(uint256)" $VAULT`

→ A risk decision, not an outage: the treasury funds the vault (`deposit`) or raises limits
(`setLimits`, admin: a `v2_mon_config_changed`). Exposure far above the MM bot's own caps looks like a
quoter key misbehaving: `incident-v2.md` §4c.

### §V27 `v2_mon_config_changed` — P1 (error) / P2 (warn), event
An admin or guardian event on a v2 contract since the monitor's first run. **error**: `RoleGranted`,
`RoleRevoked`, `RoleAdminChanged`, `MarketConfigured`, `FeedSet` (Chainlink), `PoolSet`,
`MarketConfigSet`, `CalendarSet`, `PayoutAdapterSet`, `FeeRecipientSet`, `CallerSet`, `Defunded`,
`Withdrawn` (MakerVault), `PositionWithdrawn`, `SettlementResolved` (`adminResolve`). **warn**:
`MarketRegistered`, `KeeperRewardsSet`, `FeeParamsSet`, `MakerRegistrySet`, `TierSet`,
`TradingPausedSet`, `CreatePausedSet`, `MintPausedSet`, `SettlementVetoed`, `SettlementUnvetoed`,
`BountySet`, `DailyCapSet`, `MinRollUnitsSet`, `LimitsSet`, `HolidaySet`, `SpecialExpirySet`,
`RootSet`, `MinRedeemPayoutSet`, `BaseUriSet`. Role hashes are named in the message. The
INTERFACE_VERSION 6 wiring events page as their own kinds instead: `FeeParamsScheduled` (§V38),
`RouteSet` (§V39), `OracleSet` and `ClearinghouseSet` (§V40), the pin logs (§V41), Data Streams
`FeedSet` (§V42). A `MarketConfigured`, `FeedSet` or `PoolSet` reaches only expiries without series:
the first series after it pins the new configuration, which §V43 then compares with the registry.

1. `cast tx <data.transactionHash> --rpc-url $RH_RPC`: `from` is our admin / guardian address?
2. Is it on the owner's plan for today (a wave's `RegisterMarkets`, a rotation, a limits change)?
3. The resulting state, e.g. `marketConfig(address)` for a `MarketConfigured`, `hasRole` for a role event

→ Planned: acknowledge, nothing else. Not planned: `incident-v2.md` §5, now.

### §V28 Feed proxy and owner: `v2_mon_feed_mismatch` (error), `v2_mon_feed_aggregator_changed` (warn, event), `v2_mon_feed_access_controller` (error), `v2_mon_feed_owner_changed` (warn, event), `v2_mon_safe_nonce_changed` (info, event), `v2_mon_safe_config_changed` (warn, event)
The settlement oracle reads a Chainlink **proxy**; its owner (for NVDA and TSLA the Safe
`0xeE27D5Ae494300902D90454e8630A3F1C68c9C52`, 4 of 9 owners, read on chain every run) can switch the
aggregator (a new phase: a Chainlink walk never crosses one, so a window straddling the switch has no
Chainlink price) or install an access controller (refused reads: no Chainlink price, no spot). The
Safe owns many feeds: its nonce moves for all of them, hence info. A mismatch means
`ChainlinkFeedSource.setFeed` pointed a market somewhere the registry does not know.

1. `cast call $FEED "aggregator()(address)" --rpc-url $RH_RPC`, `"accessController()(address)"`, `"owner()(address)"`, `"phaseId()(uint16)"`
2. `cast call $CL_SRC "feeds(address)(address,uint32,uint16)" $ASSET --rpc-url $RH_RPC` against the registry's `feed`
3. `cast call 0xeE27D5Ae494300902D90454e8630A3F1C68c9C52 "nonce()(uint256)" --rpc-url $RH_RPC`, `"getThreshold()(uint256)"`, `"getOwners()(address[])"`; the Safe's transaction on the explorer

→ Aggregator switch: check the next settlement windows of that market (`incident-v2.md` §1; a
two-source market corroborates on the pool). Access controller: `incident-v2.md` §2 for every market on
that feed. Mismatch: `incident-v2.md` §5. Then record the new aggregator in the registry
(`feedAggregator`) so a restarted state does not page it again.

### §V29 `v2_mon_feed_round_jump` — P2 (warn, event)
A round moved more than 5 % from the one before it (`data.bps`). The source's own jump bound is 20 %
(`maxRoundJumpBps`): this is an early warning inside it. A stock split or multiplier step, a real move,
or a bad print.

1. `cast call $FEED "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" <data.roundId> --rpc-url $RH_RPC` and the round before
2. `cast call $ASSET "uiMultiplier()(uint256)" --rpc-url $RH_RPC`, `"newUIMultiplier()(uint256)"`, `"effectiveAt()(uint256)"`
3. The underlying's real price move (the reference); the next expiry of that market

→ A bad print inside a settlement window: `incident-v2.md` §1 (veto the candidate if it uses it).

### §V30 `v2_mon_token_paused` (error), `v2_mon_oracle_paused` (warn)
`paused()`: the Stock Token (or its registry) stops every transfer of it. `oraclePaused()`: the
Chainlink source and `spot` fail closed; rolls and vault quoting stop; a settlement captured now rests
on the pool alone as a delayed candidate.

**THE ISSUER'S BRAKE DOES NOT FULLY BRAKE POOL-SOURCED SETTLEMENT** (T-SEC-OPS-LAUNCH-PARAMS, from
V8-SECURITY-VULNS.md 2026-09-20; re-derived at callhouse-contracts `v8` =
`3d36fcb31f95383e4af55f12063bf5af164b0336`). `oraclePaused()` is honoured by the sources that read a
feed and by `spot` — `ChainlinkFeedSource` (`:183`, `:215`, `_oraclePaused` `:320`),
`DataStreamsSource` (`:367`, `:494`, `:588`) and `SettlementOracle._spot` (`:849`, which returns
`SPOT_NO_SOURCE` and so reverts `StaleSpot`/`NoSource` upstream). **`UniV3TwapSource` does not read it
at all** — the string `oraclePaused` does not occur once in
`src/v2/oracle/UniV3TwapSource.sol`, against five occurrences in `ChainlinkFeedSource.sol`. So during
an issuer halt:

- quoting, rolls and every `_checkPrice`/`_floorPrice` consumer stop, because they go through `spot`;
- but `UniV3TwapSource.record` can still snapshot the `[expiry - 1800, expiry]` window and
  `windowPrice` still serves it, so **a pool snapshot alone can still become a settlement candidate
  while the issuer says its price is not to be trusted**;
- the only thing standing between that candidate and a finalized price is the **veto window** — a
  single uncorroborated source waits out `uncorroboratedDelay` (`SettlementOracle.sol:201`,
  `DEFAULT_UNCORROBORATED_DELAY = 6 hours`), and the guardian must actually use it.

That makes it a **human dependency, not a contract guarantee**. When `v2_mon_oracle_paused` fires and
the market has an expiry inside the halt, treat the veto as an action you owe, not a safety net that
acts on its own. Accepted risk, recorded here rather than fixed: see the register half,
`T-SEC-ACCEPTED-RISKS-RUNBOOK` in the contracts repository.

**The two numbers, re-confirmed 2026-09-22 (SEC-21b with T-OP-030 F-6's consequence; contracts
`docs/V8-ACCEPTED-RISKS.md` SEC-21b "Operator action" points here).** On the launch pair (NVDA, SPCX —
the only two markets with a pool source) an expiry captured during an issuer halt has exactly one ok
recorded price, the pool's. Left alone it **finalizes on that pool price `DEFAULT_UNCORROBORATED_DELAY`
= 6 h after the candidate is announced** (`SettlementOracle.sol` `DEFAULT_UNCORROBORATED_DELAY`,
`data.finalizableAt` in the `v2_sources_disagree` (§V6) and `v2_mon_settlement_late` (§V20) payloads) unless the GUARDIAN vetoes it first —
**`veto(address underlying, uint40 expiry)`, GUARDIAN, delay 0**, from the guardian hot key or the Admin
Safe (a GUARDIAN member); `unveto(address,uint40)` is the same lane. And a veto does not make the pool
price go away: a Held expiry with one ok recorded price is what `adminResolve` (CONFIG_ADMIN, 24 h lane)
is bounded by — inside the pinned deviation band around that pool price from `expiry + 48 h`, and only
from **`expiry + 7 days`** (`HELD_RESOLVE_DELAY`) inside a factor of 1.25 either way — so for a week the
admin's resolution **follows the pool leg**, and it is the pool leg the issuer said not to trust. The
veto therefore buys the week in which a corroborating source (the feed coming back) can be waited for;
it does not buy a free choice of price. Whether the issuer has ever halted `oraclePaused()` inside a
session on 4663 is T-OP-052's question, running at the time of writing; until it reports, plan for the
halt as reachable.

1. `cast call $ASSET "paused()(bool)" --rpc-url $RH_RPC`, `"oraclePaused()(bool)"`, `"tokenPaused()(bool)"`
2. `cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC`: is Chainlink still publishing?
3. The market's next expiry with open interest (`openInterest(address,uint40)`)
4. **Is a pool snapshot already recorded for an expiry inside the halt?** If the market has a UniV3
   source, check `pinnedBy(underlying, expiry)` and the oracle's candidate state for that expiry; a
   recorded snapshot starts the veto clock whatever `oraclePaused()` says.

→ `incident-v2.md` §6 (paused), §2 (oracle paused across an expiry).

### §V30a `v2_mon_oracle_halted` (error) — the issuer halted a LAUNCH token's oracle: page from the log, not the poll
The Stock Token emitted `OraclePaused()` (topic0
`0xe28b7053f432ae5400c6168140cbe15638399715519a0a39b16b505fb9fc9d9a`, `keccak256("OraclePaused()")`; the
counterpart `OracleUnpaused()` is `0xa274116fec684497d55e11cc9516edaa8d206c8b5f84c4603e32572c37f8e6dd`, both
re-derived by the monitor from the signatures with viem and pinned in `monitor.test.mjs`) for one of the launch
tokens named by `--launch` (default `NVDA,SPCX`; the addresses are the registry rows' `asset`). §V30's
`v2_mon_oracle_paused` polls the `oraclePaused()` FLAG once a pass and cannot see a halt that starts and ends
between two polls; this one reads the EVENT over the same bounded `eth_getLogs` scan as `UIMultiplierUpdated`
(first run: `tokenLookbackBlocks`, never below the registry's `v2.deployBlock`; then its own cursor with the
reorg overlap — T-OP-009's whole subject was an unbounded scan, so there is none here). The page is keyed by the
token, stays one page for the life of the halt, and clears itself (`v2_mon_resolved`) on `OracleUnpaused()`.

**Why it is an error and not §V30's warn.** T-OP-052 measured the whole chain: the event has fired ZERO times
for NVDA and SPCX, so the first one is news. And `Stock.sol` transfers check `paused()`, not `oraclePaused()`, so
during a halt **the pool keeps trading** while the Chainlink source and `spot` fail closed — every settlement
window inside the halt records the pool alone (T-OP-030 F-6, SEC-21b, accepted by the owner 2026-09-22 on the
"never happened" data plus the guardian rota this alert now staffs).

**What the guardian does, in order:**

1. **List every expiry whose `[expiry - 1800, expiry]` window falls inside the halt** for the halted market —
   `pinnedBy(underlying, expiry)` on the SettlementOracle for each live series, or the monitor's settlement
   check output. Each of those windows will produce a Chainlink `windowPrice` of not-ok and a pool snapshot only.
2. **Watch the candidate.** When `finalize` announces an uncorroborated candidate (`v2_mon_sources_disagree` /
   the candidate state on `settlementInfo`), it is the pool-only price and it finalizes after
   `uncorroboratedDelay` (6 h default) unless vetoed.
3. **Veto a pool-only candidate** with `veto(underlying, expiry)` (GUARDIAN, delay 0) BEFORE `finalizableAt`,
   unless the pool price is independently corroborated (a resumed Chainlink round that agrees will corroborate
   on the next `finalize` and finalize regardless of the veto — that is the safe outcome, §V22).
4. When the page clears (`OracleUnpaused()` landed), `unveto` restarts the delay; if the Chainlink source now
   agrees, the settlement corroborates; if it does not, the 7-day Held widening and `adminResolve` apply (§V22).
5. If the page never clears and the token's implementation was upgraded meanwhile (the beacon's `Upgraded`),
   the watch may be blind: check `oraclePaused()` by hand.

→ `incident-v2.md` §2 (oracle paused across an expiry); T-OP-052's method in `docs/V8-ORACLE-HALT-HISTORY.md`
(contracts).

### §V31 `v2_mon_multiplier_updated` (warn; error on a decrease, event), `v2_mon_multiplier_staged` (warn)
The issuer's display multiplier changes the Stock Token's price (balances do not rebase). Staged:
`newUIMultiplier()` differs from `uiMultiplier()` (`data.effectiveAt`: when). Updated: the
`UIMultiplierUpdated` log. The feed can lag the step by its heartbeat, so a window around
`effectiveAt` can mix old and new prices.

1. `cast call $ASSET "uiMultiplier()(uint256)" --rpc-url $RH_RPC`, `"newUIMultiplier()(uint256)"`, `"effectiveAt()(uint256)"`
2. The feed's rounds around `effectiveAt` (§V29 check 1)
3. The market's expiries between now and a heartbeat after `effectiveAt`

→ Watch those settlement windows (`incident-v2.md` §1); the ladders re-centre on their own.

### §V32 `v2_mon_token_blocked` — P1 (error, Clearinghouse) / P2 (warn)
`isBlocked(address)` on the token's `ACCESS_CONTROLLED_REGISTRY()` is true for the Clearinghouse
(collateral stuck, redemptions credit ledgers), the MakerVault (its quoting on that market), the
PayoutAdapter or the market's pool (conversions fall back in kind).

1. `REGY=$(cast call $ASSET "ACCESS_CONTROLLED_REGISTRY()(address)" --rpc-url $RH_RPC); cast call $REGY "isBlocked(address)(bool)" <data.address> --rpc-url $RH_RPC`
2. `cast call $ASSET "paused()(bool)" --rpc-url $RH_RPC` (a full pause instead?)
3. `cast call $ASSET "balanceOf(address)(uint256)" $CH --rpc-url $RH_RPC` (a burn with it?)

→ `incident-v2.md` §6.

### §V33 `v2_mon_usdg_paused` (error), `v2_mon_usdg_frozen` (error for Clearinghouse / OrderBook, warn otherwise)
USDG `paused()` or `isFrozen(<contract>)`. Every contract that holds USDG is checked: Clearinghouse,
OrderBook, KeeperRewards, AutoRoller, PayoutAdapter, MakerVault, RewardsDistributor.

1. `cast call $USDG "paused()(bool)" --rpc-url $RH_RPC` and `cast call $USDG "isFrozen(address)(bool)" <data.address> --rpc-url $RH_RPC`
2. `cast call $USDG "balanceOf(address)(uint256)" $CH --rpc-url $RH_RPC` (a wipe?)
3. USDG `Freeze(address)` logs for our addresses (`cast logs --address $USDG "Freeze(address indexed account)" --from-block <recent> --rpc-url $RH_RPC`)

→ `incident-v2.md` §6.

### §V34 `v2_mon_pool_liquidity_low` — P2 (warn)
The market pool's in-range `liquidity()` is below the registry's `univ3MinLiquidity` (the liquidity at
which the USDG side is about 250k, O2-01). The TWAP source's window check uses the harmonic mean over
the window, so a thin pool at expiry means no pool vote: Chainlink alone after the delay, and converted
payouts more likely to fall back in kind. AAPL, MSFT and QQQ sat at 71-82 % of their floor when the
registry was written.

The page clears only once liquidity is back `poolHysteresisBps` (1000 = 10 %) **above** the floor.
Without that band a pool resting on its floor pages open/resolved/open/resolved every pass: over 24 h of
mainnet swaps the registry floors were crossed 34 times on AAPL, 34 on GOOGL and 18 on QQQ. So a pool
just under its floor keeps one open alert, not a stream of them, and `data.clearAt` is what it must reach.

1. `cast call $POOL "liquidity()(uint128)" --rpc-url $RH_RPC` against `data.floor`
2. `cast call $UNI_SRC "pools(address)(address,bool,uint8,uint32,uint128)" $ASSET --rpc-url $RH_RPC` (the floor the source enforces)
3. `cast call $UNI_SRC "observeWindow(address,uint40,uint40)(bool,uint256,int24,uint256)" $ASSET $(( $(cast block latest -f timestamp --rpc-url $RH_RPC) - 1800 )) $(cast block latest -f timestamp --rpc-url $RH_RPC) --rpc-url $RH_RPC`

→ Persistent: the market is effectively Chainlink-only; treat its candidates as §1 (O2-07 sets
`uncorroboratedDelay` for such markets). `incident-v2.md` §3 for conversions.

### §V34a `v2_mon_pool_wiring` — P1 (error)
The UniV3 settlement source names another pool for this market than the registry does
(`data.sourcePool` vs `data.registryPool`), or holds a minimum liquidity below the registry's
(`data.sourceFloor` vs `data.registryFloor`, 0 meaning no window is ever rejected for thinness). The
source's values are the ones that count: every expiry pinned from now on takes them, and the payout
route follows the pool. `v2_mon_config_changed` announces the `PoolSet` that did it, but only while the
log is in the scanned range — a first run, a reset or a lost state file adopts it silently, so this
check stands whether or not the event was seen.

1. `cast call $UNI_SRC "pools(address)(address,bool,uint8,uint32,uint128)" $ASSET --rpc-url $RH_RPC` against the registry's `v2.univ3Pool` and `v2.univ3MinLiquidity`
2. The `PoolSet` log on `$UNI_SRC`: `cast logs --address $UNI_SRC "PoolSet(address,address,bool,uint8,uint32,uint128)" --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC` — who sent it, and when. The bound is not optional: unbounded, this RPC errors instead of answering, and the second RPC answers empty for anything it will not serve (§0)
3. `cast call $ORACLE "settlementConfig(address,uint40)(bool,address[],uint16,uint32,uint32)" $ASSET $E --rpc-url $RH_RPC` for each open expiry: those already pinned are unaffected

→ A change nobody owns is an admin-key incident: `incident-v2.md` §5. A change that was planned but
never reached the registry: fix `ops/markets/tier1.json` and redeploy, `incident-v2.md` §3 for the
conversions taken from the wrong pool in between.

### §V35 `v2_mon_l2_lag` — P2 (warn) / P1 (error, > 15 min)
The head block's timestamp is more than 60 s behind the monitor's clock. Chain 4663 has no
sequencer-uptime feed: this is the only liveness check. A devnet warped ahead reads as negative lag and
never pages.

1. `cast block latest -f number,timestamp --rpc-url $RH_RPC` and `date -u +%s`
2. The same on `$RH_RPC_2`: the chain, or one RPC?
3. The next expiry's `[E, E + 600]` snapshot window: will the stall run through it?

→ `incident.md` §7; `incident-v2.md` §2 (a stall across `E + 600` loses the pool vote).

### §V36 `v2_mon_service_down` (error), `v2_mon_service_degraded` (warn)
A `--health` target did not answer (`data.error`), answered non-2xx (the bots answer 503 `wedged` when
no tick completed in three poll intervals; indexer-v2 503 with no indexed head), or answered 2xx and
unhealthy (`data.reasons`: `status degraded|lagging`, `database unavailable`, `<channel> breaker open`,
`rules engine failing`).

1. `probe <data.name> <the URL for it in the monitor's MONITOR_HEALTH>` (§V18)
2. `railway logs --service <data.name>` and the service's deploy status in the Railway UI
3. For a bot: `cast balance <signer> --rpc-url $RH_RPC` (a key without gas wedges on receipts)

→ Railway restarts crashed processes, not wedged ones: redeploy the service. The service's own section
above (§V12-§V15, §V1-§V11) for what its failure costs.

### §V37 `v2_mon_check_failed` (warn; error for `head`), `v2_mon_resolved` (info)
A check could not complete this run (`data.check`: `head`, `scan`, `settlement`, `backlog`, `rewards`,
`vault`, `config`, `fees`, `pins`, `feeds`, `tokens`, `usdg`, `pools`, `health`); the message carries the failing read.
Conditions owned by that check stay open, never falsely resolved. `head` failing means the RPC is down:
every chain check is skipped, the health checks and delivery still run. `v2_mon_resolved` reports a
warn/error condition that cleared (`data.resolvedKind`, `openFor` seconds).

1. `node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts --json | jq '.checks'`
2. The failing read by hand (`cast call …` from the message)
3. `cast block latest --rpc-url $RH_RPC` and the backup RPC

→ An RPC that refuses `eth_getLogs` ranges (the scan halves down to 100 blocks before failing): point
`--rpc` at the archive endpoint. A view that reverts on a new contract version: the monitor's ABI needs
the change.

### §V37a `v2_mon_state_unwritable` — P1 (error)
The monitor could not write its state file, so it fell back to the container's temp directory
(`data.using`; `null` means that failed too). The state file is the monitor's whole memory: without it
every run starts empty, so every open condition pages again from scratch and — worse — every admin,
pin, feed-owner and Safe change since the last run is adopted as history and **never pages at all**.
The usual cause is a Railway volume the `node` user cannot write: the service needs
`RAILWAY_RUN_UID=0` (deploy.md §15.1, §15.12).

1. `railway variables --service monitor | grep -E 'RAILWAY_RUN_UID|MONITOR_STATE_PATH'`
2. `railway ssh --service monitor -- ls -ld /data /data/monitor-v2.json` (owner and mode)
3. `railway ssh --service monitor -- df -h /data` (ENOSPC looks the same from here)

→ Set `RAILWAY_RUN_UID=0` and redeploy (deploy.md §15.12 variable block), or point
`MONITOR_STATE_PATH` at a writable path. While it is broken,
treat the monitor as event-blind: run `§V27`'s `cast logs` for the admin roles by hand over the window.

### §V38 `v2_mon_fee_scheduled` (warn; error on a rise, event), `v2_mon_fee_change_pending` (warn; error on a rise)
`OrderBook.setFeeParams` scheduled a change: `data.params` from `data.effectiveAt` (the scheduling block +
24 h), and `data.before`, the fees in effect when it was scheduled (replayed from the book's
`FeeParamsSet` / `FeeParamsScheduled` logs, else `feeParams()` at the block before). **error** when a fee
rises or the maker rebate share falls (`data.rises`), or when `before` could not be established. From
`effectiveAt` every take pays the new fees, fills of resting orders included, and `TakeParams` has no
maximum fee. `v2_mon_fee_change_pending` is the same change read from `pendingFeeParams()` when no
`v2_mon_fee_scheduled` announced it (its log was adopted on the first run, or the state file was lost);
it resolves when the change takes effect or is cancelled.

1. `cast call $BOOK "pendingFeeParams()((uint16,uint16,uint32,uint16,uint16),uint40)" --rpc-url $RH_RPC` and `"feeParams()((uint16,uint16,uint32,uint16,uint16))"` (premium, resale, taker flat, taker cap, maker rebate)
2. `cast tx <data.transactionHash> --rpc-url $RH_RPC`: `from` is our admin? (for the pending kind: `cast logs --address $BOOK "FeeParamsScheduled((uint16,uint16,uint32,uint16,uint16),uint40)" --from-block <a day back> --rpc-url $RH_RPC`)
3. Is it the owner's planned change, and were makers, AutoRoller writers and the MM quoter told before `effectiveAt`?

→ Planned: `incident-v2.md` §5b step 2 (notice to makers, the quoter requotes). Not planned: §5b step 3 and §5.

### §V39 `v2_mon_route_changed` — P2 (warn) / P1 (error), event
`UniV3PayoutAdapter.RouteSet(asset, pool, fee)`. **warn**: the registry's `v2.univ3Pool` at its tier, or a
route cleared (that market's ITM call longs are paid in kind). **error**: a pool the registry does not name
(conversions sell elsewhere, and the tier's fee moves the conversion floor: 30 bps + 5 / 30 / 100 bps on a
0.05 / 0.30 / 1 % pool), an asset the registry lists without a pool or not at all, or a tier above 10000
(which the published adapter refuses).

1. `cast call $ADAPTER "routes(address)(address,uint24)" $ASSET --rpc-url $RH_RPC` against the registry row's `v2.univ3Pool`
2. `cast call <pool> "token0()(address)" --rpc-url $RH_RPC`, `"token1()(address)"`, `"fee()(uint24)"`, `"liquidity()(uint128)"`
3. `cast tx <data.transactionHash> --rpc-url $RH_RPC`: `from` is our admin, on today's plan (`incident-v2.md` §3 step 2)?

**INTERFACE_VERSION 8 emits two more events into this same kind**, and one of them is the only coverage
its case has.

**`PayoutRouter.RouteSet(asset, venue, poolId, fee, feeBps)`** — five fields, not the adapter's three. It
shares its NAME with the v7 event and nothing else, so the monitor renames it `RouterRouteSet` before
judging it (`scanEventName`). It is compared against the registry's `markets[].v2.payoutRoute`:
**error** for a venue, fee tier, tickSpacing or pinned v4 pool id the registry does not publish, for an
asset the registry does not list, for a tier above 10000, and for venue `none` set while the registry
publishes a route. **warn** when it matches the registry, and when it clears a route the registry does
not publish either.

**`PayoutRouter.RouteCleared(asset)`** — **error** when the registry publishes a route for that market
(its ITM call longs are paid in Stock Tokens until it is set again), **warn** when it does not.

**Read the warn case before you dismiss it.** For the markets the registry publishes no `payoutRoute`
for, this event is the ONLY thing that ever pages a cleared route. The periodic §V58 check compares the
chain against a published route and says nothing when there is none to compare, so a cleared route on
such a market is indistinguishable from its steady state. `clearRoute` is a `GUARDIAN` action at
execution delay 0, so the AccessManager writes no `OperationScheduled` or `OperationExecuted` for it
either. Nothing else will tell you.

1. `cast call $ROUTER "routes(address)((uint8,uint24,int24,address,uint16))" $ASSET --rpc-url $RH_RPC`
   — the current route. **A failed step here looks like a decode, not an error**: the v7 adapter shares
   this selector (§V58), so if the wrong shape is decoded you get plausible numbers rather than a revert.
   Confirm which contract you are talking to first: only the adapter answers `factory()`.
2. `cast tx <data.transactionHash> --rpc-url $RH_RPC`: `from` is our admin or guardian, on today's plan?
3. If the answer is no, every key that can call `setRoute` or `clearRoute` is suspect.

→ Planned: acknowledge (`RegisterMarkets` restores the registry route on its next run). Not planned:
`incident-v2.md` §5.

### §V40 `v2_mon_oracle_allowlist`, `v2_mon_oracle_clearinghouse` — P1 (error) / P2 (warn), event
The pin wiring. A source's `OracleSet(oracle, allowed)`: **error** when anything but the published
SettlementOracle is allowed (it can pre-pin that source's configuration for any expiry, §V41) or when the
published oracle is removed (every first series on a market listing the source reverts
`SourceNotPinned(source, NotAuthorized)`). `SettlementOracle.ClearinghouseSet(x)`: **error** unless `x` is
the live Clearinghouse (series creation reverts `NotAuthorized` everywhere, and `x` can pin any expiry or
move `pinnedBy`). The warn cases are the deploy wiring and its restores.

1. `cast call $ORACLE "clearinghouse()(address)" --rpc-url $RH_RPC` (must be `$CH`)
2. `cast call $CL_SRC "isOracle(address)(bool)" <data.args.oracle> --rpc-url $RH_RPC` (and `$UNI_SRC`, `$DS_SRC`); `isOracle($ORACLE)` true on every listed source
3. `cast tx <data.transactionHash> --rpc-url $RH_RPC` and `v2_mon_pin_blocked` / `v2_mon_pre_pin` in the same minutes

→ `incident-v2.md` §5a (restore the wiring), §5 when nobody owns it.

### §V41 `v2_mon_pre_pin` — P1 (error), event
A pin made outside a series creation: a `SettlementConfigPinned(asset, E)` in a transaction without the
Clearinghouse's `SeriesCreated(asset, E)` (through a moved clearinghouse pointer), or a source's
`FeedPinned` / `PoolPinned` (Data Streams `FeedPinned`) without either (through a source's allow-list). It
blocks every series of `E` while the pin differs from the configuration current at creation; a pin equal
to it is confirmed by the next series. A pin made through an oracle or Clearinghouse the registry does not
name (a migration) pages here too.

1. `cast tx <data.transactionHash> --rpc-url $RH_RPC`: who sent it, and which call made the pin
2. `cast call $ORACLE "pinnedBy(address,uint40)(address)" $ASSET <data.expiry> --rpc-url $RH_RPC` and `"settlementConfig(address,uint40)(bool,address[],uint16,uint32,uint32)"`; `cast call $CL_SRC "pinnedFeeds(address,uint40)(address,uint32,uint16,bool)" $ASSET <data.expiry>`
3. The dry run: `cast call $ORACLE "pin(address,uint40)" $ASSET <data.expiry> --from $CH --rpc-url $RH_RPC` (a revert: `v2_mon_pin_blocked`)

→ `incident-v2.md` §5a; nobody plans a pre-pin: §5.

### §V42 `v2_mon_data_streams_feed` — P1 (error, the source is listed) / P2 (warn), event
`DataStreamsSource.FeedSet(asset, feedId)`. A feed change bumps the asset's `feedVersion` and restarts its
observations, so every pinned expiry of that asset whose window was not recorded yet stops being priced by
the source and settles on its other pinned sources alone. **error** while the source is listed anywhere
(`data.listed`: a market's oracle list, or the pin of an expiry with series); **warn** when it is listed
nowhere (the launch state: no market lists it, `RegisterMarkets` never configures it).

1. `cast call $DS_SRC "feedIdOf(address)(bytes32)" $ASSET --rpc-url $RH_RPC` and `"feedVersion(address)(uint64)"`
2. `cast call $ORACLE "marketConfig(address)(address[],uint16,uint32,uint32)" $ASSET --rpc-url $RH_RPC`: is `$DS_SRC` listed?
3. For the listed expiries: `cast call $DS_SRC "pinnedFeeds(address,uint40)(bool,uint64)" $ASSET $E --rpc-url $RH_RPC` against `feedVersion`, and `cast call $DS_SRC "snapshots(address,uint40)(uint128,uint16,uint40)" $ASSET $E` (recorded windows are safe)

→ `incident-v2.md` §5 (an unplanned change), §1 for each expiry that now rests on one source.

### §V43 `v2_mon_pin_blocked`, `v2_mon_pinned_by`, `v2_mon_pin_mismatch` — P1 (error)
The `pins` check, for every registry market registered on the Clearinghouse (`--tickers` narrows it) and
every creatable expiry `E` (weekday closes in `[now + 1 h, now + 45 d]` the Clearinghouse's calendar
accepts, plus special expiries from `SpecialExpirySet` logs), and every expiry with series not yet
settled and done:
- **`v2_mon_pin_blocked`**: an `eth_call` of `SettlementOracle.pin(asset, E)` from the Clearinghouse's
  address reverts, so the next series of `E` cannot be created. `<asset>:unpinned` stands for every expiry
  nobody pinned (they all give the same answer, so one dry run per market covers them); `<asset>:<E>` is an
  expiry pinned some other way. `data.revert`: `NotAuthorized` (the oracle's pointer), `NoSource` (no
  source list), `PinMismatch` (a pre-pin that is not the current configuration), `SourceNotPinned` with the
  source and its reason (`NotAuthorized`: not allow-listed; `NoSource`: unconfigured; `PinMismatch`: a
  source pre-pin; `0x00000000`: no code or out of gas).
- **`v2_mon_pinned_by`**: `pinnedBy(asset, E)` is neither 0 nor the Clearinghouse. Without series: a pre-pin.
  With series: the pointer was moved and pinned through (the price cannot change; the next series must
  confirm). After a Clearinghouse migration every old pin shows here until its next series.
- **`v2_mon_pin_mismatch`**: an expiry with series is pinned to what the registry does not publish
  (`data.differences`: sources, `maxDeviationBps`, `uncorroboratedDelay`, `spotMaxAge`, the Chainlink feed,
  `maxStale` 26 h, `maxRoundJumpBps` 2000, the pool, its floor, the 300 s window; a series on another oracle;
  a Data Streams feed changed after the pin), or `<asset>:market-oracle`, a market row pointing new series at
  another oracle. The pin can never change: this stays open until the expiry is settled and done. An expiry
  that matched once is not read again. A registry change after an expiry was pinned (a new override) pages
  here for the expiries the monitor had not verified yet: compare with the registry at the pin's block.

Cost and freshness: the check re-reads at most every `pinCheckS` (900 s) and at once after a pin or wiring
log (`MarketConfigured`, `ClearinghouseSet`, `OracleSet`, `FeedSet`, `PoolSet`, the pin logs, `HolidaySet`,
`SpecialExpirySet`, `MarketRegistered`, `MarketConfigSet`, `CalendarSet`), a new creatable expiry, a new
expiry with series or a registry change; between re-reads the detail says `served from block N's reads`.
A re-read is the views through Multicall3 (about 6 eth_calls for 35 markets x 33 expiries) plus one dry run
per enabled market and per expiry pinned some other way (at most 4 at once).

1. `node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts --json | jq '.checks.pins, [.findings[] | select(.kind | test("pin"))]'`
2. The dry run and the pins by hand (`incident-v2.md` §5a step 1)
3. The logs that explain it: `cast logs --address $ORACLE "ClearinghouseSet(address indexed clearinghouse)" --from-block <recent> --rpc-url $RH_RPC`, the sources' `OracleSet(address indexed oracle, bool allowed)`, and `SettlementConfigPinned` for `data.expiry`

→ `incident-v2.md` §5a (blocked, pinnedBy); §5 step 3 for a mismatch nobody planned (those series settle on
that pin: tell their holders).

### §V44 `v2_mon_feed_stale` — P1 (error) / P2 (warn)
The `feeds` check, per market in scope, compares the feed's latest round (`latestRoundData().updatedAt`) with
the head block's time in **open-market** seconds. The 24/5 equity feeds print on a 0.5 % move or a 24 h
heartbeat while the market is open. They print nothing from Friday 20:00 to Sunday 20:00 New York or from the
evening before a full NYSE holiday to the holiday's evening (the monitor's `NYSE_FULL_HOLIDAYS`, equal to
`ops/markets/v2-sources.json`). Wall-clock age is not the test: it is days every weekend with nothing wrong.
The oracle's `spotMaxAgeS` (25 h) is not the limit either (`ops/deploy.md` §15.13).
- **error**: more than `feedHeartbeatS` (the registry's, 86400) + `feedStaleMarginS` (3600) of open market
  without a round. The feed missed its heartbeat: it is broken, or the price network has stalled. Over
  2026-08-03..09-17 the longest open-market gap on any of the 35 feeds was 24 h 30 s. Replaying every
  minute of that window through the check paged nothing. `spot()` reverts once the round is 25 h old.
  A settlement window has no Chainlink price once the round in force at its start is 26 h old.
- **warn**: the market reopened more than `feedReopenGraceS` (900 s) ago and the feed has not printed since
  (`data.reopenedAt`). Every feed printed within a minute of every reopen in that window. Without that
  print the round in force is from before the closure, older than 25 h by Sunday night, and `spot()` stays
  stale into the next regular session. It escalates to error at the heartbeat limit.

`data`: `updatedAt`, `ageS` (wall), `openAgeS`, `heartbeatS`, `limitS`, `roundId`. It resolves on the
first run after the feed prints.

**This alert checks feed silence, not price divergence.** The calibrated `v2_mon_price_divergence`
(§V48) compares the Chainlink source and pool TWAP when a band is configured. Without a band, look
for a stalled feed by hand each session: `spot-divergence` refusals in `mm-bot` `/state` and `v2_mm_pricing`,
`v2_pricer_fair_unavailable`, a print 150-300 bps from Cboe `current_price` × `uiMultiplier` or from the
pool for more than five minutes, or a feed that normally prints several times an hour going silent for
one. Then `ops/runbooks/incident-v2.md` §7.

1. `cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC` and `cast block latest -f timestamp --rpc-url $RH_RPC`
2. Is it one feed or all of them? `node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts --all-markets` (the `feeds` detail prints every feed's last round age); and `cast call $ORACLE "trySpot(address)(bool,uint256,uint256)" $ASSET --rpc-url $RH_RPC`
3. The price the feed should be near: Cboe's `current_price` (15 min delayed) and the pool, `cast call $UNI_SRC "latest(address)(bool,uint256,uint256)" $ASSET --rpc-url $RH_RPC`

→ `incident-v2.md` §7.

### §V45 `v2_mon_vault_outflow` — P2 (warn) / P1 (error, 90 % of the cap)
INTERFACE_VERSION 7 (c21). `MakerVault.Limits.maxDailyOutflow` is a leaky bucket over 24 h on the **net
USDG a quoter call pays out**: `place(Bid)`, `replace(Bid)` and `take` book the fall in
`usdg.balanceOf(vault) + orderBook.owed(vault)` across the call and revert
`OutflowCapExceeded(available, outflow)` above the cap. Asks, sales, cancels, closes, `claimOwed`, `sync`
and every ledger move are never booked against it, and the bucket refills linearly (`OUTFLOW_WINDOW`,
86,400 s). Launch cap **2,500e6** (2,500 USDG at once, ≤ 5,000 in any 24 h; V7-DESIGN §5.3). The vault
check reads `outflow()` every pass and reports `used` / `available` in its detail line.

- **warn** at `used >= 50 %` of the cap, escalating to **error** at 90 % under the same key
  (`<vault>:outflow`): bids and buying takes are about to revert and the bot goes one-sided.
- **warn**, key `<vault>:frozen`, when the cap itself is **0**. That is the spend freeze of
  `incident-v2.md` §4c, not an outage — everything except paying USDG out still works. It pages so that a
  freeze nobody lifted cannot sit there quietly.

1. `cast call $VAULT "outflow()(uint256,uint256)" --rpc-url $RH_RPC` and `cast call $VAULT "limits()((uint64,uint128,uint16,uint16,uint32,uint128))" --rpc-url $RH_RPC`
2. **Did our bot spend it?** The mm-bot's `/state` shows the same numbers and its own `v2_mm_outflow`
   warns when it trims bids. Bot spend and `used` agreeing is a sizing question, not an incident.
3. They disagree, or the bot is down and `used` is still rising: something else holds `QUOTER_ROLE`.
   `cast logs` the vault's `OrderPlaced` / `Taken` since the last quiet pass, and go to `incident-v2.md` §4c
   — revoke the role first, the cap only bounds the bleeding.

→ A cap at 90 % with the bot behaving is a **risk decision**: raise it with `setLimits` (all SIX fields,
§4c) once wave-2 markets are quoted, per V7-DESIGN §5.3. Anything else → `incident-v2.md` §4c.

**Canary and expansion.** On the NVDA canary one market is quoted, near-money weekly bids are ~300-500
USDG of live escrow, and 2,500e6 is far more than the bot can reach: this alert firing at all during the
canary means the quoter is doing something the bot does not intend, so treat it as §4c, not as sizing.
At the 35-market expansion the same cap is shared by every market the bot quotes, and the dearest wave-2
names (ASML, SNDK, MU: 10 % bid caps of 159 / 152 / 93 USDG a share) eat it fastest. The tell that it is
sizing and not an incident is the **bot's own** `v2_mm_outflow`: it warns when it trims bids to stay
under the cap. Bids trimmed on a meaningful share of session ticks for a week is the condition
V7-DESIGN §5.3 set for raising the cap to 5,000e6 — a `setLimits`, no redeploy. A cap the bot keeps
hitting is not harmless: the vault goes ask-only, the book shows no bid, and buyers cannot sell back.

### §V46 `v2_mon_roller_ask_overtaken` — P1 (error) / P2 (warn, delegate revoked)
INTERFACE_VERSION 7 (c16). A tracked `AutoRoller` ask is live, and the market's own spot (`trySpot`, the
freshness the contract itself accepts) has reached or passed its strike, for more than `rollerStaleS`
(60 s). That ask still carries its roll-time price, so anyone can buy it **below intrinsic value** at the
writer's expense — the hole c16 closed. `cancelStale(writer, underlying)` is permissionless, pays the
`CANCEL_STALE` bounty and the cranker calls it every tick, so this condition should never last.

- **error**: the roller is still the writer's OrderBook delegate, so `cancelStale` works and nobody is
  calling it. The cranker is down, its `stale` step is erroring, or it cannot pay for gas.
- **warn**: `isDelegate(writer, autoRoller)` is false. The writer revoked the delegate, so `cancelStale`
  reverts `NotAuthorized` and **only the writer** can withdraw the ask. Nothing we run can fix it.

1. `cast call $ROLLER "position(address,address)(uint256,uint256,uint40)" $WRITER $ASSET --rpc-url $RH_RPC`
   then `cast call $BOOK "getOrders(uint256[])((address,uint256,uint8,uint128,uint64,uint64,uint40,bool)[])" "[$ORDER]" --rpc-url $RH_RPC`
2. `cast call $ORACLE "trySpot(address)(bool,uint256,uint256)" $ASSET --rpc-url $RH_RPC` against the
   series' strike: `cast call $CH "series(uint256)((address,bool,uint40,uint128,address,uint16,bool,uint128,uint128,uint128,uint128,uint32,uint128))" $LONG_ID --rpc-url $RH_RPC`
3. Is the cranker alive and cranking? `v2_mon_service_down:cranker`, its `/health`, and
   `cast call $ROLLER "cancelStale(address,address)(bool)" $WRITER $ASSET --rpc-url $RH_RPC` (a **call**,
   nothing is sent): `true` means the cancel would work and only the caller is missing.

→ `incident-v2.md` §8.

### §V47 `v2_mon_mint_fee_zero`, `v2_mon_mint_rent` — P1 (error)
INTERFACE_VERSION 7 (c05). The writer fee is **collateral rent**: `mint` charges
`ceil(units × collateralPerUnit × mintFeePpm × (expiry − now) / (1e6 × 604800))` out of free collateral,
`close` refunds the same product floored to whoever closes, and `settle` accrues what is left to
`accruedFees`. `premiumFeeBps` is **0** at launch, so rent is the only writer fee there is.

**`v2_mon_mint_fee_zero`** — a market charging nothing.
- key `<asset>:chain`: the market is **enabled on the Clearinghouse with `mintFeePpm` 0**. Every series
  created while it stays 0 is pinned at 0 for its whole life (the rate never changes after creation), so
  this is the runtime twin of the deploy blocker in `status/DECISIONS-2026-09-17.md` §11.
- key `<asset>:registry`: `ops/markets/tier1.json` publishes no rate for it (`markets[].v2.mintFeePpm`,
  falling back to `v2.fees.mintFeePpm`). A deploy or a re-registration from this registry would charge its
  writers nothing. `build-markets.mjs --check` refuses it; this catches a registry the monitor is running
  against that never went through that gate.

**`v2_mon_mint_rent`** — the rent ledger of one series does not add up. Rent moves in exactly three
places, all logged by the Clearinghouse itself: `Minted.fee` in, `Closed.feeRefund` out,
`MintFeesAccrued.amount` to the treasury at settlement. The monitor sums them per series from its own log
scan (no chain read, and only for series it has followed since `SeriesCreated`):
- `<longId>:accrual` (error): a settled series accrued something other than charges − refunds.
- `<longId>:free-mint` (error): a series pinned above 0 ppm charged a mint **nothing**. The contract
  rounds the charge up, so with time left this cannot happen.
- `<longId>:zero-rate` (warn): the series is pinned at 0 while its market now charges. Every unit written
  into it is free until it expires; only new series pick the rate up.

The first two are, in practice, evidence that the **monitor** is decoding a different Clearinghouse than
it thinks — the v6 `Minted` / `Closed` signatures carry no fee at all — before they are evidence about
the chain. Check §V17's ABI note first.

1. `cast call $CH "market(address)((bool,bool,uint64,uint16,address,uint32))" $ASSET --rpc-url $RH_RPC` — the sixth field is the rate
2. `node ops/markets/build-markets.mjs --check` and the market's row in `ops/markets/tier1.json` against the V7-DESIGN §5.1 table
3. Per series: `cast call $CH "series(uint256)((address,bool,uint40,uint128,address,uint16,bool,uint128,uint128,uint128,uint128,uint32,uint128))" $LONG_ID --rpc-url $RH_RPC` (`mintFeePpm`, `mintFeesHeld`),
   and `cast call $CH "mintFee(uint256,uint64)(uint256)" $LONG_ID 100 --rpc-url $RH_RPC` against `closeRefund` for the same units

→ `incident-v2.md` §9.

**Canary and expansion.** NVDA is 80 ppm: `486,904,761,905` **NVDA base units** of rent on a 1-unit
weekly call at the Monday 09:45 roll — a call's rent is paid in the Stock Token it locks, not in USDG,
and that is worth about 107 USDG base units against 3,949 of premium at the same moment. Do not report
Stock Token rent as USDG anywhere without saying at what price.
During the canary the MakerVault writes almost every
ask, so nearly all of that rent is treasury paying treasury (`MM_PASS_MINT_FEE` is off by default, so it
does not move buyer asks either) and the revenue line will look like nothing — that is expected, not a
broken fee. What the canary *does* prove is the mechanics: `Minted.fee` non-zero, `Closed.feeRefund` on
a close before expiry, `MintFeesAccrued` at the first settlement. Watch for all three in the first cycle.

At expansion every market carries its **own** rate (5 ppm on SGOV and SPY up to 1,500 on NBIS,
V7-DESIGN §5.1) and **a rate is pinned into a series at creation**, so the order of operations matters:
register the market at its rate *before* anything creates a series on it. A market registered at 0 and
corrected a day later leaves a day of free series that stay free until they expire — which is why
`<asset>:chain` is an error and not a warning, and why `build-markets.mjs --check`, the
`RegisterMarkets` preflight and `VerifyV2` all refuse a zero effective rate. Two more consequences to
expect rather than page on: a writer who deposits exactly N shares writes `N × 100 − 1` units (the
deposit needs rent headroom), and an `AskWrite` whose maker cannot cover collateral **plus** rent is
skipped by the book rather than reverting, so it simply does not fill.

### §V48 `v2_mon_price_divergence` — P2 (warn) / P1 (error)

The monitor reads `ChainlinkFeedSource.latest(asset)` and `UniV3TwapSource.latest(asset)` at the same
head block. The latter is the configured pool's five-minute TWAP and applies its liquidity floor.
It compares USDG6 prices during the open 24/5 market only. A difference strictly past the market's
configured band warns; a second pass at a distinct head escalates to error. A source that does not
return a valid price leaves the check incomplete and does not create a price alert. Feed silence alone
is covered by §V44. The condition resolves when both sources become available and converge or the
24/5 market closes.

This check is **inactive by default**. Set `MONITOR_DIVERGENCE_BANDS=NVDA=<bps>,TSLA=<bps>` on the monitor,
or pass `--divergence-band NVDA=<bps>` in a diagnostic run. Each value must be 1–299 bps, below the MM's
300 bps halt threshold. Derive a band for **each** market from 30 days of paired head-time source
readings, including normal pool/feed basis, then review it before activation. One pool/feed observation
is not a calibration. A market without a configured pool cannot be enabled. Keep the monitor's state
file on its volume: that is where it remembers the consecutive-pass count.

1. Read both `latest(asset)` values at the same head, then the feed's `latestRoundData().updatedAt`.
2. Compare Cboe `current_price` and the pool directly to identify which source is wrong. Check pool
   liquidity and whether its source points to the registry pool.
3. Follow [`incident-v2.md` §7](runbooks/incident-v2.md) before pausing writes or vetoing a candidate.

---

### §V49 `v2_mon_quote_unready`, `v2_mon_pricing_reason_unknown` — P2 (warn)

**Priceability, not process health.** A pricing service that answers `/health` 200 and a series that can
be quoted are two different facts. `v2_mon_service_down` / `v2_mon_service_degraded` (§V36) page about the
process; these page about the inputs. Both can be open at once, and neither stands in for the other.

With `--pricing <base url>` (or `MONITOR_PRICING_URL`) the monitor reads, per pass and read-only:

- `GET /health` — each market's chain row (`usable`: `ok`, `chain-stale`, `chain-inconsistent`). A chain the
  service refuses means **every** estimate of that market is refused; that pages once, keyed on the ticker.
- `GET /surface/:ticker` — each expiry the provider lists, with `status` (`ok`, or the reason the expiry is
  unusable). Each expiry is bucketed by tenor: the last session of a Monday-Friday week is that week's
  **weekly**, every other session a **daily**.
- `GET /fair?ticker&strike&expiry&type` — a bounded set of probes on the live series the log scan already
  knows (`--threshold pricingProbes=24`, `pricingConcurrency=4`). Daily expiries first, one market at a
  time, so a market with many weeklies can never crowd another market's daily out of the budget.

**A tenor is judged on its own and never borrows another's result.** A market whose weeklies price and
whose dailies do not is not ready, and its daily failure pages under its own key `<TICKER>:daily`. An
expiry a live series settles on that the provider does not list at all is that tenor's failure
(`expiry-not-listed`), never a silence. `v2_mon_quote_unready` blocks automated quoting on the affected
series; it is **not** a market-registration gate (F3 D9).

`v2_mon_pricing_reason_unknown` fires when the service states a refusal or quality code this build does not
know. [`02-interfaces.md` §5.1](../../stonkhouse-plan/02-interfaces.md) keeps an unknown code verbatim and has
automation treat it as **not ready**, so every expiry or series carrying one is also counted unready. A zero
`fair` is a price, not a refusal; a `null` fair always carries a reason.

**Not served yet, so not checked.** The indexer's `/v2/config.services` (X3-301) does not exist — a build
without it means "unknown", not "healthy". The `provenance` object of §5.1 is not on `/fair` until X3-302
ships, so the **provider** and the **pricing method** are reported as not served rather than inferred from
the legacy `source` field. The monitor reads `provenance` when a build does serve it and never requires it.

1. `curl -s "$PRICING/health" | jq '.status, (.chains | to_entries[] | {(.key): .value.usable})'` — is any
   chain `chain-stale` or `chain-inconsistent`? That refuses the whole market.
2. `curl -s "$PRICING/surface/NVDA" | jq '.expiries[] | {expiry, status}'` — which expiry, and which tenor.
   A daily missing from this list while a series settles on it is the `expiry-not-listed` case.
3. `curl -s "$PRICING/fair?ticker=NVDA&strike=231000000&expiry=<E>&type=call" | jq` — the exact series'
   answer and its reason. Then [`incident-v2.md` §10](runbooks/incident-v2.md).

### §V50 `v2_mon_source_age`, `v2_mon_source_switch` — P2 (warn) / P3 (info, a label appears or disappears)

**Source clocks (F3 D5).** Freshness is a *source observation*, never a download. The monitor reports the
quote, underlying and volatility observation ages of each market. An age it cannot compute is **unknown** —
printed `unknown`, stored `null`, never 0 and never fresh. Today only the underlying clock is served (the
legacy `asOf`, the delayed file's last trade time); the quote and volatility clocks come only from §5.1
`provenance.clocks`, so they read `unknown` until a producer serves them. `/health`'s `chainTimestamp` and
`lastTradeTime` are the provider's own text in an unstated zone: they are shown verbatim and never parsed
into an age.

`v2_mon_source_age` is **inactive by default**. Set `--threshold quoteAgeS=<s>`, `underlyingAgeS=<s>` or
`volatilityAgeS=<s>` (or `MONITOR_THRESHOLDS=underlyingAgeS=1800`). The monitor invents no freshness bound:
the service already refuses a chain past its own `maxChainAgeS` (that arrives as a readiness reason under
§V49), and a stricter operator limit is a policy decision derived from a measured session. **With a limit
set, an unknown age fails it** — an unknown age cannot be shown to meet a limit. Setting `quoteAgeS` while
the delayed Cboe file states no option quote time will therefore page for every market; that is the truth
about that feed, not a bug. The publication clock is reported and never pages: an ingestion or publication
time is not a source observation.

`v2_mon_source_switch` is an **event**, paged once per transition, on three labels:
`provider` and `method` (§5.1 `provenance`, so null today) and the legacy `source` label — `cboe` means the
`cboe-delayed` provider priced from the exact listed contract, `model` every other method, so it moves when
either does. A market's label is the common value of its probed series, or `mixed` when they disagree. A
label that appears or disappears is **info** (the contract moved); a label that changes from one stated
value to another is **warn**: every estimate now comes from a different input, and the edge and spreads were
calibrated on the old one.

1. `curl -s "$PRICING/fair?ticker=NVDA&strike=<K>&expiry=<E>&type=call" | jq '{source, asOf, provenance}'`
   — what the service says now, and whether it states a provider at all.
2. Compare with the alert's `data.from` / `data.to`. A switch nobody deployed is a provider outage or a
   fallback; a switch a deploy caused belongs in the deploy record.
3. Widen or stop automated quoting on the affected market before trusting the new input:
   [`incident-v2.md` §10](runbooks/incident-v2.md).

### §V51 `v2_mon_pricer_idle` — P2 (warn)

The pricer can answer `/health` 200 for hours and reprice nothing. With `--pricer <base url>` (or
`MONITOR_PRICER_URL`) the monitor reads its `/state` counters — `ticks` and the `outcomes` histogram, one
entry per pair per tick — and pages when neither has moved for `--threshold pricerIdleS=<s>` (default 900,
0 = never), or when `lastTickAt` is itself that stale. `lastTickAt` absent is reported **unknown**, never 0.

This is **not** a process check. A pricer that does not answer leaves this alone and pages
`v2_mon_service_down` instead (§V36), so a dead process and a running-but-idle one are two different pages.
Outside the 24/5 session the pricer deliberately does nothing, so the window restarts instead of paging
every night and weekend. `strategies: 0` is not idle: the loop is running and there is nothing to reprice.

**Stopping the pricer does not cancel or reset any ask.** An ask already placed keeps its last price and can
still fill; the writer's band and size remain the writer's decision.

1. `curl -s "$PRICER/state" | jq '{ticks, lastTickAt, sessionOpen, hasRole, strategies, outcomes}'` — is it
   ticking at all, is the session open, does it still hold `PRICER_ROLE`?
2. `curl -s "$PRICER/state" | jq '.pairs[] | {ticker, outcome, why, detail}'` — a tick that evaluates every
   pair to one skip reason (`fair-unavailable`, `quote-stale`, `no-role`) is a data or role problem, not an
   idle loop; §V49 and §V50 name the input.
3. `railway logs -s pricer | tail -50`, then [`incident-v2.md` §10](runbooks/incident-v2.md).

## Monitor kinds — INTERFACE_VERSION 8

### §V52 `v2_mon_manager_operation` — P1 (error) / P2 (warn, a cancel), event
INTERFACE_VERSION 8 put every delayed admin action behind an `AccessManager`. A change is **scheduled**,
waits its role's execution delay, and is then **executed**; a role's guardian may **cancel** it in
between, and an operation expires one week after it becomes executable. Each of the three logs pages,
once, with the operation id and nonce.

`OperationScheduled` names the caller, the target and the calldata. The monitor resolves the first four
bytes against `ops/abis/v2/roles.json` and prints `<Contract>.<signature> (<ROLE>)` when the manifest
carries it. **A selector the manifest does not carry is printed as a selector and is worth more attention,
not less**: a `restricted` selector missing from the manifest belongs to `ADMIN` by default.

- **error** — `OperationScheduled`, `OperationExecuted`. The schedule is the window in which this can
  still be stopped; the execution is the moment the state actually moved.
- **warn** — `OperationCanceled`. The guardian cancelling a bad operation is the brake working. A cancel
  nobody owns is the brake being taken off something we wanted.

1. Identify it: `cast call $MANAGER "getSchedule(bytes32)(uint48)" <operationId> --rpc-url $RH_RPC` — a
   non-zero value is when it becomes executable; 0 means executed, cancelled or expired.
2. `cast call $MANAGER "getNonce(bytes32)(uint32)" <operationId> --rpc-url $RH_RPC` against `data.nonce`:
   a higher nonce means it was rescheduled.
3. Does anyone own it? The Admin Safe's own transaction history is the record. If nobody does, treat the
   Safe as compromised and go to [`incident-v2.md` §5](runbooks/incident-v2.md).
4. To stop one: the guardian of that role cancels it. `roles.json` `roleGuardian` says which role that is
   — and **`ADMIN` has no guardian**, so an ADMIN-lane operation cannot be cancelled this way.

→ [`incident-v2.md` §5](runbooks/incident-v2.md).

### §V53 `v2_mon_manager_role` — P1 (error) / P3 (warn, `RoleLabel`), event
Any change to **who may do what**: `RoleGranted(uint64,…)`, `RoleRevoked`, `RoleAdminChanged`,
`RoleGuardianChanged`, `RoleGrantDelayChanged`, `RoleLabel`, `TargetFunctionRoleUpdated`,
`TargetAdminDelayUpdated`, `TargetClosed`.

**These are not AccessControl's events.** The manager's `RoleGranted` takes a `uint64` role id; the
`RoleGranted(bytes32 role, address account, address sender)` that the un-migrated contracts still emit is
a different event with a different topic, and pages as `v2_mon_config_changed` (§V27). The monitor gives
the manager's forms names of their own precisely so a uint64 id is never read as a bytes32 role hash —
which would name the wrong role and page nothing for the right one.

What to read first, by event:

- **`RoleGranted`** — `delay` is this member's execution delay, and the message says when it differs from
  the manifest's. A **re-grant to an existing member changes the delay**, and a reduction only takes
  effect once the difference has elapsed; `newMember: false` is therefore not "nothing happened".
- **`RoleRevoked`** — if this was the last holder, that lane is dead, not merely delayed. `roles.json`
  `holders` says who else should have it.
- **`RoleAdminChanged` / `RoleGuardianChanged`** — who may grant the role, and who may cancel its
  operations. Both are compared with the manifest in the message.
- **`TargetFunctionRoleUpdated`** — a function moved to another role. The message names the function when
  the manifest carries its selector.
- **`TargetClosed`** — every restricted call on that contract reverts while it is closed.

1. `cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" <roleId> <account> --rpc-url $RH_RPC`
2. `cast call $MANAGER "getRoleAdmin(uint64)(uint64)" <roleId>` and `"getRoleGuardian(uint64)(uint64)"`
3. Compare with `ops/abis/v2/roles.json`, which is the published manifest and what §V54 checks against.

→ [`incident-v2.md` §5](runbooks/incident-v2.md).

### §V54 `v2_mon_manager_wiring` — P1 (error)
The manager's **state** against `ops/abis/v2/roles.json`. §V53 catches a change as it happens; this
catches one that happened before the monitor was watching, or while it was down — and it keeps firing
until the chain and the manifest agree, where an event pages once.

Keys: `<manager>:<roleId>:admin`, `:guardian`, and `<manager>:<roleId>:<account>:missing` / `:extra` /
`:delay`.

- A **role admin or guardian** that is not the manifest's: whoever holds that admin role can hand this
  role to anybody, and the guardian is what cancels a scheduled operation in that lane.
- A published holder that **does not hold** its role: every call that needs it reverts.
- A holder with a **different execution delay** from the manifest: the delay *is* the protection. Shorter
  is less time to notice and cancel; longer is an emergency brake that arrives late.

Only holders the registry names an address for are checked. A holder the registry has not written back
yet is **unknown** and is not reported as missing.

1. `node -e 'console.log(JSON.stringify(require("./ops/abis/v2/roles.json").delaysS,null,1))'`
2. `cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" <roleId> <account> --rpc-url $RH_RPC`
3. Fixing one is itself an `ADMIN` operation with a 48 h delay: schedule it, then §V52 pages on it.

→ [`incident-v2.md` §5](runbooks/incident-v2.md).

### §V55 `v2_mon_safe_threshold` — P1 (error); `v2_mon_protocol_safe_config_changed` — P1 (error, event); `v2_mon_protocol_safe_nonce_changed` — P4 (info, event)
Our own Safes: `shared.safes.admin` and `shared.safes.treasury`, both 2-of-3.

**`v2_mon_safe_threshold`** — a protocol Safe that needs fewer than **2** signatures, or more signatures
than it has owners.

This one is deliberately **not** a change detector. A change detector says nothing on the first run of a
fresh monitor, after a state reset, or about a Safe that was already 1-of-3 when the monitor was first
pointed at it — and "already wrong" is exactly the case that matters. This check carries no history and
fires on sight.

**`v2_mon_protocol_safe_config_changed`** — the threshold or the owner set of one of OUR Safes moved.
Changing who signs for this protocol, or how many of them are needed, is not a routine operation and it
should match a decision somebody can name. **`v2_mon_protocol_safe_nonce_changed`** — one of our Safes
executed a transaction; informational, because whatever it did lands as its own admin event (§V27, §V53)
which is where the detail is.

**These are separate kinds from §V28's `v2_mon_safe_nonce_changed` and `v2_mon_safe_config_changed`, and
the split is the point.** §V28 watches the Chainlink **feed owner** Safe, which is a third party: its
body says "Usually another feed" and sends you to the feed runbook, which is right for that Safe and
wrong for ours. Our Safes reached those kinds until INTERFACE_VERSION 8 gave them their own — a change to
the multisig that controls this protocol was arriving labelled as feed noise, at **warn**, in the feeds
group. If you see one of ours under a §V28 kind, the routing has regressed.

A Safe address with **no code**, or one that does not answer `getThreshold()`, is reported as a note and
the check goes `incomplete`. It is never counted as healthy: an EOA standing where a Safe should be is
the same failure with a friendlier shape.

1. `cast call $SAFE "getThreshold()(uint256)" --rpc-url $RH_RPC` and `"getOwners()(address[])"`
2. Raising a threshold is a Safe transaction of its own, signed by the current owners.
3. If the threshold moved without an owner, every key on that Safe is suspect:
   [`incident-v2.md` §5](runbooks/incident-v2.md).

→ [`incident-v2.md` §5](runbooks/incident-v2.md).

### §V56 `v2_mon_splitter_idle` (warn), `v2_mon_splitter_floor_miss` (error)
INTERFACE_VERSION 8 sends every protocol fee to the **FeeSplitter**, which converts Stock Token fees to
USDG through the `PayoutRouter`, splits that USDG once between a buyback balance and the Treasury Safe,
and never sells below a floor computed from the oracle's ok spot.

**`v2_mon_splitter_idle`** — the splitter has held fees since the monitor first saw them arrive and has
emitted no `Distributed` for `splitterIdleS` (24 h). `distribute(asset)` is **permissionless**: nothing
needs a role to fix this. Either the cranker's distribute step is not running, or every attempt is being
refused and `DistributionSkipped` says why.

**`v2_mon_splitter_floor_miss`** — `splitterFloorMisses` (3) consecutive skips of the same asset with the
same reason:

| reason | what it means |
|---|---|
| `BELOW_FLOOR` | the route cannot fill at the oracle's spot less slippage and the route fee. The pool is thin, the fee is high, or the route points at the wrong pool |
| `NO_ROUTE` | the asset has no `PayoutRouter` route at all (§V58) |
| `NO_SPOT` | the oracle has no ok spot for it — a feed problem (§V44), not a venue one |
| `DUST` | the balance is below what a swap is worth. Normal in small amounts |

**Nothing is lost while this is open.** The tokens are held, never dumped at whatever the pool says. But
no fee reaches the treasury or the buyback either, so it is a revenue stop, not a safety one.

The clock is **when the monitor saw the evidence**, not the log's block time: a decoded log carries a
block number, not a timestamp. The ages reported here are therefore ages since the monitor saw it, which
is the weaker and the true statement. A monitor that was down does not invent the gap.

1. `cast call $SPLITTER "buybackBalance()(uint256)" --rpc-url $RH_RPC`
2. The last `DistributionSkipped`: `cast logs --address $SPLITTER "DistributionSkipped(address,bytes32)" --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC | tail` — bounded deliberately: a result with two meanings is not a control, and an unbounded query has no meaning at all on this node (§0)
3. For `BELOW_FLOOR`, check the route (§V58) and the market's spot (§V44) before touching the slippage
   dial — `setConversionSlippageBps` is a `FEE_MANAGER` operation with a 48 h delay.

→ [`incident-v2.md` §3](runbooks/incident-v2.md).

### §V57 `v2_mon_buyback_stuck` (warn), `v2_mon_buyback_unburned` (error)
**`v2_mon_buyback_unburned`** — a `BoughtBack` with **no `Burned` in the same transaction**. The published
`FeeSplitter.buyback` requires the burned amount to equal the token's measured total-supply delta, so
against that contract this cannot happen. If it does, either the address emitting `BoughtBack` is not
that contract, or tokens bought with protocol fees are sitting somewhere instead of being burned.
**Nothing may report a burn that has not happened** — this alert exists so no dashboard can.

**`v2_mon_buyback_stuck`** — the buyback balance is non-zero, the compiled `BUYBACK_COOLDOWN` (5 min) is
long over, nothing has bought back for `buybackStuckS` (6 h), **and the contract has emitted no
`BuybackSkipped` inside that window**. That last clause is what makes this page mean "nothing is calling
`buyback()`" rather than "the buyback is not happening". `buyback(minTokenOut)` needs the `BUYBACK` role,
which the cranker key holds. `lastBuybackAt()` returns **0 before the first buyback**; the monitor reads
that as **never**, not as a 1970 timestamp, and says "never" in the message.

**The age is measured from when THIS balance was funded** (the `Distributed` that added to it), not from
the previous buyback. Ageing from the last buy would make the page lag by the whole healthy gap before
it: the longer the flywheel had been running, the later it would report the first failure.

**What this alert CANNOT see, stated plainly.** The cranker's own refusals send no transaction, so they
leave nothing on chain: an unquotable route, a `minTokenOut` that refuses every quote, and
`CRANKER_BUYBACK_DRY_RUN` all look exactly like a cranker that is not running. `railway logs -s cranker`
is the only thing that separates them. A **failed** step here is silent: an empty `grep` of the cranker
log is equally a cranker that is down, a log that has rotated, and a wrong service name — check the
service is running before you read its silence as evidence.

**`v2_mon_buyback_skipped`** (error) — the balance is idle **and** `FeeSplitter` emitted `BuybackSkipped`
inside the window. The cranker IS calling; the contract is refusing. `buyback` emits this for exactly two
reasons (`FeeSplitter.sol:149`, `:159`) and everything else reverts instead, so the reason is precise:

| reason | what it means | the fix |
|---|---|---|
| `EMPTY` | the reserve or `buybackCap` is zero. **With a non-zero balance it can only be the cap**: the flywheel is switched off by a dial, not by a stopped bot | `setBuybackCap` — `FEE_MANAGER`, 48 h delay |
| `NO_EXECUTOR` | `executor` or `stonkhouse` is `address(0)`: deploy wiring was never finished | `setBuybackExecutor` / `setToken` — `TREASURY_ADMIN`, 24 h delay |

Do not chase the cranker for either of these. Both fixes are scheduled operations, so the flywheel stays
off for the length of the delay once you start — which is the reason this pages at error rather than warn.

1. `cast call $SPLITTER "lastBuybackAt()(uint40)" --rpc-url $RH_RPC` — 0 means it has never run.
2. `cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" 10 $CRANKER --rpc-url $RH_RPC` — does the
   cranker still hold `BUYBACK` (role 10)?
3. `railway logs -s cranker | grep -i buyback | tail -30` — a `minTokenOut` that refuses every quote looks
   exactly like a stopped step. §V60 says whether the pool can fill it at all.
4. The splitter can also be **paused** by the guardian, and that is **readable and loggable**. Read the
   state: `cast call $SPLITTER "paused()(bool)" --rpc-url $RH_RPC`. The concrete contract declares
   `paused` as public state, so Solidity generates the getter (`src/v2/periphery/FeeSplitter.sol:53`),
   and `IFeeSplitter` now declares it as well (`src/v2/interfaces/IFeeSplitter.sol:166`) along with
   eight more — `orderBook()`, `router()`, `executor()`, `oracle()`, `stonkhouse()`, `burnBps()`,
   `conversionSlippageBps()` and `buybackCap()` (`:116-159`). All of them reach
   `ops/abis/v2/IFeeSplitter.json`, so a tool holding only that ABI can read them.
   **The change is observable too, and the pause is the best-logged of the lot.** Every one of the ten
   setters emits: `setTreasury` (`FeeSplitter.sol:270`) via `_setTreasury` (`:380-385`), `setOrderBook`
   (`:285`), `setRouter` (`:294`), `setBuybackExecutor` (`:301`), `setOracle` (`:309`), `setToken`
   (`:317`), `setBurnBps` (`:324`), `setBuybackCap` (`:331`), `setConversionSlippageBps` (`:338`) and
   `setPaused` (`:349`). The constructor emits `TreasurySet`, `BurnBpsSet` and `BuybackCapSet` at
   deployment (`:65` calls `_setTreasury`, whose `emit` is at `:385`; `BurnBpsSet` and `BuybackCapSet`
   at `:73-74`), so the launch values are in the log stream as values, not only as later changes. **Line
   numbers in this step were re-derived at contracts `16450a9e` (T-OP-009); the setter list this passage
   carried before (`:184`-`:259`) had drifted by roughly a hundred lines, which is how a reader opening
   them concludes the code changed when it did not.**
   **`PausedSet` fires even when the stored value does not change, and that is deliberate — do not read
   a repeated `PausedSet(true)` as a duplicate.** The contract says why at `FeeSplitter.sol:345-348`:
   `GUARDIAN` runs at execution delay 0, so the call is never scheduled and the AccessManager writes no
   `OperationScheduled` or `OperationExecuted` for it — **this event is the entire on-chain record that a
   guardian acted**. A change-only emit would hide a repeated pause, which is exactly the signal you are
   watching for. So every guardian action leaves a trace, including a pause and un-pause between two
   polls, which the state read alone would miss entirely.
   Read the trace:
   `cast logs --address $SPLITTER "PausedSet(bool)" --from-block <deployBlock> --rpc-url $RH_RPC`
   **What a FAILED step looks like here, because all three failures return quietly:**
   - `cast call ... paused()` **reverts or returns nothing** — `$SPLITTER` is not the FeeSplitter, or the
     RPC is answering for a different chain. Confirm with `cast codesize $SPLITTER`; a `0` means there is
     no contract at that address and every reading in this section is meaningless.
   - `cast logs` returns **no rows**. That is NOT proof that nothing was paused. It is equally the shape
     of a wrong `--address`, a `--from-block` later than the event, a signature that does not match the
     ABI, or an RPC that will not serve the range (§0). Prove the query can see anything at all before
     you trust an empty result: re-run it for `TreasurySet(address)` **with an explicit lower bound at
     the splitter's deploy block** —
     `cast logs --address $SPLITTER "TreasurySet(address)" --from-block <v2.flywheel.deployBlock>
     --rpc-url $RH_RPC` — which the constructor emits at deployment, so on a live splitter it MUST
     return at least one row. Without the bound this command does not return rows on `$RH_RPC`; it
     returns `-32602: expected fromBlock to be a hex string`, which the earlier wording of this control
     never mentioned and which a reader was left to interpret as "broken" (§0).
     **AN EMPTY ANSWER TO THAT MEANS THE QUERY IS BROKEN, AND HERE IS WHY IT CANNOT MEAN ANYTHING
     ELSE.** `$RH_RPC` prunes STATE (`cast call --block` older than roughly 512-9,428 blocks fails with
     `-32000 historical state`) but it does NOT prune LOGS: `eth_getLogs` answered ten million blocks
     back when measured (§0). The splitter's deploy block is inside that, so "the node no longer has
     that range" is not an available reading on `$RH_RPC`. It IS the reading on `$RH_RPC_2`, which
     answers empty with exit 0 for anything older than a few dozen blocks or whenever it throttles —
     so if you ran this against `$RH_RPC_2` the result means nothing; run it again on `$RH_RPC`.
     **Then prove the shape with a query that must answer**: re-run the same command with
     `--from-block $(( $(cast block-number --rpc-url $RH_RPC) - 500 ))` for an event you know fired
     recently (a `Distributed`, or USDG `Transfer(address,address,uint256)` on `$USDG`). Rows there and
     none for `TreasurySet` from the deploy block means `$SPLITTER` or `<deployBlock>` is wrong — a
     later block than the deploy, or a different contract. Nothing there either means the query shape
     is wrong: signature, RPC or chain. Do not read "no rows" as "healthy contract" and do not read it
     as "pruned" — until you have run the control it is a broken query with an unlocated defect.
     **MORE THAN ONE ROW IS ALSO NORMAL, AND IT IS NOT A DUPLICATE.** `_setTreasury` is called from the
     constructor (`FeeSplitter.sol:65`) AND from the `setTreasury` setter (`:271`), so a splitter whose
     treasury has ever been changed emits one `TreasurySet` per change plus the genesis one. "At least
     one" above is exact and deliberate: read extra rows as a treasury history, not as a fault. The
     asymmetry is the whole point of this bullet: "no rows" used to fail OPEN on a short node, and
     "exactly one" would fail CLOSED on a healthy splitter with a treasury history. Both are one defect
     — a result with two meanings is not a control.
   - `cast logs` returns rows but the **monitor never paged**. Expected today, and not a contradiction.
     An admin event reaches a page only if it is BOTH decoded by `SCAN_EVENTS`, which opens at
     `ops/v2/monitor.mjs:4427` (`export const SCAN_EVENTS`), and carries a severity in `CONFIG_EVENTS`,
     which opens at `ops/v2/monitor.mjs:2167` (`export const CONFIG_EVENTS`). The scan keeps a decoded log
     only when it is in `CONFIG_EVENTS` or in `OWN_KIND_EVENTS` — the gate is `ops/v2/monitor.mjs:4832`
     (`OWN_KIND_EVENTS.has(eventName)`) — and `v2_mon_config_changed` then pages only what `CONFIG_EVENTS`
     gives a severity, at `ops/v2/monitor.mjs:2266` (`const severity = CONFIG_EVENTS[e.eventName]`);
     `OWN_KIND_EVENTS` page under their own kinds. The `SCAN_EVENTS` FeeSplitter block at
     `ops/v2/monitor.mjs:4510-4515` (`// INTERFACE_VERSION 8, FeeSplitter.`, `event BuybackSkipped`) lists
     the five **operational** events only — `Distributed`, `DistributionSkipped`, `BoughtBack`, `Burned`,
     `BuybackSkipped`; the ABI's sixth, `OrderBookFeesStranded`, is in `ops/abis/v2/IFeeSplitter.json` and
     nowhere in the monitor. Of the splitter's ten **admin** events, only `TreasurySet` appears anywhere in
     the file — `ops/v2/monitor.mjs:2213` (`TreasurySet: "error"`) and `ops/v2/monitor.mjs:4525`
     (`event TreasurySet(address indexed treasury)`); `PausedSet`, `OrderBookSet`, `RouterSet`,
     `BuybackExecutorSet`, `SettlementOracleSet`, `StonkhouseSet`, `BurnBpsSet`, `BuybackCapSet` and
     `ConversionSlippageBpsSet` appear in neither list. The file states the consequence itself at
     `ops/v2/monitor.mjs:2202` (`NOTHING ever pages`): *an admin event missing from this map is an admin
     event NOTHING ever pages*. The record exists on chain and in `ops/abis/v2/IFeeSplitter.json`; the
     monitor is not yet reading it. Until it does, `cast logs` is how you see a guardian pause — not a
     phone call.
     **Every `monitor.mjs` line number above is pinned at callhouse `4453eac7` and moves whenever that
     file is edited** — T-243 watched its own edit shift them by five, and T-561 found all six stale
     again. Each citation carries, in the parentheses after it, the text to grep for on the cited line.
     Trust the anchor over the number; when you edit `monitor.mjs`, re-pin the numbers here.
   Practically: when distributions have stopped, read `paused()` first for the current state, then read
   the `PausedSet` log for who set it and when. The chain will tell you both.

### §V58 `v2_mon_route_wiring` (error), `v2_mon_route_decode` (error)
INTERFACE_VERSION 8 replaced `UniV3PayoutAdapter` with a `PayoutRouter` that routes each asset over
Uniswap **v3 or a pinned hookless v4 pool**. `v2.contracts.payoutAdapter` keeps its name and now points at
the router; `markets[].v2.payoutRoute` publishes what each market's route should be —
`null` (no route: winning calls are paid in Stock Tokens), `{ venue: "v3", fee }`, or
`{ venue: "v4", fee, tickSpacing, poolId }`.

**`v2_mon_route_decode` is the one to read first.** `IPayoutRouter.routes(address)` and
`UniV3PayoutAdapter.routes(address)` share selector **`0xd7409659`** and return different tuples. Decoding
one with the other's shape **does not revert** — it reads the venue enum as a pool address. So the monitor
identifies the contract before decoding (only the adapter answers `factory()`), and on a disagreement
between the registry's `interfaceVersion` and what is deployed it **stops the route checks** rather than
publishing a wrong address. Fix the registry or the deployment; do not "read past" this alert.

**`v2_mon_route_wiring`** compares the decoded route with the registry, key by key:

| key | what differs |
|---|---|
| `:unpublished` | a route on chain that the registry does not publish |
| `:missing` | the registry publishes a route and the chain has none — every in-the-money call is paid in kind. Safe, and not what the registry says |
| `:venue` | v3 against v4 |
| `:fee` | a different fee tier is a different pool |
| `:tickSpacing` | with the same currencies and fee, a different tick spacing is a different **pool id** |
| `:poolId` | the id the registry pins is not what its own `PoolKey` hashes to. **A v4 pool has no address: the id is the only pin there is**, so nothing else would catch this |
| `:tier` | a fee tier above `MAX_ROUTE_FEE_TIER` (10,000) |
| `:feeBps` (warn) | the cached route fee is above `MAX_ROUTE_FEE_BPS` (100), which is all the Clearinghouse counts into a floor — so a conversion that just clears the floor still leaves the holder short |

1. `cast call $ROUTER "routes(address)((uint8,uint24,int24,address,uint16))" $ASSET --rpc-url $RH_RPC` —
   venue 0 none, 1 v3, 2 v4.
2. `node ops/markets/build-markets.mjs --check` recomputes every v4 pool id from its key.
3. Setting a route is `CONFIG_ADMIN` (24 h); **clearing one is `GUARDIAN` and instant**, on purpose, so a
   bad venue can be pulled with no delay while route changes wait.

→ [`incident-v2.md` §3](runbooks/incident-v2.md), [§5](runbooks/incident-v2.md).

### §V59 `v2_mon_mint_fee_charged` — P1 (error) / P2 (warn, a market not enabled yet)
**This is §V47 inverted.** Under INTERFACE_VERSION 7 the writer fee *was* collateral rent and the alert
fired when a market charged **none**. INTERFACE_VERSION 8 replaced it with the OrderBook's 5 % seller fee
on a first sale and switched rent off, so the alert fires when rent **is** charged. Both live in the
monitor and it chooses by the registry's `v2.interfaceVersion`, because the same binary also watches the
frozen v7 run-off deployment through `ops/markets/v7-legacy.json`.

- key `<asset>:chain` — the Clearinghouse's `market(underlying).mintFeePpm` is non-zero. Every series
  created while it stays non-zero is **pinned at that rate for its whole life**, so the longer it stands
  the more series carry it. `setMarketFees(underlying, exerciseFeeBps, 0)` is the `MARKET_FEE_MANAGER`
  lane — **72 h** — so the fix is not instant and the series already created are not fixed at all.
  **warn** instead of error while the market is not enabled: no series can be created at that rate yet.
- key `<asset>:registry` — the registry the monitor is running against publishes a non-zero rate while
  declaring interface 8. `build-markets.mjs --check` refuses that; this catches a registry that never went
  through the gate. The message says whether `v2.fees.allowRent` is true, which is the flag that would
  have let it through on purpose.
- key `<longId>:series` — a live series pinned at a non-zero rate. This one cannot be fixed by any
  setting: the rate is fixed at creation.

1. `cast call $CH "market(address)((bool,bool,uint64,uint16,address,uint32))" $ASSET --rpc-url $RH_RPC` —
   the sixth field is the rate.
2. `cast call $CH "defaultMarketFees()(uint16,uint32)" --rpc-url $RH_RPC` — the default new markets take.
3. `node ops/markets/build-markets.mjs --check` for the registry half.

→ [`incident-v2.md` §9](runbooks/incident-v2.md).

### §V60 `v2_mon_token_pool_fee` (error), `v2_mon_token_pool_depth` (warn)
The STONKHOUSE pool the buyback swaps in. It is a **hookless** Uniswap v4 pool by design: a hook can take
a cut of, or reorder, every swap, and `V2Constants.MAX_HOOK_FEE_BPS` (300 bps) is the most LP fee the
design tolerates before a buyback stops being worth making.

**`v2_mon_token_pool_fee`** — `shared.token.poolKey.hooks` is not the zero address, the fee tier is above
300 bps, or `shared.token.poolId` is not what `shared.token.poolKey` hashes to. The last one matters most:
a v4 pool has no address, so the id is the only pin there is.

**`v2_mon_token_pool_depth`** — the pool's usable depth is below `--threshold tokenPoolMinDepth=<usdg6>`,
**or is unknown while that threshold is set**. An unknown depth is not a deep pool, the same rule the
source-age limits use (§V50). The depth is v4 `PoolManager` state and the registry publishes no
PoolManager address, so today it is always unknown: the threshold is **off by default** and turning it on
without a readable PoolManager will page. That gap is deliberate and recorded, not hidden.

1. `node -e 'const r=require("./ops/markets/tier1.json");console.log(r.shared.token)'`
2. Recompute the id: `cast keccak $(cast abi-encode "f(address,address,uint24,int24,address)" $C0 $C1 $FEE $TICKSPACING 0x0000000000000000000000000000000000000000)`
3. A pool with the wrong key is not a pool to fix — it is a different pool. The route to a correct one is
   a new `shared.token.poolKey` and a buyback executor pointed at it (`setBuybackExecutor`, `TREASURY_ADMIN`,
   24 h).

### §V61 `v2_mon_tvl_audit_trigger` — P2 (warn, half) / P1 (error, at or past)
Owner decision V3-D33 commissions an external audit at **$1M of value locked**. Commissioning one takes
weeks, so this is the notice, not the deadline: it pages once at half the trigger and again at it.

"Value locked" here is the **USDG the protocol's own contracts hold** (Clearinghouse + MakerVault). If any
one of those balances cannot be read the monitor reports **unknown and pages nothing**, rather than a
partial sum — a TVL that silently omits the vault would page late, which is the one thing this notice must
not do.

It is **off by default** (`auditTriggerUsdg` 0) for the same reason `--divergence-band` is: the figure is
not the uncertain part, the definition is, and no owner decision pins which contracts count. Production
sets it explicitly:

```
--threshold auditTriggerUsdg=1000000000000     # $1,000,000 in USDG base units (6 decimals)
```

1. `cast call $USDG "balanceOf(address)(uint256)" $CH --rpc-url $RH_RPC` and the same for `$VAULT`.
2. Confirm with the owner what the trigger is meant to count before treating the number as the decision.
3. The audit itself is `OWN8-12`; its findings are fixed by `C8-14`.

### §V62 `v2_mon_reprice_floorward` (error), `v2_mon_reprice_foreign_sender` (error), `v2_mon_repriced` (warn) — the PRICER lane moved a writer's ask
SEC-13 / T-OP-063: `AutoRoller.reprice` may lower an ask by at most `MAX_REPRICE_DROP_BPS` (25 %) per call
(`AutoRoller.sol:138`), so a leaked PRICER key needs several calls to reach a writer's floor
(`MIN_ASK_BPS`, 0.5 % of spot) instead of one — and the contract's own NatSpec (`:134`) says each of those
calls pages. This is that page. The monitor scans `Repriced(writer, underlying, oldOrderId, newOrderId,
price)` inside the ordinary protocol log scan (no extra `eth_getLogs`; the range is the scan's, bounded by
its cursor and `logChunkBlocks`, never unbounded — §0), remembers the ask each roll rested and each reprice
set, and judges every new reprice against the price it replaced:

- **`v2_mon_reprice_floorward` (P1):** the drop is at least `repricePageDropFraction` (default 0.8) of the
  per-call cap — 20 % or more of the ask in one call. An honest pricer following the market moves in small
  fractions; a key walking to the floor sends maximal steps. Each further step pages again.
- **`v2_mon_reprice_foreign_sender` (P1):** the transaction's `from` is not `v2.bots.pricer` from the
  registry (one `eth_getTransactionByHash` per log). Either another key holds PRICER or the registry is
  stale; both are worth a page. With no pricer key in the registry this condition is not judged and the
  warn says so.
- **`v2_mon_repriced` (P2):** every other reprice, individually up to `repriceWarnCap` (default 3) per run,
  the rest folded into one summary warn so a busy pricer cannot bury a page.

A reprice whose previous price the scan never saw (a position rolled before the scan's first block) cannot
be judged for the drop; it still warns, and the message says so.

1. `cast tx <data.transactionHash> --rpc-url $RH_RPC`: `from` is `data.sender`; compare with the registry's
   `v2.bots.pricer` (`data.pricerKey`). A sender nobody owns is a leaked key: **revoke PRICER** through
   OPS_ADMIN (delay 0), `incident-v2.md` §5.
2. The ask now: `cast call $BOOK "getOrders(uint256[])" "[<data.newOrderId>]" --rpc-url $RH_RPC` — price against
   the writer's floor, `AutoRoller.MIN_ASK_BPS` of spot (§V44 for the spot). Below the writer's own `minAskBps`
   is impossible on chain (`BadPrice`, and a step past the cap is `RepriceDropExceeded`); at it, the premium is gone and the principal is safe.
3. The walk so far: `cast logs --address $ROLLER "Repriced(address,address,uint256,uint256,uint128)" --from-block
   $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC` — one line per step; count them
   against `repricePageDropFraction`.
4. A floor-ward step from the REGISTRY pricer key is the pricer's own bug or a compromised pricer host: stop the
   pricer service first (§V51 goes quiet, which is expected), then read its `/state`.

→ Tune with `--threshold repricePageDropFraction=<0..1>` and `--threshold repriceWarnCap=<n>`. Do not raise the
fraction above 1: nothing on chain can exceed the cap, so a page would never fire.
