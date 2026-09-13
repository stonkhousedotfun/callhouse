# Architecture

How the four packages fit together, and why each boundary is where it is.

For the money maths see [ACCOUNTING.md](./ACCOUNTING.md). For the threat model see
[../SECURITY.md](../SECURITY.md). For the build plan and the recon evidence see `../plan.md` and
`../ops/recon/`.

---

## 1. The shape of it

```
                      ┌──────────────────────────────────────────┐
  depositor ──NVDA──► │  Vault  (this repo)                      │
                      │  ERC-20 shares: cNVDA                    │
                      │  is the Valorem writer                   │
                      │  is the Seaport offerer                  │
                      └───────┬──────────────────────┬───────────┘
                              │                      │
              write(optionId, n)                 approveListing(components)
                              │                      │  getOrderHash + validate
                              ▼                      ▼
              ValoremOptionsClearinghouse       Seaport 1.6
              0x9a7b…C0C0                       0x0000…B395
                    │                                 │
     n option ERC-1155 + 1 claim NFT          buyer fills, paying USDG
                    │                                 │  95% → vault
                    │                                 │   5% → Overcall
                    │                                 ▼
                    │                          option tokens leave the vault
                    │
          Saturday: redeem(claimId)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  unassigned NVDA back   assigned: strike USDG in

  off-chain, none of it custodial:
    keeper   → decides the strike, sends the rolls, POSTs the order to Overcall
    indexer  → reads events, serves the public cycle tape
    web      → deposit, queue, claim, and the fallback fill page
```

---

## 2. Trust boundaries

The important structural claim: **no off-chain component can move money.**

| Component | Holds funds | Can move funds | What it can actually do |
|---|---|---|---|
| Vault | yes, all of it | — | everything, inside its own on-chain rules |
| Keeper (hot key) | no | **no** | propose a strike, a size and an order; the vault validates all three |
| Guardian (1/1 key) | no | no | halt writes, kill listings |
| Admin Safe (2/3) | no | no | set policy inside hard caps, set the keeper and the fee recipient |
| Indexer | no | no | read events, relay an order to Overcall behind an HMAC |
| Web | no | no | build transactions the user signs |
| Overcall | no | no | list the order in their book; their API can only refuse |
| Registry owner (EOA) | no | no | set the weekly cycle and the lot size for the whole market |

The keeper is the one that usually surprises people. It never holds the option ERC-1155, never holds
collateral, and cannot produce a signature that Seaport would accept for the vault. It calls
`rollOpen` and `approveListing`, and the vault checks every field of what it proposes against its
own state before authorising anything. A fully compromised keeper key can waste a week; it cannot
take a token.

---

## 3. Contracts

`contracts/src/`, Solidity 0.8.28, via-IR, OpenZeppelin 5. No proxy: a fix means Vault v2 and a
migration.

| File | Job |
|---|---|
| `Vault.sol` | shares, deposits, the redeem queue, the phase machine, the roll |
| `Policy.sol` | pure bounds maths; the hard caps live in bytecode here |
| `Distributor.sol` | the USDG accrual index, settle-on-transfer, claims |
| `AdapterValorem.sol` | write, redeem, claim and position accounting |
| `AdapterSeaport.sol` | listing lifecycle, EIP-1271, the conduit approval |
| `lib/SeaportOrderLib.sol` | order shape validation and Seaport's three encoders |
| `lib/ValoremLib.sol` | the write/redeem path against Valorem, including the option-window check |

`Distributor`, `AdapterValorem` and `AdapterSeaport` are **abstract bases the vault inherits**, not
separate deployments. That is not a stylistic choice: Valorem mints the claim NFT to `msg.sender`
and `redeem` reverts for anyone else, and Seaport only accepts `validate` and `cancel` from the
offerer. The code has to execute in the vault's own context.

`SeaportOrderLib` and `ValoremLib` are the exception — **linked public libraries**, reached by
`DELEGATECALL`, so `address(this)` inside them is still the vault. They were extracted because
Seaport's order structs nest dynamic arrays and the three encoders (`getOrderHash`, `validate`,
`cancel`) cost several kilobytes inlined, which pushed `Vault` past the EIP-170 24 KB runtime
limit; the audit's deposit-gate and cycle-window checks then needed the room a second extraction
freed. Both libraries must be deployed and linked before the vault.

### The phase machine

```
Idle ──rollOpen()──► Listed ──lockBook()──► Exercisable ──rollClose()──► Idle
                       │                                      ▲
                       └──────────── rollClose() ─────────────┘
                              (keeper never locked the book)
```

- `rollOpen` is KEEPER only, and only while `registry.isWritingOpen()`. There is no status enum on
  the registry; that getter is the gate. The cycle is refused outright if its expiry is inverted,
  more than 21 days out (`MAX_CYCLE_TENOR`, compiled in — the registry's owner is an EOA and a
  bad cycle must skip a week, not lock collateral for years), or if the option's window differs
  from the cycle's.
- **Deposits close on the cycle's exercise timestamp**, whether or not anyone calls `lockBook`.
  Gating on the phase alone left the whole exercise window open, and assignment crashes NAV with
  no callback — minting against that crash was the one critical finding of the 2026-09-12
  review. `maxDeposit`/`maxMint` return 0 from the timestamp on. See [SECURITY.md](../SECURITY.md).
- `lockBook` is **permissionless** after the exercise timestamp. It only ever moves Listed →
  Exercisable after a time the registry already fixed, so there is nothing to gain by calling it and
  something to lose if nobody can.
- `rollClose` is KEEPER from expiry, and **anyone** from expiry + 1 hour. Depositors must never
  depend on a hot key staying alive to get their money back. The protocol fee push inside it is
  **best-effort** — a blocked or reverting fee recipient cannot freeze the close; the fee accrues
  into `pendingFeeUsdg` and anyone can complete it later with `sweepFee()`.
- `Settling` is set inside `rollClose` and is only observable mid-transaction.

Pause and halt block `rollOpen` **only**. `queueRedeem`, `completeRedeem`, `claimUsdg`,
`cancelListing`, `lockBook` and `rollClose` all keep working.

---

## 4. Keeper

`keeper/src/`, Node 22 + TypeScript + viem. One vault per process. State in SQLite so a restart
resumes rather than repeats.

| File | Job |
|---|---|
| `config.ts` | zod-validated env; fails at boot, not on a Friday night |
| `clients.ts` | two RPCs with failover; log queries pinned to the archive node |
| `state.ts` | cycles, listings, transactions; reconciled against chain on boot |
| `policy.ts` | the strike picker |
| `seaport.ts` | builds the order in Overcall's exact shape |
| `overcallApi.ts` | POST/GET/DELETE against their listings API |
| `roll.ts` | the state machine |
| `health.ts` | `/health` liveness and `/state` |
| `alerts.ts` | webhook alerts |
| `dryrun.ts` | drives a full cycle against an anvil fork with time warp |

Everything binds to `registry.isWritingOpen()` and the cycle timestamps, **never the wall clock**.
Every state-changing call simulates first, then sends, then waits for the receipt, then records.

### The listing sequence

```
1. build OrderComponents off-chain            seaport.ts
2. vault.approveListing(components)           on-chain authorisation + seaport.validate()
3. POST to overcall.finance/api/orders        with a 65-byte placeholder signature
4. verify it is visible in their book
```

Step 3's placeholder is correct, not lazy. The vault authorises by **hash**; its
`isValidSignature` ignores the signature bytes. There is no key that signs anything. But Overcall's
schema rejects any signature that is not 64 or 65 bytes before it runs any on-chain check, so the
keeper sends a well-formed placeholder and the vault answers for the hash.

If their API refuses the order, the payload is published on `/vault/nvda/cycle` so a buyer can fill
directly from our own UI. An invisible listing is an unfilled week.

---

## 5. Indexer and API

`indexer/`, Ponder. Reads only. No funds, no matching.

Listens to the vault's events, Valorem's `OptionsWritten` / `OptionsExercised` / `ClaimRedeemed` /
`BucketAssignedExercise` filtered to the vault, Seaport's `OrderFulfilled` matched on our listing
hash, the registry's `CycleSet`, and Stock Token transfers in and out.

| Route | Purpose |
|---|---|
| `GET /v1/vault` | TVL, phase, this week |
| `GET /v1/cycles` | the full history, **including unfilled weeks as rows of zeros** |
| `GET /v1/account/:addr` | shares, claimable USDG, queued position |
| `GET /v1/listings` | current and past order hashes |
| `GET /health` | indexer head versus chain head |
| `POST /v1/overcall/list` | keeper only, HMAC; relays to Overcall |

Two things it must get right, because both would publish a false number:

- A filled week emits **more than one `Harvest`** (the deposit checkpoint plus the close). Sum them
  per cycle; do not treat the last as the week's result.
- Valorem claim amounts are 1e18-scaled scalars. Divide before reporting a contract count.

---

## 6. Web

`web/`, Next.js App Router, wagmi, viem. No custody, no private keys, no server-side signing.

| Route | Content |
|---|---|
| `/` | one vault card: idle and locked, this week's strike, listed / filled / unfilled / assigned |
| `/vault/nvda` | deposit, queue withdraw, complete redeem, claim USDG |
| `/vault/nvda/cycle` | the five-rung ladder, our pick, the order hash, and the raw fill payload |
| `/activity` | every harvest, including the unfilled weeks |
| `/docs` | short spec and the risk list |
| `/legal` | geographic restrictions and the Stock Token legal form |

Raw balances and the `uiMultiplier`-adjusted "NVDA-eq" figure are both shown, with the adjusted one
labelled display-only.

**Copy rules are enforced by CI**, not by taste. `scripts/copy-lint.mjs` fails the build on "APY",
"annualized", "projected yield", "backed by Nvidia" and the rest, and separately fails if the
required disclosures are missing verbatim from `/vault/nvda` and `/legal`.

---

## 7. External dependencies, and what each can do to us

| Dependency | If it misbehaves |
|---|---|
| Valorem Clear | bytecode-identical to the Zellic-audited upstream; a fee-switch flip blocks writes until governance accepts it |
| Seaport 1.6 | canonical deployment; a compromise would reach the option ERC-1155 the vault has approved |
| OvercallRegistry | its owner is an **EOA** that sets the weekly cycle for the whole market; a bad cycle means the vault writes nothing, since the policy band still applies |
| Overcall's API | can only refuse to list; the fallback fill page is the mitigation |
| NVDA Stock Token | an upgradeable proxy; the issuer can freeze transfers and pause the oracle, which can brick writes and settlement. Disclosed, not coded around |
| USDG | an upgradeable proxy, 6 dp |
| Chainlink NVDA/USD | `us_equities_24/5`; it stops at weekends, which is why `maxPriceAge` is 4 days |
| The 4663 sequencer | centralised; there is **no** Chainlink sequencer uptime feed on this chain, so an outage surfaces as a stale price |

---

## 8. Where the bodies are buried

Things that look wrong and are not, or look fine and are not. Each is commented at the site.

1. **Seaport's `incrementCounter` does not add one.** It jumps by a quasi-random amount, so nothing
   may assume `previous + 1`. Re-read `getCounter`.
2. **`getOrderStatus` returns the fill fraction**, not the order size. `totalFilled` and `totalSize`
   are both `0` on a validated-but-unfilled order. Check `validated`, not `totalSize`.
3. **Overcall's frontend config has a top-level `registry` key that is the JUGGERNAUT market**, not
   NVDA. Wiring it would collateralise NVDA calls with the wrong token. The vault constructor
   refuses any registry whose collateral, exercise and clearinghouse do not match.
4. **The 5% fee rounds per contract, then multiplies.** See ACCOUNTING.md §6.
5. **`redeem` does not require unsold options to be burned.** Leftover option ERC-1155 sit in the
   vault as permanently inert dust and are valued at zero. Their collateral already came back
   through the claim.
6. **The price feed being stale at the weekend is correct, not broken.** The market is shut, so
   Friday's close *is* spot.
7. **`contractsRemaining` and `contractsSold` are derived views**, read from the ERC-1155 balance.
   Seaport moves the tokens out without a callback, so any counter the vault kept would drift.
8. **`totalAssets()` collapses the moment a buyer is assigned**, mid-transaction, with no callback
   — Valorem takes the collateral and the strike USDG sits in the claim until `rollClose`. That is
   honest accounting, but it is why the deposit window closes on the exercise timestamp rather than
   on the phase: pricing new shares against the gap was the critical finding in SECURITY.md.
9. **A queue entry can settle without a payout.** `queueRedeem` auto-settling a stale slot moves
   value into the owner's owed balances as pure bookkeeping (an issuer freeze must never block
   queueing). It emits `QueueEntrySettled`, not `CompleteRedeem` — off-chain readers that only
   watch the latter will misread the epoch.
10. **`Vault` has ~1.4 KB of headroom** under EIP-170 after two library extractions
   (`SeaportOrderLib`, `ValoremLib`). Anything more than a small addition needs a third extraction,
   not another optimiser setting.
