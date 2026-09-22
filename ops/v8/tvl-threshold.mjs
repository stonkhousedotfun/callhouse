/**
 * ops/v8/tvl-threshold.mjs — the OWN8-09 audit trigger: one definition, derived, in one place.
 *
 *   node ops/v8/tvl-threshold.mjs --registry ops/markets/tier1.json          # print the threshold line
 *   node ops/v8/tvl-threshold.mjs --registry ops/markets/tier1.json --json
 *
 * WHY THIS FILE EXISTS. OWN8-09 says the owner commissions an external review and a bug bounty once
 * TVL reaches $1M. Before this, that figure lived in PROSE in two places — ops/alerts.md §V61 and the
 * DEFAULTS comment in ops/v2/monitor.mjs — and in NO configuration at all: `auditTriggerUsdg` defaults
 * to 0, no registry carried the field, and `MONITOR_THRESHOLDS` appeared in no env file under
 * ops/v2/env/ or ops/v2/env-dev/. A threshold nothing sets is a notice that is dark in every shipped
 * configuration, which is the failure OWN8-09 exists to prevent rather than a conservative default.
 *
 * WHAT IT DEFINES, AND WHY THE DEFINITION IS THE HARD PART. The monitor's DEFAULTS comment is right
 * that "the number is not the uncertain part, the DEFINITION is". $1,000,000 is an owner decision
 * (V3-D33). What counts as "locked" is a choice: this counts the USDG held by the protocol's own
 * contracts — the Clearinghouse and the MakerVault — and nothing else. Both halves live here so that
 * a reader changing one is looking straight at the other.
 *
 * WHAT IT IS NOT. It emits a value; it never sets one. No deploy, no broadcast, no write to any
 * service or registry, and no network call of any kind: the registry is read from disk. `--execute`
 * exists only to be REFUSED, and a test holds that refusal in place.
 *
 * Tests: node --test ops/v8/tvl-threshold.test.mjs
 */
import { readFileSync } from "node:fs";

/** USDG is 6 decimals (ops/markets README; dev_deploy.py USDG "6 dp"). */
export const USDG_DECIMALS = 6;

/**
 * The owner's external-audit trigger, in USD. Owner decision V3-D33, "audit at $1M TVL".
 * THE ONLY PLACE THIS NUMBER IS WRITTEN. ops/v2/monitor.mjs must not restate it; the monitor's own
 * test binds its DEFAULTS to this export, so a change here that is not made there fails rather than
 * drifting into two thresholds that disagree about when the owner is told.
 */
export const AUDIT_TRIGGER_USD = 1_000_000;

/** In USDG base units, derived rather than written down: 1_000_000_000_000. */
export const AUDIT_TRIGGER_USDG6 = BigInt(AUDIT_TRIGGER_USD) * 10n ** BigInt(USDG_DECIMALS);

/**
 * WHAT "VALUE LOCKED" COUNTS, and it is deliberately short.
 *
 * The USDG the protocol's own contracts hold. Not user wallets, not the token pool, not the treasury:
 * the collateral the protocol is custodian of, which is what an external reviewer would be reviewing
 * the safety of. Adding a name here widens the trigger's meaning, so it is a decision, not a tweak —
 * ops/v2/monitor.mjs's run("tvl") block reads the same two names and its test binds to this list.
 */
export const LOCKED_HOLDERS = ["clearinghouse", "makerVault"];

/**
 * How old a TVL observation may be before it is a FAULT rather than a reading, in seconds.
 *
 * There was no staleness concept anywhere before this. A monitor that stopped being able to read the
 * balances would report its last known number forever, and for an alert whose whole premise is that
 * the owner is NOT watching, a stale number and a number that never moved are indistinguishable.
 * Four passes at the monitor's default cadence, so one missed pass is not a page.
 */
export const MAX_TVL_AGE_S = 3600;

export class TvlThresholdError extends Error {}

/**
 * Derive the audit trigger and its holder addresses from a parsed registry.
 *
 * REFUSES rather than defaulting. A registry with no `shared.usdg`, or naming none of LOCKED_HOLDERS,
 * cannot express this threshold, and answering 0 would be indistinguishable from "the owner turned it
 * off". That is the whole defect class this row is about, so the error is the answer.
 */
export function deriveTrigger(registry) {
  const shared = registry?.shared ?? {};
  const contracts = registry?.v2?.contracts ?? {};
  const usdg = shared.usdg ?? null;
  if (typeof usdg !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(usdg)) {
    throw new TvlThresholdError(
      "the registry has no shared.usdg address, so 'USDG locked in the protocol's contracts' cannot be "
      + "measured against it. Refusing to emit a threshold: a 0 here is indistinguishable from the "
      + "owner deliberately turning the audit notice off.",
    );
  }
  const holders = LOCKED_HOLDERS
    .map((name) => ({ name, address: contracts[name] ?? null }))
    .filter((h) => typeof h.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(h.address));
  if (holders.length === 0) {
    throw new TvlThresholdError(
      `the registry names none of ${LOCKED_HOLDERS.join(", ")}, so there is nothing whose USDG balance `
      + "would be summed. Refusing to emit a threshold against an empty holder set.",
    );
  }
  const missing = LOCKED_HOLDERS.filter((n) => !holders.some((h) => h.name === n));
  return {
    auditTriggerUsdg: AUDIT_TRIGGER_USDG6,
    usdg,
    holders,
    // Named, not swallowed: a trigger measured over one of two holders is a trigger that pages LATE,
    // and the caller has to decide whether that is acceptable rather than never learning it.
    missingHolders: missing,
    maxAgeS: MAX_TVL_AGE_S,
  };
}

/** The exact `--threshold` argument ops/v2/monitor.mjs takes, so nobody retypes the number. */
export const thresholdArg = (t) => `auditTriggerUsdg=${t.auditTriggerUsdg}`;

/** The MONITOR_THRESHOLDS env value, for ops/v2/env*. Same string, one source. */
export const thresholdEnvLine = (t) => `MONITOR_THRESHOLDS=${thresholdArg(t)}`;

export function parseArgs(argv) {
  const out = { registry: null, json: false, help: false, execute: false };
  const fail = (m) => { throw new TvlThresholdError(m); };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    switch (arg) {
      case "--registry": out.registry = value(); break;
      case "--json": out.json = true; break;
      case "--execute": out.execute = true; break;
      case "--help": case "-h": out.help = true; break;
      default: fail(`unknown argument: ${arg}`);
    }
  }
  return out;
}

export const USAGE = `ops/v8/tvl-threshold.mjs — the OWN8-09 audit trigger, derived from a registry

  node ops/v8/tvl-threshold.mjs --registry <path> [--json]

Prints the --threshold argument and the MONITOR_THRESHOLDS line for ops/v2/monitor.mjs. Read-only:
it reads the registry from disk, makes no network call, and writes nothing. It REFUSES a registry
that cannot express the threshold rather than emitting 0, because a 0 is indistinguishable from the
owner turning the audit notice off.`;

export function main(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const readFile = io.readFile ?? ((p) => readFileSync(p, "utf8"));
  let opts;
  try { opts = parseArgs(argv); }
  catch (error) { err(String(error.message ?? error)); err(""); err(USAGE); return 2; }
  if (opts.help) { log(USAGE); return 0; }
  if (opts.execute) {
    err("--execute is refused: ops/v8/tvl-threshold.mjs only DERIVES the threshold. It writes no "
      + "registry, sets no variable and deploys nothing. Put the printed line in the monitor's "
      + "configuration yourself.");
    return 2;
  }
  if (!opts.registry) { err("--registry <path> is required"); err(""); err(USAGE); return 2; }
  let registry;
  try { registry = JSON.parse(readFile(opts.registry)); }
  catch (error) { err(`cannot read ${opts.registry}: ${String(error?.message ?? error).split("\n")[0]}`); return 2; }
  let t;
  try { t = deriveTrigger(registry); }
  catch (error) { err(String(error.message ?? error)); return 1; }

  if (opts.json) {
    log(JSON.stringify({
      auditTriggerUsdg: String(t.auditTriggerUsdg), auditTriggerUsd: AUDIT_TRIGGER_USD,
      usdg: t.usdg, holders: t.holders, missingHolders: t.missingHolders, maxAgeS: t.maxAgeS,
      thresholdArg: thresholdArg(t), envLine: thresholdEnvLine(t),
    }, null, 2));
  } else {
    log(`OWN8-09 external-audit trigger (owner decision V3-D33): $${AUDIT_TRIGGER_USD.toLocaleString("en-US")}`);
    log(`  counted as: USDG held by ${t.holders.map((h) => h.name).join(" + ")} (USDG ${t.usdg})`);
    if (t.missingHolders.length > 0) {
      log(`  WARNING: the registry names no ${t.missingHolders.join(", ")}, so the sum is over ${t.holders.length} of ${LOCKED_HOLDERS.length} holders and will page LATE`);
    }
    log(`  stale after: ${t.maxAgeS}s`);
    log("");
    log(`  ${thresholdArg(t)}`);
    log(`  ${thresholdEnvLine(t)}`);
  }
  return t.missingHolders.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
