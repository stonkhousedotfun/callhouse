# Runbook — v8 role operations (AccessManager)

INTERFACE_VERSION 8 moved every privileged call off the targets and onto one OpenZeppelin
`AccessManager`. **No v8 target holds a role.** `src/v2/access/Managed.sol` (callhouse-contracts)
says it in its own header: `(target, selector) -> role` and the per-member execution delays live
entirely in the manager, and `AccessManaged` declares no `supportsInterface`, so a v8 target no
longer answers `type(IAccessControl).interfaceId`
(`Managed.sol:28-30` scope note, `Managed.sol:37-38` ERC-165 note, read at callhouse-contracts
`b1a120db0f55f8f2a9fcc51d414993e3f2d6fd9a`).

Two consequences for anybody typing commands:

- `grantRole(bytes32,address)` / `hasRole(bytes32,address)` **on a target contract** revert on a v8
  deployment. There is no `bytes32` role anywhere in v8. The manager's forms take a `uint64` role id.
- A role is not a permission to send a transaction now. A role with an execution delay is a
  permission to **schedule** one, wait, and then send it. §4.

**The manifest is the truth, and it is a file.** `ops/abis/v2/roles.json` is this repository's mirror
of `script/v2/roles.v8.json` in callhouse-contracts. Every role id, every execution delay, every
role admin and every role guardian in this runbook is **read out of that file by the command you
run**. Nothing below retypes one, and neither should you: a retyped id names the wrong role, and a
retyped delay makes you send a transaction into a window that has not opened.

> **Known staleness, 2026-09-20.** The copy in this repository (`ops/abis/v2/roles.json`) is behind
> the contracts source by two rows: the contracts tip maps `FeeSplitter.setOracle(address)` and
> `FeeSplitter.setToken(address)` to `TREASURY_ADMIN`, and the copy here carries neither. Neither is
> a bot role and neither changes any delay. If you are enumerating the FeeSplitter's admin surface,
> read `script/v2/roles.v8.json` in callhouse-contracts and say which file you read. Everything else
> in this runbook comes from the copy in this repository and is unaffected.

Related pages: `ops/alerts.md` §V52-§V55 (what the monitor pages when any of this happens),
`ops/runbooks/v8-safes.md` (how a Safe actually signs the transactions below), `incident-v2.md` §4
(a compromised bot key) and §5 (a compromised Safe).

---

## 0. Shell setup

```bash
# from the app repo root
REG=ops/markets/tier1.json
ROLES=ops/abis/v2/roles.json
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
eval "$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const c = r.v2.contracts;
const v = { MANAGER: c.accessManager, CH: c.clearinghouse, BOOK: c.orderBook, ORACLE: c.settlementOracle,
  CAL: c.expiryCalendar, REWARDS: c.keeperRewards, ROLLER: c.autoRoller, VAULT: c.makerVault,
  DIST: c.rewardsDistributor, SPLITTER: r.v2.flywheel.feeSplitter, BUYBACK_EXEC: r.v2.flywheel.buybackExecutor,
  SAFE_ADMIN: r.shared.safes.admin, SAFE_TREASURY: r.shared.safes.treasury,
  CRANKER: r.v2.bots.cranker, PRICER: r.v2.bots.pricer, QUOTER: r.v2.bots.quoter, GUARDIAN: r.v2.bots.guardian };
for (const [k, x] of Object.entries(v)) console.log(`export ${k}=${x ?? ""}`);' "$REG")"
```

An empty export is an address the registry has not been written back yet (`ops/markets/tier1.json`
holds explicit `null` until `O8-08`). **Never read `null` as `address(0)`** — check before you send.

The four readers below are the only way this runbook names a role id, a delay, a role admin or a role
guardian. They take a role **name** and refuse a name the manifest does not define, which is the
failure you want: a typo becomes an error instead of role `0`.

```bash
rj() { ROLES="$ROLES" node -e '
  const r = JSON.parse(require("fs").readFileSync(process.env.ROLES, "utf8"));
  const [what, name] = process.argv.slice(1);
  const table = { id: r.roles, delay: r.delaysS, admin: r.roleAdmin, guardian: r.roleGuardian }[what];
  if (!(name in r.roles)) throw new Error(`${name} is not a role in ${process.env.ROLES}`);
  if (!(name in table)) throw new Error(`${name} has no ${what} in ${process.env.ROLES}`);
  process.stdout.write(String(table[name]));' "$1" "$2"; }

rid()    { rj id       "$1"; }   # the uint64 the manager knows the role by
rdelay() { rj delay    "$1"; }   # this role's execution delay, in seconds
radmin() { rj admin    "$1"; }   # the role that may grant and revoke it (absent => ADMIN)
rguard() { rj guardian "$1"; }   # the role that may cancel its scheduled operations (absent => none)
```

The whole manifest, as a table, when you want to look rather than script:

```bash
ROLES="$ROLES" node -e '
const r = JSON.parse(require("fs").readFileSync(process.env.ROLES, "utf8"));
for (const [name, id] of Object.entries(r.roles)) {
  console.log([String(id).padStart(2), name.padEnd(18), `delay ${String(r.delaysS[name]).padStart(6)} s`,
    `admin ${(r.roleAdmin[name] ?? "ADMIN").padEnd(9)}`, `guardian ${r.roleGuardian[name] ?? "-"}`,
    `holders ${Object.entries(r.holders).filter(([, v]) => v.includes(name)).map(([k]) => k).join(",")}`].join("  "));
}'
```

Read that once at the start of any role work and keep it on screen. Everything after this point
refers to roles by name.

---

## 1. Which lane is this call in?

Ask the chain, not the file — the file is what *should* be true and §8 is how you find out it is not.

```bash
SEL=$(cast sig "setFeeRecipient(address)")                                    # the function you mean
cast call $MANAGER "getTargetFunctionRole(address,bytes4)(uint64)" $BOOK $SEL --rpc-url $RH_RPC
cast call $MANAGER "canCall(address,address,bytes4)(bool,uint32)" $SAFE_ADMIN $BOOK $SEL --rpc-url $RH_RPC
```

`getTargetFunctionRole` answers with the role id the mapping carries; compare it with
`rid <ROLE>`. `canCall` answers `(immediate, delay)` for a specific caller:

| `canCall` answers | What it means | Go to |
|---|---|---|
| `(true, 0)` | this caller may send the call right now | §3 |
| `(false, d)` with `d` non-zero | this caller is a member with an execution delay of `d` seconds; it must schedule first | §4 |
| `(false, 0)` | this caller is not a member, or the selector is mapped to a role it does not hold | it will revert `NotAuthorized`; §7 |

A selector that **no** mapping covers falls to `ADMIN` by default. That is the mistake the manifest's
own `adminHasNoTarget` note and the access-matrix test exist to catch, and `getTargetFunctionRole`
returning `rid ADMIN` for a target function is the shape of it. Do not "fix" it by sending the call
from ADMIN; report it.

Per-member state, when `canCall` is not enough:

```bash
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid QUOTER)" $QUOTER --rpc-url $RH_RPC
#   isMember, executionDelay
cast call $MANAGER "getAccess(uint64,address)(uint48,uint32,uint32,uint48)" "$(rid QUOTER)" $QUOTER --rpc-url $RH_RPC
#   since, currentDelay, pendingDelay, effect  — a pendingDelay with a future `effect` is a delay change in flight
```

**The delay belongs to the (role, member) pair, not to the role.** Two members of the same role can
be on different clocks, and a re-grant to an existing member *changes* that member's delay — a
reduction only takes effect once the difference has elapsed. `hasRole`'s second return value is the
one that decides whether you are in §3 or §4, and `rdelay <ROLE>` is only what the manifest says it
should be.

---

## 2. Who actually sends it

Every role in `holders.adminSafe` is held by the **Admin Safe**, which cannot type `cast send`. For
those, every `cast send` shown below is the **inner** call: build its calldata with `cast calldata`,
then sign and send it as a Safe transaction — `v8-safes.md` §4, `to` = the contract named in the
command, `value` = 0, `operation` = 0.

```bash
cast calldata "schedule(address,bytes,uint48)" $BOOK "$INNER" 0        # what the Safe's `data` should be
```

The four hot keys (`cranker`, `pricer`, `quoter`, `guardian` — `ops/v2/derive-bot-keys.sh`) are plain
EOAs and send directly with `--account <keystore name>`. Import each once on the machine that holds
it; **no command in this repository ever takes a key as an argument**, because `cast`'s value flag
would put it in `ps -axww` for every user on the box for as long as the send runs:

```bash
cast wallet import guardian --interactive   # prompts for the key and a password; nothing echoes
cast wallet address --account guardian      # check it against $GUARDIAN before you rely on it
```

There is **no admin driver yet.** `v8-plan/06-QUIRKS.md` §D8 records that every devnet, rehearsal and
acceptance script still sends admin calls straight from an EOA, and that the one driver that will do
schedule → warp → execute as the impersonated Safe is `F8-03`, still `todo`. Until it lands, do not
invent a driver command line: the commands here are what exists.

---

## 3. The instant lane (execution delay 0)

`rdelay <ROLE>` of 0 means a member sends the call and it lands. The manifest's zero-delay roles are
the ops and hot-key lane — check rather than remember:

```bash
ROLES="$ROLES" node -e '
const r = JSON.parse(require("fs").readFileSync(process.env.ROLES, "utf8"));
console.log("no delay :", Object.keys(r.delaysS).filter((k) => r.delaysS[k] === 0).join(" "));
console.log("delayed  :", Object.keys(r.delaysS).filter((k) => r.delaysS[k] !== 0).join(" "));'
```

A guardian pause, from the guardian hot key, is the whole shape of this lane:

```bash
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid GUARDIAN)" $GUARDIAN --rpc-url $RH_RPC   # true, 0
cast send $BOOK "setTradingPaused(bool)" true --rpc-url $RH_RPC --account guardian
```

If the second return value of `hasRole` is **not** 0, this key is in §4 and the send will revert
`AccessManagerNotScheduled` (§7) — not because the key lost the role, but because somebody put a
delay on it.

---

## 4. The delayed lane: schedule → wait → send

Three steps, and the third is the one people get wrong.

### 4.1 Build the inner calldata

```bash
INNER=$(cast calldata "setFeeRecipient(address)" $SAFE_TREASURY)
echo "$INNER"
```

Check it decodes back to what you meant before anything is signed:

```bash
cast decode-calldata "setFeeRecipient(address)" "$INNER"
```

### 4.2 Schedule it

`when = 0` asks the manager for the earliest time this caller is allowed, which is now plus **that
member's** execution delay. Passing a `when` of your own only ever makes it later.

```bash
cast calldata "schedule(address,bytes,uint48)" $BOOK "$INNER" 0     # the Safe transaction's data
# … signed and sent as a Safe transaction: v8-safes.md §4 …
```

Then pin the operation so you can find it again. The id is a pure function of (caller, target,
data) — the **caller is part of it**, so schedule and send must come from the same address:

```bash
OPID=$(cast call $MANAGER "hashOperation(address,address,bytes)(bytes32)" $SAFE_ADMIN $BOOK "$INNER" --rpc-url $RH_RPC)
cast call $MANAGER "getSchedule(bytes32)(uint48)" $OPID --rpc-url $RH_RPC   # unix seconds; 0 = not pending
cast call $MANAGER "getNonce(bytes32)(uint32)"    $OPID --rpc-url $RH_RPC
```

Record `$OPID` and the nonce in the incident or change note. The monitor pages
`v2_mon_manager_operation` on the `OperationScheduled` log with both (`ops/alerts.md` §V52) and the
on-call will ask you whether it is yours.

### 4.3 Wait, and watch

```bash
cast call $MANAGER "getSchedule(bytes32)(uint48)" $OPID --rpc-url $RH_RPC
cast block latest -f timestamp --rpc-url $RH_RPC          # ready when this is >= the schedule
cast call $MANAGER "expiration()(uint32)" --rpc-url $RH_RPC
```

`getSchedule` returning **0 is ambiguous**: executed, cancelled, or expired. `cast logs` tells you
which. These are the manager's own events, and **they are not AccessControl's** — same names,
different topics, because the role id is a `uint64` and not a `bytes32`. Writing the full typed
signature is what makes `cast` compute the right topic0:

```bash
cast logs --address $MANAGER --from-block <recent> --rpc-url $RH_RPC \
  "OperationScheduled(bytes32 indexed operationId, uint32 indexed nonce, uint48 schedule, address caller, address target, bytes data)"
cast logs --address $MANAGER --from-block <recent> --rpc-url $RH_RPC \
  "OperationExecuted(bytes32 indexed operationId, uint32 indexed nonce)"
cast logs --address $MANAGER --from-block <recent> --rpc-url $RH_RPC \
  "OperationCanceled(bytes32 indexed operationId, uint32 indexed nonce)"
```

**A scheduled operation expires.** `expiration()` is the window the manager allows *after* the
operation becomes executable (OpenZeppelin's default is one week; read the live value rather than
trusting this sentence). Miss it and the operation is gone: nothing reverts loudly at the moment it
lapses, and the next thing you notice is that the send fails as if you had never scheduled. Schedule
a reminder for the ready time, not for the deadline.

### 4.4 Send it — DIRECTLY from the member

Once it is ready there are two ways to make the call, and they are **not** interchangeable:

| | What the target sees as `msg.sender` | Use it for |
|---|---|---|
| the member calls the target **directly** | the member (the Safe, or the hot key) | **anything whose effect depends on `msg.sender`** — anything that pulls, holds, credits or attributes funds |
| `AccessManager.execute(address,bytes)` | **the manager** | only a call whose effect does not read `msg.sender` at all |

```bash
# DIRECT — the same call you scheduled, sent to the target. This is the default.
cast calldata "setFeeRecipient(address)" $SAFE_TREASURY          # `to` = $BOOK for the Safe transaction

# via the manager — only when msg.sender does not matter
cast calldata "execute(address,bytes)" $BOOK "$INNER"            # `to` = $MANAGER
```

`Managed._checkCanCall` consumes the scheduled operation **either way**
(`src/v2/access/Managed.sol:16-26` for the rule in the contract's own words, `Managed.sol:65-72` for
the body: immediate → return; a member with no delay → `NotAuthorized`; a member with a delay →
`super._checkCanCall`, which calls `consumeScheduledOp` on the manager). So
routing through `execute` is not "more correct" — it is the same authorisation with a different
`msg.sender`, and choosing it for a funds-moving call is how the manager ends up owning a balance,
an allowance or a position that should have been the Safe's. `v8-plan/06-QUIRKS.md` §D2 is the
one-line version: for a function that reads `msg.sender`, schedule and then call the target directly.

The rule is worth stating as a habit rather than a judgement call: **schedule, then call the target.
Reach for `execute` only when you can name the reason.**

### 4.5 Confirm

```bash
cast call $MANAGER "getSchedule(bytes32)(uint48)" $OPID --rpc-url $RH_RPC   # 0 now
cast call $BOOK "feeRecipient()(address)" --rpc-url $RH_RPC                 # the state you meant to change
```

`v2_mon_manager_operation` pages again on `OperationExecuted` (`ops/alerts.md` §V52): that page is
the moment the state actually moved, not the moment you scheduled it.

---

## 5. Cancelling a scheduled operation

`cancel(address caller, address target, bytes data)` takes the operation's **inputs**, not its id —
the same three values that produced `$OPID` in §4.2.

```bash
cast calldata "cancel(address,address,bytes)" $SAFE_ADMIN $BOOK "$INNER"
```

Who may send it, from the manager's own `_canCancel`: the operation's **original caller**, anybody
holding `ADMIN`, or the **guardian role of the role that gates the target function** — which is the
role the operation was scheduled under. (Nothing else: a role's own admin cannot cancel its
operations unless it also holds one of those.)

```bash
ROLE=FEE_MANAGER
rguard "$ROLE"; echo                                  # the role that may cancel this lane; errors if none
cast call $MANAGER "getRoleGuardian(uint64)(uint64)" "$(rid $ROLE)" --rpc-url $RH_RPC   # what the chain says
```

Two limits that decide whether the brake exists at all:

- **`ADMIN` has no guardian and cannot be given one.** Read it from the manifest: `rguard ADMIN`
  errors out precisely because `roleGuardian` has no `ADMIN` row, and on chain `setRoleGuardian`
  reverts `AccessManagerLockedRole` for it. So a role grant, a role revoke, a role-admin change, a
  guardian change or a selector re-mapping — every ADMIN-lane operation — is visible for its whole
  delay and can be cancelled only by ADMIN itself. The guardian cancels money-lane operations and
  **never** role or mapping changes. This is an AccessManager limit, not a policy we chose, and it is
  why §8's watch on `v2_mon_manager_role` matters more than the others.
- **`getRoleGuardian` answering `0` does not mean "no guardian".** Role `0` *is* `ADMIN`
  (`cast call $MANAGER "ADMIN_ROLE()(uint64)" --rpc-url $RH_RPC`), and an unset guardian reads back
  as `0` because that is the zero value of the slot. A money-lane role reading `0` here is a role
  whose brake was never wired — compare against the manifest (`rguard <ROLE>`), which is exactly what
  `v2_mon_manager_wiring` does continuously (`ops/alerts.md` §V54).
- A cancel clears the operation's schedule and **keeps its nonce**; the next `schedule` of the same
  (caller, target, calldata) raises it. So `getSchedule` going to 0 with `getNonce` unchanged is a
  cancel or an execution, and a higher nonce means somebody scheduled it again — with a fresh full
  delay. `getNonce` is how you tell this operation from the one before it.
- You cannot schedule the same (caller, target, calldata) twice while one is still pending: the
  second attempt reverts `AccessManagerAlreadyScheduled`. Cancel first, or wait it out.

A cancel pages as `v2_mon_manager_operation` at warn (`ops/alerts.md` §V52). A cancel the rota did
not send is the brake being taken off something we wanted: `incident-v2.md` §5.

---

## 6. Rotating a hot key, with no delay

This is the one lane built to be fast, and it is the reason `OPS_ADMIN` exists. Check the shape
before you use it — that the bot roles' role admin is `OPS_ADMIN`, and that `OPS_ADMIN` itself has
no execution delay:

```bash
for R in GUARDIAN PRICER QUOTER BUYBACK; do
  printf '%-9s id %-3s delay %-7s admin %s\n' "$R" "$(rid $R)" "$(rdelay $R)" "$(radmin $R)"
done
printf 'OPS_ADMIN id %s delay %s\n' "$(rid OPS_ADMIN)" "$(rdelay OPS_ADMIN)"
cast call $MANAGER "getRoleAdmin(uint64)(uint64)" "$(rid QUOTER)" --rpc-url $RH_RPC   # == rid OPS_ADMIN
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid OPS_ADMIN)" $SAFE_ADMIN --rpc-url $RH_RPC
```

`hasRole` for `OPS_ADMIN` must come back with a second value of 0. If it does not, this lane is
delayed and a leaked key stays live for that long — that is an incident of its own
(`v2_mon_manager_wiring`, `ops/alerts.md` §V54).

Revoke the old address and grant the new one **in one Safe transaction**, so there is no window in
which the bot's lane is dead and no second signing round at three in the morning. `grantRole` takes
the execution delay for the new member as its third argument, and it must be the manifest's:

```bash
NEWKEY=0x…                                   # the address ops/v2/derive-bot-keys.sh just derived
R=QUOTER
REVOKE=$(cast calldata "revokeRole(uint64,address)"        "$(rid $R)" $QUOTER)
GRANT=$( cast calldata "grantRole(uint64,address,uint32)"  "$(rid $R)" $NEWKEY "$(rdelay $R)")
cast calldata "multicall(bytes[])" "[$REVOKE,$GRANT]"      # `to` = $MANAGER, one Safe transaction
```

Then prove both halves:

```bash
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid $R)" $QUOTER --rpc-url $RH_RPC   # false
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" "$(rid $R)" $NEWKEY --rpc-url $RH_RPC   # true, and the delay above
```

The registry, key-file and Railway half of a rotation — which must happen in a particular order or
the tools refuse it — is `incident-v2.md` §4d. Do that first and this is its on-chain step.

**A grant with the wrong delay is silent.** Nothing reverts; the member simply runs on a different
clock from the published one, in whichever direction you typed. `v2_mon_manager_role` compares the
granted delay with the manifest and says so (`ops/alerts.md` §V53), which is the only thing that
catches it. That is why the third argument above is `$(rdelay $R)` and not a number.

---

## 7. The two reverts you will actually see

Both mean "no", and they mean opposite things about what to do next.

| Revert | Selector | What it is telling you |
|---|---|---|
| `V2Errors.NotAuthorized()` | `0xea8e4eb5` | **wrong role.** This caller is not a member, or the selector is mapped to a role it does not hold. Scheduling will not help. |
| `AccessManagerNotScheduled(bytes32)` | `0x60a299b0` | **right role, nothing scheduled.** This caller is a member *with a delay* and there is no ready operation for exactly this (caller, target, calldata). Go to §4. |

Derive both rather than trusting the table, and decode what you actually got:

```bash
cast sig "NotAuthorized()"                       # 0xea8e4eb5
cast sig "AccessManagerNotScheduled(bytes32)"    # 0x60a299b0
```

`NotAuthorized` is declared in `ops/abis/v2/V2Errors.json` and `AccessManagerNotScheduled` in
`ops/abis/v2/AccessManager.json`; both files are in this repository, so a revert data blob can be
decoded offline against them.

Where `NotAuthorized` comes from: `Managed` overrides `_checkCanCall` so that every unauthorised call
in v8 reverts the *same* error as the rest of v2 rather than OpenZeppelin's
`AccessManagedUnauthorized(address)` (`src/v2/access/Managed.sol:9-15` for the reason,
`Managed.sol:65-72` for the three-line body). Where `AccessManagerNotScheduled` comes from: the
delayed branch hands off to `super._checkCanCall`, which asks the manager to consume a scheduled
operation and gets the manager's own error when there is none — `Managed.sol:25-26` calls that "the
honest answer: the role was right and the operation was missing."

Two neighbours worth recognising, from the same ABI file, so you do not read them as the above:

- `AccessManagerNotReady(bytes32)` — scheduled, but its time has not come. Wait; do not re-schedule.
- `AccessManagerExpired(bytes32)` — scheduled, ready, and left past `expiration()`. Schedule again
  and take the full delay a second time (§4.3).

---

## 8. What the monitor will page while you do this

`ops/v2/monitor.mjs` watches the manager and both Safes. Expect these, and check them off as yours:

- `v2_mon_manager_operation` (`ops/alerts.md` §V52) — one page per `OperationScheduled`,
  `OperationExecuted` and `OperationCanceled`, with the operation id and nonce.
- `v2_mon_manager_role` (`ops/alerts.md` §V53) — any change to who may do what, including the
  manager's `RoleGranted` / `RoleRevoked`, role-admin and guardian changes, and selector re-mappings.
- `v2_mon_manager_wiring` (`ops/alerts.md` §V54) — the manager's **state** against the manifest. It
  keeps firing until the chain and `ops/abis/v2/roles.json` agree, where an event pages once. This is
  the one that catches a change made while the monitor was down.
- `v2_mon_safe_threshold` (`ops/alerts.md` §V55) — a protocol Safe below two signatures, on sight,
  with no history needed.

The manager's `RoleGranted(uint64,address,uint32,uint48,bool)` and AccessControl's
`RoleGranted(bytes32,address,address)` share a name and have different topics. The monitor gives the
manager's forms names of their own for exactly that reason; a `cast logs` line of yours must carry
the full typed signature, as in §4.3, or it will match the wrong event or nothing at all.

Tell the on-call before you schedule. A page nobody owns is treated as a compromised Admin Safe
(`incident-v2.md` §5), and that response is expensive.

---

## 9. Do NOT

- Do not call `grantRole` / `hasRole` / `revokeRole` **on a target contract**. There are no roles
  there in v8; the call reverts, and a reverting check reads like a safe one.
- Do not retype a role id, an execution delay, a role admin or a role guardian. Use `rid`, `rdelay`,
  `radmin`, `rguard` over `ops/abis/v2/roles.json` — a wrong id names a different role and a wrong
  delay is a send into a window that has not opened.
- Do not route a funds-moving call through `AccessManager.execute`. The target sees the manager as
  `msg.sender` (§4.4).
- Do not re-schedule an operation that is merely not ready. `AccessManagerNotReady` is a wait;
  re-scheduling raises the nonce and can restart the clock.
- Do not lower a member's execution delay to "move faster during an incident". Lowering it is itself
  an ADMIN-lane operation with ADMIN's delay, and the reduction only takes effect after the
  difference has elapsed — it cannot help today and it weakens tomorrow.
- Do not expect the guardian to cancel a role or mapping change. It cannot: `ADMIN` has no guardian
  (§5).
- Do not put a key on a command line. `--account` and a Foundry keystore, always (§2).
