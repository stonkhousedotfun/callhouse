// Regenerate web/lib/abi/vault.ts from the shared ops/abis/Vault.json artefact.
//
// WHY THIS EXISTS: the frontend's vault ABI is a filtered view of the compiled artefact —
// the read surface plus the functions a USER may call — never the keeper or admin entry
// points (rollOpen, approveListing, setPolicy, ...), so the app cannot encode a call it has
// no business making. Every event and every custom error IS kept, so viem can name a revert
// instead of printing a bare 4-byte selector at the user. ops/ stays the source of truth;
// run `pnpm gen:abis` after any contract change. The sibling script
// indexer/scripts/gen-abis.mjs does the same for the indexer, unfiltered.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const src = path.resolve(pkgRoot, "..", "ops", "abis", "Vault.json");
const out = path.resolve(pkgRoot, "lib", "abi", "vault.ts");

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
]);

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
    else if (USER_WRITE.has(entry.name)) functions.push(entry);
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
errors.sort(byName);
events.sort(byName);
functions.sort(byName);

const header = `// GENERATED from ops/abis/Vault.json (the compiled artifact) by scripts/gen-abis.mjs —
// do not hand-edit.
//
// This is the read + user-write surface only. Keeper and admin entry points (rollOpen,
// approveListing, setPolicy, ...) are deliberately absent: the frontend must never be able to
// encode a call it has no business making, and their OrderComponents tuples are enormous.
// Every event and every custom error IS kept, so viem can name a revert instead of printing
// a bare 4-byte selector at the user.

`;

const body = `${header}export const vaultAbi = ${JSON.stringify(
  [...errors, ...events, ...functions],
  null,
  2,
)} as const;
`;

writeFileSync(out, body);
console.log(
  `wrote ${path.relative(pkgRoot, out)} (${errors.length} errors, ${events.length} events, ${functions.length} functions)`,
);
