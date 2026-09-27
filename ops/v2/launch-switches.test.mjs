/**
 * Every launch switch reads its launch value in the PROD render once the thing it gates ships, and no
 * switch reaches the launch services' code without a row in ops/v2/launch-switches.mjs.
 *
 *   node --test ops/v2/launch-switches.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LAUNCH_SWITCHES, SWITCH_SHAPE, codeDefault, effective, launchViolations, registryValue, renderedAssignment } from "./launch-switches.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PROD_REGISTRY = JSON.parse(readFileSync(path.join(REPO, "ops", "markets", "tier1.json"), "utf8"));
const PROD_ENV = path.join(REPO, "ops", "v2", "env");


test("every row is complete: a declaring file that names it, rendered services that exist, and a reason", () => {
  const names = new Set();
  for (const row of LAUNCH_SWITCHES) {
    assert.ok(!names.has(row.name), `${row.name}: one row per switch`);
    names.add(row.name);
    assert.ok(["on", "off", "n/a"].includes(row.launch), `${row.name}: launch is on, off or n/a`);
    assert.ok(row.why && row.why.length > 20, `${row.name}: a reason`);
    assert.ok(existsSync(path.join(REPO, row.declared)), `${row.name}: ${row.declared} exists`);
    assert.ok(readFileSync(path.join(REPO, row.declared), "utf8").includes(row.name), `${row.name} appears in ${row.declared}`);
    for (const service of row.services) assert.ok(existsSync(path.join(PROD_ENV, `${service}.env`)), `${row.name}: ops/v2/env/${service}.env exists`);
    if (row.launch !== "n/a") assert.ok(row.on !== undefined && row.services.length > 0, `${row.name}: a launch switch names its ON value and its services`);
  }
});

test("the PROD render: every switch whose prerequisite the registry records runs its launch value", () => {
  // Positive control first: the flywheel's row binds under tier1.json (the splitter is recorded) and reads 1.
  const flywheel = LAUNCH_SWITCHES.find((r) => r.name === "CRANKER_FLYWHEEL_ENABLED");
  assert.notEqual(registryValue(PROD_REGISTRY, flywheel.prerequisite), null, "tier1.json records v2.flywheel.feeSplitter");
  assert.equal(effective(flywheel, "cranker"), "1");
  const bound = LAUNCH_SWITCHES.filter((r) => r.launch !== "n/a" && (!r.prerequisite || registryValue(PROD_REGISTRY, r.prerequisite) !== null));
  assert.ok(bound.length >= 8, `${bound.length} rows bind under tier1.json`);
  assert.deepEqual(launchViolations(), []);
});

test("the check names a switch the PROD render leaves off while its prerequisite ships, and only then", () => {
  // The state a lifecycle rehearsal found: the splitter recorded, the renderer's assignment gone, the keeper default (0) running.
  const dir = mkdtempSync(path.join(tmpdir(), "launch-switches-662-"));
  try {
    for (const name of readdirSync(PROD_ENV)) copyFileSync(path.join(PROD_ENV, name), path.join(dir, name));
    const cranker = readFileSync(path.join(dir, "cranker.env"), "utf8");
    assert.match(cranker, /^CRANKER_FLYWHEEL_ENABLED=1$/m, "the PROD render assigns the flywheel");
    writeFileSync(path.join(dir, "cranker.env"), cranker.replace(/^CRANKER_FLYWHEEL_ENABLED=1$/m, "# CRANKER_FLYWHEEL_ENABLED=0"));
    const found = launchViolations(PROD_REGISTRY, dir);
    assert.equal(found.length, 1, found.join("\n"));
    assert.match(found[0], /^CRANKER_FLYWHEEL_ENABLED in cranker\.env runs 0 but must be on at launch \(the registry records v2\.flywheel\.feeSplitter\)/);
    // The same render is right before the flywheel ships: no splitter recorded, the row does not bind.
    const before = structuredClone(PROD_REGISTRY);
    before.v2.flywheel.feeSplitter = null;
    assert.deepEqual(launchViolations(before, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the PROD render with `assignments` ({service: "NAME=value"}) appended, for `use(dir)`; removed after. */
function withRender(assignments, use) {
  const dir = mkdtempSync(path.join(tmpdir(), "launch-switches-1004-"));
  try {
    for (const name of readdirSync(PROD_ENV)) copyFileSync(path.join(PROD_ENV, name), path.join(dir, name));
    for (const [service, line] of Object.entries(assignments)) {
      const file = path.join(dir, `${service}.env`);
      assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(`^${line.split("=")[0]}=`, "m"), `${service}.env already assigns ${line}`);
      writeFileSync(file, `${readFileSync(file, "utf8")}\n${line}\n`);
    }
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("The check names a switch that must be OFF at launch and is rendered ON", () => {
  // MM_QUOTE_OFF_HOURS binds always (no prerequisite); CRANKER_BUYBACK_DRY_RUN once the registry records the executor.
  const withExecutor = structuredClone(PROD_REGISTRY);
  withExecutor.v2.flywheel.buybackExecutor ??= "0x" + "be".repeat(20);
  const found = withRender({ "mm-bot": "MM_QUOTE_OFF_HOURS=1", cranker: "CRANKER_BUYBACK_DRY_RUN=1" }, (dir) => launchViolations(withExecutor, dir));
  assert.equal(found.length, 2, found.join("\n"));
  assert.ok(found.some((l) => l.startsWith("MM_QUOTE_OFF_HOURS in mm-bot.env runs 1 but must be off at launch: ")), found.join("\n"));
  assert.ok(
    found.some((l) => l.startsWith("CRANKER_BUYBACK_DRY_RUN in cranker.env runs 1 but must be off at launch (the registry records v2.flywheel.buybackExecutor): ")),
    found.join("\n"),
  );
  // The same render with each switch at its launch value is clean: only the value made them violations.
  assert.deepEqual(withRender({ "mm-bot": "MM_QUOTE_OFF_HOURS=0", cranker: "CRANKER_BUYBACK_DRY_RUN=0" }, (dir) => launchViolations(withExecutor, dir)), []);
});

test("The CLI exits 1 and prints each violation, and exits 0 on the PROD render", () => {
  const cli = path.join(HERE, "launch-switches.mjs");
  const run = (dir) => spawnSync(process.execPath, [cli, "--env", dir], { encoding: "utf8" });
  const bad = withRender({ "mm-bot": "MM_QUOTE_OFF_HOURS=1" }, run);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^OFF {2}MM_QUOTE_OFF_HOURS in mm-bot\.env runs 1 but must be off at launch: /m);
  assert.match(bad.stdout, /^launch-switches: 1 switch\(es\) off while their prerequisite ships$/m);
  const good = run(PROD_ENV);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /^launch-switches: 0 switch\(es\) off while their prerequisite ships$/m);
});

/** Files of the launch services whose switch-shaped names must each have a row. Tests and fixtures are not code. */
const SCANNED = [
  "keeper/src", "indexer/src", "indexer/lib", "indexer/ponder.config.ts", "relay/src", "notifier/src",
  "web/app", "web/components", "web/lib", "web/next.config.mjs",
  "ops/v2-env.mjs", "ops/v2/monitor.mjs", "ops/go-live-v2.sh", "ops/go-live-app.sh", "ops/keeper-railway.sh",
  "ops/stonkctl/src",
];
const NOT_CODE = /(\.test\.|\.spec\.|\/tests?\/|\/__tests__\/|\/fixtures\/|\.generated\.|\/node_modules\/)/;
const CODE = /\.(m?[jt]sx?|sh|py)$/;

function walk(rel, out = []) {
  const abs = path.join(REPO, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) {
    if (CODE.test(rel) && !NOT_CODE.test(`/${rel}`)) out.push(rel);
    return out;
  }
  for (const name of readdirSync(abs)) walk(path.posix.join(rel, name), out);
  return out;
}

/** Every switch-shaped name in the scanned code, and every keeper flag field, with the first file that has it. */
export function switchesInCode() {
  const found = new Map();
  for (const rel of SCANNED.flatMap((r) => walk(r))) {
    const text = readFileSync(path.join(REPO, rel), "utf8");
    for (const m of text.matchAll(SWITCH_SHAPE)) if (!found.has(m[0])) found.set(m[0], rel);
    for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*): (?:flagField|z\.enum\(\[\s*'0',\s*'1'\s*\]\))/gm)) if (!found.has(m[1])) found.set(m[1], rel);
  }
  return found;
}

test("every switch in the launch services' code has a row in ops/v2/launch-switches.mjs", () => {
  const found = switchesInCode();
  // Positive control: the scan reaches the flags this test is about.
  for (const name of ["CRANKER_FLYWHEEL_ENABLED", "CRANKER_FIRSTMINT_ENABLED", "MM_QUOTE_OFF_HOURS", "GUARDIAN_AUTO_VETO", "PRICING_POOL_REQUIRED"]) {
    assert.ok(found.has(name), `the scan finds ${name}`);
  }
  const rows = new Set(LAUNCH_SWITCHES.map((r) => r.name));
  const missing = [...found].filter(([name]) => !rows.has(name)).map(([name, rel]) => `${name} (${rel})`);
  assert.deepEqual(missing, [], "a switch with no row: add it to ops/v2/launch-switches.mjs with its launch value and reason");
});
