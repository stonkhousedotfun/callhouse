# Runbook — Incidents

Eleven failures worth having written down. Each one: **detect**, **do** (with the exact command and
who can run it), and **do not**.

Three rules that apply to every entry on this page:

1. **The guardian can stop things. It can never move anything.** `GUARDIAN_ROLE` gates exactly
   `haltWrites`, `cancelListing` and `invalidateAllListings`, plus `rollClose` from `expiry + 1h` like
   any other address. There is no guardian path to a token transfer. See `ops/safes.md` §4 for how to
   verify that claim in the source yourself.
2. **Halting never blocks a depositor.** `writesHalted` blocks `rollOpen`, `approveListing` and every
   **fill** (`authorizeOrder` refuses) and nothing else. `queueRedeem`, `settleQueue`,
   `completeRedeem`, `claimUsdg`, `redeem`/`withdraw` while flat, `retryStrandedClaim` and
   `rollClose` all keep working. If you are ever tempted to reach for something stronger than
   `haltWrites`, there is nothing stronger, and that is the design.
3. **The vault never holds an unsold option token.** Every fill writes exactly what it buys inside
   Seaport's `authorizeOrder`. So "the inventory" is never at risk, because there is none, and
   assignment is bounded to what was sold.

## Shell setup

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_RPC_2=https://robinhood-rpc.publicnode.com
export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
export FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
export VAULT=<fill from ops/addresses.json after deploy>
export CLEAR=$(cast call $VAULT "clear()(address)" --rpc-url $RH_RPC)
```

Who can send what:

| Function | Keeper | Guardian | Admin Safe (2/3) | Anyone |
|---|---|---|---|---|
| `clear.newOptionType(...)` | yes | yes | yes | **yes** (permissionless on the clearinghouse) |
| `rollOpen(uint256 optionId)` | yes | no | no | no |
| `approveListing(components)` | yes | no | no | no |
| `cancelListing(components)` | yes | **yes** | no | no |
| `invalidateAllListings()` | yes | **yes** | no | no |
| `haltWrites()` | no | **yes** | yes | no |
| `unhaltWrites()` | no | **no** | yes | no |
| `lockBook()` | yes | yes | yes | **yes**, after `cycleExerciseTs` |
| `rollClose()` | yes, from expiry | yes, from expiry+1h | yes, from expiry+1h | **yes**, from expiry+1h |
| `retryStrandedClaim()` | yes | yes | yes | **yes**, whenever `isStranded()` |
| `settleQueue()` | yes | yes | yes | **yes**, while Idle with shares queued |
| `sweepFee()` | yes | yes | yes | **yes**, whenever `pendingFeeUsdg() > 0` |
| `authorizeOrder` / `validateOrder` | no | no | no | **Seaport only** (`NotSeaport`) |
| `setPolicy` / `setMaxPriceAge` / `setDepositCap` / `setFeeRecipient` / `acceptValoremFee` | no | no | yes | no |

---

## 1. Wrong strike armed

A cycle was armed against a strike that is not the one policy would have picked: wrong OTM
distance, wrong window, or a type whose tuple is not ours.

### Detect
```bash
cast call $VAULT "optionId()(uint256)"        --rpc-url $RH_RPC
cast call $VAULT "cycleStrikeUsdg()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "cycleExerciseTs()(uint40)"  --rpc-url $RH_RPC
cast call $VAULT "cycleExpiryTs()(uint40)"    --rpc-url $RH_RPC
cast call $VAULT "spotUsdg()(uint256)"        --rpc-url $RH_RPC
cast call $CLEAR "option(uint256)((address,uint96,address,uint96,uint40,uint40,uint160,uint96))" \
  $(cast call $VAULT "optionId()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1) --rpc-url $RH_RPC
```
Compute the band: `[spot6 * 1.03, spot6 * 1.12]` at launch policy. `rollOpen` checked **both**
bounds against the clearinghouse's own tuple in the arm transaction (`StrikeBelowBand` /
`StrikeAboveBand`, `OptionAssetMismatch`, `UnexpectedLotSize`, `ExerciseTooSoon`, `BadCycleWindow`),
so a strike outside the band now means spot moved *after* the arm, not that the gate failed. That is
normal and is **not** an incident: a rally makes the listing unfillable (§10), a sell-off makes it
cheap to the buyer but still inside what the vault accepted.

The real incident is a strike inside the band that the keeper should not have chosen (a
misconfigured `KEEPER_STRIKE_OTM_BPS`, a wrong window), or a keeper that armed while a human had
decided to skip the week.

### Do
Kill the listing first, then stop the bleeding.

```bash
# Guardian OR keeper. Needs the exact components that were authorised (the keeper's /orders serves them):
cast send $VAULT "cancelListing((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256))" \
  "<the components as published>" --rpc-url $RH_RPC --private-key $GUARDIAN_PK

# If the components cannot be reconstructed — the guardian's blunt instrument, needs no order data:
cast send $VAULT "invalidateAllListings()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK

# Then stop any further listing AND any fill this cycle:
cast send $VAULT "haltWrites()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```

Verify:
```bash
cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC   # 0x00..00
cast call $VAULT "writesHalted()(bool)"   --rpc-url $RH_RPC   # true
cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" <oldHash> --rpc-url $RH_RPC
# isCancelled true, or the counter moved so the hash is dead
```

Nothing was written unless somebody already filled; `contractsWritten()` tells you how much. The
armed cycle stays armed until `rollClose` after expiry: an unsold armed week closes with
`claimKey == 0`, redeems nothing and publishes `unfilled, 0`.

Unhalting is an **admin** action, after a human has decided why it happened:
```bash
cast send $VAULT "unhaltWrites()" --rpc-url $RH_RPC   # from the Admin Safe, 2/3
```

### Do NOT
- Do not try to "fix" the strike by arming a second type. `rollOpen` only runs from `Idle`; the cycle
  is armed and there is nothing to correct until `rollClose`.
- Do not leave a live listing while you think. A restricted order with the vault as zone is fillable
  by anyone with the payload as long as `isValidated` is true and the hook accepts. Cancel first.
- Do not have the guardian call `unhaltWrites`. It cannot, and asking it to is a sign the roles are
  being blurred.

---

## 2. Fill at a bad price

A listing filled well below what the week was worth.

### Detect
```bash
cast call $VAULT "contractsWritten()(uint112)"  --rpc-url $RH_RPC   # == sold
cast call $VAULT "listingGrossUsdg()(uint256)"  --rpc-url $RH_RPC
cast call $VAULT "listingAmount()(uint256)"     --rpc-url $RH_RPC
cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
cast logs --address $VAULT $(cast keccak "CallsWritten(uint256,uint256,uint112,uint256)") \
  --from-block <rollOpen block> --rpc-url $RH_RPC     # one per fill
```

### Do
**Nothing, on chain.** The fill is final. Seaport does not reverse, the premium is already in the
vault, and the depositors' claim on it is already correct.

What you actually do:
1. Publish the real number. A bad fill is still a filled week and the publish says so.
2. Raise `minPremiumBps` for the **next** cycle, from the Admin Safe, inside the on-chain caps
   (`MIN_PREMIUM_FLOOR_BPS = 10`, i.e. 0.10%):
```bash
# setPolicy replaces all six fields. Read policy() first and copy the other five from it; the
# tuple below is the launch policy (protocolFeeBps 500 = 5% of premium), not necessarily the live one.
cast call $VAULT "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url $RH_RPC
cast send $VAULT "setPolicy((uint16,uint16,uint16,uint16,uint16,uint64))" \
  "(300,1200,<newMinPremiumBps>,9500,500,50)" --rpc-url $RH_RPC   # from the Admin Safe
cast call $VAULT "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url $RH_RPC
```
3. Check whether the price was actually below the policy floor **at the fill**. The hook re-prices
   the floor at live spot (`PremiumBelowFloorAtFill`), so a fill under the floor is a bug in
   `ValoremLib.writeOnFill`, not a market event; escalate to engineering.

The known leakage is bounded and documented: a keeper (or the bootstrap admin) selling at the floor
to itself takes about 1.1% (2.2% for the admin) of **sold** notional per week at launch policy
(`contracts/SECURITY.md` §3). That is the whole bound; nothing reaches principal.

### Do NOT
- Do not chase it by relisting the remainder cheaper. The unsold remainder is still live at the
  original unit price, and re-listing lower is how you turn one bad fill into a whole bad week. The
  cycle is capped at 3 authorisations for exactly this reason.
- Do not set `minPremiumBps` so high that the vault stops selling. A 0% week is an acceptable
  outcome; a policy that guarantees 0% weeks forever is not a fix.
- Do not touch `minOtmBps` in response to a price problem. It has a hard floor of 100 bps in the
  bytecode and lowering it is how an admin ends up selling at-the-money calls.

---

## 3. Assigned more than expected

The vault came back with less NVDA and more USDG than the fill count suggested.

### Detect
Before `rollClose` (this is why `close-week.md` step 1 snapshots first):
```bash
CLAIM=$(cast call $VAULT "claimKey()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1)
cast call $CLEAR "claim(uint256)((uint256,uint256,uint256))" $CLAIM --rpc-url $RH_RPC
cast call $VAULT "contractsAssigned()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "contractsWritten()(uint112)"  --rpc-url $RH_RPC
```
After: read the vault's own `ClaimRedeemed(claimKey, underlyingReturned, exerciseReceived)` and
compute `assigned = contractsWritten - underlyingReturned / 1e18`.

### Do
**Understand it before you call it an incident.** Valorem assigns exercise across every writer of
the option type; every pre-exercise write shares bucket 0, so assignment is pro rata across all
writers of the id and **bounded to what the vault sold**. A vault that sold `N` can be assigned
anywhere from `0` to `N`; being assigned more than the market's average is a normal draw, not a
bug. Nothing asserts a 1:1 return.

Genuine incident conditions, in order of severity:
- `assigned > contractsWritten` → impossible by construction (write on fill); stop everything and
  escalate to engineering.
- `exerciseReceived != assigned * cycleStrikeUsdg` → the redeem does not reconcile; do **not**
  publish a number, escalate.
- `assigned == contractsWritten` with the vault now materially underweight NVDA → not a bug, a
  position.

For the underweight case the response is editorial, not technical. Publish, verbatim in substance:
*we were assigned, the vault is underweight NVDA, and v1 does not auto-rebuy; new deposits buy it
back passively.* Auto-rebuy is explicitly v2 and is not to be improvised during an incident.

Check what the vault is actually holding:
```bash
cast call $VAULT "totalAssets()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "convertToAssets(uint256)(uint256)" 1000000000000000000 --rpc-url $RH_RPC  # NVDA/share
cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
```

### Do NOT
- Do not buy NVDA with the assignment USDG. v1 has no swap path, the vault has no router, and doing it
  manually from a Safe puts a discretionary trade in the middle of a mechanical product.
- Do not size the next week off the assumption it will not happen again. Capacity is
  `Policy.maxContracts(totalAssets()) − contractsWritten()`, and `totalAssets()` already reflects
  the smaller position.

---

## 4. Keeper dead mid-week

The hot key is gone, out of gas, or the process is down, and the vault is stuck in `Listed`.

### Detect
```bash
cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC
cast balance <keeper address> --rpc-url $RH_RPC
curl -sS http://<keeper host>:8787/health
```
The external monitor on `/health` fires first (`ops/alerts.md` §11).

### Do
**Nothing is at risk. The vault was built so a dead keeper costs at most one week's premium.**

- A live listing keeps filling on its own terms: the vault's hook, not the keeper, writes and
  prices every fill. The keeper's `/orders` is what the fill page reads, so with the keeper down the
  page shows no payload; anyone who saved the payload can still fill through Seaport directly.
- `lockBook()` is **permissionless** after `cycleExerciseTs`. Anyone can call it:
```bash
cast send $VAULT "lockBook()" --rpc-url $RH_RPC --private-key <any funded key>
```
- `rollClose()` is keeper-only from `cycleExpiryTs`, then **permissionless from `expiry + 1 hour`**:
```bash
cast send $VAULT "rollClose()" --rpc-url $RH_RPC --private-key <any funded key>
# before expiry+1h from a non-keeper this reverts GuardianTooEarly(expiry+3600) — that is correct
```
- If a listing is live and the components cannot be reconstructed because the keeper's SQLite is
  gone, the guardian kills it with no order data:
```bash
cast send $VAULT "invalidateAllListings()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```
- Halt writes so a half-recovered keeper does not arm a cycle nobody is watching:
```bash
cast send $VAULT "haltWrites()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```

Recovery: refill gas (~0.05 ETH target), restart the process, confirm it re-derives state from chain
rather than from its own database, then `unhaltWrites()` from the Admin Safe.

If the key is **compromised** rather than dead, revoke before anything else, from the Admin Safe:
```bash
cast send $VAULT "revokeRole(bytes32,address)" \
  0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab <old keeper> --rpc-url $RH_RPC
cast send $VAULT "grantRole(bytes32,address)" \
  0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab <new keeper> --rpc-url $RH_RPC
cast call $VAULT "hasRole(bytes32,address)(bool)" \
  0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab <old keeper> --rpc-url $RH_RPC
```
A compromised keeper is bounded by design: it never holds an option token, `approveListing` checks
every field of a proposed order against vault state, and the hook re-prices every fill at live
spot. The worst it can do is burn gas and sell at the floor to itself (§2).

### Do NOT
- Do not move the claim NFT anywhere to "rescue" it. The claim NFT is transferable and **whoever
  holds it at expiry gets the collateral**; moving it is how you actually lose the money.
  `redeem()` requires the caller to own it.
- Do not wait for the keeper before calling `rollClose`. After `expiry + 1h` anyone can, and
  depositors are entitled to it.
- Do not restore the keeper from a stale SQLite backup and let it act on it. Let it re-read chain
  state.

---

## 5. Issuer freezes or blocklists the Stock Token

Robinhood Assets (Jersey) Limited can halt transfers of the Stock Token, blocklist an address, burn
supply (`adminBurn`) and change `uiMultiplier` (which can decrease). This is disclosed and it cannot
be coded around.

### Detect
```bash
cast call $NVDA "paused()(bool)"        --rpc-url $RH_RPC
cast call $NVDA "oraclePaused()(bool)"  --rpc-url $RH_RPC
# a transfer simulation is the real test:
cast call $NVDA "transfer(address,uint256)(bool)" <any address> 1 --from $VAULT --rpc-url $RH_RPC
```
Symptom without a flag: `deposit`, `redeem`, `completeRedeem` and every fill revert inside the token.

### Do
```bash
cast send $VAULT "haltWrites()" --rpc-url $RH_RPC --private-key $GUARDIAN_PK
```
Then publish immediately and plainly: the issuer has frozen transfers, deposits and NVDA
redemptions are failing at the token, USDG claims are unaffected, and there is nothing the vault
can do about it.

`claimUsdg()` keeps working through a freeze; it touches only USDG:
```bash
cast call $VAULT "claimableUsdg(address)(uint256)" <holder> --rpc-url $RH_RPC
```

**If the freeze lands while a claim is outstanding, the close strands the claim instead of
reverting** (§9). `rollClose` reaches Idle with the claim kept, deposits close, instant redemption
is off, and anyone can `retryStrandedClaim()` once the token lets the redeem through. Queuers get
their idle slice now (`settleQueue`) and their claim share when it clears. Say that out loud in the
publish rather than letting people discover it by failing a transaction.

**If the issuer burns supply out of the vault** (`adminBurn`), NAV is the honest
`max(balance + locked − reserved, 0)`, deposits close (`DepositsClosed`), and a settled queue
entry the reserve can no longer back is paid pro rata (`ReserveHaircut`). Publish the haircut.

`oraclePaused()` is a different and milder thing: an issuer broadcast flag on the token; the vault
refuses to arm and to fill while it is set (`OraclePaused()`), and Chainlink keeps publishing
regardless. That one is a skipped week, not a freeze.

### Do NOT
- Do not try to route around the token. There is no route.
- Do not tell depositors their money is safe in general terms. Tell them precisely which operations
  work (USDG claims, queueing) and which do not (anything moving NVDA).
- Do not unhalt until a transfer actually succeeds on chain.

---

## 6. Valorem fee switch flips on

`setFeesEnabled(true)` is `feeTo`-only on the clearinghouse with **no timelock**, and `setFeeTo`
emits no event (the nomination is visible only in storage slot 3). The fee is 15 bps of
**notional**, not of premium, which on a weekly OTM call can exceed the entire premium. On
Overcall's Clear the `feeTo` key is `0xdAe7e82A2E7D566C67E87C164B05a1C560190782`; on our own Clear
it is our admin.

### Detect
```bash
cast call $CLEAR "feesEnabled()(bool)" --rpc-url $RH_RPC   # was false
cast call $CLEAR "feeBps()(uint8)"     --rpc-url $RH_RPC   # 15
cast call $CLEAR "feeTo()(address)"    --rpc-url $RH_RPC
cast logs --address $CLEAR $(cast keccak "FeeSwitchUpdated(address,bool)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 200000 )) --rpc-url $RH_RPC
```

### Do
**The vault has already stopped.** `rollOpen` reverts `ValoremFeeNotAccepted(15)` and every fill
reverts the same way inside the hook. No action is needed to be safe; action is needed to resume.

Do the arithmetic before deciding, on this week's real numbers:
```
valoremFee = contracts * 1e18 * 15 / 10000   in NVDA terms, charged at write (on every fill)
           ~ 0.15% of notional
gross      = unitPrice6 * contracts
```
At a 0.40% minimum premium, a 0.15% notional fee eats **~37% of the floor premium**. The hook values
the fee at spot and adds it to the fill floor, so with the fee accepted a listing priced at the old
floor becomes unfillable until it is repriced. That is a policy decision, not a keeper decision, and
the switch that resumes writing is deliberately separate:

```bash
# Admin Safe, 2/3, only after an explicit decision:
cast send $VAULT "acceptValoremFee(bool)" true --rpc-url $RH_RPC
cast call $VAULT "valoremFeeAccepted()(bool)" --rpc-url $RH_RPC
```

### Do NOT
- Do not set `acceptValoremFee(true)` as a reflex to clear a stuck arm. It is a separate switch
  precisely so that nobody can do that quietly.
- Do not compensate by lowering `minOtmBps`. Selling closer to the money to pay a fee is how a
  covered-call vault turns into a losing one.
- Do not assume the flip is permanent. Re-read `feesEnabled()` each cycle; the keeper does.

---

## 7. Sequencer or RPC down in the open window

### Detect
```bash
cast block-number --rpc-url $RH_RPC
cast block latest --rpc-url $RH_RPC -f timestamp    # compare against wall clock
```
**There is no Chainlink sequencer-uptime feed on 4663**: Chainlink's directory has 57 feeds and zero
uptime entries. The standard Arbitrum-style guard cannot be built here. A stall shows up as
`block.timestamp` not advancing and as a price that ages; with `maxPriceAge` at 4 days it will
**not** trip `StalePrice` for days, so watch head liveness directly.

### Do
**The chain is the product.** There is no off-chain venue whose outage matters any more.

- If the chain is up: arm and list as usual. Once `seaport.getOrderStatus(listingHash).isValidated
  == true` the order is live and fillable by anybody with the payload:
```bash
cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" \
  $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC
```
- If the chain itself is stalled: do nothing and wait. You cannot transact. The exercise window is
  at least a full day (`MIN_EXERCISE_WINDOW`) and the listing runs for days, so a multi-hour outage
  costs nothing.
- If the outage runs past `cycleExerciseTs` with nothing sold, that is an `unfilled, 0` week.
  Publish it as one.

### Do NOT
- Do not skip the arm because some other service is down. The fill page needs only the keeper's
  `/orders` and a chain RPC.
- Do not widen the listing's `endTime` past `cycleExerciseTs` to "buy time". The vault rejects it
  (`ListingOutlivesExercise`) and the hook refuses fills after the exercise timestamp anyway
  (`WriteWindowClosed`).

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

1. **It rejects `eth_getLogs` over old ranges** (`"Archive requests require a personal token"`).
   Calls, code reads, sends and recent-range logs are fine. **The indexer cannot run on it**; if the
   primary is down, the indexer is down and the web app's history is stale. Say so on the site
   rather than serving stale numbers as current.
2. **Both RPCs return HTTP 403 to a client that sends no `User-Agent`.** Python `urllib` does this by
   default. `curl` and `cast` are fine.
3. **Cross-check anything surprising on both** before acting on it. Recon confirmed the two agree
   byte-for-byte on the feed round data; a disagreement is itself the signal.

Explorer as a third opinion: `robinhoodchain.blockscout.com` is behind a Cloudflare managed
challenge that keys on the **absence** of a `Referer` header. Any Referer value clears it:
```bash
curl -sS -H 'Referer: https://robinhoodchain.blockscout.com/' \
  'https://robinhoodchain.blockscout.com/api/v2/config/backend-version'
# or run the local proxy and point tools at 127.0.0.1:8546
node ops/bsproxy.js &
curl -sS http://127.0.0.1:8546/api/v2/config/backend-version
```
`https://stonkscan.io/address/<addr>` is a non-Cloudflare display fallback. (Source verification does
not go through Blockscout's API at all any more; it goes through Sourcify, `ops/deploy.md` §13.)

### Do NOT
- Do not point the indexer at the publicnode backup and assume it is syncing. It will fail on
  historical logs, and it will fail in a way that looks like "no events".
- Do not build anything that depends on the Blockscout API without the Referer header or the proxy.
  It returns an HTML interstitial, not an error, so the failure looks like a parse bug.
- Do not send a transaction you have only simulated against one RPC when the two disagree on head.

---

## 9. Stranded claim

`rollClose` could not redeem the Valorem claim: USDG is paused; the vault or the Clear is frozen on
USDG; the Clear's USDG was burnt by Paxos's supply controller; or the vault is blocklisted on NVDA
(that one bites in an unassigned or partially assigned week too, because `redeem` pushes each leg
only if it is non-zero). Freezes on 4663 have been indefinite in practice (27 observed, 0 lifted).

### Detect
```bash
cast call $VAULT "isStranded()(bool)"              --rpc-url $RH_RPC   # true
cast call $VAULT "phase()(uint8)"                  --rpc-url $RH_RPC   # 0 — Idle, with the claim kept
cast call $VAULT "claimKey()(uint256)"             --rpc-url $RH_RPC   # non-zero
cast call $VAULT "strandGen()(uint256)"            --rpc-url $RH_RPC
cast call $VAULT "strandedRemainingWad()(uint256)" --rpc-url $RH_RPC   # 1e18 minus the epochs' shares
cast call $VAULT "strands(uint256)(uint256,uint256,uint256,uint256,uint256)" <gen> --rpc-url $RH_RPC
# -> (assetsIn, usdgIn, wadLeft, assetsLeft, usdgLeft)
cast logs --address $VAULT $(cast keccak "ClaimStranded(uint32,uint256,uint256)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 5000 )) --rpc-url $RH_RPC
```
The keeper alerts `claim_stranded` (P1). The web app shows a stranded banner off `isStranded()`.

What the vault did on its own: reached Idle; recorded each settling queue epoch's pro-rata share
of the claim (`EpochStrandShare`); shut deposits (`maxDeposit() == 0`, `DepositsClosed`), instant
redemption and `rollOpen` (`StillStranded`). `lockedAssets()` still reads the claim, so NAV is
honest. A gas-starved close cannot fake this (`RedeemOutOfGas`).

### Do
Find the cause; it decides whether anyone can fix it:
```bash
cast call $USDG "paused()(bool)"                    --rpc-url $RH_RPC
cast call $USDG "isFrozen(address)(bool)" $VAULT    --rpc-url $RH_RPC
cast call $USDG "isFrozen(address)(bool)" $CLEAR    --rpc-url $RH_RPC
cast call $USDG "balanceOf(address)(uint256)" $CLEAR --rpc-url $RH_RPC   # ≥ what the claim owes?
cast call $NVDA "transfer(address,uint256)(bool)" $VAULT 1 --from $CLEAR --rpc-url $RH_RPC   # NVDA-side blocklist
```

Then, on a timer and after every change in those reads, **anyone** retries:
```bash
cast send $VAULT "retryStrandedClaim()" --rpc-url $RH_RPC --private-key <any funded key>
# StillStranded()  -> the cause persists; try again later
# NotStranded()    -> somebody else already cleared it
```
The keeper does this on a timer and alerts `strand_retry_failed` while it keeps reverting. The web
app has a Retry button that calls the same function.

Queuers are not stuck behind it. `settleQueue()` (permissionless, Idle) pays a queued epoch its
slice of the idle balance now and books its pro-rata share of the stranded claim
(`EpochStrandShare`), paid at the retry (`StrandShareSettled`). `previewCompleteRedeem(owner)`
shows both parts.

On success the retry emits `StrandedClaimRecovered(gen, assets, usdgOut, queueWad)` plus a
`Harvest` carrying the **stranded cycle's** number (fold it into that cycle's sums when you
publish), re-opens deposits, instant redemption and `rollOpen`, and the next open-week runbook is
ordinary.

Publish within the hour with Template E: what stranded, why (the exact read above), what still
works (USDG claims, queueing, `settleQueue`), what does not (deposits, instant redemption, the next
cycle), and that anyone can retry.

### Do NOT
- Do not halt. A halt does nothing here; the vault has already refused everything a halt would.
- Do not try to move the claim NFT to an address that is not frozen. Whoever holds it at redeem gets
  the collateral, and moving it needs a path the vault deliberately does not have.
- Do not publish the cycle's harvest numbers until the retry lands. They are unknown, and the
  publish says so.

---

## 10. Listing unfillable after a rally

The fill simulation on the cycle page (and the keeper's hourly one) reverts
`PremiumBelowFloorAtFill(gross, floor)` or `StrikeBelowBand(strike, min)` for a listing that
authorised fine.

### Detect
```bash
cast call $VAULT "spotUsdg()(uint256)"         --rpc-url $RH_RPC
cast call $VAULT "cycleStrikeUsdg()(uint256)"  --rpc-url $RH_RPC
cast call $VAULT "listingGrossUsdg()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "listingAmount()(uint256)"    --rpc-url $RH_RPC
# floor at live spot = spot6 * amount * minPremiumBps / 10000 (+ the engine fee valued at spot when on)
```
The keeper alerts `fill_sim_revert` (P2, warn) with the decoded reason. `open-week.md` §8 has the
simulation command.

### Do
This is the gate working: the vault re-prices the floor and the band floor **at every fill**, so a
listing priced at Monday's spot is refused on Tuesday's rally rather than sold cheap.

- `PremiumBelowFloorAtFill` → **reprice**: `cancelListing(components)`, then `approveListing` at
  the new floor (plus `PREMIUM_MARGIN_BPS`). The keeper does this inside its relist budget
  (`KEEPER_MAX_RELISTS`, under the vault's 3 authorisations per cycle, cancelled or not). Once the
  budget is spent, the week stays listed at the last price and fills only if spot comes back.
- `StrikeBelowBand` → the strike is now under the band floor. A reprice cannot fix a strike;
  cancel the listing (or leave it: it cannot fill while the condition holds) and publish
  `unfilled, 0` unless spot returns before `cycleExerciseTs`.

### Do NOT
- Do not lower the price to "get the fill through". The hook refuses anything under the live
  floor, so a lower ask is a listing that fills only after a sell-off, at a worse price.
- Do not arm a second type at a higher strike. `rollOpen` runs from `Idle` only; the cycle is
  armed until expiry.
- Do not treat it as an oracle problem. Read `latestRoundData()`; a fresh, higher spot is the
  ordinary case here.

---

## 11. Deposits closed unexpectedly

`maxDeposit(anyone) == 0` and `deposit`/`mint` revert `DepositsClosed()` while the vault looks idle.

### Detect
One gate, five reasons. Read them in this order:
```bash
cast call $VAULT "writesHalted()(bool)"      --rpc-url $RH_RPC   # 1. halted
cast call $VAULT "isStranded()(bool)"        --rpc-url $RH_RPC   # 2. stranded (§9)
cast call $VAULT "phase()(uint8)"            --rpc-url $RH_RPC
cast call $VAULT "cycleExerciseTs()(uint40)" --rpc-url $RH_RPC   # 3. Listed and past the exercise timestamp
cast call $VAULT "totalAssets()(uint256)"    --rpc-url $RH_RPC
cast call $VAULT "depositCap()(uint256)"     --rpc-url $RH_RPC   # 4. at the cap (launch: 20 NVDA)
cast call $NVDA  "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
cast call $VAULT "reservedAssets()(uint256)" --rpc-url $RH_RPC   # 5. reserve unbacked (balance < reserved: an issuer burn)
```

### Do
1, 3 and 4 are working as intended (find the owner of the halt; the exercise window closes deposits
whether or not `lockBook` ran; the cap is raised only after published weeks). 2 is §9. 5 is an
issuer burn: NAV is honest, settled queue entries take a pro-rata `ReserveHaircut`, and the publish
says so. The web deposit form keys off `maxDeposit() == 0` and decodes `DepositsClosed`; if it shows
"closed" and none of the five reads explains it, escalate.

### Do NOT
- Do not raise the cap to "reopen" deposits during a halt or a strand. The gate is not the cap.

---

## Escalation

| Situation | Who |
|---|---|
| Anything needing `haltWrites`, `cancelListing`, `invalidateAllListings` | Guardian, immediately, no consultation required |
| Anything needing `unhaltWrites`, `setPolicy`, `acceptValoremFee`, a role change | Admin Safe, 2 of 3 |
| Redeem that does not reconcile, `assigned > written`, a fill under the live floor, `ReserveBreached`, `UsdgLegBlocked` | Engineering. Do not publish a number until it is understood |
| Issuer freeze, stranded claim | Publish within the hour. There is no technical response beyond `retryStrandedClaim` on a timer |

The guardian is expected to act first and explain afterwards. Everything it can do is reversible by
the Admin Safe, and nothing it can do moves a token.
