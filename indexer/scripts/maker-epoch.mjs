#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, getAddress, keccak256, concatHex } from "viem";

const WEEK_SECONDS = 604_800n;
const FIRST_MONDAY_SECONDS = 345_600n;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_API = process.env.INDEXER_URL ?? "http://localhost:42069";
const leafTypes = [
  { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" },
];

function uint(value, label, allowZero = false) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} must be a decimal integer`);
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function args(argv) {
  const positional = [];
  let input;
  let output;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" || argv[i] === "--output") {
      const option = argv[i++];
      if (!argv[i]) throw new Error(`${option} requires a path`);
      if (option === "--input") input = resolve(argv[i]);
      else output = resolve(argv[i]);
    } else if (argv[i].startsWith("--")) throw new Error(`unknown option ${argv[i]}`);
    else positional.push(argv[i]);
  }
  if (positional.length !== 2) throw new Error("usage: maker:epoch <epoch-id> <budget-usdg-base-units> [--input makers.json] [--output epoch.json]");
  const epoch = uint(positional[0], "epoch", true);
  const budget = uint(positional[1], "budget");
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("epoch exceeds JSON safe integer range");
  const weekStart = FIRST_MONDAY_SECONDS + epoch * WEEK_SECONDS;
  if ((weekStart - FIRST_MONDAY_SECONDS) / WEEK_SECONDS !== epoch) throw new Error("invalid epoch");
  return { epoch, budget, input, output: output ?? resolve(SCRIPT_DIR, "../../ops/maker-epochs", `${epoch}.json`) };
}

async function fetchMakers(epoch) {
  const makers = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const url = new URL("/v2/makers", DEFAULT_API);
    url.searchParams.set("epoch", String(epoch));
    url.searchParams.set("limit", "200");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`maker API ${response.status} ${url}`);
    const page = await response.json();
    if (page.epoch?.id !== Number(epoch)) throw new Error(`maker API returned wrong epoch for ${url}`);
    if (!Array.isArray(page.items)) throw new Error("maker API response must contain items array");
    makers.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || seenCursors.has(cursor)) throw new Error("maker API cursor repeated or invalid");
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  return makers;
}

function scorePpm(row) {
  if (row.scorePpm !== undefined) {
    const exact = uint(String(row.scorePpm), "scorePpm", true);
    if (exact > 1_000_000n) throw new Error("scorePpm exceeds one million");
    return exact;
  }
  if (typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 100) {
    throw new Error("maker score must be a percentage from 0 to 100");
  }
  return BigInt(Math.round(row.score * 10_000));
}

function allocate(rows, budget) {
  const seen = new Set();
  const ranked = rows.map((row) => {
    const account = getAddress(row.maker);
    const key = account.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate maker ${account}`);
    seen.add(key);
    return { account, score: scorePpm(row) };
  }).filter((row) => row.score > 0n).sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : a.account.toLowerCase().localeCompare(b.account.toLowerCase()));
  const totalScore = ranked.reduce((sum, row) => sum + row.score, 0n);
  if (totalScore === 0n) throw new Error("epoch has no makers with positive scores");
  const allocations = ranked.map((row, index) => ({ ...row, index,
    amount: (budget * row.score) / totalScore,
    remainder: (budget * row.score) % totalScore }));
  let left = budget - allocations.reduce((sum, row) => sum + row.amount, 0n);
  const residualOrder = [...allocations].sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.index - b.index);
  for (const row of residualOrder) {
    if (left === 0n) break;
    row.amount++;
    left--;
  }
  return allocations.filter((row) => row.amount > 0n).map((row, index) => ({ ...row, index }));
}

function leaf(epoch, entry) {
  const inner = keccak256(encodeAbiParameters(leafTypes, [epoch, BigInt(entry.index), entry.account, entry.amount]));
  return keccak256(inner);
}

function pair(left, right) {
  return keccak256(concatHex(left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left]));
}

/** Matches OpenZeppelin StandardMerkleTree: hash-sort leaves, then reverse-fill the complete tree. */
function merkle(epoch, entries) {
  const sorted = entries.map((entry) => ({ entry, hash: leaf(epoch, entry) }))
    .sort((a, b) => a.hash.toLowerCase().localeCompare(b.hash.toLowerCase()));
  const n = sorted.length;
  if (n === 0) throw new Error("no allocated entries");
  const tree = Array(2 * n - 1);
  for (let i = 0; i < n; i++) tree[tree.length - 1 - i] = sorted[i].hash;
  for (let i = n - 2; i >= 0; i--) tree[i] = pair(tree[2 * i + 1], tree[2 * i + 2]);
  const proofs = new Map();
  for (let i = 0; i < n; i++) {
    const proof = [];
    let position = tree.length - 1 - i;
    while (position > 0) {
      proof.push(tree[position % 2 === 0 ? position - 1 : position + 1]);
      position = Math.floor((position - 1) / 2);
    }
    proofs.set(sorted[i].entry.index, proof);
  }
  return { root: tree[0], proofs };
}

async function publish(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== body) throw new Error(`refusing to overwrite different epoch file ${path}`);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, body, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const { epoch, budget, input, output } = args(process.argv.slice(2));
  const rows = input ? JSON.parse(await readFile(input, "utf8")) : await fetchMakers(epoch);
  if (!Array.isArray(rows)) throw new Error("maker input must be an array");
  const allocated = allocate(rows, budget);
  const { root, proofs } = merkle(epoch, allocated);
  const result = { epoch: Number(epoch), root, total: String(budget), entries: allocated.map((entry) => ({
    index: entry.index, account: entry.account, amount: String(entry.amount), proof: proofs.get(entry.index),
  })) };
  await publish(output, result);
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
