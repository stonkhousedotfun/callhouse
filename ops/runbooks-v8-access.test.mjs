/**
 * The v8 access runbooks' commands, checked mechanically.
 *
 * WHY THIS FILE EXISTS, separately from ops/runbooks.test.mjs: INTERFACE_VERSION 8 moved every
 * privileged call onto one AccessManager, and the three things an operator can now get wrong are all
 * silent. A retyped role id names a different role. A retyped execution delay sends a transaction
 * into a window that has not opened. A registry key with the old spelling (`v2.bots.mmQuoter`)
 * exports an EMPTY shell variable and every `cast` after it runs against nothing — which is exactly
 * what `incident-v2.md` did before O8-02. None of those reverts in a way that reads like the mistake
 * it is, so each one is a rule here.
 *
 * The discipline these tests enforce is MIRROR, DO NOT RE-REASON: every role id, delay, guardian and
 * role admin in the v8 runbooks is READ from ops/abis/v2/roles.json by the command the operator
 * runs, and every `cast` invocation against the manager is checked against ops/abis/v2/AccessManager.json.
 *
 *   node --test ops/runbooks-v8-access.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const OPS = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(OPS, p), "utf8");
const json = (p) => JSON.parse(read(p));
const lines = (p) => read(p).split("\n").map((text, i) => ({ n: i + 1, text }));

/**
 * The same lines with backslash continuations joined onto the line that starts them, reported at
 * that first line's number. Every `cast logs` line in v8-roles.md §4.3 is written over two physical
 * lines, so a line-by-line scan silently checks nothing — which is how a guard passes for the wrong
 * reason. (This was caught by breaking it: dropping `indexed` from an event went undetected.)
 */
function joined(p) {
  const out = [];
  for (const l of lines(p)) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /\\$/.test(prev.text)) prev.text = `${prev.text.slice(0, -1)} ${l.text.trim()}`;
    else out.push({ ...l });
  }
  return out;
}

/** The same lines, each tagged with whether it sits inside a ``` fence — a command, not prose. */
function codeLines(p) {
  let open = false;
  return joined(p).map((l) => {
    const fence = /^\s*```/.test(l.text);
    const code = open && !fence;
    if (fence) open = !open;
    return { ...l, code };
  });
}

const SAFES = "runbooks/v8-safes.md";
const ROLES_RB = "runbooks/v8-roles.md";
/** The two runbooks O8-02 adds. Everything in this file is about these unless it says otherwise. */
const NEW = [SAFES, ROLES_RB];
/** Edited by the same task (§4 went from v7 bytes32 roles to v8 manager roles), so it is checked too. */
const INCIDENT = "runbooks/incident-v2.md";
const TOPOLOGY = "safes.md";

const MANIFEST = "abis/v2/roles.json";
const MANAGER_ABI = "abis/v2/AccessManager.json";
const REGISTRY = "markets/tier1.json";

const manifest = json(MANIFEST);
const roleNames = new Set(Object.keys(manifest.roles));

const where = (hits) => hits.map((h) => `${h.file}:${h.n}: ${h.text.trim().slice(0, 170)}`).join("\n");

function matches(files, re) {
  const out = [];
  for (const file of files) {
    for (const l of joined(file)) for (const m of l.text.matchAll(re)) out.push({ file, n: l.n, text: l.text, m });
  }
  return out;
}

function scan(files, predicate) {
  const hits = [];
  for (const file of files) for (const l of joined(file)) if (predicate(l.text)) hits.push({ file, ...l });
  return hits;
}

/** `name(inTypes)` — outputs, when a runbook writes them, are returned separately. */
function parseSig(sig) {
  const m = /^([A-Za-z_][\w$]*)\(([\s\S]*)$/.exec(sig.trim());
  if (!m) return null;
  const [, name, rest] = m;
  // Split the argument list off the (optional) return list by matching the first balanced paren run.
  let depth = 1, i = 0;
  for (; i < rest.length && depth > 0; i += 1) {
    if (rest[i] === "(") depth += 1;
    else if (rest[i] === ")") depth -= 1;
  }
  if (depth !== 0) return null;
  const inputs = rest.slice(0, i - 1);
  const tail = rest.slice(i).trim();
  const outs = tail.startsWith("(") && tail.endsWith(")") ? tail.slice(1, -1) : tail === "" ? null : undefined;
  const norm = (s) => s.replace(/\s+/g, "");
  return { name, inputs: norm(inputs), outputs: outs === null || outs === undefined ? outs : norm(outs) };
}

/** ops/abis/v2/AccessManager.json as {functions: Map<name, Set<"in|out">>, events: Map<name, Set<sig>>}. */
function managerAbi() {
  const abi = json(MANAGER_ABI);
  const t = (x) => (x.type === "tuple" ? `(${x.components.map(t).join(",")})` : x.type);
  const functions = new Map(), events = new Map();
  for (const e of abi) {
    if (e.type === "function") {
      const key = `${(e.inputs ?? []).map(t).join(",")}|${(e.outputs ?? []).map(t).join(",")}`;
      if (!functions.has(e.name)) functions.set(e.name, new Set());
      functions.get(e.name).add(key);
    } else if (e.type === "event") {
      // The human-readable form `cast` needs, with the indexed markers, normalised to `type indexed name`.
      if (!events.has(e.name)) events.set(e.name, new Set());
      events.get(e.name).add(e.inputs.map((i) => `${i.type}${i.indexed ? " indexed " : " "}${i.name}`).join(","));
    }
  }
  assert.ok(functions.has("hasRole") && functions.has("canCall") && functions.has("getTargetFunctionRole"),
    "ops/abis/v2/AccessManager.json no longer looks like the AccessManager ABI");
  return { functions, events };
}

// ---------------------------------------------------------------------------------------------
// 1. Role names and delays: the manifest is the only source
// ---------------------------------------------------------------------------------------------

/**
 * Names the runbooks shout in capitals that are deliberately NOT manager roles: Safe revert codes,
 * two EVM call types, one plan-document title and the interface-version constant. Shell variables do
 * NOT go here — they are recognised automatically, so adding one to a runbook never needs a test
 * edit. Anything else in capitals has to be a role `ops/abis/v2/roles.json` defines, which is what
 * catches a role that was typed from memory instead of read.
 */
const NOT_ROLES = new Set([
  "GS013", "GS020", "GS022", "GS023", "GS024", "GS025", "GS026", "GS030",
  "CALL", "DELEGATECALL", "DIRECT", "DIRECTLY",
  "INTERFACE_VERSION", "MASTER", "QUIRKS", "DESIGN", "ADDRESSES", "VERSION", "JSON",
]);

/** Every name the file uses as a shell variable or as a key of the `eval`-ed export object. */
function shellNames(text) {
  const out = new Set();
  for (const [, n] of text.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\b/g)) out.add(n);
  for (const [, n] of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*)=/gm)) out.add(n);
  for (const [, n] of text.matchAll(/[{,][ \t\n]*([A-Z][A-Z0-9_]*):/g)) out.add(n);
  for (const [, n] of text.matchAll(/\bfor[ \t]+([A-Z][A-Z0-9_]*)[ \t]+in\b/g)) out.add(n);
  return out;
}

test("every role name the v8 runbooks name is one the manifest defines", () => {
  const hits = [];
  for (const file of NEW) {
    const text = read(file);
    const shell = shellNames(text);
    for (const l of joined(file)) {
      for (const m of l.text.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*\b|\b[A-Z]{4,}\b/g)) {
        const tok = m[0];
        // `ADMIN_ROLE()` is the manager's own getter, not a role name: a capital word immediately
        // followed by `(` is a function signature and belongs to the ABI tests below.
        if (l.text[m.index + tok.length] === "(") continue;
        if (roleNames.has(tok) || shell.has(tok) || NOT_ROLES.has(tok)) continue;
        hits.push({ file, n: l.n, text: `${tok}: not a role in ops/${MANIFEST}, not a shell variable of this file` });
      }
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("every role the v8 runbooks look up through the manifest readers exists in it", () => {
  // `rid FOO` / `rdelay FOO` / `radmin FOO` / `rguard FOO` are the four helpers v8-roles.md §0
  // defines over ops/abis/v2/roles.json. They throw on a name the manifest does not carry, so a
  // runbook that passes one has written a command that cannot run.
  const hits = [];
  for (const file of [...NEW, INCIDENT]) {
    for (const l of codeLines(file)) {
      for (const m of l.text.matchAll(/\b(rid|rdelay|radmin|rguard)\s+"?([A-Z][A-Z0-9_]*)"?/g)) {
        const [, fn, name] = m;
        const table = { rid: manifest.roles, rdelay: manifest.delaysS, radmin: manifest.roleAdmin, rguard: manifest.roleGuardian }[fn];
        if (!roleNames.has(name)) { hits.push({ file, n: l.n, text: `${fn} ${name}: not a role in ops/${MANIFEST}` }); continue; }
        // Prose is allowed to name a lookup that THROWS: `rguard ADMIN` failing is how v8-roles.md
        // shows that ADMIN has no guardian. A command line that would throw is a command that cannot run.
        if (l.code && !(name in table)) hits.push({ file, n: l.n, text: `${fn} ${name}: ${name} has no ${fn} row in ops/${MANIFEST}; the helper throws` });
      }
    }
  }
  assert.ok(matches(NEW, /\brid\s+[A-Z]/g).length > 0, "v8-roles.md no longer reads a role id from the manifest at all");
  assert.equal(hits.length, 0, where(hits));
});

test("no v8 runbook hand-types an execution delay the manifest owns", () => {
  // O8-02 acceptance 4. A delay retyped into prose is a delay that will be wrong the day the
  // manifest moves, and the operator has no way to tell. Both the raw seconds and the obvious human
  // renderings are banned, and the list is DERIVED from ops/abis/v2/roles.json so it moves with it.
  const banned = new Map();
  const ban = (needle, role) => banned.set(needle, [...(banned.get(needle) ?? []), role]);
  for (const [role, secs] of Object.entries(manifest.delaysS)) {
    if (secs === 0) continue;
    ban(String(secs), role);
    if (secs % 3600 === 0) for (const u of ["h", "hour", "hours"]) ban(`${secs / 3600} ${u}`, role);
    if (secs % 86400 === 0) for (const u of ["day", "days"]) ban(`${secs / 86400} ${u}`, role);
  }
  assert.ok(banned.size > 0, "every role in the manifest now has a zero delay; this test reads the wrong field");
  const hits = [];
  for (const file of NEW) {
    for (const l of joined(file)) {
      for (const [needle, roles] of banned) {
        if (!l.text.includes(needle)) continue;
        hits.push({ file, n: l.n, text: `"${needle}" is the delay of ${roles.join("/")} in ops/${MANIFEST}: read it (rdelay ${roles[0]}), do not type it` });
      }
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("no v8 runbook hand-types a role id", () => {
  // The other half of acceptance 4. `getTargetFunctionRole` and `hasRole` take a uint64, and the
  // difference between two role ids is one character.
  const hits = [];
  for (const file of NEW) {
    for (const l of joined(file)) {
      for (const role of roleNames) {
        const near = new RegExp(`\\b${role}\\b[^\\n]{0,24}?\\b(?:id|ID)\\b[^\\n]{0,8}?\\b\\d+|\\b(?:id|ID)\\b[^\\n]{0,8}?\\b\\d+[^\\n]{0,24}?\\b${role}\\b|\\b${role}\\b\\s*\\(\\s*\\d+\\s*\\)`);
        if (near.test(l.text)) hits.push({ file, n: l.n, text: `${role} is pinned to a literal id here; use rid ${role}` });
      }
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("each v8 runbook actually reads the manifest, and names the file it reads", () => {
  // A runbook that says "read the manifest" without a command is a runbook whose numbers were typed.
  for (const file of NEW) {
    const text = read(file);
    assert.match(text, /ops\/abis\/v2\/roles\.json/, `${file} never names ops/${MANIFEST}`);
    assert.match(text, /(node -e|jq)[\s\S]{0,400}roles\.json|ROLES=ops\/abis\/v2\/roles\.json/,
      `${file} names ops/${MANIFEST} but never reads it in a command`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Every `cast` against the manager matches the shipped ABI
// ---------------------------------------------------------------------------------------------

test("every cast call/send against $MANAGER uses a signature the AccessManager ABI has", () => {
  const { functions } = managerAbi();
  const hits = [];
  for (const h of matches([...NEW, INCIDENT, TOPOLOGY], /cast\s+(?:call|send)\s+\$MANAGER\s+"([^"]+)"/g)) {
    const parsed = parseSig(h.m[1]);
    if (parsed === null) { hits.push({ ...h, text: `${h.m[1]}: not a parseable signature` }); continue; }
    const forms = functions.get(parsed.name);
    if (forms === undefined) { hits.push({ ...h, text: `${parsed.name}: not a function of ops/${MANAGER_ABI}` }); continue; }
    const ok = [...forms].some((key) => {
      const [ins, outs] = key.split("|");
      return ins === parsed.inputs && (parsed.outputs === undefined || parsed.outputs === outs);
    });
    if (!ok) hits.push({ ...h, text: `${h.m[1]}: ops/${MANAGER_ABI} has ${[...forms].map((k) => `${parsed.name}(${k.split("|")[0]})(${k.split("|")[1]})`).join(" / ")}` });
  }
  assert.ok(matches(NEW, /cast\s+(?:call|send)\s+\$MANAGER/g).length > 0, "the v8 runbooks no longer call the manager at all");
  assert.equal(hits.length, 0, where(hits));
});

test("every cast calldata for a manager function uses a signature the AccessManager ABI has", () => {
  // `cast calldata` names no target, so this only claims the ones whose name is unambiguous: the
  // manager-only entry points. `cancel` and `hasRole` are deliberately left out — `MakerVault.cancel`
  // and v7's `hasRole(bytes32,address)` share those names and belong to other sections.
  const { functions } = managerAbi();
  const MANAGER_ONLY = new Set(["grantRole", "revokeRole", "schedule", "execute", "multicall", "hashOperation",
    "getSchedule", "getNonce", "canCall", "getTargetFunctionRole", "getRoleAdmin", "getRoleGuardian",
    "getAccess", "expiration", "minSetback", "setTargetFunctionRole", "setRoleAdmin", "setRoleGuardian"]);
  const hits = [];
  for (const h of matches([...NEW, INCIDENT], /cast\s+calldata\s+"([^"]+)"/g)) {
    const parsed = parseSig(h.m[1]);
    if (parsed === null) { hits.push({ ...h, text: `${h.m[1]}: not a parseable signature` }); continue; }
    if (!MANAGER_ONLY.has(parsed.name)) continue;
    const forms = functions.get(parsed.name);
    if (forms === undefined) { hits.push({ ...h, text: `${parsed.name}: not a function of ops/${MANAGER_ABI}` }); continue; }
    const ok = [...forms].some((key) => key.split("|")[0] === parsed.inputs);
    if (!ok) hits.push({ ...h, text: `${h.m[1]}: ops/${MANAGER_ABI} has ${[...forms].map((k) => `${parsed.name}(${k.split("|")[0]})`).join(" / ")}` });
  }
  assert.equal(hits.length, 0, where(hits));
});

test("every cast logs line against $MANAGER names a real manager event, with its indexed fields", () => {
  // AccessManager.RoleGranted(uint64,address,uint32,uint48,bool) and AccessControl's
  // RoleGranted(bytes32,address,address) share a NAME and have different topic0s. `cast` computes
  // topic0 from the text in the command, so the text is the whole guard: a line that drops `indexed`
  // or shortens the argument list quietly matches nothing, which reads like "no such event happened".
  const { events } = managerAbi();
  const norm = (s) => s.split(",").map((p) => p.trim().replace(/\s+/g, " ")).join(",");
  const hits = [];
  for (const h of matches([...NEW, INCIDENT], /cast\s+logs\s+--address\s+\$MANAGER[^\n`]*?"([A-Za-z_][\w$]*)\(([^"]*)\)"/g)) {
    const [, name, args] = h.m;
    const forms = events.get(name);
    if (forms === undefined) { hits.push({ ...h, text: `${name}: not an event of ops/${MANAGER_ABI}` }); continue; }
    if (![...forms].some((f) => norm(f) === norm(args))) {
      hits.push({ ...h, text: `${name}(${args}): ops/${MANAGER_ABI} declares ${[...forms].map((f) => `${name}(${f})`).join(" / ")}` });
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("the two reverts the v8 runbooks name are declared in the shipped ABIs", () => {
  // The selectors quoted beside them (0xea8e4eb5, 0x60a299b0) were produced with `cast sig`; what is
  // checkable offline, and what a rename would break, is that both errors still exist with these
  // exact argument lists.
  const errs = (p) => new Set(json(p).filter((e) => e.type === "error")
    .map((e) => `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`));
  const v2 = errs("abis/v2/V2Errors.json");
  const mgr = errs(MANAGER_ABI);
  assert.ok(v2.has("NotAuthorized()"), "V2Errors no longer declares NotAuthorized()");
  for (const e of ["AccessManagerNotScheduled(bytes32)", "AccessManagerNotReady(bytes32)", "AccessManagerExpired(bytes32)"]) {
    assert.ok(mgr.has(e), `ops/${MANAGER_ABI} no longer declares ${e}`);
  }
  const text = read(ROLES_RB);
  assert.match(text, /0xea8e4eb5/, "v8-roles.md no longer states the NotAuthorized selector");
  assert.match(text, /AccessManagerNotScheduled/, "v8-roles.md no longer names AccessManagerNotScheduled");
});

// ---------------------------------------------------------------------------------------------
// 3. Registry keys, alert kinds, keys on the command line
// ---------------------------------------------------------------------------------------------

/**
 * `r.` in a runbook is a parsed JSON document: either the market registry or the role manifest,
 * because both are read with `const r = JSON.parse(...)`. A path is accepted when it resolves in
 * EITHER, and the point is the ones that resolve in neither — `v2.bots.mmQuoter` is the spelling
 * that shipped in incident-v2.md and exported an empty QUOTER.
 * The two skips are the `fetch` Response inside the `probe` helper, not a document at all.
 */
const NOT_DOCUMENT_PATHS = new Set(["r.status", "r.text"]);

function resolves(root, segments) {
  let cur = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return true; // reached data; the rest is JS
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}

test("every registry or manifest key path the v8 runbooks read exists", () => {
  const roots = [json(REGISTRY), manifest];
  const hits = [];
  for (const file of [...NEW, INCIDENT, TOPOLOGY]) {
    const text = read(file);
    // `const c = r.v2.contracts;` — an alias, so `c.accessManager` is really `r.v2.contracts.accessManager`.
    const alias = new Map();
    for (const [, name, p] of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(r(?:\.[A-Za-z_$][\w$]*)+)\s*;/g)) {
      alias.set(name, p.split(".").slice(1));
    }
    const heads = [["r", []], ...[...alias].map(([n, p]) => [n, p])];
    for (const l of joined(file)) {
      for (const [head, prefix] of heads) {
        const re = new RegExp(`(?<![A-Za-z0-9_$.])${head}\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`, "g");
        for (const m of l.text.matchAll(re)) {
          const full = `${head}.${m[1]}`;
          if (NOT_DOCUMENT_PATHS.has(full)) continue;
          const segments = [...prefix, ...m[1].split(".")];
          if (roots.some((root) => resolves(root, segments))) continue;
          hits.push({ file, n: l.n, text: `${full} -> r.${segments.join(".")}: in neither ops/${REGISTRY} nor ops/${MANIFEST}` });
        }
      }
    }
  }
  assert.equal(hits.length, 0, where(hits));
});

test("every alert kind the v8 runbooks name is one something emits", () => {
  // Same shape as ops/runbooks.test.mjs's rule for the older runbooks: a kind nothing emits is a row
  // that never fires, and its absence is invisible.
  const kinds = new Set();
  const keeperAlerts = readFileSync(path.join(OPS, "..", "keeper", "src", "v2", "alerts.ts"), "utf8");
  const severity = keeperAlerts.slice(keeperAlerts.indexOf("ALERT_SEVERITY"));
  for (const [, k] of severity.matchAll(/^\s{2}(v2_[a-z0-9_]+):/gm)) kinds.add(k);
  for (const [, k] of read("v2/monitor.mjs").matchAll(/\b(v2_mon_[a-z0-9_]+)\b/g)) kinds.add(k);
  assert.ok(kinds.has("v2_boot") && kinds.has("v2_mon_l2_lag"), "the alert catalogues moved; this test reads the wrong files");
  const hits = [];
  for (const h of matches([...NEW, TOPOLOGY], /`(v2_[a-z0-9_]+)`/g)) {
    const kind = h.m[1];
    if (kind.endsWith("_")) continue; // a family, written with a trailing wildcard
    if (!kinds.has(kind)) hits.push({ ...h, text: `${kind}: neither keeper/src/v2/alerts.ts nor ops/v2/monitor.mjs emits it` });
  }
  assert.ok(matches(NEW, /`(v2_mon_[a-z0-9_]+)`/g).length > 0, "the v8 runbooks no longer say what the monitor will page");
  assert.equal(hits.length, 0, where(hits));
});

test("no v8 runbook command puts a key on the command line", () => {
  // cast --private-key takes the value as an argument, so ps -axww shows it while the send runs.
  const hits = scan(NEW, (t) => /--private-key/.test(t) && !/\bnever\b|instead of|would|--account/.test(t));
  assert.equal(hits.length, 0, `use --account <keystore name>:\n${where(hits)}`);
});

// ---------------------------------------------------------------------------------------------
// 4. The bot facts incident-v2.md §4 states, against the tools that enforce them
// ---------------------------------------------------------------------------------------------

test("incident-v2.md names the bot indices and roles the tools actually use", () => {
  // ops-c07 for v8. §4 said "50 cranker, 51 pricer, 52 mmQuoter" after the v8 rewrite moved the keys
  // to 60-63 and renamed mmQuoter to quoter, so §4d's rotation told the operator to burn an index
  // the script does not have and derive-bot-keys.sh refused the name outright.
  const derive = read("v2/derive-bot-keys.sh");
  const table = /^BOTS="([\s\S]*?)"$/m.exec(derive);
  assert.ok(table, "ops/v2/derive-bot-keys.sh no longer declares its bots in a BOTS=\"…\" table");
  const bots = table[1].trim().split("\n").map((r) => r.trim().split(/\s+/));
  assert.equal(bots.length, 4, `expected four v8 bot keys, got ${bots.length}`);

  const build = read("markets/build-markets.mjs");
  const rolesLine = /const V2_BOT_ROLES = \{([^}]*)\}/.exec(build);
  assert.ok(rolesLine, "ops/markets/build-markets.mjs no longer declares V2_BOT_ROLES");
  const botRole = new Map([...rolesLine[1].matchAll(/([A-Za-z]+):\s*"([A-Z_]+)"/g)].map((m) => [m[1], m[2]]));

  const incident = read(INCIDENT);
  const from = incident.indexOf("## 4. Bot key compromise");
  assert.ok(from > 0, "incident-v2.md has no §4");
  const body = incident.slice(from, incident.indexOf("\n## 5.", from));

  for (const [bot, index] of bots) {
    assert.match(body, new RegExp(`\\b${bot}\\b`), `incident-v2.md §4 never names the bot \`${bot}\``);
    assert.match(body, new RegExp(`\\b${index}\\b[^\\n]{0,40}\\b${bot}\\b|\\b${bot}\\b[^\\n]{0,40}\\b${index}\\b`),
      `incident-v2.md §4 does not put ${bot} at index ${index} (ops/v2/derive-bot-keys.sh)`);
    const role = botRole.get(bot);
    assert.ok(roleNames.has(role), `V2_BOT_ROLES maps ${bot} to ${role}, which ops/${MANIFEST} does not define`);
    assert.match(body, new RegExp(`\\b${bot}\\b[^\\n]{0,60}\\b${role}\\b|\\b${role}\\b[^\\n]{0,60}\\b${bot}\\b`),
      `incident-v2.md §4 does not say ${bot} holds ${role} (ops/markets/build-markets.mjs V2_BOT_ROLES)`);
  }
  // The name the v8 rename removed. A §4 that still says `mmQuoter` is telling the operator to run a
  // rotation `derive-bot-keys.sh` rejects.
  assert.doesNotMatch(body, /mmQuoter(?!` is gone|\b[^\n]{0,40}\bgone\b)/,
    "incident-v2.md §4 still uses the v7 registry spelling mmQuoter");
});

test("incident-v2.md's shell block exports the addresses a v8 role operation needs", () => {
  const incident = read(INCIDENT);
  const block = incident.slice(incident.indexOf("## Shell setup"), incident.indexOf("T=NVDA"));
  for (const [name, expr] of [
    ["QUOTER", "r.v2.bots.quoter"], ["MANAGER", "c.accessManager"],
    ["SPLITTER", "r.v2.flywheel.feeSplitter"], ["BUYBACK_EXEC", "r.v2.flywheel.buybackExecutor"],
    ["SAFE_ADMIN", "r.shared.safes.admin"], ["SAFE_TREASURY", "r.shared.safes.treasury"],
  ]) {
    assert.match(block, new RegExp(`${name}:\\s*${expr.replace(/\./g, "\\.")}`),
      `incident-v2.md's shell setup does not export ${name} from ${expr}`);
  }
  assert.doesNotMatch(block, /bots\.mmQuoter/, "incident-v2.md still exports QUOTER from the non-existent v2.bots.mmQuoter");
});

test("ops/safes.md says which of it is v1 and points at the v8 pages", () => {
  const topology = read(TOPOLOGY);
  assert.match(topology, /^## 8\. INTERFACE_VERSION 8/m, "ops/safes.md has no v8 section");
  for (const h of ["## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6.", "## 7."]) {
    const line = topology.split("\n").find((t) => t.startsWith(h));
    assert.ok(line !== undefined, `ops/safes.md lost ${h}`);
    assert.match(line, /\(v1 vault\)$/, `ops/safes.md ${h} is v1 and is not marked as such`);
  }
  for (const p of ["runbooks/v8-safes.md", "runbooks/v8-roles.md"]) {
    assert.ok(topology.includes(p), `ops/safes.md §8 does not point at ${p}`);
  }
});
