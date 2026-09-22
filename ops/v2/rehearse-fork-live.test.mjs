/**
 * node --test ops/v2/rehearse-fork-live.test.mjs
 *
 * Argument parsing, address collection (EXPECTED_ADDRESS_COUNT of them, derived), cranker/indexer
 * env rendering (no real key paths),
 * report shape, and `rehearse.sh --fork-live --check` plus the existing `--help` fresh-deploy path.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_KEYS, EXPECTED_ADDRESS_COUNT, KEY_PATH_RE, SOURCE_KEYS, assertForkLiveRegistry, assertForkOnlyEnv,
  assertRegistryContractsCovered, crankerEnv, indexerEnv, nvdaRow,
  parseServices, reportShapeOk, thirteenAddresses,
} from "./rehearse/fork-live-lib.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.resolve(HERE, "../..");
const SH = path.join(HERE, "rehearse.sh");
// --fork-live forks the ALREADY-LIVE set, and the live set is v7. tier1.json used to be the v7 registry and
// is now the v8 one, which is why these tests read v7-legacy.json for the positive path and tier1.json only
// to prove the v8 refusal. Pointing the positive path at tier1.json is the exact drift this harness must not
// silently absorb.
const REGISTRY = path.join(HERE, "../markets/v7-legacy.json");
const V8_REGISTRY = path.join(HERE, "../markets/tier1.json");

describe("parseServices", () => {
  test("defaults to cranker,indexer", () => {
    assert.deepEqual(parseServices(""), ["cranker", "indexer"]);
    assert.deepEqual(parseServices(null), ["cranker", "indexer"]);
  });
  test("dedupes and rejects unknown names", () => {
    assert.deepEqual(parseServices("indexer,cranker,indexer"), ["indexer", "cranker"]);
    assert.throws(() => parseServices("cranker,web"), /unknown --services/);
    assert.throws(() => parseServices("   ,  ,"), /empty/);
  });
});

describe("registry", () => {
  const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
  test("the committed v7 registry has every live v2.contracts address", () => {
    const a = thirteenAddresses(reg);
    assert.equal(Object.keys(a).length, EXPECTED_ADDRESS_COUNT);
    assert.match(a.clearinghouse, /^0x[0-9a-fA-F]{40}$/);
    assert.match(a["sources.chainlink"], /^0x[0-9a-fA-F]{40}$/);
  });
  test("NVDA asset is present", () => {
    assert.match(nvdaRow(reg).asset, /^0x[0-9a-fA-F]{40}$/);
  });
  test("a v8 registry is refused, naming the harness that is correct", () => {
    // The whole point: --fork-live can only measure what is already deployed, which is v7.
    const v8 = JSON.parse(readFileSync(V8_REGISTRY, "utf8"));
    assert.equal(v8.v2.interfaceVersion, 8, "tier1.json should be the v8 registry");
    assert.throws(() => assertForkLiveRegistry(v8), /INTERFACE_VERSION 8/);
    assert.throws(() => assertForkLiveRegistry(v8), /rehearse\.sh/);
    assert.throws(() => thirteenAddresses(v8), /INTERFACE_VERSION 8/);
    // and the v7 registry is NOT refused
    assert.equal(assertForkLiveRegistry(reg), reg);
  });
  test("the expected address count is derived from the key lists, not written down", () => {
    // It was the literal 13 in two places, which is exactly CONTRACT_KEYS + SOURCE_KEYS -- so it agreed with
    // itself while accessManager was missing from the list it was supposed to be counting. Pinning it against
    // a literal here would agree with itself for the same reason, so it is pinned against the REGISTRY: the
    // thing the tables claim to describe, counted independently out of the committed v7 file.
    const declared = Object.keys(reg.v2.contracts).filter((k) => k !== "sources").length
      + Object.keys(reg.v2.contracts.sources).length;
    assert.equal(EXPECTED_ADDRESS_COUNT, declared,
      "the key lists must count exactly what ops/markets/v7-legacy.json declares");
    assert.equal(thirteenAddresses(reg).accessManager, undefined, "v7 has no AccessManager; it must not be required here");
  });
  test("null contract fails closed", () => {
    const bad = structuredClone(reg);
    bad.v2.contracts.makerVault = null;
    assert.throws(() => thirteenAddresses(bad), /makerVault/);
  });
});

describe("env rendering", () => {
  const env = crankerEnv({
    rpc: "http://127.0.0.1:8590",
    registryPath: REGISTRY,
    db: "/tmp/rehearse-fork-live.x/db/cranker.db",
    port: 42195,
    pk: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    indexerUrl: "http://127.0.0.1:42190",
  });
  test("cranker env has no callhouse-keys path and uses the supplied junk pk", () => {
    assert.equal(env.CRANKER_PK.startsWith("0x"), true);
    assert.equal(env.V2_MODE, "cranker");
    assert.equal(env.RH_RPC, "http://127.0.0.1:8590");
    assert.doesNotMatch(JSON.stringify(env), KEY_PATH_RE);
    assertForkOnlyEnv(env);
  });
  test("indexer env has no parent secrets and start block is explicit", () => {
    const ie = indexerEnv({
      rpc: "http://127.0.0.1:8590",
      addresses: thirteenAddresses(JSON.parse(readFileSync(REGISTRY, "utf8"))),
      startBlock: 65780341,
      pglite: "/tmp/rehearse-fork-live.x/pglite",
      port: 42190,
    });
    assert.equal(ie.V2_START_BLOCK, "65780341");
    assert.equal(ie.DATABASE_SCHEMA, "forklive");
    assert.doesNotMatch(JSON.stringify(ie), KEY_PATH_RE);
    assert.equal(ie.CRANKER_PK, undefined);
  });
  test("a key-path value is refused", () => {
    assert.throws(() => assertForkOnlyEnv({ FOO: "/Users/x/.callhouse-keys/v2/cranker" }), /real key path/);
  });
});

describe("report shape", () => {
  test("requires mode fork-live, EXPECTED_ADDRESS_COUNT addresses, nvda.identical, keys.callhouseKeysRead false", () => {
    const good = {
      mode: "fork-live",
      forkBlock: 66_000_000,
      addresses: Object.fromEntries(Array.from({ length: EXPECTED_ADDRESS_COUNT }, (_, i) => [`k${i}`, "0x" + "11".repeat(20)])),
      nvda: { identical: true },
      services: { anvil: { status: "ok" } },
      keys: { callhouseKeysRead: false },
    };
    assert.equal(reportShapeOk(good), true);
    assert.equal(reportShapeOk({ ...good, mode: "fresh-deploy" }), false);
    assert.equal(reportShapeOk({ ...good, keys: { callhouseKeysRead: true } }), false);
    assert.equal(reportShapeOk({ ...good, nvda: {} }), false);
  });
});

describe("rehearse.sh", () => {
  test("existing fresh-deploy --help still names steps 1-5 and 1-fork.mjs", () => {
    const out = execFileSync("bash", [SH, "--help"], { encoding: "utf8" });
    assert.match(out, /1-fork\.mjs/);
    assert.match(out, /2-services\.mjs/);
    assert.match(out, /--publish/);
    assert.match(out, /--fork-live/);
  });
  test("--fork-live --only is refused", () => {
    let code = 0;
    try {
      execFileSync("bash", [SH, "--fork-live", "--only", "1"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = e.status;
      assert.match(String(e.stderr), /cannot be combined with --only/);
    }
    assert.equal(code, 2);
  });
  test("--fork-live --check PASSES end to end on the live v7 registry", () => {
    // The GREEN half, and it is asserted FIRST on purpose. This path used to read tier1.json, which became
    // the v8 registry, so the drill could only ever refuse -- a check that can only fail proves nothing when
    // it fails. It now reads ops/markets/v7-legacy.json, the ALREADY-LIVE set that --fork-live actually forks.
    const out = execFileSync("bash", [SH, "--fork-live", "--check", "--services", "cranker,indexer"], {
      encoding: "utf8", cwd: ROOT,
    });
    assert.match(out, /FORK-LIVE CHECK PASSED/);
    assert.match(out, /v7-legacy\.json/, "the fork-live path must read the LIVE v7 registry, not tier1.json");
    assert.match(out, /"clearinghouse"/);
    assert.doesNotMatch(out, /callhouse-keys/);
  });

  test("--fork-live --check REFUSES a v8 registry end to end, naming the harness that is correct", () => {
    // The RED half. tier1.json is the v8 registry the NUMBERED steps deploy from; handed to --fork-live it
    // must refuse by interfaceVersion rather than die on a null address or, once v8 deploys, silently soak a
    // v8 set through a key list that has no accessManager in it.
    let stderr = "";
    let code = 0;
    try {
      execFileSync("bash", [SH, "--fork-live", "--check", "--registry", "ops/markets/tier1.json", "--services", "cranker"], {
        encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      code = e.status;
      stderr = String(e.stderr ?? "");
    }
    assert.notEqual(code, 0, "a v8 registry must not pass --fork-live --check");
    assert.match(stderr, /INTERFACE_VERSION 8/, `expected the v8 refusal, got:\n${stderr.slice(0, 600)}`);
    assert.match(stderr, /rehearse\.sh/, "the refusal must name the harness that IS correct");
  });
  test("unknown flag still exits 2 on the fresh-deploy path", () => {
    let code = 0;
    try {
      execFileSync("bash", [SH, "--not-a-flag"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, 2);
  });
});


/* ============================================================================================
 * THE TABLE IS BOUND TO THE REGISTRY IT CLAIMS TO DESCRIBE  (O8 registry-table coverage)
 *
 * Every fixture below is built IN MEMORY. Nothing under ops/markets/ is created, edited or copied,
 * and no deploy path is executed.
 * ========================================================================================== */

/** A registry shaped exactly as the tables describe it, plus whatever `extra` adds. */
const v7Registry = (extra = {}) => ({
  v2: {
    interfaceVersion: 7,
    deployBlock: 1,
    contracts: {
      ...Object.fromEntries(CONTRACT_KEYS.map((k) => [k, "0x" + "11".repeat(20)])),
      sources: Object.fromEntries(SOURCE_KEYS.map((k) => [k, "0x" + "22".repeat(20)])),
      ...extra,
    },
  },
});

describe("registry -> table coverage (fork-live-lib.mjs)", () => {
  test("the exact registry is accepted and still readable -- the GREEN control", () => {
    // Asserted first and on purpose: a guard proved only by its refusals may be refusing everything.
    const exact = v7Registry();
    assert.equal(assertRegistryContractsCovered(exact), exact);
    assert.equal(Object.keys(thirteenAddresses(v7Registry())).length, EXPECTED_ADDRESS_COUNT);
  });

  test("a contract the registry declares and the table omits is REFUSED, and named", () => {
    // THE CASE THAT USED TO BE SILENT. thirteenAddresses only ever asked whether every name in the
    // table was present in the registry; a contract the registry declared and the table omitted was
    // never read at all, and the rehearsal reported success having never looked at it.
    for (const name of ["accessManager", "hedger", "houseVault"]) {
      const reg = v7Registry({ [name]: "0x" + "33".repeat(20) });
      assert.throws(() => assertRegistryContractsCovered(reg), new RegExp(name),
        `the refusal must NAME ${name}, not merely fail`);
      assert.throws(() => assertRegistryContractsCovered(reg), /does not enumerate/);
      // and it is reached from the real entry point, before any address is read
      assert.throws(() => thirteenAddresses(reg), new RegExp(name));
    }
  });

  test("two unlisted contracts are both named, and the count is the number of them", () => {
    const reg = v7Registry({ accessManager: "0x" + "33".repeat(20), hedger: "0x" + "44".repeat(20) });
    assert.throws(() => assertRegistryContractsCovered(reg), /2 contract\(s\)/);
    assert.throws(() => assertRegistryContractsCovered(reg), /accessManager, hedger/);
  });

  test("an unlisted price source is the same failure one level down", () => {
    // `sources` is descended into rather than compared as a contract name: SOURCE_KEYS describes it.
    const reg = v7Registry();
    reg.v2.contracts.sources.pyth = "0x" + "55".repeat(20);
    assert.throws(() => assertRegistryContractsCovered(reg), /pyth/);
    assert.throws(() => assertRegistryContractsCovered(reg), /SOURCE_KEYS/);
    // ...and `sources` itself is never reported as an unenumerated contract
    assert.doesNotThrow(() => assertRegistryContractsCovered(v7Registry()));
  });

  test("the v8 refusal comes FIRST, so the operator is told the real reason", () => {
    // Both guards are kept and they answer different questions. A v8 registry must be refused as v8
    // rather than as an unenumerated contract, or the operator is sent to widen a table that
    // correctly describes v7.
    const v8 = v7Registry({ accessManager: "0x" + "33".repeat(20) });
    v8.v2.interfaceVersion = 8;
    assert.throws(() => thirteenAddresses(v8), /INTERFACE_VERSION 8/);
  });

  test("the v8 refusal does NOT cover a new contract in a v7 registry -- which is why both exist", () => {
    // Delete this test and the argument for keeping two guards disappears with it.
    const reg = v7Registry({ accessManager: "0x" + "33".repeat(20) });
    assert.equal(assertForkLiveRegistry(reg), reg, "assertForkLiveRegistry accepts it: it is v7");
    assert.throws(() => assertRegistryContractsCovered(reg), /accessManager/);
  });

  test("accessManager is NOT in CONTRACT_KEYS, and that exclusion is verified against the live v7 set", () => {
    // Adding it would make the only legitimate use of this harness throw: --fork-live forks the
    // ALREADY-LIVE set, that set is v7, and v7-legacy.json has no AccessManager.
    assert.equal(CONTRACT_KEYS.includes("accessManager"), false);
    const live = JSON.parse(readFileSync(REGISTRY, "utf8"));
    assert.equal(live.v2.interfaceVersion, 7);
    assert.equal(live.v2.contracts.accessManager, undefined,
      "ops/markets/v7-legacy.json must have no accessManager, or this exclusion is wrong");
    assert.deepEqual(Object.keys(live.v2.contracts).filter((k) => k !== "sources").sort(), [...CONTRACT_KEYS].sort());
    assert.deepEqual(Object.keys(live.v2.contracts.sources).sort(), [...SOURCE_KEYS].sort());
  });
});

/* ============================================================================================
 * THE PYTHON COPY  (ops/v2/dev_deploy.py)
 *
 * There is no python test file in this repo. The repo's precedent for asserting a fact about
 * dev_deploy.py from a .mjs test is ops/runbooks.test.mjs:271 and ops/runbooks-v8-launch.test.mjs:76,
 * both of which PARSE the file as text. Parsing proves a guard is WRITTEN; it cannot prove the guard
 * WORKS, and "a check that passes because it never reached its subject" is the exact defect this row
 * exists to close. So the parse is kept for drift, and the guard itself is INVOKED.
 *
 * dev_deploy.py is stdlib-only and import-safe: every module-level statement is an assignment, a def,
 * a class or an import, and the only executable block is `if __name__ == "__main__"`. Importing it
 * therefore runs NO step. main() is never called, no command is parsed, and no deploy path is touched.
 * ========================================================================================== */

const PY = ["/opt/homebrew/bin/python3", "python3"].find((c) => {
  try { execFileSync(c, ["-c", ""], { stdio: "ignore" }); return true; } catch { return false; }
});

/** Run `code` with dev_deploy.py imported as `dd`. Returns stdout. Never invokes dd.main(). */
function inDevDeploy(code, { source = path.join(ROOT, "ops/v2/dev_deploy.py") } = {}) {
  const prelude = [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("dd", ${JSON.stringify(source)})`,
    "dd = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(dd)",
    'def v7(**extra):',
    '    c = {k: "0x" + "11"*20 for k in dd.CONTRACT_KEYS}',
    '    c["sources"] = {k: "0x" + "22"*20 for k in dd.SOURCE_KEYS}',
    "    c.update(extra)",
    '    return {"v2": {"interfaceVersion": 7, "deployBlock": 1, "contracts": c}}',
    "def refusal(reg):",
    "    try:",
    "        dd.registry_contracts(reg)",
    '        return "ACCEPTED"',
    "    except dd.StepFailure as exc:",
    '        return "REFUSED: " + str(exc)',
  ].join("\n");
  return execFileSync(PY, ["-c", `${prelude}\n${code}`], { encoding: "utf8", cwd: ROOT });
}

describe("registry -> table coverage (dev_deploy.py, invoked)", () => {
  test("python is available to invoke the guard", () => {
    assert.ok(PY, "no python3 interpreter found; the python guard cannot be proved by invocation");
  });

  test("the exact v7 registry flattens -- the GREEN control", () => {
    const out = inDevDeploy([
      "flat = dd.registry_contracts(v7())",
      'print(len(flat), all(flat.values()), dd.EXPECTED_ADDRESS_COUNT)',
    ].join("\n"));
    const [n, allPresent, expected] = out.trim().split(/\s+/);
    assert.equal(n, expected, "a complete v7 registry must flatten to EXPECTED_ADDRESS_COUNT entries");
    assert.equal(allPresent, "True");
    assert.equal(Number(expected), EXPECTED_ADDRESS_COUNT,
      "the python and mjs tables must count the same set");
  });

  test("a registry whose interfaceVersion differs from the pin is REFUSED, naming both numbers", () => {
    const out = inDevDeploy([
      "reg = v7(); reg['v2']['interfaceVersion'] = 8",
      "print(refusal(reg))",
    ].join("\n"));
    assert.match(out, /^REFUSED:/);
    assert.match(out, /INTERFACE_VERSION 7/, "the error must name the pin");
    assert.match(out, /declares 8/, "the error must name the registry's version");
    assert.match(out, /Fix:/, "the error must tell the reader what to do instead");
  });

  test("a contract the registry declares and CONTRACT_KEYS omits is REFUSED, and named", () => {
    for (const name of ["accessManager", "hedger"]) {
      const out = inDevDeploy(`print(refusal(v7(${name}="0x" + "33"*20)))`);
      assert.match(out, /^REFUSED:/);
      assert.match(out, new RegExp(name), `the refusal must NAME ${name}`);
      assert.match(out, /does not enumerate/);
    }
  });

  test("an unenumerated price source is REFUSED, and named", () => {
    const out = inDevDeploy([
      "reg = v7(); reg['v2']['contracts']['sources']['pyth'] = '0x' + '55'*20",
      "print(refusal(reg))",
    ].join("\n"));
    assert.match(out, /^REFUSED:/);
    assert.match(out, /pyth/);
    assert.match(out, /SOURCE_KEYS/);
  });

  test("the COMMITTED ops/markets/dev.json is refused by this v7-pinned tool", () => {
    // Not hypothetical, and the reason this row exists: dev.json is interfaceVersion 8 and declares
    // accessManager, while dev_deploy.py is pinned to 7 and does not enumerate it. Before the guard
    // this combination produced a run that reported every address present having never read the
    // contract that decides whether any restricted call is allowed.
    const out = inDevDeploy([
      `reg = json.load(open(${JSON.stringify(path.join(ROOT, "ops/markets/dev.json"))}))`,
      "print(reg['v2']['interfaceVersion'], 'accessManager' in reg['v2']['contracts'])",
      "print(refusal(reg))",
    ].join("\n"));
    const [facts, ...rest] = out.trim().split("\n");
    assert.equal(facts, "8 True", "ops/markets/dev.json is expected to be v8 and to declare accessManager");
    assert.match(rest.join("\n"), /^REFUSED:/);
  });

  test("the committed v7-legacy registry is ACCEPTED -- the guard is not refusing everything", () => {
    const out = inDevDeploy([
      `reg = json.load(open(${JSON.stringify(path.join(ROOT, "ops/markets/v7-legacy.json"))}))`,
      "flat = dd.registry_contracts(reg)",
      "print('ACCEPTED', len(flat))",
    ].join("\n"));
    assert.match(out, /^ACCEPTED /);
    assert.equal(Number(out.trim().split(/\s+/)[1]), EXPECTED_ADDRESS_COUNT);
  });

  test("THE NAMED WRONG FIX: bumping INTERFACE_VERSION to 8 does NOT silence the coverage guard", () => {
    // Bumping the pin makes the version gate agree with itself while the flattening still describes
    // v7 -- a count that agrees with itself is not a check. The coverage guard must survive it, or
    // the whole fix is one sed away from being undone in a way that reads as green.
    const mutated = path.join(process.env.TMPDIR ?? "/tmp", "dev_deploy.wrongfix.py");
    const src = readFileSync(path.join(ROOT, "ops/v2/dev_deploy.py"), "utf8");
    const bumped = src.replace(/^INTERFACE_VERSION = 7$/m, "INTERFACE_VERSION = 8");
    assert.notEqual(bumped, src, "the mutation did not apply; this test would prove nothing");
    writeFileSync(mutated, bumped);
    const out = inDevDeploy([
      `reg = json.load(open(${JSON.stringify(path.join(ROOT, "ops/markets/dev.json"))}))`,
      "print(dd.INTERFACE_VERSION, reg['v2']['interfaceVersion'])",
      "print(refusal(reg))",
    ].join("\n"), { source: mutated });
    const lines = out.trim().split("\n");
    assert.equal(lines[0], "8 8", "the version gate must now agree with itself -- that is the trap");
    assert.match(lines.slice(1).join("\n"), /^REFUSED:/, "the coverage guard must STILL refuse");
    assert.match(out, /accessManager/, "and it must still name the contract nobody would have read");
  });

  test("the python copy of the key lists has not drifted from the mjs copy", () => {
    // Two hand-written lists of one concept in two languages is how they diverge. Parsed out of the
    // python rather than restated here, so this cannot agree with itself.
    const py = readFileSync(path.join(ROOT, "ops/v2/dev_deploy.py"), "utf8");
    const listOf = (name) => {
      const m = py.match(new RegExp(`^${name} = \\[([^\\]]*)\\]`, "m"));
      assert.ok(m, `${name} not found in ops/v2/dev_deploy.py`);
      return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    assert.deepEqual(listOf("CONTRACT_KEYS"), [...CONTRACT_KEYS], "ops/v2/dev_deploy.py CONTRACT_KEYS");
    assert.deepEqual(listOf("SOURCE_KEYS"), [...SOURCE_KEYS], "ops/v2/dev_deploy.py SOURCE_KEYS");
    assert.equal(listOf("CONTRACT_KEYS").includes("accessManager"), false,
      "accessManager must not be added to dev_deploy.py CONTRACT_KEYS: that list describes the v7 set");
  });

  test("no restated address-count literal survives in either file", () => {
    // Criterion 6. The count is 10 + 3 today; a literal that happens to equal it agrees with itself
    // forever. Two `13`s are deliberately kept: they quote forge's own sourcify message verbatim.
    const py = readFileSync(path.join(ROOT, "ops/v2/dev_deploy.py"), "utf8");
    const mjs = readFileSync(path.join(ROOT, "ops/v2/rehearse/fork-live-lib.mjs"), "utf8");
    const offenders = [];
    for (const [file, text] of [["ops/v2/dev_deploy.py", py], ["ops/v2/rehearse/fork-live-lib.mjs", mjs]]) {
      text.split("\n").forEach((line, i) => {
        if (!/\b13\b/.test(line)) return;
        if (/contracts were verified/.test(line)) return;          // forge's own message, quoted
        if (/§13|^# 13\./.test(line)) return;                      // a document section number
        if (/literal `13`|the literal 13|TWO `13`s/.test(line)) return;  // the comments explaining this
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `restated count literal(s) left behind:\n${offenders.join("\n")}`);
  });
});
