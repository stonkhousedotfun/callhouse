#!/usr/bin/env node
// Review and optionally post a completed maker epoch. Keys stay in Foundry's local keystore.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isAddress, isHash } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const WEEK = 604_800n;
const FIRST_MONDAY = 345_600n;
const TYPES = ["uint256", "uint256", "address", "uint256"];
const ROOT_ABI = [{ type: "function", name: "root", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }] }];
const TOTAL_ABI = [{ type: "function", name: "totalOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
// `mapping(uint256 epoch => uint256) public claimedAmount` on the distributor
// (contracts src/v2/mm/RewardsDistributor.sol): base units already paid for that epoch. The difference from
// `totalOf` is what the epoch still owes, which is the term the funding floor was missing.
const CLAIMED_ABI = [{ type: "function", name: "claimedAmount", stateMutability: "view",
  inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
const BALANCE_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const ZERO_ROOT = `0x${"0".repeat(64)}`;
const DEFAULT_REGISTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../../ops/markets/tier1.json");

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

/**
 * The reward programs this poster can post to. A program selects WHICH distributor instance and WHICH reward
 * token the epoch is denominated in; everything else -- the file format, `validateEpoch`, the Merkle rules --
 * is shared, which is why they are one script and not two.
 */
export const PROGRAMS = ["maker", "lender"];

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
  return { epoch, total, root: tree.root, makers: values.length, endsAt: FIRST_MONDAY + (epoch + 1n) * WEEK };
}

function parse(argv) {
  // `program` DEFAULTS TO MAKER so every existing invocation means exactly what it meant before this flag
  // existed; `lookback` bounds the outstanding-liability scan below.
  const args = { file: null, registry: DEFAULT_REGISTRY, rpc: process.env.RH_RPC, account: null, apply: false,
    program: "maker", lookback: 52n };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--program") {
      const value = argv[++i];
      if (!value) throw new Error("--program requires a value");
      if (!PROGRAMS.includes(value)) throw new Error(`unknown --program ${value}; expected one of ${PROGRAMS.join(", ")}`);
      args.program = value;
    } else if (arg === "--lookback") {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? "")) throw new Error("--lookback requires a whole number of epochs");
      args.lookback = BigInt(value);
    } else if (arg === "--registry" || arg === "--account") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
    } else if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--") || args.file !== null) throw new Error(`unknown argument ${arg}`);
    else args.file = arg;
  }
  if (!args.file) throw new Error("usage: post-maker-epoch.mjs <epoch.json> [--program maker|lender] [--lookback 52] [--registry path] [--apply --account admin]; RH_RPC required");
  if (!args.rpc) throw new Error("RH_RPC is required");
  if (args.apply && !args.account) throw new Error("--apply requires a Foundry keystore --account");
  if (args.apply && !process.env.INDEXER_URL) throw new Error("--apply requires INDEXER_URL to recheck the final score snapshot");
  if (args.apply && /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(args.rpc)) {
    throw new Error("--apply refuses a local RPC; use the target chain URL");
  }
  return args;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const [file, registry] = await Promise.all([
    readFile(resolve(args.file), "utf8").then(JSON.parse),
    readFile(resolve(args.registry), "utf8").then(JSON.parse),
  ]);
  const plan = validateEpoch(file);
  const distributor = distributorFor(registry, args.program);
  const usdg = registry.shared?.usdg;
  if (!isAddress(usdg)) throw new Error("registry lacks the USDG address");
  const client = createPublicClient({ transport: http(args.rpc) });
  const [chainId, block, posted, postedTotal, balance] = await Promise.all([
    client.getChainId(), client.getBlock(),
    client.readContract({ address: distributor, abi: ROOT_ABI, functionName: "root", args: [plan.epoch] }),
    client.readContract({ address: distributor, abi: TOTAL_ABI, functionName: "totalOf", args: [plan.epoch] }),
    client.readContract({ address: usdg, abi: BALANCE_ABI, functionName: "balanceOf", args: [distributor] }),
  ]);
  if (chainId !== 4663) throw new Error(`wrong chain ${chainId}; expected 4663`);
  if (block.timestamp < plan.endsAt) throw new Error(`epoch ${plan.epoch} is still running; ends at ${plan.endsAt}`);
  if (posted.toLowerCase() !== ZERO_ROOT) {
    if (posted.toLowerCase() !== plan.root.toLowerCase() || postedTotal !== plan.total) {
      throw new Error(`epoch ${plan.epoch} already has a different root or total`);
    }
    console.log(`epoch ${plan.epoch} already posted with matching root and total`);
    return;
  }
  // THE FUNDING FLOOR IS THE NEW TOTAL PLUS EVERYTHING STILL OWED, not the new total alone. Every epoch pays
  // from this one balance and an unclaimed entry never expires, so posting against a balance that only covers
  // the new epoch means the first late claimant of an OLD epoch takes the new epoch's money -- and the
  // shortfall appears as a claim reverting weeks later rather than as a refusal here. The previous check
  // printed "Existing unpaid epochs may also need funding" and enforced nothing.
  const reader = {
    root: (e) => client.readContract({ address: distributor, abi: ROOT_ABI, functionName: "root", args: [e] }),
    totalOf: (e) => client.readContract({ address: distributor, abi: TOTAL_ABI, functionName: "totalOf", args: [e] }),
    claimedAmount: (e) => client.readContract({ address: distributor, abi: CLAIMED_ABI, functionName: "claimedAmount", args: [e] }),
  };
  const outstanding = await outstandingLiability(reader, plan.epoch, args.lookback);
  const required = requiredBalance(plan.total, outstanding);
  if (balance < required) {
    throw new Error(`${args.program} distributor holds ${balance} base units, below ${required} = new epoch total ${plan.total} + ${outstanding} still owed on posted epochs`);
  }
  console.log(JSON.stringify({ chainId, block: String(block.number), program: args.program, distributor, usdg,
    epoch: String(plan.epoch), makers: plan.makers, root: plan.root, totalBaseUnits: String(plan.total),
    outstandingBaseUnits: String(outstanding), requiredBaseUnits: String(required),
    distributorBalance: String(balance), lookbackEpochs: String(args.lookback) }, null, 2));
  if (!args.apply) { console.log("Read-only preflight passed. Add --apply --account <Foundry keystore name> to post."); return; }
  const temporary = await mkdtemp(join(tmpdir(), "maker-epoch-post-"));
  try {
    const regenerated = join(temporary, "epoch.json");
    execFileSync(process.execPath, [fileURLToPath(new URL("maker-epoch.mjs", import.meta.url)),
      String(plan.epoch), String(plan.total), "--output", regenerated], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const current = validateEpoch(JSON.parse(await readFile(regenerated, "utf8")));
    if (current.root.toLowerCase() !== plan.root.toLowerCase() || current.total !== plan.total) {
      throw new Error("epoch file differs from the current completed indexer score snapshot; regenerate and review it");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  execFileSync("cast", ["send", distributor, "setRoot(uint256,bytes32,uint256)", String(plan.epoch), plan.root,
    String(plan.total), "--account", args.account], { stdio: "inherit", env: { ...process.env, ETH_RPC_URL: args.rpc } });
  const confirmed = await client.readContract({ address: distributor, abi: ROOT_ABI, functionName: "root", args: [plan.epoch] });
  if (confirmed.toLowerCase() !== plan.root.toLowerCase()) throw new Error("send returned, but the root did not match on chain");
  console.log(`posted epoch ${plan.epoch}: ${plan.root}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error([[process.env.RH_RPC, "<RPC>"], [process.env.INDEXER_URL, "<INDEXER_URL>"]]
      .reduce((text, [secret, replacement]) => secret ? text.replaceAll(secret, replacement) : text, message));
    process.exitCode = 1;
  });
}
