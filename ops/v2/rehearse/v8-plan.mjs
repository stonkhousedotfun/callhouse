/* -------------------------------------------------------------------------------------------------
 * O8-06: the required-step manifest for the full-stack v8 fork rehearsal, and the completeness rule
 * that makes a silent skip impossible.
 *
 * WHY THIS FILE IS DATA AND NOT PROSE. O8-06's own acceptance text is the anti-false-green rule for
 * this task, quoted from v8-plan/tasks.json at the id `O8-06`:
 *
 *     "Report names fork block, fixtures, expected events; every drill has an observed outcome;
 *      skipped steps are listed as missing evidence."
 *
 * A rehearsal runner that iterates over whatever drills happen to be registered satisfies that
 * sentence trivially and tells you nothing: the set it checks is the set it ran. So the required set
 * is pinned HERE, derived from the canonical O8-06 row rather than from the runner, and the runner is
 * checked against it. Delete a drill from the runner and `missingOutcomes` names it; mark one skipped
 * without a reason and `invalidOutcomes` names it. That is the one direction the check has to work in.
 *
 * PROVENANCE, so the next reader can re-derive every line rather than trust it:
 *   - v8-plan/tasks.json, id "O8-06" — the step list in its `title`, the rule in its `acceptance`.
 *   - v8-plan/00-MASTER-2026-09-19.md section 6 step 4 — "Full-stack fork rehearsal with inert keys:
 *     deploy, role handover, deployer renounce, verify, register, fill, settle, distribute, buyback."
 *   - v8-plan/00-MASTER-2026-09-19.md section 6 step 10 — zaps, the Earn vault and lender rewards are
 *     part of the v8 launch; the hedger ships switched off.
 *   - callhouse-contracts script/v2/roles.v8.json — the role ids a step names are READ from that file
 *     at run time (see `rolesFile` below), never hand-copied into this manifest.
 *
 * The step list is deliberately longer than 00-MASTER section 6 step 4's one-line version, because the
 * tasks.json title is the fuller statement of the same step and names nine things that sentence does
 * not: guardian cancel, hot-key rotation, zaps, Earn vault funding + lending, lender-reward claim, the
 * House vault epoch, the hedger present but disabled, v7 run-off alongside, and a Friday expiry beside
 * the daily one. Where the two sources disagree in scope, the longer one wins: dropping a step because
 * the shorter summary omits it is how a rehearsal comes back green having rehearsed less than it says.
 * ------------------------------------------------------------------------------------------------- */

/** Where the required set comes from. Printed in the report so the report can be audited. */
export const SOURCE = {
  task: "O8-06",
  from: "v8-plan/tasks.json (id O8-06) + v8-plan/00-MASTER-2026-09-19.md section 6 steps 4 and 10",
  acceptance:
    "Report names fork block, fixtures, expected events; every drill has an observed outcome; skipped steps are listed as missing evidence.",
  boardRow: "T-237-O8-FORK-REHEARSAL-FULLSTACK",
};

/**
 * The statuses a step may come back with.
 *
 * `blocked` is a FIRST-CLASS OUTCOME and the reason this manifest exists. A step that cannot run today
 * is not absent and is not a pass: it is an observed outcome whose observation is "this could not be
 * attempted, and here is precisely what stopped it". T-237's AC5 says the same thing in one line — "a
 * drill that cannot run yet is a REPORT naming what blocks it - do not silently skip one".
 *
 * `skipped` exists only for a step the OPERATOR deselected (`--only`), and it still carries a reason.
 * There is no status that means "not mentioned".
 */
export const STATUSES = Object.freeze(["passed", "issue", "failed", "blocked", "skipped"]);

/** Statuses that require a human-readable reason. A bare "blocked" is the failure this file prevents. */
export const REASON_REQUIRED = Object.freeze(["issue", "failed", "blocked", "skipped"]);

/** Statuses that mean the rehearsal did NOT prove this step. `summarize().proven` counts the rest. */
export const UNPROVEN = Object.freeze(["failed", "blocked", "skipped"]);

/**
 * The required steps, in the order the launch sequence performs them.
 *
 *   id        stable key; the runner registers its drills against these
 *   title     what the step does
 *   proves    the claim that fails if this step is dropped — write it as the thing a reader would
 *             otherwise have to take on trust
 *   observes  the concrete artifacts the report must name: events, view reads, exit codes. O8-06's
 *             acceptance demands "expected events", so a step with nothing observable is a step that
 *             cannot be evidenced, and the manifest refuses one (see validateManifest).
 *   phase     which rehearsal step owns it (1 fork/deploy, 3 story, 4 drills, 5 report)
 *   source    where in the plan this step is required, so a reader can re-derive it
 */
export const REQUIRED_STEPS = Object.freeze([
  {
    id: "v8-deploy",
    title: "The production v8 deploy path runs on the fork: DeployV8 with inert keys",
    proves: "the deploy script that will be used on mainnet completes against forked mainnet state, not just a clean devnet",
    observes: ["forge script DeployV8 exit 0", "every address in the deploy broadcast record", "the deploy block"],
    phase: 1,
    source: "00-MASTER section 6 step 4 'deploy'",
  },
  {
    id: "v8-role-handover",
    title: "Role handover: every role in roles.v8.json moves from the deployer to its named principal",
    proves: "the handover step is complete and each role's holder is the principal the file names, not the deployer",
    observes: ["AccessManager RoleGranted per role", "AccessManager RoleRevoked for the deployer", "hasRole() per (role, principal) after handover"],
    phase: 1,
    source: "00-MASTER section 6 step 4 'role handover'; roles.v8.json .holders",
  },
  {
    id: "v8-deployer-renounce",
    title: "Deployer renounce: the deploying key holds no role and cannot re-grant one",
    proves: "the deployer key is inert after launch — the single most consequential irreversible step in the sequence",
    observes: ["hasRole(ADMIN, deployer) == false", "a grantRole attempt from the deployer reverts AccessManagerUnauthorizedAccount"],
    phase: 1,
    source: "00-MASTER section 6 step 4 'deployer renounce'",
  },
  {
    id: "v8-verify",
    title: "VerifyV8 passes against the rehearsed deployment",
    proves: "the gate that guards the real broadcast has been seen green at least once — F8-03's ledger says it never has",
    observes: ["forge script VerifyV8 exit 0", "the count of checks it reports", "no VerifyV8 _info line naming an EOA in a delayed role"],
    phase: 1,
    source: "00-MASTER section 6 steps 4 and 7 'VerifyV8 must pass before anything is registered'",
  },
  {
    id: "v8-register",
    title: "RegisterMarkets registers the rehearsal tickers on the v8 deployment",
    proves: "registration works against the deployed v8 set and the registry writeback is complete",
    observes: ["RegisterMarkets exit 0 per ticker", "Clearinghouse.market(asset) populated", "the registry copy's v2.contracts and v2.deployBlock"],
    phase: 1,
    source: "00-MASTER section 6 steps 4 'register' and 9",
  },
  {
    id: "v8-fill",
    title: "Fills: a write, a book fill and a resale fill on the v8 OrderBook",
    proves: "the v8 take path works end to end on forked state, including the v8 fee fields",
    observes: ["Minted", "Taken/Filled per fill", "the taker's fee against quoteTake's four values"],
    phase: 3,
    source: "00-MASTER section 6 step 4 'fill'; O8-06 title 'fills'",
  },
  {
    id: "v8-settle-daily",
    title: "A DAILY expiry settles: snapshot, finalize, settle, redeem",
    proves: "the ordinary expiry path works on v8",
    observes: ["Snapshotted", "Finalized", "Settled", "Redeemed once per (token, holder)"],
    phase: 3,
    source: "O8-06 title 'through a daily and a Friday expiry'",
  },
  {
    id: "v8-settle-friday",
    title: "A FRIDAY expiry settles beside the daily one",
    proves: "the weekly calendar branch is exercised, not only the daily one the story naturally reaches",
    observes: ["ExpiryCalendar's Friday expiry id", "Finalized and Settled for that expiry"],
    phase: 3,
    source: "O8-06 title 'a daily and a Friday expiry'",
  },
  {
    id: "v8-redeem-usdg-v4",
    title: "Redemption pays USDG over a v4 route",
    proves: "the payout route that the registry pins actually pays, rather than silently falling back",
    observes: ["the v4 swap event on the pinned pool", "the holder's USDG balance delta", "no in-kind fallback event for this holder"],
    phase: 3,
    source: "O8-06 title 'settlement (USDG via v4 and in-kind)'",
  },
  {
    id: "v8-redeem-in-kind",
    title: "Redemption falls back IN KIND for a market with no route",
    proves: "the fallback is reachable and is taken for the right reason, not as a masked failure of the v4 path",
    observes: ["the in-kind payout event", "the holder's stock-token balance delta", "no swap attempted for this market"],
    phase: 3,
    source: "O8-06 title 'settlement (USDG via v4 and in-kind)'",
  },
  {
    id: "v8-distribute-buyback-burn",
    title: "Distribute to the splitter, then buyback, then burn",
    proves: "the flywheel moves value the whole way: fees in, token bought, the burn half actually burned",
    observes: ["FeeSplitter distribution event", "the buyback swap", "Transfer to address(0) or the burn event", "the treasury half's balance delta"],
    phase: 4,
    source: "00-MASTER section 6 step 4 'distribute, buyback'; V3 decision 50/50 burn/treasury",
  },
  {
    id: "v8-guardian-cancel",
    title: "The guardian CANCELS a scheduled AccessManager operation before it executes",
    proves: "the guardian veto on the delayed-role lane works on a real scheduled operation, not only in a unit test",
    observes: ["OperationScheduled", "OperationCanceled", "the post-cancel execute attempt reverting"],
    phase: 4,
    source: "O8-06 title 'guardian cancel'; roles.v8.json .roleGuardian and .delaysS",
  },
  {
    id: "v8-hotkey-rotation",
    title: "A hot key is rotated through OPS_ADMIN",
    proves: "a compromised bot key can be replaced by the lane built for it, at the delay that lane carries",
    observes: ["the OPS_ADMIN-scheduled grant/revoke pair", "hasRole(old) == false and hasRole(new) == true", "the bot signing with the new key"],
    phase: 4,
    source: "O8-06 title 'hot-key rotation'; roles.v8.json OPS_ADMIN (id 6) and its .delaysS entry",
  },
  {
    id: "v8-zap",
    title: "A zap: USDG in, position out, through StockZap",
    proves: "the zap helper is reachable on a deployed set — V3-D29 puts it in launch scope",
    observes: ["the zap's swap and mint events", "the caller's USDG delta and position delta"],
    phase: 3,
    source: "00-MASTER section 6 step 10 'Zaps ... are part of the v8 launch'; O8-06 title 'zaps'",
  },
  {
    id: "v8-earn-fund-lend",
    title: "The Earn vault funding stage, with lending",
    proves: "the funding seam pays a real take from the real vault, and the lending leg moves",
    observes: ["the vault deposit", "the fundable/fund call pair on the take path", "the lending adapter's position delta"],
    phase: 3,
    source: "00-MASTER section 6 step 10 'the Earn vault ... part of the v8 launch'; O8-06 title 'Earn vault funding + lending'",
  },
  {
    id: "v8-lender-claim",
    title: "A lender claims $STONKHOUSE rewards for an epoch",
    proves: "the reward path a lender will actually use pays out against a real epoch",
    observes: ["the epoch's emitted root/rows", "the Claimed event", "the claimant's token balance delta"],
    phase: 4,
    source: "00-MASTER section 6 step 10 'lender rewards'; O8-06 title 'lender-reward claim'",
  },
  {
    id: "v8-house-vault-epoch",
    title: "A full House vault epoch: deposit, quote, settle, boundary, withdraw",
    proves: "the vault's whole epoch lifecycle closes, including the boundary that the share price depends on",
    observes: ["the deposit", "quotes placed", "the epoch settle", "the boundary transition", "the withdrawal request and its payout"],
    phase: 4,
    source: "O8-06 title 'a House vault epoch (deposit, quote, settle, boundary, withdraw)'",
  },
  {
    id: "v8-hedger-disabled",
    title: "The hedger is deployed and VERIFIABLY disabled",
    proves: "the ship-switched-off decision is observable on chain rather than asserted in a document",
    observes: ["the hedger's address in the registry", "its enabled/disabled view reading disabled", "an attempt to use it reverting"],
    phase: 1,
    source: "00-MASTER section 6 step 10 'the hedger ships switched off'; O8-06 title 'hedger present but disabled'",
  },
  {
    id: "v8-v7-runoff",
    title: "v7 runs off BESIDE v8: the cranker keeps settling v7 while v8 trades",
    proves: "the two deployments coexist on one chain for the run-off window, which is the launch-night shape",
    observes: ["a v7 expiry settling after the v8 deploy block", "v8 fills in the same window", "no cross-contamination of the two registries"],
    phase: 4,
    source: "00-MASTER section 6 step 8 'Freeze v7, let its series run off'; O8-06 title 'v7 run-off alongside'",
  },
]);

export const REQUIRED_IDS = Object.freeze(REQUIRED_STEPS.map((s) => s.id));

const byId = new Map(REQUIRED_STEPS.map((s) => [s.id, s]));
export const stepById = (id) => byId.get(id) ?? null;

/**
 * The manifest's own integrity. Called by the runner before it runs anything and by the unit test:
 * a duplicated id or a step with nothing observable would make the completeness check weaker in a way
 * that is invisible from its output.
 */
export function validateManifest(steps = REQUIRED_STEPS) {
  const problems = [];
  const seen = new Set();
  for (const s of steps) {
    if (!s.id) problems.push("a step has no id");
    else if (seen.has(s.id)) problems.push(`duplicate step id ${s.id}`);
    seen.add(s.id);
    if (!s.title) problems.push(`${s.id}: no title`);
    if (!s.proves) problems.push(`${s.id}: no 'proves' — a step nobody can state the point of cannot be evidenced`);
    if (!Array.isArray(s.observes) || s.observes.length === 0) {
      problems.push(`${s.id}: nothing in 'observes' — O8-06's acceptance requires expected events per step`);
    }
    if (!s.source) problems.push(`${s.id}: no 'source' — every required step must be re-derivable from the plan`);
  }
  return problems;
}

/**
 * Required ids with NO outcome at all. This is the check the whole file exists for: it is the only one
 * that can see a step the runner forgot, because it reads the requirement, not the runner.
 */
export function missingOutcomes(results = {}) {
  return REQUIRED_IDS.filter((id) => !Object.prototype.hasOwnProperty.call(results, id) || results[id] == null);
}

/** Outcomes that are present but not usable as evidence. A bare `blocked` with no blocker is the case. */
export function invalidOutcomes(results = {}) {
  const bad = [];
  for (const [id, r] of Object.entries(results)) {
    if (id.startsWith("_") || r == null) continue;
    if (!byId.has(id)) { bad.push({ id, why: "not a required O8-06 step: it is extra, and extras do not substitute for a missing one" }); continue; }
    if (!STATUSES.includes(r.status)) { bad.push({ id, why: `status ${JSON.stringify(r.status)} is not one of ${STATUSES.join(", ")}` }); continue; }
    if (REASON_REQUIRED.includes(r.status) && !String(r.reason ?? "").trim()) {
      bad.push({ id, why: `status ${r.status} with no reason — "${r.status}" on its own is exactly the silent skip O8-06's acceptance forbids` });
    }
  }
  return bad;
}

/** Steps that ran and proved their claim, versus everything else, with the unproven ones named. */
export function summarize(results = {}) {
  const missing = missingOutcomes(results);
  const invalid = invalidOutcomes(results);
  const count = (s) => REQUIRED_IDS.filter((id) => results[id]?.status === s).length;
  const unproven = REQUIRED_IDS
    .filter((id) => results[id] && UNPROVEN.includes(results[id].status))
    .map((id) => ({ id, status: results[id].status, reason: results[id].reason ?? null }));
  return {
    required: REQUIRED_IDS.length,
    passed: count("passed"),
    issue: count("issue"),
    failed: count("failed"),
    blocked: count("blocked"),
    skipped: count("skipped"),
    missing,
    invalid,
    unproven,
    /** The number O8-06 is actually asking for: steps whose claim the rehearsal established. */
    proven: count("passed") + count("issue"),
    complete: missing.length === 0 && invalid.length === 0,
  };
}

/**
 * The rule, as a throw. The runner calls this LAST, after every drill has had its turn, so that a run
 * which forgot a step exits non-zero even when every drill it did run was green.
 */
export function assertComplete(results = {}) {
  const { missing, invalid } = summarize(results);
  if (missing.length === 0 && invalid.length === 0) return;
  const lines = [];
  if (missing.length) {
    lines.push(`${missing.length} required O8-06 step(s) produced NO outcome: ${missing.join(", ")}`);
    lines.push("  Each is a step the report would otherwise have been silent about. Give it an outcome — running it, or `blocked` with the blocker named.");
  }
  for (const b of invalid) lines.push(`${b.id}: ${b.why}`);
  const err = new Error(`O8-06 rehearsal INCOMPLETE\n${lines.join("\n")}`);
  err.name = "RehearsalIncompleteError";
  throw err;
}

/**
 * The report table. O8-06's acceptance names three things the report must carry — fork block, fixtures,
 * expected events — so they are parameters here rather than something the caller may forget: a report
 * rendered without a fork block says so in the output instead of just not having one.
 */
export function renderReport(results = {}, { forkBlock = null, fixtures = null, generatedAt = new Date().toISOString() } = {}) {
  const s = summarize(results);
  const out = [];
  out.push(`# O8-06 — full-stack v8 fork rehearsal`);
  out.push("");
  out.push(`Generated ${generatedAt} · board row ${SOURCE.boardRow}`);
  out.push(`Required set derived from ${SOURCE.from}`);
  out.push("");
  out.push(`- Fork block: ${forkBlock ?? "**NOT RECORDED** — O8-06's acceptance requires it"}`);
  out.push(`- Fixtures: ${fixtures ?? "**NOT RECORDED** — O8-06's acceptance requires them"}`);
  out.push(`- Steps proven: ${s.proven} of ${s.required}`);
  out.push(`- Unproven: ${s.failed} failed, ${s.blocked} blocked, ${s.skipped} skipped, ${s.missing.length} missing`);
  out.push("");
  out.push("| step | status | evidence / why not |");
  out.push("|---|---|---|");
  for (const step of REQUIRED_STEPS) {
    const r = results[step.id];
    if (!r) { out.push(`| \`${step.id}\` | **MISSING** | no outcome was recorded — this is missing evidence, not a pass |`); continue; }
    const detail = r.status === "passed" ? (r.evidence ?? step.observes.join("; ")) : (r.reason ?? "");
    out.push(`| \`${step.id}\` | ${r.status} | ${String(detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  out.push("");
  if (s.unproven.length) {
    out.push("## Missing evidence");
    out.push("");
    out.push("Every line here is a claim in the launch sequence that this rehearsal did NOT establish.");
    out.push("");
    for (const u of s.unproven) {
      const step = stepById(u.id);
      out.push(`- **${u.id}** (${u.status}) — would have proven: ${step.proves}`);
      out.push(`  - blocker: ${u.reason ?? "(none recorded)"}`);
    }
    out.push("");
  }
  return out.join("\n");
}
