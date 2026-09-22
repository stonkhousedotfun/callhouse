/**
 * Prove the four named refusals actually fire, and that they clear when the
 * precondition is met. A refusal path that has never executed is the class this
 * task exists to eliminate.
 *
 *   node --test ops/v8/verify-gates.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseArgs, plan, refusalFor } from "./verify-gates.mjs";

const catalog = JSON.parse(readFileSync(new URL("./gates.json", import.meta.url), "utf8"));

function ctx(overrides = {}) {
  const repos = overrides.repos ?? new Map([
    ["contracts", "/tmp/contracts"],
    ["app", "/tmp/app"],
    ["site", "/tmp/site"],
    ["docs", "/tmp/docs"],
  ]);
  const state = overrides.state ?? new Map([...repos.keys()].map((name) => [
    name, { dir: repos.get(name), head: "abc", dirty: false },
  ]));
  return {
    repos, state,
    forkUrl: overrides.forkUrl ?? null,
    forkBlock: overrides.forkBlock ?? null,
    env: overrides.env ?? {},
    which: overrides.which ?? (() => true),
  };
}

function gate(id) {
  const found = catalog.gates.find((g) => g.id === id);
  assert.ok(found, id);
  return found;
}

test("parseArgs rejects a shell string and requires NAME=PATH", () => {
  assert.throws(() => parseArgs(["--repo", "contracts"]), /invalid --repo/);
  assert.throws(() => parseArgs(["--repo", "other=/x"]), /unknown repository/);
  const parsed = parseArgs(["--dry-run", "--repo", "app=/tmp/app"]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.repos.get("app"), path.resolve("/tmp/app"));
});

test("catalog is argv arrays, never a shell string, and has no expected counts", () => {
  // The catalog's own _readme says no count in it is an expectation; pinning the NUMBER of gates here
  // was the one place that stopped being true the moment a gate was legitimately added. What the test
  // actually wants is a non-empty catalog of uniquely-identified gates.
  assert.ok(catalog.gates.length > 0);
  const ids = catalog.gates.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, "gate ids must be unique");
  for (const g of catalog.gates) {
    assert.ok(Array.isArray(g.argv), g.id);
    assert.equal(g.argv.join(" ").includes("|"), false, g.id);
    assert.ok(g.count === null || g.count.parse !== undefined, g.id);
  }
});

test("fork without --fork-url is REFUSED (suites would pass on chainid != 4663)", () => {
  const reason = refusalFor(gate("contracts.fork"), ctx({ forkBlock: "1" }));
  assert.match(reason, /--fork-url is required/);
});

test("fork without --fork-block-number is REFUSED (unreproducible)", () => {
  const reason = refusalFor(gate("contracts.fork"), ctx({ forkUrl: "http://127.0.0.1:8545" }));
  assert.match(reason, /--fork-block-number is required/);
});

test("fork with both url and block is not refused", () => {
  const reason = refusalFor(gate("contracts.fork"), ctx({
    forkUrl: "http://127.0.0.1:8545", forkBlock: "123",
  }));
  assert.equal(reason, null);
});

test("check-twins without CALLHOUSE_WEB_DIR is REFUSED (script exits 0 by skipping)", () => {
  const reason = refusalFor(gate("site.check-twins"), ctx());
  assert.match(reason, /CALLHOUSE_WEB_DIR is unset/);
});

test("check-twins with CALLHOUSE_WEB_DIR pointing at the bound app/web is not refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "t150-web-"));
  const app = path.join(root, "app");
  const web = path.join(app, "web");
  mkdirSync(web, { recursive: true });
  const reason = refusalFor(gate("site.check-twins"), ctx({
    repos: new Map([["site", path.join(root, "site")], ["app", app], ["contracts", "/c"], ["docs", "/d"]]),
    env: { CALLHOUSE_WEB_DIR: web },
  }));
  assert.equal(reason, null);
});

// T-554. THE TWO `docs.copy-lint` TESTS THAT USED TO SIT HERE WERE RED AT BASE: the gate was deleted on
// 2026-09-21 by owner instruction (gates.json `removed_gates`, "remove all copy-lint, in all repos") and
// `gate("docs.copy-lint")` asserted on a catalog entry that no longer exists, so this whole file reported
// 11/13 and any real red would have hidden behind two dead ones. The finding those tests carried -- a
// parity block skipped with no sibling checkout still printed "docs copy OK" -- is preserved verbatim in
// gates.json's `preserved_finding`, which is where the owner put it. The `app-sibling` branch of
// `refusalFor` that the tests exercised is now reached by no gate in the catalog (dead, not wrong); it is
// left in place and named in the ledger rather than removed inside a row about a different suspicion.
test("the copy-lint gates the owner retired are absent from the catalog, and recorded as retired", () => {
  const retired = catalog.removed_gates?.ids ?? [];
  assert.ok(retired.includes("docs.copy-lint"), "the retirement is recorded, not a silent absence");
  for (const id of retired) {
    assert.equal(catalog.gates.some((g) => g.id === id), false, `${id} is retired but still in the catalog`);
  }
});

test("render-docs --check without a docs binding is REFUSED", () => {
  const reason = refusalFor(gate("app.render-docs"), ctx({
    repos: new Map([["app", "/tmp/app"], ["contracts", "/c"], ["site", "/s"]]),
  }));
  assert.match(reason, /needs the docs worktree/);
});

test("render-docs --check with a docs binding is not refused", () => {
  const reason = refusalFor(gate("app.render-docs"), ctx());
  assert.equal(reason, null);
});

// T-554, the T-237 suspicion 5 pinned. The suspicion said `app.rehearse.v8` refuses without `--fork-url`
// and `--fork-block-number` and that it was "verified directly against refusalFor" -- by hand. The three
// fork tests above pin `contracts.fork`; nothing pinned the rehearsal gate itself, so a catalog edit that
// dropped one of its two preconditions would have gone unnoticed by this file. Now it reds by name.
test("app.rehearse.v8 without --fork-url is REFUSED (the drills self-skip without a fork)", () => {
  const reason = refusalFor(gate("app.rehearse.v8"), ctx({ forkBlock: "1" }));
  assert.match(reason, /--fork-url is required/);
});

test("app.rehearse.v8 without --fork-block-number is REFUSED (unreproducible)", () => {
  const reason = refusalFor(gate("app.rehearse.v8"), ctx({ forkUrl: "http://127.0.0.1:8545" }));
  assert.match(reason, /--fork-block-number is required/);
});

test("app.rehearse.v8 with both url and block is not refused", () => {
  const reason = refusalFor(gate("app.rehearse.v8"), ctx({
    forkUrl: "http://127.0.0.1:8545", forkBlock: "123",
  }));
  assert.equal(reason, null);
});

// The second half of the suspicion: a precondition the catalog does not know is a REFUSAL, not a pass.
// Built on a copy of the real gate, so the catalog itself is not edited to prove it.
test("a precondition refusalFor does not know is REFUSED as unknown, never silently satisfied", () => {
  const real = gate("app.rehearse.v8");
  const withUnknown = { ...real, preconditions: [...real.preconditions, "fork-attestation"] };
  const reason = refusalFor(withUnknown, ctx({ forkUrl: "http://127.0.0.1:8545", forkBlock: "123" }));
  assert.match(reason, /unknown precondition "fork-attestation" in the catalog/);
});

test("a dirty worktree is REFUSED, never recorded as PASS", () => {
  const c = ctx();
  c.state.set("contracts", { dir: "/tmp/contracts", head: "abc", dirty: true });
  const reason = refusalFor(gate("contracts.build"), c);
  assert.match(reason, /dirty/);
});

test("plan() distinguishes REFUSED from READY and never uses skipped", () => {
  const rows = plan(catalog, ctx());
  // Derived, not pinned: the assertion's point is that plan() emits a row for EVERY gate, and a
  // hardcoded count fails whenever the catalog legitimately grows (it did, when O8-06's
  // app.rehearse.v8 row landed) without saying anything about coverage.
  assert.equal(rows.length, catalog.gates.length);
  assert.ok(rows.every((r) => r.status === "REFUSED" || r.status === "READY"));
  assert.ok(rows.some((r) => r.id === "contracts.fork" && r.status === "REFUSED"));
  assert.equal(rows.some((r) => /skip/i.test(r.status)), false);
});
