# R4 — Valorem Clear ABI + semantics on Robinhood Chain (4663)

**Target:** `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0`
**Status:** RESOLVED. Contract identified with byte-level certainty. ABI saved to `ops/abis/ValoremClear.json`.
**Date:** 2026-09-12. RPC: `https://rpc.mainnet.chain.robinhood.com`. Chain head at time of recon: 61,305,753.

---

## 0. Verdict

The deployed contract is **`ValoremOptionsClearinghouse`** from
`github.com/valorem-labs-inc/valorem-core` at commit **`6436c823f560af493af119d6148fb3237037aca4`**
(branch HEAD, "remove seed from fuzz", 2023-11-13), compiled with **solc 0.8.16, optimizer ON, runs = 200, via_ir = false**.

**Zero divergence from upstream.** All 26 external selectors match, and the runtime bytecode is byte-identical
outside the 53-byte CBOR metadata trailer. The plan's guesses in §1 were correct: `write(uint256,uint112)`,
`redeem(uint256)`, `option(uint256)`, `claim(uint256)`, `feesEnabled()` all exist with exactly those signatures.

No 4663 explorer serves verified source (see §9 UNRESOLVED), so identification was done by **bytecode reproduction**,
which is strictly stronger evidence than an explorer's "verified" badge.

---

## 1. Bytecode identity proof

```
$ curl -s -X POST -H 'content-type: application/json' \
   -d '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0","latest"],"id":1}' \
   https://rpc.mainnet.chain.robinhood.com
hexlen 32222 bytes 16110
```

Cloned upstream, initialised submodules (`solmate@3a752b8c`, `forge-std@cd7d533f`), swept optimizer settings:

```
runs=200    via_ir=false -> 16110 bytes      <-- EXACT MATCH
runs=200    via_ir=true  -> 12254 bytes
runs=999999 via_ir=false -> 21454 bytes
runs=1      via_ir=false -> 15988 bytes
runs=100    via_ir=false -> 15978 bytes
runs=1000   via_ir=false -> 16958 bytes
runs=10000  via_ir=false -> 19492 bytes
TARGET = 16110 bytes
```

Byte comparison at `runs=200, via_ir=false`:

```
local 16110 onchain 16110
FULL IDENTICAL: False
metadata-stripped len: 16057 16057
CODE IDENTICAL (metadata excluded): True

local   metadata: a264697066735822122060f3f112aa79ba5f01cc65aaef9a8691a39a1794e0d57d9447a3ed3ebeb7daa264736f6c63430008100033
onchain metadata: a26469706673582212205d10911b2ae74a73aa8960244c42de8ee8ad0da01d62b7cfed654cca34f6352564736f6c63430008100033
```

All **16,057 bytes of executable code are identical**. Only the IPFS source hash inside the CBOR trailer differs
(expected — metadata hashes the source file *paths*, which differ between Valorem's build tree and mine).
Both trailers end `64736f6c6343 000810 0033` = **solc 0.8.16**, confirming the same compiler.

The companion **`TokenURIGenerator` at `0xe53ccb924d27f421a91b59087587fd866c5d64c7`** (9,901 bytes on chain)
reproduces identically too:

```
TokenURIGenerator FULL identical: False
code (metadata stripped) identical: True   len 9848
```

---

## 2. Complete ABI — all 26 external functions

Extracted from the deployed dispatcher, not assumed. Note solc encodes selectors with leading zero bytes as
short pushes (`balanceOf` appears as `DUP1 PUSH3 fdd58e`), which is why a naive `8063` regex misses it.

| selector | signature | returns | mutability |
|---|---|---|---|
| `0x00fdd58e` | `balanceOf(address,uint256)` | `uint256` | view |
| `0x017e7e58` | `feeTo()` | `address` | view |
| `0x01ffc9a7` | `supportsInterface(bytes4)` | `bool` | view |
| `0x04e618ce` | `setTokenURIGenerator(address)` | `-` | nonpayable |
| `0x0e89341c` | `uri(uint256)` | `string` | view |
| `0x24a9d853` | `feeBps()` | `uint8` | view |
| `0x2eb2c2d6` | `safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)` | `-` | nonpayable |
| `0x379607f5` | `claim(uint256)` | `(uint256,uint256,uint256)` | view |
| `0x4e1273f4` | `balanceOfBatch(address[],uint256[])` | `uint256[]` | view |
| `0x6448be8c` | `option(uint256)` | `(address,uint96,address,uint96,uint40,uint40,uint160,uint96)` | view |
| `0x888fbf43` | `write(uint256,uint112)` | `uint256` | nonpayable |
| `0xa143c66f` | `tokenURIGenerator()` | `address` | view |
| `0xa22cb465` | `setApprovalForAll(address,bool)` | `-` | nonpayable |
| `0xa64e4f8a` | `feesEnabled()` | `bool` | view |
| `0xa901dd92` | `setFeesEnabled(bool)` | `-` | nonpayable |
| `0xaa9ffa93` | `newOptionType(address,uint96,address,uint96,uint40,uint40)` | `uint256` | nonpayable |
| `0xd6d859e9` | `sweepFees(address[])` | `-` | nonpayable |
| `0xdb006a75` | `redeem(uint256)` | `-` | nonpayable |
| `0xe1f3962c` | `feeBalance(address)` | `uint256` | view |
| `0xe6c3b1f6` | `tokenType(uint256)` | `uint8` | view |
| `0xe985e9c5` | `isApprovedForAll(address,address)` | `bool` | view |
| `0xf1f5d0c3` | `acceptFeeTo()` | `-` | nonpayable |
| `0xf242432a` | `safeTransferFrom(address,address,uint256,uint256,bytes)` | `-` | nonpayable |
| `0xf46901ed` | `setFeeTo(address)` | `-` | nonpayable |
| `0xf55e49b2` | `exercise(uint256,uint112)` | `-` | nonpayable |
| `0xf7a95a9e` | `position(uint256)` | `(address,int256,address,int256)` | view |

**Selector reconciliation: 26 deployed, 26 named, 0 unresolved, 0 missing.**

```
deployed: 26 candidates: 26
UNRESOLVED (in bytecode, not named): NONE
MISSING   (in upstream ABI, not deployed): NONE
EXACT MATCH
```

Note the plan's §1 guess of a `reclaim` alias is wrong — **the function is `redeem(uint256)`, there is no `reclaim`.**
There is also **no `burn`, no `pause`, no `owner`, and no upgrade/proxy surface.** The contract is immutable.

### Error selectors (for decoding reverts in the keeper)

| selector | error |
|---|---|
| `0x0cfe98f7` | `AccessControlViolation(address,address)` |
| `0xb06c3d55` | `AmountWrittenCannotBeZero()` |
| `0x31836dc6` | `CallerDoesNotOwnClaimId(uint256)` |
| `0xa0e229ab` | `CallerHoldsInsufficientOptions(uint256,uint112)` |
| `0x1887f3a7` | `ClaimTooSoon(uint256,uint40)` |
| `0x571ed184` | `ExerciseTooEarly(uint256,uint40)` |
| `0xdef3b576` | `ExerciseWindowTooShort(uint40)` |
| `0x93774327` | `ExpiredOption(uint256,uint40)` |
| `0x60d0c430` | `ExpiryWindowTooShort(uint40)` |
| `0x8e4c8aa6` | `InvalidAddress(address)` |
| `0x10048e8a` | `InvalidAssets(address,address)` |
| `0x630f5574` | `InvalidClaim(uint256)` |
| `0x24eb6489` | `InvalidOption(uint256)` |
| `0x9c383c50` | `OptionsTypeExists(uint256)` |
| `0x6caeb130` | `TokenNotFound(uint256)` |

### Event topics (for Ponder)

| event | indexed |
|---|---|
| `NewOptionType(uint256,address,address,uint96,uint96,uint40,uint40)` | `exerciseAsset`, `underlyingAsset`, `expiryTimestamp` — **`optionId` is NOT indexed, it is data word 0** |
| `OptionsWritten(uint256,address,uint256,uint112)` | `optionId`, `writer`, `claimId`; `amount` in data |
| `BucketWrittenInto(uint256,uint256,uint96,uint112)` | `optionId`, `claimId`, `bucketIndex` |
| `OptionsExercised(uint256,address,uint112)` | `optionId`, `exerciser` |
| `ClaimRedeemed(uint256,uint256,address,uint256,uint256)` | `claimId`, `optionId`, `redeemer`; `exerciseAmountRedeemed`, `underlyingAmountRedeemed` in data |
| `FeeSwitchUpdated(address,bool)` | *(nothing indexed)* |

> **Indexer trap:** `NewOptionType` indexes the *expiry timestamp*, not the optionId. You cannot filter
> `NewOptionType` by optionId via topics. Decode data word 0.

---

## 3. Structs as actually returned by the deployed contract

### `option(uint256)` → 8 words

```
    [0] underlyingAsset   address
    [1] underlyingAmount  uint96
    [2] exerciseAsset     address
    [3] exerciseAmount    uint96
    [4] exerciseTimestamp uint40
    [5] expiryTimestamp   uint40
    [6] settlementSeed    uint160
    [7] nextClaimKey      uint96
```

Live, against the real NVDA $246 option:

```
  option() words=8
    [0] underlyingAsset   0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec   (NVDA, 18 dec)
    [1] underlyingAmount  1000000000000000000                          (1 NVDA)
    [2] exerciseAsset     0x5fc5360d0400a0fd4f2af552add042d716f1d168   (USDG, 6 dec)
    [3] exerciseAmount    246000000                                    ($246.00)
    [4] exerciseTimestamp 1789761600  2026-09-18 20:00:00 UTC
    [5] expiryTimestamp   1789848000  2026-09-19 20:00:00 UTC
    [6] settlementSeed    717994639431561361691208322842912178045255065172 (0x7dc3fe3e…9e54)
    [7] nextClaimKey      2
```

This confirms the plan's stated conventions exactly: **lot size = 1e18 per contract**, **USDG 6 decimals**,
**`exerciseAmount = S * 1e6`**.

### `claim(uint256)` → 3 words

```
    [0] amountWritten    uint256   (1e18-scaled option count)
    [1] amountExercised  uint256   (1e18-scaled option count)
    [2] optionId         uint256
```

Live, against a real claim:

```
  claim() words=3
    [0] amountWritten   1000000000000000000 = 1.0 options
    [1] amountExercised 0 = 0.0 options
    [2] optionId        56885395977254369119998982131173877604217583767740146085872832926902011297792
```

> **`amountWritten` / `amountExercised` are WAD-scaled, not raw counts.** 1 option contract reads as `1e18`.
> Assignment ratio for the vault = `amountExercised / amountWritten`. Do not compare against `uint112 amount`
> passed to `write()`, which is a raw count.

### `position(uint256)` → `(address underlyingAsset, int256 underlyingAmount, address exerciseAsset, int256 exerciseAmount)`

Signed. Live results:

```
  option id -> underlying 0xd060…9eec amt +1000000000000000000 | exercise 0x5fc5…d168 amt -246000000
  claim  id -> underlying 0xd060…9eec amt +1000000000000000000 | exercise 0x5fc5…d168 amt 0
```

### `tokenType(uint256)` → `uint8` enum: `0 = None, 1 = Option, 2 = Claim`

---

## 4. Token ID encoding — confirmed empirically, and the NatSpec is WRONG

```solidity
uint8  private constant OPTION_KEY_PADDING = 96;
uint96 private constant CLAIM_KEY_MASK = 0xFFFFFFFFFFFFFFFFFFFFFFFF;

tokenId = (uint256(optionKey) << 96) | uint256(claimKey);
optionKey = uint160(tokenId >> 96);
claimKey  = uint96(tokenId & CLAIM_KEY_MASK);
```

- **Upper 160 bits = optionKey**, **lower 96 bits = claimKey**. Exactly as the assignment hypothesised.
- `claimKey == 0` ⟺ the id is an **optionId**. `claimKey >= 1` ⟺ **claimId**.
- Claim keys start at **1** and increment per write (`nextClaimKey` initialised to 1).
  So the first claim on an option is literally `optionId + 1`.

Confirmed from live `OptionsWritten` logs:

```
  optionId 56885395977254369119998982131173877604217583767740146085872832926902011297792
  claimId  56885395977254369119998982131173877604217583767740146085872832926902011297793
  upper160 equal? True  optionId.lower96=0  claimId.lower96(claimKey)=1
  claimId - optionId = 1
```

### optionKey derivation — the interface NatSpec is wrong, do not use it

`IValoremOptionsClearinghouse.sol` documents the preimage as **8 fields** (with trailing `uint160(0), uint96(0)`).
The **implementation hashes only 6 fields**:

```solidity
uint160 optionKey = uint160(bytes20(keccak256(abi.encode(
    underlyingAsset, underlyingAmount, exerciseAsset, exerciseAmount, exerciseTimestamp, expiryTimestamp
))));
optionId = uint256(optionKey) << 96;
```

Tested both against the live NVDA $246 option:

```
6-field (implementation):
  keccak    0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54f9fa62e96367db452ed15b79
  optionKey 0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54   MATCH=True
8-field (interface NatSpec):
  keccak    0xc723edc1efe01e717744af3dc77bf3e0ec9d664efeb6c6379c92b5e8a1de8130
  optionKey 0xc723edc1efe01e717744af3dc77bf3e0ec9d664e   MATCH=False
```

Note also `bytes20(hash)` takes the **most-significant 20 bytes**, not the low 20 (i.e. not the `address(uint160(uint256(h)))` idiom).

Cross-checked against all five live NVDA strikes:

```
  strike $226: derived 0xf9e23d199282d4611ff78a93abe9f31de2d43398  OK
  strike $231: derived 0x418ec5b78ab6c828d23ac4e50f484b1a5aeede6c  OK
  strike $236: derived 0x1edae6ecfc36b8d725f077beee6b957adf180dbf  OK
  strike $241: derived 0x11b72829420ee3bd0b8591c69e90504118dc11c9  OK
  strike $246: derived 0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54  OK
ALL 5 DERIVE CORRECTLY: True
```

**The keeper can precompute optionIds offline and does not need to read the Overcall registry to find them** —
it only needs the six parameters.

---

## 5. Live call results

```
feesEnabled()          -> 0x…0000  = false
feeBps()               -> 0x…000f  = 15   (0.15%, and it is a `constant` — NOT settable)
feeTo()                -> 0xdAe7e82A2E7D566C67E87C164B05a1C560190782
tokenURIGenerator()    -> 0xe53ccb924d27f421a91b59087587fd866c5d64c7  (9901 bytes)
feeBalance(USDG)       -> 0
feeBalance(NVDA)       -> 0
```

**`feeTo` is the same EOA the orchestrator flagged as the "Overcall fee switch key"
(`0xdAe7e82A2E7D566C67E87C164B05a1C560190782`, no bytecode).** That EOA is the only address that can call
`setFeesEnabled`, `setFeeTo`, `sweepFees`, `setTokenURIGenerator` (`onlyFeeTo` modifier).

`feeBps = 15` is **not** a divergence — upstream HEAD is `uint8 public constant feeBps = 15;`
(`src/ValoremOptionsClearinghouse.sol:104`). It is a compile-time constant with no setter; only the
on/off boolean is mutable.

### supportsInterface

```
0x01ffc9a7 (ERC165)             -> true
0xd9b67a26 (ERC1155)            -> true
0x0e89341c (ERC1155MetadataURI) -> true
0x2a55205a (ERC2981)            -> false
0xffffffff (sanity, must fail)  -> false
```

**Yes, it is a genuine ERC-1155.** Both the option fungible token and the claim NFT are ids in the *same* 1155.
There is no separate ERC-721.

---

## 6. `write()` semantics — confirmed

`write(uint256 tokenId, uint112 amount) returns (uint256 claimId)`.

**Two modes, dispatched on `claimKey`:**

- `write(optionId, n)` (claimKey == 0) → creates a **new** claim. `_batchMint` mints **both**
  `n` option tokens *and* `1` claim NFT. Returns the new claimId.
- `write(claimId, n)` (claimKey != 0) → adds to an **existing** claim the caller must already own
  (`balanceOf[msg.sender][claimId] == 1`, else `CallerDoesNotOwnClaimId`). `_mint` mints **only**
  `n` more option tokens — no second claim NFT. Returns the same claimId.

So yes: **`write()` returns a claim id and the fresh-write path mints both the option 1155 and the claim NFT**,
in a single `TransferBatch`. Confirmed on chain — the 2 `OptionsWritten` events in the scanned window are each
accompanied by a `TransferBatch`.

Reverts if `expiryTimestamp == 0` (`InvalidOption`), if `expiry <= block.timestamp` (`ExpiredOption`),
or if `amount == 0` (`AmountWrittenCannotBeZero`).

### Two build-critical consequences

**(a) The vault MUST implement `ERC1155TokenReceiver` — both hooks.**
solmate's `_batchMint` and `_mint` both enforce the receiver check when `to.code.length != 0`:

```solidity
require(
    to.code.length == 0 ? to != address(0)
      : ERC1155TokenReceiver(to).onERC1155BatchReceived(...) == ERC1155TokenReceiver.onERC1155BatchReceived.selector,
    "UNSAFE_RECIPIENT"
);
```

A fresh write hits `onERC1155BatchReceived`; a top-up write hits `onERC1155Received`. **Implement both or
`write()` reverts with `"UNSAFE_RECIPIENT"`.**

**(b) Approve `rxAmount + fee`, not `rxAmount`.**
`write()` pulls `underlyingAmount * amount + fee` in one `safeTransferFrom`:

```solidity
fee = (assetAmount * feeBps) / 10_000;
if (fee == 0) { fee = 1; }
```

Fees are **currently off**, so today `fee == 0` and `rxAmount` alone suffices. But `feeTo` can flip
`setFeesEnabled(true)` at any time with no timelock, after which every `write()` needs an extra 0.15%
(`amount * 1e18 * 15 / 10000`). If the vault approves exactly `rxAmount`, **the weekly roll breaks the moment
the switch flips.** Either read `feesEnabled()` at roll time and size the approval accordingly, or approve
`rxAmount * 10015 / 10000`. Note the `if (fee == 0) fee = 1` floor also means a fee of at least 1 wei whenever
the switch is on.

---

## 7. THE KEY QUESTION — unsold option 1155 at redeem time

### Answer: NO. `redeem()` does not require leftover option tokens to be burned. The vault does not need to do anything with them.

`redeem(uint256 claimId)` in full (`src/ValoremOptionsClearinghouse.sol`). Its complete precondition set is:

```solidity
(uint160 optionKey, uint96 claimKey) = _decodeTokenId(claimId);
if (claimKey == 0) revert InvalidClaim(claimId);                       // must be a claim, not an option
uint256 balance = balanceOf[msg.sender][claimId];
if (balance != 1) revert CallerDoesNotOwnClaimId(claimId);             // must own the claim NFT
if (optionRecord.expiryTimestamp > block.timestamp)
    revert ClaimTooSoon(claimId, optionRecord.expiryTimestamp);        // must be at/after expiry
```

That is the entire gate. **`redeem()` never reads `balanceOf[msg.sender][optionId]`.** Payout is computed purely
from the claim's stored bucket accounting (`optionTypeState.claimIndices[claimKey]`), which records how much was
written and how much of that was assigned. It then burns *only the claim NFT*:

```solidity
_burn(msg.sender, claimId, 1);
if (totalExerciseAssetAmount > 0) safeTransfer(exerciseAsset, msg.sender, totalExerciseAssetAmount);
if (totalUnderlyingAssetAmount > 0) safeTransfer(underlyingAsset, msg.sender, totalUnderlyingAssetAmount);
```

So collateral for *unexercised* options returns automatically as `underlyingAsset`, regardless of who is holding
the corresponding option tokens.

**The vault must NOT burn leftovers before closing the claim — and in fact it cannot.** There is no public
`burn` in the ABI (`_burn` is internal, reachable only via `redeem` for the claim NFT and `exercise` for options),
and solmate's transfer refuses `address(0)`:

```solidity
require(to.code.length == 0 ? to != address(0) : …, "UNSAFE_RECIPIENT");
```

Leftover (unsold) option tokens therefore stay in the vault's 1155 balance permanently as dust. After expiry they
are inert — `exercise()` reverts with `ExpiredOption` once `expiryTimestamp <= block.timestamp`, so nobody can
ever use them.

**Implication for `rollClose`:** call `clear.redeem(claimId)` directly. Do not gate it on the option balance, do
not try to burn or sweep the leftovers, and make sure vault accounting values the residual option 1155 at **zero**
rather than deriving anything from `balanceOf(vault, optionId)` (which stays non-zero forever after an unfilled or
partially-filled week). If cosmetic cleanliness matters for the UI, transfer them to a burn address with code-free
non-zero bytes (e.g. `0x…dEaD`) — but that is optional and costs gas for no economic effect.

---

## 8. Live Overcall option surface on 4663 (bonus — feeds R1/R2)

Scanned `eth_getLogs` over blocks 59,305,753 → 61,305,753 (59 logs). Zero logs exist below block 59,305,753
across `[0 … 0x3800000]` and `[0x3800000 … 59,305,753]`; **earliest log from this contract is block 60,254,094
(2026-09-11 12:57:34 UTC)** — the clearinghouse is only ~1 day old in usage terms.

50 `NewOptionType` events = **10 underlying stock tokens × 5 strikes**, every one settling in **USDG**, every one
expiring **Saturday 2026-09-19 20:00:00 UTC**, every one with `underlyingAmount = 1e18`:

| symbol | underlying address | strikes (USDG) |
|---|---|---|
| NVDA | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | 226, 231, 236, 241, 246 |
| TSLA | `0x322f0929c4625ed5bad873c95208d54e1c003b2d` | 373, 380, 388, 396, 404 |
| AAPL | `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9` | 336, 343, 350, 357, 364 |
| AMZN | `0x12f190a9f9d7d37a250758b26824b97ce941bf54` | 261, 266, 271, 276, 282 |
| SPY | `0x117cc2133c37b721f49de2a7a74833232b3b4c0c` | 784, 800, 816, 832, 849 |
| SPCX | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` | 154, 157, 160, 163, 166 |
| AI | `0x2e8c31162b855a2ffa90f6f8634643ad6f111e18` | 0.313, 0.319, 0.325, 0.332, 0.339 |
| PONS | `0x39dbed3a2bd333467115de45665cc57f813c4571` | 0.645, 0.658, 0.671, 0.684, 0.698 |
| CASHCAT | `0x020bfc650a365f8bb26819deaabf3e21291018b4` | 0.172, 0.175, 0.179, 0.183, 0.187 |
| JUGGERNAUT | `0xd7321801caae694090694ff55a9323139f043b88` | 0.01014, 0.01034, 0.01055, 0.01076, 0.01098 |

Live NVDA optionIds (all `exerciseTimestamp` 1789761600 / `expiryTimestamp` 1789848000):

```
  strike $226.00  optionId 0xf9e23d199282d4611ff78a93abe9f31de2d43398000000000000000000000000
  strike $231.00  optionId 0x418ec5b78ab6c828d23ac4e50f484b1a5aeede6c000000000000000000000000
  strike $236.00  optionId 0x1edae6ecfc36b8d725f077beee6b957adf180dbf000000000000000000000000
  strike $241.00  optionId 0x11b72829420ee3bd0b8591c69e90504118dc11c9000000000000000000000000
  strike $246.00  optionId 0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
```

**The exercise window is exactly 24 hours**: `exerciseTimestamp = expiryTimestamp - 86400`
(Fri 20:00 UTC → Sat 20:00 UTC). The plan's phase machine should treat `Exercisable` as that 24h band, and
`rollClose`/`redeem` as legal only from Sat 20:00:00 UTC **inclusive**.

Token decimals confirmed by direct call: **USDG = 6** (`symbol() = "USDG"`), **NVDA = 18** (`symbol() = "NVDA"`).

`newOptionType` is **permissionless** — anyone can create an option type. Its only checks are:
expiry ≥ now + 1 min, expiry ≥ exerciseTimestamp + 1 min, `exerciseAsset != underlyingAsset`, both assets have
`totalSupply() >= amount`, and the type must not already exist (`OptionsTypeExists`). The vault could mint its own
option types if Overcall's strike ladder ever doesn't suit, though v1 should use Overcall's.

---

## 9. Gotchas the adapter must respect

1. **`option(uint256)` is not a validity check.** It only validates the upper-160 optionKey and ignores the
   claimKey entirely. Passing a claimId — or a completely fabricated claimKey — returns the *option type's*
   struct without reverting. Verified live: `option(optionId + 9999)` returned the full valid struct while
   `tokenType()` correctly returned `0 (None)` and `claim()` reverted `TokenNotFound`.
   **Use `tokenType()` to validate an id, never `option()`.**
2. **`claim()` and `position()` do revert** on an uninitialised id, with `TokenNotFound(uint256)` = `0x6caeb130`.
3. `amountWritten` / `amountExercised` are **WAD-scaled**; `write()`'s `amount` is a **raw count**. Don't mix.
4. `write()` takes **`uint112`**, not `uint256`. Cast deliberately.
5. `redeem()` is callable by **anyone holding the claim NFT** — the claim NFT is transferable, so whoever holds it
   at expiry gets the collateral. The vault must never let the claim NFT leave.
6. **No timelock on `setFeesEnabled`.** See §6(b).
7. `exercise()` requires `exerciseTimestamp <= block.timestamp < expiryTimestamp`; `redeem()` requires
   `block.timestamp >= expiryTimestamp`. The two windows abut exactly — no dead zone, no overlap.
8. `settlementSeed` is initialised to `optionKey` and mutates as exercises are assigned. Assignment across
   writers is pseudorandom/fair per bucket — **the vault can be partially assigned**, so `rollClose` must handle
   `0 < amountExercised < amountWritten` and expect *both* USDG and NVDA back from a single `redeem()`.

---

## 10. Artifacts produced

- `<callhouse>/ops/abis/ValoremClear.json` — full ABI,
  57 entries (26 functions, 15 events, 15 errors, 1 constructor), extracted from the reproduced build.
- Upstream source for reference: clone `github.com/valorem-labs-inc/valorem-core` @ `6436c823f560af493af119d6148fb3237037aca4`,
  `forge build` with optimizer runs=200, via_ir=false, solc 0.8.16.

---

## 11. UNRESOLVED

1. **No verified source on any 4663 explorer.** Everything I tried:
   - `robinhoodchain.blockscout.com` — `/api/v2/smart-contracts/{addr}` and `/api?module=contract&action=getsourcecode`
     both return **HTTP 403** behind a Cloudflare managed challenge ("Just a moment…", `cRay` interstitial),
     with and without full browser headers. WebFetch also could not get past it.
   - `robinscan.io/api?module=contract&action=getabi` → `{"error":"not found"}`
   - `hoodscan.co/api?…` → `{"code":"FORBIDDEN"}`; its documented `Accept: text/markdown` interface returns only a
     stub page for this address with no contract tab. It is a market-data explorer, not a source-verification one.
   - `stonkscan.io/api?…` → returns the Next.js HTML shell, no API.
   **Mitigated, not blocking**: bytecode reproduction (§1) is stronger evidence than a verification badge.
   Someone should still submit the source to Blockscout so the explorer shows it publicly.
2. **Exact deployment block / deploy tx / constructor args not pinned.** Both public RPCs are pruned, not archive:
   `rpc.mainnet.chain.robinhood.com` → `{'code': -32000, 'message': 'metadata is not found, 60940493'}` for
   historical `eth_getCode`; `robinhood-rpc.publicnode.com` → `Archive requests require a personal token`.
   A naive `eth_getCode` binary search returns block 61,305,519, which is the **state-pruning boundary, not the
   deployment** — do not trust that number. Bounded via logs instead: first event from this address is block
   **60,254,094** (2026-09-11 12:57:34 UTC), and there are zero logs anywhere below it. Constructor args are
   nonetheless known from live calls: `_feeTo = 0xdAe7e82A2E7D566C67E87C164B05a1C560190782`,
   `_tokenURIGenerator = 0xe53ccb924d27f421a91b59087587fd866c5d64c7`.
3. **Testnet 46630 deployment not checked** — out of scope for R4, belongs to R7.
4. **Whether Valorem Labs themselves deployed this, or Overcall redeployed the audited code.** The bytecode is
   Valorem's, but the `feeTo` EOA is Overcall's fee-switch key, which suggests Overcall deployed it. Not confirmed
   either way; it does not affect the integration.
5. **Zellic audit report not retrieved.** The code matches upstream HEAD (commit `6436c823`, Nov 2023) but I did not
   verify that that specific commit is the audited revision, nor pull the report. Worth doing before mainnet.

---

# Verification pass

**Auditor:** independent adversarial re-check (R4-valorem-abi).
**Date:** 2026-09-12. Chain head at verification: 61,320,460. RPCs used: `https://rpc.mainnet.chain.robinhood.com`
(primary) and `https://robinhood-rpc.publicnode.com` (cross-check).
**Verdict: CONFIRMED.** Every material claim above was independently reproduced from scratch — fresh clone, fresh
compile, fresh selector extraction, fresh live calls. Three non-material corrections and two resolutions below.

## V0. What I re-ran, and what it showed

### V0.1 Chain and code presence — every claimed address `eth_getCode`'d

```
$ curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    https://rpc.mainnet.chain.robinhood.com
{"jsonrpc":"2.0","id":1,"result":"0x1237"}        # 4663 ✓

ValoremClear         0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0  bytes=16110   ✓
TokenURIGenerator    0xe53ccb924d27f421a91b59087587fd866c5d64c7  bytes=9901    ✓
feeTo                0xdAe7e82A2E7D566C67E87C164B05a1C560190782  bytes=0       ✓ EOA
USDG                 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  bytes=170     ✓
NVDA                 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC  bytes=283     ✓
TSLA                 0x322f0929c4625ed5bad873c95208d54e1c003b2d  bytes=283     ✓
AAPL                 0xaf3d76f1834a1d425780943c99ea8a608f8a93f9  bytes=283     ✓
AMZN                 0x12f190a9f9d7d37a250758b26824b97ce941bf54  bytes=283     ✓
SPY                  0x117cc2133c37b721f49de2a7a74833232b3b4c0c  bytes=283     ✓
```

Token metadata re-read live (guards against a symbol being asserted rather than read):

```
USDG  decimals=6   symbol='USDG'      NVDA  decimals=18  symbol='NVDA'
TSLA  decimals=18  symbol='TSLA'      AAPL  decimals=18  symbol='AAPL'
AMZN  decimals=18  symbol='AMZN'      SPY   decimals=18  symbol='SPY'
```

**No fabricated addresses. No address with missing code. No mainnet-Ethereum/4663 confusion** — every read above
was against chainId `0x1237`.

### V0.2 Selector extraction — redone with my own disassembler

I did not reuse their regex. I wrote a full linear EVM decode (correctly skipping PUSH*n* immediates) and collected
every `PUSHn`-immediately-followed-by-`EQ` constant in the dispatcher:

```
len 16110
EQ-compared 4-byte-ish constants: 26
26 unique
0x00fdd58e 0x017e7e58 0x01ffc9a7 0x04e618ce 0x0e89341c 0x24a9d853 0x2eb2c2d6 0x379607f5
0x4e1273f4 0x6448be8c 0x888fbf43 0xa143c66f 0xa22cb465 0xa64e4f8a 0xa901dd92 0xaa9ffa93
0xd6d859e9 0xdb006a75 0xe1f3962c 0xe6c3b1f6 0xe985e9c5 0xf1f5d0c3 0xf242432a 0xf46901ed
0xf55e49b2 0xf7a95a9e
```

Identical to their §2 table, exactly 26, no more no less. Then I recomputed all 26 selectors from the claimed
signature strings with `cast sig` — **26/26 match**, including the three they called out as easy to get wrong:

```
write(uint256,uint112)                                       0x888fbf43   ✓
redeem(uint256)                                              0xdb006a75   ✓
exercise(uint256,uint112)                                    0xf55e49b2   ✓
newOptionType(address,uint96,address,uint96,uint40,uint40)   0xaa9ffa93   ✓
option(uint256)                                              0x6448be8c   ✓
claim(uint256)                                               0x379607f5   ✓
tokenType(uint256)                                           0xe6c3b1f6   ✓
feesEnabled()                                                0xa64e4f8a   ✓
feeBps()                                                     0x24a9d853   ✓
feeTo()                                                      0x017e7e58   ✓
feeBalance(address)                                          0xe1f3962c   ✓
setFeesEnabled(bool)                                         0xa901dd92   ✓
position(uint256)                                            0xf7a95a9e   ✓
```

Negative control — the functions they claim do **not** exist. Their selectors are absent from the extracted set,
and calling them on chain reverts with empty returndata (there is no fallback in this contract):

```
reclaim(uint256)  0x2dabbeed  -> {'code': 3, 'message': 'execution reverted', 'data': '0x'}
owner()           0x8da5cb5b  -> {'code': 3, 'message': 'execution reverted', 'data': '0x'}
pause()           0x8456cb59  -> {'code': 3, 'message': 'execution reverted', 'data': '0x'}
burn(uint256,uint256) 0xb390c0ab -> not in dispatcher
```

**"There is no `reclaim`" is correct.** The plan's §1 "redeem / reclaim — bind to ABI" resolves to `redeem(uint256)`.

### V0.3 Bytecode identity — independently rebuilt from a fresh clone

This is the load-bearing claim, since every semantic statement in §3–§9 is derived from upstream source rather
than from an explorer badge. I did not trust their build. Fresh clone:

```
$ git clone https://github.com/valorem-labs-inc/valorem-core.git vc && git log -1 --format='%H %ci %s'
6436c823f560af493af119d6148fb3237037aca4 2023-11-13 01:33:59 -0500 remove seed from fuzz

$ git submodule status
 cd7d533f9a0ee0ec02ad81e0a8f262bc4203c653 lib/forge-std (v1.1.1-11-gcd7d533)
 3a752b8c83427ed1ea1df23f092ea7a810205b6c lib/solmate (v6-181-g3a752b8)
```

Commit hash, date, message and both submodule pins match their §1 exactly. Note `foundry.toml` in the repo pins
**neither** solc version nor optimizer settings — so `0.8.16 / optimizer on / runs=200 / via_ir=false` is a
*discovered* setting, not something read off the repo. I re-derived it and reproduced their sweep:

```
$ forge build --use 0.8.16 --optimize --optimizer-runs <R> --skip test --skip script
runs=1    -> 15988 bytes     (their table: 15988 ✓)
runs=100  -> 15978 bytes     (their table: 15978 ✓)
runs=1000 -> 16958 bytes     (their table: 16958 ✓)
runs=200  -> 16110 bytes     <-- TARGET
```

(The non-monotonicity at runs=1 vs runs=100 is a genuine optimizer artifact, reproduced independently — their
sweep table was really run, not invented.)

Byte comparison at runs=200:

```
local bytes 16110 onchain bytes 16110
FULL IDENTICAL: False
metadata-stripped len: 16057 16057
CODE IDENTICAL (metadata excluded): True
first differing byte offset 16067 of 16110
local   metadata: a264697066735822122060f3f112aa79ba5f01cc65aaef9a8691a39a1794e0d57d9447a3ed3ebeb7daa264736f6c6343000810
onchain metadata: a26469706673582212205d10911b2ae74a73aa8960244c42de8ee8ad0da01d62b7cfed654cca34f6352564736f6c6343000810
```

TokenURIGenerator:

```
local 9901 onchain 9901 FULL identical: False
code (metadata stripped) identical: True  len 9848 9848
```

**Reproduced.** All 16,057 executable bytes identical; the only difference is the IPFS hash in the CBOR trailer.
Both trailers carry `64736f6c6343 000810` = solc 0.8.16. Note my *local* metadata IPFS hash
(`60f3f112aa79ba…`) came out **byte-identical to theirs**, from a clone I made myself — an extra, unplanned
corroboration that we compiled the same sources with the same settings.

**Conclusion: the identity claim is sound. The contract at `0x9a7b…C0C0` on 4663 IS upstream
`ValoremOptionsClearinghouse` @ `6436c823`, and reading upstream source is a legitimate way to answer semantics
questions about it.**

### V0.4 The saved ABI file is not hand-written

I diffed `ops/abis/ValoremClear.json` against the `abi` output of *my own* compile, normalising each entry to a
canonical `type name(argtypes)` string with nested tuples expanded:

```
mine entries 57 theirs entries 57
counts by type mine:   {'constructor': 1, 'error': 15, 'event': 15, 'function': 26}
counts by type theirs: {'constructor': 1, 'error': 15, 'event': 15, 'function': 26}

In THEIRS but NOT in real compiled ABI (fabricated?):   (none)
In real ABI but MISSING from theirs:                    (none)
IDENTICAL SET: True
```

**The shipped ABI is the real compiler output. Nothing invented, nothing dropped.** Safe for the keeper and the
adapter to bind against.

### V0.5 Live state calls, re-run

```
feesEnabled()       -> 0x00…00                                        false  ✓
feeBps()            -> 0x00…0f                                        15     ✓
feeTo()             -> 0x…dae7e82a2e7d566c67e87c164b05a1c560190782            ✓
tokenURIGenerator() -> 0x…e53ccb924d27f421a91b59087587fd866c5d64c7            ✓
feeBalance(USDG)    -> 0                                                     ✓
feeBalance(NVDA)    -> 0                                                     ✓
supportsInterface 0x01ffc9a7 ERC165      -> true    ✓
supportsInterface 0xd9b67a26 ERC1155     -> true    ✓
supportsInterface 0x0e89341c MetadataURI -> true    ✓
supportsInterface 0x2a55205a ERC2981     -> false   ✓
supportsInterface 0xffffffff             -> false   ✓
```

`feeBps = 15` is confirmed as a compile-time constant with no setter — source line 104:
`uint8 public constant feeBps = 15;`. Their "not a divergence" reading is right. Only the boolean is mutable, and
only by `feeTo`. Confirmed the `onlyFeeTo` surface is exactly four functions:

```
137: modifier onlyFeeTo()
630: function setFeesEnabled(bool enabled) external onlyFeeTo
637: function setFeeTo(address newFeeTo) external onlyFeeTo
657: function setTokenURIGenerator(address newTokenURIGenerator) external onlyFeeTo
667: function sweepFees(address[] calldata tokens) external onlyFeeTo
```

### V0.6 THE HEADLINE ANSWER — re-read line by line, CONFIRMED

`redeem()` at src/ValoremOptionsClearinghouse.sol:505-566. I grepped the entire function body for `balanceOf`:

```
$ awk 'NR>=505 && NR<=566' src/ValoremOptionsClearinghouse.sol | grep -n "balanceOf"
10:        uint256 balance = balanceOf[msg.sender][claimId];
```

**Exactly one `balanceOf` read in the whole function, and it is the claim NFT.** The option balance is never
touched. Preconditions are precisely the three they listed (lines 509, 515, 524), and the only `_burn` is
`_burn(msg.sender, claimId, 1)` at line 557. Payout comes from `claimIndices[claimKey]` bucket accounting via
`_getAssetAmountsForClaimIndex`, which reads only bucket/claim-index storage — no balances.

**So: `rollClose` calls `clear.redeem(claimId)` unconditionally. Do not gate on option balance. Value residual
option 1155 at zero.** Their §7 stands in full.

Corroborating the "cannot burn leftovers anyway" half:

```
$ grep -n "function burn\|_burn(" src/ValoremOptionsClearinghouse.sol lib/solmate/src/tokens/ERC1155.sol
src/ValoremOptionsClearinghouse.sol:557:        _burn(msg.sender, claimId, 1);     # redeem, claim NFT only
src/ValoremOptionsClearinghouse.sol:616:        _burn(msg.sender, optionId, amount);  # exercise only
lib/solmate/src/tokens/ERC1155.sol:224:    function _burn(                        # internal
```

and solmate `safeTransferFrom` lines 69-75 do refuse `address(0)`:

```solidity
require(
    to.code.length == 0 ? to != address(0)
        : ERC1155TokenReceiver(to).onERC1155Received(...) == ...selector,
    "UNSAFE_RECIPIENT"
);
```

The same guard appears at `_mint` (line 165) and `_batchMint` (line 196), so **§6(a) — the vault MUST implement
both `onERC1155Received` and `onERC1155BatchReceived` — is confirmed at the library level.**

### V0.7 Token-id encoding and the wrong NatSpec — reproduced from scratch

I recomputed both preimages myself with `cast keccak` over hand-assembled `abi.encode` words, taking the **top**
20 bytes (`bytes20`), and checked each derived id against live `option()` / `tokenType()`:

```
$226 6-field: optionKey=0xf9e23d199282d4611ff78a93abe9f31de2d43398 tokenType=1 eamt=226000000 REAL=True
$231 6-field: optionKey=0x418ec5b78ab6c828d23ac4e50f484b1a5aeede6c tokenType=1 eamt=231000000 REAL=True
$236 6-field: optionKey=0x1edae6ecfc36b8d725f077beee6b957adf180dbf tokenType=1 eamt=236000000 REAL=True
$241 6-field: optionKey=0x11b72829420ee3bd0b8591c69e90504118dc11c9 tokenType=1 eamt=241000000 REAL=True
$246 6-field: optionKey=0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54 tokenType=1 eamt=246000000 REAL=True
$226..$246 8-field: no result (option() reverts — optionKey uninitialised)
```

Their exact counterexample value reproduces too:

```
6-field optionKey  0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54  (they claimed same) True
8-field optionKey  0xc723edc1efe01e717744af3dc77bf3e0ec9d664e  (they claimed same) True
```

And the NatSpec really is wrong — `src/interfaces/IValoremOptionsClearinghouse.sol:435-452` documents the preimage
with trailing `uint160(0), uint96(0)`, while `newOptionType` hashes six fields. (The NatSpec also calls the shift
constant `OPTION_ID_PADDING`; the implementation constant is `OPTION_KEY_PADDING`.)

**The keeper can precompute optionIds offline from six parameters. Use the implementation's six-field form.**

`settlementSeed` is initialised to `optionKey` itself (`settlementSeed: optionKey` in `newOptionType`) — confirmed
live, `option()[6] == optionKey` for all five NVDA strikes.

### V0.8 Live logs — their §8 numbers reproduce exactly

Correction to the orchestrator's tooling note: **an address-filtered `eth_getLogs` over the full `[0, head]` range
does work on `rpc.mainnet.chain.robinhood.com`** (it is only unfiltered wide scans that fail). That let me confirm
completeness rather than sample:

```
head 61320460
WIDE RANGE OK, NewOptionType count = 50
first block 60254094  last block 60943752

TOTAL logs from contract (all topics): 59   earliest block: 60254094
topic0 histogram: {NewOptionType:50, OptionsWritten:2, BucketWrittenInto:2,
                   TransferBatch:2, ApprovalForAll:2, TransferSingle:1}
```

Decoded, all 50:

```
distinct expiryTimestamp: {1789848000: 50}      -> Sat 2026-09-19 20:00:00 UTC   ✓ single expiry
distinct exerciseAsset:   {USDG: 50}                                             ✓
distinct underlyingAmount:{1000000000000000000}                                  ✓ lot = 1e18
exerciseTs == expiry-86400 for all: True                                         ✓ 24h window

10 underlying tickers x 5 strikes:
   AAPL        [336, 343, 350, 357, 364]
   AI          [0.313, 0.319, 0.325, 0.332, 0.339]
   AMZN        [261, 266, 271, 276, 282]
   CASHCAT     [0.172, 0.175, 0.179, 0.183, 0.187]
   JUGGERNAUT  [0.01014, 0.01034, 0.01055, 0.01076, 0.01098]
   NVDA        [226, 231, 236, 241, 246]
   PONS        [0.645, 0.658, 0.671, 0.684, 0.698]
   SPCX        [154, 157, 160, 163, 166]
   SPY         [784, 800, 816, 832, 849]
   TSLA        [373, 380, 388, 396, 404]
```

Every NVDA optionId from the logs equals the one I derived offline from the six-field preimage — the derivation is
validated end-to-end against event data, not just against `option()`:

```
$226 -> 113025628429828481228850936737953628080486640605422851339090182744894714413056
$231 -> 29652592033419692000166847561911668028189801263392568326594311383797020491776
$236 -> 13956151908388063551378518883460877979717043668997816139085862263440384458752
$241 -> 8012928620938394388054169085135774622795258770514699139381494411582911807488
$246 -> 56885395977254369119998982131173877604217583767740146085872832926902011297792
```

Exercise/expiry window, re-derived:

```
1789761600  Fri 2026-09-18 20:00:00 UTC     (exerciseTimestamp)
1789848000  Sat 2026-09-19 20:00:00 UTC     (expiryTimestamp)
delta 86400 seconds = 24.0 h
```

`exercise()` requires `expiry > now` and `exerciseTs <= now`; `redeem()` requires `now >= expiry`. **Windows abut
exactly — confirmed from source lines 587 and 592 vs 524.**

### V0.9 claimId = optionId + 1, from two independent live writes

Both `OptionsWritten` events on chain:

```
blk 60302146  OptionsWritten
  optionId = 56885395977254369119998982131173877604217583767740146085872832926902011297792
  claimId  = 56885395977254369119998982131173877604217583767740146085872832926902011297793
  writer=0xe73d7021a3ef2808c3dd8237982fcc5fa11275be amount=1
  claimId-optionId=1  upper160 equal=True  optionId.low96=0  claimId.low96=1

blk 60910684  OptionsWritten
  optionId = 873393324505681306211742772675693943830305973181304956549530887026947129344
  claimId  = 873393324505681306211742772675693943830305973181304956549530887026947129345
  writer=0x789a7490718cf944d6f2ca411ed53cdefd56306a amount=21
  claimId-optionId=1  upper160 equal=True  optionId.low96=0  claimId.low96=1
```

Each is paired with a `TransferBatch` in the same block — `_batchMint` of {option, claim NFT} confirmed on chain.

**Important scaling cross-check (their §3 warning, now proven both directions):** the `amount` field in
`OptionsWritten` is **raw** (`1` and `0x15`=21), while `claim()` returns WAD:

```
claim(optionId+1) -> amountWritten=1000000000000000000  amountExercised=0  optionId=<matches>  ✓
```

and the source is explicit — `amountWritten: amountWritten * 1e18` with the comment "Scale the amount written by
WAD for consistency", and `amountExercised` accumulated via `FixedPointMathLib.divWadDown`. **Confirmed: divide
`claim().amountWritten` by 1e18 to get contracts; never pass it to `write()`/`exercise()`, which take raw
`uint112`.** This is the single easiest place for the vault to be off by 1e18.

### V0.10 §9 adapter gotchas — confirmed live

```
--- optionId          : option() OK, tokenType()=1 (Option),  claim() reverts 0x6caeb130 TokenNotFound
--- optionId+1        : option() OK, tokenType()=2 (Claim),   claim() OK
--- optionId+2        : option() OK, tokenType()=0 (None),    claim() reverts 0x6caeb130 TokenNotFound
--- optionId+9999     : option() OK, tokenType()=0 (None),    claim() reverts 0x6caeb130 TokenNotFound
```

**Confirmed: `option()` returns a full valid struct for a nonexistent claimKey. It is not a validity check. Use
`tokenType()`.** `TokenNotFound(uint256)` = `0x6caeb130` verified by `cast sig`.

All 15 error selectors recomputed; the three they cite in the summary are right:

```
TokenNotFound(uint256)                       0x6caeb130   ✓
ClaimTooSoon(uint256,uint40)                 0x1887f3a7   ✓
CallerDoesNotOwnClaimId(uint256)             0x31836dc6   ✓
InvalidClaim(uint256)                        0x630f5574
InvalidOption(uint256)                       0x24eb6489
ExpiredOption(uint256,uint40)                0x93774327
ExerciseTooEarly(uint256,uint40)             0x571ed184
CallerHoldsInsufficientOptions(uint256,uint112) 0xa0e229ab
AmountWrittenCannotBeZero()                  0xb06c3d55
OptionsTypeExists(uint256)                   0x9c383c50
AccessControlViolation(address,address)      0x0cfe98f7
ExpiryWindowTooShort(uint40)                 0x60d0c430
ExerciseWindowTooShort(uint40)               0xdef3b576
InvalidAssets(address,address)               0x10048e8a
InvalidAddress(address)                      (15th, in ABI)
```

Event indexing re-read from the compiled ABI (not from the .sol comment):

```
NewOptionType(uint256,address,address,uint96,uint96,uint40,uint40)  indexed=[exerciseAsset, underlyingAsset, expiryTimestamp]
OptionsWritten(uint256,address,uint256,uint112)                     indexed=[optionId, writer, claimId]
BucketWrittenInto(uint256,uint256,uint96,uint112)                   indexed=[optionId, claimId, bucketIndex]
OptionsExercised(uint256,address,uint112)                           indexed=[optionId, exerciser]
ClaimRedeemed(uint256,uint256,address,uint256,uint256)              indexed=[claimId, optionId, redeemer]
BucketAssignedExercise(uint256,uint96,uint112)                      indexed=[optionId, bucketIndex]
FeeAccrued(uint256,address,address,uint256)                         indexed=[optionId, asset, payer]
FeeSwept(address,address,uint256)                                   indexed=[asset, feeTo]
FeeSwitchUpdated(address,bool)                                      indexed=[]
FeeToUpdated(address)                                               indexed=[newFeeTo]
TokenURIGeneratorUpdated(address)                                   indexed=[newTokenURIGenerator]
URI(string,uint256)                                                 indexed=[id]
+ ERC1155 TransferSingle / TransferBatch / ApprovalForAll
```

**Indexer trap confirmed: `optionId` is NOT indexed on `NewOptionType` (it is data word 0). You cannot
topic-filter it.** Note it IS indexed on `OptionsWritten`, `BucketWrittenInto`, `OptionsExercised` and
`ClaimRedeemed` — so Ponder should discover types by scanning `NewOptionType` data, then filter everything else
by topic.

Also verified live and not previously recorded: `position()` sign convention.

```
position(optionId) -> underlyingAmount=+1000000000000000000  exerciseAmount=-246000000
position(claimId)  -> underlyingAmount=+1000000000000000000  exerciseAmount=0
uri(optionId)      -> 3117-byte "data:application/json;base64,eyJuYW1lIjoiTlZEQVVTREcyNjA5MTl…"
```

(`uri()` resolving proves the `TokenURIGenerator` wiring works, independent of the bytecode match.)

---

## V1. CORRECTIONS

### C1. Wrong wall-clock timestamp for block 60,254,094 (minor, but it is quoted twice)

§8 and UNRESOLVED#2 both state block 60,254,094 = **"2026-09-11 12:57:34 UTC"**. It is not. Verified on two
independent RPCs:

```
$ eth_getBlockByNumber 0x397678e   (rpc.mainnet.chain.robinhood.com)
60254094 1789129390 2026-09-11 12:23:10 UTC
$ eth_getBlockByNumber 0x397678e   (robinhood-rpc.publicnode.com)
publicnode: 60254094 1789129390 2026-09-11 12:23:10 UTC
```

**Block 60,254,094 → unix 1789129390 → 2026-09-11 12:23:10 UTC.** The block *number* is right and the conclusion
("usage is ~1 day old") is unaffected; only the printed time is wrong by ~34 minutes. Fix before anyone anchors a
cycle boundary on it.

### C2. §8 is incomplete — a real Seaport fill already happened, and their writeup misses it

§6 says "each `OptionsWritten` in the scanned window is paired with a `TransferBatch`", which is true, but the
report never mentions the **59th log**: a `TransferSingle` at block **61,153,997** that is an executed Seaport 1.6
sale of a live NVDA $246 call. This is the highest-value single artifact on this contract and it was passed over.

```
fill tx: 0x013cd30b541372fa7f505dfb743a563f39e284b7d2805dbcb964b6a754ae720b  block 61153997
  from 0x8684c0b2e23d0c699a1ff4437e8d92258bc82905
  to   0x0000000000000068f116a894984e2db1123eb395   (Seaport 1.6)
  status 0x1, 4 logs:
    0x9a7b40e5…C0C0  TransferSingle   operator=Seaport  from=writer  to=buyer
                     id = 0x7dc3fe3e…e9e54 << 96  (NVDA $246 optionId, low96 = 0)  amount = 1
    0x5fc5360d…d168  USDG Transfer  buyer -> 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be  3800000  = 3.8 USDG
    0x5fc5360d…d168  USDG Transfer  buyer -> 0xdAe7e82A2E7D566C67E87C164B05a1C560190782   200000  = 0.2 USDG
    0x000000…eB395  Seaport OrderFulfilled, offerer=0xe73d7021…75be, zone=0x0
  gasUsed 190389
```

Three things fall out of this that matter to the build and are **not** in the report:

1. **Premium 4.0 USDG total, split 3.8 / 0.2 = exactly 95% / 5%.** This is the first live confirmation of the
   plan's architecture diagram ("USDG 95% → vault, 5% → Overcall fee recipient"). The 5% is real, and it is
   charged as a second Seaport consideration item, not taken by Valorem.
2. **The Overcall marketplace fee recipient is the same address as Valorem `feeTo`** —
   `0xdAe7e82A2E7D566C67E87C164B05a1C560190782`. One key sits on both the Valorem fee switch and the Overcall
   listing fee. That is a single point of trust the risk table should name.
3. **The writer approved Seaport 1.6 *directly*, not via a conduit** — feeds R2/R9:

```
isApprovedForAll(0xe73d7021…75be, 0x0000000000000068F116a894984e2DB1123eB395) -> true
ApprovalForAll logs: 2, both with operator = 0x…68f116a894984e2db1123eb395 (Seaport 1.6)
OrderFulfilled zone (topic[2]) = 0x0000…0000  (zero zone)
```

So the vault's `setApprovalForAll` target is Seaport itself and `conduitKey` is very likely
`bytes32(0)`. **R9 should confirm this rather than assume a conduit.** (Flagging, not concluding — R2/R9's call.)

4. Post-fill balances confirm the §7 model in the *fully-sold* case:

```
writer option bal: 0   writer claim bal: 1
buyer  option bal: 1   buyer  claim bal: 0
```

The writer kept the claim NFT and is the only party who can `redeem()` after Saturday 20:00 UTC.

### C3. The orchestrator's "never `eth_getLogs` across 61M blocks" note is too strict (not the reporter's error)

An **address-filtered** `eth_getLogs` with `fromBlock: 0x0, toBlock: head` returns fine on
`rpc.mainnet.chain.robinhood.com` for this contract. Worth knowing: it converts "I sampled a window" into
"I enumerated everything", which is what let me state the 50 / 59 counts as complete rather than as a lower bound.

---

## V2. THINGS THEY MARKED UNRESOLVED THAT I RESOLVED

### R-a. UNRESOLVED#6 — "Overcall creates option types from a registry contract or an EOA?" → **EOA. RESOLVED.**

I pulled `eth_getTransactionByHash` for the tx behind each of the 50 `NewOptionType` logs and bucketed `tx.from`:

```
SENDERS of newOptionType txs:
   0x408adcffebdf48ec23f1e3811a91aed3cc951cc0  count=50  codeBytes=0
```

**All 50 option types were created by one EOA, `0x408adcffebdf48ec23f1e3811a91aed3cc951cc0`** (`eth_getCode` → 0
bytes, nonce 73, balance 0.0139 ETH). There is no registry contract in the creation path — the ladder is minted by
an off-chain script signing with a hot key. Hand to R1: this address is Overcall's **option-type minting key**, and
it is a *different* key from the fee recipient.

### R-b. UNRESOLVED#4 — "did Valorem Labs or Overcall deploy this?" → still open, but **narrowed**.

New evidence: `feeTo` = `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` has **nonce 0** — it has never sent a
transaction on 4663. So it did **not** deploy the clearinghouse itself; it is a pure receiving/cold key that would
have to be used to exercise the fee switch. Combined with C2 (the same address collects Overcall's 5% Seaport
listing fee), the deployment was near-certainly arranged by Overcall with a Valorem-derived constructor arg, not
by Valorem Labs. **Still circumstantial — leave as unresolved-but-narrowed. It does not affect the integration,
but it does mean the fee switch is controlled by Overcall, not Valorem.**

Operational consequence for the plan's "Valorem fee switch" risk row: the key that can call `setFeesEnabled(true)`
is the same key already taking 5% of every premium. Their §6(b) advice stands — read `feesEnabled()` at roll time
rather than trusting it stays false.

### R-c. UNRESOLVED#2 — deployment block: **still unresolved, and their warning is correct and worth keeping.**

I re-tested the pruning boundary and it has *moved* since their run, which independently proves their point that a
binary search on `eth_getCode` finds the prune boundary and not the deployment:

```
block          0: ERR {'code': -32000, 'message': 'metadata is not found, 3'}
block   60254093: ERR {'code': -32000, 'message': 'metadata is not found, 60254096'}
block   61305519: ERR {'code': -32000, 'message': 'metadata is not found, 61305522'}   <- they got "deploy block" here
block   61320000: code 16110 bytes
```

Their number 61,305,519 no longer returns code; 61,320,000 does. **It is a rolling window. Do not record any
`eth_getCode` binary-search result as the deployment block.** Explorer re-check, all still failing:

```
robinhoodchain.blockscout.com /api/v2/smart-contracts/{a}      HTTP 403 Cloudflare "Just a moment..."
robinhoodchain.blockscout.com /api?module=contract&action=getabi HTTP 403 Cloudflare
robinhoodchain.blockscout.com /api/v2/addresses/{a}            HTTP 403 Cloudflare
robinscan.io /api/v2/addresses/{a}                             HTTP 404 {"error":"not found"}
robinscan.io /api?module=contract&action=getsourcecode          HTTP 404 {"error":"not found"}
hoodscan.co  /api/v2/addresses/{a}                             HTTP 301
stonkscan.io /api/v2/addresses/{a}                             HTTP 404 Next.js shell
```

**UNRESOLVED#1 and #2 both stand exactly as written** (modulo the C1 timestamp). Deployment is bounded above by
block 60,254,094; an archive node or a de-Cloudflared Blockscout is required to pin it.

---

## V3. Net assessment

| Claim | Status |
|---|---|
| Contract = upstream `ValoremOptionsClearinghouse` @ `6436c823` | **CONFIRMED** — independently recompiled, 16,057/16,110 bytes identical |
| 26 selectors, 0 unresolved / 0 missing | **CONFIRMED** — own disassembler, own `cast sig` |
| `ops/abis/ValoremClear.json` is genuine | **CONFIRMED** — set-identical to my compiler output, 57/57 |
| `redeem(uint256)`, no `reclaim` | **CONFIRMED** — `0xdb006a75` present; `0x2dabbeed` absent + reverts |
| optionKey = 6-field keccak, NatSpec's 8-field is wrong | **CONFIRMED** — 5/5 live strikes derive correctly |
| claimId = optionId + 1; `(optionKey<<96)\|claimKey` | **CONFIRMED** — 2/2 live `OptionsWritten` |
| `claim()` is WAD-scaled, `write()` is raw | **CONFIRMED** — source line + live log contrast |
| feesEnabled=false, feeBps=15 constant, feeTo EOA | **CONFIRMED** |
| **redeem() does NOT require leftover options to be burned** | **CONFIRMED** — one `balanceOf` in the function, on the claim NFT |
| Vault must implement both ERC1155 receiver hooks | **CONFIRMED** — solmate `_mint` L165, `_batchMint` L196 |
| Approve `rxAmount + fee`, fee floor 1 | **CONFIRMED** — `_calculateRecordAndEmitFee` |
| 24h exercise window, windows abut | **CONFIRMED** — 86400s exactly, 50/50 events |
| 50 NewOptionType, 10 tickers × 5 strikes, first block 60,254,094 | **CONFIRMED** (timestamp corrected, see C1) |
| `option()` is not a validity check | **CONFIRMED** live |
| `NewOptionType.optionId` not indexed | **CONFIRMED** from compiled ABI |
| Block 60,254,094 = 12:57:34 UTC | **WRONG → 12:23:10 UTC** (C1) |
| §8 covers the live Overcall surface | **INCOMPLETE** — missed an executed Seaport fill (C2) |
| Option types minted by registry or EOA? | **RESOLVED → EOA `0x408adcff…1cc0`** (R-a) |
| Who deployed? | Still open, **narrowed to Overcall** (R-b) |
| Deployment block | Still **UNRESOLVED**, warning validated (R-c) |

**No fabricated address, selector, endpoint or field name was found anywhere in this report.** The build can bind
to §2's ABI and implement §7's `rollClose` as written.

### Still UNRESOLVED after this pass

1. Exact deployment block / deploy tx hash (needs archive RPC or Blockscout past Cloudflare).
2. Whether Valorem Labs or Overcall deployed — narrowed to Overcall, not proven.
3. Zellic audit report still not retrieved; `6436c823` not shown to be the audited revision.
4. Testnet 46630 Valorem deployment — R7.
5. Whether `conduitKey` is `bytes32(0)`. My C2 evidence (direct `setApprovalForAll` to Seaport, zero zone)
   strongly suggests yes, but the order's `conduitKey` field itself was not decoded here — **R2/R9 must confirm**.
