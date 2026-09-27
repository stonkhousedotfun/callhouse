/**
 * node --test ops/v8/prelaunch-gate-image.test.mjs
 *
 * `stonkctl prelaunch-gate` runs ops/v8/prelaunch-gate.mjs inside the production `monitor` service, which runs
 * the keeper image (keeper/Dockerfile). The image must carry the gate, every file it imports at runtime, and the
 * monitor.mjs it spawns. Both keeper/Dockerfile (a COPY in the runner stage) and the root .dockerignore (which drops
 * ops/ from the build context and re-includes named files) decide that, so both are checked for every file.
 *
 * THE FILE LIST IS DERIVED, never typed: runtimeFiles() walks the relative imports (static, re-export and dynamic) from
 * the gate, plus the monitor path the gate itself exports. A new import in the gate or in go-live-gating.mjs that the
 * image does not carry fails here by name, before a launch-day `railway ssh` dies with ERR_MODULE_NOT_FOUND.
 *
 * The same image runs monitor.mjs as the `monitor` service, and the monitor also READS data files by a constant
 * path. The role manifest (ROLES_FILE, ops/abis/v2/roles.json) was never copied, so the production monitor at the v9 launch
 * logged "[incomplete] members: the role manifest could not be read: /app/ops/abis/v2/roles.json: ENOENT" and checked no
 * role holder. constantPaths() lists every path monitor.mjs builds from string literals alone on its HERE or ROOT, and
 * each one is held to the runner stage and the .dockerignore like the gate's imports, unless NOT_BAKED says why not.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_REGISTRY, HERE as MONITOR_HERE, ROLES_FILE, ROOT as MONITOR_ROOT } from "../v2/monitor.mjs";
import { MONITOR_PATH } from "./prelaunch-gate.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = path.join(ROOT, "ops", "v8", "prelaunch-gate.mjs");

const SPEC_RES = [
  /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/gs, // import x from "…" / export { x } from "…"
  /\bimport\s*["']([^"']+)["']/g, // import "…";
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("…")
];

/** Every relative module a file names, resolved to an absolute path. Bare and node: specifiers are the runtime's. */
export function relativeImports(file, text = readFileSync(file, "utf8")) {
  const out = new Set();
  for (const re of SPEC_RES) {
    for (const m of text.matchAll(re)) {
      if (m[1].startsWith("./") || m[1].startsWith("../")) out.add(path.resolve(path.dirname(file), m[1]));
    }
  }
  return [...out].sort();
}

/**
 * The files the gate needs at runtime: the entries and everything they import, transitively. A relative import that
 * does not exist is a problem, not a skip: a walker that drops what it cannot find reads a broken tree as complete.
 */
export function runtimeFiles(entries) {
  const seen = new Set();
  const missing = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!existsSync(file)) { missing.push(file); continue; }
    seen.add(file);
    queue.push(...relativeImports(file));
  }
  return { files: [...seen].sort(), missing: missing.sort() };
}

/** Whether a .dockerignore line (not an exception) drops `rel`: the path itself, a directory above it, or a glob over it. */
function excludes(line, rel) {
  if (line === "" || line.startsWith("#") || line.startsWith("!")) return false;
  const pat = line.replace(/\/+$/, "");
  if (rel === pat || rel.startsWith(`${pat}/`)) return true;
  if (!pat.includes("*")) return false;
  const re = pat.split("**").map((part) => part.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${re}(/.*)?$`).test(rel);
}

/** One line per image problem for repo-relative files; empty when the runner stage and the build context carry all. */
export function imageProblems(files, dockerfile, dockerignore) {
  const problems = [];
  const runnerAt = dockerfile.search(/^FROM\s+\S+\s+AS\s+runner\s*$/m);
  if (runnerAt === -1) return ["keeper/Dockerfile has no `FROM … AS runner` stage"];
  const runner = dockerfile.slice(runnerAt).split("\n").map((l) => l.trim());
  const ignore = dockerignore.split("\n").map((l) => l.trim());
  for (const rel of files) {
    if (!runner.includes(`COPY --chown=node:node ${rel} ./${rel}`)) {
      problems.push(`keeper/Dockerfile does not COPY ${rel} into the runner stage at ./${rel}`);
    }
    const at = ignore.indexOf(`!${rel}`);
    if (at === -1) {
      problems.push(`.dockerignore does not re-include ${rel} (it drops ops/ from the build context)`);
    } else if (ignore.slice(at + 1).some((l) => excludes(l, rel))) {
      problems.push(`.dockerignore re-excludes ${rel} after its exception (the last matching line wins)`);
    }
  }
  return problems;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

const LIT = String.raw`(?:"[^"\\]*"|'[^'\\]*')`;
const LITERALS = new RegExp(String.raw`^(?:\s*,\s*${LIT})+\s*$`);

/**
 * Every path a module builds from string literals alone on one of `bases` (name -> absolute directory):
 * `path.join(ROOT, "ops", "abis", "v2", "roles.json")`, `path.resolve(HERE, 'state')`, and `new URL("./x.json",
 * import.meta.url)` (on bases.HERE), in either quote. A path with any other part (a flag, an env value, a template,
 * another constant) is the caller's, not the image's. A result equal to a base (`ROOT = path.resolve(HERE, "..", "..")`)
 * is a base, not a file.
 */
export function constantPaths(text, bases) {
  const out = new Set();
  const call = new RegExp(String.raw`\bpath\.(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)((?:\s*,\s*${LIT})+)\s*\)`, "g");
  for (const m of text.matchAll(call)) {
    if (!Object.hasOwn(bases, m[1]) || !LITERALS.test(m[2])) continue;
    out.add(path.join(bases[m[1]], ...[...m[2].matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((p) => p[1] ?? p[2])));
  }
  if (bases.HERE !== undefined) {
    const url = new RegExp(String.raw`\bnew URL\(\s*(${LIT})\s*,\s*import\.meta\.url\s*\)`, "g");
    for (const m of text.matchAll(url)) {
      const spec = m[1].slice(1, -1);
      if (spec.startsWith("./") || spec.startsWith("../")) out.add(path.join(bases.HERE, spec));
    }
  }
  const own = new Set(Object.values(bases).map((b) => path.resolve(b)));
  return [...out].filter((p) => !own.has(path.resolve(p))).sort();
}

/** The Dockerfile with every `${NAME}` of an `ARG NAME=default` replaced by that default: the image a plain build makes. */
export function withArgDefaults(dockerfile) {
  let out = dockerfile;
  for (const m of dockerfile.matchAll(/^ARG\s+([A-Za-z_]\w*)=(\S+)\s*$/gm)) out = out.split(`\${${m[1]}}`).join(m[2]);
  return out;
}

/**
 * The constant paths of monitor.mjs that the image does not carry, and why each is right not to. Anything else the scan
 * finds must be COPYed. An entry the scan no longer finds is stale and fails the test, so this cannot hide a new path.
 */
const NOT_BAKED = {
  "ops/v2/state": "DEFAULT_STATE_DIR: where the monitor WRITES state; the service sets MONITOR_STATE_PATH=/data/monitor-v2.json",
  "package.json": "a loadViem createRequire anchor: never read; viem resolves from /app/node_modules (COPY --from=builder /out)",
  "keeper/package.json": "a loadViem createRequire anchor, as above",
  "ops/v2/package.json": "a loadViem createRequire anchor, as above",
};

const MONITOR = path.join(ROOT, "ops", "v2", "monitor.mjs");
/** Repo-relative: every constant path of monitor.mjs, resolved with the module's own HERE and ROOT. */
const monitorConstantPaths = () => constantPaths(readFileSync(MONITOR, "utf8"), { HERE: MONITOR_HERE, ROOT: MONITOR_ROOT }).map(rel);
/** Repo-relative: the files monitor.mjs reads by a constant path that the keeper image must carry. */
const monitorImageFiles = () => monitorConstantPaths().filter((f) => !Object.hasOwn(NOT_BAKED, f));

describe("the keeper image carries the pre-launch gate and everything it runs", () => {
  test("the walk starts from the gate and reaches the monitor it spawns, and every import exists", () => {
    const { files, missing } = runtimeFiles([GATE, MONITOR_PATH]);
    assert.deepEqual(missing, [], "a relative import that does not exist");
    assert.ok(files.includes(GATE) && files.includes(MONITOR_PATH));
    // The gate imports at least one module of its own (go-live-gating.mjs, which imports tvl-threshold.mjs).
    assert.ok(relativeImports(GATE).length > 0, "the walk found no import in the gate: the walker is broken");
    assert.ok(files.length > 2, files.map(rel).join(", "));
  });

  test("keeper/Dockerfile and .dockerignore carry every runtime file of the gate", () => {
    const files = runtimeFiles([GATE, MONITOR_PATH]).files.map(rel);
    const problems = imageProblems(files,
      readFileSync(path.join(ROOT, "keeper", "Dockerfile"), "utf8"),
      readFileSync(path.join(ROOT, ".dockerignore"), "utf8"));
    assert.deepEqual(problems, [], `files the gate needs: ${files.join(", ")}`);
  });

  test("the image copies the gate's runtime files and not the rest of ops/", () => {
    const files = new Set(runtimeFiles([GATE, MONITOR_PATH]).files.map(rel));
    const dockerfile = readFileSync(path.join(ROOT, "keeper", "Dockerfile"), "utf8");
    const opsCopies = [...dockerfile.matchAll(/^COPY --chown=node:node (ops\/\S+) /gm)].map((m) => m[1]);
    // The registry (an ARG path), its events calendar, the gate's closure, and the files monitor.mjs reads by a constant
    // path; never a directory or a glob.
    const monitorFiles = new Set(monitorImageFiles());
    const others = opsCopies.filter((f) => !files.has(f) && !f.startsWith("ops/markets/") && !monitorFiles.has(f));
    assert.deepEqual(others, [], "an ops/ COPY that is neither the gate's runtime closure, the registry, nor a file monitor.mjs reads");
    for (const f of opsCopies) assert.ok(!f.endsWith("/") && !f.includes("*"), `${f}: copy files, never a tree`);
  });
});

describe("the checker itself (scratch files, so a pass above means something)", () => {
  const scratch = () => mkdtempSync(path.join(os.tmpdir(), "gate-image-"));

  test("the walk follows static, re-export and dynamic imports, transitively, and ignores bare specifiers", () => {
    const dir = scratch();
    try {
      mkdirSync(path.join(dir, "v2"));
      writeFileSync(path.join(dir, "a.mjs"), 'import { b } from "./v2/b.mjs";\nimport fs from "node:fs";\nimport { x } from "viem";\n');
      writeFileSync(path.join(dir, "v2", "b.mjs"), 'export { c } from "../c.mjs";\nexport const b = 1;\n');
      writeFileSync(path.join(dir, "c.mjs"), 'export const c = () => import("./d.mjs");\nimport "./e.mjs";\n');
      writeFileSync(path.join(dir, "d.mjs"), "export {};\n");
      writeFileSync(path.join(dir, "e.mjs"), "export {};\n");
      const { files, missing } = runtimeFiles([path.join(dir, "a.mjs")]);
      assert.deepEqual(files.map((f) => path.relative(dir, f)).sort(), ["a.mjs", "c.mjs", "d.mjs", "e.mjs", path.join("v2", "b.mjs")].sort());
      assert.deepEqual(missing, []);
      writeFileSync(path.join(dir, "e.mjs"), 'import {\n  gone,\n} from "./gone.mjs";\n');
      assert.deepEqual(runtimeFiles([path.join(dir, "a.mjs")]).missing, [path.join(dir, "gone.mjs")], "a multi-line import of a missing file is named");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing COPY, a COPY outside the runner stage, and a missing or undone exception are each named", () => {
    const files = ["ops/v8/gate.mjs", "ops/v2/lib.mjs"];
    const dockerfile = [
      "FROM node:22 AS base", "WORKDIR /app", "FROM base AS builder",
      "COPY --chown=node:node ops/v2/lib.mjs ./ops/v2/lib.mjs",
      "FROM base AS runner", "COPY --chown=node:node ops/v8/gate.mjs ./ops/v8/gate.mjs",
    ].join("\n");
    const ignore = ["ops", "!ops/v8/gate.mjs", "!ops/v2/lib.mjs"].join("\n");
    assert.deepEqual(imageProblems(files, dockerfile, ignore), [
      "keeper/Dockerfile does not COPY ops/v2/lib.mjs into the runner stage at ./ops/v2/lib.mjs",
    ]);
    const good = `${dockerfile}\nCOPY --chown=node:node ops/v2/lib.mjs ./ops/v2/lib.mjs`;
    assert.deepEqual(imageProblems(files, good, ignore), [], "the control: both files copied, both re-included");
    assert.deepEqual(imageProblems(files, good, ["ops", "!ops/v8/gate.mjs"].join("\n")), [
      ".dockerignore does not re-include ops/v2/lib.mjs (it drops ops/ from the build context)",
    ]);
    assert.deepEqual(imageProblems(files, good, `${ignore}\nops/v2`), [
      ".dockerignore re-excludes ops/v2/lib.mjs after its exception (the last matching line wins)",
    ]);
    assert.deepEqual(imageProblems(files, good, `${ignore}\n**/*.mjs\nops/maker-epochs\n!ops/other.json`), [
      ".dockerignore re-excludes ops/v8/gate.mjs after its exception (the last matching line wins)",
      ".dockerignore re-excludes ops/v2/lib.mjs after its exception (the last matching line wins)",
    ], "a glob re-excludes both; an unrelated path and a later exception do not");
    assert.deepEqual(imageProblems(files, "FROM node:22\n", ignore), ["keeper/Dockerfile has no `FROM … AS runner` stage"]);
  });
});

describe("The keeper image carries every file monitor.mjs reads by a constant path", () => {
  test("the scan finds the role manifest and the registry, and every NOT_BAKED entry is one it finds", () => {
    const found = monitorConstantPaths();
    // The positive control: a scan that finds nothing would pass every image.
    assert.ok(found.includes(rel(ROLES_FILE)), `ROLES_FILE ${rel(ROLES_FILE)} is a constant path of monitor.mjs: ${found.join(", ")}`);
    assert.ok(found.includes(rel(DEFAULT_REGISTRY)), `DEFAULT_REGISTRY ${rel(DEFAULT_REGISTRY)} is a constant path of monitor.mjs`);
    assert.equal(MONITOR_ROOT, ROOT, "monitor.mjs's ROOT is this repository");
    const stale = Object.keys(NOT_BAKED).filter((f) => !found.includes(f));
    assert.deepEqual(stale, [], "a NOT_BAKED entry monitor.mjs no longer builds: remove it");
  });

  test("each such file is in the repository, COPYed into the runner stage, and re-included by .dockerignore", () => {
    const files = monitorImageFiles();
    assert.deepEqual(files.filter((f) => !existsSync(path.join(ROOT, f))), [], "a file monitor.mjs reads that the repository does not have");
    const problems = imageProblems(files,
      withArgDefaults(readFileSync(path.join(ROOT, "keeper", "Dockerfile"), "utf8")),
      readFileSync(path.join(ROOT, ".dockerignore"), "utf8"));
    assert.deepEqual(problems, [], `files monitor.mjs reads: ${files.join(", ")}`);
  });
});

describe("the constant-path scan and the ARG defaults (scratch text, so a pass above means something)", () => {
  const bases = { HERE: "/r/ops/v2", ROOT: "/r" };

  test("literal joins and resolves on HERE or ROOT, and import.meta URLs, are found; anything else is not", () => {
    const text = [
      'export const ROOT = path.resolve(HERE, "..", "..");',
      'const A = path.join(ROOT, "ops", "abis", "v2", "roles.json");',
      "const B = path.resolve(HERE, 'single-quoted.json');",
      'const C = path.join(HERE,\n  "state");',
      'const D = path.join(ROOT, "ops", name);',
      'const E = path.join(ROOT, `ops/${x}.json`);',
      'const F = path.join(OTHER, "not-a-base.json");',
      'const G = path.join(DEFAULT_STATE_DIR, "x.json");',
      'const H = readFileSync(new URL("../markets/events.json", import.meta.url));',
      'const I = path.join(ROOT, "ops", "markets", opts.file ?? "tier1.json");',
    ].join("\n");
    assert.deepEqual(constantPaths(text, bases), [
      "/r/ops/abis/v2/roles.json", "/r/ops/markets/events.json", "/r/ops/v2/single-quoted.json", "/r/ops/v2/state",
    ]);
  });

  test("the real Dockerfile without its roles.json COPY, or the .dockerignore without its exception, is named", () => {
    const files = monitorImageFiles();
    assert.ok(files.includes("ops/abis/v2/roles.json"), files.join(", "));
    const dockerfile = withArgDefaults(readFileSync(path.join(ROOT, "keeper", "Dockerfile"), "utf8"));
    const ignore = readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
    const line = "COPY --chown=node:node ops/abis/v2/roles.json ./ops/abis/v2/roles.json";
    assert.ok(dockerfile.split("\n").includes(line), "the setup: the COPY is in keeper/Dockerfile");
    assert.deepEqual(imageProblems(files, dockerfile.split("\n").filter((l) => l !== line).join("\n"), ignore), [
      "keeper/Dockerfile does not COPY ops/abis/v2/roles.json into the runner stage at ./ops/abis/v2/roles.json",
    ]);
    assert.deepEqual(imageProblems(files, dockerfile, ignore.split("\n").filter((l) => l !== "!ops/abis/v2/roles.json").join("\n")), [
      ".dockerignore does not re-include ops/abis/v2/roles.json (it drops ops/ from the build context)",
    ]);
  });

  test("an ARG default replaces its ${NAME} everywhere; an ARG with no default and an unknown name are left alone", () => {
    const df = [
      "ARG V2_REGISTRY_FILE=tier1.json", "ARG NO_DEFAULT",
      "COPY ops/markets/${V2_REGISTRY_FILE} ./ops/markets/${V2_REGISTRY_FILE}", "COPY ${NO_DEFAULT} ${OTHER} ./x",
    ].join("\n");
    assert.equal(withArgDefaults(df).split("\n")[2], "COPY ops/markets/tier1.json ./ops/markets/tier1.json");
    assert.equal(withArgDefaults(df).split("\n")[3], "COPY ${NO_DEFAULT} ${OTHER} ./x");
  });
});
