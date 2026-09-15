# Architecture

How the four packages fit together, and why each boundary is where it is.

For the money maths see [contracts/docs/ACCOUNTING.md](../contracts/docs/ACCOUNTING.md). For the
threat model see [contracts/SECURITY.md](../contracts/SECURITY.md). Both live in
`stonkhousedotfun/callhouse-contracts`, mounted at `contracts/` as a git submodule. For the runtime map (who
calls whom, over which env var, and what is proven) see [WIRING.md](./WIRING.md). For the recon
evidence see `../ops/recon/`.

**Redesigned 2026-09-13 (owner decisions D1 = A(ii), D16, D17, D14).** The vault **writes on
fill**: nothing is written at the weekly open, every Seaport fill writes exactly the contracts it
buys inside the vault's own `authorizeOrder` hook, and the vault never holds an unsold option
token. There is **no Overcall registry and no Overcall order book** anywhere in the system: the
keeper creates the week's option type on the clearinghouse itself, the vault validates the tuple
from the clearinghouse, and the only sales venue is the self-hosted fill page. The contracts are
**unaudited**; the gate is the test suite (`contracts/README.md`).

---

## 1. The shape of it

```
                      ┌──────────────────────────────────────────────────────────────┐
  depositor ──NVDA──► │  Vault  (ours, contracts/)                                   │
                      │  ERC-20 shares: cNVDA                                        │
                      │  is the Valorem writer      ─ writes only inside a fill      │
                      │  is the Seaport offerer     ─ one PARTIAL_RESTRICTED order   │
                      │  is the Seaport ZONE        ─ authorizeOrder / validateOrder │
                      └──────┬──────────────────────────────────────┬────────────────┘
                             │                                      │
        rollOpen(optionId)   │  ARMS the week, writes nothing       │  approveListing(components)
                             │                                      │  getOrderHash + validate
                             ▼                                      ▼
             ValoremOptionsClearinghouse                       Seaport 1.6
             vault.clear() (Overcall's 0x9a7b…C0C0,            0x0000…B395
             or our own from DeployClear)                           │
                    ▲                                               │ buyer calls fulfill*
                    │                                               ▼
                    │           ┌──── authorizeOrder(zp) ──── before any transfer ────┐
                    │           │  live listing? Listed? not halted? clock, fee,      │
                    │           │  oracle, band FLOOR and premium floor at live spot, │
                    │           │  size on written + k; then clear.write(id, k)       │
                    └───────────┤  k option tokens minted to the vault ── Seaport     │
                                │  moves them to the buyer, USDG to the vault        │
                                │  validateOrder: option balance back at baseline    │
                                └────────────────────────────────────────────────────┘
                                          CallsWritten(k) per fill; written == sold

          after expiry: rollClose ── redeem(claimKey) if anything sold
                    │
        ┌───────────┴───────────┐              redeem reverted (USDG paused / frozen,
        ▼                       ▼              NVDA blocklist) → claim STRANDED, Idle,
  unassigned NVDA back   assigned: strike USDG in     anyone retryStrandedClaim()

  off-chain, none of it custodial:
    keeper   → creates the option type, arms, prices and authorises the listing,
               simulates a fill every tick and reprices after a rally, closes the week,
               retries a stranded claim, serves the order payload at /orders
    indexer  → reads events, serves the public cycle tape
    web      → deposit, queue, claim, settle the queue, retry a strand, and THE fill page
```

---

## 2. Trust boundaries

The important structural claim: **no off-chain component can move money.**

| Component | Holds funds | Can move funds | What it can actually do |
|---|---|---|---|
| Vault | yes, all of it | — | everything, inside its own on-chain rules |
| Keeper (hot key) | no | **no** | create an option type (anyone can), propose it, propose a listing's size and price; the vault validates all of it at arm and re-prices at every fill |
| Guardian (1/1 key) | no | no | halt (arms, listings AND fills), kill listings |
| Admin (deployer key at bootstrap, then the 2/3 Safe) | no | no | set policy inside hard caps, the fee recipient, the cap, the price age; accept the Valorem fee; grant roles |
| Indexer | no | no | read events |
| Web | no | no | build transactions the user signs |
| Seaport 1.6 | no (transient custody during a fill) | moves the minted option tokens to the buyer and the buyer's USDG to the vault, inside one fill, between the two hooks | the only caller of `authorizeOrder` / `validateOrder` |
| Valorem Clear `feeTo` key | no | no | flip the 15 bps engine fee; the vault stops arming and filling until governance accepts it |

The keeper is the one that usually surprises people. It never holds an option token, never holds
collateral, has no signature Seaport would accept, and cannot make the vault write anything: only a
buyer's fill does that, and the hook re-checks the band floor and the premium floor at the spot of
that block. A fully compromised keeper key can waste a week, or sell at the policy floor to itself:
about 1.1% of **sold** notional per week at launch policy (2.2% for the bootstrap admin, which can
loosen policy). `contracts/SECURITY.md` §3 has the derivation. It cannot take principal.

---

## 3. Contracts

`contracts/src/`, Solidity 0.8.28, via-IR, OpenZeppelin 5. No proxy: a fix means Vault v2 and a
migration.

| File | Job |
|---|---|
| `Vault.sol` | shares, deposits (one `DepositsClosed` gate), the redeem queue, the phase machine, the arm, the zone hooks, the stranded-claim state machine |
| `Policy.sol` | pure bounds maths; the hard caps live in bytecode here |
| `Distributor.sol` | the USDG accrual index, settle-on-transfer, claims |
| `AdapterValorem.sol` | per-cycle claim accounting, redeem, the mint-only ERC-1155 receiver |
| `AdapterSeaport.sol` | listing lifecycle (`PARTIAL_RESTRICTED`, zone == the vault), the Seaport approval |
| `lib/SeaportOrderLib.sol` | order shape validation and Seaport's three encoders (linked library) |
| `lib/ValoremLib.sol` | the arm gate (`rollOpen`) and the fill gate (`writeOnFill`), the low-level redeem, the oracle read (linked library) |

`Distributor`, `AdapterValorem` and `AdapterSeaport` are **abstract bases the vault inherits**, not
separate deployments. Valorem mints the claim NFT to `msg.sender` and `redeem` reverts for anyone
else; Seaport only accepts `validate` and `cancel` from the offerer and calls the zone's hooks on
the zone. The code has to execute in the vault's own context.

`SeaportOrderLib` and `ValoremLib` are **linked public libraries**, reached by `DELEGATECALL`, so
`address(this)` inside them is still the vault. Both must be deployed (CREATE2, address fixed by
bytecode) and linked before the vault. solc lists an error in a contract's ABI only when that
contract's own bytecode can raise it, so 36 of the vault's 92 custom errors live only in the
library artefacts; every decoder in this repo merges them (`WIRING.md` §5).

**Size.** The Vault runtime is 25,470 B at contracts `ca0e985`, above EIP-170's 24,576 B and
**fine on chain 4663, whose code limit is 98,304 B** (verified by `eth_call --create` probes;
decision D17). `foundry.toml` sets `code_size_limit = 98304`, anvil rehearsals need
`--code-size-limit 98304`, and forge's EIP-170 "margin" line is noise. The contracts are not
portable to an EIP-170 chain without another extraction.

### The phase machine

```
Idle ──rollOpen(optionId)──► Listed ──lockBook()──► Exercisable ──rollClose()──► Idle
  ▲                             │                                       │
  │                             └──────────── rollClose() ──────────────┘
  │                                    (nobody locked the book)
  │
  └── rollClose whose redeem reverted: Idle with the claim KEPT (isStranded() == true);
      deposits, instant redemption and rollOpen shut; anyone retryStrandedClaim() → Idle, clean
```

- `rollOpen(optionId)` is KEEPER only, from `Idle`, not stranded, not halted. It reads the option
  tuple back from the clearinghouse: `tokenType == Option`, our asset and USDG, lot exactly `1e18`,
  exercise at least 1 hour out (`MIN_LEAD`), a window of at least 1 day (`MIN_EXERCISE_WINDOW`), a
  tenor of at most 21 days (`MAX_CYCLE_TENOR`), the engine fee off or accepted, the oracle live,
  and the strike inside the OTM band with **both** bounds. It snapshots strike and window and
  numbers the cycle. It **writes nothing**: `RollOpen.contractsCount` is always 0.
- `approveListing` authorises ONE `PARTIAL_RESTRICTED` order with zone == the vault, one ERC-1155
  offer item (the armed id, at most the remaining capacity
  `Policy.maxContracts(totalAssets()) − contractsWritten()`) and ONE USDG consideration item to the
  vault, pre-validated on Seaport so an empty signature fills. Three per cycle, cancelled or not.
- **A fill is the write.** Seaport calls `authorizeOrder` before any transfer, on every fulfil path.
  The hook checks it is the live listing, Listed, not halted, then `ValoremLib.writeOnFill` re-runs
  the clock (`WriteWindowClosed`), the fee switch, the oracle, the band **floor** (`StrikeBelowBand`)
  and the premium floor at live spot plus the engine fee valued at spot when on
  (`PremiumBelowFloorAtFill`), sizes `written + k` against the same caps, writes exactly `k`
  (`clear.write(optionId, k)` on the first fill, recording the claim; `clear.write(claimKey, k)`
  afterwards), and checks the reserve (`ReserveBreached`). Seaport moves the minted tokens to the
  buyer and the USDG to the vault. `validateOrder` runs after every transfer and reverts
  `InventoryLeftBehind` unless the option balance is back at its transient-storage baseline.
  `CallsWritten` fires **once per fill**; its sum per `claimKey` is `contractsWritten`, which equals
  sold by construction. Inside `fulfillAvailable*` a refused hook skips the vault's order rather
  than reverting the buyer's batch; on every other path the fill reverts.
- **Deposits close on the cycle's exercise timestamp**, whether or not anyone calls `lockBook`, and
  through one gate with five reasons (halted, stranded, past exercise, at the cap, reserve unbacked
  after an issuer burn): `maxDeposit`/`maxMint` return 0 and `deposit`/`mint` revert
  `DepositsClosed`. Deposits during Listed before that timestamp are allowed (D8) and disclosed:
  a late depositor buys into the open short and can be written against by a later fill.
- `lockBook` is **permissionless** after the exercise timestamp. The hook refuses fills after that
  timestamp regardless.
- `rollClose` is KEEPER from expiry, and **anyone** from expiry + 1 hour. With `claimKey == 0` (an
  unsold week) it skips the redeem. Otherwise it redeems through a low-level call: a revert inside
  USDG or the Stock Token does not brick the close; it **strands** the claim (`ClaimStranded`), reaches
  Idle with the claim kept, records each settling queue epoch's pro-rata share (`EpochStrandShare`),
  and anyone can `retryStrandedClaim()` until Valorem lets the redeem through
  (`StrandedClaimRecovered`, its `Harvest` carrying the stranded cycle's number). A gas-starved close
  cannot fake a strand (`RedeemOutOfGas`). The protocol fee push is best-effort (`pendingFeeUsdg`,
  `sweepFee`). `completeRedeem` pays the Stock Token leg with `safeTransfer` and the USDG leg
  best-effort (`UsdgLegDeferred`); NAV is the honest `max(balance + locked − reserved, 0)` and a
  reserve an issuer burn left unbacked is paid pro rata (`ReserveHaircut`).
- `settleQueue()` is permissionless while Idle: a queue that formed while flat is paid exactly what
  an instant redemption would pay, without waiting for a week to close.
- `Settling` is set inside `rollClose` and is only observable mid-transaction.

A halt blocks `rollOpen`, `approveListing` and every fill **only**. `queueRedeem`, `settleQueue`,
`completeRedeem`, `claimUsdg`, `retryStrandedClaim`, `cancelListing`, `invalidateAllListings`,
`lockBook` and `rollClose` all keep working.

---

## 4. Keeper

`keeper/src/`, Node 22 + TypeScript + viem. One vault per process. State in SQLite so a restart
resumes rather than repeats.

| File | Job |
|---|---|
| `config.ts` | zod-validated env; fails at boot, not on a Friday night |
| `clients.ts` | two RPCs with failover; log queries pinned to the archive node |
| `state.ts` | cycles, listings, transactions; reconciled against chain on boot |
| `policy.ts` | the strike and window chooser (whole-dollar strike inside the band, US-close anchor) |
| `seaport.ts` | builds the `PARTIAL_RESTRICTED` order with the vault as zone and one consideration item |
| `roll.ts` | the state machine: create type → arm → list → simulate/reprice → lock → close → retry a strand |
| `health.ts` | `/health`, `/state`, `/cycles`, and `/orders` (the fill page's order source) |
| `alerts.ts` | webhook alerts, fourteen kinds (`ops/alerts.md`) |
| `abi.ts` | the hand ABI: every function the keeper calls and all 92 custom errors, library ones included |
| `dryrun.ts` | drives a full cycle against an anvil fork with time warp |

Everything binds to the vault's own state and the option's timestamps (`cycleExerciseTs`,
`cycleExpiryTs`), **never the wall clock**. Every state-changing call simulates first, then sends,
then waits for the receipt, then records.

### The weekly sequence

```
1. choose strike and window                    policy.ts     inside the band; anchored on the US close
2. clear.newOptionType(asset, 1e18, usdg,      permissionless; OptionsTypeExists(id) → reuse the id
                       strike, exerciseTs, expiryTs)
3. vault.rollOpen(optionId)                    arms; writes nothing
4. build OrderComponents off-chain             seaport.ts    orderType 3, zone = vault, one USDG item
5. vault.approveListing(components)            on-chain authorisation + seaport.validate()
6. serve {parameters, signature: 0x} at /orders → the fill page
7. every tick: eth_call a one-contract fill    reprice (cancel + approveListing) on
                                               PremiumBelowFloorAtFill after a rally; alert
8. lockBook at cycleExerciseTs; rollClose at cycleExpiryTs; retryStrandedClaim on a timer if stranded
```

Nothing is sized by the keeper: the vault sizes every fill. Nothing is posted anywhere: fillability
comes from Seaport (`getOrderStatus`) and the simulation, never from an API status.

---

## 5. Indexer and API

`indexer/`, Ponder. Reads only. No funds, no matching, no write route.

Listens to the vault's events, the clearinghouse's `OptionsWritten` / `OptionsExercised` /
`ClaimRedeemed` filtered to the vault, Seaport's `OrderFulfilled` matched on our listing hash, and
Stock Token transfers in and out.

| Route | Purpose |
|---|---|
| `GET /v1/vault` | TVL, phase, this week, capacity, stranded state |
| `GET /v1/cycles` | the full history, **including unfilled weeks as rows of zeros** |
| `GET /v1/account/:addr` | shares, claimable USDG, queued position, pending stranded share |
| `GET /v1/listings` | current and past order hashes with their fills |
| `GET /v1/health` | indexer head versus chain head |

Things it must get right, because each would publish a false number:

- `RollOpen.contractsCount` is always 0. **Sold is the sum of `CallsWritten.contractsCount` per
  `claimKey`**, and a fill is `OrderFulfilled` on Seaport plus `CallsWritten` on the vault in the
  same transaction.
- A filled week emits **more than one `Harvest`** (the deposit checkpoint plus the close, plus a
  retry's after a strand, carrying the stranded cycle's number). Sum them per cycle.
- Valorem claim amounts are 1e18-scaled scalars. Divide before reporting a contract count.
- A stranded close emits `ClaimStranded` and a zero-leg `RollClose`; the cycle is not "closed"
  until `StrandedClaimRecovered`.
- Listing end reasons are cancel, counter bump (`AllListingsInvalidated`), `lockBook`, `rollClose`;
  `ListingApproved.seq` is unique per cycle.

---

## 6. Web

`web/`, Next.js App Router, wagmi, viem. No custody, no private keys, no server-side signing.

| Route | Content |
|---|---|
| `/` | one vault card: idle and locked, this week's strike, armed / sold / unfilled / assigned / stranded |
| `/vault/nvda` | deposit (closed whenever `maxDeposit == 0`, with the reason), queue withdraw, settle queue, complete redeem, claim USDG; a stranded banner and a Retry button when `isStranded()` |
| `/vault/nvda/cycle` | **the fill page**: this week's strike, capacity, the live in-fill floor, the order hash and the raw payload; an `eth_call` pre-flight (~500k gas) before the fill button, with the decoded refusal (a fill can be refused after a rally) |
| `/activity` | every harvest, including the unfilled weeks |
| `/docs` | short spec and the risk list |
| `/legal` | geographic restrictions and the Stock Token legal form |

The fill page's orders come from the keeper's `/orders` through a same-origin server route that
checks every order against the chain before offering it (`WIRING.md` §7). There is no other venue.

Raw balances and the `uiMultiplier`-adjusted "NVDA-eq" figure are both shown, with the adjusted one
labelled display-only.

**Copy rules are enforced by CI**, not by taste. `scripts/copy-lint.mjs` fails the build on "APY",
"annualized", "projected yield", "backed by Nvidia" and the rest, and separately fails if the
required disclosures are missing verbatim from `/vault/nvda` and `/legal`. "Unaudited" stays.

---

## 7. External dependencies, and what each can do to us

| Dependency | If it misbehaves |
|---|---|
| Valorem Clear | bytecode-identical to the Zellic-audited upstream; unmaintained; a fee-switch flip (no timelock, `feeTo` nomination emits no event) blocks arms and fills until governance accepts it. The vault settles on whichever instance it was constructed with: Overcall's, or our own from `DeployClear.s.sol` |
| Seaport 1.6 | canonical deployment; the only caller of the zone hooks; a compromise would reach what a fill mints, which is bounded to that fill |
| NVDA Stock Token | an upgradeable proxy; the issuer can freeze transfers, blocklist an address, burn supply (`adminBurn`, instant) and change the multiplier (can decrease). A freeze or blocklist strands the close rather than bricking it; a burn haircuts the reserve pro rata. Disclosed, not coded around |
| USDG | an upgradeable proxy, 6 dp; instant pause, freeze (of the vault, the Clear or Seaport), wipe. A pause or freeze strands the close and defers the USDG leg of a redemption; 27 freezes observed on 4663, none lifted |
| Chainlink NVDA/USD | `us_equities_24/5`; it stops at weekends (worst observed gap 21 h intra-week, 78 h over a long weekend), which is why `maxPriceAge` is 4 days; the frozen value can predate the close by hours |
| The 4663 sequencer | centralised; there is **no** Chainlink sequencer uptime feed on this chain, and at a 4-day price age a stall does not surface as `StalePrice` for days: watch head liveness directly |

Overcall is no longer a dependency. Its registry, order book, API, validator, fee item and fee
recipient are out of the design; its unmodified Clear instance remains the default clearinghouse
because the same option types are settled there, and only the `feeTo` switch above is a power
over it.

---

## 8. Where the bodies are buried

Things that look wrong and are not, or look fine and are not. Each is commented at the site.

1. **Seaport's `incrementCounter` does not add one.** It jumps by a quasi-random amount, so nothing
   may assume `previous + 1`. Re-read `getCounter`.
2. **`getOrderStatus` returns the fill fraction**, not the order size. `totalFilled` and `totalSize`
   are both `0` on a validated-but-unfilled order. Check `validated`, not `totalSize`.
3. **`RollOpen.contractsCount` is always 0, and that is the design.** Nothing is written at the
   open. Anyone reading it as "contracts this week" publishes an unfilled week for every week.
4. **`CallsWritten` fires per fill, not per cycle.** Sum it per `claimKey`. The first fill of a
   week costs ≈ 470k gas (it records the claim), a top-up ≈ 245k, both spike figures; the fill page
   pre-flights with ~500k.
5. **The vault has no option balance, ever, outside the two hooks.** A non-zero
   `clear.balanceOf(vault, optionId)` is a bug, not leftovers: `validateOrder` reverts the fill that
   would leave one, and the ERC-1155 receiver accepts mints only (`from == address(0)`).
6. **The band ceiling is checked at arm only; the floor at arm and at every fill.** A sell-off after
   the arm leaves the strike above the band and the listing fillable (the vault sells a call that is
   further out of the money than policy required, which is safe); a rally makes it unfillable until
   the keeper reprices, or unfillable full stop if the strike itself fell under the band floor.
7. **A fill can be refused, and that is the floor working.** `PremiumBelowFloorAtFill` re-prices
   the premium floor at the spot of the fill block, with the engine fee valued at spot when on. A
   listing priced exactly at Monday's floor is unfillable on Tuesday's uptick; `PREMIUM_MARGIN_BPS`
   is the cushion.
8. **`totalAssets()` collapses the moment a buyer is assigned**, mid-transaction, with no callback:
   Valorem takes the collateral and the strike USDG sits in the claim until `rollClose`. That is
   honest accounting, and it is why the deposit window closes on the exercise timestamp rather than
   on the phase.
9. **A stranded close is a success, not a failure.** `rollClose` returning normally with
   `isStranded() == true` and `RollClose(cycle, 0, 0, 0)` means the redeem reverted inside USDG or
   the Stock Token and the vault kept the claim rather than trapping everyone behind a reverting
   close. Instant redemption, deposits and the next arm are shut; queueing, `settleQueue`,
   `claimUsdg` and `retryStrandedClaim` are not.
10. **A queue entry can settle without a payout.** `queueRedeem` auto-settling a stale slot moves
    value into the owner's owed balances as pure bookkeeping (an issuer freeze must never block
    queueing). It emits `QueueEntrySettled`, not `CompleteRedeem`; off-chain readers that only
    watch the latter misread the epoch.
11. **The price feed being stale at the weekend is correct, not broken.** The market is shut. But
    Chainlink's frozen value can predate the close by hours, so "Friday's close is spot" is not
    quite true either; arm during the regular session.
12. **`Vault` is above 24,576 B on purpose.** Chain 4663's limit is 98,304 B. A default anvil, an
    EIP-170 chain, and forge's "margin" line all disagree with the chain; the chain wins.
