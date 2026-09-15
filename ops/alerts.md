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

There are **fourteen kinds**, listed in the index below; that is the whole vocabulary, and it is what
a relay or a human must key on. `keeper/src/alerts.ts` (`AlertKind`) is the source of truth for the
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
| Stock Token transfer fails (issuer freeze) | The failing tx reverts → `tx_revert`; a close that hits it → `claim_stranded`; deposits fail in the dapp | §20 |
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
