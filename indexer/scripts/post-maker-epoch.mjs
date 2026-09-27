#!/usr/bin/env node
// Review a completed reward epoch and emit the Admin Safe batches that post it. Nothing here signs or sends.
//
// ON v8 THE ROOT CANNOT BE POSTED FROM A KEY. `setRoot` is TREASURY_ADMIN, held only by the Admin Safe with a
// 24 h execution delay (contracts script/v2/roles.v8.json). A keystore `cast send` can only revert: an EOA gets
// NotAuthorized, and even the Safe gets AccessManagerNotScheduled until the call has been scheduled and the delay
// has run. So posting is two Safe transactions, and this tool builds both after a read-only preflight:
//
//   (no flag)   read-only preflight; prints the report and writes nothing
//   --apply     preflight, then the SCHEDULE batch: AccessManager.schedule(distributor, setRoot(...), 0)
//   --execute   the SAME preflight again, then the EXECUTE batch: the Safe calls distributor.setRoot directly
//
// The preflight runs twice on purpose. The funding floor, the already-posted check and the indexer snapshot can
// all change during the 24 h between the two batches, and a posted root is permanent (RewardsDistributor.setRoot:
// no replace, no revoke), so a check that only ran at schedule time would be a check of yesterday's chain.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, isAddress, isHash } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const WEEK = 604_800n;
const FIRST_MONDAY = 345_600n;
const TYPES = ["uint256", "uint256", "address", "uint256"];
const CHAIN_ID = 4663;
const ROOT_ABI = [{ type: "function", name: "root", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }] }];
const TOTAL_ABI = [{ type: "function", name: "totalOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
// `mapping(uint256 epoch => uint256) public claimedAmount` on the distributor
// (contracts src/v2/mm/RewardsDistributor.sol): base units already paid for that epoch. The difference from
// `totalOf` is what the epoch still owes, which is the term the funding floor was missing.
const CLAIMED_ABI = [{ type: "function", name: "claimedAmount", stateMutability: "view",
  inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
const BALANCE_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
// The distributor's reward token. The immutable is called `usdg` for ABI stability, but on the LENDER instance it
// holds the 18-dp STONKHOUSE token (RewardsDistributor.sol, "TWO INSTANCES, TWO TOKENS"). Reading it from the
// distributor itself is what keeps the funding floor in the token that instance actually pays.
const REWARD_TOKEN_ABI = [{ type: "function", name: "usdg", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const AUTHORITY_ABI = [{ type: "function", name: "authority", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
// HouseVaultFactory.vaults(): every vault that factory made. Both factory generations have it (contracts
// src/v2/periphery/house/HouseVaultFactory.sol, and the legacy factory's version of that file).
const FACTORY_VAULTS_ABI = [{ type: "function", name: "vaults", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] }];
const SET_ROOT_ABI = [{ type: "function", name: "setRoot", stateMutability: "nonpayable",
  inputs: [{ name: "epoch", type: "uint256" }, { name: "epochRoot", type: "bytes32" }, { name: "epochTotal", type: "uint256" }], outputs: [] }];
// OpenZeppelin AccessManager, the calls this tool reads or simulates.
const MANAGER_ABI = [
  { type: "function", name: "getTargetFunctionRole", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "bytes4" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "hasRole", stateMutability: "view",
    inputs: [{ type: "uint64" }, { type: "address" }], outputs: [{ type: "bool" }, { type: "uint32" }] },
  { type: "function", name: "hashOperation", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "bytes" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "getSchedule", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint48" }] },
  { type: "function", name: "schedule", stateMutability: "nonpayable",
    inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }, { name: "when", type: "uint48" }],
    outputs: [{ name: "operationId", type: "bytes32" }, { name: "nonce", type: "uint32" }] },
];
const ZERO_ROOT = `0x${"0".repeat(64)}`;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = resolve(SCRIPT_DIR, "../../ops/markets/tier1.json");
/** The generator each program's epoch file came from. Regeneration must use the same one. */
export const GENERATORS = { maker: join(SCRIPT_DIR, "maker-epoch.mjs"), lender: join(SCRIPT_DIR, "lender-epoch.mjs") };

function decimal(value, label, allowZero = false, allowSafeNumber = false) {
  if (typeof value === "number" && (!allowSafeNumber || !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a decimal integer string`);
  }
  if ((typeof value !== "string" && typeof value !== "number") || !/^(0|[1-9]\d*)$/.test(String(value))) {
    throw new Error(`${label} must be a decimal integer`);
  }
  const result = BigInt(value);
  if (!allowZero && result === 0n) throw new Error(`${label} must be positive`);
  return result;
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The reward programs this poster can post to. A program selects WHICH distributor instance and WHICH reward
 * token the epoch is denominated in; everything else -- the file format, `validateEpoch`, the Merkle rules --
 * is shared, which is why they are one script and not two.
 */
export const PROGRAMS = ["maker", "lender"];

/** How a run ends: the read-only report, the schedule batch (`--apply`) or the execute batch (`--execute`). */
export const MODES = ["read", "apply", "execute"];

/**
 * The distributor for `program`, from `v2.protocolAddresses.distributors.<program>`.
 * MAKER FALLS BACK to `v2.contracts.rewardsDistributor` so the pre-existing maker path keeps working
 * unchanged on a registry that predates the distributors block. The lender has no fallback on purpose: there
 * is no legacy lender address to be confused with, and guessing one would post real rewards to the wrong
 * contract.
 */
export function distributorFor(registry, program) {
  if (!PROGRAMS.includes(program)) throw new Error(`unknown --program ${program}; expected one of ${PROGRAMS.join(", ")}`);
  const named = registry?.v2?.protocolAddresses?.distributors?.[program];
  if (isAddress(named)) return named;
  if (program === "maker") {
    const legacy = registry?.v2?.contracts?.rewardsDistributor;
    if (isAddress(legacy)) return legacy;
  }
  throw new Error(`registry has no ${program} distributor: set v2.protocolAddresses.distributors.${program}`);
}

/**
 * The token `program` pays, as the registry names it: USDG (`shared.usdg`) for maker, the STONKHOUSE token
 * (`shared.token.address`) for lender. The preflight compares this with the distributor's own `usdg()`, so a
 * registry that wires one program's distributor under the other's key is refused instead of posted.
 */
export function rewardTokenFor(registry, program) {
  if (!PROGRAMS.includes(program)) throw new Error(`unknown --program ${program}; expected one of ${PROGRAMS.join(", ")}`);
  const token = program === "maker" ? registry?.shared?.usdg : registry?.shared?.token?.address;
  if (!isAddress(token)) {
    throw new Error(`registry lacks the ${program} reward token: set ${program === "maker" ? "shared.usdg" : "shared.token.address"}`);
  }
  return token;
}

/**
 * The Admin Safe: `v2.protocolAddresses.admin`, else `shared.safes.admin`. When both are set they must agree,
 * because the operation id hashes the CALLER -- a batch built for one Safe cannot be executed by another.
 */
export function adminSafeFor(registry) {
  const named = registry?.v2?.protocolAddresses?.admin;
  const shared = registry?.shared?.safes?.admin;
  if (isAddress(named) && isAddress(shared) && !same(named, shared)) {
    throw new Error(`registry names two Admin Safes: v2.protocolAddresses.admin ${named} and shared.safes.admin ${shared}`);
  }
  if (isAddress(named)) return named;
  if (isAddress(shared)) return shared;
  throw new Error("registry has no Admin Safe: set v2.protocolAddresses.admin");
}

/**
 * The registry keys that name an account the protocol itself controls. None of them may ever be a leaf of a reward
 * root (v9 pre-deploy). A pooled vault that earns a reward can have that reward
 * captured by anyone who deposits before the claim and redeems after it. A fee sink or a distributor would pay
 * protocol money back to the protocol.
 * The maker scorer already drops these makers (src/v2/makerScoring.ts protocolMakerKeys), but it drops them from
 * the indexer's own env on the day it runs. This is the check at POSTING time, against the registry the post is
 * reviewed with.
 */
export const PROTOCOL_ACCOUNT_KEYS = [
  "v2.contracts.makerVault", "v2.contracts.earnVault", "v2.contracts.houseVault", "v2.contracts.rewardsDistributor",
  "v2.contracts.rewardsDistributorLender", "v2.protocolAddresses.makerVault", "v2.protocolAddresses.feeSplitter",
  "v2.protocolAddresses.feeRecipient", "v2.protocolAddresses.treasury", "v2.protocolAddresses.buybackExecutor",
  ...PROGRAMS.map((program) => `v2.protocolAddresses.distributors.${program}`),
];

/**
 * `[{ address, key }]` for every PROTOCOL_ACCOUNT_KEYS entry the registry sets. An absent (or null) key is skipped.
 * A key that is set but is not an address is refused, because skipping it would switch the check off without saying so.
 */
export function protocolAccounts(registry) {
  const found = [];
  for (const key of PROTOCOL_ACCOUNT_KEYS) {
    const value = key.split(".").reduce((node, part) => node?.[part], registry);
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !isAddress(value, { strict: false })) {
      throw new Error(`registry key ${key} is set but is not an address: ${JSON.stringify(value)}`);
    }
    found.push({ address: value, key });
  }
  return found;
}

/**
 * The House vaults, read from the factories the registry names. The registry lists the factories
 * (`v2.house.factories[].address`, and `v2.contracts.houseVaultFactory`), not the vaults. So each factory is asked
 * for `vaults()` through the preflight's own chain client. An unreadable factory refuses the run: a factory whose
 * vaults cannot be listed is a hole in this check, not an empty list.
 */
export async function houseVaultAccounts(registry, chain) {
  const factories = [];
  (registry?.v2?.house?.factories ?? []).forEach((row, i) => factories.push({ address: row?.address, key: `v2.house.factories[${i}]` }));
  factories.push({ address: registry?.v2?.contracts?.houseVaultFactory, key: "v2.contracts.houseVaultFactory" });
  const found = [];
  const done = new Set();
  for (const { address, key } of factories) {
    if (address === undefined || address === null || done.has(String(address).toLowerCase())) continue;
    if (typeof address !== "string" || !isAddress(address, { strict: false })) {
      throw new Error(`registry key ${key} is set but is not an address: ${JSON.stringify(address)}`);
    }
    done.add(address.toLowerCase());
    let vaults;
    try {
      vaults = await chain.houseVaults(address);
    } catch (error) {
      const message = error instanceof Error ? (error.shortMessage ?? error.message) : String(error);
      throw new Error(`cannot list the House vaults of factory ${address} (${key}): ${message}`);
    }
    for (const vault of vaults) found.push({ address: vault, key: `a House vault of factory ${address} (${key})` });
  }
  return found;
}

/**
 * Refuses an epoch with ANY leaf naming a protocol account, and names each such account and the key it matched.
 * It never filters: dropping a leaf changes the root, so the epoch must be regenerated and reviewed again instead.
 */
export function refuseProtocolAccounts(accounts, protocol) {
  if (!Array.isArray(accounts)) throw new Error("the epoch plan carries no accounts; build it with validateEpoch");
  const byAddress = new Map();
  for (const { address, key } of protocol) {
    const id = address.toLowerCase();
    byAddress.set(id, [...(byAddress.get(id) ?? []), key]);
  }
  const hits = accounts.filter((account) => byAddress.has(account.toLowerCase()))
    .map((account) => `${account} (${byAddress.get(account.toLowerCase()).join(", ")})`);
  if (hits.length > 0) {
    throw new Error(`epoch pays a protocol account, which must never earn a reward: ${hits.join("; ")}. ` +
      "Regenerate the epoch without it and review it again; this tool does not filter leaves.");
  }
}

/**
 * Every base unit this program still owes on epochs it has ALREADY posted: for each epoch with a root, the
 * posted total minus what has been claimed.
 *
 * WHY THE NEW TOTAL ALONE IS NOT ENOUGH, and the old check's own output said so ("Existing unpaid epochs may
 * also need funding"). Every epoch is paid out of ONE shared balance. `claim` reverts when the balance is
 * short and the entry STAYS CLAIMABLE -- a defund does not expire it -- so an unclaimed amount from three
 * epochs ago is a live liability, not history. Funding only the new epoch means the first late claimant of an
 * old epoch takes the new epoch's money, and the shortfall surfaces as a random claim reverting weeks later
 * rather than as a refusal here.
 *
 * `reader` is injected so this is testable without a chain.
 */
export async function outstandingLiability(reader, epoch, lookback) {
  if (lookback < 0n) throw new Error("lookback must not be negative");
  let owed = 0n;
  const first = epoch > lookback ? epoch - lookback : 0n;
  for (let e = first; e < epoch; e++) {
    const root = await reader.root(e);
    if (typeof root !== "string" || root.toLowerCase() === ZERO_ROOT) continue;
    const total = await reader.totalOf(e);
    const claimed = await reader.claimedAmount(e);
    if (claimed > total) throw new Error(`epoch ${e} reports ${claimed} claimed against a total of ${total}`);
    owed += total - claimed;
  }
  return owed;
}

/** What the distributor must hold before this epoch may be posted: the new total PLUS everything still owed. */
export function requiredBalance(planTotal, outstanding) {
  return planTotal + outstanding;
}

export function validateEpoch(file) {
  if (file === null || typeof file !== "object" || Array.isArray(file)) throw new Error("epoch file must be an object");
  const epoch = decimal(file.epoch, "epoch", true, true);
  const total = decimal(file.total, "total");
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("epoch exceeds JSON safe integer range");
  if (!isHash(file.root) || file.root.toLowerCase() === ZERO_ROOT) throw new Error("root must be nonzero bytes32");
  if (!Array.isArray(file.entries) || file.entries.length === 0 || file.entries.length > 10_000) {
    throw new Error("entries must contain 1..10000 makers");
  }
  let sum = 0n;
  const seen = new Set();
  const values = file.entries.map((entry, index) => {
    if (entry?.index !== index) throw new Error(`entry ${index} has wrong index`);
    if (!isAddress(entry.account)) throw new Error(`entry ${index} has invalid account`);
    const key = entry.account.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate account ${entry.account}`);
    seen.add(key);
    const amount = decimal(entry.amount, `entry ${index} amount`);
    sum += amount;
    if (!Array.isArray(entry.proof) || !entry.proof.every((item) => isHash(item))) {
      throw new Error(`entry ${index} has invalid proof`);
    }
    return [epoch.toString(), String(index), entry.account, amount.toString()];
  });
  if (sum !== total) throw new Error(`entry sum ${sum} differs from total ${total}`);
  const tree = StandardMerkleTree.of(values, TYPES);
  if (tree.root.toLowerCase() !== file.root.toLowerCase()) throw new Error("Merkle root does not match entries");
  for (let i = 0; i < values.length; i++) {
    const proof = file.entries[i].proof;
    if (!StandardMerkleTree.verify(tree.root, TYPES, values[i], proof)) {
      throw new Error(`entry ${i} proof does not verify`);
    }
  }
  return { epoch, total, root: tree.root, makers: values.length, endsAt: FIRST_MONDAY + (epoch + 1n) * WEEK,
    accounts: values.map((value) => value[2]) };
}

/** `setRoot(epoch, root, total)` calldata: the inner call the Safe schedules and later sends. */
export function setRootCalldata(plan) {
  return encodeFunctionData({ abi: SET_ROOT_ABI, functionName: "setRoot", args: [plan.epoch, plan.root, plan.total] });
}

/**
 * `AccessManager.schedule(distributor, inner, 0)`. `when = 0` asks for the earliest time the caller may run it:
 * now plus the Safe's execution delay.
 */
export function scheduleCalldata(distributor, inner) {
  return encodeFunctionData({ abi: MANAGER_ABI, functionName: "schedule", args: [distributor, inner, 0] });
}

/** A Safe{Wallet} Transaction Builder file holding one call. */
export function safeBatch({ safe, name, description, to, data }) {
  return {
    version: "1.0",
    chainId: String(CHAIN_ID),
    createdAt: 0,
    meta: { name, description, createdFromSafeAddress: safe },
    transactions: [{ to, value: "0", data, contractMethod: null, contractInputsValues: null }],
  };
}

/**
 * The regeneration command for `program`: the SAME generator that produced the file, with the same inputs.
 * Maker reads the indexer (`INDEXER_URL`); lender has no route to read and regenerates from the balance file
 * it was built from, with the same cap and exclusions (lender-epoch.mjs `--input`). Regenerating a lender file
 * with the maker generator -- what this script used to do for every program -- could never match it.
 */
export function regenerationCommand(program, plan, options, output) {
  if (program === "maker") {
    return { script: GENERATORS.maker, args: [String(plan.epoch), String(plan.total), "--output", output] };
  }
  if (program !== "lender") throw new Error(`unknown --program ${program}; expected one of ${PROGRAMS.join(", ")}`);
  if (!options?.balances) throw new Error("--program lender regenerates from its balance file: pass --balances <file>");
  const args = [String(plan.epoch), String(plan.total), "--input", options.balances, "--output", output];
  if (options.registry) args.push("--registry", options.registry);
  if (options.capBps !== null && options.capBps !== undefined) args.push("--cap-bps", String(options.capBps));
  for (const address of options.exclude ?? []) args.push("--exclude", address);
  return { script: GENERATORS[program], args };
}

/** Runs the program's generator into a temporary directory and returns the file it wrote. */
export function regenerator(options, env = process.env) {
  return async (program, plan) => {
    const temporary = await mkdtemp(join(tmpdir(), `${program}-epoch-post-`));
    try {
      const output = join(temporary, "epoch.json");
      const { script, args } = regenerationCommand(program, plan, options, output);
      execFileSync(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(await readFile(output, "utf8"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

/** The chain reads the preflight makes, over a viem public client. Tests inject a stub with the same shape. */
export function viemChain(client) {
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  return {
    chainId: () => client.getChainId(),
    block: () => client.getBlock(),
    rewardToken: (distributor) => read(distributor, REWARD_TOKEN_ABI, "usdg"),
    authority: (target) => read(target, AUTHORITY_ABI, "authority"),
    houseVaults: (factory) => read(factory, FACTORY_VAULTS_ABI, "vaults"),
    root: (distributor, epoch) => read(distributor, ROOT_ABI, "root", [epoch]),
    totalOf: (distributor, epoch) => read(distributor, TOTAL_ABI, "totalOf", [epoch]),
    claimedAmount: (distributor, epoch) => read(distributor, CLAIMED_ABI, "claimedAmount", [epoch]),
    balanceOf: (token, holder) => read(token, BALANCE_ABI, "balanceOf", [holder]),
    targetFunctionRole: (manager, target, selector) => read(manager, MANAGER_ABI, "getTargetFunctionRole", [target, selector]),
    hasRole: (manager, roleId, account) => read(manager, MANAGER_ABI, "hasRole", [roleId, account]),
    hashOperation: (manager, caller, target, data) => read(manager, MANAGER_ABI, "hashOperation", [caller, target, data]),
    getSchedule: (manager, operationId) => read(manager, MANAGER_ABI, "getSchedule", [operationId]),
    simulate: async ({ from, to, data }) => (await client.call({ account: from, to, data })).data,
  };
}

async function simulate(chain, call, label) {
  try {
    return await chain.simulate(call);
  } catch (error) {
    const message = error instanceof Error ? (error.shortMessage ?? error.message) : String(error);
    throw new Error(`${label} from the Admin Safe ${call.from} reverts in simulation: ${message}`);
  }
}

/**
 * The preflight, in every mode, and the batch it earns. Refuses (throws) on the first failed check.
 *
 * Checks, in order: chain 4663; the distributor pays the program's registry token and is governed by the
 * registry's AccessManager; the epoch has ended; it is not already posted (a matching posted root ends the run
 * with status "posted", a different one refuses); the distributor holds the new total plus everything still owed,
 * in ITS reward token; the Admin Safe holds the role that gates setRoot, with a delay. Then, for the two batch
 * modes only: the operation is unscheduled (--apply) or scheduled and ready (--execute); a fresh regeneration
 * reproduces the file; and the exact Safe call simulates without reverting.
 */
export async function preflight(mode, { plan, program, registry, chain, lookback = 52n, regenerate }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}; expected one of ${MODES.join(", ")}`);
  const distributor = distributorFor(registry, program);
  const expectedToken = rewardTokenFor(registry, program);
  const safe = adminSafeFor(registry);
  const chainId = Number(await chain.chainId());
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain ${chainId}; expected ${CHAIN_ID}`);
  // PROTOCOL ACCOUNTS NEVER EARN. Checked in every mode, the read-only review included, and before the
  // already-posted early return, so a run never reports an epoch that pays one as fine.
  refuseProtocolAccounts(plan.accounts, [...protocolAccounts(registry), ...await houseVaultAccounts(registry, chain)]);
  const [block, token, manager] = await Promise.all([
    chain.block(), chain.rewardToken(distributor), chain.authority(distributor),
  ]);
  // The floor is measured in the token THIS distributor pays. The lender instance holds STONKHOUSE, so
  // reading USDG there measured a balance that can never pay a lender claim.
  if (!same(token, expectedToken)) {
    throw new Error(`${program} distributor ${distributor} pays ${token}, but the registry's ${program} reward token is ${expectedToken}`);
  }
  const registryManager = registry?.v2?.protocolAddresses?.accessManager ?? registry?.v2?.contracts?.accessManager;
  if (isAddress(registryManager) && !same(registryManager, manager)) {
    throw new Error(`${program} distributor ${distributor} is governed by ${manager}, not the registry's AccessManager ${registryManager}`);
  }
  if (block.timestamp < plan.endsAt) throw new Error(`epoch ${plan.epoch} is still running; ends at ${plan.endsAt}`);

  const reader = {
    root: (e) => chain.root(distributor, e),
    totalOf: (e) => chain.totalOf(distributor, e),
    claimedAmount: (e) => chain.claimedAmount(distributor, e),
  };
  const [posted, postedTotal] = await Promise.all([reader.root(plan.epoch), reader.totalOf(plan.epoch)]);
  /** @type {Record<string, string | number>} gains the floor, role and schedule fields as those checks pass */
  const report = { mode, chainId, block: String(block.number), program, distributor, rewardToken: token,
    accessManager: manager, adminSafe: safe, epoch: String(plan.epoch), makers: plan.makers, root: plan.root,
    totalBaseUnits: String(plan.total) };
  if (posted.toLowerCase() !== ZERO_ROOT) {
    if (!same(posted, plan.root) || postedTotal !== plan.total) {
      throw new Error(`epoch ${plan.epoch} already has a different root or total`);
    }
    return { status: "posted", report, batch: null };
  }

  // THE FUNDING FLOOR IS THE NEW TOTAL PLUS EVERYTHING STILL OWED, not the new total alone. Every epoch pays
  // from this one balance and an unclaimed entry never expires, so posting against a balance that only covers
  // the new epoch means the first late claimant of an OLD epoch takes the new epoch's money -- and the
  // shortfall appears as a claim reverting weeks later rather than as a refusal here. It runs again at
  // --execute because a defund or a late claim during the 24 h delay moves it.
  const [balance, outstanding] = await Promise.all([
    chain.balanceOf(token, distributor), outstandingLiability(reader, plan.epoch, lookback),
  ]);
  const required = requiredBalance(plan.total, outstanding);
  if (balance < required) {
    throw new Error(`${program} distributor holds ${balance} base units, below ${required} = new epoch total ${plan.total} + ${outstanding} still owed on posted epochs`);
  }
  Object.assign(report, { outstandingBaseUnits: String(outstanding), requiredBaseUnits: String(required),
    distributorBalance: String(balance), lookbackEpochs: String(lookback) });

  // THE ROLE, read rather than assumed: which role gates setRoot on this distributor, and whether the Safe holds
  // it with a delay. A zero delay would mean the Safe could call directly and the schedule batch would revert;
  // that is not the v8 configuration and the tool refuses rather than guess which batch is wanted.
  const inner = setRootCalldata(plan);
  const roleId = BigInt(await chain.targetFunctionRole(manager, distributor, inner.slice(0, 10)));
  const [isMember, rawDelay] = await chain.hasRole(manager, roleId, safe);
  const delay = BigInt(rawDelay);
  if (!isMember) throw new Error(`Admin Safe ${safe} does not hold role ${roleId}, which gates setRoot on ${distributor}`);
  if (delay === 0n) {
    throw new Error(`Admin Safe ${safe} holds role ${roleId} with no execution delay; v8 schedules setRoot, so re-read roles.v8.json before posting`);
  }
  const operationId = await chain.hashOperation(manager, safe, distributor, inner);
  const scheduledAt = BigInt(await chain.getSchedule(manager, operationId));
  Object.assign(report, { roleId: String(roleId), executionDelaySeconds: String(delay), operationId,
    scheduledAt: String(scheduledAt) });
  if (mode === "read") return { status: "ready", report, batch: null };

  if (mode === "apply" && scheduledAt !== 0n) {
    throw new Error(`operation ${operationId} is already scheduled, ready at ${scheduledAt}; run --execute once block time reaches it`);
  }
  if (mode === "execute") {
    // getSchedule is 0 for never scheduled, cancelled, executed and expired alike.
    if (scheduledAt === 0n) throw new Error(`operation ${operationId} is not scheduled (or was cancelled, executed or expired): run --apply first`);
    if (block.timestamp < scheduledAt) {
      throw new Error(`operation ${operationId} is not ready until ${scheduledAt}; block time is ${block.timestamp}`);
    }
  }

  // REGENERATE AND COMPARE, with the generator this program's file came from. The file is what gets posted; the
  // regeneration is the evidence that it is still what the current snapshot says.
  if (typeof regenerate !== "function") throw new Error("--apply and --execute regenerate the epoch; no regenerator was given");
  const current = validateEpoch(await regenerate(program, plan));
  if (!same(current.root, plan.root) || current.total !== plan.total) {
    throw new Error("epoch file differs from a fresh regeneration of the current completed snapshot; regenerate and review it");
  }

  const label = `${program} epoch ${plan.epoch}`;
  if (mode === "apply") {
    const data = scheduleCalldata(distributor, inner);
    const returned = await simulate(chain, { from: safe, to: manager, data }, "AccessManager.schedule");
    const [simulatedId] = decodeFunctionResult({ abi: MANAGER_ABI, functionName: "schedule", data: returned });
    if (!same(simulatedId, operationId)) {
      throw new Error(`schedule simulates operation ${simulatedId}, not ${operationId}; --execute would not find it`);
    }
    report.earliestExecuteAt = String(block.timestamp + delay);
    return { status: "schedule", report, batch: safeBatch({ safe, to: manager, data,
      name: `${label} 1/2: schedule RewardsDistributor.setRoot`,
      description: `AccessManager.schedule(${distributor}, setRoot(${plan.epoch}, ${plan.root}, ${plan.total}), 0). ` +
        `Role ${roleId}, ${delay} s delay, operation ${operationId}. Batch 2 comes from post-maker-epoch.mjs --execute, ` +
        "which re-runs every check, once block time reaches getSchedule(operation)." }) };
  }
  await simulate(chain, { from: safe, to: distributor, data: inner }, "RewardsDistributor.setRoot");
  return { status: "execute", report, batch: safeBatch({ safe, to: distributor, data: inner,
    name: `${label} 2/2: RewardsDistributor.setRoot`,
    description: `Direct call from the Admin Safe; consumes operation ${operationId}, ready since ${scheduledAt}. ` +
      `setRoot(${plan.epoch}, ${plan.root}, ${plan.total}) is permanent once mined.` }) };
}

export function parseArgs(argv, env = process.env) {
  // `program` DEFAULTS TO MAKER so every existing invocation means exactly what it meant before this flag
  // existed; `lookback` bounds the outstanding-liability scan.
  const args = { file: null, registry: DEFAULT_REGISTRY, rpc: env.RH_RPC, mode: "read", out: null,
    program: "maker", lookback: 52n, balances: null, capBps: null, exclude: [] };
  const value = (i, arg) => {
    const next = argv[i];
    if (!next) throw new Error(`${arg} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--program") {
      const program = value(++i, arg);
      if (!PROGRAMS.includes(program)) throw new Error(`unknown --program ${program}; expected one of ${PROGRAMS.join(", ")}`);
      args.program = program;
    } else if (arg === "--lookback") {
      const lookback = argv[++i];
      if (!/^\d+$/.test(lookback ?? "")) throw new Error("--lookback requires a whole number of epochs");
      args.lookback = BigInt(lookback);
    } else if (arg === "--apply" || arg === "--execute") {
      const mode = arg.slice(2);
      if (args.mode !== "read" && args.mode !== mode) throw new Error("--apply and --execute are separate runs; pass one");
      args.mode = mode;
    } else if (arg === "--account") {
      throw new Error("--account is gone: on v8 setRoot is TREASURY_ADMIN, held only by the Admin Safe with a 24 h delay, " +
        "so a keystore send can only revert. Use --apply for the schedule batch and --execute after the delay.");
    } else if (arg === "--registry" || arg === "--out" || arg === "--balances") {
      args[arg.slice(2)] = value(++i, arg);
    } else if (arg === "--cap-bps") {
      const capBps = value(++i, arg);
      if (!/^\d+$/.test(capBps)) throw new Error("--cap-bps requires a whole number");
      args.capBps = capBps;
    } else if (arg === "--exclude") {
      args.exclude.push(value(++i, arg));
    } else if (arg.startsWith("--") || args.file !== null) throw new Error(`unknown argument ${arg}`);
    else args.file = arg;
  }
  if (!args.file) {
    throw new Error("usage: post-maker-epoch.mjs <epoch.json> [--program maker|lender] [--lookback 52] [--registry path] " +
      "[--apply | --execute] [--out batch.json] [--balances file --cap-bps n --exclude 0x...]; RH_RPC required");
  }
  if (!args.rpc) throw new Error("RH_RPC is required");
  if (args.program === "maker" && (args.balances || args.capBps !== null || args.exclude.length > 0)) {
    throw new Error("--balances, --cap-bps and --exclude are lender regeneration inputs; the maker program regenerates from INDEXER_URL");
  }
  if (args.mode === "read") return args;
  const flag = `--${args.mode}`;
  if (!args.out) throw new Error(`${flag} requires --out <file> for the Safe Transaction Builder batch`);
  if (/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(args.rpc)) {
    throw new Error(`${flag} refuses a local RPC; use the target chain URL`);
  }
  if (args.program === "maker" && !env.INDEXER_URL) {
    throw new Error(`${flag} requires INDEXER_URL to recheck the final score snapshot`);
  }
  if (args.program === "lender" && !args.balances) {
    throw new Error(`${flag} --program lender requires --balances <file>, the balance series the epoch was generated from`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [file, registry] = await Promise.all([
    readFile(resolve(args.file), "utf8").then(JSON.parse),
    readFile(resolve(args.registry), "utf8").then(JSON.parse),
  ]);
  const plan = validateEpoch(file);
  const client = createPublicClient({ transport: http(args.rpc) });
  const result = await preflight(args.mode, { plan, program: args.program, registry, chain: viemChain(client),
    lookback: args.lookback, regenerate: regenerator({ balances: args.balances && resolve(args.balances),
      registry: resolve(args.registry), capBps: args.capBps, exclude: args.exclude }) });
  console.log(JSON.stringify(result.report, null, 2));
  if (result.status === "posted") { console.log(`epoch ${plan.epoch} already posted with matching root and total`); return; }
  if (result.batch === null) {
    console.log("Read-only preflight passed. --apply --out <file> emits the Admin Safe schedule batch; --execute after the delay.");
    return;
  }
  // `wx`: never overwrite a batch someone may already be reviewing or signing.
  await writeFile(resolve(args.out), `${JSON.stringify(result.batch, null, 2)}\n`, { flag: "wx" });
  console.log(`wrote "${result.batch.meta.name}" to ${args.out}. Import it into Safe{Wallet} Transaction Builder on ` +
    `the Admin Safe ${result.report.adminSafe}. Nothing was signed or sent.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error([[process.env.RH_RPC, "<RPC>"], [process.env.INDEXER_URL, "<INDEXER_URL>"]]
      .reduce((text, [secret, replacement]) => secret ? text.replaceAll(secret, replacement) : text, message));
    process.exitCode = 1;
  });
}
