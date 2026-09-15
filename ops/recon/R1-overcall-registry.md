# R1 — OvercallRegistry (NVDA) address + ABI

**Status: RESOLVED.** The registry exists, is deployed, is fully verified, and is live with cycle 1.
Confidence: high — verified source + constructor args + live `eth_call` on two independent RPCs.

Recon date: 2026-09-12. Chain head at time of recon: 61,309,646.

---

## 1. Answer

| Field | Value |
|---|---|
| **OvercallRegistry (NVDA), chain 4663** | **`0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`** |
| Contract name (verified) | `OvercallRegistry`, `src/OvercallRegistry.sol` |
| Verified | yes — fully verified, **not a proxy** (`proxy_type: null`, `is_changed_bytecode: false`) |
| Compiler | `0.8.28+commit.7893614a`, optimizer on, 200 runs, evm `cancun` |
| Deployed bytecode | 5,905 bytes |
| Creation tx | `0xadb99c49fca5f5d3c7a8dd6b8f2a6edaff1d9204aaf9ce1d38b959822dfba9e9` |
| Deploy block / time | **59,378,796** — 2026-09-10 11:47:22 UTC |
| Deployer / owner | `0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` (EOA, 0 bytes of code) |
| Verified on Blockscout at | 2026-09-11T12:25:05Z (also via eth_bytecode_db + verifier-alliance) |
| **Testnet 46630 NVDA registry** | **`0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56`** (exists — answers R7) |

ABI saved to `ops/abis/OvercallRegistry.json` (53 entries).
Full verified source saved to `ops/abis/OvercallRegistry.sol`, plus `ops/abis/IOvercallRegistry.sol` and `ops/abis/IValoremClear.sol`.

### Constructor args (decoded by Blockscout, matches live getters)

```
initialOwner      0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0
clearinghouse_    0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0   <- Valorem Clear
collateralToken_  0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC   <- NVDA Stock Token
exerciseToken_    0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168   <- USDG
initialLotSize    1000000000000000000                          <- 1e18 = 1.0 token
```

All four addresses are `immutable`. They cannot be changed after deploy.

---

## 2. How it was found

Overcall's frontend ships its address book in a JS chunk. Fetched `https://overcall.finance`, pulled the
`<script src>` list, downloaded all 11 `_next/static/chunks/*.js`, and grepped for 40-hex addresses.
Chunk `13i994ge4sv4e.js` (28,378 bytes) holds a per-chainId config object keyed `4663` and `46630`:

```js
let t={4663:{ ... ,registries:{AAPL:"0xB500929deb0100598D9A1392113a6F6D2A31C018",AI:"0xD1d56916f6E945F59C6E226A7429Da688532a113",
AMZN:"0x195dcf905Ad9fDda76E492016E680B2D0F9F0877",CASHCAT:"0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1",
GME:"0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335",JUGGERNAUT:"0x65dD407955912Be814f723724cE60f91ebd72616",
NVDA:"0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA",PONS:"0x365B4D099768F6B2fF07200e7d5AA14D899c1897",
SPCX:"0x915148f98C0450251261654ffb6B54BA7005efFF",SPY:"0x6369CeCe2de602Ce1911039C123dc97E816715A9",
TSLA:"0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1"},
registry:"0x65dD407955912Be814f723724cE60f91ebd72616",registryOwner:"0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0",
rpc:"https://rpc.mainnet.chain.robinhood.com",seaport:"0x0000000000000068F116a894984e2DB1123eB395",
tokenURIGenerator:"0xE53cCB924d27f421a91b59087587fD866C5d64c7",valoremDeployedAt:0x6aa298a9}
```

> **Trap avoided:** the top-level key `registry:` on chain 4663 is `0x65dD4079...` — that is the
> **JUGGERNAUT** market, not NVDA. It is only a default. The NVDA registry must be read from
> `registries.NVDA`. The frontend resolves it with `addresses[chainId].registries[symbol]`, falling back
> to `addresses[chainId].registry` / `NEXT_PUBLIC_REGISTRY_ADDRESS`. Do not wire `registry` into the vault.

Verified source was then pulled from Blockscout. **Note:** `robinhoodchain.blockscout.com` sits behind a
Cloudflare challenge and returns HTTP 403 to plain `curl` *and* to WebFetch. The firecrawl CLI gets through:

```
firecrawl scrape "https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA" --format rawHtml -o reg_src.json
```

---

## 3. The real ABI — and the spec repair it forces

### `cycle()` has NO status field

TECHSPEC §4.2/§4.4 and plan.md §9 assume:

```
registry.cycle() -> {optionIds[], exerciseTimestamp, expiryTimestamp, status}
```

The deployed contract returns **no `status`**, and there is **no status enum anywhere in the ABI**.
The actual struct, from the verified `IOvercallRegistry.sol`:

```solidity
struct Cycle {
    uint32    number;             // 1-based cycle counter; 0 before any cycle has been set
    uint40    exerciseTimestamp;  // when every option of the cycle becomes exercisable
    uint40    expiryTimestamp;    // when every option of the cycle expires
    uint96    lotSize;            // the lot size THIS cycle was validated against, 18-dec
    uint256[] optionIds;          // approved Valorem option ids, ORDERED BY ASCENDING STRIKE
}
```

ABI tuple type: `cycle() view returns ((uint32,uint40,uint40,uint96,uint256[]))`

**Status is instead three separate view helpers.** Verbatim from the verified source:

```solidity
function isCycleLive() public view returns (bool) {
    return block.timestamp < expiryTimestamp;
}

function writeDeadline() public view returns (uint40) {
    return exerciseTimestamp;            // deliberately the same instant, separately named
}

function isWritingOpen() external view returns (bool) {
    return cycleNumber != 0 && block.timestamp < writeDeadline();
}

function canReplaceCycle() public view returns (bool) {
    if (cycleNumber == 0) return true;
    if (block.timestamp >= expiryTimestamp) return true;
    IValoremClear clear = IValoremClear(clearinghouse);
    uint256[] memory ids = _activeOptionIds;
    for (uint256 i = 0; i < ids.length; ++i) {
        if (clear.option(ids[i]).nextClaimKey != 1) return false;
    }
    return true;
}
```

**Required edits:**
- `IOvercallRegistry` in the vault: drop `status`, add `lotSize` and `number` to the struct.
- Keeper trigger `cycle.status == Open` (plan §5.1, TECHSPEC §5) becomes **`registry.isWritingOpen()`**.
- The `Idle → Listed` gate becomes `isWritingOpen()`; `Exercisable` is `block.timestamp >= exerciseTimestamp`;
  `Settling` is `block.timestamp >= expiryTimestamp` (equivalently `!isCycleLive()`).

### Full function surface (53 ABI entries)

| Signature | Mutability | Returns | Selector |
|---|---|---|---|
| `cycle()` | view | `(uint32,uint40,uint40,uint96,uint256[])` | `0x6190c9d5` |
| `cycleAt(uint256)` | view | `(uint32,uint40,uint40,uint96,uint256[])` | `0x53a32acd` |
| `collateralToken()` | view | `address` | `0xb2016bd4` |
| `exerciseToken()` | view | `address` | `0x2e4d8c8f` |
| `clearinghouse()` | view | `address` | `0x5d4f5f97` |
| `activeOptionIds()` | view | `uint256[]` | `0xb1e4ff8b` |
| `isApproved(uint256)` | view | `bool` | `0x7910867b` |
| `cycleOf(uint256)` | view | `uint32` | `0x356944c4` |
| `strikePerContract(uint256)` | view | `uint96` | `0x4645ce49` |
| `cycleNumber()` | view | `uint32` | `0x2f884710` |
| `cycleCount()` | view | `uint256` | `0x316fda0f` |
| `cycleLotSize()` | view | `uint96` | `0xefdbdcdc` |
| `lotSize()` | view | `uint96` | `0x4942f65f` |
| `exerciseTimestamp()` | view | `uint40` | `0x7d4361bf` |
| `expiryTimestamp()` | view | `uint40` | `0xade6e2aa` |
| `writeDeadline()` | view | `uint40` | `0xe136de20` |
| `isCycleLive()` | view | `bool` | `0x1e4191ea` |
| `isWritingOpen()` | view | `bool` | `0xfa85ba38` |
| `canReplaceCycle()` | view | `bool` | `0x9e9add41` |
| `MAX_STRIKES()` | view | `uint256` | `0xb8f07dea` |
| `MIN_EXERCISE_WINDOW()` | view | `uint256` | `0x04b86272` |
| `owner()` | view | `address` | `0x8da5cb5b` |
| `pendingOwner()` | view | `address` | `0xe30c3978` |
| `setCycle(uint256[],uint40,uint40)` | nonpayable onlyOwner | — | `0x819868cb` |
| `setLotSize(uint96)` | nonpayable onlyOwner | — | `0xa3ab1061` |
| `transferOwnership(address)` | nonpayable onlyOwner | — | `0xf2fde38b` |
| `acceptOwnership()` | nonpayable | — | `0x79ba5097` |
| `renounceOwnership()` | view onlyOwner | **always reverts `RenounceDisabled()`** | `0x715018a6` |

Every selector above was cross-checked against the deployed bytecode's `PUSH4` dispatch table.

**Events** (this is the complete set the indexer can listen to):
```
CycleSet(uint32 indexed number, uint256[] optionIds, uint40 exerciseAt, uint40 expireAt, uint96 lotSize)
LotSizeSet(uint96 previousLotSize, uint96 newLotSize)
OwnershipTransferStarted(address indexed, address indexed)
OwnershipTransferred(address indexed, address indexed)
```

**Errors:**
```
CycleIndexOutOfBounds(uint256,uint256)   0x6c2ab271    CycleStillLive(uint40)
EmptyCycle()                                           ExerciseAssetMismatch(uint256,address,address)
ExerciseNotInFuture(uint40,uint40)                     ExerciseTimestampMismatch(uint256,uint40,uint40)
ExerciseWindowTooShort(uint40,uint40,uint256)          ExpiryTimestampMismatch(uint256,uint40,uint40)
IdenticalAssets(address)                               LotSizeMismatch(uint256,uint96,uint96)
NotAnOptionType(uint256)                               RenounceDisabled()
StrikesNotAscending(uint256,uint96,uint96)             TooManyStrikes(uint256,uint256)
UnderlyingAssetMismatch(uint256,address,address)       ZeroAddress()
ZeroLotSize()                                          ZeroStrike(uint256)
OwnableInvalidOwner(address)                           OwnableUnauthorizedAccount(address)
```

Constants: `MAX_STRIKES = 5` (hard ceiling, a 6th id reverts), `MIN_EXERCISE_WINDOW = 1 days`.

---

## 4. Live state — confirmed by eth_call

All values below read at chain head ~61,309,646 on 2026-09-12, and re-read identically on
`https://robinhood-rpc.publicnode.com` (second independent RPC).

```
function                  selector    decoded
MAX_STRIKES()             0xb8f07dea  5
MIN_EXERCISE_WINDOW()     0x04b86272  86400 s (1.0 days)
clearinghouse()           0x5d4f5f97  0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0
collateralToken()         0xb2016bd4  0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec
exerciseToken()           0x2e4d8c8f  0x5fc5360d0400a0fd4f2af552add042d716f1d168
cycleNumber()             0x2f884710  1
cycleCount()              0x316fda0f  1
cycleLotSize()            0xefdbdcdc  1000000000000000000 (1.0 tokens)
lotSize()                 0x4942f65f  1000000000000000000 (1.0 tokens)
exerciseTimestamp()       0x7d4361bf  2026-09-18 20:00:00 UTC (Fri)
expiryTimestamp()         0xade6e2aa  2026-09-19 20:00:00 UTC (Sat)
writeDeadline()           0xe136de20  2026-09-18 20:00:00 UTC (Fri)
isCycleLive()             0x1e4191ea  True
isWritingOpen()           0xfa85ba38  True
canReplaceCycle()         0x9e9add41  False
owner()                   0x8da5cb5b  0x408adcffebdf48ec23f1e3811a91aed3cc951cc0
pendingOwner()            0xe30c3978  0x0000000000000000000000000000000000000000
```

### Assertions the vault needs — both PASS

```
registry.collateralToken() == 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC  == NVDA Stock Token   PASS
registry.exerciseToken()   == 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  == USDG               PASS
registry.clearinghouse()   == 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0  == Valorem Clear      PASS
```

Raw evidence:
```
$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA","data":"0xb2016bd4"},"latest"],"id":1}' \
  https://rpc.mainnet.chain.robinhood.com
{"jsonrpc":"2.0","id":1,"result":"0x000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec"}

  data:0x2e4d8c8f ->
{"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168"}
```

### Current cycle contents — `cycle()` raw + decode

```
$ ... data:"0x6190c9d5" ...
0x0000000000000000000000000000000000000000000000000000000000000020   head offset 0x20
  0000000000000000000000000000000000000000000000000000000000000001   number            = 1
  000000000000000000000000000000000000000000000000000000006aad9840   exerciseTimestamp = 1789761600
  000000000000000000000000000000000000000000000000000000006aaee9c0   expiryTimestamp   = 1789848000
  0000000000000000000000000000000000000000000000000de0b6b3a7640000   lotSize           = 1e18
  00000000000000000000000000000000000000000000000000000000000000a0   offset -> optionIds
  0000000000000000000000000000000000000000000000000000000000000005   optionIds.length  = 5
  f9e23d199282d4611ff78a93abe9f31de2d43398000000000000000000000000
  418ec5b78ab6c828d23ac4e50f484b1a5aeede6c000000000000000000000000
  1edae6ecfc36b8d725f077beee6b957adf180dbf000000000000000000000000
  11b72829420ee3bd0b8591c69e90504118dc11c9000000000000000000000000
  7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
```

`exerciseTimestamp` 1789761600 = **Fri 2026-09-18 20:00:00 UTC**
`expiryTimestamp`   1789848000 = **Sat 2026-09-19 20:00:00 UTC**

This confirms TECHSPEC §5's stated window (book close Friday 20:00 UTC, expiry Saturday 20:00 UTC) exactly,
and the exercise window is exactly `MIN_EXERCISE_WINDOW` = 24h.

### The strike ladder (cycle 1)

Cross-checked two ways: `registry.strikePerContract(id)` and `ValoremClear.option(id).exerciseAmount`. Agree.

| rung | optionId | strike (USDG, 6-dec) | underlying/contract | isApproved | cycleOf |
|---|---|---|---|---|---|
| 0 | `0xf9e23d199282d4611ff78a93abe9f31de2d43398000000000000000000000000` | 226.00 | 1.0000 NVDA | true | 1 |
| 1 | `0x418ec5b78ab6c828d23ac4e50f484b1a5aeede6c000000000000000000000000` | 231.00 | 1.0000 NVDA | true | 1 |
| 2 | `0x1edae6ecfc36b8d725f077beee6b957adf180dbf000000000000000000000000` | 236.00 | 1.0000 NVDA | true | 1 |
| 3 | `0x11b72829420ee3bd0b8591c69e90504118dc11c9000000000000000000000000` | 241.00 | 1.0000 NVDA | true | 1 |
| 4 | `0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000` | 246.00 | 1.0000 NVDA | true | 1 |

Five rungs, $5.00 apart, strictly ascending — enforced on-chain by `StrikesNotAscending`.
Option id encoding: **upper 160 bits = option-type key, lower 96 bits = claim index (0 for the type itself)**.

`ValoremClear.option(0xf9e2...)` full decode, confirming the registry's claims are the clearinghouse's truth:
```
[0] underlyingAsset   0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec  NVDA
[1] underlyingAmount  0x0de0b6b3a7640000                          1e18 = 1.0 NVDA
[2] exerciseAsset     0x5fc5360d0400a0fd4f2af552add042d716f1d168  USDG
[3] exerciseAmount    0x0d787c80                                  226000000 = 226.00 USDG
[4] exerciseTimestamp 0x6aad9840                                  2026-09-18 20:00 UTC
[5] expiryTimestamp   0x6aaee9c0                                  2026-09-19 20:00 UTC
[6] (key)             0xf9e23d199282d4611ff78a93abe9f31de2d43398
[7] nextClaimKey      1
```

Sanity check on `isApproved`: a non-cycle id returns false —
`isApproved(0x00..00) = false`, `cycleOf(0x00..00) = 0`. Good, no default-true.

`cycleAt(0)` returns cycle 1 (history is 0-indexed, cycle numbers are 1-based).
`cycleAt(1)` reverts `CycleIndexOutOfBounds(1,1)` (`0x6c2ab271`).

---

## 5. Every Overcall registry on both chains (all eth_getCode confirmed)

One registry per collateral token, exactly as TECHSPEC §2 guessed. All 11 mainnet registries share the
same 5,905-byte bytecode and all use USDG as `exerciseToken`.

### Mainnet 4663

| market | registry | bytes | collateralToken | exerciseToken | cycleNumber | isWritingOpen |
|---|---|---|---|---|---|---|
| AAPL | `0xB500929deb0100598D9A1392113a6F6D2A31C018` | 5905 | `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9` | USDG | 1 | true |
| **NVDA** | **`0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`** | 5905 | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | USDG | 1 | true |
| TSLA | `0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1` | 5905 | `0x322f0929c4625ed5bad873c95208d54e1c003b2d` | USDG | 1 | true |
| SPY | `0x6369CeCe2de602Ce1911039C123dc97E816715A9` | 5905 | `0x117cc2133c37b721f49de2a7a74833232b3b4c0c` | USDG | 1 | true |
| GME | `0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335` | 5905 | `0x1b0e319c6a659f002271b69db8a7df2f911c153e` | USDG | **0** | **false** |
| AMZN | `0x195dcf905Ad9fDda76E492016E680B2D0F9F0877` | 5905 | `0x12f190a9f9d7d37a250758b26824b97ce941bf54` | USDG | 1 | true |
| AI | `0xD1d56916f6E945F59C6E226A7429Da688532a113` | 5905 | `0x2e8c31162b855a2ffa90f6f8634643ad6f111e18` | USDG | 1 | true |
| CASHCAT | `0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1` | 5905 | `0x020bfc650a365f8bb26819deaabf3e21291018b4` | USDG | 1 | true |
| JUGGERNAUT | `0x65dD407955912Be814f723724cE60f91ebd72616` | 5905 | `0xd7321801caae694090694ff55a9323139f043b88` | USDG | 1 | true |
| PONS | `0x365B4D099768F6B2fF07200e7d5AA14D899c1897` | 5905 | `0x39dbed3a2bd333467115de45665cc57f813c4571` | USDG | 1 | true |
| SPCX | `0x915148f98C0450251261654ffb6B54BA7005efFF` | 5905 | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` | USDG | 1 | true |

Each `collateralToken` matches that ticker's Stock Token in the same config object — so the
per-market mapping is self-consistent on-chain. GME is deployed but has never had a cycle set
(`cycleNumber == 0`) — proof that `cycleNumber == 0` is a real, reachable "no cycle yet" state
the vault must handle.

### Testnet 46630 — R7 ANSWERED: YES, the registry exists on testnet

`eth_chainId` -> `0xb626` (46630). NVDA registry `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56`, 5,905 bytes
(identical implementation).

```
collateralToken()   0x40ab39e8e1d626fa506ccdf917697975a102d1d7   (testnet NVDA)
exerciseToken()     0xe3b032b565d494a994772aeff9919cc9ac574bef   (testnet USDG)
clearinghouse()     0x0059df7c6229373a5afc0685b0ee8777f59bacbc   (testnet Valorem Clear)
owner()             0xf73b2cb96ae0bbe1a3ec3446f4c36d82caaaab82
cycleNumber()       2
cycleCount()        2
lotSize()           1e18
exerciseTimestamp() 1789000655   2026-09-09 09:57:35 UTC
expiryTimestamp()   1789087055   2026-09-10 09:57:35 UTC
isCycleLive()       false        <- testnet cycle 2 has already EXPIRED
isWritingOpen()     false
```

Testnet cycle 2 optionIds (5 rungs, expired — a fresh `setCycle` is needed before a dry run):
```
0xe1075b96018a1d52180c3224bd1931d90fcf10b3000000000000000000000000
0xf256407742c256338f3a0081b4cfe5fe549832aa000000000000000000000000
0x4c4fbc23d89c384ae6a287f7f01f740996a7b6ee000000000000000000000000
0xe3db0f18ad27a4c5184cec0e563bd6e863e7d335000000000000000000000000
0xa001cc504f22c6db2f2d273144447312815aa3bd000000000000000000000000
```

Other testnet 46630 registries from the same config: AAPL `0x36d7B6Ec2e9bC3c1858684d285718a410B59e5e1`,
AMZN `0x43a93af1a602EE47c0FB4493fFE54C8Fd01830fB`, CATTEST `0x2FBD07F3936fBBcE64b9D42F9922aB08c54ad16F`,
GME `0x9A92fE428a27B955A07dCDdD78504715ed3fd422`, MEME `0xb294bA60c8e860e905394bD4c011947AC8b8aaD3`,
PLTR `0x5125D5A853533693f8309C8C15a69321F8aDA029`, SPCX `0x059961bba30A95D3c96E2C406e71095f77D054BD`,
SPY `0xE387985cf80f3cE41f07F90Bd571Bd8F682bC6Ca`, TSLA `0x904a1D63a49c87aFbCe3F05F6079c4Eb9c85C359`.
(Only the NVDA one was eth_call-verified; the rest are from the frontend config and are unverified.)

---

## 6. Design facts that change the build

### 6.1 The registry is deliberately inert — it is NOT in the fund path

From the contract's own NatSpec (verbatim):

> This is the only contract Overcall deploys of its own, and it is deliberately inert. Valorem Clear's
> `newOptionType` is permissionless, so anyone can mint an option type on NVDA with any strike or any
> expiry; this registry is how the front end tells the five types ops created from every look-alike.
> It records; it does not compute and it does not settle.
>
> What it categorically is not, per V2 §10:
>  - not a router — users call the clearinghouse themselves, stay the writer, and keep their own Claim NFT;
>  - not a custodian — no `payable`, no `receive`, no `fallback`, and not one `transfer`, `transferFrom`,
>    `approve` or `safeTransferFrom` in the whole file

So the vault writes directly to Valorem Clear and keeps its own Claim NFT. That matches the TECHSPEC
architecture already. No approval is ever granted to the registry.

### 6.2 Use `isApproved(optionId)`, not membership in `cycle().optionIds`

TECHSPEC §4.4 says `optionId ∈ registry.cycle().optionIds`. The contract gives a direct O(1) getter:

```solidity
function isApproved(uint256 optionId) external view returns (bool) {
    return _cycleOf[optionId] == cycleNumber && cycleNumber != 0;
}
```

Cheaper than looping the array and already handles the `cycleNumber == 0` case (see GME above).
**Because `newOptionType` is permissionless, this check is the only thing separating a real Overcall
rung from a look-alike with the same strike and expiry.** It must be done in the same transaction as
the write, not cached from an earlier read.

### 6.3 A live cycle CAN be replaced — this is a real race for the keeper

`setCycle` is `onlyOwner` and is gated by `canReplaceCycle()`, which returns true when
**nothing has been written yet on the current ladder** (it reads `nextClaimKey == 1` on every rung
straight from Valorem). Overcall's comment calls this "never a mid-week rug of the front page."

The hazard for Stonkhouse: if our vault is the *first* writer of the week, then between the keeper's
`cycle()` read and the vault's `write()` the owner can legally swap the whole ladder. The vault would
then write against an `optionId` that is no longer approved.

Mitigation, and it is cheap: **the vault must re-check `registry.isApproved(optionId)` and
`registry.cycleNumber()` inside `rollOpen`, in the same tx as the Valorem `write()`**, and store the
`cycleNumber` it acted on. The keeper passing an `optionId` is a proposal; the vault must not trust it.

Right now `canReplaceCycle() == false` on the NVDA mainnet registry, which means at least one rung
already has `nextClaimKey != 1` — **someone has already written against cycle 1. The market is live
with real short positions.**

### 6.4 `lotSize()` vs `cycleLotSize()` — use the right one

Two distinct values, and the source is explicit about why:

- `cycleLotSize()` — the lot size **this** cycle's `optionIds` were validated against. Snapshotted at
  `setCycle`. This is what `underlyingAmount` on the live options actually equals.
- `lotSize()` — the **forward-looking** value, mutable by the owner via `setLotSize` at any time,
  including while a cycle is live. It applies to the *next* `setCycle`.

Contract sizing must divide idle NVDA by **`cycle().lotSize` / `cycleLotSize()`**, never by `lotSize()`.
Both are 1e18 today, so this bug would not show up in testing until Overcall changes the lot size.
`LotSizeSet(uint96,uint96)` is the event to watch.

### 6.5 Ordering guarantee makes the strike picker simpler

`setCycle` enforces strictly ascending strikes (`StrikesNotAscending`), which also rules out duplicates.
So `cycle().optionIds` is **already sorted by ascending strike**, and plan §5.2's
"pick = nearest OTM (eligible[0] ascending)" is valid with no client-side sort. Max 5 rungs, always.

### 6.6 Ownership

`Ownable2Step`, owner `0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` — an **EOA, not a Safe**
(`eth_getCode` = 0 bytes). `pendingOwner()` is zero. `renounceOwnership()` is overridden to always
revert `RenounceDisabled()`, so the registry can never become ownerless. Worth noting in the risk
register: a single Overcall EOA key controls the strike grid for every market. It cannot touch funds
(§6.1), but it can set the ladder the vault reads.

---

## 7. Everywhere I looked

| Source | Result |
|---|---|
| `https://overcall.finance` landing HTML | 200, Next.js; contained Valorem + Seaport + fee EOA |
| 11 `_next/static/chunks/*.js` bundles | **HIT** — `13i994ge4sv4e.js` holds the full per-chain address book |
| `eth_getCode` / `eth_call` on `rpc.mainnet.chain.robinhood.com` | **HIT** — all state confirmed |
| `robinhood-rpc.publicnode.com` (2nd RPC) | **HIT** — identical results, cross-verified |
| `rpc.testnet.chain.robinhood.com/rpc` (46630) | **HIT** — testnet registry confirmed |
| Blockscout `api/v2/smart-contracts/...` via firecrawl | **HIT** — full verified source + ABI + constructor args |
| Blockscout `api/v2/addresses/...` via firecrawl | **HIT** — creation tx, creator, deploy block |
| Blockscout via plain curl and via WebFetch | **BLOCKED** — Cloudflare challenge, HTTP 403 both ways |
| `robinscan.io` `?module=contract&action=getabi` | 404 `{"error":"not found"}` — no Etherscan-compatible API |
| `hoodscan.co` `?module=contract&action=getabi` | 403 FORBIDDEN; it exposes MCP + `/stocks-api` only |
| `hoodscan.co/project-api/overcall` | 404 `unknown project` — Overcall is not in their protocol registry |
| `stonkscan.io` `?module=contract&action=getabi` | returned the SPA HTML shell, no API |
| GitHub repo search: `overcall`, `overcall options`, `robinhood chain options` | no official Overcall org or contracts repo; only unrelated projects |

---

## 8. UNRESOLVED

1. **`docs.robinhood.com/chain` and any Overcall deployed-addresses doc page were not read.** The address
   book came from the frontend bundle and was then confirmed on-chain, which is a stronger source, so
   this is not blocking. But if Overcall publishes a canonical addresses page it should be diffed against
   §5 before deploy.
2. **No public Overcall GitHub repo found.** The verified Blockscout source is the only source of truth for
   `OvercallRegistry.sol`. There is no upstream to watch for changes. Someone should re-pull the verified
   source at deploy time and diff it against `ops/abis/OvercallRegistry.sol` committed here.
3. **The 9 non-NVDA testnet registry addresses in §5 are frontend-config only** — I eth_call-verified the
   testnet NVDA one and all 11 mainnet ones, but not the rest of testnet. Verify before using them.
4. **Whether Overcall rolls cycle 2 for NVDA on schedule is unobserved.** Only one cycle has ever been set
   on mainnet (`cycleCount() == 1`, set 2026-09-10, expiring 2026-09-19). The weekly cadence is stated in
   TECHSPEC and matches the cycle-1 timestamps exactly, but there is no on-chain history yet to prove
   Overcall actually re-sets weekly. Watch `CycleSet` on `0x8E973c...` through 2026-09-19/20 to confirm
   the roll happens and at what hour. If they do not roll, the vault has no week-2 ladder.
5. **`canReplaceCycle() == false` tells us *someone* wrote, but not who or how much.** I did not enumerate
   Valorem `OptionsWritten` logs to size the existing open interest per rung. That is R2/R4 territory and
   would also give the reference Seaport order. Useful for judging whether rungs are liquid.
6. **Which rung is currently at-the-money is unknown from this recon** — I did not read the NVDA Chainlink
   feed (`0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`, per the same config object) so I cannot say where
   226–246 sits relative to spot, i.e. whether the ladder satisfies the 3–12% OTM band. That is R5.
7. **Deploy-time re-read required.** Cycle 1 expires 2026-09-19 20:00 UTC. Every timestamp, optionId and
   strike in §4 is stale after that. The addresses in §1 and §5 are immutable and do not go stale.

---

## 9. Wiring for `ops/addresses.json`

```json
{
  "chainId": 4663,
  "overcallRegistryNVDA": "0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA",
  "overcallRegistryNVDA_confirmed": true,
  "overcallRegistryNVDA_deployBlock": 59378796,
  "overcallRegistryOwner": "0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0",
  "testnet": {
    "chainId": 46630,
    "overcallRegistryNVDA": "0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56",
    "clearinghouse": "0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc",
    "NVDA": "0x40ab39E8E1D626fa506CCDF917697975a102D1D7",
    "USDG": "0xe3B032b565d494A994772AEFF9919CC9AC574bEF"
  }
}
```

Corrected Solidity interface for the vault (`registry` is `immutable`, set in constructor):

```solidity
interface IOvercallRegistry {
    struct Cycle {
        uint32 number;
        uint40 exerciseTimestamp;
        uint40 expiryTimestamp;
        uint96 lotSize;
        uint256[] optionIds;
    }
    function cycle() external view returns (Cycle memory);
    function collateralToken() external view returns (address);
    function exerciseToken() external view returns (address);
    function clearinghouse() external view returns (address);
    function isApproved(uint256 optionId) external view returns (bool);
    function strikePerContract(uint256 optionId) external view returns (uint96);
    function isWritingOpen() external view returns (bool);
    function isCycleLive() external view returns (bool);
    function cycleNumber() external view returns (uint32);
    function cycleLotSize() external view returns (uint96);
    function exerciseTimestamp() external view returns (uint40);
    function expiryTimestamp() external view returns (uint40);
    function writeDeadline() external view returns (uint40);
}
```

Indexer start block for the registry: **59378796**.

---

# Verification pass — independent adversarial re-check (R1-overcall-registry)

Second agent, tasked with **refuting** the above. Every check below was re-run from scratch with my own
scripts in a private scratchpad (`.../scratchpad/R1verify/`), not reusing any artifact from the first pass.

**Verdict: CONFIRMED.** I could not refute any material claim. The address, the ABI, the spec repair and all
four design facts survive. Corrections below are refinements and additions, not reversals.

## What I re-ran

### 1. Bytecode, two RPCs, byte-for-byte
```
chainId A: 0x1237  B: 0x1237      block: 61313701
OvercallRegistry_NVDA    0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA RPC_A=5905 RPC_B=5905
owner_EOA                0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0 RPC_A=0    RPC_B=0
ValoremClear             0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 RPC_A=16110 RPC_B=16110
NVDA_token               0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC RPC_A=283  RPC_B=283
USDG                     0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 RPC_A=170  RPC_B=170
REG_AAPL/TSLA/SPY/GME/AMZN/JUGG                                     all 5905 on both RPCs
```
`eth_getCode` on 0x8E973c… is **identical** between `rpc.mainnet.chain.robinhood.com` and
`robinhood-rpc.publicnode.com` (`c == cb` → True). No RPC is lying.

### 2. Every claimed selector recomputed with `cast sig` and grepped in deployed runtime bytecode
All 28 claimed function selectors recomputed independently and **all 28 are present in the deployed runtime
bytecode**. No function was copied from an upstream repo without being in the deployment.
`collateralToken()=0xb2016bd4`, `exerciseToken()=0x2e4d8c8f`, `clearinghouse()=0x5d4f5f97` — all match.

### 3. Every claimed custom error proven by *live revert simulation* (not by grep)
Naive hex-substring search found only 10 of 20 error selectors in runtime bytecode, which initially looked
like fabricated ABI entries. It was a false alarm — substring search is unreliable for solc's revert codegen.
I proved them instead by actually triggering the reverts with `eth_call` + `from`:

```
setCycle from non-owner        -> 0x118cdaa7 0000…dead              OwnableUnauthorizedAccount(address)  OK
setCycle([]) from owner        -> 0x3b567e04                        EmptyCycle()                         OK
setCycle([12345])              -> 0xffbe9545 …3039                  NotAnOptionType(uint256)             OK
setCycle(6 ids)                -> 0xc078a35b …0006 …0005            TooManyStrikes(6,5)                  OK
setCycle(exercise in past)     -> 0xa8781597 …03e8 …6aa598c5        ExerciseNotInFuture(uint40,uint40)   OK
setCycle(window 100s)          -> 0x6f86b783 … …015180              ExerciseWindowTooShort(…,86400)      OK
setCycle on NVDA (live)        -> 0xa9e8558b …6aaee9c0              CycleStillLive(uint40)               OK
renounceOwnership from owner   -> 0x89051165                        RenounceDisabled()                   OK
cycleAt(99)                    -> 0x6c2ab271 …0063 …0001            CycleIndexOutOfBounds(99,1)          OK
setLotSize(0) from owner       -> 0xe0ff4270                        ZeroLotSize()                        OK
```
Every selector matches the claimed signature exactly, arguments included. The remaining errors
(`ZeroAddress`, `IdenticalAssets`, `OwnableInvalidOwner`, plus the per-option mismatch errors) are
constructor-/deeper-path-only and are present in the verified ABI.

### 4. Live state re-read on both RPCs — all `[SAME]`
```
collateralToken() 0xb2016bd4 -> 0x…d0601ce157db5bdc3162bbac2a2c8af5320d9eec   [SAME]  PASS (NVDA)
exerciseToken()   0x2e4d8c8f -> 0x…5fc5360d0400a0fd4f2af552add042d716f1d168   [SAME]  PASS (USDG)
clearinghouse()   0x5d4f5f97 -> 0x…9a7b40e5c1db1af822ef091c990b58b02c78c0c0   [SAME]  PASS (Valorem)
cycleNumber()=1  cycleCount()=1  cycleLotSize()=1e18  lotSize()=1e18
exerciseTimestamp 1789761600 Fri 2026-09-18 20:00:00 UTC
expiryTimestamp   1789848000 Sat 2026-09-19 20:00:00 UTC
writeDeadline     1789761600 Fri 2026-09-18 20:00:00 UTC   (== exerciseTimestamp, confirmed)
isCycleLive()=1  isWritingOpen()=1  canReplaceCycle()=0
MAX_STRIKES()=5  MIN_EXERCISE_WINDOW()=86400  owner()=0x408adc…  pendingOwner()=0x0
```
Exercise window = 1789848000 − 1789761600 = **86400 exactly** = `MIN_EXERCISE_WINDOW`. Confirmed.

### 5. `cycle()` struct — spec repair CONFIRMED, there is no `status`
Raw `cycle()` return decodes byte-for-byte as `(uint32 1, uint40 1789761600, uint40 1789848000,
uint96 1e18, uint256[5])`. `cycleAt(0)` returns **identical bytes** to `cycle()`.
Authoritative verified ABI entry:
```json
{"inputs":[],"name":"cycle","outputs":[{"components":[
 {"internalType":"uint32","name":"number","type":"uint32"},
 {"internalType":"uint40","name":"exerciseTimestamp","type":"uint40"},
 {"internalType":"uint40","name":"expiryTimestamp","type":"uint40"},
 {"internalType":"uint96","name":"lotSize","type":"uint96"},
 {"internalType":"uint256[]","name":"optionIds","type":"uint256[]"}],
 "internalType":"struct IOvercallRegistry.Cycle","name":"","type":"tuple"}],
 "stateMutability":"view","type":"function"}
```
Searched the whole verified ABI: **`"status"` does not appear; no `uint8`/enum type anywhere.** (A grep hit on
"enum" was a false positive — it is the substring inside `cycl`**`enum`**`ber`.) The TECHSPEC §4.2/§4.4 repair
is correct and required.

### 6. Blockscout verification metadata — independently re-fetched
Plain `curl` and WebFetch both get Cloudflare HTTP 403 (confirmed their tooling note). `firecrawl scrape
--format rawHtml` gets through. Fresh pull of `api/v2/smart-contracts/0x8E973c…`:
```
name                OvercallRegistry        is_verified             True
is_fully_verified   True                    is_partially_verified   False
compiler_version    0.8.28+commit.7893614a  evm_version             cancun
optimization_enabled True                   optimization_runs       200
proxy_type          None                    file_path               src/OvercallRegistry.sol
language            solidity                abi entries             53
decoded ctor: initialOwner 0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0
              clearinghouse_ 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
              collateralToken_ 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
              exerciseToken_ 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
              initialLotSize 1000000000000000000
```
**Every compiler/proxy/ctor claim confirmed.** I then diffed my freshly-scraped ABI against the committed
`ops/abis/OvercallRegistry.json`: `mine 53 theirs 53 IDENTICAL: True`. The committed ABI is trustworthy.

### 7. Deployment provenance — confirmed from the chain, not the explorer
```
eth_getTransactionReceipt 0xadb99c49fca5f5d3c7a8dd6b8f2a6edaff1d9204aaf9ce1d38b959822dfba9e9
  status 0x1  contractAddress 0x8e973ce1a6884e28ad3e377d5f670bc0b463f4ea
  blockNumber 59378796  from 0x408adcffebdf48ec23f1e3811a91aed3cc951cc0
  block timestamp 1789040842 = 2026-09-10 11:47:22 UTC
```
Creation tx, deploy block, deployer and timestamp all exactly as reported. Indexer start block 59378796 stands.

### 8. Frontend provenance re-derived from scratch
`https://overcall.finance/` → 11 chunks, `13i994ge4sv4e.js` present (HTTP 200, 28378 bytes). It contains:
```
4663 registries:{AAPL:"0xB500929deb0100598D9A1392113a6F6D2A31C018",AI:"0xD1d56916f6E945F59C6E226A7429Da688532a113",
 AMZN:"0x195dcf905Ad9fDda76E492016E680B2D0F9F0877",CASHCAT:"0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1",
 GME:"0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335",JUGGERNAUT:"0x65dD407955912Be814f723724cE60f91ebd72616",
 NVDA:"0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA",PONS:"0x365B4D099768F6B2fF07200e7d5AA14D899c1897",
 SPCX:"0x915148f98C0450251261654ffb6B54BA7005efFF",SPY:"0x6369CeCe2de602Ce1911039C123dc97E816715A9",
 TSLA:"0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1"}
46630 registries:{… NVDA:"0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56" …}
registry:"0x65dD407955912Be814f723724cE60f91ebd72616"   <-- JUGGERNAUT, mainnet default
registryOwner:"0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0"   (mainnet)
registryOwner:"0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82"   (testnet)
clearinghouse:"0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0" / testnet "0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc"
seaport:"0x0000000000000068F116a894984e2DB1123eB395"
```
**The JUGGERNAUT trap is real and I confirm the warning.** The top-level `registry:` key on 4663 is the
JUGGERNAUT market. Wiring it into the NVDA vault would silently point at the wrong collateral token.

### 9. Testnet 46630 — confirmed on BOTH testnet RPCs
`0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56`, chainId `0xb626` on both `rpc.testnet.chain.robinhood.com/rpc`
and `robinhood-sepolia-rpc.publicnode.com`, 5905 bytes, identical reads on both:
collateralToken `0x40ab39e8e1d626fa506ccdf917697975a102d1d7`, exerciseToken `0xe3b032b565d494a994772aeff9919cc9ac574bef`,
clearinghouse `0x0059df7c6229373a5afc0685b0ee8777f59bacbc`, cycleNumber 2, cycleCount 2, isCycleLive 0,
isWritingOpen 0, canReplaceCycle 1, expiryTimestamp 0x6aa34d4f. **R7 confirmed.**

## Corrections and additions

### C1 (ADDITION) — the 4 mainnet registries missing from the structured address list
The prose claimed 11 mainnet registries but only 7 addresses were emitted. I verified the other 4 myself
(`eth_getCode` + `eth_call`, all 5905 bytes, all exerciseToken = USDG, all owner = 0x408adc…):

| ticker | address | cycleNumber | isCycleLive | canReplaceCycle | collateralToken |
|---|---|---|---|---|---|
| AI | `0xD1d56916f6E945F59C6E226A7429Da688532a113` | 1 | 1 | 1 | `0x2e8c31162b855a2ffa90f6f8634643ad6f111e18` |
| CASHCAT | `0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1` | 1 | 1 | **0** | `0x020bfc650a365f8bb26819deaabf3e21291018b4` |
| PONS | `0x365B4D099768F6B2fF07200e7d5AA14D899c1897` | 1 | 1 | 1 | `0x39dbed3a2bd333467115de45665cc57f813c4571` |
| SPCX | `0x915148f98C0450251261654ffb6B54BA7005efFF` | 1 | 1 | 1 | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` |

All 11 now individually verified on-chain.

### C2 (STRENGTHENED) — "a live cycle can be replaced" is now proven cross-sectionally, not just from source
This was the claim I most wanted to refute. It survives, and the evidence is stronger than the original report's.
Scanning every registry at chain head:
```
tkr    cycNo cnt live writeOpen canReplace
NVDA   1     1   1    1         0
AAPL   1     1   1    1         1
TSLA   1     1   1    1         1
SPY    1     1   1    1         1
AMZN   1     1   1    1         1
JUGG   1     1   1    1         1
AI/PONS/SPCX  1  1    1         1
CASHCAT 1    1   1    1         0
GME    0     0   0    0         1
```
**Eight registries right now have a LIVE cycle and `canReplaceCycle() == 1`.** The gate is therefore not
time-based, and the owner can legally swap a live ladder. Design fact #2 is confirmed: the keeper's read is a
proposal, and `rollOpen` must re-check `isApproved(optionId)` + `cycleNumber()` atomically in the same tx.

Verified source (fetched by me) is exactly as described:
```solidity
function canReplaceCycle() public view returns (bool) {
    if (cycleNumber == 0) return true;
    if (block.timestamp >= expiryTimestamp) return true;
    IValoremClear clear = IValoremClear(clearinghouse);
    uint256[] memory ids = _activeOptionIds;
    for (uint256 i = 0; i < ids.length; ++i) {
        if (clear.option(ids[i]).nextClaimKey != 1) return false;
    }
    return true;
}
```
(It reads `nextClaimKey` through Valorem's `option(uint256)` = `0x6448be8c`, which is why that selector — and
not a standalone `nextClaimKey()` — appears in the registry bytecode.)

### C3 (REFINED) — "someone has written against cycle 1" is true, but it is exactly ONE rung
The original said `canReplaceCycle()==false` proves writes exist. Correct. I pinned down which.
Per-rung `ValoremClear.option()` decode plus `tokenType(optionKey|1)`:

| rung | strike | underlyingAmount | nextClaimKey | tokenType(key\|1) |
|---|---|---|---|---|
| 0 | 226.0 | 1.0 NVDA | 1 | 0 (none) |
| 1 | 231.0 | 1.0 NVDA | 1 | 0 |
| 2 | 236.0 | 1.0 NVDA | 1 | 0 |
| 3 | 241.0 | 1.0 NVDA | 1 | 0 |
| 4 | **246.0** | 1.0 NVDA | **2** | **2 (Claim)** |

**Only the 246 rung has been written — a single claim.** Four of the five rungs are untouched. Also
`CASHCAT` is in the same state, so NVDA is not unique. Full option decode confirms the rest of the table:
underlyingAsset = NVDA, exerciseAsset = USDG, exerciseAmount 226e6…246e6 (USDG is 6-decimal),
exerciseTimestamp 1789761600, expiryTimestamp 1789848000 on every rung. `strikePerContract()` agrees with
`option().exerciseAmount` on all five.

### C4 (CONFIRMED against my own doubt) — `renounceOwnership()` really is `view`
I flagged `"function renounceOwnership() view"` as a likely hand-edited ABI defect. It is **not**. The
authoritative Blockscout-verified ABI says `{"name":"renounceOwnership", …, "stateMutability":"view"}`.
The report is right. One refinement to the prose: the override **keeps `onlyOwner`** — a non-owner gets
`OwnableUnauthorizedAccount` (`0x118cdaa7`), only the owner reaches `RenounceDisabled` (`0x89051165`).

### C5 (CONFIRMED from source) — design facts #1 and #4
```solidity
function isApproved(uint256 optionId) external view returns (bool) {
    return _cycleOf[optionId] == cycleNumber && cycleNumber != 0;
}
```
Confirms #1: O(1), handles `cycleNumber == 0`, **and self-invalidates across cycle rollover** (an id stamped
with cycle 1 stops being approved the moment `cycleNumber` becomes 2 — no stale-approval bug). Note that
`strikePerContract()` is a bare passthrough to Valorem and does **not** check approval, so it must never be
used as an eligibility test.
```solidity
if (strike <= previousStrike) revert StrikesNotAscending(optionId, previousStrike, strike);
```
Confirms #4: strictly ascending, which also makes duplicate ids impossible. `optionIds` is pre-sorted; no
client-side sort needed. Combined with `MAX_STRIKES() == 5`, the ladder is bounded.

Also confirmed inert: the verified source contains no `payable`, `receive`, `fallback`, `transfer`,
`transferFrom`, `approve`, `safeTransferFrom`, `delegatecall` or `selfdestruct`. **Never approve the registry.**

### C6 (ADDITION) — testnet owner differs from mainnet owner
Not reported before: testnet registry `owner()` = `0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82`, which is
**not** the mainnet owner `0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0`. Matches the two distinct
`registryOwner` entries in the frontend config. Any keeper allowlist keyed on the registry owner must be
per-chain.

## Their UNRESOLVED items — two of them I resolved

### RESOLVED: "no canonical Overcall deployed-addresses doc page was read"
I checked. **No such page exists**, so there is nothing to diff and this can be closed.
- `https://docs.robinhood.com/chain/docs/contract-addresses/` returns HTTP 200 but is a **soft 404** — the
  scraped body is literally `Page Not Found`. The docs site is a Vocs SPA that 200s every path;
  `/chain/sitemap.xml` also returns the HTML shell, not XML. Do not trust HTTP 200 on this host.
- Overcall **does** have docs at `https://overcall.finance/docs` (the first pass said it had not read them).
  They publish only two addresses — `clearinghouse 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` and
  `seaport 0x0000000000000068F116a894984e2DB1123eB395` — both of which **corroborate** the on-chain reads.
  No per-market registry address book is published anywhere. Mapping the docs surfaced only
  `/docs` and `/docs/protocol/audits`.
- Conclusion: the frontend bundle remains the only published address source, and it has now been confirmed
  on-chain twice by two agents. Good enough to ship.

### RESOLVED (R5 input): the NVDA price feed, and a real problem with the ladder
The first pass cited `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` from the frontend config **without ever
verifying it**. I verified it — it is real:
```
eth_getCode              9571 bytes
description()            "RHNVDA / USD"
decimals()               8
latestRoundData()        roundId 18446744073709552641 (phase 1, round 1025)
                         answer  21829793457  -> 218.29793457
                         updatedAt 1789157023 = 2026-09-11 20:03:43 UTC
chain now                1789237870 = 2026-09-12 18:31:10 UTC
```
Two consequences the vault design has to absorb:

1. **Feed age is 80,847 s ≈ 22.5 hours.** This is an equity feed; it does not tick outside market hours, and
   today is a Saturday. A naive freshness gate (`require(now - updatedAt < 1 hours)`) would brick the vault
   permanently. The policy gate needs a market-hours-aware staleness rule, not a short heartbeat.
2. **The ladder against spot 218.2979:**

   | rung | strike | OTM |
   |---|---|---|
   | 0 | 226 | +3.53% |
   | 1 | 231 | +5.82% |
   | 2 | 236 | +8.11% |
   | 3 | 241 | +10.40% |
   | 4 | **246** | **+12.69%** |

   Rungs 0–3 sit inside plan §9's 3–12% OTM band. **Rung 4 is outside it**, and rung 4 is the only rung with
   open interest. So the vault's eligibility filter will legitimately reject a rung Overcall publishes — the
   "no eligible rung" path is reachable in week 1 and must be handled, not treated as an error.
   (Spot moves; re-read at deploy time.)

### STILL UNRESOLVED (I agree with them)
- **No public Overcall GitHub repo.** I found none either. The Blockscout-verified source is the only
  source of truth; re-pull and diff `ops/abis/OvercallRegistry.sol` at deploy time.
- **The 9 non-NVDA testnet registries are frontend-config only.** I verified testnet NVDA on two RPCs and all
  11 mainnet registries; I did not eth_call the other testnet ones.
- **Whether Overcall rolls cycle 2 on schedule is unobserved.** `cycleCount() == 1` — still only one cycle
  ever on mainnet. Watch `CycleSet` on 0x8E973c… through 2026-09-19/20.
- **Open interest per rung not sized.** I established *which* rung is written (rung 4, one claim) but did not
  enumerate Valorem write logs for notional. R2/R4 territory.
- **Everything time-dependent goes stale after 2026-09-19 20:00 UTC.** Addresses and ABI are immutable.

## Operational warning for the orchestrator
The session scratchpad is **shared across all parallel recon agents**. Mid-run, a sibling agent overwrote my
`scratchpad/rpc.py` with a different module (same filename, different function signatures), which surfaced as
a `NameError` rather than silently wrong numbers — but it could just as easily have produced wrong numbers.
I re-ran everything afterwards in a private subdirectory. **Agents writing helper scripts to the scratchpad
root will clobber each other; use a per-agent subdirectory.**
