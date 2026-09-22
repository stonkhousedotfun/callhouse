# R14 — stock-loan borrow demand on 4663, and the rule that turns it into a decision

Probe: 2026-09-20 UTC. Reproduce with `node ops/recon/r14-stockloan-probe.mjs`;
`--check` re-reads the chain and compares against
[`r14-stockloan-demand.json`](r14-stockloan-demand.json), failing on a market appearing or
disappearing, a change to any immutable market parameter (`loanToken`, `collateralToken`,
`oracle`, `irm`, `lltv`), a verdict flip, or the Morpho singleton losing code. It deliberately
does **not** fail on utilisation or rate moving — that is what this probe expects to see change.
Public Robinhood RPC only, read-only; no wallet, no archive node, no private key, no transaction.

This document states the **decision rule**. It cites the probe's keys by name and **restates no
threshold number**, because a number copied into prose is a second source of truth that drifts
from the file the moment anyone tunes it. Every figure quoted below is either a dated observation
or a recon citation, and is marked as such.

The operational procedure — who runs it, how often, what to do when the verdict moves — is
[`ops/runbooks/stock-yield-go-no-go.md`](../runbooks/stock-yield-go-no-go.md).

## The question this answers

Board task P8-04: *"Report from on-chain reads; go / no-go for advertising stock yield; nothing
advertised before borrowers exist."* The measurement half is the probe. This is the half that says
what the measurement licenses.

## The fact people get wrong

**Collateral posted on Morpho is not lent out, and earns nothing. Only the loan side earns.**

"Deposit NVDA on Morpho" and "earn lending yield on NVDA" are different actions, and only the
second has anything to do with this feature. The second one has no users.

This is not a subtlety — it is the single most-confused fact in the whole feature, and it inverts
the reading of every headline number on every lending dashboard. A venue can show millions of
dollars of Stock Tokens "in" it and pay the people who put them there exactly zero, because those
tokens are collateral backing USDG loans, not inventory being lent. Source:
`v8-plan/LENDING-RECON-2026-09-19.md` §2 closing paragraph; `v8-plan/06-QUIRKS.md` §H,
"Supplied stock earns 0% until someone borrows it; USDG earns today."

Borrow demand for Stock Tokens comes from makers who buy calls or write puts, and from short
sellers — **not** from covered-call writers, who are already long the share (§H).

## The decision rule

The rule lives in the JSON, not here:

- `thresholds` holds every number in the bar, and is the **only** place any of them appears. Its
  `proposedBy` field names who proposed them and on what evidence. They are **not owner-approved**
  and this document does not treat them as approved.
- `verdict.value` is `"go"` or `"no-go"`. `verdict.reasons` is a list explaining the outcome — on a
  `no-go` it names each condition that failed; on a `go` it names each one that was cleared.
- The verdict is **fail-closed**: `"no-go"` unless every threshold in `thresholds` is met **and**
  the trailing run of consecutive daily entries in `samples` reaches
  `thresholds.minConsecutiveDailySamples`.

If you believe a threshold is wrong, raise it as an open question to the probe's author and to the
owner. **Do not encode a different one here.** Two numbers for one bar is how a decision quietly
becomes two decisions.

### The bar is sustained borrowing, not a snapshot

`samples` is **append-only**: each run adds one dated entry and rewrites none. This is structural,
not stylistic. A day that has passed cannot be re-read, so a run that clobbers history makes the
go/no-go permanently unanswerable. The verdict reads the newest sample for the measured quantities
and the whole array for the run length, so a single good day cannot carry a `go` on its own.

## What the 2026-09-20 sample found

A dated observation at `observedBlock` 68133529, not a standing fact. Re-run the probe before
relying on any of it.

| | |
|---|---|
| Morpho markets with a Stock Token as loan asset | 12 |
| …of those, with any borrowing at all | 0 |
| Stock on loan, USD | 0 |
| Utilisation, best of the 12 | 0.00 % |
| Verdict | `no-go` |

The 12 markets break down SPY 6, NVDA 2, TSLA 2, AAPL 1, GOOGL 1 — every one at
`totalSupplyAssets` 0 and `totalBorrowAssets` 0.

**This agrees with the independent recon of 2026-09-19 on six points**, which is the reason to
trust it: 273 created markets against the recon's 271 eleven days earlier (two created since); 12
stock-loan markets, identical; the per-ticker split reproducing the recon's 5 + 2 + 5 grouping
exactly; all twelve empty, as recorded; the Morpho singleton's code size matching to the byte; and
Hedgehood's contracts matching in size, with NVDA's `nextLoanId` of 1 **consistent with** no loan ever
having been opened there — see the caveat below on why that is not an exact reading. Two measurements, different code, eleven days apart, same set.

### Read the verdict correctly: three measurements and one absence

`verdict.reasons` currently carries four entries, and **they are not four independent
confirmations**. Three of them are measurements:

1. stock on loan is below `thresholds.minStockOnLoanUsd`,
2. best utilisation is below `thresholds.minUtilisation`,
3. best borrow APY is below `thresholds.minBorrowApy`.

The fourth is **not a measurement at all**. `samples` holds one entry, against
`thresholds.minConsecutiveDailySamples`. That is *not enough data to say yes* — it is the absence
of evidence, not evidence of absence, and **no content in a single sample could clear that bar no
matter what it contained.** A reader who counts four failures will believe the case is four times
stronger than it is.

**The no-go is overdetermined, and that is itself a risk.** Because all four fail together, a
single bug anywhere in the measurement path is invisible behind the other three: any one of them
being wrong changes nothing about the outcome, so nothing forces it to be noticed. The honest
statement today is *"nobody is borrowing Stock Tokens, on three measurements that agree with an
independent recon, and we do not yet have enough days to say so durably."*

### What the author of the measurement flagged, and what this document did about it

The probe's author recorded one suspicion that can invert this task's answer later:
**`usdValue` has never been exercised against a non-zero balance.** Every `borrowedUsd` in the file
is 0 because every `totalBorrowAssets` is 0, so the decimals-and-price arithmetic runs for the
first time in anger on the day demand actually appears — exactly the day the number starts
mattering.

**Read for this document, and here is what was checked.** The same person wrote the probe and this
rule, which is a shared blind spot rather than a bias: an assumption made while writing the
measurement is one that will not be questioned while reading its output, because to its author it
is not an assumption. So the *comparison path* was re-read, not just the comparison — the
thresholds come from the task, but the values they are compared against come from that code:

- `usdValue(assets, decimals, priceAnswer8dp)` scales by the loan token's own `decimals`, read from
  the token per market, and by the Chainlink answer's 8 decimals. **Unverified against a live
  non-zero balance.** It returns `null` when any input is null, and the sample aggregates it with
  `?? 0`, so a market whose price or decimals failed to read contributes **zero to a sum** rather
  than announcing itself. Today every term is a true zero, so the two are indistinguishable.
- `maxBorrowApy` and `maxUtilisation` are `Math.max` reductions that also coalesce a missing value
  to `0`. A market whose IRM stopped decoding would silently lower a **maximum**. Today all 12
  markets returned a rate (0.28 %–0.87 %), so nothing is being hidden — but that is a fact about
  today's data, not a property of the code.
- `utilisation` returns `0` for an empty market rather than dividing by zero, which is correct and
  is what all 12 rows exercise.

**Consequence for any future `go`:** the first sample with real borrowing is the first time these
paths carry a non-zero value, and it is also the sample most likely to be quoted. Re-read them
then. A `go` reached on arithmetic that has never run is not a `go`.

## The venue landscape, as of the 2026-09-19 recon

A dated sample, not a standing fact. Source: `v8-plan/LENDING-RECON-2026-09-19.md`.

- **Morpho Blue** is at `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` on this chain — **not** the
  canonical mainnet address, which has no code here (§2 table; `06-QUIRKS.md` §H). Twelve markets
  exist with a Stock Token as the loan asset; all twelve were at zero supply and zero borrow (§2),
  and the probe reproduced that on 2026-09-20.
- **Hedgehood StockLend** runs six stock-lending markets, all with zero on loan (§4). Its NVDA
  market reports `nextLoanId` 1, which is **consistent with** no loan ever having been opened there but
  is NOT exact: the probe derives `loansEverOpened` as `nextLoanId > 1`, and that under-reports by one if
  Hedgehood's ids start at 0 rather than 1. Its own interface is reconstructed in a doc and its bytecode
  is unverified, so the starting id is **UNVERIFIED**. The value feeds neither the sample totals nor the
  verdict, and the bias is conservative — it can only ever understate borrowing, never overstate it — so
  the `no-go` is unaffected either way. Its SPCX market's counter is 15, which
  the recon reads as up to 14 loans opened at some point, with sizes **UNVERIFIED** because records
  read back as zero after close; the probe reproduced both counters. Hedgehood's own docs describe
  the whole thing as "an operator-controlled pilot running real money, not a product with users".
  Its bytecode is unverified on the explorer, so its reconstructed interface and any bound its
  owner is said to operate within are **UNVERIFIED**.
- **Longbow** lends no Stock Token at all (§3). It is a Morpho *curator* that lets holders **borrow
  USDG or WETH against** stock — the mirror image of this feature. Its headline TVL comes mostly
  from one memecoin-style collateral. Treat "tokenized equities need a lending market" commentary
  associated with it as **claimed, not verified**.
- Everything else on the chain is dust: the recon found no Stock Token out on loan anywhere beyond
  a single-digit-dollar position (§2, §4 "Others").

## The standing risk in any future "go": the weekend oracle

This does not go away when borrowers appear, and it is specific to *this* protocol.

Read on a Saturday (2026-09-19 20:19 UTC), the NVDA Chainlink feed's `updatedAt` was **24.4 hours
old** — it had last moved five minutes before Friday's 16:00 New York close (§6). A stock-loan
market is therefore **blind from Friday's close to Monday's open**, while the tokens keep trading
on DEXes the whole time. Liquidators cannot act on a price the oracle has not printed.

That window is the same one Stonkhouse's weekly series settle into. Whether the equity feeds update
in extended hours on weekdays is **UNVERIFIED**; heartbeat and deviation thresholds are
**UNVERIFIED** (§6). Competitors price the risk rather than ignore it: Hedgehood answers it with
150 % margin, a 25 % annualised weekend rate and a 120-hour term cap (§4) — which makes borrowing
stock most expensive exactly when our series roll.

**Any `go` must state what it assumes about the weekend, or it is assuming silently.**

## What a "go" authorises, and what it does not

A `go` **authorises opening a separately claimed task** against the surfaces that would have to
change: `web/`, the site repository's landing copy, and `callhouse-docs`.

A `go` is **not itself permission to publish anything.** It is a measurement clearing a bar, not a
copy decision, and it does not travel into a commit that also changes user-facing text.

**No rate, APY, APR or projected yield is published regardless of the verdict.** Those prohibitions
stand on their own and are cited here rather than restated: `ops/publish-template.md:59-63`
(nothing annualized, no comparison to a savings rate or to another protocol's APY),
`ops/runbooks/close-week.md:509`, `ops/README.md:297`.

### This gate is procedural, not machine-enforced

Verified: `scripts/copy-lint.mjs:50` reads
`const PACKAGES = [{name: "web", dir: join(ROOT, "web")}]` — copy-lint scans `web/` and nothing
else. Two consequences, both load-bearing:

1. **This document cannot trip copy-lint**, and no `copy-lint-allow` comment is added anywhere in
   this repository on account of it.
2. **copy-lint cannot enforce this go/no-go.** The rule written here is about a claim nobody has
   made yet, and no linter can catch a sentence that has not been written. The enforcement is a
   human reading this document before writing that sentence.

copy-lint's FORBIDDEN table is a **twin** of the site repository's copy and requires paired
cross-repo commits (`scripts/copy-lint.mjs:8-14`), so changing it is a separate, Codex-owned task
and is out of scope here.

## Exact chain calls

RPC `https://rpc.mainnet.chain.robinhood.com`, chain ID 4663. The probe sends these and nothing
else; every one is read-only.

```sh
cast chain-id --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb --rpc-url https://rpc.mainnet.chain.robinhood.com
cast logs --address 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010 \
  'CreateMarket(bytes32,(address,address,address,address,uint256))' \
  --from-block 287 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010 \
  'market(bytes32)(uint128,uint128,uint128,uint128,uint128,uint128)' \
  0x2fdd5af0a36ab05917ea93b1266b15f655b920d83a497adbfadcf4fcd9b28324 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010 \
  'idToMarketParams(bytes32)(address,address,address,address,uint256)' \
  0x2fdd5af0a36ab05917ea93b1266b15f655b920d83a497adbfadcf4fcd9b28324 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x426A79a122c6A0A47fE2F5c5F41C4BC4d102c414 'nextLoanId()(uint256)' --rpc-url https://rpc.mainnet.chain.robinhood.com
```

The Morpho singleton at `0x9D53…1010` has runtime code; the canonical mainnet address returns
`0x`, which is why the probe throws rather than emitting a snapshot of zeros if the one it queries
is codeless. Every market is decoded from its `CreateMarket` log **and** read back through
`idToMarketParams`, and the probe throws if the two disagree — a wrong decoder must not be able to
publish plausible numbers. `cast code` checks are nonempty-bytecode checks, **not** source
verification: Hedgehood's contracts are unverified on the explorer.

## Open questions

- The `thresholds` values are **proposed, not owner-approved**. They are the author's, on the
  evidence in the probe's header comment. The owner has signed off on none of them.
- `ourPosition` is `null` and will stay null until P8-02 exists. Every consumer must be null-safe
  about it.
- `perpAlternative` is a stub with `verified: false`. The recon (§8) names perp funding as the real
  alternative cost of borrowing stock, but no perp venue on 4663 was read by this probe — so the
  comparison this feature is ultimately judged against is currently **unmeasured**.
- `stockLoanMarkets[].creator` is `null` on every row: the `CreateMarket` log does not carry it.
  The recon attributes the markets to specific creators (§2), so the attribution exists but would
  need a per-market transaction lookup the probe does not do.
