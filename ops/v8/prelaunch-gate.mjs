/**
 * ops/v8/prelaunch-gate.mjs — the OWN8-02 pre-launch services gate, in one command.
 *
 *   node ops/v8/prelaunch-gate.mjs --evidence ops/v8/prelaunch-evidence.json \
 *        --relay-url http://relay.railway.internal:8080 \
 *        --pricing-url http://pricing.railway.internal:8790 \
 *        --indexer-url https://<indexer host> --long-id <NVDA long id> \
 *        --notifier-url https://dev-notify.stonkhouse.fun \
 *        --rpc "$RH_RPC" --chain-id 4663
 *
 * WHAT IT IS. v8-plan/GO-LIVE-V7-SERVICES.md section 6 "What done looks like" lists four observable
 * checks across 383 lines of packet. This prints one line per check, PASS or FAIL, and on FAIL the
 * exact next action. It exits non-zero unless all four PASS.
 *
 * WHAT IT IS NOT. It never performs the owner action. It sends no user alert, opens no subscription,
 * deploys nothing, signs nothing and writes to no service. Every observation is a read. `--execute`
 * exists only to be REFUSED, so that "this tool has no acting mode" is a statement the test suite can
 * hold me to rather than a claim in a comment.
 *
 * WHY IT FAILS LOUD RATHER THAN SKIPPING. The dominant defect on this build is a check that passes
 * because it cannot see its subject: a fork suite that self-returns without --fork-url, a copy-lint
 * that prints "docs copy OK" with no sibling app, a checksumAddress stub that was the identity
 * function and made address assertions pass for seventeen hours. So here an endpoint that is
 * UNCONFIGURED and an endpoint that is UNREACHABLE both read FAIL, with the reason. There is no
 * "skipped" status and no third outcome to hide in.
 *
 * WHY TWO OF THE FOUR NEED AN EVIDENCE FILE. Criteria 1 and 4 are not observable from a machine.
 * "The message must be seen" in an operator's Discord channel, and "a browser subscription received
 * the settlement receipt", are facts about a human's screen. A tool that inferred them from a 200
 * would be asserting exactly what the packet says a 200 does not prove ("A 200 alone is not enough").
 * So they are read from a recorded evidence file, the file's own shape is checked, and a MISSING file
 * is FAIL -- never an absent criterion, and never a pass by omission.
 *
 * Tests: node --test ops/v8/prelaunch-gate.test.mjs
 */
import { execFile as execFileCb } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);
/** Resolves to stdout; on a non-zero exit the rejection still carries `.stdout`, which the caller uses. */
const defaultExecFile = async (cmd, args) => (await execFileAsync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout;

export const EXPECTED_CHAIN_ID = 4663;

/**
 * The two monitor alert names GO-LIVE-V7-SERVICES.md:331 permits while KeeperRewards and MakerVault
 * hold 0. "Clean" today is NOT exit 0: it is exit 1 carrying EXACTLY these two names and no third.
 * A third name is a real finding, so the allowlist is exact rather than a prefix or a count -- a
 * count would let one expected name be swapped for one unexpected one and still read clean.
 */
export const MONITOR_KNOWN_STANDING = ["v2_mon_rewards_budget_low", "v2_mon_vault_inventory_low"];

/** The indexer's answer when PRICING_URL is unset (indexer/src/api/v2/markets.ts:314-320). */
export const PRICING_NOT_CONFIGURED = "Pricing service is not configured";

export function parseArgs(argv) {
  const out = {
    evidence: null, relayUrl: null, pricingUrl: null, indexerUrl: null, longId: null,
    notifierUrl: null, rpc: null, chainId: EXPECTED_CHAIN_ID, json: false, help: false, execute: false,
    timeoutMs: 10_000,
  };
  const fail = (m) => { throw new Error(m); };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    switch (arg) {
      case "--evidence": out.evidence = value(); break;
      case "--relay-url": out.relayUrl = value(); break;
      case "--pricing-url": out.pricingUrl = value(); break;
      case "--indexer-url": out.indexerUrl = value(); break;
      case "--long-id": out.longId = value(); break;
      case "--notifier-url": out.notifierUrl = value(); break;
      case "--rpc": out.rpc = value(); break;
      case "--chain-id": out.chainId = Number(value()); break;
      case "--timeout-ms": out.timeoutMs = Number(value()); break;
      case "--json": out.json = true; break;
      case "--execute": out.execute = true; break;
      case "--help": case "-h": out.help = true; break;
      default: fail(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/**
 * The refusal that keeps "read-only" true by construction.
 *
 * Acceptance criterion 2 of this task says a script that acts by default is a defect. This one has no
 * acting path at all, which is easy to claim and easy to erode. Refusing the flag outright means the
 * day somebody adds a mutating path, they have to delete this function first and the test that
 * covers it -- a deliberate act, not a drift.
 */
export function refuseExecute(opts) {
  if (!opts.execute) return null;
  return "--execute is refused: ops/v8/prelaunch-gate.mjs only OBSERVES the OWN8-02 criteria. It never "
    + "sends a test alert, never opens a subscription, never deploys and never writes to a service. "
    + "Perform the owner actions from v8-plan/GO-LIVE-V7-SERVICES.md section 3, record what you saw in "
    + "the --evidence file, then run this to check them.";
}

/** A JSON GET that distinguishes unreachable from wrong, and never turns a failure into a pass. */
export async function httpJson(url, { timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { ok: true, status: res.status, body, text };
  } catch (error) {
    // Connection refused, DNS failure, TLS failure and timeout all land here, and all mean the same
    // thing for a gate: the subject was not observed. Never a pass.
    return { ok: false, status: null, body: null, text: "", error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

const PASS = "PASS";
const FAIL = "FAIL";
const pass = (id, title, detail) => ({ id, title, status: PASS, detail, nextAction: null });
const fail = (id, title, detail, nextAction) => ({ id, title, status: FAIL, detail, nextAction });

/** Read the evidence file. A missing, unreadable or malformed file is a REASON, never an absence. */
export function loadEvidence(pathname, { readFile = (p) => readFileSync(p, "utf8") } = {}) {
  if (!pathname) return { error: "no --evidence <path> given" };
  let raw;
  try { raw = readFile(pathname); }
  catch (error) { return { error: `cannot read ${pathname}: ${String(error?.message ?? error).split("\n")[0]}` }; }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `${pathname} is not a JSON object` };
    }
    return { evidence: parsed };
  } catch (error) {
    return { error: `${pathname} is not valid JSON: ${String(error?.message ?? error).split("\n")[0]}` };
  }
}

/* ---------------------------------------------------------------------------------------------
 * The four criteria. Each is a pure function of an observation, so the tests drive them without a
 * network and without a live service. Each returns exactly one row: there is no skip.
 * ------------------------------------------------------------------------------------------- */

/**
 * 1. A test alert was RECEIVED (GO-LIVE-V7-SERVICES.md:330).
 *
 * The packet is explicit that a 200 is not the criterion: "A 200 alone is not enough: the message
 * must be seen." So the relay being up is necessary and not sufficient, and the seen-ness comes from
 * the evidence file, where an operator records what landed in the channel. `delivered` must be
 * non-empty and `failed` must be empty -- a 200 with `delivered: []` is the relay accepting a payload
 * it then dropped, which is the shape this criterion exists to catch.
 */
export function criterionTestAlert({ relayHealth, evidence, relayUrl }) {
  const id = "own8-02.relay.test-alert";
  const title = "A test alert was received in the operator channel";
  if (!relayUrl) {
    return fail(id, title, "no --relay-url given, so the relay was never observed",
      "pass --relay-url http://relay.railway.internal:8080 (ops/deploy.md:1396)");
  }
  if (!relayHealth?.ok) {
    return fail(id, title, `relay ${relayUrl}/health is unreachable: ${relayHealth?.error ?? "no answer"}`,
      "bring the relay up, then confirm RELAY_TOKEN and one target are set (relay/src/config.ts:85-91)");
  }
  if (relayHealth.status !== 200) {
    return fail(id, title, `relay ${relayUrl}/health answered ${relayHealth.status}, not 200`,
      "read `railway logs --service relay`; the relay refuses to boot with no target");
  }
  const receipt = evidence?.testAlert;
  if (!receipt) {
    return fail(id, title, "the relay is up, but no test-alert receipt is recorded: a live relay is not a delivered message",
      "send the test alert (ops/runbooks/v2-canary.md:791-792), SEE it in the channel, then record "
      + "{\"testAlert\":{\"status\":200,\"delivered\":[…],\"failed\":[],\"seenInChannel\":true,\"at\":\"<iso>\"}}");
  }
  const problems = [];
  if (receipt.status !== 200) problems.push(`status ${receipt.status}, not 200`);
  if (!Array.isArray(receipt.delivered) || receipt.delivered.length === 0) problems.push("delivered is empty");
  if (!Array.isArray(receipt.failed) || receipt.failed.length > 0) {
    problems.push(`failed is ${JSON.stringify(receipt.failed)}`);
  }
  if (receipt.seenInChannel !== true) problems.push("seenInChannel is not true: nobody attests the message was visible");
  if (problems.length > 0) {
    return fail(id, title, `the recorded receipt does not show a delivered, seen message: ${problems.join("; ")}`,
      "re-send the test alert and record the real 200 body plus seenInChannel true; do not edit the receipt to match");
  }
  return pass(id, title, `relay /health 200; receipt delivered to ${receipt.delivered.length} target(s), seen in channel`);
}

/**
 * 2. `monitor --once` is clean against production (GO-LIVE-V7-SERVICES.md:331).
 *
 * THE TRAP IS THE DEFINITION OF CLEAN, and it is neither "exit 0" nor "exit != 0 is bad". While
 * KeeperRewards and MakerVault hold 0, clean means exit 1 carrying EXACTLY the two standing names and
 * NO THIRD. A gate written as `exit === 0` reads FAIL forever and gets waived by hand; a gate written
 * as "exit 1 is fine" reads PASS through a real finding. Both names must be present AND nothing else.
 */
export function criterionMonitorOnce({ monitorRun, rpc, chainId }) {
  const id = "own8-02.monitor.once-clean";
  const title = "`monitor --once` is clean against production";
  if (!rpc) {
    return fail(id, title, "no --rpc given, so the monitor was never run",
      "pass --rpc \"$RH_RPC\" (ops/deploy.md:2045)");
  }
  if (chainId !== EXPECTED_CHAIN_ID) {
    return fail(id, title, `--chain-id ${chainId} is not ${EXPECTED_CHAIN_ID}: a clean monitor pass against the wrong chain proves nothing`,
      `re-run against chain ${EXPECTED_CHAIN_ID}, or correct --rpc`);
  }
  if (!monitorRun || monitorRun.ran !== true) {
    return fail(id, title, `the monitor did not run: ${monitorRun?.error ?? "no result"}`,
      "check ops/v2/monitor.mjs exists at this SHA and that --rpc answers; an unrun monitor is not a clean monitor");
  }
  // monitor.mjs:3517 exitCodeFor ranks an INCOMPLETE CHECK (exit 3) above a finding (exit 1), and it
  // is the more dangerous of the two here: a check that could not complete has no findings to show,
  // so a gate that only counted alert names would read it as clean.
  if (Number(monitorRun.incompleteChecks ?? 0) > 0) {
    return fail(id, title, `the monitor reported ${monitorRun.incompleteChecks} incomplete check(s): a check that could not run has no findings to show, so silence from it is not cleanliness`,
      "read the monitor's `note:` lines for the incomplete check and fix its input before judging this gate");
  }
  if (Number(monitorRun.deliveryFailures ?? 0) > 0) {
    return fail(id, title, `the monitor reported ${monitorRun.deliveryFailures} delivery failure(s): its alerts are not reaching the relay`,
      "fix ALERT_WEBHOOK / ALERT_WEBHOOK_TOKEN on the monitor; criterion 1 of this gate is about the relay, this is about the monitor reaching it");
  }
  const fired = Array.isArray(monitorRun.alerts) ? [...monitorRun.alerts] : null;
  if (fired === null) {
    return fail(id, title, "the monitor ran but its alert names could not be parsed: an unparsed run is not a clean run",
      "check the monitor's output shape; do not treat an unreadable summary as clean");
  }
  const unexpected = fired.filter((name) => !MONITOR_KNOWN_STANDING.includes(name)).sort();
  if (unexpected.length > 0) {
    return fail(id, title, `the monitor fired ${unexpected.length} name(s) beyond the two known standing pages: ${unexpected.join(", ")}`,
      "triage each unexpected name; a third name is a real finding, not a known page");
  }
  if (fired.length === 0) {
    if (monitorRun.exitCode !== 0) {
      return fail(id, title, `the monitor named no alerts but exited ${monitorRun.exitCode}: the exit and the summary disagree`,
        "read the monitor output; an exit code with no named cause is the shape that hides a crash as a finding");
    }
    return pass(id, title, "every check [ok], exit 0, no alerts");
  }
  const missing = MONITOR_KNOWN_STANDING.filter((name) => !fired.includes(name));
  if (missing.length > 0) {
    return fail(id, title, `the monitor fired a subset of the standing pages (${fired.join(", ")}) and is missing ${missing.join(", ")}`,
      "GO-LIVE-V7-SERVICES.md:331 defines clean as EXACTLY both standing names or none; a partial set means "
      + "something changed and the allowlist must be re-derived, not widened");
  }
  if (monitorRun.exitCode === 0) {
    return fail(id, title, `the monitor exited 0 while naming ${fired.join(", ")}: the exit and the summary disagree`,
      "a standing page that no longer sets the exit code means the monitor's own alerting changed; re-derive before trusting it");
  }
  return pass(id, title, `exit ${monitorRun.exitCode} with exactly the two known standing pages and no third name`);
}

/**
 * 3. `/fair` answers for a live NVDA series (GO-LIVE-V7-SERVICES.md:332).
 *
 * PRICING_URL being SET is deliberately not the criterion -- acceptance criterion 7 forbids satisfying
 * a criterion from a config value. The observation is the indexer's answer: a Money carrying `source`
 * and `asOf`, and specifically NOT the "Pricing service is not configured" string it returns when
 * PRICING_URL is unset (indexer/src/api/v2/markets.ts:314-320).
 */
export function criterionFair({ pricingHealth, fairResponse, pricingUrl, indexerUrl, longId }) {
  const id = "own8-02.pricing.fair";
  const title = "/fair answers for a live NVDA series";
  if (!pricingUrl) {
    return fail(id, title, "no --pricing-url given, so the pricing service was never observed",
      "pass --pricing-url http://pricing.railway.internal:8790");
  }
  if (!indexerUrl || !longId) {
    return fail(id, title, `missing ${!indexerUrl ? "--indexer-url" : "--long-id"}: /v2/fair was never asked`,
      "pass --indexer-url <that project's indexer> and --long-id <a LIVE NVDA series>");
  }
  if (!pricingHealth?.ok || pricingHealth.status !== 200) {
    return fail(id, title, `pricing ${pricingUrl}/health is ${pricingHealth?.ok ? pricingHealth.status : `unreachable: ${pricingHealth?.error}`}`,
      "bring pricing up and confirm 200 `status: ok` DURING A REGULAR SESSION; judge it in session, not at the weekend");
  }
  if (pricingHealth.body?.status !== "ok") {
    return fail(id, title, `pricing /health answered 200 but status is ${JSON.stringify(pricingHealth.body?.status)}, not "ok"`,
      "a 200 with a non-ok body is the service reporting its own unhealth; read its logs");
  }
  if (!fairResponse?.ok) {
    return fail(id, title, `${indexerUrl}/v2/fair/${longId} is unreachable: ${fairResponse?.error ?? "no answer"}`,
      "confirm the indexer is up and serving /v2 before judging pricing");
  }
  if (typeof fairResponse.text === "string" && fairResponse.text.includes(PRICING_NOT_CONFIGURED)) {
    return fail(id, title, `the indexer answered "${PRICING_NOT_CONFIGURED}": PRICING_URL is not set on THAT indexer`,
      "set PRICING_URL on the indexer that serves this host (ops/v2/env/indexer-v2.env:27) and redeploy it");
  }
  if (fairResponse.status !== 200) {
    return fail(id, title, `/v2/fair/${longId} answered ${fairResponse.status}, not 200`,
      "check the long id names a LIVE NVDA series; an expired or unknown series is not a pricing failure");
  }
  const money = fairResponse.body;
  const missing = ["source", "asOf"].filter((k) => money?.[k] === undefined || money?.[k] === null);
  if (money === null || typeof money !== "object" || missing.length > 0) {
    return fail(id, title, `/v2/fair/${longId} answered 200 but without ${missing.length ? missing.join(" and ") : "a Money body"}`,
      "the packet asks for a Money with source AND asOf; a price with no provenance is the delayed-data "
      + "risk in GO-LIVE-V7-SERVICES.md:350, not a pass");
  }
  return pass(id, title, `pricing /health ok; /v2/fair/${longId} returns a Money with source=${JSON.stringify(money.source)} asOf=${JSON.stringify(money.asOf)}`);
}

/**
 * 4. A Telegram and a browser subscription each received a real alert through one daily expiry
 * (GO-LIVE-V7-SERVICES.md:333).
 *
 * No machine can see a phone notification, so the received messages come from the evidence file. What
 * this DOES observe is the notifier's own health and that its settings surface is configured; what it
 * REFUSES to do is treat either of those as the criterion. The three messages are named individually
 * because "the alerts arrived" without naming them is the assertion that is always true.
 */
export const EXPECTED_EXPIRY_MESSAGES = ["reminder1h", "settlementReceipt", "fillReceipt"];

export function criterionNotifierExpiry({ notifierHealth, evidence, notifierUrl }) {
  const id = "own8-02.notifier.daily-expiry";
  const title = "Telegram and a browser subscription each got a real alert through one daily expiry";
  if (!notifierUrl) {
    return fail(id, title, "no --notifier-url given, so the notifier was never observed",
      "pass --notifier-url https://dev-notify.stonkhouse.fun");
  }
  if (!notifierHealth?.ok || notifierHealth.status !== 200) {
    return fail(id, title, `notifier ${notifierUrl}/health is ${notifierHealth?.ok ? notifierHealth.status : `unreachable: ${notifierHealth?.error}`}`,
      "bring the notifier up; check NOTIFIER_PUBLIC_URL is unset unless SMTP_URL is set (notifier/src/config.ts:152-158)");
  }
  if (notifierHealth.body?.status !== "ok") {
    return fail(id, title, `notifier /health answered 200 but status is ${JSON.stringify(notifierHealth.body?.status)}, not "ok"`,
      "read the notifier logs before judging the soak");
  }
  const soak = evidence?.dailyExpiry;
  if (!soak) {
    return fail(id, title, "the notifier is up, but no daily-expiry soak is recorded: a healthy notifier is not a delivered alert",
      "run the OWN3-406 soak through one daily expiry, then record {\"dailyExpiry\":{\"telegram\":[…],\"browser\":[…],"
      + "\"breakerOpened\":false,\"rulesStatus\":\"ok\",\"xffTestPassed\":true,\"expiry\":\"<iso>\"}}");
  }
  const problems = [];
  for (const channel of ["telegram", "browser"]) {
    const got = soak[channel];
    if (!Array.isArray(got)) { problems.push(`${channel} records no messages`); continue; }
    const absent = EXPECTED_EXPIRY_MESSAGES.filter((m) => !got.includes(m));
    if (absent.length > 0) problems.push(`${channel} is missing ${absent.join(", ")}`);
    const duplicated = EXPECTED_EXPIRY_MESSAGES.filter((m) => got.filter((x) => x === m).length > 1);
    // F4-notifications.md:83 gates production on "every expected message arrived ONCE".
    if (duplicated.length > 0) problems.push(`${channel} received ${duplicated.join(", ")} more than once`);
  }
  if (soak.breakerOpened !== false) problems.push("breakerOpened is not false");
  if (soak.rulesStatus !== "ok") problems.push(`rules.status is ${JSON.stringify(soak.rulesStatus)}, not "ok"`);
  if (soak.xffTestPassed !== true) problems.push("the XFF test is not recorded as passed");
  if (problems.length > 0) {
    return fail(id, title, `the recorded soak is incomplete: ${problems.join("; ")}`,
      "F4-notifications.md:83 gates production on every expected message arriving ONCE, no breaker open, "
      + "rules.status ok for 24 h and the XFF test passing. Re-run the soak; do not edit the record to match");
  }
  return pass(id, title, `telegram and browser each received ${EXPECTED_EXPIRY_MESSAGES.join(", ")} once through the ${soak.expiry ?? "recorded"} expiry`);
}

/* ---------------------------------------------------------------------------------------------
 * Driver
 * ------------------------------------------------------------------------------------------- */

export const CRITERIA_ORDER = [
  "own8-02.relay.test-alert",
  "own8-02.monitor.once-clean",
  "own8-02.pricing.fair",
  "own8-02.notifier.daily-expiry",
];

/**
 * Evaluate all four from already-gathered observations. Pure: the tests call this directly.
 *
 * The row count is asserted against CRITERIA_ORDER rather than trusted. A gate that silently returned
 * three rows would report "all PASS" while one criterion had quietly stopped being asked -- the same
 * shape as a contract the registry declares and the table does not enumerate.
 */
export function evaluate(observations) {
  const rows = [
    criterionTestAlert(observations),
    criterionMonitorOnce(observations),
    criterionFair(observations),
    criterionNotifierExpiry(observations),
  ];
  const ids = rows.map((r) => r.id);
  if (ids.length !== CRITERIA_ORDER.length || ids.some((id, i) => id !== CRITERIA_ORDER[i])) {
    throw new Error(`criteria drift: produced ${ids.join(", ")} but OWN8-02 is ${CRITERIA_ORDER.join(", ")}`);
  }
  return rows;
}

export const allPassed = (rows) => rows.length === CRITERIA_ORDER.length && rows.every((r) => r.status === PASS);

/** One line per criterion, and on FAIL the exact next action, indented under it. */
export function render(rows) {
  const width = Math.max(...rows.map((r) => r.id.length));
  const out = [];
  for (const row of rows) {
    out.push(`${row.status}  ${row.id.padEnd(width)}  ${row.title}`);
    out.push(`      ${row.detail}`);
    if (row.nextAction) out.push(`      NEXT: ${row.nextAction}`);
  }
  const failed = rows.filter((r) => r.status === FAIL);
  out.push("");
  out.push(failed.length === 0
    ? `OWN8-02 PRE-LAUNCH GATE: ${rows.length}/${rows.length} PASS`
    : `OWN8-02 PRE-LAUNCH GATE: ${failed.length} of ${rows.length} FAILED (${failed.map((r) => r.id).join(", ")})`);
  return out.join("\n");
}

export const USAGE = `ops/v8/prelaunch-gate.mjs — the OWN8-02 pre-launch services gate, in one command

  node ops/v8/prelaunch-gate.mjs --evidence <path> --relay-url <url> --pricing-url <url> \\
       --indexer-url <url> --long-id <id> --notifier-url <url> --rpc <url> [--chain-id ${EXPECTED_CHAIN_ID}]
       [--json] [--timeout-ms 10000]

One line per OWN8-02 criterion, PASS or FAIL, and on FAIL the exact next action. Exits non-zero
unless all four PASS. Read-only: it sends no alert, opens no subscription and writes to no service.
An unconfigured or unreachable service reads FAIL with the reason -- never PASS, never skipped.`;

/** Gather every observation, then evaluate. Probes are injected so the tests need no network. */
export async function gather(opts, probes = {}) {
  const get = probes.httpJson ?? ((url) => httpJson(url, { timeoutMs: opts.timeoutMs }));
  const runMonitor = probes.runMonitor ?? ((o) => runMonitorOnce(o, { execFile: defaultExecFile }));
  const evidenceRead = loadEvidence(opts.evidence, probes.evidenceIo ?? {});
  const [relayHealth, pricingHealth, notifierHealth, fairResponse, monitorRun] = await Promise.all([
    opts.relayUrl ? get(`${opts.relayUrl.replace(/\/$/, "")}/health`) : null,
    opts.pricingUrl ? get(`${opts.pricingUrl.replace(/\/$/, "")}/health`) : null,
    opts.notifierUrl ? get(`${opts.notifierUrl.replace(/\/$/, "")}/health`) : null,
    opts.indexerUrl && opts.longId
      ? get(`${opts.indexerUrl.replace(/\/$/, "")}/v2/fair/${encodeURIComponent(opts.longId)}`)
      : null,
    opts.rpc ? runMonitor(opts) : null,
  ]);
  return {
    ...opts,
    relayHealth, pricingHealth, notifierHealth, fairResponse, monitorRun,
    evidence: evidenceRead.evidence ?? null,
    evidenceError: evidenceRead.error ?? null,
  };
}

export async function main(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  let opts;
  try { opts = parseArgs(argv); }
  catch (error) { err(String(error.message ?? error)); err(""); err(USAGE); return 2; }
  if (opts.help) { log(USAGE); return 0; }
  const refusal = refuseExecute(opts);
  if (refusal) { err(refusal); return 2; }

  const observations = await gather(opts, io.probes ?? {});
  let rows;
  try { rows = evaluate(observations); }
  catch (error) { err(String(error.message ?? error)); return 2; }

  if (observations.evidenceError) {
    // Reported once, above the rows, because it is the reason two of them will read FAIL. It does not
    // replace those rows: a missing evidence file must still be visible as a FAILED criterion.
    err(`evidence: ${observations.evidenceError}`);
  }
  log(opts.json ? JSON.stringify({ rows, allPassed: allPassed(rows) }, null, 2) : render(rows));
  return allPassed(rows) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

/**
 * The real monitor runner: `node ops/v2/monitor.mjs --once --no-alerts --json --rpc <rpc>`.
 *
 * --no-alerts is what keeps this read-only: the monitor computes its findings and sends nothing
 * (its `how()` renders them DRY). --json is parsed rather than the `summary:` line scraped, because a
 * regex over prose is a check that quietly stops matching. A non-zero exit is NOT an error here: the
 * monitor uses exit 1 for findings and exit 3 for incomplete checks, and criterionMonitorOnce is what
 * decides which of those is clean. What IS an error is output this cannot parse -- reported as such,
 * never as an empty finding list, which would read as clean.
 */
export async function runMonitorOnce(opts, { execFile, monitorPath = "ops/v2/monitor.mjs" } = {}) {
  if (!execFile) return { ran: false, error: "no process runner supplied" };
  let stdout;
  try {
    stdout = await execFile(process.execPath, [monitorPath, "--once", "--no-alerts", "--json", "--rpc", opts.rpc]);
  } catch (error) {
    // A non-zero exit still carries stdout; only a spawn failure or unreadable output is fatal here.
    if (typeof error?.stdout !== "string" || error.stdout.trim() === "") {
      return { ran: false, error: `monitor.mjs did not produce JSON: ${String(error?.message ?? error).split("\n")[0]}` };
    }
    stdout = error.stdout;
  }
  let report;
  try { report = JSON.parse(stdout); }
  catch { return { ran: false, error: "monitor.mjs --json did not answer JSON; refusing to guess its findings from prose" }; }
  if (!Array.isArray(report?.findings) || !Array.isArray(report?.incompleteChecks)) {
    return { ran: false, error: "monitor.mjs --json answered a shape without findings[] and incompleteChecks[]: its report format changed" };
  }
  return {
    ran: true,
    exitCode: Number(report.exit),
    alerts: [...new Set(report.findings.map((f) => f.kind))].sort(),
    incompleteChecks: report.incompleteChecks.length,
    deliveryFailures: Number(report.deliveryFailures ?? 0),
  };
}
