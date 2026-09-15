# Runbook — Open the week

**What this is.** The weekly open under write on fill. Confirm the vault is flat and not stranded,
check the oracle and the Valorem fee switch, choose a strike and a window, create the option type on
the clearinghouse, **arm** it (`rollOpen` writes nothing), authorise ONE restricted Seaport listing,
and confirm a buyer can fill it from our own page. Nothing is written until somebody buys.

**Who runs it.** The keeper does all of this automatically. A human runs this runbook to verify the
keeper, or to drive the week by hand when the keeper is down. `rollOpen` and `approveListing` need
`KEEPER_ROLE`; `clear.newOptionType` is permissionless.

**Time budget.** 20 minutes if everything is normal. The listing stays live until the option's
exercise timestamp, which is days away; there is never a reason to rush a bad strike out the door.

**The most likely outcome is that nobody buys.** That is a published `unfilled, 0`, not an incident.
Do not chase a fill by cutting the price below the policy floor; the vault refuses the listing, and
it re-prices the floor at live spot inside every fill anyway.

**What changed on 2026-09-13.** There is no Overcall registry, no Overcall order book and no Overcall
fee item any more. The vault reads the option tuple from the clearinghouse itself, numbers its own
cycles, and sells through the self-hosted fill page (`/vault/nvda/cycle`) and any Seaport 1.6 fulfil
function. `rollOpen(uint256,uint112)`, `contractsSold`, `contractsRemaining`, `writeMore` and the
`POST` to overcall.finance are gone. Every fill writes exactly what it buys inside Seaport's
`authorizeOrder` hook, so `contractsWritten() == sold` by construction.

---

## 0. Shell setup

Paste this once per session. `VAULT` is filled from `ops/addresses.json` → `chains.4663.ours.vault`
once deployed. `CLEAR` is whichever clearinghouse the vault was constructed with (`vault.clear()`;
Overcall's unmodified instance by default, or our own from `script/DeployClear.s.sol`).

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_RPC_2=https://robinhood-rpc.publicnode.com

export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395    # Seaport 1.6
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168       # 6 decimals
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC       # 18 decimals
export FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15       # Chainlink RHNVDA/USD, 8 decimals

export VAULT=<fill from ops/addresses.json after deploy>
export CLEAR=$(cast call $VAULT "clear()(address)" --rpc-url $RH_RPC)
export KEEPER_PK=<hot key, KEEPER_ROLE only>
```

> These commands are written for BSD `date` (macOS). On GNU/Linux replace every
> `date -u -r <ts>` with `date -u -d @<ts>`. Everything else is portable.

---

## 1. Is the vault ready to open?

Three reads. The trigger is the vault's own state, never a registry and never the clock.

```bash
cast call $VAULT "phase()(uint8)"       --rpc-url $RH_RPC   # 0 Idle 1 Listed 2 Exercisable 3 Settling
cast call $VAULT "isStranded()(bool)"   --rpc-url $RH_RPC   # must be false
cast call $VAULT "writesHalted()(bool)" --rpc-url $RH_RPC   # must be false
cast call $VAULT "cycleNumber()(uint32)" --rpc-url $RH_RPC  # the last cycle; the vault numbers its own
```

| Check | Expected | If not |
|---|---|---|
| `phase()` | `0` (Idle) | Last week is not closed. Stop and run `close-week.md` |
| `isStranded()` | `false` | A claim is stranded (`phase == Idle && claimKey != 0`). `rollOpen` reverts `StillStranded`. Run `incident.md` §9 and come back |
| `writesHalted()` | `false` | The guardian or admin halted. `rollOpen` reverts `WritesAreHalted`. Somebody owns that decision; find them |

`canRedeemInstantly()` is a convenient summary: `true` means flat, Idle and not stranded.

---

## 2. Is the oracle usable right now?

Two separate gates. The vault enforces both at arm **and again at every fill**, but check them by
hand before spending gas.

### 2a. The issuer has not paused its oracle

```bash
cast call $NVDA "oraclePaused()(bool)" --rpc-url $RH_RPC     # must be false
```

`true` makes `rollOpen` revert `OraclePaused()` and makes every fill revert the same way. That is
the correct behaviour: the vault holds spot and sells nothing. Publish `no write, issuer oracle paused`.

### 2b. The price is fresh enough for the vault's own rule

```bash
cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC
cast call $FEED "decimals()(uint8)"      --rpc-url $RH_RPC     # 8
cast call $VAULT "maxPriceAge()(uint32)" --rpc-url $RH_RPC     # launch: 345600 = 4 days
```

Age check in one line:

```bash
UPD=$(cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC \
      | sed -n '4p' | cut -d' ' -f1)
NOW=$(cast block latest --rpc-url $RH_RPC -f timestamp)
echo "feed age: $(( (NOW - UPD) / 3600 )) h   (last update $(date -u -r $UPD '+%Y-%m-%d %H:%M UTC %A'))"
```

> **THE FEED SLEEPS ON WEEKENDS AND THIS IS NORMAL.**
> `RHNVDA / USD` is a `us_equities_24/5` feed. It declares an 86400 s heartbeat and does not honour it
> when the US equity market is shut. Measured gaps: **21 h** worst intra-week, **52 h 04 m** over a
> normal weekend, **78 h 14 m** over the Labor Day weekend. Rounds restart at **00:00:54 UTC Monday**
> (20:00 ET Sunday). That is why `maxPriceAge` is **4 days**, not 24 hours. Evidence:
> `ops/recon/R5-price-feed.md` §5 and `projects/callhouse/integrations/chainlink.md`.
>
> The gate passing is not the same as the price being useful. A 52-hour-old answer is Friday's
> frozen value, which can predate the close by hours, and Monday can gap. **Arm and list during the
> regular US session (Mon–Thu, 09:30–16:00 ET), when the feed is minutes old.** Under write on fill a
> stale arm costs less than it used to (the fill re-prices at live spot), but a strike chosen against
> a stale spot can still be a strike nobody buys.
>
> Also skip a day on which `uiMultiplier()` is scheduled to change (`nextUIMultiplier` /
> `effectiveAt` on the Stock Token), and never price between a dividend `effectiveAt` and the feed's
> next round.

Spot in USDG base units (what `Policy` compares against):

```bash
cast call $VAULT "spotUsdg()(uint256)" --rpc-url $RH_RPC     # the vault's own read, 6 dp
```

Do **not** apply `uiMultiplier()` to this. The Chainlink answer already includes it.

---

## 3. Is the Valorem fee switch still off?

```bash
cast call $CLEAR "feesEnabled()(bool)" --rpc-url $RH_RPC      # must be false
cast call $CLEAR "feeBps()(uint8)"     --rpc-url $RH_RPC      # 15
cast call $VAULT "valoremFeeAccepted()(bool)" --rpc-url $RH_RPC
```

`feesEnabled() == true` while `valoremFeeAccepted() == false` makes `rollOpen` revert
`ValoremFeeNotAccepted(15)` and refuses every fill. Deliberate: 15 bps of **notional** is a large
slice of a weekly OTM premium, and paying it is a governance decision. Escalate to the admin Safe,
`incident.md` §6. Do not work around it.

---

## 4. Choose the strike and the window

There is no ladder to pick from. The keeper chooses the strike and the window, creates the option
type, and the vault's arm gate refuses anything outside policy.

### The band (`Policy.checkStrike`, launch values)

```
band = [ spot6 * (10000 + minOtmBps) / 10000 ,  spot6 * (10000 + maxOtmBps) / 10000 ]
     = [ spot6 * 1.03 , spot6 * 1.12 ]
```

Read the live policy rather than trusting the README:

```bash
cast call $VAULT "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url $RH_RPC
# -> (minOtmBps, maxOtmBps, minPremiumBps, maxUtilizationBps, protocolFeeBps, maxContractsCap)
```

The keeper targets a configured OTM distance inside the band (`KEEPER_STRIKE_OTM_BPS` and friends,
`keeper/README.md` → Environment) and rounds to a whole-dollar strike. Both bounds are checked at
arm; **only the floor is re-checked at every fill** (`StrikeBelowBand`), so a rally after the arm
makes the listing unfillable until the keeper reprices (step 9), while a sell-off does not.

**If no whole-dollar strike falls inside the band, write nothing.** Publish `no eligible strike,
unfilled, 0`.

### The window

The vault reads exercise and expiry from the option type and never the wall clock. The arm gate
(`ValoremLib`) accepts: exercise at least **1 hour** from now (`MIN_LEAD`), a window of at least
**1 day** (`MIN_EXERCISE_WINDOW`), and a whole tenor of at most **21 days** (`MAX_CYCLE_TENOR`).
Anchor the week on the **US close, Friday 16:00 ET**: that is 20:00 UTC while US daylight saving is
in effect and **21:00 UTC otherwise** (DST ends 2026-11-01); a full-day NYSE holiday on a Friday
moves it to Thursday's close. Render the timestamps before you use them:

```bash
date -u -r <exerciseTs> '+%Y-%m-%d %H:%M:%S UTC %A'
date -u -r <expiryTs>   '+%Y-%m-%d %H:%M:%S UTC %A'
```

### Capacity (what a listing may offer)

```bash
cast call $VAULT "totalAssets()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "contractsWritten()(uint112)" --rpc-url $RH_RPC   # 0 at the open
# capacity = Policy.maxContracts(totalAssets()) - contractsWritten()
#          = min( floor(totalAssets * maxUtilizationBps / 10000 / 1e18), maxContractsCap ) - written
```

At launch that is `min(floor(totalAssets * 0.95 / 1e18), 50)`. There is no `contractsRemaining()`
view any more; compute it. The vault sizes every fill itself (`written + k` against the same cap),
so the offer amount is a ceiling, not a commitment.

---

## 5. Create the option type

`newOptionType` is permissionless on the clearinghouse. Lot is exactly `1e18` (one Stock Token per
contract; `UnexpectedLotSize` otherwise), the exercise asset is USDG, and the strike is
`exerciseAmount` in USDG base units:

```bash
cast send $CLEAR "newOptionType(address,uint96,address,uint96,uint40,uint40)(uint256)" \
  $NVDA 1000000000000000000 $USDG <strike6> <exerciseTs> <expiryTs> \
  --rpc-url $RH_RPC --private-key $KEEPER_PK
```

The id is the hash of the tuple. If the exact tuple already exists (anyone may have created it),
the call reverts `OptionsTypeExists(optionId)`; read the id out of the revert and use it, the type is
the same. Confirm the tuple the way the vault will:

```bash
cast call $CLEAR "tokenType(uint256)(uint8)" <optionId> --rpc-url $RH_RPC   # 1 = Option
cast call $CLEAR "option(uint256)((address,uint96,address,uint96,uint40,uint40,uint160,uint96))" \
  <optionId> --rpc-url $RH_RPC
# -> (underlyingAsset, underlyingAmount, exerciseAsset, exerciseAmount,
#     exerciseTimestamp, expiryTimestamp, settlementSeed, nextClaimKey)
```

`option(id)` is **not** a validity check on its own: it decodes only the upper 160 bits and returns
a valid-looking struct for a fabricated id. `tokenType()` is the check, and the vault runs it
(`NotAnOptionType`).

---

## 6. Arm

```bash
cast send $VAULT "rollOpen(uint256)" <optionId> --rpc-url $RH_RPC --private-key $KEEPER_PK
```

`rollOpen` re-reads the tuple from the clearinghouse in the same transaction (asset, USDG, lot,
window, tenor), checks the fee switch, the oracle and **both** band bounds, snapshots the strike and
the window, and **writes nothing**. The keeper's `optionId` is a proposal; the vault's re-read is the
fact.

Verify:

```bash
cast call $VAULT "phase()(uint8)"              --rpc-url $RH_RPC   # 1 = Listed
cast call $VAULT "cycleNumber()(uint32)"       --rpc-url $RH_RPC   # incremented
cast call $VAULT "optionId()(uint256)"         --rpc-url $RH_RPC   # == the id you armed
cast call $VAULT "cycleStrikeUsdg()(uint256)"  --rpc-url $RH_RPC
cast call $VAULT "cycleExerciseTs()(uint40)"   --rpc-url $RH_RPC
cast call $VAULT "cycleExpiryTs()(uint40)"     --rpc-url $RH_RPC
cast call $VAULT "claimKey()(uint256)"         --rpc-url $RH_RPC   # 0 until the first fill
cast call $VAULT "contractsWritten()(uint112)" --rpc-url $RH_RPC   # 0
cast call $CLEAR "balanceOf(address,uint256)(uint256)" $VAULT <optionId> --rpc-url $RH_RPC   # 0, always
```

The `RollOpen` event carries `contractsCount == 0` on every cycle now. The 1155 balance is zero
before, during and after the week: the vault never holds an unsold option token.

**Confirm Seaport can move what a fill mints:**

```bash
cast call $CLEAR "isApprovedForAll(address,address)(bool)" $VAULT $SEAPORT --rpc-url $RH_RPC  # true
```

The vault sets this once in its constructor. If it is `false`, the deploy was wrong and no listing
will ever be fillable; stop and escalate.

---

## 7. Build and authorise the listing

The order is a **`PARTIAL_RESTRICTED`** Seaport 1.6 order whose zone is the vault. Seaport calls the
vault's `authorizeOrder` before any transfer on every fulfil path, and that hook is where the calls
are written. Do not invent a variant; `approveListing` refuses every deviation
(`BadOrderType`, `BadZone`, `BadZoneHash`, `BadConduitKey`, `BadConsiderationLength`, ...).

| field | value |
|---|---|
| `offerer` | `$VAULT` |
| `zone` | `$VAULT` |
| `zoneHash` | 32 zero bytes |
| `orderType` | `3` (PARTIAL_RESTRICTED) |
| `startTime` | `0` (a start in the future is refused, `ListingStartsInFuture`) |
| `endTime` | `≤ vault.cycleExerciseTs()` (`ListingOutlivesExercise` otherwise) |
| `conduitKey` | `vault.conduitKey()`, 32 zero bytes at launch |
| `salt` | full random 256 bits |
| `counter` | `seaport.getCounter($VAULT)`, read live (`BadCounter` otherwise) |
| `offer[0]` | itemType 3 (ERC1155), token `$CLEAR`, identifier `optionId`, `startAmount == endAmount == N ≤ capacity` |
| `consideration[0]` | itemType 1 (ERC20) `$USDG`, identifier 0, `unitPrice6 * N`, recipient `$VAULT`. **The only consideration item** |
| `signature` | **empty**. The vault pre-validates the hash on Seaport; there is no key and no EIP-1271 |

```bash
cast call $SEAPORT "getCounter(address)(uint256)" $VAULT --rpc-url $RH_RPC
```

### Price

```
minGrossUsdg = spot6 * N * minPremiumBps / 10000      # launch: 0.40% of spot notional per week
floorUnit6   = ceil(minGrossUsdg / N)                 # plus the Valorem fee valued at spot when that fee is on
unitPrice6   = ceil(floorUnit6 * (10000 + KEEPER_PREMIUM_MARGIN_BPS) / 10000)   # default margin 100 = 1%
gross        = unitPrice6 * N                          # must divide by N exactly
```

- `gross % N == 0` or `approveListing` reverts `PremiumNotDivisibleByOrderSize`. Round **per
  contract, then multiply**. Seaport scales a partial fill's consideration by the fill fraction and
  reverts `InexactFraction` on a remainder.
- `unitPrice6 ≤ strike` (`UnitPriceExceedsStrike`).
- The floor is re-checked **at every fill against live spot** (`PremiumBelowFloorAtFill`), with the
  Valorem engine fee valued at spot added to it when that fee is on. A listing priced at the floor
  becomes unfillable on any upward tick; `KEEPER_PREMIUM_MARGIN_BPS` (default 100, i.e. 1%) is the
  keeper's cushion, and a rise beyond it is a reprice (step 9).

A premium below the floor is a week the vault declines to sell, not a number to negotiate.

### Authorise

```bash
cast send $VAULT "approveListing((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256))" \
  "($VAULT,$VAULT,[(3,$CLEAR,<optionId>,<N>,<N>)],[(1,$USDG,0,<gross6>,<gross6>,$VAULT)],3,0,<endTime>,0x0000000000000000000000000000000000000000000000000000000000000000,<salt>,<conduitKey>,<counter>)" \
  --rpc-url $RH_RPC --private-key $KEEPER_PK
```

In practice the keeper builds and sends this; by hand, prefer letting the keeper's dry run emit the
calldata rather than typing the tuple. What matters is what you check afterwards.

`approveListing` computes the hash with `seaport.getOrderHash`, validates every field against vault
state, and calls `seaport.validate()` so the order is marked on chain. At most **3** authorisations
per cycle (`Policy.MAX_LISTINGS_PER_CYCLE`, counted whether or not the earlier ones were cancelled),
and a new one is refused while the previous is live (`PreviousListingLive`).

Verify on chain:

```bash
cast call $VAULT "listingHash()(bytes32)"        --rpc-url $RH_RPC
cast call $VAULT "listingGrossUsdg()(uint256)"   --rpc-url $RH_RPC
cast call $VAULT "listingAmount()(uint256)"      --rpc-url $RH_RPC
cast call $VAULT "listingsThisCycle()(uint8)"    --rpc-url $RH_RPC   # 1

cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" \
  $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC
# -> (isValidated, isCancelled, totalFilled, totalSize)
# EXPECT: isValidated true, isCancelled false, totalFilled 0
```

`isValidated == true` is the on-chain proof the order is live. Whether it is **fillable** right now
is a second question, answered by a simulation (step 8).

---

## 8. Confirm a buyer can fill it, from our page

There is exactly one venue: `/vault/nvda/cycle`, which reads the keeper's `/orders` through the web
server (`KEEPER_ORDERS_URL`, `ops/deploy.md` §3) and offers `fulfillAdvancedOrder` with the
published payload and an empty signature. Any Seaport 1.6 fulfil function works the same way.

Open the page. It must show this cycle's strike, capacity, unit price, the live floor, the listing
hash and the full payload, and the numbers must equal `vault.listingGrossUsdg()` /
`vault.listingAmount()` exactly.

Then simulate one contract the way the page does before it enables the button (any funded USDG
holder; ~500k gas; the first fill of a week costs ≈ 470k, a top-up ≈ 245k, both spike figures):

```bash
cast call $SEAPORT "fulfillAdvancedOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes),(uint256,uint8,uint256,uint256,bytes32[])[],bytes32,address)(bool)" \
  "(<parameters incl. totalOriginalConsiderationItems=1>,1,<N>,0x,0x)" "[]" \
  0x0000000000000000000000000000000000000000000000000000000000000000 <buyer> \
  --from <buyer> --gas-limit 500000 --rpc-url $RH_RPC
```

A `true` means the hook accepted: the write would happen. A revert decodes to one of the hook
errors and tells you what to do:

| Revert | Meaning | Do |
|---|---|---|
| `PremiumBelowFloorAtFill(gross, floor)` | spot rose since the arm; the ask is under the live floor | reprice (step 9) |
| `StrikeBelowBand(strike, min)` | spot rose past the band floor | reprice with a new strike is impossible mid-cycle; cancel and wait, or accept an unfilled week |
| `OraclePaused()` / `StalePrice(...)` | the write gate | wait for the feed / the issuer |
| `ValoremFeeNotAccepted(15)` | the fee switch flipped after the arm | `incident.md` §6 |
| `WritesAreHalted()` | guardian or admin halt | find the owner of that decision |
| `WriteWindowClosed(exerciseTs)` | past the exercise timestamp | the week is over; `lockBook` |
| `ContractsAboveUtilization` / `ContractsAboveCap` | the buyer asked for more than the remaining capacity | a smaller fill works |
| `ReserveBreached(...)` | the post-write reserve check | escalate; the reserve maths are wrong or an issuer burn landed |
| `NotLiveListing(hash)` / `BadZone` / `BadOrderType` | the payload is not this cycle's authorised order | the payload on the page is stale or corrupt; re-read `listingHash()` |
| an `InsufficientBalance`-shaped Seaport error | the simulated buyer holds no USDG or has not approved Seaport | pick a real buyer address |

---

## 9. While Listed: hourly

```bash
cast call $VAULT "phase()(uint8)"              --rpc-url $RH_RPC
cast call $VAULT "contractsWritten()(uint112)" --rpc-url $RH_RPC   # == sold
cast call $VAULT "claimKey()(uint256)"         --rpc-url $RH_RPC   # non-zero after the first fill
cast call $USDG  "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" \
  $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC
cast logs --address $VAULT $(cast keccak "CallsWritten(uint256,uint256,uint112,uint256)") \
  --from-block <the rollOpen block> --rpc-url $RH_RPC
# CallsWritten(optionId indexed, claimKey indexed, contractsCount, collateral): ONE PER FILL.
# The sum of contractsCount over the cycle's claimKey == contractsWritten().
```

- Fully filled (`totalFilled == totalSize`, both non-zero) → stop. Do not relist.
- Partially filled → fine. The remainder stays live at the same unit price.
- Simulation reverts `PremiumBelowFloorAtFill` or `StrikeBelowBand` after a rally → **reprice**:
  `cancelListing(components)` (keeper or guardian), then `approveListing` again at the new floor.
  Three authorisations per cycle in total, cancelled or not, and that cap is the keeper's whole
  reprice budget (there is no keeper-side relist limit). A relist is a reprice, never a size
  change: the vault sizes fills. The keeper also relists after a guardian `cancelListing` /
  `invalidateAllListings`, and after a listing sells out while deposits have added capacity.
- Never have two live orders. `approveListing` refuses (`PreviousListingLive`); cancel first.
- The keeper mirrors the fill gate's two spot checks every tick (the strike against the band
  floor, the ask against the fill floor) and alerts `fill_sim_revert` when the live listing
  would be refused and it cannot or may not reprice
  (`ops/alerts.md` §3).

---

## 10. Close the book

After `cycleExerciseTs` no fill can succeed (`WriteWindowClosed`) and no listing may be authorised.
`lockBook()` is **permissionless** — anyone can call it, on purpose, so a dead keeper cannot strand
the vault:

```bash
cast send $VAULT "lockBook()" --rpc-url $RH_RPC --private-key $KEEPER_PK
cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC   # 2 = Exercisable
```

`lockBook` bumps the Seaport counter if a listing is still live, so nothing can fill into the
exercise window. From here the buyers can exercise until `cycleExpiryTs`, and settlement is
`close-week.md`. Deposits closed at `cycleExerciseTs` whether or not anyone called `lockBook`
(`maxDeposit() == 0`, `DepositsClosed`).

---

## 11. Done-checklist

- [ ] `phase() == 0`, `isStranded() == false`, `writesHalted() == false` before the open
- [ ] `oraclePaused()` false; feed age recorded; the arm happened in the regular US session
- [ ] `clear.feesEnabled()` false
- [ ] option type created (or the existing id read from `OptionsTypeExists`); `tokenType(id) == 1`; lot `1e18`; USDG exercise asset; window inside `[now + 1 h, +21 d]` with a ≥ 1 day exercise window
- [ ] `rollOpen(id)` mined; `phase() == 1`; `cycleNumber()` incremented; `claimKey() == 0`; `contractsWritten() == 0`; 1155 balance `0`
- [ ] `isApprovedForAll(vault, seaport)` true
- [ ] `approveListing` mined: orderType 3, zone == vault, one consideration item, `gross % N == 0`; `seaport.getOrderStatus(listingHash).isValidated == true`
- [ ] fill simulation returns `true` at the current spot
- [ ] listing visible on `/vault/nvda/cycle` with the same numbers as chain
- [ ] keeper gas balance ≥ 0.02 ETH
- [ ] the week's strike / capacity / unit price / window written down for the publish
