/* -------------------------------------------------------------------------------------------------
 * O8-06 preflight: for each required rehearsal step, can it run against this contracts tree, and if
 * not, exactly what stops it.
 *
 * WHY THIS IS DERIVED AND NOT A LIST. The blockers on this task are moving under it. T-237's own
 * acceptance says so — "the line numbers below were read at contracts 33380c14 and the tips have
 * moved" — and re-deriving at the attached base immediately retracted half of one finding (see
 * RETRACTIONS below). A hand-written table of "what is blocked" is correct for about an hour, and
 * then it is a confident lie in a file nobody re-reads. So the blockers are READ OUT OF THE CONTRACTS
 * TREE on every run: if someone lands a deploy path for the Earn vault tomorrow, this stops reporting
 * it as blocked without anyone editing this file, and if someone DELETES one, it starts.
 *
 * WHAT IT READS, all of it re-derivable by hand:
 *   script/v2/lib/V2DeployBase.sol  `ART_X = "out/Name.sol/Name.json"` -> the artifact table
 *   script/**.s.sol, script/**.sh   `_create(ART_X` / `deployCode(ART_X` / `new Name(` -> deployed
 *   script/v2/lib/V2DeployBase.sol  `vm.envOr("V2_X", ...)` -> it has a registry/env key
 *   script/v2/VerifyV8.s.sol        `_eq(name, "X")`        -> VerifyV8 knows about it
 *   script/v2/roles.v8.json         .targets / .unrestricted -> the access design knows about it
 *
 * A CORRECTION THIS FILE ALREADY CAUSED, left here because the trap is the interesting part. The
 * first version of this scan looked only for `new <Name>(` and duly reported that PayoutRouter "has
 * no deployment path". It is deployed — DeployV8.s.sol:569 `_create(ART_PAYOUT_ROUTER, ...)` — and
 * so is almost everything else in the v8 set: these scripts deploy from the compiled ARTIFACT, not
 * with a constructor call. A detector that cannot see the mechanism its subject actually uses reports
 * a clean, confident, entirely wrong blocker, and "PayoutRouter is undeployable" would have sent the
 * next reader into a day of chasing nothing. Hence the artifact table below: the ART_ constant to
 * contract-name mapping is READ from V2DeployBase rather than hand-listed here, so a new contract
 * deployed the normal way is seen without anyone updating this file.
 *
 * RETRACTIONS, recorded here because a retracted finding with evidence is worth more than a repeated
 * one (T-237 AC2). Read at contracts v8 d0602230, branch v8:
 *
 *   RETRACTED — "no V2_EARN_VAULT env input in DeployV8/VerifyV8, as there is for the hedger and the
 *   house vault" (T-225, read at 33380c14). At d0602230 the key exists throughout:
 *   DeployV8.s.sol:1318 `if (_eq(name, "EarnVault")) return "V2_EARN_VAULT";`, V2DeployBase.sol:359
 *   `c.earnVault = vm.envOr("V2_EARN_VAULT", address(0));`, V2DeployBase.sol:225 the struct field,
 *   VerifyV8.s.sol:1217 and :1246, and DeployV2Batch.sh:607 lists `earnVault` in EXTERNAL_KEYS.
 *
 *   HOLDS — "nothing constructs the Earn vault". Checked BOTH mechanisms at d0602230: no
 *   `new EarnVault(` anywhere under script/, and no `_create(ART_EARN_VAULT` either, although the
 *   artifact constant exists (V2DeployBase.sol:168) and VerifyV8 uses it for the codehash check
 *   (:1246). It arrives BY ADDRESS or not at all, which for a from-scratch fork rehearsal means not
 *   at all.
 *
 *   HOLDS, and it is the emptier of the two. At d0602230 `StockZap` appears under script/ in exactly
 *   two places, neither executable: roles.v8.json:275 (prose explaining why it is ungated) and
 *   abi-manifest.txt:80. There is no `new StockZap(`, no ART_STOCK_ZAP constant at all — so the
 *   artifact path cannot deploy it either — no V2_ env key, no VerifyV8 entry, and it is absent from
 *   DeployV2Batch.sh's EXTERNAL_KEYS. Unlike the Earn vault it cannot even be handed in pre-deployed.
 *
 * The preflight does not decide anything on its own authority: it reports, and the runner turns a
 * report into a `blocked` outcome carrying that evidence, which is what ends up in the O8-06 report.
 * ------------------------------------------------------------------------------------------------- */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { REQUIRED_STEPS } from "./v8-plan.mjs";

/**
 * What each required step needs to exist before it can be attempted.
 *
 *   deployable  contract names that something must CONSTRUCT (`new X(`) or hand in by env key
 *   envKey      contract names that must have a V2_ address input, for the by-address path
 *   verify      contract names VerifyV8 must know, or the deployment cannot be checked
 *   network     true when the step cannot be attempted at all without an off-machine RPC
 *
 * A step with no requirements is one the harness can attempt with what it already has.
 */
export const NEEDS = Object.freeze({
  "v8-deploy": { script: ["script/v2/DeployV8.s.sol"], network: true },
  "v8-role-handover": { script: ["script/v2/DeployV8.s.sol"], rolesFile: true, network: true },
  "v8-deployer-renounce": { script: ["script/v2/DeployV8.s.sol"], rolesFile: true, network: true },
  "v8-verify": { script: ["script/v2/VerifyV8.s.sol"], network: true },
  "v8-register": { script: ["script/v2/RegisterMarkets.s.sol"], network: true },
  "v8-fill": { network: true },
  "v8-settle-daily": { network: true },
  "v8-settle-friday": { network: true },
  "v8-redeem-usdg-v4": { deployable: ["PayoutRouter"], network: true },
  "v8-redeem-in-kind": { deployable: ["PayoutRouter"], network: true },
  "v8-distribute-buyback-burn": { deployable: ["FeeSplitter", "V4BuybackExecutor"], network: true },
  "v8-guardian-cancel": { rolesFile: true, network: true },
  "v8-hotkey-rotation": { rolesFile: true, network: true },
  "v8-zap": { deployable: ["StockZap"], verify: ["StockZap"], network: true },
  "v8-earn-fund-lend": { deployable: ["EarnVault"], verify: ["EarnVault"], network: true },
  "v8-lender-claim": { script: ["script/v2/DeployLenderRewards.s.sol"], network: true },
  "v8-house-vault-epoch": { deployable: ["HouseVaultFactory"], verify: ["HouseVault"], network: true },
  "v8-hedger-disabled": { envKey: ["Hedger"], verify: ["Hedger"], network: true },
  "v8-v7-runoff": { network: true },
});

const SOL_OR_SH = /\.(s?\.sol|sh)$/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith(".sol") || full.endsWith(".sh")) out.push(full);
  }
  return out;
}

const readOr = (file, fallback = "") => {
  try { return readFileSync(file, "utf8"); } catch { return fallback; }
};

/**
 * Read the contracts tree once. Everything downstream is a set lookup against this, so a caller can
 * also build it by hand in a test and watch the preflight change its mind — which is how the tests
 * prove the derivation is real rather than decorative.
 */
export function inspectContracts(contractsDir) {
  const scriptDir = path.join(contractsDir, "script");
  const files = walk(scriptDir);

  const deployBase = readOr(path.join(contractsDir, "script", "v2", "lib", "V2DeployBase.sol"));

  // The artifact table: ART_FOO -> the contract name its JSON path names. Derived, so a contract added
  // to the table is seen here without this file changing.
  const artifactName = new Map();
  for (const m of deployBase.matchAll(/constant\s+(ART_[A-Z0-9_]+)\s*=\s*"out\/[A-Za-z0-9_]+\.sol\/([A-Za-z0-9_]+)\.json"/g)) {
    artifactName.set(m[1], m[2]);
  }

  // Deployed = constructed with `new`, OR created from its artifact, which is what the v8 scripts do.
  const constructs = new Set();
  for (const f of files) {
    const text = readOr(f);
    for (const m of text.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)\s*[({]/g)) constructs.add(m[1]);
    for (const m of text.matchAll(/\b(?:_create|deployCode|_deploy)\s*\(\s*(ART_[A-Z0-9_]+)/g)) {
      const name = artifactName.get(m[1]);
      if (name) constructs.add(name);
    }
  }

  const envKeys = new Set();
  for (const m of deployBase.matchAll(/vm\.envOr\(\s*"(V2_[A-Z0-9_]+)"/g)) envKeys.add(m[1]);

  const deployV8 = readOr(path.join(contractsDir, "script", "v2", "DeployV8.s.sol"));
  const envKeyByName = new Map();
  for (const m of deployV8.matchAll(/_eq\(name,\s*"([A-Za-z0-9_]+)"\)\)\s*return\s*"(V2_[A-Z0-9_]+)"/g)) {
    envKeyByName.set(m[1], m[2]);
  }

  const verify = readOr(path.join(contractsDir, "script", "v2", "VerifyV8.s.sol"));
  const verifyKnows = new Set();
  for (const m of verify.matchAll(/_eq\(name,\s*"([A-Za-z0-9_]+)"\)/g)) verifyKnows.add(m[1]);

  let roles = null;
  try { roles = JSON.parse(readOr(path.join(contractsDir, "script", "v2", "roles.v8.json"), "null")); } catch { roles = null; }

  const scripts = new Set(
    files.map((f) => path.relative(contractsDir, f)).filter((p) => SOL_OR_SH.test(p) || p.endsWith(".sol")),
  );

  return { contractsDir, constructs, envKeys, envKeyByName, verifyKnows, roles, scripts, scriptFileCount: files.length };
}

/**
 * Can this step be attempted? Returns `{ runnable, blockers: [...] }`, where each blocker names the
 * thing that is missing AND the evidence that says so, so the O8-06 report can be audited without
 * re-running anything.
 *
 * `forkAllowed` is passed in rather than sniffed: whether this machine may call an off-machine RPC is
 * an owner decision per task (the T-107 precedent), not a property of the code, and a preflight that
 * guessed it would be the wrong kind of clever.
 */
export function preflightStep(id, facts, { forkAllowed = false } = {}) {
  const needs = NEEDS[id];
  if (!needs) return { id, runnable: false, blockers: [{ what: "unknown step", evidence: `${id} is not in NEEDS` }] };

  const blockers = [];

  for (const name of needs.deployable ?? []) {
    const constructed = facts.constructs.has(name);
    const key = facts.envKeyByName.get(name);
    const byAddress = key != null && facts.envKeys.has(key);
    if (!constructed && !byAddress) {
      blockers.push({
        what: `${name} has no deployment path`,
        evidence: `nothing under script/ deploys it: no \`new ${name}(\`, no \`_create(ART_${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}\`, and no V2_ address input${key ? ` (DeployV8 names ${key} but V2DeployBase does not read it)` : ""}`,
        fix: `give ${name} a deploy path, or hand the rehearsal a pre-deployed address`,
      });
    } else if (!constructed && byAddress) {
      blockers.push({
        what: `${name} arrives only BY ADDRESS (${key})`,
        evidence: `nothing under script/ deploys it (no \`new\`, no \`_create(ART_...)\`); V2DeployBase reads ${key}, so it can only be handed in pre-deployed`,
        fix: `the rehearsal must construct ${name} itself before it can exercise it on a fresh fork`,
        severity: "partial",
      });
    }
  }

  for (const name of needs.envKey ?? []) {
    const key = facts.envKeyByName.get(name);
    if (!key || !facts.envKeys.has(key)) {
      blockers.push({ what: `${name} has no address input`, evidence: `DeployV8/V2DeployBase expose no V2_ key for ${name}` });
    }
  }

  for (const name of needs.verify ?? []) {
    if (!facts.verifyKnows.has(name)) {
      blockers.push({
        what: `VerifyV8 does not know ${name}`,
        evidence: `no \`_eq(name, "${name}")\` in script/v2/VerifyV8.s.sol`,
        fix: `without it the deployment can carry ${name} and still verify clean — the check cannot see its subject`,
      });
    }
  }

  for (const rel of needs.script ?? []) {
    if (!facts.scripts.has(rel)) blockers.push({ what: `${rel} is missing`, evidence: `not found under ${facts.contractsDir}` });
  }

  if (needs.rolesFile && !facts.roles) {
    blockers.push({ what: "roles.v8.json is unreadable", evidence: `no parseable script/v2/roles.v8.json under ${facts.contractsDir}` });
  }

  if (needs.network && !forkAllowed) {
    blockers.push({
      what: "no fork: this step needs an off-machine archive RPC",
      evidence: "anvil --fork-url against chain 4663 is a call off this machine, which is owner-gated per task (the T-107 precedent)",
      fix: "ask the owner for a task-scoped read-only fork gate, then re-run with --fork-allowed",
    });
  }

  return { id, runnable: blockers.length === 0, blockers };
}

/** Every required step, preflighted. The runner turns each non-runnable one into a `blocked` outcome. */
export function preflightAll(facts, opts = {}) {
  return REQUIRED_STEPS.map((s) => preflightStep(s.id, facts, opts));
}

/** One line a human can act on, for the report and the runner's `reason`. */
export function describeBlockers(result) {
  if (result.runnable) return null;
  return result.blockers.map((b) => `${b.what} — ${b.evidence}${b.fix ? `; ${b.fix}` : ""}`).join(" | ");
}
