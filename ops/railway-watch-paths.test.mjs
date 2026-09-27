/**
 * node --test ops/railway-watch-paths.test.mjs
 *
 * Every Railway service built from this repo rebuilds when a file its image bakes in changes. Each
 * `<service>/railway.json` names a Dockerfile and the `build.watchPatterns` that decide whether a push rebuilds the
 * service. Those patterns must cover every file the Dockerfile COPYs from the build context. Before this test the keeper
 * watched only `keeper/**` and the package files. Its image bakes the market registry (`ops/markets/${V2_REGISTRY_FILE}`),
 * so a registry-only promote rebuilt no keeper, and go-live-v2.sh then refused the keeper by name: its running commit
 * was not the promoted one.
 *
 * What a COPY brings in is derived, never typed: every tracked file under the COPY source that survives the repo-root
 * .dockerignore (the build context of every image here; see its header). A build ARG in a source (the registry file)
 * is a wildcard, so both registries the .dockerignore admits (tier1.json for production, dev.json for the dev project)
 * must be watched. The Dockerfile parser and the .dockerignore matcher are the mirror publisher's, which its
 * own tests pin to Docker's rules.
 *
 * Watch patterns are read the STRICT way: anchored at the repo root, `*` stays inside one directory, a pattern that
 * matches a directory covers everything under it. Railway documents gitignore-style patterns, where a pattern with no
 * slash (`package.json`) also matches in every subdirectory. Anything covered here is covered under that looser reading
 * too, so the proof holds under either. A `!` pattern would break that argument, so it is refused outright.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { dockerignoreMatcher, expandSource, globToRegExp, parseDockerfile } from "./mirror/publish-mirrors.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GLOB = /[*?[]/;

/** The files a build can see: what git tracks (Railway builds from a GitHub commit), or a plain walk if not a checkout. */
function trackedFiles(root) {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split("\0").filter(Boolean);
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk("");
  return out;
}

/** true when the path is covered by the patterns (strict reading, last match wins). */
const watcher = (patterns) => dockerignoreMatcher(patterns.join("\n"));
/** true when the pattern matches the file or one of its parent directories (Docker's parent-directory rule). */
const under = (regex, file) => file.split("/").some((_, i, parts) => regex.test(parts.slice(0, i + 1).join("/")));

/**
 * Every COPY of one Dockerfile, resolved to the context files it brings in. A directory COPY also brings in any file the
 * .dockerignore re-admits under that directory once such a file is committed (web/Dockerfile copies `ops` so that
 * `ops/maker-epochs/*.json` rides in when one exists); each such `!` exception with no tracked file yet is returned as
 * a probe path, so it is watched before its first file lands.
 * @returns {{where: string, source: string, files: string[], probes: string[]}[]}
 */
function copiedFiles(dockerfile, text, files, ignored, reincludes = []) {
  const parsed = parseDockerfile(text);
  const wildcards = new Map([...parsed.args.keys()].map((name) => [name, ["*"]]));
  const context = files.filter((file) => !ignored(file));
  const out = [];
  for (const copy of parsed.copies) {
    if (copy.from !== null) continue;
    for (const raw of copy.sources) {
      for (const { source } of expandSource(raw, wildcards)) {
        const clean = source.replace(/^\.\//, "").replace(/\/+$/, "");
        let hits;
        let probes = [];
        if (clean === "." || clean === "") hits = context;
        else if (GLOB.test(clean)) {
          const regex = globToRegExp(clean);
          hits = context.filter((file) => under(regex, file));
        } else {
          hits = context.filter((file) => file === clean || file.startsWith(`${clean}/`));
          probes = reincludes
            .filter((pattern) => pattern.startsWith(`${clean}/`))
            .filter((pattern) => !hits.some((file) => under(globToRegExp(pattern), file)))
            .map((pattern) => pattern.replace(/\*\*/g, "t-op-1070-probe").replace(/\*/g, "t-op-1070-probe").replace(/\?/g, "x"))
            .filter((probe) => !ignored(probe));
        }
        out.push({ where: `${dockerfile}:${copy.line}`, source: raw, files: [...hits].sort(), probes });
      }
    }
  }
  return out;
}

/** The `!` exceptions of a .dockerignore, normalised the way the matcher reads them. */
function reincludesOf(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("!"))
    .map((line) => path.posix.normalize(line.slice(1).trim()).replace(/^\/+/, "").replace(/\/+$/, ""));
}

/** Each `<dir>/railway.json` (and a root railway.json, if one ever appears) among the given files. */
function railwayConfigs(files) {
  return files.filter((file) => /^(?:[^/]+\/)?railway\.json$/.test(file)).sort();
}

/**
 * The watch-path failures of one checkout (or scratch tree): a copied file no pattern covers, an unwatched Dockerfile,
 * a COPY that resolves to nothing, a `!` pattern, a pattern that covers nothing the image holds.
 * @param {{root: string, files?: string[]}} options
 */
function watchFailures({ root, files = trackedFiles(root) }) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const ignoreText = files.includes(".dockerignore") ? read(".dockerignore") : "";
  const ignored = dockerignoreMatcher(ignoreText);
  const reincludes = reincludesOf(ignoreText);
  const failures = [];
  const services = {};
  for (const config of railwayConfigs(files)) {
    const build = JSON.parse(read(config)).build ?? {};
    const patterns = build.watchPatterns;
    const dockerfile = build.dockerfilePath;
    if (!Array.isArray(patterns) || patterns.length === 0) { failures.push(`${config}: no build.watchPatterns (every push would rebuild it)`); continue; }
    if (typeof dockerfile !== "string" || !files.includes(dockerfile)) { failures.push(`${config}: build.dockerfilePath ${dockerfile} is not a file in the repo`); continue; }
    const negated = patterns.filter((p) => p.trim().startsWith("!"));
    if (negated.length) failures.push(`${config}: watchPatterns ${negated.join(", ")} negate; this check cannot prove coverage through a "!" pattern`);
    const watched = watcher(patterns);
    if (!watched(dockerfile)) failures.push(`${config}: no watchPattern covers ${dockerfile} itself`);
    const baked = new Set([dockerfile]);
    for (const { where, source, files: hits, probes } of copiedFiles(dockerfile, read(dockerfile), files, ignored, reincludes)) {
      if (hits.length === 0) { failures.push(`${config}: ${where} COPY ${source} resolves to no file in the build context`); continue; }
      for (const file of hits) {
        baked.add(file);
        if (!watched(file)) failures.push(`${config}: ${where} COPY ${source} bakes ${file} into the image, but no watchPattern covers it`);
      }
      for (const probe of probes) {
        baked.add(probe);
        if (!watched(probe)) failures.push(`${config}: ${where} COPY ${source} would bake ${probe} once one is committed (a .dockerignore "!" exception), but no watchPattern covers it`);
      }
    }
    for (const pattern of patterns) {
      if (pattern.trim().startsWith("!")) continue;
      const one = watcher([pattern]);
      if (![...baked].some((file) => one(file))) failures.push(`${config}: watchPattern ${pattern} covers no file ${dockerfile} bakes in (stale, or wider than the image)`);
    }
    services[config] = { dockerfile, patterns, baked: [...baked].sort() };
  }
  return { failures, services };
}

// ---------------------------------------------------------------------------------------------------------------------
// This checkout.
// ---------------------------------------------------------------------------------------------------------------------

test("every file each Railway service's Dockerfile bakes in is covered by that service's railway.json watchPatterns", () => {
  const { failures, services } = watchFailures({ root: ROOT });
  // Positive control: the discovery and the ARG wildcard both SEE what they must, or the empty list below proves nothing.
  for (const svc of ["keeper", "indexer", "web", "notifier", "relay"]) assert.ok(services[`${svc}/railway.json`], `${svc}/railway.json not found`);
  const keeper = services["keeper/railway.json"].baked;
  for (const file of ["ops/markets/tier1.json", "ops/markets/dev.json", "ops/markets/events.json", "ops/v2/monitor.mjs", "web/package.json"]) {
    assert.ok(keeper.includes(file), `the keeper image should bake ${file}; resolved: ${keeper.join(" ")}`);
  }
  // web COPYs all of ops/, but the .dockerignore lets only a few files through; the rest must not be required.
  const web = services["web/railway.json"].baked;
  assert.ok(web.includes("ops/markets/tier1.json") && !web.some((file) => file.startsWith("ops/stonkctl/")), web.join(" "));
  assert.deepEqual(failures, []);
});

test("no service watches a path the .dockerignore keeps out of every image (no catch-all pattern)", () => {
  const files = trackedFiles(ROOT);
  const ignored = dockerignoreMatcher(fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8"));
  const probes = ["docs/t-op-1070-probe.md", "contracts/t-op-1070-probe.sol"];
  for (const probe of probes) assert.ok(ignored(probe), `${probe} should be outside every build context`);
  for (const config of railwayConfigs(files)) {
    const patterns = JSON.parse(fs.readFileSync(path.join(ROOT, config), "utf8")).build.watchPatterns;
    for (const probe of probes) assert.ok(!watcher(patterns)(probe), `${config} rebuilds on ${probe}: ${patterns.join(" ")}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The checker itself, on scratch trees: each branch goes red when it should.
// ---------------------------------------------------------------------------------------------------------------------

function scratch(tree) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "t-op-1070-"));
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { root, files: Object.keys(tree) };
}

const KEEPER_DF = [
  "FROM node AS builder",
  "COPY package.json ./",
  "COPY keeper/src ./keeper/src",
  "FROM node AS runner",
  "COPY --from=builder /out ./",
  "ARG V2_REGISTRY_FILE=tier1.json",
  "COPY --chown=node:node ops/markets/${V2_REGISTRY_FILE} ./ops/markets/${V2_REGISTRY_FILE}",
  "",
].join("\n");
const IGNORE = ["ops", "!ops/markets/tier1.json", "!ops/markets/dev.json", ""].join("\n");
const railway = (patterns) => JSON.stringify({ build: { dockerfilePath: "keeper/Dockerfile", watchPatterns: patterns } });

test("the old keeper patterns are red on the registry: a copied file with no pattern is named, with its COPY line", () => {
  const tree = {
    ".dockerignore": IGNORE,
    "package.json": "{}",
    "keeper/Dockerfile": KEEPER_DF,
    "keeper/src/main.ts": "",
    "ops/markets/tier1.json": "{}",
    "ops/markets/dev.json": "{}",
    "ops/markets/build-markets.mjs": "",
    "keeper/railway.json": railway(["keeper/**", "package.json"]),
  };
  const { failures } = watchFailures(scratch(tree));
  assert.deepEqual(failures, [
    "keeper/railway.json: keeper/Dockerfile:7 COPY ops/markets/${V2_REGISTRY_FILE} bakes ops/markets/dev.json into the image, but no watchPattern covers it",
    "keeper/railway.json: keeper/Dockerfile:7 COPY ops/markets/${V2_REGISTRY_FILE} bakes ops/markets/tier1.json into the image, but no watchPattern covers it",
  ]);
  // Both registries watched: green. build-markets.mjs is kept out by the .dockerignore, so it needs no pattern.
  tree["keeper/railway.json"] = railway(["keeper/**", "package.json", "ops/markets/tier1.json", "ops/markets/dev.json"]);
  assert.deepEqual(watchFailures(scratch(tree)).failures, []);
  // Only the production registry watched: the dev project's promote would still rebuild nothing.
  tree["keeper/railway.json"] = railway(["keeper/**", "package.json", "ops/markets/tier1.json"]);
  assert.deepEqual(watchFailures(scratch(tree)).failures, [
    "keeper/railway.json: keeper/Dockerfile:7 COPY ops/markets/${V2_REGISTRY_FILE} bakes ops/markets/dev.json into the image, but no watchPattern covers it",
  ]);
});

test("a directory COPY needs only what the .dockerignore lets through, including a re-admitted glob with no file yet", () => {
  const tree = {
    ".dockerignore": ["ops", "!ops/markets/tier1.json", "!ops/maker-epochs/*.json", ""].join("\n"),
    "web/Dockerfile": "FROM node\nCOPY web ./web\nCOPY ops ./ops\n",
    "web/app.ts": "",
    "ops/markets/tier1.json": "{}",
    "ops/deploy.md": "",
    "ops/stonkctl/cli.py": "",
    "web/railway.json": JSON.stringify({ build: { dockerfilePath: "web/Dockerfile", watchPatterns: ["web/**", "ops/markets/tier1.json"] } }),
  };
  // The deploy notes and ops/stonkctl never enter the context, so they need no pattern; the maker-epoch glob does.
  assert.deepEqual(watchFailures(scratch(tree)).failures, [
    'web/railway.json: web/Dockerfile:3 COPY ops would bake ops/maker-epochs/t-op-1070-probe.json once one is committed (a .dockerignore "!" exception), but no watchPattern covers it',
  ]);
  tree["web/railway.json"] = JSON.stringify({ build: { dockerfilePath: "web/Dockerfile", watchPatterns: ["web/**", "ops/markets/tier1.json", "ops/maker-epochs/*.json"] } });
  assert.deepEqual(watchFailures(scratch(tree)).failures, []);
  // Once an epoch file is committed it is an ordinary baked file, and the same pattern covers it.
  tree["ops/maker-epochs/2026-09-25.json"] = "{}";
  assert.deepEqual(watchFailures(scratch(tree)).failures, []);
});

test("an unwatched Dockerfile, a COPY that resolves to nothing, a negated pattern and a stale pattern are each named", () => {
  const base = {
    ".dockerignore": IGNORE,
    "package.json": "{}",
    "keeper/Dockerfile": KEEPER_DF,
    "keeper/src/main.ts": "",
    "ops/markets/tier1.json": "{}",
  };
  // The Dockerfile lives outside every pattern.
  let r = watchFailures(scratch({ ...base, "keeper/railway.json": railway(["keeper/src/**", "package.json", "ops/markets/tier1.json"]) }));
  assert.deepEqual(r.failures, ["keeper/railway.json: no watchPattern covers keeper/Dockerfile itself"]);
  // keeper/src is not in the tree: the COPY would fail the build, and a blind resolver must not pass silently.
  const { "keeper/src/main.ts": _, ...noSrc } = base;
  r = watchFailures(scratch({ ...noSrc, "keeper/railway.json": railway(["keeper/**", "package.json", "ops/markets/tier1.json"]) }));
  assert.deepEqual(r.failures, ["keeper/railway.json: keeper/Dockerfile:3 COPY keeper/src resolves to no file in the build context"]);
  // A "!" pattern is refused rather than reasoned about.
  r = watchFailures(scratch({ ...base, "keeper/railway.json": railway(["keeper/**", "package.json", "ops/markets/tier1.json", "!keeper/src/main.ts"]) }));
  assert.ok(r.failures.some((f) => /negate/.test(f)), r.failures.join("\n"));
  // A pattern that no longer matches anything the image holds is stale (or wider than the image).
  r = watchFailures(scratch({ ...base, "keeper/railway.json": railway(["keeper/**", "package.json", "ops/markets/tier1.json", "web/**"]) }));
  assert.deepEqual(r.failures, ["keeper/railway.json: watchPattern web/** covers no file keeper/Dockerfile bakes in (stale, or wider than the image)"]);
  // No watchPatterns at all means every push rebuilds the service.
  r = watchFailures(scratch({ ...base, "keeper/railway.json": JSON.stringify({ build: { dockerfilePath: "keeper/Dockerfile" } }) }));
  assert.deepEqual(r.failures, ["keeper/railway.json: no build.watchPatterns (every push would rebuild it)"]);
});
