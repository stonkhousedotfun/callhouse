/**
 * wave.mjs's dev.json parity check, stale detection, clean no-op, commit-set/service mapping, docs
 * gating, drift-vs-error classification and env hygiene, driven through fake exec/git seams against
 * temp roots: no generator runs, nothing here writes to the checkout, temp dirs are cleaned up, and
 * the real generators are covered by their own gates.
 *
 *   node --test ops/v2/wave.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { devParity, failureKind, runWave, waveChildEnv, waveSteps } from "./wave.mjs";

const ENV_SERVICES = ["cranker", "indexer-v2", "mm-bot", "notifier", "pricer", "pricing"];
const KEEPER_TICKERS = ["NVDA", "TSLA"];

const tempdirs = [];
function tempdir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempdirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempdirs) rmSync(dir, { recursive: true, force: true });
});

// The two registries as v8 has them: the same market set, their own wallets. NVDA's status differs
// between them in the real files (live vs superseded-by-v2), so the fixtures differ that way too.
const TIER1 = { shared: { usdg: "0x1", admin: "0xPRODADMIN" }, v2: { interfaceVersion: 8 }, markets: [{ ticker: "NVDA", status: "live" }] };
const DEV = {
  _dev: "DEV registry note",
  shared: { usdg: "0x1", admin: "0xANVILADMIN" },
  v2: { interfaceVersion: 8 },
  feedsSource: { source: "dev snapshot", total: 2 },
  markets: [{ ticker: "NVDA", status: "superseded-by-v2" }],
};

/** A minimal repo-shaped root: every owned projection file present, contents arbitrary but valid. */
function scratchRoot() {
  const root = tempdir("wave-");
  const files = [
    ["ops/markets/tier1.json", `${JSON.stringify(TIER1, null, 2)}\n`],
    ["ops/markets/dev.json", `${JSON.stringify(DEV, null, 2)}\n`],
    ["web/lib/markets.generated.ts", "web\n"],
    ["indexer/lib/v2/marketRegistry.generated.ts", "v2\n"],
    ["indexer/lib/v2/cardRegistry.generated.json", "card\n"],
    ...KEEPER_TICKERS.map((t) => [`ops/keeper/markets/${t}.env`, `${t}\n`]),
    ...ENV_SERVICES.map((s) => [`ops/v2/env/${s}.env`, `${s}\n`]),
    ...ENV_SERVICES.map((s) => [`ops/v2/env-dev/${s}.env`, `${s} dev\n`]),
  ];
  for (const [file, text] of files) {
    const abs = path.join(root, file);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  const docs = tempdir("wave-docs-");
  for (const file of ["product/markets.md", "docs/product/markets.md"]) {
    const abs = path.join(docs, file);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "# markets\n");
  }
  return { root, docs };
}

function fakeExec(behaviour = {}) {
  const calls = [];
  const exec = (argv, cwd) => {
    calls.push(argv);
    const key = argv.join(" ");
    for (const [match, action] of Object.entries(behaviour)) {
      if (key.includes(match)) return typeof action === "function" ? action(argv, cwd) : action;
    }
    return { code: 0, output: "" };
  };
  return { calls, exec };
}

/** A git seam: `diff --name-only HEAD` answers `dirty` (an empty set = clean), everything else 0. */
function fakeGit(dirty = []) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === "diff") return { code: 0, output: dirty.join("\n") };
    return { code: 0, output: "" };
  };
  return { calls, git };
}

const silent = () => {};
const collect = () => {
  const lines = [];
  return { lines, out: (l) => lines.push(l) };
};

/*//////////////////////////////////////////////////////////////
              dev.json, CHECKED AGAINST tier1.json (never derived)
//////////////////////////////////////////////////////////////*/

test("devParity: the market set and the interface version are compared, and nothing else is", () => {
  const tier1 = `${JSON.stringify(TIER1, null, 2)}\n`;
  const dev = `${JSON.stringify(DEV, null, 2)}\n`;
  assert.deepEqual(devParity(tier1, dev), [], "the fixtures agree on the market set and the version");

  // The whole point of v8's dev registry: its own wallets and its own per-market status are NOT drift.
  assert.deepEqual(
    devParity(tier1, `${JSON.stringify({ ...DEV, shared: { usdg: "0x1", admin: "0xSOMEOTHERANVIL" } }, null, 2)}\n`),
    [],
    "a dev-only wallet value is never compared (copying tier1's in is what validateDevIsolation refuses)",
  );

  const added = { ...TIER1, markets: [...TIER1.markets, { ticker: "TSLA", status: "planned" }] };
  assert.deepEqual(devParity(`${JSON.stringify(added, null, 2)}\n`, dev), ["markets in tier1.json but not dev.json: TSLA"]);
  assert.deepEqual(devParity(tier1, `${JSON.stringify({ ...DEV, markets: [...DEV.markets, { ticker: "GONE" }] }, null, 2)}\n`), [
    "markets in dev.json but not tier1.json: GONE",
  ]);
  assert.deepEqual(devParity(tier1, `${JSON.stringify({ ...DEV, v2: { interfaceVersion: 7 } }, null, 2)}\n`), [
    "v2.interfaceVersion is 8 in tier1.json and 7 in dev.json",
  ]);
});

test("the committed registries pass the parity check (it is green on a clean tree)", () => {
  const root = new URL("../../", import.meta.url);
  const tier1 = readFileSync(new URL("ops/markets/tier1.json", root), "utf8");
  const dev = readFileSync(new URL("ops/markets/dev.json", root), "utf8");
  assert.deepEqual(devParity(tier1, dev), [], "ops/markets/tier1.json and ops/markets/dev.json agree today");
});

test("dev-parity step: a market added to tier1 is STALE in --check, and write mode refuses without touching dev.json", () => {
  const { root, docs } = scratchRoot();
  const edited = { ...TIER1, markets: [...TIER1.markets, { ticker: "TSLA", status: "planned" }] };
  writeFileSync(path.join(root, "ops/markets/tier1.json"), `${JSON.stringify(edited, null, 2)}\n`);
  const devBefore = readFileSync(path.join(root, "ops/markets/dev.json"), "utf8");

  const { lines, out } = collect();
  const checkReport = runWave({ root, check: true, docsDir: docs, exec: fakeExec().exec, git: fakeGit().git, out });
  assert.equal(checkReport.code, 1);
  assert.ok(checkReport.stale.some((s) => s.step.id === "dev-parity"), lines.join("\n"));
  assert.ok(lines.join("\n").includes("markets in tier1.json but not dev.json: TSLA"), "the output names the missing market");
  assert.ok(lines.join("\n").includes("build-markets.mjs --registry ops/markets/dev.json"), "and names the builder as the fix");

  // Write mode treats it like any registry that does not validate: refuse before projecting, and
  // never edit a registry - the old derivation wrote dev.json here, which on v8 imports production
  // wallets and nulls the anvil ones.
  const writeLines = collect();
  const writeReport = runWave({ root, docsDir: docs, exec: fakeExec().exec, git: fakeGit().git, out: writeLines.out });
  assert.equal(writeReport.code, 1, writeLines.lines.join("\n"));
  assert.equal(readFileSync(path.join(root, "ops/markets/dev.json"), "utf8"), devBefore, "wave never writes a registry");
});

test("a clean tree runs the parity step and writes no registry", () => {
  const { root, docs } = scratchRoot();
  const tier1Before = readFileSync(path.join(root, "ops/markets/tier1.json"), "utf8");
  const devBefore = readFileSync(path.join(root, "ops/markets/dev.json"), "utf8");
  const { lines, out } = collect();
  const report = runWave({ root, docsDir: docs, exec: fakeExec().exec, git: fakeGit().git, out });
  assert.equal(report.code, 0, lines.join("\n"));
  assert.equal(readFileSync(path.join(root, "ops/markets/tier1.json"), "utf8"), tier1Before);
  assert.equal(readFileSync(path.join(root, "ops/markets/dev.json"), "utf8"), devBefore);
});

/*//////////////////////////////////////////////////////////////
                    COMMIT SET AND SERVICES
//////////////////////////////////////////////////////////////*/

test("a registry change vs HEAD adds the keeper-image services and the registry files; indexer maps to indexer-v2; dev services are marked", () => {
  const { root, docs } = scratchRoot();
  const dirty = ["ops/markets/tier1.json"];
  const { exec } = fakeExec({
    "indexer/scripts/gen-v2-registry.mjs --check": { code: 1, output: "gen-v2-registry --check: lib/v2/marketRegistry.generated.ts differs; run pnpm gen:v2-registry" },
  });
  const { lines, out } = collect();
  const report = runWave({ root, check: true, docsDir: docs, exec, git: fakeGit(dirty).git, out });
  assert.equal(report.code, 1);
  const text = lines.join("\n");
  assert.ok(text.includes("  ops/markets/tier1.json"), "the commit set includes the registry file");
  // Five services run from the image that bakes the registry, the monitor included: it reads the
  // baked file (ops/deploy.md:2001-2002) and a registry edit that skips it leaves it checking the old one.
  for (const service of ["pricing", "cranker", "pricer", "mm-bot", "monitor"]) assert.ok(text.includes(`  ${service}`), `keeper-image service ${service} listed`);
  assert.ok(text.includes("  indexer-v2"), "the indexer projection maps to indexer-v2");
  assert.ok(!text.includes("  indexer\n"), "never the v1 indexer name");
});

test("a dirty dev registry marks the dev keeper-image services, and not the bots that project refuses", () => {
  const { root, docs } = scratchRoot();
  // The failing step maps to indexer-v2, so every other name printed comes from the dirty registry.
  const { exec } = fakeExec({
    "indexer/scripts/gen-v2-registry.mjs --check": { code: 1, output: "gen-v2-registry --check: lib/v2/marketRegistry.generated.ts differs" },
  });
  const { lines, out } = collect();
  const report = runWave({ root, check: true, docsDir: docs, exec, git: fakeGit(["ops/markets/dev.json"]).git, out });
  assert.equal(report.code, 1);
  const text = lines.join("\n");
  for (const service of ["pricing (dev)", "monitor (dev)"]) assert.ok(text.includes(`  ${service}`), `${service} listed:\n${text}`);
  // The stonkhouse-dev project refuses the signing bots (ops/v2/go-live-gating.mjs SIGNING), so naming
  // them here would send an operator at services that do not exist in that project.
  for (const service of ["cranker (dev)", "pricer (dev)", "mm-bot (dev)"]) {
    assert.ok(!text.includes(`  ${service}`), `${service} is refused on stonkhouse-dev and must not be listed:\n${text}`);
  }
  assert.ok(text.includes("  ops/markets/dev.json"), "the commit set includes the dev registry");
});

test("a changed env-dev file maps to its own service, dev-marked", () => {
  const { root, docs } = scratchRoot();
  const { exec } = fakeExec({
    "ops/v2-env.mjs --registry ops/markets/dev.json --out ops/v2/env-dev --check": { code: 1, output: "v2-env --check: ops/v2/env-dev/pricer.env differs at line 1" },
  });
  const { lines, out } = collect();
  const report = runWave({ root, check: true, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 1);
  const text = lines.join("\n");
  assert.ok(text.includes("  pricer (dev)"), text);
  assert.ok(!text.includes("\n  pricer\n"), "the production service is not implicated by a dev env change");
});

test("keeper-env: a changed market env maps to its keeper-<ticker> service", () => {
  const { root, docs } = scratchRoot();
  const { exec } = fakeExec({
    "ops/keeper-env.sh": (argv, cwd) => {
      if (argv.includes("--check")) return { code: 0, output: "" };
      writeFileSync(path.join(cwd, "ops/keeper/markets/NVDA.env"), "NVDA repriced\n");
      return { code: 0, output: "" };
    },
  });
  const { lines, out } = collect();
  const report = runWave({ root, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 0);
  const text = lines.join("\n");
  assert.ok(text.includes("  ops/keeper/markets/NVDA.env"), text);
  // Railway's service is keeper-<lowercase ticker> (ops/keeper-railway.sh:167); the env file is NVDA.env.
  assert.ok(text.includes("  keeper-nvda"), text);
  assert.ok(!text.includes("  keeper-NVDA"), "the upper-case name addresses no Railway service");
});

/*//////////////////////////////////////////////////////////////
                    P3 CORRECTIONS
//////////////////////////////////////////////////////////////*/

test("--skip-docs is rejected in write mode (exit 2); valid with --check only", () => {
  const { root } = scratchRoot();
  const { exec } = fakeExec();
  const writeReport = runWave({ root, docsDir: null, skipDocs: true, exec, git: fakeGit().git, out: silent });
  assert.equal(writeReport.code, 2);
  const { lines, out } = collect();
  const checkReport = runWave({ root, check: true, docsDir: null, skipDocs: true, exec, git: fakeGit().git, out });
  assert.equal(checkReport.code, 0);
  assert.ok(lines.join("\n").includes("docs: skipped (--skip-docs)"), lines.join("\n"));
});

test("a generator creating a NEW projection file lands in the commit set", () => {
  const { root, docs } = scratchRoot();
  const { exec } = fakeExec({
    "ops/v2-env.mjs": (argv, cwd) => {
      if (argv.includes("--check")) return { code: 0, output: "" };
      if (!argv.includes("--out")) writeFileSync(path.join(cwd, "ops/v2/env/newsvc.env"), "NEW=1\n");
      return { code: 0, output: "" };
    },
  });
  const { lines, out } = collect();
  const report = runWave({ root, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 0);
  assert.ok(lines.join("\n").includes("  ops/v2/env/newsvc.env"), lines.join("\n"));
  assert.ok([...report.services].includes("newsvc"), "the new service is named");
});

test("drift and non-drift failures are reported apart", () => {
  const { root, docs } = scratchRoot();
  const { exec } = fakeExec({
    "web/scripts/gen-markets.mjs --check": { code: 1, output: "gen-markets --check: lib/markets.generated.ts differs; run pnpm gen:markets" },
    "ops/markets/build-markets.mjs --check": { code: 1, output: "Error: connect ECONNREFUSED 127.0.0.1:8545" },
  });
  const { lines, out } = collect();
  const report = runWave({ root, check: true, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 1);
  const text = lines.join("\n");
  assert.ok(text.includes("STALE: web/lib/markets.generated.ts"), text);
  assert.ok(text.includes("FAILED (not drift): ops/markets/tier1.json (validator)"), text);
  assert.equal(failureKind("DRIFT ops/markets/dev.json: regenerate"), "drift");
  assert.equal(failureKind("Error: connect ECONNREFUSED"), "error");
});

test("MARKETS_REGISTRY is stripped from generator child environments", () => {
  const env = waveChildEnv({ PATH: "/bin", MARKETS_REGISTRY: "/tmp/other.json", HOME: "/x" });
  assert.equal(env.MARKETS_REGISTRY, undefined);
  assert.equal(env.PATH, "/bin");
});

/*//////////////////////////////////////////////////////////////
                    ORIGINAL BEHAVIOUR, KEPT
//////////////////////////////////////////////////////////////*/

test("clean no-op: write mode with byte-identical projections commits nothing and rebuilds nothing", () => {
  const { root, docs } = scratchRoot();
  const { calls, exec } = fakeExec();
  const { lines, out } = collect();
  const report = runWave({ root, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 0);
  assert.ok(lines.some((l) => l.includes("nothing to commit")), lines.join("\n"));
  assert.deepEqual([...report.services], []);
  const flat = calls.map((c) => c.join(" "));
  assert.ok(flat[0].includes("build-markets.mjs --check"), flat.join("\n"));
  assert.ok(flat.some((c) => c === "web/scripts/gen-markets.mjs"), "web write ran");
  assert.ok(flat.some((c) => c === "web/scripts/gen-markets.mjs --check"), "web post-check ran");
  assert.ok(flat.some((c) => c.includes("render-docs.mjs --docs-dir")), "docs write ran with --docs-dir");
  assert.ok(flat.some((c) => c === "ops/keeper-env.sh"), "keeper-env write ran");
});

test("validator failure: a registry that does not validate is never projected", () => {
  const { root, docs } = scratchRoot();
  const { calls, exec } = fakeExec({
    "ops/markets/build-markets.mjs --check": { code: 1, output: "build-markets --check: v2.interfaceVersion must be 7" },
  });
  const { lines, out } = collect();
  const report = runWave({ root, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 1);
  assert.ok(lines.join("\n").includes("never projected"), lines.join("\n"));
  const flat = calls.map((c) => c.join(" "));
  assert.ok(!flat.some((c) => c === "web/scripts/gen-markets.mjs"), "no generator ran");
});

test("docs gating: --docs-dir is required in both modes without --skip-docs; a bad checkout is rejected", () => {
  const { root } = scratchRoot();
  const { exec } = fakeExec();
  assert.equal(runWave({ root, docsDir: null, exec, git: fakeGit().git, out: silent }).code, 2);
  assert.equal(runWave({ root, check: true, docsDir: null, exec, git: fakeGit().git, out: silent }).code, 2);
  assert.equal(runWave({ root, check: true, docsDir: root, exec, git: fakeGit().git, out: silent }).code, 2);
});

test("docs commit set: a regenerated docs projection is reported as the sibling's files", () => {
  const { root, docs } = scratchRoot();
  const { exec } = fakeExec({
    "ops/markets/render-docs.mjs": (argv) => {
      if (argv.includes("--check")) return { code: 0, output: "" };
      writeFileSync(path.join(path.resolve(argv[argv.indexOf("--docs-dir") + 1]), "product/markets.md"), "# markets (regenerated)\n");
      return { code: 0, output: "" };
    },
  });
  const { lines, out } = collect();
  const report = runWave({ root, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 0);
  const text = lines.join("\n");
  assert.ok(text.includes("  callhouse-docs/product/markets.md"), text);
  assert.ok(text.includes("docs (publish)"), text);
});

test("a generator that fails after writing aborts the wave honestly", () => {
  const { root, docs } = scratchRoot();
  const { exec } = fakeExec({
    "indexer/scripts/gen-card-registry.mjs": { code: 1, output: "gen-card-registry: v2.defaults.ladder.weekly.rungs must be a positive integer" },
  });
  const { lines, out } = collect();
  const report = runWave({ root, docsDir: docs, exec, git: fakeGit().git, out });
  assert.equal(report.code, 1);
  assert.ok(lines.join("\n").includes("generator failed"), lines.join("\n"));
});

test("the wave step list matches ops/markets/README.md's projection rows one-for-one", () => {
  const readme = readFileSync(new URL("../markets/README.md", import.meta.url), "utf8");
  const ids = waveSteps("/unused").map((s) => s.id);
  assert.deepEqual(ids, ["registry", "dev-parity", "dev-registry", "web-markets", "indexer-v2-registry", "indexer-card-registry", "keeper-env", "v2-env", "v2-env-dev", "docs"]);
  const rows = [
    ["ops/markets/build-markets.mjs", "registry"],
    ["ops/markets/build-markets.mjs --check --registry ops/markets/dev.json", "dev-registry"],
    ["web/scripts/gen-markets.mjs", "web-markets"],
    ["indexer/scripts/gen-v2-registry.mjs", "indexer-v2-registry"],
    ["indexer/scripts/gen-card-registry.mjs", "indexer-card-registry"],
    ["ops/keeper-env.sh", "keeper-env"],
    ["ops/v2-env.mjs", "v2-env"],
    ["ops/v2-env.mjs --registry ops/markets/dev.json --out ops/v2/env-dev", "v2-env-dev"],
    ["render-docs.mjs", "docs"],
  ];
  for (const [command, id] of rows) {
    assert.ok(readme.includes(command), `README documents the ${id} row (${command})`);
    assert.ok(ids.includes(id), `wave has the ${id} step`);
  }
});
