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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const opsAbis = path.resolve(pkgRoot, "..", "ops", "abis");

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
  return [...added.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  writeFileSync(path.join(pkgRoot, "abis", t.out), body, "utf8");
  const mergedNote = t.mergeErrorsFrom ? `, ${merged.length} library errors merged` : "";
  console.log(`wrote abis/${t.out} (${abi.length} entries${mergedNote})`);
}
