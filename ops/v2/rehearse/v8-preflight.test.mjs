/**
 * The O8-06 preflight, tested by building a contracts tree, watching it report RUNNABLE, then TAKING
 * THE DEPLOY PATH AWAY and requiring it to flip to blocked naming the contract.
 *
 * The point is the direction. A preflight is a checker, and a checker that has only ever been shown a
 * healthy tree is the false-green shape this board keeps hitting: it would report every step runnable
 * against an empty directory just as confidently. So every case here is a pair — the fact present, the
 * fact removed — and the removal half is the one that matters.
 *
 * The fixtures are deliberately tiny and hand-written rather than copied from the real tree, so that a
 * change in the real contracts cannot make these tests pass or fail for reasons that have nothing to
 * do with the logic under test. The one test that reads the REAL tree is marked, and it asserts only
 * the two blockers that were verified by hand at contracts v8 d0602230.
 *
 *   node --test ops/v2/rehearse/v8-preflight.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { describeBlockers, inspectContracts, preflightStep } from "./v8-preflight.mjs";

/**
 * A minimal contracts tree. `deploys` is the list of contracts DeployV8 creates from their artifact —
 * the mechanism the real scripts use — and everything else is derived from it, so a fixture cannot
 * accidentally disagree with itself.
 */
function tree({ deploys = ["PayoutRouter", "FeeSplitter"], envKeys = ["V2_HEDGER"], verifyKnows = ["Hedger"], roles = true, scripts = ["DeployV8.s.sol", "VerifyV8.s.sol", "RegisterMarkets.s.sol", "DeployLenderRewards.s.sol"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "o806-preflight-"));
  const v2 = path.join(dir, "script", "v2");
  mkdirSync(path.join(v2, "lib"), { recursive: true });

  const artConst = (name) => `ART_${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

  const base = [
    ...deploys.map((n) => `    string public constant ${artConst(n)} = "out/${n}.sol/${n}.json";`),
    ...envKeys.map((k) => `        c.${k.toLowerCase()} = vm.envOr("${k}", address(0));`),
  ].join("\n");
  writeFileSync(path.join(v2, "lib", "V2DeployBase.sol"), `contract V2DeployBase {\n${base}\n}\n`);

  const deployV8 = [
    ...deploys.map((n) => `            d.x = _create(${artConst(n)}, abi.encode(mgr));`),
    // The name -> env key table DeployV8 carries for the contracts it does NOT deploy.
    ...envKeys.map((k) => {
      const name = k.replace(/^V2_/, "").toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
      return `        if (_eq(name, "${name[0].toUpperCase()}${name.slice(1)}")) return "${k}";`;
    }),
  ].join("\n");
  writeFileSync(path.join(v2, "DeployV8.s.sol"), `contract DeployV8 {\n${deployV8}\n}\n`);

  writeFileSync(
    path.join(v2, "VerifyV8.s.sol"),
    `contract VerifyV8 {\n${verifyKnows.map((n) => `        if (_eq(name, "${n}")) return c.x;`).join("\n")}\n}\n`,
  );

  for (const s of scripts) {
    const f = path.join(v2, s);
    if (!existsSync(f)) writeFileSync(f, "// placeholder\n");
  }
  if (roles) writeFileSync(path.join(v2, "roles.v8.json"), JSON.stringify({ roles: { ADMIN: 0, OPS_ADMIN: 6, GUARDIAN: 7 }, targets: {} }));

  return dir;
}

/** Every network-needing step is blocked without the fork gate, whatever else is true. */
test("no fork gate means no attempt, and it says why", () => {
  const facts = inspectContracts(tree());
  const r = preflightStep("v8-fill", facts, { forkAllowed: false });
  assert.equal(r.runnable, false);
  assert.match(describeBlockers(r), /off-machine archive RPC/);
  assert.match(describeBlockers(r), /owner-gated per task/);

  // Restore the one missing thing: with the gate, the same step is attemptable.
  assert.equal(preflightStep("v8-fill", facts, { forkAllowed: true }).runnable, true);
});

test("a contract deployed from its ARTIFACT counts as deployed", () => {
  // This is the case the first version of the scan got wrong: `_create(ART_X)` and no `new X(`.
  const facts = inspectContracts(tree({ deploys: ["PayoutRouter", "FeeSplitter", "V4BuybackExecutor"] }));
  assert.ok(facts.constructs.has("PayoutRouter"), "artifact creation must count as a deploy path");
  assert.equal(preflightStep("v8-redeem-usdg-v4", facts, { forkAllowed: true }).runnable, true);
  assert.equal(preflightStep("v8-distribute-buyback-burn", facts, { forkAllowed: true }).runnable, true);
});

test("BREAK: remove the deploy path and the step flips to blocked naming the contract", () => {
  const withIt = inspectContracts(tree({ deploys: ["PayoutRouter", "FeeSplitter", "V4BuybackExecutor"] }));
  assert.equal(preflightStep("v8-redeem-usdg-v4", withIt, { forkAllowed: true }).runnable, true);

  // Break the protected fact: PayoutRouter is no longer created anywhere.
  const without = inspectContracts(tree({ deploys: ["FeeSplitter", "V4BuybackExecutor"] }));
  const r = preflightStep("v8-redeem-usdg-v4", without, { forkAllowed: true });
  assert.equal(r.runnable, false);
  assert.match(describeBlockers(r), /PayoutRouter has no deployment path/);
  assert.match(describeBlockers(r), /_create\(ART_PAYOUT_ROUTER/);
});

test("BREAK: a contract that is only handed in BY ADDRESS is reported as a partial blocker, not a pass", () => {
  // The Earn vault's real shape at d0602230: an env key, no construction. A fresh fork has nothing to
  // point that key at, so reporting it runnable would be the false green.
  const facts = inspectContracts(tree({ deploys: ["PayoutRouter"], envKeys: ["V2_HEDGER", "V2_EARN_VAULT"], verifyKnows: ["Hedger", "EarnVault"] }));
  assert.ok(facts.envKeys.has("V2_EARN_VAULT"));
  assert.ok(!facts.constructs.has("EarnVault"));

  const r = preflightStep("v8-earn-fund-lend", facts, { forkAllowed: true });
  assert.equal(r.runnable, false);
  assert.match(describeBlockers(r), /arrives only BY ADDRESS/);
  assert.equal(r.blockers[0].severity, "partial", "by-address is a different, weaker blocker than absent entirely");

  // Restore: give it a construction and the blocker clears.
  const deployed = inspectContracts(tree({ deploys: ["PayoutRouter", "EarnVault"], envKeys: ["V2_HEDGER", "V2_EARN_VAULT"], verifyKnows: ["Hedger", "EarnVault"] }));
  assert.equal(preflightStep("v8-earn-fund-lend", deployed, { forkAllowed: true }).runnable, true);
});

test("BREAK: VerifyV8 not knowing a contract is its own blocker, stated as a blind spot", () => {
  const blind = inspectContracts(tree({ deploys: ["PayoutRouter", "Hedger"], envKeys: ["V2_HEDGER"], verifyKnows: [] }));
  const r = preflightStep("v8-hedger-disabled", blind, { forkAllowed: true });
  assert.equal(r.runnable, false);
  const why = describeBlockers(r);
  assert.match(why, /VerifyV8 does not know Hedger/);
  // The wording matters: the next reader has to understand this is a check that cannot see its subject.
  assert.match(why, /cannot see its subject/);

  const seeing = inspectContracts(tree({ deploys: ["PayoutRouter"], envKeys: ["V2_HEDGER"], verifyKnows: ["Hedger"] }));
  assert.equal(preflightStep("v8-hedger-disabled", seeing, { forkAllowed: true }).runnable, true);
});

test("BREAK: a missing script is named by path", () => {
  const facts = inspectContracts(tree({ scripts: ["DeployV8.s.sol", "VerifyV8.s.sol", "RegisterMarkets.s.sol"] }));
  const r = preflightStep("v8-lender-claim", facts, { forkAllowed: true });
  assert.equal(r.runnable, false);
  assert.match(describeBlockers(r), /script\/v2\/DeployLenderRewards\.s\.sol is missing/);
});

test("BREAK: an unreadable roles.v8.json blocks the role steps", () => {
  const facts = inspectContracts(tree({ roles: false }));
  for (const id of ["v8-role-handover", "v8-guardian-cancel", "v8-hotkey-rotation"]) {
    assert.match(describeBlockers(preflightStep(id, facts, { forkAllowed: true })), /roles\.v8\.json is unreadable/, id);
  }
});

test("an empty directory blocks everything — the preflight is not vacuously happy", () => {
  // The control for the whole file. If this ever reports something runnable, the derivation has
  // stopped reading anything and every other test here is meaningless.
  const empty = inspectContracts(mkdtempSync(path.join(tmpdir(), "o806-empty-")));
  for (const id of ["v8-deploy", "v8-verify", "v8-register", "v8-zap", "v8-earn-fund-lend"]) {
    assert.equal(preflightStep(id, empty, { forkAllowed: true }).runnable, false, `${id} must be blocked against an empty tree`);
  }
});

test("REAL TREE (skipped when absent): the two blockers verified by hand at contracts v8 d0602230", () => {
  const real = process.env.CONTRACTS_DIR ?? path.resolve(process.cwd(), "..", "callhouse-contracts");
  if (!existsSync(path.join(real, "script", "v2", "DeployV8.s.sol"))) return; // no v8 tree here; nothing to assert

  const facts = inspectContracts(real);
  // StockZap: no deploy path and no artifact constant at all.
  assert.equal(facts.constructs.has("StockZap"), false, "if StockZap gained a deploy path, update the ledger and this test");
  // EarnVault: env key present, construction absent.
  assert.equal(facts.envKeys.has("V2_EARN_VAULT"), true, "the V2_EARN_VAULT retraction still holds");
  assert.equal(facts.constructs.has("EarnVault"), false, "if the Earn vault gained a deploy path, T-225 is resolved");
  // PayoutRouter: deployed from its artifact. The regression guard for the matcher bug.
  assert.equal(facts.constructs.has("PayoutRouter"), true, "PayoutRouter is created from ART_PAYOUT_ROUTER; a scan that misses it is broken");
});
