/**
 * The registry schema, INTERFACE_VERSION 8 (O8-01), and `v2.protocolAddresses` (O3-204).
 *
 * WHY THIS FILE EXISTS. Two different failures, both silent:
 *
 *  1. A CLOSED KEY SET that is not actually closed. Every consumer of this registry reads fixed
 *     names, so a misspelt key is not a wrong value — it is no value, and the reader takes its
 *     default. `buybackExecuter` disables the buyback; `payout_route` pays every winner in kind;
 *     `allowRent` under `v2` instead of `v2.fees` turns the rent guard off. None of those look
 *     different afterwards. So an unknown key is REFUSED, and every block is checked here.
 *  2. An EXCLUSION LIST that drifts. `v2.protocolAddresses` is what scoring flags `protocol` and what
 *     `maker-epoch.mjs` never allocates to a maker. It is wrong the day somebody deploys a contract,
 *     derives a bot key or moves a Safe and updates the block that holds it without updating this
 *     one. Every key with a twin is checked against it, `null` included.
 *
 * v8 also inverts two fee rules (premium fee above resale is now REQUIRED; a non-zero writer rent is
 * now REFUSED) and decouples `dev.json` from production. An inversion is exactly the kind of edit
 * that lands half-done — one of the two directions changed, both registries still passing — so both
 * directions are asserted here, in both the shared fees and the per-market ones.
 *
 * Offline: the validators take a registry object. Nothing reads the chain, the feed directory or
 * `cast` (the EIP-55 and pool-id checks are `checksum*` / `poolIdIssues`, which `--check` runs).
 *
 *   node --test ops/markets/build-markets.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  PAYOUT_ROUTE_KEYS,
  V2_PROTOCOL_DEPLOYED_NEVER_NULL,
  V2_PROTOCOL_DISTRIBUTOR_KEYS,
  V2_PROTOCOL_KEYS,
  V2_PROTOCOL_NEVER_NULL,
  V2_PROTOCOL_TWINS,
  V2_EXTERNAL_CONTRACT_NAMES,
  V2_EXTERNAL_DEPLOY_BLOCK_KEYS,
  V2_SKELETON,
  encodePoolKey,
  routeCurrencies,
  V2_DEPLOYED_REQUIRED_PATHS,
  V2_PAYOUT_ROUTE_DELIBERATELY_NULL,
  poolIdIssues,
  validateDeployedCompleteness,
  validateDevIsolation,
  validatePayoutRoute,
  SINGLE_SOURCE_AT_2026_09_21,
  validateLaunchSet,
  validateV2,
  validateV2Protocol,
  WAVES,
  REGENERATED_ROOT_KEYS,
  RETIRED_ROOT_KEYS,
  assembleRegistry,
  rootKeyIssues,
  MARKET_FIELDS,
  assembleMarket,
  marketKeyIssues,
  checksumMarketHouseVaults,
  V2_MARKET_KEYS,
} from "./build-markets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(path.join(HERE, file), "utf8"));
const REGISTRIES = ["tier1.json", "dev.json"];
const RECON = read("v2-sources.json");
/** Not in any registry, not checksummed (the offline validators judge shape, not checksum). */
const OTHER = "0x0000000000000000000000000000000000000abc";
const addr = (n) => `0x${String(n).padStart(40, "0")}`;

const clone = (file = "tier1.json") => read(file);

/**
 * A registry that describes a DEPLOYED v8 set: every slot filled with a distinct synthetic address,
 * every twin kept equal. The committed registries are all-null before the v8 broadcast, so the
 * drift and duplicate rules have nothing to bite on there; this is what they are tested against.
 */
function deployed() {
  const r = clone();
  const a = {};
  let n = 1;
  const next = () => addr((n += 1));
  for (const k of ["clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
    "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor", "accessManager"]) {
    r.v2.contracts[k] = a[k] = next();
  }
  for (const k of ["chainlink", "univ3", "dataStreams"]) r.v2.contracts.sources[k] = next();
  r.v2.deployBlock = 70000000;
  r.v2.flywheel = { feeSplitter: next(), buybackExecutor: next(), deployBlock: 69999999 };
  r.shared.admin = next();
  r.shared.guardian = next();
  r.shared.feeRecipient = r.v2.flywheel.feeSplitter; // the splitter IS the fee recipient (V8-DESIGN §6)
  r.shared.opsWallet = next();
  r.shared.safes = { admin: r.shared.admin, treasury: next() };
  r.v2.bots = { cranker: next(), pricer: next(), quoter: next(), guardian: r.shared.guardian };
  r.v2.protocolAddresses = {
    accessManager: r.v2.contracts.accessManager,
    makerVault: r.v2.contracts.makerVault,
    autoRoller: r.v2.contracts.autoRoller,
    admin: r.shared.admin,
    guardian: r.shared.guardian,
    feeRecipient: r.shared.feeRecipient,
    opsWallet: r.shared.opsWallet,
    cranker: r.v2.bots.cranker,
    pricer: r.v2.bots.pricer,
    quoter: r.v2.bots.quoter,
    feeSplitter: r.v2.flywheel.feeSplitter,
    buybackExecutor: r.v2.flywheel.buybackExecutor,
    treasury: r.shared.safes.treasury,
    distributors: { maker: r.v2.contracts.rewardsDistributor, user: null, lender: null },
  };
  return r;
}

/** The issues `mutate` produces, judged by the protocol block's own validator alone. */
function issuesFor(mutate, registry = deployed()) {
  mutate(registry.v2.protocolAddresses, registry);
  const issues = [];
  validateV2Protocol(registry, issues);
  return issues;
}

/** The issues `mutate` produces, judged by the whole offline validator. */
function allIssuesFor(mutate, file = "tier1.json") {
  const registry = clone(file);
  mutate(registry);
  return validateV2(registry, RECON, null);
}

const mentioning = (issues, key) => issues.filter((i) => i.includes(`v2.protocolAddresses.${key}`));

/* ------------------------------------------------------------------ the committed registries */

// T-516 checked the O3-204 suspicion against this test and it does not apply. The doubt was that a
// committed registry might already carry an unrelated v2 problem, so this assertion would go red for
// a reason nothing to do with the change that added `v2.protocolAddresses` — and its author could not
// run it to find out. Run at 1afd4ab7d3b37e1f8588fe6d400de8663c7de7ce: 54 pass, 0 fail, this test
// among them. The control matters more than the pass: injecting one extra key into
// `tier1.json.v2.protocolAddresses` reds THIS test (6 fail), so it can fail and the green is
// load-bearing. Nothing was fixed, because nothing was broken.
//
// T-517 re-checked the SAME suspicion independently and concurred, with a DIFFERENT control: setting
// NVDA's `v2.wave` to `NOT_A_WAVE` reds this test with 8 failures naming `ops/markets/tier1.json has
// v2 problems` and the subject `NVDA: v2.wave`. Run at 7cc9051a8f76bfee4dd3a799b9f4c1cb276c1dfe:
// 54 pass, 0 fail; restored, still 54. Two unrelated injections, two different failure counts, one
// conclusion — which is worth more than either control alone.
//
// Both rows exist because one ledger suspicion was mined twice under different subjects: T-516 onto
// this test, which is what the doubt is actually about, and T-517 onto `ops/markets/tier1.json`,
// which the suspicion names only as the DATA this assertion reads. If you are about to open a third,
// the answer is already here.
/**
 * T-566. `ops/markets/tier1.json` is GENERATED: `build-markets.mjs` writes `waves: WAVES`
 * UNCONDITIONALLY (:1791), unlike the `v2` block one line below which IS preserved from the existing
 * file (`v2: existing && "v2" in existing ? existing.v2 : V2_SKELETON`, :1793). So a hand-edit to the
 * committed `waves` block does not survive the next builder run -- it is a change that expires with
 * no warning, and under build mode no gate runs the builder to catch it.
 *
 * T-LP-06 made exactly that edit and it landed and was pushed. This is the guard that would have
 * caught it. It fails on ANY divergence in either direction, so it equally catches editing `WAVES`
 * without regenerating the registry.
 */
test("the committed registry's waves block equals the WAVES constant that generates it", () => {
  assert.deepEqual(
    read("tier1.json").waves,
    WAVES,
    "ops/markets/tier1.json waves disagrees with WAVES in build-markets.mjs. The registry is " +
      "GENERATED, so the next builder run overwrites the file from the constant: fix WAVES and " +
      "regenerate, never hand-edit the registry.",
  );
});

test("every committed registry passes the whole offline v2 validator", () => {
  const production = read("tier1.json");
  for (const file of REGISTRIES) {
    assert.deepEqual(validateV2(read(file), RECON, production), [], `ops/markets/${file} has v2 problems`);
  }
});

test("a synthetic DEPLOYED v8 registry passes too: the rules are satisfiable, not just vacuous", () => {
  assert.deepEqual(validateV2(deployed(), RECON, null), []);
});

/* ------------------------------------------------------------------ T-OP-114: the six external keys */

/*
 * The six `v2.contracts` keys the deploy wrapper's EXTERNAL_KEYS reads (callhouse-contracts
 * script/v2/lib/registry-env.sh:413) and T-OP-116's externals step writes back — houseVault, houseVaultFactory,
 * hedger, rewardsDistributorLender, earnVault, stockVenueAdapter — were unknown to `exactKeys`, so the registry
 * the broadcast itself produces failed `--check` (T-OP-081 finding, operator M-3fb6774607fd4e0a). They are now
 * ACCEPTED when present (null or an address) and never required (coordinator ruling M-ad3328c276524acb): the
 * committed registries and the skeleton do NOT carry them until the consumers row widens render-docs.mjs and
 * gen-markets.mjs, which still throw on the keys. `v2.externalDeployBlocks` (T-302's start-block slots, one per
 * external) is the opposite — REQUIRED, in the skeleton and both registries, all null — because a new top-level
 * block breaks no consumer (M-b3f5ca18efa5443f), and it is coupled: an external address with a null block is
 * refused. These cases pin both halves of that asymmetry, the 14-count, the required-when-deployed exemption,
 * the coupling and the dev-isolation reach.
 */
const EXTERNAL = ["houseVault", "houseVaultFactory", "hedger", "rewardsDistributorLender", "earnVault", "stockVenueAdapter"];
/** `deployed()` plus the written-back externals: every external an address, every start block set. */
function deployedWithExternals() {
  const r = deployed();
  let n = 500;
  for (const k of EXTERNAL) r.v2.contracts[k] = addr((n += 1));
  r.v2.externalDeployBlocks = Object.fromEntries(EXTERNAL.map((k, i) => [k, 70000100 + i]));
  return r;
}

test("T-OP-114: the external set is exactly the wrapper's six, the start-block keys mirror it, and none is required at deployBlock", () => {
  assert.deepEqual([...V2_EXTERNAL_CONTRACT_NAMES].sort(), [...EXTERNAL].sort());
  assert.deepEqual([...V2_EXTERNAL_DEPLOY_BLOCK_KEYS], [...V2_EXTERNAL_CONTRACT_NAMES]);
  // Not a recorded key: V2_CONTRACT_NAMES stays the eleven every 14-count mirror closes over.
  for (const k of EXTERNAL) assert.equal(V2_DEPLOYED_REQUIRED_PATHS.includes(`v2.contracts.${k}`), false, `${k} is required at deployBlock`);
});

test("T-OP-169: both shipped registries carry the six ADDRESS keys as null, after accessManager and before sources; the skeleton still does not", () => {
  // T-OP-114 shipped the registries WITHOUT the six because render-docs.mjs and gen-markets.mjs closed the
  // key set; T-OP-138 widened both generators, and the contracts preflight that landed with T-OP-137
  // (check-deploy-inputs.sh) then REFUSED the real tier1.json with five `missing-writeback-key
  // .v2.contracts.<external>` lines, because a write-back must never ADD a key. So this row inverts
  // T-OP-114's assertion deliberately: the six pre-exist as null in both files, in V2_EXTERNAL_CONTRACT_NAMES
  // order, placed where callhouse-contracts' fixture twin (script/v2/fixtures/registry-v8.json, T-OP-109) places
  // them. The skeleton is untouched: `assembleRegistry` carries `v2` verbatim (the rebuild test below), and a first
  // build from nothing is still the builder's concern, not this row's.
  for (const k of EXTERNAL) assert.equal(k in V2_SKELETON.contracts, false, `V2_SKELETON.contracts carries ${k}`);
  for (const file of REGISTRIES) {
    const keys = Object.keys(read(file).v2.contracts);
    for (const k of EXTERNAL) assert.equal(read(file).v2.contracts[k], null, `${file}: v2.contracts.${k} must be present and null`);
    const core = Object.keys(V2_SKELETON.contracts).filter((k) => k !== "sources"); // the eleven, in skeleton order
    assert.deepEqual(keys, [...core, ...EXTERNAL, "sources"], `${file}: v2.contracts key order`);
  }
});

test("T-OP-114: externalDeployBlocks IS in the skeleton and both shipped registries, all null, one slot per external", () => {
  const want = Object.fromEntries(EXTERNAL.map((k) => [k, null]));
  assert.deepEqual(V2_SKELETON.externalDeployBlocks, want);
  for (const file of REGISTRIES) assert.deepEqual(read(file).v2.externalDeployBlocks, want, file);
  // Dropping it is refused like any other block: the top level is exact, no optional keys.
  const gone = allIssuesFor((r) => { delete r.v2.externalDeployBlocks; });
  assert.ok(gone.some((i) => i.includes("v2.externalDeployBlocks is missing")), gone.join(" | "));
});

test("T-OP-114: the written-back shape passes — the six as addresses on a deployed registry, with their start blocks", () => {
  assert.deepEqual(validateV2(deployedWithExternals(), RECON, null), []);
});

test("T-OP-114: present as null they pass, absent they pass, and a deployed registry with them still null is green", () => {
  // Null on the pre-broadcast file.
  const r = clone();
  for (const k of EXTERNAL) r.v2.contracts[k] = null;
  assert.deepEqual(validateV2(r, RECON, null), []);
  // Null with v2.deployBlock SET: the externals step runs after DeployV8, so this is a correct registry in the
  // middle of the launch sequence, and item 19 may leave two of them null for good.
  const d = deployed();
  for (const k of EXTERNAL) d.v2.contracts[k] = null;
  assert.deepEqual(validateV2(d, RECON, null), []);
  const issues = [];
  validateDeployedCompleteness(d, issues);
  assert.deepEqual(issues, []);
  // A subset present is fine too: the step writes one key per contract it deployed, with its block beside it.
  const some = clone();
  some.v2.contracts.earnVault = null;
  some.v2.contracts.houseVaultFactory = OTHER;
  some.v2.externalDeployBlocks.houseVaultFactory = 70000200;
  assert.deepEqual(validateV2(some, RECON, null), []);
});

test("T-OP-114: an external slot holding a non-address is refused by name", () => {
  for (const k of EXTERNAL) {
    const issues = allIssuesFor((r) => { r.v2.contracts[k] = "0xnot-an-address"; });
    assert.ok(issues.some((i) => i.includes(`v2.contracts.${k} must be null or an address`)), `${k}: ${issues.join(" | ")}`);
  }
});

test("T-OP-114: a key that is neither recorded nor external is still refused — the block stays closed", () => {
  // stockZap is the tempting one: DeployEarnVault.s.sol:111 creates it and WIRE-06 wants a home for it. Not here,
  // not by this row: an unknown name is refused exactly as before, with the six accepted beside it.
  const issues = allIssuesFor((r) => {
    for (const k of EXTERNAL) r.v2.contracts[k] = null;
    r.v2.contracts.stockZap = null;
  });
  assert.ok(issues.some((i) => /v2\.contracts\.stockZap/.test(i) && /not a known key/.test(i)), issues.join(" | "));
  assert.equal(issues.filter((i) => /not a known key/.test(i)).length, 1, `only stockZap should be unknown: ${issues.join(" | ")}`);
  // And a misspelt external is unknown, not silently accepted as the real one.
  const typo = allIssuesFor((r) => { r.v2.contracts.earnvault = OTHER; });
  assert.ok(typo.some((i) => /v2\.contracts\.earnvault/.test(i) && /not a known key/.test(i)), typo.join(" | "));
});

test("T-OP-114: externalDeployBlocks is exact over the six and each value is null or a block number", () => {
  const all = (fill) => Object.fromEntries(EXTERNAL.map((k) => [k, fill(k)]));
  assert.deepEqual(allIssuesFor((r) => { r.v2.externalDeployBlocks = all(() => null); }), []);
  // A block without its address is allowed (a step may record where it started before it records what).
  assert.deepEqual(allIssuesFor((r) => { r.v2.externalDeployBlocks = all((k) => (k === "earnVault" ? 70000100 : null)); }), []);
  // A decimal string is a block number here exactly as it is for v2.deployBlock.
  assert.deepEqual(allIssuesFor((r) => { r.v2.externalDeployBlocks = all(() => "70000100"); }), []);
  const bad = allIssuesFor((r) => { r.v2.externalDeployBlocks = { ...all(() => null), earnVault: -1, houseVaultFactory: "soon", hedger: 0 }; });
  for (const k of ["earnVault", "houseVaultFactory", "hedger"]) {
    assert.ok(bad.some((i) => i.includes(`v2.externalDeployBlocks.${k} must be null or a positive block number`)), `${k}: ${bad.join(" | ")}`);
  }
  const missing = allIssuesFor((r) => { r.v2.externalDeployBlocks = { earnVault: null }; });
  for (const k of EXTERNAL.filter((k) => k !== "earnVault")) {
    assert.ok(missing.some((i) => i.includes(`v2.externalDeployBlocks.${k} is missing`)), `${k}: ${missing.join(" | ")}`);
  }
  const extra = allIssuesFor((r) => { r.v2.externalDeployBlocks = { ...all(() => null), stockZap: null }; });
  assert.ok(extra.some((i) => /v2\.externalDeployBlocks\.stockZap/.test(i) && /not a known key/.test(i)), extra.join(" | "));
  const notObj = allIssuesFor((r) => { r.v2.externalDeployBlocks = 5; });
  assert.ok(notObj.some((i) => i.includes("v2.externalDeployBlocks must be an object")), notObj.join(" | "));
  // The top level is still closed: a misspelt block is unknown, not ignored.
  const typo = allIssuesFor((r) => { r.v2.externalDeployBlock = {}; });
  assert.ok(typo.some((i) => /v2\.externalDeployBlock\b/.test(i) && /not a known key/.test(i)), typo.join(" | "));
});

test("T-OP-114: an external ADDRESS with its start block still null is refused by name — the two are written back together", () => {
  // The flywheel precedent: `v2.flywheel.feeSplitter` set with `deployBlock` null is refused. A written-back
  // registry that records the EarnVault and not where it started is half-written, and the indexer would refuse
  // the same pair at boot (indexer/lib/env.ts:241-270); the registry says so first.
  for (const k of EXTERNAL) {
    const r = deployedWithExternals();
    r.v2.externalDeployBlocks[k] = null;
    const issues = validateV2(r, RECON, null);
    assert.ok(issues.some((i) => i.includes(`v2.contracts.${k} is set but v2.externalDeployBlocks.${k} is null`)), `${k}: ${issues.join(" | ") || "(no issues)"}`);
    assert.equal(issues.length, 1, `${k}: exactly one issue expected: ${issues.join(" | ")}`);
  }
  // Negative controls: a null address with a null block is fine (the pre-deploy state), and so is the pair set.
  const both = deployedWithExternals();
  both.v2.contracts.hedger = null;
  both.v2.externalDeployBlocks.hedger = null;
  assert.deepEqual(validateV2(both, RECON, null), []);
  assert.deepEqual(validateV2(deployedWithExternals(), RECON, null), []);
});

test("T-OP-114: a production external copied into a _dev registry is refused, and a different address is not", () => {
  // The claim/name loops in validateDevIsolation walk V2_CONTRACT_NAMES; before this row a written-back
  // production EarnVault copied into dev.json passed, because no loop looked at the key.
  const prod = deployedWithExternals();
  for (const k of EXTERNAL) {
    const dev = read("dev.json");
    dev.v2.contracts[k] = prod.v2.contracts[k];
    const issues = [];
    validateDevIsolation(dev, prod, issues);
    assert.ok(
      issues.some((i) => i.includes(`v2.contracts.${k}`) && i.includes("may not name a production")),
      `dev.json may name production's v2.contracts.${k}: ${issues.join("; ") || "(no issues)"}`,
    );
  }
  // Negative control: a dev-only address in the same slot is accepted, so the rule is not simply refusing the slot.
  const dev = read("dev.json");
  dev.v2.contracts.earnVault = OTHER;
  const ok = [];
  validateDevIsolation(dev, prod, ok);
  assert.deepEqual(ok, []);
});

test("T-OP-114: a rebuild of a shipped registry still carries v2 verbatim and loses no root key (T-607 guard unchanged)", () => {
  // `assembleRegistry` carries `v2` from the file, so a wider validator cannot add keys to a shipped registry,
  // and the root-key guard has nothing new to lose: the externals, when they arrive, arrive by write-back.
  for (const file of REGISTRIES) {
    const r = read(file);
    const written = rebuild(r, 1);
    assert.deepEqual(rootKeyIssues(r, written), [], file);
    assert.deepEqual(written.v2, r.v2, `${file}: a rebuild must carry v2 verbatim, not merge the skeleton into it`);
  }
  // And a registry that already carries the externals keeps them through a rebuild.
  const r = deployedWithExternals();
  assert.deepEqual(rebuild(r, 1).v2, r.v2);
});

test("both registries are at interface version 8", () => {
  for (const file of REGISTRIES) assert.equal(read(file).v2.interfaceVersion, 8, file);
  assert.equal(V2_SKELETON.interfaceVersion, 8);
});

/* ------------------------------------------------------------------ closed key sets */

test("the closed sets are exactly what v8 says they are", () => {
  const v2 = read("tier1.json").v2;
  assert.deepEqual(Object.keys(v2).sort(), Object.keys(V2_SKELETON).sort());
  // 03-INTERFACES §4: accessManager joins, payoutAdapter stays and now names the PayoutRouter.
  // 11 named slots plus 3 sources = the 14 addresses the deploy tooling counts.
  assert.ok("accessManager" in v2.contracts, "v2.contracts has no accessManager");
  assert.equal("payoutAdapter" in v2.contracts, true, "payoutAdapter was renamed; every consumer reads that key");
  const addresses = Object.entries(v2.contracts).flatMap(([k, v]) => (k === "sources" ? Object.keys(v) : [k]));
  // T-OP-114 / T-OP-169: the six external keys are accepted by the validator but are NOT in the recorded count
  // the deploy tooling asserts (`V2_CONTRACT_NAMES` + sources = 14); since T-OP-169 they sit beside it in the
  // shipped registries, null until the externals step writes them back. 14 recorded + 6 externals = 20 entries.
  const recorded = addresses.filter((k) => !V2_EXTERNAL_CONTRACT_NAMES.includes(k));
  assert.equal(recorded.length, 14, `v2.contracts holds ${recorded.length} recorded addresses, not 14`);
  assert.equal(addresses.length, 20, `v2.contracts holds ${addresses.length} entries, not 14 recorded + 6 externals`);
  for (const k of V2_EXTERNAL_CONTRACT_NAMES) assert.equal(v2.contracts[k], null, `v2.contracts.${k} is not null in the shipped tier1.json`);
  // v8 bot keys: renamed and extended, and never v7's.
  assert.deepEqual(Object.keys(v2.bots).sort(), ["cranker", "guardian", "pricer", "quoter"]);
  assert.deepEqual(Object.keys(v2.flywheel).sort(), ["buybackExecutor", "deployBlock", "feeSplitter"]);
  // T-OP-114: the externals' start blocks, one per external, all null before the externals step.
  assert.deepEqual(Object.keys(v2.externalDeployBlocks).sort(), [...V2_EXTERNAL_CONTRACT_NAMES].sort());
  assert.ok("allowRent" in v2.fees, "v2.fees has no allowRent: the rent guard has no opt-in to refuse against");
});

test("the shared block carries the v8 members and its keys are closed", () => {
  for (const file of REGISTRIES) {
    const s = read(file).shared;
    assert.deepEqual(Object.keys(s).sort(), ["admin", "chainId", "clearinghouse", "feeRecipient", "guardian", "multicall3", "opsWallet", "safes", "seaport", "token", "usdg"], file);
    assert.deepEqual(Object.keys(s.safes).sort(), ["admin", "treasury"], file);
    assert.deepEqual(Object.keys(s.token).sort(), ["address", "decimals", "poolId", "poolKey", "symbol"], file);
    assert.deepEqual(Object.keys(s.token.poolKey).sort(), ["currency0", "currency1", "fee", "hooks", "tickSpacing"], file);
  }
});

test("an unknown key is refused wherever it is put: a misspelt one would be ignored by every reader", () => {
  const cases = [
    ["v2", (r) => { r.v2.flyWheel = {}; }, "v2.flyWheel"],
    ["v2.contracts", (r) => { r.v2.contracts.accessmanager = OTHER; }, "v2.contracts.accessmanager"],
    ["v2.contracts.sources", (r) => { r.v2.contracts.sources.uniV4 = OTHER; }, "v2.contracts.sources.uniV4"],
    ["v2.bots", (r) => { r.v2.bots.mmQuoter = OTHER; }, "v2.bots.mmQuoter"],
    ["v2.flywheel", (r) => { r.v2.flywheel.buybackExecuter = OTHER; }, "v2.flywheel.buybackExecuter"],
    ["v2.externalDeployBlocks", (r) => { r.v2.externalDeployBlocks.stockZap = null; }, "v2.externalDeployBlocks.stockZap"],
    ["v2.fees", (r) => { r.v2.fees.allowrent = true; }, "v2.fees.allowrent"],
    ["v2.vault", (r) => { r.v2.vault.maxDailyOutFlow = "1"; }, "v2.vault.maxDailyOutFlow"],
    ["v2.defaults", (r) => { r.v2.defaults.uncorroboratedDelay = 3600; }, "v2.defaults.uncorroboratedDelay"],
    ["shared", (r) => { r.shared.treasury = OTHER; }, "shared.treasury"],
    ["shared.safes", (r) => { r.shared.safes.ops = OTHER; }, "shared.safes.ops"],
    ["shared.token", (r) => { r.shared.token.poolid = null; }, "shared.token.poolid"],
    ["shared.token.poolKey", (r) => { r.shared.token.poolKey.hook = null; }, "shared.token.poolKey.hook"],
    ["markets[].v2", (r) => { r.markets[0].v2.payoutRoutes = null; }, "v2.payoutRoutes"],
  ];
  for (const [where, mutate, expected] of cases) {
    const issues = allIssuesFor(mutate);
    assert.ok(
      issues.some((i) => i.includes(expected) && i.includes("not a known key")),
      `an unknown key under ${where} is accepted: ${issues.join("; ") || "(no issues at all)"}`,
    );
  }
});

test("a missing key is refused too, one issue per key", () => {
  for (const key of ["interfaceVersion", "flywheel", "fees", "bots", "contracts", "externalDeployBlocks"]) {
    const issues = allIssuesFor((r) => { delete r.v2[key]; });
    assert.ok(issues.some((i) => i.includes(`v2.${key} is missing`) || i.includes(`v2.${key} must be`)), `dropping v2.${key} is accepted`);
  }
  for (const key of ["safes", "token", "opsWallet"]) {
    const issues = allIssuesFor((r) => { delete r.shared[key]; });
    assert.ok(issues.some((i) => i.includes(`shared.${key}`)), `dropping shared.${key} is accepted`);
  }
});

/* ------------------------------------------------------------------ T-OP-018: no v2.uniswapV4 */

// The v4 PoolManager and StateView are verified and written down in v2-sources.json `contracts.*`,
// which is what DeployV2Batch.sh reads. Nothing reads a `v2.uniswapV4` path (V2_SKELETON's note
// lists what was searched), the contracts docs that name one are stale, and adding it here would be
// a second copy of an address the recon holds AND a key dev.json would then be required to carry.
// These pin the decision so the block is neither added by hand nor grown back by a rebuild.
test("T-OP-018: neither registry nor the skeleton carries v2.uniswapV4; the v4 pair lives in the recon", () => {
  for (const file of REGISTRIES) {
    assert.ok(!("uniswapV4" in read(file).v2), `${file} grew a v2.uniswapV4 block: DeployV2Batch.sh reads v2-sources.json, a copy here can only drift`);
  }
  assert.ok(!("uniswapV4" in V2_SKELETON), "the skeleton defines uniswapV4: dev.json is now required to carry it too");
  // The home the wrapper reads: both entries present, well-formed, distinct, and seen with code.
  const pm = RECON.contracts.v4PoolManager;
  const sv = RECON.contracts.v4StateView;
  for (const [k, e] of [["v4PoolManager", pm], ["v4StateView", sv]]) {
    assert.ok(e && /^0x[0-9a-fA-F]{40}$/.test(e.address) && e.codeExists === true, `v2-sources.json contracts.${k} is not an address seen with code: ${JSON.stringify(e)}`);
  }
  assert.notEqual(pm.address.toLowerCase(), sv.address.toLowerCase(), "the PoolManager and its StateView are one address");
  for (const [k, a] of Object.entries(read("tier1.json").v2.uniswapV3)) {
    assert.notEqual(a.toLowerCase(), pm.address.toLowerCase(), `v2.uniswapV3.${k} is the v4 PoolManager`);
    assert.notEqual(a.toLowerCase(), sv.address.toLowerCase(), `v2.uniswapV3.${k} is the v4 StateView`);
  }
});

test("T-OP-018: a registry that grows v2.uniswapV4 is refused, and the refusal names the real home", () => {
  const home = "v2-sources.json contracts.v4PoolManager";
  const shapes = [
    ["null, the shape jq reports for an absent key", null],
    ["the pair copied from the recon", { poolManager: RECON.contracts.v4PoolManager.address, stateView: RECON.contracts.v4StateView.address }],
    ["an empty object", {}],
  ];
  for (const [what, value] of shapes) {
    const issues = allIssuesFor((r) => { r.v2.uniswapV4 = value; });
    assert.ok(issues.some((i) => i.includes("v2.uniswapV4") && i.includes("not a known key")), `${what}: accepted: ${issues.join("; ") || "(no issues at all)"}`);
    assert.ok(issues.some((i) => i.includes("v2.uniswapV4 is not a registry key") && i.includes(home)), `${what}: refused without naming ${home}: ${issues.join("; ")}`);
  }
  // exactKeys is symmetric, so the same block is refused on dev.json for the same reason.
  const dev = allIssuesFor((r) => { r.v2.uniswapV4 = null; }, "dev.json");
  assert.ok(dev.some((i) => i.includes("v2.uniswapV4 is not a registry key") && i.includes(home)), dev.join("; "));
  // And the pointer is only ever about that key: a registry without it gets no such message.
  assert.ok(!allIssuesFor(() => {}).some((i) => i.includes("v2.uniswapV4")), "the pointer fires on a registry that has no uniswapV4 key");
});

/* ------------------------------------------------------------------ the inverted fee rules */

test("v8 REQUIRES the premium fee above the resale fee — the exact inverse of the v7 rule", () => {
  // v7 refused premiumFeeBps > resaleFeeBps. If that check had been left as it was, the committed
  // v8 registry (500 / 0) would be refused; if it had simply been deleted, a registry that charges
  // the writer nothing would pass. Both directions, so neither half of the inversion can be missing.
  assert.deepEqual(allIssuesFor(() => {}), [], "the committed 500 / 0 must pass");
  for (const [premium, resale] of [[0, 0], [0, 500], [500, 500], [100, 1000]]) {
    const issues = allIssuesFor((r) => {
      r.v2.fees.premiumFeeBps = premium;
      r.v2.fees.resaleFeeBps = resale;
    });
    assert.ok(
      issues.some((i) => i.includes("v2.fees.premiumFeeBps") && i.includes("is not above")),
      `premium ${premium} / resale ${resale} is accepted: ${issues.join("; ") || "(no issues)"}`,
    );
  }
});

test("v8 REFUSES a writer rent anywhere unless v2.fees.allowRent says so — the inverse of v7", () => {
  // v7 refused 0 ppm, shared and per market. v8's launch value IS 0, so the same two checks now have
  // to refuse everything else. The flag is the only way a non-zero rate gets in, and it is one key,
  // so a diff that switches rent back on cannot look like a number somebody adjusted.
  const shared = allIssuesFor((r) => { r.v2.fees.mintFeePpm = 80; });
  assert.ok(shared.some((i) => i.includes("v2.fees.mintFeePpm") && i.includes("0 rent")), shared.join("; "));

  const perMarket = allIssuesFor((r) => { r.markets[0].v2.mintFeePpm = 80; });
  assert.ok(perMarket.some((i) => i.includes("v2.mintFeePpm") && i.includes("0 rent")), perMarket.join("; "));

  // With the opt-in, the very same values are accepted — and the compiled ceiling still binds.
  assert.deepEqual(allIssuesFor((r) => {
    r.v2.fees.allowRent = true;
    r.v2.fees.mintFeePpm = 80;
    for (const m of r.markets) m.v2.mintFeePpm = 80;
  }), [], "allowRent: true does not actually allow rent");

  const overCeiling = allIssuesFor((r) => {
    r.v2.fees.allowRent = true;
    r.v2.fees.mintFeePpm = 5001;
    r.markets[0].v2.mintFeePpm = 5001;
  });
  assert.equal(overCeiling.filter((i) => i.includes("MINT_FEE_CEIL_PPM")).length, 2, overCeiling.join("; "));

  // And the flag itself is typed: a truthy string is not an owner decision.
  const bad = allIssuesFor((r) => { r.v2.fees.allowRent = "true"; });
  assert.ok(bad.some((i) => i.includes("v2.fees.allowRent must be true or false")), bad.join("; "));
});

test("every committed market is at rent 0", () => {
  for (const file of REGISTRIES) {
    const r = read(file);
    assert.equal(r.v2.fees.mintFeePpm, 0, file);
    assert.equal(r.v2.fees.allowRent, false, file);
    assert.equal(r.v2.fees.premiumFeeBps, 500, file);
    assert.equal(r.v2.fees.resaleFeeBps, 0, file);
    for (const m of r.markets) assert.equal(m.v2.mintFeePpm, 0, `${file} ${m.ticker}`);
  }
});

/* ------------------------------------------ the post-broadcast completeness rule (O8-08A) */

test("the required-when-deployed set covers every block a deployment fills, and deliberately not the bots", () => {
  // Asserted by membership, not by restating the list: a key added to V2_CONTRACT_NAMES or
  // V2_SOURCE_NAMES must appear here too, and this is what says so.
  const paths = new Set(V2_DEPLOYED_REQUIRED_PATHS);
  for (const k of ["clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
    "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor", "accessManager"]) {
    assert.ok(paths.has(`v2.contracts.${k}`), `v2.contracts.${k} is not required when deployed`);
  }
  for (const k of ["chainlink", "univ3"]) {
    assert.ok(paths.has(`v2.contracts.sources.${k}`), `v2.contracts.sources.${k} is not required when deployed`);
  }
  // dataStreams is EXEMPT and that is the decision: ops/go-live-v2.sh:333 and its header at :29-30 both
  // say DataStreamsSource ships disabled and a null there is fine, so requiring it would turn
  // build-markets --check red on a correct launch night. Operator decision, after the conflict was raised.
  assert.ok(!paths.has("v2.contracts.sources.dataStreams"), "dataStreams must stay exempt while the source ships disabled");
  for (const k of ["v2.flywheel.feeSplitter", "v2.flywheel.buybackExecutor", "shared.safes.treasury"]) {
    assert.ok(paths.has(k), `${k} is not required when deployed`);
  }
  // The bot keys are derived after the deploy (ops/v2/derive-bot-keys.sh), so requiring them here
  // would fire during a correct launch. Their absence is the decision, not an oversight.
  for (const k of ["cranker", "pricer", "quoter", "guardian"]) {
    assert.ok(!paths.has(`v2.bots.${k}`), `v2.bots.${k} must NOT be required when deployed`);
  }
  assert.ok(!paths.has("v2.flywheel.deployBlock"), "a block number is not an address slot");
});

test("post-broadcast, a launch market with no route must be a DELIBERATE null, not a forgotten one", () => {
  // O8-03 left six launch markets routeless on purpose; before it, null meant "not written yet". To a
  // completeness check those look identical, so the six are named and everything else is a defect.
  const r = deployed();
  assert.deepEqual([...V2_PAYOUT_ROUTE_DELIBERATELY_NULL].sort(), ["AMD", "AMZN", "CRWV", "MU", "ORCL", "SNDK"]);

  const clean = [];
  validateDeployedCompleteness(r, clean);
  assert.deepEqual(clean, [], "the shipped routes and the six recorded nulls are complete");

  // A routed launch market silently losing its route is the forgotten case.
  const dropped = deployed();
  const victim = dropped.markets.find((m) => m.v2.wave === "wave1" && m.v2.payoutRoute !== null);
  victim.v2.payoutRoute = null;
  const issues = [];
  validateDeployedCompleteness(dropped, issues);
  assert.ok(issues.some((i) => i.startsWith(`${victim.ticker}: v2.payoutRoute is null but v2.deployBlock`)), issues.join("; "));

  // And the reverse: a route appearing on a market the document says is routeless.
  const surprise = deployed();
  surprise.markets.find((m) => m.ticker === "MU").v2.payoutRoute = { venue: "v3", fee: 3000 };
  const back = [];
  validateDeployedCompleteness(surprise, back);
  assert.ok(back.some((i) => i.includes("is listed as deliberately routeless")), back.join("; "));
});

test("no deployBlock means no requirement: the committed all-null registry stays green", () => {
  const issues = [];
  validateDeployedCompleteness(read("tier1.json"), issues);
  assert.deepEqual(issues, [], "the pre-deploy registry must not trip the post-broadcast rule");
});

test("deployBlock set and every required slot filled is green; nulling ONE of them is red and names it", () => {
  const full = [];
  validateDeployedCompleteness(deployed(), full);
  assert.deepEqual(full, [], "a complete post-broadcast registry passes");

  // The case the old rule missed entirely: deployBlock set, all four mirror keys written, orderBook null.
  const half = deployed();
  half.v2.contracts.orderBook = null;
  half.v2.protocolAddresses.distributors.user = null;
  const issues = [];
  validateDeployedCompleteness(half, issues);
  assert.equal(issues.length, 1, issues.join("; "));
  assert.match(issues[0], /^v2\.contracts\.orderBook is null but v2\.deployBlock is 70000000/);

  // And the old rule alone still says nothing about it, which is why this task exists.
  const mirrorOnly = [];
  validateV2Protocol(half, mirrorOnly);
  assert.deepEqual(mirrorOnly, [], "the mirror rule is green on a registry missing the OrderBook");

  half.v2.contracts.orderBook = deployed().v2.contracts.orderBook;
  const restored = [];
  validateDeployedCompleteness(half, restored);
  assert.deepEqual(restored, [], "restoring the slot restores green");
});

test("every required slot is individually load-bearing: nulling any one of them is caught", () => {
  for (const path of V2_DEPLOYED_REQUIRED_PATHS) {
    const r = deployed();
    const parts = path.split(".");
    let node = r;
    for (const key of parts.slice(0, -1)) node = node[key];
    node[parts.at(-1)] = null;
    const issues = [];
    validateDeployedCompleteness(r, issues);
    assert.ok(issues.some((i) => i.startsWith(`${path} is null`)), `${path} can be null unnoticed`);
  }
});

/* ------------------------------------------------------------------ payoutRoute */

// O8-03 pinned the launch routes, so "null everywhere" is no longer the state to assert. What must
// still hold is the thing that test was really protecting: every market carries the KEY, so a market
// cannot silently lose the field, and only the launch tickers carry a route.
const O803_ROUTED = ["AAPL", "DELL", "GOOGL", "INTC", "META", "MSFT", "MSTR", "NVDA", "PLTR", "QQQ", "SPCX", "SPY", "TSLA", "TSM"];

test("payoutRoute: every committed market has the key, and it is null or a closed v3/v4 object", () => {
  for (const file of REGISTRIES) {
    for (const m of read(file).markets) {
      assert.ok("payoutRoute" in m.v2, `${file} ${m.ticker} is missing the payoutRoute key`);
      const r = m.v2.payoutRoute;
      if (r === null) continue;
      assert.ok(PAYOUT_ROUTE_KEYS[r.venue], `${file} ${m.ticker} venue ${JSON.stringify(r.venue)}`);
      assert.deepEqual(Object.keys(r).sort(), [...PAYOUT_ROUTE_KEYS[r.venue]].sort(), `${file} ${m.ticker} key set`);
    }
  }
});

test("payoutRoute: exactly the O8-03 launch tickers carry a route in tier1.json", () => {
  // The other six launch tickers (MU SNDK AMD AMZN ORCL CRWV) are deliberately null - no eligible pool
  // cleared the depth, activity and deviation gates. ops/markets/PAYOUT-ROUTES-V8.md records why, per ticker.
  const routed = read("tier1.json").markets.filter((m) => m.v2.payoutRoute !== null).map((m) => m.ticker).sort();
  assert.deepEqual(routed, [...O803_ROUTED].sort());
  for (const m of read("dev.json").markets) assert.equal(m.v2.payoutRoute, null, `dev.json ${m.ticker} carries a route`);
});

test("payoutRoute: every pinned v4 id hashes from the key beside it (poolIdIssues, cast only, no RPC)", async () => {
  // A v4 pool has no address: keccak256(abi.encode(PoolKey)) IS the pin. An id copied from a recon run
  // that does not hash from its own key names a DIFFERENT pool and the swap would simply execute there.
  // poolIdIssues needs `cast keccak`, which is local - no network, so this runs under the no-RPC rule.
  assert.deepEqual(await poolIdIssues(read("tier1.json")), []);
});

test("payoutRoute is separate from univ3Pool: the settlement source is not the payout venue", () => {
  // 06-QUIRKS §H. v4 has no observation array, so a v4 route may never become a TWAP source. One key
  // for both would have re-pointed settlement at a v4 pool the moment a route was added.
  const r = clone();
  const m = r.markets.find((x) => x.ticker === "NVDA");
  assert.ok(m.univ3Pool === undefined && "univ3Pool" in m.v2 && "payoutRoute" in m.v2);
  m.v2.payoutRoute = { venue: "v4", fee: 500, tickSpacing: 10, poolId: `0x${"ab".repeat(32)}` };
  const issues = [];
  validatePayoutRoute(m, r, RECON, issues);
  assert.deepEqual(issues, [], "a v4 route beside a v3 settlement pool is legitimate");
});

test("payoutRoute shapes: closed per venue, bounded, and a v4 route must carry its pool id", () => {
  const r = clone();
  const m = r.markets.find((x) => x.ticker === "NVDA");
  const check = (route) => {
    m.v2.payoutRoute = route;
    const issues = [];
    validatePayoutRoute(m, r, RECON, issues);
    return issues;
  };
  assert.deepEqual(check(null), [], "null (pay in kind) is not a finding");
  assert.deepEqual(check({ venue: "v3", fee: 500 }), []);
  assert.deepEqual(check({ venue: "v4", fee: 500, tickSpacing: 10, poolId: `0x${"ab".repeat(32)}` }), []);
  assert.ok(check({ venue: "v5", fee: 500 })[0].includes("venue"), "an unknown venue is accepted");
  assert.ok(check({ venue: "v4", fee: 500, tickSpacing: 10 }).some((i) => i.includes("poolId is missing")));
  assert.ok(check({ venue: "v3", fee: 500, tickSpacing: 10 }).some((i) => i.includes("not a known key")), "a v3 route may carry v4 fields");
  for (const fee of [0, 10001, "500", null, 1.5]) {
    assert.ok(check({ venue: "v3", fee }).some((i) => i.includes("payoutRoute.fee")), `fee ${JSON.stringify(fee)} is accepted`);
  }
  for (const ts of [0, 32768, "10", null]) {
    assert.ok(check({ venue: "v4", fee: 500, tickSpacing: ts, poolId: `0x${"ab".repeat(32)}` }).some((i) => i.includes("tickSpacing")), `tickSpacing ${JSON.stringify(ts)} is accepted`);
  }
  assert.ok(check({ venue: "v4", fee: 500, tickSpacing: 10, poolId: "0xdeadbeef" }).some((i) => i.includes("poolId")));
  assert.equal(Object.keys(PAYOUT_ROUTE_KEYS).sort().join(","), "v3,v4");
});

test("a v4 pool key encodes exactly as abi.encode(PoolKey) does, sorted", () => {
  // The five static words `PoolId.toId()` hashes. `--check` hashes this with `cast keccak` and
  // compares it with the committed id; if the encoding were wrong, every id would recompute wrong
  // and the comparison would fail loudly rather than pin the wrong pool.
  const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const nvda = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
  const { currency0, currency1 } = routeCurrencies(nvda, usdg);
  assert.equal(currency0, usdg.toLowerCase(), "USDG sorts below NVDA on 4663");
  assert.equal(currency1, nvda.toLowerCase());
  const hex = encodePoolKey({ currency0, currency1, fee: 500, tickSpacing: 10, hooks: `0x${"0".repeat(40)}` });
  assert.equal(hex.length, 2 + 64 * 5);
  assert.equal(
    hex,
    "0x0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168" +
      "000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec" +
      "00000000000000000000000000000000000000000000000000000000000001f4" +
      "000000000000000000000000000000000000000000000000000000000000000a" +
      "0000000000000000000000000000000000000000000000000000000000000000",
  );
});

test("the token pool must name a launch HOOK and be a pinned key-with-id", () => {
  // OWNER RULING 2026-09-21 (T-OP-012). This test asserted the INVERSE until that ruling: it required
  // shared.token.poolKey to be hookless, quoting V8-DESIGN 6A. 6A is the PAYOUT ROUTE section; the
  // buyback venue is permanently the Pons launch pool and its key must name that pool's hook, which
  // V4BuybackExecutor requires to have code. The route rule is unchanged and is asserted below.

  // AC4(c): the pinned launch-hook key PASSES -- no hooks issue is raised for a real hook.
  const pinned = allIssuesFor((r) => {
    r.shared.token.poolKey = { currency0: addr(1), currency1: addr(2), fee: 3000, tickSpacing: 60, hooks: OTHER };
    r.shared.token.poolId = `0x${"cd".repeat(32)}`;
  });
  assert.ok(!pinned.some((i) => i.includes("poolKey.hooks")), pinned.join("; "));

  // AC4(a): hooks == address(0) now FAILS, naming the rule. This is the case the old validator
  // ACCEPTED and the deployed executor would revert NoSource on.
  const hookless = allIssuesFor((r) => {
    r.shared.token.poolKey = { currency0: addr(1), currency1: addr(2), fee: 3000, tickSpacing: 60, hooks: addr(0) };
    r.shared.token.poolId = `0x${"cd".repeat(32)}`;
  });
  assert.ok(hookless.some((i) => i.includes("poolKey.hooks is the zero address")), hookless.join("; "));

  // The committed key is filled in since T-OP-108, so the half-pinned case has to be built: an id whose
  // key was nulled out. (Setting only poolId on the shipped registry no longer produces a half.)
  const half = allIssuesFor((r) => {
    r.shared.token.poolKey = { currency0: null, currency1: null, fee: null, tickSpacing: null, hooks: null };
    r.shared.token.poolId = `0x${"cd".repeat(32)}`;
  });
  assert.ok(half.some((i) => i.includes("filled in together")), half.join("; "));
});

test("AC4(b): a payout route may not name a hook at all, so the route rule is scoped and not deleted", () => {
  // The zero-hooks rule of V8-DESIGN 6A still governs routes, by a stronger mechanism than a value
  // check: `hooks` is not among PAYOUT_ROUTE_KEYS, so `exactKeys` refuses a route that carries one.
  // A route therefore cannot name a hooked pool even by accident, which is what AC1 means by
  // retaining the rule rather than loosening it.
  const hookedRoute = allIssuesFor((r) => {
    const m = r.markets[0];
    m.v2.payoutRoute = { venue: "v4", fee: 3000, tickSpacing: 60, poolId: `0x${"ab".repeat(32)}`, hooks: OTHER };
  });
  assert.ok(
    hookedRoute.some((i) => i.includes("payoutRoute") && i.includes("hooks")),
    hookedRoute.join("; "),
  );
});

/* ------------------------------------------------------------------ the uncorroborated delay */

test("the uncorroborated delay override exists, is bounded, and is refused on a corroborated market", () => {
  // O8-10 writes the 19 rows; the mechanism is here. NVDA keeps a v3 settlement pool, so it is the
  // market the override must NOT be written on — the delay only applies when that source is not ok.
  const withPool = allIssuesFor((r) => {
    const m = r.markets.find((x) => x.ticker === "NVDA");
    m.v2.overrides = { uncorroboratedDelayS: 3600 };
  });
  assert.ok(withPool.some((i) => i.includes("uncorroboratedDelayS") && i.includes("univ3Pool")), withPool.join("; "));

  const chainlinkOnly = (delay) => allIssuesFor((r) => {
    const m = r.markets.find((x) => x.v2.univ3Pool === null);
    m.v2.overrides = { uncorroboratedDelayS: delay };
  });
  assert.deepEqual(chainlinkOnly(3600), [], "3600 on a Chainlink-only market is the owner's decision of 2026-09-19");
  for (const bad of [0, 60, 899, 4 * 86400 + 1]) {
    assert.ok(chainlinkOnly(bad).some((i) => i.includes("uncorroboratedDelayS")), `${bad} s is accepted`);
  }
});

test("the SHIPPED registry: every launch row is Chainlink-only with the 3600 override, or has a pool and none", () => {
  // O8-10 wrote these rows. The validator refuses the two states in isolation; this asserts the file
  // we actually ship is in neither. The launch set is v8-plan/tasks/O-ops.md O8-10, NVDA is the canary.
  const registry = read("tier1.json");
  const launch = registry.markets.filter((m) => m.v2.wave === "wave1");
  const canary = registry.markets.filter((m) => m.v2.wave === "canary").map((m) => m.ticker);

  assert.deepEqual(canary, ["NVDA"], "NVDA is the canary and the only one");
  assert.equal(launch.length, 19, "the launch wave is the 19 of O8-10");
  assert.equal(registry.markets.filter((m) => m.v2.wave === "wave2").length, 15, "14 deferred + SGOV stay wave2");

  for (const m of [...launch, ...registry.markets.filter((x) => x.v2.wave === "canary")]) {
    const override = m.v2.overrides?.uncorroboratedDelayS;
    if (m.v2.univ3Pool === null) {
      assert.equal(override, 3600, `${m.ticker} is Chainlink-only and must carry uncorroboratedDelayS 3600`);
    } else {
      assert.equal(override, undefined, `${m.ticker} still has a v2.univ3Pool, so it must NOT carry the override`);
    }
    assert.equal(m.v2.status, "planned", `${m.ticker} status is written by the registration write-back, not here`);
  }

  // SGOV is dropped for a reason the row itself states, not one we remember.
  const sgov = registry.markets.find((m) => m.ticker === "SGOV");
  assert.equal(sgov.v2.wave, "wave2", "SGOV is dropped from the launch set");
  assert.equal(sgov.cboe?.weekly, false, "SGOV has no weekly expiries, which is why it is dropped");

  // Dailies are on by default and no launch row overrides them away.
  assert.deepEqual(registry.v2.defaults.expiriesAhead, { weekly: 2, daily: 3 }, "dailies are on in the defaults");
  for (const m of launch) {
    assert.equal(m.v2.overrides?.expiriesAhead, undefined, `${m.ticker} must not override expiriesAhead`);
  }
});

/* ------------------------------------------------------------------ dev.json vs production */

test("dev.json is no longer a copy of production", () => {
  const prod = read("tier1.json");
  const dev = read("dev.json");
  assert.ok("_dev" in dev && !("_dev" in prod));
  assert.notDeepEqual(dev.shared, prod.shared);
  assert.notDeepEqual(dev.v2.bots, prod.v2.bots);
  // Every wallet the devnet runs as is a PUBLIC anvil account (ops/devnet/lib.mjs ROLE_INDEX), so a
  // key that leaks from a dev stack is a key that was already published by anvil.
  assert.equal(dev.shared.admin, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(dev.v2.bots.cranker, "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f");
  // And the devnet deploys no v1 factory.
  for (const m of dev.markets) assert.equal(m.deployment.factory, null, m.ticker);
});

test("a dev registry may not name a production wallet, key or contract — proven one address at a time", () => {
  // This is the check that could not exist while the builder rewrote `shared` from a constant: a
  // rebuild put production's wallets back into dev.json and nothing said so.
  const production = read("tier1.json");
  // A production registry that actually has addresses; before the v8 broadcast tier1's are all null,
  // and a rule that only fires on non-null values would pass for the wrong reason.
  const prod = deployed();
  const cases = [
    ["shared.admin", (d) => { d.shared.admin = prod.shared.admin; d.shared.safes.admin = prod.shared.admin; }],
    ["shared.guardian", (d) => { d.shared.guardian = prod.shared.guardian; d.v2.bots.guardian = prod.shared.guardian; }],
    ["shared.feeRecipient", (d) => { d.shared.feeRecipient = prod.shared.feeRecipient; }],
    ["shared.safes.treasury", (d) => { d.shared.safes.treasury = prod.shared.safes.treasury; }],
    ["v2.bots.cranker", (d) => { d.v2.bots.cranker = prod.v2.bots.cranker; }],
    ["v2.contracts.clearinghouse", (d) => { d.v2.contracts.clearinghouse = prod.v2.contracts.clearinghouse; }],
    ["v2.flywheel.feeSplitter", (d) => { d.v2.flywheel.feeSplitter = prod.v2.flywheel.feeSplitter; }],
    ["v2.protocolAddresses.treasury", (d) => { d.v2.protocolAddresses.treasury = prod.shared.safes.treasury; }],
    ["a v1 factory", (d) => {
      const nvda = production.markets.find((m) => m.deployment.factory);
      d.markets.find((m) => m.ticker === nvda.ticker).deployment.factory = nvda.deployment.factory;
    }],
    ["a v1 keeper key", (d) => { d.markets[0].deployment.keeper = production.markets[0].deployment.keeper; }],
  ];
  for (const [what, mutate] of cases) {
    const dev = read("dev.json");
    mutate(dev);
    const against = what.startsWith("a v1") ? production : prod;
    const issues = [];
    validateDevIsolation(dev, against, issues);
    assert.ok(
      issues.some((i) => i.includes("may not name a production")),
      `dev.json may name production's ${what}: ${issues.join("; ") || "(no issues)"}`,
    );
  }
});

/**
 * T-249. Every other claim in validateDevIsolation walks a block the dev side also walks - except
 * production's own `v2.protocolAddresses`, which was not walked at all. A production address in that
 * block was therefore caught only THROUGH ITS TWIN elsewhere, and most keys have a twin, so the common
 * cases passed by accident rather than by rule. The exposure was exactly the twin-less slots:
 * `distributors.user` and `distributors.lender`, twin-less BY DESIGN because a second deployment of
 * RewardsDistributor cannot be mirrored into the closed, counted `v2.contracts` block (T-221).
 *
 * Measured before the fix: lender ACCEPTED, user ACCEPTED, maker REFUSED (via its twin). These pin all
 * three plus the negative case, so an over-broad rule that refused everything would fail too.
 */
test("a production protocolAddresses value may not appear in dev, INCLUDING the twin-less distributor slots", () => {
  const COPIED = "0x00000000000000000000000000000000000000aa";
  const cases = [
    ["distributors.lender", (p, d) => {
      p.v2.protocolAddresses.distributors.lender = COPIED;
      d.v2.protocolAddresses.distributors.lender = COPIED;
    }],
    ["distributors.user", (p, d) => {
      p.v2.protocolAddresses.distributors.user = COPIED;
      d.v2.protocolAddresses.distributors.user = COPIED;
    }],
    ["treasury", (p, d) => {
      p.v2.protocolAddresses.treasury = COPIED;
      d.v2.protocolAddresses.treasury = COPIED;
    }],
  ];
  for (const [what, mutate] of cases) {
    const production = read("tier1.json");
    const dev = read("dev.json");
    mutate(production, dev);
    const issues = [];
    validateDevIsolation(dev, production, issues);
    assert.ok(
      issues.some((i) => i.includes("may not name a production")),
      `dev.json may name production's ${what}: ${issues.join("; ") || "(no issues)"}`,
    );
  }
});

/** The other half: an address production does NOT own is still allowed, so the rule has not become "refuse everything". */
test("a dev-only address in the same slot is accepted, so the rule is not simply refusing the slot", () => {
  const production = read("tier1.json");
  const dev = read("dev.json");
  dev.v2.protocolAddresses.distributors.lender = "0x00000000000000000000000000000000000000bb";
  const issues = [];
  validateDevIsolation(dev, production, issues);
  assert.deepEqual(issues, []);
});

test("the isolation rule is about the protocol's addresses, not the chain's", () => {
  // USDG, Seaport, Multicall3, the Stock Tokens and the feeds are the same contracts on a fork of
  // 4663. A rule that refused them would refuse every devnet of this chain.
  const dev = read("dev.json");
  const production = read("tier1.json");
  assert.equal(dev.shared.usdg, production.shared.usdg);
  assert.equal(dev.markets[0].asset, production.markets[0].asset);
  const issues = [];
  validateDevIsolation(dev, production, issues);
  assert.deepEqual(issues, []);
});

test("the rule only applies to a registry that declares itself _dev", () => {
  const issues = [];
  validateDevIsolation(read("tier1.json"), read("tier1.json"), issues);
  assert.deepEqual(issues, [], "production must not be judged against itself");
});

/* ------------------------------------------------------------------ the frozen v7 registry */

test("v7-legacy.json keeps the v7 set readable, and tier1.json no longer carries it", () => {
  const legacy = read("v7-legacy.json");
  const prod = read("tier1.json");
  assert.ok("_legacy" in legacy, "the freeze marker is what makes build-markets refuse to touch it");
  assert.equal(legacy.v2.interfaceVersion, 7);
  // The v7 deployment, still resolvable during the run-off (the v7 monitor and cranker read it).
  assert.equal(legacy.v2.deployBlock, 65780341);
  assert.equal(legacy.v2.contracts.clearinghouse, "0x22dEf851cD1a3B04Ad7d232bE786d76E6944d424");
  assert.equal(legacy.markets.find((m) => m.ticker === "NVDA").v2.status, "live");
  // v7's fee model, frozen as it was: premium 0, rent 80 ppm on NVDA.
  assert.equal(legacy.v2.fees.premiumFeeBps, 0);
  assert.equal(legacy.markets.find((m) => m.ticker === "NVDA").v2.mintFeePpm, 80);
  // None of which is in the v8 registry any more.
  assert.equal(prod.v2.deployBlock, null);
  assert.equal(prod.v2.contracts.clearinghouse, null);
  assert.equal(prod.markets.find((m) => m.ticker === "NVDA").v2.status, "planned");
});

/* ------------------------------------------------------------------ the protocol block: missing */

test("the protocol block is in both registries with exactly the §3.3 keys", () => {
  for (const file of REGISTRIES) {
    const block = read(file).v2.protocolAddresses;
    assert.deepEqual(Object.keys(block).sort(), [...V2_PROTOCOL_KEYS].sort(), file);
    assert.deepEqual(Object.keys(block.distributors).sort(), [...V2_PROTOCOL_DISTRIBUTOR_KEYS].sort(), file);
  }
});

test("the skeleton a first build writes carries the block", () => {
  assert.ok("protocolAddresses" in V2_SKELETON, "V2_SKELETON has no protocolAddresses, so `v2` exactKeys would refuse every registry that has one");
  assert.deepEqual(Object.keys(V2_SKELETON.protocolAddresses).sort(), [...V2_PROTOCOL_KEYS].sort());
});

test("it is not a v2.contracts key (§3.1 rule 2: the address count and render-docs both close that block)", () => {
  for (const file of REGISTRIES) {
    const contracts = read(file).v2.contracts;
    assert.equal("protocolAddresses" in contracts, false, file);
    for (const key of ["admin", "guardian", "feeRecipient", "treasury", "feeSplitter", "buybackExecutor", "opsWallet"]) {
      assert.equal(key in contracts, false, `${file}: v2.contracts.${key}`);
    }
  }
});

test("a registry with no block at all is refused", () => {
  const registry = clone();
  delete registry.v2.protocolAddresses;
  const issues = [];
  validateV2Protocol(registry, issues);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /v2\.protocolAddresses is missing/);
});

test("a missing key is refused, one issue per key", () => {
  for (const key of V2_PROTOCOL_KEYS) {
    const issues = issuesFor((block) => {
      delete block[key];
    });
    assert.ok(mentioning(issues, key).some((i) => i.includes("is missing")), `dropping ${key} is accepted`);
  }
});

/**
 * T-221, THE HALF THAT WAS SILENT. `lender` landed in tier1.json with P8-05 and the constant was not
 * widened, so `exactKeys` called the shipped registry invalid — loud, and the reason this row exists.
 * The quiet half is that the leaf-entry loop iterates the SAME constant, so `distributors.lender` was
 * never handed to the null/address check or to the duplicate-address check: a lender slot holding a
 * number, a truncated address, or a copy of the maker distributor's address was accepted in silence.
 * These two cases are about the VALUE, not the key, and they are the ones that go red if the constant
 * is ever narrowed again.
 */
test("distributors.lender is checked like every other slot: a non-address value is refused", () => {
  const issues = issuesFor((block) => {
    block.distributors.lender = "0xnot-an-address";
  });
  assert.ok(
    issues.some((i) => i.includes("v2.protocolAddresses.distributors.lender must be an address or null")),
    `a malformed lender slot was accepted: ${JSON.stringify(issues)}`,
  );
});

test("distributors.lender may not quietly name another slot's address", () => {
  const issues = issuesFor((block) => {
    block.distributors.lender = block.distributors.maker;
  });
  assert.ok(
    issues.some((i) => i.includes("distributors.lender is the same address as v2.protocolAddresses.distributors.maker")),
    `the lender distributor was allowed to be the maker distributor: ${JSON.stringify(issues)}`,
  );
});

/**
 * The recurrence guard. A FUTURE distributor added to tier1.json without widening the constant fails
 * here in both directions — the registry gaining a key the constant does not know, and the constant
 * gaining one the registry does not carry. This is the assertion that was already red at base and that
 * nobody saw, because under build mode no suite runs.
 */
test("every distributor key the shipped registry carries is known to the constant, and the reverse", () => {
  for (const file of REGISTRIES) {
    const shipped = Object.keys(read(file).v2.protocolAddresses.distributors).sort();
    assert.deepEqual(
      shipped,
      [...V2_PROTOCOL_DISTRIBUTOR_KEYS].sort(),
      `${file}: the registry and V2_PROTOCOL_DISTRIBUTOR_KEYS disagree. Widen the constant in the same commit that adds the key, or exactKeys will refuse the registry the protocol ships and the leaf loop will skip the new slot's value checks entirely`,
    );
  }
  assert.ok(V2_PROTOCOL_DISTRIBUTOR_KEYS.includes("lender"), "the P8-05 lender distributor is missing from the constant again");
});

test("a missing distributors key is refused", () => {
  for (const key of V2_PROTOCOL_DISTRIBUTOR_KEYS) {
    const issues = issuesFor((block) => {
      delete block.distributors[key];
    });
    assert.ok(issues.some((i) => i.includes(`v2.protocolAddresses.distributors.${key} is missing`)), key);
  }
});

test("an unknown key in the protocol block is refused", () => {
  const issues = issuesFor((block) => {
    block.buybackExecuter = OTHER;
  });
  assert.ok(issues.some((i) => i.includes("buybackExecuter") && i.includes("not a known key")), issues.join("; "));
});

test("distributors must be an object", () => {
  const issues = issuesFor((block) => {
    block.distributors = OTHER;
  });
  assert.ok(issues.some((i) => i.includes("v2.protocolAddresses.distributors must be an object")), issues.join("; "));
});

/* ------------------------------------------------------------------ malformed */

test("anything that is not an address and not null is refused", () => {
  for (const bad of [OTHER.slice(0, 20), "not an address", 12345, true, {}, [], "0xZZZ"]) {
    const issues = issuesFor((block) => {
      block.treasury = bad;
    });
    assert.ok(mentioning(issues, "treasury").length > 0, `treasury = ${JSON.stringify(bad)} is accepted`);
  }
});

test("before the v8 deploy every slot may be null: the Safes and the splitter do not exist yet", () => {
  // v7 refused a null admin / guardian / feeRecipient outright. In v8 all three are addresses the
  // launch itself produces, so the rule moved to `v2.deployBlock` rather than being dropped.
  assert.deepEqual(V2_PROTOCOL_NEVER_NULL, []);
  assert.deepEqual(validateV2(read("tier1.json"), RECON, null), [], "the pre-deploy registry is all nulls and must pass");
});

test("once v2.deployBlock says a deployment exists, the manager, both role wallets and the recipient may not be null", () => {
  for (const key of V2_PROTOCOL_DEPLOYED_NEVER_NULL) {
    const issues = issuesFor((block, registry) => {
      block[key] = null;
      const twin = V2_PROTOCOL_TWINS[key].split(".");
      let node = registry;
      for (const step of twin.slice(0, -1)) node = node[step];
      node[twin[twin.length - 1]] = null; // keep the twin equal, so only the null rule can fire
      if (key === "guardian") registry.v2.bots.guardian = null;
      if (key === "feeRecipient") registry.v2.flywheel.feeSplitter = null;
    });
    assert.ok(mentioning(issues, key).some((i) => i.includes("is null")), `${key} = null is accepted on a deployed registry`);
  }
  // And the same nulls are fine while deployBlock is null.
  const predeploy = issuesFor((block, registry) => {
    registry.v2.deployBlock = null;
    for (const key of V2_PROTOCOL_DEPLOYED_NEVER_NULL) {
      block[key] = null;
      const twin = V2_PROTOCOL_TWINS[key].split(".");
      let node = registry;
      for (const step of twin.slice(0, -1)) node = node[step];
      node[twin[twin.length - 1]] = null;
    }
    registry.v2.bots.guardian = null;
    registry.v2.flywheel.feeSplitter = null;
    registry.v2.flywheel.buybackExecutor = null;
    block.feeSplitter = null;
    block.buybackExecutor = null;
  });
  assert.deepEqual(predeploy, []);
});

/* ------------------------------------------------------------------ drift from the twins */

test("every key with a twin must equal it, and a different address is refused", () => {
  for (const key of Object.keys(V2_PROTOCOL_TWINS)) {
    const issues = issuesFor((block) => {
      if (key.includes(".")) block.distributors[key.split(".")[1]] = OTHER;
      else block[key] = OTHER;
    });
    const mine = mentioning(issues, key);
    assert.ok(mine.length > 0, `${key} may drift from ${V2_PROTOCOL_TWINS[key]}`);
    assert.ok(mine.some((i) => i.includes(V2_PROTOCOL_TWINS[key])), `the issue for ${key} does not name its twin: ${mine.join("; ")}`);
  }
});

test("v8 leaves only distributors.user and distributors.lender without a twin — that was the O3-204 gap", () => {
  const untwinned = V2_PROTOCOL_KEYS.filter((k) => k !== "distributors" && !(k in V2_PROTOCOL_TWINS));
  assert.deepEqual(untwinned, [], `these keys mirror nothing and can drift silently: ${untwinned.join(", ")}`);
  assert.equal("distributors.user" in V2_PROTOCOL_TWINS, false, "distributors.user waits for F5");
  // `lender` is a SECOND DEPLOYMENT of RewardsDistributor, not a second contract, and `v2.contracts` is a
  // closed counted block (§3.1 rule 2), so there is nothing for it to mirror and adding a slot to mirror
  // would change a count render-docs and the deploy tooling consume. Twin-less is the DECISION here, not
  // an oversight: the address/null and duplicate-address checks still cover it, which is what T-221 fixed.
  assert.equal("distributors.lender" in V2_PROTOCOL_TWINS, false, "distributors.lender mirrors nothing by design");
  for (const key of ["feeSplitter", "buybackExecutor", "treasury", "accessManager", "opsWallet"]) {
    assert.ok(key in V2_PROTOCOL_TWINS, `${key} still has no twin`);
  }
});

test("a twin that is filled in while the block still says null is refused", () => {
  // The way an exclusion list actually goes wrong: something is deployed and nobody adds it here.
  const issues = issuesFor((block) => {
    block.makerVault = null;
  });
  assert.ok(mentioning(issues, "makerVault").length > 0, "the block may claim no MakerVault while v2.contracts has one");
});

test("a block that names an address the registry does not have is refused", () => {
  const issues = issuesFor((_block, registry) => {
    registry.v2.contracts.rewardsDistributor = null;
  });
  assert.ok(issues.some((i) => i.includes("distributors.maker")), "distributors.maker may name a distributor v2.contracts does not");
});

/* ------------------------------------------------------------------ duplicates */

test("the fee recipient IS the fee splitter: the one pair v8 lets name a single address", () => {
  const r = deployed();
  assert.equal(r.shared.feeRecipient, r.v2.flywheel.feeSplitter);
  assert.deepEqual(validateV2(r, RECON, null), []);
});

test("everything else that repeats is refused, including two Safes that are one Safe", () => {
  const cases = [
    ["two contract slots", (block, r) => {
      block.autoRoller = r.v2.contracts.makerVault;
      r.v2.contracts.autoRoller = r.v2.contracts.makerVault;
    }],
    ["a bot key that is also the admin Safe", (block, r) => {
      block.cranker = r.shared.admin;
      r.v2.bots.cranker = r.shared.admin;
    }],
    ["two bot keys", (block, r) => {
      block.pricer = block.cranker;
      r.v2.bots.pricer = r.v2.bots.cranker;
    }],
    ["the ops wallet as the treasury Safe", (block, r) => {
      block.opsWallet = r.shared.safes.treasury;
      r.shared.opsWallet = r.shared.safes.treasury;
    }],
    ["the guardian hot key as the admin Safe", (block, r) => {
      block.guardian = r.shared.admin;
      r.shared.guardian = r.shared.admin;
      r.v2.bots.guardian = r.shared.admin;
    }],
  ];
  for (const [what, mutate] of cases) {
    const issues = issuesFor(mutate);
    assert.ok(issues.some((i) => i.includes("same address")), `${what} is accepted: ${issues.join("; ")}`);
  }
});

test("the two Safes may not be one Safe (V3-D1, D10)", () => {
  const issues = allIssuesFor((r) => {
    r.shared.admin = addr(7);
    r.shared.safes = { admin: addr(7), treasury: addr(7) };
    r.v2.protocolAddresses.admin = addr(7);
    r.v2.protocolAddresses.treasury = addr(7);
  });
  assert.ok(issues.some((i) => i.includes("shared.safes.admin and shared.safes.treasury")), issues.join("; "));
});

test("shared.safes.admin and shared.admin are the same Safe written twice", () => {
  const issues = allIssuesFor((r) => {
    r.shared.admin = addr(7);
    r.shared.safes.admin = addr(8);
  });
  assert.ok(issues.some((i) => i.includes("shared.safes.admin") && i.includes("shared.admin")), issues.join("; "));
});

test("v2.bots.guardian and shared.guardian are the same hot key written twice", () => {
  const issues = allIssuesFor((r) => {
    r.v2.bots.guardian = addr(9);
  });
  assert.ok(issues.some((i) => i.includes("v2.bots.guardian") && i.includes("shared.guardian")), issues.join("; "));
});

/* ------------------------------------- the settlement source-count floor (T-568, from T-502's P2) */

/**
 * SINGLE-SOURCE MARKETS AS THEY STAND ON 2026-09-21. This is a RECORD OF AN UNREVIEWED STATE, NOT AN
 * APPROVAL. T-495 and T-502 both argued that the half-day settlement residual is bounded because
 * "no registered market is single-source". That clause is FALSE: 33 of the 35 markets in each
 * registry carry `v2.univ3Pool: null`, and `script/v2/RegisterMarkets.s.sol:919-921` builds the
 * oracle source list as `new address[](m.pool == address(0) ? 1 : 2)`, so each of them registers
 * with ONE source. Only NVDA and SPCX carry a pool.
 *
 * WHY THAT MATTERS: with one source, a window in which the Chainlink feed is not ok leaves
 * `okCount` at 0, `SettlementOracle._band` returns `(false, 0, 0)`, and `adminResolve` accepts any
 * price in (0, MAX_PRICE]. That is the BUG-04 F3 shape without needing a special expiry.
 *
 * WHAT IS NOT CLAIMED: nobody has shown a live Chainlink Stock Token feed actually goes stale over
 * the relevant window, and no market is registered yet (`v2.status` is "planned" for all 35). This
 * is a missing safety margin, not a demonstrated exploit.
 *
 * WHY THESE 33 ARE SINGLE-SOURCE, because it is a DELIBERATE TRADE and not an oversight: of the 33,
 * 20 have only "thin" pools in the F2-02 recon, 2 have no pool at all, and 11 have a pool the recon
 * calls "usable" whose observation cardinality is 1800-1860 — below MIN_POOL_OBSERVATION_CARDINALITY,
 * which `src/v2/interfaces/V2Constants.sol:148` defines as SETTLEMENT_WINDOW + SNAPSHOT_GRACE + 1 =
 * 2401. `build-markets.mjs:1211-1214` refuses a shallower pool and spells out the only two ways
 * forward: register the market Chainlink-only, or raise the ring with
 * `increaseObservationCardinalityNext(2401)` and re-run `ops/recon/r13-probe.mjs`. Every one of the
 * 33 is the first option, taken on purpose. So wiring them up is NOT a one-line registry edit.
 *
 * THE POINT OF FREEZING THE SET: a 34th single-source market must be a decision someone makes, not
 * a row that slips in. Adding a ticker here is that decision.
 *
 * STATUS OF THIS SET, stated plainly: the coordinator was asked to rule on whether recording 33
 * markets this way is the right shape (T-568, options a/b/d) and had not replied when this landed.
 * This is the shape the row's own criterion 4 forces — a plain "no market is single-source" is red
 * on commit 66 times and cannot be proven by breaking, because it is never green to begin with.
 * IT IS ONE CONSTANT TO CHANGE. If the posture call goes the other way, delete the set and the
 * first test becomes the plain assertion; nothing else here depends on it.
 */
// THE SET LIVES IN build-markets.mjs AND IS IMPORTED (T-599). It used to be defined here, which
// meant the suite froze it and the BUILD did not -- a market could gain or lose its pool and
// `--check` stayed green. Two lists that must agree are a list that will not, so there is now one.

test("no market becomes single-source without a decision", () => {
  for (const file of REGISTRIES) {
    const r = read(file);
    for (const m of r.markets) {
      if (m.v2.univ3Pool) continue;
      assert.ok(
        SINGLE_SOURCE_AT_2026_09_21.has(m.ticker),
        `${file} ${m.ticker}: a NEW single-source market. RegisterMarkets.s.sol:919-921 gives a market with no v2.univ3Pool a one-element oracle source list, so a window where the Chainlink feed is not ok leaves okCount 0 and SettlementOracle.adminResolve unbounded. Give it a univ3Pool, or add it to SINGLE_SOURCE_AT_2026_09_21 as a deliberate decision.`,
      );
    }
  }
});

test("the BUILD refuses a 34th single-source market, not just the suite (T-599)", () => {
  // The suite already froze the set; `--check` did not. These two cases pin the VALIDATOR, so the
  // guard survives someone deleting the two assertions above.
  const issues = allIssuesFor((r) => {
    const m = r.markets.find((x) => x.ticker === "NVDA");
    m.v2.univ3Pool = null;
    m.v2.univ3MinLiquidity = null;   // the pair rule: pool and floor are set together or not at all
  });
  assert.ok(issues.some((i) => i.includes("NVDA") && i.includes("a NEW single-source market")),
    `expected the build to refuse NVDA losing its pool, got ${JSON.stringify(issues)}`);
});

test("the BUILD refuses a set entry that has gained a pool, so the set cannot rot (T-599)", () => {
  // The other direction. Without it the set silently accumulates tickers that are no longer
  // single-source, and a real 34th could hide behind a stale name.
  const issues = allIssuesFor((r) => {
    const m = r.markets.find((x) => x.ticker === "AAPL");
    m.v2.univ3Pool = "0x" + "11".repeat(20);
    m.v2.univ3MinLiquidity = "1000000000000000000";
  });
  assert.ok(issues.some((i) => i.includes("AAPL") && i.includes("still listed in SINGLE_SOURCE_AT_2026_09_21")),
    `expected the build to refuse AAPL gaining a pool while still in the set, got ${JSON.stringify(issues)}`);
});

test("the recorded single-source set has not silently shrunk either", () => {
  // The inverse direction. If a market GAINS a pool the set is stale and should be trimmed, and
  // leaving a stale name here would let a future single-source market pass unnoticed under it.
  const live = new Set();
  for (const file of REGISTRIES) for (const m of read(file).markets) if (!m.v2.univ3Pool) live.add(m.ticker);
  for (const t of SINGLE_SOURCE_AT_2026_09_21) {
    assert.ok(live.has(t), `${t} now has a univ3Pool: remove it from SINGLE_SOURCE_AT_2026_09_21 so the set keeps meaning what it says`);
  }
});

// 8. The launch set: named, not inferred (T-OP-003).

/** The launch set the owner ruled on, 2026-09-21. A ticker list, deliberately not a wave name. */
const LAUNCH_SET_AT_2026_09_21 = ["NVDA", "SPCX"];

test("the shipped launch set is exactly the two markets the owner named", () => {
  // AC6(c). Two assertions, not one: the COUNT catches a set that grew or shrank, and the MEMBERS
  // catch a swap that kept the count. Removing SPCX fails the second naming SPCX; adding a third
  // fails the first.
  const named = read("tier1.json").launchSet.markets;
  // MEMBERS FIRST, COUNT SECOND, and the order is load-bearing. Both directions were run: with the
  // count first, dropping SPCX failed with "the launch set is 1 markets (NVDA)" -- a true message that
  // never says which market went missing, so the operator reading it has to diff the file to find out.
  // Checking membership first makes the red NAME THE TICKER, which is what AC6(a) asks for and what a
  // person at 3 a.m. needs.
  for (const ticker of LAUNCH_SET_AT_2026_09_21) {
    assert.ok(named.includes(ticker), `${ticker} is not in launchSet.markets; the owner's launch set is ${LAUNCH_SET_AT_2026_09_21.join(" and ")}`);
  }
  assert.equal(named.length, LAUNCH_SET_AT_2026_09_21.length,
    `the launch set is ${named.length} markets (${named.join(", ")}); the owner named ${LAUNCH_SET_AT_2026_09_21.length}`);
});

test("THE PREMISE: the launch set is not reproducible by any wave or status filter", () => {
  // This is the whole reason launchSet exists, asserted rather than asserted-about. If some single
  // `wave`, `v2.wave` or `status` value ever selects exactly {NVDA, SPCX}, a reader could derive the
  // launch set again and the block would look redundant -- so this test says out loud that it is not,
  // and goes red on the day that changes rather than letting someone quietly re-derive it.
  const markets = read("tier1.json").markets;
  const want = new Set(LAUNCH_SET_AT_2026_09_21);
  const sameSet = (list) => list.length === want.size && list.every((t) => want.has(t));
  for (const field of ["wave", "status"]) {
    for (const value of new Set(markets.map((m) => m[field]))) {
      const picked = markets.filter((m) => m[field] === value).map((m) => m.ticker);
      assert.ok(!sameSet(picked), `markets[].${field} === ${JSON.stringify(value)} selects exactly the launch set; it is derivable after all and launchSet's note is now wrong`);
    }
  }
  for (const value of new Set(markets.map((m) => m.v2.wave))) {
    const picked = markets.filter((m) => m.v2.wave === value).map((m) => m.ticker);
    assert.ok(!sameSet(picked), `markets[].v2.wave === ${JSON.stringify(value)} selects exactly the launch set; it is derivable after all`);
  }
});

test("a launch set naming a market the registry does not carry is refused", () => {
  // The failure this guard exists for: a launch that deploys nothing for one of its markets and
  // reads as configured. A typo is the ordinary way in.
  const issues = allIssuesFor((r) => { r.launchSet.markets = ["NVDA", "SPXC"]; });
  assert.ok(issues.some((i) => i.includes("SPXC") && i.includes("not a market in this registry")),
    `expected a refusal naming SPXC, got ${JSON.stringify(issues)}`);
});

test("a launch set naming the same market twice is refused", () => {
  const issues = allIssuesFor((r) => { r.launchSet.markets = ["NVDA", "SPCX", "NVDA"]; });
  assert.ok(issues.some((i) => i.includes("NVDA") && i.includes("twice")), `expected a duplicate refusal, got ${JSON.stringify(issues)}`);
});

test("an empty launch set is refused, because zero markets is not a launch", () => {
  const issues = allIssuesFor((r) => { r.launchSet.markets = []; });
  assert.ok(issues.some((i) => i.includes("launchSet.markets must be a non-empty array")), JSON.stringify(issues));
});

test("an unknown key in the launch set is refused, like every other closed block", () => {
  const issues = allIssuesFor((r) => { r.launchSet.waves = ["canary"]; });
  assert.ok(issues.some((i) => i.includes("launchSet.waves") && i.includes("not a known key")), JSON.stringify(issues));
});

test("a production registry must name its launch set; a dev registry need not", () => {
  // The asymmetry is deliberate and it is what keeps ops/markets/dev.json valid untouched: the root
  // object is not exact-keyed, so the block is addable to tier1.json alone, and `production` is
  // non-null only when a dev registry is being checked against production.
  const missing = [];
  validateLaunchSet({ markets: read("tier1.json").markets }, null, missing);
  assert.ok(missing.some((i) => i.includes("launchSet is missing")), JSON.stringify(missing));

  const dev = [];
  validateLaunchSet({ markets: read("dev.json").markets }, read("tier1.json"), dev);
  assert.deepEqual(dev, [], "a dev registry without a launchSet is not an issue");
});

// 9. Root keys: carried, regenerated or retired (T-607).

/**
 * The root keys the registries carry by hand. None may ever sit on a dropped list: a list that named
 * one would make the guard pass by agreeing to lose it, which is the original defect with extra steps.
 */
const HAND_MAINTAINED_ROOT_KEYS = ["_dev", "launchSet", "shared", "v2"];

/** What `main` hands `assembleRegistry`, minus the chain and the feed directory: the markets pass through. */
const offlineRun = (r, block = 1) => ({
  block,
  feedsSource: "offline (build-markets.test.mjs)",
  feeds: [],
  equity: [],
  tokens: [],
  skipped: [],
  markets: r.markets,
});
/** The registry a build would write over `r`, from the same literal `main` uses. */
const rebuild = (r, block) => assembleRegistry(r, offlineRun(r, block));

test("a rebuild of each shipped registry loses no root key (T-607)", () => {
  // The control that keeps the guard honest: if this were red on the shipped files, the guard would be
  // always-on and every other assertion here would pass for the wrong reason.
  for (const file of REGISTRIES) {
    const r = read(file);
    assert.deepEqual(rootKeyIssues(r, rebuild(r)), [], `${file}: a rebuild of the committed registry would lose a root key`);
  }
});

test("the T-OP-003 near miss: launchSet comes out of a rebuild exactly as it went in", () => {
  // The key that would have been eaten. Pinned by name as well as by the general guard above, so that
  // removing its line from assembleRegistry fails here naming launchSet.
  const r = read("tier1.json");
  assert.ok(r.launchSet, "tier1.json carries no launchSet: this test has nothing to protect");
  assert.deepEqual(rebuild(r).launchSet, r.launchSet, "a rebuild of tier1.json did not carry launchSet");
});

test("a root key nobody named fails the build, and the refusal names it", () => {
  // Nobody wrote a line for this key in assembleRegistry and nobody listed it as an output. Before T-607
  // it vanished on the next rebuild; now it is the one issue, by name.
  const r = read("tier1.json");
  r.opsNoteT607 = { note: "a root block added by hand after the builder was written" };
  const issues = rootKeyIssues(r, rebuild(r));
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.ok(issues[0].includes("root key opsNoteT607") && issues[0].includes("missing from the registry about to be written"), issues[0]);
});

test("a hand-maintained block rewritten instead of carried fails, naming it", () => {
  // Present is not enough. v7 wrote `shared` from a constant on every build, and that is why dev.json
  // could not stop being a copy of production: the key survived, its value did not.
  const r = read("dev.json");
  const written = rebuild(r);
  written.shared = { ...written.shared, admin: OTHER };
  const issues = rootKeyIssues(r, written);
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.ok(issues[0].includes("root key shared") && issues[0].includes("different value"), issues[0]);
});

test("a regenerated key the build stops writing is a dropped key under a better name", () => {
  const r = read("tier1.json");
  const written = rebuild(r);
  delete written.summary;
  const issues = rootKeyIssues(r, written);
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.ok(issues[0].includes("root key summary") && issues[0].includes("did not write it"), issues[0]);
});

test("the outputs really are regenerated: a rebuild does not carry the previous run's block or time", () => {
  // Why the literal must not spread `existing`: a spread would report the previous run's block as
  // this run's, and nothing downstream could tell.
  const r = read("tier1.json");
  const written = rebuild(r, r.verifiedAtBlock + 1);
  assert.equal(written.verifiedAtBlock, r.verifiedAtBlock + 1);
  assert.notEqual(written.generatedAt, r.generatedAt);
});

test("the dropped lists name no hand-maintained key, and every entry says why", () => {
  for (const key of HAND_MAINTAINED_ROOT_KEYS) {
    assert.ok(!Object.hasOwn(REGENERATED_ROOT_KEYS, key), `${key} is hand-maintained and must never be listed as regenerated`);
    assert.ok(!Object.hasOwn(RETIRED_ROOT_KEYS, key), `${key} is hand-maintained and must never be listed as retired`);
  }
  for (const [key, why] of [...Object.entries(REGENERATED_ROOT_KEYS), ...Object.entries(RETIRED_ROOT_KEYS)]) {
    assert.ok(typeof why === "string" && why.trim().length > 10, `${key}: a dropped root key needs the reason its old value can go`);
  }
  // A first build reads nothing, so it can lose nothing; what is left is the lists agreeing with the literal.
  const first = assembleRegistry(null, offlineRun(read("tier1.json")));
  assert.deepEqual(rootKeyIssues(null, first), []);
  assert.ok(!("launchSet" in first) && !("_dev" in first), "a first build invented a hand-maintained key");
});

test("a retired key is discarded on purpose, and one the build still writes is refused", () => {
  const lists = { regenerated: {}, retired: { oldBlock: "retired by this test" } };
  assert.deepEqual(rootKeyIssues({ keep: 1, oldBlock: 2 }, { keep: 1 }, lists), []);
  const still = rootKeyIssues({ oldBlock: 2 }, { oldBlock: 2 }, lists);
  assert.ok(still.length === 1 && still[0].includes("root key oldBlock") && still[0].includes("still writes"), JSON.stringify(still));
  const both = rootKeyIssues(null, { k: 1 }, { regenerated: { k: "x" }, retired: { k: "y" } });
  assert.ok(both.length === 1 && both[0].includes("both"), JSON.stringify(both));
});

/* ------------------------------------------------------------------ 10. Per-market keys: carried, regenerated or optional (T-OP-023) */

/**
 * What `main` hands `assembleMarket` for a market it has already seen, reconstructed from the row
 * itself: the token and feed-directory entries the run would read, and the verification and Cboe
 * evidence the run would produce. Feeding a row's own evidence back in is what makes the rebuild
 * comparable key by key — the regenerated keys come out equal because their inputs are equal, and any
 * carried key that does not is the guard's subject.
 */
const runFrom = (m, registry) => ({
  ticker: m.ticker,
  token: { name: m.name, token: m.asset, block: m.assetDeployBlock },
  asset: m.asset,
  feed: { name: m.feedName, heartbeat: m.feedHeartbeatS, threshold: m.feedThresholdPct },
  feedProxy: m.feed,
  feedSvr: m.feedSvr,
  feedAggregator: m.feedAggregator,
  verification: m.verification,
  cboe: m.cboe,
  shared: registry.shared,
});
/** The row a rebuild would write over `m`, from the same literal `main` uses. */
const rebuildMarket = (m, registry) => assembleMarket(m, runFrom(m, registry));
const CARRIED = Object.entries(MARKET_FIELDS).filter(([, f]) => f.kind === "carried").map(([k]) => k);
const REFUSE_NULL = Object.entries(MARKET_FIELDS).filter(([, f]) => f.kind === "carried" && f.nullOk === false).map(([k]) => k);
const NULL_OK = Object.entries(MARKET_FIELDS).filter(([, f]) => f.kind === "carried" && f.nullOk === true).map(([k]) => k);
const OPTIONAL = Object.entries(MARKET_FIELDS).filter(([, f]) => f.kind === "optional").map(([k]) => k);
const KEPT = Object.entries(MARKET_FIELDS).filter(([, f]) => f.kind === "kept").map(([k]) => k);
/** A market as `main` first sees it: no previous row, the run's reads only. */
const firstSeen = (registry) =>
  assembleMarket(undefined, {
    ...runFrom(registry.markets[0], registry),
    ticker: "NEWCO",
    verification: { ok: true, issues: [], spotUsd: 100, tokenSymbol: "NEWCO", feedDescription: "NEWCO / USD" },
    cboe: null,
  });

test("T-OP-023 baseline: no shipped market carries a key outside MARKET_FIELDS, and no null where null would be defaulted", () => {
  // The reason the row is P3 rather than a live data loss. If this is red, a rebuild of the committed
  // file would already drop something: stop and say which key before changing the builder.
  for (const file of REGISTRIES) {
    for (const m of read(file).markets) {
      const outside = Object.keys(m).filter((k) => !Object.hasOwn(MARKET_FIELDS, k));
      assert.deepEqual(outside, [], `${file} ${m.ticker}: keys the builder's literal does not name: ${outside.join(", ")}`);
      for (const k of REFUSE_NULL) assert.notEqual(m[k], null, `${file} ${m.ticker}: ${k} is null and a rebuild would default it silently`);
    }
  }
});

test("T-OP-023: MARKET_FIELDS and the literal name the same keys, for a seen market and a first-seen one", () => {
  const r = read("tier1.json");
  // Every key the literal can emit, across both shapes: the optional keys appear only when set, so a
  // seen row with modeOverride and notes set is what exercises them.
  const seen = rebuildMarket({ ...r.markets[0], modeOverride: "fixed", notes: "pinned", v1RunOff: true, v1FrozenAt: 1 }, r);
  const fresh = firstSeen(r);
  const emitted = new Set([...Object.keys(seen), ...Object.keys(fresh)]);
  assert.deepEqual([...emitted].sort(), Object.keys(MARKET_FIELDS).sort(), "the literal and MARKET_FIELDS disagree on the key set");
  // Every non-optional key is written on both shapes; every optional key is absent when unset.
  for (const [k, f] of Object.entries(MARKET_FIELDS)) {
    if (f.kind === "regenerated" || f.kind === "carried") assert.ok(k in fresh && k in seen, `${k} is ${f.kind} but a rebuild did not write it`);
    else assert.ok(!(k in fresh) && k in seen, `${k} is ${f.kind}: written iff the row had it`);
    assert.ok(typeof f.why === "string" && f.why.length > 10, `${k}: a classification needs its reason`);
  }
  // And the guard itself reports a classification gap in both directions.
  assert.ok(marketKeyIssues(undefined, { ...fresh, extra: 1 }).some((i) => i.includes("key extra is written") && i.includes("MARKET_FIELDS")));
  const { notes: _n, deployment: _d, ...missing } = { ...fresh, notes: "x" };
  assert.ok(marketKeyIssues(undefined, missing).some((i) => i.includes("key deployment is carried") && i.includes("did not write it")));
});

test("T-OP-023: a rebuild of every shipped market loses nothing, and carries every hand-maintained key byte-identically", () => {
  for (const file of REGISTRIES) {
    const r = read(file);
    for (const m of r.markets) {
      const w = rebuildMarket(m, r);
      assert.deepEqual(marketKeyIssues(m, w), [], `${file} ${m.ticker}`);
      for (const k of [...CARRIED, ...KEPT]) if (k in m) assert.deepEqual(w[k], m[k], `${file} ${m.ticker}: ${k} changed on rebuild`);
      for (const k of [...KEPT, ...OPTIONAL]) if (!(k in m)) assert.ok(!(k in w), `${file} ${m.ticker}: ${k} was invented on rebuild`);
      for (const k of OPTIONAL) if (m[k]) assert.deepEqual(w[k], m[k], `${file} ${m.ticker}: ${k} changed on rebuild`);
    }
  }
});

test("T-OP-023: a hand-written key the literal does not name is refused by ticker and key, before the write", () => {
  const r = read("tier1.json");
  const m = { ...r.markets[0], strikeOtmBpsOverride: 700 };
  const issues = marketKeyIssues(m, rebuildMarket(m, r));
  assert.equal(issues.length, 1, issues.join("; "));
  assert.ok(issues[0].startsWith(`${m.ticker}: key strikeOtmBpsOverride is in the market read and missing`), issues[0]);
  // The rebuilt row really did drop it: that is the loss the message describes.
  assert.ok(!("strikeOtmBpsOverride" in rebuildMarket(m, r)));
});

test("T-OP-023: a null where the literal would default it is refused, naming the ticker and field", () => {
  const r = read("tier1.json");
  assert.deepEqual(REFUSE_NULL.sort(), ["deployment", "minAskUsdg6", "premiumMarginBps", "priceEdgeBps", "status", "strikeOtmBps", "targetDelta", "wave"]);
  for (const k of REFUSE_NULL) {
    const m = { ...r.markets[1], [k]: null };
    const w = rebuildMarket(m, r);
    // The literal's `??` is what turns the null into a value: the guard exists because this is silent.
    assert.notEqual(w[k], null, `${k}: the literal kept the null, so the decision is moot`);
    const issues = marketKeyIssues(m, w);
    assert.ok(issues.some((i) => i.startsWith(`${m.ticker}: ${k} is null in the registry read`) && i.includes("default")), `${k}: ${issues.join("; ") || "(accepted)"}`);
  }
});

test("T-OP-023: a null that is a legal value survives a rebuild unreported (depositCapUsd is the precedent)", () => {
  const r = read("tier1.json");
  assert.deepEqual(NULL_OK.sort(), ["depositCapUsd", "v2"]);
  assert.deepEqual(KEPT.sort(), ["v1FrozenAt", "v1RunOff"]);
  for (const k of [...NULL_OK, ...KEPT]) {
    const m = { ...r.markets[2], [k]: null };
    const w = rebuildMarket(m, r);
    assert.equal(w[k], null, `${k}: a legal null was replaced on rebuild`);
    assert.deepEqual(marketKeyIssues(m, w), [], `${k}: a legal null was reported`);
  }
  // depositCapUsd null is uncapped: the derived cap is type(uint256).max, not a default cap.
  const m = { ...r.markets[2], depositCapUsd: null };
  assert.equal(rebuildMarket(m, r).depositCap, (2n ** 256n - 1n).toString());
});

test("T-OP-023: optional keys are written when set, legitimately absent when unset, and never invented", () => {
  const r = read("tier1.json");
  assert.deepEqual(OPTIONAL.sort(), ["modeOverride", "notes"]);
  const base = r.markets[3];
  for (const k of OPTIONAL) {
    for (const unset of [null, "", undefined]) {
      const m = { ...base, [k]: unset };
      const w = rebuildMarket(m, r);
      assert.ok(!(k in w), `${k}=${JSON.stringify(unset)} was written`);
      assert.deepEqual(marketKeyIssues(m, w), [], `${k}=${JSON.stringify(unset)} was reported`);
    }
  }
  const set = { ...base, modeOverride: "fixed", notes: "hand-written" };
  const w = rebuildMarket(set, r);
  assert.equal(w.modeOverride, "fixed");
  assert.equal(w.mode, "fixed");
  assert.ok(w.modeReason.startsWith("override (auto:"));
  assert.equal(w.notes, "hand-written");
  assert.deepEqual(marketKeyIssues(set, w), []);
  // A set value that a rebuild would change is the same loss: proven by handing the guard a row that lost it.
  const { notes: _dropped, ...without } = w;
  assert.ok(marketKeyIssues(set, without).some((i) => i.includes("notes is set in the registry read")));
  // And a value the build writes that the registry never had is reported too.
  assert.ok(marketKeyIssues(base, { ...rebuildMarket(base, r), notes: "invented" }).some((i) => i.includes("notes is unset in the registry read")));
});

test("T-OP-023: a carried key rewritten to a different value is reported, the same loss one level down", () => {
  const r = read("tier1.json");
  const m = r.markets[4];
  const w = { ...rebuildMarket(m, r), strikeOtmBps: m.strikeOtmBps + 1 };
  const issues = marketKeyIssues(m, w);
  assert.ok(issues.some((i) => i.startsWith(`${m.ticker}: strikeOtmBps is carried, not regenerated`)), issues.join("; "));
});

test("T-OP-023: a first-seen market has nothing to lose, and its row is the documented skeleton", () => {
  const r = read("tier1.json");
  const fresh = firstSeen(r);
  assert.deepEqual(marketKeyIssues(undefined, fresh), []);
  assert.equal(fresh.status, "superseded-by-v2");
  assert.equal(fresh.wave, "wave2");
  // v2MarketSkeleton: planned, last wave, no pool, strikeTick deliberately null (validation refuses it until chosen).
  assert.equal(fresh.v2.status, "planned");
  assert.equal(fresh.v2.univ3Pool, null);
  assert.equal(fresh.v2.strikeTick, null);
  assert.equal(fresh.deployment.factory, null);
  assert.equal(fresh.deployment.guardian, r.shared.guardian);
});

/* ------------------------------------------------------------------ T-OP-111: the two Safes are written, and they are real */

// The Admin Safe and the Treasury Safe were created by the owner on 2026-09-21 (safes-bootstrap.sh; creation txs
// 0xb61dbb85…a56 at block 68864146 and 0x4a76ae73…dcd at block 68864203) and VERIFIED on chain 4663 by T-OP-111 before
// they were written here: SafeL2 1.4.1 singleton 0x29fcB43b…C762 in slot 0, VERSION() "1.4.1", getThreshold() 2,
// getOwners() exactly the three hot-wallet keys idx 70/71/72, CompatibilityFallbackHandler 0xfd0732…Ec99, no guard,
// no module. These pins hold the WRITE: non-null, EIP-55 as the chain reads them, mirrored, distinct from every other
// principal, and never an anvil account. They do not re-read the chain; the ledger entry carries the block numbers.
const ADMIN_SAFE = "0x6f8A7B77b72511cD8939596b1659bA28C28f101B";
const TREASURY_SAFE = "0x014b996a084690FB27265BfAC157b04e9FeBbF4E";
const OPS_WALLET = "0x088E22EaF42F99c8b0d9A4e9babA5EdDE78A1439";

test("T-OP-111: tier1.json carries the two verified 2-of-3 Safes, mirrored and distinct", () => {
  const r = read("tier1.json");
  assert.equal(r.shared.safes.admin, ADMIN_SAFE, "the Admin Safe (first-created, saltNonce 2026092101, block 68864146)");
  assert.equal(r.shared.safes.treasury, TREASURY_SAFE, "the Treasury Safe (saltNonce 2026092102, block 68864203)");
  assert.equal(r.shared.admin, r.shared.safes.admin, "shared.admin IS the Admin Safe (README: same address as shared.safes.admin)");
  assert.equal(r.shared.opsWallet, OPS_WALLET, "the ops wallet, hot-wallet idx 74");
  assert.notEqual(r.shared.safes.admin.toLowerCase(), r.shared.safes.treasury.toLowerCase(), "two Safes, not one address twice");
  // Exact EIP-55 as written: a lowercased or mis-cased copy is a different string and a consumer that
  // compares strings would call the same Safe a stranger.
  for (const [k, v] of [["admin", ADMIN_SAFE], ["treasury", TREASURY_SAFE]]) {
    assert.match(v, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(v, v.toLowerCase(), `${k} must be EIP-55, not lowercase`);
  }
});

test("T-OP-111: the Safes are distinct from every other principal the launch names, and the deploy still owns feeRecipient", () => {
  const r = read("tier1.json");
  const principals = new Map();
  const add = (label, v) => {
    if (typeof v !== "string") return;
    const key = v.toLowerCase();
    assert.ok(!principals.has(key), `${label} ${v} is also ${principals.get(key)}: v8 needs distinct principals (DeployV2Batch.sh:236-244)`);
    principals.set(key, label);
  };
  add("shared.safes.admin", r.shared.safes.admin);
  add("shared.safes.treasury", r.shared.safes.treasury);
  add("shared.opsWallet", r.shared.opsWallet);
  add("shared.guardian", r.shared.guardian);
  add("shared.feeRecipient", r.shared.feeRecipient);
  for (const [k, v] of Object.entries(r.v2.bots)) if (k !== "guardian" || v !== r.shared.guardian) add(`v2.bots.${k}`, v);
  // The Safe owners are keys, not principals of the deploy, but a Safe that is its own owner is not a 2-of-3.
  for (const o of ["0x5E3706c385E7F7252D5C03b3c6eb82c88eBFF8b7", "0xF5235EBE8953c6039b36b7db2F2D3AD5EEFC66F1", "0x4C24888237890BA4d147670EB8a0e7539C9e19B6"]) {
    assert.ok(!principals.has(o.toLowerCase()), `Safe owner ${o} is also a launch principal`);
  }
  // feeRecipient is the FeeSplitter the deploy creates (V8-DESIGN §6; write-back leaves it null until then).
  assert.equal(r.shared.feeRecipient, null, "shared.feeRecipient is filled by the deploy with the FeeSplitter, not by hand");
});

test("T-OP-111: dev.json keeps its anvil Safes — production Safes never enter the dev registry", () => {
  const dev = read("dev.json");
  const prod = read("tier1.json");
  for (const k of ["admin", "treasury"]) {
    assert.notEqual(dev.shared.safes[k].toLowerCase(), prod.shared.safes[k].toLowerCase(), `dev shared.safes.${k} is the production Safe`);
  }
  assert.equal(dev.shared.safes.admin, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "dev admin Safe stays anvil #0");
  assert.equal(dev.shared.safes.treasury, "0x71bE63f3384f5fb98995898A86B02Fb2426c5788", "dev treasury Safe stays anvil #9");
  assert.notEqual(dev.shared.opsWallet, prod.shared.opsWallet, "dev opsWallet is not the production ops wallet");
});

/* ------------------------------------------------------------------ T-OP-108: shared.token from chain */

/**
 * T-OP-108. `shared.token` and its v4 PoolKey were all-null in both registries and `DeployV2Batch.sh:354-358`
 * refused the broadcast on them. The values are DERIVED from chain 4663 (endpoint and block in the ledger),
 * never typed from a document: the Pons hook's `launches(poolId)` names the token, the pool's `Initialize`
 * log gives all five key fields, and `keccak256(abi.encode(key))` is re-asserted here through the repo's own
 * `cast` path (`poolIdIssues`). These pins hold both registries to that derivation.
 */
const execFileP = promisify(execFile);
const STRICT_EIP55 = /^0x[0-9a-fA-F]{40}$/;
// viem isAddress(a, { strict: true }) without the dependency: well-formed, and either all-lowercase or equal to
// the EIP-55 form `cast to-check-sum-address` prints (the same rule ops/recon/r13-probe.mjs guards with).
async function assertStrictEip55(label, a) {
  assert.match(String(a), STRICT_EIP55, `${label} is not a 20-byte hex address`);
  if (a === a.toLowerCase()) return;
  const { stdout } = await execFileP("cast", ["to-check-sum-address", a.toLowerCase()]);
  assert.equal(a, stdout.trim(), `${label} is mixed-case but not its EIP-55 form`);
}
// The launch hook the recon pins (callhouse-contracts docs/V2-FLYWHEEL-ROUTE-SPIKE.md, re-read from the pool's
// Initialize log at block 64,068,924 for this row). A registry naming any other hook names another pool.
const PONS_LAUNCH_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

for (const file of REGISTRIES) {
  test(`T-OP-108: ${file} shared.token is complete, EIP-55 strict, currency0 is native ETH, hooks is the launch hook`, async () => {
    const t = read(file).shared.token;
    for (const k of ["address", "symbol", "decimals", "poolKey", "poolId"]) assert.notEqual(t[k], null, `shared.token.${k} is null`);
    for (const k of ["currency0", "currency1", "fee", "tickSpacing", "hooks"]) assert.notEqual(t.poolKey[k], null, `shared.token.poolKey.${k} is null`);
    assert.equal(t.symbol, "STONKHOUSE");
    assert.equal(t.decimals, 18);
    await assertStrictEip55("shared.token.address", t.address);
    await assertStrictEip55("shared.token.poolKey.currency1", t.poolKey.currency1);
    await assertStrictEip55("shared.token.poolKey.hooks", t.poolKey.hooks);
    // The v4 leg spends native ETH: currency0 is the zero address EXACTLY (DeployV2Batch.sh refuses anything else).
    assert.equal(t.poolKey.currency0, "0x0000000000000000000000000000000000000000", "currency0 must be native ETH");
    assert.equal(t.poolKey.currency1, t.address, "currency1 is the token itself");
    assert.equal(t.poolKey.hooks, PONS_LAUNCH_HOOK, "hooks must be the Pons launch hook the recon names");
    assert.equal(t.poolKey.fee, 0, "the launch pool's static fee is 0 (its fee is the hook's)");
    assert.equal(t.poolKey.tickSpacing, 200);
    assert.match(t.poolId, /^0x[0-9a-f]{64}$/);
  });

  test(`T-OP-108: ${file} shared.token.poolId is keccak256(abi.encode(poolKey)) — recomputed, not copied`, async () => {
    const r = read(file);
    const issues = await poolIdIssues(r);
    assert.ok(!issues.some((i) => i.startsWith("shared.token.poolId")), issues.join("; "));
    // Positive control: the same checker MUST refuse an id that names a different pool.
    const wrong = read(file);
    wrong.shared.token.poolId = `0x${"ab".repeat(32)}`;
    const refused = await poolIdIssues(wrong);
    assert.ok(refused.some((i) => i.startsWith("shared.token.poolId")), "the keccak check cannot see its subject");
  });
}

test("T-OP-108: both registries pin the SAME token and pool (the dev deploy path reads dev.json)", () => {
  const a = read("tier1.json").shared.token;
  const b = read("dev.json").shared.token;
  assert.deepEqual(b, a);
});

test("T-OP-108: v2-sources.json carries contracts.weth, contracts.usdgWethV3Pool and contracts.verifierProxy for DeployV2Batch.sh:314/354", async () => {
  const sources = read("v2-sources.json");
  for (const k of ["weth", "usdgWethV3Pool", "verifierProxy"]) {
    const c = sources.contracts[k];
    assert.ok(c && typeof c.address === "string", `contracts.${k}.address is missing`);
    assert.equal(c.codeExists, true, `contracts.${k} has no code on 4663`);
    await assertStrictEip55(`contracts.${k}.address`, c.address);
  }
  // The recon must agree with the contracts fixture T-OP-038 copied from the spike doc, or one of them is wrong.
  assert.equal(sources.contracts.weth.address, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "WETH: SwapRouter02.WETH9()");
  assert.equal(sources.contracts.usdgWethV3Pool.address, "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca", "factory.getPool(USDG, WETH, 100)");
});

/**
 * T-OP-108 criterion 8. `validateDevIsolation` claimed `shared.token.address` as production's own, so the
 * moment production pinned the real STONKHOUSE (this row) a dev registry naming the SAME token was refused
 * — and the dev deploy path reads that token from dev.json. The token is a fact of chain 4663 like
 * `shared.usdg`, not a wallet we run. Two-sided: the token is accepted, and the rule still refuses what it
 * is for (a production wallet copied into dev), and the acceptance is about the SLOT, not the value.
 */
test("T-OP-108: dev.json may carry production's STONKHOUSE token, while a production WALLET in dev.json is still refused", () => {
  const production = deployed();
  const token = read("tier1.json").shared.token;
  assert.match(String(token.address), STRICT_EIP55, "the committed token is an address (precondition)");
  production.shared.token = token;

  // Side one: the same token in dev.json is not an isolation defect.
  const dev = read("dev.json");
  dev.shared.token = token;
  const accepted = [];
  validateDevIsolation(dev, production, accepted);
  assert.deepEqual(accepted, [], "the chain's token was refused as if it were ours");

  // Side two: the rule survives for what it is for. A production wallet copied into dev is refused...
  for (const [what, mutate] of [
    ["shared.guardian", (d) => { d.shared.guardian = production.shared.guardian; d.v2.bots.guardian = production.shared.guardian; }],
    ["shared.opsWallet", (d) => { d.shared.opsWallet = production.shared.opsWallet; }],
    ["v2.contracts.clearinghouse", (d) => { d.v2.contracts.clearinghouse = production.v2.contracts.clearinghouse; }],
  ]) {
    const copied = read("dev.json");
    copied.shared.token = token;
    mutate(copied);
    const refused = [];
    validateDevIsolation(copied, production, refused);
    assert.ok(refused.some((i) => i.includes("may not name a production")), `dev.json may name production's ${what}: ${refused.join("; ") || "(no issues)"}`);
  }
  // ...and the token's VALUE is not what earned the acceptance: the same address in a wallet slot on
  // both sides is refused, so the exemption is the token slot and nothing wider.
  const walletProd = deployed();
  walletProd.shared.opsWallet = token.address;
  const walletDev = read("dev.json");
  walletDev.shared.opsWallet = token.address;
  const control = [];
  validateDevIsolation(walletDev, walletProd, control);
  assert.ok(control.some((i) => i.includes("shared.opsWallet") && i.includes("may not name a production")), `the token address in a wallet slot was accepted: ${control.join("; ") || "(no issues)"}`);
});

test("T-OP-108: tier1.json bot keys and shared.guardian are set, EIP-55 strict, one principal per role, and guardian is the GUARDIAN holder", async () => {
  // Operator amendment M-923273dedb0341e3 / coordinator M-979553214fb142ed (owner-questions item 18, VERIFIED):
  // cranker, pricer and quoter are the owner's derived keys (ops/v2/derive-bot-keys.sh, 2026-09-21T14:25Z,
  // indexes 60-62), read from the key-file comment lines by the operator — never derived here (the script reads
  // the mnemonic). The guardian was index 63 until T-OP-160 replaced it with the owner's hot-wallet index 2 (the
  // test below pins the bytes). DeployV2Batch.sh:667 exports V2_GUARDIAN from shared.guardian and V2DeployBase.sol:234
  // maps it to `v2.bots.guardian: GUARDIAN`, so the two slots MUST be the same principal. DeployV8._principals
  // requires the principals to be distinct. The Safes, admin and ops wallet are T-OP-111's and not judged here.
  const r = read("tier1.json");
  const bots = r.v2.bots;
  for (const k of ["cranker", "pricer", "quoter", "guardian"]) {
    assert.notEqual(bots[k], null, `v2.bots.${k} is null`);
    await assertStrictEip55(`v2.bots.${k}`, bots[k]);
  }
  assert.equal(new Set(Object.values(bots).map((a) => a.toLowerCase())).size, 4, "the four bot keys must be distinct");
  assert.equal(r.shared.guardian, bots.guardian, "shared.guardian (V2_GUARDIAN) is the GUARDIAN-role holder, v2.bots.guardian");
  for (const k of ["guardian", "cranker", "pricer", "quoter"]) {
    assert.equal(r.v2.protocolAddresses[k], bots[k], `v2.protocolAddresses.${k} mirrors v2.bots.${k}`);
  }
  // A bot key is a wallet WE run, so unlike the token it stays claimed by the dev-isolation rule.
  const dev = read("dev.json");
  dev.v2.bots.cranker = bots.cranker;
  const issues = [];
  validateDevIsolation(dev, r, issues);
  assert.ok(issues.some((i) => i.includes("v2.bots.cranker") && i.includes("may not name a production")), issues.join("; "));
});

/*
 * T-OP-160: the GUARDIAN holder is the owner's hot-wallet index 2, written byte-for-byte as ruled.
 *
 * Owner ruling 2026-09-22 06:12Z (Bridge M-0cebd9aff05944b4). The owner's first pick, the index-0 wallet
 * 0xEb82c3D0...9d9b, is the v8 DEPLOYER and `DeployV8._principals` refuses guardian == deployer, so the
 * ruling moved to the v7 dev-launch guardian every v1 row already names as `deployment.guardian`. The address
 * is a typed input nobody re-derives, so the pin is the literal string and the EIP-55 form is re-asserted
 * through `cast` rather than trusted. It replaces the derived index-63 key in `shared.guardian` and, because
 * the validator forces them equal (`v2.bots.guardian` in `validateV2Bots`, `v2.protocolAddresses.guardian`
 * via V2_PROTOCOL_TWINS), in both mirrors. `dev.json` is NOT touched: `validateDevIsolation` claims
 * production's `shared.guardian` (and, separately, every v1 row's `deployment.guardian`, which this wallet
 * also is), so a dev registry naming it is refused by name -- the T-OP-111 shape for the Safes. The devnet
 * keeps anvil #1.
 */
const OWNER_GUARDIAN = "0x29741A8d283a253E8Ce10aDfd04C6507438b6F39";
/** The v8 deployer (owner hot-wallet index 0, the v7 admin). Not a registry field; pinned here only to be refused. */
const V8_DEPLOYER = "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b";

test("T-OP-160: tier1.json shared.guardian is the ruled wallet, byte-for-byte, EIP-55 via cast, and both mirrors agree", async () => {
  const r = read("tier1.json");
  assert.equal(r.shared.guardian, OWNER_GUARDIAN, "shared.guardian is not the ruled wallet as typed");
  await assertStrictEip55("shared.guardian", r.shared.guardian);
  assert.notEqual(r.shared.guardian, r.shared.guardian.toLowerCase(), "shared.guardian must be written in its EIP-55 form, not lowercase");
  assert.equal(r.v2.bots.guardian, OWNER_GUARDIAN, "v2.bots.guardian is the same key written twice (validateV2Bots)");
  assert.equal(r.v2.protocolAddresses.guardian, OWNER_GUARDIAN, "v2.protocolAddresses.guardian mirrors shared.guardian (V2_PROTOCOL_TWINS)");
  // The ruled wallet is the v7 per-market guardian, which every v1 row still names. A fact of the registry,
  // not a rule; pinned so that a rebuild which silently rewrote those rows would be seen here.
  for (const m of r.markets) {
    if (m.deployment?.guardian !== undefined && m.deployment.guardian !== null) {
      assert.equal(m.deployment.guardian, OWNER_GUARDIAN, `${m.ticker} deployment.guardian is not the ruled wallet`);
    }
  }
  // The one collision the registry cannot see: DeployV8._principals refuses guardian == deployer, and the
  // deployer is an env input (DEPLOYER_PK), not a registry field. The withdrawn first choice was exactly this.
  assert.notEqual(r.shared.guardian.toLowerCase(), V8_DEPLOYER.toLowerCase(), "the guardian is the v8 deployer (DeployV8._principals refuses it)");
  // Not a Safe, not a Safe owner, not the ops wallet, not a bot. The T-OP-111 distinct-principals test above
  // covers the registry's own slots; these name the three the ruling was checked against.
  assert.notEqual(r.shared.guardian.toLowerCase(), r.shared.safes.admin.toLowerCase(), "the guardian is the Admin Safe");
  assert.notEqual(r.shared.guardian.toLowerCase(), r.shared.safes.treasury.toLowerCase(), "the guardian is the Treasury Safe");
  assert.notEqual(r.shared.guardian.toLowerCase(), r.shared.opsWallet.toLowerCase(), "the guardian is the ops wallet");
  for (const k of ["cranker", "pricer", "quoter"]) {
    assert.notEqual(r.shared.guardian.toLowerCase(), r.v2.bots[k].toLowerCase(), `the guardian is v2.bots.${k}`);
  }
});

test("T-OP-160: dev.json keeps its anvil guardian — the ruled wallet never enters the dev registry", () => {
  const dev = read("dev.json");
  const prod = read("tier1.json");
  assert.notEqual(dev.shared.guardian.toLowerCase(), OWNER_GUARDIAN.toLowerCase(), "dev shared.guardian is the ruled wallet");
  assert.notEqual(dev.shared.guardian.toLowerCase(), prod.shared.guardian.toLowerCase(), "dev shared.guardian is the production guardian");
  assert.equal(dev.v2.bots.guardian, dev.shared.guardian, "dev v2.bots.guardian is its own shared.guardian");
  // Positive control: the committed dev.json passes isolation, and a copy carrying the ruled wallet in
  // shared.guardian is refused BY THAT NAME (the shared.* claim runs before the v1 deployment.guardian claim,
  // so the label is shared.guardian, not '<ticker> deployment.guardian').
  const clean = [];
  validateDevIsolation(dev, prod, clean);
  assert.deepEqual(clean, [], `committed dev.json fails isolation: ${clean.join("; ")}`);
  const copy = structuredClone(dev);
  copy.shared.guardian = OWNER_GUARDIAN;
  copy.v2.bots.guardian = OWNER_GUARDIAN;
  copy.v2.protocolAddresses.guardian = OWNER_GUARDIAN;
  const issues = [];
  validateDevIsolation(copy, prod, issues);
  assert.ok(
    issues.some((i) => i.startsWith("shared.guardian ") && i.includes("is the production registry's shared.guardian")),
    `the ruled wallet in dev shared.guardian was accepted: ${issues.join("; ") || "(no issues)"}`,
  );
});

/*
 * T-OP-131: the three Uniswap v3 periphery addresses are EIP-55 at the source and in every copy.
 *
 * They were lowercase from the first build and every case-insensitive reader was happy; the strict
 * readers were not (viem isAddress strict, this file's own EIP-55 rule, the contracts preflight
 * script/v2/check-deploy-inputs.sh that gates the broadcast). The case is a function of the bytes, so the
 * pin is `cast to-check-sum-address` over the lowercase form, not a string typed here; and the validator
 * is watched refusing a lowercase copy by name, because a `--check` that cannot see its subject is the
 * defect class this ledger exists to record.
 */
const UNISWAP_V3_KEYS = ["factory", "swapRouter02", "quoterV2"];

test("T-OP-131: V2_SKELETON.uniswapV3 is EIP-55 strict, mixed-case, and equal to its own cast checksum", async () => {
  assert.deepEqual(Object.keys(V2_SKELETON.uniswapV3), UNISWAP_V3_KEYS);
  for (const k of UNISWAP_V3_KEYS) {
    const a = V2_SKELETON.uniswapV3[k];
    assert.notEqual(a, a.toLowerCase(), `V2_SKELETON.uniswapV3.${k} is lowercase: the strict readers refuse it`);
    await assertStrictEip55(`V2_SKELETON.uniswapV3.${k}`, a);
  }
});

for (const file of REGISTRIES) {
  test(`T-OP-131: ${file} v2.uniswapV3 carries the builder's EIP-55 strings exactly and the recon agrees by value`, async () => {
    const u = read(file).v2.uniswapV3;
    assert.deepEqual(Object.keys(u), UNISWAP_V3_KEYS);
    const reconNames = { factory: "factory", swapRouter02: "router", quoterV2: "quoter" };
    for (const k of UNISWAP_V3_KEYS) {
      assert.equal(u[k], V2_SKELETON.uniswapV3[k], `${file} v2.uniswapV3.${k} differs from the builder's pinned string`);
      await assertStrictEip55(`${file} v2.uniswapV3.${k}`, u[k]);
      // The recon is the probe's output and is checksummed by the probe's own guard; same bytes, same string.
      assert.equal(RECON.contracts[reconNames[k]].address, u[k], `v2-sources.json contracts.${reconNames[k]} is not the same string`);
      assert.equal(RECON.contracts[reconNames[k]].codeExists, true);
    }
  });

  test(`T-OP-131: ${file} --check refuses a right-bytes wrong-case v2.uniswapV3 copy by name and names the string to set`, () => {
    const r = read(file);
    const production = file === "dev.json" ? read("tier1.json") : null;
    assert.deepEqual(validateV2(r, RECON, production).filter((i) => i.startsWith("v2.uniswapV3")), []);
    for (const k of UNISWAP_V3_KEYS) {
      const want = V2_SKELETON.uniswapV3[k];
      // (1a) all-lowercase: the shape every lowercase comparison accepts and every strict reader refuses.
      const lower = read(file);
      lower.v2.uniswapV3[k] = want.toLowerCase();
      let issues = validateV2(lower, RECON, production).filter((i) => i.startsWith(`v2.uniswapV3.${k}`));
      assert.equal(issues.length, 1, `lowercase v2.uniswapV3.${k} was not refused exactly once: ${issues.join("; ")}`);
      assert.ok(issues[0].includes("right address in the wrong case"), issues[0]);
      assert.ok(issues[0].includes(want), "the refusal must name the exact string to set");
      // (1b) ONE hex letter in the wrong case: a corrupted checksum, which `cast to-check-sum-address` and viem's
      // getAddress would silently normalise (both NORMALISE, neither validates) -- so the rule must not either.
      const i = [...want].findIndex((c, idx) => idx >= 2 && /[a-f]/i.test(c));
      const flipped = want.slice(0, i) + (want[i] === want[i].toLowerCase() ? want[i].toUpperCase() : want[i].toLowerCase()) + want.slice(i + 1);
      assert.notEqual(flipped, want);
      assert.equal(flipped.toLowerCase(), want.toLowerCase());
      const corrupt = read(file);
      corrupt.v2.uniswapV3[k] = flipped;
      issues = validateV2(corrupt, RECON, production).filter((i) => i.startsWith(`v2.uniswapV3.${k}`));
      assert.equal(issues.length, 1, `one-letter mis-case of v2.uniswapV3.${k} was not refused exactly once: ${issues.join("; ")}`);
      assert.ok(issues[0].includes("right address in the wrong case") && issues[0].includes(want), issues[0]);
    }
  });

  test(`T-OP-131: ${file} --check refuses a DIFFERENT checksummed v2.uniswapV3 address by name against the skeleton, not as a case fault`, () => {
    const production = file === "dev.json" ? read("tier1.json") : null;
    for (const k of UNISWAP_V3_KEYS) {
      // A real, checksummed, code-bearing address that is not this key's: the neighbouring key's string. The
      // recon by-value check fires too (different bytes); the skeleton refusal must be there in its own words,
      // and the case refusal must NOT be, or a wrong address would be reported as a typo in its capitalisation.
      const other = UNISWAP_V3_KEYS.find((o) => o !== k);
      const swapped = read(file);
      swapped.v2.uniswapV3[k] = V2_SKELETON.uniswapV3[other];
      const issues = validateV2(swapped, RECON, production).filter((i) => i.startsWith(`v2.uniswapV3.${k}`));
      assert.ok(issues.some((i) => i.includes("V2_SKELETON.uniswapV3 pins") && i.includes(V2_SKELETON.uniswapV3[k])), `skeleton mismatch not named: ${issues.join("; ")}`);
      assert.ok(!issues.some((i) => i.includes("wrong case")), `a different address must not be called a case fault: ${issues.join("; ")}`);
    }
  });
}

/*
 * T-OP-156: `markets[].v2.houseVault`, the per-ticker HouseVault the broadcast's externals stage writes back
 * (owner ruling 2026-09-22: two vaults at launch, NVDA + SPCX; `v2.contracts.houseVault` stays the first launch
 * ticker's, the one VerifyV8 walks). The key is REQUIRED on every row (exactKeys is symmetric), null until the
 * write-back and null for ever outside the launch set. One address rule for the case: the same `cast` check as
 * shared.* and v2.bots, via checksumMarketHouseVaults, run by --check and exported here for a positive control.
 */
const HOUSE_VAULT_A = "0x6f8A7B77b72511cD8939596b1659bA28C28f101B"; // any checksummed address will do: the Admin Safe's string
const HOUSE_VAULT_B = "0x014b996a084690FB27265BfAC157b04e9FeBbF4E";
const withHouseVault = (r, ticker, value) => ({
  ...r,
  markets: r.markets.map((m) => (m.ticker === ticker ? { ...m, v2: { ...m.v2, houseVault: value } } : m)),
});
const houseVaultIssues = (r, ticker, production = null) =>
  validateV2(r, RECON, production).filter((i) => i.startsWith(`${ticker}: v2.houseVault`));

test("T-OP-156: the market skeleton and every committed row carry v2.houseVault: null, between overrides and registeredAt", () => {
  const fresh = firstSeen(read("tier1.json"));
  assert.ok(Object.hasOwn(fresh.v2, "houseVault"), "the skeleton names the key");
  assert.equal(fresh.v2.houseVault, null, "null until a vault is written back");
  const keys = Object.keys(fresh.v2);
  assert.equal(keys[keys.indexOf("houseVault") - 1], "overrides");
  assert.equal(keys[keys.indexOf("houseVault") + 1], "registeredAt");
  for (const file of REGISTRIES) {
    const r = read(file);
    assert.equal(r.markets.length, 35, `${file}: the 35 rows this row re-keyed`);
    for (const m of r.markets) {
      assert.ok(Object.hasOwn(m.v2, "houseVault"), `${file} ${m.ticker}: v2.houseVault is a required key`);
      assert.equal(m.v2.houseVault, null, `${file} ${m.ticker}: no vault is deployed yet`);
      const k = Object.keys(m.v2);
      assert.equal(k[k.indexOf("houseVault") + 1], "registeredAt", `${file} ${m.ticker}: the key sits where the skeleton puts it, so a rebuild writes the same order`);
    }
    // A row without the key is refused by name: the written-back registry must carry it (the T-OP-114 shape).
    const missing = { ...r, markets: r.markets.map((m, i) => (i === 0 ? { ...m, v2: Object.fromEntries(Object.entries(m.v2).filter(([k]) => k !== "houseVault")) } : m)) };
    const issues = validateV2(missing, RECON, file === "dev.json" ? r : null).filter((i) => i.includes("houseVault"));
    assert.ok(issues.length >= 1, `${file}: a row missing v2.houseVault is refused: ${issues.join("; ")}`);
  }
});

test("T-OP-156: V2_MARKET_KEYS is exported with houseVault in it, so gen-markets.mjs can close the block from THIS list", () => {
  // web/scripts/gen-markets.mjs imports this constant (T-OP-138 shape); its own twelve-name copy threw on the
  // thirteenth key. The position is pinned too: the skeleton, both registries and the generated TS carry the
  // key in this order, so a rebuild writes the same bytes.
  assert.ok(Array.isArray(V2_MARKET_KEYS) && V2_MARKET_KEYS.includes("houseVault"));
  assert.deepEqual(V2_MARKET_KEYS.slice(-3), ["houseVault", "registeredAt", "registerTx"]);
  assert.equal(new Set(V2_MARKET_KEYS).size, V2_MARKET_KEYS.length, "no duplicate name");
});

test("T-OP-156: the zero address is refused by name -- DeployHouseVault's 'not created yet' value is null here, never 0x0", async () => {
  const r = read("tier1.json");
  const ZERO = `0x${"0".repeat(40)}`;
  for (const ticker of [r.launchSet.markets[0], "TSLA"]) {
    const issues = houseVaultIssues(withHouseVault(r, ticker, ZERO), ticker);
    assert.ok(issues.some((i) => i.includes("is the zero address") && i.includes("never as 0x0")), `${ticker}: ${issues.join("; ")}`);
  }
  // Positive control on the shape of the value: zero IS an address and IS its own checksum, so without this rule
  // it would pass both the shape check and the cast rule -- which is why the rule exists.
  assert.deepEqual(houseVaultIssues(withHouseVault(r, "NVDA", ZERO), "NVDA").filter((i) => i.includes("must be null or an address")), []);
  assert.deepEqual(await checksumMarketHouseVaults(withHouseVault(r, "NVDA", ZERO)), []);
});

test("T-OP-156: a checksummed vault on a launch-set market passes; on a market outside the launch set it is refused by name", () => {
  const r = read("tier1.json");
  assert.deepEqual(r.launchSet.markets, ["NVDA", "SPCX"], "the owner's launch set, the rule's input");
  for (const ticker of r.launchSet.markets) {
    assert.deepEqual(houseVaultIssues(withHouseVault(r, ticker, HOUSE_VAULT_A), ticker), [], `${ticker}: a launched market may carry a vault`);
  }
  const outside = r.markets.find((m) => !r.launchSet.markets.includes(m.ticker)).ticker;
  const refused = houseVaultIssues(withHouseVault(r, outside, HOUSE_VAULT_A), outside);
  assert.equal(refused.length, 1, `${outside}: exactly one refusal: ${refused.join("; ")}`);
  assert.ok(refused[0].includes("not in launchSet.markets") && refused[0].includes("NVDA, SPCX"), refused[0]);
  // Shape: a non-address is refused offline, on any market.
  const bad = houseVaultIssues(withHouseVault(r, "NVDA", "0xnot-an-address"), "NVDA");
  assert.ok(bad.some((i) => i.includes("must be null or an address")), bad.join("; "));
  // No launch set (a dev registry judged on its own): any market may carry one. dev.json has no launchSet.
  const dev = read("dev.json");
  assert.ok(!("launchSet" in dev), "dev.json carries no launch set");
  assert.deepEqual(houseVaultIssues(withHouseVault(dev, outside, HOUSE_VAULT_A), outside, r), [], "without a launch set the rule does not apply");
});

test("T-OP-156: the first launch ticker's vault must be the one v2.contracts.houseVault names; the second ticker's need not", () => {
  const r = read("tier1.json");
  const [first, second] = r.launchSet.markets;
  const both = (ticker, marketValue, walked) => withHouseVault({ ...r, v2: { ...r.v2, contracts: { ...r.v2.contracts, houseVault: walked } } }, ticker, marketValue);
  assert.deepEqual(houseVaultIssues(both(first, HOUSE_VAULT_A, HOUSE_VAULT_A), first), [], "same address in both slots");
  assert.deepEqual(houseVaultIssues(both(first, HOUSE_VAULT_A, null), first), [], "the walked slot not yet written: fine");
  assert.deepEqual(houseVaultIssues(both(first, null, HOUSE_VAULT_A), first), [], "the market slot not yet written: fine");
  const clash = houseVaultIssues(both(first, HOUSE_VAULT_A, HOUSE_VAULT_B), first);
  assert.equal(clash.length, 1, clash.join("; "));
  assert.ok(clash[0].includes("is not v2.contracts.houseVault") && clash[0].includes("option A"), clash[0]);
  // The second launch ticker has its own vault, which is NOT the walked one, and that is the point of the row.
  assert.deepEqual(houseVaultIssues(both(second, HOUSE_VAULT_B, HOUSE_VAULT_A), second), [], "the second vault differs from the walked one by design");
});

test("T-OP-156: --check's cast rule refuses a lowercase vault by name and accepts the EIP-55 form (positive control on the checker)", async () => {
  const r = read("tier1.json");
  assert.deepEqual(await checksumMarketHouseVaults(r), [], "the committed registry (all null) has nothing to check");
  assert.deepEqual(await checksumMarketHouseVaults(withHouseVault(r, "NVDA", HOUSE_VAULT_A)), [], "a checksummed address passes");
  await assertStrictEip55("HOUSE_VAULT_A", HOUSE_VAULT_A);
  const lower = await checksumMarketHouseVaults(withHouseVault(r, "NVDA", HOUSE_VAULT_A.toLowerCase()));
  assert.equal(lower.length, 1, lower.join("; "));
  assert.ok(lower[0].startsWith("NVDA: v2.houseVault") && lower[0].includes("is not checksummed") && lower[0].includes(HOUSE_VAULT_A), lower[0]);
  // The offline validator does not judge case (it cannot without cast): a lowercase address is shape-valid there,
  // which is why the cast rule is wired into --check and this test exists.
  assert.deepEqual(houseVaultIssues(withHouseVault(r, "NVDA", HOUSE_VAULT_A.toLowerCase()), "NVDA"), []);
});

test("T-OP-156: a rebuild carries v2.houseVault as written (the block is carried, never merged), so the key cannot vanish or be defaulted", () => {
  const r = read("tier1.json");
  const set = withHouseVault(r, "NVDA", HOUSE_VAULT_A);
  const prev = set.markets.find((m) => m.ticker === "NVDA");
  const rebuilt = assembleMarket(prev, { ...runFrom(prev, set), ticker: "NVDA" });
  assert.equal(rebuilt.v2.houseVault, HOUSE_VAULT_A, "carried verbatim");
  assert.deepEqual(marketKeyIssues(prev, rebuilt), []);
});
