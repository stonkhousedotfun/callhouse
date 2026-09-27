/**
 * Every harness that runs ONE monitor pass and judges what it pages runs it with the
 * alert grace at 0.
 *
 * WHY. Since the alert grace, ops/v2/monitor.mjs pages a CONDITION only once it has stayed open --alert-grace-seconds
 * (MONITOR_ALERT_GRACE_S, default 30). A `--once` pass on a fresh or per-step state file holds every condition and sends
 * none, so a rehearsal, drill or devnet run that counts the pages of its pass would count none, or credit them to a later
 * pass. The grace change set MONITOR_ALERT_GRACE_S=0 in three such harnesses; a later sweep found two more (the service-boot and
 * weekend-drill rehearsals). This scan keeps the next one from being missed: any code under ops/ or scripts/ that passes
 * "--once" to ops/v2/monitor.mjs with alerts on must also set the grace to 0. A `--no-alerts` run sends nothing and is
 * exempt (ops/v8/prelaunch-gate.mjs reads its findings only). The check is per file.
 *
 *   node --test ops/v2/monitor-one-pass-runners.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODE = /\.(mjs|cjs|js|ts|sh|py)$/;
const NOT_CODE = /(\.test\.|\/tests?\/|\/node_modules\/|\/fixtures\/)/;
const ONCE = /["']--once["']/;
const NO_ALERTS = /["']--no-alerts["']/;
const GRACE_0 = /MONITOR_ALERT_GRACE_S["']?\s*:\s*["']0["']|["']--alert-grace-seconds["']\s*,\s*["']0["']/;

/** Files that pass "--once" without being a one-pass harness, and why. */
const NOT_RUNNERS = {
  "ops/v2/monitor.mjs": "the monitor itself: parseArgs reads --once",
  "ops/v2/fake-chain.mjs": "monitor.test.mjs's option builder; each test passes the grace it means (T-OP-1089)",
};

/** The one-pass runners known when this scan was written: a floor the scan must reach, so a scan that finds nothing cannot pass. */
const KNOWN = [
  "ops/rehearse-lifecycle/monitor-faults.mjs",
  "ops/rehearse-lifecycle/service-boot/boot.mjs",
  "ops/rehearse-lifecycle/weekend-drill/drill.mjs",
  "ops/v2/monitor-devnet.mjs",
  "ops/v2/rehearse/drill-kit.mjs",
];

function walk(rel, out = []) {
  const abs = path.join(REPO, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) {
    if (CODE.test(rel) && !NOT_CODE.test(`/${rel}`)) out.push(rel);
    return out;
  }
  for (const name of readdirSync(abs)) if (name !== "node_modules") walk(path.posix.join(rel, name), out);
  return out;
}

/**
 * Sorts `files` ({ file, text }) that run ops/v2/monitor.mjs --once: `alerting` (alerts on), `readOnly` (--no-alerts),
 * and `missing`, the alerting ones that never set the grace to 0.
 */
function oncePasses(files) {
  const alerting = [];
  const readOnly = [];
  const missing = [];
  for (const { file, text } of files) {
    if (file in NOT_RUNNERS || !/monitor\.mjs/.test(text) || !ONCE.test(text)) continue;
    if (NO_ALERTS.test(text)) {
      readOnly.push(file);
      continue;
    }
    alerting.push(file);
    if (!GRACE_0.test(text)) missing.push(file);
  }
  return { alerting, readOnly, missing };
}

test("every one-pass monitor harness with alerts on runs with the alert grace at 0", () => {
  const files = ["ops", "scripts"].flatMap((dir) => walk(dir)).map((file) => ({ file, text: readFileSync(path.join(REPO, file), "utf8") }));
  const { alerting, readOnly, missing } = oncePasses(files);
  for (const file of KNOWN) assert.ok(alerting.includes(file), `${file} is a one-pass harness the scan did not find: the scan is broken`);
  assert.ok(readOnly.includes("ops/v8/prelaunch-gate.mjs"), "the --no-alerts exemption did not see ops/v8/prelaunch-gate.mjs");
  for (const file of Object.keys(NOT_RUNNERS)) assert.ok(existsSync(path.join(REPO, file)), `NOT_RUNNERS names ${file}, which is gone`);
  assert.deepEqual(missing, [], "these run `monitor.mjs --once` with alerts on and no MONITOR_ALERT_GRACE_S: \"0\" (or --alert-grace-seconds 0): their one pass holds every condition for 30 s and pages none (T-OP-1089)");
});

test("the scan flags an alerting --once runner without grace 0, and passes grace 0 and --no-alerts", () => {
  const spawnLine = (extra, env = "") => `spawn("node", ["ops/v2/monitor.mjs", "--once", "--json"${extra}], { env: { PATH${env} } });`;
  const files = [
    { file: "a.mjs", text: spawnLine("") },
    { file: "b.mjs", text: spawnLine("", `, MONITOR_ALERT_GRACE_S: "0"`) },
    { file: "c.mjs", text: spawnLine(`, "--alert-grace-seconds", "0"`) },
    { file: "d.mjs", text: spawnLine(`, "--no-alerts"`) },
    { file: "e.mjs", text: spawnLine("", `, MONITOR_ALERT_GRACE_S: "30"`) },
    { file: "f.mjs", text: `spawn("other-tool", ["--once"]);` },
    { file: "g.mjs", text: `// runs ops/v2/monitor.mjs --once in each drill` },
  ];
  assert.deepEqual(oncePasses(files), { alerting: ["a.mjs", "b.mjs", "c.mjs", "e.mjs"], readOnly: ["d.mjs"], missing: ["a.mjs", "e.mjs"] });
});
