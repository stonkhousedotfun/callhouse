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
- Write more than 100% of idle (`MAX_UTILIZATION_CEIL_BPS = 10000`).
- Upgrade anything. There is no proxy. A fix is Vault v2 plus a migration.
- Disable the staleness check (`MIN_PRICE_AGE = 1 hour`) or widen it past a week
  (`MAX_PRICE_AGE_CEIL = 7 days`).

### What admin CAN do that is worth saying out loud

An honest threat model names its own worst case:

- It can point `feeRecipient` at itself and raise `protocolFeeBps` from the launch 500 to the 2000 bps
  ceiling, taking **20% of harvested premium** — on filled weeks only, never of principal. Strike
  proceeds on an assigned week are outside the fee base, so the ceiling bounds a cut of premium, not
  of the collateral the assigned depositors sold at the strike.
- It can grant itself `KEEPER_ROLE` and roll the position. Everything the keeper does is still bounded
  by `Policy`, so this buys it a legal-but-unwatched write, not an extraction.
- It can grant `DEFAULT_ADMIN_ROLE` to a fourth address. There is **no timelock** on any admin action.

That is the shape of the admin trust assumption. It is a fee-and-parameters trust, not a custody trust.
If it is not acceptable, the answer is a timelock in v2, not a paragraph here.

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
- `rollOpen(uint256 optionId, uint112 contracts)` — propose and execute the weekly write
- `approveListing(OrderComponents)` — propose a listing, at most 3 per cycle
- `cancelListing(OrderComponents)` — kill the live listing
- `invalidateAllListings()` — bump the Seaport counter
- `lockBook()` — also permissionless after `exerciseTimestamp`
- `rollClose()` — from `expiryTimestamp` (anyone else from `+1 hour`)

### Cannot
- **Hold the option ERC-1155 or the claim NFT.** The vault is the Seaport offerer and the Valorem
  writer; inventory never passes through the keeper's wallet. This is the single most important
  property of the design and it is why the vault, not the keeper, signs listings.
- List the inventory to itself, or for a dollar, or past the exercise window. `approveListing` checks
  **every field** of the proposed order against vault state before authorising it:
  `consideration[0].recipient` must be the vault, `consideration[1].recipient` must be Overcall's fee
  EOA, both tokens must be USDG, the offer must be the exact `optionId` the vault wrote, the amount
  must not exceed inventory, `startAmount == endAmount` (no Dutch auction), `endTime` must not outlive
  `exerciseTimestamp`, the counter must match, and the fee split must reproduce
  `Policy.splitPremium` exactly.
- Write outside the OTM band, below the premium floor, or above the utilization/contract caps.
- Halt, unhalt, or change any parameter.
- Move a token. It has no path to one.

### Compromise response
A stolen keeper key costs gas and, at worst, an in-policy position written at a bad moment. Revoke and
rotate from the Admin Safe — the commands are in `ops/runbooks/incident.md` §4. Do not panic-move
inventory; there is none to move.

### Hygiene
- Gas float ~0.05 ETH; alert below 0.02; refill every Saturday as part of `close-week.md`.
- Never holds NVDA, USDG, or shares. If it ever does, something is wrong.
- State lives in SQLite on the keeper host, but the keeper must be able to re-derive everything from
  chain on restart. Never restore it from a stale database and let it act.
- Runs from a stable IP. Overcall's POST limiter is per-IP as well as per-writer.

---

## 3. Guardian — 1 of 1, separate hardware, different continent

An emergency brake that is deliberately weak. Its whole value is that it can be used without a quorum
at 03:00 local, so it is given only powers that are safe to hand one person.

### Can
- `haltWrites()` — blocks `rollOpen` and `approveListing`. Nothing else.
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

This matters more than what it does block. `writesHalted` is read in exactly two places, `rollOpen` and
`approveListing`. All of the following keep working through a halt:

- `queueRedeem` — a depositor can always get in the queue
- `completeRedeem` — a settled redemption always pays out
- `claimUsdg` / `claimUsdgTo` — earned premium is always claimable
- `redeem` / `withdraw` — instant exits, while the vault is flat
- `rollClose` — settlement can never be held hostage
- `deposit` / `mint` — not blocked by the halt flag (they are gated by phase and cap, not by halt)

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
Re-run against `Vault.sol` at commit `27d502a` on 2026-09-12 — **the line numbers move whenever
the contract is edited, so match on the function names, not on the numbers**:

```
 47:    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
748:        if (!hasRole(KEEPER_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {   <- cancelListing
758:        if (!hasRole(KEEPER_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {   <- invalidateAllListings
759:            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
997:        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {  <- haltWrites
998:            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
```

Resolve each hit to its enclosing function rather than trusting the annotations above:

```bash
# POSIX awk: [ \t]* rather than \s, so this works with macOS awk as well as gawk
awk 'BEGIN{f="?"} /^[ \t]*function [A-Za-z_]/{match($0,/function [A-Za-z_][A-Za-z0-9_]*/); f=substr($0,RSTART+9,RLENGTH-9)} /GUARDIAN_ROLE/{print NR": "f}' src/Vault.sol
# 47: ?   (the constant itself)   748: cancelListing   758/759: invalidateAllListings   997/998: haltWrites
```

So the guardian's entire reachable surface is `cancelListing`, `invalidateAllListings`, `haltWrites`.
(If this grep ever returns a fourth function, this document is out of date and the claim is unverified.)

### Step 2 — enumerate every place the vault moves a token

```bash
grep -rnE "safeTransfer|safeTransferFrom\(|forceApprove|setApprovalForAll|\.transfer\(|IERC20\.transfer|\.call\(|\.call\{" \
  src/Vault.sol src/Distributor.sol src/AdapterValorem.sol src/AdapterSeaport.sol src/lib/SeaportOrderLib.sol src/lib/ValoremLib.sol
```

The pattern deliberately includes `IERC20.transfer` and `.call(`/`.call{`: since the best-effort
fee change (`contracts/SECURITY.md` §4, defect 12) the fee leg is a **raw call**, not a
`safeTransfer`, and the older five-alternative pattern misses it entirely. Expect exactly **twelve hits: eleven
transfer/approve sites plus one comment line** (`ValoremLib.sol:81`, which merely mentions
`forceApprove`). With the old pattern you get eleven and silently lose the fee leg. Re-run against
`27d502a` on 2026-09-12. Again: match the enclosing function, not the line number.

| Site | Enclosing function | Reachable by |
|---|---|---|
| `Vault.sol:443` `asset.safeTransferFrom(msg.sender, …)` | `deposit` | anyone — pulls IN |
| `Vault.sol:462` `asset.safeTransferFrom(msg.sender, …)` | `mint` | anyone — pulls IN |
| `Vault.sol:516` `asset.safeTransfer(receiver, assets)` | `redeem` | anyone, burns **their own** shares |
| `Vault.sol:531` `asset.safeTransfer(receiver, assets)` | `withdraw` | anyone, burns **their own** shares |
| `Vault.sol:646/649` `asset` / `usdg` `.safeTransfer(receiver, …)` | `_payoutOwed`, reached from `completeRedeem` → `_completeRedeem(msg.sender, receiver)` | pays only `owedAssets[msg.sender]` / `owedQueueUsdg[msg.sender]`, i.e. the caller's own settled queue entry |
| `Vault.sol:982` `address(usdg).call(abi.encodeCall(IERC20.transfer, (feeRecipient, fee)))` | `_tryPayFee`, reached from `_harvest` (only from `rollClose`) and from the permissionless `sweepFee()` | best-effort, clamped to balance; always the admin-set `feeRecipient`, never `msg.sender`; failure leaves `pendingFeeUsdg` untouched |
| `Distributor.sol:190` `usdg.safeTransfer(to, amount)` | `_claimUsdg` | pays the caller's own accrued balance, which is a function of their share balance |
| `ValoremLib.sol:85/88` `asset.forceApprove(address(clear), …)` | `writeCalls` (a `public` library reached by DELEGATECALL from `AdapterValorem._writeCalls`, only from `rollOpen`) | KEEPER only; approval is set and reset to 0 in the same call |
| `AdapterSeaport.sol:240` `setApprovalForAll(transferApprovalTarget, true)` | `_approveOptionTransfers` | **constructor only** |

`ValoremLib.sol:81` is the comment hit. There is no other `.call(`, `.call{`, `delegatecall`-by-hand
or `IERC20.transfer` in these six files; `SeaportOrderLib.sol` contributes no hit at all (it moves
no token: `validate`, `cancel` and `getOrderHash` only).

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
step 2. The only intersection is the `_tryPayFee` raw call (`Vault.sol:982`) — and it is indirect:
admin sets `feeRecipient`, and `rollClose` (via `_harvest`) or anyone (via `sweepFee()`) later sends
the accrued `pendingFeeUsdg` there. Admin never calls a transfer itself, and the fee is capped at 20%
of harvested premium, with strike proceeds excluded. That is the complete extent of admin's reach into the token flow. Note that
this is exactly the site the old grep pattern did not match; if you run step 2 with a pattern that
lacks `IERC20.transfer` / `\.call\(`, step 4 will wrongly conclude that admin has no reach at all.

---

## 5. The caps governance cannot move

Compiled into `Policy` and into `Vault`. These are the bytecode, not the configuration.

| Cap | Value | Stops |
|---|---|---|
| `Policy.MIN_OTM_FLOOR_BPS` | 100 (1%) | An admin selling at-the-money calls |
| `Policy.MAX_OTM_CEIL_BPS` | 2500 (25%) | A band so wide it earns nothing |
| `Policy.MIN_PREMIUM_FLOOR_BPS` | 10 (0.10%) | Listing for dust |
| `Policy.MAX_UTILIZATION_CEIL_BPS` | 10000 (100%) | Writing more than the vault holds |
| `Policy.PROTOCOL_FEE_CEIL_BPS` | 2000 (20% of premium) | A fee that eats the product. Strike proceeds are never in the fee base at any setting |
| `Policy.MAX_LISTINGS_PER_CYCLE` | 3 | A keeper ratcheting the price down all week |
| `Vault.MIN_PRICE_AGE` | 1 hour | Disabling the staleness check by setting it absurdly tight |
| `Vault.MAX_PRICE_AGE_CEIL` | 7 days | Turning the staleness check off by setting it absurdly wide |

Launch policy: `minOtmBps 300, maxOtmBps 1200, minPremiumBps 40, maxUtilizationBps 9500,
protocolFeeBps 500, maxContractsCap 50`; `maxPriceAge` 4 days; deposit cap 20 NVDA.

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

```bash
# 1. Admin is the Safe, and the deployer is not an admin
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x0000000000000000000000000000000000000000000000000000000000000000 $SAFE_ADMIN --rpc-url $RH_RPC   # true
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x0000000000000000000000000000000000000000000000000000000000000000 <deployer>  --rpc-url $RH_RPC   # false

# 2. Keeper and guardian are exactly who they should be, and are not each other
cast call $VAULT "hasRole(bytes32,address)(bool)" 0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab $KEEPER   --rpc-url $RH_RPC
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041 $GUARDIAN --rpc-url $RH_RPC

# 3. The keeper does NOT hold guardian or admin, and the guardian does NOT hold keeper or admin
cast call $VAULT "hasRole(bytes32,address)(bool)" 0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041 $KEEPER   --rpc-url $RH_RPC   # false
cast call $VAULT "hasRole(bytes32,address)(bool)" 0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab $GUARDIAN --rpc-url $RH_RPC   # false

# 4. Registry, asset and fee wiring
cast call $VAULT "registry()(address)"      --rpc-url $RH_RPC   # 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA
cast call $VAULT "asset()(address)"         --rpc-url $RH_RPC   # 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
cast call $VAULT "priceFeed()(address)"     --rpc-url $RH_RPC   # 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
cast call $VAULT "overcallFeeRecipient()(address)" --rpc-url $RH_RPC  # 0xdAe7e82A2E7D566C67E87C164B05a1C560190782
cast call $VAULT "feeRecipient()(address)"  --rpc-url $RH_RPC   # the fee Safe
cast call $VAULT "conduitKey()(bytes32)"    --rpc-url $RH_RPC   # 0x00..00
cast call $VAULT "seaportZone()(address)"   --rpc-url $RH_RPC   # 0x00..00

# 5. Seaport can actually move the inventory
cast call $CLEAR "isApprovedForAll(address,address)(bool)" $VAULT $SEAPORT --rpc-url $RH_RPC   # true

# 6. The guardian claim, re-verified against the deployed source (§4)
```

Then, and only then, the deployer renounces `DEFAULT_ADMIN_ROLE` — **after** confirming the Safe holds
it, and never from the only account that holds it.

Record every address in `ops/addresses.json` under `chains.4663.ours`, replacing the nulls.
