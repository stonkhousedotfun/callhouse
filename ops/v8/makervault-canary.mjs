/**
 * OWN8-07: set and read back the MakerVault canary limits FIRST, then fund the vault from the Treasury Safe.
 *
 * The risk this exists for is funding an unlimited vault. `MakerVault.deposit` is permissionless
 * (contracts/src/v2/mm/MakerVault.sol:251) so nobody can pull USDG back out by sending another transaction;
 * only DEFAULT_ADMIN_ROLE `withdraw` can, and that is the Admin Safe with a delay. So the ordering is not a
 * suggestion in a runbook, it is structural here: the funding instruction is minted by {fundingPlan}, which
 * accepts only a proof object that {verifyLimits} mints in the SAME process run, only after a field-by-field
 * readback of `limits()` from chain matched the registry. Nothing else can produce that proof, so there is no
 * argument order, no flag and no typo that emits a funding step on an unverified vault.
 *
 * This file NEVER submits a transaction. It has no signing path, no `cast send`, no Safe client. `--execute`
 * means "perform the live READ-ONLY verification"; the owner executes every state change from the Safe UI,
 * following ops/runbooks/v8-makervault.md.
 *
 *   node ops/v8/makervault-canary.mjs                                  # dry run (default): offline plan, no RPC
 *   node ops/v8/makervault-canary.mjs --execute --chain-id 4663        # live readback of limits(), read-only
 *   node ops/v8/makervault-canary.mjs --execute --chain-id 4663 --fund-usdg 25000
 *
 * The RPC URL comes from RH_RPC, never argv, because production endpoints embed credentials. Key material is
 * refused on sight: this file has nothing to sign with and must not be handed a key by habit.
 *
 * Sources, mirrored not re-reasoned:
 *   - The six `Limits` fields and their storage order: contracts/src/v2/mm/MakerVault.sol:129-137, and the
 *     `limits()` tuple in ops/v2/monitor.mjs ABI_TEXT.makerVault, which this file imports rather than retypes.
 *   - The intended canary values: ops/markets/tier1.json `v2.vault`. Never a literal in this file.
 *   - Which registry key is authoritative: ops/markets/write-back-v8.mjs:58,60,82-93 - `v2.contracts.*` and
 *     `v2.flywheel.*` are written, `v2.protocolAddresses` is a MIRROR rebuilt from those twins (line 139-141).
 *
 * Exit codes: 0 verified (and funding emitted when asked); 1 refused, or a readback that ran and did not match;
 * 2 unexpected error; 3 the readback could not see its subject and proved nothing (see the printed UNPROVEN line).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ABI_TEXT } from "../v2/monitor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export const DEFAULT_REGISTRY = path.join(REPO, "ops", "markets", "tier1.json");
export const DEFAULT_ROLES = path.join(REPO, "ops", "abis", "v2", "roles.json");

/** The roles.json key for the call this task plans. Written once; every consumer reads it from here. */
export const SET_LIMITS_SIGNATURE = "setLimits((uint64,uint128,uint16,uint16,uint32,uint128))";

export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, ERROR: 2, UNPROVEN: 3 });

/** The `limits()` view, mirrored from ops/v2/monitor.mjs so one edit moves both. */
export const MAKER_VAULT_READ_ABI_TEXT = Object.freeze([...ABI_TEXT.makerVault]);
/** The admin write this task PLANS and never sends. Selector 0x6693cc27 since INTERFACE_VERSION 7 (MakerVault.sol:126). */
export const SET_LIMITS_ABI_TEXT = Object.freeze([
  "function setLimits((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow) limits_)",
]);
export const USDG_READ_ABI_TEXT = Object.freeze([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * The six Limits fields in storage order (MakerVault.sol:129-137), with the width each one must fit.
 * Order is load-bearing: `setLimits` takes the tuple positionally, so a reordering here would encode a
 * different call with the same selector.
 */
export const LIMITS_FIELDS = Object.freeze([
  { name: "maxSeriesUnits", bits: 64n },
  { name: "maxTotalNotional", bits: 128n },
  { name: "askToleranceBps", bits: 16n, maxValue: 10_000n },
  { name: "maxBidBpsOfSpot", bits: 16n, maxValue: 10_000n },
  { name: "maxOrderLifetime", bits: 32n },
  { name: "maxDailyOutflow", bits: 128n },
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
/** A 32-byte hex blob anywhere in argv is a private key by shape; this file has nothing to sign with. */
const KEY_RE = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?:$|[^0-9a-fA-F])/;

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

/** A readback that could not see its subject. Distinct from a mismatch: it proved nothing either way. */
export class Unproven extends Error {
  constructor(message) {
    super(message);
    this.name = "Unproven";
  }
}

const lc = (value) => String(value).toLowerCase();

function at(root, dotted) {
  return dotted.split(".").reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), root);
}

export function readRegistry(filename) {
  let raw;
  try {
    raw = readFileSync(filename, "utf8");
  } catch (error) {
    throw new Refusal(`registry: cannot read ${filename}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Refusal(`registry: ${filename} is not JSON: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

/**
 * One address out of the registry, from the key write-back-v8.mjs actually writes, cross-checked against its
 * mirror. A null authoritative key means the v8 deploy has not been written back: that is a REFUSAL, never a
 * skip, because every check downstream would otherwise pass by having nothing to look at.
 */
export function resolveAddress(registry, { label, key, mirrorKey }) {
  const value = at(registry, key);
  if (value === null || value === undefined) {
    throw new Refusal(`${label}: ${key} is null - the v8 deploy has not been written back (ops/markets/write-back-v8.mjs). Nothing to verify.`);
  }
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Refusal(`${label}: ${key} is not a 20-byte 0x address: ${JSON.stringify(value)}`);
  }
  if (lc(value) === ZERO) throw new Refusal(`${label}: ${key} is the zero address, which is not an identity`);
  if (mirrorKey) {
    const mirror = at(registry, mirrorKey);
    if (mirror === null || mirror === undefined) {
      throw new Refusal(`${label}: ${key} is set but its mirror ${mirrorKey} is null - the registry is stale or hand-edited; re-run ops/markets/write-back-v8.mjs`);
    }
    if (lc(mirror) !== lc(value)) {
      throw new Refusal(`${label}: the registry disagrees with itself: ${key}=${value} but ${mirrorKey}=${mirror}`);
    }
  }
  return value;
}

export function resolveTargets(registry) {
  const chainId = at(registry, "shared.chainId");
  if (!Number.isInteger(chainId)) throw new Refusal("registry: shared.chainId is not an integer");
  return {
    chainId,
    makerVault: resolveAddress(registry, {
      label: "MakerVault",
      key: "v2.contracts.makerVault",
      mirrorKey: "v2.protocolAddresses.makerVault",
    }),
    usdg: resolveAddress(registry, { label: "USDG", key: "shared.usdg" }),
    treasurySafe: resolveAddress(registry, {
      label: "Treasury Safe",
      key: "shared.safes.treasury",
      mirrorKey: "v2.protocolAddresses.treasury",
    }),
    adminSafe: resolveAddress(registry, { label: "Admin Safe", key: "shared.safes.admin" }),
  };
}

/**
 * Which role governs a (target, selector) under the v8 AccessManager, and that role's execution delay.
 *
 * Read from ops/abis/v2/roles.json, never retyped: a retyped delay makes the owner send a transaction into a
 * window that has not opened. A target or a selector the manifest does not carry is a REFUSAL - an unmapped
 * restricted selector is exactly the case a permission check cannot see, so this must never fall through to a
 * default role or a zero delay.
 */
export function governingRole({ target, signature, roles }) {
  const manifest = roles ?? readRegistry(DEFAULT_ROLES);
  const targets = manifest?.targets;
  if (targets === null || targets === undefined || typeof targets !== "object") {
    throw new Refusal("roles.json: no targets block - the role manifest cannot say who may make this call");
  }
  const block = targets[target];
  if (block === null || block === undefined) {
    throw new Refusal(`roles.json: no targets.${target} block. The manifest does not cover this contract, so nothing here can tell you which role or delay applies.`);
  }
  const role = block[signature];
  if (typeof role !== "string") {
    throw new Refusal(`roles.json: targets.${target} does not map ${signature}. An unmapped restricted selector has no role and no delay in this file; check script/v2/roles.v8.json in callhouse-contracts before sending anything.`);
  }
  const delaySeconds = manifest?.delaysS?.[role];
  if (!Number.isInteger(delaySeconds)) {
    throw new Refusal(`roles.json: delaysS.${role} is absent or not an integer; the execution delay for ${signature} is unknown`);
  }
  const roleId = manifest?.roles?.[role];
  if (!Number.isInteger(roleId)) throw new Refusal(`roles.json: roles.${role} has no id`);
  return { role, roleId, delaySeconds };
}

function integerField(source, field, { bits, maxValue }) {
  if (!Object.prototype.hasOwnProperty.call(source, field)) {
    throw new Refusal(`v2.vault.${field}: absent. The canary limits come from the registry; this file has no default to fall back on.`);
  }
  const raw = source[field];
  if (raw === null || raw === undefined) throw new Refusal(`v2.vault.${field}: null`);
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Refusal(`v2.vault.${field}: expected an integer or a decimal string, got ${typeof raw}`);
  }
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) {
    throw new Refusal(`v2.vault.${field}: ${raw} is not a safe integer; write it as a decimal string`);
  }
  if (typeof raw === "string" && !/^[0-9]+$/.test(raw)) {
    throw new Refusal(`v2.vault.${field}: ${JSON.stringify(raw)} is not a non-negative decimal string`);
  }
  const value = BigInt(raw);
  const ceiling = (1n << bits) - 1n;
  if (value > ceiling) throw new Refusal(`v2.vault.${field}: ${value} overflows uint${bits}`);
  if (maxValue !== undefined && value > maxValue) {
    throw new Refusal(`v2.vault.${field}: ${value} exceeds ${maxValue}; the contract rejects it (MakerVault.setLimits)`);
  }
  return value;
}

/** The intended limits, from ops/markets/tier1.json `v2.vault`. Every field required; nothing defaulted. */
export function intendedLimits(registry) {
  const source = at(registry, "v2.vault");
  if (source === null || source === undefined || typeof source !== "object" || Array.isArray(source)) {
    throw new Refusal("registry: v2.vault is absent - the canary limits have no source");
  }
  const limits = {};
  for (const field of LIMITS_FIELDS) limits[field.name] = integerField(source, field.name, field);
  return Object.freeze(limits);
}

/**
 * Field-by-field comparison. An observed tuple that is MISSING a field reports ABSENT, never a pass: a v6
 * decoder against a v7 vault returns five fields and leaves `maxDailyOutflow` undefined, and `undefined ==
 * anything` must not read as agreement. This is the check that has to go red when it cannot see its subject.
 */
export function compareLimits(expected, observed) {
  if (observed === null || observed === undefined || typeof observed !== "object") {
    throw new Unproven(`limits(): returned ${observed === undefined ? "undefined" : JSON.stringify(observed)} - the readback saw no tuple at all`);
  }
  const mismatches = [];
  for (const { name } of LIMITS_FIELDS) {
    const want = expected[name];
    if (!Object.prototype.hasOwnProperty.call(observed, name) || observed[name] === undefined || observed[name] === null) {
      mismatches.push({ field: name, expected: String(want), observed: "ABSENT" });
      continue;
    }
    let got;
    try {
      got = BigInt(observed[name]);
    } catch {
      mismatches.push({ field: name, expected: String(want), observed: `UNREADABLE(${String(observed[name])})` });
      continue;
    }
    if (got !== want) mismatches.push({ field: name, expected: String(want), observed: String(got) });
  }
  return { ok: mismatches.length === 0, mismatches, fields: LIMITS_FIELDS.map((f) => f.name) };
}

const PROOF_BRAND = Symbol("makervault-limits-readback");

/**
 * The only thing that unlocks a funding instruction. Minted exclusively by {verifyLimits}, exclusively on a
 * clean comparison, and stamped with the run id of the process that read the chain.
 */
function mintProof({ runId, address, chainId, observed, comparison }) {
  if (!comparison.ok) throw new Refusal("internal: refusing to mint a readback proof from a failed comparison");
  return Object.freeze({
    [PROOF_BRAND]: true,
    runId,
    address,
    chainId,
    observed: Object.freeze({ ...observed }),
    verifiedAt: new Date().toISOString(),
  });
}

/** A fresh identity per process. A proof from another run is not a proof for this one. */
export function newRunId() {
  return randomUUID();
}

export function assertLimitsProof(proof, runId) {
  if (proof === null || proof === undefined || typeof proof !== "object" || proof[PROOF_BRAND] !== true) {
    throw new Refusal("funding is unreachable: no limits readback proof. Run --execute --chain-id <id> first; the readback mints the proof and nothing else can.");
  }
  if (proof.runId !== runId) {
    throw new Refusal(`funding is unreachable: the limits readback proof is from run ${proof.runId}, not this run ${runId}. A readback from an earlier process does not authorise funding now.`);
  }
  return proof;
}

/**
 * The Treasury Safe instruction. Unreachable until {verifyLimits} matched the chain in this same run - not by
 * documentation, by the proof argument. `deposit` is permissionless, so this is the irreversible step.
 */
export function fundingPlan({ proof, runId, usdg, makerVault, amountBaseUnits, decimals, treasurySafe }) {
  assertLimitsProof(proof, runId);
  if (lc(proof.address) !== lc(makerVault)) {
    throw new Refusal(`funding refused: the readback proved ${proof.address} but the funding target is ${makerVault}`);
  }
  if (typeof amountBaseUnits !== "bigint" || amountBaseUnits <= 0n) {
    throw new Refusal("funding refused: --fund-usdg must be a positive amount");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Refusal("funding refused: USDG decimals were not read from chain; the amount cannot be expressed in base units");
  }
  return Object.freeze({
    from: treasurySafe,
    to: usdg,
    call: `approve(${makerVault}, ${amountBaseUnits})`,
    then: { to: makerVault, call: `deposit(${usdg}, ${amountBaseUnits})` },
    amountBaseUnits,
    decimals,
    readback: `cast call ${usdg} "balanceOf(address)(uint256)" ${makerVault} --rpc-url "$RH_RPC"  # must rise by exactly ${amountBaseUnits}`,
    provenLimits: proof.observed,
    provenAt: proof.verifiedAt,
  });
}

export function loadViem() {
  try {
    return createRequire(path.join(REPO, "keeper", "package.json"))("viem");
  } catch {
    throw new Refusal("viem is not resolvable from keeper/: dependency missing; report it - do not install or patch node_modules from this task");
  }
}

/** The setLimits calldata the Admin Safe submits. Encoded by viem from the mirrored signature, never typed. */
export function limitsCalldata(limits, { viem = loadViem() } = {}) {
  const abi = viem.parseAbi(SET_LIMITS_ABI_TEXT);
  return viem.encodeFunctionData({
    abi,
    functionName: "setLimits",
    args: [LIMITS_FIELDS.reduce((tuple, f) => ({ ...tuple, [f.name]: limits[f.name] }), {})],
  });
}

/**
 * The live, READ-ONLY readback. Refuses on the wrong chain, is UNPROVEN when the address holds no code, and
 * returns a proof only when every field matched.
 */
export async function verifyLimits({ client, makerVault, expected, expectedChainId, runId }) {
  const chainId = await client.getChainId();
  if (Number(chainId) !== Number(expectedChainId)) {
    throw new Refusal(`chain id: RH_RPC is chain ${chainId}, --chain-id said ${expectedChainId}`);
  }
  const code = await client.getCode({ address: makerVault });
  if (code === undefined || code === null || code === "0x" || code === "") {
    throw new Unproven(`no code at ${makerVault} on chain ${chainId}: the limits readback has no subject, so it proves nothing`);
  }
  let observed;
  try {
    observed = await client.readContract({ address: makerVault, functionName: "limits", args: [] });
  } catch (error) {
    throw new Unproven(`limits() reverted or could not be decoded at ${makerVault}: ${String(error?.shortMessage ?? error?.message ?? error).split("\n")[0]}`);
  }
  const comparison = compareLimits(expected, observed);
  return {
    chainId: Number(chainId),
    address: makerVault,
    observed,
    comparison,
    proof: comparison.ok ? mintProof({ runId, address: makerVault, chainId: Number(chainId), observed, comparison }) : null,
  };
}

export async function readUsdgDecimals({ client, usdg }) {
  const code = await client.getCode({ address: usdg });
  if (code === undefined || code === null || code === "0x" || code === "") {
    throw new Unproven(`no code at USDG ${usdg}: decimals cannot be read, so no amount can be expressed in base units`);
  }
  const decimals = await client.readContract({ address: usdg, functionName: "decimals", args: [] });
  const value = Number(decimals);
  if (!Number.isInteger(value) || value < 0 || value > 36) throw new Unproven(`USDG decimals() returned ${String(decimals)}`);
  return value;
}

export function parseAmount(human, decimals) {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(String(human))) throw new Refusal(`--fund-usdg: ${JSON.stringify(human)} is not a decimal amount`);
  const [whole, frac = ""] = String(human).split(".");
  if (frac.length > decimals) throw new Refusal(`--fund-usdg: ${human} has more precision than USDG's ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function parseArgs(argv) {
  const opts = { registry: DEFAULT_REGISTRY, execute: false, chainId: null, fundUsdg: null, rpcEnv: "RH_RPC" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Refusal(`${arg}: missing value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--registry": opts.registry = next(); break;
      case "--execute": case "--check": opts.execute = true; break;
      case "--chain-id": opts.chainId = Number(next()); break;
      case "--fund-usdg": opts.fundUsdg = next(); break;
      case "--rpc-env": opts.rpcEnv = next(); break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Refusal(`unknown argument ${arg}`);
    }
  }
  if (opts.execute && !Number.isInteger(opts.chainId)) {
    throw new Refusal("--execute requires --chain-id <id>: a live readback against an unnamed chain proves nothing");
  }
  if (!opts.execute && opts.fundUsdg !== null) {
    throw new Refusal("--fund-usdg without --execute: a funding instruction is unreachable without a live limits readback");
  }
  return opts;
}

export function assertNoKeyMaterial(argv) {
  for (const arg of argv) {
    if (KEY_RE.test(arg)) throw new Refusal("argv carries something key-shaped. This file signs nothing and must never be handed a key.");
  }
}

const USAGE = `ops/v8/makervault-canary.mjs - OWN8-07 limits-then-readback-then-fund

  --registry <path>   registry to read (default ops/markets/tier1.json)
  --execute           perform the live READ-ONLY readback (requires --chain-id). Never sends a transaction.
  --check             synonym for --execute
  --chain-id <id>     the chain RH_RPC must be on
  --fund-usdg <amt>   emit the Treasury Safe funding instruction, ONLY after the readback matched
  --rpc-env <name>    environment variable holding the RPC URL (default RH_RPC)

Exit: 0 verified, 1 refused or mismatched, 2 error, 3 the readback could not see its subject.`;

function printLimits(label, limits) {
  console.log(label);
  for (const { name } of LIMITS_FIELDS) console.log(`  ${name.padEnd(18)} ${limits[name]}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  assertNoKeyMaterial(argv);
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  const runId = newRunId();
  const registry = readRegistry(opts.registry);
  const targets = resolveTargets(registry);
  const expected = intendedLimits(registry);

  console.log(`MakerVault canary (OWN8-07)  run ${runId}`);
  console.log(`  registry      ${opts.registry}`);
  console.log(`  chain         ${targets.chainId}`);
  console.log(`  MakerVault    ${targets.makerVault}`);
  console.log(`  USDG          ${targets.usdg}`);
  console.log(`  Admin Safe    ${targets.adminSafe}  (schedules, waits, then sends setLimits)`);
  console.log(`  Treasury Safe ${targets.treasurySafe}  (funds, only after the readback)`);
  printLimits("intended limits (registry v2.vault):", expected);
  const governs = governingRole({ target: "MakerVault", signature: SET_LIMITS_SIGNATURE });
  console.log(`\nstep 1 - setLimits is ${governs.role} (role id ${governs.roleId}) with a ${governs.delaySeconds}s execution delay (ops/abis/v2/roles.json).`);
  if (governs.delaySeconds > 0) {
    console.log(`  The Admin Safe SCHEDULES this on the AccessManager, waits ${governs.delaySeconds}s, then sends it to the target directly (ops/runbooks/v8-roles.md).`);
  }
  console.log(`  to   ${targets.makerVault}`);
  console.log(`  data ${limitsCalldata(expected)}`);

  if (!opts.execute) {
    console.log("\nstep 2 - readback: NOT RUN (dry run).");
    console.log("step 3 - funding: UNREACHABLE. No readback ran, so no proof exists and fundingPlan() refuses.");
    console.log("\nDry run complete. Re-run with --execute --chain-id <id> to read the chain.");
    return EXIT.OK;
  }

  const rpc = env[opts.rpcEnv];
  if (!rpc) throw new Refusal(`${opts.rpcEnv} is not set: the RPC URL comes from the environment, never argv`);
  const viem = loadViem();
  const client = viem.createPublicClient({ transport: viem.http(rpc, { timeout: 30_000, retryCount: 1 }) });
  const readAbi = viem.parseAbi([...MAKER_VAULT_READ_ABI_TEXT]);
  const usdgAbi = viem.parseAbi([...USDG_READ_ABI_TEXT]);
  const vaultClient = { getChainId: () => client.getChainId(), getCode: (a) => client.getCode(a), readContract: (a) => client.readContract({ ...a, abi: readAbi }) };
  const usdgClient = { getCode: (a) => client.getCode(a), readContract: (a) => client.readContract({ ...a, abi: usdgAbi }) };

  const result = await verifyLimits({ client: vaultClient, makerVault: targets.makerVault, expected, expectedChainId: opts.chainId, runId });
  console.log(`\nstep 2 - readback of limits() at ${result.address} on chain ${result.chainId}:`);
  for (const { name } of LIMITS_FIELDS) console.log(`  ${name.padEnd(18)} ${String(result.observed?.[name] ?? "ABSENT")}`);
  if (!result.comparison.ok) {
    console.log("\nFAILED - the vault does not carry the registry limits:");
    for (const m of result.comparison.mismatches) console.log(`  ${m.field}: expected ${m.expected}, chain says ${m.observed}`);
    console.log("step 3 - funding: UNREACHABLE (no proof was minted).");
    return EXIT.REFUSED;
  }
  console.log("  VERIFIED - every field matches the registry.");

  if (opts.fundUsdg === null) {
    console.log("\nstep 3 - funding: not requested. Re-run with --fund-usdg <amount> to emit the Treasury Safe instruction.");
    return EXIT.OK;
  }
  const decimals = await readUsdgDecimals({ client: usdgClient, usdg: targets.usdg });
  const amountBaseUnits = parseAmount(opts.fundUsdg, decimals);
  const plan = fundingPlan({
    proof: result.proof,
    runId,
    usdg: targets.usdg,
    makerVault: targets.makerVault,
    amountBaseUnits,
    decimals,
    treasurySafe: targets.treasurySafe,
  });
  console.log(`\nstep 3 - funding, ${opts.fundUsdg} USDG (${plan.amountBaseUnits} base units at ${plan.decimals} decimals):`);
  console.log(`  from ${plan.from} (Treasury Safe)`);
  console.log(`  1)   ${plan.to} ${plan.call}`);
  console.log(`  2)   ${plan.then.to} ${plan.then.call}`);
  console.log(`  readback: ${plan.readback}`);
  console.log("  deposit is permissionless and only the Admin Safe can withdraw: this step is the irreversible one.");
  return EXIT.OK;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof Refusal) {
        console.error(`REFUSED: ${error.message}`);
        process.exit(EXIT.REFUSED);
      }
      if (error instanceof Unproven) {
        console.error(`UNPROVEN: ${error.message}`);
        process.exit(EXIT.UNPROVEN);
      }
      console.error(error);
      process.exit(EXIT.ERROR);
    });
}
