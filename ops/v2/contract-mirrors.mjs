#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * The guard for app copies of contract numbers.
 *
 * The app copies contract numbers (cooldowns, ceilings, bounties, windows, bps). A copy is right only while the
 * contract cannot change the number. Since v8 several compiled constants became on-chain settings, and a keeper
 * or monitor holding the old copy does not fail on the day the owner changes the setting: it sends transactions
 * that revert, or raises false alarms, or misses real ones.
 *
 * Three inputs, none of them the app code being checked:
 *   1. ops/abis/v2/roles.json            the roles manifest copy this repo ships (contracts export-abis.sh).
 *   2. ops/v2/contract-mirrors.fixture.json  regenerated from a contracts checkout by THIS file (--regen): every
 *      numeric/bool `constant` under src/v2 with its evaluated value, plus the restricted selectors of
 *      script/v2/roles.v8.json at that checkout's SHA.
 *   3. ops/v2/contract-mirrors.list.mjs  the declared list of mirrors (name, file, contract, member, kind).
 *
 * The check (checkMirrors) fails by name when:
 *   - a declared COMPILED or PENDING mirror's member has a restricted setter in either manifest (1 or 2), or is no
 *     longer a compiled constant in the fixture;
 *   - a declared mirror's symbol is gone from its file (a stale declaration hides nothing);
 *   - a declared COMPILED mirror's literal value differs from the contract's value, or either value does not evaluate
 *     (a value the guard cannot compare is a problem, not a skip; compareValue: false needs a reason);
 *   - a declaration carries `fixtureMember` (the flag skipped the fixture check; regenerate instead);
 *   - the scanner finds a mirror in app code that is not declared (a name equal to a contract constant, or a
 *     comment citing `Contract.MEMBER` on or just above the declaration).
 *
 *   node ops/v2/contract-mirrors.mjs --regen <contracts-dir> [--sha S]   rewrite the fixture from a contracts checkout
 *   node ops/v2/contract-mirrors.mjs --check <contracts-dir> [--sha S]   exit 1 when the fixture is stale for it
 *   (--sha names the commit when <contracts-dir> is a `git archive` export with no .git)
 *   node ops/v2/contract-mirrors.mjs                           run the guard, one problem per line, exit 1 on any
 * ------------------------------------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const FIXTURE = path.join(HERE, "contract-mirrors.fixture.json");
export const ROLES_COPY = path.join(REPO, "ops", "abis", "v2", "roles.json");

/* ---------------------------------------------------------------- Solidity constant extraction */

const TIME_UNITS = { seconds: 1n, minutes: 60n, hours: 3_600n, days: 86_400n, weeks: 604_800n };

/**
 * Evaluate a Solidity/JS integer expression to a BigInt, or null. Numbers (with `_`, `e` exponents and a
 * trailing `n`), Solidity time units, + - * / **, parentheses, casts like uint256(x), and names looked up in
 * `env`. Anything else (keccak256, addresses, strings) is null: callers must report or explicitly justify an
 * incomparable value; it is never guessed.
 */
export function evalInt(expr, env = {}) {
  const src = String(expr)
    .trim()
    .replace(/\btype\(uint(\d+)\)\.max\b/g, (_, b) => (2n ** BigInt(b) - 1n).toString())
    .replace(/\btype\(int(\d+)\)\.max\b/g, (_, b) => (2n ** (BigInt(b) - 1n) - 1n).toString())
    .replace(/\b0x[0-9a-fA-F]+\b/g, (h) => BigInt(h).toString());
  const toks = src.match(/\d[\d_]*(?:\.\d+)?(?:e\d+)?n?|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\*\*|[-+*/()]|\S/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  function primary() {
    const t = take();
    if (t === undefined) throw new Error("end");
    if (t === "(") {
      const v = sum();
      if (take() !== ")") throw new Error(")");
      return v;
    }
    if (t === "-") return -primary();
    if (/^\d/.test(t)) {
      const m = t.replace(/_/g, "").replace(/n$/, "").match(/^(\d+)(?:\.(\d+))?(?:e(\d+))?$/);
      if (!m) throw new Error(`num ${t}`);
      const [, whole, frac = "", exp = "0"] = m;
      const e = BigInt(exp) - BigInt(frac.length);
      if (e < 0n) throw new Error("fraction");
      let v = BigInt(whole + frac) * 10n ** e;
      if (TIME_UNITS[peek()]) v *= TIME_UNITS[take()];
      return v;
    }
    if (/^(u?int\d*)$/.test(t) && peek() === "(") {
      take();
      const v = sum();
      if (take() !== ")") throw new Error(")");
      return v;
    }
    if (/^[A-Za-z_]/.test(t)) {
      if (typeof env[t] === "bigint") {
        let v = env[t];
        if (TIME_UNITS[peek()]) v *= TIME_UNITS[take()];
        return v;
      }
      throw new Error(`name ${t}`);
    }
    throw new Error(`token ${t}`);
  }
  function power() {
    const b = primary();
    if (peek() === "**") {
      take();
      return b ** power();
    }
    return b;
  }
  function product() {
    let v = power();
    while (peek() === "*" || peek() === "/") v = take() === "*" ? v * power() : v / power();
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + product() : v - product();
    return v;
  }
  try {
    const v = sum();
    return i === toks.length ? v : null;
  } catch {
    return null;
  }
}

function stripSolComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Every numeric/bool `constant` in one Solidity source: { contract, name, type, visibility, expr, line }. */
export function solidityConstants(text) {
  const src = stripSolComments(text);
  const heads = [...src.matchAll(/^\s*(?:abstract\s+)?(?:contract|library|interface)\s+(\w+)/gm)].map((m) => ({ at: m.index, name: m[1] }));
  const out = [];
  const re = /\b((?:u?int\d*)|bool)\s+(?:(public|internal|private)\s+)?constant\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g;
  for (const m of src.matchAll(re)) {
    const owner = heads.filter((h) => h.at <= m.index).pop();
    out.push({
      contract: owner ? owner.name : null,
      name: m[3],
      type: m[1],
      visibility: m[2] ?? "internal",
      expr: m[4].replace(/\s+/g, " ").trim(),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

function walk(dir, keep, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, acc);
    else if (keep(p)) acc.push(p);
  }
  return acc;
}

/** Build the fixture object from a contracts checkout (a git worktree or a `git archive` export). */
export function buildFixture(contractsDir, sha = null) {
  const srcDir = path.join(contractsDir, "src", "v2");
  const files = walk(srcDir, (p) => p.endsWith(".sol") && !p.includes(`${path.sep}mocks${path.sep}`)).sort();
  const constants = [];
  for (const f of files) {
    const rel = path.relative(contractsDir, f).split(path.sep).join("/");
    for (const c of solidityConstants(readFileSync(f, "utf8"))) constants.push({ ...c, file: rel });
  }
  // Values: evaluate with the file's own constants and V2Constants in scope (several constants derive from others).
  const byName = {};
  const qualified = {};
  for (let pass = 0; pass < 4; pass++) {
    for (const c of constants) {
      if (c.type === "bool") continue;
      const env = { ...qualified, ...byName.V2Constants, ...byName[c.contract] };
      const v = evalInt(c.expr, env);
      if (v !== null) {
        (byName[c.contract] ??= {})[c.name] = v;
        qualified[`${c.contract}.${c.name}`] = v;
        c.value = v.toString();
      }
    }
  }
  for (const c of constants) if (c.type === "bool") c.value = c.expr;
  const roles = JSON.parse(readFileSync(path.join(contractsDir, "script", "v2", "roles.v8.json"), "utf8"));
  const setters = {};
  for (const [target, sel] of Object.entries(roles.targets ?? {})) setters[target] = Object.keys(sel).sort();
  let at = sha;
  if (!at) {
    try {
      at = execFileSync("git", ["-C", contractsDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      at = null;
    }
  }
  return {
    // The generator's PATH comes first after "GENERATED by": ops/v2/post-broadcast-regen.mjs reads that token as the
    // script that owns this file and refuses one that does not exist. The old header led with `node`, the
    // interpreter, and every post-broadcast-regen run refused before doing anything.
    _comment:
      "GENERATED by ops/v2/contract-mirrors.mjs (run: node ops/v2/contract-mirrors.mjs --regen <contracts-dir>). Do not hand-edit: every numeric/bool constant under src/v2 (mocks excluded) and the restricted selectors of script/v2/roles.v8.json at contractsSha.",
    contractsSha: at,
    constants: constants.map(({ contract, name, type, visibility, expr, value = null, file, line }) => ({ contract, name, type, visibility, expr, value, file, line })),
    setters,
  };
}

/* ---------------------------------------------------------------- app scanner */

/** Directories of app code that may hold a mirror. Tests, generated ABIs and fixtures are not runtime code. */
export const SCAN_ROOTS = ["keeper/src", "keeper/scripts", "ops", "indexer/src", "indexer/lib", "indexer/scripts", "web/lib", "web/components", "web/app", "relay/src", "notifier/src"];
const SCAN_EXT = /\.(?:m?js|ts|tsx|py)$/;
const SCAN_SKIP = /(?:^|\/)(?:node_modules|abis?|fixtures|dist|build|\.next|__pycache__|\.venv|archive)(?:\/|$)|\.test\.|\.spec\.|\.generated\.|(?:^|\/)tests?\/|_test\.py$|(?:^|\/)test_[^/]*\.py$|contract-mirrors/;

export function scanFiles(repo = REPO) {
  const out = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(repo, root);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const f of walk(abs, (p) => SCAN_EXT.test(p))) {
      const rel = path.relative(repo, f).split(path.sep).join("/");
      if (!SCAN_SKIP.test(rel) && !rel.startsWith("ops/v2/contract-mirrors")) out.push(rel);
    }
  }
  return out.sort();
}

const DECL_JS = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(.*)$/;
const DECL_PY = /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(.*)$/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

/**
 * The line that assigns `symbol` in `text`: its const/let/var declaration first (or a module-level assignment for
 * Python), else the first non-comment code line assigning it. Comment and doc lines are never the answer.
 * Taking the first line with `SYMBOL =` read a doc comment ("PRICE_TICK = 100, fee ceilings of") above four
 * declarations, whose value then did not evaluate and was silently not compared.
 */
export function declarationLine(text, symbol, file = "") {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const jsDecl = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=(?!=)`);
  const pyDecl = new RegExp(`^${esc}\\s*(?::[^=]+)?=(?!=)`);
  const assignment = new RegExp(`\\b${esc}\\s*(?::[^=]+)?=(?!=)`);
  const lines = text.split("\n");
  const python = file.endsWith(".py");
  const declaration = python ? (line) => pyDecl.test(line) : (line) => jsDecl.test(line);
  return lines.find(declaration) ?? lines.find((line) => !COMMENT_LINE.test(line) && assignment.test(line) && (python || !pyDecl.test(line)));
}
/** Unit suffixes and prefixes an app name may add to the contract's name. */
const NAME_SUFFIX = /_(?:S|MS|SEC|SECS|SECONDS|BPS|PPM|USDG|USDG6|E6|WEI|N)$/;
const NAME_PREFIX = /^(?:V2_|DEFAULT_)/;

export function normalizeName(n) {
  let s = n.replace(NAME_PREFIX, "");
  while (NAME_SUFFIX.test(s)) s = s.replace(NAME_SUFFIX, "");
  return s;
}

/**
 * The contract names an app declaration `n` may copy, most specific first: `n` itself, `n` with only its
 * V2_ prefix and unit suffixes dropped (so `DEFAULT_MAX_STALE_S` is ChainlinkFeedSource.DEFAULT_MAX_STALE: stripping
 * DEFAULT_ as well hid it), then {normalizeName} (an app DEFAULT_X copying a contract X).
 */
export function nameCandidates(n) {
  let bare = n.replace(/^V2_/, "");
  while (NAME_SUFFIX.test(bare)) bare = bare.replace(NAME_SUFFIX, "");
  return [...new Set([n, bare, normalizeName(n)])];
}

/** Declarations with a literal-looking right-hand side (numbers, bigint, bool, arithmetic of those). */
function literalRhs(rhs) {
  const r = rhs.replace(/\/\/.*$|#.*$/, "").replace(/[;,]\s*$/, "").trim();
  return /^[-+*/()\s\d_.en]*$/.test(r) && /\d/.test(r) ? r : /^(?:true|false|True|False)$/.test(r) ? r : null;
}

/**
 * Find mirrors in app code: { file, line, symbol, rhs, member: "Contract.NAME" | null, how }.
 * A declaration is a mirror when its (normalized) name equals a contract constant's name, or when a comment on its
 * line or in the comment block directly above it cites `Contract.NAME` (or `Contract.sol ... NAME`) of a known constant.
 */
export function findMirrors({ repo = REPO, files = scanFiles(repo), fixture, read = (f) => readFileSync(path.join(repo, f), "utf8") }) {
  const names = new Map();
  // A contract DEFAULT_X is also matched by an app copy named for X (`UNCORROBORATED_DELAY_S` copies
  // SettlementOracle.DEFAULT_UNCORROBORATED_DELAY). Only the prefix is dropped on the contract side: dropping its unit
  // suffix too would take MIN_ASK_BPS for any MIN_ASK.
  const defaults = new Map();
  for (const c of fixture.constants) {
    if (!names.has(c.name)) names.set(c.name, []);
    names.get(c.name).push(c);
    if (!c.name.startsWith("DEFAULT_")) continue;
    const bare = c.name.slice("DEFAULT_".length);
    if (!defaults.has(bare)) defaults.set(bare, []);
    defaults.get(bare).push(c);
  }
  const contracts = new Set(fixture.constants.map((c) => c.contract).filter(Boolean));
  const cite = new RegExp(`\\b(${[...contracts].join("|")})(?:\\.sol)?(?::\\d+)?[.:\\s\`'"(]+([A-Z][A-Z0-9_]{2,})\\b`, "g");
  const hits = [];
  for (const file of files) {
    const lines = read(file).split("\n");
    const decl = file.endsWith(".py") ? DECL_PY : DECL_JS;
    lines.forEach((ln, i) => {
      const m = ln.match(decl);
      if (!m) return;
      const [, symbol, rhsRaw] = m;
      const rhs = literalRhs(rhsRaw);
      if (rhs === null) return;
      const direct = nameCandidates(symbol).map((n) => names.get(n)).find(Boolean) ?? defaults.get(normalizeName(symbol));
      if (direct) {
        hits.push({ file, line: i + 1, symbol, rhs, member: direct.map((c) => `${c.contract}.${c.name}`).join("|"), how: "name" });
        return;
      }
      // The declaration's own line plus the comment block directly above it (contiguous comment lines, at most six),
      // so a citation belongs to the declaration it documents and not to its neighbour.
      const above = [];
      for (let j = i - 1; j >= 0 && j >= i - 6 && /^\s*(?:\/\/|\/\*|\*|#)|\*\/\s*$/.test(lines[j]); j--) above.unshift(lines[j]);
      const ctx = [...above, ln].join("\n");
      for (const c of ctx.matchAll(cite)) {
        const k = names.get(c[2]);
        if (k && k.some((x) => x.contract === c[1] || c[1] === "V2Constants")) {
          hits.push({ file, line: i + 1, symbol, rhs, member: `${c[1]}.${c[2]}`, how: "cite" });
          return;
        }
      }
    });
  }
  return hits;
}

/* ---------------------------------------------------------------- the check */

function camel(member) {
  return member.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
/**
 * Setters that would make `member` settable: the declared ones (`Contract.setX`, or a bare `setX` meaning any
 * target) plus `set<Member>` in camel case on any target. Struct setters (`setLimits`) exist on several contracts, so
 * a declared one names its target.
 */
export function settersFor(entry) {
  const derived = `set${camel(entry.member).replace(/^./, (c) => c.toUpperCase())}`;
  const declared = (entry.setters ?? []).map((s) => {
    const [target, name] = s.includes(".") ? s.split(".") : [null, s];
    return { target, name };
  });
  // The derived name is searched everywhere unless a declared setter already names it (one finding, not two).
  return declared.some((d) => d.name === derived) ? declared : [...declared, { target: null, name: derived }];
}

function manifestSetters(manifest) {
  const out = {};
  for (const [target, sel] of Object.entries(manifest.targets ?? manifest.setters ?? {})) {
    out[target] = Array.isArray(sel) ? sel : Object.keys(sel);
  }
  return out;
}

/**
 * The guard. `mirrors`: the declared list. `manifests`: { name: roles-shaped object } (targets or setters).
 * `fixture`: generated constants. `found`: findMirrors output. `read(file)`: app source.
 * Returns problems, each starting with the mirror's name so a red run names what went wrong.
 */
export function checkMirrors({ mirrors, manifests, fixture, found, read, notMirrors = [] }) {
  const problems = [];
  const constants = new Map(fixture.constants.map((c) => [`${c.contract}.${c.name}`, c]));
  const setterMaps = Object.entries(manifests).map(([name, m]) => [name, manifestSetters(m)]);
  const declared = new Set();
  const ids = new Set();
  for (const e of mirrors) {
    const head = `${e.name} (${e.contract}.${e.member})`;
    if (ids.has(e.name)) problems.push(`${e.name}: declared twice`);
    ids.add(e.name);
    if (!["compiled", "live", "pending"].includes(e.kind)) problems.push(`${head}: unknown kind ${e.kind}`);
    if (e.kind === "pending" && !e.row) problems.push(`${head}: a PENDING mirror names the row that makes it live`);
    if (!Array.isArray(e.sites) || e.sites.length === 0) problems.push(`${head}: no sites`);
    // COMPILED and PENDING: the member must still be unsettable. Searched across EVERY target: a V2Constants value
    // becomes settable on whichever contract stores it.
    if (e.kind !== "live") {
      for (const [mname, map] of setterMaps) {
        for (const [target, sigs] of Object.entries(map)) {
          for (const st of settersFor(e)) {
            if (st.target && st.target !== target) continue;
            const hit = sigs.find((sig) => sig.startsWith(`${st.name}(`));
            if (hit) {
              const why = e.kind === "pending" ? `KNOWN-PENDING-${e.row}: ${e.row} must now make the app read it live` : "the app must read it live";
              problems.push(`${head}: ${target}.${hit} is a restricted setter in ${mname}, so ${e.member} is SETTABLE; ${why} at ${e.sites.map((x) => `${x.file} ${x.symbol}`).join(", ")}`);
            }
          }
        }
      }
    }
    const c = constants.get(`${e.contract}.${e.member}`);
    // `fixtureMember: false` used to skip this check, so a mirror of a member the fixture did not carry was
    // never compared and deleting its declaration stayed green. A mirror the guard cannot check fails instead: the
    // fix is a --regen from a contracts tree that has the member, never a flag.
    if (e.fixtureMember !== undefined) {
      problems.push(`${head}: fixtureMember is not accepted (it skipped the check); --regen the fixture from a contracts tree that has ${e.contract}.${e.member}`);
    }
    if (e.kind !== "live" && !c) {
      const why = e.kind === "pending" ? ` (KNOWN-PENDING-${e.row})` : "";
      problems.push(`${head}: not a compiled constant at contracts ${fixture.contractsSha}${why}; it may have become a setting`);
    }
    for (const site of e.sites ?? []) {
      const tag = `${e.name} (${site.file} ${site.symbol} -> ${e.contract}.${e.member})`;
      declared.add(`${site.file}::${site.symbol}`);
      let text = null;
      try {
        text = read(site.file);
      } catch {
        problems.push(`${tag}: file is gone; remove or move the declaration`);
        continue;
      }
      const esc = site.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`\\b${esc}\\b`).test(text)) {
        problems.push(`${tag}: symbol not found in the file; the declaration is stale`);
        continue;
      }
      if (e.kind !== "compiled" || !c) continue;
      // A value that cannot be compared is a problem by name, never a silent skip. compareValue: false is
      // an opt-out only with a written reason.
      if (site.compareValue === false) {
        if (!site.reason) problems.push(`${tag}: compareValue false without a reason; the value is not compared`);
        continue;
      }
      if (c.value === null) {
        problems.push(`${tag}: value cannot be compared: ${e.contract}.${e.member} = ${c.expr} does not evaluate; set compareValue: false with a reason`);
        continue;
      }
      const line = declarationLine(text, site.symbol, site.file);
      const rhs = line ? line.split("=").slice(1).join("=").replace(/\/\/.*$|#.*$/, "").replace(/[;,]\s*$/, "").trim() : null;
      const app = rhs === null ? null : /^(?:true|false|True|False)$/.test(rhs) ? rhs.toLowerCase() : evalInt(rhs);
      if (app === null) {
        problems.push(`${tag}: value cannot be compared: ${line ? `the declaration's value "${rhs}" does not evaluate` : "no declaration line assigns it"}`);
        continue;
      }
      const want = c.type === "bool" ? c.value : BigInt(c.value) * BigInt(site.scale ?? 1);
      if (String(app) !== String(want)) {
        problems.push(`${tag}: app value ${app} but ${e.contract}.${e.member} = ${c.expr} (${c.value}) at contracts ${fixture.contractsSha}`);
      }
    }
  }
  const ignored = new Set(notMirrors.map((n) => `${n.file}::${n.symbol}`));
  for (const h of found) {
    const k = `${h.file}::${h.symbol}`;
    if (!declared.has(k) && !ignored.has(k)) {
      problems.push(`UNDECLARED ${h.symbol} (${h.file}:${h.line} = ${h.rhs}) looks like a copy of ${h.member} (${h.how}); declare it in ops/v2/contract-mirrors.list.mjs or list it under NOT_MIRRORS with a reason`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- CLI */

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

export function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

export async function runGuard() {
  const { MIRRORS, NOT_MIRRORS } = await import("./contract-mirrors.list.mjs");
  const fixture = loadFixture();
  const manifests = { "ops/abis/v2/roles.json": JSON.parse(readFileSync(ROLES_COPY, "utf8")), "ops/v2/contract-mirrors.fixture.json": fixture };
  const read = (f) => readFileSync(path.join(REPO, f), "utf8");
  const found = findMirrors({ fixture });
  return checkMirrors({ mirrors: MIRRORS, notMirrors: NOT_MIRRORS, manifests, fixture, found, read });
}

const isMain = process.argv[1] && String(process.argv[1]).endsWith("contract-mirrors.mjs");
if (isMain) {
  const regen = arg("--regen");
  const check = arg("--check");
  if (regen || check) {
    const fresh = JSON.stringify(buildFixture(path.resolve(regen ?? check), arg("--sha")), null, 2) + "\n";
    if (regen) {
      writeFileSync(FIXTURE, fresh);
      process.stdout.write(`wrote ${path.relative(REPO, FIXTURE)}\n`);
    } else if (!existsSync(FIXTURE) || readFileSync(FIXTURE, "utf8") !== fresh) {
      process.stderr.write(`${path.relative(REPO, FIXTURE)} is stale for ${check}; rerun with --regen\n`);
      process.exit(1);
    } else process.stdout.write("fixture up to date\n");
  } else {
    const problems = await runGuard();
    for (const p of problems) process.stderr.write(`${p}\n`);
    process.stdout.write(`${problems.length} problem(s)\n`);
    process.exit(problems.length ? 1 : 0);
  }
}
