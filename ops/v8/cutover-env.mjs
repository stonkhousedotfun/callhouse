#!/usr/bin/env node
/**
 * ops/v8/cutover-env.mjs — OWN8-05: the v8 service env, with bot keys that cannot be v7's or a dev
 * stack's, and the list of state that resets with the new deploy block, derived from the code.
 *
 *   node ops/v8/cutover-env.mjs                                       # DRY RUN (the default): every check, the plan
 *   node ops/v8/cutover-env.mjs --keys-dir ~/.callhouse-keys/v8       # where the v8 key FILES live (a reference)
 *   node ops/v8/cutover-env.mjs --bots refs.json                      # other references per bot (see BOT REFERENCES)
 *   node ops/v8/cutover-env.mjs --forbid FILE                         # one more env/registry nothing may be reused from
 *   node ops/v8/cutover-env.mjs --execute --chain-id 4663 --out DIR   # write the cutover packet into DIR
 *   node ops/v8/cutover-env.mjs --reset-state                         # print only the deploy-block derivation
 *
 * Runbook: ops/runbooks/v8-cutover.md. Tests: node --test ops/v8/cutover-env.test.mjs
 *
 * WHY. OWN8-05 deploys the v8 services with NEW bot keys, none shared with v7 or with any dev stack
 * (06-QUIRKS §G). v7 runs off beside v8, so a shared key makes a v7 incident a v8 incident and two
 * processes on one key race on its nonce. That rule was, until this file, something to remember. Now
 * it is a refusal: every v8 bot's address and every key reference it is given is looked up in the
 * v7 and dev environments (and v1's, which is stricter than asked and costs nothing), and a hit
 * refuses, naming the stack and the file and line it was found at.
 *
 * WHAT A "KEY" IS HERE. This tool never sees a key. It compares IDENTIFIERS:
 *   address         the bot's EOA — the one identifier a reused key cannot hide, whatever it is called
 *   mnemonic index  "ops mnemonic index N": two stacks on one index of the ops phrase are one key
 *   key file        a ~/.callhouse-keys/... path: two stacks reading one file are one key
 * An env file that holds a raw key is scanned for these and nothing else; no line of any scanned file
 * is ever printed, only the identifier (public by construction), the file, the line and the variable.
 *
 * WHAT IT REFUSES (exit 1), all at once, in the dry run as well:
 *   - a registry that is not the v8 production one: `_dev`, interface version not 8, no chain id;
 *   - a null or malformed v2.deployBlock. build-markets' completeness rule is SILENT while the block is
 *     null (a pre-deploy registry is legitimately empty), so this refuses the null itself rather than
 *     trusting a check that cannot see an undeployed registry;
 *   - any required-when-deployed slot still null (validateDeployedCompleteness, imported, not restated);
 *   - a v8 deploy block at or below v7's, and any v8 contract address that is also a v7 one: both say
 *     the registry is a copy of v7, the "prod == dev today" trap (IMPACT-app §13);
 *   - a v8 bot with no address, two bots on one address, a bot that is also a v8 contract or Safe;
 *   - a v8 bot address or key reference found in any reuse source;
 *   - a reuse source that is missing or yields fewer identifiers than it must: a check that cannot see
 *     the v7 bots is a check that passes, so it is a refusal, not a clean result;
 *   - a render of ops/v2-env.mjs that fails, lacks a service, or does not carry the v8 deploy block;
 *   - (default registry only) committed ops/v2/env/*.env that differ from that render: go-live-v2.sh
 *     would refuse later, so this refuses now;
 *   - a deploy-block reader in the code that RESET_RULES does not classify, or a rule whose file no
 *     longer reads the block (see RESET STATE).
 *
 * WHAT IT NEVER DOES. No chain call, no Railway call, no network at all, no key generation, no key
 * read. It spawns ops/v2-env.mjs (the one env renderer — a second one here would drift) and, for the
 * packet manifest only, `git rev-parse`. The dry run renders into a temporary directory and removes it.
 * `--execute` writes the packet into --out and nowhere else; it refuses without `--chain-id` equal to
 * the registry's chain, refuses an --out inside the repository or one that is not empty, refuses while
 * any check above refuses, and reads every written file back before it reports success.
 *
 * BOT REFERENCES. By default each bot is the registry's v2.bots.<bot> address plus the two references
 * ops/v2/derive-bot-keys.sh gives it: its mnemonic index (read from that script's BOTS table, not
 * restated) and <keys-dir>/<bot>.env. --keys-dir defaults to $CALLHOUSE_V2_KEYS_DIR, else
 * ~/.callhouse-keys/v8 — the same default derive-bot-keys.sh and go-live-v2.sh use (T-477 moved the
 * v8 bots there; ~/.callhouse-keys/v2 holds v7's key files and is never a v8 default). The reuse
 * check still refuses a v2 key file if one is named explicitly, which is the guard that matters: the
 * default no longer points at v7, so an operator who forgets the export gets the v8 directory rather
 * than a refusal naming v7. --bots FILE overrides per bot:
 *   { "cranker": { "address": "0x…", "keys": ["~/.callhouse-keys/v8/cranker.env", "ops mnemonic index 60"] } }
 * A value that looks like key material (64 hex digits, or twelve or more words) is refused unread.
 *
 * RESET STATE. The list of state that resets when the deploy block changes is DERIVED: every tracked
 * source file (ts, tsx, mjs, js, cjs, sh, py, env; tests, fixtures, docs, contracts/ and dependency
 * trees excluded) is scanned for READER_PATTERN, and each file found must be classified by exactly
 * one RESET_RULES entry. A new reader nobody classified refuses, naming the line — that is the
 * "unlisted reset is a silent data gap" failure OWN8-05 exists to prevent. A rule whose file no longer
 * reads the block refuses too, so the list cannot keep describing code that has gone. What the
 * derivation cannot find (state that survives BECAUSE nothing reads the block) is NOT_DERIVED, a short
 * hand list, printed under its own heading so nobody mistakes it for derived.
 *
 * Node 22+, no npm dependencies.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateDeployedCompleteness } from "../markets/build-markets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, "../..");

export const REGISTRY = "ops/markets/tier1.json";
export const V7_REGISTRY = "ops/markets/v7-legacy.json";
const DERIVE_BOT_KEYS = "ops/v2/derive-bot-keys.sh";
const GO_LIVE = "ops/go-live-v2.sh";
const V2_ENV = "ops/v2-env.mjs";
const COMMITTED_ENV_DIR = "ops/v2/env";

/**
 * Where a reused identifier would come from. `floor` is the fail-loud part: a source yielding fewer
 * identifiers of a kind than this cannot see what it is there to see, and is a refusal. The floors
 * are what each source has always had (three v7 bots, four dev bots), not tuning.
 */
export const REUSE_SOURCES = [
  { stack: "v7", kind: "registry", path: V7_REGISTRY, bots: 3 },
  // The env the v7 services actually run on is not committed: it is ops/v2-env.mjs over the v7
  // registry. Render it rather than describe it.
  { stack: "v7", kind: "render", registry: V7_REGISTRY, floor: { "mnemonic-index": 3, keyfile: 3 } },
  { stack: "dev", kind: "registry", path: "ops/markets/dev.json", bots: 3 },
  { stack: "dev", kind: "env-dir", path: "ops/v2/env-dev", floor: { address: 1 } },
  { stack: "v1", kind: "env-dir", path: "ops/keeper/markets", floor: { address: 1, "mnemonic-index": 1 } },
];

/* ---------------------------------------------------------------------------------------------- */
/*  identifiers                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

const ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const INDEX_RE = /\bmnemonic index (\d+)\b/gi;
const HOME_ALTERNATIVES = ["~", "\\$HOME", "\\$\\{HOME\\}", os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")];
const KEYFILE_RE = new RegExp(`(?:${HOME_ALTERNATIVES.join("|")})/\\.callhouse-keys/[A-Za-z0-9._/-]+`, "g");

/** `$HOME/.callhouse-keys//v8/cranker.env.` -> `~/.callhouse-keys/v8/cranker.env`; a directory is not a key. */
export function normalizeKeyfile(ref) {
  let v = String(ref).replace(/^(?:\$HOME|\$\{HOME\})/, "~");
  if (v.startsWith(os.homedir())) v = `~${v.slice(os.homedir().length)}`;
  v = v.replace(/\/{2,}/g, "/").replace(/[.,;:)]+$/, "");
  return v.endsWith("/") || !/\/\.callhouse-keys\/./.test(v) ? null : v;
}

const idKey = (kind, value) => `${kind}:${value}`;

/** Every identifier on every line of a text file: {kind, value, where, variable}. Never the line itself. */
export function textIdentifiers(text, label) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const where = `${label}:${i + 1}`;
    const variable = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? null;
    for (const m of line.matchAll(ADDRESS_RE)) out.push({ kind: "address", value: m[0].toLowerCase(), where, variable });
    for (const m of line.matchAll(INDEX_RE)) out.push({ kind: "mnemonic-index", value: String(Number(m[1])), where, variable });
    for (const m of line.matchAll(KEYFILE_RE)) {
      const value = normalizeKeyfile(m[0]);
      if (value) out.push({ kind: "keyfile", value, where, variable });
    }
  });
  return out;
}

/** The same over a parsed JSON document, located by dotted path; a numeric `*KeyIndex` is a mnemonic index. */
export function jsonIdentifiers(doc, label) {
  const out = [];
  const walk = (node, at) => {
    if (typeof node === "string") {
      for (const id of textIdentifiers(node, label)) out.push({ ...id, where: `${label} ${at}`, variable: null });
    } else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${at}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        const here = at ? `${at}.${k}` : k;
        if (/keyindex$/i.test(k) && Number.isInteger(v)) out.push({ kind: "mnemonic-index", value: String(v), where: `${label} ${here}`, variable: null });
        else walk(v, here);
      }
    }
  };
  walk(doc, "");
  return out;
}

/** 64 hex digits (a private key) or a run of twelve or more words (a phrase). Checked BEFORE parsing. */
export function looksLikeKeyMaterial(value) {
  const s = String(value);
  return /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?:$|[^0-9a-fA-F])/.test(s) || /(?:\b[a-z]{3,8}\b[\s,]+){11,}\b[a-z]{3,8}\b/.test(s);
}

/* ---------------------------------------------------------------------------------------------- */
/*  the reuse sources                                                                              */
/* ---------------------------------------------------------------------------------------------- */

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const count = (ids, kind) => ids.filter((x) => x.kind === kind).length;

/** Render ops/v2-env.mjs over `registryFile` into a fresh temp dir; {files: {name: text}} or {error}. */
export function renderEnv(root, registryFile, outDir = null) {
  const dir = outDir ?? mkdtempSync(path.join(os.tmpdir(), "cutover-env-"));
  try {
    const r = spawnSync(process.execPath, [path.join(root, V2_ENV), "--registry", registryFile, "--out", dir], { encoding: "utf8", timeout: 60_000 });
    if (r.error) return { error: `${V2_ENV} could not run: ${r.error.message}` };
    if (r.status !== 0) return { error: `${V2_ENV} --registry ${path.relative(root, registryFile)} exited ${r.status}: ${(r.stderr || "").trim().split("\n").slice(-3).join(" / ")}` };
    const files = {};
    for (const name of readdirSync(dir).sort()) if (name.endsWith(".env")) files[name] = readFileSync(path.join(dir, name), "utf8");
    return { files };
  } finally {
    if (!outDir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every identifier the v7, dev and v1 stacks (plus any --forbid file) already use, as a Map
 * `kind:value` -> [{stack, where, variable}], and the problems that make it blind.
 */
export function collectForbidden(root, { extra = [] } = {}) {
  const index = new Map();
  const problems = [];
  const summary = [];
  const add = (stack, ids) => {
    for (const id of ids) {
      const k = idKey(id.kind, id.value);
      if (!index.has(k)) index.set(k, []);
      index.get(k).push({ stack, where: id.where, variable: id.variable });
    }
  };
  const floors = (source, label, ids) => {
    for (const [kind, min] of Object.entries(source.floor ?? {})) {
      const n = count(ids, kind);
      if (n < min) problems.push(`reuse source ${label} yields ${n} ${kind} identifier(s), at least ${min} expected: the reuse check cannot see the ${source.stack} stack through it`);
    }
  };
  for (const source of REUSE_SOURCES) {
    if (source.kind === "registry") {
      const file = path.join(root, source.path);
      if (!existsSync(file)) { problems.push(`reuse source ${source.path} (${source.stack}) is missing: the reuse check cannot see the ${source.stack} bots`); continue; }
      let doc;
      try { doc = readJson(file); } catch (e) { problems.push(`reuse source ${source.path} does not parse: ${e.message}`); continue; }
      const bots = Object.values(doc?.v2?.bots ?? {}).filter((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a));
      if (bots.length < source.bots) problems.push(`reuse source ${source.path} names ${bots.length} bot address(es) under v2.bots, at least ${source.bots} expected: the ${source.stack} bots are invisible to the reuse check`);
      const ids = jsonIdentifiers(doc, source.path);
      add(source.stack, ids);
      summary.push(`${source.stack} registry ${source.path}: ${count(ids, "address")} address(es), ${bots.length} bot(s)`);
    } else if (source.kind === "render") {
      const reg = path.join(root, source.registry);
      if (!existsSync(reg)) { problems.push(`cannot render the ${source.stack} service env: ${source.registry} is missing`); continue; }
      const r = renderEnv(root, reg);
      if (r.error) { problems.push(`cannot render the ${source.stack} service env: ${r.error}`); continue; }
      const label = `${source.stack} service env rendered by ${V2_ENV} from ${source.registry}`;
      const ids = Object.entries(r.files).flatMap(([name, text]) => textIdentifiers(text, `${source.stack}-env/${name}`));
      floors(source, label, ids);
      add(source.stack, ids);
      summary.push(`${label}: ${Object.keys(r.files).length} file(s), ${count(ids, "mnemonic-index")} mnemonic index ref(s), ${count(ids, "keyfile")} key file ref(s)`);
    } else if (source.kind === "env-dir") {
      const dir = path.join(root, source.path);
      const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".env")).sort() : [];
      if (names.length === 0) { problems.push(`reuse source ${source.path}/ (${source.stack}) has no .env files: the reuse check cannot see the ${source.stack} stack`); continue; }
      const ids = names.flatMap((n) => textIdentifiers(readFileSync(path.join(dir, n), "utf8"), `${source.path}/${n}`));
      floors(source, `${source.path}/`, ids);
      add(source.stack, ids);
      summary.push(`${source.stack} env ${source.path}/: ${names.length} file(s), ${count(ids, "address")} address(es), ${count(ids, "mnemonic-index")} mnemonic index ref(s)`);
    }
  }
  for (const file of extra) {
    const abs = path.resolve(file);
    if (!existsSync(abs)) { problems.push(`--forbid ${file} does not exist`); continue; }
    const text = readFileSync(abs, "utf8");
    let ids;
    try { ids = file.endsWith(".json") ? jsonIdentifiers(JSON.parse(text), file) : textIdentifiers(text, file); }
    catch (e) { problems.push(`--forbid ${file} does not parse: ${e.message}`); continue; }
    if (ids.length === 0) problems.push(`--forbid ${file} yields no address, mnemonic index or key file reference: it would forbid nothing`);
    add("forbid", ids);
    summary.push(`--forbid ${file}: ${ids.length} identifier(s)`);
  }
  return { index, problems, summary };
}

/* ---------------------------------------------------------------------------------------------- */
/*  the v8 bots                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/** ops/v2/derive-bot-keys.sh's BOTS table: [{bot, index, variable}]. The indices live there, not here. */
export function parseDeriveBots(text) {
  const block = /^BOTS="([\s\S]*?)"/m.exec(text);
  if (!block) throw new Error(`${DERIVE_BOT_KEYS} has no BOTS="..." table`);
  const rows = block[1].split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/));
  const bots = rows.map(([bot, index, variable, ...rest]) => {
    if (!bot || !/^\d+$/.test(index ?? "") || !/^[A-Z][A-Z0-9_]*_PK$/.test(variable ?? "") || rest.length) {
      throw new Error(`${DERIVE_BOT_KEYS} BOTS row "${[bot, index, variable, ...rest].join(" ")}" is not "<bot> <index> <VAR>_PK"`);
    }
    return { bot, index: Number(index), variable };
  });
  for (const want of ["cranker", "pricer", "quoter", "guardian"]) {
    if (!bots.some((b) => b.bot === want)) throw new Error(`${DERIVE_BOT_KEYS} BOTS table has no ${want} row`);
  }
  return bots;
}

/** go-live-v2.sh's service table: bot -> service that holds its key. */
export function parseGoLiveBots(text) {
  const lines = text.split("\n");
  const open = lines.findIndex((l) => l === 'TABLE="');
  if (open < 0) throw new Error(`${GO_LIVE} no longer opens its service table with a bare TABLE="`);
  const map = new Map();
  for (let i = open + 1; i < lines.length && lines[i] !== '"'; i += 1) {
    const row = lines[i].trim().split(/\s+/);
    if (row.length >= 10 && row[8] !== "-") map.set(row[8], { service: row[0], variable: row[9] });
  }
  if (map.size < 3) throw new Error(`only ${map.size} key-holding services parsed out of the ${GO_LIVE} table`);
  return map;
}

export const defaultKeysDir = (env = process.env) => normalizeKeyfile(`${env.CALLHOUSE_V2_KEYS_DIR || "~/.callhouse-keys/v8"}/x`)?.replace(/\/x$/, "") ?? null;

/**
 * The v8 bots with the identifiers each one must not share: [{bot, variable, index, address, refs}]
 * (`refs` are {kind, value}), plus problems. Nothing here reads a key.
 */
export function v8Bots({ derive, registry, keysDir, overrides = {} }) {
  const problems = [];
  const out = [];
  for (const { bot, index, variable } of derive) {
    const o = overrides[bot] ?? {};
    const address = o.address ?? registry?.v2?.bots?.[bot] ?? null;
    let refs = [{ kind: "mnemonic-index", value: String(index) }, { kind: "keyfile", value: `${keysDir}/${bot}.env` }];
    if (o.keys !== undefined) {
      refs = [];
      for (const [i, k] of [].concat(o.keys).entries()) {
        const ids = textIdentifiers(String(k), `--bots ${bot}.keys[${i}]`).filter((x) => x.kind !== "address");
        if (ids.length === 0) problems.push(`--bots ${bot}.keys[${i}] is not a reference this tool can compare (a ~/.callhouse-keys/... path or "ops mnemonic index N")`);
        refs.push(...ids.map(({ kind, value }) => ({ kind, value })));
      }
    }
    if (address === null) problems.push(`v2.bots.${bot} is null: no v8 ${bot} address to check (derive it: CALLHOUSE_V2_KEYS_DIR=<v8 dir> ${DERIVE_BOT_KEYS} ${bot})`);
    else if (!/^0x[0-9a-fA-F]{40}$/.test(address)) problems.push(`the v8 ${bot} address is not an address`);
    out.push({ bot, variable, index, address, refs });
  }
  const seen = new Map();
  for (const b of out) {
    if (!b.address) continue;
    const a = b.address.toLowerCase();
    if (seen.has(a)) problems.push(`v8 bots ${seen.get(a)} and ${b.bot} share address ${b.address}: one key per process (two on one key race on its nonce)`);
    else seen.set(a, b.bot);
  }
  return { bots: out, problems };
}

/** Parse and screen a --bots file. Key material refuses before anything is parsed or echoed. */
export function readBotsFile(file) {
  const text = readFileSync(file, "utf8");
  if (looksLikeKeyMaterial(text)) return { problems: [`--bots ${file} holds something shaped like key material (64 hex digits or a word phrase): this tool takes references, never keys. Not read further, not printed.`] };
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { problems: [`--bots ${file} is not JSON: ${e.message}`] }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { problems: [`--bots ${file} must be an object keyed by bot`] };
  return { overrides: doc, problems: [] };
}

/** One problem per v8 identifier found in a reuse source, naming every place it was found. */
export function checkReuse(bots, forbidden) {
  const problems = [];
  for (const b of bots) {
    const ids = [...(b.address ? [{ kind: "address", value: b.address.toLowerCase() }] : []), ...b.refs];
    for (const id of ids) {
      const hits = forbidden.get(idKey(id.kind, id.value));
      if (!hits) continue;
      const shown = id.kind === "address" ? b.address : id.kind === "mnemonic-index" ? `ops mnemonic index ${id.value}` : id.value;
      const at = hits.slice(0, 4).map((h) => `${h.stack}: ${h.where}${h.variable ? ` (${h.variable})` : ""}`).join("; ");
      const stacks = [...new Set(hits.map((h) => h.stack))].join(", ");
      problems.push(`KEY REUSE ${b.bot}: ${id.kind} ${shown} already appears in the ${stacks} stack — ${at}${hits.length > 4 ? `; and ${hits.length - 4} more` : ""}`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------------------------------------- */
/*  the registry                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

const isBlock = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^[1-9][0-9]*$/.test(v));

/** Everything that says this is not a deployed v8 production registry, or that it is a copy of v7. */
export function checkRegistry(registry, v7) {
  const problems = [];
  if (Object.hasOwn(registry, "_dev")) problems.push("the registry carries `_dev`: it describes a local devnet, not the v8 production deployment");
  if (Number(registry?.v2?.interfaceVersion) !== 8) problems.push(`registry v2.interfaceVersion is ${JSON.stringify(registry?.v2?.interfaceVersion)}, not 8`);
  const chainId = registry?.shared?.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) problems.push("registry shared.chainId is not a chain id");
  const block = registry?.v2?.deployBlock;
  // validateDeployedCompleteness returns NOTHING while this is null: refuse the null here, or an
  // undeployed registry would pass every check below by having nothing to check.
  if (block === null || block === undefined) problems.push("registry v2.deployBlock is null: the v8 deployment has not been written back (ops/markets/write-back-v8.mjs)");
  else if (!isBlock(block)) problems.push(`registry v2.deployBlock ${JSON.stringify(block)} is not a block number`);
  const issues = [];
  validateDeployedCompleteness(registry, issues);
  problems.push(...issues);
  const v7Block = v7?.v2?.deployBlock;
  if (!isBlock(v7Block)) problems.push(`${V7_REGISTRY} has no v2.deployBlock: cannot tell the v8 block from v7's`);
  else if (isBlock(block) && BigInt(block) <= BigInt(v7Block)) {
    problems.push(`registry v2.deployBlock ${block} is ${BigInt(block) === BigInt(v7Block) ? "v7's own deploy block" : `below v7's ${v7Block}`}: this is not the v8 deployment`);
  }
  const v7Contracts = new Map();
  const flat = (o, at, into) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v && typeof v === "object") flat(v, `${at}.${k}`, into);
      else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) into.set(v.toLowerCase(), `${at}.${k}`);
    }
  };
  flat(v7?.v2?.contracts, "v2.contracts", v7Contracts);
  const v8Contracts = new Map();
  flat(registry?.v2?.contracts, "v2.contracts", v8Contracts);
  for (const [a, at] of v8Contracts) {
    if (v7Contracts.has(a)) problems.push(`registry ${at} ${a} is v7's ${v7Contracts.get(a)}: the v8 registry still names a v7 contract`);
  }
  return problems;
}

/** A bot that is also a v8 contract or Safe signs as that contract's key holder: refuse it. */
export function checkBotsAgainstProtocol(bots, registry) {
  const protocol = new Map();
  const put = (o, at) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v && typeof v === "object") put(v, `${at}.${k}`);
      else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) protocol.set(v.toLowerCase(), `${at}.${k}`);
    }
  };
  put(registry?.v2?.contracts, "v2.contracts");
  put({ feeSplitter: registry?.v2?.flywheel?.feeSplitter, buybackExecutor: registry?.v2?.flywheel?.buybackExecutor }, "v2.flywheel");
  put(registry?.shared?.safes, "shared.safes");
  return bots.filter((b) => b.address && protocol.has(b.address.toLowerCase()))
    .map((b) => `v8 ${b.bot} ${b.address} is also ${protocol.get(b.address.toLowerCase())}`);
}

/** The render must be complete and must carry the v8 block, or it is not the v8 env. */
export function checkRender(files, registry, registryLabel) {
  const problems = [];
  for (const name of ["indexer-v2.env", "pricing.env", "cranker.env", "pricer.env", "mm-bot.env", "notifier.env"]) {
    const text = files[name];
    if (text === undefined) { problems.push(`${V2_ENV} rendered no ${name}`); continue; }
    const header = text.split("\n")[1] ?? "";
    if (!header.includes(`from ${registryLabel} `) || !header.includes("(v2 interface version 8)")) problems.push(`${name} was not rendered from ${registryLabel} at interface version 8: "${header.slice(0, 120)}"`);
  }
  const block = registry?.v2?.deployBlock;
  if (isBlock(block) && files["indexer-v2.env"] !== undefined && !files["indexer-v2.env"].split("\n").includes(`V2_START_BLOCK=${block}`)) {
    problems.push(`indexer-v2.env does not carry V2_START_BLOCK=${block}: the v8 indexer would start from another block`);
  }
  return problems;
}

/* ---------------------------------------------------------------------------------------------- */
/*  reset state: derived from the code                                                             */
/* ---------------------------------------------------------------------------------------------- */

/** What counts as reading the deploy block: the registry field, the env variables, Ponder's key. */
export const READER_PATTERN = /\b(?:deployBlock|deploy_block|DEPLOY_BLOCK|[A-Z0-9_]*START_BLOCK|startBlock)\b/;
const SCAN_EXT = /\.(?:ts|tsx|mjs|js|cjs|sh|py|env)$/;
const SKIP_DIRS = new Set([".git", "node_modules", "contracts", "dist", ".next", "out", "cache", "coverage", ".ponder", ".turbo"]);
const SKIP_FILE = /\.(?:test|spec)\.|\.fixture\.|(?:^|\/)(?:tests?|__tests__|fixtures)\//;

/**
 * Every deploy-block reader, classified. `effect`:
 *   resets      state keyed on the block that the code discards and rebuilds from the new one
 *   projection  the block is copied into an artifact that must be regenerated and redeployed
 *   none        reads the block, holds no cutover state (v1, v7 pins, devnet and rehearsal tools, types)
 * `path` is exact; a `path` ending in "/" is a prefix. Each rule must match at least one reader.
 * `failed` says what a failed reset looks like, because a reset that did not happen reads as quiet.
 */
export const RESET_RULES = [
  // ---- signing bots (keeper) ----
  { path: "keeper/src/v2/anchor.ts", effect: "resets", state: "The signing modes' SQLite stores (/data/cranker.db, /data/pricer.db, /data/mm-bot.db). The deployment anchor `<v2.deployBlock>:<hash>` changes, so each mode clears its cursors, adopted orders and done-marks on its first v8 boot",
    failed: "no `changed` anchor warning on a mode's first v8 boot (it kept v7 state), one on EVERY boot (the anchor is not persisting), or an `unset` warning (the image's registry has no v2.deployBlock)" },
  { path: "keeper/src/v2/cranker/cranker.ts", effect: "resets", state: "The cranker reads the deployment anchor at boot (anchor.ts)" },
  { path: "keeper/src/v2/cranker/steps.ts", effect: "resets", state: "The cranker's log index starts at v2.deployBlock: the v8 cranker never sees a v7 series (those are the v7 cranker's, v7 image and v7 registry)",
    failed: "the cranker's first index pass starts at block 0 (registry deployBlock null in the image) or below the v8 block" },
  { path: "keeper/src/v2/cranker/scanner.ts", effect: "resets", state: "The cranker log index's first block when empty is v2.deployBlock" },
  { path: "keeper/src/v2/mm/quoter.ts", effect: "resets", state: "The MM bot reads the anchor at boot and starts its series and fill scans at v2.deployBlock" },
  { path: "keeper/src/v2/mm/series-index.ts", effect: "resets", state: "The MM series index cursor floors at v2.deployBlock" },
  { path: "keeper/src/v2/mm/fills.ts", effect: "resets", state: "The MM fill history, and so the realised PnL the daily loss limit reads, restarts at the v8 block: no v7 fill is carried",
    failed: "the MM bot reports a realised PnL on its first v8 day that includes v7 fills" },
  { path: "keeper/src/v2/pricer/pricer.ts", effect: "resets", state: "The pricer reads the anchor at boot and scans StrategySet from v2.deployBlock: v7 auto-roll asks are not repriced by the v8 pricer" },
  { path: "keeper/src/v2/registry.ts", effect: "none", state: "Parses v2.deployBlock and v2.flywheel.deployBlock out of the baked registry; the readers above act on it" },
  { path: "keeper/src/v2/cranker/devnet-cycle.ts", effect: "none", state: "Local devnet acceptance driver" },
  { path: "keeper/src/v2/mm/devnet-mm.ts", effect: "none", state: "Local devnet acceptance driver" },
  { path: "keeper/src/v2/pricer/devnet-reprice.ts", effect: "none", state: "Local devnet acceptance driver" },

  // ---- indexer ----
  { path: "indexer/lib/env.ts", effect: "resets", state: "V2_START_BLOCK (and V2_FLYWHEEL_, V2_EARN_, V2_HOUSE_START_BLOCK) start every v2 source. A new Railway deployment indexes into a fresh schema, so the whole v2 index is rebuilt from the v8 block. ops/v2-env.mjs does NOT render V2_EARN_START_BLOCK or V2_HOUSE_START_BLOCK",
    failed: "/v2/config.deployBlock is not the v8 block, or /ready never turns 200 because the backfill started far below the deployment" },
  { path: "indexer/ponder.config.ts", effect: "resets", state: "Every v2 contract source's startBlock comes from the env blocks above" },
  { path: "indexer/src/v2/pnl.ts", effect: "resets", state: "The PnL clock starts at V2_START_BLOCK: v7 realised PnL is not in the v8 index" },
  { path: "indexer/src/api/v2/markets.ts", effect: "resets", state: "/v2/config.deployBlock, the input to the notifier's deployment anchor" },
  { path: "indexer/src/api/v2/schema.ts", effect: "none", state: "The /v2/config type" },
  { path: "indexer/src/v2/orderBook.ts", effect: "none", state: "Names V2_START_BLOCK twice in prose only: the F-APP-INDEXER-04 comment and the FundingSet throw message, both of which tell an operator that a start block later than the OrderBook deploy is one cause of the gap they are looking at. No start block is read, compared or stored here",
    failed: "this rule is stale if the handler starts reading a block value instead of only naming one" },
  { path: "indexer/lib/v2/marketRegistry.generated.ts", effect: "projection", state: "Registry deployBlock baked into the indexer image (the /v2/config fallback): regenerate with indexer/scripts/gen-v2-registry.mjs and rebuild" },
  { path: "indexer/scripts/gen-v2-registry.mjs", effect: "projection", state: "Generates indexer/lib/v2/marketRegistry.generated.ts" },
  { path: "indexer/lib/deployment.ts", effect: "none", state: "v1 START_BLOCK (legacy vault): not the v8 block" },
  { path: "indexer/lib/factoryIndexing.ts", effect: "none", state: "v1 START_BLOCK (legacy factory): not the v8 block" },
  { path: "indexer/lib/indexing.ts", effect: "none", state: "v1 START_BLOCK (legacy vault): not the v8 block" },
  { path: "indexer/src/factory.ts", effect: "none", state: "v1 START_BLOCK (legacy factory): not the v8 block" },
  { path: "indexer/src/vault.ts", effect: "none", state: "v1 START_BLOCK (legacy vault): not the v8 block" },
  { path: "indexer/scripts/fork-sync.ts", effect: "none", state: "v1 fork-sync harness" },
  { path: "indexer/scripts/fork-sync/", effect: "none", state: "v1 fork-sync harness" },
  { path: "indexer/scripts/v2-devnet-check.ts", effect: "none", state: "Offline check against a devnet" },
  { path: "indexer/scripts/v2-dev-readonly-check.ts", effect: "none", state: "Offline read-only check of a deployment against its registry" },
  { path: "indexer/scripts/lender-epoch.mjs", effect: "none", state: "Operator epoch tool; names v2.deployBlock in a message" },

  // ---- notifier ----
  { path: "notifier/src/rules/indexer.ts", effect: "resets", state: "The notifier's deployment anchor `chainId:interfaceVersion:deployBlock` (rules_state.anchor). On its first read of the v8 indexer the engine drops the activity cursor and stored holdings; v7 holders get no further notices from a notifier pointed at the v8 indexer",
    failed: "no `deployment anchor changed; resetting activity cursor` log on the first tick against the v8 indexer (it still reads the v7 indexer, or /v2/config failed and the anchor was left)" },

  // ---- ops ----
  { path: "ops/v2/monitor.mjs", effect: "resets", state: "The monitor state file is named after the Clearinghouse (monitor-<chain>-<clearinghouse>.json) and fingerprinted with the deploy block: v8 starts a fresh file, every change detector (roles, Safes, feeds) re-baselines and cannot report a change made before its first pass, and log scans floor at v2.deployBlock",
    failed: "the v8 monitor's state path carries the v7 Clearinghouse, or MONITOR_STATE_PATH pins an old file" },
  { path: "ops/v2-env.mjs", effect: "projection", state: "Renders V2_START_BLOCK and V2_FLYWHEEL_START_BLOCK into indexer-v2.env (not V2_EARN_/V2_HOUSE_START_BLOCK)" },
  { path: "ops/v2/env/indexer-v2.env", effect: "projection", state: "The production indexer env: V2_START_BLOCK must be the v8 block after the write-back re-render",
    failed: "V2_START_BLOCK= is empty, or is 65780341 (v7's)" },
  { path: "ops/v2/env-dev/indexer-v2.env", effect: "projection", state: "The local-devnet indexer env (dev.json)" },
  { path: "ops/v8/launch-packet.mjs", effect: "projection", state: "The owner launch packet reports v2.deployBlock: regenerate after the write-back" },
  { path: "ops/v8/freeze-v7.mjs", effect: "none", state: "Reads v2.deployBlock out of ops/markets/v7-legacy.json and uses it as the fromBlock of every freeze and run-off log scan. That is the V7 deploy block: v7Targets refuses any registry whose v2.interfaceVersion is not 7, so this file cannot be pointed at the v8 registry and the v8 block never reaches it",
    failed: "this rule is stale if the interfaceVersion === 7 guard in v7Targets is removed or the script learns to read tier1.json" },
  { path: "ops/markets/render-docs.mjs", effect: "projection", state: "Market docs pages render deploy blocks: re-render after the write-back" },
  { path: "ops/markets/build-markets.mjs", effect: "none", state: "Validates v2.deployBlock and the deployed-completeness rule" },
  { path: "ops/markets/write-back-v8.mjs", effect: "none", state: "Writes the new v2.deployBlock: the change itself" },
  { path: "ops/go-live-v2.sh", effect: "none", state: "Preflight: refuses a null v2.deployBlock and one above the chain head" },
  { path: "ops/v2/wave.mjs", effect: "none", state: "Mentions v2.deployBlock in a comment" },
  { path: "ops/v2/dev_deploy.py", effect: "none", state: "Dev deploy driver: writes a dev registry's block" },
  { path: "ops/v2/finish-dev-deploy.sh", effect: "none", state: "Dev deploy driver" },
  { path: "ops/v2/fake-chain.mjs", effect: "none", state: "Test double" },
  { path: "ops/devnet/", effect: "none", state: "Local anvil devnet" },
  { path: "ops/v2/rehearse/", effect: "none", state: "Fork rehearsal harness" },
  { path: "ops/v1-runoff-rehearse.sh", effect: "none", state: "v1 run-off rehearsal" },
  { path: "ops/go-live-app.sh", effect: "none", state: "v1 go-live (vault START_BLOCK)" },
  { path: "ops/keeper-env.sh", effect: "none", state: "v1 keeper env renderer" },
  { path: "ops/v8/cutover-env.mjs", effect: "none", state: "This tool" },

  // ---- web ----
  { path: "web/scripts/gen-markets.mjs", effect: "projection", state: "Generates web/lib/markets.generated.ts" },
  { path: "web/lib/markets.generated.ts", effect: "projection", state: "V2_REGISTRY.deployBlock is baked into the web build: regenerate and REBUILD web; a variable change alone ships the old block" },
  { path: "web/lib/v7/config.ts", effect: "none", state: "Pins the v7 deployment (block 65780341) for the run-off pages. It must NOT move to the v8 block",
    failed: "web/lib/v7/config.ts carries the v8 block" },
  { path: "web/lib/markets.ts", effect: "none", state: "v1 market deployment.deployBlock" },
  { path: "web/app/docs/page.tsx", effect: "none", state: "Displays v1 market deploy blocks" },
  { path: "web/lib/v2/api-schema.ts", effect: "none", state: "The /v2/config type" },
  { path: "web/lib/v2/api-types.ts", effect: "none", state: "The /v2/config type" },
];

/**
 * NOT DERIVED. State that survives the cutover BECAUSE nothing reads the deploy block, so the scan
 * above cannot find it. Kept short and labelled; each names where the fact is written down.
 */
export const NOT_DERIVED = [
  "DATABASE_VIEWS_SCHEMA=callhouse_v2 is a fixed name (ops/v2-env.mjs indexer-v2): a v7 indexer kept for the run-off must not share the v8 database",
  "The /data volume FILES survive a redeploy; the anchor resets their content (above), it does not delete them",
  "Railway variables survive a redeploy: a MAKER_VAULT or V2_* address left on a reused service stops the bot at boot (keeper/src/v2/config.ts refuses a registry disagreement)",
  "Per-market registeredAt / registerTx / v2.status are registry data, reset by the write-back and the OWN8-06 registrations (build-markets.mjs refuses a live market without them)",
];

/** Walk `root` for deploy-block readers: [{file, lines: [n...]}]. */
export function scanReaders(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); continue; }
      if (!SCAN_EXT.test(e.name) || SKIP_FILE.test(rel)) continue;
      const lines = [];
      readFileSync(abs, "utf8").split("\n").forEach((l, i) => { if (READER_PATTERN.test(l)) lines.push(i + 1); });
      if (lines.length) out.push({ file: rel, lines });
    }
  };
  walk(root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const ruleMatches = (rule, file) => (rule.path.endsWith("/") ? file.startsWith(rule.path) : file === rule.path);

/** The derivation: every reader classified, or a problem naming what is not. */
export function deriveResetState(root, rules = RESET_RULES) {
  const problems = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return { readers: [], classified: [], problems: [`scan root ${root} is not a directory`] };
  const readers = scanReaders(root);
  if (readers.length === 0) problems.push(`no deploy-block reader found under ${root}: the scan is blind (wrong root?), not clean`);
  const classified = [];
  for (const r of readers) {
    const hits = rules.filter((rule) => ruleMatches(rule, r.file));
    if (hits.length === 0) problems.push(`UNCLASSIFIED deploy-block reader ${r.file}:${r.lines.join(",")}: add it to RESET_RULES in ops/v8/cutover-env.mjs (resets / projection / none) before the cutover`);
    else if (hits.length > 1) problems.push(`${r.file} is classified by ${hits.length} RESET_RULES entries (${hits.map((h) => h.path).join(", ")}): exactly one`);
    else classified.push({ ...r, rule: hits[0] });
  }
  for (const rule of rules) {
    if (!readers.some((r) => ruleMatches(rule, r.file))) problems.push(`STALE RESET_RULES entry ${rule.path}: no file there reads the deploy block any more; re-derive, do not keep describing code that has gone`);
  }
  return { readers, classified, problems };
}

export function formatResetState({ readers, classified }) {
  const lines = [
    `DERIVATION: ${readers.reduce((n, r) => n + r.lines.length, 0)} line(s) in ${readers.length} file(s) match ${READER_PATTERN}`,
    "  (ts tsx mjs js cjs sh py env; tests, fixtures, docs, contracts/ and dependency trees excluded)",
    ...readers.map((r) => `  ${r.file}:${r.lines.join(",")}`),
    "",
  ];
  for (const [effect, title] of [
    ["resets", "RESETS WITH THE NEW DEPLOY BLOCK"],
    ["projection", "PROJECTIONS TO REGENERATE AND REDEPLOY"],
    ["none", "READS THE BLOCK, HOLDS NO CUTOVER STATE"],
  ]) {
    const rows = classified.filter((c) => c.rule.effect === effect);
    lines.push(`${title} (${rows.length} file(s)):`);
    for (const c of rows) {
      lines.push(`  - ${c.file}: ${c.rule.state}.`);
      if (c.rule.failed) lines.push(`      Failed looks like: ${c.rule.failed}.`);
    }
    lines.push("");
  }
  lines.push("NOT DERIVED — survives because nothing reads the block (hand list):", ...NOT_DERIVED.map((s) => `  - ${s}.`));
  return `${lines.join("\n")}\n`;
}

/* ---------------------------------------------------------------------------------------------- */
/*  arguments and main                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export class UsageError extends Error {}

export function parseArgs(argv) {
  const a = { execute: false, chainId: null, out: null, registry: null, bots: null, keysDir: null, forbid: [], resetState: false, root: null, help: false };
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === "--execute") a.execute = true;
    else if (f === "--chain-id") { const v = need(i, f); i += 1; if (!/^[1-9][0-9]*$/.test(v)) throw new UsageError("--chain-id must be a positive integer"); a.chainId = Number(v); }
    else if (f === "--out") { a.out = need(i, f); i += 1; }
    else if (f === "--registry") { a.registry = need(i, f); i += 1; }
    else if (f === "--bots") { a.bots = need(i, f); i += 1; }
    else if (f === "--keys-dir") { a.keysDir = need(i, f); i += 1; }
    else if (f === "--forbid") { a.forbid.push(need(i, f)); i += 1; }
    else if (f === "--root") { a.root = need(i, f); i += 1; }
    else if (f === "--reset-state") a.resetState = true;
    else if (f === "-h" || f === "--help") a.help = true;
    else throw new UsageError(`unknown argument ${f}`);
  }
  if (a.execute && a.resetState) throw new UsageError("--reset-state only prints; it takes no --execute");
  return a;
}

const USAGE = "usage: node ops/v8/cutover-env.mjs [--registry FILE] [--keys-dir DIR] [--bots FILE] [--forbid FILE]... [--execute --chain-id N --out DIR] | --reset-state\n";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function gitHead(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const dirty = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  if (r.status !== 0) return "not a git checkout";
  return `${r.stdout.trim()}${dirty.status === 0 && dirty.stdout.trim() ? " (DIRTY)" : ""}`;
}

function botSheet(bots, services, keysDir) {
  const lines = [
    "# v8 bot keys — REFERENCES ONLY. No key is in this file, and none was read to write it.",
    `# Derive:  CALLHOUSE_V2_KEYS_DIR=${keysDir} ${DERIVE_BOT_KEYS}`,
    `# Go live: CALLHOUSE_V2_KEYS_DIR=${keysDir} ${GO_LIVE} ...   (it refuses a key file that does not derive to the address below)`,
    "#",
    "# bot       service   variable        address                                     references",
  ];
  for (const b of bots) {
    const svc = services.get(b.bot)?.service ?? "(none: held off Railway)";
    const refs = b.refs.map((r) => (r.kind === "mnemonic-index" ? `ops mnemonic index ${r.value}` : r.value)).join("; ");
    lines.push(`${b.bot.padEnd(10)} ${svc.padEnd(9)} ${b.variable.padEnd(15)} ${String(b.address ?? "null").padEnd(43)} ${refs}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The whole run. Returns the exit code: 0 clean (and, with --execute, written and read back), 1 refused,
 * 2 usage. Writes only under --out, and only with --execute.
 */
export function main(argv, { root = DEFAULT_ROOT, env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { stderr.write(`cutover-env: ${e.message}\n${USAGE}`); return 2; }
    throw e;
  }
  if (args.help) { stdout.write(USAGE); return 0; }
  root = path.resolve(args.root ?? root);

  const derived = deriveResetState(root);
  if (args.resetState) {
    stdout.write(formatResetState(derived));
    if (derived.problems.length) { stderr.write(`REFUSED: ${derived.problems.length} problem(s)\n${derived.problems.map((p) => `  - ${p}`).join("\n")}\n`); return 1; }
    return 0;
  }

  const problems = [];
  const registryFile = path.resolve(root, args.registry ?? REGISTRY);
  const registryLabel = path.relative(root, registryFile);
  let registry = null;
  let v7 = null;
  try { registry = readJson(registryFile); } catch (e) { problems.push(`registry ${registryLabel}: ${e.message}`); }
  try { v7 = readJson(path.join(root, V7_REGISTRY)); } catch (e) { problems.push(`${V7_REGISTRY}: ${e.message}`); }
  if (registry) problems.push(...checkRegistry(registry, v7));

  let derive = [];
  let services = new Map();
  try { derive = parseDeriveBots(readFileSync(path.join(root, DERIVE_BOT_KEYS), "utf8")); } catch (e) { problems.push(e.message); }
  try { services = parseGoLiveBots(readFileSync(path.join(root, GO_LIVE), "utf8")); } catch (e) { problems.push(e.message); }

  const keysDir = args.keysDir ? normalizeKeyfile(`${args.keysDir}/x`)?.replace(/\/x$/, "") : defaultKeysDir(env);
  if (!keysDir) problems.push(`--keys-dir ${args.keysDir} is not under ~/.callhouse-keys/: key file references there cannot be compared`);
  let overrides = {};
  if (args.bots) {
    const r = readBotsFile(path.resolve(args.bots));
    problems.push(...r.problems);
    overrides = r.overrides ?? {};
  }
  const { bots, problems: botProblems } = v8Bots({ derive, registry, keysDir: keysDir ?? "?", overrides });
  problems.push(...botProblems);
  if (registry) problems.push(...checkBotsAgainstProtocol(bots, registry));

  const forbidden = collectForbidden(root, { extra: args.forbid });
  problems.push(...forbidden.problems, ...checkReuse(bots, forbidden.index));

  const render = registry ? renderEnv(root, registryFile) : { error: "no registry" };
  if (render.error) problems.push(`cannot render the v8 service env: ${render.error}`);
  else {
    problems.push(...checkRender(render.files, registry, registryLabel));
    // The committed files are what go-live-v2.sh sets. Compare them with the renderer's own gate, not
    // with the temp render above: line 1 of every render names the directory it was written to.
    if (registryFile === path.join(root, REGISTRY)) {
      const r = spawnSync(process.execPath, [path.join(root, V2_ENV), "--check"], { encoding: "utf8", timeout: 60_000 });
      if (r.status !== 0) {
        const why = (r.error?.message ?? r.stderr ?? "").trim().split("\n").slice(0, 3).join(" / ");
        problems.push(`${V2_ENV} --check fails, so the committed ${COMMITTED_ENV_DIR}/*.env that go-live-v2.sh sets are not this registry's render: ${why}`);
      }
    }
  }
  problems.push(...derived.problems);

  const block = registry?.v2?.deployBlock ?? null;
  const report = [
    `cutover-env: ${args.execute ? "EXECUTE" : "DRY RUN — nothing is written; --execute --chain-id <id> --out <dir> writes the packet"}`,
    `registry ${registryLabel}: interface ${registry?.v2?.interfaceVersion ?? "?"}, chain ${registry?.shared?.chainId ?? "?"}, deploy block ${block ?? "null"} (v7: ${v7?.v2?.deployBlock ?? "?"})`,
    `key files referenced under ${keysDir ?? "?"} (never opened)`,
    "reuse sources:",
    ...forbidden.summary.map((s) => `  ${s}`),
    "v8 bots:",
    ...bots.map((b) => `  ${b.bot.padEnd(9)} ${String(b.address ?? "null").padEnd(43)} ${b.refs.map((r) => (r.kind === "mnemonic-index" ? `index ${r.value}` : r.value)).join(" | ")}`),
    render.files ? `service env: ${Object.keys(render.files).length} file(s) rendered by ${V2_ENV} from ${registryLabel}` : "service env: not rendered",
    `reset state: ${derived.classified.length} of ${derived.readers.length} deploy-block reader file(s) classified (--reset-state prints the list)`,
  ];
  stdout.write(`${report.join("\n")}\n`);

  if (args.execute) {
    if (args.chainId === null) problems.push("--execute needs --chain-id, equal to the registry's shared.chainId");
    else if (registry && args.chainId !== registry?.shared?.chainId) problems.push(`--chain-id ${args.chainId} is not the registry's chain ${registry?.shared?.chainId}`);
    if (!args.out) problems.push("--execute needs --out DIR");
    else {
      const out = path.resolve(args.out);
      const rel = path.relative(root, out);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) problems.push(`--out ${args.out} is inside the repository: the packet is an operator artifact, not a commit`);
      if (existsSync(out) && readdirSync(out).length) problems.push(`--out ${args.out} is not empty: this never overwrites`);
    }
  }

  if (problems.length) {
    stderr.write(`REFUSED: ${problems.length} problem(s)${args.execute ? "; nothing written" : ""}\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    return 1;
  }
  if (!args.execute) { stdout.write("DRY RUN clean: every check passed. Nothing written.\n"); return 0; }

  const out = path.resolve(args.out);
  // The env goes straight from the renderer into the packet, so its first line names where it is.
  // It must then equal the render every check above ran against, first line aside.
  const envOut = path.join(out, "env");
  mkdirSync(envOut, { recursive: true });
  const written = renderEnv(root, registryFile, envOut);
  const body = (t) => t.slice(t.indexOf("\n") + 1);
  const envFailures = written.error ? [written.error] : [
    ...checkRender(written.files, registry, registryLabel),
    ...Object.keys(render.files).filter((n) => written.files[n] === undefined || body(written.files[n]) !== body(render.files[n])).map((n) => `env/${n} differs from the render that was checked`),
  ];
  if (envFailures.length) { stderr.write(`FAILED writing the env into ${envOut}:\n${envFailures.map((p) => `  - ${p}`).join("\n")}\n`); return 1; }
  const packet = {
    ...Object.fromEntries(Object.entries(written.files).map(([n, t]) => [`env/${n}`, t])),
    "bot-keys.txt": botSheet(bots, services, keysDir),
    "reset-state.txt": formatResetState(derived),
  };
  packet["MANIFEST.txt"] = [
    "# OWN8-05 cutover packet (ops/v8/cutover-env.mjs). No key material anywhere in it.",
    `source ${gitHead(root)}`,
    `registry ${registryLabel} sha256 ${sha256(readFileSync(registryFile, "utf8"))}`,
    `chain ${registry.shared.chainId} deploy block ${block}`,
    ...Object.entries(packet).map(([n, t]) => `sha256 ${sha256(t)}  ${n}`),
    "",
  ].join("\n");
  for (const [name, text] of Object.entries(packet)) if (!name.startsWith("env/")) writeFileSync(path.join(out, name), text);
  // Read back: a packet that did not land as written is not a packet.
  const bad = Object.entries(packet).filter(([name, text]) => !existsSync(path.join(out, name)) || readFileSync(path.join(out, name), "utf8") !== text).map(([n]) => n);
  if (bad.length) { stderr.write(`FAILED: ${bad.length} file(s) did not read back as written: ${bad.join(", ")}\n`); return 1; }
  stdout.write(`written and read back: ${Object.keys(packet).length} file(s) in ${out}\n`);
  return 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
