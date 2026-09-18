// Regenerate the typed ABI modules in abis/ from the shared ops/abis JSON artefacts.
//
// WHY THIS EXISTS: ponder (and abitype underneath it) infers event argument types from an ABI
// literal. `import x from "./Vault.json"` widens every `type` field to `string`, which
// destroys that inference and leaves every handler's `event.args` typed as `any`. So the JSON
// is transcribed once into an `as const` TypeScript module. ops/ stays the source of truth;
// run `pnpm gen:abis` after any ABI change there.
//
// The transcription is not a straight copy. ops/abis/StockToken.json interleaves `_comment`
// separators and annotates entries with `_selector` / `_verified`, which are useful to a human
// and fatal to abitype's `Abi` constraint, so every entry is reduced to the canonical keys.
//
// The vault links two public libraries (SeaportOrderLib, ValoremLib) and calls Policy through
// them. solc puts an error in Vault.json only when the vault's own bytecode can raise it; the 36
// raised inside a DELEGATECALLed library (every SeaportOrderLib `Bad*`, `WriteReturnedWrongClaim`,
// `RedeemOutOfGas`, `StrikeAboveBand`, ...) are absent, and a decoder built from Vault.json alone
// prints them as bare selectors. So the vault target MERGES the error fragments of those three
// artefacts (`mergeErrorsFrom`), deduplicated by signature. Errors only: the library artefacts'
// FUNCTION entries use forge's internal type names (`IValoremClear`, `ItemType`) and would not
// parse as an ABI.
//
// There is no OvercallRegistry target: the redesigned vault has no registry (decision D16).
//
// V2: callhouse-contracts script/v2/export-abis.sh
// writes the v2 interface and contract ABIs to ops/abis/v2/<Name>.json. They are rendered here to
// abis/v2/<logical>.ts through the V2_MODULES table below, and ops/shared/v2/seriesId.ts (the
// off-chain mirror of the Clearinghouse id formula) is copied to src/v2/seriesId.ts. Ponder runs
// every non-test file under src/ as an indexing file; the copy has no side effects, so that is
// harmless. The same table and the same helper copy live in web/scripts/gen-abis.mjs and
// keeper/scripts/gen-abis.mjs: the workspace has no cross-package imports.
//
// `--check` renders every output into memory (the v1 targets too: they were in sync with ops/abis
// when the mode was added) and compares it with the files on disk. It lists drifted, missing and
// stale files (a module in abis/v2 whose source left ops/abis/v2) and exits 1 on any, 0 otherwise.
// src/v2/abi.test.ts runs it, so a committed module that no longer matches ops/ fails the tests.
// Without the flag the outputs are written and stale v2 modules are removed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const opsAbis = path.resolve(pkgRoot, "..", "ops", "abis");
const check = process.argv.includes("--check");

/**
 * Every rendered file, keyed by its package-relative path, with the summary its "wrote" line
 * prints. Nothing touches the disk until every target has rendered.
 */
const outputs = new Map();
const emit = (rel, body, summary) => outputs.set(rel, { body, summary });

const targets = [
  {
    src: "Vault.json",
    out: "vault.ts",
    export: "vaultAbi",
    note:
      "Stonkhouse Vault. Compiled artefact of contracts/src/Vault.sol, plus the custom errors of\n// its linked libraries (ValoremLib, SeaportOrderLib) and Policy, which Vault.json omits.",
    mergeErrorsFrom: ["ValoremLib.json", "SeaportOrderLib.json", "Policy.json"],
  },
  {
    src: "ValoremClear.json",
    out: "valoremClear.ts",
    export: "valoremClearAbi",
    note:
      "ValoremOptionsClearinghouse, exact upstream build, 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0.\n// Claim.amountWritten / amountExercised are 1e18-scaled scalars, NOT contract counts; the\n// event arguments (OptionsWritten.amount, OptionsExercised.amount) are raw counts.",
  },
  {
    src: "StockToken.json",
    out: "stockToken.ts",
    export: "stockTokenAbi",
    note:
      "Robinhood Chain Stock Token: ERC-20 plus ERC-8056 scaled UI amount, recovered from the\n// deployed implementation's bytecode and verified live (see ops/abis/StockToken.json).\n// `uiMultiplier()` is DISPLAY ONLY — the vault never rebases and its share maths use raw\n// balances. `oraclePaused()` gates writes: a paused oracle blocks rollOpen and every fill.",
  },
  // The factory market (contracts/src/solo/, Tier 1 of the multi-market plan). Two artefacts, no
  // library errors to merge: neither contract links a public library. Extracted from
  // callhouse-contracts/out at main 5eb84d1 into ops/abis/ by the contracts lane.
  {
    src: "AccountFactory.json",
    out: "accountFactory.ts",
    export: "accountFactoryAbi",
    note:
      "AccountFactory (contracts/src/solo/AccountFactory.sol): one per market. Creates WriterAccount\n// clones (`AccountCreated`, the factory-address source in ponder.config.ts), owns the week\n// (`WeekSet`), the halt switch, the policy, the fee recipient and the per-account deposit cap.\n// `PolicySet` carries no values: the policy is read from `policy()` at setup, never from a log.",
  },
  {
    src: "WriterAccount.json",
    out: "writerAccount.ts",
    export: "writerAccountAbi",
    note:
      "WriterAccount (contracts/src/solo/Account.sol): one user's isolated covered-call account, a\n// clone of the factory's implementation. Every clone emits the same events; Ponder resolves the\n// set of addresses from the factory's `AccountCreated`. `LotFilled.premiumUsdg` is the whole ask\n// (seller's part plus the protocol fee item); `Settled(nvdaReturned, strikeUsdg)` is what the\n// Valorem redeem returned, (0, 0) when nothing was written OR when the redeem reverted.",
  },
];

const ITEM_KEYS = ["type", "name", "inputs", "outputs", "stateMutability", "anonymous"];
const PARAM_KEYS = ["name", "type", "internalType", "components", "indexed"];

const cleanParam = (p) => {
  const out = {};
  for (const k of PARAM_KEYS) {
    if (p[k] === undefined) continue;
    out[k] = k === "components" ? p[k].map(cleanParam) : p[k];
  }
  return out;
};

const cleanItem = (item) => {
  const out = {};
  for (const k of ITEM_KEYS) {
    if (item[k] === undefined) continue;
    out[k] = k === "inputs" || k === "outputs" ? item[k].map(cleanParam) : item[k];
  }
  return out;
};

const unwrap = (json) => (Array.isArray(json) ? json : (json.abi ?? json));

const paramSig = (p) => (p.type.startsWith("tuple") ? `(${p.components.map(paramSig).join(",")})${p.type.slice(5)}` : p.type);
const signature = (item) => `${item.name}(${(item.inputs ?? []).map(paramSig).join(",")})`;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The error fragments of `files` that `abi` does not already carry, sorted by name. */
const libraryErrors = (abi, files) => {
  const known = new Set(abi.filter((item) => item.type === "error").map(signature));
  const added = new Map();
  for (const file of files) {
    for (const item of unwrap(JSON.parse(readFileSync(path.join(opsAbis, file), "utf8")))) {
      if (item?.type !== "error") continue;
      const sig = signature(item);
      if (known.has(sig) || added.has(sig)) continue;
      added.set(sig, cleanItem(item));
    }
  }
  return [...added.values()].sort(byName);
};

for (const t of targets) {
  const raw = JSON.parse(readFileSync(path.join(opsAbis, t.src), "utf8"));
  // Drop the `_comment` separators, then strip the annotation keys from what is left.
  const own = unwrap(raw)
    .filter((item) => typeof item?.type === "string")
    .map(cleanItem);
  const merged = t.mergeErrorsFrom ? libraryErrors(own, t.mergeErrorsFrom) : [];
  const abi = [...own, ...merged];

  const provenance = t.mergeErrorsFrom
    ? ` and the error fragments of ${t.mergeErrorsFrom.map((f) => `ops/abis/${f}`).join(", ")}`
    : "";
  const body = `// GENERATED by scripts/gen-abis.mjs from ops/abis/${t.src}${provenance}. Do not edit by hand.
// ${t.note}
export const ${t.export} = ${JSON.stringify(abi, null, 2)} as const;
`;
  const mergedNote = t.mergeErrorsFrom ? `, ${merged.length} library errors merged` : "";
  emit(`abis/${t.out}`, body, ` (${abi.length} entries${mergedNote})`);
}

/*//////////////////////////////////////////////////////////////
                              V2 MODULES
//////////////////////////////////////////////////////////////*/

const opsAbisV2 = path.join(opsAbis, "v2");
const V2_OUT_DIR = "abis/v2";
const SERIES_ID_SRC = path.resolve(pkgRoot, "..", "ops", "shared", "v2", "seriesId.ts");
const SERIES_ID_OUT = "src/v2/seriesId.ts";

/**
 * The logical v2 ABI set. COPIED TABLE: identical in web/scripts/gen-abis.mjs and
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
    name: "payoutAdapter",
    sources: ["UniV3PayoutAdapter.json", "PayoutAdapter.json", "IPayoutAdapter.json"],
    what: "PayoutAdapter: swaps an in-kind Stock Token payout to USDG through Uniswap v3.",
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
    name: "v2Errors",
    sources: ["V2Errors.json"],
    what: "V2Errors: the shared custom errors of every v2 contract.",
  },
];

/** Every module but v2Errors merges these fragments (see renderV2Module). */
const V2_ERRORS = "V2Errors.json";

const readV2Abi = (file) =>
  unwrap(JSON.parse(readFileSync(path.join(opsAbisV2, file), "utf8")))
    .filter((item) => typeof item?.type === "string")
    .map(cleanItem);

const v2Present = (file) => existsSync(path.join(opsAbisV2, file));

/**
 * One v2 module. A concrete contract's artefact lists only the errors its own bytecode raises and
 * an interface lists none, yet any v2 call can revert with any V2Errors error once libraries and
 * external calls are involved. So every module except v2Errors itself appends the V2Errors
 * fragments it does not already carry (deduplicated by signature, sorted by name), and a decoder
 * built from one module names every shared revert.
 */
const renderV2Module = (m, src) => {
  const own = readV2Abi(src);
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
    src === first
      ? ""
      : `\n// ${src} is the frozen interface standing in until ${first} is exported; this module and\n// \`${m.name}Abi\` keep their names when it is.`;
  const body = `// GENERATED by scripts/gen-abis.mjs from ops/abis/v2/${src}${provenance}. Do not edit by hand.
// ${m.what}${standIn}
export const ${m.name}Abi = ${JSON.stringify(abi, null, 2)} as const;
`;
  const mergedNote = m.name === "v2Errors" ? "" : `, ${merged.length} V2Errors merged`;
  emit(`${V2_OUT_DIR}/${m.name}.ts`, body, ` (${abi.length} entries from ${src}${mergedNote})`);
};

for (const m of V2_MODULES) {
  const src = m.sources.find(v2Present);
  if (src) renderV2Module(m, src);
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

if (check) {
  const drifted = [];
  const missing = [];
  for (const [rel, { body }] of outputs) {
    const file = path.join(pkgRoot, rel);
    if (!existsSync(file)) missing.push(rel);
    else if (readFileSync(file, "utf8") !== body) drifted.push(rel);
  }
  const stale = staleV2();
  if (drifted.length + missing.length + stale.length === 0) {
    console.log(`gen-abis --check: ${outputs.size} files match ops/`);
  } else {
    for (const rel of drifted) console.error(`drifted: ${rel}`);
    for (const rel of missing) console.error(`missing: ${rel}`);
    for (const rel of stale) console.error(`stale:   ${rel} (no source in ops/abis/v2)`);
    console.error("gen-abis --check: generated files differ from ops/; run `pnpm gen:abis` and commit the result");
    process.exit(1);
  }
} else {
  for (const [rel, { body, summary }] of outputs) {
    const file = path.join(pkgRoot, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
    console.log(`wrote ${rel}${summary}`);
  }
  for (const rel of staleV2()) {
    rmSync(path.join(pkgRoot, rel));
    console.log(`removed ${rel} (no source in ops/abis/v2)`);
  }
}
