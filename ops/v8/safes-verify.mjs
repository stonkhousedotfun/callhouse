/**
 * Verify the four OWN8-01 addresses before they enter the production registry.
 *
 * Dry run (the default) performs only local validation and prints the live checks that would run:
 *
 *   node ops/v8/safes-verify.mjs --intake /path/to/public-addresses.json
 *
 * Live verification is read-only. The RPC URL comes from RH_RPC so credentials never appear in argv:
 *
 *   node ops/v8/safes-verify.mjs --intake /path/to/public-addresses.json \
 *     --execute --chain-id 4663
 *
 * Add --write-back to invoke ops/markets/write-back-v8.mjs after every readback passes. This file
 * never edits tier1.json itself and never passes --force to the generator.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { plannedWrites } from "../markets/write-back-v8.mjs";
import { ABI_TEXT } from "../v2/monitor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export const DEFAULT_REGISTRY = path.join(REPO, "ops", "markets", "tier1.json");
export const DEFAULT_V7_LEGACY = path.join(REPO, "ops", "markets", "v7-legacy.json");
export const DEFAULT_DEV_REGISTRY = path.join(REPO, "ops", "markets", "dev.json");
export const DEFAULT_ROLES = path.join(REPO, "ops", "abis", "v2", "roles.json");
export const WRITE_BACK = path.join(REPO, "ops", "markets", "write-back-v8.mjs");
export const SAFE_ABI_TEXT = ABI_TEXT.safe;
const DEVNET_SOURCE = path.join(REPO, "ops", "devnet", "devnet.mjs");
const DEVNET_UP = path.join(REPO, "ops", "devnet", "up.sh");

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const EXPECTED_THRESHOLD = 2n;
const EXPECTED_OWNER_COUNT = 3;

const ROLE_LABELS = {
  adminSafe: "Admin Safe",
  treasurySafe: "Treasury Safe",
  guardian: "guardian",
  opsWallet: "ops wallet",
};

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

const lc = (value) => value.toLowerCase();

function address(value, label) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Refusal(`${label}: expected a 20-byte 0x address`);
  }
  if (lc(value) === ZERO) throw new Refusal(`${label}: zero address is not an identity`);
  return value;
}

function jsonFile(filename, label) {
  let raw;
  try {
    raw = readFileSync(filename, "utf8");
  } catch (error) {
    throw new Refusal(`${label}: cannot read ${filename}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Refusal(`${label}: ${filename} is not JSON: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

export function normalizeIntake(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Refusal("intake: expected a JSON object");
  }
  const intake = {
    adminSafe: address(raw.adminSafe, "Admin Safe"),
    treasurySafe: address(raw.treasurySafe, "Treasury Safe"),
    guardian: address(raw.guardian, "guardian"),
    opsWallet: address(raw.opsWallet, "ops wallet"),
    owners: Array.isArray(raw.owners) ? raw.owners.map((owner, i) => address(owner, `owners[${i}]`)) : null,
  };
  if (intake.owners === null) throw new Refusal("owners: expected the three Safe owner public addresses");
  if (intake.owners.length !== EXPECTED_OWNER_COUNT) {
    throw new Refusal(`owners: expected ${EXPECTED_OWNER_COUNT} public addresses, got ${intake.owners.length}`);
  }
  if (new Set(intake.owners.map(lc)).size !== EXPECTED_OWNER_COUNT) {
    throw new Refusal("owners: the three expected Safe owners are not distinct");
  }
  return intake;
}

function dotted(parts) {
  return parts.reduce((out, part) => typeof part === "number" ? `${out}[${part}]` : out ? `${out}.${part}` : part, "");
}

/** Every address in an object, with the path that makes a collision actionable. */
export function addressEntries(root, { source, skip = () => false } = {}) {
  const entries = [];
  const visit = (value, parts) => {
    if (skip(parts, value)) return;
    if (typeof value === "string") {
      if (ADDRESS_RE.test(value) && lc(value) !== ZERO) entries.push({ address: lc(value), source, path: dotted(parts) });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, [...parts, i]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, [...parts, key]);
    }
  };
  visit(root, []);
  return entries;
}

/**
 * Existing v7 facts in tier1.json. The six paths written by this intake and every v2 subtree are
 * deliberately excluded so an idempotent re-verification does not collide with itself.
 */
export function v7AddressEntries(registry) {
  const intakePaths = new Set([
    "shared.admin",
    "shared.guardian",
    "shared.opsWallet",
    "shared.safes",
  ]);
  return addressEntries(registry, {
    source: "v7 registry",
    skip: (parts) => {
      if (parts.includes("v2")) return true;
      const p = dotted(parts);
      return [...intakePaths].some((prefix) => p === prefix || p.startsWith(`${prefix}.`));
    },
  });
}

/** The dev registry is itself the authoritative inventory of identities used by the local stack. */
export function devAddressEntries(registry) {
  return addressEntries(registry, { source: "dev/test registry" });
}

/**
 * Derive every public Anvil test address from the sources that define the devnet. The mnemonic and
 * account count are intentionally not copied here: a copied deny-list is the one that goes stale.
 */
export function knownDevKeyEntries({
  devnetSource = readFileSync(DEVNET_SOURCE, "utf8"),
  upSource = readFileSync(DEVNET_UP, "utf8"),
  derive,
} = {}) {
  const mnemonic = devnetSource.match(/const ANVIL_MNEMONIC = "([^"]+)";/)?.[1];
  const countRaw = upSource.match(/--accounts\s+(\d+)/)?.[1];
  if (!mnemonic) throw new Refusal("dev/test keys: ops/devnet/devnet.mjs no longer exposes ANVIL_MNEMONIC in the expected form");
  if (!countRaw) throw new Refusal("dev/test keys: ops/devnet/up.sh no longer names the Anvil --accounts count");
  if (typeof derive !== "function") throw new Refusal("dev/test keys: no mnemonic address derivation was supplied");
  const count = Number(countRaw);
  return Array.from({ length: count }, (_, index) => ({
    address: lc(derive(mnemonic, index)),
    source: "known Anvil test key",
    path: `ops/devnet account #${index}`,
  }));
}

export function roleManifestIssues(roles) {
  const issues = [];
  const guardianRoles = roles?.holders?.guardianKey;
  if (!Array.isArray(guardianRoles)) {
    issues.push("role manifest: holders.guardianKey is absent; the supplied guardian has no manifest subject");
  } else if (guardianRoles.length !== 1 || guardianRoles[0] !== "GUARDIAN") {
    issues.push(`role manifest: holders.guardianKey must be exactly [\"GUARDIAN\"], got ${JSON.stringify(guardianRoles)}`);
  }
  if (roles?.roles?.GUARDIAN === undefined) {
    issues.push("role manifest: roles.GUARDIAN is absent; the guardian holder points at no role");
  }
  return issues;
}

export function offlineIssues({ intake, registry, v7Legacy = {}, devRegistry, roles, knownTestKeys = [] }) {
  const issues = [];
  const named = Object.entries(ROLE_LABELS).map(([key, label]) => ({ key, label, address: lc(intake[key]) }));
  const seen = new Map();
  for (const item of named) {
    const prior = seen.get(item.address);
    if (prior) issues.push(`${item.label}: duplicates ${prior}; all four OWN8-01 addresses must be pairwise distinct`);
    else seen.set(item.address, item.label);
  }

  const forbidden = [
    ...v7AddressEntries(registry),
    ...addressEntries(v7Legacy, { source: "v7 legacy registry" }),
    ...devAddressEntries(devRegistry),
    ...knownTestKeys,
  ];
  const byAddress = new Map();
  for (const entry of forbidden) {
    const list = byAddress.get(entry.address) ?? [];
    list.push(entry);
    byAddress.set(entry.address, list);
  }
  for (const item of named) {
    const collisions = byAddress.get(item.address) ?? [];
    if (collisions.length > 0) {
      issues.push(`${item.label}: ${intake[item.key]} is already present at ${collisions.map((c) => `${c.source}:${c.path}`).join(", ")}`);
    }
  }

  const chainId = registry?.shared?.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    issues.push(`registry: shared.chainId must be a positive integer, got ${JSON.stringify(chainId)}`);
  }
  issues.push(...roleManifestIssues(roles));
  return issues;
}

function shortError(error) {
  if (error instanceof Refusal) return String(error.message).split("\n")[0];
  if (typeof error?.shortMessage === "string") return error.shortMessage.split("\n")[0];
  return typeof error?.name === "string" ? error.name : "unknown error";
}

export async function verifySafe(client, { label, safe, expectedOwners, abi = SAFE_ABI_TEXT }) {
  const issues = [];
  let code;
  try {
    code = await client.getCode({ address: safe });
  } catch (error) {
    return { issues: [`${label}: bytecode read failed: ${shortError(error)}`] };
  }
  if (code === undefined || code === "0x" || /^0x0*$/.test(code)) {
    return { issues: [`${label}: ${safe} has no bytecode; it is an EOA or is not deployed`] };
  }

  let threshold;
  try {
    threshold = await client.readContract({ address: safe, abi, functionName: "getThreshold" });
  } catch (error) {
    issues.push(`${label}: getThreshold() failed: ${shortError(error)}`);
  }
  let owners;
  try {
    owners = await client.readContract({ address: safe, abi, functionName: "getOwners" });
  } catch (error) {
    issues.push(`${label}: getOwners() failed: ${shortError(error)}`);
  }
  if (issues.length > 0) return { issues };

  let thresholdValue;
  try {
    thresholdValue = BigInt(threshold);
  } catch {
    issues.push(`${label}: getThreshold() returned ${JSON.stringify(threshold)}, not an integer`);
  }
  if (thresholdValue !== undefined && thresholdValue !== EXPECTED_THRESHOLD) {
    issues.push(`${label}: threshold is ${thresholdValue}, expected ${EXPECTED_THRESHOLD}`);
  }

  if (!Array.isArray(owners)) {
    issues.push(`${label}: getOwners() did not return an address array`);
    return { issues };
  }
  const observed = owners.map((owner, i) => {
    try { return lc(address(owner, `${label} owner[${i}]`)); }
    catch (error) { issues.push(error.message); return null; }
  }).filter(Boolean);
  if (observed.length !== EXPECTED_OWNER_COUNT) {
    issues.push(`${label}: owner count is ${observed.length}, expected ${EXPECTED_OWNER_COUNT}`);
  }
  const wanted = expectedOwners.map(lc);
  const missing = wanted.filter((owner) => !observed.includes(owner));
  const unexpected = observed.filter((owner) => !wanted.includes(owner));
  if (missing.length > 0) issues.push(`${label}: missing expected owner(s) ${missing.join(", ")}`);
  if (unexpected.length > 0) issues.push(`${label}: unexpected owner(s) ${unexpected.join(", ")}`);
  return { issues, threshold: thresholdValue, owners: observed };
}

export async function verifyOnChain({ client, intake, expectedChainId }) {
  let actualChainId;
  try {
    actualChainId = Number(await client.getChainId());
  } catch (error) {
    return { issues: [`RPC chain id: read failed: ${shortError(error)}`], safes: [] };
  }
  if (actualChainId !== expectedChainId) {
    return {
      issues: [`RPC chain id: connected to ${actualChainId}, expected ${expectedChainId}; no Safe was read and no registry write is allowed`],
      safes: [],
    };
  }

  const safes = await Promise.all([
    verifySafe(client, { label: "Admin Safe", safe: intake.adminSafe, expectedOwners: intake.owners }),
    verifySafe(client, { label: "Treasury Safe", safe: intake.treasurySafe, expectedOwners: intake.owners }),
  ]);
  return { actualChainId, safes, issues: safes.flatMap((safe) => safe.issues) };
}

export function writeBackRecord(intake) {
  return {
    safes: { admin: intake.adminSafe, treasury: intake.treasurySafe },
    wallets: { guardian: intake.guardian, opsWallet: intake.opsWallet },
    bots: { guardian: intake.guardian },
  };
}

export function writeBackPaths(intake) {
  return plannedWrites(writeBackRecord(intake)).map(([p]) => p);
}

/** Invoke the existing generator. The verified public addresses are the only temporary content. */
export function writeRegistryThroughGenerator({ intake, registryPath, spawn = spawnSync }) {
  const dir = mkdtempSync(path.join(tmpdir(), "stonkhouse-safe-intake-"));
  const recordPath = path.join(dir, "verified-addresses.json");
  try {
    writeFileSync(recordPath, `${JSON.stringify(writeBackRecord(intake), null, 2)}\n`, { mode: 0o600 });
    const result = spawn(process.execPath, [WRITE_BACK, "--deployment", recordPath, "--registry", registryPath], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw new Refusal(`registry generator did not start: ${shortError(result.error)}`);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
      throw new Refusal(`registry generator refused the verified intake:\n${detail}`);
    }
    return result.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = {
    intake: null,
    registry: DEFAULT_REGISTRY,
    v7Legacy: DEFAULT_V7_LEGACY,
    devRegistry: DEFAULT_DEV_REGISTRY,
    roles: DEFAULT_ROLES,
    rpcEnv: "RH_RPC",
    chainId: null,
    execute: false,
    writeBack: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Refusal(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") opts.execute = true;
    else if (arg === "--write-back") opts.writeBack = true;
    else if (arg === "--intake") opts.intake = value(i++, arg);
    else if (arg === "--registry") opts.registry = value(i++, arg);
    else if (arg === "--v7-legacy") opts.v7Legacy = value(i++, arg);
    else if (arg === "--dev-registry") opts.devRegistry = value(i++, arg);
    else if (arg === "--roles") opts.roles = value(i++, arg);
    else if (arg === "--rpc-env") opts.rpcEnv = value(i++, arg);
    else if (arg === "--chain-id") {
      const raw = value(i++, arg);
      opts.chainId = Number(raw);
      if (!Number.isSafeInteger(opts.chainId) || opts.chainId <= 0) throw new Refusal(`--chain-id must be a positive integer, got ${JSON.stringify(raw)}`);
    } else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Refusal(`unknown argument: ${arg}`);
  }
  return opts;
}

const USAGE = `usage: node ops/v8/safes-verify.mjs --intake <public-addresses.json> [options]

Default: local dry run; no RPC and no registry write.
  --execute             perform read-only chain verification
  --chain-id <id>       required with --execute; must match registry and RPC
  --write-back          with --execute, invoke ops/markets/write-back-v8.mjs
  --rpc-env <name>      environment variable holding the RPC URL (default RH_RPC)
  --registry <path>     production registry (default ops/markets/tier1.json)
  --v7-legacy <path>    frozen v7 registry (default ops/markets/v7-legacy.json)
  --dev-registry <path> dev/test identity inventory (default ops/markets/dev.json)
  --roles <path>        role manifest (default ops/abis/v2/roles.json)`;

function viemClient(rpc) {
  let viem;
  try {
    viem = createRequire(path.join(REPO, "keeper", "package.json"))("viem");
  } catch {
    throw new Refusal("viem is not resolvable from keeper/: dependency missing; do not install or patch node_modules from this task");
  }
  const abi = viem.parseAbi(SAFE_ABI_TEXT);
  const client = viem.createPublicClient({ transport: viem.http(rpc, { timeout: 30_000, retryCount: 1 }) });
  return {
    getChainId: () => client.getChainId(),
    getCode: (args) => client.getCode(args),
    readContract: (args) => client.readContract({ ...args, abi }),
  };
}

function deriveKnownTestKeys() {
  let mnemonicToAccount;
  try {
    ({ mnemonicToAccount } = createRequire(path.join(REPO, "keeper", "package.json"))("viem/accounts"));
  } catch {
    throw new Refusal("cannot derive the known Anvil test keys from keeper/viem: dependency missing; do not install or patch node_modules from this task");
  }
  return knownDevKeyEntries({ derive: (mnemonic, index) => mnemonicToAccount(mnemonic, { addressIndex: index }).address });
}

function printIssues(prefix, issues) {
  if (issues.length === 0) return;
  throw new Refusal(`${prefix}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!opts.intake) throw new Refusal(`--intake is required\n\n${USAGE}`);
  if (opts.writeBack && !opts.execute) throw new Refusal("--write-back requires --execute; an unverified address set never reaches the registry generator");

  const intake = normalizeIntake(jsonFile(path.resolve(opts.intake), "intake"));
  const registryPath = path.resolve(opts.registry);
  const registry = jsonFile(registryPath, "registry");
  const v7Legacy = jsonFile(path.resolve(opts.v7Legacy), "v7 legacy registry");
  const devRegistry = jsonFile(path.resolve(opts.devRegistry), "dev/test registry");
  const roles = jsonFile(path.resolve(opts.roles), "role manifest");
  const knownTestKeys = deriveKnownTestKeys();
  printIssues("offline intake refused", offlineIssues({ intake, registry, v7Legacy, devRegistry, roles, knownTestKeys }));

  const registryChainId = registry.shared.chainId;
  console.log(`PLAN: verify two 2-of-3 Safes and two distinct hot identities on chain ${registryChainId}`);
  console.log(`  Admin Safe: ${intake.adminSafe}`);
  console.log(`  Treasury Safe: ${intake.treasurySafe}`);
  console.log(`  guardian: ${intake.guardian} (roles.holders.guardianKey -> GUARDIAN)`);
  console.log(`  ops wallet: ${intake.opsWallet}`);
  console.log(`  expected Safe owners: ${intake.owners.join(", ")}`);
  console.log(`  generator paths: ${writeBackPaths(intake).join(", ")}`);

  if (!opts.execute) {
    console.log("DRY RUN: no RPC calls and no registry writes. Re-run with --execute and the explicit --chain-id; add --write-back only after inspecting the readback.");
    return;
  }
  if (opts.chainId === null) throw new Refusal("--execute requires --chain-id; a readback from an unidentified chain proves nothing");
  if (opts.chainId !== registryChainId) {
    throw new Refusal(`--chain-id ${opts.chainId} disagrees with registry shared.chainId ${registryChainId}; no RPC call made`);
  }
  const rpc = env[opts.rpcEnv];
  if (typeof rpc !== "string" || rpc.length === 0) {
    throw new Refusal(`--execute requires the RPC URL in environment variable ${opts.rpcEnv}; it is never accepted on argv`);
  }

  const result = await verifyOnChain({ client: viemClient(rpc), intake, expectedChainId: opts.chainId });
  printIssues("live Safe verification refused", result.issues);
  console.log(`LIVE PASS: RPC chain id ${result.actualChainId}`);
  console.log(`LIVE PASS: Admin Safe is ${result.safes[0].threshold}-of-${result.safes[0].owners.length} with the exact expected owners`);
  console.log(`LIVE PASS: Treasury Safe is ${result.safes[1].threshold}-of-${result.safes[1].owners.length} with the exact expected owners`);

  if (!opts.writeBack) {
    console.log("WRITE-BACK NOT REQUESTED: tier1.json is unchanged. Re-run the same verified intake with --execute --write-back to invoke the existing generator.");
    return;
  }
  const output = writeRegistryThroughGenerator({ intake, registryPath });
  if (output) console.log(output);
  console.log("WRITE-BACK PASS: ops/markets/write-back-v8.mjs accepted the verified intake");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${error instanceof Refusal ? "REFUSED" : "ERROR"}: ${shortError(error)}${String(error?.message ?? "").includes("\n") ? `\n${String(error.message).split("\n").slice(1).join("\n")}` : ""}`);
    process.exitCode = error instanceof Refusal ? 1 : 2;
  });
}
