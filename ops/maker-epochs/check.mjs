#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/maker-epochs/check.mjs — every committed <n>.json verifies; unposted is a distinct state.
 *
 *   node ops/maker-epochs/check.mjs
 *   node ops/maker-epochs/check.mjs --dir /tmp/epochs --offline
 *
 * Empty directory: ok. <n>.scores.json is ignored. posted:false skips the chain. posted:true
 * requires RH_RPC (or --rpc) and RewardsDistributor.root(epoch) === file.root.
 * ------------------------------------------------------------------------------------------------- */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_DIR = HERE;
export const DEFAULT_REGISTRY = path.join(ROOT, "ops", "markets", "tier1.json");

const EPOCH_FILE = /^(\d+)\.json$/;
const ALLOWED_KEYS = new Set(["epoch", "root", "total", "posted", "entries", "meta", "carry"]);
const ZERO_ROOT = /^0x0{64}$/i;

function loadViem() {
  const require = createRequire(path.join(ROOT, "keeper", "package.json"));
  return require("viem");
}

export function proofValid(viem, file, entry) {
  const inner = viem.keccak256(viem.encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
    [BigInt(file.epoch), BigInt(entry.index), entry.account, BigInt(entry.amount)],
  ));
  let node = viem.keccak256(inner);
  for (const sibling of entry.proof) {
    node = viem.keccak256(viem.concatHex(
      node.toLowerCase() < sibling.toLowerCase() ? [node, sibling] : [sibling, node],
    ));
  }
  return node.toLowerCase() === file.root.toLowerCase();
}

export function parseEpochFile(body, filename) {
  if (!body || typeof body !== "object") throw new Error(`${filename}: not a JSON object`);
  const extra = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length) throw new Error(`${filename}: unknown keys ${extra.join(",")}`);
  if (typeof body.posted !== "boolean") {
    throw new Error(`${filename}: posted must be true or false (unposted is a distinct explicit state, not a missing field)`);
  }
  if (!Number.isSafeInteger(body.epoch) || body.epoch < 0) throw new Error(`${filename}: bad epoch`);
  if (typeof body.root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.root)) {
    throw new Error(`${filename}: root is not bytes32`);
  }
  if (typeof body.total !== "string" || !/^\d+$/.test(body.total)) throw new Error(`${filename}: total is not a decimal string`);
  if (!Array.isArray(body.entries)) throw new Error(`${filename}: entries is not an array`);
  const seenAccounts = new Set();
  const seenIndices = new Set();
  let sum = 0n;
  const entries = body.entries.map((row, i) => {
    if (!row || typeof row !== "object") throw new Error(`${filename}: entry ${i} invalid`);
    if (!Number.isSafeInteger(row.index) || row.index < 0) throw new Error(`${filename}: entry ${i} bad index`);
    if (typeof row.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.account)) {
      throw new Error(`${filename}: entry ${i} bad account`);
    }
    if (typeof row.amount !== "string" || !/^\d+$/.test(row.amount)) throw new Error(`${filename}: entry ${i} bad amount`);
    if (!Array.isArray(row.proof) || row.proof.some((p) => typeof p !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p))) {
      throw new Error(`${filename}: entry ${i} bad proof`);
    }
    if (seenIndices.has(row.index) || seenAccounts.has(row.account.toLowerCase())) {
      throw new Error(`${filename}: duplicate index or account`);
    }
    seenIndices.add(row.index);
    seenAccounts.add(row.account.toLowerCase());
    sum += BigInt(row.amount);
    return row;
  });
  if (sum !== BigInt(body.total)) throw new Error(`${filename}: total does not equal the sum of amounts`);
  if (entries.some((e, i) => e.index !== i)) throw new Error(`${filename}: indices must be 0..n-1 in order`);
  const m = EPOCH_FILE.exec(filename);
  if (m && Number(m[1]) !== body.epoch) throw new Error(`${filename}: filename epoch ${m[1]} != body.epoch ${body.epoch}`);
  return {
    epoch: body.epoch,
    root: body.root,
    total: body.total,
    posted: body.posted,
    entries,
  };
}

export function listEpochFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => EPOCH_FILE.test(n)).sort((a, b) => Number(a) - Number(b));
}

export async function checkDir(dir, { rpc = process.env.RH_RPC || "", registryPath = DEFAULT_REGISTRY, offline = false, viem: viemIn } = {}) {
  const viem = viemIn ?? loadViem();
  const files = listEpochFiles(dir);
  const reports = [];
  if (files.length === 0) {
    return { ok: true, reports: [{ file: "(none)", state: "empty", detail: "no epoch files; ok" }] };
  }
  let distributor = null;
  const needChain = [];
  for (const name of files) {
    const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const file = parseEpochFile(raw, name);
    for (const entry of file.entries) {
      const account = viem.getAddress(entry.account);
      entry.account = account;
      if (!proofValid(viem, file, entry)) throw new Error(`${name}: proof for index ${entry.index} does not match root`);
    }
    if (file.posted === false) {
      reports.push({ file: name, state: "unposted", detail: `UNPOSTED local root ${file.root} verifies; on-chain not required` });
      continue;
    }
    needChain.push({ name, file });
  }
  if (needChain.length === 0) return { ok: true, reports };
  if (offline || !rpc) {
    throw new Error(`posted:true files require RH_RPC (or --rpc); ${needChain.map((x) => x.name).join(", ")} claimed posted. Unposted files must set posted: false.`);
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  distributor = registry?.v2?.contracts?.rewardsDistributor;
  if (typeof distributor !== "string" || !viem.isAddress(distributor)) {
    throw new Error(`registry ${registryPath} has no v2.contracts.rewardsDistributor address`);
  }
  const client = viem.createPublicClient({ transport: viem.http(rpc) });
  const abi = [{
    type: "function", name: "root", stateMutability: "view",
    inputs: [{ name: "epoch", type: "uint256" }], outputs: [{ type: "bytes32" }],
  }];
  for (const { name, file } of needChain) {
    const onchain = await client.readContract({
      address: viem.getAddress(distributor),
      abi,
      functionName: "root",
      args: [BigInt(file.epoch)],
    });
    if (ZERO_ROOT.test(onchain)) {
      throw new Error(`${name}: posted:true but on-chain root(epoch) is zero; set posted false or wait for RootSet`);
    }
    if (onchain.toLowerCase() !== file.root.toLowerCase()) {
      throw new Error(`${name}: posted root ${file.root} != on-chain ${onchain}`);
    }
    reports.push({ file: name, state: "posted", detail: `POSTED root matches ${distributor} root(${file.epoch})` });
  }
  return { ok: true, reports };
}

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, rpc: process.env.RH_RPC || "", offline: false, registry: DEFAULT_REGISTRY };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dir") out.dir = argv[++i];
    else if (a === "--rpc") out.rpc = argv[++i];
    else if (a === "--offline") out.offline = true;
    else if (a === "--registry") out.registry = argv[++i];
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: node ops/maker-epochs/check.mjs [--dir DIR] [--rpc URL] [--offline] [--registry FILE]\n");
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await checkDir(args.dir, { rpc: args.rpc, registryPath: args.registry, offline: args.offline });
  for (const r of result.reports) process.stdout.write(`${r.file}: ${r.detail}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("check.mjs")) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
