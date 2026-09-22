// Regenerate web/lib/abi/vault.ts from the shared ops/abis/Vault.json artefact.
//
// WHY THIS EXISTS: the frontend's vault ABI is a filtered view of the compiled artefact —
// the read surface plus the functions a USER may call — never the keeper or admin entry
// points (rollOpen, approveListing, setPolicy, ...), so the app cannot encode a call it has
// no business making. Every event and every custom error IS kept, so viem can name a revert
// instead of printing a bare 4-byte selector at the user. ops/ stays the source of truth;
// run `pnpm gen:abis` after any contract change. The sibling script
// indexer/scripts/gen-abis.mjs does the same for the indexer, unfiltered.
//
// Two things Vault.json alone cannot give the fill page:
//
// 1. The errors raised inside the vault's LINKED libraries. solc lists an error in Vault.json
//    only when the vault's own bytecode raises it; the 36 raised inside a DELEGATECALLed
//    SeaportOrderLib or ValoremLib (every `Bad*` order check, `OfferExceedsCapacity`,
//    `WriteReturnedWrongClaim`, `RedeemOutOfGas`, `StrikeAboveBand`, ...) are absent. So the
//    error fragments of ValoremLib.json, SeaportOrderLib.json and Policy.json are merged in,
//    deduplicated by signature. Errors ONLY: the library artefacts' function entries use forge's
//    internal type names (`IValoremClear`, `ItemType`) and would not parse as an ABI.
// 2. The Seaport zone hooks. Under write on fill the vault is the zone of its own
//    PARTIAL_RESTRICTED listing: Seaport calls `authorizeOrder` (which writes the filled
//    contracts) and `validateOrder` during every fill. No user calls them, but the fill page's
//    pre-flight simulates the fill and must be able to name what the hook refused with
//    (`PremiumBelowFloorAtFill`, `StrikeBelowBand`, `ReserveBreached`, `NotLiveListing`), and
//    the docs page renders the hook selectors. They are kept under SEAPORT_HOOKS.
//
// V2: callhouse-contracts script/v2/export-abis.sh
// writes the v2 interface and contract ABIs to ops/abis/v2/<Name>.json. They are rendered here to
// lib/abi/v2/<logical>.ts through the V2_MODULES table below, and ops/shared/v2/seriesId.ts (the
// off-chain mirror of the Clearinghouse id formula) is copied to lib/v2/seriesId.ts. The v2
// modules are UNFILTERED, unlike vault.ts above: the v2 pages need the views and the user writes,
// and which v2 functions are admin- or keeper-only is not settled until the contracts land, so a
// filter written now would guess. A later web task (W2) may add one. The same table and the same
// helper copy live in indexer/scripts/gen-abis.mjs and keeper/scripts/gen-abis.mjs: the workspace
// has no cross-package imports.
//
// `--check` renders every output into memory (vault.ts too: it was in sync with ops/abis when the
// mode was added) and compares it with the files on disk. It lists drifted, missing and stale files
// (a module in lib/abi/v2 whose source left ops/abis/v2) and exits 1 on any, 0 otherwise.
// lib/v2/abi.test.ts runs it, so a committed module that no longer matches ops/ fails the tests.
// Without the flag the outputs are written and stale v2 modules are removed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const opsAbis = path.resolve(pkgRoot, "..", "ops", "abis");
const src = path.join(opsAbis, "Vault.json");
const out = path.resolve(pkgRoot, "lib", "abi", "vault.ts");
const check = process.argv.includes("--check");

/**
 * Every rendered file, keyed by its package-relative path, with the summary its "wrote" line
 * prints. Nothing touches the disk until every target has rendered.
 */
const outputs = new Map();
const emit = (rel, body, summary) => outputs.set(rel, { body, summary });

/** Linked libraries whose custom errors surface through the vault but are absent from Vault.json. */
const LIBRARY_ERROR_SOURCES = ["ValoremLib.json", "SeaportOrderLib.json", "Policy.json"];

/** Nonpayable functions a depositor (or anyone, for the permissionless ones) may call. */
const USER_WRITE = new Set([
  "approve",
  "transfer",
  "deposit",
  "mint",
  "withdraw",
  "redeem",
  "queueRedeem",
  "completeRedeem",
  "claimUsdg",
  "claimUsdgTo",
  "sweepFee",
  // Permissionless recoveries a user may need to send themselves: settle a queue entry made
  // while flat (RedeemQueue offers it), and retry a stranded claim once the freeze has lifted
  // (the stranded banner offers it).
  "settleQueue",
  "retryStrandedClaim",
]);

/** Seaport 1.6 zone hooks: called by Seaport during a fill, never by a user (see header, item 2). */
const SEAPORT_HOOKS = new Set(["authorizeOrder", "validateOrder"]);

/** Functions that MUST survive the filter; a regenerate that loses one fails loudly. */
const REQUIRED_FUNCTIONS = [
  "settleQueue",
  "retryStrandedClaim",
  "authorizeOrder",
  "validateOrder",
  "isStranded",
  "previewCompleteRedeem",
  "maxDeposit",
];

const paramSig = (p) =>
  p.type.startsWith("tuple") ? `(${p.components.map(paramSig).join(",")})${p.type.slice(5)}` : p.type;
const signature = (item) => `${item.name}(${(item.inputs ?? []).map(paramSig).join(",")})`;

const abi = JSON.parse(readFileSync(src, "utf8"));

const errors = [];
const events = [];
const functions = [];
for (const entry of abi) {
  if (entry.type === "error") errors.push(entry);
  else if (entry.type === "event") events.push(entry);
  else if (entry.type === "function") {
    const mutability = entry.stateMutability;
    if (mutability === "view" || mutability === "pure") functions.push(entry);
    else if (USER_WRITE.has(entry.name) || SEAPORT_HOOKS.has(entry.name)) functions.push(entry);
  }
}

// Library errors Vault.json does not carry, deduplicated by signature.
const knownErrors = new Set(errors.map(signature));
let libraryErrorCount = 0;
for (const file of LIBRARY_ERROR_SOURCES) {
  for (const entry of JSON.parse(readFileSync(path.join(opsAbis, file), "utf8"))) {
    if (entry.type !== "error") continue;
    const sig = signature(entry);
    if (knownErrors.has(sig)) continue;
    knownErrors.add(sig);
    errors.push(entry);
    libraryErrorCount += 1;
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
errors.sort(byName);
events.sort(byName);
functions.sort(byName);

const present = new Set(functions.map((f) => f.name));
const lost = REQUIRED_FUNCTIONS.filter((name) => !present.has(name));
if (lost.length > 0) {
  throw new Error(
    `gen-abis: the filtered vault ABI lost ${lost.join(", ")} — check USER_WRITE / SEAPORT_HOOKS against ops/abis/Vault.json`,
  );
}

const header = `// GENERATED from ops/abis/Vault.json (the compiled artifact) and the error fragments of
// ${LIBRARY_ERROR_SOURCES.map((f) => `ops/abis/${f}`).join(", ")} by scripts/gen-abis.mjs —
// do not hand-edit.
//
// This is the read + user-write surface plus the two Seaport zone hooks. Keeper and admin
// entry points (rollOpen, approveListing, setPolicy, ...) are deliberately absent: the frontend
// must never be able to encode a call it has no business making, and their OrderComponents
// tuples are enormous. \`authorizeOrder\` / \`validateOrder\` are here because Seaport calls them
// during every fill of the vault's own listing and the fill page's pre-flight must name what
// they refuse with. Every event and every custom error IS kept — including the ${libraryErrorCount} raised
// inside the linked libraries, which Vault.json omits — so viem can name a revert instead of
// printing a bare 4-byte selector at the user.

`;

const body = `${header}export const vaultAbi = ${JSON.stringify(
  [...errors, ...events, ...functions],
  null,
  2,
)} as const;
`;

emit(
  path.relative(pkgRoot, out),
  body,
  ` (${errors.length} errors incl. ${libraryErrorCount} from linked libraries, ${events.length} events, ${functions.length} functions)`,
);

/*//////////////////////////////////////////////////////////////
                              V2 MODULES
//////////////////////////////////////////////////////////////*/

const opsAbisV2 = path.join(opsAbis, "v2");
const V2_OUT_DIR = "lib/abi/v2";
const SERIES_ID_SRC = path.resolve(pkgRoot, "..", "ops", "shared", "v2", "seriesId.ts");
const SERIES_ID_OUT = "lib/v2/seriesId.ts";

/**
 * The logical v2 ABI set. COPIED TABLE: identical in indexer/scripts/gen-abis.mjs and
 * keeper/scripts/gen-abis.mjs; change all three together.
 *
 * `sources` is ordered and the FIRST file present in ops/abis/v2 wins. Until a contract lane
 * exports the concrete artefact (Clearinghouse.json), the frozen interface (IClearinghouse.json)
 * stands in, and when the artefact lands it replaces the interface under the same module and export
 * name, so no consumer import changes. A logical name with no source present yet is skipped; the
 * one-source adapters and vaults appear when their tasks export them.
 */
const V2_MODULES = [
  {
    name: "clearinghouse",
    sources: ["Clearinghouse.json", "IClearinghouse.json"],
    what: "Clearinghouse: the ERC-1155 series ledger (long id even, short id odd): collateral, mint, settle, redeem.",
  },
  {
    name: "orderBook",
    sources: ["OrderBook.json", "IOrderBook.json"],
    what: "OrderBook: the on-chain order board for series units, write-on-fill asks included.",
  },
  {
    name: "settlementOracle",
    sources: ["SettlementOracle.json", "ISettlementOracle.json"],
    what: "SettlementOracle: the (underlying, expiry) settlement price over the source fallback chain.",
  },
  {
    name: "expiryCalendar",
    sources: ["ExpiryCalendar.json", "IExpiryCalendar.json"],
    what: "ExpiryCalendar: the 16:00 New York expiry grid, holidays and the regular session.",
  },
  {
    name: "priceSource",
    sources: ["IPriceSource.json"],
    what: "IPriceSource: the adapter interface every settlement price source implements.",
  },
  {
    // optional until C2-03
    name: "chainlinkFeedSource",
    sources: ["ChainlinkFeedSource.json"],
    what: "ChainlinkFeedSource: IPriceSource over the push feed's on-chain round history.",
  },
  {
    // optional until C2-03
    name: "uniV3TwapSource",
    sources: ["UniV3TwapSource.json"],
    what: "UniV3TwapSource: IPriceSource over a keeper-snapshotted Uniswap v3 pool TWAP.",
  },
  {
    // optional until C2-12
    name: "dataStreamsSource",
    sources: ["DataStreamsSource.json"],
    what: "DataStreamsSource: IPriceSource over Data Streams reports verified through the VerifierProxy.",
  },
  {
    name: "keeperRewards",
    sources: ["KeeperRewards.json", "IKeeperRewards.json"],
    what: "KeeperRewards: USDG bounties for SNAPSHOT, FINALIZE, SETTLE, REDEEM and ROLL under a daily cap.",
  },
  {
    name: "autoRoller",
    sources: ["AutoRoller.json", "IAutoRoller.json"],
    what: "AutoRoller: set-and-forget writer strategies, rolled by keepers and repriced by PRICER_ROLE.",
  },
  {
    name: "accessManager",
    sources: ["AccessManager.json"],
    what: "AccessManager: delayed role authority for the v8 deployment.",
  },
  {
    name: "feeSplitter",
    sources: ["FeeSplitter.json", "IFeeSplitter.json"],
    what: "FeeSplitter: protocol-fee distribution, buyback allocation and burns.",
  },
  {
    name: "buybackExecutor",
    sources: ["V4BuybackExecutor.json", "IBuybackExecutor.json"],
    what: "V4BuybackExecutor: splitter-only USDG-to-STONKHOUSE execution and burn.",
  },
  {
    name: "payoutAdapter",
    sources: ["PayoutRouter.json", "IPayoutRouter.json", "IPayoutAdapter.json"],
    what: "PayoutRouter: converts in-kind payouts to USDG over configured Uniswap v3 or v4 routes.",
  },
  {
    name: "makerRegistry",
    sources: ["MakerRegistry.json", "IMakerRegistry.json"],
    what: "MakerRegistry: per-maker rebate tiers on the order book.",
  },
  {
    // optional until C2-11
    name: "makerVault",
    sources: ["MakerVault.json"],
    what: "MakerVault: the treasury-funded protocol maker that quotes on the book.",
  },
  {
    // the interface stands in until C2-11 exports the contract
    name: "rewardsDistributor",
    sources: ["RewardsDistributor.json", "IRewardsDistributor.json"],
    what: "RewardsDistributor: per-epoch Merkle claims of USDG.",
  },
  {
    // P8-02. Absent from ops/abis/v2 until the contract lane exports it; the loop below then
    // silently skips this row, so abis/v2/earnVault.ts does not exist yet and nothing imports it.
    name: "earnVault",
    sources: ["EarnVault.json", "IEarnVault.json"],
    what: "EarnVault: the LENDING vault — shares against supplied stock or USDG, venue adapter, yield skim.",
  },
  {
    // P8-01. The contract is landed (src/v2/periphery/StockZap.sol) but is not in
    // script/v2/abi-manifest.txt, so export-abis.sh does not copy it here yet; see T-78.
    name: "stockZap",
    sources: ["StockZap.json", "IStockZap.json"],
    what: "StockZap: stateless USDG<->Stock Token zaps over the PayoutRouter's pinned route.",
  },
  {
    name: "v2Errors",
    sources: ["V2Errors.json"],
    what: "V2Errors: the shared custom errors of every v2 contract.",
  },
  {
    // P8-06. Absent from ops/abis/v2 until T-78 adds HouseVaultFactory to
    // script/v2/abi-manifest.txt; the loop then skips this row. Indexing uses
    // lib/v2/houseVaultEvents.ts until the artefact lands.
    name: "houseVaultFactory",
    sources: ["HouseVaultFactory.json"],
    what: "HouseVaultFactory: LISTING deploys one HouseVault per underlying.",
  },
  {
    // P8-06. Same export gap as houseVaultFactory. Do not stand in MakerVault.json.
    name: "houseVault",
    sources: ["HouseVault.json"],
    what: "HouseVault: user-funded weekly-epoch market maker; depositor shares, queued deposits/withdrawals.",
  },
];

/**
 * COVERAGE, BOTH DIRECTIONS (T-300).
 *
 * The generation loop at the bottom of this file reads `const source = m.sources.find(v2Present)`
 * and then `if (source) renderV2Module(...)`. That bare `if` is the whole defect this block exists
 * for: it skips silently in BOTH directions. An ABI that ops/abis/v2 exports and no module names is
 * not drifted and not missing - it is unseen; and a module whose sources are all absent produces
 * nothing and says nothing.
 *
 * ALL THREE GENERATORS HAD THE SAME SHAPE. web/scripts/gen-abis.mjs, indexer/scripts/gen-abis.mjs
 * and keeper/scripts/gen-abis.mjs each carried that identical two-line loop, so all three are fixed
 * together here rather than one being cited as different. The keeper's was in neither audit's scope
 * (CH3 covered the indexer, CH4 the web) and was found while fencing this row.
 *
 * NOT SET EQUALITY, DELIBERATELY. Some exported ABIs legitimately have no consumer module, so
 * requiring the two sets to match would fire on a clean tree and the next lane would add exclusions
 * until it went green - which is the unguarded list this row is about. The rule instead is that
 * every PRESENT export must be ACCOUNTED FOR by name, either by a module that names it as a source
 * or by V2_UNWIRED_ABIS below, and that adding one requires a deliberate edit in this file.
 *
 * The fourth instance of this class lives in the contracts repo, in script/v2/export-abis.sh's
 * manifest half, and belongs to T-279-C8-ABI-EXPORT-GUARD-GAPS. It is cited here, not touched.
 */
/**
 * Exported ABI files that deliberately have no generated consumer module. This is a named
 * exclusion ledger, not set equality: V2_MODULES may still name absent future/fallback sources,
 * but every ABI that is present under ops/abis/v2 must be accounted for here or in that table.
 * COPIED TABLE: keep identical in indexer/scripts/gen-abis.mjs and keeper/scripts/gen-abis.mjs.
 */
const V2_UNWIRED_ABIS = new Set([
  "Erc4626VenueAdapter.json", // EarnVault venue implementation; consumers call the vault, not the adapter.
  "Hedger.json", // No registry/config address or app/keeper call site exists yet.
  "IFeeDiscount.json", // OrderBook collaborator interface, not a standalone consumer target.
  "IFundingSource.json", // Funding seam used behind OrderBook/EarnVault, not called directly.
  "StockLoanAdapter.json", // EarnVault funding implementation, not called directly by these packages.
  "StockVenueAdapter.json", // EarnVault venue implementation, not called directly by these packages.
  "UniV3PayoutAdapter.json", // Legacy v7 adapter; v8 consumers use the PayoutRouter module.
]);

/** JSON metadata exported beside the ABIs, but not itself a contract ABI. */
const V2_NON_ABI_JSON = new Set(["roles.json"]);

/** Every module but v2Errors merges these fragments (see renderV2Module). */
const V2_ERRORS = "V2Errors.json";

// Reduce every entry to the canonical ABI keys, as indexer/scripts/gen-abis.mjs does: a forge
// artefact is clean today, but a hand-annotated one (ops/abis/StockToken.json style) would break
// abitype's `Abi` constraint.
const ITEM_KEYS = ["type", "name", "inputs", "outputs", "stateMutability", "anonymous"];
const PARAM_KEYS = ["name", "type", "internalType", "components", "indexed"];

const cleanParam = (p) => {
  const cleaned = {};
  for (const k of PARAM_KEYS) {
    if (p[k] === undefined) continue;
    cleaned[k] = k === "components" ? p[k].map(cleanParam) : p[k];
  }
  return cleaned;
};

const cleanItem = (item) => {
  const cleaned = {};
  for (const k of ITEM_KEYS) {
    if (item[k] === undefined) continue;
    cleaned[k] = k === "inputs" || k === "outputs" ? item[k].map(cleanParam) : item[k];
  }
  return cleaned;
};

const unwrap = (json) => (Array.isArray(json) ? json : (json.abi ?? json));

const readV2Abi = (file) =>
  unwrap(JSON.parse(readFileSync(path.join(opsAbisV2, file), "utf8")))
    .filter((item) => typeof item?.type === "string")
    .map(cleanItem);

const v2Present = (file) => existsSync(path.join(opsAbisV2, file));

const v2AbiFiles = () =>
  readdirSync(opsAbisV2)
    .filter((file) => file.endsWith(".json") && !V2_NON_ABI_JSON.has(file))
    .sort();

/** Present ABI exports that neither generate a module nor have a deliberate named exclusion. */
const unwiredV2 = () => {
  const accountedFor = new Set([...V2_MODULES.flatMap((module) => module.sources), ...V2_UNWIRED_ABIS]);
  return v2AbiFiles().filter((file) => !accountedFor.has(file));
};

/** Keep an old exclusion from silently blessing a later, unrelated ABI with the same name. */
const absentV2Unwired = () => [...V2_UNWIRED_ABIS].filter((file) => !v2Present(file)).sort();

/**
 * Modules whose every named source is absent from ops/abis/v2.
 *
 * The generation loop at the bottom of this file skips a sourceless module with a bare `if`, and
 * that silence is the other half of the defect the coverage checks above exist to remove: an ABI
 * the contracts repo exports and nobody wires is now visible, and a module wired here that nothing
 * exports must be nameable too. It is NOT an error. A module row deliberately lands before its ABI
 * is exported, and making this red would turn a planned row into a broken tree - the failure the
 * named-exclusion design above was chosen to avoid. So it prints, always, and the exit code does
 * not move.
 */
const dormantV2 = () =>
  V2_MODULES.filter((module) => !module.sources.some(v2Present))
    .map((module) => `${module.name} (no source present: ${module.sources.join(", ")})`)
    .sort();

/**
 * One v2 module. A concrete contract's artefact lists only the errors its own bytecode raises and
 * an interface lists none, yet any v2 call can revert with any V2Errors error once libraries and
 * external calls are involved. So every module except v2Errors itself appends the V2Errors
 * fragments it does not already carry (deduplicated by signature, sorted by name), and a decoder
 * built from one module names every shared revert.
 */
const renderV2Module = (m, file) => {
  const own = readV2Abi(file);
  let merged = [];
  if (m.name !== "v2Errors") {
    if (!v2Present(V2_ERRORS)) {
      throw new Error(`gen-abis: ${m.name} needs ops/abis/v2/${V2_ERRORS} for its error fragments, and it is missing`);
    }
    const known = new Set(own.filter((item) => item.type === "error").map(signature));
    const added = new Map();
    for (const item of readV2Abi(V2_ERRORS)) {
      if (item.type !== "error") continue;
      const sig = signature(item);
      if (known.has(sig) || added.has(sig)) continue;
      added.set(sig, item);
    }
    merged = [...added.values()].sort(byName);
  }
  const abi = [...own, ...merged];
  const provenance = m.name === "v2Errors" ? "" : ` and the error fragments of ops/abis/v2/${V2_ERRORS}`;
  const first = m.sources[0];
  const standIn =
    file === first
      ? ""
      : `\n// ${file} is the frozen interface standing in until ${first} is exported; this module and\n// \`${m.name}Abi\` keep their names when it is.`;
  const moduleBody = `// GENERATED by scripts/gen-abis.mjs from ops/abis/v2/${file}${provenance}. Do not edit by hand.
// ${m.what}${standIn}
// UNFILTERED: every function, event and error is kept; which v2 functions are admin- or keeper-only
// is not settled yet, so no filter guesses (see scripts/gen-abis.mjs).
export const ${m.name}Abi = ${JSON.stringify(abi, null, 2)} as const;
`;
  const mergedNote = m.name === "v2Errors" ? "" : `, ${merged.length} V2Errors merged`;
  emit(`${V2_OUT_DIR}/${m.name}.ts`, moduleBody, ` (${abi.length} entries from ${file}${mergedNote})`);
};

for (const m of V2_MODULES) {
  const file = m.sources.find(v2Present);
  if (file) renderV2Module(m, file);
}

emit(
  SERIES_ID_OUT,
  `// GENERATED — edit ops/shared/v2/seriesId.ts, then run \`pnpm gen:abis\` in indexer, web and keeper.\n${readFileSync(SERIES_ID_SRC, "utf8")}`,
  " (copy of ops/shared/v2/seriesId.ts)",
);

/*//////////////////////////////////////////////////////////////
                           WRITE OR CHECK
//////////////////////////////////////////////////////////////*/

/** Files in the v2 output directory that no longer have a source (package-relative paths). */
const staleV2 = () => {
  const dir = path.join(pkgRoot, V2_OUT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${V2_OUT_DIR}/${f}`)
    .filter((rel) => !outputs.has(rel))
    .sort();
};

const reportV2Coverage = (unwired, absentUnwired) => {
  for (const file of unwired) {
    console.error(`unwired: ops/abis/v2/${file} (not named in V2_MODULES or V2_UNWIRED_ABIS)`);
  }
  for (const file of absentUnwired) {
    console.error(`stale allowance: ops/abis/v2/${file} (named in V2_UNWIRED_ABIS but absent)`);
  }
};

const unwired = unwiredV2();
const absentUnwired = absentV2Unwired();
const dormant = dormantV2();
for (const entry of dormant) console.log(`dormant: ${entry}`);

if (check) {
  const drifted = [];
  const missing = [];
  for (const [rel, { body: expected }] of outputs) {
    const file = path.join(pkgRoot, rel);
    if (!existsSync(file)) missing.push(rel);
    else if (readFileSync(file, "utf8") !== expected) drifted.push(rel);
  }
  const stale = staleV2();
  const outputProblems = drifted.length + missing.length + stale.length;
  const coverageProblems = unwired.length + absentUnwired.length;
  if (outputProblems + coverageProblems === 0) {
    console.log(`gen-abis --check: ${outputs.size} files match ops/`);
  } else {
    for (const rel of drifted) console.error(`drifted: ${rel}`);
    for (const rel of missing) console.error(`missing: ${rel}`);
    for (const rel of stale) console.error(`stale:   ${rel} (no source in ops/abis/v2)`);
    reportV2Coverage(unwired, absentUnwired);
    if (outputProblems) {
      console.error("gen-abis --check: generated files differ from ops/; run `pnpm gen:abis` and commit the result");
    }
    if (coverageProblems) {
      console.error("gen-abis --check: exported ABI coverage is incomplete; update V2_MODULES or V2_UNWIRED_ABIS");
    }
    process.exit(1);
  }
} else {
  if (unwired.length + absentUnwired.length > 0) {
    reportV2Coverage(unwired, absentUnwired);
    console.error("gen-abis: exported ABI coverage is incomplete; update V2_MODULES or V2_UNWIRED_ABIS");
    process.exit(1);
  }
  for (const [rel, { body: contents, summary }] of outputs) {
    const file = path.join(pkgRoot, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
    console.log(`wrote ${rel}${summary}`);
  }
  for (const rel of staleV2()) {
    rmSync(path.join(pkgRoot, rel));
    console.log(`removed ${rel} (no source in ops/abis/v2)`);
  }
}
