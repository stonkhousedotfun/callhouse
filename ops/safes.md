# Safe topology and key roles

Four keys. Two of them are Safes, one is a hot EOA, one is a Safe that holds no power at all.

| Key | Form | Threshold | Holds | Lives |
|---|---|---|---|---|
| **Admin** | Gnosis Safe | **2 of 3** | `DEFAULT_ADMIN_ROLE` (`0x00…00`) | 3 signers, 3 devices, at least 2 jurisdictions. At least one signer on a hardware wallet that has never touched a hot machine |
| **Keeper** | plain EOA, hot | 1 of 1 | `KEEPER_ROLE` | The keeper host. Funded with ~0.05 ETH on 4663, nothing else |
| **Guardian** | Safe or hardware EOA | **1 of 1** | `GUARDIAN_ROLE` | **Separate hardware from every admin signer, and a different continent.** Held by a person who is awake when the admin signers are asleep |
| **Fee** | Gnosis Safe | 2 of 3 (or whatever treasury policy says) | **no role on the vault** | Wherever treasury lives |

Role identifiers, for `hasRole` / `grantRole` / `revokeRole`:

```
DEFAULT_ADMIN_ROLE  0x0000000000000000000000000000000000000000000000000000000000000000
KEEPER_ROLE         0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab
GUARDIAN_ROLE       0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041
```

Verify rather than trust this file:
```bash
cast call $VAULT "KEEPER_ROLE()(bytes32)"   --rpc-url $RH_RPC
cast call $VAULT "GUARDIAN_ROLE()(bytes32)" --rpc-url $RH_RPC
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x0000000000000000000000000000000000000000000000000000000000000000 $SAFE_ADMIN --rpc-url $RH_RPC
```

The addresses themselves go in `ops/addresses.json` under `chains.4663.ours` at deploy. They are
explicit `null` until then. Never assume `null` means `address(0)`.

---

## 1. Admin Safe — 2 of 3

Holds `DEFAULT_ADMIN_ROLE`. Governance, not operations. It should sign a handful of times a year.

### Can

| Function | Effect | Bounded by |
|---|---|---|
| `setPolicy(PolicyParams)` | OTM band, min premium, utilization, protocol fee, contracts cap | Hard caps compiled into `Policy.validate` — see §5 |
| `setFeeRecipient(address)` | Where the protocol fee lands | Non-zero only |
| `setDepositCap(uint256)` | TVL ceiling | Nothing |
| `setMaxPriceAge(uint32)` | Oracle staleness tolerance | `[1 hour, 7 days]`, `PriceAgeOutOfBounds` outside |
| `acceptValoremFee(bool)` | Permits writing while Valorem's 15 bps notional fee is on | Nothing — it is a deliberate, isolated switch |
| `unhaltWrites()` | Resumes writing after a halt | Nothing |
| `haltWrites()` | Also available to admin, not only guardian | Nothing |
| `grantRole` / `revokeRole` | Rotate keeper or guardian; add or remove admins | Nothing |

### Cannot

- **Move a depositor's NVDA or USDG.** There is no admin-gated transfer anywhere in the vault. See §4.
- Sell at-the-money calls. `minOtmBps` has a floor of **100 bps** in the bytecode
  (`Policy.MIN_OTM_FLOOR_BPS`); `setPolicy` reverts `MinOtmBelowFloor` below it.
- Take more than **20%** of harvested premium (`PROTOCOL_FEE_CEIL_BPS = 2000`, reverts `ProtocolFeeAboveCeiling`).
- Take any fee on strike proceeds. `rollClose` excludes the USDG it measures coming out of the
  Valorem claim from the fee base; that is bytecode, not a `policy` field, so no setting reaches it.
- List for dust: `minPremiumBps` has a floor of **10 bps** (`MIN_PREMIUM_FLOOR_BPS`).
- Write more than 99.85% of NAV (`MAX_UTILIZATION_CEIL_BPS = 9985`; the residue keeps the
  post-write reserve check, `ReserveBreached`, satisfiable at every fill).
- Upgrade anything. There is no proxy. A fix is Vault v2 plus a migration.
- Disable the staleness check (`MIN_PRICE_AGE = 1 hour`) or widen it past a week
  (`MAX_PRICE_AGE_CEIL = 7 days`).

### What admin CAN do that is worth saying out loud

An honest threat model names its own worst case:

- It can point `feeRecipient` at itself and raise `protocolFeeBps` from the launch 500 to the 2000 bps
  ceiling, taking **20% of harvested premium** — on filled weeks only, never of principal. Strike
  proceeds on an assigned week are outside the fee base, so the ceiling bounds a cut of premium, not
  of the collateral the assigned depositors sold at the strike.
- It can grant itself `KEEPER_ROLE`, arm a strike at the band floor, list at the premium floor and
  fill its own listing: about **2.2% of sold notional per week** at launch policy (the keeper alone,
  without the power to loosen policy, about 1.1%). `contracts/SECURITY.md` §3 has the derivation.
  Everything is still bounded by `Policy`'s compiled floors, so this is a pricing leak on what it
  sells, not an extraction of principal.
- It can grant `DEFAULT_ADMIN_ROLE` to a fourth address. There is **no timelock** on any admin action.
- Until the handover, **one deployer key** holds all of this (bootstrap admin, §7).

That is the shape of the admin trust assumption. It is a fee-and-pricing trust, not a custody trust.
If it is not acceptable, the answer is a timelock, higher compiled floors or a listing start delay
(all open decisions in `contracts/SECURITY.md` §3), not a paragraph here.

### Signing policy

- No single signer proposes and executes.
- Every transaction is simulated against a fork before signing, and the decoded calldata is read aloud
  (literally) by the second signer.
- `setPolicy` is sent as the **whole struct** — reading all six fields back before signing is how a
  typo in field four is caught.
- The third signer is a cold recovery key, not a routine co-signer.

---

## 2. Keeper — hot EOA

Holds `KEEPER_ROLE`. The only key that signs weekly.

### Can
- `clear.newOptionType(asset, 1e18, usdg, strike, exerciseTs, expiryTs)` — create the week's option
  type on the clearinghouse. Permissionless; anyone can, the keeper does
- `rollOpen(uint256 optionId)` — **arm** the week. Writes nothing; the vault re-reads the tuple from
  the clearinghouse and refuses anything outside the band, the window or the lot
- `approveListing(OrderComponents)` — authorise the one restricted listing, at most 3 per cycle
  (cancelled or not); a relist is a reprice
- `cancelListing(OrderComponents)` — kill the live listing
- `invalidateAllListings()` — bump the Seaport counter
- `lockBook()` — also permissionless after `cycleExerciseTs`
- `rollClose()` — from `cycleExpiryTs` (anyone else from `+1 hour`)
- `retryStrandedClaim()`, `settleQueue()`, `sweepFee()` — but so can anybody; not keeper powers

### Cannot
- **Make the vault write anything.** Only a buyer's fill does that, inside Seaport's
  `authorizeOrder`, and the hook re-prices the band floor and the premium floor at the spot of that
  block. `rollOpen` arms; it does not write.
- **Hold the option ERC-1155 or the claim NFT.** The vault is the Seaport offerer, the zone and the
  Valorem writer; there is no inventory anywhere, ever, outside the two hooks of a fill. This is the
  single most important property of the design.
- List for a dollar, past the exercise window, or on a shape Seaport's hooks would not run.
  `approveListing` checks **every field** of the proposed order against vault state before
  authorising it: `orderType == 3` (PARTIAL_RESTRICTED), `zone == vault`, `zoneHash == 0`,
  `conduitKey == vault.conduitKey()`, exactly one consideration item, USDG to the vault, the offer
  the armed `optionId` on `vault.clear()`, the amount at most the remaining capacity
  (`Policy.maxContracts(totalAssets()) − contractsWritten()`), `startAmount == endAmount` (no Dutch
  auction), `gross % amount == 0`, `unit ≤ strike`, `endTime ≤ cycleExerciseTs`, the counter live.
- Arm outside the OTM band, or list below the premium floor; and no fill goes through under the
  live floor.
- Halt, unhalt, or change any parameter.
- Move a token. It has no path to one.

### What the keeper CAN do that is worth saying out loud
It chooses the strike inside the band and the price inside policy, and it can fill its own listing.
Arming at the band floor and listing at the premium floor, then buying, takes about **1.1% of sold
notional per week** at launch policy (`contracts/SECURITY.md` §3). That is the whole bound, it is
on what the vault sells rather than on principal, and the mitigations (higher compiled floors, a
listing start delay, vol-model pricing) are open decisions there.

### Compromise response
A stolen keeper key costs gas and, at worst, a week sold at the floor to the thief. Revoke and
rotate from the admin (the deployer key at bootstrap, the Safe after the handover); the commands
are in `ops/runbooks/incident.md` §4. Do not panic-move inventory; there is none to move.

### Hygiene
- Gas float ~0.05 ETH; alert below 0.02; refill every week as part of `close-week.md`.
- Never holds NVDA, USDG, or shares. If it ever does, something is wrong.
- State lives in SQLite on the keeper host, but the keeper must be able to re-derive everything from
  chain on restart. Never restore it from a stale database and let it act.
- Serves `/orders`, the fill page's only order source, on the private network. No public domain.

---

## 3. Guardian — 1 of 1, separate hardware, different continent

An emergency brake that is deliberately weak. Its whole value is that it can be used without a quorum
at 03:00 local, so it is given only powers that are safe to hand one person.

### Can
- `haltWrites()` — blocks `rollOpen`, `approveListing` and every **fill** (`authorizeOrder`
  refuses, so a live listing stops selling instantly). Nothing else.
- `cancelListing(OrderComponents)` — cancel the authorised order on Seaport
- `invalidateAllListings()` — bump the counter; kills every outstanding order and **needs no order
  data**, which is what makes it usable when the keeper is gone and nobody can reconstruct the
  components
- `rollClose()` from `expiry + 1 hour` — but so can anybody; this is not a guardian power

### Cannot
- `unhaltWrites()`. **The guardian can stop, never start.** Resuming is an admin decision by
  construction, so a compromised guardian is a denial of service with a 2-of-3 undo, not a lever.
- Change any parameter, grant any role, or touch the fee recipient.
- **Move a token anywhere, to itself or otherwise.** See §4.

### What a guardian halt does NOT block

This matters more than what it does block. `writesHalted` is read in exactly three places:
`rollOpen`, `approveListing` and the `authorizeOrder` hook (and the one deposit gate, below). All of
the following keep working through a halt:

- `queueRedeem` — a depositor can always get in the queue
- `settleQueue` — a queue that formed while flat can always be settled, by anyone
- `completeRedeem` — a settled redemption always pays out
- `claimUsdg` / `claimUsdgTo` — earned premium is always claimable
- `redeem` / `withdraw` — instant exits, while the vault is flat and not stranded
- `rollClose` — settlement can never be held hostage
- `retryStrandedClaim` — a stranded claim can always be retried, by anyone
- `cancelListing` / `invalidateAllListings` / `lockBook` — the listing can always be killed

`deposit` / `mint` **are** closed by a halt: it is one of the five reasons of the single
`DepositsClosed` gate (halted, stranded, past `cycleExerciseTs`, at the cap, reserve unbacked). A
halt stops new money coming in while somebody works out why it was pulled.

---

## 4. "The guardian can halt and cancel but can never move tokens to itself"

This is the load-bearing claim on this page. Do not take it on faith — it is checkable in about two
minutes, and every reviewer should check it.

### Step 1 — enumerate every guardian-gated entry point

```bash
cd contracts
grep -n "GUARDIAN_ROLE" src/Vault.sol
```

Expect exactly six lines: the constant declaration, and the role check inside **three** functions.
Re-run against `Vault.sol` at commit `ca0e985` on 2026-09-13 (branch
`redesign/a2-own-strikes-2026-09-13`); **the line numbers move whenever the contract is edited, so
match on the function names, not on the numbers**:

```
  58:    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
1312:        if (!hasRole(KEEPER_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {   <- cancelListing
1322:        if (!hasRole(KEEPER_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {   <- invalidateAllListings
1323:            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
1704:        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {  <- haltWrites
1705:            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
```

Resolve each hit to its enclosing function rather than trusting the annotations above:

```bash
# POSIX awk: [ \t]* rather than \s, so this works with macOS awk as well as gawk
awk 'BEGIN{f="?"} /^[ \t]*function [A-Za-z_]/{match($0,/function [A-Za-z_][A-Za-z0-9_]*/); f=substr($0,RSTART+9,RLENGTH-9)} /GUARDIAN_ROLE/{print NR": "f}' src/Vault.sol
# 58: ?   (the constant itself)   1312: cancelListing   1322/1323: invalidateAllListings   1704/1705: haltWrites
```

The two Seaport hooks, `authorizeOrder` and `validateOrder`, are gated on `msg.sender == seaport`
(`NotSeaport`), not on a role; no key reaches them.

So the guardian's entire reachable surface is `cancelListing`, `invalidateAllListings`, `haltWrites`.
(If this grep ever returns a fourth function, this document is out of date and the claim is unverified.)

### Step 2 — enumerate every place the vault moves a token

```bash
grep -rnE "safeTransfer|safeTransferFrom\(|forceApprove|setApprovalForAll|\.transfer\(|IERC20\.transfer|\.call\(|\.call\{" \
  src/Vault.sol src/Distributor.sol src/AdapterValorem.sol src/AdapterSeaport.sol src/lib/SeaportOrderLib.sol src/lib/ValoremLib.sol
```

The pattern deliberately includes `IERC20.transfer` and `.call(`/`.call{`: the fee push and the
USDG leg of a redemption are **raw calls**, not `safeTransfer` (best-effort by design, AF-03 and
defect 12), and the low-level Valorem redeem is a `.call` too (AF-02: a revert inside USDG or the
Stock Token strands the claim instead of bricking the close). Expect exactly **fifteen hits: eleven
transfer/approve/call sites plus four comment lines** (`Vault.sol:959`, `:963`,
`AdapterValorem.sol:165`, `ValoremLib.sol:237`, which merely mention the words). Re-run against
`ca0e985` on 2026-09-13. Again: match the enclosing function, not the line number.

| Site | Enclosing function | Reachable by |
|---|---|---|
| `Vault.sol:683` `asset.safeTransferFrom(msg.sender, …)` | `deposit` | anyone (through the one `DepositsClosed` gate) — pulls IN |
| `Vault.sol:702` `asset.safeTransferFrom(msg.sender, …)` | `mint` | anyone — pulls IN |
| `Vault.sol:751` `asset.safeTransfer(receiver, assets)` | `redeem` | anyone, burns **their own** shares; only while flat and not stranded |
| `Vault.sol:766` `asset.safeTransfer(receiver, assets)` | `withdraw` | anyone, burns **their own** shares; same gate |
| `Vault.sol:995` `asset.safeTransfer(receiver, assets)` | `_payoutOwed`, reached from `completeRedeem` → `_completeRedeem(msg.sender, receiver)` | pays only `owedAssets[msg.sender]`, the caller's own settled queue entry (the Stock Token leg; a freeze reverts it, AF-03) |
| `Vault.sol:1024` `address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)))` | `_tryTransfer`, reached from (a) `_payoutOwed`'s USDG leg (`owedQueueUsdg[msg.sender]`, best-effort, deferred on failure: `UsdgLegDeferred`) and (b) `_tryPayFee`, from `_harvest` (only from `rollClose` / `retryStrandedClaim`) and the permissionless `sweepFee()` | (a) the caller's own settled USDG; (b) always the admin-set `feeRecipient`, clamped to balance, never `msg.sender`; a failure leaves `pendingFeeUsdg` untouched |
| `Distributor.sol:194` `usdg.safeTransfer(to, amount)` | `_claimUsdg` | pays the caller's own accrued balance, which is a function of their share balance |
| `ValoremLib.sol:241/250` `asset.forceApprove(address(clear), collateral + fee)` then `… , 0)` | `writeOnFill` (a `public` library reached by DELEGATECALL from the vault's `authorizeOrder`) | **Seaport only**, inside a fill (`NotSeaport` otherwise); the approval is set for exactly the write and reset to 0 in the same call. Nothing the keeper calls reaches it |
| `ValoremLib.sol:327` `address(clear).call(abi.encodeCall(IValoremClear.redeem, (claimKey)))` | `tryRedeemClaim`, from `AdapterValorem._tryRedeemClaim`, from `rollClose` and `retryStrandedClaim` | anyone (after expiry + 1 h / whenever stranded); the redeem pays the **vault**, never the caller; a failure strands the claim rather than reverting |
| `AdapterSeaport.sol:222` `setApprovalForAll(transferApprovalTarget, true)` | `_approveOptionTransfers` | **constructor only** |

`Vault.sol:959`, `:963`, `AdapterValorem.sol:165` and `ValoremLib.sol:237` are the comment hits.
There is no other `.call(`, `.call{`, `delegatecall`-by-hand or `IERC20.transfer` in these six
files; `SeaportOrderLib.sol` contributes no hit at all (it moves no token: `validate`, `cancel`
and `getOrderHash` only). Note what is **absent**: there is no transfer site reachable from
`rollOpen` any more. Arming moves nothing.

### Step 3 — confirm the intersection is empty

Read the three guardian-reachable functions end to end. They are short:

- `haltWrites` sets `writesHalted = true` and emits. That is the whole body.
- `cancelListing` → `_cancelListing` → `SeaportOrderLib.cancel` → `seaport.cancel(orders)`. No transfer.
- `invalidateAllListings` → `_invalidateAllListings` → `seaport.incrementCounter()`. No transfer.

**None of the three touches any of the sites in step 2.** The guardian moves a boolean and two Seaport
bookkeeping values. There is no code path from `GUARDIAN_ROLE` to a token transfer, and because there is
no proxy there is no way to add one without deploying a new vault.

### Step 4 — the same check for admin

Run step 1 again with `DEFAULT_ADMIN_ROLE` / `onlyRole(DEFAULT_ADMIN_ROLE)` and cross-reference against
step 2. The only intersection is the `_tryTransfer` raw call reached through `_tryPayFee`
(`Vault.sol:1024`), and it is indirect: admin sets `feeRecipient`, and `rollClose` /
`retryStrandedClaim` (via `_harvest`) or anyone (via `sweepFee()`) later sends the accrued
`pendingFeeUsdg` there. Admin never calls a transfer itself, and the fee is capped at 20% of
harvested premium, with strike proceeds excluded. That is the complete extent of admin's reach into
the token flow. Its other reach is pricing (above): it can loosen `Policy` to the compiled floors
and grant itself the keeper role, which leaks about 2.2% of sold notional per week, on what the
vault sells. Note that `Vault.sol:1024` is exactly the site a grep pattern without
`IERC20.transfer` / `\.call\(` does not match; run step 2 with the pattern as written or step 4 will
wrongly conclude that admin has no reach at all.

### Step 5 — the same check for Seaport

The one external caller with a path to a write is Seaport 1.6, through `authorizeOrder` →
`ValoremLib.writeOnFill` (the `forceApprove` sites). Read `authorizeOrder` end to end: it refuses
any caller but the Seaport immutable, any order but the live listing's hash, writes at most the
capacity policy allows, approves exactly the minted tokens for Seaport to move, and `validateOrder`
reverts the whole fill unless the vault's option balance is back where it started. A compromised
Seaport could take what one fill mints, bounded to that fill; it cannot reach idle collateral, the
claim, or the USDG index.

---

## 5. The caps governance cannot move

Compiled into `Policy` and into `Vault`. These are the bytecode, not the configuration.

| Cap | Value | Stops |
|---|---|---|
| `Policy.MIN_OTM_FLOOR_BPS` | 100 (1%) | An admin selling at-the-money calls |
| `Policy.MAX_OTM_CEIL_BPS` | 2500 (25%) | A band so wide it earns nothing |
| `Policy.MIN_PREMIUM_FLOOR_BPS` | 10 (0.10%) | Listing for dust |
| `Policy.MAX_UTILIZATION_CEIL_BPS` | 9985 (99.85%) | Writing more than the vault holds; the residue keeps the post-write `ReserveBreached` check satisfiable (AF-04) |
| `Policy.PROTOCOL_FEE_CEIL_BPS` | 2000 (20% of premium) | A fee that eats the product. Strike proceeds are never in the fee base at any setting |
| `Policy.MAX_LISTINGS_PER_CYCLE` | 3 (authorisations, cancelled or not) | A keeper ratcheting the price down all week |
| `Policy.LOT` | 1e18 | Any option type whose lot is not one Stock Token (`UnexpectedLotSize`) |
| `ValoremLib.MIN_LEAD` / `MIN_EXERCISE_WINDOW` / `MAX_CYCLE_TENOR` | 1 hour / 1 day / 21 days | A type that can be assigned in the tick it is sold, a window too short to exercise, or collateral locked for years |
| `Vault.MIN_PRICE_AGE` | 1 hour | Disabling the staleness check by setting it absurdly tight |
| `Vault.MAX_PRICE_AGE_CEIL` | 7 days | Turning the staleness check off by setting it absurdly wide |

Launch policy: `minOtmBps 300, maxOtmBps 1200, minPremiumBps 40, maxUtilizationBps 9500,
protocolFeeBps 500, maxContractsCap 50`; `maxPriceAge` 4 days; deposit cap 20 NVDA. Both band
bounds are checked at arm; the band floor and the premium floor are re-checked at **every fill** at
live spot.

---

## 6. Fee Safe

Receives the protocol fee on harvested premium (5% at launch; strike proceeds are never fee'd). **Holds no role on the vault**, is not a signer on
anything, and cannot call any vault function that a stranger could not.

```bash
cast call $VAULT "feeRecipient()(address)" --rpc-url $RH_RPC
cast call $USDG  "balanceOf(address)(uint256)" $SAFE_FEE --rpc-url $RH_RPC
```

Its balance should increase, on each `rollClose`, by exactly the **sum** of `Harvest.feeUsdg` over
every `Harvest` event carrying that `cycleNumber` — equivalently, by `pendingFeeUsdg()` read
immediately before the close. It is a sum and not a single event because `deposit`/`mint` run
`_checkpointHarvest()`, which accrues fee into `pendingFeeUsdg` without paying it out; only `_tryPayFee`,
reached from `_harvest` (only from `rollClose`) and from the permissionless `sweepFee()`, transfers. The
push is best-effort: if USDG rejects the transfer the fee stays in `pendingFeeUsdg` and the Safe's balance
rises later, on whichever `sweepFee()` or `rollClose` first succeeds. Reconciling against the close's own
`Harvest.feeUsdg` will falsely fail whenever somebody deposited after a fill or a push was deferred.
After a stranded close, the retry's `Harvest` carries the stranded cycle's number and its fee
arrives then.

On an unfilled week the increase is zero — the fee is charged only on premium, so a 0 week is free for
depositors. On an assigned week the increase is still only the fee on the premium: the close's
`Harvest.grossUsdg` includes the strike proceeds, but its `feeUsdg` is
`floor((grossUsdg - RollClose.usdgFromAssignment) * protocolFeeBps / 10000)`
(`ops/runbooks/close-week.md` §5, "Check the harvest split").

```bash
cast call $VAULT "pendingFeeUsdg()(uint256)" --rpc-url $RH_RPC   # before close: what is owed
                                                                 # after close: 0
```

---

## 7. Deploy-day checklist

**The checks below are automated.** `script/Verify.s.sol` in `contracts/` (leekzor/callhouse-contracts)
performs every one of them and more: the vault's and both libraries' bytecode byte for byte against the
audited build, every immutable, the policy field by field, roles for the admin phase, and the Safe's
build, threshold, owners, modules and guard. Run it, per `contracts/docs/DEPLOY.md`, instead of the
`cast` calls; the calls stay here as a manual cross-check.

**Launch plan: bootstrap admin, then handover.** The vault is deployed with the deployer key as
`DEFAULT_ADMIN_ROLE` (`ADMIN` = deployer), configured from that key, and later handed to the admin
Safe with `script/HandoverAdmin.s.sol`: `STEP=grant`, the Safe executes the smoke batch, then
`STEP=renounce`, which refuses until the Safe has executed a transaction after the grant. Until that
renounce, check 1 below reads the other way round (the deployer is admin) — use
`Verify.s.sol` with `ADMIN_PHASE=bootstrap`. While the deployer is admin, that one key has every power
listed in §1 "Can".

```bash
# 1. After the handover: admin is the Safe, and the deployer is not an admin
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x0000000000000000000000000000000000000000000000000000000000000000 $SAFE_ADMIN --rpc-url $RH_RPC   # true
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x0000000000000000000000000000000000000000000000000000000000000000 <deployer>  --rpc-url $RH_RPC   # false (true during bootstrap)

# 2. Keeper and guardian are exactly who they should be, and are not each other
cast call $VAULT "hasRole(bytes32,address)(bool)" 0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab $KEEPER   --rpc-url $RH_RPC
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041 $GUARDIAN --rpc-url $RH_RPC

# 3. The keeper does NOT hold guardian or admin, and the guardian does NOT hold keeper or admin
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041 $KEEPER   --rpc-url $RH_RPC   # false
cast call $VAULT "hasRole(bytes32,address)(bool)" 0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab $GUARDIAN --rpc-url $RH_RPC   # false

# 4. Asset, clearinghouse, Seaport and fee wiring (there is no registry)
cast call $VAULT "asset()(address)"         --rpc-url $RH_RPC   # 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
cast call $VAULT "usdg()(address)"          --rpc-url $RH_RPC   # 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
cast call $VAULT "clear()(address)"         --rpc-url $RH_RPC   # Overcall's 0x9a7b40e5…C0C0, or our own from DeployClear; record it in addresses.json
cast call $VAULT "seaport()(address)"       --rpc-url $RH_RPC   # 0x0000000000000068F116a894984e2DB1123eB395
cast call $VAULT "priceFeed()(address)"     --rpc-url $RH_RPC   # 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
cast call $VAULT "feeRecipient()(address)"  --rpc-url $RH_RPC   # the fee Safe
cast call $VAULT "conduitKey()(bytes32)"    --rpc-url $RH_RPC   # 0x00..00
cast call $VAULT "seaportZone()(address)"   --rpc-url $RH_RPC   # == $VAULT (the vault is its own zone)
cast call $CLEAR "feesEnabled()(bool)"      --rpc-url $RH_RPC   # false
cast call $CLEAR "feeBps()(uint8)"          --rpc-url $RH_RPC   # 15

# 5. Seaport can actually move what a fill mints
cast call $CLEAR "isApprovedForAll(address,address)(bool)" $VAULT $SEAPORT --rpc-url $RH_RPC   # true
cast call $CLEAR "balanceOf(address,uint256)(uint256)" $VAULT 1 --rpc-url $RH_RPC               # 0: the vault holds no option token, ever

# 6. The guardian claim, re-verified against the deployed source (§4)
```

The deployer renounces `DEFAULT_ADMIN_ROLE` only through `HandoverAdmin.s.sol STEP=renounce` — **after**
the Safe holds it and has executed a transaction as admin, and never from the only account that holds it.

Record every address in `ops/addresses.json` under `chains.4663.ours`, replacing the nulls
(`vault`, `clearinghouse` = `vault.clear()`, both libraries — the CREATE2 addresses for the pinned
build are in `contracts/docs/DEPLOY.md` — both Safes, guardian, keeper, the deploy block), and set
`adminPhase`.
