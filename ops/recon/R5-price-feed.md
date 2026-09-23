# R5 — Spot price source on Robinhood Chain 4663 for the OTM band gate

**Status: ANSWERED.** Chainlink has a live, production `AggregatorV3Interface` NVDA/USD feed on chain 4663.
Use it for display + the OTM band gate. It is **not** safe to use a naive 24 h staleness rule — see §5.

Recon run: 2026-09-12 ~18:00–18:30 UTC. Chain head at time of run: block `61,317,390` (`eth_blockNumber` → `0x3a79d32`), `eth_chainId` → `0x1237` (4663).

---

## 0. TL;DR / what goes in `ops/addresses.json`

```jsonc
{
  "4663": {
    "nvdaUsdFeed":            "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", // AggregatorProxy, phaseId 1  — USE THIS
    "nvdaUsdFeedSecondary":   "0xCF169363636D73dbBf77733629CB38919d14232d", // AggregatorProxy, phaseId 2  — SVR twin, identical data
    "nvdaUsdAggregator":      "0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2", // DualAggregator 1.0.0 (do not bind to this; it rotates)
    "usdgUsdFeed":            "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", // AggregatorProxy, "USDG / USD", 8dp
    "sequencerUptimeFeed":    null,                                         // DOES NOT EXIST on 4663
    "dataStreamsVerifierProxy":"0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7", // alt. pull-based source, 7009 bytes, unused by us
    "nvdaStockToken":         "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    "nvdaStockTokenBeaconAndRegistry": "0xe10b6f6b275de231345c20d14ab812db62151b00",
    "nvdaStockTokenImplementation":    "0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2"  // verified "Stock" 0.8.33
  },
  "46630": {
    "nvdaUsdFeed":         "0xcac7742b5542F155efCbD1dfA3F2DFda8dE90CB5", // MOCK aggregator, permissionless setAnswer()
    "nvdaUsdFeedAlt":      "0xb85e225E34c695Ea7092e35d548121DA276c8130", // second MOCK in Overcall's `feeds` map
    "sequencerUptimeFeed": "0x86301F34D3F29805A6784FB20A5B36374814A040"  // MOCK "L2 Sequencer Uptime Status Feed"
  }
}
```

Interface (byte-for-byte what Overcall's own frontend uses, and what I called on-chain):

```solidity
interface IAggregatorV3 {
    function decimals() external view returns (uint8);           // 8
    function description() external view returns (string memory);// "RHNVDA / USD"
    function version() external view returns (uint256);          // 6
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId) external view returns (
        uint80, int256, uint256, uint256, uint80);
}
```

---

## 1. Does Chainlink have feeds on 4663? — YES, 57 of them

Chainlink's own reference-data-directory (the JSON that backs `docs.chain.link/data-feeds/price-feeds/addresses`)
publishes a Robinhood Chain mainnet file. Slug discovery (other guesses 404):

```
$ for n in robinhood robinhood-mainnet ethereum-mainnet-robinhood-1 robinhood-chain-mainnet; do
    curl -s -o out -w '%{http_code}' https://reference-data-directory.vercel.app/feeds-$n.json; done
robinhood                          -> 404
robinhood-mainnet                  -> 200  size=81235
ethereum-mainnet-robinhood-1       -> 404
robinhood-chain-mainnet            -> 404
```

Summary of `feeds-robinhood-mainnet.json` (57 entries):

```
feeds total: 57
sequencer/uptime entries: 0            <-- NO L2 sequencer uptime feed on 4663
marketHours: {'us_equities_24/5': 35, 'Crypto': 22}
heartbeats:  {86400: 57}               <-- every feed declares 86400 s
thresholds:  {0.5: 52, 0.05: 5}        <-- 0.5 % deviation on all price feeds
decimals:    {8: 52, 18: 5}
contractVersion: {6: 57}
```

No testnet file exists — `feeds-robinhood-testnet.json`, `feeds-robinhood-sepolia.json`,
`feeds-ethereum-testnet-sepolia-robinhood-1.json` all 404.

### The NVDA record, verbatim from the directory

```json
{
 "contractAddress": "0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2",
 "contractVersion": 6,
 "heartbeat": 86400,
 "multiply": "100000000",
 "name": "Robinhood NVDA / USD",
 "path": "robinhood-nvda-usd-shared-svr",
 "proxyAddress": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
 "secondaryProxyAddress": "0xCF169363636D73dbBf77733629CB38919d14232d",
 "threshold": 0.5,
 "assetName": "Nvidia (Robinhood Tokenized Equity)",
 "feedCategory": "custom",
 "docs": {
   "assetClass": "Equity", "baseAsset": "NVDA", "quoteAsset": "USD",
   "blockchainName": "Robinhood", "marketHours": "us_equities_24/5",
   "productSubType": "calculatedPrice", "productTypeCode": "primaryTokenizedPrice",
   "clicProductName": "NVDA/USD-RefPrice-DF-Robinhood-001"
 },
 "decimals": 8,
 "maxSubmissionValue": "95780971304118053647396689196894323976171195136475135"
}
```

---

## 2. On-chain confirmation (this is the load-bearing evidence)

All calls via `https://rpc.mainnet.chain.robinhood.com`, cross-checked against
`https://robinhood-rpc.publicnode.com` (byte-identical result — see §5.4).

```
==============================================================================
Robinhood NVDA/USD proxyAddress 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15  codesize: 9571
  decimals()                 8
  description()              'RHNVDA / USD'
  version()                  6
  latestRoundData()          roundId=18446744073709552641 answer=21829793457 (=218.2979 @8dp)
                             startedAt=1789157011 updatedAt=1789157023
                             (2026-09-11T20:03:43Z, age=79554s) answeredInRound=18446744073709552641
  aggregator()               0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2
  phaseId()                  1
  owner()                    0xee27d5ae494300902d90454e8630a3f1c68c9c52   (contract, 171 bytes)
  latestAnswer()             21829793457
  latestTimestamp()          1789157023
  latestRound()              18446744073709552641  (0x1_0000000000000401 = phase 1 << 64 | 1025)
  proposedAggregator()       0x0000000000000000000000000000000000000000
  accessController()         0x0000000000000000000000000000000000000000   <-- NO READ GATE
==============================================================================
Robinhood NVDA/USD secondaryProxyAddress 0xCF169363636D73dbBf77733629CB38919d14232d  codesize: 9571
  decimals()                 8
  description()              'RHNVDA / USD'
  version()                  6
  latestRoundData()          roundId=36893488147419104257 answer=21829793457 startedAt=1789157011
                             updatedAt=1789157023 answeredInRound=36893488147419104257
  aggregator()               0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2
  phaseId()                  2
  accessController()         0x0000000000000000000000000000000000000000
==============================================================================
Robinhood NVDA/USD contractAddress(aggregator) 0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2  codesize: 23186
  typeAndVersion()           'DualAggregator 1.0.0'
  decimals()                 8
  description()              'RHNVDA / USD'
  version()                  6
  latestRoundData()          roundId=1025 answer=21829793457 startedAt=1789157011 updatedAt=1789157023
  minAnswer()                1
  maxAnswer()                0x00000000000000000000ffffffffffffffffffffffffffffffffffffffffffff  (2^192-1, i.e. effectively unbounded)
  checkEnabled()             true   (aggregator-level access controller; the PROXY has none)
  aggregator()/phaseId()     revert  (it is the aggregator, not a proxy)
```

Fresh re-read at 2026-09-12T18:28:12Z, both RPCs, identical:

```
0x0000...0001000000000000040100000000...05152836b1...6aa45e93...6aa45e9f...0000000000000401
 roundId 0x1_0000000000000401 | answer 0x5152836b1 = 21829793457 | startedAt 0x6aa45e93 | updatedAt 0x6aa45e9f
```

### 2.1 The two proxies are byte-identical `AggregatorProxy` contracts

```
0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15  bytes 9571  sha256(code)=53ca1c4d67c7b092f36c66e575874226
0xCF169363636D73dbBf77733629CB38919d14232d  bytes 9571  sha256(code)=53ca1c4d67c7b092f36c66e575874226
```
Both expose `aggregator() proposeAggregator(address) confirmAggregator(address) proposedLatestRoundData()
proposedGetRoundData(uint80) phaseId() phaseAggregators(uint16) accessController() setController(address)
owner() transferOwnership acceptOwnership` plus the AggregatorV3 + legacy V2 read surface.
They differ only in `phaseId()` (1 vs 2), which changes the high 64 bits of `roundId`.
Both currently point at the same `DualAggregator` and return the same `answer`/`updatedAt`.

`path: "robinhood-nvda-usd-shared-svr"` and `typeAndVersion() == "DualAggregator 1.0.0"` mean this is a
Chainlink **SVR (Smart Value Recapture)** deployment: the aggregator has two transmit entrypoints,
`transmit(...)` and `transmitSecondary(...)`, plus `setCutoffTime(uint32)`. Per Chainlink's SVR docs the SVR
route adds "a small, configurable delay to allow for the MEV-Share auction" and falls back to the public
route. **Overcall binds to `0x379EC4f7…` (the directory's `proxyAddress`)** — see §4 — so we do too.

### 2.2 A contract CAN read the feed (no `SimpleReadAccessController` trap)

`accessController()` is `address(0)` on both proxies, so the `AggregatorProxy.checkAccess` modifier is a
no-op. Proven empirically by routing the call through **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11`
so that `msg.sender` is a contract and `tx.origin != msg.sender`:

```
multicall3.aggregate3([ (0x379EC4f7…, true, latestRoundData()),
                        (0xC9d16E4f…, true, latestRoundData()) ])  -> err: None
  [0] proxy 0x379E...      success=True len=160  answer=21829793457 updatedAt=1789157023
  [1] aggregator 0xC9d1... success=True len=160  answer=21829793457 updatedAt=1789157023
```

So `Policy`/`Vault` can call `latestRoundData()` directly. No allowlisting handshake needed.

### 2.3 USDG / USD feed (for USD display of premium, if we want it)

```
USDG/USD proxyAddress 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2  codesize=9571
  decimals()  8   description() 'USDG / USD'   version() 6
  aggregator() 0x8beee3503f6860d5dac4ce26b5eee92982951c2e   phaseId() 1   accessController() 0x0
  latestRoundData() roundId=18446744073709551716 answer=99995060 startedAt=1789227192
                    updatedAt=1789227205 (Sat 2026-09-12 15:33:25Z, age=10104s)
USDG/USD secondaryProxyAddress 0x901f56689360B89D7767a8acE28B7801e6348fa2 — identical, phaseId 2
```
USDG = $0.9999506. Note it updated **Saturday 15:33 UTC** — crypto feeds keep running over the weekend; only
the `us_equities_24/5` feeds pause. (ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` likewise fresh,
`answer=252950650000`, `updatedAt` Sat 17:21 UTC.)

---

## 3. What the Stock Token exposes — NO price getter. `oraclePaused()` is NOT a price oracle.

### 3.1 Proxy chain

```
eth_getStorageAt(0xd0601CE1…, 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50)  // EIP-1967 beacon slot
  -> 0x...e10b6f6b275de231345c20d14ab812db62151b00
eth_getStorageAt(…, 0x360894…bbc /*impl*/) -> 0x0
eth_getStorageAt(…, 0xb53127…103 /*admin*/) -> 0x0
beacon.implementation() (0x5c60da1b) -> 0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2   (11614 bytes)
token.ACCESS_CONTROLLED_REGISTRY() -> 0xe10b6f6b275de231345c20d14ab812db62151b00   (same address as the beacon)
```

### 3.2 Full selector set of the implementation (PUSH4 scan of `0xb35490…`, resolved via openchain.xyz)

```
supportsInterface(bytes4) adminBurn(address,uint256) name() approve(address,uint256) unpauseOracle()
IsPaused() totalSupply() transferFrom(...) pauseOracle() decimals() DOMAIN_SEPARATOR() unpause()
mint(address,uint256) balanceOfUI(address) Panic(uint256) ACCESS_CONTROLLED_REGISTRY()
setMetadata(string,string) paused() updateMultiplier(uint256) balanceOf(address) Blocked(address)
oraclePaused() nonces(address) initialize(bytes32,string,string) pause() eip712Domain()
tokenPaused() hasRole(bytes32,address) symbol() effectiveAt() totalSupplyUI() burn(address,uint256)
uiMultiplier() transfer(address,uint256) updateMultiplier(uint256,uint256) terms()
newUIMultiplier() allowance(address,address) uid() permit(...) isBlocked(address)
+ OZ v5 ERC20/AccessControl/ECDSA custom errors
```

**There is no `price()`, `getPrice()`, `latestPrice()`, `oracle()` or `priceOracle()` anywhere in the token.**

### 3.3 Live values on the NVDA token

```
name()              'NVIDIA • Robinhood Token'
symbol()            'NVDA'
decimals()          18
totalSupply()       0x144aa276f67e09eb3c00 = 95824.09553415001 NVDA
totalSupplyUI()     0x144ea94ab8009e7a695d = 95898.37445999573
oraclePaused()      false
tokenPaused()       false
paused()            false
uiMultiplier()      0x0de377b4760af643 = 1000775159164630595 (1.000775159164630595e18)
newUIMultiplier()   same
effectiveAt()       0x6aa1f31e = 1788998430 = 2026-09-10T00:00:30Z  (already in the past)
ACCESS_CONTROLLED_REGISTRY() 0xe10b6f6b275de231345c20d14ab812db62151b00
terms()             'https://robinhood.com/stocktoken/rhj'
uid()               0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5
```

### 3.4 Verified source — definitive reading of `oraclePaused()`

Blockscout (`robinhoodchain.blockscout.com`) is behind a Cloudflare interstitial for both `curl` and WebFetch
(HTTP 403 / "Just a moment…"). **`robinscan.io` serves verified source at a non-Blockscout path** that works:

```
GET https://robinscan.io/api/contracts/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2
{"address":"0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2","isVerified":true,"matchType":"full",
 "name":"Stock","language":"Solidity","compilerVersion":"0.8.33+commit.64118f21","evmVersion":"cancun",
 "optimizationEnabled":true,"optimizationRuns":200,"licenseType":"MIT",
 "verifiedAt":"2026-09-08T09:42:53Z","sourceFiles":[33 files],"abi":[65 entries],
 "constructorArgs":"0x000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00"}
```
(Note: `robinscan.io/api/v2/smart-contracts/…` returns `{"error":"not found"}` — the working path is
`/api/contracts/{address}`. `hoodscan.co` returns empty, `stonkscan.io` returns its SPA shell.)

`src/OraclePausable.sol`, complete:

```solidity
abstract contract OraclePausable is IOraclePausable {
    /// @custom:storage-location erc7201:robinhood.storage.OraclePausable
    struct OraclePausableStorage { bool oraclePaused; }
    bytes32 private constant OraclePausableStorageLocation =
        0x50204cc2d5276a366b2f6a19361d0f388c29e773a6f6aa2c92cfb0dc04a5fe00;
    function oraclePaused() public view returns (bool) { ... return $.oraclePaused; }
    function _pauseOracle()   internal { $.oraclePaused = true;  emit OraclePaused(); }
    function _unpauseOracle() internal { $.oraclePaused = false; emit OracleUnpaused(); }
}
```

`src/Stock.sol` — the only two uses of it:

```solidity
function pauseOracle()   external onlyRole(ORACLE_PAUSER_ROLE) { _pauseOracle();   }
function unpauseOracle() external onlyRole(ORACLE_PAUSER_ROLE) { _unpauseOracle(); }
```

**Conclusion:** `oraclePaused()` is an *inert advisory flag*. It gates nothing inside the token — not transfers,
not mint/burn, not `updateMultiplier`. It is Robinhood's out-of-band signal ("stop trusting the published price
for this token"). It is still the right thing for our Policy to gate on, but the TECHSPEC's framing ("the token
has an oracle") is wrong: **the token's only oracle is the corporate-action / multiplier oracle, and this flag is
just a broadcast switch.** The USD price lives entirely in Chainlink.

For completeness, the real token-level kill switches (relevant to R6, not R5):

```solidity
function paused() public view returns (bool) {              // gates transfer/transferFrom/approve/permit/mint/burn
    return $.paused || IAccessControlsRegistry(ACCESS_CONTROLLED_REGISTRY).paused();
}
function tokenPaused() public view returns (bool) { return $.paused; }   // token-local half only
modifier onlyNotBlocked(address a)                          // registry.isBlocked(a)
function adminBurn(address from, uint256 amount) onlyRole(ADMIN_BURNER_ROLE)   // NOT gated by paused()
```

### 3.5 The multiplier is baked into the Chainlink answer

Robinhood docs, `docs.robinhood.com/chain/stock-tokens/`: the multiplier is exposed via `uiMultiplier()`
"defined by ERC-8056 (Scaled UI Amount Extension)", and "the oracle automatically incorporates the multiplier
into the price." Chainlink docs, `docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood`:

> **Token Price = Underlying Equity Market Price × Multiplier** … the multiplier "accounts for dividend
> reinvestments and corporate action adjustments", read from the Robinhood token contract via `uiMultiplier()`.

So the feed's `answer` is USD **per one raw 18-decimal Stock Token**, i.e. exactly the unit Overcall's strikes
are quoted in. **Do not apply `uiMultiplier()` again in the OTM math** — you would double-count.
(Caveat: today's multiplier is 1.000775, only 7.8 bps from 1.0, so I could not *empirically* separate
"answer includes the multiplier" from "answer is the raw equity price". The claim rests on the two doc
statements above, which agree with each other, plus §4.2's Overcall code which does no multiplier adjustment.)

---

## 4. What Overcall itself uses — the Chainlink proxy, same address

Pulled from Overcall's production Next.js bundle (`https://overcall.finance` → `/_next/static/chunks/*.js`).

### 4.1 Their address book, chunk `13i994ge4sv4e.js`, key `4663`

```js
NVDA:"0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
NVDA_FEED:"0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
USDG:"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
USDG_FEED:"0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
STOCK_IMPLEMENTATION:"0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2",
SEQUENCER_UPTIME_FEED:"0x0000000000000000000000000000000000000000",   // <-- explicitly zero on mainnet
MULTICALL3:"0xcA11bde05977b3631167028862bE2a173976CA11",
clearinghouse:"0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
seaport:"0x0000000000000068F116a894984e2DB1123eB395",
feeTo:"0xdAe7e82A2E7D566C67E87C164B05a1C560190782",
lotSize:1e18,
feeds:{ AAPL:"0x6B22A786…", …, NVDA:"0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", …,
        _note:"Chainlink's reference-data-directory publishes 57 feeds for this chain
               (feeds-robinhood-mainnet.json); 34 of them pair with an active Stock Token.
               Verified live 2026-09-10."},
registries:{ NVDA:"0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA", … },   // ← also answers part of R1
registry:"0x65dD407955912Be814f723724cE60f91ebd72616",
registryOwner:"0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0",
rpc:"https://rpc.mainnet.chain.robinhood.com",
explorer:"https://robinhoodchain.blockscout.com",
tokenURIGenerator:"0xE53cCB924d27f421a91b59087587fD866C5d64c7",
valoremDeployedAt:0x6aa298a9   // = 1789102249 = 2026-09-11T04:50:49Z
```

Every feed address in their `feeds` map matches the directory's `proxyAddress` column, not
`secondaryProxyAddress`. **Overcall reads the primary proxy.**

Their resolver (chunk `0dj8ov5mmi8e5.js`):
```js
feed: u.feed ?? s(t,"NVDA_FEED","nvdaFeed")
```

### 4.2 Their read + staleness rule (chunk `0dj8ov5mmi8e5.js`)

```js
let i = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)"
]);
e.s(["aggregatorV3Abi",0,i,
     "isSpotStale",0, function(e,t){ return t - 1e3*Number(e.updatedAt) > n.FEED_STALE_AFTER_MS }], 874291);
...
e.s(["FEED_STALE_AFTER_MS", 0, 72e5, ...], 598409);     //  7_200_000 ms = 7200 s = 2 HOURS
```

and the hook that builds the ladder:

```js
A = useReadContracts({contracts:[
      {address:e.feed, abi:aggregatorV3Abi, functionName:"latestRoundData"},
      {address:e.feed, abi:aggregatorV3Abi, functionName:"decimals"}]}),
j = useMemo(()=>{ let[,n,,i]=e.result; if(!(n<=0n)) return {answer:n, decimals:t.result, updatedAt:i} }),
...
C = j ?? Z,                                   // Chainlink first; Z = UniV3 TWAP fallback (memecoin markets only)
return { spot: C, spotStale: isSpotStale(C, Date.now()), ... }
```

Notes:
- `j` already drops non-positive answers (`if(!(n<=0n))`) — same `answer > 0` guard we need.
- The **UniswapV3 TWAP fallback (`Z`) is only wired for `pools:{CASHCAT,PONS,AI,JUGGERNAUT}`** (memecoin
  markets, `twapSeconds: 1800`, `quoteFeed` = ETH/USD `0x78F3556b…`, `POOL_PRICE_DECIMALS = 8`). There is
  **no pool entry for NVDA**, so for our market Chainlink is the only source Overcall has.
- `spotStale` is **display only** — `isWritable(cycle, now, n) { return "open"===cycleState(cycle,now) && !n }`
  does not consult it. Overcall will happily let you write against a 50-hour-old price.

### 4.3 Decimals convention, from their own math

```js
"strikePerToken6", 0, function(e,n){ return n<=0n ? 0n : e*BigInt("1000000000000000000")/n }
//   = exerciseAmount * 1e18 / underlyingAmount   -> USDG (6 dp) per 1e18 raw collateral

"moneynessPct",   0, function(e,n){ if(n<=0n) return; let i = n/BigInt(100);
                                    if(!(i<=0n)) return Number((e-i)*BigInt(1e6)/i)/1e4 }
//   e = strikePerToken6 (6dp);  n = Chainlink answer (8dp);  i = n/100 = spot in 6dp
//   moneyness% = (strike6 - spot6) / spot6 * 100

"NVDA_DECIMALS", 0, 18
"formatSpot",  e => formatUnits(e, 8)      // spot printed at 8 dp
"formatUsdg",  e => formatUnits(e, 6)      // USDG at 6 dp
```

**Chainlink `answer` ÷ 100 == strike in USDG-6dp.** No `uiMultiplier` term anywhere in the comparison.

### 4.4 End-to-end validation against the live NVDA rung ladder

`registry(NVDA).cycle()` → `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`, selector `0x6190c9d5`,
decoded as `(uint32 number, uint40 exerciseTimestamp, uint40 expiryTimestamp, uint96 lotSize, uint256[] optionIds)`;
each id then through Valorem Clear `option(uint256)` `0x6448be8c`:

```
cycle.number=1  exerciseTimestamp=1789761600 (2026-09-18 20:00:00Z)
                expiryTimestamp  =1789848000 (2026-09-19 20:00:00Z)  lotSize=1000000000000000000
feed answer(8dp)=21829793457 -> spot6=218297934 ($218.297934)

optionId=113025628429828481228850936737953628080486640605422851339090182744894714413056
   underlying=0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec underlyingAmount=1000000000000000000
   exercise  =0x5fc5360d0400a0fd4f2af552add042d716f1d168 exerciseAmount=226000000
   strikePerToken6=226000000 ($226.0000)  moneyness=+3.528%
optionId=29652592033419692000166847561911668028189801263392568326594311383797020491776
   exerciseAmount=231000000  strikePerToken6=231000000 ($231.0000)  moneyness=+5.819%
optionId=13956151908388063551378518883460877979717043668997816139085862263440384458752
   exerciseAmount=236000000  strikePerToken6=236000000 ($236.0000)  moneyness=+8.109%
optionId=8012928620938394388054169085135774622795258770514699139381494411582911807488
   exerciseAmount=241000000  strikePerToken6=241000000 ($241.0000)  moneyness=+10.400%
optionId=56885395977254369119998982131173877604217583767740146085872832926902011297792
   exerciseAmount=246000000  strikePerToken6=246000000 ($246.0000)  moneyness=+12.690%
```

Five rungs, $5 apart, $226–$246 against a $218.30 spot. Under the TECHSPEC launch policy
(`minOtmBps=300`, `maxOtmBps=1200`) rungs 1–4 are eligible and rung 5 (+12.69 %) is excluded.
**The decimals convention is confirmed end-to-end: `answer/100` compares directly to `strikePerToken6`.**

---

## 5. Staleness / heartbeat semantics — THE THING THAT WILL BITE US

The declared `heartbeat` is 86400 s and the deviation threshold is 0.5 %. **The 86400 s heartbeat is NOT honoured
while the US equity market is closed.** `marketHours: "us_equities_24/5"` means the feed simply stops.

### 5.1 Recent rounds, straight off `getRoundData(uint80)` on `0xC9d16E4f…`

```
roundId   answer(8dp)      updatedAt UTC              delta_s
  1016     219.7152   Fri 2026-09-11 06:14:53   25808
  1017     220.9719   Fri 2026-09-11 12:52:35   23862
  1018     219.7302   Fri 2026-09-11 13:32:36   2401
  1019     220.9011   Fri 2026-09-11 13:54:06   1290
  1020     222.0393   Fri 2026-09-11 14:28:07   2041
  1021     220.7460   Fri 2026-09-11 14:32:37   270
  1022     219.5004   Fri 2026-09-11 14:55:37   1380
  1023     220.6309   Fri 2026-09-11 15:18:08   1351
  1024     219.4800   Fri 2026-09-11 16:19:09   3661
  1025     218.2979   Fri 2026-09-11 20:03:43   13474      <-- LAST ROUND. Nothing since.
```

### 5.2 The weekend gaps (scanned rounds 880–1025)

```
   930     218.1555   Fri 2026-08-28 19:56:29   3662
   931     216.3750   Mon 2026-08-31 00:00:54   187465   <== GAP  (52 h 04 m)
   932     217.5750   Mon 2026-08-31 00:36:54   2160

   994     230.2366   Fri 2026-09-04 17:46:24   8094
   995     231.0808   Tue 2026-09-08 00:00:54   281670   <== GAP  (78 h 14 m — Labor Day Mon 2026-09-07)
   996     232.4050   Tue 2026-09-08 01:44:56   6242
```

Largest *intra-week* gap observed in the same window: **63,394 s (17 h 37 m)** (round 1006,
Tue 2026-09-08 16:19 → Wed 2026-09-09 09:56). So during the trading week a ~24 h rule holds; across a
weekend it does not, by a factor of 2–3.

Both restarts land on **00:00:54 UTC Monday/Tuesday** = 20:00 ET Sunday/Monday — the start of the
`24/5` week.

### 5.3 Where we are right now, and why it matters for `rollOpen`

```
now                  2026-09-12 18:28:15Z (Saturday)
feed updatedAt       2026-09-11 20:03:43Z (Friday)
age                  80,672 s = 22.41 h    (already > Overcall's own 2 h staleness label)
projected age at the next likely update (Mon 2026-09-14 00:00:54Z): 187,031 s = 51.95 h
```

And the Overcall cycle is **already `open` right now**:
`cycleState(cycle, now) = now >= expiry ? "expired" : now >= exerciseTimestamp ? "exercise-window" : "open"`.
Cycle 1's `exerciseTimestamp` is Fri 2026-09-18 20:00 UTC, so the write window for cycle 1 is live
across this entire weekend, during which the feed is 22–52 h old.

**Consequence:** a Policy check of the form `require(block.timestamp - updatedAt <= 86400)` would have
blocked `rollOpen` for the whole of Saturday-afternoon → Monday-00:00 every single week, and for ~78 h over a
3-day holiday weekend. If the keeper's schedule puts `rollOpen` anywhere in the weekend, a 24 h rule is a
guaranteed "skip week, 0 % premium".

### 5.4 Two RPCs agree

```
$ curl … https://rpc.mainnet.chain.robinhood.com   -> 0x…0401…05152836b1…6aa45e93…6aa45e9f…0401
$ curl … https://robinhood-rpc.publicnode.com      -> 0x…0401…05152836b1…6aa45e93…6aa45e9f…0401
```
Byte-identical. The staleness is the feed's, not an RPC artifact.

### 5.5 No L2 sequencer uptime feed on 4663

`feeds-robinhood-mainnet.json` contains zero sequencer/uptime entries, and Overcall hardcodes
`SEQUENCER_UPTIME_FEED: 0x0000…0000` for 4663. The standard Arbitrum-style
`sequencerUptimeFeed.latestRoundData()` + grace-period guard **cannot be implemented on mainnet 4663**.
Partial mitigation: 4663 is an Orbit L2 whose `block.timestamp` advances with the sequencer, so if the
sequencer stalls our age check stalls with it (it will not falsely read "fresh" against wall-clock — but it
also will not detect a stall). A testnet mock uptime feed *does* exist (§6), so code written against the
interface can at least be exercised on 46630.

---

## 6. Testnet 46630 — Chainlink is NOT there; Overcall deployed mocks

`eth_chainId` on `https://rpc.testnet.chain.robinhood.com/rpc` → `0xb626` (46630). ✔

```
==============================================================================
46630 NVDA_FEED (Overcall config)  0xcac7742b5542F155efCbD1dfA3F2DFda8dE90CB5  codesize=1668
  decimals() 8   description() 'RHNVDA / USD'   version() 6
  aggregator()/phaseId()/accessController() -> execution reverted   (not an AggregatorProxy)
  latestRoundData() roundId=2 answer=22589000000 startedAt=1788906212 updatedAt=1788906212
                    (Tue 2026-09-08 22:23:32Z, age=331147s = 92 h)
==============================================================================
46630 feeds.NVDA (Overcall config)  0xb85e225E34c695Ea7092e35d548121DA276c8130  codesize=1668
  decimals() 8   description() 'RHNVDA / USD'   version() 6
  latestRoundData() roundId=1 answer=22348480000 updatedAt=1788984539
                    (Wed 2026-09-09 20:08:59Z, age=252820s = 70 h)
==============================================================================
46630 SEQUENCER_UPTIME_FEED  0x86301F34D3F29805A6784FB20A5B36374814A040  codesize=1156
  decimals() 0   description() 'L2 Sequencer Uptime Status Feed'   version() 1
  latestRoundData() roundId=1 answer=0 startedAt=1788906219 updatedAt=1788906219   (answer 0 = sequencer UP)
```

Mock ABI (PUSH4 scan of `0xcac7742b…`, resolved):

```
latestRoundId()                                            0x11a8f413
setRound(uint80,int256,uint256,uint256,uint80)             0x299e23bc
setAnswer(int256,uint256)                                  0x860f1383
setDecimals(uint8)                                         0x7a1395aa
decimals() version() description() getRoundData(uint80) latestRoundData()
error NoDataPresent(uint80)                                0xebb8bb1f
```

No `owner()`, no `hasRole`, no access-control selector at all ⇒ **`setAnswer` looks permissionless.** Excellent
for M3 keeper dry-runs (we can warp the price deterministically), and a hard rule that testnet spot is
**not** a trust anchor. Note the two testnet addresses disagree with each other ($225.89 vs $223.48) and both
are days stale — Overcall's resolver prefers `NVDA_FEED` (`0xcac7742b…`).

Overcall testnet config also carries `USDG:"0xe3B032b565d494A994772AEFF9919CC9AC574bEF"`,
`clearinghouse:"0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc"`,
`registries.NVDA:"0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56"`,
`registry:"0x2FBD07F3936fBBcE64b9D42F9922aB08c54ad16F"`, `mocksDeployedAt:0x6aa08ae4` (2026-09-08T12:59:48Z).
(Those belong to R1/R7; recorded here because they came from the same object.)

---

## 7. Alternative / secondary source: Chainlink Data Streams

`docs.robinhood.com/chain/data-streams/` names a **Verifier Proxy on 4663:
`0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7`** — confirmed to have bytecode:

```
0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7 codesize=7009
```

Data Streams is pull-based: a keeper fetches a signed report off-chain and calls `verify()` on-chain. It would
give us a fresh price on a Saturday when the Data Feed is asleep — **but only if the stream itself publishes
outside equity hours, which I did not verify, and the report/feed-ID for RHNVDA is not in any page I could
reach.** Recorded as an option, not a recommendation. **UNRESOLVED** (§9).

---

## 8. Recommendation for `Policy`

Use `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` (`AggregatorV3Interface`, 8 decimals), read-gate only,
never in the settlement path — consistent with README's "Settlement never reads a price feed."

```solidity
uint256 public maxPriceAgeSeconds;            // admin-settable
uint256 public constant MAX_PRICE_AGE_CEILING = 4 days;   // 345_600 — covers a 3-day-holiday weekend
uint256 public constant MAX_PRICE_AGE_FLOOR   = 1 hours;  // admin cannot set it absurdly tight either

function _spot6() internal view returns (uint256) {
    (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound)
        = feed.latestRoundData();
    require(answer > 0,                         "feed: non-positive");
    require(updatedAt != 0,                     "feed: no round");
    require(updatedAt <= block.timestamp,       "feed: future ts");
    require(block.timestamp - updatedAt <= maxPriceAgeSeconds, "feed: stale");
    require(answeredInRound >= roundId,         "feed: incomplete");     // cheap, always true today
    require(!IStock(asset).oraclePaused(),      "issuer: oracle paused");
    return uint256(answer) / 100;               // 8dp -> 6dp, same unit as strikePerToken6
}
```

Then `eligible = rungs where spot6*(1e4+minOtmBps)/1e4 <= strike6 <= spot6*(1e4+maxOtmBps)/1e4`,
with `strike6 = option.exerciseAmount * 1e18 / option.underlyingAmount`.

Launch parameter choice — pick one, do not paper over it:

| Option | `maxPriceAgeSeconds` | Consequence |
|---|---|---|
| **A (recommended)** | `90_000` (25 h) + keeper only calls `rollOpen` Mon–Fri during the `24/5` window | Tight gate, no weekend surprises, costs nothing because the cycle stays `open` until Friday 20:00 UTC. Requires the keeper schedule in TECHSPEC §5.1 to move its roll off Saturday. |
| B | `190_000` (~52.8 h) | Allows a normal-weekend roll. Still blocks a 3-day-holiday weekend (78 h observed). |
| C | `345_600` (4 days) | Always passes. The gate stops being a freshness check and becomes a liveness check only. Only acceptable together with a drift guard (below). |

Whatever is chosen, add a **drift guard** independent of freshness, because a 52-hour-old price is a Friday
close and Monday can gap:

```solidity
// reject a write if the picked strike is closer than minOtm to a PESSIMISTIC spot
uint256 spotPessimistic = spot6 * (1e4 + gapBufferBps) / 1e4;   // e.g. gapBufferBps = 400 when stale
```
i.e. when `block.timestamp - updatedAt > marketFreshWindow` (say 4 h), widen `minOtmBps` by `gapBufferBps`.
That turns the stale-weekend case into "sell further out", not "sell blind".

Also carry forward:
- **Do not** apply `uiMultiplier()` to the spot in the OTM math (§3.5) — the feed already includes it.
- Keep `token.oraclePaused()` in the gate, but document that it is an inert issuer broadcast flag (§3.4),
  not something that stops Chainlink from publishing. Keeper should alert on it and on `token.paused()` /
  `registry.isBlocked(vault)`.
- Bind to the **proxy**, never to `aggregator()` — the proxy is designed to have its aggregator rotated
  (`proposeAggregator` / `confirmAggregator` are present and `proposedAggregator()` is currently zero).
- There is **no sequencer uptime feed** to guard with on mainnet (§5.5). Do not ship an interface that
  silently reads `address(0)`.
- `answeredInRound >= roundId` is trivially satisfied on a v6 proxy (the phase bits are in both), so it is
  defence-in-depth only, not a real staleness signal. `updatedAt` is the only real one.

---

## 9. UNRESOLVED

1. **Whether Chainlink honours `Stock.oraclePaused()`.** The flag is inert on-chain (§3.4). I could find no
   primary source saying the Chainlink DON stops transmitting when Robinhood flips it. Tried:
   `docs.robinhood.com/chain/oracles-and-price-feeds/`, `docs.robinhood.com/chain/stock-tokens/`,
   `docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood` — none address it. It has never been set
   `true` on NVDA in the current state, so there is no on-chain episode to observe.
2. **Which of the two proxies is the "SVR" one and which is "Standard".** Bytecode is identical
   (sha256 `53ca1c4d67c7b092f36c66e575874226` on both), both `accessController()==0`, both wrap the same
   `DualAggregator 1.0.0`, and both returned the same `answer`/`updatedAt` at the same block. Chainlink's
   docs say the addresses page carries an "SVR" / "SVR-Backup" label, but
   `docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood` exceeded WebFetch's 10 MB limit and
   the directory JSON has no `feedCategory`/label distinguishing them. Low impact for us (we are gate-only,
   and we match Overcall by using `proxyAddress` `0x379EC4f7…`), but if anyone ever puts this in a money path,
   resolve it first. I did **not** confirm whether the SVR route's "small configurable delay"
   (`setCutoffTime(uint32)` exists on the aggregator) ever makes the two proxies diverge.
3. **Whether the weekend gap is the *declared* behaviour or an SLA miss.** The directory declares
   `heartbeat: 86400` unconditionally for all 57 feeds, including the 35 `us_equities_24/5` ones. Observed
   gaps of 52 h and 78 h contradict that number. I could not find a Chainlink page that states the
   market-hours carve-out for the heartbeat. Treat the observed 78 h as the design input, not the declared 24 h.
4. **Whether Chainlink Data Streams carries RHNVDA and whether it publishes outside equity hours.**
   Verifier proxy `0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7` confirmed deployed (7009 bytes) but I have no
   feed ID, no report schema, and no evidence of weekend coverage. If the weekend-stale problem turns out to
   be a real blocker, this is the first thing to chase.
5. **When exactly Overcall opens a new registry cycle (wall clock).** Cycle 1 is `open` now with
   `exerciseTimestamp` Fri 2026-09-18 20:00 UTC. I could not pin the cycle-creation block:
   `eth_getLogs` on the registry over 50 k-block windows near head returned **HTTP 429 Too Many Requests**
   from `rpc.mainnet.chain.robinhood.com`, and Blockscout is Cloudflare-gated. This is R1's item, but it is
   the input that decides between staleness Option A and Option B in §8. Retry with `robinhood-rpc.publicnode.com`
   and smaller windows.
6. **Chainlink feed proxy / aggregator source is not verified on any 4663 explorer.**
   `robinscan.io/api/contracts/{addr}` returns `isVerified:false` for `0x379EC4f7…`, `0xCF169363…`,
   `0xC9d16E4f…`, `0x61B7e565…` and for the proxy owner `0xee27d5ae…`. All interface claims above therefore
   rest on bytecode selector extraction + live `eth_call`, not on source. (The Stock Token *is* verified —
   §3.4.) `robinhoodchain.blockscout.com` was Cloudflare-403 for `curl` and for WebFetch on every path tried,
   so I could not check whether Blockscout has them verified.
7. **Proxy owner `0xee27d5ae494300902d90454e8630a3f1c68c9c52`** is a 171-byte contract (almost certainly a
   minimal-proxy / ERC-1167 to a multisig). I did not resolve what it delegates to or who controls it.
   Relevant only as an "who can swap the aggregator under us" question.
8. **Whether the 5 unresolved Stock Token selectors matter.** `0x097a4ec9 0x24745215 0x25c00723 0x313c8981
   0x35e2f383 0x391434e3 0x4b637e8f 0x7dc7a0d9 0xd890fd71` returned no match on openchain.xyz and
   4byte.directory returned empty for everything (likely rate-limited/blocked from here). Cross-checking them
   against the 65-entry verified ABI at `robinscan.io/api/contracts/0xb35490d6…` would close this; I confirmed
   the ABI is present in that payload but did not enumerate it. None of them can be a price getter, because
   the verified `Stock.sol` + its 4 local mixins account for every public function and none returns a price.

---

## 10. Commands used (reproduce)

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
call(){ curl -s -X POST -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"],\"id\":1}" $RPC; }

# feed
call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 0xfeaf968c   # latestRoundData()
call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 0x313ce567   # decimals()
call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 0x7284e416   # description()
call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 0x245a7bfc   # aggregator()
call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 0xbc43cbaf   # accessController()  -> 0x0
call 0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2 0x181f5a77   # typeAndVersion() -> "DualAggregator 1.0.0"
call 0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2 0x9a6fc8f5<uint80 rid padded>   # getRoundData

# stock token
call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 0x7706ba52   # oraclePaused()
call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 0xa60bf13d   # uiMultiplier()
call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 0x86c75e74   # tokenPaused()
call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 0x50c09be3   # ACCESS_CONTROLLED_REGISTRY()

# registry rungs
call 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA 0x6190c9d5   # cycle()
call 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 0x6448be8c<optionId>   # option(uint256)

# chainlink directory
curl -s https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json

# verified stock source (blockscout is cloudflare-gated; this path works)
curl -s https://robinscan.io/api/contracts/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2

# overcall config
curl -s https://overcall.finance/_next/static/chunks/13i994ge4sv4e.js   # address book
curl -s https://overcall.finance/_next/static/chunks/0dj8ov5mmi8e5.js   # aggregatorV3Abi, FEED_STALE_AFTER_MS, moneynessPct
```

Selector extraction used a PUSH4 scan over `eth_getCode` output (skipping PUSH data bytes), resolved via
`https://api.openchain.xyz/signature-database/v1/lookup?function=0x…&filter=true`.

---

# Verification pass

**Verifier:** independent adversarial re-check, 2026-09-12 ~18:38–19:00Z, chain head block 61,322,984.
**Verdict: PARTIAL.** The core answer is right and I am confident binding to it. But three factual claims are
wrong, one recommendation (**Option B**) is *refuted by the data it cites*, one claim is *unproven and possibly
inverted*, and four items marked UNRESOLVED are now resolved.

Everything below was re-run from scratch with my own tooling (my own Multicall3 `aggregate3` ABI encoder and my
own opcode-aware dispatcher extractor), not by re-reading the original report. Raw evidence artifact:
`<callhouse>/ops/recon/R5-nvda-feed-round-history.json`
(all **1025** rounds, gap-annotated).

## V0. What I confirmed (no change needed)

Every one of the 15 claimed addresses has code at the claimed size. `eth_getCode` byte lengths, all re-run:

```
    9571  0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15  53ca1c4d67c7b092f36c66e575874226  NVDA feed proxy (primary)
    9571  0xCF169363636D73dbBf77733629CB38919d14232d  53ca1c4d67c7b092f36c66e575874226  NVDA feed proxy (secondary)
   23186  0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2  54db689d777eecb18c24517e86f16136  NVDA DualAggregator
    9571  0x61B7e5650328764B076A108EFF5fa7282a1B9aD2  53ca1c4d67c7b092f36c66e575874226  USDG feed proxy
    9571  0x901f56689360B89D7767a8acE28B7801e6348fa2  53ca1c4d67c7b092f36c66e575874226  USDG feed proxy secondary
    9571  0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9  53ca1c4d67c7b092f36c66e575874226  ETH/USD feed proxy
     283  0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC  399ec4bc5b43db03486ceae11f9a6fc5  NVDA Stock Token
    2332  0xe10b6f6b275de231345c20d14ab812db62151b00  e42be4f7355845c67bb554c14cd9f23e  beacon/registry
   11614  0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2  0ac99e9cc7a3738645af72f6d9e8fb82  Stock impl
    5905  0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA  87a1f0d49a9d801366f834324b8e6ed2  Overcall NVDA registry
    7009  0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7  246be742ffcc522f72309f1f42c77817  DataStreams VerifierProxy
     171  0xee27d5ae494300902d90454e8630a3f1c68c9c52  5b8bff324e02136edb0775bd77aa0fe7  feed owner
```

- **All 48 claimed selectors recomputed with `cast sig` — every one matches.** No fabricated selectors.
- **Both proxy and aggregator ABIs re-derived with a proper dispatcher extractor** (`PUSH4 … EQ … JUMPI`, not a
  naive PUSH4 scan). I validated the extractor against the Stock token's full-match verified ABI first:
  **36/36 recall, 2 false positives**. Applied to the Chainlink contracts it returns 23 selectors on the proxy
  and 50 on the aggregator, and **every ABI entry the report claimed for both is genuinely in the dispatcher** —
  including `proposedLatestRoundData()` `0x8f6b4d91`, `proposedGetRoundData(uint80)` `0x6001ac53`,
  `proposeAggregator` `0xf8a2abd3`, `confirmAggregator` `0xa928c096`, `setCutoffTime(uint32)` `0xb17f2a6b`,
  `transmit` `0xb1dc65a4`, `transmitSecondary` `0xba0cb29e`. These reverted on `eth_call` only because of
  `hasProposal()` / EOA-only / owner guards, not because they are absent. **Their ABI list is sound.**
- **Contract-caller read re-proven independently.** I wrote my own `aggregate3` encoder and read
  `latestRoundData()` through Multicall3 on both the proxy *and* the aggregator: both succeed.
- **Cross-RPC agreement:** `rpc.mainnet.chain.robinhood.com` and `robinhood-rpc.publicnode.com` return
  byte-identical code and calldata.
- **No chain confusion.** The three testnet mock addresses have `codesize 0` on mainnet 4663; testnet
  `eth_chainId` = `0xb626`.
- **Chainlink directory re-fetched** (81,235 bytes, 57 feeds). Every statistic in the report is exact:
  `marketHours {us_equities_24/5: 35, Crypto: 22}`, `heartbeat {86400: 57}`, `threshold {0.5: 52, 0.05: 5}`,
  `decimals {8: 52, 18: 5}`, `contractVersion {6: 57}`, **sequencer/uptime entries: 0**. NVDA record verbatim
  matches. All four testnet directory slugs 404.
- **Decimals chain fully reproduced** end-to-end. `registry.cycle()` → `number=1`,
  `exerciseTimestamp=1789761600` (Fri 2026-09-18 20:00:00Z), `expiryTimestamp=1789848000`
  (Sat 2026-09-19 20:00:00Z), `lotSize=1e18`, 5 optionIds. Each through Valorem `option(uint256)`:
  underlying `0xd0601ce1…9eec` @ `1e18`, exercise `0x5fc5360d…d168` (USDG) @ 226/231/236/241/246 × 1e6.
  `strikePerToken6 == exerciseAmount` exactly; moneyness vs `answer/100` = **+3.528 / +5.819 / +8.109 /
  +10.400 / +12.690 %**. Under 300/1200 bps rungs 1–4 are eligible, rung 5 excluded. Confirmed.
- **`oraclePaused()` is inert — confirmed from verified source.** I pulled the source myself
  (`https://robinscan.io/api/contracts/0xb35490d6…` → HTTP 200, 212,373 bytes, `isVerified:true`,
  `matchType:"full"`, `Stock`, `0.8.33+commit.64118f21`, 33 files, 65 ABI entries). A grep across all
  non-library sources shows `_pauseOracle()`/`_unpauseOracle()` referenced **only** at `Stock.sol:172` and
  `:176`. The single modifier in `Stock.sol` is `onlyNotPaused`, which reads `paused()`, not `oraclePaused()`.
- **No price getter on the Stock token.** I probed 20 plausible price selectors live — all revert.
- **Round invariants hold across all 1025 rounds:** `answeredInRound == roundId` in 1025/1025, no `answer <= 0`,
  no `updatedAt == 0`, no `updatedAt < startedAt`. Their `answeredInRound >= roundId` note is fine.
- **Staleness — the core catch is CONFIRMED and is worse than reported.** See V2.

## V1. Corrections — claims that are wrong

### V1.1 `maxAnswer()` is 2^176−1, not 2^192−1

```
maxAnswer() raw 0x00000000000000000000ffffffffffffffffffffffffffffffffffffffffffff
  20 leading zero hex chars, 44 'f' chars = 176 bits
  v == 2**176-1 : True    v == 2**192-1 : False
  decimal       : 95780971304118053647396689196894323976171195136475135
```

Cross-confirmed off-chain: the Chainlink directory's own `"maxSubmissionValue"` field for this feed is
`"95780971304118053647396689196894323976171195136475135"` — the same 2^176−1. Cosmetic for us, but it shows
the value was eyeballed from hex rather than decoded.

**Worth drawing the conclusion the report didn't:** with `minAnswer = 1` and `maxAnswer = 2^176−1`, these bounds
can never bind. That is *good* (no Venus-style circuit-breaker price pinning during a crash) but it also means
**the feed provides no sanity floor of its own** — the vault must impose its own absolute band.

### V1.2 Largest intra-week gap is 75,729 s (21.04 h), not 63,394 s (17.61 h)

The report sampled only rounds 700–1025. I walked **the entire history, rounds 1–1025** (feed inception
Mon 2026-06-22 00:00:43). The true worst intra-week gap is 39 % larger than reported:

```
TOP 5 INTRA-WEEK gaps (excluding the 11 weekend/holiday sleeps):
   r746     75729 s = 21.04 h | Thu 2026-08-13 16:26:27 -> Fri 2026-08-14 13:28:36
   r30      66322 s = 18.42 h | Tue 2026-06-23 18:42:38 -> Wed 2026-06-24 13:08:00
   r1006    63394 s = 17.61 h | Tue 2026-09-08 16:19:29 -> Wed 2026-09-09 09:56:03   <- the report's "max"
   r741     62651 s = 17.40 h | Wed 2026-08-12 19:57:12 -> Thu 2026-08-13 13:21:23
   r1010    60379 s = 16.77 h | Wed 2026-09-09 19:04:43 -> Thu 2026-09-10 11:51:02
```

This directly shrinks the safety margin on their recommended Option A — see V3.

### V1.3 Option B (190,000 s) is refuted by the full record

The report: *"B 190,000 s (~52.8 h) — survives a normal weekend, still blocks a 3-day holiday weekend."*
Over 11 observed weekends, **190,000 s blocks 4 — and two of those are ordinary, non-holiday weekends:**

```
ALL gaps > 86400 s (the DECLARED heartbeat), FULL history, 11/11 weekends:
   r95    gap  187152 s = 51.99 h | Fri 2026-06-26 20:01:57 -> Mon 2026-06-29 00:01:09
   r184   gap  273935 s = 76.09 h | Thu 2026-07-02 19:55:07 -> Mon 2026-07-06 00:00:42   (July 4 observed Fri)
   r275   gap  200202 s = 55.61 h | Fri 2026-07-10 16:23:43 -> Mon 2026-07-13 00:00:25   <== ORDINARY weekend
   r379   gap  189116 s = 52.53 h | Fri 2026-07-17 19:28:32 -> Mon 2026-07-20 00:00:28
   r461   gap  187412 s = 52.06 h | Fri 2026-07-24 19:57:16 -> Mon 2026-07-27 00:00:48
   r606   gap  180410 s = 50.11 h | Fri 2026-07-31 21:53:32 -> Mon 2026-08-03 00:00:22
   r704   gap  187494 s = 52.08 h | Fri 2026-08-07 19:55:37 -> Mon 2026-08-10 00:00:31
   r752   gap  203773 s = 56.60 h | Fri 2026-08-14 15:24:09 -> Mon 2026-08-17 00:00:22   <== ORDINARY weekend
   r807   gap  187373 s = 52.05 h | Fri 2026-08-21 19:57:46 -> Mon 2026-08-24 00:00:39
   r931   gap  187465 s = 52.07 h | Fri 2026-08-28 19:56:29 -> Mon 2026-08-31 00:00:54
   r995   gap  281670 s = 78.24 h | Fri 2026-09-04 17:46:24 -> Tue 2026-09-08 00:00:54   (Labor Day)
```

**The mechanism the report missed:** the weekend gap has *no stable upper bound near 52 h*, because the last
Friday round is triggered by the **0.5 % deviation threshold**, not by the closing bell. On Fri 2026-08-14 the
last print was **15:24:09 UTC — 11:24 ET, four and a half hours before the close** — simply because NVDA did not
move 0.5 % again that afternoon. A quiet Friday afternoon silently lengthens the weekend gap. Ordinary weekends
observed span **50.11 h to 56.60 h**.

So "190,000 s survives a normal weekend" is false. To survive every *ordinary* weekend observed you need
≥ 203,774 s — and that still fails both holiday weekends.

### V1.4 "Byte-identical proxies" is evidence of nothing

The report presents `sha256(code) == 53ca1c4d67c7b092f36c66e575874226` on both NVDA proxies as if it were a
finding. **The USDG and ETH/USD proxies have the same hash** (see V0 table). Every `AggregatorProxy` on 4663 is
byte-identical, because the aggregator address lives in storage, not in the code. It says nothing about whether
the two NVDA proxies are equivalent.

### V1.5 The two NVDA proxies do *not* "differ only in phaseId" — the secondary has a broken phase 1

```
PRIMARY 0x379EC4f7  phaseAggregators():        SECONDARY 0xCF169363  phaseAggregators():
   phase 1 -> 0xc9d16e4f…dc2a2                    phase 1 -> 0x0000000000000000214646852251989045073572   <-- codesize 0
   phase 2 -> 0x0000…0000                         phase 2 -> 0xc9d16e4f…dc2a2
```

The secondary proxy's phase-1 aggregator is a **codeless junk address** (`eth_getCode` → 0 bytes). Two
consequences the report missed:

1. `0xCF169363…` is **not** a clean mirror of the primary. Walking `getRoundData()` into its phase 1 hits a
   contract that does not exist. Do not treat the two as interchangeable.
2. More importantly: **the secondary proxy has already been rotated once** (phase 1 → phase 2). Aggregator
   rotation under a proxy is a *live operational event* on this chain, not a theoretical capability. That
   strengthens the report's "bind to the proxy, never the aggregator" advice — correctly, for a better reason
   than given.

### V1.6 `checkEnabled() == true` is not an enforced read ACL

The report calls it "aggregator-level ACL". It is not enforced on reads:

```
aggregator.hasAccess(Multicall3, 0x) -> 0x00…00   (FALSE)
aggregator.checkEnabled()            -> true
aggregator.latestRoundData() via Multicall3 (a contract caller) -> SUCCESS, [1025, 21829793457, …]
```

`hasAccess` returns false for a contract caller while `checkEnabled` is true, yet the read still succeeds — so
`DualAggregator 1.0.0` does not decorate its read path with the access check. This does not change the
conclusion (a contract can read), but the parenthetical is misleading and should not be relied on as a reason
to prefer the proxy.

### V1.7 "spotStale is display-only — `isWritable` ignores it" is UNPROVEN, and may be backwards

```js
"isWritable",0,function(e,t,n){return"open"===l(e,t)&&!n}
```

The third parameter is **unnamed and minified**, and I found **no call site**. I downloaded the index page plus
every chunk it references, probed five plausible market routes, and grepped all 19 JS files retrieved:
`isWritable` appears exactly once in the entire reachable bundle set — the definition. Nothing establishes that
`n` is anything other than `spotStale`; a "writable" gate taking a staleness boolean is the *natural* reading,
which would make the report's conclusion the opposite of the truth.

I did confirm the surrounding pieces verbatim: `FEED_STALE_AFTER_MS = 72e5`,
`isSpotStale = (e,t) => t - 1e3*Number(e.updatedAt) > FEED_STALE_AFTER_MS`,
`moneynessPct = (e,n) => { let i = n/100n; return Number((e-i)*1000000n/i)/1e4 }`,
`strikePerToken6 = (e,n) => n<=0n ? 0n : e*1000000000000000000n/n`,
`cycleState = (e,t) => e===undefined||e.number===0 ? "none" : t>=e.expiryTimestamp ? "expired" : t>=e.exerciseTimestamp ? "exercise-window" : "open"`
(the report omits the `"none"` branch), and one display-only use of `spotStale` as a `note:` prop.
**Do not cite Overcall's behaviour as precedent for not gating on staleness.**

### V1.8 Minor

- "Restarts land at 00:00:54 UTC" — across all 11 restarts the range is **00:00:22 to 00:01:09**.
- ETH/USD `answer=252950650000` is **$2,529.5065**, not stated in the report.
- Testnet mock #2 `updatedAt=1788984539` = Wed 2026-09-09 20:08:59Z.

## V2. Staleness: confirmed, and stronger than reported

The report's headline catch is correct and I am reinforcing it. Over the feed's **entire life** — inception
Mon 2026-06-22 00:00:43 to Fri 2026-09-11 20:03:43, 1025 rounds — **11 of 11 weekends violated the declared
86,400 s heartbeat.** The declared heartbeat is simply not honoured while US equities are closed. There is no
ambiguity left: treat 86,400 as fiction.

Live state at verification time (Sat 2026-09-12 18:38:21Z): `updatedAt=1789157023`, **age 81,278 s = 22.58 h**,
projected **187,031 s = 51.95 h** by the expected Mon 2026-09-14 00:00:5x restart. Overcall cycle 1 is `open`
until Fri 2026-09-18 20:00:00Z, so the write window does span the whole weekend.

## V3. Revised recommendation

Threshold table computed over the full 1025-round history:

```
  maxPriceAge  24 h    (86400)  blocks 11 gaps: 11 weekend,  0 intra-week
  maxPriceAge  25 h    (90000)  blocks 11 gaps: 11 weekend,  0 intra-week
  maxPriceAge  30 h   (108000)  blocks 11 gaps: 11 weekend,  0 intra-week
  maxPriceAge  52.8h  (190000)  blocks  4 gaps:  4 weekend,  0 intra-week
  maxPriceAge  57 h   (205200)  blocks  2 gaps:  2 weekend,  0 intra-week
  maxPriceAge  4 d    (345600)  blocks  0 gaps:  0 weekend,  0 intra-week

minimum maxPriceAge that never blocks anything observed      : 281,671 s (78.24 h)
minimum maxPriceAge that never blocks a MON-FRI-only roll    :  75,730 s (21.04 h)
```

- **Option A (90,000 s + weekday roll) survives — keep it — but the margin is thinner than advertised.**
  Headroom over the observed worst intra-week gap is 90,000 − 75,729 = **14,271 s (~4 h, 19 %)**, not the ~7 h
  the report's 17.61 h figure implies. I would set it to **108,000 s (30 h)** for a 32,271 s cushion; it blocks
  exactly the same 11 weekend gaps and zero intra-week gaps, so the extra headroom is free.
- **Option B is refuted as written.** Delete it or restate it honestly: 190,000 s blocks 4 of 11 weekends,
  two of them ordinary.
- **Option C (345,600 s) is the only threshold that never blocks** — and at that width the age check is barely
  a check. Only with a drift guard, as the report says.
- Keep the report's `gapBufferBps` drift guard. Given V1.3, trigger it on the *observed* distribution, not on a
  4 h notion of "stale".
- **Add a bind-time invariant the report omits:** `require(feed.decimals() == 8)` in the constructor/setter.
  The recommended `uint256 spot6 = uint256(answer) / 100;` silently produces a 100× wrong number if the bound
  feed is ever 18-decimal — and 5 of the 57 feeds in this very directory are 18-decimal.

**Unobserved risk, flagged as inference, not observation:** the history is only ~12 weeks and contains just two
holidays, both adjacent to a weekend. A **mid-week** US market holiday (Thanksgiving, Christmas, Good Friday,
a weekday July 4) is unobserved. Labor Day shows a holiday adds ~24 h to the sleep; combined with the V1.3
deviation-threshold effect, a mid-week holiday could plausibly produce a **24–30 h intra-week gap**, which would
break Option A at 90,000 s. This is the strongest argument for 108,000 s over 90,000 s.

## V4. Items they marked UNRESOLVED that I resolved

### V4.1 RESOLVED — the feed owner is a 4-of-9 Gnosis Safe

`0xee27d5ae494300902d90454e8630a3f1c68c9c52` is **not** an ERC-1167 minimal proxy. Its 171 bytes are the
**GnosisSafeProxy** runtime — the giveaway is the `masterCopy()` selector `0xa619486e` embedded in the code, and
singleton in storage slot 0:

```
code: 0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e…
slot0 (singleton) -> 0x113779daf982b09f7a9db64af132aa97496b3999   (codesize 23328, VERSION() = "1.3.0")
slot3 (ownerCount) -> 9

masterCopy()   0x113779daf982b09f7a9db64af132aa97496b3999
VERSION()      '1.3.0'
getThreshold() 4
nonce()        19
getOwners() -> 9 owners:
    0x80efdee7f82d0f2abf3bf29a9a85edf0b42c9e19   0x05724b9c8c1dde1b2f659d7c0676ff63f6d5e781
    0x480496c0884d61f2f56707adb11697f8018898c2   0xb65b6d224351cd61f856c227b2d5cfc611e9b2d8
    0x80d46dad5a5450a3611cd1d7f9110aedfa55bff6   0xfde996f00e42b33bde7c640786333623acc3f298
    0x7052cb84079905400ea52b635cab6a275fda8823   0xb7f0643d4ca8c296564ce335062833e1afa3afdb
    0xd66336ea98ce0da67f25934e7cc230d4226292a0
```

So "who can swap the aggregator under us" = **a 4-of-9 Safe v1.3.0 that has already executed 19 transactions**,
and it owns all four feed proxies and all three aggregators checked.

### V4.2 RESOLVED — the 9 "unresolved" Stock selectors are not functions at all

The verification is a **full match**, so the 65-entry ABI is exhaustive: the deployed dispatcher *cannot*
contain a function outside it. My dispatcher extractor finds 36 external functions, exactly the ABI's 36. All
nine "unresolved" selectors are artefacts of the naive PUSH4 scan:

- **`0xd890fd71`** = the ERC-165 interface ID of `IScaledUIAmountBalances { balanceOfUI(address),
  totalSupplyUI() }`. Computed by XOR and confirmed live: `supportsInterface(0xd890fd71) -> true`.
- `0xfbac3951` (`isBlocked(address)`) and `0x91d14854` (`hasRole(bytes32,address)`) are **outbound call**
  selectors — the token calling *into* the registry, not functions on the token.
- `0x4e487b71` is `Panic(uint256)`; the rest sit in error/`supportsInterface` comparison chains.
  `supportsInterface` returned `false` for the other eight.

**Methodological note for the whole recon effort:** a PUSH4 scan over-reports by ~25 % (15 of 59 constants on
this contract were not functions). Where a contract is unverified, use dispatcher-shape extraction. I re-derived
the Chainlink ABIs that way and they held up — see V0.

### V4.3 RESOLVED — Data Streams verifier, upgraded from docs-only to on-chain primary evidence

```
0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7   codesize 7009
  typeAndVersion()      'VerifierProxy 2.0.0'
  owner()               0xcb04546140628ca0ff29afc5f62a94da85fd7d25
  s_accessController()  0x0000000000000000000000000000000000000000   <- verify() is not allowlisted
  s_feeManager()        0x0000000000000000000000000000000000000000   <- no fee manager set
  dispatcher: verify(bytes,bytes) 0xf7e83aee, verifyBulk(bytes[],bytes) 0xf873a61c,
              getVerifier(bytes32) 0xeeb7b248, initializeVerifier(address), setFeeManager(address),
              unsetVerifier(bytes32), setAccessController(address), s_accessController(), s_feeManager(),
              owner/transferOwnership/acceptOwnership, typeAndVersion, + 1 unidentified (0xb011b247)
```

No longer resting on a docs citation. Feed IDs and weekend coverage remain genuinely unknown.

### V4.4 RESOLVED — the testnet mock's `setAnswer` really is permissionless

Upgraded from "appears permissionless (no `owner()` selector)" to demonstrated:

```
eth_call       setAnswer(22500000000, 1789238000) from 0x…deadbeef -> 0x        (no revert)
eth_estimateGas setAnswer(...)                    from 0x…deadbeef -> 0x1e79f   (124,831 gas — it would execute)
```

**New caveat for M3 dry-runs the report missed:** the mock's dispatcher has **only 9 functions** —
`latestRoundData, getRoundData, decimals, description, latestRoundId, setAnswer, setRound, setDecimals` (+1).
There is **no `latestAnswer()`, `latestTimestamp()`, `latestRound()`, `aggregator()`, `phaseId()`,
`accessController()`, or `owner()`**. Any Policy/keeper code written against the full
`AggregatorProxy` surface will revert on testnet. Constrain the interface to
`latestRoundData()` / `decimals()` / `description()` / `getRoundData(uint80)` and it works on both chains.

## V5. New risk the report did not flag

**The read gate can be switched on under us.** The report concludes from `accessController() == 0` that
"the Vault/Policy can call it directly with no allowlisting." True *today*, but `setController(address)`
(`0x92eefe9b`) is in the proxy's dispatcher and is owned by the 4-of-9 Safe above. That Safe can install an
access controller at any time and **brick every read the vault makes**, with no warning and no migration path.

Combined with V1.5 (a proxy on this chain has already been rotated once), the Safe holds two independent levers
over our price gate: rotate the aggregator, or gate the reads. The vault must therefore **fail safe**: if
`latestRoundData()` reverts, `rollOpen` must skip and stay Idle — never propagate the revert into a path that
blocks `queueRedeem`, `claimUsdg`, or `rollClose`. Per plan.md §2 that invariant already exists; this is a
concrete reason it is load-bearing.

## V6. Still UNRESOLVED after this pass

1. **Which proxy is SVR vs Standard.** Unchanged. The directory `path` is `robinhood-nvda-usd-shared-svr` for
   the record as a whole and carries no per-proxy label; both wrap the same aggregator and returned identical
   answers. V1.5 adds that they are *not* symmetric, but not which is which. Low impact — we match Overcall and
   bind to `proxyAddress`.
2. **Whether the weekend carve-out is declared behaviour or an SLA miss.** Unchanged, and now sharper: it is
   11/11 weekends over the feed's entire life, so it is plainly by design, but I found no Chainlink page stating
   the market-hours exception. Design for the observed 78.24 h.
3. **Whether Chainlink stops transmitting when `Stock.oraclePaused()` flips true.** Unchanged. Provably inert
   on-chain; never been true on NVDA; no primary source.
4. **Whether Data Streams carries RHNVDA and publishes outside equity hours.** Verifier now confirmed on-chain
   (V4.3), but no feed ID, no report schema, no coverage evidence.
5. **Overcall's `isWritable` third parameter** (V1.7) — no call site exists in any reachable chunk.
6. **`0xb011b247`** on the VerifierProxy, and 7 selectors on the DualAggregator
   (`0x9bd2c0b1 0x9c849b30 0xb121e147 0xc4c92b37 0xdaffc4b5 0xeb5dcd6c 0xffffffff`) — almost certainly the OCR2
   payee/billing surface (`transferPayeeship`/`acceptPayeeship`/`getOracles`), not resolved. None is a read path.
7. **Chainlink contracts remain unverified on every reachable explorer** — confirmed independently.
   `robinscan.io/api/contracts/` works and returns real verified source for the *Stock* implementation, but
   `isVerified:false` for the feed contracts. All Chainlink interface claims rest on dispatcher extraction plus
   live `eth_call` — which, after V0, I consider sufficient.
8. **Mid-week market-holiday behaviour** — unobserved in a 12-week history (V3).

## V7. Commands used

```bash
# all reads batched through my own Multicall3 aggregate3 encoder (also proves contract-caller access)
python3 r5v/r5rpc.py     # MAIN=https://rpc.mainnet.chain.robinhood.com  MAIN2=https://robinhood-rpc.publicnode.com
                         # TEST=https://rpc.testnet.chain.robinhood.com/rpc  MC3=0xcA11bde05977b3631167028862bE2a173976CA11
cast sig "<sig>"         # all 48 claimed selectors recomputed
curl -s -A 'Mozilla/5.0' https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
curl -s -A 'Mozilla/5.0' https://robinscan.io/api/contracts/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2
curl -s -A 'Mozilla/5.0' https://overcall.finance/ ; + all 19 referenced chunks
```

Note: the mainnet RPC returns **HTTP 403 without a `User-Agent` header** and **HTTP 429** under rapid
sequential calls — both silent failure modes for a naive script. Batch through Multicall3 and set a UA.
Round history was walked with `getRoundData(uint80)` in 60-call batches, rounds 1–1025, zero missing rounds
(1025 ids, 1025 results), so the gap analysis has no holes.
