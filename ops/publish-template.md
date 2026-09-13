# Weekly publish template

One post every Saturday after `rollClose`, **including the weeks where nothing happened**. An unfilled
week is the most likely outcome and publishing it honestly is the product. Four published weeks —
filled or honestly unfilled — is the bar the roadmap sets before anything else ships.

Post the same text in every place: the site's cycle tape, the social account, and the indexer's
`/v1/cycles` payload. One number, one source, everywhere.

---

## Numbers to publish

Every field, where it comes from, and how to format it. Source column refers to `close-week.md` steps.

| Field | Source | Format |
|---|---|---|
| Cycle number | `vault.cycleNumber()` (snapshot, step 1) | integer |
| Week ending | `cycleExpiryTs`, rendered UTC | `Sat 2026-09-19 20:00 UTC` |
| Strike | `cycleStrikeUsdg`, USDG 6 dp | `236.00 USDG` |
| Spot at roll | `vault.spotUsdg()` recorded at `rollOpen` | `218.30 USDG` |
| OTM at roll | `(strike / spot - 1)` | `+8.1%` |
| Contracts written | `contractsWritten` (snapshot) | integer, `1 contract = 1.0000 NVDA` |
| Contracts filled | `contractsSold` (snapshot), cross-checked against `filledNumerator/filledDenominator` | integer |
| Unit price | the listing's `unitPrice6` | `4.00 USDG per contract` |
| **Gross premium** | `unitPrice6 × contractsFilled` | USDG, 6 dp |
| **Overcall fee (5%)** | `feePerContract6 × contractsFilled` | USDG. **Never entered the vault** |
| Premium received | `writerPerContract6 × contractsFilled` | USDG — what actually landed |
| Assignment proceeds | `exerciseReceived` from the vault's `ClaimRedeemed` | USDG, `0` if not assigned |
| Harvest gross | **sum** of `Harvest.grossUsdg` over this cycle's `Harvest` events | USDG = premium received + assignment proceeds |
| **Protocol fee (5% of premium)** | **sum** of `Harvest.feeUsdg` over the cycle | USDG. `0` on an unfilled week. Never charged on assignment proceeds |
| **Net premium** | premium received − protocol fee (indexer `premiumNet`) | USDG. **Premium only**: never includes assignment proceeds |
| **Net premium per share** | indexer `premiumNetPerShare`, summed over the cycle's harvests, each against its own supply | 6 dp, e.g. `0.034200 USDG`. This is the week's yield figure |
| Credited to depositors | **sum** of `Harvest.netUsdg` over the cycle (indexer `creditedUsdg`) | USDG = net premium + assignment proceeds. Assignment proceeds are returned principal, not yield |
| USDG credited per share | **sum** over the cycle of `UsdgDistributed.credited / UsdgDistributed.totalSupply`, each event against its own `totalSupply` | 6 dp. Equals net premium per share unless assigned |
| **Assigned or not** | `contractsAssigned()` (snapshot, taken **before** the close) vs `contractsWritten`, agreeing with `RollClose.contractsAssignedCount` | `not assigned` / `n of m assigned` |
| NVDA per share | `convertToAssets(1e18)` after close | 18 dp, trimmed to 6 for display |
| Listing hash | `vault.listingHash()` before close | `0x…`, linked to the explorer |
| Close tx | the `rollClose` hash | linked to the explorer |

Formatting rules:

- USDG has **6 decimals**. Print `4.000000`, not `4000000`.
- One contract is **1.0000 NVDA** (lot size `1e18`). Never print a fractional contract.
- `uiMultiplier()` is display only — apply it to the share-equivalent line if the UI shows one, and to
  nothing else. The Chainlink spot already includes it, so never apply it twice.
- Percentages get one decimal place. Currency gets the token's own decimals.
- **Sum the cycle, never read one event.** `deposit` and `mint` run `_checkpointHarvest()`, so a fill
  followed by a deposit splits the week across two `Harvest` events and two `UsdgDistributed` events.
  Publishing off the close's event alone under-reports the week, and in the worst case prints
  `unfilled, 0` for a week that actually filled. `Harvest.cycleNumber` is indexed — filter on it.

---

## Numbers never to publish

Hard rules. CI lints the site copy for these; the post is held to the same standard.

- **Anything annualized.** No APY, no APR, no "×52", no "annualized yield", no "run rate". A weekly
  covered-call premium is not an interest rate and multiplying it by 52 is a claim about the future.
- **No projection of any kind.** No "expected", no "targeting", no "should earn", no range.
- **No "10% weekly"** or any other rate framing of a single week's result.
- **No comparison to a savings rate, a bond, a T-bill, or another protocol's APY.**
- **No "backed by Nvidia", no "Nvidia dividend", no "NVDA stock".** Stock Tokens are debt securities
  issued by Robinhood Assets (Jersey) Limited. Not equity, no vote, no claim on Nvidia.
- **No TVL milestone framing.** The deposit cap is 20 NVDA at launch on purpose.
- **No "guaranteed", "risk-free", "stable", "safe".**
- **No number from Overcall's API presented as a vault number.** Their `realisedPremium6` is the
  writer's **net** leg despite their docs calling it gross. NAV math comes from USDG that actually
  landed in the vault, never from an API field.
- **No aggregate across weeks that smooths a zero.** Publish each week on its own. A running total is
  fine; an average that hides an unfilled week is not.

---

## Template A — filled, not assigned

> **Callhouse cNVDA — week {N}, ending Sat {YYYY-MM-DD} 20:00 UTC**
>
> Filled.
>
> - Strike: **{S}.00 USDG** ({OTM}% out of the money at roll; spot was {SPOT} USDG)
> - Contracts written: **{W}** (1 contract = 1.0000 NVDA)
> - Contracts filled: **{F}** at **{U} USDG** per contract
> - Gross premium: **{GROSS} USDG**
> - Overcall fee (5%): **{OCFEE} USDG**
> - Premium received by the vault: **{RECV} USDG**
> - Protocol fee (5% of premium): **{PFEE} USDG**
> - Net to depositors: **{NET} USDG**
> - **Net USDG per share: {PPS} USDG**
> - **Not assigned.** All {W} NVDA came back.
>
> Claim your USDG at {site}/vault/nvda. Listing `{hash}` · close tx `{tx}`.
>
> Premium is paid only if a buyer fills the listing. Some weeks nobody buys and the result is 0.

## Template B — unfilled

The one that matters. Use it without apology or hedging. **Only if nothing was assigned**: Valorem
assigns exercises across every writer of the option series, so an unfilled week can still be
assigned. If `RollClose.contractsAssignedCount > 0`, use Template C with "Contracts filled: 0" and
"Premium received by the vault: 0 USDG".

> **Callhouse cNVDA — week {N}, ending Sat {YYYY-MM-DD} 20:00 UTC**
>
> **Unfilled. 0.**
>
> - Strike listed: **{S}.00 USDG** ({OTM}% out of the money at roll; spot was {SPOT} USDG)
> - Contracts written: **{W}**
> - Asked: **{U} USDG** per contract
> - Contracts filled: **0**
> - **Premium: 0 USDG**
> - **Protocol fee: 0 USDG** — the fee is charged only on premium, so an unfilled week costs
>   depositors nothing
> - **Net USDG per share: 0.000000 USDG**
> - **Not assigned.** All {W} NVDA came back.
>
> Nobody bought the calls. That is the ordinary outcome of an empty book and it is why this vault
> promises USDG or nothing rather than a yield.
>
> Listing `{hash}` · close tx `{tx}`.

## Template C — assigned

> **Callhouse cNVDA — week {N}, ending Sat {YYYY-MM-DD} 20:00 UTC**
>
> Filled, and **assigned {A} of {W}**.
>
> - Strike: **{S}.00 USDG**
> - Contracts filled: **{F}** at **{U} USDG** per contract
> - Premium received by the vault: **{RECV} USDG**
> - Assignment proceeds: **{ASSIGN} USDG** ({A} × {S}.00)
> - Protocol fee (5% of premium; none on assignment proceeds): **{PFEE} USDG**
> - **Net premium per share: {PPPS} USDG** — the week's yield
> - Credited to depositors: **{CREDIT} USDG** (net premium plus the assignment proceeds, which are
>   the assigned tokens' sale price, not yield); {PPS} USDG per share
> - NVDA per share is now **{NPS}**, down from {NPS_PRIOR}
>
> The calls were exercised, so {A} NVDA left the vault at the strike and {ASSIGN} USDG came back in
> its place. **The vault is underweight NVDA.** v1 does not buy it back — new deposits do that
> passively. Upside above {S}.00 was capped this week; that is the trade.
>
> Valorem assigns by bucket rather than pro-rata, so being assigned more or less than the fill share
> is normal.
>
> Close tx `{tx}`.

## Template D — no write

For a week with no eligible rung, no cycle, a paused oracle, or a halt.

> **Callhouse cNVDA — week {N}, ending Sat {YYYY-MM-DD} 20:00 UTC**
>
> **No calls written. 0.**
>
> Reason: {one of — no rung inside the 3–12% band at roll; Overcall did not open a cycle; the issuer
> paused the token's oracle; writes were halted by the guardian}.
>
> - Contracts written: **0**
> - **Premium: 0 USDG**
> - **Protocol fee: 0 USDG**
> - **Net USDG per share: 0.000000 USDG**
> - All NVDA stayed in the vault and stayed idle. Deposits and redemptions were unaffected.
>
> The vault only sells a call when a strike is far enough out of the money and the premium clears the
> floor. When neither is true it holds spot and writes nothing.

---

## Required disclosures

At least one of each per post, or a visible link to a page carrying all four:

1. **Legal form.** NVDA Stock Tokens are debt securities issued by Robinhood Assets (Jersey) Limited.
   Not equity in Nvidia, no vote, no dividend from Nvidia. The issuer can freeze transfers.
2. **Assignment.** A filled call can be exercised. The tokens leave at the strike and upside above it
   is capped.
3. **Empty-book weeks.** Premium is paid only if a buyer fills. Some weeks nobody buys and the answer
   is 0.
4. **Geography.** Not available to US persons — the same perimeter as Stock Tokens.

---

## Pre-publish checklist

- [ ] Every number traced to a chain read or an event in the close transaction, not to an API field
- [ ] `gross premium == Overcall fee + premium received`, to the unit
- [ ] all of this cycle's `Harvest` events collected (filter the indexed `cycleNumber`), and their summed `harvest gross == premium received + assignment proceeds`, to the unit
- [ ] each `Harvest` event's `feeUsdg == floor((grossUsdg − usdgFromAssignment) × protocolFeeBps / 10000)`, with `usdgFromAssignment` from the `RollClose` in the same transaction (`0` for a checkpoint `Harvest` from a deposit); at launch that is 5% of premium received, never 5% of harvest gross on an assigned week. The summed fee matches the fee Safe's balance delta and is **0** if no premium was received
- [ ] `net USDG per share == credited / totalSupply` from each `UsdgDistributed` event and summed, not
      recomputed from a post-close `totalSupply()` read
- [ ] Assignment taken from the pre-close snapshot and agreeing with `RollClose`'s
      `contractsAssignedCount`, **and** independently with
      `contractsWritten - underlyingReturned / 1e18` from the vault's `ClaimRedeemed`
- [ ] Zero annualized, projected, or comparative numbers anywhere in the text
- [ ] All four disclosures present or linked
- [ ] The same numbers appear on `/vault/nvda`, in `/v1/cycles`, and in the post
- [ ] Explorer links resolve (`https://robinhoodchain.blockscout.com/tx/{hash}`)
- [ ] If the week was unfilled, the post says `unfilled, 0` in those words, near the top, without
      softening
