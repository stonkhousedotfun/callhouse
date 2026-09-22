# Runbook — Close the week

**What this is.** The close after expiry. Redeem the Valorem claim (if anything sold), verify what
actually came back, check the harvest split, settle the redeem queue, and publish the result,
including when the result is `unfilled, 0`. It also covers the one close that does not finish: a
redeem that reverts inside USDG or the Stock Token leaves the claim **stranded**, and the vault
stays honest about it rather than bricking.

**Who runs it.** The keeper, from `cycleExpiryTs`. **Anyone** from `cycleExpiryTs + 1 hour`; the
vault must not depend on a hot key staying alive for depositors to get their money back. The
guardian, an admin signer, or a depositor can all call `rollClose()` after that hour.

**Time budget.** 15 minutes, plus however long the publish takes to write.

---

## Factory markets (read this first)

**The vault-shaped steps below belong to the closed pooled vault.** `rollOpen`, `approveListing`,
`lockBook`, `rollClose`, the phase machine and the redeem queue are `cNVDA`'s
(`0x88a98931E3682137E7e4D3426f623247f4A4ecbb`), which is closed and only pays out leftovers
(`app.stonkhouse.fun/collect`). **The live product is the per-market account factory**
(`src/solo/` in the contracts repository): one `AccountFactory` per Stock Token, isolated
`WriterAccount` clones, write on fill, one FULL 1-lot Seaport order per lot, each account on its
own option type. NVDA's factory is `0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb` (block
64,038,234); the other markets go live in waves (`ops/deploy.md` §14). Keep the vault steps for
the vault; run the factory equivalents in this preamble for every live market.

**Every market, from the registry.** `ops/markets/tier1.json` is the only list of markets
(`ops/markets/README.md`). Loop over the `live` rows and never type a factory address by hand:

```bash
# from the app repo root
REG=ops/markets/tier1.json
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
TICKERS=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.markets.filter(m=>m.status==="live").map(m=>m.ticker).join(" "))' "$REG")
for T in $TICKERS; do
  eval "$(node -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const m=r.markets.find(x=>x.ticker===process.argv[2]);
    console.log(`FACTORY=${m.deployment.factory} ASSET=${m.asset} FEED=${m.feed} KEEPER=${m.deployment.keeper} MODE=${m.mode}`);
  ' "$REG" "$T")"
  CLEAR=$(cast call $FACTORY "clear()(address)" --rpc-url $RH_RPC)
  echo "== $T factory=$FACTORY asset=$ASSET feed=$FEED keeper=$KEEPER mode=$MODE"
  cast call $FACTORY "week()(uint32,uint256,uint40,uint40,uint256)" --rpc-url $RH_RPC   # (id, strike6, exerciseTs, baseExpiryTs, ask6)
  cast call $FACTORY "writesHalted()(bool)"  --rpc-url $RH_RPC
  cast call $FACTORY "pendingCount()(uint256)" --rpc-url $RH_RPC   # accounts that requested lots and are not listed yet
  cast call $FACTORY "liveCount()(uint256)"    --rpc-url $RH_RPC   # accounts with live listings this week
  # ... the per-market reads for this runbook go here ...
done
```

The keeper key for a market is `KEEPER_PK` in `~/.callhouse-keys/markets/$T.env` (mode 600,
written by `ops/markets/derive-keeper-keys.sh`; NVDA's is the original keeper key, mnemonic
index 1). Load it into the shell only on the ops machine (`set -a; . ~/.callhouse-keys/markets/$T.env; set +a`),
pass it as `--private-key "$KEEPER_PK"`, and never print, echo or paste it. `cast` takes a raw key
only as an argument, so it sits in `ps` for the command's lifetime; that is accepted on the
single-user ops machine — anywhere shared, `cast wallet import <name>` once and use `--account <name>`. One key per market:
a key that works on TSLA holds no role on AAPL. The guardian (`0x29741A8d283a253E8Ce10aDfd04C6507438b6F39`)
and the admin (`0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b`) are the same on every factory.
Each market's keeper is its own Railway service, `keeper-<ticker>`:

```bash
railway ssh --service keeper-$(echo $T | tr '[:upper:]' '[:lower:]') -- wget -qO- http://127.0.0.1:8787/health
```

ABIs: `ops/abis/AccountFactory.json`, `ops/abis/WriterAccount.json`. Per-account reads take the
clone address from `pendingAt(i)` / `liveAt(i)`; `listFor(owner)` takes the **owner**, read with
`owner()` on the clone.

**Factory equivalents of the steps below:**

| Vault step | Factory equivalent, per market |
|---|---|
| §1 snapshot before the close | per live account (`liveAt(i)`, before `settle` zeroes them): `listedWeekId()`, `listedLots()`, `contractsWritten()` (= lots sold), `claimKey()`, `optionId()`, `listedStrikeUsdg()`, `listedExpiryTs()`. Assignment is Valorem's `claim(claimKey)` on `$CLEAR`, 1e18-scaled as before |
| §2 past expiry? | per account: its own `listedExpiryTs` (`baseExpiryTs + index`), not one market-wide timestamp. `settle` before it reverts `TooEarly()` |
| §3 close (`rollClose`) | `cast send $A "settle()" --rpc-url $RH_RPC --private-key <any funded key>`: **permissionless** after that account's `listedExpiryTs`. One call cancels leftover orders (Seaport counter bump), unlocks unsold tokens, and if anything was written redeems the claim (unassigned tokens back, strike USDG into the account). The keeper settles every live account; anyone can, so a dead keeper traps nothing |
| the stranded close | `settle` does not revert on a failed redeem (USDG paused, account or Clear frozen on USDG or blocked on the Stock Token): the listing clears, `listedExpiryTs` goes to 0 and `claimKey()` stays non-zero with the claim kept. **There is no retry**: a second `settle()` reverts `TooEarly` and `WriterAccount` has no other redeem (callhouse-contracts `docs/V1-RUNOFF.md`). Prevent it instead. The keeper does: before it settles an account with `claimKey != 0` it reads USDG `paused()`/`isFrozen` and the Stock Token `paused()`/`isBlocked` for the account and the Clear, and while any is true or any read fails it sends nothing for that account and alerts `v1_settle_held` (settle guard, `keeper/README.md`). Do not settle such an account by hand either; the manual check in `ops/runbooks/v1-runoff.md` step 8 is the backup |
| §4 verify the redeem | `Settled(nvdaReturned, strikeUsdg)` on the account: `nvdaReturned == (written − assigned) × 1e18`, `strikeUsdg == assigned × listedStrikeUsdg`; `clear.balanceOf(account, optionId) == 0`; `claimKey() == 0` after a successful redeem |
| §5 the harvest split | none. The 5% fee left inside each fill's Seaport order (second consideration item to `factory.feeRecipient()`) and 95% went to the owner's wallet at the fill. There is no `Harvest`, nothing to sum, no fee push to check |
| §6 the redeem queue | none. The owner `withdraw`s idle tokens and calls `claimUsdg()` whenever they like; nothing is reserved for anyone else |
| §7 close-out | `liveCount()` returns to 0 for the market once every listed account has settled; `pendingCount()` may already hold next week's requests. Keeper gas **per market** (`cast balance $KEEPER`), refill below 0.02 ETH |
| §8 publish | per market, one post each including `unfilled, 0`; the numbers come from `indexer-<ticker>` (`/v1/market/weeks`, `/v1/market/fills`) and reconcile against the accounts' `LotFilled` / `Settled` logs |

---

## 0. Shell setup

Same block as `open-week.md`:

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export SEAPORT=0x0000000000000068F116a894984e2DB1123eB395
export USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
export VAULT=<fill from ops/addresses.json after deploy>
export CLEAR=$(cast call $VAULT "clear()(address)" --rpc-url $RH_RPC)
export SAFE_FEE=<fill from ops/addresses.json after deploy>
export KEEPER_PK=<hot key, KEEPER_ROLE only>
```

> These commands are written for BSD `date` (macOS). On GNU/Linux replace every
> `date -u -r <ts>` with `date -u -d @<ts>`. Everything else is portable.

---

## 1. STOP — capture the pre-close state first

**`rollClose()` zeroes `optionId` and `contractsWritten`, and zeroes `claimKey` on a close that
redeems.** Every view that reads them returns 0 afterwards. If you do not snapshot now, the numbers
you need for the publish are gone and you will be reconstructing them from logs.

```bash
CYCLE=$(cast call $VAULT "cycleNumber()(uint32)"        --rpc-url $RH_RPC | cut -d' ' -f1)
OPT=$(cast call   $VAULT "optionId()(uint256)"          --rpc-url $RH_RPC | cut -d' ' -f1)
CLAIM=$(cast call $VAULT "claimKey()(uint256)"          --rpc-url $RH_RPC | cut -d' ' -f1)
WROTE=$(cast call $VAULT "contractsWritten()(uint112)"  --rpc-url $RH_RPC | cut -d' ' -f1)   # == sold
STRIKE=$(cast call $VAULT "cycleStrikeUsdg()(uint256)"  --rpc-url $RH_RPC | cut -d' ' -f1)
EXPIRY=$(cast call $VAULT "cycleExpiryTs()(uint40)"     --rpc-url $RH_RPC | cut -d' ' -f1)

echo "cycle=$CYCLE optionId=$OPT claimKey=$CLAIM written(=sold)=$WROTE strike6=$STRIKE expiry=$EXPIRY"
```

**If `claimKey == 0` nothing sold this week.** There is no claim to redeem, nothing can have been
assigned, and `rollClose` skips the redeem entirely (step 3, "the unsold week"). Skip the Valorem
reads below and go to step 2.

Otherwise, Valorem's own view of the claim is **the** source of truth for assignment:

```bash
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
> `vault.contractsAssigned()` already does the division; use it, and use it **now**, before close:

```bash
ASSIGNED=$(cast call $VAULT "contractsAssigned()(uint256)" --rpc-url $RH_RPC | cut -d' ' -f1)
echo "assigned contracts = $ASSIGNED of $WROTE written (= sold)"
```

Under write on fill `amountWritten / 1e18 == contractsWritten == the sum of this cycle's
`CallsWritten.contractsCount`. The vault was never assigned on more than it sold, and cannot be:
that is what the redesign bought.

Record all of the above in the week's notes. This is the raw material for the publish.

---

## 2. Are we actually past expiry?

```bash
NOW=$(cast block latest --rpc-url $RH_RPC -f timestamp)
echo "now=$NOW ($(date -u -r $NOW '+%Y-%m-%d %H:%M UTC %A'))"
echo "expiry=$EXPIRY ($(date -u -r $EXPIRY '+%Y-%m-%d %H:%M UTC %A'))"
cast call $VAULT "phase()(uint8)" --rpc-url $RH_RPC     # 1 Listed or 2 Exercisable
```

`rollClose` reverts `NotYetExpired(expiryTs)` before expiry, and `GuardianTooEarly(expiry + 3600)`
for a non-keeper caller in that first hour. Both are expected, not faults.

If `phase()` is still `1` (Listed), `lockBook()` was never called. That is fine: `rollClose`
accepts both `Listed` and `Exercisable`, and it invalidates any surviving listing itself.

---

## 3. Close

```bash
cast send $VAULT "rollClose()" --rpc-url $RH_RPC --private-key $KEEPER_PK
```

One transaction does four things, in this order:

1. bumps the Seaport counter if a listing is still live, so nothing can fill into the past
2. `clear.redeem(claimKey)` through a low-level call: collateral and any assignment proceeds come
   back, measured as real balance deltas. **Skipped when `claimKey == 0`** (the unsold week).
3. `_harvest(usdgFromAssignment)`: protocol fee on the **premium only** out to the fee Safe;
   everything else, assignment proceeds included in full, indexed into `accUsdgPerShare`
4. `_settleQueue()`: escrowed shares burned, their pro-rata NVDA and USDG reserved into an epoch

then `phase` returns to `Idle`.

**The unsold week.** With `claimKey == 0` the close emits `RollClose(cycle, 0, 0, 0)`, a
`Harvest` of whatever USDG arrived (normally 0), settles the queue, and instant redemption is back.
Publish `unfilled, 0` (Template B). Nothing was written, so nothing could be assigned.

**The stranded close.** If the redeem reverts (USDG paused; the vault or the Clear frozen on USDG;
the Clear's USDG burnt by the supply controller; the vault blocklisted on NVDA), `rollClose` does
**not** revert. It reaches Idle with the claim kept, emits `ClaimStranded(cycle, claimKey, gen)` and
a zero-leg `RollClose`, records each settling queue epoch's pro-rata share of the claim
(`EpochStrandShare`), and shuts deposits (`DepositsClosed`), instant redemption (`StillStranded`)
and the next `rollOpen`. A gas-starved close cannot fake this (`RedeemOutOfGas`). Go to
`incident.md` §9; the rest of this runbook resumes at step 6 once `retryStrandedClaim()` succeeds.

```bash
cast call $VAULT "isStranded()(bool)" --rpc-url $RH_RPC   # true == the close stranded
```

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
Valorem. That is deliberate: it stays correct even if Valorem nets a fee, and they are the numbers
the harvest and the queue payout are computed from.

**Reconcile:**

```
underlyingReturned  ==  (contractsWritten - assignedContracts) * 1e18
exerciseReceived    ==  assignedContracts * cycleStrikeUsdg
assignedContracts   ==  contractsWritten - underlyingReturned / 1e18
```

```bash
cast logs --address $VAULT $(cast keccak "ClaimRedeemed(uint256,uint256,uint256)") \
  --from-block $(( $(cast block-number --rpc-url $RH_RPC) - 200 )) --rpc-url $RH_RPC
```

If the two sides do not reconcile to the unit, **stop and do not publish a number.** Partial
assignment is normal; an unreconcilable redeem is not.

> **Cross-check assignment three ways; all three must agree.**
> 1. `contractsAssigned()` captured in step 1, **before** the close. The view returns `0` afterwards
>    because `rollClose` zeroes `claimKey`.
> 2. `RollClose.contractsAssignedCount`, the event's fourth field. `Vault.rollClose` reads
>    `contractsAssigned()` *before* the redeem and emits the real number.
> 3. `contractsWritten - underlyingReturned / 1e18` from the vault's own `ClaimRedeemed`.
>
> (1) and (2) are the same read taken at the same instant, so they are one source, not two. (3) is
> independent: a measured balance delta. **(3) disagreeing with (1)/(2) is
> `REDEEM_RECONCILE_FAILED`: do not publish a number.**

### Partial assignment is expected

Valorem assigns exercise across every writer of the option type. Every pre-exercise write lands in
bucket 0, so in practice assignment is pro rata across all writers of the id, bounded to what the
vault sold. A vault that sold `N` can come back with anywhere from `0` to `N` assigned, and a single
`redeem()` routinely returns **both** NVDA and USDG. Nothing in the vault asserts a 1:1 return.

### There are no leftover option tokens

The vault writes only what a buyer takes, inside the fill, and `validateOrder` reverts the fill
(`InventoryLeftBehind`) unless its option balance is back at the pre-fill baseline. After the close
`clear.balanceOf(vault, optionId)` is `0` and always was. If it is not, stop: something outside the
design happened, and the ERC-1155 receiver should have refused it.

```bash
cast call $CLEAR "balanceOf(address,uint256)(uint256)" $VAULT $OPT --rpc-url $RH_RPC  # 0
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
> does (with nothing excluded from the fee base, since assignment proceeds only arrive at the
> close). That exists so a depositor arriving after a fill cannot mint into premium earned before
> they got here. Consequences you must handle:
> - The week's totals are the **sum** of `Harvest.grossUsdg` / `feeUsdg` / `netUsdg` over every
>   `Harvest` carrying this `cycleNumber`, not the values on the close's event. If a fill landed and
>   then somebody deposited, the close's own event can legitimately read `(0, 0, 0)`.
> - The fee does **not** move at a checkpoint. `_accrueHarvest` only adds it to `pendingFeeUsdg`;
>   `_harvest()`, which runs from `rollClose` alone, transfers the accumulated total once.
> - The same applies to `UsdgDistributed`: sum `credited` over the cycle's events.
> - After a stranded close, the retry's `Harvest` carries the **stranded** cycle's number, not the
>   current one; include it in that cycle's sum when it lands.
>
> Read the carry before the close if you want to see it coming:
> ```bash
> cast call $VAULT "pendingFeeUsdg()(uint256)" --rpc-url $RH_RPC   # fee accrued, not yet paid out
> ```

**Where the gross came from.** `grossUsdg` is everything in the vault's USDG balance that was not
already owed to somebody: this week's filled premium **plus** any assignment proceeds. There is no
venue fee any more: the whole premium a buyer pays lands in the vault.

```
grossUsdg  ==  premium6 + exerciseReceived
premium6   ==  unitPrice6 * contractsWritten      # one price per listing; sum per listing if repriced
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
`floor(sum of fee bases * protocolFeeBps / 10000)`. Worked, assigned week: premium 20.000000,
5 contracts assigned at a 231.000000 strike, so `usdgFromAssignment = 1155000000` and
`grossUsdg = 1175000000`; `feeUsdg = floor(20000000 * 500 / 10000) = 1000000` (1.00 USDG), and
`netUsdg = 1174000000`. A `feeUsdg` of 58750000 (5% of the whole gross) would mean the fee was
taken on the strike proceeds, which the deployed contract must not do; check you read
`protocolFeeBps` and `usdgFromAssignment` from the right cycle, then treat it as wrong bytecode and
escalate (`ops/runbooks/incident.md`).

An unfilled, unassigned week harvests `0`, and `Policy.splitHarvest` returns `(0, 0)`: **the fee is
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

`pendingFeeUsdg() != 0` after the close means the fee push was deferred (USDG refused the transfer).
Nothing is stuck: anyone can `sweepFee()` later, and the close was not held hostage to it.

**Net USDG per share**, the one number the product promises:

```
netUsdgPerShare = credited / totalSupply        # both from the UsdgDistributed event
```

`totalSupply` there still **includes** the escrowed queued shares; the queue is settled after the
harvest, on purpose, so people who queued get their share of the week they actually sat through.
Use the event's own `totalSupply` field; do not re-read `totalSupply()` after the close.

Per-share as a decimal, from the event. With more than one `UsdgDistributed` in the cycle, do this
per event and add the results; each event has its own `totalSupply` and they are not interchangeable:

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

- `queueRedeem(shares)` moves shares into escrow **on the vault**. They keep earning that week's
  premium right up to settlement, and that accrual is paid out **with the redemption**, not left to
  the holders who stayed.
- Settlement snapshots **shares**, not assets. The payout is computed at settle time from
  `idleAssets() * queuedShares / totalSupply`.
- `reservedAssets` and `usdgReservedForQueue` are excluded from NAV, so a settled-but-unclaimed
  redemption does not inflate anyone else's share price.
- Each epoch is drawn down proportionally as people claim. The last claimant of an epoch has
  `shares == sharesRemaining` and takes exactly what is left, so the division strands no dust.
- **Anyone can settle a queue that formed while the vault is flat**: `settleQueue()` is
  permissionless in Idle and pays exactly what an instant redemption of the same shares would.
  The web app's "Settle queue" button and the keeper both call it. It moves no tokens, so it works
  under an issuer freeze and while halted.
  ```bash
  cast send $VAULT "settleQueue()" --rpc-url $RH_RPC --private-key <any funded key>
  ```
- Depositors collect themselves; there is nothing for ops to push:

```bash
cast call $VAULT "previewCompleteRedeem(address)(uint256,uint256)" <owner> --rpc-url $RH_RPC
# now includes the pro-rata ReserveHaircut (AF-05) and any settled stranded share.
# the depositor then calls, from their own wallet:
#   completeRedeem(address receiver)  -> (assets, usdgOut)
```

- `completeRedeem` pays the Stock Token leg with `safeTransfer` and the USDG leg best-effort: a USDG
  pause or a frozen receiver defers the USDG (`UsdgLegDeferred`, collectable later) instead of
  trapping the NVDA. `UsdgLegBlocked` means neither paid nor deferrable; escalate.
- A depositor who queues again while an older settled entry is outstanding is paid out
  automatically first; one slot per account is sufficient by construction.
- **Instant `redeem`/`withdraw` works only while the vault is flat and not stranded.**
  `canRedeemInstantly()` is the gate; otherwise both revert `UseQueue()` (or `StillStranded()`).

```bash
cast call $VAULT "canRedeemInstantly()(bool)" --rpc-url $RH_RPC   # true once phase() == 0 and not stranded
```

---

## 7. Close-out checks

```bash
cast call $VAULT "phase()(uint8)"            --rpc-url $RH_RPC   # 0 = Idle
cast call $VAULT "isStranded()(bool)"        --rpc-url $RH_RPC   # false
cast call $VAULT "listingHash()(bytes32)"    --rpc-url $RH_RPC   # 0x00..00
cast call $VAULT "claimKey()(uint256)"       --rpc-url $RH_RPC   # 0
cast call $VAULT "optionId()(uint256)"       --rpc-url $RH_RPC   # 0
cast call $VAULT "totalAssets()(uint256)"    --rpc-url $RH_RPC   # honest NAV: max(balance + locked − reserved, 0)
cast call $VAULT "idleAssets()(uint256)"     --rpc-url $RH_RPC
cast call $VAULT "convertToAssets(uint256)(uint256)" 1000000000000000000 --rpc-url $RH_RPC  # NVDA per share
cast call $VAULT "maxDeposit(address)(uint256)" 0x0000000000000000000000000000000000000001 --rpc-url $RH_RPC  # > 0 again

# keeper gas
cast balance <keeper address> --rpc-url $RH_RPC
```

**Refill the keeper if it is below 0.02 ETH.** Target float ~0.05 ETH. A keeper that runs dry between
the close and the next open is a silent unfilled week.

**Confirm Seaport agrees the order is done:**

```bash
cast call $SEAPORT "getOrderStatus(bytes32)(bool,bool,uint256,uint256)" <this week's listingHash> --rpc-url $RH_RPC
# isCancelled true, or the counter moved so the hash is dead; totalFilled/totalSize is the fill fraction
```

---

## 8. Publish

Fill in `ops/publish-template.md` and post it. Publish **every** week, including the ones where
nothing happened. The honest zero is the product.

Numbers to carry across from the steps above:

| Field | Source |
|---|---|
| cycle number | step 1 `$CYCLE` |
| strike | step 1 `$STRIKE` (USDG 6 dp) |
| contracts sold (= written) | step 1 `$WROTE`; equals the sum of the cycle's `CallsWritten.contractsCount` and Seaport's `totalFilled/totalSize × listingAmount` |
| premium received (buyer paid) | `unitPrice6 × contractsWritten`, per listing if repriced; no venue fee, all of it lands in the vault |
| assignment proceeds | `exerciseReceived` from the vault's `ClaimRedeemed` |
| harvest gross | sum of `Harvest.grossUsdg` over this cycle's `Harvest` events (includes assignment proceeds on an assigned week) |
| protocol fee (5% of premium) | sum of `Harvest.feeUsdg` over the cycle (== the fee Safe's balance delta, or `pendingFeeUsdg` if deferred); never includes a fee on assignment proceeds |
| net to depositors | sum of `Harvest.netUsdg` over the cycle |
| net USDG per share | sum over the cycle of `UsdgDistributed.credited / UsdgDistributed.totalSupply`, each event using its own `totalSupply` |
| assigned or not | step 1 `$ASSIGNED` vs `$WROTE`, cross-checked against `RollClose.contractsAssignedCount` |
| NVDA per share | `convertToAssets(1e18)` |
| stranded | `isStranded()` after the close; if `true`, Template E, and the numbers above wait for the retry |

**Never publish an annualized number.** No APY, no "x% weekly", no projection. See
`ops/publish-template.md` § "Numbers never to publish".

---

## 9. Done-checklist

- [ ] pre-close snapshot captured **before** `rollClose` (optionId, claimKey, written, strike, assigned)
- [ ] `rollClose()` mined; `phase() == 0`; `listingHash()` zero; `claimKey()` zero; `isStranded()` false (if true: `incident.md` §9, Template E)
- [ ] on a sold week: `underlyingReturned` + `exerciseReceived` reconcile against contracts written and the strike; `clear.balanceOf(vault, optionId) == 0`
- [ ] every `Harvest` for this `cycleNumber` collected (a mid-cycle deposit emits an extra one); each one's `feeUsdg` matches its own fee base (the close's is `grossUsdg - RollClose.usdgFromAssignment`) and summed gross/fee/net are consistent; the fee Safe's balance moved by the summed fee (or `pendingFeeUsdg()` explains the gap); `accUsdgPerShare` moved (or the week was a clean 0)
- [ ] `QueueSettled` emitted if anyone queued; `queuedShares()` back to 0; epoch reserves recorded
- [ ] Seaport shows the listing cancelled or dead by counter, not live
- [ ] keeper gas topped up
- [ ] alert webhook fired a test message and it was seen (`ops/alerts.md`; an alert channel nobody has watched fire is not an alert channel)
- [ ] result published from `ops/publish-template.md`, including `unfilled, 0` if that is what happened
