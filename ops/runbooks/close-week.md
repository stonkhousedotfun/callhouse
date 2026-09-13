# Runbook — Close the week

**What this is.** The Saturday close. Redeem the Valorem claim, verify what actually came back, check
the harvest split, settle the redeem queue, and publish the result — including when the result is
`unfilled, 0`.

**Who runs it.** The keeper, from `expiryTimestamp`. **Anyone** from `expiryTimestamp + 1 hour` — the
vault must not depend on a hot key staying alive for depositors to get their money back. The guardian,
an admin signer, or a depositor can all call `rollClose()` after that hour.

**Time budget.** 15 minutes, plus however long the publish takes to write.

---

## 0. Shell setup

Same block as `open-week.md`:

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export REGISTRY=0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA
export CLEAR=0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
export OVERCALL_FEE=0xdAe7e82A2E7D566C67E87C164B05a1C560190782
export VAULT=<fill from ops/addresses.json after deploy>
export SAFE_FEE=<fill from ops/addresses.json after deploy>
export KEEPER_PK=<hot key, KEEPER_ROLE only>
```

> These commands are written for BSD `date` (macOS). On GNU/Linux replace every
> `date -u -r <ts>` with `date -u -d @<ts>`. Everything else is portable.

---

## 1. STOP — capture the pre-close state first

**`rollClose()` zeroes `claimKey`, `optionId`, `contractsWritten` and `contractsSold`. Every view that
reads them returns 0 afterwards.** If you do not snapshot now, the numbers you need for the publish are
gone and you will be reconstructing them from logs.

```bash
CYCLE=$(cast call $VAULT "cycleNumber()(uint32)"        --rpc-url $RH_RPC | cut -d' ' -f1)
OPT=$(cast call   $VAULT "optionId()(uint256)"          --rpc-url $RH_RPC | cut -d' ' -f1)
CLAIM=$(cast call $VAULT "claimKey()(uint256)"          --rpc-url $RH_RPC | cut -d' ' -f1)
WROTE=$(cast call $VAULT "contractsWritten()(uint112)"  --rpc-url $RH_RPC | cut -d' ' -f1)
SOLD=$(cast call  $VAULT "contractsSold()(uint112)"     --rpc-url $RH_RPC | cut -d' ' -f1)
STRIKE=$(cast call $VAULT "cycleStrikeUsdg()(uint256)"  --rpc-url $RH_RPC | cut -d' ' -f1)
EXPIRY=$(cast call $VAULT "cycleExpiryTs()(uint40)"     --rpc-url $RH_RPC | cut -d' ' -f1)

echo "cycle=$CYCLE optionId=$OPT claimKey=$CLAIM wrote=$WROTE sold=$SOLD strike6=$STRIKE expiry=$EXPIRY"

# Valorem's own view of the claim — THE source of truth for assignment
cast call $CLEAR "claim(uint256)((uint256,uint256,uint256))" $CLAIM --rpc-url $RH_RPC
# -> (amountWritten, amountExercised, optionId)

cast call $CLEAR "position(uint256)((address,int256,address,int256))" $CLAIM --rpc-url $RH_RPC
# -> (underlyingAsset, underlyingAmount, exerciseAsset, exerciseAmount)

# Balances before
cast call $NVDA "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url $RH_RPC
cast call $VAULT "totalSupply()(uint256)"            --rpc-url $RH_RPC
cast call $VAULT "queuedShares()(uint256)"           --rpc-url $RH_RPC
cast call $VAULT "accUsdgPerShare()(uint256)"        --rpc-url $RH_RPC
```

> **`amountWritten` and `amountExercised` are 1e18-SCALED SCALARS, not contract counts.**
> One contract reads as `1000000000000000000`. Divide by `1e18` before you believe a number.
> `write()`'s `amount` argument is a raw `uint112` count. Do not compare the two directly.
> `vault.contractsAssigned()` already does the division — use it, and use it **now**, before close:

```bash
ASSIGNED=$(cast call $VAULT "contractsAssigned()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1)
echo "assigned contracts = $ASSIGNED of $WROTE written"
```

Record all of the above in the week's notes. This is the raw material for the publish.

---

## 2. Are we actually past expiry?

```bash
NOW=$(cast block latest --rpc-url $RH_RPC -f timestamp)
echo "now=$NOW ($(date -u -r $NOW '+%Y-%m-%d %H:%M UTC %A'))"
echo "expiry=$EXPIRY ($(date -u -r $EXPIRY '+%Y-%m-%d %H:%M UTC %A'))"
cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC     # 1 Listed or 2 Exercisable
```

`rollClose` reverts `NotYetExpired(expiryTs)` before expiry, and `GuardianTooEarly(expiry + 3600)` for a
non-keeper caller in that first hour. Both are expected, not faults.

If `phase()` is still `1` (Listed), `lockBook()` was never called. That is fine — `rollClose` accepts
both `Listed` and `Exercisable`, and it invalidates any surviving listing itself before redeeming.

---

## 3. Close

```bash
cast send $VAULT "rollClose()" --rpc-url $RH_RPC --private-key $KEEPER_PK
```

One transaction does four things, in this order:

1. bumps the Seaport counter if a listing is somehow still live, so nothing can fill into worthless inventory
2. `clear.redeem(claimKey)` — collateral and any assignment proceeds come back, measured as real balance deltas
3. `_harvest(usdgFromAssignment)` — protocol fee on the **premium only** out to the fee Safe; everything
   else, assignment proceeds included in full, indexed into `accUsdgPerShare`
4. `_settleQueue()` — escrowed shares burned, their pro-rata NVDA and USDG reserved into an epoch

then `phase` returns to `Idle`.

---

## 4. Verify the redeem

Pull the events from the close transaction:

```bash
TX=<rollClose tx hash>
cast receipt $TX --rpc-url $RH_RPC | head -40
cast run $TX --rpc-url $RH_RPC --quick 2>/dev/null | tail -40   # optional, decoded trace
```

Two `ClaimRedeemed` events exist and they are different. Read both.

**Valorem's** (`0xa3d8a607cd3c6b3ffa03a5117299750bca64916c2122f1efffb6bf643a35740f`):
```
ClaimRedeemed(uint256 indexed claimId, uint256 indexed optionId, address indexed redeemer,
              uint256 exerciseAmountRedeemed, uint256 underlyingAmountRedeemed)
```

**The vault's** (from `AdapterValorem`):
```
ClaimRedeemed(uint256 indexed claimKey, uint256 underlyingReturned, uint256 exerciseReceived)
```
`underlyingReturned` and `exerciseReceived` are **measured balance deltas**, not numbers copied from
Valorem. That is deliberate — it stays correct even if Valorem nets a fee — and they are the numbers the
harvest and the queue payout are computed from.

**Reconcile:**

```
underlyingReturned  ==  (contractsWritten - assignedContracts) * lotSize     # lotSize = 1e18
exerciseReceived    ==  assignedContracts * cycleStrikeUsdg
assignedContracts   ==  contractsWritten - underlyingReturned / 1e18
```

```bash
cast logs --address $VAULT $(cast keccak "ClaimRedeemed(uint256,uint256,uint256)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 200 )) --rpc-url $RH_RPC
```

If the two sides do not reconcile to the unit, **stop and do not publish a number.** Partial assignment
is normal; an unreconcilable redeem is not.

> **Cross-check assignment three ways; all three must agree.**
> 1. `contractsAssigned()` captured in step 1, **before** the close. The view returns `0` afterwards
>    because `rollClose` zeroes `claimKey` — that is the trap, and step 1 is the defence.
> 2. `RollClose.contractsAssignedCount`, the event's fourth field. `Vault.rollClose` reads
>    `contractsAssigned()` *before* `_redeemClaim` and emits the real number. (An earlier draft of the
>    vault hardcoded this to `0`; if you are reading an old ops doc that says so, it is out of date.
>    Confirm with `grep -n -A3 "uint256 assignedCount" contracts/src/Vault.sol`.)
> 3. `contractsWritten - underlyingReturned / 1e18` from the vault's own `ClaimRedeemed`.
>
> (1) and (2) are the same read taken at the same instant, so they are one source, not two. (3) is
> independent — it is a measured balance delta. **(3) disagreeing with (1)/(2) is
> `REDEEM_RECONCILE_FAILED`: do not publish a number.**

### Partial assignment is expected

Valorem assigns exercise **by bucket**, pseudorandomly, not pro-rata across the whole market. A vault
that wrote `N` contracts can come back with anywhere from `0` to `N` assigned, and a single `redeem()`
routinely returns **both** NVDA and USDG. Nothing in the vault asserts a 1:1 return, and nothing should.

### Leftover option tokens are normal and are not a problem

Unsold option ERC-1155 stays in the vault's balance forever. `redeem()` never reads it — its entire
precondition set is "the caller owns the claim NFT" and "we are at or past expiry" — and there is no
public burn. After expiry the leftovers are inert: `exercise()` reverts `ExpiredOption`. Do not try to
sweep them, and make sure no report derives anything from `clear.balanceOf(vault, optionId)`.

```bash
cast call $CLEAR "balanceOf(address,uint256)(uint256)" $VAULT $OPT --rpc-url $RH_RPC  # residual, ignore
```

---

## 5. Check the harvest split

```bash
# cycleNumber is the INDEXED first arg, so filter the whole cycle, not just the close block.
# A cycle can emit MORE THAN ONE Harvest — see the warning below.
cast logs --address $VAULT $(cast keccak "Harvest(uint32,uint256,uint256,uint256)") \
  $(cast to-uint256 $CYCLE) \
  --from-block <the rollOpen block for this cycle> --rpc-url $RH_RPC
# Harvest(cycleNumber indexed, grossUsdg, feeUsdg, netUsdg)
```

> **A cycle can emit more than one `Harvest`, and the close's own event is not the whole week.**
> `deposit` and `mint` call `_checkpointHarvest()`, which runs the same `_accrueHarvest` the close
> does (with nothing excluded from the fee base, since assignment proceeds only arrive at the close). That exists so a depositor arriving after a fill cannot mint into premium earned before they
> got here. Consequences you must handle:
> - The week's totals are the **sum** of `Harvest.grossUsdg` / `feeUsdg` / `netUsdg` over every
>   `Harvest` carrying this `cycleNumber`, not the values on the close's event. If a fill landed and
>   then somebody deposited, the close's own event can legitimately read `(0, 0, 0)`.
> - The fee does **not** move at a checkpoint. `_accrueHarvest` only adds it to `pendingFeeUsdg`;
>   `_harvest()`, which runs from `rollClose` alone, transfers the accumulated total once.
> - The same applies to `UsdgDistributed`: sum `credited` over the cycle's events.
>
> Read the carry before the close if you want to see it coming:
> ```bash
> cast call $VAULT "pendingFeeUsdg()(uint256)" --rpc-url $RH_RPC   # fee accrued, not yet paid out
> ```

**Where the gross came from.** `grossUsdg` is everything in the vault's USDG balance that was not
already owed to somebody: this week's filled premium **plus** any assignment proceeds.

```
grossUsdg  ==  vaultPremium6 + exerciseReceived

where, per the Overcall fee split:
  feePerContract6    = floor(unitPrice6 * 500 / 10000)
  writerPerContract6 = unitPrice6 - feePerContract6
  vaultPremium6      = writerPerContract6 * contractsFilled     <- what actually landed here
  overcallFee6       = feePerContract6    * contractsFilled     <- went straight to Overcall's EOA,
                                                                   never touched the vault
```

**The protocol fee** is charged on premium only. Assignment proceeds are in `grossUsdg` but are
**not** fee'd, so check each `Harvest` event against its own fee base, not `feeUsdg / grossUsdg`:

```
# the close's Harvest — take usdgFromAssignment from the RollClose event in the SAME tx
# (== ClaimRedeemed.exerciseReceived; 0 if nothing was assigned)
feeUsdg == floor((grossUsdg - usdgFromAssignment) * protocolFeeBps / 10000)   # launch: 500 bps = 5%
netUsdg == grossUsdg - feeUsdg

# a checkpoint Harvest (emitted from a deposit/mint, no RollClose in its tx)
feeUsdg == floor(grossUsdg * protocolFeeBps / 10000)
netUsdg == grossUsdg - feeUsdg
```

Check per event, then sum: flooring per event means the summed fee can be a few base units below
`floor(sum of fee bases * protocolFeeBps / 10000)`. Worked, assigned week: vault premium 19.000000,
5 contracts assigned at a 231.000000 strike, so `usdgFromAssignment = 1155000000` and
`grossUsdg = 1174000000`; `feeUsdg = floor(19000000 * 500 / 10000) = 950000` (0.95 USDG), and
`netUsdg = 1173050000`. A `feeUsdg` of 58700000 (5% of the whole gross) would mean the fee was
taken on the strike proceeds, which the deployed contract must not do — check you read
`protocolFeeBps` and `usdgFromAssignment` from the right cycle, then treat it as wrong bytecode and
escalate (`ops/runbooks/incident.md`).

An unfilled, unassigned week harvests `0`, and `Policy.splitHarvest` returns `(0, 0)` — **the fee is
charged only on premium.** A 0 week costs depositors nothing. Say so in the publish.

Confirm the fee actually moved and the rest was indexed:

```bash
# increased by the SUM of feeUsdg over this cycle's Harvest events (== pendingFeeUsdg immediately
# before the close), NOT by the close event's own feeUsdg
cast call $USDG "balanceOf(address)(uint256)" $SAFE_FEE --rpc-url $RH_RPC
cast call $VAULT "pendingFeeUsdg()(uint256)" --rpc-url $RH_RPC                # 0 after the close
cast call $VAULT "accUsdgPerShare()(uint256)" --rpc-url $RH_RPC               # increased
cast call $VAULT "totalUsdgDistributed()(uint256)" --rpc-url $RH_RPC
cast call $VAULT "usdgDust()(uint256)"        --rpc-url $RH_RPC               # sub-unit remainder, carried
cast call $VAULT "usdgUnallocated()(uint256)" --rpc-url $RH_RPC               # non-zero only if supply was 0

cast logs --address $VAULT $(cast keccak "UsdgDistributed(uint256,uint256,uint256)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 200 )) --rpc-url $RH_RPC
# UsdgDistributed(credited, accUsdgPerShare, totalSupply)
```

**Net USDG per share** — the one number the product promises:

```
netUsdgPerShare = credited / totalSupply        # both from the UsdgDistributed event
```

`totalSupply` there still **includes** the escrowed queued shares — the queue is settled after the
harvest, on purpose, so people who queued get their share of the week they actually sat through. Use the
event's own `totalSupply` field; do not re-read `totalSupply()` after the close.

Per-share as a decimal, from the event. With more than one `UsdgDistributed` in the cycle, do this
per event and add the results — each event has its own `totalSupply` and they are not interchangeable:

```bash
python3 -c "
credited=<credited>; supply=<totalSupply>
print('net USDG per share = %.6f' % (credited/1e6 / (supply/1e18)))"
```

Sanity: `accUsdgPerShare` is scaled by `1e27`, so a holder's claimable is
`balance * (accUsdgPerShare - snapshot) / 1e27`. Spot-check one holder:

```bash
cast call $VAULT "claimableUsdg(address)(uint256)" <holder> --rpc-url $RH_RPC
```

---

## 6. Process the redeem queue

`rollClose` already settled it. What is left is people collecting.

```bash
cast logs --address $VAULT $(cast keccak "QueueSettled(uint256,uint256,uint256,uint256)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 200 )) --rpc-url $RH_RPC
# QueueSettled(epochId indexed, shares, assets, usdgOut)

cast call $VAULT "epochId()(uint256)"             --rpc-url $RH_RPC   # incremented
cast call $VAULT "queuedShares()(uint256)"        --rpc-url $RH_RPC   # back to 0
cast call $VAULT "reservedAssets()(uint256)"      --rpc-url $RH_RPC   # NVDA owed to settled epochs
cast call $VAULT "usdgReservedForQueue()(uint256)" --rpc-url $RH_RPC  # USDG owed to settled epochs
cast call $VAULT "epochs(uint256)(uint256,uint256,uint256)" <epochId-1> --rpc-url $RH_RPC
# -> (sharesRemaining, assetsRemaining, usdgRemaining)
```

**Queue semantics, stated once so nobody re-derives them wrong:**

- `queueRedeem(shares)` moves shares into escrow **on the vault**. They keep earning that week's premium
  right up to settlement, and that accrual is paid out **with the redemption**, not left to the holders
  who stayed.
- Settlement snapshots **shares**, not assets. The payout is computed at settle time from
  `idleAssets() * queuedShares / totalSupply`.
- `reservedAssets` and `usdgReservedForQueue` are excluded from NAV, so a settled-but-unclaimed
  redemption does not inflate anyone else's share price.
- Each epoch is drawn down proportionally as people claim. The last claimant of an epoch has
  `shares == sharesRemaining` and takes exactly what is left, so the division strands no dust.
- Depositors collect themselves; there is nothing for ops to push:

```bash
cast call $VAULT "previewCompleteRedeem(address)(uint256,uint256)" <owner> --rpc-url $RH_RPC
# the depositor then calls, from their own wallet:
#   completeRedeem(address receiver)  -> (assets, usdgOut)
```

- A depositor who queues again while an older settled entry is outstanding is paid out automatically
  first; one slot per account is sufficient by construction.
- **Instant `redeem`/`withdraw` works only while the vault is flat.** `canRedeemInstantly()` is the
  gate; otherwise both revert `UseQueue()`.

```bash
cast call $VAULT "canRedeemInstantly()(bool)" --rpc-url $RH_RPC   # true once phase() == 0
```

---

## 7. Close-out checks

```bash
cast call $VAULT "phase()(uint8)"            --rpc-url $RH_RPC   # 0 = Idle
cast call $VAULT "listingHash()(bytes32)"    --rpc-url $RH_RPC   # 0x00..00
cast call $VAULT "claimKey()(uint256)"       --rpc-url $RH_RPC   # 0
cast call $VAULT "optionId()(uint256)"       --rpc-url $RH_RPC   # 0
cast call $VAULT "totalAssets()(uint256)"    --rpc-url $RH_RPC
cast call $VAULT "idleAssets()(uint256)"     --rpc-url $RH_RPC
cast call $VAULT "convertToAssets(uint256)(uint256)" 1000000000000000000 --rpc-url $RH_RPC  # NVDA per share

# keeper gas
cast balance <keeper address> --rpc-url $RH_RPC
```

**Refill the keeper if it is below 0.02 ETH.** Target float ~0.05 ETH. A keeper that runs dry between
Saturday and the next roll is a silent unfilled week.

**Confirm the Overcall book agrees the order is done:**

```bash
curl -sS "https://overcall.finance/api/orders?offerer=$VAULT&status=all" | jq '.listings[] |
  {orderHash, status, quantity, remaining, filledNumerator, filledDenominator, realisedPremium6}'
```

> `realisedPremium6` from that API is the **writer's net** leg (gross minus Overcall's 5%), despite
> their docs describing it as gross. Do not publish it as gross, and do not do NAV math off any API
> field — do it off the USDG that actually landed in the vault.

---

## 8. Publish

Fill in `ops/publish-template.md` and post it. Publish **every** week, including the ones where nothing
happened. The honest zero is the product.

Numbers to carry across from the steps above:

| Field | Source |
|---|---|
| cycle number | step 1 `$CYCLE` |
| strike | step 1 `$STRIKE` (USDG 6 dp) |
| contracts written | step 1 `$WROTE` |
| contracts filled | `contractsSold` at step 1, cross-checked against the Overcall listing's `filledNumerator/filledDenominator` |
| gross premium (buyer paid) | `unitPrice6 * contractsFilled` |
| Overcall fee (5%) | `feePerContract6 * contractsFilled` — never entered the vault |
| assignment proceeds | `exerciseReceived` from the vault's `ClaimRedeemed` |
| harvest gross | sum of `Harvest.grossUsdg` over this cycle's `Harvest` events (includes assignment proceeds on an assigned week) |
| protocol fee (5% of premium) | sum of `Harvest.feeUsdg` over the cycle (== the fee Safe's balance delta); never includes a fee on assignment proceeds |
| net to depositors | sum of `Harvest.netUsdg` over the cycle |
| net USDG per share | sum over the cycle of `UsdgDistributed.credited / UsdgDistributed.totalSupply`, each event using its own `totalSupply` |
| assigned or not | step 1 `$ASSIGNED` vs `$WROTE`, cross-checked against `RollClose.contractsAssignedCount` |
| NVDA per share | `convertToAssets(1e18)` |

**Never publish an annualized number.** No APY, no "x% weekly", no projection. See
`ops/publish-template.md` § "Numbers never to publish".

---

## 9. Done-checklist

- [ ] pre-close snapshot captured **before** `rollClose` (optionId, claimKey, wrote, sold, strike, assigned)
- [ ] `rollClose()` mined; `phase() == 0`; `listingHash()` zero; `claimKey()` zero
- [ ] `underlyingReturned` + `exerciseReceived` reconcile against contracts written and the strike
- [ ] every `Harvest` for this `cycleNumber` collected (a mid-cycle deposit emits an extra one); each one's `feeUsdg` matches its own fee base (the close's is `grossUsdg - RollClose.usdgFromAssignment`) and summed gross/fee/net are consistent; the fee Safe's balance moved by the summed fee; `pendingFeeUsdg()` is back to 0; `accUsdgPerShare` moved (or the week was a clean 0)
- [ ] `QueueSettled` emitted if anyone queued; `queuedShares()` back to 0; epoch reserves recorded
- [ ] Overcall book shows the listing as `filled` / `expired`, not stuck `open`
- [ ] keeper gas topped up
- [ ] alert webhook fired a test message and it was seen (`ops/alerts.md` — an alert channel nobody has watched fire is not an alert channel)
- [ ] result published from `ops/publish-template.md`, including `unfilled, 0` if that is what happened
