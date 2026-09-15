# R10 — Independent address audit (Robinhood Chain 4663)

Run date: 2026-09-12. All evidence below was produced by commands actually executed in this session.
Chain confirmed at the top of every run: `eth_chainId` -> `0x1237` (4663), head ~61,314,582.

Primary RPCs used:
- `https://rpc.mainnet.chain.robinhood.com` — live, but **state-pruned**: `eth_getCode` at head-100,000 fails
  with `{"code":-32000,"message":"metadata is not found, 61207031"}`. Only ~1–2k blocks of historical state.
- `https://rpc.ordofi.network` — **the only archive node found**. Usable state floor measured at block
  **55,989,685** (head-5,317,218). Below that: `missing trie node ... is not available, not found`.
  All deployment-block binary searches were done here.
- `https://robinhood-rpc.publicnode.com` — head only; **403 Forbidden on any non-`latest` block tag**.

---

## 1. Verdict table — the six addresses the spec asserts

| Spec label | Address | Code bytes | Real identity (proven) | Verdict |
|---|---|---|---|---|
| Valorem Clear | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` | 16110 | `ValoremOptionsClearinghouse` | **CORRECT** |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` | 23981 | Seaport, `information()` version = `1.6` | **CORRECT — it is 1.6, not 1.5** |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 170 (ERC-1967 proxy) | `Global Dollar` / `USDG` / **6 decimals** | **CORRECT** |
| NVDA Stock Token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 283 (**beacon** proxy) | `NVIDIA • Robinhood Token` / `NVDA` / 18 decimals | **CORRECT, but proxy type is mis-stated — see §7** |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | 3808 | canonical Multicall3, **byte-identical** to Arbitrum + Base | **CORRECT** |
| Overcall fee switch key | `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` | 0 (EOA) | Valorem `feeTo()` **AND** the Overcall 5% premium recipient | **HALF-RIGHT — see §4, biggest correction in this file** |

Raw first pass (`eth_getCode` / `eth_getTransactionCount` / `eth_getBalance`, all at `latest`):

```
chainId: 0x1237      blockNumber: 0x3a76f77
Valorem Clear  0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0  codelen_bytes= 16110  nonce=    1 balance_wei=0
Seaport 1.6    0x0000000000000068F116a894984e2DB1123eB395  codelen_bytes= 23981  nonce=    2 balance_wei=0
USDG           0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  codelen_bytes=   170  nonce=    1 balance_wei=0
NVDA           0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC  codelen_bytes=   283  nonce=    1 balance_wei=0
Multicall3     0xcA11bde05977b3631167028862bE2a173976CA11  codelen_bytes=  3808  nonce=    1 balance_wei=0
FeeKey         0xdAe7e82A2E7D566C67E87C164B05a1C560190782  codelen_bytes=     0  nonce=    0 balance_wei=0
```

---

## 2. Valorem Clear — `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0`

### Deployment (binary search on the ordofi archive node, then block scan)

```
ValoremClear   0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0  deployed in block 59378584
block 59378584 ts=1789040820 (2026-09-10 11:47:00Z) txcount=18
  tx 0xacc4c4f96a1881f195e706387a4755eabc5243ccb56d3bcf07baa50c1ba21034
     from=0x408adcffebdf48ec23f1e3811a91aed3cc951cc0 to=None
     created=0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0 input_len=16445
```

**It is two days old.** Deployed Thu 2026-09-10 11:47:00 UTC by EOA `0x408adcffebdf48ec23f1e3811a91aed3cc951cc0`
(deployer nonce 1). The same EOA created `0xe53ccb924d27f421a91b59087587fd866c5d64c7` at nonce 0 in the same block.

### Constructor arguments, decoded from the creation tx input tail

```
creation input bytes: 16445
last 128 hex (constructor args): 000000000000000000000000dae7e82a2e7d566c67e87c164b05a1c560190782
                                 000000000000000000000000e53ccb924d27f421a91b59087587fd866c5d64c7
  arg0 (_feeTo)             = 0xdae7e82a2e7d566c67e87c164b05a1c560190782
  arg1 (_tokenURIGenerator) = 0xe53ccb924d27f421a91b59087587fd866c5d64c7
from: 0x408adcffebdf48ec23f1e3811a91aed3cc951cc0 nonce: 1
```

This matches `constructor(address _feeTo, address _tokenURIGenerator)` in
`valorem-labs-inc/clear` `src/ValoremOptionsClearinghouse.sol` verbatim.

### Live state reads

```
feesEnabled()          0x0000...0000        -> false
feeBps()               0x0000...000f        -> 15
feeTo()                0x0000...dae7e82a2e7d566c67e87c164b05a1c560190782
tokenURIGenerator()    0x0000...e53ccb924d27f421a91b59087587fd866c5d64c7
feeBalance(USDG)       0
feeBalance(NVDA)       0
supportsInterface(0xd9b67a26 ERC1155) = 1
supportsInterface(0x01ffc9a7 ERC165)  = 1
supportsInterface(0x2a55205a ERC2981) = 0
owner() / symbol() / totalSupply()    -> execution reverted (no such functions — non-upgradable, no owner, no pause)
```

`feeBps()` = 15 confirms the README's 15 bps. `feesEnabled()` = **false** confirms "off at Overcall launch".
`1e18 * 15 / 10000 = 1.5e15` = **0.0015 NVDA per contract** — TECHSPEC's figure is exactly right.

### ABI — dispatcher selectors extracted from the deployed runtime bytecode (25 entries)

```
0x017e7e58,0x01ffc9a7,0x04e618ce,0x0e89341c,0x24a9d853,0x2eb2c2d6,0x379607f5,0x4e1273f4,0x6448be8c,
0x888fbf43,0xa143c66f,0xa22cb465,0xa64e4f8a,0xa901dd92,0xaa9ffa93,0xd6d859e9,0xdb006a75,0xe1f3962c,
0xe6c3b1f6,0xe985e9c5,0xf1f5d0c3,0xf242432a,0xf46901ed,0xf55e49b2,0xf7a95a9e
```

Resolved (openchain.xyz signature DB) — **every one is a `ValoremOptionsClearinghouse` function, nothing extra**:

| selector | signature |
|---|---|
| `0xaa9ffa93` | `newOptionType(address,uint96,address,uint96,uint40,uint40)` |
| `0x888fbf43` | `write(uint256,uint112)` |
| `0xf55e49b2` | `exercise(uint256,uint112)` |
| `0xdb006a75` | `redeem(uint256)` |
| `0x6448be8c` | `option(uint256)` |
| `0x379607f5` | `claim(uint256)` |
| `0xf7a95a9e` | `position(uint256)` |
| `0xe6c3b1f6` | `tokenType(uint256)` |
| `0x24a9d853` | `feeBps()` |
| `0xa64e4f8a` | `feesEnabled()` |
| `0x017e7e58` | `feeTo()` |
| `0xe1f3962c` | `feeBalance(address)` |
| `0xa901dd92` | `setFeesEnabled(bool)` |
| `0xf46901ed` | `setFeeTo(address)` |
| `0xf1f5d0c3` | `acceptFeeTo()` |
| `0xd6d859e9` | `sweepFees(address[])` |
| `0xa143c66f` | `tokenURIGenerator()` |
| `0x04e618ce` | `setTokenURIGenerator(address)` |
| `0x0e89341c` | `uri(uint256)` |
| `0x01ffc9a7` `0x4e1273f4` `0xa22cb465` `0xe985e9c5` `0xf242432a` `0x2eb2c2d6` | ERC-1155 / ERC-165 surface |

`balanceOf(address,uint256)` = `0x00fdd58e` is not caught by the dispatcher-pattern scan but responds correctly
(`eth_call` returns `0x00…00`), so it is present — it is a solmate public mapping.

**This answers plan.md R4.** The names are `write / redeem / exercise / claim / option / feesEnabled`, exactly as
the pre-rename `OptionSettlementEngine` audit describes.

### Verified source: NOT available anywhere. See §9.

---

## 3. Seaport — `0x0000000000000068F116a894984e2DB1123eB395` — is it really 1.6?

**Yes. Version string verbatim:**

```
name()          -> 'Seaport'
information()   -> version = '1.6'
                   domainSeparator  = 0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0
                   conduitController= 0x00000000f9490004c11cef243f5400493c00ad63
```

`0x00000000F9490004C11Cef243f5400493c00Ad63` is the canonical Seaport ConduitController.

**Bytecode proof.** I diffed the 4663 runtime against the Seaport at the same address on Arbitrum One:

```
len a 23981 len b 23981 differing bytes: 34
differing runs: 2
  offset 15419-15420 (2 bytes)  4663=0x1237  arb=0xa4b1
  offset 15427-15458 (32 bytes) 4663=0xa6b20d2b...af3730b0  arb=0x2b9168d7...f14bc4ea
```

The only differences are the two cached immutables Seaport bakes in at deploy: `_CHAIN_ID`
(0x1237 = 4663 vs 0xa4b1 = 42161) and `_DOMAIN_SEPARATOR`. 23,947 of 23,981 bytes are identical.
This is unambiguously canonical Seaport 1.6. Deployed before archive floor (block ≤ 55,989,685).

---

## 4. `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` — what it actually is

### The README's claim is proven, and it is also incomplete.

**Proven half 1 — it IS the Valorem fee switch holder.**
- `feeTo()` on the clearinghouse returns it (see §2).
- It was hard-set as constructor `arg0 (_feeTo)` at deploy (see §2).
- Overcall's own site (https://overcall.finance) independently states: *"Fee switch holder:
  0xdAe7e82A2E7D566C67E87C164B05a1C560190782"*.

**Proven half 2 — it CANNOT seize collateral.** From `valorem-labs-inc/clear` `src/ValoremOptionsClearinghouse.sol`
(the source whose full ABI the deployed bytecode matches), the complete set of `onlyFeeTo` powers is:

```solidity
modifier onlyFeeTo() { if (msg.sender != feeTo) revert AccessControlViolation(msg.sender, feeTo); _; }

function setFeesEnabled(bool enabled)             external onlyFeeTo { feesEnabled = enabled; ... }
function setFeeTo(address newFeeTo)               external onlyFeeTo { pendingFeeTo = newFeeTo; }   // 2-step
function setTokenURIGenerator(address n)          external onlyFeeTo { ... }                        // cosmetic
function sweepFees(address[] calldata tokens)     external onlyFeeTo {
    ...
    fee = feeBalance[token];            // <-- reads ONLY the accrual ledger
    if (fee > 1) { sweep = fee - 1; feeBalance[token] = 1;
                   SafeTransferLib.safeTransfer(ERC20(token), sendFeeTo, sweep); }
}
```

`sweepFees` transfers strictly `feeBalance[token]`, an internal counter that only `_calculateRecordAndEmitFee`
increments. There is no path from `feeTo` to writer collateral. There is no `owner()`, no pause, no upgrade hook
on the deployed contract (confirmed: `owner()` reverts; the 25-selector dispatcher has no admin surface beyond
the four above). **README/TECHSPEC claim is CORRECT.**

### The missing half — it is ALSO the Overcall protocol revenue address.

I found the single real Seaport fill on this chain (tx
`0x013cd30b541372fa7f505dfb743a563f39e284b7d2805dbcb964b6a754ae720b`, block 61153997, Sat 2026-09-12 13:49:12Z)
and decoded it:

```
Valorem TransferSingle operator 0x…68f116a894984e2db1123eb395 (Seaport)
        from 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be to 0x8684c0b2e23d0c699a1ff4437e8d92258bc82905
        id 56885395977254369119998982131173877604217583767740146085872832926902011297792 value 1
USDG Transfer from 0x8684c0…82905 to 0xe73d70…1275be  amount 3.8 USDG
USDG Transfer from 0x8684c0…82905 to 0xdae7e8…190782  amount 0.2 USDG     <-- THE FEE KEY
```

0.2 / 4.0 = **exactly 5%**. This is the "Overcall take: 5% of premium, second Seaport consideration" from
TECHSPEC §2 — and the recipient is the same address the spec labels only as the "fee switch key".
It matches its on-chain USDG balance: `feeKey USDG bal: 200000` (= 0.2 USDG, 6 dp).

**Correction required:** relabel the row in README.md and TECHSPEC.md from
"Overcall fee switch key (can turn Valorem 15 bps fee on; cannot seize collateral)" to
**"Overcall treasury — Valorem `feeTo()` (15 bps switch, cannot seize collateral) AND the 5% premium-fee
consideration recipient on every Overcall Seaport order."** The keeper must expect this exact address as the
second consideration recipient; an order that pays a different address is not an Overcall order.

### It has never sent a transaction, on any chain I could check.

```
0xdAe7e82A2E7D566C67E87C164B05a1C560190782 nonce=0 balance_eth=0.00000000   (chain 4663)
feeKey code on arbitrum: 0 bytes   nonce 0x0
feeKey code on base:     0 bytes   nonce 0x0
feeKey code on ethereum: "0x"      nonce 0x0
```

So: a plain EOA, **zero code and zero nonce on 4663, Ethereum, Arbitrum and Base**, holding 0 ETH and 0.2 USDG.
Two consequences worth putting in the risk section:
1. It **cannot flip the fee switch today** — it has no gas on 4663. Near-term fee-switch risk is lower than the
   README implies. But this can change with one funding transfer, so the `feesEnabled()` write-gate stays mandatory.
2. It is **not a Safe or multisig anywhere** — it is a single unused key that simultaneously holds Overcall's
   revenue and Valorem's only privileged role. That is a single-key concentration worth naming explicitly.

---

## 5. USDG — `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` — is it really 6 decimals?

**Yes.**

```
name()        -> 'Global Dollar'
symbol()      -> 'USDG'
decimals()    -> 0x…06   = 6
totalSupply() -> 0x289caa6f126e9 = 714,453,430.642409 USDG
owner()       -> 0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f
paused()      -> false
DOMAIN_SEPARATOR() -> 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036
```

170-byte ERC-1967 minimal proxy. Raw runtime contains the EIP-1967 implementation slot constant
`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`. Storage reads:

```
USDG eip1967.impl   0x0000…68184c449e1a8f34fa18d289737129fd27b66f8f
USDG eip1967.admin  0x0000…0000   (empty)
USDG eip1967.beacon 0x0000…0000   (empty)
```

Implementation: `0x68184c449e1a8f34fa18d289737129fd27b66f8f`. Admin slot empty → not a TransparentUpgradeableProxy;
upgrade authority lives in the implementation (UUPS-style), gated by `owner()` =
`0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f`. Deployed before the archive floor (block ≤ 55,989,685) so I could
not recover its deployment tx — see UNRESOLVED.

---

## 6. NVDA Stock Token — `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` — is it really NVDA?

**Yes.**

```
name()        -> 'NVIDIA • Robinhood Token'
symbol()      -> 'NVDA'
decimals()    -> 18
totalSupply() -> 0x144aa276f67e09eb3c00 = 95,824.09553415 NVDA
paused()      -> false
uiMultiplier()-> 0x0de377b4760af643 = 1000775159164630595  (= 1.000775159164630595e18)
DOMAIN_SEPARATOR() -> 0x9561b23bbb0b6a2c7eecb765b6ae196568c31251e7086d435234d3017abcf6f7
```

`uiMultiplier()` (selector `0xa60bf13d`) exists and **is already ≠ 1e18** — it is 1.000775…, so the ERC-8056
adjustment is live today, not a future concern. The README's "internal accounting uses raw balances, UI shows
multiplier-adjusted share-equivalent" is the right call and must be implemented from day one.

---

## 7. Correction: NVDA is a **beacon** proxy, not a plain proxy — shared upgrade surface

The 283-byte runtime is not an EIP-1967 implementation-slot proxy. It reads `implementation()` (`0x5c60da1b`)
from a **hard-coded beacon address baked into the bytecode**:

```
0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000
  e10b6f6b275de231345c20d14ab812db62151b00 6001600160a01b0316635c60da1b …
```

Storage reads confirm:

```
NVDA eip1967.impl   0x0000…0000  (empty)
NVDA eip1967.admin  0x0000…0000  (empty)
NVDA eip1967.beacon 0x0000…e10b6f6b275de231345c20d14ab812db62151b00
0xe10b…1b00 .implementation() -> 0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2   (beacon codelen 2332)
```

So: **NVDA → beacon `0xe10b6f6b275de231345c20d14ab812db62151b00` → logic `0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2`.**

AAPL, TSLA, AMZN, SPY, SPCX all have the **same 283-byte runtime** (see §10), i.e. every Robinhood Stock Token
shares this one beacon. That means **a single beacon upgrade changes the logic of every stock token at once** —
including `transfer`, `uiMultiplier` and any freeze semantics.

README's risk list says only *"Issuer freeze. RHJ can halt transfers."* That understates it. Add:
*"Stock Token logic is a shared upgradeable beacon (`0xe10b6f6b275de231345c20d14ab812db62151b00`). One beacon
upgrade re-points every stock token's implementation simultaneously; the vault has no notice and no veto."*

---

## 8. Correction: the Overcall Seaport order uses **NO conduit** — direct Seaport approval

TECHSPEC lists `AdapterSeaport.sol // EIP-712 hash + conduit approvals`. The live reference order has
`conduitKey = 0x00…00` and the writer approved **Seaport itself**, not a conduit:

```
ApprovalForAll blk 60303653  owner=0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
                             operator=0x0000000000000068f116a894984e2db1123eb395  (Seaport)
ApprovalForAll blk 60910861  owner=0x789a7490718cf944d6f2ca411ed53cdefd56306a
                             operator=0x0000000000000068f116a894984e2db1123eb395  (Seaport)
```

Full decode of the only real fill (`fulfillOrder(Order,bytes32)`, selector `0xb3a34c4c`):

```
word1 fulfillerConduitKey: 0x0000…0000
  offerer:    0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
  zone:       0x0000000000000000000000000000000000000000
  orderType:  1                      (PARTIAL_OPEN — partial fills ARE allowed)
  startTime:  0
  endTime:    1789761600             (Fri 2026-09-18 20:00:00Z — == exerciseTimestamp)
  zoneHash:   0x0000…0000
  salt:       0xd41d3e5932ad2f6d51910cd86e5482e154a23ea77275d006d602712094dda344
  conduitKey: 0x0000…0000            <-- ZERO CONDUIT
  totalOriginalConsiderationItems: 2
  offer items: 1
    itemType=3 (ERC1155) token=0x9a7b40e5…c78c0c0 id=568853959…97792 start=1 end=1
  consideration items: 2
    itemType=1 (ERC20) token=0x5fc5360d…1d168 (USDG) amt=3800000 recipient=0xe73d7021…1275be   (95%)
    itemType=1 (ERC20) token=0x5fc5360d…1d168 (USDG) amt=200000  recipient=0xdae7e82a…190782   (5%)
  signature len: 65  (plain ECDSA — NOT EIP-1271)
OrderFulfilled orderHash 0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522
```

Actionable consequences for this repo (this also closes plan.md R2 and R9):
- The vault approves **Seaport directly** with `setApprovalForAll(0x…68F116a894984e2DB1123eB395, true)` on the
  clearinghouse. Do **not** build conduit plumbing.
- `orderType = 1` (PARTIAL_OPEN) → a buyer may take fewer than `n` contracts. The vault's accounting must handle
  partial fills, not assume all-or-nothing.
- `startTime = 0`, `endTime = registry.exerciseTimestamp()` — the listing expires at the instant exercise opens.
- Two considerations, fixed 95/5 split, second recipient hard-coded to `0xdAe7e8…190782`.
- The reference order is signed by an **EOA with a 65-byte signature**. Our vault would sign via **EIP-1271**.
  Seaport supports that, but whether Overcall's off-chain book accepts a contract maker is **UNRESOLVED** (R3).

---

## 9. BLOCKER: no explorer on 4663 serves verified source or an ABI

None of the six addresses has verified source I could retrieve. Every explorer route I tried:

| Endpoint | Result |
|---|---|
| `https://robinhoodchain.blockscout.com/api/v2/addresses/{a}` | HTTP **403**, Cloudflare `cf-mitigated: challenge`, "Just a moment…" interstitial. Fails with curl (any UA) **and** with WebFetch. |
| `https://robinhoodchain.blockscout.com/api/v2/smart-contracts/{a}` | same 403 challenge |
| `https://robinscan.io/api?module=contract&action=getsourcecode&address={a}` | `{"error":"not found"}` 404 |
| `https://robinscan.io/api/v2/smart-contracts/{a}` | `{"error":"not found"}` 404 |
| `https://robinscan.io/api/v2/stats` | `{"error":"not found"}` 404 — no Blockscout API at all |
| `https://hoodscan.co/api/v2/...` | HTTP 403 `{"code":"FORBIDDEN"}` — by design; it serves pages, not a Blockscout API |
| `https://stonkscan.io/api?...` | returns the Next.js HTML shell, no API |

`hoodscan.co` does expose an agent path: `https://hoodscan.co/llms.txt`, an MCP server at
`https://hoodscan.co/mcp` (Streamable HTTP, no auth), and any page URL answers with Markdown when requested with
`Accept: text/markdown`. But `/address/{a}` returns only a stub (title + canonical link, no contract data) and its
`openapi.json` exposes only `/stocks-api`, `/stocks-api/{address}`, `/api/sandbox/stocks`.

**This escalates plan.md R8 from "unknown" to "blocker".** We have no working contract-verification endpoint for
deploy time and no verified-source route for third-party contracts. Options to evaluate: the HoodScan MCP server,
a Blockscout API key / non-Cloudflare host, or self-hosting verification. Until then, "Confirm on explorer before
wiring" in README.md §Addresses is not an executable instruction.

Consequence for the audit claim: Overcall's site says Valorem Clear is *"audited, deployed unmodified"*, and the
deployed contract's **entire** external ABI matches `valorem-labs-inc/clear@master` with nothing extra. That is
strong but it is **not** a byte-level proof. Before mainnet, compile `valorem-labs-inc/clear` at the audited
commit with matching solc settings and diff the runtime against the 16,110 on-chain bytes.

---

## 10. Bonus, and it closes plan.md R1: the seven OvercallRegistry contracts

The Valorem deployer `0x408adcffebdf48ec23f1e3811a91aed3cc951cc0` (nonce 73) deployed seven **identical
5,905-byte** contracts at nonces 2–8. `cast compute-address` + `eth_getCode`:

```
nonce 0  0xE53cCB924d27f421a91b59087587fD866C5d64c7  codelen=9901   <- TokenURIGenerator
nonce 1  0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0  codelen=16110  <- Valorem Clear
nonce 2  0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA  codelen=5905
nonce 3  0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1  codelen=5905
nonce 4  0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335  codelen=5905
nonce 5  0x915148f98C0450251261654ffb6B54BA7005efFF  codelen=5905
nonce 6  0x6369CeCe2de602Ce1911039C123dc97E816715A9  codelen=5905
nonce 7  0xB500929deb0100598D9A1392113a6F6D2A31C018  codelen=5905
nonce 8  0x195dcf905Ad9fDda76E492016E680B2D0F9F0877  codelen=5905
nonce 9+ codelen=0
```

Their dispatcher (28 selectors, extracted from bytecode and resolved) is exactly the registry plan.md R1 asks for:

```
0x6190c9d5 cycle()                       0xb2016bd4 collateralToken()
0x2e4d8c8f exerciseToken()               0x5d4f5f97 clearinghouse()
0xb1e4ff8b activeOptionIds()             0x4645ce49 strikePerContract(uint256)
0x7d4361bf exerciseTimestamp()           0xade6e2aa expiryTimestamp()
0xe136de20 writeDeadline()               0x4942f65f lotSize()
0xefdbdcdc cycleLotSize()                0x2f884710 cycleNumber()
0x316fda0f cycleCount()                  0x356944c4 cycleOf(uint256)
0x53a32acd cycleAt(uint256)              0x7910867b isApproved(uint256)
0x1e4191ea isCycleLive()                 0xfa85ba38 isWritingOpen()
0x9e9add41 canReplaceCycle()             0x04b86272 MIN_EXERCISE_WINDOW()
0xb8f07dea MAX_STRIKES()                 0x819868cb setCycle(uint256[],uint40,uint40)
0xa3ab1061 setLotSize(uint96)            0x8da5cb5b owner()  0xe30c3978 pendingOwner()
0x79ba5097 acceptOwnership()             0xf2fde38b transferOwnership(address)  0x715018a6 renounceOwnership()
```

### **The NVDA registry is `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`.**

```
=== registry 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA  collateral=0xd0601ce1…d9eec (NVDA)
    collateralToken()      0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec
    exerciseToken()        0x5fc5360d0400a0fd4f2af552add042d716f1d168   (USDG)
    clearinghouse()        0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0
    owner()                0x408adcffebdf48ec23f1e3811a91aed3cc951cc0
    lotSize()              1000000000000000000
    cycleLotSize()         1000000000000000000
    cycleNumber()          1     cycleCount()  1
    exerciseTimestamp()    1789761600  [Fri 2026-09-18 20:00:00Z]
    expiryTimestamp()      1789848000  [Sat 2026-09-19 20:00:00Z]
    writeDeadline()        1789761600  [Fri 2026-09-18 20:00:00Z]
    isCycleLive()          1     isWritingOpen()  1     canReplaceCycle()  0
    MIN_EXERCISE_WINDOW()  86400     MAX_STRIKES()  5     pendingOwner()  0
    activeOptionIds()      n=5
        113025628429828481228850936737953628080486640605422851339090182744894714413056  strike 226.0
        29652592033419692000166847561911668028189801263392568326594311383797020491776   strike 231.0
        13956151908388063551378518883460877979717043668997816139085862263440384458752   strike 236.0
        8012928620938394388054169085135774622795258770514699139381494411582911807488    strike 241.0
        56885395977254369119998982131173877604217583767740146085872832926902011297792   strike 246.0
```

`cycle()` raw ABI shape (384 bytes) — a struct returned by reference:

```
w0  0x20                              (head offset)
w1  1                                 cycleNumber
w2  1789761600                        exerciseTimestamp
w3  1789848000                        expiryTimestamp
w4  1000000000000000000               lotSize
w5  0xa0                              offset to optionIds[]
w6  5                                 optionIds.length
w7..w11                               the five optionIds above
```

All seven registries:

| Registry | Collateral | Symbol | cycleNumber | isCycleLive | strikes (USDG) |
|---|---|---|---|---|---|
| `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA` | `0xd0601CE1…D9EEC` | **NVDA** | 1 | yes | 226 / 231 / 236 / 241 / 246 |
| `0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1` | `0x322f0929…3b2d` | TSLA | 1 | yes | 373 / 380 / 388 / 396 / 404 |
| `0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335` | `0x1b0e319c…153e` | GME | 0 | **no** | — (registry exists, no cycle ever set) |
| `0x915148f98C0450251261654ffb6B54BA7005efFF` | `0x4a0e65a3…5eea` | SPCX | 1 | yes | 154 / 157 / 160 / 163 / 166 |
| `0x6369CeCe2de602Ce1911039C123dc97E816715A9` | `0x117cc213…4c0c` | SPY | 1 | yes | 784 / 800 / 816 / 832 / 849 |
| `0xB500929deb0100598D9A1392113a6F6D2A31C018` | `0xaf3d76f1…93f9` | AAPL | 1 | yes | 336 / 343 / 350 / 357 / 364 |
| `0x195dcf905Ad9fDda76E492016E680B2D0F9F0877` | `0x12f190a9…bf54` | AMZN | 1 | yes | 261 / 266 / 271 / 276 / 282 |

Every registry: `exerciseToken()` = USDG, `clearinghouse()` = the audited address, `owner()` = the deployer EOA,
`lotSize()` = 1e18, `MAX_STRIKES()` = 5, `MIN_EXERCISE_WINDOW()` = 86400 (24 h).

**README §Addresses says "Overcall NVDA registry and conduit/zone IDs: fill in at deploy from a live Overcall
order."** They are now known: registry above, `zone = address(0)`, `conduitKey = bytes32(0)`.

Rung spacing is ~2.2% (226 → 246 spans 8.85% across 4 steps). The README's 3–12% OTM band therefore admits
roughly the top 3–4 of 5 rungs — compatible with "Max listings signed per cycle: 3", but tight. Worth a note in
`Policy.sol`: if spot moves, the band may admit 0 rungs and the vault correctly writes nothing.

Lot / strike units confirmed on-chain via `option(uint256)` for the strike-246 NVDA type:

```
  underlyingAsset   0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec
  underlyingAmount  1000000000000000000        = 1.0000 NVDA per contract   (README lot size CORRECT)
  exerciseAsset     0x5fc5360d0400a0fd4f2af552add042d716f1d168
  exerciseAmount    246000000                  = 246.000000 USDG            (TECHSPEC "S * 1e6" CORRECT)
  exerciseTimestamp 1789761600  Fri 2026-09-18 20:00:00Z
  expiryTimestamp   1789848000  Sat 2026-09-19 20:00:00Z
```

**README's "book close Friday 20:00 UTC, expiry Saturday 20:00 UTC" is exactly right** — and matches Overcall's
own site ("Book closes: Fri 20:00 UTC / Expires: Sat 20:00 UTC"). Mechanically: `writeDeadline ==
exerciseTimestamp == Seaport order endTime == Fri 20:00`, and `expiryTimestamp == Sat 20:00`.

---

## 11. Overcall market size today — this is a very young, very thin venue

All 59 logs ever emitted by the clearinghouse, pulled with `eth_getLogs` from its deploy block to head in 300k
chunks and classified by topic0:

```
total logs: 59
    50  0x4da1232e…  NewOptionType(uint256,address,address,uint96,uint96,uint40,uint40)
     2  0x64b996b5…  OptionsWritten(uint256,address,uint256,uint112)
     2  0x018396e2…  BucketWrittenInto(uint256,uint256,uint96,uint112)
     2  0x4a39dc06…  TransferBatch
     2  0x17307eab…  ApprovalForAll
     1  0xc3d58168…  TransferSingle
first log block 60254094 (Fri 2026-09-11 12:23:10Z)   last log block 61153997 (Sat 2026-09-12 13:49:12Z)
```

Zero `ClaimRedeemed`, zero `OptionsExercised`, zero `FeeAccrued`, zero `FeeSwept`, zero `FeeSwitchUpdated`.

The two writes ever:

```
blk 60302146 Fri 2026-09-11 13:45:10Z  optionId …297792 (NVDA, strike 246)  writer 0xe73d7021…1275be  amount 1
blk 60910684 Sat 2026-09-12 06:58:16Z  optionId …129344 (Cash Cat, strike 0.172) writer 0x789a7490…56306a  amount 21
```

The one fill ever: the 4.00 USDG NVDA-246 trade decoded in §4/§8.
Clearinghouse balances right now: `Valorem NVDA bal: 1000000000000000000` (1.0 NVDA), `Valorem USDG bal: 0`.

Premium context: 4.00 USDG on one 1-NVDA contract. With the 226 rung as the near-ATM strike, that is on the order
of 1.8% of spot for the week — comfortably above the README's `Min list premium 0.40% of spot / week`.
But **n = 1**. The README's "No buyer. Most likely failure mode." is, on this evidence, the base case.

Overcall runs option types against six stock tokens **and four memecoins** — the 50 `NewOptionType` events cover:

```
0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec  NVDA  'NVIDIA • Robinhood Token'       226 – 246
0x322f0929c4625ed5bad873c95208d54e1c003b2d  TSLA  'Tesla • Robinhood Token'        373 – 404
0xaf3d76f1834a1d425780943c99ea8a608f8a93f9  AAPL  'Apple • Robinhood Token'        336 – 364
0x12f190a9f9d7d37a250758b26824b97ce941bf54  AMZN  'Amazon • Robinhood Token'       261 – 282
0x117cc2133c37b721f49de2a7a74833232b3b4c0c  SPY   'SPDR S&P 500 ETF Trust • …'     784 – 849
0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea  SPCX  'Space Exploration Technologies…'154 – 166
0x020bfc650a365f8bb26819deaabf3e21291018b4  CASHCAT 'Cash Cat'                     0.172 – 0.187
0x39dbed3a2bd333467115de45665cc57f813c4571  PONS  'Pons'                           0.645 – 0.698
0x2e8c31162b855a2ffa90f6f8634643ad6f111e18  AI    'Artificial Inu'                 0.313 – 0.339
0xd7321801caae694090694ff55a9323139f043b88  JUGGERNAUT 'The Juggernaut'            0.01014 – 0.01098
```

Note the asymmetry: **10 underlyings have live option ladders but only 7 registries exist from this deployer, and
only 6 of those have a live cycle.** The four memecoin ladders (CASHCAT / PONS / AI / JUGGERNAUT) have no registry
among nonces 2–8. Either a second deployer holds more registries, or those types were created by calling
`newOptionType` directly (Valorem is permissionless). Flagged as UNRESOLVED — it matters because the keeper is
supposed to bind to `registry.cycle()`, and a ladder without a registry is not keeper-bindable.

---

## 12. The two addresses handed to me — and the busiest contracts on 4663

### `0x780a9ee45f84d2bdeb8451da4bedc869ba0a8b60` and `0xb55fbcf06f9924578687beebb26c0877948d83b1`

Nothing to do with Stonkhouse. Both were created **inside the same transaction**
`0xc9f859fa62bf25fa9bb8e85d1bb3c15ed7b4af7f55d4f2d825151e2b790619d1` (to launchpad
`0xe33e9e479df8802cb0866d5d05258bec4cf62948`) in block **61299061** (Sat 2026-09-12 17:56:31Z — minutes old when
I looked):

```
0x780a9ee45f84d2bdeb8451da4bedc869ba0a8b60  codelen=3248   name()='FOMO' symbol()='FOMO' decimals()=18
                                            totalSupply()=1e27
0xb55fbcf06f9924578687beebb26c0877948d83b1  codelen=10229  factory()=0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e
                                            getReserves() responds -> a Uniswap-V2-style AMM pair
```

`0x780a…` is a **FOMO memecoin** (identical 3,248-byte template to `0x4f3e89a5…5593` = `'10xfun'/'10X'`);
`0xb55f…` is its **liquidity pair**. Launchpad/router `0xe33e9e47…2948` and factory `0x7ed598bc…ec7e` are both
owned by `0x263ed295dafae1d9aadd6e56c4b6f9f38ee019dd`.

### Busiest `to` addresses — 300 consecutive blocks ending at head 61,314,582 (3,236 txs)

```
  300  0x00000000000000000000000000000000000a4b05  0x6bf6a42d startBlock(uint256,uint64,uint64,uint64)  [ArbOS internal, 1/block]
  271  0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc  0x4d819a2a swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],…)
                                                   752 bytes, WETH9()=0x0bd7d308…ad73, owner()=0x0c628d65…fbb4  (aggregator entrypoint)
  267  0x8876789976decbfcbbbe364623c63652db8c0904  0x3593564c execute(bytes,bytes[],uint256)  -> Uniswap Universal Router (24546 B)
  149  0xcaf681a66d020601342297493863e78c959e5cb2  0x04e45aaf exactInputSingle / 0xac9650d8 multicall / 0x5ae401dc multicall(uint256,bytes[])
                                                   factory()=0x1f7d7550b1b028f7571e69a784071f0205fd2efa  -> Uniswap V3 SwapRouter02
  141  0xccc88a9d1b4ed6b0eaba998850414b24f1c315be  0x0a2b8f36 permit2TransferAndMulticall(...)  owner()=0x463cb782…f56e
  117  0x89e5db8b5aa49aa85ac63f691524311aeb649eba  0xb6f9de95/0x791ac947/0x7ff36ab5 -> Uniswap V2 Router02
                                                   factory()=0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f  WETH9()=0x0bd7d308…ad73
   94  0x4337084d9e255ff0702461cf8895ce9e3b5ff108  0x765e827f handleOps(...)  -> ERC-4337 EntryPoint-style
   83  0x5fc5360d0400a0fd4f2af552add042d716f1d168  transfer/approve/transferFrom  -> USDG (spec address, most-used token)
   76  0xef161b8b000810944017a69af3b4bb28c87ae318  0x39ecce49 (33832 B, unresolved)
   72  0xca11bde05977b3631167028862be2a173976ca11  0x174dea71 aggregate3Value  -> Multicall3 (spec address)
   65  0x9c3fa17f2b541bb8a5ab8958ccaa9bdf40631e8e  0x59a87bc1 buy / 0xd04c6983 sell / 0x3729bb9a sweepFees(uint256)
                                                   factory()=0x7ed598bc…ec7e  (bonding-curve pair, same DEX as §12)
   64  0x9689992f5b5c09447f15906d8d11214944488341  0x3e0f9c3c axiomTrade(bytes,bytes[],uint256)  (100 B proxy)
   50  0x4f3e89a560c8ca3bd79502a0a0e55a7ccc955593  approve -> token '10xfun' / '10X'
   38  0x80114879f80d156c8003676557324c518babd194  0xa0193551 / 0x3593564c
   34  0x6e2a35a7ad683cf634d91492d73bb7ff774c6919  0x0c307f76 dagSwapTo(...) / 0xf2c42696 dagSwapByOrderId(...)
   27  0x637e3b374a3d4c550fa2ac0c5ad8115a19f1b07e  0xa0712d68 mint(uint256)
   25  0x39dbed3a2bd333467115de45665cc57f813c4571  approve -> token 'Pons' / 'PONS'
   24  0x1521027b665fa38fa4a642991607ad708376dd7b  0x00000000
   20  0x58daec3116aae6d93017baaea7749052e8a04fa7  0xdd46508f modifyLiquidities(bytes,uint256)  -> Uniswap V4 position manager
   20  0xb300000b72deaeb607a12d5f54773d1c19c7028d  0x810c705b
```

Sanity check passes: this is a DEX/memecoin-dominated Arbitrum-Orbit chain with USDG as the quote asset, one
ArbOS internal tx per block, canonical Multicall3 in the top ten, and **none of Overcall's contracts anywhere in
the top 25** — consistent with §11 (three user transactions total across two days).

Corroboration from HoodScan's own 60-project directory (`https://hoodscan.co/projects`, fetched as Markdown):
grepping for `overcall|valorem|option|seaport|covered call` returns **zero hits**. Overcall is not yet listed by
the chain's own explorer directory.

### Independent confirmation from Overcall itself

`https://overcall.finance` states, verbatim:

```
Valorem Clear:      0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
Seaport 1.6:        0x0000000000000068F116a894984e2DB1123eB395
Fee switch holder:  0xdAe7e82A2E7D566C67E87C164B05a1C560190782
"5% protocol fee"
"Valorem Clear — audited, deployed unmodified"
Book closes: "Fri 20:00 UTC"   Expires: "Sat 20:00 UTC"
```

No chain id, no registry address, and no listings-API URL on the page.

---

## 13. Corrections we must make to README.md / TECHSPEC.md

1. **Relabel `0xdAe7e82A2E7D566C67E87C164B05a1C560190782`.** It is the Overcall **treasury**: Valorem `feeTo()`
   *and* the 5% premium-fee consideration recipient on every Overcall Seaport order (§4, proven). The current
   label describes only half of it. The keeper must assert this exact recipient when validating an order.
2. **Add to the fee-switch risk line:** the key is an EOA with **nonce 0 and 0 ETH on 4663, Ethereum, Arbitrum and
   Base** (§4). It cannot flip the switch until funded — and it is a single key, not a Safe, holding both the
   protocol's revenue and Valorem's only privileged role.
3. **TECHSPEC `AdapterSeaport.sol // EIP-712 hash + conduit approvals` → no conduit.** The live order has
   `conduitKey = bytes32(0)`, `zone = address(0)`, and writers `setApprovalForAll` **directly to Seaport** (§8).
   Delete conduit plumbing from the design.
4. **`orderType = 1` (PARTIAL_OPEN).** Partial fills are allowed. The vault's fill accounting must not assume
   all-or-nothing (§8).
5. **NVDA is a shared beacon proxy** (`0xe10b6f6b275de231345c20d14ab812db62151b00` → `0xb35490d6…5ae2`), and every
   stock token uses the same 283-byte beacon-proxy runtime. Add to Risks: one beacon upgrade re-points all stock
   tokens at once, with no notice (§7). Today's list says only "Issuer freeze".
6. **Fill in the registry addresses.** NVDA = `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA`; all seven listed in
   §10. README's "fill in at deploy" can now be resolved (§10).
7. **`uiMultiplier()` is already 1.000775159164630595, not 1.0** (§6). The multiplier-adjusted UI is required at
   launch, not later.
8. **R8 is a blocker, not an unknown.** "Confirm on explorer before wiring" is currently not executable: no 4663
   explorer serves verified source or an ABI to a script (§9). Pick a verification path before the deploy phase.
9. **Add a deploy-gate task:** compile `valorem-labs-inc/clear` at the Zellic-audited commit and byte-diff the
   runtime against the 16,110 on-chain bytes. "Deployed unmodified" is currently Overcall's claim plus a complete
   ABI match — not a byte-level proof (§9).
10. **Temper the maturity language.** The clearinghouse is **2 days old** (deployed 2026-09-10 11:47 UTC), has
    **2 writes and 1 fill ever**, and holds **1.0 NVDA** (§2, §11). Overcall does not appear in HoodScan's
    60-project directory. The README reads as if the venue is established.

Nothing else in the spec's address table is wrong. Valorem Clear, Seaport 1.6, USDG (6 dp), NVDA, and Multicall3
are all exactly what the spec says they are.

---

## UNRESOLVED

- **Verified source / ABI for any 4663 contract.** Blockscout is behind a Cloudflare managed challenge (403 to
  curl with three different UAs and to WebFetch); robinscan.io has no Blockscout API (404 on `/api` and
  `/api/v2/*`); hoodscan.co returns `{"code":"FORBIDDEN"}` on `/api/v2/*` by design; stonkscan.io serves only a
  Next.js shell. **Untried:** the HoodScan MCP server at `https://hoodscan.co/mcp`, and a Blockscout API key.
- **Deployment tx / block / deployer for Seaport, USDG, NVDA, Multicall3, and the NVDA beacon.** All five already
  had code at the deepest archive block I could reach (55,989,685 on ordofi, head-5.3M). The pruned official RPC
  cannot go past ~1–2k blocks. Needs a real archive node or a working explorer.
- **Byte-level equivalence of the deployed Valorem Clear to the Zellic-audited source.** Full external-ABI match
  + Overcall's "deployed unmodified" claim + correct constructor arity. Not compiled and diffed.
- **Who owns `0xdAe7e82A2E7D566C67E87C164B05a1C560190782`** and whether it is custodied as a single key or in a
  signer scheme. On-chain it is an unused EOA on all four chains checked; nothing more is derivable on-chain.
- **Why 10 underlyings have option ladders but only 7 registries exist** (§11). Either a second deployer holds
  more registries, or the memecoin types were created by direct permissionless `newOptionType` calls. Not chased.
- **Whether Overcall's off-chain book accepts an EIP-1271 contract maker.** The one reference order is signed by
  an EOA with a 65-byte ECDSA signature. This is plan.md R3 and I did not test a POST.
- **Overcall's listings API URL.** Not on `overcall.finance`'s landing page; I did not crawl the app bundle.
- **Identity of `0xef161b8b000810944017a69af3b4bb28c87ae318`** (33,832 B, selector `0x39ecce49`, #9 busiest) and
  `0x1521027b665fa38fa4a642991607ad708376dd7b` / `0xb300000b72deaeb607a12d5f54773d1c19c7028d` — selectors
  `0x39ecce49`, `0x810c705b`, `0xa0193551` are not in the openchain signature DB and I did not decompile.
- **USDG upgrade authority mechanics.** `owner() = 0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f`, EIP-1967 admin
  slot empty. Whether that owner can upgrade (UUPS) was not confirmed without the implementation's source.
- **Testnet 46630 (plan.md R7).** Out of scope for this task; not checked.

---

# Verification pass (independent re-audit, adversarial)

Second agent, 2026-09-12. Every check below was re-run from scratch against chain 4663; nothing
was taken from the report above. Tooling note: the session scratchpad is shared and a sibling
agent overwrote `rpc.py` mid-run, so all commands here use a uniquely-named helper
(`r10v_rpc.py`). Verdict: **PARTIAL** — the six spec addresses and the fee-key correction are
fully confirmed, but three claims are wrong and four "UNRESOLVED" items are resolvable.

## A. Confirmed — re-derived independently

### A.1 `eth_getCode` on every claimed address (all at `latest`)

```
ValoremClear         0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 bytes= 16110
Seaport              0x0000000000000068F116a894984e2DB1123eB395 bytes= 23981
USDG                 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 bytes=   170
NVDA                 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC bytes=   283
Multicall3           0xcA11bde05977b3631167028862bE2a173976CA11 bytes=  3808
FeeKey               0xdAe7e82A2E7D566C67E87C164B05a1C560190782 bytes=     0
Reg-NVDA             0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA bytes=  5905
Reg-TSLA             0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1 bytes=  5905
Reg-GME              0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335 bytes=  5905
Reg-SPCX             0x915148f98C0450251261654ffb6B54BA7005efFF bytes=  5905
Reg-SPY              0x6369CeCe2de602Ce1911039C123dc97E816715A9 bytes=  5905
Reg-AAPL             0xB500929deb0100598D9A1392113a6F6D2A31C018 bytes=  5905
Reg-AMZN             0x195dcf905Ad9fDda76E492016E680B2D0F9F0877 bytes=  5905
TokenURIGen          0xE53cCB924d27f421a91b59087587fD866C5d64c7 bytes=  9901
Deployer             0x408adcffebdf48ec23f1e3811a91aed3cc951cc0 bytes=     0
Beacon               0xe10b6f6b275de231345c20d14ab812db62151b00 bytes=  2332
BeaconImpl           0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2 bytes= 11614
USDGimpl             0x68184c449e1a8f34fa18d289737129fd27b66f8f bytes= 18644
ConduitController    0x00000000f9490004c11cef243f5400493c00ad63 bytes=  8820
Chainlink-RHNVDA     0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 bytes=  9571
FOMO                 0x780a9ee45f84d2bdeb8451da4bedc869ba0a8b60 bytes=  3248
FOMOpair             0xb55fbcf06f9924578687beebb26c0877948d83b1 bytes= 10229
```

Every size matches the report exactly. No claimed address is code-less except the two EOAs
(fee key, deployer), as claimed.

### A.2 CREATE derivation proves the deployer set cryptographically

```
cast compute-address 0x408adcffebdf48ec23f1e3811a91aed3cc951cc0 --nonce N
 nonce 0 -> 0xE53cCB924d27f421a91b59087587fD866C5d64c7   TokenURIGenerator
 nonce 1 -> 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0   ValoremOptionsClearinghouse
 nonce 2 -> 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA   Registry NVDA
 nonce 3 -> 0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1   Registry TSLA
 nonce 4 -> 0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335   Registry GME
 nonce 5 -> 0x915148f98C0450251261654ffb6B54BA7005efFF   Registry SPCX
 nonce 6 -> 0x6369CeCe2de602Ce1911039C123dc97E816715A9   Registry SPY
 nonce 7 -> 0xB500929deb0100598D9A1392113a6F6D2A31C018   Registry AAPL
 nonce 8 -> 0x195dcf905Ad9fDda76E492016E680B2D0F9F0877   Registry AMZN
```
This is stronger evidence than the report gave. Deployer nonce is now **73**, balance
0.013982486926892 ETH.

### A.3 Valorem deployment tx

```
from 0x408adcffebdf48ec23f1e3811a91aed3cc951cc0  to None  nonce 1  block 59378584
contractAddress 0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0  status 0x1
ts 1789040820  2026-09-10T11:47:00Z
creation input len bytes 16445
last 128 hex: ...dae7e82a2e7d566c67e87c164b05a1c560190782 ...e53ccb924d27f421a91b59087587fd866c5d64c7
  arg0 = 0xdae7e82a2e7d566c67e87c164b05a1c560190782
  arg1 = 0xe53ccb924d27f421a91b59087587fd866c5d64c7
```
Confirmed verbatim.

### A.4 Live Valorem reads

```
feesEnabled()                 -> 0x00..00        (false)
feeTo()                       -> 0x..dae7e82a2e7d566c67e87c164b05a1c560190782
feeBps()                      -> 0x..0f          (15)
tokenURIGenerator()           -> 0x..e53ccb924d27f421a91b59087587fd866c5d64c7
supportsInterface(0xd9b67a26) -> 1               (ERC-1155)
supportsInterface(0x01ffc9a7) -> 1
balanceOf(0,0)                -> 0               (responds)
balanceOfBatch([],[])         -> empty array     (responds)
isApprovedForAll(0,0)         -> 0
feeBalance(USDG)              -> 0
tokenType(1)                  -> 0
uri(0)                        -> revert 0x6caeb130 = TokenNotFound(uint256)  [cast sig confirms]
owner()                       -> revert 0x        (no owner, as claimed)
paused()                      -> revert 0x        (no pause, as claimed)
name()/symbol()               -> revert 0x
```

### A.5 Every claimed selector recomputed with `cast sig` — all match

All 26 Valorem selectors, all 28 registry selectors, `information()` `0xf47b7740`,
`uiMultiplier()` `0xa60bf13d`, `implementation()` `0x5c60da1b`, `aggregate3Value` `0x174dea71`,
`factory()` `0xc45a0155`, `getReserves()` `0x0902f1ac` — identical to the report.
`fulfillOrder(Order,bytes32)` = `0xb3a34c4c` confirmed with the full nested tuple:
```
cast sig "fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)"
0xb3a34c4c
```
Event topics recomputed: `NewOptionType` `0x4da1232e…3aeb`, `OptionsWritten` `0x64b996b5…7abb`,
`BucketWrittenInto` `0x018396e2…24fd`, `OrderFulfilled` `0x9d9af8e3…6f31`. All match.

### A.6 Seaport is 1.6 — and the diff extends to Ethereum mainnet too

```
name()        -> 'Seaport'
information() -> version '1.6'
                 domainSeparator   0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0
                 conduitController 0x00000000f9490004c11cef243f5400493c00ad63
eth_chainId   -> 0x1237

len 4663 23981 | len arb 23981 | len eth 23981
arb differing bytes: 34   ranges [(15419,15420),(15427,15458)]
    15419-15420  4663=0x1237      arb=0xa4b1
    15427-15458  4663=0xa6b20d2b… arb=0x2b9168d7…
eth differing bytes: 34   ranges [(15419,15420),(15427,15458)]
    15419-15420  4663=0x1237      eth=0x0001
    15427-15458  4663=0xa6b20d2b… eth=0xfce34bc6…
```
Confirmed against **two** reference chains, not one. The only differences are the cached
`_CHAIN_ID` and `_DOMAIN_SEPARATOR`.

### A.7 Multicall3 byte-identical on four chains

```
MC3 4663  bytes= 3808 sha256=2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e
MC3 arb   bytes= 3808 sha256=2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e
MC3 base  bytes= 3808 sha256=2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e
MC3 eth   bytes= 3808 sha256=2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e
```

### A.8 Tokens

```
USDG  name 'Global Dollar' symbol 'USDG' decimals 6 totalSupply 714453430.642409
      paused false  owner 0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f
      eip1967 impl   0x68184c449e1a8f34fa18d289737129fd27b66f8f
      eip1967 beacon 0x0    eip1967 admin 0x0
NVDA  name 'NVIDIA • Robinhood Token' symbol 'NVDA' decimals 18 totalSupply 95824.09553415
      paused false  owner() reverts  oraclePaused() -> false
      uiMultiplier() 0x0de377b4760af643 = 1000775159164630595 = 1.0007751591646306
      eip1967 impl   0x0    eip1967 admin 0x0
      eip1967 beacon 0xe10b6f6b275de231345c20d14ab812db62151b00
```
The 283-byte NVDA runtime is dumped in full below — it contains a **PUSH32 literal** of the
beacon and calls `0x5c60da1b`, so the beacon-proxy claim is proven from the bytecode itself:
```
0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000
e10b6f6b275de231345c20d14ab812db62151b006001600160a01b0316635c60da1b6040518163ffffffff
1660e01b8152600401602060405180830381865afa…
```
`beacon.implementation()` -> `0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2`. Confirmed.

All six sibling stock tokens share a **byte-identical** 283-byte runtime (so the same beacon):
```
TSLA 0x322f0929c4625ed5bad873c95208d54e1c003b2d same_as_NVDA=True 'Tesla • Robinhood Token'
GME  0x1b0e319c6a659f002271b69db8a7df2f911c153e same_as_NVDA=True 'GameStop • Robinhood Token'
SPCX 0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea same_as_NVDA=True 'Space Exploration Technologies Corp. Class A Common Stock • Robinhood Token'
SPY  0x117cc2133c37b721f49de2a7a74833232b3b4c0c same_as_NVDA=True 'SPDR S&P 500 ETF Trust • Robinhood Token'
AAPL 0xaf3d76f1834a1d425780943c99ea8a608f8a93f9 same_as_NVDA=True 'Apple • Robinhood Token'
AMZN 0x12f190a9f9d7d37a250758b26824b97ce941bf54 same_as_NVDA=True 'Amazon • Robinhood Token'
```

### A.9 The fee key — both halves re-confirmed

```
FEEKEY 4663  code=0x nonce=0 bal=0
FEEKEY eth   code=0x nonce=0 bal=0
FEEKEY arb   code=0x nonce=0 bal=0
FEEKEY base  code=0x nonce=0 bal=0
USDG balanceOf(feekey) -> 0x30d40 = 200000 = 0.2 USDG
```

Fill tx `0x013cd30b541372fa7f505dfb743a563f39e284b7d2805dbcb964b6a754ae720b`:
```
to 0x0000000000000068f116a894984e2db1123eb395   selector 0xb3a34c4c   status 0x1  block 61153997
from 0x8684c0b2e23d0c699a1ff4437e8d92258bc82905
ERC20 Transfer 0x8684c0…82905 -> 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be  3800000
ERC20 Transfer 0x8684c0…82905 -> 0xdae7e82a2e7d566c67e87c164b05a1c560190782   200000
```
The 5% premium-fee claim is **CONFIRMED**. README/TECHSPEC must relabel this address.

### A.10 Full calldata decode of the reference fill — every field matches

Raw 38 words decoded by hand (no library):
```
w0  = 0x40                              offset to Order
w1  = 0x00…00                           fulfillerConduitKey = 0
  parameters:
    offerer   0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
    zone      0x0000000000000000000000000000000000000000
    orderType 1                         PARTIAL_OPEN
    startTime 0
    endTime   0x6aad9840 = 1789761600   == registry exerciseTimestamp
    zoneHash  0x00…00
    salt      0xd41d3e5932ad2f6d51910cd86e5482e154a23ea77275d006d602712094dda344
    conduitKey 0x00…00
    totalOriginalConsiderationItems 2
  offer[0]   itemType 3 (ERC1155) token 0x9a7b40e5…c78c0c0
             identifier 0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
             start 1 end 1
  consid[0]  itemType 1 USDG  3800000 -> 0xe73d7021…1275be
  consid[1]  itemType 1 USDG   200000 -> 0xdae7e82a…190782
  signature  0x41 = 65 bytes, v=0x1b    plain ECDSA
```
Every field in the report's decode is correct.

`isApprovedForAll(writer, Seaport)` on the clearinghouse returns **1**, and the only two
`ApprovalForAll` events the clearinghouse has ever emitted both name Seaport as operator:
```
ApprovalForAll owner=0xe73d7021a3ef2808c3dd8237982fcc5fa11275be operator=0x0000000000000068f116a894984e2db1123eb395 approved=1 blk 60303653
ApprovalForAll owner=0x789a7490718cf944d6f2ca411ed53cdefd56306a operator=0x0000000000000068f116a894984e2db1123eb395 approved=1 blk 60910861
```
**No conduit anywhere on this venue. CONFIRMED.** Both writers are EOAs (nonce 26 / nonce 23,
0 bytes of code), which is why the reference signature is a plain 65-byte ECDSA.

### A.11 `onlyFeeTo` surface — now proven from verified source, not inferred

Grep of the **Sourcify-verified deployed source** (see §B.3):
```
137:    modifier onlyFeeTo() {  if (msg.sender != feeTo) revert AccessControlViolation(...)  }
630:    function setFeesEnabled(bool enabled) external onlyFeeTo
637:    function setFeeTo(address newFeeTo) external onlyFeeTo       // sets pendingFeeTo only
657:    function setTokenURIGenerator(address ...) external onlyFeeTo
667:    function sweepFees(address[] calldata tokens) external onlyFeeTo
678:                fee = feeBalance[token];
682:                    feeBalance[token] = 1;
905:        feeBalance[assetAddress] += fee;                          // only writer of feeBalance
```
Exactly four `onlyFeeTo` functions. `sweepFees` reads only `feeBalance[token]`, whose sole
increment site is `_calculateRecordAndEmitFee` at line 905. **The fee key cannot touch
collateral. CONFIRMED, now at source level.**

### A.12 All 7 stock registries re-read live — every value matches

`collateralToken` / `exerciseToken` (USDG on all 7) / `clearinghouse` (the audited address on
all 7) / `lotSize` 1e18 / `MAX_STRIKES` 5 / `MIN_EXERCISE_WINDOW` 86400 /
`owner` `0x408adcff…51cc0` / `pendingOwner` 0 — all as reported. GME is `cycleNumber 0`,
`cycleCount 0`, `isCycleLive 0`, `activeOptionIds` n=0. The other six are cycle 1, live,
`exerciseTimestamp 1789761600`, `expiryTimestamp 1789848000`.

One value the report did not mention: **`canReplaceCycle()` is `false` on the NVDA registry**
and `true` on the other six. That is the registry protecting a cycle that has been written
into — consistent with the single NVDA write.

The 5,905-byte runtimes are **not** literally identical; NVDA vs AAPL differ in 57 bytes across
6 runs, all three embedded copies of the `collateralToken` immutable:
```
   1012-1025 / 1027-1031   nvda=d0601ce1…d9eec   aapl=af3d76f1…a93f9
   4108-4121 / 4123-4127   (same)
   4198-4211 / 4213-4217   (same)
```

`option()` for the NVDA rungs, read live off the clearinghouse:
```
underlyingAsset  NVDA   underlyingAmount 0x0de0b6b3a7640000 = 1e18  (all five)
exerciseAsset    USDG   exerciseAmount   0x0d787c80=226000000
                                         0x0dc4c7c0=231000000
                                         0x0e111300=236000000
                                         0x0e5d5e40=241000000
                                         0x0ea9a980=246000000
exerciseTimestamp 0x6aad9840=1789761600  expiryTimestamp 0x6aaee9c0=1789848000
nextClaimKey on the 246 rung = 2  (one claim written)
```
README lot size and TECHSPEC's `S * 1e6` are both correct. Fri 20:00 / Sat 20:00 correct.

### A.13 Market census re-run — 59 logs, exactly as claimed

`eth_getLogs` over `[59378584, head]` in 200k-block chunks, `address = clearinghouse`:
```
total logs 59
    50 NewOptionType
     2 OptionsWritten
     2 BucketWrittenInto
     2 TransferBatch
     2 ApprovalForAll
     1 TransferSingle
```
Zero `OptionsExercised`, `ClaimRedeemed`, `FeeAccrued`, `FeeSwept`, `FeeSwitchUpdated`.
`NVDA.balanceOf(clearinghouse) = 1.0`, `USDG.balanceOf(clearinghouse) = 0`. Confirmed.

### A.14 Chainlink feed (README row the report did not audit)

```
0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15  9571 bytes
description()      -> 'RHNVDA / USD'
decimals()         -> 8
version()          -> 6
aggregator()       -> 0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2
latestRoundData()  -> roundId 0x1…0401, answer 0x5152836b1 = 21847238321 = 218.47238321
```
Real, correct, and matches README.

---

## B. Corrections — things the report got wrong or left on the table

### B.1 REFUTED: "all seven OvercallRegistry addresses are now known (closes R1)". There are **eleven**.

The report's own UNRESOLVED #5 asks why 10 ladders exist but only 7 registries. The answer is
that it stopped enumerating the deployer's CREATE addresses at nonce 8. The deployer's nonce is
**73**. Scanning nonces 9–73 and `eth_getCode`-ing each:

```
nonce  45 0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1 bytes=5905  collateral=020bfc65…018b4
nonce  52 0x365B4D099768F6B2fF07200e7d5AA14D899c1897 bytes=5905  collateral=39dbed3a…c4571
nonce  53 0xD1d56916f6E945F59C6E226A7429Da688532a113 bytes=5905  collateral=2e8c3116…11e18
nonce  54 0x65dD407955912Be814f723724cE60f91ebd72616 bytes=5905  collateral=d7321801…43b88
(no other contract exists at nonces 9-73)
```

| Registry | Collateral | Symbol | cycle | live | strikes (USDG, 6 dp raw) |
|---|---|---|---|---|---|
| `0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1` | `0x020bfc650a365f8bb26819deaabf3e21291018b4` | `CASHCAT` (Cash Cat) | 1 | yes | 172000/175000/179000/183000/187000 |
| `0x365B4D099768F6B2fF07200e7d5AA14D899c1897` | `0x39dbed3a2bd333467115de45665cc57f813c4571` | `PONS` (Pons) | 1 | yes | 645000/658000/671000/684000/698000 |
| `0xD1d56916f6E945F59C6E226A7429Da688532a113` | `0x2e8c31162b855a2ffa90f6f8634643ad6f111e18` | `AI` (Artificial Inu) | 1 | yes | 313000/319000/325000/332000/339000 |
| `0x65dD407955912Be814f723724cE60f91ebd72616` | `0xd7321801caae694090694ff55a9323139f043b88` | `JUGGERNAUT` (The Juggernaut) | 1 | yes | 10140/10340/10550/10760/10980 |

All four: `exerciseToken()` = USDG, `clearinghouse()` = the audited address,
`owner()` = `0x408adcff…51cc0`, `lotSize()` = 1e18, `MAX_STRIKES()` = 5,
`exerciseTimestamp` 1789761600, `expiryTimestamp` 1789848000. Same contract, same operator.

**Closure proof that 11 is the complete set.** All 50 `NewOptionType` logs, decoded properly
(`underlyingAsset` is `topics[2]`, not a data word):
```
exerciseAssets:    {USDG: 50}
expiryTimestamps:  {1789848000: 50}
distinct underlyings: 10
  5  0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec  NVDA
  5  0x322f0929c4625ed5bad873c95208d54e1c003b2d  TSLA
  5  0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea  SPCX
  5  0x117cc2133c37b721f49de2a7a74833232b3b4c0c  SPY
  5  0xaf3d76f1834a1d425780943c99ea8a608f8a93f9  AAPL
  5  0x12f190a9f9d7d37a250758b26824b97ce941bf54  AMZN
  5  0x020bfc650a365f8bb26819deaabf3e21291018b4  CASHCAT
  5  0x39dbed3a2bd333467115de45665cc57f813c4571  PONS
  5  0x2e8c31162b855a2ffa90f6f8634643ad6f111e18  AI
  5  0xd7321801caae694090694ff55a9323139f043b88  JUGGERNAUT
```
10 underlyings × 5 rungs = 50 option types, plus GME with no cycle = 11 registries.
Nothing is missing and there is no second deployer. **UNRESOLVED #5 is resolved.**
(This also reconciles with plan.md §14, which already says "11 live markets".)

### B.2 WRONG: the claimed `cycle()` return shape does not decode

The report states:
> `cycle() [0x6190c9d5] -> (uint256 cycleNumber, uint40 exerciseTimestamp, uint40 expiryTimestamp, uint96 lotSize, uint256[] optionIds)`

It returns a single **struct**, not a flat tuple, and `number` is **uint32**:
```
$ cast call 0x8E973cE1…f4EA "cycle()((uint32,uint40,uint40,uint96,uint256[]))" --rpc-url https://rpc.mainnet.chain.robinhood.com
(1, 1789761600, 1789848000, 1000000000000000000, [1130256284…56, 2965259203…76, 1395615190…52, 8012928620…88, 5688539597…92])

$ cast call 0x8E973cE1…f4EA "cycle()(uint256,uint40,uint40,uint96,uint256[])" --rpc-url https://rpc.mainnet.chain.robinhood.com
Error: could not decode output; did you specify the wrong function return data type?
  ABI decoding failed: buffer overrun while deserializing
```
A dynamic struct is returned behind an offset pointer, so a flat decode reads `0x20` as the
cycle number. `contracts/src/interfaces/IOvercallRegistry.sol` already declares
`struct Cycle { uint32 number; uint40 exerciseTimestamp; uint40 expiryTimestamp; uint96 lotSize; uint256[] optionIds; }`
and `function cycle() external view returns (Cycle memory)` — so the **repo is right and the
report is wrong**. Do not copy the report's signature into the keeper.

### B.3 REFUTED: "no 4663 explorer serves verified source to a script (R8 is a blocker)"

**Sourcify supports chain 4663** and serves verified source and ABI over plain HTTP with no key
and no Cloudflare challenge:
```
$ curl https://sourcify.dev/server/chains | grep 4663
{'name': 'Robinhood Chain', 'chainId': 4663, 'supported': True, 'etherscanAPI': False,
 'rpc': ['…drpc…','https://rpc.mainnet.chain.robinhood.com','https://robinhood-rpc.publicnode.com','https://rpc.ordofi.network']}

$ curl https://sourcify.dev/server/v2/contract/4663/0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
{"matchId":"48600090","creationMatch":"exact_match","runtimeMatch":"exact_match",
 "verifiedAt":"2026-09-10T13:24:56Z","match":"exact_match","chainId":"4663", …}
```
Add `?fields=all` for sources, ABI, metadata, storage layout, stdJsonInput and deployment.
(Note: comma-separated `fields=` selectors are rejected — `{"customCode":"invalid_parameter"}`.
Use `fields=all` or the bare endpoint.)

Verification status swept across every address in this audit:

| Address | Sourcify | Verified name | solc |
|---|---|---|---|
| `0x9a7b40e5…C78C0C0` | **exact_match** (creation+runtime) | `lib/clear/src/ValoremOptionsClearinghouse.sol:ValoremOptionsClearinghouse` | 0.8.16+commit.07a7930e |
| `0xE53cCB92…5d64c7` | **exact_match** | `lib/clear/src/TokenURIGenerator.sol:TokenURIGenerator` | 0.8.16 |
| `0x8E973cE1…f4EA` (NVDA reg) | **exact_match** | `src/OvercallRegistry.sol:OvercallRegistry` | 0.8.28+commit.7893614a |
| `0x66992dD2…C5Ae1` (TSLA reg) | **exact_match** | same | 0.8.28 |
| `0xbDc50c66…A0335` (GME reg) | **exact_match** | same | 0.8.28 |
| `0x0000…3eB395` (Seaport) | match (runtime) | `src/Seaport.sol:Seaport` | 0.8.24+commit.e11b9ed9 |
| `0x5fc5360D…1d168` (USDG proxy) | match | `contracts/Erc1155/ERC1155CollectionProxy.sol:ERC1155CollectionProxy` | 0.8.30 |
| `0x68184c44…b66f8f` (USDG impl) | match | `contracts/stablecoins/USDG.sol:USDG` | 0.8.28 |
| `0xd0601CE1…D9EEC` (NVDA) | match | OZ `BeaconProxy` | 0.8.33 |
| `0xe10b6f6b…51b00` ("beacon") | **exact_match** | `src/AccessControlsRegistry.sol:AccessControlsRegistry` | 0.8.33 |
| `0xb35490d6…c5ae2` (stock impl) | **exact_match** | `src/Stock.sol:Stock` | 0.8.33 |
| `0xcA11bde0…76CA11` | **exact_match** | `Multicall3.sol:Multicall3` | 0.8.12 |
| `0xe33E9E47…62948` (launchpad) | **exact_match** | `contracts/src/v2/PonsV2LaunchAndBuy.sol:PonsV2LaunchAndBuy` | — |
| `0x7eD598Bc…1ec7e` (FOMO factory) | **exact_match** | `contracts/src/v2/PonsV2LaunchFactory.sol:PonsV2LaunchFactory` | — |
| `0x1E0F8a0a…27Bf1` `0x365B4D09…c1897` `0xD1d56916…2a113` `0x65dD4079…72616` | **not verified** | the four memecoin registries | — |
| `0xeF161b8b…Ae318` `0x1521027b…6dd7b` `0xb300000b…7028d` `0x780a9ee4…a8b60` `0xb55fbcf0…d83b1` `0x379EC4f7…E9F15` | not verified | — | — |

**R8 is not a blocker for reading ABIs/source.** It remains a blocker only for *publishing*
our own verification (no Blockscout/Etherscan verify API reachable) — Sourcify verification of
our deploy should be tested during M2. **UNRESOLVED #1 is resolved.**

### B.4 RESOLVED: "deployed unmodified" is now proven byte-for-byte, not inferred

Report UNRESOLVED #3 said "I did not compile the audited commit and diff the runtime bytes".
Sourcify's `creationMatch: exact_match` already does that. Additionally the verified source is
byte-identical to upstream master:
```
$ curl -sL https://raw.githubusercontent.com/valorem-labs-inc/clear/master/src/ValoremOptionsClearinghouse.sol -o up.sol
$ shasum -a 256 up.sol VOC.sol
73ee0bfbea54cb8a744fdcc1d8e551dd4b54eeb20200368ffcd3a0f9d177115d  up.sol
73ee0bfbea54cb8a744fdcc1d8e551dd4b54eeb20200368ffcd3a0f9d177115d  VOC.sol   (36238 bytes each)
```
Compiler settings recorded by Sourcify: `solc 0.8.16+commit.07a7930e`, optimizer on / 200 runs,
`evmVersion london`, `viaIR false`, `bytecodeHash ipfs`, remappings include
`clear/=lib/clear/src/` and `solmate/=lib/clear/lib/solmate/src/`.
Upstream's last change to that file is commit `2855df9ca5ad`, 2023-08-22 ("fix: reduce minimum
option duration to 1 minute for 0dte support"); the file has been frozen since.
**UNRESOLVED #3 is resolved for the clearinghouse.** Whether Zellic's report covers that exact
commit is a documentation question, not an on-chain one.

### B.5 PARTIALLY RESOLVED: deployment blocks for the pre-existing infrastructure

Report UNRESOLVED #2 said none of these were reachable. Sourcify's `deployment` field carries
four of them:
```
USDG proxy   0x5fc5360D…1d168  block 56     tx 0xc51b4ac115d158a50eb9cb902a9d1359d25200e3582192f75c0ad80beba54930  deployer 0xBe498aad9c6fd0E4Cd6d1E3fBb395026c5D28215
USDG impl    0x68184c44…b66f8f  block 56     tx 0x5a88b74f8ade975f0fbb8908b70cde112d64b263c9b60967996bb20314d48769  deployer 0xBe498aad9c6fd0E4Cd6d1E3fBb395026c5D28215
stock beacon 0xe10b6f6b…51b00   block 7662   tx 0x7984f34fe941971b6ea06f31653a84758872240090ce1e6d13ff0070f529c500  deployer 0x074377a78A9710A1D47244f89797718b4f491279
stock impl   0xb35490d6…c5ae2   block 7784   tx 0xd58cebebcd6bde7cd6b9a37aabf9ab220958b57e90c7f942ab1a53f45206420f  deployer 0x074377a78A9710A1D47244f89797718b4f491279
TokenURIGen  0xE53cCB92…5d64c7  block 59378584 txIndex 9  deployer 0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0
```
USDG is a genesis-era contract (block 56). The stock-token machinery landed at block ~7.7k.
Still missing: Seaport, the NVDA `BeaconProxy` instance, and Multicall3 (Sourcify records no
deployment for those three).

Archive-node claim re-tested and **confirmed**:
```
rh    blk head-1000   len 16110
rh    blk head-100000 {'code': -32000, 'message': 'metadata is not found, 61239933'}
rh    blk 59378585    {'code': -32000, 'message': 'metadata is not found, 59378588'}
pn    any historical  HTTP 403
ordo  blk head-1000 / head-100000 / 59378585   len 16110
ordo  blk 56000000   len 0   (correct empty answer -> archive floor is <= 56,000,000)
```

### B.6 The "beacon" is not an `UpgradeableBeacon` — it is `AccessControlsRegistry`

Sourcify names `0xe10b6f6b275de231345c20d14ab812db62151b00` as
`src/AccessControlsRegistry.sol:AccessControlsRegistry` (exact_match). It answers
`implementation()` so it functions as the beacon for all stock tokens, but its surface is
wider than "a beacon", and `owner()` reverts on it. The report's risk framing (one upgrade
re-points every stock token) stands and is if anything understated; the label does not.

### B.7 Events missing from the report's ABI list

The verified ABI has 15 events. The report listed 8 and omitted four that the indexer will see:
```
0x44ff2fbc78e1b47302b448d04100599303d07cbc0be8d0660f8aaf4e37e38688  BucketAssignedExercise(uint256,uint96,uint112)
0x9887df018dfa75103faf0f1388028e55a1124783c285d8d2cbcf62a067a6b844  FeeToUpdated(address)
0xcc1c2a8facb923b39ebff8338454ef2ebf13e0d9f7e105ff75a48966340194f6  TokenURIGeneratorUpdated(address)
0x6bb7ff708619ba0610cba295a58592e0451dee2622938c8755667688daf3529b  URI(string,uint256)
```
Topics for the ones it did name, recomputed from the verified ABI:
```
0xa3d8a607cd3c6b3ffa03a5117299750bca64916c2122f1efffb6bf643a35740f  ClaimRedeemed(uint256,uint256,address,uint256,uint256)
0xf6c60e0fc5385c6476a6ab1c19a57c2cf1dcd7634067c3dd0149a78ff5fd2b4d  OptionsExercised(uint256,address,uint112)
0xab6412cc7c5e1894494776aefcca0d1eabe45c98c0a9a5318808ac7f9ebf39fa  FeeAccrued(uint256,address,address,uint256)
0xc0f93f8147d0fdac4c9b68e295a3c0ae16c7e8367c0cd576144326b25205dbf4  FeeSwept(address,address,uint256)
0x96fbf5a8f3f0c618bcf274409014aca975bcc820a1ed78125a730bafd9a9704d  FeeSwitchUpdated(address,bool)
```
`NewOptionType` indexing matters and the report did not state it: `exerciseAsset`,
`underlyingAsset` and **`expiryTimestamp`** are indexed; `optionId` is **not**.

Verified return types worth pinning (some differ from the usual assumption):
```
feeBps()            -> uint8                (not uint256)
claim(uint256)      -> (uint256 amountWritten, uint256 amountExercised, uint256 optionId)   struct
position(uint256)   -> (address, int256 underlyingAmount, address, int256 exerciseAmount)   struct, SIGNED
option(uint256)     -> (address,uint96,address,uint96,uint40,uint40,uint160 settlementSeed,uint96 nextClaimKey)
write(uint256,uint112) -> uint256
tokenType(uint256)  -> uint8
```
`contracts/src/interfaces/IValoremClear.sol` already matches all of these.

### B.8 Registry selector list is missing one, and one Valorem selector is not a PUSH4

The registry has **28** ABI functions; the report listed 27. Missing:
`renounceOwnership()` `0x715018a6` (the source declares a `RenounceDisabled()` error, so it
reverts — but it is in the dispatcher and the indexer/ops docs should know it exists).

`balanceOf(address,uint256)` `0x00fdd58e` is **not** present as a PUSH4 literal in the Valorem
runtime — solc emits it as `PUSH3 0xfdd58e` (`62fdd58e` is present in the bytecode), which is
why a naive PUSH4 scan misses it. The function does respond. The report's "25-selector
dispatcher" vs the ABI's 26 functions is explained by exactly this.

### B.9 The OTM-band statement is backwards

The report says the 3–12% band "admits roughly the top 3–4 of 5 rungs". At the live feed price
of 218.47 the rungs are +3.45% / +5.73% / +8.02% / +10.31% / +12.60% OTM. A `minOtmBps 300 /
maxOtmBps 1200` policy admits 226 / 231 / 236 / 241 — the **bottom four**, with 246 excluded —
and "nearest OTM" picks 226. The count is right; the end of the ladder is not.

### B.10 The FOMO pair is not a Uniswap V2 pair

```
0xb55fbcf06f9924578687beebb26c0877948d83b1
  factory()     -> 0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e   (PonsV2LaunchFactory, Sourcify exact_match)
  getReserves() -> 0x…1761b225f997d4a3  0x…0338cffa501b074ab82eba63
  token0()      -> revert 0x
  token1()      -> revert 0x
  name()        -> revert 0x
```
A real UniV2 pair exposes `token0()`/`token1()`. This is a Pons V2 launch pool, not a
Uniswap-V2 pair. Irrelevant to Stonkhouse either way — the "unrelated" conclusion stands.

### B.11 Not verifiable: the busiest-`to` table

Every address in that table except three is elided (`0x65050a9b…40dc`, `0x88767899…0904`, …),
so it cannot be re-derived. The three full ones do exist:
`0xeF161b8b000810944017a69Af3B4bb28c87Ae318` 33832 B, `0x1521027b665fa38fa4a642991607ad708376dd7b`
141 B, `0xb300000b72deaeb607a12d5f54773d1c19c7028d` 180 B. None is Sourcify-verified, so the
report's UNRESOLVED #8 stands; treat the labelled rows of that table as unverified.

---

## C. UNRESOLVED after this pass

1. Deployment tx / block / deployer for **Seaport**, the **NVDA `BeaconProxy` instance**, and
   **Multicall3** on 4663. Sourcify carries no `deployment` record for them and ordofi's
   archive floor (~56,000,000) is far above their creation height. Needs a genuine full-archive
   node or a working explorer.
2. Who controls `0xdAe7e82A2E7D566C67E87C164B05a1C560190782`. Still an unused EOA (nonce 0,
   zero balance) on 4663 / Ethereum / Arbitrum / Base. Nothing further is derivable on chain.
   It holds both Overcall's revenue and Valorem's only privileged role, and it is not a Safe.
3. Whether Overcall's listings API accepts an **EIP-1271** maker. The single reference order is
   a 65-byte EOA signature and both known writers are EOAs. plan.md §14 records R3's answer
   ("ERC-1271 offerers explicitly accepted"); this pass did not independently re-test a POST.
4. Identity of `0xeF161b8b000810944017a69Af3B4bb28c87Ae318` (33,832 B, not Sourcify-verified),
   `0x1521027b665fa38fa4a642991607ad708376dd7b`, `0xb300000b72deaeb607a12d5f54773d1c19c7028d`.
5. Whether USDG's `owner()` `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f` can upgrade the
   implementation. USDG's impl **is** Sourcify-verified (`contracts/stablecoins/USDG.sol:USDG`,
   `match`), so this is now answerable by reading that source — not attempted here.
6. Whether the four memecoin registries are the same compiled `OvercallRegistry`. Their
   runtimes are 5,905 bytes and every read behaves identically, but they are **not** Sourcify-
   verified, so byte equivalence to the verified stock registries was not diffed.
7. Testnet 46630 — out of scope for R10; plan.md §14 records R7's answer (unusable).

## D. Actions for the spec

- `README.md` / `TECHSPEC.md`: relabel `0xdAe7e82A…0782` from "Overcall fee switch key" to
  **"Overcall treasury — Valorem `feeTo()` AND the 5% premium-fee recipient"**. It is one
  unfunded EOA holding both roles.
- `ops/addresses.json`: add the four memecoin registries so the registry list is the real 11,
  and mark the four as *source-unverified*.
- `ops/recon`: R8 should read "Blockscout is Cloudflare-gated, but **Sourcify serves chain 4663
  source + ABI + deployment metadata over plain HTTP**" — that is the route for `ops/abis/` and
  for verifying our own deploy.
- Do not copy this report's `cycle()` signature anywhere; use the struct form the repo already has.
