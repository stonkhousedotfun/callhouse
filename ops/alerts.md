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

There are **thirteen kinds**, listed in the index below — that is the whole vocabulary, and it is
what a relay or a human must key on. The payload `severity` is `info | warn | error`; the P-level
mapping is per kind in the index. Delivery dedupes per `kind:dedupeKey` for one hour
(`KEEPER_ALERT_COOLDOWN_MS`); a **failed** delivery is retried in five minutes, not held for the
hour. State changes (`boot`, `roll_open`, `roll_close`, an on-chain revert) fire with `force` and
are never suppressed.

**Transport:** `ALERT_WEBHOOK` is a generic JSON POST. Telegram and Discord do not accept this
shape directly — a raw Discord URL returns 400 forever and you will see nothing. `ALERT_WEBHOOK`
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
  is logged by the relay, not retried — a retry would duplicate the message where it landed); 502
  when every target refused, timed out (`RELAY_TIMEOUT_MS`, default 5 s, under the keeper's 10 s
  abort) or was unreachable — so the keeper's five-minute retry applies; 401 wrong/missing token;
  400 not a keeper alert. `kind` is not an enum on the relay side, so a new kind still arrives.
- **Silence is the failure mode.** A relay with a wrong token, a deleted Discord webhook, or a bot
  removed from its chat looks exactly like a quiet week. The Saturday webhook test below is the
  control; `ops/deploy.md` §12.4 is the one-line test.

**Health endpoint:** `GET /health` on `KEEPER_PORT` (default 8787). 200 `ok`/`degraded` while the
keeper ticks (degraded covers low gas, RPC lag, a slow in-flight transaction); 503 `wedged` only
when no tick has started or completed in three poll intervals *and* no tick is currently running
younger than the tx timeout. Unauthenticated; RPC URLs are served redacted to their origin.

## Severity

| Payload | P-level | Meaning | Response |
|---|---|---|---|
| `error` | **P1/P2** | A transaction reverted, the book is wrong, the cycle is stuck | Per kind, below |
| `warn` | **P2/P3** | The vault is behaving correctly but something around it is not | Within the hour |
| `info` | **INFO** | Expected behaviour worth recording | None. Several feed the weekly publish |

**An unfilled week is INFO, not an alert.** It is the most likely outcome, the product promises to
publish it honestly, and paging somebody about it trains everyone to ignore the channel.

## Shell prelude for every "first three checks" block

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_RPC_2=https://robinhood-rpc.publicnode.com
export REGISTRY=0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA
export CLEAR=0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
export FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
export VAULT=<from ops/addresses.json>
```

---

## Index — what the keeper emits

| kind | Payload sev | P | Fires when | Runbook |
|---|---|---|---|---|
| `tx_revert` | error | P2 | A keeper tx would revert / failed submission / reverted on chain (`force`). `data.kind` names the tx: `rollOpen`, `approveListing`, `cancelListing`, `invalidateAllListings`, `lockBook`, `rollClose` | §1 |
| `api_reject` | error | P2 | Overcall POST rejected (status in `data.status`, 401 included), book says `unfillable`, the 3-listing cap is exhausted, the on-chain hash differs from the built order, the vault shows a listing this keeper cannot serve, or the ERC-1155 approval is missing at boot (`force`) | §2 |
| `listing_invisible` | error | P2 | Authorised on chain, absent from Overcall's book after `KEEPER_LISTING_VISIBLE_MS` (default 15 min) | §3 |
| `phase_stuck` | error | P1 | Past expiry + 1h and the vault is still not `Idle` | §4 |
| `keeper_error` | error | P2 | A tick threw, or an unhandled rejection | §5 |
| `oracle_paused` | warn | P2 | Issuer flipped `oraclePaused()` | §6 |
| `valorem_fees_enabled` | warn | P2 | Valorem's 15 bps notional fee turned on; the vault has already stopped writing | §7 |
| `low_gas` | warn | P2 | Keeper ETH below `KEEPER_MIN_GAS_WEI` (default 0.01) | §8 |
| `rpc_lag` | warn | P2 | Head block trails the wall clock, or both RPC endpoints are unreachable | §9 |
| `no_rung` | info (**warn** for `stale-oracle`) | INFO/P2 | The week is being skipped; `data.reason` says why: `no-rung-in-band`, `premium-above-strike`, `stale-oracle: …`, `writes-halted`, `no-keeper-role`, `valorem-fees-enabled`, `oracle-paused`, `no-idle-collateral` | §10 |
| `boot` | info (**warn** if no KEEPER_ROLE) | INFO | Process online and reconciled. Warn variant: the key can close but not open | — |
| `roll_open` | info, `force` | INFO | Cycle opened: strike, contracts, price, tx hash in `data` | — |
| `roll_close` | info, `force` | INFO | Week closed: summed gross/fee/net plus `premiumUsdg` / `strikeProceedsUsdg` in `data`; an assigned week's message names premium and strike proceeds separately. Emitted by the keeper's own close AND by the boot reconciliation when someone else closed the week | [payload](#roll_close--info-payload-and-message) |

## Index — conditions this file covers that the keeper does NOT emit

These need an external watcher, a weekly runbook step, or surface inside another kind. None of
them will ever arrive as a webhook with the old SCREAMING_CASE code; that vocabulary is retired.

| Condition | How it actually reaches you | Runbook |
|---|---|---|
| Keeper down / heartbeat missed | External uptime monitor on `/health` (503) — **not yet stood up**; until then, Railway restart notifications | §11 |
| One RPC endpoint down (the other works) | Silent by design (fallback). Both down → `rpc_lag` | §9 |
| Two RPCs disagree | Not monitored — no comparison logic exists | §12 |
| Registry cycle replaced under a live position | `rollOpen`/`approveListing` reverts → `tx_revert` with `OptionNotApproved` / `OptionNotInCurrentCycle` | §13 |
| Feed stale while market is closed | Expected; no alert. A `stale-oracle` warn during the cash session is the broken-feed case | §14 |
| Seaport counter moved under a live listing | Keeper re-reads the counter and relists; a deliberate invalidation surfaces as `api_reject` (cap/hash) or `tx_revert` (`BadCounter`) | §15 |
| Fill / partial fill | No alert. `/cycles`, the indexer, and the `roll_close` sums carry it | §16 |
| Assignment detected | No alert. Weekly check in `close-week.md` | §17 |
| Book not locked at exercise | No alert. `rollClose` accepts `Listed` and invalidates the listing itself | §18 |
| Redeem reconciliation | No alert. Manual check, `close-week.md` §4 — do not publish a number until it balances | §19 |
| Harvest zero / split across events | No separate kind: `roll_close` carries the cycle-summed gross/fee/net | §20 |
| Stock Token transfer fails (issuer freeze) | The failing tx reverts → `tx_revert`; deposits fail in the dapp | §21 |
| Writes halted by guardian | Warn log per tick; `no_rung` at window close with `reason: writes-halted` — treat as key compromise until owned | §22 |
| Role or policy changed | No alert. Every legitimate change is a planned Safe transaction; review the Safe queue | §23 |
| Deposit cap reached | No alert. Working as intended | §24 |
| Settled epoch unclaimed 30 days | No alert. Periodic `epochs()` review | §25 |
| Indexer behind head | No alert — the indexer has no webhook. External monitor on its `/v1/health` (lag in blocks and seconds; Ponder's own `/health` only says the process is up) — **not yet stood up** | §26 |
| Keeper gas truly empty (cannot pay for `rollClose`) | No separate kind. `low_gas` at 0.01 is the only gas alert; past expiry + 1h anyone can close | §8 |

---

## Emitted kinds — first three checks

### §1 `tx_revert` — P2 (error)
A keeper transaction would revert, failed submission, or reverted on chain. `data.kind` names the
transaction; the revert reason is in `data.reason` or decodable from `data.hash`. Decode it rather
than guessing:

| Error | Meaning |
|---|---|
| `WrongPhase(0, n)` | Last week is not closed |
| `WritesAreHalted()` | Guardian or admin halted — see §22 |
| `WritingNotOpen()` | Past the write deadline, or no cycle set |
| `NoCycle()` | `cycleNumber == 0` |
| `OptionNotApproved(id)` / `OptionNotInCurrentCycle(...)` | Ladder changed — see §13 |
| `ValoremFeeNotAccepted(15)` | See §7 |
| `OraclePaused()` / `StalePrice(...)` | See §6 / §14 |
| `StrikeBelowBand` / `StrikeAboveBand` | The picked rung left the band between read and send |
| `ContractsAboveUtilization` / `ContractsAboveCap` / `ContractsZero` | Sizing |
| `BadFeeSplit` / `OvercallFeeRoundsToZero` / `PremiumNotDivisibleByOrderSize` / `BadCounter` / `ListingOutlivesExercise` / `OfferExceedsInventory` / `PremiumBelowMinimum` / `PreviousListingLive` / `TooManyListings` | `approveListing` — the order builder or a live predecessor |

1. `cast run <txhash> --rpc-url $RH_RPC` to decode
2. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC` and `"writesHalted()(bool)"`
3. `cast call $REGISTRY "isWritingOpen()(bool)" --rpc-url $RH_RPC`

→ Most of these are the gate working. Fix the input and retry; the write window is days long. A
fee-split revert means the **builder** is wrong: fee is floored per contract then multiplied. Fix
the builder, do not tune the number until it passes. `open-week.md` §6.

### §2 `api_reject` — P2 (error)
Six call sites share this kind; `data` says which:

- **POST rejected** — non-2xx from `POST /api/orders`; `data.status` holds the code. 400 schema,
  409 counter/duplicate, 422 an on-chain fact, 429 rate limit. **401 is the design question**:
  Overcall refused the vault's signature shape. Their docs state check 8 as "the signature
  verifies for offerer (**EOA or ERC-1271**)" and their bundled viem does the 1271 fallback, but we
  have never seen a contract offerer accepted in production. Confirm the body carried a 65-byte
  signature, then `cast call $VAULT "isValidSignature(bytes32,bytes)(bytes4)" <digest> 0x
  --rpc-url $RH_RPC` — must return `0x1626ba7e`. Fall back to our own surface, open the
  conversation with Overcall. **Do not respond by moving the option tokens to an EOA** — that
  hands a hot key custody of depositor collateral and needs an explicit Admin decision.
- **Network error** — `data.status: 0`, their API unreachable while the chain is fine. Their API
  is a distribution channel; the chain is the product. Keep rolling, publish the payload on
  `/vault/nvda/cycle`, the retry loop self-heals.
- **`unfillable`** — their book flipped the row; almost always the 1155 balance or the Seaport
  approval. `cast call $CLEAR "balanceOf(address,uint256)(uint256)" $VAULT <optionId>` and
  `"isApprovedForAll(address,address)(bool)" $VAULT $SEAPORT`. It recovers on its own once the
  on-chain fact is true again; if `isApprovedForAll` is false the deploy was wrong — escalate.
- **Cap exhausted / hash mismatch / unservable listing / approval missing at boot** — all four
  mean the keeper's view and the chain's view have diverged. `cast call $VAULT
  "listingHash()(bytes32)"` and `cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,
  uint256)" <hash>` first. The keeper self-recovers an unservable listing with
  `invalidateAllListings` + relist (once per hash per boot); repeated alerts mean the recovery
  itself is reverting.

**If `isValidated` is true the order is fillable regardless** of what the POST did — publish the
payload ourselves. The POST is idempotent. `open-week.md` §7.

### §3 `listing_invisible` — P2 (error)
Authorised on chain, and 15 minutes later the listing is not in their book. Their rows re-sync
against chain if older than 30 s, so a GET is a real check, not a cache read.

1. `curl -sS "https://overcall.finance/api/orders?offerer=$VAULT&status=open" | jq '.listings[].orderHash'`
2. Compare to `cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC`
3. `curl -sS "https://overcall.finance/api/orders/<orderHash>" | jq '.listing.status'`

→ Re-POST (idempotent — the keeper's retry loop does this itself while the row is unserved). If it
still does not appear, fall back to our own surface. An invisible listing is an unfilled week.

### §4 `phase_stuck` — P1 (error)
Past `expiry + 1 hour` and the vault is still not `Idle`. Depositors' money is sitting behind an
unredeemed claim.

1. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC`
2. `cast call $VAULT "cycleExpiryTs()(uint40)" --rpc-url $RH_RPC` vs `cast block latest -f timestamp`
3. `cast call $NVDA "paused()(bool)" --rpc-url $RH_RPC` — is settlement blocked by the issuer?

→ **Anyone can call `rollClose()` now.** Do it. If it reverts inside the token, that is §21. The
keeper reconciles a close it did not witness at boot (sums the harvest from logs, fires
`roll_close`), so the record self-heals once the process is back.

### §5 `keeper_error` — P2 (error)
A tick threw, or an unhandled rejection. `data.reason` carries the message. The process is alive
(the alert itself proves it), so:

1. Read the keeper logs around the timestamp — the same line is logged at error level
2. `curl -sS http://<keeper host>:8787/health` — heartbeat, gas, RPC lag, phase
3. If it repeats every minute: the tick body is failing deterministically; the hourly dedupe means
   the webhook shows it once — the logs have every instance

→ The weekly cadence is protected by the permissionless paths (`lockBook`, `rollClose` at
expiry + 1h) even if the keeper never recovers. A reboot is safe at any point: boot reconciles
from chain, including closing out a cycle someone else closed.

### §6 `oracle_paused` — P2 (warn)
`NVDA.oraclePaused()` returned true. `rollOpen` reverts `OraclePaused()`.

1. `cast call $NVDA "oraclePaused()(bool)" --rpc-url $RH_RPC`
2. `cast call $NVDA "paused()(bool)" --rpc-url $RH_RPC` — is this the milder flag or a full freeze?
3. `cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC` — is Chainlink still publishing?

→ An issuer broadcast flag; Chainlink keeps publishing regardless. The vault holds spot and writes
nothing. Skipped week, not a freeze. If `paused()` is also true, escalate to
`ops/runbooks/incident.md` §5.

### §7 `valorem_fees_enabled` — P2 (warn)
`clear.feesEnabled()` flipped to true. 15 bps of **notional**, no timelock.

1. `cast call $CLEAR "feesEnabled()(bool)" --rpc-url $RH_RPC`
2. `cast call $CLEAR "feeBps()(uint8)" --rpc-url $RH_RPC`
3. `cast call $VAULT "valoremFeeAccepted()(bool)" --rpc-url $RH_RPC`

→ The vault has already stopped writing (`ValoremFeeNotAccepted`) — that is why this is a warn,
not a page: nothing is at risk, the week is simply skipped until governance acts. Resuming needs
an explicit Admin Safe decision, and the arithmetic first — at a 0.40% premium floor, a 0.15%
notional fee is ~37% of the floor. `ops/runbooks/incident.md` §6.

### §8 `low_gas` — P2 (warn)
Keeper balance below `KEEPER_MIN_GAS_WEI` (default 0.01 ETH; the message reads ETH, `data` carries
raw wei). There is no separate "gas empty" alert — this one is the whole ladder.

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

→ One endpoint down alone is silent by design — reads and sends fail over. Both down: the keeper
cannot transact; `/health` shows `degraded` while ticks still attempt, then `wedged` if they stop
completing. **The indexer cannot use the backup** — it rejects `eth_getLogs` over old ranges — so
history goes stale and the site should say so. `ops/runbooks/incident.md` §8.

### §10 `no_rung` — INFO, or P2 (warn) for `stale-oracle`
The week is being skipped; `data.reason` says why:

- `no-rung-in-band` / `premium-above-strike` — routine. The ladder is flat 5.00 USDG rungs against
  a moving spot; a 3% move pushes rungs out of the band from either end. Publish `no eligible
  rung, unfilled, 0`.
- `stale-oracle: …` — **warn, while the window is still open.** If the US market is shut this is
  expected (the `us_equities_24/5` feed stops; measured gaps: 17 h 37 m intra-week, 52 h weekend,
  78 h three-day; `maxPriceAge` is days for this reason). If the market is open, the feed is
  genuinely broken — or the chain is stalled: chain 4663 has no Chainlink sequencer-uptime feed,
  so a sequencer stall surfaces exactly here. `ops/runbooks/incident.md` §7.
- `writes-halted` — see §22. `no-keeper-role` — the boot warn told you already. `no-idle-collateral`
  — everything is queued for withdrawal; check the exit queue.
- At window close unwritten, a forced `no_rung` records the skipped week whatever the reason.
- If Overcall simply never set a new cycle (`CYCLE_NOT_ROLLED` in the old vocabulary): their cycles
  are created **by hand by an operator** — their own docs say "no keeper, no bot, no scheduled
  roll". Only one cycle has ever been set on this registry, so the weekly cadence is stated
  intent, not observed history. Publish `no cycle, unfilled, 0`. `open-week.md` §1.

### `roll_close` — INFO: payload and message
No action; it feeds the weekly publish. On an assigned week the vault's `Harvest.grossUsdg`
includes the strike proceeds (`RollClose.usdgFromAssignment`), which are returned principal and
carry no fee. Publishing the gross as "harvested" would show principal as yield, so the keeper
splits it: premium = gross − strike proceeds.

Message, by outcome (`<n>` the cycle, amounts in USDG to at most 6 decimals, trailing zeros dropped):

| Outcome | Message |
|---|---|
| Unfilled | `cycle <n> closed unfilled: 0 USDG harvested.` |
| Filled, nothing assigned | `cycle <n> closed: <gross> USDG harvested, <net> to depositors.` |
| Filled, assigned | `cycle <n> closed: premium <premium> USDG (fee <fee>), strike proceeds <proceeds> USDG from <k> contracts assigned; <net> USDG to depositors.` |
| Assigned, proceeds unknown (no `RollClose` in the receipt — unreachable with the deployed vault) | `cycle <n> closed: <gross> USDG gross including strike proceeds from <k> contracts assigned (premium/proceeds split unknown), <net> to depositors.` |

A close reconstructed at boot (someone else closed the week) appends ` The close ran without this
keeper witnessing it; reconstructed from chain logs.` to any of the four. Example, dry-run cycle 3:
`cycle 3 closed: premium 19.079259 USDG (fee 0.953962), strike proceeds 2025 USDG from 9 contracts assigned; 2043.125297 USDG to depositors.`

`data`:

| Field | Meaning |
|---|---|
| `cycleNumber` | The vault cycle |
| `grossUsdg` / `feeUsdg` / `netUsdg` | Every `Harvest` for the cycle, summed (§20). Gross includes strike proceeds |
| `premiumUsdg` | `grossUsdg − strikeProceedsUsdg`. `null` when the proceeds are unknown |
| `strikeProceedsUsdg` | `RollClose.usdgFromAssignment`; `"0"` when nothing was assigned, `null` when unknown |
| `assetsReturned` | `RollClose.assetsReturned`, underlying base units (wei) as a string; `null` when unknown |
| `contractsAssigned` | `RollClose.contractsAssignedCount` |
| `contractsAssignedSource` / `contractsAssignedFromClaim` | Keeper's own close only: where the count came from (`RollClose` \| `claim-preread` \| `unknown`) and its pre-close Valorem read |
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
`wedged`. The process is down, wedged, or the host is gone.

1. `curl -sS http://<keeper host>:8787/health`
2. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC` — is there a live position to babysit?
3. `cast call $REGISTRY "isWritingOpen()(bool)" --rpc-url $RH_RPC` — is a roll being missed right now?

→ `ops/runbooks/incident.md` §4. Nothing is at risk: `lockBook` is permissionless and `rollClose`
opens to anyone at expiry + 1h. Restarting a keeper mid-transaction is safe (boot reconciles, and
a tx that landed unwatched has its bookkeeping replayed from logs) — but check `/health` first: a
slow close holds a tick open and is **not** wedged.

### §12 RPC disagreement — not monitored
The two RPCs returning different state at the same block. Recon confirmed they agree byte-for-byte
on feed round data, so a disagreement is real — but no comparison logic exists in the keeper; this
is a manual check when something smells wrong.

1. Re-run the differing call against both with an explicit `--block <n>`
2. `cast block-number` on both — is one simply behind?
3. Third opinion: `https://stonkscan.io/address/<addr>` or Blockscout through `ops/bsproxy.js`

→ Do not send a transaction until they agree. Halt writes if a roll is pending.

### §13 Registry cycle replaced under a live position — surfaces as `tx_revert`
The registry's cycle number moved, or our written `optionId` stopped being approved, while we hold
a position. The keeper's next `rollOpen`/`approveListing` reverts `OptionNotApproved` /
`OptionNotInCurrentCycle`.

1. `cast call $REGISTRY "isApproved(uint256)(bool)" $(cast call $VAULT "optionId()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1) --rpc-url $RH_RPC`
2. `cast call $REGISTRY "cycleOf(uint256)(uint32)" <our optionId> --rpc-url $RH_RPC` vs `registry.cycleNumber()`
3. `cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC`

→ Our position is unaffected — it is a real Valorem option type that settles on its own terms —
but the rung is off Overcall's grid and their book will refuse new listings on it. Keep the
on-chain listing, publish the payload on our own surface, expect a thin week.
`ops/runbooks/incident.md` §9.

### §14 Stale feed, market closed vs market open — see §10
The `stale-oracle` warn fires regardless of market hours; interpreting it needs the clock.
`RHNVDA / USD` is a `us_equities_24/5` feed: it stops when the market closes and restarts at
00:00:54 UTC Monday. It is also why the keeper should prefer to roll during the cash session — a
passing gate is not the same as a useful price. `open-week.md` §2b.

### §15 Seaport counter moved — self-healing, surfaces only if deliberate
`seaport.getCounter(vault)` changed while a listing was live. Everything from this offerer is
dead; the keeper re-reads the counter live and rebuilds within the relist budget.

1. `cast call $SEAPORT "getCounter(address)(uint256)" $VAULT --rpc-url $RH_RPC`
2. `cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC`
3. `cast logs --address $VAULT $(cast keccak "AllListingsInvalidated(uint256)") --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC` — who bumped it?

→ If it was `lockBook` or `rollClose`, this is expected. If nobody bumped it deliberately,
escalate. Seaport 1.2+ bumps by a quasi-random amount, so the keeper always re-reads.

### §16 Fills — no alert by design
1. `cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC`
2. `cast call $VAULT "contractsSold()(uint112)" --rpc-url $RH_RPC`
3. `curl -sS "https://overcall.finance/api/orders/<orderHash>" | jq '{status,remaining,filledNumerator,filledDenominator}'`

→ Record for the publish. A partial fill leaves the remainder live at the same unit price — that
is what `PARTIAL_OPEN` is for. Do not relist cheaper to clear it. (The keeper reuses the previous
price lifted to the current policy floor, never below it.)

### §17 Assignment — weekly check
A `BucketAssignedExercise` or `OptionsExercised` touched our option type.

1. `cast call $VAULT "contractsAssigned()(uint256)" --rpc-url $RH_RPC` — **before** `rollClose`; it returns 0 after
2. `cast call $CLEAR "claim(uint256)((uint256,uint256,uint256))" $(cast call $VAULT "claimKey()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1) --rpc-url $RH_RPC`
3. `cast call $VAULT "contractsWritten()(uint112)" --rpc-url $RH_RPC`

→ Normal. Valorem assigns by bucket, pseudorandomly, so `0..N` of our contracts can be taken.
`amountWritten`/`amountExercised` are **1e18-scaled scalars** — divide before believing them.
Escalate only if `assigned > written`. `ops/runbooks/incident.md` §3.

### §18 Book not locked — untidy, not dangerous
Past `exerciseTimestamp` and `phase()` is still `1`. `lockBook()` is permissionless — anyone can
call it. `rollClose` accepts `Listed` too and invalidates any surviving listing itself, and both
closing paths DELETE the row from Overcall's book.

### §19 Redeem reconciliation — manual, before publishing
`underlyingReturned + assigned × strike` does not match what was written.

1. The vault's `ClaimRedeemed(claimKey, underlyingReturned, exerciseReceived)` from the close tx
2. The pre-close snapshot from `close-week.md` §1
3. `cast call $CLEAR "position(uint256)((address,int256,address,int256))" <claimKey> --rpc-url $RH_RPC`

→ **Do not publish a number.** Partial assignment is normal; an unreconcilable redeem is not.
Escalate to engineering. `RollClose.contractsAssignedCount` is a real number (the vault reads
`contractsAssigned()` before `_redeemClaim` zeroes `claimKey`) and is usable as evidence — but it
is the *same* read as the pre-close snapshot, so it agreeing with the snapshot proves nothing. The
independent number is `contractsWritten - underlyingReturned / 1e18` off the vault's
`ClaimRedeemed`; that is the one that has to agree. `close-week.md` §4.

### §20 Harvest accounting — why every number is a sum
`deposit`/`mint` run `_checkpointHarvest()`, so a fill followed by a deposit puts the premium on
an earlier `Harvest` and leaves the close's own event at `(0, 0, 0)`. Reading only the close's
event reports a filled week as unfilled. The keeper sums every `Harvest` carrying the cycle number
from the rollOpen block (recovered from the tx row or the `RollOpen` log) through the close block;
the indexer folds the same way; the web history reads the indexer's sum. The fee still leaves the
vault exactly once, from `rollClose`. On an assigned week the close's gross also carries the
strike proceeds (`RollClose.usdgFromAssignment`, fee-free): premium is gross minus that, and the
keeper records both (`roll_close` payload above, `GET /cycles`). `close-week.md` §5.

1. `cast logs --address $VAULT $(cast keccak "Harvest(uint32,uint256,uint256,uint256)") $(cast to-uint256 <cycle>) --from-block <rollOpen block> --rpc-url $RH_RPC`
2. `cast call $VAULT "pendingFeeUsdg()(uint256)" --rpc-url $RH_RPC` — must be 0 after close; non-zero means premium WAS taken this cycle
3. `cast logs --address $VAULT $(cast keccak "UsdgDistributed(uint256,uint256,uint256)") --from-block <rollOpen block> --rpc-url $RH_RPC`

### §21 Stock Token transfer fails — issuer freeze, surfaces as `tx_revert`
1. `cast call $NVDA "paused()(bool)" --rpc-url $RH_RPC`
2. `cast call $NVDA "transfer(address,uint256)(bool)" <any address> 1 --from $VAULT --rpc-url $RH_RPC`
3. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC` — is a claim outstanding?

→ Issuer freeze. Halt writes, publish within the hour, state precisely what still works (USDG
claims) and what does not (anything moving NVDA). There is no technical response.
`ops/runbooks/incident.md` §5.

### §22 Writes halted — treat as key compromise until owned
The `WritesHalted(bool)` event fired. The keeper logs a warn per tick and, at window close, fires
`no_rung` with `reason: writes-halted` — days after the fact. The runbook check is the early
warning.

1. `cast call $VAULT "writesHalted()(bool)" --rpc-url $RH_RPC`
2. `cast logs --address $VAULT $(cast keccak "WritesHalted(bool)") --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC` — who, and when?
3. `cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC`

→ If a human did it deliberately, acknowledge and move on. If nobody owns it, treat as a key
compromise until proven otherwise. Only the Admin Safe can unhalt.

### §23 Role or policy changed — Safe review is the control
No keeper alert exists for `RoleGranted`/`RoleRevoked`/`PolicyUpdated`/`MaxPriceAgeUpdated`/
`FeeRecipientUpdated`/`DepositCapUpdated`/`ValoremFeeAccepted`. Every legitimate change is a
planned Safe transaction — review the Safe queue and transaction history; an unplanned
`RoleGranted` is the most serious event in this file.

1. `cast logs --address $VAULT $(cast keccak "RoleGranted(bytes32,address,address)") --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC`
2. `cast call $VAULT "hasRole(bytes32,address)(bool)" 0x0000000000000000000000000000000000000000000000000000000000000000 <each admin> --rpc-url $RH_RPC`
3. `cast call $VAULT "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url $RH_RPC`

→ Confirm it was intended and that the keeper picked up the new bounds on its next poll.

### §24 Deposit cap reached — working as intended
`maxDeposit(address)` returned 0. Launch cap is 20 NVDA and it is deliberately not a TVL race.
Raising it is an Admin decision after published weeks, per the README's launch sequence.

### §25 Settled epoch unclaimed — periodic review
A settled epoch still holds balances a month later.

1. `cast call $VAULT "epochs(uint256)(uint256,uint256,uint256)" <epochId> --rpc-url $RH_RPC`
2. `cast call $VAULT "reservedAssets()(uint256)" --rpc-url $RH_RPC` and `"usdgReservedForQueue()(uint256)"`
3. Identify the holders from the `QueueRedeem` logs for that epoch

→ Nothing is stuck — `completeRedeem` works forever and the reserves are excluded from NAV so
nobody else's share price is inflated. Reach out to the depositor.

### §26 Indexer lag — external monitor (not yet stood up)
Ponder is behind head. The indexer has no webhook; point an uptime check at `/v1/health`, which reports
`lag.blocks` / `lag.seconds` and turns `degraded` when behind. Railway's own healthcheck uses `/ready`
(ready only after historical sync), which is right for deploys and wrong for lag monitoring.

1. `cast block-number --rpc-url $RH_RPC` vs the indexer's last processed block
2. Is the indexer pointed at the primary RPC? The publicnode backup rejects historical `eth_getLogs`
3. Indexer process logs

→ Chain state is unaffected. The web app's history is stale and should say so rather than serve
stale numbers as current.

---

## Routing

| Payload severity | Channel | Who |
|---|---|---|
| `error` | webhook, unmuted | Whoever is on the weekly rota; guardian if §4 or §21 |
| `warn` | webhook | Whoever is on the weekly rota, within the hour |
| `info` | webhook, log only | Nobody. Several feed the weekly publish |

Test the webhook every Saturday as part of `close-week.md`: with the relay, a failed delivery is
retried after five minutes and then suppressed for the hour — a silently broken relay looks
exactly like a quiet week. An alert channel nobody has seen fire is not an alert channel.
