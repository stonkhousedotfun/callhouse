/**
 * node --test ops/v2/contract-mirrors.test.mjs
 *
 * The app copies contract numbers. This fails by name when a copied number becomes settable on chain
 * (a restricted setter appears in the shipped roles manifest or in the fixture regenerated from contracts), when a
 * copy's value drifts from the contract, when a declaration goes stale, and when a new copy appears in app code
 * without being declared. The controls below prove each of those branches can go red.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildFixture, checkMirrors, evalInt, findMirrors, loadFixture, nameCandidates, normalizeName, REPO, ROLES_COPY, runGuard, settersFor, solidityConstants } from "./contract-mirrors.mjs";
import { parseHeader, resolveGenerator } from "./post-broadcast-regen.mjs";
import { MIRRORS, NOT_MIRRORS } from "./contract-mirrors.list.mjs";

const fixture = loadFixture();
const rolesCopy = JSON.parse(readFileSync(ROLES_COPY, "utf8"));
const read = (f) => readFileSync(path.join(REPO, f), "utf8");
const found = findMirrors({ fixture });
const manifests = () => ({ "ops/abis/v2/roles.json": structuredClone(rolesCopy), "ops/v2/contract-mirrors.fixture.json": structuredClone(fixture) });
const run = (over = {}) => checkMirrors({ mirrors: MIRRORS, notMirrors: NOT_MIRRORS, manifests: manifests(), fixture, found, read, ...over });

test("the guard is green at this base: every copy is declared, unsettable, and equal to the contract", async () => {
  const problems = await runGuard();
  assert.deepEqual(problems, []);
});

test("control: a setter for a declared COMPILED member in the shipped roles manifest turns the guard red by name", () => {
  const e = MIRRORS.find((m) => m.kind === "compiled" && m.contract === "V2Constants" && m.member === "SETTLEMENT_WINDOW");
  assert.ok(e, "the SETTLEMENT_WINDOW mirror is declared");
  const m = manifests();
  // V2Constants is not a target: the setter would land on the contract that stores the value, here the oracle.
  m["ops/abis/v2/roles.json"].targets.SettlementOracle[`${settersFor(e).at(-1).name}(uint32)`] = "CONFIG_ADMIN";
  const problems = checkMirrors({ mirrors: MIRRORS, notMirrors: NOT_MIRRORS, manifests: m, fixture, found, read });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], new RegExp(`^${e.name} .*SETTABLE`));
});

test("control: a PENDING mirror goes red naming its row when its setter lands in the fixture", () => {
  // The last three PENDING mirrors are LIVE, so no real one is left to drive this control. It runs on the
  // buyback-cooldown declaration put back the way it was (PENDING, its setter named), in place of the live one.
  const live = MIRRORS.find((m) => m.kind === "live" && m.member === "BUYBACK_COOLDOWN");
  assert.ok(live, "the FeeSplitter buyback-cooldown mirror is declared (live since T-OP-809)");
  const e = { ...live, kind: "pending", row: "T-OP-636", setters: ["FeeSplitter.setBuybackCooldown"] };
  const mirrors = MIRRORS.map((m) => (m === live ? e : m));
  const f = structuredClone(fixture);
  f.setters.FeeSplitter = [...f.setters.FeeSplitter, "setBuybackCooldown(uint40)"];
  const problems = checkMirrors({ mirrors, notMirrors: NOT_MIRRORS, manifests: { ...manifests(), "ops/v2/contract-mirrors.fixture.json": f }, fixture, found, read });
  assert.ok(problems.length >= 1);
  assert.ok(problems.every((p) => p.startsWith(`${e.name} `)), problems.join("\n"));
  assert.match(problems[0], /KNOWN-PENDING-T-OP-636/);
});

test("control: a member that stops being a compiled constant in the fixture turns its mirror red", () => {
  const e = MIRRORS.find((m) => m.kind === "compiled" && m.contract === "V2Constants" && m.member === "FINALIZE_DELAY");
  const f = structuredClone(fixture);
  f.constants = f.constants.filter((c) => !(c.contract === e.contract && c.name === e.member));
  const problems = checkMirrors({ mirrors: MIRRORS, notMirrors: NOT_MIRRORS, manifests: manifests(), fixture: f, found, read });
  assert.ok(problems.some((p) => p.startsWith(`${e.name} `) && /not a compiled constant/.test(p)), problems.join("\n"));
});

test("control: a copied value that differs from the contract turns its mirror red", () => {
  const e = MIRRORS.find((m) => m.kind === "compiled" && m.member === "FINALIZE_DELAY");
  const f = structuredClone(fixture);
  f.constants.find((c) => c.contract === e.contract && c.name === e.member).value = "121";
  const problems = checkMirrors({ mirrors: MIRRORS, notMirrors: NOT_MIRRORS, manifests: manifests(), fixture: f, found, read });
  assert.ok(problems.some((p) => p.startsWith(`${e.name} `) && /app value 120/.test(p)), problems.join("\n"));
});

test("control: an undeclared copy in app code is found by name and by a Contract.MEMBER citation", () => {
  const fake = {
    "keeper/src/v2/fake-a.ts": "export const MAX_BOUNTY = 1_000_000n;\n",
    "ops/v2/fake-b.mjs": "/** SettlementOracle.MAX_SOURCES, mirrored */\nexport const ORACLE_CAP = 8;\n",
    "keeper/src/v2/fake-c.ts": "export const MAX_BOUNTY = config.maxBounty;\n",
  };
  const hits = findMirrors({ fixture, files: Object.keys(fake), read: (f) => fake[f] });
  assert.deepEqual(hits.map((h) => [h.file, h.symbol, h.how]), [
    ["keeper/src/v2/fake-a.ts", "MAX_BOUNTY", "name"],
    ["ops/v2/fake-b.mjs", "ORACLE_CAP", "cite"],
  ]);
  const problems = checkMirrors({ mirrors: MIRRORS, notMirrors: NOT_MIRRORS, manifests: manifests(), fixture, found: [...found, ...hits], read });
  assert.equal(problems.filter((p) => p.startsWith("UNDECLARED")).length, 2, problems.join("\n"));
});

test("A copy of a DEFAULT_ constant is found by name, with or without the prefix, and MIN_ASK is not MIN_ASK_BPS", () => {
  const fake = {
    "ops/stonkctl/src/stonkctl/fake_a.py": "DEFAULT_MAX_STALE_S = 93_600\n",
    "web/lib/v2/fake-b.ts": "export const UNCORROBORATED_DELAY_S = 21_600;\n",
    "ops/devnet/fake-c.mjs": "const MIN_ASK = 100_000n;\n",
    // Both FeeSplitter.SPOT_MAX_AGE (1800) and SettlementOracle.DEFAULT_SPOT_MAX_AGE (3600) exist: the suffix-only name
    // is tried first, so this copy is not taken for the splitter's.
    "keeper/src/v2/fake-d.ts": "export const DEFAULT_SPOT_MAX_AGE_S = 3_600;\n",
  };
  const hits = findMirrors({ fixture, files: Object.keys(fake), read: (f) => fake[f] });
  assert.deepEqual(hits.map((h) => [h.symbol, h.member, h.how]), [
    ["DEFAULT_MAX_STALE_S", "ChainlinkFeedSource.DEFAULT_MAX_STALE", "name"],
    ["UNCORROBORATED_DELAY_S", "SettlementOracle.DEFAULT_UNCORROBORATED_DELAY", "name"],
    ["DEFAULT_SPOT_MAX_AGE_S", "SettlementOracle.DEFAULT_SPOT_MAX_AGE", "name"],
  ]);
  // Most specific first: the suffix-only name is tried before the fully normalized one.
  assert.deepEqual(nameCandidates("V2_DEFAULT_MAX_STALE_S"), ["V2_DEFAULT_MAX_STALE_S", "DEFAULT_MAX_STALE"]);
  assert.deepEqual(nameCandidates("DEFAULT_MAX_STALE_S"), ["DEFAULT_MAX_STALE_S", "DEFAULT_MAX_STALE", "MAX_STALE"]);
});

test("Deleting a real DEFAULT_ copy's declaration turns the guard red naming it", () => {
  for (const [file, symbol] of [
    ["ops/stonkctl/src/stonkctl/waves.py", "DEFAULT_MAX_STALE_S"],
    ["web/lib/v2/payoutTiming.ts", "UNCORROBORATED_DELAY_S"],
  ]) {
    assert.ok(found.some((h) => h.file === file && h.symbol === symbol && h.how === "name"), `${file} ${symbol} is found by name in the real tree`);
    const without = MIRRORS.map((e) => ({ ...e, sites: e.sites.filter((x) => !(x.file === file && x.symbol === symbol)) }))
      .filter((e) => e.sites.length > 0);
    const problems = run({ mirrors: without });
    assert.ok(problems.some((p) => p.startsWith(`UNDECLARED ${symbol} (${file}:`)), `${symbol}: ${problems.join("\n")}`);
  }
});

test("control: a declaration whose symbol left its file is stale", () => {
  const e = MIRRORS.find((m) => m.kind === "compiled");
  const moved = { ...e, sites: [{ file: e.sites[0].file, symbol: "NO_SUCH_SYMBOL_T_OP_635" }] };
  const problems = checkMirrors({ mirrors: [moved], notMirrors: NOT_MIRRORS, manifests: manifests(), fixture, found: [], read });
  assert.ok(problems.some((p) => /stale/.test(p)), problems.join("\n"));
});

test("every declared compiled or pending mirror names a contract member the fixture knows (no escape flag)", () => {
  const known = new Set(fixture.constants.map((c) => `${c.contract}.${c.name}`));
  for (const e of MIRRORS) {
    assert.equal(e.fixtureMember, undefined, `${e.name}: fixtureMember is not accepted (T-OP-986)`);
    if (e.kind === "live") continue;
    assert.ok(known.has(`${e.contract}.${e.member}`), `${e.name}: ${e.contract}.${e.member} is not in the fixture`);
  }
});

// Each skip the guard used to take silently now fails by name. The declarations below are synthetic; the
// real list is green (first test), so each control proves one branch can go red.
const oneSite = (over = {}) => ({ name: "t-op-986-probe", contract: "V2Constants", member: "FINALIZE_DELAY", kind: "compiled", sites: [{ file: "probe.mjs", symbol: "FINALIZE_DELAY" }], ...over });
const probeRun = (mirror, text, f = fixture) =>
  checkMirrors({ mirrors: [mirror], notMirrors: [], manifests: { "ops/v2/contract-mirrors.fixture.json": structuredClone(f) }, fixture: f, found: [], read: () => text });

test("A declaration whose member is missing from the fixture is refused by name, flag or no flag", () => {
  const missing = { member: "NOT_IN_THE_FIXTURE_T_OP_986", sites: [{ file: "probe.mjs", symbol: "NOT_IN_THE_FIXTURE_T_OP_986" }] };
  const text = "export const NOT_IN_THE_FIXTURE_T_OP_986 = 1;\n";
  for (const flag of [{}, { fixtureMember: false }]) {
    const problems = probeRun(oneSite({ ...missing, ...flag }), text);
    assert.ok(problems.some((p) => p.startsWith("t-op-986-probe ") && /not a compiled constant at contracts/.test(p)), `${JSON.stringify(flag)}\n${problems.join("\n")}`);
  }
  const flagged = probeRun(oneSite({ fixtureMember: false }), "export const FINALIZE_DELAY = 120;\n");
  assert.ok(flagged.some((p) => p.startsWith("t-op-986-probe ") && /fixtureMember is not accepted/.test(p)), flagged.join("\n"));
});

test("A compiled value the guard cannot compare is a problem by name, not a skip", () => {
  const green = probeRun(oneSite(), "export const FINALIZE_DELAY = 120;\n");
  assert.deepEqual(green, [], "control: an equal literal is green");
  const notLiteral = probeRun(oneSite(), "export const FINALIZE_DELAY = config.finalizeDelay;\n");
  assert.ok(notLiteral.some((p) => /value cannot be compared: the declaration's value "config\.finalizeDelay" does not evaluate/.test(p)), notLiteral.join("\n"));
  const f = structuredClone(fixture);
  f.constants.find((c) => c.contract === "V2Constants" && c.name === "FINALIZE_DELAY").value = null;
  const unevaluable = probeRun(oneSite(), "export const FINALIZE_DELAY = 120;\n", f);
  assert.ok(unevaluable.some((p) => /value cannot be compared: V2Constants\.FINALIZE_DELAY = .* does not evaluate/.test(p)), unevaluable.join("\n"));
  const noReason = probeRun(oneSite({ sites: [{ file: "probe.mjs", symbol: "FINALIZE_DELAY", compareValue: false }] }), "export const FINALIZE_DELAY = 1;\n");
  assert.ok(noReason.some((p) => /compareValue false without a reason/.test(p)), noReason.join("\n"));
  const withReason = probeRun(oneSite({ sites: [{ file: "probe.mjs", symbol: "FINALIZE_DELAY", compareValue: false, reason: "a unit the scale cannot express" }] }), "export const FINALIZE_DELAY = 1;\n");
  assert.deepEqual(withReason, [], "compareValue false with a reason is an explicit, written opt-out");
});

test("The value is read from the declaration, not from a doc comment above it that names the symbol", () => {
  const text = "/**\n * FINALIZE_DELAY = 120 seconds after the expiry, per the contract\n */\nexport const FINALIZE_DELAY = 121;\n";
  const problems = probeRun(oneSite(), text);
  assert.ok(problems.some((p) => /app value 121 but V2Constants\.FINALIZE_DELAY/.test(p)), problems.join("\n"));
  const py = probeRun(oneSite({ sites: [{ file: "probe.py", symbol: "FINALIZE_DELAY" }] }), "# FINALIZE_DELAY = 120, see V2Constants\nFINALIZE_DELAY = 121\n");
  assert.ok(py.some((p) => /app value 121/.test(p)), py.join("\n"));
});

test("A class field is found by the non-comment assignment fallback", () => {
  const mirror = oneSite({ sites: [{ file: "probe.ts", symbol: "FINALIZE_DELAY" }] });
  const text = "class Probe {\n  /** FINALIZE_DELAY = 121 in the generated description. */\n  FINALIZE_DELAY = 120;\n}\n";
  assert.deepEqual(probeRun(mirror, text), []);
});

test("A declaration wins over an earlier write through another object", () => {
  const text = "o.FINALIZE_DELAY = 121;\nexport const FINALIZE_DELAY = 120;\n";
  assert.deepEqual(probeRun(oneSite(), text), []);
});

test("A column-zero assignment-looking line is a declaration only in Python", () => {
  const js = "const help = `\nFINALIZE_DELAY = 121\n`;\nexport const FINALIZE_DELAY = 120;\n";
  assert.deepEqual(probeRun(oneSite(), js), []);
  const jsWithoutDeclaration = probeRun(oneSite(), "const help = `\nFINALIZE_DELAY = 120\n`;\n");
  assert.ok(jsWithoutDeclaration.some((p) => /no declaration line assigns it/.test(p)), jsWithoutDeclaration.join("\n"));
  const pyMirror = oneSite({ sites: [{ file: "probe.py", symbol: "FINALIZE_DELAY" }] });
  assert.deepEqual(probeRun(pyMirror, "FINALIZE_DELAY = 120\n"), []);
});

test("the guard does not read its settable facts from the app files it checks", () => {
  const src = readFileSync(path.join(REPO, "ops/v2/contract-mirrors.list.mjs"), "utf8");
  // Setter NAMES may be declared (they say what to look for); setter SIGNATURES and manifest targets may not.
  assert.doesNotMatch(src, /\btargets\s*:|\bset[A-Z]\w*\(/);
});

test("evalInt and solidityConstants read the Solidity forms the fixture depends on", () => {
  assert.equal(evalInt("5 minutes"), 300n);
  assert.equal(evalInt("48 hours"), 172_800n);
  assert.equal(evalInt("2_500e6"), 2_500_000_000n);
  assert.equal(evalInt("45 * 86_400"), 3_888_000n);
  assert.equal(evalInt("10n ** 16n"), 10n ** 16n);
  assert.equal(evalInt("uint256(SETTLEMENT_WINDOW) + SNAPSHOT_GRACE + 1", { SETTLEMENT_WINDOW: 1800n, SNAPSHOT_GRACE: 600n }), 2401n);
  assert.equal(evalInt("keccak256(\"X\")"), null);
  const cs = solidityConstants("library V2Constants {\n  // uint40 internal constant NOPE = 1;\n  uint40 internal constant BUYBACK_COOLDOWN = 5 minutes;\n}\ncontract F {\n  uint256 public constant CAP = 1_000e6;\n  bytes32 private constant K = keccak256('k');\n}\n");
  assert.deepEqual(cs.map((c) => [c.contract, c.name, c.expr, c.line]), [
    ["V2Constants", "BUYBACK_COOLDOWN", "5 minutes", 3],
    ["F", "CAP", "1_000e6", 6],
  ]);
  assert.equal(normalizeName("ROLL_OPEN_GRACE_S"), "ROLL_OPEN_GRACE");
  assert.equal(normalizeName("V2_MAX_BOUNTY_USDG"), "MAX_BOUNTY");
});

test("The fixture's header names this generator's PATH, so post-broadcast-regen can attribute it", () => {
  // post-broadcast-regen.mjs reads the first token after "GENERATED by" as the generator and refuses a file whose
  // generator does not exist. An earlier generator wrote `node ops/v2/...` there, the token was `node`, and every
  // post-broadcast-regen run refused before doing anything. Built from a throwaway contracts tree, so the header a
  // --regen WRITES is what is checked, not only the committed fixture.
  const dir = mkdtempSync(path.join(tmpdir(), "contract-mirrors-header-"));
  try {
    mkdirSync(path.join(dir, "src", "v2"), { recursive: true });
    mkdirSync(path.join(dir, "script", "v2"), { recursive: true });
    writeFileSync(path.join(dir, "src", "v2", "X.sol"), "contract X {\n    uint256 public constant N = 7;\n}\n");
    writeFileSync(path.join(dir, "script", "v2", "roles.v8.json"), JSON.stringify({ targets: {} }));
    const written = JSON.stringify(buildFixture(dir, "0".repeat(40)), null, 2) + "\n";
    const exists = (p) => existsSync(path.join(REPO, p));
    for (const [label, text] of [["a fresh --regen", written], ["the committed fixture", read("ops/v2/contract-mirrors.fixture.json")]]) {
      const h = parseHeader(text.slice(0, 1200));
      assert.ok(h, `${label}: no GENERATED by header in the first 1200 bytes`);
      assert.equal(h.generator, "ops/v2/contract-mirrors.mjs", `${label}: the header's generator token`);
      assert.equal(resolveGenerator("ops/v2/contract-mirrors.fixture.json", h.generator, exists), "ops/v2/contract-mirrors.mjs");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
