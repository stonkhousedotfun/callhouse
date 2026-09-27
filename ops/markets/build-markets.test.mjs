/**
 * The registry schema, INTERFACE_VERSION 8, and `v2.protocolAddresses`.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  isTickSpacing,
  routeCurrencies,
  V2_DEPLOYED_REQUIRED_PATHS,
  V2_PAYOUT_ROUTE_DELIBERATELY_NULL,
  V2_PAYOUT_ROUTE_PINS,
  pinPayoutRoute,
  routesPinnedByBuild,
  validatePayoutRoutePins,
  poolIdIssues,
  validateDeployedCompleteness,
  validateDevIsolation,
  validatePayoutRoute,
  SINGLE_SOURCE_AT_2026_09_21,
  validateLaunchSet,
  launchTickers,
  selectLaunchPairs,
  validateV2,
  validateV2Protocol,
  validateVaultLimits,
  EARN_FUNDING_KEY,
  validateNoEarnFunding,
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
  HOUSE_FACTORY_KINDS,
  launchFactoryKind,
  HOUSE_MARKET_KEYS,
  liquidityCheck,
  pinNotLiveIssues,
  V2_INTENDED_CHAINLINK_BANDS,
  CHAINLINK_NO_BAND,
  intendedChainlinkBand,
  pinChainlinkBand,
  validateChainlinkBands,
  MASSIVE_MAX_PAGES,
  massiveKey,
  modeFor,
  nextFridays,
  probeMassive,
} from "./build-markets.mjs";
import { depth } from "./route-liquidity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(path.join(HERE, file), "utf8"));
const REGISTRIES = ["tier1.json", "dev.json"];
const RECON = read("v2-sources.json");
/** Not in any registry, not checksummed (the offline validators judge shape, not checksum). */
const OTHER = "0x0000000000000000000000000000000000000abc";
const addr = (n) => `0x${String(n).padStart(40, "0")}`;

const clone = (file = "tier1.json") => read(file);

/**
 * The shipped registries carry the launch
 * set and nothing else. A test that needs another kind of market (a Chainlink-only row, a deliberately routeless one,
 * one outside the launch set) or just more rows appends a SYNTHETIC one here: SPCX's row re-tickered, with fresh
 * digit-only addresses (valid EIP-55 as written, and distinct from every real one), no pool, route, vault or
 * registration, and the 3600 s uncorroborated delay a Chainlink-only row must carry. It never reads a removed
 * production row. Its ticker comes from the builder's own recorded constants (SINGLE_SOURCE_AT_2026_09_21,
 * V2_PAYOUT_ROUTE_DELIBERATELY_NULL): a Chainlink-only row outside that set is refused as a NEW single-source
 * market, which is a different case from the one each test is about.
 */
function withSynthetic(r, ticker, n) {
  const row = structuredClone(r.markets.find((m) => m.ticker === "SPCX"));
  const a = (k) => addr(9_000_000 + n * 10 + k);
  Object.assign(row, { ticker, name: `${ticker} (synthetic)`, asset: a(1), assetSymbol: ticker, feed: a(2), feedSvr: a(3), feedAggregator: a(4) });
  row.v2 = { ...row.v2, status: "planned", univ3Pool: null, univ3MinLiquidity: null, dataStreamsFeedId: null, payoutRoute: null, houseVault: null, house: { weekly: null, daily: null }, registeredAt: null, registerTx: null, overrides: { uncorroboratedDelayS: 3600 } };
  // The band the builder writes for THIS ticker (`--pin-bands`), not SPCX's cloned one. A re-tickered row
  // that kept SPCX's band would be a row the builder never writes, refused by validateChainlinkBands for that reason.
  row.v2.chainlinkBand = intendedChainlinkBand(ticker);
  r.markets.push(row);
  return row;
}

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
  // The file's flywheel.config (the deploy knobs) stays; only the written-back addresses change.
  r.v2.flywheel = { ...r.v2.flywheel, feeSplitter: next(), buybackExecutor: next(), deployBlock: 69999999 };
  r.shared.admin = next();
  r.shared.guardian = next();
  r.shared.feeRecipient = r.v2.flywheel.feeSplitter; // the splitter IS the fee recipient (the flywheel design)
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

// An audit checked one suspicion against this test and it does not apply. The doubt was that a
// committed registry might already carry an unrelated v2 problem, so this assertion would go red for
// a reason nothing to do with the change that added `v2.protocolAddresses` — and its author could not
// run it to find out. Run on the tree that added it: 54 pass, 0 fail, this test
// among them. The control matters more than the pass: injecting one extra key into
// `tier1.json.v2.protocolAddresses` reds THIS test (6 fail), so it can fail and the green is
// load-bearing. Nothing was fixed, because nothing was broken.
//
// A second audit re-checked the SAME suspicion independently and concurred, with a DIFFERENT control: setting
// NVDA's `v2.wave` to `NOT_A_WAVE` reds this test with 8 failures naming `ops/markets/tier1.json has
// v2 problems` and the subject `NVDA: v2.wave`. Run on a later tree:
// 54 pass, 0 fail; restored, still 54. Two unrelated injections, two different failure counts, one
// conclusion — which is worth more than either control alone.
//
// Both audits exist because one suspicion was examined twice under different subjects: the first onto
// this test, which is what the doubt is actually about, and the second onto `ops/markets/tier1.json`,
// which the suspicion names only as the DATA this assertion reads. If you are about to open a third,
// the answer is already here.
/**
 * `ops/markets/tier1.json` is GENERATED: `build-markets.mjs` writes `waves: WAVES`
 * UNCONDITIONALLY (:1791), unlike the `v2` block one line below which IS preserved from the existing
 * file (`v2: existing && "v2" in existing ? existing.v2 : V2_SKELETON`, :1793). So a hand-edit to the
 * committed `waves` block does not survive the next builder run -- it is a change that expires with
 * no warning, and no gate runs the builder to catch it.
 *
 * An earlier change made exactly that edit and it landed and was pushed. This is the guard that would have
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

/* ------------------------------------------------------------------ the external keys */

/*
 * The six `v2.contracts` keys the deploy wrapper's EXTERNAL_KEYS reads (callhouse-contracts
 * script/v2/lib/registry-env.sh:413) and the externals step writes back — houseVault, houseVaultFactory,
 * hedger, rewardsDistributorLender, earnVault, stockVenueAdapter — were unknown to `exactKeys`, so the registry
 * the broadcast itself produces failed `--check`. They are now
 * ACCEPTED when present (null or an address) and never required. A later change
 * added a seventh, stockZap: DeployEarnVault.s.sol creates it beside the EarnVault and only the app reads it, so the
 * wrapper's EXTERNAL_KEYS stays six (pinned below against stonkhouse's Python port of it). The keys are in
 * both committed registries; the skeleton still does not carry them. `v2.externalDeployBlocks` (the start-block slots, one per
 * external) is the opposite — REQUIRED, in the skeleton and both registries, all null — because a new top-level
 * block breaks no consumer, and it is coupled: an external address with a null block is
 * refused. These cases pin both halves of that asymmetry, the 14-count, the required-when-deployed exemption,
 * the coupling and the dev-isolation reach.
 */
const EXTERNAL = ["houseVault", "houseVaultFactory", "hedger", "rewardsDistributorLender", "earnVault", "stockVenueAdapter", "stockZap"];
/**
 * What the launch wrote back into the SHIPPED tier1.json (dev.json is pre-broadcast
 * and keeps every external null). v9 mainnet launch 12:02 PM PT 2026-09-25, deployBlock 72462898, stonkctl run
 * 20260925T190245Z write-back: its second commit wrote these four addresses and their start blocks. The
 * houseVault is NVDA's (the first launch ticker's) daily vault; houseVaultFactory is the daily launch factory. Hedger,
 * the lender distributor and the stock venue adapter were not deployed at launch.
 */
const WRITTEN_BACK = {
  houseVault: "0xF9F95d999aA798fc0B60a0f85f7CCe251fe247a7",
  houseVaultFactory: "0x4626da1A3fCf06d837dBD49708C7B658DFD08843",
  hedger: null,
  rewardsDistributorLender: null,
  earnVault: "0x847794900FAE91516Cc3fbc36955C6B64a2dD609",
  stockVenueAdapter: null,
  stockZap: "0x0E3C7Ea59d89D6BE8bB6Af5706856C4E913a0FE7",
};
const WRITTEN_BACK_BLOCKS = { houseVault: 72467324, houseVaultFactory: 72467085, hedger: null, rewardsDistributorLender: null, earnVault: 72465317, stockVenueAdapter: null, stockZap: 72465317 };
const NONE_WRITTEN = Object.fromEntries(EXTERNAL.map((k) => [k, null]));
/** The shipped registry as it was before the externals write-back: the externals, their blocks and every House slot null. */
function preWriteBack(r) {
  for (const k of EXTERNAL) {
    r.v2.contracts[k] = null;
    r.v2.externalDeployBlocks[k] = null;
  }
  r.v2.house.factories = [];
  for (const m of r.markets) m.v2 = { ...m.v2, houseVault: null, house: { ...m.v2.house, weekly: null, daily: null } };
  return r;
}
/** `deployed()` plus the written-back externals: every external an address, every start block set. */
function deployedWithExternals() {
  const r = deployed();
  let n = 500;
  for (const k of EXTERNAL) r.v2.contracts[k] = addr((n += 1));
  r.v2.externalDeployBlocks = Object.fromEntries(EXTERNAL.map((k, i) => [k, 70000100 + i]));
  // The launch factory entry (daily on v9) IS v2.contracts.houseVaultFactory, and the first launch
  // ticker's vault (and its daily slot) IS v2.contracts.houseVault, so a write-back moves them together. On the
  // post-launch tier1.json the real pair sits in those slots, so a synthetic write-back that moved only the externals
  // is refused as split.
  r.v2.house.factories = [{ kind: "daily", address: r.v2.contracts.houseVaultFactory, deployBlock: r.v2.externalDeployBlocks.houseVaultFactory }];
  const first = r.markets.find((m) => m.ticker === r.launchSet.markets[0]);
  first.v2 = { ...first.v2, houseVault: r.v2.contracts.houseVault, house: { ...first.v2.house, daily: r.v2.contracts.houseVault } };
  return r;
}

test("The external set is the wrapper's six plus stockZap, the start-block keys mirror it, and none is required at deployBlock", () => {
  assert.deepEqual([...V2_EXTERNAL_CONTRACT_NAMES].sort(), [...EXTERNAL].sort());
  assert.deepEqual([...V2_EXTERNAL_DEPLOY_BLOCK_KEYS], [...V2_EXTERNAL_CONTRACT_NAMES]);
  // Not a recorded key: V2_CONTRACT_NAMES stays the eleven every 14-count mirror closes over.
  for (const k of EXTERNAL) assert.equal(V2_DEPLOYED_REQUIRED_PATHS.includes(`v2.contracts.${k}`), false, `${k} is required at deployBlock`);
});

test("stockZap is the one external the deploy wrapper does not read -- the wrapper's EXTERNAL_KEYS stays six", () => {
  // ops/stonkctl registry.py CONTRACTS is `(registry key, V2_* name, recorded)`; its unrecorded rows are EXTERNAL_KEYS,
  // the Python port of callhouse-contracts registry-env.sh EXTERNAL_KEYS. StockZap is not a
  // DeployV8 input, so neither list may grow a stockZap row just because the registry now carries the key.
  const py = readFileSync(path.join(HERE, "..", "stonkctl", "src", "stonkctl", "registry.py"), "utf8");
  const rows = [...py.matchAll(/^\s*\("([A-Za-z.]+)", "V2_[A-Z0-9_]+", (True|False)\),$/gm)];
  assert.ok(rows.length >= 20, `registry.py CONTRACTS table not found (${rows.length} rows): the pin below would be vacuous`);
  const wrapperExternals = rows.filter((m) => m[2] === "False").map((m) => m[1]);
  assert.deepEqual(wrapperExternals, V2_EXTERNAL_CONTRACT_NAMES.filter((k) => k !== "stockZap"));
  assert.equal(rows.some((m) => m[1] === "stockZap"), false, "stonkctl maps stockZap to a DeployV8 variable");
});

test("Both shipped registries carry the external ADDRESS keys, after accessManager and before sources; the skeleton still does not", () => {
  // The registries first shipped WITHOUT the six because render-docs.mjs and gen-markets.mjs closed the
  // key set; both generators were then widened, and the contracts preflight
  // (check-deploy-inputs.sh) then REFUSED the real tier1.json with five `missing-writeback-key
  // .v2.contracts.<external>` lines, because a write-back must never ADD a key. So this test inverts
  // the first assertion deliberately: the six pre-exist as null in both files, in V2_EXTERNAL_CONTRACT_NAMES
  // order, placed where callhouse-contracts' fixture twin (script/v2/fixtures/registry-v8.json) places
  // them. The skeleton is untouched: `assembleRegistry` carries `v2` verbatim (the rebuild test below), and a first
  // build from nothing is still the builder's concern, not this test's.
  for (const k of EXTERNAL) assert.equal(k in V2_SKELETON.contracts, false, `V2_SKELETON.contracts carries ${k}`);
  for (const file of REGISTRIES) {
    const keys = Object.keys(read(file).v2.contracts);
    // tier1.json has since been written back by the externals step (WRITTEN_BACK, derived above); dev.json
    // has not, and keeps every external present and null.
    const want = file === "tier1.json" ? WRITTEN_BACK : NONE_WRITTEN;
    for (const k of EXTERNAL) {
      assert.ok(k in read(file).v2.contracts, `${file}: v2.contracts.${k} must be present`);
      assert.equal(read(file).v2.contracts[k], want[k], `${file}: v2.contracts.${k}`);
    }
    const core = Object.keys(V2_SKELETON.contracts).filter((k) => k !== "sources"); // the eleven, in skeleton order
    assert.deepEqual(keys, [...core, ...EXTERNAL, "sources"], `${file}: v2.contracts key order`);
  }
});

test("externalDeployBlocks IS in the skeleton and both shipped registries, one slot per external", () => {
  assert.deepEqual(V2_SKELETON.externalDeployBlocks, NONE_WRITTEN);
  // Null until the externals step writes a block beside its address; tier1.json has been written back.
  assert.deepEqual(read("dev.json").v2.externalDeployBlocks, NONE_WRITTEN, "dev.json");
  assert.deepEqual(read("tier1.json").v2.externalDeployBlocks, WRITTEN_BACK_BLOCKS, "tier1.json");
  // Dropping it is refused like any other block: the top level is exact, no optional keys.
  const gone = allIssuesFor((r) => { delete r.v2.externalDeployBlocks; });
  assert.ok(gone.some((i) => i.includes("v2.externalDeployBlocks is missing")), gone.join(" | "));
});

test("The written-back shape passes — every external an address on a deployed registry, with its start block", () => {
  assert.deepEqual(validateV2(deployedWithExternals(), RECON, null), []);
});

test("Present as null they pass, absent they pass, and a deployed registry with them still null is green", () => {
  // Null on the pre-broadcast file. The shipped file is written back, so preWriteBack rebuilds that shape,
  // House slots included (a written-back vault with its launch factory nulled is not a state the launch produces).
  const r = preWriteBack(clone());
  for (const k of EXTERNAL) r.v2.contracts[k] = null;
  assert.deepEqual(validateV2(r, RECON, null), []);
  // Null with v2.deployBlock SET: the externals step runs after DeployV8, so this is a correct registry in the
  // middle of the launch sequence, and item 19 may leave two of them null for good.
  const d = preWriteBack(deployed());
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
  // The launch House factory entry (daily on v9) IS v2.contracts.houseVaultFactory, so a
  // write-back moves them together.
  some.v2.house.factories = [{ kind: "daily", address: OTHER, deployBlock: 70000200 }];
  assert.deepEqual(validateV2(some, RECON, null), []);
});

test("An external slot holding a non-address is refused by name", () => {
  for (const k of EXTERNAL) {
    const issues = allIssuesFor((r) => { r.v2.contracts[k] = "0xnot-an-address"; });
    assert.ok(issues.some((i) => i.includes(`v2.contracts.${k} must be null or an address`)), `${k}: ${issues.join(" | ")}`);
  }
});

test("A key that is neither recorded nor external is still refused — the block stays closed", () => {
  // stockZap used to be this case's refused example. It is an external now (accepted beside the other six,
  // asserted below), so the closed block is pinned with a name no list knows: an eighth name is refused as before.
  const issues = allIssuesFor((r) => {
    for (const k of EXTERNAL) r.v2.contracts[k] = null;
    r.v2.contracts.zapRouter = null;
  });
  assert.ok(issues.some((i) => /v2\.contracts\.zapRouter/.test(i) && /not a known key/.test(i)), issues.join(" | "));
  assert.equal(issues.filter((i) => /not a known key/.test(i)).length, 1, `only zapRouter should be unknown: ${issues.join(" | ")}`);
  assert.equal(issues.some((i) => /v2\.contracts\.stockZap\b/.test(i)), false, `stockZap is an external now: ${issues.join(" | ")}`);
  assert.ok(issues.some((i) => /not a known key \(.*\bstockZap\b.*\)/.test(i)), `the known-key list must name stockZap: ${issues.join(" | ")}`);
  // And a misspelt external is unknown, not silently accepted as the real one.
  const typo = allIssuesFor((r) => { r.v2.contracts.earnvault = OTHER; });
  assert.ok(typo.some((i) => /v2\.contracts\.earnvault/.test(i) && /not a known key/.test(i)), typo.join(" | "));
});

test("externalDeployBlocks is exact over the externals and each value is null or a block number", () => {
  // These cases judge the block shapes with no external address set (a block without its address is legal,
  // an address without its block is not). The shipped tier1.json is now written back, so each case starts from its
  // pre-write-back shape rather than inheriting three addresses the case did not set.
  const issuesOf = (mutate) => allIssuesFor((r) => {
    preWriteBack(r);
    mutate(r);
  });
  const all = (fill) => Object.fromEntries(EXTERNAL.map((k) => [k, fill(k)]));
  assert.deepEqual(issuesOf((r) => { r.v2.externalDeployBlocks = all(() => null); }), []);
  // A block without its address is allowed (a step may record where it started before it records what).
  assert.deepEqual(issuesOf((r) => { r.v2.externalDeployBlocks = all((k) => (k === "earnVault" ? 70000100 : null)); }), []);
  // A decimal string is a block number here exactly as it is for v2.deployBlock.
  assert.deepEqual(issuesOf((r) => { r.v2.externalDeployBlocks = all(() => "70000100"); }), []);
  const bad = issuesOf((r) => { r.v2.externalDeployBlocks = { ...all(() => null), earnVault: -1, houseVaultFactory: "soon", hedger: 0 }; });
  for (const k of ["earnVault", "houseVaultFactory", "hedger"]) {
    assert.ok(bad.some((i) => i.includes(`v2.externalDeployBlocks.${k} must be null or a positive block number`)), `${k}: ${bad.join(" | ")}`);
  }
  const missing = issuesOf((r) => { r.v2.externalDeployBlocks = { earnVault: null }; });
  for (const k of EXTERNAL.filter((k) => k !== "earnVault")) {
    assert.ok(missing.some((i) => i.includes(`v2.externalDeployBlocks.${k} is missing`)), `${k}: ${missing.join(" | ")}`);
  }
  const extra = issuesOf((r) => { r.v2.externalDeployBlocks = { ...all(() => null), zapRouter: null }; });
  assert.ok(extra.some((i) => /v2\.externalDeployBlocks\.zapRouter/.test(i) && /not a known key/.test(i)), extra.join(" | "));
  const notObj = issuesOf((r) => { r.v2.externalDeployBlocks = 5; });
  assert.ok(notObj.some((i) => i.includes("v2.externalDeployBlocks must be an object")), notObj.join(" | "));
  // The top level is still closed: a misspelt block is unknown, not ignored.
  const typo = issuesOf((r) => { r.v2.externalDeployBlock = {}; });
  assert.ok(typo.some((i) => /v2\.externalDeployBlock\b/.test(i) && /not a known key/.test(i)), typo.join(" | "));
});

test("An external ADDRESS with its start block still null is refused by name — the two are written back together", () => {
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

test("A production external copied into a _dev registry is refused, and a different address is not", () => {
  // The claim/name loops in validateDevIsolation walk V2_CONTRACT_NAMES; before this fix a written-back
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

test("A rebuild of a shipped registry still carries v2 verbatim and loses no root key (guard unchanged)", () => {
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
  // INTERFACE_VERSION 8: accessManager joins, payoutAdapter stays and now names the PayoutRouter.
  // 11 named slots plus 3 sources = the 14 addresses the deploy tooling counts.
  assert.ok("accessManager" in v2.contracts, "v2.contracts has no accessManager");
  assert.equal("payoutAdapter" in v2.contracts, true, "payoutAdapter was renamed; every consumer reads that key");
  const addresses = Object.entries(v2.contracts).flatMap(([k, v]) => (k === "sources" ? Object.keys(v) : [k]));
  // The external keys are accepted by the validator but are NOT in the recorded count
  // the deploy tooling asserts (`V2_CONTRACT_NAMES` + sources = 14); they sit beside it in the
  // shipped registries. 14 recorded + 7 externals (stockZap is the seventh) = 21 entries. The
  // externals step has written the launch's three back, StockZap was added by hand (WRITTEN_BACK); the other
  // three were not deployed.
  const recorded = addresses.filter((k) => !V2_EXTERNAL_CONTRACT_NAMES.includes(k));
  assert.equal(recorded.length, 14, `v2.contracts holds ${recorded.length} recorded addresses, not 14`);
  assert.equal(addresses.length, 21, `v2.contracts holds ${addresses.length} entries, not 14 recorded + 7 externals`);
  for (const k of V2_EXTERNAL_CONTRACT_NAMES) assert.equal(v2.contracts[k], WRITTEN_BACK[k], `v2.contracts.${k} in the shipped tier1.json`);
  // v8 bot keys: renamed and extended, and never v7's.
  assert.deepEqual(Object.keys(v2.bots).sort(), ["cranker", "guardian", "pricer", "quoter"]);
  // `config` joined the flywheel (its deploy knobs), and v2.earn / v2.keeper are new blocks.
  assert.deepEqual(Object.keys(v2.flywheel).sort(), ["buybackExecutor", "config", "deployBlock", "feeSplitter"]);
  assert.deepEqual(Object.keys(v2.flywheel.config).sort(), ["burnBps", "buybackCap", "buybackCapCeiling", "buybackCooldownS",
    "buybackMaxTotalFeeBps", "buybackMinLiquidity", "buybackSlippageBps", "buybackTwapWindowS", "conversionSlippageBps"]);
  // `limits` joined v2.earn (the EarnVault Limits) and v2.house (per launch ticker).
  assert.deepEqual(Object.keys(v2.earn), ["skimBps", "limits"]);
  assert.deepEqual(Object.keys(v2.house), ["factories", "limits"]);
  assert.deepEqual(Object.keys(v2.keeper).sort(), ["bountyCancelStale", "bountyFinalize", "bountyRedeem", "bountyRoll",
    "bountySettle", "bountySnapshot", "dailyCap", "maxBounty", "rewardsFund"]);
  // The externals' start blocks, one per external (values pinned by the externalDeployBlocks test).
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
    ["v2.externalDeployBlocks", (r) => { r.v2.externalDeployBlocks.zapRouter = null; }, "v2.externalDeployBlocks.zapRouter"],
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

/* ------------------------------------------------------------------ no v2.uniswapV4 */

// The v4 PoolManager and StateView are verified and written down in v2-sources.json `contracts.*`,
// which is what DeployV2Batch.sh reads. Nothing reads a `v2.uniswapV4` path (V2_SKELETON's note
// lists what was searched), the contracts docs that name one are stale, and adding it here would be
// a second copy of an address the recon holds AND a key dev.json would then be required to carry.
// These pin the decision so the block is neither added by hand nor grown back by a rebuild.
test("Neither registry nor the skeleton carries v2.uniswapV4; the v4 pair lives in the recon", () => {
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

test("A registry that grows v2.uniswapV4 is refused, and the refusal names the real home", () => {
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

  // And the flag itself is typed: a truthy string is not a decision.
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

/* ------------------------------------------ the post-broadcast completeness rule */

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
  // dataStreams is EXEMPT and that is the decision: the go-live script and its header both
  // say DataStreamsSource ships disabled and a null there is fine, so requiring it would turn
  // build-markets --check red on a correct launch night. A deliberate decision, after the conflict was raised.
  assert.ok(!paths.has("v2.contracts.sources.dataStreams"), "dataStreams must stay exempt while the source ships disabled");
  for (const k of ["v2.flywheel.feeSplitter", "v2.flywheel.buybackExecutor", "shared.safes.treasury"]) {
    assert.ok(paths.has(k), `${k} is not required when deployed`);
  }
  // The bot keys are made after the deploy, so requiring them here
  // would fire during a correct launch. Their absence is the decision, not an oversight.
  for (const k of ["cranker", "pricer", "quoter", "guardian"]) {
    assert.ok(!paths.has(`v2.bots.${k}`), `v2.bots.${k} must NOT be required when deployed`);
  }
  assert.ok(!paths.has("v2.flywheel.deployBlock"), "a block number is not an address slot");
});

test("post-broadcast, a launch market with no route must be a DELIBERATE null, not a forgotten one", () => {
  // v8's route decision left six launch markets routeless on purpose; before it, null meant "not written yet". To a
  // completeness check those look identical, so the six are named and everything else is a defect.
  const r = deployed();
  assert.deepEqual([...V2_PAYOUT_ROUTE_DELIBERATELY_NULL].sort(), ["AMD", "AMZN", "CRWV", "MU", "ORCL", "SNDK"]);
  // The registry no longer carries any of the six; a synthetic routeless MU stands in for the recorded case.
  withSynthetic(r, "MU", 1);

  const clean = [];
  validateDeployedCompleteness(r, clean);
  assert.deepEqual(clean, [], "the shipped routes and the six recorded nulls are complete");

  // A routed launch market silently losing its route is the forgotten case.
  const dropped = deployed();
  withSynthetic(dropped, "MU", 1);
  const victim = dropped.markets.find((m) => m.v2.wave === "wave1" && m.v2.payoutRoute !== null);
  victim.v2.payoutRoute = null;
  const issues = [];
  validateDeployedCompleteness(dropped, issues);
  assert.ok(issues.some((i) => i.startsWith(`${victim.ticker}: v2.payoutRoute is null but v2.deployBlock`)), issues.join("; "));

  // And the reverse: a route appearing on a market the document says is routeless.
  const surprise = deployed();
  withSynthetic(surprise, "MU", 1).v2.payoutRoute = { venue: "v3", fee: 3000 };
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

  // And the old rule alone still says nothing about it, which is why this test exists.
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

// v8's route decision pinned the launch routes, so "null everywhere" is no longer the state to assert. What must
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

test("payoutRoute: exactly the launch tickers carry a route in tier1.json", () => {
  // The other six launch tickers (MU SNDK AMD AMZN ORCL CRWV) are deliberately null - no eligible pool
  // cleared the depth, activity and deviation gates. The route recon recorded why, per ticker.
  // Of v8's routes only the launch set's remain, and both launch markets are routed.
  const tier1 = read("tier1.json");
  const routed = tier1.markets.filter((m) => m.v2.payoutRoute !== null).map((m) => m.ticker).sort();
  const present = new Set(tier1.markets.map((m) => m.ticker));
  assert.deepEqual(routed, O803_ROUTED.filter((t) => present.has(t)).sort());
  assert.deepEqual(routed, [...tier1.launchSet.markets].sort(), "every launch market carries its O8-03 route");
  // dev.json was routeless until the pinned v3 routes went into every registry the
  // builder reads; the devnet forks 4663, so it has the same pools. A dev market with no pin stays routeless.
  for (const m of read("dev.json").markets) {
    assert.deepEqual(m.v2.payoutRoute, V2_PAYOUT_ROUTE_PINS[m.ticker] ?? null, `dev.json ${m.ticker} route`);
  }
});

/* ------------------------------------------------------------------ pinned v3 fee-500 payout routes */

test("The pinned payout routes are exactly v3 fee 500 for NVDA and SPCX", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(V2_PAYOUT_ROUTE_PINS)),
    { NVDA: { venue: "v3", fee: 500 }, SPCX: { venue: "v3", fee: 500 } },
  );
  for (const t of Object.keys(V2_PAYOUT_ROUTE_PINS)) {
    assert.ok(!V2_PAYOUT_ROUTE_DELIBERATELY_NULL.includes(t), `${t} is both pinned and deliberately routeless`);
  }
});

test("dev.json routes NVDA and SPCX through v3 fee 500; tier1.json keeps the live router's routes until the redeploy", () => {
  // A registry that names a deployment records the LIVE router, and the pin
  // reaches it through the redeploy's `--pin-routes`. A registry that names none carries the pin now.
  assert.equal(routesPinnedByBuild(read("dev.json")), true, "dev.json names no deployment");
  assert.equal(routesPinnedByBuild(read("tier1.json")), false, "tier1.json names the live v8 deployment");
  for (const file of REGISTRIES) {
    const r = read(file);
    for (const t of ["NVDA", "SPCX"]) {
      const m = r.markets.find((x) => x.ticker === t);
      assert.ok(m, `${file} has no ${t}`);
      if (routesPinnedByBuild(r)) assert.deepEqual(m.v2.payoutRoute, { venue: "v3", fee: 500 }, `${file} ${t} payoutRoute`);
      // The pin resolves to factory.getPool(asset, USDG, 500); the source recon says that pool IS the settlement TWAP
      // pool, so the payout swaps through the same deep pool the oracle reads, not a separate one.
      const pool = RECON.markets.find((x) => x.ticker === t).pools.find((p) => Number(p.fee) === V2_PAYOUT_ROUTE_PINS[t].fee);
      assert.ok(pool, `the recon has no fee-${V2_PAYOUT_ROUTE_PINS[t].fee} pool for ${t}`);
      assert.equal(pool.address.toLowerCase(), m.v2.univ3Pool.toLowerCase(), `${file} ${t}: the pinned tier's pool is not v2.univ3Pool`);
    }
  }
});

test("The builder writes the pin over a hand-maintained v4 route and touches nothing else in v2", () => {
  const prev = clone().markets.find((m) => m.ticker === "NVDA");
  prev.v2.payoutRoute = { venue: "v4", fee: 375, tickSpacing: 4, poolId: `0x${"ab".repeat(32)}` };
  const built = pinPayoutRoute("NVDA", prev.v2);
  assert.deepEqual(built.payoutRoute, { venue: "v3", fee: 500 });
  assert.deepEqual({ ...built, payoutRoute: null }, { ...prev.v2, payoutRoute: null }, "another v2 field moved");
  assert.deepEqual(Object.keys(built), Object.keys(prev.v2), "the key order moved");
  assert.equal(prev.v2.payoutRoute.venue, "v4", "the previous block was mutated");
  // A ticker with no pin keeps whatever was written.
  const other = { ...prev.v2, payoutRoute: { venue: "v3", fee: 3000 } };
  assert.equal(pinPayoutRoute("MU", other), other);

  // Through assembleMarket, the per-market step of a full build. main passes pinRoutes: routesPinnedByBuild(existing),
  // so a build of a pre-deploy registry (dev.json) writes the pin.
  const run = {
    ticker: "NVDA", token: { name: prev.name, block: prev.assetDeployBlock }, asset: prev.asset,
    feed: { name: prev.feedName }, feedProxy: prev.feed, feedSvr: prev.feedSvr, feedAggregator: prev.feedAggregator,
    verification: prev.verification, cboe: prev.cboe, shared: clone().shared,
  };
  const market = assembleMarket(prev, { ...run, pinRoutes: true });
  assert.deepEqual(market.v2.payoutRoute, { venue: "v3", fee: 500 });
  // A build of a DEPLOYED registry passes pinRoutes: false and keeps the live route.
  const kept = assembleMarket(prev, { ...run, pinRoutes: false });
  assert.deepEqual(kept.v2.payoutRoute, prev.v2.payoutRoute);
  // Left out, the flag is off: v2 is carried as written (the carry rule), never pinned by accident on a
  // deployed registry; on a pre-deploy one validatePayoutRoutePins then fails --check instead.
  assert.deepEqual(assembleMarket(prev, run).v2, prev.v2);
});

test("--check refuses a pre-deploy registry whose launch route is not its pin, and leaves a deployed one to the live-route check", () => {
  const production = read("tier1.json");
  for (const route of [
    { venue: "v4", fee: 375, tickSpacing: 4, poolId: `0x${"ab".repeat(32)}` },
    { venue: "v3", fee: 3000 },
    null,
  ]) {
    const r = clone("dev.json");
    r.markets.find((m) => m.ticker === "SPCX").v2.payoutRoute = route;
    const issues = validateV2(r, RECON, production);
    assert.ok(
      issues.some((i) => i.startsWith("SPCX: v2.payoutRoute is") && i.includes("V2_PAYOUT_ROUTE_PINS")),
      `${JSON.stringify(route)} passed: ${issues.join("; ")}`,
    );
  }
  // A deployed registry with REGISTERED markets on non-pin routes (the v8 shape, rebuilt here because the shipped v9
  // tier1.json carries the pins): the pin rule says nothing (route-liquidity.mjs compares it with the live router).
  const live = clone("tier1.json");
  assert.equal(routesPinnedByBuild(live), false, "premise: a deployed registry");
  for (const t of Object.keys(V2_PAYOUT_ROUTE_PINS)) {
    const m = live.markets.find((x) => x.ticker === t);
    assert.notEqual(m.v2.registeredAt, null, `premise: ${t} is registered`);
    m.v2.payoutRoute = { venue: "v4", fee: 375, tickSpacing: 4, poolId: `0x${"ab".repeat(32)}` };
  }
  const pins = [];
  validatePayoutRoutePins(live, pins);
  assert.deepEqual(pins, []);
  // And the committed production registry (v9, on its pins) stays green.
  const shipped = [];
  validatePayoutRoutePins(read("tier1.json"), shipped);
  assert.deepEqual(shipped, []);
});

/*
 * The stonkctl launch writes the new deployment back BEFORE RegisterMarkets, so writeback's --check sees a
 * DEPLOYED registry whose launch markets are unregistered (the prepare step's unrecord nulls registeredAt/registerTx and sets
 * them planned). route-liquidity.mjs waives the router equality for them. The pin rule is what says, by
 * name, that the prepare step skipped --pin-routes, because RegisterMarkets would otherwise set the old v4 route on
 * the new router.
 */
test("At the v9 writeback (deployed, launch markets not yet registered) --check requires the pins by name; a registered market stays the chain's", () => {
  const writeback = clone("tier1.json"); // deployBlock stays set: the core write-back has recorded the deployment
  for (const t of Object.keys(V2_PAYOUT_ROUTE_PINS)) {
    const m = writeback.markets.find((x) => x.ticker === t);
    // The shipped v9 file carries the pins (its prepare step ran --pin-routes), so the skipped-pin case this test is
    // about is rebuilt: each launch market gets back a v4 route, the shape v8 shipped.
    Object.assign(m.v2, { registeredAt: null, registerTx: null, status: "planned", payoutRoute: { venue: "v4", fee: 375, tickSpacing: 4, poolId: `0x${"ab".repeat(32)}` } });
  }
  assert.equal(routesPinnedByBuild(writeback), false, "premise: a deployed registry, so the pre-deploy rule alone is silent");
  const unpinned = [];
  validatePayoutRoutePins(writeback, unpinned);
  assert.equal(unpinned.length, 2, unpinned.join("; "));
  for (const t of ["NVDA", "SPCX"]) {
    const line = unpinned.find((i) => i.startsWith(`${t}: v2.payoutRoute is {"venue":"v4"`));
    assert.ok(line, `${t} named: ${unpinned.join("; ")}`);
    assert.ok(line.includes("is not registered yet") && line.includes("--pin-routes") && line.includes("RegisterMarkets would set this route"), line);
  }
  assert.ok(validateV2(writeback, RECON, null).some((i) => i.startsWith("NVDA: v2.payoutRoute is") && i.includes("not registered yet")), "the whole validator refuses it");

  // The prepared registry the launch should have: pinned. Silent.
  const pinned = structuredClone(writeback);
  for (const m of pinned.markets) m.v2 = pinPayoutRoute(m.ticker, m.v2);
  const none = [];
  validatePayoutRoutePins(pinned, none);
  assert.deepEqual(none, []);

  // One market registered (RegisterMarkets ran for it): its route is the chain's business again, pinned or not.
  const half = structuredClone(writeback);
  Object.assign(half.markets.find((m) => m.ticker === "NVDA").v2, { registeredAt: 1790200000, registerTx: `0x${"12".repeat(32)}` });
  const halfIssues = [];
  validatePayoutRoutePins(half, halfIssues);
  assert.deepEqual(halfIssues.map((i) => i.split(":")[0]), ["SPCX"], halfIssues.join("; "));
});

test("`--pin-routes` writes only the payout routes, offline", async () => {
  const { mkdtempSync, writeFileSync: write, readFileSync: slurp } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "t-op-337-"));
  const before = clone();
  before.markets.find((m) => m.ticker === "NVDA").v2.payoutRoute = { venue: "v4", fee: 375, tickSpacing: 4, poolId: `0x${"ab".repeat(32)}` };
  before.markets.find((m) => m.ticker === "SPCX").v2.payoutRoute = null;
  const file = path.join(dir, "registry.json");
  write(file, JSON.stringify(before, null, 2) + "\n");
  // RH_RPC points nowhere: a network read would fail the run.
  const { stderr } = await promisify(execFile)(process.execPath, [path.join(HERE, "build-markets.mjs"), "--pin-routes", "--registry", file],
    { env: { ...process.env, RH_RPC: "http://127.0.0.1:1" } });
  const after = JSON.parse(slurp(file, "utf8"));
  for (const t of ["NVDA", "SPCX"]) assert.deepEqual(after.markets.find((m) => m.ticker === t).v2.payoutRoute, { venue: "v3", fee: 500 });
  const strip = (r) => ({ ...r, markets: r.markets.map((m) => ({ ...m, v2: { ...m.v2, payoutRoute: null } })) });
  assert.deepEqual(strip(after), strip(before), "--pin-routes moved a field other than payoutRoute");
  assert.match(stderr, /NVDA: payoutRoute .* -> \{"venue":"v3","fee":500\}/);
});

test("The intended Chainlink bands are the scale-fault doc's, a band setBand accepts, and in both registries", () => {
  // The scale-fault rule: NVDA [$20, $2,000], SPCX [$20, $1,000], USDG 6 dp.
  assert.deepEqual(JSON.parse(JSON.stringify(V2_INTENDED_CHAINLINK_BANDS)), {
    NVDA: { minPrice: "20000000", maxPrice: "2000000000" },
    SPCX: { minPrice: "20000000", maxPrice: "1000000000" },
  });
  for (const [t, b] of Object.entries(V2_INTENDED_CHAINLINK_BANDS)) {
    assert.ok(BigInt(b.minPrice) > 0n && BigInt(b.maxPrice) > BigInt(b.minPrice) && BigInt(b.maxPrice) < 1n << 128n, t);
  }
  assert.equal(CHAINLINK_NO_BAND, "none");
  assert.equal(intendedChainlinkBand("AMD"), CHAINLINK_NO_BAND);
  assert.deepEqual(intendedChainlinkBand("NVDA"), { minPrice: "20000000", maxPrice: "2000000000" });
  for (const file of REGISTRIES) {
    const r = read(file);
    for (const m of r.markets) assert.deepEqual(m.v2.chainlinkBand, intendedChainlinkBand(m.ticker), `${file} ${m.ticker}`);
    const issues = [];
    validateChainlinkBands(r, issues);
    assert.deepEqual(issues, [], file);
  }
});

test("--check refuses a band that is not the intended one, a missing band, and a band on a no-band market, by name", () => {
  const wrong = allIssuesFor((r) => { r.markets.find((m) => m.ticker === "NVDA").v2.chainlinkBand = { minPrice: "20000000", maxPrice: "90000000000" }; });
  assert.ok(wrong.some((i) => i.startsWith("NVDA: v2.chainlinkBand is {\"minPrice\":\"20000000\",\"maxPrice\":\"90000000000\"}") && i.includes("--pin-bands")), wrong.join("; "));
  const missing = allIssuesFor((r) => { delete r.markets.find((m) => m.ticker === "SPCX").v2.chainlinkBand; });
  assert.ok(missing.some((i) => i.startsWith("SPCX: v2.chainlinkBand is undefined")), missing.join("; "));
  const nulled = allIssuesFor((r) => { r.markets.find((m) => m.ticker === "SPCX").v2.chainlinkBand = null; });
  assert.ok(nulled.some((i) => i.startsWith("SPCX: v2.chainlinkBand is null")), nulled.join("; "));
  // A market with no table entry carries the explicit marker; the same market with a band is refused.
  assert.deepEqual(allIssuesFor((r) => { withSynthetic(r, "AMD", 1); }), [], "a no-band market with the marker is accepted");
  const banded = allIssuesFor((r) => { withSynthetic(r, "AMD", 1).v2.chainlinkBand = { minPrice: "1", maxPrice: "2" }; });
  assert.ok(banded.some((i) => i.startsWith("AMD: v2.chainlinkBand is") && i.includes("intended band is \"none\"")), banded.join("; "));
  // The unedited registry is the positive control: the rule is not simply refusing the key.
  assert.deepEqual(allIssuesFor(() => {}), []);
});

test("pinChainlinkBand writes the table value and nothing else; a non-object v2 passes through", () => {
  const prev = clone().markets.find((m) => m.ticker === "NVDA").v2;
  const stripped = { ...prev, chainlinkBand: { minPrice: "1", maxPrice: "2" } };
  const pinned = pinChainlinkBand("NVDA", stripped);
  assert.deepEqual(pinned, { ...stripped, chainlinkBand: { minPrice: "20000000", maxPrice: "2000000000" } });
  assert.deepEqual(pinChainlinkBand("AMD", stripped).chainlinkBand, CHAINLINK_NO_BAND);
  assert.equal(pinChainlinkBand("NVDA", null), null);
});

test("`--pin-bands` writes only the Chainlink bands, offline", async () => {
  const { mkdtempSync, writeFileSync: write, readFileSync: slurp } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "t-op-506-"));
  const before = clone();
  delete before.markets.find((m) => m.ticker === "NVDA").v2.chainlinkBand;
  before.markets.find((m) => m.ticker === "SPCX").v2.chainlinkBand = { minPrice: "1", maxPrice: "2" };
  const file = path.join(dir, "registry.json");
  write(file, JSON.stringify(before, null, 2) + "\n");
  // RH_RPC points nowhere: a network read would fail the run.
  const { stderr } = await promisify(execFile)(process.execPath, [path.join(HERE, "build-markets.mjs"), "--pin-bands", "--registry", file],
    { env: { ...process.env, RH_RPC: "http://127.0.0.1:1" } });
  const after = JSON.parse(slurp(file, "utf8"));
  for (const t of ["NVDA", "SPCX"]) assert.deepEqual(after.markets.find((m) => m.ticker === t).v2.chainlinkBand, intendedChainlinkBand(t), t);
  const strip = (r) => ({ ...r, markets: r.markets.map((m) => ({ ...m, v2: { ...m.v2, chainlinkBand: null } })) });
  assert.deepEqual(strip(after), strip(before), "--pin-bands moved a field other than chainlinkBand");
  assert.match(stderr, /NVDA: chainlinkBand undefined -> \{"minPrice":"20000000","maxPrice":"2000000000"\}/);
  assert.match(stderr, /SPCX: chainlinkBand \{"minPrice":"1","maxPrice":"2"\} -> \{"minPrice":"20000000","maxPrice":"1000000000"\}/);
  // It runs alone: with --check it refuses and writes nothing.
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(HERE, "build-markets.mjs"), "--pin-bands", "--check", "--registry", file],
    { env: { ...process.env, RH_RPC: "http://127.0.0.1:1" } }), (e) => e.code === 2 && /runs alone/.test(e.stderr));
});

test("payoutRoute: every pinned v4 id hashes from the key beside it (poolIdIssues, cast only, no RPC)", async () => {
  // A v4 pool has no address: keccak256(abi.encode(PoolKey)) IS the pin. An id copied from a recon run
  // that does not hash from its own key names a DIFFERENT pool and the swap would simply execute there.
  // poolIdIssues needs `cast keccak`, which is local - no network, so this runs under the no-RPC rule.
  assert.deepEqual(await poolIdIssues(read("tier1.json")), []);

  // The line above says nothing once no registry holds a v4 route. dev.json already routes the launch set
  // v3 fee 500, and tier1.json follows at the redeploy's write-back, after which it passes over nothing.
  // So the checker is also held to a v4 route of its own: NVDA's live v8 key (recon-derived)
  // must hash to its id, and the same key beside another id must be refused BY NAME.
  const V4_NVDA = { venue: "v4", fee: 375, tickSpacing: 4, poolId: "0xdf5c0bcd967d54774c139a4ef803ec994779736346fb4c21b50ed241b1fd2682" };
  const withRoute = (route) => {
    const r = read("tier1.json");
    r.markets.find((m) => m.ticker === "NVDA").v2.payoutRoute = route;
    return r;
  };
  assert.deepEqual(await poolIdIssues(withRoute(V4_NVDA)), [], "NVDA's recorded v4 key hashes to its recorded id");
  const refused = await poolIdIssues(withRoute({ ...V4_NVDA, poolId: `0x${"ab".repeat(32)}` }));
  assert.equal(refused.length, 1, "exactly the one wrong id is refused");
  assert.match(refused[0], /^NVDA: v2\.payoutRoute\.poolId is 0xabab.* the pinned id names a different pool$/);
});

test("payoutRoute is separate from univ3Pool: the settlement source is not the payout venue", () => {
  // Route vs TWAP source. v4 has no observation array, so a v4 route may never become a TWAP source. One key
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
  for (const ts of [0, -1, -60, 32768, 1.5, "10", null]) {
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
  // This test once asserted the INVERSE: it required
  // shared.token.poolKey to be hookless, quoting a design section that is about PAYOUT ROUTES; the
  // buyback venue is permanently the Pons launch pool and its key must name that pool's hook, which
  // V4BuybackExecutor requires to have code. The route rule is unchanged and is asserted below.

  // Case (c): the pinned launch-hook key PASSES -- no hooks issue is raised for a real hook.
  const pinned = allIssuesFor((r) => {
    r.shared.token.poolKey = { currency0: addr(1), currency1: addr(2), fee: 3000, tickSpacing: 60, hooks: OTHER };
    r.shared.token.poolId = `0x${"cd".repeat(32)}`;
  });
  assert.ok(!pinned.some((i) => i.includes("poolKey.hooks")), pinned.join("; "));

  // Case (a): hooks == address(0) now FAILS, naming the rule. This is the case the old validator
  // ACCEPTED and the deployed executor would revert NoSource on.
  const hookless = allIssuesFor((r) => {
    r.shared.token.poolKey = { currency0: addr(1), currency1: addr(2), fee: 3000, tickSpacing: 60, hooks: addr(0) };
    r.shared.token.poolId = `0x${"cd".repeat(32)}`;
  });
  assert.ok(hookless.some((i) => i.includes("poolKey.hooks is the zero address")), hookless.join("; "));

  // The committed key is filled in, so the half-pinned case has to be built: an id whose
  // key was nulled out. (Setting only poolId on the shipped registry no longer produces a half.)
  const half = allIssuesFor((r) => {
    r.shared.token.poolKey = { currency0: null, currency1: null, fee: null, tickSpacing: null, hooks: null };
    r.shared.token.poolId = `0x${"cd".repeat(32)}`;
  });
  assert.ok(half.some((i) => i.includes("filled in together")), half.join("; "));
});

test("a payout route may not name a hook at all, so the route rule is scoped and not deleted", () => {
  // The design's zero-hooks rule still governs routes, by a stronger mechanism than a value
  // check: `hooks` is not among PAYOUT_ROUTE_KEYS, so `exactKeys` refuses a route that carries one.
  // A route therefore cannot name a hooked pool even by accident, which is what the design means by
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
  // The rows are written elsewhere; the mechanism is here. NVDA keeps a v3 settlement pool, so it is the
  // market the override must NOT be written on — the delay only applies when that source is not ok.
  const withPool = allIssuesFor((r) => {
    const m = r.markets.find((x) => x.ticker === "NVDA");
    m.v2.overrides = { uncorroboratedDelayS: 3600 };
  });
  assert.ok(withPool.some((i) => i.includes("uncorroboratedDelayS") && i.includes("univ3Pool")), withPool.join("; "));

  // No shipped market is Chainlink-only any more, so the case runs on a synthetic one.
  const chainlinkOnly = (delay) => allIssuesFor((r) => {
    withSynthetic(r, "AMD", 1).v2.overrides = { uncorroboratedDelayS: delay };
  });
  assert.deepEqual(chainlinkOnly(3600), [], "3600 on a Chainlink-only market is the owner's decision of 2026-09-19");
  for (const bad of [0, 60, 899, 4 * 86400 + 1]) {
    assert.ok(chainlinkOnly(bad).some((i) => i.includes("uncorroboratedDelayS")), `${bad} s is accepted`);
  }
});

test("the SHIPPED registry: every launch row is Chainlink-only with the 3600 override, or has a pool and none", () => {
  // The launch wrote these rows. The validator refuses the two states in isolation; this asserts the file
  // we actually ship is in neither. NVDA is the canary.
  const registry = read("tier1.json");
  const launch = registry.markets.filter((m) => m.v2.wave === "wave1");
  const canary = registry.markets.filter((m) => m.v2.wave === "canary").map((m) => m.ticker);

  // Re-derived: a registry change cut the shipped file to the launch set
  // (NVDA and SPCX only). The counts this used to pin (19 in wave1, 15 in wave2, SGOV dropped for having
  // no weeklies) described the 35-row file it replaced; "no other row ships" is the stronger form of all three.
  assert.deepEqual(registry.markets.map((m) => m.ticker), registry.launchSet.markets, "the shipped rows are the launch set and nothing else");
  assert.deepEqual(canary, ["NVDA"], "NVDA is the canary and the only one");
  assert.deepEqual(launch.map((m) => m.ticker), ["SPCX"], "SPCX is the rest of the launch set");
  assert.equal(registry.markets.filter((m) => m.v2.wave === "wave2").length, 0, "no deferred row ships");

  for (const m of [...launch, ...registry.markets.filter((x) => x.v2.wave === "canary")]) {
    const override = m.v2.overrides?.uncorroboratedDelayS;
    if (m.v2.univ3Pool === null) {
      assert.equal(override, 3600, `${m.ticker} is Chainlink-only and must carry uncorroboratedDelayS 3600`);
    } else {
      assert.equal(override, undefined, `${m.ticker} still has a v2.univ3Pool, so it must NOT carry the override`);
    }
    // Written by the registration write-back, not here: a later write-back released both live after the Safe's go-live execute.
    assert.equal(m.v2.status, "live", `${m.ticker} status is the registration write-back's`);
  }

  // Dailies only, no weeklies, and no launch row overrides that away. The earlier "one daily" was superseded by
  // six daily closes ahead, whose own test below pins the number; this one
  // keeps the property it guarded, no weekly and no per-row override, against the builder's seed. The one exception is
  // SPCX: its options are listed for Fridays only, so SPCX lists its next
  // two Friday (weekly) closes and no dailies. OWNER_EXPIRIES_AHEAD below pins it; no other row may override.
  assert.deepEqual(registry.v2.defaults.expiriesAhead, V2_SKELETON.defaults.expiriesAhead, "the builder's seed, not a per-file value");
  assert.equal(registry.v2.defaults.expiriesAhead.weekly, 0, "no weeklies");
  for (const m of launch) {
    assert.deepEqual(m.v2.overrides?.expiriesAhead, OWNER_EXPIRIES_AHEAD[m.ticker], `${m.ticker} overrides expiriesAhead only as the owner ruled`);
  }
});

/** No SPCX dailies (SPCX options are Friday-only): the only per-market expiriesAhead. */
const OWNER_EXPIRIES_AHEAD = { SPCX: { weekly: 2, daily: 0 } };

/** NVDA lists Mon/Wed/Fri only: the only per-market dailyWeekdays. */
const OWNER_DAILY_WEEKDAYS = { NVDA: ["mon", "wed", "fri"] };

test("Every weekday by default, NVDA Mon/Wed/Fri only, in both registries; no other row overrides it", () => {
  assert.deepEqual(V2_SKELETON.defaults.dailyWeekdays, ["mon", "tue", "wed", "thu", "fri"]);
  for (const file of ["tier1.json", "dev.json"]) {
    const registry = read(file);
    assert.deepEqual(registry.v2.defaults.dailyWeekdays, V2_SKELETON.defaults.dailyWeekdays, `${file} v2.defaults.dailyWeekdays`);
    for (const m of registry.markets) {
      assert.deepEqual(m.v2.overrides?.dailyWeekdays, OWNER_DAILY_WEEKDAYS[m.ticker], `${file} ${m.ticker} overrides dailyWeekdays only as the owner ruled`);
    }
  }
});

test("The validator refuses a dailyWeekdays that is empty, repeats a day, names a weekend day or is not a list", () => {
  const nvda = (r) => r.markets.find((m) => m.ticker === "NVDA");
  const refused = (value) => allIssuesFor((r) => { nvda(r).v2.overrides = { dailyWeekdays: value }; }).filter((i) => i.includes("dailyWeekdays"));
  assert.deepEqual(refused(["mon", "wed", "fri"]), [], "the shipped value passes");
  for (const bad of [[], ["mon", "mon"], ["mon", "sat"], "mon", 3]) {
    assert.deepEqual(refused(bad), [`NVDA.v2.overrides.dailyWeekdays must be a non-empty list of distinct weekdays (mon, tue, wed, thu, fri), not ${JSON.stringify(bad)}`], JSON.stringify(bad));
  }
  const defaults = allIssuesFor((r) => { r.v2.defaults.dailyWeekdays = ["tue", "tue"]; }).filter((i) => i.includes("dailyWeekdays"));
  assert.equal(defaults.length > 0, true, "the defaults list is checked too");
});

test("Six daily closes and no weekly -- both registries list them on every market, and pass the validator", () => {
  // First 0DTE only, then daily options up to six days ahead.
  // `v2` is carried as written by a rebuild, so the builder's
  // constant and the two committed registries are three copies of one decision; this pins them equal.
  assert.deepEqual(V2_SKELETON.defaults.expiriesAhead, { weekly: 0, daily: 6 }, "the first-build seed");
  for (const file of ["tier1.json", "dev.json"]) {
    const registry = read(file);
    assert.deepEqual(registry.v2.defaults.expiriesAhead, V2_SKELETON.defaults.expiriesAhead, `${file} v2.defaults.expiriesAhead`);
    // Every market, not only the launch set: an override would bring a weekly (or a second daily) back for one row.
    // The one exception: SPCX, Friday closes only.
    for (const m of registry.markets) {
      assert.deepEqual(m.v2.overrides?.expiriesAhead, OWNER_EXPIRIES_AHEAD[m.ticker], `${file} ${m.ticker} overrides expiriesAhead`);
    }
    // The weekly ladder DEFINITION stays, so a later decision turns the tenor back on with one number.
    assert.deepEqual(Object.keys(registry.v2.defaults.ladder).sort(), ["daily", "weekly"], `${file} ladder tenors`);
    assert.ok(registry.v2.defaults.ladder.weekly.rungs > 0, `${file} ladder.weekly.rungs`);
    assert.ok(registry.v2.defaults.expiriesAhead.daily > 0, `${file}: a daily of 0 would list nothing at all`);
  }
  // weekly 0 is a value the offline validator accepts (intTree: a non-negative integer) -- the shipped file is clean.
  assert.deepEqual(allIssuesFor(() => {}).filter((i) => i.includes("expiriesAhead")), []);
  assert.deepEqual(allIssuesFor(() => {}, "dev.json").filter((i) => i.includes("expiriesAhead")), []);
  // Positive control: the same rule refuses a negative count, so the empty list above is the rule passing, not absent.
  const negative = allIssuesFor((r) => { r.v2.defaults.expiriesAhead.weekly = -1; });
  assert.ok(negative.some((i) => i.includes("v2.defaults.expiriesAhead.weekly")), negative.join("; "));
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
 * Every other claim in validateDevIsolation walks a block the dev side also walks - except
 * production's own `v2.protocolAddresses`, which was not walked at all. A production address in that
 * block was therefore caught only THROUGH ITS TWIN elsewhere, and most keys have a twin, so the common
 * cases passed by accident rather than by rule. The exposure was exactly the twin-less slots:
 * `distributors.user` and `distributors.lender`, twin-less BY DESIGN because a second deployment of
 * RewardsDistributor cannot be mirrored into the closed, counted `v2.contracts` block.
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
  // None of which is in the current registry any more. tier1.json records the deployment itself,
  // so the check is that it names that one and not v7's, which the old null pins only implied. v9 mainnet launch
  // 12:02 PM PT 2026-09-25, deployBlock 72462898, stonkctl run 20260925T190245Z write-back (its first commit
  // wrote the block and the Clearinghouse).
  assert.equal(prod.v2.deployBlock, 72462898);
  assert.notEqual(prod.v2.deployBlock, legacy.v2.deployBlock);
  assert.equal(prod.v2.contracts.clearinghouse, "0xD33663CD8A363710daF87C78616899cED34b9374");
  assert.notEqual(prod.v2.contracts.clearinghouse.toLowerCase(), legacy.v2.contracts.clearinghouse.toLowerCase());
  assert.equal(prod.v2.interfaceVersion, 8);
});

/* ------------------------------------------------------------------ the protocol block: missing */

test("the protocol block is in both registries with exactly V2_PROTOCOL_KEYS and V2_PROTOCOL_DISTRIBUTOR_KEYS", () => {
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

test("it is not a v2.contracts key (the address count and render-docs both close that block)", () => {
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
 * THE HALF THAT WAS SILENT. `lender` landed in tier1.json with the lender rewards and the constant was not
 * widened, so `exactKeys` called the shipped registry invalid — loud, and the reason this test exists.
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
 * nobody saw, because no suite ran.
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

test("v8 leaves only distributors.user and distributors.lender without a twin — that was the gap", () => {
  const untwinned = V2_PROTOCOL_KEYS.filter((k) => k !== "distributors" && !(k in V2_PROTOCOL_TWINS));
  assert.deepEqual(untwinned, [], `these keys mirror nothing and can drift silently: ${untwinned.join(", ")}`);
  assert.equal("distributors.user" in V2_PROTOCOL_TWINS, false, "distributors.user waits for F5");
  // `lender` is a SECOND DEPLOYMENT of RewardsDistributor, not a second contract, and `v2.contracts` is a
  // closed counted block, so there is nothing for it to mirror and adding a slot to mirror
  // would change a count render-docs and the deploy tooling consume. Twin-less is the DECISION here, not
  // an oversight: the address/null and duplicate-address checks still cover it, which is what the fix covered.
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

test("the two Safes may not be one Safe", () => {
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

/* ------------------------------------- the settlement source-count floor */

/**
 * SINGLE-SOURCE MARKETS AS THEY STAND ON 2026-09-21. This is a RECORD OF AN UNREVIEWED STATE, NOT AN
 * APPROVAL. Two earlier audits both argued that the half-day settlement residual is bounded because
 * "no registered market is single-source". That clause is FALSE: 33 of the 35 markets in each
 * registry carry `v2.univ3Pool: null`, and `script/v2/RegisterMarkets.s.sol:919-921` builds the
 * oracle source list as `new address[](m.pool == address(0) ? 1 : 2)`, so each of them registers
 * with ONE source. Only NVDA and SPCX carry a pool.
 *
 * WHY THAT MATTERS: with one source, a window in which the Chainlink feed is not ok leaves
 * `okCount` at 0, `SettlementOracle._band` returns `(false, 0, 0)`, and `adminResolve` accepts any
 * price in (0, MAX_PRICE]. That is the unbounded adminResolve window, reached without needing a special expiry.
 *
 * WHAT IS NOT CLAIMED: nobody has shown a live Chainlink Stock Token feed actually goes stale over
 * the relevant window, and no market is registered yet (`v2.status` is "planned" for all 35). This
 * is a missing safety margin, not a demonstrated exploit.
 *
 * WHY THESE 33 ARE SINGLE-SOURCE, because it is a DELIBERATE TRADE and not an oversight: of the 33,
 * 20 have only "thin" pools in the source recon, 2 have no pool at all, and 11 have a pool the recon
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
 * STATUS OF THIS SET, stated plainly: whether recording 33
 * markets this way is the right shape was still open when this landed.
 * This is the shape the test's own criterion forces — a plain "no market is single-source" is red
 * on commit 66 times and cannot be proven by breaking, because it is never green to begin with.
 * IT IS ONE CONSTANT TO CHANGE. If the posture call goes the other way, delete the set and the
 * first test becomes the plain assertion; nothing else here depends on it.
 */
// THE SET LIVES IN build-markets.mjs AND IS IMPORTED. It used to be defined here, which
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

test("the BUILD refuses a 34th single-source market, not just the suite", () => {
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

test("the BUILD refuses a set entry that has gained a pool, so the set cannot rot", () => {
  // The other direction. Without it the set silently accumulates tickers that are no longer
  // single-source, and a real 34th could hide behind a stale name.
  // AAPL is no longer in the registry; a synthetic AAPL row (the set still names it) carries the case.
  const issues = allIssuesFor((r) => {
    const m = withSynthetic(r, "AAPL", 1);
    m.v2.overrides = {};
    m.v2.univ3Pool = "0x" + "11".repeat(20);
    m.v2.univ3MinLiquidity = "1000000000000000000";
  });
  assert.ok(issues.some((i) => i.includes("AAPL") && i.includes("still listed in SINGLE_SOURCE_AT_2026_09_21")),
    `expected the build to refuse AAPL gaining a pool while still in the set, got ${JSON.stringify(issues)}`);
});

test("the recorded single-source set has not silently shrunk either", () => {
  // The inverse direction. If a market GAINS a pool the set is stale and should be trimmed, and
  // leaving a stale name here would let a future single-source market pass unnoticed under it.
  // The set records the launch-set decision for all 33, and all 33 have since left the registry. What must
  // still hold is that no set entry that IS in a registry has a pool, and every Chainlink-only row is in the set.
  for (const file of REGISTRIES) {
    for (const m of read(file).markets) {
      if (SINGLE_SOURCE_AT_2026_09_21.has(m.ticker)) {
        assert.ok(!m.v2.univ3Pool, `${file} ${m.ticker} now has a univ3Pool: remove it from SINGLE_SOURCE_AT_2026_09_21 so the set keeps meaning what it says`);
      } else {
        assert.ok(m.v2.univ3Pool, `${file} ${m.ticker} is Chainlink-only but not in SINGLE_SOURCE_AT_2026_09_21`);
      }
    }
  }
});

// 8. The launch set: named, not inferred.

/** The launch set. A ticker list, deliberately not a wave name. */
const LAUNCH_SET_AT_2026_09_21 = ["NVDA", "SPCX"];

test("the shipped launch set is exactly the two launch markets", () => {
  // Two assertions, not one: the COUNT catches a set that grew or shrank, and the MEMBERS
  // catch a swap that kept the count. Removing SPCX fails the second naming SPCX; adding a third
  // fails the first.
  const named = read("tier1.json").launchSet.markets;
  // MEMBERS FIRST, COUNT SECOND, and the order is load-bearing. Both directions were run: with the
  // count first, dropping SPCX failed with "the launch set is 1 markets (NVDA)" -- a true message that
  // never says which market went missing, so the operator reading it has to diff the file to find out.
  // Checking membership first makes the red NAME THE TICKER, which is what a failing check should do and what a
  // person at 3 a.m. needs.
  for (const ticker of LAUNCH_SET_AT_2026_09_21) {
    assert.ok(named.includes(ticker), `${ticker} is not in launchSet.markets; the owner's launch set is ${LAUNCH_SET_AT_2026_09_21.join(" and ")}`);
  }
  assert.equal(named.length, LAUNCH_SET_AT_2026_09_21.length,
    `the launch set is ${named.length} markets (${named.join(", ")}); the owner named ${LAUNCH_SET_AT_2026_09_21.length}`);
});

/*
 * The
 * builder cuts the feed directory to the launch set (launchTickers + selectLaunchPairs in main), so the cut survives a
 * rebuild. The expected tickers are READ from production's launchSet, never typed here.
 */
test("Both shipped registries list exactly launchSet.markets, and every other feed is a recorded skip", () => {
  const production = read("tier1.json");
  const want = [...production.launchSet.markets].sort();
  for (const file of REGISTRIES) {
    const r = read(file);
    assert.deepEqual(r.markets.map((m) => m.ticker).sort(), want, `${file}: markets are exactly the launch set`);
    assert.deepEqual(launchTickers(r, file === "tier1.json" ? null : production), production.launchSet.markets, `${file}: the set the builder cuts to`);
    assert.equal(r.summary.markets, want.length, `${file} summary`);
    // What the feed directory offered and the cut left out is on the record, with the reason, not silently gone.
    const leftOut = r.skipped.filter((x) => typeof x.why === "string" && x.why.startsWith("not in launchSet.markets"));
    const unpaired = r.skipped.length - leftOut.length;
    assert.equal(r.markets.length + leftOut.length + unpaired, r.feedsSource.equity, `${file}: every tokenised-equity feed is a market, a launch-set skip, or an unpaired skip`);
    assert.ok(leftOut.length > 0, `${file}: the feed directory offers more than the launch set, and the skips say so`);
    for (const x of leftOut) assert.ok(!want.includes(x.ticker), `${file}: ${x.ticker} is in the launch set but was skipped`);
  }
});

test("launchTickers uses the registry's own set, else production's (a _dev registry), else cuts nothing", () => {
  const own = { launchSet: { note: "n", markets: ["NVDA"] } };
  const prod = { launchSet: { note: "n", markets: ["NVDA", "SPCX"] } };
  assert.deepEqual(launchTickers(own, prod), ["NVDA"], "a registry's own launch set wins");
  assert.deepEqual(launchTickers({ _dev: "x" }, prod), ["NVDA", "SPCX"], "a dev registry follows production");
  assert.equal(launchTickers({}, null), null, "no set anywhere: nothing is cut");
  assert.equal(launchTickers({ launchSet: { markets: [] } }, null), null, "an empty set is not a cut to nothing");
});

test("selectLaunchPairs keeps the set, records every other pair with its reason, and keeps all with no set", () => {
  const pair = (ticker) => ({ ticker, feed: { name: `Robinhood ${ticker} / USD` }, token: {} });
  const pairs = ["AAPL", "NVDA", "SPCX", "TSLA"].map(pair);
  const { kept, left } = selectLaunchPairs(pairs, ["NVDA", "SPCX"]);
  assert.deepEqual(kept.map((p) => p.ticker), ["NVDA", "SPCX"]);
  assert.deepEqual(left, [
    { feed: "Robinhood AAPL / USD", ticker: "AAPL", why: "not in launchSet.markets (NVDA, SPCX)" },
    { feed: "Robinhood TSLA / USD", ticker: "TSLA", why: "not in launchSet.markets (NVDA, SPCX)" },
  ]);
  const all = selectLaunchPairs(pairs, null);
  assert.equal(all.kept.length, 4);
  assert.deepEqual(all.left, []);
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

// 9. Root keys: carried, regenerated or retired.

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

test("a rebuild of each shipped registry loses no root key", () => {
  // The control that keeps the guard honest: if this were red on the shipped files, the guard would be
  // always-on and every other assertion here would pass for the wrong reason.
  for (const file of REGISTRIES) {
    const r = read(file);
    assert.deepEqual(rootKeyIssues(r, rebuild(r)), [], `${file}: a rebuild of the committed registry would lose a root key`);
  }
});

test("launchSet comes out of a rebuild exactly as it went in", () => {
  // The key that would have been eaten. Pinned by name as well as by the general guard above, so that
  // removing its line from assembleRegistry fails here naming launchSet.
  const r = read("tier1.json");
  assert.ok(r.launchSet, "tier1.json carries no launchSet: this test has nothing to protect");
  assert.deepEqual(rebuild(r).launchSet, r.launchSet, "a rebuild of tier1.json did not carry launchSet");
});

test("a root key nobody named fails the build, and the refusal names it", () => {
  // Nobody wrote a line for this key in assembleRegistry and nobody listed it as an output. Before the root-key guard
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

/* ------------------------------------------------------------------ 10. Per-market keys: carried, regenerated or optional */

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

test("Baseline: no shipped market carries a key outside MARKET_FIELDS, and no null where null would be defaulted", () => {
  // The reason this is low severity rather than a live data loss. If this is red, a rebuild of the committed
  // file would already drop something: stop and say which key before changing the builder.
  for (const file of REGISTRIES) {
    for (const m of read(file).markets) {
      const outside = Object.keys(m).filter((k) => !Object.hasOwn(MARKET_FIELDS, k));
      assert.deepEqual(outside, [], `${file} ${m.ticker}: keys the builder's literal does not name: ${outside.join(", ")}`);
      for (const k of REFUSE_NULL) assert.notEqual(m[k], null, `${file} ${m.ticker}: ${k} is null and a rebuild would default it silently`);
    }
  }
});

test("MARKET_FIELDS and the literal name the same keys, for a seen market and a first-seen one", () => {
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

test("A rebuild of every shipped market loses nothing, and carries every hand-maintained key byte-identically", () => {
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

test("A hand-written key the literal does not name is refused by ticker and key, before the write", () => {
  const r = read("tier1.json");
  const m = { ...r.markets[0], strikeOtmBpsOverride: 700 };
  const issues = marketKeyIssues(m, rebuildMarket(m, r));
  assert.equal(issues.length, 1, issues.join("; "));
  assert.ok(issues[0].startsWith(`${m.ticker}: key strikeOtmBpsOverride is in the market read and missing`), issues[0]);
  // The rebuilt row really did drop it: that is the loss the message describes.
  assert.ok(!("strikeOtmBpsOverride" in rebuildMarket(m, r)));
});

test("A null where the literal would default it is refused, naming the ticker and field", () => {
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

test("A null that is a legal value survives a rebuild unreported (depositCapUsd is the precedent)", () => {
  const r = read("tier1.json");
  const synth = withSynthetic(r, "AMD", 1); // The shipped registry has two rows, not the five this walked
  assert.deepEqual(NULL_OK.sort(), ["depositCapUsd", "v2"]);
  assert.deepEqual(KEPT.sort(), ["v1FrozenAt", "v1RunOff"]);
  for (const k of [...NULL_OK, ...KEPT]) {
    const m = { ...synth, [k]: null };
    const w = rebuildMarket(m, r);
    assert.equal(w[k], null, `${k}: a legal null was replaced on rebuild`);
    assert.deepEqual(marketKeyIssues(m, w), [], `${k}: a legal null was reported`);
  }
  // depositCapUsd null is uncapped: the derived cap is type(uint256).max, not a default cap.
  const m = { ...synth, depositCapUsd: null };
  assert.equal(rebuildMarket(m, r).depositCap, (2n ** 256n - 1n).toString());
});

test("Optional keys are written when set, legitimately absent when unset, and never invented", () => {
  const r = read("tier1.json");
  assert.deepEqual(OPTIONAL.sort(), ["modeOverride", "notes"]);
  const base = withSynthetic(r, "AMZN", 2); // Two shipped rows; a synthetic third
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

test("A carried key rewritten to a different value is reported, the same loss one level down", () => {
  const r = read("tier1.json");
  const m = withSynthetic(r, "ASML", 3); // Two shipped rows; a synthetic one
  const w = { ...rebuildMarket(m, r), strikeOtmBps: m.strikeOtmBps + 1 };
  const issues = marketKeyIssues(m, w);
  assert.ok(issues.some((i) => i.startsWith(`${m.ticker}: strikeOtmBps is carried, not regenerated`)), issues.join("; "));
});

test("A first-seen market has nothing to lose, and its row is the documented skeleton", () => {
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

/* ------------------------------------------------------------------ the two Safes are written, and they are real */

// The Admin Safe and the Treasury Safe were created on chain 4663 (safes-bootstrap.sh; creation txs
// 0xb61dbb85…a56 at block 68864146 and 0x4a76ae73…dcd at block 68864203) and VERIFIED on chain 4663 before
// they were written here: SafeL2 1.4.1 singleton 0x29fcB43b…C762 in slot 0, VERSION() "1.4.1", getThreshold() 2,
// getOwners() exactly the three owner keys, CompatibilityFallbackHandler 0xfd0732…Ec99, no guard,
// no module. These pins hold the WRITE: non-null, EIP-55 as the chain reads them, mirrored, distinct from every other
// principal, and never an anvil account. They do not re-read the chain; the creation blocks are named above.
const ADMIN_SAFE = "0x6f8A7B77b72511cD8939596b1659bA28C28f101B";
const TREASURY_SAFE = "0x014b996a084690FB27265BfAC157b04e9FeBbF4E";
const OPS_WALLET = "0x088E22EaF42F99c8b0d9A4e9babA5EdDE78A1439";

test("tier1.json carries the two verified 2-of-3 Safes, mirrored and distinct", () => {
  const r = read("tier1.json");
  assert.equal(r.shared.safes.admin, ADMIN_SAFE, "the Admin Safe (first-created, saltNonce 2026092101, block 68864146)");
  assert.equal(r.shared.safes.treasury, TREASURY_SAFE, "the Treasury Safe (saltNonce 2026092102, block 68864203)");
  assert.equal(r.shared.admin, r.shared.safes.admin, "shared.admin IS the Admin Safe (README: same address as shared.safes.admin)");
  assert.equal(r.shared.opsWallet, OPS_WALLET, "the ops wallet");
  assert.notEqual(r.shared.safes.admin.toLowerCase(), r.shared.safes.treasury.toLowerCase(), "two Safes, not one address twice");
  // Exact EIP-55 as written: a lowercased or mis-cased copy is a different string and a consumer that
  // compares strings would call the same Safe a stranger.
  for (const [k, v] of [["admin", ADMIN_SAFE], ["treasury", TREASURY_SAFE]]) {
    assert.match(v, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(v, v.toLowerCase(), `${k} must be EIP-55, not lowercase`);
  }
});

test("The Safes are distinct from every other principal the launch names, and the deploy still owns feeRecipient", () => {
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
  // feeRecipient is the FeeSplitter the deploy creates. The launch write-back has filled it,
  // so "the deploy owns it" is now checked as equality with the deployed splitter (v2.flywheel.feeSplitter), never a
  // hand-set address. v9 mainnet launch 12:02 PM PT 2026-09-25, deployBlock 72462898, stonkctl run
  // 20260925T190245Z write-back (its first commit wrote both slots).
  assert.equal(r.shared.feeRecipient, r.v2.flywheel.feeSplitter, "shared.feeRecipient is the FeeSplitter the deploy wrote back, not a hand-set address");
  assert.equal(r.shared.feeRecipient, "0xb837819273097BC6D2F1AdB4AC897DFd5c5DBdf0");
});

test("dev.json keeps its anvil Safes — production Safes never enter the dev registry", () => {
  const dev = read("dev.json");
  const prod = read("tier1.json");
  for (const k of ["admin", "treasury"]) {
    assert.notEqual(dev.shared.safes[k].toLowerCase(), prod.shared.safes[k].toLowerCase(), `dev shared.safes.${k} is the production Safe`);
  }
  assert.equal(dev.shared.safes.admin, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "dev admin Safe stays anvil #0");
  assert.equal(dev.shared.safes.treasury, "0x71bE63f3384f5fb98995898A86B02Fb2426c5788", "dev treasury Safe stays anvil #9");
  assert.notEqual(dev.shared.opsWallet, prod.shared.opsWallet, "dev opsWallet is not the production ops wallet");
});

/* ------------------------------------------------------------------ shared.token from chain */

/**
 * `shared.token` and its v4 PoolKey were all-null in both registries and `DeployV2Batch.sh:354-358`
 * refused the broadcast on them. The values are DERIVED from chain 4663 (endpoint and block recorded at the time),
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
// The launch hook the recon pins (re-read from the pool's
// Initialize log at block 64,068,924 for this pin). A registry naming any other hook names another pool.
const PONS_LAUNCH_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

for (const file of REGISTRIES) {
  test(`${file} shared.token is complete, EIP-55 strict, currency0 is native ETH, hooks is the launch hook`, async () => {
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

  test(`${file} shared.token.poolId is keccak256(abi.encode(poolKey)) — recomputed, not copied`, async () => {
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

test("Both registries pin the SAME token and pool (the dev deploy path reads dev.json)", () => {
  const a = read("tier1.json").shared.token;
  const b = read("dev.json").shared.token;
  assert.deepEqual(b, a);
});

test("v2-sources.json carries contracts.weth, contracts.usdgWethV3Pool and contracts.verifierProxy for DeployV2Batch.sh:314/354", async () => {
  const sources = read("v2-sources.json");
  for (const k of ["weth", "usdgWethV3Pool", "verifierProxy"]) {
    const c = sources.contracts[k];
    assert.ok(c && typeof c.address === "string", `contracts.${k}.address is missing`);
    assert.equal(c.codeExists, true, `contracts.${k} has no code on 4663`);
    await assertStrictEip55(`contracts.${k}.address`, c.address);
  }
  // The recon must agree with the contracts fixture copied from the route spike, or one of them is wrong.
  assert.equal(sources.contracts.weth.address, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "WETH: SwapRouter02.WETH9()");
  assert.equal(sources.contracts.usdgWethV3Pool.address, "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca", "factory.getPool(USDG, WETH, 100)");
});

/**
 * `validateDevIsolation` claimed `shared.token.address` as production's own, so the
 * moment production pinned the real STONKHOUSE, a dev registry naming the SAME token was refused
 * — and the dev deploy path reads that token from dev.json. The token is a fact of chain 4663 like
 * `shared.usdg`, not a wallet we run. Two-sided: the token is accepted, and the rule still refuses what it
 * is for (a production wallet copied into dev), and the acceptance is about the SLOT, not the value.
 */
test("dev.json may carry production's STONKHOUSE token, while a production WALLET in dev.json is still refused", () => {
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

test("tier1.json bot keys and shared.guardian are set, EIP-55 strict, one principal per role, and guardian is the GUARDIAN holder", async () => {
  // The bot slots hold public addresses only:
  // cranker, pricer and quoter are three distinct keys, and nothing here
  // reads or derives a key.
  // The guardian is a separate key (the
  // test below pins the bytes). DeployV2Batch.sh:667 exports V2_GUARDIAN from shared.guardian and V2DeployBase.sol:234
  // maps it to `v2.bots.guardian: GUARDIAN`, so the two slots MUST be the same principal. DeployV8._principals
  // requires the principals to be distinct. The Safes, admin and ops wallet are checked elsewhere.
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
 * The GUARDIAN holder is a fixed owner key, written byte-for-byte as chosen.
 *
 * The first choice, the wallet
 * 0xEb82c3D0...9d9b, is the v8 DEPLOYER and `DeployV8._principals` refuses guardian == deployer, so the
 * choice moved to the v7 dev-launch guardian every v1 row already names as `deployment.guardian`. The address
 * is a typed input nobody re-derives, so the pin is the literal string and the EIP-55 form is re-asserted
 * through `cast` rather than trusted. It replaces an earlier bot key in `shared.guardian` and, because
 * the validator forces them equal (`v2.bots.guardian` in `validateV2Bots`, `v2.protocolAddresses.guardian`
 * via V2_PROTOCOL_TWINS), in both mirrors. `dev.json` is NOT touched: `validateDevIsolation` claims
 * production's `shared.guardian` (and, separately, every v1 row's `deployment.guardian`, which this wallet
 * also is), so a dev registry naming it is refused by name -- the same shape as for the Safes. The devnet
 * keeps anvil #1.
 */
const OWNER_GUARDIAN = "0x29741A8d283a253E8Ce10aDfd04C6507438b6F39";
/** The v8 deployer (the v7 admin). Not a registry field; pinned here only to be refused. */
const V8_DEPLOYER = "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b";

test("tier1.json shared.guardian is the recorded guardian wallet, byte-for-byte, EIP-55 via cast, and both mirrors agree", async () => {
  const r = read("tier1.json");
  assert.equal(r.shared.guardian, OWNER_GUARDIAN, "shared.guardian is not the ruled wallet as typed");
  await assertStrictEip55("shared.guardian", r.shared.guardian);
  assert.notEqual(r.shared.guardian, r.shared.guardian.toLowerCase(), "shared.guardian must be written in its EIP-55 form, not lowercase");
  assert.equal(r.v2.bots.guardian, OWNER_GUARDIAN, "v2.bots.guardian is the same key written twice (validateV2Bots)");
  assert.equal(r.v2.protocolAddresses.guardian, OWNER_GUARDIAN, "v2.protocolAddresses.guardian mirrors shared.guardian (V2_PROTOCOL_TWINS)");
  // The recorded guardian wallet is the v7 per-market guardian, which every v1 row still names. A fact of the registry,
  // not a rule; pinned so that a rebuild which silently rewrote those rows would be seen here.
  for (const m of r.markets) {
    if (m.deployment?.guardian !== undefined && m.deployment.guardian !== null) {
      assert.equal(m.deployment.guardian, OWNER_GUARDIAN, `${m.ticker} deployment.guardian is not the ruled wallet`);
    }
  }
  // The one collision the registry cannot see: DeployV8._principals refuses guardian == deployer, and the
  // deployer is an env input (DEPLOYER_PK), not a registry field. The withdrawn first choice was exactly this.
  assert.notEqual(r.shared.guardian.toLowerCase(), V8_DEPLOYER.toLowerCase(), "the guardian is the v8 deployer (DeployV8._principals refuses it)");
  // Not a Safe, not a Safe owner, not the ops wallet, not a bot. The distinct-principals test above
  // covers the registry's own slots; these name the three the guardian choice was checked against.
  assert.notEqual(r.shared.guardian.toLowerCase(), r.shared.safes.admin.toLowerCase(), "the guardian is the Admin Safe");
  assert.notEqual(r.shared.guardian.toLowerCase(), r.shared.safes.treasury.toLowerCase(), "the guardian is the Treasury Safe");
  assert.notEqual(r.shared.guardian.toLowerCase(), r.shared.opsWallet.toLowerCase(), "the guardian is the ops wallet");
  for (const k of ["cranker", "pricer", "quoter"]) {
    assert.notEqual(r.shared.guardian.toLowerCase(), r.v2.bots[k].toLowerCase(), `the guardian is v2.bots.${k}`);
  }
});

test("dev.json keeps its anvil guardian — the production guardian wallet never enters the dev registry", () => {
  const dev = read("dev.json");
  const prod = read("tier1.json");
  assert.notEqual(dev.shared.guardian.toLowerCase(), OWNER_GUARDIAN.toLowerCase(), "dev shared.guardian is the ruled wallet");
  assert.notEqual(dev.shared.guardian.toLowerCase(), prod.shared.guardian.toLowerCase(), "dev shared.guardian is the production guardian");
  assert.equal(dev.v2.bots.guardian, dev.shared.guardian, "dev v2.bots.guardian is its own shared.guardian");
  // Positive control: the committed dev.json passes isolation, and a copy carrying the production guardian wallet in
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
 * The three Uniswap v3 periphery addresses are EIP-55 at the source and in every copy.
 *
 * They were lowercase from the first build and every case-insensitive reader was happy; the strict
 * readers were not (viem isAddress strict, this file's own EIP-55 rule, the contracts preflight
 * script/v2/check-deploy-inputs.sh that gates the broadcast). The case is a function of the bytes, so the
 * pin is `cast to-check-sum-address` over the lowercase form, not a string typed here; and the validator
 * is watched refusing a lowercase copy by name, because a `--check` that cannot see its subject is the
 * defect class these pins exist to catch.
 */
const UNISWAP_V3_KEYS = ["factory", "swapRouter02", "quoterV2"];

test("V2_SKELETON.uniswapV3 is EIP-55 strict, mixed-case, and equal to its own cast checksum", async () => {
  assert.deepEqual(Object.keys(V2_SKELETON.uniswapV3), UNISWAP_V3_KEYS);
  for (const k of UNISWAP_V3_KEYS) {
    const a = V2_SKELETON.uniswapV3[k];
    assert.notEqual(a, a.toLowerCase(), `V2_SKELETON.uniswapV3.${k} is lowercase: the strict readers refuse it`);
    await assertStrictEip55(`V2_SKELETON.uniswapV3.${k}`, a);
  }
});

for (const file of REGISTRIES) {
  test(`${file} v2.uniswapV3 carries the builder's EIP-55 strings exactly and the recon agrees by value`, async () => {
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

  test(`${file} --check refuses a right-bytes wrong-case v2.uniswapV3 copy by name and names the string to set`, () => {
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

  test(`${file} --check refuses a DIFFERENT checksummed v2.uniswapV3 address by name against the skeleton, not as a case fault`, () => {
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
 * `markets[].v2.houseVault`, the per-ticker HouseVault the broadcast's externals stage writes back
 * (two vaults at launch, NVDA + SPCX; `v2.contracts.houseVault` stays the first launch
 * ticker's, the one VerifyV8 walks). The key is REQUIRED on every row (exactKeys is symmetric), null until the
 * write-back and null for ever outside the launch set. One address rule for the case: the same `cast` check as
 * shared.* and v2.bots, via checksumMarketHouseVaults, run by --check and exported here for a positive control.
 */
const HOUSE_VAULT_A = "0x6f8A7B77b72511cD8939596b1659bA28C28f101B"; // any checksummed address will do: the Admin Safe's string
const HOUSE_VAULT_B = "0x014b996a084690FB27265BfAC157b04e9FeBbF4E";
// The launch vault IS the market's vault of the launch factory's kind (launchFactoryKind: daily on
// the shipped v9 tier1.json, weekly where no launch factory is recorded, e.g. dev.json), so the two are written together.
const withHouseVault = (r, ticker, value) => ({
  ...r,
  markets: r.markets.map((m) => (m.ticker === ticker ? { ...m, v2: { ...m.v2, houseVault: value, house: { ...m.v2.house, [launchFactoryKind(r)]: value } } } : m)),
});
// The shipped tier1.json names the launch vault in v2.contracts.houseVault (the one VerifyV8 walks), and the
// first launch ticker's row must name the same one (option A), so a case that plants a candidate vault on that row
// plants it in the walked slot too. The option-A pairing itself is pinned by its own test below.
const walked = (r, value) => ({ ...r, v2: { ...r.v2, contracts: { ...r.v2.contracts, houseVault: value } } });
const houseVaultIssues = (r, ticker, production = null) =>
  validateV2(r, RECON, production).filter((i) => i.startsWith(`${ticker}: v2.houseVault`));

test("The market skeleton and every committed row carry v2.houseVault, between overrides and house", () => {
  const fresh = firstSeen(read("tier1.json"));
  assert.ok(Object.hasOwn(fresh.v2, "houseVault"), "the skeleton names the key");
  assert.equal(fresh.v2.houseVault, null, "null until a vault is written back");
  const keys = Object.keys(fresh.v2);
  assert.equal(keys[keys.indexOf("houseVault") - 1], "overrides");
  // 59606648 put v2.house {weekly, daily} between houseVault and registeredAt.
  assert.equal(keys[keys.indexOf("houseVault") + 1], "house");
  // Both files are cut to the launch set, and the launch wrote tier1.json's
  // vaults back (v9 mainnet launch 12:02 PM PT 2026-09-25, deployBlock 72462898, stonkctl run 20260925T190245Z
  // write-back; its second commit wrote both); dev.json is pre-broadcast.
  const vaults = { "tier1.json": { NVDA: WRITTEN_BACK.houseVault, SPCX: "0x031AB8C376C31447e766Fb95d19D2369f3806Ce1" }, "dev.json": { NVDA: null, SPCX: null } };
  for (const file of REGISTRIES) {
    const r = read(file);
    assert.deepEqual(r.markets.map((m) => m.ticker), ["NVDA", "SPCX"], `${file}: the launch set's two rows`);
    for (const m of r.markets) {
      assert.ok(Object.hasOwn(m.v2, "houseVault"), `${file} ${m.ticker}: v2.houseVault is a required key`);
      assert.equal(m.v2.houseVault, vaults[file][m.ticker], `${file} ${m.ticker}: v2.houseVault`);
      const k = Object.keys(m.v2);
      assert.equal(k[k.indexOf("houseVault") + 1], "house", `${file} ${m.ticker}: the key sits where the skeleton puts it, so a rebuild writes the same order`);
    }
    // A row without the key is refused by name: the written-back registry must carry it (the external-keys shape).
    const missing = { ...r, markets: r.markets.map((m, i) => (i === 0 ? { ...m, v2: Object.fromEntries(Object.entries(m.v2).filter(([k]) => k !== "houseVault")) } : m)) };
    const issues = validateV2(missing, RECON, file === "dev.json" ? r : null).filter((i) => i.includes("houseVault"));
    assert.ok(issues.length >= 1, `${file}: a row missing v2.houseVault is refused: ${issues.join("; ")}`);
  }
});

test("V2_MARKET_KEYS is exported with houseVault in it, so gen-markets.mjs can close the block from THIS list", () => {
  // web/scripts/gen-markets.mjs imports this constant; its own twelve-name copy threw on the
  // thirteenth key. The position is pinned too: the skeleton, both registries and the generated TS carry the
  // key in this order, so a rebuild writes the same bytes.
  assert.ok(Array.isArray(V2_MARKET_KEYS) && V2_MARKET_KEYS.includes("houseVault"));
  // The per-kind `house` block sits straight after the launch vault it restates. `chainlinkBand` is appended
  // after `registerTx`: that is where `--pin-bands` writes it in both registries and where the skeleton
  // lists it. gen-markets.mjs emits a fixed field list and does not emit it, so the generated TS is unchanged.
  assert.deepEqual(V2_MARKET_KEYS.slice(-5), ["houseVault", "house", "registeredAt", "registerTx", "chainlinkBand"]);
  assert.equal(new Set(V2_MARKET_KEYS).size, V2_MARKET_KEYS.length, "no duplicate name");
});

test("The zero address is refused by name -- DeployHouseVault's 'not created yet' value is null here, never 0x0", async () => {
  const r = read("tier1.json");
  withSynthetic(r, "AMD", 1); // A market outside the launch set, now that the registry has none
  const ZERO = `0x${"0".repeat(40)}`;
  for (const ticker of [r.launchSet.markets[0], "AMD"]) {
    const issues = houseVaultIssues(withHouseVault(r, ticker, ZERO), ticker);
    assert.ok(issues.some((i) => i.includes("is the zero address") && i.includes("never as 0x0")), `${ticker}: ${issues.join("; ")}`);
  }
  // Positive control on the shape of the value: zero IS an address and IS its own checksum, so without this rule
  // it would pass both the shape check and the cast rule -- which is why the rule exists.
  assert.deepEqual(houseVaultIssues(withHouseVault(r, "NVDA", ZERO), "NVDA").filter((i) => i.includes("must be null or an address")), []);
  assert.deepEqual(await checksumMarketHouseVaults(withHouseVault(r, "NVDA", ZERO)), []);
});

test("A checksummed vault on a launch-set market passes; on a market outside the launch set it is refused by name", () => {
  const r = read("tier1.json");
  assert.deepEqual(r.launchSet.markets, ["NVDA", "SPCX"], "the owner's launch set, the rule's input");
  for (const ticker of r.launchSet.markets) {
    assert.deepEqual(houseVaultIssues(withHouseVault(walked(r, HOUSE_VAULT_A), ticker, HOUSE_VAULT_A), ticker), [], `${ticker}: a launched market may carry a vault`);
  }
  // Every shipped row is a launch row now, so the market outside the set is a synthetic one.
  const outsideReg = structuredClone(r);
  const outside = withSynthetic(outsideReg, "MU", 1).ticker;
  assert.ok(!r.launchSet.markets.includes(outside));
  const refused = houseVaultIssues(withHouseVault(outsideReg, outside, HOUSE_VAULT_A), outside);
  assert.equal(refused.length, 1, `${outside}: exactly one refusal: ${refused.join("; ")}`);
  assert.ok(refused[0].includes("not in launchSet.markets") && refused[0].includes("NVDA, SPCX"), refused[0]);
  // Shape: a non-address is refused offline, on any market.
  const bad = houseVaultIssues(withHouseVault(walked(r, null), "NVDA", "0xnot-an-address"), "NVDA");
  assert.ok(bad.some((i) => i.includes("must be null or an address")), bad.join("; "));
  // No launch set (a dev registry judged on its own): any market may carry one. dev.json has no launchSet.
  const dev = read("dev.json");
  assert.ok(!("launchSet" in dev), "dev.json carries no launch set");
  withSynthetic(dev, outside, 2);
  assert.deepEqual(houseVaultIssues(withHouseVault(dev, outside, HOUSE_VAULT_A), outside, r), [], "without a launch set the rule does not apply");
});

test("The first launch ticker's vault must be the one v2.contracts.houseVault names; the second ticker's need not", () => {
  const r = read("tier1.json");
  const [first, second] = r.launchSet.markets;
  const both = (ticker, marketValue, walked) => withHouseVault({ ...r, v2: { ...r.v2, contracts: { ...r.v2.contracts, houseVault: walked } } }, ticker, marketValue);
  assert.deepEqual(houseVaultIssues(both(first, HOUSE_VAULT_A, HOUSE_VAULT_A), first), [], "same address in both slots");
  assert.deepEqual(houseVaultIssues(both(first, HOUSE_VAULT_A, null), first), [], "the walked slot not yet written: fine");
  assert.deepEqual(houseVaultIssues(both(first, null, HOUSE_VAULT_A), first), [], "the market slot not yet written: fine");
  const clash = houseVaultIssues(both(first, HOUSE_VAULT_A, HOUSE_VAULT_B), first);
  assert.equal(clash.length, 1, clash.join("; "));
  assert.ok(clash[0].includes("is not v2.contracts.houseVault") && clash[0].includes("option A"), clash[0]);
  // The second launch ticker has its own vault, which is NOT the walked one, and that is the point of the test.
  assert.deepEqual(houseVaultIssues(both(second, HOUSE_VAULT_B, HOUSE_VAULT_A), second), [], "the second vault differs from the walked one by design");
});

test("--check's cast rule refuses a lowercase vault by name and accepts the EIP-55 form (positive control on the checker)", async () => {
  const r = read("tier1.json");
  assert.deepEqual(await checksumMarketHouseVaults(r), [], "the committed registry's written-back vaults are EIP-55");
  assert.deepEqual(await checksumMarketHouseVaults(withHouseVault(r, "NVDA", HOUSE_VAULT_A)), [], "a checksummed address passes");
  await assertStrictEip55("HOUSE_VAULT_A", HOUSE_VAULT_A);
  const lower = await checksumMarketHouseVaults(withHouseVault(r, "NVDA", HOUSE_VAULT_A.toLowerCase()));
  assert.equal(lower.length, 1, lower.join("; "));
  assert.ok(lower[0].startsWith("NVDA: v2.houseVault") && lower[0].includes("is not checksummed") && lower[0].includes(HOUSE_VAULT_A), lower[0]);
  // The offline validator does not judge case (it cannot without cast): a lowercase address is shape-valid there,
  // which is why the cast rule is wired into --check and this test exists.
  assert.deepEqual(houseVaultIssues(withHouseVault(walked(r, HOUSE_VAULT_A.toLowerCase()), "NVDA", HOUSE_VAULT_A.toLowerCase()), "NVDA"), []);
});

test("A rebuild carries v2.houseVault as written (the block is carried, never merged), so the key cannot vanish or be defaulted", () => {
  const r = read("tier1.json");
  const set = withHouseVault(r, "NVDA", HOUSE_VAULT_A);
  const prev = set.markets.find((m) => m.ticker === "NVDA");
  const rebuilt = assembleMarket(prev, { ...runFrom(prev, set), ticker: "NVDA" });
  assert.equal(rebuilt.v2.houseVault, HOUSE_VAULT_A, "carried verbatim");
  assert.deepEqual(marketKeyIssues(prev, rebuilt), []);
});

test("encodePoolKey refuses a tickSpacing outside [1, 32767] by name, before encoding; the validator holds the same rule", async () => {
  const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const nvda = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
  const key = (tickSpacing) => ({ ...routeCurrencies(nvda, usdg), fee: 500, tickSpacing, hooks: `0x${"0".repeat(40)}` });
  // Positive control: both ends of the range encode, to five 32-byte hex words.
  for (const ts of [1, 10, 32767]) {
    assert.match(encodePoolKey(key(ts)), /^0x[\da-f]{320}$/, `tickSpacing ${ts} must encode`);
    assert.equal(isTickSpacing(ts), true);
  }
  // -1 used to encode as a word containing "-1" (BigInt(-1).toString(16)), which is not hex at all.
  for (const ts of [-1, -60, 0, 32768, 1.5, "10", null, undefined]) {
    assert.throws(() => encodePoolKey(key(ts)), /encodePoolKey: tickSpacing .* must be an integer in \[1, 32767\]/, `tickSpacing ${JSON.stringify(ts)} encoded`);
    assert.equal(isTickSpacing(ts), false, `isTickSpacing(${JSON.stringify(ts)})`);
  }
  // poolIdIssues must not reach the throw: a bad spacing is the validator's named finding, not a crash of --check.
  const r = read("tier1.json");
  const m = r.markets.find((x) => x.ticker === "NVDA");
  m.v2.payoutRoute = { venue: "v4", fee: 500, tickSpacing: -1, poolId: `0x${"ab".repeat(32)}` };
  assert.deepEqual(await poolIdIssues(r), []);
  const issues = [];
  validatePayoutRoute(m, r, RECON, issues);
  assert.ok(issues.some((i) => i.includes("v2.payoutRoute.tickSpacing -1 must be an integer in [1, 32767]")), issues.join("\n"));
});

/*
 * The House blocks, in the shape the daily-HouseVault deploy's
 * step 2 writes back: v2.house.factories[] { kind, address, deployBlock } and
 * markets[].v2.house { weekly, daily }. The kind of a vault comes from the factory it was enumerated from.
 */
/**
 * The v8 House shape, rebuilt from the shipped v9 tier1.json (which records the daily shape): a
 * synthetic WEEKLY launch factory as the only factory entry, each launch vault in its market's weekly slot.
 */
const V8_WEEKLY_FACTORY = `0x${"0".repeat(36)}8001`;
function v8House(r) {
  r.v2.contracts.houseVaultFactory = V8_WEEKLY_FACTORY;
  r.v2.house.factories = [{ kind: "weekly", address: V8_WEEKLY_FACTORY, deployBlock: r.v2.externalDeployBlocks.houseVaultFactory }];
  for (const m of r.markets) m.v2 = { ...m.v2, house: { weekly: m.v2.houseVault, daily: null } };
  return r;
}

test("The shipped registry records the launch factory as daily (v9) and each launch vault as its market's daily vault", () => {
  assert.deepEqual(HOUSE_FACTORY_KINDS, ["weekly", "daily"]);
  assert.deepEqual(HOUSE_MARKET_KEYS, ["weekly", "daily"]);
  const tier1 = read("tier1.json");
  // Read from the registry itself: the launch (daily) entry is v2.contracts.houseVaultFactory at its
  // externals start block, and it is the only entry: no weekly factory was deployed at the v9 launch.
  assert.deepEqual(tier1.v2.house.factories, [{ kind: "daily", address: tier1.v2.contracts.houseVaultFactory, deployBlock: tier1.v2.externalDeployBlocks.houseVaultFactory }]);
  assert.equal(launchFactoryKind(tier1), "daily");
  for (const t of tier1.launchSet.markets) {
    const m = tier1.markets.find((x) => x.ticker === t);
    assert.ok(m.v2.houseVault !== null, `${t}: the launch vault is written back`);
    assert.deepEqual(m.v2.house, { weekly: null, daily: m.v2.houseVault }, t);
  }
  for (const file of REGISTRIES) {
    for (const m of read(file).markets) assert.deepEqual(Object.keys(m.v2.house), HOUSE_MARKET_KEYS, `${file} ${m.ticker}`);
  }
  // dev.json deploys the same launch tickers' House vaults, so it carries the same limits block.
  assert.deepEqual(read("dev.json").v2.house, { factories: [], limits: tier1.v2.house.limits });
  assert.deepEqual(allIssuesFor(() => {}).filter((i) => i.includes("house")), []);
  assert.deepEqual(allIssuesFor(() => {}, "dev.json").filter((i) => i.includes("house")), []);
});

test("The factories list and each market's house block are refused by name when they break the shape", () => {
  // The v8 shape (weekly launch factory plus a separate daily one) is what these cases are about: v8House rebuilds it.
  const houseIssues = (mutate, file) => allIssuesFor((r) => { v8House(r); mutate(r); }, file).filter((i) => i.includes("house"));
  const DAILY_FACTORY = `0x${"0".repeat(36)}da11`;
  const DAILY_VAULT = `0x${"0".repeat(36)}da12`;
  const nvda = (r) => r.markets.find((m) => m.ticker === "NVDA");
  const withDaily = (r) => r.v2.house.factories.push({ kind: "daily", address: DAILY_FACTORY, deployBlock: 70300000 });
  // A daily vault on a pooled launch market, with a daily factory recorded: the deploy runbook's written-back shape.
  assert.deepEqual(houseIssues((r) => { withDaily(r); nvda(r).v2.house.daily = DAILY_VAULT; }), []);
  // ... without the daily factory, on a market with no pool, or equal to the weekly vault: refused.
  assert.ok(houseIssues((r) => { nvda(r).v2.house.daily = DAILY_VAULT; }).some((i) => i.includes("has no daily factory")));
  assert.ok(houseIssues((r) => { withDaily(r); const m = nvda(r); m.v2.house.daily = DAILY_VAULT; m.v2.univ3Pool = null; m.v2.univ3MinLiquidity = null; }).some((i) => i.includes("v2.house.daily needs a v2.univ3Pool")));
  assert.ok(houseIssues((r) => { withDaily(r); const m = nvda(r); m.v2.house.daily = m.v2.houseVault; }).some((i) => i.includes("equals its weekly vault")));
  // The weekly vault is the launch vault.
  assert.ok(houseIssues((r) => { nvda(r).v2.house.weekly = DAILY_VAULT; }).some((i) => i.startsWith("NVDA: v2.house.weekly") && i.includes("is not v2.houseVault")));
  assert.ok(houseIssues((r) => { nvda(r).v2.house = { weekly: nvda(r).v2.houseVault }; }).some((i) => i.includes("NVDA: v2.house")));
  // Factories: two of one kind, a bad kind, a weekly entry that is not the launch factory, a non-list.
  assert.ok(houseIssues((r) => { withDaily(r); withDaily(r); }).some((i) => i.includes("a second daily factory")));
  assert.ok(houseIssues((r) => { r.v2.house.factories[0].kind = "monthly"; }).some((i) => i.includes("kind must be one of")));
  assert.ok(houseIssues((r) => { r.v2.house.factories[0].address = DAILY_FACTORY; }).some((i) => i.includes("the weekly entry IS the launch factory")));
  assert.ok(houseIssues((r) => { r.v2.house.factories = {}; }).some((i) => i.includes("must be a list")));
  assert.ok(houseIssues((r) => { delete r.v2.house; }).some((i) => i.includes("v2")) || allIssuesFor((r) => { delete r.v2.house; }).length > 0, "the root key is required");
});

/*
 * v9's launch factory is a kind-aware factory from which the redeploy creates DAILY
 * vaults only. The launch path
 * (registry-env.sh) records it as the DAILY entry at v2.contracts.houseVaultFactory, each launch vault at
 * markets[T].v2.house.daily, and the same vault in the launch vault slots. v9Launch() is tier1.json in that shape.
 * Digit-only synthetic addresses, so no EIP-55 casing is in play.
 */
const V9_FACTORY = `0x${"0".repeat(36)}9001`;
const V9_NVDA = `0x${"0".repeat(36)}9002`;
const V9_SPCX = `0x${"0".repeat(36)}9003`;
function v9Launch({ launchSlots = true } = {}) {
  const r = read("tier1.json");
  r.v2.contracts.houseVaultFactory = V9_FACTORY;
  r.v2.externalDeployBlocks.houseVaultFactory = 70300000;
  r.v2.house.factories = [{ kind: "daily", address: V9_FACTORY, deployBlock: 70300000 }];
  r.v2.contracts.houseVault = launchSlots ? V9_NVDA : null;
  if (!launchSlots) r.v2.externalDeployBlocks.houseVault = null;
  for (const m of r.markets) {
    const d = m.ticker === "NVDA" ? V9_NVDA : m.ticker === "SPCX" ? V9_SPCX : null;
    m.v2 = { ...m.v2, houseVault: launchSlots ? d : null, house: { weekly: null, daily: d } };
  }
  return r;
}
const houseOnly = (issues) => issues.filter((i) => /house/i.test(i));
const completeness = (r) => { const issues = []; validateDeployedCompleteness(r, issues); return issues; };

test("launchFactoryKind is the kind of the factory entry at v2.contracts.houseVaultFactory", () => {
  assert.equal(launchFactoryKind(v8House(read("tier1.json"))), "weekly", "v8: the launch factory is the weekly entry");
  assert.equal(launchFactoryKind(read("tier1.json")), "daily", "the shipped v9 tier1.json: the launch factory is the daily entry");
  assert.equal(launchFactoryKind(v9Launch()), "daily", "v9: the launch factory is the daily entry");
  const noEntry = v9Launch(); noEntry.v2.house.factories = [];
  assert.equal(launchFactoryKind(noEntry), "weekly", "no entry: the implied pre-T-OP-101 launch factory");
  const both = v9Launch(); both.v2.house.factories.unshift({ kind: "weekly", address: V9_FACTORY, deployBlock: 70300000 });
  assert.equal(launchFactoryKind(both), null, "both kinds at one address: ambiguous");
  assert.equal(launchFactoryKind(read("dev.json")), "weekly", "no launch factory recorded");
});

test("A v9 registry (daily launch factory, daily launch vaults) validates, with or without the launch vault slots", () => {
  assert.deepEqual(houseOnly(validateV2(v9Launch(), RECON, null)), []);
  assert.deepEqual(houseOnly(completeness(v9Launch())), [], "and the go-live check passes: every launch market lists its daily vault");
  // The House write-back alone (write-back-v8.mjs --house-deployment) writes house.daily and leaves the launch slots null.
  assert.deepEqual(houseOnly(validateV2(v9Launch({ launchSlots: false }), RECON, null)), []);
  assert.deepEqual(houseOnly(completeness(v9Launch({ launchSlots: false }))), []);
  // Control: the v8 shape still validates under the unchanged weekly rule (v8House; the shipped file is v9's).
  assert.deepEqual(houseOnly(validateV2(v8House(read("tier1.json")), RECON, null)), []);
  assert.deepEqual(houseOnly(validateV2(read("tier1.json"), RECON, null)), [], "and the shipped v9 tier1.json");
});

test("A v9 record that claims both kinds, or disagrees, is refused by name", () => {
  const nvda = (r) => r.markets.find((m) => m.ticker === "NVDA");
  const issuesOf = (mutate) => { const r = v9Launch(); mutate(r); return houseOnly(validateV2(r, RECON, null)); };
  // The launch vault slot names a vault that is not the market's daily vault.
  assert.ok(issuesOf((r) => { nvda(r).v2.houseVault = V9_SPCX; }).some((i) => i.startsWith("NVDA: v2.houseVault") && i.includes("is not v2.house.daily") && i.includes("the launch factory is daily")));
  // PLAUSIBLE WRONG FIX (b): the daily vault written into the weekly slot so the old rule passes. Refused both ways.
  const inWeekly = issuesOf((r) => { nvda(r).v2.house = { weekly: V9_NVDA, daily: null }; });
  assert.ok(inWeekly.some((i) => i.startsWith("NVDA: v2.house.weekly") && i.includes("no weekly factory is recorded")), inWeekly.join("; "));
  assert.ok(inWeekly.some((i) => i.startsWith("NVDA: v2.houseVault") && i.includes("is not v2.house.daily")), inWeekly.join("; "));
  // One launch factory under both kinds.
  const both = issuesOf((r) => { r.v2.house.factories.unshift({ kind: "weekly", address: V9_FACTORY, deployBlock: 70300000 }); });
  assert.ok(both.some((i) => i.includes("recorded as BOTH the weekly and the daily factory")), both.join("; "));
  // A weekly entry that is not the launch factory is still refused (the existing rule).
  const otherWeekly = issuesOf((r) => { r.v2.house.factories.push({ kind: "weekly", address: `0x${"0".repeat(36)}9009`, deployBlock: 70300001 }); });
  assert.ok(otherWeekly.some((i) => i.includes("the weekly entry IS the launch factory")), otherWeekly.join("; "));
});

test("The go-live check refuses a deployed v9 registry that does not list every launch market's House vault", () => {
  const pending = v9Launch();
  const spcx = pending.markets.find((m) => m.ticker === "SPCX");
  spcx.v2 = { ...spcx.v2, houseVault: null, house: { weekly: null, daily: null } };
  const missing = completeness(pending);
  assert.deepEqual(missing.filter((i) => i.startsWith("SPCX: v2.house.daily is null")).length, 1, missing.join("; "));
  assert.ok(missing[missing.length - 1].includes("the indexer watches only the House vaults the registry lists"));
  // A recorded launch factory with no factory entry cannot say its kind: refused once the deployment is written back.
  const noEntry = v9Launch({ launchSlots: false });
  noEntry.v2.house.factories = [];
  for (const m of noEntry.markets) m.v2 = { ...m.v2, house: { weekly: null, daily: null } };
  assert.ok(completeness(noEntry).some((i) => i.startsWith(`v2.contracts.houseVaultFactory ${V9_FACTORY} has no v2.house.factories entry`)));
  // Not deployed (no v2.deployBlock): not a go-live registry, so nothing is required yet.
  const predeploy = structuredClone(pending); predeploy.v2.deployBlock = null;
  assert.deepEqual(houseOnly(completeness(predeploy)), []);
  // v8: the weekly launch factory is discovered on the legacy topic the indexer already watches; not this check's case.
  assert.deepEqual(houseOnly(completeness(v8House(read("tier1.json")))), []);
  // The shipped v9 tier1.json lists every launch market's daily vault.
  assert.deepEqual(houseOnly(completeness(read("tier1.json"))), []);
});

test("The go-live House rule skips a launch-set market only while it is unregistered", () => {
  // A market listed after the launch (stonkctl list-market) joins launchSet.markets before RegisterMarkets runs, and
  // its daily vault is created with the registration. While v2.registeredAt is null it is not yet a go-live market.
  const listing = v9Launch();
  const spcx = listing.markets.find((m) => m.ticker === "SPCX");
  spcx.v2 = { ...spcx.v2, houseVault: null, house: { weekly: null, daily: null }, registeredAt: null, registerTx: null };
  assert.deepEqual(houseOnly(completeness(listing)).filter((i) => i.startsWith("SPCX:")), [],
    "unregistered: no House vault required yet");
  // REGISTERED with no daily vault still fails, whatever else the row says.
  const registered = structuredClone(listing);
  const r = registered.markets.find((m) => m.ticker === "SPCX");
  r.v2.registeredAt = 1790066516;
  r.v2.registerTx = `0x${"ab".repeat(32)}`;
  const issues = completeness(registered);
  assert.equal(issues.filter((i) => i.startsWith("SPCX: v2.house.daily is null")).length, 1, issues.join("; "));
  // The skip is per market: NVDA (registered, vault listed) is unaffected in both registries.
  assert.deepEqual(houseOnly(completeness(listing)).filter((i) => i.startsWith("NVDA:")), []);
});

/*//////////////////////////////////////////////////////////////
          --check runs the route-liquidity check
//////////////////////////////////////////////////////////////*/

test("main() runs liquidityCheck on the registry it judges and makes its FAILs v2 problems", () => {
  const src = readFileSync(path.join(HERE, "build-markets.mjs"), "utf8");
  const main = src.slice(src.indexOf("async function main()"));
  // Named lines, not a behaviour test: main() reads the feed directory and the chain, so it cannot run here. What
  // this pins is that the call exists, is made on `subject` (the committed file under --check), and that its issues
  // join v2Issues -- which is what turns them into exit 1 under --check and after a build.
  assert.match(main, /const routes = await liquidityCheck\(subject, block\);/);
  assert.match(main, /v2Issues\.push\(\.\.\.routes\.issues\);/);
  assert.ok(main.indexOf("liquidityCheck(subject") < main.indexOf("if (CHECK_ONLY) {"), "the check runs before --check decides");
});

test("liquidityCheck passes the route check's FAILs through unchanged", async () => {
  // A deployed registry (deployBlock set) without the router/TWAP addresses is refused by the check without any read.
  const registry = structuredClone(read("tier1.json"));
  delete registry.v2.contracts.sources;
  const out = await liquidityCheck(registry, 1, { routerV4: async () => assert.fail("no read may happen") });
  assert.equal(out.issues.length, 1);
  assert.match(out.issues[0], /^route liquidity: .*nothing measured$/);
});

test("A _dev registry skips the route check with a logged reason, never silently", async () => {
  const out = await liquidityCheck(read("dev.json"), 1, { routerV4: async () => assert.fail("no read may happen") });
  assert.deepEqual(out.issues, []);
  assert.match(out.reports[0], /skipped for a _dev registry/);
});

/*//////////////////////////////////////////////////////////////
   The live v8 routes FAIL; --check stays red and says why
//////////////////////////////////////////////////////////////*/

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
/** Depths within ±100 bps, USD, measured at block 70981224 (rpc.mainnet.chain.robinhood.com) by route-liquidity.mjs. */
const MEASURED_509 = {
  NVDA: { routeUsd: 758, v3Usd: 709_893, routeProtocolFee: 0 },
  // 1000 pips of protocol fee on each side: lpFee 10000 + 1000 = 11000 pips, over MAX_ROUTE_FEE_TIER.
  SPCX: { routeUsd: 45_244, v3Usd: 235_947, routeProtocolFee: (1000 << 12) | 1000 },
};

/**
 * The v8 routes MEASURED_509 was measured on (v8's v4 routes, tier1.json before the v9 launch). The shipped
 * tier1.json is the v9 launch's and carries the v3 pins, so the v8-shape cases put these back with v8Routes.
 */
const V8_ROUTES_509 = {
  NVDA: { venue: "v4", fee: 375, tickSpacing: 4, poolId: "0xdf5c0bcd967d54774c139a4ef803ec994779736346fb4c21b50ed241b1fd2682" },
  SPCX: { venue: "v4", fee: 10000, tickSpacing: 200, poolId: "0xcb6ffbcc84359535c2cc0a5688c0a76520ea6e0a4820fddd3ac8d7880e576370" },
};
const v8Routes = (r) => {
  for (const m of r.markets) m.v2 = { ...m.v2, payoutRoute: { ...V8_ROUTES_509[m.ticker] } };
  return r;
};

/**
 * A fake chain for the committed tier1.json's two markets, driven through the REAL routeLiquidityIssues by
 * liquidityCheck. Each market has its v3 fee-500 pool (its `v2.univ3Pool`, the pin's pool) and the v4 pool its v8
 * route names (V8_ROUTES_509), at the depths measured on chain. `live` picks what PayoutRouter.routes(asset) returns:
 * the v8 v4 route ("committed", the router v8 ran) or the v3 pin. The pools are constant-L at spot 200 with no
 * initialized ticks, so depth is linear in L and each L is sized with route-liquidity.mjs's own depth(). The buyback
 * executor and token pool are dropped from the registry: they are reported, never failing, and are not what this
 * test is about.
 */
function chain509(registry, { live }) {
  delete registry.v2.flywheel;
  delete registry.shared.token;
  const usdg = registry.shared.usdg.toLowerCase();
  const committed = new Map(Object.entries(V8_ROUTES_509));
  const byAsset = new Map(registry.markets.map((m) => [m.asset.toLowerCase(), m]));
  const stateOf = (m, usd, extra) => {
    const quoteIsToken0 = usdg < m.asset.toLowerCase();
    const P = quoteIsToken0 ? 5e9 : 2e-10; // raw token1 per raw token0 at 200 USDG (6 dp) per asset (18 dp)
    const s = { sqrtPriceX96: BigInt(Math.round(Math.sqrt(P) * 2 ** 96)), tick: Math.floor(Math.log(P) / Math.log(1.0001)), ticks: [] };
    const unit = depth({ ...s, liquidity: 10n ** 18n }, { quoteIsToken0, quoteDecimals: 6 }).weaker;
    return { ...s, liquidity: BigInt(Math.round((usd / unit) * 1e18)), ...extra };
  };
  const v3 = new Map();
  const v4 = new Map();
  for (const m of registry.markets) {
    const x = MEASURED_509[m.ticker];
    const route = committed.get(m.ticker);
    v3.set(m.v2.univ3Pool.toLowerCase(), stateOf(m, x.v3Usd, { tickSpacing: 10, fee: 500 }));
    v4.set(route.poolId, { m, fee: route.fee, tickSpacing: route.tickSpacing, state: stateOf(m, x.routeUsd, { tickSpacing: route.tickSpacing, lpFee: route.fee, protocolFee: x.routeProtocolFee }) });
  }
  const marketOf = (a, b) => byAsset.get(a.toLowerCase()) ?? byAsset.get(b.toLowerCase());
  return {
    decimals: async (t) => (t.toLowerCase() === usdg ? 6 : 18),
    routerV4: async () => ({ poolManager: addr(7001), stateView: addr(7002) }),
    payoutRoute: async (_router, asset) => {
      const m = byAsset.get(asset.toLowerCase());
      if (live === "pin") return { venue: "v3", fee: 500, tickSpacing: 10, v3Pool: m.v2.univ3Pool };
      const r = committed.get(m.ticker);
      return { venue: r.venue, fee: r.fee, tickSpacing: r.tickSpacing, v3Pool: ZERO_ADDR };
    },
    // The most a route's fee is credited; high enough that no cached-fee staleness line is part of this test.
    routeFeeBps: async () => 100,
    twapPool: async (_source, asset) => byAsset.get(asset.toLowerCase()).v2.univ3Pool,
    v3GetPool: async (_factory, a, b, fee) => (fee === 500 ? marketOf(a, b).v2.univ3Pool : ZERO_ADDR),
    v4Initialized: async (_pm, c0, c1) => {
      const m = marketOf(c0, c1);
      return [...v4.entries()].filter(([, p]) => p.m === m).map(([poolId, p]) => ({ poolId, fee: p.fee, tickSpacing: p.tickSpacing, hooks: ZERO_ADDR }));
    },
    v4LiquidityMany: async (_sv, ids) => ids.map((id) => ({ liquidity: v4.get(id).state.liquidity, sqrtPriceX96: v4.get(id).state.sqrtPriceX96 })),
    v3Pool: async (p) => v3.get(p.toLowerCase()),
    v4Pool: async (_sv, id) => v4.get(id).state,
    executorPools: async () => assert.fail("the executor was dropped from this registry"),
  };
}

test("The live v8 routes FAIL for both launch markets, every FAIL is kept, and one line per market names the v9 fix", async () => {
  const registry = v8Routes(clone()); // the v8 shape: registered launch markets on their v4 routes
  assert.deepEqual(registry.markets.map((m) => m.ticker), registry.launchSet.markets, "tier1.json is the launch set and nothing else");
  const out = await liquidityCheck(registry, 1, chain509(registry, { live: "committed" }));
  const fails = out.issues.filter((i) => / is (SHALLOW|TOO EXPENSIVE) — /.test(i));
  assert.equal(fails.length, 3, out.issues.join("\n"));
  assert.match(fails[0], /^NVDA: NVDA payout route \(registry v4 375\/4 .*\) is SHALLOW — depth \$758 within ±100 bps is below the \$50,000 floor; holds 0\.1 % of the depth of the deepest candidate v3 500 /);
  assert.match(fails[1], /^SPCX: SPCX payout route \(registry v4 10000\/200 .*\) is SHALLOW — depth \$45,244 .*holds 19\.2 % of the depth/);
  assert.match(fails[2], /^SPCX: SPCX payout route .* is TOO EXPENSIVE — lpFee 10000 \+ protocol fee 1000 pips on the sell side = 11000 pips/);
  const why = out.issues.filter((i) => !fails.includes(i));
  assert.equal(why.length, 2, why.join("\n"));
  assert.match(why[0], /^NVDA: the payout-route FAILs above are the LIVE route \(v4 fee 375 tickSpacing 4 on PayoutRouter 0x[0-9a-fA-F]{40}\), not the pin v3 fee 500 /);
  assert.match(why[1], /^SPCX: the payout-route FAILs above are the LIVE route \(v4 fee 10000 tickSpacing 200 /);
  for (const w of why) {
    assert.match(w, /is in launchSet\.markets, so no exemption applies/);
    assert.match(w, /The v9 redeploy clears them: stonkctl runs --pin-routes .* setRouteV3\(asset, 500\) on the new router/);
  }
  assert.ok(out.issues.indexOf(why[0]) > out.issues.indexOf(fails[2]), "the explanation follows the FAILs");
});

test("No exemption. The wrapper never drops a launch market's route FAIL; it only appends", async () => {
  // No low-liquidity route anywhere, and no exemption for NVDA or SPCX. So whatever
  // liquidityCheck adds, every FAIL routeLiquidityIssues raised for a launch market is still in its output, in order.
  const registry = v8Routes(clone()); // the v8 shape: registered launch markets on their v4 routes
  const out = await liquidityCheck(registry, 1, chain509(registry, { live: "committed" }));
  const raw = out.issues.filter((i) => !/: the payout-route FAILs above are the LIVE route /.test(i));
  assert.deepEqual(out.issues.slice(0, raw.length), raw, "the check's own lines come first, unchanged");
  for (const t of registry.launchSet.markets) assert.ok(raw.some((i) => i.startsWith(`${t}: ${t} payout route `)), `${t}'s FAIL is kept`);
});

test("At the v9 write-back (routes are the v3 pins, on chain and in the registry) the check is green", async () => {
  // What `--pin-routes` writes, and what RegisterMarkets then sets on the router: this is the state that clears the failure.
  const registry = clone();
  for (const m of registry.markets) m.v2 = pinPayoutRoute(m.ticker, m.v2);
  const out = await liquidityCheck(registry, 1, chain509(registry, { live: "pin" }));
  assert.deepEqual(out.issues, []);
});

test("Registry and router disagreeing is route-liquidity's own drift line, and no v9 line is added", async () => {
  // The router already holds the v3 pin but the registry still records v4: the fix is the write-back, not a route.
  const registry = v8Routes(clone());
  const out = await liquidityCheck(registry, 1, chain509(registry, { live: "pin" }));
  assert.ok(out.issues.some((i) => /^NVDA: registry v2\.payoutRoute is v4 fee 375 tickSpacing 4 but PayoutRouter\.routes\(asset\) on chain is v3 fee 500/.test(i)), out.issues.join("\n"));
  assert.equal(out.issues.filter((i) => /the payout-route FAILs above are the LIVE route/.test(i)).length, 0, out.issues.join("\n"));
});

test("pinNotLiveIssues is silent unless a registered, pinned market's non-pin route FAILs", () => {
  const failing = (ticker) => ({ ticker, refs: [{ role: "payoutRoute", verdict: { ok: false }, feeVerdict: { ok: true } }] });
  const passing = (ticker) => ({ ticker, refs: [{ role: "payoutRoute", verdict: { ok: true }, feeVerdict: { ok: true } }] });
  const feeOnly = (ticker) => ({ ticker, refs: [{ role: "payoutRoute", verdict: { ok: true }, feeVerdict: { ok: false } }] });
  const oracleOnly = (ticker) => ({ ticker, refs: [{ role: "univ3Pool", verdict: { ok: false } }] });
  const r = v8Routes(clone()); // the v8 shape: registered launch markets on their v4 routes
  const lines = (reg, pairs, issues = []) => pinNotLiveIssues(reg, { issues, pairs });
  // The control: both launch markets FAIL on their v8 v4 routes.
  assert.deepEqual(lines(r, [failing("NVDA"), failing("SPCX")]).map((l) => l.split(":")[0]), ["NVDA", "SPCX"]);
  assert.deepEqual(lines(r, [feeOnly("SPCX")]).map((l) => l.split(":")[0]), ["SPCX"], "a fee FAIL counts too");
  // Passing, or only the oracle pool failing (a TWAP pool is not a payout route): nothing.
  assert.deepEqual(lines(r, [passing("NVDA"), passing("SPCX")]), []);
  assert.deepEqual(lines(r, [oracleOnly("NVDA")]), []);
  // Already on the pin: a FAIL there is a different problem and speaks for itself.
  const pinned = clone();
  for (const m of pinned.markets) m.v2 = pinPayoutRoute(m.ticker, m.v2);
  assert.deepEqual(lines(pinned, [failing("NVDA"), failing("SPCX")]), []);
  // Not registered yet: validatePayoutRoutePins speaks for it.
  const unregistered = v8Routes(clone());
  unregistered.markets[0].v2.registeredAt = null;
  assert.deepEqual(lines(unregistered, [failing("NVDA"), failing("SPCX")]).map((l) => l.split(":")[0]), ["SPCX"]);
  // Registry-vs-router drift already named for the market: nothing more.
  assert.deepEqual(lines(r, [failing("NVDA")], ["NVDA: registry v2.payoutRoute is v4 fee 375 tickSpacing 4 but PayoutRouter.routes(asset) on chain is v3 fee 500: x"]), []);
  // No pin (a synthetic, routeless market outside the pin table): nothing.
  const other = clone();
  const syn = withSynthetic(other, V2_PAYOUT_ROUTE_DELIBERATELY_NULL[0], 1);
  syn.v2.payoutRoute = { venue: "v3", fee: 3000 };
  syn.v2.registeredAt = 1;
  assert.equal(V2_PAYOUT_ROUTE_PINS[syn.ticker], undefined);
  assert.deepEqual(lines(other, [failing(syn.ticker)]), []);
  // A pinned market outside launchSet.markets is explained without the launch-set sentence.
  const noLaunch = v8Routes(clone());
  noLaunch.launchSet.markets = ["SPCX"];
  const [nvda] = lines(noLaunch, [failing("NVDA")]);
  assert.doesNotMatch(nvda, /launchSet\.markets/);
  assert.match(nvda, /The v9 redeploy clears them/);
});

/* ------------------------------------------------------------------ the registry owns every launch knob */

test("The launch-knob blocks are exact, typed and required, in both committed registries", () => {
  // Required: an absent block is named by the exact-key check (both projections refuse a missing key by name).
  assert.ok(allIssuesFor((r) => delete r.v2.flywheel.config).includes("v2.flywheel.config is missing"));
  assert.ok(allIssuesFor((r) => delete r.v2.keeper).includes("v2.keeper is missing"));
  assert.ok(allIssuesFor((r) => delete r.v2.earn).includes("v2.earn is missing"));
  assert.ok(allIssuesFor((r) => delete r.v2.fees.payoutSlippageBps).includes("v2.fees.payoutSlippageBps is missing"));
  assert.ok(allIssuesFor((r) => delete r.v2.defaults.univ3WindowS).includes("v2.defaults.univ3WindowS is missing"));
  // Exact: a misspelt knob would reach the projections as a missing value, so it is refused here first.
  const typo = allIssuesFor((r) => { r.v2.flywheel.config.burnBp = 1; delete r.v2.flywheel.config.burnBps; });
  assert.ok(typo.some((i) => i.startsWith("v2.flywheel.config.burnBp is not a known key")), typo.join("; "));
  assert.ok(typo.includes("v2.flywheel.config.burnBps is missing"), typo.join("; "));
  // Typed: bps as integers in range, big amounts as decimal strings, like the vault's uint128 fields.
  const bad = allIssuesFor((r) => {
    r.v2.flywheel.config.burnBps = 10_001;
    r.v2.flywheel.config.buybackCap = 50_000_000; // a JSON number, not the decimal string
    r.v2.flywheel.config.buybackTwapWindowS = 0;
    r.v2.earn.skimBps = 10_001;
    r.v2.keeper.dailyCap = 100_000_000;
    r.v2.fees.payoutSlippageBps = 301;
  });
  for (const want of [
    "v2.flywheel.config.burnBps must be an integer in [0, 10000]",
    "v2.flywheel.config.buybackCap must be a decimal string in [0, 115792089237316195423570985008687907853269984665640564039457584007913129639935]",
    "v2.flywheel.config.buybackTwapWindowS must be > 0: a zero TWAP window reads no price",
    "v2.earn.skimBps must be an integer in [0, 10000]",
    "v2.keeper.dailyCap must be a decimal string of USDG base units",
    "v2.fees.payoutSlippageBps must be an integer in [0, 300]",
  ]) assert.ok(bad.includes(want), `missing "${want}" in: ${bad.join("; ")}`);
  // A present block of the wrong type is named once, not twice.
  const notObject = allIssuesFor((r) => { r.v2.keeper = "100"; });
  assert.deepEqual(notObject.filter((i) => i.startsWith("v2.keeper")), ["v2.keeper must be an object (the KeeperRewards bounties, daily cap and funding, T-OP-609)"]);
});

test("No registry key may configure Earn just-in-time funding, and none ships", () => {
  const named = (issues) => issues.filter((i) => i.includes("no registry key may configure Earn just-in-time funding"));
  for (const file of REGISTRIES) assert.deepEqual(named(allIssuesFor(() => {}, file)), [], file);
  // Not even a switch that is off: the order is no allowlist entry at all. Named wherever it is put, in addition to the
  // anonymous exact-key refusal where the block is exact-keyed.
  const issues = allIssuesFor((r) => {
    r.v2.earn.fundingAllowed = false;
    r.markets[0].v2.jit = true;
    r.v2.earnJustInTime = { makers: [] };
  });
  assert.deepEqual(named(issues).map((i) => i.split(" is refused:")[0]), ["v2.earn.fundingAllowed", "v2.earnJustInTime", "markets[0].v2.jit"]);
  assert.ok(named(issues).every((i) => i.includes('"Do not turn on Earn just-in-time funding until quoteTake is fixed"') && i.includes("T-OP-835")));
  assert.ok(issues.some((i) => i.startsWith("v2.earn.fundingAllowed is not a known key")), "the exact-key refusal stays");
  // Keys only: a value that says "funding" (a comment, a label) is not a switch.
  const values = [];
  validateNoEarnFunding({ v2: { note: "funding is off", makers: ["jit"] } }, values);
  assert.deepEqual(values, []);
  for (const k of ["setFundingAllowed", "bookFunding", "FUNDING", "justInTime", "JIT"]) assert.ok(EARN_FUNDING_KEY.test(k), k);
  for (const k of ["skimBps", "limits", "fund", "jitter", "keeper"]) assert.ok(!EARN_FUNDING_KEY.test(k), k);
});

test("The MakerVault launch limits and the launch knobs are what both committed registries ship", () => {
  const U128 = "340282366920938463463374607431768211455";
  for (const file of REGISTRIES) {
    const v2 = read(file).v2;
    assert.deepEqual(v2.vault, { maxSeriesUnits: "30000", maxTotalNotional: U128, askToleranceBps: 0, maxBidBpsOfSpot: 1000,
      maxOrderLifetime: 300, maxDailyOutflow: U128 }, `${file} v2.vault`);
    assert.deepEqual(v2.flywheel.config, V2_SKELETON.flywheel.config, `${file} v2.flywheel.config`);
    assert.deepEqual(v2.keeper, V2_SKELETON.keeper, `${file} v2.keeper`);
    assert.deepEqual(v2.earn, V2_SKELETON.earn, `${file} v2.earn`);
    assert.equal(v2.fees.payoutSlippageBps, 30, `${file} v2.fees.payoutSlippageBps`);
    for (const k of ["maxFeedAgeS", "chainlinkMaxStaleS", "chainlinkMaxRoundJumpBps", "univ3WindowS"]) {
      assert.equal(v2.defaults[k], V2_SKELETON.defaults[k], `${file} v2.defaults.${k}`);
    }
  }
});

test("The buyback ceiling, cooldown and max bounty ship at the contracts' compiled values", () => {
  // Launch values re-derived from callhouse-contracts
  // src/v2/interfaces/V2Constants.sol: BUYBACK_CAP_CEIL = 1_000_000_000 (1,000 USDG, :137), BUYBACK_COOLDOWN =
  // 5 minutes (:63), MAX_BOUNTY = 1_000_000 (1 USDG, :86).
  for (const file of REGISTRIES) {
    const v2 = read(file).v2;
    assert.deepEqual([v2.flywheel.config.buybackCapCeiling, v2.flywheel.config.buybackCooldownS, v2.keeper.maxBounty],
      ["1000000000", 300, "1000000"], file);
  }
  // Required and typed like their neighbours.
  const missing = allIssuesFor((r) => { delete r.v2.flywheel.config.buybackCapCeiling; delete r.v2.keeper.maxBounty; });
  assert.ok(missing.includes("v2.flywheel.config.buybackCapCeiling is missing"), missing.join("; "));
  assert.ok(missing.includes("v2.keeper.maxBounty is missing"), missing.join("; "));
  const bad = allIssuesFor((r) => {
    r.v2.flywheel.config.buybackCapCeiling = 1_000_000_000; // a JSON number, not the decimal string
    r.v2.flywheel.config.buybackCooldownS = 0;
    r.v2.keeper.maxBounty = 1_000_000;
  });
  for (const want of [
    "v2.flywheel.config.buybackCapCeiling must be a decimal string in [0, 115792089237316195423570985008687907853269984665640564039457584007913129639935]",
    "v2.flywheel.config.buybackCooldownS must be > 0: FeeSplitter.setBuybackCooldown refuses 0 (T-OP-607)",
    "v2.keeper.maxBounty must be a decimal string of USDG base units",
  ]) assert.ok(bad.includes(want), `missing "${want}" in: ${bad.join("; ")}`);
  const wide = allIssuesFor((r) => { r.v2.flywheel.config.buybackCooldownS = 2 ** 40; });
  assert.ok(wide.includes("v2.flywheel.config.buybackCooldownS must be an integer in [0, 1099511627775]"), wide.join("; "));
});

test("The launch fee split is 10 % buyback-and-burn / 90 % treasury in the builder and both registries", () => {
  // The launch split is set directly to 10/90 through the registry and can move to
  // 50:50 later. The deploy reads V2_BURN_BPS from here, so the splitter is born at 1000, not at the
  // contracts' LAUNCH_BURN_BPS 5000 fallback. The skeleton is only a first build's v2 block (assembleRegistry carries
  // an existing v2 verbatim), so each committed file is pinned too.
  assert.equal(V2_SKELETON.flywheel.config.burnBps, 1000, "V2_SKELETON.flywheel.config.burnBps");
  for (const file of REGISTRIES) assert.equal(read(file).v2.flywheel.config.burnBps, 1000, `${file} v2.flywheel.config.burnBps`);
});

test("A buyback cap above its ceiling is refused, a cap equal to it is not", () => {
  const above = allIssuesFor((r) => { r.v2.flywheel.config.buybackCap = "1000000001"; });
  assert.ok(above.includes("v2.flywheel.config.buybackCap 1000000001 is above buybackCapCeiling 1000000000: FeeSplitter.setBuybackCap reverts above the ceiling"),
    above.join("; "));
  const equal = allIssuesFor((r) => { r.v2.flywheel.config.buybackCap = "1000000000"; });
  assert.deepEqual(equal.filter((i) => i.includes("buybackCap")), []);
  const lowered = allIssuesFor((r) => { r.v2.flywheel.config.buybackCapCeiling = "49999999"; });
  assert.ok(lowered.some((i) => i.startsWith("v2.flywheel.config.buybackCap 50000000 is above buybackCapCeiling 49999999")), lowered.join("; "));
});

test("A market may override the per-market oracle tuning, never the registry-wide maxFeedAgeS", () => {
  const ok = allIssuesFor((r) => { r.markets[0].v2.overrides = { chainlinkMaxStaleS: 7200, univ3WindowS: 600 }; });
  assert.deepEqual(ok.filter((i) => i.includes("overrides")), []);
  const t = read("tier1.json").markets[0].ticker;
  const bad = allIssuesFor((r) => { r.markets[0].v2.overrides = { maxFeedAgeS: 86400 }; });
  assert.ok(bad.includes(`${t}.v2.overrides.maxFeedAgeS: maxFeedAgeS is registry-wide (v2.defaults only, V2_MAX_FEED_AGE_S); a market cannot override it`),
    bad.join("; "));
});

/* ------------------------------------------------------------------ the House and Earn limits */

test("Both committed registries ship the House and Earn launch limits (values cited)", () => {
  const U128 = "340282366920938463463374607431768211455";
  // The launch values, as callhouse-contracts script/v2/fixtures/house-limits.v8.json carries them at launch:
  // 100 shares per series (10000 units), notional uncapped, 1,000,000 USDG a day; the two price guards;
  // lifetime 300 s. Typed here, not read from the builder, so a changed skeleton goes red.
  const house = { maxSeriesUnits: "10000", maxTotalNotional: U128, askToleranceBps: 25, maxBidBpsOfSpot: 300,
    maxOrderLifetime: 300, maxDailyOutflow: "1000000000000" };
  // Earn launch values: 7,000 shares per series (700000 units) and 1,000,000 USDG caps.
  const earn = { maxSeriesUnits: "700000", maxOrderNotional: "1000000000000", maxWrittenUnitsPerSeries: "700000",
    maxWrittenNotional: "1000000000000", maxDailyOutflow: "1000000000000" };
  for (const file of REGISTRIES) {
    const v2 = read(file).v2;
    assert.deepEqual(v2.house.limits, { NVDA: house, SPCX: house }, `${file} v2.house.limits`);
    assert.deepEqual(v2.earn.limits, earn, `${file} v2.earn.limits`);
  }
  assert.deepEqual(V2_SKELETON.house.limits, { NVDA: house, SPCX: house });
  assert.deepEqual(V2_SKELETON.earn.limits, earn);
  assert.notEqual(V2_SKELETON.house.limits.NVDA, V2_SKELETON.house.limits.SPCX, "the two skeleton rows must not alias");
  for (const file of REGISTRIES) {
    assert.deepEqual(allIssuesFor(() => {}, file).filter((i) => i.includes("limits")), [], file);
  }
});

test("The limits blocks are exact, typed and complete for the launch set, and refused by name", () => {
  const limitIssues = (mutate) => allIssuesFor(mutate).filter((i) => i.includes("limits"));
  // Required: a registry without either block is refused where the exact-key check walks it.
  assert.ok(allIssuesFor((r) => delete r.v2.house.limits).includes("v2.house.limits is missing"));
  assert.ok(allIssuesFor((r) => delete r.v2.earn.limits).includes("v2.earn.limits is missing"));
  // Every launch ticker must carry its six limits: DeployHouseVault STOPs on a ticker with none.
  assert.deepEqual(limitIssues((r) => delete r.v2.house.limits.SPCX), [
    "v2.house.limits has no SPCX: SPCX is in launchSet.markets, and DeployHouseVault creates its vault with the limits written from this block (T-OP-655)",
  ]);
  // And no ticker the registry does not carry (a typo would silently leave the real one unset).
  const typo = limitIssues((r) => { r.v2.house.limits.NVDIA = r.v2.house.limits.NVDA; });
  assert.deepEqual(typo, ["v2.house.limits.NVDIA: NVDIA is not a market in this registry"]);
  // Exact, per ticker and in the Earn block.
  const keys = limitIssues((r) => {
    r.v2.house.limits.NVDA.maxDailyOutFlow = "1";
    delete r.v2.house.limits.NVDA.maxDailyOutflow;
    r.v2.earn.limits.maxSeriesUnit = "1";
  });
  for (const want of [
    "v2.house.limits.NVDA.maxDailyOutflow is missing",
    "v2.earn.limits.maxSeriesUnit is not a known key (maxSeriesUnits, maxOrderNotional, maxWrittenUnitsPerSeries, maxWrittenNotional, maxDailyOutflow)",
  ]) assert.ok(keys.includes(want), `missing "${want}" in: ${keys.join("; ")}`);
  assert.ok(keys.some((i) => i.startsWith("v2.house.limits.NVDA.maxDailyOutFlow is not a known key")), keys.join("; "));
  // Typed: the struct widths, decimal strings for the uint64/uint128 amounts, and the House outflow above 0.
  const bad = limitIssues((r) => {
    r.v2.house.limits.NVDA.askToleranceBps = 10_001; // HouseVault._setLimits reverts CeilingExceeded above BPS
    r.v2.house.limits.NVDA.maxSeriesUnits = 10_000; // a JSON number, not the decimal string
    r.v2.house.limits.SPCX.maxDailyOutflow = "0";
    r.v2.earn.limits.maxSeriesUnits = "18446744073709551616"; // 2^64: does not fit uint64
    r.v2.earn.limits.maxDailyOutflow = 1;
  });
  for (const want of [
    "v2.house.limits.NVDA.askToleranceBps must be an integer in [0, 10000]",
    "v2.house.limits.NVDA.maxSeriesUnits must be a decimal string in [0, 18446744073709551615]",
    "v2.house.limits.SPCX.maxDailyOutflow must be > 0: 0 deploys the HouseVault unable to pay out; a spend freeze is a GUARDIAN tightenLimits call after launch, not a deploy value",
    "v2.earn.limits.maxSeriesUnits must be a decimal string in [0, 18446744073709551615]",
    "v2.earn.limits.maxDailyOutflow must be a decimal string in [0, 340282366920938463463374607431768211455]",
  ]) assert.ok(bad.includes(want), `missing "${want}" in: ${bad.join("; ")}`);
  // EarnVault accepts 0 in every field (fail-closed), so a zero Earn cap is NOT refused.
  assert.deepEqual(limitIssues((r) => { r.v2.earn.limits.maxDailyOutflow = "0"; }), []);
  // A present block of the wrong type is named once.
  assert.deepEqual(limitIssues((r) => { r.v2.earn.limits = "1000000"; }),
    ["v2.earn.limits must be an object of the five EarnVault limits (maxSeriesUnits, maxOrderNotional, maxWrittenUnitsPerSeries, maxWrittenNotional, maxDailyOutflow) (T-OP-655)"]);
  assert.deepEqual(limitIssues((r) => { r.v2.house.limits = []; }).filter((i) => i.startsWith("v2.house.limits must")),
    ["v2.house.limits must be an object of { <TICKER>: the six HouseVault limits } (T-OP-655)"]);
});

test("validateVaultLimits is the whole check: a registry with no launch set needs no House row", () => {
  const issues = [];
  validateVaultLimits({ markets: [{ ticker: "NVDA" }], v2: { house: { factories: [], limits: {} }, earn: { skimBps: 0, limits: V2_SKELETON.earn.limits } } }, issues);
  assert.deepEqual(issues, []);
});

/*//////////////////////////////////////////////////////////////
          THE OPTION-CHAIN EVIDENCE COMES FROM MASSIVE
//////////////////////////////////////////////////////////////*/

/**
 * probeMassive through a fake fetch: Massive's contract listing (paged by `next_url`) and its option snapshot's
 * `underlying_asset`, in the shapes a live NVDA response had on 2026-09-24 (reference/options/contracts rows:
 * expiration_date, underlying_ticker, ticker, ...; snapshot underlying_asset: price, ticker, timeframe). No network.
 */
const MASSIVE_KEY = "test-massive-key-0123456789";
const BASE = "https://api.massive.example";
const NOW = new Date("2026-09-24T09:00:00Z"); // a Thursday: the next two Fridays are 2026-09-25 and 2026-10-02
const iso = (yymmdd) => `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
/** Massive listing pages: `perExpiry` contracts for each expiry, cut into pages of `pageSize` rows. */
function listing(root, expiries, { perExpiry = 3, pageSize = 4 } = {}) {
  const rows = expiries.flatMap((e) => Array.from({ length: perExpiry }, (_, i) => ({
    contract_type: i % 2 ? "put" : "call", expiration_date: iso(e), strike_price: 100 + i,
    ticker: `O:${root}${e}C${String(100 + i).padStart(5, "0")}000`, underlying_ticker: root, shares_per_contract: 100,
  })));
  const pages = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += pageSize) pages.push(rows.slice(i, i + pageSize));
  return pages;
}
/** A fetch over those pages plus the snapshot; records every URL and Authorization header it was sent. */
function massiveFetch({ root, pages, price, listingStatus = 200, snapshotStatus = 200, nextOrigin = BASE }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init?.headers?.authorization });
    const u = new URL(url);
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.pathname === `/v3/snapshot/options/${root}`) {
      return json(snapshotStatus, { status: "OK", results: [{ underlying_asset: { price, ticker: root, timeframe: "DELAYED" } }] });
    }
    if (u.pathname === "/v3/reference/options/contracts") {
      const page = Number(u.searchParams.get("cursor") ?? 0);
      const next = page + 1 < pages.length ? `${nextOrigin}/v3/reference/options/contracts?cursor=${page + 1}` : undefined;
      return json(listingStatus, { status: "OK", results: pages[page] ?? [], ...(next ? { next_url: next } : {}) });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
}
const NVDA_EXPIRIES = ["260925", "260928", "260930", "261002", "261005", "261009", "261016"];

test("probeMassive records the registry's evidence shape from Massive's listing and snapshot", async () => {
  const { fetchImpl, calls } = massiveFetch({ root: "NVDA", pages: listing("NVDA", NVDA_EXPIRIES), price: 222.7 });
  const got = await probeMassive("NVDA", 222.2, undefined, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
  assert.deepEqual(got, {
    source: "massive", root: "NVDA",
    // `url` stays the Cboe locator the keeper readers fetch (fair.ts cboe.url, keeper-env.sh KEEPER_VOL_URL); no call went there.
    url: "https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json",
    checkedAt: NOW.toISOString(), http: 200, rows: NVDA_EXPIRIES.length * 3, expiries: NVDA_EXPIRIES, weekly: true,
    currentPrice: 222.7, spotDivergenceBps: 23, underlyingMatches: true, symbol: "NVDA",
  });
  // Every page was followed (21 rows in pages of 4), then the snapshot; the key went only in the header.
  assert.equal(calls.length, 6 + 1);
  assert.equal(calls[0].url, `${BASE}/v3/reference/options/contracts?underlying_ticker=NVDA&expired=false&limit=1000`);
  assert.ok(calls.every((c) => new URL(c.url).origin === BASE), "every read went to Massive");
  for (const c of calls) {
    assert.equal(c.authorization, `Bearer ${MASSIVE_KEY}`);
    assert.ok(!c.url.includes(MASSIVE_KEY), "the key is never in a URL");
  }
  assert.ok(!JSON.stringify(got).includes(MASSIVE_KEY), "the key is never in the evidence");
  assert.deepEqual(modeFor(got), { mode: "vol", reason: `weekly chain, ${NVDA_EXPIRIES.length * 3} rows, spot divergence 23 bps` });
});

test("An empty Massive listing for NVDA puts NVDA in fixed mode, by name", async () => {
  const { fetchImpl } = massiveFetch({ root: "NVDA", pages: [[]], price: 222.7 });
  const got = await probeMassive("NVDA", 222.2, undefined, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
  assert.equal(got.weekly, false);
  assert.deepEqual(got.expiries, []);
  assert.deepEqual(modeFor(got), { mode: "fixed", reason: "no weekly expiries (has …)" });
});

test("A Friday-only chain is weekly exactly when both of the next two Fridays are listed (SPCX's shape)", async () => {
  for (const [expiries, weekly] of [[["260925", "261002", "261009", "261016"], true], [["261002", "261009"], false], [["260925"], false]]) {
    const { fetchImpl } = massiveFetch({ root: "SPCX", pages: listing("SPCX", expiries), price: 142.66 });
    const got = await probeMassive("SPCX", 142.2, undefined, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
    assert.equal(got.weekly, weekly, expiries.join(","));
    assert.equal(modeFor(got).mode, weekly ? "vol" : "fixed", expiries.join(","));
  }
  assert.deepEqual(nextFridays(NOW), ["260925", "261002"]);
});

test("A different instrument (underlying 300+ bps from the feed) is fixed, as it was on Cboe", async () => {
  const { fetchImpl } = massiveFetch({ root: "SPCX", pages: listing("SPCX", ["260925", "261002"]), price: 150 });
  const got = await probeMassive("SPCX", 142, undefined, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
  assert.equal(got.spotDivergenceBps, 563);
  assert.equal(got.underlyingMatches, false);
  assert.deepEqual(modeFor(got), { mode: "fixed", reason: "Massive SPCX is a different instrument: its underlying price diverges 563 bps from the feed" });
});

test("An HTTP failure on EITHER read records that status and no expiries (fixed), never a half listing", async () => {
  for (const [listingStatus, snapshotStatus, http] of [[403, 200, 403], [200, 429, 429], [200, 500, 500]]) {
    const { fetchImpl } = massiveFetch({ root: "NVDA", pages: listing("NVDA", NVDA_EXPIRIES), price: 222.7, listingStatus, snapshotStatus });
    const got = await probeMassive("NVDA", 222.2, { root: "NVDA", http: 200, weekly: true }, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
    assert.equal(got.source, "massive", `${listingStatus}/${snapshotStatus}: this run's evidence, not the previous`);
    assert.equal(got.http, http);
    assert.deepEqual([got.rows, got.expiries, got.weekly], [0, [], false]);
    assert.deepEqual(modeFor(got), { mode: "fixed", reason: "no Massive option chain" });
  }
});

test("A network error keeps the previous evidence with lastError, the key scrubbed from it", async () => {
  const previous = { root: "NVDA", http: 200, weekly: true, expiries: ["260925"] };
  const fetchImpl = async () => { throw new Error(`connect failed for key ${MASSIVE_KEY}`); };
  const got = await probeMassive("NVDA", 222.2, previous, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
  assert.deepEqual(got, { ...previous, lastError: "connect failed for key <key>", lastErrorAt: NOW.toISOString() });
});

test("A next_url on another origin is refused, never sent the key", async () => {
  const { fetchImpl, calls } = massiveFetch({ root: "NVDA", pages: listing("NVDA", NVDA_EXPIRIES), price: 222.7, nextOrigin: "https://elsewhere.example" });
  const got = await probeMassive("NVDA", 222.2, undefined, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
  assert.match(got.error, /next_url left https:\/\/api\.massive\.example/);
  assert.ok(calls.every((c) => new URL(c.url).origin === BASE), "no request left the Massive origin");
  assert.equal(modeFor(got).mode, "fixed");
});

test("A listing longer than MASSIVE_MAX_PAGES is refused rather than truncated", async () => {
  const pages = Array.from({ length: MASSIVE_MAX_PAGES + 1 }, () => listing("NVDA", ["260925"], { perExpiry: 1 })[0]);
  const { fetchImpl } = massiveFetch({ root: "NVDA", pages, price: 222.7 });
  const got = await probeMassive("NVDA", 222.2, undefined, { key: MASSIVE_KEY, fetchImpl, now: NOW, base: BASE });
  assert.match(got.error, new RegExp(`more than ${MASSIVE_MAX_PAGES} pages`));
  assert.equal(modeFor(got).mode, "fixed");
});

test("No key is an error the evidence records, not a request", async () => {
  let called = false;
  const got = await probeMassive("NVDA", 222.2, undefined, { key: null, fetchImpl: async () => { called = true; }, now: NOW, base: BASE });
  assert.equal(called, false);
  assert.match(got.error, /no Massive key/);
  assert.equal(modeFor(got).mode, "fixed");
});

test("massiveKey reads MASSIVE_API_KEY first, then the key file, and trims; none is null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "massive-key-"));
  try {
    const file = path.join(dir, "api_key");
    writeFileSync(file, " from-file-key \n");
    assert.equal(massiveKey({ MASSIVE_API_KEY: " from-env " }, file), "from-env");
    assert.equal(massiveKey({}, file), "from-file-key");
    assert.equal(massiveKey({ MASSIVE_API_KEY: "  " }, file), "from-file-key");
    assert.equal(massiveKey({}, path.join(dir, "missing")), null);
    writeFileSync(file, "\n");
    assert.equal(massiveKey({}, file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modeFor's rules are unchanged: the committed Cboe-era evidence decides the committed modes", () => {
  const registry = JSON.parse(readFileSync(path.join(HERE, "tier1.json"), "utf8"));
  for (const m of registry.markets) {
    if (m.modeOverride) continue;
    assert.equal(modeFor(m.cboe).mode, m.mode, `${m.ticker}: ${JSON.stringify(m.cboe).slice(0, 120)}`);
  }
  assert.deepEqual(modeFor(null), { mode: "fixed", reason: "no Cboe option chain" });
});
