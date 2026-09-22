// node --test ops/runbooks-v7-runoff.test.mjs
//
// Guards for ops/runbooks/v7-runoff.md. A NEW file: ops/runbooks.test.mjs and its RUNBOOKS array
// belong to another lane and are not touched here.
//
// These assert the facts an operator would act on, against their real sources -- the registry files in
// this repo -- rather than against a copy of them in prose. Anything that lives in callhouse-contracts is
// asserted to be written as a cross-repo REFERENCE, not as a runnable local path, because that checkout is
// not part of this repository and a test that depended on its location would be green or red for reasons
// unrelated to this runbook.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNBOOK = readFileSync(path.join(HERE, "runbooks/v7-runoff.md"), "utf8");
const legacy = JSON.parse(readFileSync(path.join(HERE, "markets/v7-legacy.json"), "utf8"));
const tier1 = JSON.parse(readFileSync(path.join(HERE, "markets/tier1.json"), "utf8"));

/** Fenced code blocks only -- prose that quotes a flag to forbid it is not a command. */
const commands = () => [...RUNBOOK.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");

test("no command hands the operator a key on the command line", () => {
  // cast --private-key takes the value as an argument, so ps -axww shows it while the send runs.
  // Same rule and same carve-out as ops/runbooks.test.mjs:132-136: a line that forbids the flag is fine.
  const offending = commands()
    .split("\n")
    .filter((l) => /--private-key/.test(l) && !/\bnever\b|instead of|would|--account/.test(l));
  assert.deepEqual(offending, [], `use --account <keystore name>:\n${offending.join("\n")}`);
});

test("every command block names a keystore account rather than a raw key", () => {
  const sends = commands().split("\n").filter((l) => /cast send/.test(l));
  assert.ok(sends.length > 0, "the runbook should show at least one send");
  for (const l of sends) assert.match(l, /--account/, `a send without --account:\n${l}`);
});

test("every registry key path the runbook reads exists in the file it names", () => {
  // Each `require("./ops/markets/<file>")` followed by a dotted path, as the runbook writes it.
  const reads = [...RUNBOOK.matchAll(/require\("\.\/ops\/markets\/([\w.-]+)"\)((?:\.[\w]+)+)/g)];
  assert.ok(reads.length > 0, "the runbook should read at least one registry key");
  const files = { "v7-legacy.json": legacy, "tier1.json": tier1 };
  for (const [, file, dotted] of reads) {
    const root = files[file];
    assert.ok(root, `the runbook reads an unknown registry file: ${file}`);
    let node = root;
    for (const key of dotted.slice(1).split(".")) {
      assert.ok(node !== null && typeof node === "object" && key in node, `${file}${dotted}: '${key}' does not exist`);
      node = node[key];
    }
    assert.ok(typeof node === "string" && node.length > 0, `${file}${dotted} is empty`);
  }
});

test("the runbook points at the V7 clearinghouse key, not the other one in the same file", () => {
  // The trap this guards: ops/markets/v7-legacy.json carries BOTH. `v2.contracts.clearinghouse` is the v7
  // contract FreezeV7 targets; `shared.clearinghouse` in that same "frozen v7 registry" is the V1
  // Clearinghouse, still read by the v1 run-off (ops/markets/README.md). An operator who reads the wrong
  // one sends an admin call to the wrong contract.
  //
  // IT IS NOT THE V8 CLEARINGHOUSE, and this guard used to say it was. There is no deployed v8
  // Clearinghouse at all: ops/markets/tier1.json `v2.contracts.clearinghouse` is null. The name below and
  // the message below carried that wrong fact into a shipped document. The ASSERTIONS are unchanged --
  // both are value equalities that hold either way, which is exactly why the wrong label survived here.
  const v7 = legacy.v2.contracts.clearinghouse;
  const v1 = legacy.shared.clearinghouse;
  assert.notEqual(v7.toLowerCase(), v1.toLowerCase(), "the two keys no longer differ -- re-read this guard, it may be obsolete");
  assert.equal(v1.toLowerCase(), tier1.shared.clearinghouse.toLowerCase(), "shared.clearinghouse should still match the live registry's shared block");
  assert.match(RUNBOOK, /v2\.contracts\.clearinghouse/, "the runbook must name the v7 key");
  assert.ok(RUNBOOK.includes(`require("./ops/markets/v7-legacy.json").v2.contracts.clearinghouse`),
    "the runbook must READ the v7 key, not just mention it");
  // and it must warn about the other one rather than leaving it to be found
  assert.match(RUNBOOK, /shared\.clearinghouse/, "the runbook must name the other key it is warning against");
});

test("the legacy registry is the v7 one", () => {
  // If these ever stop being 7 / the v7 deploy block, this runbook is reading the wrong file.
  assert.equal(legacy.v2.interfaceVersion, 7);
  assert.ok(Number(legacy.v2.deployBlock) > 0, "the legacy registry should carry a v7 deploy block");
});

test("contracts-side paths are cross-repo references, never runnable local paths", () => {
  // script/v2/** and docs/V7-RUNOFF.md live in callhouse-contracts, which is not this repository.
  // Every command block that runs one must say where it is run from.
  for (const block of [...RUNBOOK.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1])) {
    if (!/script\/v2\//.test(block)) continue;
    assert.match(block, /callhouse-contracts/,
      `a command runs a contracts script without saying which checkout:\n${block}`);
  }
});

test("the ordering constraint and the abort point are both stated", () => {
  // The rollback fact the launch packet depends on (v8-plan/tasks/O-ops.md O8-07): v7 is frozen only
  // AFTER v8 verifies, and stopping before the freeze is a clean state.
  assert.match(RUNBOOK, /only \*?after\*? v8 (is verified|verifies)/i);
  assert.match(RUNBOOK, /clean state/i);
  assert.match(RUNBOOK, /## Abort points/);
});

test("the freeze is documented as instant, with no timelock", () => {
  // v7 has no AccessManager; there is no scheduled-then-execute window, so the abort point is before
  // the send and nowhere after it. An operator who expects a delay would plan a change of mind.
  assert.match(RUNBOOK, /no timelock|has no timelock|instant/i);
});

test("every step tells the operator what FAILURE looks like, not only success", () => {
  // A run-off step that silently skips its check reads identical to one that passed it.
  const worked = (RUNBOOK.match(/\*\*Worked:\*\*/g) ?? []).length;
  const failed = (RUNBOOK.match(/\*\*Failed[,:]/g) ?? []).length;
  assert.ok(worked >= 3, `expected several success criteria, found ${worked}`);
  assert.ok(failed >= worked, `every success criterion needs a failure criterion: ${worked} worked, ${failed} failed`);
});
