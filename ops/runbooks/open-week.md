# Runbook — Open the week

**What this is.** The Friday open. Confirm Overcall rolled a new cycle, confirm the vault is allowed
to write, pick a strike, write, list, and confirm the listing is visible in two places.

**Who runs it.** The keeper does all of this automatically. A human runs this runbook to verify the
keeper, or to drive the roll by hand when the keeper is down. Every write step needs `KEEPER_ROLE`.

**Time budget.** 20 minutes if everything is normal. The write window stays open until the registry's
`exerciseTimestamp`, which is days away — there is never a reason to rush a bad strike out the door.

**The most likely outcome is that nobody buys.** That is a published `unfilled, 0`, not an incident.
Do not chase a fill by cutting the price below `minPremiumBps`; the vault will reject it anyway.

---

## 0. Shell setup

Paste this once per session. `VAULT` is the only value that is not yet known — fill it from
`ops/addresses.json` → `chains.4663.ours.vault` once deployed.

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_RPC_2=https://robinhood-rpc.publicnode.com

export REGISTRY=0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA   # OvercallRegistry, NVDA market
export CLEAR=0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0      # ValoremOptionsClearinghouse
export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395    # Seaport 1.6
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168       # 6 decimals
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC       # 18 decimals
export FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15       # Chainlink RHNVDA/USD, 8 decimals
export OVERCALL_FEE=0xdAe7e82A2E7D566C67E87C164B05a1C560190782

export VAULT=<fill from ops/addresses.json after deploy>
export KEEPER_PK=<hot key, KEEPER_ROLE only>
```

> These commands are written for BSD `date` (macOS). On GNU/Linux replace every
> `date -u -r <ts>` with `date -u -d @<ts>`. Everything else is portable.

> **Never substitute a different registry.** `0x65dD407955912Be814f723724cE60f91ebd72616` is the
> JUGGERNAUT market and is the top-level `registry` key in Overcall's own frontend config. Wiring it
> would collateralise NVDA calls against a memecoin. The vault constructor rejects it, but the keeper
> config can still point a read at it and give you a strike ladder from the wrong market.

---

## 1. Did the cycle actually roll?

The trigger is the registry, never the clock. Three reads:

```bash
cast call $REGISTRY "cycleNumber()(uint32)"     --rpc-url $RH_RPC
cast call $REGISTRY "isWritingOpen()(bool)"     --rpc-url $RH_RPC
cast call $REGISTRY "cycle()((uint32,uint40,uint40,uint96,uint256[]))" --rpc-url $RH_RPC
```

`cycle()` returns `(number, exerciseTimestamp, expiryTimestamp, lotSize, optionIds[])`. There is **no
status field** — `isWritingOpen()` is the gate, and it is `cycleNumber != 0 && now < writeDeadline()`.

Render the timestamps so you are reading dates, not integers:

```bash
cast call $REGISTRY "exerciseTimestamp()(uint40)" --rpc-url $RH_RPC   # book close, write deadline
cast call $REGISTRY "expiryTimestamp()(uint40)"   --rpc-url $RH_RPC   # settlement
date -u -r $(cast call $REGISTRY "exerciseTimestamp()(uint40)" --rpc-url $RH_RPC | cut -d' ' -f1) \
     '+%Y-%m-%d %H:%M:%S UTC %A'
```

**Pass when all four hold:**

| Check | Expected |
|---|---|
| `registry.cycleNumber()` | strictly greater than `vault.cycleNumber()` |
| `registry.isWritingOpen()` | `true` |
| `vault.phase()` | `0` (Idle) |
| `registry.exerciseTimestamp()` | in the future, and at least ~24 h away |

```bash
cast call $VAULT "cycleNumber()(uint32)" --rpc-url $RH_RPC
cast call $VAULT "phase()(uint8)"        --rpc-url $RH_RPC   # 0 Idle 1 Listed 2 Exercisable 3 Settling
```

If `vault.phase()` is not `0`, last week is not closed. Stop and run `close-week.md` first.

If `registry.cycleNumber()` has not moved, Overcall has not rolled. Watch for the event rather than
polling blindly:

```bash
cast logs --address $REGISTRY \
  $(cast keccak "CycleSet(uint32,uint256[],uint40,uint40,uint96)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 50000 )) \
  --rpc-url $RH_RPC
```

**Cadence caveat, stated honestly.** As of 2026-09-12 exactly one cycle has ever been set on the NVDA
registry: `cycleCount() == 1`, set Fri 2026-09-11 12:23:22 UTC (block 60254204) for a book that closes
Fri 2026-09-18 20:00 UTC. A weekly cadence is Overcall's stated intent and matches those timestamps,
but there is **no on-chain history proving they re-set weekly.** Do not build a schedule that assumes
it. If `cycleNumber` has not moved by the Monday after expiry, that is alert `CYCLE_NOT_ROLLED` — see
`ops/alerts.md` — and the honest publish for the week is `no cycle, unfilled, 0`.

A second timing fact from the same source: Overcall cannot replace a live ladder once anybody has
written against it (`canReplaceCycle()` reads `nextClaimKey != 1` on every rung). So cycle N+1 can only
be set at or after cycle N's expiry — Saturday 20:00 UTC at the earliest. Expect the new ladder to
appear over a weekend. **That does not mean you should write over a weekend.** See step 2.

---

## 2. Is the oracle usable right now?

Two separate gates. The vault enforces both, but check them by hand before spending gas.

### 2a. The issuer has not paused its oracle

```bash
cast call $NVDA "oraclePaused()(bool)" --rpc-url $RH_RPC     # must be false
```

`true` makes `rollOpen` revert `OraclePaused()`. That is the correct behaviour — the vault holds spot
and writes nothing. Publish `unfilled, 0, issuer oracle paused`.

### 2b. The price is fresh enough for the vault's own rule

```bash
cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RH_RPC
cast call $FEED "decimals()(uint8)"    --rpc-url $RH_RPC     # 8
cast call $VAULT "maxPriceAge()(uint32)" --rpc-url $RH_RPC   # launch: 345600 = 4 days
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
> when the US equity market is shut. Measured gaps: **17 h 37 m** worst intra-week, **52 h 04 m** over a
> normal weekend, **78 h 14 m** over the Labor Day weekend. Rounds restart at **00:00:54 UTC Monday**
> (20:00 ET Sunday). That is why `maxPriceAge` is **4 days**, not 24 hours — a 24 h rule would have
> blocked `rollOpen` every Saturday and Sunday and guaranteed a 0% week. Evidence:
> `ops/recon/R5-price-feed.md` §5.
>
> The gate passing is not the same as the price being useful. A 52-hour-old answer is Friday's close,
> and Monday can gap. **Prefer to roll during the US cash session (Mon–Fri, roughly 13:30–19:45 UTC),
> when the feed is minutes old.** The write window runs until Friday 20:00 UTC, so waiting for Monday
> costs nothing.
>
> If you must roll while the market is shut, pick **one rung higher** than the band's nearest-OTM
> answer. You are selling against a stale spot; buy yourself the gap.

Spot in USDG base units (what `Policy` compares against):

```bash
# feed is 8 dp, Policy normalises to USDG 6 dp => divide by 100
python3 -c "print('spot6 =', $(cast call $FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' \
  --rpc-url $RH_RPC | sed -n '2p' | cut -d' ' -f1) // 100)"
```

Do **not** apply `uiMultiplier()` to this. The Chainlink answer already includes it. Applying it twice
shifts the whole OTM band.

---

## 3. Is the Valorem fee switch still off?

```bash
cast call $CLEAR "feesEnabled()(bool)" --rpc-url $RH_RPC      # must be false
cast call $CLEAR "feeBps()(uint8)"     --rpc-url $RH_RPC      # 15
cast call $VAULT "valoremFeeAccepted()(bool)" --rpc-url $RH_RPC
```

`feesEnabled() == true` while `valoremFeeAccepted() == false` makes `rollOpen` revert
`ValoremFeeNotAccepted(15)`. Deliberate: 15 bps of **notional** is a large slice of a weekly OTM
premium, and paying it is a governance decision, not a keeper decision. Escalate to the admin Safe —
see `ops/runbooks/incident.md` § "Valorem fee switch flips on". Do not work around it.

---

## 4. Pick the strike

The ladder is already sorted. `setCycle` enforces strictly ascending strikes on-chain
(`StrikesNotAscending`), so `cycle().optionIds` is ordered by ascending strike and has at most 5 entries
(`MAX_STRIKES() == 5`). No client-side sort, no dedupe.

```bash
for ID in $(cast call $REGISTRY "activeOptionIds()(uint256[])" --rpc-url $RH_RPC \
            | tr -d '[]' | tr ',' '\n' | awk '{print $1}'); do
  S=$(cast call $REGISTRY "strikePerContract(uint256)(uint96)" $ID --rpc-url $RH_RPC | cut -d' ' -f1)
  A=$(cast call $REGISTRY "isApproved(uint256)(bool)" $ID --rpc-url $RH_RPC)
  C=$(cast call $REGISTRY "cycleOf(uint256)(uint32)" $ID --rpc-url $RH_RPC)
  printf "strike=%s.%s USDG  approved=%s  cycleOf=%s  id=%s\n" \
    $((S/1000000)) $(printf '%06d' $((S%1000000))) "$A" "$C" "$ID"
done
```

Cross-check one rung against the clearinghouse, which is the actual truth:

```bash
cast call $CLEAR "option(uint256)((address,uint96,address,uint96,uint40,uint40,uint160,uint96))" \
  <optionId> --rpc-url $RH_RPC
# -> (underlyingAsset, underlyingAmount, exerciseAsset, exerciseAmount,
#     exerciseTimestamp, expiryTimestamp, settlementSeed, nextClaimKey)
```

`underlyingAsset` must be `$NVDA`, `exerciseAsset` must be `$USDG`, `underlyingAmount` must equal
`cycle().lotSize`, and `exerciseAmount` must equal `strikePerContract`.

**Selection rule (`Policy.checkStrike`, launch values):**

```
band = [ spot6 * (10000 + minOtmBps) / 10000 ,  spot6 * (10000 + maxOtmBps) / 10000 ]
     = [ spot6 * 1.03 , spot6 * 1.12 ]
pick = the FIRST rung in the ascending list that falls inside the band   (nearest OTM)
```

Read the live policy rather than trusting the README:

```bash
cast call $VAULT "policy()(uint16,uint16,uint16,uint16,uint16,uint64)" --rpc-url $RH_RPC
# -> (minOtmBps, maxOtmBps, minPremiumBps, maxUtilizationBps, protocolFeeBps, maxContractsCap)
```

**If no rung is inside the band, write nothing.** This is routine, not an error. Today's ladder is a
flat 5.00 USDG spacing (226 / 231 / 236 / 241 / 246 against a spot of 218.30 = +3.5% to +12.7%), so a
3% move in spot pushes rungs out of the band from either end. Publish `no eligible rung, unfilled, 0`.

**Size (`Policy.checkContracts`):**

```bash
IDLE=$(cast call $VAULT "idleAssets()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1)
echo "idle NVDA = $(cast from-wei $IDLE)"
# contracts = min( floor(idle * maxUtilizationBps / 10000 / 1e18), maxContractsCap )
```

At launch that is `min(floor(idle * 0.95 / 1e18), 50)`. Divide by **`cycle().lotSize`**, never by
`registry.lotSize()` — the latter is the forward-looking value the owner can change mid-cycle for the
*next* `setCycle`, and using it would mis-size the write the moment Overcall changes lot size. Both are
`1e18` today, so this bug would not show up in testing.

---

## 5. Write

```bash
cast send $VAULT "rollOpen(uint256,uint112)" <optionId> <contracts> \
  --rpc-url $RH_RPC --private-key $KEEPER_PK
```

The vault re-checks everything in this same transaction — `isWritingOpen()`, `isApproved(optionId)`,
`cycleOf(optionId) == cycle.number`, the fee switch, the oracle, the OTM band and the size. The keeper
proposing an `optionId` is a proposal, never a fact. That in-transaction re-check is what closes the
race where Overcall's owner replaces the ladder between your read and your write.

Verify:

```bash
cast call $VAULT "phase()(uint8)"            --rpc-url $RH_RPC   # 1 = Listed
cast call $VAULT "optionId()(uint256)"       --rpc-url $RH_RPC   # == the id you wrote
cast call $VAULT "claimKey()(uint256)"       --rpc-url $RH_RPC   # non-zero; this is the claim NFT
cast call $VAULT "contractsWritten()(uint112)" --rpc-url $RH_RPC
cast call $VAULT "cycleStrikeUsdg()(uint256)"  --rpc-url $RH_RPC
cast call $VAULT "lockedAssets()(uint256)"     --rpc-url $RH_RPC # contracts * 1e18
```

**Confirm the ERC-1155 balance on chain — the vault must actually hold what it is about to list:**

```bash
cast call $CLEAR "balanceOf(address,uint256)(uint256)" $VAULT <optionId> --rpc-url $RH_RPC
cast call $CLEAR "balanceOf(address,uint256)(uint256)" $VAULT <claimKey> --rpc-url $RH_RPC   # must be 1
cast call $CLEAR "tokenType(uint256)(uint8)" <optionId> --rpc-url $RH_RPC                    # 1 = Option
cast call $CLEAR "tokenType(uint256)(uint8)" <claimKey> --rpc-url $RH_RPC                    # 2 = Claim
```

`option(id)` is **not** a validity check — it decodes only the upper 160 bits and happily returns a
valid-looking struct for a fabricated id. Use `tokenType()`.

**Confirm Seaport can move the tokens:**

```bash
cast call $CLEAR "isApprovedForAll(address,address)(bool)" $VAULT $SEAPORT --rpc-url $RH_RPC  # true
```

The vault sets this once in its constructor. If it is `false`, the deploy was wrong and no listing will
ever be fillable — stop and escalate.

---

## 6. Build and authorise the listing

Order shape is copied from the one real filled Overcall order. Do not invent a variant.

| field | value |
|---|---|
| `offerer` | `$VAULT` |
| `zone` | `0x0000000000000000000000000000000000000000` |
| `zoneHash` | 32 zero bytes |
| `orderType` | `1` (PARTIAL_OPEN) |
| `startTime` | `0` |
| `endTime` | `registry.exerciseTimestamp()` — the **Friday book close**, not the Saturday expiry |
| `conduitKey` | 32 zero bytes |
| `salt` | full random 256 bits, no prefix |
| `counter` | `seaport.getCounter($VAULT)`, read live |
| `offer[0]` | itemType 3 (ERC1155), token `$CLEAR`, identifier `optionId`, `startAmount == endAmount == N` |
| `consideration[0]` | itemType 1 (ERC20) `$USDG`, identifier 0, `writerPerContract6 * N`, recipient `$VAULT` |
| `consideration[1]` | itemType 1 (ERC20) `$USDG`, identifier 0, `feePerContract6 * N`, recipient `$OVERCALL_FEE` |

```bash
cast call $SEAPORT "getCounter(address)(uint256)" $VAULT --rpc-url $RH_RPC
```

### The fee rounding rule

```
feePerContract6    = floor(unitPrice6 * 500 / 10000)
writerPerContract6 = unitPrice6 - feePerContract6
consideration[1]   = feePerContract6    * N
consideration[0]   = writerPerContract6 * N
```

Round **per contract, then multiply**. Rounding on the total produces an order that signs and validates
and is then unfillable: Seaport scales every consideration item by the fill fraction and reverts
`InexactFraction` unless each amount divides evenly, and because every Overcall order is `PARTIAL_OPEN`
that quietly makes the listing full-fill-only. `unitPrice6` must also be **≥ 20**, or the 5% floors to
zero and Overcall's schema rejects the order outright.

`contracts/src/Policy.sol::splitPremium()` implements exactly this and
`contracts/src/lib/SeaportOrderLib.sol` enforces it on-chain (`BadFeeSplit`,
`OvercallFeeRoundsToZero`, `PremiumNotDivisibleByOrderSize`). If `approveListing` reverts with one of
those, the builder is wrong — fix the builder, do not tune the number until it passes.

### Price floor

```
minGrossUsdg = spot6 * N * minPremiumBps / 10000      # launch: 0.40% of spot notional per week
```

`approveListing` re-reads spot and enforces this (`Policy.checkPremium` → `PremiumBelowMinimum`).
A premium below the floor is a week the vault declines to sell, not a number to negotiate.

### Authorise

```bash
cast send $VAULT "approveListing((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256))" \
  "(<offerer>,<zone>,[(3,$CLEAR,<optionId>,<N>,<N>)],[(1,$USDG,0,<writer6>,<writer6>,$VAULT),(1,$USDG,0,<fee6>,<fee6>,$OVERCALL_FEE)],1,0,<endTime>,<zoneHash>,<salt>,<conduitKey>,<counter>)" \
  --rpc-url $RH_RPC --private-key $KEEPER_PK
```

In practice the keeper builds and sends this; by hand, prefer letting the keeper's `--dry-run` emit the
calldata rather than typing the tuple. What matters is what you check afterwards.

`approveListing` computes the hash with `seaport.getOrderHash`, validates every field against vault
state, and calls `seaport.validate()` so the order is marked on-chain. At most **3** listings per cycle
(`Policy.MAX_LISTINGS_PER_CYCLE`), and a new one is refused while the previous is live
(`PreviousListingLive`).

Verify on chain:

```bash
cast call $VAULT "listingHash()(bytes32)"        --rpc-url $RH_RPC
cast call $VAULT "listingGrossUsdg()(uint256)"   --rpc-url $RH_RPC
cast call $VAULT "listingAmount()(uint256)"      --rpc-url $RH_RPC
cast call $VAULT "listingsThisCycle()(uint8)"    --rpc-url $RH_RPC

cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" \
  $(cast call $VAULT "listingHash()(bytes32)" --rpc-url $RH_RPC) --rpc-url $RH_RPC
# -> (isValidated, isCancelled, totalFilled, totalSize)
# EXPECT: isValidated true, isCancelled false, totalFilled 0
```

`isValidated == true` is the on-chain proof the order is live and fillable **even if the Overcall API
never accepts it**. That is the floor under the whole week.

---

## 7. Publish to Overcall

```bash
curl -sS -X POST 'https://overcall.finance/api/orders?market=NVDA' \
  -H 'content-type: application/json' \
  -d @order.json -w '\nHTTP %{http_code}\n'
```

`order.json` is `{"chainId": 4663, "components": {...}, "signature": "0x<65 bytes>"}` — and nothing
else. There is no `optionId` field and no `maker` field; both are derived server-side. `content-type`
is the only header. There is no API key, no auth, no allowlist.

Every uint inside `components` is a **decimal string**, and `totalOriginalConsiderationItems` is **not
sent** (it belongs to `OrderParameters`, not `OrderComponents`).

The `signature` is a well-formed **65-byte placeholder**. Overcall's schema only accepts 64 or 65 bytes,
and the vault's `isValidSignature` ignores the bytes entirely — it answers `0x1626ba7e` for the
authorised `listingHash` and `0xffffffff` for everything else. There is no key to compromise here.

| code | meaning | do |
|---|---|---|
| 201 | created | record `listing.orderHash`; it must equal `vault.listingHash()` |
| 200 | identical hash re-POSTed | nothing — the POST is idempotent, retries are safe |
| 400 | schema | the builder is wrong. Read `error` verbatim; it is zod's own message |
| 401 | signature did not verify for the offerer | see below |
| 409 | counter moved or duplicate | re-read `getCounter`, rebuild, re-sign |
| 422 | an on-chain fact did not hold | re-run step 5's balance/approval checks |
| 429 | rate limit | back off. Cap is 20 open listings per writer per chain plus a per-IP bucket |

**A 401 on a first live listing is the one thing worth escalating immediately.** Overcall's own docs
state check 8 as "the signature verifies for offerer (**EOA or ERC-1271**)", and their bundled viem does
the 1271 fallback — but we have never seen a contract offerer accepted in production. If it 401s, the
listing is still live and fillable on Seaport (step 6 proved `isValidated`); it just will not appear on
overcall.finance. Fall back to step 8b, publish the payload on our own surface, and open the
conversation with Overcall. Do **not** respond by moving the option tokens to an EOA — that hands a hot
key custody of depositor collateral and needs an explicit Admin decision.

Confirm it landed (rows older than 30 s are re-synced against the chain as part of serving them, so
wait ~30 s and this is a real confirmation, not a cache read):

```bash
curl -sS "https://overcall.finance/api/orders?offerer=$VAULT&status=open" | jq '.listings[] |
  {orderHash, optionId, quantity, remaining, unitPrice6, totalPrice6, status, endTime}'

curl -sS "https://overcall.finance/api/orders/<orderHash>" | jq '.listing.status'
```

---

## 8. Confirm it is visible in both places

### 8a. Overcall's own surface
Open <https://overcall.finance> → NVDA → the book. The listing must be there with the right strike,
quantity and unit price. A listing that exists on chain but is invisible to buyers is an unfilled week.

### 8b. Our surface
Open `/vault/nvda/cycle`. It must show this cycle's strike, contracts, unit price, the listing hash and
the full Seaport payload — the payload is published so a buyer can fulfil directly from our UI even
when the Overcall API refused the order. Check the numbers on the page match
`vault.listingGrossUsdg()` and `vault.listingAmount()` exactly.

### 8c. Statuses that are not "open"
Overcall's status machine is `open → cancelled | filled | expired | unfillable`, and `unfillable`
recovers to `open` on its own. `unfillable` almost always means the 1155 balance or the Seaport
approval check failed — go back to step 5.

---

## 9. Hourly while Listed

```bash
cast call $VAULT "phase()(uint8)"                --rpc-url $RH_RPC
cast call $VAULT "contractsSold()(uint112)"      --rpc-url $RH_RPC
cast call $VAULT "contractsRemaining()(uint112)" --rpc-url $RH_RPC
cast call $USDG  "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
curl -sS "https://overcall.finance/api/orders?offerer=$VAULT&status=all" | jq '.listings[].status'
```

- Fully filled → stop. Do not relist.
- Partially filled → fine. `PARTIAL_OPEN` means the remainder stays live at the same unit price.
- `cancelled` / `expired` / stuck `unfillable` → relist **once**, at most 3 listings for the whole cycle.
- Never have two live orders covering the same 1155 amount. `approveListing` refuses
  (`PreviousListingLive`); cancel first.

---

## 10. Close the book

After `registry.exerciseTimestamp()` no new listing may be authorised. `lockBook()` is
**permissionless** — anyone can call it, on purpose, so a dead keeper cannot strand the vault:

```bash
cast send $VAULT "lockBook()" --rpc-url $RH_RPC --private-key $KEEPER_PK
cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC   # 2 = Exercisable
```

`lockBook` bumps the Seaport counter if a listing is still live, so nothing can fill into the exercise
window. From here the buyers have 24 hours to exercise, and settlement is `close-week.md`.

---

## 11. Done-checklist

- [ ] `registry.cycleNumber()` incremented past `vault.cycleNumber()`, `isWritingOpen()` true
- [ ] `oraclePaused()` false; feed age recorded, and the roll happened in the cash session (or the strike was widened a rung)
- [ ] `clear.feesEnabled()` false
- [ ] strike chosen from the ascending ladder, inside the live OTM band; `isApproved` true
- [ ] `rollOpen` mined; `phase() == 1`; `claimKey()` non-zero; 1155 balance equals contracts written
- [ ] `isApprovedForAll(vault, seaport)` true
- [ ] `approveListing` mined; `seaport.getOrderStatus(listingHash).isValidated == true`
- [ ] POST returned 201/200 and `listing.orderHash == vault.listingHash()`
- [ ] listing visible on overcall.finance **and** on `/vault/nvda/cycle`
- [ ] keeper gas balance ≥ 0.02 ETH
- [ ] the week's strike / contracts / unit price written down for Saturday's publish
