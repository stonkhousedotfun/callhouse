#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * The copy-vs-contracts ABI drift check.
 *
 * ops/abis/v2 is the app's copy of the contracts' interfaces: the indexer, web and keeper generators render it
 * into typed modules, and every in-repo guard (indexer eventCoverage.test.ts, keeper abi-conformance.test.ts, each
 * package's gen-abis --check) compares against THAT copy. Nothing compared the copy with the contracts, so after
 * the 00:39 export the contracts gained HouseVault.PerformanceFeeBpsApplied and EarnVault.LimitsSet and every
 * guard here stayed green.
 *
 * This reads the contracts' OWN compiled output, never a regenerated copy:
 *   <contracts>/script/v2/abi-manifest.txt     the names export-abis.sh publishes (same parse rules)
 *   <contracts>/out/<Name>.sol/<Name>.json     `.abi` of each, as export-abis.sh renders it
 *   <contracts>/script/v2/roles.v8.json        the source of ops/abis/v2/roles.json
 * and compares item by item (functions, events, errors, constructor) with ops/abis/v2/<Name>.json.
 *
 * OUT/ MUST BE BUILT FROM THE CHECKOUT IT SITS IN. A checkout on another commit with an old out/ yields artifacts
 * that parse and are wrong. So before comparing, every source file named in each artifact's metadata is hashed
 * (keccak256, as solc records it) and must equal the file on disk; one mismatch refuses the whole run (exit 2).
 *
 * One line per drifted item, then a summary:
 *   ADDED    <Name> <kind> <signature>   the contracts have it, the copy does not
 *   REMOVED  <Name> <kind> <signature>   the copy has it, the contracts no longer do
 *   CHANGED  <Name> <kind> <signature>   same signature, different detail (indexed, outputs, mutability, names)
 *   ORDER    <Name>                      same items, different order: the generators would emit different bytes
 *   MISSING  <Name>                      in the manifest, no ops/abis/v2/<Name>.json
 *   STALE    <Name>                      ops/abis/v2/<Name>.json is not in the manifest
 *   ROLES    roles <path>                ops/abis/v2/roles.json differs from script/v2/roles.v8.json there
 *
 * The fix for any drift is a regen commit in callhouse (contracts script/v2/export-abis.sh --callhouse <tree>,
 * which also re-runs the web/indexer/keeper generators), never an allowlist.
 *
 *   node ops/v2/abi-drift.mjs --contracts <contracts-checkout> [--abis <dir>]
 *
 * Exit codes: 0 no drift; 1 drift (every item named); 2 bad arguments, or the contracts output cannot be trusted
 * (manifest or artifact missing, out/ not built from this checkout).
 * ------------------------------------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ABIS = path.resolve(HERE, "../abis/v2");
const ROLES_NAME = "roles";

// --- keccak256 (Keccak-f[1600], the pre-NIST padding solc uses; node:crypto has only SHA3) --------------------
const MASK = (1n << 64n) - 1n;
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RC = (() => {
  // The round constants from the spec's LFSR, rather than 24 typed hex values.
  let r = 1;
  const bit = () => {
    const out = r & 1;
    r = r & 0x80 ? ((r << 1) ^ 0x71) & 0xff : (r << 1) & 0xff;
    return out;
  };
  return Array.from({ length: 24 }, () => {
    let c = 0n;
    for (let j = 0; j < 7; j++) if (bit()) c |= 1n << BigInt((1 << j) - 1);
    return c;
  });
})();
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(a) {
  const c = new Array(5);
  const b = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    }
    a[0] ^= RC[round];
  }
}

/** keccak256 of bytes (Buffer/Uint8Array or a utf8 string), as a 0x-prefixed hex string. */
export function keccak256(input) {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const rate = 136;
  const padded = Buffer.alloc((Math.floor(data.length / rate) + 1) * rate);
  data.copy(padded);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) state[i] ^= padded.readBigUInt64LE(off + 8 * i);
    keccakF(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], 8 * i);
  return `0x${out.toString("hex")}`;
}

// --- inputs ---------------------------------------------------------------------------------------------------
/** script/v2/abi-manifest.txt, parsed exactly as export-abis.sh parses it ('#' comments, one identifier a line). */
export function parseManifest(text) {
  const names = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(line)) throw new Error(`abi-manifest.txt:${i + 1}: '${line}' is not a contract name`);
    if (names.includes(line)) throw new Error(`abi-manifest.txt:${i + 1}: ${line} is listed twice`);
    names.push(line);
  });
  if (names.length === 0) throw new Error("abi-manifest.txt lists no names");
  return names;
}

/**
 * Every source an artifact was compiled from must hash to what solc recorded, or out/ belongs to another tree.
 * Returns the problems (empty when fresh). `cache` maps a relative path to its hash so shared imports hash once.
 */
export function staleSources(contractsDir, artifact, cache = new Map()) {
  const sources = artifact.metadata?.sources;
  if (!sources || typeof sources !== "object" || Object.keys(sources).length === 0) {
    return ["artifact has no metadata.sources: cannot tell which tree built it"];
  }
  const problems = [];
  for (const [rel, { keccak256: recorded } = {}] of Object.entries(sources)) {
    if (!cache.has(rel)) {
      const file = path.join(contractsDir, rel);
      cache.set(rel, existsSync(file) ? keccak256(readFileSync(file)) : null);
    }
    const now = cache.get(rel);
    if (now === null) problems.push(`${rel} is not in the checkout`);
    else if (now !== recorded) problems.push(`${rel} changed since it was compiled`);
  }
  return problems;
}

// --- ABI items ------------------------------------------------------------------------------------------------
const canonicalType = (p) =>
  p.type.startsWith("tuple") ? `(${(p.components ?? []).map(canonicalType).join(",")})${p.type.slice(5)}` : p.type;
const params = (list, withIndexed) =>
  (list ?? []).map((p) => [canonicalType(p), withIndexed && p.indexed ? "indexed" : "", p.name].filter(Boolean).join(" ")).join(", ");

/** "event Foo(uint256,address)": the identity an item is matched by across the two ABIs. */
export function itemKey(item) {
  if (item.type === "fallback" || item.type === "receive") return item.type;
  const name = item.type === "constructor" ? "" : ` ${item.name}`;
  return `${item.type}${name}(${(item.inputs ?? []).map(canonicalType).join(",")})`;
}

/** Everything a decoder or a caller depends on beyond the key, readable in a CHANGED line. */
export function describe(item) {
  switch (item.type) {
    case "function":
      return `${item.name}(${params(item.inputs)}) ${item.stateMutability} returns (${params(item.outputs)})`;
    case "event":
      return `${item.name}(${params(item.inputs, true)})${item.anonymous ? " anonymous" : ""}`;
    case "error":
      return `${item.name}(${params(item.inputs)})`;
    default:
      return `${item.type}(${params(item.inputs)})${item.stateMutability ? ` ${item.stateMutability}` : ""}`;
  }
}

/** The drift lines for one contract: `expected` is the contracts' ABI, `copy` the ops/abis/v2 file. */
export function diffAbi(name, expected, copy) {
  const lines = [];
  const index = (abi) => new Map(abi.map((item) => [itemKey(item), item]));
  const want = index(expected);
  const have = index(copy);
  for (const [key, item] of want) {
    if (!have.has(key)) lines.push(`ADDED    ${name} ${key}`);
    else if (!isDeepStrictEqual(item, have.get(key))) {
      const was = describe(have.get(key));
      const now = describe(item);
      lines.push(`CHANGED  ${name} ${key}: ${was === now ? "internalType or other metadata differs" : `was ${was}; now ${now}`}`);
    }
  }
  for (const key of have.keys()) if (!want.has(key)) lines.push(`REMOVED  ${name} ${key}`);
  if (lines.length === 0 && !isDeepStrictEqual(expected, copy)) {
    lines.push(`ORDER    ${name}: same items in a different order (the generators would emit different bytes)`);
  }
  return lines;
}

/** Paths (a.b[2].c) at which two JSON values differ, at most `limit` of them. */
function jsonDiffPaths(a, b, at = "", out = [], limit = 20) {
  if (out.length >= limit || isDeepStrictEqual(a, b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      jsonDiffPaths(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k, out, limit);
    }
    return out;
  }
  out.push(at || "(root)");
  return out;
}

// --- the check ------------------------------------------------------------------------------------------------
/**
 * Compare `abisDir` with the contracts checkout. Returns { drift: string[], errors: string[], names: string[] }.
 * `errors` are reasons the comparison cannot be trusted; when there are any, `drift` is empty.
 */
export function checkDrift({ contractsDir, abisDir = DEFAULT_ABIS }) {
  const errors = [];
  const manifestPath = path.join(contractsDir, "script/v2/abi-manifest.txt");
  if (!existsSync(manifestPath)) return { drift: [], errors: [`no manifest at ${manifestPath}`], names: [] };
  let names;
  try {
    names = parseManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { drift: [], errors: [error.message], names: [] };
  }
  if (!existsSync(abisDir)) return { drift: [], errors: [`no ABI copy directory at ${abisDir}`], names };

  const expected = new Map();
  const cache = new Map();
  for (const name of names) {
    const rel = `out/${name}.sol/${name}.json`;
    const file = path.join(contractsDir, rel);
    if (!existsSync(file)) {
      errors.push(`missing artifact ${rel} for manifest entry ${name}: run forge build in ${contractsDir}`);
      continue;
    }
    const artifact = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(artifact.abi)) {
      errors.push(`${rel} has no .abi array`);
      continue;
    }
    const stale = staleSources(contractsDir, artifact, cache);
    if (stale.length) {
      errors.push(`${rel} was not built from this checkout (${stale.slice(0, 3).join("; ")}${stale.length > 3 ? `; +${stale.length - 3} more` : ""}): run forge build in ${contractsDir}`);
      continue;
    }
    expected.set(name, artifact.abi);
  }
  const rolesSource = path.join(contractsDir, "script/v2/roles.v8.json");
  if (!existsSync(rolesSource)) errors.push(`no roles manifest at ${rolesSource}`);
  if (errors.length) return { drift: [], errors, names };

  const drift = [];
  for (const [name, abi] of expected) {
    const file = path.join(abisDir, `${name}.json`);
    if (!existsSync(file)) {
      drift.push(`MISSING  ${name}: in script/v2/abi-manifest.txt, no ops/abis/v2/${name}.json`);
      continue;
    }
    drift.push(...diffAbi(name, abi, JSON.parse(readFileSync(file, "utf8"))));
  }
  for (const entry of readdirSync(abisDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (name !== ROLES_NAME && !names.includes(name)) {
      drift.push(`STALE    ${name}: ops/abis/v2/${entry} is not in script/v2/abi-manifest.txt`);
    }
  }
  const rolesCopy = path.join(abisDir, `${ROLES_NAME}.json`);
  if (!existsSync(rolesCopy)) drift.push(`MISSING  ${ROLES_NAME}: no ops/abis/v2/${ROLES_NAME}.json`);
  else {
    const paths = jsonDiffPaths(JSON.parse(readFileSync(rolesSource, "utf8")), JSON.parse(readFileSync(rolesCopy, "utf8")));
    for (const p of paths) drift.push(`ROLES    ${ROLES_NAME} ${p}: ops/abis/v2/roles.json differs from script/v2/roles.v8.json`);
  }
  return { drift, errors, names };
}

/** "<sha>" or "<sha> (uncommitted changes)" for a git checkout; "no git" for an export. */
function describeCheckout(dir) {
  try {
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirty ? `${sha} (uncommitted changes)` : sha;
  } catch {
    return "no git";
  }
}

export function main(argv = process.argv.slice(2), out = console) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? null : v;
  };
  const contracts = flag("--contracts");
  const abis = flag("--abis");
  if (!contracts || abis === null) {
    out.error("usage: node ops/v2/abi-drift.mjs --contracts <contracts-checkout> [--abis <dir>]");
    return 2;
  }
  const contractsDir = path.resolve(contracts);
  const abisDir = abis ? path.resolve(abis) : DEFAULT_ABIS;
  const { drift, errors, names } = checkDrift({ contractsDir, abisDir });
  if (errors.length) {
    for (const e of errors) out.error(`abi-drift: ${e}`);
    out.error(`abi-drift: cannot compare; nothing was checked against ${abisDir}`);
    return 2;
  }
  out.log(`abi-drift: contracts ${contractsDir} @ ${describeCheckout(contractsDir)}; ${names.length} manifest ABIs + roles vs ${abisDir}`);
  if (drift.length === 0) {
    out.log(`abi-drift: no drift (${names.length} ABIs + roles.json match the contracts' compiled output)`);
    return 0;
  }
  for (const line of drift) out.log(line);
  // Every line is "<TAG> <Name> ...": the second token is the file.
  const files = new Set(drift.map((line) => line.split(/\s+/)[1].replace(/:$/, "")));
  out.error(`abi-drift: ${drift.length} drifted item(s) in ${files.size} file(s). Fix with a regen commit in callhouse (contracts script/v2/export-abis.sh --callhouse <this tree>), not a waiver.`);
  return 1;
}

const isMain = process.argv[1] && String(process.argv[1]).endsWith("abi-drift.mjs");
if (isMain) process.exitCode = main();
