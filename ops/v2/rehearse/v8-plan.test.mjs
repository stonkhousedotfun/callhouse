/**
 * The completeness rule of the O8-06 manifest, tested by BREAKING THE PROTECTED FACT rather than by
 * asking the checker whether it is happy.
 *
 * The fact under protection is: "every required step of the v8 fork rehearsal has an observed outcome,
 * and a step that could not run says what blocked it." So each test here removes or corrupts that fact
 * and requires the check to go red NAMING the step, then restores it and requires green. A test that
 * only ever feeds the checker well-formed input proves nothing — that is the exact false-green shape
 * this board has hit six times, and a manifest whose job is to catch silent skips is the last place to
 * repeat it.
 *
 *   node --test ops/v2/rehearse/v8-plan.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REQUIRED_IDS,
  REQUIRED_STEPS,
  STATUSES,
  assertComplete,
  invalidOutcomes,
  missingOutcomes,
  renderReport,
  stepById,
  summarize,
  validateManifest,
} from "./v8-plan.mjs";

/** A complete, well-formed result set: every required step passed. The control for every break below. */
const allPassed = () => Object.fromEntries(REQUIRED_IDS.map((id) => [id, { status: "passed", evidence: `observed ${id}` }]));

test("the manifest itself is well formed", () => {
  assert.deepEqual(validateManifest(), []);
  assert.equal(new Set(REQUIRED_IDS).size, REQUIRED_IDS.length, "ids are unique");
  assert.ok(REQUIRED_STEPS.length >= 19, `expected the full O8-06 step list, got ${REQUIRED_STEPS.length}`);
});

test("validateManifest catches a step with nothing observable", () => {
  // Break it: a step with no `observes` cannot be evidenced, so the report would carry a row that
  // asserts nothing. The manifest must refuse it.
  const broken = [...REQUIRED_STEPS.map((s) => ({ ...s })), { id: "made-up", title: "t", proves: "p", observes: [], source: "s" }];
  const problems = validateManifest(broken);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /made-up: nothing in 'observes'/);

  // Restore: the real manifest is clean.
  assert.deepEqual(validateManifest(), []);
});

test("a complete run is complete, and assertComplete does not throw on it", () => {
  const results = allPassed();
  const s = summarize(results);
  assert.equal(s.missing.length, 0);
  assert.equal(s.invalid.length, 0);
  assert.equal(s.proven, REQUIRED_IDS.length);
  assert.equal(s.complete, true);
  assert.doesNotThrow(() => assertComplete(results));
});

test("BREAK: delete one step's outcome and the check goes red naming that step", () => {
  for (const victim of REQUIRED_IDS) {
    const results = allPassed();
    delete results[victim];

    // Red, and it must name the step — "something is missing" would send the next reader looking.
    assert.deepEqual(missingOutcomes(results), [victim]);
    assert.equal(summarize(results).complete, false);
    let err = null;
    try { assertComplete(results); } catch (e) { err = e; }
    assert.ok(err, `assertComplete must throw when ${victim} has no outcome`);
    assert.equal(err.name, "RehearsalIncompleteError");
    assert.match(err.message, new RegExp(victim.replace(/[-]/g, "\\-")), `the failure must name ${victim}`);

    // Restore: green again. Without this half the test would pass against a checker that always throws.
    results[victim] = { status: "passed", evidence: "restored" };
    assert.deepEqual(missingOutcomes(results), []);
    assert.doesNotThrow(() => assertComplete(results));
  }
});

test("BREAK: a step present but null is missing, not present", () => {
  const results = allPassed();
  results[REQUIRED_IDS[0]] = null;
  assert.deepEqual(missingOutcomes(results), [REQUIRED_IDS[0]]);
  assert.throws(() => assertComplete(results), { name: "RehearsalIncompleteError" });
});

test("BREAK: `blocked` with no blocker is refused; with one it is accepted", () => {
  const id = "v8-earn-fund-lend";

  const bare = allPassed();
  bare[id] = { status: "blocked" };
  const bad = invalidOutcomes(bare);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].id, id);
  assert.match(bad[0].why, /silent skip/);
  assert.throws(() => assertComplete(bare), { name: "RehearsalIncompleteError" });

  // Restore: the SAME status with a reason is a legitimate, reportable outcome. `blocked` is not the
  // failure — an unexplained `blocked` is.
  const named = allPassed();
  named[id] = { status: "blocked", reason: "no deploy path: nothing constructs EarnVault (T-225)" };
  assert.deepEqual(invalidOutcomes(named), []);
  assert.doesNotThrow(() => assertComplete(named));
  assert.equal(summarize(named).proven, REQUIRED_IDS.length - 1, "a blocked step is NOT counted as proven");
});

test("BREAK: whitespace is not a reason", () => {
  const results = allPassed();
  results["v8-zap"] = { status: "blocked", reason: "   " };
  assert.equal(invalidOutcomes(results).length, 1);
});

test("BREAK: an unknown status is refused", () => {
  const results = allPassed();
  results["v8-verify"] = { status: "green" };
  const bad = invalidOutcomes(results);
  assert.equal(bad.length, 1);
  assert.match(bad[0].why, /not one of/);
  assert.ok(!STATUSES.includes("green"));
});

test("BREAK: extra drills do not substitute for a missing required one", () => {
  // The failure this guards: a runner grows five new drills, drops one required step, and reports
  // "23 of 23 drills passed". The count is true and the rehearsal is incomplete.
  const results = allPassed();
  delete results["v8-guardian-cancel"];
  results["some-extra-drill"] = { status: "passed", evidence: "green" };

  assert.deepEqual(missingOutcomes(results), ["v8-guardian-cancel"]);
  const bad = invalidOutcomes(results);
  assert.equal(bad.length, 1);
  assert.match(bad[0].why, /extras do not substitute/);
  assert.throws(() => assertComplete(results), { name: "RehearsalIncompleteError" });
});

test("the report names an unproven step's claim and its blocker, not just its status", () => {
  const results = allPassed();
  results["v8-deployer-renounce"] = { status: "blocked", reason: "fork gate not granted" };
  const md = renderReport(results, { forkBlock: 123456, fixtures: "tier1.rehearsal.json" });

  assert.match(md, /Fork block: 123456/);
  assert.match(md, /Missing evidence/);
  assert.match(md, /v8-deployer-renounce/);
  assert.match(md, /fork gate not granted/);
  // The point of the section: the reader learns what is NOT known, in the step's own words.
  assert.match(md, new RegExp(stepById("v8-deployer-renounce").proves.slice(0, 40)));
});

test("a report with no fork block says so rather than omitting it", () => {
  // O8-06's acceptance names the fork block explicitly. A report that just leaves it out reads as if
  // it were never required.
  const md = renderReport(allPassed(), {});
  assert.match(md, /Fork block: \*\*NOT RECORDED\*\*/);
  assert.match(md, /Fixtures: \*\*NOT RECORDED\*\*/);
});

test("a missing step is rendered as MISSING, never as a blank row that reads like a pass", () => {
  const results = allPassed();
  delete results["v8-v7-runoff"];
  const md = renderReport(results, { forkBlock: 1, fixtures: "f" });
  assert.match(md, /`v8-v7-runoff` \| \*\*MISSING\*\*/);
  assert.match(md, /missing evidence, not a pass/);
});
