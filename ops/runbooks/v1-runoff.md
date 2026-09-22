# Runbook — v1 freeze and run-off

**What this is.** ADR-10 of the Stonkhouse v2 plan, run on the live chain: freeze every v1 account
factory (today one, NVDA `0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb`), let the weeks already
listed run to their own expiry, keep `settle()` cranked, keep the v1 exercise page up until the
last v1 option has expired plus 24 hours, then switch off `keeper-nvda` and the v1 `indexer` and
archive. v1 positions are not converted: writers withdraw from v1 and deposit into v2 themselves.

**Who runs it.** The owner: the freeze needs the guardian and admin keys, the redeploys need
Railway, the announcements and the docs push are public. Agents wrote it and rehearsed it on a fork
(§ Rehearsal record); nothing in it has been run on mainnet.

**Time budget.** Steps 0–7: about two hours on freeze day. Step 8: a few minutes after each
listed expiry, for at most 7 days plus seconds (21 days is the contract bound). Steps 9–11: under
an hour, once the last expiry is 24 hours old.

**Read with it.** `callhouse-contracts/docs/V1-RUNOFF.md` (what the freeze does and does not do,
read from `src/solo/`), `script/v2/freeze-v1.sh --help`, `keeper/README.md` (`SOLO_WIND_DOWN`,
alert `v1_drained`, the settle guard), `ops/markets/README.md` (`v1RunOff`, `v1FrozenAt`), `ops/deploy.md` §14.1–14.2
(`keeper-nvda`), `ops/alerts.md` (`v1_drained`, `v1_settle_held`).

Every step has **commands** (copy-paste, bash or zsh), **expected** output and an **abort**
condition. Keys never go on a command line: `read -rs` into the environment, `unset` afterwards.

---

## The timeline

| When | Step | Who | What users see |
|---|---|---|---|
| T − 1 day or more | 1. announce | owner | the announcement (§ User-facing text, A) |
| T, before the freeze | 2. rehearse on a fork · 3. read-only check | owner | nothing |
| T | 4. freeze · 5. post-check | owner (guardian + admin keys) | deposits and new v1 listings refused; unsold lots stop selling; `/legacy` banner says writes are halted (live read) |
| T + ~1 h | 6. registry + generated files + docs · 7. `keeper-nvda` to `SOLO_WIND_DOWN=1` | owner | text B; docs markets page "Running off: frozen on …"; banner shows the freeze date after the web rebuild |
| each `listedExpiryTs` until the last (≤ T + 7 days) | 8. watch `settle()` | keeper (holds a settle the issuers would strand); owner checks | accounts settle; reserved collateral becomes withdrawable |
| last expiry + 24 h | 9. the exercise page may go | owner decides | — |
| `liveCount() == 0` and step 9 passed | 10. switch off `keeper-nvda`, v1 `indexer` | owner | text C; `/legacy` history panels read "unavailable" |
| after 10 | 11. archive | owner | — |

---

## 0. Before you start

**Preconditions.** Every box, or do not start.

- [ ] v2 is the product users are sent to (ADR-10 freezes v1 "when v2 opens"). The web build that
      serves `/legacy` (`NEXT_PUBLIC_V2=1`, W2-12) is live, so v1 users have the migration page and
      the freeze banner.
- [ ] `callhouse-contracts` checkout on `v2` with `script/v2/freeze-v1.sh` (C2-14). Forge cache warm
      (`forge build` once).
- [ ] `callhouse` checkout on the ref Railway will deploy (`DEPLOY_REF` below), containing the
      keeper's `SOLO_WIND_DOWN` (K2-06), the `/legacy` freeze banner (W2-12) and this runbook,
      pushed to `origin`: `ops/keeper-railway.sh` builds from a fresh clone of `origin/<ref>`.
- [ ] `web/lib/markets.test.ts` no longer asserts that no market has a `v1FrozenAt` (the test
      "v1FrozenAt is null for every market at this build" at `80c97f6`). It fails the web gate the
      moment step 6 sets NVDA's date; the web lane makes it follow the registry first.
      `keeper/src/solo.winddown.test.ts` already holds on both sides of the freeze.
- [ ] Tools: foundry (`cast`, `forge`, `anvil`), `jq`, Node ≥ 22, pnpm, Railway CLI ≥ 5.47.2
      logged in (`railway whoami`).
- [ ] You hold the guardian key (hot wallet account 2) and the admin key (account 0), or the Safes
      that hold those roles if they were handed over.

**Shell setup.** Paste once per terminal; every later step assumes it.

```bash
APP=~/Desktop/robinhood-dev/callhouse                  # app repo at DEPLOY_REF
CONTRACTS=~/Desktop/robinhood-dev/callhouse-contracts  # branch v2
DOCS=~/Desktop/robinhood-dev/callhouse-docs            # branch v2
DEPLOY_REF=main                                         # the origin ref keeper-railway.sh deploys
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export PATH="$HOME/.foundry/bin:$PATH"
REG="$APP/ops/markets/tier1.json"
eval "$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const m = r.markets.find((x) => x.ticker === "NVDA");
  console.log(`F=${m.deployment.factory} NVDA=${m.asset} KEEPER=${m.deployment.keeper} GUARDIAN=${m.deployment.guardian} ADMIN=${m.deployment.admin} DEPLOY_BLOCK=${m.deployment.deployBlock} USDG=${r.shared.usdg} CLEAR=${r.shared.clearinghouse}`);
' "$REG")"
STOCK_REG=$(cast parse-bytes32-address "$(cast storage $NVDA 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50 --rpc-url $RH_RPC)")
echo "F=$F KEEPER=$KEEPER GUARDIAN=$GUARDIAN ADMIN=$ADMIN"; echo "USDG=$USDG CLEAR=$CLEAR NVDA=$NVDA STOCK_REG=$STOCK_REG DEPLOY_BLOCK=$DEPLOY_BLOCK"

# Read-only helpers.
n1() { awk '{print $1}'; }   # cast prints large numbers as "1789975676 [1.789e9]"; keep the number
runoff_table() {             # every live account: its expiry, whether settle() will redeem, its owner
  local n i a e
  n=$(cast call $F "liveCount()(uint256)" --rpc-url $RH_RPC | n1)
  echo "block $(cast block-number --rpc-url $RH_RPC)  liveCount $n  pendingCount $(cast call $F 'pendingCount()(uint256)' --rpc-url $RH_RPC | n1)  writesHalted $(cast call $F 'writesHalted()(bool)' --rpc-url $RH_RPC)"
  i=0
  while [ "$i" -lt "$n" ]; do
    a=$(cast call $F "liveAt(uint256)(address)" $i --rpc-url $RH_RPC)
    e=$(cast call $a "listedExpiryTs()(uint40)" --rpc-url $RH_RPC | n1)
    echo "$a  listedExpiryTs $e ($(date -u -r $e '+%F %T UTC'))  claimKey $(cast call $a 'claimKey()(uint256)' --rpc-url $RH_RPC | n1)  owner $(cast call $a 'owner()(address)' --rpc-url $RH_RPC)"
    i=$((i + 1))
  done
}
settle_safe() {              # settle_safe <account>: the redeem inside settle() needs all six false
  local a=$1 r
  r="USDG.paused=$(cast call $USDG 'paused()(bool)' --rpc-url $RH_RPC) USDG.isFrozen(account)=$(cast call $USDG 'isFrozen(address)(bool)' $a --rpc-url $RH_RPC) USDG.isFrozen(Clear)=$(cast call $USDG 'isFrozen(address)(bool)' $CLEAR --rpc-url $RH_RPC) NVDA.paused=$(cast call $NVDA 'paused()(bool)' --rpc-url $RH_RPC) isBlocked(account)=$(cast call $STOCK_REG 'isBlocked(address)(bool)' $a --rpc-url $RH_RPC) isBlocked(Clear)=$(cast call $STOCK_REG 'isBlocked(address)(bool)' $CLEAR --rpc-url $RH_RPC)"
  echo "$r"
  case "$r" in *true*) echo "NOT SAFE for $a: if its claimKey is not 0, settle() now strands the claim" ;; *) echo "SAFE for $a" ;; esac
}
```

**Expected.**

```
F=0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb KEEPER=0x06c131cfEd73A56893f5eB52D17252856FAFC1d2 GUARDIAN=0x29741A8d283a253E8Ce10aDfd04C6507438b6F39 ADMIN=0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 CLEAR=0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6 NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC STOCK_REG=0xe10b6f6B275de231345c20D14Ab812db62151b00 DEPLOY_BLOCK=64038234
```

`STOCK_REG` is the Stock Token access registry (the beacon in the token's EIP-1967 slot):
`isBlocked(address)` lives there, not on the token.

**Abort** if any address differs from the line above: the registry at `$APP` is not the one this
runbook was written against. Stop and find out why.

---

## 1. Announce

**Commands.** None. Post text A (§ User-facing text) with the planned date and time filled in, on
the channels you use (X, the site's notice, the Discord), and add it to the docs page
`legacy/moving-from-v1.md` (docs lane). Pick a freeze time between 05:00 and 23:59 UTC: the web
banner prints the date in New York time and the docs page in UTC, and inside that window they are
the same day.

**Expected.** The notice is public before the freeze.

**Abort.** Do not freeze earlier than the time you announced.

---

## 2. Rehearse on a fork (the gate)

On freeze day, against a fork of the current chain.

**Commands.**

```bash
cd "$APP"
ops/v1-runoff-rehearse.sh --contracts "$CONTRACTS"
```

It forks 4663 with anvil on port 8547 (`--port` to change), lists one unsold lot on the fork so
there is something to run off, runs `freeze-v1.sh --rehearse` then `--check`, the reads of steps
3, 5 and 8, the registry edit of step 6 on a temporary copy (with `keeper-env.sh`, `render-docs`,
`gen-markets` and `build-markets --check` on that copy), and the keeper from this checkout on the
rendered `NVDA.env` against the fork with a throwaway key: it must report `windDown`, settle the
account at its expiry, raise `v1_drained` once and send nothing else. The log goes to
`ops/runbooks/rehearsals/v1-runoff-<utc date>.log`; commit it with the run record. About four
minutes.

Minimum, contracts side only (if the app checkout is not at hand):

```bash
anvil --fork-url $RH_RPC --chain-id 4663 --port 8547 --code-size-limit 98304 > /tmp/anvil-v1-runoff.log 2>&1 &
cd "$CONTRACTS" && script/v2/freeze-v1.sh --rehearse --rpc http://127.0.0.1:8547 --registry "$REG"; echo "exit $?"
kill %1
```

**Expected.** The full rehearsal ends with

```
== REHEARSAL PASSED: <n> checks. Fork block <b>; freeze in block <b'>; v1FrozenAt <ts> on the fork (mainnet gets its own).
anvil stopped (port 8547)
```

and exit 0 (the 2026-09-17 run: 50 checks). The minimum ends
`== REHEARSAL PASSED: 1 v1 factory frozen on the fork, post-check passed, second run sent nothing`, exit 0.

**Abort.** Any `REHEARSAL FAILED` or `FREEZE FAILED` line, or a non-zero exit: do not go on today.
The line above it names the check.

---

## 3. Read-only check on mainnet

**Commands.**

```bash
cd "$CONTRACTS"
script/v2/freeze-v1.sh --check --dry-run --registry "$REG"
script/v2/freeze-v1.sh --check --rpc $RH_RPC --registry "$REG"; echo "exit $?"
FREEZE_FROM=$(cast block-number --rpc-url $RH_RPC); echo "FREEZE_FROM=$FREEZE_FROM"
runoff_table
cast call $F "week()(uint32,uint256,uint40,uint40,uint256)" --rpc-url $RH_RPC
cast balance $GUARDIAN --ether --rpc-url $RH_RPC
cast balance $ADMIN --ether --rpc-url $RH_RPC
```

**Expected.**

- The dry run lists exactly one factory:
  `NVDA   0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb  guardian 0x29741A8d283a253E8Ce10aDfd04C6507438b6F39  admin 0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b`.
- The check prints the state row
  `NVDA   0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb false   115792..(78 d) <live> <pending> registry guardian true, registry admin true`,
  the two calls `0xb28ea39f…0001` (`setWritesHalted(true)`) and `0x86651203…0000`
  (`setDepositCap(0)`), `PENDING: 2 call(s) left to Safe batches`,
  `== NOT FROZEN YET: batches for the missing calls are in …/broadcast/freeze-v1/<utc>`, and
  **exit 3**. Nothing is sent.
- `runoff_table`: `writesHalted false`, then one line per live account. Write down `FREEZE_FROM`,
  `liveCount`, `pendingCount` and the largest `listedExpiryTs` in the run record.
- Each balance above 0.0005 ETH (the two calls used 52,080 and 29,975 gas on the fork).

`liveCount 0` is the easy case: nothing is listed, and the run-off ends at the freeze. With live
accounts, every lot listed and not yet sold stops selling at the freeze (intended), and sold
options run to their `listedExpiryTs`.

**Abort.**
- `FREEZE FAILED` (exit 1): a tool, the RPC, or the registry is wrong; the message says which.
- `registry guardian false` or `registry admin false`: the registry's role holders changed. Stop.
- A factory other than `0xc4A5…2BBb` in the plan.
- `writesHalted true` already: someone halted the factory. Find out who before going on (the
  script would only send the cap).

---

## 4. Freeze

### 4a. With the keys (today's setup)

**Commands.**

```bash
cd "$CONTRACTS"
read -rs GUARDIAN_PK && export GUARDIAN_PK   # paste the guardian key (hot wallet account 2); nothing echoes
read -rs ADMIN_PK && export ADMIN_PK         # paste the admin key (hot wallet account 0)
script/v2/freeze-v1.sh --broadcast --rpc $RH_RPC --registry "$REG"; echo "exit $?"
#   read the plan it prints, then type:  freeze
unset GUARDIAN_PK ADMIN_PK
```

**Expected**, in order:

```
  GUARDIAN_PK address 0x29741A8d283a253E8Ce10aDfd04C6507438b6F39
  ADMIN_PK address    0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b
  NVDA   0xc4A5…2BBb false   115792..(78 d) …  registry guardian true, registry admin true, GUARDIAN_PK true, ADMIN_PK true
MAINNET. Freezing 1 v1 factory on chain 4663 at https://rpc.mainnet.chain.robinhood.com:
  halts from 0x29741A8d283a253E8Ce10aDfd04C6507438b6F39
  caps  from 0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b
Type the word "freeze" to send the transactions: freeze
== FreezeV1 --broadcast
  …guardian key executed 1 call(s) from 0x29741A8d283a253E8Ce10aDfd04C6507438b6F39
  …admin key executed 1 call(s) from 0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b
== FreezeV1, key-less, against the chain
  …post-check PASSED: 3 checks on 1 factories
  NVDA   0xc4A5…2BBb true    0              …
== FROZEN: 1 v1 factory: all halted with a zero deposit cap, post-check passed against the chain
exit 0
```

The transactions are in `broadcast/freeze-v1/<utc>/run-latest.json` (with hashes); the halt is
sent before the cap.

**Abort.**
- A printed key address is not the one above, or a role reads `false`: type anything but
  `freeze` (nothing is sent), `unset GUARDIAN_PK ADMIN_PK`, stop.
- `FREEZE FAILED: FreezeV1 (broadcast) failed`: forge simulates the whole script before sending,
  so a refusal there sent nothing; a failure after the first receipt may have sent the halt only.
  Run step 5's `--check`: it says what is missing. Re-running 4a is safe (idempotent: it skips
  what landed).
- Exit 3 with both keys exported: a key did not reach forge. Stop and check the environment.

### 4b. With a Safe for a role

Only if the guardian or admin role has been handed to a Safe. The batches from step 3 are in
`$CONTRACTS/broadcast/freeze-v1/<utc>/`.

**Commands.**

```bash
cd "$CONTRACTS"
B=$(dirname "$(ls -t broadcast/freeze-v1/*/guardian-safe-batch.json | head -1)"); echo "$B"   # step 3's run
jq -r '.transactions[] | .to + " " + .data' "$B/guardian-safe-batch.json"
cast calldata-decode "setWritesHalted(bool)" "$(jq -r '.transactions[0].data' "$B/guardian-safe-batch.json")"
jq -r '.transactions[] | .to + " " + .data' "$B/admin-safe-batch.json"
cast calldata-decode "setDepositCap(uint256)" "$(jq -r '.transactions[0].data' "$B/admin-safe-batch.json")"
```

Import the guardian batch in Safe{Wallet} → Transaction Builder on the guardian Safe, sign, execute;
then the admin batch on the admin Safe. The app warns that the file has no checksum: expected.

**Expected.** One transaction per file, `to` = `0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb`; the
decodes print `true` and `0`.

**Abort.** Any other `to`, any other decoded value, or more than one transaction in a file.

---

## 5. Post-check and `v1FrozenAt`

**Commands.**

```bash
cd "$CONTRACTS"
script/v2/freeze-v1.sh --check --rpc $RH_RPC --registry "$REG"; echo "exit $?"
cast call $F "writesHalted()(bool)" --rpc-url $RH_RPC
cast call $F "depositCap()(uint256)" --rpc-url $RH_RPC
cast logs --from-block $((FREEZE_FROM + 1)) --to-block latest --address $F "WritesHalted(bool)" --rpc-url $RH_RPC --json | jq -r '.[] | [.blockNumber, .transactionHash, .data] | @tsv'
cast logs --from-block $((FREEZE_FROM + 1)) --to-block latest --address $F "DepositCapSet(uint256)" --rpc-url $RH_RPC --json | jq -r '.[] | [.blockNumber, .transactionHash, .data] | @tsv'
HALT_BLOCK=$(cast to-dec $(cast logs --from-block $((FREEZE_FROM + 1)) --to-block latest --address $F "WritesHalted(bool)" --rpc-url $RH_RPC --json | jq -r '.[-1].blockNumber'))
CAP_BLOCK=$(cast to-dec $(cast logs --from-block $((FREEZE_FROM + 1)) --to-block latest --address $F "DepositCapSet(uint256)" --rpc-url $RH_RPC --json | jq -r '.[-1].blockNumber'))
FREEZE_BLOCK=$(( HALT_BLOCK > CAP_BLOCK ? HALT_BLOCK : CAP_BLOCK ))
V1_FROZEN_AT=$(cast block $FREEZE_BLOCK --field timestamp --rpc-url $RH_RPC)
echo "HALT_BLOCK=$HALT_BLOCK CAP_BLOCK=$CAP_BLOCK FREEZE_BLOCK=$FREEZE_BLOCK V1_FROZEN_AT=$V1_FROZEN_AT ($(date -u -r $V1_FROZEN_AT '+%F %T UTC'))"
# A keeper listing is refused now (any existing account's owner will do):
OWNER0=$(cast logs --from-block $DEPLOY_BLOCK --to-block latest --address $F "AccountCreated(address,address,uint32)" --rpc-url $RH_RPC --json | jq -r '.[0].topics[1]' | sed 's/^0x000000000000000000000000/0x/')
cast call $F "listFor(address)" $OWNER0 --from $KEEPER --rpc-url $RH_RPC
runoff_table
```

**Expected.**
- `--check`: `post-check PASSED: 3 checks on 1 factories`, `== FROZEN: 1 v1 factory: all halted with a zero deposit cap, post-check passed`, **exit 0**.
- `true`, then `0`.
- Exactly one `WritesHalted` line ending `…0001` and one `DepositCapSet` line ending `…0000`; their
  transaction hashes are the ones in `run-latest.json` (4a) or the Safe executions (4b).
- `V1_FROZEN_AT` is the timestamp of the block holding the later of the two transactions: the
  first block in which both halves of the freeze were in force.
- `listFor` fails with `execution reverted` and data `0x46855cdc` (`WritesAreHalted()`). Before the
  freeze the same call reverts with `0x3f79168f` instead (the account has nothing requested).
- `runoff_table` prints `writesHalted true` and the same accounts as in step 3. Write the last
  `listedExpiryTs` down as `LAST_EXPIRY` (or `V1_FROZEN_AT` when `liveCount` is 0), and
  `UI_UNTIL=$(( (LAST_EXPIRY > V1_FROZEN_AT ? LAST_EXPIRY : V1_FROZEN_AT) + 86400 ))`.

**Abort.**
- `--check` exit 3, `writesHalted` false or a cap other than 0: the missing call did not land.
  Back to step 4 for it.
- More than one event of either kind, or a `WritesHalted` line ending `…0000`: someone else
  changed the factory in between. Stop, check the guardian and admin keys
  (`ops/runbooks/incident.md`), and do not go on.
- **Never** lift the halt on a v1 factory: the Seaport orders of unsold lots are still validated
  and would fill again (`docs/V1-RUNOFF.md`).

Post text B (§ User-facing text) now.

---

## 6. Registry, generated files, docs, commit

**Commands.** In the app checkout at `DEPLOY_REF`, with `V1_FROZEN_AT` from step 5.

```bash
cd "$APP"
node -e '
const fs = require("fs"); const [file, t, ts] = process.argv.slice(1);
if (!/^[1-9][0-9]{9}$/.test(ts)) throw new Error("v1FrozenAt must be unix seconds, got " + ts);
const r = JSON.parse(fs.readFileSync(file, "utf8"));
const i = r.markets.findIndex((m) => m.ticker === t);
if (i < 0 || !r.markets[i].deployment?.factory) throw new Error(t + ": no such market with a factory");
const o = {};
for (const [k, v] of Object.entries(r.markets[i])) {
  if (k === "v1RunOff" || k === "v1FrozenAt") continue;
  o[k] = v;
  if (k === "status") { o.v1RunOff = true; o.v1FrozenAt = Number(ts); }
}
r.markets[i] = o;
fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
console.log(t + ": v1RunOff true, v1FrozenAt " + ts + " (" + new Date(ts * 1000).toISOString() + ")");
' ops/markets/tier1.json NVDA "$V1_FROZEN_AT"
git diff ops/markets/tier1.json
node ops/markets/build-markets.mjs --check; echo "exit $?"
node ops/keeper-env.sh
grep -n '^SOLO_WIND_DOWN=' ops/keeper/markets/NVDA.env
node ops/keeper-env.sh --check; echo "exit $?"
pnpm --filter @callhouse/web gen:markets
grep -n 'v1FrozenAt: [0-9]' web/lib/markets.generated.ts
node ops/markets/render-docs.mjs --docs-dir "$DOCS"
grep -F 'Running off: frozen on' "$DOCS/product/markets.md"
node ops/markets/render-docs.mjs --check --docs-dir "$DOCS"; echo "exit $?"
pnpm --filter @callhouse/keeper test > /tmp/keeper-test.log 2>&1; echo "keeper tests exit $?"
(cd web && pnpm test > /tmp/web-test.log 2>&1); echo "web tests exit $?"
# copy-lint was removed on 2026-09-21; this step no longer exists
git add ops/markets/tier1.json ops/keeper/markets/NVDA.env web/lib/markets.generated.ts
git commit -m "Freeze the NVDA v1 factory: v1RunOff and v1FrozenAt"
(cd "$DOCS" && diff -rq product docs/product && git add product/markets.md docs/product/markets.md && git commit -m "Markets page: NVDA v1 factory frozen")
```

Then push both (`origin`, owner-gated; the docs push **publishes** GitBook, which is intended now)
and let `web` rebuild from `DEPLOY_REF` (`v1FrozenAt` is compiled in: build time, `ops/deploy.md` §6).

**Expected.**
- `NVDA: v1RunOff true, v1FrozenAt <ts> (<iso>)`; the diff is exactly two added lines,
  `"v1RunOff": true,` and `"v1FrozenAt": <ts>,`, right after `"status": "live",`.
- `build-markets --check`: `v2: 35 market blocks, 13 pools checked on chain at block <n>, 0 problem(s)`, `no drift`, exit 0 (a `note:` line about pool liquidity is informational).
- `keeper-env.sh`: `NVDA   live     vol   factory 0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb  -> ops/keeper/markets/NVDA.env` and `keeper-env: 1 written, 34 unchanged, 35 market(s)`; grep: `SOLO_WIND_DOWN=1`; `--check`: `35 file(s) match the registry`, exit 0.
- `gen:markets`: `wrote lib/markets.generated.ts: 35 markets …`; grep: one line, `v1FrozenAt: <ts>,`.
- `render-docs`: two `written` lines (`product/markets.md` and `docs/product/markets.md`); the grep
  shows the NVDA row: `Running off: frozen on <YYYY-MM-DD>, so no new writes and no deposits. Listed weeks still settle, and withdrawals and USDG claims keep working.`; `--check` exit 0.
- Keeper tests, web tests, copy-lint: exit 0. `diff -rq` prints nothing.

**Abort.**
- The diff has anything but those two lines: `git checkout ops/markets/tier1.json` and redo.
- Any exit other than 0: do not commit; fix first. A red web test naming `v1FrozenAt` is the
  precondition of step 0 not met.

---

## 7. `keeper-nvda` to `SOLO_WIND_DOWN=1`

Do it the same day. Until it runs, the old keeper process is on a halted factory: its `listFor`
simulations fail and send nothing, but it can still send a harmless `setWeek` when a week is due.

**Commands.** From `$APP` at the pushed `DEPLOY_REF`.

```bash
cd "$APP"
railway link -p 9988a803-0b8f-4b0e-8ada-ba71e5a505ae -e 319fcb44-0e25-4367-947c-09351a349d2e
railway service list --json | jq -r '.[].name' | grep '^keeper'
railway variables --service keeper --json | jq -r 'keys[]' | grep -E '^(FACTORY|VAULT|WIND_DOWN)$'
ops/keeper-railway.sh --tickers NVDA --ref "$DEPLOY_REF"                                # dry run: read the plan
ops/keeper-railway.sh --tickers NVDA --ref "$DEPLOY_REF" --i-understand-this-deploys    # type: yes
railway ssh --service keeper-nvda -- node -e 'Promise.all(["/health","/state"].map((p)=>fetch("http://127.0.0.1:8787"+p).then((r)=>r.json()))).then(([h,s])=>console.log(JSON.stringify({status:h.status,windDown:h.factory.windDown,writesHalted:h.factory.writesHalted,liveCount:h.factory.liveCount,pendingCount:h.factory.pendingCount,weekId:h.factory.weekId,hasKeeperRole:h.factory.hasKeeperRole,nextWeek:s.nextWeek,drainedAt:s.drainedAt,settleHeld:s.settleHeld})))'
railway logs --service keeper-nvda --lines 200 | grep -E 'factory wiring verified|SOLO_WIND_DOWN|v1_drained|v1_settle_held|settled'
cast call $F "week()(uint32,uint256,uint40,uint40,uint256)" --rpc-url $RH_RPC
```

**Expected.**
- Services: `keeper` and `keeper-nvda`. `keeper` has `VAULT` and `WIND_DOWN`, **not** `FACTORY`.
- Dry run: `keeper-env --check: 35 file(s) match`, `NVDA: factory 0xc4A5…2BBb, keeper 0x06c131cfEd73A56893f5eB52D17252856FAFC1d2, KEEPER_ROLE=true`, and the plan's variable list includes `SOLO_WIND_DOWN`.
- Deploy: `keeper-nvda deployment SUCCESS`, `keeper-nvda /health: 200 status=ok market=NVDA factory=0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb hasKeeperRole=true`, `KEEPERS DEPLOYED`.
- The probe prints `"windDown":true,"writesHalted":true,…,"nextWeek":null,…,"settleHeld":[]`. The logs show
  `SOLO_WIND_DOWN: v1 run-off; settling only, never setWeek or listFor`, and the relay shows the
  boot alert `keeper online for NVDA factory 0xc4A5… (v1 run-off: settle only)`. With `liveCount`
  and `pendingCount` both 0, the `v1_drained` alert follows within a minute.
- `week()`: from here on the id never changes again (write it in the run record).

**Abort.**
- `keeper` has `FACTORY`: it still drives the NVDA factory. Remove `FACTORY` from `keeper` first
  (`ops/deploy.md` §14.5 step 5: both use key index 1), then run the deploy.
- `windDown` missing or `false`, or a `setWeek` from `0x06c1…C1d2` after this step: the image lacks
  K2-06 or the variable did not land. `railway down --service keeper-nvda -y`, fix the ref, deploy
  again. Nothing is at risk while it is down: `settle()` is permissionless.
- `settleHeld` missing from the probe: the image predates the settle guard. Deploy a ref that has
  it; until then run step 8 by hand (stop the keeper before any sold account's `listedExpiryTs`
  while `settle_safe` says NOT SAFE).

Seal nothing new: `KEEPER_PK` is kept as it was (`--rotate-key` is not used).

---

## 8. Watch `settle()` after each `listedExpiryTs`

Skip to step 9 if `liveCount` was 0 at the freeze.

**The rule (C2-14 / K2-06).** `settle()` redeems a sold account's Valorem claim with a caught
call. If that redeem fails (USDG paused; the account or the Clear frozen on USDG or blocked on the
Stock Token), `settle()` still completes, clears `listedExpiryTs` and **keeps the claim for good**:
a second `settle()` reverts `TooEarly` and `WriterAccount` has no other redeem. So **nothing of
ours may settle an account with `claimKey != 0` while any `settle_safe` read is true.** An account
with `claimKey 0` sold nothing; its `settle()` has no redeem and is safe at any time. Anyone else
can still call `settle()`; that is outside our control.

**The keeper enforces the rule itself (settle guard).** Before it sends `settle()` for an expired
account, it reads `claimKey()` and the same six gates as `settle_safe`, in one multicall: USDG
`paused()`, USDG `isFrozen(account)`, USDG `isFrozen(Clear)`, NVDA `paused()`, and
`isBlocked(account)` / `isBlocked(Clear)` on NVDA's `ACCESS_CONTROLLED_REGISTRY()` (the same
address as `STOCK_REG`). If `claimKey` is not 0 and any gate is true, or any of those reads fails,
it sends nothing for that account, alerts `v1_settle_held` (warn; `data.reason` is `usdg_paused`,
`usdg_frozen`, `clear_usdg_frozen`, `asset_paused`, `asset_blocked`, `clear_asset_blocked` or
`read_failed`) once per account per reason, and lists the account in `/state` `settleHeld`. It
tries again every tick and settles on the first tick every read is false. `settle_safe` stays as
the backup check, and it is the check to run before any settle by hand.

**Commands.** In the hour before each account's `listedExpiryTs` (from `runoff_table`):

```bash
runoff_table
settle_safe <account>
```

Within 10 minutes after it:

```bash
runoff_table
cast call <account> "claimKey()(uint256)" --rpc-url $RH_RPC
cast logs --from-block $FREEZE_BLOCK --to-block latest --address <account> "Settled(uint256,uint256)" --rpc-url $RH_RPC --json | jq -r '.[] | [.blockNumber, .transactionHash, .data] | @tsv'
railway logs --service keeper-nvda --lines 200 | grep -E 'settled|settle would revert|tx_revert|v1_settle_held|settle hold lifted'
railway ssh --service keeper-nvda -- node -e 'fetch("http://127.0.0.1:8787/state").then((r)=>r.json()).then((s)=>console.log(JSON.stringify(s.settleHeld)))'
```

**Expected.**
- Before: `SAFE for <account>`.
- After (the keeper polls every 60 s): the account is gone from `runoff_table`, `claimKey` reads
  `0`, one `Settled` line whose data is `(nvdaReturned, strikeUsdg)`, a keeper log `settled`
  with the same transaction hash, no `v1_settle_held`, and `settleHeld` prints `[]`. The owner
  can now withdraw and claim.

**Abort / act.**
- `NOT SAFE` and `claimKey` not 0: the keeper holds that account by itself. After the expiry,
  confirm it: a `v1_settle_held` alert naming the account and the gate, the account in
  `settleHeld`, no `Settled` event. Leave the keeper running, do not settle by hand, and follow
  `ops/runbooks/incident.md` §5 (issuer freeze). When every read is false again, the keeper settles
  the account within a minute (log `settle hold lifted`, then `settled`); check it as in Expected.
- `NOT SAFE`, `claimKey` not 0, and the keeper does **not** hold it (no `settleHeld` in `/state`,
  so the image predates the guard): stop the keeper before the expiry with
  `railway down --service keeper-nvda -y`, and redeploy
  (`ops/keeper-railway.sh --tickers NVDA --ref "$DEPLOY_REF" --i-understand-this-deploys`) once
  every read is false again. Then re-check step 7's probe.
- `v1_settle_held` with `read_failed` while `settle_safe` says SAFE: the keeper's RPC is failing
  the reads (`data.failedReads`; check `rpc_lag`). It settles once the reads answer. If it still
  holds after 10 minutes, settle by hand as below.
- Still live 10 minutes after the expiry with no `v1_settle_held`: the keeper is down or wedged
  (`/health`, logs). Once `settle_safe` says SAFE, settle by hand from any funded wallet without
  putting a key on the line:
  `cast send <account> "settle()" --interactive --rpc-url $RH_RPC` (prompts for the key).
- `claimKey` still non-zero after a `Settled` event: the redeem failed and the claim is stranded
  (the v1 gap above). Record the account, its owner and `claimKey` in the run record and tell the
  writer; the collateral behind that claim cannot be recovered through the account.

---

## 9. The v1 exercise page: until the last expiry + 24 hours

Buyers exercise v1 calls on the Valorem clearinghouse inside `[exerciseTs, listedExpiryTs)`; the
`/legacy/<ticker>/book` page (W2-12 `ExercisePanel`) is the interface for it.

**Commands.**

```bash
echo "UI_UNTIL=$UI_UNTIL ($(date -u -r $UI_UNTIL '+%F %T UTC'))  now $(date -u +%s)"
curl -s -o /dev/null -w '%{http_code}\n' https://app.stonkhouse.fun/legacy/nvda/book
curl -s -o /dev/null -w '%{http_code}\n' https://app.stonkhouse.fun/legacy/nvda/account
```

**Expected.** `200` for both, every day until `UI_UNTIL`. After `UI_UNTIL` the exercise panel may be
removed in a web release (web lane). The `/legacy` account page stays for as long as any v1 account
holds assets (step 11 lists them): `withdraw` and `claimUsdg` have no deadline in the contracts.

**Abort.** A non-200 before `UI_UNTIL`: roll `web` back (`ops/deploy.md` §7). Do not merge a web
change that removes `/legacy` or builds without `NEXT_PUBLIC_V2=1` before `UI_UNTIL`.

---

## 10. Switch off `keeper-nvda` and the v1 `indexer`

**Gate commands.**

```bash
cast call $F "liveCount()(uint256)" --rpc-url $RH_RPC
cast call $F "pendingCount()(uint256)" --rpc-url $RH_RPC
echo "now $(date -u +%s)  UI_UNTIL $UI_UNTIL"
railway ssh --service keeper-nvda -- node -e 'fetch("http://127.0.0.1:8787/state").then((r)=>r.json()).then((s)=>console.log(JSON.stringify({windDown:s.windDown,drainedAt:s.drainedAt,liveCount:s.liveCount,pendingCount:s.pendingCount})))'
```

**Expected.** `liveCount` `0`; now past `UI_UNTIL`; `drainedAt` a timestamp, matching the relay's
info alert `NVDA v1 market drained: factory 0xc4A5… has no live or pending account; nothing is left to settle`.
`pendingCount` is normally 0. If it is not (an owner called `requestWrite` after the freeze), there
is no `v1_drained` and `drainedAt` stays null: `liveCount() == 0` is the gate, because a pending
account has nothing listed and nothing to settle.

**Abort.** `liveCount` above 0: back to step 8. Now before `UI_UNTIL`: wait.

**Commands**, archive first (step 11 needs these files), then stop:

```bash
mkdir -p ~/v1-runoff-archive && cd ~/v1-runoff-archive
railway logs --service keeper-nvda --lines 5000 > keeper-nvda.log
railway ssh --service keeper-nvda -- node -e 'Promise.all(["/health","/state"].map((p)=>fetch("http://127.0.0.1:8787"+p).then((r)=>r.json()))).then((x)=>console.log(JSON.stringify(x,null,2)))' > keeper-nvda-health-state.json
railway down --service keeper-nvda -y
railway variables --service web --json | jq -r 'to_entries[] | select(.key | test("^NEXT_PUBLIC_(V1_)?API_URL$")) | "\(.key)=\(.value)"'
railway logs --service indexer --lines 2000 > indexer.log
railway down --service indexer -y
curl -s -o /dev/null -w '%{http_code}\n' https://app.stonkhouse.fun/legacy
```

Before `railway down --service indexer`, open `indexer-v2` → Variables in the Railway UI:
`PONDER_RPC_URL_4663` must be a pasted value, not the reference `${{indexer.PONDER_RPC_URL_4663}}`
(`ops/deploy.md` §15.4), or deleting the v1 service later breaks `indexer-v2`.

**Expected.** Both `down` commands return without error; `railway service status --service keeper-nvda`
and `--service indexer` show no running deployment; `/legacy` answers `200`. The `/legacy` history
panels (vault history, activity) now read "unavailable" or fall back to a log scan
(`ops/deploy.md` §15.5): degraded, not broken. The `indexer` also served the closed pooled vault's
history; the vault's collect flow reads the chain and keeps working. Deleting
`NEXT_PUBLIC_V1_API_URL` on `web` (UI, then a rebuild) is optional tidying.

**Abort.** `PONDER_RPC_URL_4663` on `indexer-v2` is a reference: paste the value first. `/legacy`
not 200 after the indexer is down: redeploy the removed `indexer` deployment from the Railway UI
(Deployments → Redeploy) and hand the page to the web lane.

`railway service delete --service keeper-nvda -y` and `--service indexer -y` (they take their
volume and deployment history with them) only after step 11 is committed.

---

## 11. Archive

**Commands.**

```bash
cd "$APP"
# Every v1 account ever created, with what it still holds.
cast logs --from-block $DEPLOY_BLOCK --to-block latest --address $F "AccountCreated(address,address,uint32)" --rpc-url $RH_RPC --json \
  | jq -r '.[].topics[2]' | sed 's/^0x000000000000000000000000/0x/' | while read -r a; do
    echo "$a owner $(cast call $a 'owner()(address)' --rpc-url $RH_RPC) NVDA $(cast call $NVDA 'balanceOf(address)(uint256)' $a --rpc-url $RH_RPC | n1) USDG $(cast call $USDG 'balanceOf(address)(uint256)' $a --rpc-url $RH_RPC | n1) claimKey $(cast call $a 'claimKey()(uint256)' --rpc-url $RH_RPC | n1) listedExpiryTs $(cast call $a 'listedExpiryTs()(uint40)' --rpc-url $RH_RPC | n1)"
  done | tee ~/v1-runoff-archive/accounts-final.txt
runoff_table | tee ~/v1-runoff-archive/runoff-final.txt
cast call $F "writesHalted()(bool)" --rpc-url $RH_RPC
cast call $F "depositCap()(uint256)" --rpc-url $RH_RPC
```

Then: fill in the run record below, copy the archive files you want kept into
`ops/runbooks/rehearsals/` (logs are plain text; nothing in them is secret, but read them before
committing), commit, and tag the commit locally (`git tag v1-runoff-complete`; pushing tags is
owner-gated).

**Expected.** `writesHalted` `true`, `depositCap` `0`. Every account shows `listedExpiryTs 0`.
Accounts with a non-zero `NVDA` or `USDG` balance are writers who have not withdrawn yet: they can
at any time, from `/legacy/nvda/account` or the explorer's write-contract tab
(`withdraw(uint256)`, `claimUsdg()`). A non-zero `claimKey` is a stranded claim (step 8).

**What stays as it is, for good.**
- `writesHalted` true and the guardian's and admin's roles on the factory. Never unhalt.
- The registry row: `status: live`, `v1RunOff: true`, `v1FrozenAt`. `ops/keeper/markets/NVDA.env`
  stays rendered with `SOLO_WIND_DOWN=1` (a redeploy of it could only settle).
- Optional: revoke `KEEPER_ROLE` from `0x06c1…C1d2`
  (`cast send $F "revokeRole(bytes32,address)" $(cast keccak KEEPER_ROLE) $KEEPER --interactive --rpc-url $RH_RPC`, admin key at the prompt). `setWeek` has no effect on a halted factory either way.

**Hand-offs once archived.** Web lane: remove the v1 exercise panel (after `UI_UNTIL`); keep the
account page. Site lane: the "Legacy accounts" Valorem/Seaport risk groups on `/risks`, `/terms`
and `/legal` were kept "until the run-off is complete" (S2-02); they can go. Docs lane: post text C
on `legacy/moving-from-v1.md`.

---

## User-facing text

Plain statements of what the contracts do. No dates other than the ones read on chain, no
returns, no promises about the interface beyond today. Say "Stock Tokens". Fill the `<…>` from
the run record; times in New York time, with the UTC in brackets.

**A. Announcement (step 1).**

> **Stonkhouse v1 is closing to new activity.**
> The v1 NVDA account factory is scheduled to be frozen on Robinhood Chain on <DATE> at about
> <TIME> New York time. From that block:
> - v1 accounts no longer accept deposits, and no new v1 lots are listed. A lot that is listed
>   but not sold by then stops selling.
> - Calls already sold are not affected. Their buyers can exercise them in their normal exercise
>   window. v1 does not exercise for you: an in-the-money v1 call that is not exercised before its
>   expiry expires without payout.
> - Each v1 account settles after its own expiry. Settlement is open to anyone; our keeper
>   normally does it. Collateral reserved for a listing can be withdrawn after that account settles.
> - Withdrawals and USDG claims keep working. The contracts set no deadline for them.
> - v1 positions do not move to v2. To use v2, withdraw from v1 and deposit into v2 yourself.
>
> Steps: docs.stonkhouse.fun → Legacy → Moving from v1. Stonkhouse is unaudited. Stock Tokens and
> USDG carry issuer risk: a pause, freeze or blocklist at the moment a sold account settles can keep
> that account's collateral from coming back.

**B. At the freeze (after step 5).**

> **Stonkhouse v1 is frozen** as of block <FREEZE_BLOCK> (<FROZEN_AT, New York>).
> No deposits and no new listings on v1 from that block. The last v1 option on NVDA expires on
> <LAST_EXPIRY, New York>; after that, no v1 call can be exercised. Until then, holders of sold v1
> calls can exercise in the call's own window at app.stonkhouse.fun/legacy. Exercising is a
> transaction on the Valorem clearinghouse and does not depend on our site.
> Writers: your account settles after its expiry, then withdraw your Stock Tokens and claim your USDG
> from /legacy/nvda/account. To use v2, deposit there separately.

(With `liveCount` 0 at the freeze, replace the middle two sentences by: "No v1 option is open: every
v1 call has already expired and settled.")

**C. Run-off complete (after step 10).**

> **The v1 run-off is complete.** Every v1 NVDA account has settled, and the v1 keeper and the v1
> indexer are switched off. Nothing in v1 needs a keeper any more. If your v1 account still holds
> Stock Tokens or USDG, `withdraw` and `claimUsdg` on your account have no deadline in the
> contracts; the /legacy account page and the explorer's write-contract tab both call them.

### Where each piece shows up

| Surface | Picks up | When |
|---|---|---|
| Web `/legacy` banner (W2-12 `FreezeBanner`, `NEXT_PUBLIC_V2=1` builds only) | reads `writesHalted()` from the factory every 30 s: "New writes are halted on chain for NVDA." | at the freeze block, no deploy |
| same banner | the registry's `v1FrozenAt`, compiled into `web/lib/markets.generated.ts`: "Registry freeze date: NVDA: <Month D, YYYY>" (New York date) | after step 6's commit and the `web` rebuild |
| Docs markets page, legacy table (`ops/markets/render-docs.mjs`) | `v1RunOff` + `v1FrozenAt`: "Running off: frozen on <YYYY-MM-DD> (UTC date), so no new writes and no deposits. Listed weeks still settle, and withdrawals and USDG claims keep working." | after step 6's docs commit is pushed |
| Docs `legacy/moving-from-v1.md` | static page (docs lane): add text B, later C. Two of its sentences do not hold for a frozen factory and go in the same edit: "Cancel any unfilled lot … while its sale window remains open" (after the freeze no lot sells) and "If an issuer pause or blocklist makes redemption fail, retry after the restriction lifts" (a failed redeem inside `settle()` cannot be retried; step 8) | steps 5 and 10 |
| Site (`callhouse-site`) | the announcement notice; the "Legacy accounts" risk labels come off after step 11 | steps 1 and 11 |
| Keeper `/health`, `/state`; relay | `windDown`, `nextWeek: null`, `drainedAt`; alert `v1_drained` | steps 7 and 10 |

---

## Run record

Fill in as you go; commit with the logs.

| Item | Value |
|---|---|
| announcement posted (UTC) | |
| rehearsal log (step 2) | `ops/runbooks/rehearsals/v1-runoff-<date>.log` |
| `FREEZE_FROM`; `liveCount` / `pendingCount` before | |
| halt transaction, block | |
| cap transaction, block | |
| `FREEZE_BLOCK`, `V1_FROZEN_AT` (UTC) | |
| `LAST_EXPIRY`, `UI_UNTIL` (UTC) | |
| registry commit (app), docs commit | |
| `keeper-nvda` redeploy (UTC), `week()` id from then on | |
| each settle: account, tx, `claimKey` after | |
| stranded claims (account, owner, `claimKey`) | none expected |
| `v1_drained` (UTC) or `liveCount` 0 observed | |
| `keeper-nvda` down, `indexer` down (UTC) | |
| archive commit, tag | |

---

## Rehearsal record — 2026-09-17

`ops/v1-runoff-rehearse.sh` against an anvil fork of 4663 (port 8547), app `v2-O2-05-v1-runoff`,
contracts `v2-O2-05-rehearsal` (C2-14's `freeze-v1.sh`), registry unchanged (NVDA without
`v1RunOff`/`v1FrozenAt`). Full log: [`rehearsals/v1-runoff-2026-09-17.log`](rehearsals/v1-runoff-2026-09-17.log).
**Passed.** What it showed:

| Step | Result on the fork |
|---|---|
| 3 before | `writesHalted` false, `depositCap` max, live 0, pending 0, 1 account; guardian, admin and keeper hold their roles; USDG and NVDA not paused, the Clear not frozen or blocked |
| fork setup | one account, 2 NVDA deposited, 1 lot listed unsold through the real keeper address (impersonated): live 1, `listedExpiryTs` = `baseExpiryTs` + index |
| 2 `--rehearse` | 2 batch calls (`0xb28ea39f…0001`, `0x86651203…0000`) sent from the registry's guardian and admin (impersonated), status 1; post-check 3/3; second run "nothing to do" |
| 5 `--check` | exit 0, `post-check PASSED: 3 checks on 1 factories`; one `WritesHalted` and one `DepositCapSet` event; `v1FrozenAt` from the later block; `listFor` reverts `0x46855cdc`, `deposit(1)` reverts `0x935d630c` |
| 6 on a copy | registry diff exactly 2 lines; `keeper-env.sh --registry` adds only the run-off block with `SOLO_WIND_DOWN=1`; docs row "Running off: frozen on 2026-09-17"; `markets.generated.ts` one `v1FrozenAt`; `build-markets --check` no drift; real files unchanged, `keeper-env.sh --check` green |
| 7–8, 10 keeper | the keeper from the app checkout on the rendered `NVDA.env`: `/health` `ok`, `windDown` true, `writesHalted` true, `hasKeeperRole` true; `/state` `nextWeek` null; nonce 0 before expiry; warped to `listedExpiryTs`: one `settle` sent, live 0; `v1_drained` once, `drainedAt` set; `week()` unchanged; exactly one transaction |
| writer (step 11's claim) | `idleAssets` 2 NVDA after settle; `withdraw` on the frozen factory returned both |

The keeper's `oracle_paused` warning in the log is an artefact of the 4-day warp (the fork's feed
is older than `maxPriceAge` at the warped block); run-off settles do not read the feed. The same
day, the read-only blocks of steps 0, 3 and 11 were run verbatim in zsh against mainnet (not
frozen: `--check` exit 3, `liveCount` 0, guardian 0.01 ETH, admin 0.049 ETH), and the blocks of
steps 4b and 5 against a second fork frozen by `--rehearse`.

What it does **not** prove: the real guardian and admin keys and their broadcast (impersonated),
Safe{Wallet}, Railway (`keeper-railway.sh`, the image at `DEPLOY_REF`, the relay), the web and docs
deploys, a **sold** lot's redeem inside the keeper's settle (the contracts' fork test
`FreezeV1Fork.t.sol` covers a sold lot: exercise after the freeze, a stranger's settle, withdraw and
claim), and an issuer pause during the run-off.
