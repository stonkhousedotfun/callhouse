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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const opsAbis = path.resolve(pkgRoot, "..", "ops", "abis");
const src = path.join(opsAbis, "Vault.json");
const out = path.resolve(pkgRoot, "lib", "abi", "vault.ts");

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

writeFileSync(out, body);
console.log(
  `wrote ${path.relative(pkgRoot, out)} (${errors.length} errors incl. ${libraryErrorCount} from linked libraries, ${events.length} events, ${functions.length} functions)`,
);
