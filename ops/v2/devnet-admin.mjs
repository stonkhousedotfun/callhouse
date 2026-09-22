#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/v2/devnet-admin.mjs — one restricted call on a v8 devnet, performed the way the manifest says.
 *
 *   node ops/v2/devnet-admin.mjs Clearinghouse "setMarketFees(address,uint16,uint32)" 0xNVDA 500 0
 *   node ops/v2/devnet-admin.mjs --dry-run OrderBook "setTradingPaused(bool)" true
 *   node ops/v2/devnet-admin.mjs --cancel Clearinghouse "setMarketFees(address,uint16,uint32)" 0xNVDA 500 0
 *
 * The plan (role, execution delay, and which of the three modes) comes from ops/abis/v2/roles.json
 * through ops/v2/lib/admin.mjs; the sending comes from ops/devnet/lib.mjs. No delay and no role id is
 * written down here: a grep of this file for any of the five published delays comes back empty, and a
 * delay is printed in seconds so that not even the divisor to hours lives here.
 *
 * --dry-run TOUCHES NO NODE AT ALL: it neither opens a connection nor loads viem, so it answers in a
 * checkout with no node_modules and answers the same way on a laptop with no devnet running. The
 * calldata and the operation id need keccak and are printed only when viem does resolve; the plan
 * itself never needs it.
 *
 * WHAT IT IMPERSONATES. The Admin Safe, with anvil_impersonateAccount + anvil_setBalance, stopped
 * again in a `finally` inside ops/v2/lib/admin.mjs — including on the error path. Devnet only; no key
 * is read, held or needed. Production runs the same three shapes from the real Safe.
 *
 * Tests: node --test ops/v2/devnet-admin.test.mjs
 * ------------------------------------------------------------------------------------------------- */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AdminError, ROLES_FILE, adminCall, adminCancel, canonicalSignature, loadRoles, planFor } from "./lib/admin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
/** The devnet's generated address book. Same file and same override as ops/devnet/lib.mjs:21. */
export const ADDRESSES_FILE = process.env.DEVNET_ADDRESSES ?? path.join(ROOT, "ops", "devnet", "addresses.json");

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Every file this prints or names is shown relative to the checkout: absolute paths are noise. */
const rel = (file) => {
  const r = path.relative(ROOT, file);
  return r === "" || r.startsWith("..") ? file : r;
};

/**
 * Where each roles.json target's address lives in the devnet address book. The book has the shape of
 * the registry's `v2.contracts` (ops/devnet/README.md, DevDeploy's JSON), so these keys are the
 * registry's, mirrored from ops/v2/monitor.mjs CONTRACT_NAMES / FLYWHEEL_NAMES rather than invented.
 * Several are tried in order because the flywheel half of v8 is not deployed yet and a devnet may put
 * it under either key; a name that resolves to nothing is reported with every key that was tried.
 */
export const ADDRESS_KEYS = Object.freeze({
  Clearinghouse: ["contracts.clearinghouse"],
  OrderBook: ["contracts.orderBook"],
  SettlementOracle: ["contracts.settlementOracle"],
  ExpiryCalendar: ["contracts.expiryCalendar"],
  KeeperRewards: ["contracts.keeperRewards"],
  AutoRoller: ["contracts.autoRoller"],
  MakerVault: ["contracts.makerVault"],
  MakerRegistry: ["contracts.makerRegistry"],
  RewardsDistributor: ["contracts.rewardsDistributor"],
  ChainlinkFeedSource: ["contracts.sources.chainlink"],
  UniV3TwapSource: ["contracts.sources.univ3"],
  DataStreamsSource: ["contracts.sources.dataStreams"],
  // INTERFACE_VERSION 8 keeps the `payoutAdapter` key and points it at the PayoutRouter
  // (ops/v2/monitor.mjs CONTRACT_NAMES). The v7 adapter answered the same key before it.
  PayoutRouter: ["contracts.payoutRouter", "contracts.payoutAdapter"],
  // `v2.flywheel` in the registry (ops/v2/monitor.mjs FLYWHEEL_NAMES); DevDeploy does not write it yet.
  FeeSplitter: ["contracts.feeSplitter", "flywheel.feeSplitter"],
  V4BuybackExecutor: ["contracts.buybackExecutor", "flywheel.buybackExecutor"],
});

/** The AccessManager itself, so the manager can be resolved from the book like any other contract. */
const MANAGER_KEY = "contracts.accessManager";
/** The Admin Safe the roles are granted to (roles.json holders.adminSafe). */
const SAFE_KEY = "accounts.adminSafe";
/** The guardian key that cancels a scheduled operation on a devnet (roles.json holders.guardianKey). */
const GUARDIAN_KEY = "accounts.guardian";

class UsageError extends Error {}

const dig = (object, dotted) => dotted.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), object);

/** The address book, or null when this devnet has not been brought up (--dry-run still works). */
export function readAddresses(file = ADDRESSES_FILE) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`${rel(file)}: cannot be read as JSON (${error.message})`);
  }
}

/** The first of `keys` the book answers with an address, plus where it came from. */
export function fromBook(addresses, keys) {
  for (const key of keys) {
    const value = addresses === null ? undefined : dig(addresses, key);
    if (typeof value === "string" && ADDRESS_RE.test(value)) return { address: value, source: `${rel(ADDRESSES_FILE)} ${key}` };
  }
  return { address: null, source: null };
}

/**
 * `<target>` as { contract, address, source }. A NAME is looked up in the address book; an ADDRESS is
 * matched back to a name, because the role cannot be read from roles.json without knowing which
 * contract this is. An address the book does not know is refused rather than planned against a guess.
 */
export function resolveTargetArg(raw, { roles, addresses }) {
  if (ADDRESS_RE.test(raw)) {
    for (const [contract, keys] of Object.entries(ADDRESS_KEYS)) {
      const { address, source } = fromBook(addresses, keys);
      if (address !== null && address.toLowerCase() === raw.toLowerCase()) return { contract, address: raw, source };
    }
    throw new UsageError(
      `${raw} is not a contract ${rel(ADDRESSES_FILE)} names, so its role cannot be read from ${rel(ROLES_FILE)}. ` +
        "Pass the contract NAME instead (the manifest's own spelling), or bring the devnet up first.",
    );
  }
  const keys = ADDRESS_KEYS[raw];
  if (keys === undefined) {
    throw new UsageError(`${raw} is not a target in ${rel(ROLES_FILE)}. Targets: ${Object.keys(roles.targets).join(", ")}`);
  }
  const { address, source } = fromBook(addresses, keys);
  return { contract: raw, address, source };
}

function pad(label) {
  return label.padEnd(11, " ");
}

function printPlan(out, { plan, target, manager, safe, guardian, args, result }) {
  const why = {
    execute: "delay 0: manager.execute only — schedule reverts on a zero setback (AccessManager.sol:464-465)",
    "schedule-execute": "manager.schedule -> warp -> manager.execute (AccessManager.sol:467-469, 516-521)",
    "schedule-direct": "manager.schedule -> warp -> direct call from the Safe (AccessManager.sol:528, Managed.sol:65-72)",
  }[plan.mode];
  out(`devnet-admin: ${plan.contract}.${plan.signature}`);
  out(`  ${pad("role")}${plan.role} (${plan.roleId})   ${rel(ROLES_FILE)} targets.${plan.contract}`);
  out(`  ${pad("delay")}${plan.delayS} s   ${rel(ROLES_FILE)} delaysS.${plan.role}`);
  out(`  ${pad("mode")}${plan.mode}   ${why}`);
  out(`  ${pad("manager")}${manager.address ?? "unresolved"}${manager.source === null ? "" : `   ${manager.source}`}`);
  out(`  ${pad("safe")}${safe.address ?? "unresolved"}${safe.source === null ? "" : `   ${safe.source}`}`);
  if (guardian !== undefined) out(`  ${pad("guardian")}${guardian.address ?? "unresolved"}${guardian.source === null ? "" : `   ${guardian.source}`}`);
  out(`  ${pad("target")}${target.address ?? "unresolved"}${target.source === null ? "" : `   ${target.source}`}`);
  out(`  ${pad("args")}${args.length === 0 ? "(none)" : args.join("  ")}`);
  if (result !== undefined) {
    if (result.data !== null && result.data !== undefined) out(`  ${pad("calldata")}${result.data}`);
    // The operation id is printed on every path: it is the handle the monitor's OperationScheduled /
    // OperationExecuted / OperationCanceled events carry, and what a cancel has to be given.
    out(`  ${pad("operation")}${result.operationId ?? "not computed"}`);
    if (result.note) out(`  ${pad("note")}${result.note}`);
  }
}

const USAGE = `usage: node ops/v2/devnet-admin.mjs [flags] <target> "<signature>" [args...]

  <target>        a contract name as ops/abis/v2/roles.json spells it (Clearinghouse, OrderBook, ...)
                  or a 0x address ops/devnet/addresses.json maps to one of them
  <signature>     the full function signature, e.g. "setMarketFees(address,uint16,uint32)"
  args            one per parameter; arrays and tuples as JSON, e.g. '[100,50,0,25,10]'

  --dry-run       print the plan and send nothing (no node, no viem needed)
  --cancel        cancel the operation this call would be, instead of performing it (guardian lane)
  --manager <a>   the AccessManager; else DEVNET_MANAGER; else addresses.json ${MANAGER_KEY}
  --safe <a>      the Admin Safe to impersonate; else DEVNET_SAFE; else addresses.json ${SAFE_KEY}
  --guardian <a>  --cancel only: who sends cancel(); else DEVNET_GUARDIAN; else addresses.json
                  ${GUARDIAN_KEY}; else the Safe
  --no-preflight  skip the read-back that compares roles.json with the manager's own mapping
  -h, --help
`;

export function parseArgv(argv) {
  const out = { flags: { dryRun: false, cancel: false, preflight: true }, manager: null, safe: null, guardian: null, positional: [] };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs an address`);
    if (!ADDRESS_RE.test(v)) throw new UsageError(`${flag} ${JSON.stringify(v)} is not an address`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.flags.dryRun = true;
    else if (arg === "--cancel") out.flags.cancel = true;
    else if (arg === "--no-preflight") out.flags.preflight = false;
    else if (arg === "--manager") (out.manager = value(i, "--manager")), (i += 1);
    else if (arg === "--safe") (out.safe = value(i, "--safe")), (i += 1);
    else if (arg === "--guardian") (out.guardian = value(i, "--guardian")), (i += 1);
    else if (arg === "--help" || arg === "-h") out.flags.help = true;
    else if (arg.startsWith("--")) throw new UsageError(`unknown flag ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

export async function run(argv, out = (line) => process.stdout.write(`${line}\n`)) {
  const parsed = parseArgv(argv);
  if (parsed.flags.help) {
    out(USAGE.trimEnd());
    return 0;
  }
  const [rawTarget, signature, ...args] = parsed.positional;
  if (rawTarget === undefined || signature === undefined) throw new UsageError(`a target and a signature are required\n\n${USAGE.trimEnd()}`);

  const roles = loadRoles();
  const addresses = readAddresses();
  const target = resolveTargetArg(rawTarget, { roles, addresses });
  // The plan is resolved before anything is looked up on a node, so a wrong signature fails the same
  // way whether or not a devnet is running — and an unmapped one is never planned as ADMIN.
  const plan = planFor({ target: target.contract, signature, roles });

  const manager = parsed.manager
    ? { address: parsed.manager, source: "--manager" }
    : process.env.DEVNET_MANAGER
      ? { address: process.env.DEVNET_MANAGER, source: "DEVNET_MANAGER" }
      : fromBook(addresses, [MANAGER_KEY]);
  const safe = parsed.safe
    ? { address: parsed.safe, source: "--safe" }
    : process.env.DEVNET_SAFE
      ? { address: process.env.DEVNET_SAFE, source: "DEVNET_SAFE" }
      : fromBook(addresses, [SAFE_KEY]);
  const guardian = parsed.guardian
    ? { address: parsed.guardian, source: "--guardian" }
    : process.env.DEVNET_GUARDIAN
      ? { address: process.env.DEVNET_GUARDIAN, source: "DEVNET_GUARDIAN" }
      : (() => {
          const found = fromBook(addresses, [GUARDIAN_KEY]);
          return found.address === null ? { address: safe.address, source: safe.source === null ? null : `${safe.source} (the Safe holds GUARDIAN)` } : found;
        })();

  if (parsed.flags.dryRun) {
    const result = await adminCall({
      manager: manager.address,
      safe: safe.address,
      target: { contract: target.contract, address: target.address },
      signature: plan.signature,
      args,
      dryRun: true,
      roles,
    });
    printPlan(out, { plan, target, manager, safe, guardian: parsed.flags.cancel ? guardian : undefined, args, result });
    out("  dry run: nothing was sent");
    return 0;
  }

  // Only now is a node needed, so every resolution failure is reported by the exact key it looked for.
  if (manager.address === null) throw new UsageError(`no AccessManager: pass --manager, set DEVNET_MANAGER, or bring up a devnet that writes ${rel(ADDRESSES_FILE)} ${MANAGER_KEY}`);
  if (safe.address === null) throw new UsageError(`no Admin Safe: pass --safe, set DEVNET_SAFE, or bring up a devnet that writes ${rel(ADDRESSES_FILE)} ${SAFE_KEY}`);
  if (target.address === null) {
    throw new UsageError(`no address for ${target.contract}: ${rel(ADDRESSES_FILE)} has none of ${ADDRESS_KEYS[target.contract].join(", ")}. Pass the address as <target> once the contract is deployed.`);
  }
  if (parsed.flags.cancel && guardian.address === null) throw new UsageError(`no canceller: pass --guardian, set DEVNET_GUARDIAN, or bring up a devnet that writes ${rel(ADDRESSES_FILE)} ${GUARDIAN_KEY}`);

  const call = { manager: manager.address, safe: safe.address, target: { contract: target.contract, address: target.address }, signature: plan.signature, args, roles };
  const result = parsed.flags.cancel
    ? await adminCancel({ ...call, guardian: guardian.address })
    : await adminCall({ ...call, skipPreflight: !parsed.flags.preflight });
  printPlan(out, { plan, target, manager, safe, guardian: parsed.flags.cancel ? guardian : undefined, args, result });
  for (const tx of result.txs) out(`  ${pad(tx.step)}${tx.hash}`);
  if (result.scheduledAt) out(`  ${pad("ready at")}${result.scheduledAt} (unix seconds, from the manager's own getSchedule)`);
  if (result.executedAt) out(`  ${pad("executed")}${result.executedAt}`);
  if (result.canceledAt) out(`  ${pad("canceled")}${result.canceledAt}`);
  return 0;
}

async function main(argv) {
  try {
    process.exit(await run(argv));
  } catch (error) {
    // A revert arrives here as the decoded name ops/devnet/lib.mjs `send` produced ("... would revert:
    // AccessManagerUnauthorizedCall(...)"): printed as it is and exited non-zero, never swallowed.
    process.stderr.write(`devnet-admin: ${error instanceof AdminError || error instanceof UsageError ? error.message : (error?.stack ?? error)}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

export { UsageError, canonicalSignature };
