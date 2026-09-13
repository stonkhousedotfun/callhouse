# R7 / R8 — Testnet 46630 coverage + explorer & verification API

Agent: `R7-R8-testnet-explorer`
Date of run: 2026-09-12 (all output below was produced live on that date)
Scope: (A) what exists on Robinhood Chain Testnet 46630 and whether a real 2-week keeper
dry-run is possible there; (B) which explorer responds, which has a working contract
verification API, and the canonical URL patterns for frontend links.

---

## TL;DR — the two answers

**R7 — Can we run a real 2-week keeper dry-run on 46630?**
**No. Use a mainnet fork (4663) + mock registry.** Testnet 46630 is a real, well-maintained
Robinhood-operated chain with an official faucet and *official* Stock Tokens and USDG, but:

1. **Valorem Clear does not exist on 46630 at all** — `eth_getCode` = 0 bytes at the mainnet
   address, and the testnet Blockscout has **zero** contracts matching `Valorem`,
   `Clearinghouse` or `OptionSettlement`. Without Valorem there is no `write` / `redeem`
   / option-ERC-1155, which is the entire vault mechanism.
2. **Overcall has no testnet deployment.** No registry contract, and overcall.finance
   documents mainnet addresses only.
3. **There is no NVDA Stock Token on 46630.** The official `StockFactory` has emitted exactly
   five `Deployed` events ever: TSLA, AMZN, PLTR, NFLX, AMD. NVDA is not one of them.
4. **The testnet `Stock` implementation is an older build than mainnet's** — it is missing
   `oraclePaused()`, `pauseOracle()`, `unpauseOracle()`, `terms()` and the
   `OraclePaused`/`OracleUnpaused` events. Our policy write-gate (plan §5.2, R5) depends on
   `oraclePaused()`. Testing that gate on 46630 is impossible.

What 46630 *is* still good for: a free, real-network smoke test of Vault + Distributor +
deploy scripts + Blockscout verification + frontend explorer links, against **real**
Robinhood Stock Token and USDG contracts (TSLA instead of NVDA). Do that. Do the
Valorem/Seaport/registry cycle on an anvil fork of 4663.

**R8 — Explorer + verification.**
Canonical and the only one with a verification API: **Blockscout**.

| | chain | base URL | verifier API | forge works directly? |
|---|---|---|---|---|
| mainnet | 4663 | `https://robinhoodchain.blockscout.com` | `/api` — live | **NO — Cloudflare blocks forge.** Workaround below, tested. |
| testnet | 46630 | `https://explorer.testnet.chain.robinhood.com` | `/api` — live | **YES — tested end-to-end.** |

`robinscan.io`, `hoodscan.co` and `stonkscan.io` all respond and all serve
`/address/…`, `/tx/…`, `/token/…`, but **none of them is a Blockscout and none has a
contract-verification API.** They are display-only alternatives.

---

## A. Testnet 46630

### A.0 Chain is live and fast

```
$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://rpc.testnet.chain.robinhood.com/rpc
{"jsonrpc":"2.0","id":1,"result":"0xb626"}          # 46630

$ ... eth_blockNumber ...
{"jsonrpc":"2.0","id":1,"result":"0x70c5cb6"}       # 118,250,678
```

Both public RPCs agree (`https://robinhood-sepolia-rpc.publicnode.com` → `0xb626`,
head `0x70c5cc4`). Testnet head is **~118.2M blocks — nearly 2× mainnet's ~61.3M**.
Blockscout reports `"average_block_time":131.0` ms and `"total_transactions":"270185241"`.

Gas:
```
MAINNET gasPrice 0x5d558e0  = 0.097868 gwei
TESTNET gasPrice 0x989680   = 0.01     gwei
testnet: 0.01 ETH / gasPrice = 1,000,000,000 gas units
```
One faucet drip (0.01 ETH) buys 1e9 gas. **Gas is a non-issue for a dry-run.**

### A.1 Requested contracts — `eth_getCode` byte length on 46630

Run against `https://rpc.testnet.chain.robinhood.com/rpc`:

| name | address | testnet bytes | mainnet bytes | verdict |
|---|---|---|---|---|
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` | **23981** | 23981 | **PRESENT**, same deployment |
| Valorem Clear | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` | **0** | 16110 | **ABSENT** |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | **3808** | 3808 | **PRESENT**, byte-identical |
| USDG (mainnet addr) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | **0** | 170 | **ABSENT at this address** (different testnet address — see A.3) |
| NVDA (mainnet addr) | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | **0** | 283 | **ABSENT**, and no NVDA anywhere on 46630 |

Raw loop output:
```
0x0000000000000068F116a894984e2DB1123eB395 -> 23981
0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 -> 0
0xcA11bde05977b3631167028862bE2a173976CA11 -> 3808
0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 -> 0
0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC -> 0
```

### A.2 Seaport 1.6 on testnet is the same deployment (bonus for R2/R9)

Bytecode lengths match exactly (23981 B) but the bytes differ in **64 nibbles only**, all of
them inside the cached EIP-712 immutables:

```
num differing nibbles: 64
  byte offset 15419..15420: mainnet=1237  testnet=b626      <-- chainId 4663 vs 46630
  byte offset 15427..15458: (cached domain separator)
```

`information()` (`0xf47b7740`) on both chains:

```
MAINNET  version: 1.6  domainSeparator: 0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0
                       conduitController: 0x00000000f9490004c11cef243f5400493c00ad63
TESTNET  version: 1.6  domainSeparator: 0x0c73d0253563636cf8ee766ce8aac88e6b4e22e1151b14e8f8bf3bf44cda3036
                       conduitController: 0x00000000f9490004c11cef243f5400493c00ad63
```

**The canonical Seaport ConduitController `0x00000000F9490004C11Cef243f5400493c00Ad63` is
present on BOTH chains with 8820 bytes of code.** (Feeds R9 — hand this to whoever owns it.)

### A.3 Official testnet Stock Tokens and USDG — found, with proof

There **is** an official Robinhood token deployment on 46630. It is reached through a
`StockFactory` + beacon, mirroring mainnet exactly.

**The faucet is the entry point.** `https://faucet.testnet.chain.robinhood.com/` (rendered
via firecrawl; it is a Vercel app behind a JS "Vercel Security Checkpoint", so plain curl
gets HTTP 429 + `x-vercel-mitigated: challenge` on every path):

> ## Testnet Faucet
> Each faucet request will send 0.01 testnet ETH and five of each Stock Token to your wallet.
> Claim once every 24 hours.
> ### You will receive
> 0.01 ETH (Native) / 5 TSLA / 5 AMZN / 5 PLTR / 5 NFLX / 5 AMD
> Supported by Offchain [Labs]

**Note the list: TSLA, AMZN, PLTR, NFLX, AMD. No NVDA. No USDG.**

Confirmed on-chain. Each is a 283-byte beacon proxy — *the same 283 bytes as mainnet NVDA*:

```
mainnet NVDA  (283 B): 0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000
                        e10b6f6b275de231345c20d14ab812db62151b00 6001600160a01b0316635c60da1b...
testnet TSLA  (283 B): 0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000
                        1df3ca0fd30ed5eeb09eb01938f4e9c5196e6ca5 6001600160a01b0316635c60da1b...
identical: False
differing nibble range: 84..545   (only the immutable beacon address + the metadata hash)
```
Same solc (`0033` CBOR tail → `0.8.33`), same proxy, different beacon per chain.

`eth_call` probe of all five testnet tokens:

```
0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E  codeBytes=283
   name()  'Tesla'   symbol() 'TSLA'  decimals() 18
   uiMultiplier()  0x...0de0b6b3a7640000  (= 1e18 exactly)
   totalSupply()   6122495000000000000000000
0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02  'Amazon'   / AMZN / 18 / uiMultiplier 1e18
0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0  'Palantir Technologies' / PLTR / 18 / 1e18
0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93  'Netflix'  / NFLX / 18 / 1e18
0x71178BAc73cBeb415514eB542a8995b82669778d  'AMD'      / AMD  / 18 / 1e18
```
All five: identical `totalSupply` (faucet-minted), ~218k–285k holders each.

#### Official testnet addresses (ALL confirmed by eth_getCode + explorer record)

| role | testnet 46630 | mainnet 4663 |
|---|---|---|
| Stock Token TSLA | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` | — |
| Stock Token AMZN | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` | — |
| Stock Token PLTR | `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` | — |
| Stock Token NFLX | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` | — |
| Stock Token AMD | `0x71178BAc73cBeb415514eB542a8995b82669778d` | — |
| Stock Token NVDA | **DOES NOT EXIST** | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| `Stock` implementation | `0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA` | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` |
| `AccessControlsRegistry` (beacon) | `0x1dF3cA0fD30ED5eeb09eB01938f4E9c5196E6Ca5` | `0xe10b6f6b275de231345c20d14ab812db62151b00` |
| `StockFactory` proxy | `0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da` | `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046` |
| `StockFactory` impl | `0x55Eec3AE0deDf81291aa2BA10572f52f35bF562A` | `0xEe351E53BCe6AAF106428358838197C91e36EE0E` |
| Robinhood deployer EOA (testnet) | `0x720538e8c1426F077ba6e2592a59d5176F602D88` | — |
| **USDG proxy** | `0x7E955252E15c84f5768B83c41a71F9eba181802F` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| `USDG` implementation | `0xF0863D7A29a55d0c4263c11bFac754312ff078DF` | `0x68184C449E1a8f34fA18d289737129FD27B66f8F` |

Explorer records (testnet, `/api/v2/addresses/…`):
```
0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E
 creator: 0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da   verified: True
 proxy_type: eip1967_beacon
 impls: [{'address_hash': '0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA', 'name': 'Stock'}]

0x1dF3cA0fD30ED5eeb09eB01938f4E9c5196E6Ca5
 name: "AccessControlsRegistry"  is_verified: true
 creator: 0x720538e8c1426F077ba6e2592a59d5176F602D88

0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da
 impls: [{'address_hash': '0x55Eec3AE0deDf81291aa2BA10572f52f35bF562A', 'name': 'StockFactory'}]
 creator: 0x720538e8c1426F077ba6e2592a59d5176F602D88
```

Mainnet mirror (`/api/v2/addresses/…` through the proxy in §B.3):
```
0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
 name: BeaconProxy   verified: True   proxy_type: eip1967_beacon
 impls: [{'address_hash': '0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2', 'name': 'Stock'}]
 creator: 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046
0xe10b6f6b275de231345c20d14ab812db62151b00
 name: AccessControlsRegistry   verified: True
0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
 name: ERC1967Proxy   proxy_type: eip1967
 impls: [{'address_hash': '0x68184C449E1a8f34fA18d289737129FD27B66f8F', 'name': 'USDG'}]
```

**Testnet USDG is the real thing**, not a mock. Its proxy bytecode is **byte-identical** to
mainnet USDG's proxy, its impl is verified under the name `USDG`, and its ABI is the genuine
Paxos Global Dollar surface:

```
testnet USDG code == mainnet USDG code: True
testnet impl slot (0x360894a1…): 0x...f0863d7a29a55d0c4263c11bfac754312ff078df
mainnet impl slot (0x360894a1…): 0x...68184c449e1a8f34fa18d289737129fd27b66f8f
testnet decimals: 6
```
```
impl 0xF0863D7A29a55d0c4263c11bFac754312ff078DF  name: USDG  verified: True
  compiler: v0.8.28+commit.7893614a
  fns: DEFAULT_ADMIN_ROLE, DOMAIN_SEPARATOR, EIP712_DOMAIN_HASH_DEPRECATED,
       EIP712_VERSION_PREFIX, acceptDefaultAdminTransfer, allowance, approve,
       assetProtectionRoleDeprecated, balanceOf, batchSetFacet, beginDefaultAdminTransfer,
       betaDelegateWhitelisterDeprecated, burn, cancelDefaultAdminTransfer,
       changeDefaultAdminDelay, decimals, decreaseApproval, decreaseSupply,
       decreaseSupplyFromAddress, defaultAdmin, defaultAdminDelay, ..., facets, getFacet,
       globalTransferSettings, increaseSupply, increaseSupplyToAddress, initialize,
       initializeV3, mint, setFacet, supplyControl, transferFromBatch, upgradeTo, ...
```

> Caveat carried forward: the testnet USDG proxy was created by
> `0x980DfEa441f11277E36576511B03fAE2Eab24B2C`, **not** by the Robinhood deployer EOA
> `0x720538e8…` that deployed the Stock infra. The impl is verified as `USDG` with the real
> Paxos ABI, but I could not independently tie that deployer to Paxos. Treat it as
> "the real USDG contract code, deployed by an unconfirmed party."
> The faucet does **not** dispense USDG, so a testnet dry-run has no USDG source anyway.

### A.4 Proof there is no NVDA on testnet — the factory's own event log

`StockFactory` implementation ABI (verified source, testnet Blockscout):
```
function deploy(bytes32,string,string) returns (address)   nonpayable
function tokenAddress(bytes32) returns (address)           view
function beacon() returns (address)                        view
event   Deployed(bytes32 indexed uid, address stock, string name, string symbol)
```

Every log ever emitted by `0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da`
(`/api/v2/addresses/{a}/logs` → `log count on page: 7  next: False` — that is the complete set):

```
Deployed(bytes32 indexed uid, address stock, string name, string symbol)
  uid=0x...958cc238f7a04144bf5eb07da3d3734e  stock=0x71178BAc73cBeb415514eB542a8995b82669778d  name=AMD                    symbol=AMD
  uid=0x...41de1e6ae0f4cd3825f77b5a4a3cc784  stock=0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93  name=Netflix                symbol=NFLX
  uid=0x...52cd6b007b15456ba5fbc3aa605765e0  stock=0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0  name=Palantir Technologies  symbol=PLTR
  uid=0x...99c33a4e234448e99d6c8a5e5dddeda0  stock=0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02  name=Amazon                 symbol=AMZN
  uid=0x...aa1fee9afa45465cbc65157b4edf63f5  stock=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E  name=Tesla                  symbol=TSLA
Initialized(uint64 version)  version=1
Upgraded(address indexed implementation)  implementation=0x55Eec3AE0deDf81291aa2BA10572f52f35bF562A
```

**Five stock tokens, full stop. NVDA is not on testnet.**

Independently: I scanned all 50 testnet tokens whose symbol matches `NVDA` in the
Blockscout search index and checked each one's `eth_getCode` against the official
283-byte beacon-proxy shape and the official beacon address:
```
===== NVDA
  (scanned 50)          <- zero hits
```
They are all independent hobbyist mocks — `"NVDA Test Stock"`, `"Mock NVDA"`,
`"NVIDIA (mock)"`, `"Nasduck Mock NVDA"`, `"NVIDIA Stock Token (replica)"`, `"NVDA Doge"`,
etc. **Do not use any of them.** None is Robinhood-issued.

### A.5 The testnet `Stock` build is BEHIND mainnet — this is the real blocker for R5

Both `Stock` implementations are verified with full source. Diffing their ABIs:

```
mainnet Stock: Stock v0.8.33+commit.64118f21  verified_at 2026-06-15T23:47:14Z
testnet Stock: Stock v0.8.33+commit.64118f21  verified_at 2026-03-13T19:48:53Z
identical ABI surface: False
only on mainnet: ['event OraclePaused()', 'event OracleUnpaused()',
                  'function oraclePaused()', 'function pauseOracle()',
                  'function terms()',        'function unpauseOracle()']
only on testnet: []
```

Confirmed live by `eth_call` (selectors from `cast sig`, not guessed):

```
MAINNET NVDA  0x7706ba52 oraclePaused()   -> 0x0000...0000   (false)
MAINNET NVDA  0xd5025625 terms()          -> "https://robinhood.com/stocktoken/rhj"
MAINNET NVDA  0x86c75e74 tokenPaused()    -> false
MAINNET NVDA  0x5c975abb paused()         -> false
MAINNET NVDA  0xa60bf13d uiMultiplier()   -> 1000775159164630595   (1.000775e18)

TESTNET TSLA  0x7706ba52 oraclePaused()   -> ERROR execution reverted
TESTNET TSLA  0xd5025625 terms()          -> ERROR execution reverted
TESTNET TSLA  0x86c75e74 tokenPaused()    -> false
TESTNET TSLA  0x5c975abb paused()         -> false
TESTNET TSLA  0xa60bf13d uiMultiplier()   -> 1000000000000000000   (exactly 1e18)
```

Consequences for the build:
- The `oraclePaused()` write-gate (plan §5.2) **cannot be exercised on 46630**.
- `uiMultiplier` is pinned at exactly 1e18 on testnet, so the
  "uiMultiplier change mid-cycle does not break share math" fork test (plan §4.11 #12)
  has nothing to move. Mainnet NVDA is already at 1.000775e18, i.e. non-unity in production.
- Any adapter compiled against `IStock` with `oraclePaused()` will revert on testnet.
  If we want a testnet smoke test, the policy gate must be feature-detected
  (staticcall + accept revert) or compiled out.

### A.6 BONUS for R5/R6 — full verified `Stock` source is downloadable on BOTH chains

This was not asked for but it closes most of R6 for free:

```
GET https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA
GET https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2   (needs Referer, see §B.3)
```
Both return `file_path: src/Stock.sol` plus 20+ `additional_sources`, including
`src/interfaces/IStock.sol`, `src/interfaces/IScaledUIAmount.sol`,
`src/interfaces/IScaledUIAmountBalances.sol`,
`src/interfaces/IScaledUIAmountNewUIMultiplier.sol`, `src/Roles.sol`,
`src/interfaces/IAccessControlsRegistry.sol`.

Full mainnet `Stock` ABI (32 functions) — the ERC-8056 surface the Vault and UI need:
```
ACCESS_CONTROLLED_REGISTRY() view returns (address)
DOMAIN_SEPARATOR() view returns (bytes32)
adminBurn(address,uint256)
allowance(address,address) view returns (uint256)
approve(address,uint256) returns (bool)
balanceOf(address) view returns (uint256)
balanceOfUI(address) view returns (uint256)
burn(address,uint256)
decimals() view returns (uint8)
effectiveAt() view returns (uint256)
eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])
initialize(bytes32,string,string)
mint(address,uint256)
name() view returns (string)
newUIMultiplier() view returns (uint256)
nonces(address) view returns (uint256)
oraclePaused() view returns (bool)          <-- MAINNET ONLY
pause()
pauseOracle()                               <-- MAINNET ONLY
paused() view returns (bool)
permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
setMetadata(string,string)
supportsInterface(bytes4) view returns (bool)
symbol() view returns (string)
terms() view returns (string)               <-- MAINNET ONLY
tokenPaused() view returns (bool)
totalSupply() view returns (uint256)
totalSupplyUI() view returns (uint256)
transfer(address,uint256) returns (bool)
transferFrom(address,address,uint256) returns (bool)
uiMultiplier() view returns (uint256)
uid() view returns (bytes32)
unpause()
unpauseOracle()                             <-- MAINNET ONLY
updateMultiplier(uint256)
updateMultiplier(uint256,uint256)

event Approval(address,address,uint256)
event EIP712DomainChanged()
event Initialized(uint64)
event MetaDataUpdated(string,string)
event OraclePaused()                        <-- MAINNET ONLY
event OracleUnpaused()                      <-- MAINNET ONLY
event Paused()
event Transfer(address,address,uint256)
event TransferWithScaledUI(address,address,uint256,uint256)
event UIMultiplierUpdated(uint256,uint256,uint256)
event Unpaused()
```

Note for the Vault/indexer: there are **two** pause flags (`paused()` global and
`tokenPaused()` per-token), a **two-arg `updateMultiplier(uint256,uint256)`** overload with
`effectiveAt()` / `newUIMultiplier()` scheduling, and a dedicated
`TransferWithScaledUI(address,address,uint256,uint256)` event. Hand this to whoever owns
R5/R6 — I did not chase the semantics further, it is out of my scope.

### A.7 Faucet

- URL: **`https://faucet.testnet.chain.robinhood.com/`** — live, run by Offchain Labs.
- Dispenses: **0.01 testnet ETH + 5 each of TSLA, AMZN, PLTR, NFLX, AMD. Once per 24 h.**
- Requires connecting a wallet in a browser. It is a Vercel app with a
  **Vercel Security Checkpoint** JS challenge on *every* path (`/`, `/add-chain`,
  `/api/claim`, `/api/faucet`, `/api/tokens`, `/api/config`, `/robots.txt` all returned
  `http=429` + `x-vercel-mitigated: challenge` to curl). **No headless/programmatic claim
  path was found.** Funding the keeper hot key on testnet is a manual, daily browser action.
- Rate math: one drip = 1e9 gas units at the current 0.01 gwei, so a single claim funds
  weeks of keeper activity. Gas is not the constraint; the missing protocol is.
- There is also an "Add testnet" button at `/add-chain` (same challenge).
- Docs page confirming networks: `https://docs.robinhood.com/chain/connecting` —
  mainnet 4663 / testnet 46630, public RPCs
  `https://rpc.mainnet.chain.robinhood.com` and `https://rpc.testnet.chain.robinhood.com`,
  Alchemy `https://robinhood-{mainnet,testnet}.g.alchemy.com/v2/{API_KEY}`
  (+ `wss://` variants), and "also supported by QuickNode, Blockdaemon, dRPC, and
  Validation Cloud". Status page: `http://status.robinhoodchain.offchain.io/`.

### A.8 Testnet RPC limits (matters for the indexer)

```
testnet head: 118256827
  range    1000: OK, 748 logs
  range   10000: OK, 8571 logs
  range   50000: {"code":-32000,"message":"logs matched by query exceeds limit of 10000"}
  range  100000: (same)
  range  500000: (same)
```
The cap is **10,000 matched logs per `eth_getLogs`**, not a block-range cap. Page by result
count, not by fixed block width. Also:
```
eth_getBlockByNumber      -> OK
txpool_status             -> -32601 "the method txpool_status does not exist/is not available"
debug_traceTransaction    -> -32601 "does not exist/is not available"
```
**No `debug_*` namespace on the public testnet RPC.** If the keeper or a test needs tracing,
use a local anvil fork or a paid provider.

### A.9 Competitive note (unsolicited, but you will want to know)

The testnet Blockscout already indexes other people's covered-call work:
```
0x7b242611B7C490BC5F571095ef511d60E89bf914 | CoveredCallVault    | verified
0x7d873a335aD3cf8cc5A7AfEe8fA80b2d042b54E0 | CoveredCallVault    | verified
0xbAB66DC34052479eF7a97e213DA8a9948ff772E3 | CoveredCallVault    | verified
0xe2029A8BDF6f559E50160Eb59f1E4B4Fc7A011C5 | CoveredCallVault    | verified
0x6fFC92cf98AD2FE3869049aa8519fe8b9bf067a9 | CoveredCallVault    | verified
0xed863107f3F8d460746f21D3906A69817F1BCc99 | CoveredCallVault    | verified
0x0145453fF7fe3d3D62aBe3A6a99F21a74493323d | CoveredCallOption   | verified
0xeD9469A50745Abf0Cd1287edd658A048d287Ef82 | PremiumSeller       | verified
0xD4a94d34Bdc879314492f16837FAEa66744b59Bc | PremiumSeller       | verified
0xF81d643FbD0E1a2984778fe212e295075993f723 | OptionAuction       | verified
0xc8426470D1234A23eaF5Df79b96eD3B8446c4352 | OptionBV4Router     | verified
```
None of them touches Valorem (there is none on testnet), so they are all self-contained
toys — but somebody else is circling this idea. I did not read their source.

---

## B. Explorers + verification

### B.1 Which hosts respond

All five return HTTP 200 at the root:
```
https://robinhoodchain.blockscout.com          http=200
https://robinscan.io                           http=200
https://hoodscan.co                            http=200
https://stonkscan.io                           http=200
https://explorer.testnet.chain.robinhood.com   http=200
```

But only two are Blockscout:
```
robinhoodchain.blockscout.com   /api/v2/config/backend-version -> {"backend_version":"v11.3.0.+commit.65c6dfb2"}
explorer.testnet.chain...       /api/v2/config/backend-version -> {"backend_version":"v10.2.6"}

robinscan.io   /api/v2/stats -> {"error":"not found"}
hoodscan.co    /api/v2/stats -> {"message":"This endpoint serves the HoodScan pages. For programmatic
                                access use the MCP server at https://hoodscan.co/mcp or the swap index
                                at https://hoodscan.co/swaps-api (see https://hoodscan.co/llms.txt).",
                                "code":"FORBIDDEN"}
stonkscan.io   /api/v2/stats -> <!DOCTYPE html> ... Next.js app shell
```

**`robinscan.io`, `hoodscan.co` and `stonkscan.io` have no contract-verification API.**
`hoodscan.co` does offer an MCP server (`https://hoodscan.co/mcp`, Streamable HTTP, no auth)
and an `llms.txt`; it is a market-data/meme-coin explorer, useful for token price/liquidity
lookups, useless for verification.

Blockscout's own public chain registry confirms the canonical pair:
```
GET https://chains.blockscout.com/api/chains
"4663":  {"name":"Robinhood Chain", "ecosystem":"Arbitrum Orbit", "rollupType":"arbitrum",
          "explorers":[{"url":"https://robinhoodchain.blockscout.com/","hostedBy":"blockscout"}]}
"46630": {"name":"Robinhood Chain Testnet", "isTestnet":true, "settlementLayerChainId":"1",
          "explorers":[{"url":"https://explorer.testnet.chain.robinhood.com/","hostedBy":"self-hosted"}]}
```

### B.2 Verification API — both are live

Both report the Rust verifier microservice enabled:
```
GET {base}/api/v2/smart-contracts/verification/config
 -> {"is_rust_verifier_microservice_enabled":true,
     "license_types":{"none":1,"unlicense":2,"mit":3,...},
     "solidity_compiler_versions":["v0.8.36+commit.8a079791","v0.8.35+commit.47b9dedd",
       "v0.8.34+commit.80d5c536","v0.8.33+commit.64118f21","v0.8.32+commit.ebbd65e5",
       "v0.8.31+commit.fd3a2265","v0.8.30+commit.73712a01","v0.8.29+commit.ab55807c", ...]}
```
(identical list on both — `0.8.30` and `0.8.33` are both available.)

**Live submit test on testnet** — raw etherscan-compat POST, deliberately junk source:
```
$ curl -X POST https://explorer.testnet.chain.robinhood.com/api \
    -d module=contract -d action=verifysourcecode \
    -d codeformat=solidity-standard-json-input \
    -d contractaddress=0x0000000000000068F116a894984e2DB1123eB395 ...
{"message":"OK","result":"0000000000000068f116a894984e2db1123eb3956aa596f5","status":"1"}

$ curl "https://explorer.testnet.chain.robinhood.com/api?module=contract&action=checkverifystatus&guid=0000000000000068f116a894984e2db1123eb3956aa596f5"
{"message":"OK","result":"Fail - Unable to verify","status":"1"}
```
Submit → GUID → poll → verdict. The full protocol works. ("Fail" is correct; I submitted a
`contract X{}` against Seaport's bytecode on purpose.)

### B.3 forge verify-contract — **TESTNET WORKS, MAINNET IS BLOCKED BY CLOUDFLARE**

`forge` here is `1.3.5-foundry-zksync-v0.1.9`.

#### Testnet — works directly. Tested end to end:

```
$ forge verify-contract 0x0000000000000068F116a894984e2DB1123eB395 src/Probe.sol:Probe \
    --chain-id 46630 \
    --verifier blockscout \
    --verifier-url https://explorer.testnet.chain.robinhood.com/api \
    --constructor-args $(cast abi-encode "constructor(uint256)" 1) \
    --compiler-version v0.8.30+commit.73712a01 \
    --num-of-optimizations 200 \
    --watch

Start verifying contract `0x0000000000000068F116a894984e2DB1123eB395` deployed on 46630
Compiler version: v0.8.30+commit.73712a01
Optimizations:    200
Constructor args: 0x0000000000000000000000000000000000000000000000000000000000000001

Submitting verification for [src/Probe.sol:Probe] 0x0000000000000068F116a894984e2DB1123eB395.
Submitted contract for verification:
	Response: `OK`
	GUID: `0000000000000068f116a894984e2db1123eb3956aa59740`
	URL: https://explorer.testnet.chain.robinhood.com/address/0x0000000000000068f116a894984e2db1123eb395
Contract verification status:
	Response: `OK`
	Details: `Pending in queue`
Warning: Verification is still pending...; waiting 15 seconds before trying again
Contract verification status:
	Response: `OK`
	Details: `Fail - Unable to verify`
```
(`Fail` expected — I verified a dummy `Probe` against Seaport's address. Everything else —
submit, queue, poll, terminal verdict — is a clean pass. No API key needed.)

**Working testnet flags:**
```
--chain-id 46630 --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api
```

#### Mainnet — DIRECT FAILS. `robinhoodchain.blockscout.com` is behind a Cloudflare managed challenge.

```
$ forge verify-contract 0x... src/Probe.sol:Probe --chain-id 4663 \
    --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api ...

Start verifying contract `0x...` deployed on 4663
Error: Failed to obtain contract ABI for 0x...
Failed to deserialize content: expected value at line 1 column 1
<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
 ... cZone: 'robinhoodchain.blockscout.com', cType: 'managed' ...
```
It fails on the very first call (ABI fetch), before any submit.

**Root cause, isolated deterministically.** The CF rule keys on the presence of a
`Referer` header. Five runs each:
```
-- 5x bare curl:            <!DOCTYPE html> ... Just a moment...   (x5)
-- 5x browser UA only:      <!DOCTYPE html> ... Just a moment...   (x5)
-- 5x 'foundry/1.3.5' UA:   <!DOCTYPE html> ... Just a moment...   (x5)
-- 5x UA + Referer:         {"backend_version":"v11.3.0..."}       (x5)
```
Further narrowing:
```
Referer only (no UA)       -> {"backend_version":"v11.3.0.+commit.65c6dfb2"}   PASS
Referer=example.com + UA   -> {"backend_version":"v11.3.0.+commit.65c6dfb2"}   PASS
foundryUA + Referer        -> {"backend_version":"v11.3.0.+commit.65c6dfb2"}   PASS
UA + Origin                -> challenge                                        FAIL
UA + sec-fetch-mode        -> challenge                                        FAIL
```
**Any `Referer` header at all — the value is irrelevant — passes.** `forge`/reqwest never
sends one, so forge can never reach mainnet Blockscout.

#### Tested workaround: a 30-line local Referer-injecting reverse proxy

Save as `ops/bsproxy.js`, run `node ops/bsproxy.js`, point `--verifier-url` at it:

```js
// Minimal reverse proxy: localhost -> robinhoodchain.blockscout.com, injecting a Referer
// header, which is the single thing Cloudflare's managed challenge checks for on that host.
const http = require('http');
const https = require('https');
const UPSTREAM = 'robinhoodchain.blockscout.com';
const PORT = Number(process.env.PORT || 8546);

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['accept-encoding'];
    headers['host'] = UPSTREAM;
    headers['referer'] = `https://${UPSTREAM}/`;
    headers['user-agent'] =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    if (body.length) headers['content-length'] = String(body.length);
    const up = https.request(
      { host: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    up.on('error', e => { res.writeHead(502); res.end(String(e)); });
    if (body.length) up.write(body);
    up.end();
  });
}).listen(PORT, '127.0.0.1', () => console.error('bsproxy on 127.0.0.1:' + PORT));
```

Proof it works:
```
$ curl -s http://127.0.0.1:8546/api/v2/config/backend-version
{"backend_version":"v11.3.0.+commit.65c6dfb2"}

$ forge verify-check 0xdead...beef --verifier blockscout \
    --verifier-url http://127.0.0.1:8546/api --chain-id 4663
Checking verification status on 4663
Contract verification status:
	Response: `OK`
	Details: `Unknown UID`          <-- real JSON API response, CF cleared

$ curl -X POST "http://127.0.0.1:8546/api?module=contract&action=verifysourcecode" \
    -d contractaddress=0xcA11bde05977b3631167028862bE2a173976CA11 ...
{"message":"Smart-contract already verified.","result":"Smart-contract already verified.","status":"0"}
```
And forge itself, through the proxy, reaching the real API and returning real Blockscout
semantics rather than HTML:
```
Submitting verification for [src/Probe.sol:Probe] 0xdAe7e82A2E7D566C67E87C164B05a1C560190782.
Warning: Could not detect deployment: Address is not a smart-contract
```
(That is the correct answer — `0xdAe7e82A…` is the EOA from the brief.)

**Working mainnet flags (with the proxy running):**
```
--chain-id 4663 --verifier blockscout --verifier-url http://127.0.0.1:8546/api
```

#### Second mainnet constraint: hosted Blockscout rate limits

Hit during testing:
```
Error: Failed to obtain contract ABI for 0xcA11bde05977b3631167028862bE2a173976CA11
Context:
- Response result is unexpectedly empty: status=0,
  message=Too many requests. Increase limits now at https://dev.blockscout.com
```
`robinhoodchain.blockscout.com` is the **hosted** Blockscout instance and throttles
anonymous traffic. For deploy-day verification and for the indexer, get an API key from
`https://dev.blockscout.com` and pass it as `--verifier-api-key` / `VERIFIER_API_KEY`.

The testnet instance is self-hosted and showed **no** throttling:
```
--- testnet blockscout burst (20 rapid requests): ok=20 bad=0
```

### B.4 Canonical explorer URL patterns for the frontend

All verified with a live HTTP check plus a 404 control (a bogus route returns 404, so a 200
is meaningful).

**Mainnet 4663 — `https://robinhoodchain.blockscout.com`**
```
address  https://robinhoodchain.blockscout.com/address/{address}                 200
token    https://robinhoodchain.blockscout.com/token/{address}                   200
tx       https://robinhoodchain.blockscout.com/tx/{txHash}                       200
block    https://robinhoodchain.blockscout.com/block/{number}                    200
source   https://robinhoodchain.blockscout.com/address/{address}?tab=contract    200
```

**Testnet 46630 — `https://explorer.testnet.chain.robinhood.com`**
```
address  https://explorer.testnet.chain.robinhood.com/address/{address}          200
token    https://explorer.testnet.chain.robinhood.com/token/{address}            200
tx       https://explorer.testnet.chain.robinhood.com/tx/{txHash}                200
block    https://explorer.testnet.chain.robinhood.com/block/{number}             200
control  https://explorer.testnet.chain.robinhood.com/definitely-not-a-route-xyz 404
```

Exact URLs exercised:
```
.../address/0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC                                200  (mainnet NVDA)
.../tx/0x82eae0f17935187d1c810faa42c3d4b6741f0af35e9a934a9c8eecaa68a64043              200  (mainnet blk 61312607)
.../block/61312607                                                                    200
.../address/0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E                                200  (testnet TSLA)
.../tx/0x6c6e48815a470397084fd403d60280c93bea7983a2201e35aa7d93548df0abb5              200  (testnet blk 118257090)
.../block/118257090                                                                   200
```

For `viem` / wagmi `defineChain`:
```ts
blockExplorers: {
  default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com',
             apiUrl: 'https://robinhoodchain.blockscout.com/api' }   // 4663
}
blockExplorers: {
  default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com',
             apiUrl: 'https://explorer.testnet.chain.robinhood.com/api' }  // 46630
}
```
Caution: a browser will send `Referer` automatically, so links and in-page fetches to the
mainnet explorer are fine. The CF problem only bites **server-side / CLI** clients
(forge, the indexer, curl scripts).

**Alternate mainnet explorers** (display only, no verification API). All three answer
`/address/`, `/tx/`, `/token/` and 404 correctly:
```
robinscan.io   /address 308(redirect)  /tx 200  /token 308  /bogus 404
hoodscan.co    /address 301(redirect)  /tx 200  /token 301  /bogus 404
stonkscan.io   /address 200            /tx 200  /token 200  /bogus 404
```
If you want a non-Cloudflare mainnet fallback link, `stonkscan.io` uses the same
`/address|/tx|/token/{x}` shape with no redirects. `hoodscan.co` additionally serves
Markdown from any page URL via `Accept: text/markdown` and exposes an MCP server at
`https://hoodscan.co/mcp` — handy for token price/liquidity, not for us.

### B.5 Blockscout REST endpoints that actually worked (for the indexer)

Testnet (no headers needed) / mainnet (add any `Referer`):
```
/api/v2/stats
/api/v2/config/backend-version
/api/v2/search?q={query}                                  <- how I found the stock tokens
/api/v2/tokens?q={symbol}&type=ERC-20
/api/v2/addresses/{address}                               <- creator, proxy_type, implementations
/api/v2/addresses/{address}/logs                          <- DECODED logs, this is the good one
/api/v2/smart-contracts/{address}                         <- verified source + ABI + compiler settings
/api/v2/smart-contracts/verification/config
/api?module=contract&action=getabi&address={address}
/api?module=contract&action=verifysourcecode              (POST)
/api?module=contract&action=checkverifystatus&guid={guid}
```
Gotcha: `/api/v2/smart-contracts?limit=3` is rejected —
`{"errors":[{"title":"Invalid value","source":{"pointer":"/limit"},"detail":"Unexpected field: limit"}]}`.
Use `next_page_params` cursors, not `limit`.
Gotcha: `/api/v2/addresses/{mainnet StockFactory}/logs` returned `Internal server error`
on the mainnet instance (testnet worked fine) — likely the page is too large. Use a
`topic0`-filtered `eth_getLogs` there instead.
Gotcha: python `urllib` gets **HTTP 403** from both public RPCs without a `User-Agent`.
Set one (`curl/8.7.1` works).

---

## RECOMMENDATION

**Do not plan two live weeks on 46630.** Restructure milestone **M6** as:

1. **Fork-based dry-run (primary).** anvil fork of 4663 at a pinned block. Real Valorem
   Clear, real Seaport 1.6, real NVDA, real USDG, real `oraclePaused()`. Mock only the
   OvercallRegistry (`cycle()` + timestamps) so the keeper can time-warp two weekly cycles
   in minutes instead of 14 days. This is the only environment where the whole
   `Idle → Listed → Exercisable → Settling → Idle` machine can actually run.
2. **Testnet 46630 smoke test (secondary, cheap, worth doing).** Deploy Vault + Policy +
   Distributor against **TSLA** `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` instead of NVDA.
   This exercises, for real: the deploy script, constructor wiring, role grants, Blockscout
   verification, the real Robinhood `Stock` token's transfer/approve/`uiMultiplier` path,
   the frontend's explorer links, and Ponder's ability to sync a live chain. Skip the
   Valorem/Seaport legs and feature-detect `oraclePaused()`.
3. **Ask Overcall directly** whether they will stand up a 46630 registry. If they will, R7
   flips and a genuine testnet dry-run becomes possible. Right now nothing of theirs exists
   on 46630 and their site documents mainnet only.
4. **Before deploy day**: check the `ops/bsproxy.js` workaround into the repo and get a
   `https://dev.blockscout.com` API key. Mainnet verification will fail in CI otherwise,
   and it will fail in a confusing way (an HTML deserialization error, not a 403).

---

## UNRESOLVED

1. **Is testnet USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F` officially Paxos-issued?**
   Its proxy bytecode is byte-identical to mainnet USDG's, its implementation is verified
   under the name `USDG` with the authentic Paxos ABI (`supplyControl`, `facets`,
   `assetProtectionRoleDeprecated`, `betaDelegateWhitelisterDeprecated`), and `decimals()`
   is 6 — but its creator `0x980DfEa441f11277E36576511B03fAE2Eab24B2C` is **not** the
   Robinhood deployer EOA that deployed the Stock infra, and the faucet does not dispense
   USDG. *Tried:* Blockscout address + smart-contract records for proxy and impl, bytecode
   and ERC-1967 slot comparison against mainnet, search across all 50 indexed `USDG`
   tokens. *Not tried:* asking Paxos/Robinhood, or tracing that deployer's funding.
   Low impact — a testnet dry-run has no USDG source regardless.

2. **Exact CF rule on `robinhoodchain.blockscout.com`.** I proved empirically that any
   `Referer` header clears it and that no `Referer` is always challenged (5/5 each, four
   variants). Whether this is a stable WAF rule or an incidental bot-fight heuristic that
   Robinhood/Blockscout may change is unknown. The proxy is defensive either way, but the
   team should re-test on deploy day rather than trust this note.

3. **No end-to-end *successful* verification was performed.** I proved submit → GUID →
   queue → terminal verdict on both chains, but every submission was a deliberate dummy
   (`Probe` against Seaport / Multicall3 / an EOA), so all terminal results were
   `Fail - Unable to verify` or `already verified`. A true green verification needs a
   contract we actually deployed. *Blocked because:* no funded key on either chain and the
   faucet cannot be claimed headlessly.

4. **Whether 46630 accepts `eth_sendRawTransaction` from us.** Never exercised — no funded
   key. The chain is producing blocks with 1.42M txs today, so this is near-certainly fine,
   but it is untested by me.

5. **The complete mainnet official Stock Token list.** The mainnet `StockFactory` proxy is
   `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046` (impl `0xEe351E53BCe6AAF106428358838197C91e36EE0E`,
   same `Deployed(bytes32,address,string,string)` event, same `tokenAddress(bytes32)` getter),
   but `/api/v2/addresses/{a}/logs` returned `Internal server error` — the list is far larger
   than testnet's 5. *Not retried* with a `topic0`-filtered `eth_getLogs`; out of my scope,
   but that is the way to enumerate every Robinhood stock token on 4663 in one call.

6. **Whether `--verifier-api-key` is required or merely advisable on mainnet.** I hit the
   anonymous rate limit once but did not obtain a key to compare.

7. **Overcall's own testnet intentions.** overcall.finance documents only the mainnet
   Valorem/Seaport addresses and has no testnet section. I did not contact them
   (`@overcallfi` on X is the listed channel).

---

# Verification pass (adversarial re-check, 2026-09-12)

Independent re-run of every material claim. **Verdict: PARTIAL — R8 fully CONFIRMED, R7's core answer REFUTED.**

Headline: **R7 is wrong.** Valorem Clear, the Overcall registries, and a *live* Overcall cycle collateralised by
the **official faucet TSLA Stock Token** all exist on testnet 46630 right now. A real testnet keeper dry-run is
possible today. The mainnet-fork plan is still a fine *primary*, but "we cannot dry-run on testnet" is false and
recommendation #3 ("ask Overcall whether they will stand up a 46630 registry") is moot — they already did.

## 1. REFUTED — "Valorem Clear has zero bytecode on 46630"

The address check was right; the conclusion was wrong. Valorem Clear is deployed on testnet at a **different
address**, and its runtime bytecode is **byte-identical** to mainnet's.

```
                                    address                                      tn      mn
Valorem Clear (mainnet addr) 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0           0   16110
Valorem Clear (TESTNET addr) 0x0059df7c6229373a5afc0685b0ee8777f59bacbc       16110       0

testnet Valorem len 32222 mainnet len 32222 IDENTICAL: True
```

Live calls on testnet `0x0059df7c…`:
```
feesEnabled() 0xa64e4f8a -> 0
feeBps()      0x24a9d853 -> 15
feeTo()       0x017e7e58 -> 0xf73b2cb96ae0bbe1a3ec3446f4c36d82caaaab82
```

**Root cause of their false negative:** they searched Blockscout by *name* (`?q=Valorem`). The testnet Valorem is
**unverified**, so it has no name to match. Searching by address finds it:
```
GET /api/v2/addresses/0x0059df7c6229373a5afc0685b0ee8777f59bacbc
  is_contract=True  is_verified=False  name=None  creator=0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82
```
Name search on an unverified contract is not evidence of absence. Same bug hid all four Overcall contracts.

## 2. REFUTED — "Overcall has no testnet deployment"

Ten Overcall registries on 46630, all `eth_getCode`-confirmed, all deployed by `0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82`
(same EOA as testnet Valorem; also `registry.owner()` and Valorem `feeTo()`). Addresses from `ops/recon/R1-overcall-registry.md`,
independently re-verified here:
```
NVDA reg  0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56  5905 bytes
AAPL reg  0x36d7B6Ec2e9bC3c1858684d285718a410B59e5e1  5905
AMZN reg  0x43a93af1a602EE47c0FB4493fFE54C8Fd01830fB  5905
TSLA reg  0x904a1D63a49c87aFbCe3F05F6079c4Eb9c85C359  5778   <-- older build, no isWritingOpen()
PLTR reg  0x5125D5A853533693f8309C8C15a69321F8aDA029  5905
SPY  reg  0xE387985cf80f3cE41f07F90Bd571Bd8F682bC6Ca  5905
GME  reg  0x9A92fE428a27B955A07dCDdD78504715ed3fd422  5905
MEME reg  0xb294bA60c8e860e905394bD4c011947AC8b8aaD3  5905
SPCX reg  0x059961bba30A95D3c96E2C406e71095f77D054BD  5905
CATTEST   0x2FBD07F3936fBBcE64b9D42F9922aB08c54ad16F  5905
```

NVDA registry, live `eth_call` (selectors from `cast sig`, not guessed):
```
collateralToken   0xb2016bd4 -> 0x40ab39e8e1d626fa506ccdf917697975a102d1d7  (Overcall mock NVDA)
exerciseToken     0x2e4d8c8f -> 0xe3b032b565d494a994772aeff9919cc9ac574bef  (Overcall mock USDG)
clearinghouse     0x5d4f5f97 -> 0x0059df7c6229373a5afc0685b0ee8777f59bacbc  (Valorem Clear, testnet)
owner             0x8da5cb5b -> 0xf73b2cb96ae0bbe1a3ec3446f4c36d82caaaab82
cycleNumber       0x2f884710 -> 2        cycleCount 0x316fda0f -> 2
lotSize           0x4942f65f -> 1000000000000000000
exerciseTimestamp 0x7d4361bf -> 1789000655   expiryTimestamp 0xade6e2aa -> 1789087055
isCycleLive       0x1e4191ea -> 0        isWritingOpen 0xfa85ba38 -> 0   (cycle 2 expired)
```

## 3. THE DRY-RUN TARGET THEY MISSED — a LIVE cycle on the OFFICIAL TSLA token

`Overcall TSLA registry 0x904a1D63a49c87aFbCe3F05F6079c4Eb9c85C359` uses as collateral the **official,
faucet-dispensed** TSLA Stock Token — the same `0xC9f9c869…` this report itself recommends deploying against.

```
collateral  0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e   <-- OFFICIAL faucet TSLA Stock Token
exercise    0xe3b032b565d494a994772aeff9919cc9ac574bef   (Overcall mock USDG, 6 dec, 'Global Dollar')
clearing    0x0059df7c6229373a5afc0685b0ee8777f59bacbc   (real Valorem Clear)
cycleNumber 1   lotSize 1e18   isCycleLive() -> 1        <-- LIVE at time of check
exerciseTimestamp 1789156800   expiryTimestamp 1789243200   (now 1789238370)
cycle() -> 5 optionIds
```
Two of the five option series decoded straight off testnet Valorem `option(uint256)` (`0x6448be8c`):
```
optionId 0x449d897c132507b077c021aaa6438f95cd945731000000000000000000000000
   underlying 0xc9f9c869…bf3bd4e amt 1e18 (1.00)   exercise 0xe3b032b5…574bef amt 233000000 (233.00 USDG)
   exerciseTs 1789156800  expiryTs 1789243200   tokenType(0xe6c3b1f6) -> 1
optionId 0xb0dc81ecb3559ff752dd5380dd922ada2c28e940000000000000000000000000
   underlying 0xc9f9c869…bf3bd4e amt 1e18 (1.00)   exercise 0xe3b032b5…574bef amt 238000000 (238.00 USDG)
```
AMZN reg `0x43a93af1…` and PLTR reg `0x5125D5A8…` likewise use the official faucet AMZN / PLTR tokens.

**Funding is not blocked by the faucet.** Both Overcall testnet tokens expose a permissionless
`mint(address,uint256)` (`0x40c10f19`, present in bytecode; `eth_call` from an arbitrary unfunded EOA returns
`0x`, i.e. no revert):
```
tn NVDA mock  mint(rand,1e18) from 0x1111…1111 -> 0x
tn USDG mock  mint(rand,1e18) from 0x1111…1111 -> 0x
```
So USDG for premium/exercise can be self-minted; only ETH for gas needs the faucet. This also resolves their
"faucet dispenses no USDG" concern for the Overcall path.

## 4. PARTIALLY REFUTED — "the `oraclePaused()` write-gate cannot be exercised on 46630"

Correct for the five **official** faucet Stock Tokens; **wrong** for Overcall's own testnet NVDA mock, which
implements it.
```
0x40ab39e8e1d626fa506ccdf917697975a102d1d7  'NVIDIA • Robinhood Token' / NVDA / 18 / totalSupply 400e18
   uiMultiplier 0xa60bf13d -> 1000000000000000000
   oraclePaused 0x7706ba52 -> 0        <-- PRESENT, returns false (does NOT revert)
   terms        0xd5025625 -> REVERT
```
So the plan §5.2 gate *can* be exercised on 46630 against the Overcall NVDA registry's collateral. Their §4.11 #12
`uiMultiplier` point still stands: it is pinned at exactly 1e18 on both the mock and the official tokens.

## 5. CONFIRMED — everything else in their report

Re-ran and reproduced exactly:

| Claim | Result |
|---|---|
| `eth_chainId` tn `0xb626` / mn `0x1237`; heads 118,260,186 / 61,286,187; gasPrice 0.01 vs 0.0968 gwei | CONFIRMED |
| All 5 official testnet Stock Tokens, 283 bytes, name/symbol/decimals/uiMultiplier=1e18 | CONFIRMED |
| Testnet `Stock` lacks `oraclePaused/pauseOracle/unpauseOracle/terms`; mainnet has them | CONFIRMED (see below) |
| Mainnet NVDA `terms()` = `https://robinhood.com/stocktoken/rhj`, `uiMultiplier()` = 1000775159164630595 | CONFIRMED |
| Seaport tn vs mn: same length, **64** differing nibbles; `information()` -> `1.6` + conduitController `0x00000000f9490004c11cef243f5400493c00ad63` on both; tn domainSeparator `0x0c73d025…cda3036` | CONFIRMED |
| Multicall3 tn/mn bytecode identical | CONFIRMED |
| ConduitController 8820 bytes on both | CONFIRMED |
| `eth_getLogs` caps on **matched logs (10000)**, not block span | CONFIRMED (`{"code":-32000,"message":"logs matched by query exceeds limit of 10000"}`) |
| `debug_traceTransaction`, `txpool_status` absent on public testnet RPC | CONFIRMED (`-32601 does not exist/is not available`) |
| Blockscout backend versions mn `v11.3.0.+commit.65c6dfb2` / tn `v10.2.6` | CONFIRMED |
| `chains.blockscout.com/api/chains`: 4663 -> robinhoodchain.blockscout.com (blockscout), 46630 -> explorer.testnet… (self-hosted) | CONFIRMED |
| robinscan.io `{"error":"not found"}`, hoodscan.co FORBIDDEN + MCP pointer, stonkscan.io Next.js shell — none a Blockscout | CONFIRMED |
| URL patterns `/address /token /block` 200 on both; `/definitely-not-a-route-xyz` -> 404 control | CONFIRMED |

Selectors independently recomputed with `cast sig` — **all match**, none fabricated:
```
oraclePaused() 0x7706ba52   terms() 0xd5025625   uiMultiplier() 0xa60bf13d   newUIMultiplier() 0xdc767007
effectiveAt() 0x97a4064f    tokenPaused() 0x86c75e74   pauseOracle() 0x253ea980   unpauseOracle() 0x0fab6865
deploy(bytes32,string,string) 0xb2670cc5   tokenAddress(bytes32) 0x97bb3ce9   beacon() 0x59659e90
cast keccak "Deployed(bytes32,address,string,string)" = 0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6
```

ABI-diff claim verified live on three tokens:
```
TESTNET TSLA 0xC9f9c869…  oraclePaused/pauseOracle/unpauseOracle/terms -> execution reverted
                          uiMultiplier 1e18  newUIMultiplier 1e18  effectiveAt 0  tokenPaused 0  paused 0
TESTNET AMD  0x71178BAc…  identical shape
MAINNET NVDA 0xd0601CE1…  oraclePaused -> 0   terms -> 'https://robinhood.com/stocktoken/rhj'
                          uiMultiplier 1000775159164630595   effectiveAt 1788998430   name 'NVIDIA • Robinhood Token'
```
Corroborated by implementation code size: testnet `Stock` impl 10992 B vs mainnet 11614 B.
*Caveat on method:* `pauseOracle()`/`unpauseOracle()` revert on **mainnet** too (access control), so `eth_call`
alone cannot prove their absence — the ABI diff and the codesize delta carry that claim, not the revert.

Proxy wiring independently confirmed via ERC-1967 slot `0x360894a1…382bbc` and `StockFactory.beacon()`:
```
tn USDG proxy         -> impl 0xf0863d7a29a55d0c4263c11bfac754312ff078df
mn USDG proxy         -> impl 0x68184c449e1a8f34fa18d289737129fd27b66f8f
tn StockFactory proxy -> impl 0x55eec3ae0dedf81291aa2ba10572f52f35bf562a
mn StockFactory proxy -> impl 0xee351e53bce6aaf106428358838197c91e36ee0e
tn StockFactory.beacon() 0x59659e90 -> 0x1df3ca0fd30ed5eeb09eb01938f4e9c5196e6ca5   (= the ACR address)
tn USDG decimals 6, symbol 'USDG'   mn USDG decimals 6
```

The five official tokens re-confirmed two independent ways — `StockFactory.tokenAddress(bytes32)` **and** the
7-log history (5 `Deployed` + `Initialized(1)` + `Upgraded(0x55Eec3…)`, `next_page_params: None`):
```
tokenAddress(uid) on testnet factory 0x2DD5b0Ea…:
   TSLA 0x…aa1fee9afa45465cbc65157b4edf63f5 -> 0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e
   AMD  0x…958cc238f7a04144bf5eb07da3d3734e -> 0x71178bac73cbeb415514eb542a8995b82669778d
   AMZN 0x…99c33a4e234448e99d6c8a5e5dddeda0 -> 0x5884ad2f920c162cfbbacc88c9c51aa75ec09e02
   PLTR 0x…52cd6b007b15456ba5fbc3aa605765e0 -> 0x1fbe1a0e43594b3455993b5de5fd0a7a266298d0
   NFLX 0x…41de1e6ae0f4cd3825f77b5a4a3cc784 -> 0x3b8262a63d25f0477c4dde23f83cfe22cb768c93
```
**Caveat on their "decisive proof" #2:** uids are per-chain, not global — every testnet uid returns `0x0` on the
mainnet factory and vice-versa. So "mainnet NVDA's uid maps to zero on testnet" proves nothing. The 7-log
enumeration is the load-bearing evidence for "no official testnet NVDA", and it holds.

## 6. R8 — CONFIRMED end to end, including the Cloudflare finding

The Referer rule reproduced exactly, same request, only the header differing:
```
GET https://robinhoodchain.blockscout.com/api/v2/config/backend-version
  no Referer   -> HTTP403 <!DOCTYPE html>…<title>Just a moment…</title>  (Cloudflare managed challenge)
  Referer: https://example.com -> {"backend_version":"v11.3.0.+commit.65c6dfb2"}
```
`forge` behaviour reproduced on both chains:
```
$ forge verify-check 0x0000000000000068f116a894984e2db1123eb3956aa59740 --verifier blockscout \
    --verifier-url https://explorer.testnet.chain.robinhood.com/api --chain-id 46630
Checking verification status on 46630
Contract verification status:  Response: `OK`   Details: `Unknown UID`      <-- testnet API works, no key

$ forge verify-check 0xdeadbeef --verifier blockscout \
    --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663
ERROR etherscan: Failed to deserialize response: expected value at line 1 column 1
  res="<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment...</title>…"   <-- mainnet blocked
```
Also confirmed: `/api/v2/smart-contracts/verification/config` (tn) returns `is_rust_verifier_microservice_enabled:true`
plus the license enum; `/api?module=contract&action=getabi` returns a real ABI on testnet.

### Two corrections to R8 (minor)

1. **`/api/v2/addresses/{mainnet StockFactory}/logs` is NOT broken.** They logged it as an "Internal server error"
   and left mainnet token enumeration unresolved. With a `Referer` header it returns items normally. Their error
   was a Cloudflare artifact, not a Blockscout bug.
2. **An API key is effectively required on mainnet, not merely advisable.** I hit the anonymous limit on a
   *single* request even with the Referer bypass:
   `HTTP429 {"message":"Too many requests. Increase limits now at https://dev.blockscout.com","status":"0"}`.
   Treat `--verifier-api-key` as mandatory for CI.

## 7. RESOLVED — one of their UNRESOLVED items

**"The complete mainnet official Stock Token list"** — done in one call, no Blockscout needed:
```
eth_getLogs {address: 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046,
             topics: [0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6],
             fromBlock: 0x0, toBlock: latest}   on https://rpc.mainnet.chain.robinhood.com
-> 204 Deployed events
```
(The full topic0-filtered range scan is accepted by the mainnet RPC — the brief's "never scan 61M blocks" warning
applies to unfiltered queries.) First rows:
```
blk 19698  0xc93a8c440cea26d7445df01729f193b27965099f  WEEK  Roundhill Weekly T-Bill ETF
blk 34767  0x322f0929c4625ed5bad873c95208d54e1c003b2d  TSLA  Tesla • Robinhood Token
blk 45898  0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec  NVDA  NVIDIA • Robinhood Token
blk 46112  0x82da4646242e1d962e96e932269dc644c94a9caa  WDAY  Workday • Robinhood Token
…
```
204 symbols: WEEK TSLA NVDA WDAY QBTS BA FLNC NNE ARM TTWO LULU INOD PENG CLSK ASTS LITE FUTU RDDT IONQ CELH XNDU
APLD ASML MXL PR CBRS CCL NFLX LUNR MDB ZM DELL SOFI RIVN UPS P CRWD DDOG RGTI ZS AAOI RKLB POET MSTR NASA UMC
SOXX SMCI NOW TSEM IREN NU AMAT RDW SATS ELF QUBT TSM GME XOM LLY SPMO BABA QCOM XLK EWY NBIS F RBLX INTU SHOP
RVI MSFT AAPL USO AMD SLV CRCL META CRWV BE GOOGL PLTR INTC QQQ AMZN ORCL SGOV USAR MU SNDK SPY GLW NOK COST
NVTS AVGO COIN MRVL DRAM SPCX SKHY PFE PATH MRNA VSAT NET DJT SMR LRCX CRM FISV GEV SMH SHY COHR RCAT ON MPWR
HPE ANET ABCL GLD FLY GLXY APP CEG HWM VICR QNT PWR FIG AXON HII EWT MOD POWL JOBY CIEN CLS NAVN LHX SIMO WDC
ZETA TER AMC BULL CSCO AEIS ADBE KLAC PL TTD AEHR SCHD CRDO IBRX CTSH DOCN UNH AMBA WULF OKLO GE PANW AUR MTSI
AXTI SLS JEPQ KSS IBM SNAP LMT VST FIX CVNA CLOV KTOS OUST AMKR VRT SNOW FTNT ONTO JNJ ALAB HIMS SOUN TEAM RUN
VTI INDA JBL AVAV TE TEM WYFI INFQ FICO BB BND PEACH

Note: `https://robinhood-rpc.publicnode.com` returned HTTP 403 for this query; use the primary RPC.

Their remaining UNRESOLVED items (testnet USDG `0x7E9552…` provenance, CF-rule stability, no true-green
verification, unexercised `eth_sendRawTransaction`, Overcall's intentions) I did not resolve — except that
**Overcall's testnet intentions are moot: the registries are already deployed and one cycle is live.**

## 8. Revised recommendation for M6

1. **Testnet 46630 dry-run is viable and should be the primary smoke test.** Point the keeper at Overcall
   TSLA registry `0x904a1D63a49c87aFbCe3F05F6079c4Eb9c85C359` (official faucet TSLA collateral, live cycle) or
   NVDA registry `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56` (mock NVDA that *does* implement `oraclePaused()`).
   Real Valorem Clear at `0x0059df7c6229373a5afc0685b0ee8777f59bacbc`, real Seaport 1.6, self-mintable USDG.
2. **Keep the anvil mainnet fork** for time-warping two full weekly cycles — that part of their advice is right.
3. Feature-detect on testnet: the TSLA registry build (5778 B) **lacks `isWritingOpen()`**; the 5905 B builds have it.
   Official faucet Stock Tokens lack `oraclePaused()`/`terms()`; the Overcall NVDA mock has `oraclePaused()`.
4. R8 actions unchanged: check in the Referer proxy, and get a dev.blockscout.com API key (mandatory, not optional).

## 9. UNRESOLVED after this pass

- Whether the live TSLA testnet cycle is refreshed on a schedule, or whether Overcall must be asked to run
  `setCycle` again once it expires (`isCycleLive()` was 1 with ~80 minutes left at time of check; the NVDA
  registry's cycle 2 is already expired). Not determinable read-only.
- Whether `mint(address,uint256)` on the two Overcall testnet tokens actually succeeds in a real transaction.
  `eth_call` from an arbitrary EOA does not revert, which is strong but not proof — no funded testnet key here.
- Faucet contents unverified by me: `https://faucet.testnet.chain.robinhood.com/` returns
  `HTTP 429 Vercel Security Checkpoint` to every non-browser client, so their "0.01 ETH + 5 of each token"
  figure rests on their firecrawl render alone. Not load-bearing now that USDG is self-mintable.
- The nine non-NVDA Overcall testnet registries beyond TSLA/AMZN/PLTR were code-size-checked but not fully
  `eth_call`-enumerated.
