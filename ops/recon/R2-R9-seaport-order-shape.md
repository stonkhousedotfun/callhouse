# R2 / R9 — Overcall Seaport 1.6 order shape + conduit (chain 4663)

**Status: RESOLVED.** Found the single real Overcall fill that exists on Robinhood Chain mainnet,
decoded it from raw calldata, and independently confirmed the same shape against Overcall's own
public listings API. Both sources agree byte-for-byte.

Recon date: 2026-09-12. RPC used for every call below: `https://rpc.mainnet.chain.robinhood.com`
(the publicnode RPC rejects `eth_getLogs` with `Archive requests require a personal token`;
ordofi returns `the network is busy`). Blockscout `robinhoodchain.blockscout.com` is behind a
Cloudflare managed challenge and returned the JS interstitial for every `/api/v2/...` path, so
**all history below came from raw `eth_getLogs`**, not from an explorer.

---

## 0. TL;DR — the shape to copy

| field | value | how confirmed |
|---|---|---|
| `offerer` | the writer (EOA in both live samples) | calldata + API |
| `zone` | `0x0000000000000000000000000000000000000000` | calldata + API |
| `zoneHash` | `0x00…00` (32 zero bytes) | calldata + API |
| `orderType` | **`1` = PARTIAL_OPEN** | calldata word 8 + API `"orderType":1` |
| `startTime` | `0` | calldata + API |
| `endTime` | option's **exerciseTimestamp** (Friday 20:00 UTC book close), not expiry | calldata + API |
| `salt` | full random 256-bit, no OpenSea-style domain prefix | two samples, both high-entropy |
| `conduitKey` | **`0x00…00` (ZERO)** | calldata word 13 + API + `setApprovalForAll(SEAPORT,…)` on chain |
| `totalOriginalConsiderationItems` | `2` | calldata word 14 |
| `counter` | `0` (`Seaport.getCounter(offerer) == 0` for both offerers) | eth_call |
| offer[0] | `itemType 3` (ERC1155), token = Valorem Clear, id = Valorem option id, `startAmount == endAmount == contracts` | calldata + API |
| consideration[0] | `itemType 1` (ERC20) USDG, **95 %** of gross, recipient = offerer | calldata + API + ERC20 Transfer logs |
| consideration[1] | `itemType 1` (ERC20) USDG, **5 %** of gross, recipient = **`0xdAe7e82A2E7D566C67E87C164B05a1C560190782`** | calldata + API + ERC20 Transfer logs |
| signature | plain **65-byte ECDSA** (r,s,v=27), offerer is an EOA | recovered signer == offerer |
| fulfilled via | `fulfillOrder(...)` selector `0xb3a34c4c`, `fulfillerConduitKey = 0x00…00` | tx input |

**Overcall fee recipient (exact): `0xdAe7e82A2E7D566C67E87C164B05a1C560190782`.**
Same address is also `ValoremClear.feeTo()` — see §7.

---

## 1. Topic hash (computed, not guessed)

```
$ cast keccak "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])"
0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31

$ cast keccak "TransferSingle(address,address,address,uint256,uint256)"
0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62
```

## 2. Seaport `information()` — version, domain separator, conduit controller

```
$ cast sig "information()"
0xf47b7740

$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x0000000000000068F116a894984e2DB1123eB395","data":"0xf47b7740"},"latest"],"id":1}' \
  https://rpc.mainnet.chain.robinhood.com
{"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000000000000000000000000000000000000000000060
a6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0
00000000000000000000000000000000f9490004c11cef243f5400493c00ad63
0000000000000000000000000000000000000000000000000000000000000003
312e360000000000000000000000000000000000000000000000000000000000"}
```

Decoded:

| | |
|---|---|
| `version` | **`"1.6"`** (len 3, `0x312e36`) |
| `domainSeparator` | **`0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0`** |
| `conduitController` | **`0x00000000F9490004C11Cef243f5400493c00Ad63`** (the canonical address) |

Independently re-derived the domain separator and it matches exactly:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name="Seaport" version="1.6" chainId=4663 verifyingContract=0x0000000000000068F116a894984e2DB1123eB395
computed domainSeparator 0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0
on-chain   domainSeparator 0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0
```

### 2a. The Seaport on 4663 is canonical Seaport 1.6 (bytecode-verified)

Diffed the deployed runtime against Ethereum mainnet Seaport 1.6 at the same address
(`https://ethereum-rpc.publicnode.com`). Same length, **only two immutables differ**:

```
len 23981 23981
differing bytes: 34   (2 runs)
  offset 15419..15420 len 2   4663=1237      mainnet=0001      <- immutable chainId (0x1237 = 4663)
  offset 15427..15458 len 32  4663=a6b20d2b…30b0  mainnet=fce34bc6…ba64   <- immutable domain separator
```

4663 Seaport codehash: `0x95809b70c9659c30188db5fdd87103e24b1a55379af8c851fca393aba0224a00` (23981 bytes).

EIP-712 typehashes (recomputed locally, standard Seaport):

```
OrderComponents    0xfa445660b7e21515a59617fcd68910b487aa5808b8abda3d78bc85df364b2c2f
OfferItem          0xa66999307ad1bb4fde44d13a5d710bd7718e0c87c1eef68a571629fbf5b93d02
ConsiderationItem  0x42d81c6929ffdc4eb27a0808e40e82516ad42296c166065de7f812492304ff6e
```

## 3. Finding the real fill

`eth_getLogs` on this RPC accepts the **full 0 → latest** range for a single address, so no
chunking was needed. Valorem Clear's entire event history is tiny:

```
address 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0, fromBlock 0x0, toBlock latest  -> 59 logs total

0x4da1232e91e9e12e1fcd6f97817ab15d2d20bdc3596fbfefc47b69ec4bcb3aeb  50   NewOptionType
0x64b996b55aa21c6915cb2fbdc6f619d5456d7ab76ac22242b0c8651a560c7abb   2   OptionsWritten
0x018396e28579edb572f52da642075ea7c69a23fb652be2694ed71bf27aa524fd   2   BucketWrittenInto
0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb   2   TransferBatch
0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31   2   ApprovalForAll
0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62   1   TransferSingle   <-- THE fill
```

All six topic0 values were matched by `cast keccak` on the candidate signature, not guessed
(e.g. `cast keccak "NewOptionType(uint256,address,address,uint96,uint96,uint40,uint40)"` →
`0x4da1232e…3aeb`).

The one `TransferSingle`:

```
tx 0x013cd30b541372fa7f505dfb743a563f39e284b7d2805dbcb964b6a754ae720b  block 61153997
operator 0x0000000000000068f116a894984e2db1123eb395   <-- SEAPORT ITSELF (not a conduit)
from     0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
to       0x8684c0b2e23d0c699a1ff4437e8d92258bc82905
id       0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
value    1
```

Cross-check that this is the **only** Overcall fill ever: every USDG `Transfer` whose `to` is the
Overcall fee address, over all of history —

```
eth_getLogs address=USDG topics=[Transfer, null, 0x…dae7e82a…] fromBlock 0x0 toBlock latest
USDG transfers TO overcall fee addr: 1
  blk 61153997  from 0x8684c0b2e23d0c699a1ff4437e8d92258bc82905  amt 200000
  tx 0x013cd30b541372fa7f505dfb743a563f39e284b7d2805dbcb964b6a754ae720b
```

And every Seaport log with `topics[1] == offerer`:

```
Seaport logs w/ offerer 0xe73d…75be in topic1: 1
  blk 61153997  t0 0x9d9af8e3…6f31 (OrderFulfilled)
```

→ no `OrderCancelled`, no `OrderValidated`, no `CounterIncremented`. Overcall never pre-validates
on chain; the order lives purely as an off-chain signature until someone fulfills it.

## 4. The `OrderFulfilled` event, decoded

```json
{
 "orderHash": "0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522",
 "offerer":   "0xe73d7021a3ef2808c3dd8237982fcc5fa11275be",
 "zone":      "0x0000000000000000000000000000000000000000",
 "recipient": "0x8684c0b2e23d0c699a1ff4437e8d92258bc82905",
 "offer": [
  {"itemType": 3, "token": "0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0",
   "identifier": "56885395977254369119998982131173877604217583767740146085872832926902011297792",
   "amount": "1"}
 ],
 "consideration": [
  {"itemType": 1, "token": "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "identifier": "0",
   "amount": "3800000", "recipient": "0xe73d7021a3ef2808c3dd8237982fcc5fa11275be"},
  {"itemType": 1, "token": "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "identifier": "0",
   "amount": "200000",  "recipient": "0xdae7e82a2e7d566c67e87c164b05a1c560190782"}
 ],
 "txHash": "0x013cd30b541372fa7f505dfb743a563f39e284b7d2805dbcb964b6a754ae720b",
 "blockNumber": 61153997
}
```

Matching ERC20 `Transfer` logs in the same receipt (USDG, 6 decimals — `decimals()` → `6`,
`symbol()` → `USDG`):

```
USDG  from 0x8684c0b2…2905  to 0xe73d7021…75be  amt 3800000   (3.80 USDG = 95.0 %)
USDG  from 0x8684c0b2…2905  to 0xdae7e82a…0782  amt  200000   (0.20 USDG =  5.0 %)
                                          gross  4000000   (4.00 USDG)
```

**95 / 5 split confirmed exactly.** Fee recipient confirmed: `0xdAe7e82A2E7D566C67E87C164B05a1C560190782`.

## 5. Originating transaction → full `OrderParameters`

```
tx    0x013cd30b541372fa7f505dfb743a563f39e284b7d2805dbcb964b6a754ae720b
from  0x8684c0b2e23d0c699a1ff4437e8d92258bc82905   (buyer)
to    0x0000000000000068f116a894984e2db1123eb395   (Seaport)
value 0    input 1220 bytes    selector 0xb3a34c4c
```

`cast sig "fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)"`
→ `0xb3a34c4c` ✔ (checked `fulfillBasicOrder` = `0xfb0f3ee1` and `fulfillAdvancedOrder` = `0xe7acab24`, neither matches)

Raw calldata words (offsets relative to the 4-byte selector):

```
w00 …0040   -> offset to Order struct (word 2)
w01 …0000   -> fulfillerConduitKey = 0x00…00           <-- buyer ALSO uses no conduit
w02 …0040   -> Order.parameters offset  (word 4)
w03 …0400   -> Order.signature   offset (word 34)
w04 000000000000000000000000e73d7021a3ef2808c3dd8237982fcc5fa11275be   offerer
w05 0000…0000                                                          zone = address(0)
w06 …0160   -> offer offset            (word 15)
w07 …0220   -> consideration offset    (word 21)
w08 …0001   orderType = 1 = PARTIAL_OPEN
w09 …0000   startTime = 0
w10 …6aad9840   endTime = 1789761600 = 2026-09-18T20:00:00Z
w11 0000…0000   zoneHash = bytes32(0)
w12 d41d3e5932ad2f6d51910cd86e5482e154a23ea77275d006d602712094dda344   salt
w13 0000…0000   conduitKey = bytes32(0)                                 <-- ZERO CONDUIT
w14 …0002   totalOriginalConsiderationItems = 2
w15 …0001   offer.length = 1
w16 …0003     itemType = 3 (ERC1155)
w17 …9a7b40e5c1db1af822ef091c990b58b02c78c0c0   token = Valorem Clear
w18 7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000   identifierOrCriteria
w19 …0001     startAmount = 1
w20 …0001     endAmount   = 1
w21 …0002   consideration.length = 2
w22 …0001     itemType = 1 (ERC20)
w23 …5fc5360d0400a0fd4f2af552add042d716f1d168   USDG
w24 …0000     identifierOrCriteria = 0
w25 …0039fbc0 startAmount = 3800000
w26 …0039fbc0 endAmount   = 3800000
w27 …e73d7021a3ef2808c3dd8237982fcc5fa11275be   recipient = offerer
w28 …0001     itemType = 1
w29 …5fc5360d0400a0fd4f2af552add042d716f1d168   USDG
w30 …0000     identifierOrCriteria = 0
w31 …00030d40 startAmount = 200000
w32 …00030d40 endAmount   = 200000
w33 …dae7e82a2e7d566c67e87c164b05a1c560190782   recipient = OVERCALL FEE
w34 …0041   signature.length = 65
w35 110031b6ee7194d2f32d90a12bde37ea048c81c4094da7207a25edadb4c081ec   r
w36 35ae8045cafac3191fbc3c0be75eba15c62fccabf9f72508318f528f51ab56b0   s
w37 1b…                                                                v = 27
```

### Order hash proof

Recomputed the EIP-712 `OrderComponents` hash from the decoded parameters with `counter = 0`
(`Seaport.getCounter(0xe73d…75be)` → `0`, selector `0xf07ec373`):

```
counter 0  orderHash 0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522
actual     orderHash 0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522
```

**Exact match** — so the decode above is the complete, correct `OrderParameters`, and
`totalOriginalConsiderationItems == consideration.length == 2` (it is not part of the signed struct;
it must still be set correctly in the calldata struct or Seaport reverts).

### Signature proof

```
EIP712 digest    0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150   (0x1901 || DS || orderHash)
recovered signer 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
offerer          0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
eth_getCode(offerer) -> 0 bytes   (EOA)
```

Plain 65-byte ECDSA. **Not** EIP-2098 compact, **not** EIP-1271. (Overcall's own signer is an EOA;
a contract offerer like our vault would fall through to the EIP-1271 branch, which Seaport supports,
but Overcall's own production path has never exercised it — see UNRESOLVED.)

`getOrderStatus(0xa11edb62…)` (selector `0x46423aa7`) after the fill:

```
isValidated 1   isCancelled 0   totalFilled 1   totalSize 1
```

## 6. R9 — the conduit question. Answer: **zero conduit key, direct Seaport approval.**

Three independent confirmations:

1. `conduitKey` in the signed order is `bytes32(0)` (calldata w13, and `"conduitKey":"0x00…00"` in
   Overcall's API).
2. The offerer approved **Seaport itself**, not a conduit:
   ```
   tx 0x0de2f1a5f5809b611aaa3aa7674c202e7ab6954edcc37cd4d51fd247d3414438  block 60303653
   from 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
   to   0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0   (Valorem Clear)
   input 0xa22cb465                                          setApprovalForAll(address,bool)
         0000000000000000000000000000000000000068f116a894984e2db1123eb395   = SEAPORT
         0000000000000000000000000000000000000000000000000000000000000001   = true
   ```
   Live re-check via `isApprovedForAll` (`0xe985e9c5`) on Clear:
   ```
   0x789A7490718CF944D6F2cA411ED53cDeFd56306a  approved->Seaport 1   approved->zero-key-conduit 0
   0xe73d7021a3ef2808c3dd8237982fcc5fa11275be  approved->Seaport 1   approved->zero-key-conduit 0
   ```
3. The `TransferSingle` `operator` is Seaport `0x…68f116a894984e2db1123eb395`, not a conduit address.

**Implication for Stonkhouse:** `AdapterSeaport` must call
`clear.setApprovalForAll(0x0000000000000068F116a894984e2DB1123eB395, true)` — approve **Seaport
directly**. Do not deploy or use a conduit.

### ConduitController on 4663 (verified, plus one trap)

`eth_getCode(0x00000000F9490004C11Cef243f5400493c00Ad63)` → **8820 bytes**. Present and matches the
address Seaport's `information()` reports.

Its full event history (`fromBlock 0x0`) is 8 logs = **4 conduits created**, none of them Overcall's:

| block | conduit | key prefix (creator) |
|---|---|---|
| 609699 | `0x963F00d3ff000064fFCbA824b800c0000000C300` | `0x61159Fefdfada89302ed55f8B9e89e2D67d82587…` |
| 4972630 | `0x2511B11582E0858d68472eCd3Bee4f27533202a4` | `0xCe370EbCBC655F845DF7DFb8C079E75B5EA17D93…` |
| 32524266 | `0xA8eBB42940fd93C944785Fab49EB7Db2E29a9EF3` | `0x2383E444C160768BE4A368D50593fE1E4B9F3a27…` |
| 55447152 | `0x44e5CD5495944fe1e99a74D0D642a90565e7c03e` | `0x28aE44Ae6D461f9371EB06f5e3950846487Cc3B2…` |

Event sigs computed: `NewConduit(address,bytes32)` = `0x4397af6128d529b8ae0442f99db1296d5136062597a15bbc61c1b2a6431a7d15`.

⚠️ **Trap — do not blanket-resolve `conduitKey` through the controller.** On 4663,

```
ConduitController.getConduit(0x00…00)  ->  conduit 0xf9ed144bacaed98d0f3899b8b56c965d1a966d08, exists = true
eth_getCode(0xf9ed144b…)  -> 3190 bytes,
   codehash 0x069efdc9b946a332dce9951324fa197268e3ff0e00e44c6bf36049fc53113a41
   (identical codehash to all four real conduits above)
```

There is **real conduit runtime code at the zero-key-derived address** on this chain, and
`getConduit(bytes32(0))` reports `exists = true`. It is *not* what Seaport uses: Seaport special-cases
`conduitKey == bytes32(0)` and transfers directly. It is also inert — the controller has no record of it:

```
ConduitController.ownerOf(0xf9ed144b…) -> revert 0x4ca82090
ConduitController.getKey(0xf9ed144b…)  -> revert 0x4ca82090
cast sig "NoConduit()"  ->  0x4ca82090
```

So nobody can open channels on it. But any code that does
`if (conduitKey != 0) approve(getConduit(conduitKey))` **must** keep the `!= 0` guard, and must never
approve `0xf9ed144b…`.

## 7. R2 — orderType, partial fills, restriction

- `orderType = 1`. Seaport's enum: `0 FULL_OPEN, 1 PARTIAL_OPEN, 2 FULL_RESTRICTED, 3 PARTIAL_RESTRICTED, 4 CONTRACT`.
- `zone = address(0)` and `zoneHash = bytes32(0)` → **unrestricted**. No zone callback, no
  `validateOrder` hook, anyone can fulfill. Nothing gates who may buy.
- **Partial fills ARE allowed.** `PARTIAL_OPEN` + Overcall's API exposes `remaining`,
  `filledNumerator`, `filledDenominator`. The single historical fill happened to be `1/1` via
  `fulfillOrder`; a buyer wanting less than the whole size must use `fulfillAdvancedOrder`
  (`0xe7acab24`) with `numerator/denominator`.
- The reference fill used `fulfillOrder`, which forces the whole order — that is the buyer's choice,
  not a property of the order.

**Divisibility rule the keeper must respect.** Seaport reverts with `InexactFraction` unless every
item amount times `numerator` divides evenly by `denominator`. Overcall's live open order is built so
that the per-contract unit price splits cleanly:

```
quantity 21, unitPrice6 50000  ->  total 1,050,000
  consideration[0] 997,500  = 47,500 per contract  (95 %)
  consideration[1]  52,500  =  2,500 per contract  ( 5 %)
```

i.e. pick `unitPrice6` divisible by 20 so the 5 % leg is an integer per contract, then set
`startAmount = endAmount = unitPrice6 * contracts * 19/20` and `.../20`. That guarantees any
`n/contracts` fraction is exact. **Copy this.**

## 8. Second, independent sample — Overcall's public listings API

`https://overcall.finance/api/orders` is open, unauthenticated `GET` (also accepts
`?status=filled`, `?chainId=4663`). `OPTIONS` reports `allow: GET, HEAD, OPTIONS, POST`.

Currently-open order (fetched 2026-09-12):

```json
{
 "orderHash": "0xeda0150a4b4fa3dbdac9fb4aca507c9784f19b9024dc24c52c6993429ef4bded",
 "chainId": 4663,
 "offerer": "0x789A7490718CF944D6F2cA411ED53cDeFd56306a",
 "optionId": "873393324505681306211742772675693943830305973181304956549530887026947129344",
 "quantity": "21", "remaining": "21",
 "unitPrice6": "50000", "totalPrice6": "1050000", "realisedPremium6": "0",
 "startTime": "0", "endTime": "1789761600",
 "counter": "0", "status": "open",
 "filledNumerator": "0", "filledDenominator": "0",
 "components": {
   "offerer": "0x789A7490718CF944D6F2cA411ED53cDeFd56306a",
   "zone": "0x0000000000000000000000000000000000000000",
   "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
   "orderType": 1,
   "startTime": "0", "endTime": "1789761600",
   "salt": "75794036196465706161439318797461512643738241961564828131921871581053974772386",
   "conduitKey": "0x0000000000000000000000000000000000000000000000000000000000000000",
   "counter": "0",
   "offer": [{"itemType":3,"token":"0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
              "identifierOrCriteria":"8733933245…129344","startAmount":"21","endAmount":"21"}],
   "consideration": [
     {"itemType":1,"token":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168","identifierOrCriteria":"0",
      "startAmount":"997500","endAmount":"997500","recipient":"0x789A7490718CF944D6F2cA411ED53cDeFd56306a"},
     {"itemType":1,"token":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168","identifierOrCriteria":"0",
      "startAmount":"52500","endAmount":"52500","recipient":"0xdAe7e82A2E7D566C67E87C164B05a1C560190782"}]
 },
 "signature": "0xbb0484c1…193f1c"   (65 bytes)
}
```

I recomputed its order hash from `components` alone:

```
recomputed orderHash 0xeda0150a4b4fa3dbdac9fb4aca507c9784f19b9024dc24c52c6993429ef4bded
api orderHash        0xeda0150a4b4fa3dbdac9fb4aca507c9784f19b9024dc24c52c6993429ef4bded
match True
```

On-chain state of that open order: `getOrderStatus` → `isValidated 0, isCancelled 0, totalFilled 0,
totalSize 0`; `getCounter(0x789A…306a)` → `0`; offerer code length 0 (EOA); `isApprovedForAll(offerer,
Seaport)` → `1`.

`GET /api/orders?status=filled` returns exactly the one fill I found on chain, with the identical
signature bytes `0x110031b6…1b`, salt `959419927…708740` (= `0xd41d3e59…a344`) and components —
so **the API is a faithful mirror of the signed order.** `realisedPremium6: "3800000"` is the *net to
writer*, `totalPrice6: "4000000"` is gross. (Note for R3: `components` contains the EIP-712
`OrderComponents` fields only — it has **no** `totalOriginalConsiderationItems`; a fulfiller must
add it = `consideration.length`.)

Note the field naming: prices are carried as `unitPrice6` / `totalPrice6` / `realisedPremium6`
(USDG 6-decimal integers), and `optionId` / `quantity` / `remaining` are decimal strings.

## 9. What the option itself is (context for the order)

`NewOptionType` for the traded id, block 60254180,
tx `0xb7488de2320a49a2b8408ae82a26f55854f8f6e9b92172f04f02b0a61ae2f6a5`:

```
optionId          0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
  optionTypeId    0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54   (upper 160 bits)
  claim index     0                                            (low 96 bits — 0 = the option token)
underlyingAsset   0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC  NVDA, 18 dec
underlyingAmount  1000000000000000000  (1 NVDA per contract)
exerciseAsset     0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  USDG, 6 dec
exerciseAmount    246000000            (strike $246.00)
exerciseTimestamp 1789761600 = 2026-09-18T20:00:00Z   <-- equals the order's endTime
expiryTimestamp   1789848000 = 2026-09-19T20:00:00Z
```

All 50 `NewOptionType` events belong to one cycle (same exercise/expiry): **10 markets × 5 strikes**.

| underlying | symbol | strike ladder (USDG, 6 dec) |
|---|---|---|
| `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | NVDA | 226 / 231 / 236 / 241 / **246** |
| `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | TSLA | 373 / 380 / 388 / 396 / 404 |
| `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | SPCX | 154 / 157 / 160 / 163 / 166 |
| `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | SPY | 784 / 800 / 816 / 832 / 849 |
| `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | AAPL | 336 / 343 / 350 / 357 / 364 |
| `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | AMZN | 261 / 266 / 271 / 276 / 282 |
| `0x020bfC650A365f8BB26819deAAbF3E21291018b4` | CASHCAT | 0.172 / 0.175 / 0.179 / 0.183 / 0.187 |
| `0x39dBED3a2bd333467115dE45665cC57F813C4571` | PONS | 0.645 / 0.658 / 0.671 / 0.684 / 0.698 |
| `0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18` | AI | 0.313 / 0.319 / 0.325 / 0.332 / 0.339 |
| `0xD7321801CAae694090694Ff55A9323139F043B88` | JUGGERNAUT | 0.01014 / 0.01034 / 0.01055 / 0.01076 / 0.01098 |

All five NVDA strikes carry `underlyingAmount = 1e18`, so **1 option contract = 1 whole NVDA token.**
Symbols/decimals came from `symbol()` (`0x95d89b41`) and `decimals()` (`0x313ce567`) eth_calls.

Writer lifecycle observed (useful for the keeper):

```
2026-09-11 13:45:10Z  blk 60302146  writer -> Clear   write(uint256,uint112)        0x888fbf43
                      args: optionId 0x7dc3fe3e…0000, amount 1
                      emits OptionsWritten + BucketWrittenInto + TransferBatch(mint) of
                      [optionId …0000 = option ERC1155, optionId …0001 = claim NFT], amounts [1,1]
2026-09-11 13:47:45Z  blk 60303653  writer -> Clear   setApprovalForAll(SEAPORT,true) 0xa22cb465
2026-09-11 13:48:12Z                POST to Overcall API (createdAt in the listing)
2026-09-12 13:49:12Z  blk 61153997  buyer  -> Seaport fulfillOrder                   0xb3a34c4c
```

Option types are created by a separate EOA: `newOptionType(address,uint96,address,uint96,uint40,uint40)`
= `0xaa9ffa93`, tx `0xb7488de2…f6a5` sent from `0x408adcffebdf48ec23f1e3811a91aed3cc951cc0`.

Valorem engine fee state right now (bonus for R4 / the policy gate):

```
ValoremClear.feesEnabled()  (0xa64e4f8a) -> 0x00…00  = false
ValoremClear.feeTo()        (0x017e7e58) -> 0x…dae7e82a2e7d566c67e87c164b05a1c560190782
```

→ the Overcall Seaport 5 % fee recipient **is the same address as Valorem's `feeTo`**.

## 10. Addresses touched, with evidence

| name | address | evidence |
|---|---|---|
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` | `eth_getCode` 23981 B; `information()` → `"1.6"` |
| ConduitController | `0x00000000F9490004C11Cef243f5400493c00Ad63` | `eth_getCode` 8820 B; returned by `information()` |
| Valorem Clear | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` | `eth_getCode` 16110 B; offer token in the fill |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `symbol()`=USDG `decimals()`=6; consideration token |
| NVDA stock token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `symbol()`=NVDA `decimals()`=18; `NewOptionType.underlyingAsset` |
| **Overcall fee recipient** | `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` | `consideration[1].recipient` in the fill + USDG Transfer log + `Clear.feeTo()`; 0 bytes code (EOA) |
| Overcall writer #1 (offerer of the filled order) | `0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be` | offerer topic of `OrderFulfilled`; 0 bytes code (EOA) |
| Overcall writer #2 (offerer of the live open order) | `0x789A7490718CF944D6F2cA411ED53cDeFd56306a` | API + `isApprovedForAll` → 1; 0 bytes code (EOA) |
| Buyer / fulfiller | `0x8684C0b2E23D0c699A1Ff4437e8d92258bc82905` | `tx.from`; 0 bytes code (EOA) |
| Option-type creator | `0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` | `tx.from` of the `newOptionType` call |
| zero-key conduit (DO NOT USE) | `0xf9ed144bACaed98d0f3899B8B56c965D1A966D08` | `getConduit(0)` → exists; 3190 B code; `ownerOf` reverts `NoConduit()` |

## 11. Concrete guidance for `AdapterSeaport`

```
offerer   = address(vault)                     // contract -> Seaport takes the EIP-1271 branch
zone      = address(0)
zoneHash  = bytes32(0)
orderType = 1                                  // PARTIAL_OPEN
startTime = 0
endTime   = registry/option exerciseTimestamp  // Friday 20:00 UTC, NOT the Saturday expiry
salt      = 32 random bytes (no prefix)
conduitKey= bytes32(0)
totalOriginalConsiderationItems = 2
offer[0]        = OfferItem(ERC1155, CLEAR, optionId, contracts, contracts)
consideration[0]= ConsiderationItem(ERC20, USDG, 0, gross*19/20, gross*19/20, vault)
consideration[1]= ConsiderationItem(ERC20, USDG, 0, gross/20,    gross/20,    0xdAe7e82A2E7D566C67E87C164B05a1C560190782)
   with gross = unitPrice6 * contracts, unitPrice6 % 20 == 0
approval  = CLEAR.setApprovalForAll(SEAPORT, true)     // NOT a conduit
counter   = Seaport.getCounter(vault)   // cancel-all by incrementCounter(); per-order cancel via cancel(OrderComponents[])
```

Signing: Overcall's own makers are EOAs using 65-byte ECDSA. Our vault is a contract, so Seaport
will fall through to `isValidSignature` (EIP-1271) on the vault. Alternative per TECHSPEC §4.7:
`Seaport.validate(Order[])` from the vault so `isValidated == 1` and no signature is needed at fill
time — note that Overcall has **never** used `validate()` (zero `OrderValidated` events on this
Seaport for their offerers), so validate-only orders are untested against their API/UI.

---

## UNRESOLVED

1. **Whether Overcall's API/UI accepts a contract (EIP-1271) offerer.** Both live makers are EOAs and
   the API stores a 65-byte `signature` string. I did not POST to `https://overcall.finance/api/orders`
   (write action, out of scope for read-only recon) so I could not test whether it validates the
   signature as ECDSA-only or calls `isValidSignature`. **This is the single biggest launch risk for
   R2/R3** — if their indexer does `ecrecover(...) == offerer`, our vault's EIP-1271 order will be
   rejected off-chain even though it fills fine on-chain. R3 should test this with a throwaway maker.
2. **Whether Overcall ever posts orders with `orderType 0/2/3` or a non-zero `conduitKey`.** Only two
   orders exist in total on 4663 (1 filled + 1 open); both are `orderType 1`, `zone 0`, `conduitKey 0`.
   A sample of two. The shape could change if they add a zone later.
3. **Whether a real partial fill has ever been executed on this Seaport by Overcall.** `PARTIAL_OPEN`
   is declared and the API tracks `filledNumerator/filledDenominator`, but the one historical fill was
   `1/1` via `fulfillOrder`. Partial-fill behaviour with their book is untested in production.
4. **Provenance of the conduit at `0xf9ed144bACaed98d0f3899B8B56c965D1A966D08`.** It has valid conduit
   runtime bytecode but no `ConduitController` record (`ownerOf` reverts `NoConduit()`), and
   `createConduit` with `conduitKey == bytes32(0)` would require `msg.sender == address(0)`. Most likely
   a genesis/pre-deploy artifact of the Orbit chain. Harmless (no one can open channels on it) but
   unexplained. I did not find its deploying transaction.
5. **Blockscout REST API is unusable from a terminal** — `robinhoodchain.blockscout.com/api/v2/*` and
   `/api?module=...` both return the Cloudflare "Just a moment…" managed-challenge HTML, with or without
   a browser User-Agent. `robinscan.io/api/v2/*` → `{"error":"not found"}`; `hoodscan.co/api/v2/*` →
   `{"code":"FORBIDDEN"}` and points at an MCP server at `https://hoodscan.co/mcp` plus
   `https://hoodscan.co/swaps-api` and `https://hoodscan.co/llms.txt`; `stonkscan.io/api/v2/*` → the
   Next.js HTML shell. **I never obtained verified Solidity source or an ABI from any explorer.** Every
   ABI element in this doc was confirmed by `cast keccak` / `cast sig` against observed topic0 values and
   observed 4-byte selectors, plus successful `eth_call`s. R8 should chase the hoodscan MCP server.
6. **Whether the 5 % fee recipient ever received anything other than USDG.** I only scanned USDG
   `Transfer` logs with that address as `to` (exactly 1 hit, all-history). I did not enumerate every
   ERC20 on the chain.
7. **`overcall.finance/api/orders` pagination / filter grammar.** `?status=filled` and `?chainId=4663`
   work; `?includeFilled=true` is ignored (returns only the open order). `/api/cycle` and `/api/markets`
   return the Next.js HTML shell, i.e. they are not endpoints. No auth headers were needed for GET.
   POST body shape is untested — that belongs to R3.

## Artifacts

- `<callhouse>/ops/recon/sample-overcall-order.json`
  — the full decoded real order (parameters + signature + provenance + the live open order as a
  second sample).

---

# Verification pass — adversarial re-check (independent agent)

**Date:** 2026-09-12. **Verdict: CONFIRMED** (one citation error; two of the original UNRESOLVED items
now resolved). Every check below was re-run from scratch against
`https://rpc.mainnet.chain.robinhood.com`; nothing was taken from the original report.

Isolation note: the shared scratchpad had a concurrent writer (my `rpc.py` was overwritten mid-run by
another agent). All work below was redone in a private directory to rule out cross-contamination.

## V1. Every claimed address re-`eth_getCode`'d

```
Seaport              0x0000000000000068F116a894984e2DB1123eB395 bytes=23981
ConduitController    0x00000000F9490004C11Cef243f5400493c00Ad63 bytes=8820
ValoremClear         0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 bytes=16110
USDG                 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 bytes=170
FeeRecipient         0xdAe7e82A2E7D566C67E87C164B05a1C560190782 bytes=0      (EOA)
NVDA                 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC bytes=283
OffererFilled        0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be bytes=0      (EOA)
OffererOpen          0x789A7490718CF944D6F2cA411ED53cDeFd56306a bytes=0      (EOA)
Buyer                0x8684C0b2E23D0c699A1Ff4437e8d92258bc82905 bytes=0      (EOA)
OptTypeCreator       0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0 bytes=0      (EOA)
ZeroKeyConduit       0xf9ed144bACaed98d0f3899B8B56c965D1A966D08 bytes=3190
Conduit1             0x963F00d3ff000064fFCbA824b800c0000000C300 bytes=3190
Conduit2             0x2511B11582E0858d68472eCd3Bee4f27533202a4 bytes=3190
Conduit3             0xA8eBB42940fd93C944785Fab49EB7Db2E29a9EF3 bytes=3190
Conduit4             0x44e5CD5495944fe1e99a74D0D642a90565e7c03e bytes=3190
```
All 15 match the reported byte counts exactly. **No fabricated address.**

## V2. Every claimed selector and topic0 recomputed

All 16 selectors recomputed with `cast sig` — every one matches:
`fulfillOrder 0xb3a34c4c`, `fulfillAdvancedOrder 0xe7acab24`, `fulfillBasicOrder 0xfb0f3ee1`,
`information() 0xf47b7740`, `getCounter 0xf07ec373`, `getOrderStatus 0x46423aa7`,
`getConduit 0x6e9bfd9f`, `getKey 0x93790f44`, `ownerOf 0x14afd79e`, `NoConduit() 0x4ca82090`,
`write 0x888fbf43`, `newOptionType 0xaa9ffa93`, `feesEnabled 0xa64e4f8a`, `feeTo 0x017e7e58`,
`setApprovalForAll 0xa22cb465`, `isApprovedForAll 0xe985e9c5`.

All 9 event topic0s recomputed with `cast keccak` — every one matches, and `OrderFulfilled`,
`TransferSingle` and `Transfer` were additionally matched against the topic0s actually present in the
fill receipt. **No selector was copied from an upstream repo without being present on-chain** — each
non-event selector was also exercised with a live `eth_call` that returned data rather than reverting.

## V3. Independent re-decode of the fill calldata

Fetched `0x013cd30b…720b` myself: `from 0x8684c0b2…2905`, `to 0x…68f116a894984e2db1123eb395`
(Seaport), block 61153997, ts 1789220952 = 2026-09-12T13:49:12Z, 1220 bytes of calldata, selector
`0xb3a34c4c`. Hand-decoded the ABI without reference to the original report:

```
TOP word1 (fulfillerConduitKey) = 0x00…00
offerer   = 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
zone      = 0x0000000000000000000000000000000000000000
orderType = 1
startTime = 0
endTime   = 1789761600  (2026-09-18 20:00:00 UTC)
zoneHash  = 0x00…00
salt      = 0xd41d3e5932ad2f6d51910cd86e5482e154a23ea77275d006d602712094dda344
conduitKey= 0x00…00
totalOriginalConsiderationItems = 2
offer[0] itemType=3 token=0x9a7b40e5…c0c0 id=0x7dc3fe3e…0000 start=1 end=1
cons[0]  itemType=1 token=0x5fc5360d…d168 id=0 start=end=3800000 recipient=0xe73d7021…75be
cons[1]  itemType=1 token=0x5fc5360d…d168 id=0 start=end=200000  recipient=0xdae7e82a…0782
signature len 65, v=27
```
**Every field reproduces theirs exactly.**

## V4. Cryptographic proof recomputed from scratch (pure-Python keccak + secp256k1)

```
derived domainSeparator = 0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0  MATCH
   (EIP712Domain, name="Seaport", version="1.6", chainId=4663, verifyingContract=Seaport)
OrderComponents typehash = 0xfa445660b7e21515a59617fcd68910b487aa5808b8abda3d78bc85df364b2c2f
recomputed orderHash = 0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522  MATCH emitted
digest               = 0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150
ecrecover            -> 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be = offerer               MATCH
```
The order hash reproducing means the decode is complete — any wrong field would break it. The domain
separator deriving with **chainId 4663** rules out any confusion with the Ethereum-mainnet deployment.

I also recomputed the **open** order's hash from the API's `components` alone:
`0xeda0150a4b4fa3dbdac9fb4aca507c9784f19b9024dc24c52c6993429ef4bded` — **MATCH**.

## V5. `information()` and the mainnet-Ethereum bytecode diff — reproduced

`eth_call 0xf47b7740` → version `"1.6"` (`0x312e36`), domainSeparator `0xa6b20d2b…30b0`,
conduitController `0x00000000f9490004c11cef243f5400493c00ad63`.

Pulled Ethereum mainnet Seaport runtime from `https://ethereum-rpc.publicnode.com` and diffed:
```
Ethereum mainnet Seaport bytes: 23981
chain 4663      Seaport bytes: 23981
differing bytes: 34   runs: 2
  offset 15419..15420  ETH 0001  |  4663 1237        <- immutable chainId (4663 = 0x1237)
  offset 15427..15458  ETH fce34bc6…ba64 | 4663 a6b20d2b…30b0   <- immutable domain separator
```
**Exactly 34 bytes in exactly 2 runs, as claimed.** Canonical Seaport 1.6.

## V6. The "only one fill ever" claim — independently reproduced

Full-history `eth_getLogs` on Valorem Clear (`fromBlock 0x0`, `toBlock latest`) returns **59 logs**:
50 NewOptionType, 2 OptionsWritten, 2 BucketWrittenInto, 2 TransferBatch, 2 ApprovalForAll,
**1 TransferSingle**. Identical census.

```
TransferSingle: blk 61153997 operator 0x0000000000000068f116a894984e2db1123eb395  <- SEAPORT, not a conduit
                from 0xe73d7021…75be to 0x8684c0b2…2905
TransferBatch:  blk 60302146 mint 0x0 -> 0xe73d7021…75be   (writer 1 write())
                blk 60910684 mint 0x0 -> 0x789a7490…306a   (writer 2 write())
ApprovalForAll: blk 60303653 owner 0xe73d7021…75be operator 0x…68f116a8… approved=1
                blk 60910861 owner 0x789a7490…306a operator 0x…68f116a8… approved=1
```
**Both approvals are to Seaport directly. Zero approvals to any conduit, ever.** Since any Overcall
fill must move a Clear ERC-1155, the single TransferSingle is conclusive: one fill, ever.

Seaport logs with `topics[1] == offerer`: filled-offerer → 1 (the OrderFulfilled); open-offerer → 0.
Confirms **no OrderCancelled / OrderValidated / CounterIncremented** (topic0s
`0x6bacc01d…`, `0xf2807919…`, `0x721c2012…` recomputed and absent).

## V7. Live state re-read

```
getOrderStatus(0xa11edb62…e522) -> isValidated=1 isCancelled=0 totalFilled=1 totalSize=1
getOrderStatus(0xeda0150a…bded) -> 0,0,0,0   (open order never validated on chain)
getCounter(both offerers)       -> 0
getConduit(bytes32(0))          -> 0xf9ed144bacaed98d0f3899b8b56c965d1a966d08, exists=true
ownerOf / getKey (0xf9ed144b…)  -> revert 0x4ca82090 = NoConduit()
ownerOf(0x963F00d3…)            -> 0x61159fefdfada89302ed55f8b9e89e2d67d82587
getKey (0x963F00d3…)            -> 0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e
Clear.isApprovedForAll(offerer1, SEAPORT)        -> 1
Clear.isApprovedForAll(offerer1, zeroKeyConduit) -> 0
Clear.isApprovedForAll(offerer2, SEAPORT)        -> 1
Clear.isApprovedForAll(offerer2, zeroKeyConduit) -> 0
Clear.feesEnabled()             -> false
Clear.feeTo()                   -> 0xdae7e82a2e7d566c67e87c164b05a1c560190782
```
ConduitController lifetime logs = 8 (4 `NewConduit` + 4 of `0xc8894f26…`), the 4 conduits and owner
keys exactly as reported. **R9 stands: conduitKey is ZERO, approval goes straight to Seaport.**

## V8. NEW — the zero-key conduit trap is proven to be a genuine CREATE2 derivation

I validated the standard Seaport conduit init-code hash
`0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059` against **all four real
conduits** (CREATE2 from the ConduitController with salt = conduitKey reproduces each address
exactly), then applied it to `salt = bytes32(0)`:

```
CREATE2(controller, bytes32(0), initCodeHash) = 0xf9ed144bacaed98d0f3899b8b56c965d1a966d08
getConduit(bytes32(0)) returned               = 0xf9ed144bacaed98d0f3899b8b56c965d1a966d08   MATCH
```
All five conduits share runtime codehash `0x069efdc9b946a332dce9951324fa197268e3ff0e00e44c6bf36049fc53113a41`
(re-hashed by me), confirming that claim too. So `exists=true` comes from the address having code,
while the controller's owner mapping is empty — hence `NoConduit()`. **The trap and the
`conduitKey != 0` guard advice are both correct and now mechanically explained.**

## V9. NEW — partial fills EMPIRICALLY PROVEN (was UNRESOLVED #3)

The original report inferred partial fills from `orderType == 1` but noted no partial fill had ever
executed. I simulated `fulfillAdvancedOrder` (0xe7acab24) against the **live open order** via
`eth_call` from the buyer EOA (which holds 4,034,849 USDG but has 0 allowance to Seaport):

```
numerator= 21 denominator= 21 -> revert 0x13be252b InsufficientAllowance()   [USDG's own error]
numerator=  1 denominator= 21 -> revert 0x13be252b InsufficientAllowance()
numerator=  2 denominator= 21 -> revert 0x13be252b InsufficientAllowance()
numerator=  3 denominator= 21 -> revert 0x13be252b InsufficientAllowance()
numerator=  1 denominator=  2 -> revert 0xc63cf089 InexactFraction()
```
Reaching the ERC-20 transfer stage means Seaport passed **time, signature, order status and the
orderType/fraction checks**. Specifically it did **not** revert
`PartialFillsNotEnabledForOrder() = 0xa11b63ff`. Three conclusions:

1. **Partial fills are genuinely enabled** on Overcall's live order (1/21, 2/21, 3/21 all validate).
2. **The `InexactFraction` divisibility rule is real and enforced** — 1/2 fails because the offer
   amount 21 × 1 / 2 is not an integer. The keeper guidance in §7 is correct; I also confirmed
   `997500 % 21 == 0` (47,500/contract) and `52500 % 21 == 0` (2,500/contract), and that
   `unitPrice6 % 20 == 0` is exactly the right condition.
3. **The signature stored by the API is valid on-chain** (no `InvalidSigner`/`InvalidSignature`).

## V10. NEW — fee recipient has received exactly one token transfer ever (was UNRESOLVED #6)

The original report only scanned USDG. I ran an **address-unfiltered**, all-history `eth_getLogs` for
`Transfer(address,address,uint256)` with the fee recipient as `to`:

```
ALL Transfer(*, -> 0xdAe7e82A…0782) chain-wide, all history: 1 hits
   token 0x5fc5360d0400a0fd4f2af552add042d716f1d168  blk 61153997  amt 200000
```
**Exactly one, the USDG fee leg.** (Covers ERC-20/ERC-721; ERC-1155 to that address is separately
excluded by the Clear log census in V6.)

## V11. API re-fetched — faithful, including the response envelope

```
GET https://overcall.finance/api/orders               -> HTTP 200 application/json, 1845 bytes
GET https://overcall.finance/api/orders?status=filled -> HTTP 200 application/json, 1859 bytes
OPTIONS /api/orders -> HTTP 204, allow: GET, HEAD, OPTIONS, POST
?chainId=4663 -> works;  ?includeFilled=true -> silently ignored (1 listing, status "open")
```
- Filled listing's `signature` is **byte-identical** to the on-chain calldata signature, and its
  `salt` equals the calldata salt. Confirmed by direct comparison.
- `components` keys are exactly `[conduitKey, consideration, counter, endTime, offer, offerer,
  orderType, salt, startTime, zone, zoneHash]` — **`totalOriginalConsiderationItems` is absent**, as
  reported. The keeper must supply it as `consideration.length`.
- **Minor documentation gap:** the response is wrapped in a top-level object,
  `{"listings":[ … ]}`. `sample-overcall-order.json` stores the listing object flattened, so anyone
  coding against that file will miss the envelope. Noted for R3/keeper.

## V12. CORRECTION — wrong tx hash cited for the traded option's `NewOptionType`

This is the one real error found.

§9 of this report and `sample-overcall-order.json` → `_underlyingOption.source` both cite
`tx 0xb7488de2320a49a2b8408ae82a26f55854f8f6e9b92172f04f02b0a61ae2f6a5` as the `NewOptionType`
transaction for the traded option. **That is a different option.**

```
tx 0xb7488de2… block 60254094 from 0x408adc…1cC0
   newOptionType(NVDA, 1e18, USDG, exerciseAmount=226000000, 1789761600, 1789848000)
   -> created optionId 0xf9e23d199282d4611ff78a93abe9f31de2d43398000000000000000000000000
      (the NVDA $226 strike — NOT the traded one)

tx 0xb068d8355b5376899f82287e8736843ad023372b1f13def32b7c8a7665faf378  block 60254180
   newOptionType(NVDA, 1e18, USDG, exerciseAmount=246000000, 1789761600, 1789848000)
   -> this is the ACTUAL creator of the traded option
      0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54000000000000000000000000
```
The cited **block number (60254180) is correct**; the tx hash is not. Both txs are from the same
creator EOA `0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0`, so the *address* claim and its evidence
line remain valid. Impact: **cosmetic/provenance only** — every option *parameter* reported
(strike 246000000, underlyingAmount 1e18, exerciseTimestamp 1789761600, expiryTimestamp 1789848000,
underlying NVDA, exercise USDG) was re-read by me from the real `NewOptionType` log and is correct.

Corrected `NewOptionType` decode for the traded option (block 60254180):
```
topics[1] exerciseAsset   = 0x5fc5360d0400a0fd4f2af552add042d716f1d168 (USDG)
topics[2] underlyingAsset = 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec (NVDA)
topics[3] expiryTimestamp = 1789848000  (2026-09-19 20:00:00 UTC)
data: optionId 0x7dc3fe3e…0000 | exerciseAmount 246000000 | underlyingAmount 1e18
      exerciseTimestamp 1789761600 (2026-09-18 20:00:00 UTC)
order endTime == exerciseTimestamp -> TRUE ;  == expiryTimestamp -> FALSE
```
**The load-bearing §10 rule — `endTime = exerciseTimestamp`, NOT expiry — is confirmed correct.**

Token-id encoding confirmed: upper 160 bits = optionKey `0x7dc3fe3e6e640b0e22b2e3206a1ff607437e9e54`,
lower 96 bits = 0 (option type, not a claim).

## V13. Ladder claim re-checked (bonus, R1/R4)

The 50 `NewOptionType` events are **10 distinct underlyings × 5 strikes each**, all sharing a single
`exerciseTimestamp 1789761600` and a single `expiryTimestamp 1789848000` — one cycle, as claimed.
Underlying addresses: `0xd0601ce1…`, `0x322f0929…`, `0x4a0e65a3…`, `0x117cc213…`, `0xaf3d76f1…`,
`0x12f190a9…`, `0x020bfc65…`, `0x39dbed3a…`, `0x2e8c3116…`, `0xd7321801…` (5 each).

## V14. Explorer blockage independently reproduced

```
robinhoodchain.blockscout.com/api/v2/…  -> "Just a moment..." (Cloudflare managed challenge)
robinhoodchain.blockscout.com/api?module=contract&action=getabi -> same challenge
robinscan.io/api/v2/…   -> HTTP 404 {"error":"not found"}
hoodscan.co/api/v2/…    -> HTTP 301
stonkscan.io/api/v2/…   -> Next.js HTML shell
```
Confirmed with a full desktop-Chrome User-Agent. **No verified source or ABI obtainable from any
explorer.** The original report's method note is honest and accurate.

## Verification verdict

**CONFIRMED.** The core answer to R2 and R9 is correct and now independently reproduced end-to-end:
order shape (offerer / zone 0 / zoneHash 0 / orderType 1 PARTIAL_OPEN / startTime 0 /
endTime = exerciseTimestamp / random unprefixed salt / **conduitKey = bytes32(0)** /
totalOriginalConsiderationItems 2), the ERC-1155 offer leg, the exact 95/5 USDG consideration split to
`0xdAe7e82A2E7D566C67E87C164B05a1C560190782`, and the direct-to-Seaport approval model. The §10
`AdapterSeaport` guidance is safe to build against.

One correction (V12, a misattributed tx hash — cosmetic). Two former unknowns resolved (V9 partial
fills, V10 fee-recipient token scope) and one mechanically explained (V8 conduit CREATE2 derivation).

### Still genuinely UNRESOLVED after this pass
1. **EIP-1271 / contract-offerer acceptance by Overcall's off-chain API.** Untouched — still the
   single biggest launch risk for R2/R3. Both live makers are EOAs; the API stores a 65-byte
   signature. On-chain, a vault-as-offerer order will fill fine (Seaport falls through to
   `isValidSignature`), but if their indexer does `ecrecover(...) == offerer` the listing is rejected
   before it is ever visible. **Must be settled by an actual POST from a throwaway contract maker.**
   I did not POST (write action, out of scope for read-only recon).
2. **Sample size is two.** One filled + one open order, both orderType 1 / zone 0 / conduitKey 0. A
   future Overcall release could introduce a zone or a conduit; the adapter should read these from
   the fetched order rather than hardcoding them.
3. **Provenance of the code at `0xf9ed144bACaed98d0f3899B8B56c965D1A966D08`.** V8 proves the address
   is the canonical CREATE2 derivation for `salt = 0`, but *who deployed it* is still unknown —
   `createConduit` with a zero key would require `msg.sender == address(0)`. The RPC serves no
   archive state (`eth_getCode` at old blocks → `{"code":-32000,"message":"metadata is not found"}`),
   so the deploying tx could not be located. Genesis/pre-deploy remains the likely explanation.
   Operationally harmless — channels can never be opened on it — provided the `!= 0` guard stays.
4. **No verified Solidity source or ABI from any explorer** (V14). Every ABI element in this document
   is backed by `cast keccak` / `cast sig` against an observed topic0 or 4-byte selector plus a live
   `eth_call`, which is strong but is not the same as verified source. R8 should still chase the
   hoodscan MCP server.
5. **Seaport `validate(Order[])` as an EIP-1271 alternative** — untested against Overcall's API
   (zero `OrderValidated` events on this chain, re-confirmed in V6).
6. **Overcall API POST body shape** — `allow` advertises POST (V11) but the payload schema is
   untested. Belongs to R3.
