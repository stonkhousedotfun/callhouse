/* -------------------------------------------------------------------------------------------------
 * ops/v2/lib/admin.mjs — the one place that knows how an INTERFACE_VERSION 8 admin action is
 * performed on a devnet. K8-04 (keeper devnet scripts), W8-04 (web acceptance), X8-05 (indexer sync
 * harness) and O8-06 (rehearsal drills) call this instead of hand-rolling schedule/execute, which is
 * how a delay lane gets silently wrong in four places at once. See ops/v2/ADMIN-DRIVER.md.
 *
 * TWO HALVES, AND THE LINE BETWEEN THEM IS LOAD-BEARING.
 *   pure   loadRoles / planFor / parseSignature / coerceArgs read ops/abis/v2/roles.json and answer
 *          { contract, role, roleId, delayS, mode } with node builtins only: no chain, no viem, no
 *          third-party import at all. That is what lets `node --test ops/v2/devnet-admin.test.mjs`
 *          exercise the whole published selector -> role -> delay mapping in a checkout with no
 *          node_modules, which is the state every v8 app worktree is in today.
 *   chain  adminCall / adminCancel import ops/devnet/lib.mjs DYNAMICALLY, inside the function body.
 *          That module resolves viem through the keeper workspace package and process.exit(2)s when
 *          it cannot (ops/devnet/lib.mjs:25-35). A top-level import here would take the pure half
 *          down with it and there would be no test to run at all.
 *
 * THE THREE MODES (OpenZeppelin v5.4.0 AccessManager, as vendored at
 * callhouse-contracts/lib/openzeppelin-contracts/contracts/access/manager/AccessManager.sol; the
 * line numbers below were read there, not remembered):
 *   execute          role delay 0  ->  manager.execute(target, data).
 *                    `schedule` REVERTS `AccessManagerUnauthorizedCall` when the member's setback is
 *                    0 (AccessManager.sol:464-465), so scheduling a GUARDIAN / OPS_ADMIN / PRICER /
 *                    QUOTER / BUYBACK action is not harmless belt and braces, it is a revert.
 *   schedule-execute role delay > 0  ->  manager.schedule(target, data, 0), warp past the delay,
 *                    manager.execute(target, data). `when = 0` is clamped up to now + setback by the
 *                    manager itself (AccessManager.sol:467-469), so the wait is the chain's number
 *                    and never one this driver computed. execute consumes the schedule
 *                    (AccessManager.sol:516-521).
 *   schedule-direct  role delay > 0 AND the target reads msg.sender  ->  schedule, warp, then call
 *                    the TARGET directly from the member. See MSG_SENDER_FUNCTIONS.
 *
 * THE OPERATION ID IS hashOperation(SAFE, target, data) — the CALLER is the Safe, never this
 * driver's own account (AccessManager.sol:588-589, `keccak256(abi.encode(caller, target, data))`).
 * On a node the id is read from the manager's own `hashOperation` view rather than hashed here: the
 * chain is the source of truth for its own id, and this file then holds no keccak of its own.
 *
 * MIRROR, DO NOT RE-REASON. Every role id and every execution delay is read from
 * ops/abis/v2/roles.json at run time. There is deliberately no second copy of a delay constant in
 * this file: a grep of it for any of the five published delays comes back empty, and a delay is
 * printed in seconds rather than in hours so that not even the divisor is written down here.
 *
 * DEVNET ONLY. adminCall impersonates the Safe with anvil's cheat RPCs. Production runs the same
 * three shapes from the real Safe UI; nothing here holds or reads a key.
 *
 * Tests: node --test ops/v2/devnet-admin.test.mjs
 * ------------------------------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..", "..");
/** The role manifest export-abis.sh copies beside the ABIs; `script/v2/roles.v8.json` in the contracts repo. */
export const ROLES_FILE = path.join(ROOT, "ops", "abis", "v2", "roles.json");
/** The devnet primitives (rpc, send, warpTo, abiOf, loadAddresses), imported dynamically. Never at top level. */
export const DEVNET_LIB = path.join(ROOT, "ops", "devnet", "lib.mjs");

/**
 * The manifest version this driver understands. A v7 manifest has no manager at all and a v9 one
 * could re-cut the roles; either way the mapping below would be read against the wrong table, so
 * loadRoles refuses rather than planning from it.
 */
export const INTERFACE_VERSION = 8;

/** The three shapes planFor can return, in the order ADMIN-DRIVER.md documents them. */
export const MODES = Object.freeze(["execute", "schedule-execute", "schedule-direct"]);

/** Paths in a message are shown relative to the checkout: an absolute one is noise in a CLI line. */
const rel = (file) => {
  const r = path.relative(ROOT, file);
  return r === "" || r.startsWith("..") ? file : r;
};

/** Every refusal this module raises: a wrong signature, a wrong manifest, a plan that cannot be made. */
export class AdminError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdminError";
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  the manifest                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * ops/abis/v2/roles.json, validated enough that a plan built from it cannot be quietly wrong:
 * interfaceVersion exactly 8, every role id an integer, every role a delay. Unlike the monitor's
 * loadRoleManifest — which degrades to "unknown" because a monitor that cannot name a role must
 * still watch it — this one THROWS. A driver that cannot read the manifest must send nothing.
 */
export function loadRoles(file = ROLES_FILE) {
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new AdminError(`${rel(file)}: cannot be read as JSON (${error.message})`);
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new AdminError(`${rel(file)}: not a JSON object`);
  if (json.interfaceVersion !== INTERFACE_VERSION) {
    throw new AdminError(
      `${rel(file)}: interfaceVersion is ${JSON.stringify(json.interfaceVersion)}, and this driver plans only for ${INTERFACE_VERSION}. ` +
        "Re-export the manifest (script/v2/export-abis.sh in callhouse-contracts) before driving admin calls.",
    );
  }
  for (const key of ["roles", "delaysS", "targets"]) {
    if (json[key] === null || typeof json[key] !== "object" || Array.isArray(json[key])) throw new AdminError(`${rel(file)}: no ${key} object`);
  }
  for (const [role, id] of Object.entries(json.roles)) {
    if (!Number.isInteger(id) || id < 0) throw new AdminError(`${rel(file)}: role ${role} has id ${JSON.stringify(id)}, which is not a uint64 role id`);
    const delayS = json.delaysS[role];
    if (!Number.isInteger(delayS) || delayS < 0) throw new AdminError(`${rel(file)}: role ${role} has delaysS ${JSON.stringify(delayS)}, which is not a number of seconds`);
  }
  return {
    file,
    interfaceVersion: json.interfaceVersion,
    roles: { ...json.roles },
    delaysS: { ...json.delaysS },
    roleAdmin: { ...(json.roleAdmin ?? {}) },
    roleGuardian: { ...(json.roleGuardian ?? {}) },
    holders: { ...(json.holders ?? {}) },
    targets: { ...json.targets },
    unrestricted: { ...(json.unrestricted ?? {}) },
    notes: { ...(json.notes ?? {}) },
  };
}

/**
 * SCHEDULE-THEN-DIRECT-CALL: the one case `execute` cannot serve, as ONE explicit list.
 *
 * `manager.execute` relays through `Address.functionCallWithValue(target, data, msg.value)`
 * (AccessManager.sol:528), so under the schedule-execute mode the target sees `msg.sender == manager`
 * and not the Safe. A delayed function that READS msg.sender must therefore be scheduled and then
 * called DIRECTLY on the target by the member: `AccessManaged._checkCanCall` (AccessManaged.sol:95-111,
 * and this repository's override at src/v2/access/Managed.sol:65-72) calls
 * `authority().consumeScheduledOp(caller, data)` when the caller is not immediate and has a delay,
 * which consumes the very same operation id. v8-plan/06-QUIRKS.md §D.2 and
 * callhouse-contracts src/v2/access/V8Roles.sol:17-19 state the same rule.
 *
 * WHICH DIRECTION IS DANGEROUS. A MISSING entry is the bad one: the call still succeeds, with the
 * MANAGER as msg.sender — money to the wrong address, or a caller-keyed mapping written under the
 * manager. An EXTRA entry is merely pedantic: a direct call works for any delayed function on a
 * `Managed` target. The list therefore errs toward listing. It is not the default for everything
 * delayed only because a target that is still on its v7 `AccessControl` gate (roles.json
 * notes.freezeState: C8-01..C8-08 are mid-migration) accepts the `execute` relay and refuses the
 * direct call, and because `execute` is the lane the rehearsals and the monitor's
 * OperationExecuted events are written against.
 *
 * THE SET IS EMPTY AT INTERFACE_VERSION 8, AND THAT IS A READ RESULT, NOT AN OVERSIGHT. Every entry
 * of roles.json whose role carries a delay > 0 was read in callhouse-contracts at
 * 522cf603dd306c875711c17401de864d06585095: not one of them reads msg.sender. v8 deleted exactly the
 * functions that would have — the free-`to` money exits — so each now pays the stored `treasury`:
 * MakerVault.withdraw / withdrawPosition (MakerVault.sol:312-316, 332-337), KeeperRewards.defund
 * (KeeperRewards.sol:187-191) and RewardsDistributor.defund (RewardsDistributor.sol:161-165). The
 * functions that DO read msg.sender are user paths carrying no role at all (MakerVault.deposit,
 * KeeperRewards.fund, PayoutRouter.swapToUsdg, OrderBook.claimOwed), and the delay-0 lanes, which
 * never schedule anything.
 *
 * HOW TO KEEP IT HONEST when a target changes or one of the three frozen contracts (PayoutRouter,
 * FeeSplitter, V4BuybackExecutor) lands. From a callhouse-contracts checkout:
 *
 *   awk '/^[ \t]*function /{fn=$0} /msg\.sender/{print FILENAME": "NR"  "fn}' $(find src/v2 -name '*.sol')
 *
 * Add `"<Contract>.<canonical signature>"` for every hit that is (a) mapped in roles.json to a role
 * whose delaysS is > 0 and (b) really reads msg.sender in its own body. Never from the name: a
 * `withdraw` that pays a stored treasury does not belong here and a `setRoot` that stamped
 * msg.sender would.
 */
export const MSG_SENDER_FUNCTIONS = new Set([]);

/* ---------------------------------------------------------------------------------------------- */
/*  signatures                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Solidity elementary types this driver can encode. Anything else is refused rather than guessed. */
const ELEMENTARY_RE = /^(address|bool|string|bytes|bytes([1-9]|[12][0-9]|3[0-2])|(u?int)(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$/;
const ARRAY_SUFFIX_RE = /^(\[\d*\])*$/;

/** Split on the commas at bracket depth 0, so `(uint16,uint16),address` is two parts and not three. */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) throw new AdminError(`unbalanced brackets in ${JSON.stringify(text)}`);
  }
  if (depth !== 0) throw new AdminError(`unbalanced brackets in ${JSON.stringify(text)}`);
  parts.push(text.slice(start));
  return parts;
}

/** One parameter of a signature as an ABI input: `{ type }`, or `{ type: "tuple…", components }`. */
function parseParam(text) {
  const trimmed = text.trim();
  if (trimmed === "") throw new AdminError("empty parameter in the signature");
  if (trimmed.startsWith("(")) {
    // A tuple: find its closing paren, then whatever array suffix follows it. A trailing parameter
    // NAME (`(uint16,uint16) fees`) is accepted and dropped — roles.json spells types only, but a
    // signature copied out of the Solidity source should still plan rather than half-parse.
    let depth = 0;
    let close = -1;
    for (let i = 0; i < trimmed.length; i += 1) {
      if (trimmed[i] === "(") depth += 1;
      else if (trimmed[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) throw new AdminError(`unbalanced parentheses in parameter ${JSON.stringify(trimmed)}`);
    const inner = trimmed.slice(1, close);
    const suffix = trimmed.slice(close + 1).trim().split(/\s+/)[0] ?? "";
    if (!ARRAY_SUFFIX_RE.test(suffix)) throw new AdminError(`parameter ${JSON.stringify(trimmed)}: ${JSON.stringify(suffix)} is not an array suffix`);
    const components = inner.trim() === "" ? [] : splitTop(inner).map(parseParam);
    if (components.length === 0) throw new AdminError(`parameter ${JSON.stringify(trimmed)}: an empty tuple encodes nothing`);
    return { type: `tuple${suffix}`, components };
  }
  const token = trimmed.split(/\s+/)[0];
  const suffixAt = token.indexOf("[");
  const base = suffixAt === -1 ? token : token.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : token.slice(suffixAt);
  if (!ELEMENTARY_RE.test(base)) throw new AdminError(`parameter ${JSON.stringify(token)}: ${JSON.stringify(base)} is not an elementary Solidity type`);
  if (!ARRAY_SUFFIX_RE.test(suffix)) throw new AdminError(`parameter ${JSON.stringify(token)}: ${JSON.stringify(suffix)} is not an array suffix`);
  // `uint` and `int` are aliases the ABI spells in full; roles.json already does, and so must the
  // canonical form, or the selector would differ from the one the manager was mapped with.
  const canonicalBase = base === "uint" ? "uint256" : base === "int" ? "int256" : base;
  return { type: `${canonicalBase}${suffix}` };
}

/** `{ name, inputs }` of a full function signature. Pure: no keccak, so no selector is computed here. */
export function parseSignature(signature) {
  if (typeof signature !== "string") throw new AdminError(`signature must be a string, got ${typeof signature}`);
  const text = signature.trim().replace(/^function\s+/, "");
  const open = text.indexOf("(");
  if (open === -1 || !text.endsWith(")")) {
    throw new AdminError(`${JSON.stringify(signature)} is not a full function signature, e.g. setMarketFees(address,uint16,uint32)`);
  }
  const name = text.slice(0, open).trim();
  if (!NAME_RE.test(name)) throw new AdminError(`${JSON.stringify(signature)}: ${JSON.stringify(name)} is not a function name`);
  const inner = text.slice(open + 1, -1).trim();
  const inputs = inner === "" ? [] : splitTop(inner).map(parseParam);
  return { name, inputs };
}

/** The type-only spelling roles.json uses as its key, rebuilt from the parse. */
export function canonicalSignature(signature) {
  const { name, inputs } = parseSignature(signature);
  return `${name}(${inputs.map(canonicalType).join(",")})`;
}

function canonicalType(param) {
  if (!param.type.startsWith("tuple")) return param.type;
  return `(${param.components.map(canonicalType).join(",")})${param.type.slice("tuple".length)}`;
}

/**
 * The signature as a one-entry JSON ABI, which is what viem encodes from and what ops/devnet/lib.mjs
 * `send` decodes reverts against. Built from the signature rather than from a published ABI file on
 * purpose: three of roles.json's targets (PayoutRouter, FeeSplitter, V4BuybackExecutor) are frozen
 * from 03-INTERFACES and have no compiled ABI in ops/abis/v2 yet, and roles.json's own key is the
 * canonical signature in any case.
 */
export function abiItemFor(signature) {
  const { name, inputs } = parseSignature(signature);
  return { type: "function", name, inputs, outputs: [], stateMutability: "nonpayable" };
}

/* ---------------------------------------------------------------------------------------------- */
/*  arguments                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;

const intBits = (type) => {
  const bits = type.replace(/^u?int/, "");
  return bits === "" ? 256 : Number(bits);
};

/**
 * One CLI argument as the value viem encodes. Strings in, JS values out; arrays and tuples are given
 * as JSON (`'[100,50]'`), and a tuple is an ARRAY because roles.json spells its components without
 * names, which is the form viem expects for an unnamed tuple.
 *
 * Ranges are checked here rather than left to the chain: `setMarketFees(…, 70000, …)` on a uint16 is
 * a typo worth naming, not a revert to decode. The address case lowercases instead of checksumming —
 * there is no keccak in the pure half, viem accepts an all-lowercase address, and the encoded word is
 * identical either way. A checksum is display, never encoding.
 */
export function coerceArg(param, raw, where = "argument") {
  const type = param.type;
  const arrayAt = type.lastIndexOf("[");
  if (arrayAt !== -1) {
    const elem = type.slice(0, arrayAt);
    const fixed = type.slice(arrayAt + 1, -1);
    const value = typeof raw === "string" ? parseJson(raw, where) : raw;
    if (!Array.isArray(value)) throw new AdminError(`${where}: ${type} wants a JSON array, got ${JSON.stringify(raw)}`);
    if (fixed !== "" && value.length !== Number(fixed)) throw new AdminError(`${where}: ${type} wants ${fixed} entries, got ${value.length}`);
    const elemParam = elem.startsWith("tuple") ? { type: elem, components: param.components } : { type: elem };
    return value.map((v, i) => coerceArg(elemParam, v, `${where}[${i}]`));
  }
  if (type === "tuple") {
    const value = typeof raw === "string" ? parseJson(raw, where) : raw;
    if (!Array.isArray(value)) {
      throw new AdminError(`${where}: ${canonicalType(param)} wants a JSON array of its ${param.components.length} fields, got ${JSON.stringify(raw)}`);
    }
    if (value.length !== param.components.length) {
      throw new AdminError(`${where}: ${canonicalType(param)} wants ${param.components.length} fields, got ${value.length}`);
    }
    return value.map((v, i) => coerceArg(param.components[i], v, `${where}.${i}`));
  }
  if (type === "address") {
    if (typeof raw !== "string" || !ADDRESS_RE.test(raw)) throw new AdminError(`${where}: ${JSON.stringify(raw)} is not a 20-byte address`);
    return raw.toLowerCase();
  }
  if (type === "bool") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new AdminError(`${where}: ${JSON.stringify(raw)} is not a bool (true | false | 1 | 0)`);
  }
  if (type === "string") {
    if (typeof raw !== "string") throw new AdminError(`${where}: ${JSON.stringify(raw)} is not a string`);
    return raw;
  }
  if (type === "bytes") {
    if (typeof raw !== "string" || !HEX_RE.test(raw) || raw.length % 2 !== 0) throw new AdminError(`${where}: ${JSON.stringify(raw)} is not 0x-prefixed bytes`);
    return raw;
  }
  if (type.startsWith("bytes")) {
    const size = Number(type.slice("bytes".length));
    if (typeof raw !== "string" || !HEX_RE.test(raw) || raw.length !== 2 + size * 2) throw new AdminError(`${where}: ${JSON.stringify(raw)} is not ${type} (0x and ${size * 2} hex digits)`);
    return raw;
  }
  // uintN / intN
  const signed = type.startsWith("int");
  const bits = intBits(type);
  let value;
  if (typeof raw === "bigint") value = raw;
  else if (typeof raw === "number") {
    if (!Number.isInteger(raw)) throw new AdminError(`${where}: ${raw} is not an integer`);
    // A JSON number above 2^53 has already lost digits by the time it reaches here; the only honest
    // answer is to refuse and ask for the quoted form.
    if (!Number.isSafeInteger(raw)) throw new AdminError(`${where}: ${raw} is past 2^53 and a JSON number cannot carry it exactly — quote it as a string`);
    value = BigInt(raw);
  } else if (typeof raw === "string") {
    const text = raw.trim().replace(/_/g, "");
    if (!/^-?(\d+|0x[0-9a-fA-F]+)$/.test(text)) throw new AdminError(`${where}: ${JSON.stringify(raw)} is not a ${type} (decimal or 0x hex)`);
    value = BigInt(text);
  } else throw new AdminError(`${where}: ${JSON.stringify(raw)} is not a ${type}`);
  const limit = 1n << BigInt(signed ? bits - 1 : bits);
  if (signed ? value >= limit || value < -limit : value >= limit || value < 0n) {
    throw new AdminError(`${where}: ${value} does not fit in ${type}`);
  }
  return value;
}

function parseJson(raw, where) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AdminError(`${where}: ${JSON.stringify(raw)} is not JSON (${error.message})`);
  }
}

/** Every argument of a call, checked for arity first so a shifted argument list is named, not encoded. */
export function coerceArgs(signature, args) {
  const { name, inputs } = parseSignature(signature);
  if (args.length !== inputs.length) {
    throw new AdminError(
      `${name} takes ${inputs.length} argument(s) (${inputs.map(canonicalType).join(", ") || "none"}), got ${args.length}`,
    );
  }
  return inputs.map((input, i) => coerceArg(input, args[i], `${name} argument ${i + 1} (${canonicalType(input)})`));
}

/* ---------------------------------------------------------------------------------------------- */
/*  the plan                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * PURE. How `contract.signature` must be performed, resolved from ops/abis/v2/roles.json alone: no
 * chain, no node, no viem.
 *
 * An unmapped signature is REFUSED and never planned as ADMIN. roles.json notes.adminHasNoTarget:
 * "No target function is mapped to ADMIN. ADMIN is manager-only. An unmapped restricted selector
 * falls to ADMIN by default, which is exactly the mistake the access-matrix test must catch." A
 * driver that silently filled in ADMIN would perform that mistake instead of catching it.
 *
 * @param {object}  a
 * @param {string}  a.target     a contract NAME as roles.json.targets spells it
 * @param {string}  a.signature  the full signature; spacing is normalised, the types are not
 * @param {object}  [a.roles]    a loadRoles() result; read from ROLES_FILE when absent
 * @param {Set}     [a.msgSenderFunctions] override for the schedule-direct set (tests only)
 * @returns {{contract: string, signature: string, role: string, roleId: number, delayS: number, mode: string}}
 */
export function planFor({ target, signature, roles = loadRoles(), msgSenderFunctions = MSG_SENDER_FUNCTIONS }) {
  const contract = String(target);
  const functions = roles.targets[contract];
  if (functions === undefined || functions === null || typeof functions !== "object") {
    throw new AdminError(`${contract} is not a target in ${rel(roles.file)}. Targets: ${Object.keys(roles.targets).join(", ")}`);
  }
  const canonical = canonicalSignature(signature);
  const role = functions[canonical];
  if (role === undefined) {
    const known = Object.keys(functions);
    throw new AdminError(
      `${contract}.${canonical} is not a restricted function in ${rel(roles.file)}, so this driver will not plan it. ` +
        "An unmapped selector falls to ADMIN on chain (roles.json notes.adminHasNoTarget) and is never planned as ADMIN here. " +
        (known.length === 0
          ? `${contract} has no restricted function at all in the manifest.`
          : `${contract} restricted functions: ${known.join(", ")}.`) +
        " If the function really is privileged, the manifest is what has to change first.",
    );
  }
  const roleId = roles.roles[role];
  if (!Number.isInteger(roleId)) throw new AdminError(`${rel(roles.file)}: ${contract}.${canonical} maps to role ${JSON.stringify(role)}, which has no id`);
  const delayS = roles.delaysS[role];
  if (!Number.isInteger(delayS)) throw new AdminError(`${rel(roles.file)}: role ${role} has no execution delay`);
  const key = `${contract}.${canonical}`;
  // Delay 0 goes straight to execute BECAUSE schedule reverts on a zero setback (AccessManager.sol:464-465).
  const mode = delayS === 0 ? "execute" : msgSenderFunctions.has(key) ? "schedule-direct" : "schedule-execute";
  return { contract, signature: canonical, role, roleId, delayS, mode };
}

/** Every (contract, signature) the manifest publishes, planned. The test walks this. */
export function allPlans(roles = loadRoles(), msgSenderFunctions = MSG_SENDER_FUNCTIONS) {
  const out = [];
  for (const [contract, functions] of Object.entries(roles.targets)) {
    for (const signature of Object.keys(functions)) out.push(planFor({ target: contract, signature, roles, msgSenderFunctions }));
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  the chain                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * ops/devnet/lib.mjs, imported here and nowhere else. It resolves viem through the keeper workspace
 * package and process.exit(2)s with its own message when it cannot, which is the loud failure a real
 * devnet run should get; the pure half above never reaches this line.
 */
async function devnetLib() {
  return import(pathToFileURL(DEVNET_LIB).href);
}

/** The AccessManager ABI with V2Errors merged in, so a revert decodes by name (ops/devnet/lib.mjs:105). */
const managerAbi = (lib) => lib.abiOf("AccessManager");

/**
 * The manager's own view of this call, read before anything is sent: the role the chain maps the
 * selector to, and the Safe's membership and execution delay for it. A manifest that disagrees with
 * the chain is the failure this whole file exists to prevent — the plan would pick a mode for a delay
 * the member does not have — so the disagreement is named and the call refused rather than sent and
 * decoded from a revert. `--no-preflight` skips it for a node that is mid-deploy.
 */
async function preflight({ lib, manager, safe, target, plan }) {
  const abi = managerAbi(lib);
  const selector = lib.viem.toFunctionSelector(`function ${plan.signature}`);
  const chainRoleId = Number(await lib.read(manager, abi, "getTargetFunctionRole", [target, selector]));
  if (chainRoleId !== plan.roleId) {
    throw new AdminError(
      `${plan.contract}.${plan.signature} (${selector}) is role ${chainRoleId} on the manager at ${manager}, and ${rel(ROLES_FILE)} says ${plan.role} (${plan.roleId}). ` +
        "The manifest and the deployment disagree; re-export roles.json or re-deploy before driving admin calls.",
    );
  }
  const [isMember, executionDelayS] = await lib.read(manager, abi, "hasRole", [BigInt(plan.roleId), safe]);
  if (!isMember) throw new AdminError(`${safe} does not hold ${plan.role} (${plan.roleId}) on the manager at ${manager}: nothing it schedules or executes for ${plan.contract}.${plan.signature} can pass`);
  if (Number(executionDelayS) !== plan.delayS) {
    throw new AdminError(
      `${safe} has an execution delay of ${Number(executionDelayS)} s for ${plan.role} on chain, and ${rel(ROLES_FILE)} publishes ${plan.delayS} s. ` +
        `A plan built on the manifest would take the ${plan.mode} path for a delay the member does not have.`,
    );
  }
  return { selector, chainRoleId, isMember, executionDelayS: Number(executionDelayS) };
}

/**
 * `target` as both halves of what a call needs: the manifest NAME the plan is read under and the
 * ADDRESS the transaction goes to. A bare name cannot be sent to and a bare address cannot be
 * planned from, so both are required and a caller that has only one is told which one is missing
 * rather than meeting `undefined is not a target`.
 */
function resolveTarget(target, { needAddress }) {
  if (typeof target === "string") {
    throw new AdminError(
      `target must be { contract, address } and not ${JSON.stringify(target)}: the manifest name resolves the role and the address is what the transaction goes to. ` +
        "ops/v2/devnet-admin.mjs resolves both from ops/devnet/addresses.json.",
    );
  }
  if (target === null || typeof target !== "object") throw new AdminError(`target must be { contract, address }, got ${JSON.stringify(target)}`);
  const contract = target.contract ?? target.name;
  if (typeof contract !== "string" || contract === "") throw new AdminError("target.contract is missing: it is the contract NAME as ops/abis/v2/roles.json targets spells it");
  if (needAddress && (typeof target.address !== "string" || !ADDRESS_RE.test(target.address))) {
    throw new AdminError(`target.address for ${contract} is ${JSON.stringify(target.address)}, which is not an address`);
  }
  return { contract, address: target.address ?? null };
}

/**
 * Perform `contract.signature(args…)` as the Safe, in whichever of the three modes the manifest says.
 *
 * The Safe is impersonated (anvil_impersonateAccount) and funded (anvil_setBalance) exactly as
 * ops/devnet/lib.mjs:296-297 does for a whale, and impersonation is stopped in a `finally`, so a
 * revert half way through leaves the node as it was found.
 *
 * @returns {Promise<{operationId: string|null, mode: string, scheduledAt: number|null, executedAt: number|null, txs: object[]}>}
 */
export async function adminCall({ manager, safe, target, signature, args = [], dryRun = false, roles = loadRoles(), skipPreflight = false }) {
  const { contract, address } = resolveTarget(target, { needAddress: !dryRun });
  const plan = planFor({ target: contract, signature, roles });
  const argv = coerceArgs(plan.signature, args);
  const item = abiItemFor(plan.signature);

  if (dryRun) {
    // Sends nothing and opens no connection. The calldata and the operation id are computed only if
    // viem happens to resolve; a checkout without node_modules still gets the whole plan.
    const offline = await offlineEncode({ safe, address, item, argv, plan });
    return { plan, mode: plan.mode, operationId: offline.operationId, data: offline.data, scheduledAt: null, executedAt: null, txs: [], dryRun: true, note: offline.note };
  }

  const lib = await devnetLib();
  const abi = managerAbi(lib);
  const data = lib.viem.encodeFunctionData({ abi: [item], functionName: item.name, args: argv });
  const chain = skipPreflight ? null : await preflight({ lib, manager, safe, target: address, plan });
  // The manager hashes its own operation ids; reading hashOperation(SAFE, target, data) keeps the
  // CALLER right (AccessManager.sol:588-589) and keeps a second keccak out of this file.
  const operationId = await lib.read(manager, abi, "hashOperation", [safe, address, data]);

  const txs = [];
  let scheduledAt = null;
  let executedAt = null;
  await lib.rpc("anvil_impersonateAccount", [safe]);
  await lib.rpc("anvil_setBalance", [safe, lib.viem.toHex(10n ** 18n)]);
  try {
    if (plan.mode !== "execute") {
      // `when = 0`: the manager clamps it up to now + setback itself (AccessManager.sol:467-469), so
      // the ready time is the chain's number and never one computed here.
      const scheduled = await lib.send(safe, { address: manager, abi, functionName: "schedule", args: [address, data, 0], label: `schedule ${plan.contract}.${plan.signature}` });
      txs.push({ step: "schedule", hash: scheduled.hash });
      scheduledAt = Number(await lib.read(manager, abi, "getSchedule", [operationId]));
      if (scheduledAt === 0) throw new AdminError(`schedule ${plan.contract}.${plan.signature}: the manager reports no schedule for ${operationId} right after scheduling it`);
      // One time-travel implementation for the whole repository: ops/devnet/lib.mjs:227.
      await lib.warpTo(scheduledAt);
    }
    if (plan.mode === "schedule-direct") {
      // The member calls the TARGET, so the target sees the Safe. Managed._checkCanCall consumes the
      // scheduled operation on the manager (src/v2/access/Managed.sol:65-72, AccessManaged.sol:95-111).
      const direct = await lib.send(safe, { address, abi: [item], functionName: item.name, args: argv, label: `${plan.contract}.${plan.signature} direct` });
      txs.push({ step: "direct", hash: direct.hash });
    } else {
      const executed = await lib.send(safe, { address: manager, abi, functionName: "execute", args: [address, data], label: `execute ${plan.contract}.${plan.signature}` });
      txs.push({ step: "execute", hash: executed.hash });
    }
    executedAt = await lib.now();
  } finally {
    await lib.rpc("anvil_stopImpersonatingAccount", [safe]);
  }
  return { plan, mode: plan.mode, operationId, data, chain, scheduledAt, executedAt, txs, dryRun: false };
}

/**
 * The guardian lane: cancel an operation that is waiting out its delay. `cancel(caller, target, data)`
 * takes the SAFE as `caller` because that is who scheduled it and what the id was hashed with
 * (AccessManager.sol:537-552); the SENDER may be the scheduler itself, an ADMIN, or the role's
 * guardian (`_canCancel`, AccessManager.sol:722), which for roles 1-5 is GUARDIAN (roles.json
 * roleGuardian). O8-06 drills exactly this.
 */
export async function adminCancel({ manager, guardian, safe, target, signature, args = [], roles = loadRoles() }) {
  const { contract, address } = resolveTarget(target, { needAddress: true });
  const plan = planFor({ target: contract, signature, roles });
  const argv = coerceArgs(plan.signature, args);
  const item = abiItemFor(plan.signature);
  const lib = await devnetLib();
  const abi = managerAbi(lib);
  const data = lib.viem.encodeFunctionData({ abi: [item], functionName: item.name, args: argv });
  const operationId = await lib.read(manager, abi, "hashOperation", [safe, address, data]);
  const scheduledAt = Number(await lib.read(manager, abi, "getSchedule", [operationId]));
  if (scheduledAt === 0) {
    throw new AdminError(`${plan.contract}.${plan.signature}: nothing is scheduled under ${operationId} (caller ${safe}), so there is nothing to cancel`);
  }
  const txs = [];
  await lib.rpc("anvil_impersonateAccount", [guardian]);
  await lib.rpc("anvil_setBalance", [guardian, lib.viem.toHex(10n ** 18n)]);
  try {
    const canceled = await lib.send(guardian, { address: manager, abi, functionName: "cancel", args: [safe, address, data], label: `cancel ${plan.contract}.${plan.signature}` });
    txs.push({ step: "cancel", hash: canceled.hash });
  } finally {
    await lib.rpc("anvil_stopImpersonatingAccount", [guardian]);
  }
  return { plan, mode: plan.mode, operationId, data, scheduledAt, canceledAt: await lib.now(), txs };
}

/**
 * --dry-run's calldata and operation id, when they can be had without a node. viem is resolved the
 * same way ops/devnet/lib.mjs:25 resolves it, but through a try/catch: a checkout with no
 * node_modules still prints the whole plan, with `note` saying what is missing and why.
 */
async function offlineEncode({ safe, address, item, argv, plan }) {
  let viem;
  try {
    const { createRequire } = await import("node:module");
    viem = createRequire(path.join(ROOT, "keeper", "package.json"))("viem");
  } catch (error) {
    // First line only: the require stack that follows is three lines of noise around one fact.
    const why = String(error.message).split("\n")[0];
    return { data: null, operationId: null, note: `calldata and operation id need viem through the keeper package (${why}); the plan above is read from the manifest and needs nothing` };
  }
  const data = viem.encodeFunctionData({ abi: [item], functionName: item.name, args: argv });
  if (safe === null || safe === undefined || address === null || address === undefined) {
    return { data, operationId: null, note: `the operation id is keccak256(abi.encode(caller, target, data)) and needs both the Safe and ${plan.contract}'s address` };
  }
  // AccessManager.sol:588-589. The same three words the manager hashes, in the same order, with the
  // SAFE as caller. On a node the id is read from the manager instead; this branch exists for --dry-run.
  const operationId = viem.keccak256(
    viem.encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes" }], [safe, address, data]),
  );
  return { data, operationId, note: null };
}
