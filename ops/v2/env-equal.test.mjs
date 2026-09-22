/**
 * node --test ops/v2/env-equal.test.mjs
 *
 * O8-05. The historic production-monitor refuse was one comment line in pricer.env when
 * go-live-v2.sh diff'd the whole env directory. These fail if that comparison comes back.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assignmentLines, compareSelectedEnv } from "./env-equal.mjs";

test("assignmentLines ignores comments and blanks", () => {
  const text = [
    "# ops/v2/env/pricer.env — comment",
    "",
    "V2_MODE=pricer",
    "# PRICER_REPRICE_OFF_HOURS=0  1 = allow repricing outside the regular session",
    "PORT=8794",
  ].join("\n");
  assert.deepEqual(assignmentLines(text), ["V2_MODE=pricer", "PORT=8794"]);
});

test("comment-only drift in an unselected file does not refuse monitor", () => {
  const local = mkdtempSync(path.join(tmpdir(), "env-equal-local-"));
  const clone = mkdtempSync(path.join(tmpdir(), "env-equal-clone-"));
  try {
    writeFileSync(path.join(local, "pricer.env"), "V2_MODE=pricer\n# comment A\nPORT=8794\n");
    writeFileSync(path.join(clone, "pricer.env"), "V2_MODE=pricer\n# comment B\nPORT=8794\n");
    writeFileSync(path.join(local, "pricing.env"), "V2_MODE=pricing\nPORT=8790\n");
    writeFileSync(path.join(clone, "pricing.env"), "V2_MODE=pricing\nPORT=8790\n");
    assert.deepEqual(compareSelectedEnv({ localDir: local, cloneDir: clone, services: ["monitor", "relay"] }), []);
    assert.deepEqual(compareSelectedEnv({ localDir: local, cloneDir: clone, services: ["pricing"] }), []);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("assignment drift in a selected service still refuses", () => {
  const local = mkdtempSync(path.join(tmpdir(), "env-equal-local-"));
  const clone = mkdtempSync(path.join(tmpdir(), "env-equal-clone-"));
  try {
    writeFileSync(path.join(local, "pricing.env"), "V2_MODE=pricing\nPORT=8790\n");
    writeFileSync(path.join(clone, "pricing.env"), "V2_MODE=pricing\nPORT=8791\n");
    const problems = compareSelectedEnv({ localDir: local, cloneDir: clone, services: ["pricing", "monitor"] });
    assert.deepEqual(problems, ["pricing.env assignments differ from the reviewed SHA"]);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a generated env present on only one side of a selected service refuses", () => {
  const local = mkdtempSync(path.join(tmpdir(), "env-equal-local-"));
  const clone = mkdtempSync(path.join(tmpdir(), "env-equal-clone-"));
  try {
    writeFileSync(path.join(local, "notifier.env"), "PORT=8791\n");
    const problems = compareSelectedEnv({ localDir: local, cloneDir: clone, services: ["notifier"] });
    assert.deepEqual(problems, ["notifier.env exists on only one side of the reviewed SHA"]);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});
