# v8 launch canary

The v8 equivalent of [`v2-canary.md`](v2-canary.md), on the same section skeleton, so an operator who
has run the v2 canary can navigate this one. Read that runbook's §1 first if you have not: everything
it says about the shell, the keys and the abort posture still applies.

> **§2 AND §3 NOW CARRY THEIR COMMANDS.** They were blocked on `C8-10`, which has landed. Every flag
> below is one an argument parser accepts at the contracts commit this app repo pins — check the
> gitlink with `git ls-tree HEAD contracts` rather than trusting a hash typed here, which is how the
> previous note in this place went stale: it named a commit that no longer was the pin, and nothing
> re-read it. At the current pin `script/v2/` contains `DeployV8.s.sol`, `VerifyV8.s.sol`,
> `BroadcastV8.s.sol`, `broadcast-v8.sh`, `roles.v8.json` and `fixtures/registry-v8.json`.
> Re-verified 2026-09-21 (T-OP-095) at callhouse `eab902369ef5d97a400d6d32fb263beafc39e8f4`: the gitlink is
> contracts `d9999d1ea89ffeded82ba98af850d33dbb94941f`, and the contracts `v8` tip that carries the P0 batch is
> `0d43097a7b65c5fde31492948c5483b96ddeb329` — every `:line` below was re-read at THAT tip, and §1 precondition 4
> says what the one-export gap between the two costs you.
> The rule that produced the block still holds: **an invented flag is a run that never starts.** If
> you add a flag here, point at the parser line that accepts it, and add the assertion to
> `ops/runbooks-v8-launch.test.mjs` that would have caught you.

## Shell setup

As `v2-canary.md` §Shell setup, with two v8 additions.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
export RH_RPC=${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}
export MANAGER=            # the AccessManager, once deployed (ops/devnet/addresses.json on a devnet)
export ADMIN_SAFE=         # the 2-of-3 Admin Safe (OWN8-01)
```

No private key is ever exported, typed or pasted in this runbook. Signing is the Safe's, through the
admin driver; the guardian's hot key lives where `ops/deploy.md` §15 says it lives.

## 1. Preconditions

- [ ] `ops/markets/tier1.json` is the launch set: NVDA `canary`, nineteen markets `wave1`, fifteen
      `wave2` (O8-10) — **that is the rollout ORDER, not what launches.** What launches is the registry's
      `launchSet.markets`, `NVDA` and `SPCX` only (owner ruling 2026-09-21, written into `launchSet.note`;
      `ops/markets/build-markets.mjs:1766-1788` validates the block and refuses a production registry without
      one). Waves and `launchSet` answer different questions and nothing infers one from the other. The
      registration step (§2) takes its tickers from `V2_TICKERS`
      (`contracts/script/v2/RegisterMarkets.s.sol:49`, `:225`), so on launch day that is `V2_TICKERS=NVDA,SPCX`.
      `node --test ops/markets/build-markets.test.mjs` is green.
- [ ] Every launch market's `v2.payoutRoute` is decided — a route or a recorded null
      (`ops/markets/PAYOUT-ROUTES-V8.md`). The rows are **provisional** and re-measured before
      `OWN8-06`; the launch does not need them fresh, the buyback does.
- [ ] The Admin Safe exists, is 2-of-3, and its three owners are three different people. The monitor
      raises `v2_mon_safe_threshold` below two signatures.
- [ ] `ops/abis/v2/roles.json` is the published role manifest for the commit being deployed. Every
      role id and delay used below is read from it at run time, never typed from a plan document.
      **At callhouse `eab90236` it is not yet that manifest**: it was exported from contracts `d9999d1e`
      (the gitlink, commit `02d3da3d`), and contracts `0d43097a` differs in two rows —
      `HouseVault.setOracle(address) → CONFIG_ADMIN` (T-OP-058) is absent from `targets`, and AutoRoller
      `stop(address)` is absent from `unrestricted`. The delays are identical. Re-export from the commit being
      deployed (`script/v2/export-abis.sh` in the contracts repo, then re-pin the gitlink) before launch day,
      or `devnet-admin.mjs` plans `HouseVault setOracle` from a manifest that does not know the selector.
- [ ] The contracts commit being deployed is green in CI under forge **v1.5.1** in both jobs
      (`.github/workflows/ci.yml:43-44`, `:68-69`; T-OP-043) with `check-env-names.sh` and
      `check-fork-floors.sh` run before the toolchain (`:35-37`; T-OP-040). The fork job carries **one
      expected red**, `HouseVaultSettlement`, until T-OP-044 lands; a second red is a stop, not a shrug. A
      `forge fmt` result from any other forge version is not evidence (root `AGENTS.md`, tooling pin).
- [ ] The v7 set is still running and **not** frozen. It is frozen only after v8 verifies (§6).
- [ ] `node ops/v2/devnet-admin.mjs --help` runs. This is the one path admin calls take.

## 2. Deploy

One wrapper runs the whole path and gates itself: `script/v2/broadcast-v8.sh` in the contracts
repository. **A dry run is the default and sends nothing** (`broadcast-v8.sh:14-15`).

```bash
# 2a. EXPORT THE RECORD PATH FIRST. The wrapper does NOT set it (:545 invokes DeployV8 without it)
#     and DeployV8.s.sol:210 defaults it to empty, which writes NO record — and §2c below has
#     nothing to consume. Export it before the run, not after.
export V2_DEPLOY_RECORD_OUT="$PWD/broadcast/v8/deploy-record.json"

# 2a'. EXPORT THE V2_* INPUTS, ALL OF THEM — see the paragraph under this block. The wrapper exports
#      ONLY V2_EXPECT_CHAIN_ID (:544-545 for DeployV8, :596-597 for RegisterMarkets). Nothing below
#      starts without them.

# 2b. DRY RUN — prints the plan and every refusal it would apply, sends nothing. This is the default.
./script/v2/broadcast-v8.sh --registry ops/markets/tier1.json --rpc "$RH_RPC"

# 2c. THE REAL THING. BOTH flags are required; either alone is refused (:17-18).
./script/v2/broadcast-v8.sh --registry ops/markets/tier1.json --rpc "$RH_RPC" --execute --chain-id 4663
```

`--registry` `:228`, `--rpc` `:229`, `--execute` `:230`, `--chain-id` `:231`, `--from` `:232`,
`--run-dir` `:233`, `--self-test` `:234`; anything else dies at `:236`. **Keys never go on a command
line, and the wrapper enforces that rather than asking.** `:218-219` rejects every key-bearing flag
it knows of, and any bare hex argument, before it even considers `--help` — read that line for the
list; it is deliberately not repeated here, because a runbook that spells out key flags is one
copy-paste away from being the problem it warns about. The signing keys are read from the
environment by the forge scripts themselves.

`--execute` needs the deployer's **address** for VerifyV8 and refuses without it: export
`V2_DEPLOYER`, or let it derive the address (never the key) from `DEPLOYER_PK` (`:179-193`).

**THE WRAPPER DOES NOT BUILD THE `V2_*` ENVIRONMENT, AND AS OF CONTRACTS `0d43097a` NOTHING IN THIS
RUNBOOK'S PATH DOES (found by T-OP-095, 2026-09-21; open).** `DeployV8` takes every input from `V2_*`
(`script/v2/lib/V2DeployBase.sol:335-464`): the Safes, the bot keys, USDG, the routers, the fees and
the buyback pool are `vm.envAddress` / `vm.envUint` reads (`:366-371`, `:381-386`, `:391-397`,
`:446-453`), and those cheatcodes **revert when the variable is unset**, so the forge simulation dies
before a transaction is built. `RegisterMarkets` likewise needs `V2_TICKERS` and the per-market
`V2_MARKET_<T>_*` set (`RegisterMarkets.s.sol:54-66`, `:225` "V2_TICKERS is empty"), and the wrapper's
register step does not even set `V2_TICKERS` (`:596-597`; the dry-run line at `:592` prints it, the
execute line does not pass it). The only in-repo producer of that environment from the registry is
`DeployV2Batch.sh` (`env_name()`, `export_contracts` `:736`, `export_market` `:743`), which
`broadcast-v8.sh` does not call — it mirrors that script's key list (`:44-47`) and nothing else.
Consequences for the operator until a contracts row closes this: (1) 2c as written stops at "environment
variable not found" — a **stop before any transaction**, not a partial deploy; (2) the whole `V2_*` set
must be exported in the shell that runs 2c, from the registry, with the v8 names (`payoutAdapter` is
`V2_PAYOUT_ROUTER` since T-OP-022, `V2_ADMIN` is gone in favour of `V2_ADMIN_SAFE` —
`docs/DEPLOY-V2.md:491-493`); (3) no end-to-end run of this driver against any node has ever been made
(T-192's own ledger entry, suspicion 5). Reported to the coordinator as driver drift with this row;
`DeployV2Batch.sh` is not a substitute, because it still registers BEFORE it verifies (`:1237-1246`,
then `VerifyV8` at `:1330`), which is the ordering `broadcast-v8.sh` exists to refuse.

**Two gates in the wrapper decide whether anything is registered, and both are worth knowing before
you run it.** Registration requires *this run's* verify receipt — `--from register` on a fresh run
directory dies rather than proceeding (`:95`). And **VerifyV8 exiting 0 is not accepted as a pass**:
it must print a `VERIFY PASSED:` line or the wrapper refuses with "that is NOT a pass — it is a
VerifyV8 that did not run its checks. NOTHING IS REGISTERED" (`:116`). Resume a stopped run with
`--from deploy|verify|register` and `--run-dir <that run's dir>`; resuming cannot skip the gate.

Then write the deployment record back into the registry (O8-08A):

```bash
node ops/markets/write-back-v8.mjs --deployment "$V2_DEPLOY_RECORD_OUT"
```

It refuses to write a half-filled registry and rebuilds `v2.protocolAddresses` from its twins. It
takes `--deployment <file> [--registry <path>] [--check] [--force]`; `--registry` does not need
`--force`, and `--check` writes nothing and reports the diff.

Do not improvise the broadcast from `DeployV2.s.sol`. v8 is a different contract set with an
AccessManager in front of it.

## 3. Wiring and parameters

The batch runs through the admin driver. Everything below is current:

**Every admin call goes through the driver, never from an EOA.** Under v8 each restricted call is
`schedule` → wait the role's delay → `execute`, and `v8-plan/06-QUIRKS.md:40` records that the
existing devnet, rehearsal and acceptance scripts still send admin calls straight from the admin EOA,
which is wrong under delays. The driver is `ops/v2/devnet-admin.mjs` (`ops/v2/ADMIN-DRIVER.md`):

```bash
node ops/v2/devnet-admin.mjs --dry-run <Target> "<signature>" [args...]   # plan only, sends nothing
node ops/v2/devnet-admin.mjs --manager $MANAGER --safe $ADMIN_SAFE <Target> "<signature>" [args...]
node ops/v2/devnet-admin.mjs --cancel --guardian <addr> <Target> "<signature>" [args...]
```

`--dry-run`, `--cancel`, `--no-preflight`, `--manager`, `--safe`, `--guardian`, `--help` are the whole
flag set; anything else is a `UsageError`. Run the `--dry-run` first and read the plan: it prints the
role, the delay it read from `roles.json`, and the operation id you will need to execute or cancel.

**Caps and delays are read, not typed.** Every role delay comes from `ops/abis/v2/roles.json`; the
buyback cap is read from the deployed FeeSplitter, and `BUYBACK_COOLDOWN` / `BUYBACK_CAP_CEIL` are
`V2Constants` compiled into it (`src/v2/periphery/FeeSplitter.sol:210`, `:330`), not manifest fields —
`roles.json` carries neither name. Do not copy a number out of `v8-plan/03-INTERFACES.md` into this
file: entry 2 of `v8-plan/status/INTERFACE-CHANGES-V8.md` is what happens when a plan document is
trusted over the artifact — two selector pins were simply wrong.

**The lanes, cross-checked against `script/v2/roles.v8.json` at contracts `0d43097a` (T-OP-095).**
`roles`/`delaysS`: ADMIN 172800 s, FEE_MANAGER 172800, MARKET_FEE_MANAGER 259200, CONFIG_ADMIN 86400,
TREASURY_ADMIN 86400, LISTING 3600, and OPS_ADMIN / GUARDIAN / PRICER / QUOTER / BUYBACK at 0.
`holders`: the Admin Safe holds ADMIN, FEE_MANAGER, MARKET_FEE_MANAGER, CONFIG_ADMIN, TREASURY_ADMIN,
LISTING, OPS_ADMIN, GUARDIAN and QUOTER; `guardianKey` GUARDIAN; `pricerKey` PRICER; `quoterKey` QUOTER;
`crankerKey` BUYBACK. `roleAdmin` parents GUARDIAN, PRICER, QUOTER and BUYBACK to OPS_ADMIN;
`roleGuardian` lets GUARDIAN cancel FEE_MANAGER, MARKET_FEE_MANAGER, CONFIG_ADMIN, TREASURY_ADMIN and
LISTING operations. The app copy (`ops/abis/v2/roles.json`) agrees on every one of these; it differs
only in the two `targets`/`unrestricted` rows §1 precondition 4 names.

**The HouseVault batch (T-OP-058, T-OP-064).** `HouseVaultFactory.createVault(...)` is LISTING (1 h).
The vault's own restricted set at `0d43097a`: the ten QUOTER entries (`depositToClearinghouse`,
`withdrawFromClearinghouse`, `place`, `replace`, `cancel`, `take`, `close`, `claimOwed`, `sync`,
`refreshApprovals`), `setLimits` and `setPerformanceFeeBps` under TREASURY_ADMIN (24 h),
`setProtocolAccount` and **`setOracle(address)` under CONFIG_ADMIN (24 h)** — the row T-OP-058 added
so a market-oracle migration can reach the vault's boundary; a factory batch that maps the vault's
selectors must include it. `rollEpoch`, `requestDeposit`, `requestWithdraw`, the two cancels and
`claim` are deliberately ungated (`unrestricted.HouseVault`). **Vault fees launch at 0 with no setter
call**: `performanceFeeBps` is a storage default (`HouseVault.sol:233`) and neither `DeployV8` nor
`RegisterMarkets` calls `setPerformanceFeeBps`; setting it later is a TREASURY_ADMIN operation through
the driver. The T-OP-081 full-stack rehearsal, whose scheduled-operation list this section was to be
checked against, had **not landed** at the time of this re-verification (`ops/runbooks/v8-fork-rehearsal.md`
still says every step is `blocked`); re-check §3 against it when it does.

**Compiled, not wired — the P0-batch values an operator might look for a call to set and must not.**
`AutoRoller.MIN_ASK_BPS = 50` and `MAX_REPRICE_DROP_BPS = 2_500` (`src/v2/AutoRoller.sol:129`, `:138`;
T-OP-063). `Clearinghouse.SPOT_READ_GAS = 240_000` (`src/v2/Clearinghouse.sol:106`; T-OP-080). The spot
rule (T-OP-061 / T-OP-087): `SPOT_CORROBORATION_AGE = 30 minutes`, `MIN_UNCORROBORATED_DELAY = 30 minutes`,
`MAX_UNCORROBORATED_DELAY = 24 hours`, `MAX_SPOT_MAX_AGE = 4 days`
(`src/v2/oracle/SettlementOracle.sol:213-227`) — accuracy-by-agreement past 30 min, so no step anywhere
should read "`spotMaxAgeS` 25 h means the print may be 25 h old"; none of the three v8 runbooks does.
`EarnVault.convertToShares` / `convertToAssets` / `preview*` **revert `PositionOpen` while a position
is open** (T-OP-065): no step in this runbook reads them, and none may be added that does — use the
`indicative*` views.

## 4. Services

As `v2-canary.md` §4, with the v8 service set. The registry is baked into the keeper image, so a
registry change rebuilds `pricing`, `cranker`, `pricer`, `mm-bot` **and** `monitor` (the monitor reads
the baked file; ops/deploy.md §15.12). Bring up `relay` and `monitor` before the signing bots: the
monitor is the only thing that notices a wedged loop after boot.

## 5. The first market day

Day-one triage. Every kind below is one `ops/v2/monitor.mjs` emits today — the test asserts it.

| Alert kind | What it means | First move |
|---|---|---|
| `v2_mon_safe_threshold` | the Admin Safe is below two signatures | stop. This is the control plane. |
| `v2_mon_manager_operation` | an operation was scheduled, executed or cancelled on the AccessManager | match it to a driver run; an unrecognised one is an incident |
| `v2_mon_manager_role` | a role was granted, revoked or its delay changed | same: match to a run, or treat as unauthorised |
| `v2_mon_manager_wiring` | a target's authority is not the manager you deployed | halt admin actions; the wiring is wrong |
| `v2_mon_fee_scheduled` / `v2_mon_fee_change_pending` | a fee change is scheduled or waiting out `FEE_CHANGE_DELAY` | confirm it is yours; it becomes live without another call |
| `v2_mon_mint_rent` | a non-zero rent rate under v8, where rent is off | the registry or a market is misconfigured |
| `v2_mon_route_changed` / `v2_mon_route_wiring` / `v2_mon_route_decode` | a payout route moved, is wired wrong, or will not decode | conversions are the blast radius, not settlement |
| `v2_mon_splitter_idle` / `v2_mon_splitter_floor_miss` | the splitter is not distributing, or missed its floor | fee money is accruing unswept; not urgent, not ignorable |
| `v2_mon_buyback_stuck` / `v2_mon_buyback_unburned` | buyback is not running, or bought and did not burn | check the cranker's BUYBACK role and the cooldown |
| `v2_mon_oracle_halted` | an `OraclePaused` has been seen on a launch-set Stock Token (NVDA, SPCX) since the last unpause (T-OP-083) | `ops/alerts.md` §V30a: list the expiries inside the halt; a series settling on the pool alone is the veto candidate |

Settlement, feed and pool alerts behave as in `v2-canary.md` §5, with two v8 differences: the spot
rule is accuracy-by-agreement (§3, T-OP-061/087 — a stale print is refused, not aged), and a halt on
a launch market pages by itself (`v2_mon_oracle_halted`, above).

## 6. Abort and rollback

**v7 is frozen only after v8 verifies.** Until `FreezeV7.s.sol` (the v7 freeze — `v7-runoff.md`;
`FreezeV1.s.sol` is the older v1 tool and not this step) / the v8 verification step has run, aborting is
clean: v8 is deployed but unused, v7 is still serving, and nothing has to be unwound. That ordering is
the whole reason the freeze is last.

After the freeze, rollback is not a script — it is the incident runbook, the guardian pause, and a
decision by the owner. Do not plan to rely on it.

## 7. Sign-off

As `v2-canary.md` §7: named person, timestamp, the SHAs of all four repos, the deployment record file,
and the monitor's first clean pass. Add for v8: the Safe's three owners and threshold as read on
chain, and the role manifest hash the deploy used.

## 8. Dry-run record

**Not yet executed — blocked on F8-03's devnet path and C8-10.** No dry run has been performed for
this runbook, and nothing below is a record of one. Headings kept so the shape is ready:

> Re-verified 2026-09-21 (T-OP-095): still not executed. The two blockers named above have both
> landed — C8-10 (§2 carries its commands) and the devnet path (`ops/devnet/`). What blocks a dry run
> now is §2a′: the wrapper does not build the `V2_*` environment. The line above is kept as history.

- Date, operator, chain and block:
- Commands run, in order:
- What differed from this runbook:
- Alerts raised during the run:

## Related

- [`v2-canary.md`](v2-canary.md) — the v2 canary this follows
- [`incident-v2.md`](incident-v2.md) — what to do when one of the alerts above fires
- [`v8-safes.md`](v8-safes.md), [`v8-roles.md`](v8-roles.md) — the Safe and role set-up
- [`v7-runoff.md`](v7-runoff.md) — the run-off this launch starts
- [`v8-fork-rehearsal.md`](v8-fork-rehearsal.md) — the full-stack rehearsal (O8-06 / T-OP-081), not finished
- `ops/v2/ADMIN-DRIVER.md` — the one way an admin call is made under v8
- `ops/markets/PAYOUT-ROUTES-V8.md` — the payout routes and their provisional status

### Provenance

Re-verified by `T-OP-095` (claude-615885) on 2026-09-21 at callhouse `eab902369ef5d97a400d6d32fb263beafc39e8f4`
against contracts `0d43097a7b65c5fde31492948c5483b96ddeb329` (read-only checkout `wt/v8-contracts`; the gitlink
at this base is `d9999d1ea89ffeded82ba98af850d33dbb94941f`). Every `:line` in §2 was re-read in
`script/v2/broadcast-v8.sh`, `script/v2/DeployV8.s.sol`, `script/v2/lib/V2DeployBase.sol` and
`script/v2/RegisterMarkets.s.sol` at that tip; §3's lanes were read from `script/v2/roles.v8.json` and diffed
against `ops/abis/v2/roles.json`; §5's kinds were grepped in `ops/v2/monitor.mjs` at this base. Scratch runs,
all read-only and none a gate: `node ops/v2/devnet-admin.mjs --help` (exit 0) and
`node ops/markets/write-back-v8.mjs --help` (exit 2, usage) from this tree. Not run: the broadcast wrapper, any
`forge` command, `ops/runbooks-v8-launch.test.mjs`, `build-markets.test.mjs`; no network. The two facts this
pass could not establish are marked in place: the §2a′ environment gap is UNVERIFIABLE-UNTIL-BROADCAST and open,
and the T-OP-081 scheduled-operation cross-check is pending that row.
