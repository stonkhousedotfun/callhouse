/**
 * node --test ops/shell-pipefail-grep.test.mjs
 *
 * No ops shell script pipes into an early-exiting grep under pipefail.
 *
 * `producer | grep -q x` stops reading at the first match. If the producer still has output to write,
 * it takes SIGPIPE (rc 141), and under `set -o pipefail` the pipeline's status is that 141, so a MATCH
 * reads as a MISS. Measured on this box (bash 3.2.57, BSD grep 2.6.0) with the match on line 1:
 * 0/200 false misses at 15 KB, 12/200 at 62 KB, 200/200 at 288 KB; and 5/100 at only 920 bytes for
 * `railway environment edit --help`, which writes its help line by line. go-live-v2.sh refused a
 * valid service intermittently for exactly this reason.
 *
 * Two layers:
 *   1. a static guard over every tracked ops/ and scripts/ shell file that turns pipefail on, with its
 *      own positive control (the detector is run on known-bad lines and must flag each one);
 *   2. the 300k-line control on the real helper definitions, extracted from the scripts: the fixed
 *      shape must HIT, a missing name must MISS, and the old pipe shape (typed here as the control)
 *      must MISS on the same input — so the input is proven big enough to trigger the failure.
 *
 * Runs bash with stubs only. No Railway, no RPC, no keys.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const OPS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(OPS, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ------------------------------------------------------------------------------------------------
// 1. Static guard
// ------------------------------------------------------------------------------------------------

/**
 * A pipe (not `||`) into grep whose options make it stop before EOF: -q/--quiet/--silent, -m/--max-count,
 * or stdout sent to /dev/null (`grep -x >/dev/null` reads to EOF on BSD grep; GNU grep is
 * documented to stop at the first match when its output is /dev/null — not measured here, no GNU grep
 * on this box — so that shape is refused too).
 */
const PIPE_GREP = /(?<!\|)\|(?!\|)\s*grep\b([^|]*)/g;
const EARLY_EXIT = /(^|\s)-[A-Za-z]*[qm]|--quiet\b|--silent\b|--max-count\b|>\s*\/dev\/null/;

function earlyExitPipes(source) {
  const hits = [];
  source.split("\n").forEach((text, i) => {
    if (/^\s*#/.test(text)) return;
    for (const m of text.matchAll(PIPE_GREP)) {
      if (EARLY_EXIT.test(m[1])) hits.push({ n: i + 1, text: text.trim() });
    }
  });
  return hits;
}

test("the detector flags every known-bad shape and none of the fixed ones (positive control)", () => {
  const bad = [
    `has_var() { var_names "$1" | grep -qx "$2"; }`,
    `  printf '%s\\n' "$names" | grep -qx "$2"`,
    `in_list() { printf '%s\\n' $2 | grep -x "$1" >/dev/null; }`,
    `railway environment edit --help | grep -q -- '--service-config' \\`,
    `if cast wallet list 2>/dev/null | grep -q "^$ACCOUNT"; then`,
    `echo "$VAULT" | grep -Eq '^0x[0-9a-fA-F]{40}$' || die "x"`,
    `  | grep --quiet foo`,
    `x=$(cmd | grep -m1 foo)`,
  ];
  for (const line of bad) assert.equal(earlyExitPipes(line).length, 1, `detector missed: ${line}`);
  const good = [
    `in_list() { grep -qx "$1" <<<"$(printf '%s\\n' $2)"; }`,
    `has_var() { local names; names=$(var_names "$1") || return 1; grep -qx "$2" <<<"$names"; }`,
    `[ -f x ] || grep -q foo file`,
    `rw_ver=$(railway --version 2>/dev/null | grep -oE '[0-9]+(\\.[0-9]+){1,3}' | head -1 || true)`,
    `# a comment about \`cmd | grep -q\``,
  ];
  for (const line of good) assert.deepEqual(earlyExitPipes(line), [], `detector flagged a fixed shape: ${line}`);
});

test("no pipefail shell script under ops/ or scripts/ pipes into an early-exiting grep", () => {
  const files = execFileSync("git", ["ls-files", "--", "ops/*.sh", "ops/**/*.sh", "scripts/*.sh", "scripts/**/*.sh"], {
    cwd: ROOT, encoding: "utf8",
  }).split("\n").filter(Boolean);
  assert.ok(files.includes("ops/go-live-v2.sh") && files.includes("ops/v8/import-deployer.sh"),
    "git ls-files did not list the scripts this guard exists for; it is reading the wrong tree");
  const offenders = [];
  let scanned = 0;
  for (const rel of files) {
    const source = read(rel);
    if (!/pipefail/.test(source)) continue;
    scanned++;
    for (const h of earlyExitPipes(source)) offenders.push(`${rel}:${h.n}: ${h.text}`);
  }
  assert.ok(scanned >= 8, `only ${scanned} pipefail scripts scanned; expected the eight T-OP-653 fixed at least`);
  assert.deepEqual(offenders, [],
    "collect the output first and grep a here-string (grep -q x <<<\"$out\"), or use [[ =~ ]] for a secret");
});

// ------------------------------------------------------------------------------------------------
// 2. The 300k-line control on the real helpers
// ------------------------------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "t-op-653-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

// TARGET first, so grep matches on the first line and the writer still has ~3 MB to write.
const NAMES = path.join(TMP, "names.txt");
fs.writeFileSync(NAMES, ["TARGET", ...Array.from({ length: 300_000 }, (_, i) => `RAILWAY_VAR_${i}`)].join("\n") + "\n");

/** The definition of shell function `name` exactly as the script has it: from `name() {` to the first line ending in `}`. */
function fnDef(rel, name) {
  const lines = read(rel).split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.ok(start >= 0, `${rel} has no ${name}() definition`);
  const end = lines.findIndex((l, i) => i >= start && /\}\s*(#.*)?$/.test(l.trim()));
  return lines.slice(start, end + 1).join("\n");
}

/** One line of `rel` matching `re`, exactly as the script has it. */
function lineOf(rel, re) {
  const hits = read(rel).split("\n").filter((l) => re.test(l));
  assert.equal(hits.length, 1, `${rel}: expected one line matching ${re}, found ${hits.length}`);
  return hits[0];
}

/** Run `body` under the scripts' own `set -euo pipefail`, with var_names/die stubbed. */
function sh(body, env = {}) {
  const script = [
    "set -euo pipefail",
    `die() { echo "DIE: $*" >&2; exit 3; }`,
    `var_names() { cat "$NAMES"; }`,
    body,
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, NAMES, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const verdict = (call) => `if ${call}; then echo HIT; else echo MISS; fi`;

test("control: the old pipe shape reads a match as a miss on this input (so the input is big enough)", () => {
  const old = sh(`old_has_var() { var_names "$1" | grep -qx "$2"; }\n${verdict("old_has_var svc TARGET")}`);
  assert.equal(old.out, "MISS", `the pre-fix shape did not reproduce the false miss here: ${JSON.stringify(old)}`);
  const oldList = sh(`old_in_list() { printf '%s\\n' $2 | grep -qx "$1"; }\nL=$(cat "$NAMES")\n${verdict('old_in_list TARGET "$L"')}`);
  assert.equal(oldList.out, "MISS", `the pre-fix in_list shape did not reproduce the false miss: ${JSON.stringify(oldList)}`);
});

for (const rel of ["ops/go-live-app.sh", "ops/keeper-railway.sh", "ops/go-live-v2.sh"]) {
  test(`${rel} has_var: a present name is found and an absent one is not, with 300k names`, () => {
    const def = fnDef(rel, "has_var");
    assert.equal(sh(`${def}\n${verdict("has_var svc TARGET")}`).out, "HIT", def);
    assert.equal(sh(`${def}\n${verdict("has_var svc RAILWAY_VAR_299999")}`).out, "HIT", def);
    assert.equal(sh(`${def}\n${verdict("has_var svc NOT_THERE")}`).out, "MISS", def);
    // Exact name, not a prefix: TARGE is not TARGET.
    assert.equal(sh(`${def}\n${verdict("has_var svc TARGE")}`).out, "MISS", def);
  });
}

test("ops/go-live-v2.sh var_is_set and in_list: found with 300k entries, absent stays absent", () => {
  const rel = "ops/go-live-v2.sh";
  const vis = fnDef(rel, "var_is_set");
  assert.equal(sh(`${vis}\n${verdict("var_is_set svc TARGET")}`).out, "HIT");
  assert.equal(sh(`${vis}\n${verdict("var_is_set svc NOT_THERE")}`).out, "MISS");
  // A read that fails answers "not set" rather than dying (its documented contract).
  assert.equal(sh(`${vis}\nvar_names() { return 1; }\n${verdict("var_is_set svc TARGET")}`).out, "MISS");
  const inList = fnDef(rel, "in_list");
  assert.equal(sh(`${inList}\nL=$(cat "$NAMES")\n${verdict('in_list TARGET "$L"')}`).out, "HIT");
  assert.equal(sh(`${inList}\n${verdict('in_list indexer-v2 "web keeper indexer-v2 monitor"')}`).out, "HIT");
  assert.equal(sh(`${inList}\n${verdict('in_list indexer "web keeper indexer-v2 monitor"')}`).out, "MISS");
});

test("ops/v2/derive-bot-keys.sh --only filter keeps a named bot with 300k names in WANT", () => {
  const line = lineOf("ops/v2/derive-bot-keys.sh", /^\s*if \[ -n "\$WANT" \] && .*then continue; fi/);
  const loop = (bot) => `WANT=$(cat "$NAMES")\nfor BOT in ${bot}; do\n${line}\necho KEPT\ndone\necho END`;
  assert.equal(sh(loop("TARGET")).out, "KEPT\nEND");
  assert.equal(sh(loop("guardian")).out, "END");
});

test("ops/go-live-app.sh web check: a big page that says 'No vault address configured' is NOT reported configured", () => {
  const cond = lineOf("ops/go-live-app.sh", /^if \[ "\$pcode" = 200 \] && ! .*No vault address configured.*then$/);
  const PAGE = path.join(TMP, "page.html");
  // Multi-line on purpose: the live page is one 63 KB line today, which grep must read to its end anyway.
  fs.writeFileSync(PAGE, `<html><body><p>No vault address configured</p>\n${"<div>filler</div>\n".repeat(40_000)}</body></html>`);
  const run = (c) => sh(`pcode=200\npage=$(cat "${PAGE}")\n${c}\n  echo CONFIGURED\nelse\n  echo NOT_CONFIGURED\nfi`).out;
  assert.equal(run(cond), "NOT_CONFIGURED", cond);
  // Control: the pre-fix line on the same page passes for the wrong reason.
  assert.equal(run(`if [ "$pcode" = 200 ] && ! printf '%s' "$page" | grep -q "No vault address configured"; then`), "CONFIGURED",
    "the pre-fix shape no longer reproduces the false pass on a 680 KB page; the control is not exercising anything");
  fs.writeFileSync(PAGE, `<html><body>\n${"<div>vault 0xabc</div>\n".repeat(40_000)}</body></html>`);
  assert.equal(run(cond), "CONFIGURED");
});

test("ops/v8/import-deployer.sh: an existing keystore listed as '0x<name> (Local)' is found, and nothing is imported", () => {
  const home = path.join(TMP, "home");
  fs.mkdirSync(path.join(home, ".foundry", "bin"), { recursive: true });
  const castLog = path.join(TMP, "cast.log");
  // cast 1.3.5-foundry-zksync and 1.6.0 both list a keystore file `ops` as "0xops (Local)" (measured).
  fs.writeFileSync(path.join(home, ".foundry", "bin", "cast"), [
    "#!/usr/bin/env bash",
    `echo "$*" >> "${castLog}"`,
    `if [ "$1 $2" = "wallet list" ]; then for i in $(seq 1 2000); do echo "0xother$i (Local)"; done; echo "0xops (Local)"; echo "0xopsx (Local)"; exit 0; fi`,
    "exit 7",
  ].join("\n"), { mode: 0o755 });
  const wallet = path.join(TMP, "wallet.txt");
  fs.writeFileSync(wallet, "no phrase here\n");
  const run = (account) => {
    fs.rmSync(castLog, { force: true });
    const r = spawnSync("bash", [path.join(OPS, "v8", "import-deployer.sh"), account], {
      encoding: "utf8", env: { ...process.env, HOME: home, CALLHOUSE_WALLET_FILE: wallet },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, calls: fs.existsSync(castLog) ? fs.readFileSync(castLog, "utf8") : "" };
  };
  const hit = run("ops");
  assert.equal(hit.code, 0, JSON.stringify(hit));
  assert.match(hit.out, /keystore "ops" already exists:\n0xops \(Local\)\n/);
  assert.doesNotMatch(hit.out, /0xopsx/, "a keystore whose name merely starts with the account name is a different keystore");
  assert.doesNotMatch(hit.calls, /wallet import/, "an existing keystore must not be re-imported");
  // An absent account goes on to read the phrase, which this dummy wallet file does not have.
  const miss = run("deployer");
  assert.equal(miss.code, 1, JSON.stringify(miss));
  assert.match(miss.err, /expected a 24-word phrase/);
});

test("ops/v8/launch.sh anvil_up: finds anvil in a long answer and says no to an empty one", () => {
  const def = fnDef("ops/v8/launch.sh", "anvil_up");
  const bin = path.join(TMP, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash\n[ -n "\${CURL_OUT:-}" ] && cat "$CURL_OUT"; exit 0\n`, { mode: 0o755 });
  const out = path.join(TMP, "rpc.json");
  fs.writeFileSync(out, `{"jsonrpc":"2.0","id":1,"result":"anvil/v1.3.5"}\n${"x".repeat(1_000_000)}\n`);
  const env = { PATH: `${bin}:${process.env.PATH}`, ANVIL_RPC: "http://127.0.0.1:1" };
  assert.equal(sh(`${def}\n${verdict("anvil_up")}`, { ...env, CURL_OUT: out }).out, "HIT", def);
  assert.equal(sh(`${def}\n${verdict("anvil_up")}`, env).out, "MISS", def);
});
