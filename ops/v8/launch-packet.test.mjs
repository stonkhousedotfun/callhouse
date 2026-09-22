/**
 * ops/v8/launch-packet.test.mjs — tests for the owner launch packet generator (O8-07).
 *
 *   node --test ops/v8/launch-packet.test.mjs
 *
 * FIXTURES LIVE IN THIS FILE, not beside it. The task's scope is three paths and a fixtures file
 * would be a fourth; more usefully, a fixture built here is built by the same code that asserts on
 * it, so it cannot drift into agreeing with a bug.
 *
 * WHAT THESE TESTS ARE FOR. The generator's whole value is that it REFUSES. A refusal is worthless
 * unless the thing refusing can also succeed, so every red assertion below has a green partner: the
 * same function, on a complete input, producing the packet. A checker that only ever says no is
 * indistinguishable from one that cannot see its input at all.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { V2_DEPLOYED_REQUIRED_PATHS } from "../markets/build-markets.mjs";
import {
  DEFAULT_GATES,
  DEFAULT_REGISTRY,
  DEFAULT_ROLES,
  PACKET_EXTRA_REQUIRED_PATHS,
  PACKET_REQUIRED_PATHS,
  at,
  blankReason,
  checklistRows,
  collectBlockers,
  marketSummary,
  parseArgs,
  renderPacket,
  rollbackRows,
  run,
} from "./launch-packet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_REGISTRY = JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8"));
const REAL_ROLES = JSON.parse(readFileSync(DEFAULT_ROLES, "utf8"));
const REAL_GATES = JSON.parse(readFileSync(DEFAULT_GATES, "utf8"));

const setPath = (obj, dotted, value) => {
  const keys = dotted.split(".");
  let node = obj;
  for (const k of keys.slice(0, -1)) node = node[k];
  node[keys.at(-1)] = value;
};

/** The real registry with every required path filled — the green partner for every red test. */
function completeRegistry() {
  const reg = structuredClone(REAL_REGISTRY);
  let n = 1;
  const addr = () => "0x" + String(n++).padStart(40, "a");
  for (const p of V2_DEPLOYED_REQUIRED_PATHS) setPath(reg, p, addr());
  setPath(reg, "shared.opsWallet", addr());
  setPath(reg, "shared.guardian", addr());
  setPath(reg, "shared.feeRecipient", at(reg, "v2.flywheel.feeSplitter").value);
  setPath(reg, "v2.deployBlock", 68200000);
  return reg;
}

const completeArgs = (over = {}) => ({
  registry: completeRegistry(),
  roles: REAL_ROLES,
  gates: REAL_GATES,
  rehearsal: "FORK-LIVE CHECK PASSED\n13 addresses\n",
  rehearsalPath: "/tmp/rehearsal.txt",
  ...over,
});

test("the required list is non-empty and extends the registry's own rule rather than replacing it", () => {
  assert.ok(PACKET_REQUIRED_PATHS.length > 0);
  for (const p of V2_DEPLOYED_REQUIRED_PATHS) assert.ok(PACKET_REQUIRED_PATHS.includes(p), `${p} dropped`);
  for (const p of PACKET_EXTRA_REQUIRED_PATHS) assert.ok(PACKET_REQUIRED_PATHS.includes(p));
  // The extras must not silently duplicate the imported list; a duplicate would double-report.
  assert.equal(new Set(PACKET_REQUIRED_PATHS).size, PACKET_REQUIRED_PATHS.length);
});

test("at() separates a missing key from a null value", () => {
  const o = { a: { b: null } };
  assert.deepEqual(at(o, "a.b"), { found: true, value: null });
  assert.deepEqual(at(o, "a.c"), { found: false, value: undefined });
  assert.deepEqual(at(o, "x.y.z"), { found: false, value: undefined });
});

test("blankReason treats 0 and false as VALUES, not blanks", () => {
  // The bug this guards: `if (!value)` flags mintFeePpm 0 and allowRent false, and whoever loosens
  // it to silence those stops seeing real blanks.
  assert.equal(blankReason({ found: true, value: 0 }), null);
  assert.equal(blankReason({ found: true, value: false }), null);
  assert.equal(blankReason({ found: true, value: "0x0" }), null);

  assert.equal(blankReason({ found: false, value: undefined }), "missing");
  assert.equal(blankReason({ found: true, value: null }), "null");
  assert.equal(blankReason({ found: true, value: "" }), "empty string");
  assert.equal(blankReason({ found: true, value: "   " }), "empty string");
});

test("RED: the registry as committed today blocks the packet, naming the v8 addresses", () => {
  const blockers = collectBlockers(completeArgs({ registry: REAL_REGISTRY }));
  assert.ok(blockers.length > 0, "the v8 block is entirely null today; zero blockers would mean the check is blind");
  const paths = blockers.map((b) => b.path);
  assert.ok(paths.includes("registry:v2.contracts.clearinghouse"));
  assert.ok(paths.includes("registry:shared.safes.admin"));
  for (const b of blockers) assert.equal(b.reason, "null", `${b.path} should be null, not ${b.reason}`);
});

test("GREEN: a complete registry produces no blockers at all", () => {
  // Without this, every red test above would also pass against a checker that always refuses.
  assert.deepEqual(collectBlockers(completeArgs()), []);
});

test("BREAK THE SUBJECT: deleting the whole contracts block must still report every address", () => {
  // build-markets.mjs:1251 deliberately SKIPS a path whose value is undefined, delegating a missing
  // block to that block's own validator. Copying that here would mean a registry with no
  // `v2.contracts` at all produced zero blockers and a confident packet.
  const registry = completeRegistry();
  delete registry.v2.contracts;
  const blockers = collectBlockers(completeArgs({ registry }));
  const missing = blockers.filter((b) => b.reason === "missing").map((b) => b.path);
  const expected = V2_DEPLOYED_REQUIRED_PATHS.filter((p) => p.startsWith("v2.contracts.")).map((p) => `registry:${p}`);
  assert.deepEqual(missing.sort(), expected.sort());
  assert.ok(expected.length > 0, "the expectation itself must not be empty");
});

test("BREAK THE SUBJECT: every required path, removed one at a time, is caught", () => {
  for (const p of PACKET_REQUIRED_PATHS) {
    const registry = completeRegistry();
    setPath(registry, p, null);
    const blockers = collectBlockers(completeArgs({ registry }));
    assert.deepEqual(blockers, [{ path: `registry:${p}`, reason: "null" }], `nulling ${p} was not caught alone`);
  }
});

test("two manifests disagreeing about the interface version is a blocker", () => {
  const roles = structuredClone(REAL_ROLES);
  roles.interfaceVersion = REAL_ROLES.interfaceVersion + 1;
  const blockers = collectBlockers(completeArgs({ roles }));
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].path, "interfaceVersion");
  assert.match(blockers[0].reason, /not describing this launch/);
  // Green partner: they agree as committed.
  assert.equal(REAL_ROLES.interfaceVersion, at(REAL_REGISTRY, "v2.interfaceVersion").value);
});

test("an empty gate catalog is a blocker, not an empty checklist", () => {
  const blockers = collectBlockers(completeArgs({ gates: { ...REAL_GATES, gates: [] } }));
  assert.ok(blockers.some((b) => b.path === "gates:gates"));
  assert.ok(collectBlockers(completeArgs({ gates: { gates: undefined } })).some((b) => b.path === "gates:gates"));
});

test("an emptied role manifest section is a blocker, not an empty table", () => {
  const roles = structuredClone(REAL_ROLES);
  roles.roleGuardian = {};
  assert.ok(collectBlockers(completeArgs({ roles })).some((b) => b.path === "roles:roleGuardian"));
  const gone = structuredClone(REAL_ROLES);
  delete gone.targets;
  assert.ok(collectBlockers(completeArgs({ roles: gone })).some((b) => b.path === "roles:targets"));
});

test("an unbound or unreadable rehearsal record is named, never silently omitted", () => {
  const unbound = collectBlockers(completeArgs({ rehearsalPath: null, rehearsal: null }));
  assert.ok(unbound.some((b) => b.path === "rehearsal" && /no rehearsal record bound/.test(b.reason)));

  const unreadable = collectBlockers(completeArgs({ rehearsalPath: "/nope/missing.txt", rehearsal: null }));
  assert.ok(unreadable.some((b) => b.path === "rehearsal" && /could not be read/.test(b.reason)));
});

test("rollback: a zero-delay role says there is nothing to cancel", () => {
  const rows = rollbackRows(REAL_ROLES);
  const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));

  // The dangerous wrong answer is "cancellable by ADMIN" — an operator reads that as a brake.
  for (const r of rows.filter((x) => x.delayS === 0)) {
    assert.match(r.cancellableBy, /NOTHING TO CANCEL/, `${r.role} implies a brake it does not have`);
    assert.match(r.cancellableBy, /revoke this role via/);
  }
  assert.ok(rows.some((r) => r.delayS === 0), "fixture must contain a zero-delay role or this proves nothing");

  // ADMIN has a delay and no guardian: visible for its window, undoable only by ADMIN.
  assert.equal(byRole.ADMIN.guardian, null);
  assert.ok(byRole.ADMIN.delayS > 0);
  assert.match(byRole.ADMIN.cancellableBy, /ADMIN holder ONLY/);

  // A money lane with a guardian names it.
  assert.equal(byRole.FEE_MANAGER.guardian, REAL_ROLES.roleGuardian.FEE_MANAGER);
  assert.match(byRole.FEE_MANAGER.cancellableBy, new RegExp(REAL_ROLES.roleGuardian.FEE_MANAGER));
});

test("rollback rows mirror the manifest exactly — ids and delays are never retyped", () => {
  for (const r of rollbackRows(REAL_ROLES)) {
    assert.equal(r.id, REAL_ROLES.roles[r.role]);
    assert.equal(r.delayS, REAL_ROLES.delaysS[r.role]);
  }
  assert.equal(rollbackRows(REAL_ROLES).length, Object.keys(REAL_ROLES.roles).length);
});

test("checklist: every catalog gate becomes a row, and each says what FAILED looks like", () => {
  const rows = checklistRows(REAL_GATES);
  assert.equal(rows.length, REAL_GATES.gates.length);
  assert.deepEqual(rows.map((r) => r.id), REAL_GATES.gates.map((g) => g.id));
  for (const r of rows) assert.ok(r.failedLooksLike.length > 0, `${r.id} has no failure description`);
});

test("checklist: a gate with preconditions warns that an unmet precondition is REFUSED, not PASS", () => {
  const withPre = REAL_GATES.gates.filter((g) => (g.preconditions ?? []).length > 0);
  assert.ok(withPre.length > 0, "fixture must contain a precondition gate or this proves nothing");
  const rows = Object.fromEntries(checklistRows(REAL_GATES).map((r) => [r.id, r]));
  for (const g of withPre) {
    assert.match(rows[g.id].failedLooksLike, /REFUSED, never PASS/, `${g.id} lost its vacuous-pass warning`);
    for (const p of g.preconditions) assert.match(rows[g.id].failedLooksLike, new RegExp(p));
  }
});

test("marketSummary counts from the registry's own rows", () => {
  const s = marketSummary(REAL_REGISTRY);
  assert.equal(s.total, REAL_REGISTRY.markets.length);
  assert.equal(s.routed + s.unrouted, s.total);
  assert.equal([...s.byStatus.values()].reduce((a, b) => a + b, 0), s.total);
  assert.deepEqual(marketSummary({}), { total: 0, byWave: new Map(), byStatus: new Map(), routed: 0, unrouted: 0 });
});

test("the rendered packet carries every required value and every gate id", () => {
  const registry = completeRegistry();
  const packet = renderPacket({
    registry,
    roles: REAL_ROLES,
    gates: REAL_GATES,
    rehearsal: "FORK-LIVE CHECK PASSED",
    sources: [{ file: "ops/markets/tier1.json", sha256: "deadbeef" }],
  });
  for (const p of V2_DEPLOYED_REQUIRED_PATHS) {
    assert.ok(packet.includes(String(at(registry, p).value)), `${p} is missing from the packet body`);
  }
  for (const g of REAL_GATES.gates) assert.ok(packet.includes(g.id), `gate ${g.id} missing from the checklist`);
  for (const role of Object.keys(REAL_ROLES.roles)) assert.ok(packet.includes(role));
  assert.ok(packet.includes("FORK-LIVE CHECK PASSED"), "the rehearsal record is not in the packet");
  assert.match(packet, /## 5\. Rollback/);
});

test("no address, role id or delay is typed into the generator source", () => {
  // Criterion 5: every number in the packet is derived. A literal here is the drift this prevents.
  const src = readFileSync(path.join(HERE, "launch-packet.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(code.match(/0x[0-9a-fA-F]{40}/g), null, "an address literal is in the generator");
  for (const delay of new Set(Object.values(REAL_ROLES.delaysS))) {
    if (delay === 0) continue; // `delayS === 0` is a branch on the manifest's value, not a copy of it
    assert.ok(!code.includes(String(delay)), `delay ${delay} is typed into the generator`);
  }
});

test("run(): refuses today with a non-zero exit, and --blockers answers the same question with zero", () => {
  const packetOut = [];
  const packetErr = [];
  const refused = run([], { log: (s) => packetOut.push(s), err: (s) => packetErr.push(s), write: () => assert.fail("nothing may be written on a refusal") });
  assert.equal(refused, 1);
  assert.match(packetErr.join("\n"), /REFUSED/);

  const queryOut = [];
  const asked = run(["--blockers"], { log: (s) => queryOut.push(s), err: () => {}, write: () => assert.fail("no write") });
  assert.equal(asked, 0, "--blockers is a question, not a gate");
  assert.match(queryOut.join("\n"), /blocker\(s\)/);
});

test("run(): an unreadable registry is its OWN refusal, naming the file, not a blocker list", () => {
  // T-550. This test used to be named "a complete registry writes a packet and exits 0" while its
  // body passed an unreadable path and asserted exit 1 -- the name and the body disagreed, so the
  // green end-to-end path of run() looked covered and was not. The name now says what it does, and
  // the message is asserted, because /REFUSED/ alone cannot tell this refusal from the blocker one.
  const written = [];
  const errs = [];
  const code = run(["--registry", "/does/not/matter"], {
    log: () => {},
    err: (s) => errs.push(s),
    write: (f, c) => written.push([f, c]),
  });
  assert.equal(code, 1);
  assert.equal(written.length, 0);
  assert.match(errs.join("\n"), /could not be read or parsed: \/does\/not\/matter/);
});

test("GREEN run(): a complete registry on disk writes a packet and exits 0", () => {
  // THE MISSING GREEN PARTNER, and the one this file's own header promises: "every red assertion
  // below has a green partner ... A checker that only ever says no is indistinguishable from one
  // that cannot see its input at all." Every other run() assertion is a refusal, so without this
  // one nothing shows the generator can reach the end and produce a packet at all.
  const dir = mkdtempSync(path.join(os.tmpdir(), "launch-packet-"));
  const registryPath = path.join(dir, "registry.json");
  const rehearsalPath = path.join(dir, "rehearsal.txt");
  writeFileSync(registryPath, JSON.stringify(completeRegistry()));
  writeFileSync(rehearsalPath, "FORK-LIVE CHECK PASSED\n13 addresses\n");

  const written = [];
  const errs = [];
  const code = run(["--registry", registryPath, "--rehearsal", rehearsalPath, "--out", path.join(dir, "packet.md")], {
    log: () => {},
    err: (s) => errs.push(s),
    write: (f, c) => written.push([f, c]),
  });
  assert.equal(code, 0, `run() refused a complete input: ${errs.join(" | ")}`);
  assert.equal(written.length, 1, "exactly one packet is written");
  assert.ok(written[0][1].length > 0, "the packet is not empty");
});

test("parseArgs: every flag the runbook documents is understood", () => {
  const runbook = readFileSync(path.join(HERE, "..", "runbooks", "v8-launch-packet.md"), "utf8");
  // Only lines that invoke THIS generator. The runbook also cites write-back-v8.mjs and its
  // --deployment flag, which is another tool's argument parser and not this one's business.
  const ours = runbook.split("\n").filter((l) => l.includes("launch-packet.mjs"));
  assert.ok(ours.length > 0, "the runbook never shows the generator being invoked");
  const flags = [...new Set(ours.join("\n").match(/--[a-z][a-z-]*/g) ?? [])];
  assert.ok(flags.length > 0, "the runbook documents no flags at all");
  const known = new Set(["--registry", "--roles", "--gates", "--rehearsal", "--out", "--blockers", "--test"]);
  for (const f of flags) assert.ok(known.has(f), `the runbook documents ${f}, which the generator does not accept`);

  const a = parseArgs(["--registry", "R", "--roles", "O", "--gates", "G", "--rehearsal", "H", "--out", "U", "--blockers"]);
  assert.deepEqual(a, { registryPath: "R", rolesPath: "O", gatesPath: "G", rehearsalPath: "H", outPath: "U", blockersOnly: true });
  const d = parseArgs([]);
  assert.equal(d.registryPath, DEFAULT_REGISTRY);
  assert.equal(d.blockersOnly, false);
  assert.equal(d.rehearsalPath, null);
});
