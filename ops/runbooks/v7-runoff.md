# Runbook — v7 freeze and run-off

The operator-side procedure for winding v7 down after v8 verifies. It is the app-repo companion to
the contracts-side document, which is the **authority on what the freeze does**:

- `callhouse-contracts` `docs/V7-RUNOFF.md` — what the two calls do, what they deliberately do not
  do, what a v7 holder can still do afterwards, and when the run-off ends.
- `callhouse-contracts` `script/v2/FreezeV7.s.sol` — the tool. It reads the live set, builds the
  plan, refuses to build a wrong one, and prints the post-check.

This runbook does not paraphrase either. Where a fact belongs to the contracts side, it is cited
with its file and line so you can read the original.

> **Two files share the name `docs/V7-RUNOFF.md`.** Every unqualified `docs/V7-RUNOFF.md` below
> means the **contracts-side** document named above. This repository now also has one, added by
> T-233: `docs/V7-RUNOFF.md` in *this* checkout is the **deployment pin** — what keeps the v7
> indexer and cranker running — and §5a always qualifies it as "this repo's". The collision is
> ugly and is recorded in the deferred-verification ledger with a rename recommendation.

**Every step below says what it looks like when it has WORKED and what it looks like when it has
FAILED.** That is deliberate. A run-off step that silently skips its check reads identical to one
that passed it, and this workspace has already shipped three checks that passed because they could
not see the thing they were checking.

---

## Preconditions — read these before you touch anything

**1. v8 must have verified first. This is an ordering constraint, not a preference.**

The run-off is downstream of launch verification (`v8-plan/tasks/O-ops.md`, O8-07). v7 is frozen
only *after* v8 is verified and working. If v8 has not verified, **stop here** — and note that
stopping here is a completely clean state: nothing has been sent, nothing is paused, v7 continues to
operate exactly as it did. There is no half-frozen condition to unwind.

**2. Know which Clearinghouse you are freezing. This one has bitten already.**

`ops/markets/v7-legacy.json` carries **two different** clearinghouse values:

| Key | Value | What it is |
|---|---|---|
| `v2.contracts.clearinghouse` | the v7 Clearinghouse | **use this one** |
| `shared.clearinghouse` | the V1 Clearinghouse | do **not** use this for the freeze |

Read the correct one, never a pasted hex:

```sh
node -e 'console.log(require("./ops/markets/v7-legacy.json").v2.contracts.clearinghouse)'
```

It must equal `FreezeV7.CLEARINGHOUSE` (`script/v2/FreezeV7.s.sol:153`). **Worked:** the two
strings are identical. **Failed:** they differ — stop, and do not "fix" it by editing either side.
One of them is wrong and which one is wrong decides whether you are about to send an admin call to
the wrong contract.

The same file's `v2.interfaceVersion` is `7` and its `v2.deployBlock` is the v7 deploy block; those
are the markers that you are reading the legacy registry and not the live v8 one.

**3. The freeze is instant and there is no timelock.**

v7 has no AccessManager and no delay — that arrives with v8 (`docs/V7-RUNOFF.md`, "What the freeze
does"). Each call is effective in the block it lands. There is no scheduled-then-execute window in
which to change your mind, so the abort point is **before** step 4 and nowhere after it.

---

## Why FreezeV7 declares the v7 tuples locally

`FreezeV7.s.sol:6-18` declares `MarketConfigV7` and `SeriesV7` **in the script**, rather than
importing them from `src/v2`. Its own comment gives the reason, and it is the single most important
thing to understand before you sign anything:

> the v7 market row as the LIVE Clearinghouse stores it … `src/v2` on the `v8` branch is a different
> contract and a tuple change there must never silently change the calldata the owner signs.

`src/v2` on the `v8` branch is **v8's** Clearinghouse. If the script imported its structs, then a
v8-side field addition would silently re-shape the calldata for a call aimed at the **deployed v7**
contract — and it would still compile. The local declaration is what makes that impossible.

The same reasoning pins the selector: `FreezeV7.SET_MARKET_CONFIG` (`FreezeV7.s.sol:184`) and
`SET_CREATE_PAUSED` (`:183`) are the only two selectors a freeze plan may hold, enforced at
`:487`. **Do not retype those tuples or selectors into a ticket, a Safe description or this
runbook.** Read them from the script.

---

## 0. Read the live set

Run the tool. It sends nothing.

```sh
# from the callhouse-contracts checkout, on the v8 branch
forge script script/v2/FreezeV7.s.sol --rpc-url "$RH_RPC" -vv
```

**Worked:** it prints the switches, every series with its expiry and settled flag, the run-off dates,
and a plan; it writes `broadcast/freeze-v7-guardian-safe-batch.json` and
`broadcast/freeze-v7-admin-safe-batch.json`.

**Failed, and each means something different:**

- It plans **0 calls** on a first run → the set is already frozen. Do not proceed; find out who
  froze it.
- It refuses with *"a freeze plan holds setCreatePaused and setMarketConfig only"* (`:487`) → the
  plan tried to build a call outside the two allowed selectors. This is the guard working. Stop.
- It refuses because a registered, still-enabled market was left out (`FreezeV7.freezeSet`) → the
  market list it read does not match what you expect. Stop and reconcile before sending anything.
- It errors reading the chain → you are pointed at the wrong RPC or the wrong Clearinghouse. Re-check
  precondition 2.

**Re-run this at freeze time and quote its numbers.** The figures in `docs/V7-RUNOFF.md` under
"The live set" are C8-12's fork dry-run record at block 67,497,154, not a standing fact — the live
pricer keeps opening series until the freeze actually lands.

## 1. Rehearse on a fork — mandatory

The contracts side treats this as a gate, not an option. C8-12 recorded a genuinely forked run of
8/8 at chain 4663 block 67,497,154; **that is C8-12's evidence, not yours.** You still run your own.

**Worked:** the rehearsal applies the plan from the real role holders and then proves that `close`,
`redeem`, `withdraw`, `cancel` and resale all still work afterwards.

**Failed:** any of those post-freeze operations reverting is a stop. The freeze is supposed to stop
*new risk*, not to trap anyone who already holds something.

## 2. Send the two calls — guardian first

Guardian's `setCreatePaused(true)` goes first, because it is the one that covers every market
(`docs/V7-RUNOFF.md`, "What the freeze does"). Then admin's `setMarketConfig(NVDA, enabled = false)`,
which is what stops `mint` on the 32 series that already exist.

Use a Foundry keystore account. **Never put a key on the command line** — `--private-key` takes its
value as an argument, so `ps -axww` shows it for the lifetime of the send.

```sh
cast send "$CLEARINGHOUSE" 'setCreatePaused(bool)' true --account <keystore-name> --rpc-url "$RH_RPC"
```

Or import the generated batch files on the corresponding Safes. Those files carry **no checksum**, so
Safe{Wallet} will warn you. Decode every call before signing.

**Worked:** the decoded `setMarketConfig` shows NVDA and the market row with `enabled = false` and
**every other field exactly as step 0 read it**.

**Failed:** any other field differs. That is not a cosmetic difference — it means the row you are
about to write is not the row the chain currently holds. Do not sign. The script is built to refuse
this (`_checkFreezeOnly`), so a difference reaching the Safe means something upstream is wrong.

## 3. Verify

Re-run step 0.

**Worked:** it plans **0 calls** and prints the post-check.

**Failed:** it still plans calls → one of the two sends did not land. Check which, and send only that
one. A post-check that reports the **order book paused** is also a failure
(`test_postCheck_failsWhenTheBookWasPaused`): pausing the book is deliberately not part of the
freeze, because taking away resale takes away the only way a holder has to sell a long before
expiry.

## 3a. The app-side tool: `ops/v8/freeze-v7.mjs`

Steps 2 and 3 in one command, with the readbacks and the run-off checks the manual path leaves to you. It
takes its targets from `ops/markets/v7-legacy.json` (`v2.contracts.clearinghouse`, never
`shared.clearinghouse`), signs only through `cast send --account <keystore name>`, and reads every URL from
the environment: `RH_RPC`, `V7_CRANKER_HEALTH_URL` (the v7 cranker's full `/health` URL) and
`V7_INDEXER_HEALTH_URL` (the v7 indexer's full `/v2/health` URL). None of them goes on the command line.

```sh
# from this checkout; the three URLs are already exported in this shell
node ops/v8/freeze-v7.mjs                                   # dry run: the plan, no RPC, nothing sent
node ops/v8/freeze-v7.mjs --check --chain-id 4663           # read-only: state, readback, run-off
node ops/v8/freeze-v7.mjs --execute --chain-id 4663 --guardian-account <guardian-keystore> --admin-account <admin-keystore>
```

`--execute` refuses before it sends anything if the RPC is not chain 4663, if a role holder lacks its
role, if a registered market is enabled but missing from `waves.live`, if either call reverts in
simulation, or if the v7 cranker or v7 indexer is **already** unhealthy (so a dead service is not blamed
on the freeze afterwards). It sends the guardian call first, then the admin call, and then decides the
outcome from the chain alone. A receipt is never the verdict.

**Worked:** it prints `READBACK PASS` twice, then `RUN-OFF PASS`, then `FROZEN: both readbacks agree and the
run-off path is intact.` and exits 0. The readback it passed was: `createPaused() == true`; every live
market's `enabled == false` with every other field unchanged, both against its own pre-send read and against
the chain's `MarketConfigSet` history; the book not paused; no series created after the pause and no unit
minted after the disable; the v7 cranker's `/health` answering for the v7 Clearinghouse and the v7 cranker
signer with a head block past the freeze; the v7 indexer's `/v2/health` at `interfaceVersion` 7, `ok`, and
indexed past the freeze; every unsettled series settling in simulation without a revert.

**Failed, and each means something different:**

- `REFUSED` before `SENDING` → nothing was sent. v7 is unchanged. Read the reason; this is the clean abort.
- `SEND FAILED after N successful call(s)` → a send did not land, or landed signed by the wrong account.
  The message reads the chain back and names the state. `HALF-APPLIED: paused, but NVDA still enabled` is
  the dangerous one: new series ids are stopped, mint into the series that already exist is **not**. Re-run
  `--execute`; it sends only what is missing.
- `READBACK FAILED (state …)` → the sends reported success and the chain disagrees. The freeze is **not**
  done, whatever the receipts said. The lines under it name each fact that does not hold.
- `RUN-OFF FAILED` → frozen, but the run-off path is not intact: the cranker or indexer is not the v7 one,
  is not ticking past the freeze, or a series will not settle. `reverts MarketDisabled` or
  `reverts CreatePaused` from a settle means the freeze is blocking settlement, which it must never do.
- `UNPROVEN` with **exit code 3** → frozen and read back, but some unsettled series could not be simulated
  past their expiry (the node ignored or refused the `eth_call` block-time override). This is not a pass.
  Re-run `--check` after the next expiry has passed and settled.

**How to tell a half-applied freeze from a clean one.** Run `--check`. The first line after the targets is
`STATE:` and it is one of three things:

| `STATE:` | Meaning |
|---|---|
| `LIVE` | Not paused, every live market enabled. Nothing has been sent. Clean. |
| `HALF-APPLIED` | One half is on chain and the other is not; the line names which. Not clean. Never leave it here. |
| `FROZEN` | Both flags read right. Clean **only if** the readback that follows also passes: a series created or a unit minted after the freeze fails it even though both flags read right. |

Expect one cranker tick error right after the freeze if a tick was mid-cycle when the pause landed (a
`createSeries` simulated before the pause and sent after it reverts `CreatePaused`). That is recorded on the
cranker's `/health` as `lastTickError`, and it does not fail the tool; a heartbeat that stops does.

## 4. During the run-off

What still works, and must keep working — the freeze does not touch any of it
(`docs/V7-RUNOFF.md`, "What the freeze does not do"):

- settlement, redemption and `redeemBatch` — every expiry after the freeze settles and pays exactly
  as it would have;
- `close`, `withdraw`, `cancel`, and resale of an existing long;
- the AutoRoller's close-out half, so a writer can still get out.

A resting `AskWrite` can no longer fill — the book reads the market's `enabled` when it plans a fill
and plans the order as a skip. It escrows nothing, so no funds sit behind it. `Bid` and `AskResale`
keep their escrow and their maker can `cancel` at any time.

If the cranker is off, anyone can settle an expiry from their own wallet; see the command in
`docs/V7-RUNOFF.md`, "Owner commands", step 5.

**Two dates, and they are not the same date** (`docs/V7-RUNOFF.md`, "When the run-off ends"):

- **when the last position expires** — the largest expiry among series that still carry units;
- **when the last settlement job is due** — the largest expiry among series that *exist*.

Both are computed by the tool, never assumed. The hard ceiling is freeze time + `MAX_TENOR`
(45 days, `V2Constants.MAX_TENOR`): no series created before the freeze can expire later than that.

## 5. Switching services off

Driven by the table in `docs/V7-RUNOFF.md`, "When the v7 services can be switched off". Do not
switch anything off on a date; switch it off when the condition in that table is met.

**The failure to watch for:** turning the cranker off while an unsettled expiry with open interest
remains. Settlement then depends on somebody noticing. That is recoverable — `settle` stays callable
by anyone for ever — but it is recoverable only if someone is still looking.

## 5a. The deployment pin — what keeps the v7 images running

§5 says when the v7 services may be switched **off**. This section is the other half: what stops
them being switched **over** while the run-off is still open.

**The fact that makes this necessary:** there is no separate v7 service. The v7 indexer and cranker
are `indexer-v2` and `cranker` — the same two service names `ops/go-live-v2.sh` deploys into
(`ops/go-live-v2.sh:104` and its ordered service list; `ops/deploy.md:1584` probes those names and
records `interfaceVersion 7` coming back). No `railway.json` in this repository pins an image, a tag
or a digest; every one builds from source. So "the v7 bots keep reading the frozen registry from
their own v7 image" is, today, a description of an image nothing holds still.

**What a rebuild does.** A v8 keeper handed `ops/markets/v7-legacy.json` refuses totally and exits
(`keeper/src/v2/registry.ts:573-585`). That refusal is loud and correct — the process dies instead
of mispricing a set it cannot read — but operationally it means **the v7 cranker stops**, and
expired v7 series then settle only when somebody notices. §5's failure-to-watch-for, arrived at by
accident instead of by decision.

**The pin.** This repo's `docs/V7-RUNOFF.md` carries a `v7-pin` block naming the project, the
environment, both services, both service ids, the commit and image digest each one currently runs,
and a `runoff_open` switch. Fill it from Railway before the cutover and commit it.

```sh
ops/go-live-v2.sh --check-v7-pin                      # the pin alone, deploys nothing
ops/go-live-v2.sh --check-v7-pin --services cranker   # what the cutover would hit
```

**Worked:** `v7 pin: run-off OPEN; indexer-v2 and cranker are pinned at <sha> / <sha>`, exit 0. Once
released: `v7 pin: run-off CLOSED by <name> at <ts>`, exit 0.

**Failed:** a `REFUSED: v7 pin: …` line naming the exact field, exit 1. Every one of these refuses,
and that is the design — an unfilled pin is an unanswered question, not permission:

| what you did | what you see |
|---|---|
| deployed `cranker` or `indexer-v2` with the run-off open | `cannot deploy cranker while the v7 run-off is open` |
| committed the pin as an unfilled template | `project_id is empty: the pin was committed as a template and never filled in` |
| deleted a field | `cranker_commit is absent from the pin block` |
| deleted the file, or renamed the fenced block | `… not found or unreadable. An absent pin is a refusal, not an open road.` / `no \`\`\`v7-pin block` |
| set `runoff_open: no` without saying who | `runoff_open is no but released_by is empty: an unattributed release is refused` |

The gate runs inside the ordinary preflight, in the dry run too, before any Railway call — so a
refusal costs nothing. It is **skipped on the dev project**, which has no v7 deployment, and says so
in a note when it skips.

**What the pin does not do.** It guards one path: this script. It cannot stop a Railway-side
redeploy, a `railway up` typed by hand, or a push that trips a service's `watchPatterns` and
rebuilds it automatically. Those stay owner discipline. What the pin buys is that the one automated
path that would silently replace the v7 runtime now stops and says why.

---

## Abort points

| Where | Abort is clean? |
|---|---|
| Before step 2 | **Yes, completely.** Nothing sent, nothing paused, v7 unchanged. |
| Between the guardian call and the admin call | Partially. New series ids are stopped; `mint` into the 32 existing series is not. This is a real intermediate state, so do not leave it there — either complete step 2 or reverse the guardian call deliberately. |
| After both calls | There is no abort. The freeze is instant and has no timelock. Reversing it is a fresh, deliberate owner decision with its own reason. |

## What this runbook does not cover

- **v1.** The v1 solo markets have their own freeze and their own runbook
  (`ops/runbooks/v1-runoff.md`, and `docs/V1-RUNOFF.md` on the contracts side).
- **Pausing the order book.** Deliberately not part of the freeze, and `FreezeV7.s.sol` cannot even
  encode it.
- **User-facing copy.** Nothing here authorises a public statement; that is a separately claimed task.
