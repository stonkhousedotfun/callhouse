# R3 — Overcall listings API

**Status: RESOLVED. NOT a launch blocker.**
There is no maker allowlist, no API key, no account, no handshake. The POST is open to anyone
and the validator explicitly accepts an **ERC-1271 contract offerer**. The only hard constraints
are on-chain facts we control plus one schema detail (signature must be 64 or 65 bytes) that
dictates how we implement `isValidSignature` on the vault.

Recon date: 2026-09-12. All output below was produced by commands actually run.

---

## 1. TL;DR — the exact request the keeper must make

```
POST https://overcall.finance/api/orders?market=NVDA
content-type: application/json
(no auth header of any kind)

{
  "chainId": 4663,
  "components": {
    "offerer":       "0x<vault, EIP-55 checksummed>",
    "zone":          "0x0000000000000000000000000000000000000000",
    "offer": [
      { "itemType": 3,
        "token": "0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
        "identifierOrCriteria": "<optionId, decimal string>",
        "startAmount": "<N>",
        "endAmount":   "<N>" }
    ],
    "consideration": [
      { "itemType": 1,
        "token": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        "identifierOrCriteria": "0",
        "startAmount": "<writer6>",
        "endAmount":   "<writer6>",
        "recipient":   "0x<vault, same as offerer>" },
      { "itemType": 1,
        "token": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        "identifierOrCriteria": "0",
        "startAmount": "<fee6>",
        "endAmount":   "<fee6>",
        "recipient":   "0xdAe7e82A2E7D566C67E87C164B05a1C560190782" }
    ],
    "orderType":  1,
    "startTime":  "0",
    "endTime":    "<registry.exerciseTimestamp(), decimal string>",
    "zoneHash":   "0x0000000000000000000000000000000000000000000000000000000000000000",
    "salt":       "<32 random bytes as decimal string>",
    "conduitKey": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "counter":    "<seaport.getCounter(vault), read live, decimal string>"
  },
  "signature": "0x<130 hex chars (65 bytes) or 128 hex chars (64 bytes, EIP-2098)>"
}
```

Success: **201** `{"listing": {...}}` — read `listing.orderHash`.
Re-POSTing the identical order hash: **200** with the existing row (idempotent — safe keeper retry).
Every error: `{"error": "<human string>"}` with the status codes in §4.

Note there is **no** `optionId` and **no** `maker` field in the body — TECHSPEC §6.3 guessed
`{chainId, order, signature, optionId, maker}`. The real body is `{chainId, components, signature}`;
optionId and maker are derived server-side from `components`. Fix TECHSPEC.

Amounts (all uint as decimal strings):
```
total6            = N * unitPrice6
feePerContract6   = unitPrice6 * 500 / 10000      // integer div, 500 bps = 5%
                    (throws client-side if this rounds to 0 → unitPrice6 must be >= 20)
writerPerContract6= unitPrice6 - feePerContract6
writer6           = writerPerContract6 * N        // consideration[0]
fee6              = feePerContract6   * N         // consideration[1]
```
The fee is rounded **per contract, not on the total** — a total-rounded fee produces an order that
signs and validates but is then unfillable (Seaport `InexactFraction` on a partial fill).

---

## 2. How the endpoint was found

Homepage is Next.js 16 + Turbopack on Railway behind Cloudflare.

```
$ curl -sS -D headers.txt -o index.html https://overcall.finance
HTTP/2 200
x-powered-by: Next.js
x-railway-request-id: fKb9IV5iRk2siLLz2h0iww
server: cloudflare
```

Routes from the homepage: `/buy /write /positions /docs /risk /terms`.
Downloaded all 27 `_next/static/chunks/*.js` referenced by `/`, `/write`, `/buy`, `/positions`, `/docs`
(2.2 MB total, saved under the scratchpad) and grepped:

```
$ grep -ohE '/api/[A-Za-z0-9/_\.\-]*' js/*.js | sort -u
/api/glossary/Errors      <- viem docsPath, not a real route
/api/human                <- abitype docsPath, not a real route
/api/orders
/api/orders/
/api/WagmiProvider        <- wagmi docsPath, not a real route
```

`/api/orders` is the **only** API surface in the whole app. There is no API subdomain, no
OpenAPI/swagger, no `/api/cycle`, no `/api/markets`.

### The client code (chunk `0dj8ov5mmi8e5.js`, offsets 386.8k–388.4k), de-minified by hand

```js
class BookError extends Error { status; constructor(status, msg){...this.name="BookError"} }

async function bookError(res){                       // error envelope
  let t=""; try{ const j=await res.json();
    if (j && typeof j==="object" && "error" in j && typeof j.error==="string") t=j.error;
  }catch{}
  return new BookError(res.status, t);
}

// GET list
async function fetchListings(p){
  const q=new URLSearchParams();
  if(p.optionId!==undefined) q.set("optionId", p.optionId);
  if(p.offerer !==undefined) q.set("offerer",  p.offerer);
  if(p.status  !==undefined) q.set("status",   p.status);
  if(p.limit   !==undefined) q.set("limit",    String(p.limit));
  const res=await fetch(`/api/orders${q.toString()?`?${q}`:""}`,{headers:{accept:"application/json"}});
  if(!res.ok) throw await bookError(res);
  return (await res.json()).listings ?? [];
}

// GET one
async function refreshListing(hash){
  const res=await fetch(`/api/orders/${hash}`,{headers:{accept:"application/json"}});
  if(!res.ok) throw await bookError(res);
  return (await res.json()).listing;
}

// POST  <-- THE ONE WE NEED
usePublishListing = () => useMutation({ mutationFn: async (input) => {
  const { market, ...body } = input;                       // market is stripped out
  const qs = marketQuery(market);                          // -> "market=NVDA"
  const res = await fetch(qs===""?"/api/orders":`/api/orders?${qs}`,{
    method:"POST",
    headers:{"content-type":"application/json"},           // <-- ONLY header. no auth.
    body: JSON.stringify(body)                             // {chainId, components, signature}
  });
  if(!res.ok) throw await bookError(res);
  return (await res.json()).listing;
}})

// DELETE
useRecordCancellation = () => useMutation({ mutationFn: async (hash) => {
  const res=await fetch(`/api/orders/${hash}`,{method:"DELETE"});
  if(!res.ok) throw await bookError(res);
  return (await res.json()).listing;
}})
```

Caller (`07kxbr322x35u.js` @9414, identical copy in `0x_d0xi1_f-zt.js` @11548):

```js
const components = buildListing({offerer,clearinghouse,usdg,optionId,quantity,unitPrice6,
                                 exerciseTimestamp,counter,fee});
const signature  = await signTypedDataAsync({ domain: seaportDomain(chainId),
                                              types: seaportTypes,
                                              primaryType: "OrderComponents",
                                              message: components });
return (await publish.mutateAsync({ chainId, components: componentsToJson(components),
                                    signature, market })).orderHash;
```

`marketQuery` (`0dj8ov5mmi8e5.js` @395490):
```js
MARKET_QUERY_KEY = "market";
marketQuery = (m) => m===undefined ? "" : `market=${encodeURIComponent(m.symbol)}`;
```

`componentsToJson` (@446631) — every uint becomes a decimal string, and
**`totalOriginalConsiderationItems` is NOT sent** (it lives in `OrderParameters`, not `OrderComponents`):
```js
componentsToJson = (o) => ({
  offerer:o.offerer, zone:o.zone,
  offer:o.offer.map(i=>({itemType:i.itemType,token:i.token,
      identifierOrCriteria:i.identifierOrCriteria.toString(),
      startAmount:i.startAmount.toString(), endAmount:i.endAmount.toString()})),
  consideration:o.consideration.map(i=>({...same..., recipient:i.recipient})),
  orderType:o.orderType,
  startTime:o.startTime.toString(), endTime:o.endTime.toString(),
  zoneHash:o.zoneHash, salt:o.salt.toString(),
  conduitKey:o.conduitKey, counter:o.counter.toString()
});
```

---

## 3. The request body schema (zod), lifted verbatim and CONFIRMED against the live server

Module `602787` in `0dj8ov5mmi8e5.js` @441918–447150. This is a shared `web/src/lib/orderbook/`
module — the request-body object is present in the client bundle but unused there, which is what
you expect from a schema that is imported by the route handler. **Confirmed** to be the server's
schema by the probe in §5.

```js
const addr  = z.string().refine(isAddress).transform(getAddress);
const uint  = z.string().regex(/^[0-9]{1,78}$/).transform(BigInt);
const b32   = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s=>s.toLowerCase());
const sig   = z.string().regex(/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/)   // 64 or 65 BYTES ONLY
                        .transform(s=>s.toLowerCase());

const offerItem = z.object({ itemType: z.literal(3 /*ERC1155*/), token: addr,
                             identifierOrCriteria: uint, startAmount: uint, endAmount: uint });

const considItem = z.object({ itemType: z.literal(1 /*ERC20*/), token: addr,
                              identifierOrCriteria: uint.refine(v=>v===0n,
                                 "The ERC-20 consideration item must carry identifier 0."),
                              startAmount: uint, endAmount: uint, recipient: addr });

const components = z.object({
  offerer: addr,
  zone: addr.refine(v => v === ZERO_ADDRESS, "A listing carries no zone."),
  offer: z.array(offerItem).length(1, "A listing offers exactly one item."),
  consideration: z.array(considItem)
      .min(1,"A listing carries at least one consideration item.")
      .max(2,"A listing carries at most two consideration items."),
  orderType: z.literal(1 /*PARTIAL_OPEN*/),
  startTime: uint.refine(v=>v===0n, "Start time must be 0."),
  endTime:   uint,
  zoneHash:  b32.refine(v=>v===ZERO_HASH, "A listing carries no zone hash."),
  salt:      uint,
  conduitKey:b32.refine(v=>v===ZERO_HASH, "A listing uses no conduit."),
  counter:   uint,
})
 .refine(o => o.offer[0].startAmount===o.offer[0].endAmount,
         "A listing is fixed-price: the offered amounts must be equal.")
 .refine(o => o.consideration.every(c=>c.startAmount===c.endAmount),
         "A listing is fixed-price: the premium amounts must be equal.")
 .refine(o => o.consideration[0].recipient === o.offerer,
         "The premium must be paid to the offerer.")
 .refine(o => !o.consideration[1] || o.consideration[1].token === o.consideration[0]?.token,
         "Both consideration items must ask for the same token.")
 .refine(o => !o.consideration[1] || o.consideration[1].startAmount > 0n,
         "A consideration item must carry a non-zero amount.");

// THE POST BODY:
z.object({ chainId: z.number().int().positive(), components, signature: sig });
```

### >>> The one constraint that shapes our contract <<<
`signature` must match `/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/` — **exactly 64 or 65 bytes**.
An arbitrary-length EIP-1271 blob (a multisig bundle, an ERC-6492 wrapper, an ABI-encoded struct)
is rejected at the schema before any on-chain check.

Therefore the vault's `isValidSignature(bytes32 hash, bytes signature)` **must accept a plain
65-byte `(r,s,v)` ECDSA signature** (or a 64-byte EIP-2098 compact one) and return `0x1626ba7e`.
Concretely: `ECDSA.recover(hash, signature)` and check the recovered address holds `KEEPER_ROLE`
(or equals a stored `listingSigner`). `hash` arrives as the **final EIP-712 digest**
(`keccak256(0x1901 ‖ domainSeparator ‖ orderHash)`), so do not re-hash it.
This is compatible with Seaport 1.6's own path: Seaport tries ecrecover first, sees
`recovered != offerer`, and falls back to `offerer.isValidSignature(digest, originalSignature)`
with the same 65 bytes.

This is a design constraint, not a blocker. Do not design the vault to expect a custom
signature envelope.

---

## 4. Server-side validation order (primary source: Overcall's own docs)

From <https://overcall.finance/docs/protocol/premium-market>, section "POST — validation, in order".
The docs reference their private repo at `web/src/lib/orderbook/validate.ts`.

| # | Check | Failure |
|---|---|---|
| 0 | zod schema of §3 | 400 |
| 1 | `chainId` is 4663 or 46630 **and matches the server's** | 400 |
| 2 | offer token is the clearinghouse, consideration token is USDG | 422 |
| 3 | `registry.isApproved(optionId)` **and the cycle is live** | 422 |
| 4 | the option id exists, `endTime == option.exerciseTimestamp`, still in the future | 422 |
| 5 | `1 <= N <= 2^112-1`; `unitPrice6 >= 1`; `P` an exact multiple of `N`; `unitPrice6 <= exerciseAmount` | 422 |
| 6 | `counter == seaport.getCounter(offerer)`, read live | 409 |
| 7 | locally derived order hash == `seaport.getOrderHash` | 500 |
| 8 | **the signature verifies for offerer (EOA or ERC-1271)** | 401 |
| 9 | `balanceOf(offerer, optionId) >= N` and `isApprovedForAll(offerer, SEAPORT)` | 422 |
| 10 | Seaport reports the order neither cancelled nor already filled | 409 |
| 11 | **at most 20 open listings per writer per chain; a per-IP token bucket on POST** | 429 |
| 12 | insert | 201 |

Direct quotes worth pinning:

> "8 | the signature verifies for offerer (**EOA or ERC-1271**) | 401"

> "11 | at most 20 open listings per writer per chain; a per-IP token bucket on POST | 429"

> "A replay of an identical order hash returns 200 with the existing row rather than an error —
> posting the same signed order twice is idempotent."

> "Check 5's price ceiling is worth naming: a premium above the strike is a typing mistake, not a listing."

> "The validator recomputes the split rather than trusting it, and rejects a missing fee item, a wrong
> recipient, a wrong amount, a writer's item that does not reconcile, and a fee item when none is configured."

> "The fee is rounded per contract rather than on the total, because Seaport scales every consideration
> item by the fill fraction and reverts InexactFraction unless each amount divides evenly — a
> total-rounded fee produces a listing that signs, validates, and is then unfillable."

From `/docs/faq`:
> "The clearinghouse itself is permissionless and will accept a write on any option type anyone creates,
> but an off-grid id is never displayed and **the book refuses listings on it**."

> "The book API will not delete an order on request, because a hidden fillable order is worse than a
> visible one."

Storage/freshness (docs, "The listings API"):
> "Route handlers, in the repository at `web/src/app/api/orders/`, backed by Postgres through Drizzle
> (Neon over HTTP in production, PGlite locally and in tests). No response is cached at the edge
> (`export const dynamic = 'force-dynamic'` on every route), and any row last read more than 30 s ago
> is re-synced against the chain as part of serving it (`SYNC_MAX_AGE_MS = 30_000`)."

Lazy sync multicall: `getOrderStatus(hash)`, `getCounter(offerer)`, `balanceOf(offerer, optionId)`,
`isApprovedForAll(offerer, SEAPORT)`. Status machine:
`open -> cancelled | filled | expired | unfillable`, and `unfillable -> open` recovers on its own.

---

## 5. Live read-only probes actually run (5 GET/OPTIONS, 1 malformed POST — no fake order posted)

### 5.1 GET the book — no auth, works anonymously
```
$ curl -sS -D - -H 'accept: application/json' 'https://overcall.finance/api/orders?market=NVDA'
HTTP/2 200
content-type: application/json
x-railway-request-id: hppkYaNZRxONR77H9o6EoQ

{"listings":[]}
```
(Book is empty right now — this cycle's listings are all filled or the writers have not listed yet.)

### 5.2 OPTIONS — allowed methods, and NO CORS
```
$ curl -sS -D - -o /dev/null -X OPTIONS 'https://overcall.finance/api/orders'
HTTP/2 204
allow: GET, HEAD, OPTIONS, POST
```
```
$ curl -sS -D - -o /dev/null -X OPTIONS \
    -H 'Origin: https://callhouse.example' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    'https://overcall.finance/api/orders' | grep -iE 'HTTP|allow|access-control'
HTTP/2 204
allow: GET, HEAD, OPTIONS, POST
```
**No `Access-Control-Allow-Origin` is returned.** A browser on our domain cannot call this endpoint
directly. Our keeper is server-side so it is unaffected, and TECHSPEC's `POST /v1/overcall/list`
(keeper-only, server-side forward) is the right shape. Do not try to POST from our web app's browser code.

### 5.3 A real reference order — filled, from an EOA (also answers R2 and R9)
```
$ curl -sS -H 'accept: application/json' 'https://overcall.finance/api/orders?status=filled&limit=3'
{"listings":[{
 "orderHash":"0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522",
 "chainId":4663,
 "offerer":"0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be",
 "optionId":"56885395977254369119998982131173877604217583767740146085872832926902011297792",
 "quantity":"1","remaining":"0",
 "unitPrice6":"4000000","totalPrice6":"4000000","realisedPremium6":"3800000",
 "startTime":"0","endTime":"1789761600",
 "salt":"95941992777576660739888578361827826050802484697670100586800480598437555708740",
 "counter":"0","status":"filled","filledNumerator":"1","filledDenominator":"1",
 "components":{
   "salt":"95941992777576660739888578361827826050802484697670100586800480598437555708740",
   "zone":"0x0000000000000000000000000000000000000000",
   "offer":[{"token":"0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0","itemType":3,
             "endAmount":"1","startAmount":"1",
             "identifierOrCriteria":"56885395977254369119998982131173877604217583767740146085872832926902011297792"}],
   "counter":"0","endTime":"1789761600",
   "offerer":"0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be",
   "zoneHash":"0x0000000000000000000000000000000000000000000000000000000000000000",
   "orderType":1,"startTime":"0",
   "conduitKey":"0x0000000000000000000000000000000000000000000000000000000000000000",
   "consideration":[
     {"token":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168","itemType":1,"endAmount":"3800000",
      "recipient":"0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be","startAmount":"3800000",
      "identifierOrCriteria":"0"},
     {"token":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168","itemType":1,"endAmount":"200000",
      "recipient":"0xdAe7e82A2E7D566C67E87C164B05a1C560190782","startAmount":"200000",
      "identifierOrCriteria":"0"}]},
 "signature":"0x110031b6ee7194d2f32d90a12bde37ea048c81c4094da7207a25edadb4c081ec35ae8045cafac3191fbc3c0be75eba15c62fccabf9f72508318f528f51ab56b01b",
 "createdAt":"2026-09-11T13:48:12.611Z","checkedAt":"2026-09-12T18:08:53.266Z"}]}
```
Signature is 132 chars = 65 bytes → EOA. `4000000` premium → `3800000` writer + `200000` fee = exactly 5%.

```
$ curl ... eth_getCode 0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be
0 bytes     <- EOA writer, as expected
```

### 5.4 GET one listing
```
$ curl -sS -H 'accept: application/json' \
  'https://overcall.finance/api/orders/0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522'
{"listing":{ ...same object as above, checkedAt refreshed to 2026-09-12T18:11:30.905Z... }}
```

### 5.5 Error envelope
```
$ curl -sS -w 'HTTP %{http_code}\n' -H 'accept: application/json' \
   'https://overcall.finance/api/orders?status=all'
HTTP 400
{"error":"One of the query parameters is not valid."}
```
(`status=all` is only legal together with `offerer` — see docs. `status=filled` unscoped is fine.)

### 5.6 THE AUTH TEST — one malformed POST, no order created
```
$ curl -sS -D - -H 'content-type: application/json' -X POST --data '{}' \
   'https://overcall.finance/api/orders?market=NVDA'
HTTP/2 400
content-type: application/json
x-railway-request-id: EbYrC_PrT8OqalKRljLL4A

{"error":"Invalid input: expected number, received undefined (at chainId)"}
```
Two things proven by this one request:

1. **There is no auth gate in front of the validator.** An unknown, unregistered, credential-less
   caller gets 400 (schema) — not 401, not 403, not "unknown maker". There is nothing to be
   allowlisted into.
2. The server's schema **is** the zod object recovered from the bundle in §3 — the error string is
   zod's own message for `chainId: z.number().int().positive()` on the exact key name, in the exact
   object, at the first issue. That transitively confirms the `signature` regex is server-enforced.

No fake order was ever posted.

---

## 6. Would our vault (a contract offerer using EIP-1271) be accepted?

**Yes.** Evidence, strongest first:

1. Overcall's own protocol docs state the check verbatim: *"8 | the signature verifies for offerer
   (**EOA or ERC-1271**) | 401"* — <https://overcall.finance/docs/protocol/premium-market>.
2. The zod schema (§3) has **no** offerer allowlist, no `EOA-only` refinement, no `code.length == 0`
   check. `offerer` is just `addr` = "valid address, checksummed".
3. The 400 in §5.6 shows the route reaches the schema with no prior identity gate.
4. Overcall's ERC-1271 ABI and viem's `verifyHash`/1271 fallback (`isValidSignature` →
   `0x1626ba7e`) are in the shipped bundle (`2lfphdkvxy21b.js` @327267 and @328216), i.e. their
   viem version is one that does the 1271 fallback.
5. Their FAQ: *"The contracts themselves are permissionless and have no allowlist"*. The API's only
   per-writer limit is the 20-open-listing cap, which is quantitative and applies to everyone.

**What we must get right on our side for check 8 and check 9 to pass:**

- `Vault.isValidSignature(bytes32 digest, bytes sig)` returns `0x1626ba7e` for a **65-byte** (or
  64-byte EIP-2098) ECDSA signature produced by the keeper key over the Seaport digest. Nothing longer.
- `ValoremOptionsClearinghouse.setApprovalForAll(0x0000000000000068F116a894984e2DB1123eB395, true)`
  called **by the vault**, once. (This is exactly what Overcall's "Allow the book" button does:
  `useSetApprovalForAll().approveSeaport = () => setApprovalForAll(contracts.seaport, true)`,
  `07kxbr322x35u.js` @5807.) Without it check 9 returns 422 and, later, the listing row flips to
  `unfillable` with the UI copy *"suspended — tokens missing or book not allowed"*.
- The vault must hold `>= N` of the option ERC-1155 at POST time (check 9).
- `consideration[0].recipient == offerer` — so USDG lands **in the vault**, which is what we want.
- Vault must implement `onERC1155Received` / `onERC1155BatchReceived` (Valorem's `write` uses a safe
  mint; their copy: *"Your wallet must accept ERC-1155 tokens … to write"*).

**Residual risk (small, and testable before launch):** check 8's implementation is not visible to us.
If it is `recoverTypedDataAddress(...) === offerer` with no 1271 fallback, a contract offerer would get
401 "The book refused the signature." The docs say otherwise and the 1271 code path is in their
dependency tree, but the cheap, non-destructive way to settle it is:
**post one real 1-contract listing from the vault on testnet 46630** (registry
`0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56`, clearinghouse `0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc`,
mock USDG `0xe3B032b565d494A994772AEFF9919CC9AC574bEF`, `chainId: 46630`) during M3. That is a real
listing on a testnet book, not a fake order on mainnet. Do that before M7.

---

## 7. Auth / rate limits / operational notes

- **Auth: none.** No API key, no bearer, no SIWE, no nonce, no captcha/Turnstile, no cookie.
  The only header the client sends on POST is `content-type: application/json`.
  (`grep` for `authorization`, `x-api-key`, `siwe`, `turnstile` across all 27 chunks: no hits.)
- **Rate limit:** "a per-IP token bucket on POST" → 429. Keeper should back off on 429 and must not
  hammer. Our cycle needs at most 1–3 POSTs a week, so this is not a constraint — but the keeper
  must run from a stable IP and not share it with retries-in-a-loop.
- **Listing cap:** 20 open listings per writer per chain (429). TECHSPEC §4.7 already caps us at 3
  signed listings per cycle — fine.
- **No CORS.** Server-to-server only.
- **Cancellation:** `DELETE /api/orders/{hash}` does **not** delete. It forces a chain re-read and
  returns 409 + the row if Seaport still considers the order live. To actually kill a listing:
  `seaport.cancel([orderComponents])` (offerer-only) or `seaport.incrementCounter()`. Note Seaport
  1.2+ bumps the counter by a quasi-random amount — always read `getCounter` live before signing.
  UI copy for this: `counterMoved: "Your listings were all cancelled in the meantime. Sign again."`
- **Freshness:** rows older than 30 s are re-synced on read, so the keeper can verify a listing
  landed with `GET /api/orders?offerer=<vault>&status=open` ~30 s after POST. This is the alert hook
  for TECHSPEC §5.5 "listing not visible after 15 min".

### Listing object fields returned by the API
`orderHash, chainId, offerer, optionId, quantity, remaining, unitPrice6, totalPrice6,
realisedPremium6, startTime, endTime, salt, counter, status, filledNumerator, filledDenominator,
components{...}, signature, createdAt, checkedAt`

`status` values (from `statusCopy.listing`, `2lfphdkvxy21b.js` @506676):
`open, partial, filled, cancelled, expired, unfillable`. Query also accepts `status=all`
(requires `offerer`).

`realisedPremium6` is the **writer's net** leg, not the buyer's gross. In the live sample:
`totalPrice6 = 4000000`, fill = 1/1, yet `realisedPremium6 = 3800000` — exactly `consideration[0]`,
i.e. gross minus the 5% fee. Note this **contradicts the docs**, which state the formula as
`total_price6 x filled_numerator / filled_denominator` (that would be `4000000`). The implementation
is the one that matters and it returns net. Either way: do NAV math off the USDG that actually lands
in the vault, per README — never off an API field.

---

## 8. Supporting on-chain confirmations (all run against https://rpc.mainnet.chain.robinhood.com)

```
$ cast call 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA "activeOptionIds()(uint256[])" --rpc-url $RPC
[113025628429828481228850936737953628080486640605422851339090182744894714413056,
 29652592033419692000166847561911668028189801263392568326594311383797020491776,
 13956151908388063551378518883460877979717043668997816139085862263440384458752,
 8012928620938394388054169085135774622795258770514699139381494411582911807488,
 56885395977254369119998982131173877604217583767740146085872832926902011297792]

$ cast call 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA "isApproved(uint256)(bool)" \
    56885395977254369119998982131173877604217583767740146085872832926902011297792 --rpc-url $RPC
true
$ cast call ... "isCycleLive()(bool)"        -> true
$ cast call ... "isWritingOpen()(bool)"      -> true
$ cast call ... "exerciseTimestamp()(uint40)"-> 1789761600
$ cast call ... "collateralToken()(address)" -> 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
$ cast call ... "exerciseToken()(address)"   -> 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168

$ eth_getCode 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA  -> 5905 bytes (OvercallRegistry, NVDA)
$ eth_getCode 0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be  -> 0 bytes (EOA writer)
$ eth_getCode 0x00000000F9490004C11Cef243f5400493c00Ad63  -> 8820 bytes (Seaport conduit controller)
$ eth_getCode 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15  -> 9571 bytes (Chainlink RHNVDA/USD)
```

On testnet 46630 (https://rpc.testnet.chain.robinhood.com/rpc):
```
$ eth_getCode 0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56 -> 5905 bytes  (OvercallRegistry NVDA;
                                                            byte-identical size to mainnet's)
$ eth_getCode 0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc -> 16110 bytes (ValoremOptionsClearinghouse;
                                                            same size as mainnet's 16110)
$ eth_getCode 0xe3B032b565d494A994772AEFF9919CC9AC574bEF -> 1862 bytes  (mock USDG)
```

The filled reference order's `endTime` (1789761600) equals `registry.exerciseTimestamp()` exactly —
confirms check 4 and confirms the keeper must read `endTime` from the registry, never from a clock.

### Addresses recovered from the app's address book (`549344` in `2e7jvfnd-wkxs.js` / `13i994ge4sv4e.js`)
Cross-checked against <https://overcall.finance/docs/protocol/contracts>.

| 4663 | address |
|---|---|
| ValoremOptionsClearinghouse | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| Conduit controller (unused) | `0x00000000F9490004C11Cef243f5400493c00Ad63` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| NVDA stock token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| Stock implementation (shared, behind beacon) | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` |
| **OvercallRegistry NVDA** | `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA` |
| Registry TSLA / GME / SPCX / SPY / AAPL / AMZN | `0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1` / `0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335` / `0x915148f98C0450251261654ffb6B54BA7005efFF` / `0x6369CeCe2de602Ce1911039C123dc97E816715A9` / `0xB500929deb0100598D9A1392113a6F6D2A31C018` / `0x195dcf905Ad9fDda76E492016E680B2D0F9F0877` |
| Registry owner | `0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` |
| **Overcall fee recipient (`feeTo`)** | `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` (EOA) |
| Chainlink RHNVDA/USD | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` |
| Chainlink USDG/USD | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` |
| Sequencer uptime feed | `0x0000000000000000000000000000000000000000` (none exists) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| TokenURIGenerator | `0xE53cCB924d27f421a91b59087587fD866C5d64c7` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| lotSize | `1000000000000000000` on every market |

| 46630 (testnet) | address |
|---|---|
| clearinghouse | `0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc` |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| mock USDG | `0xe3B032b565d494A994772AEFF9919CC9AC574bEF` |
| mock NVDA | `0x40ab39E8E1D626fa506CCDF917697975a102D1D7` |
| **registry NVDA** | `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56` |
| feeTo (testnet deployer, throwaway) | `0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82` |
| faucet | https://faucet.testnet.chain.robinhood.com |

**R7 is answered in passing: yes, the Overcall registry exists on testnet 46630**, with 10 markets
(`AAPL AMZN CATTEST GME MEME NVDA PLTR SPCX SPY TSLA`).

### Fee config, lifted from the bundle (`07kxbr322x35u.js` @6100–8300)
```js
const DEFAULT_BPS = 500n;   // NEXT_PUBLIC_FEE_BPS = "500"  (inlined at build time)
const BPS_CEILING = 1000n;
const TESTNET_DEPLOYER = "0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82";
feeRecipient = "0xdAe7e82A2E7D566C67E87C164B05a1C560190782";  // NEXT_PUBLIC_FEE_RECIPIENT, inlined
// hard guard: on chain 4663, recipient === TESTNET_DEPLOYER throws FeeConfigError
resolveFee(chainId) -> { bps: 500n, recipient: "0xdAe7e82A2E7D566C67E87C164B05a1C560190782" }
```
If `bps` were ever 0 the order would carry **one** consideration item and the validator would reject a
fee item. The keeper must derive the fee from the live reference order shape, not hardcode "always 2 items".

### Seaport typed-data constants (`995078` in `0dj8ov5mmi8e5.js` @447164)
```js
SEAPORT_PRIMARY_TYPE = "OrderComponents"
seaportDomain = (chainId) => ({ name:"Seaport", version:"1.6", chainId,
                                verifyingContract:"0x0000000000000068F116a894984e2DB1123eB395" })
seaportTypes = { OrderComponents:[offerer address, zone address, offer OfferItem[],
                                  consideration ConsiderationItem[], orderType uint8,
                                  startTime uint256, endTime uint256, zoneHash bytes32,
                                  salt uint256, conduitKey bytes32, counter uint256],
                 OfferItem:[itemType uint8, token address, identifierOrCriteria uint256,
                            startAmount uint256, endAmount uint256],
                 ConsiderationItem:[itemType uint8, token address, identifierOrCriteria uint256,
                                    startAmount uint256, endAmount uint256, recipient address] }
ItemType  = {NATIVE:0, ERC20:1, ERC721:2, ERC1155:3, ERC721_WITH_CRITERIA:4, ERC1155_WITH_CRITERIA:5}
OrderType = {FULL_OPEN:0, PARTIAL_OPEN:1, FULL_RESTRICTED:2, PARTIAL_RESTRICTED:3, CONTRACT:4}
```

### `buildListing`, lifted verbatim (`278829` in `0dj8ov5mmi8e5.js` @441918)
```js
salt = BigInt of 32 crypto-random bytes         // NOT a Seaport "prefix" salt; plain random
if (N < 1n || N > (1n<<112n)-1n) throw "Quantity must be between 1 and 2^112 - 1 contracts."
if (unitPrice6 < 1n)             throw "Premium must be at least 1 USDG unit per contract."
if (exerciseTimestamp <= 0n)     throw "End time must be the option exercise timestamp."
feePerContract6 = fee ? unitPrice6 * fee.bps / 10000n : 0n
if (fee && feePerContract6 <= 0n) throw "This premium is too small to carry the protocol fee."
writerPerContract6 = unitPrice6 - feePerContract6
consideration = [ {ERC20, usdg, 0, writerPerContract6*N, writerPerContract6*N, offerer} ]
if (fee && feePerContract6*N > 0n)
  consideration.push({ERC20, usdg, 0, feePerContract6*N, feePerContract6*N, fee.recipient})
return { offerer, zone:0x0, offer:[{ERC1155, clearinghouse, optionId, N, N}], consideration,
         orderType:1, startTime:0n, endTime:exerciseTimestamp, zoneHash:0x0…0,
         salt, conduitKey:0x0…0, counter }
```

---

## 9. Fallback (self-hosted order page) — what it must contain

We do **not** need this as a launch gate any more, but build it anyway as the censorship/downtime
hedge (TECHSPEC §12 "Listing API censorship / downtime"). On `/vault/nvda/cycle`, for each live listing:

1. The full `OrderParameters` — i.e. our `components` **plus `totalOriginalConsiderationItems`**
   (`= consideration.length`, 2 while the fee is on). `counter` is dropped; it is not in `OrderParameters`.
2. The `signature` (the same 65-byte blob we POSTed).
3. `orderHash`, `optionId`, strike, `quantity`, `remaining`, `unitPrice6`, `totalPrice6`, `endTime`.
4. A one-click "Buy" that: `USDG.approve(SEAPORT, k * unitPrice6)` then
   `seaport.fulfillAdvancedOrder({parameters, numerator:k, denominator:N, signature, extraData:"0x"},
   [], bytes32(0), address(0))`. `fulfillOrder(order, bytes32(0))` takes the whole remainder.
5. A raw JSON copy button so any buyer can fill from their own tooling.
6. Live status read from Seaport `getOrderStatus(orderHash)` so the page cannot show a dead order.

Nothing about this requires Overcall's cooperation — a signed Seaport order is public and fillable
by anyone holding a copy, which Overcall's own FAQ states.

---

## UNRESOLVED

1. **Check 8's exact implementation is not observable.** The docs say "EOA or ERC-1271" and the
   1271 code path exists in their dependency tree, but I did not see `web/src/lib/orderbook/validate.ts`
   (private repo) and I did not POST a real contract-offerer order. Settle it with one real 1-contract
   listing from the vault on **testnet 46630** during M3, before M7. Until that passes, treat
   "1271 accepted" as high-confidence-but-untested.
2. **Is the `?market=` query param required on POST, or does the server default it?** The client
   always sends it when a market is selected and sends none when `market` is undefined. I did not
   determine whether the server falls back to the default market or 400s. Mitigation: always send
   `?market=NVDA`. (Zero cost, removes the question.)
3. **The per-IP token bucket's numbers** (capacity / refill rate) are not published. Unknown whether
   a shared-IP cloud keeper could trip it. Mitigation: dedicated egress IP, exponential backoff on 429.
4. **Whether `status` accepts every value in `statusCopy`** (`partial`, `cancelled`, `expired`,
   `unfillable`) on the GET. I confirmed `open` (default), `filled`, and that `all` requires `offerer`.
   Did not enumerate the rest — did not want to spam the endpoint.
5. **No public repo, no OpenAPI, no docs subdomain.** `github.com/valorem-labs-inc/clear` is the only
   GitHub link anywhere on the site (the settlement engine, not Overcall's app). Overcall's own
   `web/` and `contracts/` repos are private; `/docs` is the only spec. Searched all 27 JS chunks and
   every docs page.
6. **No contact channel found for a handshake** other than <https://x.com/overcallfi>. No email, no
   Discord, no Telegram on the site. Not needed given §6, but if we ever want one (e.g. to be listed
   as a known vault), X is the only door.
7. **`realisedPremium6` does not match Overcall's own documented formula.** The docs say
   `total_price6 x filled_numerator / filled_denominator` (= 4000000 on the sample, a 1/1 fill of a
   4000000 listing). The API returned `3800000`, which is the writer's post-fee leg. One sample, one
   market, one full fill — I did not test a partial fill, and could not, since the book is empty.
   Unresolved whether a partial fill scales the net leg or the gross. Do not build NAV on this field;
   read the USDG transfer. Hand this to whoever owns the indexer (R2 / Phase 3).

---

# Verification pass

**Adversarial re-verification, 2026-09-12, independent agent.**
Every check below was re-run from scratch. I did not reuse any number from the report above.

**Verdict: PARTIAL.** The core answer is right and is now proven much harder than the report proved it —
there is no auth and no maker allowlist, and I demonstrated that by getting a *brand-new, never-seen
throwaway EOA* all the way through the signature check on a genuinely signed order. But six specific
claims are wrong or overstated, one of them (the 64-byte signature claim) directly contradicted by
experiment and directly relevant to the vault's `isValidSignature`.

## V0. What I confirmed independently

### Every address: re-`eth_getCode`d, byte counts identical

```
$ python3 code.py     # raw eth_getCode via JSON-RPC, mainnet + testnet
=== chain main 0x1237
ValoremClearinghouse     0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 bytes=16110
Seaport1.6               0x0000000000000068F116a894984e2DB1123eB395 bytes=23981
ConduitController        0x00000000F9490004C11Cef243f5400493c00Ad63 bytes=8820
USDG                     0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 bytes=170
NVDAStockToken           0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC bytes=283
StockImpl                0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2 bytes=11614
RegistryNVDA             0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA bytes=5905
RegistryTSLA             0x66992dD28FB5267b5D817BF7d8D121E3787C5Ae1 bytes=5905
RegistryGME              0xbDc50c663F33Cd6913Ce5598Ad23291046AA0335 bytes=5905
RegistrySPCX             0x915148f98C0450251261654ffb6B54BA7005efFF bytes=5905
RegistrySPY              0x6369CeCe2de602Ce1911039C123dc97E816715A9 bytes=5905
RegistryAAPL             0xB500929deb0100598D9A1392113a6F6D2A31C018 bytes=5905
RegistryAMZN             0x195dcf905Ad9fDda76E492016E680B2D0F9F0877 bytes=5905
RegistryOwner            0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0 bytes=0
FeeRecipient             0xdAe7e82A2E7D566C67E87C164B05a1C560190782 bytes=0
ChainlinkRHNVDA          0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 bytes=9571
ChainlinkUSDG            0x61B7e5650328764B076A108EFF5fa7282a1B9aD2 bytes=9571
Multicall3               0xcA11bde05977b3631167028862bE2a173976CA11 bytes=3808
TokenURIGenerator        0xE53cCB924d27f421a91b59087587fD866C5d64c7 bytes=9901
WETH                     0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 bytes=2202
RefOfferer_EOA           0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be bytes=0
=== chain test 0xb626
t_clearinghouse          0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc bytes=16110
t_Seaport                0x0000000000000068F116a894984e2DB1123eB395 bytes=23981
t_mockUSDG               0xe3B032b565d494A994772AEFF9919CC9AC574bEF bytes=1862
t_mockNVDA               0x40ab39E8E1D626fa506CCDF917697975a102D1D7 bytes=3778
t_registryNVDA           0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56 bytes=5905
t_feeTo                  0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82 bytes=0
```

Every byte count matches the report exactly. No claimed contract turned out to be an EOA; no claimed
EOA turned out to be a contract. `eth_chainId` was checked on each endpoint before the reads
(`0x1237` = 4663, `0xb626` = 46630), so no mainnet-Ethereum / chain-4663 confusion.

### Every claimed selector: recomputed with `cast sig`, then found in the deployed bytecode

All 27 registry selectors are present in the 5905-byte OvercallRegistry runtime. None was copied from
an upstream repo without being deployed.

```
YES b1e4ff8b activeOptionIds()        YES 4645ce49 strikePerContract(uint256)
YES 7910867b isApproved(uint256)      YES 9e9add41 canReplaceCycle()
YES 1e4191ea isCycleLive()            YES b8f07dea MAX_STRIKES()
YES fa85ba38 isWritingOpen()          YES 04b86272 MIN_EXERCISE_WINDOW()
YES 7d4361bf exerciseTimestamp()      YES 819868cb setCycle(uint256[],uint40,uint40)
YES ade6e2aa expiryTimestamp()        YES a3ab1061 setLotSize(uint96)
YES e136de20 writeDeadline()          YES 8da5cb5b owner()
YES b2016bd4 collateralToken()        YES e30c3978 pendingOwner()
YES 2e4d8c8f exerciseToken()          YES f2fde38b transferOwnership(address)
YES 5d4f5f97 clearinghouse()          YES 79ba5097 acceptOwnership()
YES 4942f65f lotSize()                YES 715018a6 renounceOwnership()
YES efdbdcdc cycleLotSize()           YES 6190c9d5 cycle()
YES 2f884710 cycleNumber()
YES 316fda0f cycleCount()
YES 356944c4 cycleOf(uint256)
```

On the clearinghouse: `a22cb465 setApprovalForAll` YES, `e985e9c5 isApprovedForAll` YES,
`f23a6e61 onERC1155Received` YES. `00fdd58e balanceOf(address,uint256)` does **not** appear as a
literal 4-byte string — it is pushed as `PUSH3 0xfdd58e` (`62fdd58e`, leading zero byte trimmed by the
optimiser). A live `eth_call` returns a real balance, so the function is there; noting it so nobody
"discovers" a missing `balanceOf` later.

### Every claimed registry value: re-`eth_call`ed, none reverted

```
activeOptionIds()      -> 113025628429828481228850936737953628080486640605422851339090182744894714413056
                          29652592033419692000166847561911668028189801263392568326594311383797020491776
                          13956151908388063551378518883460877979717043668997816139085862263440384458752
                           8012928620938394388054169085135774622795258770514699139381494411582911807488
                          56885395977254369119998982131173877604217583767740146085872832926902011297792
isCycleLive()          -> true            isWritingOpen()  -> true
exerciseTimestamp()    -> 1789761600      expiryTimestamp()-> 1789848000
writeDeadline()        -> 1789761600      lotSize()        -> 1000000000000000000
cycleLotSize()         -> 1000000000000000000   cycleNumber()-> 1   cycleCount() -> 1
canReplaceCycle()      -> false           MAX_STRIKES()    -> 5
MIN_EXERCISE_WINDOW()  -> 86400 (24h)
collateralToken()      -> 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec
exerciseToken()        -> 0x5fc5360d0400a0fd4f2af552add042d716f1d168
clearinghouse()        -> 0x9a7b40e5c1db1af822ef091c990b58b02c78c0c0
owner()                -> 0x408adcffebdf48ec23f1e3811a91aed3cc951cc0
pendingOwner()         -> 0x0000000000000000000000000000000000000000
isApproved(56885…7792) -> true
cycleOf(56885…7792)    -> 1
strikePerContract(56885…7792) -> 246000000    (246.000000 USDG per contract)
```

Byte-identical option-id list to the report. `strikePerContract` is new and confirms check 5's ceiling
(the "premium cannot exceed the strike" rejection below fires at exactly this number).

### The order shape is now proven cryptographically, not just quoted

I recomputed the Seaport 1.6 EIP-712 `OrderComponents` hash locally from the API's own `components`
and compared three ways:

```
$ python3 eip712.py
OrderComponents typehash fa445660b7e21515a59617fcd68910b487aa5808b8abda3d78bc85df364b2c2f
local orderHash   0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522
API   orderHash   0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522
MATCH
domainSeparator   0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0
digest            0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150
sig bytes 65
ecrecover -> 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
offerer   -> 0xe73d7021a3ef2808c3dd8237982fcc5fa11275be
SIG MATCH
```

and cross-checked the domain separator against Seaport's own on-chain `information()`:

```
$ eth_call 0x0000000000000068F116a894984e2DB1123eB395 0xf47b7740   # information()
domainSeparator   0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0   <- identical
conduitController 0x00000000f9490004c11cef243f5400493c00ad63
version           "1.6"
```

This single result pins, from the chain: Seaport **1.6**; `verifyingContract`
`0x0000000000000068F116a894984e2DB1123eB395`; `chainId 4663`; domain `name:"Seaport", version:"1.6"`;
the exact `OrderComponents` / `OfferItem` / `ConsiderationItem` field order; and that the stored
65-byte blob is a **plain ECDSA signature over the final EIP-712 digest** (`ecrecover` → offerer).
The conduit controller address is confirmed **from Seaport itself**, not from Overcall's docs.

```
$ eth_call SEAPORT getOrderStatus(0xa11edb…e522)  -> isValidated=true isCancelled=false
                                                     totalFilled=1 totalSize=1
$ eth_call SEAPORT getCounter(0xE73d…75be)        -> 0     (matches components.counter)
```

### The zod schema really is the server's — 20 refinements reproduced verbatim

Every one of these is a live `POST` that failed at the schema and therefore made no chain call and
inserted nothing.

```
[400] empty object                    {"error":"Invalid input: expected number, received undefined (at chainId)"}
[400] chainId only                    {"error":"Invalid input: expected object, received undefined (at components)"}
[400] sig 66 bytes                    {"error":"Not a valid signature. (at signature)"}
[400] sig 63 bytes                    {"error":"Not a valid signature. (at signature)"}
[400] nonzero zone                    {"error":"A listing carries no zone. (at components.zone)"}
[400] orderType 0                     {"error":"Invalid input: expected 1 (at components.orderType)"}
[400] startTime 1                     {"error":"Start time must be 0. (at components.startTime)"}
[400] nonzero conduitKey              {"error":"A listing uses no conduit. (at components.conduitKey)"}
[400] nonzero zoneHash                {"error":"A listing carries no zone hash. (at components.zoneHash)"}
[400] recipient != offerer            {"error":"The premium must be paid to the offerer. (at components)"}
[400] 3 consideration items           {"error":"A listing carries at most two consideration items. (at components.consideration)"}
[400] 0 consideration items           {"error":"A listing carries at least one consideration item. (at components.consideration)"}
[400] 2 offer items                   {"error":"A listing offers exactly one item. (at components.offer)"}
[400] offer itemType 2                {"error":"Invalid input: expected 3 (at components.offer.0.itemType)"}
[400] consid itemType 0               {"error":"Invalid input: expected 1 (at components.consideration.0.itemType)"}
[400] consid identifier !=0           {"error":"The ERC-20 consideration item must carry identifier 0. (at components.consideration.0.identifierOrCriteria)"}
[400] start!=end on offer             {"error":"A listing is fixed-price: the offered amounts must be equal. (at components)"}
[400] start!=end on consid            {"error":"A listing is fixed-price: the premium amounts must be equal. (at components)"}
[400] consid[1] diff token            {"error":"Both consideration items must ask for the same token. (at components)"}
[400] consid[1] zero amount           {"error":"A consideration item must carry a non-zero amount. (at components)"}
[400] uint as number not string       {"error":"Invalid input: expected string, received number (at components.counter)"}
```

The recovered schema in §3 above is exact. An uppercase-hex signature is accepted (the regex is
`[0-9a-fA-F]`, then lowercased), and a non-checksummed lowercase `offerer` is accepted (the `addr`
transform re-checksums it).

### The bundle claims hold

27 chunks, 2.2 MB, same set. `usePublishListing` is verbatim what the report de-minified:

```js
"usePublishListing",0,function(){let e=w();return(0,g.useMutation)({mutationFn:async e=>{
  let t,{market:n,...i}=e,
  r=await fetch(""===(t=(0,b.marketQuery)(n))?"/api/orders":`/api/orders?${t}`,
    {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(i)});
  if(!r.ok)throw await x(r);return(await r.json()).listing},onSuccess:()=>{e()}})}
```

```
$ grep -ohE '/api/[A-Za-z0-9/_\.\-]*' *.js | sort -u
/api/glossary/Errors   /api/human   /api/orders   /api/orders/   /api/WagmiProvider
$ grep -ohE '.{80}verifyingContract.{80}' *.js | head -1
…"seaportDomain",0,function(e){return{name:"Seaport",version:"1.6",chainId:e,
   verifyingContract:"0x0000000000000068F116a894984e2DB1123eB395"}},"seaportTypes"…
$ grep -c NEXT_PUBLIC_FEE_BPS / NEXT_PUBLIC_FEE_RECIPIENT / dAe7e82A…0782  -> 6 / 4 / 4
```

### The docs quotes are real

I fetched `/docs/protocol/premium-market` and `/docs/faq` myself and found, verbatim, the whole
0–12 validation table including *"8 | the signature verifies for offerer (EOA or ERC-1271) | 401"*,
*"11 | at most 20 open listings per writer per chain; a per-IP token bucket on POST | 429"*,
*"A replay of an identical order hash returns 200 with the existing row"*, `SYNC_MAX_AGE_MS = 30_000`,
*"DELETE /api/orders/[hash] does not delete anything either"*, *"The contracts themselves are
permissionless and have no allowlist"*, and the `realised premium … total_price6 × filled_numerator /
filled_denominator` formula. The sequence diagram in the docs independently shows the POST body as
`{chainId, components, signature}`.

### The whole validation pipeline, now with live status codes and exact error strings

Each of these is a POST with a **fresh salt** and a garbage 65-byte signature, so none could insert.

```
[401] chainId 4663, garbage sig        {"error":"Invalid signature."}
[400] chainId 1                        {"error":"This chain is not supported."}
[400] chainId 46630                    {"error":"This listing is signed for chain 46630; this book serves chain 4663."}
[400] chainId 999999                   {"error":"This chain is not supported."}
[422] bogus optionId                   {"error":"This strike is not in the current cycle."}
[422] endTime + 60                     {"error":"A listing must end at the exercise timestamp of its option."}
[409] counter 7                        {"error":"Your listings were all cancelled in the meantime. Sign again."}
[422] offer token = USDG               {"error":"A listing must offer an option token from the clearinghouse."}
[422] consideration token = NVDA       {"error":"A listing must ask for its premium in USDG."}
[422] premium 999e6 > strike 246e6     {"error":"The premium cannot exceed the strike."}
[401] contract offerer (Multicall3)    {"error":"Invalid signature."}
```

Checks 1, 2, 3, 4, 5, 6 and 8 of the docs table are confirmed empirically with the documented status
codes. **The keeper should classify on these exact strings** — they are not in the report above.

---

## V1. >>> THE AUTH QUESTION IS SETTLED HARDER THAN THE REPORT SETTLED IT <<<

The report's proof was a `{}` POST returning a 400 from the schema. That only shows there is no gate
*in front of the schema*. It does not show that an unknown maker survives the *signature* check —
which is exactly where an allowlist would live.

So I generated a throwaway keypair, signed the real Seaport digest with it, and posted a
properly-formed order from an address Overcall has never seen:

```
$ cast wallet new
Address:     0xd06FfC9091A8fe409077B05174E2FaE1685B0261
Private key: 0x8bd4…f25a          (throwaway, zero balance, never funded)

$ python3 maker.py
throwaway maker: 0xd06FfC9091A8fe409077B05174E2FaE1685B0261
orderHash 0x78560d6a52e6f0237a1273a987677373b6ec3349aa505889c4427c7c14e3c3b4
digest    0x81cca031b78f5fe4902c37393b4ddebfb2706e392e172612fcd6a63aae8735f7
sig 0x7c51f84ac7add53491d546a63a11ceb0909d2f4048854c253ecd7652fd885187
     3506e1995280d3759c442b12b907bfe7f2745155918a71b30b5e222cb0555554 1b   (65 bytes)

POST https://overcall.finance/api/orders?market=NVDA
STATUS 422 {"error":"You do not hold enough option contracts to back this listing."}
```

**That order passed checks 0 through 8 inclusive and failed only at check 9 (`balanceOf`).**
A never-before-seen, unregistered, unfunded address got its EIP-712 signature *accepted* by the book.

There is no maker allowlist, no registration, no handshake, and nothing in front of the signature
check. **R3's launch-blocker question is dead.** No listing was created (422, no insert).
This also independently re-proves the body shape `{chainId, components, signature}` — a wrong body
could not have reached check 9.

---

## V2. CORRECTIONS — six claims that are wrong or overstated

### C1 — A 64-byte EIP-2098 compact signature is REJECTED. It is 65 bytes only.

The report says the vault's `isValidSignature` must accept *"a plain 65-byte `(r,s,v)` ECDSA signature
(or a 64-byte EIP-2098 compact one)"* and headlines *"Exactly 64 or 65 bytes."* The **schema** allows
64; the **verifier** does not.

Same key, same order shape, same everything — only the signature encoding differs:

```
65-byte (r,s,v)         -> 422 "You do not hold enough option contracts to back this listing."  (PASSED sig check)
64-byte EIP-2098, v=28  -> 401 "Invalid signature."
64-byte EIP-2098, v=27  -> 401 "Invalid signature."
```

My compact encoding is correct — I round-tripped it through the `ecrecover` precompile on 4663 and it
recovers the right address:

```
65-byte: 0x6e625d74…0eec2 1c   v=28
64-byte: 0x6e625d74…ec2       (r ‖ (s | yParity<<255))
decoded yParity 1  v 28  s matches: True
ecrecover from decoded compact -> 0xd06ffc9091a8fe409077b05174e2fae1685b0261
expected                       -> 0xd06ffc9091a8fe409077b05174e2fae1685b0261
```

Seaport 1.6 itself accepts EIP-2098; Overcall's book is stricter than Seaport here.

**Consequences for our build.** The keeper must emit a **65-byte** `(r,s,v)` signature and must never
compact it. The vault's `isValidSignature(bytes32,bytes)` still only has to handle 65 bytes, so the
report's contract-design conclusion is unchanged and safe — but do not "optimise" to 64, and do not
write a vault that *only* accepts 64. Update TECHSPEC/plan to say **65 bytes, full stop**.

### C2 — The idempotent-replay short-circuit runs BEFORE the chainId check and BEFORE the signature check

The report presents replay-idempotency as a validation-pipeline endpoint ("replaying an identical
order hash returns 200 with the existing row — keeper retries are safe"). It is actually a **very
early** short-circuit that skips validation entirely:

```
# reference components with their ORIGINAL salt (hash already in the DB),
# but chainId 1 and a garbage 65-byte signature 0x1111…11:
[200] chainId 1        {"listing":{"orderHash":"0xa11edb62…e522","chainId":4663,"offerer":"0xE73d…"…}}
[200] chainId 46630    {"listing":{"orderHash":"0xa11edb62…e522",…}}
[200] lowercase offerer{"listing":{"orderHash":"0xa11edb62…e522",…}}

# the SAME bodies with a FRESH salt (hash not in the DB):
[400] chainId 1        {"error":"This chain is not supported."}
[400] chainId 46630    {"error":"This listing is signed for chain 46630; this book serves chain 4663."}
```

So the server derives the order hash, finds an existing row, and returns it — without validating
`chainId` and without verifying the signature it was just handed.

**Consequence for the keeper.** A `200` is **not** evidence that the body you just sent was validated
or stored. It only means *some* row exists at that order hash. The keeper must compare the returned
`listing.orderHash` — and ideally `listing.signature` and `listing.components` — against what it
computed locally before logging "listing landed". Nothing here is exploitable (no state changes), but a
naive `if (res.status === 200) markListed()` would happily mark a garbage POST as success.
`201` is the only status that means "newly inserted".

### C3 — "The book is empty right now" is false. There is a live open listing.

The report ran only `?market=NVDA` and concluded the book was empty. Unfiltered:

```
$ curl -sS 'https://overcall.finance/api/orders'
{"listings":[{
  "orderHash":"0xeda0150a4b4fa3dbdac9fb4aca507c9784f19b9024dc24c52c6993429ef4bded",
  "chainId":4663,"offerer":"0x789A7490718CF944D6F2cA411ED53cDeFd56306a",
  "optionId":"873393324505681306211742772675693943830305973181304956549530887026947129344",
  "quantity":"21","remaining":"21","unitPrice6":"50000","totalPrice6":"1050000",
  "realisedPremium6":"0","startTime":"0","endTime":"1789761600","counter":"0",
  "status":"open","filledNumerator":"0","filledDenominator":"0",
  "components":{ …zone 0x0, orderType 1, conduitKey 0x0…0, zoneHash 0x0…0,
    "offer":[{"itemType":3,"token":"0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
              "identifierOrCriteria":"873393…129344","startAmount":"21","endAmount":"21"}],
    "consideration":[
      {"itemType":1,"token":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168","identifierOrCriteria":"0",
       "startAmount":"997500","endAmount":"997500","recipient":"0x789A7490718CF944D6F2cA411ED53cDeFd56306a"},
      {"itemType":1,"token":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168","identifierOrCriteria":"0",
       "startAmount":"52500","endAmount":"52500","recipient":"0xdAe7e82A2E7D566C67E87C164B05a1C560190782"}]},
  "signature":"0xbb0484c1…1c",   # 65 bytes
  "createdAt":"2026-09-12T06:58:50.450Z","checkedAt":"2026-09-12T18:29:17.702Z"}]}
```

This is a **better reference order for R2 than the filled one**: `N = 21`, unfilled, so it exercises
the multi-contract fee rounding the report warned about, and it confirms the per-contract formula
exactly — `50000 × 500 / 10000 = 2500`/contract fee; `2500 × 21 = 52500`; `47500 × 21 = 997500`;
`997500 + 52500 = 1050000 = 21 × 50000`. Offerer `0x789A…306a` has **0 bytes of code** (another EOA).
On-chain: `clearinghouse.balanceOf(0x789A…306a, 873393…) = 21` and
`isApprovedForAll(0x789A…306a, SEAPORT) = true` — so check 9's two conditions are exactly what a live
open listing satisfies.

Two side facts worth carrying: `registry.isApproved(873393…)` is **false on all seven mainnet
registries**, yet the row is still `open` — so the lazy status sync re-checks Seaport status, counter,
balance and approval, but **not** `registry.isApproved`. And no `market=` filter surfaces this row,
which means `market=` filters by the registry's *current-cycle* option ids.

### C4 — The "zero hits for authorization / x-api-key / siwe / turnstile" grep is false

```
authorization    51      x-api-key    1      siwe    3
credentials      16      cookie       7      turnstile/hcaptcha/recaptcha/apiKey/csrf/Bearer  0
```

Every hit is third-party library boilerplate, not Overcall API auth:
`x-api-key` is Rainbow's `enhanced-provider.rainbow.me` default key; `siwe` is viem's unused
`verifySiweMessage` helper; `authorization` is viem's EIP-7702 `authorizationList` transaction field;
`credentials`/`cookie` are `fetch` option names inside wagmi/viem.

**The conclusion (no auth) is correct and is independently proven by V1.** But do not cite that grep —
it does not say what the report says it says.

### C5 — `status=partial` is NOT a valid query value (resolves their UNRESOLVED #4)

```
?status=open        200 (default)        ?status=all      400 "One of the query parameters is not valid."
?status=filled      200                  ?status=partial  400 "One of the query parameters is not valid."
?status=cancelled   200 {"listings":[]}  ?status=bogus    400
?status=expired     200 {"listings":[]}
?status=unfillable  200 {"listings":[]}
?offerer=0xE73d…75be&status=all   200    (all requires offerer, as documented)
?limit=0     400      ?limit=1/50/100/200  200      ?limit=9999  400
?foo=bar     200  (unknown params ignored; known params validated)
```

`partial` exists in the client's `statusCopy` display map but is **not** an accepted filter value.
A keeper polling `?status=partial` would get a 400, not an empty list.

### C6 — `market` is a validated GET param too, and only seven symbols are valid on mainnet

The report treats `market` as a POST-only query param. It is validated on GET as well:

```
?market=NVDA/TSLA/GME/SPY/AAPL/AMZN/SPCX   200
?market=PLTR / MEME / CATTEST              400 "One of the query parameters is not valid."
?market=BOGUS                              400
```

So mainnet 4663 has exactly **seven** markets. The report's "10 markets
(AAPL AMZN CATTEST GME MEME NVDA PLTR SPCX SPY TSLA)" is the **testnet** set; do not carry that number
onto mainnet. `market=` genuinely filters: `?market=NVDA&status=filled` returns the reference order,
`?market=TSLA&status=filled` returns `[]`.

---

## V3. RESOLVED — things the report left open that I closed

### Their UNRESOLVED #2 — is `?market=` required on POST? **No, but a wrong value is fatal.**

Three POSTs, identical bodies, genuinely signed by the throwaway key, differing only in the query:

```
?market=NVDA   -> 422 "You do not hold enough option contracts to back this listing."   (reached check 9)
(no query)     -> 422 "You do not hold enough option contracts to back this listing."   (reached check 9)
?market=TSLA   -> 422 "This strike is not in the current cycle."                         (died at check 3)
```

The param is optional — omitting it validates against the right registry anyway. But the server uses
`market` to **select which registry to validate against**, so a stale or wrong symbol kills the POST at
check 3 with a misleading error. The report's mitigation ("always send `?market=NVDA`") is right;
add: *never send a symbol that does not match the option being listed*, and if in doubt omit it.

### Their `confirmed: false` on the registry owner — now confirmed on-chain

```
$ eth_call 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA 0x8da5cb5b   # owner()
0x000000000000000000000000408adcffebdf48ec23f1e3811a91aed3cc951cc0
$ eth_call … 0xe30c3978   # pendingOwner()
0x0  (none)
```

`registryOwner = 0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` — confirmed, 0 bytes of code (an EOA, not
a Safe). Two-step ownership (`pendingOwner`/`acceptOwnership`) is present in the bytecode. Worth noting
for the risk register: **the cycle is set by a single EOA key, not a multisig**.

### Their UNRESOLVED #3 — the per-IP rate limit is not tight

Across this verification I sent roughly **50 POSTs** and ~40 GETs to `overcall.finance` from one
residential IP at about 1 req/s over ~12 minutes. **Zero 429s.** (I did get a 429 from the *RPC
provider*, which is unrelated.) The exact bucket is still unpublished, but a keeper doing 1–3 POSTs a
week will not come close. Keep the backoff; drop this from the risk list.

### Their UNRESOLVED #7 — `realisedPremium6` discrepancy: reproduced, and their read is correct

I re-fetched the filled order myself: `totalPrice6: "4000000"`, `filledNumerator/Denominator: 1/1`,
`realisedPremium6: "3800000"`. The docs formula, which I also pulled myself, verbatim: *"the realised
premium is derived from them — `total_price6 × filled_numerator / filled_denominator`"* → would be
`4000000`. The implementation returns the writer's post-fee leg. The open listing (0 filled) returns
`realisedPremium6: "0"`, consistent with either. **Their flag stands: do not build NAV on this field.**

---

## V4. STILL UNRESOLVED — and their #1 deserves to stay open

**ERC-1271 for a contract offerer is genuinely untested, and I could not settle it remotely.**

What I added:

- A contract offerer (Multicall3, 3808 bytes) with a garbage signature returns the **identical**
  `401 {"error":"Invalid signature."}` an EOA gets. There is **no** distinct "offerer must be an EOA"
  rejection anywhere in the pipeline. Good sign, but it does not discriminate: an ecrecover-only
  verifier and a 1271-capable verifier both return 401 for a bad signature.
- The viem in their bundle does do the fallback — `verifyTypedData` → `verifyHash`, and `verifyHash`
  builds a deployless call with `erc6492SignatureValidatorAbi` / `erc6492SignatureValidatorByteCode`
  and checks for `0x1626ba7e`:
  ```js
  callData:(0,s.encodeFunctionData)({abi:t.erc1271Abi,functionName:"isValidSignature",args:[c,g]})
  …  if(A?.startsWith("0x1626ba7e"))return!0;
  ```
  That is the *client* bundle. The route handler is server-side and private. It is strong
  circumstantial evidence, not proof.
- I scanned every contract I know on 4663 for a permissive `isValidSignature(bytes32,bytes)` that
  would let me construct a positive test. All revert. There is no such contract to borrow.

**So: the "unknown maker" half of R3 is settled dead (V1). The "contract maker" half is not.**
The report's flat *"NOT a launch blocker"* is slightly too strong — we are betting the
vault-as-offerer design (plan §11.1: "Vault is the Seaport offerer. Keeper never custodies the 1155")
on an unverified server code path. Treat it as an **M3 gate**, not a closed item: deploy the vault on
testnet 46630 (registry `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56`, clearinghouse
`0x0059Df7C6229373a5AFC0685B0EE8777f59BAcbc`, mock USDG `0xe3B032b565d494A994772AEFF9919CC9AC574bEF`)
and post one real 1-contract listing. If it 401s, the fallback order page in §9 stops being a hedge and
becomes the primary listing surface — which is a product decision, so find out in M3, not in M7.

Also still open:

- **The 20-open-listings-per-writer cap** is untested. I never created a listing, so I could not
  probe it. Documented only.
- **Does a partial fill scale the net or the gross leg of `realisedPremium6`?** Unchanged: one
  full-fill sample, and the one open listing is unfilled.
- **Upper bound on `limit`** is somewhere in (200, 9999]. Not worth another probe.

---

## V5. One-line summary for whoever builds the keeper

Body `{chainId, components, signature}`; `?market=NVDA` optional but never wrong; **65-byte** ECDSA
only (not 64); `201` means inserted and `200` means "a row already exists at this hash, which may not
be yours"; classify failures on the exact error strings in V0; poll
`GET /api/orders?offerer=<vault>&status=open` ~30 s later to confirm; never `?status=partial`.

*— verification pass ends —*
