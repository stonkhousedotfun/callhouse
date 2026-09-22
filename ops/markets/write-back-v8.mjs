/**
 * ops/markets/write-back-v8.mjs — turn a v8 deployment record into a correct registry commit (O8-08A).
 *
 *   node ops/markets/write-back-v8.mjs --deployment <file>            # write ops/markets/tier1.json
 *   node ops/markets/write-back-v8.mjs --deployment <file> --check    # write nothing; report the diff
 *   node ops/markets/write-back-v8.mjs --deployment <file> --registry <path> --force
 *
 * WHY A TOOL AND NOT A HAND EDIT. Launch night writes ~30 addresses into four blocks plus a mirror
 * block whose every key must equal its twin exactly. Done by hand under time pressure the failure is
 * not a syntax error, it is one slot left null or one mirror out of step — and until O8-08A the
 * validator was GREEN on both. This writes every twin pair by construction and then runs the
 * completeness rule against its own output, refusing to write a registry it knows is incomplete.
 *
 * WHAT IT MAY TOUCH. Only the blocks the builder PRESERVES across a rebuild (ops/markets/tier1.json
 * `_readme`, build-markets.mjs): the top-level `v2` block and `shared`. A write-back into a
 * regenerated block would be discarded by the next `build-markets.mjs` run, silently, which is worse
 * than no tool. Market rows are never touched here -- including `markets[].v2.houseVault` (T-OP-156, the
 * per-ticker HouseVault of the two launch markets): that key is written per ticker by the broadcast's own
 * externals stage on the contracts side (callhouse-contracts DeployV2Batch.sh, the node snippet that also
 * writes `registeredAt` / `registerTx`), and this tool only PRESERVES it -- the offline validator it runs
 * before writing (`validateV2`) requires the key on every row and refuses a vault on a market outside
 * `launchSet.markets`, so a written-back registry that lost the key or put a vault on the wrong row is
 * refused here too, never written.
 *
 * IDEMPOTENT, AND IT REFUSES TO LIE. Re-running with the same record is a no-op. A slot that already
 * holds a DIFFERENT non-null address is a refusal, not an overwrite, unless --force says the operator
 * means it: on launch night the likely cause of a conflict is the wrong deployment file, and the
 * expensive outcome is a registry that names a contract nobody deployed.
 *
 * THE DEPLOYMENT RECORD, AS DeployV8.s.sol toJson ACTUALLY EMITS IT — read off the emitter
 * (callhouse-contracts script/v2/DeployV8.s.sol toJson:1973 and its four helpers) at
 * 5e431016c2b510caf7ad2f30c7c7e0dabbfcacd2, not imagined:
 *   { accessManager, clearinghouse, orderBook, settlementOracle, expiryCalendar, keeperRewards,
 *     autoRoller, payoutAdapter, makerVault, makerRegistry, rewardsDistributor,   // ELEVEN, TOP LEVEL
 *     sources: { chainlink, univ3, dataStreams },
 *     flywheel: { feeSplitter, buybackExecutor },
 *     deployBlock, safes: { admin, treasury }, wallets: { guardian }, bots: { … } }
 *
 * THIS DOCSTRING USED TO DESCRIBE A `contracts: { … }` WRAPPER THAT THE EMITTER HAS NEVER WRITTEN,
 * and the code below read that wrapper, so every address resolved to `undefined` and `put` dropped
 * it in silence. The registry was then written with the blocks this tool did understand and no
 * error about the fourteen it never saw. The two sides were each written from the same intent and
 * never from each other — the third instance of that family in this seam today, after T-442 and
 * T-444.
 * `shared.feeRecipient` is NOT read from the record: it IS the fee splitter (V8-DESIGN §6) and is
 * written from `flywheel.feeSplitter`, so the two cannot disagree. `bots` is optional because
 * ops/v2/derive-bot-keys.sh writes those after the deploy.
 *
 * Tests: node --test ops/markets/write-back-v8.test.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { V2_DEPLOYED_REQUIRED_PATHS, validateDeployedCompleteness, validateV2 } from "./build-markets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = path.join(HERE, "tier1.json");

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (v) => typeof v === "string" && ADDRESS_RE.test(v);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

const CONTRACTS = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor", "accessManager",
];
const SOURCES = ["chainlink", "univ3", "dataStreams"];
const BOTS = ["cranker", "pricer", "quoter", "guardian"];

/**
 * Every top-level key this tool knows how to record.
 *
 * MIRRORED, NOT INVENTED. `DeployV2Batch.sh` `mined_addresses` (:857-870) already walks this record
 * with the same rule — each top-level value is an address, or one of the two ADDRESS GROUPS, or it
 * is refused — and its `write_back` (:876-900) already writes the top-level shape correctly. That
 * bash pair is the third consumer of this record and it got the shape right; this file is the one
 * that did not. Keeping the two rules the same wording is the point: two implementations of one
 * job that disagree is how this defect happened.
 */
const KNOWN_RECORD_KEYS = new Set([
  ...CONTRACTS, "sources", "flywheel", "deployBlock", "safes", "wallets", "bots",
]);

/**
 * An unrecognised key is a REFUSAL, not a no-op.
 *
 * The same fail-closed principle T-444 established for a missing deployBlock, and the reason this
 * row exists: `put` skipping an undefined value silently is what let fourteen addresses disappear
 * without a word. A key this tool does not know is either a new contract nobody taught it about or
 * a record from a different producer, and both of those are things an operator must be told on
 * launch night rather than discover in the registry afterwards.
 */
function refuseUnknownKeys(record) {
  const unknown = Object.keys(record).filter((k) => !KNOWN_RECORD_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`the deployment record carries ${unknown.length === 1 ? "a key" : "keys"} this tool does not know where to record: `
      + `${unknown.join(", ")}. Refusing to guess. Add it to CONTRACTS or KNOWN_RECORD_KEYS, or correct the record.`);
  }
}

/** Every write this record implies, as [dotted path, address]. Nothing else may be written. */
export function plannedWrites(record) {
  refuseUnknownKeys(record);
  const writes = [];
  const put = (p, v) => { if (v !== undefined && v !== null) writes.push([p, v]); };
  put("v2.deployBlock", record.deployBlock);
  for (const k of CONTRACTS) put(`v2.contracts.${k}`, record[k]);
  for (const k of SOURCES) put(`v2.contracts.sources.${k}`, record.sources?.[k]);
  put("v2.flywheel.feeSplitter", record.flywheel?.feeSplitter);
  put("v2.flywheel.buybackExecutor", record.flywheel?.buybackExecutor);
  put("v2.flywheel.deployBlock", record.flywheel?.deployBlock);
  put("shared.safes.admin", record.safes?.admin);
  put("shared.safes.treasury", record.safes?.treasury);
  put("shared.admin", record.safes?.admin);            // shared.admin IS the Admin Safe (validateShared)
  put("shared.guardian", record.wallets?.guardian);
  put("shared.opsWallet", record.wallets?.opsWallet);
  put("shared.feeRecipient", record.flywheel?.feeSplitter); // the splitter IS the fee recipient, V8-DESIGN §6
  // The guardian hot key is one key with two homes and the validator enforces the equality
  // (`v2.bots.guardian` and `shared.guardian` "are one hot key and must be written the same, null
  // included"). Writing one without the other is exactly the half-write this tool exists to stop, and
  // it is how the first run of this test failed.
  put("v2.bots.guardian", record.bots?.guardian ?? record.wallets?.guardian);
  for (const k of BOTS) if (k !== "guardian") put(`v2.bots.${k}`, record.bots?.[k]);
  return writes;
}

/** The mirror block, built from the registry's own values so a twin cannot be written out of step. */
export function mirrorFrom(registry) {
  const g = (p) => p.split(".").reduce((n, k) => (isObject(n) ? n[k] : undefined), registry) ?? null;
  return {
    accessManager: g("v2.contracts.accessManager"),
    makerVault: g("v2.contracts.makerVault"),
    autoRoller: g("v2.contracts.autoRoller"),
    admin: g("shared.admin"),
    guardian: g("shared.guardian"),
    feeRecipient: g("shared.feeRecipient"),
    opsWallet: g("shared.opsWallet"),
    cranker: g("v2.bots.cranker"),
    pricer: g("v2.bots.pricer"),
    quoter: g("v2.bots.quoter"),
    feeSplitter: g("v2.flywheel.feeSplitter"),
    buybackExecutor: g("v2.flywheel.buybackExecutor"),
    treasury: g("shared.safes.treasury"),
    distributors: {
      maker: g("v2.contracts.rewardsDistributor"),
      // `user` and `lender` MIRROR THEMSELVES, and that is not a shortcut. A twin exists only where the
      // registry names the same address twice: `maker` has one (`v2.contracts.rewardsDistributor`), because
      // the maker distributor is the deploy's own `rewardsDistributor`. The user and lender programs are
      // SEPARATE RewardsDistributor instances with no slot under `v2.contracts` to mirror, so the block's own
      // value is the only source there is and reading it back is what keeps `applyRecord`'s wholesale
      // `registry.v2.protocolAddresses = mirror` from dropping them.
      user: g("v2.protocolAddresses.distributors.user"),
      // T-442. `lender` was missing here while `build-markets.mjs` V2_PROTOCOL_DISTRIBUTOR_KEYS required it
      // and `tier1.json` carried it, so every real run deleted the key and then refused its own output at
      // `validateV2`. The launch-night writer could not write. The omission was invisible because the test
      // that guards this property compared `registry.v2.protocolAddresses` with `mirrorFrom(registry)` one
      // line after `applyRecord` had assigned exactly that -- a comparison of a value with itself, which
      // would have stayed green if this function returned nothing at all. Both halves are fixed together;
      // adding the key alone would leave the next omission just as invisible.
      lender: g("v2.protocolAddresses.distributors.lender"),
    },
  };
}

function setPath(registry, dotted, value) {
  const parts = dotted.split(".");
  let node = registry;
  for (const k of parts.slice(0, -1)) {
    if (!isObject(node[k])) throw new Error(`${dotted}: ${k} is not an object in the registry`);
    node = node[k];
  }
  node[parts.at(-1)] = value;
}

const getPath = (registry, dotted) =>
  dotted.split(".").reduce((n, k) => (isObject(n) ? n[k] : undefined), registry);

/**
 * Apply a record to a registry object in place. Returns { changed, conflicts, issues }: `conflicts`
 * are non-null slots the record would change (refused unless force), `issues` are completeness
 * problems in the RESULT — the caller writes nothing when either is non-empty.
 */
export function applyRecord(registry, record, { force = false } = {}) {
  const changed = [];
  const conflicts = [];
  for (const [p, value] of plannedWrites(record)) {
    if (p !== "v2.deployBlock" && p !== "v2.flywheel.deployBlock" && !isAddress(value)) {
      conflicts.push(`${p}: ${JSON.stringify(value)} is not an address`);
      continue;
    }
    const current = getPath(registry, p);
    if (current === value) continue;
    if (current !== null && current !== undefined && !force) {
      conflicts.push(`${p} already holds ${JSON.stringify(current)} and the record says ${JSON.stringify(value)} (--force to overwrite)`);
      continue;
    }
    setPath(registry, p, value);
    changed.push(p);
  }
  if (conflicts.length === 0) {
    const mirror = mirrorFrom(registry);
    if (JSON.stringify(registry.v2.protocolAddresses) !== JSON.stringify(mirror)) {
      registry.v2.protocolAddresses = mirror;
      changed.push("v2.protocolAddresses (rebuilt from its twins)");
    }
  }
  const issues = [];
  validateDeployedCompleteness(registry, issues);
  return { changed, conflicts, issues };
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) { console.error(`${name} needs a value`); process.exit(2); }
    return v;
  };
  const force = argv.includes("--force");
  const check = argv.includes("--check");
  const deployment = arg("--deployment");
  if (deployment === null) {
    console.error("usage: node ops/markets/write-back-v8.mjs --deployment <file> [--registry <path>] [--check] [--force]");
    process.exit(2);
  }
  const registryPath = arg("--registry") ?? DEFAULT_REGISTRY;
  const record = JSON.parse(readFileSync(deployment, "utf8"));

  // T-444: refuse a record with no top-level `deployBlock`, BEFORE anything is applied.
  //
  // The guard that exists for a half-written registry is build-markets.mjs
  // validateDeployedCompleteness, and it opens with
  //   `const block = at(registry, "v2.deployBlock"); if (block === null || block === undefined) return;`
  // so it checks NOTHING when that field is absent. The `put` helper above drops undefined and null
  // silently, so a record without `deployBlock` never writes `v2.deployBlock` -- and then switches off
  // the very check that would have caught the result. Measured on this base: such a record writes 22
  // paths, exits 0, prints "wrote 22 path(s)", and leaves both `v2.deployBlock` and
  // `shared.safes.admin` null. Add the one field and the identical record refuses and names the null
  // slots. One field is the whole difference.
  //
  // The guard goes HERE, on the writer, for two reasons. The validator is shared and correct for what
  // it is asked -- "given a registry that claims a deployment, is it complete?" -- and a registry with
  // no deployBlock is legitimately incomplete-but-honest, so teaching the validator to refuse it would
  // break every pre-deploy caller. And this file is what produces the bad state: it is the only place
  // that can refuse before a null lands on disk. build-markets.mjs is deliberately NOT edited.
  //
  // Fail-closed, and it names the field and the file it actually read, because the two existing
  // messages blame innocent parties from either end -- the conflict message blames the deployment
  // file when the registry disagreed, the incompleteness message blames the registry when the record
  // was short. Neither is at fault here: the record simply lacks a field.
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    console.error(`refused: ${deployment} is not a deployment record object`);
    process.exit(1);
  }
  if (record.deployBlock === undefined || record.deployBlock === null) {
    console.error(`refused: the deployment record ${deployment} has no top-level "deployBlock".`);
    console.error(`  Without it this tool writes every other address and reports success, and build-markets.mjs`);
    console.error(`  validateDeployedCompleteness returns before checking anything, so nothing catches the`);
    console.error(`  half-written registry. Neither ${registryPath} nor the deployment is malformed -- the`);
    console.error(`  record is missing one field. Add "deployBlock": <the block the deploy landed in> and re-run.`);
    process.exit(1);
  }
  if (!Number.isInteger(record.deployBlock) || record.deployBlock <= 0) {
    console.error(`refused: the deployment record ${deployment} has "deployBlock": ${JSON.stringify(record.deployBlock)}, which is not a positive integer block number.`);
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const { changed, conflicts, issues } = applyRecord(registry, record, { force });

  for (const c of conflicts) console.error(`refused: ${c}`);
  for (const i of issues) console.error(`incomplete: ${i}`);
  if (conflicts.length > 0) {
    console.error(`\n${conflicts.length} conflict(s): nothing written. The likely cause on launch night is the wrong deployment file.`);
    process.exit(1);
  }
  if (issues.length > 0) {
    console.error(`\n${issues.length} slot(s) still null with v2.deployBlock set: nothing written. A half-written registry is the failure this tool exists to prevent (${V2_DEPLOYED_REQUIRED_PATHS.length} slots are required once a deployment exists).`);
    process.exit(1);
  }
  // The same recon file build-markets validates against; without it every pinned univ3Pool reports
  // "ops/markets/v2-sources.json is missing", which is a false alarm from the tool, not a registry fault.
  const reconPath = path.join(path.dirname(registryPath), "v2-sources.json");
  const recon = existsSync(reconPath) ? JSON.parse(readFileSync(reconPath, "utf8")) : null;
  const offline = validateV2(registry, recon, null);
  if (offline.length > 0) {
    for (const i of offline) console.error(`registry: ${i}`);
    console.error(`\n${offline.length} offline validator problem(s): nothing written.`);
    process.exit(1);
  }
  if (changed.length === 0) {
    console.log("write-back: registry already matches the deployment record; nothing to write");
    return;
  }
  for (const p of changed) console.log(`  ${p}`);
  if (check) {
    console.log(`\n--check: ${changed.length} path(s) would change; nothing written`);
    process.exit(1);
  }
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`\nwrote ${changed.length} path(s) to ${path.relative(process.cwd(), registryPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
