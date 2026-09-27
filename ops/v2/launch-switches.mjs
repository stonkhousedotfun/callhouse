/**
 * Every feature switch the launch services read, and what it must be on launch day.
 *
 * The fee flywheel was the pattern: a step behind a switch whose default is OFF, a
 * rendered env that never turned it on, a skip that said nothing, and a comment ("off until the flywheel is
 * deployed") that went stale when the flywheel shipped. This table is the list of those switches. Each row says
 * which registry value means the thing it gates has shipped, and what the switch must read in the PROD render when
 * it has. `launch-switches.test.mjs` holds the rendered ops/v2/env files and the code to it:
 *
 *   - a row whose prerequisite is in ops/markets/tier1.json and whose effective PROD value (the rendered assignment,
 *     else the code default) is not its launch value fails by name;
 *   - a switch-shaped name (`*_ENABLED`, `*_ENABLE`, `*_DISABLE(D)`, `*_SKIP`, `*_OFF`, `*_DRY_RUN`, or a keeper
 *     `flagField`) that appears in the launch services' code with no row here fails by name.
 *
 * Adding a switch means adding a row, with its reason. A row is not a place to park a bug: `launch: "off"` needs a
 * `why` that names the decision or the reason the gated thing does not ship.
 *
 *   node --test ops/v2/launch-switches.test.mjs
 *   node ops/v2/launch-switches.mjs [--registry FILE] [--env DIR]    the violations of one render, exit 1 on any
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROD_REGISTRY_PATH = path.join(REPO, "ops", "markets", "tier1.json");
export const PROD_ENV_DIR = path.join(REPO, "ops", "v2", "env");

/**
 * @typedef {object} LaunchSwitch
 * @property {string} name        the env name
 * @property {string} declared    the file that reads it (repo-relative)
 * @property {string[]} services  the rendered ops/v2/env/<service>.env files it applies to ([] = not a rendered bot env)
 * @property {"on"|"off"|"n/a"} launch  what it must be on launch day ("n/a": not a launch switch, see `why`)
 * @property {string} [on]        the value that means ON (flags: "1"); the effective value is compared to it
 * @property {string|null} [prerequisite]  a dotted registry path; the row binds only when that value is non-null
 * @property {string} why         the reason: the decision it follows, or why it does not ship
 */

/** @type {LaunchSwitch[]} */
export const LAUNCH_SWITCHES = [
  // ---- keeper: cranker ----
  {
    name: "CRANKER_FLYWHEEL_ENABLED", declared: "keeper/src/v2/config.ts", services: ["cranker"], launch: "on", on: "1",
    prerequisite: "v2.flywheel.feeSplitter",
    why: "claim, distribute and buy back (T-OP-658): rendered =1 when the registry records the splitter; off with a splitter pages v2_cranker_flywheel_disabled",
  },
  {
    name: "CRANKER_FIRSTMINT_ENABLED", declared: "keeper/src/v2/config.ts", services: ["cranker"], launch: "on", on: "1",
    prerequisite: "v2.contracts.clearinghouse",
    why: "the keeper's first mint of each fresh expiry (T-OP-591); default on; set 0 only while a setMarket/setFeed/setPool repair is scheduled",
  },
  {
    name: "CRANKER_BUYBACK_DRY_RUN", declared: "keeper/src/v2/config.ts", services: ["cranker"], launch: "off", on: "1",
    prerequisite: "v2.flywheel.buybackExecutor",
    why: "1 probes the buyback and never sends it; the launch buys back, so it stays at the default 0",
  },
  // ---- keeper: mm-bot ----
  {
    name: "MM_QUOTE_OFF_HOURS", declared: "keeper/src/v2/config.ts", services: ["mm-bot"], launch: "off", on: "1",
    prerequisite: null,
    why: "owner ruling: no quote outside the regular session (orders placed in a session expire at its close)",
  },
  {
    name: "MM_ASK_FALLBACK_ONLY", declared: "keeper/src/v2/config.ts", services: ["mm-bot"], launch: "on", on: "1",
    prerequisite: "v2.contracts.makerVault",
    why: "T-OP-133, the owner's model: the vault's ask is the fallback, resting only while no other maker asks",
  },
  {
    name: "MM_DEPOSIT_TOKENS", declared: "keeper/src/v2/config.ts", services: ["mm-bot"], launch: "on", on: "1",
    prerequisite: "v2.contracts.makerVault",
    why: "move Stock Tokens idle in the vault wallet into its Clearinghouse ledger",
  },
  {
    name: "MM_FAIR_FROM_SESSION", declared: "keeper/src/v2/config.ts", services: ["mm-bot"], launch: "on", on: "1",
    prerequisite: "v2.contracts.makerVault",
    why: "halt fair-before-open when the fair was priced on a chain dated before this session's open",
  },
  // ---- keeper: pricer ----
  {
    name: "PRICER_REPRICE_OFF_HOURS", declared: "keeper/src/v2/config.ts", services: ["pricer"], launch: "off", on: "1",
    prerequisite: null,
    why: "reprices only in the regular session, as the MM quotes (MM_QUOTE_OFF_HOURS)",
  },
  // ---- keeper: guardian ----
  {
    name: "GUARDIAN_AUTO_VETO", declared: "keeper/src/v2/config.ts", services: ["guardian"], launch: "on", on: "1",
    prerequisite: "v2.contracts.settlementOracle",
    why: "T-OP-324: veto a scale fault or a stale round the pool disagrees with; rendered as an assignment",
  },
  // ---- keeper: pricing ----
  {
    name: "PRICING_CHAIN_WARM_UP", declared: "keeper/src/v2/pricing/main.ts", services: ["pricing"], launch: "n/a", on: "1",
    prerequisite: null,
    why: "a boot-time cache warm-up, not a feature gate: off only delays the first answer",
  },
  {
    name: "PRICING_POOL_REQUIRED", declared: "keeper/src/v2/pricing/main.ts", services: ["pricing"], launch: "on", on: "1",
    prerequisite: "v2.contracts.sources.univ3",
    why: "a market with a pool is not priced without its pool spot",
  },
  // ---- notifier ----
  {
    name: "RULES_ENABLED", declared: "notifier/src/config.ts", services: ["notifier"], launch: "on", on: ["true", "1"],
    prerequisite: "v2.contracts.clearinghouse",
    why: "the N2-02 rules engine (reminders, receipts); default true and never rendered, so only a Railway override turns it off",
  },
  // ---- not switches: names that only look like one ----
  {
    name: "SAFE_RUN_DRY_RUN", declared: "ops/stonkctl/src/stonkctl/dayzero.py", services: [], launch: "n/a",
    prerequisite: null,
    why: "a Python constant holding safe-run.sh's --dry-run flag for stonkctl's own dry runs, not an env switch",
  },
];

export const SWITCH_SHAPE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:ENABLED|ENABLE|DISABLED|DISABLE|SKIP|OFF|DRY_RUN)\b/g;

/** A dotted path into the registry; null when any segment is missing or null. */
export function registryValue(registry, dotted) {
  let at = registry;
  for (const key of dotted.split(".")) {
    if (at === null || typeof at !== "object" || !(key in at)) return null;
    at = at[key];
  }
  return at ?? null;
}

/** The assignment of `name` in a rendered env file's text, or null when it is only a comment or absent. */
export function renderedAssignment(text, name) {
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  return line === undefined ? null : line.slice(name.length + 1);
}

/**
 * The code default of a switch: the zod `.default('x')` of its `NAME:` field in the file that declares it (the field
 * may span lines, as notifier's z.preprocess does), else null.
 */
export function codeDefault(row) {
  const source = readFileSync(path.join(REPO, row.declared), "utf8");
  const start = source.search(new RegExp(`\\n\\s*${row.name}: `));
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n\s*[A-Z][A-Z0-9_]*: /);
  const field = next === -1 ? rest : rest.slice(0, next + 1);
  const m = field.match(/\.default\((['"])([^'"]*)\1\)/);
  return m === null ? null : m[2];
}

const isOn = (row, value) => (Array.isArray(row.on) ? row.on : [row.on]).includes(value);

/** What a service runs: the rendered assignment, else the code default. */
export function effective(row, service, envDir = PROD_ENV_DIR) {
  const text = readFileSync(path.join(envDir, `${service}.env`), "utf8");
  return renderedAssignment(text, row.name) ?? codeDefault(row);
}

/** One line per (row, service) whose prerequisite `registry` records and whose effective value is not its launch value. */
export function launchViolations(registry = JSON.parse(readFileSync(PROD_REGISTRY_PATH, "utf8")), envDir = PROD_ENV_DIR) {
  const out = [];
  for (const row of LAUNCH_SWITCHES) {
    if (row.launch === "n/a") continue;
    if (row.prerequisite && registryValue(registry, row.prerequisite) === null) continue;
    for (const service of row.services) {
      const value = effective(row, service, envDir);
      if ((row.launch === "on") !== isOn(row, value)) {
        out.push(`${row.name} in ${service}.env runs ${value === null ? "(no default)" : value} but must be ${row.launch} at launch` +
          `${row.prerequisite ? ` (the registry records ${row.prerequisite})` : ""}: ${row.why}`);
      }
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const registry = JSON.parse(readFileSync(arg("--registry", PROD_REGISTRY_PATH), "utf8"));
  const found = launchViolations(registry, arg("--env", PROD_ENV_DIR));
  for (const line of found) process.stdout.write(`OFF  ${line}\n`);
  process.stdout.write(`launch-switches: ${found.length} switch(es) off while their prerequisite ships\n`);
  process.exitCode = found.length === 0 ? 0 : 1;
}
