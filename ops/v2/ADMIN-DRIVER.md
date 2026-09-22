# The v8 admin driver

One helper turns any restricted call into the shape the AccessManager actually accepts, so `K8-04`,
`W8-04`, `X8-05` and `O8-06` never hand-roll `schedule` / `execute` and never disagree about a delay.

- `ops/v2/lib/admin.mjs` — the library: `loadRoles`, `planFor`, `adminCall`, `adminCancel`.
- `ops/v2/devnet-admin.mjs` — the CLI.
- `ops/v2/devnet-admin.test.mjs` — `node --test`, node builtins only, no chain.
- Input: `ops/abis/v2/roles.json`, the published role manifest. **Every** role id and execution delay
  is read from it at run time. Neither source file writes a delay down, and the test proves it.

```
node ops/v2/devnet-admin.mjs [flags] <target> "<signature>" [args...]

  <target>        a contract name as roles.json spells it (Clearinghouse, OrderBook, MakerVault, …)
                  or a 0x address ops/devnet/addresses.json maps to one of them
  <signature>     the full signature, e.g. "setMarketFees(address,uint16,uint32)"
  args            one per parameter; arrays and tuples as JSON: '[100,50,0,25,10]'

  --dry-run       print the plan and send nothing (no node, no viem, no connection)
  --cancel        cancel the operation this call would be, instead of performing it
  --manager <a>   the AccessManager; else DEVNET_MANAGER; else addresses.json contracts.accessManager
  --safe <a>      the Admin Safe to impersonate; else DEVNET_SAFE; else addresses.json accounts.adminSafe
  --guardian <a>  --cancel only: who sends cancel(); else DEVNET_GUARDIAN; else addresses.json
                  accounts.guardian; else the Safe
  --no-preflight  skip the read-back that compares roles.json with the manager's own mapping
```

Exit codes: `0` done, `1` refused or reverted, `2` usage (an unresolvable manager, Safe or target
names the exact key it looked for). Every path prints the operation id.

## The three modes, and why they are not interchangeable

`planFor` answers one of three modes from the manifest alone. The line numbers are OpenZeppelin
v5.4.0 as vendored at
`callhouse-contracts/lib/openzeppelin-contracts/contracts/access/manager/AccessManager.sol`.

| mode | when | what it sends |
| --- | --- | --- |
| `execute` | the role's `delaysS` is 0 | `manager.execute(target, data)` |
| `schedule-execute` | delay > 0 | `manager.schedule(target, data, 0)` → warp → `manager.execute(target, data)` |
| `schedule-direct` | delay > 0 **and** the target reads `msg.sender` | `schedule` → warp → call the **target** directly, as the Safe |

1. **A delay-0 action must not be scheduled.** `schedule` reverts `AccessManagerUnauthorizedCall`
   when the member's setback is 0 (`AccessManager.sol:464-465`). Scheduling a `GUARDIAN`,
   `OPS_ADMIN`, `PRICER`, `QUOTER` or `BUYBACK` action is not harmless belt and braces; it is a
   revert. A pause has to be instant anyway — that is what the role is for.
2. **`when = 0` is deliberate.** The manager clamps it up to `now + setback` itself
   (`AccessManager.sol:467-469`), so the ready time is the chain's number, read back from
   `getSchedule`, and never one this driver computed. `execute` then consumes the schedule
   (`AccessManager.sol:516-521`).
3. **`execute` relays as the manager.** It calls
   `Address.functionCallWithValue(target, data, msg.value)` (`AccessManager.sol:528`), so the target
   sees `msg.sender == manager`, not the Safe. A delayed function that reads `msg.sender` must
   therefore be scheduled and then called **directly**: `AccessManaged._checkCanCall`
   (`AccessManaged.sol:95-111`, and this repo's override `src/v2/access/Managed.sol:65-72`) calls
   `authority().consumeScheduledOp(caller, data)` for a delayed member, which consumes the very same
   operation. Same rule in `v8-plan/06-QUIRKS.md` §D.2 and `src/v2/access/V8Roles.sol:17-19`.

**`MSG_SENDER_FUNCTIONS` (in `ops/v2/lib/admin.mjs`) is the one list that decides mode 3**, and it is
never inferred from a name. **It is empty at INTERFACE_VERSION 8**, which is a read result, not an
oversight: v8 deleted exactly the functions that would have been on it — the free-`to` money exits —
so `MakerVault.withdraw` / `withdrawPosition`, `KeeperRewards.defund` and `RewardsDistributor.defund`
all pay the stored `treasury`, and the functions that do read `msg.sender` (`MakerVault.deposit`,
`KeeperRewards.fund`, `PayoutRouter.swapToUsdg`, `OrderBook.claimOwed`) carry no role at all. The
file carries the one-line `awk` that re-derives the list when a target changes. A **missing** entry is
the dangerous direction — the call succeeds with the manager as `msg.sender`; an **extra** one is
merely pedantic.

## The operation id

```
operationId = hashOperation(SAFE, target, data)          AccessManager.sol:588-589
            = keccak256(abi.encode(caller, target, data))
```

**The caller is the Safe, never the account that sent the transaction.** On a node the driver reads
the id from the manager's own `hashOperation` view rather than hashing it locally, so there is no
second keccak in the repository to get wrong; `--dry-run` computes it from viem when viem resolves,
and prints the plan without it when it does not. The id is what `getSchedule`, `cancel` and the
monitor's `OperationScheduled` / `OperationExecuted` / `OperationCanceled` events all key on, so it is
printed on every path — schedule, execute and cancel.

## What it does on a node

The Safe is impersonated with `anvil_impersonateAccount` and funded with `anvil_setBalance` (the same
pair `ops/devnet/lib.mjs:296-297` uses for a whale), and impersonation is stopped in a `finally`,
including on the error path. Time travel goes through `warpTo` (`ops/devnet/lib.mjs:227`) — the
repository has exactly one time-travel implementation. Transactions go through `send`
(`ops/devnet/lib.mjs:197`), which simulates first so a revert decodes by name.

Before anything is sent, the driver reads the manager's own `getTargetFunctionRole(target, selector)`
and `hasRole(roleId, safe)` and refuses if either disagrees with `roles.json` — a manifest that has
drifted from the deployment would otherwise pick a mode for a delay the member does not have.
`--no-preflight` skips it for a node that is mid-deploy.

**Devnet only.** No key is read, held or needed. Production runs the same three shapes from the real
Safe; the `roles.json` lookup and the operation id are identical there.

## Using it from a script

```js
import { adminCall, adminCancel, loadRoles, planFor } from "../v2/lib/admin.mjs";

const roles = loadRoles();
planFor({ target: "Clearinghouse", signature: "setMarketFees(address,uint16,uint32)", roles });
// { contract, signature, role: "MARKET_FEE_MANAGER", roleId: 2, delayS: 259200, mode: "schedule-execute" }

const r = await adminCall({
  manager, safe,
  target: { contract: "Clearinghouse", address: clearinghouse },
  signature: "setMarketFees(address,uint16,uint32)",
  args: [nvda, "500", "0"],
});
// { operationId, mode, scheduledAt, executedAt, txs: [{ step, hash }, …] }
```

`loadRoles` and `planFor` are **pure**: node builtins, no chain, no viem. `adminCall` and
`adminCancel` import `ops/devnet/lib.mjs` dynamically, inside the function body, so a harness can
plan (and test) the whole mapping in a checkout that cannot resolve viem.

## Worked examples

### K8-04 — keeper devnet scripts (`devnet-cycle`, `devnet-mm`, `devnet-reprice`)

v8 has no direct mint: the book mints, so the OrderBook must be on the Clearinghouse's minter
allow-list before `devnet-cycle` can fill anything. `CONFIG_ADMIN`, so it is scheduled, warped and
executed in one command:

```bash
node ops/v2/devnet-admin.mjs Clearinghouse "setMinter(address,bool)" "$ORDER_BOOK" true
#   role   CONFIG_ADMIN (3)     delay 86400 s     mode schedule-execute
```

`devnet-reprice` drives the pricer's own lane, which is instant — no schedule, no warp:

```bash
node ops/v2/devnet-admin.mjs AutoRoller "reprice(address,address,uint128)" "$WRITER" "$NVDA" 1250000
#   role   PRICER (8)           delay 0 s         mode execute
```

Check a lane before wiring it into a script; this needs no devnet at all:

```bash
node ops/v2/devnet-admin.mjs --dry-run MakerVault "setLimits((uint64,uint128,uint16,uint16,uint32,uint128))" '[10000,250000000000,100,1000,0,0]'
```

### W8-04 — web fork acceptance, the 48 h pending-fee drill

The pending fee notice the web app must show is an `OrderBook.setFeeParams` under `FEE_MANAGER`.
Schedule it and let the operation sit to screenshot the notice:

```bash
node ops/v2/devnet-admin.mjs --dry-run OrderBook "setFeeParams((uint16,uint16,uint32,uint16,uint16))" '[100,50,0,25,10]'
#   role   FEE_MANAGER (1)      delay 172800 s    mode schedule-execute
node ops/v2/devnet-admin.mjs OrderBook "setFeeParams((uint16,uint16,uint32,uint16,uint16))" '[100,50,0,25,10]'
```

Note the two 48 h numbers are different things and must not be conflated: `FEE_MANAGER`'s **execution
delay** lives in `roles.json`, and the OrderBook's own `V2Constants.FEE_CHANGE_DELAY` pending window
is compiled into the contract (`ops/v2/monitor.mjs` `FEE_CHANGE_DELAY`). The driver waits out the
first; the app shows the second. `FeeAboveMax` on a take is a third, unrelated, user-side refusal.

### X8-05 — indexer devnet sync harness

Every admin action the harness backfills over has to be performed the same way twice, or the
cardinalities move. Listing a market is the cheap lane (`LISTING`, one hour), which is enough to put
an `OperationScheduled` and an `OperationExecuted` in front of the indexer:

```bash
node ops/v2/devnet-admin.mjs Clearinghouse "registerMarket(address,uint64,bool)" "$NVDA" 100 true
#   role   LISTING (5)          delay 3600 s      mode schedule-execute
```

The operation id the command prints is the one the indexer's manager rows key on; assert against it
rather than re-deriving a hash in the harness.

### O8-06 — rehearsal drills, including the guardian cancel

The instant brake, and then the guardian cancel of a money-lane operation that is waiting out its
delay. `GUARDIAN` is the role guardian of roles 1–5 (`roles.json` `roleGuardian`), which is why it can
cancel a `MARKET_FEE_MANAGER` operation it did not schedule (`_canCancel`, `AccessManager.sol:722`):

```bash
# 1. instant brake — delay 0, executed on the spot
node ops/v2/devnet-admin.mjs OrderBook "setTradingPaused(bool)" true
#   role   GUARDIAN (7)         delay 0 s         mode execute

# 2. schedule a 72 h market-fee change (it will NOT execute until the warp)
node ops/v2/devnet-admin.mjs --dry-run Clearinghouse "setMarketFees(address,uint16,uint32)" "$NVDA" 500 0
#   role   MARKET_FEE_MANAGER (2)   delay 259200 s   mode schedule-execute

# 3. the guardian cancels it — same arguments, so the same operation id
node ops/v2/devnet-admin.mjs --cancel --guardian "$GUARDIAN_KEY" \
  Clearinghouse "setMarketFees(address,uint16,uint32)" "$NVDA" 500 0
```

The cancel is `cancel(caller = SAFE, target, data)`: the caller is whoever **scheduled** it, not
whoever sends the cancel. Pass the same `<target> "<signature>" args` the schedule used and the
driver re-derives the id; a mismatch is reported as "nothing is scheduled under …" rather than
silently cancelling nothing.

## Boundaries

- **Target calls only.** `roles.json.targets` maps `(contract, signature) → role`, and that is all the
  driver plans. Role grants, revokes and selector mappings are manager **self**-calls under `ADMIN`'s
  execution delay (or `OPS_ADMIN`, instant, for the `GUARDIAN` / `PRICER` / `QUOTER` / `BUYBACK` hot
  keys). `O8-06`'s hot-key rotation drill therefore needs a manager-self lane that does not exist
  yet: it would read `delaysS.ADMIN` / `delaysS.OPS_ADMIN` and target the manager itself.
- **No target is mapped to `ADMIN`,** and an unmapped signature is refused rather than planned. An
  unmapped restricted selector falls to `ADMIN` by default on chain — `roles.json`
  `notes.adminHasNoTarget` calls that "exactly the mistake the access-matrix test must catch", so the
  driver refuses instead of performing it.
- **The manifest is the contract.** `PayoutRouter`, `FeeSplitter` and `V4BuybackExecutor` are frozen
  from `03-INTERFACES` and have no compiled ABI yet; the driver plans them from the signature because
  `roles.json`'s own key *is* the canonical signature. When those contracts land, only the address
  book entry has to follow (`ADDRESS_KEYS` in `ops/v2/devnet-admin.mjs`).
