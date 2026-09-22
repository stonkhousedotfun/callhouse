/**
 * node --test ops/v8/cutover-env.test.mjs
 *
 * No network, no chain, no Railway, no key. The reuse sources are the REAL committed v7, dev and v1
 * files: a refusal proven against a fixture proves the lookup, and the lookup was never the risk —
 * seeing the real v7 bots is. Every BROKEN case runs in a temp copy, so nothing here edits a tracked
 * file. Each guard is shown twice: red with its protected fact removed, green with it present.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { V2_DEPLOYED_REQUIRED_PATHS, validateDeployedCompleteness } from "../markets/build-markets.mjs";
import {
  DEFAULT_ROOT, NOT_DERIVED, READER_PATTERN, RESET_RULES, REUSE_SOURCES, UsageError, V7_REGISTRY,
  checkBotsAgainstProtocol, checkRegistry, checkRender, checkReuse, collectForbidden, deriveResetState,
  jsonIdentifiers, looksLikeKeyMaterial, main, normalizeKeyfile, parseArgs, parseDeriveBots, parseGoLiveBots,
  readBotsFile, renderEnv, textIdentifiers, v8Bots, defaultKeysDir,
} from "./cutover-env.mjs";

const ROOT = DEFAULT_ROOT;
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cutover-env-test-"));
const BOTS = ["cranker", "pricer", "quoter", "guardian"];

function run(argv, opts = {}) {
  const sink = () => ({ text: "", write(t) { this.text += t; return true; } });
  const stdout = sink();
  const stderr = sink();
  const code = main(argv, { stdout, stderr, env: {}, ...opts });
  return { code, out: stdout.text, err: stderr.text };
}

/** Addresses no stack has ever used: 0xbbbb…<n>. */
let next = 0x5000;
const fresh = () => `0x${(next++).toString(16).padStart(40, "b")}`;

/** The committed v8 registry with every required-when-deployed slot and every bot filled. */
function deployed(mutate = () => {}) {
  const r = json("ops/markets/tier1.json");
  for (const p of V2_DEPLOYED_REQUIRED_PATHS) {
    const keys = p.split(".");
    let o = r;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)] = fresh();
  }
  r.v2.deployBlock = 70_000_000;
  r.v2.flywheel.deployBlock = 69_999_990;
  for (const b of BOTS) r.v2.bots[b] = fresh();
  mutate(r);
  return r;
}

const put = (dir, name, doc) => {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  return file;
};

/** --bots references that point at the v8 key directory only. */
const v8KeyRefs = (over = {}) => ({ ...Object.fromEntries(BOTS.map((b) => [b, { keys: [`~/.callhouse-keys/v8/${b}.env`] }])), ...over });

/**
 * A minimal root holding just the reuse sources (and the renderer the v7 source needs), so a source
 * can be blinded without touching the real tree. `mutate(dir)` breaks it.
 */
function miniRoot(mutate = () => {}) {
  const dir = tmp();
  const copy = (rel) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); copyFileSync(path.join(ROOT, rel), path.join(dir, rel)); };
  copy("ops/v2-env.mjs");
  copy(V7_REGISTRY);
  copy("ops/markets/dev.json");
  for (const n of readdirSync(path.join(ROOT, "ops/v2/env-dev"))) copy(`ops/v2/env-dev/${n}`);
  copy("ops/keeper/markets/NVDA.env");
  mutate(dir);
  return dir;
}

/* ---------------------------------------------------------------------------------------------- */

describe("constants are read from their owners, not restated", () => {
  test("the bot indices and variables come from derive-bot-keys.sh, and v2-env.mjs renders the same ones", () => {
    const derive = parseDeriveBots(read("ops/v2/derive-bot-keys.sh"));
    assert.deepEqual(derive.map((b) => b.bot), BOTS);
    const env = read("ops/v2-env.mjs");
    const services = parseGoLiveBots(read("ops/go-live-v2.sh"));
    for (const b of derive) {
      if (!services.has(b.bot)) continue; // the guardian holds no Railway service
      // Two files that must agree on which index a v8 bot is: disagreeing is a v8 key nobody derived.
      assert.match(env, new RegExp(`botKey\\("${b.variable}", "${b.bot}", ${b.index},`), `v2-env.mjs renders ${b.bot} at another index than derive-bot-keys.sh`);
      assert.equal(services.get(b.bot).variable, b.variable, `go-live-v2.sh sets ${b.bot}'s key under another variable`);
    }
    assert.deepEqual([...services.keys()].sort(), ["cranker", "pricer", "quoter"]);
  });

  test("a BOTS table that lost a bot or a column refuses instead of checking fewer bots", () => {
    const good = read("ops/v2/derive-bot-keys.sh");
    assert.throws(() => parseDeriveBots(good.replace(/^guardian 63 GUARDIAN_PK"$/m, '"')), /no guardian row/);
    assert.throws(() => parseDeriveBots(good.replace(/^BOTS="cranker 60 CRANKER_PK$/m, 'BOTS="cranker CRANKER_PK')), /is not "<bot> <index> <VAR>_PK"/);
    assert.throws(() => parseDeriveBots("#!/bin/bash\n"), /no BOTS=/);
  });
});

describe("identifiers", () => {
  test("address, mnemonic index and key file are found; the line itself is never returned", () => {
    const line = "# CRANKER_PK=<secret: $HOME/.callhouse-keys/v2/cranker.env from ops/v2/derive-bot-keys.sh (ops mnemonic index 50; address 0xD03c35Ee40Ae67050c0E8fa1Cfc45D6c39bb22b0)>";
    const ids = textIdentifiers(line, "f.env");
    assert.deepEqual(ids.map((x) => [x.kind, x.value]).sort(), [
      ["address", "0xd03c35ee40ae67050c0e8fa1cfc45d6c39bb22b0"],
      ["keyfile", "~/.callhouse-keys/v2/cranker.env"],
      ["mnemonic-index", "50"],
    ]);
    for (const id of ids) {
      assert.deepEqual(Object.keys(id).sort(), ["kind", "value", "variable", "where"]);
      assert.equal(id.where, "f.env:1");
      assert.equal(id.variable, "CRANKER_PK");
    }
  });

  test("home spellings normalise to ~, and a templated or directory reference is not a key file", () => {
    assert.equal(normalizeKeyfile("${HOME}/.callhouse-keys//v8/pricer.env."), "~/.callhouse-keys/v8/pricer.env");
    assert.equal(normalizeKeyfile(`${os.homedir()}/.callhouse-keys/v8/quoter.env`), "~/.callhouse-keys/v8/quoter.env");
    assert.equal(normalizeKeyfile("~/.callhouse-keys/v2/"), null);
    assert.deepEqual(textIdentifiers("from ~/.callhouse-keys/v2/<bot>.env", "x").filter((i) => i.kind === "keyfile"), []);
  });

  test("a 64-hex key is not mistaken for an address, and a numeric keeperKeyIndex is an index", () => {
    const key = `0x${"ab".repeat(32)}`;
    assert.deepEqual(textIdentifiers(`KEY=${key}`, "x"), []);
    const ids = jsonIdentifiers({ markets: [{ deployment: { keeperKeyIndex: 14 } }] }, "r.json");
    assert.deepEqual(ids.map((i) => [i.kind, i.value, i.where]), [["mnemonic-index", "14", "r.json markets[0].deployment.keeperKeyIndex"]]);
  });

  test("key material is recognised; references are not", () => {
    assert.equal(looksLikeKeyMaterial(`"x": "0x${"1f".repeat(32)}"`), true);
    assert.equal(looksLikeKeyMaterial("1f".repeat(32)), true);
    assert.equal(looksLikeKeyMaterial("abandon ability able about above absent absorb abstract absurd abuse access accident"), true);
    assert.equal(looksLikeKeyMaterial("0xD03c35Ee40Ae67050c0E8fa1Cfc45D6c39bb22b0"), false);
    assert.equal(looksLikeKeyMaterial('{"cranker":{"keys":["~/.callhouse-keys/v8/cranker.env","ops mnemonic index 60"]}}'), false);
  });
});

describe("the reuse check sees v7, dev and v1 (the real committed files)", () => {
  const forbidden = collectForbidden(ROOT);
  const v7 = json(V7_REGISTRY);
  const dev = json("ops/markets/dev.json");
  const bot = (b, address, refs = [{ kind: "keyfile", value: `~/.callhouse-keys/v8/${b}.env` }]) => ({ bot: b, address, refs });

  test("every source is visible", () => {
    assert.deepEqual(forbidden.problems, []);
    assert.equal(forbidden.summary.length, REUSE_SOURCES.length);
  });

  test("ACCEPTANCE: the v7 cranker's address fed as the v8 cranker is refused, naming v7 and where", () => {
    const problems = checkReuse([bot("cranker", v7.v2.bots.cranker)], forbidden.index);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^KEY REUSE cranker: address 0x[0-9a-fA-F]{40} already appears in the v7 stack/);
    assert.match(problems[0], /ops\/markets\/v7-legacy\.json v2\.bots\.cranker/);
    // Positive control: the same call with a fresh address is clean, so the red above is the address.
    assert.deepEqual(checkReuse([bot("cranker", fresh())], forbidden.index), []);
  });

  test("every v7 bot and every dev bot is refused as a v8 bot", () => {
    for (const [stack, bots] of [["v7", v7.v2.bots], ["dev", dev.v2.bots]]) {
      for (const [name, address] of Object.entries(bots)) {
        const problems = checkReuse([bot("cranker", address)], forbidden.index);
        assert.ok(problems.some((p) => p.includes(`the ${stack}`) || p.includes(`${stack},`) || p.includes(`, ${stack}`)), `${stack} ${name} ${address} was not refused`);
      }
    }
  });

  test("the v7 bots' key files are refused as v8 key files, however they got named", () => {
    const problems = checkReuse([bot("cranker", fresh(), [{ kind: "keyfile", value: "~/.callhouse-keys/v2/cranker.env" }])], forbidden.index);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /keyfile ~\/\.callhouse-keys\/v2\/cranker\.env already appears in the v7/);
    assert.match(problems[0], /v7-env\/cranker\.env:\d+ \(CRANKER_PK\)/);
  });

  test("the v7 indices 50-52 and a v1 keeper index are refused as v8 indices", () => {
    for (const index of ["50", "51", "52", "1"]) {
      const problems = checkReuse([bot("pricer", fresh(), [{ kind: "mnemonic-index", value: index }])], forbidden.index);
      assert.equal(problems.length, 1, `ops mnemonic index ${index} was not refused`);
    }
    assert.deepEqual(checkReuse([bot("pricer", fresh(), [{ kind: "mnemonic-index", value: "999" }])], forbidden.index), []);
  });

  test("a --forbid env naming an index refuses that index, and names the file and variable", () => {
    const dir = tmp();
    const f = put(dir, "railway-export.env", "# CRANKER_PK=<secret: ops mnemonic index 60>\n");
    const extra = collectForbidden(ROOT, { extra: [f] });
    const problems = checkReuse([bot("cranker", fresh(), [{ kind: "mnemonic-index", value: "60" }])], extra.index);
    assert.ok(problems.some((p) => p.includes(`forbid: ${f}:1 (CRANKER_PK)`)), problems.join("\n"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a blind reuse source is a refusal, not a clean result", () => {
  const blind = (mutate) => {
    const dir = miniRoot(mutate);
    try { return collectForbidden(dir).problems; } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test("positive control: the mini root with every source intact is clean", () => {
    assert.deepEqual(blind(() => {}), []);
  });

  test("the v7 registry gone", () => {
    const p = blind((d) => rmSync(path.join(d, V7_REGISTRY)));
    assert.ok(p.some((x) => /ops\/markets\/v7-legacy\.json \(v7\) is missing/.test(x)), p.join("\n"));
    assert.ok(p.some((x) => /cannot render the v7 service env/.test(x)), p.join("\n"));
  });

  test("the v7 bots nulled", () => {
    const p = blind((d) => {
      const f = path.join(d, V7_REGISTRY);
      const r = JSON.parse(readFileSync(f, "utf8"));
      for (const k of Object.keys(r.v2.bots)) r.v2.bots[k] = null;
      writeFileSync(f, JSON.stringify(r));
    });
    assert.ok(p.some((x) => /names 0 bot address\(es\) under v2\.bots/.test(x)), p.join("\n"));
  });

  test("the v7 renderer gone", () => {
    const p = blind((d) => rmSync(path.join(d, "ops/v2-env.mjs")));
    assert.ok(p.some((x) => /cannot render the v7 service env: ops\/v2-env\.mjs could not run|exited/.test(x)), p.join("\n"));
  });

  test("the dev env directory emptied", () => {
    const p = blind((d) => { for (const n of readdirSync(path.join(d, "ops/v2/env-dev"))) rmSync(path.join(d, "ops/v2/env-dev", n)); });
    assert.ok(p.some((x) => /ops\/v2\/env-dev\/ \(dev\) has no \.env files/.test(x)), p.join("\n"));
  });

  test("the v1 keeper env stripped of its index", () => {
    const p = blind((d) => {
      const f = path.join(d, "ops/keeper/markets/NVDA.env");
      writeFileSync(f, readFileSync(f, "utf8").replace(/mnemonic index \d+/g, "mnemonic slot"));
    });
    assert.ok(p.some((x) => /ops\/keeper\/markets\/ yields 0 mnemonic-index/.test(x)), p.join("\n"));
  });

  test("a --forbid file with nothing in it", () => {
    const dir = tmp();
    const f = put(dir, "empty.env", "FOO=bar\n");
    const p = collectForbidden(ROOT, { extra: [f] }).problems;
    assert.ok(p.some((x) => x.includes("yields no address, mnemonic index or key file reference")), p.join("\n"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the registry", () => {
  const v7 = json(V7_REGISTRY);

  test("positive control: a deployed v8 registry passes", () => {
    assert.deepEqual(checkRegistry(deployed(), v7), []);
  });

  test("an undeployed registry refuses even though the completeness rule is silent about it", () => {
    const committed = json("ops/markets/tier1.json");
    assert.equal(committed.v2.deployBlock, null, "the committed registry is pre-deploy; if this changed, pick another fixture");
    const silent = [];
    validateDeployedCompleteness(committed, silent);
    assert.deepEqual(silent, [], "the imported rule says nothing while the block is null: that is why the null is refused here");
    assert.ok(checkRegistry(committed, v7).some((p) => /v2\.deployBlock is null/.test(p)));
  });

  test("a null required slot is named", () => {
    const p = checkRegistry(deployed((r) => { r.v2.contracts.orderBook = null; }), v7);
    assert.ok(p.some((x) => x.startsWith("v2.contracts.orderBook is null")), p.join("\n"));
  });

  test("v7's deploy block, or one below it, is not a v8 deployment", () => {
    assert.ok(checkRegistry(deployed((r) => { r.v2.deployBlock = v7.v2.deployBlock; }), v7).some((p) => /is v7's own deploy block/.test(p)));
    assert.ok(checkRegistry(deployed((r) => { r.v2.deployBlock = v7.v2.deployBlock - 1; }), v7).some((p) => /below v7's/.test(p)));
  });

  test("a v7 contract in the v8 registry is refused", () => {
    const p = checkRegistry(deployed((r) => { r.v2.contracts.clearinghouse = v7.v2.contracts.clearinghouse; }), v7);
    assert.ok(p.some((x) => /v2\.contracts\.clearinghouse .* is v7's v2\.contracts\.clearinghouse/.test(x)), p.join("\n"));
  });

  test("a dev registry, another interface version, or no v7 block to compare with", () => {
    assert.ok(checkRegistry(deployed((r) => { r._dev = "local"; }), v7).some((p) => /_dev/.test(p)));
    assert.ok(checkRegistry(deployed((r) => { r.v2.interfaceVersion = 7; }), v7).some((p) => /not 8/.test(p)));
    assert.ok(checkRegistry(deployed(), { v2: {} }).some((p) => /cannot tell the v8 block from v7's/.test(p)));
  });
});

describe("the v8 bots", () => {
  const derive = parseDeriveBots(read("ops/v2/derive-bot-keys.sh"));

  test("the default key directory is v8's, and CALLHOUSE_V2_KEYS_DIR still overrides it", () => {
    // T-477 moved the v8 bot keys to ~/.callhouse-keys/v8; T-481 moved the consumers' defaults with
    // them. ~/.callhouse-keys/v2 holds v7's indices 50-52 and both stacks run at once, so a default
    // pointing there hands a v8 run v7's key file. Pinned here because derive-bot-keys.sh,
    // go-live-v2.sh and this tool must agree, and nothing else checks that they do.
    assert.equal(defaultKeysDir({}), "~/.callhouse-keys/v8");
    assert.notEqual(defaultKeysDir({}), "~/.callhouse-keys/v2");
    assert.equal(defaultKeysDir({ CALLHOUSE_V2_KEYS_DIR: "~/.callhouse-keys/rehearsal" }), "~/.callhouse-keys/rehearsal");
    // The override is honoured even when it names v7's directory: this tool reports, the reuse check
    // refuses. What it must never do is fall back there on its own.
    assert.equal(defaultKeysDir({ CALLHOUSE_V2_KEYS_DIR: "~/.callhouse-keys/v2" }), "~/.callhouse-keys/v2");
    // Not under ~/.callhouse-keys/ at all is not a key directory this tool can compare.
    assert.equal(defaultKeysDir({ CALLHOUSE_V2_KEYS_DIR: "/tmp/keys" }), null);
  });

  test("the shell default agrees with derive-bot-keys.sh, read from the script, not restated", () => {
    // Mirrored, not re-reasoned: if the script moves its OUT_DIR again this goes red rather than
    // letting the two defaults drift apart silently.
    const out = read("ops/v2/derive-bot-keys.sh").match(/^OUT_DIR="\$\{CALLHOUSE_V2_KEYS_DIR:-\$HOME(\/[^"}]+)\}"/m);
    assert.ok(out, "OUT_DIR line not found in ops/v2/derive-bot-keys.sh");
    assert.equal(`~${out[1]}`, defaultKeysDir({}));
    const goLive = read("ops/go-live-v2.sh").match(/^KEYS_DIR="\$\{CALLHOUSE_V2_KEYS_DIR:-\$HOME(\/[^"}]+)\}"/m);
    assert.ok(goLive, "KEYS_DIR line not found in ops/go-live-v2.sh");
    assert.equal(`~${goLive[1]}`, defaultKeysDir({}));
  });

  test("default references are the derive index and <keys-dir>/<bot>.env", () => {
    const { bots, problems } = v8Bots({ derive, registry: deployed(), keysDir: "~/.callhouse-keys/v8" });
    assert.deepEqual(problems, []);
    const cranker = bots.find((b) => b.bot === "cranker");
    assert.deepEqual(cranker.refs, [{ kind: "mnemonic-index", value: "60" }, { kind: "keyfile", value: "~/.callhouse-keys/v8/cranker.env" }]);
  });

  test("a null bot, two bots on one address, an unparseable reference", () => {
    const shared = fresh();
    const { problems } = v8Bots({
      derive,
      registry: deployed((r) => { r.v2.bots.pricer = null; r.v2.bots.quoter = shared; r.v2.bots.guardian = shared; }),
      keysDir: "~/.callhouse-keys/v8",
      overrides: { cranker: { keys: ["railway:${{shared.CRANKER_PK}}"] } },
    });
    assert.ok(problems.some((p) => p.startsWith("v2.bots.pricer is null")), problems.join("\n"));
    assert.ok(problems.some((p) => /v8 bots quoter and guardian share address/.test(p)), problems.join("\n"));
    assert.ok(problems.some((p) => /--bots cranker\.keys\[0\] is not a reference/.test(p)), problems.join("\n"));
  });

  test("a bot that is also a v8 contract or Safe", () => {
    const r = deployed();
    const bots = [{ bot: "guardian", address: r.shared.safes.admin, refs: [] }];
    assert.deepEqual(checkBotsAgainstProtocol(bots, r), [`v8 guardian ${r.shared.safes.admin} is also shared.safes.admin`]);
  });

  test("a --bots file holding a key is refused unread, and the key is not echoed", () => {
    const dir = tmp();
    const key = `0x${"7e".repeat(32)}`;
    const f = put(dir, "bots.json", { cranker: { keys: [key] } });
    const { problems, overrides } = readBotsFile(f);
    assert.equal(overrides, undefined);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /shaped like key material/);
    assert.ok(!problems[0].includes(key.slice(2)));
    const r = run(["--bots", f]);
    assert.equal(r.code, 1);
    assert.ok(!(r.out + r.err).includes(key.slice(2)), "the key reached the output");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the render", () => {
  test("a render from another registry, or without the v8 block, is not the v8 env", () => {
    const dir = tmp();
    const reg = deployed();
    const file = put(dir, "v8.json", reg);
    const r = renderEnv(ROOT, file);
    assert.equal(r.error, undefined);
    const label = path.relative(ROOT, file);
    assert.deepEqual(checkRender(r.files, reg, label), []);
    const noBlock = { ...r.files, "indexer-v2.env": r.files["indexer-v2.env"].replace(/^V2_START_BLOCK=.*$/m, "V2_START_BLOCK=") };
    assert.ok(checkRender(noBlock, reg, label).some((p) => /does not carry V2_START_BLOCK=70000000/.test(p)));
    const { "cranker.env": _gone, ...missing } = r.files;
    assert.ok(checkRender(missing, reg, label).some((p) => /rendered no cranker\.env/.test(p)));
    assert.ok(checkRender(r.files, reg, "ops/markets/tier1.json").some((p) => /was not rendered from ops\/markets\/tier1\.json/.test(p)));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("main: dry run by default, --execute only with a chain id and an empty --out outside the repo", () => {
  const setup = (mutate) => {
    const dir = tmp();
    return {
      dir,
      registry: put(dir, "v8.json", deployed(mutate)),
      bots: put(dir, "bots.json", v8KeyRefs()),
      done: () => rmSync(dir, { recursive: true, force: true }),
    };
  };

  test("the committed tree refuses today (no v8 deployment yet) and writes nothing", () => {
    const r = run([]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^cutover-env: DRY RUN/);
    assert.match(r.err, /v2\.deployBlock is null/);
  });

  test("green: deployed registry, fresh bots, v8 key directory", () => {
    const s = setup();
    const r = run(["--registry", s.registry, "--bots", s.bots, "--keys-dir", "~/.callhouse-keys/v8"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /DRY RUN clean: every check passed\. Nothing written\./);
    s.done();
  });

  test("red: the same with the v7 cranker as the v8 cranker", () => {
    const s = setup((r) => { r.v2.bots.cranker = json(V7_REGISTRY).v2.bots.cranker; });
    const r = run(["--registry", s.registry, "--bots", s.bots, "--keys-dir", "~/.callhouse-keys/v8"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /KEY REUSE cranker: address .*ops\/markets\/v7-legacy\.json v2\.bots\.cranker/);
    s.done();
  });

  test("--execute refuses without --chain-id, with the wrong one, inside the repo, or into a non-empty dir", () => {
    const s = setup();
    const base = ["--registry", s.registry, "--bots", s.bots, "--keys-dir", "~/.callhouse-keys/v8", "--execute"];
    const out = path.join(s.dir, "packet");
    let r = run([...base, "--out", out]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--execute needs --chain-id/);
    assert.equal(existsSync(out), false);
    r = run([...base, "--chain-id", "1", "--out", out]);
    assert.match(r.err, /--chain-id 1 is not the registry's chain 4663/);
    assert.equal(existsSync(out), false);
    const inside = path.join(ROOT, "ops/v8/packet-must-not-exist");
    r = run([...base, "--chain-id", "4663", "--out", inside]);
    assert.match(r.err, /is inside the repository/);
    assert.equal(existsSync(inside), false);
    mkdirSync(out);
    writeFileSync(path.join(out, "keep.txt"), "mine");
    r = run([...base, "--chain-id", "4663", "--out", out]);
    assert.match(r.err, /is not empty: this never overwrites/);
    assert.deepEqual(readdirSync(out), ["keep.txt"]);
    s.done();
  });

  test("--execute writes the packet, reads it back, and the packet holds no key", () => {
    const s = setup();
    const out = path.join(s.dir, "packet");
    const r = run(["--registry", s.registry, "--bots", s.bots, "--keys-dir", "~/.callhouse-keys/v8", "--execute", "--chain-id", "4663", "--out", out]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /written and read back: 9 file\(s\)/);
    const envs = readdirSync(path.join(out, "env")).sort();
    assert.deepEqual(envs, ["cranker.env", "indexer-v2.env", "mm-bot.env", "notifier.env", "pricer.env", "pricing.env"]);
    assert.ok(readFileSync(path.join(out, "env/indexer-v2.env"), "utf8").split("\n").includes("V2_START_BLOCK=70000000"));
    const manifest = readFileSync(path.join(out, "MANIFEST.txt"), "utf8");
    for (const [, sha, name] of manifest.matchAll(/^sha256 ([0-9a-f]{64}) {2}(.+)$/gm)) {
      assert.equal(createHash("sha256").update(readFileSync(path.join(out, name), "utf8")).digest("hex"), sha, `${name} is not what MANIFEST.txt says`);
    }
    for (const name of ["bot-keys.txt", "reset-state.txt", ...envs.map((e) => `env/${e}`)]) {
      assert.equal(/[0-9a-fA-F]{64}/.test(readFileSync(path.join(out, name), "utf8")), false, `${name} holds 64 hex digits`);
    }
    const sheet = readFileSync(path.join(out, "bot-keys.txt"), "utf8");
    assert.match(sheet, /^cranker +cranker +CRANKER_PK +0x[0-9a-f]{40} +~\/\.callhouse-keys\/v8\/cranker\.env$/m);
    assert.match(sheet, /^quoter +mm-bot +MM_QUOTER_PK /m);
    s.done();
  });

  test("usage errors exit 2", () => {
    assert.throws(() => parseArgs(["--nope"]), UsageError);
    assert.throws(() => parseArgs(["--chain-id", "abc"]), UsageError);
    assert.throws(() => parseArgs(["--execute", "--reset-state"]), UsageError);
    assert.throws(() => parseArgs(["--out"]), UsageError);
    assert.equal(run(["--nope"]).code, 2);
  });
});

describe("reset state is derived from the code", () => {
  test("the real tree: every reader classified, every rule still matching", () => {
    const d = deriveResetState(ROOT);
    assert.deepEqual(d.problems, []);
    assert.ok(d.readers.length >= 40, `only ${d.readers.length} readers: the scan is blind`);
    const resets = new Set(d.classified.filter((c) => c.rule.effect === "resets").map((c) => c.file));
    for (const f of ["keeper/src/v2/anchor.ts", "notifier/src/rules/indexer.ts", "ops/v2/monitor.mjs", "indexer/lib/env.ts"]) assert.ok(resets.has(f), `${f} is not listed as resetting`);
    assert.ok(NOT_DERIVED.length > 0);
    assert.equal(new Set(RESET_RULES.map((r) => r.path)).size, RESET_RULES.length, "a rule path appears twice");
  });

  test("an unclassified reader refuses and names its line; removing it is green again", () => {
    const dir = tmp();
    const rules = [{ path: "a.ts", effect: "none", state: "x" }];
    put(dir, "a.ts", "const b = registry.v2.deployBlock;\n");
    assert.deepEqual(deriveResetState(dir, rules).problems, []);
    put(dir, "keeper/new.ts", "// nothing\nconst from = V2_START_BLOCK;\n");
    const p = deriveResetState(dir, rules).problems;
    assert.equal(p.length, 1);
    assert.match(p[0], /^UNCLASSIFIED deploy-block reader keeper\/new\.ts:2:/);
    rmSync(path.join(dir, "keeper/new.ts"));
    assert.deepEqual(deriveResetState(dir, rules).problems, []);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a rule whose file stopped reading the block is stale", () => {
    const dir = tmp();
    put(dir, "a.ts", "const b = 1;\n");
    put(dir, "b.ts", "startBlock: 5,\n");
    const p = deriveResetState(dir, [{ path: "a.ts", effect: "none", state: "x" }, { path: "b.ts", effect: "none", state: "y" }]).problems;
    assert.deepEqual(p.map((x) => x.split(":")[0]), ["STALE RESET_RULES entry a.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty tree is blind, not clean; tests, fixtures and docs are not readers", () => {
    const dir = tmp();
    put(dir, "x.test.ts", "deployBlock\n");
    put(dir, "fixtures/y.ts", "deployBlock\n");
    put(dir, "z.md", "deployBlock\n");
    put(dir, "node_modules/p/index.js", "deployBlock\n");
    const d = deriveResetState(dir, []);
    assert.deepEqual(d.readers, []);
    assert.match(d.problems[0], /no deploy-block reader found/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("one file classified twice is refused", () => {
    const dir = tmp();
    put(dir, "ops/a.ts", "deployBlock\n");
    const p = deriveResetState(dir, [{ path: "ops/", effect: "none", state: "x" }, { path: "ops/a.ts", effect: "none", state: "y" }]).problems;
    assert.ok(p.some((x) => /classified by 2 RESET_RULES entries/.test(x)), p.join("\n"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("the pattern catches the env names and the registry field, not a longer identifier", () => {
    for (const s of ["V2_START_BLOCK", "V2_FLYWHEEL_START_BLOCK", "START_BLOCK", "deployBlock", "startBlock", "deploy_block"]) assert.ok(READER_PATTERN.test(s), s);
    for (const s of ["assetDeployBlock", "deployBlockHash"]) assert.ok(!READER_PATTERN.test(s), s);
  });
});

describe("ops/runbooks/v8-cutover.md", () => {
  const RUNBOOK = read("ops/runbooks/v8-cutover.md");
  const commandFlags = (command) => {
    const flags = [];
    for (const line of RUNBOOK.split("\n")) {
      const at = line.indexOf(command);
      if (at < 0) continue;
      const tail = line.slice(at + command.length).split(/`|\||\s#/)[0];
      for (const [f] of tail.matchAll(/--[a-z][a-z-]*/g)) flags.push(f);
    }
    return flags;
  };

  test("names RAILWAY_RUN_UID=0 and the other traps", () => {
    for (const trap of ["RAILWAY_RUN_UID=0", "CALLHOUSE_V2_KEYS_DIR", "DATABASE_SCHEMA", "DATABASE_VIEWS_SCHEMA", "V2_EARN_START_BLOCK"]) assert.ok(RUNBOOK.includes(trap), trap);
  });

  test("names every file the derivation says resets", () => {
    for (const r of RESET_RULES.filter((x) => x.effect === "resets")) assert.ok(RUNBOOK.includes(r.path), `${r.path} resets and the runbook does not say so`);
  });

  test("every go-live-v2.sh flag it passes is one the script parses", () => {
    const script = read("ops/go-live-v2.sh");
    const known = new Set([...script.matchAll(/^\s*(--[a-z-]+)[|)]/gm)].map((m) => m[1]));
    assert.ok(known.has("--apply") && known.has("--services"), "the go-live-v2.sh parser no longer looks like a case block");
    const used = commandFlags("go-live-v2.sh");
    assert.ok(used.length >= 3);
    for (const f of used) assert.ok(known.has(f), `go-live-v2.sh does not parse ${f}`);
  });

  test("every cutover-env.mjs flag it passes is one parseArgs accepts", () => {
    const used = commandFlags("cutover-env.mjs");
    assert.ok(used.includes("--execute") && used.includes("--chain-id"));
    for (const f of used) {
      const argv = ["--execute", "--reset-state"].includes(f) || f === "--help" ? [f] : [f, "x"];
      try { parseArgs(f === "--chain-id" ? [f, "4663"] : argv); } catch (e) { assert.fail(`parseArgs rejects ${f}: ${e.message}`); }
    }
  });

  test("every step says what FAILURE looks like, and no line hands over a key", () => {
    const worked = (RUNBOOK.match(/\*\*Worked:\*\*/g) ?? []).length;
    const failed = (RUNBOOK.match(/\*\*Failed:\*\*/g) ?? []).length;
    assert.ok(worked >= 5, `only ${worked} success criteria`);
    assert.equal(failed, worked, `${worked} worked vs ${failed} failed`);
    assert.doesNotMatch(RUNBOOK, /--private-key|[0-9a-fA-F]{64}/);
  });
});

