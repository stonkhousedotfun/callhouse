/**
 * ops/v8/verify-gates.mjs — the launch-verification runner (O8-13A).
 *
 *   node ops/v8/verify-gates.mjs --dry-run --repo contracts=<path> --repo app=<path> \
 *                                --repo site=<path> --repo docs=<path>
 *   node ops/v8/verify-gates.mjs --repo … --fork-url <url> --fork-block-number <n>   # O8-13 proper
 *
 * WHY IT REFUSES. v8-plan/06-QUIRKS section A catalogues checks on this build that PASS WITHOUT
 * CHECKING: a fork suite with no --fork-url self-returns at `if (block.chainid != 4663) return;`, the
 * site's check-twins prints "skipped" and exits 0 with no CALLHOUSE_WEB_DIR, the docs copy-lint skips
 * its parity block and still prints "docs copy OK", render-docs --check with no --docs-dir checks
 * nothing. A runner that recorded those as PASS — or as a benign "skipped" — would reproduce inside
 * the tool the exact failure the tool exists to end. So an unmet precondition is a REFUSAL: a named
 * reason and a non-zero exit, reported apart from PASSED and from FAILED.
 *
 * COUNTS ARE MEASURED, NEVER ASSERTED. 01-CONTEXT's quoted numbers (1,608 tests, 44 fork tests, 80
 * refusal cases) are already stale — it says the fork gate is 7 suites while 12 fork suite files
 * exist. The catalog carries a parse rule, not an expected value, and the report records what ran.
 *
 * --dry-run resolves every gate's script or binary against the bound worktrees and executes nothing,
 * which is why it is safe under build mode and makes no network call.
 *
 * Tests: node --test ops/v8/verify-gates.test.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GATES = path.join(HERE, "gates.json");
const GIT = existsSync("/opt/homebrew/bin/git") ? "/opt/homebrew/bin/git" : "git";
export const REPOS = ["contracts", "app", "site", "docs"];

/** The --repo NAME=PATH parser, the shape scripts/release-preflight.mjs:22-33 already uses. */
export function parseArgs(argv) {
  const out = { repos: new Map(), dryRun: false, gates: DEFAULT_GATES, forkUrl: null, forkBlock: null,
    ledger: null, report: null, legalBaseline: null, help: false };
  const fail = (m) => { throw new Error(m); };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    if (arg === "--repo") {
      const binding = value();
      const sep = binding.indexOf("=");
      if (sep < 1 || sep === binding.length - 1) fail(`invalid --repo binding: ${binding}`);
      const name = binding.slice(0, sep);
      if (!REPOS.includes(name)) fail(`unknown repository: ${name} (expected one of ${REPOS.join(", ")})`);
      if (out.repos.has(name)) fail(`duplicate --repo binding: ${name}`);
      out.repos.set(name, path.resolve(binding.slice(sep + 1)));
    } else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--gates") out.gates = path.resolve(value());
    else if (arg === "--fork-url") out.forkUrl = value();
    else if (arg === "--fork-block-number") out.forkBlock = value();
    // The three OWN8-10/11/12 bindings. The ledger and the verification report live OUTSIDE every
    // repo worktree, so they are paths, not repo-relative names; the legal baseline is a git ref
    // resolved inside the bound site worktree.
    else if (arg === "--ledger") out.ledger = path.resolve(value());
    else if (arg === "--report") out.report = path.resolve(value());
    else if (arg === "--legal-baseline") out.legalBaseline = value();
    else if (arg === "--help" || arg === "-h") out.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return out;
}

const sameDir = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/** HEAD and cleanliness of a bound worktree; `null` when git cannot say, never a silent pass. */
export function repoState(dir) {
  const run = (args) => execFileSync(GIT, ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    return { dir, head: run(["rev-parse", "HEAD"]), dirty: run(["status", "--porcelain"]) !== "" };
  } catch (error) {
    return { dir, head: null, dirty: null, error: String(error.message ?? error).split("\n")[0] };
  }
}

/**
 * Why this gate may not run, or null. Every reason is a property of a script at its pinned SHA, read
 * rather than assumed; the comments name the line.
 */
export function refusalFor(gate, ctx) {
  const repo = ctx.repos.get(gate.repo);
  if (repo === undefined) return `no --repo ${gate.repo}=PATH binding`;
  const state = ctx.state.get(gate.repo);
  if (state?.head === null) return `cannot read ${gate.repo} HEAD: ${state.error}`;
  if (state?.dirty) return `${gate.repo} worktree is dirty: a PASS from an uncommitted tree names no SHA`;
  for (const pre of gate.preconditions ?? []) {
    switch (pre) {
      case "fork-url":
        // test/v2/fork/*.t.sol self-return at `if (block.chainid != 4663) return;` without a fork.
        if (!ctx.forkUrl) return "--fork-url is required: without it the fork suites pass having asserted nothing";
        break;
      case "fork-block-number":
        // 06-QUIRKS A2: the public RPC keeps ~15 minutes of history, so the block is fresh, not pinned.
        if (!ctx.forkBlock) return "--fork-block-number is required and must be recorded: an unrecorded fork block is an unreproducible run";
        break;
      case "app-binding":
        if (!ctx.repos.has("app")) return "needs the app worktree (--repo app=PATH)";
        break;
      case "docs-binding":
        // render-docs --check without --docs-dir equal to the bound docs worktree checks nothing.
        if (!ctx.repos.has("docs")) return "needs the docs worktree (--repo docs=PATH) as --docs-dir";
        break;
      case "app-web-binding": {
        // check-twins.mjs:22-23 prints "sibling web v2 source or registry is absent; skipped" and exits 0.
        const app = ctx.repos.get("app");
        if (!app) return "needs the app worktree to set CALLHOUSE_WEB_DIR";
        const want = path.join(app, "web");
        if (!ctx.env.CALLHOUSE_WEB_DIR) return `CALLHOUSE_WEB_DIR is unset: check-twins exits 0 by skipping. Set it to ${want}`;
        if (!sameDir(ctx.env.CALLHOUSE_WEB_DIR, want)) {
          return `CALLHOUSE_WEB_DIR is ${ctx.env.CALLHOUSE_WEB_DIR}, not the bound app worktree's web/ (${want})`;
        }
        break;
      }
      case "app-sibling": {
        // copy-lint-docs.mjs:53 appCandidates are ../callhouse and ../../callhouse from the docs root.
        const app = ctx.repos.get("app");
        const docs = ctx.repos.get("docs");
        if (!app || !docs) return "needs both the docs and app worktrees: the parity block is skipped without a sibling app";
        const candidates = [path.resolve(docs, "../callhouse"), path.resolve(docs, "../../callhouse")];
        if (!candidates.some((c) => sameDir(c, app))) {
          return `no appCandidate of ${docs} resolves to the bound app worktree, so copy-lint-docs skips its parity block and still prints "docs copy OK"`;
        }
        break;
      }
      case "registry-copy":
        if (!ctx.repos.has("app")) return "needs a registry copy from the app worktree";
        break;
      case "out-built":
        if (!existsSync(path.join(repo, "out"))) return "contracts out/ is not built: run the build gate first";
        break;
      case "cast":
        if (!ctx.which("cast")) return "foundry `cast` is not on PATH";
        break;
      case "rpc":
        if (!ctx.forkUrl && !process.env.RH_RPC) return "needs an RPC: pass --fork-url or set RH_RPC, and record which";
        break;
      case "devnet-up":
        return "needs ops/devnet/up.sh running: start it and re-run this gate alone";
      case "site-binding":
        if (!ctx.repos.has("site")) return "needs the site worktree (--repo site=PATH): the legal pages and lib/legal.ts are read from it";
        break;
      case "contracts-binding":
        if (!ctx.repos.has("contracts")) return "needs the contracts worktree (--repo contracts=PATH): the packet's sources and docs are read from it";
        break;
      case "legal-baseline": {
        // There is no safe default for "the state being approved FROM". A guessed ref diffs the
        // wrong pair of trees and still prints a clean-looking per-page table.
        if (!ctx.legalBaseline) return "--legal-baseline <git ref> is required: without the approved-from state the diff has no meaning, and a default would silently diff the wrong thing";
        const site = ctx.repos.get("site");
        if (!site) break; // already refused by site-binding
        try {
          execFileSync(GIT, ["-C", site, "rev-parse", "--verify", `${ctx.legalBaseline}^{commit}`], { stdio: "ignore" });
        } catch {
          return `--legal-baseline ${ctx.legalBaseline} does not resolve to a commit in the bound site worktree`;
        }
        break;
      }
      case "ledger-path":
        if (!ctx.ledger) return "--ledger <DEFERRED-VERIFICATION.md> is required: the ledger is in no repo worktree, so nothing resolves it for you";
        if (!existsSync(ctx.ledger)) return `--ledger ${ctx.ledger} does not exist`;
        break;
      case "verification-report":
        // Expected to refuse today: O8-13 writes this file only after OWN8-11 reopens verification.
        if (!ctx.report) return "--report <status/VERIFICATION-REPORT.md> is required: the audit packet is assembled around it";
        if (!existsSync(ctx.report)) return `--report ${ctx.report} does not exist: O8-13 writes the verification report once OWN8-11 reopens verification, so this refusal is the expected state before that`;
        break;
      default:
        return `unknown precondition ${JSON.stringify(pre)} in the catalog`;
    }
  }
  return null;
}

/** Where the gate's script or binary lives, or null when it is a PATH binary. */
export function resolveTarget(gate, repoDir) {
  const [head, next] = gate.argv;
  const candidate = head === "node" || head === "pnpm" ? next : head;
  if (!candidate || candidate.startsWith("--") || candidate.startsWith("<")) return { kind: "binary", name: head };
  if (candidate.includes("/")) {
    const abs = path.resolve(repoDir, candidate);
    return { kind: "file", path: abs, exists: existsSync(abs) };
  }
  return { kind: "binary", name: head };
}

export function plan(catalog, ctx) {
  const rows = [];
  for (const gate of catalog.gates) {
    const repoDir = ctx.repos.get(gate.repo);
    const refusal = refusalFor(gate, ctx);
    const target = repoDir ? resolveTarget(gate, repoDir) : null;
    const missing = target?.kind === "file" && !target.exists ? `${gate.argv.join(" ")}: ${target.path} does not exist` : null;
    rows.push({ id: gate.id, repo: gate.repo, inCi: gate.inCi, status: refusal || missing ? "REFUSED" : "READY",
      reason: refusal ?? missing ?? null, target });
  }
  return rows;
}

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (error) { console.error(String(error.message)); process.exit(2); }
  if (args.help) {
    process.stdout.write("usage: node ops/v8/verify-gates.mjs --dry-run --repo contracts=PATH --repo app=PATH --repo site=PATH --repo docs=PATH [--fork-url URL --fork-block-number N] [--ledger PATH] [--report PATH] [--legal-baseline REF] [--gates FILE]\n");
    process.exit(0);
  }
  const catalog = JSON.parse(readFileSync(args.gates, "utf8"));
  const state = new Map();
  for (const [name, dir] of args.repos) state.set(name, repoState(dir));
  const ctx = {
    repos: args.repos, state, forkUrl: args.forkUrl, forkBlock: args.forkBlock, env: process.env,
    ledger: args.ledger, report: args.report, legalBaseline: args.legalBaseline,
    which: (bin) => { try { execFileSync("command", ["-v", bin], { shell: true, stdio: "ignore" }); return true; } catch { return false; } },
  };
  for (const [name, s] of state) {
    console.log(`${name.padEnd(9)} ${s.head ?? "HEAD UNREADABLE"} ${s.dirty ? "DIRTY" : s.dirty === null ? "" : "clean"}  ${s.dir}`);
  }
  const rows = plan(catalog, ctx);
  const refused = rows.filter((r) => r.status === "REFUSED");
  const ready = rows.filter((r) => r.status === "READY");
  console.log(`\n${catalog.gates.length} gates in the catalog: ${ready.length} ready, ${refused.length} refused`);
  for (const r of refused) console.log(`  REFUSED ${r.id}: ${r.reason}`);
  if (!args.dryRun) {
    console.error("\nrefusing to RUN gates: O8-13 proper is blocked on OWN8-11 (the owner reopening verification).");
    console.error("This tool plans and refuses today; pass --dry-run to record the plan.");
    process.exit(2);
  }
  const unresolved = rows.filter((r) => r.target?.kind === "file" && !r.target.exists);
  if (unresolved.length > 0) {
    for (const r of unresolved) console.error(`  UNRESOLVED ${r.id}: ${r.reason}`);
    console.error(`\n${unresolved.length} catalog entr(ies) name a script that does not exist at the bound SHAs.`);
    process.exit(1);
  }
  console.log("\n--dry-run: every catalog entry resolves to a path that exists; no gate was executed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
