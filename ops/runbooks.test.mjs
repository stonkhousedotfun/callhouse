/**
 * The runbooks' commands, checked mechanically.
 *
 * WHY THIS FILE EXISTS: a runbook is read once, at 3 a.m., by someone who did not write it. Every
 * rule here is a command that was in the v2 runbooks and could not work as written — a private
 * hostname nothing resolves, a tool no image has, a log line the relay never logs, a rotation order
 * the scripts refuse, a variable the monitor does not read. Prose is not tested; the things an
 * operator would type are.
 *
 *   node --test ops/runbooks.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const OPS = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(OPS, p), "utf8");
const lines = (p) => read(p).split("\n").map((text, i) => ({ n: i + 1, text }));

const ALERTS = "alerts.md";
const DEPLOY = "deploy.md";
const INCIDENT = "runbooks/incident-v2.md";
const CANARY = "runbooks/v2-canary.md";
/** The cut-scope mainnet DEV deployment: the canary's little brother, on the same terms. */
const DEV_DEPLOY = "runbooks/v2-dev-deploy.md";
const PRICING_GO_LIVE = "runbooks/v2-pricing-go-live.md";
const RELAY_MONITOR = "runbooks/relay-monitor-go-live.md";
const OPS_ONLY_PUB = "runbooks/ops-only-publication.md";
const RUNBOOKS = [ALERTS, DEPLOY, INCIDENT, CANARY, DEV_DEPLOY, PRICING_GO_LIVE, RELAY_MONITOR, OPS_ONLY_PUB];

const where = (hits) => hits.map((h) => `${h.file}:${h.n}: ${h.text.trim().slice(0, 150)}`).join("\n");

function scan(files, predicate) {
  const hits = [];
  for (const file of files) for (const l of lines(file)) if (predicate(l.text)) hits.push({ file, ...l });
  return hits;
}

/** Every match of `re` in every runbook, as {file, n, text, m}. */
function matches(files, re) {
  const out = [];
  for (const file of files) {
    for (const l of lines(file)) for (const m of l.text.matchAll(re)) out.push({ file, n: l.n, text: l.text, m });
  }
  return out;
}

/** `port` per service, from the one table in ops/go-live-v2.sh. */
function servicePorts() {
  const all = read("go-live-v2.sh").split("\n");
  const open = all.findIndex((t) => t === 'TABLE="');
  assert.ok(open > 0, "ops/go-live-v2.sh no longer opens its service table with a bare TABLE=\"");
  const ports = new Map();
  for (let i = open + 1; all[i] !== '"'; i += 1) {
    assert.ok(i < all.length, "ops/go-live-v2.sh service table is unterminated");
    const row = all[i].trim().split(/\s+/);
    if (row.length > 2 && /^\d+$/.test(row[2])) ports.set(row[0], row[2]);
  }
  assert.ok(ports.size >= 7, `only ${ports.size} services parsed out of the go-live-v2.sh table`);
  return ports;
}

/** The long flags a `case "$1" in` / `case a in` block accepts. */
function flagsOf(source, re) {
  const found = new Set();
  for (const [, flag] of source.matchAll(re)) found.add(flag);
  return found;
}

/**
 * Every `--flag` a runbook passes to `command`, against the set the command parses. The command's
 * arguments run to the end of the line or to the first thing that ends a command in Markdown: a
 * closing backtick, a table pipe, or a trailing `#` comment.
 */
function flagHits(files, command, known, why) {
  const hits = [];
  for (const file of files) {
    for (const l of lines(file)) {
      const at = l.text.indexOf(command);
      if (at < 0) continue;
      const args = l.text.slice(at + command.length).split(/[`|]|\s#/)[0];
      for (const [, flag] of args.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)) {
        if (!known.has(flag)) hits.push({ file, n: l.n, text: `${command} ${flag}: ${why}` });
      }
    }
  }
  return hits;
}

/**
 * The source of every service that reads a `KEEPER_*` / `MM_*` / `CRANKER_*` / `PRICER_*` variable,
 * concatenated. The bots are keeper/src; `KEEPER_ORDERS_URL` is the web app's, read per request.
 */
function serviceSources() {
  const roots = ["keeper/src", "web/app", "web/lib", "web/.env.example", "relay/src", "notifier/src"];
  const out = [];
  const walk = (p) => {
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      out.push(readFileSync(p, "utf8")); // a file, not a directory
      return;
    }
    for (const e of entries) {
      const child = path.join(p, e.name);
      if (e.isDirectory()) walk(child);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(readFileSync(child, "utf8"));
    }
  };
  for (const r of roots) walk(path.join(OPS, "..", r));
  assert.ok(out.length > 20, `only ${out.length} service sources found: the tree moved`);
  return out.join("\n");
}

test("no runbook reaches a private endpoint with curl or wget", () => {
  // *.railway.internal resolves only inside the Railway private network, and no image installs curl
  // or wget: keeper and indexer are bookworm-slim, relay/notifier/web are alpine (busybox wget). The
  // one exception is the `web` service's own wget, which is alpine and documented as such.
  const hits = scan(RUNBOOKS, (t) => /\b(curl|wget)\b[^`\n]*railway\.internal/.test(t) && !/--service web\b/.test(t));
  assert.equal(hits.length, 0, `use probe / node -e fetch instead:\n${where(hits)}`);
});

test("no in-container probe uses a tool its image does not have", () => {
  // `railway ssh --service <keeper|indexer|cranker|pricer|mm-bot|pricing|monitor> -- wget|curl`.
  const debian = /railway ssh --service \$?[a-z0-9$_{}-]*(keeper|indexer|cranker|pricer|mm-bot|pricing|monitor)[a-z0-9$_{}-]* -- [^`\n]*\b(wget|curl)\b/;
  const hits = scan(RUNBOOKS, (t) => debian.test(t));
  assert.equal(hits.length, 0, `Debian images have neither; use node -e fetch:\n${where(hits)}`);
});

test("no v2 runbook command puts a key on the command line", () => {
  // cast --private-key takes the value as an argument, so ps -axww shows it while the send runs.
  // The v2 runbooks name a Foundry keystore account instead.
  const hits = scan([INCIDENT, ALERTS, CANARY, DEV_DEPLOY], (t) => /--private-key/.test(t) && !/\bnever\b|instead of|would|--account/.test(t));
  assert.equal(hits.length, 0, `use --account <keystore name>:\n${where(hits)}`);
});

test("alerts.md does not send the on-call after a log line the relay never logs", () => {
  // relay-13. relay/src/server.ts logs "alert relayed" (with failed[]) and
  // "alert NOT delivered: every target failed". There is no "target refused".
  const relay = readFileSync(path.join(OPS, "..", "relay", "src", "server.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // the file's header prose describes a 502 as "every target refused"
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/target refused/.test(relay), "the relay now logs 'target refused': update this test and §V14");
  // Flagged: the phrase offered as something to look for (in backticks), not the English sentence
  // "every target refused" describing a 502, and not the note saying the relay never logs it.
  const hits = scan([ALERTS, INCIDENT, CANARY, DEV_DEPLOY], (t) => /`target refused`/.test(t) && !/never log|does not log/.test(t));
  assert.equal(hits.length, 0, `the relay never logs that; name its real lines instead:\n${where(hits)}`);
  const alerts = read(ALERTS);
  for (const real of ["alert relayed", "alert NOT delivered: every target failed"]) {
    assert.ok(alerts.includes(real), `§V14 should name the relay's real line ${JSON.stringify(real)}`);
  }
});

test("the monitor service's copy-paste variable block boots and names real variables", () => {
  // ops-c35: the repo root has no Dockerfile, and without RAILWAY_RUN_UID=0 the node user cannot
  // write /data. Both belong in the block the owner pastes.
  const deploy = read(DEPLOY);
  const all = deploy.split("\n");
  const at = all.findIndex((t) => /^MONITOR_STATE_PATH=/.test(t));
  assert.ok(at > 0, "deploy.md §15.12 has no MONITOR_STATE_PATH line");
  let start = at;
  while (start > 0 && !/^```/.test(all[start - 1])) start -= 1;
  let end = at;
  while (end < all.length && !/^```/.test(all[end])) end += 1;
  const block = all.slice(start, end);
  assert.ok(block.some((t) => t === "RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile"), "the block chooses no builder");
  assert.ok(block.some((t) => t === "RAILWAY_RUN_UID=0"), "the block cannot write its volume");

  // Every name it sets is one the monitor actually reads.
  const monitor = read("v2/monitor.mjs");
  for (const t of block) {
    const name = /^([A-Z][A-Z0-9_]*)=/.exec(t)?.[1];
    if (name === undefined || name.startsWith("RAILWAY_")) continue;
    assert.ok(monitor.includes(name), `deploy.md §15.12 sets ${name}, which ops/v2/monitor.mjs never reads`);
  }
});

test("the runbooks name the same monitor variables the monitor reads", () => {
  const monitor = read("v2/monitor.mjs");
  const hits = [];
  for (const file of RUNBOOKS) {
    for (const l of lines(file)) {
      for (const name of l.text.match(/\bMONITOR_[A-Z0-9_]+\b/g) ?? []) {
        if (!monitor.includes(name)) hits.push({ file, n: l.n, text: `${name}: not read by ops/v2/monitor.mjs` });
      }
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("incident-v2.md gives a bot-key rotation order the tools accept", () => {
  // ops-c07: derive-bot-keys.sh refuses to overwrite a key file or re-point a non-null v2.bots
  // entry, and go-live-v2.sh --rotate-keys takes a key only when it derives to the pushed address.
  const incident = read(INCIDENT);
  assert.match(incident, /^### 4d\. Rotating a bot key/m, "no §4d rotation order");
  const from4d = incident.indexOf("### 4d.");
  const body = incident.slice(from4d, incident.indexOf("### Do NOT", from4d));
  for (const step of [/mv ~\/\.callhouse-keys\/v2/, /v2\.bots\["?<bot>"?\]\s*=\s*null/, /derive-bot-keys\.sh <bot>/, /--rotate-keys/]) {
    assert.match(body, step, "§4d is missing a step the tools require");
  }
  // Each compromise section hands the rotation to §4d rather than repeating a refused order.
  for (const s of ["### 4a.", "### 4b.", "### 4c."]) {
    const from = incident.indexOf(s);
    const to = incident.indexOf("### 4", from + 5);
    assert.match(incident.slice(from, to), /§4d/, `${s} does not point at §4d`);
  }
});

test("every runbook section a monitor alert names exists", () => {
  // The monitor puts a runbook anchor in every alert it sends; a page that points nowhere is worse
  // than no page.
  const alerts = read(ALERTS);
  const incident = read(INCIDENT);
  const monitor = read("v2/monitor.mjs");
  const missing = [];
  for (const [, doc, section] of monitor.matchAll(/\$\{(AL|IR)\} §(V?\d+[a-z]?)/g)) {
    // alerts.md headings keep the §; incident-v2.md numbers its sections ("## 4. Bot key compromise",
    // "### 5a. …"), so §5a there is the 5a heading.
    const found = doc === "AL"
      ? new RegExp(`^#+ §${section}\\b`, "m").test(alerts)
      : new RegExp(`^#+ ${section}\\.`, "m").test(incident);
    if (!found) missing.push({ file: doc === "AL" ? ALERTS : INCIDENT, n: 0, text: `§${section} has no heading` });
  }
  assert.equal(missing.length, 0, where(missing));
});

/*//////////////////////////////////////////////////////////////
       O2-04: the canary runbook's commands, on the same terms
//////////////////////////////////////////////////////////////*/

test("every private-network URL a runbook probes uses that service's own port", () => {
  // O2-04. The ports live in one place, the service table in ops/go-live-v2.sh, and a runbook that
  // probes the wrong one prints ERR — which reads exactly like a dead service at 3 a.m.
  const ports = servicePorts();
  const hits = [];
  for (const h of matches(RUNBOOKS, /\bhttps?:\/\/([a-z0-9-]+)\.railway\.internal:(\d+)/g)) {
    const [, svc, port] = h.m;
    const want = ports.get(svc);
    // A v1 service (keeper, indexer, Postgres) is not in the v2 table and is not this test's business.
    if (want !== undefined && want !== port) {
      hits.push({ ...h, text: `${svc}.railway.internal:${port}: that service listens on ${want}` });
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("every go-live-v2.sh flag a runbook passes is one the script parses", () => {
  // O2-04. `--dry-run`, `--offline`, `--ref`, `--services`, `--registry`, `--rotate-keys`,
  // `--ignore-expiry-window`, `--yes`: an invented one exits 2 with "unknown argument", and a
  // near-miss (`--service` for `--services`) is the easy one to write and the easy one to miss.
  const script = read("go-live-v2.sh");
  const known = flagsOf(script, /^\s*(--[a-z-]+)[|)]/gm);
  for (const extra of ["--help", "--yes"]) known.add(extra);
  assert.ok(known.has("--apply") && known.has("--ref"), "the go-live-v2.sh argument parser no longer looks like a case block");
  const hits = flagHits(RUNBOOKS, "go-live-v2.sh", known, "the script's parser exits 2 on it");
  assert.equal(hits.length, 0, where(hits));
});

test("every monitor.mjs flag a runbook passes is one the monitor parses", () => {
  // O2-04. Same shape: an unknown flag is a UsageError, not a run.
  const monitor = read("v2/monitor.mjs");
  const known = flagsOf(monitor, /case "(--[a-z-]+)":/g);
  assert.ok(known.has("--once") && known.has("--rpc"), "ops/v2/monitor.mjs no longer parses its flags in a case block");
  const hits = flagHits(RUNBOOKS, "monitor.mjs", known, "not a flag it parses");
  assert.equal(hits.length, 0, where(hits));
});

test("every dev_deploy.py flag and subcommand a runbook passes is one the script parses", () => {
  // The dev deploy is one script now, and the runbook hands the owner its command lines. argparse
  // exits 2 on an unknown flag AND on an unknown positional, so a stale `--fork` or a renamed
  // `broadcast` is a run that never starts — the same failure the two tests above exist for.
  const py = read("v2/dev_deploy.py");
  const known = flagsOf(py, /add_argument\("(--[a-z-]+)"/g);
  known.add("--help");
  assert.ok(known.has("--dry-run") && known.has("--resume"),
    "ops/v2/dev_deploy.py no longer declares its flags with add_argument(\"--flag\"");
  const hits = flagHits(RUNBOOKS, "dev_deploy.py", known, "argparse exits 2 on it");

  // The positional is `choices=[...]`: the word right after the path is one of those, or nothing.
  const choices = new Set(
    (py.match(/"command", choices=\[([^\]]+)\]/) ?? [, ""])[1].match(/"([a-z]+)"/g)?.map((s) => s.slice(1, -1)) ?? []);
  assert.ok(choices.has("preflight") && choices.has("all"),
    "ops/v2/dev_deploy.py no longer declares its subcommands with choices=[...]");
  for (const file of RUNBOOKS) {
    for (const l of lines(file)) {
      const at = l.text.indexOf("dev_deploy.py");
      if (at < 0) continue;
      const word = l.text.slice(at + "dev_deploy.py".length).split(/[`|]|\s#/)[0].trim().split(/\s+/)[0];
      if (!word || word.startsWith("-")) continue;
      if (!choices.has(word)) hits.push({ file, n: l.n, text: `dev_deploy.py ${word}: not a subcommand it accepts` });
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("every bot variable a runbook assigns is one the keeper reads", () => {
  // O2-04. §3.5-§3.7 of the canary runbook hand the owner a `railway variables --set` block. A name
  // the keeper's schema does not have is accepted by Railway in silence and does nothing.
  //
  // Only NAME=value is checked — an assignment is something the owner will type. A name mentioned in
  // prose may be a variable a follow-up ticket proposes (deploy.md §15.13's PRICER_REPRICE_OFF_HOURS).
  const src = serviceSources();
  const hits = [];
  for (const h of matches(RUNBOOKS, /\b((?:MM|CRANKER|PRICER|KEEPER|POLL)_[A-Z0-9_]+)=/g)) {
    const name = h.m[1];
    if (!new RegExp(`\\b${name}\\b`).test(src)) hits.push({ ...h, text: `${name}=…: no service source reads it` });
  }
  assert.equal(hits.length, 0, where(hits));
});

test("every alert kind a runbook names is one something emits", () => {
  // O2-04. The canary's day-one triage table (§5.6) is a list of alert kinds. A kind nothing emits
  // is a row that never fires, and its absence is invisible.
  const kinds = new Set();
  const keeperAlerts = readFileSync(path.join(OPS, "..", "keeper", "src", "v2", "alerts.ts"), "utf8");
  const severity = keeperAlerts.slice(keeperAlerts.indexOf("ALERT_SEVERITY"));
  for (const [, k] of severity.matchAll(/^\s{2}(v2_[a-z0-9_]+):/gm)) kinds.add(k);
  for (const [, k] of read("v2/monitor.mjs").matchAll(/\b(v2_mon_[a-z0-9_]+)\b/g)) kinds.add(k);
  assert.ok(kinds.has("v2_boot") && kinds.has("v2_mon_l2_lag"), "the alert catalogues moved; this test reads the wrong files");
  const hits = [];
  for (const h of matches([INCIDENT, CANARY, DEV_DEPLOY, PRICING_GO_LIVE, RELAY_MONITOR], /`(v2_[a-z0-9_]+)`/g)) {
    const kind = h.m[1];
    if (kind.endsWith("_")) continue; // `v2_mon_feed_*` written as a family
    if (kind.startsWith("v2_meta") || kind.startsWith("v2_alerts") || kind.startsWith("v2_txs")) continue; // SQLite tables
    if (!kinds.has(kind)) hits.push({ ...h, text: `${kind}: neither keeper/src/v2/alerts.ts nor ops/v2/monitor.mjs emits it` });
  }
  assert.equal(hits.length, 0, where(hits));
});
