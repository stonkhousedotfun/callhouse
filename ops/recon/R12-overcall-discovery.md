# R12 — Overcall on-chain discovery (Robinhood Chain 4663)

Agent: `R12-overcall-discovery`
Read on: **2026-09-12**, chain head `0x3a78102` = **61,308,162**
RPC used: `https://rpc.mainnet.chain.robinhood.com` (mainnet 4663), `https://rpc.testnet.chain.robinhood.com/rpc` (testnet 46630)

**Bottom line: Overcall is found, fully. Its entire on-chain surface is one contract type — `OvercallRegistry`, deployed once per market (11 live on mainnet) — plus an unmodified Valorem Clear and its TokenURIGenerator. There is no zone, no conduit, no periphery, no fee contract, and no proxy. R1, R2, R3, R4, R7, R8, R9 are answered below with primary evidence.**

---

## 0. How Overcall was located

Not via the explorer (Blockscout `/api` is behind a Cloudflare JS challenge — Overcall's own docs say so). The address book came out of the **Next.js client bundle** at `overcall.finance`, then every address was re-derived from chain state.

```
curl -sSL https://overcall.finance/ -o index.html            # 200, 66,498 B
# 27 JS chunks pulled from index.html + /write /buy /positions /docs /risk /terms
grep -ohE '0x[0-9a-fA-F]{40}' chunks/*.js | sort | uniq -c | sort -rn
```

The address book lives in `chunks/13i994ge4sv4e.js`, keyed by chain id, exported as `addresses`:

```js
registries:{AAPL:"0xB500929deb0100598D9A1392113a6F6D2A31C018",AI:"0xD1d56916f6E945F59C6E226A7429Da688532a113",
AMZN:"0x195dcf905Ad9fDda76E492016E680B2D0F9F0877",CASHCAT:"0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1",
GME:"0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335",JUGGERNAUT:"0x65dD407955912Be814f723724cE60f91ebd72616",
NVDA:"0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA",PONS:"0x365B4D099768F6B2fF07200e7d5AA14D899c1897",
SPCX:"0x915148f98C0450251261654ffb6B54BA7005efFF",SPY:"0x6369CeCe2de602Ce1911039C123dc97E816715A9",
TSLA:"0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1"},
registry:"0x65dD407955912Be814f723724cE60f91ebd72616",
registryOwner:"0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0",
tokenURIGenerator:"0xE53cCB924d27f421a91b59087587fD866C5d64c7",
feeTo:"0xdAe7e82A2E7D566C67E87C164B05a1C560190782",
clearinghouse:"0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
```

The address book was then **independently confirmed** by the official docs page `https://overcall.finance/docs/protocol/contracts` and by Sourcify + `eth_getCode` + `eth_call` on every entry.

> Note: `registry:` (the singleton fallback) points at the **JUGGERNAUT** registry, not NVDA. Do not use it. Always resolve per market from `registries[SYMBOL]`, or from `NEXT_PUBLIC_REGISTRY_ADDRESS`. The frontend prefers `registries[sym]` and falls back to `registry` only if that lookup misses.

---

## 1. The Overcall contract set — mainnet 4663 (R1, R8)

Every row below returned the stated byte count from a real `eth_getCode` in this session.

### Deployed by Overcall

| Contract | Address | runtime bytes | Sourcify |
|---|---|---|---|
| `ValoremOptionsClearinghouse` (Valorem Clear, unmodified) | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` | 16110 | `exact_match` 2026-09-10T13:24:56Z |
| `TokenURIGenerator` | `0xE53cCB924d27f421a91b59087587fD866C5d64c7` | 9901 | `exact_match` 2026-09-10T13:24:30Z |
| `OvercallRegistry` — **NVDA** | `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA` | 5905 | `exact_match` 2026-09-10T13:24:55Z |
| `OvercallRegistry` — TSLA | `0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1` | 5905 | (docs say verified) |
| `OvercallRegistry` — GME | `0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335` | 5905 | (docs say verified) |
| `OvercallRegistry` — SPCX | `0x915148f98C0450251261654ffb6B54BA7005efFF` | 5905 | (docs say verified) |
| `OvercallRegistry` — SPY | `0x6369CeCe2de602Ce1911039C123dc97E816715A9` | 5905 | (docs say verified) |
| `OvercallRegistry` — AAPL | `0xB500929deb0100598D9A1392113a6F6D2A31C018` | 5905 | (docs say verified) |
| `OvercallRegistry` — AMZN | `0x195dcf905Ad9fDda76E492016E680B2D0F9F0877` | 5905 | (docs say verified) |
| `OvercallRegistry` — CASHCAT | `0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1` | 5905 | **not on Sourcify** (see §1.1) |
| `OvercallRegistry` — PONS | `0x365B4D099768F6B2fF07200e7d5AA14D899c1897` | 5905 | **not on Sourcify** |
| `OvercallRegistry` — AI | `0xD1d56916f6E945F59C6E226A7429Da688532a113` | 5905 | **not on Sourcify** |
| `OvercallRegistry` — JUGGERNAUT | `0x65dD407955912Be814f723724cE60f91ebd72616` | 5905 | **not on Sourcify** |

Raw:
```
registry_NVDA            0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA bytes=5905
registry_TSLA            0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1 bytes=5905
registry_GME             0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335 bytes=5905
registry_SPCX            0x915148f98C0450251261654ffb6B54BA7005efFF bytes=5905
registry_SPY             0x6369CeCe2de602Ce1911039C123dc97E816715A9 bytes=5905
registry_AAPL            0xB500929deb0100598D9A1392113a6F6D2A31C018 bytes=5905
registry_AMZN            0x195dcf905Ad9fDda76E492016E680B2D0F9F0877 bytes=5905
registry_CASHCAT         0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1 bytes=5905
registry_PONS            0x365B4D099768F6B2fF07200e7d5AA14D899c1897 bytes=5905
registry_AI              0xD1d56916f6E945F59C6E226A7429Da688532a113 bytes=5905
registry_JUGGERNAUT      0x65dD407955912Be814f723724cE60f91ebd72616 bytes=5905
registryOwner            0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0 bytes=0      <- EOA
tokenURIGenerator        0xE53cCB924d27f421a91b59087587fD866C5d64c7 bytes=9901
feeTo                    0xdAe7e82A2E7D566C67E87C164B05a1C560190782 bytes=0      <- EOA
```

**The official docs page lists only 7 mainnet registries** (NVDA/TSLA/GME/SPCX/SPY/AAPL/AMZN) and says "all nine deployed contracts are verified on Sourcify" (9 = clearinghouse + URI generator + 7 registries). The 4 pool-priced markets (CASHCAT, PONS, AI, JUGGERNAUT) are **live on chain but newer than the docs page** (docs read their addresses on 2026-09-08; these 4 are live as of today). They are unverified on Sourcify but provably the same code — see next.

### 1.1 Proof the 4 unverified registries are the same contract

All 11 registries are 5905 bytes. Their runtime hashes differ **only because `collateralToken` is an `immutable` baked into the code**. Byte-diffing NVDA vs JUGGERNAUT:

```
len NVDA=5905 len JUGG=5905 differing bytes=60 in 3 runs
  offset 1012-1031 (20B)  NVDA=d0601ce157db5bdc3162bbac2a2c8af5320d9eec  JUGG=d7321801caae694090694ff55a9323139f043b88
  offset 4108-4127 (20B)  NVDA=d0601ce157db5bdc3162bbac2a2c8af5320d9eec  JUGG=d7321801caae694090694ff55a9323139f043b88
  offset 4198-4217 (20B)  NVDA=d0601ce157db5bdc3162bbac2a2c8af5320d9eec  JUGG=d7321801caae694090694ff55a9323139f043b88
identical bytes: 5845/5905 = 98.98%
```

The only differing bytes are the 20-byte collateral-token immutable at 3 sites. The trailing metadata CBOR hash is byte-identical, so it is the same compilation unit as the Sourcify-`exact_match` NVDA registry. **Treat all 11 as the audited-equal same contract.**

### 1.2 There is no other Overcall contract

- **No zone.** Every live order carries `zone = 0x0` and the client's own zod schema refuses anything else: `"A listing carries no zone."`
- **No conduit.** `conduitKey = 0x0`; schema: `"A listing uses no conduit."` The Seaport conduit controller exists on the chain at `0x00000000F9490004C11Cef243f5400493c00Ad63` (8820 bytes, returned by Seaport's own `information()`), but Overcall does not use it.
- **No fee contract.** The 5% premium fee is a plain second Seaport consideration item paid to an **EOA**.
- **No proxy.** Sourcify: `"proxyResolution": {"isProxy": false, "proxyType": null, "implementations": []}`.
- **No keeper contract.** Overcall's docs: *"No keeper, no bot, no scheduled roll. Nothing runs unattended. A cycle is created by hand by an operator."*

### 1.3 Reference addresses (all confirmed by `eth_getCode` this session)

| Piece | Address | bytes |
|---|---|---|
| NVDA Stock Token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 283 (beacon proxy) |
| NVDA Stock Token **beacon** | `0xe10b6f6b275de231345c20d14ab812db62151b00` | 2332 |
| Shared `Stock` implementation | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` | 11614 |
| USDG (6 dp) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 170 |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` | 23981 |
| Seaport ConduitController | `0x00000000F9490004C11Cef243f5400493c00Ad63` | 8820 |
| Chainlink RHNVDA/USD | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | 9571 |
| Chainlink USDG/USD | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | 9571 |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 2202 |
| Uniswap V3 factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | 2109 |
| Uniswap V4 PoolManager | `0x8366a39CC670b4001a1121B8f6a443a643e40951` | 24009 |
| UniversalRouter | `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` | 19499 |
| Sequencer uptime feed | `0x0000000000000000000000000000000000000000` | **none exists — skip the check** |

---

## 2. `OvercallRegistry` — verified source + ABI (R1)

Sourcify has the full verified source. Saved to the repo:

- `ops/abis/OvercallRegistry.sol` (18,544 B)
- `ops/abis/IOvercallRegistry.sol` (23,439 B)
- `ops/abis/OvercallRegistry.abi.json` (53 entries)

```
GET https://sourcify.dev/server/v2/contract/4663/0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA?fields=all
match = "exact_match"  (creation + runtime)
compiler = solc 0.8.28+commit.7893614a, optimizer enabled runs=200, evmVersion cancun, viaIR false
deployment = {"transactionHash":"0xadb99c49fca5f5d3c7a8dd6b8f2a6edaff1d9204aaf9ce1d38b959822dfba9e9",
              "blockNumber":"59378796","transactionIndex":"10",
              "deployer":"0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0"}
sources = src/OvercallRegistry.sol, src/interfaces/IOvercallRegistry.sol, src/interfaces/IValoremClear.sol,
          lib/openzeppelin-contracts/contracts/access/Ownable.sol, .../Ownable2Step.sol, .../utils/Context.sol
```

### 2.1 The `Cycle` struct — this is what `Vault`/keeper binds to

```solidity
struct Cycle {
    uint32     number;             // 1-based; 0 before any cycle has been set
    uint40     exerciseTimestamp;  // every option of the cycle becomes exercisable
    uint40     expiryTimestamp;    // every option of the cycle expires
    uint96     lotSize;            // snapshotted at setCycle, 18-dp
    uint256[]  optionIds;          // approved Valorem option ids, ASCENDING STRIKE
}
```

### 2.2 Read surface (selectors computed with `cast sig`, all called live)

| Signature | Selector |
|---|---|
| `cycle()` → `(uint32,uint40,uint40,uint96,uint256[])` | `0x6190c9d5` |
| `cycleAt(uint256 index)` → same tuple | `0x53a32acd` |
| `cycleCount()` → `uint256` | `0x316fda0f` |
| `cycleNumber()` → `uint32` | `0x2f884710` |
| `cycleOf(uint256 optionId)` → `uint32` | `0x356944c4` |
| `collateralToken()` → `address` | `0xb2016bd4` |
| `exerciseToken()` → `address` | `0x2e4d8c8f` |
| `clearinghouse()` → `address` | `0x5d4f5f97` |
| `activeOptionIds()` → `uint256[]` | `0xb1e4ff8b` |
| `exerciseTimestamp()` → `uint40` | `0x7d4361bf` |
| `expiryTimestamp()` → `uint40` | `0xade6e2aa` |
| `lotSize()` → `uint96` | `0x4942f65f` |
| `cycleLotSize()` → `uint96` | `0xefdbdcdc` |
| `isCycleLive()` → `bool` | `0x1e4191ea` |
| `isWritingOpen()` → `bool` | `0xfa85ba38` |
| `isApproved(uint256 optionId)` → `bool` | `0x7910867b` |
| `writeDeadline()` → `uint40` | `0xe136de20` |
| `canReplaceCycle()` → `bool` | `0x9e9add41` |
| `strikePerContract(uint256 optionId)` → `uint96` | `0x4645ce49` |
| `owner()` / `pendingOwner()` | `0x8da5cb5b` / — |

Admin (owner only): `setCycle(uint256[] optionIds, uint40 exerciseAt, uint40 expireAt)` = **`0x819868cb`**, `setLotSize(uint96)`, `transferOwnership`, `acceptOwnership`. `renounceOwnership()` is `view` and reverts `RenounceDisabled`.

Events: `CycleSet(uint32 indexed number, uint256[] optionIds, uint40 exerciseAt, uint40 expireAt, uint96 lotSize)` — topic0 `0x0693c43568951ef06d18f0540e21539e80ffe14e3a7c01433e83ee8576022ffa`; `LotSizeSet(uint96,uint96)`; `OwnershipTransferStarted`; `OwnershipTransferred`.

Errors: `CycleIndexOutOfBounds`, `CycleStillLive`, `EmptyCycle`, `ExerciseAssetMismatch`, `ExerciseNotInFuture`, `ExerciseTimestampMismatch`, `ExerciseWindowTooShort`, `ExpiryTimestampMismatch`, `IdenticalAssets`, `LotSizeMismatch`, `NotAnOptionType`, `OwnableInvalidOwner`, `OwnableUnauthorizedAccount`, `RenounceDisabled`, `StrikesNotAscending`, `TooManyStrikes`, `UnderlyingAssetMismatch`, `ZeroAddress`, `ZeroLotSize`, `ZeroStrike`.

### 2.3 Semantics that matter for the keeper (from verified source)

```solidity
uint256 public constant MIN_EXERCISE_WINDOW = 1 days;
uint256 public constant MAX_STRIKES = 5;

function isApproved(uint256 optionId) external view returns (bool) {
    return _cycleOf[optionId] == cycleNumber && cycleNumber != 0;
}
function isCycleLive() public view returns (bool) {
    return block.timestamp < expiryTimestamp;
}
function writeDeadline() public view returns (uint40) {
    return exerciseTimestamp;           // <-- write deadline IS the exercise timestamp
}
function isWritingOpen() external view returns (bool) {
    return cycleNumber != 0 && block.timestamp < writeDeadline();
}
function strikePerContract(uint256 optionId) external view returns (uint96 strike) {
    strike = IValoremClear(clearinghouse).option(optionId).exerciseAmount;
}
```

Four things to carry into `Policy.sol` / the keeper:

1. **`MAX_STRIKES = 5`** — there are never more than 5 rungs. The "ladder of 5" in TECHSPEC §7 is correct and is a hard on-chain constant.
2. **`writeDeadline() == exerciseTimestamp`** — writing closes at book close (Fri 20:00 UTC), not at expiry. `rollOpen` must gate on `isWritingOpen()`.
3. **`optionIds` are ordered by ascending strike** — enforced by `StrikesNotAscending`. Index 0 is the lowest strike. You may pick a rung by index without re-sorting.
4. **`isApproved(optionId)`** is the cheap single-call guard against writing a look-alike option. Docs: *"`newOptionType` on the clearinghouse is permissionless"* — anyone can mint a look-alike option type. **`registry.isApproved(optionId)` is the only thing that distinguishes a real Overcall rung.** This should be a hard `require` in `AdapterValorem`.
5. The registry `lotSize` in `Cycle` is **snapshotted at `setCycle`**; forward-looking `lotSize()` can move after expiry. Validate against `cycle().lotSize`, not `lotSize()`.

---

## 3. Valorem Clear ABI on 4663 (R4)

Extracted from the bundle (`valoremClearAbi`) and every read confirmed live.

| Signature | Selector |
|---|---|
| `write(uint256 tokenId, uint112 amount)` → `uint256 claimId` | `0x888fbf43` |
| `newOptionType(address underlyingAsset, uint96 underlyingAmount, address exerciseAsset, uint96 exerciseAmount, uint40 exerciseTimestamp, uint40 expiryTimestamp)` → `uint256 optionId` | `0xaa9ffa93` |
| `option(uint256 tokenId)` → `Option` | `0x6448be8c` |
| `claim(uint256 claimId)` → `(uint256 amountWritten, uint256 amountExercised, uint256 optionId)` | `0x379607f5` |
| `position(uint256 tokenId)` → `(address,int256,address,int256)` | `0xf7a95a9e` |
| `exercise(uint256 optionId, uint112 amount)` | — |
| `redeem(uint256 claimId)` | — |
| `tokenType(uint256)` → `uint8` (0 None / 1 Option / 2 Claim) | `0xe6c3b1f6` |
| `feesEnabled()` → `bool` | `0xa64e4f8a` |
| `feeBps()` → `uint8` | `0x24a9d853` |
| `feeTo()` → `address` | `0x017e7e58` |
| `feeBalance(address token)` → `uint256` | — |
| `setFeesEnabled(bool)`, `sweepFees(address[])`, `setFeeTo`, `acceptFeeTo`, `setTokenURIGenerator` | owner-only |

```solidity
struct Option {
    address underlyingAsset;  uint96 underlyingAmount;
    address exerciseAsset;    uint96 exerciseAmount;
    uint40  exerciseTimestamp; uint40 expiryTimestamp;
    uint160 settlementSeed;   uint96 nextClaimKey;
}
```

Events (topic0 computed with `cast keccak`):

| Event | topic0 |
|---|---|
| `NewOptionType(uint256,address,address,uint96,uint96,uint40,uint40)` | `0x4da1232e91e9e12e1fcd6f97817ab15d2d20bdc3596fbfefc47b69ec4bcb3aeb` |
| `OptionsWritten(uint256,address,uint256,uint112)` | `0x64b996b55aa21c6915cb2fbdc6f619d5456d7ab76ac22242b0c8651a560c7abb` |
| `OptionsExercised(uint256,address,uint112)` | `0xf6c60e0fc5385c6476a6ab1c19a57c2cf1dcd7634067c3dd0149a78ff5fd2b4d` |
| `ClaimRedeemed(uint256,uint256,address,uint256,uint256)` | `0xa3d8a607cd3c6b3ffa03a5117299750bca64916c2122f1efffb6bf643a35740f` |
| `BucketWrittenInto(uint256,uint256,uint96,uint112)` | — |
| `BucketAssignedExercise(uint256,uint96,uint112)` | — |
| `FeeAccrued(uint256,address,address,uint256)` / `FeeSwept` / `FeeSwitchUpdated(address,bool)` / `FeeToUpdated(address)` | — |

**`NewOptionType` indexes `exerciseAsset`, `underlyingAsset`, `expiryTimestamp`** (topics 1,2,3); `optionId`, `exerciseAmount`, `underlyingAmount`, `exerciseTimestamp` are in `data` in that order.

### 3.1 Fee switch state — live

```
CLEARINGHOUSE {"feesEnabled": 0, "feeBps": 15, "feeTo": "0xdae7e82a2e7d566c67e87c164b05a1c560190782",
               "tokenURIGenerator": "0xe53ccb924d27f421a91b59087587fd866c5d64c7"}
```

**`feesEnabled() == false`, `feeBps() == 15`.** README's claim is correct. `feeTo` is an EOA (`eth_getCode` = 0 bytes). The `feesEnabled()` revert-gate in `AdapterValorem` is well-founded.

### 3.2 Token-id encoding (confirmed empirically)

`optionId` = upper 160 bits set, lower 96 bits zero. The claim NFT for the first write on an option is `optionId + 1` — observed directly:

```
optionId=56885395977254369119998982131173877604217583767740146085872832926902011297792
       = 0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
claimId =56885395977254369119998982131173877604217583767740146085872832926902011297793   (= optionId | 1)
```

So: **option id has `lower96 == 0`; claim ids share the upper 160 bits with `lower96 = claimKey ≥ 1`.** `nextClaimKey` in the `Option` struct is the next key that will be issued, so `nextClaimKey - 1` = number of claims opened against that option so far.

---

## 4. LIVE OPTION SERIES — NVDA cycle 1 (HIGH VALUE)

`cycle()` on the NVDA registry `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`:

```json
{
  "cycle": { "number": 1, "exerciseTimestamp": 1789761600, "expiryTimestamp": 1789848000,
             "lotSize": 1000000000000000000, "optionIds": [ ...5 ids... ] },
  "collateralToken": "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",   <- NVDA Stock Token
  "exerciseToken":   "0x5fc5360d0400a0fd4f2af552add042d716f1d168",   <- USDG
  "cycleNumber": 1, "cycleCount": 1,
  "lotSize": 1000000000000000000, "cycleLotSize": 1000000000000000000,
  "isCycleLive": 1, "isWritingOpen": 1,
  "writeDeadline": 1789761600,
  "owner": "0x408adcffebdf48ec23f1e3811a91aed3cc951cc0",
  "clearinghouse": "0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0",
  "canReplaceCycle": 0
}
```

- `exerciseTimestamp` **1789761600 = Fri 18 Sep 2026 20:00:00 UTC** (book close / write deadline)
- `expiryTimestamp` **1789848000 = Sat 19 Sep 2026 20:00:00 UTC** (exactly +86,400 s)
- `collateralToken()` == NVDA, `exerciseToken()` == USDG — **TECHSPEC §5 assertions hold**
- `lotSize` = `1e18` = 1.0000 NVDA per contract — README's lot size is correct

### The five NVDA rungs, decoded from `option(uint256)` on Valorem Clear

| # | strike (USDG) | optionId (decimal) | underlying | exercise | contracts written |
|---|---|---|---|---|---|
| 0 | **226.00** | `113025628429828481228850936737953628080486640605422851339090182744894714413056` | 1.0 NVDA | USDG | 0 |
| 1 | **231.00** | `29652592033419692000166847561911668028189801263392568326594311383797020491776` | 1.0 NVDA | USDG | 0 |
| 2 | **236.00** | `13956151908388063551378518883460877979717043668997816139085862263440384458752` | 1.0 NVDA | USDG | 0 |
| 3 | **241.00** | `8012928620938394388054169085135774622795258770514699139381494411582911807488` | 1.0 NVDA | USDG | 0 |
| 4 | **246.00** | `56885395977254369119998982131173877604217583767740146085872832926902011297792` | 1.0 NVDA | USDG | **1** (`nextClaimKey=2`) |

All five: `underlyingAmount = 1000000000000000000`, `exerciseAmount` = strike × 1e6 (USDG 6 dp), `exerciseTimestamp = 1789761600`, `expiryTimestamp = 1789848000`.

Hex ids (upper-160 form):
```
226 -> 0xf9e23d199282d4611ff78a93abe9f31de2d43398000000000000000000000000
231 -> 0x418ec5b78ab6c828d23ac4e50f484b1a5aeede6c000000000000000000000000
236 -> 0x1edae6ecfc36b8d725f077beee6b957adf180dbf000000000000000000000000
241 -> 0x11b72829420ee3bd0b8591c69e90504118dc11c9000000000000000000000000
246 -> 0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
```

### Strike ladder vs. Stonkhouse's OTM band

Overcall's own site reports NVDA spot **218.30** (Chainlink RHNVDA/USD, display only). Against that:

| strike | OTM % | inside Stonkhouse 3–12% band? |
|---|---|---|
| 226 | +3.53% | yes |
| 231 | +5.82% | yes |
| 236 | +8.11% | yes |
| 241 | +10.40% | yes |
| 246 | +12.69% | **no — 0.69pp above the 12% cap** |

The NVDA ladder is a **flat 5.00 USDG rung spacing**, not a percentage spacing (the equity markets all use flat rungs; the pool-priced memecoin markets use ~2% relative rungs). With spot at 218.30, four of five rungs qualify. Stonkhouse's `Policy` "nearest rung inside the band" therefore has real choices today — but note the band nearly excludes the top rung, and a 3% move in spot would push rungs out of the band from either end. **Recommend Policy treat "no qualifying rung ⇒ write nothing" as a routine weekly outcome, not an exception.**

### All markets, cycle 1 (full data in `ops/recon/live-option-series.json`)

```
NVDA        cycle=1 strikes=[226.0, 231.0, 236.0, 241.0, 246.0]
TSLA        cycle=1 strikes=[373.0, 380.0, 388.0, 396.0, 404.0]
GME         cycle=0 strikes=[]                                  <- no cycle ever set (cycleCount=0)
SPCX        cycle=1 strikes=[154.0, 157.0, 160.0, 163.0, 166.0]
SPY         cycle=1 strikes=[784.0, 800.0, 816.0, 832.0, 849.0]
AAPL        cycle=1 strikes=[336.0, 343.0, 350.0, 357.0, 364.0]
AMZN        cycle=1 strikes=[261.0, 266.0, 271.0, 276.0, 282.0]
CASHCAT     cycle=1 strikes=[0.172, 0.175, 0.179, 0.183, 0.187]
PONS        cycle=1 strikes=[0.645, 0.658, 0.671, 0.684, 0.698]
AI          cycle=1 strikes=[0.313, 0.319, 0.325, 0.332, 0.339]
JUGGERNAUT  cycle=1 strikes=[0.01014, 0.01034, 0.01055, 0.01076, 0.01098]
```

**Every market shares the same `exerciseTimestamp`/`expiryTimestamp` and the same `exerciseToken` (USDG).** Cycle 1 is the FIRST cycle — `cycleCount() == 1` everywhere. **There is no historical weekly cycle to calibrate against yet.**

---

## 5. The complete Overcall option universe — and who writes

`NewOptionType` over the last 8M blocks on the clearinghouse:

```
NewOptionType logs: 50
per-underlying option-type counts:
  0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec  5   NVDA
  0x322f0929c4625ed5bad873c95208d54e1c003b2d  5   TSLA
  0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea  5   SPCX
  0x117cc2133c37b721f49de2a7a74833232b3b4c0c  5   SPY
  0xaf3d76f1834a1d425780943c99ea8a608f8a93f9  5   AAPL
  0x12f190a9f9d7d37a250758b26824b97ce941bf54  5   AMZN
  0x020bfc650a365f8bb26819deaabf3e21291018b4  5   CASHCAT
  0x39dbed3a2bd333467115de45665cc57f813c4571  5   PONS
  0x2e8c31162b855a2ffa90f6f8634643ad6f111e18  5   AI
  0xd7321801caae694090694ff55a9323139f043b88  5   JUGGERNAUT
```

**Exactly 50 option types = 5 × 10 markets. That is the entire options universe on chain 4663.** Every one was created by a single sender:

```
from=0x408adcffebdf48ec23f1e3811a91aed3cc951cc0 to=0x9a7b40e5...C78C0C0 sel=0xaa9ffa93 count=50
```

`0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` is the **Overcall ops EOA**: it is `registryOwner` on all 11 registries, it deployed the registries, it created all 50 option types, and it sent every `setCycle`. Nonce 73. **Single key, no multisig.** GME's registry exists but `cycleCount() == 0` — a cycle has never been set for it (matches the site showing GME "no cycle").

### Who has called `write()` on Valorem Clear (answers the "which contracts call Valorem" question)

```
OptionsWritten: 2 logs

block=60302146 tx=0xaf661fa9f4733ff19145a1004b77e1290ed3046521ed85dc22861f2de7f1465d
   optionId=56885395...297792   (NVDA 246 strike)
   writer=0xe73d7021a3ef2808c3dd8237982fcc5fa11275be claimId=...297793 amount=1
   tx.from=0xe73d7021a3ef2808c3dd8237982fcc5fa11275be tx.to=0x9a7b40e5... selector=0x888fbf43
   writer codeBytes=0

block=60910684 tx=0x4b8beaa93970fa0e46453af4ec7b527680d4ead0bbeef8ea5dfaf356b39047b2
   optionId=873393...129344   (CASHCAT lowest strike)
   writer=0x789a7490718cf944d6f2ca411ed53cdefd56306a claimId=...129345 amount=21
   tx.from=0x789a7490718cf944d6f2ca411ed53cdefd56306a tx.to=0x9a7b40e5... selector=0x888fbf43
   writer codeBytes=0
```

`OptionsExercised: 0 logs`. `ClaimRedeemed: 0 logs`.

**Both writers are EOAs calling the clearinghouse directly. `codeBytes=0` on both. No contract has ever written on Valorem Clear on this chain.** Stonkhouse's `AdapterValorem` would be the first contract writer — which also means:

- the ERC-1155 `onERC1155Received` / `onERC1155BatchReceived` path in Valorem's mint has **never been exercised by a contract on 4663**. Fork-test it hard; the vault must implement `ERC1155Holder` for both the option tokens and the claim NFT or `write()` will revert on mint.
- total protocol usage to date: **2 writes, 1 fill, 0 exercises, 0 redeems.** This is a week-one protocol.

---

## 6. Seaport order shape (R2, R9) — from a real filled order

### 6.1 The reference order: the one filled NVDA call

`GET https://overcall.finance/api/orders?status=filled&limit=50` →

```json
{
  "orderHash": "0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522",
  "chainId": 4663,
  "offerer": "0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be",
  "optionId": "56885395977254369119998982131173877604217583767740146085872832926902011297792",
  "quantity": "1", "remaining": "0",
  "unitPrice6": "4000000", "totalPrice6": "4000000", "realisedPremium6": "3800000",
  "startTime": "0", "endTime": "1789761600",
  "salt": "95941992777576660739888578361827826050802484697670100586800480598437555708740",
  "counter": "0", "status": "filled",
  "filledNumerator": "1", "filledDenominator": "1",
  "components": {
    "offerer": "0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be",
    "zone": "0x0000000000000000000000000000000000000000",
    "offer": [{ "itemType": 3, "token": "0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
                "identifierOrCriteria": "56885395...297792", "startAmount": "1", "endAmount": "1" }],
    "consideration": [
      { "itemType": 1, "token": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        "identifierOrCriteria": "0", "startAmount": "3800000", "endAmount": "3800000",
        "recipient": "0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be" },
      { "itemType": 1, "token": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        "identifierOrCriteria": "0", "startAmount": "200000", "endAmount": "200000",
        "recipient": "0xdAe7e82A2E7D566C67E87C164B05a1C560190782" }
    ],
    "orderType": 1,
    "startTime": "0", "endTime": "1789761600",
    "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "conduitKey": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "counter": "0"
  },
  "signature": "0x110031b6ee7194d2f32d90a12bde37ea048c81c4094da7207a25edadb4c081ec35ae8045cafac3191fbc3c0be75eba15c62fccabf9f72508318f528f51ab56b01b",
  "createdAt": "2026-09-11T13:48:12.611Z",
  "checkedAt": "2026-09-12T18:15:32.238Z"
}
```

Corroborated on chain: `USDG.balanceOf(0xdAe7e8…0782) = 0.200000` — exactly the 5% fee from this single 4.00 USDG fill. The fee path is real and it goes to the EOA.

### 6.2 Order shape rules, from the client's own `buildListing` + zod schema

| Field | Value | Source |
|---|---|---|
| `offerer` | the writer (must equal `consideration[0].recipient`) | schema: *"The premium must be paid to the offerer."* |
| `zone` | `0x0` (**none**) | schema: *"A listing carries no zone."* |
| `offer` | **exactly 1** item: `itemType=3` (ERC1155), `token = clearinghouse`, `identifierOrCriteria = optionId`, `startAmount = endAmount = quantity` | schema: *"A listing offers exactly one item."* |
| `consideration` | 1 or 2 items, both ERC20 USDG with `identifierOrCriteria = 0`; `[0]` = net premium → offerer, `[1]` = fee → fee recipient | schema: min 1, max 2 |
| `orderType` | **`1` = `PARTIAL_OPEN`** | literal in schema — **partial fills ARE allowed** |
| `startTime` | **`0`** | schema: *"Start time must be 0."* |
| `endTime` | **the option's `exerciseTimestamp`** (= book close, = `registry.writeDeadline()`) | `buildListing` requires `endTime > 0`; live orders use 1789761600 |
| `zoneHash` | `0x0` | schema: *"A listing carries no zone hash."* |
| `conduitKey` | **`0x0` — no conduit** | schema: *"A listing uses no conduit."* |
| `salt` | 32 random bytes as a uint256 (`crypto.getRandomValues`) | `buildListing` |
| `counter` | `Seaport.getCounter(offerer)` | `readCounter` |
| `totalOriginalConsiderationItems` | `consideration.length` | `toParameters` |

Fixed-price only: `startAmount === endAmount` on every item (two separate schema refinements).

**Fee arithmetic** (`buildListing`, exact integer order — do not reorder, it is per-contract then multiplied):

```js
feePerContract6    = unitPrice6 * feeBps / 10000     // rounded down
writerPerContract6 = unitPrice6 - feePerContract6
consideration[0]   = writerPerContract6 * quantity   // to offerer
consideration[1]   = feePerContract6    * quantity   // to fee recipient
```
with `feeBps = 500` (5%), ceiling 1000 bps. It throws if `feePerContract6 == 0` — *"This premium is too small to carry the protocol fee."* So **minimum unit price is 20 USDG-units (0.00002 USDG) or the fee rounds to zero and the client refuses**. Confirmed in the live order: 4000000 → fee 200000, writer 3800000.

**Approvals** (from `useWalletFacts` / `useApprove*`): because `conduitKey` is zero, everything is approved **directly to Seaport / the clearinghouse**, never to a conduit:
- collateral (NVDA) `approve(clearinghouse, amount)` — for `write`
- option ERC-1155 `setApprovalForAll(seaport, true)` **on the clearinghouse** — for the listing to be fillable
- USDG `approve(seaport, amount)` — buyer, to pay the premium
- USDG `approve(clearinghouse, amount)` — buyer, to pay the strike on `exercise`

**Fulfilment**: `fulfillAdvancedOrder(advancedOrder, [], bytes32(0), address(0))` with `fulfillerConduitKey = 0x0` and `recipient = address(0)`; simple path `fulfillOrder(order, bytes32(0))`.

**EIP-712 domain**: `{name:"Seaport", version:"1.6", chainId, verifyingContract:"0x0000000000000068F116a894984e2DB1123eB395"}`, primary type `OrderComponents`, standard Seaport types.

### 6.3 R9 answered

Conduit controller `0x00000000F9490004C11Cef243f5400493c00Ad63` exists (8820 bytes; Seaport's `information()` returns it), but **Overcall uses the zero conduit**. Approve Seaport directly. Docs confirm: *"Reported by Seaport; Overcall uses no conduit."*

---

## 7. Overcall listings API (R3) — endpoint, payload, and a LAUNCH BLOCKER

Base: `https://overcall.finance/api/orders`. Same-origin Next.js route. **No auth header, no API key, no nonce.**

### GET
`GET /api/orders?status=open|filled|cancelled|expired&optionId=&offerer=&limit=` → `{"listings":[ ... ]}`
Any other `status` → `400 {"error":"One of the query parameters is not valid."}`. Poll interval used by their own UI: 15 s.

Response fields per listing: `orderHash, chainId, offerer, optionId, quantity, remaining, unitPrice6, totalPrice6, realisedPremium6, startTime, endTime, salt, counter, status, filledNumerator, filledDenominator, components{...}, signature, createdAt, checkedAt`.

### POST
`POST /api/orders?market=NVDA` (the `market` query param is optional), body:

```json
{ "chainId": 4663, "components": { ...OrderComponents, all numbers as decimal strings... }, "signature": "0x..." }
```

### Probes I actually ran

```
POST {}                                    -> 400 {"error":"Invalid input: expected number, received undefined (at chainId)"}
POST {...,"offer":[]}                      -> 400 {"error":"A listing offers exactly one item. (at components.offer)"}
POST {...valid shape, 200-byte signature}  -> 400 {"error":"Not a valid signature. (at signature)"}
POST {...valid shape, 65-byte garbage sig} -> 401 {"error":"Invalid signature."}
```

Two conclusions, both load-bearing:

**(a) Unknown makers are NOT blocked.** A body with an arbitrary `offerer` passed every structural check and failed only at signature recovery (`401 Invalid signature`). There is no allowlist, no handshake, no registration step. If the signature recovers to the offerer, the listing is accepted. **The "Overcall API handshake" in plan.md M7 is not a blocker — no handshake exists.**

**(b) ⚠️ EIP-1271 CONTRACT SIGNATURES ARE REJECTED. This IS a blocker.** The signature validator is:

```js
z.string().regex(/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/, "Not a valid signature.")
```

64-byte (EIP-2098 compact) or 65-byte ECDSA **only**. A 200-byte signature — the shape an EIP-1271 contract signature takes — is rejected at the schema layer with `400 Not a valid signature.` The server returns the client's zod messages verbatim, so **the same schema runs server-side**; this is not a client-only check I could bypass.

**Impact on Stonkhouse.** `AdapterSeaport.sol` is specified in TECHSPEC §5 as "EIP-1271 listings". Seaport itself will honour a 1271 order from the vault on chain, so a listing signed that way **is fulfillable** — but it can never be POSTed to Overcall, so it will **never appear on overcall.finance**, and per README that is "an unfilled week". Options, in preference order:

1. **Ask Overcall to widen the regex** to accept an arbitrary-length signature and verify via `Seaport.getOrderStatus`/ERC-1271. Small change on their side; this is the real "handshake" to negotiate pre-launch.
2. **Make the offerer an EOA keeper**, and have the vault transfer the option ERC-1155s to that EOA before listing. This puts written options in a hot EOA between write and fill — a custody regression the Admin Safe has to accept explicitly. Note `consideration[0].recipient` must equal `offerer`, so the USDG premium would land in the EOA too and need sweeping back to the vault.
3. **Ship the fallback first**: publish the vault's own 1271-signed Seaport payload on `/vault/nvda/cycle`, as README already contemplates. Accept lower fill probability for v1.

I recommend treating (1) as the launch-week ask and (3) as the guaranteed path, and pricing week 0–1 on the assumption that fills come only from our own surface. **Do not architect around (2) without an explicit Admin decision.**

---

## 8. Testnet 46630 (R7) — Overcall IS deployed there

```
t_registry_NVDA      0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56 bytes=5905
t_clearinghouse      0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc bytes=16110
t_NVDA (mock)        0x40ab39E8E1D626fa506CCDF917697975a102D1D7 bytes=3778
t_USDG (mock)        0xe3B032b565d494A994772AEFF9919CC9AC574bEF bytes=1862
t_registry_TSLA      0x904a1D63a49c87aFbCe3F05F6079c4Eb9c85C359 bytes=5778   <- older build
t_SEQ_UPTIME (mock)  0x86301F34D3F29805A6784FB20A5B36374814A040 bytes=1156
```

Testnet NVDA registry `cycle()` returns **cycleNumber = 2** with 5 option ids, `lotSize = 1e18`, `exerciseTimestamp = 0x6aa1fbcf`, `expiryTimestamp = 0x6aa34d4f`. So testnet is a cycle ahead of mainnet and is usable for the M3/M6 dry-runs.

Full testnet address book (from the bundle + docs `contracts/deployments/46630.json`):

| Contract | Address |
|---|---|
| `ValoremOptionsClearinghouse` | `0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc` |
| `TokenURIGenerator` | `0x878Acc151a297e1c82E0eD87826968e6fBF0f606` |
| `OvercallRegistry` (NVDA) | `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56` |
| `OvercallRegistry` (docs' singleton) | `0x904a1D63a49c87aFbCe3F05F6079c4Eb9c85C359` |
| registries: AAPL / AMZN / CATTEST / GME / MEME / PLTR / SPCX / SPY / TSLA | `0x36d7B6Ec…e5e1` / `0x43a93af1…30fB` / `0x2FBD07F3…d16F` / `0x9A92fE42…d422` / `0xb294bA60…aaD3` / `0x5125D5A8…a029` / `0x059961bb…4bD` / `0xE387985c…c6Ca` / `0x904a1D63…C359` |
| `MockStockToken` (NVDA stand-in) | `0x7731D8D6765f73E9FAbE989e3222B7D635c9F3F5` |
| `MockUSDG` | `0xe3B032b565d494A994772AEFF9919CC9AC574bEF` |
| `MockAggregatorV3` (NVDA feed) | `0xcac7742b5542F155efCbD1dfA3F2DFda8dE90CB5` |
| `MockSequencerUptimeFeed` | `0x86301F34D3F29805A6784FB20A5B36374814A040` |
| `feeTo` **and** registry owner | `0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82` |
| Seaport 1.6 / Multicall3 | same canonical addresses as mainnet |

RPC `https://rpc.testnet.chain.robinhood.com`, faucet `https://faucet.testnet.chain.robinhood.com`. **No published explorer for 46630.**

The client hard-fails if the mainnet fee recipient is ever set to the testnet deployer: *"The protocol fee recipient on mainnet is …, which is the testnet deployer. Its private key is a throwaway and must never hold real fees."*

---

## 9. Explorer reality check (R8)

| Explorer | Result |
|---|---|
| `robinhoodchain.blockscout.com/api/v2/...` | **Cloudflare JS challenge** (`Just a moment...`) for any scripted client, including `/api`. Overcall's own docs confirm: *"The explorer sits behind a Cloudflare JS challenge for automated clients, and that includes its `/api` endpoint — verification from a shell is not available."* |
| `robinscan.io/api/v2/...` | `404 {"error":"not found"}` — has an API but different routes; not probed further |
| `hoodscan.co/api/v2/...` | `403` after redirect to lowercase path |
| `stonkscan.io/api/v2/...` | returns the Next.js SPA shell, not JSON |
| **`sourcify.dev/server/v2/contract/4663/{addr}`** | **works, returns full verified source + ABI + storage layout + deployment tx.** Use this. |

**Recommendation for `ops/`: use Sourcify as the verification backend for 4663, not Blockscout.** Blockscout remains fine for human links in the UI.

---

## 10. Ops cadence, observed

- `setCycle` tx `0xbd29d015d45dcaa0a0cb2bcefd9eb6722e9d66819418c3cc99c423eca775eb8e`, block 60,320,764, **2026-09-11 12:23:22 UTC**, `from = 0x408adc…1CC0`, selector `0x819868cb`.
- Option types created at blocks 60,254,094–60,254,180 — **before** the cycle was set, in the same session, one tx per strike.
- Cycle 1 exercise **Fri 18 Sep 2026 20:00 UTC**, expiry **Sat 19 Sep 2026 20:00 UTC**.
- So the operator's pattern is: create 5 option types → `setCycle` → let it run. Roughly **7 days of lead time** between `setCycle` and book close.
- `canReplaceCycle() == false` while a cycle is live (`CycleStillLive` guards `setCycle`), so the ladder for the current week cannot be changed mid-flight. Good for the keeper: **once `rollOpen` reads `cycle()`, the optionIds and timestamps are immutable for that week.**
- Cadence caution: only ONE cycle has ever existed. There is no evidence yet that cycle 2 will land on the next calendar Friday, or that the operator will roll on time. **The keeper must poll `cycleNumber()` and bind to `cycle()`; it must not assume a weekly wall-clock.** README already says this; the chain data supports it strongly.

---

## 11. ⚠️ Impostor / look-alike warnings

1. **"Overcall Finance" (OVC) token — `0xfc920df31d8382137f77548c838486ce5d8981d0`** — an ERC-20 with 3248 bytes of code, `name() = "Overcall Finance"`, `symbol() = "OVC"`, 18 decimals. A web search returned this as "the contract address" for Overcall. **It is referenced nowhere in overcall.finance's HTML, JS bundles, or docs** (`grep -ril` across all fetched assets: not found). Overcall's docs describe no protocol token. **Treat OVC as unaffiliated; do not wire it into anything, and do not let it near the UI address book.**
2. **Counterfeit GME.** Overcall's docs: *"A counterfeit GME token has traded over a hundred million dollars on this chain."* The registry-approved GME collateral is `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` (`name() = "GameStop • Robinhood Token"`, 283 bytes, beacon proxy). Whitelist by address, never by symbol — that is Overcall's stated rule and should be Stonkhouse's too.
3. **`newOptionType` is permissionless.** Anyone can mint an option type with NVDA/USDG and the same timestamps but a different strike, or the same strike with a subtly different `underlyingAmount`. **`registry.isApproved(optionId)` is the only defence.** Make it a hard require in `AdapterValorem.write`.
4. **`addresses[4663].registry` is the JUGGERNAUT registry**, not NVDA. A naive read of the bundle's singleton `registry` field would point Stonkhouse at a memecoin market. Resolve per market.

### 11.5 Stock Token proxy + blocklist shape (partial R6 input)

The NVDA Stock Token is a **standard EIP-1967 beacon proxy**, and the beacon **doubles as the blocklist authority**. Verified end to end:

```
cast keccak "eip1967.proxy.beacon"
  -> 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d51
     (minus 1 = 0x...d50, the slot Overcall's probeBlocklist reads — standard EIP-1967 beacon slot)

eth_getStorageAt(0xd0601CE1…9EEC, 0xa3f0ad74…d50)
  -> 0x000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00     <- beacon

beacon.implementation()   [0x5c60da1b]
  -> 0x000000000000000000000000b35490d6f9163de4f80d88dc75c3516eb64c5ae2     <- shared Stock impl (matches docs)

beacon.isBlocked(0x408adc…1CC0)   [0xfbac3951]
  -> 0x0000…0000  (false)
```

| Piece | Address | bytes |
|---|---|---|
| NVDA Stock Token (beacon proxy) | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 283 |
| Beacon **and blocklist** (`implementation()`, `isBlocked(address)`) | `0xe10b6f6b275de231345c20d14ab812db62151b00` | 2332 |
| Shared `Stock` implementation | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` | 11614 |

Two consequences for Stonkhouse:

- **The issuer can swap the implementation behind every Stock Token at once** by pointing the beacon elsewhere. That is a single upgrade key over the vault's entire underlying. It belongs in `README` risk copy and in the audit scope note.
- **`isBlocked` is enforced on transfer**, so the *vault itself* can be blocked. Overcall reproduced the paused-token case on testnet: with collateral paused, both reclaim and exercise revert (their txs `0x581b3776…a12efe` and `0xa3c38a22…6840867`). A blocked or paused underlying freezes `rollClose`/redemption with no contract able to unstick it. `Guardian` cannot fix this — worth saying plainly in the risk page.

---

## 12. Answers to plan.md §9 unknowns

| # | Status | Answer |
|---|---|---|
| **R1** | **RESOLVED** | NVDA registry `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`. Full verified source + ABI saved to `ops/abis/`. `cycle()`, `collateralToken()`, `exerciseToken()`, `optionIds`, timestamps all confirmed live. |
| **R2** | **RESOLVED** | zone `0x0`, conduitKey `0x0`, orderType `1` (PARTIAL_OPEN → **partial fills allowed**), fee recipient `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` @ 500 bps, salt = 32 random bytes, startTime 0, endTime = `exerciseTimestamp`. Real filled order in §6.1. |
| **R3** | **RESOLVED (with a blocker)** | `POST https://overcall.finance/api/orders`, body `{chainId, components, signature}`, no auth, **unknown makers accepted**. **But EIP-1271 signatures are rejected by regex.** See §7. |
| **R4** | **RESOLVED** | Full Valorem ABI + selectors + token-id encoding in §3. `feesEnabled()=false`, `feeBps()=15`. |
| **R5** | **PARTIAL** | Chainlink RHNVDA/USD `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` (8 dp, 0.5% deviation, 86400 s heartbeat, multiplier ALREADY applied — never re-apply). USDG/USD `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`. **No sequencer uptime feed exists on 4663 — the address book slot is `0x0` and the check must be skipped.** `oraclePaused()`/`paused()` on the Stock Token: docs report both `false`; I did not call them myself — leaving to R5's owner. |
| **R6** | **PARTIAL** | NVDA token is a **beacon proxy**. See §11.5 — the beacon is also the blocklist authority. `uiMultiplier()` semantics not read by me. |
| **R7** | **RESOLVED** | Yes. Testnet 46630 has a full Overcall deployment, NVDA registry `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56`, currently on **cycle 2**. §8. |
| **R8** | **RESOLVED** | Blockscout `/api` is Cloudflare-gated. **Use Sourcify** (`sourcify.dev/server/v2/contract/4663/{addr}`) for verified source/ABI and for our own deploy verification. §9. |
| **R9** | **RESOLVED** | ConduitController `0x00000000F9490004C11Cef243f5400493c00Ad63` exists; **Overcall uses the zero conduit**. Approve Seaport directly. |

---

## 13. UNRESOLVED

1. **Whether Overcall will accept an EIP-1271 signature if asked.** The regex is a hard `400` today. Whether they will widen it is a business question I cannot answer from chain or code. **This is the single highest-value item to escalate.** (I confirmed the rejection; I did not attempt to contact them.)
2. **Cycle-2 timing and whether the cadence is truly weekly.** `cycleCount() == 1` everywhere on mainnet — there is exactly one cycle in history. The Friday/Saturday 20:00 UTC pattern comes from cycle 1 plus the site's copy, not from an observed repetition. Cannot be confirmed until cycle 2 lands.
3. **How the operator chooses the 5 strikes.** NVDA uses flat 5.00 USDG rungs; the pool-priced markets use ~2% relative rungs. With one cycle of data I cannot tell whether the rung anchor is spot-at-setCycle, a round number, or discretionary. This matters for whether Stonkhouse's 3–12% band will reliably contain a rung. **Re-measure at cycle 2.**
4. **`realisedPremium6` semantics in the API.** On the filled order `unitPrice6 = 4000000` but `realisedPremium6 = 3800000` — it appears to be the **writer's net** (post-5%-fee), but I only have one filled order, so I cannot rule out a different definition under partial fills.
5. **Whether the POST endpoint rate-limits or dedupes.** I sent 4 probes; none were accepted, so I never observed the success path, a duplicate-salt response, or any rate limit.
6. **`ops/recon/live-option-series.json` `contractsWritten_inferred`** is derived from `nextClaimKey - 1`, i.e. the number of *claims opened*, not the number of contracts written. For NVDA 246 they coincide (1 claim, 1 contract) but they diverge if one writer writes twice into one claim. Read `claim(claimId).amountWritten` for the true figure.
7. **Overcall source repository.** `api.github.com/search/repositories?q=overcall+robinhood` → `total_count: 0`; `api.github.com/orgs/overcall/repos` → `[]`. **No public repo found.** Their docs reference internal paths (`config/addresses.json`, `contracts/deployments/<chainid>.json`, `web/src/app/api/orders`) but the repo is not published. Code-search would need an authenticated token (unauthenticated `search/code` → 401).
8. **The other three explorers** (robinscan.io, hoodscan.co, stonkscan.io) were probed only at the Blockscout-style `/api/v2` path. They may expose usable APIs on other routes; I stopped once Sourcify solved the problem.
9. **Stock Token `uiMultiplier()` / ERC-8056 semantics and `oraclePaused()` heartbeat** — belongs to R5/R6; I have the beacon and implementation addresses but did not call the multiplier surface.

---

## 14. Artifacts written

| Path | Contents |
|---|---|
| `ops/recon/R12-overcall-discovery.md` | this file |
| `ops/recon/live-option-series.json` | all 11 markets, cycle state, and all 50 decoded option series |
| `ops/abis/OvercallRegistry.sol` | Sourcify verified source, exact_match |
| `ops/abis/IOvercallRegistry.sol` | Sourcify verified interface (full NatSpec) |
| `ops/abis/OvercallRegistry.abi.json` | 53-entry ABI |

---

# Verification pass

Independent adversarial re-derivation, 2026-09-12, chain head block 61,324,626 → 61,328,614
(`ts 1789238387` = 2026-09-12 18:39:47 UTC). Every address below was `eth_getCode`'d by me in this
pass; every selector was recomputed with `cast sig`; every log count was re-scanned with my own
`eth_getLogs`. RPC used: `https://rpc.mainnet.chain.robinhood.com` (fallback
`https://robinhood-rpc.publicnode.com`), testnet `https://rpc.testnet.chain.robinhood.com/rpc`.

**Verdict: PARTIAL.** The core answer survives. Every address, every selector, every optionId,
every strike, the order shape and the whole-chain usage history reproduce bit-exactly. Four things
are wrong or materially incomplete: a wrong block number, an over-stated launch blocker, a listings-API
gate that was never found, and a testnet section that reads as "ready" when it is not.

## 1. What reproduced exactly (no corrections)

### 1.1 `eth_getCode` byte lengths — 25/25 mainnet, 3/3 testnet

```
ValoremClear         0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 -> 16110
TokenURIGenerator    0xE53cCB924d27f421a91b59087587fD866C5d64c7 -> 9901
REG_NVDA             0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA -> 5905
REG_TSLA             0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1 -> 5905
REG_GME              0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335 -> 5905
REG_SPCX             0x915148f98C0450251261654ffb6B54BA7005efFF -> 5905
REG_SPY              0x6369CeCe2de602Ce1911039C123dc97E816715A9 -> 5905
REG_AAPL             0xB500929deb0100598D9A1392113a6F6D2A31C018 -> 5905
REG_AMZN             0x195dcf905Ad9fDda76E492016E680B2D0F9F0877 -> 5905
REG_CASHCAT          0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1 -> 5905
REG_PONS             0x365B4D099768F6B2fF07200e7d5AA14D899c1897 -> 5905
REG_AI               0xD1d56916f6E945F59C6E226A7429Da688532a113 -> 5905
REG_JUGGERNAUT       0x65dD407955912Be814f723724cE60f91ebd72616 -> 5905
opsEOA               0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0 -> 0
feeTo                0xdAe7e82A2E7D566C67E87C164B05a1C560190782 -> 0
ConduitController    0x00000000F9490004C11Cef243f5400493c00Ad63 -> 8820
NVDA_beacon          0xe10b6f6b275de231345c20d14ab812db62151b00 -> 2332
StockImpl            0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2 -> 11614
FEED_NVDA            0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 -> 9571
FEED_USDG            0x61B7e5650328764B076A108EFF5fa7282a1B9aD2 -> 9571
GME_token            0x1b0E319c6A659F002271B69dB8A7df2F911c153E -> 283
IMPOSTOR_OVC         0xfc920df31d8382137f77548c838486ce5d8981d0 -> 3248
NVDA_token           0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC -> 283
USDG                 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 -> 170
Seaport16            0x0000000000000068F116a894984e2DB1123eB395 -> 23981
--- TESTNET 46630 ---
REG_NVDA_T           0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56 -> 5905
Clear_T              0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc -> 16110
testFeeTo            0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82 -> 0
```

### 1.2 Selectors — every quoted selector recomputes

`cast sig` output matched all eight quoted registry selectors and every clearinghouse selector:
`cycle() 0x6190c9d5`, `collateralToken() 0xb2016bd4`, `exerciseToken() 0x2e4d8c8f`,
`isApproved(uint256) 0x7910867b`, `isWritingOpen() 0xfa85ba38`, `writeDeadline() 0xe136de20`,
`strikePerContract(uint256) 0x4645ce49`, `setCycle(uint256[],uint40,uint40) 0x819868cb`,
`write(uint256,uint112) 0x888fbf43`,
`newOptionType(address,uint96,address,uint96,uint40,uint40) 0xaa9ffa93`,
`information() 0xf47b7740`, `isBlocked(address) 0xfbac3951`, `implementation() 0x5c60da1b`.

More important: **every claimed function is actually in the deployed dispatcher**, not copied from
upstream. I extracted the PUSH4 table from the clearinghouse runtime and eth_call'd every registry
getter. The 51 dispatcher selectors include `feeBalance(address) e1f3962c`, `setFeesEnabled(bool)
a901dd92`, `sweepFees(address[]) d6d859e9`, `setTokenURIGenerator(address) 04e618ce`,
`acceptFeeTo() f1f5d0c3`. `balanceOf(address,uint256) 0x00fdd58e` does not appear as a PUSH4
(leading zero byte → the optimiser emits a shorter push) but eth_call returns `0x00…00`, so it is live.

The registry ABI from Sourcify (`?fields=abi`, contract name `src/OvercallRegistry.sol:OvercallRegistry`,
solc `0.8.28+commit.7893614a`, cancun, 200 runs, viaIR false) contains **every** function, event and
error in the claimed list. Omissions only, no inventions: the claimed list drops
`renounceOwnership()`, `OwnershipTransferStarted`, `OwnershipTransferred`, `OwnableInvalidOwner(address)`,
`OwnableUnauthorizedAccount(address)`.

### 1.3 NVDA cycle — bit-exact

Raw `cycle()` decoded: `number=1`, `exerciseTimestamp=0x6aad9840=1789761600` (2026-09-18 20:00:00 UTC),
`expiryTimestamp=0x6aaee9c0=1789848000` (2026-09-19 20:00:00 UTC), `lotSize=0x0de0b6b3a7640000=1e18`,
5 optionIds. All five claimed decimal optionIds match the on-chain words exactly
(`MATCH_claimed_id=True` ×5), all have `lower96 == 0`, and `clearinghouse.option(id)` returns:

| idx | strike | eAmt | underlying | uAmt | ets | xts | nextClaimKey | isApproved | cycleOf |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 226 | 226000000 | 0xd0601ce1…9eec | 1e18 | 1789761600 | 1789848000 | 1 | 1 | 1 |
| 1 | 231 | 231000000 | same | 1e18 | same | same | 1 | 1 | 1 |
| 2 | 236 | 236000000 | same | 1e18 | same | same | 1 | 1 | 1 |
| 3 | 241 | 241000000 | same | 1e18 | same | same | 1 | 1 | 1 |
| 4 | 246 | 246000000 | same | 1e18 | same | same | **2** | 1 | 1 |

`MAX_STRIKES() = 5`, `MIN_EXERCISE_WINDOW() = 0x15180 = 86400`, `isCycleLive()=1`,
`isWritingOpen()=1`, `canReplaceCycle()=0`, `writeDeadline()=1789761600 == exerciseTimestamp`,
`owner()=0x408adc…1cc0`, `clearinghouse()=0x9a7b40e5…c0c0`.

All 11 registries swept: collateral tokens, `exerciseToken` (USDG on every one), `cycleCount`,
`owner` and strike ladders all match the report, including `GME cycleCount=0` and the pool-priced
ladders (CASHCAT 0.172–0.187, PONS 0.645–0.698, AI 0.313–0.339, JUGGERNAUT 0.01014–0.01098).

OTM math against the live feed (`answer 21829793457 / 1e8 = 218.29793457`):
3.53 / 5.82 / 8.11 / 10.40 / **12.69%** — four inside the 3–12% band, top rung 0.69pp outside. Correct.

### 1.4 Byte-diff NVDA vs JUGGERNAUT registry — reproduced to the byte

```
len NVDA 5905 len JUGG 5905
differing bytes: 60
  offset 1012-1031 (20B) NVDA=d0601ce157db5bdc3162bbac2a2c8af5320d9eec JUGG=d7321801caae694090694ff55a9323139f043b88
  offset 4108-4127 (20B) NVDA=d0601ce157db5bdc3162bbac2a2c8af5320d9eec JUGG=d7321801caae694090694ff55a9323139f043b88
  offset 4198-4217 (20B) NVDA=d0601ce157db5bdc3162bbac2a2c8af5320d9eec JUGG=d7321801caae694090694ff55a9323139f043b88
trailing metadata identical: True
  a2646970667358221220a0abc082c9f344b4334b0710ebe84a2c0ae32c886831b0b312c46dc7185e473a64736f6c634300081c0033
```

### 1.5 Sourcify, deployment, fee switch, Seaport

```
0x8E973cE1…f4EA  exact_match creation+runtime, verifiedAt 2026-09-10T13:24:55Z
0x9a7b40e5…C0C0  exact_match creation+runtime, verifiedAt 2026-09-10T13:24:56Z
0xE53cCB92…64c7  exact_match creation+runtime, verifiedAt 2026-09-10T13:24:30Z
0x65dD4079…2616  match: None   (JUGGERNAUT not verified — as claimed)
0x1E0F8a0a…7Bf1  match: None   (CASHCAT not verified — as claimed)
```
Deployment (Sourcify `?fields=deployment`):
`NVDA registry tx 0xadb99c49fca5f5d3c7a8dd6b8f2a6edaff1d9204aaf9ce1d38b959822dfba9e9 block 59378796 deployer 0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` — exactly as claimed.
Clearinghouse: `tx 0xacc4c4f96a1881f195e706387a4755eabc5243ccb56d3bcf07baa50c1ba21034 block 59378584`.

```
feesEnabled() 0x…00 (false)   feeBps() 0x…0f (15)
feeTo()       0x…dae7e82a2e7d566c67e87c164b05a1c560190782
tokenURIGenerator() 0x…e53ccb924d27f421a91b59087587fd866c5d64c7
USDG.decimals() 6   USDG.balanceOf(0xdAe7e8…0782) 0x30d40 = 200000 = 0.200000 USDG
Seaport.information() -> version "1.6", conduitController 0x00000000f9490004c11cef243f5400493c00ad63
```

Token-id encoding: `tokenType(optionId)=1`, `tokenType(optionId|1)=2`,
`claim(optionId|1) -> amountWritten=1000000000000000000, amountExercised=0, optionId=<the 246 id>`.

### 1.6 Whole-chain usage history — re-scanned myself

`eth_getLogs` on the clearinghouse, blocks 59,300,000 → head, 500k windows (clearinghouse was
deployed at 59,378,584, so this is complete history):

```
NewOptionType    50 logs
OptionsWritten    2 logs
OptionsExercised  0 logs
ClaimRedeemed     0 logs
FeeAccrued        0 logs
```
All 50 `NewOptionType` txs: `senders {'0x408adcffebdf48ec23f1e3811a91aed3cc951cc0': 50}`,
`selectors {'0xaa9ffa93': 50}`. `eth_getTransactionCount(0x408adc…1CC0) = 73`.

```
block 60302146 optionId 56885395…297792 writer 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be claimId …297793 amount 1
   writer codeBytes: 0
block 60910684 optionId 87339332…129344 writer 0x789a7490718cf944d6f2ca411ed53cdefd56306a claimId …129345 amount 21
   writer codeBytes: 0
```
**"No contract has ever written on Valorem Clear on 4663" is CONFIRMED.** Stonkhouse would be the
first contract writer; the ERC-1155 receiver path is untested on this chain. `ERC1155Holder` on the
vault for both token types remains a hard requirement.

### 1.7 Order shape and the address book

`GET /api/orders?status=filled` returned exactly the order quoted, field for field (zone `0x0`,
zoneHash `0x0`, conduitKey `0x0`, orderType `1`, startTime `0`, endTime `1789761600`, counter `0`,
offer itemType 3 / token = clearinghouse / identifier = the 246 optionId, consideration
`3800000 → offerer` + `200000 → 0xdAe7e8…0782`, signature 130 hex chars = **65 bytes**).

I also pulled the **open** order the report did not have, which corroborates the fee arithmetic on a
multi-quantity listing: `orderHash 0xeda0150a…bded`, offerer `0x789A7490…306a`, quantity 21,
`unitPrice6 50000`, `totalPrice6 1050000`, consideration `997500 → offerer` + `52500 → feeTo`
(= 47500×21 and 2500×21).

Bundle `addresses[4663]` verified directly out of `chunks/13i994ge4sv4e.js`: the `registries` map
matches all 11 addresses, `registry:"0x65dD407955912Be814f723724cE60f91ebd72616"` (the JUGGERNAUT
trap is real), `registryOwner:"0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0"`,
`feeTo:"0xdAe7e82A2E7D566C67E87C164B05a1C560190782"`,
`SEQUENCER_UPTIME_FEED:"0x0000000000000000000000000000000000000000"`.

Impostor check reproduced: `name()="Overcall Finance"`, `symbol()="OVC"`, `decimals=18` at
`0xfc920df3…81d0`; `grep -ril fc920df31d8382137f77548c838486ce5d8981d0` across the fetched HTML and
all 11 homepage JS chunks → **no hits**. Unaffiliated. Real GME `name()="GameStop • Robinhood Token"`.

Beacon path reproduced: `eth_getStorageAt(NVDA, 0xa3f0ad74…d50) = 0x…e10b6f6b275de231345c20d14ab812db62151b00`,
`beacon.implementation() = 0x…b35490d6f9163de4f80d88dc75c3516eb64c5ae2`,
`beacon.isBlocked(0x408adc…1CC0) = false`.

Blockscout `/api/v2/...` and `/api?module=contract...` both return **HTTP 403** — the Cloudflare
claim is correct, Sourcify is the right tool.

---

## 2. CORRECTIONS

### C1 — the `setCycle` block number is wrong

Report: *"`setCycle` tx `0xbd29d015…eb8e`, block 60,320,764, 2026-09-11 12:23:22 UTC"*.

```
setCycle tx: {'from': '0x408adcffebdf48ec23f1e3811a91aed3cc951cc0',
              'to': '0x8e973ce1a6884e28ad3e377d5f670bc0b463f4ea',
              'blockNumber': '0x39767fc', 'nonce': '0xe'} selector 0x819868cb
block 60254204 ts 1789129402 2026-09-11 12:23:22 UTC
```

**Block is 60,254,204, not 60,320,764.** The timestamp and the ~7-day lead time to book close are right.
Nonce on that tx was 14.

### C2 — "option types created at blocks 60,254,094–60,254,180" is NVDA-only

Across all 50 `NewOptionType` logs the block range is **60,254,094 → 60,943,752**. The pool-priced
markets were created months of blocks later. As written the sentence implies the whole universe was
created in an 86-block window; it was not.

### C3 — the "65-byte garbage → 401" probe is not reproducible; the API DEDUPES

I re-POSTed an **existing** open order's exact components with a 65-byte garbage signature and with a
64-byte garbage signature:

```
P4 65-byte garbage, existing components  -> HTTP 200  {"listing":{...stored record, real signature...}}
P5 64-byte garbage, existing components  -> HTTP 200  {"listing":{...stored record, real signature...}}
```

The API is **idempotent by orderHash**: a POST whose components hash to a stored order returns 200 with
the stored listing and never looks at the submitted signature. This resolves their unresolved item
*"whether POST /api/orders rate-limits or dedupes"* → **it dedupes**. No rate limiting observed across
~20 probes in ~12 minutes.

Check order is: signature-format (400) → dedupe (200) → cycle membership (422) → signature recovery (401).

### C4 — a listings-API gate the report never found: HTTP 422, and it is NVDA-only today

With a **fresh salt** (new orderHash, so no dedupe), POSTs are rejected on market:

```
d_cashcat   {"error":"This strike is not in the current cycle."} <HTTP 422>
d_cashcat2  {"error":"This strike is not in the current cycle."} <HTTP 422>
d_nvda226   {"error":"Invalid signature."}                       <HTTP 401>
d_nvda246   {"error":"Invalid signature."}                       <HTTP 401>
TSLA        {"error":"This strike is not in the current cycle."} <HTTP 422>
SPY         {"error":"This strike is not in the current cycle."} <HTTP 422>
JUGGERNAUT  {"error":"This strike is not in the current cycle."} <HTTP 422>
PONS        {"error":"This strike is not in the current cycle."} <HTTP 422>
AI          {"error":"This strike is not in the current cycle."} <HTTP 422>
```

Every one of those rejected optionIds is `registry.isApproved(optionId) == true` on chain with
`cycleOf == cycleNumber` and `exerciseTimestamp == 1789761600` — I verified CASHCAT's directly
(`isApproved -> 0x…01`, and the id is literally `cycle().optionIds[0]` on the CASHCAT registry). TSLA
was retried at a realistic 4.00 USDG premium to rule out a price-band confound: still 422.

Consequences for the build:
- **`registry.isApproved()` being true does NOT predict that Overcall will accept the listing.** The
  keeper needs to treat 422 as a distinct, non-retryable "Overcall does not list this market" state,
  separate from a 401/400.
- Today only **NVDA** is listable through the API. That is fine for an NVDA vault, but it means the
  report's implication that any of the 10 live markets could be listed is wrong, and it is a second
  single point of dependency for launch week (if Overcall's server-side cycle table lags a `setCycle`,
  our listing 422s even though the chain says the strike is approved).

### C5 — the EIP-1271 launch blocker is over-stated (and the ask should be reworded)

What I actually proved server-side is a **signature-length gate**, not an EIP-1271 gate:

```
200-byte sig, existing components   -> 400 {"error":"Not a valid signature. (at signature)"}
100-byte sig, existing components   -> 400 {"error":"Not a valid signature. (at signature)"}
200-byte sig, contract offerer, NVDA-> 400 {"error":"Not a valid signature. (at signature)"}
```

But a **contract** offerer with a 65-byte blob passes the format gate *and* the cycle gate:

```
C1 offerer 0xcA11bde05977b3631167028862bE2a173976CA11 (a CONTRACT), NVDA 246, 65-byte blob
   -> 401 {"error":"Invalid signature."}
C3 offerer 0x00000000219ab540356cBB839Cbe05303d7705Fa (unknown EOA), NVDA 246, 65-byte blob
   -> 401 {"error":"Invalid signature."}
```

So the accurate statement is: **Overcall's API rejects any signature that is not exactly 64 or 65 bytes.**
An ERC-1271 signature is not *inherently* longer than 65 bytes — a contract can implement
`isValidSignature` over a 65-byte payload. Whether Overcall's validator uses `ecrecover` (which excludes
every contract offerer regardless of blob length) or ERC-1271 / `Seaport.getOrderStatus` is **UNRESOLVED**:
a garbage 65-byte blob fails both, so C1 does not discriminate.

Also note the report quotes the zod source
`z.string().regex(/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/, "Not a valid signature.")` as if read from
the bundle. I downloaded all 11 chunks the homepage loads plus the docs route's extra chunks and
`grep`'d for `conduitKey`, `orderType` and `fA-F` — **the order-building and signature-validation code is
not in any client chunk I could fetch.** The behaviour is confirmed server-side by my probes; the quoted
regex literal is not independently sourced. Treat it as inferred, not quoted.

Rewrite the launch-week ask as: *"does your `/api/orders` signature validator call ERC-1271 /
`Seaport.getOrderStatus`, or only `ecrecover`? If only `ecrecover`, we need contract offerers supported."*
Their options (a)/(b)/(c) and the recommendation stand.

The **unknown-maker** half of their finding is fully confirmed: an arbitrary EOA and an arbitrary
contract both cleared every structural check with no auth, no key, no registration. **No handshake exists.**

### C6 — testnet (R7) is materially misleading; do not plan M3/M6 against it as written

Everything below is from `eth_call` on `https://rpc.testnet.chain.robinhood.com/rpc`
(`eth_chainId -> 0xb626`).

**C6a — the cycle they cite is EXPIRED.** Report: *"currently on cycle 2 with 5 option ids … Usable for
M3/M6 dry-runs."*

```
REG 0xdFA1cab9…4A56  cycleCount=2  cycleNumber=2
  isCycleLive()     0  (false)
  isWritingOpen()   0  (false)
  canReplaceCycle() 1  (true)
  cycle: num 2 ets 1789000655 = 2026-09-10 00:37:35 UTC
                xts 1789087055 = 2026-09-11 00:37:35 UTC   lot 1e18  nIds 5
```
Both timestamps are in the past. `rollOpen` against this registry reverts today. Overcall must set
cycle 3, or M3/M6 runs against our own `MockRegistry` / a registry we deploy.

**C6b — there are ten testnet registries, not one, and Overcall's own docs point at the wrong one.**
`addresses[46630].registries` in the bundle:
`AAPL 0x36d7B6Ec…e5e1, AMZN 0x43a93af1…30fB, CATTEST 0x2FBD07F3…d16F, GME 0x9A92fE42…d422,
MEME 0xb294bA60…aaD3, NVDA 0xdFA1cab9…4A56, PLTR 0x5125D5A8…A029, SPCX 0x059961bb…54BD,
SPY 0xE387985c…C6Ca, TSLA 0x904a1D63…C359`; singleton `registry: 0x2FBD07F3…d16F` (CATTEST).

`https://overcall.finance/docs/protocol/contracts` lists the testnet registry as
**`0x904a1D63a49c87aFbCe3F05F6079c4Eb9c85C359`** — which is the **TSLA** registry, and is a
**different, older build**:

```
docs registry 0x904a1D63…C359  code = 5778 bytes   (mainnet/bundle build is 5905)
  collateralToken()  0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e   (testnet TSLA, NOT the mock)
  exerciseToken()    0xe3b032b565d494a994772aeff9919cc9ac574bef
  cycleCount()       1        isCycleLive() 1        canReplaceCycle() 0
  isWritingOpen()    REVERT   <-- function does not exist in this build
  writeDeadline()    REVERT   <-- function does not exist in this build
  MAX_STRIKES() 5   MIN_EXERCISE_WINDOW() 86400   lotSize 1e18
  cycle: num 1 ets 1789156800 = 2026-09-11 20:00 UTC  xts 1789243200 = 2026-09-12 20:00 UTC
```
It is the only testnet registry with a live cycle right now — and it is exactly the one whose ABI would
silently break `AdapterValorem`'s `isWritingOpen()` / `writeDeadline()` gates. The docs also assert
*"its immutable collateral token is the mock"*, which its own `collateralToken()` refutes. **The docs'
testnet section is stale. Use the bundle, not the docs page, for 46630.**

**C6c — the bundle's testnet NVDA registry IS the right target and IS ABI-identical to mainnet.**
Byte-diff mainnet `0x8E973cE1…f4EA` vs testnet `0xdFA1cab9…4A56`: both 5905 bytes, 200 differing bytes
in exactly 10 × 20-byte immutable runs (`exerciseToken` ×3, `clearinghouse` ×4, `collateralToken` ×3),
trailing metadata CBOR **identical**. Same compilation unit. Good for M3/M6 once a cycle is live.

**C6d — addresses M3/M6 needs that the report never gave:**

| name | address (46630) | code |
|---|---|---|
| testnet NVDA mock (registry's `collateralToken`) | `0x40ab39E8E1D626fa506CCDF917697975a102D1D7` | 3778 |
| testnet USDG mock (`exerciseToken`) | `0xe3B032b565d494A994772AEFF9919CC9AC574bEF` | 1862 |
| testnet TokenURIGenerator | `0x878Acc151a297e1c82E0eD87826968e6fBF0f606` | 9901 |
| MockSequencerUptimeFeed | `0x86301F34D3F29805A6784FB20A5B36374814A040` | 1156 |
| MockAggregatorV3 (NVDA feed) | `0xcac7742b5542F155efCbD1dfA3F2DFda8dE90CB5` | (bundle `NVDA_FEED`) |
| docs' `MockStockToken` (a *different* mock instance, unused by the NVDA registry) | `0x7731D8D6765f73E9FAbE989e3222B7D635c9F3F5` | 3778 |

**C6e — testnet DOES have a sequencer uptime feed** (`0x86301F34…A040`, 1156 bytes); mainnet's slot is
zero. Whatever gate we write must be chain-conditional, not compiled out.

**C6f — `0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82` is now confirmed**, not "confirmed: false".
`clearinghouse.feeTo()` on 46630 returns it, `registry.owner()` on 46630 returns it, and
`eth_getCode = 0` (EOA). The "throwaway key, never set as mainnet fee recipient" warning stands.

### C7 — `claim().amountWritten` is 1e18-scaled; the event `amount` is not

Their unresolved note says *"Read `claim(claimId).amountWritten` for the true figure"* without flagging
the scale:

```
claim(optionId246 | 1) -> amountWritten = 1000000000000000000   (1e18)
OptionsWritten log      -> amount       = 1                      (contracts)
```
An adapter that compares `claim().amountWritten` to `contractsWritten` directly is wrong by 1e18.
`nextClaimKey - 1` (their `contractsWritten_inferred`) counts **claims**, which is what they said —
but the corrective they recommend needs the `/1e18` on top. Put this in `AdapterValorem`'s comments.

### C8 — feed staleness is a live tripwire and was not flagged

Overcall's own contracts page: *"The RHNVDA/USD feed has 8 decimals, a 0.5 % deviation threshold and an
**86,400 s heartbeat**, and it holds the last price outside market hours. Its answer already has the
ERC-8056 multiplier applied — never re-apply it."*

Measured at head ts 1789238387:
```
NVDA_FEED description "RHNVDA / USD" decimals 8 answer 21829793457 updatedAt 1789157023
  -> age 81,364 s = 22.60 h   (heartbeat 86,400 s — ~84 minutes of margin left)
USDG_FEED description "USDG / USD"  decimals 8 answer 99995060   updatedAt 1789227205  -> age 11,182 s
```
plan.md §4.4 gates `rollOpen` on *"spot = feed.latestRoundData() (heartbeat fresh)"*. On a weekend or a
market holiday the NVDA feed sits within minutes of its heartbeat, so a naive "fresh within 1h" check
bricks `rollOpen` and a naive "fresh within heartbeat" check can pass on a 23-hour-old print. Pick the
staleness bound deliberately and document it; the feed is a gate only, never a fund path.

---

## 3. Unresolved items I could resolve

| Their unresolved | Resolution |
|---|---|
| `uiMultiplier()` / ERC-8056 and `oraclePaused()` (R5/R6) | `uiMultiplier()` selector `0xa60bf13d` → `0x0de377b4760af643` = **1000775159164630595** (≈1.000775e18) on NVDA. `oraclePaused()` selector `0x7706ba52` → **false**. `paused()` `0x5c975abb` → **false**. `isBlocked(address)` on the **token** reverts — the blocklist lives on the beacon, as the report said. All three selectors are in the shared implementation's dispatcher (`a60bf13d`, `7706ba52`, `5c975abb`, `fbac3951`). |
| `realisedPremium6` semantics | Second data point: the live **open** order has `totalPrice6 "1050000"` but `realisedPremium6 "0"` with `filledNumerator 0`. So it is the realised, post-fee amount accrued from fills, not a quote or a gross. Their reading was right. |
| Whether POST rate-limits or dedupes | **Dedupes by orderHash**, returns HTTP 200 with the stored listing (see C3). No rate limit observed over ~20 probes / ~12 min. |
| No public Overcall repo | Corroborated from the site itself: `links:{docs:"/docs",engine:"https://github.com/valorem-labs-inc/clear",terms:"/terms",risk:"/risk",x:"https://x.com/overcallfi"}`. The only code link is **upstream Valorem**, not an Overcall repo. |
| How pool-priced markets get their rungs | Bundle carries `addresses[4663].pools`: each of CASHCAT / PONS / AI / JUGGERNAUT maps to a Uniswap V3 pool with `quote: 0x0Bd7D308…AD73` (WETH), `quoteFeed: 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, `twapSeconds: 1800`. That is the ~2% relative rung source. **The NVDA anchor is still unresolved** — one cycle of data. |
| Other explorers | `robinscan.io`, `hoodscan.co`, `stonkscan.io` all return HTTP 200 at the root. Not probed further — Sourcify answers everything we need, and Blockscout `/api` is 403 (confirmed). |

---

## 4. UNRESOLVED after this pass

1. **Does Overcall's `/api/orders` validator call ERC-1271, or only `ecrecover`?** A 65-byte blob from a
   contract offerer clears the format and cycle gates and dies at 401 — which is consistent with both.
   Only Overcall can answer, or a real 1271-signed 65-byte order from a deployed vault could. This is
   still the top escalation, reworded per C5.
2. **Why the listings API 422s every market except NVDA** (C4), and whether that gate is a server-side
   cycle cache (so it lags `setCycle`) or an explicit market allowlist. If it is a cache, launch week has
   a race: the chain says approved, the API says 422.
3. **The NVDA strike anchor.** Flat 5.00 USDG rungs on one cycle. Whether the anchor is spot-at-`setCycle`,
   a round number, or discretionary is undecidable from `cycleCount() == 1`. Re-measure at cycle 2.
4. **Whether the cadence is weekly.** Still exactly one mainnet cycle in history. Bind the keeper to
   `cycleNumber()` / `cycle()`, never to a wall clock. (Unchanged from their report — correct as stated.)
5. **When Overcall will set testnet cycle 3** on `0xdFA1cab9…4A56` (C6a). Until then M3/M6 has no live
   testnet registry with the mainnet ABI.
6. **The exact zod schema text.** The order-building and signature-validation code is in no client chunk
   I could fetch; the regex literal in the report above is inferred from server responses, not quoted
   from source. The *behaviour* (64/65 bytes only) is confirmed.
7. **Whether `0x904a1D63…C359`'s 5778-byte build exists anywhere on mainnet.** All 11 mainnet registries
   are 5905, so no — but if Overcall redeploys a registry mid-life, size is the cheap tell. Pin the
   registry build by runtime-hash in `ops/addresses.json` and have the keeper assert it.

