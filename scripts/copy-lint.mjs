#!/usr/bin/env node
/**
 * copy-lint — enforces the frontend copy rules from README "Frontend copy" and
 * TECHSPEC 7.3. These are compliance rules, not style rules. They fail CI.
 *
 * Scanned here: web/ → app.stonkhouse.fun, the dapp. The directory must exist and
 * must yield files; a package that has vanished is a hard failure, not a silent pass.
 *
 * TWIN FILE. The marketing landing (stonkhouse.fun) moved to its own repository,
 * stonkhousedotfun/callhouse-site, on 2026-09-13 and carries its own copy of this script with
 * the site/ disclosure table. FORBIDDEN below must stay IDENTICAL in both copies:
 * change it in paired commits to both repos. Before the split this was one file
 * applying one rule set to both surfaces; now drift is possible, so diff the two
 * FORBIDDEN tables whenever either changes.
 *
 * FORBIDDEN: marketing claims we are not allowed to make. Checked twice per file:
 *   once per line (so the report names the line), and once against the whole file
 *   flattened to one line, because JSX copy wraps and a phrase split at a line
 *   break ("projected\nyield") is invisible to a per-line scan. The flattened pass
 *   only reports what the per-line pass did not already catch.
 * REQUIRED:  disclosures that must be literally present on specific pages. Also
 *   checked against the flattened file, so a disclosure may itself wrap.
 *
 * SELF-TEST: every run first lints synthetic trees in a temp directory and asserts
 * the linter still fails where it must and passes where it must. A gate that
 * cannot demonstrate it fails on known-bad input proves nothing when it is green,
 * and this file was once green while both of its passes were blind. The self-test
 * is not optional and has no flag; it costs milliseconds and no dependencies.
 *
 * DELIBERATELY ABSENT: no dependencies (this runs in CI before install of any
 * workspace), no auto-fix, no severity levels, no per-package rule overrides —
 * one rule set, applied identically to every surface (and to the site repo's twin).
 *
 * Escape hatch: put `copy-lint-allow` in a comment on the same line. Use it only
 * where the forbidden phrase appears inside an explicit negation, e.g. a docs page
 * saying "we do not publish an APY". Allowed lines are also excluded from the
 * flattened pass.
 */
import {readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join, dirname, relative, extname} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const EXT = new Set([".tsx", ".ts", ".jsx", ".js", ".md", ".mdx", ".html", ".json"]);
const SKIP_DIR = new Set(["node_modules", ".next", "dist", "out", ".git", "coverage"]);

/** Frontend packages under compliance in this repository. Each is expected to exist. */
const PACKAGES = [{name: "web", dir: join(ROOT, "web")}];

/** Phrases that must never appear on the marketing surface. */
const FORBIDDEN = [
  {re: /\bAPY\b/i, why: 'README "Frontend copy": APY is not allowed on the marketing surface'},
  {re: /\bAPR\b/i, why: "annualized-return claims are not allowed; show last week realized USDG only"},
  {re: /10\s*%\s*weekly/i, why: 'README "Frontend copy": "10% weekly" is not allowed'},
  {re: /projected\s+(yield|return|apy|income)/i, why: "TECHSPEC 7.3: projected yield is not allowed"},
  {re: /annuali[sz]ed/i, why: "TECHSPEC 8: do not annualize on the page"},
  {re: /backed\s+by\s+nvidia/i, why: 'TECHSPEC 7.3: "backed by Nvidia the company" is not allowed'},
  {re: /dividend\s+paid\s+(in\s+cash\s+)?by\s+nvidia/i, why: "TECHSPEC 7.3: Nvidia does not pay you a dividend"},
  {re: /guaranteed\s+(yield|return|premium)/i, why: "premium is paid only if a buyer fills; nothing is guaranteed"},
  {re: /\bguaranteed\b/i, why: "do not promise an outcome"},
  {re: /risk[-\s]?free/i, why: "assignment and issuer freeze are real risks"},
  {re: /\bcan['’]?t\s+lose\b/i, why: "a buyer can lose the full cost"},
  {re: /\bfree\s+money\b/i, why: "do not describe a risky trade as free money"},
];

/**
 * Disclosures required on specific routes. `pkg` names the package the page lives
 * in; `page` is matched against the POSIX relative path of the file inside it.
 *
 * The assignment wording differs by surface on purpose. On web/legacy/ the reader is a
 * depositor, so it is "your tokens". On the landing (stonkhousedotfun/callhouse-site) nobody
 * has deposited yet, so it is "the collateral". Do not unify them.
 */
const REQUIRED = [
  {
    pkg: "web",
    page: "app/page.tsx",
    phrases: ["Marketplace"],
  },
  {
    pkg: "web",
    page: "components/v2/Marketplace.tsx",
    phrases: ["max loss"],
  },
  {
    pkg: "web",
    page: "components/v2/PayoffCard.tsx",
    phrases: ["max loss"],
  },
  {
    pkg: "web",
    // W2-01 moved the real v1 vault page here; /vault/nvda is only a redirect when v2 is on.
    page: "app/legacy/vault/nvda/page.tsx",
    phrases: [
      "Premium is paid only if a buyer fills",
      "Assignment can take your tokens at the strike",
      "Stock Tokens are debt securities",
      "Last week realized",
    ],
  },
  {
    pkg: "web",
    page: "app/legal/page.tsx",
    phrases: ["not available to US persons", "Robinhood Assets (Jersey) Limited"],
  },
];

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (EXT.has(extname(p))) acc.push(p);
  }
  return acc;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lints `packages` against FORBIDDEN and `required`, returning every violation as a
 * string plus the scanned-file count per package. Pure with respect to its inputs —
 * the self-test drives it with synthetic trees before the real run trusts it.
 */
function lintPackages(packages, required) {
  const errors = [];
  const counts = new Map();
  const present = new Set();

  for (const {name, dir} of packages) {
    counts.set(name, 0);
    if (!isDir(dir)) {
      errors.push(`${name}/  MISSING — package directory does not exist; every listed frontend package is scanned`);
      continue;
    }
    present.add(name);

    const files = walk(dir);
    counts.set(name, files.length);
    if (files.length === 0) {
      errors.push(`${name}/  scanned 0 files — is the ${name} package scaffolded?`);
      continue;
    }

    for (const file of files) {
      const rel = relative(dir, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      const caught = new Set();
      lines.forEach((line, i) => {
        if (line.includes("copy-lint-allow")) return;
        for (const rule of FORBIDDEN) {
          const m = line.match(rule.re);
          if (m) {
            caught.add(rule);
            errors.push(`${name}/${rel}:${i + 1}  forbidden copy ${JSON.stringify(m[0])} — ${rule.why}`);
          }
        }
      });
      // Second pass over the file flattened to one line: a forbidden phrase split at a
      // JSX line wrap matches no single line. Rules already caught above are skipped so
      // a hit is not reported twice. Allowed lines are left out of the flattening.
      const flat = lines
        .filter((line) => !line.includes("copy-lint-allow"))
        .join(" ")
        .replace(/\s+/g, " ");
      for (const rule of FORBIDDEN) {
        if (caught.has(rule)) continue;
        const m = flat.match(rule.re);
        if (m) {
          errors.push(
            `${name}/${rel}  forbidden copy ${JSON.stringify(m[0])} spans a line break — ${rule.why}`,
          );
        }
      }
    }
  }

  for (const {pkg, page, phrases} of required) {
    // A missing package is already reported once; do not repeat it per page.
    if (!present.has(pkg)) continue;
    const dir = packages.find((p) => p.name === pkg).dir;
    let body;
    try {
      body = readFileSync(join(dir, page), "utf8");
    } catch {
      errors.push(`${pkg}/${page}  MISSING — required disclosure page does not exist`);
      continue;
    }
    const flat = body.replace(/\s+/g, " ");
    for (const phrase of phrases) {
      if (!flat.includes(phrase.replace(/\s+/g, " "))) {
        errors.push(`${pkg}/${page}  missing required disclosure: ${JSON.stringify(phrase)}`);
      }
    }
  }

  return {errors, counts};
}

/**
 * Proves the linter can still fail before any green result is believed. Each case
 * builds a tree under a fresh temp dir and asserts on the error list; the required
 * pages of the clean tree are generated from REQUIRED itself, so the test exercises
 * the real rule set rather than a copy of it that could drift.
 */
function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), "copy-lint-"));
  const packages = [{name: "web", dir: join(tmp, "web")}];
  const writeCleanTree = () => {
    for (const {dir} of packages) {
      mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, "prose.tsx"), "export const Prose = () => <>ordinary descriptive copy</>;\n");
    }
    for (const {pkg, page, phrases} of REQUIRED) {
      const f = join(tmp, pkg, page);
      mkdirSync(dirname(f), {recursive: true});
      writeFileSync(f, phrases.join("\n") + "\n");
    }
  };
  let ran = 0;
  const expect = (label, mutate, ok) => {
    ran += 1;
    rmSync(tmp, {recursive: true, force: true});
    mkdirSync(tmp, {recursive: true});
    writeCleanTree();
    if (mutate) mutate();
    const {errors} = lintPackages(packages, REQUIRED);
    if (!ok(errors)) {
      console.error(`copy-lint self-test FAILED — ${label}\n  got: ${JSON.stringify(errors)}`);
      rmSync(tmp, {recursive: true, force: true});
      process.exit(1);
    }
  };
  try {
    expect("a clean tree passes", null, (e) => e.length === 0);
    expect(
      "a forbidden phrase on one line is caught",
      () => writeFileSync(join(tmp, "web", "prose.tsx"), "earn a steady APY here\n"),
      (e) => e.some((x) => x.includes("forbidden copy")),
    );
    expect(
      "a forbidden phrase wrapped across lines is caught",
      () => writeFileSync(join(tmp, "web", "prose.tsx"), "the projected\n   yield on offer\n"),
      (e) => e.some((x) => x.includes("spans a line break")),
    );
    expect(
      "an absolute profit promise is caught",
      () => writeFileSync(join(tmp, "web", "prose.tsx"), "This is free money and you can't lose.\n"),
      (e) => e.some((x) => x.includes("free money")) && e.some((x) => x.includes("can't lose")),
    );
    expect(
      "copy-lint-allow escapes a negation",
      () => writeFileSync(join(tmp, "web", "prose.tsx"), "we do not publish an APY // copy-lint-allow\n"),
      (e) => e.length === 0,
    );
    expect(
      "a missing required disclosure is caught",
      () => writeFileSync(join(tmp, "web", "app", "legacy", "vault", "nvda", "page.tsx"), "nothing disclosed here\n"),
      (e) => e.some((x) => x.includes("missing required disclosure")),
    );
    expect(
      "a required disclosure may itself wrap lines",
      () =>
        writeFileSync(
          join(tmp, "web", "app", "legal", "page.tsx"),
          "not available to\n  US persons\nRobinhood Assets\n (Jersey) Limited\n",
        ),
      (e) => !e.some((x) => x.includes("missing required disclosure")),
    );
    expect(
      "a vanished package is a hard failure",
      () => rmSync(join(tmp, "web"), {recursive: true, force: true}),
      (e) => e.some((x) => x.includes("MISSING")),
    );
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
  console.log(`copy-lint self-test OK — ${ran} cases`);
}

selfTest();

const {errors, counts} = lintPackages(PACKAGES, REQUIRED);
const tally = PACKAGES.map(({name}) => `${counts.get(name)} files in ${name}`).join(", ");

if (errors.length) {
  console.error(`\ncopy-lint FAILED — ${errors.length} violation(s) across ${tally}:\n`);
  for (const e of errors) console.error("  " + e);
  console.error("\nThese are compliance rules from README 'Frontend copy' and TECHSPEC 7.3.");
  console.error("web/ (app.stonkhouse.fun, the dapp) is scanned and is not exempt. The landing,");
  console.error("stonkhouse.fun, is linted by the same rules in stonkhousedotfun/callhouse-site.");
  console.error("If a hit is inside an explicit negation, add a `copy-lint-allow` comment on that line.\n");
  process.exit(1);
}

console.log(`copy-lint OK — ${tally}, 0 violations.`);
