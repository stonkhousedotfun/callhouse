# Runbook — Incidents

Ten failures worth having written down. Each one: **detect**, **do** (with the exact command and who
can run it), and **do not**.

Two rules that apply to every entry on this page:

1. **The guardian can stop things. It can never move anything.** `GUARDIAN_ROLE` gates exactly
   `haltWrites`, `cancelListing` and `invalidateAllListings`, plus `rollClose` from `expiry + 1h` like
   any other address. There is no guardian path to a token transfer. See `ops/safes.md` for how to
   verify that claim in the source yourself.
2. **Halting never blocks a depositor.** `writesHalted` blocks `rollOpen` and `approveListing` and
   nothing else. `queueRedeem`, `completeRedeem`, `claimUsdg`, `redeem`/`withdraw` while flat, and
   `rollClose` all keep working. If you are ever tempted to reach for something stronger than
   `haltWrites`, there is nothing stronger, and that is the design.

## Shell setup

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_RPC_2=https://robinhood-rpc.publicnode.com
export REGISTRY=0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA
export CLEAR=0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
export FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
export VAULT=<fill from ops/addresses.json after deploy>
```

Who can send what:

| Function | Keeper | Guardian | Admin Safe (2/3) | Anyone |
|---|---|---|---|---|
| `rollOpen(uint256,uint112)` | yes | no | no | no |
| `approveListing(components)` | yes | no | no | no |
| `cancelListing(components)` | yes | **yes** | no | no |
| `invalidateAllListings()` | yes | **yes** | no | no |
| `haltWrites()` | no | **yes** | yes | no |
| `unhaltWrites()` | no | **no** | yes | no |
| `lockBook()` | yes | yes | yes | **yes**, after `exerciseTimestamp` |
| `rollClose()` | yes, from expiry | yes, from expiry+1h | yes, from expiry+1h | **yes**, from expiry+1h |
| `setPolicy` / `setMaxPriceAge` / `setDepositCap` / `setFeeRecipient` / `acceptValoremFee` | no | no | yes | no |

---

## 1. Wrong strike listed

A listing went out against a rung that is not the one policy would have picked — wrong OTM distance,
or (worse) a rung from the wrong cycle or the wrong market.

### Detect
```bash
cast call $VAULT "optionId()(uint256)"        --rpc-url $RH_RPC
cast call $VAULT "cycleStrikeUsdg()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "cycleNumber()(uint32)"      --rpc-url $RH_RPC
cast call $REGISTRY "isApproved(uint256)(bool)" $(cast call $VAULT "optionId()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1) --rpc-url $RH_RPC
cast call $REGISTRY "cycleOf(uint256)(uint32)" $(cast call $VAULT "optionId()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1) --rpc-url $RH_RPC
cast call $VAULT "spotUsdg()(uint256)" --rpc-url $RH_RPC
```
Compute the band: `[spot6 * 1.03, spot6 * 1.12]` at launch policy. If the strike is outside it, the
listing should never have been authorised — `Policy.checkStrike` reverts `StrikeBelowBand` /
`StrikeAboveBand` — so an out-of-band strike means the spot moved *after* the roll, not that the gate
failed. That is normal and is **not** an incident.

The real incident is a strike from a rung that is no longer approved (`isApproved == false`), or a
`cycleOf` that does not match `cycleNumber`. That means Overcall replaced the ladder.

### Do
Kill the listing first, then stop the bleeding.

```bash
# Guardian OR keeper. Needs the exact components that were authorised:
cast send $VAULT "cancelListing((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256))" \
  "<the components as published>" --rpc-url $RH_RPC --private-key $GUARDIAN_PK

# If the components cannot be reconstructed — this is the guardian's blunt instrument and needs
# no order data at all:
cast send $VAULT "invalidateAllListings()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK

# Then stop any further writing this cycle:
cast send $VAULT "haltWrites()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```

Verify:
```bash
cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC   # 0x00..00
cast call $VAULT "writesHalted()(bool)"   --rpc-url $RH_RPC   # true
cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" <oldHash> --rpc-url $RH_RPC
# isCancelled true, or the counter moved so the hash is dead
```
Then record the cancellation with Overcall so their book stops showing it:
```bash
curl -sS -X DELETE "https://overcall.finance/api/orders/<orderHash>" -w '\nHTTP %{http_code}\n'
```

Unhalting is an **admin** action, after a human has decided why it happened:
```bash
cast send $VAULT "unhaltWrites()" --rpc-url $RH_RPC   # from the Admin Safe, 2/3
```

### Do NOT
- Do not try to "fix" the strike by writing a second position. `rollOpen` only runs from `Idle` and the
  cycle is already written; there is nothing to correct until `rollClose`.
- Do not DELETE on Overcall and stop there. Their DELETE does **not** delete — it records a cancellation
  and forces a chain re-read, and returns 409 with the row if Seaport still considers the order live. A
  hidden fillable order is worse than a visible one. Cancel on chain first, always.
- Do not have the guardian call `unhaltWrites`. It cannot, and asking it to is a sign the roles are
  being blurred.

---

## 2. Fill at a bad price

A listing filled well below what the week was worth.

### Detect
```bash
curl -sS "https://overcall.finance/api/orders?offerer=$VAULT&status=all" | jq '.listings[] |
  {orderHash, status, unitPrice6, quantity, remaining, filledNumerator, filledDenominator}'
cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
cast call $VAULT "contractsSold()(uint112)" --rpc-url $RH_RPC
```

### Do
**Nothing, on chain.** The fill is final. Seaport does not reverse, the premium is already in the vault,
and the depositors' claim on it is already correct.

What you actually do:
1. Publish the real number. A bad fill is still a filled week and the publish says so.
2. Raise `minPremiumBps` for the **next** cycle, from the Admin Safe, inside the on-chain caps
   (`MIN_PREMIUM_FLOOR_BPS = 10`, i.e. 0.10%):
```bash
cast send $VAULT "setPolicy((uint16,uint16,uint16,uint16,uint16,uint64))" \
  "(300,1200,<newMinPremiumBps>,9500,1000,50)" --rpc-url $RH_RPC   # from the Admin Safe
cast call $VAULT "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url $RH_RPC
```
3. Check whether the price was actually below the policy floor. If it was, the incident is a bug in
   `approveListing`'s premium check, not a market event — escalate to engineering, because
   `Policy.checkPremium` is supposed to make that unreachable.

### Do NOT
- Do not chase it by relisting the remainder cheaper. Every Overcall order is `PARTIAL_OPEN`; the
  unsold remainder is still live at the original unit price, and re-listing lower is how you turn one
  bad fill into a whole bad week. The cycle is capped at 3 listings for exactly this reason.
- Do not set `minPremiumBps` so high that the vault stops selling. A 0% week is an acceptable outcome;
  a policy that guarantees 0% weeks forever is not a fix.
- Do not touch `minOtmBps` in response to a price problem. It has a hard floor of 100 bps in the
  bytecode and lowering it is how an admin ends up selling at-the-money calls.

---

## 3. Assigned more than expected

The vault came back with far less NVDA and far more USDG than the fill count suggested.

### Detect
Before `rollClose` (this is why `close-week.md` step 1 snapshots first):
```bash
CLAIM=$(cast call $VAULT "claimKey()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1)
cast call $CLEAR "claim(uint256)((uint256,uint256,uint256))" $CLAIM --rpc-url $RH_RPC
cast call $VAULT "contractsAssigned()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "contractsWritten()(uint112)"  --rpc-url $RH_RPC
```
After: read the vault's own `ClaimRedeemed(claimKey, underlyingReturned, exerciseReceived)` and compute
`assigned = contractsWritten - underlyingReturned / 1e18`.

### Do
**Understand it before you call it an incident.** Valorem assigns exercise **by bucket**, pseudorandomly
across writers, not pro-rata. A vault that wrote `N` can be assigned anywhere from `0` to `N`, and being
assigned more than your share of the market's total exercise is a normal draw, not a bug. The adapter
accepts the full range and nothing asserts a 1:1 return.

Genuine incident conditions, in order of severity:
- `assigned > contractsWritten` → impossible; stop everything and escalate to engineering.
- `exerciseReceived != assigned * cycleStrikeUsdg` → the redeem does not reconcile; do **not** publish a
  number, escalate.
- `assigned == contractsWritten` with the vault now materially underweight NVDA → not a bug, a position.

For the underweight case the response is editorial, not technical. Publish, verbatim in substance:
*we were assigned, the vault is underweight NVDA, and v1 does not auto-rebuy — new deposits buy it back
passively.* Auto-rebuy is explicitly v2 and is not to be improvised during an incident.

Check what the vault is actually holding:
```bash
cast call $VAULT "totalAssets()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "convertToAssets(uint256)(uint256)" 1000000000000000000 --rpc-url $RH_RPC  # NVDA/share
cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
```

### Do NOT
- Do not buy NVDA with the assignment USDG. v1 has no swap path, the vault has no router, and doing it
  manually from a Safe puts a discretionary trade in the middle of a mechanical product.
- Do not size the next week off the assumption it will not happen again. Size off `idleAssets()`, which
  already reflects the smaller position.

---

## 4. Keeper dead mid-week

The hot key is gone, out of gas, or the process is down, and the vault is stuck in `Listed`.

### Detect
```bash
cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC
cast balance <keeper address> --rpc-url $RH_RPC
curl -sS http://<keeper host>:8787/health
```
Alert `KEEPER_HEARTBEAT_MISSED` fires first. See `ops/alerts.md`.

### Do
**Nothing is at risk. The vault was built so a dead keeper costs at most one week's premium.**

- `lockBook()` is **permissionless** after `exerciseTimestamp`. Anyone can call it:
```bash
cast send $VAULT "lockBook()" --rpc-url $RH_RPC --private-key <any funded key>
```
- `rollClose()` is keeper-only from `expiryTimestamp`, then **permissionless from `expiry + 1 hour`**:
```bash
cast send $VAULT "rollClose()" --rpc-url $RH_RPC --private-key <any funded key>
# before expiry+1h from a non-keeper this reverts GuardianTooEarly(expiry+3600) — that is correct
```
- If a listing is live and the components cannot be reconstructed because the keeper's SQLite is gone,
  the guardian kills it with no order data:
```bash
cast send $VAULT "invalidateAllListings()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```
- Halt writes so a half-recovered keeper does not roll into a cycle nobody is watching:
```bash
cast send $VAULT "haltWrites()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```

Recovery: refill gas (~0.05 ETH target), restart the process, confirm it re-derives state from chain
rather than from its own database, then `unhaltWrites()` from the Admin Safe.

If the key is **compromised** rather than dead, revoke before anything else — from the Admin Safe:
```bash
cast send $VAULT "revokeRole(bytes32,address)" \
  0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab <old keeper> --rpc-url $RH_RPC
cast send $VAULT "grantRole(bytes32,address)" \
  0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab <new keeper> --rpc-url $RH_RPC
cast call $VAULT "hasRole(bytes32,address)(bool)" \
  0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab <old keeper> --rpc-url $RH_RPC
```
A compromised keeper is bounded by design: it never holds the option ERC-1155, and `approveListing`
checks every field of a proposed order against vault state on chain, so it cannot list the inventory to
itself or for a dollar. The worst it can do is burn gas and write a bad-but-in-policy position.

### Do NOT
- Do not move the option tokens or the claim NFT anywhere to "rescue" them. The claim NFT is
  transferable and **whoever holds it at expiry gets the collateral** — moving it is how you actually
  lose the money. `redeem()` requires the caller to own it.
- Do not wait for the keeper before calling `rollClose`. After `expiry + 1h` anyone can, and depositors
  are entitled to it.
- Do not restore the keeper from a stale SQLite backup and let it act on it. Let it re-read chain state.

---

## 5. Issuer freezes the Stock Token

Robinhood Assets (Jersey) Limited can halt transfers of the Stock Token. This is disclosed and it cannot
be coded around.

### Detect
```bash
cast call $NVDA "paused()(bool)"        --rpc-url $RH_RPC
cast call $NVDA "oraclePaused()(bool)"  --rpc-url $RH_RPC
# a transfer simulation is the real test:
cast call $NVDA "transfer(address,uint256)(bool)" <any address> 1 --from $VAULT --rpc-url $RH_RPC
```
Symptom without a flag: `deposit`, `redeem`, `completeRedeem` and `rollOpen` all revert inside the token.

### Do
```bash
cast send $VAULT "haltWrites()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```
Then publish immediately and plainly: the issuer has frozen transfers, deposits and NVDA redemptions are
failing at the token, USDG claims are unaffected, and there is nothing the vault can do about it.

`claimUsdg()` keeps working through a freeze — it touches only USDG:
```bash
cast call $VAULT "claimableUsdg(address)(uint256)" <holder> --rpc-url $RH_RPC
```

If the freeze lands while the vault is written and a claim is outstanding, `rollClose` may itself revert
inside the token's transfer. There is no workaround. Wait for the freeze to lift, then close. Say that
out loud in the publish rather than letting people discover it by failing a transaction.

`oraclePaused()` is a different and milder thing: it is an issuer broadcast flag on the token, the vault
refuses to write while it is set (`OraclePaused()`), and Chainlink keeps publishing regardless. That one
is a skipped week, not a freeze.

### Do NOT
- Do not try to route around the token. There is no route.
- Do not tell depositors their money is safe in general terms. Tell them precisely which operations work
  (USDG claims) and which do not (anything moving NVDA).
- Do not unhalt until a transfer actually succeeds on chain.

---

## 6. Valorem fee switch flips on

`setFeesEnabled(true)` is owner-only on the clearinghouse with **no timelock**. The fee is 15 bps of
**notional**, not of premium, which on a weekly OTM call can exceed the entire premium.

### Detect
```bash
cast call $CLEAR "feesEnabled()(bool)" --rpc-url $RH_RPC   # was false
cast call $CLEAR "feeBps()(uint8)"     --rpc-url $RH_RPC   # 15
cast call $CLEAR "feeTo()(address)"    --rpc-url $RH_RPC   # 0xdAe7e82A2E7D566C67E87C164B05a1C560190782
cast logs --address $CLEAR $(cast keccak "FeeSwitchUpdated(address,bool)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 200000 )) --rpc-url $RH_RPC
```

### Do
**The vault has already stopped.** `rollOpen` reverts `ValoremFeeNotAccepted(15)` and `AdapterValorem`
reverts `ValoremFeesEnabled(15)`. No action is needed to be safe; action is needed to resume.

Do the arithmetic before deciding, on this week's real numbers:
```
valoremFee6 = contracts * lotSize * 15 / 10000   in NVDA terms, charged at write
            ~ 0.15% of notional
grossPremium6 = unitPrice6 * contracts
```
At a 0.40% minimum premium, a 0.15% notional fee eats **~37% of the floor premium**. That is a policy
decision, not a keeper decision, and the switch that resumes writing is deliberately separate:

```bash
# Admin Safe, 2/3, only after an explicit decision:
cast send $VAULT "acceptValoremFee(bool)" true --rpc-url $RH_RPC
cast call $VAULT "valoremFeeAccepted()(bool)" --rpc-url $RH_RPC
```

There is a second, mechanical consequence: `write()` pulls `underlyingAmount * n + fee` in a single
`transferFrom`, and Valorem floors the fee at 1 wei when it would round to zero. The adapter approves
the exact collateral, so the first write after a flip could revert on allowance even with the flag
accepted. Rehearse one write on a fork before resuming.

### Do NOT
- Do not set `acceptValoremFee(true)` as a reflex to clear a stuck roll. It is a separate switch
  precisely so that nobody can do that quietly.
- Do not compensate by lowering `minOtmBps`. Selling closer to the money to pay a fee is how a
  covered-call vault turns into a losing one.
- Do not assume the flip is permanent. Re-read `feesEnabled()` each cycle; the keeper does.

---

## 7. Sequencer or Overcall API down in the Friday window

### Detect — sequencer / chain
```bash
cast block-number --rpc-url $RH_RPC
cast block latest --rpc-url $RH_RPC -f timestamp    # compare against wall clock
```
**There is no Chainlink sequencer-uptime feed on 4663** — Chainlink's directory has 57 feeds and zero
uptime entries, and Overcall hardcodes `0x0`. The standard Arbitrum-style guard cannot be built here. A
stall shows up as `block.timestamp` not advancing and as a price that ages; it will never falsely read
"fresh", because the vault's staleness check is measured in chain time and stalls with it.

### Detect — Overcall API
```bash
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' 'https://overcall.finance/api/orders?market=NVDA'
curl -sS "https://overcall.finance/api/orders?offerer=$VAULT&status=open" | jq '.listings | length'
```

### Do
**The chain is the product; their API is a distribution channel.**

- If the chain is up but their API is down or rejecting: still do `rollOpen` and `approveListing`. Once
  `seaport.getOrderStatus(listingHash).isValidated == true`, the order is live and fillable by anybody
  with the payload, with or without Overcall:
```bash
cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" \
  $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC
```
  Publish the full Seaport payload on `/vault/nvda/cycle` so a buyer can fulfil from our own surface,
  and retry the POST with backoff. The POST is **idempotent** — re-posting an identical order hash
  returns 200 with the existing row — so retries are safe.
- On `429`, back off hard. The limits are 20 open listings per writer per chain plus a per-IP token
  bucket. Our cycle needs at most 3 POSTs; if we are seeing 429s, something is looping.
- If the chain itself is stalled: do nothing and wait. You cannot transact. Note that Overcall sized the
  exercise window to a full 24 hours (`MIN_EXERCISE_WINDOW == 86400`) for exactly this reason, and the
  write window runs for days, so a multi-hour outage costs nothing.
- If the outage runs past `exerciseTimestamp` with nothing listed, that is an `unfilled, 0` week.
  Publish it as one.

### Do NOT
- Do not skip `rollOpen` because the API is down. An on-chain-validated order with no Overcall row can
  still fill; an unwritten week definitely cannot.
- Do not POST from the web app's browser code as a workaround. The endpoint returns no
  `Access-Control-Allow-Origin` at all — it is server-to-server only.
- Do not widen the listing's `endTime` past `registry.exerciseTimestamp()` to "buy time". The vault
  rejects it (`ListingOutlivesExercise`) and Overcall's validator rejects it too.

---

## 8. RPC failure

### Detect
```bash
cast block-number --rpc-url $RH_RPC   || echo "PRIMARY DOWN"
cast block-number --rpc-url $RH_RPC_2 || echo "BACKUP DOWN"
```
Or a silent version of the same thing: two RPCs disagreeing on head, or one returning stale state.

### Do
Fail over to the backup for reads and sends:
```bash
export RH_RPC=https://robinhood-rpc.publicnode.com
```

Three things to know about the backup before you rely on it:

1. **It rejects `eth_getLogs` over old ranges** — `"Archive requests require a personal token"`. Calls,
   code reads, sends and recent-range logs are fine. **The indexer cannot run on it**; if the primary is
   down, the indexer is down and the web app's history is stale. Say so on the site rather than
   serving stale numbers as current.
2. **Both RPCs return HTTP 403 to a client that sends no `User-Agent`.** Python `urllib` does this by
   default. `curl` and `cast` are fine.
3. **Cross-check anything surprising on both** before acting on it. Recon confirmed the two agree
   byte-for-byte on the feed round data; a disagreement is itself the signal.

Explorer as a third opinion — but remember `robinhoodchain.blockscout.com` is behind a Cloudflare
managed challenge that keys on the **absence** of a `Referer` header. Any Referer value clears it:
```bash
curl -sS -H 'Referer: https://robinhoodchain.blockscout.com/' \
  'https://robinhoodchain.blockscout.com/api/v2/config/backend-version'
# or run the local proxy and point tools at 127.0.0.1:8546
node /Users/omaidfaizyar/Desktop/robinhood-dev/callhouse/ops/bsproxy.js &
curl -sS http://127.0.0.1:8546/api/v2/config/backend-version
```
`https://stonkscan.io/address/<addr>` is a non-Cloudflare display fallback.

### Do NOT
- Do not point the indexer at the publicnode backup and assume it is syncing. It will fail on historical
  logs, and it will fail in a way that looks like "no events".
- Do not build anything that depends on the Blockscout API without the Referer header or the proxy. It
  returns an HTML interstitial, not an error, so the failure looks like a parse bug.
- Do not send a transaction you have only simulated against one RPC when the two disagree on head.

---

## 9. Overcall replaces the cycle mid-week

Not in the original list, but it is real and it is cheap to watch for.

### Detect
```bash
cast call $REGISTRY "cycleNumber()(uint32)"   --rpc-url $RH_RPC
cast call $VAULT    "cycleNumber()(uint32)"   --rpc-url $RH_RPC
cast call $REGISTRY "canReplaceCycle()(bool)" --rpc-url $RH_RPC
cast call $REGISTRY "isApproved(uint256)(bool)" $(cast call $VAULT "optionId()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1) --rpc-url $RH_RPC
```

`setCycle` is `onlyOwner` on the registry and gated by `canReplaceCycle()`, which is true only while
**nothing** has been written on the current ladder. So once we have written, the ladder we wrote against
cannot be pulled out from under us. The window is narrow and specific: if Callhouse is the **first**
writer of the week, the owner can legally swap the ladder between the keeper's `cycle()` read and the
vault's `write()`.

### Do
Nothing — the vault already handles it. `rollOpen` re-checks `isWritingOpen()`, `isApproved(optionId)`
and `cycleOf(optionId) == cycle.number` **in the same transaction as the Valorem write**, and stores the
cycle number it acted on. A swapped ladder makes the roll revert `OptionNotApproved` or
`OptionNotInCurrentCycle`. Re-read the ladder and roll again.

If the swap happened *after* we wrote, our position is unaffected — we hold a real Valorem option type
that settles on its own terms — but our rung is no longer on Overcall's displayed grid and their book
will refuse new listings on it ("an off-grid id is never displayed and the book refuses listings on
it"). Keep the on-chain listing, publish the payload on our own surface, and expect a thin week.

### Do NOT
- Do not cache the ladder across the roll transaction and treat the keeper's read as authoritative. It
  is a proposal. The in-transaction re-check is the whole defence.
- Do not assume `canReplaceCycle() == false` means safe forever. It flips true again at expiry.

---

## Escalation

| Situation | Who |
|---|---|
| Anything needing `haltWrites`, `cancelListing`, `invalidateAllListings` | Guardian, immediately, no consultation required |
| Anything needing `unhaltWrites`, `setPolicy`, `acceptValoremFee`, a role change | Admin Safe, 2 of 3 |
| Redeem that does not reconcile, `assigned > written`, a policy gate that did not fire | Engineering. Do not publish a number until it is understood |
| Issuer freeze | Publish within the hour. There is no technical response |

The guardian is expected to act first and explain afterwards. Everything it can do is reversible by the
Admin Safe, and nothing it can do moves a token.
