/**
 * The O8-06 runner: does it actually produce an outcome for every required step, under every way a
 * step can go wrong?
 *
 * The property under test is the one the whole task rests on — "every drill has an observed outcome"
 * — so the tests drive the runner into each failure mode (deselected, blocked by preflight, drill
 * throws, no implementation registered, context not wired) and require a recorded outcome every time.
 * A runner that silently dropped a step would still look fine from its own summary line; it is caught
 * here by comparing against the requirement, not against what the runner did.
 *
 *   node --test ops/v2/rehearse/6-v8-drills.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { IMPLEMENTATIONS, makeContext, runAll } from "./6-v8-drills.mjs";
import { REQUIRED_IDS, assertComplete, missingOutcomes, summarize } from "./v8-plan.mjs";
import { inspectContracts } from "./v8-preflight.mjs";

const emptyFacts = () => inspectContracts(mkdtempSync(path.join(tmpdir(), "o806-run-")));
const quiet = () => {};

test("every required step has an implementation registered", () => {
  // The hole this closes: a step added to the manifest and forgotten in the runner. It would still be
  // reported (as blocked, "no implementation registered"), but it should never get that far.
  for (const id of REQUIRED_IDS) {
    assert.equal(typeof IMPLEMENTATIONS[id], "function", `${id} has no implementation in 6-v8-drills.mjs`);
  }
  // And no implementations for steps that are not required — an extra is a sign the manifest moved.
  for (const id of Object.keys(IMPLEMENTATIONS)) {
    assert.ok(REQUIRED_IDS.includes(id), `${id} is implemented but is not a required O8-06 step`);
  }
});

test("without the fork gate every step is reported, and every one of them is blocked", async () => {
  const results = await runAll(emptyFacts(), { forkAllowed: false, log: quiet });

  assert.deepEqual(missingOutcomes(results), [], "no step may be left without an outcome");
  assert.doesNotThrow(() => assertComplete(results));

  const s = summarize(results);
  assert.equal(s.blocked, REQUIRED_IDS.length);
  assert.equal(s.proven, 0, "nothing is proven without a fork — a run that claimed otherwise would be the false green");
  for (const id of REQUIRED_IDS) assert.match(results[id].reason, /\S/, `${id} must carry a reason`);
});

test("the fork-gate blocker names the gate, not something vague", async () => {
  const results = await runAll(emptyFacts(), { forkAllowed: false, log: quiet });
  assert.match(results["v8-fill"].reason, /off-machine archive RPC/);
  assert.match(results["v8-fill"].reason, /owner-gated/);
});

test("--only still records the steps it did NOT run, as skipped with a reason", async () => {
  // The trap: `--only` producing a report that simply omits everything else, which reads as if the
  // rehearsal covered one step and had nothing else to say.
  const results = await runAll(emptyFacts(), { only: ["v8-verify"], forkAllowed: false, log: quiet });

  assert.deepEqual(missingOutcomes(results), []);
  assert.equal(results["v8-verify"].status, "blocked"); // preflight, since there is no fork
  assert.equal(results["v8-fill"].status, "skipped");
  assert.match(results["v8-fill"].reason, /deselected by --only/);
  assert.doesNotThrow(() => assertComplete(results));
});

test("a drill that THROWS becomes a failed outcome, never a missing one", async () => {
  // A complete tree so the preflight lets the drills run, with the fork gate on.
  const facts = { ...emptyFacts() };
  facts.constructs = new Set(["PayoutRouter", "FeeSplitter", "V4BuybackExecutor", "HouseVaultFactory", "EarnVault", "StockZap"]);
  facts.envKeys = new Set(["V2_HEDGER"]);
  facts.envKeyByName = new Map([["Hedger", "V2_HEDGER"]]);
  facts.verifyKnows = new Set(["Hedger", "HouseVault", "EarnVault", "StockZap"]);
  facts.roles = { roles: { ADMIN: 0, OPS_ADMIN: 6, GUARDIAN: 7 }, holders: {}, delaysS: {} };
  facts.scripts = new Set([
    "script/v2/DeployV8.s.sol", "script/v2/VerifyV8.s.sol", "script/v2/RegisterMarkets.s.sol", "script/v2/DeployLenderRewards.s.sol",
  ]);

  // An unwired context: every on-chain accessor throws. The implemented drills must come back failed
  // or blocked — never passed. This is the positive control for the whole runner: if an unwired
  // context can produce a pass, every green this file ever reports is meaningless.
  const results = await runAll(facts, { forkAllowed: true, ctx: makeContext(facts), log: quiet });

  assert.deepEqual(missingOutcomes(results), []);
  for (const id of REQUIRED_IDS) {
    assert.notEqual(results[id].status, "passed", `${id} must not pass against an unwired context`);
  }
  assert.equal(summarize(results).proven, 0);
});

// T-552 (T-237 suspicion 1). The suspicion named three shapes that would kill the completeness guarantee
// silently: an early return, a swallowing catch, and A DEFAULT STATUS. The first two are not in the
// runner (assertComplete is called last in main; a throwing drill becomes `failed`, tested above). The
// third WAS: `status: r.status ?? "passed"` counted a status-less return as a proven pass, and `passed`
// is the one status invalidOutcomes asks no reason for, so assertComplete could not see it either.
test("BREAK: a drill that returns without naming a status is FAILED, never passed by default", async () => {
  const facts = { ...emptyFacts() };
  facts.constructs = new Set(["PayoutRouter", "FeeSplitter", "V4BuybackExecutor", "HouseVaultFactory", "EarnVault", "StockZap"]);
  facts.envKeys = new Set(["V2_HEDGER"]);
  facts.envKeyByName = new Map([["Hedger", "V2_HEDGER"]]);
  facts.verifyKnows = new Set(["Hedger", "HouseVault", "EarnVault", "StockZap"]);
  facts.roles = { roles: { ADMIN: 0, OPS_ADMIN: 6, GUARDIAN: 7 }, holders: {}, delaysS: {} };
  facts.scripts = new Set([
    "script/v2/DeployV8.s.sol", "script/v2/VerifyV8.s.sol", "script/v2/RegisterMarkets.s.sol", "script/v2/DeployLenderRewards.s.sol",
  ]);
  const id = "v8-verify";
  const original = IMPLEMENTATIONS[id];
  try {
    // The shape a forgotten verdict takes: evidence, no status. It LOOKS like a pass.
    IMPLEMENTATIONS[id] = async () => ({ evidence: "VerifyV8 printed 31 checks" });
    const r1 = await runAll(facts, { only: [id], forkAllowed: true, ctx: makeContext(facts), log: quiet });
    assert.equal(r1[id].status, "failed", "a status-less return must not be counted as anything but failed");
    assert.match(r1[id].reason, /returned no valid status/);
    assert.equal(summarize(r1).proven, 0, "and it must not count as proven");
    assert.doesNotThrow(() => assertComplete(r1), "it is a complete outcome, with its reason, not a missing one");

    // A drill that returns nothing at all, and one that returns a status the manifest does not know.
    IMPLEMENTATIONS[id] = async () => undefined;
    const r2 = await runAll(facts, { only: [id], forkAllowed: true, ctx: makeContext(facts), log: quiet });
    assert.equal(r2[id].status, "failed");
    IMPLEMENTATIONS[id] = async () => ({ status: "ok", evidence: "spelled wrong" });
    const r3 = await runAll(facts, { only: [id], forkAllowed: true, ctx: makeContext(facts), log: quiet });
    assert.equal(r3[id].status, "failed");
    assert.match(r3[id].reason, /"ok"/);

    // The control: an explicit pass is still a pass, so the rule refuses the absence, not the verdict.
    IMPLEMENTATIONS[id] = async () => ({ status: "passed", evidence: "VerifyV8 printed 31 checks" });
    const r4 = await runAll(facts, { only: [id], forkAllowed: true, ctx: makeContext(facts), log: quiet });
    assert.equal(r4[id].status, "passed");
    assert.equal(summarize(r4).proven, 1);
  } finally {
    IMPLEMENTATIONS[id] = original;
  }
});

test("a wired context lets an implemented drill pass — the checker is not simply always red", async () => {
  // The other half of the control above. Without this, "nothing ever passes" would satisfy every
  // other test in this file.
  const facts = { ...emptyFacts() };
  facts.roles = {
    roles: { ADMIN: 0, OPS_ADMIN: 6, GUARDIAN: 7 },
    holders: { ADMIN: "0xADMIN", OPS_ADMIN: "0xOPS", GUARDIAN: "0xGUARD" },
    delaysS: {},
  };
  facts.scripts = new Set(["script/v2/DeployV8.s.sol"]);

  const ctx = makeContext(facts, {
    deployer: "0xDEPLOYER",
    // Every named principal holds its role; the deployer holds none.
    hasRole: async (_id, who) => who !== "0xDEPLOYER",
  });

  const results = await runAll(facts, { only: ["v8-role-handover"], forkAllowed: true, ctx, log: quiet });
  assert.equal(results["v8-role-handover"].status, "passed");
  assert.match(results["v8-role-handover"].evidence, /held by their named principal/);
});

test("BREAK: the deployer still holding a role fails the handover drill, naming the role", async () => {
  const facts = { ...emptyFacts() };
  facts.roles = { roles: { ADMIN: 0, OPS_ADMIN: 6 }, holders: { ADMIN: "0xADMIN", OPS_ADMIN: "0xOPS" }, delaysS: {} };
  facts.scripts = new Set(["script/v2/DeployV8.s.sol"]);

  // Break the protected fact: handover left ADMIN with the deployer.
  const ctx = makeContext(facts, {
    deployer: "0xDEPLOYER",
    hasRole: async (id, who) => (who === "0xDEPLOYER" ? id === 0 : true),
  });

  const results = await runAll(facts, { only: ["v8-role-handover"], forkAllowed: true, ctx, log: quiet });
  assert.equal(results["v8-role-handover"].status, "failed");
  assert.match(results["v8-role-handover"].reason, /deployer still holds ADMIN/);
});

test("BREAK: a renounce where grantRole does NOT revert is failed, not passed", async () => {
  // Holding no role is the easy half. The drill's whole point is the second half: the deployer must
  // also be unable to give itself one back. A drill that checked only the first half would pass here.
  const facts = { ...emptyFacts() };
  facts.roles = { roles: { ADMIN: 0 }, holders: { ADMIN: "0xADMIN" }, delaysS: {} };
  facts.scripts = new Set(["script/v2/DeployV8.s.sol"]);

  const ctx = makeContext(facts, {
    deployer: "0xDEPLOYER",
    hasRole: async () => false,
    expectRevert: async () => ({ reverted: false }),
  });
  const results = await runAll(facts, { only: ["v8-deployer-renounce"], forkAllowed: true, ctx, log: quiet });
  assert.equal(results["v8-deployer-renounce"].status, "failed");
  assert.match(results["v8-deployer-renounce"].reason, /did NOT revert/);

  // Restore: it reverts, and the drill passes.
  const ok = makeContext(facts, {
    deployer: "0xDEPLOYER",
    hasRole: async () => false,
    expectRevert: async () => ({ reverted: true, reason: "AccessManagerUnauthorizedAccount" }),
  });
  const good = await runAll(facts, { only: ["v8-deployer-renounce"], forkAllowed: true, ctx: ok, log: quiet });
  assert.equal(good["v8-deployer-renounce"].status, "passed");
});

test("BREAK: a cancelled operation that still executes fails the guardian drill", async () => {
  const facts = { ...emptyFacts() };
  facts.roles = { roles: { GUARDIAN: 7 }, holders: { GUARDIAN: "0xGUARD" }, delaysS: { CONFIG_ADMIN: 172800 } };
  facts.scripts = new Set([]);

  const base = {
    scheduleDelayedOperation: async () => ({ id: "0xOP" }),
    cancelAs: async () => ({ ok: true }),
  };

  const bad = makeContext(facts, { ...base, expectExecuteRefused: async () => ({ refused: false }) });
  const r1 = await runAll(facts, { only: ["v8-guardian-cancel"], forkAllowed: true, ctx: bad, log: quiet });
  assert.equal(r1["v8-guardian-cancel"].status, "failed");
  assert.match(r1["v8-guardian-cancel"].reason, /cancel is cosmetic/);

  const good = makeContext(facts, { ...base, expectExecuteRefused: async () => ({ refused: true, reason: "AccessManagerNotScheduled" }) });
  const r2 = await runAll(facts, { only: ["v8-guardian-cancel"], forkAllowed: true, ctx: good, log: quiet });
  assert.equal(r2["v8-guardian-cancel"].status, "passed");
});

test("BREAK: no delayed role in roles.v8.json blocks the guardian drill instead of passing vacuously", async () => {
  // The false green this prevents: every delay set to 0, so nothing can be scheduled, so the drill
  // finds nothing to cancel and reports success at having cancelled nothing.
  const facts = { ...emptyFacts() };
  facts.roles = { roles: { GUARDIAN: 7 }, holders: { GUARDIAN: "0xGUARD" }, delaysS: { CONFIG_ADMIN: 0 } };
  const results = await runAll(facts, { only: ["v8-guardian-cancel"], forkAllowed: true, ctx: makeContext(facts), log: quiet });
  assert.equal(results["v8-guardian-cancel"].status, "blocked");
  assert.match(results["v8-guardian-cancel"].reason, /no role with a non-zero delay/);
});

test("BREAK: a hedger that reads disabled but does not refuse a use is failed", async () => {
  const facts = { ...emptyFacts() };
  facts.envKeyByName = new Map([["Hedger", "V2_HEDGER"]]);
  facts.envKeys = new Set(["V2_HEDGER"]);
  facts.verifyKnows = new Set(["Hedger"]);

  const ctx = makeContext(facts, {
    contracts: { hedger: "0x00000000000000000000000000000000000000aa" },
    marketAssets: ["0xNVDA"],
    hedgerEnabledFor: async () => false,
    expectHedgeRefused: async () => ({ refused: false }),
  });
  const results = await runAll(facts, { only: ["v8-hedger-disabled"], forkAllowed: true, ctx, log: quiet });
  assert.equal(results["v8-hedger-disabled"].status, "failed");
  assert.match(results["v8-hedger-disabled"].reason, /does not gate the path/);
});

test("BREAK: one asset left enabled fails, even when the others are off", async () => {
  // The whole reason this drill iterates: `enabled` is per asset (Hedger.sol:35). A drill that read
  // one boolean would pass this case, which is a live hedger on TSLA at launch.
  const facts = { ...emptyFacts() };
  facts.envKeyByName = new Map([["Hedger", "V2_HEDGER"]]);
  facts.envKeys = new Set(["V2_HEDGER"]);
  facts.verifyKnows = new Set(["Hedger"]);

  const ctx = makeContext(facts, {
    contracts: { hedger: "0x00000000000000000000000000000000000000aa" },
    marketAssets: ["0xNVDA", "0xTSLA", "0xMETA"],
    hedgerEnabledFor: async (_h, asset) => asset === "0xTSLA",
    expectHedgeRefused: async () => ({ refused: true, reason: "Disabled()" }),
  });
  const results = await runAll(facts, { only: ["v8-hedger-disabled"], forkAllowed: true, ctx, log: quiet });
  assert.equal(results["v8-hedger-disabled"].status, "failed");
  assert.match(results["v8-hedger-disabled"].reason, /0xTSLA/);

  // Restore: all three off, and it passes naming all three.
  const ok = makeContext(facts, {
    contracts: { hedger: "0x00000000000000000000000000000000000000aa" },
    marketAssets: ["0xNVDA", "0xTSLA", "0xMETA"],
    hedgerEnabledFor: async () => false,
    expectHedgeRefused: async () => ({ refused: true, reason: "Disabled()" }),
  });
  const good = await runAll(facts, { only: ["v8-hedger-disabled"], forkAllowed: true, ctx: ok, log: quiet });
  assert.equal(good["v8-hedger-disabled"].status, "passed");
  assert.match(good["v8-hedger-disabled"].evidence, /all 3 registered assets/);
});

test("BREAK: no registered assets blocks rather than passing vacuously", async () => {
  // "every asset is disabled" over an empty list is true and means nothing.
  const facts = { ...emptyFacts() };
  facts.envKeyByName = new Map([["Hedger", "V2_HEDGER"]]);
  facts.envKeys = new Set(["V2_HEDGER"]);
  facts.verifyKnows = new Set(["Hedger"]);
  const ctx = makeContext(facts, { contracts: { hedger: "0x00000000000000000000000000000000000000aa" }, marketAssets: [] });
  const results = await runAll(facts, { only: ["v8-hedger-disabled"], forkAllowed: true, ctx, log: quiet });
  assert.equal(results["v8-hedger-disabled"].status, "blocked");
  assert.match(results["v8-hedger-disabled"].reason, /would assert nothing/);
});

test("BREAK: a zero hedger address blocks rather than reading as 'disabled'", async () => {
  // "Not deployed" and "deployed but off" are different claims, and only one of them is the decision.
  const facts = { ...emptyFacts() };
  facts.envKeyByName = new Map([["Hedger", "V2_HEDGER"]]);
  facts.envKeys = new Set(["V2_HEDGER"]);
  facts.verifyKnows = new Set(["Hedger"]);
  const ctx = makeContext(facts, { contracts: { hedger: "0x0000000000000000000000000000000000000000" } });
  const results = await runAll(facts, { only: ["v8-hedger-disabled"], forkAllowed: true, ctx, log: quiet });
  assert.equal(results["v8-hedger-disabled"].status, "blocked");
  assert.match(results["v8-hedger-disabled"].reason, /cannot be distinguished from 'not deployed'/);
});

test("the unwritten drills report what remains, not a pass", async () => {
  const facts = { ...emptyFacts() };
  facts.roles = { roles: {}, holders: {}, delaysS: {} };
  facts.scripts = new Set([
    "script/v2/DeployV8.s.sol", "script/v2/VerifyV8.s.sol", "script/v2/RegisterMarkets.s.sol", "script/v2/DeployLenderRewards.s.sol",
  ]);
  facts.constructs = new Set(["PayoutRouter", "FeeSplitter", "V4BuybackExecutor", "HouseVaultFactory"]);
  facts.verifyKnows = new Set(["HouseVault"]);

  const results = await runAll(facts, { only: ["v8-fill", "v8-settle-daily"], forkAllowed: true, ctx: makeContext(facts), log: quiet });
  for (const id of ["v8-fill", "v8-settle-daily"]) {
    assert.equal(results[id].status, "blocked");
    assert.match(results[id].reason, /drill not written/);
    assert.match(results[id].reason, /deliberately not written blind/);
  }
});
