#!/usr/bin/env node
/**
 * Lender epoch generator: time-weighted Earn-vault supply -> a weekly epoch file and Merkle root.
 *
 * Usage:
 *   node indexer/scripts/lender-epoch.mjs <epoch-id> <budget-stonkhouse-base-units> \
 *     [--input balances.json] [--output epoch.json] [--registry ops/markets/tier1.json] [--cap-bps 2000]
 *
 * INPUT is a per-address balance-change series: {account, block, timestamp, sharesAfter, assetsAfter}, where
 * `assetsAfter` is the vault-asset value held AFTER that change. One row per change, any order; the generator
 * sorts. Given `--input` it reads a file and never touches the network, which is how the tests drive it.
 *
 * THE CREDIT IS TIME-WEIGHTED SUPPLY, NOT THE CLOSING BALANCE, and that is the whole point of the file.
 * A closing-balance rule pays a wallet that deposits an hour before the epoch ends the same as one that
 * supplied all week, which is a free option on the reward and the first thing anyone would farm. So the credit
 * is the integral of assets over the epoch window -- assets x seconds held -- computed from the balance the
 * wallet carried INTO the window plus every change inside it. A wallet with no row before the window simply
 * starts at zero.
 *
 * AMOUNTS ARE 18-DECIMAL $STONKHOUSE BASE UNITS. USDG is 6-decimal and the maker program pays it; nothing on
 * this path may carry a 6-decimal assumption. 100 whole tokens is 1e20, which does not fit in a uint64, so
 * every amount here is a BigInt and every amount in the output file is a decimal STRING.
 *
 * THE MERKLE FORMAT IS NOT DEFINED HERE. It comes from `./lib/epoch-merkle.mjs`, the single copy shared with
 * `maker-epoch.mjs`, so the two programs cannot drift into producing different roots for the same input.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { epochWindow, merkle } from "./lib/epoch-merkle.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = resolve(SCRIPT_DIR, "../../ops/markets/tier1.json");
/** Per-wallet share ceiling, basis points of the epoch budget. 20 % by default. */
const DEFAULT_CAP_BPS = 2000n;
const BPS = 10_000n;

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
  let registry = DEFAULT_REGISTRY;
  let capBps = DEFAULT_CAP_BPS;
  const exclude = [];
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === "--input" || option === "--output" || option === "--registry" || option === "--cap-bps" || option === "--exclude") {
      i++;
      if (!argv[i]) throw new Error(`${option} requires a value`);
      if (option === "--input") input = resolve(argv[i]);
      else if (option === "--output") output = resolve(argv[i]);
      else if (option === "--registry") registry = resolve(argv[i]);
      // Repeatable: the House vaults are per-market, so there is no single value that could name them.
      else if (option === "--exclude") exclude.push(argv[i]);
      else capBps = uint(argv[i], "--cap-bps", true);
    } else if (option.startsWith("--")) throw new Error(`unknown option ${option}`);
    else positional.push(option);
  }
  if (positional.length !== 2) {
    throw new Error("usage: lender:epoch <epoch-id> <budget-stonkhouse-base-units> [--input balances.json] [--output epoch.json] [--registry tier1.json] [--cap-bps 2000] [--exclude 0x... ...]");
  }
  const epoch = uint(positional[0], "epoch", true);
  const budget = uint(positional[1], "budget");
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("epoch exceeds JSON safe integer range");
  if (capBps === 0n || capBps > BPS) throw new Error("--cap-bps must be 1..10000");
  const { start, end } = epochWindow(epoch);
  return { epoch, budget, input, registry, capBps, exclude, start, end,
    output: output ?? resolve(SCRIPT_DIR, "../../ops/lender-epochs", `${epoch}.json`) };
}

/**
 * Protocol-owned addresses, READ FROM THE REGISTRY rather than hardcoded, so a new protocol wallet is excluded
 * by adding it to the registry and not by editing this file. Matched case-insensitively: the registry is
 * checksummed and an indexer row may not be.
 *
 * THE GUARD USED TO TEST THE BLOCK'S PRESENCE, NOT ITS CONTENTS, AND THAT IS WHY IT PASSED ON AN EMPTY LIST.
 * Every value in `v2.protocolAddresses` is null until a deployment fills it, so on the committed registry this
 * function walked the tree, found no 0x string, and returned an EMPTY SET - while the error above, whose whole
 * purpose is to refuse "with no exclusion list", did not fire. Every protocol-owned address would then have
 * been paid lender rewards out of the budget, and nothing anywhere would have said so: the run succeeds, the
 * file is written, the Merkle root is valid, and the money is simply wrong. A check that cannot see its
 * subject is the dominant defect class in this codebase and this was an instance of it.
 *
 * `extra` carries addresses the registry CANNOT hold. See the note on the closed schema at the call site:
 * the House vaults are factory-created and per-market, so no fixed key could name them.
 */
export function exclusions(registry, extra = []) {
  const p = registry?.v2?.protocolAddresses;
  if (p === undefined || p === null || typeof p !== "object") {
    throw new Error("registry has no v2.protocolAddresses block: refusing to run with no exclusion list");
  }
  const out = new Set();
  const walk = (node) => {
    for (const value of Object.values(node)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "object") { walk(value); continue; }
      if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) out.add(value.toLowerCase());
    }
  };
  walk(p);
  for (const address of extra) {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`--exclude ${address}: not an address`);
    }
    out.add(address.toLowerCase());
  }
  // FAIL CLOSED ON CONTENTS. An empty set means either a registry whose addresses are still null (no
  // deployment yet) or one this program cannot read - and in both cases the correct action is to refuse,
  // because the alternative is to pay the protocol its own rewards and report success.
  if (out.size === 0) {
    throw new Error(
      "exclusion list is EMPTY: v2.protocolAddresses exists but holds no addresses, so nothing would be " +
        "excluded and protocol-owned balances would be paid. Fill the registry block (it is null until " +
        "v2.deployBlock is set) or pass --exclude for each protocol-owned address.",
    );
  }
  return out;
}

/**
 * Time-weighted supply per account over [start, end): the integral of `assetsAfter` over seconds held.
 * Rows at or before `start` establish the balance carried INTO the window; rows inside it move it; rows at or
 * after `end` are ignored. Returns BigInt weights in asset-units x seconds.
 */
export function weigh(rows, start, end, excluded) {
  if (!Array.isArray(rows)) throw new Error("balance input must be an array");
  if (end <= start) throw new Error("epoch window is empty");
  const byAccount = new Map();
  /**
   * D28 VALUES STOCK AT THE SETTLEMENT ORACLE SPOT AND CREDITS USD VALUE. THIS PROGRAM READS NO PRICE, so it
   * can only weigh one asset against itself: `assetsAfter` is in that asset's own base units and a share of
   * one vault's units is not comparable to a share of another's. Summing them would produce a split that is
   * silently wrong per asset - the kind of wrong that looks like a working distribution. So a mixed input is
   * REFUSED here rather than weighted, and stock Earn vaults stay out of scope until a price source exists.
   * A single-asset run is correct today because the ratio of any two weights within one asset is price-free.
   */
  let asset = null;
  for (const row of rows) {
    if (row.asset !== undefined && row.asset !== null) {
      const seen = String(row.asset).toLowerCase();
      if (asset === null) asset = seen;
      else if (asset !== seen) {
        throw new Error(
          `input mixes assets (${asset} and ${seen}): this program weighs base units and reads no price, so it ` +
            "cannot value one asset against another. Run one epoch per asset, or supply a priced input.",
        );
      }
    }
    const account = getAddress(row.account);
    if (excluded.has(account.toLowerCase())) continue;
    const timestamp = uint(String(row.timestamp), "timestamp", true);
    const assets = uint(String(row.assetsAfter), "assetsAfter", true);
    const block = uint(String(row.block ?? "0"), "block", true);
    if (timestamp >= end) continue;
    if (!byAccount.has(account)) byAccount.set(account, []);
    byAccount.get(account).push({ timestamp, assets, block });
  }
  const weights = [];
  for (const [account, events] of byAccount) {
    // Stable ordering: time first, then block, so two changes in one second cannot swap.
    events.sort((a, b) => (a.timestamp === b.timestamp
      ? (a.block === b.block ? 0 : a.block < b.block ? -1 : 1)
      : a.timestamp < b.timestamp ? -1 : 1));
    let held = 0n;              // the balance carried into the window
    let cursor = start;
    let weight = 0n;
    for (const event of events) {
      if (event.timestamp <= start) { held = event.assets; continue; }
      weight += held * (event.timestamp - cursor);
      held = event.assets;
      cursor = event.timestamp;
    }
    weight += held * (end - cursor);
    if (weight > 0n) weights.push({ account, weight });
  }
  // Deterministic order: weight descending, then address, so the file is reproducible run to run.
  weights.sort((a, b) => (a.weight === b.weight
    ? a.account.toLowerCase().localeCompare(b.account.toLowerCase())
    : a.weight > b.weight ? -1 : 1));
  return weights;
}

/**
 * Pro-rata by weight, with a per-wallet ceiling and rescaling, so THE ENTRY SUM EQUALS `budget` EXACTLY.
 * Capped wallets are pinned at the ceiling and their excess is redistributed among the rest, repeatedly,
 * because redistribution can push another wallet over. Any dust left by integer division goes to the largest
 * remainders, which is the maker generator's rule (`maker-epoch.mjs:92-100`) and keeps the sum exact.
 */
export function allocate(weights, budget, capBps) {
  if (weights.length === 0) throw new Error("epoch has no lenders with positive time-weighted supply");
  const cap = (budget * capBps) / BPS;
  if (cap === 0n) throw new Error("--cap-bps rounds the per-wallet cap to zero for this budget");
  if (cap * BigInt(weights.length) < budget) {
    throw new Error(`per-wallet cap ${cap} across ${weights.length} lenders cannot distribute ${budget}: raise --cap-bps`);
  }
  const pinned = new Map();
  for (;;) {
    const open = weights.filter((row) => !pinned.has(row.account));
    const remaining = budget - [...pinned.values()].reduce((sum, amount) => sum + amount, 0n);
    const openWeight = open.reduce((sum, row) => sum + row.weight, 0n);
    if (open.length === 0 || openWeight === 0n) break;
    let capped = false;
    for (const row of open) {
      if ((remaining * row.weight) / openWeight > cap) { pinned.set(row.account, cap); capped = true; }
    }
    if (!capped) {
      const draft = open.map((row) => ({ account: row.account,
        amount: (remaining * row.weight) / openWeight,
        remainder: (remaining * row.weight) % openWeight }));
      let left = remaining - draft.reduce((sum, row) => sum + row.amount, 0n);
      for (const row of [...draft].sort((a, b) => (a.remainder === b.remainder
        ? a.account.toLowerCase().localeCompare(b.account.toLowerCase())
        : a.remainder > b.remainder ? -1 : 1))) {
        if (left === 0n) break;
        row.amount++;
        left--;
      }
      for (const row of draft) pinned.set(row.account, row.amount);
      break;
    }
  }
  const allocated = weights
    .map((row) => ({ account: row.account, amount: pinned.get(row.account) ?? 0n }))
    .filter((row) => row.amount > 0n)
    .map((row, index) => ({ ...row, index }));
  const sum = allocated.reduce((total, row) => total + row.amount, 0n);
  if (sum !== budget) throw new Error(`allocation sums to ${sum}, not the budget ${budget}`);
  return allocated;
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

/** The whole pipeline, exported so the tests drive it without touching the filesystem. */
export function buildEpoch({ epoch, budget, rows, registry, capBps, exclude = [], start, end }) {
  const allocated = allocate(weigh(rows, start, end, exclusions(registry, exclude)), budget, capBps);
  const { root, proofs } = merkle(epoch, allocated);
  return { epoch: Number(epoch), root, total: String(budget), entries: allocated.map((entry) => ({
    index: entry.index, account: entry.account, amount: String(entry.amount), proof: proofs.get(entry.index),
  })) };
}

async function main() {
  const { epoch, budget, input, output, registry, capBps, exclude, start, end } = args(process.argv.slice(2));
  /**
   * THE INPUT SOURCE, NAMED (D28). The sibling `maker-epoch.mjs` reads `INDEXER_URL` and needs no file. This
   * program cannot yet, and the reason is specific rather than an omission: it needs per-account Earn-vault
   * BALANCE HISTORY over the epoch window - a row per change with `assetsAfter` and a timestamp - and no
   * route serves that. `src/api/v2/earn.ts` reads the deposit, withdrawal, queue, skim and adapter-move
   * tables, which are the events, not a balance series, and it answers per address rather than per window.
   * So the automatable form of this program is blocked on ONE missing route, not on a design question, and
   * `--input` is the honest interim rather than a permanent interface.
   */
  if (!input) {
    throw new Error(
      "--input is required: no route serves per-account Earn-vault balance history over an epoch window. " +
        "src/api/v2/earn.ts returns events per address, not a balance series per window; until such a route " +
        "exists this program cannot be automated the way maker-epoch.mjs is.",
    );
  }
  const rows = JSON.parse(await readFile(input, "utf8"));
  const registryJson = JSON.parse(await readFile(registry, "utf8"));
  await publish(output, buildEpoch({ epoch, budget, rows, registry: registryJson, capBps, exclude, start, end }));
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
