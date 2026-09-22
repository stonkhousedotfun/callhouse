# Runbook — MakerVault canary and buyback enable (OWN8-07, OWN8-08)

Two owner operations that look independent and are not:

- **OWN8-07** — set the MakerVault's guard rails, **read them back from chain**, and only then fund the
  vault from the Treasury Safe.
- **OWN8-08** — set the buyback cap to 50 USDG, read it back, and then **prove a burn was indexed** before
  anybody calls the flywheel "working".

Both are driven by two scripts that plan and verify and **never send a transaction**:

```
node ops/v8/makervault-canary.mjs    # OWN8-07
node ops/v8/buyback-enable.mjs       # OWN8-08
node --test ops/v8/makervault-canary.test.mjs   # covers both modules
```

Every state change below is signed by a Safe, by you. The scripts emit the calldata, name the role and the
execution delay that govern it, and afterwards read the chain back. They hold no key, accept none in argv, and
have no signing path at all.

> **The ordering in OWN8-07 is structural, not advisory.** `MakerVault.deposit` is permissionless
> (`contracts/src/v2/mm/MakerVault.sol:251`): once USDG is in the vault, no second transaction pulls it back
> out except an admin `withdraw`, which is a delayed call. So funding an unlimited vault is the mistake that
> cannot be undone by sending something else. `ops/v8/makervault-canary.mjs` will not emit a funding
> instruction unless a `limits()` readback matched the registry **in the same process run** — the funding
> step takes a proof object that only the readback mints, so no flag order and no typo can reach it. Deleting
> that gate turns three tests red (see `FUNDING IS UNREACHABLE WHEN THE LIMITS READBACK FAILED`).

Related pages: `ops/runbooks/v8-roles.md` (schedule → wait → call the target directly, and how to read a role
id or delay out of the manifest instead of retyping it), `ops/runbooks/v8-safes.md` (how a Safe signs),
`ops/alerts.md` (what the monitor pages when this goes wrong), `ops/runbooks/v8-launch.md` (where OWN8-07 and
OWN8-08 sit in the launch order).

---

## 0. Shell setup

```bash
# from the app repo root
REG=ops/markets/tier1.json
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export V2_INDEXER_URL=https://<the v8 indexer base URL>      # no trailing /v2
```

`RH_RPC` and `V2_INDEXER_URL` come from the environment and are never accepted in argv, because the production
endpoints embed credentials and argv ends up in shell history and in logs.

**An address the registry has not been written back yet is `null`, not `address(0)`.** Both scripts refuse on a
`null`, naming the key:

```
REFUSED: MakerVault: v2.contracts.makerVault is null - the v8 deploy has not been written back
         (ops/markets/write-back-v8.mjs). Nothing to verify.
```

That refusal is the correct outcome before `O8-08` has run. It is not a reason to type an address into the
command; run the write-back generator.

---

## 1. OWN8-07 — limits, readback, then funding

### 1.1 Emit the plan (no RPC, no key, no send)

```bash
node ops/v8/makervault-canary.mjs
```

**Success looks like** the six `Limits` fields printed straight out of `tier1.json` `v2.vault`, the
`setLimits` calldata (selector `0x6693cc27`), the governing role and its delay, and then:

```
step 2 - readback: NOT RUN (dry run).
step 3 - funding: UNREACHABLE. No readback ran, so no proof exists and fundingPlan() refuses.
```

**FAILED looks like** any line beginning `REFUSED:` and exit 1. The ones you will actually hit:

| refusal | what it means |
|---|---|
| `v2.contracts.makerVault is null` | the v8 deploy is not written back yet — run `ops/markets/write-back-v8.mjs` |
| `the registry disagrees with itself: v2.contracts.makerVault=… but v2.protocolAddresses.makerVault=…` | the registry was hand-edited; `protocolAddresses` is a **mirror** the generator rebuilds |
| `v2.vault.maxDailyOutflow: absent` | somebody removed a limit from the registry. The script has no default to fall back on, deliberately |
| `v2.vault.askToleranceBps: 10001 exceeds 10000` | the contract would reject this; better to find out here than in a Safe |

### 1.2 Schedule, wait, send

`setLimits` is a **delayed** call. Read which role and how long from the manifest — do not retype either:

```bash
node -e 'const r=require("./ops/abis/v2/roles.json");const s="setLimits((uint64,uint128,uint16,uint16,uint32,uint128))";
const role=r.targets.MakerVault[s];console.log(role, r.roles[role], r.delaysS[role]+"s")'
```

At the time of writing that prints `TREASURY_ADMIN 4 86400s`, and the script prints the same numbers from the
same file. Follow `ops/runbooks/v8-roles.md` §4: the Admin Safe **schedules** the operation on the
`AccessManager`, waits out the delay, and then sends the call **to the MakerVault directly**.

**FAILED looks like** `AccessManagerUnauthorizedAccount` (the Safe does not hold the role) or a revert on the
direct send (the delay has not elapsed, or the operation was never scheduled). Neither is retried by sending
harder — re-read the role manifest and the schedule id.

### 1.3 Read the limits back from chain

```bash
node ops/v8/makervault-canary.mjs --execute --chain-id 4663
```

`--execute` here performs the **read-only** verification. It sends nothing.

**Success looks like** every field echoed from `limits()` followed by:

```
  VERIFIED - every field matches the registry.
```

**FAILED looks like** exit 1 and a per-field list naming both sides:

```
FAILED - the vault does not carry the registry limits:
  maxDailyOutflow: expected 2500000000, chain says 0
step 3 - funding: UNREACHABLE (no proof was minted).
```

**UNPROVEN (exit 3) is a third outcome and it is not a pass.** It means the readback could not see its
subject at all:

```
UNPROVEN: no code at 0x… on chain 4663: the limits readback has no subject, so it proves nothing
```

Causes, in order of likelihood: the registry points at the wrong address; the deploy has not happened on this
chain; `RH_RPC` is a different chain than `--chain-id` claimed (that one refuses instead, with both numbers).
A `maxDailyOutflow` that reads as **ABSENT** rather than a number means the tuple came back with five fields —
a decoder built against the pre-`INTERFACE_VERSION 7` vault. Stop; the outflow cap is exactly the guard that
is invisible when it is unset.

### 1.4 Fund — only now, and only through the script

```bash
node ops/v8/makervault-canary.mjs --execute --chain-id 4663 --fund-usdg 25000
```

The funding instruction is emitted **only** when the readback in that same run matched. It prints the Treasury
Safe's two calls, the amount in base units at the decimals **read from the USDG contract** (never assumed),
and the readback that proves the deposit landed:

```
cast call $USDG "balanceOf(address)(uint256)" $VAULT --rpc-url "$RH_RPC"   # must rise by exactly <amount>
```

**FAILED looks like** `funding is unreachable: no limits readback proof` — which is what you get if the
readback did not pass, or if you try to fund from a different invocation than the one that verified. That is
the guard working. Do not work around it by reading the amount out of the plan and typing it into the Safe
yourself: the whole point is that the limits were proven seconds ago, by this run, against this address.

**After funding**, run the balance readback. A balance that did not rise by exactly the amount means the
deposit reverted or went somewhere else; a balance that rose by *more* means somebody else deposited too
(`deposit` is permissionless) — reconcile before you continue.

### 1.5 Start the MM bot and the pricer

Owner action, outside these scripts: `keeper/README.md` covers the quoter and pricer services. Their roles
(`QUOTER`, `PRICER`) are granted through `OPS_ADMIN` at **delay 0**, so a grant or a revoke is one Safe
transaction with no waiting — that is also how you stop a misbehaving bot.

**FAILED looks like** every bot transaction reverting with `AccessManagerUnauthorizedAccount`: the key does
not hold its role. `ops/go-live-v2.sh` warns about exactly this rather than proceeding.

---

## 2. OWN8-08 — enable the buyback, then prove a burn

### 2.1 Emit the plan

```bash
node ops/v8/buyback-enable.mjs --usdg-decimals 6
```

Without `--usdg-decimals` the dry run **withholds the calldata** instead of guessing a scale:

```
step 1 - setBuybackCap calldata: WITHHELD. USDG decimals are unknown offline; pass --usdg-decimals <n> or run --execute.
```

That is deliberate. A cap scaled by the wrong decimals is off by a factor of 10^12 in one direction or the
other, and both directions are bad. When you pass the flag, the live run in §2.3 refuses if the chain
disagrees with it.

The cap itself is `50` whole USDG (`--cap-usdg` to change it), the OWN8-08 figure from
`v8-plan/tasks/OWN-owner.md`. The selector is `0x364db0e2`.

### 2.2 Schedule, wait, send

`setBuybackCap` is governed by **`FEE_MANAGER`**, whose delay in the manifest is **172800s (48 h)** — twice
the MakerVault's. Read it the same way:

```bash
node -e 'const r=require("./ops/abis/v2/roles.json");const role=r.targets.FeeSplitter["setBuybackCap(uint256)"];
console.log(role, r.roles[role], r.delaysS[role]+"s")'
```

Plan the launch calendar around that: the cap has to be scheduled two days before you want the flywheel live.

### 2.3 Read the enable back

```bash
node ops/v8/buyback-enable.mjs --execute --chain-id 4663
```

Checks three facts, because any one of them alone is a false green: `buybackCap()` equals the cap in base
units, `executor()` is the registry's buyback executor, and `paused()` is `false`.

**Success**: `VERIFIED - cap, executor and unpaused all match.`

**FAILED (exit 1)**: a per-check list. An `executor` of `0x0000…0000` is a failure, not "not configured yet".

**UNPROVEN (exit 3)**: no code at the splitter, or a view that reverted. The readback saw nothing, so it
proved nothing.

### 2.4 Watch for the first indexed burn

```bash
node ops/v8/buyback-enable.mjs --execute --chain-id 4663 --watch-burn --window-seconds 1800
```

Polls the indexer's `/v2/flywheel` until `burnedTotal` is greater than zero.

**Success**: `BURNED - burnedTotal=… after N poll(s). The flywheel is indexed, not just enabled.`

**FAILED (exit 1) — silence**:

```
FAILED - no burn indexed within 1800s. Enabled is not working: check the splitter's USDG balance,
         the executor's pool liquidity, and whether the cranker is calling buyback().
```

A window that elapses with no burn **fails**. It never reports success on silence, and that is the single
most important line in this runbook: "enabled" and "working" are different facts, and the gap between them is
where a launch quietly ships a flywheel that never turns.

**UNPROVEN (exit 3) — blind**: the route cannot show a burn at all.

```
UNPROVEN: /v2/flywheel reports configured:false - the indexer has no FeeSplitter address,
          so a burn could never appear here
```

The indexer is missing its splitter env var, or the route/schema moved. Fix the indexer and run the watch
again. Do **not** record the step as done: a watch that cannot see burns would wait out its whole window and
then report silence, which reads like a chain problem and is not one.

---

## 3. Exit codes

| code | meaning |
|---|---|
| 0 | verified — and, when asked, the funding instruction was emitted |
| 1 | REFUSED (bad input, un-written-back registry, key-shaped argv) **or** a readback that ran and did not match **or** a burn window that elapsed in silence |
| 2 | unexpected error |
| 3 | UNPROVEN — a check could not see its subject, so it established nothing either way |

Treat 3 as worse than 1, not better. A mismatch tells you what is wrong; an UNPROVEN tells you that you have
been looking at nothing.

---

## 4. Notes, and one gap this runbook does not close

**The six EarnVault selectors said to be mapped to `OPS_ADMIN`.** T-196 asked for a conclusion. What is
checkable in this repository at the SHA this page was written:

- `ops/abis/v2/roles.json` carries **19 target blocks and 102 selectors, and not one of them maps to
  `OPS_ADMIN`**. There is **no `targets.EarnVault` block at all**, although `ops/abis/v2/EarnVault.json`
  exists and the contract has admin calls. Any consumer that enumerates `targets` from this file therefore
  covers **zero** EarnVault selectors. (Checked, so the claim stays narrow: nothing in this repository
  currently enumerates `targets` — `ops/go-live-v2.sh:397-417` reads only `roles[NAME]` for the three bot
  roles, and `ops/v8/launch-packet.mjs:129` only asserts the key is present. The gap is therefore in the
  manifest, not yet in a checker that reads it.)
- So the mapping cannot be confirmed **or** refuted here. It would live in `script/v2/roles.v8.json` in
  callhouse-contracts, which this worktree does not carry at this base (its `contracts/` submodule predates
  v8 — it has no `FeeSplitter.sol` and no `EarnVault.sol`).
- What the manifest here *does* establish, and what makes the question worth answering: `OPS_ADMIN` has
  **delay 0** and is the role admin of `GUARDIAN`, `PRICER`, `QUOTER` and `BUYBACK`. If six EarnVault
  state-changing selectors were mapped to it, they would be callable **instantly** by every `OPS_ADMIN`
  holder — and `holders.adminSafe` includes `OPS_ADMIN`. That is the T-170 shape: a money-moving call behind
  a zero-delay role.

**Not established by this task**: whether those six selectors exist in the contracts-side manifest, what they
are, and whether they move value. Somebody with the contracts tip has to read `script/v2/roles.v8.json` and
say. `ops/v8/makervault-canary.test.mjs` records the current state, so the day an `EarnVault` block or an
`OPS_ADMIN` mapping appears in this file, that test goes red instead of the change landing silently.

**Manifest staleness.** `v8-roles.md` already records that this repository's `roles.json` is behind the
contracts tip by two `FeeSplitter` rows (`setOracle`, `setToken`). Neither is used above. If you are
enumerating the splitter's whole admin surface, read the contracts-side file and say which file you read.

**The `contracts/` submodule in this repository lags v8.** `contracts/src/v2/mm/MakerVault.sol:296` declares
`setLimits` as `onlyRole(DEFAULT_ADMIN_ROLE)`, which is the pre-v8 shape; under `INTERFACE_VERSION 8` no
target holds a role and the manifest maps the selector to `TREASURY_ADMIN` on the `AccessManager`. Where the
two disagree, the manifest and the contracts tip win. The scripts read the manifest at run time for exactly
this reason.
