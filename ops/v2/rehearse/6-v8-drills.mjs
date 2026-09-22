#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * O8-06 — the full-stack v8 fork rehearsal runner.
 *
 *   node ops/v2/rehearse/6-v8-drills.mjs [--only <id>[,<id>]] [--fork-allowed] [--report <file>]
 *                                        [--contracts <dir>]
 *
 * WHAT THIS IS. Steps 1-5 of ops/v2/rehearse are the O2-03 rehearsal and they are v7-shaped: step 1
 * drives `DeployV2Batch.sh --rehearse` and `VerifyV2`, and the eleven drills registered in
 * 4-drills.mjs are the O2-03 set. Not one of them is a v8 drill. O8-06 is therefore not a run of the
 * existing harness — it is a second drill set, against the v8 deploy path, and this file is its
 * runner.
 *
 * WHAT IT GUARANTEES, which is the part that matters under build mode. Every required O8-06 step
 * produces an outcome, or the process exits non-zero naming the step that did not. There is no path
 * through this file that ends in a green report with a step quietly missing from it. That is
 * v8-plan.mjs's `assertComplete`, called last, after every drill has had its turn — and proved by
 * breaking in v8-plan.test.mjs rather than asserted here.
 *
 * HONEST SCOPE, stated rather than implied, because a deliberate shortfall is indistinguishable from
 * an accidental one once the author is gone:
 *
 *   IMPLEMENTED — the AccessManager family. Role handover, deployer renounce, the guardian cancelling
 *   a scheduled operation, hot-key rotation through OPS_ADMIN, and the hedger's disabled state. These
 *   are reads and sends against roles.v8.json plus the manager's own views, they need no story state,
 *   and I could write them faithfully from the file and the harness primitives.
 *
 *   NOT WRITTEN — the trading drills: fills, the daily and Friday settlements, both redemption legs,
 *   distribute/buyback/burn, the zap, the Earn vault funding leg, the lender claim, the House vault
 *   epoch and the v7 run-off. Each needs the step-3 story's state — a deployed v8 set, funded
 *   personas, live feeds — which this machine cannot produce without the fork gate. I did NOT write
 *   them blind. Nineteen drills of plausible on-chain code that has never executed is worth less than
 *   nothing here: it reads as done, nothing downstream would catch it under build mode, and the first
 *   person to run it would be debugging my guesses instead of the product. They are registered, and
 *   each reports exactly what remains to be written.
 *
 * Every one of those, implemented or not, gets an outcome. `blocked` with its blocker named IS the
 * deliverable for a step that cannot run yet (T-237 AC5); silence is not.
 * ------------------------------------------------------------------------------------------------- */
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  REQUIRED_STEPS, SOURCE, STATUSES, assertComplete, renderReport, summarize,
} from "./v8-plan.mjs";
import { describeBlockers, inspectContracts, preflightStep } from "./v8-preflight.mjs";

const argv = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const ONLY = argValue("--only") ? argValue("--only").split(",").map((s) => s.trim()).filter(Boolean) : null;

/**
 * The fork gate is an INPUT, never a sniff.
 *
 * Whether this machine may call an off-machine archive RPC is an owner decision taken per task — the
 * operator held T-107 for exactly this and the owner's grant there was explicitly scoped to that one
 * probe and inherited by nothing. So the runner refuses to infer it from a reachable endpoint or a set
 * variable: someone passes --fork-allowed, and the report records that they did.
 */
const FORK_ALLOWED = argv.includes("--fork-allowed");

const CONTRACTS_DIR = argValue("--contracts", process.env.CONTRACTS_DIR ?? path.resolve(process.cwd(), "..", "callhouse-contracts"));
const REPORT_FILE = argValue("--report", null);

const say = (line = "") => process.stdout.write(`${line}\n`);

/* ---------------------------------------------------------------------------------------------- *
 * Drill implementations.
 *
 * A drill returns `{ status, evidence }` on success or throws. It may also return `{ status:
 * "blocked", reason }` when it discovers at run time that its subject is not there — a drill is
 * allowed to find a blocker the preflight could not see from the file system.
 *
 * `unwritten(what)` is a first-class registration, not a stub that silently passes: it returns a
 * `blocked` outcome whose reason is the work remaining. The difference matters — a stub returning
 * `passed` is the failure mode this whole task exists to prevent.
 * ---------------------------------------------------------------------------------------------- */

const unwritten = (remaining) => async () => ({
  status: "blocked",
  reason: `drill not written: ${remaining}. It needs the step-3 story state (a deployed v8 set, funded personas, live feeds), which needs the fork gate; it was deliberately not written blind.`,
});

/**
 * The AccessManager drills share a shape: read roles.v8.json for the subject set, then assert against
 * the manager's own views. They are written against the harness primitives in lib.mjs (`read`, `send`,
 * `impersonate`, `events`) and the contracts' own accessors, so they MIRROR the deployment rather than
 * recomputing anything about it.
 *
 * In particular they do NOT recompute AccessManager operation ids locally. `hashOperation` is the
 * manager's own view and the fork has one deployed; asking it is both simpler and immune to the class
 * of bug where a locally re-derived constant silently disagrees with the chain. Mirror, do not
 * re-reason — the same rule the owner directive puts on pinned constants.
 */
async function roleHandover(ctx) {
  const { roles } = ctx.facts;
  if (!roles?.holders) return { status: "blocked", reason: "roles.v8.json has no .holders map to check the handover against" };
  const deployer = ctx.deployer;
  if (!deployer) return { status: "blocked", reason: "no deployer address in the rehearsal state: step 1 has not run on this fork" };

  const checked = [];
  for (const [roleName, id] of Object.entries(roles.roles ?? {})) {
    const principal = roles.holders?.[roleName];
    if (!principal) continue;
    const holds = await ctx.hasRole(id, principal);
    const deployerStillHolds = await ctx.hasRole(id, deployer);
    if (!holds) return { status: "failed", reason: `${roleName} (${id}) is not held by its named principal ${principal} after handover` };
    if (deployerStillHolds) return { status: "failed", reason: `the deployer still holds ${roleName} (${id}) after handover` };
    checked.push(`${roleName}=${principal}`);
  }
  if (checked.length === 0) return { status: "blocked", reason: "roles.v8.json named no (role, principal) pair to check: the handover would be vacuously true" };
  return { status: "passed", evidence: `${checked.length} roles held by their named principal and none by the deployer: ${checked.join(", ")}` };
}

async function deployerRenounce(ctx) {
  const { roles } = ctx.facts;
  const deployer = ctx.deployer;
  if (!deployer) return { status: "blocked", reason: "no deployer address in the rehearsal state: step 1 has not run on this fork" };

  const ids = Object.values(roles?.roles ?? {});
  if (ids.length === 0) return { status: "blocked", reason: "roles.v8.json listed no role ids, so 'holds nothing' would assert nothing" };

  for (const id of ids) {
    if (await ctx.hasRole(id, deployer)) return { status: "failed", reason: `the deployer still holds role ${id}` };
  }
  // Holding nothing is not the whole claim: the deployer must also be unable to GIVE itself a role.
  const regrant = await ctx.expectRevert(deployer, "grantRole", [0, deployer, 0]);
  if (!regrant.reverted) {
    return { status: "failed", reason: "the deployer holds no role but grantRole from it did NOT revert — renounce is incomplete" };
  }
  return { status: "passed", evidence: `deployer ${deployer} holds none of ${ids.length} roles and grantRole from it reverts ${regrant.reason}` };
}

async function guardianCancel(ctx) {
  const { roles } = ctx.facts;
  const delayed = Object.entries(roles?.delaysS ?? {}).filter(([, s]) => Number(s) > 0);
  if (delayed.length === 0) {
    return { status: "blocked", reason: "roles.v8.json lists no role with a non-zero delay, so there is no scheduled operation for the guardian to cancel — check .delaysS" };
  }
  const guardian = roles?.holders?.GUARDIAN ?? roles?.roleGuardian;
  if (!guardian) return { status: "blocked", reason: "roles.v8.json names no guardian principal (.holders.GUARDIAN / .roleGuardian)" };

  const op = await ctx.scheduleDelayedOperation(delayed[0][0]);
  if (!op) return { status: "blocked", reason: `could not schedule a delayed operation for ${delayed[0][0]}: nothing on the deployment takes one` };

  const cancelled = await ctx.cancelAs(guardian, op);
  if (!cancelled.ok) return { status: "failed", reason: `the guardian could not cancel the scheduled operation: ${cancelled.reason}` };

  // The cancel is only meaningful if the operation can then NOT execute. Breaking the protected fact
  // is the assertion, not the OperationCanceled event on its own.
  const executed = await ctx.expectExecuteRefused(op);
  if (!executed.refused) {
    return { status: "failed", reason: "the operation was cancelled and STILL executed — the cancel is cosmetic" };
  }
  return {
    status: "passed",
    evidence: `scheduled ${op.id} for ${delayed[0][0]} (delay ${delayed[0][1]}s), guardian ${guardian} cancelled it, execute then refused ${executed.reason}`,
  };
}

async function hotkeyRotation(ctx) {
  const { roles } = ctx.facts;
  const opsAdmin = roles?.holders?.OPS_ADMIN;
  const opsRoleId = roles?.roles?.OPS_ADMIN;
  if (opsAdmin == null || opsRoleId == null) {
    return { status: "blocked", reason: "roles.v8.json names no OPS_ADMIN principal or id, so the lane the rotation runs through does not exist in the file" };
  }
  const bot = ctx.botToRotate;
  if (!bot) return { status: "blocked", reason: "the rehearsal state names no bot key to rotate: step 1 has not funded the bots on this fork" };

  const rotated = await ctx.rotateKeyThroughOpsAdmin(bot);
  if (!rotated.ok) return { status: "failed", reason: `rotation through OPS_ADMIN failed: ${rotated.reason}` };

  const oldHolds = await ctx.hasRole(bot.roleId, bot.oldKey);
  const newHolds = await ctx.hasRole(bot.roleId, rotated.newKey);
  if (oldHolds) return { status: "failed", reason: `the OLD key ${bot.oldKey} still holds role ${bot.roleId} after rotation — the compromised key is still live` };
  if (!newHolds) return { status: "failed", reason: `the new key ${rotated.newKey} does not hold role ${bot.roleId} after rotation` };
  return { status: "passed", evidence: `role ${bot.roleId}: ${bot.oldKey} -> ${rotated.newKey} through OPS_ADMIN (${opsAdmin}), old key revoked` };
}

/**
 * "The hedger ships switched off" is PER ASSET, which is the part a drill written from the decision
 * rather than the code would get wrong.
 *
 * Hedger.sol:35 is `mapping(address asset => bool) public enabled`, not a single flag — there is also
 * a global `paused` (:36), but that is a separate lever and `hedge` checks both (:109-110, reverting
 * `Paused()` then `Disabled()`). So the claim to check is: for EVERY registered market asset,
 * `enabled[asset]` is false, and a `hedge` on it reverts. Reading one boolean would be a check that
 * cannot see most of its subject — an asset enabled at construction would sail past it.
 */
async function hedgerDisabled(ctx) {
  const hedger = ctx.contracts?.hedger;
  if (!hedger || /^0x0{40}$/i.test(hedger)) {
    return { status: "blocked", reason: "no hedger address in the deployment: V2_HEDGER was unset, so 'deployed but disabled' cannot be distinguished from 'not deployed'" };
  }
  const assets = ctx.marketAssets ?? [];
  if (assets.length === 0) {
    // Zero assets would make "every asset is disabled" vacuously true. That is the false green.
    return { status: "blocked", reason: "the rehearsal state lists no registered market asset, so 'every asset is disabled' would assert nothing — register markets first" };
  }

  const checked = [];
  for (const asset of assets) {
    if (await ctx.hedgerEnabledFor(hedger, asset)) {
      return { status: "failed", reason: `hedger ${hedger} has enabled[${asset}] == true; the launch decision is that it ships switched off for every asset` };
    }
    // Reading false is not enough: the flag has to actually gate the path.
    const use = await ctx.expectHedgeRefused(hedger, asset);
    if (!use.refused) {
      return { status: "failed", reason: `enabled[${asset}] reads false but a hedge on it did NOT revert — the flag does not gate the path` };
    }
    checked.push(`${asset}:${use.reason ?? "reverted"}`);
  }
  return {
    status: "passed",
    evidence: `hedger ${hedger} present; enabled[asset] false and hedge reverts for all ${checked.length} registered assets (${checked.join(", ")})`,
  };
}

/** id -> implementation. Every required step appears exactly once; v8-plan.test.mjs enforces the set. */
export const IMPLEMENTATIONS = {
  "v8-deploy": unwritten("run DeployV8 against the fork and record every deployed address and the deploy block"),
  "v8-role-handover": roleHandover,
  "v8-deployer-renounce": deployerRenounce,
  "v8-verify": unwritten("run VerifyV8 against the rehearsed deployment and record its check count and every _info line"),
  "v8-register": unwritten("run RegisterMarkets per ticker and assert the registry writeback"),
  "v8-fill": unwritten("a write, a book fill and a resale fill, with the taker fee checked against quoteTake's four values"),
  "v8-settle-daily": unwritten("snapshot, finalize, settle and redeem one daily expiry"),
  "v8-settle-friday": unwritten("the same through a Friday expiry, which needs the weekly calendar branch"),
  "v8-redeem-usdg-v4": unwritten("a redemption that pays USDG over the pinned v4 route, asserting the swap happened rather than a fallback"),
  "v8-redeem-in-kind": unwritten("a redemption for a market with no route, asserting the in-kind leg and that no swap was attempted"),
  "v8-distribute-buyback-burn": unwritten("distribute to the FeeSplitter, then buyback, then assert the burn half reached address(0) and the treasury half its Safe"),
  "v8-guardian-cancel": guardianCancel,
  "v8-hotkey-rotation": hotkeyRotation,
  "v8-zap": unwritten("a zap through StockZap — blocked ahead of the harness by StockZap having no deploy path at all"),
  "v8-earn-fund-lend": unwritten("an Earn vault deposit, the fundable/fund pair on a take, and the lending leg — blocked ahead of the harness by nothing constructing EarnVault"),
  "v8-lender-claim": unwritten("emit an epoch and claim against it, asserting the claimant's token delta"),
  "v8-house-vault-epoch": unwritten("a full House vault epoch: deposit, quotes, settle, the boundary transition, withdraw"),
  "v8-hedger-disabled": hedgerDisabled,
  "v8-v7-runoff": unwritten("a v7 expiry settling after the v8 deploy block while v8 fills in the same window, with the two registries kept apart"),
};

/**
 * The run context. Everything a drill touches on chain goes through here, so that the drills stay
 * readable and so a future harness wiring (once the fork gate lands) has one place to fill in.
 *
 * Deliberately NOT faked: each accessor throws until it is wired. A context whose methods returned
 * plausible defaults would let every implemented drill report `passed` against nothing at all, which
 * is precisely the shape this board has hit six times.
 */
export function makeContext(facts, state = {}) {
  const notWired = (what) => () => {
    throw new Error(`${what} is not wired: it needs a live fork from steps 1-3. Run with the fork gate, or expect this drill to report blocked.`);
  };
  return {
    facts,
    contracts: state.contracts ?? null,
    deployer: state.deployer ?? null,
    botToRotate: state.botToRotate ?? null,
    marketAssets: state.marketAssets ?? null,
    hasRole: state.hasRole ?? notWired("hasRole"),
    expectRevert: state.expectRevert ?? notWired("expectRevert"),
    scheduleDelayedOperation: state.scheduleDelayedOperation ?? notWired("scheduleDelayedOperation"),
    cancelAs: state.cancelAs ?? notWired("cancelAs"),
    expectExecuteRefused: state.expectExecuteRefused ?? notWired("expectExecuteRefused"),
    rotateKeyThroughOpsAdmin: state.rotateKeyThroughOpsAdmin ?? notWired("rotateKeyThroughOpsAdmin"),
    hedgerEnabledFor: state.hedgerEnabledFor ?? notWired("hedgerEnabledFor"),
    expectHedgeRefused: state.expectHedgeRefused ?? notWired("expectHedgeRefused"),
  };
}

/**
 * Run every required step and return the results map.
 *
 * Order of decision per step, and it matters:
 *   1. deselected by --only          -> skipped, with the reason recorded
 *   2. preflight says it cannot run  -> blocked, carrying the preflight's evidence
 *   3. the drill runs                -> whatever it returns
 *   4. the drill throws              -> failed, carrying the message
 * There is no fifth branch, and in particular there is no branch that records nothing.
 */
export async function runAll(facts, { only = null, forkAllowed = false, ctx = null, log = say } = {}) {
  const results = {};
  const context = ctx ?? makeContext(facts);

  for (const step of REQUIRED_STEPS) {
    const id = step.id;
    if (only && !only.includes(id)) {
      results[id] = { status: "skipped", reason: `deselected by --only ${only.join(",")}` };
      continue;
    }

    const pre = preflightStep(id, facts, { forkAllowed });
    if (!pre.runnable) {
      results[id] = { status: "blocked", reason: describeBlockers(pre), blockers: pre.blockers };
      log(`  BLOCKED  ${id}: ${results[id].reason}`);
      continue;
    }

    const impl = IMPLEMENTATIONS[id];
    if (!impl) {
      // Not a silent pass: a required step with no implementation is a hole in this file.
      results[id] = { status: "blocked", reason: `no implementation registered for ${id} in 6-v8-drills.mjs` };
      log(`  BLOCKED  ${id}: ${results[id].reason}`);
      continue;
    }

    try {
      const r = await impl(context);
      // T-552 (T-237 suspicion 1, "a default status"). This line used to read `status: r.status ?? "passed"`:
      // a drill that returned `{}` -- or `{ evidence }` from a code path that forgot its verdict -- was
      // counted PASSED and PROVEN, with nothing downstream able to tell it from a real pass, because
      // `passed` is the one status that needs no reason. That is the silent-pass shape this file exists to
      // refuse, sitting in the runner itself. A drill now names its outcome or it is a FAILED outcome that
      // says so; the throw path below already treats "the drill could not say" the same way.
      if (r == null || typeof r !== "object" || !STATUSES.includes(r.status)) {
        const got = r == null ? String(r) : JSON.stringify(r.status);
        results[id] = { status: "failed", reason: `the drill returned no valid status (got ${got}): a drill must name its outcome, it is never passed by default` };
      } else {
        results[id] = { ...r };
      }
      log(`  ${String(results[id].status).toUpperCase().padEnd(8)} ${id}${results[id].reason ? `: ${results[id].reason}` : ""}`);
    } catch (error) {
      results[id] = { status: "failed", reason: String(error?.message ?? error) };
      log(`  FAILED   ${id}: ${results[id].reason}`);
    }
  }
  return results;
}

async function main() {
  say(`O8-06 full-stack v8 fork rehearsal`);
  say(`  required set: ${REQUIRED_STEPS.length} steps, from ${SOURCE.from}`);
  say(`  contracts:    ${CONTRACTS_DIR}`);
  say(`  fork gate:    ${FORK_ALLOWED ? "GRANTED (--fork-allowed)" : "NOT GRANTED — every on-chain step will report blocked"}`);
  say("");

  const facts = inspectContracts(CONTRACTS_DIR);
  if (facts.scriptFileCount === 0) {
    say(`!! no scripts found under ${CONTRACTS_DIR}/script — pass --contracts <dir> or set CONTRACTS_DIR`);
  }

  const results = await runAll(facts, { only: ONLY, forkAllowed: FORK_ALLOWED });

  const s = summarize(results);
  say("");
  say(`${s.proven} of ${s.required} steps proven; ${s.failed} failed, ${s.blocked} blocked, ${s.skipped} skipped`);

  const report = renderReport(results, {
    forkBlock: results._forkBlock ?? null,
    fixtures: facts.scriptFileCount ? `${CONTRACTS_DIR} (${facts.scriptFileCount} script files)` : null,
  });
  if (REPORT_FILE) {
    writeFileSync(REPORT_FILE, `${report}\n`);
    say(`report written to ${REPORT_FILE}`);
  } else {
    say("");
    say(report);
  }

  // LAST, and the reason the file is shaped this way: a run that lost a step exits non-zero even when
  // every drill it did run was green.
  assertComplete(results);

  // A rehearsal that proved nothing is not a passing rehearsal. Blocked steps are honestly reported,
  // and they are still not evidence.
  if (s.failed > 0 || s.proven === 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`\nO8-06 RUNNER FAILED: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
