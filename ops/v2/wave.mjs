/**
 * One command regenerates and checks every registry projection (O3-102; 02-interfaces.md §3.1
 * rule 5; ops/markets/README.md's projection table).
 *
 *   node ops/v2/wave.mjs            # validate the registries, regenerate every projection, print
 *                                   # the exact file commit set and the services to rebuild
 *   node ops/v2/wave.mjs --check    # CI: write nothing; exit 1 naming each stale projection
 *
 *   --docs-dir <callhouse-docs checkout>   where render-docs writes. Required in write mode; in
 *                                          --check mode a missing docs checkout fails unless
 *                                          --skip-docs explicitly allows it.
 *   --skip-docs                            --check mode only: report the docs projection as
 *                                          skipped instead of failing without --docs-dir.
 *
 * tier1.json is the INPUT: build-markets only validates it (its write build re-derives from the
 * network and is a separate, runbooked action). dev.json is NOT derived from it and wave never
 * edits a registry: from INTERFACE_VERSION 8 dev.json is the local anvil devnet's own registry
 * (ops/markets/README.md "dev.json, the second registry"), whose wallets are anvil accounts and
 * whose --check refuses any production wallet, key or contract (validateDevIsolation,
 * ops/markets/build-markets.mjs:1267-1321). What wave checks instead is the one thing a
 * hand-maintained second registry loses silently - the market SET - and it names the builder as the
 * fix. The Codex-owned indexer/web generators and keeper-env.sh are invoked as commands; their
 * source is never edited. No generated output may be hand-edited: wave exists so nobody has to.
 *
 * The commit set names every file to commit: changed projections plus a registry file that differs
 * from HEAD. The services to rebuild are derived from it: a registry change rebuilds the five
 * services built from the image that bakes it (keeper/Dockerfile: pricing, cranker, pricer, mm-bot
 * and the monitor), minus the signing bots for the dev registry, which the stonkhouse-dev project
 * refuses; projections map to their own service (indexer-v2 for the indexer's, keeper-<ticker> for
 * keeper-env's, the env file's stem for v2-env's, docs (publish) for the docs').
 *
 * `git` is /opt/homebrew/bin/git when present (this machine's /usr/bin/git is broken), else PATH's;
 * with no working git the registry-vs-HEAD check is reported as unknown, never silently skipped.
 * MARKETS_REGISTRY is stripped from generator child processes, so a parent shell export cannot
 * point a generator at another registry by accident.
 *
 * Tests: node --test ops/v2/wave.test.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The signing bots, read from the gating module that decides them rather than restated here.
import { SIGNING } from "./go-live-gating.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const NODE = process.execPath;
const GIT = existsSync("/opt/homebrew/bin/git") ? "/opt/homebrew/bin/git" : "git";

/**
 * The committed registries. v7-legacy.json is frozen - build-markets refuses to rebuild or validate
 * it (ops/markets/build-markets.mjs:1505-1509) and only ops/v2-env.mjs still renders from it - so it
 * has no wave step, but an edit to it still belongs in the commit set rather than being invisible.
 */
const REGISTRY_FILES = ["ops/markets/tier1.json", "ops/markets/dev.json", "ops/markets/v7-legacy.json"];

/**
 * The services built from the image that bakes a registry: keeper/Dockerfile copies
 * ops/markets/${V2_REGISTRY_FILE} into the image (keeper/Dockerfile:122-130), and pricing, cranker,
 * pricer and mm-bot run from it (ops/deploy.md:1217-1220) - as does the monitor, which runs the same
 * image and reads the baked file (ops/deploy.md:2001-2002; ops/v2/monitor.mjs:107 defaults to
 * ops/markets/tier1.json). A registry edit that does not rebuild the monitor leaves it checking the
 * previous registry, which is the one service whose job is to notice that.
 */
const KEEPER_IMAGE_SERVICES = ["pricing", "cranker", "pricer", "mm-bot", "monitor"];

/**
 * What an operator rebuilds for a changed registry. The dev registry is baked by the stonkhouse-dev
 * project (V2_REGISTRY_FILE=dev.json, ops/deploy.md:2026-2028), which refuses the signing bots
 * (ops/v2/go-live-gating.mjs SIGNING, enforced at planGating :60-67) - so naming them there sends an
 * operator at a service that does not exist. The frozen v7 registry rebuilds nothing by itself.
 */
const registryServices = (file) => {
  if (file.endsWith("v7-legacy.json")) return [];
  if (!file.endsWith("dev.json")) return [...KEEPER_IMAGE_SERVICES];
  return KEEPER_IMAGE_SERVICES.filter((service) => !SIGNING.includes(service)).map((service) => `${service} (dev)`);
};

/** The child-process environment for generators: the parent's, minus MARKETS_REGISTRY. */
export function waveChildEnv(env = process.env) {
  const out = { ...env };
  delete out.MARKETS_REGISTRY;
  return out;
}

/*//////////////////////////////////////////////////////////////
              dev.json, CHECKED AGAINST tier1.json (never derived)
//////////////////////////////////////////////////////////////*/

/**
 * dev.json is not a projection of tier1.json and wave never writes it. Until INTERFACE_VERSION 8 it
 * was tier1.json byte-for-byte plus `_dev`, and this file used to regenerate it that way; the v8
 * registry commit made it the LOCAL ANVIL DEVNET's own registry (ops/markets/README.md "dev.json,
 * the second registry"): every wallet in it is a public anvil account, its v1 deployment fields and
 * its `v2.contracts` / `v2.deployBlock` / `v2.flywheel` are null, and `build-markets.mjs --check
 * --registry ops/markets/dev.json` refuses any address production owns (validateDevIsolation,
 * ops/markets/build-markets.mjs:1267-1321). Copying tier1's values in would import production
 * wallets AND null out the anvil ones, so the derivation is gone rather than narrowed.
 *
 * What a hand-maintained second registry does lose silently is the market SET: the builder
 * regenerates `markets` from the feed directory for whichever registry it is pointed at, so a market
 * added to tier1.json stays absent from dev.json until dev.json is rebuilt too. That, and the
 * interface version both consumers gate on, is all this compares. Statuses are deliberately NOT
 * compared: NVDA is `live` in tier1.json and `superseded-by-v2` in dev.json by design. No value is
 * ever copied between the files.
 *
 * Returns the problems found, empty when the two registries agree.
 */
export function devParity(tier1Text, devText) {
  const tier1 = JSON.parse(tier1Text);
  const dev = JSON.parse(devText);
  const problems = [];
  const tickers = (registry) => (registry.markets ?? []).map((market) => market.ticker);
  const inTier1 = new Set(tickers(tier1));
  const inDev = new Set(tickers(dev));
  const missing = [...inTier1].filter((ticker) => !inDev.has(ticker));
  const extra = [...inDev].filter((ticker) => !inTier1.has(ticker));
  if (missing.length > 0) problems.push(`markets in tier1.json but not dev.json: ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`markets in dev.json but not tier1.json: ${extra.join(", ")}`);
  const tier1Version = tier1.v2?.interfaceVersion;
  const devVersion = dev.v2?.interfaceVersion;
  if (tier1Version !== devVersion) {
    problems.push(`v2.interfaceVersion is ${JSON.stringify(tier1Version)} in tier1.json and ${JSON.stringify(devVersion)} in dev.json`);
  }
  return problems;
}

/*//////////////////////////////////////////////////////////////
                        THE PROJECTION SET
//////////////////////////////////////////////////////////////*/

/** The per-service env files a directory holds, listed at call time. */
function envFiles(root, dir) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith(".env"))
    .sort()
    .map((name) => `${dir}/${name}`);
}

const stemOf = (file) => path.basename(file, ".env");

/**
 * The documented projection set, in run order. `checkOnly` steps validate an input registry in
 * place; `internal` steps run in this process (dev.json's derivation — there is no external
 * generator to call); everything else is invoked as a command, never edited. `files(root)` lists
 * owned outputs; `services(changed)` maps a changed projection to what an operator rebuilds.
 */
export function waveSteps(root) {
  return [
    {
      id: "registry",
      label: "ops/markets/tier1.json (validator)",
      checkOnly: true,
      check: ["ops/markets/build-markets.mjs", "--check"],
      files: () => ["ops/markets/tier1.json"],
      services: () => [],
    },
    {
      id: "dev-parity",
      label: "ops/markets/dev.json (market set and interface version match tier1.json)",
      internal: true,
      checkOnly: true,
      files: () => ["ops/markets/dev.json"],
      services: () => [],
      run(mode, r) {
        const problems = devParity(
          readFileSync(path.join(r, "ops/markets/tier1.json"), "utf8"),
          readFileSync(path.join(r, "ops/markets/dev.json"), "utf8"),
        );
        if (problems.length === 0) return { code: 0, output: "" };
        return {
          code: 1,
          output: [
            `DRIFT ops/markets/dev.json: ${problems.join("; ")}`,
            "  rebuild it with node ops/markets/build-markets.mjs --registry ops/markets/dev.json — it regenerates the",
            "  market rows and preserves _dev, shared and the v2 blocks. wave never edits a registry: dev.json holds the",
            "  devnet's own wallets and copying tier1's in would fail validateDevIsolation.",
          ].join("\n"),
        };
      },
    },
    {
      id: "dev-registry",
      label: "ops/markets/dev.json (validator)",
      checkOnly: true,
      check: ["ops/markets/build-markets.mjs", "--check", "--registry", "ops/markets/dev.json"],
      files: () => ["ops/markets/dev.json"],
      services: () => [],
    },
    {
      id: "web-markets",
      label: "web/lib/markets.generated.ts",
      write: ["web/scripts/gen-markets.mjs"],
      check: ["web/scripts/gen-markets.mjs", "--check"],
      files: () => ["web/lib/markets.generated.ts"],
      services: () => ["web"],
    },
    {
      id: "indexer-v2-registry",
      label: "indexer/lib/v2/marketRegistry.generated.ts",
      write: ["indexer/scripts/gen-v2-registry.mjs"],
      check: ["indexer/scripts/gen-v2-registry.mjs", "--check"],
      files: () => ["indexer/lib/v2/marketRegistry.generated.ts"],
      services: () => ["indexer-v2"],
    },
    {
      id: "indexer-card-registry",
      label: "indexer/lib/v2/cardRegistry.generated.json",
      write: ["indexer/scripts/gen-card-registry.mjs"],
      check: ["indexer/scripts/gen-card-registry.mjs", "--check"],
      files: () => ["indexer/lib/v2/cardRegistry.generated.json"],
      services: () => ["indexer-v2"],
    },
    {
      id: "keeper-env",
      label: "ops/keeper/markets/*.env",
      write: ["ops/keeper-env.sh"],
      check: ["ops/keeper-env.sh", "--check"],
      files: (r) => envFiles(r, "ops/keeper/markets"),
      // Railway names the service keeper-<lowercase ticker> (ops/keeper-railway.sh:167); the env files are
      // written upper-case (ops/keeper-env.sh), so the stem is lowered or the printed name addresses nothing.
      services: (changed) => [...new Set(changed.map((f) => `keeper-${stemOf(f).toLowerCase()}`))],
    },
    {
      id: "v2-env",
      label: "ops/v2/env/*.env",
      write: ["ops/v2-env.mjs"],
      check: ["ops/v2-env.mjs", "--check"],
      files: (r) => envFiles(r, "ops/v2/env"),
      services: (changed) => [...new Set(changed.map(stemOf))],
    },
    {
      id: "v2-env-dev",
      label: "ops/v2/env-dev/*.env",
      write: ["ops/v2-env.mjs", "--registry", "ops/markets/dev.json", "--out", "ops/v2/env-dev"],
      check: ["ops/v2-env.mjs", "--registry", "ops/markets/dev.json", "--out", "ops/v2/env-dev", "--check"],
      files: (r) => envFiles(r, "ops/v2/env-dev"),
      services: (changed) => [...new Set(changed.map((f) => `${stemOf(f)} (dev)`))],
    },
    {
      id: "docs",
      label: "callhouse-docs product/markets.md + docs/product/markets.md",
      sibling: true,
      write: (docsDir) => ["ops/markets/render-docs.mjs", "--docs-dir", docsDir],
      check: (docsDir) => ["ops/markets/render-docs.mjs", "--check", "--docs-dir", docsDir],
      files: () => ["product/markets.md", "docs/product/markets.md"],
      services: () => ["docs (publish)"],
    },
  ];
}

/*//////////////////////////////////////////////////////////////
                          EXECUTION SEAMS
//////////////////////////////////////////////////////////////*/

function defaultExec(argv, cwd) {
  try {
    const out = execFileSync(NODE, argv, { cwd, encoding: "utf8", env: waveChildEnv(), stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, output: out };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function defaultGit(args, cwd) {
  try {
    const out = execFileSync(GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, output: out };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** The registry files differing from HEAD, or null when git cannot say (reported, never hidden). */
function registryDirty(root, git) {
  const ran = git(["diff", "--name-only", "HEAD", "--", ...REGISTRY_FILES], root);
  if (ran.code !== 0) return null;
  return new Set(ran.output.split("\n").map((s) => s.trim()).filter((s) => s !== ""));
}

function snapshot(root, files) {
  const bytes = new Map();
  for (const file of files) {
    const abs = path.join(root, file);
    bytes.set(file, existsSync(abs) ? readFileSync(abs) : null);
  }
  return bytes;
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => {
    const a = before.get(name);
    const b = after.get(name);
    // A file absent from a snapshot (or from disk) against a present one is a change.
    if (a == null || b == null) return a !== b;
    return !a.equals(b);
  }).sort();
}

/** A failed check is drift (stale projection) or something else (RPC, a missing tool, a crash). */
const DRIFT_MARK = /DRIFT|differs|is missing|is stale/i;
export const failureKind = (output) => (DRIFT_MARK.test(output) ? "drift" : "error");

const tail = (output, lines = 40) => {
  const all = output.trim().split("\n");
  const shown = all.length <= lines ? all : [`… (${all.length - lines} earlier line(s) elided)`, ...all.slice(-lines)];
  return shown.map((l) => `  ${l}`).join("\n");
};

function printCommitSet(out, rows) {
  out("commit set:");
  if (rows.length === 0) out("  (nothing: every projection is byte-identical)");
  for (const row of rows) out(`  ${row}`);
}

function printServices(out, services) {
  out("services to rebuild:");
  if (services.length === 0) out("  (none)");
  for (const service of services) out(`  ${service}`);
}

/*//////////////////////////////////////////////////////////////
                              THE WAVE
//////////////////////////////////////////////////////////////*/

/**
 * Run the wave. Returns { code, stale, failed, changed, services, skippedDocs, registryDirty } —
 * the CLI prints and exits with it; the tests drive it with fake exec/git and a temp root.
 */
export function runWave({ root, check = false, docsDir = null, skipDocs = false, exec = defaultExec, git = defaultGit, out = () => {} }) {
  const steps = waveSteps(root);
  const report = { code: 0, stale: [], failed: [], changed: new Map(), services: new Set(), skippedDocs: false, registryDirty: null };

  if (skipDocs && !check) {
    out("error: --skip-docs only applies with --check (write mode regenerates the docs projection: pass --docs-dir <callhouse-docs checkout>)");
    report.code = 2;
    return report;
  }
  const docsDirAbs = docsDir === null ? null : path.resolve(docsDir);
  if (docsDirAbs !== null && !existsSync(path.join(docsDirAbs, "product"))) {
    out(`error: --docs-dir ${docsDirAbs} does not look like a callhouse-docs checkout (no product/ directory)`);
    report.code = 2;
    return report;
  }
  if (docsDirAbs === null && !skipDocs) {
    if (check) {
      out("error: --check needs the docs checkout: pass --docs-dir <callhouse-docs>, or --skip-docs to explicitly skip the docs projection");
    } else {
      out("error: write mode regenerates the docs projection: pass --docs-dir <callhouse-docs checkout>");
    }
    report.code = 2;
    return report;
  }
  if (docsDirAbs === null && skipDocs) {
    report.skippedDocs = true;
    out(`docs: skipped (--skip-docs); run node ops/markets/render-docs.mjs --check --docs-dir <callhouse-docs checkout> before release`);
  }

  const active = steps.filter((s) => !(s.id === "docs" && report.skippedDocs));
  const dirty = registryDirty(root, git);
  report.registryDirty = dirty;

  const runCheck = (step) => {
    const argv = step.internal ? null : step.id === "docs" ? step.check(docsDirAbs) : step.check;
    return step.internal ? step.run("check", step.id === "docs" ? docsDirAbs : root) : exec(argv, root);
  };
  const runWrite = (step) => {
    const argv = step.internal ? null : step.id === "docs" ? step.write(docsDirAbs) : step.write;
    return step.internal ? step.run("write", root) : exec(argv, root);
  };
  const owned = (step) => step.files(step.id === "docs" ? docsDirAbs : root);
  const displayFiles = (step, files) => (step.id === "docs" ? files.map((f) => `callhouse-docs/${f}`) : files);
  const noteServices = (step, changed) => {
    for (const service of step.services(changed)) report.services.add(service);
  };

  if (check) {
    for (const step of active) {
      const ran = runCheck(step);
      if (ran.code !== 0) {
        const entry = { step, output: ran.output.trim(), kind: failureKind(ran.output) };
        (entry.kind === "drift" ? report.stale : report.failed).push(entry);
        const files = owned(step);
        report.changed.set(step.id, files);
        noteServices(step, files);
      }
    }
    // A registry edit shows up even before anything built from it is stale.
    if (dirty === null) out("note: git could not compare the registry against HEAD; the registry-vs-HEAD part of the commit set is unknown");
    if (dirty !== null) for (const file of REGISTRY_FILES) if (dirty.has(file)) for (const service of registryServices(file)) report.services.add(service);
    if (report.stale.length > 0 || report.failed.length > 0) {
      report.code = 1;
      out("");
      for (const { step, output, kind } of [...report.stale, ...report.failed]) {
        out(`${kind === "drift" ? "STALE" : "FAILED (not drift)"}: ${step.label}`);
        if (output !== "") out(tail(output));
      }
      out("");
      const rows = [];
      if (dirty !== null) for (const file of REGISTRY_FILES) if (dirty.has(file)) rows.push(file);
      for (const { step } of [...report.stale, ...report.failed]) rows.push(...displayFiles(step, owned(step)));
      printCommitSet(out, [...new Set(rows)]);
      printServices(out, [...report.services].sort());
    } else {
      out(`wave: every projection is current${report.skippedDocs ? " (docs skipped)" : ""}`);
    }
    return report;
  }

  // Write mode, in step order: tier1 validates before anything is derived or projected from it;
  // dev.json is derived next; its validator then checks the derived bytes; projections follow.
  // A registry that does not validate is never projected.
  const regenerated = [];
  for (const step of active) {
    if (step.checkOnly) {
      const ran = runCheck(step);
      if (ran.code !== 0) {
        out(`error: ${step.label} does not validate; a broken registry is never projected:`);
        out(tail(ran.output.trim()));
        report.code = 1;
        return report;
      }
      continue;
    }
    regenerated.push(step);
    const where = step.id === "docs" ? docsDirAbs : root;
    const before = snapshot(where, owned(step));
    const ran = runWrite(step);
    if (ran.code !== 0) {
      out(`error: ${step.label} generator failed:`);
      out(tail(ran.output.trim()));
      report.code = 1;
      return report;
    }
    // A generator may add or remove projection files: re-read the owned list before comparing.
    const after = snapshot(where, owned(step));
    const changed = changedFiles(before, after);
    report.changed.set(step.id, changed);
    if (changed.length > 0) noteServices(step, changed);
  }

  // What wave wrote must check clean: a generator whose output disagrees with its own --check
  // leaves the tree dirty in a way the CI gate would catch one commit too late.
  for (const step of active) {
    const ran = runCheck(step);
    if (ran.code !== 0) {
      out(`error: ${step.label} still fails its own --check after regenerating:`);
      out(tail(ran.output.trim()));
      report.code = 1;
      return report;
    }
  }

  if (dirty === null) out("note: git could not compare the registry against HEAD; the registry-vs-HEAD part of the commit set is unknown");
  const rows = [];
  if (dirty !== null) for (const file of REGISTRY_FILES) if (dirty.has(file)) rows.push(file);
  for (const step of regenerated) for (const file of report.changed.get(step.id) ?? []) rows.push(...displayFiles(step, [file]));
  if (dirty !== null) for (const file of REGISTRY_FILES) if (dirty.has(file)) for (const service of registryServices(file)) report.services.add(service);
  if (rows.length === 0) out("wave: every projection already byte-identical; nothing to commit");
  printCommitSet(out, [...new Set(rows)]);
  printServices(out, [...report.services].sort());
  return report;
}

function main(argv) {
  let check = false;
  let docsDir = null;
  let skipDocs = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--skip-docs") skipDocs = true;
    else if (arg === "--docs-dir") {
      docsDir = argv[i + 1];
      if (docsDir === undefined || docsDir.startsWith("--")) {
        console.error("--docs-dir needs a directory");
        process.exit(2);
      }
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: node ops/v2/wave.mjs [--check] [--docs-dir <callhouse-docs checkout>] [--skip-docs]\n");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg} (see --help)`);
      process.exit(2);
    }
  }
  const report = runWave({ root: ROOT, check, docsDir, skipDocs, out: (line) => process.stdout.write(`${line}\n`) });
  process.exit(report.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
