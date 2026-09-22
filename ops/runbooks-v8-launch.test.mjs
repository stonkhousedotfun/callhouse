/**
 * ops/runbooks/v8-launch.md, checked mechanically (O8-02C).
 *
 * Same standard as ops/runbooks.test.mjs and deliberately a SEPARATE file: that one is a sibling
 * lane's and this task may not edit it. The rules are the ones that made the v2 runbooks wrong in
 * practice — a flag the parser exits 2 on, an alert kind nothing emits, a private key on a command
 * line — applied to the one runbook this task owns.
 *
 *   node --test ops/runbooks-v8-launch.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const OPS = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(OPS, p), "utf8");
const RUNBOOK = "runbooks/v8-launch.md";
const lines = (p) => read(p).split("\n").map((text, i) => ({ n: i + 1, text }));
const where = (hits) => hits.map((h) => `${RUNBOOK}:${h.n}: ${h.text.trim().slice(0, 160)}`).join("\n");

/** Every `--flag` the source's own parser accepts. */
function flagsOf(source, re) {
  const found = new Set();
  for (const [, flag] of source.matchAll(re)) found.add(flag);
  return found;
}

/**
 * Every `--flag` the runbook passes to `command`, against the set that command parses. Arguments run
 * to the end of the line or to the first thing that ends a command in Markdown: a closing backtick, a
 * table pipe, or a trailing `#` comment.
 */
function flagHits(command, known, why) {
  const hits = [];
  for (const l of lines(RUNBOOK)) {
    const at = l.text.indexOf(command);
    if (at < 0) continue;
    const args = l.text.slice(at + command.length).split(/[`|]|\s#/)[0];
    for (const [, flag] of args.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)) {
      if (!known.has(flag)) hits.push({ n: l.n, text: `${command} ${flag}: ${why}` });
    }
  }
  return hits;
}

test("every devnet-admin.mjs flag the runbook passes is one the driver parses", () => {
  // The admin driver is the ONE path an admin call takes under v8 (ops/v2/ADMIN-DRIVER.md), so a
  // wrong flag here is not a typo, it is an operator at 3 a.m. with no way to make the call.
  const driver = read("v2/devnet-admin.mjs");
  const known = flagsOf(driver, /arg === "(--[a-z-]+)"/g);
  assert.ok(known.has("--dry-run") && known.has("--manager"),
    "ops/v2/devnet-admin.mjs no longer parses its flags with `arg === \"--flag\"`");
  const hits = flagHits("devnet-admin.mjs", known, "the driver throws UsageError on it");
  assert.equal(hits.length, 0, where(hits));
});

test("every monitor.mjs flag the runbook passes is one the monitor parses", () => {
  const monitor = read("v2/monitor.mjs");
  const known = flagsOf(monitor, /case "(--[a-z-]+)":/g);
  assert.ok(known.has("--once") && known.has("--rpc"), "ops/v2/monitor.mjs no longer parses its flags in a case block");
  const hits = flagHits("monitor.mjs", known, "not a flag it parses");
  assert.equal(hits.length, 0, where(hits));
});

test("every go-live-v2.sh flag the runbook passes is one the script parses", () => {
  const script = read("go-live-v2.sh");
  const known = flagsOf(script, /^\s*(--[a-z-]+)[|)]/gm);
  for (const extra of ["--help", "--yes"]) known.add(extra);
  assert.ok(known.has("--apply") && known.has("--ref"), "ops/go-live-v2.sh no longer parses its flags in a case block");
  const hits = flagHits("go-live-v2.sh", known, "the script's parser exits 2 on it");
  assert.equal(hits.length, 0, where(hits));
});

test("every dev_deploy.py flag the runbook passes is one argparse declares", () => {
  const py = read("v2/dev_deploy.py");
  const known = flagsOf(py, /add_argument\("(--[a-z-]+)"/g);
  known.add("--help");
  assert.ok(known.has("--dry-run"), "ops/v2/dev_deploy.py no longer declares flags with add_argument(\"--flag\")");
  const hits = flagHits("dev_deploy.py", known, "argparse exits 2 on it");
  assert.equal(hits.length, 0, where(hits));
});

test("every build-markets.mjs and write-back-v8.mjs flag the runbook passes is real", () => {
  // Both are node scripts the runbook hands the operator; both exit 2 on an unknown flag.
  const bm = read("markets/build-markets.mjs");
  const bmKnown = new Set([...flagsOf(bm, /args\.has\("(--[a-z-]+)"\)/g), ...flagsOf(bm, /argValue\("(--[a-z-]+)"\)/g), "--registry", "--help"]);
  assert.ok(bmKnown.has("--check"), "ops/markets/build-markets.mjs no longer parses --check");
  const wb = read("markets/write-back-v8.mjs");
  const wbKnown = new Set([...flagsOf(wb, /argv\.includes\("(--[a-z-]+)"\)/g), ...flagsOf(wb, /arg\("(--[a-z-]+)"\)/g), "--help"]);
  assert.ok(wbKnown.has("--deployment"), "ops/markets/write-back-v8.mjs no longer parses --deployment");
  assert.deepEqual(
    [...flagHits("build-markets.mjs", bmKnown, "not a flag it parses"), ...flagHits("write-back-v8.mjs", wbKnown, "not a flag it parses")],
    [],
  );
});

test("every v2_mon_* kind the runbook names is one ops/v2/monitor.mjs emits", () => {
  // The triage table is only useful if the kinds are the ones that will actually arrive. A kind that
  // nothing emits is a row the operator waits for forever, and a renamed kind is worse.
  const emitted = new Set(read("v2/monitor.mjs").match(/v2_mon_[a-z_]+/g) ?? []);
  assert.ok(emitted.size > 20, "ops/v2/monitor.mjs no longer names its alert kinds v2_mon_*");
  const hits = [];
  for (const l of lines(RUNBOOK)) {
    for (const [kind] of l.text.matchAll(/v2_mon_[a-z_]+/g)) {
      if (!emitted.has(kind)) hits.push({ n: l.n, text: `${kind}: ops/v2/monitor.mjs emits no such kind` });
    }
  }
  assert.equal(hits.length, 0, where(hits));
  // And the table is not empty: the v8-specific kinds this runbook exists to triage are present.
  const text = read(RUNBOOK);
  for (const kind of ["v2_mon_safe_threshold", "v2_mon_manager_operation", "v2_mon_manager_role",
    "v2_mon_manager_wiring", "v2_mon_fee_scheduled", "v2_mon_splitter_idle", "v2_mon_buyback_stuck"]) {
    assert.ok(text.includes(kind), `the day-one triage table does not mention ${kind}`);
  }
});

test("no line hands the operator a private key", () => {
  // Signing under v8 is the Safe's, through the driver; the one thing a runbook must never teach is
  // pasting a key into a shell.
  const hits = [];
  for (const l of lines(RUNBOOK)) {
    if (/--private-key|PRIVATE_KEY=|0x[0-9a-fA-F]{64}\b/.test(l.text)) hits.push({ n: l.n, text: l.text });
  }
  assert.equal(hits.length, 0, where(hits));
});

test("the runbook follows v2-canary.md's section skeleton", () => {
  const want = ["## Shell setup", "## 1. Preconditions", "## 2. Deploy", "## 3. Wiring and parameters",
    "## 4. Services", "## 5. The first market day", "## 6. Abort and rollback", "## 7. Sign-off",
    "## 8. Dry-run record", "## Related"];
  const got = lines(RUNBOOK).map((l) => l.text).filter((t) => t.startsWith("## "));
  assert.deepEqual(got, want, "an operator who has run the v2 canary must be able to navigate this one");
});

test("the deploy section carries a real broadcast command whose flags the wrapper parses", () => {
  // INVERTED BY T-OP-001. This assertion used to require /Blocked on C8-10/ and forbid any
  // DeployV8/VerifyV8 command line. C8-10 has landed, so that guard had stopped describing a wait
  // and started PINNING THE HOLE OPEN: the suite was green because the runbook was unusable, and a
  // correct command tripped it exactly as fast as an invented one. It now requires the opposite,
  // and it checks the flags against the wrapper's OWN parser rather than against a list typed here.
  const text = read(RUNBOOK);
  assert.ok(!/Blocked on C8-10/.test(text), "C8-10 has landed; the deploy section must not still claim to be waiting on it");

  // Derived from the gitlink, not from a typed commit hash (T-OP-001 criterion 6): whatever commit
  // `contracts` is pinned at, this reads THAT wrapper. FAIL-CLOSED — an unpopulated submodule must
  // fail loudly here rather than skip, because "the parser could not be read" and "the flags are
  // fine" are the same colour otherwise, and that is the defect this row exists to remove.
  let wrapper;
  try {
    wrapper = readFileSync(path.join(OPS, "..", "contracts", "script", "v2", "broadcast-v8.sh"), "utf8");
  } catch (error) {
    assert.fail(`cannot read contracts/script/v2/broadcast-v8.sh (${error.code}). The contracts gitlink is not populated, so this assertion cannot check the runbook's flags against a parser. Populate it and re-run; do not skip this test.`);
  }
  const known = flagsOf(wrapper, /^\s*(--[a-z-]+)\)/gm);
  assert.ok(known.has("--registry") && known.has("--execute"),
    "contracts/script/v2/broadcast-v8.sh no longer parses its flags in a case block; this assertion is reading the wrong shape");

  const cmd = lines(RUNBOOK).filter((l) => l.text.includes("broadcast-v8.sh"));
  assert.ok(cmd.length > 0, "the deploy section must carry the broadcast command, not a description of it");
  const used = new Set();
  for (const l of cmd) for (const m of l.text.matchAll(/(--[a-z-]+)/g)) used.add(m[1]);
  const unknown = [...used].filter((f) => !known.has(f));
  assert.deepEqual(unknown, [], `the runbook passes broadcast-v8.sh flags its parser would reject: ${unknown.join(", ")}`);
  for (const need of ["--registry", "--rpc", "--execute", "--chain-id"]) {
    assert.ok(used.has(need), `the deploy section must show ${need} — an operator cannot run the real broadcast without it`);
  }

  // The record path is the step that has no parser to catch it: broadcast-v8.sh does not set
  // V2_DEPLOY_RECORD_OUT and DeployV8.s.sol defaults it to empty, so an operator who does not export
  // it gets NO deployment record and the write-back below has nothing to consume.
  assert.match(text, /V2_DEPLOY_RECORD_OUT/, "the deploy section must tell the operator to export the record path before the run");
  assert.match(text, /Not yet executed/i, "the dry-run record must not claim a run that did not happen");
});

test("the wave composition the runbook states is the one ops/markets/tier1.json actually holds", () => {
  // T-OP-001 criterion 11: close the CLASS, not the instance. Before this, nothing in this file
  // opened tier1.json — the one sentence in the runbook that is a checkable claim about a
  // machine-readable file was the only one nothing read, while the line beside it told the operator
  // to run build-markets.test.mjs and expect green, so a real mechanical check read as covering a
  // prose claim it does not touch.
  const registry = JSON.parse(read("markets/tier1.json"));
  const counts = {};
  for (const m of registry.markets) {
    const w = (m.v2 || {}).wave;
    counts[w] = (counts[w] || 0) + 1;
  }
  const text = read(RUNBOOK);
  const canary = registry.markets.filter((m) => (m.v2 || {}).wave === "canary").map((m) => m.ticker);
  assert.equal(canary.length, counts.canary || 0);
  // The runbook states the composition in words; assert each number against the registry it describes.
  const stated = text.match(/is the launch set: (\w+) `canary`, (\w+) markets `wave1`, (\w+)\s*\n?\s*`wave2`/);
  assert.ok(stated, "precondition 1 no longer states the wave composition in the shape this assertion reads");
  const words = { one: 1, nineteen: 19, fifteen: 15, twelve: 12, twenty: 20 };
  const asNumber = (w) => (words[w.toLowerCase()] !== undefined ? words[w.toLowerCase()] : Number(w));
  assert.deepEqual(canary, [stated[1]], `the runbook names ${stated[1]} as the canary; tier1.json has ${canary.join(", ") || "none"}`);
  assert.equal(counts.wave1, asNumber(stated[2]), `runbook says ${stated[2]} wave1, registry holds ${counts.wave1}`);
  assert.equal(counts.wave2, asNumber(stated[3]), `runbook says ${stated[3]} wave2, registry holds ${counts.wave2}`);
});
