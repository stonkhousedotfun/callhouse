# R6 — NVDA Stock Token internals (ERC-8056, uiMultiplier, freeze) + USDG

**Chain:** Robinhood Chain mainnet, chainId 4663 (0x1237)
**RPC used:** `https://rpc.mainnet.chain.robinhood.com` (fallback `https://robinhood-rpc.publicnode.com`)
**Date of all live calls:** 2026-09-12, around block 61,307,000–61,321,000
**Method:** raw JSON-RPC (`eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getLogs`, `eth_getTransactionReceipt`), Geth-style `eth_call` **state overrides**, on-chain dispatch-table extraction, and selector/topic resolution against openchain.xyz.

> **Blockscout is unusable for this chain right now.** `https://robinhoodchain.blockscout.com/api/v2/...` and the legacy `/api?module=contract` endpoints all return a **Cloudflare managed challenge (HTTP 403, `cf-mitigated: challenge`)** for non-browser clients. So **no verified source was obtainable for any contract below.** Everything here is derived from deployed bytecode plus live calls. Every claim is backed by output quoted in this file.

---

## 0. TL;DR / answers to the brief

| # | Question | Answer |
|---|---|---|
| 1 | name/symbol/decimals/totalSupply | `NVIDIA • Robinhood Token` / `NVDA` / `18` / `95824095534150000000000` |
| 2 | `uiMultiplier()` semantics | selector `0xa60bf13d`, `uint256`, **1e18-scaled**, currently `1000775159164630595`. **NON-REBASING — proven.** `balanceOf`/`totalSupply` are raw and unchanged. **NOT a blocker.** |
| 3 | `oraclePaused()` | **EXISTS.** selector `0x7706ba52`, returns `bool`, currently `false`. It does **not** block transfers (proven by state override) — it is a pure signal, exactly what the Policy gate wants. |
| 4 | Freeze surface | **Large.** A single shared registry gives one EOA a **global cross-token pause**, another EOA a **blocklist** (246 addresses already blocked), plus per-token `pause()`, `mint`, `burn`, `adminBurn`, and beacon upgrade. **All 13 role holders are plain EOAs — no multisig, no timelock.** |
| 5 | ERC-20 return values | **Compliant.** `transfer` and `approve` return `true`; reverts use OpenZeppelin v5 custom errors. |
| 6 | Fee-on-transfer / hook | **None.** Proven with a compiled probe contract against live state: sender −X, recipient +X, exactly. |
| 7 | USDG | impl `0x68184c449e1a8f34fa18d289737129fd27b66f8f`, `Global Dollar`/`USDG`/**6 decimals (spec CONFIRMED)**/`714451814009907`. Freeze + wipe + pause exist and freeze is enforced. Admin is an **OZ TimelockController (24h min delay)** — better governance than the Stock Token side. No rebase. |

**Two findings that need to reach the risk disclosure and the Policy design (neither breaks share math):**

- **G1 — one EOA can halt every Stock Token on the chain at once.** `0xe7bcb188254bc6ebbff63014dfed4cd4a024f22a` holds `PAUSER_ROLE` on the shared registry. Proven by state override: with `registry.paused()==true`, `NVDA.transfer(...)` reverts `IsPaused()` (`0x1309a563`). The same registry backs **204 stock tokens**. This bricks `write`, `redeem` and depositor withdrawals simultaneously.
- **G2 — one EOA can blocklist the vault address itself.** `0x913ca87347391218e5de2c17c5a0aeba8b0b28fd` holds `BLOCKER_ROLE`. `blockAccounts(address[])` is a single unilateral call. Proven: transfer to *or from* a blocked address reverts `Blocked(address)` (`0x75e91ce7`). **246 addresses are already blocked** (they include OFAC-SDN Tornado Cash routers, so this is a live compliance list, not a dormant feature).

---

## 1. Proxy resolution

The NVDA token is **not** an EIP-1967 logic proxy. It is a **beacon proxy with the beacon hard-coded as an immutable**, and the beacon is simultaneously the chain-wide access-control registry.

```
$ eth_getCode 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00
6001600160a01b0316635c60da1b6040518163ffffffff1660e01b8152600401602060405180830381865afa...
```

The immutable `0xe10b6f6b275de231345c20d14ab812db62151b00` is called with `0x5c60da1b` = `implementation()`, and the result is the delegatecall target.

```
$ eth_getStorageAt NVDA 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc   (EIP-1967 impl)
0x0000...0000                                              <-- EMPTY, not a logic proxy
$ eth_getStorageAt NVDA 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50   (EIP-1967 beacon)
0x000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00
$ eth_call 0xe10b6f6b...1b00 0x5c60da1b   (implementation())
0x000000000000000000000000b35490d6f9163de4f80d88dc75c3516eb64c5ae2
$ eth_call NVDA 0x50c09be3   (ACCESS_CONTROLLED_REGISTRY())
0x000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00
```

| Role | Address | Code size |
|---|---|---|
| NVDA proxy | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 283 |
| **Beacon + AccessControlledRegistry** | **`0xe10b6f6b275de231345c20d14ab812db62151b00`** | 2332 |
| **Stock Token implementation** | **`0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2`** | 11614 |
| StockTokenFactory | `0x4783c67b63de2b358ac5951a7d41f47a38f3c046` | (upgradeable, 2 `Upgraded` events) |

USDG, by contrast, is a textbook `ERC1967Proxy`:

```
$ eth_getStorageAt 0x5fc5360D...d168 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
0x00000000000000000000000068184c449e1a8f34fa18d289737129fd27b66f8f
```

The registry has been upgraded twice (`Upgraded(address)` at blocks 7796 and 657134) — **both times to the same implementation** `0xb354...5ae2`, i.e. a re-point, not a logic change.

---

## 2. Live metadata

```
############ NVDA 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
name()          0x06fdde03 -> NVIDIA • Robinhood Token
symbol()        0x95d89b41 -> NVDA
decimals()      0x313ce567 -> 18
totalSupply()   0x18160ddd -> 95824095534150000000000
uiMultiplier()  0xa60bf13d -> 1000775159164630595
oraclePaused()  0x7706ba52 -> False
paused()        0x5c975abb -> False
tokenPaused()   0x86c75e74 -> False
uid()           0xf514ce36 -> 0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5
terms()         0xd5025625 -> https://robinhood.com/stocktoken/rhj
DOMAIN_SEPARATOR() 0x3644e515 -> 0x9561b23bbb0b6a2c7eecb765b6ae196568c31251e7086d435234d3017abcf6f7
```

`terms()` → `.../rhj` = **Robinhood Assets (Jersey) Limited**, matching the README's "debt securities issued by Robinhood Assets (Jersey) Limited".

`eip712Domain()` decodes to `fields=0x0f`, `name="NVIDIA • Robinhood Token"`, `version="1"`, `chainId=4663`, `verifyingContract=0xd0601ce1...`, `salt=0`, `extensions=[]` — so `permit()` is usable and the domain is standard.

```
############ USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
name()        -> Global Dollar
symbol()      -> USDG
decimals()    -> 6            <-- TECHSPEC claim CONFIRMED
totalSupply() -> 714451814009907     (714,451,814.009907 USDG)
paused()      -> False
owner()       -> 0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f
defaultAdmin()-> 0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f
```

---

## 3. `uiMultiplier()` semantics — NON-REBASING, proven four ways

**Selector `0xa60bf13d`, returns `uint256`, 18-decimal fixed point (1e18 = 1.0).**

### 3.1 The spec (primary source)

ERC-8056 is **"Scaled UI Amount Extension for ERC-20 Tokens"** (https://eips.ethereum.org/EIPS/eip-8056). Verbatim from the spec:

> "Multiplier is represented with 18 decimals (1e18 = 1.0)."
> "The standard ERC-20 functions (`balanceOf`, `transfer`, `transferFrom`, etc.) MUST continue to work with raw amounts."

Robinhood's own docs (https://docs.robinhood.com/chain/building-with-stock-tokens/) say:

> "Stock tokens are not rebasing tokens" … "the multiplier scales the effective amount without changing raw balances or total supply."
> `uiMultiplier()`: "Current UI multiplier, expressed with 18 decimals (1e18 = 1.0)."
> `UIMultiplierUpdated` event: "Emitted when the multiplier changes (e.g. a dividend or split)."

So the multiplier moves on **both** dividends and splits, and neither touches raw balances.

### 3.2 Arithmetic identity at a pinned block (no race)

Pinned to block **61,307,864**:

```
uiMultiplier    1000775159164630595
totalSupply     95824095534150000000000
totalSupplyUI   95898374459995734042973 | ts*m//1e18 = 95898374459995734042973 | match True

0x36f95458df353f692ded419c89fcbbcdf98c62f3 raw=4733138031771704098     ui=4736806967094493550     MATCH=True
0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3 raw=20822834527028345542590 ui=20838975538045557945663 MATCH=True
0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e raw=1297562423876421507841  ui=1298568241280969604753  MATCH=True
```

`balanceOfUI(a) == balanceOf(a) * uiMultiplier() / 1e18`, **floor** rounding, exactly. `balanceOf` is the raw ledger.

> Caution for whoever writes the UI: an unpinned two-call read races. My first attempt compared `balanceOf` and `balanceOfUI` in separate `eth_call`s at `"latest"` and one active router address mismatched purely because its balance moved between the calls. **Read both in one multicall, or pin the block.**

### 3.3 The historical step — the decisive proof

The multiplier has changed **exactly once** in the token's life. Full-history scan for topic `UIMultiplierUpdated`:

```
### UIMultiplierUpdated: 1 logs
blk 58952659 tx 0x4ac23f2e58e2c4962dcd701c2beff581e87f3995152a29d527c07a3afd67d956
data [1000000000000000000, 1000775159164630595, 1788998430]
```

i.e. `UIMultiplierUpdated(old=1e18, new=1.000775159164630595e18, effectiveAt=1788998430)` = **2026-09-10 00:00:30 UTC**, which is block **58,958,493**.

Now compare `TransferWithScaledUI` logs either side of that block:

```
============ BEFORE effectiveAt  blocks 58958093-58958492
  blk 58958126 value=2977399461855 valueUI=2977399461855 impliedMult=1000000000000000000
     paired Transfer value=2977399461855  == RAW value
============ AFTER  effectiveAt  blocks 58958494-58958893
  blk 58958500 value=78777783473277152   valueUI=78838848794105747   impliedMult=1000775159164630589
  blk 58958500 value=3860111390190580513 valueUI=3863103590911181688 impliedMult=1000775159164630594
     paired Transfer value=3860111390190580513  == RAW value
```

The multiplier stepped from 1.0 to 1.000775…, and **the standard `Transfer` event kept carrying the RAW value on both sides**. Only the extra `valueUI` field moved. Nothing rebased.

### 3.4 Storage layout

ERC-7201 namespace `0x395525728d1d6f4af44d273368682dd92b28e7464d750ef3212d3cb7f5959d00`:

```
+0  0x...0de0b6b3a7640000  = 1000000000000000000   (old multiplier — still 1e18, never rewritten)
+1  0x...0de377b4760af643  = 1000775159164630595   (newUIMultiplier)
+2  0x...6aa1f31e          = 1788998430            (effectiveAt)
```

And OZ v5 `ERC20Storage` at `0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00`:

```
+2  0x...144aa276f67e09eb3c00  = totalSupply (RAW)
+3  "NVIDIA • Robinhood Token"
+4  "NVDA"
```

**Raw supply and the multiplier are separate storage.** A multiplier update writes only `+1`/`+2` of the other namespace. That is a structural guarantee that `totalSupply()` cannot move because of a corporate action.

### 3.5 Two operational gotchas for the vault/UI

1. **`uiMultiplier()` is a time-conditional read, not a stored value.** `+0` still holds the old `1e18` while `uiMultiplier()` already returns the new value, because the getter compares `block.timestamp` to `effectiveAt`. **The multiplier therefore changes with no transaction and no event at the moment it changes.** An indexer that only watches `UIMultiplierUpdated` will show a stale multiplier between the scheduling tx and `effectiveAt`. Schedule a re-read at `effectiveAt()`.
2. `updateMultiplier(uint256,uint256)` (`0xbad60f18`) is the scheduling call. Embedded revert strings in the implementation are `"New multiplier must be greater t…"` and `"Effective time must not be in th…"` — so the multiplier is **monotonically increasing** and cannot be backdated. A reverse split would need a different path; **UNRESOLVED** whether `updateMultiplier(uint256)` (`0x5ffe6146`, never observed called) bypasses the monotonicity check.

### 3.6 ERC-165

```
supportsInterface(0xa60bf13d) IScaledUIAmount                -> True
supportsInterface(0x4bd27648) IScaledUIAmountNewUIMultiplier -> True
supportsInterface(0xd890fd71) IScaledUIAmountBalances        -> True
supportsInterface(0x57854fc3) IScaledUIAmountConversion      -> False
supportsInterface(0x01ffc9a7) ERC165                         -> True
supportsInterface(0xffffffff)                                -> False
```

`toUIAmount(uint256)` / `fromUIAmount(uint256)` **revert — they do not exist.** Do the multiply in our own code.

**Deviation from the spec worth noting:** ERC-8056 names the per-transfer event `TransferWithUIAmount`; Robinhood emits **`TransferWithScaledUI(address indexed,address indexed,uint256,uint256)`**, topic `0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802`. Index on that hash, not on the spec name. `UIMultiplierUpdateCancelled` from the spec is **absent** from the implementation.

---

## 4. `oraclePaused()` — exists, and is only a signal

```
oraclePaused()  0x7706ba52 -> False      (VERIFIED LIVE)
```

It is a real function on the deployed implementation. Related surface, all present in the dispatch table: `pauseOracle()` `0x253ea980`, `unpauseOracle()` `0x0fab6865`, events `OraclePaused()` `0xe28b7053…` and `OracleUnpaused()` `0xa274116f…`. Gated by `ORACLE_PAUSER_ROLE` (`keccak("ORACLE_PAUSER_ROLE")` = `0x155fc2c2b00b801014447f9d3a1522625740f8e592e4c0b0bb7c5867c150aa11`).

**Neither event has ever fired on NVDA** (0 occurrences in a full-history scan), so the flag has never been raised for this token.

Storage: ERC-7201 namespace `0x50204cc2d5276a366b2f6a19361d0f388c29e773a6f6aa2c92cfb0dc04a5fe00`, **slot +0, byte 0**. Forcing it true via state override:

```
[oraclePaused override] tokenPaused=00 oraclePaused=01 paused=00
[oraclePaused override] transfer -> 0x0000...0001      <-- SUCCEEDS
```

**`oraclePaused()` does not block transfers.** It is a pure read-only market-status signal. That is exactly the shape TECHSPEC line 165 assumes (`token.oraclePaused() == false` as a write-gate), so the Policy gate works as designed — but note it gates *our* discretion, it is not a safety rail the token enforces.

---

## 5. Transfer restrictions, freeze surface, and every privileged role

### 5.1 The registry is a chain-wide control plane

`0xe10b6f6b275de231345c20d14ab812db62151b00` is beacon + pause + blocklist for **all** stock tokens. Its full ABI, recovered from its 2332-byte dispatch table:

`supportsInterface(bytes4)` · `getRoleAdmin(bytes32)` · `grantRole` · `revokeRole` · `renounceRole` · `hasRole` · `DEFAULT_ADMIN_ROLE()` · `upgradeTo(address)` `0x3659cfe6` · `implementation()` `0x5c60da1b` · `pause()` `0x8456cb59` · `unpause()` `0x3f4ba83a` · `paused()` `0x5c975abb` · **`blockAccounts(address[])` `0x6abf7081`** · **`unblockAccounts(address[])` `0xfaed47fd`** · **`isBlocked(address)` `0xfbac3951`**

(The three non-obvious selectors were confirmed by exact keccak match, not guessed: `cast sig "blockAccounts(address[])"` → `0x6abf7081`, `"unblockAccounts(address[])"` → `0xfaed47fd`, `"isBlocked(address)"` → `0xfbac3951`.)

**Scope:** the StockTokenFactory `0x4783c67b63de2b358ac5951a7d41f47a38f3c046` has emitted **204** `Deployed(bytes32 indexed uid, address token, string name, string symbol)` events (topic `0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6`, confirmed by exact keccak match on `Deployed(bytes32,address,string,string)`). NVDA is one of them:

```
blk 45898  uid 0x...915f477416294f5099a5e0e09f327ce5   <-- equals NVDA.uid()
           token 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec  "NVIDIA • Robinhood Token" / "NVDA"
```

Full list saved to `ops/recon/R6-stock-tokens-list.json` (204 entries: TSLA, NVDA, WDAY, QBTS, BA, ARM, ASML, RDDT, IONQ, …). All resolve `ACCESS_CONTROLLED_REGISTRY()` to the same registry.

### 5.2 Global pause — PROVEN to halt transfers

Registry storage slot 1 packs `paused` (byte 20) with `implementation` (bytes 0–19):

```
$ eth_getStorageAt registry 0x1
0x000000000000000000000000b35490d6f9163de4f80d88dc75c3516eb64c5ae2
```

Override it to `0x...01b35490d6f9163de4f80d88dc75c3516eb64c5ae2` (paused = 1):

```
[paused override] registry.paused()   -> 0x...0001
[paused override] token.paused()      -> 0x...0001     <-- the TOKEN now reports paused
[paused override] token.tokenPaused() -> 0x...0000     <-- its own flag is still false
[paused override] transfer            -> REVERT 0x1309a563
```

`0x1309a563` = **`IsPaused()`** (confirmed both by `cast sig "IsPaused()"` and by openchain lookup).

Two conclusions:
- `token.paused()` is `registry.paused() || tokenPaused()`. Our monitoring should read `paused()`, which already covers both.
- **One `PAUSER_ROLE` call freezes NVDA and 203 other tokens simultaneously.** Deposits, `write`, Valorem `redeem`, Seaport fills and depositor withdrawals all stop. This is the "issuer freeze (existential)" risk in TECHSPEC line 451, and it is **global, not per-token**.

### 5.3 Blocklist — PROVEN, and already in active use

```
registry.isBlocked(0x722122df12d4e14e13ac3b6895a86e84145b6967) = True
registry.isBlocked(0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3) = False   (normal holder)

transfer(holder -> clean addr)   OK      return=0x...0001
transfer(holder -> BLOCKED)      REVERT  data=0x75e91ce7000000000000000000000000722122df12d4e14e13ac3b6895a86e84145b6967
transfer(BLOCKED -> holder)      REVERT  data=0x75e91ce7000000000000000000000000722122df12d4e14e13ac3b6895a86e84145b6967
```

`0x75e91ce7` = `Blocked(address)`. **Enforced on both the sender and the recipient side.**

History on the registry: **`Blocked`: 246 · `Unblocked`: 4 · `Paused()`: 1 · `Unpaused()`: 2.**

The bulk of the blocklist was seeded around block 43,543 and includes `0x722122df12d4e14e13ac3b6895a86e84145b6967`, `0xdd4c48c0b24039969fc16d1cdf626eab821d3384`, `0x8589427373d6d84e98730d7795d8f6f8731fda16` — OFAC-SDN Tornado Cash contracts. So this is a **live sanctions-screening list**, and a vault address that ever receives tainted flow is a realistic blocklist candidate, not a theoretical one.

**The registry has already been paused once** (`Paused()` ×1, `Unpaused()` ×2) — the mechanism is exercised, not dormant.

### 5.4 Every privileged role and its holder

Role names recovered by keccak pre-image search (exact matches, not guesses). Holders taken from `RoleGranted`/`RoleRevoked` logs over full history on the registry.

| Role | keccak | Holder | Holder type |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x00…00` | `0xd6f8378f8e440c65f8382f5f2728c78dfd55b66d` | **EOA** |
| `BEACON_UPGRADER_ROLE` | `0x5ab8bd28…0c39` | `0xcd8c6182e7c6ca3b5156d6a90a67719d7e2be094` | **EOA** |
| `PAUSER_ROLE` (global) | `0x65d7a28e…862a` | `0xe7bcb188254bc6ebbff63014dfed4cd4a024f22a` | **EOA** |
| `BLOCKER_ROLE` | `0x8f2e0057…9037` | `0x913ca87347391218e5de2c17c5a0aeba8b0b28fd` | **EOA** |
| `MULTIPLIER_UPDATER_ROLE` | `0x7158cf42…b615` | `0x92905e8d0e2301ba143215b8d86d63ffd4188143` | **EOA** |
| `MINTER_ROLE` | `0x9f2df0fe…56a6` | `0x2b94105fff37630f98e1f24811dad588fc5c3a87` | **EOA** |
| `BURNER_ROLE` | `0x3c11d16c…a848` | `0x6e40b50a40c1db42a85a0e8fe8ff7d9cbfc2d8c1` | **EOA** |
| `ADMIN_BURNER_ROLE` | `0x25e7ebc8…8936` | `0x957b6de6525c63349f7619743ef1e0ad93cd74d4` | **EOA** |
| `TOKEN_PAUSER_ROLE` | `0xe95e22ec…30a2` | `0xfccf56b674113d9c4eb0f9b3370930ced9e6ab23` | **EOA** |
| `ORACLE_PAUSER_ROLE` | `0x155fc2c2…aa11` | `0x7369d100c00f28e45d779ac9d4b1c7afa61e4abc` | **EOA** |
| `TOKEN_DEPLOYER_ROLE` | `0x5f077d4e…bbeb` | `0x5516b3451d4d6c9f63353fe7bc9537477ecce000` | **EOA** |
| `METADATA_UPDATER_ROLE` | `0x7f526084…a61e` | `0xcba16c2b9048af033c5b34e43dd1d47d1358524a` | **EOA** |
| **UNIDENTIFIED** `0xb4e5de73…84f8` | — | `0x697e774d60c1a3769f2ed0b919aacf17be0ae553` | **EOA** |

`0x074377a78a9710a1d47244f89797718b4f491279` was the deployer; it held `DEFAULT_ADMIN_ROLE` + `BEACON_UPGRADER_ROLE` and **renounced both at blocks 8692/8695** after handing them on. Good hygiene, but the successors are still single keys.

`eth_getCode` on every one of the 13 holders returns `0x` → **every privileged Robinhood role is a single EOA. No Gnosis Safe, no timelock, no delay anywhere.** For comparison, USDG's admin *is* a timelock (§7).

`MULTIPLIER_UPDATER_ROLE` is the key that moved the dividend:

```
tx 0x4ac23f2e58e2c4962dcd701c2beff581e87f3995152a29d527c07a3afd67d956
from: 0x92905e8d0e2301ba143215b8d86d63ffd4188143
to:   0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec
input: 0xbad60f18 | 1000775159164630595 | 1788998430
```

### 5.5 Issuer clawback on the token itself

The implementation exposes **`adminBurn(address,uint256)` `0x06dd0419`** alongside `mint(address,uint256)` and `burn(address,uint256)`. `adminBurn` takes an arbitrary holder — the issuer can destroy vault-held NVDA without the vault's consent. There is no allowlist and no transfer hook, but this is a strictly stronger power than a freeze. Disclose it.

There is **no allowlist, no per-account transfer hook, and no external callback** on transfer — the only transfer-path gates are the global pause, the per-token pause, and the two-sided blocklist.

---

## 6. ERC-20 compliance and fee-on-transfer

### 6.1 Return values and error shape

```
transfer(holder -> 0x..beef)             OK  return=0x0000…0001
approve(0x..beef, 1e15)                       0x0000…0001
transfer(holder -> beef, > balance)      REVERT 0xe450d38c | holder | 20822… | 1e30
transferFrom(holder->beef) no allowance  REVERT 0xfb8f41b2 | 0xbeef | 0 | 1e15
```

`0xe450d38c` = `ERC20InsufficientBalance(address,uint256,uint256)`; `0xfb8f41b2` = `ERC20InsufficientAllowance(address,uint256,uint256)`. Both are **OpenZeppelin Contracts v5** errors, and the OZ v5 `ERC20Storage` ERC-7201 slot is present in the bytecode. So the token is stock OZ v5 `ERC20Upgradeable` + `ERC20PermitUpgradeable` with a custom `_update` override.

**Verdict: fully ERC-20 compliant on return values. Reverts on failure, returns `true` on success.** `SafeERC20` is still the right call but a plain `transfer` would not silently no-op.

### 6.2 Fee-on-transfer — none, proven by execution

I compiled a probe contract, injected it at an address via `eth_call` `code` override, funded it by overriding the ERC20 balances slot, and measured both sides across a real `transfer`:

```solidity
function run(address t, address to, uint256 amt) external returns (uint256,uint256,uint256,uint256,bool) {
    uint256 sb = IT(t).balanceOf(address(this));
    uint256 rb = IT(t).balanceOf(to);
    bool ok = IT(t).transfer(to, amt);
    return (sb, IT(t).balanceOf(address(this)), rb, IT(t).balanceOf(to), ok);
}
```

```
======================== NVDA
   granted probe balance   : 5000000000000000000
   transfer amount         : 1000000000000000000
   sender before / after   : 5000000000000000000 / 4000000000000000000   (delta 1000000000000000000)
   recipient before / after: 0 / 1000000000000000000                     (delta 1000000000000000000)
   transfer() returned     : True
   >>> FEE ON TRANSFER     : NONE
======================== USDG
   granted probe balance   : 5000000
   transfer amount         : 1000000
   sender before / after   : 5000000 / 4000000   (delta 1000000)
   recipient before / after: 0 / 1000000         (delta 1000000)
   transfer() returned     : True
   >>> FEE ON TRANSFER     : NONE
```

**Both tokens move the exact amount. No fee, no skim, no rounding loss.** Exact-amount accounting in the vault is safe for both legs.

Corroborating evidence from real receipts: every `Transfer` is accompanied by exactly one `TransferWithScaledUI` and nothing else — no third-party fee `Transfer`, no hook event. Topic census over a 6,000-block window on NVDA: `Transfer` 3572, `TransferWithScaledUI` 3572, `Approval` 234, **and nothing else**.

---

## 7. USDG quick pass

| Item | Value |
|---|---|
| Proxy | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (ERC1967Proxy, 170 bytes) |
| Implementation | **`0x68184c449e1a8f34fa18d289737129fd27b66f8f`** (18644 bytes) |
| name / symbol / decimals | `Global Dollar` / `USDG` / **6 — TECHSPEC CONFIRMED** |
| totalSupply | `714451814009907` = 714,451,814.009907 USDG |
| paused() | `false` |
| owner() = defaultAdmin() | `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f` |
| defaultAdminDelay | `10800` (3h) |
| supplyControl() | `0xdf5fff9cb88b3cab50572fae73e2eb08599d25d4` (170-byte proxy) |

**Architecture:** UUPS proxy + a **facet router**. The implementation forwards unknown selectors via `getFacet(bytes4)`; unrouted selectors revert `FacetNotFound()` `0x800ab12c` (which is why `uiMultiplier()` etc. revert with that payload on USDG). Control test confirms the map is real — `getFacet(0xdeadbeef)`, `getFacet(0xffffffff)` all return `0x0`.

| Facet | Address | Size | Contents |
|---|---|---|---|
| Pause + Asset Protection | `0x58cab81e3d8468a0e90df8cbfacb34535e1de942` | 12266 | `freeze`, `unfreeze`, `freezeBatch`, `unfreezeBatch`, `isFrozen`, `getFrozenData`, **`wipeFrozenAddress`**, `pause`, `unpause`, `paused`, `setSupplyControl`, `reclaimToken` |
| Permit + EIP-3009 | `0x780d30b6a89bc9eef953a543aa288c3b05b01309` | 16149 | `permit` (×2), `transferWithAuthorization` (×2 + batch), `receiveWithAuthorization` (×2), `cancelAuthorization` (×2), `cancelPermits`, typehashes |

**Codebase lineage:** the implementation carries `supplyControllerDeprecated()`, `assetProtectionRoleDeprecated()`, `betaDelegateWhitelisterDeprecated()`, `proposedOwnerDeprecated()` and `increaseApproval`/`decreaseApproval` — this is the **Paxos PAX/USDP** lineage, which matches USDG being a Paxos-issued Global Dollar.

### 7.1 Freeze is real and enforced

```
isFrozen mapping slot = 6
transfer with SENDER frozen      -> REVERT 0x1fd1cc44
transfer with RECIPIENT frozen   -> REVERT 0x1fd1cc44
control (nobody frozen)          -> OK
```

`0x1fd1cc44` = **`AddressFrozen()`** (openchain). Enforced on both sides, same as the Stock Token blocklist.

**`wipeFrozenAddress(address)` `0xe2f72f03` is outright confiscation** — it destroys the balance of an already-frozen address. Between that and `decreaseSupplyFromAddress(uint256,address)`, USDG held by the vault is seizable by the issuer. Same disclosure category as the NVDA `adminBurn`.

**Reassuring:** `Freeze`, `Unfreeze`, `FrozenAddressWiped` and `Paused(address)` have **0 occurrences** on chain 4663 in full history. Nothing has ever been frozen or wiped here.

### 7.2 USDG does not rebase

Even though the implementation contains a `MultiplierGrowth` library (inherited from Paxos' yield-bearing `USDL`/Lift Dollar codebase), there is **no multiplier getter in the ABI** and balances are flat:

```
totalSupply @61319896 = 0x…0289caa6f126e9
totalSupply @61320891 = 0x…0289caa6f126e9     delta = 0
mints=0 burns=0  -> EXPLAINS DELTA: True
idle holder 0x937897fe19f675c96a71078820f21ca9bd637180:
   bal@61319896 = 67971085283 == bal@61320891 = 67971085283   -> NO REBASE
```

…across ~1000 blocks during which **3305 USDG transfers** occurred. `balanceOf` is a plain raw ledger. Safe for `usdgReservedForQueuedRedeems` arithmetic and for `accUsdgPerShare`.

### 7.3 USDG governance — materially better than the Stock Token side

`defaultAdmin` `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f` is a **6754-byte contract**. It is **not** a Gnosis Safe (`VERSION()`, `getOwners()`, `getThreshold()`, `nonce()`, `domainSeparator()` all revert). Its dispatch table identifies it unambiguously as an **OpenZeppelin `TimelockController`**:

`schedule(address,uint256,bytes,bytes32,bytes32,uint256)` · `scheduleBatch` · `execute` · `executeBatch` · `cancel(bytes32)` · `getMinDelay()` · `updateDelay(uint256)` · `isOperationReady/Pending/Done` · `getOperationState` · `hashOperation(Batch)` · `PROPOSER_ROLE()` · `EXECUTOR_ROLE()` · `CANCELLER_ROLE()`

```
getMinDelay() -> 0x…015180 = 86400  (24 hours)
```

So **USDG admin actions are behind a 24-hour timelock**; Robinhood Stock Token admin actions are behind **nothing**.

USDG role grants (all at block 57, never revoked):

| Role hash | Name | Holder | Type |
|---|---|---|---|
| `0x00…00` | `DEFAULT_ADMIN_ROLE` | `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f` | TimelockController |
| `0x139c2898…e46d` | `PAUSE_ROLE` | `0x3af3e85f4f97de7ad0f000b724fb77fe5ffc024b` | EOA |
| `0xe3e4f9d7…9796` | `ASSET_PROTECTION_ROLE` | `0x3af3e85f4f97de7ad0f000b724fb77fe5ffc024b` | EOA |
| `0xf8708381…3540` | **UNIDENTIFIED** | `0x3af3e85f4f97de7ad0f000b724fb77fe5ffc024b` | EOA |
| `0x2a0ee64a…1a9d` | **UNIDENTIFIED** | `0x3af3e85f4f97de7ad0f000b724fb77fe5ffc024b` | EOA |
| `0xb552f1be…73bd` | **UNIDENTIFIED** | `0x3af3e85f4f97de7ad0f000b724fb77fe5ffc024b` | EOA |
| `0x14682d18…06d0` | **UNIDENTIFIED** | `0x4e4336d068df68000d6d6ab326feef9ad4faeef8` | EOA |
| `0xf5c39a02…017b` | **UNIDENTIFIED** | `0x55f78e37adb9d1f6931c1da7314b374558ae9684` | EOA |
| `0x36dc7495…97f5` | **UNIDENTIFIED** | `0x5fd949b0fd3a994a6d7e364c82e43be23de22e38` | EOA |

Note `ASSET_PROTECTION_ROLE` — the freeze/wipe key — **is a bare EOA**, not the timelock.

---

## 8. What this means for Stonkhouse (concrete)

1. **Share math is safe. Ship it.** `README.md` line 143 ("Use raw `balanceOf` for ERC-20 math. Display layer multiplies by `uiMultiplier()`. Never rebase internally.") is **exactly right** and now proven on-chain. No change needed to `Vault.sol`.
2. **The multiplier is free NAV, as TECHSPEC line 16 assumes.** It has moved once, +0.0775%, on 2026-09-10, and it only goes up (monotonic per the embedded revert string).
3. **UI: read `balanceOf` and `uiMultiplier` in one multicall.** Two separate `eth_call`s at `"latest"` race. Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` is already on the address list.
4. **Indexer: watch `TransferWithScaledUI`, not `TransferWithUIAmount`.** And schedule a multiplier re-read at `effectiveAt()` — the value changes with no transaction and no event.
5. **Policy gate: `oraclePaused()` works as specced** but is advisory only. Also gate on `paused()` (which folds in the global registry pause) before `rollOpen`.
6. **Emergency detection: watch the registry, not the token.** Subscribe to registry `Paused()` `0x9e87fac8…`, `Unpaused()` `0xa45f47fd…`, `Blocked(address)` `0x75e91ce7…` — and specifically `Blocked` filtered on the vault address. TECHSPEC line 264 ("asset transfer failing (issuer freeze) — surface as emergency, do not write") should be a proactive watch, not a failed-transaction discovery.
7. **Risk disclosure needs to be stronger than the README currently is.** "Issuer can freeze transfers" undersells it. The accurate statement: *a single Robinhood-controlled EOA, with no multisig or timelock, can halt all 204 stock tokens at once; a second EOA can blocklist the vault contract unilaterally; a third can burn vault-held tokens via `adminBurn`. 246 addresses are already blocked. USDG carries an equivalent `freeze` + `wipeFrozenAddress` power, though its admin sits behind a 24h timelock.*
8. **No `SafeERC20`-breaking behaviour on either leg.** Exact amounts, `bool` returns, OZ v5 reverts.

---

## 9. UNRESOLVED

1. **No verified source for anything.** Blockscout (`robinhoodchain.blockscout.com`) returns a Cloudflare managed challenge (HTTP 403, `cf-mitigated: challenge`) on both `/api/v2/smart-contracts/...` and legacy `/api?module=contract&action=getsourcecode|getabi`. I did **not** try `robinscan.io`, `hoodscan.co` or `stonkscan.io` — **someone should**, ideally through the firecrawl skill which can pass a browser challenge. Everything in this file is bytecode + live-call derived. Source would let us confirm the inferred pieces below.
2. **`tokenPaused()` storage slot not located.** I scanned the three known ERC-7201 namespaces (`0x50204cc2…fe00`, `0x52c63247…ce00`, `0x395525728d…d00`) at offsets 0–13, bytes 0–1, and could not make `tokenPaused()` return true via override. So **I did not directly prove that the per-token pause blocks transfers** — I only proved it for the global registry pause. Given `token.paused()` ORs the two and the revert is a single `IsPaused()`, it almost certainly does, but it is not proven.
3. **USDG `paused()` storage slot not located** (scanned slots 0–39, bytes 0–1). **USDG pause enforcement on transfer is therefore inferred, not proven.** USDG *freeze* enforcement IS proven.
4. **`updateMultiplier(uint256)` `0x5ffe6146`** — present in the dispatch table, never called on-chain. Unknown whether it applies immediately and whether it enforces the same monotonic-increase check. Matters only if a reverse split ever happens.
5. **Unidentified role hashes.** Registry: `0xb4e5de7340a2fee2ff9be79f5ec0e8feae4b633bc8cc663711520e08f24984f8` (held by EOA `0x697e774d60c1a3769f2ed0b919aacf17be0ae553`), after ~1700 candidate pre-images. USDG: six role hashes (`0xf8708381…`, `0x2a0ee64a…`, `0xb552f1be…`, `0x14682d18…`, `0xf5c39a02…`, `0x36dc7495…`) after ~1300 candidates. **Someone holds powers I could not name.**
6. **`globalTransferSettings()` `0x5b9d419e` return shape not decoded.** Raw value is `0x…699cea00 | 0x…015180 | 0 × N` — plausibly a window start plus an 86400s period, but the struct field names/types are unknown. If USDG ever enforces a transfer window, this is where it lives. **Worth resolving before the keeper depends on USDG moving at an arbitrary hour.**
7. **`getFrozenData(address)` `0xd7d4db3d` return shape not decoded.**
8. **`uid()` return type ambiguous.** Value `0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5` is right-aligned, so it could be `bytes32` or `uint128`. I recorded `bytes32` because `initialize(bytes32,string,string)` takes the uid as `bytes32` and the factory's `Deployed` event indexes it as `bytes32`. Cosmetic.
9. **`0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6`** appears as a PUSH32 constant in the Stock Token implementation and I could not identify it. The two neighbouring constants resolved cleanly to the ERC-2612 `PERMIT_TYPEHASH` (`0x6e71edae…`) and the EIP-712 domain typehash (`0x8b73c3c6…`), so this is probably a third typehash, not a role.
10. **Non-view return types in both ABI files are inferred as void.** I could not safely execute state-changing calls. Anything marked `_verified` was actually called.
11. **Testnet 46630 not checked** for any of the above (that is R7's scope).

---

## 10. Artifacts produced

| Path | Contents |
|---|---|
| `/Users/omaidfaizyar/Desktop/robinhood-dev/callhouse/ops/abis/StockToken.json` | 56 entries — full recovered ABI of impl `0xb354…5ae2`, with per-entry `_selector`, `_topic0` and `_verified` provenance |
| `/Users/omaidfaizyar/Desktop/robinhood-dev/callhouse/ops/abis/USDG.json` | 94 entries — implementation + both facets, with facet attribution per function |
| `/Users/omaidfaizyar/Desktop/robinhood-dev/callhouse/ops/recon/R6-stock-tokens-list.json` | All 204 Robinhood Stock Tokens (uid, address, name, symbol, deploy block) |
| `/Users/omaidfaizyar/Desktop/robinhood-dev/callhouse/ops/recon/R6-stock-token.md` | this file |

## 11. Address appendix (every one confirmed by an `eth_getCode` or log I actually ran)

| Name | Address | Bytes |
|---|---|---|
| NVDA Stock Token (beacon proxy) | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 283 |
| Stock Token implementation | `0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2` | 11614 |
| AccessControlledRegistry + beacon | `0xe10b6f6b275de231345c20d14ab812db62151b00` | 2332 |
| StockTokenFactory | `0x4783c67b63de2b358ac5951a7d41f47a38f3c046` | — |
| USDG (ERC1967 proxy) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 170 |
| USDG implementation | `0x68184c449e1a8f34fa18d289737129fd27b66f8f` | 18644 |
| USDG pause/asset-protection facet | `0x58cab81e3d8468a0e90df8cbfacb34535e1de942` | 12266 |
| USDG permit/EIP-3009 facet | `0x780d30b6a89bc9eef953a543aa288c3b05b01309` | 16149 |
| USDG supplyControl | `0xdf5fff9cb88b3cab50572fae73e2eb08599d25d4` | 170 |
| USDG admin (OZ TimelockController, 24h) | `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f` | 6754 |

---

# Verification pass — adversarial re-check (independent agent)

**Date:** 2026-09-12, head block **61,337,108 → 61,338,251**, chainId `0x1237` (4663).
**Method:** every address re-`eth_getCode`d, every selector recomputed with `cast sig` / `cast keccak`, every
claimed function re-`eth_call`ed, every state-override proof re-run from scratch with negative controls, every
event count re-derived from `eth_getLogs` over the full `0x0 → head` range. Primary sources (EIP text,
Robinhood docs) fetched and grepped for the quoted strings.

**VERDICT: CONFIRMED.** No fabricated address, no fabricated selector, no fabricated endpoint. Every load-bearing
claim reproduced. Corrections below are **one material omission** (the USDG facet map) plus refinements; three
items they filed as UNRESOLVED are now RESOLVED.

## V0. Environment note that matters for reproduction

`https://rpc.mainnet.chain.robinhood.com` **rejects requests without a `User-Agent` header (HTTP 403)** and
**is not an archive node** — historical `eth_call` fails with `{"code":-32000,"message":"metadata is not found, <blk>"}`
for any block more than a few thousand behind head:

```
eth_call NVDA uiMultiplier() @ 58958400 -> {'code': -32000, 'message': 'metadata is not found, 58958403'}
```

So §3(b)'s historical evidence **cannot** have come from historical `eth_call` — and it didn't; it came from
`eth_getLogs`, which this node does serve over the full range. Their method holds. `debug_traceCall` and
`trace_call` are both absent (`-32601`).

## V1. Every claimed address re-verified — all 25 correct

```
NVDA proxy               0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC bytes=283
StockToken impl          0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2 bytes=11614
Registry/Beacon          0xe10b6f6b275de231345c20d14ab812db62151b00 bytes=2332
StockTokenFactory        0x4783c67b63de2b358ac5951a7d41f47a38f3c046 bytes=163
USDG proxy               0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 bytes=170
USDG impl                0x68184c449e1a8f34fa18d289737129fd27b66f8f bytes=18644
USDG assetprot facet     0x58cab81e3d8468a0e90df8cbfacb34535e1de942 bytes=12266
USDG permit facet        0x780d30b6a89bc9eef953a543aa288c3b05b01309 bytes=16149
USDG timelock admin      0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f bytes=6754
USDG supplyControl       0xdf5fff9cb88b3cab50572fae73e2eb08599d25d4 bytes=170
...all 13 stock-token role holders + USDG role holder + Tornado router  bytes=0  (EOAs, as claimed)
```

Only nit: `StockTokenFactory` is **163 bytes** (it is itself a proxy), which their table left blank as
"(upgradeable, 2 Upgraded events)". Consistent, just now measured.

**All 13 role holders re-verified with `hasRole()` live, not from logs, each with a negative control:**

```
DEFAULT_ADMIN_ROLE       hasRole(0xd6f8378f...) = True    control(bogus)=False
BEACON_UPGRADER_ROLE     hasRole(0xcd8c6182...) = True    control(bogus)=False
PAUSER_ROLE              hasRole(0xe7bcb188...) = True    control(bogus)=False
BLOCKER_ROLE             hasRole(0x913ca873...) = True    control(bogus)=False
MULTIPLIER_UPDATER_ROLE  hasRole(0x92905e8d...) = True    control(bogus)=False
MINTER_ROLE              hasRole(0x2b94105f...) = True    control(bogus)=False
BURNER_ROLE              hasRole(0x6e40b50a...) = True    control(bogus)=False
ADMIN_BURNER_ROLE        hasRole(0x957b6de6...) = True    control(bogus)=False
TOKEN_PAUSER_ROLE        hasRole(0xfccf56b6...) = True    control(bogus)=False
ORACLE_PAUSER_ROLE       hasRole(0x7369d100...) = True    control(bogus)=False
TOKEN_DEPLOYER_ROLE      hasRole(0x5516b345...) = True    control(bogus)=False
METADATA_UPDATER_ROLE    hasRole(0xcba16c2b...) = True    control(bogus)=False
UNIDENTIFIED_b4e5de73    hasRole(0x697e774d...) = True    control(bogus)=False
```

This is **stronger** evidence than their `RoleGranted`-log derivation (logs cannot show a later revoke). Every
role hash recomputed with `cast keccak` matches their table byte-for-byte.

## V2. Every selector recomputed — zero discrepancies

`cast sig` reproduces all of: `uiMultiplier() 0xa60bf13d`, `newUIMultiplier() 0xdc767007`, `effectiveAt() 0x97a4064f`,
`balanceOfUI(address) 0x437a9958`, `totalSupplyUI() 0x9bea6429`, `oraclePaused() 0x7706ba52`, `pauseOracle() 0x253ea980`,
`unpauseOracle() 0x0fab6865`, `tokenPaused() 0x86c75e74`, `adminBurn(address,uint256) 0x06dd0419`,
`ACCESS_CONTROLLED_REGISTRY() 0x50c09be3`, `isBlocked(address) 0xfbac3951`, `blockAccounts(address[]) 0x6abf7081`,
`unblockAccounts(address[]) 0xfaed47fd`, `updateMultiplier(uint256,uint256) 0xbad60f18`, `updateMultiplier(uint256) 0x5ffe6146`,
`uid() 0xf514ce36`, `terms() 0xd5025625`, `getFacet(bytes4) 0x112b6a67`, `isFrozen 0xe5839836`, `freeze 0x8d1fdf2f`,
`wipeFrozenAddress 0xe2f72f03`, `supplyControl() 0x4a254dfe`, `globalTransferSettings() 0x5b9d419e`,
`getFrozenData 0xd7d4db3d`, `getMinDelay() 0xf27a0c92`. Errors/topics likewise: `IsPaused() 0x1309a563`,
`Blocked(address) 0x75e91ce7`, `AddressFrozen() 0x1fd1cc44`, `FacetNotFound() 0x800ab12c`,
`ERC20InsufficientBalance 0xe450d38c`, `ERC20InsufficientAllowance 0xfb8f41b2`,
`TransferWithScaledUI 0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802`,
`UIMultiplierUpdated 0x2205df45…b055`, `Deployed(bytes32,address,string,string) 0xd9b0c6a1…76d6`, and all role hashes.

**Independent corroboration of `adminBurn`:** calling `0x06dd0419` from an unprivileged address reverts
`AccessControlUnauthorizedAccount` naming `keccak("ADMIN_BURNER_ROLE")` — proving both that the function
exists in the deployed bytecode and which role gates it, without trusting their dispatch-table read:

```
eth_call NVDA 0x06dd0419… ->
  0xe2517d3f 0000…0000  25e7ebc863fa4efd16243c82323b71f247c0cf439aca64c51b84a74afb738936
                        ^ = cast keccak "ADMIN_BURNER_ROLE"
```

Same technique confirms the rest of the privileged surface and its gating role, live:

```
0x51335b50 setMetadata(string,string)   -> AccessControlUnauthorized role=METADATA_UPDATER_ROLE
0x8456cb59 pause()                      -> AccessControlUnauthorized role=TOKEN_PAUSER_ROLE
0x40c10f19 mint(address,uint256)        -> AccessControlUnauthorized role=MINTER_ROLE
0x9dc29fac burn(address,uint256)        -> AccessControlUnauthorized role=BURNER_ROLE
0x5ffe6146 updateMultiplier(uint256)    -> AccessControlUnauthorized role=MULTIPLIER_UPDATER_ROLE
registry 0x3659cfe6 upgradeTo(address)  -> AccessControlUnauthorized role=BEACON_UPGRADER_ROLE
registry 0x8456cb59 pause()             -> AccessControlUnauthorized role=PAUSER_ROLE
registry 0x3f4ba83a unpause()           -> AccessControlUnauthorized role=PAUSER_ROLE
registry 0x6abf7081 blockAccounts()     -> AccessControlUnauthorized role=BLOCKER_ROLE
registry 0xfaed47fd unblockAccounts()   -> AccessControlUnauthorized role=BLOCKER_ROLE
```

`51335b50 = setMetadata(string,string)` and `812eb8b2 = initialize(bytes32,string,string)` also confirmed
against the openchain signature DB, so their ABI entries for both are real, not inferred.

## V3. NON-REBASING — independently re-proven. Their headline answer is correct.

**Pinned-block identity, 8 fresh holders at block 61,338,251** (`m = 1000775159164630595`):

```
totalSupply 95824095534150000000000  totalSupplyUI 95898374459995734042973  identity: True
0xd4eb2120… raw=21027211363072764968351 ui=21043510798667475407664  MATCH
0x8366a39c… raw=33642120129539116507474 ui=33668198127275132173474  MATCH
0xe5e70264… raw=198717631549045905371   ui=198871669342314834164    MATCH
0xf2852136… raw=34340697236299905582    ui=34367316742482427999     MATCH
0xff737c78… raw=6920723702916206        ui=6926088365320397         MATCH   (+ 4 more, all MATCH)
```

**ERC-165** reproduced exactly, including their negative results, plus two controls of my own:

```
IScaledUIAmount               0xa60bf13d -> True
IScaledUIAmountNewUIMultiplier 0x4bd27648 -> True
IScaledUIAmountBalances       0xd890fd71 -> True
IScaledUIAmountConversion     0x57854fc3 -> False
IERC20 (control)              0x36372b07 -> False
0xffffffff (control)          0xffffffff -> False
```

**The single historical step, re-derived from logs myself:**

```
UIMultiplierUpdated @ blk 0x3838bd3 = 58,952,659   tx 0x4ac23f2e…d956
  data = 0x0de0b6b3a7640000 | 0x0de377b4760af643 | 0x6aa1f31e
       = 1e18 | 1000775159164630595 | 1788998430
eth_getBlockByNumber(58958493).timestamp = 1788998430   <-- effectiveAt lands exactly on this block
```

**Transfer-vs-TransferWithScaledUI either side of that block — the decisive test, re-run:**

```
BEFORE (blk 58958126/27/42)
  Transfer.value=2977399461855          SUI.value=2977399461855          SUI.valueUI=2977399461855          impliedMult=1.000000000000000000e18
  Transfer.value=22613763131469192      SUI.value=22613763131469192      SUI.valueUI=22613763131469192      impliedMult=1.000000000000000000e18
AFTER  (blk 58958500/01/12)
  Transfer.value=78777783473277152      SUI.value=78777783473277152      SUI.valueUI=78838848794105747      impliedMult=1.000775159164630589e18
  Transfer.value=227598982283641859     SUI.value=227598982283641859     SUI.valueUI=227775407720619620     impliedMult=1.000775159164630593e18
```

`Transfer.value == TransferWithScaledUI.value` (raw) on **both** sides; only `valueUI` moves. **Nothing rebased.**

**Storage separation re-read directly, confirming their §3(c) digit-for-digit:**

```
0x395525728d1d…5959d00 +0  0x…0de0b6b3a7640000   = 1e18            (old multiplier, never rewritten)
0x395525728d1d…5959d00 +1  0x…0de377b4760af643   = 1000775159164630595
0x395525728d1d…5959d00 +2  0x…6aa1f31e           = 1788998430
0x52c63247…bace00      +2  0x…144aa276f67e09eb3c00 = 95824095534150000000000 = totalSupply (raw)
```

Slot `+0` still holds `1e18` while `uiMultiplier()` already returns the new value → **their "time-conditional
read" gotcha is confirmed at the storage level.** The multiplier does change with no tx and no event.

**Namespace identification (they left these unnamed).** The convention is `robinhood.storage.<Name>` /
`openzeppelin.storage.<Name>` under ERC-7201. Recomputed and matched exactly:

```
robinhood.storage.OraclePausable    -> 0x50204cc2d5276a366b2f6a19361d0f388c29e773a6f6aa2c92cfb0dc04a5fe00  ✓ exact
openzeppelin.storage.ERC20          -> 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00  ✓ exact
openzeppelin.storage.Nonces         -> 0x5ab42ced628888259c08ac98db1eb0cf702fc1501344311d8b100cd1bfe4bb00  ✓ exact
openzeppelin.storage.EIP712         -> 0xa16a46d94261c7517cc8ff89f61c0ce93598e3c849801011dee649a6a557d100  ✓ exact
openzeppelin.storage.Initializable  -> 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00  ✓ exact
```

## V4. Primary sources — their quotes are verbatim, not paraphrased

`https://eips.ethereum.org/EIPS/eip-8056` (HTTP 200) is titled **"Scaled UI Amount Extension for ERC-20 Tokens"**
and contains, word for word:

> "Multiplier is represented with 18 decimals (1e18 = 1.0)."
> "Backwards Compatibility: The standard ERC-20 functions (balanceOf, transfer, transferFrom, etc.) MUST continue to work with raw amounts."
> "Raw Amount Preservation: All actual token operations continue to use raw amounts, ensuring that the multiplier is purely a display feature and doesn't affect the underlying token economics."
> "DeFi Protocol Integration. DeFi protocols should: Continue using raw amounts for all protocol operations"

The spec also hard-codes `const ISCALED_UI_AMOUNT_ID = "0xa60bf13d"` — an **independent primary-source
confirmation of the interface ID** I measured on-chain. And the spec's event is indeed named
`TransferWithUIAmount(address,address,uint256,uint256)`, so their gotcha #2 (deployment renamed it to
`TransferWithScaledUI`) is confirmed against the spec text.

`https://docs.robinhood.com/chain/building-with-stock-tokens/` (HTTP 200) contains verbatim:

> "The multiplier scales the effective amount without changing raw balances or total supply — balanceOf() and totalSupply() stay fixed. **Stock tokens are not rebasing tokens.**"

**NEW — a line from that same page they did not report, and it bears on Policy/NAV:**

> "The Chainlink price already includes the corporate-action multiplier (dividends, splits), so the value you read is the token's full price — **don't apply the multiplier yourself.**"

→ NAV / strike / premium math that reads the Chainlink feed must **not** additionally multiply by `uiMultiplier()`.
Doing both double-counts every dividend and split. Cross-check this against R5 before the Policy gate is written.

## V5. `oraclePaused()` — re-proven signal-only

```
override 0x50204cc2…fe00 +0 = 1
  oraclePaused() -> 0x…01
  tokenPaused()  -> 0x…00
  paused()       -> 0x…00        <-- NOT folded into paused()
  transfer()     -> 0x…01        <-- SUCCEEDS
```

Confirmed: advisory only, and note it is **not** visible through `paused()`, so the Policy gate must read
`oraclePaused()` separately — their recommendation #4 is right for the right reason.

## V6. Freeze surface — G1 and G2 re-proven, and one path they under-weighted

**G2 blocklist needs no override at all** (the list is live), re-run against a real holder:

```
transfer(holder -> clean)   -> 0x…0001                                   OK
transfer(holder -> BLOCKED) -> REVERT 0x75e91ce7 000…722122df12d4e14e13ac3b6895a86e84145b6967
transfer(BLOCKED -> holder) -> REVERT 0x75e91ce7 000…722122df12d4e14e13ac3b6895a86e84145b6967
```

All three OFAC-SDN addresses they named re-checked, with a control:

```
isBlocked(0x722122dF…6967) [Tornado router]   = True
isBlocked(0xdd4c48c0…3384) [Tornado 0.1 ETH]  = True
isBlocked(0x85894273…DA16) [Tornado donation] = True
isBlocked(0x1111…1111)     [control]          = False
```

**G1 global pause re-proven** by overriding registry slot 1 (`paused` packed at byte 20 above `implementation`):

```
slot1 override = 0x000000000000000000000001b35490d6f9163de4f80d88dc75c3516eb64c5ae2
  registry.paused()       -> 0x…0001
  registry.implementation() -> 0x…b35490d6…5ae2   (control: impl still intact, override is well-formed)
  token.paused()          -> 0x…0001
  token.tokenPaused()     -> 0x…0000
  token.transfer()        -> REVERT 0x1309a563 = IsPaused()
```

**Blast radius re-counted from scratch over the full range — every count matches exactly:**

```
Factory Deployed(bytes32,address,string,string)  count=204   first_blocks=[19698, 34767, 45898]
Registry Blocked(address)                        count=246   first_blocks=[43543, 43546, 43550]
Registry Unblocked(address)                      count=4     first_blocks=[53336, 80752, 495553]
Registry Paused()                                count=1     blocks=[611101]
Registry Unpaused()                              count=2     blocks=[610644, 611243]
Registry Upgraded(address)                       count=2     blocks=[7796, 657134]
```

Six tokens sampled at random from the 204 `Deployed` events, each re-checked:

```
PLTR 0x894e1ec2… code=283 registry_match=True uiMultiplier=1000000000000000000
RGTI 0x284358ab… code=283 registry_match=True uiMultiplier=1000000000000000000
SKHY 0x84cab63b… code=283 registry_match=True uiMultiplier=1000000000000000000
AUR  0x373c06c4… code=283 registry_match=True uiMultiplier=1000000000000000000
PENG 0x9b23573b… code=283 registry_match=True uiMultiplier=1000000000000000000
IONQ 0x558378e0… code=283 registry_match=True uiMultiplier=1000000000000000000
```

NVDA is present in the factory event set as `('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', 'NVIDIA • Robinhood Token', 'NVDA')`.
**"One EOA halts 204 tokens" is confirmed.** (Sampled tokens all still sit at `1e18` — NVDA is unusual in having
already taken a corporate action.)

### NEW — the upgrade path is a bigger key than `adminBurn`, and the 1967 beacon slot is a decoy

Full NVDA runtime, disassembled:

```
0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00
6001600160a01b0316635c60da1b…afa…365f5f375f5f365f845af43d5f5f3e80801560b6573d5ff35b3d5ffd…
```

```
EIP1967 impl slot   -> 0x0   (empty)
EIP1967 beacon slot -> 0x…e10b6f6b275de231345c20d14ab812db62151b00
EIP1967 admin slot  -> 0x0
```

Their §1 is right that the beacon is a **hard-coded immutable**, and right that the 1967 beacon slot also holds
it — but the summary sentence blurs the consequence. Stated cleanly: **the EIP-1967 beacon slot is dead storage
on these proxies.** The delegatecall target comes only from the immutable `0xe10b6f6b…1b00` → `implementation()`.
Writing the 1967 slot would change nothing; the only lever is `registry.upgradeTo(address)`, which I proved above
is gated by `BEACON_UPGRADER_ROLE` — a **bare EOA** (`0xcd8c6182…`, `eth_getCode` = `0x`) that can **replace the
logic of all 204 tokens in one transaction, with no timelock and no delay.** That strictly dominates `adminBurn`
in their risk write-up and should lead the disclosure.

### Registry `Paused`/`Unpaused` asymmetry — RESOLVED (their open item #12)

Block ordering explains it: `Unpaused@610644` fires **before** `Paused@611101`, then `Unpaused@611243`. The first
is a no-op unpause on an already-unpaused registry. The real global-pause window was **blocks 611101 → 611243
(142 blocks)**. Not an accounting error — and confirmation the mechanism has been exercised in production.

## V7. ERC-20 compliance + fee-on-transfer — re-proven by executing a probe

Their `0x391434e3`-vs-`0xe450d38c` question does not arise: I tested live rather than reading the dispatch table,
and the deployed contract emits the OZ v5 selectors exactly as they reported.

```
transfer(over-balance) -> 0xe450d38c 000…bee2 | 0 | 0c9f2c9cd04674edea40000000   = ERC20InsufficientBalance
transferFrom(no allow) -> 0xfb8f41b2 000…beef1 | 0 | 038d7ea4c68000              = ERC20InsufficientAllowance
transfer(to address(0))-> 0xec442f05 000…0000                                    = ERC20InvalidReceiver
transfer(normal)       -> 0x…0001   approve -> 0x…0001                           (both return true)
```

**Fee-on-transfer probe, independently compiled (solc 0.8.36) and executed via `eth_call` `code` override,
funded by overriding the balances slot:**

```
NVDA: senderBefore=5000000000000000000 senderAfter=4000000000000000000 (delta -1000000000000000000)
      recipBefore=0 recipAfter=1000000000000000000 (delta +1000000000000000000) returned=True  FEE=NONE
USDG: senderBefore=5000000 senderAfter=4000000 (delta -1000000)
      recipBefore=0 recipAfter=1000000 (delta +1000000) returned=True               FEE=NONE
```

(NVDA balances live in `openzeppelin.storage.ERC20 +0`; USDG balances in plain **slot 1** — the latter not
recorded in their report.) **Exact-amount accounting is safe on both legs. Confirmed.**

## V8. RESOLVED: their open item #2 — `tokenPaused()` storage slot, and per-token pause enforcement

Their PUSH32 scan could not find it because this contract is compiled **via-IR**: the storage slot is not pushed,
it is `CODECOPY`'d out of the code tail. Disassembling the `0x86c75e74` handler at `0x03ed`:

```
1005 JUMPDEST
1006 PUSH0 / MLOAD
1008 PUSH1 0x20
1010 PUSH2 0x2d09      <-- code offset of the slot constant
1014 CODECOPY
1016 MLOAD / MSTORE
1020 SLOAD
1021 PUSH1 0xff / AND
```

`code[0x2d09:0x2d29]` gives the answer, and the tail shows the namespace base and the `+1` member together:

```
code[0x2ce9:0x2d49] = 8d25ea8ee309999a79f0af498fbab0e424669497170669bd9e93b81a62babc00
                      8d25ea8ee309999a79f0af498fbab0e424669497170669bd9e93b81a62babc01 a2646970…
```

**Per-token pause namespace base `0x8d25ea8e…babc00`; `tokenPaused` is member `+1` = `0x8d25ea8ee309999a79f0af498fbab0e424669497170669bd9e93b81a62babc01`.**
Overriding it proves what they could only infer:

```
tokenPaused slot current value: 0x0
override -> 0x…01
  tokenPaused() -> 0x…0001
  paused()      -> 0x…0001
  transfer()    -> REVERT 0x1309a563 = IsPaused()
```

**The per-token pause DOES block transfers.** Combined with V6, `paused() == registry.paused() || tokenPaused()`
is now proven in both directions, not inferred. Their recommendation #4 ("gate on `paused()`, it folds in both")
stands on proof.

## V9. RESOLVED: their open item #3 — USDG `paused()` slot, and USDG pause enforcement

Same technique on the asset-protection facet. Their scan looked at bytes 0–1 of slots 0–39; the flag is at
**byte 20**, packed above two uint32s. Disassembly of the `0x5c975abb` handler at `0x04a1`:

```
1186 PUSH1 0x04
1188 SLOAD
1189 PUSH1 0x01 / PUSH1 0xa0 / SHL      <-- 1 << 160
1195 DIV
1196 PUSH1 0xff / AND
```

→ `paused = byte 20 of plain slot 4`.

```
USDG slot4 current: 0x00000000000000000000000000000000000000000000000001518000699cea00
override slot4    : 0x00000000000000000000000100000000000000000000000001518000699cea00
  paused()              -> 0x…0001
  transfer()            -> REVERT 0xab35696f
  transfer() (control)  -> 0x…0001
```

`0xab35696f` = `cast keccak "ContractPaused()"` — **exact match**, and independently confirmed by openchain.
**USDG pause enforcement on transfer is now PROVEN, not inferred**, and the error is named. Note it is
`ContractPaused()`, **not** OZ's `EnforcedPause()` (`0xd93c0665`).

USDG freeze re-proven from scratch, including locating the mapping myself:

```
isFrozen mapping base slot = 6   (found by scanning keccak(addr‖slot) for slot 0..11)
control (nobody frozen)  -> 0x…0001                OK
SENDER frozen            -> REVERT 0x1fd1cc44      = AddressFrozen()
RECIPIENT frozen         -> REVERT 0x1fd1cc44
```

## V10. CORRECTION (material): the USDG facet map has **three** facets, not two

This is the one real omission. Enumerating `getFacet(bytes4)` across the union of 169 selectors found in the
implementation and all facet bytecodes returns a **third facet they never mention**, and it is the largest one:

| Facet | Address | Code | Routed selectors |
|---|---|---|---|
| **Settings / metadata / access control (UNREPORTED)** | **`0xdc3ef8ab3eb30d62e04dbe8a804d232573aa1fe5`** | **19444** | **62** |
| Permit + EIP-3009 | `0x780d30b6a89bc9eef953a543aa288c3b05b01309` | 16149 | 18 |
| Pause + asset protection | `0x58cab81e3d8468a0e90df8cbfacb34535e1de942` | 12266 | 12 |

```
getFacet(0x5b9d419e globalTransferSettings) -> 0xdc3ef8ab3eb30d62e04dbe8a804d232573aa1fe5
eth_getCode(0xdc3ef8ab…) -> 19444 bytes
```

It routes `name/symbol/decimals` (`06fdde03`,`95d89b41`,`313ce567`), `DOMAIN_SEPARATOR` (`3644e515`),
`supplyControl()` (`4a254dfe`), `owner()` (`8da5cb5b`), `defaultAdmin()` (`84ef8ffc`), ERC-1271 `isValidSignature`
(`1626ba7e`), `globalTransferSettings()` (`5b9d419e`), the whole `AccessControl` + `AccessControlDefaultAdminRules`
surface (`91d14854`,`2f2ff15d`,`d547741f`,`248a9ca3`,`a217fddf`,`cc8463c8`,`cefc1429`,`634e93da`,`022d63fb`,`a1eda53c`),
plus ~30 selectors that resolve to nothing in any public DB. **Their §7 facet table is incomplete and should not be
treated as the full USDG surface.** Note also `getFacet(0x4a254dfe supplyControl)` points here, **not** to
`0x58cab81e` where their table implies the supply-control surface lives (only the *setter* `setSupplyControl`
`0x52e5a050` is on `0x58cab81e`).

Their control test does hold — `getFacet(0xdeadbeef) -> 0x0`, and unrouted selectors revert `FacetNotFound()`
`0x800ab12c` (re-confirmed live on `eip712Domain()` and `wipeFrozenAddresses(address[])`).

**In their favour:** the 12 selectors routed to `0x58cab81e` resolve *exactly* to the contents they listed —
`3f4ba83a unpause`, `45c8b1a6 unfreeze`, `4cfd7a57 freezeBatch`, `52e5a050 setSupplyControl`, `5c975abb paused`,
`8456cb59 pause`, `8d1fdf2f freeze`, `d7d4db3d getFrozenData`, `e2f72f03 wipeFrozenAddress`, `e5839836 isFrozen`,
`fd89d324 unfreezeBatch`, `fff28137 reclaimToken()`. Every one an exact `cast sig` match. Nothing invented.

## V11. Other USDG claims re-tested live

```
b921e163 increaseSupply(uint256)                 REVERT 0xdcae1750 = AccountMissingSupplyControllerRole(address)  -> EXISTS
98e52f9a decreaseSupply(uint256)                 REVERT 0xdcae1750                                               -> EXISTS
076bdc36 increaseSupplyToAddress(uint256,address)REVERT 0xdcae1750                                               -> EXISTS
1f17c083 decreaseSupplyFromAddress(uint256,addr) REVERT 0xdcae1750                                               -> EXISTS (clawback path confirmed)
d73dd623 increaseApproval(address,uint256)       REVERT 0x7c946ed7 = ZeroValue()                                 -> EXISTS
66188463 decreaseApproval(address,uint256)       REVERT 0x7c946ed7                                               -> EXISTS
7ecebe00 nonces(address)                         OK
e94a0102 authorizationState(address,bytes32)     OK
3644e515 DOMAIN_SEPARATOR()  -> 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036
84b0196e eip712Domain()                          REVERT 0x800ab12c = FacetNotFound  -> NOT on USDG
17ffc320 reclaimToken(address)                   REVERT 0x800ab12c                  -> NOT present (only no-arg)
```

**Minor ABI-hygiene correction:** `ops/abis/USDG.json` / the combined signature list mixes the two tokens'
surfaces. `eip712Domain()` is real on **NVDA** but reverts `FacetNotFound` on **USDG** — a caller who trusts the
merged list will build a call that cannot succeed. Worth splitting before anything consumes those files.

**Timelock re-verified, and the identification is now airtight** — the three role getters return values that are
exact keccak preimage matches, with `TIMELOCK_ADMIN_ROLE` absent (which is correct for OZ v5 TimelockController):

```
PROPOSER_ROLE()  0x8f61f4f5 -> 0xb09aa5ae…9cc1  == cast keccak "PROPOSER_ROLE"   MATCH
EXECUTOR_ROLE()  0x07bd0265 -> 0xd8aa0f31…9e63  == cast keccak "EXECUTOR_ROLE"   MATCH
CANCELLER_ROLE() 0xb08e51c0 -> 0xfd643c72…f783  == cast keccak "CANCELLER_ROLE"  MATCH
TIMELOCK_ADMIN_ROLE() 0x0d3cf6fc -> REVERT   (absent in OZ v5 — consistent)
getMinDelay() -> 86400   (24h)
Gnosis Safe probes VERSION()/getOwners()/getThreshold() -> all REVERT
```

**And the caveat they flagged is confirmed with negative controls — the freeze key is NOT behind the timelock:**

```
USDG hasRole(PAUSE_ROLE,            0x3af3e85f…024b bare EOA) = True
USDG hasRole(PAUSE_ROLE,            0xcfa0388f…4c6f timelock) = False
USDG hasRole(ASSET_PROTECTION_ROLE, 0x3af3e85f…024b bare EOA) = True
USDG hasRole(ASSET_PROTECTION_ROLE, 0xcfa0388f…4c6f timelock) = False
USDG hasRole(…,                     0x…dEaD       control)   = False
```

The 24h timelock guards *upgrades and admin transfer*, **not** freeze/wipe/pause. Their §7 says this; it deserves
more weight than the "governance is better than Robinhood's" framing gives it.

USDG history counts re-derived over the full range — all zero, as claimed:

```
Freeze(address) 0   Unfreeze(address) 0   FrozenAddressWiped(address) 0
Paused(address) 0   Unpaused(address) 0   Upgraded(address) 1 (blk 57)   RoleGranted 9 (blk 57)
```

## V12. PARTIALLY RESOLVED: their open items #4 and #7

**#4 `updateMultiplier(uint256)` `0x5ffe6146`** — now proven to **exist in the deployed implementation and to be
gated by `MULTIPLIER_UPDATER_ROLE`** (revert `0xe2517d3f…7158cf42e4a4f01c5456c8d75cdbd375748d45e9db7e812f5bcd18844122b615`).
Still unknown: whether it applies immediately and whether it enforces the same monotonic check. Only a signed
call could settle that, so it stays partly open.

**#7 `globalTransferSettings()` `0x5b9d419e`** — return decoded as **5 words**:

```
w0 = 1771891200   (0x699cea00 = 2026-02-24 00:00:00 UTC)
w1 = 86400        (0x015180 = 24h)
w2 = w3 = w4 = 0
```

and — the part that pins it down — `w0` and `w1` are **packed into plain slot 4**, the same slot that carries the
`paused` flag at byte 20: `0x…01518000699cea00` = `uint32 w1 << 32 | uint32 w0`. So the "window start + 86400s
period" reading is structurally supported, not just plausible. The exact struct field names remain unknown.

## V13. Their open item #1 — I tried the three explorers they didn't. **Still unresolved.**

```
https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xb354…  -> Cloudflare "Just a moment..." challenge
https://robinscan.io/api/v2/smart-contracts/0xb354…                   -> {"error":"not found"}
https://robinscan.io/api?module=contract&action=getsourcecode&…       -> {"error":"not found"}
https://robinscan.io/api/v2/addresses/0xb354…                         -> {"error":"not found"}
https://hoodscan.co/api/v2/smart-contracts/0xb354…                    -> {"code":"FORBIDDEN"}  (market-data API only; /openapi.json exposes only /stocks-api*)
https://stonkscan.io/api/contract/0xb354…                             -> HTML, no API
```

**No verified source is obtainable for any contract on 4663 from any of the four explorers.** Their UNRESOLVED #1
stands, now exhaustively. Everything in this file — theirs and mine — is bytecode- and live-call-derived.

HoodScan does give useful third-party corroboration of the token identity (`Accept: text/markdown` on
`https://hoodscan.co/stocks/NVDA`): *"NVIDIA • Robinhood Token … Token contract: 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"*,
$20.9M liquidity across 30 pools, 136,906 holders. Note it counts **191** stock/ETF tokens against the factory's
**204** `Deployed` events — the on-chain count is authoritative; the gap is presumably delisted or non-stock deployments.

## V14. Their open items I could NOT resolve — their UNRESOLVED entries are honest

- **The 7 unidentified role hashes** (1 registry, 6 USDG). I ran an independent brute force over 1,744
  candidates — ~100 role stems × `_ROLE`/`ROLE`/`_ROLE()`/`_ADMIN_ROLE` suffixes × 4 prefixes. **No match**,
  including for `0xb4e5de7340a2fee2ff9be79f5ec0e8feae4b633bc8cc663711520e08f24984f8`. Genuinely open.
- **`getFrozenData(address)` return shape.** Returns 2 zero words for every address; since `Freeze` has **0**
  occurrences chain-wide there is no non-zero sample anywhere to decode against. Undecidable from chain state.
- **`0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6`** — unidentified. I confirmed its two
  neighbours are `0x6e71edae…26c9` (ERC-2612 `PERMIT_TYPEHASH`) and `0x8b73c3c6…400f` (EIP-712 domain typehash),
  and that `0xc7f505b2…81d2` is the `EIP712DomainChanged()` topic, so their "probably a third typehash" reading
  is the reasonable one — but unproven.
- **Non-view return types** in both ABI JSONs remain inferred. Correct to keep flagged.
- **Testnet 46630** not checked here either (R7 scope).
- The multiplier namespace **`0x395525728d1d…5959d00` could not be named** — it is not `robinhood.storage.{ScaledUIAmount,Multiplier,UIMultiplier,…}` (24 candidates × 6 prefixes tried). Cosmetic.

## V15. Net effect on the build

Nothing in their §8 changes. Reinforced, and three additions:

1. **§8.1 stands on proof.** Non-rebasing is now confirmed by pinned-block identity across 8 holders, by raw-value
   `Transfer` events on both sides of the only historical multiplier step, by direct storage reads showing the
   multiplier and `totalSupply` in separate namespaces, by ERC-165, by the EIP text and by Robinhood's own docs.
   **Use raw `balanceOf`. Do not rebase internally.**
2. **Add to the Policy/NAV spec:** Robinhood's docs say the Chainlink price **already includes** the multiplier.
   Never multiply a feed price by `uiMultiplier()`. Reconcile with R5.
3. **Lead the risk disclosure with the beacon upgrade, not `adminBurn`.** A single bare EOA
   (`0xcd8c6182e7c6ca3b5156d6a90a67719d7e2be094`, `BEACON_UPGRADER_ROLE`) can replace the logic of all 204 stock
   tokens in one untimelocked transaction. The EIP-1967 beacon slot on the proxies is dead storage, so
   `registry.upgradeTo()` is the whole attack surface — and the correct thing to monitor is
   `Upgraded(address)` **on the registry** `0xe10b6f6b…1b00`, alongside their `Paused()`/`Blocked()` watches.
4. **Do not treat `ops/abis/USDG.json` as complete** until the third facet `0xdc3ef8ab3eb30d62e04dbe8a804d232573aa1fe5`
   is folded in, and split the merged NVDA/USDG signature list.
