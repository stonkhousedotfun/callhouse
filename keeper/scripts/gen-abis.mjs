// Regenerate the keeper's v2 ABI modules in src/v2/abi/ from the shared ops/abis/v2 JSON artefacts.
//
// WHY THIS EXISTS: the v1 keeper transcribed its ABI fragments by hand (src/abi.ts) and pins them
// with a test. v2 has no hand-written ABIs in the keeper: the cranker,
// the pricing service and the mm-bot all call contracts whose ABIs callhouse-contracts
// script/v2/export-abis.sh writes to ops/abis/v2/<Name>.json, and a transcription would be one
// more copy to drift. viem infers every readContract / writeContract argument from an ABI literal,
// and a JSON import widens `type` to `string` (and ops/ sits outside this package's tsconfig
// rootDir anyway), so each ABI is rendered once into an `as const` TypeScript module under src/.
// ops/ stays the source of truth; run `pnpm gen:abis` after any change under ops/abis/v2 or
// ops/shared/v2.
//
// Outputs: src/v2/abi/<logical>.ts through the V2_MODULES table below, and a copy of
// ops/shared/v2/seriesId.ts (the off-chain mirror of the Clearinghouse id formula) at
// src/v2/seriesId.ts. The same table and the same helper copy live in indexer/scripts/gen-abis.mjs
// and web/scripts/gen-abis.mjs: the workspace has no cross-package imports. Double quotes, unlike
// the keeper's TypeScript, so the copied table stays byte-identical across the three generators.
//
// DELIBERATELY ABSENT: no v1 targets. src/abi.ts stays hand-written and is pinned by
// src/abi.test.ts against contracts/out.
//
// `--check` renders every output into memory and compares it with the files on disk. It lists
// drifted, missing and stale files (a module in src/v2/abi whose source left ops/abis/v2) and exits
// 1 on any, 0 otherwise. src/v2/abi.test.ts runs it, so a committed module that no longer matches
// ops/ fails the tests. Without the flag the outputs are written and stale v2 modules are removed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const opsAbisV2 = path.resolve(pkgRoot, "..", "ops", "abis", "v2");
const check = process.argv.includes("--check");

/**
 * Every rendered file, keyed by its package-relative path, with the summary its "wrote" line
 * prints. Nothing touches the disk until every module has rendered.
 */
const outputs = new Map();
const emit = (rel, body, summary) => outputs.set(rel, { body, summary });

const V2_OUT_DIR = "src/v2/abi";
const SERIES_ID_SRC = path.resolve(pkgRoot, "..", "ops", "shared", "v2", "seriesId.ts");
const SERIES_ID_OUT = "src/v2/seriesId.ts";

/**
 * The logical v2 ABI set. COPIED TABLE: identical in indexer/scripts/gen-abis.mjs and
 * web/scripts/gen-abis.mjs; change all three together.
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

// Reduce every entry to the canonical ABI keys, as indexer/scripts/gen-abis.mjs does: a forge
// artefact is clean today, but a hand-annotated one (ops/abis/StockToken.json style) would break
// abitype's `Abi` constraint.
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
