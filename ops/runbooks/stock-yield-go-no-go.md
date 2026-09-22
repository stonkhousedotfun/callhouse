# Runbook — stock-yield go/no-go sampling

**What this is for.** Board task P8-04 says nothing about stock yield is advertised before
borrowers exist. The measurement is `ops/recon/r14-stockloan-probe.mjs`; the decision rule is
[`ops/recon/R14-STOCKLOAN-DEMAND.md`](../recon/R14-STOCKLOAN-DEMAND.md). This is the procedure that
runs the one and feeds the other.

**Read the decision document first if you have not.** In particular the section on why the current
`no-go` is overdetermined, and why three of the four `verdict.reasons` are measurements while the
fourth is the absence of one.

---

## NOTHING RUNS THIS AUTOMATICALLY

There is no cron, no CI job and no keeper behind this. `ops` is not a pnpm workspace package
(`pnpm-workspace.yaml` lists `keeper`, `indexer`, `web`, `relay`, `notifier`), so the repository's
`pnpm -r test` never reaches it, and `v8-plan/06-QUIRKS.md` §A.5 states in as many words that ops
checks are not in CI.

**The schedule below depends on a human remembering.** That is written down rather than assumed,
because the bar this feature is judged against is a count of *consecutive daily* samples, and a
missed day does not fail loudly — it silently resets the trailing run that
`thresholds.minConsecutiveDailySamples` measures. A gap costs the whole streak, not one day.

If this feature becomes live work, the first improvement is to put the probe behind something that
does not forget. Until then, the owner or the operator runs it.

---

## Who runs it, and how often

| | |
|---|---|
| **Who** | The operator, or whoever the owner delegates. It needs no key and no privileged access. |
| **How often** | Once per day, on the same calendar day boundary each time (`sample.date` is a UTC date). |
| **Where** | Any callhouse worktree on `v8` that carries `ops/recon/`. |
| **Owner gate** | **Required before the first call of any session.** See below. |

### The owner gate is not optional and does not travel

The probe makes live read-only JSON-RPC calls to a third-party endpoint. That needs a **per-task
owner gate**, obtained through the coordinator.

A task contract that mandates the reads is **not** that gate — if a contract could authorise its
own network access the gate would mean nothing, because every task wanting network access would
simply say so. A grant is bound to the task it was given for: it does **not** travel to a successor
task id, another lane, another endpoint, or a method outside the list the grant names. On
2026-09-20 the owner granted read-only calls to `https://rpc.mainnet.chain.robinhood.com` using the
committed probe for the remainder of that run; that grant expired with the run.

If you find yourself reasoning about whether something is close enough to a previous grant, it is
not. Ask.

---

## Running it

```sh
cd <a callhouse worktree on v8>
node ops/recon/r14-stockloan-probe.mjs
```

It prints the block scanned, the market counts, where it wrote, and the verdict with its reasons.
It rewrites `ops/recon/r14-stockloan-demand.json`, **appending** one dated entry to `samples`.

Then commit the file. A sample that is not committed did not happen — the next run reads the
committed file as its history, so an uncommitted run is a day thrown away.

### `samples` is append-only, and a clobbered run cannot be recovered

Each run carries every earlier entry forward untouched and adds one. **Never hand-edit `samples`,
never reorder it, never drop an entry, and never regenerate the file from anything but a real run.**

A day that has passed cannot be re-measured. There is no archive query that reconstructs it and no
way to go back. A run that clobbers history makes the go/no-go permanently unanswerable, so this is
the one rule in this runbook with no recovery procedure attached — only prevention.

**Never hand-write, stub, or partially populate the JSON, and never generate it from the probe's
test fixtures.** A synthetic file satisfies every structural assertion and every key the decision
document cites while being fiction. This workspace has already paid for that failure mode once, in
a stubbed dependency whose identity function made assertions *pass* rather than fail.

### Sanity-check the run before trusting it

The probe throws rather than emitting zeros if the Morpho singleton has no code, and throws if a
market decoded from a `CreateMarket` log disagrees with `idToMarketParams`. Two things it cannot
catch on its own:

- **A truncated log scan.** If the created-market count comes back far below what the last run saw,
  suspect that `eth_getLogs` returned less than the full range, not that the chain changed. An
  endpoint that answers a too-wide window with an empty array rather than an error would produce
  zero markets and no error at all — the worst outcome this tool can have. The 2026-09-20 run saw
  273 created and 12 stock-loan; the independent recon of 2026-09-19 saw 271 and 12.
- **A plausible-but-wrong dollar figure**, the first time any market has a non-zero balance. See
  the decision document: that arithmetic has never been exercised against a non-zero input.

---

## `--check`: what a drift means

```sh
node ops/recon/r14-stockloan-probe.mjs --check
```

Re-reads the chain and compares against the committed JSON. **Writes nothing** — it is safe to run
against a clean tree, and it is the right mode when you want to know whether anything moved without
producing a sample.

| Exit | Meaning | Do |
|---|---|---|
| `0`, "no material drift" | The market set and its immutable parameters are as committed. | Nothing. |
| `1`, market **appeared** | A new Stock-Token loan market exists on chain. | **This is the tool working.** Run the probe properly so the new market enters `stockLoanMarkets` and the sample. Worth telling the owner: a new market is the first thing that would precede real demand. |
| `1`, market **disappeared** | A market in the committed file was not found on chain. | Do not assume it was removed — Morpho markets are immutable and do not vanish. Suspect a truncated scan first, and re-run before concluding anything. |
| `1`, **loan/collateral/oracle/IRM/LLTV changed** | An immutable parameter differs from the committed file. | Treat as a **bug in the tooling or a wrong committed file until proven otherwise**, not as chain news. These fields cannot change for a given market id. |
| `1`, **verdict flipped** | The decision changed. | Follow the section below. |
| `1`, **Morpho code presence changed** | The singleton lost or gained code. | Stop and escalate. Nothing else in this runbook applies. |

Utilisation and rate moving are deliberately **not** drift. Those are what the probe exists to
watch change.

---

## When the verdict moves

### To `go`

**A `go` does not act on its own, and nobody publishes anything on the strength of it.**

1. **Report it to the owner.** That is the whole of the immediate action.
2. Before anyone relies on the dollar figures, re-read the `usdValue` path — the first sample with
   real borrowing is the first time that arithmetic carries a non-zero value, and it is also the
   sample most likely to be quoted.
3. Check that the `go` is not resting on a short streak that happens to have just reached the bar.
   Look at the trailing entries in `samples`, not only `verdict`.
4. If it survives all of that, a `go` **authorises opening a separately claimed task** against
   `web/`, the site repository and `callhouse-docs`. It is not permission to publish, and no copy
   change is ever smuggled in with a measurement commit.
5. **No rate, APY, APR or projected yield is published regardless** — see
   `ops/publish-template.md:59-63`, `ops/runbooks/close-week.md:509`, `ops/README.md:297`. A `go`
   changes what may be *described*, never what may be *quoted as a number*.

Note that `scripts/copy-lint.mjs` scans `web/` only, so it cannot enforce any of this. The
enforcement is a person reading the decision document before writing the sentence.

### To `no-go`, after a `go`

Demand that appeared has gone away, or a threshold stopped being met.

1. **Report it to the owner immediately**, and with more urgency than a flip to `go`. If anything
   public was opened on the strength of the earlier `go`, it is now describing a state that no
   longer holds.
2. Identify which of `verdict.reasons` changed. A flip driven by the sample count is a gap in the
   schedule — a process failure, ours. A flip driven by one of the measured quantities is the
   market moving, theirs. **They need different responses and must not be conflated.**
3. Do not resume any public claim until a fresh `go` clears on its own terms. A verdict that has
   oscillated is weaker evidence than one that has never moved, not equal evidence.

### Staying at `no-go`

Nothing to do but keep sampling. This is the expected state: as of 2026-09-20 there is no borrowing
of Stock Tokens on this chain at all, on three measurements that agree with an independent recon.
The streak is the only thing accumulating, and it only accumulates if someone runs this.
